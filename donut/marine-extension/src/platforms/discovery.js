// discovery.js — 发现侧：把平台搜索结果解析成候选（直评场景）
//
// 由 scratchpad/port-to-extension.mjs 从已验证的解析器自动生成，请勿手改；
// 要改逻辑请改 scratchpad/parse-*.mjs 后重新生成。
//
// 每个平台的取数层不一样，这不是设计选择而是实测结果：
//   · bilibili    SSR HTML —— 搜索首屏没有结果接口，只有 nav / search/default
//   · xiaohongshu SSR DOM  —— /search/notes 首屏不触发；curl 抓不到 data-note-id，
//                             候选和 xsec_token 只能从真实浏览器渲染后的 DOM 拿
//   · zhihu       /api/v4/search_v3 优先，DOM 兜底（两条路产出都会波动，需按 id 合并）
//   · douyin      渲染后 DOM 为主，/aweme/v1/web/general/search/ 补精确指标
//
// 运行在 ISOLATED world，经典脚本（无 import/export），全局入口 marineDiscovery。

var marineDiscovery = marineDiscovery || {};

(function () {
  'use strict';

  // ---------------------------------------------------------------- bilibili
  marineDiscovery.bilibili = (function () {
    /**
     * Bilibili 搜索结果页「发现侧」解析器
     *
     * 场景：只做直评（在视频本身下面发评论），所以一条候选 = 一个可评论的视频。
     * 输入：搜索结果页的 SSR/实时 DOM HTML（如 p4-bilibili.html）
     * 输出：[{ id, title, metrics, open_url, author, ... }]
     *
     * 只用 node 内置能力（纯字符串/正则），无第三方依赖。
     *
     * 结构要点（实测自 p4-bilibili.html）：
     *   .bili-video-card                 卡片容器（42 个）
     *     .bili-video-card__skeleton     骨架屏，永远存在且带 hide，必须跳过
     *     .bili-video-card__wrap         真实内容从这里开始
     *       a[href^="//www.bilibili.com/video/BV..."]   标题/封面链接 -> BV 号
     *       .bili-video-card__stats--item  第 1 个=播放量，第 2 个=弹幕数
     *       .bili-video-card__stats__duration           时长 mm:ss / hh:mm:ss
     *       .bili-video-card__info--tit[title]          干净标题（内文里有 <em class="keyword">）
     *       .bili-video-card__info--owner[href*=space]  UP 主页 -> mid
     *       .bili-video-card__info--author              UP 名
     *       .bili-video-card__info--date                " · 2023-08-09" 或 " · 07-09"
     */

    // ---------------------------------------------------------------- helpers

    const EXPECTED_STATS_PER_CARD = 2;  // 播放 + 弹幕

    const ENTITIES = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#34': '"',
    };

    function decodeEntities(s) {
      if (!s) return s;
      return s
        .replace(/&(amp|lt|gt|quot|apos|nbsp|#39|#34);/g, (_, k) => ENTITIES[k])
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 16)));
    }

    function stripTags(s) {
      return decodeEntities(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    }

    /** "3082" -> 3082, "6.6万" -> 66000, "118.9万" -> 1189000, "1.2亿" -> 120000000, "-" -> null */
    function parseCount(text) {
      if (text == null) return null;
      const t = String(text).replace(/[,\s]/g, '');
      if (!t || /^-+$/.test(t)) return null;
      const m = t.match(/^([\d.]+)\s*([万亿])?$/);
      if (!m) return null;
      const n = parseFloat(m[1]);
      if (!Number.isFinite(n)) return null;
      const mult = m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1;
      return Math.round(n * mult);
    }

    /** "00:54" -> 54, "36:19" -> 2179, "1:02:33" -> 3753 */
    function parseDuration(text) {
      if (!text) return null;
      const parts = String(text).trim().split(':').map((x) => parseInt(x, 10));
      if (parts.some((x) => !Number.isFinite(x))) return null;
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 1) return parts[0];
      return null;
    }

    /** " · 2023-08-09" -> "2023-08-09"；" · 07-09" -> "07-09"（B 站当年发布省略年份，无法安全补年） */
    function parsePubDate(raw) {
      if (!raw) return null;
      const t = stripTags(raw).replace(/^[·•・]\s*/, '').trim();
      return t || null;
    }

    // ---------------------------------------------------------------- 卡片切分

    // class="bili-video-card"（容器），排除 __wrap / __info / __skeleton 等 BEM 子元素
    const CARD_ANCHOR = /class="bili-video-card(?![_])[^"]*"/g;
    // 兜底：结果列表结束的标志
    const LIST_END_MARKERS = ['vui_pagenation', 'class="bili-footer', '</main>', 'id="i_cecream"'];

    function sliceCards(html) {
      const anchors = [];
      CARD_ANCHOR.lastIndex = 0;
      let m;
      while ((m = CARD_ANCHOR.exec(html)) !== null) anchors.push(m.index);
      if (anchors.length === 0) return [];

      // 最后一张卡的结束边界
      const lastStart = anchors[anchors.length - 1];
      let end = html.length;
      for (const mark of LIST_END_MARKERS) {
        const i = html.indexOf(mark, lastStart);
        if (i !== -1 && i < end) end = i;
      }

      return anchors.map((start, i) => {
        const stop = i + 1 < anchors.length ? anchors[i + 1] : end;
        const raw = html.slice(start, stop);
        // 骨架屏在 __wrap 之前，直接从 __wrap 开始切掉它
        const w = raw.indexOf('class="bili-video-card__wrap"');
        return w === -1 ? raw : raw.slice(w);
      });
    }

    // ---------------------------------------------------------------- 单卡解析

    function pickAttr(seg, cls, attr) {
      // 属性顺序不定，先定位到含该 class 的标签，再在标签内找属性
      const i = seg.indexOf(`class="${cls}"`);
      if (i === -1) return null;
      const open = seg.lastIndexOf('<', i);
      const close = seg.indexOf('>', i);
      if (open === -1 || close === -1) return null;
      const tag = seg.slice(open, close + 1);
      const m = tag.match(new RegExp(`${attr}="([^"]*)"`));
      return m ? decodeEntities(m[1]) : null;
    }

    function pickText(seg, cls) {
      const re = new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)<\\/`, '');
      const m = seg.match(re);
      return m ? stripTags(m[1]) : null;
    }

    function parseCard(seg) {
      // 1) CPM 广告：href 指向 cm.bilibili.com，且没有 BV 链接
      const isAd = /cm\.bilibili\.com/.test(seg) || /class="[^"]*bili-video-card__info--ad/.test(seg);

      // 2) BV 号（唯一稳定 ID）
      const bv = seg.match(/\/video\/(BV[0-9A-Za-z]+)/);
      if (!bv) return null;          // 无 BV = 广告卡 / 纯骨架屏 / 非视频卡 -> 剔除
      if (isAd) return null;
      const id = bv[1];

      // 3) 标题：优先 title 属性（干净），退化到内文剥 <em class="keyword">
      let title = pickAttr(seg, 'bili-video-card__info--tit', 'title');
      if (!title) title = pickText(seg, 'bili-video-card__info--tit');
      title = title ? title.trim() : null;

      // 4) 统计。B站搜索卡固定渲染 2 个 stat（播放、弹幕），且两者 svg 图标在 HTML 里
      //    完全相同（实测 84 个 item 的 svg 指纹一致），没有任何语义锚点可用 ——
      //    只能按位取。所以位置约定必须**显式断言**：一旦 B站在卡片上加/减 stat，
      //    这里要大声失败，而不是静默把新指标当成播放量。
      //    （变异测试实测：不加断言时，注入一个新 stat 会让全部 play 变成该新值，
      //      候选数不变、零报错 —— 存量库会悄悄变脏。）
      const items = [...seg.matchAll(
        /class="bili-video-card__stats--item"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/g
      )].map((m) => stripTags(m[1]));
      if (items.length !== EXPECTED_STATS_PER_CARD) {
        throw new Error(
          `bilibili: 卡片 ${id} 的 stats--item 数量为 ${items.length}，期望 ${EXPECTED_STATS_PER_CARD}。` +
          `B站可能改版了统计项，按位取值已不可信，拒绝产出可能错位的指标。`
        );
      }
      const playText = items[0] ?? null;
      const danmakuText = items[1] ?? null;

      const durationText = pickText(seg, 'bili-video-card__stats__duration');

      // 5) UP 主
      const author = pickText(seg, 'bili-video-card__info--author');
      const ownerHref = pickAttr(seg, 'bili-video-card__info--owner', 'href');
      const midM = ownerHref && ownerHref.match(/space\.bilibili\.com\/(\d+)/);
      const authorId = midM ? midM[1] : null;

      const publishedAt = parsePubDate(pickText(seg, 'bili-video-card__info--date'));

      return {
        id,                                                  // BV 号，永久稳定
        title,
        metrics: {
          play: parseCount(playText),
          play_text: playText,
          danmaku: parseCount(danmakuText),
          danmaku_text: danmakuText,
          duration_sec: parseDuration(durationText),
          duration_text: durationText,
        },
        open_url: `https://www.bilibili.com/video/${id}/`,   // 无 query，无凭证
        author: author || null,
        author_id: authorId,
        published_at: publishedAt,
      };
    }

    // ---------------------------------------------------------------- 入口

    function parse(rawText) {
      const html = String(rawText ?? '');
      const out = [];
      const seen = new Set();
      for (const seg of sliceCards(html)) {
        const item = parseCard(seg);
        if (!item) continue;
        if (seen.has(item.id)) continue;                     // 同一 BV 只留一条
        seen.add(item.id);
        out.push(item);
      }
      return out;
    }


    // CLI: node parse-bilibili.mjs <file.html> [n]

    return { parse };
  })();

  // ---------------------------------------------------------------- zhihu
  marineDiscovery.zhihu = (function () {
    /**
     * 知乎「发现侧」解析器 —— 直评场景
     *
     * 候选 = 一条可直评的内容：answer（回答）或 article（专栏文章）。
     * question（问题）本身不是投放目标，故被丢弃（只作为 answer 的父级用于拼 URL）。
     *
     * 输入 rawText 可以是：
     *   A) /api/v4/search_v3?t=general&q=... 的响应体（推荐，指标最全）
     *      —— 允许被截断（抓包常见），解析器逐条 brace-match，坏的那条走正则兜底。
     *   B) 搜索结果页的 DOM 快照 HTML（兜底，指标只有赞同数/评论数）
     *
     * 只用 node 内置能力，无第三方依赖。
     *
     * 导出：
     *   parse(rawText) -> [{ id, title, metrics, open_url, author, ... }]
     */

    // ---------------------------------------------------------------- utils

    const ENTITIES = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#34': '"',
    };

    function decodeEntities(s) {
      return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, k) => {
        if (k[0] === '#') {
          const code = k[1] === 'x' || k[1] === 'X'
            ? parseInt(k.slice(2), 16)
            : parseInt(k.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
      });
    }

    /** 去掉 <em> 高亮标签等富文本，拿到干净标题。可能要解两遍实体（&amp;lt;）。 */
    function cleanText(s) {
      if (s == null) return '';
      let t = String(s);
      t = decodeEntities(t);          // &amp;quot; -> &quot;
      t = t.replace(/<[^>]*>/g, '');  // 去标签（含 <em>）
      t = decodeEntities(t);          // 再解一层
      return t.replace(/\s+/g, ' ').trim();
    }

    /** "1.2万" / "3千" / "1.2k" / "40" -> Number */
    function parseCount(raw) {
      if (raw == null) return null;
      if (typeof raw === 'number') return raw;
      const s = String(raw).trim().replace(/,/g, '');
      const m = s.match(/^([\d.]+)\s*([万亿千wWkK]?)/);
      if (!m) return null;
      const n = parseFloat(m[1]);
      if (!Number.isFinite(n)) return null;
      switch (m[2]) {
        case '万': case 'w': case 'W': return Math.round(n * 1e4);
        case '亿': return Math.round(n * 1e8);
        case '千': case 'k': case 'K': return Math.round(n * 1e3);
        default: return Math.round(n);
      }
    }

    /** 从 start（必须指向 '{'）开始做字符串感知的括号配对，返回完整对象串；截断则返回 null。 */
    function sliceBalanced(str, start) {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < str.length; i++) {
        const c = str[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return str.slice(start, i + 1); }
      }
      return null; // 被截断
    }

    // ---------------------------------------------------------------- URL 构造

    /**
     * 注意：接口里的 object.url 是 https://api.zhihu.com/answers/<id>，浏览器打不开。
     * 直评要的是 www 站的内容页。
     */
    function buildOpenUrl(type, id, questionId) {
      if (type === 'answer') {
        return questionId
          ? `https://www.zhihu.com/question/${questionId}/answer/${id}`
          : `https://www.zhihu.com/answer/${id}`; // 服务端 302 到带 question 的规范地址
      }
      if (type === 'article') return `https://zhuanlan.zhihu.com/p/${id}`;
      return null;
    }

    const COMMENTABLE = new Set(['answer', 'article']);

    // ---------------------------------------------------------------- API JSON 路径

    function normalizeApiObject(obj, highlight) {
      const type = obj && obj.type;
      if (!COMMENTABLE.has(type)) return null;
      const rawId = obj.id != null ? String(obj.id) : null;
      if (!rawId) return null;

      const questionId = obj.question && obj.question.id != null ? String(obj.question.id) : null;
      const title = cleanText(obj.title || (highlight && highlight.title) || (obj.question && obj.question.name) || '');
      const author = obj.author && (obj.author.name || obj.author.id)
        ? {
            id: obj.author.id || null,
            name: cleanText(obj.author.name || ''),
            url_token: obj.author.url_token || null,
            home_url: obj.author.url_token ? `https://www.zhihu.com/people/${obj.author.url_token}` : null,
          }
        : null;

      return {
        id: `zhihu:${type}:${rawId}`,
        raw_id: rawId,
        type,
        title,
        excerpt: cleanText(obj.excerpt || (highlight && highlight.description) || ''),
        open_url: buildOpenUrl(type, rawId, questionId),
        question_id: questionId,
        author,
        metrics: {
          voteup_count: obj.voteup_count ?? null,
          comment_count: obj.comment_count ?? null,
          // answer 用 favorites_count，article 用 zfav_count
          favorite_count: obj.favorites_count ?? obj.zfav_count ?? null,
          visits_count: obj.visits_count ?? null,        // 只有部分 answer 有
          answer_count: obj.answer_count ?? null,        // answer 才有（同题竞争度）
          created_time: obj.created_time ?? null,
          updated_time: obj.updated_time ?? null,
        },
        _source: 'api-json',
        _partial: false,
      };
    }

    /** 被截断的最后一条：object 里 content 之前的字段还在，用正则捞回来。 */
    function salvageTruncated(chunk) {
      const objAt = chunk.indexOf('"object":{');
      if (objAt < 0) return null;
      const head = chunk.slice(0, objAt);
      const body = chunk.slice(objAt);

      const type = (body.match(/"type"\s*:\s*"(answer|article|question|zvideo|pin)"/) || [])[1];
      if (!COMMENTABLE.has(type)) return null;
      const rawId = (body.match(/"id"\s*:\s*"?(\d+)"?/) || [])[1];
      if (!rawId) return null;

      // highlight 在 object 之前，所以截断的这条标题通常还在
      const hlTitle = (head.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1];
      const objTitle = (body.slice(0, 4000).match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1];
      let title = '';
      try { title = cleanText(JSON.parse(`"${objTitle || hlTitle || ''}"`)); } catch { title = cleanText(objTitle || hlTitle || ''); }

      const num = (k) => {
        const m = body.match(new RegExp(`"${k}"\\s*:\\s*(-?\\d+)`));
        return m ? Number(m[1]) : null;
      };
      const questionId = (body.match(/"question"\s*:\s*\{\s*"id"\s*:\s*"?(\d+)"?/) || [])[1] || null;

      return {
        id: `zhihu:${type}:${rawId}`,
        raw_id: rawId,
        type,
        title,
        excerpt: '',
        open_url: buildOpenUrl(type, rawId, questionId),
        question_id: questionId,
        author: null, // author 排在 content 之后，被截断了 —— 如实为 null，不编造
        metrics: {
          voteup_count: num('voteup_count'),
          comment_count: num('comment_count'),
          favorite_count: num('favorites_count') ?? num('zfav_count'),
          visits_count: num('visits_count'),
          answer_count: null,
          created_time: num('created_time'),
          updated_time: num('updated_time'),
        },
        _source: 'api-json',
        _partial: true, // 该条来自截断兜底，字段可能缺
      };
    }

    function parseSearchV3(rawText) {
      const out = [];
      const starts = [];
      const re = /\{"type":"(?:search_result|search_club|slug)"/g;
      let m;
      while ((m = re.exec(rawText))) starts.push(m.index);

      for (let i = 0; i < starts.length; i++) {
        const at = starts[i];
        const chunk = sliceBalanced(rawText, at);
        if (chunk) {
          let item;
          try { item = JSON.parse(chunk); } catch { item = null; }
          if (item && item.object) {
            const n = normalizeApiObject(item.object, item.highlight);
            if (n) out.push(n);
            continue;
          }
        }
        // 截断（或坏 JSON）：兜底
        const tail = rawText.slice(at, starts[i + 1] ?? rawText.length);
        const s = salvageTruncated(tail);
        if (s) out.push(s);
      }
      return out;
    }

    // ---------------------------------------------------------------- DOM HTML 路径

    function attrOf(html, name) {
      const m = html.match(new RegExp(`${name}="([^"]*)"`));
      return m ? m[1] : null;
    }


    // class 属性是无序的 token 集合，不是字符串。用精确串匹配（如 split 在
    // `class="Card SearchResult-Card"` 上）会因为知乎换个书写顺序、或多加一个
    // class 就整体归零 —— 变异测试实测：仅调换顺序，候选从 17 变 0，且零报错。
    // 下面两个 helper 一律按 token 判定。
    function classTokens(tag) {
      const m = tag.match(/\sclass="([^"]*)"/);
      return m ? m[1].trim().split(/\s+/) : [];
    }

    /** 按「开标签的 class 里含有全部 required token」切分，返回各段起始下标。 */
    function splitByClassTokens(html, required) {
      const need = [].concat(required);
      const out = [];
      const re = /<div\b[^>]*>/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const toks = classTokens(m[0]);
        if (need.every((t) => toks.includes(t))) out.push(m.index);
      }
      return out;
    }

    /** 该片段里是否存在 class 含全部 token 的元素。 */
    function hasClassTokens(html, required) {
      const need = [].concat(required);
      const re = /<[a-z][a-z0-9]*\b[^>]*\sclass="[^"]*"[^>]*>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const toks = classTokens(m[0]);
        if (need.every((t) => toks.includes(t))) return m.index;
      }
      return -1;
    }

    function parseSearchHtml(rawText) {
      const out = [];
      // 每张搜索结果卡片
      const starts = splitByClassTokens(rawText, ['Card', 'SearchResult-Card']);
      const cards = starts.map((p, i) => rawText.slice(p, starts[i + 1] ?? rawText.length));
      for (const card of cards) {
        const answerAt = hasClassTokens(card, ['ContentItem', 'AnswerItem']);
        const articleAt = hasClassTokens(card, ['ContentItem', 'ArticleItem']);
        const isAnswer = answerAt >= 0;
        const isArticle = articleAt >= 0;
        if (!isAnswer && !isArticle) continue; // 相关搜索 / 广告 / 问题卡，跳过

        let type, rawId, questionId = null, openUrl = null;
        if (isAnswer) {
          type = 'answer';
          const item = card.slice(answerAt);
          rawId = attrOf(item.slice(0, 400), 'name');
          const href = (item.match(/href="\/question\/(\d+)\/answer\/(\d+)"/) || []);
          if (href[1]) { questionId = href[1]; rawId = rawId || href[2]; }
          if (!rawId) continue;
          openUrl = buildOpenUrl('answer', rawId, questionId);
        } else {
          type = 'article';
          const href = card.match(/href="(?:https?:)?\/\/zhuanlan\.zhihu\.com\/p\/(\d+)"/);
          if (!href) continue;
          rawId = href[1];
          openUrl = buildOpenUrl('article', rawId, null);
        }

        const titleM = card.match(/<span\s[^>]*class="[^"]*\bHighlight\b[^"]*"[^>]*>([\s\S]*?)<\/span>/)
                     || card.match(/<span class="Highlight">([\s\S]*?)<\/span>/);
        const title = titleM ? cleanText(titleM[1]) : '';

        const voteM = card.match(/aria-label="赞同 ([\d.,]+\s*[万千wWkK]?)\s*"/) || card.match(/>赞同 ([\d.,]+\s*[万千wWkK]?)</);
        const cmtM = card.match(/>([\d.,]+\s*[万千wWkK]?) 条评论</);
        const hasAddComment = card.includes('添加评论');

        // 回答卡的摘要以 "<b data-first-child="">作者名</b>：" 开头
        const authorM = card.match(/<b data-first-child="">([^<]{1,40})<\/b>：/);

        out.push({
          id: `zhihu:${type}:${rawId}`,
          raw_id: rawId,
          type,
          title,
          excerpt: cleanText((card.match(/itemprop="text"[^>]*>([\s\S]{0,400}?)<\/span>/) || [])[1] || ''),
          open_url: openUrl,
          question_id: questionId,
          author: authorM ? { id: null, name: cleanText(authorM[1]), url_token: null, home_url: null } : null,
          metrics: {
            voteup_count: voteM ? parseCount(voteM[1]) : null,
            comment_count: cmtM ? parseCount(cmtM[1]) : (hasAddComment ? 0 : null),
            favorite_count: null,   // DOM 上没有
            visits_count: null,     // DOM 上没有
            answer_count: null,
            created_time: null,     // DOM 上没有
            updated_time: null,
          },
          _source: 'dom',
          _partial: false,
        });
      }
      return out;
    }

    // ---------------------------------------------------------------- 入口

    /** 按 id 去重，优先保留字段更全的那条（api-json > dom，完整 > 截断兜底）。 */
    function dedupe(items) {
      const score = (it) => (it._source === 'api-json' ? 2 : 0) + (it._partial ? 0 : 1);
      const map = new Map();
      for (const it of items) {
        const prev = map.get(it.id);
        if (!prev || score(it) > score(prev)) map.set(it.id, it);
      }
      return [...map.values()];
    }

    function parse(rawText) {
      const s = String(rawText || '');
      const head = s.slice(0, 4096).trimStart();
      const looksJson = head.startsWith('{') || head.startsWith('[') || s.includes('"type":"search_result"');
      const items = looksJson ? parseSearchV3(s) : parseSearchHtml(s);
      return dedupe(items);
    }


    // ---------------------------------------------------------------- CLI 自测

    return { parseSearchV3, parseSearchHtml, dedupe, parse };
  })();

  // ---------------------------------------------------------------- douyin
  marineDiscovery.douyin = (function () {
    /**
     * 抖音「发现侧」候选解析器（只做直评场景：候选 = 一条可直接评论的内容）
     *
     * 输入 rawText 可以是下面任意一种，parse() 自动识别：
     *   1) DOM 快照 HTML —— www.douyin.com/search/<kw> 的 document.documentElement.outerHTML
     *      （注意：抖音搜索结果**不在** SSR 里。RENDER_DATA / RSC flight 里没有任何 aweme_id，
     *        列表是 hydration 之后由 XHR 填的，所以必须抓「渲染后的 DOM」而不是首屏响应体。）
     *   2) /aweme/v1/web/general/search/{stream,single}/ 的 JSON 响应（**可被截断**，容错解析）
     *
     * 输出：[{ id, title, metrics:{...}, open_url, author, ... }]
     *
     * 无第三方依赖，只用 node 内置能力。
     */

    /* ------------------------------------------------------------------ *
     * 通用工具
     * ------------------------------------------------------------------ */

    const HTML_ENTITIES = {
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
      '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
    };

    function decodeEntities(s) {
      return String(s)
        .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m])
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (_, d) => String.fromCodePoint(parseInt(d, 16)));
    }

    /** "2.6万" / "1.6亿" / "9799" -> 26000 / 160000000 / 9799；拿不到就 null */
    function parseCount(raw) {
      if (raw == null) return null;
      const s = String(raw).trim().replace(/[,\s]/g, '');
      if (!s) return null;
      const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(万|w|W|亿|k|K)?$/);
      if (!m) return null;
      const n = parseFloat(m[1]);
      if (!Number.isFinite(n)) return null;
      const unit = m[2];
      if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 1e4);
      if (unit === '亿') return Math.round(n * 1e8);
      if (unit === 'k' || unit === 'K') return Math.round(n * 1e3);
      return Math.round(n);
    }

    /** 19 位左右的纯数字 aweme_id 校验（抖音 item id 目前 19 位，历史内容也有 19 位；放宽到 17-20） */
    function isAwemeId(id) {
      return typeof id === 'string' && /^[0-9]{17,20}$/.test(id);
    }

    /**
     * open_url：不带任何凭证的规范详情页。
     *  - 视频（aweme_type 0 / media_type 4）-> /video/<aweme_id>
     *  - 图文（aweme_type 68 / media_type 2）-> /note/<aweme_id>
     * 两个 route 在抖音 web 路由表里都存在（video_detail / note_detail）。
     */
    function detailUrl(id, kind) {
      return `https://www.douyin.com/${kind === 'note' ? 'note' : 'video'}/${id}`;
    }

    /**
     * 搜索页弹层地址：点开搜索卡片不跳转，只把 URL 换成 ?modal_id=<aweme_id>。
     * 需要原始关键词才能拼；只在能从产物里拿到关键词时给出，作为「留在搜索会话里评论」的备选。
     */
    function modalUrl(id, keyword) {
      if (!keyword) return null;
      return `https://www.douyin.com/search/${encodeURIComponent(keyword)}?modal_id=${id}`;
    }

    function emptyMetrics() {
      return {
        digg_count: null,     // 点赞
        comment_count: null,  // 评论
        share_count: null,    // 分享
        collect_count: null,  // 收藏
        play_count: null,     // 抖音 web 恒为 0，见下方说明，一律不填
      };
    }

    /* ------------------------------------------------------------------ *
     * 分支 A：DOM 快照（完整，20 条/首屏）
     * ------------------------------------------------------------------ */

    /** 从 card 起点做 <div> 配平，切出这张卡的完整 HTML（最后一张卡不会吃到页面剩余部分） */
    function sliceBalancedDiv(html, start) {
      const re = /<(\/?)div\b/gi;
      re.lastIndex = start;
      let depth = 0;
      let m;
      while ((m = re.exec(html))) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) {
          const close = html.indexOf('>', re.lastIndex);
          return html.slice(start, close === -1 ? html.length : close + 1);
        }
      }
      return html.slice(start); // 结构不闭合时兜底
    }

    /** 去掉 svg/script/style，再抽出所有文本节点（保留出现顺序） */
    function textNodes(cardHtml) {
      const cleaned = cardHtml
        .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' SVG ')
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
      const out = [];
      const re = />([^<>]+)</g;
      let m;
      while ((m = re.exec(cleaned))) {
        const t = decodeEntities(m[1]).replace(/ SVG /g, '').trim();
        if (t) out.push(t);
      }
      return out;
    }

    const DURATION_RE = /^\d{1,3}:\d{2}(:\d{2})?$/;
    const COUNT_RE = /^[0-9]+(\.[0-9]+)?\s*(万|亿|w|W|k|K)?$/;
    const DATE_RE = /^·?\s*(\d{4}年)?\d{1,2}月\d{1,2}日$|^·?\s*\d+(天|小时|分钟|秒)前$|^·?\s*(刚刚|昨天|前天)/;
    const TYPE_BADGES = new Set(['图文', '直播', '合集', '广告', '视频', '课程']);
    // 混在瀑布流里、但**不是**可评论内容的卡（它们也占一个 waterfall_item_<假 id>）
    const NON_CONTENT_HEADINGS = new Set(['相关搜索', '大家都在搜', '相关推荐', '相关话题', '猜你想搜']);

    function parseDom(html) {
      // 关键词：优先从 RENDER_DATA 的 pathname 拿（URL-encoded JSON），否则从 <title>/输入框
      let keyword = null;
      const rd = html.match(/<script id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/);
      if (rd) {
        try {
          const app = JSON.parse(decodeURIComponent(rd[1]))?.app;
          const p = app?.pathname && decodeURIComponent(app.pathname);
          if (p && p.startsWith('/search/')) keyword = decodeURIComponent(p.slice('/search/'.length));
        } catch { /* ignore */ }
      }
      if (!keyword) {
        const iv = html.match(/<input[^>]+data-e2e="searchbar-input"[^>]*value="([^"]*)"/);
        if (iv) keyword = decodeEntities(iv[1]);
      }

      // 每张结果卡的锚点：id="waterfall_item_<aweme_id>"（语义 id，不是混淆 class，相对稳定）
      const anchors = [...html.matchAll(/<div[^>]*\sid="waterfall_item_([0-9]+)"/g)];
      const seen = new Set();
      const out = [];

      for (const a of anchors) {
        const id = a[1];
        if (!isAwemeId(id) || seen.has(id)) continue;

        const card = sliceBalancedDiv(html, a.index);
        const texts = textNodes(card);
        if (!texts.length) continue;                          // 占位/未渲染的卡（虚拟列表还没填内容）
        if (NON_CONTENT_HEADINGS.has(texts[0])) continue;     // 「相关搜索」卡：假 id + 无作者，直接丢

        let duration = null, countRaw = null, date = null, author = null, badge = null;
        let title = null;

        for (let i = 0; i < texts.length; i++) {
          const t = texts[i];
          if (!duration && DURATION_RE.test(t)) { duration = t; continue; }
          if (TYPE_BADGES.has(t)) { badge = badge || t; continue; }
          if (!countRaw && COUNT_RE.test(t) && !/^\d{1,3}:\d{2}/.test(t)) { countRaw = t; continue; }
          if (!date && DATE_RE.test(t)) { date = t.replace(/^·\s*/, ''); continue; }
          // 作者：紧跟在 "@" 文本节点后面的那个节点
          if (t === '@' && i + 1 < texts.length) { author = author || texts[i + 1]; continue; }
          if (author === null && texts[i - 1] === '@') continue;
          // 标题/正文：剩下里最长的那个
          if (title === null || t.length > title.length) {
            if (t !== author && t !== '@') title = t;
          }
        }
        // 作者节点可能被当成 title 竞争，兜底剔除
        if (author && title === author) title = null;

        // 「可评论内容」的最低证据：有 @作者，或者同时有时长+数字（视频卡）。
        // 达不到就不是一条能直评的内容（推荐词卡 / 商品卡 / 空壳），丢弃。
        if (!author && !(duration && countRaw)) continue;

        const kind = badge === '图文' ? 'note' : 'video';
        const metrics = emptyMetrics();
        metrics.digg_count = parseCount(countRaw);

        seen.add(id);
        out.push({
          id,
          title: title || '',
          metrics,
          open_url: detailUrl(id, kind),
          author: author || null,
          // ——附加，去重/挑选用——
          source_layer: 'dom',
          kind,                                  // video | note(图文)
          duration: duration || null,            // 图文卡没有时长
          published_text: date || null,          // DOM 只有相对/简写日期，没有精确 timestamp
          published_at: null,
          digg_count_raw: countRaw || null,      // "2.6万" 这种原始文案
          modal_url: modalUrl(id, keyword),      // 搜索页弹层（点开不跳转的那个 URL）
          keyword: keyword || null,
        });
      }
      return out;
    }

    /* ------------------------------------------------------------------ *
     * 分支 B：搜索接口 JSON（可能被截断，逐 item 容错切片）
     * ------------------------------------------------------------------ */

    function jsonUnescape(s) {
      try { return JSON.parse(`"${s.replace(/"/g, '\\"')}"`); }
      catch { return s.replace(/\\n/g, '\n').replace(/\\u0026/g, '&').replace(/\\"/g, '"'); }
    }

    function pickStr(seg, key) {
      const m = seg.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      return m ? jsonUnescape(m[1]) : null;
    }
    function pickNum(seg, key) {
      const m = seg.match(new RegExp(`"${key}"\\s*:\\s*(-?[0-9]+)`));
      return m ? Number(m[1]) : null;
    }

    function parseApiJson(text) {
      // 不 JSON.parse 整体：响应可能在任意位置被截断。按 "aweme_id":"..." 切片，
      // 每片 = 一个 item，最后一片若字段不全就丢掉。
      const marks = [...text.matchAll(/"aweme_id"\s*:\s*"([0-9]{17,20})"/g)];
      const out = [];
      const seen = new Set();

      for (let i = 0; i < marks.length; i++) {
        const id = marks[i][1];
        if (seen.has(id)) continue;
        const start = marks[i].index;
        const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
        const seg = text.slice(start, end);

        const statBlock = seg.match(/"statistics"\s*:\s*\{[^}]*\}/);
        if (!statBlock) continue;               // 被截断，statistics 还没出现 -> 丢弃这条残片
        const st = statBlock[0];

        const metrics = emptyMetrics();
        metrics.digg_count = pickNum(st, 'digg_count');
        metrics.comment_count = pickNum(st, 'comment_count');
        metrics.share_count = pickNum(st, 'share_count');
        metrics.collect_count = pickNum(st, 'collect_count');
        // play_count 抖音 web 恒为 0，是假字段，不往上报

        const awemeType = pickNum(seg, 'aweme_type');
        const mediaType = pickNum(seg, 'media_type');
        const kind = (awemeType === 68 || mediaType === 2) ? 'note' : 'video';

        const desc = pickStr(seg, 'desc');
        const createTime = pickNum(seg, 'create_time');

        // 作者：item 里第一个 nickname/sec_uid（author 块紧跟 desc 之后）
        const authorBlock = seg.slice(0, seg.indexOf('"music"') === -1 ? seg.length : seg.indexOf('"music"'));

        seen.add(id);
        out.push({
          id,
          title: desc || '',
          metrics,
          open_url: detailUrl(id, kind),
          author: pickStr(authorBlock, 'nickname'),
          source_layer: 'api-json',
          kind,
          duration: null,
          published_text: null,
          published_at: createTime ? new Date(createTime * 1000).toISOString() : null,
          digg_count_raw: metrics.digg_count == null ? null : String(metrics.digg_count),
          modal_url: null,                       // 接口响应里没有关键词上下文
          keyword: null,
          author_sec_uid: pickStr(authorBlock, 'sec_uid'),
          truncated_source: true,
        });
      }
      return out;
    }

    /* ------------------------------------------------------------------ *
     * 入口
     * ------------------------------------------------------------------ */

    function parse(rawText) {
      if (!rawText || typeof rawText !== 'string') return [];
      const head = rawText.slice(0, 4096).trimStart();
      if (head.startsWith('{') || head.startsWith('[')) return parseApiJson(rawText);
      return parseDom(rawText);
    }

    /**
     * DOM（条数全但只有点赞）+ 接口 JSON（条数少但四个指标齐）按 aweme_id 合并。
     * DOM 打底，JSON 命中就把 comment/share/collect 和精确时间补上。
     */
    function merge(...lists) {
      const byId = new Map();
      for (const list of lists) {
        for (const it of list || []) {
          const prev = byId.get(it.id);
          if (!prev) { byId.set(it.id, { ...it }); continue; }
          const merged = { ...prev };
          for (const k of Object.keys(it)) {
            if (k === 'metrics') continue;
            if (merged[k] == null || merged[k] === '') merged[k] = it[k];
          }
          merged.metrics = { ...prev.metrics };
          const exact = it.source_layer === 'api-json'; // 接口是精确值，DOM 是「1.6万」这种四舍五入
          for (const k of Object.keys(it.metrics || {})) {
            if (it.metrics[k] == null) continue;
            if (merged.metrics[k] == null || exact) merged.metrics[k] = it.metrics[k];
          }
          if (exact && it.published_at) merged.published_at = it.published_at;
          if (exact && it.title) merged.title = it.title;
          merged.source_layer = [...new Set([prev.source_layer, it.source_layer])].join('+');
          byId.set(it.id, merged);
        }
      }
      return [...byId.values()];
    }


    return { parse, merge, parseCount, detailUrl, modalUrl };
  })();

  // ---------------------------------------------------------------- xiaohongshu
  marineDiscovery.xiaohongshu = (function () {
    /**
     * 小红书 (xiaohongshu.com) 搜索结果页解析器 —— 「发现侧」候选抽取
     *
     * 场景：只做直评（在笔记本身下面发评论），所以「候选」= 一条可评论的笔记。
     *
     * 数据来源（实测 p4-xiaohongshu.html，931KB）：
     *   1) window.__INITIAL_STATE__  —— 存在，但只有 11.9KB 的 global 配置，**没有**任何笔记/feed 数据。
     *      本解析器仍会尝试从中挖 feed（未来页面结构变了可能会有），拿不到就静默退回 DOM。
     *   2) DOM —— 笔记全部在 <section class="note-item" data-note-id="...">，这是实际生效的路径。
     *
     * 只依赖 node 内置能力（纯字符串/正则），不引入任何第三方库。
     *
     * open_url 实测（2026-07-27，curl 无 cookie）：
     *   带正确 token   /explore/<id>?xsec_token=<t>&xsec_source=pc_search  -> 200，正文/标题齐全
     *   DOM 原样链接   /search_result/<id>?xsec_token=<t>&xsec_source=     -> 200，同上
     *   不带 token     /explore/<id>                                      -> 302 /404/sec_xxx
     *                                                                        error_code=300031「当前笔记暂时无法浏览」
     *   token 改 1 个字符                                                  -> 同样 302 300031
     *   => token 是强校验的必需凭证，且是**会过期**的短时凭证：候选存库时 id 可长期复用，
     *      open_url/token 只能当缓存，过期后必须重新搜索该 note_id 拿新 token。
     */

    const ORIGIN = 'https://www.xiaohongshu.com';
    const NOTE_ID_RE = /^[0-9a-f]{24}$/;

    /* ------------------------------------------------------------------ utils */

    function decodeEntities(s) {
      if (!s) return s;
      return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&');
    }

    function stripTags(html) {
      return decodeEntities(String(html).replace(/<[^>]*>/g, '')).trim();
    }

    /** "8319" -> 8319 ; "4.8万" -> 48000 ; "1.2亿" -> 120000000 ; "赞"/"" -> null */
    function parseCount(text) {
      if (text == null) return null;
      const t = String(text).trim();
      if (!t) return null;
      const m = t.match(/^([\d.]+)\s*([万亿wW])?$/);
      if (!m) return null; // 例如未点赞时显示「赞」
      const n = parseFloat(m[1]);
      if (!Number.isFinite(n)) return null;
      const unit = m[2];
      if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 1e4);
      if (unit === '亿') return Math.round(n * 1e8);
      return Math.round(n);
    }

    function attr(chunk, name) {
      const re = new RegExp(`\\s${name}="([^"]*)"`);
      const m = chunk.match(re);
      return m ? decodeEntities(m[1]) : null;
    }

    /* -------------------------------------------------- layer 1: INITIAL_STATE */

    /** 抽出 window.__INITIAL_STATE__ 并尽量 JSON.parse（小红书会往里塞裸 undefined）。 */
    function extractInitialState(raw) {
      const key = 'window.__INITIAL_STATE__=';
      const i = raw.indexOf(key);
      if (i === -1) return null;
      const rest = raw.slice(i + key.length);
      const end = rest.indexOf('</script>');
      let json = end === -1 ? rest : rest.slice(0, end);
      json = json.trim().replace(/;$/, '');
      // 裸 undefined -> null（实测本页有 24 处），只替换值位置，不碰字符串内容里的 "undefined"
      json = json.replace(/([:,[])\s*undefined\s*(?=[,}\]])/g, '$1null');
      try {
        return JSON.parse(json);
      } catch {
        return null;
      }
    }

    /** 在 state 里深搜「像笔记卡」的对象；本页拿不到（state 里只有 global 配置）。 */
    function candidatesFromState(state) {
      if (!state || typeof state !== 'object') return [];
      const out = [];
      const seen = new Set();
      const stack = [state];
      let guard = 0;
      while (stack.length && guard++ < 200000) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) {
          for (const v of node) if (v && typeof v === 'object') stack.push(v);
          continue;
        }
        const card = node.noteCard || node.note_card || null;
        const id = node.id || node.noteId || node.note_id;
        if (card && typeof id === 'string' && NOTE_ID_RE.test(id) && !seen.has(id)) {
          seen.add(id);
          const inter = card.interactInfo || card.interact_info || {};
          const user = card.user || {};
          const token = node.xsecToken || node.xsec_token || card.xsecToken || card.xsec_token || null;
          out.push({
            id,
            title: card.displayTitle || card.display_title || card.title || null,
            metrics: {
              liked_count: parseCount(inter.likedCount ?? inter.liked_count),
              liked_count_text: String(inter.likedCount ?? inter.liked_count ?? '') || null,
            },
            open_url: buildOpenUrl(id, token),
            author: {
              id: user.userId || user.user_id || null,
              name: user.nickname || user.nickName || null,
            },
            note_type: card.type || null,
            xsec_token: token,
            _source: 'initial-state',
          });
        }
        for (const k of Object.keys(node)) {
          const v = node[k];
          if (v && typeof v === 'object') stack.push(v);
        }
      }
      return out;
    }

    /* ------------------------------------------------------------ layer 2: DOM */

    /**
     * open_url：必须带 xsec_token，否则打开是「当前笔记暂时无法浏览」。
     * DOM 里 token 出现在 /search_result/<id>?xsec_token=...&xsec_source=（source 为空）。
     * 我们改写成 /explore/<id>?xsec_token=...&xsec_source=pc_search —— explore 是笔记详情的
     * 规范路径（页面里同时存在裸 /explore/<id> 隐藏链接），pc_search 与页面自身 profile 链接
     * 用的 xsec_source 取值一致。
     */
    function buildOpenUrl(id, token) {
      if (!id) return null;
      if (!token) return `${ORIGIN}/explore/${id}`; // 无 token 大概率打不开，但不编造
      return `${ORIGIN}/explore/${id}?xsec_token=${token}&xsec_source=pc_search`;
    }

    function sliceSections(raw) {
      const out = [];
      let i = raw.indexOf('<section');
      while (i !== -1) {
        const next = raw.indexOf('<section', i + 8);
        const close = raw.indexOf('</section>', i);
        let end;
        if (close === -1) end = next === -1 ? raw.length : next;
        else end = next === -1 || close < next ? close + 10 : next;
        out.push(raw.slice(i, end));
        i = next;
      }
      return out;
    }

    function candidatesFromDom(raw) {
      const out = [];
      const seen = new Set();
      for (const sec of sliceSections(raw)) {
        if (!/class="[^"]*\bnote-item\b/.test(sec)) continue;

        const id = attr(sec, 'data-note-id');
        // 搜索流里混着「大家都在搜」推荐卡，它们的 data-note-id 是 uuid#timestamp，直接排除
        if (!id || !NOTE_ID_RE.test(id)) continue;
        if (seen.has(id)) continue;
        seen.add(id);

        // token：优先取该 section 内 /search_result/<id> 或 /explore/<id> 上的 xsec_token
        let token = null;
        const hrefs = [...sec.matchAll(/href="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
        const noteHref =
          hrefs.find((h) => h.includes(`/search_result/${id}`) && h.includes('xsec_token=')) ||
          hrefs.find((h) => h.includes(`/explore/${id}`) && h.includes('xsec_token=')) ||
          null;
        if (noteHref) {
          const t = noteHref.match(/[?&]xsec_token=([^&"]+)/);
          if (t) token = t[1];
        }

        // 标题：<a class="title"><span>…</span></a>
        let title = null;
        const tm = sec.match(/class="title"[^>]*>([\s\S]*?)<\/a>/);
        if (tm) title = stripTags(tm[1]) || null;

        // 点赞数。原来直接取卡内第一个 class="count"，但小红书 CSS 里已经存在
        // comment-wrapper / collect-wrapper —— 一旦它们被开关打开并排在点赞前面，
        // 首匹配会静默取到评论数或收藏数（变异测试实测：liked 全变成注入值，
        // 候选数仍为 40、零报错）。所以必须先把范围收进 like-wrapper 内部。
        let likedText = null;
        const lw = sec.match(/class="[^"]*\blike-wrapper\b[^"]*"[\s\S]*?<\/span>\s*<\/span>/);
        const scope = lw ? lw[0] : null;
        if (scope) {
          const cm = scope.match(/class="[^"]*\bcount\b[^"]*"[^>]*>([\s\S]*?)<\/span>/);
          if (cm) likedText = stripTags(cm[1]) || null;
        }
        // 没找到 like-wrapper 就如实留空，不再退回“卡内第一个 count”——
        // 那个兜底正是错值的来源，宁可缺失也不要错。

        // 作者
        const authorHref = hrefs.find((h) => h.includes('/user/profile/')) || null;
        const aid = authorHref && authorHref.match(/\/user\/profile\/([0-9a-f]{24})/);
        const nameM = sec.match(/class="name"[^>]*>([\s\S]*?)<\/div>/);
        const timeM = sec.match(/class="time"[^>]*>([\s\S]*?)<\/div>/);

        out.push({
          id,
          title,
          metrics: {
            liked_count: parseCount(likedText),
            liked_count_text: likedText,
          },
          open_url: buildOpenUrl(id, token),
          author: {
            id: aid ? aid[1] : null,
            name: nameM ? stripTags(nameM[1]) || null : null,
            profile_url: authorHref ? (authorHref.startsWith('http') ? authorHref : ORIGIN + authorHref) : null,
          },
          // 只有视频笔记的封面里有 play-icon；图文笔记没有
          note_type: /class="play-icon"/.test(sec) ? 'video' : 'normal',
          publish_time_text: timeM ? stripTags(timeM[1]) || null : null,
          xsec_token: token,
          _source: 'dom',
        });
      }
      return out;
    }

    /* ------------------------------------------------------------------ public */

    /**
     * @param {string} rawText 搜索结果页 HTML 全文
     * @returns {Array<{id:string,title:string|null,metrics:object,open_url:string|null,author:object}>}
     */
    function parse(rawText) {
      const raw = String(rawText);
      const state = extractInitialState(raw);
      const fromState = candidatesFromState(state);
      if (fromState.length) return fromState;
      return candidatesFromDom(raw);
    }


    /* --------------------------------------------------------------- self test */


    return { extractInitialState, parse };
  })();

  // ---------------------------------------------------------------- canary
  marineDiscovery.canary = (function () {
    // 发现侧健康断言。
    //
    // 存在的理由：四个解析器在页面改版 / 抓取残缺时的默认行为都是「静默返回短列表」，
    // 而不是报错。实测过的真实事故形态：
    //   · 小红书 HTML 被截断到 700k → 0 条（笔记从文档 85.6% 才开始出现，是悬崖不是渐进）
    //   · CDP getOuterHTML 超时 → HTML 变 0 字节 → 所有平台 0 条
    //   · 知乎 class 书写顺序变化 → 17 条变 0 条（已用 token 匹配修掉，但同类风险仍在）
    // 这三种在没有断言时，上游看到的都是「今天候选少」而不是「解析器坏了」。
    //
    // 阈值是「明显不对」的下界，不是期望值 —— 目的是抓住塌陷，不是做质量评分。

    const EXPECTED = {
      //           最少条数   必填字段（字段名 -> 最低覆盖率）
      bilibili:    { min: 15, coverage: { title: 0.95, play: 0.95, open_url: 1.0 } },
      zhihu:       { min: 6,  coverage: { title: 0.90, open_url: 1.0 } },
      douyin:      { min: 8,  coverage: { title: 0.90, open_url: 1.0 } },
      // 小红书 token 覆盖率必须近乎 100%：没有 token 的候选是打不开的死候选。
      xiaohongshu: { min: 15, coverage: { open_url: 1.0, xsec_token: 0.98 } },
    };

    const get = (item, field) => {
      if (field in item) return item[field];
      if (item.metrics && field in item.metrics) return item.metrics[field];
      return undefined;
    };

    /**
     * @returns {{ok:boolean, platform:string, count:number, failures:string[], coverage:object}}
     * 只报告，不抛 —— 由调用方决定是中止本轮还是记一条告警。
     */
    function check(platform, items) {
      const spec = EXPECTED[platform];
      if (!spec) throw new Error(`canary: 未知平台 ${platform}`);
      const failures = [];
      const n = items.length;
      if (n < spec.min) failures.push(`条数 ${n} < 下界 ${spec.min}（疑似页面塌陷/抓取残缺）`);

      const coverage = {};
      for (const [field, minRate] of Object.entries(spec.coverage)) {
        const got = items.filter((i) => {
          const v = get(i, field);
          return v !== undefined && v !== null && v !== '';
        }).length;
        const rate = n ? got / n : 0;
        coverage[field] = { got, of: n, rate: +rate.toFixed(3), min: minRate };
        if (n && rate < minRate) failures.push(`${field} 覆盖率 ${(rate * 100).toFixed(1)}% < ${(minRate * 100)}%`);
      }
      return { ok: failures.length === 0, platform, count: n, failures, coverage };
    }

    function assertHealthy(platform, items) {
      const r = check(platform, items);
      if (!r.ok) throw new Error(`canary[${platform}] 不健康：${r.failures.join('；')}`);
      return r;
    }

    return { check, assertHealthy, EXPECTED };
  })();

  // 便捷入口：按平台取解析器。未知平台返回 null 而不是抛错，让调用方决定。
  marineDiscovery.parseFor = function (platform, raw) {
    var m = marineDiscovery[platform];
    if (!m || typeof m.parse !== 'function') return null;
    return m.parse(raw);
  };
})();
