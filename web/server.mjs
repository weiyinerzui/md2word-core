#!/usr/bin/env node
// ============================================================
// md2word — 本地静态托管 + 同源图片代理（web/server.mjs）
//   npm start   （等价 node web/server.mjs）
//
// 为什么存在：浏览器导出 .docx 时需把外链图字节嵌入文档，
// 但多数图床（如 telegraph/pages.dev）不返回 Access-Control-Allow-Origin，
// 浏览器 fetch 被 CORS 拦截。经本服务 /img 反代即同源请求，绕开限制。
// 纯静态跑 web/dist 依然可用 —— 只是外链图导出降级为占位框并给出原因。
// ============================================================
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { existsSync } from 'node:fs';
// 运行位置：web/（dist 邻位）或直接部署的 dist/ 内
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = existsSync(join(HERE, 'dist')) ? join(HERE, 'dist') : HERE;
const PORT = Number(process.env.PORT || 5173);

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(DIST, p));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  try {
    const st = await stat(file);
    const isDir = st.isDirectory();
    const target = isDir ? join(file, 'index.html') : file;
    const data = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 — 请先执行 npm run build:web');
  }
}

// ---------- /img?url= 同源代理（含 SSRF 防护）----------
const PRIVATE_V4 = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];
const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|metadata\..*)$/i;

function safeImageUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return null; }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const h = parsed.hostname;
  if (BLOCKED_HOST.test(h) || h.includes('::') || PRIVATE_V4.some((r) => r.test(h))) return null;
  return parsed;
}

const MAX_BYTES = 26 * 1024 * 1024;

async function proxyImage(req, res, raw) {
  const u = safeImageUrl(raw);
  if (!u) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('bad url'); }
  try {
    const upstream = await fetch(u, {
      headers: { 'user-agent': 'md2word-server/1 (+local image proxy)', accept: 'image/*,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok) {
      // 透传上游状态码（浏览器端据 res.status 归类 404/403/5xx），网络异常仍为 502
      const code = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`upstream ${upstream.status}`);
    }
    const len = Number(upstream.headers.get('content-length') || 0);
    if (len > MAX_BYTES) { res.writeHead(413); return res.end('too large'); }
    const type = (upstream.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    if (!/^image\//i.test(type)) { res.writeHead(415); return res.end('not an image'); }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) { res.writeHead(413); return res.end('too large'); }
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(buf.length),
      'cache-control': 'public, max-age=3600',
      // 同源回源不需要 ACAO；给上是为了静态部署时也能复用（无害）
      'access-control-allow-origin': '*',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('proxy error: ' + String(e && e.message || e).slice(0, 120));
  }
}

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const q = url.searchParams;
  const target = q.get('u') || q.get('url');
  if (target) return proxyImage(req, res, target);
  return serveStatic(req, res, url.pathname);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`md2word web →  http://127.0.0.1:${PORT}   （dist: ${DIST}）`);
  console.log(`  图片代理   →  /img?url=<外链>   （外链图可直接嵌入导出的 .docx）`);
});
