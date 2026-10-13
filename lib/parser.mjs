// ============================================================
// md2word — Markdown → 文档 IR
// markdown-it(GFM) + 自研数学/脚注规则 → 块级/行内节点树
// 行为参照：WordMarker markdown-document-ir-parser（remark 系）
//   math_block / math_inline、footnote、html 表格分类、源级风格
// ============================================================
import MarkdownIt from 'markdown-it';
import { parse as parse5 } from 'parse5';

export function createMarkdown() {
  const md = new MarkdownIt({ html: true, linkify: false, breaks: false, typographer: false });

  // ---- 块级 $$...$$ 公式 ----
  md.block.ruler.before('paragraph', 'math_block', (state) => {
    const start = state.line;
    if (start >= state.lineMax) return false;
    const first = state.src.slice(state.bMarks[start], state.eMarks[start]);
    const m = /^\s{0,3}\$\$(.*)$/.exec(first);
    if (!m) return false;

    let content = null;
    let nextLine = start;
    // 单行形式：$$ x $$
    const single = /^(.*)\$\$\s*$/.exec(m[1]);
    if (single && single[1].trim()) {
      content = single[1].trim();
      nextLine = start + 1;
    } else {
      // 多行形式：首行 $$ 之后的内容 + 后续各行，直到独占的 $$ 行
      const buf = m[1].length ? [m[1]] : [];
      for (let ln = start + 1; ln < state.lineMax; ln++) {
        const l = state.src.slice(state.bMarks[ln], state.eMarks[ln]);
        if (/^\s{0,3}\$\$\s*$/.test(l)) { content = buf.join('\n'); nextLine = ln + 1; break; }
        buf.push(l);
      }
    }
    if (content == null) return false;

    const tok = new state.Token('math_js', 'math', 0);
    tok.content = content.trim();
    tok.meta = { display: true };
    tok.map = [start, nextLine];
    state.tokens.push(tok);
    state.line = nextLine;
    return true;
  });

  // ---- 行内 $...$（$ 后非空白、闭合 $ 前非空白、不含换行）----
  md.inline.ruler.before('text', 'math_inline', (state) => {
    const src = state.src, pos = state.pos;
    if (src[pos] !== '$' || src[pos + 1] === '$' || src[pos + 1] === undefined) return false;
    // 货币启发：$ 前后都是数字则不当公式（如 100$~$50）
    if (/[0-9]/.test(src[pos - 1] || '') && /[0-9]/.test(src[pos + 1])) return false;
    let i = pos + 1;
    while (i < state.posMax) {
      const ch = src[i];
      if (ch === '\\' && src[i + 1] === '$') { i += 2; continue; }
      if (ch === '\n' || ch === '$') break;
      i++;
    }
    if (src[i] !== '$') return false;
    const content = src.slice(pos + 1, i);
    if (!content || /^\s|\s$/.test(content)) return false;
    const token = state.push('math_js_inline', 'math', 0);
    token.content = content;
    token.meta = { display: false };
    state.pos = i + 1;
    return true;
  });

  // ---- 行内脚注引用 [^label] ----
  md.inline.ruler.before('text', 'footnote_ref', (state) => {
    const src = state.src, pos = state.pos;
    if (src[pos] !== '[' || src[pos + 1] !== '^') return false;
    const m = /^\[\^([^\]\s]+)\]/.exec(src.slice(pos));
    if (!m) return false;
    const token = state.push('footnote_ref', '', 0);
    token.meta = { label: m[1] };
    state.pos = pos + m[0].length;
    return true;
  });

  return md;
}

// ============================================================
// 脚注定义预抽取：[^label]: 内容 → 移出源，收集为 map
// ============================================================
export function extractFootnotes(src) {
  const defs = new Map();
  const lines = src.split('\n');
  const keep = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^[ \t]{0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(lines[i]);
    if (m) {
      let content = m[2];
      let j = i + 1;
      while (j < lines.length && /^[ \t]{4,}\S/.test(lines[j])) {
        content += ' ' + lines[j].trim();
        j++;
      }
      defs.set(m[1], content.trim());
      if (keep.length && keep[keep.length - 1].trim()) keep.push('');
      i = j;
      continue;
    }
    keep.push(lines[i]);
    i++;
  }
  return { src: keep.join('\n'), defs };
}

// ============================================================
// HTML 表格解析（AI 常直接输出 <table>）
// ============================================================
export function parseHtmlTable(html) {
  let frag;
  try { frag = parse5(html); } catch { return null; }
  const tables = [];
  const walk = (n) => {
    if (n.tagName === 'table') { tables.push(n); return; }
    for (const c of n.childNodes || []) walk(c);
  };
  walk(frag);
  if (tables.length !== 1) return null;
  let nested = false;
  const deep = (n) => { for (const c of n.childNodes || []) { if (c.tagName === 'table') nested = true; else deep(c); } };
  deep(tables[0]);
  if (nested) return null;

  const inlineHtml = (node) => {
    let out = '';
    for (const c of node.childNodes || []) {
      if (c.nodeName === '#text') out += c.value;
      else if (['b', 'strong'].includes(c.tagName)) out += `<strong>${inlineHtml(c)}</strong>`;
      else if (['i', 'em'].includes(c.tagName)) out += `<em>${inlineHtml(c)}</em>`;
      else if (['s', 'del', 'strike'].includes(c.tagName)) out += `<s>${inlineHtml(c)}</s>`;
      else if (c.tagName === 'br') out += '\n';
      else out += inlineHtml(c);
    }
    return out;
  };
  const headerRows = [];
  const bodyRows = [];
  const visitRow = (tr, isHead) => {
    const cells = [];
    for (const td of tr.childNodes || []) {
      if (!['td', 'th'].includes(td.tagName)) continue;
      const styleAttr = td.attrs.find((a) => a.name === 'style')?.value || '';
      const align = /text-align:\s*(left|center|right)/i.exec(styleAttr)?.[1]
        || td.attrs.find((a) => a.name === 'align')?.value || undefined;
      cells.push({
        text: inlineHtml(td).trim(),
        header: isHead || td.tagName === 'th',
        rowspan: Math.max(1, parseInt(td.attrs.find((a) => a.name === 'rowspan')?.value) || 1),
        colspan: Math.max(1, parseInt(td.attrs.find((a) => a.name === 'colspan')?.value) || 1),
        align,
      });
    }
    if (cells.length) (isHead ? headerRows : bodyRows).push(cells);
  };
  const visit = (n) => {
    for (const c of n.childNodes || []) {
      if (c.tagName === 'tr') visitRow(c, false);
      else if (c.tagName === 'thead') { for (const t of c.childNodes || []) if (t.tagName === 'tr') visitRow(t, true); }
      else visit(c);
    }
  };
  visit(tables[0]);
  const all = [...headerRows, ...bodyRows];
  if (!all.length) return null;
  const hasHeader = headerRows.length > 0 || (all[0] || []).some((c) => c.header);
  return { header: hasHeader ? all[0] : null, rows: hasHeader ? all.slice(1) : all, hasHeader };
}

// ============================================================
// md-it tokens → IR（递归下降）
// ============================================================
export function markdownToIr(src, opts = {}) {
  const md = opts.md || createMarkdown();
  const { src: srcNoDefs, defs } = extractFootnotes(src);
  const tokens = md.parse(srcNoDefs, {});
  const warnings = [];
  const doc = { type: 'doc', children: [], footnotes: [] };

  // ---------- 行内解析 ----------
  function findClose(toks, from) {
    const open = toks[from].type;
    const close = open.replace(/_open$/, '_close');
    let depth = 0;
    for (let j = from + 1; j < toks.length; j++) {
      if (toks[j].type === open) depth++;
      if (toks[j].type === close) { if (depth === 0) return j; depth--; }
    }
    return -1;
  }

  function parseInline(toks, st = {}) {
    const out = [];
    const base = () => ({ bold: st.bold || false, italics: st.italics || false, strike: st.strike || false });
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      switch (t.type) {
        case 'text': out.push({ type: 'text', text: t.content, ...base() }); i++; break;
        case 'code_inline': out.push({ type: 'inline_code', text: t.content }); i++; break;
        case 'softbreak': out.push({ type: 'soft_break' }); i++; break;
        case 'hardbreak': out.push({ type: 'hard_break' }); i++; break;
        case 'math_js_inline': out.push({ type: 'math_inline', source: t.content }); i++; break;
        case 'footnote_ref': out.push({ type: 'footnote_ref', label: t.meta.label }); i++; break;
        case 'image': {
          const alt = t.content || t.attrGet('alt') || '';
          out.push({ type: 'image', src: t.attrGet('src') || '', alt, title: t.attrGet('title') || '' });
          i++; break;
        }
        case 'link_open': {
          const closeIdx = findClose(toks, i);
          if (closeIdx < 0) { i++; break; }
          const href = t.attrGet('href') || '';
          const children = parseInline(toks.slice(i + 1, closeIdx), st);
          out.push({ type: 'link', href, children, ...base() });
          i = closeIdx + 1; break;
        }
        case 'strong_open': case 'em_open': case 's_open': case 'del_open': {
          const closeIdx = findClose(toks, i);
          if (closeIdx < 0) { i++; break; }
          const key = t.type === 'strong_open' ? 'bold' : t.type === 'em_open' ? 'italics' : 'strike';
          const children = parseInline(toks.slice(i + 1, closeIdx), { ...st, [key]: true });
          out.push({ type: 'strong', children, ...base() });
          i = closeIdx + 1; break;
        }
        case 'html_inline': {
          if (/<br\s*\/?>/i.test(t.content)) out.push({ type: 'hard_break' });
          else out.push({ type: 'text', text: t.content.replace(/<[^>]*>/g, ''), ...base() });
          i++; break;
        }
        default: i++;
      }
    }
    return out;
  }

  // ---------- 表格 tokens ----------
  function parseMdTable(tokens) {
    // tokens: table_open ... table_close
    const inner = tokens.slice(1, -1);
    const headerCells = [];
    const rows = [];
    let current = null;
    let inHead = false;
    for (let i = 0; i < inner.length; i++) {
      const t = inner[i];
      if (t.type === 'thead_open') inHead = true;
      else if (t.type === 'thead_close') inHead = false;
      else if (t.type === 'tr_open') current = { cells: [] };
      else if (t.type === 'tr_close') {
        if (current) { if (inHead) headerCells.push(current.cells); else rows.push(current.cells); }
        current = null;
      } else if (t.type === 'th_open' || t.type === 'td_open') {
        const align = /text-align:\s*(left|center|right)/.exec(t.attrGet('style') || '')?.[1];
        const inlineToks = inner[i + 1]?.type === 'inline' ? inner[i + 1].children : [];
        current.cells.push({ text: '', children: parseInline(inlineToks), header: t.type === 'th_open', align, rowspan: 1, colspan: 1 });
      }
    }
    // 修正：第一遍 tr 在 thead 之外时（无 thead 的表）不应进 header
    if (!headerCells.length && rows.length) { /* 保持原样：无表头表 */ }
    return { header: headerCells.length ? headerCells[0] : null, rows, hasHeader: headerCells.length > 0, aligns: null };
  }

  // ---------- 块解析 ----------
  function renderChildren(toks, target) {
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      const inlineOf = (idx) => (toks[idx]?.type === 'inline' ? toks[idx].children || [] : []);
      switch (t.type) {
        case 'heading_open': {
          const depth = parseInt(t.tag[1]);
          target.push({ type: 'heading', depth, children: parseInline(inlineOf(i + 1)) });
          i += 3; break;
        }
        case 'paragraph_open': {
          const children = parseInline(inlineOf(i + 1));
          // 独立图片段 → figure
          if (children.length === 1 && children[0].type === 'image') {
            target.push({ type: 'figure', image: children[0] });
          } else {
            target.push({ type: 'paragraph', children });
          }
          i += 3; break;
        }
        case 'math_js': target.push({ type: 'math_block', source: t.content }); i++; break;
        case 'fence': case 'code_block': {
          const lang = (t.info || '').trim().split(/\s+/)[0] || '';
          if (lang === 'mermaid') target.push({ type: 'mermaid', source: t.content });
          else target.push({ type: 'code_block', lang, lines: t.content.replace(/\n$/, '').split('\n') });
          i++; break;
        }
        case 'blockquote_open': {
          let depth = 1, j = i + 1;
          const inner = [];
          while (j < toks.length) {
            if (toks[j].type === 'blockquote_open') depth++;
            if (toks[j].type === 'blockquote_close' && --depth === 0) break;
            inner.push(toks[j]);
            j++;
          }
          const blocks = [];
          renderChildren(inner, blocks);
          target.push({ type: 'blockquote', children: blocks });
          i = j + 1; break;
        }
        case 'bullet_list_open': case 'ordered_list_open': {
          const ordered = t.type === 'ordered_list_open';
          const start = ordered ? parseInt(t.attrGet('start') || '1') : 1;
          let depth = 1, j = i + 1;
          const inner = [];
          while (j < toks.length) {
            const ty = toks[j].type;
            if (/(list|item)_open/.test(ty)) depth++;
            if (/(list|item)_close/.test(ty)) {
              depth--;
              if (depth === 0) break;
            }
            inner.push(toks[j]);
            j++;
          }
          const items = [];
          parseListItem(inner, ordered, items);
          target.push({ type: ordered ? 'ordered_list' : 'bullet_list', items, start });
          i = j + 1; break;
        }
        case 'table_open': {
          let depth = 0, j = i;
          while (j < toks.length) {
            if (toks[j].type === 'table_open') depth++;
            if (toks[j].type === 'table_close' && --depth === 0) break;
            j++;
          }
          const tbl = parseMdTable(toks.slice(i, j + 1));
          target.push({ type: 'table', ...tbl, htmlSource: false });
          i = j + 1; break;
        }
        case 'hr': target.push({ type: 'thematic_break' }); i++; break;
        case 'html_block': {
          const html = (t.content || '').trim();
          if (/^<table[\s>]/i.test(html)) {
            const parsed = parseHtmlTable(html);
            if (parsed) target.push({ type: 'table', ...parsed, htmlSource: true });
            else {
              target.push({ type: 'html_block', htmlKind: 'table', html });
              warnings.push({ code: 'htmlTableUnsupported', message: 'HTML 表格结构复杂（嵌套/多顶层表），已降级为原文' });
            }
          } else if (html) {
            target.push({ type: 'html_block', htmlKind: 'raw', html });
            warnings.push({ code: 'htmlBlockDegraded', message: '原始 HTML 块仅支持表格，其余降级为文本' });
          }
          i++; break;
        }
        default: i++;
      }
    }
  }

  // 列表项：list_item_open ... list_item_close（inner 含首段与嵌套列表）
  function parseListItem(toks, ordered, items) {
    let i = 0;
    while (i < toks.length) {
      if (toks[i].type !== 'list_item_open') { i++; continue; }
      let depth = 1, j = i + 1;
      const inner = [];
      while (j < toks.length) {
        const ty = toks[j].type;
        if (ty === 'list_item_open') depth++;
        if (ty === 'list_item_close' && --depth === 0) break;
        inner.push(toks[j]);
        j++;
      }
      const blocks = [];
      renderChildren(inner, blocks);
      items.push({ type: 'list_item', blocks });
      i = j + 1;
    }
  }

  renderChildren(tokens, doc.children);

  // ---------- 脚注定义 ----------
  const usedLabels = [];
  const collect = (nodes) => {
    for (const n of nodes || []) {
      if (n.children) collect(n.children);
      if (n.blocks) for (const b of n.blocks) collect(b.children);
      if (n.items) for (const it of n.items) collect(it.blocks);
      if (n.type === 'footnote_ref') usedLabels.push(n.label);
    }
  };
  collect(doc.children);
  const seen = new Set();
  for (const label of usedLabels) {
    if (seen.has(label)) continue;
    seen.add(label);
    const def = defs.get(label);
    if (def != null) {
      const children = parseInline(md.parseInline(def, {})[0]?.children || []);
      doc.footnotes.push({ type: 'footnote_def', label, children });
    } else {
      warnings.push({ code: 'footnoteUndefined', message: `脚注 [^${label}] 未找到定义` });
    }
  }
  return { doc, warnings };
}
