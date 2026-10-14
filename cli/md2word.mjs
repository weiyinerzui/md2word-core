#!/usr/bin/env node
// ============================================================
// md2word — 命令行入口（源码运行）
//   node cli/md2word.mjs input.md -o output.docx [--style zh|en|default]
//   node cli/md2word.mjs input.md --html out.html
// 实现见 lib/cli.mjs（与打包版 pack/entry.mjs 共用同一份逻辑）
// ============================================================
import { runCli } from '../lib/cli.mjs';

process.exitCode = await runCli(process.argv.slice(2));
