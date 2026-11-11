(() => {
  type Entry = ReviewPage;
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
  const mergeSelected = new Set<string>();
  const mergeButton = document.getElementById('merge') as HTMLButtonElement | null;
  const undoButton = document.getElementById('undo') as HTMLButtonElement | null;
  const objectUrls = new Set<string>();
  const mergeHistory: string[] = [];
  function updateSelection(): void {
    if (!mergeButton || !undoButton) return;
    let message = 'Select at least two consecutive included pages with the Merge checkboxes.';
    let valid = false;
    try { const pages = mergeSelection(entries, mergeSelected); valid = true; message = pages.length + ' consecutive pages selected.'; }
    catch (error) { if (mergeSelected.size) message = String(error); }
    mergeButton.disabled = busy || !valid;
    undoButton.disabled = busy || !entries.some(page => page.sources);
    document.getElementById('selection')!.textContent = entries.length + ' pages. ' + message;
  }
  function syncOrder(): Promise<State> {
    return send('reorder', { urls: entries.flatMap(originalPages).map(page => page.url) });
  }
  function undo(page: Entry): void {
    entries = undoMergedPage(entries, page);
    mergeSelected.delete(page.url);
    URL.revokeObjectURL(page.url); objectUrls.delete(page.url);
    render();
    void safe(async () => { await syncOrder(); });
  }
  window.addEventListener('unload', () => { objectUrls.forEach(url => URL.revokeObjectURL(url)); });

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
      row.className = 'entry' + (mergeSelected.has(item.url) ? ' merge-selected' : '');
      const check = document.createElement('input');
      check.type = 'checkbox'; check.checked = item.selected;
      check.setAttribute('aria-label', 'Include page ' + (index + 1));
      check.onchange = () => {
        includeReviewPage(item, check.checked); updateSelection();
        void safe(async () => { for (const source of originalPages(item)) { source.selected = item.selected; await send('select', { url: source.url, selected: item.selected }); } });
      };
      const preview = document.createElement('img');
      preview.src = item.url; preview.alt = 'Page preview'; preview.loading = 'lazy';
      const caption = document.createElement('span');
      caption.textContent = (index + 1) + ' · ' + item.width + '×' + item.height;
      row.append(check, preview, caption);
      if (review) {
        const selectLabel = document.createElement('label');
        const select = document.createElement('input'); select.type = 'checkbox';
        select.checked = mergeSelected.has(item.url); select.disabled = busy;
        select.setAttribute('aria-label', 'Select page ' + (index + 1) + ' for merging');
        select.onchange = () => {
          if (select.checked) mergeSelected.add(item.url); else mergeSelected.delete(item.url);
          row.classList.toggle('merge-selected', select.checked); updateSelection();
        };
        selectLabel.append(select, 'Merge'); row.append(selectLabel);
        const enlarge = document.createElement('button'); enlarge.textContent = 'Preview';
        enlarge.onclick = () => {
          const dialog = document.getElementById('large-preview') as HTMLDialogElement;
          dialog.querySelector('img')!.src = item.url; dialog.showModal();
        };
        row.append(enlarge);
        if (item.sources) {
          const restore = document.createElement('button'); restore.textContent = 'Undo merge';
          restore.disabled = busy; restore.onclick = () => undo(item); row.append(restore);
        }
        for (const [label, offset] of [['Up', -1], ['Down', 1]] as const) {
          const button = document.createElement('button');
          button.textContent = label;
          button.disabled = index + offset < 0 || index + offset >= entries.length;
          button.onclick = () => {
            [entries[index], entries[index + offset]] = [entries[index + offset], entries[index]];
            render();
            void safe(async () => { await syncOrder(); });
          };
          row.append(button);
        }
      }
      list.append(row);
    });
    if (busy) for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = true;
    exportButton.disabled = busy || entries.length === 0;
    updateSelection();
  }
  async function refresh(action = 'images'): Promise<void> {
    const state = await send(action);
    const byUrl = new Map(state.entries.map(entry => [entry.url, entry]));
    if (generation === state.generation && review) {
      const known = new Set(entries.flatMap(originalPages).map(page => page.url));
      for (const page of entries) {
        if (!page.sources) page.selected = byUrl.get(page.url)?.selected ?? page.selected;
      }
      entries.push(...state.entries.filter(page => !known.has(page.url)));
    } else {
      objectUrls.forEach(url => URL.revokeObjectURL(url)); objectUrls.clear();
      mergeSelected.clear(); mergeHistory.length = 0;
      entries = state.entries;
    }
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

  if (review) {
    document.getElementById('close-preview')!.onclick = () => (document.getElementById('large-preview') as HTMLDialogElement).close();
    undoButton!.onclick = () => {
      const page = [...mergeHistory].reverse().map(url => entries.find(entry => entry.url === url)).find(entry => entry?.sources);
      if (page && !busy) undo(page);
    };
    mergeButton!.onclick = () => {
      if (busy) return;
      let sources: Entry[];
      try { sources = mergeSelection(entries, mergeSelected); }
      catch (error) { setStatus(String(error)); return; }
      const origins = [...new Set(sources.flatMap(originalPages).filter(page => !page.bytes).map(page => new URL(page.url).origin + '/*'))];
      const permission = browser.permissions.request({ origins });
      busy = true; render(); setStatus('Merging images. Keep this review tab open...');
      void safe(async () => {
        try {
          if (!await permission) throw new Error('Image host access was not granted.');
          const state = await send('stop');
          if (state.generation !== generation) { await refresh(); throw new Error('Capture changed. Select pages again.'); }
          const merged = await mergeImagesVertically(sources);
          objectUrls.add(merged.url); mergeHistory.push(merged.url);
          entries = replaceMergedPages(entries, sources, merged);
          mergeSelected.clear();
          setStatus('Merged ' + sources.length + ' pages into ' + merged.width + ' x ' + merged.height + '. Originals are available with Undo merge.');
        } finally {
          busy = false;
          for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = false;
          render();
        }
      });
    };
  }

  exportButton.onclick = () => {
    if (busy) return;
    if (!review) {
      void safe(async () => {
        await browser.tabs.create({ url: browser.runtime.getURL('review.html') + '?tab=' + tabId });
      });
      return;
    }
    const selected = entries.filter(entry => entry.selected);
    if (!selected.length) { setStatus('Select at least one image.'); return; }
    // Request only image origins, directly inside the user gesture.
    const origins = [...new Set(selected.filter(page => !page.bytes).map(page => new URL(page.url).origin + '/*'))];
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
        if (state.entries.some(entry => !entries.flatMap(originalPages).some(old => old.url === entry.url))) {
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
