// bilibili.js — Bilibili 字幕提取（运行在 ISOLATED world）
// 流程：从 URL 取 bvid → x/web-interface/view 得到 aid + 分P cid →
//       x/player/wbi/v2?aid=&cid= 得到 subtitle.subtitles[] →
//       取 subtitle_url（协议相对，补 https）→ 拉取 JSON → 解析 body[]。
// 说明：B 站字幕需登录后可见（content script 自动带上浏览器的登录 Cookie）。
//       该 player 接口对 w_rid(WBI) 签名为可选，登录态下可直接请求；如遇风控可再加签名。

async function marineBiliGetJSON(url) {
  const res = await fetch(url, { credentials: 'include' });
  return res.json();
}

async function marineExtractBilibili(opts) {
  opts = opts || {};
  const path = location.pathname;
  const bvMatch = path.match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (!bvMatch) {
    return { ok: false, error: '当前不是 Bilibili 普通视频页（仅支持 bilibili.com/video/BV... ）。' };
  }
  const bvid = bvMatch[1];
  const p = parseInt(new URLSearchParams(location.search).get('p') || '1', 10) || 1;
  marineLog('info', 'bilibili', '开始提取：' + bvid + ' p=' + p);

  let view;
  try {
    view = await marineBiliGetJSON('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
  } catch (e) {
    return { ok: false, error: '请求视频信息失败：' + (e && e.message || e) };
  }
  if (!view || view.code !== 0 || !view.data) {
    return { ok: false, error: '获取视频信息失败：' + (view && view.message || '未知错误') };
  }
  const aid = view.data.aid;
  const pages = view.data.pages || [];
  const cid = (pages[p - 1] && pages[p - 1].cid) || view.data.cid;
  marineLog('info', 'bilibili', 'view → aid=' + aid + ' cid=' + cid);

  let player;
  try {
    player = await marineBiliGetJSON(
      'https://api.bilibili.com/x/player/wbi/v2?aid=' + aid + '&cid=' + cid);
  } catch (e) {
    return { ok: false, error: '请求播放器信息失败：' + (e && e.message || e) };
  }
  if (!player || player.code !== 0 || !player.data) {
    return { ok: false, error: '获取播放器信息失败：' + (player && player.message || '未知错误') };
  }

  const subObj = player.data.subtitle || {};
  let list = (subObj.subtitles || []).filter(s => s.subtitle_url);
  marineLog(list.length ? 'info' : 'warn', 'bilibili',
    '字幕轨：' + list.length + ' 条' + (list.length ? '（' + list.map(s => s.lan).join(',') + '）' : '（需登录或该视频无字幕）'));
  if (!list.length) {
    return {
      ok: false,
      error: '未找到字幕。请确认：①已登录 B 站（字幕需登录可见）；②该视频确有 CC / AI 字幕。'
    };
  }

  const langs = list.map(s => ({ code: s.lan, name: s.lan_doc || s.lan }));
  const track = list.find(s => opts.lang && s.lan === opts.lang) || list[0];

  let url = track.subtitle_url;
  if (url.startsWith('//')) url = 'https:' + url;
  else if (url.startsWith('http://')) url = 'https://' + url.slice(7);

  marineLog('net', 'bilibili', '拉取字幕文件：' + track.lan);
  let data;
  try {
    // 字幕文件由 URL 中的 auth_key 鉴权，无需带 Cookie；同源 Referer 由页面自动附带。
    data = await (await fetch(url)).json();
  } catch (e) {
    marineLog('error', 'bilibili', '下载字幕文件失败：' + (e && e.message || e));
    return { ok: false, error: '下载字幕文件失败：' + (e && e.message || e) };
  }
  const cues = marineParseBiliBody(data);
  marineLog(cues.length ? 'ok' : 'warn', 'bilibili', '字幕解析：' + cues.length + ' 条');
  return {
    ok: cues.length > 0,
    source: 'bilibili',
    lang: track.lan,
    langs,
    cues,
    error: cues.length ? undefined : '字幕文件为空。'
  };
}
