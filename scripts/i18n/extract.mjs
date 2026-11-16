// Extract candidate user-facing English strings from the Odysseus frontend.
// usage: node extract.mjs <repo> <out.json>
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const repo = process.argv[2];
const outFile = process.argv[3];
const found = new Map(); // text -> {n, files:Set, ctx:Set}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', times: '×', middot: '·', rarr: '→', larr: '←', check: '✓', bull: '•', laquo: '«', raquo: '»', copy: '©', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', deg: '°' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const c = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) ? String.fromCodePoint(c) : m; }
  return ENT[e] ?? m;
});

function add(text, file, ctx) {
  text = text.replace(/\s+/g, ' ').trim();
  if (!isUi(text)) return;
  let e = found.get(text);
  if (!e) found.set(text, (e = { n: 0, files: new Set(), ctx: new Set() }));
  e.n++; e.files.add(file); if (ctx) e.ctx.add(ctx);
}

function isUi(s) {
  if (s.length < 2 || s.length > 260) return false;
  if (!/[A-Za-z]{2}/.test(s)) return false;
  if (/^[.]/.test(s)) return false;
  if (/^(https?:|\/|\.\/|#|data:|mailto:)/.test(s)) return false;
  if (/=>|function\s*\(|;\s*$|\bnull\b.*\bundefined\b|[<>]{2}|\$\(|\)\s*\{/.test(s)) return false;
  if (/^[a-z]/.test(s) && !/\s/.test(s)) return false;               // identifiers, css classes, event names
  if (/^[A-Za-z0-9_.:\-\/\\]+$/.test(s) && /[_:\/\\]|[A-Za-z0-9]\.[A-Za-z]/.test(s)) return false; // snake_case, paths, dotted ids (but allow 'Loading...')
  if (/^[A-Z][A-Za-z]*(-[A-Z][A-Za-z]*)+$/.test(s)) return false;     // Content-Type (keep 'Auto-detect')
  if (/^[A-Z][a-z]+[A-Z]/.test(s) && !/\s/.test(s)) return false;     // CamelCase identifiers
  if (/^[A-Z0-9_]+$/.test(s) && s.length > 5) return false;          // CONSTANTS
  if (/^[a-z]/.test(s)) return false;                                 // sentences starting lowercase are almost always code/css
  if (/[{}]/.test(s.replace(/\{\d+\}/g, ''))) return false;           // leftover code braces
  if (/\b(px|rem|em|vh|vw|rgba?|var\()\b/.test(s) && !/\s[A-Z]/.test(s)) return false;
  return true;
}

function fromMarkup(str, file, ctx) {
  // attributes
  for (const m of str.matchAll(/\b(placeholder|title|aria-label|alt|data-tooltip|data-title|data-placeholder|label)=("([^"]*)"|'([^']*)')/g)) {
    add(decode(m[3] ?? m[4] ?? ''), file, ctx + ':attr:' + m[1]);
  }
  const stripped = str.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  for (const seg of stripped.split(/<[^>]*>/)) {
    const t = decode(seg);
    if (t.trim()) add(t, file, ctx + ':text');
  }
}

const SKIP_CALLEES = new Set(['querySelector', 'querySelectorAll', 'getElementById', 'closest', 'matches', 'addEventListener', 'removeEventListener', 'add', 'remove', 'toggle', 'contains', 'getAttribute', 'hasAttribute', 'removeAttribute', 'getItem', 'setItem', 'removeItem', 'createElement', 'createElementNS', 'postMessage', 'fetch', 'log', 'warn', 'error', 'debug', 'info', 'trace', 'test', 'match', 'matchAll', 'split', 'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'dispatchEvent', 'emit', 'on', 'off', 'once', 'require', 'import', 'getComputedStyle', 'getPropertyValue', 'setProperty', 'removeProperty', 'localeCompare', 'padStart', 'padEnd', 'join', 'has', 'get', 'set', 'delete', 'sendBeacon', 'open', 'assert', 'RegExp', 'Error']);
const KEEP_ERRORS = true;

function templateText(node) {
  let s = '';
  node.quasis.forEach((q, i) => {
    s += q.value.cooked ?? q.value.raw;
    if (i < node.expressions.length) s += `{${i + 1}}`;
  });
  return s;
}

function scanJs(code, file, offsetLine = 0) {
  let ast;
  const opts = { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true, allowAwaitOutsideFunction: true };
  try { ast = acorn.parse(code, { ...opts, sourceType: 'module' }); }
  catch { try { ast = acorn.parse(code, { ...opts, sourceType: 'script' }); } catch (e) { console.error('PARSE FAIL', file, e.message); return; } }
  walk.ancestor(ast, {
    Literal(node, _s, anc) { if (typeof node.value === 'string') handle(node.value, node, anc, file); },
    TemplateLiteral(node, _s, anc) { handle(templateText(node), node, anc, file, true); },
  });
}

function handle(text, node, anc, file, isTpl) {
  const parent = anc[anc.length - 2];
  if (!parent) return;
  let ctx = parent.type;
  if (parent.type === 'Property') { if (parent.key === node && !parent.computed) return; ctx = 'prop:' + (parent.key.name ?? parent.key.value); }
  if (parent.type === 'MemberExpression' && parent.property === node) return;
  if (parent.type === 'ImportDeclaration' || parent.type === 'ExportAllDeclaration' || parent.type === 'ExportNamedDeclaration') return;
  if (parent.type === 'SwitchCase') return;
  if (parent.type === 'BinaryExpression' && ['==', '===', '!=', '!=='].includes(parent.operator)) return;
  if (parent.type === 'ImportExpression') return;
  if (parent.type === 'ExpressionStatement') return; // 'use strict'
  if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
    const c = parent.callee;
    const name = c.type === 'MemberExpression' ? (c.property.name ?? c.property.value) : c.name;
    if (name === 'Error' || name === 'TypeError') { if (!KEEP_ERRORS) return; ctx = 'error'; }
    else if (SKIP_CALLEES.has(name)) return;
    else ctx = 'call:' + name;
    if (name === 'setAttribute' && parent.arguments[1] !== node) return;
  }
  if (parent.type === 'AssignmentExpression') {
    const l = parent.left; const nm = l.type === 'MemberExpression' ? (l.property.name ?? l.property.value) : '';
    if (['className', 'id', 'href', 'src', 'type', 'name', 'value', 'cssText', 'display', 'width', 'height', 'color', 'background', 'rel', 'target', 'htmlFor', 'for'].includes(nm)) return;
    ctx = 'assign:' + nm;
  }
  const rel = file;
  if (/<[a-zA-Z!\/][^>]*>/.test(text)) fromMarkup(text, rel, ctx);
  else add(text, rel, ctx);
}

function scanHtml(file) {
  const src = fs.readFileSync(path.join(repo, file), 'utf8');
  for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {
    if (/\bsrc=/.test(m[1])) continue;
    scanJs(m[2], file);
  }
  fromMarkup(src.replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' '), file, 'html');
}

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'lib' || e.name === 'node_modules') continue; out.push(...listJs(p)); }
    else if (/\.m?js$/.test(e.name) && !/\.min\.js$/.test(e.name) && e.name !== 'i18n.js') out.push(p);
  }
  return out;
}

for (const f of ['static/index.html', 'static/login.html']) scanHtml(f);
const files = [path.join(repo, 'static/app.js'), ...listJs(path.join(repo, 'static/js'))];
for (const f of files) scanJs(fs.readFileSync(f, 'utf8'), path.relative(repo, f));

const out = {};
for (const [k, v] of [...found.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  out[k] = { n: v.n, files: [...v.files].slice(0, 3), ctx: [...v.ctx].slice(0, 3) };
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log('unique strings:', Object.keys(out).length, 'files scanned:', files.length + 2);
