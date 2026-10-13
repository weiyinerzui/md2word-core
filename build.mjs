// ============================================================
// md2word — web 构建脚本
//   node build.mjs          → web/dist（可直接 http 服务打开）
// 产出：app.js(ESM, mermaid 外置) + katex css/fonts + 样式 + 示例
// ============================================================
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'web', 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1) 应用包
await build({
  entryPoints: [join(root, 'web', 'app.mjs')],
  bundle: true,
  format: 'esm',
  target: ['chrome110', 'firefox115', 'safari16'],
  outfile: join(dist, 'app.js'),
  minify: true,
  sourcemap: false,
  external: ['mermaid'],
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

console.log(`✓ web/dist 构建完成 → ${dist}`);
console.log('  预览：  python3 -m http.server 5173 -d web/dist   （浏览器打开 http://localhost:5173）');
