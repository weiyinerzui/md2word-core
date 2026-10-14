// ============================================================
// md2word — CLI 实现（被 cli/md2word.mjs 与 pack/entry.mjs 共用）
// ============================================================
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const HELP = `md2word — AI Markdown → 规范 Word 文档（行为复刻 WordMarker v2.4.4，独立实现）

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
  图片（本地/dataURI/可 fetch 的 http）→ 居中 ≤540px`;

/**
 * 执行 CLI。
 * @param {string[]} argv 参数（不含 node 与脚本名）
 * @param {{ cwd?: string, log?: (...a:any[])=>void, onWarn?:(w:any[])=>void }} [io]
 * @returns {Promise<number>} 退出码
 */
export async function runCli(argv, io = {}) {
  const log = io.log || ((...a) => console.log(...a));
  const cwd = io.cwd || process.cwd();

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
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
  } catch (e) {
    log(`参数错误：${e.message}`);
    log(HELP);
    return 1;
  }

  const args = parsed.values;
  if (args.help) { log(HELP); return 0; }
  if (!parsed.positionals.length) { log(HELP); return 1; }

  const input = resolve(cwd, parsed.positionals[0]);
  if (!existsSync(input)) {
    log(`输入文件不存在: ${input}`);
    return 1;
  }
  const style = ['zh', 'en', 'default'].includes(args.style) ? args.style : 'zh';
  const md = await readFile(input, 'utf-8');
  const outDocx = args.output ? resolve(cwd, args.output) : input.replace(/\.md$/i, '') + '.docx';
  const title = args.title || basename(input).replace(/\.md$/i, '');

  const opts = {
    style,
    title,
    readFile: async (p) => new Uint8Array(await readFile(p)),
    fetchFn: (u) => (globalThis.fetch ? fetch(u) : Promise.reject(new Error('no fetch'))),
  };

  let warnings = [];
  if (args.html) {
    const { buildWordClipboardHtml } = await import('./emitter-html.mjs');
    const { parseMarkdown } = await import('./index.mjs');
    const ir = parseMarkdown(md);
    const result = await buildWordClipboardHtml(ir, { style, fetchFn: opts.fetchFn });
    warnings = result.warnings;
    writeFileSync(resolve(cwd, args.html), `<!DOCTYPE html>\n<meta charset="utf-8">\n${result.html}\n`, 'utf-8');
    if (!args.quiet) log(`✓ Word 剪贴板 HTML 写入 ${resolve(cwd, args.html)}`);
  }

  if (!args.html || args.output) {
    const { exportMarkdownToDocx } = await import('./emitter-docx.mjs');
    const { buffer, warnings: w } = await exportMarkdownToDocx(md, opts);
    warnings = [...warnings, ...w];
    await writeFile(outDocx, buffer);
    if (!args.quiet) log(`✓ ${outDocx}（${(buffer.length / 1024).toFixed(1)} KB，样式: ${style}）`);
  }

  if (warnings.length && !args.quiet) {
    log(`⚠ ${warnings.length} 条降级提示:`);
    const shown = new Set();
    for (const w of warnings) {
      const key = w.code + w.message;
      if (shown.has(key)) continue;
      shown.add(key);
      log(`  - [${w.code}] ${w.message}`);
    }
  }
  if (io.onWarn) io.onWarn(warnings);
  return 0;
}
