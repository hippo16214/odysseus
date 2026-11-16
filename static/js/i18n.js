/*
 * Odysseus i18n runtime (classic script, loaded before every module).
 *
 * Design goals
 *  - Keep the diff against upstream tiny: English source strings stay in the code
 *    and are used as the lookup key (gettext style). Missing keys fall back to English.
 *  - Translate static HTML and dynamically generated DOM automatically
 *    (text nodes + placeholder/title/aria-label/alt/value attributes).
 *  - Expose window.t(key, vars) for strings that never reach the DOM
 *    (toasts, alert/confirm/prompt, document.title, data passed to libraries).
 *
 * Locale file: /static/locales/<lang>.json
 *   { "Exact English text": "Texto en español",
 *     "Deleted {n} items":  "Se eliminaron {n} elementos" }   // {placeholders} are supported
 */
(function () {
  'use strict';

  var DEFAULT_LANG = 'es';
  var SUPPORTED = ['en', 'es'];
  var STORAGE_KEY = 'odysseus.lang';
  var LOCALE_VERSION = '1';

  function detectLang() {
    var lang = null;
    try { lang = localStorage.getItem(STORAGE_KEY); } catch (e) { /* storage blocked */ }
    if (lang && SUPPORTED.indexOf(lang) !== -1) return lang;
    return DEFAULT_LANG;
  }

  var lang = detectLang();
  var exact = Object.create(null);   // "English" -> "Español"
  var patterns = [];                 // [{re, anchor, names, target}]
  var loaded = false;

  // ---------------------------------------------------------------- loading
  function compileEntries(dict) {
    Object.keys(dict).forEach(function (key) {
      var value = dict[key];
      if (typeof value !== 'string' || !value) return;
      if (key.indexOf('{') === -1) {
        exact[key] = value;
        return;
      }
      var names = [];
      var anchor = '';
      var src = '';
      var re = /\{(\w+)\}/g;
      var last = 0;
      var m;
      while ((m = re.exec(key)) !== null) {
        var literal = key.slice(last, m.index);
        if (literal.length > anchor.length) anchor = literal;
        src += escapeRe(literal) + '([\\s\\S]+?)';
        names.push(m[1]);
        last = m.index + m[0].length;
      }
      var tail = key.slice(last);
      if (tail.length > anchor.length) anchor = tail;
      src += escapeRe(tail);
      if (!names.length) { exact[key] = value; return; }
      patterns.push({ re: new RegExp('^' + src + '$'), anchor: anchor, names: names, target: value });
    });
    // Longest anchors first: most specific pattern wins.
    patterns.sort(function (a, b) { return b.anchor.length - a.anchor.length; });
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function loadLocale() {
    if (lang === 'en') { loaded = true; return; }
    try {
      var xhr = new XMLHttpRequest();
      // Synchronous on purpose: avoids a flash of untranslated UI. File is small and cached.
      xhr.open('GET', '/static/locales/' + lang + '.json?v=' + LOCALE_VERSION, false);
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        compileEntries(JSON.parse(xhr.responseText));
      }
    } catch (e) {
      if (window.console) console.warn('[i18n] could not load locale', lang, e);
    }
    loaded = true;
  }

  // ---------------------------------------------------------------- lookup
  function interpolate(str, vars) {
    if (!vars) return str;
    return str.replace(/\{(\w+)\}/g, function (all, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all;
    });
  }

  /** Translate a string; returns the input unchanged when no translation exists. */
  function translate(text) {
    if (lang === 'en' || !text) return text;
    var hit = exact[text];
    if (hit !== undefined) return hit;
    if (text.length > 240 || !patterns.length) return text;
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      if (text.indexOf(p.anchor) === -1) continue;
      var m = p.re.exec(text);
      if (!m) continue;
      var vars = {};
      for (var j = 0; j < p.names.length; j++) vars[p.names[j]] = m[j + 1];
      return interpolate(p.target, vars);
    }
    return text;
  }

  /** Public t(): t('Delete {n} items', {n: 3}). Falls back to the English key. */
  function t(key, vars) {
    if (typeof key !== 'string') return key;
    if (lang !== 'en') {
      var hit = exact[key];
      if (hit === undefined) {
        // key may itself be a pattern ("{n}" placeholders) -> direct lookup in raw form
        hit = rawPatternTarget(key);
      }
      if (hit !== undefined) return interpolate(hit, vars);
    }
    return interpolate(key, vars);
  }

  var rawIndex = null;
  function rawPatternTarget(key) {
    if (key.indexOf('{') === -1) return undefined;
    if (!rawIndex) {
      rawIndex = Object.create(null);
      patterns.forEach(function (p) {
        // rebuild the raw key from the pattern source is lossy; store by names+anchor instead
        rawIndex[p.names.join(',') + '|' + p.anchor] = p.target;
      });
    }
    // Compute the same signature for the requested key.
    var names = [], anchor = '', last = 0, re = /\{(\w+)\}/g, m;
    while ((m = re.exec(key)) !== null) {
      var lit = key.slice(last, m.index);
      if (lit.length > anchor.length) anchor = lit;
      names.push(m[1]);
      last = m.index + m[0].length;
    }
    var tail = key.slice(last);
    if (tail.length > anchor.length) anchor = tail;
    return rawIndex[names.join(',') + '|' + anchor];
  }

  // ---------------------------------------------------------------- DOM translation
  var TEXT_SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, SVG: 1, TEMPLATE: 1 };
  // Areas that hold user / model generated content: never translate those.
  var SKIP_SELECTOR = [
    '[data-no-i18n]', '[contenteditable="true"]', '[contenteditable=""]',
    '.message-content', '.msg-content', '.markdown-body', '.chat-message-body',
    '.cm-editor', '.ProseMirror', '.ql-editor', '.katex', '.hljs', '.mermaid'
  ].join(',');
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip', 'data-title', 'data-placeholder'];
  var originals = new WeakMap(); // node|element -> { text | attrName: english }

  function inSkippedArea(el) {
    return !!(el && el.closest && el.closest(SKIP_SELECTOR));
  }

  function translateTextNode(node) {
    var raw = node.nodeValue;
    if (!raw) return;
    var trimmed = raw.trim();
    if (!trimmed || trimmed.length > 300) return;
    var rec = originals.get(node);
    var source = trimmed;
    if (rec && rec.translated === trimmed) source = rec.source; // our own output: retranslate from source
    var out = translate(source);
    if (out === source && !(rec && rec.translated === trimmed)) return; // nothing to do
    var parent = node.parentNode;
    if (!parent || TEXT_SKIP_TAGS[parent.nodeName.toUpperCase()] || inSkippedArea(parent)) return;
    var lead = raw.slice(0, raw.indexOf(trimmed));
    var trail = raw.slice(raw.indexOf(trimmed) + trimmed.length);
    originals.set(node, { source: source, translated: out });
    if (raw !== lead + out + trail) node.nodeValue = lead + out + trail;
  }

  function translateAttrs(el) {
    var rec = originals.get(el);
    for (var i = 0; i < ATTRS.length; i++) {
      var name = ATTRS[i];
      var val = el.getAttribute(name);
      if (!val) continue;
      var key = 'a:' + name;
      var source = val;
      if (rec && rec[key] && rec[key].translated === val) source = rec[key].source;
      var out = translate(source.trim());
      if (out === source.trim()) continue;
      if (inSkippedArea(el)) continue;
      rec = rec || {};
      rec[key] = { source: source, translated: out };
      originals.set(el, rec);
      el.setAttribute(name, out);
    }
    if ((el.tagName === 'INPUT') && /^(button|submit|reset)$/i.test(el.type || '') && el.value) {
      var v = translate(el.value.trim());
      if (v !== el.value.trim()) el.value = v;
    }
  }

  function translateTree(root) {
    if (!root || lang === 'en') return;
    if (root.nodeType === 3) { translateTextNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (TEXT_SKIP_TAGS[root.nodeName.toUpperCase()]) return;
      if (inSkippedArea(root)) return;
      translateAttrs(root);
    }
    var walker = document.createTreeWalker(root, 1 | 4, {
      acceptNode: function (n) {
        if (n.nodeType === 1) {
          if (TEXT_SKIP_TAGS[n.nodeName.toUpperCase()]) return 2; // FILTER_REJECT (skips subtree)
          if (n.hasAttribute && n.hasAttribute('data-no-i18n')) return 2;
          return 3; // FILTER_SKIP, but descend
        }
        return 1;
      }
    });
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) translateTextNode(n);
    }
    if (root.querySelectorAll) {
      var els = root.querySelectorAll('[placeholder],[title],[aria-label],[alt],[data-tooltip],[data-title],[data-placeholder],input[type=button],input[type=submit],input[type=reset]');
      for (var i = 0; i < els.length; i++) translateAttrs(els[i]);
    }
  }

  var pending = new Set();
  var scheduled = false;
  function schedule(node) {
    pending.add(node);
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || setTimeout)(flush);
  }
  function flush() {
    scheduled = false;
    var batch = Array.from(pending);
    pending.clear();
    for (var i = 0; i < batch.length; i++) {
      var n = batch[i];
      if (n.isConnected === false) continue;
      translateTree(n);
    }
  }

  var observer = null;
  function startObserver() {
    if (observer || lang === 'en' || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'childList') {
          for (var j = 0; j < m.addedNodes.length; j++) schedule(m.addedNodes[j]);
        } else if (m.type === 'characterData') {
          schedule(m.target);
        } else if (m.type === 'attributes') {
          schedule(m.target);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS
    });
  }

  // ---------------------------------------------------------------- native dialogs
  function wrapDialogs() {
    ['alert', 'confirm', 'prompt'].forEach(function (name) {
      var orig = window[name];
      if (typeof orig !== 'function' || orig.__i18n) return;
      var wrapped = function (msg, def) {
        return name === 'prompt'
          ? orig.call(window, translate(String(msg == null ? '' : msg)), def)
          : orig.call(window, translate(String(msg == null ? '' : msg)));
      };
      wrapped.__i18n = true;
      window[name] = wrapped;
    });
  }

  function translateTitle() {
    if (lang === 'en') return;
    var title = document.title;
    var out = translate(title);
    if (out !== title) document.title = out;
    var titleEl = document.querySelector('title');
    if (titleEl && window.MutationObserver) {
      new MutationObserver(function () {
        var cur = document.title, tr = translate(cur);
        if (tr !== cur) document.title = tr;
      }).observe(titleEl, { childList: true });
    }
  }

  // ---------------------------------------------------------------- public API
  function setLang(next) {
    if (SUPPORTED.indexOf(next) === -1) return;
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
    window.location.reload();
  }

  loadLocale();
  try { document.documentElement.setAttribute('lang', lang); } catch (e) { /* ignore */ }

  /** Wire <select data-lang-select>: UI language is per browser, AI reply language is a server setting. */
  function bindLangPicker(root) {
    var sels = (root || document).querySelectorAll('select[data-lang-select]');
    for (var i = 0; i < sels.length; i++) {
      (function (sel) {
        if (sel.__i18nBound) return;
        sel.__i18nBound = true;
        sel.value = lang;
        sel.addEventListener('change', function () {
          var next = sel.value;
          // Best effort: only admins may change the global AI reply language.
          try {
            fetch('/api/auth/settings', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ response_language: next })
            }).catch(function () { /* non-admin or offline: UI language still changes */ })
              .then(function () {
                // Drop the shared settings snapshot before the page reloads.
                return import('/static/js/appConfig.js')
                  .then(function (m) { m.invalidateSettings(); })
                  .catch(function () { /* cache module unavailable: reload clears it anyway */ });
              })
              .then(function () { setLang(next); });
          } catch (e) { setLang(next); }
        });
      })(sels[i]);
    }
  }

  window.i18n = {
    lang: lang,
    supported: SUPPORTED.slice(),
    t: t,
    translate: translate,
    setLang: setLang,
    translateTree: translateTree,
    bindLangPicker: bindLangPicker
  };
  window.t = t;

  wrapDialogs();

  function boot() {
    translateTree(document.body || document.documentElement);
    translateTitle();
    startObserver();
  }
  document.addEventListener('DOMContentLoaded', function () { bindLangPicker(); });
  // The settings modal may be injected later; bind lazily when it appears.
  document.addEventListener('click', function () { bindLangPicker(); }, true);
  if (lang !== 'en') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
      // Start observing immediately so nodes parsed before DOMContentLoaded are caught too.
      startObserver();
    } else {
      boot();
    }
  }
})();
