// ============================================================
// md2word web — 浏览器外壳（行为对应 WordMarker 自定义窗口壳：
//   左侧命令栏 + 双栏编辑/预览 + 底部状态）
//   转换内核与 CLI 共用同一套 lib/（行为一致性由架构保证）
// ============================================================
import { renderPreviewHtml, buildWordClipboardHtml, exportMarkdownToDocx } from '../lib/index.mjs';
import { preprocessMarkdown, markdownToIr } from '../lib/index.mjs';
import { rasterizeMermaid } from '../lib/assets.mjs';

const $ = (s) => document.querySelector(s);
const srcEl = $('#src'), pv = $('#pv-body'), toast = mkToast();
const styleSel = $('#style-preset');

// ── 状态 ───────────────────────────────
const state = { mermaidPngs: new Map(), lastHtml: '', seq: 0 };

function mkToast() {
  const el = document.createElement('div');
  el.id = 'toast';
  document.body.appendChild(el);
  return {
    show(msg, err = false) {
      el.textContent = msg;
      el.className = 'show' + (err ? ' err' : '');
      clearTimeout(mkToast._t);
      mkToast._t = setTimeout(() => (el.className = ''), 2400);
    },
  };
}

// ── 实时预览（防抖 160ms）────────────────
let timer = 0;
srcEl.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(refresh, 160);
});

async function refresh() {
  const md = srcEl.value;
  const { html, mermaid } = await renderPreviewHtml(md);
  pv.innerHTML = html;
  state.pendingMermaid = mermaid;
  stats();
  renderMermaidQueue(mermaid);
}

async function renderMermaidQueue(queue) {
  if (!queue?.length) return;
  let ok = 0;
  for (const { id, source } of queue) {
    try {
      const png = await rasterizeMermaid(source, { scale: 2 });
      const host = document.getElementById(id);
      if (host && png) {
        host.dataset.state = 'done';
        host.textContent = '';
        host.appendChild(Object.assign(document.createElement('img'), { src: png, alt: 'Mermaid' }));
        state.mermaidPngs.set(source, png);
        ok++;
      }
    } catch {
      const host = document.getElementById(id);
      if (host) host.dataset.state = 'failed';
    }
  }
  return ok;
}

function stats() {
  const v = srcEl.value;
  $('#stat-lines').textContent = `${v.split('\n').length} 行`;
  $('#stat-words').textContent = `${v.replace(/\s/g, '').length} 字`;
  try {
    const ir = markdownToIr(preprocessMarkdown(v));
    const w = ir.warnings || [];
    const el = $('#stat-warn');
    if (!w.length) { el.textContent = '✓ 无转换丢失'; el.className = 'ok'; }
    else {
      el.textContent = `⚠ ${w.length} 处降级`;
      el.title = w.map((x) => `[${x.code}] ${x.message}`).join('\n');
      el.className = 'bad';
    }
  } catch { /* 解析失败静默 */ }
}

// ── 复制为 Word（text/html + text/plain 双通道）────
async function copyAsWord() {
  const md = srcEl.value;
  if (!md.trim()) return toast.show('编辑器为空', true);
  const ir = markdownToIr(preprocessMarkdown(md));
  const clip = await buildWordClipboardHtml(ir, { style: styleSel.value });
  const plain = clip.plain || md;
  try {
    if (navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([clip.html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        }),
      ]);
    } else {
      legacyCopy(clip.html);
    }
    const lost = clip.warnings.length;
    toast.show(lost ? `已复制（${lost} 处降级）` : '已复制，粘贴到 Word 试试 ✓');
  } catch (e) {
    legacyCopy(clip.html);
    toast.show('已复制（降级路径）');
  }
}

function legacyCopy(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.style.position = 'fixed';
  div.style.opacity = '0';
  document.body.appendChild(div);
  const r = document.createRange();
  r.selectNodeContents(div);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  document.execCommand('copy');
  sel.removeAllRanges();
  div.remove();
}

// ── 导出 .docx / .html ────────────────
async function exportDocx() {
  const md = srcEl.value;
  if (!md.trim()) return toast.show('编辑器为空', true);
  toast.show('转换中…');
  const mermaidPngs = {};
  for (const [k, v] of state.mermaidPngs) mermaidPngs[fnv(k)] = v;
  const { buffer, warnings } = await exportMarkdownToDocx(md, {
    style: styleSel.value,
    title: guessTitle(md),
    fetchFn: (u) => fetch(u),
    readFile: null,
  });
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  download(blob, `${guessTitle(md)}.docx`);
  toast.show(warnings.length ? `已导出（${warnings.length} 处降级，见状态栏）` : '已导出 ✓ 公式可直接在 Word 中编辑');
}

async function exportHtml() {
  const md = srcEl.value;
  const ir = markdownToIr(preprocessMarkdown(md));
  const clip = await buildWordClipboardHtml(ir, { style: styleSel.value });
  const doc = `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${guessTitle(md)}</title></head>\n<body style="background:#fff">\n${clip.html}\n</body></html>`;
  download(new Blob([doc], { type: 'text/html' }), `${guessTitle(md)}.html`);
  toast.show('HTML 已导出（可直接粘贴进邮件/在线编辑器）');
}

function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function guessTitle(md) {
  const h = /^#\s+(.+)$/m.exec(md);
  return (h ? h[1] : 'md2word').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) || 'md2word';
}

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(16);
}

// ── 事件绑定 ─────────────────────────
$('#btn-copy').addEventListener('click', copyAsWord);
$('#btn-export').addEventListener('click', exportDocx);
$('#btn-html').addEventListener('click', exportHtml);
$('#style-preset').addEventListener('change', () => toast.show('样式已切换：刷新输出生效'));

$('#btn-demo').addEventListener('click', async () => {
  const res = await fetch('./sample.md');
  srcEl.value = await res.text();
  refresh();
  toast.show('演示文档已载入');
});

$('#btn-mermaid').addEventListener('click', async () => {
  if (!state.pendingMermaid?.length) return toast.show('文档中暂无 Mermaid 图', true);
  toast.show('正在栅格化…');
  for (const { source } of state.pendingMermaid) {
    try { await rasterizeMermaid(source, { scale: 2 }); } catch { /* 略 */ }
  }
  refresh();
  toast.show('Mermaid 已重渲染');
});

// 分栏拖拽
(() => {
  const div = $('#divider'), editor = $('#editor'), preview = $('#preview');
  let dragging = false;
  div.addEventListener('pointerdown', (e) => { dragging = true; div.setPointerCapture(e.pointerId); });
  div.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const main = $('#main').getBoundingClientRect();
    const ratio = Math.min(0.8, Math.max(0.2, (e.clientX - main.left) / main.width));
    editor.style.flex = `0 0 ${ratio * 100}%`;
    preview.style.flex = `1 1 ${100 - ratio * 100}%`;
  });
  div.addEventListener('pointerup', () => (dragging = false));
})();

// 快捷键（对齐原版：Ctrl+Shift+C 复制 / Ctrl+Shift+S 导出）
addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
  if (e.code === 'KeyC') { e.preventDefault(); copyAsWord(); }
  if (e.code === 'KeyS') { e.preventDefault(); exportDocx(); }
});

// 初始
$('#btn-demo').click();
