// sw.js — service worker：点工具栏图标即打开侧边栏
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
// SW 启动时也设一次，确保重载后即生效
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
