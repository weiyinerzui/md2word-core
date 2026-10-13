// ============================================================
// md2word — 数学公式服务
// LaTeX → KaTeX(MathML) → 规范化 → mathml2omml(开源 LGPL) → OMML 修复
// 行为参照：WordMarker math-export-service（katex-mathml-omml 引擎）
// 自研对应：mathml-canonicalizer / mtable 定界符包装 / oMathPara
// ============================================================
import katex from 'katex';
import 'katex/contrib/mhchem'; // \ce{} \pu{} 化学式
import { mml2omml } from 'mathml2omml';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const XML = 'http://www.w3.org/XML/1998/namespace';
export { XML as XMLNS };

// DOM 工具（@xmldom/xmldom 在浏览器/Node 一致可用）
const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
const ser = (node) => new XMLSerializer().serializeToString(node);
const kids = (el) => Array.prototype.slice.call(el?.childNodes || []);
const q = (el, name, ns = 'http://schemas.openxmlformats.org/officeDocument/2006/math') => {
  const out = [];
  for (const c of kids(el)) if (c.nodeName === name || c.localName === name) out.push(c);
  return out;
};
const text = (el) => {
  let s = '';
  for (const c of kids(el)) if (c.nodeName === '#text') s += c.nodeValue;
  return s;
};
const local = (el) => el.localName || el.nodeName.replace(/^.*:/, '');

/** KaTeX 渲染 → 规范化 MathML（剥外壳/语义标注/隐形符，结构等价改写） */
export function renderMathToMathml(source, { displayMode = false, macros } = {}) {
  const html = katex.renderToString(source, {
    output: 'mathml',
    throwOnError: true,
    strict: 'ignore',
    trust: false,
    displayMode,
    macros: { ...macros },
  });
  let mathml = html.match(/<math[\s\S]*<\/math>/)?.[0];
  if (!mathml) throw new Error('katex produced no mathml');
  mathml = canonicalizeMathml(mathml, displayMode);
  return mathml;
}

/** MathML 规范化（自研，对应原 mathml-canonicalizer 的核心规则） */
export function canonicalizeMathml(mathmlStr, displayMode) {
  const doc = parseXml(mathmlStr);
  const math = doc.documentElement;
  // 1) 删除 annotation/annotation-xml，展开 semantics
  stripAnnotations(math);
  // 2) 文本节点剥离 U+2061（FUNCTION APPLICATION，Word 中成乱码）
  stripFunctionApplication(math);
  // 3) display 属性 / 命名空间
  math.setAttribute('display', displayMode ? 'block' : 'inline');
  math.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
  return ser(math);
}

function stripAnnotations(el) {
  for (const c of kids(el)) {
    if (local(c) === 'annotation' || local(c) === 'annotation-xml') el.removeChild(c);
    else stripAnnotations(c);
  }
  // semantics → 展开为其 presentation 子元素
  const children = kids(el).filter((c) => c.nodeName !== '#text');
  for (const c of children) {
    if (local(c) === 'semantics') {
      const pres = kids(c).find((k) => k.nodeName !== '#text' && local(k) !== 'annotation');
      if (pres) {
        el.replaceChild(pres, c);
        stripAnnotations(pres);
      } else el.removeChild(c);
    }
  }
}

function stripFunctionApplication(el) {
  for (const c of kids(el)) {
    if (c.nodeName === '#text') {
      if (c.nodeValue.includes('⁡')) c.nodeValue = c.nodeValue.replace(/\u2061/g, '');
      else if (c.nodeValue === '\u2061') el.removeChild(c);
    } else if (local(c) === 'mo' && text(c) === '\u2061') el.removeChild(c);
    else stripFunctionApplication(c);
  }
}

// ------------------------------------------------------------
// OMML 后处理
// ------------------------------------------------------------

/**
 * 定界符包装：`(` run + m:m + `)` run → m:d（原生可伸缩括号矩阵）
 * 对应原 mathml-mtable-to-omml-adapter 的 _normalizeTableDelimiters
 */

export function wrapMatrixDelimiters(ommlStr) {
  try {
    const doc = parseXml(ommlStr);
    const root = doc.documentElement;
    if (!root) return ommlStr;
    const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
    const kidsArr = Array.prototype.slice.call(root.childNodes).filter((c) => c.nodeName !== '#text');
    const PAIRS = [['(', ')'], ['[', ']'], ['{', '}'], ['⟨', '⟩'], ['⌊', '⌋'], ['⌈', '⌉'], ['|', '|']];
    const runText = (el) => (text(q(el, 't')[0] || el) || '').trim();
    const isRun = (el) => local(el) === 'r';

    for (let round = 0; round < 6; round++) {
      const nodes = Array.prototype.slice.call(root.childNodes).filter((c) => c.nodeName !== '#text');
      let done = false;
      for (let i = 0; i + 2 < nodes.length; i++) {
        const a = nodes[i], mid = nodes[i + 1], b = nodes[i + 2];
        if (local(mid) !== 'm' || !isRun(a) || !isRun(b)) continue;
        const ta = runText(a), tb = runText(b);
        const pair = PAIRS.find(([o, c]) => ta === o && tb === c);
        if (!pair) continue;
        const d = doc.createElementNS(M, 'm:d');
        const dPr = doc.createElementNS(M, 'm:dPr');
        for (const [name, val] of [['m:begChr', pair[0]], ['m:endChr', pair[1]]]) {
          const el = doc.createElementNS(M, name);
          el.setAttribute('m:val', val);
          dPr.appendChild(el);
        }
        const eEl = doc.createElementNS(M, 'm:e');
        root.removeChild(b);
        root.removeChild(mid);
        eEl.appendChild(mid);
        d.appendChild(dPr);
        d.appendChild(eEl);
        root.replaceChild(d, a);
        done = true;
        break;
      }
      if (!done) break;
    }
    return ser(root);
  } catch {
    return ommlStr;
  }
}

/**
 * 数学资产构建：一次调用产出 mathml + omml + 降级信息
 * 任何一步失败 → fallback（对应原 describe degradation 链）
 */
export async function buildMathAsset(source, { displayMode = false } = {}) {
  const asset = {
    source,
    displayMode,
    engine: 'katex-mathml-omml',
    mathml: null,
    omml: null,
    fallbackText: source,
    warnings: [],
  };
  try {
    asset.mathml = renderMathToMathml(source, { displayMode });
  } catch (e1) {
    // 第二次尝试：宽松模式（保留 KaTeX 错误染色）
    try {
      asset.mathml = renderMathToMathml(source, { displayMode, macros: undefined });
      asset.warnings.push({ code: 'mathLooseRender', message: `公式宽松渲染：${String(e1.message || e1).slice(0, 80)}` });
    } catch {
      asset.warnings.push({ code: 'mathRenderFailed', message: `公式渲染失败：${String(e1.message || e1).slice(0, 80)}` });
      return asset;
    }
  }
  try {
    let omml = captureConsole(() => mml2omml(asset.mathml), (notes) => {
      if (notes.length) asset.warnings.push({ code: 'ommlUpstreamNotes', message: `上游转换备注：${notes.slice(0, 2).join('; ')}` });
    });
    // 上游 bug 修复：mathvariant=normal 时 mml2omml 会产出非法枚举 <m:sty m:val="undefined"/>（配合 m:nor 已足够表意，直接剔除）
    omml = String(omml).replaceAll('<m:sty m:val="undefined"/>', '');
    // 自研修复：矩阵定界符 → m:d
    try { omml = wrapMatrixDelimiters(omml); } catch { /* 保持原样 */ }
    asset.omml = displayMode ? wrapOmathPara(omml) : omml;
  } catch (e2) {
    asset.warnings.push({ code: 'ommlConvertFailed', message: `OMML 转换失败：${String(e2.message || e2).slice(0, 80)}` });
  }
  return asset;
}

/** display 数学：包一层 <m:oMathPara><m:oMathParaPr><m:jc center/></...>（纯字符串拼接，避免跨文档 DOM 移植丢内容） */
export function wrapOmathPara(ommlStr) {
  const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
  const inner = String(ommlStr || '').trim();
  return (
    '<m:oMathPara xmlns:m="' + M + '">' +
    '<m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>' +
    inner +
    '</m:oMathPara>'
  );
}

/** 预处理后的 OMML 是否可用（根元素判定） */
export function isDisplayOmml(ommlStr) {
  return /^<m:oMathPara[\s>]/.test(ommlStr || '') || /<m:oMathPara[\s>]/.test(ommlStr || '');
}

/** 捕获同步执行期间的 console.warn 噪音（mml2omml 上游对 mpadded/mphantom 的提示），转为诊断 */
export function captureConsole(fn, sink) {
  const original = console.warn;
  const notes = [];
  console.warn = (...a) => {
    const msg = a.map(String).join(' ').trim();
    if (msg && !notes.includes(msg)) notes.push(msg.slice(0, 120));
  };
  try {
    const out = fn();
    if (sink) sink(notes);
    return out;
  } finally {
    console.warn = original;
  }
}
