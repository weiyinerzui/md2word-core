# md2word 打包与发布

本目录负责把 md2word 打包成**单文件可执行程序**（无需安装 Node.js），以及**在线体验版**。

## 一、产物形态

| 形态 | 文件 | 用户怎么用 |
|---|---|---|
| **双击即用本地 Web 版** | `md2word-win-x64.exe`（无参数） | 双击 → 自动打开浏览器 → 完整界面（含图片代理，外链图可直嵌） |
| **命令行版** | 同一个文件（带参数） | `md2word 输入.md -o 输出.docx --style zh` |
| **在线体验版** | EdgeOne Pages URL | 浏览器打开即用（纯静态；外链网图受 CORS 限制） |

当前在线版地址（v1.1.1 重新部署，2026-10-15）：
https://md2word-core-5wqovb40-edptemkd.edgeone.cool
首次访问会 302 到带 token 的会话链接（匿名部署的防盗链机制，直接跟随重定向即可）。

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

## 三、v1.1.0 缺陷复盘（已全部修复）

v1.1.0 的四个产物，其中三个是坏的，根源是打包链路里的四个独立缺陷：

| # | 缺陷 | 现象 | 修复 |
|---|---|---|---|
| 1 | `execFileSync(node_modules/.bin/postject.cmd)` 在 Windows 上抛 **EINVAL**（Node ≥ 18.20/20.12/22 禁止不带 shell 启动 .cmd/.bat），且错误被 try/catch 只打警告不失败 | **Windows exe 实为原版 node.exe（byte-identical）**，双击进 REPL/打印 node 帮助，Web 端打不开 | 改为 `process.execPath + postject/dist/cli.js` 直接调用；注入失败即 `exit(1)` |
| 2 | 校验 `buf.includes('NODE_SEA_BLOB')` —— 原版 node.exe 本身就含此字符串，**永远通过** | 上面的假产物顺利“验证”并发布 | 改为比对 blob 的 64 字节唯一前缀 + 同平台实跑 `--help` 断言输出 md2word 帮助 |
| 3 | SEA blob 由 CI 宿主的 Node 22.x 生成，注入基底是 **22.11.0** —— blob 序列化格式跨版本不兼容 | **linux/mac 产物运行即 segfault**（blob 反序列化拿到空指针） | build.mjs 下载同版本 Node 专用于 `--experimental-sea-config`，与基底严格同版 |
| 4 | macOS 未传 `--macho-segment-name NODE_SEA`，blob 落在默认 `__POSTJECT` 段，而运行时只认 **NODE_SEA** 段（node_sea.cc） | mac 产物即使注入成功也找不到 blob | mac 目标追加 `--macho-segment-name NODE_SEA`（已静态验证 section 落在 NODE_SEA 段） |

另外两个伴生修复：
- **Windows 本机交叉构建**：git-bash GNU tar 把盘符 `E:\` 当远程主机（“Cannot connect to E”）→ 优先 `Git\usr\bin\tar.exe --force-local`，System32 bsdtar 兜底（bsdtar 解 .tar.xz 会卡死、无符号链接权限时报错但文件已解出，均容错）。下载补了重试+超时。
- **openBrowser**：`spawn` ENOENT 是异步 `'error'` 事件，无监听器 → uncaught exception 杀进程（无 xdg-open 的 Linux 上一启动就崩）。已挂监听器，改提示用户手动访问 URL。

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
- **匿名部署有期限**：EdgeOne 匿名部署默认约 24 小时后回收——v1.1.0 的在线链接
  `md2word-dkbsoez8-gzyfrjyi` 已因此 404（也因当时的 claim token 误提交进 git 后又删除，无法再认领）。
  **部署后务必立即认领**（命令与网页链接都在部署输出里，有效期约 24 小时），
  例如 v1.1.1 的认领方式：

```
edgeone makers claim --sid 13ab5f675d0277701456b2a971e4ae66
# 或浏览器打开（需登录腾讯云账号）：
# https://console.cloud.tencent.com/edgeone/makers/claim?token=13ab5f675d0277701456b2a971e4ae66
```

认领后即变为长期项目，URL 稳定；后续更新只需重新 deploy 到同一 project。

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
