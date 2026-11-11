// Resume only sessions explicitly enabled by the user, in their original tab.

async function navigationSession(tabId: number): Promise<StoredCapture | undefined> {
  return captureTransaction<StoredCapture | undefined>((sessions, _images, done) => {
    const request = sessions.get(tabId);
    request.onsuccess = () => done(request.result);
  });
}

async function navigationPause(tabId: number, token: string, reason?: string): Promise<void> {
  await captureTransaction<void>((sessions, _images, done) => {
    const request = sessions.get(tabId);
    request.onsuccess = () => {
      const state = request.result as StoredCapture | undefined;
      if (state?.autoResume?.token === token) {
        state.autoResume.pauseReason = reason; sessions.put(state, tabId);
      }
      done();
    };
  });
}

async function authorizedNavigationState(tabId: number, token?: string) {
  const state = await navigationSession(tabId);
  const policy = state?.autoResume;
  if (!state || !policy?.enabled || (token && token !== policy.token)) return { error: 'Automatic continuation is disabled.' };
  const tab = await browser.tabs.get(tabId);
  if (!tab.url || !navigationAllowed(policy, tab.url)) return { error: 'Outside the current chapter/site. The saved capture is unchanged.' };
  if (!await browser.permissions.contains({ origins: [policy.origin + '/*'] })) return { error: 'Site access is no longer granted.' };
  return { state, policy, url: tab.url as string };
}

const navigationJobs = new Map<number, Promise<void>>();
function resumeAfterNavigation(tabId: number): Promise<void> {
  const running = navigationJobs.get(tabId);
  if (running) return running;
  const job = (async () => {
    const session = await navigationSession(tabId);
    if (!session?.autoResume?.enabled) return;
    const token = session.autoResume.token;
    try {
      const approved = await authorizedNavigationState(tabId, token);
      if ('error' in approved) { await navigationPause(tabId, token, approved.error); return; }
      try {
        const live = await browser.tabs.sendMessage(tabId, { action: 'status' });
        if (live?.capturing && live.generation === approved.state.generation) {
          await browser.tabs.sendMessage(tabId, { action: 'configure-auto-scope', generation: live.generation, policy: approved.policy });
          return;
        }
      } catch { /* A full navigation destroys the previous content script. */ }
      await browser.scripting.executeScript({ target: { tabId }, files: ['imageInfo.js', 'navigationScope.js', 'content.js'] });
      const fresh = await authorizedNavigationState(tabId, token);
      if ('error' in fresh) { await navigationPause(tabId, token, fresh.error); return; }
      const result = await browser.tabs.sendMessage(tabId, { action: 'auto-resume',
        state: fresh.state, token, autoPixels: fresh.policy.autoPixels });
      await navigationPause(tabId, token, result?.paused ? 'Waiting for the reader or manual verification.' : result?.error);
    } catch (error) { await navigationPause(tabId, token, 'Automatic continuation paused: ' + String(error)); }
  })();
  navigationJobs.set(tabId, job);
  const cleanup = () => { if (navigationJobs.get(tabId) === job) navigationJobs.delete(tabId); };
  void job.then(cleanup, cleanup);
  return job;
}

browser.tabs.onUpdated.addListener((tabId: number, change: { status?: string; url?: string }) => {
  if (change.status === 'complete') void resumeAfterNavigation(tabId).catch(() => {
    // If storage itself is unavailable, ordinary capture writes report it in UI.
  });
});

browser.runtime.onMessage.addListener((message: { action?: string; tabId?: number; enabled?: boolean;
  generation?: string; token?: string; autoPixels?: boolean; includeNextChapters?: boolean },
sender: { id?: string; url?: string; frameId?: number; tab?: { id?: number } }) => {
  if (!message.action?.startsWith('navigation-')) return undefined;
  const fromExtension = sender.id === browser.runtime.id && sender.url?.startsWith(browser.runtime.getURL(''));
  const fromSource = sender.id === browser.runtime.id && sender.frameId === 0 && sender.tab?.id !== undefined;
  return (async () => {
    if (message.action === 'navigation-state' && fromSource) {
      const result = await authorizedNavigationState(sender.tab!.id!, message.token);
      if (!('error' in result)) await navigationPause(sender.tab!.id!, result.policy.token);
      return result;
    }
    if (!fromExtension || !Number.isSafeInteger(message.tabId)) throw new Error('Invalid automatic continuation request.');
    const tabId = message.tabId!;
    if (message.action === 'navigation-status') return { autoResume: (await navigationSession(tabId))?.autoResume };
    if (message.action !== 'navigation-control') throw new Error('Unknown navigation action.');
    const tab = await browser.tabs.get(tabId);
    if (!tab.url) throw new Error('Open the source chapter.');
    const origin = new URL(tab.url).origin;
    if (message.enabled && !await browser.permissions.contains({ origins: [origin + '/*'] })) {
      throw new Error('Allow access to this site to continue after navigation.');
    }
    const result = await captureTransaction<{ ok?: boolean; error?: string }>((sessions, _images, done) => {
      const request = sessions.get(tabId);
      request.onsuccess = () => {
        const state = request.result as StoredCapture | undefined;
        if (!state || state.generation !== message.generation) { done({ error: 'Capture changed. Refresh the popup.' }); return; }
        state.autoResume = { enabled: Boolean(message.enabled), token: crypto.randomUUID(), origin,
          chapterKey: navigationChapterKey(tab.url), autoPixels: Boolean(message.autoPixels),
          includeNextChapters: Boolean(message.includeNextChapters) };
        sessions.put(state, tabId); done({ ok: true });
      };
    });
    if (result.ok && message.enabled) await resumeAfterNavigation(tabId);
    return result;
  })().catch((error: unknown) => ({ error: String(error) }));
});
