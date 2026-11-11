(() => {
  type Entry = { url: string; order: number; width: number; height: number; selected: boolean };
  type State = { capturing: boolean; generation: string; title: string; entries: Entry[]; missing: number };
  const statusElement = document.getElementById('status')!;
  const list = document.getElementById('list')!;
  const titleInput = document.getElementById('title') as HTMLInputElement;
  const exportButton = document.getElementById('export') as HTMLButtonElement;
  const review = new URLSearchParams(location.search).has('tab');
  let tabId: number;
  let entries: Entry[] = [];
  let generation = '';
  let busy = false;
  let missing = 0;

  function setStatus(value: string): void { statusElement.textContent = value; }
  async function send(action: string, extra: object = {}): Promise<State> {
    try { return await browser.tabs.sendMessage(tabId, { action, ...extra }); }
    catch { throw new Error('Capture unavailable: the source tab was closed or navigated. Start again from the chapter.'); }
  }
  async function safe(action: () => Promise<void>): Promise<void> {
    try { await action(); } catch (error) { setStatus(String(error)); }
  }
  function render(): void {
    list.replaceChildren();
    entries.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'entry';
      const check = document.createElement('input');
      check.type = 'checkbox'; check.checked = item.selected;
      check.setAttribute('aria-label', 'Include page ' + (index + 1));
      check.onchange = () => {
        item.selected = check.checked;
        void safe(async () => { await send('select', { url: item.url, selected: item.selected }); });
      };
      const preview = document.createElement('img');
      preview.src = item.url; preview.alt = 'Page preview'; preview.loading = 'lazy';
      const caption = document.createElement('span');
      caption.textContent = (index + 1) + ' · ' + item.width + '×' + item.height;
      row.append(check, preview, caption);
      if (review) {
        for (const [label, offset] of [['Up', -1], ['Down', 1]] as const) {
          const button = document.createElement('button');
          button.textContent = label;
          button.disabled = index + offset < 0 || index + offset >= entries.length;
          button.onclick = () => {
            [entries[index], entries[index + offset]] = [entries[index + offset], entries[index]];
            render();
            void safe(async () => { await send('reorder', { urls: entries.map(entry => entry.url) }); });
          };
          row.append(button);
        }
      }
      list.append(row);
    });
    exportButton.disabled = busy || entries.length === 0;
  }
  async function refresh(action = 'images'): Promise<void> {
    const state = await send(action);
    const byUrl = new Map(state.entries.map(entry => [entry.url, entry]));
    // Keep manual ordering across refreshes, but never across capture generations.
    entries = generation === state.generation && review
      ? [...entries.filter(entry => byUrl.has(entry.url)).map(entry => byUrl.get(entry.url)!),
        ...state.entries.filter(entry => !entries.some(old => old.url === entry.url))]
      : state.entries;
    generation = state.generation;
    missing = state.missing;
    if (state.title) titleInput.value = state.title;
    else if (titleInput.value) await send('title', { title: titleInput.value });
    render();
    setStatus((state.capturing ? 'Capturing. ' : 'Stopped. ') + entries.length
      + ' images. Check order and exclude unwanted images.'
      + (missing ? ' WARNING: ' + missing + ' viewed image(s) not loaded or broken.' : ''));
  }
  document.getElementById('start')!.onclick = () => safe(async () => {
    if (busy) return;
    await refresh('start');
  });
  document.getElementById('stop')!.onclick = () => safe(async () => { if (!busy) await refresh('stop'); });
  document.getElementById('refresh')!.onclick = () => safe(async () => { if (!busy) await refresh(); });
  titleInput.oninput = () => { void safe(async () => { await send('title', { title: titleInput.value }); }); };

  exportButton.onclick = () => {
    if (busy) return;
    if (!review) {
      void safe(async () => {
        await browser.tabs.create({ url: browser.runtime.getURL('review.html') + '?tab=' + tabId });
      });
      return;
    }
    const selected = entries.filter(entry => entry.selected).map(entry => entry.url);
    if (!selected.length) { setStatus('Select at least one image.'); return; }
    // Request only image origins, directly inside the user gesture.
    const origins = [...new Set(selected.map(url => new URL(url).origin + '/*'))];
    busy = true;
    for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = true;
    const permission = browser.permissions.request({ origins });
    void safe(async () => {
      try {
        if (!await permission) throw new Error('Image host access was not granted.');
        const state = await send('stop');
        if (state.generation !== generation) {
          await refresh();
          throw new Error('Capture changed. Review the new list before exporting.');
        }
        missing = state.missing;
        if (missing) throw new Error(missing + ' viewed image(s) are not loaded or broken. Return to the chapter and recapture after they load.');
        if (state.entries.some(entry => !entries.some(old => old.url === entry.url))) {
          await refresh();
          throw new Error('New images were found. Review them before exporting.');
        }
        await exportArchive(selected, titleInput.value, setStatus);
      } finally {
        busy = false;
        for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = false;
        render();
      }
    });
  };

  void safe(async () => {
    if (review) {
      tabId = Number(new URLSearchParams(location.search).get('tab'));
      if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid source tab.');
      document.getElementById('start')!.hidden = true;
      exportButton.textContent = 'Export selected images to CBZ';
    } else {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined || !/^https?:/.test(tab.url || '')) throw new Error('Open an HTTP(S) chapter tab first.');
      tabId = tab.id;
      await browser.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      titleInput.value = new URL(tab.url).pathname.split('/').filter(Boolean).slice(-2).join(' - ') || 'chapter';
    }
    await refresh('status');
  });
})();
