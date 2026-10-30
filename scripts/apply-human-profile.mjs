#!/usr/bin/env node
// 把 config.human.yml 合并进 config.json。
//
//   node scripts/apply-human-profile.mjs --dry-run   只打印会改什么，不写盘
//   node scripts/apply-human-profile.mjs             备份后写入
//   node scripts/apply-human-profile.mjs --revert    还原最近一次备份
//
// 设计上只做三件事：校验键名、打印差异、备份后原子写入。
// 不做「整份覆盖」：config.human.yml 里没写的字段保持 config.json 原值。
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CONFIG = path.join(ROOT, 'config.json');
const OVERLAY = path.join(ROOT, 'config.human.yml');
const BACKUP_DIR = path.join(ROOT, '.local', 'backups');
const args = new Set(process.argv.slice(2));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    // 兼容 Windows 下带 BOM 的 UTF-8。
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(`读不了 ${path.relative(ROOT, file)}：${error.message}`);
  }
}

function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 把嵌套对象拍平成 a.b.c -> 值；数组整体当作一个值。 */
function flatten(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) flatten(child, dotted, out);
    else out.set(dotted, child);
  }
  return out;
}

function preview(value) {
  if (typeof value === 'string') {
    const oneLine = value.replace(/\s+/g, ' ');
    return oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine;
  }
  const text = JSON.stringify(value);
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

function latestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((name) => /^config-\d{8}-\d{6}\.json$/.test(name))
    .sort();
  return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null;
}

if (args.has('--help') || args.has('-h')) {
  console.log(`用法：
  node scripts/apply-human-profile.mjs --dry-run   预览差异
  node scripts/apply-human-profile.mjs             备份后写入 config.json
  node scripts/apply-human-profile.mjs --revert    还原最近一次备份

说明：只合并 config.human.yml 里出现的字段，其余保持原值。
写入后需要重启桥接（node src/bridge.js，或控制台 /api/restart）才会生效。`);
  process.exit(0);
}

if (args.has('--revert')) {
  const backup = latestBackup();
  if (!backup) fail(`没有找到备份（${path.relative(ROOT, BACKUP_DIR)}/config-*.json）`);
  fs.copyFileSync(backup, CONFIG);
  console.log(`✓ 已还原：${path.relative(ROOT, backup)} → config.json`);
  console.log('  记得重启桥接。');
  process.exit(0);
}

if (!fs.existsSync(OVERLAY)) fail(`找不到 ${path.relative(ROOT, OVERLAY)}`);
const config = readJson(CONFIG);
let overlay;
try {
  overlay = yaml.load(fs.readFileSync(OVERLAY, 'utf8'));
} catch (error) {
  fail(`config.human.yml 解析失败：${error.message}`);
}
if (!isPlainObject(overlay)) fail('config.human.yml 顶层必须是一个对象（键值对）');

const configFlat = flatten(config);
const overlayFlat = flatten(overlay);

const unknown = [...overlayFlat.keys()].filter((key) => !configFlat.has(key));
if (unknown.length) {
  fail(`config.json 里没有这些字段，可能拼错了：\n  ${unknown.join('\n  ')}\n`
    + '（如果是有意新增字段，先手工在 config.json 里加上空值再跑。）');
}

const changes = [];
for (const [key, next] of overlayFlat) {
  const prev = configFlat.get(key);
  if (JSON.stringify(prev) === JSON.stringify(next)) continue;
  changes.push({ key, prev, next });
}

if (!changes.length) {
  console.log('✓ config.json 已经是最新，没有需要改的字段。');
  process.exit(0);
}

console.log(`准备修改 ${changes.length} 个字段：\n`);
for (const { key, prev, next } of changes) {
  console.log(`  ${key}`);
  console.log(`    ${preview(prev)}  →  ${preview(next)}`);
}

if (args.has('--dry-run')) {
  console.log('\n（--dry-run：没有写入。去掉参数再跑一次就会落盘。）');
  process.exit(0);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = path.join(BACKUP_DIR, `config-${stamp}.json`);
fs.copyFileSync(CONFIG, backup);

for (const { key, next } of changes) {
  const parts = key.split('.');
  let cursor = config;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = next;
}

atomicWriteJson(CONFIG, config);
console.log(`\n✓ 已写入 config.json（备份：${path.relative(ROOT, backup)}）`);
console.log('  重启桥接后生效：node src/bridge.js，或在控制台点「重启桥接」。');
