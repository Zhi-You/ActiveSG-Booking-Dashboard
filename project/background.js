chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'asg:open-map') return;
  sendResponse({ ok: true });
  const params = new URLSearchParams();
  if (sender.tab?.id != null) params.set('tab', String(sender.tab.id));
  if (msg.sport) params.set('sport', msg.sport);
  if (msg.date) params.set('date', msg.date);
  chrome.tabs.create({
    url: chrome.runtime.getURL(`map.html?${params}`),
    index: sender.tab ? sender.tab.index + 1 : undefined,
    openerTabId: sender.tab?.id,
  });
});
