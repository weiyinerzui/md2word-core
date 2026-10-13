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
