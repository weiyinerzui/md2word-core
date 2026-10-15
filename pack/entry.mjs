#!/usr/bin/env node
// ============================================================
// md2word — 打包入口（Node SEA / 单文件可执行）
//
// 行为分流：
//   · 带参数（如 input.md -o out.docx）→ CLI：转 Markdown 为 .docx / .html
//   · 无参数（双击）                  → 本地 Web 应用：起服务 + 自动开浏览器
//
// 注意：SEA 的 blob 必须是 CommonJS，因此本文件用 CJS 写法，
// 动态 import() 加载 ESM 内核（打包时由 esbuild 转为内联）。
// 资源（web/dist）以 SEA assets 内嵌，见 pack/sea-config.json。
// ============================================================
'use strict';

function readSeaAsset(name) {
  // 打包环境：从 SEA blob 读；源码环境：从磁盘读（便于本地调试）
  try {
    const sea = require('node:sea');
    if (sea && typeof sea.getAsset === 'function') {
      try {
        const buf = sea.getAsset(name);          // Node 20.12+：返回 ArrayBuffer
        return buf ? new Uint8Array(buf) : null;
      } catch {
        try { return new Uint8Array(sea.getRawAsset(name)); } catch { return null; }
      }
    }
  } catch { /* 非 SEA 环境 */ }
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    return new Uint8Array(fs.readFileSync(path.join(__dirname, 'web', 'dist', name)));
  } catch { return null; }
}

async function startWeb() {
  const { createMd2wordServer, listenOnFreePort, openBrowser, extType } = await import('../lib/server-core.mjs');
  const { existsSync, readFileSync } = await import('node:fs');
  const path = await import('node:path');

  // 资源解析：SEA 内嵌优先；否则回退到随 exe 同目录的 web/dist
  const cache = new Map();
  const fromSea = (name) => {
    if (cache.has(name)) return cache.get(name);
    let data = readSeaAsset(name);
    let type = extType(name);
    if (!data) {
      const disk = path.join(__dirname, 'web', 'dist', name);
      if (existsSync(disk)) data = new Uint8Array(readFileSync(disk));
    }
    if (!data && !name.includes('.')) {
      // 无扩展名路径（如 /sample）→ 试 .md
      const alt = name + '.md';
      if (existsSync(path.join(__dirname, 'web', 'dist', alt))) {
        data = new Uint8Array(readFileSync(path.join(__dirname, 'web', 'dist', alt)));
        type = extType(alt);
      }
    }
    const v = data ? { data, type } : null;
    cache.set(name, v);
    return v;
  };

  async function resolveAsset(pathname) {
    if (pathname === '/sample.md') return fromSea('sample.md');
    return fromSea(pathname.replace(/^\//, ''));
  }

  const server = createMd2wordServer({ resolveAsset });
  const port = await listenOnFreePort(server, { startPort: 5173 });
  const url = `http://127.0.0.1:${port}`;
  process.stdout.write(`\n  md2word 已启动 →  ${url}\n  关闭此窗口即退出应用。\n\n`);
  const opened = await openBrowser(url);
  if (!opened) process.stdout.write(`  （未能自动打开浏览器，请手动访问 ${url}）\n\n`);
}

(async () => {
  const argv = process.argv.slice(2);
  // 无参数（含双击）→ 本地 Web；有参数 → CLI
  const noArgs = argv.length === 0;
  try {
    if (noArgs) await startWeb();
    else {
      const { runCli } = await import('../lib/cli.mjs');
      process.exitCode = await runCli(argv);
    }
  } catch (e) {
    console.error('运行出错：', e && e.stack || e);
    process.exit(1);
  }
})();
