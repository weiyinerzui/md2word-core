#!/usr/bin/env node
// ============================================================
// md2word — 打包为单文件可执行（Node SEA）
//
//   node pack/build.mjs                    为当前平台产出
//   node pack/build.mjs --target win-x64   交叉产出 Windows .exe（联网下载官方 node）
//   node pack/build.mjs --target linux-x64,mac-arm64
//   node pack/build.mjs --all              三平台四架构
//
// 原理：esbuild 把 pack/entry.mjs + lib/ 打成单 CJS → SEA blob（内嵌 web/dist 资源）
//       → postject 注入官方 node 可执行 → 单文件。
// 产物：dist-bin/md2word-<platform>-<arch>[.exe] + SHA256SUMS.txt
// ============================================================
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]pack$/, '');
const OUT = join(ROOT, 'dist-bin');
const TMP = join(ROOT, '.pack-tmp');
const DIST = join(ROOT, 'web', 'dist');
const NODE_VER = process.env.NODE_SEA_VER || 'v22.11.0';
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// Windows 提供裸 node.exe；Linux/macOS 只发布 tar 包，需下载后解出 bin/node
const TARGETS = {
  'win-x64':   { plat: 'win-x64',     tar: false, out: 'md2word-win-x64.exe',  url: `https://nodejs.org/dist/${NODE_VER}/win-x64/node.exe` },
  'linux-x64': { plat: 'linux-x64',   tar: true,  out: 'md2word-linux-x64',    url: `https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz` },
  'mac-x64':   { plat: 'darwin-x64',  tar: true,  out: 'md2word-mac-x64',      url: `https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-x64.tar.gz` },
  'mac-arm64': { plat: 'darwin-arm64', tar: true, out: 'md2word-mac-arm64',    url: `https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-arm64.tar.gz` },
};

const log = (...a) => console.log(...a);

// Windows 本机交叉解包（构建 linux/mac 目标）时的 tar 选择：
//  ① git-bash GNU tar（Git\usr\bin\tar.exe）+ --force-local —— 首选：
//     未加 --force-local 时 GNU tar 会把盘符路径 E:\… 误当远程主机（"Cannot connect to E"）。
//  ② System32 bsdtar 兜底（注意它解 .tar.xz 需外部 xz 过滤器，个别环境会卡死；
//     且无符号链接权限时报错但文件已解出 —— 调用方对非 0 退出码做了容错）。
// Linux/macOS 宿主机直接用系统 tar。
function tarCommand() {
  if (process.platform === 'win32') {
    const gnu = join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'tar.exe');
    if (existsSync(gnu)) return { cmd: gnu, args: ['--force-local'] };
    const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (existsSync(sys)) return { cmd: sys, args: [] };
    return { cmd: 'tar', args: ['--force-local'] }; // git-bash 的 GNU tar 在 PATH 里
  }
  return { cmd: 'tar', args: [] };
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function normalizeTarget(t) {
  const a = process.arch;
  const map = { win: `win-${a}`, windows: `win-${a}`, linux: `linux-${a}`, mac: `mac-${a}`, darwin: `mac-${a}` };
  return map[t] || t;
}
function currentTarget() {
  const p = { win32: 'win', linux: 'linux', darwin: 'mac' }[process.platform];
  return `${p}-${process.arch}`;
}

async function downloadWithRetry(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(240_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i === tries) throw new Error(`下载失败（已试 ${tries} 次）${url}：${(e && e.message) || e}`);
      log(`      第 ${i} 次下载失败（${(e && e.message) || e}），重试 …`);
    }
  }
}

async function fetchNodeBinary(t, spec) {
  const binName = spec.plat + (t === 'win-x64' ? '.exe' : '');
  const cachedPath = join(TMP, binName);
  if (existsSync(cachedPath)) { log(`      使用缓存 ${binName}`); return cachedPath; }
  log(`      下载 ${spec.url}`);
  const raw = await downloadWithRetry(spec.url);

  if (!spec.tar) {
    writeFileSync(cachedPath, raw);
    return cachedPath;
  }
  // tar.xz / tar.gz → 取出 bin/node
  const archive = join(TMP, `node-${spec.plat}` + (spec.url.endsWith('.xz') ? '.tar.xz' : '.tar.gz'));
  writeFileSync(archive, raw);
  const dir = join(TMP, `x-${spec.plat}`);
  mkdirSync(dir, { recursive: true });
  try {
    const t = tarCommand();
    execFileSync(t.cmd, [...t.args, '-x', '-f', archive, '-C', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // 非零退出码不一定致命（如 bsdtar 无符号链接权限）—— 继续靠下面的
    // existsSync(bin/node) 判定；真正缺文件时会带原因抛出。
    log(`      tar 非零退出（${String((e.stderr || e.message) || e).trim().slice(0, 120)}）—— 检查目标文件 …`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  // 解出的顶层目录名如 node-v22.11.0-linux-x64
  const top = readdirSync(dir).find((n) => n.startsWith('node-'));
  if (!top) throw new Error('tar 解包后未找到 node-* 目录');
  const extracted = join(dir, top, 'bin', 'node');
  if (!existsSync(extracted)) throw new Error(`未找到 ${extracted}`);
  writeFileSync(cachedPath, readFileSync(extracted));
  // writeFileSync 不保留可执行位 —— 此文件随后要被 execFileSync 执行（config node / 注入基底），
  // 缺 +x 时直接 EACCES（linux/mac CI 曾在此失败）。
  try { chmodSync(cachedPath, 0o755); } catch { /* win 平台无意义但无害 */ }
  return cachedPath;
}

function resolvePostject() {
  // 直接返回 cli.js 路径，由 process.execPath 运行。
  // 不要用 node_modules/.bin/postject.cmd：Windows 上 execFileSync 启动
  // .cmd/.bat 会抛 EINVAL（Node ≥ 18.20/20.12/22 的安全策略，无法绕过）。
  // v1.1.0 的 Windows 产物正是此缺陷：错误被吞掉，发布了一个未注入的原版 node.exe。
  const local = join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  if (existsSync(local)) return local;
  throw new Error('缺少 postject —— 请执行: npm install -D postject');
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

  let targets;
  if (argv.includes('--all')) targets = Object.keys(TARGETS);
  else if (get('--target')) targets = get('--target').split(',').map((t) => normalizeTarget(t.trim()));
  else targets = [currentTarget()];

  log(`md2word 打包 — 目标: ${targets.join(', ')}  (Node SEA ${NODE_VER})`);

  if (!existsSync(join(DIST, 'app.js'))) {
    console.error('✗ 未找到 web/dist/app.js —— 请先执行:  npm run build:web');
    process.exit(1);
  }

  let esbuild;
  try { ({ build: esbuild } = await import('esbuild')); }
  catch {
    console.error('✗ 缺少依赖 esbuild —— 请先执行:  npm install');
    process.exit(1);
  }

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  // 1) esbuild → 单 CJS
  log('\n[1/4] esbuild 打包 JS 内核 …');
  const bundlePath = join(TMP, 'md2word.cjs');
  await esbuild({
    entryPoints: [join(ROOT, 'pack', 'entry.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    outfile: bundlePath,
    legalComments: 'none',
    logLevel: 'warning',
    // Node 内置模块保持外部引用；其它（lib/、依赖）全部内联
    external: [],
  });
  log(`      内核 ${(statSync(bundlePath).size / 1024).toFixed(0)} KB`);

  // 2) SEA blob（内嵌 web/dist）
  log('[2/4] 生成 SEA blob（内嵌 web/dist 资源）…');
  const assets = {};
  for (const name of listFiles(DIST)) assets[name] = join(DIST, name);
  const seaConfigPath = join(TMP, 'sea-config.json');
  writeFileSync(seaConfigPath, JSON.stringify({
    main: bundlePath,
    output: join(TMP, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    assets,
  }, null, 2));
  // 生成 blob 的 Node 必须与基底二进制同版本 —— SEA blob 的序列化格式跨版本不兼容，
  // 版本不一致时目标运行期直接崩溃【segfault，无任何输出】。
  // v1.1.0 的 linux/mac 产物即是此缺陷：CI 的 setup-node（22.x 最新）与基底 22.11.0 不一致。
  // 故这里不用 process.execPath（宿主机任意版本），而是下载同版本 Node 专用于 config 步骤。
  const hostTarget = currentTarget();
  if (!TARGETS[hostTarget]) throw new Error(`宿主平台 ${hostTarget} 无官方 Node 发行物映射，无法生成同版本 blob`);
  const hostNode = await fetchNodeBinary(hostTarget, TARGETS[hostTarget]);
  log(`      config node: ${NODE_VER}（与基底同版本）`);
  execFileSync(hostNode, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });
  const blobPath = join(TMP, 'sea-prep.blob');
  log(`      blob ${(statSync(blobPath).size / 1024 / 1024).toFixed(2)} MB（含 ${Object.keys(assets).length} 个资源）`);

  // 3+4) 注入各平台
  const postjectCli = resolvePostject();
  mkdirSync(OUT, { recursive: true });
  const results = [];
  for (const t of targets) {
    const spec = TARGETS[t];
    if (!spec) { log(`  ⚠ 未知目标 ${t}，跳过`); continue; }
    log(`[3/4] ${t}: 获取 Node 二进制 …`);
    const basePath = await fetchNodeBinary(t, spec);
    const outPath = join(OUT, spec.out);
    writeFileSync(outPath, readFileSync(basePath));
    if (t !== 'win-x64') chmodSync(outPath, 0o755);
    log(`[4/4] ${t}: postject 注入 …`);
    const postjectArgs = [postjectCli, outPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SENTINEL, '--overwrite'];
    // macOS：Node 运行时只在 NODE_SEA 段里找 blob（node_sea.cc: macho_segment_name = "NODE_SEA"），
    // 不传该参数会注入到默认 __POSTJECT 段 → 运行时找不到 blob 而崩溃。
    if (t.startsWith('mac-')) postjectArgs.push('--macho-segment-name', 'NODE_SEA');
    try {
      execFileSync(process.execPath, postjectArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      // 注入失败即失败 —— 绝不能让未注入的原版 node.exe 混进产物（v1.1.0 教训）
      console.error(`✗ postject 注入失败（${t}）：${String((e.stderr || e.message) || e).slice(0, 400)}`);
      process.exit(1);
    }
    const size = (statSync(outPath).size / 1024 / 1024).toFixed(1);
    const sha = createHash('sha256').update(readFileSync(outPath)).digest('hex');
    results.push({ t, out: spec.out, size, sha });
    log(`      ✓ ${spec.out}  ${size} MB  sha256:${sha.slice(0, 16)}…`);
  }

  // 校验（任一失败即中止打包，绝不发布无效产物）：
  //   ① 真注入：产物必须包含 blob 的 64 字节唯一前缀。
  //      不能用 buf.includes('NODE_SEA_BLOB') —— 原版 node.exe 本身就含此字符串，会漏检
  //      （v1.1.0 Windows 产物为纯 node.exe，该检查照样通过）。
  //   ② 实跑（仅当前平台）：--help 必须输出 md2word 的帮助文本；
  //      未注入时它输出的是 node 自己的帮助（或双击进入 REPL），据此可直接判定。
  log('\n校验:');
  const blobHead = readFileSync(blobPath).subarray(0, 64);
  let failed = false;
  for (const r of results) {
    const buf = readFileSync(join(OUT, r.out));
    const injected = buf.includes(blobHead);
    const samePlat = currentTarget() === r.t;
    let ran = '（异平台，跳过实跑）';
    let ranOk = true;
    if (samePlat) {
      try {
        const v = execFileSync(join(OUT, r.out), ['--help'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        ranOk = /md2word — AI Markdown/.test(v);
        ran = ranOk ? '实跑 ✓' : '实跑异常（输出的是 node 帮助，未注入）';
      } catch { ranOk = false; ran = '实跑失败 ✗'; }
    }
    const ok = injected && ranOk;
    if (!ok) failed = true;
    log(`  ${r.out}: 注入 ${injected ? '✓' : '✗（疑似原版 node，未注入）'} | ${ran}`);
  }
  if (failed) {
    console.error('\n✗ 校验未通过 —— 存在无效产物，已中止（不写入 SHA256SUMS）');
    process.exit(1);
  }

  writeFileSync(join(OUT, 'SHA256SUMS.txt'), results.map((r) => `${r.sha}  ${r.out}`).join('\n') + '\n');
  log(`\n✓ 完成 → ${OUT}`);
}

main().catch((e) => { console.error('✗ 打包失败：', (e && e.stack) || e); process.exit(1); });
