// ============================================================
// md2word — web 构建脚本
//   node build.mjs          → web/dist（静态可开；外链图直嵌导出需 npm start）
// 产出：app.js(mermaid 已打包) + katex css/fonts + 样式 + 示例 + server.mjs
// ============================================================
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 依赖以动态导入引入：缺失时给出带指引的提示，而不是裸堆栈
let build;
try {
  ({ build } = await import('esbuild'));
} catch {
  console.error([
    '✗ 依赖尚未安装：找不到 esbuild。',
    '',
    '  原因：node_modules/ 不入 Git（.gitignore），克隆后需先安装依赖：',
    '',
    '    npm install',
    '',
    '  （首次约 1–2 分钟；完成后再执行 npm run build:web）',
  ].join('\n'));
  process.exit(1);
}

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'web', 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1) 应用包（mermaid 一并打包：离线可用、免 CDN）
await build({
  entryPoints: [join(root, 'web', 'app.mjs')],
  bundle: true,
  format: 'esm',
  target: ['chrome110', 'firefox115', 'safari16'],
  outfile: join(dist, 'app.js'),
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});

// 2) KaTeX 样式 + 字体（离线自带）
mkdirSync(join(dist, 'assets'), { recursive: true });
cpSync(join(root, 'node_modules', 'katex', 'dist', 'katex.min.css'), join(dist, 'assets', 'katex.min.css'));
cpSync(join(root, 'node_modules', 'katex', 'dist', 'fonts'), join(dist, 'assets', 'fonts'), { recursive: true });

// 3) 壳与静态资源
cpSync(join(root, 'web', 'index.html'), join(dist, 'index.html'));
cpSync(join(root, 'web', 'style.css'), join(dist, 'style.css'));
cpSync(join(root, 'samples', 'ai-demo.md'), join(dist, 'sample.md'));
if (existsSync(join(root, 'web', 'favicon.svg'))) cpSync(join(root, 'web', 'favicon.svg'), join(dist, 'favicon.svg'));

// dist 里 app.js 由 <script src> 载入 → 改 module 引入（保留 importmap 动态能力）
const html = readFileSync(join(dist, 'index.html'), 'utf-8');
writeFileSync(join(dist, 'index.html'), html.replace('<script src="app.js">', '<script type="module" src="app.js">'));

// 4) 静态托管 + 同源图片代理（复制 server.mjs 到 dist，dist 可独立分发）
if (existsSync(join(root, 'web', 'server.mjs'))) cpSync(join(root, 'web', 'server.mjs'), join(dist, 'server.mjs'));

console.log(`✓ web/dist 构建完成 → ${dist}（app.js ${(readFileSync(join(dist, 'app.js'), 'utf8').length / 1048576).toFixed(2)} MB）`);
console.log('  预览：  npm start                       （推荐：带同源图片代理，外链图可直嵌）');
console.log('  静态：  python3 -m http.server 5173 -d web/dist   （零依赖；外链图导出仅占位框提示）');

