// Shared by the background coordinator and isolated content script.
function navigationChapterKey(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Open an HTTP(S) chapter.');
  if (['scan-manga.com', 'www.scan-manga.com'].includes(url.hostname)) {
    const id = url.pathname.match(/_([0-9]+)\.html$/i)?.[1];
    if (id) return url.origin + '/scan-manga/' + id;
  }
  url.hash = '';
  url.pathname = url.pathname.replace(/\/page(?:\/|-)\d+\/?$/i, '').replace(/\/$/, '') || '/';
  for (const key of ['page', 'p', 'pg', 'pageno', 'pagenum']) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

function navigationAllowed(policy: Pick<AutoResumePolicy, 'origin' | 'includeNextChapters' | 'chapterKey'>, url: string): boolean {
  try { return new URL(url).origin === policy.origin && (policy.includeNextChapters || navigationChapterKey(url) === policy.chapterKey); }
  catch { return false; }
}
