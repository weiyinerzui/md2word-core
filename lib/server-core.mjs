// ============================================================
// md2word — 本地服务内核（静态托管 + 同源图片代理）
// 被两种形态共用：
//   · web/server.mjs （开发：从 web/dist 读文件）
//   · pack/entry.mjs （SEA 单文件：从内嵌资源读）
// 资源来源通过注入的 resolveAsset(pathname) 解耦。
// ============================================================
import { createServer } from 'node:http';

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

export function extType(p) {
  const i = String(p).lastIndexOf('.');
  return MIME[i >= 0 ? String(p).slice(i).toLowerCase() : ''] || 'application/octet-stream';
}

// ---------- /img?url= 同源代理（含 SSRF 防护）----------
const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./, /^172\.(1[6-9]|2\d|3[01])\./];
const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|metadata\..*)$/i;
const MAX_BYTES = 26 * 1024 * 1024;

export function safeImageUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return null; }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const h = parsed.hostname;
  if (BLOCKED_HOST.test(h) || h.includes('::') || PRIVATE_V4.some((r) => r.test(h))) return null;
  return parsed;
}

async function proxyImage(res, raw) {
  const u = safeImageUrl(raw);
  if (!u) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('bad url'); }
  try {
    const upstream = await fetch(u, {
      headers: { 'user-agent': 'md2word/1 (+local image proxy)', accept: 'image/*,*/*' },
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
      'access-control-allow-origin': '*',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('proxy error: ' + String((e && e.message) || e).slice(0, 120));
  }
}

/**
 * 创建 md2word 本地服务（未 listen —— 由调用方决定端口）。
 * @param {object} o
 * @param {(pathname:string)=>Promise<{data:Uint8Array,type:string}|null>} o.resolveAsset 资源解析（注入）
 * @returns {import('node:http').Server}
 */
export function createMd2wordServer({ resolveAsset }) {
  return createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { res.writeHead(400); return res.end(); }
    const target = url.searchParams.get('u') || url.searchParams.get('url');
    if (target) return proxyImage(res, target);

    let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    try { pathname = decodeURIComponent(pathname); } catch { /* 保留原样 */ }
    const asset = await resolveAsset(pathname);
    if (!asset) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' });
    res.end(Buffer.from(asset.data));
  });
}

/** 在 127.0.0.1 上监听，端口被占用时自动 +1 重试（默认最多 20 次） */
export function listenOnFreePort(server, { host = '127.0.0.1', startPort = 5173, tries = 20 } = {}) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const attempt = () => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && tries-- > 0) { port++; setTimeout(attempt, 60); return; }
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, host, () => { server.removeListener('error', onError); resolve(port); });
    };
    attempt();
  });
}

/** 打开系统默认浏览器（跨平台） */
export async function openBrowser(url) {
  const { spawn } = await import('node:child_process');
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}
