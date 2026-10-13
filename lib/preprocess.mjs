// ============================================================
// md2word — 源预处理（确定性、语法保留）
// 行为参照：WordMarker markdown-source-preprocessor
//   1. 去 BOM          2. CRLF/CR → LF
//   3. 数学定界符规范化 \( \) → $ $、\[ \] → $$ $$（代码保护）
// ============================================================

/** 把文本切成「可见区段 / 保护代码」交替片段 */
function splitProtectedRegions(src) {
  const regions = [];
  // 围栏代码块（``` / ~~~）
  const fence = /(^|\n)([ \t]*)(```+|~~~+)[^\n]*(\n[\s\S]*?)(?:\n[ \t*\-]*```+|\n[ \t]*~~~+|$)/g;
  // 行内代码（含跨行，保守处理单/多反引号对）
  const codeSpan = /(`+)([\s\S]*?)\1/g;
  // 逐块扫描：先扫围栏，围栏之间的内容扫行内代码
  let pos = 0;
  const push = (text, isProtected) => {
    if (text) regions.push({ text, protected: !!isProtected });
  };
  let m;
  const fenceMarks = [];
  while ((m = fence.exec(src))) fenceMarks.push({ start: m.index, end: m.index + m[0].length });
  for (const f of fenceMarks) {
    // 前面区域里的行内代码也保护
    const between = src.slice(pos, f.start);
    let last = 0, cm;
    codeSpan.lastIndex = 0;
    while ((cm = codeSpan.exec(between))) {
      push(between.slice(last, cm.index), false);
      push(cm[0], true);
      last = cm.index + cm[0].length;
    }
    push(between.slice(last), false);
    push(fence.start >= pos ? src.slice(f.start, f.end) : '', true);
    pos = f.end;
  }
  const tail = src.slice(pos);
  let last = 0, cm;
  while ((cm = codeSpan.exec(tail))) {
    push(tail.slice(last, cm.index), false);
    push(cm[0], true);
    last = cm.index + cm[0].length;
  }
  push(tail.slice(last), false);
  return regions;
}

/** \[...\] → $$...$$、\(...\) → $...$（仅在未保护区段内改写） */
export function canonicalizeMathDelimiters(src) {
  if (!/\\\(|\\\[/.test(src)) return src;
  const regions = splitProtectedRegions(src);
  return regions
    .map((r) => {
      if (r.protected) return r.text;
      // 块级：\[
      let t = r.text.replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => `\n$$${body}$$\n`);
      // 行内：\( ... \)
      t = t.replace(/\\\(([\s\S]*?)\\\)/g, (_, body) => `$${body}$`);
      return t;
    })
    .join('');
}

export function preprocessMarkdown(src) {
  let s = src;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n?/g, '\n');
  s = canonicalizeMathDelimiters(s);
  return s;
}
