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

async function fetchNodeBinary(t, spec) {
  const binName = spec.plat + (t === 'win-x64' ? '.exe' : '');
  const cachedPath = join(TMP, binName);
  if (existsSync(cachedPath)) { log(`      使用缓存 ${binName}`); return cachedPath; }
  log(`      下载 ${spec.url}`);
  const res = await fetch(spec.url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${spec.url}`);
  const raw = Buffer.from(await res.arrayBuffer());

  if (!spec.tar) {
    writeFileSync(cachedPath, raw);
    return cachedPath;
  }
  // tar.xz / tar.gz → 取出 bin/node
  const archive = join(TMP, `node-${spec.plat}` + (spec.url.endsWith('.xz') ? '.tar.xz' : '.tar.gz'));
  writeFileSync(archive, raw);
  // 用系统 tar（Linux/macOS/Windows10+ 均自带；Windows 交叉构建 Linux 时也可用）
  const dir = join(TMP, `x-${spec.plat}`);
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', dir], { stdio: 'ignore' });
  // 解出的顶层目录名如 node-v22.11.0-linux-x64
  const top = readdirSync(dir).find((n) => n.startsWith('node-'));
  if (!top) throw new Error('tar 解包后未找到 node-* 目录');
  const extracted = join(dir, top, 'bin', 'node');
  if (!existsSync(extracted)) throw new Error(`未找到 ${extracted}`);
  writeFileSync(cachedPath, readFileSync(extracted));
  return cachedPath;
}

async function resolvePostject() {
  const local = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'postject.cmd' : 'postject');
  if (existsSync(local)) return local;
  throw new Error('缺少 postject —— 请执行: npm install -D postject');
}

function countOccurrences(buf, needle) {
  const n = Buffer.from(needle);
  let c = 0, i = 0;
  while ((i = buf.indexOf(n, i)) !== -1) { c++; i += n.length; }
  return c;
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
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });
  const blobPath = join(TMP, 'sea-prep.blob');
  log(`      blob ${(statSync(blobPath).size / 1024 / 1024).toFixed(2)} MB（含 ${Object.keys(assets).length} 个资源）`);

  // 3+4) 注入各平台
  const postject = await resolvePostject();
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
    try {
      execFileSync(postject, [outPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SENTINEL, '--overwrite'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      log(`      ⚠ postject 输出: ${String(e.stderr || e.message).slice(0, 240)}`);
    }
    const size = (statSync(outPath).size / 1024 / 1024).toFixed(1);
    const sha = createHash('sha256').update(readFileSync(outPath)).digest('hex');
    results.push({ t, out: spec.out, size, sha });
    log(`      ✓ ${spec.out}  ${size} MB  sha256:${sha.slice(0, 16)}…`);
  }

  // 校验：实跑产物（仅当前平台可执行；跨平台仅静态检查 blob 段存在）
  log('\n校验:');
  for (const r of results) {
    const buf = readFileSync(join(OUT, r.out));
    const hasBlob = buf.includes(Buffer.from('NODE_SEA_BLOB'));
    const samePlat = currentTarget() === r.t;
    let ran = '（异平台，跳过实跑）';
    if (samePlat) {
      try {
        const v = execFileSync(join(OUT, r.out), ['--help'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        ran = /md2word — AI Markdown/.test(v) ? '实跑 ✓' : '实跑异常';
      } catch { ran = '实跑失败 ✗'; }
    }
    log(`  ${r.out}: SEA 段 ${hasBlob ? '✓' : '✗'} | ${ran}`);
  }

  writeFileSync(join(OUT, 'SHA256SUMS.txt'), results.map((r) => `${r.sha}  ${r.out}`).join('\n') + '\n');
  log(`\n✓ 完成 → ${OUT}`);
}

main().catch((e) => { console.error('✗ 打包失败：', (e && e.stack) || e); process.exit(1); });
