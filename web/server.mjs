#!/usr/bin/env node
// ============================================================
// md2word — 本地静态托管 + 同源图片代理（开发/源码运行）
//   npm start   （等价 node web/server.mjs）
//
// 为什么存在：浏览器导出 .docx 时需把外链图字节嵌入文档，
// 但多数图床（如 telegraph/pages.dev）不返回 Access-Control-Allow-Origin，
// 浏览器 fetch 被 CORS 拦截。经本服务 /img 反代即同源请求，绕开限制。
// 纯静态跑 web/dist 依然可用 —— 只是外链图导出降级为占位框并给出原因。
//
// 打包版（单文件 exe）用同一内核，但资源来自内嵌（见 pack/entry.mjs）。
// ============================================================
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { createMd2wordServer, listenOnFreePort, openBrowser, extType } from '../lib/server-core.mjs';

// 运行位置：web/（dist 邻位）或直接部署的 dist/ 内
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = existsSync(join(HERE, 'dist')) ? join(HERE, 'dist') : HERE;
const START_PORT = Number(process.env.PORT || 5173);

async function resolveAsset(pathname) {
  const p = normalize(join(DIST, pathname));
  if (!p.startsWith(DIST)) return null;
  try {
    const data = await readFile(p);
    return { data, type: extType(pathname) };
  } catch {
    // 目录回退到 index.html
    try {
      const data = await readFile(join(p, 'index.html'));
      return { data, type: 'text/html; charset=utf-8' };
    } catch { return null; }
  }
}

const server = createMd2wordServer({ resolveAsset });
const port = await listenOnFreePort(server, { startPort: START_PORT });
const url = `http://127.0.0.1:${port}`;
console.log(`md2word web →  ${url}   （dist: ${DIST}）`);
console.log(`  图片代理   →  /img?url=<外链>   （外链图可直接嵌入导出的 .docx）`);
if (process.argv.includes('--open')) openBrowser(url);
