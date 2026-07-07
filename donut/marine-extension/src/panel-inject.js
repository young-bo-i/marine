// panel-inject.js — 把 Marine 面板以悬浮侧栏形式注入到网页里。
// 为什么：Chrome 不允许扩展在启动时自动弹出 docked 侧边栏（sidePanel.open 需用户手势），
// 所以改用内容脚本注入一个 shadow-DOM 侧栏（iframe 加载 popup.html），默认展开 = 启动即自动显示。
// 面板绑定它所在的标签页（?tabId=），抓取/生成/填入都作用于这个页面。
(async () => {
  if (window.top !== window) return; // 仅顶层框架
  if (document.getElementById("__marine_panel_host")) return; // 只注入一次

  // 内容脚本拿不到自己的 tabId，向 SW 要一次。
  let tabId = null;
  try {
    const r = await chrome.runtime.sendMessage({ __marineGetTabId: true });
    tabId = r && r.tabId != null ? r.tabId : null;
  } catch (e) {
    /* SW 未就绪：面板仍能用当前窗口活动标签页兜底 */
  }

  const PANEL_W = 384;
  const host = document.createElement("div");
  host.id = "__marine_panel_host";
  const shadow = host.attachShadow({ mode: "open" });

  const src =
    chrome.runtime.getURL("popup.html") +
    (tabId != null ? "?tabId=" + tabId : "");

  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      .m-toggle {
        position: fixed; top: 14px; right: 0; width: 26px; height: 54px; border: none;
        background: #27272a; color: #c8c8c8; border-radius: 8px 0 0 8px; cursor: pointer;
        box-shadow: 0 1px 5px rgba(0,0,0,.45); font-size: 15px; line-height: 54px; padding: 0;
        z-index: 2147483647;
      }
      .m-toggle:hover { background: #3f3f46; }
      .m-panel {
        position: fixed; top: 0; bottom: 0; right: 0; width: ${PANEL_W}px;
        background: #18181b; border-left: 1px solid #2a2a2e;
        box-shadow: -2px 0 14px rgba(0,0,0,.35); transition: transform .18s ease;
        z-index: 2147483646;
      }
      .m-panel.collapsed { transform: translateX(100%); }
      .m-iframe { width: 100%; height: 100%; border: none; display: block; }
      @media (prefers-color-scheme: light) {
        .m-toggle { background: #f4f4f5; color: #18181b; }
        .m-panel { background: #fafafa; border-left-color: #e4e4e7; }
      }
    </style>
    <button class="m-toggle" title="Marine 截流面板">≈</button>
    <div class="m-panel">
      <iframe class="m-iframe" src="${src}" allow="clipboard-write; clipboard-read"></iframe>
    </div>
  `;
  shadow.appendChild(wrap);
  document.documentElement.appendChild(host);

  const panel = shadow.querySelector(".m-panel");
  const toggle = shadow.querySelector(".m-toggle");
  // 记住折叠状态（每个 profile 独立）。默认展开=自动显示。
  try {
    const s = await chrome.storage.local.get("marinePanelCollapsed");
    if (s && s.marinePanelCollapsed) panel.classList.add("collapsed");
  } catch (e) {}
  toggle.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    try {
      chrome.storage.local.set({ marinePanelCollapsed: collapsed });
    } catch (e) {}
  });
})();
