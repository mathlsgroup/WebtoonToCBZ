// Observe visible chapter images while the user browses normally.
type CapturedImage = { url: string; order: number; width: number; height: number };
let capturing = false;
let counter = 0;
const images = new Map<string, CapturedImage>();
let observer: MutationObserver | undefined;

function scan(): void {
  if (!capturing) return;
  for (const img of document.images) {
    const url = img.currentSrc || img.src;
    if (!url || !/^https?:/.test(url)) continue;
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    // Exclude common icons and tracking pixels; review is still necessary.
    if (width < 250 || height < 250) continue;
    if (!images.has(url)) images.set(url, { url, order: counter++, width, height });
  }
}

function start(): void {
  capturing = true;
  counter = 0;
  images.clear();
  scan();
  observer?.disconnect();
  observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset'] });
  document.addEventListener('load', scan, true);
}
function stop(): void {
  capturing = false;
  observer?.disconnect();
  document.removeEventListener('load', scan, true);
}

browser.runtime.onMessage.addListener((message: { action: string }) => {
  if (message.action === 'start') { start(); return Promise.resolve({ ok: true }); }
  if (message.action === 'stop') { scan(); stop(); return Promise.resolve({ ok: true }); }
  if (message.action === 'status') return Promise.resolve({ capturing, count: images.size });
  if (message.action === 'images') { scan(); return Promise.resolve([...images.values()]); }
  return undefined;
});
