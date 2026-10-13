// ============================================================
// md2word — 预览渲染（编辑器右侧实时预览）
// 同一 markdown-it 实例 + 自定义规则：KaTeX(HTML)、代码高亮、
// mermaid 占位（浏览器异步渲染）。渲染即所见 ≈ 复制/导出结果
// ============================================================
import { createMarkdown } from './parser.mjs';
import { highlightToTokens, tokenColor } from './highlight.mjs';

const md = createMarkdown();
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let katexLib = null;
async function ensureKatex() {
  if (!katexLib) katexLib = (await import('katex')).default;
  return katexLib;
}

export async function renderPreviewHtml(markdown, opts = {}) {
  const katex = await ensureKatex();
  const { preprocessMarkdown } = await import('./preprocess.mjs');
  const src = preprocessMarkdown(markdown);
  const collect = { mermaid: [], footnotes: new Map() };

  const renderMath = (tex, displayMode) => {
    try {
      return katex.renderToString(tex, { output: 'htmlAndMathml', throwOnError: false, displayMode, strict: 'ignore', trust: false });
    } catch {
      return `<code>${esc(tex)}</code>`;
    }
  };

  md.renderer.rules.math_js_inline = (tokens, idx) => {
    const t = tokens[idx];
    let inner = t.content;
    if (!t.meta?.display && /^[\s\S]*\$\$$/.test(inner)) inner = inner.replace(/\$\$$/, '');
    return renderMath(inner, false);
  };
  md.renderer.rules.math_js = (tokens, idx) => {
    const t = tokens[idx];
    return `<div style="text-align:center">${renderMath(t.content, true)}</div>`;
  };
  md.renderer.rules.footnote_ref = (tokens, idx) => {
    const label = tokens[idx].meta.label;
    if (!collect.footnotes.has(label)) collect.footnotes.set(label, collect.footnotes.size + 1);
    return `<sup class="wm-footnote-ref" data-label="${esc(label)}" style="cursor:pointer">[${collect.footnotes.get(label)}]</sup>`;
  };
  md.renderer.rules.fence = (tokens, idx) => {
    const t = tokens[idx];
    const lang = (t.info || '').trim().split(/\s+/)[0] || '';
    if (lang === 'mermaid') {
      const id = `wm-mermaid-${collect.mermaid.length}`;
      collect.mermaid.push({ id, source: t.content });
      return `<div class="wm-mermaid" id="${id}" data-state="pending"><pre style="display:none">${esc(t.content)}</pre>加载图表…</div>`;
    }
    const result = highlightToTokens(t.content.replace(/\n$/, ''), lang);
    const html = (result.spans || []).map((s) => {
      const color = tokenColor(s.className);
      return `<span${color ? ` style="color:${color}"` : ''}>${esc(s.text)}</span>`;
    }).join('');
    return `<pre class="code-block" style="background:#F6F8FA; border:1px solid #D0D7DE; border-radius:6px; padding:12px"><code>${html}</code></pre>`;
  };
  // code_block（缩进代码）同 fence
  md.renderer.rules.code_block = md.renderer.rules.fence;

  let html = md.render(src);

  // 预览态的简单净化（浏览器预览可信源；保留 KaTeX/高亮结构）
  // （DOMPurify 可选：由 web 层调用，这里保持渲染器职责单一）
  return { html, mermaid: collect.mermaid };
}
