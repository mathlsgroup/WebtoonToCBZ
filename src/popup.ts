declare const JSZip: new () => {
  file: (name: string, data: Blob) => void;
  generateAsync: (options: { type: 'blob'; compression: 'STORE' }) => Promise<Blob>;
};
type CapturedImage = { url: string; order: number; width: number; height: number };
const status = document.getElementById('status')!;
const list = document.getElementById('list')!;
const titleInput = document.getElementById('title') as HTMLInputElement;
const startButton = document.getElementById('start') as HTMLButtonElement;
const stopButton = document.getElementById('stop') as HTMLButtonElement;
const exportButton = document.getElementById('export') as HTMLButtonElement;
let tabId: number | undefined;
let entries: CapturedImage[] = [];

async function send(action: string): Promise<any> {
  if (tabId === undefined) throw new Error('No active tab');
  return browser.tabs.sendMessage(tabId, { action });
}
function setStatus(message: string): void { status.textContent = message; }
function render(): void {
  list.replaceChildren();
  for (const item of entries) {
    const row = document.createElement('label');
    row.className = 'entry';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = true;
    check.dataset.url = item.url;
    const preview = document.createElement('img');
    preview.src = item.url;
    preview.alt = 'Preview';
    const caption = document.createElement('span');
    caption.textContent = `${item.order + 1} · ${item.width}×${item.height}`;
    row.append(check, preview, caption);
    list.append(row);
  }
  exportButton.disabled = entries.length === 0;
}
async function refresh(): Promise<void> {
  entries = (await send('images')) as CapturedImage[];
  entries.sort((a, b) => a.order - b.order);
  render();
  setStatus(`${entries.length} images detected. Review before export.`);
}
async function safe(action: () => Promise<void>): Promise<void> {
  try { await action(); } catch (err) { setStatus(`Error: ${String(err)}`); }
}
startButton.onclick = () => safe(async () => {
  await send('start');
  setStatus('Capturing. Browse the chapter, then click Stop.');
});
stopButton.onclick = () => safe(async () => {
  await send('stop');
  await refresh();
});
document.getElementById('refresh')!.onclick = () => safe(refresh);
exportButton.onclick = () => safe(async () => {
  const selected = [...list.querySelectorAll<HTMLInputElement>('input:checked')].map(el => el.dataset.url!);
  if (!selected.length) { setStatus('Select at least one image.'); return; }
  exportButton.disabled = true;
  try {
    const zip = new JSZip();
    let count = 0;
    for (const url of selected) {
      setStatus(`Fetching image ${count + 1}/${selected.length}...`);
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) throw new Error(`Not an image: ${url}`);
      const extByType: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' };
      const ext = extByType[blob.type.split(';')[0]] || 'img';
      zip.file(`${String(++count).padStart(4, '0')}.${ext}`, blob);
    }
    const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const objectUrl = URL.createObjectURL(archive);
    const filename = `${(titleInput.value.trim() || 'chapter').replace(/[\\/:*?"<>|]/g, '_')}.cbz`;
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.click();
    setStatus(`Created ${filename} (${count} images).`);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  } finally { exportButton.disabled = false; }
});
void safe(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  if (!tabId) throw new Error('Open a chapter in a normal web tab.');
  const url = new URL(tab.url || 'https://example.invalid');
  titleInput.value = url.pathname.split('/').filter(Boolean).slice(-2).join(' - ') || 'chapter';
  const state = await send('status');
  setStatus(state.capturing ? `Capturing (${state.count} images).` : 'Ready to capture.');
  if (state.count) await refresh();
});
