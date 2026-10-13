// ============================================================
// md2word — Word 样式预设（3 档）
// 行为参照：WordMarker docx-style-catalog（zh-academic / en-academic /
// word-default），通过 docx styles API 等价重建（原实现为部件级替换）
// 数值单位：字号 half-point；间距/缩进 twips (1/20pt)
// ============================================================
import {
  AlignmentType, LevelFormat, convertMillimetersToTwip,
} from 'docx';

const FONT_TEXT_ZH = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: 'SimSun' };
const FONT_HEADING_ZH = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: 'SimSun' };
const FONT_EN = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: 'SimSun' };
const FONT_CODE = { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: 'Consolas', cs: 'Consolas' };

const COLOR_BLACK = '000000';
const COLOR_LINK = '0563C1';
const COLOR_CODE_BG = 'F6F8FA';
const COLOR_BORDER = 'D0D7DE';

// 字号：12pt=24 10.5pt=21 10pt=20
function headingRun(size, { bold = true, color = COLOR_BLACK, italic = false } = {}) {
  return { size, bold, color, italics: italic };
}

/** 文档基础样式（段落/字符），返回 docx Document 的 styles 选项 */
export function buildStyleProfile(presetId = 'zh') {
  if (presetId === 'en') return buildEn();
  if (presetId === 'default') return buildDefault();
  return buildZh();
}

function linkCharStyles(extra = []) {
  return [
    { id: 'Hyperlink', name: 'Hyperlink', basedOn: 'DefaultParagraphFont', run: { color: COLOR_LINK, underline: { type: 'single' } } },
    { id: 'WMInlineCode', name: 'WordMarker Inline Code', basedOn: 'DefaultParagraphFont', run: { font: FONT_CODE, shading: { fill: COLOR_CODE_BG } } },
    ...extra,
  ];
}

// ---------------- 中文论文档 ----------------
function buildZh() {
  return {
    id: 'zh',
    name: '中文论文',
    styles: {
      default: {
        document: {
          run: { font: FONT_TEXT_ZH, size: 24, color: COLOR_BLACK },
          paragraph: { spacing: { line: 360, after: 120 }, indent: { firstLine: 480 }, alignment: AlignmentType.JUSTIFIED },
        },
      },
      paragraphStyles: [
        { id: 'Normal', name: 'Normal', quickFormat: true, run: { font: FONT_TEXT_ZH, size: 24, color: COLOR_BLACK }, paragraph: { spacing: { line: 360, after: 120 }, indent: { firstLine: 480 }, alignment: AlignmentType.JUSTIFIED } },
        ...[40, 32, 28, 26, 24, 24].map((size, i) => ({
          id: `Heading${i + 1}`, name: `heading ${i + 1}`, basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { ...headingRun(size), font: FONT_HEADING_ZH },
          paragraph: {
            spacing: { before: i === 0 ? 360 : 240, after: 120, line: 360 }, indent: { firstLine: 0 },
            alignment: AlignmentType.LEFT, keepNext: true, keepLines: true, outlineLevel: i,
          },
        })),
        { id: 'ListParagraph', name: 'List Paragraph', basedOn: 'Normal', quickFormat: true, run: { font: FONT_TEXT_ZH, size: 24 }, paragraph: { spacing: { after: 60, line: 360 }, indent: { firstLine: 0 }, alignment: AlignmentType.LEFT } },
        {
          id: 'WMQuote', name: 'WordMarker Quote', basedOn: 'Normal', quickFormat: true,
          run: { color: COLOR_BLACK },
          paragraph: {
            spacing: { line: 300, after: 120 }, indent: { firstLine: 480, left: 360 },
            alignment: AlignmentType.JUSTIFIED,
            border: { left: { style: 'single', size: 12, color: COLOR_BORDER, space: 12 } },
            shading: { fill: COLOR_CODE_BG },
          },
        },
        {
          id: 'WMCodeBlock', name: 'WordMarker Code Block', basedOn: 'Normal', quickFormat: true,
          run: { font: FONT_CODE, size: 20, color: '24292F' },
          paragraph: { spacing: { line: 280, before: 0, after: 0 }, indent: { firstLine: 0 }, alignment: AlignmentType.LEFT },
        },
        { id: 'Caption', name: 'Caption', basedOn: 'Normal', quickFormat: true, run: { size: 21, color: '333333', bold: false }, paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 60, after: 120 }, indent: { firstLine: 0 } } },
        { id: 'WMReferenceItem', name: 'WordMarker Reference Item', basedOn: 'Normal', quickFormat: true, run: { size: 21 }, paragraph: { spacing: { line: 360, after: 60 }, indent: { left: 480, hanging: 480, firstLine: 0 }, alignment: AlignmentType.JUSTIFIED, tabStops: [{ type: 'left', position: 480 }] } },
      ],
      characterStyles: linkCharStyles([
        { id: 'WMRefCitation', name: 'WordMarker Reference Citation', basedOn: 'DefaultParagraphFont', run: { vertAlign: 'superscript' } },
      ]),
    },
    numbering: buildNumbering('zh'),
    table: { mode: 'three-line', headerBottomSz: 6, borderSz: 12, cellMargin: { top: 80, bottom: 80, left: 120, right: 120 }, headerBold: true },
    docDefaults: { spacingAfter: 120 },
  };
}

// ---------------- 英文论文档 ----------------
function buildEn() {
  return {
    id: 'en',
    name: 'English Academic',
    styles: {
      default: {
        document: {
          run: { font: FONT_EN, size: 24, color: COLOR_BLACK },
          paragraph: { spacing: { line: 360 }, indent: { firstLine: 720 }, alignment: AlignmentType.JUSTIFIED },
        },
      },
      paragraphStyles: [
        { id: 'Normal', name: 'Normal', quickFormat: true, run: { font: FONT_EN, size: 24, color: COLOR_BLACK }, paragraph: { spacing: { line: 360 }, indent: { firstLine: 720 }, alignment: AlignmentType.JUSTIFIED } },
        ...[32, 28, 24, 24, 24, 24].map((size, i) => ({
          id: `Heading${i + 1}`, name: `heading ${i + 1}`, basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: headingRun(size),
          paragraph: { spacing: { before: 240, after: 120, line: 276 }, indent: { firstLine: 0 }, alignment: AlignmentType.LEFT, keepNext: true, keepLines: true, outlineLevel: i },
        })),
        { id: 'ListParagraph', name: 'List Paragraph', basedOn: 'Normal', quickFormat: true, run: { font: FONT_EN, size: 24 }, paragraph: { spacing: { after: 60, line: 360 }, indent: { firstLine: 0 }, alignment: AlignmentType.LEFT } },
        {
          id: 'WMQuote', name: 'WordMarker Quote', basedOn: 'Normal', quickFormat: true,
          paragraph: { spacing: { line: 276, after: 120 }, indent: { left: 360, right: 360, firstLine: 0 }, border: { left: { style: 'single', size: 12, color: COLOR_BORDER, space: 12 } } },
        },
        {
          id: 'WMCodeBlock', name: 'WordMarker Code Block', basedOn: 'Normal', quickFormat: true,
          run: { font: FONT_CODE, size: 20, color: '24292F' },
          paragraph: { spacing: { line: 280, before: 0, after: 0 }, indent: { firstLine: 0 }, alignment: AlignmentType.LEFT },
        },
        { id: 'Caption', name: 'Caption', basedOn: 'Normal', quickFormat: true, run: { size: 21, italics: true }, paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 60, after: 120 }, indent: { firstLine: 0 } } },
        { id: 'WMReferenceItem', name: 'WordMarker Reference Item', basedOn: 'Normal', quickFormat: true, run: { size: 22 }, paragraph: { spacing: { line: 276, after: 60 }, indent: { left: 720, hanging: 720, firstLine: 0 }, alignment: AlignmentType.JUSTIFIED, tabStops: [{ type: 'left', position: 720 }] } },
      ],
      characterStyles: linkCharStyles([
        { id: 'WMRefCitation', name: 'WordMarker Reference Citation', basedOn: 'DefaultParagraphFont', run: { vertAlign: 'superscript' } },
      ]),
    },
    numbering: buildNumbering('en'),
    table: { mode: 'three-line', headerBottomSz: 6, borderSz: 12, cellMargin: { top: 80, bottom: 80, left: 108, right: 108 }, headerBold: true, cellSize: 22 },
  };
}

// ---------------- Word 默认档 ----------------
function buildDefault() {
  return {
    id: 'default',
    name: 'Word 默认',
    styles: {
      default: {
        document: {
          run: { font: { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '宋体', cs: 'Times New Roman' }, size: 22, color: COLOR_BLACK },
          paragraph: { spacing: { after: 120 } },
        },
      },
      paragraphStyles: [
        { id: 'Normal', name: 'Normal', quickFormat: true, run: { size: 22, color: COLOR_BLACK }, paragraph: { spacing: { after: 120 } } },
        { id: 'Heading1', name: 'heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, color: '2E74B5' }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0, keepNext: true } },
        { id: 'Heading2', name: 'heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 26, bold: true, color: '2E74B5' }, paragraph: { spacing: { before: 120, after: 120 }, outlineLevel: 1, keepNext: true } },
        { id: 'Heading3', name: 'heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, color: '1F4D78' }, paragraph: { spacing: { before: 120, after: 120 }, outlineLevel: 2, keepNext: true } },
        { id: 'Heading4', name: 'heading 4', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, italics: true, color: '1F4D78' }, paragraph: { spacing: { before: 120, after: 120 }, outlineLevel: 3, keepNext: true } },
        { id: 'Heading5', name: 'heading 5', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 22, color: '2E74B5' }, paragraph: { spacing: { before: 120, after: 120 }, outlineLevel: 4 } },
        { id: 'Heading6', name: 'heading 6', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 22, color: '2E74B5' }, paragraph: { spacing: { before: 120, after: 120 }, outlineLevel: 5 } },
        { id: 'ListParagraph', name: 'List Paragraph', basedOn: 'Normal', quickFormat: true, run: {}, paragraph: { indent: { left: 720, hanging: 360 } } },
        {
          id: 'WMQuote', name: 'WordMarker Quote', basedOn: 'Normal', quickFormat: true,
          paragraph: { spacing: { after: 120 }, indent: { left: 360 }, border: { left: { style: 'single', size: 18, color: 'AAAAAA', space: 12 } } },
        },
        {
          id: 'WMCodeBlock', name: 'WordMarker Code Block', basedOn: 'Normal', quickFormat: true,
          run: { font: FONT_CODE, size: 20, color: '24292F' },
          paragraph: { spacing: { line: 280 }, shading: { fill: COLOR_CODE_BG } },
        },
        { id: 'Caption', name: 'Caption', basedOn: 'Normal', quickFormat: true, run: { size: 20, color: '595959' }, paragraph: { alignment: AlignmentType.CENTER } },
        { id: 'WMReferenceItem', name: 'WordMarker Reference Item', basedOn: 'Normal', quickFormat: true, run: { size: 20 }, paragraph: { indent: { left: 360, hanging: 360 } } },
      ],
      characterStyles: linkCharStyles([
        { id: 'WMRefCitation', name: 'WordMarker Reference Citation', basedOn: 'DefaultParagraphFont', run: { vertAlign: 'superscript' } },
      ]),
    },
    numbering: buildNumbering('default'),
    table: { mode: 'grid' },
  };
}

// ---------------- 编号 ----------------
function buildNumbering(preset) {
  const BULLETS = ['\u2022', '\u25E6', '\u25AA']; // • ◦ ▪
  const levels = [];
  for (let lvl = 0; lvl < 6; lvl++) {
    levels.push({
      level: lvl,
      format: LevelFormat.BULLET,
      text: BULLETS[lvl % BULLETS.length],
      alignment: 'left',
      style: { paragraph: { indent: { left: 480 + lvl * 480, hanging: 300 } } },
    });
  }
  const ordLevels = [];
  for (let lvl = 0; lvl < 6; lvl++) {
    const format = preset === 'en' && lvl === 1 ? LevelFormat.LOWER_LETTER : preset === 'en' && lvl === 2 ? LevelFormat.LOWER_ROMAN : LevelFormat.DECIMAL;
    const text = preset === 'en' && lvl >= 1 && lvl <= 2 ? '%1.' : Array.from({ length: lvl + 1 }, (_, k) => `%${k + 1}`).join('.') + '.';
    ordLevels.push({
      level: lvl,
      format,
      text,
      alignment: 'left',
      style: { paragraph: { indent: { left: 480 + lvl * 480, hanging: 300 } } },
    });
  }
  return {
    config: [
      { reference: 'md-bullet', levels },
      { reference: 'md-ordered', levels: ordLevels },
    ],
  };
}

export const STYLE_PRESETS = [
  { id: 'zh', label: '中文论文' },
  { id: 'en', label: 'English Academic' },
  { id: 'default', label: 'Word 默认' },
];

export { FONT_CODE, COLOR_CODE_BG, COLOR_BORDER, COLOR_LINK, FONT_TEXT_ZH };
