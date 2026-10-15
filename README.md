# md2word

**AI Markdown → 规范 Word 文档，一键完成。** 公式变 Word 原生可编辑对象，表格带结构，代码带高亮——不再是“复制粘贴全丢版式”。

本仓库是闭源应用 **WordMarker v2.4.4**（© 2026 CarrotWuDev）的行为复刻，采用 clean-room（洁净室）方法独立实现：二进制与前端资源**仅用作行为观察证据**，所有产出代码均为原创或显式声明开源依赖。完整证据链与逆向分析见 [ANALYSIS.md](./ANALYSIS.md)。

## 能力（对照原版行为规格）

| 元素 | 行为规格（逆向自原版） | md2word 实现 | 验证 |
|---|---|---|---|
| 行内/块级公式 | KaTeX MathML → OMML，Word 中可编辑 | `$…$` `$$…$$` `\(…\)` `\[…\]` → `m:oMath` | ✓ oMath 断言 |
| 显示公式排版 | 独立居中段落 | `m:oMathPara + jc=center` + before:80/after:160 | ✓ |
| 求和/积分 | nary 结构 | `m:nary`（0.5.0 自动吸收上下限操作数） | ✓ |
| 矩阵 | 原版补丁 vendored 版 | mathml2omml 0.5.0 + 自研 `m:d` 定界符包装 | ✓ pmatrix→`m:d` |
| 化学式 `\ce{}` | mhchem 链路 | `katex/dist/contrib/mhchem.mjs` 直通 | ✓ 光照箭头 `m:limUpp` |
| 公式降级 | 两级降级保证不阻塞 | KaTeX 严格→宽松→斜体文本 | ✓ |
| GFM 表格 | 结构保留 | 行/列/对齐/表头三线表 | ✓ |
| **AI HTML 表格**（Gemini 特产） | 原版 altChunk 降级 | parse5 提升 IR：rowspan/colspan → `vMerge`/`gridSpan` **优于原版** | ✓ |
| 代码块 | 等宽+底纹 | 盒装拼边 + highlight.js 逐 token 着色 | ✓ 35 色 span |
| 代码复制降级 | CLI 无浏览器 | HTML 发射器文本化 + 警告 | ✓ |
| 脚注 `[^n]` | REF 域+书签 | `REF mdref_N \h \* MERGEFORMAT` 五段复杂域（全上标） | ✓ |
| 有序列表 start | 原版 startOverride | 独立 reference `md-ord-N` + `levels[0].start` | ✓ w:start |
| 图片 | 居中 ≤540 | 纯 JS 探测尺寸 + `capSize(540)` | ✓ |
| Mermaid | 浏览器栅格化 | scale=2, maxCanvas=12000, FNV 缓存；CLI 降级代码块 | ✓ |
| 剪贴板（复制为 Word） | CF_HTML, MathML 内嵌 | `text/html + text/plain` 双通道, `mso-style-name` 标题（Word 自动套 Heading N） | ✓ Playwright 实测 |
| 三样式预设 | zh/en/default | `buildStyleProfile` 等价重建 | ✓ 分化断言 |
| 页面规格 | A4 单节边距 2.54cm | 11906×16838 twips, 1440/708 | ✓ |
| 快捷键 | Ctrl+Shift+C / Ctrl+Shift+S | 同 | ✓ |
| 三栏布局 | sidebar+editor+preview+statusBar | 同构外壳 | ✓ 截图存证 |

## 使用方式（三种）

| 方式 | 适合 | 命令 / 操作 |
|---|---|---|
| **单文件，双击即用** | 普通用户 | 下载 `md2word-win-x64.exe` → 双击 → 浏览器打开完整界面 |
| 单文件，命令行 | 批处理 | `md2word 输入.md -o 输出.docx [--style zh\|en\|default]` |
| [在线体验版](https://md2word-core-5wqovb40-edptemkd.edgeone.cool) | 免下载 | 浏览器打开即用（外链网图受 CORS 限制，完整功能请用单文件版） |
| 源码运行 | 开发者 | `npm install` → `npm start` |

打包细节见 [PACKAGING.md](./PACKAGING.md)。单文件版内置图片代理，**外链网图可直接嵌入 .docx**。

## 运行形态（外链图策略）

| 形态 | 命令 | 外链图（如 telegraph/pages.dev 图床） | Mermaid |
|---|---|---|---|
| **本地全功能**（推荐） | `npm start` → http://127.0.0.1:5173 | ✅ 直嵌 .docx（内置同源代理 `/img?url=`，绕 CORS；>1080px/1.5MB 自动重采样） | ✅ 渲染进文档 |
| 纯静态 | `python3 -m http.server 5173 -d web/dist` | ⚠ 降级为占位框 + 具体原因（404/403/CORS/格式） | ✅（mermaid 已打包，离线可用） |
| CLI | `node cli/md2word.mjs x.md` | ✅ Node 无 CORS 概念（源站可达则直嵌） | ⚠ 无画布时保留代码块 + 提示 |

- 外链图一旦**源站删除**（HTTP 404），任何工具都无法再嵌入——导出时会给出占位框与准确原因，不再无声丢失。
- `npm start` 同样静态托管 dist，代理仅处理显式的 `/img?url=` 请求；含 SSRF 防护（拦截内网/元数据地址）。

## 快速开始

```bash
npm install
npm run demo                 # 样例 → samples/ai-demo.docx
node cli/md2word.mjs in.md -o out.docx --style zh     # zh | en | default
node cli/md2word.mjs in.md --html out.html            # 剪贴板模式产物
```

Web 应用（与 CLI 同一转换内核）：

```bash
npm run build:web
python3 -m http.server 5173 -d web/dist
# 打开 http://localhost:5173 —— Ctrl+Shift+C 复制为 Word / Ctrl+Shift+S 导出
```

## 架构

```
Markdown ─preprocess(定界符/BOM/CRLF/代码保护)→ markdown-it(+自研 数学/脚注/表格 规则)
        → IR(带诊断的中间表达) ─┬→ emitter-docx  ─assets(数学/图片/canvas)→ .docx
                                │     └ jszip 后处理（<undefined> 剥离 + m:mathPr 注入）
                                └→ emitter-html（CF_HTML 剪贴板）
                                  preview.mjs（KaTeX 实时预览，与导出同源）
```

## 差异与已知取舍

- `m:mathPr`（Cambria Math 默认）：原版写在 settings；md2word 由 jszip 后处理注入 —— 结果等价。
- 有序多层列表 start：v1 仅顶层独立编号（嵌套层沿用默认）。
- mhchem 的 `mpadded/mphantom` 上游警告：v1 接受（视觉差异可忽略）。
- Mermaid 需浏览器画布；CLI 环境自动降级为代码块 + 警告，不阻塞导出。
- 原版对 AI HTML 表走 altChunk（内容快照）；md2word 直接提升为表格 IR（可编辑性更好）。

## 依赖与署名

| 库 | 许可 | 用途 |
|---|---|---|
| [docx](https://github.com/dolanmiu/docx) 9.x | MIT | OOXML 生成 |
| [markdown-it](https://github.com/markdown-it/markdown-it) | MIT | Markdown 解析 |
| [KaTeX](https://github.com/KaTeX/KaTeX) | MIT | LaTeX→MathML |
| [mathml2omml](https://github.com/rnwonwor/mathml2omml) | **LGPL-3.0-or-later** | MathML→OMML |
| [highlight.js](https://github.com/highlightjs/highlight.js) | BSD-3 | 语法高亮 |
| [parse5](https://github.com/inikulin/parse5) | MIT | AI HTML 表提升 |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | MIT | OMML 后处理 DOM |
| [jszip](https://github.com/Stuk/jszip) | MIT/GPLv3 双许可 | ZIP 后处理 |
| mermaid（运行时 CDN） | MIT | 流程图 |

mathml2omml 按 LGPL-3.0 以独立库通过 npm **链接使用**（非源码内嵌分发，动态 import 隔离），特此署名并保持该依赖可独立替换。

## 法律声明

- WordMarker 为闭源软件，其作者© 2026 CarrotWuDev 拥有其全部权利。本项目与其无任何关联、未使用其任何源代码、资源或二进制；逆向分析仅用于**互操作性与学术研究**，产物为行为层面的独立表达。
- 本项目以 MIT 许可发布。
