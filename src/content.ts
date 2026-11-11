(() => {
  const scope = globalThis as typeof globalThis & { webtoonCaptureInstalled?: boolean };
  if (scope.webtoonCaptureInstalled) return;
  scope.webtoonCaptureInstalled = true;
  type Entry = { url: string; order: number; width: number; height: number; selected: boolean };
  let capturing = false;
  let generation = crypto.randomUUID();
  let title = '';
  let nextOrder = 0;
  let manualOrder: string[] = [];
  let positions = new WeakMap<HTMLImageElement, number>();
  const records = new Map<string, Entry>();
  const nodes = new Map<string, HTMLImageElement>();
  const seen = new Set<HTMLImageElement>();
  let mutation: MutationObserver | undefined;
  let scheduled = false;

  function visible(img: HTMLImageElement): boolean {
    const rect = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
      && rect.right > 0 && rect.left < innerWidth && style.visibility !== 'hidden'
      && style.display !== 'none' && style.opacity !== '0';
  }

  function scan(): void {
    if (!capturing) return;
    // Reserve positions before image downloads finish, including placeholders.
    for (const img of document.images) {
      if (!positions.has(img)) positions.set(img, nextOrder++);
      if (visible(img)) seen.add(img);
      if (!seen.has(img)) continue;
      const url = img.currentSrc || img.src;
      if (!/^https?:/.test(url) || !img.complete || !img.naturalWidth) continue;
      if (!records.has(url)) {
        records.set(url, { url, order: positions.get(img)!, width: img.naturalWidth,
          height: img.naturalHeight, selected: true });
        nodes.set(url, img);
      }
    }
  }

  function schedule(): void {
    if (scheduled || !capturing) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; scan(); });
  }

  function stop(): void {
    scan();
    capturing = false;
    mutation?.disconnect();
    document.removeEventListener('load', schedule, true);
    document.removeEventListener('error', schedule, true);
    document.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
  }

  function start(): void {
    stop();
    records.clear(); nodes.clear(); seen.clear();
    positions = new WeakMap(); nextOrder = 0; generation = crypto.randomUUID();
    title = ''; manualOrder = [];
    capturing = true;
    scan();
    mutation = new MutationObserver(schedule);
    mutation.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['src', 'srcset', 'sizes', 'style', 'class', 'hidden'] });
    document.addEventListener('load', schedule, true);
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
      const node = nodes.get(entry.url)!;
      return node.isConnected && (node.currentSrc || node.src) === entry.url;
    });
    connected.sort((a, b) => nodes.get(a.url)!.compareDocumentPosition(nodes.get(b.url)!) & 4 ? -1 : 1);
    let index = 0;
    const connectedSet = new Set(connected);
    const ordered = entries.map(entry => connectedSet.has(entry) ? connected[index++] : entry);
    const missing = [...seen].filter(img => !img.complete || !img.naturalWidth).length;
    const byUrl = new Map(ordered.map(entry => [entry.url, entry]));
    const manualSet = new Set(manualOrder);
    const finalOrder = [...manualOrder.filter(url => byUrl.has(url)).map(url => byUrl.get(url)!),
      ...ordered.filter(entry => !manualSet.has(entry.url))];
    return { capturing, generation, title, entries: finalOrder, missing };
  }

  browser.runtime.onMessage.addListener((message: { action: string; url?: string; selected?: boolean; title?: string; urls?: string[] }) => {
    switch (message.action) {
      case 'start': start(); break;
      case 'stop': stop(); break;
      case 'select': {
        const entry = records.get(message.url || '');
        if (entry) entry.selected = Boolean(message.selected);
        break;
      }
      case 'title': title = message.title || ''; break;
      case 'reorder': manualOrder = [...new Set(message.urls || [])].filter(url => records.has(url)); break;
      case 'status': case 'images': break;
      default: return undefined;
    }
    return Promise.resolve(snapshot());
  });
})();
