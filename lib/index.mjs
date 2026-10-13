// ============================================================
// md2word — 公共 API（CLI 与浏览器共用同一转换内核）
// 两条链路对应原产品行为：
//   复制为 Word（富 HTML 剪贴板） / 导出为 Word 文件（DOCX）
// ============================================================
export { preprocessMarkdown, canonicalizeMathDelimiters } from './preprocess.mjs';
export { createMarkdown, markdownToIr, extractFootnotes, parseHtmlTable } from './parser.mjs';
export { renderMathToMathml, canonicalizeMathml, buildMathAsset, wrapOmathPara, wrapMatrixDelimiters } from './math.mjs';
export { buildStyleProfile, STYLE_PRESETS } from './styles.mjs';
export { exportMarkdownToDocx, convertIrToDocx, prepareAssets, annotateIr } from './emitter-docx.mjs';
export { buildWordClipboardHtml } from './emitter-html.mjs';
export { highlightToTokens, tokenColor } from './highlight.mjs';
export { renderPreviewHtml } from './preview.mjs';

/** 解析入口：md 源 → { ir, warnings } */
import { preprocessMarkdown } from './preprocess.mjs';
import { markdownToIr } from './parser.mjs';
export function parseMarkdown(markdown) {
  return markdownToIr(preprocessMarkdown(markdown));
}
