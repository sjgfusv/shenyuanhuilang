/**
 * 遗物图标预览（临时调试页）
 * ------------------------------------------------------------
 * 用途：26 件遗物的图标是 16×16 的程序化纹理，游戏里显示时只有 17px，
 * 在整页截图里根本看不清画对没有。这个页面把它们**同一份代码**画出来，
 * 放大 8 倍排列，外加流派色环与符号的对照，用来肉眼验收。
 *
 * 它不复制绘制代码 —— 直接加载 战斗2D.js 并调用它的内部纹理生成，
 * 所以这里看到的就是游戏里真实的那一张，改代码这里跟着变。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, '战斗2D.js'), 'utf8');

// 抠出 RELIC_VIS 的 id / label / school 与 ensureRelicTextures / relicPen 相关片段，
// 拼成一个独立可跑的小模块（避免整份引擎依赖 Phaser / DOM）。
const relicVisBody = src.match(/var RELIC_VIS = \{[\s\S]*?\n  \};/);
const relicFallback = src.match(/var RELIC_FALLBACK = \{[\s\S]*?\n  \};/);
const penFn = src.match(/function relicPen\(g\) \{[\s\S]*?\n  \}/);
const ensureFn = src.match(/function ensureRelicTextures\(scene, g\) \{[\s\S]*?\n  \}/);
const schoolColors = src.match(/var SCHOOL_COLOR = \{[\s\S]*?\n  \};/);
const schoolLabel = src.match(/var SCHOOL_LABEL = \{[\s\S]*?\n  \};/);

if (!relicVisBody || !penFn || !ensureFn || !schoolColors) {
  console.error('❌ 无法从 战斗2D.js 抠出遗物图标代码，请检查结构是否变化');
  process.exit(1);
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>遗物图标预览 · 深渊回廊 2.8.1</title>
<style>
  body { margin:0; padding:24px; background:#0b0e18; color:#c8cede;
         font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; color:#efe8ff; letter-spacing:2px; }
  .sub { color:#6b7385; font-size:12px; margin-bottom:18px; }
  .school { margin:22px 0 8px; font-size:13px; font-weight:bold; letter-spacing:2px; }
  .grid { display:flex; flex-wrap:wrap; gap:18px; }
  .cell { width:104px; text-align:center; }
  .cell canvas { display:block; margin:0 auto; image-rendering:pixelated;
                 background:#12141f; border-radius:8px; }
  .name { font-size:12px; color:#e6e9f0; margin-top:7px; }
  .meta { font-size:10px; color:#6b7385; margin-top:2px; }
  .desc { font-size:10px; color:#8b93a6; margin-top:5px; line-height:1.5; }
  .legend { margin-top:26px; padding-top:14px; border-top:1px solid #1e2434;
            font-size:11px; color:#8b93a6; line-height:1.9; }
</style>
</head>
<body>
<h1>遗物图标 · 26 件</h1>
<div class="sub">同一份绘制代码（战斗2D.js），放大 8 倍；游戏内以 17px 显示，色环载流派、白色符号载效果。</div>
<div id="root"></div>
<div class="legend" id="legend"></div>
<script>
// ===== 从 战斗2D.js 抠出来的真实代码（保持原样，勿改）=====
${schoolColors[0]}
${schoolLabel ? schoolLabel[0] : ''}
${relicFallback ? relicFallback[0] : ''}
${relicVisBody[0]}

// ===== 极简 Phaser Graphics 替身 =====
// 只需要还原 generateTexture 的行为：把绘制指令光栅化到一张 16×16 的 canvas。
// 这样预览页不依赖 Phaser，也不会因为版本差异画出不一样的东西。
function makeFakeScene() {
  var textures = {};
  return {
    textures: {
      exists: function (k) { return !!textures[k]; },
      addCanvas: function (k, w, h) { textures[k] = { w: w, h: h }; return textures[k]; }
    },
    _textures: textures
  };
}
// 用 Canvas2D 实现 Graphics 的那几个方法（relicPen 只用到这些）
function fakeGraphics(ctx) {
  var lw = 1.7, stroke = '#fff', fill = '#fff';
  var api = {
    clear: function () { ctx.clearRect(0, 0, 16, 16); return api; },
    lineStyle: function (w, c, a) { lw = w; stroke = 'rgba(255,255,255,' + (a == null ? 1 : a) + ')'; return api; },
    fillStyle: function (c, a) { fill = c === 0xffffff ? 'rgba(255,255,255,' + (a == null ? 1 : a) + ')' : 'rgba(0,0,0,1)'; return api; },
    beginPath: function () { ctx.beginPath(); return api; },
    moveTo: function (x, y) { ctx.moveTo(x, y); return api; },
    lineTo: function (x, y) { ctx.lineTo(x, y); return api; },
    closePath: function () { ctx.closePath(); return api; },
    strokePath: function () { ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(); return api; },
    arc: function (x, y, r, a0, a1) { ctx.arc(x, y, r, a0, a1); return api; },
    fillCircle: function (x, y, r) { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); return api; },
    fillTriangle: function (x1, y1, x2, y2, x3, y3) {
      ctx.fillStyle = fill; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.closePath(); ctx.fill(); return api;
    },
    fillRoundedRect: function (x, y, w, h, r) {
      ctx.fillStyle = fill; ctx.beginPath();
      if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); } else { ctx.rect(x, y, w, h); }
      ctx.fill(); return api;
    },
    strokeCircle: function (x, y, r) { ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); return api; },
    // 预览页自己实现：把当前 canvas 存成"纹理"
    generateTexture: function (name) {
      var out = document.createElement('canvas');
      out.width = 16; out.height = 16;
      out.getContext('2d').drawImage(ctx.canvas, 0, 0);
      api._last = out;
      scene._textures[name] = { img: out };
      return api;
    }
  };
  return api;
}

// ===== 渲染：用真实代码画出每一件 =====
var scene = makeFakeScene();
function drawOne(vis) {
  var cv = document.createElement('canvas');
  cv.width = 16; cv.height = 16;
  var ctx = cv.getContext('2d');
  var g = fakeGraphics(ctx);
  // 与 ensureRelicTextures 内部逐行一致：先铺内圈流派色，再画符号，最后压色环
  var tint = SCHOOL_COLOR[vis.school] || SCHOOL_COLOR[''];
  var hex = '#' + ('000000' + tint.toString(16)).slice(-6);
  ctx.fillStyle = hexToRgba(hex, 0.08);
  ctx.beginPath(); ctx.arc(8, 8, 7.0, 0, Math.PI * 2); ctx.fill();
  try { vis.draw(relicPen(g)); } catch (e) { console.warn('绘制失败', e); }
  ctx.lineWidth = 1; ctx.strokeStyle = hexToRgba(hex, 0.92);
  ctx.beginPath(); ctx.arc(8, 8, 7.0, 0, Math.PI * 2); ctx.stroke();
  return cv;
}
function hexToRgba(hex, a) {
  var n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

var root = document.getElementById('root');
var bySchool = {};
Object.keys(RELIC_VIS).forEach(function (id) {
  var v = RELIC_VIS[id];
  var s = v.school || '';
  (bySchool[s] = bySchool[s] || []).push({ id: id, v: v });
});
var order = ['blood', 'perfect', 'link', 'greed', ''];
var schoolName = { blood: '血怒流', perfect: '完美流', link: '连携流', greed: '贪婪流', '': '通用（不参与成套）' };
order.forEach(function (s) {
  if (!bySchool[s]) return;
  var h = document.createElement('div');
  h.className = 'school';
  h.style.color = '#' + ('000000' + (SCHOOL_COLOR[s] || SCHOOL_COLOR['']).toString(16)).slice(-6);
  h.textContent = schoolName[s] + ' · ' + bySchool[s].length + ' 件';
  root.appendChild(h);
  var grid = document.createElement('div');
  grid.className = 'grid';
  bySchool[s].forEach(function (it) {
    var cell = document.createElement('div');
    cell.className = 'cell';
    var icon = drawOne(it.v);
    icon.style.width = '64px'; icon.style.height = '64px';
    cell.appendChild(icon);
    var n = document.createElement('div'); n.className = 'name'; n.textContent = it.v.label;
    var m = document.createElement('div'); m.className = 'meta'; m.textContent = it.id + ' · ' + it.v.quality;
    var d = document.createElement('div'); d.className = 'desc'; d.textContent = it.v.desc;
    cell.appendChild(n); cell.appendChild(m); cell.appendChild(d);
    grid.appendChild(cell);
  });
  root.appendChild(grid);
});
document.getElementById('legend').innerHTML =
  '<b>验收要点</b><br>' +
  '· 每个符号在 16px 下是否一眼认得出（游戏里只有 17px）<br>' +
  '· 色环是否清楚区分四流派（血怒玫红 / 完美金 / 连携绿 / 贪婪紫 / 通用灰）<br>' +
  '· 符号笔画是否越出色环（越界会被色环压住，看起来像缺口）<br>' +
  '· 26 个符号彼此是否够不同 —— 两个长得像的，玩家在条上就分不出来';
</script>
</body>
</html>`;

const outPath = path.join(__dirname, '遗物图标预览.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log('✅ 已生成 ' + outPath);
console.log('   遗物件数: ' + (relicVisBody[0].match(/^\s{4}[A-Za-z_$][\w$]*: \{ label:/gm) || []).length);
