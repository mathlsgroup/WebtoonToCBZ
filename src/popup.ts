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
  const numberedMergeButton = document.getElementById('merge-numbered') as HTMLButtonElement | null;
  const detectButton = document.getElementById('detect') as HTMLButtonElement | null;
  const hideExcluded = document.getElementById('hide-excluded') as HTMLInputElement | null;
  const heightButton = document.getElementById('detect-height') as HTMLButtonElement | null;
  const targetHeightInput = document.getElementById('target-height') as HTMLInputElement | null;
  const heightToleranceInput = document.getElementById('height-tolerance') as HTMLInputElement | null;
  const minimumWidthInput = document.getElementById('minimum-width') as HTMLInputElement | null;
  const excludeNarrowButton = document.getElementById('exclude-narrow') as HTMLButtonElement | null;
  const objectUrls = new Set<string>();
  const mergeHistory: string[] = [];
  function ensurePageNumbers(): void {
    let next = entries.reduce((max, page) => Number.isSafeInteger(page.pageNumber)
      ? Math.max(max, page.pageNumber!) : max, 0) + 1;
    for (const page of entries) if (page.selected && page.pageNumber === undefined) page.pageNumber = next++;
  }
  function updateSelection(): void {
    if (!mergeButton || !undoButton) return;
    let message = 'Select at least two consecutive included pages with the Merge checkboxes.';
    let valid = false;
    try { const pages = mergeSelection(entries, mergeSelected); valid = true; message = pages.length + ' consecutive pages selected.'; }
    catch (error) { if (mergeSelected.size) message = String(error); }
    mergeButton.disabled = busy || !valid;
    undoButton.disabled = busy || !entries.some(page => page.sources);
    document.getElementById('selection')!.textContent = entries.filter(page => page.selected).length + ' included, '
      + entries.filter(page => !page.selected).length + ' excluded. ' + message;
    try {
      const groups = numberedPageGroups(entries);
      numberedMergeButton!.disabled = busy || !groups.length;
      document.getElementById('numbering')!.textContent = groups.length
        ? groups.length + ' numbered group(s) ready to merge. Check the assignments first.'
        : 'Edit page numbers or use Suggest page numbers to prepare groups.';
    } catch (error) {
      numberedMergeButton!.disabled = true;
      document.getElementById('numbering')!.textContent = String(error);
    }
    detectButton!.disabled = busy || !entries.some(page => page.selected);
    heightButton!.disabled = busy || !entries.some(page => page.selected);
    const counts = new Map<number, number>();
    for (const page of entries) if (page.selected && page.pageNumber !== undefined) {
      counts.set(page.pageNumber, (counts.get(page.pageNumber) ?? 0) + 1);
    }
    Array.from(list.children).forEach((row, index) => {
      row.classList.toggle('numbered-group', entries[index].selected && (counts.get(entries[index].pageNumber!) ?? 0) > 1);
    });
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
  function runReviewTask(pages: Entry[], message: string, task: (verify: () => Promise<void>) => Promise<void>): void {
    if (busy) return;
    const origins = [...new Set(pages.filter(page => !page.bytes).map(page => new URL(page.url).origin + '/*'))];
    // Host access must be requested in the click handler, before the first await.
    const permission = browser.permissions.request({ origins });
    busy = true; render(); setStatus(message);
    void safe(async () => {
      const verify = async (): Promise<void> => {
        const state = await send('status');
        if (state.generation !== generation) {
          await refresh(); throw new Error('Capture changed. Review the new list before continuing.');
        }
      };
      try {
        if (!await permission) throw new Error('Image host access was not granted.');
        const state = await send('stop');
        if (state.generation !== generation) {
          await refresh(); throw new Error('Capture changed. Review the new list before continuing.');
        }
        await task(verify);
      } finally {
        busy = false;
        for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = false;
        render();
      }
    });
  }
  function mergeGroups(groups: Entry[][]): void {
    runReviewTask(groups.flat(), 'Merging images. Keep this review tab open...', async verify => {
      const created: Entry[] = [];
      let committed = false;
      try {
        let result = entries;
        for (const [index, sources] of groups.entries()) {
          setStatus('Merging group ' + (index + 1) + '/' + groups.length + '...');
          const merged = await mergeImagesVertically(sources);
          created.push(merged);
          result = replaceMergedPages(result, sources, merged);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        await verify();
        entries = result;
        for (const page of created) { objectUrls.add(page.url); mergeHistory.push(page.url); }
        committed = true; mergeSelected.clear();
        setStatus('Merged ' + groups.length + ' group(s). Check Preview; Undo merge restores the sources.');
      } finally {
        // Failed batches leave every row intact and release provisional images.
        if (!committed) created.forEach(page => URL.revokeObjectURL(page.url));
      }
    });
  }
  function render(): void {
    if (review) ensurePageNumbers();
    list.replaceChildren();
    entries.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'entry' + (mergeSelected.has(item.url) ? ' merge-selected' : '');
      row.hidden = !!hideExcluded?.checked && !item.selected;
      const check = document.createElement('input');
      check.type = 'checkbox'; check.checked = item.selected;
      check.setAttribute('aria-label', 'Include page ' + (index + 1));
      check.onchange = () => {
        if (!check.checked) mergeSelected.delete(item.url);
        includeReviewPage(item, check.checked); render();
        void safe(async () => { for (const source of originalPages(item)) { source.selected = item.selected; await send('select', { url: source.url, selected: item.selected }); } });
      };
      const preview = document.createElement('img');
      preview.src = item.url; preview.alt = 'Page preview'; preview.loading = 'lazy';
      const caption = document.createElement('span');
      caption.textContent = (index + 1) + ' · ' + item.width + '×' + item.height;
      row.append(check, preview, caption);
      if (review) {
        const numberLabel = document.createElement('label'); numberLabel.className = 'page-number';
        const number = document.createElement('input');
        number.type = 'number'; number.min = '1'; number.step = '1';
        number.value = item.pageNumber === undefined ? '' : String(item.pageNumber);
        number.disabled = busy || !item.selected;
        number.setAttribute('aria-label', 'Page number for image ' + (index + 1));
        number.oninput = () => {
          item.pageNumber = number.valueAsNumber; item.groupingNote = 'Manual assignment';
          note.textContent = item.groupingNote; updateSelection();
        };
        numberLabel.append('Page number', number); row.append(numberLabel);
        const note = document.createElement('small'); note.className = 'grouping-note';
        note.textContent = item.groupingNote ?? ''; caption.append(document.createElement('br'), note);
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
          let target = index + offset;
          while (hideExcluded?.checked && target >= 0 && target < entries.length && !entries[target].selected) target += offset;
          const button = document.createElement('button');
          button.textContent = label;
          button.disabled = target < 0 || target >= entries.length;
          button.onclick = () => {
            [entries[index], entries[target]] = [entries[target], entries[index]];
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
    hideExcluded!.onchange = () => { if (!busy) render(); };
    excludeNarrowButton!.onclick = () => {
      if (busy) return;
      const minimum = minimumWidthInput!.valueAsNumber;
      if (!Number.isSafeInteger(minimum) || minimum < 1) {
        setStatus('Enter a positive whole minimum width in pixels.'); return;
      }
      const affected = entries.filter(page => page.selected && Number.isFinite(page.width) && page.width > 0 && page.width < minimum);
      busy = true; render();
      void safe(async () => {
        try {
          const state = await send('status');
          if (state.generation !== generation) {
            await refresh(); throw new Error('Capture changed. Review the new list before excluding images.');
          }
          for (const page of affected) {
            for (const source of originalPages(page)) {
              const updated = await send('select', { url: source.url, selected: false });
              if (updated.generation !== generation) {
                await refresh(); throw new Error('Capture changed. Review the new list before excluding images.');
              }
            }
            includeReviewPage(page, false); mergeSelected.delete(page.url);
          }
          setStatus(affected.length + ' image(s) narrower than ' + minimum + ' px excluded. '
            + 'Use Hide excluded images to hide them. Re-enable individual images with their inclusion checkbox.');
        } finally {
          busy = false;
          for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = false;
          render();
        }
      });
    };
    heightButton!.onclick = () => {
      if (busy) return;
      try {
        const target = targetHeightInput!.valueAsNumber;
        const tolerance = heightToleranceInput!.valueAsNumber;
        const suggestions = suggestPagesByHeight(entries, target, tolerance);
        for (const suggestion of suggestions) {
          suggestion.page.pageNumber = suggestion.pageNumber;
          suggestion.page.groupingNote = suggestion.note;
        }
        render();
        const groups = numberedPageGroups(entries);
        setStatus(groups.length + ' group(s) suggested near ' + target + ' px (tolerance ' + tolerance + '%) using captured dimensions. '
          + 'Check the groups, then click Merge numbered pages. Unmatched images remain separate.');
      } catch (error) { setStatus(String(error)); }
    };
    document.getElementById('close-preview')!.onclick = () => (document.getElementById('large-preview') as HTMLDialogElement).close();
    undoButton!.onclick = () => {
      const page = [...mergeHistory].reverse().map(url => entries.find(entry => entry.url === url)).find(entry => entry?.sources);
      if (page && !busy) undo(page);
    };
    detectButton!.onclick = () => {
      const pages = entries.filter(page => page.selected);
      runReviewTask(pages, 'Analyzing image borders. Keep this review tab open...', async verify => {
        const edges = new Map<string, PageEdges>();
        const failures = new Map<string, string>();
        for (const [index, page] of pages.entries()) {
          const message = 'Analyzing image ' + (index + 1) + '/' + pages.length + '...';
          setStatus(message); document.getElementById('numbering')!.textContent = message;
          try { edges.set(page.url, await inspectPageEdges(page)); }
          catch (error) { failures.set(page.url, 'Analysis failed: ' + String(error) + '. Check manually.'); }
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        await verify();
        for (const suggestion of suggestPageNumbers(entries, edges)) {
          suggestion.page.pageNumber = suggestion.pageNumber;
          suggestion.page.groupingNote = failures.get(suggestion.page.url) ?? suggestion.note;
        }
        setStatus('Page numbers suggested. Review and correct them, then click Merge numbered pages.'
          + (failures.size ? ' ' + failures.size + ' image(s) could not be analyzed and were kept separate.' : ''));
      });
    };
    numberedMergeButton!.onclick = () => {
      if (busy) return;
      try {
        const groups = numberedPageGroups(entries);
        if (!groups.length) { setStatus('Give consecutive images the same page number first.'); return; }
        mergeGroups(groups);
      } catch (error) { setStatus(String(error)); }
    };
    mergeButton!.onclick = () => {
      if (busy) return;
      let sources: Entry[];
      try { sources = mergeSelection(entries, mergeSelected); }
      catch (error) { setStatus(String(error)); return; }
      mergeGroups([sources]);
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
    try {
      if (numberedPageGroups(entries).length) {
        setStatus('Use Merge numbered pages before exporting, or assign different numbers to keep images separate.'); return;
      }
    } catch (error) { setStatus(String(error)); return; }
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
