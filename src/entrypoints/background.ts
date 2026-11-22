/**
 * Toolbar click → open the optimizer page bound to the TCGplayer tab the user
 * was on (the page talks to TCGplayer through that tab's content script).
 */
export default defineBackground(() => {
  // MV3 (Chrome) exposes `action`; the Firefox build is MV2, which has `browserAction`.
  const action = browser.action ?? browser.browserAction;
  action.onClicked.addListener(async (tab) => {
    const params = new URLSearchParams();
    if (tab.id !== undefined && tab.url && /^https:\/\/([a-z0-9-]+\.)*tcgplayer\.com\//.test(tab.url)) {
      params.set('tabId', String(tab.id));
    }
    const url = browser.runtime.getURL(`/optimizer.html?${params}`);
    await browser.tabs.create({ url, index: tab.index + 1 });
  });
});
