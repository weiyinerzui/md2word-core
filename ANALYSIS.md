# WordMarker 逆向分析报告 → md2word 复刻依据

> 方法：REA（Reverse Engineer Anything）四通道流程；仅作互操作性研究。
> 目标：`CarrotWuDev/WordMarker` v2.4.4（Tauri v2 桌面应用，闭源）。

## 1. 侦察与解包（证据链）

| 步骤 | 工具/手法 | 结果 |
|---|---|---|
| 包格式 | `.deb` → ar/tar | `usr/bin/app`（28MB ELF，Rust 符号未 strip） |
| 前端资源 | `resources/` 中 brotli 压缩 `assets.br` | 333 文件 100% 提取，无混淆 |
| 目录结构 | 解包后直读 | `js/core/`（数学、IR、DOCX、HTML 发射器）`export-styles/word/{chinese-academic, english-academic, custom-reference}` |
| 外壳 | IPC 命令面（28 个 `#[tauri::command]`） | `read_clipboard / write_clipboard_html / save_file`… |
| 版本指纹 | 前端资源常量 | `© 2026 CarrotWuDev`，v2.4.4 |

## 2. 行为规格（三份子报告汇总）

### 2.1 数学管线（`math-pipeline.js` + KaTeX vendor）
1. 预处理把 `\(\)` `…` 统一为 `$`。
2. KaTeX `output:'mathml'` → `canonicalizeMathML`（剥 `<annotation>`/`<semantics>`、去 U+2061 FUNCTION APPLICATION）。
3. mathml2omml → OMML。
4. 四个适配器：
   - `phantom/merror` → 占位 run；
   - `mtable`（矩阵）→ 重排 + **定界符**：原版把字面 `(` `)` run 折叠成 `m:d`（可伸缩括号）；
   - `mathvariant` → `m:sty`/`m:nor`；
   - `nary`（∑∫∏）操作数吸收进 `m:e`（原版 vendored 旧版 mathml2omml 需自研适配；**0.5.0 上游已吸收**）。
5. display → 包 `m:oMathPara`，居中段 spacing before:80 / after:160。
6. 复制模式直接把 KaTeX 的 `<math>` MathML 嵌进 CF_HTML（Word 2016+ 粘贴时自动 OMML 化）。
7. 任何失败 → 斜体文本降级，绝不阻塞导出。

### 2.2 DOCX 管线（`document-ir.js` + vendored docx 9.x + JSZip 3.10.1）
- 四阶段：解析 IR → docx-emitter → altChunk 注入（HTML 块）→ docx-style-package **整包替换** styles/numbering/settings/theme/fontTable。
- 单节 A4：`11906×16838` twips，边距 1440，页眉脚 708；无页眉页脚页码区。
- `settings.xml` 内含 `m:mathPr`（Cambria Math 主字体）。
- 三线表（top/bottom 1pt 黑 + 表头底 0.5pt）来自 `chinese-academic` 预设。
- 脚注：正常文末列表 + 正文上标 `REF` 域（可跳转书签 `wm_ref_item_N`）。

### 2.3 应用骨架（Tauri v2，无 JS 框架）
- 窗口外壳：sidebar（命令） + editor（CodeMirror 6 魔改） + preview + statusBar。
- `loadScriptOnce` 懒加载 KaTeX/highlight/mermaid。
- 三链路：**复制为 Word**（Ctrl+Shift+C，`write_clipboard_html`）、**导出文件**（Ctrl+Shift+S）、**实时双栏预览**。
- 三样式：zh / en / default。

## 3. 复刻决策表

| # | 原版行为 | md2word 决策 | 理由 |
|---|---|---|---|
| 1 | vendored mathml2omml + 自研 nary 吸收适配器 | npm 0.5.0，吸收已内置 → 删除适配器 | 减少自研面，实测 `m:e` 含操作数 |
| 2 | 字面 `(` run + `m:m` + `)` run（旧版未折叠） | 自研 `wrapMatrixDelimiters`（真 `m:d`） | **超越**：Word 中括号可伸缩，与 bmatrix/vmatrix 语义一致 |
| 3 | vendored docx 9.x IIFE + 整包 styles 替换 | npm docx 9.10 走 styles API 等价重建 | 同代库、更干净的可维护面；结果一致 |
| 4 | REF 域五段 | `ImportedXmlComponent.fromXmlString` 注入 5 run | docx 无 fldChar 导出；post 处理剥 `<undefined>` 包装 |
| 5 | settings 自带 `m:mathPr` | jszip 后处理注入 | 等价结果，避免整包替换 |
| 6 | 有序列表 `startOverride` | 独立 reference `md-ord-N` + `levels[0].start` | `instance` 无 start 参数 |
| 7 | altChunk 嵌 HTML 表 | parse5 → 表格 IR → `rowSpan/columnSpan` | 可编辑性、vMerge/gridSpan 原生结构 |
| 8 | Mermaid 浏览器栅格化 scale 2 | 相同（maxCanvas 12000 + FNV 缓存） | 行为一致 |
| 9 | CodeMirror 6 | textarea + 自研分栏拖拽 | v1 克制；编辑体验非本次规格核心 |

## 4. 验证矩阵（全部基于真实运行）

| 通道 | 断言 | 结果 |
|---|---|---|
| CLI zh | `<m:oMath`=7 · `oMathPara jc`=3 · `m:nary`=3 · `m:d`=1 · `limUpp`=1 · REF=3 · gridSpan=1 · vMerge=2 · `m:sty undefined` 清零 | ✓ |
| CLI en/default | Times 加权 / 蓝标题 / 宋体退出 | ✓ |
| 剪贴板 HTML | 9× `mso-style-name`（Word 自动 Heading N）· 7× MathML 内嵌 · 3× sup 锚点 | ✓ |
| 浏览器（Chromium 实测；无接口调用模拟） | 图表 | ✓ |
|   | DOM | 预览 H1/KaTeX 节点 7 |
|   | 按钮 | 真实下载事件 → 14.0KB docx |
|   | 剪贴板 | 读回 text/html 11045 字节 |
|   | 运行时 | 0 pageerror / 0 console.error |
| 样式分化 | 宋体 9→3→0 / Times 18→6 / 蓝标题 flag | ✓ |

## 5. 法律

- 逆向产物仅用于互操作性研究；未复制任何源码/资源/二进制到本仓库。
- 复刻物按“行为规格”独立表达；开源依赖全部在 README 署名（mathml2omml LGPL-3.0 链接式使用）。

## 修复记录 v1.1（用户实测反馈）

### 故障 1：Mermaid 不渲染（预览 failed / DOCX 回退代码块）
两处独立缺陷，均已修复并有浏览器级复现证据：
1. **渲染 id 含冒号**：`rasterizeMermaid` 用缓存 key（`fnv:s2`）当元素 id，mermaid 内部 `querySelector('#mmd-x:s2')` 抛 "not a valid selector"。→ id 清洗为 `[a-zA-Z0-9_-]`。
2. **Tainted canvas**：Chromium 对含 `<foreignObject>` 的 <img>SVG 判污染，`toDataURL` 抛 "Tainted canvases may not be exported"。mermaid 的 html 标签/边标签就是 foreignObject。→ 渲染后 `deForeignSvg` 将其原地替换为等位 `<text>`（多行 → tspan）；`flowchart.htmlLabels:false` 作前置减量。浏览器复现：替换前 TAINT，替换后 CLEAN、PNG 13KB 真产出。

### 故障 2：外链图导出丢失（用户样例 URL）
- 源站实况（2025-10 实测）：该 URL 曾返回 200/4.4MB JPEG，**现已 404**（第三方图床内容不可复活——任何工具都一样，非本项目缺陷）。
- 修复链（B1+B3，用户已确认）：
  - **B1**：figure 失败不再静默消失 → 文档内可见占位图框（alt+URL+原因）；资产级警告（imageUnavailable/imageResized/mermaidRenderFailed）浮出到状态栏 + 导出 toast；`loadImageAsset` 按 fetch 结果细分类（cors / not-found / http-403 / server / unsupported / no-fetcher），每个码有人话文案。
  - **B3**：`web/server.mjs`（约 100 行）：静态托管 + `/img?url=` 同源代理；上游状态码**透传**（404→404，浏览器端据此显示"远端 404"而非笼统跨域）；SSRF 防护拦截 localhost/内网段/元数据地址（实测 400）。
  - web 端取图顺序：直连（CORS 友好源）→ 代理回退（有响应即透传，含 404/403）→ 都失败才按 CORS 报错。
  - **决策③（重编码默认开）**：浏览器路径 canvas 重采样（>1080px 或 >1.5MB 触发，JPEG 0.85）。实测 2000×1400/322KB → 1080×756/151KB；4.4MB 原图 → 118KB。CLI 无 canvas，保持原字节。
- 验证矩阵（Playwright 真实点击导出）：代理模式 docx 含该图 drawing + word/media jpeg + URL 不落文本层；静态/CLI 模式落占位框 + "远端 404"准确措辞。
- 附带修复：`exportDocx` 中 `mermaidPngs` 死代码接通（DOCX 走内核栅格化，剪贴板/HTML 模式注入 PNG map）。

### v1.1 已知限制（更新）
- 纯静态部署下外链图永远无法直嵌（浏览器安全模型，无解）；占位框+原因+可复制 URL 是诚实降级。
- CLI 的 mermaid 仍为代码块保留（Node 无画布）；可在有浏览器环境 `npm start` 导出。

## 修复记录 v1.2（用户二轮实测反馈）

### 故障 3：Mermaid 在 web 预览 / 导出 HTML / 剪贴板全坏（DOCX 却正常）
根因：`rasterizeMermaid()` 返回**对象** `{ dataUri, width, height, png }`，但 `web/app.mjs` 三处消费点把它当**字符串**：
- `renderMermaidQueue`：`src: png` → 预览 img.src = `[object Object]`（坏图）；
- `state.mermaidPngs.set(source, png)` → 剪贴板/HTML 取到对象；
- 传给 emitter-html 的 mermaidPngs 也是对象 → 导出 HTML 里 `<img src="[object Object]">`。
DOCX 不受影响——它走 `lib/` 内核另一条栅格化路径（消费 `.png` 字节），故出现"docx 正常、html/预览坏"的错位。
**修复**：三处统一取 `png.dataUri`。

（用户另反馈"web 端一直显示加载图表…"。经复现，当前 v1.1 构建下预览 `data-state=done` 正常；该症状属**本地未更新构建**——修复前的 id 冒号 bug 会让它停在 pending。已随本版重新构建。）

### 故障 4：在线图片在导出 HTML 中丢失
根因：`lib/emitter-html.mjs` 的 `imageTag()` **只处理 `data:` 开头**的图，遇到 `http(s)` 直接返回 `null` → `figure` 分支落到 `out += '<p>alt</p>'`，图只剩一行 alt 文字。DOCX 走 `lib/assets.mjs`（会 fetch/代理）故正常。
**修复（用户选 a+b 混合）**：
- **a**：取不到字节时**保留外链** `<img src="原URL" width height>`（浏览器打开 .html 仍可见），并记录 `imageExternalLink` 告警；
- **b**：能取到字节时（直连或同源代理）经 `reencodeImage` 后转 **base64 data URI 内嵌** → 导出的 .html 完全自包含、离线可看。
- `imageTag(src, alt)` 改为 `(src, alt)`，内部按 data / http(s) / 其他 三路处理，结果进 `imageCache`；新增 `bytesToBase64`（Buffer / btoa 双兼容）；`buildWordClipboardHtml` 增加 `options.fetchFn`（web 传 `webFetchImage` 代理回退版，CLI 传 node fetch）。
- `exportHtml` 补 `surfaceWarnings`（此前 HTML 导出的降级提示不上状态栏）。

### v1.2 验证矩阵（Playwright 真实交互）
| 检查 | 代理模式(5173) | 纯静态(5175) | CLI --html |
|---|---|---|---|
| 预览 mermaid | `state=done` + `data:image/png` | 同 | n/a |
| HTML mermaid | ✓ data URI（非 `[object Object]`） | ✓ | n/a |
| HTML 在线图 | ✓ 内嵌 data URI（271KB 自包含） | ✓ 内嵌（源站带 ACAO） | ✓ 内嵌（193KB） |
| HTML 无 ACAO 源 | — | ✓ 外链兜底 + 告警（不再 `<p>alt</p>`） | — |
| DOCX 回归 | drawings=2、media 2 文件 | 同 | nary=6、sty-undefined=False |
| 剪贴板 text/html | mermaid ✓ + 在线图 ✓ | 同 | n/a |
