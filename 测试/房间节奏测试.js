// ============================================================
// 深渊回廊 - 房间节奏回归（Node 脚本，不需要浏览器）
// ------------------------------------------------------------
// 背景（用户反馈）：
//   「游戏玩到后面房间长的根本跑不完，跑个好几分钟才能打一两只怪」
//
// 病根（已定位）：
//   ① 房间长度 `base = 1400 + floor * 140` **无上限** → 层 50 = 8400px、层 100 = 15400px
//   ② 普通房敌人数 `clamp(2 + floor/2 + ri(0,2), 2, 7)` 在**层 10 就封顶 7 只**
//   ③ 敌人出生区间从 `屏宽 + 60` 起、且第 0 只固定钉在 `屏宽 + 140`
//      → 进房后**整块第一屏永远是空的**，每次都要先白跑一屏
//   ①②一组合，密度从每 200px 一只崩到每 1000px 以上一只 → 满房空走廊
//
// 本脚本做什么：
//   从**源文件里正则抽取真实的房间生成公式**（不是复刻一遍，公式改了这里就报错），
//   把冻结的旧版 `老版2.6/试炼2D.js` 当 baseline，与本版 `战斗2D.js` 逐层对照，
//   输出「房间长度 / 敌人数 / 跑到第一只怪的距离 / 平均怪间距 / 一屏能看到几只」。
//
//   ⚠️ 两种视口都要看：房间长度有 `W×2` 这个下限，所以**桌面端房间反而更长**
//   （1920 屏 → 3840px），手机横屏（800px）才是 1600。只测手机尺寸会漏掉主场景。
//
// 用法：node 测试/房间节奏测试.js
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OLD_FILE = '老版2.6/试炼2D.js';   // 冻结的旧公式 = baseline
const NEW_FILE = '战斗2D.js';           // 当前版本

function readSrc(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) throw new Error('找不到源文件：' + rel);
  return fs.readFileSync(p, 'utf8');
}

/** 正则抽取一段真实公式；抽不到就报错，绝不静默退回"猜的公式" */
function grab(src, re, label) {
  const m = src.match(re);
  if (!m) throw new Error('公式抽取失败（源文件结构可能变了）：' + label);
  return m[0].trim();
}

/* ------------------------------------------------------------
   从两个源文件里抽取各自的房间节奏公式
   ------------------------------------------------------------ */
function extractOld(src) {
  return {
    base:       grab(src, /var base = 1400 \+ this\.floor \* 140;/, '旧 base'),
    levelWidth: grab(src, /this\.levelWidth = Math\.max\(nonCombat \? Math\.round\(W \* 0\.85\) : W \* 2, base\);/, '旧 levelWidth'),
    count:      grab(src, /n = clamp\(2 \+ Math\.floor\(floor \/ 2\) \+ ri\(0, 2\), 2, 7\);/, '旧 敌人数'),
    spanStart:  grab(src, /var spanStart = self\.scale\.width \+ 60;/, '旧 spanStart'),
    spanEnd:    grab(src, /var spanEnd = Math\.max\(spanStart \+ 40, self\.levelWidth - 100\);/, '旧 spanEnd'),
    // 旧版第 0 只怪固定钉在这里，不参与均分
    firstX:     grab(src, /var baseX = this\.scale\.width \+ 140;/, '旧 首怪固定点'),
    hasWant:    false
  };
}

function extractNew(src) {
  return {
    base:       grab(src, /var base = Math\.min\(1400 \+ this\.floor \* 90, 2200\);/, '新 base'),
    levelWidth: grab(src, /this\.levelWidth = Math\.max\(nonCombat \? Math\.round\(W \* 0\.85\) : W \* 2, base\);/, '新 levelWidth'),
    want:       grab(src, /var want = clamp\(Math\.round\(this\.levelWidth \/ 240\), 4, 9\);/, '新 数量上限 want'),
    byFloor:    grab(src, /var byFloor = 2 \+ Math\.floor\(floor \/ 2\);/, '新 byFloor'),
    bySize:     grab(src, /var bySize = Math\.round\(this\.levelWidth \/ 700\);/, '新 bySize'),
    count:      grab(src, /n = clamp\(Math\.max\(byFloor, bySize\) \+ ri\(0, 2\), 2, want\);/, '新 敌人数'),
    spanStart:  grab(src, /var spanStart = Math\.round\(self\.scale\.width \* 0\.45\);/, '新 spanStart'),
    spanEnd:    grab(src, /var spanEnd = Math\.max\(spanStart \+ 40, self\.levelWidth - 120\);/, '新 spanEnd'),
    hasWant:    true
  };
}

/* ------------------------------------------------------------
   把抽出来的公式编译成可调用函数（`this.` / `self.` 一律还原成裸变量）
   ------------------------------------------------------------ */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// ri(a,b) 是整数随机，取中值当期望值（本脚本算的是期望节奏，不是某一次随机结果）
const ri = (a, b) => Math.round((a + b) / 2);

function compile(expr, argNames) {
  let e = expr.trim().replace(/;$/, '');
  // 抽到的是语句（`var base = …` / `this.levelWidth = …`），剥掉左值只留表达式
  const m = e.match(/^(?:var\s+\w+|(?:this|self)\.\w+)\s*=\s*([\s\S]*)$/);
  if (m) e = m[1];
  e = e.replace(/\b(this|self)\./g, '');
  return new Function(...argNames, 'clamp', 'ri', 'return (' + e + ');');
}

/** 编译 + 立刻求值：argNames 声明参数，clamp / ri 由本模块注入 */
function call(expr, argNames, ...vals) {
  return compile(expr, argNames)(...vals, clamp, ri);
}

/** 算一层的房间节奏（非战斗房不在本次关注的"跑很久"范围内，只算普通战斗房） */
function simulate(F, floor, W) {
  const scale = { width: W };

  const base = call(F.base, ['floor'], floor);
  const nonCombat = false;   // 只看普通战斗房
  const levelWidth = call(F.levelWidth, ['W', 'base', 'nonCombat'], W, base, nonCombat);

  // 敌人数
  let n;
  if (F.hasWant) {
    const want = call(F.want, ['levelWidth'], levelWidth);
    const byFloor = call(F.byFloor, ['floor'], floor);
    const bySize = call(F.bySize, ['levelWidth'], levelWidth);
    n = call(F.count, ['byFloor', 'bySize', 'want'], byFloor, bySize, want);
  } else {
    n = call(F.count, ['floor'], floor);
  }

  // 敌人横向分布
  const spanStart = call(F.spanStart, ['scale'], scale);
  const spanEnd = call(F.spanEnd, ['spanStart', 'levelWidth'], spanStart, levelWidth);
  const step = (spanEnd - spanStart) / Math.max(1, n);

  // 旧版把第 0 只钉在固定点（不参与均分），新版全员均分 —— 首怪位置就是最大差别
  const firstX = F.firstX ? call(F.firstX, ['scale'], scale) : spanStart + step * 0.5;

  const heroX = 140;                       // 玩家进房出生点（buildLevel 里写死 140）
  const gap = n > 1 ? (spanEnd - spanStart) / n : 0;

  return {
    floor, levelWidth, n,
    screens: +(levelWidth / W).toFixed(2),
    firstX: Math.round(firstX),
    firstDist: Math.round(firstX - heroX),  // 进房后要跑多远才遇到第一只怪
    gap: Math.round(gap),                   // 平均每只怪的间距
    perScreen: +(W / Math.max(1, gap)).toFixed(1)  // 一屏内大致能看到几只怪
  };
}

/* ------------------------------------------------------------
   输出
   ------------------------------------------------------------ */
const pad = (s, w) => String(s).padStart(w);
const FLOORS = [1, 3, 5, 10, 20, 30, 50, 100];

// 手机横屏实测画布（800×360，DPR3 → 2400×1080）；桌面用本机浏览器实测的 1920
const VIEWPORTS = [
  { name: '手机横屏', W: 800 },
  { name: '桌面',     W: 1920 }
];

const OLD = extractOld(readSrc(OLD_FILE));
const NEW = extractNew(readSrc(NEW_FILE));

const allRows = [];
for (const vp of VIEWPORTS) {
  console.log('\n' + '='.repeat(100));
  console.log('视口：' + vp.name + '  W = ' + vp.W + 'px        旧 = ' + OLD_FILE + '（冻结 baseline）    新 = ' + NEW_FILE);
  console.log('='.repeat(100));

  const rows = FLOORS.map(f => ({ f, o: simulate(OLD, f, vp.W), n: simulate(NEW, f, vp.W) }));
  allRows.push({ vp, rows });

  const head = '  层' + pad('房间长', 9) + pad('屏数', 7) + pad('敌数', 6) + pad('跑到首怪', 10) + pad('怪间距', 9) + pad('一屏可见', 10);
  console.log('\n  【旧版 baseline】');
  console.log(head + '  评价');
  for (const { f, o } of rows) {
    const verdict = o.gap > 700 ? '  ← 空走廊，跑半天' : (o.firstDist > vp.W ? '  ← 进房先白跑一屏' : '');
    console.log('  ' + pad(f, 3) + pad(o.levelWidth + 'px', 9) + pad(o.screens, 7) + pad(o.n, 6)
      + pad(o.firstDist + 'px', 10) + pad(o.gap + 'px', 9) + pad(o.perScreen, 10) + verdict);
  }

  console.log('\n  【新版修复后】');
  console.log(head + '  评价');
  for (const { f, n } of rows) {
    const verdict = n.gap > 700 ? '  ← 空走廊！' : (n.gap > 550 ? '  ← 偏空' : '  ← 节奏正常');
    console.log('  ' + pad(f, 3) + pad(n.levelWidth + 'px', 9) + pad(n.screens, 7) + pad(n.n, 6)
      + pad(n.firstDist + 'px', 10) + pad(n.gap + 'px', 9) + pad(n.perScreen, 10) + verdict);
  }

  console.log('\n  【逐层变化（旧 → 新）】');
  for (const { f, o, n } of rows) {
    const d = (a, b) => (b - a >= 0 ? '+' : '') + (b - a);
    console.log('  层 ' + pad(f, 3) + '  长度 ' + pad(o.levelWidth, 6) + ' → ' + pad(n.levelWidth, 6) + ' (' + d(o.levelWidth, n.levelWidth) + ')'
      + '   间距 ' + pad(o.gap, 5) + ' → ' + pad(n.gap, 5) + ' (' + d(o.gap, n.gap) + ')'
      + '   首怪 ' + pad(o.firstDist, 5) + ' → ' + pad(n.firstDist, 5) + ' (' + d(o.firstDist, n.firstDist) + ')');
  }
}

/* ------------------------------------------------------------
   断言：把"用户不再需要长跑"这件事变成可回归的硬指标
   ------------------------------------------------------------ */
console.log('\n' + '='.repeat(100));
let failed = 0;
function assert(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed++;
}

for (const { vp, rows } of allRows) {
  const tag = '[' + vp.name + '] ';
  const deep = simulate(NEW, 100, vp.W);
  const deep50 = simulate(NEW, 50, vp.W);

  // ① 房间长度不再随层数无限膨胀（封顶生效）
  assert(deep.levelWidth === deep50.levelWidth,
    tag + '层 100 与层 50 等长（' + deep.levelWidth + 'px），长度不再随层数增长');
  assert(deep.screens <= 2.8,
    tag + '最深层房间 ' + deep.screens + ' 屏（旧版层 100 为 ' + simulate(OLD, 100, vp.W).screens + ' 屏）');

  // ② 每一层的密度都不再崩（本次的核心指标）
  for (const { f, n } of rows) {
    assert(n.gap <= 550,
      tag + '层 ' + pad(f, 3) + ' 怪间距 ' + pad(n.gap, 4) + 'px ≤ 550px（一屏可见 ' + n.perScreen + ' 只）');
  }

  // ③ 进房不再白跑一屏：首怪落在屏幕内
  for (const { f, n } of rows) {
    assert(n.firstX <= vp.W,
      tag + '层 ' + pad(f, 3) + ' 首怪 x=' + pad(n.firstX, 4) + ' 在屏幕内（旧版固定 ' + (vp.W + 140) + '）');
  }

  // ④ 后期怪数量确实顶到了上限（不是被 7 只卡住）
  assert(deep.n >= 9, tag + '层 100 出怪 ' + deep.n + ' 只（旧版封顶 7 只）');
}

// ⑤ 手机端前期手感不被改重
const m1 = simulate(NEW, 1, 800);
const m1old = simulate(OLD, 1, 800);
assert(Math.abs(m1.n - m1old.n) <= 2,
  '[手机横屏] 层 1 出怪 ' + m1.n + ' 只，与旧版 ' + m1old.n + ' 只基本一致（前期难度未被改重）');

console.log('='.repeat(100));
console.log(failed === 0 ? '全部通过 ✓' : failed + ' 项失败 ✗');
process.exit(failed === 0 ? 0 : 1);
