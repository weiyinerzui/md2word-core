// ============================================================
// md2word — 资产服务：图片（数据/尺寸/上限） + mermaid（浏览器栅格化）
// 行为参照：WordMarker document-asset-registry + mermaid-browser-rasterizer
//   尺寸上限 540px、PNG dataUri、mermaid scale=2、canvas 上限 12000
// ============================================================

export const MAX_IMAGE_WIDTH = 540;

/** dataURI / bytes → {bytes, mime, width, height} */
export async function loadImageAsset(src, opts = {}) {
  const { fetchFn = null } = opts;
  try {
    if (/^data:image\//i.test(src)) {
      const mime = /^data:([^;,]+)/.exec(src)[1];
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(mime)) {
        return { error: 'unsupported', mime };
      }
      const bytes = dataUriToBytes(src);
      const dim = imageSize(bytes, mime);
      return { bytes, mime, ...dim };
    }
    if (/^https?:\/\//i.test(src)) {
      if (!fetchFn) return { error: 'no-fetcher', src };
      let res;
      try {
        res = await fetchFn(src);
      } catch (e) {
        const msg = String(e && e.message || e);
        return { error: /cors|access-?control|ERR_FAILED|failed to fetch/i.test(msg) ? 'cors' : 'network', src, detail: msg };
      }
      if (!res.ok) return { error: res.status === 404 ? 'not-found' : res.status >= 500 ? 'server' : 'http-' + res.status, src };
      const buf = new Uint8Array(await res.arrayBuffer());
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim() || sniffMime(buf);
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(mime)) return { error: 'unsupported', mime, src };
      const dim = imageSize(buf, mime);
      return { bytes: buf, mime, ...dim };
    }
    if (opts.readFile) {
      const buf = await opts.readFile(src);
      const mime = sniffMime(buf);
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(mime)) return { error: 'unsupported', mime, src };
      const dim = imageSize(buf, mime);
      return { bytes: buf, mime, ...dim };
    }
    return { error: 'no-fetcher', src };
  } catch (e) {
    return { error: 'external', src, detail: String(e) };
  }
}

// 诊断学：错误码 → 人话
const FAIL_REASONS = {
  cors: '浏览器跨域限制（源站未返回 Access-Control-Allow-Origin）',
  'http-403': '源站拒绝访问（403，可能防盗链/Referer 校验）',
  network: '网络请求被拒绝/无法连接',
  'not-found': '远端 404',
  server: '远端服务器错误（5xx）',
  unsupported: '图片格式不支持（仅 PNG/JPEG/GIF/BMP 可嵌入）',
  'no-fetcher': '当前环境无图片抓取通道（纯静态模式下使用 npm start 或 CLI）',
  external: '外部图片获取失败',
};
export function describeImageFailure(asset) {
  return FAIL_REASONS[asset?.error] || `未知失败（${asset?.error}）`;
}

export function dataUriToBytes(uri) {
  const b64 = uri.split(',')[1] || '';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function sniffMime(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0x3c) return 'image/svg+xml';
  return 'application/octet-stream';
}

// 纯 JS 图像头解析（PNG/JPEG/GIF/BMP）——浏览器与 Node 一致
export function imageSize(b, mimeHint) {
  const v = (o, n = 1, le = false) => {
    let x = 0;
    for (let i = 0; i < n; i++) x += b[o + i] * 256 ** (le ? i : n - 1 - i);
    return x;
  };
  const m = mimeHint || sniffMime(b);
  try {
    if (m === 'image/png' && v(0, 4) === 0x89504e47) return { width: v(16, 4), height: v(20, 4) };
    if (m === 'image/gif') return { width: v(6, 2, true), height: v(8, 2, true) };
    if (m === 'image/bmp') return { width: v(18, 4, true), height: v(22, 4, true) };
    if (m === 'image/jpeg') {
      let o = 2;
      while (o < b.length) {
        if (b[o] !== 0xff) { o++; continue; }
        const marker = b[o + 1];
        const len = v(o + 2, 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: v(o + 7, 2), height: v(o + 5, 2) };
        }
        o += 2 + len;
      }
    }
  } catch { /* fallthrough */ }
  return { width: 320, height: 180 };
}

export function capSize(width, height, max = MAX_IMAGE_WIDTH) {
  const w = Number(width) || 320, h = Number(height) || 180;
  if (w <= max) return { width: w, height: h };
  return { width: max, height: Math.round((h * max) / w) };
}

// ------------------------------------------------------------
// Mermaid（仅浏览器）：SVG → PNG dataUri，缓存 FNV-1a hash
// ------------------------------------------------------------
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

let mermaidReady = null;
export async function ensureMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then((m) => {
      const mermaid = m.default;
      // htmlLabels:false：减少 foreignObject（边标签仍会留 → 用 deForeignSvg 兜底）
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', flowchart: { htmlLabels: false } });
      return mermaid;
    });
  }
  return mermaidReady;
}

export async function rasterizeMermaid(source, { scale = 2, maxCanvas = 12000 } = {}) {
  const cache = rasterizeMermaid._cache || (rasterizeMermaid._cache = new Map());
  const key = `${fnv1a(source)}:s${scale}`;
  if (cache.has(key)) return cache.get(key);
  const mermaid = await ensureMermaid();
  // ⚠ render id 不能含 CSS 选择器非法字符（如 : ）——冒号会导致 querySelector 抛错，图全灭
  const safeId = 'mmd-' + key.replace(/[^a-zA-Z0-9_-]/g, '');
  const { svg: raw } = await mermaid.render(safeId, source);
  // Chromium 对含 foreignObject 的 <img>SVG 判为 tainted canvas —— 替换为等位 <text> 后才能 toDataURL
  const svg = deForeignSvg(raw);
  const dim = svgSize(svg);
  let { width, height } = dim;
  let s = scale;
  while (width * s > maxCanvas || height * s > maxCanvas) s = Math.max(0.5, s - 0.5);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('svg decode failed'));
      im.src = url;
    });
    await (globalThis.document?.fonts?.ready || Promise.resolve());
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * s);
    canvas.height = Math.round(height * s);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUri = canvas.toDataURL('image/png');
    const out = { dataUri, width: Math.round(width), height: Math.round(height), png: dataUriToBytes(dataUri) };
    cache.set(key, out);
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function svgSize(svg) {
  const vb = /viewBox="([\d.\s,+-]+)"/.exec(svg);
  if (vb) {
    const n = vb[1].split(/[\s,]+/).map(Number);
    if (n.length === 4 && n[2] > 4 && n[3] > 4) return { width: n[2], height: n[3] };
  }
  const w = /width="([\d.]+)(?:px)?"/.exec(svg);
  const h = /height="([\d.]+)(?:px)?"/.exec(svg);
  if (w && h) return { width: parseFloat(w[1]), height: parseFloat(h[1]) };
  return { width: 800, height: 600 };
}


// ------------------------------------------------------------
// 图片重编码（决策③：默认开启；仅浏览器路径生效）
//   触发条件：字节 >1.5MB 或 边 >1080px；canvas 重采样并 JPEG 0.85
//   Node/CLI 无 DOM —— 传回 false，发射层仅给提示（保持原字节）
// ------------------------------------------------------------
export function reencodeImage(asset, { maxWidth = 1080, minBytes = 1572864, quality = 0.85 } = {}) {
  if (!asset || asset.error || !asset.bytes) return false;
  if (typeof document === 'undefined' || !globalThis.createImageBitmap) return false;
  if (asset.bytes.length <= minBytes && Math.max(asset.width || 0, asset.height || 0) <= maxWidth) return false;
  return createImageBitmap(new Blob([asset.bytes], { type: asset.mime }))
    .then(async (bmp) => {
      const scale = Math.min(1, maxWidth / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close?.();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (!blob) return false;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const url = canvas.toDataURL('image/jpeg', quality);
      void url;
      return { bytes, mime: 'image/jpeg', width: w, height: h };
    })
    .catch(() => false);
}


// ------------------------------------------------------------
// SVG 去污染：mermaid 的 foreignObject（html 标签/边标签）会让 Chromium
// 把 img 加载的 SVG 判为 tainted canvas，toDataURL 直接抛错。
// 这里把每个 foreignObject 原地替换为同位置的 <text>（多行 → tspan），
// 之后 canvas 读取即为 clean，可直接栅格化为 PNG。
// 仅在浏览器路径调用（DOMParser）；顺带剔除外部引用防其它污染源。
// ------------------------------------------------------------
export function deForeignSvg(svg) {
  if (typeof DOMParser === 'undefined' || !/<foreignObject/i.test(svg)) return svg;
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    for (const fo of Array.from(doc.getElementsByTagName('foreignObject'))) {
      const txt = (fo.textContent || '').replace(/\s+/g, ' ').trim();
      const num = (a) => parseFloat(fo.getAttribute(a) || '0') || 0;
      const [x, y, w, h] = [num('x'), num('y'), num('width'), num('height')];
      const NS = 'http://www.w3.org/2000/svg';
      const t = doc.createElementNS(NS, 'text');
      t.setAttribute('x', String(x + w / 2));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'middle');
      t.setAttribute('font-size', '14');
      t.setAttribute('font-family', '"Helvetica Neue", Helvetica, Arial, sans-serif');
      t.setAttribute('fill', '#333');
      const lines = txt.length ? [txt] : [''];
      if (lines.length === 1) {
        t.setAttribute('y', String(y + h / 2));
        t.textContent = lines[0];
      } else {
        const lh = 18;
        const y0 = y + h / 2;
        t.setAttribute('y', String(y0));
        lines.forEach((ln, i) => {
          const ts = doc.createElementNS(NS, 'tspan');
          ts.setAttribute('x', String(x + w / 2));
          ts.setAttribute('dy', i === 0 ? '0' : String(lh));
          ts.textContent = ln;
          t.appendChild(ts);
        });
      }
      fo.replaceWith(t);
    }
    // 其它污染源防御：外部链接改 data
    for (const img of Array.from(doc.getElementsByTagName('image'))) {
      const href = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
      if (/^https?:/i.test(href)) img.remove();
    }
    return new XMLSerializer().serializeToString(doc.documentElement);
  } catch {
    return svg;
  }
}
