// Site-specific comment target adapters. Detection methods are deliberately
// read-only and fail closed: an ambiguous DOM shape must fall back to the core
// implementation (Bilibili) or produce no target (Zhihu / Xiaohongshu).
(function (root) {
  'use strict';

  const ZHIHU_ANSWER_SELECTOR = '.AnswerItem[data-zop]';
  const ZHIHU_COMMENT_SELECTOR = '.CommentItemV2[data-id],.CommentItem[data-id]';
  const XHS_COMMENT_SELECTOR = '.comment-item[id^="comment-"]';
  const XHS_NOTE_ROOT_SELECTOR = [
    '#noteContainer',
    '.note-container',
    '.note-detail-mask',
    '.note-scroller',
    '.note-detail',
    '.note-item',
    '[data-note-id]',
  ].join(',');
  // `.note-scroller` is only the scroll surface for the note body/comments.
  // Xiaohongshu mounts the shared bottom editor beside that surface, so the
  // nearest XHS_NOTE_ROOT_SELECTOR can legitimately differ for a comment and
  // its editor.  Lifecycle checks must compare a common outer note shell.
  const XHS_NOTE_SHELL_SELECTOR = [
    '#noteContainer',
    '.note-container',
    '.note-detail-mask',
    '.note-detail',
    '.note-item',
    '[data-note-id]',
  ].join(',');
  const zhihuModalBindings = new WeakMap();

  function asElement(value) {
    return value && value.nodeType === 1 ? value : null;
  }

  function safeMatches(value, selector) {
    const element = asElement(value);
    if (!element || typeof element.matches !== 'function') return false;
    try { return element.matches(selector); } catch (error) { return false; }
  }

  function safeClosest(value, selector) {
    const element = asElement(value);
    if (!element) return null;
    try {
      if (typeof element.closest === 'function') return element.closest(selector);
    } catch (error) {}
    for (let current = element, depth = 0; current && depth < 24; depth++) {
      if (safeMatches(current, selector)) return current;
      current = asElement(current.parentElement);
    }
    return null;
  }

  function safeQuery(value, selector) {
    if (!value || typeof value.querySelector !== 'function') return null;
    try { return value.querySelector(selector); } catch (error) { return null; }
  }

  function safeQueryAll(value, selector, max) {
    if (!value || typeof value.querySelectorAll !== 'function') return [];
    try { return Array.from(value.querySelectorAll(selector)).slice(0, max || 400); }
    catch (error) { return []; }
  }

  function safeAttribute(value, name) {
    const element = asElement(value);
    if (!element || typeof element.getAttribute !== 'function') return '';
    try { return String(element.getAttribute(name) || '').trim(); }
    catch (error) { return ''; }
  }

  function normalizeText(value, maxLength) {
    const text = String(value || '').replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return text.slice(0, maxLength || 4000);
  }

  function elementText(value, maxLength) {
    const element = asElement(value);
    if (!element) return '';
    try { return normalizeText(element.textContent, maxLength); }
    catch (error) { return ''; }
  }

  function stableId(value) {
    const id = String(value == null ? '' : value).trim();
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ? id : '';
  }

  function xhsHexId(value) {
    const id = String(value == null ? '' : value).trim();
    return /^[0-9a-f]{16,64}$/i.test(id) ? id.toLowerCase() : '';
  }

  function hostMatches(locationLike, domain) {
    const hostname = String(locationLike && locationLike.hostname || '').toLowerCase();
    return hostname === domain || hostname.endsWith('.' + domain);
  }

  function nearestBoundary(value, isBoundary) {
    for (let current = asElement(value), depth = 0; current && depth < 24; depth++) {
      if (isBoundary(current)) return current;
      current = asElement(current.parentElement);
    }
    return null;
  }

  function ownedElements(boundary, selector, isBoundary, max) {
    return safeQueryAll(boundary, selector, max).filter(function (candidate) {
      return nearestBoundary(candidate, isBoundary) === boundary;
    });
  }

  function firstOwnedText(boundary, selector, isBoundary, maxLength) {
    const candidates = ownedElements(boundary, selector, isBoundary, 120);
    for (const candidate of candidates) {
      const text = elementText(candidate, maxLength);
      if (text) return text;
    }
    return '';
  }

  function editorAttributeLabel(editor) {
    for (let current = asElement(editor), depth = 0; current && depth < 4; depth++) {
      for (const name of ['placeholder', 'aria-label', 'data-placeholder']) {
        const value = normalizeText(safeAttribute(current, name), 160);
        if (value) return value;
      }
      current = asElement(current.parentElement);
    }
    return '';
  }

  function isEditableElement(value) {
    const element = asElement(value);
    if (!element) return false;
    const tag = String(element.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return true;
    if (element.isContentEditable) return true;
    const editable = safeAttribute(element, 'contenteditable');
    return editable === 'true' || editable === 'plaintext-only';
  }

  function replyPrefix(value) {
    const text = normalizeText(value, 220);
    const match = text.match(/^(?:正在)?回复(?:给)?\s*(?:@|「)?\s*(.+?)\s*(?:」|[:：])?\s*$/);
    const author = normalizeText(match && match[1], 80).replace(/[」:：]+$/, '').trim();
    return author && author.length <= 64 ? '回复 @' + author : '';
  }

  // Some Xiaohongshu builds expose the reply target only as text in an
  // ancestor of the shared editor (for example "回复 某人"). Walk that subtree
  // while excluding the editor/contenteditable branch entirely, so target
  // detection never reads or retains the user's draft.
  function textOutsideEditor(scope, editor) {
    const parts = [];
    const state = { nodes: 0, chars: 0, overflow: false };
    const visit = function (node) {
      if (!node || state.overflow || node === editor) return;
      if (++state.nodes > 300) { state.overflow = true; return; }
      if (node.nodeType === 3) {
        const value = String(node.nodeValue || '');
        state.chars += value.length;
        if (state.chars > 1000) { state.overflow = true; return; }
        parts.push(value);
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1) {
        const element = asElement(node);
        if (isEditableElement(element)) return;
        const tag = String(element && element.tagName || '').toLowerCase();
        if (/^(?:script|style|template|noscript)$/.test(tag)) return;
      }
      let children = [];
      try { children = Array.from(node.childNodes || []); } catch (error) {}
      for (const child of children) visit(child);
    };
    visit(scope);
    return state.overflow ? [] : parts.map(function (part) {
      return normalizeText(part, 220);
    }).filter(Boolean);
  }

  function replyLabelFromScope(scope, editor, selectors) {
    if (!scope) return '';
    const candidates = safeQueryAll(scope, selectors, 100).filter(function (candidate) {
      if (candidate === editor || isEditableElement(candidate)) return false;
      try {
        if (candidate.contains && candidate.contains(editor)) return false;
        if (editor && editor.contains && editor.contains(candidate)) return false;
      } catch (error) {}
      return true;
    }).map(function (candidate) {
      return elementText(candidate, 220);
    }).filter(Boolean).sort(function (a, b) { return a.length - b.length; });
    for (const text of candidates) {
      const label = replyPrefix(text);
      if (label) return label;
    }
    const textChunks = textOutsideEditor(scope, editor)
      .sort(function (a, b) { return a.length - b.length; });
    for (const text of textChunks) {
      const label = replyPrefix(text);
      if (label) return label;
    }
    return '';
  }

  function scopeElementIsLive(scope, documentLike) {
    const element = asElement(scope && scope.element);
    if (!element || !element.isConnected) return false;
    if (!documentLike || typeof documentLike.contains !== 'function') return true;
    try { return documentLike.contains(element); } catch (error) { return false; }
  }

  function elementIsExplicitlyHidden(value, boundary) {
    const stop = asElement(boundary);
    for (let current = asElement(value), depth = 0; current && depth < 32; depth++) {
      if (current.hidden || safeAttribute(current, 'aria-hidden') === 'true') return true;
      const inlineStyle = safeAttribute(current, 'style').toLowerCase();
      if (/(?:^|;)\s*display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/.test(inlineStyle) ||
          /(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)(?:\s*!important)?\s*(?:;|$)/.test(inlineStyle)) {
        return true;
      }
      if (typeof root.getComputedStyle === 'function') {
        try {
          const style = root.getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
            return true;
          }
        } catch (error) {}
      }
      if (current === stop) break;
      current = asElement(current.parentElement);
    }
    return false;
  }

  function rememberedScope(scope, kind, documentLike) {
    if (!scope || scope.kind !== kind || !stableId(scope.id)) return null;
    if (!scopeElementIsLive(scope, documentLike)) return null;
    return scope;
  }

  function freezeTheme(accent, soft, ring, siteLabel) {
    return Object.freeze({
      accent,
      soft,
      ring,
      badge: accent,
      directLabel: siteLabel ? 'Marine · ' + siteLabel + '直评' : 'Marine · 直评',
      replyLabel: siteLabel ? 'Marine · ' + siteLabel + '回复' : 'Marine · 回复',
    });
  }

  const bilibili = Object.freeze({
    supportsPage: function (locationLike) {
      return hostMatches(locationLike, 'bilibili.com') && /(?:^|\/)video(?:\/|$)/.test(
        String(locationLike && locationLike.pathname || ''),
      );
    },
    commentSearchRoot: function () { return null; },
    isCommentBoundary: function () { return false; },
    commentId: function () { return ''; },
    domIdentity: function () { return null; },
    isReplyThread: function () { return false; },
    isCommentEditor: function () { return false; },
    editorContextLabel: function () { return ''; },
    directScopeFromEventPath: function () { return null; },
    directScopeForEditor: function () { return null; },
    theme: freezeTheme('#00aeec', 'rgba(0, 174, 236, .055)', 'rgba(0, 174, 236, .18)'),
  });

  function isZhihuCommentBoundary(value) {
    const element = asElement(value);
    if (!element || !stableId(safeAttribute(element, 'data-id'))) return false;
    if (safeMatches(element, ZHIHU_COMMENT_SELECTOR)) return true;
    if (!safeClosest(element, '.Modal-content')) return false;
    return safeQueryAll(element, 'button', 80).some(function (button) {
      return elementText(button, 24) === '回复' && safeClosest(button, '[data-id]') === element;
    });
  }

  function zhihuAnswerScope(value) {
    const element = safeMatches(value, ZHIHU_ANSWER_SELECTOR)
      ? asElement(value)
      : safeClosest(value, ZHIHU_ANSWER_SELECTOR);
    if (!element) return null;
    const encoded = safeAttribute(element, 'data-zop');
    if (!encoded || encoded.length > 8192) return null;
    let data;
    try { data = JSON.parse(encoded); } catch (error) { return null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.type && String(data.type).toLowerCase() !== 'answer') return null;
    const id = stableId(data.itemId);
    if (!id) return null;
    return {
      id,
      kind: 'answer',
      title: normalizeText(data.title, 300),
      authorName: normalizeText(data.authorName, 120),
      element,
    };
  }

  function zhihuScopeFromPath(path) {
    const values = Array.isArray(path) ? path : [];
    const control = values.find(function (value) {
      if (!safeMatches(value, 'button,[role="button"]')) return false;
      const text = elementText(value, 40);
      return text.length <= 40 && (/评论/.test(text) || text === '添加回答');
    });
    if (!control) return null;
    for (const value of values) {
      const scope = zhihuAnswerScope(value);
      if (scope && safeClosest(control, ZHIHU_ANSWER_SELECTOR) === scope.element) {
        scope.selectedAt = Date.now();
        return scope;
      }
    }
    return null;
  }

  function isZhihuCommentEditor(editor) {
    if (!safeMatches(editor, '.public-DraftEditor-content[role="textbox"]')) return false;
    if (!isEditableElement(editor)) return false;
    if (safeClosest(editor, '.CommentEditorV2,.CommentBox,.Comments-container,.CommentListV2')) {
      return true;
    }
    const modal = safeClosest(editor, '.Modal-content');
    if (!modal) return false;
    return safeQueryAll(modal, 'button', 160).some(function (button) {
      return elementText(button, 24) === '发布';
    });
  }

  function uniqueZhihuScope(documentLike) {
    const scopes = [];
    const seen = new Set();
    for (const element of safeQueryAll(documentLike, ZHIHU_ANSWER_SELECTOR, 500)) {
      const scope = zhihuAnswerScope(element);
      if (!scope || seen.has(scope.id)) continue;
      seen.add(scope.id);
      scopes.push(scope);
    }
    return scopes.length === 1 ? scopes[0] : null;
  }

  function zhihuEditableAncestorWithin(value, boundary) {
    const editable = safeClosest(value,
      '.public-DraftEditor-content,[contenteditable="true"],[contenteditable="plaintext-only"]');
    if (!editable) return null;
    try { return boundary.contains(editable) ? editable : null; }
    catch (error) { return null; }
  }

  function bindZhihuScope(scope, editor) {
    if (!scope) return null;
    const modal = safeClosest(editor, '.Modal-content');
    scope.boundEditor = editor;
    scope.boundModal = modal;
    if (!modal || scope.modalObserver || typeof root.MutationObserver !== 'function') return scope;

    const previousBinding = zhihuModalBindings.get(modal);
    if (previousBinding && previousBinding.scope !== scope) {
      previousBinding.scope.invalidated = true;
      try { previousBinding.observer.disconnect(); } catch (error) {}
    }
    const wrapper = safeClosest(modal, '.Modal-wrapper,.Modal') || modal.parentElement || modal;
    const parent = wrapper && wrapper.parentNode;
    const observer = new root.MutationObserver(function () {
      let hidden = !modal.isConnected;
      for (const element of [wrapper, modal]) {
        if (!element || hidden) continue;
        hidden = !!element.hidden || safeAttribute(element, 'aria-hidden') === 'true';
        if (!hidden && typeof root.getComputedStyle === 'function') {
          try {
            const style = root.getComputedStyle(element);
            hidden = style.display === 'none' || style.visibility === 'hidden';
          } catch (error) {}
        }
      }
      if (!hidden) return;
      scope.invalidated = true;
      try { observer.disconnect(); } catch (error) {}
      if (zhihuModalBindings.get(modal) && zhihuModalBindings.get(modal).scope === scope) {
        zhihuModalBindings.delete(modal);
      }
    });
    try {
      observer.observe(wrapper, {
        attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'class', 'style'],
      });
      if (parent) observer.observe(parent, { childList: true });
      scope.modalObserver = observer;
      zhihuModalBindings.set(modal, { scope, observer });
    } catch (error) {
      try { observer.disconnect(); } catch (ignore) {}
    }
    return scope;
  }

  function zhihuShouldClearScope(path) {
    const values = Array.isArray(path) ? path : [];
    const modal = values.find(function (value) { return safeMatches(value, '.Modal-content'); });
    const control = values.find(function (value) {
      if (!safeMatches(value, 'button,[role="button"],a')) return false;
      const label = normalizeText([
        safeAttribute(value, 'aria-label'),
        safeAttribute(value, 'title'),
        elementText(value, 40),
      ].join(' '), 100);
      const cls = safeAttribute(value, 'class');
      return /(?:关闭|close)/i.test(label) || /(?:^|[-_\s])(?:modal-?)?close(?:[-_\s]|$)/i.test(cls);
    });
    if (control) return true;
    const wrapper = values.find(function (value) { return safeMatches(value, '.Modal-wrapper'); });
    return !!(wrapper && !modal && values[0] === wrapper);
  }

  const zhihu = Object.freeze({
    supportsPage: function (locationLike) {
      return hostMatches(locationLike, 'zhihu.com');
    },

    commentSearchRoot: function (documentLike) {
      const modal = safeQuery(documentLike, '.Modal-content');
      if (modal && safeQuery(modal, '.public-DraftEditor-content[role="textbox"]') &&
          safeQuery(modal, '[data-id]')) return modal;
      return safeQuery(documentLike,
        '.Modal-content .Comments-container,.Modal-content .CommentListV2,' +
        '.Comments-container,.CommentListV2') || null;
    },

    isCommentBoundary: isZhihuCommentBoundary,

    commentId: function (element) {
      return isZhihuCommentBoundary(element)
        ? stableId(safeAttribute(element, 'data-id'))
        : '';
    },

    domIdentity: function (commentElement) {
      if (!isZhihuCommentBoundary(commentElement)) return null;
      const authorElement = ownedElements(
        commentElement, 'a[href*="/people/"]', isZhihuCommentBoundary, 120,
      ).find(function (element) {
        return !zhihuEditableAncestorWithin(element, commentElement);
      });
      const authorName = elementText(authorElement, 120);
      // The 2026 modal mounts a reply DraftJS editor inside the same data-id
      // floor. Only the first owned, non-editor paragraph is the comment body;
      // never inspect paragraphs in contenteditable descendants.
      const bodyElement = ownedElements(commentElement, 'p', isZhihuCommentBoundary, 120)
        .find(function (element) {
          return !zhihuEditableAncestorWithin(element, commentElement);
        });
      const text = elementText(bodyElement, 4000);
      return {
        authorName,
        text,
        wholeText: normalizeText([authorName, text].filter(Boolean).join(' '), 4200),
        confidentText: !!text,
      };
    },

    isReplyThread: function (element) {
      return safeMatches(element,
        '.NestComment,.CommentItemV2--rootComment,.CommentItem--rootComment');
    },

    isCommentEditor: function (editor) {
      return isZhihuCommentEditor(editor);
    },

    editorContextLabel: function (editor) {
      if (!safeMatches(editor, '.public-DraftEditor-content[role="textbox"]')) return '';
      const attributed = editorAttributeLabel(editor);
      if (/^(?:正在)?回复(?:给)?\s*/.test(attributed)) return attributed;
      const owner = safeClosest(editor, '.CommentEditorV2,.CommentBox');
      const local = replyLabelFromScope(
        owner,
        editor,
        '.public-DraftEditorPlaceholder-root,.CommentEditorV2-placeholder,' +
          '.CommentBox-placeholder,[class*="ReplyTo"],[class*="replyTo"]',
      );
      if (local) return local;
      const modal = safeClosest(editor, '.Modal-content');
      const modalEditors = safeQueryAll(
        modal, '.public-DraftEditor-content[role="textbox"]', 40,
      ).filter(isEditableElement);
      // Never borrow a reply label from another DraftJS box in the same
      // portal. Modal-level fallback is safe only while this is its sole
      // editor; normal direct/reply boxes must resolve from their own owner.
      if (!modal || modalEditors.length !== 1 || modalEditors[0] !== editor) return attributed;
      const modalLabel = replyLabelFromScope(
        modal,
        editor,
        '.Modal-title,.Modal-subtitle,[class*="ReplyModal"] [class*="title"]',
      );
      return modalLabel || attributed;
    },

    directScopeFromEventPath: zhihuScopeFromPath,

    shouldClearDirectScopeFromEventPath: zhihuShouldClearScope,

    directScopeForEditor: function (editor, previousScope, locationLike, documentLike) {
      if (!isZhihuCommentEditor(editor)) return null;
      const owned = zhihuAnswerScope(editor);
      if (owned) return bindZhihuScope(owned, editor);

      const previous = rememberedScope(previousScope, 'answer', documentLike);
      if (previous && !previous.invalidated) {
        const live = zhihuAnswerScope(previous.element);
        const modal = safeClosest(editor, '.Modal-content');
        const sameModal = !!modal && previous.boundModal === modal && modal.isConnected;
        const freshSelection = !previous.boundModal && Number(previous.selectedAt) > 0 &&
          Date.now() - Number(previous.selectedAt) <= 15_000;
        if (live && live.id === previous.id && (sameModal || freshSelection)) {
          previous.title = live.title;
          previous.authorName = live.authorName;
          return bindZhihuScope(previous, editor);
        }
      }

      // A portal modal has no structural link back to its AnswerItem. Without
      // an explicit recent click, only a document containing one answer is
      // unambiguous; a route answer id alone is not enough when more answers
      // are rendered on the same page.
      return bindZhihuScope(uniqueZhihuScope(documentLike), editor);
    },

    theme: freezeTheme('#1772f6', 'rgba(23, 114, 246, .055)', 'rgba(23, 114, 246, .18)', '知乎'),
  });

  function isXhsCommentBoundary(value) {
    const element = asElement(value);
    if (!element || !safeMatches(element, XHS_COMMENT_SELECTOR)) return false;
    const id = safeAttribute(element, 'id').match(/^comment-([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
    return !!(id && stableId(id[1]));
  }

  function xhsCommentId(element) {
    if (!isXhsCommentBoundary(element)) return '';
    const match = safeAttribute(element, 'id').match(/^comment-(.+)$/);
    return match ? stableId(match[1]) : '';
  }

  function xhsIdFromLocation(locationLike) {
    const pathname = String(locationLike && locationLike.pathname || '');
    const match = pathname.match(/\/explore\/([0-9a-f]{16,64})(?:\/|$)/i);
    return match ? xhsHexId(match[1]) : '';
  }

  function xhsIdFromElement(value) {
    const element = asElement(value);
    if (!element) return '';
    for (const name of ['data-note-id', 'data-id']) {
      const id = xhsHexId(safeAttribute(element, name));
      if (id) return id;
    }
    const ids = new Set();
    for (const anchor of safeQueryAll(element, 'a[href*="/explore/"]', 80)) {
      const href = safeAttribute(anchor, 'href');
      const match = href.match(/\/explore\/([0-9a-f]{16,64})(?:[/?#]|$)/i);
      const id = match ? xhsHexId(match[1]) : '';
      if (id) ids.add(id);
    }
    return ids.size === 1 ? ids.values().next().value : '';
  }

  function explicitXhsId(value) {
    const element = asElement(value);
    if (!element) return '';
    for (const name of ['data-note-id', 'data-id']) {
      const id = xhsHexId(safeAttribute(element, name));
      if (id) return id;
    }
    return '';
  }

  function xhsNoteRoot(value) {
    return safeClosest(value, XHS_NOTE_ROOT_SELECTOR);
  }

  function xhsNoteShellAncestors(value) {
    const shells = [];
    for (let current = asElement(value), depth = 0; current && depth < 40; depth++) {
      if (safeMatches(current, XHS_NOTE_SHELL_SELECTOR)) shells.push(current);
      current = asElement(current.parentElement);
    }
    return shells;
  }

  function xhsSharedNoteShell(left, right, locationLike, documentLike) {
    const leftRoot = xhsNoteRoot(left);
    const rightRoot = xhsNoteRoot(right);
    // Preserve layouts where the shared editor really is mounted inside the
    // same nearest note/scroller root as the selected comment.
    if (leftRoot && leftRoot === rightRoot && xhsScope(leftRoot, locationLike, documentLike)) {
      return leftRoot;
    }
    const rightShells = new Set(xhsNoteShellAncestors(right));
    for (const candidate of xhsNoteShellAncestors(left)) {
      if (!rightShells.has(candidate)) continue;
      // A common generic wrapper is not enough on feed/search pages. Require
      // the shell to resolve to one concrete note before retaining a reply.
      if (xhsScope(candidate, locationLike, documentLike)) return candidate;
    }
    return null;
  }

  function cleanedDocumentTitle(documentLike) {
    const raw = normalizeText(documentLike && documentLike.title, 300);
    return normalizeText(raw.replace(/\s*[-_|]\s*小红书(?:网页版)?\s*$/i, ''), 300);
  }

  function xhsNoteTitle(element, documentLike) {
    const attributed = normalizeText(safeAttribute(element, 'data-note-title'), 300);
    if (attributed) return attributed;
    const title = safeQuery(element,
      '.note-content .title,.note-content .note-title,#detail-title,.note-title');
    return elementText(title, 300) || cleanedDocumentTitle(documentLike);
  }

  function xhsNoteAuthor(element) {
    const attributed = normalizeText(safeAttribute(element, 'data-note-author'), 120);
    if (attributed) return attributed;
    return elementText(safeQuery(element,
      '.author-wrapper .username,.author-container .username,' +
      '.author-container .name,.note-author .name'), 120);
  }

  function xhsScope(element, locationLike, documentLike) {
    const noteRoot = asElement(element);
    if (!noteRoot) return null;
    const locationId = xhsIdFromLocation(locationLike);
    // On an opened detail page the URL is authoritative. Descendant explore
    // links can point to recommendations and must not be mistaken for the
    // currently opened note.
    const elementId = locationId ? explicitXhsId(noteRoot) : xhsIdFromElement(noteRoot);
    if (locationId && elementId && locationId !== elementId) return null;
    const id = locationId || elementId;
    if (!id) return null;
    return {
      id,
      kind: 'note',
      title: xhsNoteTitle(noteRoot, documentLike),
      authorName: xhsNoteAuthor(noteRoot),
      element: noteRoot,
    };
  }

  function xhsScopeFromPath(path) {
    const values = Array.isArray(path) ? path : [];
    const directControl = values.find(function (value) {
      return safeAttribute(value, 'id') === 'content-textarea' ||
        safeMatches(value, '.engage-bar-container,.engage-bar-container .input-box');
    });
    if (!directControl) return null;
    const locationLike = root.location || null;
    for (const value of values) {
      const noteRoot = xhsNoteRoot(value);
      if (!noteRoot) continue;
      const documentLike = noteRoot.ownerDocument || root.document || null;
      const scope = xhsScope(noteRoot, locationLike, documentLike);
      if (scope) return scope;
    }
    return null;
  }

  function isXhsCommentEditor(editor) {
    if (!asElement(editor) || safeAttribute(editor, 'id') !== 'content-textarea') return false;
    if (!isEditableElement(editor)) return false;
    return !!safeClosest(editor, '.engage-bar-container');
  }

  function xhsEditorContextLabel(editor) {
    if (!asElement(editor) || safeAttribute(editor, 'id') !== 'content-textarea') return '';
    const attributed = editorAttributeLabel(editor);
    if (/^(?:正在)?回复(?:给)?\s*/.test(attributed)) return attributed;
    const bar = safeClosest(editor, '.engage-bar-container');
    const label = replyLabelFromScope(
      bar,
      editor,
      '.reply-tag,.reply-to,.reply-target,.input-box .placeholder,' +
        '.content-edit .placeholder,[class*="reply"]',
    );
    return label || attributed;
  }

  function xhsReplyAuthor(label) {
    const match = normalizeText(label, 240).match(/^(?:正在)?回复(?:给)?\s*@?\s*(.+?)(?:\s*[:：]\s*)?$/);
    return match ? normalizeText(match[1], 120) : '';
  }

  function xhsPersistentReplyIsOpen(info) {
    if (!info || info.mode !== 'reply' || !isXhsCommentEditor(info.editor)) return false;
    const commentElement = asElement(info.commentEl);
    const target = info.target || {};
    if (!commentElement || !commentElement.isConnected || !info.editor.isConnected) return false;
    const documentLike = info.editor.ownerDocument || commentElement.ownerDocument || root.document || null;
    const noteShell = xhsSharedNoteShell(
      commentElement,
      info.editor,
      root.location || null,
      documentLike,
    );
    if (!noteShell) return false;
    if (elementIsExplicitlyHidden(info.editor, noteShell) ||
        elementIsExplicitlyHidden(commentElement, noteShell)) return false;
    if (!String(target.id || '').trim() || xhsCommentId(commentElement) !== String(target.id).trim()) {
      return false;
    }
    const labelAuthor = xhsReplyAuthor(xhsEditorContextLabel(info.editor));
    const targetAuthor = normalizeText(target.authorName, 120);
    return !!labelAuthor && !!targetAuthor && labelAuthor === targetAuthor;
  }

  function xhsExplicitCancelFromPath(path, info) {
    const values = Array.isArray(path) ? path : [];
    const control = values.find(function (value) {
      return safeMatches(value, 'button,[role="button"]') &&
        /^(?:取消|cancel)$/i.test(elementText(value, 40));
    });
    if (!control || !xhsPersistentReplyIsOpen(info)) return false;
    const controlRoot = values.find(function (value) {
      return safeMatches(value, XHS_NOTE_ROOT_SELECTOR);
    }) || xhsNoteRoot(control);
    const editorRoot = xhsNoteRoot(info.editor);
    return !!(controlRoot && editorRoot && controlRoot === editorRoot);
  }

  const xiaohongshu = Object.freeze({
    supportsPage: function (locationLike) {
      // Search/profile/feed entry pages open note details via SPA, so register
      // on the whole first-party host and let the editor predicate narrow it.
      return hostMatches(locationLike, 'xiaohongshu.com');
    },

    commentSearchRoot: function (documentLike) {
      return safeQuery(documentLike,
        '.note-scroller .comments-el,.note-scroller .comments-container,' +
        '.note-detail-mask .comments-el,.note-detail-mask .comments-container,' +
        '.note-scroller') || null;
    },

    isCommentBoundary: isXhsCommentBoundary,
    commentId: xhsCommentId,

    domIdentity: function (commentElement) {
      if (!isXhsCommentBoundary(commentElement)) return null;
      const authorName = firstOwnedText(
        commentElement,
        '.name',
        isXhsCommentBoundary,
        120,
      );
      const text = firstOwnedText(
        commentElement,
        '.note-text',
        isXhsCommentBoundary,
        4000,
      );
      return {
        authorName,
        text,
        wholeText: normalizeText([authorName, text].filter(Boolean).join(' '), 4200),
        confidentText: !!text,
      };
    },

    isReplyThread: function (element) {
      return safeMatches(element, '.parent-comment,.reply-container,.comment-thread');
    },

    isCommentEditor: function (editor) {
      return isXhsCommentEditor(editor);
    },

    editorContextLabel: function (editor) {
      return xhsEditorContextLabel(editor);
    },

    directScopeFromEventPath: xhsScopeFromPath,

    shouldClearTargetFromEventPath: xhsExplicitCancelFromPath,

    persistentTargetIsOpen: function (info) {
      return xhsPersistentReplyIsOpen(info);
    },

    directScopeForEditor: function (editor, previousScope, locationLike, documentLike) {
      if (!isXhsCommentEditor(editor)) return null;
      const noteRoot = xhsNoteRoot(editor) || safeClosest(editor, '.engage-bar-container');
      const current = xhsScope(noteRoot, locationLike, documentLike);
      if (current) {
        const previous = rememberedScope(previousScope, 'note', documentLike);
        if (previous && previous.id === current.id) {
          return {
            id: current.id,
            kind: 'note',
            title: current.title || normalizeText(previous.title, 300),
            authorName: current.authorName || normalizeText(previous.authorName, 120),
            element: current.element,
          };
        }
        return current;
      }

      const previous = rememberedScope(previousScope, 'note', documentLike);
      const locationId = xhsIdFromLocation(locationLike);
      if (!previous || !xhsHexId(previous.id) || (locationId && previous.id !== locationId)) return null;
      return previous;
    },

    theme: freezeTheme('#ff2442', 'rgba(255, 36, 66, .055)', 'rgba(255, 36, 66, .18)', '小红书'),
  });

  const adapters = {
    bilibili,
    zhihu,
    xiaohongshu,
    get: function (platform) {
      const key = String(platform || '').toLowerCase();
      if (key === 'bilibili') return bilibili;
      if (key === 'zhihu') return zhihu;
      if (key === 'xiaohongshu') return xiaohongshu;
      return null;
    },
  };

  root.MarineCommentTargetAdapters = Object.freeze(adapters);
})(globalThis);
