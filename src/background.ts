// Only the top-frame capture script may request an already displayed local blob.
// No HTTP requests, page variables, URL interception or image reconstruction.
browser.runtime.onMessage.addListener((message: { action?: string; url?: string }, sender: {
  id?: string; frameId?: number; tab?: { id?: number }; url?: string;
}) => {
  if (message.action !== 'read-displayed-blob') return undefined;
  const tabId = sender.tab?.id;
  const url = message.url;
  if (sender.id !== browser.runtime.id || sender.frameId !== 0 || tabId === undefined
    || typeof url !== 'string' || !url.startsWith('blob:')) return Promise.resolve({ error: 'Invalid source image request.' });
  try {
    if (!sender.url || new URL(url).origin !== new URL(sender.url).origin) {
      return Promise.resolve({ error: 'Only same-origin displayed blobs can be read.' });
    }
  } catch { return Promise.resolve({ error: 'Invalid source image URL.' }); }
  return browser.scripting.executeScript({
    target: { tabId }, world: 'MAIN', args: [url],
    func: async (source: string) => {
      try {
        if (new URL(source).origin !== location.origin || !source.startsWith('blob:')
          || !Array.from(document.images).some(img => (img.currentSrc || img.src) === source
            && img.complete && img.naturalWidth > 0)) {
          return { error: 'The source image is no longer loaded in this document.' };
        }
        const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) return { error: 'Local image response: HTTP ' + response.status };
        const blob = await response.blob();
        if (!blob.size || blob.size > 64 * 1024 * 1024) return { error: 'Local image is empty or exceeds the 64 MiB transfer limit.' };
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const chunks: string[] = [];
        for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
          const end = Math.min(offset + 256 * 1024, bytes.length);
          let binary = '';
          for (let index = offset; index < end; index += 8192) {
            binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 8192, end)));
          }
          chunks.push(btoa(binary));
        }
        return { chunks, total: bytes.length };
      } catch (error) {
        return { error: 'Page-context blob read failed: ' + String(error)
          + '. Original bytes are unavailable; the URL may be revoked or blocked. If the image is still loaded, use the explicit displayed-pixels PNG action, or exclude this image.' };
      }
    },
  }).then((results: { result?: unknown; error?: { message?: string } }[]) => {
    return results[0]?.result ?? { error: results[0]?.error?.message || 'Page-context image reader did not return data.' };
  }).catch((error: unknown) => ({ error: 'Page-context image reader unavailable: ' + String(error) }));
});
