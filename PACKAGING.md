# md2word 打包与发布

本目录负责把 md2word 打包成**单文件可执行程序**（无需安装 Node.js），以及**在线体验版**。

## 一、产物形态

| 形态 | 文件 | 用户怎么用 |
|---|---|---|
| **双击即用本地 Web 版** | `md2word-win-x64.exe`（无参数） | 双击 → 自动打开浏览器 → 完整界面（含图片代理，外链图可直嵌） |
| **命令行版** | 同一个文件（带参数） | `md2word 输入.md -o 输出.docx --style zh` |
| **在线体验版** | EdgeOne Pages URL | 浏览器打开即用（纯静态；外链网图受 CORS 限制） |

**同一个可执行文件，按"有无参数"自动分流**：无参数 → 本地 Web 应用；带参数 → CLI。

## 二、本地打包

```bash
npm install
npm run build:web            # 先生成 web/dist
npm run build:bin            # 打包当前平台
npm run build:bin:all        # 三平台四架构
node pack/build.mjs --target win-x64          # 指定单个目标
node pack/build.mjs --target linux-x64,mac-arm64
```

产物在 `dist-bin/`：

```
md2word-win-x64.exe      约 92 MB
md2word-linux-x64        约 128 MB
md2word-mac-x64
md2word-mac-arm64
SHA256SUMS.txt
```

> **交叉编译**：Windows 目标是官方 `node.exe` 直接下载；Linux/macOS 需下载官方 tar 包解出 `bin/node`。
> 因此打包机需联网，且能访问 `nodejs.org`。

### 原理（Node SEA）

1. `esbuild` 把 `pack/entry.mjs` + `lib/` 打成单文件 CommonJS（Node SEA 的 blob 必须是 CJS）；
2. `node --experimental-sea-config` 生成 blob，**把整个 `web/dist`（约 5.7 MB，66 个文件）作为资源内嵌**；
3. `postject` 把 blob 注入官方 Node 可执行文件 → 单文件成品。

运行时通过 `node:sea` 的 `getAsset()` 读取内嵌资源，**无需外带任何文件**。

## 三、GitHub Actions 自动发布（推荐）

`.github/workflows/build-binaries.yml` 已配置：

- **推 tag**（如 `git tag v1.0.1 && git push --tags`）→ 三平台原生 runner 各自构建 → 自动创建 Release 并附上全部产物 + `SHA256SUMS.txt`；
- 也可在 Actions 页面手动 `Run workflow` 只构建不上传 Release。

为什么用 CI 而不是本机交叉编译：**只有原生 runner 才能真实运行自己产出的二进制**（Windows exe 在 Linux 上无法执行验证），CI 里每平台都会跑一次 `--help` 冒烟。

## 四、在线体验版

```bash
node build.mjs --online        # 生成 web/dist-online（纯静态，无 server.mjs）
npx -y edgeone makers deploy --anonymous web/dist-online
```

- **纯静态**：不含本地图片代理，外链网图导出受浏览器 CORS 限制（会降级为占位框/外链）；
- 页面右下角有引导横幅，提示需要完整功能请下载桌面版；
- **匿名部署有期限**：EdgeOne 匿名部署默认约 24 小时后回收，需 `claim` 认领为正式项目才能长期保留（认领链接见部署输出）。

## 五、用户下载后的注意事项

写进 Release 说明，也可复制到其他渠道：

**Windows**
- 首次运行可能被 **SmartScreen** 拦截（因为未做代码签名，非病毒）：
  点「更多信息」→「仍要运行」。
- 若被杀软误报（Node SEA 产物的常见误报）：加白名单即可。

**macOS**
- 首次打开提示"无法验证开发者"：**右键 → 打开**，或终端执行
  `xattr -dr com.apple.quarantine ./md2word-mac-arm64`

**Linux**
- `chmod +x md2word-linux-x64` 后运行。

## 六、体积说明

单文件约 92–128 MB，因为内嵌了完整 Node 运行时（这是"双击即用、免装 Node"的代价）。
如需更小体积，可改用 `@yao-pkg/pkg` 的压缩模式或 strip 调试符号（Linux 产物未 strip，可再省约 30%）。
