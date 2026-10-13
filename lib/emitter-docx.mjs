// ============================================================
// md2word — DOCX 发射器（IR → docx 库对象树 → .docx）
// 行为参照：WordMarker docx-emitter / math-docx-emitter /
// code-block-docx-emitter（OMML 注入、逐 token 着色、
// 代码块盒装拼边、脚注书签 + REF 域、图片 540px 上限）
// ============================================================
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel,
  ImageRun, ImportedXmlComponent, Packer, Paragraph, ShadingType, SimpleField,
  Table, TableCell, TableRow, TextRun, Tab, VerticalAlign, WidthType,
  Bookmark, TableLayoutType,
} from 'docx';
import { buildStyleProfile } from './styles.mjs';
import { highlightToTokens, tokenColor, tokenEmphasis } from './highlight.mjs';
import { capSize, MAX_IMAGE_WIDTH, fnv1a, describeImageFailure, reencodeImage } from './assets.mjs';

const CODE_BG = 'F6F8FA';
const CODE_BORDER = 'D0D7DE';

// ------------------------------------------------------------
// 1) IR 预标注：数学/脚注/图片 资产键
// ------------------------------------------------------------
export function annotateIr(doc) {
  let mathSeq = 0;
  const footOrder = [];
  const seen = new Set();
  const walkInline = (nodes) => {
    for (const n of nodes || []) {
      if (n.children) walkInline(n.children);
      if (n.type === 'math_inline' && !n.__id) n.__id = `math-${mathSeq++}`;
      if (n.type === 'footnote_ref' && !seen.has(n.label)) { seen.add(n.label); footOrder.push(n.label); }
    }
  };
  const walkBlocks = (nodes) => {
    for (const n of nodes || []) {
      if (n.children) walkBlocks(n.children);
      if (n.blocks) for (const b of n.blocks) { walkBlocks([b]); if (b.children) walkInline(b.children); }
      if (n.items) for (const it of n.items) walkBlocks(it.blocks);
      if (n.children && !n.blocks && !n.items) walkInline(n.children);
      if (n.type === 'math_block' && !n.__id) n.__id = `math-${mathSeq++}`;
      if (n.type === 'mermaid' && !n.__id) n.__id = `mermaid-${fnv1a(n.source)}`;
    }
  };
  walkBlocks(doc.children);
  walkInline(doc.children); // 顶层段落行内（walkBlocks 已覆盖 children——双重遍历幂等）
  const labelToNum = new Map(footOrder.map((l, i) => [l, i + 1]));
  for (const def of doc.footnotes || []) def.__num = labelToNum.get(def.label) || 0;
  return { labelToNum };
}

// 内联遍历工具：覆盖 paragraphs/tables/blockquote/list 中的行内节点
function eachInlineNode(doc, fn) {
  const walkInline = (nodes, ctx) => {
    for (const n of nodes || []) { fn(n, ctx); if (n.children && !n.blocks) walkInline(n.children, ctx); }
  };
  const walkBlocks = (nodes, ctx) => {
    for (const n of nodes || []) {
      if (n.children) walkInline(n.children, { ...ctx, node: n });
      if (n.blocks) for (const b of n.blocks) walkBlocks(b, ctx);
      if (n.items) for (const it of n.items) walkBlocks(it.blocks, ctx);
      if (n.type === 'table') {
        if (n.header) for (const c of n.header) walkInline(c.children || [], ctx);
        for (const row of n.rows || []) for (const c of row) walkInline(c.children || [], ctx);
      }
    }
  };
  walkBlocks(doc.children, {});
}

// ------------------------------------------------------------
// 2) 资产准备（math 服务在建文档前全部就绪）
// ------------------------------------------------------------
export async function prepareAssets(doc, opts = {}) {
  const { buildMathAsset } = await import('./math.mjs');
  const { loadImageAsset, rasterizeMermaid } = await import('./assets.mjs');
  annotateIr(doc);
  const mathAssets = new Map();
  const imageAssets = new Map();
  const mermaidAssets = new Map();
  const warnings = [];

  eachInlineNode(doc, (n) => {
    if ((n.type === 'math_inline' || n.type === 'math_block') && !mathAssets.has(n.__id)) {
      mathAssets.set(n.__id, buildMathAsset(n.source, { displayMode: n.type === 'math_block' || n.display }));
    }
  });
  const walkBlocks = (nodes) => {
    for (const n of nodes || []) {
      if (n.children) walkBlocks(n.children);
      if (n.blocks) for (const b of n.blocks) walkBlocks(b);
      if (n.items) for (const it of n.items) walkBlocks(it.blocks);
      if (n.type === 'math_block' && !mathAssets.has(n.__id)) {
        mathAssets.set(n.__id, buildMathAsset(n.source, { displayMode: true }));
      }
      if (n.type === 'mermaid' && !mermaidAssets.has(n.__id)) {
        if (opts.mermaid !== false && typeof document !== 'undefined' && globalThis.Image) {
          mermaidAssets.set(n.__id,
            rasterizeMermaid(n.source, { scale: 2 })
              .catch((e) => { warnings.push({ code: 'mermaidRenderFailed', message: `Mermaid 渲染失败：${String(e.message || e).slice(0, 60)}` }); return null; }));
        } else {
          warnings.push({ code: 'mermaidNoRasterizer', message: '当前环境无浏览器画布，Mermaid 图以代码块形式保留' });
        }
      }
      if (n.type === 'figure' && !imageAssets.has(n.image.src)) {
        imageAssets.set(n.image.src, loadImageAsset(n.image.src, opts).catch(() => null));
      }
    }
  };
  walkBlocks(doc.children);
  eachInlineNode(doc, (n) => {
    if (n.type === 'image' && !imageAssets.has(n.src)) {
      imageAssets.set(n.src, loadImageAsset(n.src, opts).catch(() => null));
    }
  });

  // 等待全部资产
  const resolveMap = async (m) => {
    const out = new Map();
    for (const [k, v] of m) out.set(k, await Promise.resolve(v));
    return out;
  };
  const images = await resolveMap(imageAssets);
  if (opts.reencode !== false) {
    // ③ 决策：外链图过大重采样（浏览器 canvas）——在资产阶段预计算，发射层同步消费
    for (const asset of images.values()) {
      if (!asset || asset.error || !asset.bytes) continue;
      const r = await reencodeImage(asset);
      if (r) {
        asset.reencoded = r;
        warnings.push({ code: 'imageResized', message: `图片已重采样：${asset.width}×${asset.height} → ${r.width}×${r.height}，${(asset.bytes.length / 1048576).toFixed(1)}MB → ${(r.bytes.length / 1048576).toFixed(2)}MB` });
      }
    }
  }
  return {
    math: await resolveMap(mathAssets),
    images,
    mermaid: await resolveMap(mermaidAssets),
    warnings,
  };
}

// ------------------------------------------------------------
// 3) IR → docx
// ------------------------------------------------------------
export function convertIrToDocx(ir, options = {}) {
  const { doc } = ir;
  const profile = options.profile || buildStyleProfile(options.style || 'zh');
  const assets = options.assets || { math: new Map(), images: new Map(), mermaid: new Map() };
  const warnings = [...(ir.warnings || []), ...(assets.warnings || [])];
  const { labelToNum } = annotateIr(doc);

  let listItemIndex = 0; // 每个 bullet 列表一个 instance
  const orderedRefs = []; // {reference, start}
  let orderedSeq = 0;

  // ---------- 行内 ----------
  function inlineRuns(nodes, ctx = {}) {
    const out = [];
    for (const n of nodes || []) {
      switch (n.type) {
        case 'text': {
          if (!n.text) break;
          out.push(new TextRun({
            text: n.text,
            bold: n.bold || ctx.bold, italics: n.italics || ctx.italics, strike: n.strike || ctx.strike,
          }));
          break;
        }
        case 'inline_code': {
          out.push(new TextRun({ text: n.text, style: 'WMInlineCode', bold: n.bold, italics: n.italics }));
          break;
        }
        case 'strong': {
          out.push(...inlineRuns(n.children, { ...ctx, bold: true }));
          break;
        }
        case 'hard_break': out.push(new TextRun({ break: 1 })); break;
        case 'soft_break': out.push(new TextRun({ break: 1 })); break; // 视觉换行策略（同原版 visual-break）
        case 'link': {
          const safeHref = /^(https?:|mailto:|#|\.\/|\/)/i.test(n.href) ? n.href : '';
          if (!safeHref) { out.push(...inlineRuns(n.children, ctx)); break; }
          const children = n.children?.length ? inlineRuns(n.children, ctx) : [new TextRun({ text: n.href })];
          out.push(new ExternalHyperlink({ link: safeHref, children: children.map((r) => withHyperlinkStyle(r)) }));
          break;
        }
        case 'image': {
          const img = emitImage(n);
          if (img) out.push(img);
          else if (n.src) out.push(new TextRun({ text: `[图片：${n.alt || n.src}]`, italics: true, color: '888888' }));
          break;
        }
        case 'math_inline': {
          const m = emitMath(n);
          if (m) out.push(m);
          else out.push(mathFallback(n));
          break;
        }
        case 'footnote_ref': {
          const num = labelToNum.get(n.label);
          if (num) out.push(...refCitationRuns(num));
          else out.push(new TextRun({ text: `[^${n.label}]` }));
          break;
        }
        default: break;
      }
    }
    return out;
  }

  function withHyperlinkStyle(r) {
    try { return r; } finally { /* Hyperlink 样式由样式表定义；docx 的 ExternalHyperlink 已包装 */ }
  }

  function mathFallback(n) {
    const t = n.source || '[公式]';
    return new TextRun({ text: t, italics: true });
  }

  function emitMath(n) {
    const asset = assets.math.get(n.__id);
    if (!asset || !asset.omml) {
      if (asset?.warnings?.length) warnings.push(...asset.warnings.map((w) => ({ ...w, source: n.source?.slice(0, 30) })));
      else warnings.push({ code: n.type === 'math_block' ? 'blockMathFallback' : 'inlineMathFallback', message: `公式降级为文本：${n.source?.slice(0, 40)}` });
      return null;
    }
    try {
      return ImportedXmlComponent.fromXmlString(asset.omml);
    } catch (e) {
      warnings.push({ code: 'mathXmlImportFailed', message: String(e.message || e).slice(0, 80) });
      return null;
    }
  }

  // 脚注引用：REF 域（begin/instr/separate/result/end 五段 run，上标）
  function refCitationRuns(num) {
    const rpr = '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>';
    const mk = (inner) => ImportedXmlComponent.fromXmlString(`<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${rpr}${inner}</w:r>`);
    return [
      mk('<w:fldChar w:fldCharType="begin"/>'),
      mk(`<w:instrText xml:space="preserve"> REF mdref_${num} \\h \\* MERGEFORMAT </w:instrText>`),
      mk('<w:fldChar w:fldCharType="separate"/>'),
      mk(`<w:t>[${num}]</w:t>`),
      mk('<w:fldChar w:fldCharType="end"/>'),
    ];
  }

  function emitImage(n) {
    const asset = assets.images.get(n.src ?? n.image?.src);
    if (!asset || asset.error || !asset.bytes) {
      const reason = describeImageFailure(asset) || '未加载';
      warnings.push({ code: 'imageUnavailable', src: n.src ?? n.image?.src, reason, message: `图片未嵌入（${reason}）：${String(n.src ?? n.image?.src).slice(0, 60)}` });
      return null;
    }
    const shrink = asset.reencoded || false;
    if (!shrink) {
      const mimeToType = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' };
      const type = mimeToType[asset.mime];
      if (!type) return null;
      const size = capSize(asset.width, asset.height, MAX_IMAGE_WIDTH);
      return new ImageRun({
        type,
        data: asset.bytes,
        transformation: size,
        altText: { title: n.alt || 'image', description: n.alt || '', name: n.alt || 'image' },
      });
    }
    return new ImageRun({
      type: 'jpg',
      data: shrink.bytes,
      transformation: capSize(shrink.width, shrink.height, MAX_IMAGE_WIDTH),
      altText: { title: n.alt || 'image', description: n.alt || '', name: n.alt || 'image' },
    });
  }

  // 失败可读占位图框：文字化信息框（alt + URL + 原因）
  function imageFallbackBox(image) {
    const label = image.alt || '图片';
    const url = String(image.src || '').replace(/^https?:\/\//, '');
    return new Table({
      alignment: AlignmentType.CENTER,
      width: { size: 92, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: 'C8CDD4' },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C8CDD4' },
        left: { style: BorderStyle.SINGLE, size: 4, color: 'C8CDD4' },
        right: { style: BorderStyle.SINGLE, size: 4, color: 'C8CDD4' },
        insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      },
      rows: [new TableRow({
        children: [new TableCell({
          margins: { top: 120, bottom: 120, left: 160, right: 160 },
          children: [
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: `▲ 图片未嵌入：${label}`, bold: true, color: '8B949E' })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: url.slice(0, 110), size: 18, color: '6E7781' })] }),
          ],
        })],
      })],
    });
  }

  // ---------- 代码块（盒装拼边 + 逐 token 着色）----------
  function codeBlockParagraphs(node) {
    const { spans } = highlightLines(node);
    return node.lines.map((line, idx) => {
      const first = idx === 0, last = idx === node.lines.length - 1;
      const border = (side) => {
        if ((side === 'top' && first) || (side === 'bottom' && last)) {
          return { style: BorderStyle.SINGLE, size: 4, color: CODE_BORDER, space: 4 };
        }
        return side === 'top' || side === 'bottom' ? { style: BorderStyle.NIL } : { style: BorderStyle.SINGLE, size: 4, color: CODE_BORDER, space: 4 };
      };
      const tokens = (spans[idx] || []).length ? (spans[idx] || []) : [{ text: line || ' ', className: null }];
      const runs = tokens.filter((t) => t.text).map((t) => new TextRun({
        text: t.text || ' ',
        color: tokenColor(t.className) || undefined,
        bold: tokenEmphasis(t.className).bold || undefined,
        italics: tokenEmphasis(t.className).italics || undefined,
      }));
      if (!runs.length) runs.push(new TextRun({ text: ' ' }));
      return new Paragraph({
        style: 'WMCodeBlock',
        shading: { type: ShadingType.CLEAR, fill: CODE_BG },
        spacing: { line: 280, before: 0, after: 0 },
        border: { top: border('top'), bottom: border('bottom'), left: border('left'), right: border('right') },
        children: runs,
      });
    });
  }

  function highlightLines(node) {
    const code = node.lines.join('\n');
    const result = highlightToTokens(code, node.lang);
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
    return { spans: lines };
  }

  // ---------- 表格 ----------
  function emitTable(node) {
    const cfg = profile.table || { mode: 'grid' };
    const isThreeLine = cfg.mode === 'three-line';
    const border = (sz, color = CODE_BORDER) => ({ style: BorderStyle.SINGLE, size: sz, color });
    const nil = { style: BorderStyle.NIL };
    const borders = isThreeLine
      ? { top: border(12, '000000'), bottom: border(12, '000000'), left: nil, right: nil, insideHorizontal: nil, insideVertical: nil }
      : { top: border(4), bottom: border(4), left: border(4), right: border(4), insideHorizontal: border(4), insideVertical: border(4) };
    const cellSize = cfg.cellSize; // en 预设 22
    const mkCell = (cell, isHeader, isFirstCol, rowIdx) => {
      const align = cell.align === 'left' || cell.align === 'center' || cell.align === 'right'
        ? { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT }[cell.align]
        : (isHeader || !isFirstCol ? AlignmentType.CENTER : AlignmentType.LEFT);
      const runCtx = isHeader ? { bold: cfg.headerBold } : {};
      const children = inlineRuns(cell.children || [], runCtx).map((r) => r);
      const para = new Paragraph({
        alignment: align,
        spacing: { before: 20, after: 20 },
        children: children.length ? children : [new TextRun({ text: ' ' })],
      });
      const margins = cfg.cellMargin || { top: 80, bottom: 80, left: 120, right: 120 };
      return new TableCell({
        children: [para],
        columnSpan: cell.colspan > 1 ? cell.colspan : undefined,
        rowSpan: cell.rowspan > 1 ? cell.rowspan : undefined,
        verticalAlign: VerticalAlign.CENTER,
        margins,
        ...(isHeader && isThreeLine ? { borders: { bottom: { style: BorderStyle.SINGLE, size: cfg.headerBottomSz || 6, color: '000000' } } } : {}),
      });
    };
    const rows = [];
    if (node.header) {
      rows.push(new TableRow({
        tableHeader: true,
        children: node.header.map((c, i) => mkCell(c, true, i === 0, 0)),
      }));
    }
    (node.rows || []).forEach((cells, r) => {
      rows.push(new TableRow({ children: cells.map((c, i) => mkCell(c, false, i === 0, r)) }));
    });
    return new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.AUTOFIT,
      borders,
    });
  }

  // ---------- 块级 ----------
  function emitBlocks(nodes, out, ctx = { inQuote: false, listDepth: -1, style: null }) {
    for (const n of nodes) {
      switch (n.type) {
        case 'heading': {
          const depth = Math.min(6, Math.max(1, n.depth));
          out.push(new Paragraph({ style: `Heading${depth}`, children: headingRunsClean(inlineRuns(n.children)) }));
          break;
        }
        case 'paragraph': {
          const opts = { children: inlineRuns(n.children) };
          if (ctx.style) opts.style = ctx.style;
          if (!opts.style) opts.style = 'Normal';
          if (ctx.listDepth >= 0) { opts.style = 'ListParagraph'; }
          out.push(new Paragraph(opts));
          break;
        }
        case 'code_block': out.push(...codeBlockParagraphs(n)); break;
        case 'blockquote': {
          emitBlocks(n.children, out, { ...ctx, style: 'WMQuote', inQuote: true });
          break;
        }
        case 'bullet_list': case 'ordered_list': {
          const ordered = n.type === 'ordered_list';
          const reference = ordered ? `md-ord-${orderedSeq++}` : 'md-bullet';
          if (ordered) orderedRefs.push({ reference, start: n.start || 1 });
          const instance = ordered ? 0 : listItemIndex++;
          emitList(n, out, ctx, reference, instance, ordered, 0);
          break;
        }
        case 'table': out.push(emitTable(n)); out.push(new Paragraph({ text: '', spacing: { after: 60 } })); break;
        case 'thematic_break': out.push(new Paragraph({ thematicBreak: true })); break;
        case 'math_block': {
          const m = emitMath(n);
          if (m) out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 80, after: 160 }, children: [m] }));
          else out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 80, after: 160 }, children: [mathFallback(n)] }));
          break;
        }
        case 'mermaid': {
          const asset = assets.mermaid.get(n.__id);
          if (asset && asset.png) {
            const size = capSize(asset.width, asset.height, MAX_IMAGE_WIDTH);
            out.push(new Paragraph({
              alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 },
              children: [new ImageRun({ type: 'png', data: asset.png, transformation: size, altText: { title: 'Mermaid diagram', description: 'Mermaid diagram', name: 'mermaid' } })],
            }));
          } else {
            out.push(...codeBlockParagraphs({ lang: 'mermaid', lines: n.source.replace(/\n$/, '').split('\n') }));
          }
          break;
        }
        case 'figure': {
          const img = emitImage(n.image);
          if (img) {
            out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 }, children: [img] }));
            if (n.image.alt) out.push(new Paragraph({ style: 'Caption', children: [new TextRun({ text: n.image.alt })] }));
          } else {
            // B1：不再安静丢失 —— 占位图框（文档结构可见，交档可对账）
            out.push(imageFallbackBox(n.image));
          }
          break;
        }
        case 'html_block': {
          const text = (n.html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          out.push(new Paragraph({ style: 'Normal', children: [new TextRun({ text: text || n.html.slice(0, 100) })] }));
          break;
        }
        default: break;
      }
    }
  }

  function headingRunsClean(runs) { return runs; }

  function emitList(listNode, out, ctx, reference, instance, ordered, level) {
    for (const item of listNode.items || []) {
      let first = true;
      for (const block of item.blocks || []) {
        if (block.type === 'paragraph') {
          out.push(new Paragraph({
            style: 'ListParagraph',
            numbering: { reference, level: Math.min(level, 5), instance },
            children: inlineRuns(block.children),
          }));
        } else if (block.type === 'bullet_list' || block.type === 'ordered_list') {
          // 嵌套列表：ordered 重开 reference，bullet 共用
          const ord = block.type === 'ordered_list';
          const ref2 = ord ? `md-ord-${orderedSeq++}` : 'md-bullet';
          if (ord) orderedRefs.push({ reference: ref2, start: block.start || 1 });
          const inst2 = ord ? 0 : listItemIndex++;
          emitList(block, out, ctx, ref2, inst2, ord, level + 1);
        } else {
          // 列表项内的块级元素（代码块/公式/表格）
          emitBlocks([block], out, { ...ctx, listDepth: level });
        }
        first = false;
      }
      if (!item.blocks || !item.blocks.length) {
        out.push(new Paragraph({ style: 'ListParagraph', numbering: { reference, level: Math.min(level, 5), instance }, children: [new TextRun('')] }));
      }
    }
  }

  // ---------- 文档组装 ----------
  const children = [];
  emitBlocks(doc.children, children);

  // 脚注/参考文献（正文流，对应原版 WMReferenceItem）
  if ((doc.footnotes || []).length) {
    children.push(new Paragraph({ style: 'Normal', spacing: { before: 240 }, children: [] }));
    for (const def of doc.footnotes) {
      const num = def.__num || 0;
      const bookmark = new Bookmark({ id: `mdref_${num}`, children: [new TextRun({ text: `[${num}]` })] });
      children.push(new Paragraph({
        style: 'WMReferenceItem',
        children: [bookmark, new TextRun({ children: [new Tab()] }), ...inlineRuns(def.children)],
      }));
    }
  }

  // numbering 配置：profile 基础 + 每个有序列表的 start
  const numbering = deepCloneNumbering(profile.numbering);
  const ordBase = numbering.config.find((c) => c.reference === 'md-ordered');
  for (const { reference, start } of orderedRefs) {
    const cfg = JSON.parse(JSON.stringify(ordBase));
    cfg.reference = reference;
    cfg.levels[0].start = start;
    numbering.config.push(cfg);
  }
  numbering.config = numbering.config.filter((c) => c.reference !== 'md-ordered');

  const document = new Document({
    title: options.title || 'md2word document',
    creator: options.creator || 'md2word',
    description: '',
    styles: profile.styles,
    numbering,
    sections: [{ children }],
  });
  return { document, warnings };
}

function deepCloneNumbering(n) {
  return JSON.parse(JSON.stringify(n));
}

// ------------------------------------------------------------
// 4) 顶层 API
// ------------------------------------------------------------
export async function exportMarkdownToDocx(markdown, options = {}) {
  const { preprocessMarkdown } = await import('./preprocess.mjs');
  const { markdownToIr } = await import('./parser.mjs');
  const src = preprocessMarkdown(markdown);
  const ir = markdownToIr(src);
  const assets = await prepareAssets(ir.doc, options);
  const profile = buildStyleProfile(options.style || 'zh');
  const { document, warnings } = convertIrToDocx(ir, { ...options, assets, profile });
  const buffer = await packDocument(document);
  const post = await postProcessDocx(buffer);
  return { buffer: post, warnings, ir };
}

// ------------------------------------------------------------
// 5) ZIP 后处理（jszip）
// ------------------------------------------------------------
import JSZip from 'jszip';

const MATH_PR =
  '<m:mathPr><m:mathFont m:val="Cambria Math"/><m:brkBin m:val="before"/>' +
  '<m:brkBinSub m:val="--"/><m:smallFrac m:val="0"/><m:dispDef/>' +
  '<m:lMargin m:val="0"/><m:rMargin m:val="0"/><m:defJc m:val="centerGroup"/>' +
  '<m:wrapIndent m:val="1440"/><m:intLim m:val="subSup"/><m:naryLim m:val="undOvr"/></m:mathPr>';

async function packDocument(document) {
  if (typeof window !== 'undefined' && typeof Blob !== 'undefined') {
    const blob = await Packer.toBlob(document);
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(await Packer.toBuffer(document));
}

async function postProcessDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  // 1) word/document.xml：剥离 ImportedXmlComponent 包装标记
  const docFile = zip.file('word/document.xml');
  if (docFile && !docFile.async) return buffer;
  let docXml = await docFile.async('string');
  if (docXml.includes('<undefined>')) {
    docXml = docXml.replaceAll('<undefined>', '').replaceAll('</undefined>', '');
  }
  zip.file('word/document.xml', docXml);

  // 2) word/settings.xml：注入 m:mathPr（Word 公式默认变正体 Cambria Math）
  const settingsFile = zip.file('word/settings.xml');
  if (settingsFile) {
    let s = await settingsFile.async('string');
    if (!s.includes('<m:mathPr>')) {
      // 插在 </w:settings> 之前，w: 命名空间需已声明（docx 默认声明 m:）
      s = s.replace('</w:settings>', MATH_PR + '</w:settings>');
    }
    zip.file('word/settings.xml', s);
  }

  const out = await zip.generateAsync({
    type: 'uint8array', // Node/浏览器通吃（nodebuffer 浏览器端不存在）
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return out;
}
