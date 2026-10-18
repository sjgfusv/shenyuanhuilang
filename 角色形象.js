/**
 * 角色形象（Character art）
 * ============================================================
 * 试炼 2D 里所有会动的角色的专属形象：9 位英雄 + 10 种怪物。
 * 全部由代码绘制，无外部素材；网格与试炼2D.js 一致（CELL = 64，脚底 y = 60）。
 *
 * 设计原则（沿用既有的像素世界，不做风格替换）
 *   · 剪影优先 —— 64px 高、快速移动时唯一能瞬间读懂的是轮廓：
 *     体型高低胖瘦 → build；头饰外轮廓 → head；武器轮廓 → weapon / offhand
 *   · 配色即身份 —— 每个角色的主色与其技能特效、HUD 语义色同源
 *     （紫=奥术 / 绿=游侠 / 青=守护与贤者 / 金=神圣与精英 / 玫红=深渊爪牙 / 血红=层主）
 *   · 一套部件库拼出 19 个角色：head / weapon / offhand / legs / extras，
 *     共享代码却互不相似；新增角色只需加一行参数
 *   · 远程攻击沿用同一套做法：弹药（箭 / 奥术弹 / 灵能波 / 长矛）也由代码画出，
 *     颜色取自施放者的 acc —— 谁射出来的，一眼可辨
 *
 * 对外接口（window.角色形象）
 *   LOOKS                     全部角色参数表
 *   RANGED                    远程英雄的弹药定义（kind 外观 + name 招式名 + color 取色）
 *   MOB_SHOTS                 怪物的远程弹药定义（骷髅骑兵掷矛等）
 *   ensureHeroTexture(scene, heroId)        英雄精灵表（14 帧）
 *   ensureMobTexture(scene, mobKey, mirrorOf) 怪物精灵表（7 帧；镜像怪传玩家英雄 id 即照玩家造型）
 *   ensureShotTexture(scene, kind, color)   弹药精灵表（按外观 + 颜色缓存）
 *   heroAnimKeys / mobAnimKeys              动画 key 命名
 *   shotAnimKey(kind, color)                弹药动画 key
 *   canvasGraphics(ctx)                     给预览页用的 Canvas2D 兼容层
 */
(function (global) {
  'use strict';

  var CELL = 64;
  var HERO_FRAMES = 15;   // 0-1 idle · 2-5 run · 6 jump · 7 fall · 8-10 attack · 11 hurt · 12 dead · 13 roll · 14 guard
  var MOB_FRAMES = 7;     // 0-1 walk · 2-3 attack · 4 hurt · 5-6 dead

  // ============================================================
  //  绘制小工具（只使用 Phaser Graphics 与兼容层共有的方法）
  // ============================================================
  function rect(g, c, a, x, y, w, h) { g.fillStyle(c, a); g.fillRect(x, y, w, h); }
  function rrect(g, c, a, x, y, w, h, r) { g.fillStyle(c, a); g.fillRoundedRect(x, y, w, h, r); }
  function circ(g, c, a, x, y, r) { g.fillStyle(c, a); g.fillCircle(x, y, r); }
  function tri(g, c, a, x1, y1, x2, y2, x3, y3) { g.fillStyle(c, a); g.fillTriangle(x1, y1, x2, y2, x3, y3); }
  function ell(g, c, a, x, y, w, h) { g.fillStyle(c, a); g.fillEllipse(x, y, w, h); }
  function seg(g, w, c, a, x1, y1, x2, y2) {
    g.lineStyle(w, c, a); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.strokePath();
  }
  function srect(g, w, c, a, x, y, ww, h, r) {
    g.lineStyle(w, c, a); g.strokeRoundedRect(x, y, ww, h, r);
  }
  function box(g, c, a, x, y, w, h, r) {   // 主体块 + 顶部高光（所有角色共用的立体感来源）
    rrect(g, c, a, x, y, w, h, r);
    rrect(g, 0xffffff, 0.12 * a, x + 1, y + 1, w - 2, Math.max(1, h * 0.22), Math.max(1, r - 1));
  }
  function dk(c, f) {   // 颜色加深（部件阴影用）
    var r = (c >> 16) & 255, gg = (c >> 8) & 255, b = c & 255;
    r = Math.round(r * f); gg = Math.round(gg * f); b = Math.round(b * f);
    return (r << 16) | (gg << 8) | b;
  }
  function lt(c, f) {
    var r = (c >> 16) & 255, gg = (c >> 8) & 255, b = c & 255;
    r = Math.min(255, Math.round(r + (255 - r) * f));
    gg = Math.min(255, Math.round(gg + (255 - gg) * f));
    b = Math.min(255, Math.round(b + (255 - b) * f));
    return (r << 16) | (gg << 8) | b;
  }

  // ============================================================
  //  角色参数表
  //  build:  bw 躯干宽 · bh 躯干高 · headR 头半径 · hip 胯部 y · shoulder 肩宽加成
  //  head:   头饰类型（决定剪影上半部）
  //  weapon / offhand: 武器与副手（决定剪影两侧）
  //  legs:   legs 双腿 · robe 长袍 · wisp 黑雾下摆 · lava 熔岩底座 · beast 四足 · bones 骨腿
  //  extras: cape 披风 · plume 顶羽 · quiver 箭袋 · orb 宝珠 · scroll 卷轴 · halo 光环
  //          aura 暗影光晕 · cracks 裂缝发光 · spines 背刺 · tails 影尾 · ribs 肋骨
  //          tatter 破布 · fur 毛皮 · scars 战痕 · outline 紫色描边（镜像怪）
  // ============================================================
  var LOOKS = {

    // ---------------- 英雄（9 位）----------------
    warrior: {
      kind: 'hero', className: '战士 · 重甲长剑',
      build: { bw: 26, bh: 23, headR: 9, hip: 47, shoulder: 5 },
      colors: { main: 0x4a90d9, sub: 0x2a5a8a, acc: 0xffe08a, skin: 0xf0c8a0, dark: 0x16233c, cape: 0x9b2a4a },
      head: 'helm', weapon: 'sword', offhand: 'roundShield', legs: 'legs',
      extras: ['cape']
    },
    guardian: {
      kind: 'hero', className: '守护者 · 塔盾壁垒',
      build: { bw: 27, bh: 22, headR: 9, hip: 46, shoulder: 6 },
      colors: { main: 0xb08a4a, sub: 0x6a5030, acc: 0x5fd0e0, skin: 0xd8b088, dark: 0x241a10, cape: 0x5a3a20 },
      head: 'greathelm', weapon: null, offhand: 'towerShield', legs: 'legs',
      extras: ['plume']
    },
    paladin: {
      kind: 'hero', className: '圣骑士 · 圣光剑',
      build: { bw: 25, bh: 24, headR: 9, hip: 47, shoulder: 4 },
      colors: { main: 0xe8e0c0, sub: 0xc8a040, acc: 0xffe08a, skin: 0xf0c8a0, dark: 0x4a3a1a, cape: 0xf0e8d0 },
      head: 'wingHelm', weapon: 'glowSword', offhand: null, legs: 'legs',
      extras: ['cape', 'halo']
    },
    ranger: {
      kind: 'hero', className: '游侠 · 长弓',
      build: { bw: 21, bh: 22, headR: 8, hip: 49, shoulder: 2 },
      colors: { main: 0x3a7a4a, sub: 0x1e4a2a, acc: 0x9fe0c0, skin: 0xe8c0a0, dark: 0x10240f, cape: 0x6a5a3a },
      head: 'featherCap', weapon: 'bow', offhand: null, legs: 'legs',
      extras: ['quiver', 'cloakShort']
    },
    rogue: {
      kind: 'hero', className: '刺客 · 双匕',
      build: { bw: 19, bh: 21, headR: 8, hip: 50, shoulder: 1 },
      colors: { main: 0x4a3a6a, sub: 0x241a38, acc: 0xff6ab0, skin: 0xe0b090, dark: 0x110b1c, cape: 0x2e2248 },
      head: 'hood', weapon: 'dagger', offhand: 'dagger', legs: 'legs',
      extras: ['scarf']
    },
    shadow: {
      kind: 'hero', className: '暗影 · 长镰',
      build: { bw: 21, bh: 25, headR: 8, hip: 50, shoulder: 2 },
      colors: { main: 0x1a1424, sub: 0x0d0a14, acc: 0xc79aff, skin: 0x2a2038, dark: 0x07050a, cape: 0x241a38 },
      head: 'facelessHood', weapon: 'scythe', offhand: null, legs: 'wisp',
      extras: ['aura', 'tails']
    },
    mage: {
      kind: 'hero', className: '法师 · 尖帽法杖',
      build: { bw: 23, bh: 24, headR: 9, hip: 50, shoulder: 2 },
      colors: { main: 0x5a3a9a, sub: 0x2e1f5a, acc: 0xc79aff, skin: 0xe8c8a8, dark: 0x150e2c, cape: 0x3a2a6a },
      head: 'pointedHat', weapon: 'staff', offhand: null, legs: 'robe',
      extras: ['orb', 'runeTrim']
    },
    sage: {
      kind: 'hero', className: '贤者 · 水晶卷轴',
      build: { bw: 22, bh: 24, headR: 9, hip: 50, shoulder: 2 },
      colors: { main: 0x3a8a9a, sub: 0x1e4a5a, acc: 0x5fd0e0, skin: 0xf0d0b0, dark: 0x0d262e, cape: 0x2a6a7a },
      head: 'sageCap', weapon: 'staff', offhand: null, legs: 'robe',
      extras: ['scroll', 'orb']
    },
    berserker: {
      kind: 'hero', className: '狂战士 · 双斧',
      build: { bw: 30, bh: 24, headR: 9, hip: 46, shoulder: 7 },
      colors: { main: 0xb03a2a, sub: 0x6a1a14, acc: 0xff9a5a, skin: 0xe0a880, dark: 0x280d09, cape: 0x6a3a20, hair: 0xd8a040 },
      head: 'bare', weapon: 'axe', offhand: 'axe', legs: 'legs',
      extras: ['fur', 'scars']
    },

    // ---------------- 怪物（10 种）----------------
    claw: {
      kind: 'mob', className: '黑暗爪牙 · 兽形',
      build: { bw: 26, bh: 19, headR: 9, hip: 47, shoulder: 4 },
      colors: { main: 0x8a2a5a, sub: 0x4a1030, acc: 0xd44a8a, eye: 0xffd76a, dark: 0x2a0a1c },
      head: 'beast', weapon: 'claws', offhand: null, legs: 'beast',
      extras: ['spines']
    },
    skeleton: {
      kind: 'mob', className: '骷髅骑兵 · 长矛',
      build: { bw: 19, bh: 23, headR: 8, hip: 48, shoulder: 1 },
      colors: { main: 0x9a9aa8, sub: 0x6a6a78, acc: 0xd8d8e8, eye: 0xff6a4a, dark: 0x3a3a44 },
      head: 'skull', weapon: 'spear', offhand: null, legs: 'bones',
      extras: ['ribs'],
      animRate: 1.5     // 动作最多：近战突刺 + 中远距离掷矛
    },
    zombie: {
      kind: 'mob', className: '死尸 · 蹒跚',
      build: { bw: 26, bh: 22, headR: 9, hip: 47, shoulder: 3 },
      colors: { main: 0x4a7a4a, sub: 0x2a4a2a, acc: 0x7aa86a, skin: 0x7a9a6a, eye: 0xffe08a, dark: 0x1a2a18 },
      head: 'rot', weapon: 'arm', offhand: null, legs: 'legs',
      extras: ['tatter']
    },
    magma: {
      kind: 'mob', className: '岩浆行者 · 熔岩巨块',
      build: { bw: 32, bh: 25, headR: 9, hip: 50, shoulder: 6 },
      colors: { main: 0x3a1a10, sub: 0x1a0c08, acc: 0xff7a2a, glow: 0xffc060, eye: 0xffe08a, dark: 0x120705 },
      head: 'molten', weapon: 'fist', offhand: 'fist', legs: 'lava',
      extras: ['cracks'],
      animRate: 1.4     // 两套动作：近身挥拳 + 助跑冲锋
    },
    shade: {
      kind: 'mob', className: '影（附身）· 飘浮',
      build: { bw: 23, bh: 24, headR: 9, hip: 52, shoulder: 2 },
      colors: { main: 0x2a2a4a, sub: 0x14142a, acc: 0x7a6ad0, eye: 0xd8d0ff, dark: 0x0a0a18 },
      head: 'wisp', weapon: null, offhand: null, legs: 'wisp',
      extras: ['tails', 'aura']
    },
    mimic: {
      kind: 'mob', className: '镜像怪 · 照玩家造型',
      build: null,   // 运行时取玩家英雄的体型
      colors: { main: 0x6a3ab0, sub: 0x3a1a6a, acc: 0xd0b0ff, eye: 0xff6ab0, dark: 0x1a0a34 },
      head: 'mirror', weapon: 'mirror', offhand: 'mirror', legs: 'legs',
      extras: ['outline', 'aura'],
      animRate: 1.5     // 动作跟着玩家走：玩家近战它就近战，玩家远程它就远程
    },
    guard: {
      kind: 'mob', className: '精英守卫 · 重戟大盾',
      build: { bw: 29, bh: 24, headR: 10, hip: 47, shoulder: 7 },
      colors: { main: 0xd4a02a, sub: 0x8a6010, acc: 0xfff0c0, eye: 0xff8a4a, dark: 0x2a1c06 },
      head: 'greathelm', weapon: 'halberd', offhand: 'towerShield', legs: 'legs',
      extras: ['plume', 'cape'],
      animRate: 1.4     // 两套动作：重戟横扫 + 举盾冲锋
    },
    necro: {
      kind: 'mob', className: '死灵法师 · 骨面兜帽',
      build: { bw: 21, bh: 26, headR: 9, hip: 52, shoulder: 2 },
      colors: { main: 0x5a3a8a, sub: 0x2e1a4a, acc: 0x9fe0c0, eye: 0x9fe0c0, dark: 0x150a28 },
      head: 'necroMask', weapon: 'staff', offhand: null, legs: 'wisp',
      extras: ['orb', 'ghostOrbs']
    },
    lord: {
      kind: 'mob', className: '层主 · 双角巨剑',
      build: { bw: 33, bh: 22, headR: 11, hip: 49, shoulder: 8 },
      colors: { main: 0xb0182a, sub: 0x6a0a14, acc: 0xff5a4a, eye: 0xffd76a, dark: 0x2a0308, cape: 0x4a040c },
      head: 'hornedCrown', weapon: 'greatsword', offhand: null, legs: 'legs',
      extras: ['cape', 'horns'],
      animRate: 1.35    // 两套动作：巨剑挥砍 + 跳跃砸地
    },
    shadowking: {
      kind: 'mob', className: '影之皇 · 鹿角长镰',
      build: { bw: 35, bh: 22, headR: 11, hip: 49, shoulder: 8 },
      colors: { main: 0x3a0a2a, sub: 0x1a0414, acc: 0xe0c0ff, eye: 0xe0c0ff, dark: 0x0c020a, cape: 0x24041c },
      head: 'crownAntlers', weapon: 'scythe', offhand: null, legs: 'wisp',
      extras: ['cape', 'aura', 'halo'],
      animRate: 1.35    // 两套动作：长镰横扫 + 跳跃砸地
    },

    // ---------------- 机制型敌人（B 项：每一只都要求玩家动用工具箱里的某一件）----------------
    // 设计约束：**不新增任何绘制部件**，只用上面已有的部件族重新配色组合。
    // 依据是 README 的那条约定「剪影优先 + 配色即身份」——
    // 轮廓负责"这是什么类型"，配色负责"具体是哪一只"，所以复用剪影不会认错人，
    // 而三只的语义色都刻意与既有敌人拉开（铁青 / 蛛丝绿 / 血祭红）。
    bulwark: {
      kind: 'mob', className: '铁壁兵 · 圆盾横列（正面免疫）',
      build: { bw: 30, bh: 24, headR: 10, hip: 47, shoulder: 8 },
      // 铁青冷钢。**杂兵用圆盾，精英用塔盾** —— 这一条是实测逼出来的：
      // 原本给它的部件组合（greathelm + towerShield + halberd + plume）与精英守卫
      // 墨迹宽度完全一样（61px 对 61px @同一坐标），而只换武器/去掉顶羽**毫无变化**，
      // 因为这一族的轮廓是被塔盾整体支配的。所以真正的区分点只能是盾本身，
      // 而"大盾=精英、小盾=杂兵"也比单纯换色更符合直觉。
      colors: { main: 0x4a6a8a, sub: 0x24384c, acc: 0x9fd8ff, eye: 0x9fd8ff, dark: 0x101a24 },
      head: 'helm', weapon: 'spear', offhand: 'roundShield', legs: 'legs',
      extras: []
    },
    weaver: {
      kind: 'mob', className: '织网者 · 四足吐丝（织网减速）',
      build: { bw: 30, bh: 20, headR: 9, hip: 46, shoulder: 5 },
      // 蛛丝绿：四足剪影（beast）在怪物里只有黑暗爪牙用过，
      // 而它无武器、拖着破布与尾丝 —— 轮廓独一无二
      colors: { main: 0x3a5a4a, sub: 0x1c2e26, acc: 0xa8e88a, eye: 0xd8ff9a, dark: 0x0a1410 },
      head: 'rot', weapon: null, offhand: null, legs: 'beast',
      extras: ['tatter', 'tails'],
      animRate: 1.4
    },
    sacrificer: {
      kind: 'mob', className: '献祭者 · 血祭祭司（给同伴套盾）',
      build: { bw: 22, bh: 25, headR: 9, hip: 51, shoulder: 3 },
      // 血祭红。**无面兜帽 + 不持武器**（纯施法者）—— 与"骨面 + 骨杖"的死灵法师分开：
      // 实测两者原本墨迹宽度同为 53px（部件组合整个撞车），改完两侧轮廓与头部都不同。
      colors: { main: 0x7a1a2a, sub: 0x3e0c16, acc: 0xff7a8a, eye: 0xff9aa8, dark: 0x1a0408 },
      head: 'facelessHood', weapon: null, offhand: null, legs: 'robe',
      extras: ['orb', 'ghostOrbs', 'aura']
    }
  };

  // ============================================================
  //  远程英雄（普攻是远程攻击，不再是挥砍）
  //  外观 kind 挂在形象上（姿势与武器绘制要用），招式名与数值留在 试炼2D.js
  //  chains = 远程连招的四招名字：触发时机与近战完全一样（完美格挡 / 翻滚后 / 落地后 / 第 3 下），
  //  但弓不可能「横扫」、法杖也不需要「突进」，所以按武器各叫各的名字；
  //  倍率、穿透、溅射等数值在 试炼2D.js 的 RANGED_CHAIN —— 和 RANGED_ATTACK 同样的分工。
  // ============================================================
  var RANGED = {
    ranger: {
      kind: 'arrow', name: '疾风箭', note: '最快 · 可穿两个',
      chains: { counter: '反击箭', roll: '连珠箭', land: '踏地箭', triple: '三连射' }
    },
    mage: {
      kind: 'orb', name: '奥术弹', note: '追踪 · 命中溅射',
      chains: { counter: '反击奥术', roll: '奥术连发', land: '奥术塌缩', triple: '三重奥术' }
    },
    sage: {
      kind: 'wave', name: '灵能波', note: '慢 · 穿透全场',
      chains: { counter: '灵能反击', roll: '灵波连击', land: '灵能塌陷', triple: '三重灵波' }
    }
  };
  /** 怪物的远程弹药（骷髅骑兵概率掷矛；镜像怪照玩家英雄的弹药） */
  var MOB_SHOTS = {
    skeleton: { kind: 'spear', name: '掷矛', color: 0xd8d8e8 }
  };
  Object.keys(RANGED).forEach(function (id) {
    if (LOOKS[id]) LOOKS[id].ranged = RANGED[id].kind;
  });

  // ============================================================
  //  姿势（帧 → 各部件偏移）
  // ============================================================
  function heroPose(f, look) {
    var rk = look && look.ranged;   // 远程英雄：攻击帧是「张弓 / 举杖」而不是挥砍
    var p = { dy: 0, lean: 0, legOff: 0, crouch: 0, arm: 0, wp: 0, air: 0, alpha: 1, dead: false, roll: false, aim: 0, guard: false };
    switch (f) {
      case 0: break;                                                        // idle
      case 1: p.dy = 1; p.crouch = 1; p.arm = 1; break;                      // 呼吸
      case 2: p.lean = 1; p.legOff = -5; p.crouch = 1; p.arm = 3; break;     // 跑 1
      case 3: p.dy = -1; p.lean = 1; p.arm = 1; break;                       // 跑 2
      case 4: p.lean = 1; p.legOff = 5; p.crouch = 1; p.arm = -3; break;     // 跑 3
      case 5: p.dy = -1; p.lean = 1; p.arm = -1; break;                      // 跑 4
      case 6: p.dy = -2; p.crouch = -3; p.air = 1; break;                    // 起跳（收腿）
      case 7: p.dy = 1; p.air = 2; p.arm = 2; break;                         // 下落（伸展）
      case 8:                                                                // 攻击起手
        if (rk) { p.lean = -1; p.crouch = 1; p.arm = 3; p.aim = 1; }         // 张弓 / 举杖蓄力
        else { p.lean = 2; p.legOff = 3; p.crouch = 1; p.arm = 2; }
        break;
      case 9:                                                                // 攻击挥出
        if (rk) { p.lean = 1; p.crouch = 1; p.arm = 4; p.aim = 2; }          // 释放（弦回弹 / 杖前送）
        else { p.lean = 4; p.legOff = 5; p.crouch = 2; p.arm = 4; p.wp = 1; }
        break;
      case 10:                                                               // 收招
        if (rk) { p.lean = 0; p.arm = 1; p.aim = 0; }
        else { p.lean = 2; p.legOff = 1; p.crouch = 2; p.arm = 1; p.wp = 2; }
        break;
      case 11: p.dy = 1; p.lean = -3; p.crouch = 2; p.arm = -2; break;       // 受击
      case 12: p.dy = 9; p.crouch = 17; p.dead = true; p.alpha = 0.75; break; // 倒地
      case 13: p.dy = 6; p.crouch = 13; p.roll = true; p.arm = -3; break;    // 翻滚
      case 14: p.dy = 1; p.crouch = 3; p.lean = -1; p.arm = -2; p.guard = true; break;  // 举盾（重心压低、身体顶着盾）
    }
    return p;
  }

  function mobPose(f) {
    var p = { dy: 0, lean: 0, legOff: 0, crouch: 0, arm: 0, wp: 0, lunge: 0, air: 0, alpha: 1, dead: false };
    switch (f) {
      case 0: break;
      case 1: p.dy = 2; p.crouch = 2; p.legOff = 3; break;
      case 2: p.lean = -3; p.crouch = 2; p.arm = -3; break;      // 起手后仰
      case 3: p.lean = 5; p.lunge = 9; p.arm = 4; p.wp = 1; break;   // 扑击
      case 4: p.lean = -5; p.dy = 2; p.crouch = 3; break;        // 受击
      case 5: p.dy = 7; p.crouch = 13; p.alpha = 0.5; p.dead = true; break;
      case 6: p.dy = 14; p.crouch = 20; p.alpha = 0.25; p.dead = true; break;
    }
    return p;
  }

  // ============================================================
  //  部件：腿 / 下摆 / 底座
  // ============================================================
  function drawLegs(g, L, cx, p, o) {
    var b = L.build, c = L.colors, a = p.alpha;
    var hip = b.hip + p.dy - p.crouch * 0.35;
    var foot = Math.min(61, 60 + p.dy);   // 倒地 / 翻滚帧不要探出单元下沿
    var legW = Math.max(6, Math.round(b.bw * 0.3));
    var off = p.legOff;
    var type = L.legs || 'legs';
    var bootC = dk(c.sub, 0.7);

    if (type === 'robe' || type === 'wisp' || type === 'lava') {
      if (type === 'lava') {
        // 熔岩底座：宽扁的熔岩池 + 发光裂缝
        ell(g, c.sub, a, cx, foot - 6, b.bw + 12, 14);
        ell(g, c.main, a, cx, foot - 9, b.bw + 4, 11);
        ell(g, c.acc, 0.5 * a, cx - 5, foot - 8, 10, 4);
        ell(g, c.acc, 0.35 * a, cx + 7, foot - 6, 8, 3);
        return;
      }
      // 长袍 / 影雾：上窄下宽，底边带强调色或飘散锯齿
      var topW = b.bw + 2, botW = b.bw + (type === 'wisp' ? 16 : 12);
      var h = foot - hip;
      var sway = p.legOff * 0.6;   // 跑动时袍摆 / 影雾跟着摆动，不再像在滑行
      for (var i = 0; i < 4; i++) {
        var t = i / 3;
        var w = topW + (botW - topW) * t;
        var y = hip + h * (i / 4);
        var cc = type === 'wisp' ? c.main : c.main;
        rect(g, cc, a * (type === 'wisp' ? (0.95 - t * 0.35) : 1), cx - w / 2 + sway * t, y, w, h / 4 + 1);
      }
      if (type === 'robe') {
        rect(g, c.acc, 0.75 * a, cx - botW / 2, foot - 3, botW, 3);
        rect(g, dk(c.main, 0.7), a, cx - 2, hip, 4, h);   // 袍面竖缝
      } else {
        // 影雾：底边三缕飘散
        tri(g, c.main, 0.55 * a, cx - botW / 2 - 2, foot - 3, cx - botW / 6, foot + 1, cx - 2, foot - 3);
        tri(g, c.main, 0.45 * a, cx + 2, foot - 3, cx + botW / 6, foot + 1, cx + botW / 2 + 2, foot - 3);
        circ(g, c.acc, 0.35 * a, cx - 4, hip + h * 0.45, 5);
        circ(g, c.acc, 0.25 * a, cx + 5, hip + h * 0.7, 4);
      }
      return;
    }

    if (type === 'bones') {
      // 骨腿：细骨 + 关节球
      var lx = cx - b.bw * 0.26, rx = cx + b.bw * 0.26;
      rect(g, c.main, a, lx - 2 + off * 0.4, hip, 4, foot - hip - 4);
      rect(g, c.main, a, rx - 2 - off * 0.4, hip, 4, foot - hip - 4);
      circ(g, c.main, a, lx + off * 0.4, hip + 3, 3);
      circ(g, c.main, a, rx - off * 0.4, hip + 3, 3);
      rect(g, c.sub, a, lx - 3 + off * 0.4, foot - 4, 7, 4);
      rect(g, c.sub, a, rx - 3 - off * 0.4, foot - 4, 7, 4);
      return;
    }

    if (type === 'beast') {
      // 兽形四足：前后两对短腿 + 爪
      var f1 = cx - b.bw * 0.34, f2 = cx + b.bw * 0.3;
      rect(g, dk(c.main, 0.8), a, f1 + off * 0.5, hip - 2, 6, foot - hip + 2);
      rect(g, dk(c.main, 0.8), a, f2 - off * 0.5, hip - 2, 6, foot - hip + 2);
      rect(g, dk(c.sub, 0.9), a, f1 + 8 + off * 0.5, hip, 5, foot - hip);
      rect(g, dk(c.sub, 0.9), a, f2 - 10 - off * 0.5, hip, 5, foot - hip);
      rect(g, c.acc, 0.85 * a, f1 + off * 0.5 - 1, foot - 3, 8, 3);
      rect(g, c.acc, 0.85 * a, f2 - off * 0.5 - 1, foot - 3, 8, 3);
      return;
    }

    // 普通人形双腿
    rect(g, bootC, a, cx - b.bw * 0.3 - legW / 2 + off * 0.5, hip, legW, foot - hip - 5);
    rect(g, bootC, a, cx + b.bw * 0.3 - legW / 2 - off * 0.5, hip, legW, foot - hip - 5);
    rect(g, dk(bootC, 0.75), a, cx - b.bw * 0.3 - legW / 2 - 1 + off * 0.5, foot - 5, legW + 2, 5);
    rect(g, dk(bootC, 0.75), a, cx + b.bw * 0.3 - legW / 2 - 1 - off * 0.5, foot - 5, legW + 2, 5);
  }

  // ============================================================
  //  部件：躯干
  // ============================================================
  function drawTorso(g, L, cx, p, o) {
    var b = L.build, c = L.colors, a = p.alpha;
    var hip = b.hip + p.dy - p.crouch * 0.35;
    var top = hip - b.bh;
    var w = b.bw + b.shoulder * 0.6;
    var x = cx - w / 2;

    // 披风（在身后）
    if (L.extras.indexOf('cape') >= 0 || L.extras.indexOf('cloakShort') >= 0) {
      var cw = w + 10, ch = (L.extras.indexOf('cloakShort') >= 0) ? b.bh * 0.9 : b.bh + 6;
      rrect(g, c.cape || dk(c.main, 0.8), 0.92 * a, cx - cw / 2 - 2, top - 1, cw, ch, 4);
      rrect(g, dk(c.cape || c.main, 0.7), 0.9 * a, cx - cw / 2 - 2, top + ch - 5, cw, 5, 3);
    }

    // 躯干主体
    box(g, c.main, a, x, top, w, b.bh, 5);
    // 胸甲分片 / 腰部
    rrect(g, c.sub, 0.95 * a, x + 1, top + b.bh - 6, w - 2, 6, 3);
    rect(g, c.acc, 0.8 * a, x + 2, top + b.bh * 0.52, w - 4, 2);   // 腰带
    // 肩甲
    var sw = Math.max(6, Math.round(w * 0.3));
    rrect(g, lt(c.main, 0.12), a, x - 2, top - 1, sw, 8, 3);
    rrect(g, lt(c.main, 0.12), a, x + w + 2 - sw, top - 1, sw, 8, 3);

    // 附加装饰
    if (L.extras.indexOf('fur') >= 0) {
      rrect(g, c.cape || 0x6a3a20, a, x - 1, top - 2, w + 2, 7, 3);
      tri(g, 0xffffff, 0.16 * a, x + 2, top, x + 6, top - 5, x + 10, top);
      tri(g, 0xffffff, 0.16 * a, x + w - 10, top, x + w - 6, top - 5, x + w - 2, top);
    }
    if (L.extras.indexOf('ribs') >= 0) {
      for (var i = 0; i < 3; i++) rect(g, c.sub, 0.9 * a, x + 3, top + 5 + i * 4, w - 6, 2);
      rect(g, dk(c.main, 0.6), a, cx - 1, top + 2, 2, b.bh - 4);   // 脊柱
    }
    if (L.extras.indexOf('tatter') >= 0) {
      tri(g, c.dark, 0.85 * a, x + 2, top + b.bh - 2, x + 8, top + b.bh + 5, x + 14, top + b.bh - 2);
      tri(g, c.dark, 0.7 * a, x + w - 14, top + b.bh - 2, x + w - 8, top + b.bh + 4, x + w - 2, top + b.bh - 2);
    }
    if (L.extras.indexOf('scars') >= 0) {
      seg(g, 2, lt(c.acc, 0.3), 0.7 * a, x + 5, top + 6, x + 12, top + 12);
      seg(g, 2, lt(c.acc, 0.3), 0.5 * a, x + 9, top + 5, x + 15, top + 10);
    }
    if (L.extras.indexOf('runeTrim') >= 0) {
      rect(g, c.acc, 0.9 * a, cx - 2, top + 4, 4, 4);
      rect(g, c.acc, 0.7 * a, cx - 6, top + 12, 12, 2);
    }
    if (L.extras.indexOf('cracks') >= 0) {
      seg(g, 2, c.glow || c.acc, 0.9 * a, x + 6, top + 4, x + 11, top + 14);
      seg(g, 2, c.glow || c.acc, 0.7 * a, x + w - 8, top + 6, x + w - 13, top + 16);
      seg(g, 2, c.glow || c.acc, 0.6 * a, cx + 2, top + b.bh - 8, cx + 7, top + b.bh);
    }
    if (L.extras.indexOf('spines') >= 0) {
      for (var s = 0; s < 4; s++) {
        var sx = cx - 8 + s * 5;
        tri(g, c.acc, 0.85 * a, sx, top + 1, sx + 3, top - 6 - (s % 2) * 2, sx + 6, top + 1);
      }
    }
    return { top: top, hip: hip, w: w, x: x };
  }

  // ============================================================
  //  部件：头（剪影的主要来源）
  // ============================================================
  function drawHead(g, L, cx, p, o, torso) {
    var b = L.build, c = L.colors, a = p.alpha;
    var r = b.headR;
    var hy = torso.top - r + 6 + p.lean * 0.3;
    var eyeC = c.eye || 0xffffff;
    var face = c.skin || 0xf0c8a0;

    switch (L.head) {
      case 'helm':   // 全罩头盔：圆顶 + T 形面窗 + 顶脊
        rrect(g, c.main, a, cx - r - 2, hy - r - 2, (r + 2) * 2, (r + 2) * 2, 5);
        rrect(g, lt(c.main, 0.14), a, cx - r - 2, hy - r - 2, (r + 2) * 2, 4, 3);
        rect(g, c.dark, a, cx - r + 1, hy - 4, (r - 1) * 2, 4);     // 面窗
        rect(g, c.dark, a, cx - 2, hy - 1, 4, 6);                    // 鼻梁
        circ(g, eyeC, 0.9 * a, cx - 4, hy - 2, 1.6);
        circ(g, eyeC, 0.9 * a, cx + 4, hy - 2, 1.6);
        rect(g, c.acc, 0.9 * a, cx - 2, hy - r - 2, 4, (r + 2) * 2); // 顶脊
        rect(g, c.sub, a, cx - r + 2, hy + r - 1, (r - 2) * 2, 4);   // 颈护
        break;

      case 'greathelm':   // 桶盔：方顶 + 横缝 + 顶羽
        rrect(g, c.main, a, cx - r - 2, hy - r - 3, (r + 2) * 2, (r + 3) * 2, 4);
        rrect(g, lt(c.main, 0.1), a, cx - r - 2, hy - r - 3, (r + 2) * 2, 4, 3);
        rect(g, c.dark, a, cx - r, hy - 5, r * 2, 9);                // 视察缝
        rect(g, c.main, a, cx - 2, hy - 5, 4, 9);                    // 中央立柱
        rect(g, c.sub, a, cx - r - 2, hy + r - 2, (r + 2) * 2, 5);
        for (var i = 0; i < 3; i++) tri(g, c.acc, 0.9 * a, cx - 3 + i * 3, hy - r - 3, cx - 1 + i * 3, hy - r - 7, cx + 1 + i * 3, hy - r - 3);
        break;

      case 'wingHelm':   // 带翼头盔：圆顶 + 两侧翼 + 发光缝
        rrect(g, c.main, a, cx - r - 1, hy - r - 2, (r + 1) * 2, (r + 2) * 2, 5);
        rrect(g, c.sub, a, cx - r + 1, hy - 3, (r - 1) * 2, 5);
        circ(g, eyeC, 0.95 * a, cx - 4, hy - 1, 1.8);
        circ(g, eyeC, 0.95 * a, cx + 4, hy - 1, 1.8);
        tri(g, c.acc, 0.92 * a, cx - r - 1, hy - 2, cx - r - 9, hy - 9, cx - r - 3, hy + 5);
        tri(g, c.acc, 0.92 * a, cx + r + 1, hy - 2, cx + r + 9, hy - 9, cx + r + 3, hy + 5);
        rect(g, c.acc, 0.85 * a, cx - 2, hy - r - 2, 4, 4);
        break;

      case 'hood':   // 兜帽：锥形外轮廓 + 阴影里的眼
        tri(g, c.main, a, cx, hy - r - 6, cx - r - 3, hy + r + 1, cx + r + 3, hy + r + 1);
        rrect(g, c.main, a, cx - r - 2, hy - r + 2, (r + 2) * 2, (r + 4) * 2, 5);
        rrect(g, c.dark, a, cx - r + 1, hy - r + 4, (r - 1) * 2, (r + 2) * 2, 4);
        rect(g, eyeC, 0.95 * a, cx - 5, hy, 3, 2);
        rect(g, eyeC, 0.95 * a, cx + 2, hy, 3, 2);
        rect(g, c.sub, a, cx - r - 2, hy + r + 4, (r + 2) * 2, 4);
        break;

      case 'facelessHood':   // 无面兜帽：只有两点亮眼
        tri(g, c.main, a, cx, hy - r - 7, cx - r - 3, hy + r + 2, cx + r + 3, hy + r + 2);
        rrect(g, c.sub, a, cx - r - 2, hy - r + 2, (r + 2) * 2, (r + 4) * 2, 5);
        rect(g, c.dark, a, cx - r + 1, hy - r + 5, (r - 1) * 2, (r + 1) * 2);
        circ(g, eyeC, 0.95 * a, cx - 4, hy, 2.2);
        circ(g, eyeC, 0.95 * a, cx + 4, hy, 2.2);
        rect(g, c.acc, 0.5 * a, cx - r - 2, hy + r + 3, (r + 2) * 2, 2);
        break;

      case 'featherCap':   // 羽帽：圆帽 + 一片羽毛
        circ(g, face, a, cx, hy, r);
        rrect(g, c.main, a, cx - r - 2, hy - r - 2, (r + 2) * 2, 8, 4);
        tri(g, c.acc, 0.95 * a, cx + r - 1, hy - r - 1, cx + r + 7, hy - r - 10, cx + r + 2, hy - r + 2);
        circ(g, c.dark, a, cx - 4, hy - 1, 1.6);
        circ(g, c.dark, a, cx + 4, hy - 1, 1.6);
        rect(g, dk(face, 0.85), a, cx - 3, hy + 4, 6, 2);
        break;

      case 'pointedHat':   // 尖顶宽檐帽
        circ(g, face, a, cx, hy, r);
        circ(g, c.dark, a, cx - 4, hy - 1, 1.5);
        circ(g, c.dark, a, cx + 4, hy - 1, 1.5);
        rrect(g, c.main, a, cx - r - 7, hy - r - 3, (r + 7) * 2, 6, 3);       // 檐
        tri(g, c.main, a, cx, hy - r - 12, cx - r + 1, hy - r - 3, cx + r - 1, hy - r - 3);
        rrect(g, c.main, a, cx - 5, hy - r - 9, 10, 8, 3);
        rect(g, c.acc, 0.9 * a, cx - r + 1, hy - r - 4, (r - 1) * 2, 2);     // 帽箍
        circ(g, c.acc, 0.95 * a, cx + 5, hy - r - 8, 2.4);                   // 帽尖星
        break;

      case 'sageCap':   // 智者小帽 + 额饰
        circ(g, face, a, cx, hy, r);
        circ(g, c.dark, a, cx - 4, hy - 1, 1.6);
        circ(g, c.dark, a, cx + 4, hy - 1, 1.6);
        rrect(g, c.main, a, cx - r - 1, hy - r - 3, (r + 1) * 2, 8, 5);
        rect(g, c.acc, 0.95 * a, cx - r + 1, hy - r - 1, (r - 1) * 2, 3);    // 额饰发光
        circ(g, c.acc, 0.9 * a, cx, hy - r - 1, 2.6);
        rect(g, lt(face, 0.5), a, cx - 4, hy + 5, 8, 4);                     // 长须
        break;

      case 'bare':   // 无盔（乱发）
        var hair = c.hair || 0xd8a040;
        rrect(g, hair, a, cx - r - 1, hy - r - 3, (r + 1) * 2, r + 5, 5);
        tri(g, hair, a, cx - r - 1, hy - 2, cx - r - 6, hy + 4, cx - r, hy + 2);
        tri(g, hair, a, cx + r + 1, hy - 2, cx + r + 6, hy + 4, cx + r, hy + 2);
        circ(g, face, a, cx, hy + 1, r - 1);
        circ(g, 0xffe08a, 0.95 * a, cx - 4, hy, 1.8);
        circ(g, 0xffe08a, 0.95 * a, cx + 4, hy, 1.8);
        rect(g, dk(face, 0.7), a, cx - 4, hy + 5, 8, 2);
        break;

      case 'skull':   // 骷髅头：眼窝 + 牙
        circ(g, c.main, a, cx, hy, r + 1);
        rect(g, c.main, a, cx - r + 1, hy, (r - 1) * 2, 6);
        circ(g, c.dark, a, cx - 4, hy - 1, 3.2);                       // 眼窝
        circ(g, c.dark, a, cx + 4, hy - 1, 3.2);
        circ(g, eyeC, 0.95 * a, cx - 4, hy - 1, 1.4);                  // 眼中火
        circ(g, eyeC, 0.95 * a, cx + 4, hy - 1, 1.4);
        rect(g, c.dark, a, cx - 1, hy + 2, 2, 3);
        for (var t = 0; t < 4; t++) rect(g, c.dark, 0.85 * a, cx - 4 + t * 2.6, hy + 5, 1.4, 3);
        break;

      case 'rot':   // 腐烂头：不对称 + 一只突眼
        circ(g, c.skin || 0x7a9a6a, a, cx, hy + 1, r);
        rrect(g, dk(c.skin || 0x7a9a6a, 0.8), a, cx - r + 1, hy + 3, (r - 1) * 2, 5, 3);
        circ(g, eyeC, a, cx - 4, hy - 2, 2.8);
        circ(g, c.dark, a, cx + 4, hy - 1, 2.2);
        rect(g, c.dark, a, cx - 4, hy + 5, 8, 2);
        tri(g, c.acc, 0.7 * a, cx - 6, hy - 6, cx - 2, hy - 3, cx - 6, hy - 1);
        break;

      case 'molten':   // 熔岩头：黑石块 + 裂缝 + 独眼
        rrect(g, c.main, a, cx - r - 1, hy - r, (r + 1) * 2, (r + 2) * 2, 6);
        rrect(g, dk(c.main, 0.7), a, cx - r, hy - r + 1, (r) * 2, 6, 3);
        seg(g, 2, c.acc, 0.95 * a, cx - r + 2, hy + 4, cx - 2, hy - 3);
        seg(g, 2, c.acc, 0.8 * a, cx + 3, hy + 6, cx + r - 2, hy);
        circ(g, eyeC, a, cx, hy - 1, 3.4);
        circ(g, 0xff4a10, a, cx, hy - 1, 1.6);
        break;

      case 'beast':   // 兽头：楔形 + 尖耳 + 獠牙
        tri(g, c.main, a, cx - r - 3, hy + r, cx - r - 3, hy - r - 6, cx + r + 1, hy + r);
        tri(g, c.main, a, cx + r + 3, hy + r, cx + r + 3, hy - r - 4, cx - r - 1, hy + r);
        tri(g, dk(c.main, 0.7), a, cx - r - 2, hy - r + 1, cx - r - 6, hy - r - 8, cx - r + 2, hy - r - 2);
        tri(g, dk(c.main, 0.7), a, cx + r + 2, hy - r + 1, cx + r + 6, hy - r - 8, cx - r - 2 + 2 * r, hy - r - 2);
        circ(g, eyeC, a, cx - 4, hy - 2, 3);
        circ(g, 0x1a0008, a, cx - 4, hy - 2, 1.4);
        rect(g, c.dark, a, cx - 6, hy + 4, 12, 4);
        tri(g, 0xffffff, 0.9 * a, cx - 5, hy + 4, cx - 3, hy + 9, cx - 1, hy + 4);
        tri(g, 0xffffff, 0.9 * a, cx + 1, hy + 4, cx + 3, hy + 9, cx + 5, hy + 4);
        break;

      case 'wisp':   // 影：无实体头（雾团 + 两点眼）
        ell(g, c.main, 0.9 * a, cx, hy, (r + 4) * 2, (r + 3) * 2);
        ell(g, c.dark, 0.75 * a, cx - 2, hy + 1, (r + 1) * 2, (r + 1) * 2);
        circ(g, eyeC, a, cx - 4, hy - 1, 2.6);
        circ(g, eyeC, a, cx + 4, hy - 1, 2.6);
        circ(g, c.acc, 0.35 * a, cx, hy + 2, r + 5);
        break;

      case 'hornedCrown':   // 角冠：头盔 + 双角
        rrect(g, c.main, a, cx - r - 2, hy - r - 1, (r + 2) * 2, (r + 2) * 2, 5);
        rrect(g, dk(c.main, 0.8), a, cx - r + 1, hy - 3, (r - 1) * 2, 5);
        circ(g, eyeC, a, cx - 4, hy - 1, 2);
        circ(g, eyeC, a, cx + 4, hy - 1, 2);
        rect(g, c.acc, 0.95 * a, cx - 2, hy - r - 1, 4, (r + 2) * 2);   // 冠脊
        // 双角（外弯）
        tri(g, c.acc, 0.95 * a, cx - r - 1, hy - r + 2, cx - r - 12, hy - r - 7, cx - r + 2, hy - r - 2);
        tri(g, c.acc, 0.95 * a, cx + r + 1, hy - r + 2, cx + r + 12, hy - r - 7, cx + r - 2, hy - r - 2);
        tri(g, dk(c.acc, 0.7), a, cx - 2, hy + r - 1, cx - 1, hy + r + 5, cx + 2, hy + r - 1);
        break;

      case 'crownAntlers':   // 鹿角王冠 + 影雾
        ell(g, c.main, 0.9 * a, cx, hy, (r + 3) * 2, (r + 4) * 2);
        circ(g, eyeC, a, cx - 5, hy - 1, 2.6);
        circ(g, eyeC, a, cx + 5, hy - 1, 2.6);
        circ(g, c.acc, 0.3 * a, cx, hy, r + 4);
        // 王冠
        rrect(g, c.acc, 0.95 * a, cx - r - 1, hy - r - 4, (r + 1) * 2, 6, 2);
        for (var k = 0; k < 3; k++) tri(g, c.acc, 0.95 * a, cx - r + k * (r) - 1, hy - r - 4, cx - r + k * (r) + 2, hy - r - 8, cx - r + k * (r) + 5, hy - r - 4);
        // 多叉鹿角
        seg(g, 3, c.acc, 0.9 * a, cx - r, hy - r - 4, cx - r - 7, hy - r - 8);
        seg(g, 2, c.acc, 0.9 * a, cx - r - 4, hy - r - 8, cx - r - 11, hy - r - 9);
        seg(g, 3, c.acc, 0.9 * a, cx + r, hy - r - 4, cx + r + 7, hy - r - 8);
        seg(g, 2, c.acc, 0.9 * a, cx + r + 4, hy - r - 8, cx + r + 11, hy - r - 9);
        break;

      case 'necroMask':   // 死灵面具：兜帽 + 骨质面具 + 两点幽光 + 牙缝
        tri(g, c.main, a, cx, hy - r - 10, cx - r - 4, hy + r + 2, cx + r + 4, hy + r + 2);
        rrect(g, c.sub, a, cx - r - 2, hy - r + 2, (r + 2) * 2, (r + 4) * 2, 5);
        rrect(g, lt(c.main, 0.3), a, cx - r + 1, hy - r + 3, (r - 1) * 2, (r + 3) * 2, 4);
        rect(g, c.acc, 0.95 * a, cx - 5, hy - 1, 4, 2);
        rect(g, c.acc, 0.95 * a, cx + 1, hy - 1, 4, 2);
        for (var nm = 0; nm < 3; nm++) rect(g, c.dark, 0.75 * a, cx - 3 + nm * 3, hy + 5, 1.6, 3);
        break;

      case 'mirror':   // 镜像怪：兜帽 + 玩家式面孔（紫色调）
        rrect(g, c.main, a, cx - r - 2, hy - r - 2, (r + 2) * 2, (r + 2) * 2, 5);
        rrect(g, c.dark, a, cx - r + 1, hy - 4, (r - 1) * 2, 8, 2);
        rect(g, c.acc, 0.95 * a, cx - 5, hy - 2, 4, 3);
        rect(g, c.acc, 0.95 * a, cx + 1, hy - 2, 4, 3);
        tri(g, c.main, a, cx, hy - r - 8, cx - r - 1, hy - r, cx + r + 1, hy - r);
        break;

      default:
        circ(g, face, a, cx, hy, r);
    }
  }

  // ============================================================
  //  部件：武器与副手
  // ============================================================
  function weaponPos(L, cx, p, torso) {
    var b = L.build;
    var handY = torso.top + b.bh * 0.55;
    var hx = cx + b.bw * 0.36 + 1;
    if (L.weapon === 'axe' || L.weapon === 'dagger') hx = cx + b.bw * 0.3;
    var swing = p.wp === 1 ? 1 : (p.wp === 2 ? 0.45 : 0);
    var ax = hx + swing * 4;
    var ay = handY - swing * 12 + p.arm * 0.4;
    return { x: ax, y: ay, swing: swing };
  }

  function drawWeapon(g, L, cx, p, torso) {
    var c = L.colors, a = p.alpha;
    var w = L.weapon;
    if (!w || w === 'mirror') {
      if (w === 'mirror') { drawMirrorWeapon(g, L, cx, p, torso); }
      return;
    }
    var hp = weaponPos(L, cx, p, torso);
    var hx = hp.x, hy = hp.y;

    switch (w) {
      case 'sword':   // 长剑：剑柄 + 十字护手 + 剑身
        rect(g, 0x6a4a20, a, hx - 1, hy - 2, 3, 8);
        rect(g, c.acc, a, hx - 5, hy + 5, 11, 3);
        rect(g, 0xd8d8e8, a, hx + 1, hy - 17, 4, 15);
        tri(g, 0xeaeaf4, a, hx + 1, hy - 17, hx + 5, hy - 17, hx + 3, hy - 22);
        break;
      case 'glowSword':   // 圣光剑：剑身发光
        rect(g, c.acc, a, hx - 1, hy - 2, 3, 9);
        rect(g, lt(c.acc, 0.4), a, hx - 6, hy + 6, 13, 3);
        rect(g, 0xfff8e0, a, hx, hy - 18, 5, 16);
        circ(g, c.acc, 0.35 * a, hx + 2, hy - 14, 7);
        tri(g, 0xfff8e0, a, hx, hy - 18, hx + 5, hy - 18, hx + 2, hy - 23);
        break;
      case 'greatsword':   // 巨剑：更宽更长
        rect(g, 0x503020, a, hx - 2, hy - 2, 4, 10);
        rect(g, c.acc, a, hx - 7, hy + 7, 15, 4);
        rect(g, 0xc8c8d8, a, hx, hy - 17, 7, 19);
        rect(g, 0xeaeaF4, a, hx + 2, hy - 17, 3, 19);
        tri(g, 0xc8c8d8, a, hx, hy - 17, hx + 7, hy - 17, hx + 3.5, hy - 23);
        break;
      case 'dagger':   // 匕首
        rect(g, 0x3a2a14, a, hx - 1, hy - 1, 3, 6);
        rect(g, c.acc, a, hx - 3, hy + 4, 7, 2);
        rect(g, 0xd8d8e8, a, hx, hy - 14, 3, 16);
        tri(g, 0xeaeaf4, a, hx, hy - 14, hx + 3, hy - 14, hx + 1.5, hy - 18);
        break;
      case 'axe':   // 战斧（双持各一把）
        rect(g, 0x5a4020, a, hx - 1, hy - 13, 3, 23);
        tri(g, 0xc8c8d8, a, hx + 2, hy - 15, hx + 12, hy - 8, hx + 2, hy + 1);
        tri(g, 0x9a9aac, a, hx + 2, hy - 15, hx + 10, hy - 10, hx + 2, hy - 5);
        break;
      case 'bow':   // 长弓 + 弦（远程英雄的攻击帧会张弓 / 放弦）
        var tipX = hx + 6.8, tipT = hy - 16.4, tipB = hy + 6.4;
        g.lineStyle(3, 0x6a4a20, a);
        g.beginPath(); g.arc(hx + 3, hy - 5, 12, -1.25, 1.25, false); g.strokePath();
        if (p.aim === 1) {
          // 张弓：弦被拉到身后，箭搭在弦上待发
          seg(g, 1.4, c.acc, 0.95 * a, tipX, tipT, hx - 5, hy - 5);
          seg(g, 1.4, c.acc, 0.95 * a, hx - 5, hy - 5, tipX, tipB);
          rect(g, 0x8a6a3a, a, hx - 5, hy - 6, 21, 2);
          rect(g, 0xd8d8e8, a, hx - 11, hy - 6, 6, 2);
          tri(g, c.acc, a, hx - 11, hy - 6, hx - 11, hy - 3, hx - 15, hy - 4.5);
          tri(g, 0xd8d8e8, a, hx + 16, hy - 7, hx + 16, hy - 3, hx + 20, hy - 5);
        } else if (p.aim === 2) {
          // 释放：弦已回弹成直线，箭离弦（残留的弦影让「射出去了」读得出来）
          seg(g, 1.4, c.acc, 0.95 * a, tipX, tipT, tipX, tipB);
          seg(g, 1.4, 0xffffff, 0.3 * a, tipX - 5, hy - 10, tipX - 5, hy);
        } else {
          seg(g, 1.4, c.acc, 0.95 * a, tipX, tipT, tipX, tipB);
          rect(g, 0xd8d8e8, a, hx, hy - 6, 11, 2);   // 搭箭
          tri(g, c.acc, a, hx + 11, hy - 7, hx + 11, hy - 3, hx + 15, hy - 5);
        }
        break;
      case 'staff':   // 法杖 + 顶端宝珠（远程英雄的攻击帧会举杖 / 推出宝珠）
        if (p.aim === 1) {
          seg(g, 3, 0x5a3a1a, a, hx - 3, hy + 9, hx + 8, hy - 11);
          circ(g, c.acc, 0.28 * a, hx + 10, hy - 13, 9);
          circ(g, c.acc, a, hx + 10, hy - 13, 4.5);
          circ(g, 0xffffff, 0.6 * a, hx + 8.6, hy - 14.4, 2);
        } else if (p.aim === 2) {
          seg(g, 3, 0x5a3a1a, a, hx - 4, hy + 8, hx + 10, hy - 8);
          circ(g, c.acc, 0.34 * a, hx + 12, hy - 11, 9);
          circ(g, lt(c.acc, 0.25), a, hx + 12, hy - 11, 4.6);
          circ(g, 0xffffff, 0.8 * a, hx + 10.6, hy - 12.4, 2.4);
        } else {
          rect(g, 0x5a3a1a, a, hx + 1, hy - 15, 3, 25);
          circ(g, c.acc, a, hx + 2.5, hy - 18, 4);
          circ(g, 0xffffff, 0.5 * a, hx + 2.5, hy - 19.5, 2);
          circ(g, c.acc, 0.25 * a, hx + 2.5, hy - 18, 7);
        }
        break;
      case 'scythe':   // 长镰：斜杆 + 下垂弯刃（竖直长杆会顶穿单元上沿）
        seg(g, 3, 0x2a2038, a, hx - 2, hy + 10, hx + 8, hy - 12);
        g.lineStyle(4, 0xd8d8e8, a);
        g.beginPath(); g.arc(hx + 8, hy - 12, 6, -0.3, 1.9, false); g.strokePath();
        tri(g, 0xd8d8e8, a, hx + 11, hy - 2, hx + 17, hy + 4, hx + 9, hy + 7);
        break;
      case 'spear':   // 长矛：斜持
        seg(g, 3, 0x6a5a3a, a, hx - 3, hy + 8, hx + 10, hy - 14);
        tri(g, 0xd8d8e8, a, hx + 7, hy - 16, hx + 14, hy - 19, hx + 10, hy - 9);
        rect(g, c.acc, a, hx + 5, hy - 4, 6, 2);
        break;
      case 'halberd':   // 重戟：斜杆 + 斧刃 + 钩
        seg(g, 4, 0x5a5a6a, a, hx - 3, hy + 8, hx + 9, hy - 12);
        tri(g, 0xd8d8e8, a, hx + 3, hy - 4, hx + 12, hy - 11, hx + 5, hy + 5);
        tri(g, 0xd8d8e8, a, hx + 7, hy - 13, hx + 11, hy - 18, hx + 14, hy - 11);
        tri(g, 0xb0b0c0, a, hx + 3, hy - 8, hx - 6, hy - 6, hx + 3, hy + 1);
        rect(g, c.acc, a, hx + 4, hy - 2, 6, 3);
        break;
      case 'claws':   // 双爪
        rect(g, dk(c.main, 0.7), a, hx - 2, hy - 6, 5, 12);
        for (var cl = 0; cl < 3; cl++) {
          tri(g, 0xf0f0f8, a, hx + 2, hy - 4 + cl * 4, hx + 10, hy - 2 + cl * 4, hx + 2, hy + 2 + cl * 4);
        }
        break;
      case 'fist':   // 熔岩巨拳
        rrect(g, c.main, a, hx - 3, hy - 8, 12, 16, 6);
        rrect(g, c.sub, a, hx - 1, hy - 6, 9, 12, 4);
        seg(g, 2, c.acc, 0.9 * a, hx + 1, hy - 3, hx + 9, hy + 2);
        break;
      case 'arm':   // 僵尸前伸的手臂
        rrect(g, dk(c.skin || 0x7a9a6a, 0.9), a, hx - 2, hy - 4, 12, 7, 3);
        circ(g, c.main, a, hx + 11, hy, 4);
        circ(g, dk(c.main, 0.8), a, hx + 15, hy - 2, 2.2);
        break;
    }
  }

  function drawMirrorWeapon(g, L, cx, p, torso) {
    // 镜像怪：用玩家的武器轮廓，但整体紫色
    var a = p.alpha, c = L.colors;
    var hp = weaponPos(L, cx, p, torso);
    rrect(g, c.main, a, hp.x - 2, hp.y - 16, 8, 22, 3);
    rrect(g, c.acc, 0.9 * a, hp.x - 1, hp.y - 16, 6, 6, 2);
  }

  function drawOffhand(g, L, cx, p, torso) {
    var c = L.colors, a = p.alpha, b = L.build;
    var o = L.offhand;
    if (!o || o === 'mirror') return;
    // 举盾帧：盾牌从身侧移到身前（压住躯干 = 一看就是"挡"）
    var hx = p.guard ? cx + b.bw * 0.34 : cx - b.bw * 0.5 - 5;
    var hy = p.guard ? torso.top + b.bh * 0.62 : torso.top + b.bh * 0.5;
    if (o === 'roundShield') {
      circ(g, c.sub, a, hx - 1, hy, 9);
      circ(g, lt(c.main, 0.1), a, hx - 1, hy, 7.5);
      circ(g, c.acc, 0.95 * a, hx - 1, hy, 3);
      circ(g, dk(c.sub, 0.7), a, hx - 1, hy, 1.4);
    } else if (o === 'towerShield') {
      rrect(g, c.sub, a, hx - 6, hy - 18, 13, 34, 4);
      rrect(g, lt(c.main, 0.08), a, hx - 4, hy - 16, 9, 30, 3);
      rect(g, c.acc, 0.95 * a, hx - 1, hy - 14, 3, 26);
      circ(g, c.acc, 0.8 * a, hx, hy - 10, 3);
    } else if (o === 'dagger') {
      rect(g, 0x3a2a14, a, hx - 1, hy - 1, 3, 6);
      rect(g, 0xd8d8e8, a, hx, hy - 12, 3, 14);
      tri(g, 0xeaeaf4, a, hx, hy - 12, hx + 3, hy - 12, hx + 1.5, hy - 16);
    } else if (o === 'axe') {
      rect(g, 0x5a4020, a, hx, hy - 18, 3, 28);
      tri(g, 0xc8c8d8, a, hx - 9, hy - 18, hx, hy - 11, hx - 9, hy - 4);
    } else if (o === 'fist') {
      rrect(g, c.main, a, hx - 7, hy - 8, 12, 16, 6);
      seg(g, 2, c.acc, 0.9 * a, hx - 6, hy - 3, hx + 1, hy + 2);
    }
  }

  // ============================================================
  //  部件：附加效果（光环 / 卷轴 / 宝珠 / 紫描边 …）
  // ============================================================
  function drawExtras(g, L, cx, p, torso) {
    var c = L.colors, a = p.alpha;
    var heads = [];

    if (L.extras.indexOf('halo') >= 0) {
      g.lineStyle(2, c.acc, 0.75 * a);
      g.beginPath(); g.arc(cx, torso.top - L.build.headR - 4 + p.dy, 7, Math.PI * 1.08, Math.PI * 1.92, false); g.strokePath();
    }
    if (L.extras.indexOf('aura') >= 0) {
      // 暗影光晕：贴着躯干的椭圆（大圆形光晕会被单元上下沿裁成硬边）
      ell(g, c.acc, 0.1 * a, cx, torso.top + L.build.bh * 0.5, L.build.bw + 14, L.build.bh + 12);
      ell(g, c.acc, 0.07 * a, cx, torso.top + L.build.bh * 0.5, L.build.bw + 22, L.build.bh + 20);
    }
    if (L.extras.indexOf('quiver') >= 0) {
      rect(g, 0x6a4a20, a, cx - L.build.bw * 0.62, torso.top + 2, 6, 18);
      for (var q = 0; q < 3; q++) {
        rect(g, 0xd8d8e8, 0.95 * a, cx - L.build.bw * 0.62 + 1 + q * 2, torso.top - 6, 1.6, 8);
        tri(g, c.acc, a, cx - L.build.bw * 0.62 + q * 2, torso.top - 6, cx - L.build.bw * 0.62 + 2.6 + q * 2, torso.top - 6,
          cx - L.build.bw * 0.62 + 1.3 + q * 2, torso.top - 10);
      }
    }
    if (L.extras.indexOf('scroll') >= 0) {
      var sx = cx - L.build.bw * 0.7;
      rrect(g, 0xd8c8a0, a, sx - 4, torso.top + 4 + p.arm, 9, 5, 2);
      rrect(g, 0xd8c8a0, a, sx - 4, torso.top + 16 + p.arm, 9, 5, 2);
      rect(g, c.acc, 0.8 * a, sx - 2, torso.top + 7 + p.arm, 5, 9);
    }
    if (L.extras.indexOf('orb') >= 0) {
      var ox = cx + L.build.bw * 0.75, oy = torso.top - 2 + Math.sin(p.dy * 0.8) * 2;
      circ(g, c.acc, a, ox, oy, 4.5);
      circ(g, 0xffffff, 0.55 * a, ox - 1, oy - 1, 2);
      circ(g, c.acc, 0.22 * a, ox, oy, 8);
    }
    if (L.extras.indexOf('ghostOrbs') >= 0) {
      circ(g, c.acc, 0.5 * a, cx - 12, torso.top - 6, 2.6);
      circ(g, c.acc, 0.4 * a, cx + 13, torso.top + 2, 2.2);
      circ(g, c.acc, 0.3 * a, cx + 8, torso.top - 12, 1.8);
    }
    if (L.extras.indexOf('tails') >= 0) {
      // 影尾：从背后拖出的两条
      for (var t = 0; t < 2; t++) {
        var tx = cx - L.build.bw * 0.5 - 6 - t * 5;
        tri(g, c.main, (0.5 - t * 0.15) * a, tx, torso.top + 10 + t * 6, tx - 8, torso.top + 4 + t * 10, tx, torso.top + 22 + t * 6);
      }
    }
    if (L.extras.indexOf('horns') >= 0) {
      tri(g, dk(c.acc, 0.8), 0.95 * a, cx - 8, torso.top + 2, cx - 16, torso.top - 6, cx - 5, torso.top + 6);
      tri(g, dk(c.acc, 0.8), 0.95 * a, cx + 8, torso.top + 2, cx + 16, torso.top - 6, cx + 5, torso.top + 6);
    }
    if (L.extras.indexOf('outline') >= 0) {
      // 镜像怪：紫色描边（与本体拉开一层）
      srect(g, 2, c.acc, 0.5 * a, cx - L.build.bw / 2 - 4, torso.top - 13, L.build.bw + 8, L.build.bh + 20, 7);
    }
    return heads;
  }

  // ============================================================
  //  远程攻击：弹药（箭矢 / 奥术弹 / 灵能波 / 长矛）
  //  与角色同一套做法 —— 代码绘制、按「外观 + 颜色」缓存、预览页可逐帧核对。
  //  一律朝右绘制，游戏里按飞行方向旋转整个精灵，所以帧只负责脉动与拖尾。
  // ============================================================
  //  bw/bh 是判定框（贴着可见墨迹，别让弹道打中看不见的地方）
  var SHOTS = {
    arrow: { w: 40, h: 16, bw: 34, bh: 12, frames: 3, name: '箭矢', note: '细长 · 有尾羽' },
    orb:   { w: 30, h: 30, bw: 22, bh: 22, frames: 4, name: '奥术弹', note: '圆形脉动 · 绕行光点' },
    wave:  { w: 40, h: 48, bw: 22, bh: 32, frames: 4, name: '灵能波', note: '新月波前 · 逐渐张开' },
    spear: { w: 50, h: 16, bw: 44, bh: 14, frames: 3, name: '长矛', note: '叶形矛尖 · 尾羽' }
  };

  function drawShotFrame(g, kind, color, fi, ox) {
    ox = ox || 0;
    color = color == null ? 0xffffff : color;

    if (kind === 'arrow') {
      var cy = 8;
      var tr = [10, 15, 7][fi] || 10;                       // 拖尾长度逐帧变化 = 飞行抖动
      rect(g, color, 0.18, ox + 2, cy - 1, tr, 2);
      rect(g, 0xffffff, 0.10, ox + 2, cy, tr + 5, 1);
      rect(g, 0x8a6a3a, 1, ox + 6, cy - 1, 24, 2);          // 箭杆
      tri(g, color, 1, ox + 7, cy - 1, ox + 2, cy - 5, ox + 2, cy - 1);      // 尾羽
      tri(g, color, 1, ox + 7, cy + 1, ox + 2, cy + 5, ox + 2, cy + 1);
      tri(g, 0xd8d8e8, 1, ox + 30, cy - 5, ox + 30, cy + 5, ox + 38, cy);    // 箭头
      rect(g, 0xf0f0f8, 1, ox + 30, cy - 1, 5, 2);
      return;
    }

    if (kind === 'orb') {
      var cx = ox + 15, cyy = 15;
      var s = [0.86, 1, 1.12, 0.96][fi] || 1;               // 脉动
      circ(g, color, 0.16, cx, cyy, 13 * s);
      circ(g, color, 0.4, cx, cyy, 9.5 * s);
      circ(g, color, 0.95, cx, cyy, 5.5 * s);
      circ(g, 0xffffff, 0.85, cx - 1.5 * s, cyy - 1.5 * s, 2.4 * s);
      var ang = fi * Math.PI / 2;                           // 绕行光点 = 自转感
      for (var k = 0; k < 3; k++) {
        var aa = ang + k * Math.PI * 2 / 3;
        circ(g, 0xffffff, 0.7, cx + Math.cos(aa) * 9 * s, cyy + Math.sin(aa) * 9 * s, 1.4);
      }
      return;
    }

    if (kind === 'wave') {
      var wy = 24;                                          // 画布加高后居中：波前两端不贴边
      var r = [12, 15, 17, 18][fi] || 15;
      var al = [0.92, 0.8, 0.62, 0.4][fi] || 0.8;           // 越飞越淡
      rect(g, color, 0.1 * al, ox + 2, wy - r * 0.55, 9, r * 1.1);   // 拖尾
      g.lineStyle(6, color, al);
      g.beginPath(); g.arc(ox + 12, wy, r, -1.0, 1.0, false); g.strokePath();
      g.lineStyle(3, 0xffffff, al * 0.55);
      g.beginPath(); g.arc(ox + 12, wy, r - 2.4, -0.85, 0.85, false); g.strokePath();
      tri(g, color, al, ox + 12 + r * Math.cos(-1.0), wy + r * Math.sin(-1.0),
        ox + 12 + r * Math.cos(-1.0) - 4, wy + r * Math.sin(-1.0) - 5,
        ox + 12 + r * Math.cos(-1.0) + 2, wy + r * Math.sin(-1.0) - 1);
      tri(g, color, al, ox + 12 + r * Math.cos(1.0), wy + r * Math.sin(1.0),
        ox + 12 + r * Math.cos(1.0) - 4, wy + r * Math.sin(1.0) + 5,
        ox + 12 + r * Math.cos(1.0) + 2, wy + r * Math.sin(1.0) + 1);
      return;
    }

    // spear：长矛（叶形矛尖 + 尾羽）
    var sy = 8;
    var tl = [10, 14, 8][fi] || 10;
    rect(g, color, 0.16, ox + 2, sy - 1, tl + 6, 2);
    rect(g, 0x8a7a5a, 1, ox + 6, sy - 1, 30, 3);            // 矛杆
    rect(g, dk(color, 0.7), 1, ox + 29, sy - 4, 3, 9);      // 绑绳
    tri(g, 0xe8e8f0, 1, ox + 33, sy - 6, ox + 33, sy + 6, ox + 46, sy);     // 矛尖
    tri(g, 0xffffff, 0.45, ox + 34, sy - 3, ox + 34, sy + 3, ox + 42, sy);
    tri(g, color, 1, ox + 7, sy - 1, ox + 2, sy - 5, ox + 2, sy - 1);
    tri(g, color, 1, ox + 7, sy + 1, ox + 2, sy + 5, ox + 2, sy + 1);
    if (fi === 1) circ(g, 0xffffff, 0.5, ox + 44, sy, 1.6);  // 尖端反光闪一下
  }

  function shotSize(kind) { var s = SHOTS[kind] || SHOTS.orb; return { w: s.w, h: s.h, bw: s.bw, bh: s.bh, frames: s.frames }; }
  function shotTextureKey(kind, color) { return 'rt_shot_' + kind + '_' + (color >>> 0).toString(16); }
  function shotAnimKey(kind, color) { return 'shot_' + kind + '_' + (color >>> 0).toString(16); }

  /** 把弹药精灵表切成 w×h 的帧（尺寸与角色的 64×64 不同，单独一份） */
  function registerFramesWH(scene, key, count, w, h) {
    var t = scene.textures.get(key);
    if (!t) return;
    for (var i = 0; i < count; i++) {
      if (!t.has(i)) t.add(i, 0, i * w, 0, w, h);
    }
  }

  /** 按「外观 + 颜色」生成弹药纹理（同色复用，换英雄只多一张） */
  function ensureShotTexture(scene, kind, color) {
    kind = SHOTS[kind] ? kind : 'orb';
    color = color == null ? 0xffffff : color;
    var key = shotTextureKey(kind, color);
    if (scene.textures.exists(key)) return key;
    var s = SHOTS[kind];
    var g = scene.make.graphics({ x: 0, y: 0 }, false);
    for (var f = 0; f < s.frames; f++) drawShotFrame(g, kind, color, f, f * s.w);
    g.generateTexture(key, s.w * s.frames, s.h);
    registerFramesWH(scene, key, s.frames, s.w, s.h);
    g.destroy();
    return key;
  }

  /** 弹药的循环动画（脉动 / 自转） */
  function ensureShotAnim(scene, kind, color, rate) {
    kind = SHOTS[kind] ? kind : 'orb';
    var key = shotAnimKey(kind, color), tex = ensureShotTexture(scene, kind, color);
    if (!scene.anims.exists(key)) {
      var list = [];
      for (var i = 0; i < SHOTS[kind].frames; i++) list.push(i);
      scene.anims.create({
        key: key, frames: scene.anims.generateFrameNumbers(tex, { frames: list }),
        frameRate: rate || 14, repeat: -1
      });
    }
    return key;
  }

  // ============================================================
  //  画一帧
  // ============================================================
  function drawFrame(g, look, fi, ox, kind) {
    var p = (kind === 'hero' ? heroPose(fi, look) : mobPose(fi));
    var c = look.colors;
    var b = look.build;
    var cx = ox + 32 + p.lean * 0.6;
    var hx = (p.lunge ? p.lunge : 0);

    // 地面投影（让角色落地更稳；死亡帧不加）
    if (!p.dead) {
      ell(g, 0x000000, 0.22 * p.alpha, cx, 58 + p.dy, b.bw + 6, 5);
    }
    cx += hx * 0.5;

    drawLegs(g, look, cx, p);
    if (p.roll) {
      // 翻滚：团身——只画一个低矮圆球 + 头饰轮廓
      var rc = look.colors;
      circ(g, rc.main, p.alpha, cx, 46 + p.dy, 15);
      circ(g, lt(rc.main, 0.14), 0.5 * p.alpha, cx - 4, 42 + p.dy, 8);
      rrect(g, rc.sub, p.alpha, cx - 14, 52 + p.dy, 28, 8, 4);
      rect(g, rc.acc, 0.85 * p.alpha, cx + 6, 42 + p.dy, 8, 3);
      return;
    }
    var torso = drawTorso(g, look, cx, p);
    drawHead(g, look, cx, p, null, torso);
    drawOffhand(g, look, cx, p, torso);
    drawWeapon(g, look, cx, p, torso);
    drawExtras(g, look, cx, p, torso);
    // 举盾帧：身前一道弧光盾（没拿盾的英雄靠它读，拿盾的再多一层强调）
    if (p.guard) {
      var gy = torso.top + b.bh * 0.5;
      g.lineStyle(4, c.acc, 0.5 * p.alpha);
      g.beginPath(); g.arc(cx + 6, gy, 20, -1.15, 1.15, false); g.strokePath();
      g.lineStyle(2, 0xffffff, 0.26 * p.alpha);
      g.beginPath(); g.arc(cx + 6, gy, 15, -1.0, 1.0, false); g.strokePath();
    }
  }

  // ============================================================
  //  精灵表
  // ============================================================
  function drawSheet(g, look, kind) {
    var n = (kind === 'hero' || (look.kind === 'hero')) ? HERO_FRAMES : MOB_FRAMES;
    for (var f = 0; f < n; f++) drawFrame(g, look, f, f * CELL, look.kind);
    return n;
  }

  function framesOf(look) { return look.kind === 'hero' ? HERO_FRAMES : MOB_FRAMES; }

  /** 把整张精灵表切成 CELL×CELL 的帧（与试炼2D.js 的精灵表约定一致） */
  function registerFrames(scene, key, count) {
    var t = scene.textures.get(key);
    if (!t) return;
    for (var i = 0; i < count; i++) {
      if (!t.has(i)) t.add(i, 0, i * CELL, 0, CELL, CELL);
    }
  }

  /** 角色的镜像版参数（镜像怪照玩家造型） */
  function mirrorLookOf(mirrorOf) {
    var src = LOOKS[mirrorOf] || LOOKS.warrior;
    return {
      kind: 'mob', build: src.build, colors: LOOKS.mimic.colors,
      head: src.head, weapon: src.weapon, offhand: src.offhand, legs: src.legs,
      extras: (src.extras || []).concat(['outline'])
    };
  }

  var inkCache = {};
  /**
   * 量出某个角色所有帧合起来的墨迹范围（离屏 canvas 画一遍再扫 alpha）。
   * 血条宽度、居中排布都按它来 —— 19 个角色的体型差得很多，按 64px 单元算会明显偏宽。
   */
  function inkOf(id, mirrorOf) {
    var key = id + "|" + (mirrorOf || "");
    if (inkCache[key]) return inkCache[key];
    var look = LOOKS[id];
    if (!look) return null;
    if (look === LOOKS.mimic) look = mirrorLookOf(mirrorOf);
    if (typeof document === "undefined") return null;
    var cv = document.createElement("canvas");
    cv.width = CELL; cv.height = CELL;
    var ctx = cv.getContext("2d");
    var g = canvasGraphics(ctx);
    var n = look.kind === "hero" ? HERO_FRAMES : MOB_FRAMES;
    var minX = CELL, maxX = -1, minY = CELL, maxY = -1;
    for (var f = 0; f < n; f++) {
      ctx.clearRect(0, 0, CELL, CELL);
      drawFrame(g, look, f, 0, look.kind);
      var d = ctx.getImageData(0, 0, CELL, CELL).data;
      for (var y = 0; y < CELL; y++) {
        for (var x = 0; x < CELL; x++) {
          if (d[(y * CELL + x) * 4 + 3] > 40) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
    }
    var box = maxX < 0 ? { x: 0, y: 0, w: CELL, h: CELL } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    inkCache[key] = box;
    return box;
  }

  /** 角色的视觉宽度（血条 / 居中用） */
  function visualWidth(id, mirrorOf) {
    var box = inkOf(id, mirrorOf);
    return box ? box.w : 40;
  }

  function heroTextureKey(id) { return 'rt_hero_' + (id || 'warrior'); }
  function mobTextureKey(key) { return 'rt_mob_' + (key || 'claw'); }

  function ensureHeroTexture(scene, id) {
    var look = LOOKS[id] || LOOKS.warrior;
    var name = heroTextureKey(LOOKS[id] ? id : 'warrior');
    if (scene.textures.exists(name)) return name;
    var g = scene.make.graphics({ x: 0, y: 0 }, false);
    drawSheet(g, look, 'hero');
    g.generateTexture(name, CELL * HERO_FRAMES, CELL);
    registerFrames(scene, name, HERO_FRAMES);
    g.destroy();
    return name;
  }

  /** 怪物精灵表；镜像怪传 mirrorOf = 玩家英雄 id（长成玩家的样子，紫色化） */
  function ensureMobTexture(scene, key, mirrorOf) {
    var look = LOOKS[key] || LOOKS.claw;
    var name = mobTextureKey(key);
    if (look === LOOKS.mimic) name = 'rt_mob_mimic_' + (mirrorOf || 'warrior');
    if (scene.textures.exists(name)) return name;
    var use = look;
    if (look === LOOKS.mimic) {
      var src = LOOKS[mirrorOf] || LOOKS.warrior;
      use = {
        kind: 'mob',
        build: src.build,                     // 体型照玩家
        colors: LOOKS.mimic.colors,           // 配色换成镜像紫
        head: src.head, weapon: src.weapon, offhand: src.offhand, legs: src.legs,
        extras: (src.extras || []).concat(['outline'])
      };
    }
    var g = scene.make.graphics({ x: 0, y: 0 }, false);
    drawSheet(g, use, 'mob');
    g.generateTexture(name, CELL * MOB_FRAMES, CELL);
    registerFrames(scene, name, MOB_FRAMES);
    g.destroy();
    return name;
  }

  function heroAnimKeys(id) {
    return {
      idle: 'hero_idle', run: 'hero_run', jump: 'hero_jump', fall: 'hero_fall',
      attack: 'hero_attack', hurt: 'hero_hurt', dead: 'hero_dead', roll: 'hero_roll'
    };
  }
  function mobAnimKeys(key) {
    return { walk: 'mob_' + key + '_walk', attack: 'mob_' + key + '_attack', hurt: 'mob_' + key + '_hurt', dead: 'mob_' + key + '_dead' };
  }
  /**
   * 动画节奏倍率：动作（招式）多的怪物帧率更高，动起来更利落，
   * 也顺带把「这只有几套招式」从动作上就读出来。默认 1。
   */
  function animRateOf(key) {
    var l = LOOKS[key];
    return (l && l.animRate) || 1;
  }

  // ============================================================
  //  Canvas2D 兼容层（预览页用；方法与 Phaser Graphics 子集一致）
  // ============================================================
  function css(c, a) {
    var r = (c >> 16) & 255, g2 = (c >> 8) & 255, b = c & 255;
    return 'rgba(' + r + ',' + g2 + ',' + b + ',' + (a == null ? 1 : a) + ')';
  }
  function canvasGraphics(ctx) {
    var fs = { c: 0xffffff, a: 1 }, ls = { w: 1, c: 0xffffff, a: 1 };
    var path = [];
    var g = {
      fillStyle: function (c, a) { fs.c = c; fs.a = a == null ? 1 : a; },
      lineStyle: function (w, c, a) { ls.w = w; ls.c = c; ls.a = a == null ? 1 : a; },
      fillRect: function (x, y, w, h) { ctx.fillStyle = css(fs.c, fs.a); ctx.fillRect(x, y, w, h); },
      fillRoundedRect: function (x, y, w, h, r) {
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.fillStyle = css(fs.c, fs.a);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath(); ctx.fill();
      },
      strokeRoundedRect: function (x, y, w, h, r) {
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.strokeStyle = css(ls.c, ls.a); ctx.lineWidth = ls.w;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath(); ctx.stroke();
      },
      fillCircle: function (x, y, r) { ctx.fillStyle = css(fs.c, fs.a); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); },
      strokeCircle: function (x, y, r) { ctx.strokeStyle = css(ls.c, ls.a); ctx.lineWidth = ls.w; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); },
      fillTriangle: function (x1, y1, x2, y2, x3, y3) {
        ctx.fillStyle = css(fs.c, fs.a);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.closePath(); ctx.fill();
      },
      fillEllipse: function (x, y, w, h) { ctx.fillStyle = css(fs.c, fs.a); ctx.beginPath(); ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill(); },
      strokeEllipse: function (x, y, w, h) { ctx.strokeStyle = css(ls.c, ls.a); ctx.lineWidth = ls.w; ctx.beginPath(); ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.stroke(); },
      beginPath: function () { path = []; },
      moveTo: function (x, y) { path.push(['m', x, y]); },
      lineTo: function (x, y) { path.push(['l', x, y]); },
      closePath: function () { path.push(['c']); },
      arc: function (x, y, r, s, e, acw) { path.push(['a', x, y, r, s, e, acw]); },
      strokePath: function () {
        ctx.strokeStyle = css(ls.c, ls.a); ctx.lineWidth = ls.w;
        ctx.beginPath();
        path.forEach(function (pt) {
          if (pt[0] === 'm') ctx.moveTo(pt[1], pt[2]);
          else if (pt[0] === 'l') ctx.lineTo(pt[1], pt[2]);
          else if (pt[0] === 'c') ctx.closePath();
          else if (pt[0] === 'a') ctx.arc(pt[1], pt[2], pt[3], pt[4], pt[5], !!pt[6]);
        });
        ctx.stroke();
      }
    };
    return g;
  }

  global.角色形象 = {
    CELL: CELL, HERO_FRAMES: HERO_FRAMES, MOB_FRAMES: MOB_FRAMES,
    LOOKS: LOOKS,
    RANGED: RANGED, MOB_SHOTS: MOB_SHOTS, SHOTS: SHOTS,
    drawFrame: drawFrame, drawSheet: drawSheet, framesOf: framesOf,
    ensureHeroTexture: ensureHeroTexture, ensureMobTexture: ensureMobTexture,
    heroTextureKey: heroTextureKey, mobTextureKey: mobTextureKey,
    drawShotFrame: drawShotFrame, shotSize: shotSize,
    ensureShotTexture: ensureShotTexture, ensureShotAnim: ensureShotAnim,
    shotTextureKey: shotTextureKey, shotAnimKey: shotAnimKey,
    heroAnimKeys: heroAnimKeys, mobAnimKeys: mobAnimKeys, animRateOf: animRateOf,
    inkOf: inkOf, visualWidth: visualWidth, mirrorLookOf: mirrorLookOf,
    canvasGraphics: canvasGraphics
  };
})(typeof window !== 'undefined' ? window : this);
