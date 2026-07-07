// sw.js — service worker：点工具栏图标即打开侧边栏（原生侧边栏兜底）
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
// SW 启动时也设一次，确保重载后即生效
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// 注入式悬浮侧栏（panel-inject.js）问 SW 拿自己所在标签页 id——内容脚本自己拿不到。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.__marineGetTabId) {
    sendResponse({ tabId: sender.tab && sender.tab.id });
    return true;
  }
});
