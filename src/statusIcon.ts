// Poll committed metadata only: no payload reads, permissions or source-tab messages.
// This also catches navigation updates and preparation work while the popup is closed.
function captureIconStatus(tabId: number, state?: StoredCapture): { color: string; title: string } {
  if (!state) return { color: 'idle', title: 'No capture in this tab' };
  const selected = state.entries.filter(page => page.selected);
  const jobs = [...preparationJobs.keys()].some(key => JSON.parse(key)[0] === tabId);
  const errors = [...preparationErrors.keys()].some(key => JSON.parse(key)[0] === tabId);
  if (state.archiveError || errors || selected.some(page => page.saveState === 'error')) {
    return { color: 'busy', title: 'Image processing failed — open review for details' };
  }
  if (state.missing > 0 || selected.some(page => page.url.startsWith('blob:') && page.saveState !== 'saved')) {
    return { color: 'busy', title: 'Images pending, missing or not saved locally' };
  }
  if (jobs) return { color: 'busy', title: 'Processing images (thumbnails / JPEG)' };
  if (!selected.length) return { color: 'idle', title: 'Waiting for chapter images' };
  const remote = selected.some(page => !page.url.startsWith('blob:'));
  return { color: 'ready', title: remote
    ? 'Known processing complete — remote images will be downloaded at export'
    : 'Known images saved and processing complete' };
}

const displayedCaptureIcons = new Map<number, string>();
let refreshingCaptureIcons = false;
async function refreshCaptureIcons(): Promise<void> {
  if (refreshingCaptureIcons) return;
  refreshingCaptureIcons = true;
  try {
    const database = await captureDatabase;
    const states = await new Promise<Map<number, StoredCapture>>((resolve, reject) => {
      const result = new Map<number, StoredCapture>();
      const transaction = database.transaction('sessions', 'readonly');
      const cursor = transaction.objectStore('sessions').openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (item) { result.set(Number(item.key), item.value); item.continue(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    for (const tabId of new Set([...states.keys(), ...displayedCaptureIcons.keys()])) {
      const status = captureIconStatus(tabId, states.get(tabId));
      const signature = JSON.stringify(status);
      if (displayedCaptureIcons.get(tabId) === signature) continue;
      try {
        await browser.action.setIcon({ tabId, path: `icons/${status.color}.svg` });
        await browser.action.setTitle({ tabId, title: `Webtoon to CBZ — ${status.title}` });
        displayedCaptureIcons.set(tabId, signature);
      } catch { displayedCaptureIcons.delete(tabId); } // Source tab may have closed.
    }
  } catch {
    // Never retain a green success indicator when storage cannot be inspected.
    for (const tabId of displayedCaptureIcons.keys()) {
      await browser.action.setIcon({ tabId, path: 'icons/busy.svg' }).catch(() => {});
      await browser.action.setTitle({ tabId, title: 'Webtoon to CBZ — Local storage unavailable' }).catch(() => {});
    }
    displayedCaptureIcons.clear();
  } finally { refreshingCaptureIcons = false; }
}

setInterval(() => { void refreshCaptureIcons(); }, 750);
void refreshCaptureIcons();
