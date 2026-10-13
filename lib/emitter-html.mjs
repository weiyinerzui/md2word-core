// ============================================================
// md2word — 「复制为 Word」HTML 发射器
// 产出 Word 粘贴友好的富 HTML：单根 div、全内联样式、
// 标题带 mso-style-name 使 Word 自动套 Heading N 样式、
// 公式内嵌 MathML（Word 2016+ 粘贴时自动 OMML 化）
// 行为参照：WordMarker word-clipboard-html-emitter
// ============================================================
import { buildMathAsset } from './math.mjs';
import { highlightToTokens, tokenColor, PALETTE_LIGHT } from './highlight.mjs';
import { capSize, MAX_IMAGE_WIDTH, dataUriToBytes } from './assets.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FONT_TEXT = { zh: `Calibri, "Microsoft YaHei", SimSun, sans-serif`, en: `"Times New Roman", Times, serif`, default: `Calibri, "Microsoft YaHei", SimSun, sans-serif` };
const FONT_CODE = 'Consolas, "Courier New", monospace';
const CODE_BG = '#F6F8FA';
const CODE_BORDER = '#D0D7DE';
const LINK = '#0563C1';

export async function buildWordClipboardHtml(ir, options = {}) {
  const styleId = options.style || 'zh';
  const { doc } = ir;
  const warnings = [...(ir.warnings || [])];
  const mathCache = new Map();
  const imageCache = new Map();

  async function mathHtml(node, display) {
    const key = `${display ? 'b' : 'i'}:${node.source}`;
    if (!mathCache.has(key)) mathCache.set(key, buildMathAsset(node.source, { displayMode: display }));
    const asset = await mathCache.get(key);
    if (!asset.mathml) {
      warnings.push(...asset.warnings.map((w) => ({ ...w })));
      return null;
    }
    if (display) {
      return `<div style="text-align:center; margin:12px 0">${asset.mathml}</div>`;
    }
    return `<span>${asset.mathml}</span>`;
  }

  async function imageTag(src, alt) {
    if (/^data:image\/(png|jpe?g|gif|bmp)/i.test(src)) {
      if (!imageCache.has(src)) {
        imageCache.set(src, (async () => {
          try {
            const bytes = dataUriToBytes(src);
            const { imageSize } = await import('./assets.mjs');
            return imageSize(bytes);
          } catch { return null; }
        })());
      }
      const dim = await imageCache.get(src);
      const size = capSize(dim?.width || 320, dim?.height || 180, MAX_IMAGE_WIDTH);
      return `<img src="${esc(src)}" alt="${esc(alt || '')}" width="${size.width}" height="${size.height}" />`;
    }
    return null;
  }

  async function inlineHtml(nodes, ctx = {}) {
    let out = '';
    for (const n of nodes || []) {
      switch (n.type) {
        case 'text': {
          let t = esc(n.text);
          if (n.bold) t = `<strong>${t}</strong>`;
          else if (ctx.bold) t = `<strong>${t}</strong>`;
          if (n.italics || ctx.italics) t = `<em>${t}</em>`;
          if (n.strike || ctx.strike) t = `<s>${t}</s>`;
          out += t;
          break;
        }
        case 'inline_code':
          out += `<code style="font-family:${FONT_CODE}; background-color:#F6F8FA; padding:2px 4px; border-radius:3px; font-size:85%">${esc(n.text)}</code>`;
          break;
        case 'strong': out += `<strong>${await inlineHtml(n.children, { ...ctx, bold: true })}</strong>`; break;
        case 'link': {
          const safe = /^(https?:|mailto:)/i.test(n.href) ? n.href : '';
          const inner = n.children?.length ? await inlineHtml(n.children, ctx) : esc(n.href);
          out += safe ? `<a href="${esc(safe)}" style="color:${LINK}; text-decoration:underline">${inner}</a>` : inner;
          break;
        }
        case 'soft_break': case 'hard_break': out += '<br />'; break;
        case 'math_inline': {
          const html = await mathHtml(n, false);
          out += html ?? esc(`$${n.source}$`);
          if (!html) warnings.push({ code: 'mathClipboardFallback', message: `公式降级：${n.source.slice(0, 30)}` });
          break;
        }
        case 'footnote_ref': out += `<sup style="font-size:75%">[${esc(n.label)}]</sup>`; break;
        case 'image': {
          const tag = await imageTag(n.src, n.alt);
          out += tag ?? esc(n.alt || n.src);
          if (!tag) warnings.push({ code: 'imageClipboardFallback', message: `图片不可用，降级为文本：${String(n.src).slice(0, 40)}` });
          break;
        }
        default: break;
      }
    }
    return out;
  }

  function codeBlockHtml(node) {
    const result = highlightToTokens(node.lines.join('\n'), node.lang);
    const lines = [];
    let cur = [];
    for (const t of result.spans || []) {
      const parts = t.text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) { lines.push(cur); cur = []; }
        if (parts[i]) cur.push({ text: parts[i], className: t.className });
      }
    }
    if (cur.length) lines.push(cur);
    const bodyHtml = lines.map((tokens) => tokens.map((t) => {
      const color = tokenColor(t.className);
      const style = [];
      if (color) style.push(`color:${color}`);
      return `<span${style.length ? ` style="${style.join('; ')}"` : ''}>${esc(t.text)}</span>`;
    }).join('')).join('\n');
    return `<pre style="font-family:${FONT_CODE}; background-color:${CODE_BG}; color:#24292F; padding:16px; border-radius:6px; border:1px solid ${CODE_BORDER}; font-size:13px; line-height:1.45; white-space:pre-wrap; margin:12px 0"><code class="language-${esc(node.lang || 'text')}">${bodyHtml}</code></pre>`;
  }

  async function blockHtml(nodes) {
    let out = '';
    for (const n of nodes) {
      switch (n.type) {
        case 'heading': {
          const d = Math.min(6, Math.max(1, n.depth));
          out += `<h${d} style="mso-style-name:'Heading ${d}'">${await inlineHtml(n.children)}</h${d}>`;
          break;
        }
        case 'paragraph': out += `<p>${await inlineHtml(n.children)}</p>`; break;
        case 'code_block': out += codeBlockHtml(n); break;
        case 'blockquote': out += `<blockquote style="border-left:4px solid ${CODE_BORDER}; padding:4px 16px; margin:12px 0; color:#57606A">${await blockHtml(n.children)}</blockquote>`; break;
        case 'bullet_list': out += `<ul>${(await itemsHtml(n.items, 0, false)).join('')}</ul>`; break;
        case 'ordered_list': out += `<ol${n.start && n.start !== 1 ? ` start="${n.start}"` : ''}>${(await itemsHtml(n.items, 0, true)).join('')}</ol>`; break;
        case 'table': out += tableHtml(n); break;
        case 'thematic_break': out += '<hr />'; break;
        case 'math_block': {
          const html = await mathHtml(n, true);
          out += html ?? `<p style="text-align:center">${esc(`$$${n.source}$$`)}</p>`;
          break;
        }
        case 'mermaid': {
          // 复制模式：先源码块，再（可用时）由调用方注入 PNG —— web 层处理后传入 asset
          out += codeBlockHtml({ lang: 'mermaid', lines: n.source.replace(/\n$/, '').split('\n') });
          const png = options.mermaidPngs?.[n.__id || fnvOf(n.source)];
          if (png) out += `<div style="text-align:center">${await imageTag(png, 'Mermaid diagram') ?? `<img src="${esc(png)}" alt="Mermaid diagram" />`}</div>`;
          break;
        }
        case 'figure': {
          const tag = await imageTag(n.image.src, n.image.alt);
          if (tag) {
            out += `<div style="text-align:center; margin:12pt 0">${tag}`;
            if (n.image.alt) out += `<p style="font-size:10.5pt; color:#57606A; margin:4pt 0 0 0">${esc(n.image.alt)}</p>`;
            out += '</div>';
          } else out += `<p>${esc(n.image.alt || n.image.src || '')}</p>`;
          break;
        }
        case 'html_block': {
          out += `<p style="color:#57606A">${esc((n.html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200))}</p>`;
          break;
        }
        default: break;
      }
    }
    return out;
  }

  async function itemsHtml(items, level, ordered) {
    const out = [];
    for (const item of items || []) {
      let inner = '';
      for (const b of item.blocks || []) {
        if (b.type === 'paragraph') inner += `<p>${await inlineHtml(b.children)}</p>`;
        else if (b.type === 'bullet_list') inner += `<ul>${(await itemsHtml(b.items, level + 1, false)).join('')}</ul>`;
        else if (b.type === 'ordered_list') inner += `<ol>${(await itemsHtml(b.items, level + 1, true)).join('')}</ol>`;
        else inner += await blockHtml([b]);
      }
      out.push(`<li>${inner}</li>`);
    }
    return out;
  }

  function tableHtml(node) {
    const cellTag = (cell, isHeader, isFirstCol) => {
      const tag = isHeader ? 'th' : 'td';
      const align = cell.align || (isHeader ? 'center' : isFirstCol ? 'left' : 'center');
      const span = [];
      if (cell.colspan > 1) span.push(` colspan="${cell.colspan}"`);
      if (cell.rowspan > 1) span.push(` rowspan="${cell.rowspan}"`);
      // 行内子树序列化需要 await —— HTML 表格（parse5 已提前转纯文本），md 表 children 也可能有公式：
      // 这里退化为文本（公式进表格单元格在复制模式降级为源码文本）
      return `<${tag}${span.join('')} style="border:1px solid ${CODE_BORDER}; padding:6px 13px;${isHeader ? ' font-weight:bold; background-color:#F6F8FA;' : ''} text-align:${align}">${esc(cellText(cell))}</${tag}>`;
    };
    const rows = [];
    if (node.header) rows.push(`<tr>${node.header.map((c, i) => cellTag(c, true, i === 0)).join('')}</tr>`);
    for (const row of node.rows || []) rows.push(`<tr>${row.map((c, i) => cellTag(c, false, i === 0)).join('')}</tr>`);
    return `<table style="border-collapse:collapse; margin:12px 0" >${rows.join('')}</table>`;
  }

  const body = await blockHtml(doc.children);

  // 参考文献区
  let refs = '';
  if ((doc.footnotes || []).length) {
    const items = [];
    for (const def of doc.footnotes) {
      items.push(`<p style="text-align:justify; margin:0 0 6pt 0"><span style="font-size:75%; vertical-align:super">[${esc(def.label)}]</span>&nbsp;${await inlineHtml(def.children)}</p>`);
    }
    refs = `<hr />${items.join('')}`;
  }

  const font = FONT_TEXT[styleId] || FONT_TEXT.zh;
  return {
    html: `<div style="font-family:${font}; font-size:11pt; line-height:1.5; color:#1F2328">${body}${refs}</div>`,
    plain: toPlainMarkdownFallback(ir),
    warnings,
  };
}

function cellText(cell) {
  if (cell.text != null && cell.text !== '') return cell.text;
  const parts = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.text) parts.push(n.text);
      if (n.children) walk(n.children);
      if (n.source) parts.push(n.source);
    }
  };
  walk(cell.children);
  return parts.join('').trim() || ' ';
}

function fnvOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(16);
}

/** text/plain 回退（无富文本粘贴能力的环境） */
function toPlainMarkdownFallback(ir) {
  const parts = [];
  const walk = (n) => {
    if (!n) return;
    if (n.text) parts.push(n.text);
    if (n.children) n.children.forEach(walk);
    if (n.blocks) n.blocks.forEach(walk);
    if (n.items) n.items.forEach(walk);
    if (n.type === 'math_inline' && n.source) parts.push(`$${n.source}$`);
    if (n.type === 'math_block' && n.source) parts.push(`\n${n.source}\n`);
    if (n.type === 'soft_break' || n.type === 'hard_break') parts.push('\n');
  };
  walk(ir.doc.children);
  return parts.join('');
}

export { esc };
