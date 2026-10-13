// ============================================================
// md2word — 代码高亮服务
// highlight.js → 结构化 token → (docx 彩色 run / HTML 内联 span)
// 行为参照：WordMarker Shiki token 管线（本实现采用 highlight.js，
// 轻量、零 wasm；调色板按导出主题区分深浅）
// ============================================================
import hljs from 'highlight.js/lib/common';

// GitHub Light 近似（浅色导出）
const PALETTE_LIGHT = {
  keyword: '#cf222e', 'variable.language': '#cf222e', built_in: '#0550ae', type: '#0550ae',
  literal: '#0550ae', number: '#0550ae', string: '#0a3069', 'char.escape': '#0550ae',
  subst: '#24292f', comment: '#6e7781', doctag: '#0550ae', meta: '#cf222e',
  tag: '#116329', name: '#116329', attr: '#0550ae', attribute: '#0550ae',
  variable: '#953800', 'variable.constant': '#0550ae', bullet: '#116329', code: '#0550ae',
  symbol: '#0550ae', 'class.title': '#8250df', 'title.class': '#8250df', 'title.function': '#8250df',
  title: '#8250df', selector_tag: '#116329', selector_class: '#5965e2', selector_id: '#5965e2',
  section: '#0550ae', addition: '#116329', deletion: '#82071e', regexp: '#116329',
  operator: '#0550ae', punctuation: '#24292f', property: '#0550ae', params: '#24292f',
};

export const CODE_THEME_LIGHT = {
  bg: '#F6F8FA', fg: '#24292F', border: '#D0D7DE',
};

export function highlightToTokens(code, lang) {
  let result = null;
  let usedLang = lang || '';
  if (lang && hljs.getLanguage(lang)) {
    try { result = hljs.highlight(code, { language: lang, ignoreIllegals: true }); } catch { result = null; }
    usedLang = lang;
  } else {
    try { result = hljs.highlightAuto(code); usedLang = result.language || ''; } catch { result = null; }
  }
  if (!result) {
    return { lang: usedLang, background: CODE_THEME_LIGHT.bg, foreground: CODE_THEME_LIGHT.fg, spans: [{ text: code, className: null }] };
  }
  return { lang: usedLang, background: CODE_THEME_LIGHT.bg, foreground: CODE_THEME_LIGHT.fg, html: result.value, ...parseHljsHtml(result.value) };
}

// 解析 hljs 的 HTML 输出 → [{text, className: 'keyword'}] 扁平 token 列表
export function parseHljsHtml(html) {
  const spans = [];
  const stack = [];
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) stack.push(m[1]);
    else if (m[2] !== undefined) {
      const cls = stack.length ? stack[stack.length - 1] : null;
      const text = m[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
      if (text) {
        const last = spans[spans.length - 1];
        if (last && last.className === cls) last.text += text;
        else spans.push({ text, className: cls });
      }
    } else stack.pop();
  }
  return { spans };
}

export function tokenColor(className, theme = PALETTE_LIGHT) {
  if (!className) return null;
  // hljs class 可能是 "hljs-keyword"、复合 "hljs-title function_"
  for (const part of className.split(/[\s.]+/)) {
    const key = part.replace(/^hljs[-]?/, '').replace(/_/g, '.');
    if (theme[key]) return theme[key];
    if (theme[part]) return theme[part];
  }
  return null;
}

export function tokenEmphasis(className) {
  if (!className) return {};
  const out = {};
  if (/\bitalic|emphasis\b/.test(className)) out.italics = true;
  if (/\bbold|strong\b/.test(className)) out.bold = true;
  return out;
}

export { PALETTE_LIGHT };
