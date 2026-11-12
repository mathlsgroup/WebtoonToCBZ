type StoredPage = { url: string; order: number; width: number; height: number; selected: boolean; reencoded?: boolean; saveState?: 'pending' | 'saved' | 'error'; saveError?: string; fileType?: string; byteLength?: number };
type AutoResumePolicy = { enabled: boolean; token: string; origin: string; chapterKey: string; autoPixels: boolean; includeNextChapters: boolean; pauseReason?: string };
type PreparationOptions = { jpeg: boolean; engine: JpegEngine };
type StoredCapture = { generation: string; entries: StoredPage[]; title: string; missing: number; capturing: boolean; archiveError?: string; manualOrder?: string[]; previewVersion?: number; autoResume?: AutoResumePolicy; preparation?: PreparationOptions };

// Dedicated extension-origin IndexedDB: binaries never enter site storage or sync.
const captureDatabase = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('webtoon-captures', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('sessions');
    request.result.createObjectStore('images');
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function captureTransaction<T>(operation: (sessions: IDBObjectStore, images: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  const database = await captureDatabase;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['sessions', 'images'], 'readwrite');
    let value: T;
    transaction.oncomplete = () => resolve(value);
    transaction.onabort = () => reject(transaction.error || new Error('Capture storage transaction aborted.'));
    transaction.onerror = () => reject(transaction.error);
    try { operation(transaction.objectStore('sessions'), transaction.objectStore('images'), result => { value = result; }); }
    catch (error) { transaction.abort(); reject(error); }
  });
}

type ArchiveRequest = { action: string; tabId?: number; state?: StoredCapture; generation?: string; url?: string;
  offset?: number; total?: number; base64?: string; selected?: boolean; title?: string; urls?: string[]; command?: string;
  dataUrl?: string; previewVersion?: number };

async function handleArchive(message: ArchiveRequest, sender: { id?: string; frameId?: number; url?: string; tab?: { id?: number } }) {
  if (sender.id !== browser.runtime.id) throw new Error('Invalid archive sender.');
  const fromExtension = sender.url?.startsWith(browser.runtime.getURL(''));
  const tabId = fromExtension ? message.tabId : sender.frameId === 0 ? sender.tab?.id : undefined;
  if (!Number.isSafeInteger(tabId) || tabId! < 0) throw new Error('Invalid archive tab.');
  if (!fromExtension && !['archive-reset', 'archive-state', 'archive-bytes', 'archive-commit', 'archive-check'].includes(message.action)
    && !(message.action === 'archive-request' && message.command === 'blob-data')) throw new Error('Invalid source archive request.');
  return captureTransaction<unknown>((sessions, images, done) => {
    const request = sessions.get(tabId!);
    request.onsuccess = () => {
      const stored = request.result as StoredCapture | undefined;
      if (message.action === 'archive-reset') {
        const state = message.state;
        if (!state || typeof state.generation !== 'string' || !Array.isArray(state.entries)) { done({ error: 'Invalid capture state.' }); return; }
        // Remove only this tab's previous payloads, in the same transaction.
        const cursor = images.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (item) { if ((item.key as IDBValidKey[])[0] === tabId) item.delete(); item.continue(); }
        };
        sessions.put(state, tabId!); done({ ok: true });
        if(typeof cancelCapturePreparation==='function')cancelCapturePreparation(tabId!);
        return;
      }
      if (!stored) { done({ error: 'No saved capture for this tab.' }); return; }
      if (message.action === 'archive-state') {
        if (stored.generation !== message.state?.generation) { done({ error: 'Capture changed.' }); return; }
        const acknowledged = new Map(stored.entries.filter(page => page.saveState === 'saved').map(page => [page.url, page]));
        const autoResume = stored.autoResume && { ...stored.autoResume,
          enabled: stored.autoResume.enabled && message.state.capturing,
          pauseReason: message.state.capturing ? stored.autoResume.pauseReason : 'Stopped by user.' };
        const state = { ...message.state, preparation:stored.preparation, autoResume, previewVersion: stored.previewVersion ?? 0, entries: message.state.entries.map(page => acknowledged.has(page.url)
          ? { ...page, reencoded: acknowledged.get(page.url)!.reencoded, fileType: acknowledged.get(page.url)!.fileType ?? page.fileType,
            byteLength: acknowledged.get(page.url)!.byteLength ?? page.byteLength, saveState: 'saved' as const, saveError: undefined } : page) };
        sessions.put(state, tabId!); done({ ok: true }); return;
      }
      const generation = message.generation ?? stored.generation;
      if (generation !== stored.generation) { done({ error: 'Capture changed. Refresh the review.' }); return; }
      if (message.action === 'archive-preview-get') {
        const allowed = new Set(stored.entries.map(page => page.url));
        const urls = [...new Set(message.urls || [])].filter(url => allowed.has(url));
        const previews: { url: string; dataUrl: string }[] = [];
        let remaining = urls.length;
        const complete = () => done({ generation, previewVersion: stored.previewVersion ?? 0, previews });
        if (!remaining) { complete(); return; }
        for (const url of urls) {
          const request = images.get([tabId!, generation, url, 'thumbnail']);
          request.onsuccess = () => {
            if (typeof request.result?.dataUrl === 'string') previews.push({ url, dataUrl: request.result.dataUrl });
            if (!--remaining) complete();
          };
        }
        return;
      }
      if (message.action === 'archive-preview-clear') {
        stored.previewVersion = (stored.previewVersion ?? 0) + 1;
        sessions.put(stored, tabId!);
        const cursor = images.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) { done({ ok: true }); return; }
          const key = item.key as IDBValidKey[];
          if (key[0] === tabId && key[1] === generation && key[3] === 'thumbnail') item.delete();
          item.continue();
        };
        return;
      }
      if (message.action === 'archive-request' && message.command !== 'blob-data') {
        if (message.command === 'stop') {
          stored.capturing = false;
          if (stored.autoResume) { stored.autoResume.enabled = false; stored.autoResume.pauseReason = 'Stopped by user.'; }
        }
        if (message.command === 'select') {
          const page = stored.entries.find(page => page.url === message.url);
          if (page) page.selected = Boolean(message.selected);
        } else if (message.command === 'title') stored.title = message.title || '';
        else if (message.command === 'reorder') {
          const order = new Map((message.urls || []).map((url, index) => [url, index]));
          stored.manualOrder = [...order.keys()];
          stored.entries.sort((a, b) => (order.get(a.url) ?? order.size) - (order.get(b.url) ?? order.size));
        }
        sessions.put(stored, tabId!);
        const locals = stored.entries.filter(page => page.url.startsWith('blob:'));
        done({ ...stored, capturing: false, archived: true, pendingSaves: 0,
          savedCount: locals.filter(page => page.saveState === 'saved').length,
          unsavedCount: locals.filter(page => page.saveState !== 'saved').length }); return;
      }
      const page = stored.entries.find(page => page.url === message.url);
      if (!page) { done({ error: 'Image not present in saved capture.' }); return; }
      const key = [tabId!, stored.generation, page.url];
      if (message.action === 'archive-preview-put' || message.action === 'archive-preview-delete') {
        if (message.previewVersion !== (stored.previewVersion ?? 0)) { done({ error: 'Preview cache was cleared. Discard this stale thumbnail.' }); return; }
        if (message.action === 'archive-preview-delete') { images.delete([...key, 'thumbnail']); done({ ok: true }); return; }
        const prefix = 'data:image/png;base64,';
        if (typeof message.dataUrl !== 'string' || !message.dataUrl.startsWith(prefix) || message.dataUrl.length > 256 * 1024) {
          done({ error: 'Invalid thumbnail payload.' }); return;
        }
        const bytes = atob(message.dataUrl.slice(prefix.length));
        if (![137,80,78,71,13,10,26,10].every((byte, index) => bytes.charCodeAt(index) === byte)) {
          done({ error: 'Thumbnail must contain PNG data.' }); return;
        }
        images.put({ dataUrl: message.dataUrl }, [...key, 'thumbnail']); done({ ok: true }); return;
      }
      const offset = message.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) { done({ error: 'Invalid image offset.' }); return; }
      if (message.action === 'archive-check') {
        const manifest = images.get(key);
        manifest.onsuccess = () => done({ saved: manifest.result?.complete === true });
        return;
      }
      if (message.action === 'archive-commit') {
        const total = message.total;
        if (!Number.isSafeInteger(total) || total! < 1 || total! > 64 * 1024 * 1024) { done({ error: 'Invalid complete image size.' }); return; }
        let remaining = Math.ceil(total! / (256 * 1024));
        let invalid = false;
        let fileType: string | undefined;
        for (let start = 0; start < total!; start += 256 * 1024) {
          const part = images.get([...key, start]);
          part.onsuccess = () => {
            if (part.result?.total !== total || part.result?.data?.length !== Math.min(256 * 1024, total! - start)) invalid = true;
            if (start === 0 && part.result?.data) {
              try { fileType = imageExtension(part.result.data); } catch { /* Unsupported data is reported by review/export. */ }
            }
            if (--remaining) return;
            if (invalid) { done({ error: 'Image save incomplete; not all chunks were committed.' }); return; }
            images.put({ complete: true, total }, key);
            page.saveState = 'saved'; page.saveError = undefined;
            page.byteLength = total; page.fileType = fileType;
            sessions.put(stored, tabId!);
            done({ ok: true });
            if(typeof enqueueCapturePreparation==='function')enqueueCapturePreparation(tabId!,generation,page.url);
          };
        }
        return;
      }
      if (message.action === 'archive-bytes') {
        if (!Number.isSafeInteger(message.total) || message.total! < 1 || message.total! > 64 * 1024 * 1024
          || typeof message.base64 !== 'string' || message.base64.length > 350000) { done({ error: 'Invalid image payload.' }); return; }
        // Store bounded chunks separately; avoid rewriting a full image per chunk.
        const data = Uint8Array.from(atob(message.base64), char => char.charCodeAt(0));
        if (data.length !== Math.min(256 * 1024, message.total! - offset) || offset % (256 * 1024) !== 0) { done({ error: 'Incomplete image payload.' }); return; }
        images.put({ data, total: message.total }, [...key, offset]); done({ ok: true }); return;
      }
      if (page.saveState && page.saveState !== 'saved') {
        done({ error: page.saveError || 'Image save is not complete. Return to the image with capture active and wait for Saved locally.' }); return;
      }
      const chunk = images.get([...key, offset]);
      chunk.onsuccess = () => {
        const value = chunk.result as { data: Uint8Array; total: number } | undefined;
        if (!value) { done({ error: 'Image data was not saved before navigation. Return to that page and capture it again.' }); return; }
        let binary = '';
        for (const byte of value.data) binary += String.fromCharCode(byte);
        done({ generation, offset, total: value.total, base64: btoa(binary) });
      };
    };
  });
}

browser.runtime.onMessage.addListener((message: ArchiveRequest, sender: Parameters<typeof handleArchive>[1]) => {
  if (!message.action?.startsWith('archive-')) return undefined;
  return handleArchive(message, sender).catch((error: unknown) => ({ error: 'Local capture storage: ' + String(error) }));
});

// Tab identifiers are only stable within a browser session. Avoid restoring an
// unrelated capture if Firefox reuses an identifier after a full restart.
browser.runtime.onStartup.addListener(() => {
  void captureTransaction<void>((sessions, images, done) => {
    sessions.clear(); images.clear(); done();
  }).catch(() => { /* Read/write requests report storage failures to the UI. */ });
});
