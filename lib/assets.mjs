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
      if (!fetchFn) return { error: 'external', src };
      const res = await fetchFn(src);
      if (!res.ok) return { error: 'external', src };
      const buf = new Uint8Array(await res.arrayBuffer());
      const mime = res.headers.get('content-type') || sniffMime(buf);
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(mime)) return { error: 'unsupported', mime };
      const dim = imageSize(buf, mime);
      return { bytes: buf, mime, ...dim };
    }
    if (opts.readFile) {
      const buf = await opts.readFile(src);
      const mime = sniffMime(buf);
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(mime)) return { error: 'unsupported', mime };
      const dim = imageSize(buf, mime);
      return { bytes: buf, mime, ...dim };
    }
    return { error: 'external', src };
  } catch (e) {
    return { error: 'external', src, detail: String(e) };
  }
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
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
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
  const { svg } = await mermaid.render(`mmd-${key}`, source);
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
