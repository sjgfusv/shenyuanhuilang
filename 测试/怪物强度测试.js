/* ============================================================
   怪物强度回归（v2.8「全面加强敌人」）
   ------------------------------------------------------------
   为什么要有这个脚本：用户反馈「怪物太弱了」，而"弱"是个手感词 ——
   改数值之前必须先把**改了多少**变成可读的数字，否则下一轮调平衡只能靠猜。

   做法与 测试/房间节奏测试.js 一致：**从源码里正则抽出真实公式与常数**
   （不手抄一份），再按老版 2.6 的旧公式算一遍基线，两边对照。
   公式一旦被改回旧值、或者常数被写错，这里立刻红。

   运行：node 测试/怪物强度测试.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  \u2713 ' + msg); }
  else { fails++; console.log('  \u2717 ' + msg); }
};

/* ---------- 1. 从源码抽取常数 ---------- */

// 难度表（主程序.js）—— 纯对象字面量，直接求值
const mainSrc = read('主程序.js');
const dmMatch = mainSrc.match(/const difficultyModifiers = \{[\s\S]*?\n\};/);
if (!dmMatch) { console.error('✗ 找不到 difficultyModifiers'); process.exit(1); }
const DM = eval('(' + dmMatch[0].slice(dmMatch[0].indexOf('{'), dmMatch[0].lastIndexOf('}') + 1) + ')');

// 层数曲线（经典2D.js 的 enemyScaler）
const clsSrc = read('经典2D.js');
const baseM = clsSrc.match(/var base = floor \* ([\d.]+) \+ ([\d.]+);/);
const halfM = clsSrc.match(/var half = Math\.round\(floor \* ([\d.]+)\);/);
if (!baseM || !halfM) { console.error('✗ 找不到 enemyScaler 的层数曲线'); process.exit(1); }
const BASE_A = parseFloat(baseM[1]), BASE_B = parseFloat(baseM[2]);
const HALF_MUL = parseFloat(halfM[1]);

// 种类相对系数用到的两张表
const refM = clsSrc.match(/var TIER_REF = \{([^}]*)\};/);
if (!refM) { console.error('✗ 找不到 TIER_REF'); process.exit(1); }
const TIER_REF = eval('({' + refM[1] + '})');

// 敌种基数（战斗2D.js 的 ENEMY_TYPES）—— 只抽我们关心的几个
const enemySrc = read('战斗2D.js');
function typeBase(key) {
  const m = new RegExp(key + ':\\s*\\{[^}]*?hp:\\s*(\\d+),\\s*atk:\\s*(\\d+)').exec(enemySrc);
  return m ? { hp: +m[1], atk: +m[2] } : null;
}

console.log('============================================================');
console.log(' 怪物强度回归 · v2.8 全面加强');
console.log('============================================================\n');

console.log('【抽到的常数】');
console.log('  难度表 enemyHp/enemyAtk（easy/normal/hard/hell）: ' +
  ['easy', 'normal', 'hard', 'hell'].map(d => DM[d].enemyHp + '/' + DM[d].enemyAtk).join('  '));
console.log('  难度表 enemyAi.detect: ' +
  ['easy', 'normal', 'hard', 'hell'].map(d => d + '=' + (DM[d].enemyAi && DM[d].enemyAi.detect)).join('  '));
console.log('  层数曲线: base = floor×' + BASE_A + '+' + BASE_B + ' , half = round(floor×' + HALF_MUL + ')');
console.log('  TIER_REF: ' + JSON.stringify(TIER_REF));
['claw', 'guard', 'lord'].forEach(k => console.log('  ' + k + ': ' + JSON.stringify(typeBase(k))));
console.log('');

/* ---------- 2. 新旧公式 ---------- */

const OLD = { baseA: 2, baseB: 4, halfMul: 0.5 };
const OLD_DIFF = { easy: [0.9, 0.9], normal: [1, 1], hard: [1.15, 1.2], hell: [1.35, 1.4] };

/** 复刻 enemyScaler 的算法；old=true 时用老版 2.6 的旧曲线 */
function calc(diff, floor, tier, baseHp, baseAtk, old) {
  const A = old ? OLD.baseA : BASE_A;
  const B = old ? OLD.baseB : BASE_B;
  const H = old ? OLD.halfMul : HALF_MUL;
  const base = floor * A + B;
  const half = Math.round(floor * H);
  let hpBase, atkBase;
  if (tier === 'boss') { hpBase = base + 10; atkBase = 5 + half; }
  else if (tier === 'elite') { hpBase = base + 6; atkBase = 4 + half; }
  else { hpBase = base; atkBase = 3 + half; }
  const ref = TIER_REF[tier] || TIER_REF.normal;
  const kHp = baseHp / ref;
  const kAtk = 1 + (baseAtk / 4 - 1) * 0.5;
  const hpMul = old ? OLD_DIFF[diff][0] : (DM[diff].enemyHp || 1);
  const atkMul = old ? OLD_DIFF[diff][1] : (DM[diff].enemyAtk || 1);
  return {
    hp: Math.min(99999, Math.max(1, Math.round(hpBase * kHp * hpMul))),
    atk: Math.min(200, Math.max(1, Math.round(atkBase * kAtk * atkMul)))
  };
}

const pct = (o, n) => (o === 0 ? '—' : ((n / o - 1) * 100 >= 0 ? '+' : '') + ((n / o - 1) * 100).toFixed(0) + '%');
const FLOORS = [1, 5, 10, 20, 30, 50];

/* ---------- 3. 逐难度对照表 ---------- */

const claw = typeBase('claw');
console.log('【普通怪（黑暗爪牙）· 各难度 × 层数 —— 旧 → 新】');
console.log('  层数    简单            普通            困难            地狱');
FLOORS.forEach(f => {
  const cells = ['easy', 'normal', 'hard', 'hell'].map(d => {
    const o = calc(d, f, 'normal', claw.hp, claw.atk, true);
    const n = calc(d, f, 'normal', claw.hp, claw.atk, false);
    return (o.hp + '→' + n.hp + ' ' + pct(o.hp, n.hp)).padEnd(15);
  });
  console.log('  ' + String(f).padEnd(7) + cells.join(' '));
});
console.log('');

console.log('【普通怪攻击力 · 各难度 × 层数 —— 旧 → 新】');
console.log('  层数    简单            普通            困难            地狱');
FLOORS.forEach(f => {
  const cells = ['easy', 'normal', 'hard', 'hell'].map(d => {
    const o = calc(d, f, 'normal', claw.hp, claw.atk, true);
    const n = calc(d, f, 'normal', claw.hp, claw.atk, false);
    return (o.atk + '→' + n.atk + ' ' + pct(o.atk, n.atk)).padEnd(15);
  });
  console.log('  ' + String(f).padEnd(7) + cells.join(' '));
});
console.log('');

console.log('【精英 / 层主（正常难度）—— 旧 → 新】');
['guard', 'lord'].forEach(k => {
  const b = typeBase(k);
  const tier = k === 'lord' ? 'boss' : 'elite';
  const cells = FLOORS.map(f => {
    const o = calc('normal', f, tier, b.hp, b.atk, true);
    const n = calc('normal', f, tier, b.hp, b.atk, false);
    return f + '层 ' + o.hp + '→' + n.hp;
  });
  console.log('  ' + k.padEnd(7) + cells.join('  '));
});
console.log('');

/* ---------- 4. AI 层 ---------- */

console.log('【AI 侵略性（移速 / 前摇 / 后摇 / 索敌 倍率）】');
console.log('  难度    speed   windup  recover detect');
['easy', 'normal', 'hard', 'hell'].forEach(d => {
  const a = DM[d].enemyAi || {};
  console.log('  ' + d.padEnd(8) + String(a.speed).padEnd(8) + String(a.windup).padEnd(8) +
    String(a.recover).padEnd(8) + String(a.detect));
});
console.log('');

/* ---------- 5. 断言（回归护栏） ---------- */

console.log('【回归断言】');

// 曲线常数
ok(BASE_A === 2.5 && BASE_B === 5, '层数 HP 曲线 = floor×2.5+5（旧版是 ×2+4）');
ok(HALF_MUL === 0.62, '层数 ATK 曲线 = floor×0.62（旧版是 ÷2）');

// 难度档位必须严格递增 —— 调参最容易犯的错就是把两档调反
const order = ['easy', 'normal', 'hard', 'hell'];
let mono = true;
for (let i = 1; i < order.length; i++) {
  if (!(DM[order[i]].enemyHp > DM[order[i - 1]].enemyHp)) mono = false;
  if (!(DM[order[i]].enemyAtk > DM[order[i - 1]].enemyAtk)) mono = false;
}
ok(mono, '四档难度的 enemyHp / enemyAtk 严格递增（简单 < 普通 < 困难 < 地狱）');

// 每一档都要比旧版强（用户要求：所有难度下都加强）
let allUp = true;
const detail = [];
order.forEach(d => {
  const [oh, oa] = OLD_DIFF[d];
  const up = DM[d].enemyHp > oh && DM[d].enemyAtk > oa;
  if (!up) allUp = false;
  detail.push(d + ' +' + (((DM[d].enemyHp / oh) - 1) * 100).toFixed(0) + '%血/+' +
    (((DM[d].enemyAtk / oa) - 1) * 100).toFixed(0) + '%攻');
});
ok(allUp, '四档难度的敌人血量与攻击都高于旧版（' + detail.join('，') + '）');

// 逐档强度：第 1 层不能劝退、第 50 层必须有分量
const f1 = calc('normal', 1, 'normal', claw.hp, claw.atk, false);
const f50 = calc('normal', 50, 'normal', claw.hp, claw.atk, false);
ok(f1.hp >= 8 && f1.hp <= 14, '普通/第 1 层爪牙血量在 8~14（不让开局变磨）—— 实际 ' + f1.hp);
ok(f50.hp >= 150, '普通/第 50 层爪牙血量 ≥150（后期不再两三刀）—— 实际 ' + f50.hp);
ok(f50.atk >= 30, '普通/第 50 层爪牙攻击 ≥30 —— 实际 ' + f50.atk);

// 前摇下限护栏：引擎侧不能把 windup 压到完美闪避窗口附近
const hasFloor = /out\.windup = Math\.max\((\d+)/.exec(enemySrc);
ok(hasFloor && +hasFloor[1] >= 200,
  '引擎对前摇设了 ≥200ms 硬下限（完美闪避窗口 150ms，压到窗口附近就成了抽奖）—— 实际 ' +
  (hasFloor ? hasFloor[1] + 'ms' : '缺失'));
const hasRecoverFloor = /out\.recover = Math\.max\((\d+)/.exec(enemySrc);
ok(hasRecoverFloor && +hasRecoverFloor[1] >= 140, '引擎对后摇设了 ≥140ms 硬下限（留出反击的缝）');

// AI 在四档里也要单调
let aiMono = true;
for (let i = 1; i < order.length; i++) {
  const a = DM[order[i]].enemyAi, b = DM[order[i - 1]].enemyAi;
  if (!(a && b)) { aiMono = false; break; }
  if (!(a.detect > b.detect && a.windup < b.windup && a.recover < b.recover)) aiMono = false;
}
ok(aiMono, 'AI 侵略性随难度单调加强（索敌更远、前摇更短、后摇更短）');

// 索敌上限：不能让怪隔着半个房间冲过来，破坏「一个一个引」的节奏
ok(DM.hell.enemyAi.detect <= 1.5, '最高难度的索敌倍率 ≤1.5（引擎与宿主两侧都有这道闸）');

console.log('');
console.log('============================================================');
if (fails) { console.log('失败 ' + fails + ' 项 ✗'); process.exit(1); }
console.log('全部通过 ✓');
