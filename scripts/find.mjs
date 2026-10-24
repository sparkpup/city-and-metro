#!/usr/bin/env node
/*
 * scripts/find.mjs — 定点检索（零依赖，只搜 js/ scripts/ docs/）
 *
 * 用法：
 *   node scripts/find.mjs <关键词>           搜 js/ scripts/ docs/，默认跳过 js/geo_*.js 与 js/data_*.js
 *   node scripts/find.mjs <关键词> --all     连内容/生成物一起搜
 *   node scripts/find.mjs 票 价             多个关键词按「同时命中」判定（AND）
 *
 * 为什么默认跳过 geo_/data_：那 15 个文件占仓库 83.7% 字节（geo 80.7% + data 3.0%），
 * 是生成物与城市内容，命中它们几乎总是噪声。要看城市内容请直接读 js/data_<id>.js 的对应章节。
 * 输出末尾会给「命中文件 + 该文件总行数」，行数就是后续 Read 的预算提示——不要整文件读。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const all = argv.includes('--all');
const words = argv.filter((a) => !a.startsWith('--'));
if (!words.length) { console.log('用法: node scripts/find.mjs <关键词> [<关键词2> ...] [--all]'); process.exit(2); }

const isContent = (rel) => /^js\/(geo|data)_[A-Za-z0-9_]+\.js$/.test(rel);
const walk = (dir, out) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|md|html|css|json)$/.test(e.name)) out.push(p);
  }
  return out;
};
const files = [];
for (const d of ['js', 'scripts', 'docs']) { const p = path.join(REPO, d); if (fs.existsSync(p)) walk(p, files); }

const needles = words.map((w) => w.toLowerCase());
let skipped = 0, hits = 0;
const touched = new Map();
for (const f of files) {
  const rel = path.relative(REPO, f).split(path.sep).join('/');
  if (!all && isContent(rel)) { skipped++; continue; }
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    if (!needles.every((n) => low.includes(n))) continue;
    hits++;
    touched.set(rel, lines.length);
    console.log(rel + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 160));
  }
}
console.log('--- 命中 ' + hits + ' 处，涉及 ' + touched.size + ' 个文件（括号内为文件总行数，按此预算 Read，勿整文件读）');
for (const [rel, n] of [...touched].sort((a, b) => b[1] - a[1])) console.log('    ' + rel + '  (' + n + ' 行)');
if (skipped) console.log('（已跳过 ' + skipped + ' 个内容/生成物文件，加 --all 可纳入）');
