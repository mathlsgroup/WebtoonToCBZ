(() => {
  const scope = globalThis as typeof globalThis & { webtoonCaptureInstalled?: boolean };
  if (scope.webtoonCaptureInstalled) return;
  scope.webtoonCaptureInstalled = true;
  type Entry = { url: string; order: number; width: number; height: number; selected: boolean; reencoded?: boolean; readerPage?: number; sourceUrl?: string; saveState?: 'pending' | 'saved' | 'error'; saveError?: string; fileType?: string; byteLength?: number };
  type ReaderChapter = { key: string; total: number; offset: number };
  type ResumeState = { generation: string; entries: Entry[]; title: string; missing: number; manualOrder?: string[]; autoResume?: AutoResumePolicy; readerChapters?: ReaderChapter[] };
  let capturing = false;
  let generation: string = crypto.randomUUID();
  let title = '';
  let nextOrder = 0;
  let manualOrder: string[] = [];
  let positions = new WeakMap<HTMLImageElement, number>();
  const records = new Map<string, Entry>();
  const nodes = new Map<string, HTMLImageElement>();
  const seen = new Set<HTMLImageElement>();
  type BlobData = { bytes?: Uint8Array; error?: string; reencoded?: boolean };
  const blobs = new Map<string, Promise<BlobData>>();
  const chapterPages = new Map<string, string>();
  const readerChapters = new Map<string, ReaderChapter>();
  let mutation: MutationObserver | undefined;
  let scheduled = false;
  let autoPixels = false;
  let inheritedMissing = 0;
  let readerOffset = 0;
  let archiveError = '';
  let pendingSaves = 0;
  let archiveQueue = Promise.resolve();
  const pendingReads = new Set<string>();
  const pendingWrites = new Set<string>();
  const repairs = new Map<string, Promise<void>>();
  const repairAttempts = new Map<string, string>();
  let automaticWait: MutationObserver | undefined;
  let automaticAttempt = 0;
  let readerScope: Pick<AutoResumePolicy, 'origin' | 'chapterKey' | 'includeNextChapters'> | undefined;
  let captureNotice = '';

  function sameReaderChapter(url: string | undefined): boolean {
    if (url === location.href) return true;
    try { return !!url && navigationChapterKey(url) === navigationChapterKey(location.href); }
    catch { return false; }
  }
  function readerChapterKey(url = location.href): string {
    try { return navigationChapterKey(url); } catch { return 'current-document'; }
  }
  function readerSlot(page: number, url = location.href): string { return readerChapterKey(url) + '\n' + page; }

  function automaticReaderReady(): boolean {
    if (document.querySelector('#challenge-running, #challenge-form, #cf-challenge-running')
      || /^(just a moment|attention required|checking your browser)/i.test(document.title || '')) return false;
    if (['scan-manga.com', 'www.scan-manga.com'].includes(location.hostname)) {
      const reader = chapterReader();
      return !!reader && Number.isSafeInteger(Number(reader.dataset.nbpage)) && Number(reader.dataset.nbpage) > 0;
    }
    return document.images.length > 0;
  }

  async function resumeAutomatically(state: ResumeState, token: string) {
    if (capturing && generation === state.generation) return snapshot();
    const attempt = ++automaticAttempt;
    automaticWait?.disconnect();
    let checking = false;
    const begin = async () => {
      if (attempt !== automaticAttempt || checking) return { paused: true };
      checking = true;
      try {
        const approved = await browser.runtime.sendMessage({ action: 'navigation-state', token });
        if (attempt !== automaticAttempt) return { paused: true };
        if (approved?.error || approved?.state?.generation !== state.generation) {
          automaticWait?.disconnect(); return { error: approved?.error || 'Capture changed.' };
        }
        if (!automaticReaderReady()) return { paused: true };
        automaticWait?.disconnect();
        start(approved.policy.autoPixels, approved.state);
        await checkpoint();
        return snapshot();
      } finally { checking = false; }
    };
    if (automaticReaderReady()) return begin();
    automaticWait = new MutationObserver(() => {
      if (automaticReaderReady()) void begin().catch(error => { archiveError = String(error); });
    });
    automaticWait.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    return { paused: true };
  }

  function repairVisible(url: string, img: HTMLImageElement, sourceUrl: string): void {
    const entry = records.get(url);
    if (!entry || entry.saveState === 'saved' || pendingReads.has(url) || pendingWrites.has(url)
      || repairs.has(url) || repairAttempts.get(url) === sourceUrl) return;
    repairAttempts.set(url, sourceUrl);
    const expectedGeneration = generation;
    const safetyCopy = autoPixels ? freezePixels(img) : undefined;
    const job = (async () => {
      const stored = await browser.runtime.sendMessage({ action: 'archive-check', generation: expectedGeneration, url });
      if (expectedGeneration !== generation) return;
      if (stored?.saved) { entry.saveState = 'saved'; entry.saveError = undefined; return; }
      const cached = await blobs.get(url);
      if (cached?.bytes) await persistBlob(url, cached.bytes, expectedGeneration);
      else await cacheBlob(url, sourceUrl, safetyCopy);
    })().catch(error => { if (generation === expectedGeneration) { entry.saveState = 'error'; entry.saveError = String(error); } });
    repairs.set(url, job);
    void job.finally(() => { if (repairs.get(url) === job) repairs.delete(url); });
  }

  function queueArchive(message: object, expectedGeneration = generation): Promise<boolean> {
    const job = archiveQueue.then(async () => {
      if (expectedGeneration !== generation) return false;
      const result = await browser.runtime.sendMessage(message);
      if (result?.error) throw new Error(result.error);
      if (!result?.ok) throw new Error('Local storage did not confirm the write.');
      return true;
    });
    const settled = job.catch(error => { if (generation === expectedGeneration) archiveError = String(error); return false; });
    archiveQueue = settled.then(() => undefined);
    return settled;
  }
  function checkpoint(): Promise<boolean> {
    return queueArchive({ action: 'archive-state', state: snapshot() });
  }
  function encodeChunk(bytes: Uint8Array, offset: number): string {
    const end = Math.min(offset + 256 * 1024, bytes.length);
    let binary = '';
    // Indexed reads avoid Firefox Xray constructor/species access.
    for (let index = offset; index < end; index += 8192) {
      const codes: number[] = [];
      for (let cursor = index; cursor < Math.min(index + 8192, end); cursor++) codes.push(bytes[cursor]);
      binary += String.fromCharCode(...codes);
    }
    return btoa(binary);
  }
  async function persistBlob(url: string, bytes: Uint8Array, expectedGeneration: string): Promise<boolean> {
    if (expectedGeneration !== generation) return false;
    const entry = records.get(url);
    if (!entry) return false;
    entry.byteLength = bytes.length;
    try { entry.fileType = imageExtension(bytes); } catch { entry.fileType = undefined; }
    entry.saveState = 'pending'; entry.saveError = undefined;
    pendingWrites.add(url);
    pendingSaves++;
    try {
      if (!await checkpoint()) throw new Error(archiveError || 'Capture metadata could not be saved.');
      for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
        if (!await queueArchive({ action: 'archive-bytes', generation: expectedGeneration, url,
          offset, total: bytes.length, base64: encodeChunk(bytes, offset) }, expectedGeneration)) {
          throw new Error(archiveError || 'Image chunk could not be saved.');
        }
      }
      if (!await queueArchive({ action: 'archive-commit', generation: expectedGeneration, url, total: bytes.length }, expectedGeneration)) {
        throw new Error(archiveError || 'Image save was not confirmed.');
      }
      if (generation !== expectedGeneration) return false;
      entry.saveState = 'saved';
      return true;
    } catch (error) {
      if (generation === expectedGeneration) { entry.saveState = 'error'; entry.saveError = String(error); }
      return false;
    } finally { if (generation === expectedGeneration) { pendingSaves--; pendingWrites.delete(url); } }
  }
  function scanAndSave(): void { scan(); void checkpoint(); }

  function chapterReader(): HTMLElement | null {
    if (!['scan-manga.com', 'www.scan-manga.com'].includes(location.hostname)) return null;
    return document.querySelector<HTMLElement>('#container.img_lel[data-nbpage]');
  }
  function eligible(url: string): boolean {
    if (/^https?:/.test(url)) return true;
    try { return url.startsWith('blob:') && new URL(url).origin === location.origin; }
    catch { return false; }
  }
  function cacheBlob(url: string, sourceUrl = url, frozen?: Promise<BlobData>): Promise<BlobData> {
    repairAttempts.set(url, sourceUrl);
    // Read only an already displayed same-origin blob, while its URL still exists.
    // Never reconstruct URLs, decrypt data, or intercept the site's loading logic.
    // Freeze the displayed frame synchronously, before fetch or any await. A
    // reader arrow may recycle the image node while the original read is pending.
    const img = nodes.get(url);
    const original = (async (): Promise<BlobData> => {
      try {
        const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) throw new Error('Empty image blob.');
        if (bytes.length > 64 * 1024 * 1024) return { error: 'Local image exceeds the 64 MiB transfer limit.' };
        return { bytes };
      } catch (isolatedError) {
        try {
          const result = await browser.runtime.sendMessage({ action: 'read-displayed-blob', url: sourceUrl });
          if (result?.error) return { error: result.error };
          if (!Number.isSafeInteger(result?.total) || result.total < 1 || result.total > 64 * 1024 * 1024
            || !Array.isArray(result.chunks) || result.chunks.length !== Math.ceil(result.total / (256 * 1024))) {
            throw new Error('Invalid page-context image response.');
          }
          const bytes = new Uint8Array(result.total);
          let offset = 0;
          for (const chunk of result.chunks) {
            if (typeof chunk !== 'string' || chunk.length > 350000) throw new Error('Invalid image chunk.');
            const binary = atob(chunk);
            if (binary.length !== Math.min(256 * 1024, bytes.length - offset)) throw new Error('Incomplete page-context image.');
            for (let index = 0; index < binary.length; index++) bytes[offset + index] = binary.charCodeAt(index);
            offset += binary.length;
          }
          return { bytes };
        } catch (error) {
          return { error: 'Displayed image blob could not be read. Isolated context: ' + String(isolatedError)
            + '. Page context: ' + String(error) + '. Reload the chapter and start capture before reading.' };
        }
      }
    })();
    const safetyCopy = frozen ?? (autoPixels && img && (img.currentSrc || img.src) === sourceUrl
      ? freezePixels(img) : undefined);
    const usable = (promise: Promise<BlobData>) => promise.then(data => {
      if (!data.bytes) throw new Error(data.error || 'Image bytes unavailable.');
      return data;
    });
    // Do not hold a ready PNG behind a slow/blocked original read. Publish one
    // immutable result; a late original must never overwrite transferred chunks.
    const pending: Promise<BlobData> = safetyCopy
      ? Promise.any([usable(original), usable(safetyCopy.then(async data => {
        // Give already-ready original reads one event-loop turn, never a network
        // timeout. A finished PNG must not wait 30 seconds before being saved.
        if (data.bytes) await new Promise(resolve => setTimeout(resolve, 0));
        return data;
      }))]).catch((error: AggregateError) => ({ error: error.errors.map(String).join(' ') }))
      : original;
    blobs.set(url, pending);
    const expectedGeneration = generation;
    pendingReads.add(url);
    void pending.then(data => {
      if (expectedGeneration !== generation) return;
      pendingReads.delete(url);
      if (data.bytes) {
        const entry = records.get(url);
        if (entry && data.reencoded) entry.reencoded = true;
        void persistBlob(url, data.bytes, expectedGeneration);
      } else {
        const entry = records.get(url);
        if (entry) { entry.saveState = 'error'; entry.saveError = data.error; }
      }
    });
    return pending;
  }

  async function blobChunk(message: { url?: string; generation?: string; offset?: number }) {
    const requestedGeneration = generation;
    if (message.generation !== generation) return { error: 'Capture changed. Refresh the review.' };
    await repairs.get(message.url || '');
    const cached = blobs.get(message.url || '');
    if (!records.has(message.url || '')) return { error: 'Image was not captured in this document.' };
    if (!cached) {
      // Continue restores metadata without copying every archived binary back
      // into the page. Read saved chunks instead of reporting a false absence.
      try {
        return await browser.runtime.sendMessage({ action: 'archive-request', command: 'blob-data',
          generation, url: message.url, offset: message.offset });
      } catch (error) { return { error: 'Saved image bytes unavailable: ' + String(error) }; }
    }
    let data = await cached;
    // A failed fetch is retryable on review refresh; successful bytes stay cached.
    const node = nodes.get(message.url || '');
    const currentUrl = node && (node.currentSrc || node.src);
    if (!data.bytes && node?.isConnected && currentUrl && eligible(currentUrl) && currentUrl.startsWith('blob:')) {
      data = await cacheBlob(message.url!, currentUrl);
    }
    if (requestedGeneration !== generation) return { error: 'Capture changed. Refresh the review.' };
    if (!data.bytes) return { error: data.error };
    const offset = message.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= data.bytes.length) return { error: 'Invalid blob offset.' };
    return { generation, offset, total: data.bytes.length, base64: encodeChunk(data.bytes, offset) };
  }

  async function capturePixels(message: { url?: string; generation?: string }) {
    const requestedGeneration = generation;
    if (message.generation !== generation) return { error: 'Capture changed. Refresh the review.' };
    const entry = records.get(message.url || '');
    const img = nodes.get(message.url || '');
    const source = img && (img.currentSrc || img.src);
    if (!entry || !img?.isConnected || !source?.startsWith('blob:') || !eligible(source)
      || !img.complete || !img.naturalWidth || !img.naturalHeight) {
      return { error: 'The captured local image is no longer loaded. Display it in the source chapter first.' };
    }
    const original = await blobs.get(entry.url);
    if (requestedGeneration !== generation) return { error: 'Capture changed. Refresh the review.' };
    if (original?.bytes) return { reencoded: entry.reencoded ?? false };
    if (!img.isConnected || (img.currentSrc || img.src) !== source || !img.complete) {
      return { error: 'The source image changed during capture. Display the page again and refresh the review.' };
    }
    const data = await freezePixels(img);
    if (requestedGeneration !== generation) return { error: 'Capture changed. Refresh the review.' };
    if (!data.bytes) return { error: data.error };
    blobs.set(entry.url, Promise.resolve(data));
    entry.reencoded = true;
    await persistBlob(entry.url, data.bytes, requestedGeneration);
    return { reencoded: true };
  }

  async function freezePixels(img: HTMLImageElement): Promise<BlobData> {
    const source = img.currentSrc || img.src;
    if (!img.isConnected || !img.complete || !img.naturalWidth || !img.naturalHeight
      || !source.startsWith('blob:') || !eligible(source)) {
      return { error: 'The displayed local image is not available for a PNG safety copy.' };
    }
    const width = img.naturalWidth, height = img.naturalHeight;
    if (width > 32767 || height > 32767 || width * height > 64 * 1024 * 1024) {
      return { error: 'Displayed image exceeds the Canvas memory limit.' };
    }
    let canvas: HTMLCanvasElement | undefined;
    try {
      canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas allocation failed.');
      // Opt-in safety copy or explicit user action. Origin-clean checks remain.
      // These are re-encoded pixels, never claimed to be original image bytes.
      context.drawImage(img, 0, 0);
      const png = await new Promise<Blob>((resolve, reject) => {
        canvas!.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed.')), 'image/png');
      });
      if (png.size > 64 * 1024 * 1024) throw new Error('PNG exceeds the 64 MiB transfer limit.');
      const bytes = new Uint8Array(await png.arrayBuffer());
      return { bytes, reencoded: true };
    } catch (error) {
      return { error: 'Displayed pixel capture failed: ' + String(error) + '. Browser security restrictions were not changed.' };
    } finally { if (canvas) { canvas.width = 0; canvas.height = 0; } }
  }

  function visible(img: HTMLImageElement): boolean {
    const rect = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
      && rect.right > 0 && rect.left < innerWidth && style.visibility !== 'hidden'
      && style.display !== 'none' && style.opacity !== '0';
  }

  function scan(): void {
    if (!capturing) return;
    if (readerScope && !navigationAllowed(readerScope, location.href)) {
      stop(false);
      captureNotice = 'Capture paused at the chapter boundary. Start a new capture for another chapter.';
      void checkpoint();
      return;
    }
    const reader = chapterReader();
    if (['scan-manga.com', 'www.scan-manga.com'].includes(location.hostname) && !reader) return;
    if (reader) {
      const key = readerChapterKey();
      const total = Number(reader.dataset.nbpage);
      if (Number.isSafeInteger(total) && total > 0) {
        if (!readerChapters.has(key)) {
          const offset = Math.max(0, ...[...readerChapters.values()].map(chapter => chapter.offset + chapter.total));
          readerChapters.set(key, { key, total, offset });
        }
        readerChapters.get(key)!.total = total;
        let offset = 0;
        for (const chapter of readerChapters.values()) { chapter.offset = offset; offset += chapter.total; }
        for (const entry of records.values()) {
          const chapter = readerChapters.get(readerChapterKey(entry.sourceUrl));
          if (chapter && entry.readerPage) entry.order = chapter.offset + entry.readerPage - 1;
        }
        readerOffset = readerChapters.get(key)!.offset;
      }
    }
    // Reserve positions before image downloads finish, including placeholders.
    for (const img of reader ? reader.querySelectorAll('img') : document.images) {
      if (!positions.has(img)) positions.set(img, nextOrder++);
      if (visible(img)) seen.add(img);
      if (!seen.has(img)) continue;
      const url = img.currentSrc || img.src;
      if (!eligible(url) || !img.complete || !img.naturalWidth) continue;
      const page = reader ? Number(img.closest<HTMLElement>('.image-container[data-page]')?.dataset.page) : 0;
      if (reader && (!Number.isSafeInteger(page) || page < 1 || page > Number(reader.dataset.nbpage))) continue;
      // Rebind a returned page to its new loaded node/blob. A remembered page
      // number alone does not prove its payload was durably saved.
      const slot = readerSlot(page);
      if (page && chapterPages.has(slot)) {
        const known = chapterPages.get(slot)!;
        nodes.set(known, img);
        if (url.startsWith('blob:')) repairVisible(known, img, url);
        continue;
      }
      // During a same-document chapter transition, old image nodes can remain
      // briefly visible. Do not assign their URLs to the new chapter's slots.
      const previous = records.get(url);
      if (reader && previous?.sourceUrl && !sameReaderChapter(previous.sourceUrl)) continue;
      if (!records.has(url)) {
        records.set(url, { url, order: page ? readerOffset + page - 1 : positions.get(img)!, width: img.naturalWidth,
          height: img.naturalHeight, selected: true, readerPage: page || undefined, sourceUrl: location.href,
          saveState: url.startsWith('blob:') ? 'pending' : undefined });
        nodes.set(url, img);
        if (url.startsWith('blob:')) cacheBlob(url);
      }
      if (page) chapterPages.set(slot, url);
    }
  }

  function schedule(): void {
    if (scheduled || !capturing) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; scanAndSave(); });
  }

  function stop(scanCurrent = true): void {
    automaticAttempt++; automaticWait?.disconnect();
    if (scanCurrent) scan();
    capturing = false;
    mutation?.disconnect();
    document.removeEventListener('load', scanAndSave, true);
    document.removeEventListener('error', schedule, true);
    document.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
  }

  async function finishSaving(): Promise<ReturnType<typeof snapshot>> {
    const expectedGeneration = generation;
    await Promise.all([...blobs.values(), ...repairs.values()]);
    while (generation === expectedGeneration && pendingSaves > 0) {
      await archiveQueue;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (generation === expectedGeneration) await checkpoint();
    return snapshot();
  }

  window.addEventListener('beforeunload', event => {
    if (pendingSaves || pendingReads.size || repairs.size) {
      event.preventDefault(); event.returnValue = '';
    }
  });

  function start(usePixels = false, resume?: ResumeState): void {
    stop();
    // A new generation must not wait behind a stalled previous storage request.
    if(!resume)archiveQueue=Promise.resolve();
    records.clear(); nodes.clear(); seen.clear(); blobs.clear(); chapterPages.clear(); readerChapters.clear();
    positions = new WeakMap(); nextOrder = 0; generation = resume?.generation ?? crypto.randomUUID();
    title = resume?.title || ''; manualOrder = resume?.manualOrder || [];
    inheritedMissing = 0;
    readerOffset = 0;
    if (resume) {
      for (const chapter of resume.readerChapters || []) readerChapters.set(chapter.key, { ...chapter });
      // Migrate older single-chapter snapshots without losing their page slots.
      if (!readerChapters.size) for (const entry of resume.entries) {
        if (!entry.readerPage) continue;
        const key = readerChapterKey(entry.sourceUrl);
        const chapter = readerChapters.get(key) || { key, total: 0, offset: 0 };
        chapter.total = Math.max(chapter.total, entry.readerPage);
        readerChapters.set(key, chapter);
      }
      const firstCurrent = resume.entries.findIndex(entry => sameReaderChapter(entry.sourceUrl));
      readerOffset = firstCurrent >= 0 ? firstCurrent : resume.entries.length;
      for (const entry of resume.entries) {
        const order = resume.readerChapters?.length ? entry.order
          : entry.readerPage && sameReaderChapter(entry.sourceUrl) ? readerOffset + entry.readerPage - 1 : nextOrder;
        records.set(entry.url, { ...entry, order });
        nextOrder = Math.max(nextOrder + 1, order + 1);
        if (entry.readerPage) chapterPages.set(readerSlot(entry.readerPage, entry.sourceUrl), entry.url);
      }
      if (!resume.readerChapters?.length && !resume.entries.some(entry => sameReaderChapter(entry.sourceUrl))) inheritedMissing = resume.missing;
    }
    autoPixels = usePixels; archiveError = ''; pendingSaves = 0; pendingReads.clear(); pendingWrites.clear(); repairs.clear(); repairAttempts.clear();
    captureNotice = '';
    try { readerScope = resume?.autoResume || { origin: new URL(location.href).origin,
      chapterKey: navigationChapterKey(location.href), includeNextChapters: false }; }
    catch { readerScope = undefined; }
    if (!resume) void queueArchive({ action: 'archive-reset', state: { generation, entries: [], title, missing: 0, capturing: true } });
    capturing = true;
    scan();
    mutation = new MutationObserver(schedule);
    mutation.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['src', 'srcset', 'sizes', 'style', 'class', 'hidden', 'data-loaded', 'data-nbpage', 'data-page'] });
    // Start reading during the capture phase, before a target onload handler can
    // revoke its URL. A requestAnimationFrame here would be too late.
    document.addEventListener('load', scanAndSave, true);
    document.addEventListener('error', schedule, true);
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
  }

  function snapshot() {
    scan();
    // Connected images use DOM order. Removed/recycled images retain reserved
    // positions; manual ordering is available for ambiguous readers.
    const entries = [...records.values()].sort((a, b) => a.order - b.order);
    const connected = entries.filter(entry => {
      const node = nodes.get(entry.url);
      return node?.isConnected && (node.currentSrc || node.src) === entry.url;
    });
    connected.sort((a, b) => nodes.get(a.url)!.compareDocumentPosition(nodes.get(b.url)!) & 4 ? -1 : 1);
    let index = 0;
    const connectedSet = new Set(connected);
    const reader = chapterReader();
    const ordered = reader ? entries : entries.map(entry => connectedSet.has(entry) ? connected[index++] : entry);
    const unread = reader ? [...readerChapters.values()].reduce((total, chapter) => total + Math.max(0, chapter.total
      - [...chapterPages.keys()].filter(slot => slot.startsWith(chapter.key + '\n')).length), 0) : 0;
    const missing = inheritedMissing + Math.max(unread, [...seen].filter(img => !img.complete || !img.naturalWidth).length);
    const byUrl = new Map(ordered.map(entry => [entry.url, entry]));
    const manualSet = new Set(manualOrder);
    const finalOrder = [...manualOrder.filter(url => byUrl.has(url)).map(url => byUrl.get(url)!),
      ...ordered.filter(entry => !manualSet.has(entry.url))];
    const localPages = finalOrder.filter(entry => entry.url.startsWith('blob:'));
    const currentPageFailures=localPages.filter(entry=>{
      const node=nodes.get(entry.url);
      return entry.saveState==='error'&&node?.isConnected&&(node.currentSrc||node.src)===entry.url;
    });
    return { capturing, generation, title, entries: finalOrder, missing, autoPixels, archiveError, captureNotice, manualOrder,
      currentPageFailures:currentPageFailures.length,
      currentPageError:currentPageFailures[0]?.saveError,
      readerChapters: [...readerChapters.values()],
      savedCount: localPages.filter(entry => entry.saveState === 'saved').length,
      unsavedCount: localPages.filter(entry => entry.saveState !== 'saved').length,
      pendingSaves: pendingSaves + pendingReads.size + repairs.size };
  }

  browser.runtime.onMessage.addListener((message: { action: string; url?: string; selected?: boolean; title?: string; urls?: string[]; generation?: string; offset?: number; autoPixels?: boolean; state?: ResumeState; token?: string; policy?: AutoResumePolicy }) => {
    switch (message.action) {
      case 'blob-data': return blobChunk(message);
      case 'capture-displayed-pixels': return capturePixels(message);
      case 'start': start(message.autoPixels); return checkpoint().then(() => snapshot());
      case 'auto-resume':
        if (!message.state?.generation || !message.token) return Promise.resolve({ error: 'Invalid automatic capture request.' });
        return resumeAutomatically(message.state, message.token);
      case 'configure-auto-scope':
        if (message.generation === generation && message.policy) readerScope = message.policy;
        return Promise.resolve(snapshot());
      case 'resume':
        if (!message.state?.generation || !Array.isArray(message.state.entries)) return Promise.resolve({ error: 'Invalid saved capture.' });
        start(message.autoPixels, message.state); break;
      case 'stop': stop(); void checkpoint(); return finishSaving();
      case 'select': {
        const entry = records.get(message.url || '');
        if (entry) entry.selected = Boolean(message.selected);
        break;
      }
      case 'title': title = message.title || ''; break;
      case 'reorder': manualOrder = [...new Set(message.urls || [])].filter(url => records.has(url)); break;
      case 'images': repairAttempts.clear(); break;
      case 'status': break;
      default: return undefined;
    }
    const state = snapshot();
    if (['start', 'resume', 'stop', 'select', 'title', 'reorder', 'images'].includes(message.action)) void checkpoint();
    return Promise.resolve(state);
  });
})();
