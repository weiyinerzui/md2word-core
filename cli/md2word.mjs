#!/usr/bin/env node
// ============================================================
// md2word — 命令行
//   md2word input.md -o output.docx [--style zh|en|default]
//   md2word input.md --html out.html         只产出「复制为 Word」HTML
// ============================================================
import { writeFile, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const argv = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o' },
    style: { type: 'string', short: 's', default: 'zh' },
    html: { type: 'string' },
    title: { type: 'string', short: 't' },
    quiet: { type: 'boolean', short: 'q', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const args = argv.values;
if (args.help || !argv.positionals.length) {
  console.log(`md2word — AI Markdown → 规范 Word 文档（行为复刻 WordMarker v2.4.4，独立实现）

用法:
  md2word input.md -o output.docx [--style zh|en|default]
  md2word input.md --html out.html [--style zh]

样式:
  zh        中文论文（宋体+Times 小四 1.5 倍行距 首行缩进 2 字符 三线表）
  en        English Academic（Times 12pt, APA 风格）
  default   Word 默认（蓝色标题）

特性:
  $...$ / $$...$$ / \\(...\\) / \\[...\\] → Word 原生公式（OMML，可编辑）
  \\ce{} 化学式 (mhchem)、pmatrix/bmatrix 矩阵 → 原生 m:d 定界符
  代码块 → 等宽字体 + 盒装底纹 + 逐 token 语法高亮
  GFM 表格 + AI 输出的 HTML 表格（rowspan/colspan）
  [^脚注] → 参考文献列表 + 可跳转 REF 域
  图片（本地/dataURI/可 fetch 的 http）→ 居中 ≤540px`);
  process.exit(args.help ? 0 : 1);
}

const input = resolve(argv.positionals[0]);
if (!existsSync(input)) {
  console.error(`输入文件不存在: ${input}`);
  process.exit(1);
}
const style = ['zh', 'en', 'default'].includes(args.style) ? args.style : 'zh';
const md = await readFile(input, 'utf-8');
const outDocx = args.output ? resolve(args.output) : input.replace(/\.md$/i, '') + '.docx';
const title = args.title || basename(input).replace(/\.md$/i, '');

const opts = {
  style,
  title,
  readFile: async (p) => {
    const b = await readFile(p);
    return new Uint8Array(b);
  },
  fetchFn: (u) => (globalThis.fetch ? fetch(u) : Promise.reject(new Error('no fetch'))),
};

let warnings = [];
if (args.html) {
  const { buildWordClipboardHtml } = await import('../lib/emitter-html.mjs');
  const { parseMarkdown } = await import('../lib/index.mjs');
  const ir = parseMarkdown(md);
  const result = await buildWordClipboardHtml(ir, { style });
  warnings = result.warnings;
  writeFileSync(resolve(args.html), `<!DOCTYPE html>\n<meta charset="utf-8">\n${result.html}\n`, 'utf-8');
  if (!args.quiet) console.log(`✓ Word 剪贴板 HTML 写入 ${resolve(args.html)}`);
}

if (!args.html || args.output) {
  const { exportMarkdownToDocx } = await import('../lib/emitter-docx.mjs');
  const { buffer, warnings: w } = await exportMarkdownToDocx(md, opts);
  warnings = [...warnings, ...w];
  await writeFile(outDocx, buffer);
  if (!args.quiet) console.log(`✓ ${outDocx}（${(buffer.length / 1024).toFixed(1)} KB，样式: ${style}）`);
}

if (warnings.length && !args.quiet) {
  console.log(`⚠ ${warnings.length} 条降级提示:`);
  const shown = new Set();
  for (const w of warnings) {
    const key = w.code + w.message;
    if (shown.has(key)) continue;
    shown.add(key);
    console.log(`  - [${w.code}] ${w.message}`);
  }
}
