/**
 * ============================================================
 *  深渊回廊 · 2D 实时战斗前端（战斗2D）
 * ------------------------------------------------------------
 *  定位：可插拔的实时战斗**表现层**，自身不含任何「试炼」业务语义。
 *    · 楼层 / 房间序列由宿主下发（setFloorPlan）；未下发时退化为自造地图
 *    · 奖励三选一 / 诅咒抉择 / 事件 / 休整面板在本层绘制，选项内容由宿主给定
 *    · 清房、结算、中途存档通过 game 事件与 bridge 回调宿主
 *  玩法：横版侧视实时动作战斗（泰拉瑞亚 / 马里奥风格）
 *   - 左右跑动、重力跳跃、蓄力跳（按住蓄力、松开起跳，越久越高）
 *   - 近战挥砍：前摇 → 判定帧 → 后摇，带范围判定与击退
 *   - 跳劈：滞空时挥砍 → 高速下落斩，命中与落地都会造成范围冲击
 *   - 敌人自主 AI：巡逻 → 察觉 → 追击 → 攻击 → 受击 → 死亡
 *   - 敌人属性显示：头顶血条 + HUD 目标面板（生命/攻击/速度/行为）
 *   - 房间地图：每层生成分支网格地图，清空房间后打开地图点击进入下一房间
 *     房间类型：入口 / 普通 / 精英 / 镜像 / Boss / 宝箱 / 祭坛 / 商店 / 休整点 / 随机事件
 *   - 环境主题：按难度切换星雾与火星（简单·白星光 普通·蓝星光 困难·暖色 地狱·红焰）
 *   - 全屏渲染，HUD 全部由 Phaser 画在游戏画面内（不依赖 DOM 文本层）
 *   - 画面内死亡 / 商店：死亡结算与商店都在 2D 画面中完成，
 *     结束本局走画面内的「菜单」，新版已没有第二个可切换的视图
 *
 *  属性映射（沿用经典模式养成）：
 *   攻击力 → 挥砍基础伤害      暴击率 → 暴击概率
 *   暴击伤害 → 暴击倍率        闪避 → 受击闪避率
 *   荆棘 → 被击中反伤          吸血 → 造成伤害回血
 *   连击 → 连段伤害递增        斩杀 → 低血敌人处决
 *   护盾 → 优先扣减的临时血量
 * ============================================================
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'abyss_trial2d_settings';
  var LAYOUT_KEY = 'abyss_trial2d_layout';   // 玩家自定义的面板 / 按钮布局
  // 常驻功能按钮的中文名（布局编辑器里一颗按钮一个单元，用它们做单元标题）
  // ⚠️ P5 试炼关停后「文字界面」按钮已移除（合并后没有可切换的视图了，
  //    切老版由侧边栏负责）——这里的 text 项一并删掉，避免留下无主单元。
  // ⚠️ 「更多」与「退出」已合并为**一颗「菜单」**（v2.8）：
  //    · 「更多」原本只是打开 DOM 侧边栏，而侧边栏那批功能（作弊 / 通关条件 /
  //      教程 / 存档管理 / 图鉴 / 难度 / 切换老版）现在直接画在画布菜单里，
  //      2D 画面不再需要「画布 → DOM 侧边栏 → 目标面板」这个中间层；
  //    · 「退出」点下去弹的本来就是暂停菜单（里面叫「结束本局」），
  //      名字与行为对不上 —— 玩家会以为「退出不见了」。
  //    合并成「菜单」后，一颗按钮 = 一个中枢，Esc 走同一个入口。
  var HUD_BTN_LABELS = {
    stats: '属性', shop: '商店', codex: '图鉴', settings: '设置', menu: '菜单'
  };
  // 菜单里显示的难度中文名（与 主界面.html 难度下拉的文案逐字一致）
  var DIFF_CN = { easy: '简单', normal: '普通', hard: '困难', hell: '地狱', custom: '自定义' };
  var GRAVITY = 1700;
  var CELL = 64;

  // ===== 遗物条（v2.8.1）几何 =====
  // 位置刻意夹在「狂怒条」与「属性面板」之间：
  //   狂怒条 y ≈ 74（条高 8，下沿约 78）
  //   → 遗物条中心 104（17px 图标占 95.5~112.5）
  //   → 属性面板首行中心 124（top0 = 104 + RELIC_ROW_H）
  // ⚠️ RELIC_ROW_H 必须 ≥ 20：它决定属性面板从哪一行开始。
  //    第一版写成 24 时算出来是 128，而 statPanelMetrics 原本的首行是 106 ——
  //    实测「遗物」标签与属性面板的「攻」叠在了一起。20 是「图标下沿 112.5
  //    到首行中心 124」留出 11.5px 后的最小值，再小就压字了。
  var RELIC_ROW_CY = 104;   // 行中心
  var RELIC_ROW_H = 20;     // 行占位高度（属性面板按它下让）

  // 蓄力跳参数：按住跳跃键蓄力，松开才起跳，蓄得越久跳越高
  // 跳跃高度 = 初速度² / (2 × 重力)，以此推算能上的平台高度
  var CHARGE = {
    max: 620,        // 满蓄力所需时间(ms)
    minPower: 520,   // 轻点（最快松开）→ 约 80px 小跳
    maxPower: 1150,  // 满蓄力 → 约 390px 高跳（可上最高平台）
    coyote: 110      // 土狼时间(ms)：离开平台后仍可蓄力的宽限
  };

  // 跳劈（下落攻击）：滞空时挥砍触发，高速砸向地面
  // 命中敌人有蓄力倍率，落地产生范围冲击波
  var DIVE = {
    speed: 960,        // 下坠速度（px/s）
    mult: 1.9,         // 下落斩命中倍率
    splashMult: 1.15,  // 落地冲击波倍率
    splashRadius: 130, // 落地冲击波半径
    cooldown: 360,     // 两次跳劈之间的最短间隔(ms)

    // 「把敌人砸进地里」——这是一条**刻意保留的特性**，不是 bug。
    // 以前它其实是物理事故的副产品：英雄以 960px/s 下坠，和敌人之间挂着 collider，
    // 一帧挤一点，最后把敌人压穿地面；而敌人真的沉到地面以下之后就打不到、
    // 也清不掉，变成死局。现在改成显式机制：
    //   · 跳劈命中时按概率触发，压扁 + 地裂 + 尘土，敌人被「钉」在地里一段时间
    //   · 只动视觉（缩放），**物理体一动不动** —— 玩家照样打得到，清得掉
    //   · 下坠期间临时关掉「英雄 ↔ 敌人」的碰撞，从根上不再挤压
    buryChance: 0.38,  // 跳劈命中时砸进地里的概率
    buryTime: 1300,    // 陷在地里的时长(ms)
    burySquash: 0.42   // 压扁到原本高度的比例
  };

  // 闪避（翻滚冲刺）：消耗体力换取短暂无敌。
  // 在敌人攻击命中的瞬间闪避 → 完美闪避：体力全额返还 + 震开周围敌人 + 锐利强化
  var DODGE = {
    cost: 30,           // 体力消耗
    speed: 520,         // 冲刺速度(px/s)
    time: 260,          // 冲刺时长(ms)
    invuln: 320,        // 无敌帧(ms)
    perfect: 150,       // 完美窗口(ms)：闪避起手后这段时间内挡下伤害即完美
    recover: 110,       // 收招(ms)：结束后才能再闪
    airDrag: 0.55,      // 空中闪避每帧保留的下坠速度（近滞空）
    radius: 175,        // 完美闪避影响半径
    stun: 900,          // 完美闪避：范围内敌人定身(ms)
    sharp: 3000,        // 锐利（完美闪避强化）持续(ms)
    sharpMult: 2.2      // 锐利伤害倍率
  };

  // 体力：闪避的唯一资源，停手后自动回复
  var STAMINA = {
    max: 100,
    regen: 58,     // 每秒回复
    delay: 420     // 消耗后延迟(ms)才开始回复
  };

  // 英雄技能（实时化）：主动技能每层一次，被动常驻
  // 文字模式是回合制数值（+6 护盾、「下一次攻击 +5 伤害」），这里按实时战斗的尺度重做；
  // 技能名与语义与英雄图鉴（主程序.js 的 heroOptions）保持一致
  var SKILL = {
    power: 3000,      // 「下一次攻击 +N」类技能在实时里的强化时长(ms)
    burstR: 210,      // 元素风暴半径
    arrowSpeed: 900,  // 精准射击：穿透箭速度
    arrowLife: 700,   // 穿透箭存活(ms)
    arrowMult: 2      // 穿透箭伤害倍率
  };

  /**
   * 远程英雄的普攻（按 J / 触摸攻击钮）
   * 游侠、法师、贤者的武器本来就是弓与杖，普攻改成专属远程攻击，不再挥砍。
   * 数值取向：三者互相拉开 —— 射速 / 单体威力 / 覆盖方式各不相同，
   * 谁上场都能一眼从弹道认出来。外观（外观 kind、颜色、招式名）取自 角色形象.RANGED。
   *   cd      攻击间隔(ms)
   *   speed   弹速 px/s
   *   dmg     伤害倍率（乘英雄攻击力）
   *   pierce  可命中敌人数（1 = 命中即消失）
   *   life    存活(ms) → 射程 ≈ speed × life
   *   homing  每秒向最近敌人转过的弧度（追踪强度）
   *   splash  命中后的溅射半径 / splashMult 溅射伤害倍率
   *   knock   命中造成的硬直(ms)
   */
  var RANGED_ATTACK = {
    ranger: { cd: 300, speed: 780, dmg: 1.00, pierce: 2, life: 900, knock: 110, spin: false },
    mage:   { cd: 560, speed: 430, dmg: 1.15, pierce: 1, life: 1600, homing: 3.4, splash: 58, splashMult: 0.55, knock: 60, spin: true },
    sage:   { cd: 470, speed: 400, dmg: 0.85, pierce: 99, life: 1150, knock: 150, spin: false, wide: 34 }
  };

  /**
   * 防御（举盾）：按住 S / ↓
   * 文字模式的「防御」是一次 +3 护盾，实时里做成一个**姿态**：
   *   · 正前方减伤 75%，背后不减伤（鼓励转身顶着打）
   *   · 举盾持续消耗体力 —— 和闪避抢同一个资源池，形成「闪 or 挡」的抉择
   *   · 刚举起来的 200ms 内挡下 = **完美格挡**，完全免伤 + 反弹 + 护盾 + 盾反窗口
   *     （奖励只给时机，不给长按；一直举着只能减伤，还会把体力耗光）
   */
  var GUARD = {
    drain: 14,           // 举盾每秒消耗体力
    minStamina: 12,      // 体力低于此值无法举盾
    reopen: 30,          // 因为体力不足放下盾后，要回到这个值才能再举（避免一放一举地抖）
    moveScale: 0.42,     // 举盾时的移动速度倍率
    front: 0.25,         // 正面减伤：只吃 25% 伤害
    raise: 70,           // 举盾起手(ms)：抬盾这段时间还没成型，不减免
    perfect: 200,        // 举盾成型后 200ms 内挡下 = 完美格挡
    shieldGain: 3,       // 完美格挡 +3 护盾（= 文字模式「防御」的数值）
    guardianBonus: 2,    // 守护者被动「坚壁防御」：每次防御额外 +2 护盾
    stun: 700,           // 完美格挡把攻击者顶住(ms)
    counter: 1200,       // 盾反窗口(ms)
    counterMult: 2,      // 盾反伤害倍率
    counterLunge: 210    // 盾反的前冲速度
  };

  /**
   * 连招：在窗口内接上下一击就有额外效果（近战：强化挥砍）
   * 窗口、优先级、按键时机与远程共用一套；远程的招式另见 RANGED_CHAIN
   */
  var CHAIN = {
    window: 760,             // 连招衔接窗口(ms)
    sweepAt: 3,              // 第 3 段变「横扫」
    sweepMult: 1.4,
    sweepRange: 1.5,
    dodgeWindow: 900,        // 闪避结束后接攻击 = 突进斩
    dodgeMult: 1.5,
    dodgeLunge: 240,
    diveWindow: 700,         // 跳劈落地后接攻击 = 落地斩
    diveMult: 1.3,
    diveSplash: 0.6,         // 落地斩附带的小范围伤害比例
    diveSplashR: 96
  };

  /**
   * 远程英雄的连招（游侠 · 弓 / 法师 · 法杖 / 贤者 · 卷轴）
   * 触发时机、衔接窗口与优先级与近战**一模一样**（同一套 pickChain 分支），
   * 但招式本身必须换成远程该有的东西 —— 弓和法杖既挥不出「横扫」，
   * 也不需要为了打人把自己「突进」到怪脸上：
   *   完美格挡 → **反击箭**：拉满的一箭，穿透 3、必定暴击，靠强击退把怪推开（自己不冲）
   *   翻滚之后 → **连珠箭**：连续点射 3 发（间隔 80ms、几乎同一条线），
   *                每发重新瞄准最近的敌人 —— 目标是**单个硬目标**（精英 / 首领）的持续输出，
   *                与三连散（一次铺开好多个目标）正好互补
   *   空中射击落地 → **踏地箭**：远程没有跳劈，窗口改挂在「空中射击后落地」上；箭插地即炸一圈
   *   地面连按 J 第 3 下 → **三连散**：一次射出多支（多目标时一支锁一个），中近距离全覆盖
   * 招式名按英雄分开（弓 / 法杖 / 卷轴各一套，写在 角色形象.RANGED[id].chains），
   * 数值留在这里 —— 与 RANGED_ATTACK 的分工一致：形象归形象、手感归手感。
   */
  var RANGED_CHAIN = {
    counter: {
      key: 'counter', name: '反击箭', mult: 2.0, forceCrit: true,
      pierce: 3, knock: 340, speedMult: 1.15, boost: 1.45, color: '#ffd76a'
    },
    roll: {
      key: 'roll', name: '连珠箭', mult: 0.8, burst: 3, burstGap: 80,
      speedMult: 1.2, boost: 1.2, color: '#8ad8ff'
    },
    land: {
      key: 'land', name: '踏地箭', mult: 1.3, blast: 96, blastMult: 0.6,
      grav: 900,          // 下坠弧线：朝地面瞄，插地即炸
      boost: 1.35, color: '#ff9a5a'
    },
    triple: {
      key: 'triple', name: '三连散', mult: 1.0, spread: 3, spreadDeg: 12,
      sideMult: 0.68, boost: 1.15, color: '#f0d06a'
    }
  };

  /**
   * 腐化脉冲：所有「每回合」类的诅咒 / 环境效果在实时里的节拍
   * 文字模式的一回合 ≈ 这里的一次脉冲（5 秒），玩家看得见倒计时，也躲得开站位。
   */
  var PULSE = { period: 5000, warn: 1500 };   // 兜底值：宿主可用 setPulseProfile 覆盖

  /**
   * 脉冲节拍默认曲线（规划 §3.12）
   * 回合上限取消后，压力由「脉冲节拍」承担：层数越深、本层清掉的房间越多脉冲越快。
   * 它只改**每回合类效果多久结算一次**，不动敌人数值、不新增伤害来源。
   */
  var PULSE_BY_DIFFICULTY = {
    easy:   { start: 6000, step: 250, min: 3200 },
    normal: { start: 5000, step: 350, min: 2600 },
    hard:   { start: 4400, step: 450, min: 2200 },
    hell:   { start: 3800, step: 550, min: 1800 },
    custom: { start: 5000, step: 350, min: 2600 }
  };

  // ============================================================
  //  宿主主权（交接接口）
  //  ------------------------------------------------------------
  //  引擎是**表现层**：楼层规划 / 诅咒池 / 遗物 / 脉冲节拍都该由宿主决定。
  //  这里每一项都是「宿主没下发时的兜底」—— 下发过就以宿主的为准。
  //  因此老宿主（试炼程序.js）一行都不用改，行为与从前完全一致。
  // ============================================================
  var HOST = {
    floorPlan: null,   // setFloorPlan：null = 用内置 generateFloorMap 自造地图
    cursePool: null,   // setCursePool：null = 用内置 RT_CURSES 那 10 条
    relics: [],        // setRelics：本局遗物（字符串 id，或 { id, name, ... }）
    relicFx: null,     // 遗物折成的系数（recomputeRelicFx 算好，热路径只读）
    pulse: null,       // setPulseProfile：null = 按难度取 PULSE_BY_DIFFICULTY
    enemyScaler: null, // setEnemyScaler：null = 用引擎内置曲线；宿主接了就用宿主的（数值统一）
    godMode: false     // setGodMode：作弊面板 / 开发者命令的「无敌」
  };

  /**
   * 遗物效果表（只放「能用一组系数表达」的；需要介入结算的走三个钩子）
   * ------------------------------------------------------------
   * 键 = 遗物 id；值里的**数值项累加**、**字符串项记为开关**（用 hasPerk 查）。
   * 引擎侧消费点：
   *   stamMax / stamRegen      → 体力（STAMINA）
   *   guardPerfect             → 完美格挡窗口（GUARD.perfect）
   *   goldGain                 → 击杀 / 宝箱金币（killEnemy）
   *   takenMult                → 承受伤害（damageHero）
   *   dmgMult / dmgLowHp       → 造成伤害（rollPlayerDamage）
   *   healKill                 → 击杀回血（killEnemy）
   *   thorn                    → 反伤（damageHero，走 hero.thorn）
   * ⚠️ P1 只铺通路：先放 3 条用于回归验证；24 件的完整内容见
   *    《待做/2.7规划.md》§3.4，P3 按同一张表补齐即可，不必再动引擎骨架。
   */
  /* ------------------------------------------------------------
     遗物效果表（A 项「遗物构筑化」）
     ------------------------------------------------------------
     改造前的 24 件**全部是无条件数值**（+80ms 窗口、+30 体力……）：
     拿到任何一件都不需要改变打法，只是数字更好 —— 这正是
     「更新只是在堆数量、玩起来没深度」的根源：**数量不产生新的决定**。

     现在每一条都按同一个标准重写：
       ① **有条件**：效果挂在某个玩家可以主动去创造的状态上（残血 / 连携 / 完美判定）
       ② **有流派**：同流派之间互相放大（见下面的分组）
       ③ **有代价**：至少不再是无痛增益（贪婪流拿受伤换收益）

     四个流派（school，与宿主 RELIC_POOL 的 school 字段一一对应；
     构筑面板与三选一卡片都按它显示，玩家能看出自己正在凑哪一套）：
       blood   血怒 —— 主动掉血换输出：破釜沉舟 + 血之饥渴 + 荆棘之心 + 狂热之血
       perfect 完美 —— 判定窗口与收益：完美直觉 + 铁壁 + 反击之刃 + 锐利核心
       link    连携 —— 新资源本身：连携之心 + 不屈意志 + 回响精通（见文件里的 LINK）
       greed   贪婪 —— 收益换风险：贪婪之心 + 商人眼光 + 命运轮盘

      ⚠️ 双套遗物（2.9.2 · F7）：下面有 4 件是 `{ melee, ranged }` 而不是扁平对象 ——
      同一件遗物在近战 / 远程英雄手上是**两个不同的东西**（名字、描述、图标、效果全换）。
      取用规则只有一处：recomputeRelicFx() 按 heroRanged() 取一份，**绝不两份同时生效**。
      有双套的是 trackingCharm / piercingArrow / heavyStrike / chainMaster。
     ------------------------------------------------------------ */
  var RELIC_FX = {
    // ===== 血怒流：越残越猛（条件全是"当前生命比例"，玩家可以主动去够）=====
    desperateStrike: { dmgPerMissingHp: 0.07 },                        // 破釜沉舟：每损失 10% 生命，伤害 +7%（取代原来的"半血以下 +25%"开关）
    bloodThirst:     { vampireExtra: 1, vampLowHpMult: 1 },            // 血之饥渴：吸血 +1；生命 ≤50% 时翻倍
    thornHeart:      { thornExtra: 3, thornLowHpMult: 1 },             // 荆棘之心：反伤 +3；生命 ≤50% 时翻倍
    furyBlood:       { furyGain: 0.35, furyLowHp: 0.35 },              // 狂热之血：狂怒获取 +35%；生命 ≤50% 时再 +35%
    immortalTotem:   { perk: 'totem' },                                // 不朽图腾：致命伤保留 1 血 —— 血怒流的保险丝（敢残血的前提）

    // ===== 完美流：把判定窗口和判定收益一起堆起来 =====
    perfectInstinct: { perfectWindow: 80, sharpDur: 2000 },            // 完美直觉：完美闪避窗口 +80ms、锐利 +2s
    ironWall:        { guardPerfect: 80 },                             // 铁壁：完美格挡窗口 +80ms
    counterBlade:    { counterMult: 1, guardShield: 3 },               // 反击之刃：盾反 ×2→×3 并回 3 护盾
    sharpCore:       { sharpMultSet: 3.0 },                            // 锐利核心：锐利倍率 2.2 → 3.0
    windShadow:      { dodgeInvuln: 120, dashDist: 0.15 },             // 疾风残影：无敌帧 +120ms、冲刺 +15%

    // ===== 连携流：新资源（LINK）的三个旋钮 —— 上限 / 耐打 / 强度 =====
    linkHeart:       { linkMax: 2 },                                   // 连携之心：上限 3 → 5
    unbroken:        { perk: 'unbroken' },                             // 不屈意志：挨打时连携只 −1、不清零
    echoMaster:      { linkDmg: 0.6 },                                 // 回响精通：连携倍率 1.6 → 2.2

    // ===== 贪婪流：收益换风险 =====
    greedyHeart:     { goldGain: 0.60, takenMult: 0.20 },              // 贪婪之心：金币 +60%；受伤 +20%（代价与收益一起翻倍）
    merchantEye:     { shopDiscount: 0.25 },                           // 商人眼光：商店价格 −25%
    fateWheel:       { perk: 'fateWheel' },                            // 命运轮盘：每清一房随机收益
    soulDrinker:     { healKill: 2, healKillLowHp: 2 },                // 汲魂者：击杀回 2；生命 ≤50% 时回 4

    // ===== 生存 / 机动 / 输出（保留原有手感，各挑一条做成"条件型"）=====
    lightBoots:      { stamMax: 30, stamRegen: 0.30 },                 // 轻盈之靴：体力上限 +30、停手回复 +30%
    airFeather:      { airDrag: 0.40, airDodgeFree: 1 },               // 滞空之羽：空中闪避坠速更小，且不耗体力
    shieldResonance: { shieldGain: 2, perfectShield: 3 },              // 护盾共鸣：护盾 +2；完美格挡额外 +3
    chainMaster: {
      melee:  { chainWindow: 250, sweepMult: 0.50 },                   // 连击大师：连招窗口 +250ms、横扫 +50%
      ranged: { shotInterval: 0.12, thirdShotMult: 0.50 }              // 连珠：连射间隔 −12%、每第 3 发 +50%
    },
    executioner:     { executeBonus: 0.10, executeLink: 1 },           // 处决者：斩杀线 +10%；斩杀成功回 1 连携
    huntMark:        { executeSet: 0.50 },                             // 猎杀标记：斩杀线提升至 50%
    heavyStrike: {
      melee:  { diveMult: 0.40, buryChance: 0.12, diveLinkMult: 0.6 }, // 重击：跳劈 +0.4、埋人 +12%；跳劈吃连携时倍率再 +0.6
      ranged: { airShotDmg: 0.40, airSplash: 40 }                      // 坠星：空中射击 +0.4、命中溅射 40px
    },
    trackingCharm: {
      melee:  { swingAim: 12, swingWidth: 6 },                         // 觅隙：挥砍朝最近敌人偏 12°、判定宽 +6px
      ranged: { homing: 0.50, shotSpeed: 0.10 }                        // 追踪符：追踪 +50%、弹速 +10%
    },
    piercingArrow: {
      melee:  { sweepExtra: 1 },                                       // 裂阵：横扫多命中 1 个目标
      ranged: { pierce: 1 }                                            // 穿透之矢：穿透 +1
    },
    abyssMark:       { perk: 'fourChoices' }                           // 深渊印记：三选一变四选一
  };


  /**
   * 把遗物加成写回机制常量（每次下发遗物整体重算）
   * 一律「基准 + 增量」或「基准 × 倍率」，绝不做累加 —— 否则反复下发会越加越多。
   * 注意：这里只动"机制参数"，不改伤害结算；伤害/金币那类走 Scene 里的 relicFx() 热路径。
   */
  function applyMechRelics() {
    var fx = HOST.relicFx || {};
    function num(k, d) { var v = fx[k]; return (typeof v === 'number') ? v : (d || 0); }

    STAMINA.max = Math.round(MECH_BASE.staminaMax + num('stamMax', 0));
    STAMINA.regen = MECH_BASE.staminaRegen * (1 + num('stamRegen', 0));

    DODGE.invuln = Math.round(MECH_BASE.dodgeInvuln + num('dodgeInvuln', 0));
    DODGE.speed = Math.round(MECH_BASE.dodgeSpeed * (1 + num('dashDist', 0)));
    DODGE.perfect = Math.round(MECH_BASE.dodgePerfect + num('perfectWindow', 0));
    DODGE.sharp = Math.round(MECH_BASE.dodgeSharp + num('sharpDur', 0));
    DODGE.sharpMult = num('sharpMultSet', 0) > 0
      ? num('sharpMultSet', 0)
      : MECH_BASE.dodgeSharpMult * (1 + num('sharpMult', 0));
    DODGE.airDrag = Math.max(0.05, MECH_BASE.dodgeAirDrag * (1 - num('airDrag', 0)));

    GUARD.perfect = Math.round(MECH_BASE.guardPerfect + num('guardPerfect', 0));
    GUARD.counterMult = MECH_BASE.guardCounterMult + num('counterMult', 0);
    // 注意 key 是 guardShield（完美格挡给多少），不是 shieldGain（护盾共鸣的"所有来源 +2"）——
    // 两者若共用一个 key，完美格挡会吃到两次加成。
    GUARD.shieldGain = Math.round(MECH_BASE.guardShieldGain + num('guardShield', 0));

    CHAIN.window = Math.round(MECH_BASE.chainWindow + num('chainWindow', 0));
    CHAIN.sweepMult = MECH_BASE.chainSweepMult * (1 + num('sweepMult', 0));

    DIVE.mult = MECH_BASE.diveMult + num('diveMult', 0);
    DIVE.buryChance = Math.min(0.9, MECH_BASE.diveBuryChance + num('buryChance', 0));

    var fg = 1 + num('furyGain', 0);
    FURY.gainKill = Math.max(1, Math.round(MECH_BASE.furyGainKill * fg));
    FURY.gainChain = Math.max(1, Math.round(MECH_BASE.furyGainChain * fg));
    FURY.gainPerfect = Math.max(1, Math.round(MECH_BASE.furyGainPerfect * fg));
    FURY.gainHurt = Math.max(1, Math.round(MECH_BASE.furyGainHurt * fg));
    FURY.gainHit = {
      normal: Math.max(1, Math.round(MECH_BASE.furyGainHit.normal * fg)),
      elite: Math.max(1, Math.round(MECH_BASE.furyGainHit.elite * fg)),
      mirror: Math.max(1, Math.round(MECH_BASE.furyGainHit.mirror * fg)),
      boss: Math.max(1, Math.round(MECH_BASE.furyGainHit.boss * fg))
    };

    // 连携（LINK）：上限与倍率 —— A 项「遗物构筑化」的接口。
    // 遗物可以买到"连携上限 +1"或"回响更强"，于是「完美判定流」从
    // "靠手感的运气"变成一条能主动堆出来的构筑路线。
    LINK.max = Math.max(1, Math.round(MECH_BASE.linkMax + num('linkMax', 0)));
    LINK.dmgMult = MECH_BASE.linkDmgMult + num('linkDmg', 0);

    var pierceAdd = Math.round(num('pierce', 0));
    var shotScale = 1 + num('shotSpeed', 0);
    var homingScale = 1 + num('homing', 0);
    ['ranger', 'mage', 'sage'].forEach(function (h) {
      var ra = RANGED_ATTACK[h], b = MECH_BASE.ranged[h];
      if (!ra || !b) return;
      ra.pierce = b.pierce + pierceAdd;
      ra.speed = Math.round(b.speed * shotScale);
      ra.cd = Math.round(b.cd * (1 - Math.min(0.5, num('shotInterval', 0))));   // 连珠：连射间隔 −12%
      if (b.homing > 0) ra.homing = b.homing * homingScale;
    });

    // 体力上限同步（2.9.1 F8）
    // ------------------------------------------------------------
    // HUD 读的是 `hero.maxStamina`，而它是**建号时从 STAMINA.max 复制一次**的
    // （见 create 里的 hero.maxStamina = STAMINA.max）。遗物改变上限后不同步，
    // 「轻盈之靴：体力上限 +30」就只改了常量、画面与实际可用上限都还是 100。
    // 反过来（去掉遗物）也要收一次：当前值不能超过新上限。
    // 同类字段目前只有这一个；连携上限（LINK.max）每次现读，不受影响。
    var sc = state.scene;
    if (sc && sc.hero) {
      sc.hero.maxStamina = STAMINA.max;
      if (sc.hero.stamina > sc.hero.maxStamina) sc.hero.stamina = sc.hero.maxStamina;
    }
  }

  /** 奖励 / 遗物品质配色（沿用引擎既有语义色，不引入新色） */
  var QUALITY_STYLE = {
    common:    { name: '普通', tint: 0x9aa0b0, color: '#c8cede' },
    rare:      { name: '稀有', tint: 0x4a8ad0, color: '#7ab8ff' },
    legendary: { name: '传说', tint: 0xd4a02a, color: '#ffd76a' }
  };

  /**
   * 环境效果 HUD（实时化 · 每房间一换）
   * 三件事在这里定死：
   *   1) 节奏 —— 2D 的一层是 8 个房间的实时战斗，如果只在深入下一层时重掷，
   *      一局下来只碰得到三五，池子里另外十个永远轮不到。所以改成**每进一个房间重掷一次**，
   *      由宿主用「袋抽」发牌（15 个洗成一叠，抽完才重洗），谁都不会被漏掉。
   *   2) 位置 —— 钉在屏幕右上角的「房间 · 已探索」正下方。注意必须挂进 scrollFactor(0) 的
   *      hud 容器里：只写 this.add.text 的话它会跟着镜头滚，跑到房间中段就看不见了。
   *   3) 可读 —— 除了名字与数值，还要写清它在这套实时战斗里**实际是什么**
   *      （WORLD_ENVS 的 rt 文案，把 {值} 换成真实数值），不然"厄运 +21%"等于没说。
   */
  var ENV = {
    panelW: 302,     // 面板最大宽度（窄屏按窗口收窄）
    padX: 14,        // 内边距（左右）
    padY: 10,        // 内边距（上下）
    gapRoom: 14,     // 与「房间 · 已探索」那一行的间距
    gapCurse: 8,     // 面板与诅咒条之间的间距
    bossClear: 124,  // 层主血条在场且横向撞上时，面板下移到这一行
    lockRange: 520,  // 连珠箭的锁定距离：超出这个距离就不再拐弯，保持平射
    flash: 1200      // 换环境时面板高亮时长(ms)
  };

  /**
   * 试炼诅咒（实时化）
   * 名字与文字版试炼完全一致；desc 是文字模式的原文，rt 是它在 2D 里实际变成什么 ——
   * 「每回合」统一译成「每 5 秒一次腐化脉冲」，而「每回合 -1 攻击 / -5% 闪避」这类
   * 会永久削人的诅咒改成**同一房间内累积、清空房间后恢复**（否则一层下来角色就废了）。
   */
  var RT_CURSES = [
    { name: '脆弱', desc: '每回合减少2点护盾', rt: '每 5 秒失去 2 点护盾' },
    { name: '吸血反噬', desc: '每次攻击后自身损失1点生命', rt: '每次命中敌人后自身失去 1 点生命（无视护盾）' },
    { name: '荆棘诅咒', desc: '受到攻击时额外受到1点伤害', rt: '每次被命中额外承受 1 点伤害' },
    { name: '药水衰减', desc: '药水治疗效果减半', rt: '所有治疗效果减半（药水 / 祭坛 / 技能 / 魂晶）' },
    { name: '护甲腐蚀', desc: '每回合失去1点护盾', rt: '每 5 秒失去 1 点护盾' },
    { name: '虚弱', desc: '每回合攻击力-1（最低0）', rt: '每 5 秒攻击 -1（最低 1）；清空房间后恢复' },
    { name: '迟钝', desc: '每回合闪避率-5%（最低0）', rt: '每 5 秒闪避 -5%（最低 0）；清空房间后恢复' },
    { name: '生命流失', desc: '每回合失去1点生命（无视护盾）', rt: '每 5 秒失去 1 点生命（无视护盾）' },
    { name: '易伤', desc: '受到伤害+2', rt: '每次被命中额外承受 2 点伤害' },
    { name: '贪婪', desc: '战斗胜利金币减半', rt: '击杀敌人与开宝箱获得的金币减半' }
  ];

  /**
   * 经典模式环境效果（实时化）
   * 名字与经典模式一致；rt 说明它在 2D 里落到哪个动作上。
   * 附带的钩子名就是实现位置，方便对照调试。
   */
  var WORLD_ENVS = [
    { name: '荆棘之地', desc: '每次攻击时受到 {value} 当前生命的反弹伤害（无视护盾）', rt: '每次命中敌人，自己也掉 {value} 当前生命；敌人打你时同样反噬它', hook: 'thorn' },
    { name: '虚弱之雾', desc: '所有单位攻击力 {value}（最低1）', rt: '双方伤害 ×(1-{value})', hook: 'atkDown' },
    { name: '护盾崩坏', desc: '每回合失去 {value} 当前护盾（至少1点）', rt: '每 5 秒失去 {value} 当前护盾', hook: 'shieldDecay' },
    { name: '治疗抑制', desc: '所有治疗效果 {value}（治疗药水、吸血、技能）', rt: '所有治疗 ×(1-{value})', hook: 'healDown' },
    { name: '能量涌动', desc: '攻击力 {attackBonus}，每回合自伤 {selfDamage} 最大生命', rt: '双方伤害 ×(1+{attackBonus})，每 5 秒自伤 {selfDamage} 最大生命', hook: 'atkUp' },
    { name: '闪避领域', desc: '所有单位闪避率 {value}（上限50%）', rt: '双方闪避 +{value}：敌人有几率闪开你的攻击（飘字「闪开」）', hook: 'dodge' },
    { name: '暴击共振', desc: '所有单位暴击伤害 {value}', rt: '双方暴击伤害 +{value}', hook: 'critDmg' },
    { name: '连击风暴', desc: '所有单位连击率 {value}（上限40%）', rt: '你的连击加成 +{value}；敌人命中后有 {value} 概率立刻再打一下', hook: 'combo' },
    { name: '死亡回响', desc: '敌人死亡时，对玩家造成 {value} 最大生命的伤害（无视护盾）', rt: '每击杀一个敌人，失去 {value} 最大生命（无视护盾）', hook: 'deathEcho' },
    { name: '吸血诅咒', desc: '所有单位攻击时恢复 {value} 最大生命（至少1点）', rt: '双方每次命中回复 {value} 最大生命', hook: 'lifesteal' },
    { name: '缓慢凋零', desc: '每回合所有单位失去 {value} 最大生命（至少1点）', rt: '每 5 秒双方失去 {value} 最大生命（含上限）', hook: 'decay' },
    { name: '能量导管', desc: '每回合所有单位获得 {value} 最大生命的护盾（至少1点）', rt: '每 5 秒你获得 {value} 最大生命的护盾（敌人无护盾条，只结算你）', hook: 'shieldGain' },
    { name: '厄运', desc: '所有单位受到伤害 {value}', rt: '双方受到伤害 ×(1+{value})', hook: 'dmgUp' },
    { name: '幸运', desc: '所有单位暴击率 {value}', rt: '双方暴击率 +{value}', hook: 'lucky' },
    { name: '时间扭曲', desc: '每回合所有单位额外消耗 {value} 当前生命（无视护盾）', rt: '每 5 秒双方额外失去 {value} 当前生命（无视护盾）', hook: 'timeWarp' }
  ];

  /** 名字 → 实时化定义（运行时按名字查） */
  /**
   * 诅咒查表：宿主用 setCursePool 下发过就以它为**唯一**依据（可借此禁用某条），
   * 否则退回内置 10 条。
   * ⚠️ 表外的名字会被静默丢弃（不报错），所以新增诅咒前必须先下发池子（风险 R9）。
   */
  function curseByName(n) {
    var list = HOST.cursePool || RT_CURSES;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].name === n) return list[i];
    return null;
  }
  function envByName(n) { return WORLD_ENVS.filter(function (e) { return e.name === n; })[0] || null; }

  /**
   * 远程连招的招式名：先看英雄自己的名字（角色形象.RANGED[id].chains），
   * 没有就退回 RANGED_CHAIN 里的通用名 —— 弓 / 法杖 / 卷轴各叫各的，但逻辑只有一套。
   */
  function rangedChainName(rg, key, fallback) {
    var A = global.角色形象;
    var ch = (A && A.RANGED && rg && A.RANGED[rg.id] && A.RANGED[rg.id].chains) || null;
    return (ch && ch[key]) || fallback;
  }

  /**
   * 图鉴里展示经典文案时，把 {value} / {attackBonus} 这类占位符写成「<数值>」
   * 真实数值只有「当前生效」的那一条才有（要由宿主按层数与难度算），其余条目印出 {value} 只是噪音。
   */
  function envPlaceholderText(tpl) {
    return String(tpl == null ? '' : tpl).replace(/\{[A-Za-z]+\}/g, '<数值>');
  }

  /**
   * 狂怒（实时重做）
   * 文字版试炼的狂怒是「上限 10，攻击/防御/药水各 +1，满了手动爆发固定 10~14 伤害」。
   * 那套在实时里立不住：实时挥砍频率是回合制的几十倍，10 格会瞬间满；固定伤害在
   * 攻击力几十上百的实时尺度下也毫无意义。所以改成**一管进攻资源**：
   *   · 上限 100 —— 粒度够细，一根条就看得懂，节奏约等于「连续压制 3~5 秒攒满」
   *   · 攒怒靠**进攻**：命中 / 技巧命中 / 完美防御 / 击杀 / 挨打（越危险越怒）
   *     —— 举盾和走位不攒怒，所以它奖励的是"打得凶"，和体力（奖励会躲）形成一组对立
   *   · 满了按 R 进入**狂怒状态 6 秒**：攻速、伤害、移速全面拉满；代价是受到的伤害 +15%
   *     （狂暴而不设防）—— 保留原版"亲手按下爆发"的那个时刻，但把一次性伤害换成一段状态
   *   · **只手动触发**：满怒后不会自动爆发，一直存着等玩家按 R —— 什么时候用由玩家决定。
   *     （曾经有一条"满怒 12 秒没按就自动爆发"的兜底，用户要求去掉：自动触发会在玩家
   *       不想动手的时候把资源吞掉，攒怒的意义就没了。）
   */
  var FURY = {
    max: 100,
    gainHit: { normal: 2, elite: 3, mirror: 3, boss: 4 },   // 命中敌人（按层级）
    gainChain: 3,        // 连招命中额外
    gainPerfect: 6,      // 完美闪避 / 完美格挡
    gainKill: 5,         // 击杀
    gainHurt: 4,         // 挨打（逆风也能翻）
    duration: 6000,      // 狂怒状态持续(ms)
    atkSpeed: 1.35,      // 攻击间隔缩短倍率
    dmgMult: 1.5,        // 伤害倍率
    moveMult: 1.25,      // 移动速度倍率
    takenMult: 1.15      // 代价：受到的伤害 +15%
  };

  /**
   * 平台魂晶
   * 第一版给的是「金币 +2 / 护盾 +1 / 生命 +4」——数值全部落在结算里了，但护盾 +1 在
   * 「护盾条 = 护盾 ÷ 生命上限」的画法下只有 0.5%（约 1px），回血 4 点在 200 血里也看不出来，
   * 玩家体感就是「捡了没反应」。所以这一版的目标不是改机制，而是让收益**看得见**：
   *   · 护盾 +6（与「战吼」同量级，条体有约 3% 的可见跳变）
   *   · 低血时回复最大生命的 25%（至少 8 点，飘字显示实际值）
   *   · 金币 3 + 层数（宝箱的约 1/3，符合它「顺手捡」的定位）
   *   · 判定框放大，并加「近距离发亮 + 提示」——让玩家知道这东西是可以碰的
   *   · 每个房间最少有一颗长在**最低的那段平台**上，不用每次都为了一颗魂晶爬满全场
   */
  var CRYSTAL = {
    pickupX: 46,        // 拾取判定半宽（原 34：贴着边走过去会漏判）
    pickupY: 62,        // 拾取判定半高（原 44：落在平台边缘时够不到）
    nearX: 140,         // 进入这个范围：魂晶放大发亮 + 出「拾取」提示
    nearY: 170,
    healPct: 0.35,      // 低血分支：回复最大生命的 35%（v2.9 上调，配合降频）
    healMin: 12,
    lowHpAt: 0.6,       // 生命低于这个比例算「低血」→ 魂晶转急救（显性化）
    shield: 10,         // 护盾分支（原 6：降频后单颗收益上调 67%）
    points: 5,          // 金币分支 = 5 + 层数（原 3 + 层数）

    // ===== v2.9 P1：读条拾取（停留触发，键鼠与触屏零差异）=====
    stayMs: 200,        // 靠近后站住多久开始读条
    channelMs: 600,     // 读条时长
    stillSpeed: 46,     // 水平速度低于它算「站住」（不用"无输入"，摇杆回中但有惯性会误判）
    stillVy: 200,       // 竖直速度低于它（落地 / 贴地）
    enemyNear: 60,      // 敌人离玩家这么近 → 打断读条
    hurtLock: 180,      // 受击后这段时间内不能开始读条

    // ===== v2.9 P1：房间级投放（从"每段平台 62%"改成"每房 1 颗保底 + 30% 第二颗"）=====
    extraChance: 0.30,
    maxPerRoom: 2,
    blueWeight: 7,      // 三色权重：蓝 70% / 深渊 20% / 腐化 10%
    abyssWeight: 2,
    corruptWeight: 1
  };

  /* 三色魂晶：共用同一套显示对象（矩形 + 光晕），只用颜色区分 ——
     建三套纹理等于三倍显存与三次纹理切换，施工清单 §10.2 明令禁止。 */
  var CRYSTAL_KINDS = {
    blue:    { key: 'blue',    name: '魂晶',     color: 0x8ad8ff, text: '#8ad8ff' },
    abyss:   { key: 'abyss',   name: '深渊魂晶', color: 0xc79aff, text: '#c79aff' },
    corrupt: { key: 'corrupt', name: '腐化魂晶', color: 0xa8e85a, text: '#a8e85a' }
  };

  /* 加速下坠：空中按下（S / ↓ / 摇杆下推 / 防御键）→ 穿过单向平台落下一层 */
  var FASTFALL = {
    speed: 940,      // 目标下坠速度
    accel: 4200      // 加速度(px/s²)：约 0.1 秒进入高速，手感干脆
  };

  /* ============================================================
     2.9 · P2 战斗节奏（把怪从"沙包"改回"对手"）
     ------------------------------------------------------------
     病根不是"前摇太长"，是"前摇可以被无限打断且完全重置"。
     这里只做两件事（初步设想 §5.3 的改法 1 + 2）：
       · 前摇计时器不因受击重置 —— 受击只进硬直，windupUntil 继续走；
       · 前摇后 40% 霸体 —— 起手动作最后一段不可打断、不被击退。
     合起来就是一句话：**你打它，它照样打你**。
     ⚠️ 红线：前摇硬下限 200ms 不动（完美闪避窗口固定 150ms，见 §5.4）。
     简单难度 / 前 3 层保留"沙包感"，霸体与扑击都不启用。
     ============================================================ */
  var RHYTHM = {
    armorRatio: 0.40,     // 前摇后 40% 霸体
    armorMinFloor: 4,     // 前 3 层不霸体（教学区）
    pounceWindup: 300,    // 近战怪对空扑击的前摇（可闪）
    pounceSpeedX: 250,
    pounceSpeedY: 700,
    pounceTime: 900,
    pounceCd: 2600,
    pounceMinFloor: 4,
    pounceRange: 280,
    pounceRise: 70,       // 玩家必须比怪高这么多，才值得起跳扑
    stompBounce: 720,     // 踩头弹起速度
    stompDamage: 0.6,     // 踩头伤害 = 攻击力 × 0.6
    stompWindowVy: 160,   // 下坠速度达到它才算"踩"
    stompCd: 400          // 同一只怪的连续踩头间隔
  };

  /* ============================================================
     2.9 · P3：断桥的坠落惩罚
     ------------------------------------------------------------
     掉出地面 → 扣「最大生命」的百分比（按难度，上限 12%，单次不致死）
     → 传送到**缺口右侧最近**的安全段（永远向前，不往回送）。
     这条规则同时是 P4 塌陷回廊的"跳崖脱困"基础：意外时是惩罚，被困时是出路。
     ============================================================ */
  var PIT = {
    dmgPct: { easy: 0.04, normal: 0.07, hard: 0.10, hell: 0.12, custom: 0.07 },
    triggerY: 220,    // 掉到 groundY + 220 以下 → 判定坠落
    invuln: 600,      // 传送后无敌
    lock: 500         // 防连续触发的锁
  };


  /* ============================================================
     2.9 · P0 结构地基：地形骨架 + 统一房间目标
     ------------------------------------------------------------
     定位（见《2.9版本初步设想》§2 / 施工清单 §3）：
       · 骨架是**每个战斗房间的必选维度**，不是新增房间类型；
       · P0 只把「骨架选择层 + 骨架实现层」和「统一目标结构」搭出来，
         实际只实现平厅一种 —— 因此玩家感知不到任何变化，这是刻意的。
       · P3 再把双层 / 断桥加进 SKELETON.enabled 与层数权重表；
         P4 再把塌陷 / 守点 / 限时接到 ROOM_OBJECTIVE 的其它 type 上。

     skeletonMode（回退开关，施工清单 §3.1 / §3.3）：
       'skeleton' = 新骨架系统（默认）
       'legacy'   = 完全绕过骨架选择，直接走旧的平厅生成器
     两种模式共用同一份平厅布局函数，所以 P0 阶段行为逐字节等价；
     P3 之后 'legacy' 才会真正退化成"只有平厅"。
     ============================================================ */
  var SKELETON = {
    mode: 'skeleton',
    // 已启用的骨架：P0 只有平厅；P3 加入双层 / 断桥
    enabled: ['flat', 'double', 'bridge'],
    // 目标分布（第 16 层以后）。真正的分布按层数走 skeletonWeightTable()
    weights: { flat: 40, double: 35, bridge: 25 },
    names: { flat: '平厅', double: '双层', bridge: '断桥' },
    last: null,        // 调试：最近一次抽签结果
    samples: 0         // 调试：累计抽签次数
  };

  /* 统一房间目标支持的 type。P0 只实现 'clear'，其余四种先在结构里占位：
       clear   清怪归零
       arrive  抵达某点（P4 机制的出口 / 守点圈外）
       collect 收集 N 个（塌陷回廊的魂晶钥匙）
       hold    圈内累计 N 秒（守点）
       timed   N 秒内完成（限时） */
  var ROOM_OBJECTIVE_TYPES = ['clear', 'arrive', 'collect', 'hold', 'timed'];

  /* ============================================================
     2.9.2 · 新机制的独立回退开关
     ------------------------------------------------------------
     施工清单 §1.4 要求「所有结构性改动都要有可回退的开关」，§4.3 / §5.3 又要求
     单向平台 / 三色 / 读条 / 踩头各自独立 —— 原来只有骨架与机制两级开关，
     这四件出问题只能改代码。现在一行 API 就能各自退回 2.8 的手感：
       API.setToggles({ oneWay:false })  → 平台恢复四面实体（跳不上去、侧面会挂住）
       API.setToggles({ tricolor:false })→ 魂晶只出蓝色
       API.setToggles({ channel:false }) → 进拾取范围即拿，没有 0.2 + 0.6 秒读条
       API.setToggles({ stomp:false })   → 踩头不再弹跳
     默认全开。只影响之后生成的房间 / 魂晶，场上已有的不动（改一半是更糟的 bug）。
     ============================================================ */
  var TOGGLES = {
    oneWay: true, tricolor: true, channel: true, stomp: true,
    // 2.9.4：进圈才启动守点袭击。默认所有房间都过门结算；
    // 守点房是唯一例外（开门即结算、选完奖励直接开地图，门仍保留为兜底）。
    // settleAtDoor=false 可让全部房间都退回"开门即结算"。
    holdGate: true, settleAtDoor: true
  };

  /* ============================================================
     2.9 · P4：机制挂载（骨架之上的"这个房间要你干什么"）
     ------------------------------------------------------------
     与骨架正交：同一种机制可以挂在不同骨架上。
     硬规则（施工清单 §3.4）：
       · 同一房最多挂 1 种机制
       · 层主房 / 非战斗房不挂
       · 机制从第 3 层起
       · 每 5 层至少 1 次带机制的房间（第 5/10/15... 层的第 2 间强制兜底）
     回退：API.setMechanicEnabled(name, false) 可单独关掉某一种。
     ============================================================ */
  var MECHANIC = {
    minFloor: 3,
    rates: { collapse: 0.15, hold: 0.10, timed: 0.10 },
    names: { collapse: '塌陷', hold: '守点', timed: '限时' },
    /**
     * 教学三连（2.9.2 · F2）：第 3 / 4 / 5 层各固定教一种。
     * 玩家第一次见到新玩法是"被安排好的"，不是抽奖 —— 之后才进随机池。
     * 每层只教一次（本层已有机制房就不再强制）。
     */
    teach: { 3: 'collapse', 4: 'hold', 5: 'timed' },
    /**
     * 每层保底（2.9.2 · F2）：从这一层起，每层至少 1 间机制房。
     * 原来的"每 5 层保底一次"实测只有 0.74 间/层，机制房比玩家以为的稀疏得多；
     * 保底时优先选**本层还没出现过的**机制（见 pickGuaranteedMechanic）。
     */
    guaranteeFromFloor: 3,
    /**
     * 不挂机制的房间类型（2.9.1）
     *   boss          层主房要打层主，机制房会设 noEnemies 把层主挤掉
     *   start         进层缓冲房（1~3 只杂兵），挂机制等于"一进门就得处理地形"
     *   elite/mirror  这两种房的全部意义就是那一个怪；noEnemies 会让精英 / 镜像消失，
     *                 而清房后宿主仍按房型发「精英遗物」—— 没打精英却拿精英奖励
     */
    noMechanicRooms: { boss: 1, start: 1, elite: 1, mirror: 1 },
    // 回退开关（方案 §11）：关掉后该骨架不再被抽成塌陷房（回到"塌陷只能挂平厅"）
    collapseOnDouble: true,
    collapseOnBridge: true
  };

  /* ============================================================
     2.9 · P4：机制参数按难度缩放
     ------------------------------------------------------------
     普通 = 实测默认档（8 段 / 4.0s / 3 颗 / 0.8s 预警 / 3 敌人）。
     简单：需求−1、塌陷间隔与预警更长、段数与敌人更少。
     困难：段数+1、间隔与预警缩短、敌人上限+1（需求保持 3）。
     地狱：需求+1、间隔与预警再缩短、段数 10。
     守点 / 限时同样按难度缩放（"其他参数也一样"）。
     ============================================================ */
  var MECH_DIFF = {
    easy: {
      collapse: { segments: 6, interval: 5500, warn: 1000, need: 2, enemies: 2 },
      hold: { waves: 3, waveMul: 0.7, dur: 14000, hp: 80, mul: 0.85 },
      timed: { need: 36000 }
    },
    normal: {
      collapse: { segments: 8, interval: 4000, warn: 800, need: 3, enemies: 3 },
      hold: { waves: 3, waveMul: 1.0, dur: 16000, hp: 100, mul: 1.0 },
      timed: { need: 30000 }
    },
    hard: {
      collapse: { segments: 9, interval: 3400, warn: 700, need: 3, enemies: 4 },
      hold: { waves: 3, waveMul: 1.3, dur: 18000, hp: 125, mul: 1.25 },
      timed: { need: 26000 }
    },
    hell: {
      collapse: { segments: 10, interval: 2800, warn: 600, need: 4, enemies: 4 },
      hold: { waves: 3, waveMul: 1.6, dur: 20000, hp: 150, mul: 1.5 },
      timed: { need: 22000 }
    },
    custom: {
      collapse: { segments: 8, interval: 4000, warn: 800, need: 3, enemies: 3 },
      hold: { waves: 3, waveMul: 1.0, dur: 16000, hp: 100, mul: 1.0 },
      timed: { need: 30000 }
    }
  };

  /* ============================================================
     2.9.2 §3 · 守住核心的常量
     ------------------------------------------------------------
     守点从「站进圈里凑 8 秒」改成「撑过 16 秒的尸潮，按核心剩余血量发奖」。
     数值口径（反馈 §3.2–§3.3）：
       · 核心血量只随层数**线性小涨**（+2/层），单次伤害随难度与层数放大；
         两个轴一起涨，否则高层的厚血核心反而比低层更耐打（难度倒挂）。
       · 同一核心 0.3s 内只结算 1 次 —— 一帧多段会让"护罩"和"清怪"都失去意义。
       · 普通 10 层 DPS ≈ 26 → 持续挨打 4.4~4.6s 碎；加上走到位 3~5s，
         挂机的人在第 8~10 秒就看着核心碎，等不到 16 秒结束。
     ============================================================ */
  var CORE = {
    meleeRange: 56,          // 近战怪进这个距离就开始前摇
    rangedMin: 260, rangedMax: 340,
    hitCd: 300,              // 0.3s 结算间隔（防一帧多段）
    dmgNormal: 6, dmgElite: 9, dmgShooter: 4,
    shieldMul: 0.5,          // 玩家在圈内 → 核心受伤减半
    shrinkAt: 0.6,           // 袭击进度 60% 起护罩收缩
    shrinkMul: 0.8,
    waveWarn: 800,           // 每波前 0.8s 预警（圈边闪 3 下 + 两侧裂纹）
    queueCd: 350,            // 排队补怪：0.35s 一只（"涌进来"而不是"一次刷满"）
    spawnMin: 260, spawnMax: 520,
    waveAt: [0, 0.25, 0.5],  // 袭击进度 0% / 25% / 50% 各一波
    flyerFromFloor: 6,
    idleCheck: 3000,         // 挂机判定窗口
    idlePct: 0.01,           // 每次扣 1% 最大生命（不致死，最低留 1）
    reward: { perfect: 1.5, normal: 1.0, narrow: 0.6 },
    // 2.9.4 H4：普通基准第 3 层 5 只 → 第 15 层 15 只，难度只改乘数
    waveCurve: { lo: 5, hi: 15, floorLo: 3, floorHi: 15 }
  };

  /* ============================================================
     2.9.1 · 图鉴「地形与机制」：一份数据，两处使用
     ------------------------------------------------------------
     · 画布内图鉴：codexEntries('terrain') → 左侧列表 + 右侧字段行
     · DOM 图鉴：API.getCodexData().entries → 主程序「地形与机制」分类
     数字一律从常量现算，改 MECH_DIFF / CRYSTAL / SKELETON 时图鉴会跟着变。
     rows 是 [标签, 值]；行数控制在 4 行以内 —— 详情区放不下时会丢掉后面的行。
     ============================================================ */
  function codexTerrainEntries() {
    var cE = MECH_DIFF.easy, cN = MECH_DIFF.normal, cH = MECH_DIFF.hard, cX = MECH_DIFF.hell;
    var pit = Math.round(PIT.dmgPct.normal * 100);
    var sec = function (ms) { return (ms / 1000) + 's'; };
    return [
      {
        title: '地形骨架：平厅 / 双层 / 断桥',
        rows: [
          ['平厅', '一整条地面 + 2~3 个单向平台；平台能从下方跳上去，也能靠踩头弹跳借力。'],
          ['双层', '实体上层 + 1~2 个连通口，上层常驻远程怪；视口太矮放不下时自动退回平厅。'],
          ['断桥', '地面断 1~2 处，掉下去扣最大生命 ' + pit + '%（普通），传送到缺口右侧最近的安全地面，不往回送。'],
          ['抽签', '第 1 层固定平厅；第 16 层以后平厅 ' + SKELETON.weights.flat + ' / 双层 ' + SKELETON.weights.double + ' / 断桥 ' + SKELETON.weights.bridge + '。层主房 / 非战斗房 / 起点房固定平厅。']
        ],
        note: '骨架是每个战斗房的必选维度，和机制是两件事：先看脚下长什么样，再看这间房要你干什么。'
      },
      {
        title: '塌陷',
        rows: [
          ['玩法', '出口锁着，收满 ' + cN.collapse.need + ' 颗魂晶解封；地面每 ' + sec(cN.collapse.interval) + ' 塌一段（简单 ' + sec(cE.collapse.interval) + ' / 地狱 ' + sec(cX.collapse.interval) + '）。'],
          ['钥匙', '地面钥匙要停下来读条，浮空钥匙跳跃触碰即收；地面塌掉时还没拿的钥匙会被抛到前方安全段。'],
          ['兜底', '最后一段开始预警就强制解锁（没有速度奖励）；掉进深渊扣最大生命 ' + pit + '%，传送到前沿 + 1。'],
          ['难度', '段数 ' + cE.collapse.segments + '/' + cN.collapse.segments + '/' + cH.collapse.segments + '/' + cX.collapse.segments + '，需求 ' + cE.collapse.need + '/' + cN.collapse.need + '/' + cH.collapse.need + '/' + cX.collapse.need + ' 颗（简单 / 普通 / 困难 / 地狱）。']
        ],
        note: '没有浮台 —— 任何能站着等地面塌完的地方都会让这个机制失效。样板房与调参页里它叫「塌陷回廊」，正式局叫「塌陷」。'
      },
      {
        title: '守点 · 守住核心',
        rows: [
          ['玩法', '圈心立着一颗核心。撑到袭击结束（简单 ' + sec(cE.hold.dur) + ' / 普通 ' + sec(cN.hold.dur) + ' / 地狱 ' + sec(cX.hold.dur) + '）即算守住，按核心剩余血量发奖 —— 不看你在圈里站了多久。'],
          ['核心', '不还手、不移动、不能被打；不会自己掉血，只有被打中才掉，同一核心 0.3s 内只结算一次。怪默认打核心，被玩家打中后 ' + (1.5) + 's 内才转火。'],
          ['护罩', '站在圈内 → 核心受伤减半。袭击后半段（' + Math.round(CORE.shrinkAt * 100) + '% 起）护罩收缩 ' + Math.round((1 - CORE.shrinkMul) * 100) + '%，后期得贴着核心打。'],
          ['奖励', '核心 ≥80% 完美（金币 ×' + CORE.reward.perfect + ' + 1 颗深渊魂晶）/ ≥50% 守住（×' + CORE.reward.normal + '，30% 魂晶）/ 1–49% 惨胜（×' + CORE.reward.narrow + '）/ 碎裂：无奖励但门照开。']
        ],
        note: '失守只会少拿奖励，不会卡关。挂机也不算：' + sec(CORE.idleCheck) + ' 内没有任何输入就扣 ' + Math.round(CORE.idlePct * 100) + '% 最大生命（不致死）。'
      },
      {
        title: '限时',
        rows: [
          ['玩法', '在 ' + sec(cN.timed.need) + ' 内清空房间（简单 ' + sec(cE.timed.need) + ' / 地狱 ' + sec(cX.timed.need) + '）。'],
          ['超时', '敌人强化，但仍可清空通关，不会死锁。'],
          ['奖励', '剩余秒数 × 3 + 击杀 × 2；超时完成没有速度奖励。']
        ],
        note: ''
      },
      {
        title: '三色魂晶',
        rows: [
          ['蓝', '金币 ' + CRYSTAL.points + ' + 层数，或护盾 ' + CRYSTAL.shield + '。'],
          ['深渊', '大量金币 + 强效护盾，代价是本房间敌人强化。'],
          ['腐化', '1 件遗物 + 1 条诅咒。'],
          ['读条', '靠近后站住 ' + sec(CRYSTAL.stayMs) + ' 开始、' + sec(CRYSTAL.channelMs) + ' 读完；移动 / 受击 / 怪贴近会打断，快速跑过不触发。']
        ],
        note: ''
      },
      {
        title: '低血急救',
        rows: [
          ['触发', '生命低于 ' + Math.round(CRYSTAL.lowHpAt * 100) + '% 时，蓝色魂晶核心与光晕转绿、提示改成「救命」。'],
          ['效果', '拾取必定回复 ' + Math.round(CRYSTAL.healPct * 100) + '% 最大生命（至少 ' + CRYSTAL.healMin + ' 点）。'],
          ['本色', '深渊 / 腐化魂晶保留本色，只多一圈绿色急救环。']
        ],
        note: ''
      },
      {
        title: '单向平台与加速下坠',
        rows: [
          ['平台', '只能从上方踩住，从下往上可以直接穿过。'],
          ['加速下坠', '空中按下（S / ↓ / 摇杆下推 / 盾键）→ 高速下坠并穿过单向平台。'],
          ['地面按下', '仍然是防御 —— 两者不冲突：空中下坠、地面举盾。']
        ],
        note: ''
      },
      {
        title: '踩头弹跳',
        rows: [
          ['触发', '从上方落到敌人头顶（下坠速度够快才算踩），自己弹起。'],
          ['收益', '重置空中攻击：跳劈 / 挥砍可以立刻再接。'],
          ['代价', '踩头不是无敌 —— 近战怪第 4 层起会对滞空的你起跳扑击。']
        ],
        note: ''
      },
      {
        title: '怪物节奏',
        rows: [
          ['前摇', '计时不因受击重置：你打它，它照样打你。'],
          ['霸体', '第 4 层起普通 / 困难 / 地狱的前摇后 ' + Math.round(RHYTHM.armorRatio * 100) + '% 不可打断、不被击退（简单与前 3 层保留沙包感）。'],
          ['扑击', '近战怪在你滞空时会起跳扑击（前摇 ' + RHYTHM.pounceWindup + 'ms，可闪）；charger 冲锋的纵向判定加高。']
        ],
        note: ''
      }
    ];
  }

  /** 骷髅骑兵：近战为主，中远距离有概率改掷长矛（长矛带抛物线，看得见、闪得掉） */
  var MOB_THROW = {
    cd: 1400,         // 每隔这么久掷一次「要不要掷矛」的判定（不是每帧都掷，否则等于必掷）
    chance: 0.35,     // 每次判定的掷矛概率
    minDist: 96,      // 比这更近就老实近战（贴脸掷矛不合理）
    maxDist: 380,     // 超出这个距离它还没进入攻击距离，自然不会起手
    speed: 470,       // 出手速度
    gravity: 340,     // 抛物线重力（比玩家重力轻，飞得更平）
    mult: 1.1,        // 伤害倍率
    stick: 900        // 落地插在地上到消失(ms)
  };

  var state = {
    game: null,
    scene: null,
    container: null,
    available: false,
    enabled: true,
    booted: false,
    settings: null,
    quality: 'medium',
    renderMode: null,        // 'webgl' | 'canvas'（实际落地的渲染器）
    compatMode: false,       // 是否退到了「极简渲染配置」（画质糙一点，玩法不变）
    contextLost: false,      // WebGL 上下文是否正被系统回收（iOS 切后台常见）
    lastInitError: null,     // 初始化失败原因（供宿主显示在界面上）
    _webglProbe: undefined,  // WebGL 探测结果缓存（undefined = 尚未探测）
    _gestureGuard: false,    // 手势守卫是否已安装
    _visibilityBound: false, // 前台唤醒是否已绑定
    actionHandler: null,
    bridge: {},
    pendingStart: null
  };

  // ============================================================
  //  设置（存档集成）
  // ============================================================
  function defaultSettings() {
    // hudDensity 必须在这里有默认值：loadSettings 只从 defaultSettings 的**键**
    // 上回填（见下面的 for-in），缺键的项无论存了多少次都读不回来 ——
    // 第一版漏了它，结果设置里切「极简」存进了 localStorage，
    // 引擎侧却永远解析成 undefined，画面上什么都不会变。
    return { enabled: true, quality: 'auto', particles: true, screenShake2D: true, floatText: true, hudDensity: 'auto' };
  }

  function loadSettings() {
    var s = defaultSettings();
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        for (var k in s) if (p[k] !== undefined) s[k] = p[k];
      }
    } catch (e) { /* 忽略 */ }
    state.settings = s;
    state.enabled = s.enabled !== false;
    return s;
  }

  function saveSettings(patch) {
    var s = state.settings || loadSettings();
    if (patch) for (var k in patch) if (patch[k] !== undefined) s[k] = patch[k];
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
    state.enabled = s.enabled !== false;
    return s;
  }

  // ============================================================
  //  画质档位（设备自适应）
  // ============================================================
  var QUALITY = {
    high:   { stars: 130, particles: true, count: 14 },
    medium: { stars: 85,  particles: true, count: 9 },
    low:    { stars: 40,  particles: false, count: 0 }
  };

  /**
   * 触摸设备（手机 / 平板）
   * 用于画质上限与触摸说明文案；比 UA 嗅探可靠，且不会误判桌面触摸屏。
   */
  function isTouchDevice() {
    try {
      return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    } catch (e) { return false; }
  }

  /**
   * WebGL 可用性主动探测
   * ------------------------------------------------------------
   * 注意：探测结果**只用来决定画质档位**，不再用来否决 WebGL 渲染器。
   * 原因是这个探测本身在苹果设备上很不可靠：它建的是 1×1 的小 context，
   * 省电模式 / 硬件加速被关 / context 名额紧张时它能过，真建 960×540 的游戏
   * context 时才翻脸；反过来，探测失败也不代表极简配置建不出来。
   * 所以渲染器选择改由 init 里的四段式尝试负责，这里只回答「大概有多强」。
   *
   * 探测用的 context 必须立刻释放 —— 移动端 WebGL context 名额有限（通常 8~16 个），
   * 泄露一个就可能让真正的游戏 context 创建失败。
   */
  function probeWebGL(force) {
    if (!force && state._webglProbe !== undefined) return state._webglProbe;
    state._webglProbe = (function () {
      var gl = null;
      try {
        var c = document.createElement('canvas');
        c.width = 1; c.height = 1;
        var opts = { failIfMajorPerformanceCaveat: false, antialias: false, depth: true, stencil: false };
        gl = c.getContext('webgl', opts) || c.getContext('experimental-webgl', opts);
        if (!gl) return false;
        // 能拿到 context 不代表真能用：部分设备 context 建得出来、着色器却编译失败
        var sh = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(sh, 'precision mediump float;\nvoid main(){gl_Position=vec4(0.0,0.0,0.0,1.0);}');
        gl.compileShader(sh);
        var ok = !!gl.getShaderParameter(sh, gl.COMPILE_STATUS);
        gl.deleteShader(sh);
        return ok;
      } catch (e) {
        return false;
      } finally {
        try {
          if (gl) {
            var lose = gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
          }
        } catch (e2) { /* 忽略 */ }
      }
    })();
    return state._webglProbe;
  }

  function detectQuality() {
    var s = state.settings || loadSettings();
    if (s.quality && s.quality !== 'auto') return s.quality;
    try {
      var cores = navigator.hardwareConcurrency || 4;
      if (cores <= 2) return 'low';
      // 低内存设备（低端安卓机常见）直接压到最低档
      if (navigator.deviceMemory && navigator.deviceMemory <= 2) return 'low';
      // WebGL 不可用 → Phaser 走 Canvas 渲染器，那是纯 CPU 光栅化，
      // 手机端必须压到最低档，否则每一帧都在掉。
      if (!probeWebGL()) return 'low';
      // 触摸设备默认封顶中档：高画质那套星尘 + 粒子在手机上掉帧明显，
      // 而「能不能玩」比「好不好看」重要。
      if (isTouchDevice()) return 'medium';
      return cores <= 4 ? 'medium' : 'high';
    } catch (e) { return 'medium'; }
  }

  function qp() { return QUALITY[state.quality] || QUALITY.medium; }

  // ============================================================
  //  工具
  // ============================================================
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function ri(a, b) { return Math.floor(rnd(a, b + 1)); }
  /**
   * 中文文本的换行配置
   * ------------------------------------------------------------
   * Phaser 默认的 wordWrap 是「按空格断行」的 basicWrap —— 而中文句子没有空格，
   * 于是整段文字**根本不会换行**：它无视宽度限制一路横穿出去，压在旁边的元素上。
   * 图鉴里「文字叠在一起」的主因就是这个，而不是坐标算错。
   * 凡是中文正文都必须带上 useAdvancedWrap（按字符断行）。
   */
  function wrapCN(width) { return { width: width, useAdvancedWrap: true }; }
  function fmt(n) { return Math.round(n) + ''; }
  /** 0xRRGGBB → '#rrggbb'（飘字要字符串，颜色却来自角色形象表里的数值） */
  function hexOf(c) { return '#' + ('000000' + ((c | 0) >>> 0).toString(16)).slice(-6); }
  // 命中判定的复用矩形（每帧都要比，别每次 new）
  var _rectA = new Phaser.Geom.Rectangle(0, 0, 0, 0);
  var _rectB = new Phaser.Geom.Rectangle(0, 0, 0, 0);

  /** 毫秒 → 「M 分 S 秒」 */
  function fmtTime(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(s / 60);
    return m > 0 ? (m + ' 分 ' + (s % 60) + ' 秒') : (s + ' 秒');
  }

  // ============================================================
  //  音频（接入 AbyssAudio 程序化合成，无外部音频资源）
  // ============================================================
  function sfx(name) {
    var a = global.AbyssAudio;
    if (!a || typeof a.sfx !== 'function') return;
    try { a.sfx(name); } catch (e) { /* 音频失败不影响游戏 */ }
  }

  function setBgmScene(scene) {
    var a = global.AbyssAudio;
    if (!a || typeof a.setScene !== 'function') return;
    try { a.setScene(scene); } catch (e) { /* 忽略 */ }
  }

  // ============================================================
  //  宿主桥接（持有内核状态的宿主，如 经典2D.js）：商店数据 / 决策内容 / 退出本局
  //  ------------------------------------------------------------
  //  2D 层只负责画面与交互，楼层规划、解锁、退出流程仍由宿主处理，
  //  桥接缺失时（例如单独打开 2D 层）自动降级为画面内提示。
  // ============================================================
  function hasBridge(name) {
    return !!(state.bridge && typeof state.bridge[name] === 'function');
  }

  function callBridge(name, a, b) {
    if (!hasBridge(name)) return null;
    try { return state.bridge[name](a, b); } catch (e) {
      console.warn('[战斗2D] 桥接调用失败：' + name, e);
      return null;
    }
  }

  /** 房间类型 → BGM 场景（战斗/精英/镜像/Boss/宝箱/祭坛各用不同氛围） */
  function bgmForRoom(type) {
    if (type === 'boss') return 'boss';
    if (type === 'elite') return 'elite';
    if (type === 'mirror') return 'mirror';
    if (type === 'treasure') return 'explore';
    if (type === 'shrine') return 'rest';
    if (type === 'shop' || type === 'rest') return 'rest';
    if (type === 'event') return 'explore';
    return 'battle';
  }

  /**
   * 非战斗房间：没有敌人，清空条件 = 完成房间目标
   * 宝箱 / 祭坛是原本就有的；商店 / 休整点 / 随机事件是本次接入经典模式时新增的三种。
   */
  function nonCombatRoom(type) {
    return type === 'treasure' || type === 'shrine' ||
      type === 'shop' || type === 'rest' || type === 'event';
  }

  /**
   * 平厅骨架：**纯布局计算**，不创建任何显示对象 / 物理体
   * ------------------------------------------------------------
   * 从原 spawnPlatforms 里原样抽出来的，算法一个字没改：
   *   · 平台数量 = 4 + min(5, floor/2)，非战斗房固定 2 段
   *   · 高度带 = [max(groundY-350, H*0.14), groundY-110]
   *   · 槽位内随机 → 冲突（GAP_X / GAP_Y）就重掷 → 放不下就少一段
   * 抽出来的目的（P0 §3.1）：骨架选择层和骨架实现层解耦，
   * 并且让「分布统计」能脱离 Phaser 直接跑（测试/P0结构地基验证.html）。
   *
   * @param {object} p { floor, nonCombat, viewW, viewH, levelWidth, groundY }
   * @returns {{count:number, topY:number, lowY:number, minLen:number, maxLen:number,
   *            platforms:Array<{x0:number,x1:number,y:number,len:number}>}}
   */
  function flatSkeletonLayout(p) {
    var nonCombat = !!p.nonCombat;
    var count = (p.countOverride != null) ? p.countOverride
      : (nonCombat ? 2 : (4 + Math.min(5, Math.floor(p.floor / 2))));
    var H = p.viewH;
    // 平台高度限制在满蓄力跳跃可及范围内（离地约 100~350px）
    // 上限为什么是 H*0.14 而不是 H*0.3：手机横屏 H 只有 360，groundY - 350 早就在屏幕
    // 外面了，真正的上限由 H 决定 —— 写死像素会在最小视口下把平台顶进 HUD。
    var topY = Math.max(p.groundY - 350, H * 0.14);
    var lowY = p.groundY - 110;
    if (lowY < topY + 30) lowY = topY + 30;   // 极矮视口的兜底，别让 rnd(topY, lowY) 反向

    var xMin = p.viewW * 0.35;
    var xMax = Math.max(p.viewW * 0.5, p.levelWidth - 260);
    var span = Math.max(120, xMax - xMin);
    var perSlot = span / Math.max(1, count);
    // 平台长度跟着可用空间伸缩：手机横屏水平方向也紧张，
    // 固定 3~6 格时 4 段平均宽度已经超过整段跨度，一样会互相压上来。
    var usable = Math.floor((perSlot - 20) / 64);
    var maxLen = Math.max(2, Math.min(6, usable));
    var minLen = Math.max(2, Math.min(maxLen, 3));

    // 摆放规则：两段平台只要「水平投影挨着」，高度就必须拉开 GAP_Y，
    // 否则玩家看到的是一个台阶、实际是两层碰撞体，踩上去的位置全靠运气。
    // GAP_Y 必须大于「敌人身高 + 平台厚度」：怪物高约 48、平台体厚 20，净空要够 48，
    // 所以中心间距至少要 68 —— 不然会有一只怪卡在两层平台之间，打不到也出不来。
    var GAP_X = 56;
    var GAP_Y = 68;
    var placed = [];

    for (var i = 0; i < count; i++) {
      var spot = null;
      for (var tries = 0; tries < 48 && !spot; tries++) {
        var len = ri(minLen, maxLen);
        var w = len * 64;
        var y = rnd(topY, lowY);
        var left;
        if (tries < 28) {
          // 前大半数尝试限制在自己的槽位里：先保证水平方向自然散开，
          // 而不是等到冲突了再满地图乱找
          var slotStart = xMin + perSlot * i;
          var slotEnd = Math.max(slotStart, slotStart + perSlot - w);
          left = rnd(slotStart, slotEnd);
        } else {
          // 槽里实在放不下（前一段太长，或者槽太窄）才放开全局
          left = rnd(xMin, Math.max(xMin, xMax - w));
        }
        var hit = false;
        for (var k = 0; k < placed.length; k++) {
          var q = placed[k];
          if (left < q.x1 + GAP_X && q.x0 < left + w + GAP_X &&
              Math.abs(y - q.y) < GAP_Y) { hit = true; break; }
        }
        if (!hit) spot = { x0: left, x1: left + w, y: y, len: len };
      }
      // 挤不下就少放一段 —— 叠成一坨比少一段难看得多，跳上去的判定也说不清
      if (!spot) continue;
      placed.push(spot);
    }

    return { count: count, topY: topY, lowY: lowY, minLen: minLen, maxLen: maxLen, platforms: placed };
  }

  // ============================================================
  //  纹理键
  // ============================================================
  var TEX = {
    hero: 'rt_hero', enemy: 'rt_enemy', boss: 'rt_boss',
    ground: 'rt_ground', platform: 'rt_platform',
    // 2.9.1 F1：两种"平台"必须长得不一样 —— 单向浮台可穿、双层上层实体。
    // TEX.platform 只留作**碰撞体占位**（不可见，64×20），视觉改由下面两张承担。
    platThin: 'rt_plat_thin', platDeck: 'rt_plat_deck',
    // 2.9.2 §3 守住核心
    coreOk: 'rt_core_ok', coreHurt: 'rt_core_hurt',
    coreCrit: 'rt_core_crit', coreBroken: 'rt_core_broken',
    coreBar: 'rt_corebar',
    shieldCalm: 'rt_shield_calm', shieldTight: 'rt_shield_tight', shieldHit: 'rt_shield_hit',
    warnRing: 'rt_warn_ring', warnCrackL: 'rt_warn_crack_l', warnCrackR: 'rt_warn_crack_r',
    // 2.9.4 B1：限时房入口蜡烛（燃烧 / 将尽 / 熄灭）
    candleFull: 'rt_candle_full', candleLow: 'rt_candle_low', candleOut: 'rt_candle_out',
    // 2.9.2 §4 断桥
    gapL: 'rt_gap_l', gapR: 'rt_gap_r',
    abyss: 'rt_abyss', fog: 'rt_fog', pier: 'rt_pier', landCrack: 'rt_land_crack',
    plankOk: 'rt_plank_ok', plankLoose: 'rt_plank_loose', plankFalling: 'rt_plank_falling',
    rockfall: 'rt_rockfall',
    slash: 'rt_slash', spark: 'rt_spark', projectile: 'rt_proj', portal: 'rt_portal'
  };

  var HERO_FRAMES = { idle: [0, 1], run: [2, 3, 4, 5], jump: [6], fall: [7], attack: [8, 9, 10], hurt: [11], dead: [12], roll: [13], guard: [14] };
  var ENEMY_FRAMES = { walk: [0, 1], attack: [2, 3], hurt: [4], dead: [5, 6] };

  function registerFrames(scene, key, count) {
    var t = scene.textures.get(key);
    if (!t) return;
    for (var i = 0; i < count; i++) {
      if (!t.has(i)) t.add(i, 0, i * CELL, 0, CELL, CELL);
    }
  }

  /**
   * 引导兜底：Phaser 在「内置纹理已被解码缓存」的情况下，会在场景管理器注册
   * READY 回调之前就发出 READY（热刷新/二次进入时可能出现），结果是场景永远
   * 没进入队列 —— 表现为全屏黑屏、试炼打不开。这里检测并手动补齐队列。
   */
  function ensureSceneBooted(game, SceneClass) {
    if (!game || !game.scene) return false;
    var sm = game.scene;
    if (sm.scenes && sm.scenes.length > 0) return false;   // 已正常引导
    if (game.isRunning !== true) return false;              // 引擎自身尚未引导完，等下一轮
    try {
      sm.isBooted = false;
      sm._pending = [{ key: 'default', scene: SceneClass, autoStart: true, data: {} }];
      sm.bootQueue();
      console.log('[战斗2D] 检测到场景队列未启动，已手动补齐引导（Phaser 时序兜底）');
      return true;
    } catch (e) {
      console.warn('[战斗2D] 场景引导兜底失败：', e);
      return false;
    }
  }

  /** 安排若干次引导检查：热刷新时 Phaser 可能在纹理就绪后才发出 READY */
  function scheduleBootGuard() {
    [0, 200, 800, 2000].forEach(function (ms) {
      setTimeout(function () { ensureSceneBooted(state.game, BattleScene); }, ms);
    });
  }

  /**
   * 画布尺寸校正
   * 2D 舞台被隐藏（display:none）期间父容器尺寸为 0，Phaser 的 RESIZE 模式会把
   * 画布压成 0×0，再次显示时若不校正，所有界面坐标都会算错。
   */
  function fixCanvasSize() {
    var game = state.game, host = state.container;
    if (!game || !game.scale || !host) return;
    try {
      var vv = global.visualViewport;
      // iOS 上 window.innerHeight 是「含地址栏」的高度，visualViewport 才是真实可视区
      var availH = Math.round((vv && vv.height) || global.innerHeight || 0);
      var w = Math.max(1, host.clientWidth || global.innerWidth || 1);
      var h = Math.max(1, host.clientHeight || availH || 1);
      // 容器比可视区还高时按可视区收一收：否则底部那排触摸按钮正好落在地址栏
      // 底下，看得见却点不到（iOS 横屏时地址栏尤其占地方）
      if (availH > 0 && h > availH + 1) h = availH;
      var need = game.scale.width < 2 || game.scale.height < 2 ||
        Math.abs(game.scale.width - w) > 2 || Math.abs(game.scale.height - h) > 2;
      if (!need) return;
      game.scale.resize(w, h);
      if (state.scene && state.scene.ready) state.scene.onResize({ width: w, height: h });
    } catch (e) { /* 尺寸校正失败不影响战斗 */ }
  }

  // ============================================================
  //  高密度屏（DPR）适配
  // ============================================================
  /* ============================================================
     现象：手机上整个战斗画面发糊、文字边缘不锐利，PC 上正常。

     根因：Phaser 3 的 ScaleManager 是按 **CSS 像素** 写 canvas.width/height 的
     （整个 vendor/phaser.min.js 里 devicePixelRatio 只被存进 Device 模块，没人读它；
      Phaser 3 也**没有** Phaser 2 那个 resolution 配置项）。
     于是 DPR=2/3 的手机上，画布只有 CSS 像素那么多物理像素，浏览器必须把整块位图
     放大 2~3 倍去铺满屏幕 —— 每个画出来的像素被摊成 2~3 个物理像素，这就是"糊"。

     ⚠️ 不能走"把坐标全改成物理像素"那条路（试过，真机上一片错位）：
        项目里几十处布局常量（24 / 12 / RELIC_ROW_CY / 各字号…）都是**逻辑语义**的，
        坐标系一变，它们全都要乘密度；漏一处就是错位，而且相机跟随 / 死区 / 边界 /
        命中矩形还要各自再乘一遍，永远对不齐。

     ✅ 本文件的接法：**只动渲染，不动坐标**。
        · canvas.width/height = 逻辑尺寸 × 密度        → 真像素，浏览器不再放大
        · renderer 尺寸 / GL 视口 / 裁剪矩形 = 画布物理尺寸
        · 投影矩阵仍按**逻辑尺寸**建立                → 世界 (0..W, 0..H) 正好铺满画布
        于是所有游戏代码（世界坐标 / HUD 坐标 / 相机 / 指针 / 命中矩形）继续用
        逻辑像素，一行都不用改；文字与矢量图形则真按物理像素栅格化，边缘变锐利。

     为什么这三者可以不一致（这是关键，也是上一条路走歪的地方）：
     Phaser 的投影矩阵是**全局一份**（WebGLRenderer.setProjectionMatrix），
     相机只贡献「变换矩阵 + 裁剪矩形」两项 —— 所以视口可以比投影的世界范围大，
     那正好等价于"按密度放大"。

     DPR=1 时三个尺寸完全相等，本模块等于什么都没做（PC 上零行为差异）。
     已在 测试/dpi解耦验证台.html 用 readPixels 逐像素验证过（DPR=1/2/3 与非线性档）。
     ============================================================ */

  var MAX_CANVAS_PIXELS = 16777216;   // ① 4096×4096：iOS 单张画布超过会白屏
  var BUDGET_PIXELS = 4000000;        // ② 每帧填充预算（约 2560×1560）
  // ⚠️ BUDGET_PIXELS 是"清晰 ↔ 帧率"的**唯一旋钮**：调大更清楚但更吃填充率。
  //    小屏高分（例如 800×360 逻辑 @3 倍 = 259 万像素）根本不触发限流，
  //    大屏高密度（1920×990 @2 倍 = 760 万）才会退到 1.5 / 1.25。

  /** 设备**标称**密度（1~3）。只用于诊断与限流输入，不要拿它去乘坐标 */
  function realDeviceDpr() {
    var d = 1;
    try {
      if (typeof global.devicePixelRatio === 'number' && global.devicePixelRatio > 0) {
        d = global.devicePixelRatio;
      }
    } catch (e) { /* 忽略 */ }
    return Math.max(1, Math.min(3, d));
  }

  /**
   * 这一档该用多大密度（物理像素 = 逻辑像素 × 本函数值）
   * 超预算就按 0.25 一档往下降：宁可稍糊也不卡 —— 低配机上"清晰"不能拿帧率换。
   */
  function densityFor(lw, lh, isGL) {
    // Canvas 渲染器是纯 CPU 光栅化，没有投影可放大（放大只会让画面变小），
    // 因此这类设备保持 1 = 与旧版本完全一致。
    if (!isGL) return 1;
    if (!(lw > 0 && lh > 0)) return 1;
    var d = realDeviceDpr();
    var cap = Math.min(MAX_CANVAS_PIXELS, BUDGET_PIXELS);
    // 不超预算就**原样**用设备密度（2.625 这种非整数也照用）：
    // 只有画布像素与设备像素严格 1:1，才不会再多一层重采样。
    if (lw * d * lh * d <= cap) return d;
    // 超预算才按 0.25 一档降（此时本来就不是 1:1 了，取整齐值便于诊断）
    while (d > 1 && lw * d * lh * d > cap) d -= 0.25;
    if (d < 1) d = 1;
    return Math.round(d * 4) / 4;     // 量化到 0.25，避免出现 1.13 这种怪值
  }

  /** 建引擎之前先把这一档密度算出来（场景 create 里生成纹理要用它） */
  function preseedDensity(container, isGL) {
    try {
      var lw = container ? Math.round(container.clientWidth || 0) : 0;
      var lh = container ? Math.round(container.clientHeight || 0) : 0;
      state._dprCanvas = densityFor(lw, lh, isGL);
    } catch (e) {
      state._dprCanvas = 1;
    }
    return state._dprCanvas;
  }

  /** 全项目唯一的密度口径（未算出之前一律 1 = 老行为）。纹理与文字分辨率只认它 */
  function deviceDpr() {
    var d = state._dprCanvas;
    return (d > 0) ? d : 1;
  }

  /** 实际渲染密度 = 画布像素 / 逻辑尺寸（诊断用，永远反映真相） */
  function renderDpr() {
    var g = state.game, sc = g && g.scale, c = g && g.canvas;
    if (!sc || !c || !(sc.width > 0)) return deviceDpr();
    return Math.max(1, c.width / sc.width);
  }

  /**
   * 装接法：把上面三件事挂到 Phaser 上
   * ------------------------------------------------------------
   * 只改三个"输出口"，不改任何一处游戏逻辑：
   *   ① ScaleManager.updateScale   —— 唯一决定 canvas.width/height 的地方
   *   ② renderer.resize            —— 决定 GL 视口 / 裁剪矩形 / 清屏范围
   *   ③ renderer.preRenderCamera   —— 决定每台相机绘制时被裁到哪里
   */
  function installDensity(game) {
    if (!game || !game.scale || state._densityInstalled) return false;
    state._densityInstalled = true;
    var sc = game.scale, r = game.renderer;

    // ① 画布后备像素 = 逻辑尺寸 × 密度。
    //    gameSize / baseSize / displaySize 仍写**逻辑**尺寸（与原生 RESIZE 完全一致）：
    //    相机尺寸、指针换算、displayScale 全靠它们，一动就全盘错位。
    sc.updateScale = function () {
      var lw = Math.max(1, Math.round(this.parentSize.width));
      var lh = Math.max(1, Math.round(this.parentSize.height));
      var gl = !!(game.renderer && game.renderer.gl);
      var d = densityFor(lw, lh, gl);
      if (d !== state._dprCanvas) {
        state._dprCanvas = d;
        state._dprDirty = true;      // 纹理/字号是"按密度生成一次"的，需要重建
      }
      this.displaySize.setSize(lw, lh);
      this.gameSize.setSize(lw, lh);
      this.baseSize.setSize(lw, lh);
      this.canvas.width = Math.round(lw * d);
      this.canvas.height = Math.round(lh * d);
      // 渲染器必须与画布同步：Phaser 只在 baseSize 变化时才调 renderer.resize，
      // 而"画布像素变大、逻辑尺寸不变"（正是本改动的形态）不会触发它 ——
      // 不同步的话 GL 视口会停在上一个尺寸，画面只画进左下角一块。
      var gm = state.game;
      if (gm && gm.renderer && typeof gm.renderer.resize === 'function' &&
          (gm.renderer.width !== this.canvas.width || gm.renderer.height !== this.canvas.height)) {
        try { gm.renderer.resize(lw, lh); } catch (e) { /* 忽略 */ }
      }
    };

    if (r && typeof r.setProjectionMatrix === 'function') {
      // ② 渲染器尺寸 = 画布物理像素（视口 / 裁剪 / 清屏 / 遮罩全部自洽），
      //    投影矩阵 = 逻辑尺寸（坐标照旧按逻辑铺满整张画布）。
      var origResize = r.resize.bind(r);
      r.resize = function (w, h) {
        var pw = Math.round(this.canvas.width || 0);
        var ph = Math.round(this.canvas.height || 0);
        origResize(pw > 0 ? pw : w, ph > 0 ? ph : h);
        this.setProjectionMatrix(w, h);
      };

      // ③ 相机裁剪矩形 = 整张画布物理像素。
      //    ⚠️ 相机自己的 width/height 必须保持**逻辑**口径（跟随 / 死区 / 边界 /
      //    worldView 全按它算），所以这里只是"临时换成物理裁剪、画完换回来"。
      //    不这么做的话，裁剪框只有逻辑尺寸那么大 —— 画面只画出左下角一块。
      var origPRC = r.preRenderCamera.bind(r);
      r.preRenderCamera = function (cam) {
        var sw = cam.width, sh = cam.height, sx = cam.x, sy = cam.y;
        cam.x = 0; cam.y = 0;
        cam.width = Math.round(this.canvas.width) || sw;
        cam.height = Math.round(this.canvas.height) || sh;
        origPRC(cam);
        cam.width = sw; cam.height = sh; cam.x = sx; cam.y = sy;
      };
    }
    return true;
  }

  /**
   * 文字按密度重新栅格化
   * ------------------------------------------------------------
   * Phaser 的 Text 是**预渲染纹理**：字号 14px 就栅格化一张 14px 高的图，
   * 投影放大 3 倍 = 把那张小图放大 3 倍 → 糊。
   * setResolution(d) 只改纹理的像素密度、**不改显示尺寸**，所以布局一行都不用动。
   */
  function applyTextDensity(list, d) {
    if (!list) return 0;
    d = d || deviceDpr();
    var arr = list.list ? list.list : list;
    var n = 0;
    for (var i = 0; i < arr.length; i++) {
      var o = arr[i];
      if (!o) continue;
      if (o.type === 'Text') {
        // 自定义布局把文字缩放过时，sharpenScaledText 会记一个更高的 _layoutRes，
        // 取两者较大值，避免两条路径互相把对方的分辨率改小。
        var want = Math.max(d, o._layoutRes || 0);
        if (o._textRes !== want && typeof o.setResolution === 'function') {
          o._textRes = want;
          try { o.setResolution(want); n++; } catch (e) { /* 单条失败不影响其它 */ }
        }
      } else if (o.list) {
        n += applyTextDensity(o.list, d);
      }
    }
    return n;
  }

  /**
   * 只读设备诊断（真机排查用）
   * ------------------------------------------------------------
   * 手机上打不开控制台：在地址栏里敲 `javascript:战斗2D.设备诊断()`
   * 或由宿主显示出来。三个比值各自对应一类故障：
   *   · 渲染密度 ≈ 设备DPR            → 正常
   *   · 渲染密度 < 设备DPR 且 > 1     → 被预算限流（性能保护，不是故障）
   *   · 渲染密度 == 1                 → 未生效（Canvas 渲染器 或 预算压到 1）
   *   · 画布CSS比 != 1                → CSS 把画布拉伸过，1:1 被破坏
   */
  function densityReport() {
    var out = {
      设备DPR: realDeviceDpr(),
      渲染密度: Math.round(renderDpr() * 100) / 100,
      预算像素: BUDGET_PIXELS
    };
    var g = state.game;
    if (!g || !g.canvas || !g.scale) { out.说明 = '引擎还没启动'; return out; }
    var c = g.canvas, sc = g.scale, r = g.renderer;
    out.逻辑尺寸 = Math.round(sc.width) + '×' + Math.round(sc.height);
    out.画布像素 = c.width + '×' + c.height;
    out.画布CSS = c.clientWidth + '×' + c.clientHeight;
    out.画布CSS比 = c.clientWidth ? Math.round(c.width / c.clientWidth * 100) / 100 : null;
    if (r) {
      out.渲染器 = r.width + '×' + r.height;
      out.投影 = (r.projectionWidth || 0) + '×' + (r.projectionHeight || 0);
      try {
        if (r.gl) {
          out.GL视口 = r.gl.getParameter(r.gl.VIEWPORT).join(',');
          out.GL缓冲 = r.gl.drawingBufferWidth + '×' + r.gl.drawingBufferHeight;
        }
      } catch (e) { /* 忽略 */ }
    }
    if (state.scene && state.scene.cameras && state.scene.cameras.main) {
      var cam = state.scene.cameras.main;
      out.主相机 = Math.round(cam.width) + '×' + Math.round(cam.height) +
        ' zoom=' + cam.zoom + ' scroll=' + Math.round(cam.scrollX) + ',' + Math.round(cam.scrollY);
    }
    var d = deviceDpr();
    if (d >= realDeviceDpr() - 0.01) out.结论 = '正常：整屏按设备密度渲染';
    else if (d > 1) out.结论 = '已限流：' + d + ' 倍（性能保护，不是故障）';
    else out.结论 = '未生效：密度为 1（Canvas 渲染器 或 预算被压到 1）';
    return out;
  }

  /**
   * 单向浮台 · 视觉（64×28）
   * ------------------------------------------------------------
   * 2.9.1 F1：玩家判断"能不能穿"看的是**底面**，所以两种平台的差异必须落在
   * 「下缘虚不虚」上，厚度与冷暖只是第二层证据。
   *   材质 = 凝结的光（不是砖）：冷青、半透明、下缘 alpha 归零；
   *   没有描边、没有支撑、没有砖缝 —— 空的东西不需要轮廓。
   * 顶部 2px 冷白高光是"上表面"，也就是可站立的那一面（与碰撞面重合）。
   */
  function makeThinPlatformTexture(scene) {
    var name = TEX.platThin;
    if (scene.textures.exists(name)) return name;
    var W = 64, H = 28;
    var tex = scene.textures.createCanvas(name, W, H);
    var ctx = tex.getContext();
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0.00, 'rgba(170,241,255,0.96)');
    g.addColorStop(0.20, 'rgba(98,197,238,0.80)');
    g.addColorStop(0.60, 'rgba(52,132,186,0.40)');
    g.addColorStop(1.00, 'rgba(14,44,70,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 上表面：冷白高光条（也是唯一"实"的一笔）
    ctx.fillStyle = 'rgba(228,252,255,0.95)';
    ctx.fillRect(0, 0, W, 2);
    // 能量横纹：连续亮线 + 每 64px 一个断口 —— 读作"流动的光"，而不是"砌好的砖"
    ctx.fillStyle = 'rgba(196,248,255,0.50)';
    ctx.fillRect(0, 9, 26, 1);
    ctx.fillRect(38, 9, 26, 1);
    tex.refresh();
    return name;
  }

  /**
   * 双层上层 · 视觉（64×64）
   * ------------------------------------------------------------
   * 2.9.1 F1：它是**一层楼**，不是悬浮物。三条证据一次给足：
   *   ① 厚：64px 实心，一直到底（浮台只有 28 且下缘化掉）；
   *   ② 材质：暖褐砖石 + 错缝砖缝（浮台是冷青光片）；
   *   ③ 附属：spawnDeckSegment 会补支撑柱与两端侧壁（浮台什么都没有）。
   * 顶部 3px 暖高光是可站立面（与碰撞面重合），底部 4px 深色收边把"厚度"收住。
   */
  function makeDeckTexture(scene) {
    var name = TEX.platDeck;
    if (scene.textures.exists(name)) return name;
    var W = 64, H = 64;
    var tex = scene.textures.createCanvas(name, W, H);
    var ctx = tex.getContext();
    // 底：深石色（砖缝就是这个颜色）
    ctx.fillStyle = '#241a15';
    ctx.fillRect(0, 0, W, H);
    // 砖：2 列 × 4 行，隔行错缝 16px
    var brickW = 32, rowH = 14;
    var rows = [{ y: 5, off: 0 }, { y: 19, off: 16 }, { y: 33, off: 0 }, { y: 47, off: 16 }];
    for (var r = 0; r < rows.length; r++) {
      var ry = rows[r].y, off = rows[r].off, idx = 0;
      for (var bx = -off; bx < W; bx += brickW, idx++) {
        ctx.fillStyle = ((r + idx) % 2 === 0) ? '#55392d' : '#4a3128';
        ctx.fillRect(bx + 1, ry, brickW - 2, rowH - 2);
        // 每块砖的顶边微高光：砖有厚度，不是平涂色块
        ctx.fillStyle = 'rgba(255,206,160,0.10)';
        ctx.fillRect(bx + 1, ry, brickW - 2, 1);
      }
    }
    // 上表面：暖高光条 + 1px 亮边
    ctx.fillStyle = 'rgba(255,224,178,0.60)';
    ctx.fillRect(0, 0, W, 3);
    ctx.fillStyle = 'rgba(255,246,228,0.92)';
    ctx.fillRect(0, 0, W, 1);
    // 底部收边：实心、深、齐平 —— "下面是实的"
    ctx.fillStyle = 'rgba(12,8,6,0.94)';
    ctx.fillRect(0, H - 4, W, 4);
    tex.refresh();
    return name;
  }

  /** 上层支撑柱（8×64 竖向渐变：贴着楼板实一点，往下越来越淡） */
  function makePillarTexture(scene) {
    var name = 'rt_pillar';
    if (scene.textures.exists(name)) return name;
    var W = 8, H = 64;
    var tex = scene.textures.createCanvas(name, W, H);
    var ctx = tex.getContext();
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0.00, 'rgba(62,43,32,0.70)');
    g.addColorStop(0.42, 'rgba(36,25,19,0.44)');
    g.addColorStop(1.00, 'rgba(12,8,6,0.12)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 两侧各收 1px：柱子要有边，不能是一条糊开的带子
    ctx.clearRect(0, 0, 1, H);
    ctx.clearRect(W - 1, 0, 1, H);
    tex.refresh();
    return name;
  }

  /* ============================================================
     2.9.2 · 守点「核心」与断桥的美术（反馈 §3.3 / §3.9 / §4.2）
     ------------------------------------------------------------
     一支笔、一套色，与既有地形纹理同一规格（64 网格内的代码画布，不引入图片文件）：
       冷青 #5fd0e0 = 玩家的东西（护罩 / 读数 / 提醒）
       暗紫 #6c5bd0 = 被守护的东西（核心本体）
       暖金 #ffd76a = 危险预警（与既有「限时」同色，玩家已经学过这个色）
       暖褐 #55392d = 木质（与双层上层同族）
     核心刻意**不用敌人那套暖红/品红**：它不还手、不掉落，是「要保的东西」，
     配色一旦沾上敌人色系，玩家第一眼会以为它是敌人。
     ============================================================ */

  /** 画一张代码纹理：draw(ctx, W, H)。已存在则跳过（重进房间不会重复生成） */
  function canvasTex(scene, name, W, H, draw) {
    if (scene.textures.exists(name)) return name;
    var tex = scene.textures.createCanvas(name, W, H);
    draw(tex.getContext(), W, H);
    tex.refresh();
    return name;
  }

  /* ---------- 2.9.4 B1-C：入口蜡烛 3 状态（48×80） ---------- */
  function makeCandleTextures(scene) {
    function draw(state) {
      return function (ctx, W, H) {
        var top = state === 0 ? 31 : (state === 1 ? 49 : 62);
        // 地面接触影与黄铜托盘：暖色但压暗，避免和奖励魂晶抢焦点
        ctx.fillStyle = 'rgba(0,0,0,0.34)';
        ctx.beginPath(); ctx.ellipse(24, 73, 18, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#3b2b25'; ctx.fillRect(8, 68, 32, 5);
        ctx.fillStyle = '#8b6540'; ctx.fillRect(11, 66, 26, 3);
        ctx.fillStyle = '#c49555'; ctx.fillRect(14, 65, 20, 2);
        ctx.fillStyle = '#4b3528'; ctx.fillRect(20, 62, 8, 5);
        // 蜡身：三态共用同一个底点，变短读作时间流逝，而不是换了一个道具
        ctx.fillStyle = state === 2 ? '#5b554f' : '#d8c49b';
        ctx.fillRect(18, top, 12, 66 - top);
        ctx.fillStyle = state === 2 ? '#756c62' : '#f3e2b8';
        ctx.fillRect(19, top + 1, 4, 65 - top);
        ctx.fillStyle = state === 2 ? '#403c39' : '#a98e6c';
        ctx.fillRect(27, top + 2, 3, 64 - top);
        ctx.fillStyle = state === 2 ? '#4a4540' : '#ead6ab';
        ctx.fillRect(17, top, 14, 3);
        if (state < 2) {
          // 一侧凝蜡，给轮廓一个不对称的落点
          ctx.fillStyle = '#f0ddb2';
          ctx.fillRect(17, top + 3, 3, state === 0 ? 9 : 5);
          ctx.fillRect(17, top + (state === 0 ? 11 : 7), 2, 3);
        }
        ctx.fillStyle = '#241d1a'; ctx.fillRect(23, top - 5, 2, 6);
        if (state < 2) {
          // 外焰暖橙、内焰近白；将尽时缩小并偏蓝，和 HUD 的橙/红档呼应
          var fy = top - (state === 0 ? 19 : 14);
          ctx.fillStyle = state === 0 ? 'rgba(255,177,74,0.15)' : 'rgba(255,93,90,0.12)';
          ctx.beginPath(); ctx.ellipse(24, fy + 7, state === 0 ? 11 : 8, state === 0 ? 15 : 11, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = state === 0 ? '#ff9f43' : '#ff725a';
          ctx.beginPath();
          ctx.moveTo(24, fy); ctx.bezierCurveTo(31, fy + 8, 30, fy + 15, 24, fy + 17);
          ctx.bezierCurveTo(18, fy + 15, 18, fy + 8, 24, fy); ctx.fill();
          ctx.fillStyle = state === 0 ? '#fff1b8' : '#ffd0a0';
          ctx.beginPath();
          ctx.moveTo(24, fy + 7); ctx.bezierCurveTo(27, fy + 11, 27, fy + 15, 24, fy + 16);
          ctx.bezierCurveTo(21, fy + 14, 21, fy + 11, 24, fy + 7); ctx.fill();
        } else {
          // 熄灭后只留一缕冷烟，入口仍能认出"时间已经烧完"
          ctx.strokeStyle = 'rgba(143,157,176,0.62)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(24, top - 5);
          ctx.bezierCurveTo(18, top - 12, 31, top - 17, 25, top - 25); ctx.stroke();
        }
      };
    }
    canvasTex(scene, TEX.candleFull, 48, 80, draw(0));
    canvasTex(scene, TEX.candleLow, 48, 80, draw(1));
    canvasTex(scene, TEX.candleOut, 48, 80, draw(2));
  }

  /* ---------- A6：核心 4 状态（64×64） ---------- */
  // 六棱柱外轮廓（顺时针：顶 → 右上 → 右下 → 底 → 左下 → 左上）
  var CORE_HEX = [[32, 7], [51, 19], [51, 41], [32, 53], [13, 41], [13, 19]];
  // 裂纹：手写而不是随机 —— 随机裂纹在小尺寸上会糊成噪点，手写才有一个"断"的方向
  var CORE_CRACKS = [
    [[32, 12], [27, 21], [34, 26], [28, 35]],
    [[46, 23], [38, 28], [41, 36], [33, 41]],
    [[19, 27], [25, 33], [18, 39]],
    [[35, 15], [43, 21], [41, 27]],
    [[24, 19], [30, 25]]
  ];

  function coreHexPath(ctx, pts, dx, dy) {
    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) {
      var x = pts[i][0] + (dx || 0), y = pts[i][1] + (dy || 0);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function drawCoreBase(ctx, W, H, dead) {
    // 石座：底部 13px、两段砌石、比晶核各宽 3px —— 「嵌进去」而不是「摆上去」
    ctx.fillStyle = dead ? '#151312' : '#1d1a16';
    ctx.fillRect(3, H - 13, W - 6, 13);
    ctx.fillStyle = dead ? '#201c1a' : '#2a2420';
    ctx.fillRect(4, H - 12, W - 8, 5);
    ctx.fillRect(4, H - 6, W - 8, 5);
    ctx.fillStyle = 'rgba(255,214,150,0.09)';
    ctx.fillRect(4, H - 12, W - 8, 1);
    if (dead) {
      // 碎裂：石座正中一道贯穿裂缝 —— 奖励没了，但"它曾经立在这"要读得出来
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(30, H - 13); ctx.lineTo(34, H - 8); ctx.lineTo(29, H - 3); ctx.lineTo(33, H);
      ctx.stroke();
    }
  }

  /**
   * 核心本体
   * opt: { left, right, light, rim, glow, cracks, chip }
   *   左半面受光（亮一档）/ 右半面背光 / 中央内芯发光 / 外圈符文
   *   濒碎时 chip = 右上角缺一块（缺口比裂纹更直接地说明"快没了"）
   */
  function drawCoreBody(ctx, opt) {
    var L = CORE_HEX;
    // 左半面
    ctx.beginPath();
    ctx.moveTo(L[0][0], L[0][1]); ctx.lineTo(L[5][0], L[5][1]);
    ctx.lineTo(L[4][0], L[4][1]); ctx.lineTo(L[3][0], L[3][1]);
    ctx.closePath();
    ctx.fillStyle = opt.left; ctx.fill();
    // 右半面
    ctx.beginPath();
    ctx.moveTo(L[0][0], L[0][1]); ctx.lineTo(L[1][0], L[1][1]);
    ctx.lineTo(L[2][0], L[2][1]); ctx.lineTo(L[3][0], L[3][1]);
    ctx.closePath();
    ctx.fillStyle = opt.right; ctx.fill();
    // 中缝：让两个面在视觉上折起来（没有这一笔，六边形就是一整块平色）
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(32, 8); ctx.lineTo(32, 52); ctx.stroke();

    if (opt.glow > 0) {
      var lg = ctx.createRadialGradient(32, 31, 1, 32, 31, 16);
      lg.addColorStop(0, opt.light.replace('ALPHA', opt.glow));
      lg.addColorStop(1, opt.light.replace('ALPHA', '0'));
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(32, 13); ctx.lineTo(39, 30); ctx.lineTo(32, 47); ctx.lineTo(25, 30);
      ctx.closePath();
      ctx.fill();
    }
    if (opt.chip) {
      // 右上角缺一块：直接把那个三角区域挖掉（透明），再补一圈暗边
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); ctx.moveTo(51, 19); ctx.lineTo(51, 31); ctx.lineTo(40, 21); ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,140,120,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(51, 31); ctx.lineTo(40, 21); ctx.stroke();
    }
    // 外圈符文
    ctx.strokeStyle = opt.rim;
    ctx.lineWidth = 1.5;
    coreHexPath(ctx, L, 0, 0);
    ctx.stroke();
    // 四向刻痕：把"封印"这件事画出来（四个短刻，不是装饰花纹）
    ctx.strokeStyle = opt.rim;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(32, 2); ctx.lineTo(32, 5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(9, 30); ctx.lineTo(11, 30); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(53, 30); ctx.lineTo(55, 30); ctx.stroke();
    if (!opt.chip) { ctx.beginPath(); ctx.moveTo(32, 55); ctx.lineTo(32, 58); ctx.stroke(); }

    // 裂纹：暗缝 + 一次极淡的亮边（受光面被劈开会反光）
    var n = opt.cracks || 0;
    for (var i = 0; i < n && i < CORE_CRACKS.length; i++) {
      var p = CORE_CRACKS[i];
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      for (var j = 1; j < p.length; j++) ctx.lineTo(p[j][0], p[j][1]);
      ctx.strokeStyle = 'rgba(6,4,14,0.92)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.13)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }

  function makeCoreTextures(scene) {
    var W = 64, H = 64;
    // 完好：满光、无裂
    canvasTex(scene, TEX.coreOk, W, H, function (ctx) {
      drawCoreBody(ctx, {
        left: '#5b4bb8', right: '#3f2f7c', light: 'rgba(214,200,255,ALPHA)',
        rim: 'rgba(140,232,255,0.85)', glow: 0.62, cracks: 0, chip: false
      });
      drawCoreBase(ctx, W, H, false);
    });
    // 受损：暗一档 + 3 道裂
    canvasTex(scene, TEX.coreHurt, W, H, function (ctx) {
      drawCoreBody(ctx, {
        left: '#4c3d99', right: '#332566', light: 'rgba(196,182,255,ALPHA)',
        rim: 'rgba(120,200,228,0.66)', glow: 0.38, cracks: 3, chip: false
      });
      drawCoreBase(ctx, W, H, false);
    });
    // 濒碎：缺角 + 5 道裂 + 内芯转红（红是"快没了"，不是"敌人"—— 只在光里出现）
    canvasTex(scene, TEX.coreCrit, W, H, function (ctx) {
      drawCoreBody(ctx, {
        // 濒碎：棱面保持暗，只把**内芯**烧红 —— 整块提亮会洗掉棱面，反而不像"快没了"
        left: '#3f3179', right: '#2a1e52', light: 'rgba(255,96,84,ALPHA)',
        rim: 'rgba(255,140,120,0.70)', glow: 0.52, cracks: 5, chip: true
      });
      drawCoreBase(ctx, W, H, false);
    });
    // 碎裂：无光、两片掉在石座上
    canvasTex(scene, TEX.coreBroken, W, H, function (ctx) {
      drawCoreBody(ctx, {
        left: '#241d3f', right: '#1a1530', light: 'rgba(0,0,0,ALPHA)',
        rim: 'rgba(120,130,160,0.35)', glow: 0, cracks: 5, chip: true
      });
      drawCoreBase(ctx, W, H, true);
      // 碎片：两片斜插在石座前，第三片落在左侧 —— 「它碎了」比空槽更好读
      ctx.fillStyle = '#2c2450';
      ctx.strokeStyle = 'rgba(140,150,190,0.30)';
      ctx.lineWidth = 1;
      [[38, 51, 7, 10, 0.5], [24, 53, 6, 8, -0.7]].forEach(function (s) {
        ctx.save();
        ctx.translate(s[0], s[1]); ctx.rotate(s[4]);
        ctx.beginPath(); ctx.moveTo(-s[2], 0); ctx.lineTo(0, -s[3]); ctx.lineTo(s[2], 0); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.restore();
      });
    });
  }

  /* ---------- A7：核心血条（64×10 的槽 + 代码画填充） ---------- */
  function makeCoreBarTexture(scene) {
    canvasTex(scene, TEX.coreBar, 64, 10, function (ctx, W) {
      // 槽：外框一轮暗边，内部 8 格分隔 —— 分段读数量，比一根连续条更好判断"还剩几成"
      ctx.fillStyle = 'rgba(4,3,9,0.80)';
      ctx.fillRect(0, 0, W, 10);
      ctx.fillStyle = '#150f1e';
      ctx.fillRect(1, 1, W - 2, 8);
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      for (var i = 1; i < 8; i++) ctx.fillRect(i * 8, 1, 1, 8);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(1, 1, W - 2, 1);
      // 两端收口：和血条本身同色系的冷青，说明「这是玩家的读数」
      ctx.fillStyle = 'rgba(120,230,255,0.55)';
      ctx.fillRect(0, 1, 1, 8);
      ctx.fillRect(W - 1, 1, 1, 8);
    });
  }

  /* ---------- A8：护罩穹顶（192×192 格架，圆环本身由代码画） ---------- */
  function hexStroke(ctx, cx, cy, r, rot) {
    ctx.beginPath();
    for (var i = 0; i < 6; i++) {
      var a = rot + i * Math.PI / 3;
      var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  /**
   * 护罩穹顶格架
   * 为什么不是"一个圆"：圆读作"范围提示"，六边格架读作"一顶罩子"——
   * 玩家要判断的是"我站进去了没有"，罩子比光圈更能说明这件事。
   * mode: 0 常态 / 1 收缩中（格架更密、更亮、少一环）/ 2 受击闪（只剩朝外的刺）
   */
  function makeShieldTextures(scene) {
    var S = 192, C = 96, R = 86;
    var draw = function (mode) {
      return function (ctx) {
        ctx.strokeStyle = mode === 2 ? 'rgba(234,252,255,0.92)' : 'rgba(95,208,224,' + (mode === 1 ? 0.46 : 0.30) + ')';
        ctx.lineWidth = 1.2;
        if (mode !== 2) {
          var rings = mode === 1
            ? [{ r: 36, n: 8, h: 7 }, { r: 58, n: 12, h: 8 }, { r: 78, n: 16, h: 8 }]
            : [{ r: 32, n: 6, h: 8 }, { r: 56, n: 10, h: 8 }, { r: 78, n: 14, h: 8 }];
          for (var i = 0; i < rings.length; i++) {
            var ring = rings[i];
            for (var j = 0; j < ring.n; j++) {
              var a = j * Math.PI * 2 / ring.n + (i * 0.17);
              hexStroke(ctx, C + Math.cos(a) * ring.r, C + Math.sin(a) * ring.r * 0.82, ring.h, a + 0.26);
            }
          }
        }
        // 周向刻线：12 道，收口在内侧（提示这是边界，不是装饰环）
        ctx.strokeStyle = mode === 2 ? 'rgba(255,255,255,0.95)' : 'rgba(120,230,255,' + (mode === 1 ? 0.78 : 0.62) + ')';
        ctx.lineWidth = 2;
        var tickIn = mode === 1 ? R - 14 : R - 7;
        for (var t = 0; t < 12; t++) {
          var ang = t * Math.PI / 6;
          ctx.beginPath();
          ctx.moveTo(C + Math.cos(ang) * tickIn, C + Math.sin(ang) * tickIn * 0.86);
          ctx.lineTo(C + Math.cos(ang) * (R - 1), C + Math.sin(ang) * (R - 1) * 0.86);
          ctx.stroke();
        }
      };
    };
    canvasTex(scene, TEX.shieldCalm, S, S, draw(0));
    canvasTex(scene, TEX.shieldTight, S, S, draw(1));
    canvasTex(scene, TEX.shieldHit, S, S, draw(2));
  }

  /* ---------- A13：波次预警（圈边闪烁帧 + 屏幕两侧裂纹） ---------- */
  function makeWarnTextures(scene) {
    // 闪烁帧：12 枚朝外的尖角 —— 闪起来像"栅栏立起来"，不是"圈变粗"
    canvasTex(scene, TEX.warnRing, 192, 192, function (ctx) {
      var C = 96, R = 84;
      ctx.strokeStyle = 'rgba(255,215,106,0.95)';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'square';
      for (var i = 0; i < 12; i++) {
        var a = i * Math.PI / 6;
        ctx.save();
        ctx.translate(C, C);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(R - 12, -5); ctx.lineTo(R + 2, 0); ctx.lineTo(R - 12, 5);
        ctx.stroke();
        ctx.restore();
      }
    });
    // 屏幕两侧裂纹：从边缘往里裂（128×256）。翻转配色，让"边缘"和"裂痕"分开
    var crack = function (flip) {
      return function (ctx, W, H) {
        if (flip) { ctx.translate(W, 0); ctx.scale(-1, 1); }
        var g = ctx.createLinearGradient(0, 0, 46, 0);
        g.addColorStop(0, 'rgba(255,110,80,0.30)');
        g.addColorStop(1, 'rgba(255,110,80,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 46, H);
        ctx.strokeStyle = 'rgba(255,150,110,0.85)';
        ctx.lineWidth = 2;
        var paths = [
          [[0, 40], [16, 52], [10, 74], [30, 92], [24, 118]],
          [[0, 132], [22, 120], [34, 140], [20, 160], [40, 178]],
          [[0, 196], [12, 210], [6, 232]]
        ];
        for (var i = 0; i < paths.length; i++) {
          var p = paths[i];
          ctx.beginPath();
          ctx.moveTo(p[0][0], p[0][1]);
          for (var j = 1; j < p.length; j++) ctx.lineTo(p[j][0], p[j][1]);
          ctx.lineWidth = i === 0 ? 2.4 : 1.6;
          ctx.stroke();
          // 分叉：主裂旁再开一小截，"裂"才不像"折线"
          ctx.beginPath();
          var m = p[Math.min(p.length - 1, 2)];
          ctx.moveTo(m[0], m[1]); ctx.lineTo(m[0] + 14, m[1] - 9);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      };
    };
    canvasTex(scene, TEX.warnCrackL, 128, 256, crack(false));
    canvasTex(scene, TEX.warnCrackR, 128, 256, crack(true));
  }

  /* ============================================================
     2.9.2 · 断桥美术（反馈 §4.2）
     ------------------------------------------------------------
     断桥现在最大的问题是"看起来像地面少了一块贴图"，而不是"桥断了"。
     三个新元素分头解决这件事：
       A9 断面（锯齿 + 钢筋 + 木梁）= 这段地面是被**劈开**的；
       A10 深渊渐隐 + 雾 = 下面**很深**，掉下去真的没了；
       A11 桥墩竖纹 + 落点裂纹 = 这是一座**桥**，而且有人跳过。
     ============================================================ */

  // 断面右侧的锯齿（宽 48 的贴图里，右边那一条是"被劈开的面"）
  var GAP_JAG = [[46, 0], [38, 14], [47, 26], [35, 40], [44, 54], [33, 68], [42, 82], [31, 96], [38, 112]];

  function makeGapTextures(scene) {
    var W = 48, H = 112;
    var draw = function (flip) {
      return function (ctx) {
        if (flip) { ctx.translate(W, 0); ctx.scale(-1, 1); }
        // 断面主体：和地面同一套色，但**压暗一档** —— 断口是阴影里的东西
        ctx.beginPath();
        ctx.moveTo(0, 0);
        for (var i = 0; i < GAP_JAG.length; i++) ctx.lineTo(GAP_JAG[i][0], GAP_JAG[i][1]);
        ctx.lineTo(0, H);
        ctx.closePath();
        var fg = ctx.createLinearGradient(0, 0, 0, H);
        fg.addColorStop(0, '#3a3046');
        fg.addColorStop(0.45, '#2b2336');
        fg.addColorStop(1, '#1a1422');
        ctx.fillStyle = fg;
        ctx.fill();
        // 断口亮边：沿着锯齿描一条受光线。这是整张图最重要的一笔 ——
        // 没有它，断面在近乎全黑的背景里只剩"地面突然没了"。
        ctx.beginPath();
        for (var jz = 0; jz < GAP_JAG.length; jz++) {
          if (jz === 0) ctx.moveTo(GAP_JAG[jz][0], GAP_JAG[jz][1]);
          else ctx.lineTo(GAP_JAG[jz][0], GAP_JAG[jz][1]);
        }
        ctx.strokeStyle = 'rgba(206,214,240,0.38)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,236,206,0.18)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // 砌层：断面里也要有石头分层，否则就是一坨色块
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 1;
        [24, 52, 80].forEach(function (y) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(36, y + 2); ctx.stroke();
        });
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        [26, 54, 82].forEach(function (y) {
          ctx.beginPath(); ctx.moveTo(0, y + 1); ctx.lineTo(34, y + 3); ctx.stroke();
        });
        // 上表面：延续地面那条绿边（断口边缘的草皮）
        ctx.fillStyle = 'rgba(76,175,80,0.34)';
        ctx.fillRect(0, 0, 40, 3);
        ctx.fillStyle = 'rgba(180,230,170,0.22)';
        ctx.fillRect(0, 0, 40, 1);

        // 露出来的钢筋：三根，向左伸进石头里 —— 从断口往外看才是"被扯断的"
        [30, 58, 84].forEach(function (y, i) {
          var x1 = 30 - i * 4;
          ctx.strokeStyle = '#8a4a2a';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x1, y);
          ctx.lineTo(GAP_JAG[i * 2 + 1][0] - 2, y + 3);
          ctx.stroke();
          ctx.strokeStyle = 'rgba(232,168,96,0.85)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1, y - 0.5);
          ctx.lineTo(GAP_JAG[i * 2 + 1][0] - 2, y + 2.5);
          ctx.stroke();
        });
        // 一根断掉的木梁斜插在断口里：木色与双层上层同族，读作"这里是搭出来的桥"
        ctx.save();
        ctx.translate(24, 68);
        ctx.rotate(-0.42);
        ctx.fillStyle = '#55392d';
        ctx.fillRect(-16, -3, 30, 6);
        ctx.fillStyle = 'rgba(255,206,160,0.18)';
        ctx.fillRect(-16, -3, 30, 1);
        ctx.fillStyle = '#2a1a12';
        ctx.fillRect(12, -3, 4, 6);      // 断口：末端是空的
        ctx.restore();

        // 底部压黑：断口往下就是深渊（与 A10 的渐隐接上）
        var vg = ctx.createLinearGradient(0, H - 46, 0, H);
        vg.addColorStop(0, 'rgba(4,3,8,0)');
        vg.addColorStop(1, 'rgba(4,3,8,0.85)');
        ctx.fillStyle = vg;
        ctx.fillRect(0, H - 46, W, 46);
      };
    };
    canvasTex(scene, TEX.gapL, W, H, draw(false));
    canvasTex(scene, TEX.gapR, W, H, draw(true));
  }

  /** A10：缺口下方深渊渐隐（64×160，上黑下透 —— 只交代"深"，不切出一块黑方块） */
  function makeAbyssTexture(scene) {
    canvasTex(scene, TEX.abyss, 64, 160, function (ctx, W, H) {
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0.00, 'rgba(2,2,6,0.97)');
      g.addColorStop(0.18, 'rgba(4,5,12,0.86)');
      g.addColorStop(0.45, 'rgba(6,8,18,0.52)');
      g.addColorStop(0.75, 'rgba(8,10,22,0.16)');
      g.addColorStop(1.00, 'rgba(10,12,26,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      // 顶部冷色雾霭：深渊不是"纯黑方块"，它被上方的光微微照亮
      var hz = ctx.createLinearGradient(0, 0, 0, 54);
      hz.addColorStop(0, 'rgba(96,128,178,0.16)');
      hz.addColorStop(1, 'rgba(96,128,178,0)');
      ctx.fillStyle = hz;
      ctx.fillRect(0, 0, W, 54);
      // 顶端一道更黑的"檐口"：把缺口边缘和天空分开，避免渐隐把边缘糊掉
      ctx.fillStyle = 'rgba(0,0,0,0.92)';
      ctx.fillRect(0, 0, W, 3);
    });
    // 雾气粒子：一枚软圆斑，代码里循环上浮
    canvasTex(scene, TEX.fog, 32, 32, function (ctx) {
      var g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
      g.addColorStop(0, 'rgba(196,214,236,0.22)');
      g.addColorStop(0.55, 'rgba(180,200,228,0.09)');
      g.addColorStop(1, 'rgba(170,190,220,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 32, 32);
    });
  }

  /** A11：桥墩竖纹（16×64）+ 落点撞击裂纹（48×20） */
  function makeBridgeDecalTextures(scene) {
    canvasTex(scene, TEX.pier, 16, 64, function (ctx) {
      // 不是一根柱子，是桥面正面的**结构缝**：两道暗竖条 + 中间压暗
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(0, 0, 16, 64);
      ctx.fillStyle = 'rgba(0,0,0,0.48)';
      ctx.fillRect(3, 0, 3, 64);
      ctx.fillRect(11, 0, 3, 64);
      ctx.fillStyle = 'rgba(255,214,150,0.07)';
      ctx.fillRect(2, 0, 1, 64);
      ctx.fillRect(10, 0, 1, 64);
      // 一道横缝：说明桥面是分段搭的
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.fillRect(0, 30, 16, 2);
      ctx.fillStyle = 'rgba(255,214,150,0.05)';
      ctx.fillRect(0, 29, 16, 1);
    });
    canvasTex(scene, TEX.landCrack, 48, 20, function (ctx) {
      // 落点裂纹：从一点放射，暗示"有人从对面跳过来砸在这儿"
      ctx.strokeStyle = 'rgba(6,4,10,0.78)';
      ctx.lineCap = 'round';
      var arms = [
        [[14, 3], [22, 9], [34, 12]],
        [[14, 3], [10, 10], [2, 14]],
        [[14, 3], [26, 4], [40, 3]],
        [[14, 3], [18, 12], [24, 18]]
      ];
      for (var i = 0; i < arms.length; i++) {
        var p = arms[i];
        ctx.beginPath();
        ctx.moveTo(p[0][0], p[0][1]);
        for (var j = 1; j < p.length; j++) ctx.lineTo(p[j][0], p[j][1]);
        ctx.lineWidth = i === 0 ? 2 : 1.4;
        ctx.stroke();
      }
      // 起的土：极淡的两点，只用来压住"这里没有草皮"
      ctx.fillStyle = 'rgba(196,180,150,0.10)';
      ctx.beginPath(); ctx.arc(18, 8, 6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(38, 14, 4, 0, Math.PI * 2); ctx.fill();
    });
  }

  /** A12：残板 3 张（56×14 完整 / 松动 / 掉落中） */
  function makePlankTextures(scene) {
    var W = 56, H = 14;
    var board = function (ctx, x, w, y, h, fill, top) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = top;
      ctx.fillRect(x, y, w, 1);
    };
    // 完整：两块板 + 四颗钉子 + 一道中缝
    canvasTex(scene, TEX.plankOk, W, H, function (ctx) {
      board(ctx, 0, W, 0, 6, '#55392d', 'rgba(255,206,160,0.22)');
      board(ctx, 0, W, 7, 6, '#4a3128', 'rgba(255,206,160,0.14)');
      ctx.fillStyle = 'rgba(200,176,144,0.75)';
      [[5, 3], [51, 3], [5, 10], [51, 10]].forEach(function (p) {
        ctx.beginPath(); ctx.arc(p[0], p[1], 1.4, 0, Math.PI * 2); ctx.fill();
      });
      ctx.fillStyle = 'rgba(0,0,0,0.40)';
      ctx.fillRect(28, 0, 1, 13);
    });
    // 松动：一端翘起（视觉上右端更亮），中间裂开一道，右端钉子没了
    canvasTex(scene, TEX.plankLoose, W, H, function (ctx) {
      board(ctx, 0, W, 1, 6, '#5d4033', 'rgba(255,206,160,0.26)');
      board(ctx, 0, W - 6, 8, 5, '#463027', 'rgba(255,206,160,0.10)');
      ctx.fillStyle = 'rgba(200,176,144,0.65)';
      [[5, 4], [18, 4]].forEach(function (p) {
        ctx.beginPath(); ctx.arc(p[0], p[1], 1.4, 0, Math.PI * 2); ctx.fill();
      });
      // 裂缝：从右上斜切到左下 —— 这是"站上去会掉"的唯一承诺
      ctx.strokeStyle = 'rgba(8,6,12,0.9)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(40, 1); ctx.lineTo(33, 6); ctx.lineTo(38, 9); ctx.lineTo(30, 13);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    });
    // 掉落中：整体压暗、左缘被扯断（锯齿），边缘残渣
    canvasTex(scene, TEX.plankFalling, W, H, function (ctx) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(6, 0); ctx.lineTo(2, 4); ctx.lineTo(7, 8); ctx.lineTo(3, 14);
      ctx.lineTo(W, 14); ctx.lineTo(W, 0);
      ctx.closePath();
      ctx.clip();
      board(ctx, 0, W, 0, 6, '#33241d', 'rgba(255,206,160,0.10)');
      board(ctx, 0, W, 7, 6, '#2a1d17', 'rgba(255,206,160,0.06)');
      ctx.restore();
      ctx.fillStyle = 'rgba(90,70,56,0.5)';
      ctx.fillRect(12, 12, 3, 2);
      ctx.fillRect(34, 11, 2, 2);
    });
  }

  /** 落石（26×26）：§4.3 ② 用，不属于原 A9–A12 清单，单列在这一段 */
  function makeRockTexture(scene) {
    canvasTex(scene, TEX.rockfall, 26, 26, function (ctx) {
      var pts = [[13, 1], [23, 8], [25, 18], [16, 25], [6, 23], [1, 14], [4, 5]];
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = '#3a3448';
      ctx.fill();
      ctx.strokeStyle = 'rgba(150,160,190,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // 受光面（左上）+ 背光面（右下）：石头要有体积，否则是个灰点
      ctx.fillStyle = 'rgba(120,130,165,0.55)';
      ctx.beginPath(); ctx.moveTo(13, 3); ctx.lineTo(22, 9); ctx.lineTo(13, 14); ctx.lineTo(4, 9);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(10,8,16,0.45)';
      ctx.beginPath(); ctx.moveTo(13, 15); ctx.lineTo(22, 10); ctx.lineTo(23, 18); ctx.lineTo(15, 23);
      ctx.closePath(); ctx.fill();
    });
  }

  /** 生成全部代码纹理 */  function buildTextures(scene) {
    var g = scene.make.graphics({ x: 0, y: 0 }, false);

    // 主角与敌人的精灵表由 角色形象.js 按角色按需生成
    // （ensureHeroTexture / ensureMobTexture：9 位英雄 + 10 种怪物各有专属形象）

    // ---------- 地形 ----------
    if (!scene.textures.exists(TEX.ground)) {
      g.fillStyle(0x2a2135, 1); g.fillRect(0, 0, 64, 64);
      g.fillStyle(0x3d3149, 1); g.fillRect(0, 0, 64, 10);
      g.fillStyle(0x4CAF50, 0.5); g.fillRect(0, 0, 64, 3);
      g.fillStyle(0x1a1425, 1);
      g.fillRect(8, 20, 10, 8); g.fillRect(34, 34, 12, 8); g.fillRect(46, 14, 8, 6);
      g.generateTexture(TEX.ground, 64, 64);
      g.clear();
    }
    if (!scene.textures.exists(TEX.platform)) {
      g.fillStyle(0x3a2f48, 1); g.fillRect(0, 0, 64, 20);
      g.fillStyle(0x4CAF50, 0.45); g.fillRect(0, 0, 64, 3);
      g.fillStyle(0x241d30, 1); g.fillRect(4, 10, 14, 6); g.fillRect(40, 8, 16, 7);
      g.generateTexture(TEX.platform, 64, 20);
      g.clear();
    }
    // 两种平台的**可见**外观（2.9.1 F1）：撞色 + 撞厚度 + 撞下缘
    makeThinPlatformTexture(scene);
    makeDeckTexture(scene);
    makePillarTexture(scene);

    // ---------- 2.9.2 §3 守住核心 / §4 断桥 ----------
    makeCoreTextures(scene);
    makeCoreBarTexture(scene);
    makeShieldTextures(scene);
    makeWarnTextures(scene);
    makeCandleTextures(scene);
    makeGapTextures(scene);
    makeAbyssTexture(scene);
    makeBridgeDecalTextures(scene);
    makePlankTextures(scene);
    makeRockTexture(scene);

    // ---------- 特效 ----------
    if (!scene.textures.exists(TEX.slash)) {
      g.lineStyle(6, 0xffffff, 0.95);
      g.beginPath(); g.arc(30, 34, 26, Phaser.Math.DegToRad(-70), Phaser.Math.DegToRad(70), false); g.strokePath();
      g.lineStyle(3, 0xa8e6ff, 0.8);
      g.beginPath(); g.arc(30, 34, 18, Phaser.Math.DegToRad(-60), Phaser.Math.DegToRad(60), false); g.strokePath();
      g.generateTexture(TEX.slash, 60, 68);
      g.clear();
    }
    if (!scene.textures.exists(TEX.spark)) {
      g.fillStyle(0xffffff, 1); g.fillCircle(4, 4, 4);
      g.generateTexture(TEX.spark, 8, 8);
      g.clear();
    }
    if (!scene.textures.exists(TEX.projectile)) {
      g.fillStyle(0x7a3ab0, 1); g.fillCircle(9, 9, 9);
      g.fillStyle(0xd8b0ff, 1); g.fillCircle(9, 9, 5);
      g.generateTexture(TEX.projectile, 18, 18);
      g.clear();
    }
    if (!scene.textures.exists(TEX.portal)) {
      g.lineStyle(4, 0x73f0b4, 0.9); g.strokeEllipse(28, 45, 44, 88);
      g.lineStyle(2, 0xd8fff0, 0.7); g.strokeEllipse(28, 45, 28, 68);
      g.generateTexture(TEX.portal, 56, 90);
      g.clear();
    }

    // ---------- 画面控件图标 ----------
    ensureIconTextures(scene);

    g.destroy();
  }

  // ============================================================
  //  敌人图鉴（类型 → 属性与行为）
  // ============================================================
  var ENEMY_TYPES = {
    claw:     { name: '黑暗爪牙',   tier: 'normal', behavior: 'chaser',  hp: 24,  atk: 4,  speed: 72,  w: 30, h: 44, scale: 1.0,  tex: 'enemy', color: 0x8a2a5a, attackRange: 58,  windup: 340, recover: 420, detect: 430 },
    skeleton: { name: '骷髅骑兵',   tier: 'normal', behavior: 'chaser',  hp: 32,  atk: 5,  speed: 98,  w: 30, h: 44, scale: 1.0,  tex: 'enemy', color: 0x8a8a9a, attackRange: 62,  windup: 300, recover: 460, detect: 470, throw: true },
    zombie:   { name: '死尸',       tier: 'normal', behavior: 'chaser',  hp: 44,  atk: 6,  speed: 52,  w: 32, h: 46, scale: 1.05, tex: 'enemy', color: 0x4a7a4a, attackRange: 58,  windup: 520, recover: 560, detect: 380, thorn: 1 },
    magma:    { name: '岩浆行者',   tier: 'normal', behavior: 'charger', hp: 36,  atk: 7,  speed: 86,  w: 32, h: 46, scale: 1.05, tex: 'enemy', color: 0xb04a1a, attackRange: 72,  windup: 430, recover: 540, detect: 520 },
    shade:    { name: '影（附身）', tier: 'normal', behavior: 'flyer',   hp: 28,  atk: 6,  speed: 112, w: 30, h: 30, scale: 0.95, tex: 'enemy', color: 0x2a2a4a, attackRange: 52,  windup: 300, recover: 380, detect: 540, fly: true },
    mimic:    { name: '镜像怪',     tier: 'mirror', behavior: 'chaser',  hp: 42,  atk: 8,  speed: 106, w: 30, h: 44, scale: 1.0,  tex: 'enemy', color: 0x6a3ab0, attackRange: 64,  windup: 300, recover: 400, detect: 480, tint: 0xd0b0ff },
    guard:    { name: '精英守卫',   tier: 'elite',  behavior: 'charger', hp: 72,  atk: 11, speed: 94,  w: 34, h: 50, scale: 1.2,  tex: 'enemy', color: 0xd4a02a, attackRange: 78,  windup: 450, recover: 540, detect: 580, tint: 0xfff0c0 },
    necro:    { name: '死灵法师',   tier: 'elite',  behavior: 'shooter', hp: 56,  atk: 9,  speed: 66,  w: 32, h: 48, scale: 1.15, tex: 'enemy', color: 0x5a3a8a, attackRange: 340, windup: 540, recover: 700, detect: 560, keepDist: 220 },
    lord:     { name: '层主',       tier: 'boss',   behavior: 'boss',    hp: 160, atk: 14, speed: 84,  w: 42, h: 60, scale: 1.5,  tex: 'boss',  color: 0xb0182a, attackRange: 92,  windup: 520, recover: 620, detect: 720 },
    shadowking:{ name: '影之皇',    tier: 'boss',   behavior: 'boss',    hp: 240, atk: 18, speed: 100, w: 44, h: 64, scale: 1.7,  tex: 'boss',  color: 0x3a0a2a, attackRange: 100, windup: 460, recover: 520, detect: 820, tint: 0xe0c0ff },

    /* ---------------- 机制型敌人（B 项）----------------
       为什么加它们：原来 10 种敌人的区别只有"血量 / 速度 / 行为"，
       而行为又只有追击 / 冲锋 / 飞行 / 远程四种 —— **打法完全一样**：
       靠近、按 J、躲开。加数量不会改变这件事。
       这三只各自封掉一条玩家最省事的路径，逼你动用工具箱里的某一件：
         bulwark  铁壁兵  → 正面免疫：不许站桩平砍，必须跳劈（从上方）或绕后
         weaver   织网者  → 织网减速：不许硬吃远程，必须用闪避切断
         sacrificer 献祭者 → 给同伴套盾：不许按"最近的先打"，必须换目标
       三只都刻意配了"能看出来的解法"，而不是纯数值压制。 */
    bulwark:  { name: '铁壁兵',   tier: 'normal', behavior: 'bulwark', hp: 40,  atk: 6,  speed: 68,  w: 34, h: 48, scale: 1.1,  tex: 'enemy', color: 0x4a6a8a, attackRange: 68,  windup: 480, recover: 560, detect: 520, shieldFront: true },
    weaver:   { name: '织网者',   tier: 'normal', behavior: 'shooter', hp: 30,  atk: 4,  speed: 74,  w: 32, h: 44, scale: 1.0,  tex: 'enemy', color: 0x3a5a4a, attackRange: 300, windup: 620, recover: 820, detect: 540, keepDist: 240, web: true },
    sacrificer:{ name: '献祭者',  tier: 'elite',  behavior: 'support', hp: 48,  atk: 6,  speed: 72,  w: 30, h: 48, scale: 1.1,  tex: 'enemy', color: 0x7a1a2a, attackRange: 320, windup: 560, recover: 700, detect: 620, keepDist: 260, auraShield: true }
  };

  function poolForFloor(floor) {
    var pool = ['claw', 'skeleton'];
    if (floor >= 2) pool.push('zombie');
    if (floor >= 3) pool.push('magma');
    if (floor >= 4) pool.push('shade');
    // 机制型敌人从第 5 层开始逐个登场：给玩家足够时间先学会基本操作，
    // 再让"某一种打法被针对"成为压力来源 —— 它们的作用是制造变化，不是制造难度墙
    if (floor >= 5) pool.push('bulwark');
    if (floor >= 6) pool.push('necro');
    if (floor >= 7) pool.push('weaver');
    if (floor >= 9) pool.push('sacrificer');
    return pool;
  }

  // 敌人属性显示用的中文标签
  var TIER_NAMES = { normal: '普通', elite: '精英', mirror: '镜像', boss: '首领' };
  var BEHAVIOR_NAMES = { chaser: '追击', charger: '冲锋', flyer: '飞行', shooter: '远程', boss: '首领', bulwark: '持盾', support: '辅助' };

  // ============================================================
  //  房间系统（地图生成 + 房间类型）
  //  每层生成一张分支地图：入口 → 分支房间 → … → Boss 房间
  //  清空房间后走向传送门即打开地图，点击相邻房间继续深入
  // ============================================================
  /* ============================================================
     机制常量的「基准值」快照
     ------------------------------------------------------------
     24 件遗物里有 18 件做的是「把引擎既有机制的参数挪一点」——
     例如完美闪避窗口 150ms → 230ms。这些常量散落在 DODGE / GUARD / CHAIN /
     DIVE / STAMINA / FURY / RANGED_ATTACK 里，被几十处热路径直接读取。
     与其去改那几十处读取点，不如**在下发遗物时按基准值整体重算一次常量**：
     读取点一行都不用动，也不会因为反复下发而累加漂移。
     （新增遗物只要往 RELIC_FX 加一行、在这里补一条映射即可。）
     ============================================================ */
  /* ============================================================
     连携（Link）—— 把「打得好」变成一种能攒、能选、有风险的资源
     ------------------------------------------------------------
     为什么要它（用户反馈：「玩法没什么深度」）：
       引擎里本来就有很硬的技巧门槛（完美闪避 150ms / 完美格挡 200ms / 盾反 / 跳劈），
       但它们的收益是**互相孤立的瞬时 buff** —— 完美闪避必给锐利、完美格挡必给盾反，
       玩家没有任何可做的决定，"打得好"只等于"接下来几秒数字更大"。
     连携把技巧变成资源，于是产生了三个真实抉择：
       · 攒：每次完美判定 +1（上限 3）
       · 选：点数被**下一次主动攻击**吃掉（普攻 / 连招 / 跳劈都吃），
             "留着这点打盾反"和"现在先砍一刀"变成需要权衡的事
       · 险：一旦被打中，全部清零 —— 想攒就得敢在刀尖上站着
     与遗物的关系（A 项「遗物构筑化」）：上限 / 倍率 / 受击是否清零都由遗物改，
     所以「连携上限 + 不屈意志 + 回响精通」本身就是一条能主动堆的构筑路线。
     ============================================================ */
  var LINK = {
    max: 3,          // 上限（遗物 linkMax 可抬）
    dmgMult: 1.6,    // 连携招式的伤害倍率（遗物 linkDmg 可抬）
    splash: 1.5,     // 跳劈带连携时，落地冲击波半径的倍率
    knock: 1.6       // 盾反带连携时，击退力度的倍率
  };

  /* ============================================================
     织网者的网（B 项机制型敌人）
     ------------------------------------------------------------
     它不是"另一种远程怪"，而是**逼你用闪避**的那一只：
     被网缠住 → 移动掉到 45%，而**闪避可以直接把网撕开**（见 tryDodge）。
     于是每一发网都变成一道实时的二选一：先闪掉它，还是先吃一下换个输出窗口。
     解法写在操作上（而不是数值上），这是"机制型"和"堆数值"的分界线。
     ============================================================ */
  var WEB = {
    duration: 5200,     // 缠身时长
    moveScale: 0.45,    // 被缠住时的移动速度倍率
    cd: 2600,           // 同一只织网者的两次吐网间隔
    speed: 260,         // 网弹飞行速度
    radius: 560         // 吐网的最远距离
  };

  /* 铁壁兵的转身延迟（B 项）
     ------------------------------------------------------------
     这个数字是"绕后"这条解法**唯一**的存在依据：
     它对玩家的朝向每帧都会更新（那就永远正面），所以必须给它一个转身延迟 ——
     玩家在延迟窗口里绕到背后，才打得到它。调大 = 更好绕，调小 = 只能跳劈。 */
  var SHIELD_TURN = 700;

  var MECH_BASE = {
    staminaMax: STAMINA.max,
    staminaRegen: STAMINA.regen,
    dodgeInvuln: DODGE.invuln,
    dodgeSpeed: DODGE.speed,
    dodgePerfect: DODGE.perfect,
    dodgeSharp: DODGE.sharp,
    dodgeSharpMult: DODGE.sharpMult,
    dodgeAirDrag: DODGE.airDrag,
    guardPerfect: GUARD.perfect,
    guardCounterMult: GUARD.counterMult,
    guardShieldGain: GUARD.shieldGain,
    chainWindow: CHAIN.window,
    chainSweepMult: CHAIN.sweepMult,
    diveMult: DIVE.mult,
    diveBuryChance: DIVE.buryChance,
    furyGainKill: FURY.gainKill,
    furyGainChain: FURY.gainChain,
    furyGainPerfect: FURY.gainPerfect,
    furyGainHurt: FURY.gainHurt,
    furyGainHit: { normal: FURY.gainHit.normal, elite: FURY.gainHit.elite, mirror: FURY.gainHit.mirror, boss: FURY.gainHit.boss },
    linkMax: LINK.max,
    linkDmgMult: LINK.dmgMult,
    ranged: {
      // cd 也要存基准：连珠（2.9.2 F7）会按比例缩短连射间隔，没有基准就会越叠加越短
      ranger: { cd: RANGED_ATTACK.ranger.cd, pierce: RANGED_ATTACK.ranger.pierce, speed: RANGED_ATTACK.ranger.speed, homing: 0 },
      mage: { cd: RANGED_ATTACK.mage.cd, pierce: RANGED_ATTACK.mage.pierce, speed: RANGED_ATTACK.mage.speed, homing: RANGED_ATTACK.mage.homing || 0 },
      sage: { cd: RANGED_ATTACK.sage.cd, pierce: RANGED_ATTACK.sage.pierce, speed: RANGED_ATTACK.sage.speed, homing: 0 }
    }
  };

  var ROOM_TYPES = {
    start:    { name: '入口',     icon: '⌂', fill: 0x3a3a48, line: 0xd8d8e8, center: '#d8d8e8', desc: '本层入口，少量敌人' },
    enemy:    { name: '普通房间', icon: '×', fill: 0x44444f, line: 0x9aa0b0, center: '#c8cede', desc: '普通敌人把守' },
    elite:    { name: '精英房间', icon: '★', fill: 0x24406a, line: 0x4a8ad0, center: '#7ab8ff', desc: '精英守卫 · 金币更多' },
    mirror:   { name: '镜像房间', icon: '◇', fill: 0x412a63, line: 0x9a5ad0, center: '#c79aff', desc: '镜像怪复制你的属性' },
    boss:     { name: 'Boss房间', icon: '☠', fill: 0x661a22, line: 0xd02a3a, center: '#ff8a7a', desc: '层主坐镇 · 击败后深入下一层' },
    treasure: { name: '宝箱房间', icon: '▣', fill: 0x63501c, line: 0xd4a02a, center: '#ffd76a', desc: '无战斗 · 开箱获得金币' },
    shrine:   { name: '祭坛房间', icon: '✚', fill: 0x17524c, line: 0x4ad0c0, center: '#7fe8d8', desc: '无战斗 · 祭坛恢复生命' },
    // --- 并入经典模式时新增的三种（无战斗，走近目标物开画内面板）---
    shop:     { name: '商店房间', icon: '$', fill: 0x1c4a2a, line: 0x4ad07a, center: '#8ae8a8', desc: '无战斗 · 用金币换取补给' },
    rest:     { name: '休整房间', icon: '☾', fill: 0x2a3150, line: 0x6a8ad0, center: '#a8c0ff', desc: '无战斗 · 恢复生命与状态' },
    event:    { name: '事件房间', icon: '?', fill: 0x4a3a1c, line: 0xd0b04a, center: '#ffe8a0', desc: '无战斗 · 未知的际遇' }
  };

  var MAP_COLS = 4;   // 入口 → 中段分支 ×2 → Boss
  var MAP_ROWS = 3;

  /** 非战斗房间目标物的交互提示语（挂在标签胶囊里，替代原来写死在每段里的裸文字） */
  var GOAL_HINT = {
    treasure: '走近开启',
    shrine: '走近祈祷',
    shop: '走近查看',
    rest: '走近歇息',
    event: '走近探查'
  };

  /** 会生成目标物的房间类型白名单（战斗房一律不生成，见 spawnRoomGoal 的说明） */
  var GOAL_KINDS = { treasure: 1, shrine: 1, shop: 1, rest: 1, event: 1 };

  /** 按列分配房间类型（第 1 列偏普通/镜像，第 2 列偏精英） */
  function pickRoomType(col) {
    var r = Math.random();
    if (col <= 1) {
      if (r < 0.46) return 'enemy';
      if (r < 0.68) return 'mirror';
      if (r < 0.87) return 'treasure';
      return 'shrine';
    }
    if (r < 0.32) return 'enemy';
    if (r < 0.58) return 'elite';
    if (r < 0.76) return 'mirror';
    if (r < 0.89) return 'treasure';
    return 'shrine';
  }

  /**
   * 生成一层的地图：分支网格 + 相邻连线
   * 保证：入口只有一个、最右列必为 Boss、每个房间都有入口与出路
   */
  function generateFloorMap(floor) {
    var nodes = [];
    var cols = [];
    var id = 0;
    function mk(col, row, type) {
      var n = { id: id++, col: col, row: row, type: type, links: [], visited: false, cleared: false };
      nodes.push(n);
      return n;
    }

    var start = mk(0, 1, 'start');
    start.visited = true;
    cols.push([start]);

    var prev = [start];
    for (var c = 1; c < MAP_COLS; c++) {
      var isBossCol = (c === MAP_COLS - 1);
      var rows = [];
      if (isBossCol) {
        rows = [prev[ri(0, prev.length - 1)].row];
      } else {
        prev.forEach(function (n) {
          if (rows.indexOf(n.row) < 0) rows.push(n.row);
          // 每个房间有 55% 概率再分出一条支路
          if (Math.random() < 0.55) {
            var r2 = n.row + (Math.random() < 0.5 ? -1 : 1);
            if (r2 >= 0 && r2 < MAP_ROWS && rows.indexOf(r2) < 0) rows.push(r2);
          }
        });
        if (rows.length > MAP_ROWS) rows = rows.slice(0, MAP_ROWS);
      }
      rows.sort(function (a, b) { return a - b; });
      var col = rows.map(function (r) { return mk(c, r, isBossCol ? 'boss' : pickRoomType(c, floor)); });
      cols.push(col);

      // 连接：上一列每个房间至少有一条出路，且只连相邻行
      prev.forEach(function (n) {
        var cands = col.filter(function (m) { return Math.abs(m.row - n.row) <= 1; });
        if (!cands.length) cands = [col[0]];
        n.links.push(cands[ri(0, cands.length - 1)].id);
      });
      // 本列每个房间都要有人能走到
      col.forEach(function (m) {
        var reachable = prev.some(function (n) { return n.links.indexOf(m.id) >= 0; });
        if (!reachable) {
          var best = prev.slice().sort(function (a, b) {
            return Math.abs(a.row - m.row) - Math.abs(b.row - m.row);
          })[0];
          best.links.push(m.id);
        }
      });
      prev = col;
    }

    // 保底：本层至少要有一个真正的战斗房间
    var mid = cols[1].concat(cols[2] || []);
    var hasFight = mid.some(function (n) {
      return n.type === 'enemy' || n.type === 'elite' || n.type === 'mirror';
    });
    if (!hasFight && mid.length) mid[0].type = 'enemy';

    return { floor: floor, cols: cols, nodes: nodes, current: start };
  }

  /**
   * 给一组列连线（cols = 二维节点数组）
   * 与 generateFloorMap 内联的规则完全一致：相邻列、行号相差 ≤1 才可互通，
   * 且保证「每个房间都有出路」与「每个房间都走得到」。
   * 抽出来是为了让**宿主下发的规划**与原自造地图走同一套连线，不出现两套手感。
   */
  function linkCols(cols) {
    for (var c = 1; c < cols.length; c++) {
      var prev = cols[c - 1], col = cols[c];
      if (!prev.length || !col.length) continue;

      // ⚠️ 连线**必须是有约束的**，不能全连
      // ------------------------------------------------------------
      // 全连（每个节点通往下一列的所有房间）看起来"分支很多"，实际上
      // 每一条路都通向同一批房间 —— 玩家选哪条都一样，等于没有选择（用户反馈：
      // "不要把每个房间都连上啊，要让玩家有选择，比如选完敌袭下一个就只能进精英，
      //   不能选择进另一个宝箱房间"）。
      // 正确做法：**每个节点只连 1~2 条出边**，于是"打了哪一间"会真正决定
      // "接下来能去哪一间"——这才是 roguelike 地图的取舍感。
      //
      // 具体规则：
      //   · 每个节点默认只有 **1 条**出边（"进了这间，下一间就定了"）；
      //   · 但**每一列至少有一个节点给 2 条** —— 否则整层一个选择点都没有，
      //     又变回一条直线（起点列只有 1 个节点，所以它天然就是这个分叉点，
      //     玩家一开局就能选方向）；
      //   · 上一列里"哪个节点是分叉点"是随机的 —— 于是"刚才选了哪一间"
      //     会直接影响"这一列还有没有得选"，选择因此有了后果。
      var forkIdx = ri(0, prev.length - 1);
      prev.forEach(function (n, ni) {
        var cands = col.filter(function (m) { return Math.abs(m.row - n.row) <= 1; });
        if (!cands.length) cands = [col[0]];
        var want = (ni === forkIdx && cands.length > 1) ? 2 : 1;
        var pool = cands.slice().sort(function () { return Math.random() - 0.5; });
        for (var i = 0; i < want && i < pool.length; i++) {
          if (n.links.indexOf(pool[i].id) < 0) n.links.push(pool[i].id);
        }
      });

      // 兜底：后一列每个房间**至少要有一个入口**，否则地图上会出现永远进不去的门
      col.forEach(function (m) {
        var reachable = prev.some(function (n) { return n.links.indexOf(m.id) >= 0; });
        if (!reachable) {
          var best = prev.slice().sort(function (a, b) {
            return Math.abs(a.row - m.row) - Math.abs(b.row - m.row);
          })[0];
          best.links.push(m.id);
        }
      });
    }
    return cols;
  }

  // ============================================================
  //  环境主题（按难度切换星雾与火星）
  // ============================================================
  var ENV_THEMES = {
    easy:   { name: '简单', star: 0xffffff, fog: 0x2a4a6a, fogAlpha: 0.16, ember: false, ground: 0x2a3446 },
    normal: { name: '普通', star: 0x9fd8ff, fog: 0x4a1a3a, fogAlpha: 0.22, ember: false, ground: 0x2e2a40 },
    hard:   { name: '困难', star: 0xffc9a0, fog: 0x5a2410, fogAlpha: 0.26, ember: true,  ground: 0x3a2a2a },
    hell:   { name: '地狱', star: 0xff8a5a, fog: 0x6a0a08, fogAlpha: 0.32, ember: true,  ground: 0x40201a }
  };

  function envThemeFor(diff) {
    if (diff === 'easy') return ENV_THEMES.easy;
    if (diff === 'hard' || diff === 'custom') return ENV_THEMES.hard;
    if (diff === 'hell') return ENV_THEMES.hell;
    return ENV_THEMES.normal;
  }

  // ============================================================
  //  画面内界面风格
  //  全部取自 主样式.css 既有设计语言，画面内界面不再自带一套配色：
  //   · 模态面板 ← .modal-content      rgba(15,22,44,.98) · 白 12% 描边 · 18px 圆角
  //   · 内嵌卡片 ← .trial-player-panel rgba(18,24,40,.68) · 白 7% 描边  · 10px 圆角
  //   · 血量条   ← .trial-enemy-hp     白 6% 轨道 + 语义色渐变（圆角端 · 0.4s 缓动 · 掉血残影）
  //   · 画面控件 ← .trial-ghost-btn    语义色底 + 同色描边 · 全圆角（悬浮在战场之上）
  //   · 面板动作 ← .trial-action-btn   白 3% 底 + 白 7% 描边 · 4px 圆角（面板之内）
  // ============================================================
  var FONT = '"Microsoft YaHei", "Segoe UI", system-ui, sans-serif';

  var UI = {
    // 遮罩层
    dim: 0x04060f, dimAlpha: 0.88,
    // 模态面板
    panel: 0x0f162c, panelAlpha: 0.97, panelLine: 0xffffff, panelLineAlpha: 0.12, panelR: 18,
    // 面板内嵌卡片
    box: 0x121828, boxAlpha: 0.74, boxLine: 0xffffff, boxLineAlpha: 0.07, boxR: 10,
    // 血量条（轨道 / 渐变）
    // ⚠️ 轨道的两个 alpha 是"空槽看不看得见"的唯一决定因素：
    //    条没满的时候（狂怒尤其常见），玩家看到的只是左边那一段渐变，
    //    空槽太暗就等于"条只有那么长" —— 旁边的数值看上去就飘在空处，
    //    被当成"文字没贴着条"。0.06 / 0.50 实测在 #07070f 上几乎不可辨（≈ +14 灰阶），
    //    现在提到能读出一条完整槽位、又不抢填充色的程度。
    track: 0xffffff, trackAlpha: 0.12, trackBase: 0x05070f, trackBaseAlpha: 0.62,
    hpFrom: '#e86878', hpTo: '#f0d06a',
    heroFrom: '#5fd0a8', heroTo: '#73f0b4',
    shieldFrom: '#5fd0e0', shieldTo: '#9a8ef0',
    stamFrom: '#6fc8f0', stamTo: '#a8e6ff',
    // 语义文字色
    title: '#f0d06a', text: '#f0f4ff', sub: '#a8bce0', muted: '#6a7fa0',
    accent: '#5fd0e0', good: '#73f0b4', gold: '#f0d06a', danger: '#e86878',
    // 控件着色（Graphics / tint 用数值）
    cGhost: 0x5fd0e0, cPrimary: 0x73f0b4, cGold: 0xf0d06a, cDanger: 0xe86878, cPlain: 0xffffff,
    cStam: 0x6fc8f0, cPerfect: 0xffd76a,
    // 敌人层级色（与地图图例同源）
    tier: { normal: '#e8909c', elite: '#7ab8ff', mirror: '#c79aff', boss: '#ff8a7a' },
    tierHex: { normal: 0xe8909c, elite: 0x7ab8ff, mirror: 0xc79aff, boss: 0xff8a7a }
  };

  /** 圆角矩形路径（不依赖 ctx.roundRect，兼容旧引擎） */  function pathRoundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /**
   * 血条填充纹理（语义色横向渐变 + 圆角端点 + 顶部 1px 高光）
   * 纹理宽度向上取 8 的倍数，并按**显示宽度 1:1** 使用（显示尺寸是逻辑的、
   * 纹理是"逻辑 × 密度"像素，所以 scale 恒为 1/密度，圆角不会被横向拉伸）。
   * 名字里带密度：密度变了自然换一张，不会拿旧密度的纹理凑合。
   */
  function barTexture(scene, key, h, w, from, to) {
    var d = deviceDpr();
    var tw = Math.max(8, Math.ceil(w / 8) * 8);      // 逻辑宽度
    var pw = Math.round(tw * d), ph = Math.round(h * d);   // 纹理像素
    var name = 'rt_bar_' + key + '_' + h + '_' + tw + '_' + d;
    if (scene.textures.exists(name)) return name;
    var tex = scene.textures.createCanvas(name, pw, ph);
    var ctx = tex.getContext();
    var grad = ctx.createLinearGradient(0, 0, pw, 0);
    grad.addColorStop(0, from);
    grad.addColorStop(1, to);
    pathRoundRect(ctx, 0, 0, pw, ph, ph / 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(0, 0, pw, Math.max(1, Math.round(ph * 0.2)));
    ctx.globalCompositeOperation = 'source-over';
    tex.refresh();
    return name;
  }

  /** 血条轨道纹理：暗底 + 白 6% 槽 + 语义色 14% 细描边（对齐 .hp-bar） */
  function trackTexture(scene, h, w, tint) {
    var d = deviceDpr();
    var tw = Math.max(8, Math.ceil(w / 8) * 8);
    var pw = Math.round(tw * d), ph = Math.round(h * d);
    var name = 'rt_track_' + h + '_' + tw + '_' + tint.toString(16) + '_' + d;
    if (scene.textures.exists(name)) return name;
    var g = scene.make.graphics({ x: 0, y: 0 }, false);
    var r = Math.min(ph / 2, pw / 2);
    g.fillStyle(UI.trackBase, UI.trackBaseAlpha);
    g.fillRoundedRect(0, 0, pw, ph, r);
    g.fillStyle(UI.track, UI.trackAlpha);
    g.fillRoundedRect(0, 0, pw, ph, r);
    g.lineStyle(d, tint, 0.14);
    g.strokeRoundedRect(d / 2, d / 2, pw - d, ph - d, Math.max(0.5, r - d / 2));
    g.generateTexture(name, pw, ph);
    g.destroy();
    return name;
  }

  /** 柔和辉光纹理（白色，运行时 tint 着色）：替代 CSS 的 box-shadow 光晕 */
  function glowTexture(scene) {
    var name = 'rt_glow';
    if (scene.textures.exists(name)) return name;
    var size = 64;
    var tex = scene.textures.createCanvas(name, size, size);
    var ctx = tex.getContext();
    var grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.26)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    tex.refresh();
    return name;
  }

  /**
   * 被自定义布局缩放的文字 → 按目标尺寸重新栅格化
   * ------------------------------------------------------------
   * 用户反馈："自定义按键缩放：放大和缩小文字都会不清晰。"
   *
   * 原因：Phaser 的 Text 是**预渲染纹理** —— `setScale(s)` 只是把那固定分辨率的一张图
   * 拉大/压小，放得越大越糊（布局编辑器允许放到 250%）。
   * 修法：在**缩放变化时**同步提高 `resolution`，让文字按目标尺寸重新渲染一次。
   *   · 放大 → resolution 跟着上去，边缘重新变锐利；
   *   · 缩小 → 保持 ≥1（纹理缩小本身是清晰的；非整数缩放的线性过滤属于渲染层固有限制，
   *     那部分无法靠分辨率解决）；
   *   · 只在缩放**真的变了**时重建纹理（setResolution 会重新栅格化，不便宜），
   *     并且把值量化到 0.25 一档，避免同一尺寸反复重建。
   * `setResolution` 不改变显示尺寸（Phaser 会同步调整纹理与 size），所以
   * 依赖坐标的布局代码不受影响。
   */
  function sharpenScaledText(o, s) {
    if (!o || o.type !== 'Text' || typeof o.setResolution !== 'function') return;
    // 基准密度用**引擎的有效密度**（而不是裸的 devicePixelRatio）：
    // 文字最终是被投影放大 deviceDpr 倍画到屏幕上的，两个数必须是同一个口径。
    var res = Math.max(1, Math.min(4, s * deviceDpr()));
    res = Math.round(res * 4) / 4;
    if (o._layoutRes === res) return;
    o._layoutRes = res;
    o._textRes = res;          // 与 applyTextDensity 共用同一个"已设过"标记
    try { o.setResolution(res); } catch (e) { /* 忽略 */ }
  }

  /**
   * 这张图标纹理是不是"已经有一张了"
   * ------------------------------------------------------------
   * ⚠️ 刻意**不重建**：图标在场景创建时按当时的密度生成，之后密度就算变了也
   *    继续用旧的那张（略软），而不是在战斗中删掉纹理重画 —— 删纹理会把正在
   *    被引用的 frame 一起销毁，那一帧的按钮/遗物图标会变成未定义状态。
   *    显示尺寸一律是逻辑值，所以几何永远不会错，最差只是"没吃到新密度"。
   */
  function iconTextureReady(scene, name, logical, d) {
    if (!scene.textures.exists(name)) return false;
    var t = scene.textures.get(name);
    var img = (t && t.getSourceImage) ? t.getSourceImage() : null;
    if (img && d > 0 && Math.round(img.width) !== Math.round(logical * d)) {
      state._iconDensityStale = true;   // 诊断用：图标密度与当前密度不一致
    }
    return true;
  }

  /**
   * 画面控件图标（16×16 内绘制，1:1 显示，2px 笔宽，白色 → 运行时 tint）
   * 三个图标同一套笔宽与视觉重量：文字块 / 钱袋 / 出口
   */
  function ensureIconTextures(scene) {
    var defs = {
      text: function (g) {
        g.lineStyle(2, 0xffffff, 1);
        g.beginPath(); g.moveTo(2, 4); g.lineTo(14, 4); g.strokePath();
        g.beginPath(); g.moveTo(2, 8); g.lineTo(14, 8); g.strokePath();
        g.beginPath(); g.moveTo(2, 12); g.lineTo(10, 12); g.strokePath();
      },
      shop: function (g) {
        g.lineStyle(2, 0xffffff, 1);
        g.strokeRoundedRect(3, 7, 10, 7, 2);
        g.beginPath(); g.arc(8, 7, 3, Math.PI, 0, false); g.strokePath();
      },
      // 属性：仪表盘（上弧 + 两端刻度 + 指针 + 轴心）。
      // 刻意不用"三根递增竖条"——那已经是「难度」图标，而这里要的是"数值/状态"。
      // 两端那两根短刻度不是装饰：只有弧 + 指针时，缩小到 16px 会读成一张脸。
      stats: function (g) {
        g.lineStyle(2, 0xffffff, 1);
        g.beginPath(); g.arc(8, 9.6, 5.6, Math.PI, Math.PI * 2, false); g.strokePath();
        g.beginPath(); g.moveTo(2.8, 9.6); g.lineTo(4.4, 11.4); g.strokePath();
        g.beginPath(); g.moveTo(13.2, 9.6); g.lineTo(11.6, 11.4); g.strokePath();
        g.beginPath(); g.moveTo(8, 9.6); g.lineTo(10.4, 5.6); g.strokePath();
        g.fillStyle(0xffffff, 1);
        g.fillCircle(8, 9.6, 1.3);
      },
      quit: function (g) {
        g.lineStyle(2, 0xffffff, 1);
        g.beginPath(); g.moveTo(11.5, 3); g.lineTo(4, 3); g.lineTo(4, 13); g.lineTo(11.5, 13); g.strokePath();
        g.beginPath(); g.moveTo(8, 8); g.lineTo(15, 8); g.strokePath();
        g.fillStyle(0xffffff, 1);
        g.fillTriangle(11.5, 4.5, 15.5, 8, 11.5, 11.5);
      },
      // 技能：八芒星（与其它图标同一套笔宽）
      skill: function (g) {
        g.lineStyle(2, 0xffffff, 1);
        g.beginPath(); g.moveTo(8, 1); g.lineTo(8, 15); g.strokePath();
        g.beginPath(); g.moveTo(1, 8); g.lineTo(15, 8); g.strokePath();
        g.beginPath(); g.moveTo(4, 4); g.lineTo(12, 12); g.strokePath();
        g.beginPath(); g.moveTo(12, 4); g.lineTo(4, 12); g.strokePath();
      },
      // 图鉴：摊开的书（书脊 + 两页 + 文字行），与商店的"袋"、退出的"门"同笔宽
      codex: function (g) {        g.lineStyle(2, 0xffffff, 1);
        g.beginPath(); g.moveTo(8, 4); g.lineTo(8, 14); g.strokePath();
        g.beginPath(); g.moveTo(8, 4); g.lineTo(2, 3); g.lineTo(2, 13); g.lineTo(8, 14); g.strokePath();
        g.beginPath(); g.moveTo(8, 4); g.lineTo(14, 3); g.lineTo(14, 13); g.lineTo(8, 14); g.strokePath();
        g.lineStyle(1, 0xffffff, 0.75);
        g.beginPath(); g.moveTo(4, 6.5); g.lineTo(6.5, 7); g.strokePath();
        g.beginPath(); g.moveTo(4, 9.5); g.lineTo(6.5, 10); g.strokePath();
        g.beginPath(); g.moveTo(9.5, 7); g.lineTo(12, 6.5); g.strokePath();
        g.beginPath(); g.moveTo(9.5, 10); g.lineTo(12, 9.5); g.strokePath();
      },
      // ---------- 菜单（v2.8）：中枢那一套功能各要一颗图标 ----------
      // 全部沿用上面同一套规格：16×16 画布、2px 笔宽、白色描边（运行时 tint）。
      // 不用 emoji / Unicode 符号——它们在不同平台上的字形、基线、粗细都无法控制，
      // 一混进来整排图标的视觉重量就散了。
      menu: function (g) {
        // 方框 + 两横线：与 text 图标的「裸三横线」区分开（后者没有边框）
        g.lineStyle(2, 0xffffff, 1);
        g.strokeRoundedRect(2, 2, 12, 12, 3);
        g.beginPath(); g.moveTo(5, 6.4); g.lineTo(11, 6.4); g.strokePath();
        g.beginPath(); g.moveTo(5, 9.8); g.lineTo(11, 9.8); g.strokePath();
      },
      settings: function (g) {
        // 齿轮：内圈 + 八根短齿（齿长压到 2.2，留出描边余量不越 16×16）
        g.lineStyle(2, 0xffffff, 1);
        g.beginPath(); g.arc(8, 8, 3.6, 0, Math.PI * 2); g.strokePath();
        for (var i = 0; i < 8; i++) {
          var a = i * Math.PI / 4;
          g.beginPath();
          g.moveTo(8 + Math.cos(a) * 4.6, 8 + Math.sin(a) * 4.6);
          g.lineTo(8 + Math.cos(a) * 6.8, 8 + Math.sin(a) * 6.8);
          g.strokePath();
        }
      },
      cheat: function (g) {
        // 骰子「3」点面：作弊的语义一眼可读，且与其它图标的直线风格互补
        g.lineStyle(2, 0xffffff, 1);
        g.strokeRoundedRect(3, 3, 10, 10, 2);
        g.fillStyle(0xffffff, 1);
        g.fillCircle(5.8, 5.8, 1.15);
        g.fillCircle(8, 8, 1.15);
        g.fillCircle(10.2, 10.2, 1.15);
      },
      condition: function (g) {
        // 通关条件：旗杆 + 三角旗面
        g.lineStyle(2, 0xffffff, 1);
        g.beginPath(); g.moveTo(4, 2.5); g.lineTo(4, 13.5); g.strokePath();
        g.beginPath(); g.moveTo(4, 3.5); g.lineTo(12.5, 5.5); g.lineTo(4, 7.5); g.strokePath();
      },
      tutorial: function (g) {
        // 教程：问号（钩 + 竖 + 点）
        g.lineStyle(2, 0xffffff, 1);
        g.beginPath(); g.arc(8, 6, 3.2, Math.PI * 0.92, Math.PI * 2.32); g.strokePath();
        g.beginPath(); g.moveTo(8, 9.2); g.lineTo(8, 10.8); g.strokePath();
        g.fillStyle(0xffffff, 1);
        g.fillCircle(8, 13.1, 1.15);
      },
      save: function (g) {
        // 存档管理：软盘（切角外框 + 上方滑片 + 下方标签）
        g.lineStyle(2, 0xffffff, 1);
        g.beginPath();
        g.moveTo(3, 3); g.lineTo(11, 3); g.lineTo(13, 5); g.lineTo(13, 13); g.lineTo(3, 13);
        g.closePath(); g.strokePath();
        g.beginPath(); g.moveTo(6, 3); g.lineTo(6, 6.5); g.lineTo(10, 6.5); g.lineTo(10, 3); g.strokePath();
        g.beginPath(); g.moveTo(5, 13); g.lineTo(5, 9.5); g.lineTo(11, 9.5); g.lineTo(11, 13); g.strokePath();
      },
      legacy: function (g) {
        // 切换老版：两条反向箭头（一来一回）
        g.lineStyle(2, 0xffffff, 1);
        g.beginPath(); g.moveTo(4.5, 5.5); g.lineTo(12, 5.5); g.strokePath();
        g.beginPath(); g.moveTo(11.5, 10.5); g.lineTo(4, 10.5); g.strokePath();
        g.fillStyle(0xffffff, 1);
        g.fillTriangle(5, 3, 5, 8, 2, 5.5);
        g.fillTriangle(11, 8, 11, 13, 14, 10.5);
      },
      difficulty: function (g) {
        // 难度：三根递增竖条（低 → 高）
        g.lineStyle(2, 0xffffff, 1);
        g.beginPath(); g.moveTo(3.5, 13); g.lineTo(3.5, 9.5); g.strokePath();
        g.beginPath(); g.moveTo(8, 13); g.lineTo(8, 6.5); g.strokePath();
        g.beginPath(); g.moveTo(12.5, 13); g.lineTo(12.5, 3.5); g.strokePath();
      },
      power: function (g) {
        // 结束本局：电源符号（顶部留缺口的圆环 + 竖线）
        g.lineStyle(2, 0xffffff, 1);
        g.beginPath(); g.arc(8, 8.8, 5, -Math.PI / 3, Math.PI * 4 / 3, false); g.strokePath();
        g.beginPath(); g.moveTo(8, 2.4); g.lineTo(8, 8.4); g.strokePath();
      }
    };
    // 图标纹理按密度生成（16 逻辑像素的图形 → 16×d 像素的纹理）。
    // 显示端一律 setDisplaySize(逻辑尺寸)，所以布局完全不受影响，只是边缘变锐利。
    var d = deviceDpr();
    var g = null;
    Object.keys(defs).forEach(function (k) {
      var name = 'rt_ico_' + k;
      if (iconTextureReady(scene, name, 16, d)) return;
      if (!g) g = scene.make.graphics({ x: 0, y: 0 }, false);
      g.clear();
      g.setScale(d);                    // generateTexture 会把对象变换一起烘进纹理
      defs[k](g);
      g.generateTexture(name, 16 * d, 16 * d);
    });
    if (g) g.destroy();
  }

  // ============================================================
  //  遗物图标（v2.8.1）
  // ------------------------------------------------------------
  //  为什么要有这一套：2.7 把主画面换成 2D 画布之后，遗物在画面上**只剩一个数字**
  //  （菜单里「遗物 N 件」）。而 26 件遗物分四流派、同派互相放大，是这一版构筑的
  //  核心 —— 玩家看不见自己拿了什么、在凑哪一套，构筑这件事就不成立了。
  //
  //  设计约束（三条，都是为了让图标条不变成一撮噪点）：
  //   1) **符号只表达效果，颜色只表达流派**。符号一律用白色描边 + 运行时 tint，
  //      与 rt_ico_* 那 16 个按钮图标同一支笔（16×16 画布 / 2px 主笔宽），
  //      所以它们看上去是同一套东西，而不是贴上去的另一套素材。
  //   2) 外圈 1px 色环 + 内圈 8% 同色薄涂：色相是"我正在凑哪一套"在画面上的
  //      唯一载体，色环让它在外圈成一条连续的弧 —— 一排看过去先看到的是色带。
  //   3) 通用（无流派）用中性灰：它不参与成套，就不该抢流派的视觉位。
  //
  //  符号全部用"能读出来的做法"而不是抽象图形（镰刀就是镰刀、砖墙就是砖墙）：
  //  图标只有 16px，抽象图形在这个尺寸下必然退化成点。
  // ============================================================

  /** 遗物流派色（色相分离优先：玫红 / 金 / 绿 / 紫，通用为中性灰） */
  var SCHOOL_COLOR = {
    blood:   0xff5a7a,   // 血怒：残血换输出
    perfect: 0xf0d06a,   // 完美：判定窗口与判定收益
    link:    0x73f0b4,   // 连携：新资源（攒 → 选 → 险）
    greed:   0xb07ae0,   // 贪婪：收益换风险
    '':      0x8f97ad    // 通用
  };
  var SCHOOL_LABEL = { blood: '血怒', perfect: '完美', link: '连携', greed: '贪婪', '': '通用' };
  /** 流派色转 CSS 色串（文字用 —— Phaser 的 Text 只吃字符串色） */
  function schoolCss(school) {
    return '#' + ('000000' + (SCHOOL_COLOR[school] || SCHOOL_COLOR['']).toString(16)).slice(-6);
  }

  /**
   * 遗物符号绘制上下文
   * ------------------------------------------------------------
   * 符号一律画在**中心坐标系**里（0,0 = 圆心，半径约 6.9 给人眼留白）。
   * 直接写 16×16 绝对坐标的话，每改一次环的粗细就要把所有符号重算一遍。
   *   move/line：抬笔 / 画线（不含落笔，连续调用即折线）
   *   ring/arc ：整圆 / 弧
   *   dot      ：实心圆点
   *   tri      ：实心三角
   *   w        ：改笔画粗细（主笔 1.7，细节 1.15 —— 副笔太粗会在 16px 里糊成一团）
   */
  function relicPen(g) {
    // 当前笔宽自己记一份：dot/tri 会把 lineStyle 换成填充色，填完必须还回来 ——
    // 否则「先点一个点、再描一条线」的符号里，那条线会用填充残留的状态画出来
    var lw = 1.7;
    var api = {
      w: function (n) { lw = (n == null ? 1.7 : n); g.lineStyle(lw, 0xffffff, 1); return api; },
      move: function (x, y) { g.beginPath(); g.moveTo(8 + x, 8 + y); return api; },
      line: function (x, y) { g.lineTo(8 + x, 8 + y); g.strokePath(); return api; },
      // 折线一气呵成（只描一次边）：line 连打会在每个转折点留下加粗的接头
      poly: function (pts, close) {
        g.beginPath();
        for (var i = 0; i < pts.length; i++) {
          if (i === 0) g.moveTo(8 + pts[i][0], 8 + pts[i][1]);
          else g.lineTo(8 + pts[i][0], 8 + pts[i][1]);
        }
        if (close) g.closePath();
        g.strokePath();
        return api;
      },
      ring: function (r, a0, a1) { g.beginPath(); g.arc(8, 8, r, a0, a1, false); g.strokePath(); return api; },
      dot: function (x, y, r) {
        g.fillStyle(0xffffff, 1);
        g.fillCircle(8 + x, 8 + y, r == null ? 1.2 : r);
        g.lineStyle(lw, 0xffffff, 1);   // 还笔：见 lw 的说明
        return api;
      },
      tri: function (x1, y1, x2, y2, x3, y3) {
        g.fillStyle(0xffffff, 1);
        g.fillTriangle(8 + x1, 8 + y1, 8 + x2, 8 + y2, 8 + x3, 8 + y3);
        g.lineStyle(lw, 0xffffff, 1);   // 还笔
        return api;
      }
    };
    return api;
  }

  /**
   * 26 件遗物的符号 + 静态定义
   * ------------------------------------------------------------
   * ⚠️ label / quality / school / desc 与 经典2D.js 的 RELIC_POOL **逐字同源**。
   *    遗物详情的文案与图鉴说的是同一件事（改数值不会让界面说谎）。
   *    这里留一份只读副本的原因：宿主 setRelics() 只下发 id 列表，
   *    画布内拿不到 label 与 desc —— 而详情卡片恰恰只显示这两样。
   *    副本一旦与 RELIC_POOL 不同步，遗物条就会显示错名字，
   *    所以下面这段的每个字段都必须照着 RELIC_POOL 抄，不要在这里另写文案。
   *    （顺序无关，按 id 查表；新增遗物时两处一起加。）
   */
  var RELIC_VIS = {
    // ===== 血怒流：主动掉血换输出 =====
    desperateStrike: { label: '破釜沉舟', quality: 'rare', school: 'blood', desc: '每损失 10% 生命，伤害 +7%（残血最多 +56%）· 与血之饥渴、荆棘之心成套',
      // 破盾：**盾牌轮廓本身保留完整**，只在中线切一道锯齿裂痕 ——
      // 试过"真的把轮廓也撕开"，结果盾牌在 16px 下认不出来了。
      // 可辨识优先于字面准确：先看得出是盾，再看出它裂了。
      draw: function (p) { p.w(1.7).poly([[-5.2, -3.0], [-5.2, 1.2], [0, 5.6], [5.2, 1.2], [5.2, -3.0], [0, -6.0]], true); p.w(1.15).poly([[0, -6.0], [-1.8, -2.2], [1.8, 0.4], [-1.8, 3.0], [0, 5.6]], false); }},
    bloodThirst: { label: '血之饥渴', quality: 'rare', school: 'blood', desc: '吸血等级 +1；生命 ≤50% 时吸血翻倍',
      draw: function (p) { p.w(1.7).poly([[0, -6.2], [3.6, 0.2], [3.6, 1.8]], false); p.move(0, -6.2).line(-3.6, 0.2); p.poly([[-3.6, 0.2], [-3.6, 2.0]], false); p.ring(2.5, 0.16, Math.PI - 0.16); p.w(1.15).dot(0, 1.3, 1.35); }},
    thornHeart: { label: '荆棘之心', quality: 'rare', school: 'blood', desc: '被命中反弹 +3；生命 ≤50% 时反伤翻倍',
      draw: function (p) { p.w(1.7).ring(4.7, 0, Math.PI * 2); for (var i = 0; i < 8; i++) { var a = i * Math.PI / 4 + Math.PI / 8; p.move(Math.cos(a) * 4.7, Math.sin(a) * 4.7).line(Math.cos(a) * 6.9, Math.sin(a) * 6.9); } p.w(1.15).dot(0, 0, 1.9); }},
    furyBlood: { label: '狂热之血', quality: 'common', school: 'blood', desc: '狂怒获取 +35%；生命 ≤50% 时再 +35%',
      draw: function (p) { p.w(1.7).ring(5.0, Math.PI * 0.72, Math.PI * 2.28); p.poly([[0, -1.0], [3.2, -5.4], [3.6, 0.2]], true); p.w(1.15).move(-3.2, 4.6).line(3.2, 4.6); }},
    immortalTotem: { label: '不朽图腾', quality: 'legendary', school: 'blood', desc: '致命伤保留 1 血（每层一次）· 敢残血作战的前提',
      draw: function (p) { p.w(1.7).poly([[-3.2, -6.0], [3.2, -6.0], [4.8, 3.4], [-4.8, 3.4]], true); p.w(1.15).move(-2.0, -1.4).line(2.0, -1.4); p.move(-2.4, 0.8).line(2.4, 0.8); p.move(-5.8, 5.4).line(5.8, 5.4); }},
    soulDrinker: { label: '汲魂者', quality: 'common', school: 'blood', desc: '击杀回复 2 生命；生命 ≤50% 时回复 4',
      // 击杀回血：用「被吸上来的一缕魂」而不是第二颗血滴 ——
      // 血滴已经给了「血之饥渴」，两件遗物同一个符号在条上就分不出来了
      draw: function (p) { p.w(1.7).poly([[-4.4, 6.0], [-4.4, 2.0], [-1.6, -1.0], [1.6, -3.6], [4.4, -5.4]], false); p.w(1.15).poly([[-1.4, 6.0], [-1.4, 3.0], [0.6, 0.6], [3.0, -1.4]], false); p.move(3.2, -2.6).line(4.6, -4.0); }},

    // ===== 完美流：判定窗口与判定收益 =====
    perfectInstinct: { label: '完美直觉', quality: 'rare', school: 'perfect', desc: '完美闪避窗口 +80ms，锐利持续 +2s',
      draw: function (p) { p.w(1.7).ring(5.4, 0, Math.PI * 2); p.w(1.15).ring(2.2, 0, Math.PI * 2); p.dot(0, 0, 1.25); p.w(1.7).move(-6.9, 0).line(-5.6, 0); p.move(6.9, 0).line(5.6, 0); p.move(0, -6.9).line(0, -5.6); p.move(0, 6.9).line(0, 5.6); }},
    ironWall: { label: '铁壁', quality: 'common', school: 'perfect', desc: '完美格挡窗口 +80ms',
      draw: function (p) { p.w(1.7).poly([[-5.4, -4.2], [5.4, -4.2], [5.4, 1.0], [0, 5.8], [-5.4, 1.0]], true); p.w(1.15).move(-5.4, -0.8).line(5.4, -0.8); p.move(-1.8, -3.4).line(-1.8, -1.6); p.move(1.8, -3.4).line(1.8, -1.6); p.move(-3.4, 1.6).line(-3.4, 3.0); }},
    counterBlade: { label: '反击之刃', quality: 'rare', school: 'perfect', desc: '盾反伤害 ×2 → ×3，盾反回 3 护盾',
      draw: function (p) { p.w(1.7).poly([[-5.0, 5.0], [2.2, -2.2], [4.6, -4.6]], false); p.w(1.15).move(-5.0, 5.0).line(-2.6, 4.0); p.move(-5.0, 5.0).line(-4.0, 2.6); p.w(1.7).poly([[1.0, -4.6], [4.6, -4.6], [4.6, -1.0]], false); }},
    sharpCore: { label: '锐利核心', quality: 'legendary', school: 'perfect', desc: '完美闪避的锐利倍率 2.2 → 3.0',
      draw: function (p) { p.w(1.7).poly([[0, -6.4], [1.9, -1.9], [6.4, 0], [1.9, 1.9], [0, 6.4], [-1.9, 1.9], [-6.4, 0], [-1.9, -1.9]], true); p.w(1.15).dot(0, 0, 1.2); }},
    windShadow: { label: '疾风残影', quality: 'rare', school: 'perfect', desc: '闪避无敌帧 +120ms，冲刺距离 +15%',
      draw: function (p) { p.w(1.7).ring(4.6, -Math.PI * 0.42, Math.PI * 0.42); p.poly([[-1.4, -2.8], [3.0, 0], [-1.4, 2.8]], true); p.w(1.15).ring(6.6, -Math.PI * 0.30, Math.PI * 0.30); }},

    // ===== 连携流：新资源的三个旋钮 =====
    linkHeart: { label: '连携之心', quality: 'rare', school: 'link', desc: '连携上限 3 → 5，能一口气攒更多',
      draw: function (p) { p.w(1.7).poly([[0, -6.4], [3.0, -3.2], [0, 0], [-3.0, -3.2]], true); p.poly([[0, 0], [3.0, 3.2], [0, 6.4], [-3.0, 3.2]], true); p.w(1.15).dot(0, 0, 1.05); }},
    unbroken: { label: '不屈意志', quality: 'legendary', school: 'link', desc: '挨打时连携只 −1 而非清零 · 与连携之心成套',
      draw: function (p) { p.w(1.7).poly([[-2.2, -6.4], [1.8, -2.0], [-1.2, 1.2], [2.2, 6.4]], false); p.w(1.15).poly([[-4.8, -6.4], [-4.8, -2.4], [-3.0, -0.6]], false); p.poly([[4.8, 6.4], [4.8, 2.4], [3.0, 0.6]], false); }},
    echoMaster: { label: '回响精通', quality: 'rare', school: 'link', desc: '连携招式倍率 1.6 → 2.2',
      draw: function (p) { p.w(1.15).dot(-4.2, 0, 1.3); p.w(1.7).ring(2.8, -Math.PI * 0.58, Math.PI * 0.58); p.ring(5.4, -Math.PI * 0.52, Math.PI * 0.52); }},
    executioner: { label: '处决者', quality: 'rare', school: 'link', desc: '斩杀线 +10%；斩杀成功回 1 连携',
      draw: function (p) { p.w(1.7).poly([[-4.8, 6.2], [3.0, 0.6]], false); p.move(-2.6, 2.6).line(-0.4, 4.4); p.w(1.15).ring(4.0, -2.5, -0.6); p.w(1.7).move(5.2, -6.2).line(5.2, -3.4); }},
    heavyStrike: { label: '重击', quality: 'common', school: 'link', desc: '跳劈 +0.4 倍、埋人 +12%；跳劈消耗连携时倍率再 +0.6',
      draw: function (p) { p.w(1.7).poly([[1.0, -6.4], [5.0, -3.0], [1.0, 0.4]], true); p.move(1.0, -3.0).line(-2.4, 0.6); p.w(1.15).move(-4.4, 2.2).line(-1.0, 2.2); p.move(-5.4, 4.4).line(0.6, 4.4); p.w(1.7).dot(3.6, 3.6, 1.5); },
      // 坠星（远程）：**一条竖落的轨迹 + 底部放射**（"砸下来会溅开"），
      // 和重击的"箭头 + 两道横线"区分开 —— 横线读作"重"，放射线读作"溅射"
      variants: {
        ranged: { label: '坠星', desc: '空中射击伤害 +0.4 倍，命中溅射 40px',
          draw: function (p) {
            p.w(1.7).poly([[0.8, -6.4], [0.8, 0.6]], false);
            p.tri(0.8, 3.4, -1.8, 0.4, 3.4, 0.4);
            p.w(1.15).poly([[-5.6, 5.4], [-2.6, 3.4]], false);
            p.poly([[0.8, 6.0], [0.8, 4.4]], false);
            p.poly([[5.8, 4.2], [3.0, 3.0]], false);
          } }
      }},

    // ===== 贪婪流：收益换风险 =====
    greedyHeart: { label: '贪婪之心', quality: 'rare', school: 'greed', desc: '金币获取 +60%；受到的伤害 +20%',
      draw: function (p) { p.w(1.7).ring(5.4, 0, Math.PI * 2); p.w(1.15).ring(3.1, 0, Math.PI * 2); p.w(1.7).dot(0, 0, 1.4); }},
    merchantEye: { label: '商人眼光', quality: 'common', school: 'greed', desc: '商店价格 −25%',
      draw: function (p) { p.w(1.7).poly([[-6.4, 0], [-3.4, -3.0], [3.4, -3.0], [6.4, 0], [3.4, 3.0], [-3.4, 3.0]], true); p.w(1.15).ring(1.9, 0, Math.PI * 2); p.dot(0, 0, 0.95); }},
    fateWheel: { label: '命运轮盘', quality: 'legendary', school: 'greed', desc: '每清一个房间随机 +2~8 金币 或 −1 生命',
      draw: function (p) { p.w(1.7).ring(5.6, 0, Math.PI * 2); for (var i = 0; i < 6; i++) { var a = i * Math.PI / 3; p.move(Math.cos(a) * 2.2, Math.sin(a) * 2.2).line(Math.cos(a) * 5.6, Math.sin(a) * 5.6); } p.w(1.15).ring(2.2, 0, Math.PI * 2); }},

    // ===== 通用：不参与成套，用中性灰 =====
    lightBoots: { label: '轻盈之靴', quality: 'common', school: '', desc: '体力上限 +30，停手回复 +30%',
      draw: function (p) { p.w(1.7).poly([[-5.6, -2.2], [0.0, -5.0], [5.6, -2.2], [0.0, 0.6]], true); p.w(1.15).poly([[-4.8, 0.6], [0.0, 3.4], [4.8, 0.6]], false); p.poly([[-3.6, 3.0], [0.0, 5.4], [3.6, 3.0]], false); }},
    airFeather: { label: '滞空之羽', quality: 'rare', school: '', desc: '空中闪避保留的坠速更小，且不消耗体力',
      draw: function (p) { p.w(1.7).poly([[3.0, 5.4], [3.6, -1.4], [0.0, -5.6], [-3.2, -1.6], [-2.6, 5.4]], true); p.w(1.15).dot(0.2, -2.8, 1.05); }},
    shieldResonance: { label: '护盾共鸣', quality: 'common', school: '', desc: '任何来源获得的护盾 +2；完美格挡额外 +3',
      draw: function (p) { p.w(1.7).poly([[0, -6.2], [4.2, -3.2], [4.2, 1.2], [0, 4.8], [-4.2, 1.2], [-4.2, -3.2]], true); p.w(1.15).ring(1.6, 0, Math.PI * 2); p.dot(0, 0, 1.05); }},
    chainMaster: { label: '连击大师', quality: 'rare', school: '', desc: '连招窗口 +250ms，第 3 段横扫 +50%',
      draw: function (p) { p.w(1.7).move(-5.8, 1.2).line(5.8, 1.2); p.w(1.15).move(-5.8, -3.6).line(2.2, -3.6); p.move(-5.8, 6.0).line(4.6, 6.0); },
      // 连珠（远程）：**三点成串 + 侧面一道速度弧**（点读作"弹"，横线才读作"段"）
      variants: {
        ranged: { label: '连珠', desc: '连射间隔 −12%，每第 3 发伤害 +50%',
          draw: function (p) {
            p.w(1.7).dot(-4.8, 0.2, 1.30);
            p.dot(-2.0, 0.2, 1.30);
            p.dot(0.8, 0.2, 1.30);
            p.w(1.15).ring(4.8, -Math.PI * 0.30, Math.PI * 0.30);
          } }
      }},
    huntMark: { label: '猎杀标记', quality: 'legendary', school: '', desc: '斩杀线提升至 50%',
      draw: function (p) { p.w(1.7).ring(4.6, 0, Math.PI * 2); p.move(-6.9, 0).line(-3.2, 0); p.move(6.9, 0).line(3.2, 0); p.move(0, -6.9).line(0, -3.2); p.move(0, 6.9).line(0, 3.2); p.w(1.15).dot(0, 0, 1.5); }},
    trackingCharm: { label: '觅隙', quality: 'rare', school: '', desc: '挥砍自动朝最近敌人偏转 12°，判定宽度 +6px',
      // 觅隙（近战）：**一道斜刃 + 分离的刃尖**（会自己找过去）。
      // 与追踪符的弧线刻意相反：直线读作"斩"，弧线才读作"拐弯的弹道"。
      // 第一版加过护手，16px 下和刃身糊成一条斜杠 —— 删掉，只留刃与尖。
      draw: function (p) {
        p.w(1.7).poly([[5.0, -6.0], [-0.6, 1.4]], false);
        p.w(1.15).poly([[-0.6, 1.4], [-0.6, 2.6]], false);
        p.tri(-0.6, 5.4, -3.0, 2.2, 1.8, 2.2);
      },
      variants: {
        ranged: { label: '追踪符', desc: '远程普攻追踪 +50%，弹速 +10%',
          // 追踪符：一道**指向的弧** + 箭头（弹道会拐弯去追目标）
          draw: function (p) { p.w(1.7).ring(5.2, -Math.PI * 0.78, Math.PI * 0.78); p.tri(4.6, 0, 1.0, -2.2, 1.0, 2.2); p.w(1.15).dot(-1.6, 0, 1.15); } }
      }},
    piercingArrow: { label: '裂阵', quality: 'rare', school: '', desc: '第 3 段横扫多命中 1 个目标',
      // 裂阵（近战）：**三道竖列被同一条斜线齐齐切开** —— 阵型裂了，多一个人被扫到。
      // 切口的 y 随 x 线性变化，断点连起来就是那道斜劈（比"画一条斜线压过去"更干净：
      // 压过去的第一版在 16px 下变成了 Σ）。
      draw: function (p) {
        // 两道竖列（各被斜切一个缺口）+ 一道穿过缺口的斜劈。
        // 只留两条是对的：三条在 16px 下会连成一个「H」，读不出"裂"。
        var xs = [-4.4, 4.4];
        for (var i = 0; i < xs.length; i++) {
          var x = xs[i], cut = -x * 0.70;
          p.w(1.6).poly([[x, -6.0], [x, cut - 1.5]], false);
          p.poly([[x, cut + 1.5], [x, 6.0]], false);
        }
        p.w(1.15).poly([[-4.4, 3.08], [4.4, -3.08]], false);
      },
      variants: {
        ranged: { label: '穿透之矢', desc: '远程普攻穿透 +1',
          draw: function (p) { p.w(1.7).move(-5.4, 0).line(3.6, 0); p.w(1.15).poly([[3.6, -3.0], [6.6, 0], [3.6, 3.0]], true); p.w(1.7).move(-5.4, -3.0).line(-2.0, 0); p.move(-5.4, 3.0).line(-2.0, 0); } }
      }},
    abyssMark: { label: '深渊印记', quality: 'rare', school: '', desc: '遗物三选一变四选一',
      draw: function (p) { p.w(1.7).dot(0, -4.4, 1.5); p.w(1.15).dot(-4.4, 2.6, 1.5); p.dot(4.4, 2.6, 1.5); p.w(1.7).ring(6.6, 0, Math.PI * 2); }}
  };

  /** 取一件遗物的视觉定义（id 不认识时给一个中性的兜底，绝不返回 undefined） */
  var RELIC_FALLBACK = {
    label: '未知遗物', quality: 'common', school: '',
    desc: '这件遗物不在图标表里 —— 请对照图鉴确认它的效果。',
    draw: function (p) { p.w(1.7).ring(5.4, 0, Math.PI * 2); p.w(1.15).dot(0, -2.0, 1.2); p.move(0, 0.6).line(0, 4.0); }
  };

  /** 当前英雄的武器口径（双套遗物用；没有场景时按近战算） */
  function currentWeaponKind() {
    var sc = state.scene;
    try { return (sc && sc.heroRanged && sc.heroRanged()) ? 'ranged' : 'melee'; } catch (e) { return 'melee'; }
  }

  /**
   * 取一件遗物的视觉定义（id 不认识时给一个中性的兜底，绝不返回 undefined）
   * 2.9.2 F7：4 件双套遗物有 variants，没传 weapon 时按当前英雄取 ——
   * 图标、名字、描述三样必须同源，否则会出现"图标是觅隙、名字是追踪符"。
   */
  function relicVis(id, weapon) {
    var v = RELIC_VIS[id];
    if (!v) return RELIC_FALLBACK;
    if (!v.variants) return v;
    var ov = v.variants[weapon || currentWeaponKind()];
    if (!ov) return v;
    var out = {};
    for (var k in v) out[k] = v[k];
    for (var k2 in ov) out[k2] = ov[k2];
    return out;
  }

  /** 遗物图标纹理键（双套遗物有两张纹理：@m 近战 / @r 远程） */
  function relicTexKey(id, weapon) {
    var v = RELIC_VIS[id];
    if (!v) return null;
    if (!v.variants) return 'rt_rl_' + id;
    return 'rt_rl_' + id + '@' + ((weapon || currentWeaponKind()) === 'ranged' ? 'r' : 'm');
  }

  /**
   * 生成遗物图标纹理（白色符号 + 流派色环）
   * ------------------------------------------------------------
   * 一次把 26 件全画出来（每张 16×16，共约 26 KB 显存），不做按需：
   * 玩家随时可能拿到任意一件，而"拿到的那一刻"正是最需要看清楚的时候，
   * 那时再去生成纹理就是一次可感知的卡顿。
   * 形状变化（被布局编辑器缩放）不重新生成 —— 16→22px 的放大靠纹理过滤即可。
   * 2.9.2：双套遗物两套都画（多 4 张，代价可忽略），换英雄时无需重建纹理。
   */
  function ensureRelicTextures(scene, g) {
    var made = 0;
    var d = deviceDpr();
    function drawOne(name, vis, id) {
      if (iconTextureReady(scene, name, 16, d)) return;
      if (!g) g = scene.make.graphics({ x: 0, y: 0 }, false);
      g.clear();
      g.setScale(d);                   // 与 rt_ico_* 同一套做法：纹理按密度生成
      // 内圈：流派色薄涂（8%）
      var tint = SCHOOL_COLOR[vis.school] || SCHOOL_COLOR[''];
      g.fillStyle(tint, 0.08);
      g.fillCircle(8, 8, 7.0);
      // 符号：白色，运行时按状态 tint。
      // ⚠️ 每件遗物用一个**独立的笔**：笔宽是笔自己的状态（见 relicPen 的 lw），
      //    共用一支笔会让上一件遗物留下的线宽串到下一件上去。
      try { vis.draw(relicPen(g)); } catch (e) { console.warn('[战斗2D] 遗物图标绘制失败：' + id, e); }
      // 色环：1px，画在符号之后（压住越界的笔画端点，不让符号糊出圆外）
      g.lineStyle(1, tint, 0.92);
      g.strokeCircle(8, 8, 7.0);
      g.generateTexture(name, 16 * d, 16 * d);
      made++;
    }
    Object.keys(RELIC_VIS).forEach(function (id) {
      var v = RELIC_VIS[id];
      if (v.variants) {
        ['melee', 'ranged'].forEach(function (w) {
          drawOne(relicTexKey(id, w), relicVis(id, w), id);
        });
      } else {
        drawOne('rt_rl_' + id, v, id);
      }
    });
    if (g && made) g.destroy();
    return made;
  }

  /**
   * 全局字体修正
   * Phaser 的 Text 默认字体是 Courier，与主界面的微软雅黑不一致（数字尤其突兀）。
   * 这里给工厂方法统一补上 fontFamily，避免逐个文本样式手写。
   */
  function installFontDefault() {
    if (typeof Phaser === 'undefined' || !Phaser.GameObjects) return;
    var protos = [Phaser.GameObjects.GameObjectFactory, Phaser.GameObjects.GameObjectCreator];
    protos.forEach(function (ctor) {
      if (!ctor || !ctor.prototype || typeof ctor.prototype.text !== 'function') return;
      var proto = ctor.prototype;
      if (proto.__dshFontPatched) return;
      var orig = proto.text;
      proto.text = function (x, y, text, style) {
        var s = {};
        if (style) { for (var k in style) { s[k] = style[k]; } }
        if (!s.fontFamily) s.fontFamily = FONT;
        // 高密度屏：新建的文字直接按当前密度栅格化（见 applyTextDensity 的说明）。
        // 密度变了由 applyTextDensity 统一补，这里只负责"开局就对"。
        if (!s.resolution) s.resolution = deviceDpr();
        return orig.call(this, x, y, text, s);
      };
      proto.__dshFontPatched = true;
    });
  }

  // ============================================================
  //  战斗场景
  // ============================================================
  class BattleScene extends Phaser.Scene {
    constructor() { super({ key: 'TrialBattle' }); }

    create() {
      state.scene = this;
      this.ready = false;
      this.floor = 0;
      this.points = 0;
      this.enemies = [];
      this.projectiles = [];
      this.shots = [];          // 主角的远程弹丸（箭矢 / 奥术弹 / 灵能波）
      this.groundTiles = [];
      this.groundStrips = [];       // v2.9 P3：地面分段视觉（平厅 1 条 / 断桥 2~3 条）
      this.groundSegments = [];     // v2.9 P3：地面分段区间（坠落传送用）
      this.platformTiles = [];
      this.platformStrips = [];
      this.platformDecor = [];      // 2.9.1 F1：平台附属视觉（上层支撑柱 / 侧壁）
      // ===== 2.9 P0：骨架 / 目标（都是"每房间重算"的临时状态） =====
      this.roomSkeleton = null;    // 本房间抽中的骨架：flat / double / bridge
      this.platformSpots = [];     // 本房间平台摆位（调试 / 分布统计）
      this.roomObjective = null;   // 统一房间目标 { type, need, got, done }
      this._terrainParams = null;  // 最近一次骨架参数快照（调试）
      this._flatLayout = null;     // 最近一次平厅布局（含高度上下限，调试）
      this.skeletonParts = [];     // P3 骨架的附属对象（上层地板 / 遮罩等）
      // ===== 2.9 P1：单向平台 / 加速下坠 / 读条拾取 =====
      this._platformPass = false;  // 是否正在"穿过单向平台"（加速下坠）
      this._hurtAt = 0;            // 最近一次真正受伤的时间（读条打断用）
      // ===== 2.9 P4：机制房（调试单房间 / 塌陷 / 守点 / 限时） =====
      this.collapse = null;
      this.holdZone = null;
      this.timedRoom = null;
      this._forceSkeleton = null;  // 调试：强制指定骨架（不走抽签）
      this._noPlatforms = false;   // 无浮台变体（塌陷房专用）
      this._roomMechanic = null;   // 本房间挂载的机制
      this._floorMechanicCount = 0; // 本层已出现的机制房数（每层保底用）
      this._floorMechanicKinds = {}; // 本层已出现过的机制种类（保底时优先没出现过的）
      this.mechanicEnabled = { collapse: true, hold: true, timed: true };
      this.previewMode = false;    // 调试单房间：走进传送门 = 完成一局（不打开地图）
      this.previewEnded = false;
      this.collapseRecords = [];   // 塌陷回廊的每局记录（预览页导出 / 验收）
      this.boss = null;
      this.attacking = false;
      this.attackHits = {};
      this.running = false;
      this.portalOpen = false;
      this.comboCount = 0;
      this.comboTimer = 0;

      // 房间地图状态
      this.floorMap = null;      // 当前层地图（节点 + 连线）
      this.roomNode = null;      // 当前所在房间
      this.mapOpen = false;      // 地图界面是否打开（打开时物理与战斗逻辑暂停）
      this.roomGoal = null;      // 宝箱 / 祭坛等非战斗房间的目标
      this.difficulty = 'normal';
      this.env = ENV_THEMES.normal;

      // 画面内界面状态（死亡 / 商店 / 确认框）
      this.shopOpen = false;
      this.shopLayer = null;
      this.shopTab = 0;
      this.shopPage = 0;
      this.shopData = null;
      this.deathOpen = false;
      this.deathLayer = null;
      this.confirmOpen = false;
      this.confirmLayer = null;
      this.pendingMapAfterShop = false;
      this._finished = false;
      this._pausedForShop = false;

      // 战绩（死亡结算显示）
      this.kills = 0;
      this.roomsCleared = 0;
      this.runStartedAt = 0;

      // 跳劈状态
      this.diving = false;
      this.diveHits = {};
      this.diveReadyAt = 0;
      this.diveFx = null;

      // 界面按钮命中区（画面坐标，随窗口重排）
      this.hudButtons = [];
      this.panelButtons = { confirm: [], shop: [], death: [], map: [], choice: [], pause: [], relic: [], relicStats: [] };
      this.shopItemRects = [];
      this.nearestEnemy = null;
      this._viewPaused = false;
      this._pausedForConfirm = false;
      // ===== 遗物条与遗物详情（v2.8.1）=====
      this.relicStrip = null;          // 血条下方的常驻图标行
      this.relicStripIcons = [];
      this.relicRects = [];            // 遗物条命中区
      this._relicStripVisible = false;
      this.relicOpen = false;          // 遗物详情卡片是否打开
      this.relicView = 'list';         // 'list' | 'stats'
      this.relicPage = 0;
      this.relicPageCount = 1;
      this.relicRects2 = [];           // 详情卡片内的列表命中区（暂未做点击，留给后续）
      this.relicLayer = null;
      this.relicStatsLayer = null;
      this._pausedForRelic = false;
      this.hudDensity = 'auto';        // 由设置写入：auto / full / compact / minimal

      // 对象池：飘字文本复用（性能优化，长时间战斗不产生垃圾）
      this.floatPool = [];
      this.floats = [];

      buildTextures(this);
      this.buildAnimations();
      this.buildBackground();

      // HUD 密度：从已保存的设置里读一次（buildHud 会按它决定遗物条与属性面板的取舍）。
      // 之后设置面板每次改动都会经 API.setSettings → applyHudDensity 实时推过来。
      this.hudDensity = (state.settings && state.settings.hudDensity) || 'auto';

      // 物理分组：静态地形 + 敌人组（碰撞器只需建立一次）
      this.solids = this.physics.add.staticGroup();
      this.enemyGroup = this.physics.add.group();

      this.buildHero();
      this.buildHud();
      this.buildInput();

      // 碰撞：主角与敌人都会站在地形上
      this.physics.add.collider(this.hero, this.solids);
      this.physics.add.collider(this.enemyGroup, this.solids);
      // 主角与敌人互相阻挡（不可穿过身体）。
      // 留一个引用：跳劈下坠期间要临时关掉它（见 tryDiveAttack），不然英雄会把敌人
      // 一帧一帧地挤进地面里去。
      // v2.9 P2：碰撞回调承担「踩头弹跳」——从上方砸到敌人头顶时弹起并重置空中攻击。
      this._heroEnemyCollider = this.physics.add.collider(this.hero, this.enemyGroup,
        this.onHeroEnemyContact, null, this);

      this.scale.on('resize', this.onResize, this);

      // HUD 文字按当前密度栅格化一次（新建的文字由 installFontDefault 的工厂补丁
      // 直接带上 resolution，这里补的是 buildHud 过程中已经建好的那一批）。
      applyTextDensity(this.children.list);
      state._dprDirty = false;

      this.ready = true;
      console.log('[战斗2D] 战斗场景就绪（横版实时战斗）');

      if (state.pendingStart) {
        var d = state.pendingStart;
        state.pendingStart = null;
        this.beginRun(d);
      }
    }

    buildAnimations() {
      // 角色动画按需注册：英雄在 setHeroLook（随英雄形象重建），怪物在 spawnEnemy（按怪物类型）
      this.setHeroLook(this.heroLookId || 'warrior');
    }

    /** 切换英雄形象：精灵表 + 动画一起按该英雄的专属纹理重建（动画 key 不变，play 调用点无需改动） */
    setHeroLook(id) {
      var A = 角色形象;
      if (!A || !A.LOOKS[id] || A.LOOKS[id].kind !== 'hero') id = 'warrior';
      this.heroLookId = id;
      var tex = A.ensureHeroTexture(this, id);
      if (this.hero) this.hero.setTexture(tex);
      this.buildHeroAnims(tex);
      return tex;
    }

    buildHeroAnims(tex) {
      var self = this;
      var mk = function (key, frames, rate, repeat) {
        if (self.anims.exists(key)) self.anims.remove(key);
        self.anims.create({ key: key, frames: self.anims.generateFrameNumbers(tex, { frames: frames }), frameRate: rate, repeat: repeat });
      };
      mk('hero_idle', HERO_FRAMES.idle, 3, -1);
      mk('hero_run', HERO_FRAMES.run, 12, -1);
      mk('hero_jump', HERO_FRAMES.jump, 6, 0);
      mk('hero_fall', HERO_FRAMES.fall, 6, 0);
      mk('hero_attack', HERO_FRAMES.attack, 18, 0);
      mk('hero_hurt', HERO_FRAMES.hurt, 8, 0);
      mk('hero_roll', HERO_FRAMES.roll, 10, -1);
      mk('hero_dead', HERO_FRAMES.dead, 6, 0);
      mk('hero_guard', HERO_FRAMES.guard, 4, 0);   // 举盾（单帧姿态，靠盾光呼吸）
    }

    /** 怪物动画：按怪物类型注册；镜像怪换了玩家造型时自动重建 */
    ensureMobAnims(key, tex) {
      var A = 角色形象, keys = A.mobAnimKeys(key), F = ENEMY_FRAMES, self = this;
      // 动作（招式）多的怪物帧率更高 —— 倍率写在 角色形象.js 的形象表里
      var rate = A.animRateOf ? A.animRateOf(key) : 1;
      var mk = function (k, frames, fps, repeat) {
        fps = Math.max(1, Math.round(fps * rate));
        if (self.anims.exists(k)) {
          var cur = self.anims.get(k);
          // 纹理与帧率都对得上才复用（改帧率后必须重建，否则热刷新看不到变化）
          if (cur && cur.frames && cur.frames.length &&
            cur.frames[0].textureKey === tex && cur.frameRate === fps) return;
          self.anims.remove(k);
        }
        self.anims.create({ key: k, frames: self.anims.generateFrameNumbers(tex, { frames: frames }), frameRate: fps, repeat: repeat });
      };
      mk(keys.walk, F.walk, 6, -1);
      mk(keys.attack, F.attack, 10, 0);
      mk(keys.hurt, F.hurt, 10, 0);
      mk(keys.dead, F.dead, 6, 0);
    }

    /** 取怪物某个动作的动画 key */
    mobAnimKey(e, action) {
      var keys = 角色形象.mobAnimKeys((e && e.key) || 'claw');
      return keys[action || 'walk'] || keys.walk;
    }

    buildBackground() {
      var W = this.scale.width, H = this.scale.height;
      var env = this.env || ENV_THEMES.normal;
      this.bgStars = [];
      for (var layer = 0; layer < 3; layer++) {
        var cnt = Math.floor(qp().stars * (0.5 + layer * 0.4));
        for (var i = 0; i < cnt; i++) {
          var s = this.add.rectangle(rnd(0, W), rnd(0, H), layer === 2 ? 2 : 1, layer === 2 ? 2 : 1,
            env.star, 0.12 + layer * 0.16);
          s.scrollFactorX = 0.05 + layer * 0.07;
          s.scrollFactorY = 0.05 + layer * 0.07;
          s._layer = layer;
          this.bgStars.push(s);
        }
      }
      this.fog = this.add.rectangle(W / 2, H + 60, W * 3, 300, env.fog, env.fogAlpha);
      this.fog.setScrollFactor(0.2, 1);
      this.refreshEnvironment();
    }

    /**
     * 应用环境主题（难度 → 星色 / 雾色 / 火星粒子）
     * 阶段5：简单·白星光 普通·蓝星光 困难·暖色 地狱·红色火焰
     */
    applyEnvironment(diff) {
      this.difficulty = diff || 'normal';
      this.env = envThemeFor(this.difficulty);
      if (!this.bgStars) return;   // 背景尚未建立
      this.refreshEnvironment();
    }

    refreshEnvironment() {
      var env = this.env || ENV_THEMES.normal;
      var W = this.scale.width, H = this.scale.height;
      if (this.bgStars) {
        this.bgStars.forEach(function (s) {
          s.setFillStyle(env.star, 0.12 + s._layer * 0.16);
        });
      }
      if (this.fog) { this.fog.setFillStyle(env.fog, env.fogAlpha); }
      if (this.fogFar) { this.fogFar.setFillStyle(env.fog, env.fogAlpha * 0.7); }

      // 地狱 / 困难：上升火星
      var wantEmber = !!env.ember && qp().particles && !(state.settings && state.settings.particles === false);
      if (wantEmber && !this.emberEmitter) {
        try {
          this.emberEmitter = this.add.particles(0, 0, TEX.spark, {
            x: { min: -40, max: W + 40 }, y: H + 20,
            speedY: { min: -150, max: -60 }, speedX: { min: -24, max: 24 },
            lifespan: 2800, frequency: 120, quantity: 1,
            scale: { start: 0.5, end: 0 }, alpha: { start: 0.85, end: 0 },
            tint: [0xff7a3a, 0xffb060, 0xff4a20], blendMode: 'ADD'
          });
          this.emberEmitter.setDepth(3);
          this.emberEmitter.setScrollFactor(0.4, 0.4);
        } catch (e) { this.emberEmitter = null; }
      } else if (!wantEmber && this.emberEmitter) {
        this.emberEmitter.destroy();
        this.emberEmitter = null;
      }
    }

    buildHero() {
      this.hero = this.physics.add.sprite(120, 200, 角色形象.ensureHeroTexture(this, this.heroLookId || 'warrior'), 0);
      this.hero.setOrigin(0.5, 1);
      this.hero.body.setSize(26, 46);
      this.hero.body.setOffset((CELL - 26) / 2, CELL - 46);
      this.hero.setDepth(10);
      this.hero.setCollideWorldBounds(true);

      this.hero.hp = 100; this.hero.maxHp = 100; this.hero.shield = 0;
      this.hero.attack = 10; this.hero.critRate = 0; this.hero.critDamage = 150;
      this.hero.dodge = 0; this.hero.thorn = 0; this.hero.vampire = 0;
      this.hero.combo = 0; this.hero.execute = 0;
      this.hero.potions = 0; this.hero.name = '冒险者';

      this.invulnUntil = 0;
      this.attackReadyAt = 0;
      this.coyoteUntil = 0;
      this.jumpBufferUntil = 0;
      this.heroDead = false;

      // 体力（闪避资源）
      this.hero.stamina = STAMINA.max;
      this.hero.maxStamina = STAMINA.max;
      this.hero.perfectCount = 0;

      // 闪避（翻滚）状态
      this.dodging = false;
      this.dodgeStartAt = 0;
      this.dodgeUntil = 0;
      this.dodgeReadyAt = 0;
      this.staminaHoldUntil = 0;
      this.perfectUntil = 0;
      this._lastPerfectAt = -9999;
      this._staminaShown = STAMINA.max;
      this._afterimageAt = 0;

      // 连携（技巧资源；设计说明见文件里 LINK 那一段）
      // 局内**跨房间保留**、只有挨打才清零 —— 这是"敢不敢攒"的赌注所在
      this.link = 0;
      this.linkPips = null;
      this._diveLinked = false;
      // 织网者的网（B 项）：缠身剩余时间与可视
      this.webUntil = 0;
      this.webFx = null;

      // 狂怒（举盾）
      this.guarding = false;
      this.guardStartAt = 0;
      this.guardReadyAt = 0;
      this.guardFlashAt = 0;
      this.guardBlocked = false;
      this.blockCount = 0;

      // 狂怒（实时重做）：一管进攻资源 + 满值后 6 秒狂怒状态（只手动触发）
      this.fury = 0;
      this.furyUntil = 0;
      this._furyFull = false;
      this._furyWasOn = false;

      // 连招（三连斩 / 盾反 / 突进斩 / 落地斩）
      this.chainCount = 0;
      this.chainUntil = 0;
      this.counterUntil = 0;
      this.dodgeCounterUntil = 0;
      this.diveCounterUntil = 0;

      // 平台上的魂晶
      this.crystals = [];
      this.platformPerches = [];

      // 诅咒 / 环境效果（实时化）与腐化脉冲
      this.curses = [];
      this.worldEnv = null;
      this.pulseAt = 0;
      this._baseAtk = null;
      this._baseDodge = null;

      // 英雄技能（主动每层一次 / 被动常驻）
      this.skill = null;
      this.skillId = '';
      this.skillUsed = false;
      this.skillPowerUntil = 0;
      this.skillPowerMult = 1;
      this.skillVampire = 0;
      this.guardUntil = 0;
      this.skillLockUntil = 0;
      this._roomFirstHit = false;
      this._roomFirstKill = false;
      this.skillProjectiles = [];
      this.skillButtons = [];

      // 蓄力跳状态
      this.isCharging = false;
      this.chargeStart = 0;
      this.chargeRatio = 0;
      // 蓄力指示光圈（跟随脚底，随蓄力放大变色）
      this.chargeRing = this.add.circle(0, 0, 16, 0xa8e6ff, 0.2).setDepth(9).setVisible(false);
      // 举盾盾光：身前一道弧（随朝向翻转，挡下时闪金）
      this.guardArc = this.add.arc(0, 0, 26, -62, 62, false, 0x8ad8ff, 0.26).setDepth(10).setVisible(false);
      this.guardArc.setStrokeStyle(3, 0xffffff, 0.35);
      // 连招提示：窗口开着时贴在主角头顶
      this.chainHint = this.add.text(0, 0, '', { fontSize: '13px', color: UI.gold, fontStyle: 'bold' })
        .setOrigin(0.5).setDepth(12).setVisible(false);
      this.chainHint.setShadow(0, 1, '#04060f', 4, false, true);
      // 魂晶提示：走近时贴在魂晶下方，告诉玩家"这东西能捡"
      this.crystalHint = this.add.text(0, 0, '拾取', { fontSize: '12px', color: UI.accent, fontStyle: 'bold' })
        .setOrigin(0.5, 0).setDepth(12).setVisible(false);
      this.crystalHint.setShadow(0, 1, '#04060f', 4, false, true);
      this.chargeRing.setStrokeStyle(2, 0xffffff, 0.55);

      this.hero.play('hero_idle');
    }

    buildHud() {
      var W = this.scale.width, H = this.scale.height;
      this.hud = this.add.container(0, 0).setDepth(1000).setScrollFactor(0);

      // ===== 主角生命（与敌人血条同一套血条组件；护盾是叠加在生命上的第二层）=====
      this.heroMeter = this.createMeter({
        key: 'hero', h: 18, from: UI.heroFrom, to: UI.heroTo, glow: true, glowTint: UI.cPrimary
      });
      this.shieldMeter = this.createMeter({
        key: 'shield', h: 18, from: UI.shieldFrom, to: UI.shieldTo, track: false, trail: false
      });
      this.hud.add(this.meterParts(this.heroMeter));
      this.hud.add([this.shieldMeter.fill]);

      // ===== 体力（闪避资源）：青蓝细条，位于生命条正下方 =====
      this.staminaMeter = this.createMeter({
        key: 'stam', h: 9, from: UI.stamFrom, to: UI.stamTo, trail: false
      });
      // 狂怒条（金色，与青蓝体力条并排：一条管生存、一条管进攻）
      this.furyMeter = this.createMeter({
        key: 'fury', h: 9, from: '#8a3a1a', to: '#ffd76a', trail: false
      });
      this.hud.add(this.meterParts(this.furyMeter));
      // 狂怒状态的身周金环
      this.furyRing = this.add.circle(0, 0, 26, 0xffd76a, 0.24).setDepth(9).setVisible(false);
      this.furyRing.setStrokeStyle(2, 0xffd76a, 0.7);
      // 「可完美闪避」时机提示光（金色，只在危险窗口亮起）
      this.staminaTip = this.add.image(0, 0, glowTexture(this)).setTint(UI.cPerfect).setAlpha(0);
      this.hud.add([this.staminaTip].concat(this.meterParts(this.staminaMeter)));

      this.hpText = this.add.text(0, 0, '', { fontSize: '14px', color: UI.text, fontStyle: 'bold' }).setOrigin(0, 0.5);
      this.hpText.setShadow(0, 1, '#04060f', 5, false, true);
      this.shieldText = this.add.text(0, 0, '', { fontSize: '13px', color: UI.accent, fontStyle: 'bold' }).setOrigin(0, 0.5);
      this.shieldText.setShadow(0, 1, '#04060f', 5, false, true);
      this.nameText = this.add.text(24, 10, '冒险者', { fontSize: '13px', color: UI.good, fontStyle: 'bold' }).setOrigin(0, 0.5);
      this.staminaText = this.add.text(0, 0, '', { fontSize: '12px', color: UI.accent, fontStyle: 'bold' }).setOrigin(0, 0.5);
      this.staminaText.setShadow(0, 1, '#04060f', 5, false, true);
      this.sharpText = this.add.text(0, 0, '', { fontSize: '12px', color: UI.gold, fontStyle: 'bold' }).setOrigin(0, 0.5).setVisible(false);
      this.sharpText.setShadow(0, 1, '#04060f', 5, false, true);
      this.furyText = this.add.text(0, 0, '', { fontSize: '12px', color: UI.sub, fontStyle: 'bold' }).setOrigin(0, 0.5);
      this.furyText.setShadow(0, 1, '#04060f', 5, false, true);
      // 满怒 / 狂怒中的操作提示（贴在狂怒条下方，明确告诉玩家按 R）
      this.furyHint = this.add.text(0, 0, '按 R · 狂怒爆发', { fontSize: '12px', color: UI.gold, fontStyle: 'bold' }).setOrigin(0, 0.5).setVisible(false);
      this.furyHint.setShadow(0, 1, '#04060f', 5, false, true);
      this.nameText.setShadow(0, 1, '#04060f', 5, false, true);

      this.floorText = this.add.text(W - 24, 18, '第 1 层', { fontSize: '19px', color: UI.title, fontStyle: 'bold' }).setOrigin(1, 0.5);
      this.pointText = this.add.text(W - 24, 42, '金币 0', { fontSize: '14px', color: UI.good }).setOrigin(1, 0.5);
      this.enemyCountText = this.add.text(W - 24, 64, '', { fontSize: '13px', color: UI.danger }).setOrigin(1, 0.5);
      this.roomText = this.add.text(W - 24, 86, '', { fontSize: '13px', color: UI.sub }).setOrigin(1, 0.5);

      // ===== 本房间环境效果（钉在「房间 · 已探索」正下方）=====
      // 面板内容全部按「右边缘 = 0」的局部坐标画，容器整体贴到 W - 24，窄屏只需改宽度。
      this.envPanel = this.add.container(0, 0).setVisible(false);
      this.envBg = this.add.graphics();
      this.envMark = this.add.graphics();
      this.envLabel = this.add.text(0, 0, '本房间环境', { fontSize: '10px', color: '#8f86c8', fontStyle: 'bold' });
      this.envName = this.add.text(0, 0, '', { fontSize: '15px', color: '#efe8ff', fontStyle: 'bold' });
      this.envValueText = this.add.text(0, 0, '', { fontSize: '12px', color: UI.gold, fontStyle: 'bold' }).setOrigin(1, 0);
      this.envEffect = this.add.text(0, 0, '', { fontSize: '11px', color: '#a99fd0', lineSpacing: 3 });
      this.envName.setShadow(0, 1, '#04060f', 5, false, true);
      this.envValueText.setShadow(0, 1, '#04060f', 4, false, true);
      this.envLabel.setShadow(0, 1, '#04060f', 4, false, true);
      this.envPanel.add([this.envBg, this.envMark, this.envLabel, this.envName, this.envValueText, this.envEffect]);

      // 诅咒胶囊（排在环境面板**上方**）：与「本房间环境」同一套语言 —— 菱形标记 + 小标签 + 内容
      this.cursePanel = this.add.container(0, 0).setVisible(false);
      this.curseBg = this.add.graphics();
      this.curseMark = this.add.graphics();
      this.curseLabel = this.add.text(0, 0, '诅咒', { fontSize: '10px', color: '#d98a96', fontStyle: 'bold' });
      this.curseLabel.setShadow(0, 1, '#04060f', 4, false, true);
      this.curseText = this.add.text(0, 0, '', {
        fontSize: '12px', color: UI.danger, lineSpacing: 4
      });
      this.curseText.setShadow(0, 1, '#04060f', 4, false, true);
      this.cursePanel.add([this.curseBg, this.curseMark, this.curseLabel, this.curseText]);

      // 腐化脉冲倒计时（垫在环境面板下方；没有对应内容时不占位）
      this.pulseText = this.add.text(W - 24, 150, '', {
        fontSize: '12px', color: UI.muted, fontStyle: 'bold'
      }).setOrigin(1, 0).setVisible(false);
      this.pulseText.setShadow(0, 1, '#04060f', 4, false, true);
      this.floorText.setShadow(0, 1, '#04060f', 5, false, true);
      this.pointText.setShadow(0, 1, '#04060f', 5, false, true);
      this.enemyCountText.setShadow(0, 1, '#04060f', 5, false, true);
      this.roomText.setShadow(0, 1, '#04060f', 5, false, true);

      // ===== 属性面板（攻击 / 暴击 / 闪避 / 护盾 / 荆棘 / 吸血 / 连击 / 斩杀）=====
      this.statPanel = this.add.container(0, 0).setScrollFactor(0);
      this.statItems = [];
      var statDefs = [
        { key: 'attack',   label: '攻', color: 0xff8a7a, always: true },
        { key: 'critRate', label: '暴', color: 0xffd76a, suffix: '%' },
        { key: 'dodge',    label: '闪', color: 0x8ab8ff, suffix: '%' },
        { key: 'shield',   label: '盾', color: 0x5fd0e0 },
        { key: 'thorn',    label: '棘', color: 0xc0a0ff },
        { key: 'vampire',  label: '吸', color: 0xff7ab0 },
        { key: 'combo',    label: '连', color: 0x9fe0c0, suffix: '%' },
        { key: 'execute',  label: '斩', color: 0xff6b6b, suffix: '%' }
      ];
      var self = this;
      statDefs.forEach(function (d) {
        // 圆形图例点：与画面内胶囊 / 血条的圆角语言一致
        var box = self.add.circle(0, 0, 4.5, d.color, 1).setOrigin(0, 0.5);
        var txt = self.add.text(0, 0, d.label + ' 0', { fontSize: '12px', color: UI.text }).setOrigin(0, 0.5);
        txt.setShadow(0, 1, '#04060f', 4, false, true);
        self.statPanel.add([box, txt]);
        self.statItems.push({ key: d.key, label: d.label, suffix: d.suffix || '', always: !!d.always, box: box, text: txt });
      });
      this.layoutStatPanel();
      this.buildRelicStrip();

      // ===== 英雄技能（主动每层一次）：独立一行的胶囊，位置在 layoutHudButtons 里排 =====
      this.skillBtn = this.craftButton(this.hud, this.skillButtons, {
        action: 'skill', label: '技能', icon: 'skill', variant: 'primary',
        shape: 'pill', x: 24, y: 78, w: 72, h: 24
      });
      this.updateSkillHud();

      this.potionText = this.add.text(24, H - 48, '', { fontSize: '14px', color: '#ffb347' }).setOrigin(0, 0.5);
      this.hintText = this.add.text(W / 2, H - 22, 'A/D 移动 · 按住 W/空格 蓄力跳 · J 挥砍（空中=跳劈）· K 闪避 · E 技能 · L 药水', { fontSize: '13px', color: UI.muted }).setOrigin(0.5);
      this.comboText = this.add.text(W / 2, 44, '', { fontSize: '22px', color: UI.title, fontStyle: 'bold' }).setOrigin(0.5).setAlpha(0);

      // ===== 层主血条（顶部居中，命名 + 数值内嵌）=====
      this.bossMeter = this.createMeter({ key: 'hp', h: 14, glow: true, glowTint: UI.cDanger });
      this.hud.add(this.meterParts(this.bossMeter));
      this.bossName = this.add.text(W / 2, 82, '', { fontSize: '15px', color: UI.danger, fontStyle: 'bold' }).setOrigin(0.5);
      this.bossName.setShadow(0, 1, '#04060f', 5, false, true);
      this.bossText = this.add.text(W / 2, 100, '', { fontSize: '11px', color: '#ffffff', fontStyle: 'bold' }).setOrigin(0.5).setVisible(false);
      this.bossText.setShadow(0, 1, '#04060f', 4, false, true);
      this.bossName.setVisible(false);
      this.hud.add([this.bossName, this.bossText]);
      this.setMeterVisible(this.bossMeter, false);

      this.centerMsg = this.add.text(W / 2, H * 0.4, '', { fontSize: '30px', color: UI.title, fontStyle: 'bold' }).setOrigin(0.5).setAlpha(0);
      // 清空房间后的出口方向指引（出口在屏幕外时贴边显示）
      this.guideArrow = this.add.text(W - 52, H * 0.45, '▶ 出口', {
        fontSize: '16px', color: UI.good, fontStyle: 'bold'
      }).setOrigin(0.5).setVisible(false);

      // ===== 目标敌人属性（最近的敌人：名字 / 层级 / 生命 / 攻击 / 速度 / 行为）=====
      this.targetPanel = this.add.container(0, 0).setScrollFactor(0).setVisible(false);
      this.targetBg = this.add.graphics();
      this.targetName = this.add.text(0, 0, '', { fontSize: '13px', fontStyle: 'bold' }).setOrigin(0, 0.5);
      this.targetName.setShadow(0, 1, '#04060f', 4, false, true);
      this.targetTierBg = this.add.graphics();
      this.targetTier = this.add.text(0, 0, '', { fontSize: '11px' }).setOrigin(0, 0.5);
      this.targetHp = this.add.text(0, 0, '', { fontSize: '11px', color: UI.sub, fontStyle: 'bold' }).setOrigin(1, 0.5);
      this.targetMeter = this.createMeter({ key: 'hp', h: 10 });
      this.targetTags = [];
      var tg, tt;
      for (var ti = 0; ti < 3; ti++) {
        tg = this.add.graphics();
        tt = this.add.text(0, 0, '', { fontSize: '11px', color: UI.muted }).setOrigin(0, 0.5);
        this.targetTags.push({ gfx: tg, text: tt, last: '', x: 0, y: 0, w: 0 });
      }
      this.targetPanel.add([this.targetBg, this.targetName, this.targetTierBg, this.targetTier]);
      this.targetPanel.add(this.meterParts(this.targetMeter));
      this.targetPanel.add([this.targetHp]);
      this.targetTags.forEach(function (t) { self.targetPanel.add([t.gfx, t.text]); });

      // ⚠️ 狂怒数值 / 满怒提示必须在 hud 容器里（第 11 条）
      // ------------------------------------------------------------
      // 它们曾经漏加进 hud：坐标本身算得没错（条右缘 + 10，与生命 / 体力同一个
      // meterTextX 口径），但对象留在**场景根**上 —— scrollFactor 还是 1、depth 还是 0，
      // 于是相机一滚动，数字就跟着世界一起走。进房间时相机 scroll 恰好是 (0,0)，
      // 看着分毫不差；人一走动、镜头一跟，数字就贴着条往左滑，最后压在条上。
      // （hud 容器是 scrollFactor 0，里面的对象自己写 1 也没关系 —— 生命 / 体力
      //   数值就是这样待着的，相机怎么动都钉在原处。）
      this.hud.add([this.hpText, this.shieldText, this.staminaText, this.sharpText,
        this.furyText, this.furyHint, this.nameText,
        this.statPanel, this.floorText, this.pointText, this.enemyCountText, this.roomText,
        this.envPanel, this.cursePanel, this.pulseText,
        this.potionText, this.hintText, this.comboText, this.centerMsg, this.guideArrow,
        this.targetPanel]);
      // 层主血条的名条 / 数值压在血条之上
      this.hud.bringToTop(this.bossName);
      this.hud.bringToTop(this.bossText);

      // ===== 画面内功能按钮（商店 / 图鉴 / 设置 / 菜单）=====
      // 独立容器且层级最高：地图、商店、死亡面板打开时依然可用
      // ⚠️ 「文字界面」按钮已删：试炼并入经典后新版只有 2D 这一个视图，
      //    切老版（2.6）由侧边栏 / 2D 画面的 DOM 覆盖层负责，画内不再放同义按钮。
      this.uiBar = this.add.container(0, 0).setDepth(2600).setScrollFactor(0);
      [
        // 「属性」：属性面板的完整明细入口。
        // 以前它是遗物条上一颗 10px 的小字「▸ 属性」，只在属性面板收起时才露出，
        // 而且正好和技能胶囊 / 按钮行挤在同一块地方 —— 手机上经常被压住、点不到。
        // 现在它是这一行的正式成员，与图鉴 / 设置同款胶囊；同时它进了布局编辑器
        // （单元 id = h.fn.stats），玩家可以单独拖动 / 缩放 / 隐藏它。
        { id: 'stats', label: '属性', icon: 'stats', variant: 'ghost' },
        { id: 'shop', label: '商店', icon: 'shop', variant: 'gold' },
        { id: 'codex', label: '图鉴', icon: 'codex', variant: 'ghost' },
        // 设置入口必须在画布内：实时战斗为了不挡住「攻击」键，把右下角的
        // 侧边栏开关（☰）收起来了，而设置正挂在侧边栏里 —— 不补这一颗，
        // 手机上就没法进设置，「按键自定义」也就够不着。
        { id: 'settings', label: '设置', icon: 'settings', variant: 'ghost' },
        // 「菜单」= 本局中枢（原先的「更多」+「退出」两颗合并而来，见 HUD_BTN_LABELS 的说明）。
        // 打开的是**画布内**的菜单界面：本局状态 + 继续 / 结束 + 一整套系统功能，
        // 全部由引擎自己绘制（不再借 DOM 侧边栏这个中间层）。
        { id: 'menu', label: '菜单', icon: 'menu', variant: 'ghost' }
      ].forEach(function (d) {
        self.craftButton(self.uiBar, self.hudButtons, {
          action: d.id, label: d.label, icon: d.icon, variant: d.variant,
          shape: 'pill', x: 0, y: 0, w: 40, h: 28
        });
      });

      this.layoutHudButtons(W);
      this.refreshHud();
    }

    /** 主角 / 层主 / 目标面板 / 功能按钮的统一布局（随窗口宽度缩放） */
    layoutHudButtons(sizeW) {
      if (!this.heroMeter) return;
      var W = sizeW || this.scale.width;
      var k = clamp(Math.min(W / 900, 1), 0.68, 1);

      // ===== 主角：名字 + 生命条 + 数值 + 护盾 =====
      var x0 = 24, barY = 34, barW = Math.round(252 * k);
      this.nameText.setPosition(x0, 12).setFontSize(Math.max(11, Math.round(13 * k)));
      this.placeMeter(this.heroMeter, x0, barY, barW);
      this.placeMeter(this.shieldMeter, x0, barY, barW);
      this.hpText.setFontSize(Math.max(11, Math.round(14 * k)));
      this.shieldText.setFontSize(Math.max(10, Math.round(13 * k)));
      // gap 是「离条右边缘多远」，不是绝对坐标 —— 条被缩放了它才跟得住，
      // 实际位置由 meterTextX() 现算（见那里的说明）
      this._hpTextGap = 10;
      this._hpTextY = barY;

      // 体力条（生命条正下方，与属性面板 / 胶囊行保持间距）=====
      var stamY = barY + 22;
      this.placeMeter(this.staminaMeter, x0, stamY, barW);
      this.staminaTip.setPosition(x0 + barW / 2, stamY).setDisplaySize(barW * 1.08, 30);
      this.staminaText.setFontSize(Math.max(10, Math.round(12 * k)));
      this._stamTextGap = 10;
      this._stamTextY = stamY;

      // ===== 狂怒条（体力条正下方，金色；满怒时呼吸，狂怒中显示剩余秒数）=====
      var furyY = stamY + 20;
      this.placeMeter(this.furyMeter, x0, furyY, barW);
      this.furyText.setFontSize(Math.max(10, Math.round(12 * k)));
      this.furyTextPos = { gap: 10, y: furyY };
      this.furyHint.setFontSize(Math.max(10, Math.round(12 * k)));
      this.furyHintPos = { x: x0 + 4, y: furyY + 17 };
      this.paintFuryMeter();

      // ===== 英雄技能胶囊：紧贴在「攻 / 暴 / 闪 / 盾 …」属性面板正下方 =====
      // （原来排在狂怒条下方，和属性面板那一行叠在一起了）
      var gapY = Math.max(5, Math.round(6 * k));
      var skillH = Math.max(22, Math.round(24 * k));
      var statBottom = this.statPanelMetrics(W).bottom;   // 按当前宽度现算，不受上次布局影响
      if (this.skillBtn) {
        var sbY = statBottom + gapY + skillH / 2;
        this.layoutPillRow([this.skillBtn], x0, sbY, skillH, 0);
        this.updateSkillHud();
      }

      // ===== 常驻功能按钮：接在技能胶囊下面（商店 / 图鉴 / 设置 / 菜单）=====
      var bh = Math.max(24, Math.round(28 * k));
      var rowTop = (this.skillBtn ? (this.skillBtn.y + skillH / 2) : statBottom) + gapY;
      var by = rowTop + bh / 2;
      var gapX = Math.round(8 * k);
      // maxRight = 画面右边界留 12px：窄屏上让整行等比收缩，绝不把「菜单」推出屏幕
      this.layoutPillRow(this.hudButtons, x0, by, bh, gapX, W - 12);
      this._hudRowBottom = by + bh / 2;

      // 触摸设备 + 低高度横屏：目标面板要挪到顶部中央（见下），层主名字给它让一行
      var compact = this.isTouch && this.scale.height < 460;

      // ===== 层主血条 =====
      var bossW = Math.round(Math.min(460, W - 140) * Math.max(0.72, k));
      this.placeMeter(this.bossMeter, Math.round(W / 2 - bossW / 2), 100, bossW);
      this.bossName.setPosition(W / 2, compact ? 88 : 82).setFontSize(Math.max(13, Math.round(15 * k)));
      this.bossText.setPosition(W / 2, 100);

      // ===== 目标敌人属性面板 =====
      var tk = Math.max(0.84, k);
      var tpW = Math.round(252 * tk);
      var headH = Math.round(28 * tk);
      var meterY = headH + Math.round(15 * tk);
      var tagH = Math.round(18 * tk);
      var tagY = meterY + Math.round(22 * tk);
      var tpH = tagY + Math.round(tagH / 2) + Math.round(10 * tk);
      this._tp = {
        w: tpW, h: tpH, k: tk, pad: Math.round(12 * tk), headH: headH,
        headY: Math.round(14 * tk), meterY: meterY, tagY: tagY, tagH: tagH
      };
      this.paintTargetPanel();
      this.layoutTargetPanel();
      // 生命数值紧跟在血条右侧，宽度变化后必须重排（否则窄屏会脱节）
      this.refreshHud();

      // ===== 目标面板定位 =====
      // 触摸设备 + 低高度横屏（手机横着拿）：左下角整个被摇杆占住，而目标面板按
      // 老位置从 _hudRowBottom 往下排会到 y≈277，正好压在摇杆判定圈上（重叠 92×54）——
      // 玩家想瞄一眼敌人血量就会误触移动。这种屏幕上左右两侧都排满了 HUD
      // （左侧属性/按钮列，右侧诅咒胶囊 + 环境面板），只有顶部中央这一条是空的；
      // 而且锁定目标的血量本来就该摆在视线正前方，比挤在左下角更好读。
      // 必须排在 refreshHud() 之后：要按「生命数值」的实际宽度让开，否则会压住它。
      if (compact) {
        var hpx = this.meterTextX(this.heroMeter, this._hpTextGap);
        if (hpx == null) hpx = 0;
        var hpr = Math.round(hpx + (this.hpText ? this.hpText.width : 0) + 12);
        var tx = Math.max(Math.round(W / 2 - tpW / 2), hpr);
        this.targetPanel.setPosition(Math.min(tx, W - 24 - tpW), 2);
      } else {
        this.targetPanel.setPosition(24, this._hudRowBottom + Math.round(14 * tk));
      }
      this._targetCompact = compact;

      // ===== 窄屏：左右两列会横向撞上，把「诅咒 / 环境」整列压到左侧 HUD 下方 =====
      // 宽屏下左列（属性 + 技能 + 按钮 + 目标面板）到 x≈400 就结束了，右列从 x≈1058 起，互不干扰；
      // 窄屏（420）左列按钮行能伸到 x≈387，右列从 x≈124 起 —— 只能往下让，宁可往下走也不叠字。
      var leftRight = x0;
      this.hudButtons.forEach(function (b) { leftRight = Math.max(leftRight, b.x + b.w); });
      var rightLeft = W - 24 - (this._envPanelW || ENV.panelW);
      var minTop = 0;
      if (leftRight >= rightLeft) {
        // 左列的下沿：环境面板要整块让到它下面去。
        // 遗物条在场时它把属性面板推低了 RELIC_ROW_H，这里必须跟着 ——
        // 少算这一行，窄屏上环境面板就会压在遗物条上。
        var leftBottom = this._relicStripVisible
          ? (RELIC_ROW_CY + RELIC_ROW_H / 2 + 6)
          : this._hudRowBottom;
        minTop = (this.targetPanel.visible ? (this.targetPanel.y + this._tp.h) : leftBottom)
          + Math.round(10 * k);
      }
      if ((this._envHudMinTop || 0) !== minTop) {
        this._envHudMinTop = minTop;
        this.layoutEnvHud(W);   // 用新的下限重排一次；layoutEnvHud 不会再回调这里，无递归
      }
    }

    /** 目标面板底板：内嵌卡片风格（圆角 + 细分隔线） */
    paintTargetPanel() {
      var t = this._tp;
      if (!t || !this.targetBg) return;
      var g = this.targetBg, r = UI.boxR;
      g.clear();
      g.fillStyle(UI.trackBase, 0.42);
      g.fillRoundedRect(0, 0, t.w, t.h, r);
      g.fillStyle(UI.box, UI.boxAlpha);
      g.fillRoundedRect(0, 0, t.w, t.h, r);
      g.lineStyle(1, UI.boxLine, UI.boxLineAlpha);
      g.strokeRoundedRect(0.5, 0.5, t.w - 1, t.h - 1, r - 0.5);
      // 标题行与内容之间的分隔线（对齐 .trial-panel-header）
      g.lineStyle(1, 0xffffff, 0.07);
      g.beginPath();
      g.moveTo(t.pad, t.headH);
      g.lineTo(t.w - t.pad, t.headH);
      g.strokePath();
    }

    /** 目标面板内容排版（名字 / 层级胶囊 / 生命值 / 血条 / 属性胶囊） */
    layoutTargetPanel() {
      var t = this._tp;
      if (!t) return;
      var pad = t.pad;
      this.targetName.setPosition(pad, t.headY);
      var chipX = pad + Math.ceil(this.targetName.width) + Math.round(8 * t.k);
      var chipH = Math.round(16 * t.k);
      var chipW = Math.ceil(this.targetTier.width) + Math.round(16 * t.k);
      var g = this.targetTierBg;
      g.clear();
      g.fillStyle(0xffffff, 0.03);
      g.fillRoundedRect(chipX, t.headY - chipH / 2, chipW, chipH, chipH / 2);
      g.lineStyle(1, 0xffffff, 0.07);
      g.strokeRoundedRect(chipX + 0.5, t.headY - chipH / 2 + 0.5, chipW - 1, chipH - 1, chipH / 2 - 0.5);
      this.targetTier.setPosition(chipX + Math.round(8 * t.k), t.headY);
      this.targetHp.setPosition(t.w - pad, t.headY);
      this.placeMeter(this.targetMeter, pad, t.meterY, t.w - pad * 2);

      var x = pad;
      var self = this;
      var defs = this._targetTags || [];
      this.targetTags.forEach(function (tag, i) {
        if (!defs[i]) return;
        x = self.paintTag(tag, x, t.tagY, defs[i].text, t.tagH, defs[i].color);
      });
    }

    /** 属性小胶囊（对齐 .stat-tag：白 3% 底 + 白 7% 描边 + 全圆角） */
    paintTag(tag, x, y, text, h, color) {
      if (tag.last !== text) {
        tag.text.setText(text);
        if (color) tag.text.setColor(color);
        tag.last = text;
        tag.w = Math.ceil(tag.text.width) + 20;
        tag.x = null;              // 宽度变化 → 重画底板
      }
      if (tag.x !== x || tag.y !== y || tag._h !== h) {
        tag.x = x; tag.y = y; tag._h = h;
        var g = tag.gfx;
        g.clear();
        g.fillStyle(0xffffff, 0.03);
        g.fillRoundedRect(x, y - h / 2, tag.w, h, h / 2);
        g.lineStyle(1, 0xffffff, 0.07);
        g.strokeRoundedRect(x + 0.5, y - h / 2 + 0.5, tag.w - 1, h - 1, h / 2 - 0.5);
        tag.text.setPosition(x + 10, y);
      }
      return x + tag.w + 8;
    }

    buildInput() {
      var k = this.input.keyboard;
      this.keys = k.addKeys({
        left: Phaser.Input.Keyboard.KeyCodes.A, left2: Phaser.Input.Keyboard.KeyCodes.LEFT,
        right: Phaser.Input.Keyboard.KeyCodes.D, right2: Phaser.Input.Keyboard.KeyCodes.RIGHT,
        jump: Phaser.Input.Keyboard.KeyCodes.W, jump2: Phaser.Input.Keyboard.KeyCodes.SPACE,
        jump3: Phaser.Input.Keyboard.KeyCodes.UP,
        attack: Phaser.Input.Keyboard.KeyCodes.J, potion: Phaser.Input.Keyboard.KeyCodes.L,
        dodge: Phaser.Input.Keyboard.KeyCodes.K,   // 闪避
        skill: Phaser.Input.Keyboard.KeyCodes.E,
        guard: Phaser.Input.Keyboard.KeyCodes.S,   // 防御（举盾）
        guard2: Phaser.Input.Keyboard.KeyCodes.DOWN,
        fury: Phaser.Input.Keyboard.KeyCodes.R     // 狂怒（满值后爆发）
      });
      k.addCapture([Phaser.Input.Keyboard.KeyCodes.SPACE, Phaser.Input.Keyboard.KeyCodes.UP,
        Phaser.Input.Keyboard.KeyCodes.DOWN, Phaser.Input.Keyboard.KeyCodes.LEFT, Phaser.Input.Keyboard.KeyCodes.RIGHT]);

      // 挂机判定（2.9.2 §3.9 第 5 条）要读"这 3 秒内有没有输入"：
      // isDown 只在按住时为真，点一下就松开的攻击会整段漏掉，所以另记一个按键时间戳。
      var scnRef = this;
      k.on('keydown', function () { scnRef._keyTapAt = scnRef.time.now; });

      // ===== 触摸控制（虚拟摇杆 + 蓄力跳 / 攻击 / 药水）=====
      this.isTouch = isTouchDevice();
      this.touchInput = { left: false, right: false, downHeld: false, jumpHeld: false, joyJumpHeld: false, jumpPressed: false, guardHeld: false };
      this.pointerRoles = {};
      this.joyOrigin = { x: 0, y: 0 };

      var self = this;
      var W = this.scale.width, H = this.scale.height;
      this.touchUI = this.add.container(0, 0).setDepth(1001).setScrollFactor(0);

      // 摇杆（左下）
      this.joyBase = this.add.circle(120, H - 120, 66, 0x0a0a14, 0.34).setStrokeStyle(3, 0xffffff, 0.2);
      this.joyKnob = this.add.circle(120, H - 120, 30, 0x73f0b4, 0.42);
      this.joyLabel = this.add.text(120, H - 120, '◀ ▶', { fontSize: '18px', color: '#cfe8dd' }).setOrigin(0.5);

      // 蓄力跳（右下，最大）
      this.btnJump = this.add.circle(W - 112, H - 112, 58, 0x73f0b4, 0.26).setStrokeStyle(3, 0x73f0b4, 0.65);
      this.btnJumpLabel = this.add.text(W - 112, H - 112, '蓄力跳', { fontSize: '17px', color: '#d8fff0', fontStyle: 'bold' }).setOrigin(0.5);
      // 攻击
      this.btnAttack = this.add.circle(W - 236, H - 92, 46, 0xffb347, 0.24).setStrokeStyle(3, 0xffb347, 0.65);
      this.btnAttackLabel = this.add.text(W - 236, H - 92, '攻击', { fontSize: '16px', color: '#ffe6bf', fontStyle: 'bold' }).setOrigin(0.5);
      // 药水
      this.btnPotion = this.add.circle(W - 86, H - 248, 34, 0x5fd0e0, 0.22).setStrokeStyle(2, 0x5fd0e0, 0.65);
      this.btnPotionLabel = this.add.text(W - 86, H - 248, '药水', { fontSize: '13px', color: '#d8f4ff' }).setOrigin(0.5);

      // 闪避（消耗体力 · 短时无敌）
      this.btnDodge = this.add.circle(W - 216, H - 268, 40, 0x5fd0e0, 0.24).setStrokeStyle(3, 0x5fd0e0, 0.65);
      this.btnDodgeLabel = this.add.text(W - 216, H - 268, '闪避', { fontSize: '15px', color: '#d8f4ff', fontStyle: 'bold' }).setOrigin(0.5);
      // 英雄技能（每层一次）
      this.btnSkill = this.add.circle(W - 300, H - 216, 38, 0x73f0b4, 0.24).setStrokeStyle(3, 0x73f0b4, 0.65);
      this.btnSkillLabel = this.add.text(W - 300, H - 216, '技能', { fontSize: '15px', color: '#d8fff0', fontStyle: 'bold' }).setOrigin(0.5);
      // 防御（按住举盾）
      this.btnGuard = this.add.circle(W - 312, H - 312, 36, 0xffd76a, 0.22).setStrokeStyle(3, 0xffd76a, 0.6);
      this.btnGuardLabel = this.add.text(W - 312, H - 312, '防御', { fontSize: '15px', color: '#fff0c8', fontStyle: 'bold' }).setOrigin(0.5);
      // 狂怒（满值才亮）
      this.btnFury = this.add.circle(W - 420, H - 240, 30, 0x6a5a30, 0.18).setStrokeStyle(3, 0xffb347, 0.5);
      this.btnFuryLabel = this.add.text(W - 420, H - 240, '狂怒', { fontSize: '13px', color: '#ffe0b0', fontStyle: 'bold' }).setOrigin(0.5);

      this.touchUI.add([this.joyBase, this.joyKnob, this.joyLabel,
        this.btnDodge, this.btnDodgeLabel,
        this.btnSkill, this.btnSkillLabel,
        this.btnGuard, this.btnGuardLabel,
        this.btnFury, this.btnFuryLabel,
        this.btnJump, this.btnJumpLabel, this.btnAttack, this.btnAttackLabel,
        this.btnPotion, this.btnPotionLabel]);
      this.touchUI.setVisible(this.isTouch);

      // 多点触控：可同时移动与跳跃
      this.input.addPointer(3);
      this.input.on('pointerdown', function (p) { self.updateInputMode(p); self.onPointerDown(p); });
      this.input.on('pointermove', function (p) { self.onPointerMove(p); });
      this.input.on('pointerup', function (p) { self.onPointerUp(p); });
      this.input.on('pointerupoutside', function (p) { self.onPointerUp(p); });

      // 每帧最后一站：把玩家在布局编辑器里关掉的单元按回去。
      // 放在 postupdate（而不是 update 里）—— update 中途有十几处 return，
      // 放里面必然会漏；postupdate 在渲染之前，也不会有「闪一帧」的问题。
      this.events.off('postupdate', this.enforceHiddenUnits, this);
      this.events.on('postupdate', this.enforceHiddenUnits, this);

      // 触摸设备：把操作提示换成触摸说明（短版 —— 横屏手机底部只剩摇杆与
      // 按键区之间一条窄缝，长句会被两头夹住；按钮上本来就有各自的名字）
      if (this.isTouch && this.hintText) {
        this.hintText.setText('摇杆移动（上推=蓄力跳）· 右下按键出手');
      }
      this.layoutTouchControls(this.scale.width, this.scale.height);
      this.applyCustomLayout();   // 玩家保存过的自定义布局，开局就叠上去
    }

    /**
     * 按输入方式自动切换控件：触摸 → 显示虚拟控件；鼠标 → 隐藏，保持画面干净
     */
    updateInputMode(p) {
      var isTouchPointer = (p.pointerType === 'touch') ||
        (p.pointerType === undefined && this.isTouch && p.wasTouch);
      if (this._lastInputWasTouch === isTouchPointer) return;
      this._lastInputWasTouch = isTouchPointer;
      if (this.touchUI) this.touchUI.setVisible(isTouchPointer);
      if (this.hintText) {
        this.hintText.setText(isTouchPointer
          ? '摇杆移动（上推=蓄力跳）· 右下按键出手'
          : 'A/D 移动 · 按住 W/空格 蓄力跳 · J 挥砍（空中=跳劈）· K 闪避 · E 技能 · L 药水');
      }
    }

    /** 触点是否命中某个圆形按钮 */
    hitCircle(p, circle, pad) {
      return Phaser.Math.Distance.Between(p.x, p.y, circle.x, circle.y) <= circle.radius + (pad || 16);
    }

    onPointerDown(p) {
      // 布局编辑模式：拖动面板 / 按钮，不触发任何战斗操作
      if (this.editMode) { this.layoutEditDown(p.x, p.y); return; }
      // 0) 悬停 / 按压状态先跟上，保证点下去的控制一定有反馈
      if (p.pointerType !== 'touch') this.updateUiHover(p);
      var hit = this.uiHitTest(p);
      if (hit) this.flashButtonDown(hit);
      // 1) 画面内界面按钮优先（死亡 / 商店 / 确认框 / 常驻功能按钮）
      if (this.handleUiClick(p)) return;
      // 2) 面板打开时不再接受战斗操作
      if (this.mapOpen || this.shopOpen || this.codexOpen || this.deathOpen || this.confirmOpen) return;
      if (!this.running || this.heroDead) return;

      // 摇杆与动作键（触摸设备）：取离触点最近的一个，而不是按固定顺序先到先得。
      // 小屏上按钮不可避免挨得近，而摇杆的容错半径又是最大的 —— 固定顺序会让
      // 「手指明明按在技能键上、触发的却是摇杆」。
      if (this.isTouch) {
        var hit = this.hitTouchButton(p);
        if (hit) {
          if (hit.role === 'joystick') {
            this.pointerRoles[p.id] = 'joystick';
            this.joyOrigin = { x: this.joyBase.x, y: this.joyBase.y };
            this.joyKnob.setPosition(this.joyBase.x, this.joyBase.y);
          } else if (hit.role === 'jump') {
            this.pointerRoles[p.id] = 'jump';
            this.touchInput.jumpHeld = true;
            this.touchInput.jumpPressed = true;
            this.btnJump.setFillStyle(0x73f0b4, 0.48);
            this.pressFeedback(this.btnJump, this.btnJumpLabel);
          } else if (hit.role === 'dodge') {
            this.pointerRoles[p.id] = 'dodge';
            this.pressFeedback(this.btnDodge, this.btnDodgeLabel);
            this.tryDodge();
          } else if (hit.role === 'skill') {
            this.pointerRoles[p.id] = 'skill';
            this.pressFeedback(this.btnSkill, this.btnSkillLabel);
            this.useSkill();
          } else if (hit.role === 'guard') {
            // 按住举盾：指针抬起才放下
            this.pointerRoles[p.id] = 'guard';
            this.touchInput.guardHeld = true;
            this.pressFeedback(this.btnGuard, this.btnGuardLabel);
          } else if (hit.role === 'fury') {
            this.pointerRoles[p.id] = 'fury';
            this.pressFeedback(this.btnFury, this.btnFuryLabel);
            this.tryFury();
          } else if (hit.role === 'attack') {
            this.pointerRoles[p.id] = 'attack';
            this.pressFeedback(this.btnAttack, this.btnAttackLabel);
            this.tryAttack();
          } else if (hit.role === 'potion') {
            this.pointerRoles[p.id] = 'potion';
            this.pressFeedback(this.btnPotion, this.btnPotionLabel);
            this.usePotion();
          }
          return;
        }
      }
      // 桌面/鼠标：点击画面即挥砍（滞空时自动变成跳劈）；触摸：点画面右侧空白处也挥砍
      if (!this.isTouch) this.tryAttack();
      else if (p.x > this.scale.width * (2 / 3) && p.y > this.scale.height * 0.25) this.tryAttack();
    }

    /**
     * 触摸按钮命中判定：返回离触点最近的那一个（无命中返回 null）
     * ------------------------------------------------------------
     * 用「距离 / 该按钮的判定半径」归一化后再比大小：
     * 这样判定半径小的按钮（攻击、技能）不会因为整体半径小而总被邻近的大按钮抢走，
     * 规则也更符合直觉 —— 手指落在哪个按钮中心附近，就是哪个按钮。
     */
    hitTouchButton(p) {
      if (this.touchUI && this.touchUI.visible === false) return null;
      // 容错半径只留 4px：按钮本身已经够大（直径 ≥46px），而 layoutTouchControls
      // 保证了视觉圆之间至少 10px 净空 —— 判定圈再各自外扩十几像素的话，
      // 相邻两键的判定就会重新叠在一起，又回到「按跳跃出攻击」。
      // 摇杆是拖动操作、且离按键区很远，所以它可以留大一点的容错。
      var cands = [
        { role: 'joystick', c: this.joyBase,   pad: 16 },
        { role: 'jump',     c: this.btnJump,   pad: 4 },
        { role: 'attack',   c: this.btnAttack, pad: 4 },
        { role: 'dodge',    c: this.btnDodge,  pad: 4 },
        { role: 'skill',    c: this.btnSkill,  pad: 4 },
        { role: 'guard',    c: this.btnGuard,  pad: 4 },
        { role: 'fury',     c: this.btnFury,   pad: 4 },
        { role: 'potion',   c: this.btnPotion, pad: 4 }
      ];
      var best = null, bestScore = Infinity;
      for (var i = 0; i < cands.length; i++) {
        var cd = cands[i];
        // 隐藏的按钮（技能未解锁 / 狂怒未满）不该响应触摸
        if (!cd.c || cd.c.visible === false) continue;
        var dist = Phaser.Math.Distance.Between(p.x, p.y, cd.c.x, cd.c.y);
        // 判定半径要跟着编辑器里的缩放走：玩家把它改小了，判定圈也得一起小，
        // 否则视觉分开了、手感还在打架（这正是「往小了改」的用处）。
        var reach = cd.c.radius * (cd.c.scaleX || 1) + cd.pad;
        if (dist > reach) continue;
        var score = dist / reach;   // 越接近中心越小
        if (score < bestScore) { bestScore = score; best = cd; }
      }
      return best;
    }

    /** 画面坐标下的矩形按钮命中测试（按列表顺序，返回首个命中的按钮） */
    hitBtnList(p, list) {
      if (!list || !list.length) return null;
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        // 编辑器里隐藏掉的按钮不参与命中：它已经不可见，却还占着一个热区，
        // 玩家点空气会开面板（"点了一下没反应 / 反而开了别的界面"）。
        if (!b || b._hidden) continue;
        var pad = b.pad || 2;
        if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - b.h / 2 - pad && p.y <= b.y + b.h / 2 + pad) return b;
      }
      return null;
    }

    /**
     * 界面点击分发（返回 true 表示已消费）
     * 层级：确认框 → 商店 → 死亡面板 → 常驻功能按钮
     */
    handleUiClick(p) {
      var pb = this.panelButtons || {};
      // 决策面板优先级最高：它是宿主推进流程的阻塞点（奖励 / 诅咒 / 事件）
      if (this.choiceOpen) {
        var chb = this.hitBtnList(p, pb.choice);
        if (chb) { sfx('click'); this.onChoiceAction(chb); }
        return true;
      }
      if (this.pauseOpen) {
        var pab = this.hitBtnList(p, pb.pause);
        if (pab) { sfx('click'); this.onPauseAction(pab.action); }
        return true;
      }
      if (this.confirmOpen) {
        var cb = this.hitBtnList(p, pb.confirm);
        if (cb) {
          sfx('click');
          if (cb.action === 'yes') this.confirmYes(); else this.confirmNo();
        }
        return true;   // 严格模态：吞掉其余点击
      }
      // 遗物条最优先：它压在 HUD 左列上，且下面就是战场 ——
      // 放在功能按钮之后判定的话，点图标会先被别的热区吃掉。
      if (!this.panelOverlayOpen()) {
        var rh = this.relicHitTest(p);
        if (rh) {
          sfx('click');
          this.openRelicPanel();
          return true;
        }
      }
      if (this.relicOpen) {
        if (this.relicView === 'stats') {
          var rsb = this.hitBtnList(p, pb.relicStats);
          if (rsb) { sfx('click'); this.onRelicAction(rsb.action); return true; }
        } else {
          var rb = this.hitBtnList(p, pb.relic);
          if (rb) { sfx('click'); this.onRelicAction(rb.action); return true; }
        }
        return true;   // 模态：吞掉其余点击（与图鉴 / 商店一致）
      }
      // 常驻功能按钮：面板打开时整行已被 syncUiBarVisibility 收起 ——
      // 命中必须同步跳过，否则会出现「点在图鉴 / 结算面板上，触发的却是
      // 藏在后面的退出试炼」这种看不见却点得到的怪事。
      if (!this.panelOverlayOpen()) {
        var hb = this.hitBtnList(p, this.hudButtons);
        if (hb) { this.onHudAction(hb.id); return true; }
      }
      if (this.shopOpen) {
        var sb = this.hitBtnList(p, pb.shop);
        if (sb) { sfx('click'); this.onShopAction(sb.action); return true; }
        var item = this.hitBtnList(p, this.shopItemRects);
        if (item) { this.buyShopItem(item.id); return true; }
        return true;
      }
      if (this.codexOpen) {
        var xb = this.hitBtnList(p, pb.codex);
        if (xb) { sfx('click'); this.onCodexAction(xb.action); return true; }
        if (this.handleCodexClick(p)) return true;
        return true;
      }
      if (this.deathOpen) {
        var db = this.hitBtnList(p, pb.death);
        if (db) { sfx('click'); this.onDeathAction(db.action); return true; }
        return true;
      }
      if (this.mapOpen) {
        var mb = this.hitBtnList(p, pb.map);
        if (mb) { sfx('click'); this.onMapAction(mb.action); return true; }
        return true;
      }
      var skb = this.hitBtnList(p, this.skillButtons);
      if (skb) { sfx('click'); this.useSkill(); return true; }
      return false;
    }

    /** 遗物详情卡片的动作分发（列表页 / 属性页共用一套动作名） */
    onRelicAction(action) {
      if (action === 'relic:close') { this.closeRelicPanel(); return; }
      if (action === 'relic:stats') {
        // 列出遗物 → 属性明细：两页互斥，切换时把另一层收干净
        this.relicView = 'stats';
        if (this.relicLayer) { this.destroyLayer('relicLayer'); this.relicLayer = null; }
        this.panelButtons.relic = [];
        this.buildRelicStatsLayer();
        return;
      }
      if (action === 'relic:statsBack') {
        // 没有遗物时不该"返回遗物列表"——那会进入一张写着"本局还没有遗物"的
        // 空卡片，而玩家本来就是从「属性」按钮直接进来的，没有列表可退。
        // 这时返回按钮的真实语义是"关闭"，按钮文案在 buildRelicStatsLayer 里
        // 已经跟着改成「返回战斗」。
        if (!(this.relics || []).length) { this.closeRelicPanel(); return; }
        this.relicView = 'list';
        if (this.relicStatsLayer) { this.destroyLayer('relicStatsLayer'); this.relicStatsLayer = null; }
        this.panelButtons.relicStats = [];
        this.buildRelicLayer();
        return;
      }
      if (action === 'relic:prev') {
        if (this.relicPage > 0) { this.relicPage--; this.buildRelicLayer(); }
        return;
      }
      if (action === 'relic:next') {
        if (this.relicPage < (this.relicPageCount || 1) - 1) { this.relicPage++; this.buildRelicLayer(); }
        return;
      }
    }

    /**
     * 盯住设置面板的开关：面板关掉后恢复战斗。
     * 用 MutationObserver 而不是定时轮询 —— 面板可能被好几种方式关掉
     * （关闭按钮 / 点遮罩 / Esc / 从里面点「打开编辑器」时它自己隐藏）。
     * 编辑模式那边自己管 running，这里只管解冻。
     */
    watchSettingsClosed() {
      var self = this;
      var modal = document.getElementById('settingsModal');
      if (!modal || typeof MutationObserver === 'undefined') { this.thawForDom(); return; }
      if (this._settingsObs) { this._settingsObs.disconnect(); this._settingsObs = null; }
      var prev = modal.classList.contains('hidden');
      this._settingsObs = new MutationObserver(function () {
        var now = modal.classList.contains('hidden');
        if (now && !prev) {
          self._settingsObs.disconnect();
          self._settingsObs = null;
          self.thawForDom();
        }
        prev = now;
      });
      this._settingsObs.observe(modal, { attributes: true, attributeFilter: ['class'] });
    }

    /**
     * DOM 面板停战 / 复战（设置面板与宿主侧边栏共用）
     * ------------------------------------------------------------
     * 为什么不用 pauseForView()：那个会 `scene.pause()`（整场景停更），
     * 恢复必须配一次 `resumeFromView()`；而 DOM 面板会被**好几种方式**关掉
     * （关闭按钮 / 遮罩 / Esc / 内部跳转），配对很容易漏 —— 漏一次就是永久卡死。
     * 这里走**逻辑冻结**：`_viewPaused` 让 update 提前返回（AI / 攻击 / 技能全停），
     * 同时显式 `physics.world.pause()`，物理也不会推着敌人继续滑。
     * 恢复只是把这两样放开，天然幂等 —— 漏调顶多是停着，不会崩。
     */
    freezeForDom() {
      this._viewPaused = true;
      this.clearStaleInput();
      if (this.touchInput) {
        this.touchInput.left = false; this.touchInput.right = false; this.touchInput.downHeld = false;
        this.touchInput.jumpHeld = false; this.touchInput.joyJumpHeld = false;
        this.touchInput.jumpPressed = false; this.touchInput.guardHeld = false;
      }
      if (this.touchUI) this.touchUI.setVisible(false);
      try { this.physics.world.pause(); } catch (e) { /* 忽略 */ }
      this.syncUiBarVisibility();
      return true;
    }

    thawForDom() {
      if (!this._viewPaused) return false;   // 幂等：重复调用不再多播一次音效
      this._viewPaused = false;
      this.clearStaleInput();
      // 别的画内面板还开着就先别放开物理（与 _resumeFromPanelPause 同一口径）
      if (!this.mapOpen && !this.shopOpen && !this.deathOpen && !this.confirmOpen &&
          !this.codexOpen && !this.choiceOpen && !this.pauseOpen && !this.relicOpen) {
        try { this.physics.world.resume(); } catch (e) { /* 忽略 */ }
      }
      if (this.touchUI) this.touchUI.setVisible(this._lastInputWasTouch === true);
      this.syncUiBarVisibility();
      return true;
    }

    /**
     * 应用 HUD 密度（v2.8.1）
     * ------------------------------------------------------------
     * 三档 + 自动：
     *   auto    按屏幕自动（默认）—— 宽屏给完整信息，窄屏自动收
     *   full    完整：属性面板 + 遗物条都常驻
     *   compact 精简：收起属性面板，但保留遗物条
     *   minimal 极简：只留生命 / 体力 / 狂怒三条，其余信息全部进详情卡片
     *
     * 存在的理由：用户的两条诉求是矛盾的 ——「要看到更多信息」与
     * 「不要让按钮和信息铺满屏幕」。这不是一道能替所有人拍板的题：
     * 大屏玩家想看全，小屏玩家想干净。做成可选之后，两边都不必被牺牲。
     */
    applyHudDensity() {
      var d = (state.settings && state.settings.hudDensity) || this.hudDensity || 'auto';
      if (d === this.hudDensity) return false;
      this.hudDensity = d;
      this.refreshRelicStrip();
      this.layoutStatPanel();
      this.layoutHudButtons(this.scale.width);
      return true;
    }

    /** 常驻功能按钮（属性 / 商店 / 图鉴 / 设置 / 菜单） */
    onHudAction(id) {
      if (id === 'stats') {
        // 「属性」= 属性明细页（8 项数值 + 说明）。属性面板收起时这是它唯一的出口，
        // 属性面板显示时它仍然是"看完整说明"的入口 —— 所以两颗常驻，不按状态隐藏。
        sfx('click');
        this.openRelicStatsPage();
        return;
      }
      if (id === 'shop') {
        if (this.shopOpen) this.closeShop(); else this.openShop();
        return;
      }
      if (id === 'codex') {
        if (this.codexOpen) this.closeCodex(); else this.openCodex();
        return;
      }
      if (id === 'settings') {
        sfx('click');
        if (typeof window.openSettingsModal !== 'function') {
          this.showCenter('设置不可用', '#ffd76a');
          return;
        }
        // 设置面板是全屏模态（z-index 114514，盖在画布上），所以必须冻结战斗 ——
        // 否则玩家在调设置时会被看不见的敌人打死。
        // freezeForDom 同时会停掉物理世界（老写法只设 _viewPaused，
        // 场景 update 虽然返回了，但 Arcade 物理仍在推着敌人滑）。
        this.freezeForDom();
        window.openSettingsModal();
        this.watchSettingsClosed();
        return;
      }
      if (id === 'menu') {
        // 菜单 = 本局中枢，就地开在画布内（宿主的 Esc 键走同一个入口，两条路径行为一致）。
        // 打开后玩家能继续 / 结束本局，也能进设置 / 作弊 / 图鉴 / 存档等一整套系统功能。
        // 已经倒下 / 正在结算时 openPauseMenu 会返回 false，落到下面的原逻辑兜底。
        if (this.openPauseMenu()) return;
        // 撤离确认要说清「现在走能拿到什么」—— 这是「稳 vs 贪」那个抉择的决策依据，
        // 不说清玩家只会觉得退出=放弃
        if (this.heroDead) {
          this.askQuit('已倒下，确认结束本局？');
        } else {
          var rw = callBridge('rewardPreview', {
            floor: this.floor, points: this.points, kills: this.kills || 0, extracted: true
          });
          this.askQuit(rw
            ? '主动撤离 ×1.25 结算：\n本次带回 ' + rw.totalGold + ' 金币 · ' + rw.totalXp + ' 经验\n继续深入产出更高，但战死只有基础倍率'
            : '确认结束本局？本局进度将结束');
        }
        return;
      }
    }

    /**
     * 是否有全屏面板正占用画面
     * ------------------------------------------------------------
     * 这些面板都是画布内的独立图层：地图 2000 / 商店 2200 / 死亡结算 2200 /
     * 图鉴 2310 / 撤离确认 2400；而常驻功能按钮行 uiBar 的层级是 2600 ——
     * 比它们全都高，于是看图鉴、看结算时这排按钮横在面板正上方，把内容盖住。
     * _viewPaused 时画面被 DOM 全屏模态（设置面板）盖住，同样让它让位。
     */
    panelOverlayOpen() {
      return !!(this.mapOpen || this.shopOpen || this.codexOpen ||
                this.deathOpen || this.confirmOpen ||
                this.choiceOpen || this.pauseOpen || this.relicOpen || this._viewPaused);
    }

    /**
     * 常驻功能按钮行（商店 / 图鉴 / 设置 / 菜单）的显隐
     * ------------------------------------------------------------
     * 面板一打开就整行收起。每个面板都自带关闭按钮（商店 / 图鉴的「关闭」、
     * 死亡结算的「商店 / 结束本局」、撤离确认的「继续战斗」），
     * 所以收起这排按钮不会把玩家困在面板里。
     * 面板打开期间战斗虽然被暂停，但场景 update 仍在跑（只有 pauseForView
     * 那条路会 `scene.pause()`，DOM 全屏面板走的是 freezeForDom 的逻辑冻结），
     * 因此统一在这里每帧对齐状态，不必去每个开关点插调用。
     */
    syncUiBarVisibility() {
      if (!this.uiBar) return;
      var want = !this.panelOverlayOpen();
      if (this.uiBar.visible !== want) this.uiBar.setVisible(want);
    }

    /** 按钮按压缩放反馈（大按钮优化：手感更明确） */
    pressFeedback(circle, label) {
      var targets = label ? [circle, label] : [circle];
      try {
        this.tweens.add({ targets: targets, scaleX: 0.9, scaleY: 0.9, duration: 70, yoyo: true });
      } catch (e) { /* 忽略 */ }
    }

    onPointerMove(p) {
      if (this.editMode) { this.layoutEditMove(p.x, p.y); return; }
      // 界面按钮悬停（鼠标设备；与触摸摇杆互不干扰）
      if (p.pointerType !== 'touch') this.updateUiHover(p);
      if (this.pointerRoles[p.id] !== 'joystick') return;
      var dx = p.x - this.joyOrigin.x;
      var dy = p.y - this.joyOrigin.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      // 摇杆的拖动行程同样跟着缩放走（编辑器里把摇杆改小了，行程也该短）
      var maxR = 58 * (this.joyBase && this.joyBase.scaleX ? this.joyBase.scaleX : 1);
      var k = dist > maxR ? maxR / dist : 1;
      this.joyKnob.setPosition(this.joyOrigin.x + dx * k, this.joyOrigin.y + dy * k);
      // 横版只需左右；留一点死区避免误触
      this.touchInput.left = dx < -12;
      this.touchInput.right = dx > 12;
      // 摇杆下推 = 空中加速下坠（地面仍是防御；见 updateHero 的 fastFall）
      this.touchInput.downHeld = dy > 34 && Math.abs(dy) > Math.abs(dx);

      // 摇杆上推 = 蓄力跳（松开摇杆即起跳），单手也能跳
      var up = dy < -34 && Math.abs(dy) > Math.abs(dx);
      if (up && !this.touchInput.joyJumpHeld) {
        this.touchInput.joyJumpHeld = true;
        this.touchInput.jumpPressed = true;
      } else if (!up && this.touchInput.joyJumpHeld) {
        this.touchInput.joyJumpHeld = false;
      }
    }

    onPointerUp(p) {
      if (this.editMode) { this.layoutEditUp(); return; }
      var role = this.pointerRoles[p.id];
      delete this.pointerRoles[p.id];
      if (role === 'joystick') {
        this.touchInput.left = false;
        this.touchInput.right = false;
        this.touchInput.downHeld = false;
        this.touchInput.joyJumpHeld = false;
        this.joyKnob.setPosition(this.joyBase.x, this.joyBase.y);
      } else if (role === 'jump') {
        this.touchInput.jumpHeld = false;
        this.btnJump.setFillStyle(0x73f0b4, 0.26);
      } else if (role === 'guard') {
        this.touchInput.guardHeld = false;
        this.btnGuard.setFillStyle(0xffd76a, 0.22);
      }
    }

    onResize(size) {
      if (!this.ready) return;
      if (!size || size.width < 40 || size.height < 40) return;   // 舞台隐藏期间容器为 0，忽略
      var W = size.width, H = size.height;
      this.floorText.setPosition(W - 24, 18);
      this.pointText.setPosition(W - 24, 42);
      this.enemyCountText.setPosition(W - 24, 64);
      if (this.roomText) this.roomText.setPosition(W - 24, 86);
      this.layoutEnvHud(W);   // 环境面板 / 诅咒条 / 脉冲倒计时（含环境面板底板重绘）
      // 触摸控件先排：底部文字要按摇杆与按键区的实际位置避让，得先知道它们在哪
      this.layoutTouchControls(W, H);
      // 药水数：摇杆占着左下角，它必须落在摇杆的判定圈之外。原来固定在 H-48，
      // 横屏落在圈里、竖屏更是直接被圆盖住（重叠 59×11）。
      var tz = this._touchZone;
      if (this.isTouch && tz) {
        this.potionText.setPosition(24, Math.max(96, Math.round(tz.joyTop) - 26));
      } else {
        this.potionText.setPosition(24, H - 48);
      }
      // 操作提示：横屏时摇杆与按键区之间只剩一条窄缝，居中摆会被两头夹住，
      // 所以放进缝里；竖屏底部空着，照常居中。
      if (this.isTouch && H < 460 && tz) {
        this.hintText.setPosition(Math.round((tz.joyRight + tz.left) / 2), H - 22);
      } else {
        this.hintText.setPosition(W / 2, H - 22);
      }
      this.centerMsg.setPosition(W / 2, H * 0.4);
      this.comboText.setPosition(W / 2, 44);
      if (this.fog) { this.fog.setSize(W * 3, 300); this.fog.setPosition(W / 2, H + 60); }
      this.layoutStatPanel(W);
      this.layoutHudButtons(W);

      // 画布高度变了（地址栏收起/展开、进出全屏、旋屏）→ 关卡是按**旧高度**铺的：
      // groundY、平台高度、地板、相机边界全都按旧尺寸算过，之后没人重算。
      // 真机实测到的典型症状：进试炼时先按 650 高建好关卡（groundY=554），
      // 画布随后缩到 334（地址栏让位）→ **地面永远留在屏幕外**，相机也无事可做。
      // 所以高度差超过阈值就按新尺寸重建当前房间（代价：本房间敌人会重置，
      // 但总比整关错位、看不见地面强）。重建走 buildLevel，不会回头调用 onResize，无递归。
      if (this.ready && this.levelWidth && Math.abs(H - (this._builtH || 0)) > 24) {
        this._builtH = H;
        this.buildLevel(this.roomNode);
        // 注意：**不能 return** —— 后面还有面板重排与 applyCustomLayout（玩家自定义的面板/按钮
        // 位置），跳过去就等于「尺寸一变，玩家调好的布局全丢」。buildLevel 不会再回调 onResize，无递归。
      }

      // HUD 下沿变了（安全线跟着变）→ 相机边界、跟随参数都要重算，
      // 否则竖屏↔横屏切换、地址栏收起等尺寸变化后会留下过时的死区/偏移。
      if (this.levelWidth) {
        this.applyCameraBounds();
        this.applyCameraFollow();
      }

      // 地图打开时按新尺寸重排（不改变地图状态）
      if (this.mapOpen && this.mapLayer) {
        this.destroyLayer('mapLayer');
        this.buildMapLayer(W, H);
      }
      // 画面内界面（死亡 / 商店 / 确认框）同样按新尺寸重排
      if (this.deathOpen) { this.destroyLayer('deathLayer'); this.buildDeathLayer(W, H); }
      if (this.shopOpen) { this.destroyLayer('shopLayer'); this.buildShopLayer(W, H); }
      if (this.codexOpen) { this.destroyLayer('codexLayer'); this.buildCodexLayer(W, H); }
      if (this.confirmOpen) { this.destroyLayer('confirmLayer'); this.buildConfirmLayer(W, H); }
      // 遗物卡片：尺寸变化会改变每页装得下几行，必须按新尺寸重画
      if (this.relicOpen) {
        if (this.relicView === 'stats') {
          if (this.relicStatsLayer) { this.destroyLayer('relicStatsLayer'); this.relicStatsLayer = null; }
          this.buildRelicStatsLayer(W, H);
        } else {
          if (this.relicLayer) { this.destroyLayer('relicLayer'); this.relicLayer = null; }
          this.buildRelicLayer(W, H);
        }
      }

      // 最后叠一层玩家自定义：上面刚把基准位置算好，这里覆盖成玩家要的位置。
      // 基准刚重算过，之前的「已应用偏移」记录必须作废 —— 不清的话 applyCustomLayout
      // 会以为偏移早就搬上去了，直接什么都不做。
      this._appliedOffset = {};
      this._invalidateEditCache();       // 基准变了，外框缓存跟着作废
      this.applyCustomLayout();
    }

    /** 遮罩层（对齐 .modal-backdrop：暗场让面板成为唯一焦点） */
    addDim(layer, W, H, alpha) {
      var r = this.add.rectangle(W / 2, H / 2, W, H, UI.dim, alpha != null ? alpha : UI.dimAlpha);
      layer.add(r);
      return r;
    }

    /**
     * 面板底板：圆角 + 1px 细描边 + 顶部内高光
     * 对齐 .modal-content（18px 圆角 / 白 12% 描边）与 .trial-player-panel（10px / 白 7%）
     */
    addPanel(layer, x, y, w, h, opts) {
      opts = opts || {};
      var r = Math.max(2, opts.radius != null ? opts.radius : UI.panelR);
      var g = this.add.graphics();
      g.fillStyle(opts.fill != null ? opts.fill : UI.panel,
        opts.fillAlpha != null ? opts.fillAlpha : UI.panelAlpha);
      g.fillRoundedRect(x, y, w, h, r);
      // 顶部内高光：让圆角面板有厚度的暗示（与胶囊、血条的高光同源）
      g.fillStyle(0xffffff, 0.03);
      g.fillRoundedRect(x + 1, y + 1, w - 2, Math.max(2, h * 0.16), Math.max(1, r - 1));
      g.lineStyle(1, opts.line != null ? opts.line : UI.panelLine,
        opts.lineAlpha != null ? opts.lineAlpha : UI.panelLineAlpha);
      g.strokeRoundedRect(x + 0.5, y + 0.5, w - 1, h - 1, r - 0.5);
      layer.add(g);
      return g;
    }

    /** 销毁某个界面层（含其中的补间） */
    destroyLayer(name) {
      var layer = this[name];
      if (!layer) return;
      var self = this;
      try { this.tweens.killTweensOf(layer); } catch (e) { /* 忽略 */ }
      if (layer.list) layer.list.forEach(function (c) { self.tweens.killTweensOf(c); });
      layer.destroy(true);
      this[name] = null;
      this._hoverBtn = null;   // 层被销毁后不能继续持有悬停按钮引用
      this._hoverRow = null;
      // 菜单层额外持有「难度胶囊」的引用（切难度只重画它们，不整层重建）——
      // 层没了就必须一起清，否则下次刷新会 paint 到已经销毁的显示对象上。
      // 统一放在这里而不是各调用点：销毁路径有四条（关闭 / 重画 / 重排 / 转屏），
      // 分散写迟早漏一条。
      if (name === 'pauseLayer') this._menuDiffBtns = null;
    }

    /**
     * 触摸控件布局
     * ------------------------------------------------------------
     * 手机横屏的空间比桌面紧张得多：6.7 寸手机的横屏 CSS 视口只有约 800×360，
     * 而右手要在里面放下攻击 / 跳跃 / 闪避 / 技能 / 防御 / 药水 / 狂怒七个键。
     * 旧版沿「右下角向外辐射」摆，七个键挤进 228×163 的一小块里：最小键直径
     * 只有 42px（低于 44px 的触摸下限），判定圈更互相重叠 25px —— 手指按在
     * 「蓄力跳」上会触发「攻击」。
     *
     * 改成「两行网格 + 半径驱动间距」：
     *   · 下排三个主键（闪避 / 跳跃 / 攻击）最大，落在拇指最顺手的右下角
     *   · 上排四个次键（药水 / 防御 / 技能 / 狂怒）略小，排成一横排
     *   · 间距全部由「实际半径 + 净空」现算，所以任何屏幕上都不会挤到一起，
     *     也不会因为屏幕比例变化而算错
     *   · 半径有绝对下限（直径 46px），小屏上按键不会缩到点不中
     *   · 整块压在屏幕右侧，把中央视野还给战斗
     * 竖屏沿用同一套规则，只是列数从 4 收到 2、行数从 2 放到 4。
     */
    layoutTouchControls(W, H) {
      if (!this.touchUI) return;

      // 半径下限 23 → 直径 46px：比这个更小手指按不准
      function rad(base, k) { return Math.max(23, Math.round(base * k)); }

      var m, gap, jr, jx, jy, zoneLeft, zoneTop;

      if (W < H * 0.85) {
        // ---------- 竖屏：摇杆独占左下，动作键收进右侧两列四行 ----------
        var kp = clamp(W / 420, 0.72, 1);
        m = Math.max(10, Math.round(14 * kp));
        gap = Math.max(8, Math.round(12 * kp));

        var pA = rad(52, kp);              // 主键
        var pB = rad(31, kp);              // 次键
        var colB = W - m - pA;             // 贴右手拇指的一列
        var colA = colB - (pA + pA + gap);
        var r1 = H - m - pA;
        var r2 = r1 - (pA + pB + gap);
        var r3 = r2 - (pB + pB + gap);
        var r4 = r3 - (pB + pB + gap);

        this.placeTouchBtn(this.btnJump, this.btnJumpLabel, colB, r1, pA, 17 * kp);
        this.placeTouchBtn(this.btnAttack, this.btnAttackLabel, colA, r1, pA, 17 * kp);
        this.placeTouchBtn(this.btnDodge, this.btnDodgeLabel, colB, r2, pB, 14 * kp);
        this.placeTouchBtn(this.btnSkill, this.btnSkillLabel, colA, r2, pB, 14 * kp);
        this.placeTouchBtn(this.btnPotion, this.btnPotionLabel, colB, r3, pB, 14 * kp);
        this.placeTouchBtn(this.btnGuard, this.btnGuardLabel, colA, r3, pB, 14 * kp);
        this.placeTouchBtn(this.btnFury, this.btnFuryLabel, colB, r4, pB, 14 * kp);

        jr = rad(60, kp);
        jx = m + jr;
        jy = H - m - jr;
        zoneLeft = colA - pA;
        zoneTop = r4 - pB;
      } else {
        // ---------- 横屏（手机横屏 / 平板 / 桌面）：两行网格 ----------
        var kk = clamp(Math.min(W / 800, H / 360), 0.9, 1.25);
        m = Math.max(10, Math.round(14 * kk));
        gap = Math.max(8, Math.round(10 * kk));

        var rA = rad(32, kk);              // 主键
        var rB = rad(25, kk);              // 次键
        var dB = rA + rA + gap;            // 主键 ↔ 主键
        var dS = rB + rB + gap;            // 次键 ↔ 次键
        var dM = rA + rB + gap;            // 上下两行之间

        var col3 = W - m - rA;
        var col2 = col3 - dB;
        var col1 = col2 - dB;
        var col0 = col1 - dS;
        var rowA = H - m - rA;
        var rowB = rowA - dM;

        // 下排：攻击占最右下的拇指位，跳跃与闪避在其左
        this.placeTouchBtn(this.btnDodge, this.btnDodgeLabel, col1, rowA, rA, 15 * kk);
        this.placeTouchBtn(this.btnJump, this.btnJumpLabel, col2, rowA, rA, 15 * kk);
        this.placeTouchBtn(this.btnAttack, this.btnAttackLabel, col3, rowA, rA, 15 * kk);
        // 上排：低频 / 条件键，排成一横排
        this.placeTouchBtn(this.btnPotion, this.btnPotionLabel, col0, rowB, rB, 13 * kk);
        this.placeTouchBtn(this.btnGuard, this.btnGuardLabel, col1, rowB, rB, 13 * kk);
        this.placeTouchBtn(this.btnSkill, this.btnSkillLabel, col2, rowB, rB, 13 * kk);
        this.placeTouchBtn(this.btnFury, this.btnFuryLabel, col3, rowB, rB, 13 * kk);

        jr = rad(48, kk);
        jx = m + jr;
        jy = H - m - jr;
        zoneLeft = col0 - rB;
        zoneTop = rowB - rB;
      }

      this.joyBase.setRadius(jr).setPosition(jx, jy);
      this.joyKnob.setRadius(Math.round(jr * 0.45)).setPosition(jx, jy);
      this.joyLabel.setFontSize(Math.max(13, Math.round(jr * 0.34))).setPosition(jx, jy);

      // 供 onResize 摆底部文字：记下摇杆半径与按键区左上角，好把文字放进两者之间的空档
      this._joyR = jr;
      this._touchZone = { left: zoneLeft, top: zoneTop, joyRight: jx + jr, joyTop: jy - jr };
    }

    /** 摆放一个圆形触摸键（圆本体 + 居中标签） */
    placeTouchBtn(circle, label, x, y, r, fontPx) {
      if (circle) circle.setRadius(r).setPosition(x, y);
      if (label) label.setFontSize(Math.max(11, Math.round(fontPx))).setPosition(x, y);
    }

    /* ============================================================
       自定义布局（设置 → 2D 试炼按键自定义）
       ------------------------------------------------------------
       分工：布局函数（layoutTouchControls / layoutHudButtons / layoutEnvHud …）
       算出「响应式基准位置」，这一层在基准之上叠加玩家的偏移 / 缩放 /
       透明度 / 隐藏。

       为什么要分层：基准永远由布局函数算，玩家的自定义只是一层覆盖 ——
       换分辨率、转屏、切视图都不会把布局算坏。而 applyCustomLayout 总是
       紧跟在布局之后调用，所以「基准 + 偏移」每次都是从同一个起点重算
       （幂等），拖动时不会越拖越偏。

       坐标按屏幕比例（0~1）保存，同一份配置在任何分辨率下都成立。
       ============================================================ */

    /** 读取玩家保存的布局；返回 { 单元id: {dx,dy,s,a,v} } */
    loadCustomLayout() {
      if (this.customLayout) return this.customLayout;
      var items = {};
      try {
        var raw = localStorage.getItem(LAYOUT_KEY);
        var d = raw ? JSON.parse(raw) : null;
        if (d && d.items && typeof d.items === 'object') items = d.items;
      } catch (e) { /* 读坏了就按默认布局走 */ }
      this.customLayout = items;
      return items;
    }

    saveCustomLayout() {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({ v: 1, items: this.customLayout || {} }));
      } catch (e) { /* 隐私模式写不进去，本次会话内仍然生效 */ }
    }

    /**
     * 去抖保存
     * ------------------------------------------------------------
     * 缩放 / 透明度滑杆拖一次会甩出几十个 input 事件，原来每个都同步
     * JSON.stringify + localStorage.setItem —— 那是**同步磁盘 I/O**，会把主线程
     * 堵住，手机上滑起来就是一顿一顿的。积到停手之后再落盘一次即可；
     * 退出编辑时还会立刻补一次（见 exitLayoutEdit），不会丢。
     */
    saveCustomLayoutSoon() {
      var self = this;
      if (this._saveTimer) clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(function () {
        self._saveTimer = null;
        self.saveCustomLayout();
      }, 250);
    }

    /** 取（必要时建）某一项的配置 */
    layoutEntry(id, create) {
      var L = this.loadCustomLayout();
      if (!L[id] && create) L[id] = { dx: 0, dy: 0, s: 1, a: 1, v: true };
      return L[id];
    }

    /** 该项是否被玩家改过 */
    isCustomized(id) {
      var c = (this.customLayout || {})[id];
      if (!c) return false;
      return !!(c.dx || c.dy || (c.s != null && c.s !== 1) ||
                (c.a != null && c.a !== 1) || c.v === false);
    }

    /**
     * 可编辑单元表
     * ------------------------------------------------------------
     * 每个单元 = 「一组一起移动、一起缩放的对象」。三类部件互不重叠，
     * 避免同一个对象被平移两次：
     *   meters → 走 placeMeter（血条的子对象由它统一重新定位）
     *   btns   → 数据按钮，改 x/y 后重绘
     *   objs   → 普通显示对象，直接平移 x/y
     * style 是「缩放 / 透明度 / 隐藏」的作用对象（含上面那些子对象）。
     * apply 用于位置由别处变量决定的特殊情况：生命数值这类文本每次
     * refreshHud 都会用 meterTextX 重新摆位，直接挪文本会被下一次刷新弹回去，
     * 所以必须改源头。
     */
    editableUnits() {
      var self = this;
      var U = [];
      function unit(id, label, group, o) {
        o.id = id; o.label = label; o.group = group;
        o.objs = o.objs || []; o.meters = o.meters || []; o.btns = o.btns || [];
        if (!o.style) {
          o.style = o.objs.slice();
          // 血条类单元：meter 的填充 / 拖影 / 底槽也要能缩放，否则「生命条」
          // 只有旁边的数字在缩，条本身纹丝不动。
          // 它们的纹理宽度就是条宽（placeMeter 用 setDisplaySize(w,h) 后 scale 恰为 1），
          // 所以直接 setScale 就是等比缩小；paintMeter 只动裁剪（纹理坐标），不受影响。
          // 唯独 glow 用固定尺寸纹理、scale 不等于 1，再叠一层会把它算成一个小点，必须排除。
          o.meters.forEach(function (m) {
            if (!m) return;
            ['track', 'trailImg', 'fill'].forEach(function (k) { if (m[k]) o.style.push(m[k]); });
          });
        }
        o.anchor = function () {
          if (o.anchorMeter) return { x: o.anchorMeter.x, y: o.anchorMeter.y };
          if (o.anchorBtn) return { x: o.anchorBtn.x, y: o.anchorBtn.y };
          if (o.anchorObj) return { x: o.anchorObj.x, y: o.anchorObj.y };
          return { x: 0, y: 0 };
        };
        U.push(o);
      }

      // ---------- 触摸按钮 ----------
      unit('t.joy', '摇杆', '按钮', { objs: [this.joyBase, this.joyKnob, this.joyLabel], anchorObj: this.joyBase });
      unit('t.jump', '蓄力跳', '按钮', { objs: [this.btnJump, this.btnJumpLabel], anchorObj: this.btnJump });
      unit('t.attack', '攻击', '按钮', { objs: [this.btnAttack, this.btnAttackLabel], anchorObj: this.btnAttack });
      unit('t.dodge', '闪避', '按钮', { objs: [this.btnDodge, this.btnDodgeLabel], anchorObj: this.btnDodge });
      unit('t.potion', '药水键', '按钮', { objs: [this.btnPotion, this.btnPotionLabel], anchorObj: this.btnPotion });
      unit('t.guard', '防御', '按钮', { objs: [this.btnGuard, this.btnGuardLabel], anchorObj: this.btnGuard });
      unit('t.skill', '技能键', '按钮', { objs: [this.btnSkill, this.btnSkillLabel], anchorObj: this.btnSkill });
      unit('t.fury', '狂怒', '按钮', { objs: [this.btnFury, this.btnFuryLabel], anchorObj: this.btnFury });

      // ---------- 左上：主角状态 ----------
      unit('h.name', '主角名', '信息面板', { objs: [this.nameText], anchorObj: this.nameText });
      unit('h.hp', '生命条', '信息面板', {
        meters: [this.heroMeter, this.shieldMeter],
        objs: [this.hpText, this.shieldText],
        anchorMeter: this.heroMeter,
        apply: function (dx, dy) {
          // ⚠️ 横向**不能**再叠加 dx（第 10 条）
          // ------------------------------------------------------------
          // 这几个数值的实际 x 由 meterTextX() 现算（= 条的右边缘 + gap），
          // 而条本身已经跟着 ddx 移动过了 —— 这里再给 gap 加一次，数字就会
          // 比条多走一倍距离，"文字不贴着条"就是这么来的。
          // 纵向没有现算逻辑（y 是布局时算好的），仍然要跟着 dy 走。
          if (self._hpTextY != null) self._hpTextY += dy;
        }
      });
      unit('h.stam', '体力条', '信息面板', {
        meters: [this.staminaMeter], objs: [this.staminaText, this.staminaTip],
        anchorMeter: this.staminaMeter,
        apply: function (dx, dy) {
          if (self._stamTextY != null) self._stamTextY += dy;   // 横向同上：由 meterTextX 现算
        }
      });
      unit('h.fury', '狂怒条', '信息面板', {
        meters: [this.furyMeter], objs: [this.furyText, this.furyHint],
        anchorMeter: this.furyMeter,
        apply: function (dx, dy) {
          // 狂怒数值与生命 / 体力**同一口径**：x 由 meterTextX 现算，只跟纵向
          if (self.furyTextPos) self.furyTextPos.y += dy;
          // 满怒提示「按 R · 狂怒爆发」是绝对坐标（贴在条左端下方），横向仍要跟
          if (self.furyHintPos) { self.furyHintPos.x += dx; self.furyHintPos.y += dy; }
        }
      });
      // 属性面板 / 环境面板 / 诅咒面板 / 目标面板都是 Container：
      // 内部子对象按局部坐标排，整体挪容器即可，不会干扰内部布局
      unit('h.stats', '属性面板', '信息面板', { objs: [this.statPanel], anchorObj: this.statPanel });
      unit('h.skillChip', '技能胶囊', '信息面板', { btns: [this.skillBtn], anchorBtn: this.skillBtn });
      // 功能按钮行：一颗按钮一个单元（原来整行是一个单元，只能一起挪，
      // 玩家没法只把「退出试炼」挪开、也没法只把某一颗缩小）
      (this.hudButtons || []).forEach(function (b) {
        if (!b) return;
        unit('h.fn.' + b.id, HUD_BTN_LABELS[b.id] || b.id, '功能按钮',
          { btns: [b], anchorBtn: b });
      });
      unit('h.potion', '药水数量', '信息面板', { objs: [this.potionText], anchorObj: this.potionText });

      // ---------- 右上：试炼信息（一行一个单元）----------
      unit('h.info.floor', '层数', '信息面板', { objs: [this.floorText], anchorObj: this.floorText });
      unit('h.info.point', '金币', '信息面板', { objs: [this.pointText], anchorObj: this.pointText });
      unit('h.info.enemy', '敌人数', '信息面板', { objs: [this.enemyCountText], anchorObj: this.enemyCountText });
      if (this.roomText) {
        unit('h.info.room', '房间 · 已探索', '信息面板', { objs: [this.roomText], anchorObj: this.roomText });
      }
      unit('h.env', '环境面板', '信息面板', { objs: [this.envPanel], anchorObj: this.envPanel });
      unit('h.curse', '诅咒面板', '信息面板', { objs: [this.cursePanel], anchorObj: this.cursePanel });
      unit('h.pulse', '脉冲倒计时', '信息面板', { objs: [this.pulseText], anchorObj: this.pulseText });

      // ---------- 战斗相关 ----------
      unit('h.target', '目标敌人面板', '战斗', { objs: [this.targetPanel], anchorObj: this.targetPanel });
      unit('h.boss', '层主血条', '战斗', {
        meters: [this.bossMeter], objs: [this.bossName, this.bossText], anchorMeter: this.bossMeter,
        apply: function (dx, dy) {
          self.bossName.setPosition(self.bossName.x + dx, self.bossName.y + dy);
          if (self.bossText) self.bossText.setPosition(self.bossText.x + dx, self.bossText.y + dy);
        }
      });
      unit('h.hint', '操作提示', '战斗', { objs: [this.hintText], anchorObj: this.hintText });
      unit('h.combo', '连击数', '战斗', { objs: [this.comboText], anchorObj: this.comboText });

      return U.filter(function (u) {
        return u.anchorObj || u.anchorMeter || u.anchorBtn ||
               u.objs.length || u.meters.length || u.btns.length;
      });
    }

    /**
     * 把玩家的自定义叠到当前布局上。
     * 必须在所有布局函数之后调用（onResize / relayoutForEdit / beginRun）。
     */
    applyCustomLayout() {
      var L = this.loadCustomLayout();
      var W = this.scale.width, H = this.scale.height;
      if (W < 40 || H < 40) return;
      var self = this;
      this.editableUnits().forEach(function (u) {
        var c = L[u.id];
        var s = (c && c.s != null) ? c.s : 1;
        var a = (c && c.a != null) ? c.a : 1;
        var hide = !!(c && c.v === false);
        var dx = c ? (c.dx || 0) * W : 0;
        var dy = c ? (c.dy || 0) * H : 0;

        // 只在「偏移量本身变了」的时候才搬一次，而且搬的是**差量**。
        // 原来直接在当前坐标上累加：这个方法每被调用一次，整个单元就往自定义方向
        // 再走一截 —— 玩家什么都不做，狂怒条和旁边的数字也会一直往右飘。
        if (!self._appliedOffset) self._appliedOffset = {};
        var prevOff = self._appliedOffset[u.id] || { dx: 0, dy: 0 };
        var ddx = dx - prevOff.dx, ddy = dy - prevOff.dy;
        if (ddx || ddy) {
          u.meters.forEach(function (m) { if (m && m.fill) self.placeMeter(m, m.x + ddx, m.y + ddy, m.w); });
          u.btns.forEach(function (b) { if (!b) return; b.x += ddx; b.y += ddy; self.paintButton(b); });
          u.objs.forEach(function (o) { if (o) { o.x += ddx; o.y += ddy; } });
          if (u.apply) u.apply(ddx, ddy);
        }
        self._appliedOffset[u.id] = { dx: dx, dy: dy };
        // 取消隐藏时要把可见性还原回来 —— 但只还原「我们自己隐藏过的」，
        // 免得盖掉技能未解锁 / 狂怒未满这类游戏逻辑
        var wasHidden = !!(self._hiddenUnits && self._hiddenUnits[u.id]);
        // 记录上一次真正写进样式层的值。
        // 原来只在「值为非默认」时才写，于是把缩放从 40% 拖回 100% 毫无反应 ——
        // 滑块在动、画面不动，玩家只会以为编辑器坏了。改成跟上一帧的值比：
        // 只要变了就写，包括「写回默认」。
        if (!self._appliedStyle) self._appliedStyle = {};
        var prev = self._appliedStyle[u.id] || { s: 1, a: 1, hide: false };
        if (s !== prev.s || a !== prev.a || hide !== prev.hide || wasHidden) {
          u.style.forEach(function (o) {
            if (!o || !o.setScale) return;
            if (s !== prev.s) {
              o.setScale(s);
              sharpenScaledText(o, s);
            }
            if (a !== prev.a) o.setAlpha(a);
            if (hide) o.setVisible(false);
            else if (prev.hide || wasHidden) o.setVisible(true);
          });
          // 按钮类单元：缩放 / 透明 / 显隐走 applyButtonStyle（见那里的说明），
          // 不能用 setScale —— 底板画在 Graphics 的绝对坐标上。
          u.btns.forEach(function (b) {
            if (!b) return;
            self.applyButtonStyle(b, s, a, hide);
            // applyButtonStyle 是**按 slotCenter 绝对定位**的，会把按钮摆回基准位置，
            // 连玩家拖出来的偏移一起抹掉 —— 表现就是「摆好的按钮一改缩放就跳回原位」。
            // 上面位置分支已经算好本轮该有的总偏移，这里补回去。
            var off = self._appliedOffset[u.id];
            if (off && (off.dx || off.dy)) {
              b.x += off.dx; b.y += off.dy;
              self.paintButton(b);
            }
          });
          self._appliedStyle[u.id] = { s: s, a: a, hide: hide };
        }
        if (hide) {
          if (!self._hiddenUnits) self._hiddenUnits = {};
          if (!self._hiddenStyles) self._hiddenStyles = {};
          self._hiddenUnits[u.id] = true;
          // 记下这批对象：有些单元（目标敌人面板 / 层主血条 / 环境面板 / 连击数）
          // 的战斗逻辑每帧都在 setVisible(true)，玩家在编辑器里关掉它们一进战斗就被顶回来。
          // 每帧末尾由 enforceHiddenUnits() 按这份清单把它们按回去。
          // 按钮类的部件（底板 Graphics / 文字 / 图标）不在 style 里，单独补上。
          var parts = u.style.slice();
          u.btns.forEach(function (b) {
            if (!b) return;
            if (b.gfx) parts.push(b.gfx);
            if (b.text) parts.push(b.text);
            if (b.icon) parts.push(b.icon);
          });
          self._hiddenStyles[u.id] = parts;
        } else if (self._hiddenUnits) {
          delete self._hiddenUnits[u.id];
          if (self._hiddenStyles) delete self._hiddenStyles[u.id];
        }
      });
    }

    /**
     * 落实「玩家在编辑器里关掉的那些单元」
     * ------------------------------------------------------------
     * 挂在场景的 postupdate 上：这是 update() 所有 return 之后的最后一站，
     * 渲染又排在它后面，所以不必去每个 setVisible(true) 处插判断也不会漏，
     * 更不会出现「先显示一帧再被按回去」的闪烁。
     */
    enforceHiddenUnits() {
      var S = this._hiddenStyles;
      if (!S) return;
      for (var id in S) {
        var arr = S[id];
        if (!arr) continue;
        for (var i = 0; i < arr.length; i++) {
          var o = arr[i];
          if (o && o.setVisible && o.visible !== false) o.setVisible(false);
        }
      }
    }

    /** 重算基准布局并重新叠加自定义（编辑时拖动一下就调一次） */
    relayoutForEdit() {
      var W = this.scale.width, H = this.scale.height;
      if (W < 40 || H < 40) return;
      // 与 onResize 里保持一致：先把固定坐标的文本摆回基准
      this.nameText.setPosition(24, 12);
      this.floorText.setPosition(W - 24, 18);
      this.pointText.setPosition(W - 24, 42);
      this.enemyCountText.setPosition(W - 24, 64);
      if (this.roomText) this.roomText.setPosition(W - 24, 86);
      this.comboText.setPosition(W / 2, 44);
      this.centerMsg.setPosition(W / 2, H * 0.4);

      this.layoutTouchControls(W, H);
      var tz = this._touchZone;
      if (this.isTouch && tz) {
        this.potionText.setPosition(24, Math.max(96, Math.round(tz.joyTop) - 26));
      } else {
        this.potionText.setPosition(24, H - 48);
      }
      if (this.isTouch && H < 460 && tz) {
        this.hintText.setPosition(Math.round((tz.joyRight + tz.left) / 2), H - 22);
      } else {
        this.hintText.setPosition(W / 2, H - 22);
      }
      this.layoutStatPanel(W);
      this.layoutHudButtons(W);
      this.layoutEnvHud(W);
      // 基准刚重算过，作废「已应用偏移」记录（见 applyCustomLayout）
      this._appliedOffset = {};
      this._invalidateEditCache();       // 基准变了，外框缓存跟着作废
      this.applyCustomLayout();
    }

    /* ============================================================
       布局编辑模式
       ------------------------------------------------------------
       进入后冻结战斗（不然一边挨打一边调布局），所有可编辑单元画上外框：
       白色 = 默认，金色 = 改过，绿色 = 当前选中。拖动即移动，配合
       底部工具条调缩放 / 透明度 / 显隐。
       ============================================================ */

    enterLayoutEdit() {
      if (this.editMode) return true;
      if (!this.ready) return false;
      this.loadCustomLayout();
      this.editMode = true;
      this.editSel = null;
      this.editDrag = null;
      this._invalidateEditCache();       // 单元表 / 外框缓存按本次编辑重建
      this._editWasRunning = this.running;
      this.running = false;              // 冻住战斗
      this.clearStaleInput();
      if (!this.editGfx) this.editGfx = this.add.graphics().setDepth(9000).setScrollFactor(0);
      this.editGfx.setVisible(true);
      this.drawEditOverlay();
      if (window.Trial2DLayoutBar) window.Trial2DLayoutBar.open(this);
      return true;
    }

    exitLayoutEdit(save) {
      if (!this.editMode) return;
      this.editMode = false;
      this.editDrag = null;
      // 去抖保存还挂着的话立刻补上：不然「拖完滑杆马上点完成」会丢掉最后一次
      if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
      if (this._lbSyncTimer) { clearTimeout(this._lbSyncTimer); this._lbSyncTimer = null; }
      if (this.editGfx) this.editGfx.setVisible(false).clear();
      this.running = !!this._editWasRunning && !this._finished;
      if (save !== false) this.saveCustomLayout();
      if (window.Trial2DLayoutBar) window.Trial2DLayoutBar.close();
      this.relayoutForEdit();
    }

    /** 单元当前的外框（拾取与画框共用） */
    unitBounds(u) {
      // 不依赖 getBounds() 返回值的类型：Phaser 各显示对象的 getBounds 实现不一，
      // 有的返回的对象没有 clone()。手动求并集最稳。
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
      function add(b) {
        if (!b || !(b.width > 0) || !(b.height > 0)) return;
        any = true;
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.width > maxX) maxX = b.x + b.width;
        if (b.y + b.height > maxY) maxY = b.y + b.height;
      }
      u.objs.forEach(function (o) { if (o && o.getBounds) { try { add(o.getBounds()); } catch (e) {} } });
      u.meters.forEach(function (m) { if (m && m.track) { try { add(m.track.getBounds()); } catch (e) {} } });
      u.btns.forEach(function (b) { if (b) add({ x: b.x, y: b.y - b.h / 2, width: b.w, height: b.h }); });
      if (!any) return null;
      return new Phaser.Geom.Rectangle(minX, minY, maxX - minX, maxY - minY);
    }

    /** 命中测试：后声明的优先（多为更靠上的小元素），避免大面板吃掉小按钮 */
    unitAt(px, py) {
      var U = this._editUnits();
      var B = this._editBounds;
      for (var i = U.length - 1; i >= 0; i--) {
        var r = (B && B[U[i].id]) || this.unitBounds(U[i]);
        if (r && Phaser.Geom.Rectangle.Contains(r, px, py)) return U[i];
      }
      return null;
    }

    /* ============================================================
       拖动热路径
       ------------------------------------------------------------
       拖动**不能**每帧跑全量重排。relayoutForEdit 会把整个 HUD 从基准重算一遍
       （摇杆 / 属性面板 / 环境面板 / 功能按钮行 / 三条槽 ……），而拖动只改变
       **一个**单元的偏移 —— 原来每个 pointermove 都要付这一整套：

         重排 1.5ms + 全量画框 0.8ms + DOM 同步 0.5ms（还会触发样式重算）

       触摸设备一帧内往往不止一个 move 事件（120Hz 采样 / 高刷屏），于是一帧
       要付好几套，直接顶穿 16.7ms 的帧预算 —— 手感就是「提起来一卡一卡、
       跟不上手指」。另外每帧重建 editableUnits 会造出上百个闭包，触发
       周期性 GC，卡顿还会一顿一顿地来。

       所以拆开：位置只搬被拖的那一个单元、外框只重算它的包围盒、
       DOM 拖动期间完全不动（松手同步一次）、吸附改到松手时做。
       ============================================================ */

    /** 编辑期间复用的单元表：拖动时每帧都要按 id 找单元，不必每次重建 */
    _editUnits() {
      if (!this._editUnitsCache) this._editUnitsCache = this.editableUnits();
      return this._editUnitsCache;
    }

    _findEditUnit(id) {
      var U = this._editUnits();
      for (var i = 0; i < U.length; i++) if (U[i].id === id) return U[i];
      return null;
    }

    /** 基准布局变了（重排 / 转屏）：单元表与外框缓存都必须重建 */
    _invalidateEditCache() {
      this._editUnitsCache = null;
      this._editBounds = null;
      this._editBoundsDirty = true;
    }

    /** 把某个单元的显示对象整体搬 ddx/ddy，并同步「已应用偏移」记录 */
    _shiftUnit(id, ddx, ddy) {
      if (!ddx && !ddy) return false;
      var u = this._findEditUnit(id);
      if (!u) return false;
      var self = this;
      u.meters.forEach(function (m) { if (m && m.fill) self.placeMeter(m, m.x + ddx, m.y + ddy, m.w); });
      u.btns.forEach(function (b) { if (!b) return; b.x += ddx; b.y += ddy; self.paintButton(b); });
      u.objs.forEach(function (o) { if (o) { o.x += ddx; o.y += ddy; } });
      if (u.apply) u.apply(ddx, ddy);
      if (!this._appliedOffset) this._appliedOffset = {};
      var p = this._appliedOffset[id];
      if (!p) p = this._appliedOffset[id] = { dx: 0, dy: 0 };
      p.dx += ddx; p.dy += ddy;
      return true;
    }

    /** 偏移记录与显示对象一起走（拖动、松手吸附补零头都走这里） */
    _moveUnitBy(id, ddx, ddy) {
      var W = this.scale.width, H = this.scale.height;
      if (W < 40 || H < 40 || (!ddx && !ddy)) return false;
      var c = this.layoutEntry(id, true);
      c.dx = (c.dx || 0) + ddx / W;
      c.dy = (c.dy || 0) + ddy / H;
      return this._shiftUnit(id, ddx, ddy);
    }

    /** 只重算一个单元的外框再整体重画（其余用缓存） */
    _redrawUnitFrame(id) {
      if (!this._editBounds) { this.drawEditOverlay(); return; }
      var u = this._findEditUnit(id);
      if (!u) return;
      this._editBounds[id] = this.unitBounds(u);
      this.drawEditOverlay();
    }

    layoutEditDown(px, py) {
      var u = this.unitAt(px, py);
      this.editSel = u ? u.id : null;
      this.editDrag = u ? { id: u.id, lastX: px, lastY: py, moved: false } : null;
      this.drawEditOverlay();
      this.notifyLayoutBar();
      return !!u;
    }

    layoutEditMove(px, py) {
      if (!this.editDrag) return false;
      var dx = px - this.editDrag.lastX, dy = py - this.editDrag.lastY;
      if (!dx && !dy) return false;
      this.editDrag.lastX = px; this.editDrag.lastY = py;
      this.editDrag.moved = true;
      // 拖动过程**不吸附**：4px 步进会让位移一格一格地跳，手感就是「涩、不跟手」。
      // 吸附改到松手时补一次（见 layoutEditUp），既跟手又能对齐。
      this._moveUnitBy(this.editDrag.id, dx, dy);
      this._redrawUnitFrame(this.editDrag.id);
      return true;
    }

    layoutEditUp() {
      if (!this.editDrag) return false;
      var d = this.editDrag;
      this.editDrag = null;
      if (!d.moved) return false;
      var W = this.scale.width, H = this.scale.height;
      // 松手吸附到 4px 网格：手指拖动本来就有几像素误差，不吸附容易摆歪
      if (this.editSnap !== false && W >= 40 && H >= 40) {
        var c = this.layoutEntry(d.id, false);
        if (c) {
          var sx = Math.round(c.dx * W / 4) * 4 / W;
          var sy = Math.round(c.dy * H / 4) * 4 / H;
          var ex = (sx - c.dx) * W, ey = (sy - c.dy) * H;
          if (ex || ey) {
            c.dx = sx; c.dy = sy;
            this._shiftUnit(d.id, ex, ey);
            this._redrawUnitFrame(d.id);
          }
        }
      }
      this.saveCustomLayout();
      // DOM 侧拖动期间一律不动，松手同步一次就够：chip 的「已改 / 选中」标记
      // 拖动过程中本来也不看，而每帧改 31 个 chip 的 class 会引来样式重算
      this.notifyLayoutBar();
      return true;
    }

    /** 工具条改值（缩放 / 透明度 / 显隐） */
    setLayoutValue(id, key, v) {
      var c = this.layoutEntry(id, true);
      c[key] = v;
      this.relayoutForEdit();
      this.drawEditOverlay();
      this.saveCustomLayoutSoon();
      this.syncLayoutBarSoon();
    }

    /** 重置：给 id 就重置那一项，不给就全部 */
    resetCustomLayout(id) {
      var self = this;
      var ids = id ? [id] : Object.keys(this.loadCustomLayout());
      if (id) {
        delete this.loadCustomLayout()[id];
      } else {
        this.customLayout = {};
      }
      this.relayoutForEdit();
      // relayoutForEdit 里的 applyCustomLayout 现在会跟上一帧的记录比对，「改回默认」
      // 也能写回去了；这里再显式推一次是为了立刻生效，不依赖下一帧。
      var byId = {};
      this.editableUnits().forEach(function (u) { byId[u.id] = u; });
      ids.forEach(function (x) {
        var u = byId[x];
        if (!u) return;
        var wasHidden = !!(self._hiddenUnits && self._hiddenUnits[x]);
        u.style.forEach(function (o) {
          if (!o || !o.setScale) return;
          o.setScale(1);
          o.setAlpha(1);
          if (wasHidden) o.setVisible(true);
        });
        // ⚠️ 血条的子对象宽高是靠 setDisplaySize（本质就是 scaleX/scaleY）摆出来的，
        //    上面那句 setScale(1) 会把它们放大回**纹理**宽度：252 → 256（纹理按 8 对齐），
        //    于是点一下「重置」，条就粗了 4px、旁边的数值也跟着右移 4px。
        //    这里按逻辑宽高重新摆一次，把几何还回去。
        u.meters.forEach(function (m) {
          if (!m) return;
          if (m.track) m.track.setDisplaySize(m.w, m.trackH);
          if (m.fill) m.fill.setDisplaySize(m.w, m.fillH);
          if (m.trailImg) m.trailImg.setDisplaySize(m.w, m.fillH);
        });
        // 按钮类单元：样式走 applyButtonStyle（尺寸在数据上，不在 scale 上）
        u.btns.forEach(function (b) { if (b) self.applyButtonStyle(b, 1, 1, false); });
        if (self._hiddenUnits) delete self._hiddenUnits[x];
        if (self._hiddenStyles) delete self._hiddenStyles[x];
        if (self._appliedStyle) delete self._appliedStyle[x];
      });
      this.drawEditOverlay();
      this.saveCustomLayout();
      this.notifyLayoutBar();
    }

    /** 导出当前布局（方便备份 / 换机） */
    exportCustomLayout() {
      return JSON.stringify({ v: 1, items: this.loadCustomLayout() }, null, 2);
    }

    /** 导入布局；非法内容一律拒绝，不落盘 */
    importCustomLayout(text) {
      try {
        var d = JSON.parse(text);
        if (!d || typeof d !== 'object' || !d.items || typeof d.items !== 'object') return false;
        var clean = {};
        Object.keys(d.items).forEach(function (k) {
          var v = d.items[k];
          if (!v || typeof v !== 'object') return;
          clean[k] = {
            dx: Number(v.dx) || 0, dy: Number(v.dy) || 0,
            s: v.s == null ? 1 : Math.max(0.2, Math.min(2.5, Number(v.s) || 1)),
            a: v.a == null ? 1 : Math.max(0.1, Math.min(1, Number(v.a) || 1)),
            v: v.v !== false
          };
        });
        this.customLayout = clean;
        this.relayoutForEdit();
        this.drawEditOverlay();
        this.saveCustomLayout();
        this.notifyLayoutBar();
        return true;
      } catch (e) { return false; }
    }

    drawEditOverlay() {
      var g = this.editGfx;
      if (!g || !this.editMode) return;
      var self = this;
      var U = this._editUnits();
      // 包围盒缓存：unitBounds 要对每个显示对象调 getBounds（Container 还要遍历
      // 子节点），是这里最贵的一步。编辑期间基准不变、框也就不会变，没必要每帧
      // 把这 30 多个单元重算一遍 —— 只有被拖动的那一个由 _redrawUnitFrame 更新。
      if (!this._editBounds || this._editBoundsDirty) {
        this._editBounds = {};
        U.forEach(function (u) { self._editBounds[u.id] = self.unitBounds(u); });
        this._editBoundsDirty = false;
      }
      g.clear();
      U.forEach(function (u) {
        var r = self._editBounds[u.id];
        if (!r) return;
        var sel = (u.id === self.editSel);
        var on = self.isCustomized(u.id);
        g.lineStyle(sel ? 2 : 1, sel ? 0x73f0b4 : (on ? 0xffd76a : 0xffffff), sel ? 1 : (on ? 0.62 : 0.26));
        if (sel) { g.fillStyle(0x73f0b4, 0.1); g.fillRect(r.x - 2, r.y - 2, r.width + 4, r.height + 4); }
        g.strokeRect(r.x - 2, r.y - 2, r.width + 4, r.height + 4);
      });
    }

    notifyLayoutBar() {
      if (window.Trial2DLayoutBar) window.Trial2DLayoutBar.sync(this);
    }

    /**
     * DOM 同步去抖到「一帧最多一次」
     * ------------------------------------------------------------
     * 滑杆拖一下会甩出几十个 input 事件，每个都同步一遍工具条（31 个 chip 的
     * class 开关 + 一串文本）纯属白做 —— chip 上的「已改 / 选中」标记本来也
     * 不需要比一帧更频繁。用 setTimeout(0) 而不是 rAF：页面被切到后台时 rAF
     * 会停，挂着的标记就再也清不掉，同步会永久卡死。
     */
    syncLayoutBarSoon() {
      var self = this;
      if (this._lbSyncTimer) return;
      this._lbSyncTimer = setTimeout(function () {
        self._lbSyncTimer = null;
        if (self.editMode) self.notifyLayoutBar();
      }, 0);
    }

    // ---------- 开局 / 结束 ----------
    beginRun(d) {
      d = d || {};
      this.points = d.points || 0;
      this.running = true;
      this.heroDead = false;
      // 正常一局：退出调试单房间模式（预览页会在 buildDebugRoom 里重新打开）
      this.previewMode = false;
      this.previewEnded = false;
      // 新一局：体力回满、闪避状态清空
      this.hero.stamina = this.hero.maxStamina;
      this.hero.perfectCount = 0;
      this.dodging = false; this.dodgeReadyAt = 0; this.perfectUntil = 0;
      this.staminaHoldUntil = 0; this._staminaShown = this.hero.maxStamina;
      // 新一局：防御与连招状态清空
      this.lowerGuard();
      this.chainCount = 0; this.chainUntil = 0;
      this.counterUntil = 0; this.dodgeCounterUntil = 0; this.diveCounterUntil = 0;
      this.blockCount = 0;
      // 新一局：狂怒归零
      this.fury = 0; this.furyUntil = 0;
      this._furyFull = false; this._furyWasOn = false;
      this.paintFuryMeter();
      // 新一局：连携归零（局内跨房间保留，见 LINK 的说明）
      this.link = 0; this._diveLinked = false;
      this.paintLinkMeter();
      // 新一局：网的状态清空
      this.webUntil = 0;
      // 英雄形象：每位英雄一套专属精灵（宿主在 startRun 里传 heroId）
      this.setHeroLook(d.heroId || (d.skill && d.skill.id) || this.heroLookId || 'warrior');
      // 诅咒 / 环境效果（宿主在 startRun / 换层时传入）
      this.curses = [];
      this.worldEnv = null;
      this._baseAtk = null;
      this._baseDodge = null;
      this.setCursesAndEnv(d.curses, d.environment);
      // 英雄技能：宿主在 startRun 里传入（id / 技能名 / 主动技能名）
      this.skill = d.skill || null;
      this.skillId = (this.skill && this.skill.id) || '';
      this.skillUsed = !!(this.skill && this.skill.used);
      this.skillPowerUntil = 0; this.skillPowerMult = 1; this.skillVampire = 0;
      this.guardUntil = 0; this.skillLockUntil = 0;
      this._roomFirstHit = false; this._roomFirstKill = false;
      this._totemUsedFloor = false;   // 不朽图腾：每层一次，新一局重置
      this.updateSkillHud();
      // 新一局：清空战绩与画面内界面
      this._finished = false;
      this.kills = 0;
      this.roomsCleared = 0;
      this.runStartedAt = this.time.now;
      this.diving = false;
      this.deathOpen = false;
      this.shopOpen = false;
      this.confirmOpen = false;
      this.choiceOpen = false;
      this.pauseOpen = false;
      this.pendingMapAfterShop = false;
      this._viewPaused = false;
      try { this.scene.resume(); } catch (e) { /* 忽略 */ }
      this.destroyLayer('deathLayer');
      this.destroyLayer('shopLayer');
      this.destroyLayer('confirmLayer');
      this.destroyLayer('pauseLayer');
      this.destroyLayer('choiceLayer');
      if (this.panelButtons) this.panelButtons = { confirm: [], shop: [], death: [], map: [], choice: [], pause: [] };
      this.shopItemRects = [];
      this.hero.name = d.heroName || '冒险者';
      this.nameText.setText(this.hero.name);
      this.applyPlayerStats(d.player || {});
      if (d.player && d.player.hp !== undefined) this.hero.hp = Math.min(d.player.hp, this.hero.maxHp);

      // 环境主题（按难度切换星雾与火星）
      this.applyEnvironment(d.difficulty || 'normal');

      // 遗物：宿主可在 startRun 的 relics 里带进来，也可局中随时 setRelics 重下发
      if (d.relics && d.relics.length) HOST.relics = d.relics.slice();
      this.relics = HOST.relics;
      this.recomputeRelicFx();

      // 起始层数与起始房间 —— 读档续玩的关键（N20）
      // ------------------------------------------------------------
      // ⚠️ 这里原来**写死** `this.floor = 1`，而宿主那边又无条件把 roomIndex 归零，
      //    两者叠加的后果就是"2D 画面里存的档形同虚设，重进必须从第一层重新打"
      //    （用户反馈）。现在层数与房间位置都由宿主在 startRun 的 payload 里带进来：
      //      floor                 起始层数（默认 1）
      //      roomIndex             本层第几间（默认 0 = 入口）
      //      roomsClearedThisFloor 本层已清房间数（脉冲节拍要用，读档时等于 roomIndex）
      var startFloor = Math.max(1, Math.round(d.floor || 1));
      var startIdx = Math.max(0, Math.round(d.roomIndex || 0));
      this.floor = startFloor;
      this._floorMechanicCount = 0;
      this._floorMechanicKinds = {};
      this._floorRoomsCleared = Math.max(0, Math.round(
        d.roomsClearedThisFloor != null ? d.roomsClearedThisFloor : startIdx));
      this.floorMap = this.makeFloorMap(startFloor);
      // 读档续玩：把当前房间挪到存档所在的那一间（地图连线与节点都保留）
      // ⚠️ 必须按 **col（列号）** 找，不能用 `nodes[startIdx]` ——
      //    `nodes` 是按"列→行"顺序铺平的数组，而经典模式的规划**每列有 2 个候选**
      //    （见 经典2D.js 的 planFromRooms），于是 nodes[2] 其实是 col1 的第二个节点、
      //    不是 col2 的第一个。用下标找会让读档位置**整体偏前**（实测：存档在第 3 间，
      //    读档后落回第 2 间）。
      //    同一列里取**第一个**（= 主线房，与存档里 rooms[col] 的类型一致）。
      if (startIdx > 0) {
        var target = null;
        for (var ni = 0; ni < this.floorMap.nodes.length; ni++) {
          var cand = this.floorMap.nodes[ni];
          if (cand.col === startIdx) { target = cand; break; }
        }
        if (target) this.floorMap.current = target;
      }
      this.roomNode = this.floorMap.current;
      if (this.roomNode) this.roomNode.visited = true;
      this.buildLevel(this.roomNode);
      var rt = ROOM_TYPES[this.roomNode.type] || ROOM_TYPES.enemy;
      this.showCenter('深渊回廊 · 第 ' + startFloor + ' 层 · ' + rt.name, rt.center || '#ffd76a');
      // 远程英雄：开局点明普攻是远程，免得玩家还在等挥砍
      var rg0 = this.heroRanged();
      if (rg0) {
        var self2 = this;
        this.time.delayedCall(900, function () {
          if (self2.running) self2.showFloat(self2.hero.x, self2.hero.y - 96, '普攻：' + rg0.name + '（远程）', hexOf(rg0.color), 15);
        });
        console.log('[战斗2D] 远程英雄：' + this.heroLookId + ' · 普攻 ' + rg0.name + '（' + rg0.kind + '）');
      }
      sfx('battleStart');
      setBgmScene(bgmForRoom(this.roomNode.type));
      console.log('[战斗2D] 战斗开始：' + this.hero.name + ' · 难度 ' + this.difficulty + ' · 第 ' +
        this.floor + ' 层第 ' + (startIdx + 1) + ' 间（' + this.floorMap.nodes.length + ' 个房间）');

      // 触摸设备：操作提示只在开局亮几秒就淡出
      // 手机上它被夹在摇杆与按键区之间的一条窄缝里，常驻会一直占着底部一行；
      // 而各按钮上本来就写着名字、摇杆上也有箭头，看一次就够。
      if (this.isTouch && this.hintText) {
        var self3 = this;
        this.hintText.setAlpha(1).setVisible(true);
        if (this._hintFadeEv) { this._hintFadeEv.remove(); this._hintFadeEv = null; }
        this._hintFadeEv = this.time.delayedCall(5000, function () {
          if (self3._finished || !self3.running) return;
          self3.tweens.add({
            targets: self3.hintText, alpha: 0, duration: 700,
            onComplete: function () { self3.hintText.setVisible(false); }
          });
        });
      }
    }

    applyPlayerStats(p) {
      if (!p) return;
      var h = this.hero;
      if (p.maxHp !== undefined) { var diff = p.maxHp - h.maxHp; h.maxHp = p.maxHp; if (diff > 0) h.hp += diff; }
      if (p.hp !== undefined) h.hp = Math.min(p.hp, h.maxHp);
      if (p.attack !== undefined) h.attack = p.attack;
      if (p.critRate !== undefined) h.critRate = p.critRate;
      if (p.critDamage !== undefined) h.critDamage = p.critDamage;
      if (p.dodge !== undefined) h.dodge = p.dodge;
      if (p.thorn !== undefined) h.thorn = p.thorn;
      if (p.vampire !== undefined) h.vampire = p.vampire;
      if (p.combo !== undefined) h.combo = p.combo;
      if (p.execute !== undefined) h.execute = p.execute;
      if (p.shield !== undefined) h.shield = p.shield;
      if (p.potions !== undefined) h.potions = p.potions;
      this.refreshHud();
    }

    // ---------- 结束本局 ----------
    endRun(reason) { this.finishRun(reason); }

    /**
     * 结束本局：交给宿主（写出结果并退出试炼）
     * 宿主未接入时回退到 game 事件，保证单独打开 2D 层也能收尾
     */
    finishRun(reason) {
      if (this._finished) return;
      this._finished = true;
      this.running = false;
      this.attacking = false;
      this.diving = false;
      if (this.diveFx) this.diveFx.setVisible(false);
      if (reason === 'dead') this.heroDead = true;

      var result = {
        reason: reason, floor: this.floor, points: this.points,
        hp: Math.max(0, Math.round(this.hero.hp)), maxHp: this.hero.maxHp,
        kills: this.kills || 0, rooms: this.roomsCleared || 0,
        elapsed: Math.max(0, Math.round((this.time.now - this.runStartedAt) / 1000))
      };
      console.log('[战斗2D] 结束本局：' + reason + ' · 第 ' + this.floor + ' 层 · 金币 ' + this.points);
      setBgmScene('explore');
      // 关闭画面内界面
      // ⚠️ 必须把**所有**画内图层一起收掉，尤其是暂停层 / 决策层：
      //    "结束本局"可以从「暂停菜单 → 结束本局 → 确认结束」这条链进来，
      //    只关 confirm/shop 的话，暂停窗会留在画布上（实测反馈过这个现象）。
      //    收尾期间这些面板已无意义，统一关闭不会影响任何回退路径。
      this.shopOpen = false; this.confirmOpen = false;
      this.pauseOpen = false; this.choiceOpen = false;
      this.deathOpen = false; this.codexOpen = false;
      this.relicOpen = false;
      this.mapOpen = false;
      this._pausedForPause = false;
      this._pausedForConfirm = false;
      this._pausedForChoice = false;
      this._pausedForRelic = false;
      this.pendingMapAfterShop = false;
      if (this.touchUI) this.touchUI.setVisible(false);
      this.destroyLayer('shopLayer'); this.destroyLayer('confirmLayer');
      this.destroyLayer('pauseLayer'); this.destroyLayer('choiceLayer');
      this.destroyLayer('deathLayer'); this.destroyLayer('codexLayer');
      this.destroyLayer('relicLayer'); this.destroyLayer('relicStatsLayer');
      this.destroyLayer('mapLayer');
      if (this.panelButtons) {
        this.panelButtons.shop = []; this.panelButtons.confirm = [];
        this.panelButtons.pause = []; this.panelButtons.choice = [];
        this.panelButtons.death = []; this.panelButtons.map = [];
        this.panelButtons.relic = []; this.panelButtons.relicStats = [];
      }
      this.syncUiBarVisibility();
      if (hasBridge('exit')) { callBridge('exit', result); return; }
      if (this.game && this.game.events) this.game.events.emit('trial2d:run-ended', result);
    }

    /** 静默收尾（不发事件、不触发结算）—— 退出试炼 / 重置 / 关闭引擎时用 */
    abortRun() {
      this.running = false;
      this.heroDead = false;
      this.attacking = false;
      this.diving = false;
      this._viewPaused = false;
      this.shopOpen = false;
      this.deathOpen = false;
      this.confirmOpen = false;
      this.pendingMapAfterShop = false;
      if (this.diveFx) this.diveFx.setVisible(false);
      this.destroyLayer('shopLayer');
      this.destroyLayer('deathLayer');
      this.destroyLayer('confirmLayer');
      this.destroyLayer('pauseLayer');
      this.destroyLayer('choiceLayer');
      // 遗物面板的两张卡片也要一起收：它是一对互斥的层（列表 / 属性），
      // 关闭路径同样只有 closeRelicPanel 一条 —— 静默收尾漏掉就会留在画布上。
      this.destroyLayer('relicLayer');
      this.destroyLayer('relicStatsLayer');
      this.relicOpen = false;
      this._pausedForRelic = false;
      this.choiceOpen = false;
      this.pauseOpen = false;
      if (this.mapOpen) {
        this.mapOpen = false;
        this.destroyLayer('mapLayer');
        try { this.physics.world.resume(); } catch (e) { /* 忽略 */ }
      }
      if (this.panelButtons) this.panelButtons = { confirm: [], shop: [], death: [], map: [], choice: [], pause: [], relic: [], relicStats: [] };
      this.shopItemRects = [];
      if (this.touchUI) this.touchUI.setVisible(this._lastInputWasTouch === true);
      this.syncUiBarVisibility();
    }

    /**
     * 冻结战斗（不换视图）
     * ------------------------------------------------------------
     * 原语义是「切到文字界面」：宿主隐藏画布、换成 DOM 文字面板。
     * 试炼并入经典后新版不再有第二个视图，但这个**能力**留着 —— 宿主需要
     * "让 2D 彻底停住"时仍然用它（`_viewPaused` 也参与 panelOverlayOpen 的判定）。
     * ⚠️ 不再去点亮 `text` 按钮：那颗按钮已随"文字界面视图"一起删除。
     */
    pauseForView() {
      if (this._viewPaused) return;   // 幂等：宿主与画面按钮可能都会调用
      this._viewPaused = true;
      this.attacking = false;
      this.diving = false;
      this.isCharging = false;
      this.dodging = false;
      this.dodgeReadyAt = 0;
      if (this.chargeRing) this.chargeRing.setVisible(false);
      if (this.diveFx) this.diveFx.setVisible(false);
      if (this.hero) this.hero.setVelocity(0, 0);
      if (this.touchInput) {
        this.touchInput.left = false; this.touchInput.right = false; this.touchInput.downHeld = false;
        this.touchInput.jumpHeld = false; this.touchInput.joyJumpHeld = false; this.touchInput.jumpPressed = false;
      }
      if (this.touchUI) this.touchUI.setVisible(false);
      try { this.physics.world.pause(); } catch (e) { /* 忽略 */ }
      try { this.scene.pause(); } catch (e) { /* 忽略 */ }
      // scene.pause 之后 update 不再跑，功能按钮行的显隐要在这里补一次
      this.syncUiBarVisibility();
    }

    /** 解除 pauseForView 的冻结 */
    resumeFromView() {
      this._viewPaused = false;
      this.clearStaleInput();   // 冻结期间按下的键不该在恢复时补发
      try { this.scene.resume(); } catch (e) { /* 忽略 */ }
      if (!this.mapOpen && !this.shopOpen && !this.deathOpen && !this.confirmOpen) {
        try { this.physics.world.resume(); } catch (e) { /* 忽略 */ }
      }
      if (this.touchUI) this.touchUI.setVisible(this._lastInputWasTouch === true);
      this.syncUiBarVisibility();
      sfx('click');
    }

    /** 实时战况快照（原消费方是文字界面，它随试炼关停移除后引擎内已无调用点） */
    buildSnapshot() {
      var self = this;
      var h = this.hero;
      return {
        floor: this.floor, points: this.points,
        kills: this.kills || 0, roomsCleared: this.roomsCleared || 0,
        elapsed: Math.max(0, Math.round((this.time.now - this.runStartedAt) / 1000)),
        running: !!this.running, dead: !!this.heroDead, finished: !!this._finished,
        roomType: this.roomNode ? this.roomNode.type : null,
        roomName: this.roomNode ? ((ROOM_TYPES[this.roomNode.type] || ROOM_TYPES.enemy).name) : '—',
        mapOpen: !!this.mapOpen, shopOpen: !!this.shopOpen,
        enemiesAlive: this.enemies.filter(function (e) { return e.alive; }).length,
        enemies: this.enemies.map(function (e) {
          return {
            name: e.name, tier: e.tier, behavior: e.behavior, alive: !!e.alive,
            hp: Math.max(0, Math.round(e.hp)), maxHp: e.maxHp, atk: Math.round(e.atk),
            speed: e.def.speed, tierName: TIER_NAMES[e.tier] || '普通',
            behaviorName: BEHAVIOR_NAMES[e.behavior] || '追击'
          };
        }),
        hero: {
          name: h.name, hp: Math.max(0, Math.round(h.hp)), maxHp: h.maxHp, shield: Math.round(h.shield),
          attack: Math.round(h.attack), critRate: Math.round(h.critRate), critDamage: Math.round(h.critDamage),
          dodge: Math.round(h.dodge), thorn: Math.round(h.thorn), vampire: Math.round(h.vampire),
          combo: Math.round(h.combo), execute: Math.round(h.execute), potions: h.potions
        }
      };
    }

    // ---------- 死亡结算（画面内，不再回文字界面）----------
    /** 面板期间（含被 DOM 全屏面板盖住期间）的按键不该在恢复后「补发」（清掉 JustDown 残留） */
    clearStaleInput() {
      var k = this.keys;
      if (k) ['attack', 'potion', 'jump', 'jump2', 'jump3', 'jump4', 'dodge', 'dodge2', 'guard', 'guard2', 'fury'].forEach(function (n) {
        var key = k[n];
        if (key) { key._justDown = false; key._justUp = false; }
      });
      if (this.touchInput) { this.touchInput.jumpPressed = false; this.touchInput.guardHeld = false; }
      this.lowerGuard();   // 面板打开时不再举着盾
    }

    // ---------- 英雄技能（主动每层一次 / 被动常驻） ----------
    /**
     * 主动技能：按键 E，或点 HUD 技能胶囊 / 触摸「技能」钮
     * 文字模式是回合制数值，这里按实时战斗的尺度重做，技能名与语义不变：
     *   护盾类 → 立刻获得护盾；「下一次攻击 +N」→ 数秒内的攻击强化；
     *   元素风暴 → 范围爆发；精准射击 → 穿透箭；暗影突袭 → 无敌 + 重击
     */
    useSkill() {
      var now = this.time.now, h = this.hero;
      if (!this.running || this.heroDead) return false;
      // 面板 / 被 DOM 全屏面板盖住期间战斗不推进，技能也不该生效
      if (this.mapOpen || this.shopOpen || this.codexOpen || this.deathOpen || this.confirmOpen || this._viewPaused) return false;
      if (!this.skill || !this.skill.activeName) {
        if (this.skill) this.showFloat(h.x, h.y - 70, '该英雄没有主动技能', UI.muted, 14);
        return false;
      }
      if (this.skillUsed) {
        this.showFloat(h.x, h.y - 70, '本层已使用', UI.muted, 14);
        sfx('error');
        return false;
      }
      if (now < this.skillLockUntil) return false;

      var id = this.skillId, name = this.skill.activeName, ok = true;
      switch (id) {
        case 'warrior':      // 战吼：6 点护盾 + 震退近身敌人
          this.addShield(6, '战吼');
          this.knockAround(150, 260, 0);
          break;
        case 'guardian':     // 护盾壁垒：6 点护盾 + 4 秒内受到的伤害减半
          this.addShield(6, '护盾壁垒');
          this.guardUntil = now + 4000;
          break;
        case 'paladin':      // 神圣审判：8 点护盾 + 回复 4 点生命
          this.addShield(8, '神圣审判');
          this.healHero(4, true);
          break;
        case 'rogue':        // 影舞突袭：3 秒内攻击 ×2
          this.grantPower(2, '影舞突袭');
          break;
        case 'ranger':       // 精准射击：射出一支穿透箭
          this.fireArrow(SKILL.arrowMult);
          break;
        case 'mage':         // 元素风暴：以自身为中心的元素爆发
          this.burstAround(SKILL.burstR, 2.5, 0x9a8ef0, '元素风暴');
          break;
        case 'berserker':    // 破釜沉舟：失去 15% 当前生命，8 秒内攻击 ×2.5 并吸血
          var cost = Math.max(1, Math.round(h.hp * 0.15));
          h.hp = Math.max(1, h.hp - cost);
          this.showFloat(h.x, h.y - 86, '-' + cost, '#ff6b6b', 15);
          this.grantPower(2.5, '破釜沉舟', 8000, 0.2);
          break;
        case 'sage':         // 法力灌注：回复 8 点生命 + 3 点护盾 + 3 秒内攻击 ×1.6
          this.healHero(8, true);
          this.addShield(3, '法力灌注');
          this.grantPower(1.6, '法力灌注');
          break;
        case 'shadow':       // 暗影突袭：1.2 秒无敌 + 下一次攻击 ×3
          this.invulnUntil = Math.max(this.invulnUntil, now + 1200);
          this.grantPower(3, '暗影突袭');
          break;
        default:
          ok = false;
          this.showFloat(h.x, h.y - 70, '该英雄的技能尚未适配实时战斗', UI.muted, 14);
          break;
      }
      if (!ok) return false;

      this.skillUsed = true;
      this.skillLockUntil = now + 320;
      this._skillFlashAt = now;
      if (hasBridge('skillUsed')) callBridge('skillUsed', true);

      // 施法表现：技能名飘字 + 绿色冲击环 + 轻微闪光
      this.showFloat(h.x, h.y - 100, name, UI.gold, 20);
      sfx('skill');
      this.cameras.main.flash(90, 235, 240, 200);
      var ring = this.add.circle(h.x, h.y - 24, 14, 0x73f0b4, 0.18).setDepth(11);
      ring.setStrokeStyle(3, 0x73f0b4, 0.9);
      this.tweens.add({
        targets: ring, radius: 120, alpha: 0, duration: 320,
        onComplete: function () { ring.destroy(); }
      });
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(80, 0.004);
      this.updateSkillHud();
      this.refreshHud();
      console.log('[战斗2D] 使用英雄技能：' + name + '（' + id + '）');
      return true;
    }

    /** 技能胶囊 / 触摸钮的状态（技能名 · 已用 / 无主动技能时隐藏） */
    updateSkillHud() {
      var b = this.skillBtn;
      if (!b) return;
      var has = !!(this.skill && this.skill.activeName);
      if (b.gfx && b.gfx.visible !== has) {
        b.gfx.setVisible(has);
        b.text.setVisible(has);
        if (b.icon) b.icon.setVisible(has);
      }
      if (this.touchInput && this.btnSkill) this.btnSkill.setVisible(!!this.isTouch && has);
      if (!has) return;
      var label = this.skillUsed ? (this.skill.activeName + ' · 已用') : this.skill.activeName;
      if (b.text.text !== label) {
        b.text.setText(label);
        b.w = Math.round(b.text.width + Math.max(10, Math.round(b.h * 0.5)) * 2 + (b.icon ? 23 : 0));
      }
      b.disabled = !!this.skillUsed;
      this.paintButton(b);
    }

    /** 每层一次：换层 / 开局时恢复主动技能 */
    resetSkill(silent) {
      this.skillUsed = false;
      if (!silent && hasBridge('skillUsed')) callBridge('skillUsed', false);
      this.updateSkillHud();
      if (!silent && this.skill && this.skill.activeName) {
        this.showFloat(this.hero.x, this.hero.y - 108, '技能就绪', UI.good, 14);
      }
    }

    /** 立刻获得护盾（叠加在生命条之上） */
    addShield(n, tag) {
      var h = this.hero;
      // 遗物：护盾共鸣 —— 任何来源获得的护盾都额外 +N（药水 / 技能 / 格挡 / 魂晶一并生效）
      var gain = n + (n > 0 ? this.relicFx('shieldGain', 0) : 0);
      h.shield += gain;
      this.showFloat(h.x, h.y - 80, '+' + gain + ' 护盾', UI.accent, 16);
      this.spark(h.x, h.y - 26, 0x5fd0e0);
      if (tag) this.showFloat(h.x, h.y - 102, tag, '#9fe0c0', 13);
      this.refreshHud();
    }

    /** 攻击强化（「下一次攻击 +N」的实时等价物） */
    grantPower(mult, tag, dur, vampire) {
      var now = this.time.now;
      this.skillPowerUntil = Math.max(this.skillPowerUntil || 0, now + (dur || SKILL.power));
      this.skillPowerMult = Math.max(this.skillPowerMult || 1, mult || 1);
      if (vampire) this.skillVampire = Math.max(this.skillVampire || 0, vampire);
      if (tag) this.showFloat(this.hero.x, this.hero.y - 108, tag, '#c79aff', 13);
    }

    /** 击退附近敌人（技能用；dmgMult > 0 时附带伤害） */
    knockAround(radius, force, dmgMult) {
      var h = this.hero, self = this;
      this.enemies.forEach(function (e) {
        if (!e.alive) return;
        if (Math.abs(e.sprite.x - h.x) > radius || Math.abs(e.sprite.y - h.y) > radius) return;
        var dir = e.sprite.x >= h.x ? 1 : -1;
        e.sprite.setVelocity(dir * force, -160);
        e.hurtUntil = self.time.now + 140;
        if (dmgMult > 0) self.damageEnemy(e, self.rollPlayerDamage(dmgMult, false, null, { noLink: true }), false);
        self.spark(e.sprite.x, e.sprite.y - 26, 0x8ad8ff);
      });
    }

    /** 以主角为中心的范围爆发（元素风暴） */
    burstAround(radius, mult, color, tag) {
      var h = this.hero, self = this;
      color = color || 0x9a8ef0;
      var ring = this.add.circle(h.x, h.y - 24, 20, color, 0.2).setDepth(11);
      ring.setStrokeStyle(4, color, 0.9);
      this.tweens.add({
        targets: ring, radius: radius, alpha: 0, duration: 340,
        onComplete: function () { ring.destroy(); }
      });
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(160, 0.009);
      this.enemies.forEach(function (e) {
        if (!e.alive) return;
        if (Math.abs(e.sprite.x - h.x) > radius || Math.abs(e.sprite.y - h.y) > radius) return;
        var dir = e.sprite.x >= h.x ? 1 : -1;
        e.sprite.setVelocity(dir * 220, -220);
        self.showFloat(e.sprite.x, e.sprite.y - 74, tag || '爆发', UI.gold, 15);
        self.damageEnemy(e, self.rollPlayerDamage(mult, false, null, { noLink: true }), false);
      });
      this.spark(h.x, h.y - 26, color);
    }

    /** 精准射击：穿透箭（命中多个敌人、命中后不消失） */
    fireArrow(mult) {
      var h = this.hero, dir = h.flipX ? -1 : 1;
      // 施放者是远程英雄时，用他自己的弹道画得更亮更长 —— 同一套视觉语言，一眼认得出是谁的技能
      var rg = this.heroRanged();
      var kind = rg ? (rg.kind === 'wave' ? 'orb' : rg.kind) : 'orb';
      var tex = rg ? 角色形象.ensureShotTexture(this, kind, rg.color) : TEX.projectile;
      var a = this.physics.add.sprite(h.x + dir * 26, h.y - 30, tex, 0);
      if (rg) {
        a.play(角色形象.ensureShotAnim(this, kind, rg.color, 16));
        a.setScale(1.35).setRotation(0);
        a.body.setSize(角色形象.shotSize(kind).bw * 1.35, 角色形象.shotSize(kind).bh * 1.35, true);
      } else {
        a.setTint(0x9fe0c0);
      }
      a.setDepth(9);
      a.body.setAllowGravity(false);
      a.setVelocityX(dir * SKILL.arrowSpeed);
      a._dmg = Math.round(h.attack * (mult || SKILL.arrowMult));
      a._friendly = true;
      a._hit = {};
      a._lifeUntil = this.time.now + SKILL.arrowLife;
      this.skillProjectiles.push(a);
      this.showFloat(h.x, h.y - 108, '精准射击', '#9fe0c0', 13);
      sfx('attack');
      this.spark(h.x + dir * 26, h.y - 30, 0x9fe0c0);
    }

    /** 穿透箭逐帧：飞行中命中每个敌人各结算一次 */
    updateSkillProjectiles() {
      if (!this.skillProjectiles || !this.skillProjectiles.length) return;
      var self = this, now = this.time.now;
      this.skillProjectiles = this.skillProjectiles.filter(function (a) {
        if (!a || !a.active) return false;
        if (now > a._lifeUntil || a.x < -60 || a.x > self.levelWidth + 60 ||
          a.body.blocked.left || a.body.blocked.right || a.body.blocked.down) {
          a.destroy(); return false;
        }
        var hit = false;
        self.enemies.forEach(function (e, idx) {
          if (!e.alive || a._hit[idx]) return;
          if (Phaser.Geom.Intersects.RectangleToRectangle(a.getBounds(), e.sprite.getBounds())) {
            a._hit[idx] = true;
            self.damageEnemy(e, { dmg: a._dmg, crit: true }, false);
            hit = true;
          }
        });
        if (hit) self.spark(a.x, a.y, 0x9fe0c0);
        return true;
      });
    }

    /** 被动：进入房间的「战斗开始」效果（战士 / 圣骑士） */
    applyRoomStartPassive() {
      if (this.skillId === 'warrior') this.addShield(3, '坚韧之盾');
      else if (this.skillId === 'paladin') this.addShield(4, '圣光护盾');
    }

    /** 被动：伤害修正（首击 / 概率 / 低血，对应文字模式的首回合、30% 概率、生命低于 50%） */
    heroPassiveDamage() {
      var h = this.hero, id = this.skillId, flat = 0, forceCrit = false;
      if (id === 'mage' && Math.random() < 0.3) flat += 3;            // 奥术爆发
      if (id === 'berserker' && h.hp <= h.maxHp / 2) flat += 2;        // 嗜血狂暴
      if (!this._roomFirstHit) {
        if (id === 'rogue') flat += 2;                                // 迅捷突袭
        if (id === 'shadow') forceCrit = true;                        // 暗影步
      }
      return { flat: flat, forceCrit: forceCrit };
    }

    /** 被动：击杀触发的「战斗胜利」效果（贤者 / 游侠，每房间一次） */
    applyKillPassive() {
      if (this._roomFirstKill) return;
      this._roomFirstKill = true;
      if (this.skillId === 'sage') {
        this.healHero(2, true);
        this.showFloat(this.hero.x, this.hero.y - 96, '灵能回响', '#9fe0c0', 13);
      } else if (this.skillId === 'ranger') {
        this.points += 1;
        this.showFloat(this.hero.x, this.hero.y - 96, '寻宝天赋 +1 点', UI.gold, 13);
        this.refreshHud();
      }
    }

    /** 被动：守护者的「坚壁防御」——2D 里的防守动作是闪避，闪避成功即获得护盾 */
    onDodgeSuccess() {
      if (this.skillId !== 'guardian') return;
      this.addShield(2, '坚壁防御');
    }
    // ---------- 闪避与体力 ----------
    /** 闪避（翻滚冲刺）：消耗体力换取短时无敌；命中瞬间闪避 = 完美闪避 */
    tryDodge() {
      var now = this.time.now, h = this.hero;
      if (!this.running || this.heroDead || this.dodging || this.diving) return false;
      if (now < this.dodgeReadyAt) return false;
      if (h.stamina < DODGE.cost) {
        this.showFloat(h.x, h.y - 70, '体力不足', UI.accent, 15);
        sfx('error');
        this.staminaMeter.fill.setTint(0xff8a7a);
        return false;
      }

      // 滞空之羽：空中闪避不耗体力 —— 把"滞空机动"做成一条真能围绕它打的路线
      var airborne = !(h.body.blocked.down || h.body.touching.down);
      var freeAir = this.relicFx('airDodgeFree', 0) > 0 && airborne;
      if (!freeAir) h.stamina -= DODGE.cost;
      this.staminaHoldUntil = now + STAMINA.delay;
      this.dodging = true;
      this.dodgeStartAt = now;
      this.dodgeUntil = now + DODGE.time;
      this.dodgeReadyAt = now + DODGE.time + DODGE.recover;
      // 无敌帧：闪避的全部意义在这里
      this.invulnUntil = Math.max(this.invulnUntil, now + DODGE.invuln);
      this.dodgeFxUntil = now + DODGE.invuln;
      // 织网者：闪避把身上的网撕开 —— 这就是那一发网的解法。
      // 放在"闪避的收益"里，而不是让玩家去别处找说明。
      if (now < (this.webUntil || 0)) {
        this.webUntil = 0;
        this.showFloat(h.x, h.y - 120, '撕开蛛网', '#a8e88a', 17);
        this.spark(h.x, h.y - 30, 0xa8e88a);
      }
      // 闪避可取消攻击后摇与蓄力
      this.attacking = false;
      this.isCharging = false;
      this.chargeRatio = 0;
      if (this.chargeRing) this.chargeRing.setVisible(false);

      var dir = h.flipX ? -1 : 1;
      var onGround = h.body.blocked.down || h.body.touching.down;
      h.setVelocityX(dir * DODGE.speed);
      if (!onGround) h.setVelocityY(h.body.velocity.y * 0.3);   // 空中闪避：短暂滞空
      h.play('hero_roll', true);
      this._afterimageAt = 0;
      this.spawnAfterimage(h);
      sfx('dash');
      this.spark(h.x - dir * 12, h.y - 22, 0x8ae0ff);
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(60, 0.002);
      this.refreshHud();
      return true;
    }

    /** 闪避逐帧：冲刺位移 + 残影，结束后交还控制 */
    updateDodge(dt, onGround) {
      var now = this.time.now, h = this.hero;
      if (now < this.dodgeUntil) {
        var dir = h.flipX ? -1 : 1;
        if (Math.abs(h.body.velocity.x) < DODGE.speed * 0.5) h.setVelocityX(dir * DODGE.speed);
        if (!onGround) h.setVelocityY(h.body.velocity.y * DODGE.airDrag);
        if (now - this._afterimageAt > 45) {
          this._afterimageAt = now;
          this.spawnAfterimage(h);
        }
        h.play('hero_roll', true);
      } else {
        this.dodging = false;
        h.setVelocityX(h.body.velocity.x * 0.4);
        // 翻滚收招后的短暂窗口内接攻击 = 突进斩（连招）
        this.dodgeCounterUntil = Math.max(this.dodgeCounterUntil || 0, now + CHAIN.dodgeWindow);
      }
      h.setAlpha(this.invulnAlpha());
    }

    /**
     * 无敌帧的闪烁：闪避用柔和虚影（角色仍要看得清），受击无敌沿用快速闪烁
     */
    invulnAlpha() {
      var now = this.time.now;
      if (now >= this.invulnUntil) return 1;
      if (now < (this.dodgeFxUntil || 0)) return 0.62 + 0.22 * Math.sin(now / 55);
      return 0.45 + 0.35 * Math.sin(now / 60);
    }

    /** 闪避残影：复用主角当前帧，短时淡出（对象数量与生命周期都受控） */
    spawnAfterimage(h) {
      var img = this.add.image(h.x, h.y, h.texture.key, h.frame.name)
        .setOrigin(0.5, 1).setDepth(9).setFlipX(h.flipX).setAlpha(0.32).setTint(0x7fd8ff);
      this.tweens.add({ targets: img, alpha: 0, duration: 240, onComplete: function () { img.destroy(); } });
    }

    /**
     * 完美闪避：在敌人攻击命中的瞬间闪避成功
     * 奖励：体力全额返还 + 震开（定身）周围敌人 + 锐利（短时伤害强化）+ 化解逼近的弹幕
     */
    onPerfectDodge() {
      var now = this.time.now, h = this.hero;
      if (now - (this._lastPerfectAt || -9999) < 200) return;   // 同一次攻击只结算一次
      this._lastPerfectAt = now;
      this._perfectAt = now;

      h.stamina = h.maxStamina;
      this.perfectUntil = now + DODGE.sharp;
      h.perfectCount = (h.perfectCount || 0) + 1;
      this.perfectCount = h.perfectCount;
      this.addFury(FURY.gainPerfect);          // 完美闪避攒怒（技巧奖励）
      this.addLink(1);                         // 完美闪避攒连携（技巧 → 可消费的资源）

      this.showFloat(h.x, h.y - 96, '完美闪避!', UI.gold, 22);
      this.spark(h.x, h.y - 26, 0xffd76a);
      sfx('perfect');
      this.cameras.main.flash(120, 250, 226, 150);
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(90, 0.005);

      var ring = this.add.circle(h.x, h.y - 24, 16, 0xffd76a, 0.16).setDepth(11);
      ring.setStrokeStyle(3, 0xffd76a, 0.9);
      this.tweens.add({
        targets: ring, radius: DODGE.radius, alpha: 0, duration: 320,
        onComplete: function () { ring.destroy(); }
      });

      // 震开：范围内的敌人定身（正在冲锋的也会被打断）
      var self = this, r = DODGE.radius;
      this.enemies.forEach(function (e) {
        if (!e.alive) return;
        if (Math.abs(e.sprite.x - h.x) > r || Math.abs(e.sprite.y - h.y) > r) return;
        e.state = 'chase';
        e.stunUntil = now + DODGE.stun;
        e.sprite.setVelocity(0, 0);
        self.showFloat(e.sprite.x, e.sprite.y - 80, '定身', UI.gold, 14);
        self.spark(e.sprite.x, e.sprite.y - 26, 0xffd76a);
      });
      // 逼近的弹幕直接化解，避免完美闪避后立刻被同一波弹幕打中
      this.clearNearbyProjectiles(h.x, h.y, 150);
      this.refreshHud();
    }

    /** 化解范围内的敌方弹幕 */
    clearNearbyProjectiles(x, y, r) {
      var self = this;
      this.projectiles = this.projectiles.filter(function (p) {
        if (!p || !p.active || p._friendly) return !!p;
        if (Math.abs(p.x - x) > r || Math.abs(p.y - y) > r) return true;
        self.spark(p.x, p.y, 0xffd76a);
        p.destroy();
        return false;
      });
    }

    /** 体力回复 + 闪避提示（危险时机体力条发光 = 可完美闪避） */
    updateStamina(dt) {
      var h = this.hero, now = this.time.now;
      if (!this.staminaMeter || !h) return;
      if (!this.heroDead && now >= this.staminaHoldUntil && h.stamina < h.maxStamina) {
        h.stamina = Math.min(h.maxStamina, h.stamina + STAMINA.regen * dt / 1000);
      }
      this.setMeterValue(this.staminaMeter, h.stamina / h.maxStamina);
      this.updateMeter(this.staminaMeter, dt, now);

      var low = h.stamina < DODGE.cost;
      var sharpLeft = this.perfectUntil - now;
      var v = Math.round(h.stamina);
      if (v !== this._staminaShown || Math.abs(sharpLeft - (this._sharpLeftShown || 0)) > 90) {
        this._sharpLeftShown = sharpLeft;
        this.updateStaminaText();
      }
      // 体力不足：条体转红（还能不能再闪，一眼可读）
      var wantTint = low ? 0xff8a7a : 0xffffff;
      if (this.staminaMeter.fill.tintTopLeft !== wantTint) this.staminaMeter.fill.setTint(wantTint);

      var danger = !low && this.perfectWindowOpen();   // 体力不足时不再提示可完美闪避
      var tip = danger ? (0.2 + 0.18 * (0.5 + 0.5 * Math.sin(now / 130))) : 0;
      if (Math.abs((this.staminaTip.alpha || 0) - tip) > 0.012) this.staminaTip.setAlpha(tip);
      if (this.isTouch && this.btnDodge) {
        this.btnDodge.setFillStyle(0x5fd0e0, low ? 0.1 : (danger ? 0.44 : 0.24));
      }
    }

    /** 当前是否处于「可完美闪避」窗口：附近敌人在前摇 / 冲锋，或有弹幕正在逼近 */
    perfectWindowOpen() {
      var h = this.hero;
      if (!h) return false;
      var es = this.enemies || [];
      for (var i = 0; i < es.length; i++) {
        var e = es[i];
        if (!e.alive) continue;
        if (e.state !== 'windup' && e.state !== 'charge') continue;
        if (Math.abs(e.sprite.x - h.x) < 200 && Math.abs(e.sprite.y - h.y) < 150) return true;
      }
      var ps = this.projectiles || [];
      for (var j = 0; j < ps.length; j++) {
        var p = ps[j];
        if (!p || !p.active || p._friendly) continue;
        var dx = h.x - p.x;
        if (Math.abs(dx) < 170 && Math.abs((h.y - 30) - p.y) < 80 && dx * p.body.velocity.x > 0) return true;
      }
      return false;
    }

    /** 体力数值 + 锐利倒计时（只在数值变化时更新文本） */
    updateStaminaText() {
      if (!this.staminaText) return;
      var h = this.hero, now = this.time.now;
      var v = Math.round(h.stamina);
      this._staminaShown = v;
      this.staminaText.setText('体力 ' + v).setColor(h.stamina < DODGE.cost ? UI.danger : UI.accent);
      var x = this.meterTextX(this.staminaMeter, this._stamTextGap);
      if (x == null) x = 286;
      var y = this._stamTextY != null ? this._stamTextY : 56;
      this.staminaText.setPosition(x, y);

      var left = this.perfectUntil - now;
      var show = left > 0;
      if (this.sharpText.visible !== show) this.sharpText.setVisible(show);
      this.sharpText.setPosition(x + this.staminaText.width + 10, y);
      if (show) this.sharpText.setText('锐利 ' + (left / 1000).toFixed(1) + 's');
    }

    heroDie() {
      this.heroDead = true;
      this.attacking = false;
      this.diving = false;
      this.dodging = false;
      if (this.diveFx) this.diveFx.setVisible(false);
      this.hero.hp = 0;
      this.hero.play('hero_dead', true);
      this.hero.setVelocity(0, -200);
      this.hero.body.checkCollision.none = true;
      this.running = false;
      this.refreshHud();
      sfx('defeat');
      setBgmScene('explore');
      if (this.targetPanel) this.targetPanel.setVisible(false);
      // 稍等死亡动画再弹出结算面板
      var self = this;
      this.time.delayedCall(600, function () { if (self.heroDead) self.showDeathPanel(); });
    }

    showDeathPanel() {
      if (this.deathOpen || !this.ready) return;
      this.deathOpen = true;
      if (this.mapOpen) this.destroyLayer('mapLayer');
      this.confirmOpen = false;
      this.destroyLayer('confirmLayer');
      if (this.touchUI) this.touchUI.setVisible(false);
      this.buildDeathLayer();
      if (this.deathLayer) {
        this.deathLayer.setAlpha(0);
        this.tweens.add({ targets: this.deathLayer, alpha: 1, duration: 280 });
      }
    }

    buildDeathLayer(sizeW, sizeH) {
      var W = (sizeW && sizeW >= 40) ? sizeW : this.scale.width;
      var H = (sizeH && sizeH >= 40) ? sizeH : this.scale.height;
      if (W < 40 || H < 40) return null;
      var mini = W < 700;
      var L = this.add.container(0, 0).setDepth(2200).setScrollFactor(0);
      this.deathLayer = L;
      this.panelButtons.death = [];

      this.addDim(L, W, H);
      L.add(this.add.text(W / 2, H * 0.18, '你倒下了', {
        fontSize: (mini ? 28 : 42) + 'px', color: UI.danger, fontStyle: 'bold', letterSpacing: 4
      }).setOrigin(0.5));
      var roomName = this.roomNode ? ((ROOM_TYPES[this.roomNode.type] || ROOM_TYPES.enemy).name) : '深渊';
      L.add(this.add.text(W / 2, H * 0.18 + (mini ? 26 : 38), '深渊回廊 · 第 ' + this.floor + ' 层 · ' + roomName, {
        fontSize: (mini ? 12 : 15) + 'px', color: UI.muted
      }).setOrigin(0.5));

      var boxW = Math.min(W * 0.84, 460), boxH = mini ? 200 : 232;
      var boxY = H * 0.5;
      this.addPanel(L, W / 2 - boxW / 2, boxY - boxH / 2, boxW, boxH, {});

      var lines = [
        ['到达层数', '第 ' + this.floor + ' 层'],
        ['金币', '' + this.points],
        ['击败敌人', (this.kills || 0) + ' 个'],
        ['通过房间', (this.roomsCleared || 0) + ' 个'],
        ['存活时间', fmtTime(this.time.now - this.runStartedAt)]
      ];
      // 深渊回响：把「这一局能带回经典模式什么」直接摆在结算面板上。
      // ⚠️ 原文案是"活着撤离可多得 25%（撤离结算 ×1.25）"——那是**试炼时代**的机制，
      //    并入经典模式后已经没有"撤离结算"了（宿主的 rewardPreview 恒为 null，
      //    这段本来也永远不会显示）。这句留在死亡面板上只会误导玩家，已换成实际规则。
      var rw = callBridge('rewardPreview', {
        floor: this.floor, points: this.points, kills: this.kills || 0, extracted: false
      });
      if (rw) {
        lines.push(['深渊回响', '+' + rw.totalGold + ' 金币 / +' + rw.totalXp + ' 经验']);
      }
      var self = this;
      var top = boxY - boxH / 2 + (mini ? 20 : 26);
      var step = mini ? 25 : 29;
      lines.forEach(function (ln, i) {
        var y = top + i * step;
        L.add(self.add.text(W / 2 - boxW / 2 + 24, y, ln[0], {
          fontSize: (mini ? 12 : 14) + 'px', color: UI.muted
        }).setOrigin(0, 0.5));
        L.add(self.add.text(W / 2 + boxW / 2 - 24, y, ln[1], {
          fontSize: (mini ? 14 : 17) + 'px', color: UI.title, fontStyle: 'bold'
        }).setOrigin(1, 0.5));
      });

      L.add(this.add.text(W / 2, boxY + boxH / 2 + (mini ? 22 : 28),
        '本局成绩已计入记录 · 金币可在商店换成下一局的实力', {
          fontSize: (mini ? 11 : 13) + 'px', color: UI.accent
        }).setOrigin(0.5));

      var bw = Math.min(200, W * 0.37), bh = mini ? 38 : 44;
      var gap = Math.min(28, W * 0.04);
      var by = Math.min(H - (mini ? 54 : 70), boxY + boxH / 2 + (mini ? 62 : 80));
      var bx = W / 2 - (bw * 2 + gap) / 2;
      this.uiButton(L, this.panelButtons.death, 'shop', '商店', bx, by, bw, bh, true);
      this.uiButton(L, this.panelButtons.death, 'exit', '结束本局', bx + bw + gap, by, bw, bh, false);
      return L;
    }

    onDeathAction(action) {
      if (action === 'shop') { this.openShop({ returnToDeath: true }); return; }
      if (action === 'exit') { this.finishRun('dead'); return; }
    }

    // ---------- 商店（画面内）----------
    openShop(opts) {
      if (this.shopOpen) return;
      this.shopOpen = true;
      this.shopReturnToDeath = !!(opts && opts.returnToDeath);
      this.dodging = false;
      this.dodgeReadyAt = 0;
      this.shopTab = 0;
      this.shopPage = 0;
      // 商店盖在地图之上：先收起地图层（逻辑状态保留，关闭时重建）
      if (this.mapOpen) this.destroyLayer('mapLayer');
      this._pausedForShop = !this.mapOpen && !this.deathOpen;
      if (this._pausedForShop) { try { this.physics.world.pause(); } catch (e) { /* 忽略 */ } }
      this.attacking = false;
      this.diving = false;
      this.isCharging = false;
      if (this.chargeRing) this.chargeRing.setVisible(false);
      if (this.diveFx) this.diveFx.setVisible(false);
      if (this.hero) this.hero.setVelocity(0, 0);
      if (this.touchUI) this.touchUI.setVisible(false);
      this.shopData = callBridge('shopData', this.points);
      this.buildShopLayer();
      if (this.shopLayer) {
        this.shopLayer.setAlpha(0);
        this.tweens.add({ targets: this.shopLayer, alpha: 1, duration: 200 });
      }
      setBgmScene('shop');
      sfx('shop');
      this.setHudButtonOn('shop', true);
    }

    closeShop() {
      if (!this.shopOpen) return;
      this.shopOpen = false;
      this.destroyLayer('shopLayer');
      this.shopItemRects = [];
      if (this.panelButtons) this.panelButtons.shop = [];
      this.setHudButtonOn('shop', false);      setBgmScene(bgmForRoom(this.roomNode ? this.roomNode.type : 'enemy'));
      sfx('click');

      // 结束 Boss 房间后打开过商店：关闭后继续选房间
      if (this.pendingMapAfterShop && !this.deathOpen) {
        this.pendingMapAfterShop = false;
        this.openMap();
        return;
      }
      // 从地图界面打开的商店：关闭后回到地图
      if (this.mapOpen) {
        this.buildMapLayer();
        if (this.mapLayer) {
          this.mapLayer.setAlpha(0);
          this.tweens.add({ targets: this.mapLayer, alpha: 1, duration: 180 });
        }
        return;
      }
      if (this._pausedForShop) {
        this._pausedForShop = false;
        try { this.physics.world.resume(); } catch (e) { /* 忽略 */ }
      }
      if (this.touchUI) this.touchUI.setVisible(this._lastInputWasTouch === true);
    }

    onShopAction(action) {
      if (action === 'close') { this.closeShop(); return; }
      if (action === 'prev') { this.shopPage = Math.max(0, this.shopPage - 1); this.rebuildShop(); return; }
      if (action === 'next') { this.shopPage = this.shopPage + 1; this.rebuildShop(); return; }
      if (action.indexOf('tab') === 0) {
        this.shopTab = parseInt(action.slice(3), 10) || 0;
        this.shopPage = 0;
        this.rebuildShop();
        return;
      }
    }

    rebuildShop() {
      if (!this.shopOpen) return;
      this.destroyLayer('shopLayer');
      this.buildShopLayer();
    }

    /** 购买：金币与解锁由宿主处理，2D 层只负责展示与反馈 */
    buyShopItem(id) {
      var res = callBridge('shopBuy', id, this.points);
      if (!res) { sfx('error'); this.showCenter('商店数据不可用', '#ff8a7a'); return; }
      if (res.ok) {
        sfx('buy');
        if (typeof res.points === 'number') this.points = res.points;
        this.showCenter(res.name ? ('已购买 · ' + res.name) : '购买成功', '#73f0b4');
        this.refreshHud();
      } else {
        sfx('error');
        this.showCenter(res.msg || '无法购买', '#ff8a7a');
      }
      this.shopData = callBridge('shopData', this.points) || this.shopData;
      this.rebuildShop();
    }

    // ---------- 图鉴（画面内）----------
    /**
     * 深渊图鉴：只讲 **2D 试炼** 里真实成立的规则
     *   · 内容全部从运行中的表里现算（英雄 / 怪物 / 技巧 / 连招 / 诅咒 / 环境），
     *     所以改数值不会让图鉴说谎
     *   · 形象直接用 角色形象.js 生成的同一张精灵（与战场完全一致）
     *   · 诅咒与环境写清「文字模式原描述 → 在 2D 里实际变成什么」
     */
    codexEntries(section) {
      var A = 角色形象, self = this, out = [];
      // 图鉴补充数据（遗物 / 商品 / 增益 / 事件）来自宿主，**按需取一次**。
      // 没有宿主时（单独打开 2D 层）这四个分类只是空的，不会抛错。
      var _extra = null;
      function extra(key) {
        if (_extra === null) _extra = callBridge('codexExtra') || {};
        return (_extra && _extra[key]) ? _extra[key] : [];
      }

      if (section === 'hero') {
        var HERO_INFO = {
          warrior:   { tag: '重甲长剑 · 正面硬吃', atk: '长剑挥砍（近战 · 380ms · ×1.0）', ult: '战吼 —— 立刻 +6 护盾，震退 150px 内的敌人', pas: '开战 +3 护盾（进入每个房间时）', tip: '举盾顶住正面、蓄力跳追高台；血厚，适合先手探房。' },
          guardian:  { tag: '塔盾壁垒 · 举盾换命', atk: '塔盾撞击（近战 · 380ms · ×1.0）', ult: '护盾壁垒 —— +6 护盾，4 秒内受到的伤害减半', pas: '坚壁防御 —— 每次完美格挡 +2 护盾', tip: '全场最吃「完美格挡」的人：挡一下就多 5 点护盾，还会顶开敌人。' },
          paladin:   { tag: '圣光剑 · 越打越稳', atk: '圣光剑（近战 · 380ms · ×1.0）', ult: '神圣审判 —— +8 护盾并回复 4 点生命', pas: '开战 +4 护盾（进入每个房间时）', tip: '开房先存护盾，用护盾换走位，血线始终比对手高一截。' },
          ranger:    { tag: '长弓 · 放风筝（远程）', atk: '疾风箭（远程 · 300ms · ×1.0 · 可穿 2 个）', ult: '精准射击 —— 射出强化箭（×2，穿透到底）', pas: '寻宝天赋 —— 每房间首次击杀 +1 金币', tip: '全场射速最快；滞空按 J 会自动朝最近敌人射击，边跳边打。' },
          rogue:     { tag: '双匕 · 爆发窗口（最瘦）', atk: '双匕连刺（近战 · 380ms · ×1.0）', ult: '影舞突袭 —— 3 秒内攻击 ×2', pas: '迅捷突袭 —— 房间内首次命中 +2 伤害', tip: '突进斩（翻滚后接 J）命中后开技能，3 秒 ×2 能秒掉普通怪。' },
          shadow:    { tag: '长镰 · 高风险爆发', atk: '长镰横扫（近战 · 380ms · ×1.0）', ult: '暗影突袭 —— 1.2 秒无敌，3 秒内攻击 ×3', pas: '暗影步 —— 房间内首次命中必定暴击', tip: '无敌帧里硬穿弹幕，落地接盾反/横扫把爆发一次倒出去。' },
          mage:      { tag: '法杖 · 控场（远程）', atk: '奥术弹（远程 · 560ms · ×1.15 · 追踪 + 溅射）', ult: '元素风暴 —— 以自身为中心 210px 爆发（×2.5 + 击退）', pas: '奥术爆发 —— 每次命中 30% 概率 +3 伤害', tip: '弹丸会转弯，对着人堆放；被围住时元素风暴是解围牌。' },
          sage:      { tag: '卷轴法杖 · 续航（远程）', atk: '灵能波（远程 · 470ms · ×0.85 · 穿透全场）', ult: '法力灌注 —— +8 生命 +3 护盾，3 秒内攻击 ×1.6', pas: '灵能回响 —— 每房间首次击杀回复 2 生命', tip: '一道波穿一条线，适合站在平台边缘往走廊里推。' },
          berserker: { tag: '双斧 · 残血更凶（最宽）', atk: '双斧劈砍（近战 · 380ms · ×1.0）', ult: '破釜沉舟 —— 失去 15% 当前生命，8 秒攻击 ×2.5 且吸血 20%', pas: '嗜血狂暴 —— 生命 ≤50% 时 +2 伤害', tip: '先挨到半血再开技能，吸血叠加后能靠打伤害回血。' }
        };
        var LEGS_CN = { legs: '双腿', robe: '长袍', wisp: '黑雾下摆', lava: '熔岩底座', beast: '四足', bones: '骨腿' };
        var GEAR_CN = {
          sword: '长剑', glowSword: '圣光剑', bow: '长弓', dagger: '匕首', scythe: '长镰',
          staff: '法杖', axe: '战斧', claws: '利爪', spear: '长矛', arm: '腐臂',
          fist: '巨拳', mirror: '镜像兵器', halberd: '重戟', greatsword: '巨剑',
          roundShield: '圆盾', towerShield: '塔盾'
        };
        Object.keys(A.LOOKS).forEach(function (id) {
          var L = A.LOOKS[id];
          if (L.kind !== 'hero') return;
          var info = HERO_INFO[id] || {};
          // ⚠️ name 原来直接写内部 id（'warrior' / 'guardian' …），而图鉴列表会把
          //    name 当作副标题显示出来 —— 玩家看到的就是一串英文（用户反馈的
          //    "该显示中文的地方显示了英文"）。改成完整中文名，
          //    并让列表的副标题改用 tag（真正有信息量的那一行，见 buildCodexRow）。
          var cn = (L.className || '').split(' · ')[0];
          out.push({
            id: id, name: L.className || cn || id, cn: cn, tag: info.tag || '',
            portrait: { kind: 'hero', key: id },
            rows: [
              ['普攻', info.atk || '—'],
              ['主动技能', info.ult || '—'],
              ['被动', info.pas || '—'],
              // 装备原来拼的是内部素材名（sword + roundShield）→ 换成中文
              ['装备', [GEAR_CN[L.weapon] || L.weapon, GEAR_CN[L.offhand] || L.offhand]
                .filter(Boolean).join(' + ') +
                (L.legs ? ' · ' + (LEGS_CN[L.legs] || L.legs) : '')],
              ['体型', '宽 ' + L.build.bw + ' × 高 ' + L.build.bh]
            ],
            note: info.tip || ''
          });
        });

      } else if (section === 'mob') {
        var TIER = { normal: '普通', elite: '精英', mirror: '镜像', boss: '首领' };
        var MOB_EXTRA = {
          skeleton: '中远距离（96~380px）每 1.4 秒判定一次，35% 概率改掷长矛；长矛走抛物线、落地插住，看得见也闪得掉。',
          mimic: '完全照当前玩家：体型、装备、攻击方式全都一样 —— 你远程它就远程（换镜像紫），你近战它就贴身。镜像房里它会按你的属性成长。',
          guard: '举盾冲锋，被打断会立刻再冲；重戟横扫范围比看上去宽。',
          necro: '保持 220px 距离远程放弹幕，被逼近会后撤；平台上那只就是它。',
          magma: '先蓄力再高速冲锋，冲锋命中是 1.5 倍伤害；贴身后改用巨拳。',
          zombie: '走得最慢，但自带 1 点荆棘反伤 —— 打得越急自己越疼。',
          shade: '会飞，能绕过地形直线追你；近身突进快但没有远程手段。',
          lord: '每 2.8~4.4 秒跳起来砸地，落点半径 160px，落地前有影子可读。',
          shadowking: '层主的强化版：更宽、更抗打，砸地频率相同但伤害更高。',
          claw: '最快的普通怪之一，纯贴身扑击，没有远程手段。',
          // B 项三只机制型敌人（2.8 新增）：图鉴里那一行蓝字说明的就是"怎么破它"。
          // 不写清解法的话，玩家只会觉得"这怪打不动/怎么突然走不动了"，机制等于没做。
          bulwark: '正面免疫：站在地上平砍打不动，只能跳劈（从上方砸）或绕到背后。它转身有 700ms 延迟 —— 那个延迟就是绕后的窗口，硬拼是打不动的。',
          weaver: '保持 240px 距离吐网（最远 560px）：网不掉血，只把移动压到 45%、缠身 5.2 秒，而闪避可以直接把网撕开。贴上去它没有别的攻击手段。',
          sacrificer: '自己不追也不打，每 3~4 秒给 320px 内的同伴套一层血盾（6 + 层数 × 1.2，中盾的怪身上有青色环），自己也拿一半 —— 先点掉它，否则每一下伤害都被分摊。'
        };
        Object.keys(ENEMY_TYPES).forEach(function (key) {
          var d = ENEMY_TYPES[key];
          if (key === 'mimic' && !A.LOOKS[key]) return;
          out.push({
            // name 同上：原来写的是内部 key（claw / skeleton / lord …），
            // 而列表会把它当副标题显示 —— 换成中文名，副标题交给 tag。
            id: key, name: d.name, cn: d.name, tag: TIER[d.tier] + ' · ' + (BEHAVIOR_NAMES[d.behavior] || '追击'),
            tier: d.tier,
            portrait: { kind: 'mob', key: key },
            rows: [
              ['层级', TIER[d.tier] || d.tier],
              ['行为', (BEHAVIOR_NAMES[d.behavior] || '追击') + (d.behavior === 'shooter' ? '（保持 ' + (d.keepDist || 200) + 'px）' : '')],
              ['生命 / 攻击', d.hp + ' / ' + d.atk + '（每层 +20% / +15%）'],
              ['移动速度', d.speed + ' px/s'],
              ['攻击距离', d.attackRange + 'px · 前摇 ' + d.windup + 'ms · 后摇 ' + d.recover + 'ms'],
              ['动画帧率', '×' + (A.animRateOf ? A.animRateOf(key) : 1) + (A.animRateOf && A.animRateOf(key) > 1 ? '（动作多，帧率更高）' : '')]
            ],
            note: MOB_EXTRA[key] || ''
          });
        });

      } else if (section === 'skill') {
        out = [
          { id: 'charge', name: '蓄力跳', tag: '按住 空格 / W / ↑，松开起跳', rows: [['跳跃高度', '轻点 520（约 80px）· 半蓄力 835（约 205px）· 满蓄力 1150（约 380px）'], ['满蓄力耗时', '620ms'], ['代价', '蓄力期间移动速度减半'], ['宽限', '走出平台边缘后仍有约 120ms 可起跳（土狼时间）']], note: '平台都是按满蓄力可及范围生成的，够不到就再多蓄一点。' },
          { id: 'dive', name: '跳劈', tag: '滞空时按 J（近战英雄）', rows: [['下坠速度', '960 px/s'], ['下坠命中', '×1.9 伤害 + 额外击退'], ['落地冲击', '半径 130px 范围 ×1.15'], ['限制', '同一敌人一次只结算一次；两次跳劈间隔 360ms']], note: '补刀、清群、突围的主力；空中先蓄力跳再按 J 就能连续跳劈。' },
          { id: 'airshot', name: '空中射击', tag: '滞空时按 J（游侠 / 法师 / 贤者）', rows: [['行为', '自动朝最近的敌人射击'], ['区别', '落地是平射，滞空带俯角'], ['注意', '远程英雄没有跳劈']], note: '三人普攻本来就是远程，空中攻击换成射击而不是下落斩。' },
          { id: 'dodge', name: '闪避（翻滚）', tag: 'K', rows: [['体力消耗', '30 / 100'], ['无敌时间', '320ms'], ['翻滚速度', '520 px/s，持续 260ms'], ['可以取消', '攻击后摇、蓄力']], note: '空中闪避会把下坠速度压到 30% 并逐帧衰减，等于半滞空。' },
          { id: 'perfectDodge', name: '完美闪避', tag: '在敌人命中的瞬间按 K', rows: [['判定窗口', '闪避起手 150ms 内挡下伤害'], ['奖励', '体力全额返还 · 定身 0.9s（半径 175px）· 锐利 3 秒（伤害 ×2.2 且必暴）'], ['附带', '化解 150px 内逼近的弹幕']], note: '体力条在可以完美闪避时会亮起金色呼吸光 —— 看到就按下。' },
          { id: 'guard', name: '防御（举盾）', tag: '按住 S / ↓', rows: [['正面减伤', '只吃 25% 伤害'], ['背后', '不减伤（会提示「背后!」）—— 要转身顶着打'], ['体力消耗', '14 / 秒，与闪避共用同一个体力池'], ['代价', '移动速度 ×0.42、不能起跳'], ['自动收盾', '体力低于 12；回到 30 才能再举']], note: '按 J 会先收盾再攻击，所以「举盾 → 格挡 → 盾反」可以一口气接出来。' },
          { id: 'perfectBlock', name: '完美格挡', tag: '抬盾成型后 200ms 内挡下正面攻击', rows: [['免伤', '完全不掉血'], ['反弹', '攻击者被顶开并定身 0.7s'], ['奖励', '+3 护盾；守护者额外 +2'], ['附带', '化解 130px 内的弹幕，并打开 1.2 秒盾反窗口']], note: '奖励只给时机不给长按：一直举着盾只能减伤，还拿不到护盾。' },
          { id: 'potion', name: '治疗药水', tag: 'L', rows: [['回复量', '最大生命的 35%'], ['来源', '开局携带 + 宝箱 45% 概率掉落 + 商店购买']], note: '遇到「治疗抑制」环境或「药水衰减」诅咒时回复会打折。' },
          { id: 'fury', name: '狂怒（重做）', tag: '满值后按 R', color: '#ffd76a', rows: [
            ['原版（文字试炼）', '上限 10，攻击 / 防御 / 药水各 +1，满后手动「爆发」造成 10~14 点固定伤害；商店有「狂怒燃料」'],
            ['为什么重做', '实时挥砍的频率是回合制的几十倍，10 格瞬间就满；固定伤害在攻击力几十上百的实时尺度下也读不出来'],
            ['现在是什么', '一管进攻资源，上限 ' + FURY.max + '，攒满按 R 进入 ' + (FURY.duration / 1000) + ' 秒狂怒状态'],
            ['攒怒来源', '命中敌人（普通 +2 / 精英与镜像 +3 / 首领 +4）· 连招命中额外 +3 · 完美闪避与完美格挡各 +6 · 击杀 +5 · 挨打 +4'],
            ['为什么不给防御', '举盾与走位不攒怒 —— 它奖励的是"打得凶"，正好和奖励"会躲"的体力形成一组对立'],
            ['狂怒状态', '攻击间隔 ÷1.35 · 伤害 ×1.5 · 移动速度 ×1.25 · 不再被后仰打断'],
            ['代价', '受到的伤害 +15%（狂暴而不设防）'],
            ['不会浪费', '满怒后不会自动爆发，一直存着等你按 R —— 什么时候用由你决定']
          ], note: '节奏感：体力管「活下来」，狂怒管「打得进去」——两者都靠打得好，但一个奖励规避、一个奖励压制。' }
        ];

      } else if (section === 'chain') {
        // 连招有两套招式：近战（挥砍）与远程（弹丸），触发时机完全一样，只换招式本身
        var rc = RANGED_CHAIN;
        out = [
          {
            id: 'sweep', name: '横扫 / ' + rc.triple.name, tag: '地面连按 J 的第 3 下（' + CHAIN.window + 'ms 内）', color: UI.gold,
            rows: [
              ['近战 · 横扫', '伤害 ×' + CHAIN.sweepMult + '、范围 ×' + CHAIN.sweepRange + '（实测 118px 外普通够不到、横扫打得到）'],
              ['远程 · ' + rc.triple.name, '一次射出 ' + rc.triple.spread + ' 支扇形弹（偏角 ±' + rc.triple.spreadDeg + '°），中间 ×1.0、两侧 ×' + rc.triple.sideMult],
              ['提示', '主角头顶显示「接 J · 连斩 1/2 → 2/2」，远程显示「连射 1/2 → 2/2」']
            ],
            note: '近战是一下把身前一整片扫开；远程是同一时间把三支弹铺成一个扇面 —— 都是清小怪的主力。'
          },
          {
            id: 'counter', name: '盾反 / ' + rc.counter.name, tag: '完美格挡后 1.2 秒内按 J', color: '#ffd76a',
            rows: [
              ['近战 · 盾反', '伤害 ×' + GUARD.counterMult + '、必定暴击，把敌人推开，附带短促前冲'],
              ['远程 · ' + rc.counter.name, '伤害 ×' + rc.counter.mult + '、必定暴击、穿透 ' + rc.counter.pierce + '、击退 ' + rc.counter.knock + ' —— 靠击退把人推开，自己不冲'],
              ['前提', '必须先成功完美格挡']
            ],
            note: '全场收益最高的连招：挡一下再打，伤害能到普通攻击的三倍。'
          },
          {
            id: 'roll', name: '突进斩 / ' + rc.roll.name, tag: '翻滚结束后 0.9 秒内按 J', color: '#8ad8ff',
            rows: [
              ['近战 · 突进斩', '伤害 ×' + CHAIN.dodgeMult + '、前冲 ' + CHAIN.dodgeLunge + ' px/s'],
              ['远程 · ' + rc.roll.name, '连续点射 ' + rc.roll.burst + ' 发（间隔 ' + rc.roll.burstGap + 'ms、几乎同一条线），每发 ×' + rc.roll.mult + '、速度 ×' + rc.roll.speedMult + '，三发全中合计 ×' + (rc.roll.mult * rc.roll.burst).toFixed(2)],
              ['每发重新锁定', '连射期间每一发都重新锁定最近的敌人（' + ENV.lockRange + 'px 内）—— 目标在跑、跳上高台，后面几发都会跟着改角度'],
              ['定位', '打「单个硬目标」（精英 / 首领）的持续输出；和三连散（一次铺开好多个目标）正好互补']
            ],
            note: '近战是「翻滚穿过敌人 → 回头一刀」；远程是「翻滚拉开 → 连续点射」，把闪避的无敌帧换成一轮实打实的输出。'
          },
          {
            id: 'landing', name: '落地斩 / ' + rc.land.name, tag: '近战：跳劈落地后 0.7 秒内按 J ｜ 远程：空中射击后落地', color: '#ff9a5a',
            rows: [
              ['近战 · 落地斩', '伤害 ×' + CHAIN.diveMult + '、半径 ' + CHAIN.diveSplashR + 'px 的二次范围伤害'],
              ['远程 · ' + rc.land.name, '伤害 ×' + rc.land.mult + '，弹丸带下坠弧线瞄向地面，命中或插地都会炸开半径 ' + rc.land.blast + 'px（溅射 ×' + rc.land.blastMult + '）'],
              ['窗口来源', '远程没有跳劈，窗口改挂在「空中射击后落地」上 —— 节奏与近战一致']
            ],
            note: '把单点爆发铺成一片：近战靠落地冲击，远程靠插在地上的那一炸。'
          }
        ];
        out.push({
          id: 'rule', name: '连招规则', tag: '窗口、优先级与消耗', color: UI.accent,
          rows: [
            ['优先级', '盾反（反击箭）> 突进斩（连珠箭）> 落地斩（踏地箭）> 三连斩（三连散）'],
            ['窗口', '每个窗口独立计时、各自消耗，不会叠成一次超大伤害'],
            ['打断', '举盾会清空连招计数'],
            ['两套招式', '触发时机、衔接窗口、优先级对近战与远程完全一样；差别只在招式本身 —— 近战靠冲上去挥砍，远程靠弹丸的形态（穿透 / 连射 / 落点 / 多目标）'],
            ['远程招式名', '游侠（弓）/ 法师（法杖）/ 贤者（卷轴）各有自己的四个招式名，见本页各条目的「远程」一行']
          ],
          note: '窗口开着时主角头顶会提示「接 J · XX」，照着按就是收益。'
        });

      } else if (section === 'curse') {
        out = RT_CURSES.map(function (c) {
          return {
            id: c.name, name: c.name, cn: '', tag: '每层深入时随机获得，不重复',
            active: self.hasCurse(c.name),
            rows: [['文字模式', c.desc], ['2D 实时里', c.rt]],
            note: ''
          };
        });
        out.unshift({
          id: 'about', name: '诅咒总则', tag: '文字版试炼的诅咒，在 2D 里怎么生效', rows: [
            ['来源', '每深入一层随机获得一条，全 pool 不重复'],
            ['「每回合」译成', '每 5 秒一次的**腐化脉冲**（屏幕右上角有倒计时，最后 1.5 秒转红）'],
            ['两类改成每房间', '虚弱（攻击 -1）、迟钝（闪避 -5%）在同一房间内累积，清空房间后恢复到本局基础值'],
            ['为什么这么改', '实时战斗没有「回合」，脉冲是能看懂也能预期的等价物；永久削人的两条若按脉冲累积，一层打完角色就废了']
          ], note: ''
        });

      } else if (section === 'env') {
        var cur = this.worldEnv;
        if (cur) {
          out.push({
            id: '__cur', name: '当前环境 · ' + cur.name, tag: '当前生效' + (cur.displayValue ? ' · ' + cur.displayValue : ''), active: true,
            rows: [['原描述', envPlaceholderText((envByName(cur.name) || {}).desc || cur.description || '')], ['2D 实时里', this.envSummaryText() || envPlaceholderText((envByName(cur.name) || {}).rt) || ''], ['当前数值', cur.displayValue || '—']],
            note: '环境每进入一个房间重掷一次（袋抽发牌，15 种都会轮到），对双方同时生效 —— 它既是压力也是机会。'
          });
        }
        out = out.concat(WORLD_ENVS.map(function (e) {
          return {
            id: e.name, name: e.name, cn: '', tag: '每房间随机 · 对双方生效', active: !!(cur && cur.name === e.name),
            // 非当前环境拿不到本层的真实数值，占位符写成「<数值>」，免得图鉴里直接印出 {value}
            rows: [['文字模式（经典）', envPlaceholderText(e.desc)], ['2D 实时里', envPlaceholderText(e.rt)], ['结算位置', e.hook]],
            note: ''
          };
        }));
      } else if (section === 'terrain') {
        // 2.9 地形 / 机制 / 魂晶：与 DOM 图鉴同源（codexTerrainEntries 一处维护）
        out = codexTerrainEntries().map(function (e, i) {
          return {
            id: 'terrain_' + i, name: e.title, cn: e.title, tag: '',
            rows: e.rows, note: e.note
          };
        });
      } else if (section === 'relic') {
        // 遗物：数据来自宿主的池子（现算，因此图鉴永远与实现一致）
        var rl = extra('relics');
        out = rl.map(function (r, i) {
          return {
            id: 'relic_' + i, name: r.name, cn: r.name, tag: r.quality || '遗物',
            rows: [['品质', r.quality || '—'], ['效果', r.desc || '—']],
            note: '精英与层主必掉；宝箱有概率、商店可买、深渊裂隙也会给。'
          };
        });
      } else if (section === 'shop') {
        // 商品：内核的商店目录（与商店里真正上架的是同一份数据）
        var sp = extra('shop');
        out = sp.map(function (it, i) {
          return {
            id: 'shop_' + i, name: it.label, cn: it.label,
            tag: (it.rarity === 'rare' ? '稀有' : '普通') + ' · ' + (it.cost != null ? it.cost + ' 金币' : '—'),
            rows: [['价格', (it.cost != null ? it.cost + ' 金币' : '—')],
                   ['限购', it.maxPurchase ? String(it.maxPurchase) : '不限'],
                   ['说明', it.desc || '—']],
            note: ''
          };
        });
      } else if (section === 'bonus') {
        // 开局增益：内核的全量池（getBonusChoices 只随机抽 3 个，图鉴要全量）
        var bp = extra('bonus');
        out = bp.map(function (b, i) {
          return {
            id: 'bonus_' + i, name: b.title, cn: b.title, tag: '开局三选一',
            rows: [['效果', b.description || '—']],
            note: ''
          };
        });
      } else if (section === 'event') {
        // 随机事件：内核的事件池
        var ev = extra('events');
        out = ev.map(function (e, i) {
          return {
            id: 'event_' + i, name: e.label, cn: e.label, tag: '随机事件',
            rows: [['说明', e.description || '—']],
            note: '事件房里随机抽 3 个备选。'
          };
        });
      }
      return out;
    }

    codexTabs() {
      // 11 类 —— 与文字界面的图鉴对齐（原来只有 6 类：英雄/怪物/技巧/连招/诅咒/环境，
      // 缺了遗物 / 商品 / 增益 / 事件这四类最常被查阅的内容）。
      // 2.9 再加「地形」：骨架 / 机制房 / 三色魂晶 / 读条 / 踩头 —— 否则玩家在一局里
      // 按「菜单 → 图鉴」查不到塌陷房怎么开门（DOM 图鉴有，画布内没有）。
      return [
        { id: 'hero', label: '英雄' }, { id: 'mob', label: '怪物' },
        { id: 'relic', label: '遗物' }, { id: 'shop', label: '商品' },
        { id: 'bonus', label: '增益' }, { id: 'event', label: '事件' },
        { id: 'skill', label: '技巧' }, { id: 'chain', label: '连招' },
        { id: 'curse', label: '诅咒' }, { id: 'env', label: '环境' },
        { id: 'terrain', label: '地形' }
      ];
    }

    openCodex(opts) {
      if (this.codexOpen) return;
      this.codexOpen = true;
      this.codexReturnToDeath = !!(opts && opts.returnToDeath);
      this.dodging = false; this.dodgeReadyAt = 0;
      this.lowerGuard();
      this.codexTab = opts && opts.tab ? opts.tab : (this.codexTab || 'hero');
      this.codexPage = 0;
      this.codexIndex = 0;
      if (this.mapOpen) this.destroyLayer('mapLayer');
      if (this.shopOpen) { this.shopOpen = false; this.destroyLayer('shopLayer'); this.setHudButtonOn('shop', false); }
      this._pausedForCodex = !this.mapOpen && !this.deathOpen;
      if (this._pausedForCodex) { try { this.physics.world.pause(); } catch (e) { /* 忽略 */ } }
      this.attacking = false; this.diving = false; this.isCharging = false;
      if (this.chargeRing) this.chargeRing.setVisible(false);
      if (this.diveFx) this.diveFx.setVisible(false);
      if (this.hero) this.hero.setVelocity(0, 0);
      if (this.touchUI) this.touchUI.setVisible(false);
      this.buildCodexLayer();
      if (this.codexLayer) {
        this.codexLayer.setAlpha(0);
        this.tweens.add({ targets: this.codexLayer, alpha: 1, duration: 200 });
      }
      sfx('click');
      this.setHudButtonOn('codex', true);
    }

    closeCodex() {
      if (!this.codexOpen) return;
      this.codexOpen = false;
      this.destroyLayer('codexLayer');
      this.panelButtons.codex = [];
      this.codexRects = [];
      this.setHudButtonOn('codex', false);
      sfx('click');
      if (this._pausedForCodex) {
        this._pausedForCodex = false;
        try { this.physics.world.resume(); } catch (e) { /* 忽略 */ }
      }
      if (this.mapOpen) { this.buildMapLayer(); return; }
      if (this.deathOpen) { return; }
      if (this.touchUI) this.touchUI.setVisible(this._lastInputWasTouch === true);
    }

    rebuildCodex() {
      if (!this.codexOpen) return;
      this.destroyLayer('codexLayer');
      this.buildCodexLayer();
    }

    onCodexAction(action) {
      if (action === 'close') { this.closeCodex(); return; }
      if (action === 'prev') { this.codexPage = Math.max(0, this.codexPage - 1); this.codexIndex = this.codexPage * this.codexPerPage(); this.rebuildCodex(); return; }
      if (action === 'next') { this.codexPage = this.codexPage + 1; this.codexIndex = this.codexPage * this.codexPerPage(); this.rebuildCodex(); return; }
      if (action.indexOf('tab:') === 0) {
        this.codexTab = action.slice(4);
        this.codexPage = 0; this.codexIndex = 0;
        this.rebuildCodex();
        return;
      }
    }

    codexPerPage() { return this._codexPerPage || 8; }

    selectCodexEntry(i) {
      var list = this.codexEntries(this.codexTab);
      if (i < 0 || i >= list.length) return;
      this.codexIndex = i;
      this.codexPage = Math.floor(i / this.codexPerPage());
      this.rebuildCodex();
    }

    buildCodexLayer(sizeW, sizeH) {
      var W = (sizeW && sizeW >= 40) ? sizeW : this.scale.width;
      var H = (sizeH && sizeH >= 40) ? sizeH : this.scale.height;
      if (W < 40 || H < 40) { fixCanvasSize(); return null; }
      // mini  = 真的窄：宽度摆不下「左栏列表 + 右栏详情」，只能单栏；
      // tight = 不窄但很矮（手机横屏 800×360：宽度够、高度只有 360）——
      //   它照样能用双栏，只是所有尺寸都得收一档。
      // 原来只有 mini 一个开关，手机横屏落进「不是 mini」的分支、直接套桌面尺寸：
      // 22px 内边距、138 高的形象卡、300px 侧栏，内容被挤出面板，和页脚文字叠成一团。
      var mini = W < 760;
      var tight = !mini && H < 520;
      var compact = mini || tight;   // 字号 / 间距走哪一档
      var self = this;
      var L = this.add.container(0, 0).setDepth(2310).setScrollFactor(0);
      this.codexLayer = L;
      this.panelButtons.codex = [];
      this.codexRects = [];

      this.addDim(L, W, H);

      var tabs = this.codexTabs();
      var list = this.codexEntries(this.codexTab);
      var panelW = Math.min(W * 0.94, 1040), panelH = Math.min(H * 0.92, 660);
      var panelX = W / 2 - panelW / 2, panelY = H / 2 - panelH / 2;
      this.addPanel(L, panelX, panelY, panelW, panelH, {});
      var pad = compact ? 14 : 22;

      // ---- 页眉：标题 + 收录条数 ----
      var headY = panelY + pad + (compact ? 2 : 6);
      L.add(this.add.text(panelX + pad, headY, '深渊图鉴', {
        fontSize: (compact ? 19 : 25) + 'px', color: UI.title, fontStyle: 'bold', letterSpacing: 3
      }).setOrigin(0, 0.5));
      L.add(this.add.text(panelX + pad + (compact ? 108 : 148), headY + 3, '实时战斗', {
        fontSize: (compact ? 11 : 12) + 'px', color: UI.muted, letterSpacing: 1
      }).setOrigin(0, 0.5));
      // 收录统计（30 来个字）在单栏（真窄屏）下不画：360px 宽的面板里它会一路顶到
      // 左边，和「2D 试炼」副标题叠在一起。这一行信息价值最低，先让它让位 ——
      // 空出来的位置正好给「第 N / M 条」用（单栏没有列表可点，玩家得知道自己在哪）。
      if (!mini) {
        L.add(this.add.text(panelX + panelW - pad, headY,
          '收录 ' + this.codexEntries('hero').length + ' 英雄 · ' + this.codexEntries('mob').length + ' 怪物 · ' + this.codexEntries('curse').length + ' 诅咒 · ' + this.codexEntries('env').length + ' 环境', {
            fontSize: (compact ? 11 : 12) + 'px', color: UI.sub
          }).setOrigin(1, 0.5));
      } else {
        L.add(this.add.text(panelX + panelW - pad, headY, (this.codexIndex + 1) + ' / ' + list.length, {
          fontSize: '11px', color: UI.muted
        }).setOrigin(1, 0.5));
      }

      // ---- 分页签 ----
      var tabY = headY + (compact ? 26 : 34), tabH = compact ? 26 : 30;
      var availW = panelW - pad * 2;
      var tabW = Math.min(compact ? 58 : 74, Math.floor((availW - (tabs.length - 1) * 6) / Math.max(1, tabs.length)));
      var tx = panelX + pad;
      tabs.forEach(function (t) {
        var on = t.id === self.codexTab;
        self.uiButton(L, self.panelButtons.codex, 'tab:' + t.id, t.label, tx, tabY, tabW, tabH, on);
        tx += tabW + 6;
      });

      // ---- 主体 ----
      var bodyTop = tabY + tabH / 2 + (compact ? 10 : 14);
      var footH = compact ? 40 : 48;
      var bodyBottom = panelY + panelH - pad - footH;
      // 侧栏宽度：矮屏再收一档，把宽度让给右侧详情 —— 详情里字段行少换一行就省一行高度
      var railW = mini ? 0
        : (tight ? Math.min(168, Math.max(132, panelW * 0.22))
                 : Math.min(300, Math.max(224, panelW * 0.29)));
      // 单栏时一页只放一条：翻页按钮的语义是「翻一页」，而单栏没有列表可以点，
      // 一页塞 5 条的话按一下「下一页」会直接跳过 4 条。
      var pageSize = mini ? 1 : (tight ? 5 : 8);
      this._codexPerPage = pageSize;
      var perPage = pageSize;
      var pageCount = Math.max(1, Math.ceil(list.length / perPage));
      if (this.codexPage >= pageCount) this.codexPage = 0;
      if (this.codexIndex >= list.length) this.codexIndex = 0;
      var cur = list[this.codexIndex] || list[0] || null;

      if (!mini) {
        // 左栏：词条列表（与右栏同高，选中项用绿胶囊）
        var railX = panelX + pad, railY = bodyTop;
        var railH = bodyBottom - bodyTop;
        this.addPanel(L, railX, railY, railW, railH, {
          fill: UI.box, fillAlpha: 0.42, radius: Math.max(8, UI.boxR), lineAlpha: 0.06
        });
        // 底部留 24px 给「第 N / M 页」提示：只留 16 的话提示会顶到最后一行上
        var rowH = (railH - 24) / perPage;
        var start = this.codexPage * perPage;
        for (var i = 0; i < perPage; i++) {
          var it = list[start + i];
          if (!it) break;
          var ry = railY + 8 + i * rowH;
          this.codexRow(L, railX + 8, ry, railW - 16, rowH - 4, it, start + i === this.codexIndex);
        }
        // 翻页提示
        if (pageCount > 1) {
          // 位置必须在左栏**内部**：原来写在 bodyBottom + 12，而那正好是页脚按钮所在的那一行，
          // 提示文字直接压在「‹ 上一页 / 下一页 ›」上面
          L.add(this.add.text(railX + railW / 2, railY + railH - 8,
            '第 ' + (this.codexPage + 1) + ' / ' + pageCount + ' 页 · 共 ' + list.length + ' 条', {
              fontSize: '11px', color: UI.muted
            }).setOrigin(0.5));
        }
      }

      // ---- 右栏 / 单栏：当前词条详情 ----
      var detailX = mini ? panelX + pad : panelX + pad + railW + 16;
      var detailW = mini ? panelW - pad * 2 : panelW - pad * 2 - railW - 16;
      // 传进去的是「紧凑档」而不是「单栏」：矮屏（手机横屏）走双栏，但尺寸必须收小
      this.codexDetail(L, detailX, bodyTop, detailW, bodyBottom - bodyTop, cur, compact);

      // ---- 页脚 ----
      var fy = panelY + panelH - pad - footH / 2;
      var bw = compact ? 92 : 108, bh = compact ? 32 : 36;
      if (pageCount > 1) {
        var pw = compact ? 74 : 88;
        this.uiButton(L, this.panelButtons.codex, 'prev', '‹ 上一页', panelX + pad, fy, pw, bh, false);
        this.uiButton(L, this.panelButtons.codex, 'next', '下一页 ›', panelX + pad + pw + 8, fy, pw, bh, false);
      }
      this.uiButton(L, this.panelButtons.codex, 'close', '返回战斗', panelX + panelW - pad - bw, fy, bw, bh, true);

      return L;
    }

    /** 图鉴左栏条目：中文名 + 英文 id/副标题，选中态用语义色描边 + 左侧色条 */
    codexRow(L, x, y, w, h, it, on) {
      var accent = it.color || (it.tier ? UI.tierHex[it.tier] : UI.cPrimary);
      var r = {
        x: x, y: y, w: w, h: h, i: this.codexRects.length, accent: accent, on: !!on, gfx: null
      };
      var g = this.add.graphics();
      r.g = g;
      L.add(g);
      this.codexRects.push(r);
      this.paintCodexRow(r, false);
      var name = it.cn || it.name;
      L.add(this.add.text(x + 14, y + h / 2 - (it.tag ? 7 : 0), name, {
        fontSize: '13px', color: on ? UI.text : UI.sub, fontStyle: on ? 'bold' : 'normal'
      }).setOrigin(0, 0.5));
      // 副标题：原来显示的是**内部 id**（warrior / claw / skeleton …）——
      // 对玩家没有意义，而且全是英文（用户反馈"该显示中文的地方显示了英文"）。
      // 换成条目自身的 tag（"重甲长剑 · 正面硬吃" / "精英 · 冲锋"），
      // 这才是图鉴列表里有信息量的那一行。
      var sub = it.tag || '';
      if (sub && sub !== name) {
        L.add(this.add.text(x + 14, y + h / 2 + 8, sub, {
          fontSize: '10px', color: UI.muted
        }).setOrigin(0, 0.5));
      }
      if (it.active) L.add(this.add.circle(x + w - 14, y + 12, 3.5, UI.cGold, 1));
      return r;
    }

    /** 重画一条图鉴条目（选中 / 悬停 / 常态三态） */
    paintCodexRow(r, hover) {
      var g = r && r.g;
      if (!g || !g.scene) return;
      var rad = Math.max(4, UI.boxR - 4);
      g.clear();
      g.fillStyle(r.on ? r.accent : UI.box, r.on ? 0.16 : (hover ? 0.78 : 0.5));
      g.fillRoundedRect(r.x, r.y, r.w, r.h, rad);
      g.lineStyle(1, r.on ? r.accent : UI.panelLine, r.on ? 0.85 : (hover ? 0.2 : 0.06));
      g.strokeRoundedRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, rad);
      if (r.on) {   // 左侧 3px 色条：当前这一条的定位标记
        g.fillStyle(r.accent, 1);
        g.fillRoundedRect(r.x + 2, r.y + 4, 3, r.h - 8, 1.5);
      }
    }

    /** 图鉴右栏详情：形象（真实精灵）+ 名称 + 字段行 + 备注 */
    codexDetail(L, x, y, w, h, it, compact) {
      if (!it) return;
      var self = this;
      var A = 角色形象;
      var hasArt = !!(it.portrait && A);
      var artW = compact ? Math.min(150, w * 0.4) : 168;
      var artH = compact ? 118 : 138;
      // 详情区本身就很矮时，形象卡再收一档，把高度让给字段行
      if (h < 190) artH = Math.round(artH * 0.78);

      // ---- 形象卡：直接用战场上的那张精灵（idle + 出手两帧）----
      if (hasArt) {
        this.addPanel(L, x, y, artW, artH, { fill: UI.box, fillAlpha: 0.5, radius: Math.max(8, UI.boxR), lineAlpha: 0.07 });
        var tex = null, frames = [0, 9];
        try {
          if (it.portrait.kind === 'hero') {
            tex = A.ensureHeroTexture(this, it.portrait.key);
            frames = [0, 9];
          } else {
            tex = A.ensureMobTexture(this, it.portrait.key, this.heroLookId);
            frames = [0, 2];
          }
        } catch (e) { tex = null; }
        if (tex) {
          var sc = compact ? 0.86 : 1.0;
          var cx1 = x + artW * 0.32, cx2 = x + artW * 0.72, cy1 = y + artH * 0.62;
          L.add(this.add.image(cx1, cy1, tex, frames[0]).setOrigin(0.5, 1).setScale(sc));
          L.add(this.add.image(cx2, cy1, tex, frames[1]).setOrigin(0.5, 1).setScale(sc));
          // 地面线：两帧站在同一条线上，不然形象会"飘"
          var gl = this.add.graphics();
          gl.lineStyle(1, UI.panelLine, 0.16);
          gl.beginPath(); gl.moveTo(x + 12, cy1 + 1); gl.lineTo(x + artW - 12, cy1 + 1); gl.strokePath();
          L.add(gl);
          L.add(this.add.text(cx1, cy1 + 6, '待机', { fontSize: '10px', color: UI.muted }).setOrigin(0.5, 0));
          L.add(this.add.text(cx2, cy1 + 6, it.portrait.kind === 'hero' ? '出手' : '出手', { fontSize: '10px', color: UI.muted }).setOrigin(0.5, 0));
        }
      }

      // ---- 名称块 ----
      var textX = hasArt ? x + artW + 16 : x;
      var textW = hasArt ? w - artW - 16 : w;
      var nameColor = it.tier ? UI.tier[it.tier] : (it.color || UI.title);
      L.add(this.add.text(textX, y + 4, it.cn || it.name, {
        fontSize: (compact ? 17 : 20) + 'px', color: nameColor, fontStyle: 'bold'
      }).setOrigin(0, 0));
      if (it.cn && it.cn !== it.name) {
        L.add(this.add.text(textX, y + (compact ? 26 : 30), it.name, {
          fontSize: '11px', color: UI.muted
        }).setOrigin(0, 0));
      }
      if (it.tag) {
        L.add(this.add.text(textX, y + (compact ? 42 : 50), it.tag, {
          fontSize: (compact ? 11 : 12) + 'px', color: UI.sub, wordWrap: wrapCN(textW)
        }).setOrigin(0, 0));
      }
      if (it.active) {
        var ab = this.add.text(textX + textW, y + 6, '● 本层生效中', { fontSize: '11px', color: UI.gold, fontStyle: 'bold' }).setOrigin(1, 0);
        L.add(ab);
      }

      // ---- 字段行：标签（沉色，右对齐） + 值（正文色），与死亡结算面板同一套节奏 ----
      // 字段行是并排画在形象卡**右边**的（textX = x + artW + 16），所以不该按形象卡的高度
      // 往下推。原来推了整整 138px，而手机横屏下整个详情区只有 212px 高 —— 字段行直接被
      // 推到面板外面，叠在页脚按钮上，这就是「文字叠在一起」的由来。
      // 真正需要避开的只是上面那三行标题块。
      var listTop = y + (compact ? 74 : 86) + 12;
      var bottom = y + h;                          // 详情区下沿：任何内容都不该越过它
      // 标签列宽按这一条里最长的标签现算：原来固定 64px，遇到 7 个字的「两类改成每房间」
      // 就被撑破，标签直接压到右边的值上（这也是「文字叠在一起」的一种）。
      var labelFont = (compact ? 11 : 12) + 'px';
      var labelW = compact ? 64 : 78;
      (it.rows || []).forEach(function (r) {
        // make.text 且不加入显示列表：只为量一次宽度，不会闪一下
        var probe = self.make.text({ x: 0, y: 0, text: r[0], style: { fontSize: labelFont } }, false);
        var wpx = probe.width;
        probe.destroy();
        labelW = Math.max(labelW, Math.min(Math.round(wpx + 10), Math.round(textW * 0.45)));
      });
      var cy = listTop;
      (it.rows || []).forEach(function (r) {
        // 万一还是放不下，宁可少画一行，也不要画到面板外和页脚叠在一起
        if (cy + 18 > bottom) return;
        var lab = self.add.text(textX, cy, r[0], {
          fontSize: labelFont, color: UI.muted, wordWrap: wrapCN(labelW - 6)
        }).setOrigin(0, 0);
        L.add(lab);
        var val = self.add.text(textX + labelW, cy - 1, r[1], {
          fontSize: (compact ? 12 : 13) + 'px', color: UI.text, lineSpacing: 4,
          wordWrap: wrapCN(textW - labelW)
        }).setOrigin(0, 0);
        L.add(val);
        // 行高取标签和值里更高的那个：标签换行成两行时，行高只算值会把下一行压上来
        cy += Math.max(20, Math.max(val.height, lab.height) + 7);
      });

      // ---- 备注 ----
      if (it.note) {
        var noteY = cy + 6;
        var room = bottom - noteY;
        // 留不下两行就干脆不画：画一半会越过面板下沿盖住页脚
        if (room >= 34) {
          var bar = this.add.graphics();
          bar.fillStyle(UI.cAccentLine || 0x5fd0e0, 0.5);
          bar.fillRoundedRect(textX, noteY + 2, 2, Math.max(12, Math.min(56, room - 8)), 1);
          L.add(bar);
          var note = this.add.text(textX + 10, noteY, it.note, {
            fontSize: (compact ? 11 : 12) + 'px', color: UI.accent, lineSpacing: 5,
            wordWrap: wrapCN(textW - 14)
          }).setOrigin(0, 0);
          // 长备注整体缩一点，而不是溢出去 —— 缩放比截断保留的信息多
          if (note.height > room - 4) note.setScale(Math.max(0.74, (room - 4) / note.height));
          L.add(note);
        }
      }
    }

    /** 图鉴条目行的命中（悬停反馈用：返回该行的矩形） */
    hitCodexRow(p) {
      if (!this.codexRects) return null;
      for (var i = 0; i < this.codexRects.length; i++) {
        var r = this.codexRects[i];
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return r;
      }
      return null;
    }

    /** 图鉴层内的条目点击（与面板按钮共用一套命中） */
    handleCodexClick(p) {
      if (!this.codexRects || !this.codexRects.length) return false;
      for (var i = 0; i < this.codexRects.length; i++) {
        var r = this.codexRects[i];
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
          var list = this.codexEntries(this.codexTab);
          var idx = this.codexPage * this.codexPerPage() + r.i;
          if (list[idx]) { sfx('click'); this.selectCodexEntry(idx); return true; }
        }
      }
      return false;
    }

    buildShopLayer(sizeW, sizeH) {
      var W = (sizeW && sizeW >= 40) ? sizeW : this.scale.width;
      var H = (sizeH && sizeH >= 40) ? sizeH : this.scale.height;
      if (W < 40 || H < 40) {
        // 尺寸异常（画布被压成 0）：先校正尺寸，下一帧重试
        fixCanvasSize();
        return null;
      }
      // 只看宽度是不够的：手机横屏 800×360 宽度过关、高度只有 360，于是套用桌面尺寸
      // （24px 内边距 + 3 行 70px 的商品格），cellH 被压到 37px，而商品名 / 描述 /
      // 备注叠起来要 40px 以上 —— 文字就叠在一起了。高度也得算进来。
      var mini = W < 700 || H < 520;
      var self = this;
      var L = this.add.container(0, 0).setDepth(2300).setScrollFactor(0);
      this.shopLayer = L;
      this.panelButtons.shop = [];
      this.shopItemRects = [];

      this.addDim(L, W, H);

      var data = this.shopData || { points: this.points, groups: [] };      var groups = data.groups || [];
      if (this.shopTab >= groups.length) this.shopTab = 0;

      var panelW = Math.min(W * 0.92, 920), panelH = Math.min(H * 0.9, 620);
      var panelX = W / 2 - panelW / 2, panelY = H / 2 - panelH / 2;
      this.addPanel(L, panelX, panelY, panelW, panelH, {});

      var pad = mini ? 14 : 24;
      var headY = panelY + pad + (mini ? 4 : 8);
      L.add(this.add.text(panelX + pad, headY, '商店', {
        fontSize: (mini ? 18 : 24) + 'px', color: UI.title, fontStyle: 'bold', letterSpacing: 2
      }).setOrigin(0, 0.5));
      L.add(this.add.text(panelX + panelW - pad, headY,
        '金币 ' + (data.points != null ? data.points : Math.round(this.points)), {
          fontSize: (mini ? 14 : 18) + 'px', color: UI.gold, fontStyle: 'bold'
        }).setOrigin(1, 0.5));

      if (!groups.length) {
        L.add(this.add.text(W / 2, H / 2, '商店数据不可用（宿主未提供商品目录）', {
          fontSize: '15px', color: UI.danger
        }).setOrigin(0.5));
        var cw0 = mini ? 100 : 130;
        this.uiButton(L, this.panelButtons.shop, 'close', '返回', W / 2 - cw0 / 2, H / 2 + 60, cw0, mini ? 34 : 40, true);
        return L;
      }

      // 分组标签
      var tabY = headY + (mini ? 30 : 42);
      var tabH = mini ? 28 : 34;
      var tabW = Math.min(mini ? 100 : 136, (panelW - pad * 2 - 16) / Math.max(1, groups.length));
      var tx = panelX + pad;
      groups.forEach(function (g, i) {
        self.uiButton(L, self.panelButtons.shop, 'tab' + i, g.title || ('分组' + (i + 1)), tx, tabY, tabW, tabH, i === self.shopTab);
        tx += tabW + 8;
      });

      var listTop = tabY + tabH / 2 + (mini ? 12 : 18);
      var listBottom = panelY + panelH - pad - (mini ? 44 : 56);
      var cols = mini ? 1 : 2;
      var rows = mini ? 4 : 3;
      var perPage = cols * rows;
      var items = (groups[this.shopTab] && groups[this.shopTab].items) ? groups[this.shopTab].items : [];
      var pageCount = Math.max(1, Math.ceil(items.length / perPage));
      if (this.shopPage >= pageCount) this.shopPage = 0;
      var pageItems = items.slice(this.shopPage * perPage, this.shopPage * perPage + perPage);
      var gapX = 12, gapY = mini ? 8 : 12;
      var cellW = (panelW - pad * 2 - gapX * (cols - 1)) / cols;
      var cellH = Math.min(mini ? 54 : 70, ((listBottom - listTop) - gapY * (rows - 1)) / rows);

      pageItems.forEach(function (it, i) {
        var c = i % cols, r = Math.floor(i / cols);
        var x = panelX + pad + c * (cellW + gapX);
        var y = listTop + r * (cellH + gapY);
        var canBuy = !!it.affordable;
        var owned = !!it.owned;
        self.addPanel(L, x, y, cellW, cellH, {
          radius: UI.boxR,
          fill: owned ? 0x12201a : UI.box,
          fillAlpha: owned ? 0.95 : (canBuy ? 0.96 : 0.72),
          line: owned ? 0x2f5a48 : (canBuy ? UI.cPrimary : 0xffffff),
          lineAlpha: owned ? 0.85 : (canBuy ? 0.32 : 0.08)
        });
        L.add(self.add.text(x + 12, y + (mini ? 13 : 17), it.label || '—', {
          fontSize: (mini ? 12 : 15) + 'px', fontStyle: 'bold',
          color: owned ? '#8fd8b0' : (canBuy ? '#ffffff' : '#9aa0b0')
        }).setOrigin(0, 0.5));
        L.add(self.add.text(x + 12, y + (mini ? 30 : 38), it.desc || '', {
          fontSize: (mini ? 10 : 12) + 'px', color: UI.muted
        }).setOrigin(0, 0.5));
        // ⚠️ 这里原来写 `it.price`，而宿主 bridge 给的是 **`cost`** ——
        //    于是商店里每一格商品右侧都显示 "undefined 点"
        //    （用户反馈的"该显示具体数字的地方显示的是英文"，指的就是它）。
        //    三层兜底：宿主给的 tag（可购买 / 金币不足 / 已售罄）→ 已拥有 → cost。
        //    全都没有就**不显示**，绝不再吐一个 undefined 出来。
        var priceTxt = it.tag || (owned ? '已拥有' : (it.cost != null ? (it.cost + ' 点') : ''));
        if (priceTxt) {
          L.add(self.add.text(x + cellW - 12, y + (mini ? 13 : 17), priceTxt, {
            fontSize: (mini ? 12 : 15) + 'px', fontStyle: 'bold',
            color: owned ? '#8fd8b0' : (canBuy ? UI.gold : UI.muted)
          }).setOrigin(1, 0.5));
        }
        if (it.note) {
          L.add(self.add.text(x + cellW - 12, y + (mini ? 31 : 39), it.note, {
            fontSize: (mini ? 9 : 11) + 'px', color: UI.muted
          }).setOrigin(1, 0.5));
        }
        self.shopItemRects.push({ id: it.id, x: x, y: y + cellH / 2, w: cellW, h: cellH, pad: 0 });
      });

      if (!pageItems.length) {
        L.add(this.add.text(W / 2, (listTop + listBottom) / 2, '该分组暂无可购买的商品', {
          fontSize: '14px', color: UI.muted
        }).setOrigin(0.5));
      }

      var ctrlY = panelY + panelH - pad - (mini ? 8 : 10);
      if (pageCount > 1) {
        var pw = mini ? 36 : 44, ph = mini ? 26 : 32;
        this.uiButton(L, this.panelButtons.shop, 'prev', '◀', panelX + pad, ctrlY, pw, ph, false);
        this.uiButton(L, this.panelButtons.shop, 'next', '▶', panelX + pad + pw + 8, ctrlY, pw, ph, false);
        L.add(this.add.text(panelX + pad + pw * 2 + 22, ctrlY,
          '第 ' + (this.shopPage + 1) + ' / ' + pageCount + ' 页 · 共 ' + items.length + ' 项', {
            fontSize: (mini ? 11 : 13) + 'px', color: UI.muted
          }).setOrigin(0, 0.5));
      }
      var closeW = mini ? 96 : 130, closeH = mini ? 32 : 38;
      this.uiButton(L, this.panelButtons.shop, 'close',
        this.deathOpen ? '返回结算' : (this.mapOpen ? '返回地图' : '返回战斗'),
        panelX + panelW - pad - closeW, ctrlY, closeW, closeH, true);
      return L;
    }

    // ---------- 确认框（结束本局二次确认）----------
    askQuit(msg) {
      if (this.confirmOpen) return;
      this.confirmOpen = true;
      this._confirmMsg = msg || '确认结束本局？';
      if (this.running) {
        this._pausedForConfirm = true;
        try { this.physics.world.pause(); } catch (e) { /* 忽略 */ }
        this.attacking = false;
        this.diving = false;
        this.isCharging = false;
        if (this.chargeRing) this.chargeRing.setVisible(false);
        if (this.hero) this.hero.setVelocity(0, 0);
      }
      if (this.touchUI) this.touchUI.setVisible(false);
      this.buildConfirmLayer();
      sfx('click');
    }

    buildConfirmLayer(sizeW, sizeH) {
      var W = (sizeW && sizeW >= 40) ? sizeW : this.scale.width;
      var H = (sizeH && sizeH >= 40) ? sizeH : this.scale.height;
      if (W < 40 || H < 40) return null;
      var mini = W < 700;
      // ⚠️ depth 必须高于暂停层（2480）：确认框是**严格模态**，任何时候都不该被别的
      //    画内图层压住 —— 被压住的表现是"框看得见、按钮点不到"，玩家只能先关掉
      //    下面那层再回来点（实测反馈过）。这里给到 2520，并且暂停层的结束本局
      //    分支已经改成"先关暂停菜单再弹确认框"，两道保险。
      var L = this.add.container(0, 0).setDepth(2520).setScrollFactor(0);
      this.confirmLayer = L;
      this.panelButtons.confirm = [];

      this.addDim(L, W, H, 0.78);
      var bw = Math.min(W * 0.86, 420), bh = mini ? 158 : 176;
      this.addPanel(L, W / 2 - bw / 2, H / 2 - bh / 2, bw, bh, {});
      L.add(this.add.text(W / 2, H / 2 - (mini ? 44 : 50), '结束本局', {
        fontSize: (mini ? 18 : 21) + 'px', color: UI.title, fontStyle: 'bold', letterSpacing: 2
      }).setOrigin(0.5));
      L.add(this.add.text(W / 2, H / 2 - (mini ? 12 : 14), this._confirmMsg || '', {
        fontSize: (mini ? 12 : 14) + 'px', color: UI.text, align: 'center',
        wordWrap: wrapCN(bw - 40)
      }).setOrigin(0.5));

      var btnW = mini ? 116 : 140, btnH = mini ? 36 : 42, gap = 18;
      var by = H / 2 + (mini ? 44 : 52);
      this.uiButton(L, this.panelButtons.confirm, 'no', '继续战斗', W / 2 - btnW - gap / 2, by, btnW, btnH, true);
      this.uiButton(L, this.panelButtons.confirm, 'yes', '确认结束', W / 2 + gap / 2, by, btnW, btnH, false);
      return L;
    }

    confirmYes() {
      var wasDead = this.heroDead;
      this.closeConfirm();
      this.finishRun(wasDead ? 'dead' : 'manual');
    }

    confirmNo() { this.closeConfirm(); }

    closeConfirm() {
      this.confirmOpen = false;
      this.destroyLayer('confirmLayer');
      if (this.panelButtons) this.panelButtons.confirm = [];
      if (this._pausedForConfirm) {
        this._pausedForConfirm = false;
        this._resumeFromPanelPause();
      }
      if (this.touchUI) this.touchUI.setVisible(this._lastInputWasTouch === true);
    }

    /**
     * 面板全部关掉后恢复物理世界
     * 新面板（决策 / 暂停）可能盖在旧面板之上，所以统一在这里判断一次，
     * 而不是在每个 close 里各写一份会互相漏掉的条件。
     */
    _resumeFromPanelPause() {
      if (this.mapOpen || this.shopOpen || this.deathOpen || this.confirmOpen ||
        this.codexOpen || this.choiceOpen || this.pauseOpen || this.relicOpen) return false;
      try { this.physics.world.resume(); } catch (e) { /* 忽略 */ }
      return true;
    }

    // ============================================================
    //  菜单（画内 · 本局中枢）
    //  ------------------------------------------------------------
    //  与 pauseForView 的区别：那个会 `scene.pause()`（整场景停更，宿主让 2D
    //  彻底停住时用，见它的说明）；
    //  这个是**就地暂停** —— 画面照旧、不通知宿主，玩家在战场原地看着菜单继续 / 结束 / 调设置。
    //
    //  v2.8：入口与内容都重做过。原来 HUD 上是「更多」（开 DOM 侧边栏）与
    //  「退出」（其实是开暂停菜单）两颗，名字和行为还对不上；现在合并成一颗
    //  「菜单」，打开的就是下面这个中枢界面，Esc 走同一个入口。
    // ============================================================
    openPauseMenu() {
      if (this.pauseOpen || this._finished || this.heroDead) return false;
      if (this.panelOverlayOpen()) return false;   // 别的面板开着时不叠上来
      this.pauseOpen = true;
      this._pausedForPause = !!this.running;
      if (this.running) {
        try { this.physics.world.pause(); } catch (e) { /* 忽略 */ }
        this.attacking = false;
        this.diving = false;
        this.isCharging = false;
        this.dodging = false;
        if (this.chargeRing) this.chargeRing.setVisible(false);
        if (this.hero) this.hero.setVelocity(0, 0);
      }
      if (this.touchUI) this.touchUI.setVisible(false);
      this.buildPauseLayer();
      sfx('click');
      this.emitRt('rt:pause', { open: true, floor: this.floor });
      return true;
    }

    closePauseMenu() {
      if (!this.pauseOpen) return false;
      this.pauseOpen = false;
      this._pausedForPause = false;
      // destroyLayer 会顺手清掉 _menuDiffBtns（见那里的说明）
      this.destroyLayer('pauseLayer');
      if (this.panelButtons) this.panelButtons.pause = [];
      this._resumeFromPanelPause();
      if (this.touchUI) this.touchUI.setVisible(this._lastInputWasTouch === true);
      this.emitRt('rt:pause', { open: false, floor: this.floor });
      return true;
    }

    /** 菜单里的系统功能项（顺序 = 玩家排查问题的常见顺序：先看条件，再改设置，最后才是作弊） */
    menuEntries() {
      return [
        { id: 'condition', label: '通关条件', icon: 'condition' },
        { id: 'codex', label: '图鉴', icon: 'codex' },
        { id: 'tutorial', label: '教程', icon: 'tutorial' },
        { id: 'settings', label: '设置', icon: 'settings' },
        { id: 'save', label: '存档管理', icon: 'save' },
        { id: 'cheat', label: '作弊', icon: 'cheat' },
        { id: 'legacy', label: '切换老版 2.6', icon: 'legacy' }
      ];
    }

    /**
     * 菜单主体：本局中枢
     * ------------------------------------------------------------
     * v2.8 重绘。原来是「已暂停 + 两颗按钮」的小窗，而侧边栏那 8 项功能
     * （作弊 / 通关条件 / 设置 / 教程 / 图鉴 / 存档管理 / 难度 / 切换老版）
     * 得先点 HUD「更多」打开 DOM 侧边栏才够得着 —— 同一块屏幕上两套入口、两种风格。
     * 现在合并成一个中枢：左边「你现在的处境」、右边「你能做的事」、
     * 底部两颗决策按钮。全部画布内绘制，DOM 只保留本身就是 DOM 的重面板。
     *
     * 尺寸**由内容算出来**（先量几何再画）：窄屏上固定高度必然顶出画面。
     */
    buildPauseLayer(sizeW, sizeH) {
      var self = this;
      var W = (sizeW && sizeW >= 40) ? sizeW : this.scale.width;
      var H = (sizeH && sizeH >= 40) ? sizeH : this.scale.height;
      if (W < 40 || H < 40) return null;
      // ⚠️ 重画前必须先销毁旧层。
      //    这条路径会被「在菜单里切难度」走到（换完难度要重画一次刷新高亮），
      //    不销毁的话每切一次就**叠一层**：dim 越叠越黑、旧层的按钮仍然留在
      //    场景里被渲染，而 closePauseMenu / 重排都只认最后建的那一层 ——
      //    前面几层永远回收不掉。实测连点几次难度之后画面就拖不动了。
      if (this.pauseLayer) this.destroyLayer('pauseLayer');
      // 紧凑模式：手机横屏（≈800×360）与任何偏矮的窗口 —— 那两种尺寸下双栏会挤成一条缝
      var mini = W < 880 || H < 560;
      var pad = mini ? 16 : 28;
      var gapG = mini ? 8 : 12;
      var cellH = mini ? 40 : 46;
      var diffH = mini ? 30 : 34;
      var headH = mini ? 54 : 64;
      var footH = mini ? 54 : 66;
      var stripH = mini ? 30 : 0;

      // ---------- 先量几何，再画 ----------
      var pw = Math.min(W - (mini ? 20 : 120), 940);
      // 左栏宽只依赖 pw（不依赖高度）—— 所以不会和下面的 ph 互为因果
      var lw = mini ? 0 : Math.round(Math.min(296, pw * 0.34));
      var rw = pw - pad * 2 - lw - (mini ? 0 : 25);
      var cols = rw >= 640 ? 4 : (rw >= 460 ? 3 : (rw >= 320 ? 2 : 1));
      var entries = this.menuEntries();
      var rows = Math.max(1, Math.ceil(entries.length / cols));
      var gridH = rows * cellH + (rows - 1) * gapG;
      var contentH = gridH + (mini ? 12 : 16) + diffH;
      // 左栏要留出「诅咒明细」的地方：只留计数的话，中诅咒的玩家在菜单里
      // 看到的还是个说不清代价的数字（而那正是最该看清楚的时候）。
      // 上限 4 行 —— 再多就交给「…另有 N 条」，不能让诅咒把面板撑出屏幕。
      var curseLines = mini ? 0 : Math.min((this.curses || []).length, 4);
      var ph = Math.min(
        headH + stripH + contentH + footH + (mini ? 16 : 28) + (curseLines ? 24 + curseLines * 18 : 0),
        H - 24);

      var px = Math.round((W - pw) / 2), py = Math.round((H - ph) / 2);

      var L = this.add.container(0, 0).setDepth(2480).setScrollFactor(0);
      this.pauseLayer = L;
      this.panelButtons.pause = [];
      this.addDim(L, W, H, 0.82);
      this.addPanel(L, px, py, pw, ph, {});

      // ---------- 面板头：标题 + 一行元信息 + Esc 提示 ----------
      var titleFs = mini ? 16 : 21;
      var metaFs = mini ? 10 : 12;
      var headY = py + (mini ? 12 : 20);
      L.add(this.add.text(px + pad, headY, '深渊回廊', {
        fontSize: titleFs + 'px', color: UI.title, fontStyle: 'bold', letterSpacing: mini ? 3 : 5
      }).setOrigin(0, 0));
      var diffName = DIFF_CN[this.difficulty] || '';
      L.add(this.add.text(px + pad, headY + titleFs + (mini ? 4 : 7),
        '已暂停 · 第 ' + this.floor + ' 层' + (diffName ? ' · ' + diffName : '') +
        ' · 击杀 ' + (this.kills || 0), {
          fontSize: metaFs + 'px', color: UI.sub
        }).setOrigin(0, 0));
      // 键盘用户的返回路径。刻意不做成右上角的 ✕：底部「继续战斗」已经是同一件事，
      // 一个动作摆两个控件只会让玩家犹豫按哪个。
      if (!mini) {
        L.add(this.add.text(px + pw - pad, headY + 6, 'Esc 返回战场', {
          fontSize: metaFs + 'px', color: UI.muted
        }).setOrigin(1, 0));
      }

      var bodyTop = headY + titleFs + metaFs + (mini ? 18 : 30);
      var footTop = py + ph - footH;

      // ---------- 主体 ----------
      if (!mini) {
        this.menuStatusCard(L, px + pad, bodyTop, lw, footTop - bodyTop - 6);
        this.menuFunctionGrid(L, px + pad + lw + 25, bodyTop, rw, footTop - bodyTop - 6,
          entries, cols, cellH, gapG, diffH);
      } else {
        this.menuStatusStrip(L, px + pad, bodyTop);
        var gridTop = bodyTop + stripH - 4;
        this.menuFunctionGrid(L, px + pad, gridTop, pw - pad * 2, footTop - gridTop - 6,
          entries, cols, cellH, gapG, diffH);
      }

      // ---------- 底部决策：继续 / 结束 ----------
      var bw = mini ? 152 : 180, bh = mini ? 36 : 42, gapB = 16;
      var bx0 = Math.round(W / 2 - (bw * 2 + gapB) / 2);
      var by = footTop + (footH - 8) / 2;
      this.craftButton(L, this.panelButtons.pause, {
        action: 'resume', label: '继续战斗', shape: 'card', variant: 'primary',
        x: bx0, y: by, w: bw, h: bh
      });
      this.craftButton(L, this.panelButtons.pause, {
        action: 'quit', label: '结束本局', shape: 'card', variant: 'danger',
        x: bx0 + bw + gapB, y: by, w: bw, h: bh
      });
      return L;
    }

    /**
     * 左栏：本局状态卡
     * ------------------------------------------------------------
     * 「暂停」这个动作本身就该带信息量 —— 玩家按下 Esc 的动机往往正是
     * 「我得停下来看清自己现在的处境」。所以这里不只报数，还把**诅咒明细**列出来：
     * 诅咒在持续结算（腐化脉冲），只给一个计数说不清代价，而诅咒恰是 v2.8 里
     * 「重新开始没清干净」那个 bug 的现场，摆在菜单里也便于玩家自己发现异常。
     */
    menuStatusCard(L, x, y, w, h) {
      var self = this;
      if (w < 60 || h < 80) return;
      this.addPanel(L, x, y, w, h, {
        fill: UI.box, fillAlpha: UI.boxAlpha, radius: UI.boxR,
        line: UI.boxLine, lineAlpha: UI.boxLineAlpha
      });
      var pad = 16;
      L.add(this.add.text(x + pad, y + 13, '本局', {
        fontSize: '12px', color: UI.muted, fontStyle: 'bold', letterSpacing: 2
      }).setOrigin(0, 0));

      var curses = this.curses || [];
      var rows = [
        { k: '生命', v: Math.round(this.hero.hp) + ' / ' + this.hero.maxHp, c: UI.hpFrom },
        { k: '护盾', v: String(Math.round(this.hero.shield || 0)), c: UI.shieldFrom },
        { k: '体力', v: Math.round(this.hero.stamina) + ' / ' + this.hero.maxStamina, c: UI.stamFrom },
        { k: '金币', v: String(Math.round(this.points)), c: UI.gold },
        { k: '遗物', v: (this.relics || []).length + ' 件', c: UI.accent },
        { k: '诅咒', v: curses.length + ' 条', c: curses.length ? UI.danger : UI.muted }
      ];
      var ry = y + 40, rh = 24;
      rows.forEach(function (r) {
        L.add(self.add.text(x + pad, ry, r.k, { fontSize: '12px', color: UI.sub }).setOrigin(0, 0.5));
        L.add(self.add.text(x + w - pad, ry, r.v, {
          fontSize: '13px', color: r.c, fontStyle: 'bold'
        }).setOrigin(1, 0.5));
        ry += rh;
      });

      if (!curses.length) return;
      ry += 4;
      L.add(this.add.text(x + pad, ry, '诅咒明细', {
        fontSize: '11px', color: UI.muted, fontStyle: 'bold', letterSpacing: 2
      }).setOrigin(0, 0.5));
      ry += 19;
      var room = Math.floor((y + h - 16 - ry) / 18);
      var show = Math.max(0, Math.min(curses.length, room));
      for (var i = 0; i < show; i++) {
        L.add(this.add.text(x + pad + 6, ry, '· ' + curses[i], {
          fontSize: '12px', color: UI.danger
        }).setOrigin(0, 0.5));
        ry += 18;
      }
      if (show < curses.length) {
        L.add(this.add.text(x + pad + 6, ry, '…另有 ' + (curses.length - show) + ' 条', {
          fontSize: '11px', color: UI.muted
        }).setOrigin(0, 0.5));
      }
    }

    /** 紧凑模式的一行状态摘要（没有左栏时用） */
    menuStatusStrip(L, x, y) {
      var curses = this.curses || [];
      var txt = '生命 ' + Math.round(this.hero.hp) + '/' + this.hero.maxHp +
        '   护盾 ' + Math.round(this.hero.shield || 0) +
        '   体力 ' + Math.round(this.hero.stamina) + '/' + this.hero.maxStamina +
        '   金币 ' + Math.round(this.points) +
        '   遗物 ' + (this.relics || []).length +
        '   诅咒 ' + curses.length;
      L.add(this.add.text(x, y + 12, txt, {
        fontSize: '12px', color: UI.sub
      }).setOrigin(0, 0.5));
    }

    /**
     * 右栏：系统功能网格 + 难度行
     * ------------------------------------------------------------
     * 全部是画布内控件（craftButton 的 card 形状，与商店 / 图鉴 / 死亡结算同一套），
     * 图标用 ensureIconTextures 新画的那一批（同一笔宽，不用 emoji）。
     * 整块在给定高度里**垂直居中**，于是同一个函数在桌面（矮而宽）和手机（高而窄）
     * 上都不会把内容顶出面板。
     */
    menuFunctionGrid(L, x, y, w, h, entries, cols, cellH, gapG, diffH) {
      var self = this;
      var rows = Math.max(1, Math.ceil(entries.length / cols));
      var gridH = rows * cellH + (rows - 1) * gapG;
      var blockH = gridH + (diffH ? 16 + diffH : 0);
      var top = y + Math.max(0, Math.round((h - blockH) / 2));
      var gapX = 10;
      var cw = (w - (cols - 1) * gapX) / cols;

      entries.forEach(function (e, i) {
        var r = Math.floor(i / cols), c = i % cols;
        self.craftButton(L, self.panelButtons.pause, {
          action: e.id, label: e.label, icon: e.icon, shape: 'card', variant: 'ghost',
          x: Math.round(x + c * (cw + gapX)), y: Math.round(top + r * (cellH + gapG) + cellH / 2),
          w: Math.round(cw), h: cellH
        });
      });

      if (!diffH) return;
      L.add(this.add.text(x, top + gridH + 10, '难度', {
        fontSize: '11px', color: UI.muted, fontStyle: 'bold', letterSpacing: 2
      }).setOrigin(0, 0.5));
      var diffs = [['easy', '简单'], ['normal', '普通'], ['hard', '困难'], ['hell', '地狱'], ['custom', '自定义']];
      var gapD = 6;
      var dw = (w - (diffs.length - 1) * gapD) / diffs.length;
      var dy = top + gridH + 16 + diffH / 2;
      var diffBtns = [];
      diffs.forEach(function (d, i) {
        diffBtns.push(self.craftButton(L, self.panelButtons.pause, {
          action: 'diff:' + d[0], label: d[1], shape: 'card',
          // 当前难度用 primary 高亮。与「继续战斗」同色是刻意的：
          // 它表示「现在生效的状态」，而不是一个待点的动作
          variant: (self.difficulty === d[0]) ? 'primary' : 'plain',
          x: Math.round(x + i * (dw + gapD)), y: Math.round(dy),
          w: Math.round(dw), h: diffH
        }));
      });
      // 留住这排胶囊的引用：切难度只重画它们，不整层重建（见 refreshMenuDifficulty）
      this._menuDiffBtns = diffBtns;
    }

    /**
     * 切难度后只刷新那排胶囊的高亮
     * ------------------------------------------------------------
     * 原来这里直接 buildPauseLayer() 整层重建 —— 菜单有 55 个显示对象
     * （14 颗按钮 × 底板/图标/文字 + 面板 + 各处文字），实测一次 **17.95ms**，
     * 比一帧预算还长：点一下难度就掉一帧，连点就是一串可见的卡顿。
     * 而这件事真正变的只有 5 颗胶囊的语义色，重建其余 50 个对象纯属白做。
     *
     * 注意三个字段要一起改：craftButton 建立时按 variant 定了底板 tint
     * 与文字颜色，只改 variant 的话重绘出来的还是旧色。
     */
    refreshMenuDifficulty() {
      var self = this;
      (this._menuDiffBtns || []).forEach(function (b) {
        if (!b || !b.gfx || !b.gfx.scene) return;
        var on = (b.action === 'diff:' + self.difficulty);
        var want = on ? 'primary' : 'plain';
        b.variant = want;
        b.tint = on ? UI.cPrimary : UI.cPlain;
        if (b.text) b.text.setColor(on ? '#d8fff0' : UI.sub);
        self.paintButton(b);
      });
    }

    onPauseAction(action) {
      if (!action) return;
      if (action === 'resume') { this.closePauseMenu(); return; }
      if (action === 'quit') {
        // ⚠️ 顺序不能反：**必须先关掉菜单，再弹结束确认框**。
        //    两个都是画内图层，菜单层 depth 2480、确认层 2520 —— 即使 depth 已经
        //    够了，留着菜单层也意味着"玩家点确认结束后，回退路径上还压着一个
        //    已经没意义的菜单窗"。
        this.closePauseMenu();
        this.askQuit('确认结束本局？');
        return;
      }
      // 难度：交给宿主换（只有宿主知道难度怎么生效、怎么落存档），换完只刷新
      // 那排胶囊的高亮。与侧边栏那个下拉是同一条路径，不会出现两套难度逻辑。
      if (action.indexOf('diff:') === 0) {
        var v = action.slice(5);
        if (callBridge('setDifficulty', v)) {
          // 立刻把引擎侧的难度标记也改掉再刷新：引擎真正的难度系数由宿主的
          // 难度签名比对异步下发，这里若不等，刷新读到的还是旧值 ——
          // 表现就是"点了困难，高亮还停在普通上"。
          this.difficulty = v;
          this.refreshMenuDifficulty();
        } else {
          this.showCenter('难度切换不可用', '#ffd76a');
        }
        return;
      }
      // 其余功能（通关条件 / 图鉴 / 教程 / 设置 / 存档管理 / 作弊 / 切换老版）本身就是
      // DOM 面板，引擎不认识它们 —— 只把 id 交给宿主，由宿主打开对应界面，并在它
      // 关闭后解冻战斗（经典2D.js 的 anyDomPanelOpen + MutationObserver 负责这一对）。
      // 这样"引擎只画界面、宿主管业务"的边界没有被打破。
      if (!callBridge('openPanel', action)) {
        this.showCenter('该功能暂不可用', '#ffd76a');
      }
    }

    // ============================================================
    //  决策面板（奖励三选一 / 诅咒抉择 / 事件 / 休整）
    //  ------------------------------------------------------------
    //  内容**全部由宿主给**，引擎只负责画与回传：
    //    { title, desc, cards: [{ id, name, desc, quality, tag, disabled }],
    //      actions: [{ id, label, primary }] }
    //  选完 → bridge.choiceResult({ kind, action, id, card, index }) + emit 'rt:choice'。
    //  与其它画内面板一样登记进 panelOverlayOpen，打开时冻结战斗。
    // ============================================================
    openChoicePanel(kind, data) {
      if (this.choiceOpen) this.closeChoicePanel(null);
      var W = this.scale.width, H = this.scale.height;
      if (W < 40 || H < 40) return false;
      data = data || {};
      this.choiceOpen = true;
      this.choiceKind = kind || 'reward';
      this.choiceData = data;
      // 上限 12：商店 5 张 / 遗物 4 张 / **英雄选择 9 张**（搬进画布后要用）。
      // 原来写死 4，第 5 张（净化）会被静默截掉；写死 6 又装不下 9 位英雄。
      this.choiceCards = (data.cards || []).slice(0, 12);
      this._pausedForChoice = !!this.running;
      if (this.running) {
        try { this.physics.world.pause(); } catch (e) { /* 忽略 */ }
        this.attacking = false;
        this.diving = false;
        this.isCharging = false;
        if (this.chargeRing) this.chargeRing.setVisible(false);
        if (this.hero) this.hero.setVelocity(0, 0);
      }
      if (this.touchUI) this.touchUI.setVisible(false);
      this.buildChoiceLayer();
      sfx('click');
      this.emitRt('rt:choice-open', { kind: this.choiceKind, cards: this.choiceCards.length });
      return true;
    }

    /** 关面板并把玩家的选择回传宿主（result 为 null 表示只是收起，没有选择） */
    closeChoicePanel(result) {
      if (!this.choiceOpen) return false;
      this.choiceOpen = false;
      this._pausedForChoice = false;
      this.destroyLayer('choiceLayer');
      if (this.panelButtons) this.panelButtons.choice = [];
      this.choiceRects = [];
      this.choiceCards = [];   // 顺手清掉：否则 debug() 会读到上一块面板的卡片，排查时误导
      this.choiceData = null;
      this._resumeFromPanelPause();
      if (this.touchUI) this.touchUI.setVisible(this._lastInputWasTouch === true);
      if (result) {
        this.emitRt('rt:choice', result);
        callBridge('choiceResult', result);
      }
      return true;
    }

    buildChoiceLayer(sizeW, sizeH) {
      var W = (sizeW && sizeW >= 40) ? sizeW : this.scale.width;
      var H = (sizeH && sizeH >= 40) ? sizeH : this.scale.height;
      if (W < 40 || H < 40) return null;
      var self = this;
      var data = this.choiceData || {};
      var cards = this.choiceCards || [];
      var actions = (data.actions || []).slice(0, 3);
      var mini = W < 700;
      var L = this.add.container(0, 0).setDepth(2450).setScrollFactor(0);
      this.choiceLayer = L;
      this.panelButtons.choice = [];
      this.choiceRects = [];

      this.addDim(L, W, H, 0.84);
      var pw = Math.min(W - 20, mini ? 660 : 780);
      var ph = Math.min(H - 16, mini ? 268 : 322);
      var px = Math.round(W / 2 - pw / 2), py = Math.round(H / 2 - ph / 2);
      this.addPanel(L, px, py, pw, ph, {});

      L.add(this.add.text(W / 2, py + (mini ? 14 : 20), data.title || '请选择', {
        fontSize: (mini ? 16 : 20) + 'px', color: UI.title, fontStyle: 'bold', letterSpacing: 2
      }).setOrigin(0.5, 0));
      if (data.desc) {
        L.add(this.add.text(W / 2, py + (mini ? 38 : 50), data.desc, {
          fontSize: (mini ? 11 : 13) + 'px', color: UI.sub, align: 'center',
          wordWrap: wrapCN(pw - 48)
        }).setOrigin(0.5, 0));
      }

      var n = Math.max(1, cards.length);
      var gap = mini ? 10 : 14;
      var padX = mini ? 16 : 26;
      var cardTop = py + (mini ? 76 : 96);
      var actH = actions.length ? (mini ? 34 : 40) : 0;
      var bottomPad = (mini ? 14 : 20);
      // 卡片区可用高度（动作按钮与内边距先扣掉）
      var areaH = py + ph - bottomPad - (actH ? actH + (mini ? 12 : 16) : 0) - cardTop;
      // 一行最多 5 张，超了就换行 —— 选英雄有 9 位，挤一行每张只有 68px，字全糊在一起
      var cols = Math.min(n, 5);
      var rows = Math.ceil(n / cols);
      var cardW = Math.min(mini ? 142 : 168,
        Math.floor((pw - padX * 2 - gap * (cols - 1)) / cols));
      var cardH = Math.max(52, Math.min(mini ? 126 : 150,
        Math.floor((areaH - gap * (rows - 1)) / rows)));
      // 每行各自居中：末行不满时（9 位英雄 = 5 + 4）左边对齐会显得缺一块
      var rowX0 = [];
      for (var ri = 0; ri < rows; ri++) {
        var inRow = Math.min(cols, n - ri * cols);
        var rowW = cardW * inRow + gap * (inRow - 1);
        rowX0.push(Math.round(W / 2 - rowW / 2));
      }

      cards.forEach(function (card, i) {
        var c = i % cols, r = Math.floor(i / cols);
        self.craftChoiceCard(L, card, rowX0[r] + c * (cardW + gap), cardTop + r * (cardH + gap), cardW, cardH, mini);
      });

      if (actions.length) {
        var bh = mini ? 34 : 40;
        var gapA = 12;
        var availA = pw - padX * 2;
        var perMax = Math.floor((availA - gapA * (actions.length - 1)) / actions.length);
        // 按**最长的那一条**文案给够宽度：中文按 1em、英文数字按 0.56em 估宽。
        // 原来这里写死上限 130/156，与文案长度无关 —— 于是"献祭 4 生命 · 解除一条诅咒"
        // 这类长按钮文字直接冲出底板（用户反馈）。
        // 上限是"每个按钮实际能分到的宽度"，实在放不下就交给 paintButton 的字号自适应兜底。
        var fsA = mini ? 13 : 15;
        var needA = 0;
        actions.forEach(function (a) {
          var t = String(a.label || a.id || '');
          var em = 0;
          for (var ci = 0; ci < t.length; ci++) em += (t.charCodeAt(ci) > 255 ? 1 : 0.56);
          needA = Math.max(needA, Math.ceil(em * fsA) + 28);
        });
        var bw = Math.max(mini ? 84 : 96, Math.min(needA, perMax, mini ? 210 : 280));
        var tW = bw * actions.length + gapA * (actions.length - 1);
        var bx = Math.round(W / 2 - tW / 2);
        var by = py + ph - bottomPad - bh / 2;
        actions.forEach(function (a, i) {
          self.uiButton(L, self.panelButtons.choice, 'act:' + a.id, a.label || a.id,
            bx + i * (bw + gapA), by, bw, bh, !!a.primary);
        });
      }
      return L;
    }

    /**
     * 一张可选卡（品质色条 / 名字 / 品质 / 说明）
     * 命中登记进 panelButtons.choice，与其它按钮共用同一套矩形命中。
     */
    craftChoiceCard(layer, card, x, y, w, h, mini) {
      var q = QUALITY_STYLE[card.quality] || QUALITY_STYLE.common;
      var off = !!card.disabled;
      this.addPanel(layer, x, y, w, h, {
        radius: UI.boxR, fill: UI.box, fillAlpha: off ? 0.5 : 0.9,
        line: q.tint, lineAlpha: off ? 0.18 : 0.55
      });
      layer.add(this.add.rectangle(x + w / 2, y + 3, w - 10, 3, q.tint, off ? 0.3 : 0.9).setOrigin(0.5, 0));
      layer.add(this.add.text(x + w / 2, y + (mini ? 12 : 16), card.name || '—', {
        fontSize: (mini ? 13 : 15) + 'px', color: off ? UI.muted : q.color, fontStyle: 'bold'
      }).setOrigin(0.5, 0));
      layer.add(this.add.text(x + w / 2, y + (mini ? 30 : 37), card.tag || q.name, {
        fontSize: (mini ? 10 : 11) + 'px', color: UI.muted
      }).setOrigin(0.5, 0));
      layer.add(this.add.text(x + w / 2, y + (mini ? 46 : 56), card.desc || '', {
        fontSize: (mini ? 10 : 12) + 'px', color: UI.sub, align: 'center',
        wordWrap: wrapCN(w - 16), lineSpacing: 2
      }).setOrigin(0.5, 0));

      var btn = {
        action: 'card', id: card.id, label: card.name, card: card, disabled: off,
        x: x, y: y + h / 2, w: w, h: h, pad: 0, shape: 'card', variant: 'plain', state: 'normal'
      };
      this.choiceRects.push(btn);
      if (!off) this.panelButtons.choice.push(btn);
      return btn;
    }

    /** 决策面板的点击结果：卡片 → { action:'card', id, card }；按钮 → { action:'act:<id>' } */
    onChoiceAction(btn) {
      if (!btn) return;
      var action = btn.action || '';
      var isCard = (action === 'card');
      var result = {
        kind: this.choiceKind,
        action: isCard ? 'card' : action,
        id: isCard ? btn.id : (action.indexOf('act:') === 0 ? action.slice(4) : action),
        card: btn.card || null,
        index: isCard ? (this.choiceCards || []).indexOf(btn.card) : -1
      };
      this.closeChoicePanel(result);
    }

    // ============================================================
    //  画面内控件：血条组件 + 按钮组件
    // ============================================================

    /**
     * 血条组件（轨道 + 语义色渐变填充 + 掉血残影 + 可选辉光）
     * 数值变化按 CSS transition 的节奏补间；静止帧只做位置同步，不产生计算。
     */
    createMeter(opts) {
      opts = opts || {};
      var trackH = opts.h || 7;
      var fillH = Math.max(3, trackH - 2);
      var key = opts.key || 'hp';
      var from = opts.from || UI.hpFrom, to = opts.to || UI.hpTo;
      var m = {
        key: key, from: from, to: to, trackH: trackH, fillH: fillH,
        tint: opts.tint != null ? opts.tint : UI.cPlain,
        x: 0, y: 0, w: 0, value: 1, shown: 1, trail: 1,
        track: null, glow: null, trailImg: null, fill: null, dot: null
      };
      m.bodyTex = barTexture(this, key, fillH, 64, from, to);
      // 残影统一用生命色：任何血条上都能直接读出「刚掉了多少」
      m.trailTex = (key === 'hp') ? m.bodyTex : barTexture(this, 'hp', fillH, 64, UI.hpFrom, UI.hpTo);
      // ⚠️ 纹理是"逻辑 × 密度"像素，显示尺寸必须给**逻辑**值，否则第一帧会按
      //    纹理像素当逻辑像素画出去（宽度是实际的 d 倍）。placeMeter 会再算一次。
      if (opts.track !== false) {
        m.track = this.add.image(0, 0, trackTexture(this, trackH, 64, m.tint))
          .setOrigin(0, 0.5).setDisplaySize(64, trackH);
      }
      if (opts.glow) {
        m.glow = this.add.image(0, 0, glowTexture(this)).setOrigin(0.5, 0.5)
          .setTint(opts.glowTint != null ? opts.glowTint : UI.cPrimary).setAlpha(0.4);
      }
      if (opts.trail !== false) {
        m.trailImg = this.add.image(0, 0, m.trailTex).setOrigin(0, 0.5).setAlpha(0.38)
          .setDisplaySize(64, fillH);
      }
      m.fill = this.add.image(0, 0, m.bodyTex).setOrigin(0, 0.5).setDisplaySize(64, fillH);
      return m;
    }

    /** 组成一个血条的显示对象（按绘制先后返回，便于按顺序入容器） */
    meterParts(m) {
      var out = [];
      if (m.glow) out.push(m.glow);
      if (m.track) out.push(m.track);
      if (m.trailImg) out.push(m.trailImg);
      out.push(m.fill);
      return out;
    }

    /** 血条几何布局（可逐帧调用：只有宽度或密度变化才重建纹理） */
    placeMeter(m, x, y, w) {
      w = Math.max(4, Math.round(w));
      m.x = x; m.y = y;
      m.wLogical = w;
      var d = deviceDpr();
      if (m.w !== w || m.px !== d) {
        m.w = w; m.px = d;
        m.texW = Math.round(Math.max(8, Math.ceil(w / 8) * 8) * d);   // 纹理像素宽
        m.bodyTex = barTexture(this, m.key, m.fillH, w, m.from, m.to);
        m.fill.setTexture(m.bodyTex).setDisplaySize(w, m.fillH);
        if (m.key !== 'hp') m.trailTex = barTexture(this, 'hp', m.fillH, w, UI.hpFrom, UI.hpTo);
        if (m.trailImg) m.trailImg.setTexture(m.trailTex).setDisplaySize(w, m.fillH);
        if (m.track) m.track.setTexture(trackTexture(this, m.trackH, w, m.tint)).setDisplaySize(w, m.trackH);
      }
      if (m.track) m.track.setPosition(x, y);
      if (m.glow) m.glow.setPosition(x + w / 2, y).setDisplaySize(w * 1.1, m.trackH * 3.4);
      this.paintMeter(m);
    }

    /**
     * 「贴在条右侧」的文字该放在哪（生命值 / 体力 / 狂怒）
     * ------------------------------------------------------------
     * 不能记成布局时算死的坐标（x0 + barW + 10）：布局编辑器可以把条缩放到 20%~250%，
     * 条的实际右边缘一变，那个固定坐标就留在原地 —— 数字和条之间裂开一大截，
     * 玩家看到的就是「狂怒进度不固定在狂怒条旁边」。
     * gap 里已经含了玩家自定义的横向偏移（见 applyCustomLayout）。
     */
    meterTextX(meter, gap) {
      var tr = meter && meter.track;
      if (!tr) return null;
      var dw = (tr.displayWidth != null && tr.displayWidth > 0) ? tr.displayWidth : tr.width;
      return tr.x + dw + (gap == null ? 10 : gap);
    }

    /**
     * 狂怒数值的定位（第 10 条）
     * ------------------------------------------------------------
     * 与生命值 / 体力值**共用 meterTextX 的同一口径**，并且共用同一个刷新点：
     * refreshHud() 里会调用它，paintFuryMeter() 里也会调用它 ——
     * 两条路径互为兜底，于是"某些路径只更新了条、没更新数字"不再可能。
     * （用户原话："狂怒条旁边的文字并没有像生命体力那样固定在对应的条旁边"。）
     */
    placeFuryText() {
      if (!this.furyText || !this.furyTextPos) return;
      var fx = this.meterTextX(this.furyMeter, this.furyTextPos.gap);
      if (fx == null) {
        // 兜底：条还没摆出来时贴在默认条宽之后，**不要**退到 x=10（那样文字会跑到
        // 屏幕最左边，看起来就是"狂怒数值没贴在条旁边"）。见下面 meterTextX 的说明。
        var m = this.furyMeter, tr = m && m.track;
        fx = tr ? (tr.x + (tr.displayWidth || 252) + (this.furyTextPos.gap || 10))
          : (24 + 252 + (this.furyTextPos.gap || 10));
      }
      this.furyText.setPosition(fx, this.furyTextPos.y);
    }

    /** 数值同步（只在数值变化时调用，不逐帧） */
    setMeterValue(m, v) {
      var nv = clamp(v, 0, 1);
      if (nv < m.shown) m.trail = Math.max(m.trail, m.shown);   // 掉血：残影留在原处慢慢收
      else m.trail = Math.max(m.trail, nv);
      m.value = nv;
      if (m.glow) m.glow.setAlpha(0.34 * (0.35 + 0.65 * nv));
    }

    /** 补间 + 濒危脉冲（逐帧） */
    updateMeter(m, dt, now) {
      var target = m.value;
      if (m.shown !== target) {
        m.shown += (target - m.shown) * Math.min(1, dt / 110);
        if (Math.abs(m.shown - target) < 0.0015) m.shown = target;
      }
      if (m.trail > m.shown) {
        m.trail += (m.shown - m.trail) * Math.min(1, dt / 340);
        if (m.trail - m.shown < 0.0015) m.trail = m.shown;
      } else if (m.trail !== m.shown) {
        m.trail = m.shown;
      }
      var crit = target > 0 && target <= 0.28;
      var pulse = crit ? 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(now / 150)) : 1;
      if (m._pulse !== pulse) {
        m._pulse = pulse;
        m.fill.setAlpha(pulse);
        if (m.trailImg) m.trailImg.setAlpha(0.38 * pulse);
      }
      this.paintMeter(m);
    }

    /** 血条绘制：位置 + 裁剪（纹理是"逻辑 × 密度"像素，裁剪值也按纹理像素算） */
    paintMeter(m) {
      var vis = m.visible !== false;
      var w = m.w, shown = clamp(m.shown, 0, 1), trail = clamp(m.trail, 0, 1);
      var d = m.px || 1;
      var texW = m.texW || Math.round(Math.max(8, Math.ceil(w / 8) * 8) * d);
      var texH = Math.round(m.fillH * d);
      var dw = w * shown, dtr = w * trail, r = m.fillH / 2;
      if (dw > 0.6 && dw < r * 1.7) {
        // 极低血量：只留一个圆头，避免出现方角碎片
        m.fill.setVisible(false);
        var dot = this.ensureMeterDot(m);
        dot.setVisible(vis).setPosition(m.x, m.y).setDisplaySize(Math.max(1, dw), m.fillH);
      } else {
        if (m.dot && m.dot.visible) m.dot.setVisible(false);
        m.fill.setVisible(vis && dw > 0.6);
        if (dw > 0.6) {
          m.fill.setPosition(m.x, m.y).setCrop(0, 0, Math.max(1, dw * texW / w), texH);
        }
      }
      if (m.trailImg) {
        if (vis && dtr > dw + 0.6) {
          m.trailImg.setVisible(true).setPosition(m.x, m.y)
            .setCrop(0, 0, Math.max(1, dtr * texW / w), texH);
        } else if (m.trailImg.visible) {
          m.trailImg.setVisible(false);
        }
      }
    }

    /** 极低血量的圆头（懒创建：正常血量不占显示对象） */
    ensureMeterDot(m) {
      if (!m.dot) {
        m.dot = this.add.circle(0, 0, Math.max(2, m.fillH / 2),
          parseInt(m.from.replace('#', ''), 16), 1).setOrigin(0, 0.5).setDepth(9);
      }
      return m.dot;
    }

    /** 整条血条显示 / 隐藏 */
    setMeterVisible(m, v) {
      v = !!v;
      if (m.visible === v) return;
      m.visible = v;
      if (m.glow) m.glow.setVisible(v);
      if (m.track) m.track.setVisible(v);
      this.paintMeter(m);
    }

    /** 销毁整条血条（离开房间时回收，避免残留显示对象） */
    destroyMeter(m) {
      if (!m) return;
      ['glow', 'track', 'trailImg', 'fill', 'dot'].forEach(function (k) {
        if (m[k]) { m[k].destroy(); m[k] = null; }
      });
      m.visible = false;
    }

    /**
     * 一排常驻胶囊按钮的布局
     * ------------------------------------------------------------
     * 每颗按钮先在「未缩放」状态下量一次原生宽度，按它分到一个固定槽位；
     * 位置 = 槽位中心，缩放 = 改绘制尺寸。这样编辑器里把某一颗改小或隐藏，
     * 不会把它右边的按钮挤走 —— 「一颗一颗单独调」才成立。
     *
     * `maxRight`（可选）：这一行**允许到达的最右 x**。给了它就会在必要时
     * 给整行乘一个统一的收缩系数 `fitScale`，保证行尾不会越出画面。
     * 收口的原因见下面那段注释 —— 少了它，窄屏上行尾那颗按钮会被推出屏幕。
     */
    layoutPillRow(btns, x0, by, bh, gapX, maxRight) {
      var self = this;
      (btns || []).forEach(function (b) {
        if (!b || !b.gfx) return;
        b.baseH = bh;
        b._baseFont = Math.round(clamp(bh * 0.42, 11, 16));
        // 量原生宽度：临时把缩放 / 透明当作默认，免得量到缩放后的值
        var ku = b.userScale, ka = b.userAlpha, kf = b.fitScale;
        b.userScale = 1; b.userAlpha = 1; b.fitScale = 1; b.h = bh; b.w = 24;
        self.paintButton(b);
        b.baseW = Math.max(24, b.w);
        b.userScale = ku; b.userAlpha = ka; b.fitScale = kf;
      });

      // ------------------------------------------------------------
      // 溢出收口（第 2 条：窄屏上「最后那颗按钮不见了」）
      // ------------------------------------------------------------
      // 按钮的字号 / 高度都有绝对下限（字号 11px、高 24px），于是这一行有一个
      // **最小可能宽度**（4 颗约 320px）。窗口比它窄时，旧代码照样按原生宽度
      // 从左往右排 —— 行尾那颗被整个推到屏幕右侧之外：玩家看不见它，
      // 连布局编辑器的框也在屏幕外，点不到（表现为「按钮不见了 / 点不到」）。
      // 这里改成整体等比收缩：宁可小一圈，也保证整行落在画面里。
      var fit = 1;
      var list = (btns || []).filter(function (b) { return b && b.gfx; });
      if (maxRight && list.length > 0) {
        var total = 0;
        list.forEach(function (b) { total += b.baseW; });
        total += gapX * (list.length - 1);
        var avail = maxRight - x0;
        if (total > avail && total > 0) fit = clamp(avail / total, 0.5, 1);
      }

      // 按**取整后的实际宽度**排槽位：先前的写法用未取整的 baseW×fit 算槽位，
      // 而真正绘制时每颗都会 round 一次 —— 每颗最多多出 1px，4~5 颗累积下来
      // 整行就比预算长出几个像素，最后那颗还是会探出边界。
      function assign(f) {
        var bx = x0;
        list.forEach(function (b) {
          // 向下取整而不是四舍五入：floor 保证每颗都**不超过**预算宽度，
          // 于是整行永远不会比算出来的总宽更长（round 会每颗多出最多 1px，
          // 4~5 颗累积下来最右边那颗照样探出边界）。
          var w = Math.max(16, Math.floor(b.baseW * f));
          b.slotCenter = bx + w / 2;
          bx += w + gapX;
        });
        return bx - gapX;
      }
      var end = assign(fit);
      if (maxRight && end > maxRight && end > x0) {
        // 还超：用**实测行尾**再反算一档，把取整误差一起吃掉
        fit = clamp(fit * (maxRight - x0) / (end - x0), 0.5, 1);
        end = assign(fit);
      }
      list.forEach(function (b) { b.fitScale = fit; });
      list.forEach(function (b) {
        b.y = by;
        self.applyButtonStyle(b, b.userScale || 1,
          b.userAlpha == null ? 1 : b.userAlpha, b._hidden);
      });
      return end;   // 行尾 x
    }

    /**
     * 按钮的样式落地（位置之外的缩放 / 透明度 / 显隐）
     * ------------------------------------------------------------
     * 按钮不能走 setScale：底板是 craftButton 用绝对坐标画在 Graphics 上的，
     * 缩放会以 (0,0) 为原点把整颗按钮拖到画面左上角去。
     * 所以缩放落在「数据尺寸」上（baseH / baseW × s），再重绘 ——
     * 字号、内边距、命中矩形都会跟着等比收放。
     */
    applyButtonStyle(b, s, a, hide) {
      if (!b || !b.gfx) return;
      s = (s > 0) ? s : 1;
      a = (a == null) ? 1 : a;
      // 实际绘制尺寸 = 编辑器设的缩放 × 本行现算的收口系数。
      // 两者必须分开存：收口系数每次布局都会变，混进 userScale 就会一乘再乘。
      var fit = (b.fitScale > 0) ? b.fitScale : 1;
      b.userScale = s;
      b.userAlpha = a;
      b._hidden = !!hide;
      b.h = Math.max(12, Math.round((b.baseH || b.h) * s * fit));
      // 宽度与 layoutPillRow 的 assign() 同一口径（floor）——
      // 两边一个 round 一个 floor 的话，槽位与实际绘制宽度会差 1px，
      // 累积到行尾就又把最后一颗挤出边界。
      b.w = Math.max(16, Math.floor((b.baseW || b.w) * s * fit));
      if (b.slotCenter != null) b.x = Math.round(b.slotCenter - b.w / 2);
      b.gfx.setVisible(!hide).setAlpha(a);
      if (b.icon) b.icon.setVisible(!hide);
      if (b.text) b.text.setVisible(!hide);
      this.paintButton(b);
    }

    /** 画面内按钮（统一控件）
     *   shape 'pill'：悬浮在战场之上的常驻控件（对齐 .trial-ghost-btn）
     *   shape 'card'：面板之内的动作按钮（对齐 .trial-action-btn）
     * 状态（常态 / 悬停 / 按下）由 paintButton 重绘，命中仍走矩形命中列表。
     */
    craftButton(layer, list, o) {
      var tint = o.variant === 'primary' ? UI.cPrimary
        : o.variant === 'danger' ? UI.cDanger
          : o.variant === 'gold' ? UI.cGold
            : o.variant === 'ghost' ? UI.cGhost : UI.cPlain;
      var color = o.variant === 'primary' ? '#d8fff0'
        : o.variant === 'danger' ? UI.danger
          : o.variant === 'gold' ? UI.gold
            : o.variant === 'ghost' ? UI.accent : UI.sub;
      if (o.color) color = o.color;
      var h = o.h;
      var baseFont = Math.round(clamp(h * 0.42, 11, 16));   // 基准字号（缩小自适应要从它反算）
      var g = this.add.graphics();
      var txt = this.add.text(0, 0, o.label, {
        fontSize: baseFont + 'px',
        color: color, fontStyle: 'bold'
      }).setOrigin(0, 0.5);
      var ico = o.icon ? this.add.image(0, 0, 'rt_ico_' + o.icon).setOrigin(0, 0.5).setTint(tint) : null;
      var btn = {
        action: o.action, id: o.action, label: o.label, x: o.x, y: o.y, w: o.w, h: h, pad: 3,
        shape: o.shape || 'card', variant: o.variant || 'plain', tint: tint,
        gfx: g, text: txt, icon: ico, state: 'normal', disabled: !!o.disabled,
        _baseFont: baseFont      // 字号自适应的基准（paintButton 里从它反算，不会逐次累积）
      };
      layer.add(ico ? [g, ico, txt] : [g, txt]);
      list.push(btn);
      this.paintButton(btn);
      return btn;
    }

    /** 按钮绘制：底板 / 语义色薄涂 / 细描边 / 内容居中（状态变化时调用） */
    paintButton(b) {
      if (!b || !b.gfx || !b.gfx.scene) return;
      var g = b.gfx, st = b.state, a = b.disabled ? 0.38 : 1;
      var x = b.x, y = b.y, h = b.h;
      var hover = st === 'hover', down = st === 'down';
      // 常驻胶囊被编辑器缩放过：字号 / 内边距 / 图标都得跟着缩放走，
      // 否则缩小后文字与图标是固定像素、会把按钮撑成又矮又宽的一条。
      // us === 1 时下面每个值都与原来自动定宽的结果完全一致。
      // ⚠️ 必须**连 fitScale 一起**算进去（窄屏的整行收口系数，见 layoutPillRow）：
      //    只缩底板不缩内容的话，下面 `if (b.w < need)` 会把 b.w 按原字号撑回去，
      //    收口等于没做 —— 行尾那颗照样越界。
      var us = ((b.userScale > 0) ? b.userScale : 1) * ((b.fitScale > 0) ? b.fitScale : 1);
      if (b.shape === 'pill' && b._baseFont) {
        var fs = Math.max(8, Math.round(b._baseFont * us));
        if (parseInt(b.text.style.fontSize, 10) !== fs) b.text.setFontSize(fs);
      }
      var r = b.shape === 'pill' ? h / 2 : Math.max(3, Math.min(6, Math.round(h * 0.12)));
      var padX = Math.max(Math.round(10 * us), Math.round(h * 0.5));
      var icoW = b.icon ? Math.max(8, Math.round(16 * us)) : 0;
      var gap = b.icon ? Math.max(4, Math.round(7 * us)) : 0;

      // 文字永不越界（用户反馈："祭坛房间内'献祭 4 生命 · 解除一条诅咒'几个字越界了"）
      // ------------------------------------------------------------
      // 原来只有 `shape === 'pill'` 的按钮会在文字变长时**自动加宽**；
      // 而画内面板里的按钮（uiButton → shape 'card'）宽度是布局算好的、不能自由伸缩，
      // 于是长文案直接冲出底板。
      // 这里的办法是反过来：**可用宽度不够就自动缩小字号**（下限 9px，再长也不溢出）。
      // 字号一律从 `_baseFont`（创建时的字号）反算，所以 paintButton 被反复调用
      // （悬停 / 按下 / 禁用各一次）也不会逐次累积缩小 —— 这是这类自适应的经典坑。
      var baseFs = b._baseFont || (parseInt(b.text.style.fontSize, 10) || 13);
      var availText = b.w - padX * 2 - icoW - gap;
      var wantFs = baseFs;
      if (b.shape !== 'pill' && availText > 8) {
        if (parseInt(b.text.style.fontSize, 10) !== baseFs) b.text.setFontSize(baseFs);   // 先归位再量
        if (b.text.width > availText) {
          wantFs = Math.max(9, Math.floor(baseFs * availText / Math.max(1, b.text.width)));
        }
      }
      if (parseInt(b.text.style.fontSize, 10) !== wantFs) b.text.setFontSize(wantFs);

      // 最后一层保底：字号已经压到下限（9px）仍放不下 → 截断加省略号。
      // 极端长文案（例如拼了一整句话的按钮）宁可少显示几个字，也**绝不冲出底板**。
      // 宽度恢复时会把完整文案还原（所以先与 b.label 比对，而不是记"截断过"）。
      if (b.shape !== 'pill' && b.label && availText > 8) {
        var full = String(b.label);
        if (b.text.text !== full) b.text.setText(full);
        var cut = full, guard = 0;
        while (cut.length > 3 && b.text.width > availText && guard++ < 40) {
          cut = cut.slice(0, -1);
          b.text.setText(cut + '…');
        }
      }

      var need = Math.round(b.text.width + padX * 2 + icoW + gap);
      // ⚠️ 被整行收口（fitScale < 1）时**不能**再自动加宽：那等于把收口原地撤销，
      //    行尾又会探出边界（实测每颗会悄悄长回 1~2px，4 颗就是 5px 以上）。
      //    此时宽度以布局给的为准 —— 字号已经按 us（含 fitScale）缩过，
      //    文字实际宽度与底板宽度本就该在同一条线上。
      var fitS = (b.fitScale > 0) ? b.fitScale : 1;
      if (b.w < need && b.shape === 'pill' && fitS >= 1) b.w = need;
      var w = b.w;
      var content = icoW + gap + b.text.width;
      var cx = x + Math.max(padX, Math.round((w - content) / 2));
      var lift = down ? 1 : (hover ? -1 : 0);
      var top = y - h / 2 + lift;
      // 编辑器设的透明度要乘进来（paintButton 会重设 text/icon 的 alpha，
      // 不乘的话文字会被顶回全不透明，只剩底板是淡的）
      var ua = (b.userAlpha == null) ? 1 : b.userAlpha;
      a *= ua;

      g.clear();
      var on = !!b.on;   // 当前生效（例如商店已打开）
      if (b.shape === 'pill') {
        // 战场之上的常驻控件：先铺暗底保证可读，再叠语义色
        g.fillStyle(UI.box, (hover ? 0.9 : down ? 0.94 : 0.78) * a);
        g.fillRoundedRect(x, top, w, h, r);
        g.fillStyle(b.tint, (b.variant === 'plain' ? 0.07
          : (down ? 0.3 : hover ? 0.2 : (on ? 0.22 : 0.12))) * a);
        g.fillRoundedRect(x, top, w, h, r);
        g.lineStyle(1, b.tint, (b.variant === 'plain' ? 0.18
          : (down ? 0.72 : hover ? 0.5 : (on ? 0.62 : 0.28))) * a);
        g.strokeRoundedRect(x + 0.5, top + 0.5, w - 1, h - 1, Math.max(1, r - 0.5));
      } else {
        // 面板之内的动作：白底微提 + 语义色薄涂
        g.fillStyle(0xffffff, (hover ? 0.09 : down ? 0.13 : 0.035) * a);
        g.fillRoundedRect(x, top, w, h, r);
        if (b.variant !== 'plain') {
          g.fillStyle(b.tint, (down ? 0.3 : hover ? 0.2 : 0.1) * a);
          g.fillRoundedRect(x, top, w, h, r);
        }
        g.lineStyle(1, b.variant === 'plain' ? 0xffffff : b.tint,
          (hover ? 0.34 : b.variant === 'plain' ? 0.07 : 0.2) * a);
        g.strokeRoundedRect(x + 0.5, top + 0.5, w - 1, h - 1, Math.max(1, r - 0.5));
      }
      if (b.icon) {
        // 图标纹理本来就是 16×16，所以 us=1 时这个 setDisplaySize 不会改变外观，
        // 但它保证了「缩小后再改回 100%」能把图标恢复原尺寸。
        b.icon.setDisplaySize(icoW, icoW);
        b.icon.setPosition(cx, y + lift).setAlpha(a);
        b.text.setPosition(cx + icoW + gap, y + lift).setAlpha(a);
      } else {
        b.text.setPosition(cx, y + lift).setAlpha(a);
      }
    }

    setButtonState(b, state) {
      if (!b || !b.gfx || !b.gfx.scene || b.state === state) return;
      b.state = state;
      this.paintButton(b);
    }

    /** 常驻胶囊的「当前生效」状态（如商店已打开），与悬停 / 按压状态正交 */
    setHudButtonOn(id, on) {
      var b = (this.hudButtons || []).filter(function (x) { return x.id === id; })[0];
      if (!b || !!b.on === !!on) return;
      b.on = !!on;
      this.paintButton(b);
    }

    /** 命中测试（与 handleUiClick 同一优先级，保证「点亮的就是会响应的」） */
    uiHitTest(p) {
      var pb = this.panelButtons || {};
      // 二次确认是严格模态：其余控件一律不响应
      if (this.confirmOpen) return this.hitBtnList(p, pb.confirm);
      // 常驻功能按钮在面板打开时已被收起，命中也要跳过（与 handleUiClick 一致）
      if (!this.panelOverlayOpen()) {
        // 遗物条与常驻按钮同一优先级判定（顺序与 handleUiClick 一致）
        if (this.relicHitTest(p)) return { relicStrip: true };
        var hb = this.hitBtnList(p, this.hudButtons);
        if (hb) return hb;
      }
      if (this.relicOpen) {
        if (this.relicView === 'stats') return this.hitBtnList(p, pb.relicStats);
        return this.hitBtnList(p, pb.relic);
      }
      if (this.shopOpen) return this.hitBtnList(p, pb.shop) || this.hitBtnList(p, this.shopItemRects);
      if (this.codexOpen) return this.hitBtnList(p, pb.codex) || this.hitCodexRow(p);
      if (this.deathOpen) return this.hitBtnList(p, pb.death);
      if (this.mapOpen) return this.hitBtnList(p, pb.map);
      // 技能胶囊画面上被面板盖住 → 命中排在面板之后，避免「看不见却点得到」
      var sb2 = this.hitBtnList(p, this.skillButtons);
      if (sb2) return sb2;
      return null;
    }

    /** 悬停状态（鼠标设备；触摸设备不产生悬停） */
    updateUiHover(p) {
      // 图鉴词条行：单独维护高亮（它不是胶囊按钮，没有 gfx 可复用）
      if (this.codexOpen) {
        var row = this.hitCodexRow(p);
        if (row !== this._hoverRow) {
          if (this._hoverRow) this.paintCodexRow(this._hoverRow, false);
          this._hoverRow = row;
          if (row) this.paintCodexRow(row, true);
        }
      } else if (this._hoverRow) {
        this.paintCodexRow(this._hoverRow, false);
        this._hoverRow = null;
      }
      var b = this.uiHitTest(p) || null;
      if (!b || b.relicStrip) {
        // 遗物条不是胶囊按钮（没有 gfx 可复用），悬停单独维护：
        // 17px 的图标在鼠标下必须给出可见反馈，否则玩家根本不知道它可点。
        this._hoverRelic(p);
      }
      if (b === this._hoverBtn) return;
      if (this._hoverBtn) this.setButtonState(this._hoverBtn, 'normal');
      this._hoverBtn = (b && b.gfx && b.gfx.scene) ? b : null;
      if (this._hoverBtn) this.setButtonState(this._hoverBtn, 'hover');
    }

    /** 遗物详情的悬停：图标放大 1.18 + 提亮；`+N` 那一格只提亮文字 */
    _hoverRelic(p) {
      var hit = this.relicStripWanted ? this.relicHitTest(p) : null;
      var idx = hit ? hit.i : -2;          // -1 = 尾部（+N / ▸属性）那一格
      if (idx === this._hoverRelicIdx) return;
      var prev = this._hoverRelicIdx;
      this._hoverRelicIdx = idx;
      var reset = (function (self) {
        return function (i) {
          if (i >= 0 && self.relicStripIcons && self.relicStripIcons[i]) {
            var im = self.relicStripIcons[i];
            var d = self._relicIconD || 17;
            im.setDisplaySize(d, d);
            im.setTint(0xffffff);
            im.setAlpha(1);
          }
        };
      })(this);
      reset(prev);
      if (idx >= 0 && this.relicStripIcons && this.relicStripIcons[idx]) {
        var img = this.relicStripIcons[idx];
        var d2 = this._relicIconD || 17;
        img.setDisplaySize(d2 * 1.18, d2 * 1.18);
        img.setTint(0xffffff);          // 保持原色，只靠尺寸表达（色环是信息，不能改色）
        img.setAlpha(1);
      }
    }

    /** 按压反馈：按下时轻微下沉，松手回到常态 */
    flashButtonDown(b) {
      if (!b || !b.gfx || !b.gfx.scene) return;
      var self = this;
      this.setButtonState(b, 'down');
      this.time.delayedCall(130, function () {
        self.setButtonState(b, b === self._hoverBtn ? 'hover' : 'normal');
      });
    }

    /** 面板动作按钮（面板内统一样式，保留旧签名以便各处调用） */
    uiButton(layer, list, action, label, x, y, w, h, primary) {
      return this.craftButton(layer, list, {
        action: action, label: label, x: x, y: y, w: w, h: h,
        shape: 'card', variant: primary ? 'primary' : 'plain'
      });
    }

    // ---------- 关卡（每个关卡 = 地图上的一个房间）----------

    /**
     * 顶部 HUD 的下沿（左侧那一列：属性面板 → 技能胶囊 → 常驻按钮行）
     * ------------------------------------------------------------
     * 短屏手机横屏（H≈360）时它能到 y≈157 —— 屏幕高度的 44%。
     * 而平台带的 y 由 max(groundY-350, H*0.14) 决定，360 上就是 50~154：
     * **整个平台带都落在 HUD 层里**，这就是「跳上台阶看不见自己、也看不见上面」
     * 的物理原因（桌面 H=720 时平台带在 274~514、HUD 只到 179，所以只有小屏中招）。
     */
    hudSafeTop() {
      var b = this._hudRowBottom;
      if (!b || !isFinite(b)) b = this.statPanelMetrics(this.scale.width).bottom + 30;
      return Math.round(b + 8);
    }

    /**
     * 2.9 新增画布元素的比例系数（0.8~1.2，720 高为基准）
     * ------------------------------------------------------------
     * 施工清单 §9.1 要求「按视口比例自适应，不写死像素」，但游戏本体是固定像素风格，
     * 整体按比例缩放反而破坏观感 —— 所以只给 **2.9 新增的这几件**用：
     *   守点圈半径、塌陷预警层高度、门上的符文凹槽。
     * 它们原来都是写死值，同一间房在 360 和 720 高上占屏比例差一倍，
     * 判定宽严、遮挡关系都会跟着变（用户反馈的"圈压进 HUD"就是这里来的）。
     */
    mechScale() {
      return clamp((this.scale.height || 720) / 720, 0.8, 1.2);
    }

    /**
     * 相机边界：纵向留出跟随余量
     * ------------------------------------------------------------
     * 原来写死 setBounds(0, 0, levelWidth, H)：边界高度 == 视口高度 → scrollY 恒为 0，
     * 相机纵向一点都不能动（既谈不上"跟随"，跳上台阶也看不见人）。
     * 现在留「安全线 + 大半个屏高」的余量，纵向跟随（含满蓄力跳）都有空间走。
     */
    applyCameraBounds() {
      var H = this.scale.height;
      var head = this.hudSafeTop() + Math.round(H * 0.8);
      this._camHeadroom = head;
      this.physics.world.setBounds(0, -600, this.levelWidth, H + 1200);
      this.cameras.main.setBounds(0, -head, this.levelWidth, H + head);
    }

    /**
     * 相机跟随参数：纵向死区 + 跟随偏移
     * ------------------------------------------------------------
     * 目标：相机跟着主角上下左右动，而主角**始终整段落在屏幕里、且不缩到 HUD 后面**。
     *
     * 死区是居中于屏幕的（上沿 = H/2 − dz/2），小屏上做不到「上沿 ≥ 安全线 + 身高」
     * （H=360 时居中上沿最多到 180，而需要 221）——所以叠加**跟随偏移**：
     * setFollowOffset(0, offY) 让「参与死区判定的点」比主角高 offY，
     * 于是主角实际被允许出现的屏幕区间整体下移。合成后：
     *     可站区间 = [ offY + H/2 − dz/2 , offY + H/2 + dz/2 ]
     * 两条硬约束：
     *   ① 上沿 ≥ 安全线 + 可视身高 + 4   → 头顶永远不在 HUD 后面
     *   ② 下沿 ≤ 屏幕高 − 28             → **脚底永远在屏幕内**
     * ② 是第一版漏掉的，真机上被它坑得很惨：区间下沿跑到屏幕外（370 > 334）时，
     * 死区失去"把镜头拉回来"的能力 —— 镜头被台阶顶上去后，人落地了镜头也不下来，
     * 表现为「站在地上只能看到头以上的画面，身体和地面全在屏幕外」（实测 scrollY=−132）。
     * 所以先把 dz 压到「整段区间放得进屏幕」，再据此反算 offY。
     */
    applyCameraFollow() {
      var cam = this.cameras.main;
      if (!cam) return;
      var H = this.scale.height;
      var hh = ((this.hero && this.hero.displayHeight) || 64) * 0.82;
      var bandTop = Math.round(this.hudSafeTop() + hh + 4);   // 约束①
      var bandBottomMax = H - 28;                              // 约束②
      var dz = Math.max(60, Math.min(Math.round(H * 0.45), bandBottomMax - bandTop));
      var offY = Math.round(bandTop - (H / 2 - dz / 2));
      // 横向死区（第 12 条："走起来画面一抽一抽的"）
      // ------------------------------------------------------------
      // 原来写死 `this.scale.width * 0.3`：桌面 1908 宽时死区有 **572px**，
      // 主角可以在屏幕上"自由滑动"近 300px 而相机纹丝不动；一碰死区边缘，相机才以
      // lerp 0.12 开始追。于是持续行走时是「相机不动 → 突然启动 → 追上 → 又不动」
      // 的循环，视觉上就是画面一顿一顿地抽。
      // 收窄到 ~6%（并夹在 24~90px）：既能吸收攻击 / 受击时的微小位移，
      // 又让持续行走时相机**连续**跟随。
      // ⚠️ 纵向死区 dz 一个字都不动 —— P0 那套结论解决的是"人躲进 HUD / 脚底出画"，
      //    与横向无关；用户也明确要求"不影响相机现有跟随功能"。
      var dzX = Math.max(24, Math.min(Math.round(this.scale.width * 0.06), 90));
      cam.setDeadzone(dzX, dz);
      cam.setFollowOffset(0, offY);
      this._camFollowOffsetY = offY;
      this._camBand = [bandTop, Math.round(offY + H / 2 + dz / 2)];
    }

    buildLevel(room) {
      this.clearLevel();
      if (room) this.roomNode = room;
      var node = this.roomNode || { type: 'enemy', row: 1, col: 1 };
      if (this.floorMap) this.floor = this.floorMap.floor;
      // 预览模式跟着**这一间房**走，不能只由 buildDebugRoom 打开：
      // 原来从调试房切回正式流程时 previewMode 还是 true，nextFloor 会去走「结算本局」而不是开地图。
      this.previewMode = !!(node && node.debugRoom);

      var W = this.scale.width, H = this.scale.height;
      this.groundY = H - 96;
      // 记住「这一关是按什么高度铺的」：onResize 靠它判断画布是否变了尺寸、
      // 要不要按新高度重建房间（见那里的说明）。
      this._builtH = H;
      // 房间长度：Boss 房间更宽阔；宝箱 / 祭坛房间「拿完就走」，只留一屏出头
      // （原来的 Math.max(W*2, base) 会把缩短量整个吃掉 —— 这也是之前宝箱房跑半天的原因）
      //
      // ⚠️ 封顶（用户反馈："后期房间长的根本跑不完，跑好几分钟才能打一两只怪"）
      // ------------------------------------------------------------
      // 原式 `base = 1400 + floor * 140` **没有上限**：层 50 = 8400px、层 100 = 15400px，
      // 而普通房敌人数在层 10 就封顶到 7 只 → 密度从每 200px 一只崩到每 1000px 以上一只，
      // 房间里大半是空走廊。**难度应该由敌人强度与数量承担，不该由"多跑两屏"承担。**
      // 现在改为随层数温和增长（每层 +90）并在 2200 封顶。
      var base = Math.min(1400 + this.floor * 90, 2200);
      var nonCombat = nonCombatRoom(node.type);
      if (node.type === 'boss') base += 380;
      if (nonCombat) base = Math.round(W * 0.95) + 260;
      this.levelWidth = Math.max(nonCombat ? Math.round(W * 0.85) : W * 2, base);

      // 相机边界与纵向余量：见 applyCameraBounds 的说明（短屏修「跳上台阶看不见」）
      this.applyCameraBounds();

      // ===== P4：机制挂载（与骨架正交）=====
      var mech = this.pickMechanic(node);
      this._roomMechanic = mech;
      if (mech) {
        node.mechanic = mech;
        if (!node._mechCounted) {
          node._mechCounted = true;
          this._floorMechanicCount = (this._floorMechanicCount || 0) + 1;
          // 本层出现过的机制种类（2.9.2 F2）：保底时优先挑没出现过的
          this._floorMechanicKinds = this._floorMechanicKinds || {};
          this._floorMechanicKinds[mech] = true;
        }
      }
      if (mech === 'collapse') { node.noEnemies = true; node.noCrystals = true; }
      else if (mech === 'hold') { node.noEnemies = true; }
      // 塌陷房：平厅不放浮台（浮台 = 安全岛，站上去等地面塌完机制就失效）。
      // 双层 / 断桥从 2.9.1 起保留自己的骨架 —— 上层有寿命（半程崩），缺口算已塌块。
      this._noPlatforms = (mech === 'collapse') || !!node.noPlatforms;

      // 地形：P0 起走骨架入口（legacy 模式内部直接平厅，行为与 2.8 一致）
      this.buildTerrain(node);
      this._forceSkeleton = null;
      this._noPlatforms = false;
      this.initRoomObjective(node.type);
      // 机制房（塌陷/守点/限时）自己控制刷怪节奏；调试单房间也可以先不放敌人
      if (!node.noEnemies) this.spawnEnemies(node.type);
      this.spawnRoomGoal(node.type);
      this.spawnPortal();

      this.hero.setPosition(140, this.groundY - 80);
      this.hero.setVelocity(0, 0);
      this.hero.setAlpha(1).setAngle(0).setVisible(true);
      this.hero.body.checkCollision.none = false;
      this.heroDead = false;
      this.portalOpen = false;
      // 2.9.4：每间房只结算一次；过门后等待宿主奖励流程回话
      this._roomSettled = false;
      this._awaitClearAck = false;
      this._awaitClearAckUntil = 0;
      // 重置蓄力状态
      this.isCharging = false;
      this.chargeRatio = 0;
      this.coyoteUntil = 0;
      // 进房重置闪避状态（体力保留）
      this.dodging = false;
      this.dodgeReadyAt = 0;
      // 英雄被动：首击 / 首杀每房间各一次；开战护盾类被动在此生效
      this._roomFirstHit = false;
      this._roomFirstKill = false;
      // 诅咒「虚弱 / 迟钝」在同一房间内累积，进新房间时恢复到本局的基础值
      if (this.curses && (this.curses.indexOf('虚弱') >= 0 || this.curses.indexOf('迟钝') >= 0)) {
        if (this._baseAtk == null) { this._baseAtk = this.hero.attack; this._baseDodge = this.hero.dodge; }
        this.hero.attack = this._baseAtk;
        this.hero.dodge = this._baseDodge;
      }
      this._baseAtk = this.hero.attack;
      this._baseDodge = this.hero.dodge;
      // 腐化脉冲从进房开始重新计时
      this.pulseAt = this.time.now + this.pulseInterval();
      if (this.skillProjectiles && this.skillProjectiles.length) {
        this.skillProjectiles.forEach(function (a) { if (a) a.destroy(); });
        this.skillProjectiles = [];
      }
      if (this.shots && this.shots.length) {
        this.shots.forEach(function (a) { if (a) a.destroy(); });
        this.shots = [];
      }
      this.applyRoomStartPassive();
      if (this.chargeRing) this.chargeRing.setVisible(false);

      // 相机：横向 0.12 平滑跟随；纵向**同样跟随**（lerpY 也是 0.12），
      // 再叠加 applyCameraFollow 的死区 + 跟随偏移，让他在跟随范围内不缩到 HUD 后面。
      //
      // ⚠️ roundPixels 保持 **true**（曾经试过 false，已回退）
      // ------------------------------------------------------------
      // 试 false 的理由是"lerp 收敛期的小数速度被取整成 0,0,1,0,0,1 的跳步"，
      // 但实机反馈是**更抽了**：相机落在半像素上之后，程序化生成的纹理
      // （渐变 + 抗锯齿边缘）每帧都在不同的采样位置上重采样 ——
      // 那不是"移动更连续"，而是整幅画面在**闪烁/蠕动**，比取整跳步难看得多。
      // 取整跳步最多让移动看起来"一格格"，而半像素采样是**全屏都在抖**。
      this.cameras.main.startFollow(this.hero, true, 0.12, 0.12);
      this.applyCameraFollow();
      // 进房立刻对齐到主角，别把上一房间的镜头偏移带过来
      this.cameras.main.centerOn(this.hero.x, this.hero.y);
      this.refreshHud();
      // 机制房：地形 / 门都已就位，最后挂机制（它会接管目标、钥匙、刷怪与门锁）
      this.startMechanic(node);
      // 无战斗房间（宝箱/祭坛）：直接判定清空条件
      var self = this;
      this.time.delayedCall(400, function () { if (self.running) self.checkFloorClear(); });
      // 进房过渡：从暗处淡入
      this.cameras.main.fadeIn(240, 4, 4, 14);
    }

    clearLevel() {
      var self = this;
      // 「深渊魂晶强化」是本房间内的状态：换房必须清掉，否则下一个房间的怪一出生就被放大
      this._roomEmpower = 0;
      this.enemies.forEach(function (e) {
        if (!e) return;
        if (e.throwFx) { e.throwFx.destroy(); e.throwFx = null; }
        if (e.sprite) e.sprite.destroy();
        if (e.meter) self.destroyMeter(e.meter);
        if (e.nameLbl) e.nameLbl.destroy();
        if (e.atkLbl) e.atkLbl.destroy();
      });
      this.enemies = [];
      this.nearestEnemy = null;
      if (this.targetPanel) this.targetPanel.setVisible(false);
      this.projectiles.forEach(function (p) { if (p) p.destroy(); });
      this.projectiles = [];
      if (this.skillProjectiles) {
        this.skillProjectiles.forEach(function (a) { if (a) a.destroy(); });
        this.skillProjectiles = [];
      }
      if (this.shots) {
        this.shots.forEach(function (a) { if (a) a.destroy(); });
        this.shots = [];
      }
      this.clearCrystals();
      this.platformPerches = [];
      if (this.groundStrips) {
        this.groundStrips.forEach(function (s) { s.destroy(); });
        this.groundStrips = [];
      }
      this.groundStrip = null;
      this.groundSegments = [];
      this.platformTiles.forEach(function (t) { t.destroy(); });
      this.platformTiles = [];
      if (this.platformStrips) {
        this.platformStrips.forEach(function (s) { s.destroy(); });
        this.platformStrips = [];
      }
      // 平台的附属视觉（支撑柱 / 侧壁）一起清 —— 漏掉就是"房间里漂着几根柱子"
      if (this.platformDecor) {
        this.platformDecor.forEach(function (s) { if (s && s.destroy) s.destroy(); });
        this.platformDecor = [];
      }
      // 飘字归还对象池（不残留到下一个房间）
      if (this.floats) {
        var pool = this.floatPool;
        this.floats.forEach(function (t) {
          t.setVisible(false);
          if (pool.length < 60) pool.push(t); else t.destroy();
        });
        this.floats = [];
      }
      if (this.portal) { this.portal.destroy(); this.portal = null; }
      if (this.roomGoal) {
        // ⚠️ 必须连 **extra** 一起销毁：它是"目标物的第二个部件"
        //    （宝箱盖 / 祭坛光球 / 商店遮阳篷 / 篝火木柴 / 裂隙辉光），
        //    原来只销毁了 obj 与 label，extra 就永久留在场景里 ——
        //    玩家离开非战斗房间后，在后面的房间里会看到**漂浮的方块与光点**
        //    （用户反馈的"进其他房间还会有残留"就是这个）。
        if (this.roomGoal.obj) this.roomGoal.obj.destroy();
        if (this.roomGoal.extra) this.roomGoal.extra.destroy();
        if (this.roomGoal.label) this.roomGoal.label.destroy();
        // 目标物可能带一组附属图形（重画后的装饰部件），一并清掉
        if (this.roomGoal.parts) {
          this.roomGoal.parts.forEach(function (p) { if (p && p.destroy) p.destroy(); });
        }
        this.roomGoal = null;
      }
      // ===== 2.9 P4：机制房的临时对象 / 状态 =====
      this.destroyCollapse();
      this.destroyHoldZone();
      this.destroyTimedRoom();
      // ===== 2.9 P0：清掉本房间的骨架 / 目标临时状态 =====
      // 骨架在进房时算一次，出房必须整体丢弃；P3 的骨架对象（上层地板、
      // 缺口遮罩等）统一挂在 skeletonParts 里，由这里一次销毁。
      if (this.skeletonParts && this.skeletonParts.length) {
        this.skeletonParts.forEach(function (p) { if (p && p.destroy) p.destroy(); });
        this.skeletonParts = [];
      }
      this.platformSpots = [];
      this._platformPass = false;
      this.roomObjective = null;
      this.roomSkeleton = null;
      this._terrainParams = null;
      this._flatLayout = null;
      this.deckY = null;
      this.deckGaps = [];
      this.bridgeGaps = [];
      this._pitLockUntil = 0;
      // 2.9.2：断桥的活体装饰 + 守点（守住核心）的结算倍率
      this._bridgeActive = false;
      this._bridgeFog = null;
      this._bridgeHazards = null;
      this._bridgeRocks = null;
      this._plank = null;
      this._roomGoldMul = 1;
      this._roomHoldFailed = false;
      this.boss = null;
      this.setMeterVisible(this.bossMeter, false);
      this.bossName.setVisible(false);
      this.bossText.setVisible(false);
    }

    /**
     * 铺地面
     * @param {Array<{x0:number,x1:number}>|null} segments 地面段；不传 = 整条（平厅）
     * ------------------------------------------------------------
     * v2.9 P3：从「一整条」重构成「若干段」——断桥的缺口就是段与段之间。
     * 碰撞体仍然按 64px 一格复用同一个池（不在缺口处新建 / 销毁对象），
     * 只是把缺口里的格子移出关卡并关掉 body；视觉按段各一条 TileSprite。
     */
    layoutFloor(segments) {
      var y = this.groundY + 32;
      if (!segments || !segments.length) segments = [{ x0: 0, x1: this.levelWidth + 128 }];
      // 2.9.2 §4.2：断桥允许每段 ±32px 的落差。dy 是**该段地面相对 groundY 的偏移**，
      // 碰撞体、视觉条、出生点、掉落判定全部读同一个 dy（不另建一套坐标）。
      this.groundSegments = segments.map(function (s) {
        return {
          x0: Math.max(0, s.x0), x1: Math.min(s.x1, this.levelWidth + 256),
          dy: s.dy || 0
        };
      }, this);

      var need = Math.ceil(this.levelWidth / 64) + 4;
      while (this.groundTiles.length < need) {
        var t = this.solids.create(this.groundTiles.length * 64 + 32, 0, TEX.ground);
        t.setOrigin(0.5, 0.5);
        t.setVisible(false);   // 只作碰撞体，视觉由地砖条承担（降低绘制调用）
        t.refreshBody();
        this.groundTiles.push(t);
      }
      var self = this;
      this.groundTiles.forEach(function (t, i) {
        var cx = i * 64 + 32;
        // 只保留**中心落在段内**的格子：段的边界都对齐到 64，
        // 这样视觉缺口与碰撞缺口完全重合（多留半格会出现"看得见坑、踩得着地"）。
        var seg = null;
        for (var k = 0; k < self.groundSegments.length; k++) {
          var s = self.groundSegments[k];
          if (cx >= s.x0 && cx <= s.x1) { seg = s; break; }
        }
        if (seg) {
          t.setPosition(cx, y + (seg.dy || 0));
          if (t.body) t.body.enable = true;
          t.refreshBody();
        } else {
          // 缺口：移出关卡 + 关掉碰撞（不是销毁，换房时再放回来）
          t.setPosition(cx, self.groundY + 3000);
          if (t.body) t.body.enable = false;
        }
      });

      // 视觉地板：每段一条 TileSprite（断桥 2~3 段 = 2~3 次绘制，仍然很低）
      if (this.groundStrips) {
        this.groundStrips.forEach(function (s) { s.destroy(); });
      }
      this.groundStrips = this.groundSegments.map(function (s) {
        var w = Math.max(64, s.x1 - s.x0);
        return self.add.tileSprite(s.x0, y + (s.dy || 0), w, 64, TEX.ground).setOrigin(0, 0.5).setDepth(1);
      });
      this.groundStrip = this.groundStrips[0] || null;
    }

    /* ============================================================
       2.9 · P0：骨架选择层 + 骨架实现层
       ------------------------------------------------------------
       房间 = 骨架（必选）× 机制（可选，P4）× 房间类型（不变）。
       P0 只实现平厅，抽出两层的价值是：P3 加双层/断桥时只动
       pickSkeleton 的权重表与 applySkeleton 的分支，不动主流程。
       ============================================================ */

    /** 骨架参数入口：层数 / 视口 / 房间类型 / 房间宽度（施工清单 §3.1 第 2 条） */
    skeletonParams(node) {
      var n = node || this.roomNode || {};
      return {
        floor: this.floor,
        roomType: n.type || 'enemy',
        nonCombat: nonCombatRoom(n.type),
        viewW: this.scale.width,
        viewH: this.scale.height,
        levelWidth: this.levelWidth,
        groundY: this.groundY,
        col: (n.col != null ? n.col : 0)
      };
    }

    /**
     * 骨架选择（只选、不建）
     * 层数渐进表来自初步设想 §2.1：地形认知一层一层长出来，而不是第一层就扔进断桥。
     * 层主房与第 1 层固定平厅；非战斗房也固定平厅（没有战斗空间需求）。
     * 起点房（2.9.1）：同样固定平厅 —— 它是进层的缓冲房，只有 1~3 只杂兵；
     * 放个坑或上层没有玩法收益，反而会让"刚进层就被迫处理地形"。
     * 这跟 pickMechanic 排除 start 是同一个判断，两处必须一致。
     */
    pickSkeleton(params) {
      if (params.nonCombat || params.roomType === 'boss' || params.roomType === 'start' || params.floor <= 1) return 'flat';
      var table = this.skeletonWeightTable(params.floor);
      var pool = [];
      var total = 0;
      for (var i = 0; i < SKELETON.enabled.length; i++) {
        var k = SKELETON.enabled[i];
        var w = table[k] || 0;
        if (w > 0) { pool.push({ key: k, w: w }); total += w; }
      }
      if (!pool.length) return 'flat';
      if (pool.length === 1) return pool[0].key;
      var r = Math.random() * total;
      for (var j = 0; j < pool.length; j++) {
        r -= pool[j].w;
        if (r <= 0) return pool[j].key;
      }
      return pool[pool.length - 1].key;
    }

    /**
     * 层数 → 骨架权重（百分比，不必加起来等于 100，抽签会归一化）
     *   1     平厅 100                     教学：先学会跑跳
     *   2     平厅 75 / 双层 25            引入"上层"（这一层还没有坑）
     *   3~5   平厅 70 / 双层 15 / 断桥 15   2.9.2 F2：断桥提前到第 3 层
     *   6~15  平厅 50 / 双层 30 / 断桥 20  引入"脚下有坑"
     *   16+   平厅 40 / 双层 35 / 断桥 25  目标分布
     *
     * ⚠️ 第 2 层刻意**不进**断桥：那是玩家第一次见到"上层"的一层，
     *    同时出现坑会让两个新概念互相遮蔽（反馈文档给的是"3 层起进池子"）。
     */
    skeletonWeightTable(floor) {
      if (floor <= 1) return { flat: 100 };
      if (floor === 2) return { flat: 75, double: 25 };
      if (floor <= 5) return { flat: 70, double: 15, bridge: 15 };
      if (floor <= 15) return { flat: 50, double: 30, bridge: 20 };
      return { flat: 40, double: 35, bridge: 25 };
    }

    /**
     * 骨架实现：按骨架类型铺地形
     * @returns {string} 实际落成的骨架（double/bridge 放不下时会退回 flat）
     */
    applySkeleton(sk, params) {
      if (sk === 'double') {
        if (this.buildDoubleSkeleton(params)) return 'double';
        console.warn('[战斗2D] 双层骨架在当前视口放不下，退回平厅');
        this.buildFlatSkeleton(params);
        return 'flat';
      }
      if (sk === 'bridge') {
        if (this.buildBridgeSkeleton(params)) return 'bridge';
        console.warn('[战斗2D] 断桥骨架生成失败，退回平厅');
        this.buildFlatSkeleton(params);
        return 'flat';
      }
      this.buildFlatSkeleton(params);
      return 'flat';
    }

    /**
     * 平厅骨架实现：连续地面 + 浮台
     * 布局数值全部来自 flatSkeletonLayout（纯函数），这里只负责"落成对象"。
     */
    buildFlatSkeleton(params) {
      this.layoutFloor();
      // 塌陷回廊：地面就是全部地形。有任何浮台都会让"站在上面等塌完"变成无解安全区，
      // 所以这里支持无平台变体（施工反馈：塌陷房间不要浮台）。
      if (params && params.noPlatforms) {
        this.platformSpots = [];
        this._flatLayout = null;
        return;
      }
      var layout = flatSkeletonLayout(params);
      this.platformSpots = layout.platforms.slice();
      this._flatLayout = layout;          // 调试：最近一次平厅布局（含高度上下限）
      for (var i = 0; i < layout.platforms.length; i++) {
        var spot = layout.platforms[i];
        this.spawnPlatformAt(spot.x0, spot.y, spot.len);
      }
    }

    /**
     * 双层骨架（P3.1）
     * ------------------------------------------------------------
     * 上层：一条横跨 55% 房间长度的实体地板，带 1~2 个「连通口」（缺口）。
     * 下层：主战场，出口仍在地面右端（**不改出口位置** —— 2.9 的边界）。
     * 上层放远程怪（复用 platformPerches），于是「站高台的远程怪」从偶尔出现
     * 变成结构性存在。
     *
     * 两条硬约束（不满足就退回平厅，宁可这一间还是平地，也不要出一个不可玩的房间）：
     *   ① 上层不能压进 HUD：deckY >= hudSafeTop + 44
     *   ② 上层必须留出 110px 净空，且在满蓄力跳跃范围内
     * 高度一律按视口 / 地面算，不写死像素（手机 H≈360 会自动压缩）。
     * @returns {boolean} 是否建成
     */
    buildDoubleSkeleton(params) {
      var groundY = this.groundY;
      var deckY = Math.max(groundY - 210, this.hudSafeTop() + 44);
      var minClear = 110;
      if (deckY > groundY - minClear) return false;                  // 视口太矮：放不下两层
      var jumpH = (CHARGE.maxPower * CHARGE.maxPower) / (2 * GRAVITY);
      if (groundY - deckY > jumpH - 10) return false;                // 满蓄力也上不去

      this.layoutFloor();
      this.deckY = deckY;

      var edge = 120;
      var spanW = Math.round(this.levelWidth * 0.55);
      var maxStart = Math.max(edge, this.levelWidth - spanW - 160);
      // 起点与所有分段边界都吸附到 64px 地砖网格：
      // 原来 spawnDeckSegment 会 floor((x1-x0)/64)，上层地板比设计短 0~63px，
      // 于是「128px 的连通口」看起来比 128 宽一截。对齐之后缺口就是精确的 128。
      var grid = function (v) { return Math.round(v / 64) * 64; };
      var startX = grid(clamp(rnd(edge, maxStart), edge, maxStart));
      var gapCount = (this.levelWidth > 2200 && Math.random() < 0.35) ? 2 : 1;
      var gapW = 128;
      var segs = [];
      var mk = function (a, b) {
        var x0 = grid(a), x1 = grid(b);
        if (x1 - x0 >= 64) segs.push({ x0: x0, x1: x1 });
      };

      if (gapCount === 1) {
        var gx = startX + Math.round(spanW * rnd(0.38, 0.58));
        if (gx - startX >= 192 && startX + spanW - (gx + gapW) >= 192) {
          mk(startX, gx); mk(gx + gapW, startX + spanW);
        }
      } else {
        var g1 = startX + Math.round(spanW * 0.30);
        var g2 = startX + Math.round(spanW * 0.68);
        if (g1 - startX >= 160 && g2 - (g1 + gapW) >= 160 && startX + spanW - (g2 + gapW) >= 160) {
          mk(startX, g1); mk(g1 + gapW, g2); mk(g2 + gapW, startX + spanW);
        }
      }
      if (!segs.length) mk(startX, startX + spanW);

      this.deckGaps = [];
      for (var i = 1; i < segs.length; i++) {
        this.deckGaps.push({ x0: segs[i - 1].x1, x1: segs[i].x0 });
      }
      var self = this;
      segs.forEach(function (seg) { self.spawnDeckSegment(seg.x0, seg.x1, deckY); });
      return true;
    }

    /** 上层地板的一段：实体碰撞（不是单向）+ 一条视觉条 + 站台点 */
    spawnDeckSegment(x0, x1, y) {
      // 向下取整：宁可少铺半格，也不能让上层地板盖进连通口
      var len = Math.max(1, Math.floor((x1 - x0) / 64));
      var w = len * 64;
      for (var j = 0; j < len; j++) {
        var t = this.solids.create(x0 + 32 + j * 64, y, TEX.platform);
        t.setOrigin(0.5, 0.5);
        t.setVisible(false);
        t.refreshBody();
        t._solidDeck = true;    // 实体层：加速下坠不能穿过它（与单向平台相反）
        this.platformTiles.push(t);
      }
      // 视觉顶面 = 碰撞面（y − 10）：原来 tileSprite 以 y 为中心、高 64，
      // 顶面比碰撞面高 22px —— 英雄看起来是"陷进"地板里的。这次一起对齐。
      var topY = y - 10;
      var strip = this.add.tileSprite(x0, topY, w, 64, TEX.platDeck)
        .setOrigin(0, 0).setDepth(3);
      strip._solidDeck = true;   // 和碰撞体同一个标记：塌陷房开工时靠它保住上层
      this.platformStrips.push(strip);

      // 两端侧壁：让"这一段有端点"看得出来 —— 双层的连通口就靠这两个竖条被找到
      for (var e = 0; e < 2; e++) {
        var ex = (e === 0) ? x0 + 3 : x0 + w - 3;
        var edge = this.add.rectangle(ex, topY + 32, 6, 64, 0x8a6550, 0.85).setDepth(3.2);
        edge._solidDeck = true;
        edge._deckEdge = true;   // 回归用：段端侧壁（帮助玩家找到连通口）
        this.platformDecor.push(edge);
      }

      // 支撑柱：每 256px 一根，从楼板底面连到地面 —— 这是"一层楼"最直接的读法，
      // 也是和"悬浮薄板"区分开的那一笔（薄板下面什么都没有）
      var deckBottom = topY + 64;
      var pillarH = this.groundY - deckBottom + 6;   // 多 6px 插进地面，不留一道缝
      if (pillarH > 34) {
        var pn = Math.max(1, Math.round(w / 256));
        for (var k = 0; k < pn; k++) {
          var px = x0 + (w / pn) * (k + 0.5);
          var pil = this.add.image(px, deckBottom + pillarH / 2 - 3, 'rt_pillar')
            .setDisplaySize(14, pillarH).setDepth(1.5);
          pil._solidDeck = true;
          pil._deckPillar = true;   // 回归用
          this.platformDecor.push(pil);
        }
      }
      // 上层站台点：中段必有，长段再加一个靠左的（远程怪分布更自然）
      this.platformPerches.push({ x: x0 + w / 2, y: y - 20, len: len, crystal: false, deck: true });
      if (w >= 420) {
        this.platformPerches.push({ x: x0 + w * 0.24, y: y - 20, len: len, crystal: false, deck: true });
      }
      // 记进平台摆位：调试面板 / 分布统计按它算「几段平台」，双层原来是空的（显示 0 段）
      this.platformSpots.push({ x0: x0, x1: x0 + w, y: y, len: len, deck: true });
    }

    /**
     * 断桥骨架（P3.2）
     * ------------------------------------------------------------
     * 地面断 1~2 处，缺口下是坑。缺口宽度按「轻点跳」的横向射程算（96~128px，
     * 轻点跳约 153px），不逼玩家满蓄力；缺口离出生点 / 出口都留足余量。
     * 掉出地面 → 扣最大生命百分比 + 传送到**缺口右侧最近**的安全段（不往回送）。
     * @returns {boolean} 是否建成
     */
    buildBridgeSkeleton(params) {
      var lw = this.levelWidth;
      // 挂塌陷时缺口固定 1 处（方案 §6.2）：2 个缺口 + 塌陷会把地面碎成"只能连跳的走廊"。
      var mechHint = this._roomMechanic || this._mechGapCap;
      var mechGapCap = (mechHint === 'collapse') ? 1 : 0;
      // 2.9.2 §4.4：缺口宽度分层。旧实现所有层都是 128 —— 同一道题从第 6 层做到第 99 层。
      //   ≤10 层：2 格（128）轻点跳（轻点射程约 153）
      //   11–15 ：3 格（192）必须蓄力跳
      //   16+   ：3 格 + 允许 2 处缺口（选路线）
      // 宽度必须取 64 的整数倍：地面碰撞按 64 格复用，非对齐宽度会出现「看得见坑、踩得着地」。
      var wide = this.floor >= 11;
      var gapW = wide ? 192 : 128;
      var twoGapChance = this.floor >= 16 ? 0.55 : (this.floor >= 8 ? 0.4 : 0);
      var gapCount = (Math.random() < twoGapChance) ? 2 : 1;
      if (mechGapCap) gapCount = Math.min(gapCount, mechGapCap);
      var marginL = Math.max(320, Math.round(lw * 0.16));
      var marginR = Math.max(360, Math.round(lw * 0.14));
      var usable = Math.max(220, lw - marginL - marginR);
      var gaps = [];
      for (var i = 0; i < gapCount; i++) {
        var a = marginL + usable * (i / gapCount);
        var b = marginL + usable * ((i + 1) / gapCount) - gapW;
        if (b <= a) continue;
        var gx = Math.round(rnd(a, b) / 64) * 64;
        gaps.push({ x0: gx, x1: gx + gapW, w: gapW });
      }
      if (!gaps.length) return false;
      gaps.sort(function (a, b) { return a.x0 - b.x0; });

      // 缺口之间留出至少 3 格落脚点，否则断桥会碎成"只能连着跳"的走廊
      var segs = [];
      var cursor = 0;
      for (var g = 0; g < gaps.length; g++) {
        if (gaps[g].x0 - cursor < 192) continue;
        segs.push({ x0: cursor, x1: gaps[g].x0 });
        cursor = gaps[g].x1;
      }
      segs.push({ x0: cursor, x1: lw + 128 });
      if (segs.length < 2) return false;

      // 2.9.2 §4.2：三段桥面允许 ±32px 落差 —— 全平的三段只是"地面缺了几块"，
      // 有落差的断桥才像断桥。第一段永远是 0（出生点不动），相邻差 ≤ 32（一步跳得上去）。
      var steps = [0, 32, -32];
      var prevDy = 0;
      for (var s2 = 1; s2 < segs.length; s2++) {
        var pick = steps[ri(0, steps.length - 1)];
        // 相邻落差太大就退成"同高"，宁可平一段也不要出现跳不上去的台阶
        if (Math.abs(pick - prevDy) > 40) pick = prevDy;
        segs[s2].dy = pick;
        prevDy = pick;
      }
      segs[0].dy = 0;

      this.layoutFloor(segs);
      this.bridgeGaps = gaps;

      // 少而精的浮台：3 段。断桥的重点是"脚下有坑"，不是又摆一地台阶
      var layout = flatSkeletonLayout({
        floor: params.floor, nonCombat: false,
        viewW: params.viewW, viewH: params.viewH,
        levelWidth: params.levelWidth, groundY: params.groundY,
        countOverride: 3
      });
      this.platformSpots = layout.platforms.slice();
      this._flatLayout = layout;
      for (var p = 0; p < layout.platforms.length; p++) {
        var spot = layout.platforms[p];
        this.spawnPlatformAt(spot.x0, spot.y, spot.len);
      }
      // 断桥加料开关：塌陷房不加（它有自己的一套压力，加料会互相打架）、
      // 精英 / 层主房不加（一只额外的对岸射手能把精英房直接变成不可玩）
      var rt = (this.roomNode && this.roomNode.type) || 'enemy';
      this.decorateBridge(gaps, segs, {
        sniper: rt === 'enemy' && !this._roomMechanic && this.floor >= 8,
        plank: !this._roomMechanic && rt !== 'boss',
        rocks: rt !== 'boss'
      });
      return true;
    }

    /* ============================================================
       2.9.2 §4 · 断桥的"像桥"部分（全部是附属对象，随房间销毁）
       ------------------------------------------------------------
       反馈 §4.1 的判据只有一句：现在看起来像"地面少了一块贴图"。
       所以这里的每一笔都只服务"这是个断口、下面是空的"：
         ① 断面（锯齿 + 钢筋 + 断木梁）—— 这段地面是被劈开的
         ② 深渊渐隐 + 上浮雾气 —— 下面是深的
         ③ 桥墩结构缝 + 落点撞击裂纹 —— 这是座桥，而且有人跳过
       ============================================================ */
    decorateBridge(gaps, segs, opts) {
      var self = this;
      opts = opts || {};
      var parts = this.skeletonParts;
      var push = function (o) { if (o) parts.push(o); return o; };
      this._bridgeActive = true;
      this._bridgeFog = [];
      this._bridgeHazards = [];
      this._bridgeRocks = [];
      this._plank = null;

      var segOf = function (x) {
        for (var i = 0; i < segs.length; i++) {
          if (x >= segs[i].x0 - 4 && x <= segs[i].x1 + 4) return segs[i];
        }
        return segs[segs.length - 1];
      };

      // ---------- 桥面：结构缝（每 256px 一道）----------
      segs.forEach(function (s) {
        var topY = self.groundY + (s.dy || 0);
        for (var px = s.x0 + 128; px < s.x1 - 64; px += 256) {
          push(self.add.image(px, topY + 32, TEX.pier).setOrigin(0.5, 0.5).setDepth(2));
        }
      });

      // ---------- 每个缺口：断面 + 深渊 + 雾 + 落点裂纹 ----------
      gaps.forEach(function (g, gi) {
        var leftSeg = segOf(g.x0 - 8);
        var rightSeg = segOf(g.x1 + 8);
        var yL = self.groundY + ((leftSeg && leftSeg.dy) || 0);
        var yR = self.groundY + ((rightSeg && rightSeg.dy) || 0);

        // 断面：左侧岸的右缘 / 右侧岸的左缘（两张镜像的图，一图一用途）
        push(self.add.image(g.x0 - 48, yL, TEX.gapL).setOrigin(0, 0).setDepth(2));
        push(self.add.image(g.x1, yR, TEX.gapR).setOrigin(0, 0).setDepth(2));

        // 深渊渐隐：铺满缺口（宽度是 128 或 192，用 tileSprite 平铺到实际宽度）
        var abyss = push(self.add.tileSprite(g.x0, Math.max(yL, yR) + 2, g.x1 - g.x0, 160, TEX.abyss)
          .setOrigin(0, 0).setDepth(0));
        // TileSprite 的 texture 是它内部生成的画布（key 是 uuid），验收要用标记位认它
        abyss._isAbyss = true;

        // 雾气粒子：缓慢上浮 + 左右轻摆（不走 tween —— 换房销毁对象时容易留下空 tween）
        for (var f = 0; f < 7; f++) {
          var fog = push(self.add.image(
            g.x0 + 14 + Math.random() * Math.max(20, (g.x1 - g.x0) - 28),
            yL + 40 + Math.random() * 80, TEX.fog
          ).setDepth(1).setAlpha(0));
          self._bridgeFog.push({
            img: fog, top: Math.min(yL, yR) - 6,
            speed: rnd(9, 20), phase: Math.random() * 6.28, amp: rnd(3, 8), span: 120
          });
        }

        // 落点撞击裂纹：缺口右侧的落脚点（暗示"有人从对面跳过来砸在这儿"）
        push(self.add.image(g.x1 + 54, yR, TEX.landCrack).setOrigin(0.5, 0).setDepth(2).setAlpha(0.85));

        // ---------- §4.3 ② 落石：只在玩家靠近缺口前后 300px 时触发 ----------
        if (opts.rocks) {
          self._bridgeHazards.push({ x0: g.x0, x1: g.x1, y: Math.min(yL, yR), nextAt: 0 });
        }

        // ---------- §4.3 ③ 残板：缺口中央一块悬空板，站上去 0.8 秒后掉 ----------
        if (opts.plank && gi === 0 && (g.x1 - g.x0) >= 160) {
          self.spawnResidualPlank((g.x0 + g.x1) / 2, Math.max(yL, yR) - 96);
        }

        // ---------- §4.3 ① 对岸射手：缺口右侧固定 1 只远程（复用常规刷怪）----------
        if (opts.sniper && gi === 0) {
          var sx = Math.min(self.levelWidth - 200, g.x1 + 220);
          var e = self.spawnEnemy(self.floor >= 14 ? 'necro' : 'weaver', sx, yR - 120, self.floor);
          if (e) e._bridgeSniper = true;    // 调试用标记：缺口旁"守桥"的那一只
        }
      });
    }

    /** §4.3 ③ 残板：一块可站的单向板，站满 0.8s 就掉 */
    spawnResidualPlank(x, y) {
      var t = this.solids.create(x, y, TEX.platform);
      t.setOrigin(0.5, 0.5);
      t.setVisible(false);
      t.refreshBody();
      if (t.body && TOGGLES.oneWay) {
        t.body.checkCollision.down = false;
        t.body.checkCollision.left = false;
        t.body.checkCollision.right = false;
      }
      this.platformTiles.push(t);
      var vis = this.add.image(x, y - 10, TEX.plankOk).setOrigin(0.5, 0).setDepth(3);
      this.skeletonParts.push(vis);
      this._plank = {
        x: x, y: y, tile: t, vis: vis, standMs: 0, dropped: false, fallVy: 0
      };
    }

    /**
     * 断桥的活体装饰：雾 / 落石 / 残板（2.9.2 §4.2–§4.3）
     * ------------------------------------------------------------
     * 走主 update 而不是 tween / timer：换房会销毁这些对象，
     * 而 tween 与 timedEvent 不跟着消失 —— 留下的空回调是这类
     * 「只在特定房间出现」的功能最常见的坑（也是本项目出现过的 bug 类型）。
     */
    updateBridgeFx(dt, time) {
      // ---------- 雾：缓慢上浮，升到顶回到底部 ----------
      var fog = this._bridgeFog;
      if (fog && fog.length) {
        for (var i = 0; i < fog.length; i++) {
          var f = fog[i];
          if (!f.img || !f.img.active) continue;
          f.img.y -= f.speed * dt / 1000;
          if (f.img.y < f.top) f.img.y = f.top + f.span;
          f.img.x += Math.sin(time / 900 + f.phase) * f.amp * dt / 1000;
          // 中间最浓、两头最淡：雾不该在缺口边缘画出一条硬线
          var k = clamp((f.img.y - f.top) / f.span, 0, 1);
          f.img.setAlpha(0.52 * Math.sin(Math.PI * k));
        }
      }

      // ---------- 落石：玩家进缺口前后 300px 才开始计时 ----------
      var hz = this._bridgeHazards;
      if (hz && hz.length && this.running && !this.heroDead) {
        for (var h = 0; h < hz.length; h++) {
          var z = hz[h];
          if (this.hero.x < z.x0 - 300 || this.hero.x > z.x1 + 300) continue;
          if (!z.nextAt) z.nextAt = time + rnd(700, 1300);
          if (time < z.nextAt) continue;
          z.nextAt = time + rnd(2400, 3600);
          this.spawnRockfall((z.x0 + z.x1) / 2 + rnd(-40, 40), z.y);
        }
      }
      var rocks = this._bridgeRocks;
      if (rocks && rocks.length) {
        for (var r = rocks.length - 1; r >= 0; r--) {
          var rk = rocks[r];
          rk.t += dt;
          if (rk.phase === 'warn') {
            // 0.6s 地面阴影预警：没这一步就是抽奖（可以闪，前提是看得见）
            var p = clamp(rk.t / rk.warnMs, 0, 1);
            if (rk.shadow && rk.shadow.active) {
              rk.shadow.setScale(0.7 + p * 1.5);
              rk.shadow.setAlpha(0.16 + p * 0.34);
            }
            if (rk.t >= rk.warnMs) {
              rk.phase = 'fall';
              rk.t = 0;
              if (rk.shadow) { rk.shadow.destroy(); rk.shadow = null; }
              rk.rock = this.add.image(rk.x, this.hudSafeTop(), TEX.rockfall).setDepth(9);
              rk.vy = 0;
            }
            continue;
          }
          var rock = rk.rock;
          if (!rock || !rock.active) { rocks.splice(r, 1); continue; }
          rk.vy += 1900 * dt / 1000;
          rock.y += rk.vy * dt / 1000;
          rock.rotation += dt / 240;
          var hb = this.hero;
          if (!this.heroDead && hb && Math.abs(rock.x - hb.x) < 32 && Math.abs(rock.y - (hb.y - 40)) < 44) {
            this.damageHero(Math.max(6, Math.round(8 + this.floor * 0.6)), null, false, rock.x);
            this.showFloat(hb.x, hb.y - 96, '落石!', '#c8b8a0', 15);
            if (state.settings.screenShake2D !== false) {
              this.cameras.main.shake(120, 0.005);
            }
            rock.destroy();
            rocks.splice(r, 1);
            continue;
          }
          if (rock.y >= rk.y) {
            this.spark(rock.x, rk.y, 0x9a90b0);
            this.showFloat(rock.x, rk.y - 26, '落石', '#9a90b0', 12);
            if (state.settings.screenShake2D !== false) {
              this.cameras.main.shake(80, 0.003);
            }
            rock.destroy();
            rocks.splice(r, 1);
          }
        }
      }

      // ---------- 残板：站 0.8s 掉，离开就恢复（不惩罚"只是路过"）----------
      var pl = this._plank;
      if (pl && !pl.dropped) {
        var ph = this.hero;
        var standing = !this.heroDead && ph && ph.body && ph.body.blocked.down &&
          Math.abs(ph.x - pl.x) < 30 && Math.abs(ph.y - (pl.y - 10)) < 14;
        if (standing) {
          pl.standMs += dt;
          if (pl.standMs > 240 && pl.vis && pl.vis.texture.key !== TEX.plankLoose) {
            pl.vis.setTexture(TEX.plankLoose);     // 先"松"一下，再掉
          }
          if (pl.standMs >= 800) {
            pl.dropped = true;
            if (pl.tile) { pl.tile.destroy(); pl.tile = null; }
            if (pl.vis) pl.vis.setTexture(TEX.plankFalling).setAlpha(0.85);
            pl.fallVy = 40;
            this.showFloat(pl.x, pl.y - 46, '残板碎了', '#c8b0a0', 14);
            this.spark(pl.x, pl.y, 0x8a6a52);
            sfx('thorn');
          }
        } else {
          pl.standMs = Math.max(0, pl.standMs - dt * 1.6);
          if (pl.vis && pl.standMs < 200 && pl.vis.texture.key !== TEX.plankOk) {
            pl.vis.setTexture(TEX.plankOk);
          }
        }
      }
      if (pl && pl.dropped && pl.vis && pl.vis.active) {
        pl.fallVy += 1600 * dt / 1000;
        pl.vis.y += pl.fallVy * dt / 1000;
        pl.vis.setAlpha(Math.max(0, 0.85 - (pl.vis.y - pl.y) / 240));
        if (pl.vis.y > this.groundY + 420 || pl.vis.alpha <= 0.02) {
          pl.vis.destroy();
          pl.vis = null;
        }
      }
    }

    /** 落石预警：地面阴影（0.6s 后石头落下，见 updateBridgeFx） */
    spawnRockfall(x, surfaceY) {
      var shadow = this.add.ellipse(x, surfaceY + 2, 8, 4, 0x000000, 0.35).setDepth(2);
      if (!this._bridgeRocks) this._bridgeRocks = [];
      this._bridgeRocks.push({
        x: x, y: surfaceY, phase: 'warn', t: 0, warnMs: 600,
        shadow: shadow, rock: null, vy: 0
      });
      this.showFloat(x, surfaceY - 30, '落石!', '#ffd76a', 13);
      sfx('spearwind');
    }

    /**
     * 铺一个房间的地形（buildLevel 的唯一地形入口）
     * legacy 模式绕过骨架选择，直接平厅 —— 即 2.8 行为。
     */
    buildTerrain(node) {
      var params = this.skeletonParams(node);
      params.noPlatforms = !!this._noPlatforms;
      var sk = this._forceSkeleton || ((SKELETON.mode === 'legacy') ? 'flat' : this.pickSkeleton(params));
      // 回退开关：塌陷房抽到双层 / 断桥时，若对应开关关掉就退回平厅（方案 §11）
      if (!this._forceSkeleton && this._roomMechanic === 'collapse') {
        if (sk === 'double' && !MECHANIC.collapseOnDouble) sk = 'flat';
        if (sk === 'bridge' && !MECHANIC.collapseOnBridge) sk = 'flat';
      }
      this._terrainParams = params;
      SKELETON.samples++;
      // applySkeleton 会返回**实际落成**的骨架：双层/断桥在窄视口放不下时会退回平厅，
      // 调试与图鉴必须看到真实结果，而不是抽签结果。
      var actual = this.applySkeleton(sk, params);
      this.roomSkeleton = actual;
      SKELETON.last = {
        mode: SKELETON.mode, skeleton: actual, picked: sk,
        floor: params.floor, roomType: params.roomType
      };
      // 地形铺完再放魂晶：数量/位置/颜色是"房间级"决策，不能跟着单段平台走。
      // 机制房（塌陷回廊）自己放钥匙，用 noCrystals 跳过常规投放。
      if (!(node && node.noCrystals)) this.populateRoomCrystals();
    }

    /** 旧入口保留：外部 / 调试直接调用时等价于"平厅骨架" */
    spawnPlatforms(floor) {
      var params = this.skeletonParams(this.roomNode);
      params.floor = floor;
      this.buildFlatSkeleton(params);
    }

    /**
     * 在指定位置铺一段平台
     * left 是平台左边缘（TileSprite 的 x），y 是平台中线。
     * 碰撞体按 64px 一格铺，视觉交给一整条 TileSprite（9 段平台 = 9 次绘制，
     * 而不是 40+ 个精灵）。
     */
    spawnPlatformAt(left, y, len) {
      var w = len * 64;
      for (var j = 0; j < len; j++) {
        var t = this.solids.create(left + 32 + j * 64, y, TEX.platform);
        t.setOrigin(0.5, 0.5);
        t.setVisible(false);   // 碰撞体不可见，视觉交给整段 TileSprite
        t.refreshBody();
        // ===== v2.9 P1：单向平台 =====
        // 只保留「从上方踩住」这一面（body.up），其余三面关闭：
        //   · 从下往上跳 → 不再被顶住（原来最常见的"跳不上去、卡一下"）
        //   · 左右不再挡人 → 贴边跑不会被平台侧面挂住
        //   · 从上面落下仍然踩得住（up 面照旧）
        // 加速下坠时再把 up 临时关掉，就能直接穿过平台落到下一层。
        if (t.body && TOGGLES.oneWay) {
          t.body.checkCollision.down = false;
          t.body.checkCollision.left = false;
          t.body.checkCollision.right = false;
        }
        this.platformTiles.push(t);
      }
      // 2.9.1 F1：可穿的浮台画成"薄、冷、下缘化掉"的光片。
      // 顶面对齐碰撞面（y−10），底面用 28px 的渐变收成透明 —— 玩家看底面就知道能穿。
      var strip = this.add.tileSprite(left, y - 10, w, 28, TEX.platThin)
        .setOrigin(0, 0).setDepth(2);
      strip._thin = true;    // 调试 / 回归用：这是"可穿的薄浮台"，不是实体楼板
      this.platformStrips.push(strip);

      // 平台不再自己长魂晶：v2.9 P1 改成"房间级投放"（保底 1 + 30% 第二颗），
      // 由 populateRoomCrystals 统一决定数量、位置与颜色。
      var midX = left + w / 2;
      var topY2 = y - 20;
      this.platformPerches.push({ x: midX, y: topY2, len: len, crystal: false });
    }

    /**
     * 加速下坠期间临时关掉「单向平台的上表面」
     * 松键 / 落地立刻恢复；进房时新平台的 up 面默认是开的。
     */
    setPlatformPassThrough(on) {
      on = !!on;
      if (this._platformPass === on) return;
      this._platformPass = on;
      for (var i = 0; i < this.platformTiles.length; i++) {
        var t = this.platformTiles[i];
        if (!t || !t.body || t._solidDeck) continue;   // 双层骨架的实体上层：不可穿
        t.body.checkCollision.up = !on;
      }
    }

    /**
     * 房间级魂晶投放（v2.9 P1）
     * ------------------------------------------------------------
     * 口径（初步设想 §7.2）：每房保底 1 颗 + 30% 额外 1 颗，上限 2 颗。
     * 位置：第一颗永远放在**最低的平台**（保证够得到）；第二颗优先放在更高的平台
     * （越难够到越值钱），但只在最高的 3 段里随机 —— 不会放到天花板死角。
     * 颜色：三色共用显示对象，按权重抽（蓝 70 / 深渊 20 / 腐化 10）。
     */
    populateRoomCrystals(wantOverride) {
      var perches = (this.platformPerches || []).slice();
      if (!perches.length) return;
      // y 越大越低 —— 先按"低 → 高"排
      perches.sort(function (a, b) { return b.y - a.y; });

      var want = (wantOverride != null) ? wantOverride
        : (1 + (Math.random() < CRYSTAL.extraChance ? 1 : 0));
      want = Math.max(1, Math.min(want, CRYSTAL.maxPerRoom, perches.length));

      var picks = [];
      var used = {};
      picks.push(perches[0]);
      used[0] = true;
      if (want > 1) {
        // 更高的平台里随机挑一段（最多看 3 段，避免挑到最顶上够不着的那一段）
        var hi = [];
        for (var i = 1; i < perches.length; i++) hi.push(i);
        hi.sort(function (a, b) { return perches[a].y - perches[b].y; });   // 高的在前
        var top = hi.slice(0, 3);
        var idx = top[Math.floor(Math.random() * top.length)];
        if (idx != null && !used[idx]) { picks.push(perches[idx]); used[idx] = true; }
      }

      var self = this;
      picks.forEach(function (p, n) {
        var kind = self.rollCrystalKind(n > 0);
        self.spawnCrystal(p.x, p.y - 26, kind);
        p.crystal = true;
      });
    }

    /** 按权重抽魂晶颜色；preferRare = 高台上的第二颗，更偏向深渊/腐化 */
    rollCrystalKind(preferRare) {
      if (!TOGGLES.tricolor) return 'blue';   // 回退：只有蓝色魂晶
      var bw = CRYSTAL.blueWeight;
      var aw = CRYSTAL.abyssWeight * (preferRare ? 2.2 : 1);
      var cw = CRYSTAL.corruptWeight * (preferRare ? 2.2 : 1);
      var total = bw + aw + cw;
      var r = Math.random() * total;
      if (r < bw) return 'blue';
      if (r < bw + aw) return 'abyss';
      return 'corrupt';
    }

    // ---------- 平台上的魂晶（给平台一个"值得上去"的理由）----------
    /**
     * v2.9 P1：三色魂晶
     * 共用同一套显示对象（矩形核 + 圆形光晕），只换颜色 —— 不建三套纹理。
     * c 上新增的状态：
     *   kind      blue / abyss / corrupt
     *   stillMs   在拾取范围内"站住"的累计时长
     *   chargeMs  读条进度
     *   chargeGfx 读条圆环（懒建，离开范围就隐藏）
     *   emerg     低血急救提示环（绿，HUD 之外的第二重信号）
     */
    spawnCrystal(x, y, kind) {
      kind = CRYSTAL_KINDS[kind] ? kind : 'blue';
      var def = CRYSTAL_KINDS[kind];
      var core = this.add.rectangle(x, y, 13, 13, def.color, 1).setDepth(5).setAngle(45);
      core.setStrokeStyle(2, 0xffffff, 0.85);
      var glow = this.add.circle(x, y, 14, def.color, 0.16).setDepth(4);
      var spin = this.tweens.add({ targets: core, angle: 405, duration: 3600, repeat: -1 });
      var bob = this.tweens.add({
        targets: [core, glow], y: y - 6, duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
      });
      this.crystals.push({
        x: x, y: y, kind: kind, core: core, glow: glow, taken: false, near: false,
        spin: spin, bob: bob, stillMs: 0, chargeMs: 0, chargeGfx: null, emerg: null, emergTween: null
      });
    }

    /** 低血（<60%）→ 蓝色魂晶转急救，外观变绿；深渊/腐化保留本色但加绿色急救环 */
    crystalLowHp() {
      var h = this.hero;
      return !!(h && h.hp > 0 && h.hp < h.maxHp * CRYSTAL.lowHpAt);
    }

    crystalFill(c) {
      if (!c) return 0x8ad8ff;
      if (c.kind === 'blue' && this.crystalLowHp()) return 0x7fe8a0;
      return CRYSTAL_KINDS[c.kind].color;
    }

    /** 靠近时魂晶放大发亮（"这东西能碰"的可读性提示） */
    paintCrystal(c, near) {
      if (!c || !c.core || !c.core.active) return;
      var col = this.crystalFill(c);
      c.core.setScale(near ? 1.45 : 1);
      c.core.setFillStyle(col, 1);
      c.core.setStrokeStyle(near ? 3 : 2, 0xffffff, near ? 1 : 0.85);
      if (c.glow && c.glow.active) {
        c.glow.setScale(near ? 1.6 : 1);
        c.glow.setFillStyle(col, near ? 0.34 : 0.16);
      }
      this.syncEmergencyRing(c);
    }

    /** 低血急救的第二重信号：绿色呼吸环（深渊/腐化也能一眼看出"现在捡它能救命"） */
    syncEmergencyRing(c) {
      if (!c || !c.core || !c.core.active) return;
      var on = this.crystalLowHp();
      if (on && !c.emerg) {
        c.emerg = this.add.circle(c.core.x, c.core.y, 22, 0x7fe8a0, 0).setDepth(4);
        c.emerg.setStrokeStyle(2, 0x7fe8a0, 0.8);
        c.emergTween = this.tweens.add({
          targets: c.emerg, scaleX: 1.35, scaleY: 1.35, alpha: 0.15,
          duration: 780, yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
        });
      }
      if (c.emerg) {
        c.emerg.setVisible(on && !c.taken);
        if (on) c.emerg.setPosition(c.core.x, c.core.y);
      }
    }

    /** 读条圆环：0 不画；>0 画一段顺时针圆弧（不新增 HUD，进度就长在魂晶身上） */
    paintCrystalCharge(c, ratio) {
      if (!c || !c.core || !c.core.active) return;
      ratio = clamp(ratio || 0, 0, 1);
      if (ratio <= 0) {
        if (c.chargeGfx) c.chargeGfx.setVisible(false);
        return;
      }
      if (!c.chargeGfx) {
        c.chargeGfx = this.add.graphics().setDepth(7);
      }
      var g = c.chargeGfx;
      g.setVisible(true);
      g.clear();
      g.setPosition(c.core.x, c.core.y);
      g.lineStyle(3, 0xffffff, 0.9);
      g.beginPath();
      g.arc(0, 0, 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio, false);
      g.strokePath();
      g.lineStyle(1, CRYSTAL_KINDS[c.kind].color, 0.5);
      g.beginPath();
      g.arc(0, 0, 24, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio, false);
      g.strokePath();
    }

    /** 玩家身边有没有活着的敌人（读条会被贴近的怪打断） */
    enemyNearHero(radius) {
      var h = this.hero;
      if (!h) return false;
      for (var i = 0; i < this.enemies.length; i++) {
        var e = this.enemies[i];
        if (!e || !e.alive || !e.sprite) continue;
        if (Math.abs(e.sprite.x - h.x) <= radius && Math.abs(e.sprite.y - h.y) <= radius) return true;
      }
      return false;
    }

    /**
     * v2.9 P1：停留触发读条拾取
     * ------------------------------------------------------------
     * 靠近魂晶 → 站住 0.2s 开始读条 → 读条 0.6s 完成。
     * 移动 / 受击 / 敌人贴近都会打断（并把进度清零）。
     * 快速跑过（不停留）不会开始读条 —— 这就是"不拿"的表达，
     * 键鼠与触屏完全一致，不需要任何新按键。
     * 实现要点：判定用"位置变化速度 < 阈值"，不要用"没有输入" ——
     * 摇杆回中但有惯性时会误判（施工清单 §9.2）。
     */
    updateCrystals(dt) {
      var h = this.hero, self = this;
      dt = (typeof dt === 'number' && dt > 0) ? dt : 16.7;
      if (!this.crystals || !this.crystals.length) {
        if (this.crystalHint && this.crystalHint.visible) this.crystalHint.setVisible(false);
        return;
      }
      var hintFor = null;
      var hintRatio = 0;
      var still = Math.abs(h.body.velocity.x) <= CRYSTAL.stillSpeed &&
        Math.abs(h.body.velocity.y) <= CRYSTAL.stillVy;
      var enemyNear = this.enemyNearHero(CRYSTAL.enemyNear);
      var hurtLock = this.time.now < (this._hurtAt || 0) + CRYSTAL.hurtLock;
      var canChannel = still && !enemyNear && !hurtLock && !this.diving && !this.heroDead && !this.mapOpen;

      this.crystals.forEach(function (c) {
        if (c.taken || !c.core || !c.core.active) return;
        var dx = Math.abs(c.core.x - h.x), dy = Math.abs(c.core.y - (h.y - 26));
        var inRange = dx <= CRYSTAL.pickupX && dy <= CRYSTAL.pickupY;

        // 浮空钥匙：没有平台可站，读条不可能完成 —— 改成"跳跃触碰即收"
        if (inRange && c.airborne) {
          c.taken = true;
          self.takeCrystal(c);
          return;
        }

        if (!inRange) {
          // 离开拾取范围：读条清零（不拿就是不拿，不需要"取消"操作）
          if (c.chargeMs > 0 && self.collapse) self.collapse.stats.interrupts++;
          c.stillMs = 0;
          c.chargeMs = 0;
          self.paintCrystalCharge(c, 0);
        } else if (!TOGGLES.channel) {
          // 回退：没有读条 —— 进范围直接拾取（2.8 的手感）
          c.taken = true;
          self.takeCrystal(c);
          return;
        } else if (canChannel) {
          if (c.chargeMs <= 0) {
            c.stillMs += dt;
            if (c.stillMs >= CRYSTAL.stayMs) c.chargeMs = 1;
          } else {
            c.chargeMs += dt;
          }
        } else {
          // 移动 / 受击 / 怪贴近：打断并清零
          if (c.chargeMs > 0 && self.collapse) self.collapse.stats.interrupts++;
          c.stillMs = 0;
          c.chargeMs = 0;
        }

        var ratio = c.chargeMs > 0 ? c.chargeMs / CRYSTAL.channelMs : 0;
        self.paintCrystalCharge(c, ratio);
        if (inRange && (!hintFor || ratio > hintRatio)) { hintFor = c; hintRatio = ratio; }

        // 发亮 + 低血急救环：低血时每帧同步一次（血条变化后外观立刻跟上）
        var near = dx <= CRYSTAL.nearX && dy <= CRYSTAL.nearY;
        if (near !== c.near || self.crystalLowHp()) {
          c.near = near;
          self.paintCrystal(c, near);
        }

        if (c.chargeMs >= CRYSTAL.channelMs) {
          c.taken = true;
          self.takeCrystal(c);
        }
      });

      if (this.crystalHint) {
        var show = !!hintFor;
        if (this.crystalHint.visible !== show) this.crystalHint.setVisible(show);
        if (show) {
          var kd = CRYSTAL_KINDS[hintFor.kind];
          var low = this.crystalLowHp();
          var label = hintFor.airborne
            ? '浮空魂晶'
            : (hintRatio > 0
              ? ('拾取中 ' + Math.round(hintRatio * 100) + '%')
              : (low && hintFor.kind === 'blue' ? '救命' : kd.name));
          // 只在内容真的变了才重排文字：setColor / setFontSize 每帧调用会白白重画
          var hkey = label + '|' + (low ? 1 : 0) + '|' + hintFor.kind;
          if (this._crystalHintKey !== hkey) {
            this._crystalHintKey = hkey;
            this.crystalHint.setText(label);
            this.crystalHint.setFontSize(low ? 14 : 12);
            this.crystalHint.setColor(low ? '#7fe8a0' : kd.text);
          }
          this.crystalHint.setPosition(hintFor.core.x, hintFor.core.y + 20);
        }
      }
    }

    /**
     * 拾取结算（v2.9 P1：三色 + 单颗收益上调）
     *  · 蓝：低血 → 急救回血；否则 金币 / 护盾 二选一
     *  · 深渊：强效（大量金币 + 护盾 + 少量回血），代价是房间内敌人强化
     *  · 腐化：请宿主发 1 件遗物 + 1 条诅咒；宿主没接就折成金币（避免"捡了没反应"）
     */
    takeCrystal(c) {
      var h = this.hero, out = '', color = CRYSTAL_KINDS.blue.text;
      var kind = (c && c.kind) || 'blue';
      var kd = CRYSTAL_KINDS[kind];
      var lowHp = this.crystalLowHp();

      if (kind === 'corrupt') {
        color = kd.text;
        var res = hasBridge('corruptCrystal')
          ? callBridge('corruptCrystal', { floor: this.floor, x: c.core.x, y: c.core.y })
          : null;
        if (res && res.ok) {
          out = '腐化魂晶 · 遗物「' + (res.relicName || '未知') + '」 · 诅咒 +1';
          if (res.curseName) out += '（' + res.curseName + '）';
        } else {
          var cg = Math.round((CRYSTAL.points + this.floor) * 3);
          this.points += cg;
          out = '腐化魂晶 · 金币 +' + cg;
        }
      } else if (kind === 'abyss') {
        color = kd.text;
        var ag = 8 + this.floor * 2;
        this.points += ag;
        this.addShield(Math.round(CRYSTAL.shield * 1.6), null);
        this.healHero(Math.max(4, Math.round(h.maxHp * 0.12)), true);
        out = '深渊魂晶 · 金币 +' + ag + ' · 护盾 +' + Math.round(CRYSTAL.shield * 1.6);
        this.empowerRoomEnemies();
      } else if (lowHp) {
        var heal = Math.max(CRYSTAL.healMin, Math.round(h.maxHp * CRYSTAL.healPct));
        var real = this.healHero(heal, true);
        out = '急救 · 生命 +' + (real > 0 ? real : heal);
        color = '#7fd6a0';
      } else if (Math.random() < 0.5) {
        var g = CRYSTAL.points + this.floor;
        this.points += g;
        out = '魂晶 · 金币 +' + g;
        color = '#ffd76a';
      } else {
        this.addShield(CRYSTAL.shield, null);
        out = '魂晶 · 护盾 +' + CRYSTAL.shield;
        color = '#5fd0e0';
      }

      // ===== P4：收集类目标（塌陷回廊的钥匙）=====
      if (this.roomObjective && this.roomObjective.type === 'collect') {
        if (this.collapse) this.onCollapseCollect();
        else {
          this.roomObjective.got = Math.min(this.roomObjective.need, this.roomObjective.got + 1);
          if (this.roomObjective.got >= this.roomObjective.need) this.roomObjective.done = true;
        }
        if (c.isKey) {
          var oo = this.roomObjective, runes = '';
          for (var ri2 = 0; ri2 < oo.need; ri2++) runes += (ri2 < oo.got ? '◆' : '◇');
          out += '　' + runes;
        }
      }

      this.showFloat(h.x, h.y - 96, out, color, 19);
      sfx('crystal');
      this.spark(c.core.x, c.core.y, kd.color);
      // 拾取爆发：双环 + 四散火星，让这一下有分量
      var ring = this.add.circle(c.core.x, c.core.y, 6, kd.color, 0.35).setDepth(11);
      ring.setStrokeStyle(2, 0xffffff, 0.9);
      this.tweens.add({ targets: ring, radius: 46, alpha: 0, duration: 260, onComplete: function () { ring.destroy(); } });
      for (var i = 0; i < 4; i++) this.spark(c.core.x + rnd(-16, 16), c.core.y + rnd(-16, 16), kd.color);
      this.cleanCrystalFx(c);
      var core = c.core;
      this.tweens.add({
        targets: core, y: core.y - 26, alpha: 0, scaleX: 2, scaleY: 2, duration: 240,
        onComplete: function () { core.destroy(); }
      });
      this.refreshHud();
      this.checkFloorClear(true);   // P4 的 collect 目标：拿到钥匙立刻重判开门
      return out;
    }

    /** 深渊魂晶的代价：房间内所有敌人强化（血量 +20%、攻击 +15%） */
    empowerRoomEnemies() {
      var n = 0;
      this.enemies.forEach(function (e) {
        if (!e || !e.alive) return;
        e.maxHp = Math.round(e.maxHp * 1.2);
        e.hp = Math.min(e.maxHp, Math.round(e.hp * 1.2) + 1);
        e.atk = Math.round(e.atk * 1.15);
        n++;
      });
      // 之后刷出来的怪也要吃同一份加成：塌陷 / 守点房是持续刷怪的，
      // 原来只有"当时场上"的怪被强化，玩家等一批新怪进来就把深渊魂晶的代价白拿了。
      // 上限 3 层（连续拿 3 颗深渊魂晶 ≈ ×1.73 血量），避免刷起来叠成不可玩。
      this._roomEmpower = Math.min(3, (this._roomEmpower || 0) + 1);
      if (n > 0) {
        this.showCenter('深渊之力涌动 · 敌人强化', '#c79aff');
        this.refreshHud();
      }
    }

    cleanCrystalFx(c) {
      if (!c) return;
      if (c.spin) c.spin.remove();
      if (c.bob) c.bob.remove();
      if (c.glow) c.glow.destroy();
      if (c.chargeGfx) { c.chargeGfx.destroy(); c.chargeGfx = null; }
      if (c.emergTween) { c.emergTween.remove(); c.emergTween = null; }
      if (c.emerg) { c.emerg.destroy(); c.emerg = null; }
    }

    clearCrystals() {
      if (!this.crystals) return;
      var self = this;
      this.crystals.forEach(function (c) {
        self.cleanCrystalFx(c);
        if (c.core) c.core.destroy();
      });
      this.crystals = [];
    }

    /** 按房间类型决定敌人编成 */
    spawnEnemies(roomType) {
      var floor = this.floor;
      var pool = poolForFloor(floor);
      var list = [];
      var i, n;
      var nonCombat = nonCombatRoom(roomType);

      if (nonCombat) {
        // 非战斗房间：没有敌人
      } else if (roomType === 'boss') {
        list.push((floor >= 3 && Math.random() < 0.35) ? 'shadowking' : 'lord');
        if (floor >= 2) list.push(pool[ri(0, pool.length - 1)]);
      } else if (roomType === 'elite') {
        list.push(Math.random() < 0.5 ? 'guard' : 'necro');
        list.push(Math.random() < 0.5 ? 'guard' : 'necro');
        list.push(pool[ri(0, pool.length - 1)]);
      } else if (roomType === 'mirror') {
        n = clamp(1 + Math.floor(floor / 3), 1, 3);
        for (i = 0; i < n; i++) list.push('mimic');
      } else if (roomType === 'start') {
        n = clamp(1 + Math.floor(floor / 3), 1, 3);
        for (i = 0; i < n; i++) list.push(pool[ri(0, pool.length - 1)]);
      } else {
        // 敌人数：原式 `clamp(2 + floor/2 + ri(0,2), 2, 7)` 在**层 10 就封顶 7 只**，
        // 而房间长度那时还在随层数上涨 → 后期房间越宽、里面反而越空。
        //
        // 现在数量同时受两条约束、取较大者（上限 want 也按房间长度给）：
        //   · byFloor —— 层数强度（原有成长曲线，前期手感不变）
        //   · bySize  —— 把房间铺满所需（每 ~700px 一只）
        // 加了 bySize 是必须的：桌面房间长度有 `W×2` 这个下限（1920 屏 → 3840px），
        // 只按层数给 2~4 只的话，把敌人摊开反而比原来"挤在第二屏"更空 ——
        // 首怪是近了，但打完第一只要跑 900px 才见下一只。
        var want = clamp(Math.round(this.levelWidth / 240), 4, 9);
        var byFloor = 2 + Math.floor(floor / 2);
        var bySize = Math.round(this.levelWidth / 700);
        n = clamp(Math.max(byFloor, bySize) + ri(0, 2), 2, want);
        for (i = 0; i < n; i++) list.push(pool[ri(0, pool.length - 1)]);
        if (floor >= 2 && Math.random() < 0.35) list.push(Math.random() < 0.5 ? 'guard' : 'necro');
      }

      var self = this;

      // 出生点必须在**所有平台之上**。
      // 地面敌人原来固定用 groundY - 80，而这个高度正好落在平台的碰撞层里：敌人一出生
      // 就嵌在平台中间 —— 卡住不动、打不到、也不掉下来，于是「剩余敌人」永远清不了零。
      // 从平台上方落下，结果只有两种：站在平台顶面，或者落回地面，都正常。
      var platformTopY = self.groundY;
      self.platformTiles.forEach(function (t) { if (t.y < platformTopY) platformTopY = t.y; });
      var dropY = Math.min(self.groundY - 80, platformTopY - 60);

      // 水平铺开：原来 x 是「上一只 + 150~260」累加出来的，idx 越大越容易越过关卡右端，
      // 一旦越过就被塞回同一段区间 —— 几只敌人会叠在同一个点上，看起来像一个怪，
      // 实际是两个，打死一个还有一个。
      //
      // ⚠️ 出生区间前移（用户反馈："跑好几分钟才能打一两只怪"）
      // ------------------------------------------------------------
      // 原来 `spanStart = 屏宽 + 60`、且第 0 只固定钉在 `屏宽 + 140` ——
      // 意味着**进房后的整块第一屏永远没有敌人**，每次都得先白跑一屏才见到第一只怪；
      // 房间被拉长到 2200 后这段空跑更长。改成从屏幕中段（0.45W）起铺：
      // 玩家从 x=140 出发，几步之内就接触，进房即有仗打。
      var spanStart = Math.round(self.scale.width * 0.45);
      var spanEnd = Math.max(spanStart + 40, self.levelWidth - 120);
      var step = (spanEnd - spanStart) / Math.max(1, list.length);

      list.forEach(function (key, idx) {
        var def = ENEMY_TYPES[key];
        if (!def) return;
        var x = spanStart + step * (idx + 0.5) + rnd(-step * 0.22, step * 0.22);
        x = clamp(x, spanStart, spanEnd);
        // P3：断桥的缺口上方不刷怪（掉进坑里会被判"脱离战斗"，房间反而更好清）
        x = self.adjustSpawnX(x);
        // 飞行怪的高度随便放都行（它们不与地形碰撞，见 spawnEnemy），
        // 地面怪则从平台上方落下
        var y = def.fly ? rnd(self.scale.height * 0.3, self.groundY - 130) : dropY;
        var e = self.spawnEnemy(key, x, y, floor);
        // 镜像房间：镜像怪按玩家属性成长（越强越难打）
        if (e && key === 'mimic' && roomType === 'mirror') {
          // 数值：宿主接了 enemyScaler 就由它算（tier==='mirror' 分支按玩家属性定标），
          // 这里的硬覆写只在没有宿主时兜底 —— 否则会把宿主算好的数值又盖回去。
          // 名字与标签始终照旧（那是"镜像"的表现，与数值来源无关）。
          if (!HOST.enemyScaler) {
            e.maxHp = Math.round(Math.max(36, self.hero.attack * 3 + self.hero.maxHp * 0.45));
            e.hp = e.maxHp;
            e.atk = Math.max(6, Math.round(self.hero.attack * 0.6));
          }
          // ⚠️ 基底必须是 **e.def**，不是原始表 def（2.9.1 F5）
          // spawnEnemy 已经按 heroRanged() 把镜像怪改成了 shooter（mimicDef，同弹道 / 同射程），
          // 这里若用 ENEMY_TYPES 的原始 chaser 覆盖，shooter 配置会被整份丢掉 ——
          // 表现就是"玩远程英雄进镜像房，镜像怪照样贴脸挥砍"。
          e.def = Object.assign({}, e.def, { name: '镜像·' + self.hero.name });
          e.name = e.def.name;
          if (e.nameLbl) e.nameLbl.setText(e.name);
          if (e.atkLbl) e.atkLbl.setText('攻 ' + e.atk);
        }
      });

      // 平台上站远程敌人：平台从「路过」变成「必须处理的战术地形」
      if (!nonCombat && this.platformPerches.length && list.length) {
        var perches = this.platformPerches.slice();
        var want = (this.floor >= 3 && Math.random() < 0.4) ? 2 : (Math.random() < 0.6 ? 1 : 0);
        for (var pi = 0; pi < want && perches.length; pi++) {
          var spot = perches.splice(ri(0, perches.length - 1), 1)[0];
          var pk = Math.random() < 0.5 ? 'necro' : 'skeleton';
          var pe = this.spawnEnemy(pk, spot.x, spot.y, this.floor);
          if (pe) {
            pe.name = pe.name + ' · 高台';
            pe.onPerch = true;
            if (pe.nameLbl) pe.nameLbl.setText(pe.name);
          }
        }
      }
    }

    /* ============================================================
       非战斗房间的目标物（宝箱 / 祭坛 / 商店 / 休整点 / 事件裂隙）
       ------------------------------------------------------------
       **重画（用户反馈："中间那坨丑死了"）**
       原实现是 `add.rectangle(...)` + `add.circle(...)` 拼的纯色占位图 ——
       一块实心矩形配一条浅色横杠，没有圆角、没有描边、没有高光、没有投影，
       与引擎其它所有视觉（圆角面板 18px / 卡片 10px / 胶囊按钮 / 渐变血条 /
       程序化精灵）完全不在一个语言里，所以显得又硬又廉价。

       现在统一按引擎**既有的三条语言**重画（refinement：保留既有身份，不发明新风格）：
         · **圆角 + 顶部内高光 + 1px 描边** —— 与 addPanel / craftButton / trackTexture 同源
         · **语义色**取自 ROOM_TYPES[type].center —— 与地图节点、HUD 三处同色，不再各写各的
         · **辉光 + 地面投影 + 待交互呼吸** —— 让它从背景里浮出来、并真正"站"在地上
       五种各自有可辨认的剪影（箱子 / 台座宝珠 / 条纹篷 / 篝火 / 裂隙），
       而不是同一个方块换五种颜色。
       ============================================================ */
    /** 目标物底衬：圆角形体 + 顶部内高光 + 语义色描边（全引擎同一套"厚度"语言） */
    paintGoalBody(g, x, y, w, h, fill, accent, r, opts) {
      opts = opts || {};
      g.fillStyle(fill, opts.fillAlpha != null ? opts.fillAlpha : 0.95);
      g.fillRoundedRect(x, y, w, h, r);
      // 顶部内高光：引擎里凡是"有厚度"的面都有这一条（面板 / 胶囊 / 血条）
      if (opts.gloss !== false) {
        g.fillStyle(0xffffff, 0.10);
        g.fillRoundedRect(x + 2, y + 2, w - 4, Math.max(2, h * 0.16), Math.max(1, r - 1));
      }
      if (opts.line !== false) {
        g.lineStyle(opts.lineW || 1, accent, opts.lineAlpha != null ? opts.lineAlpha : 0.55);
        g.strokeRoundedRect(x + 0.5, y + 0.5, w - 1, h - 1, Math.max(0.5, r - 0.5));
      }
    }

    /** 宝箱：箱体 + 檐口式箱盖 + 盖缝 + 锁扣 */
    paintGoalChest(g, accent) {
      this.paintGoalBody(g, -30, -4, 60, 32, 0x5a4110, accent, 6);
      this.paintGoalBody(g, -33, -23, 66, 20, 0x7a5a16, accent, 8);
      g.fillStyle(0x2a1e06, 0.85);
      g.fillRect(-30, -6, 60, 3);                       // 盖缝
      this.paintGoalBody(g, -6, -11, 12, 14, 0xe8c25a, 0xffe8a0, 3, { lineAlpha: 0.85 });
      g.fillStyle(0x3a2a08, 1);
      g.fillCircle(0, -4, 2);                           // 锁孔
    }

    /** 祭坛：三级台座 + 悬浮宝珠（外辉光 → 内芯 → 高光点） */
    paintGoalShrine(g, accent) {
      this.paintGoalBody(g, -30, 6, 60, 20, 0x123f3a, accent, 5);
      this.paintGoalBody(g, -22, -8, 44, 16, 0x17524c, accent, 5);
      this.paintGoalBody(g, -14, -20, 28, 13, 0x1d6a62, accent, 4);
      g.fillStyle(accent, 0.5);
      g.fillRoundedRect(-16, -21, 32, 2, 1);            // 台面辉光线
      g.fillStyle(accent, 0.16); g.fillCircle(0, -44, 17);
      g.fillStyle(accent, 0.42); g.fillCircle(0, -44, 11);
      g.fillStyle(0xffffff, 0.85); g.fillCircle(0, -44, 6);
      g.fillStyle(0xffffff, 0.9); g.fillCircle(-2.5, -46.5, 2);
    }

    /** 商店：立柱 + 台面 + 三件小商品 + 三段条纹遮阳篷 */
    paintGoalShop(g, accent) {
      this.paintGoalBody(g, -30, -8, 6, 36, 0x17402a, accent, 2, { lineAlpha: 0.3, gloss: false });
      this.paintGoalBody(g, 24, -8, 6, 36, 0x17402a, accent, 2, { lineAlpha: 0.3, gloss: false });
      this.paintGoalBody(g, -38, 8, 76, 20, 0x1c4a2a, accent, 5);
      g.fillStyle(0x8ae8a8, 0.9); g.fillRoundedRect(-26, 0, 12, 9, 2);
      g.fillStyle(0xf0d06a, 0.9); g.fillRoundedRect(-8, 0, 12, 9, 2);
      g.fillStyle(0x5fd0e0, 0.9); g.fillRoundedRect(10, 0, 12, 9, 2);
      var y0 = -30, w = 24;
      for (var i = 0; i < 3; i++) {
        g.fillStyle(i % 2 ? 0x2f7a4a : 0x9af0b8, 1);
        g.fillRoundedRect(-36 + i * w, y0, w, 14, 3);
      }
      g.fillStyle(0xffffff, 0.10);
      g.fillRoundedRect(-36, y0 + 1, 72, 4, 2);
      g.lineStyle(1, accent, 0.45);
      g.strokeRoundedRect(-36.5, y0 - 0.5, 73, 15, 4);
    }

    /** 休整点：一圈石 + 交叉木柴 + 三层火焰 */
    paintGoalRest(g, accent) {
      var stones = [[-26, 20], [-13, 24], [2, 25], [16, 23], [27, 18]];
      stones.forEach(function (p) {
        g.fillStyle(0x3a4266, 1); g.fillCircle(p[0], p[1], 6);
        g.fillStyle(0xffffff, 0.08); g.fillCircle(p[0] - 1.5, p[1] - 2, 2.6);
      });
      g.save(); g.translateCanvas(0, 12); g.rotateCanvas(-0.5);
      this.paintGoalBody(g, -16, -3, 32, 6, 0x2a3150, accent, 3, { lineAlpha: 0.35, gloss: false });
      g.restore();
      g.save(); g.translateCanvas(0, 12); g.rotateCanvas(0.5);
      this.paintGoalBody(g, -16, -3, 32, 6, 0x333c60, accent, 3, { lineAlpha: 0.35, gloss: false });
      g.restore();
      g.fillStyle(0xe86878, 0.30); g.fillCircle(0, -6, 19);     // 外焰
      g.fillStyle(0xffb347, 0.72); g.fillCircle(0, -10, 13);    // 中焰
      g.fillStyle(0xffe8a0, 0.92); g.fillCircle(0, -14, 7);     // 内焰
      g.fillStyle(0xffffff, 0.9); g.fillCircle(0, -16, 3);      // 芯
    }

    /** 事件：两块错位石框夹出的竖直裂隙（暗底 + 亮芯 + 外泄光点） */
    paintGoalRift(g, accent) {
      this.paintGoalBody(g, -26, -34, 24, 68, 0x2a2416, accent, 7, { lineAlpha: 0.4 });
      this.paintGoalBody(g, 2, -34, 24, 68, 0x2a2416, accent, 7, { lineAlpha: 0.4 });
      g.fillStyle(0x0a0710, 1);    g.fillRoundedRect(-9, -30, 18, 60, 9);
      g.fillStyle(accent, 0.55);   g.fillRoundedRect(-5, -24, 10, 46, 5);
      g.fillStyle(0xfff3c0, 0.9);  g.fillRoundedRect(-2, -16, 4, 28, 2);
      g.fillStyle(accent, 0.5);
      g.fillRoundedRect(-30, -12, 5, 5, 1.5);
      g.fillRoundedRect(25, -20, 5, 5, 1.5);
      g.fillRoundedRect(21, 10, 4, 4, 1.2);
    }

    /** 非战斗房间的目标物：宝箱 / 祭坛 / 商店 / 休整点 / 事件点 */
    spawnRoomGoal(roomType) {
      // ⚠️ 只有这五种才生成目标物 —— 战斗房（enemy / elite / mirror / boss / start）
      //    必须直接返回。原实现靠"五个 else if 都不命中就什么都不做"隐式做到这一点，
      //    重画时若把最后一种写成 `else`，就会给**所有**房间都塞一个裂隙，
      //    战斗房中央凭空多出一坨（这是重画过程中真实踩到并修掉的一个回归）。
      if (!GOAL_KINDS[roomType]) return;
      var def = ROOM_TYPES[roomType];
      if (!def) return;
      var x = Math.round(this.levelWidth * 0.58);
      var y = this.groundY - 26;
      // 语义色与地图节点 / HUD 同源（ROOM_TYPES[type].center），三处不会再各写各的
      var accent = parseInt(String(def.center).replace('#', ''), 16);

      var root = this.add.container(x, y).setDepth(6);
      var parts = [];

      // 地面投影：让它"站"在地上，而不是浮在背景上
      var shadow = this.add.ellipse(0, 27, 78, 15, 0x04060f, 0.45);
      root.add(shadow);

      // 辉光：语义色柔光（复用引擎的 glowTexture，替代 CSS 的 box-shadow 光晕）
      var glow = this.add.image(0, 2, glowTexture(this))
        .setTint(accent).setAlpha(0.30).setDisplaySize(168, 124);
      root.add(glow); parts.push(glow);

      var body = this.add.container(0, 0);
      root.add(body);

      var art = this.add.graphics();
      body.add(art); parts.push(art);
      if (roomType === 'treasure') this.paintGoalChest(art, accent);
      else if (roomType === 'shrine') this.paintGoalShrine(art, accent);
      else if (roomType === 'shop') this.paintGoalShop(art, accent);
      else if (roomType === 'rest') this.paintGoalRest(art, accent);
      else this.paintGoalRift(art, accent);   // 走到这里一定是 event（上面的 GOAL_KINDS 已把关）

      // 标签：胶囊底 + 文字（与引擎的胶囊 / 卡片语言一致，不再是裸文字）
      var label = this.add.text(0, 0, def.name.replace('房间', '') + ' · ' + (GOAL_HINT[roomType] || '走近查看'), {
        fontFamily: FONT, fontSize: '12px', color: def.center, fontStyle: 'bold'
      }).setOrigin(0.5);
      label.setShadow(0, 1, '#04060f', 4, false, true);
      var lw = Math.round(label.width) + 20, lh = 22;
      var plate = this.add.graphics();
      plate.fillStyle(UI.box, 0.86);
      plate.fillRoundedRect(-lw / 2, -lh / 2, lw, lh, lh / 2);
      plate.fillStyle(0xffffff, 0.03);
      plate.fillRoundedRect(-lw / 2 + 1, -lh / 2 + 1, lw - 2, 4, 2);
      plate.lineStyle(1, accent, 0.30);
      plate.strokeRoundedRect(-lw / 2 + 0.5, -lh / 2 + 0.5, lw - 1, lh - 1, lh / 2 - 0.5);
      var holder = this.add.container(0, -78, [plate, label]);
      root.add(holder); parts.push(plate);

      // 待交互的呼吸感：辉光脉动 + 本体轻微浮动（标签固定，读起来更稳）
      var glowTween = this.tweens.add({
        targets: glow, alpha: 0.15, scaleX: 0.86, scaleY: 0.86,
        duration: 1500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
      });
      var bobTween = this.tweens.add({
        targets: body, y: -4, duration: 1900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
      });

      this.roomGoal = {
        kind: roomType, done: false, x: x, y: y,
        obj: root,          // 兼容字段（"已使用"的表现改走 markGoalUsed）
        extra: null,        // 旧字段：新画法把所有部件都收在 root 里
        glow: glow, label: label, holder: holder,
        parts: parts, tweens: [glowTween, bobTween]
      };
    }

    /**
     * 目标物「已使用」的表现
     * ------------------------------------------------------------
     * 旧写法是 `obj.setFillStyle(0x3a3a44)` —— 只对纯色矩形成立。
     * 重画后主体是 Graphics + Container，改成：熄灭辉光、停掉呼吸、整体压暗、标签转灰。
     */
    markGoalUsed(g) {
      if (!g || g.used) return;
      g.used = true;
      if (g.tweens) {
        var self = this;
        g.tweens.forEach(function (t) { try { t.stop(); } catch (e) { /* 忽略 */ } });
        try { self.tweens.killTweensOf(g.glow); } catch (e) { /* 忽略 */ }
      }
      if (g.glow) g.glow.setVisible(false);
      if (g.parts) {
        g.parts.forEach(function (p) {
          if (p && p.setAlpha) p.setAlpha(0.34);
        });
      }
      if (g.label) { g.label.setText('已使用'); g.label.setColor(UI.muted); g.label.setAlpha(1); }
    }

    /** 触碰宝箱 / 祭坛的结算 */
    resolveRoomGoal() {
      var g = this.roomGoal;
      if (!g || g.done) return;
      // 商店 / 休整点 / 事件：引擎不出自己的结算，交给宿主开面板。
      // 处理完由宿主调 API.finishRoomGoal() 收尾 —— 在那之前传送门不开，
      // 避免「面板还没处理，门已经开了」这种能把玩家卡住的中间态。
      // 祭坛（shrine）只在**宿主接了 roomAction** 时交出去 ——
      // 经典模式要用它做「献祭生命解除诅咒」；试炼没接 bridge，
      // 必须保持引擎原有的「走近祈祷回血」行为不变。
      var hostOwnsShrine = (g.kind === 'shrine' && hasBridge('roomAction'));
      if (g.kind === 'shop' || g.kind === 'rest' || g.kind === 'event' || hostOwnsShrine) {
        if (g.awaiting) return;
        g.awaiting = true;
        this.notifyRoomAction(g.kind, g);
        return;
      }
      g.done = true;
      if (g.kind === 'chest') {
        var gain = 8 + this.floor * 3;
        if (this.hasCurse('贪婪')) gain = Math.max(1, Math.round(gain * 0.5));   // 诅咒：贪婪
        this.points += gain;
        var bonus = '';
        if (Math.random() < 0.45) { this.hero.potions++; bonus = ' · 药水 +1'; }
        this.showFloat(g.x, g.y - 70, '+' + gain + bonus, '#ffd76a', 20);
        this.showCenter('宝箱开启 · 金币 +' + gain + bonus, '#ffd76a');
        this.spark(g.x, g.y - 30, 0xffd76a);
        sfx('chest');
        this.time.delayedCall(140, function () { sfx('coin'); });
      } else {
        var heal = Math.round(this.hero.maxHp * 0.35);
        var before = this.hero.hp;
        this.healHero(heal, true);
        var real = Math.round(this.hero.hp - before);
        this.showCenter(real > 0 ? ('祭坛祈祷 · 生命 +' + real) : '祭坛祈祷 · 生命已满，获得 3 金币', '#7fe8d8');
        if (real <= 0) this.points += 3;
        this.spark(g.x, g.y - 60, 0x7fe8d8);
        sfx('heal');
      }
      if (g.extra) g.extra.destroy();
      this.markGoalUsed(g);          // 重画后"已使用"的表现统一走这里（旧写法是 obj.setFillStyle）
      this.refreshHud();
      this.checkFloorClear();
    }

    /**
     * 宿主处理完非战斗房间（关掉画内面板）后调用：收尾并开放传送门
     * 商店 / 休整点 / 事件房只有走到这里才算「清空」，isRoomCleared 才放行。
     */
    finishRoomGoal() {
      var g = this.roomGoal;
      if (!g || g.done) return false;
      g.done = true;
      g.awaiting = false;
      if (g.extra) g.extra.destroy();
      this.markGoalUsed(g);          // 重画后"已使用"的表现统一走这里
      this.refreshHud();
      this.checkFloorClear();
      return true;
    }

    /**
     * 非战斗房间的目标物被触碰 → 请宿主出面板
     * 引擎**不自己决定**商店卖什么、休整回多少、事件是什么（这些是经典内核的数据），
     * 只把上下文递出去；宿主收到后调 API.openChoicePanel / openShop 等打开画内面板。
     */
    notifyRoomAction(kind, goal) {
      var payload = {
        kind: kind,
        floor: this.floor,
        points: Math.round(this.points),
        hp: Math.round(this.hero.hp), maxHp: this.hero.maxHp,
        potions: this.hero.potions,
        room: this.roomNode ? {
          type: this.roomNode.type, col: this.roomNode.col, row: this.roomNode.row,
          name: this.roomNode.name || null, desc: this.roomNode.desc || null,
          payload: (this.roomNode.payload !== undefined) ? this.roomNode.payload : null
        } : null,
        goal: goal ? { kind: goal.kind, x: goal.x, y: goal.y } : null
      };
      // 同 notifyCheckpoint：bridge 与事件二选一。
      // 两个都发的话，接了 bridge 的宿主会把画内面板开两遍（第二次先关再开，白闪一下）。
      if (hasBridge('roomAction')) { callBridge('roomAction', payload); return true; }
      if (this.emitRt('rt:room-action', payload)) return true;
      // 谁都没接：给个可见反馈，别让玩家以为卡住了
      this.showCenter('这里还没有人打理（宿主未接入）', '#ffd76a');
      this.finishRoomGoal();
      return false;
    }

    /**
     * 直接跳到本层第 index 个房间（不走地图连线，作弊 / 调试用）
     * 与 enterRoom 的区别：不做「只能走相邻房间」的校验 ——
     * 但后面的收尾（buildLevel / 环境重掷 / 事件）与正常进房完全一致。
     */
    gotoRoomByIndex(index) {
      if (!this.running || !this.floorMap || !this.floorMap.nodes) return false;
      var n = this.floorMap.nodes[index];
      if (!n) return false;
      if (this.mapOpen) this.closeMap();
      this.floorMap.current = n;
      n.visited = true;
      this.cameras.main.flash(300, 6, 6, 18);
      this.buildLevel(n);
      var def = ROOM_TYPES[n.type] || ROOM_TYPES.enemy;
      this.showCenter('第 ' + this.floor + ' 层 · ' + def.name, def.center || '#ffd76a');
      this.rollRoomEnv(n.type);
      sfx('door');
      setBgmScene(bgmForRoom(n.type));
      return true;
    }

    /**
     * 敌人属性：优先问宿主（经典公式），宿主没接就退回引擎内置曲线
     * 内置曲线保留原样：hp = def.hp×(1+0.2(f−1))、atk = def.atk×(1+0.15(f−1))
     *
     * 宿主还可以顺带回一个可选的 `ai` 倍率包（移速 / 前摇 / 后摇 / 索敌），
     * 用来做「不只是更肉更痛，而是更主动」的那一层加强 —— 见 boostEnemyDef。
     */
    enemyStats(def, floor, key) {
      if (HOST.enemyScaler) {
        try {
          var r = HOST.enemyScaler({
            key: key, tier: def.tier, baseHp: def.hp, baseAtk: def.atk,
            floor: floor,
            roomType: this.roomNode ? this.roomNode.type : null
          });
          if (r && r.hp > 0) {
            return {
              hp: Math.round(r.hp),
              atk: Math.max(1, Math.round(r.atk > 0 ? r.atk : def.atk)),
              ai: r.ai || null
            };
          }
        } catch (e) {
          console.warn('[战斗2D] 宿主的敌人属性函数出错，退回内置曲线：', e);
        }
      }
      var scale = 1 + (floor - 1) * 0.2;
      return {
        hp: Math.round(def.hp * scale),
        atk: Math.round(def.atk * (1 + (floor - 1) * 0.15)),
        ai: null
      };
    }

    /**
     * 把 AI 缩放应用到 def 的**副本**上
     * ------------------------------------------------------------
     * 敌人的移速 / 前摇 / 后摇 / 索敌范围在 AI 状态机里是被 `def.xxx` 直接读的
     * （十几处），所以不去改那些读取点，而是**换掉 def 本身** —— `e.def` 跟着换，
     * 后面所有读取自然生效。和 mimicDef 是同一个套路。
     *
     * ⚠️ 前摇有下限（200ms）：完美闪避的窗口是固定的 150ms，玩家要"看到起手 →
     *    在命中瞬间闪"；前摇一旦压到窗口附近，这一击就变成没法反应的抽奖，
     *    那不是变强、是变坏。后摇下限 140ms 同理（留出反击的缝）。
     */
    boostEnemyDef(def, ai) {
      if (!ai) return def;
      var out = {};
      for (var k in def) out[k] = def[k];
      if (ai.speed) out.speed = Math.max(12, Math.round(def.speed * ai.speed));
      if (ai.windup) out.windup = Math.max(200, Math.round(def.windup * ai.windup));
      if (ai.recover) out.recover = Math.max(140, Math.round(def.recover * ai.recover));
      if (ai.detect) out.detect = Math.round(def.detect * ai.detect);
      if (ai.attackRange) out.attackRange = Math.round(def.attackRange * ai.attackRange);
      return out;
    }

    spawnEnemy(key, x, y, floor) {
      var def = ENEMY_TYPES[key];
      if (!def) return null;
      // 镜像怪照玩家英雄：造型一致，攻击方式也一致（玩家远程，它就远程）
      if (key === 'mimic') def = this.mimicDef(def);
      var tex = 角色形象.ensureMobTexture(this, key, this.heroLookId);
      this.ensureMobAnims(key, tex);
      var spr = this.physics.add.sprite(x, y, tex, 0);
      spr.setOrigin(0.5, 1);
      spr.setScale(def.scale || 1);
      spr.setDepth(8);
      this.enemyGroup.add(spr);
      spr.body.setSize(def.w, def.h);
      // 偏移要按**这一帧的真实尺寸**算。原来写死 CELL(=64)，而各角色的精灵帧并不都是
      // 64 高（实测约 52）—— 碰撞体整体上移了十几像素：高台上的远程敌人一出生就嵌进
      // 平台、卡在那儿清不掉（「怪都打完了还显示剩余敌人 1」），玩家打它时的判定也偏上。
      var frameW = (spr.frame && spr.frame.realWidth) || CELL;
      var frameH = (spr.frame && spr.frame.realHeight) || CELL;
      spr.body.setOffset((frameW - def.w) / 2, frameH - def.h);
      spr.body.setAllowGravity(!def.fly);
      // 飞行怪不与地形碰撞：它们的悬浮高度必然和平台层重叠（手机横屏时平台几乎占满了
      // 地面以上的空间，没有能避开的空档），不穿过去就会被平台顶住 —— 卡在那儿不动、
      // 打不到、也不掉下来，于是「剩余敌人」永远清不了零。
      // 玩家打飞行怪靠的是距离判定而不是物理接触，所以关掉碰撞没有副作用。
      if (def.fly) spr.body.checkCollision.none = true;
      // 世界边界：不设的话，被击退时敌人会带着速度一路飞出关卡，直到 updateEnemies
      // 里那个「x < -120 或 x > levelWidth + 120」的兜底把它判成「脱离战斗」直接抹掉 ——
      // 玩家看到的就是「怪被打飞到屏幕外面，然后凭空消失」。
      // 主角一直有这条边界（hero.setCollideWorldBounds），敌人漏了。
      spr.setCollideWorldBounds(true);
      if (def.fly) spr.setVelocityY(0);
      if (def.tint) spr.setTint(def.tint);

      var stats = this.enemyStats(def, floor, key);
      // 敌人强化（AI 层）：宿主给了 ai 倍率包就换一份 def 副本 ——
      // e.def 之后读到的就是缩放后的移速 / 前摇 / 后摇 / 索敌。
      // 必须在 e = {...} 之前换，因为 e.def 存的就是这个引用。
      if (stats.ai) def = this.boostEnemyDef(def, stats.ai);
      var hp = stats.hp;

      var e = {
        key: key, def: def, sprite: spr, name: def.name, tier: def.tier, behavior: def.behavior,
        hp: hp, maxHp: hp, atk: stats.atk,
        alive: true, state: 'patrol', dir: Math.random() < 0.5 ? -1 : 1,
        hurtUntil: 0, attackAt: 0, didHit: false, patrolUntil: 0,
        windupUntil: 0, recoverUntil: 0, nextSpecial: 0, chargeUntil: 0
      };
      // 本房间被深渊魂晶强化过 → 之后刷出来的怪吃同一份加成（见 empowerRoomEnemies）
      if (this._roomEmpower > 0) {
        var hpF = Math.pow(1.2, this._roomEmpower), atkF = Math.pow(1.15, this._roomEmpower);
        e.maxHp = Math.round(e.maxHp * hpF);
        e.hp = e.maxHp;
        e.atk = Math.round(e.atk * atkF);
      }
      spr.play(角色形象.mobAnimKeys(key).walk);
      this.enemies.push(e);

      // 头顶血条 + 名字/攻击标签（敌人属性显示）
      // 条宽贴着精灵本体，不再固定比精灵宽一截
      // 血条贴住该角色的实际体型（各角色视觉宽度差得很多，不再按 64px 单元算）
      var inkW = 角色形象.visualWidth(key, this.heroLookId) * (def.scale || 1);
      e.barW = Math.round(clamp(inkW * 1.15 + 8, 32, 76));
      e.meter = this.createMeter({ key: 'hp', h: 7 });
      e.nameLbl = this.add.text(0, 0, def.name, {
        fontSize: '11px', color: UI.tier[def.tier] || UI.tier.normal, fontStyle: 'bold'
      }).setOrigin(1, 0.5).setDepth(9).setVisible(false);
      e.nameLbl.setShadow(0, 1, '#04060f', 4, false, true);
      e.atkLbl = this.add.text(0, 0, '攻 ' + e.atk, {
        fontSize: '11px', color: UI.sub
      }).setOrigin(0, 0.5).setDepth(9).setVisible(false);
      e.atkLbl.setShadow(0, 1, '#04060f', 4, false, true);
      this.meterParts(e.meter).forEach(function (o) { o.setDepth(9); });
      this.setMeterVisible(e.meter, false);

      if (def.tier === 'boss') {
        this.boss = e;
        this.setMeterVisible(this.bossMeter, true);
        this.bossName.setVisible(true);
        this.bossText.setVisible(true);
        this.bossName.setText(def.name);
        this.bossText.setText('生命 ' + hp + ' / ' + hp);
        this.setMeterValue(this.bossMeter, 1);
      }
      return e;
    }

    /**
     * 镜像怪的运行时配置：照当前英雄切换近战 / 远程
     * 玩家是游侠 / 法师 / 贤者时，它改用「同一种弹道 + 镜像紫」远距离放风筝；
     * 玩家是近战英雄时维持原样。改的是副本，不动 ENEMY_TYPES 原表。
     */
    mimicDef(base) {
      var def = {};
      for (var k in base) def[k] = base[k];
      var rg = this.heroRanged();
      if (rg) {
        def.behavior = 'shooter';
        def.rangedKind = rg.kind;
        def.rangedSpeed = Math.round(rg.cfg.speed * 0.72);   // 比玩家慢一档：看得见、闪得掉
        def.attackRange = 330;
        def.keepDist = 200;
        def.name = '镜像怪 · ' + rg.name;
      } else {
        def.rangedKind = null;
      }
      return def;
    }

    spawnPortal() {
      this.portal = this.add.image(this.levelWidth - 100, this.groundY - 45, TEX.portal)
        .setDepth(5).setAlpha(0.25).setVisible(false);
      this.physics.add.existing(this.portal, true);
    }

    // ---------- 主角战斗 ----------
    tryAttack() {
      var now = this.time.now;
      if (!this.running || this.heroDead || now < this.attackReadyAt) return;
      // 举盾时攻击 = 先收盾再打（不阻断操作流，盾反就是这么接出来的）
      if (this.guarding) this.lowerGuard();
      // 连招判定：盾反 > 突进斩 > 落地斩 > 三连斩
      var chain = this.pickChain(now);
      // 远程英雄（游侠 / 法师 / 贤者）：普攻就是远程攻击，地空一致，不进入近战流程
      var rg = this.heroRanged();
      if (rg) { this.tryRangedAttack(now, rg, chain); return; }
      // 滞空挥砍 = 跳劈（下落攻击）
      if (!(this.hero.body.blocked.down || this.hero.body.touching.down)) { this.tryDiveAttack(now); return; }
      if (chain && chain.lunge) this.hero.setVelocityX((this.hero.flipX ? -1 : 1) * chain.lunge);
      // 狂怒状态：攻击间隔缩短 35%
      var rate = this.furyActive() ? FURY.atkSpeed : 1;
      this.attackReadyAt = now + (chain ? Math.max(240, 380 - 60) : 380) / rate;
      this.attacking = true;
      this.attackHits = {};
      this._swingLinkDone = false;   // 连携：新的这一挥可以再烧一点（见 rollPlayerDamage 的守卫）
      this.hero.play('hero_attack', true);

      var dir = this.hero.flipX ? -1 : 1;
      var span = chain ? (chain.range || 1) : 1;
      var slash = this.add.image(this.hero.x + dir * (36 * span), this.hero.y - 34, TEX.slash).setDepth(11);
      slash.setFlipX(dir < 0);
      slash.setAngle(dir < 0 ? -22 : 22);
      if (span > 1) slash.setScale(span);
      if (chain) slash.setTint(parseInt(chain.color.replace('#', ''), 16));
      this.tweens.add({
        targets: slash, alpha: { from: 0.95, to: 0 }, scaleX: 1.3 * span, scaleY: 1.3 * span,
        duration: 180, onComplete: function () { slash.destroy(); }
      });

      var self = this;
      this.time.delayedCall(70, function () {
        if (!self.attacking || !self.running) return;
        self.resolveMeleeHit(chain);
        self.chainSplash(chain);
      });
      this.time.delayedCall(220, function () { if (!self.diving) self.attacking = false; });
      if (chain) this.chainFeedback(chain);
      sfx(chain ? 'crit' : 'attack');
    }

    /**
     * 跳劈起手：滞空时挥砍 → 高速下坠，刀光跟随
     * 下落中命中敌人（1.9 倍伤害），落地产生范围冲击波
     */
    tryDiveAttack(now) {
      if (this.diving || now < this.diveReadyAt || !this.running || this.heroDead) return;
      this.diving = true;
      this.diveHits = {};
      this.attacking = true;
      this._swingLinkDone = false;   // 连携：新的这一次跳劈可以再烧一点
      this._diveLinked = false;      // 跳劈是否带连携（落地冲击波范围据此放大）
      this.attackReadyAt = now + 240;
      this.diveReadyAt = now + 240;
      this.isCharging = false;
      if (this.chargeRing) this.chargeRing.setVisible(false);

      var h = this.hero;
      h.play('hero_attack', true);
      h.setVelocityY(DIVE.speed);
      h.setVelocityX(h.body.velocity.x * 0.6);

      // 下坠期间关掉「英雄 ↔ 敌人」的碰撞。
      // Arcade 会把互相重叠的两个动态体推开：英雄 960px/s 砸下来时，这个推力方向
      // 正好朝下，一帧挤一点，最后把敌人**压穿地面** —— 而沉到地面以下的敌人打不到
      // 也清不掉，整局卡死。关掉之后英雄直接穿过敌人体，手感上也更像「砸穿」。
      if (this._heroEnemyCollider) this._heroEnemyCollider.active = false;

      if (!this.diveFx) this.diveFx = this.add.image(0, 0, TEX.slash).setDepth(11);
      this.diveFx.setVisible(true).setAngle(90).setAlpha(0.95).setScale(0.95);

      this.showFloat(h.x, h.y - 78, '跳劈!', '#ffd76a', 18);
      sfx('attack');
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(70, 0.003);
    }

    /** 跳劈逐帧：下坠命中判定 → 落地冲击 */
    updateDive(onGround) {
      var h = this.hero;
      var self = this;
      if (this.diveFx) this.diveFx.setPosition(h.x + (h.flipX ? -18 : 18), h.y - 8);
      if (h.body.velocity.y < DIVE.speed * 0.5) h.setVelocityY(DIVE.speed);

      var rect = new Phaser.Geom.Rectangle(h.x - 46, h.y - 34, 92, 96);
      var hitAny = false;
      this.enemies.forEach(function (e, idx) {
        if (!e.alive || self.diveHits[idx]) return;
        if (Phaser.Geom.Intersects.RectangleToRectangle(rect, e.sprite.getBounds())) {
          self.diveHits[idx] = true;
          self.showFloat(e.sprite.x, e.sprite.y - 92, '下落斩', '#ff9a5a', 16);
          self.damageEnemy(e, self.rollPlayerDamage(DIVE.mult, false, null, { move: 'dive' }), false);
          // 砸进地里：刻意保留的特性（见 DIVE 里的说明）。
          // 排在伤害之后 —— 已经被打死的敌人不该再演一遍「陷进地里」。
          if (e.alive && self.buryEnemy(e)) {
            self.showFloat(e.sprite.x, e.sprite.y - 120, '砸进地里!', '#c9a06a', 17);
          }
          hitAny = true;
        }
      });
      if (hitAny && state.settings.screenShake2D !== false) this.cameras.main.shake(140, 0.009);
      if (onGround) this.diveImpact();
    }

    /** 跳劈落地：冲击波范围伤害 + 震屏 + 尘环 */
    diveImpact() {
      var h = this.hero;
      var self = this;
      this.diving = false;
      this.attacking = false;
      this.diveReadyAt = this.time.now + DIVE.cooldown;
      this._wasAirborne = false;
      if (this.diveFx) this.diveFx.setVisible(false);
      // 恢复「英雄 ↔ 敌人」的碰撞（下坠期间临时关掉了，见 tryDiveAttack）
      if (this._heroEnemyCollider) this._heroEnemyCollider.active = true;
      // 砸地姿势：定格在下坠帧上再起身
      this._landingUntil = this.time.now + 150;
      // 脚下地裂
      this.groundCrack(h.x, h.y + 2, 460);

      // 带连携的跳劈：冲击波一并放大 —— 让"用它清一群"和"留着打单体盾反"
      // 变成两个真的不一样的选择（倍率上的差别见 rollPlayerDamage）
      var splashR = DIVE.splashRadius * (this._diveLinked ? LINK.splash : 1);

      var ring = this.add.circle(h.x, h.y - 6, 18, 0xffd76a, 0.22).setDepth(11);
      ring.setStrokeStyle(3, 0xffd76a, 0.9);
      this.tweens.add({
        targets: ring, radius: splashR, alpha: 0, duration: 300,
        onComplete: function () { ring.destroy(); }
      });
      this.spark(h.x, h.y - 4, 0xffd76a);
      sfx('anvil');
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(210, 0.013);

      // 冲击波：范围内尚未被下落斩命中的敌人补一次范围伤害
      var radius = splashR;
      this.enemies.forEach(function (e, idx) {
        if (!e.alive || self.diveHits[idx]) return;
        if (Math.abs(e.sprite.x - h.x) <= radius && Math.abs(e.sprite.y - h.y) <= radius * 0.9) {
          self.damageEnemy(e, self.rollPlayerDamage(DIVE.splashMult, false, null, { noLink: true }), false);
        }
      });
      this.showFloat(h.x, h.y - 72, '冲击波', '#ffd76a', 15);
      this._diveLinked = false;   // 这一次跳劈的连携结算完了，别带给下一次
      // 落地后的短暂窗口内接攻击 = 落地斩（连招）
      this.diveCounterUntil = this.time.now + CHAIN.diveWindow;
    }

    /** 脚下地裂：几道从落点散开的裂纹，自己淡出。跳劈落地与敌人被砸进地里都用它 */
    groundCrack(x, y, life) {
      var g = this.add.graphics().setDepth(3);
      g.lineStyle(2, 0x1d140d, 0.85);
      for (var i = 0; i < 6; i++) {
        var dir = (i % 2 === 0) ? 1 : -1;
        var spread = 0.22 + 0.34 * Math.floor(i / 2);
        var len = rnd(16, 36);
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + dir * Math.cos(spread) * len, y + Math.sin(spread) * rnd(3, 8));
        g.strokePath();
      }
      this.tweens.add({
        targets: g, alpha: 0, duration: Math.max(200, life || 420),
        onComplete: function () { g.destroy(); }
      });
      return g;
    }

    /**
     * 把敌人砸进地里（刻意保留的特性，不是 bug）
     * ------------------------------------------------------------
     * 只压扁**视觉**，物理体一动不动 —— 这样玩家照样打得到它、清得掉。
     * 以前「砸进地里」其实是物理事故的副产品：英雄下坠时和敌人之间挂着 collider，
     * 把敌人一帧一帧往地下挤，挤穿地面之后打不到也清不掉，整局就此卡住。
     * 现在换成显式机制：有概率触发、有固定时长、时间到自己拱出来。
     * 返回是否真的触发了。
     */
    buryEnemy(e) {
      if (!e || !e.alive || e.buried) return false;
      if (Math.random() >= DIVE.buryChance) return false;
      var spr = e.sprite;
      if (!spr || !spr.active) return false;
      var self = this;

      e.buried = true;
      e.buryUntil = this.time.now + DIVE.buryTime;
      // 陷在地里期间不行动：复用硬直通道（updateEnemies 里会直接 return）
      e.hurtUntil = Math.max(e.hurtUntil || 0, e.buryUntil);
      spr.setVelocity(0, 0);
      if (e._buryBaseScaleY == null) e._buryBaseScaleY = spr.scaleY;
      var baseY = e._buryBaseScaleY;

      this.tweens.add({ targets: spr, scaleY: baseY * DIVE.burySquash, duration: 90, ease: 'Quad.easeOut' });
      this.groundCrack(spr.x, spr.y + 2, DIVE.buryTime);
      this.spark(spr.x, spr.y - 12, 0xc9a06a);
      sfx('anvil');
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(130, 0.007);

      // 时间到了自己从地里拱出来
      this.time.delayedCall(DIVE.buryTime, function () {
        if (!spr.active || !e.alive) return;
        e.buried = false;
        self.tweens.add({ targets: spr, scaleY: baseY, duration: 260, ease: 'Back.easeOut' });
        self.spark(spr.x, spr.y - 6, 0xc9a06a);
      });
      return true;
    }

    resolveMeleeHit(chain) {
      var dir = this.hero.flipX ? -1 : 1;
      var span = chain ? (chain.range || 1) : 1;
      // 觅隙（2.9.2 F7 · 近战）：判定宽 +6px，刀光自动朝最近的敌人偏 12°
      var wExtra = this.relicFx('swingWidth', 0);
      var aimDeg = this.relicFx('swingAim', 0);
      var hx = this.hero.x + dir * 40 * span;
      var hy = this.hero.y - 36;
      if (aimDeg > 0) {
        // 轴对齐矩形不能旋转，所以"偏 12°"落在判定的**纵向落点**上：
        // 只朝面向那一侧 170px 内最近的敌人偏，偏移量 = tan(12°) × 水平距离，且不超过半高。
        var near = null, nd = 1e9, h0 = this.hero;
        this.enemies.forEach(function (e) {
          if (!e.alive || !e.sprite) return;
          var dx2 = (e.sprite.x - h0.x) * dir;
          if (dx2 < 8 || dx2 > 170) return;
          var d2 = Math.abs(dx2) + Math.abs(e.sprite.y - h0.y) * 0.5;
          if (d2 < nd) { nd = d2; near = e; }
        });
        if (near) {
          var maxOff = Math.min(36, Math.tan(Phaser.Math.DegToRad(aimDeg)) *
            Math.abs(near.sprite.x - this.hero.x));
          hy += Phaser.Math.Clamp((near.sprite.y - 24) - hy, -maxOff, maxOff);
        }
      }
      var rect = new Phaser.Geom.Rectangle(
        hx - (44 + wExtra / 2) * span, hy - 36, (88 + wExtra) * span, 72);
      var self = this;
      this.enemies.forEach(function (e, idx) {
        if (!e.alive || self.attackHits[idx]) return;
        if (Phaser.Geom.Intersects.RectangleToRectangle(rect, e.sprite.getBounds())) {
          self.attackHits[idx] = true;
          self.damageEnemy(e, self.rollPlayerDamage(chain ? chain.mult : 1, chain && chain.forceCrit, chain && chain.name), false);
          if (chain && chain.name === '盾反') {
            var kd = (e.sprite.x >= self.hero.x) ? 1 : -1;
            e.sprite.setVelocity(kd * 320, -180);
          }
        }
      });

      // 裂阵（2.9.2 F7 · 近战）：横扫额外把「判定外最近的一个」也扫进去。
      // 不加默认命中上限 —— 横扫本来就能扫一片，"多一个目标"应该做成纯增量，
      // 而不是先把默认值砍下来再卖回来。
      if (chain && chain.name === '横扫' && Math.round(this.relicFx('sweepExtra', 0)) > 0) {
        var best = null, bd = 1e9;
        this.enemies.forEach(function (e, idx) {
          if (!e.alive || self.attackHits[idx] || !e.sprite) return;
          var d = Math.abs(e.sprite.x - self.hero.x) + Math.abs(e.sprite.y - self.hero.y) * 0.5;
          if (d < bd && d < 180) { bd = d; best = { e: e, idx: idx }; }
        });
        if (best) {
          self.attackHits[best.idx] = true;
          self.damageEnemy(best.e, self.rollPlayerDamage(chain.mult * 0.8, false, '裂阵'), false);
          self.showFloat(best.e.sprite.x, best.e.sprite.y - 62, '裂阵', '#ffd76a', 14);
        }
      }
    }

    // ============================================================
    //  远程攻击（游侠 · 长弓 / 法师 · 法杖 / 贤者 · 卷轴）
    //  这三种武器本来就不是用来挥砍的：普攻改成各自的专属远程攻击。
    //  外观（弹道 kind、颜色、招式名）来自 角色形象.RANGED，
    //  数值来自 RANGED_ATTACK —— 形象与手感分开调，互不牵扯。
    // ============================================================
    /** 当前英雄的远程配置；近战英雄返回 null */
    heroRanged() {
      var A = 角色形象;
      var id = this.heroLookId;
      if (!A || !A.RANGED || !A.RANGED[id]) return null;
      var cfg = RANGED_ATTACK[id];
      if (!cfg) return null;
      var art = A.RANGED[id];
      var look = A.LOOKS[id] || {};
      return {
        id: id, kind: art.kind, name: art.name, cfg: cfg,
        color: (look.colors && look.colors.acc) || 0xffffff
      };
    }

    /**
     * 远程普攻：落地平射；滞空时自动朝最近的敌人射击（空战也打得中）
     * 连招（chain）走远程自己的一套：反击箭 / 连珠箭 / 踏地箭 / 三连散，见 RANGED_CHAIN
     */
    tryRangedAttack(now, rg, chain) {
      var h = this.hero, cfg = rg.cfg;
      var grounded = h.body.blocked.down || h.body.touching.down;
      if (now < this.attackReadyAt) return;
      // 连珠（2.9.2 F7 · 远程）：连射间隔 −12% 已经在 applyMechRelics 里按基准缩短，
      // 这里只处理「每第 3 发 +50%」——900ms 内连着按才算同一串。
      var thirdBoost = this.relicFx('thirdShotMult', 0);
      var shotBonus = 1;
      if (thirdBoost > 0) {
        if (now - (this._shotStreakAt || 0) > 900) this._shotStreak = 0;
        this._shotStreak = (this._shotStreak || 0) + 1;
        this._shotStreakAt = now;
        if (this._shotStreak >= 3) { this._shotStreak = 0; shotBonus = 1 + thirdBoost; }
      }
      // 狂怒状态：远程攻击间隔同样缩短
      this.attackReadyAt = now + cfg.cd / (this.furyActive() ? FURY.atkSpeed : 1);
      this.attacking = true;
      this.attackHits = {};
      this._swingLinkDone = false;   // 连携：新的一次射击可以再烧一点

      // 位移：近战连招是「自己冲上去」（lunge）；远程连招都不带位移 ——
      // 弓与法杖的收益在弹丸上，不在身位上（连珠箭是原地连射，见 RANGED_CHAIN.roll）
      var faceDir = h.flipX ? -1 : 1;
      if (chain && chain.lunge) h.setVelocityX(faceDir * chain.lunge);

      var aim = this.rangedAim(grounded);
      if (aim.dir !== faceDir) h.setFlipX(aim.dir < 0);
      h.play('hero_attack', true);

      // 滞空时射过一箭 → 落地打开踏地箭窗口（远程没有跳劈，用空中射击接同一套节奏）
      if (!grounded) this._airShotAt = now;
      if (!grounded) this.showFloat(h.x, h.y - 80, '空中射击', hexOf(rg.color), 14);
      if (chain) this.chainFeedback(chain);
      sfx(chain ? 'crit' : (cfg.spin ? 'magic' : 'shoot'));

      var self = this;
      // 拉弓 / 举杖需要一小段起手：起手帧先亮，弹丸 90ms 后离手。
      // 瞄准点在离手那一刻重算 —— 不然这 90ms 里主角自己移动/落地了，弹丸会飞歪。
      this.time.delayedCall(90, function () {
        if (!self.running || self.heroDead) return;
        var g2 = self.hero.body.blocked.down || self.hero.body.touching.down;

        // 三连散：一次射出多支。
        // 场上有多个敌人时**一支锁一个**（真·全覆盖，和近战横扫"扫开一整片"对应）；
        // 只剩一个敌人时退回按角度散开，仍然是一发三支的扇形。
        if (chain && chain.spread > 1) {
          var n = chain.spread, mid = (n - 1) / 2, deg = chain.spreadDeg || 12;
          var base = self.rangedAim(g2);
          var targets = self.nearestEnemies(n);
          for (var i = 0; i < n; i++) {
            var tgt = targets[i];
            var aimI = tgt
              ? { dir: (tgt.sprite.x >= self.hero.x ? 1 : -1), tx: tgt.sprite.x, ty: tgt.sprite.y - 26 }
              : base;
            self.fireShot(rg, aimI, chain, {
              angleDeg: tgt ? 0 : (i - mid) * deg,
              mult: (i === 0) ? shotBonus : (chain.sideMult || 0.7) * shotBonus,   // 主目标满伤，其余两支打折
              air: !g2
            });
          }
          return;
        }

        // 连珠箭：连续点射（间隔 burstGap），**每一发都重新锁定**最近的敌人 ——
        // 目标在跑、跳到高台，后面几发都会跟着改角度；总倍率靠打满三发换
        if (chain && chain.burst > 1) {
          var gap = chain.burstGap || 90;
          for (var b = 0; b < chain.burst; b++) {
            (function (idx) {
              self.time.delayedCall(idx * gap, function () {
                if (!self.running || self.heroDead) return;
                self.fireShot(rg, self.lockAim(ENV.lockRange), chain, { mult: shotBonus, air: !g2 });
              });
            })(b);
          }
          return;
        }

        // 踏地箭：瞄向地面（就近敌人的脚下 / 前方地面），箭带下坠弧线，插地即炸
        if (chain && chain.blast) {
          self.fireShot(rg, self.groundAim(), chain, { grav: RANGED_CHAIN.land.grav, mult: shotBonus, air: !g2 });
          return;
        }

        self.fireShot(rg, self.rangedAim(g2), chain, { mult: shotBonus, air: !g2 });
      });
      this.time.delayedCall(Math.min(cfg.cd - 40, 260), function () { self.attacking = false; });
    }

    /** 最近的 n 个敌人（三连散一支锁一个用） */
    nearestEnemies(n) {
      var h = this.hero;
      return this.enemies.filter(function (e) { return e.alive; })
        .map(function (e) {
          return { e: e, d: Math.abs(e.sprite.x - h.x) + Math.abs(e.sprite.y - h.y) * 0.5 };
        })
        .sort(function (a, b) { return a.d - b.d; })
        .slice(0, n)
        .map(function (o) { return o.e; });
    }

    /** 踏地箭的落点：优先瞄最近敌人的脚下，没有敌人就瞄前方地面 */
    groundAim() {
      var h = this.hero, dir = h.flipX ? -1 : 1;
      var best = null, bd = 1e9;
      this.enemies.forEach(function (e) {
        if (!e.alive) return;
        var d = Math.abs(e.sprite.x - h.x);
        if (d < bd) { bd = d; best = e; }
      });
      var tx = best ? best.sprite.x : (h.x + dir * 170);
      var ty = best ? (best.sprite.y - 4) : (this.groundY - 4);
      if (Math.abs(tx - h.x) > 12) dir = tx >= h.x ? 1 : -1;
      return { dir: dir, tx: tx, ty: ty };
    }

    /**
     * 锁定最近敌人的瞄准点（连珠箭每发重锁用）
     * 普攻落地时是**固定平射**（想打哪就打哪、也能空放），只有这招会锁人；
     * 超出 maxDist 就不锁，保持平射 —— 免得隔着半个房间拐弯。
     */
    lockAim(maxDist) {
      var h = this.hero;
      var best = null, bd = 1e9;
      this.enemies.forEach(function (e) {
        if (!e.alive) return;
        var d = Math.abs(e.sprite.x - h.x);
        if (d < bd) { bd = d; best = e; }
      });
      if (!best || (maxDist && bd > maxDist)) return this.rangedAim(true);
      return {
        dir: (best.sprite.x >= h.x) ? 1 : -1,
        tx: best.sprite.x,
        ty: best.sprite.y - 26
      };
    }

    /** 瞄准点：落地时朝正前方平射；滞空时朝最近的敌人（越近越优先） */
    rangedAim(grounded) {
      var h = this.hero;
      var dir = h.flipX ? -1 : 1;
      var tx = h.x + dir * 300, ty = h.y - 34;
      if (!grounded) {
        var best = null, bd = 1e9;
        this.enemies.forEach(function (e) {
          if (!e.alive) return;
          var d = Math.abs(e.sprite.x - h.x) + Math.abs(e.sprite.y - h.y) * 0.5;
          if (d < bd) { bd = d; best = e; }
        });
        if (best) {
          tx = best.sprite.x; ty = best.sprite.y - 26;
          if (Math.abs(tx - h.x) > 12) dir = tx >= h.x ? 1 : -1;
        }
      }
      return { dir: dir, tx: tx, ty: ty };
    }

    /**
     * 射出弹丸：箭矢 / 奥术弹 / 灵能波
     * extra（可选）是连招的额外参数：
     *   angleDeg  扇形偏角（三连散的左右两支）
     *   mult      这一发的伤害系数（三连散的两侧打折）
     *   grav      下坠加速度（踏地箭瞄地面）
     */
    fireShot(rg, aim, chain, e) {
      var h = this.hero, cfg = rg.cfg, A = 角色形象;
      var extra = e || {};
      var mult = (chain ? chain.mult : 1) * (extra.mult != null ? extra.mult : 1);
      // 坠星（2.9.2 F7 · 远程）：空中射击 +0.4 倍。溅射在下面挂到弹丸上。
      var airAdd = extra.air ? this.relicFx('airShotDmg', 0) : 0;
      if (airAdd > 0) mult *= (1 + airAdd);
      var tex = A.ensureShotTexture(this, rg.kind, rg.color);
      var anim = A.ensureShotAnim(this, rg.kind, rg.color, rg.kind === 'wave' ? 9 : 16);
      var size = A.shotSize(rg.kind);
      var mx = h.x + aim.dir * 26, my = h.y - 34;

      var s = this.physics.add.sprite(mx, my, tex, 0);
      s.setDepth(9);
      s.play(anim);
      s.body.setAllowGravity(false);
      s.body.setSize(size.bw, size.bh, true);         // 判定框贴着可见弹体
      var boost = chain ? (chain.boost || 1.25) : 1;   // 连招弹丸更大更亮
      if (boost > 1) { s.setScale(boost); s.body.setSize(size.bw * boost, size.bh * boost, true); }

      var dx = aim.tx - mx, dy = aim.ty - my;
      if (Math.abs(dx) < 8) dx = aim.dir * 8;                 // 正上/正下不成立：兜个方向
      var ang = Math.atan2(dy, dx) + (extra.angleDeg ? Phaser.Math.DegToRad(extra.angleDeg) : 0);
      var spd = cfg.speed * (chain && chain.speedMult ? chain.speedMult : 1);
      s.setVelocity(Math.cos(ang) * spd, Math.sin(ang) * spd);
      if (rg.kind !== 'orb') s.setRotation(ang);

      s._friendly = true;
      s._kind = rg.kind;
      s._color = rg.color;
      s._grav = extra.grav || 0;                       // 手动积分：弹丸不该吃满世界重力
      // 伤害在离手时定，吃到当下所有强化；连招额外乘倍率、盾反（反击箭）必定暴击
      s._roll = this.rollPlayerDamage(cfg.dmg * mult, chain && chain.forceCrit, chain && chain.name);
      s._pierce = Math.max(cfg.pierce || 1, (chain && chain.pierce) || 0);   // 取大值：反击箭不会把贤者的穿透 99 削弱
      s._counter = chain ? chain.name : null;          // 带上招式名，命中时飘字
      s._hit = {};
      s._lifeUntil = this.time.now + cfg.life;
      s._knock = Math.max(cfg.knock || 80, (chain && chain.knock) || 0);
      s._splash = cfg.splash || 0;
      s._splashMult = cfg.splashMult || 0;
      // 坠星：空中射击的弹丸命中时溅射 40px（不覆盖英雄自带的更大溅射）
      if (airAdd > 0) {
        s._splash = Math.max(s._splash, this.relicFx('airSplash', 0) || 40);
        s._splashMult = Math.max(s._splashMult, 0.55);
      }
      s._homing = cfg.homing || 0;
      // 踏地箭：命中会炸，落地 / 失效也会炸（blastShot）
      if (chain && chain.blast) { s._blast = chain.blast; s._blastMult = chain.blastMult || 0.6; }
      this.shots.push(s);

      // 出手表现：手上一点光 + 轻微后坐
      this.spark(mx, my, rg.color);
      var ring = this.add.circle(mx, my, 5, rg.color, 0.5).setDepth(11);
      this.tweens.add({ targets: ring, radius: 18, alpha: 0, duration: 150, onComplete: function () { ring.destroy(); } });
      return s;
    }

    /** 弹丸逐帧：追踪 → 命中 → 穿透 / 消失（踏地箭落地即炸） */
    updateShots(dt) {
      if (!this.shots || !this.shots.length) return;
      var self = this, now = this.time.now;
      this.shots = this.shots.filter(function (s) {
        if (!s || !s.active) return false;
        if (now > s._lifeUntil || s.x < -80 || s.x > self.levelWidth + 80 ||
          s.y < -240 || s.y > self.groundY + 800) {
          if (s._blast) self.blastShot(s);     // 飞到寿命尽头也要炸，不然踏地箭会静悄悄消失
          s.destroy(); return false;
        }
        if (s._grav) {                          // 踏地箭：手动积分出下坠弧线
          s.setVelocityY(s.body.velocity.y + s._grav * dt / 1000);
          if (s.body.blocked.down || self.projectileGroundY(s.x, s.y) !== null) {
            self.blastShot(s); s.destroy(); return false;
          }
        }
        if (s._homing) self.steerShot(s, dt);
        if (s._kind !== 'orb' && s.body) s.setRotation(Math.atan2(s.body.velocity.y, s.body.velocity.x));

        var hitAny = false;
        self.enemies.forEach(function (e, idx) {
          if (!e.alive || s._hit[idx]) return;
          if (!self.shotHitsBody(s, e)) return;
          s._hit[idx] = true;
          self.damageEnemy(e, s._roll, false);
          if (s._knock) e.hurtUntil = Math.max(e.hurtUntil, now + s._knock);   // 硬直 = 被弹丸顶住
          if (s._splash) self.splashShot(s, e, s._splash, s._splashMult);
          self.spark(s.x, s.y, s._color);
          hitAny = true;
          s._pierce -= 1;
        });
        if (hitAny && s._pierce <= 0) { s.destroy(); return false; }
        return true;
      });
    }

    /**
     * 弹丸是否打中敌人：拿判定框（body）比，而不是拿 64px 的贴图框比
     * 用贴图框会比视觉早约 40px 判中，看着像「还没碰到就炸了」。
     */
    shotHitsBody(s, e) {
      var sb = s.body, eb = e.sprite.body;
      if (!sb || !eb || !sb.enable || !eb.enable) return false;
      var a = _rectA.setTo(sb.x, sb.y, sb.width, sb.height);
      var b = _rectB.setTo(eb.x, eb.y, eb.width, eb.height);
      return Phaser.Geom.Intersects.RectangleToRectangle(a, b);
    }

    /** 追踪（奥术弹）：每秒朝最近敌人转过 homing 弧度，转不过来就擦身而过 */
    steerShot(s, dt) {
      var best = null, bd = 1e9;
      this.enemies.forEach(function (e) {
        if (!e.alive) return;
        var d = Math.abs(e.sprite.x - s.x) + Math.abs(e.sprite.y - s.y);
        if (d < bd) { bd = d; best = e; }
      });
      if (!best || !s.body) return;
      var cur = Math.atan2(s.body.velocity.y, s.body.velocity.x);
      var want = Math.atan2((best.sprite.y - 24) - s.y, best.sprite.x - s.x);
      var diff = Phaser.Math.Angle.Wrap(want - cur);
      var maxTurn = s._homing * dt / 1000;
      var next = cur + Phaser.Math.Clamp(diff, -maxTurn, maxTurn);
      var sp = Math.sqrt(s.body.velocity.x * s.body.velocity.x + s.body.velocity.y * s.body.velocity.y);
      s.setVelocity(Math.cos(next) * sp, Math.sin(next) * sp);
    }

    /**
     * 踏地箭：就地炸开一圈（命中敌人时由 _splash 走同一条路，这里管落地 / 失效那一下）
     * 与 splashShot 的区别：溅射中心是**弹丸自己所在的位置**，不是被打中的敌人。
     */
    blastShot(s) {
      var self = this, radius = s._blast || 96, cy = s.y - 6;
      var ring = this.add.circle(s.x, cy, 10, s._color, 0.26).setDepth(11);
      ring.setStrokeStyle(3, s._color, 0.9);
      this.tweens.add({
        targets: ring, radius: radius, alpha: 0, duration: 240,
        onComplete: function () { ring.destroy(); }
      });
      this.spark(s.x, cy, s._color);
      sfx('splash');
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(80, 0.004);
      var mult = s._blastMult || 0.6;
      this.enemies.forEach(function (e, idx) {
        if (!e.alive || s._hit[idx]) return;
        if (Math.abs(e.sprite.x - s.x) > radius || Math.abs((e.sprite.y - 22) - cy) > radius) return;
        s._hit[idx] = true;
        self.damageEnemy(e, {
          dmg: Math.max(1, Math.round(s._roll.dmg * mult)), crit: false, chain: s._counter
        }, false);
        e.hurtUntil = Math.max(e.hurtUntil, self.time.now + 120);
      });
    }

    /** 命中溅射（奥术弹）：以被打中的那只为中心，主目标不重复吃溅射，只扫周围 */
    splashShot(s, hit, radius, mult) {
      var self = this;
      // 溅射中心 = 被打中的敌人（不是弹丸擦到它的那个位置，否则范围会偏出去半个身位）
      var cx = hit.sprite.x, cy = hit.sprite.y - 22;
      var ring = this.add.circle(cx, cy, 8, s._color, 0.26).setDepth(11);
      ring.setStrokeStyle(3, s._color, 0.9);
      this.tweens.add({ targets: ring, radius: radius, alpha: 0, duration: 230, onComplete: function () { ring.destroy(); } });
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(70, 0.003);
      this.enemies.forEach(function (e, idx) {
        if (!e.alive || s._hit[idx]) return;
        if (Math.abs(e.sprite.x - cx) > radius || Math.abs((e.sprite.y - 22) - cy) > radius) return;
        self.damageEnemy(e, { dmg: Math.max(1, Math.round(s._roll.dmg * mult)), crit: false }, false);
        e.hurtUntil = Math.max(e.hurtUntil, self.time.now + 90);
      });
      sfx('splash');
    }

    /**
     * 玩家伤害结算的唯一出口（普攻 / 连招 / 跳劈 / 技能都走这里）
     * @param {object} [opts] noLink: true = 这一下不吃连携（技能每段、跳劈溅射这类
     *                        "同一次挥击的附属段"，否则一次跳劈会连吃两点）
     *                        move: 招式类型（'dive' = 跳劈），给连携加招式专属效果
     */
    rollPlayerDamage(mult, forceCrit, chainName, opts) {
      var now = this.time.now;
      var sharp = now < this.perfectUntil;              // 完美闪避强化：锐利
      var power = now < (this.skillPowerUntil || 0) ? (this.skillPowerMult || 1) : 1;   // 英雄技能强化
      var pass = this.heroPassiveDamage();              // 英雄被动（首击 / 概率 / 低血）
      var env = this.envPlayerDamageMult();             // 环境：虚弱之雾 / 能量涌动
      var critEnv = this.envPlayerCrit();               // 环境：幸运 / 暴击共振
      var fury = this.furyActive() ? FURY.dmgMult : 1;  // 狂怒状态：伤害 ×1.5
      var base = this.hero.attack * env * fury * rnd(0.85, 1.15) * (mult || 1)
        * (sharp ? DODGE.sharpMult : 1) * power + pass.flat;
      if (this.hero.combo > 0 && this.comboCount > 0) {
        // 环境：连击风暴 —— 连击加成本身也被放大
        var comboRate = this.hero.combo + (this.hasEnv('连击风暴') ? this.envValue('comboBonus') * 100 : 0);
        base *= (1 + Math.min(this.comboCount, 8) * (comboRate / 100));
      }
      // 遗物：造成伤害的系数（表见 RELIC_FX）
      var relicDmg = 1 + this.relicFx('dmgMult', 0);
      // 破釜沉舟（血怒流核心）：伤害随**已损失的生命比例**连续上升。
      // 原来是"半血以下 +25%"的开关 —— 开关只让玩家"等到半血"，
      // 而曲线让玩家主动去够：再挨一下就能多打 7%，这个"要不要冒险"才是流派的玩法。
      var perMiss = this.relicFx('dmgPerMissingHp', 0);
      if (perMiss > 0 && this.hero.maxHp > 0) {
        var missRatio = Math.max(0, 1 - this.hero.hp / this.hero.maxHp);
        if (missRatio > 0) relicDmg *= 1 + Math.min(0.80, missRatio * perMiss * 10);
      }
      if (this.hasPerk('berserkLowHp') && this.hero.hp <= this.hero.maxHp * 0.5) {
        relicDmg *= 1 + this.relicFx('dmgLowHp', 0.25);
      }
      if (relicDmg !== 1) base *= relicDmg;

      // 连携：把点数烧在这一击上。
      // 这是整套系统**唯一**的消费点 —— 于是"这点数是留给盾反，还是现在就砍掉"
      // 这个决定，完全由玩家自己的出招时机做出来，不需要额外的按键。
      var linked = false;
      // _swingLinkDone 守卫：一次挥击只烧一点。
      // 近战 / 跳劈的命中都是"遍历敌人逐个结算"，没这个守卫的话
      // 一刀扫中 3 只怪就会把 3 点连携一口气吃光。
      if (!(opts && opts.noLink) && !this._swingLinkDone && this.link > 0 && this.running && !this.heroDead) {
        this._swingLinkDone = true;
        this.link--;
        linked = true;
        // 重击：跳劈吃连携时倍率再抬一截 —— 给"跳劈流"一个专属的连携用法
        var lkMult = LINK.dmgMult +
          ((opts && opts.move === 'dive') ? this.relicFx('diveLinkMult', 0) : 0);
        base *= lkMult;
        // 跳劈的连携不只加伤害，连落地冲击波一起放大 ——
        // 让"用它清一群"和"留着打单体盾反"变成两个真的不同的选择
        if (opts && opts.move === 'dive') this._diveLinked = true;
        this.showFloat(this.hero.x + rnd(-14, 14), this.hero.y - 118, '回响!', '#8ae8ff', 17);
        this.spark(this.hero.x, this.hero.y - 30, 0x8ae8ff);
        sfx('perfect');
        this.paintLinkMeter();
      }

      var crit = sharp || forceCrit || pass.forceCrit ||
        Math.random() < (this.hero.critRate / 100 + critEnv.rate);
      if (crit) base *= (this.hero.critDamage / 100) * critEnv.dmg;
      return { dmg: Math.max(1, Math.round(base)), crit: crit, chain: chainName || null, link: linked };
    }

    /**
     * 铁壁兵：这一下是不是砸在它的盾面上？
     * 用"敌人朝向 + 玩家站位"判定，并且**从上方来的攻击不算正面** ——
     * 跳劈正是设计好的解法，不能让盾把它也一并挡了（否则这只怪只剩"绕后"一条路）。
     */
    isFrontalHit(e) {
      var spr = e.sprite, h = this.hero;
      if (!spr || !h) return false;
      // ⚠️ 朝向必须读 e.faceDir，**不能读 sprite.flipX**：
      //    flipX 在受击硬直（spr.setFlipX(velocity.x < 0)）与冲锋期间会被**速度方向**覆写，
      //    挨了一下被打飞之后，它的"盾面"就跟着飞的方向翻过去了 —— 判定会整个错乱。
      //    faceDir 由 AI 单独维护，并带转身延迟（见 SHIELD_TURN）。
      var facing = e.faceDir || (spr.flipX ? -1 : 1);
      var playerSide = (h.x >= spr.x) ? 1 : -1;    // 玩家在它的哪一边
      if (facing !== playerSide) return false;     // 背后 → 不算正面
      if (h.y < spr.y - 34) return false;          // 明显高于它 = 跳劈 / 空中攻击，从上方压下来
      return true;
    }

    /** 敌人身上的护盾环（献祭者给的）—— 没有这个环，玩家看不出"该先打谁" */
    refreshEnemyShieldRing(e) {
      if (!e || !e.sprite || !e.sprite.active) return;
      if (e.shield > 0) {
        if (!e.shieldRing) {
          e.shieldRing = this.add.circle(0, 0, 24, 0x5fd0e0, 0.14).setDepth(10);
          e.shieldRing.setStrokeStyle(2, 0x5fd0e0, 0.75);
        }
        e.shieldRing.setVisible(true);
        e.shieldRing.setPosition(e.sprite.x, e.sprite.y - 26);
      } else if (e.shieldRing) {
        e.shieldRing.setVisible(false);
      }
    }

    /**
     * 前摇后段霸体（P2）
     * 简单难度 / 前 3 层不启用 —— 新手区保留"怪被压着打"的沙包感。
     */
    armorActive(e, now) {
      if (!e || e.state !== 'windup' || !e.windupDur) return false;
      if (this.difficulty === 'easy' || this.floor < RHYTHM.armorMinFloor) return false;
      var start = e.windupStart || 0;
      if (!start) return false;
      return (now - start) >= e.windupDur * (1 - RHYTHM.armorRatio);
    }

    damageEnemy(e, roll, fromThorn) {
      if (!e.alive) return;
      var dmg = roll.dmg;

      // 守点房：打中它就把仇恨拉过来 1.5s（§3.4）—— 这是"站在核心前面把怪拉住"的根据。
      // 放在最前面：连被盾牌格挡的那一下也算"你惹到它了"，否则铁壁兵会永远无视玩家。
      if (this.holdZone && this.holdZone.coreAlive && !fromThorn) {
        e._aggroHeroUntil = this.time.now + 1500;
      }

      // ===== 机制型敌人（B 项）=====
      // ① 铁壁兵：正面免疫 —— 站桩平砍打不动它，必须跳劈（从上方）或绕到背后。
      //    它针对的是"无脑按 J"这条最省事的路径，所以反馈必须**立刻且明确**：
      //    飘「盾牌格挡」+ 金属音 + 把玩家推开，而不是默默把伤害吞掉。
      if (e.def.shieldFront && !fromThorn && this.isFrontalHit(e)) {
        this.showFloat(e.sprite.x, e.sprite.y - 76, '盾牌格挡', '#9fd8ff', 17);
        this.spark(e.sprite.x, e.sprite.y - 32, 0x9fd8ff);
        if (!e._blockSfxAt || this.time.now - e._blockSfxAt > 300) {
          e._blockSfxAt = this.time.now;
          sfx('parry');
        }
        // 反弹：给玩家一点后退力，让"这条路走不通"变成身体能感觉到的反馈
        var kb = (this.hero.x >= e.sprite.x) ? 1 : -1;
        this.hero.setVelocityX(kb * 220);
        this.showFloat(this.hero.x, this.hero.y - 104, '绕后或用跳劈', '#8a9aa8', 13);
        return;
      }

      // ② 献祭者给的护盾：优先吸收（与玩家护盾同一套语义，读起来不用重新学）
      if (e.shield > 0) {
        var abs = Math.min(e.shield, dmg);
        e.shield -= abs;
        dmg -= abs;
        this.showFloat(e.sprite.x, e.sprite.y - 92, '护盾 -' + Math.round(abs), '#5fd0e0', 14);
        this.spark(e.sprite.x, e.sprite.y - 30, 0x5fd0e0);
        this.refreshEnemyShieldRing(e);
        if (dmg <= 0) {
          e.hurtUntil = Math.max(e.hurtUntil || 0, this.time.now + 80);
          return;   // 这一下全被护盾吃掉
        }
      }

      // 环境：闪避领域（敌人有几率闪开，只有直接命中会闪，反伤/环境伤害不闪）
      if (!fromThorn && this.envEnemyDodge() > 0 && Math.random() < this.envEnemyDodge()) {
        this.showFloat(e.sprite.x, e.sprite.y - 74, '闪开', '#b8a8ff', 16);
        return;
      }

      // 狂怒状态：伤害加成已经算进 rollPlayerDamage，这里只做"怒焰灼烧"的表现
      if (this.furyActive() && Math.random() < 0.5) {
        this.spark(e.sprite.x + rnd(-12, 12), e.sprite.y - rnd(10, 40), 0xffb347);
      }

      // 斩杀：线上限 25%，遗物可以抬（处决者 +10%，猎杀标记直接设成 50%）
      var exeLine = this.relicFx('executeSet', 0) > 0
        ? this.relicFx('executeSet', 0)
        : (0.25 + this.relicFx('executeBonus', 0));
      if (!fromThorn && this.hero.execute > 0 && (e.hp / e.maxHp) <= exeLine && Math.random() < (this.hero.execute / 100)) {
        dmg = Math.max(dmg, Math.ceil(e.hp));
        this.showFloat(e.sprite.x, e.sprite.y - 74, '斩杀!', '#ff5555', 24);
        sfx('execute');
        // 处决者：斩杀成功回连携 —— 把"收割残血"接进连携循环，
        // 于是"先攒点、再收割"成为一条能自己滚起来的打法
        var exLink = Math.round(this.relicFx('executeLink', 0));
        if (exLink > 0) this.addLink(exLink);
      }

      this._roomFirstHit = true;   // 被动：首击类技能（刺客 / 暗影）只在本房间的第一次命中生效
      e.hp -= dmg;
      // ===== P2：前摇后段霸体 =====
      // 霸体不等于免疫：伤害照吃，但**不进硬直、不被击退、不打断起手**。
      // 于是「看到起手 → 必须闪」这条反馈才真正成立。
      var armored = this.armorActive(e, this.time.now);
      if (!armored) {
        // 用 max 而不是直接赋值：普通命中硬直只有 150ms，而「被砸进地里」是 1300ms ——
        // 直接覆盖会把长硬直砍短，怪就一边压扁着一边站起来乱跑了
        e.hurtUntil = Math.max(e.hurtUntil || 0, this.time.now + 150);
      }
      // 破釜沉舟的吸血
      if (this.skillVampire && this.time.now < (this.skillPowerUntil || 0)) {
        this.healHero(Math.max(1, Math.round(dmg * this.skillVampire)), false);
      }
      // 陷在地里的怪不该被打飞：它已经钉在土里了
      if (!armored && !e.buried) {
        var dir = (e.sprite.x >= this.hero.x) ? 1 : -1;
        e.sprite.setVelocity(dir * 180, -130);
      }
      if (armored) {
        if (!e._armorFloatAt || this.time.now - e._armorFloatAt > 600) {
          e._armorFloatAt = this.time.now;
          this.showFloat(e.sprite.x, e.sprite.y - 84, '霸体', '#9fd8ff', 14);
        }
      } else {
        e.sprite.play(this.mobAnimKey(e, 'hurt'), true);
      }

      this.showFloat(e.sprite.x, e.sprite.y - 56, '-' + fmt(dmg), roll.crit ? '#ffd700' : '#ffffff', roll.crit ? 23 : 17);
      this.spark(e.sprite.x, e.sprite.y - 30, roll.crit ? 0xffd700 : 0xff8a7a);
      if (roll.crit && state.settings.screenShake2D !== false) this.cameras.main.shake(90, 0.006);

      var vampLv = this.hero.vampire + this.relicFx('vampireExtra', 0);   // 遗物：血之饥渴
      // 血之饥渴：生命 ≤50% 时吸血翻倍 —— 与破釜沉舟同向，凑成"越残越能打"的一整套
      if (vampLv > 0 && this.relicFx('vampLowHpMult', 0) > 0 &&
          this.hero.hp <= this.hero.maxHp * 0.5) vampLv *= 2;
      if (vampLv > 0) {
        this.healHero(Math.max(1, Math.round(dmg * Math.min(0.5, vampLv * 0.05))), false);
        sfx('vampire');
      }

      this.comboCount++;
      this.comboTimer = 900;
      if (this.comboCount >= 3) {
        this.comboText.setText(this.comboCount + ' 连击').setAlpha(1);
        if (this.comboCount % 3 === 0) sfx('combo');
      }

      // 敌人自带荆棘反伤
      if (e.def.thorn && !fromThorn) { sfx('thorn'); this.damageHero(e.def.thorn, e, true); }

      // 狂怒：命中攒怒（按层级，连招命中额外加成）
      if (!fromThorn) this.furyOnHit(e, roll.chain ? { name: roll.chain } : null);

      // ===== 环境 / 诅咒：挂在「我打中敌人」这个动作上的效果 =====
      if (!fromThorn) {
        // 吸血诅咒：所有单位攻击时回血 → 我也回
        if (this.hasEnv('吸血诅咒')) {
          this.healHero(Math.max(1, Math.round(this.hero.maxHp * this.envValue('lifesteal'))), false);
        }
        // 荆棘之地：每次攻击时受到反弹（无视护盾）
        if (this.hasEnv('荆棘之地')) {
          var rb = Math.max(1, Math.round(this.hero.hp * this.envValue('rebound')));
          this.hero.hp = Math.max(1, this.hero.hp - rb);
          this.showFloat(this.hero.x, this.hero.y - 78, '荆棘 -' + rb, '#c8ff9a', 14);
        }
        // 吸血反噬：每次攻击后自身损失 1 点生命（无视护盾）
        if (this.hasCurse('吸血反噬')) {
          this.hero.hp = Math.max(1, this.hero.hp - 1);
          this.showFloat(this.hero.x, this.hero.y - 92, '反噬 -1', UI.danger, 13);
        }
        this.refreshHud();
        if (this.hero.hp <= 0) { this.heroDie(); return; }
      }

      if (e.hp <= 0) this.killEnemy(e);
      else sfx(roll.crit ? 'crit' : 'block');
    }

    /** 敌人脱离关卡：静默移除（不给金币），只保证房间能正常清空 */
    dropEnemy(e) {
      e.alive = false;
      e.hp = 0;
      if (e.throwFx) { e.throwFx.destroy(); e.throwFx = null; }
      if (e.sprite) { e.sprite.setVelocity(0, 0); e.sprite.destroy(); }
      if (e.meter) { this.destroyMeter(e.meter); e.meter = null; }
      if (e.nameLbl) e.nameLbl.destroy();
      if (e.atkLbl) e.atkLbl.destroy();
      if (e.shieldRing) { e.shieldRing.destroy(); e.shieldRing = null; }   // 献祭者的护盾环
      if (this.boss === e) {
        this.boss = null;
        this.setMeterVisible(this.bossMeter, false);
        this.bossName.setVisible(false);
        this.bossText.setVisible(false);
      }
      this.showFloat(this.hero.x, this.hero.y - 84, '敌人脱离战斗', UI.muted, 13);
      this.refreshHud();
      this.checkFloorClear();
    }

    killEnemy(e) {
      e.alive = false;
      e.hp = 0;
      // 被砸进地里时是压扁着的，死亡动画得先把缩放还原 —— 不然尸体会是扁的
      if (e.buried) {
        e.buried = false;
        if (e._buryBaseScaleY != null && e.sprite && e.sprite.active) {
          e.sprite.setScale(e.sprite.scaleX, e._buryBaseScaleY);
        }
      }
      e.sprite.setVelocity(0, -170);
      e.sprite.play(this.mobAnimKey(e, 'dead'), true);
      e.sprite.body.checkCollision.none = true;
      this.tweens.add({
        targets: e.sprite, alpha: 0, y: e.sprite.y + 12, duration: 620, delay: 140,
        onComplete: function () { e.sprite.setVisible(false); }
      });
      this.spark(e.sprite.x, e.sprite.y - 30, 0xffd76a);
      this.setMeterVisible(e.meter, false);
      if (e.nameLbl) e.nameLbl.setVisible(false);
      if (e.atkLbl) e.atkLbl.setVisible(false);
      if (e.shieldRing) { e.shieldRing.destroy(); e.shieldRing = null; }   // 献祭者的护盾环

      var gain = e.tier === 'boss' ? 12 : (e.tier === 'elite' ? 5 : 2);
      gain = Math.max(1, Math.round(gain * (1 + this.relicFx('goldGain', 0))));   // 遗物：金币获取
      if (this.hasCurse('贪婪')) gain = Math.max(1, Math.round(gain * 0.5));   // 诅咒：贪婪
      this.points += gain;
      this.kills = (this.kills || 0) + 1;
      this.showFloat(e.sprite.x, e.sprite.y - 84, '+' + gain, '#73f0b4', 16);
      sfx(e.tier === 'boss' ? 'victory' : 'coin');

      // 环境：死亡回响 —— 敌人死亡时扣玩家最大生命的百分比（无视护盾）
      if (this.hasEnv('死亡回响') && !this.heroDead) {
        var de = Math.max(1, Math.round(this.hero.maxHp * this.envValue('deathDamage')));
        this.hero.hp = Math.max(1, this.hero.hp - de);
        this.showFloat(this.hero.x, this.hero.y - 76, '死亡回响 -' + de, '#b8a8ff', 15);
      }
      // 狂怒：击杀攒怒
      this.addFury(FURY.gainKill);
      // 遗物：击杀回复（汲魂者一类）
      var healKill = this.relicFx('healKill', 0);
      // 汲魂者：残血时回得更多 —— 低血不再只是等死，而是"再杀一个就能撑住"
      if (healKill > 0 && this.relicFx('healKillLowHp', 0) > 0 &&
          this.hero.hp <= this.hero.maxHp * 0.5) healKill += this.relicFx('healKillLowHp', 0);
      if (healKill > 0 && !this.heroDead) this.healHero(healKill, true);

      if (this.boss === e) {
        this.boss = null;
        this.setMeterVisible(this.bossMeter, false);
        this.bossName.setVisible(false);
        this.bossText.setVisible(false);
      }
      this.applyKillPassive();
      this.refreshHud();
      this.checkFloorClear();
    }

    // ---------- 防御（举盾）----------
    /** 举盾是否成立：按住键 + 体力够 + 不在翻滚/跳劈/挥砍中 */
    updateGuard(dt, onGround) {
      var h = this.hero, now = this.time.now;
      var ti = this.touchInput;
      var held = (this.keys.guard.isDown || this.keys.guard2.isDown || ti.guardHeld) &&
        !this.dodging && !this.diving && !this.attacking && !this.isCharging && !this.heroDead;
      // v2.9 P1：空中按下是「加速下坠」，不是举盾 —— 两个状态必须互斥，
      // 否则玩家想落下一层时会莫名其妙举着盾飘下去。
      if (!onGround) held = false;

      if (held && h.stamina < GUARD.minStamina) {
        if (this.guarding && now > (this._guardWarnAt || 0)) {
          this._guardWarnAt = now + 900;
          this.showFloat(h.x, h.y - 84, '体力不足', UI.danger, 14);
          sfx('error');
        }
        held = false;
        this.guardBlocked = true;      // 锁住：体力回到 reopen 之前不许再举
      } else if (this.guardBlocked) {
        if (h.stamina >= GUARD.reopen) this.guardBlocked = false;
        else held = false;
      }
      if (held && !this.guarding) {          // 刚举起来
        this.guarding = true;
        this.guardStartAt = now;
        this.guardReadyAt = now + GUARD.raise;   // 抬盾要一点时间
        this.chainCount = 0;                     // 举盾打断连招
      } else if (!held && this.guarding) {
        this.lowerGuard();
      }
      if (!this.guarding) return 0;

      // 持续消耗体力（和闪避共用资源池 → 闪 or 挡 是个真抉择）
      h.stamina = Math.max(0, h.stamina - GUARD.drain * dt / 1000);
      this.staminaHoldUntil = now + STAMINA.delay;   // 举盾期间不回体力
      if (h.stamina <= 0) {
        this.lowerGuard();
        this.guardBlocked = true;
        this.showFloat(h.x, h.y - 84, '体力耗尽', UI.danger, 14);
        return 0;
      }
      // 盾光：成型后亮起，完美窗口内更亮
      var ready = now >= this.guardReadyAt;
      var inWindow = ready && (now - this.guardStartAt) <= GUARD.perfect;
      var flash = Math.max(0, 1 - (now - this.guardFlashAt) / 220);
      if (this.guardArc) {
        this.guardArc.setVisible(true);
        this.guardArc.setPosition(h.x + (h.flipX ? -20 : 20), h.y - 34);
        this.guardArc.setScale(h.flipX ? -1 : 1, 1);
        var a = (ready ? (inWindow ? 0.5 : 0.26) : 0.1) + flash * 0.6;
        this.guardArc.setFillStyle(flash > 0.05 ? 0xffd76a : (inWindow ? 0xffe08a : 0x8ad8ff), Math.min(0.7, a));
      }
      if (!ready) return GUARD.front;        // 还在抬盾：不减免
      return inWindow ? -1 : GUARD.front;    // -1 = 完美格挡窗口
    }

    lowerGuard() {
      if (!this.guarding) return;
      this.guarding = false;
      this.guardReadyAt = 0;
      if (this.guardArc) this.guardArc.setVisible(false);
    }

    /**
     * 完美格挡：完全免伤 + 顶开攻击者 + 护盾 + 盾反窗口
     * 数字沿用文字模式的「防御 +3 护盾」，守护者的「坚壁防御」再 +2
     */
    onPerfectBlock(source) {
      var now = this.time.now, h = this.hero;
      this.guardFlashAt = now;
      this.blockCount = (this.blockCount || 0) + 1;
      this.counterUntil = now + GUARD.counter;
      this.addFury(FURY.gainPerfect);          // 完美格挡攒怒（技巧奖励）
      this.addLink(1);                         // 完美格挡攒连携（技巧 → 可消费的资源）
      this.guarding = true;                    // 格挡后保持举盾，等玩家决定是否盾反
      this.guardStartAt = now - GUARD.perfect; // 窗口已过：继续举着只减伤，不再连出完美
      this.showFloat(h.x, h.y - 96, '完美格挡!', '#ffd76a', 22);
      // 护盾共鸣：完美格挡额外给盾（与"任何来源 +2"分开算，见 RELIC_FX 的说明）
      this.addShield(GUARD.shieldGain + Math.round(this.relicFx('perfectShield', 0)), null);
      if (this.skillId === 'guardian') this.addShield(GUARD.guardianBonus, '坚壁防御');
      sfx('parry');
      this.cameras.main.flash(80, 255, 240, 200);
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(110, 0.006);

      // 反弹：把攻击者顶住并推开
      if (source && source.alive && source.sprite) {
        source.hurtUntil = now + GUARD.stun;
        var dir = (source.sprite.x >= h.x) ? 1 : -1;
        source.sprite.setVelocity(dir * 240, -130);
        this.showFloat(source.sprite.x, source.sprite.y - 84, '被挡开', '#ffd76a', 14);
      }
      // 正面的弹幕一并挡开（与完美闪避的「化解弹幕」对称）
      this.clearNearbyProjectiles(h.x, h.y, 130);
      var fx = this.add.circle(h.x + (h.flipX ? -22 : 22), h.y - 34, 14, 0xffd76a, 0.3).setDepth(11);
      fx.setStrokeStyle(3, 0xffd76a, 0.95);
      this.tweens.add({ targets: fx, radius: 64, alpha: 0, duration: 240, onComplete: function () { fx.destroy(); } });
      this.spark(h.x + (h.flipX ? -22 : 22), h.y - 34, 0xffd76a);
      this.refreshHud();
      return 'blocked';
    }

    // ---------- 连招 ----------
    /** 远程连招定义：RANGED_CHAIN 的数值 + 本英雄的招式名 */
    rangedChain(rg, key) {
      var c = RANGED_CHAIN[key];
      if (!c) return null;
      var out = {};
      for (var k in c) out[k] = c[k];
      out.name = rangedChainName(rg, key, c.name);
      out.ranged = key;
      return out;
    }

    /**
     * 攻击时先判定「接的是哪一招」，优先级：盾反 > 突进斩 > 落地斩 > 三连斩
     * 返回 null 表示这一下就是普通攻击。
     * 远程英雄（游侠 / 法师 / 贤者）走**完全相同**的判定与窗口，
     * 只是每一招换成了远程版本（反击箭 / 连珠箭 / 踏地箭 / 三连散）。
     */
    pickChain(now) {
      var rg = this.heroRanged();
      if (now < this.counterUntil) {
        this.counterUntil = 0; this.chainCount = 0; this.chainUntil = 0;
        return rg ? this.rangedChain(rg, 'counter')
          : { name: '盾反', mult: GUARD.counterMult, range: 1.15, lunge: GUARD.counterLunge, forceCrit: true, color: '#ffd76a' };
      }
      if (now < this.dodgeCounterUntil) {
        this.dodgeCounterUntil = 0; this.chainCount = 0; this.chainUntil = 0;
        return rg ? this.rangedChain(rg, 'roll')
          : { name: '突进斩', mult: CHAIN.dodgeMult, range: 1.2, lunge: CHAIN.dodgeLunge, color: '#8ad8ff' };
      }
      if (now < this.diveCounterUntil) {
        this.diveCounterUntil = 0; this.chainCount = 0; this.chainUntil = 0;
        return rg ? this.rangedChain(rg, 'land')
          : { name: '落地斩', mult: CHAIN.diveMult, range: 1.35, splash: true, color: '#ff9a5a' };
      }
      // 三连：窗口内连着按，第 3 下变招（近战横扫 / 远程三连散）
      if (now < this.chainUntil) this.chainCount = Math.min(this.chainCount + 1, CHAIN.sweepAt);
      else this.chainCount = 1;
      this.chainUntil = now + CHAIN.window;
      if (this.chainCount >= CHAIN.sweepAt) {
        this.chainCount = 0;
        return rg ? this.rangedChain(rg, 'triple')
          : { name: '横扫', mult: CHAIN.sweepMult, range: CHAIN.sweepRange, color: UI.gold };
      }
      return null;
    }

    /** 连招窗口开着时在主角头顶提示「接 J」 */
    updateChainHint() {
      var t = this.chainHint;
      if (!t) return;
      var now = this.time.now, label = '', color = UI.gold;
      var rg = this.heroRanged();
      var nm = function (key, fallback) { return rg ? rangedChainName(rg, key, fallback) : fallback; };
      if (now < this.counterUntil) { label = '接 J · ' + nm('counter', '盾反'); color = RANGED_CHAIN.counter.color; }
      else if (now < this.dodgeCounterUntil) { label = '接 J · ' + nm('roll', '突进斩'); color = RANGED_CHAIN.roll.color; }
      else if (now < this.diveCounterUntil) { label = '接 J · ' + nm('land', '落地斩'); color = RANGED_CHAIN.land.color; }
      else if (now < this.chainUntil && this.chainCount > 0) {
        label = '接 J · ' + (rg ? '连射 ' : '连斩 ') + this.chainCount + '/2';
        color = '#9fe0c0';
      }
      var show = !!label && this.running && !this.heroDead;
      if (t.visible !== show) t.setVisible(show);
      if (!show) return;
      t.setText(label).setColor(color);
      t.setPosition(this.hero.x, this.hero.y - 112);
    }

    /** 连招命中的表现：招式名 + 一圈对应色的冲击环 */
    chainFeedback(chain) {
      if (!chain) return;
      var h = this.hero;
      this.showFloat(h.x, h.y - 104, chain.name, chain.color, 20);
      var ring = this.add.circle(h.x, h.y - 34, 12, 0xffffff, 0.22).setDepth(11);
      var col = parseInt(chain.color.replace('#', ''), 16);
      ring.setFillStyle(col, 0.22); ring.setStrokeStyle(3, col, 0.9);
      this.tweens.add({ targets: ring, radius: 54, alpha: 0, duration: 240, onComplete: function () { ring.destroy(); } });
      sfx('crit');
    }

    /** 落地斩的小范围冲击（只补一次范围伤害） */
    chainSplash(chain) {
      if (!chain || !chain.splash) return;
      var h = this.hero, self = this;
      var radius = CHAIN.diveSplashR;
      var ring = this.add.circle(h.x, h.y - 8, 16, 0xff9a5a, 0.24).setDepth(11);
      ring.setStrokeStyle(3, 0xff9a5a, 0.9);
      this.tweens.add({ targets: ring, radius: radius, alpha: 0, duration: 260, onComplete: function () { ring.destroy(); } });
      this.enemies.forEach(function (e, idx) {
        if (!e.alive || (self.attackHits && self.attackHits[idx])) return;
        if (Math.abs(e.sprite.x - h.x) > radius || Math.abs(e.sprite.y - h.y) > radius * 0.9) return;
        if (self.attackHits) self.attackHits[idx] = true;
        self.damageEnemy(e, self.rollPlayerDamage(CHAIN.diveMult * CHAIN.diveSplash, false, null, { noLink: true }), false);
      });
    }

    // ============================================================
    //  诅咒与环境效果（实时化）
    //  名字与经典模式完全一致，落点写在 战斗2D 的各个结算口上。
    //  「每回合」类统一走腐化脉冲；会永久削人的两类改成「清空房间后恢复」。
    // ============================================================
    /** 宿主传入当前诅咒与环境（开新局 / 深入下一层时调用） */
    setCursesAndEnv(curses, env) {
      this.curses = (curses || []).filter(function (n) { return !!curseByName(n); });
      this.worldEnv = (env && env.name && envByName(env.name)) ? env : null;
      this.updateCurseHud();
      return { curses: this.curses.slice(), env: this.worldEnv ? this.worldEnv.name : null };
    }

    hasCurse(name) { return !!(this.curses && this.curses.indexOf(name) >= 0); }
    envValue(key, fallback) {
      var v = this.worldEnv && this.worldEnv.values ? this.worldEnv.values[key] : undefined;
      return (typeof v === 'number') ? v : (fallback || 0);
    }
    hasEnv(name) { return !!(this.worldEnv && this.worldEnv.name === name); }

    /** 环境对伤害的整体缩放（虚弱之雾 / 能量涌动 / 厄运 / 虚弱诅咒） */
    envPlayerDamageMult() {
      var m = 1;
      if (this.hasEnv('虚弱之雾')) m *= (1 - this.envValue('attackReduction'));
      if (this.hasEnv('能量涌动')) m *= (1 + this.envValue('attackBonus'));
      return Math.max(0.1, m);
    }
    /** 受到的伤害缩放（厄运 + 易伤诅咒 + 荆棘诅咒） */
    damageTakenMult() {
      var m = 1;
      if (this.hasEnv('厄运')) m *= (1 + this.envValue('extraDamage'));
      return m;
    }
    damageTakenFlat() {
      var f = 0;
      if (this.hasCurse('易伤')) f += 2;
      if (this.hasCurse('荆棘诅咒')) f += 1;
      return f;
    }
    /** 治疗缩放（治疗抑制环境 + 祭坛/技能；药水另有「药水衰减」诅咒） */
    healMult(isPotion) {
      var m = 1;
      if (this.hasEnv('治疗抑制')) m *= (1 - this.envValue('healReduction'));
      if (isPotion && this.hasCurse('药水衰减')) m *= 0.5;
      return clamp(m, 0, 1);
    }
    /** 敌人的暴击与闪避（幸运 / 暴击共振 / 闪避领域给的是「所有单位」） */
    envEnemyCrit() {
      var rate = this.hasEnv('幸运') ? this.envValue('luckyBonus') : 0;
      if (rate <= 0 || Math.random() >= rate) return 1;
      var mult = 1.5 + (this.hasEnv('暴击共振') ? this.envValue('critDamageBonus') : 0);
      return mult;
    }
    envEnemyDodge() { return this.hasEnv('闪避领域') ? this.envValue('dodgeBonus') : 0; }
    /** 玩家暴击率 / 暴击伤害的环境加成（幸运 / 暴击共振） */
    envPlayerCrit() {
      var rate = this.hasEnv('幸运') ? this.envValue('luckyBonus') : 0;
      var dmg = 1 + (this.hasEnv('暴击共振') ? this.envValue('critDamageBonus') : 0);
      return { rate: rate, dmg: dmg };
    }

    /**
     * 腐化脉冲：每 5 秒结算一次所有「每回合」类效果
     * 顺序固定（先扣护盾再扣血），并给一次可见的脉冲提示 —— 玩家能预期到它
     */
    applyPulse() {
      var h = this.hero, msgs = [];
      if (!this.running || this.heroDead) return;
      var eco = 0x9a8ef0;

      // --- 诅咒 ---
      var shieldLoss = 0;
      if (this.hasCurse('脆弱')) shieldLoss += 2;
      if (this.hasCurse('护甲腐蚀')) shieldLoss += 1;
      if (shieldLoss > 0 && h.shield > 0) {
        var used = Math.min(h.shield, shieldLoss);
        h.shield -= used;
        this.showFloat(h.x, h.y - 84, '诅咒 · 护盾 -' + used, UI.danger, 15);
        msgs.push('护盾 -' + used);
      }
      if (this.hasCurse('生命流失')) {
        h.hp = Math.max(1, h.hp - 1);
        this.showFloat(h.x, h.y - 66, '诅咒 · 生命 -1', UI.danger, 15);
        msgs.push('生命 -1');
      }
      if (this.hasCurse('虚弱')) {
        h.attack = Math.max(1, h.attack - 1);
        msgs.push('攻击 -1');
      }
      if (this.hasCurse('迟钝')) {
        h.dodge = Math.max(0, h.dodge - 5);
        msgs.push('闪避 -5%');
      }

      // --- 环境：护盾崩坏 / 缓慢凋零 / 时间扭曲 / 能量涌动自伤 / 能量导管 ---
      if (this.hasEnv('护盾崩坏') && h.shield > 0) {
        var sl = Math.max(1, Math.round(h.shield * this.envValue('shieldLoss')));
        h.shield = Math.max(0, h.shield - sl);
        this.showFloat(h.x, h.y - 90, '环境 · 护盾 -' + sl, '#b8a8ff', 14);
        msgs.push('环境 · 护盾 -' + sl);
      }
      if (this.hasEnv('能量涌动')) {
        var sd = Math.max(1, Math.round(h.maxHp * this.envValue('selfDamage')));
        h.hp = Math.max(1, h.hp - sd);
        this.showFloat(h.x, h.y - 72, '能量涌动 -' + sd, '#ffb060', 14);
        msgs.push('环境 · 生命 -' + sd);
      }
      if (this.hasEnv('能量导管')) {
        var sg = Math.max(1, Math.round(h.maxHp * this.envValue('shieldGain')));
        this.addShield(sg, null);
        msgs.push('环境 · 护盾 +' + sg);
      }
      if (this.hasEnv('缓慢凋零')) {
        var dec = Math.max(1, Math.round(h.maxHp * this.envValue('decay')));
        h.maxHp = Math.max(6, h.maxHp - dec);
        h.hp = Math.min(h.hp, h.maxHp);
        this.showFloat(h.x, h.y - 78, '凋零 · 生命上限 -' + dec, '#b8a8ff', 14);
        msgs.push('环境 · 生命上限 -' + dec);
      }
      if (this.hasEnv('时间扭曲')) {
        var tw = Math.max(1, Math.round(h.hp * this.envValue('timeLoss')));
        h.hp = Math.max(1, h.hp - tw);
        this.showFloat(h.x, h.y - 84, '时间扭曲 -' + tw, '#b8a8ff', 14);
        msgs.push('环境 · 生命 -' + tw);
      }
      // 敌人也吃脉冲类环境（缓慢凋零 / 时间扭曲）
      var self = this;
      this.enemies.forEach(function (e) {
        if (!e.alive) return;
        if (self.hasEnv('缓慢凋零')) {
          var ed = Math.max(1, Math.round(e.maxHp * self.envValue('decay')));
          e.maxHp = Math.max(1, e.maxHp - ed);
          e.hp = Math.min(e.hp, e.maxHp);
          if (e.hp <= 0) self.damageEnemy(e, { dmg: 0, crit: false }, false);
        }
        if (self.hasEnv('时间扭曲')) {
          var et = Math.max(1, Math.round(e.hp * self.envValue('timeLoss')));
          e.hp = Math.max(1, e.hp - et);
        }
      });

      // 脉冲表现：一圈紫环 + 轻微震屏 + **屏幕中间的横幅**（玩家能预期到这一下，也能看清扣了什么）
      var ring = this.add.circle(h.x, h.y - 30, 16, eco, 0.22).setDepth(11);
      ring.setStrokeStyle(3, eco, 0.85);
      this.tweens.add({ targets: ring, radius: 96, alpha: 0, duration: 380, onComplete: function () { ring.destroy(); } });
      sfx('curse');
      // HUD 上的诅咒胶囊同步闪一下：屏幕中间有横幅、右上角有落点，不再是「只有一圈光」
      this.curseFlashUntil = this.time.now + ENV.flash;
      // 以前这条只在「生命流失 / 虚弱 / 迟钝」命中时才弹，其余情况（脆弱、护甲腐蚀、纯环境类…）
      // 屏幕中间什么都没有，只剩光圈 —— 现在无论扣了什么都会弹，并逐条写清
      this.showCenter('腐化脉冲' + (msgs.length ? ' · ' + msgs.join(' / ') : ''), '#c79aff');
      this.refreshHud();
      if (h.hp <= 0) this.heroDie();
    }

    /**
     * 当前环境效果在这套实时战斗里**实际是什么**
     * 用 WORLD_ENVS 的 rt 文案（"在 2D 里变成什么"），把 {值} 换成宿主给的真实数值。
     * 例：厄运 → 「双方受到伤害 ×(1+21.0%)」；荆棘之地 → 「每次命中敌人，自己也掉 3.2% 当前生命…」
     */
    envSummaryText() {
      var e = this.worldEnv;
      if (!e) return '';
      var def = envByName(e.name);
      var tpl = def ? (def.rt || '') : (e.description || '');
      var vals = e.values || {};
      var keys = Object.keys(vals);
      return String(tpl).replace(/\{(\w+)\}/g, function (m, key) {
        var v = vals[key];
        // 兼容 {value}：池子里只有唯一一个数值字段时直接取它（与 formatEnvDescription 同一套规则）
        if ((v === undefined || v === null) && key === 'value' && keys.length === 1) v = vals[keys[0]];
        if (typeof v !== 'number') return m;
        if (Math.abs(v) < 1) return (v * 100).toFixed(1) + '%';
        return String(Math.round(v * 10) / 10);
      });
    }

    /**
     * 右上角信息胶囊的底板（环境 / 诅咒共用同一套语言）
     * 圆角 + 1px 语义色描边 + 顶部内高光 + 左侧菱形标记；flash 让换内容时闪一下。
     */
    paintInfoBox(g, mk, pw, h, color, flash) {
      if (!g || !mk) return;
      g.clear();
      g.fillStyle(0x140f26, 0.62);
      g.fillRoundedRect(-pw, 0, pw, h, 12);
      g.fillStyle(0xffffff, 0.03);
      g.fillRoundedRect(-pw + 1, 1, pw - 2, Math.max(2, h * 0.2), 11);
      g.lineStyle(1, color, 0.20 + 0.55 * flash);
      g.strokeRoundedRect(-pw, 0, pw, h, 12);
      mk.clear();
      var mx = -pw + ENV.padX + 3, my = ENV.padY + 5;
      mk.fillStyle(color, 0.75 + 0.25 * flash);
      mk.beginPath();
      mk.moveTo(mx, my - 5); mk.lineTo(mx + 5, my); mk.lineTo(mx, my + 5); mk.lineTo(mx - 5, my);
      mk.closePath(); mk.fillPath();
    }

    /** 环境面板底板（紫色） */
    paintEnvPanelBg(h, flash) {
      this.paintInfoBox(this.envBg, this.envMark, this._envPanelW || ENV.panelW, h, 0xb8a8ff, flash);
      this._envBgFlash = flash;
    }

    /** 诅咒胶囊底板（红色） */
    paintCurseBg(h, flash) {
      this.paintInfoBox(this.curseBg, this.curseMark, this._envPanelW || ENV.panelW, h, 0xe86878, flash);
      this._curseBgFlash = flash;
    }

    /**
     * 右上角整列的排版：**诅咒 → 环境 → 腐化脉冲倒计时**，紧贴在「房间 · 已探索」下方
     * 两块都是同一套胶囊（菱形标记 + 小标签 + 内容），高度各自按内容现算，下面的依次让位。
     */
    layoutEnvHud(sizeW) {
      if (!this.envPanel || !this.cursePanel) return;
      var W = sizeW || this.scale.width;
      if (W < 40) return;
      var k = clamp(Math.min(W / 900, 1), 0.68, 1);
      var pw = Math.round(Math.min(ENV.panelW * Math.max(0.9, k), Math.max(180, W - 96)));
      this._envPanelW = pw;

      var padX = ENV.padX, padY = ENV.padY, textX = -pw + padX + 12;
      var wrapW = Math.max(80, pw - padX - 12 - padX);

      // ===== 环境面板内容行 =====
      var rowLab = padY + 1;              // 「本房间环境」+ 数值
      var rowName = rowLab + 15;          // 环境名（大字号）
      var rowEff = rowName + 23;          // 它在实时里实际是什么
      this.envLabel.setPosition(textX, rowLab);
      this.envName.setPosition(textX, rowName);
      this.envValueText.setPosition(-padX, rowLab + 1);
      this.envEffect.setPosition(textX, rowEff);
      this.envEffect.setWordWrapWidth(wrapW, true);
      var effH = this.envEffect.text ? this.envEffect.height : 0;
      var envH = rowEff + effH + padY - (effH ? 0 : 6);

      // ===== 诅咒胶囊：标签一行 + 名称列表若干行（先定宽再读高，换行会改 height）=====
      this.curseLabel.setPosition(textX, padY + 1);
      this.curseText.setPosition(textX, padY + 16);
      this.curseText.setWordWrapWidth(wrapW, true);
      var curseH = padY + 16 + this.curseText.height + padY - 4;

      // ===== 从「房间 · 已探索」下面开始往下堆 =====
      var top = ((this.roomText ? this.roomText.y : 86) + ENV.gapRoom);
      // 层主血条压在顶部中间（y≈100）：窄屏时这一列会钻到它底下，整体下移一行让开
      var bm = this.bossMeter;
      if (this.boss && this.boss.alive && bm && bm.w && (W - 24 - pw) < (bm.x + bm.w + 8) && top < ENV.bossClear) {
        top = ENV.bossClear;
      }
      // 窄屏：左右两列撞上时，整列下移到左侧 HUD 之下（下限由 layoutHudButtons 算出）
      if (this._envHudMinTop > top) top = this._envHudMinTop;

      var curseFlash = Math.max(0, Math.min(1, ((this.curseFlashUntil || 0) - this.time.now) / ENV.flash));
      this.cursePanel.setPosition(W - 24, top);
      this._cursePanelH = curseH;
      this._curseTop = top;
      this.paintCurseBg(curseH, curseFlash);

      // 环境面板紧跟在诅咒胶囊下方（诅咒隐藏时它就顶到第一位）
      var envTop = top + (this.cursePanel.visible ? curseH + ENV.gapCurse : 0);
      this.envPanel.setPosition(W - 24, envTop);
      this._envPanelH = envH;
      this._envPanelTop = envTop;
      var envFlash = Math.max(0, Math.min(1, ((this.envFlashUntil || 0) - this.time.now) / ENV.flash));
      this.paintEnvPanelBg(envH, envFlash);

      // 脉冲倒计时垫底
      if (this.pulseText) {
        var bottom = (this.envPanel.visible ? (envTop + envH) : envTop);
        this.pulseText.setPosition(W - 24, bottom + ENV.gapCurse);
      }
    }

    /** 换房间换到新环境：面板整体闪一下再落位（一次有节制的提示，不抢画面中心） */
    flashEnvPanel() {
      if (!this.envPanel) return;
      this.tweens.killTweensOf(this.envPanel);
      this.envPanel.setAlpha(0.3);
      this.tweens.add({ targets: this.envPanel, alpha: 1, duration: 260, ease: 'Cubic.easeOut' });
      sfx('env');
    }

    /** 诅咒胶囊 + 环境面板（HUD 右上角「房间 · 已探索」下方，诅咒在上、环境在下） */
    updateCurseHud() {
      if (!this.cursePanel || !this.envPanel) return;
      var hasEnv = !!this.worldEnv;
      var hasCurse = !!(this.curses && this.curses.length);

      // --- 环境面板 ---
      if (this.envPanel.visible !== hasEnv) this.envPanel.setVisible(hasEnv);
      if (hasEnv) {
        this.envName.setText(this.worldEnv.name);
        this.envValueText.setText(this.worldEnv.displayValue || '');
        var sum = this.envSummaryText();
        if (this.envEffect.text !== sum) this.envEffect.setText(sum);
        // 环境换了（换了房间）：闪一下，让「这次是什么」有机会被看见
        if (this._envShownName !== this.worldEnv.name) {
          var isChange = !!this._envShownName;
          this._envShownName = this.worldEnv.name;
          this.envFlashUntil = this.time.now + ENV.flash;
          if (isChange) this.flashEnvPanel();
        }
      } else {
        this._envShownName = null;
      }

      // --- 诅咒胶囊 ---
      if (this.cursePanel.visible !== hasCurse) this.cursePanel.setVisible(hasCurse);
      if (hasCurse) this.curseText.setText(this.curses.join(' · '));

      this.layoutEnvHud();
      this.updatePulseHud();
    }

    /** 脉冲倒计时（垫在最下面，最后 1.5 秒转红）+ 环境 / 诅咒胶囊高亮的逐帧衰减 */
    updatePulseHud() {
      // 高亮衰减：只在还亮着的时候重画，避免每帧刷 Graphics
      if ((this.envFlashUntil || 0) > 0) {
        var eLeft = ((this.envFlashUntil || 0) - this.time.now) / ENV.flash;
        var eFlash = eLeft > 1 ? 1 : (eLeft > 0 ? eLeft : 0);
        if (this.envPanel.visible && Math.abs((this._envBgFlash || 0) - eFlash) > 0.02) {
          this.paintEnvPanelBg(this._envPanelH || 30, eFlash);
        }
        if (eFlash <= 0) this.envFlashUntil = 0;
      }
      if ((this.curseFlashUntil || 0) > 0) {
        var cLeft = ((this.curseFlashUntil || 0) - this.time.now) / ENV.flash;
        var cFlash = cLeft > 1 ? 1 : (cLeft > 0 ? cLeft : 0);
        if (this.cursePanel.visible && Math.abs((this._curseBgFlash || 0) - cFlash) > 0.02) {
          this.paintCurseBg(this._cursePanelH || 40, cFlash);
        }
        if (cFlash <= 0) this.curseFlashUntil = 0;
      }
      if (!this.pulseText) return;
      var on = this.running && !this.heroDead && ((this.curses && this.curses.length) || this.worldEnv);
      if (this.pulseText.visible !== !!on) this.pulseText.setVisible(!!on);
      if (!on) return;
      var leftMs = Math.max(0, this.pulseAt - this.time.now);
      var urgent = leftMs <= this.pulseWarn();
      // 同时显示「当前节拍」：让「压力在变快」这件事被玩家看见（规划 §3.12）
      var iv = this.pulseInterval();
      var txt = '腐化脉冲 ' + (leftMs / 1000).toFixed(1) + 's · 节拍 ' + (iv / 1000).toFixed(1) + 's';
      if (this.pulseText.text !== txt) this.pulseText.setText(txt);
      this.pulseText.setColor(urgent ? UI.danger : UI.muted);
      this.pulseText.setAlpha(urgent ? (0.6 + 0.4 * Math.abs(Math.sin(this.time.now / 160))) : 1);
    }

    // ---------- 狂怒（实时重做）----------
    /** 攒怒：clamp 到上限；满了只提示一次，不自动爆发（见 tryFury） */
    addFury(n, tag) {
      if (!this.running || this.heroDead || n <= 0) return 0;
      if (this.furyActive()) return 0;                 // 狂怒期间不再攒（避免自己喂自己）
      // 狂热之血：低血时攒得更快 —— 残血反打的手感支撑（血怒流的第三条腿）
      var lowBoost = this.relicFx('furyLowHp', 0);
      if (lowBoost > 0 && this.hero.hp <= this.hero.maxHp * 0.5) n *= 1 + lowBoost;
      var before = this.fury;
      this.fury = Math.min(FURY.max, this.fury + n);
      var gained = Math.round(this.fury - before);
      if (gained > 0) {
        if (this.fury >= FURY.max && !this._furyFull) {
          this._furyFull = true;
          this.showFloat(this.hero.x, this.hero.y - 118, '狂怒已满 · 按 R 爆发', '#ffd76a', 16);
          sfx('levelUp');
        }
        if (tag && gained >= 3) this.showFloat(this.hero.x + rnd(-16, 16), this.hero.y - 104, '+' + gained + ' 怒', '#ffb347', 12);
      }
      this.paintFuryMeter();
      return gained;
    }

    /* ---------- 连携（技巧资源；设计说明见文件上方的 LINK）----------
       产出只有一条路（完美判定），消费只有一条路（主动攻击）。
       中间那句"要不要现在就花掉"，就是这套系统想加进战斗的那个决定。 */
    /** 攒连携：完美闪避 / 完美格挡各 +1，上限由遗物可抬 */
    addLink(n) {
      if (!this.running || this.heroDead) return 0;
      var cap = Math.max(1, LINK.max);
      var before = this.link || 0;
      this.link = Math.min(cap, before + (n || 1));
      var gained = this.link - before;
      if (gained > 0) {
        this.showFloat(this.hero.x, this.hero.y - 140, '连携 +' + gained, '#8ae8ff', 16);
        this.paintLinkMeter();
      }
      return gained;
    }

    /** 挨打即断：这是"攒着不用"的代价，也是这套系统唯一的惩罚 */
    breakLink() {
      if (!this.link) return 0;
      // 不屈意志：挨打只掉 1 点、不清零 —— 连携流的"安全带"。
      // 它的意义是让"攒到 5 点再一口气放"这种打法真的敢去打。
      if (this.hasPerk('unbroken')) {
        this.link -= 1;
        this.showFloat(this.hero.x, this.hero.y - 140, '连携 −1', '#ff9a5a', 15);
        this.paintLinkMeter();
        return 1;
      }
      var lost = this.link;
      this.link = 0;
      this.showFloat(this.hero.x, this.hero.y - 140, '连携中断 −' + lost, '#ff6b6b', 16);
      this.paintLinkMeter();
      return lost;
    }

    furyActive() { return this.furyUntil > this.time.now; }
    furyLeft() { return Math.max(0, this.furyUntil - this.time.now); }

    /** 按 R（或触摸「狂怒」钮）：满怒即可进入狂怒状态 */
    tryFury() {
      var now = this.time.now;
      if (!this.running || this.heroDead) return false;
      if (this.mapOpen || this.shopOpen || this.codexOpen || this.deathOpen || this.confirmOpen || this._viewPaused) return false;
      if (this.furyActive()) { this.showFloat(this.hero.x, this.hero.y - 84, '狂怒进行中', UI.gold, 14); return false; }
      if (this.fury < FURY.max) {
        this.showFloat(this.hero.x, this.hero.y - 84, '狂怒值未满 ' + Math.floor(this.fury) + '/' + FURY.max, UI.muted, 14);
        sfx('error');
        return false;
      }
      this.enterFury();
      return true;
    }

    /** 进入狂怒状态：清空狂怒值，换来 6 秒全面强化（唯一的入口是 tryFury —— 手动） */
    enterFury() {
      var now = this.time.now, h = this.hero;
      this.fury = 0;
      this._furyFull = false;
      this.furyUntil = now + FURY.duration;
      this.showCenter('狂怒爆发！', '#ffd76a');
      this.showFloat(h.x, h.y - 96, '狂怒 · 攻速 +35% 伤害 +50%', '#ffd76a', 15);
      sfx('skill');
      sfx('battleStart');
      this.cameras.main.flash(120, 255, 180, 90);
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(160, 0.008);
      var ring = this.add.circle(h.x, h.y - 30, 18, 0xffd76a, 0.3).setDepth(11);
      ring.setStrokeStyle(4, 0xffd76a, 0.95);
      this.tweens.add({ targets: ring, radius: 150, alpha: 0, duration: 380, onComplete: function () { ring.destroy(); } });
      this.spark(h.x, h.y - 30, 0xffd76a);
      this.paintFuryMeter();
      this.refreshHud();
    }

    /** 狂怒状态的逐帧表现与结束判定 */
    updateFury(dt) {
      var h = this.hero, now = this.time.now;
      var on = this.furyActive();
      if (on) {
        if (this._furyWasOn !== true) { this._furyWasOn = true; }
        // 金色怒焰：持续从脚边升起火星 + 身周金环
        if (Math.random() < 0.55) this.spark(h.x + rnd(-18, 18), h.y - rnd(0, 46), 0xffb347);
        if (this.furyRing) {
          this.furyRing.setVisible(true);
          this.furyRing.setPosition(h.x, h.y - 28);
          var pulse = 0.22 + 0.12 * Math.sin(now / 110);
          this.furyRing.setRadius(26 + 3 * Math.sin(now / 140));
          this.furyRing.setFillStyle(0xffd76a, pulse);
        }
      } else {
        if (this._furyWasOn === true) {
          this._furyWasOn = false;
          this.showFloat(h.x, h.y - 92, '狂怒结束', UI.muted, 14);
        }
        if (this.furyRing && this.furyRing.visible) this.furyRing.setVisible(false);
      }
      // 满怒不再自动进入（本版：去掉自动爆发，只保留手动按 R）
      this.paintFuryMeter();
    }

    /** 狂怒条的实时重绘（条体 + 满怒呼吸） */
    paintFuryMeter() {
      if (!this.furyMeter) return;
      var now = this.time.now;
      var on = this.furyActive();
      var ratio = on ? (this.furyLeft() / FURY.duration) : (this.fury / FURY.max);
      this.setMeterValue(this.furyMeter, ratio);
      var full = !on && this.fury >= FURY.max;
      var tint = on ? 0xffe6a0 : (full ? 0xffd76a : 0xffffff);
      if (this.furyMeter.fill.tintTopLeft !== tint) this.furyMeter.fill.setTint(tint);
      // 满怒：条体呼吸；狂怒中：条体显示剩余时间
      var alpha = 1;
      if (full) alpha = 0.72 + 0.28 * Math.abs(Math.sin(now / 180));
      if (this.furyMeter.fill.alpha !== alpha) { try { this.furyMeter.fill.setAlpha(alpha); } catch (e) { /* 忽略 */ } }
      if (this.furyText) {
        var txt;
        if (on) txt = '狂怒 ' + (this.furyLeft() / 1000).toFixed(1) + 's';
        else if (full) txt = '狂怒就绪 · R';
        else txt = '狂怒 ' + Math.floor(this.fury) + '/' + FURY.max;
        if (this.furyText.text !== txt) this.furyText.setText(txt);
        var col = on ? UI.gold : (full ? UI.gold : UI.sub);
        this.furyText.setColor(col);
        if (this.furyTextPos) {
          // 条被缩放 / 被移走后，数字要跟着条的**实际**右边缘走（见 meterTextX）。
          // 与 refreshHud 里那次是同一个实现（placeFuryText），口径不会漂。
          this.placeFuryText();
        }
      }
      // 「R 狂怒」提示（满怒或进行中都显示，位置贴条尾）
      if (this.furyHint) {
        var show = this.running && !this.heroDead && (full || on);
        if (this.furyHint.visible !== show) this.furyHint.setVisible(show);
        if (show && this.furyHintPos) this.furyHint.setPosition(this.furyHintPos.x, this.furyHintPos.y);
      }
      if (this.isTouch && this.btnFury) {
        this.btnFury.setFillStyle(full ? 0xffd76a : (on ? 0xffb347 : 0x6a5a30), full ? 0.5 : (on ? 0.4 : 0.18));
      }
    }

    /* ============================================================
       连携的可视化：主角头顶的菱形点，亮 = 已攒
       ------------------------------------------------------------
       为什么不做成 HUD 里的一根条：
         · 它是**离散**的（0~N 点），条形会让人误以为能慢慢涨
         · 更重要的是它必须"不用看角落" —— 连携会因挨打一次性清零，
           玩家得在贴身缠斗的瞬间就看清还剩几点，才谈得上"这一刀值不值"
       所以它挂在世界坐标里跟着主角走，也不登记进自定义布局（不干扰玩家布局）。
       ============================================================ */
    /** 重建连携点（数量随 LINK.max 变 —— 遗物抬上限时会走到这里） */
    buildLinkPips(cap) {
      if (this.linkPips) this.linkPips.forEach(function (p) { if (p) p.destroy(); });
      var arr = [];
      for (var i = 0; i < cap; i++) {
        var g = this.add.graphics().setDepth(1200).setVisible(false);
        g.fillStyle(0x8ae8ff, 1);
        g.beginPath();
        g.moveTo(0, -5); g.lineTo(5, 0); g.lineTo(0, 5); g.lineTo(-5, 0);
        g.closePath(); g.fillPath();
        arr.push(g);
      }
      this.linkPips = arr;
    }

    /** 头顶连携点：位置 + 明暗（每帧调用；0 点时整组隐藏，画面保持干净） */
    paintLinkMeter() {
      var cap = Math.max(1, LINK.max);
      if (!this.linkPips || this.linkPips.length !== cap) this.buildLinkPips(cap);
      var h = this.hero;
      if (!h) return;
      var n = this.link || 0;
      var show = this.running && !this.heroDead && n > 0;
      if (!show) {
        this.linkPips.forEach(function (p) { if (p && p.visible) p.setVisible(false); });
        return;
      }
      var gap = 13;
      var x0 = h.x - (cap - 1) * gap / 2;
      var y = h.y - 126;
      // 最新攒到的那一点在呼吸：眼睛能立刻跟上"刚刚又攒了一个"
      var pulse = 0.70 + 0.30 * Math.abs(Math.sin(this.time.now / 220));
      for (var i = 0; i < cap; i++) {
        var p = this.linkPips[i];
        if (!p) continue;
        if (i >= n) {
          // 未攒的点不显示 —— 平时画面里只有"已经拿到的"，不留一排空槽占视线
          if (p.visible) p.setVisible(false);
          continue;
        }
        if (!p.visible) p.setVisible(true);
        p.setPosition(x0 + i * gap, y);
        p.setAlpha(i === n - 1 ? pulse : 1);
        p.setScale(i === n - 1 ? 1.12 : 0.92);
      }
    }

    /**
     * 屏幕外的存活敌人 → 在对应的屏幕边缘画一个金色箭头
     * ------------------------------------------------------------
     * 关卡有两屏宽，怪还可能站在高台上。「剩余敌人 1」却怎么也找不到那一个，
     * 是这套 2D 试炼里最容易被当成 bug 的情况 —— 给个方向就不必满地图瞎找。
     */
    updateOffscreenEnemyMarkers() {
      if (!this.enemyMarkers) {
        this.enemyMarkers = this.add.graphics().setDepth(30).setScrollFactor(0);
      }
      var g = this.enemyMarkers;
      g.clear();
      if (!this.running || this.heroDead) return;
      var cam = this.cameras.main;
      var W = this.scale.width, H = this.scale.height;
      this.enemies.forEach(function (e) {
        if (!e.alive) return;
        var sx = e.sprite.x - cam.scrollX;
        var sy = e.sprite.y - cam.scrollY;
        var offX = (sx < -8) ? -1 : (sx > W + 8 ? 1 : 0);
        var offY = (sy < -8) ? -1 : (sy > H + 8 ? 1 : 0);
        if (!offX && !offY) return;
        var x, y, ax, ay;
        g.fillStyle(0xffd76a, 0.92);
        g.beginPath();
        if (offX) {
          // 这一关是横向的，优先指左右
          x = offX < 0 ? 16 : W - 16;
          y = clamp(sy, 56, H - 56);
          ax = (offX < 0) ? -9 : 9;
          g.moveTo(x + ax, y);
          g.lineTo(x - ax * 0.55, y - 11);
          g.lineTo(x - ax * 0.55, y + 11);
        } else {
          // 上下也指：敌人跑到很高处、或万一沉到地面以下时，玩家至少知道往下找
          y = offY < 0 ? 56 : H - 56;
          x = clamp(sx, 26, W - 26);
          ay = (offY < 0) ? -9 : 9;
          g.moveTo(x, y + ay);
          g.lineTo(x - 11, y - ay * 0.55);
          g.lineTo(x + 11, y - ay * 0.55);
        }
        g.closePath();
        g.fillPath();
        g.lineStyle(1, 0x04060f, 0.6);
        g.strokePath();
      });
    }

    /** 完美防御 / 连招 / 命中 / 击杀 / 挨打 的攒怒口 */
    furyOnHit(e, chain) {
      var tier = (e && e.tier) || 'normal';
      var g = FURY.gainHit[tier] || FURY.gainHit.normal;
      if (chain) g += FURY.gainChain;
      this.addFury(g, chain ? chain.name : null);
    }

    damageHero(dmg, source, ignoreInvuln, fromX) {
      if (this.heroDead || !this.running) return false;
      if (HOST.godMode) return 'immune';   // 作弊面板 / 开发者命令的「无敌」
      var now = this.time.now;
      if (!ignoreInvuln && now < this.invulnUntil) {
        // 无敌帧挡下攻击：闪避起手 150ms 内的即是「完美闪避」
        if (this.dodging && now - this.dodgeStartAt <= DODGE.perfect) this.onPerfectDodge();
        return 'immune';
      }

      // 环境 / 诅咒对「承受伤害」的修正（厄运 ×、易伤 +2、荆棘诅咒 +1）
      if (!ignoreInvuln) {
        dmg = dmg * this.damageTakenMult() + this.damageTakenFlat();
        // 狂怒状态：狂暴而不设防 —— 受到的伤害 +15%
        if (this.furyActive()) dmg *= FURY.takenMult;
        // 遗物：承受伤害的系数（贪婪之心 +10% 这类，用乘法叠在诅咒 / 环境之后）
        dmg *= (1 + this.relicFx('takenMult', 0));
        // 敌人的暴击（幸运 / 暴击共振）
        if (source && source.sprite) {
          var ec = this.envEnemyCrit();
          if (ec > 1) {
            dmg *= ec;
            this.showFloat(source.sprite.x, source.sprite.y - 96, '环境暴击', '#b8a8ff', 14);
          }
        }
      }

      // 防御（举盾）：正面减伤、背后不减伤；刚举起来的窗口内挡下 = 完美格挡
      var blockedFront = false;
      if (!ignoreInvuln && this.guarding && now >= this.guardStartAt + GUARD.raise) {
        var ax = (fromX !== undefined && fromX !== null) ? fromX
          : (source && source.sprite ? source.sprite.x : null);
        var facing = this.hero.flipX ? -1 : 1;
        var frontal = (ax === null) ? true : ((ax - this.hero.x) * facing >= -14);
        if (frontal) {
          var g = this.updateGuard(16.7, true);
          if (g === -1) return this.onPerfectBlock(source);
          dmg = Math.max(1, dmg * GUARD.front);
          blockedFront = true;
        } else {
          this.showFloat(this.hero.x, this.hero.y - 88, '背后!', '#ff9a5a', 15);
        }
      }

      // 闪避
      if (!ignoreInvuln && this.hero.dodge > 0 && Math.random() < (this.hero.dodge / 100)) {
        this.showFloat(this.hero.x, this.hero.y - 62, '闪避', '#8ab8ff', 18);
        sfx('dodge');
        this.invulnUntil = now + 280;
        this.onDodgeSuccess();
        return 'dodged';
      }

      // 护盾壁垒：4 秒内受到的伤害减半
      if (this.guardUntil && now < this.guardUntil) dmg = Math.max(1, dmg * 0.5);
      // v2.9 P1：受击会打断魂晶读条（读条的风险窗口就来自这里）
      this._hurtAt = now;
      var remain = Math.round(dmg);
      if (this.hero.shield > 0) {
        var use = Math.min(this.hero.shield, remain);
        this.hero.shield -= use;
        remain -= use;
        this.showFloat(this.hero.x, this.hero.y - 80, '-' + fmt(use), '#5fd0e0', 16);
        sfx('shield');
      }
      if (remain > 0) {
        this.hero.hp -= remain;
        // 遗物：不朽图腾 —— 致命伤保留 1 血，每层一次（与经典内核的 hasTotem 同语义）
        if (this.hero.hp <= 0 && this.hasPerk('totem') && !this._totemUsedFloor) {
          this.hero.hp = 1;
          this._totemUsedFloor = true;
          this.showFloat(this.hero.x, this.hero.y - 116, '不朽图腾 · 保留 1 血', '#ffd76a', 18);
          sfx('levelUp');
        }
        this.showFloat(this.hero.x, this.hero.y - 62, '-' + fmt(remain), '#ff6b6b', 18);
        // 挡下来的这一下不该把角色打得后仰 —— 盾还举着，人站着
        if (!blockedFront && !this.furyActive()) {
          this.hero.play('hero_hurt', true);
          this.hero.setTint(0xff8080);
          var self = this;
          this.time.delayedCall(140, function () { if (!self.heroDead) self.hero.clearTint(); });
        } else {
          this.spark(this.hero.x + (this.hero.flipX ? -22 : 22), this.hero.y - 34, blockedFront ? 0xffd76a : 0xffb347);
        }
      } else {
        this.showFloat(this.hero.x, this.hero.y - 80, blockedFront ? '格挡' : '护盾抵挡', blockedFront ? '#ffd76a' : '#5fd0e0', 15);
      }
      // 挡下的一下只给短促缓冲：举盾不是无敌，一直举着照样会被磨
      this.invulnUntil = now + (blockedFront ? 260 : 700);
      // 狂怒：挨打也攒怒（逆风翻盘的手感）
      if (remain > 0) this.addFury(FURY.gainHurt);
      // 连携：真掉血就全断。
      // 只认"实际掉血"（remain > 0）—— 被盾挡住 / 被护盾吃掉的那一下不断，
      // 因为"用护盾换连携"本身就是一个玩家可以做的交换，断了反而少一个选择。
      if (remain > 0) this.breakLink();
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(140, 0.008);

      var thornVal = this.hero.thorn + this.relicFx('thornExtra', 0);   // 遗物：荆棘之心
      // 荆棘之心：生命 ≤50% 时反伤翻倍 —— 血怒流"故意挨打"的那一环
      if (this.relicFx('thornLowHpMult', 0) > 0 &&
          this.hero.hp <= this.hero.maxHp * 0.5) thornVal *= 2;
      if (thornVal > 0 && source) this.damageEnemy(source, { dmg: thornVal, crit: false }, true);
      if (remain > 0) sfx('hurt');

      // 环境：荆棘之地（敌人出手也要被反噬）+ 吸血诅咒（敌人回血）+ 连击风暴（敌人再补一下）
      if (source && source.alive && source.sprite) {
        if (this.hasEnv('荆棘之地')) {
          var rb = Math.max(1, Math.round(source.hp * this.envValue('rebound')));
          source.hp = Math.max(0, source.hp - rb);
          this.showFloat(source.sprite.x, source.sprite.y - 76, '荆棘反噬 -' + rb, '#c8ff9a', 14);
          if (source.hp <= 0) this.killEnemy(source);
        }
        if (this.hasEnv('吸血诅咒') && source.alive) {
          var ls = Math.max(1, Math.round(source.maxHp * this.envValue('lifesteal')));
          source.hp = Math.min(source.maxHp, source.hp + ls);
          this.showFloat(source.sprite.x, source.sprite.y - 92, '吸血 +' + ls, '#ff8ab0', 13);
        }
        if (this.hasEnv('连击风暴') && remain > 0 && Math.random() < this.envValue('comboBonus') && !this.heroDead) {
          this.showFloat(source.sprite.x, source.sprite.y - 108, '连击风暴', '#b8a8ff', 14);
          this.damageHero(Math.round(dmg * 0.6), null, false, source.sprite.x);
        }
      }

      this.refreshHud();
      if (this.hero.hp <= 0) this.heroDie();
      return remain > 0 ? 'hit' : 'shield';
    }

    healHero(amount, showText, isPotion) {
      if (this.heroDead) return 0;
      var m = this.healMult(isPotion);
      var before = this.hero.hp;
      this.hero.hp = Math.min(this.hero.maxHp, this.hero.hp + amount * m);
      var real = Math.round(this.hero.hp - before);
      if (real > 0 && showText !== false) this.showFloat(this.hero.x, this.hero.y - 68, '+' + real, '#7fd6a0', 17);
      else if (real <= 0 && m < 1 && showText !== false) this.showFloat(this.hero.x, this.hero.y - 68, '治疗被抑制', '#b8a8ff', 13);
      this.refreshHud();
      return real;
    }

    usePotion() {
      if (!this.running || this.heroDead) return;
      if (this.hero.potions <= 0) { this.showFloat(this.hero.x, this.hero.y - 68, '没有药水', '#ffb347', 15); sfx('error'); return; }
      this.hero.potions--;
      this.healHero(Math.round(this.hero.maxHp * 0.35), true, true);
      sfx('potion');
      this.refreshHud();
    }

    // ---------- 特效 ----------
    /** 血条逐帧补间（数值同步在 refreshHud / setMeterValue） */
    updateMeters(dt, now) {
      if (this.heroMeter) this.updateMeter(this.heroMeter, dt, now);
      if (this.shieldMeter) this.updateMeter(this.shieldMeter, dt, now);
      if (this.bossMeter && this.boss) this.updateMeter(this.bossMeter, dt, now);
      if (this.targetMeter && this.targetPanel && this.targetPanel.visible) {
        this.updateMeter(this.targetMeter, dt, now);
      }
    }

    /**
     * 属性面板的行列参数（layoutStatPanel 与 layoutHudButtons 共用）
     * 抽出来是因为「英雄技能 / 常驻按钮」要接着属性面板往下排，
     * 必须按**当前宽度**算行数，不能读上一次布局留下的值（开局时宽度可能是 0）。
     */
    statPanelMetrics(sizeW) {
      var W = sizeW || this.scale.width;
      // 遗物条占着那一行时，属性面板整体下让 —— 两者不叠字。
      var rowH = RELIC_ROW_H;
      var top0 = this._relicStripVisible ? (RELIC_ROW_CY + rowH) : 106;
      // 「精简」与「极简」档：属性面板整块收起（数值没有消失，搬进了遗物详情
      // 卡片的「属性明细」页 —— 这也是手机横屏原来就有的行为，只是那时没有出口）。
      var dens = this.hudDensity || 'auto';
      if (dens === 'minimal' || dens === 'compact') {
        return { perRow: 4, step: 84, font: 12, rows: 0, top: top0, rowH: 18, bottom: top0 - 6 };
      }
      // 触摸设备 + 低高度横屏（手机横着拿）：这 8 个小格（攻/暴/闪/盾/棘/吸/连/斩）
      // 在整场战斗里一个数字都不会变，却是左侧 HUD 里最密的一块 —— 2 行 × 4 格。
      // 屏幕高度只有 ~360 时把它收起来：技能胶囊与功能按钮随之上移约 34px，
      // 把画面多让出来一条。
      // ⚠️ 原来这里写着"想核对数值随时切「文字界面」"—— 那个按钮在 v2.8 已随
      //    试炼关停一起删除，手机玩家因此**完全没有途径**核对这 8 个数值。
      //    现在这批数据搬进了属性明细页，入口是常驻按钮行里的「属性」胶囊
      //    （id = stats，与图鉴 / 设置同款），收起才不再是死路。
      if (this.isTouch && this.scale.height < 460) {
        return { perRow: 4, step: 84, font: 12, rows: 0, top: top0, rowH: 18, bottom: top0 - 6 };
      }
      var perRow = W >= 880 ? 8 : (W >= 560 ? 4 : 3);
      var count = (this.statItems && this.statItems.length) || 8;
      var rows = Math.max(1, Math.ceil(count / perRow));
      return {
        perRow: perRow,
        step: perRow === 8 ? 74 : 84,
        font: W >= 560 ? 12 : 11,
        rows: rows,
        top: top0,
        rowH: 18,
        bottom: top0 + (rows - 1) * 18 + 9   // 最后一行的下沿（含半个行高）
      };
    }

    /** 属性面板布局：窄屏折行并缩小字号，避免越界；紧凑模式下（手机横屏）整块收起 */
    layoutStatPanel(sizeW) {
      if (!this.statItems || !this.statItems.length) return;
      var m = this.statPanelMetrics(sizeW);
      // ⚠️ 必须缓存：refreshHud 每帧都会带动遗物条 → 遗物条又会调这里，
      //    而每个 statItem 的 setFontSize / setVisible 都会让 Phaser **重新栅格化**
      //    文字纹理（8 项 × 每帧）。不缓存就是每帧重建 8 张纹理，帧级掉血。
      var W = sizeW || this.scale.width;
      var sig = m.rows + '|' + m.top + '|' + m.perRow + '|' + m.font + '|' + W;
      if (this._statLayoutSig === sig) { this.hudStatBottom = m.bottom; this.hudBtnY = m.bottom + 14; return; }
      this._statLayoutSig = sig;
      var collapsed = m.rows === 0;
      this.statItems.forEach(function (it, i) {
        it.box.setVisible(!collapsed);
        it.text.setVisible(!collapsed);
        if (collapsed) return;
        var row = Math.floor(i / m.perRow);
        var col = i % m.perRow;
        var x = 24 + col * m.step;
        var y = m.top + row * m.rowH;
        it.box.setPosition(x, y);
        it.text.setPosition(x + 13, y);
        it.text.setFontSize(m.font);
      });
      // 属性面板 → 英雄技能 → 常驻按钮：三层依次往下排
      this.hudStatBottom = m.bottom;
      this.hudBtnY = m.bottom + 14;   // 兼容旧字段（常驻按钮行的基准）
    }

    // ============================================================
    //  遗物条（v2.8.1）
    // ------------------------------------------------------------
    //  解决什么：2.7 把主画面换成 2D 之后，遗物在画面上只剩菜单里一个数字。
    //  而 27 件遗物分四流派、同派互相放大 —— 看不见自己拿了什么、在凑哪一套，
    //  构筑这件事就不成立。
    //
    //  为什么不加按钮：加一颗「遗物」按钮等于把画面上已经过多的按钮再 +1。
    //  这里改成**把图标直接嵌进主角血条组**：它长在血条下面，读作「这个角色的
    //  装备」，而不是一颗新的系统入口。玩家不需要学一个新按钮 ——
    //  看到图标就点，这是所有游戏通用的直觉。
    //
    //  信息分层（对应用户要求的「可以不直接显示」）：
    //    · 图标 + 流派色环 → 常驻，一眼看出「有几件、哪几派」
    //    · 点图标 / 点 +N  → 详情卡片：逐件效果 + 品质 + 属性明细
    //  属性明细是刻意一起搬进去的：`statPanelMetrics` 在手机横屏下会把
    //  8 个属性格整块收起（rows: 0），而它原来的兜底说明是「随时切文字界面」——
    //  那个按钮在 v2.8 已经删掉了。不给这批数值一个新出口，我就不该收它们。
    // ============================================================

    /** 三档 HUD 密度是否允许常驻遗物条 */
    relicStripWanted() {
      var d = this.hudDensity || 'auto';
      // 「极简」档不常驻遗物条：这一档的语义就是"只留三条资源条，其余都进详情卡片"，
      // 而详情卡片的入口现在是常驻按钮行里的「属性」胶囊（id = stats）——
      // 不依赖遗物条，所以这里可以老老实实按档位收掉。
      // （2.8.1 当初不敢收，是因为那唯一的出口「▸ 属性」正好长在遗物条上。）
      // 页面被切到后台 / 窗口最小化时，Phaser 的 scale 会被置成 0（浏览器把
      // canvas 尺寸归零）。这时候**不做任何判断**：保持现状比按 0 宽重排安全得多 ——
      // 按 0 宽会把遗物条判成"放不下"而收起，回到前台再展开，
      // 中间那一帧的收起/展开会把玩家调好的自定义布局顶掉。
      if (!(this.scale.width > 0)) return this._relicStripVisible === true;
      if (d === 'minimal') return false;
      // 「完整」档无条件显示（玩家显式要求看更多）；自动与精简档按屏幕判断。
      // 阈值 17 个图标 ≈ 4 件遗物之后开始出「+N」：再宽也只是把数字往后挪，
      // 不如把空间留给战场（一排图标本来就该是"扫一眼"的信息，不是清单）。
      return d === 'full' || this.scale.width >= 420;
    }

    /** 属性面板此刻是否收起（= 8 个属性格是否被档位 / 屏幕高度收掉） */
    _statCollapsedNow(sizeW) {
      var m = this.statPanelMetrics((sizeW && sizeW > 0) ? sizeW : this.scale.width);
      return m.rows === 0;
    }

    /** 建立遗物条的显示对象（只建一次；位置与显隐由 layoutRelicStrip 定） */
    buildRelicStrip() {
      var self = this;
      if (this.relicStrip) return;
      ensureRelicTextures(this, null);

      this.relicStrip = this.add.container(0, 0).setScrollFactor(0);
      this.relicStripIcons = [];
      this.relicRects = [];          // 命中区（含 `+N` 那一格）

      this.relicChipLabel = this.add.text(24, 8, '遗物', {
        fontSize: '10px', color: '#8f86c8', fontStyle: 'bold'
      }).setOrigin(0, 0.5);
      this.relicChipLabel.setLetterSpacing(2);
      this.relicChipLabel.setShadow(0, 1, '#04060f', 4, false, true);
      this.relicChipCount = this.add.text(24, 8, '', {
        fontSize: '10px', color: UI.muted, fontStyle: 'bold'
      }).setOrigin(1, 0.5);
      this.relicChipEmpty = this.add.text(24, 8, '暂无 · 精英与层主必掉', {
        fontSize: '10px', color: UI.muted
      }).setOrigin(0, 0.5);
      this.relicChipMore = this.add.text(24, 8, '', {
        fontSize: '10px', color: UI.gold, fontStyle: 'bold'
      }).setOrigin(0, 0.5);
      // ⓘ 「▸ 属性」那颗小字入口已经搬走了：现在它是常驻按钮行里的正式胶囊
      //   （id = stats，见 buildHud）。遗物条这一行只负责"遗物"本身。

      this.relicStrip.add([this.relicChipLabel, this.relicChipCount,
        this.relicChipEmpty, this.relicChipMore]);

      // 图标池：按 4 件预留（绝大多数一局拿不到更多），不够时按需扩。
      // 每个图标是一张 16×16 的 Image（白符号 + 流派色环），显示尺寸由布局给。
      for (var i = 0; i < 4; i++) this._pushRelicIcon();

      this.hud.add(this.relicStrip);
      this.layoutRelicStrip();
      this.refreshRelicStrip();
    }

    /** 往图标池里加一张（纹理在 setTexture 时按 id 指到 rt_rl_<id>） */
    _pushRelicIcon() {
      var img = this.add.image(0, 0, 'rt_rl_abyssMark').setOrigin(0.5);
      img.setVisible(false);
      this.relicStrip.add(img);
      this.relicStripIcons.push(img);
      return img;
    }

    /**
     * 按当前尺寸与密度重排遗物条（不改显隐，显隐由 refreshRelicStrip 定）
     * @param {number} [sizeW] 指定宽度。不传就用实时画布宽度 ——
     *   与 layoutHudButtons(sizeW) 同一套约定：布局函数都能按"假定宽度"算，
     *   这样窄屏行为可以脱离真实窗口尺寸被单独验证（真实浏览器里
     *   `scale.width` 是只读的 getter，想靠赋值模拟窄屏是做不到的）。
     */
    layoutRelicStrip(sizeW) {
      if (!this.relicStrip) return;
      var W = (sizeW && sizeW > 0) ? sizeW : this.scale.width;
      // 页面在后台时 scale 会被置 0（见 relicStripWanted 的说明）。
      // 阈值用 40 而不是 0：舞台刚建立那一帧 scale 可能是 1×1，
      // 按 1 排出来的坐标（计数被摆到 x = -11）会一直留到下一轮可见时才纠正。
      if (!(W > 40)) return;
      var k = clamp(Math.min(W / 900, 1), 0.68, 1);
      var rh = Math.max(18, Math.round(20 * k));      // 行高
      this._relicRowH = rh;
      // 图标直径：与属性面板的字号观感对齐（12px 字 ≈ 18px 图标）
      var d = Math.max(15, Math.round(17 * k));
      this._relicIconD = d;
      var gap = Math.max(3, Math.round(4 * k));
      this._relicGap = gap;

      // 可用宽度：从 x=24 起，右侧留 12；但若右列（环境 / 诅咒胶囊）会压到
      // 左侧，就把收窄也一起算进来。
      // ⚠️ 不能只依赖 _envHudMinTop / _envPanelW：那两个值由 layoutEnvHud 写入，
      //    而它跑在 layoutHudButtons 的后半段 —— 首帧 / 换层 / 改密度时它们可能还没
      //    算出来（undefined），此时若按整屏宽度排图标，窄屏上遗物条会横穿到右列底下。
      //    所以这里**无条件**按右列宽度设一个上界，时序无关。
      var availRight = W - 12;
      var rightColLeft = W - 24 - (this._envPanelW || ENV.panelW);
      // 右列真的会横着撞上左列时，给遗物条留的右边界退到它之前
      if (rightColLeft < 24 + Math.round(252 * k) + 120) {
        availRight = Math.min(availRight, Math.max(24 + 96, rightColLeft - 8));
      }

      // 先给标签与计数留位：标签「遗物」+ 右侧计数文案
      var labW = this.relicChipLabel.width + 6;
      var cntW = this.relicChipCount.width + 8;
      var iconLeft = 24 + Math.round(labW) + 4;
      var iconRight = availRight - Math.round(cntW);

      var maxN = Math.max(1, Math.floor((iconRight - iconLeft + gap) / (d + gap)));
      maxN = Math.min(maxN, 12);
      var rel = this.relics || [];
      var showAll = rel.length <= maxN;
      var shown = showAll ? rel.length : Math.max(1, maxN - 1);   // 留一格给 +N

      while (this.relicStripIcons.length < shown) this._pushRelicIcon();

      var y = RELIC_ROW_CY;
      var x = iconLeft;
      for (var i = 0; i < this.relicStripIcons.length; i++) {
        var img = this.relicStripIcons[i];
        var on = i < shown;
        img.setVisible(on);
        if (on) {
          img.setDisplaySize(d, d);
          img.setPosition(x + d / 2, y);
          x += d + gap;
        }
      }
      this._relicShown = shown;
      this._relicIconLeft = iconLeft;
      this._relicIconRight = iconRight;

      // 右侧计数 / `+N`：在行内右对齐（图标不一定铺满，跟着图标尾部更自然）
      var tailX = Math.min(x - gap + Math.max(6, Math.round(8 * k)), availRight);
      this._relicTailX = tailX;
      this.relicChipMore.setPosition(tailX, y);
      this.relicChipLabel.setPosition(24, y);
      this.relicChipCount.setPosition(availRight, y);
      this.relicChipEmpty.setPosition(24 + Math.round(labW) + 4, y);
    }

    /**
     * 同步遗物条的内容（遗物增减、属性面板是否收起、密度变化都要走这里）
     * @param {number} [sizeW] 指定宽度（只给验证/测试用，见 layoutRelicStrip）
     */
    refreshRelicStrip(sizeW) {
      if (!this.relicStrip) return;
      var W = (sizeW && sizeW > 0) ? sizeW : this.scale.width;
      var rel = this.relics || [];
      var wanted = this.relicStripWanted() && rel.length > 0;
      // 没有遗物、或者当前档位不常驻 → 整条不占位，属性面板与下面的按钮整体上移。
      // （属性明细的入口现在是常驻按钮行里的「属性」胶囊，不再靠这一行托着。）
      // ⚠️ 收起来的时候必须把**容器本身**也设成不可见：
      //    这个容器在 buildRelicStrip 里是默认可见的，容器里的「遗物 / 暂无…」小字
      //    若只靠 _relicStripVisible 这个布尔量"当作没显示"，字还是会画在
      //    狂怒条与属性面板之间（实测就是这么冒出来的）。
      if (!wanted) {
        if (this._relicStripVisible || this.relicStrip.visible) {
          this._relicStripVisible = false;
          this.relicStrip.setVisible(false);
          this.layoutRelicStrip(W);
          this.layoutStatPanel(W);
        }
        return;
      }
      if (!this._relicStripVisible) {
        this._relicStripVisible = true;
        this.relicStrip.setVisible(true);
        this.layoutRelicStrip(W);
        this.layoutStatPanel(W);     // 行了占位，属性面板得往下让
      }
      this.layoutRelicStrip(W);

      var shown = this._relicShown || 0;
      var vis = rel.slice(0, shown);
      var k = clamp(Math.min(W / 900, 1), 0.68, 1);
      for (var i = 0; i < shown; i++) {
        var img = this.relicStripIcons[i];
        if (!img) continue;
        var id = (typeof vis[i] === 'string') ? vis[i] : (vis[i] && vis[i].id);
        // 认不出的 id 走兜底纹理：不认识的遗物也要看得见（宁可显示一个问号），
        // 而不是在条上留一个空洞 —— 空洞会让玩家以为"我少拿了一件"。
        // 2.9.2 F7：双套遗物按当前英雄取对应那一张（@m / @r）
        var tex = relicTexKey(id) || 'rt_rl___missing';
        if (!this.textures.exists(tex)) {
          if (!this.textures.exists('rt_rl___missing')) {
            var g = this.make.graphics({ x: 0, y: 0 }, false);
            RELIC_FALLBACK.draw(relicPen(g));
            g.lineStyle(1, SCHOOL_COLOR[''], 0.92);
            g.strokeCircle(8, 8, 7.0);
            g.generateTexture('rt_rl___missing', 16, 16);
            g.destroy();
          }
          tex = 'rt_rl___missing';
        }
        img.setTexture(tex);
        img.setDisplaySize(this._relicIconD || 17, this._relicIconD || 17);
      }

      var extra = rel.length - shown;
      var showMore = extra > 0;
      this.relicChipMore.setText(showMore ? ('+' + extra) : '');
      var has = rel.length > 0;
      this.relicChipLabel.setText('遗物');
      this.relicChipCount.setText(rel.length + ' 件');

      // 命中区：图标各一格；`+N` 单独一格（开详情卡片）
      var rects = [];
      var gap = this._relicGap || 4, d = this._relicIconD || 17;
      var rowY = RELIC_ROW_CY;
      var pad = 3;
      for (var j = 0; j < shown; j++) {
        var img2 = this.relicStripIcons[j];
        if (!img2) continue;
        rects.push({
          x: img2.x - d / 2 - pad, y: rowY - d / 2 - pad,
          w: d + pad * 2, h: d + pad * 2, i: j, kind: 'relic'
        });
      }
      if (showMore) {
        var tw = this.relicChipMore.width;
        var tx = this._relicTailX != null ? this._relicTailX : this._relicIconLeft;
        rects.push({
          x: tx - pad, y: rowY - 9, w: tw + pad * 2, h: 18, i: -1, kind: 'open'
        });
      }
      this.relicRects = rects;

      // 标签与计数的可见性（这一行现在只承载遗物本身）
      this.relicChipLabel.setVisible(has);
      this.relicChipEmpty.setVisible(false);
      this.relicChipCount.setVisible(has);
      this.relicChipMore.setVisible(showMore);
    }

    /** 遗物条命中测试（与 uiHitTest 同一优先级：点得到的一定会响应） */
    relicHitTest(p) {
      if (!this._relicStripVisible || !this.relicRects) return null;
      for (var i = 0; i < this.relicRects.length; i++) {
        var r = this.relicRects[i];
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return { rect: r, i: r.i };
      }
      return null;
    }

    // ---------- 遗物详情卡片 ----------
    /**
     * 打开遗物详情
     * ------------------------------------------------------------
     * 战斗暂停的做法与图鉴一致（_pausedForRelic）：它是"停下来读"的信息面板，
     * 不暂停等于让玩家在弹幕里读说明书。
     */
    openRelicPanel() {
      if (this.relicOpen) { this.closeRelicPanel(); return; }
      if (this._finished || this.heroDead) return;
      if (this.panelOverlayOpen()) return;      // 别的面板开着时不叠上来
      this.relicOpen = true;
      this.relicPage = 0;
      this.dodging = false; this.dodgeReadyAt = 0;
      this.lowerGuard();
      this._pausedForRelic = !this.mapOpen && !this.deathOpen;
      if (this._pausedForRelic) { try { this.physics.world.pause(); } catch (e) { /* 忽略 */ } }
      this.attacking = false; this.diving = false; this.isCharging = false;
      if (this.chargeRing) this.chargeRing.setVisible(false);
      if (this.diveFx) this.diveFx.setVisible(false);
      if (this.hero) this.hero.setVelocity(0, 0);
      if (this.touchUI) this.touchUI.setVisible(false);
      this.buildRelicLayer();
      if (this.relicLayer) {
        this.relicLayer.setAlpha(0);
        this.tweens.add({ targets: this.relicLayer, alpha: 1, duration: 180 });
      }
      sfx('click');
      this.syncUiBarVisibility();
    }

    /**
     * 直接打开「属性明细」页（不经过遗物列表）
     * ------------------------------------------------------------
     * 常驻按钮行里的「属性」胶囊（id = stats）走的就是这条路：
     * 玩家点它是为了看数值，先弹一张遗物列表只会多一次点击；
     * 属性页本身不依赖遗物数据（它读的是 hero 与 statItems），所以这条路成立。
     */
    openRelicStatsPage() {
      if (this.relicOpen) return;
      if (this._finished || this.heroDead) return;
      if (this.panelOverlayOpen()) return;
      this.relicOpen = true;
      this.relicView = 'stats';
      this.relicPage = 0;
      this.dodging = false; this.dodgeReadyAt = 0;
      this.lowerGuard();
      this._pausedForRelic = !this.mapOpen && !this.deathOpen;
      if (this._pausedForRelic) { try { this.physics.world.pause(); } catch (e) { /* 忽略 */ } }
      this.attacking = false; this.diving = false; this.isCharging = false;
      if (this.chargeRing) this.chargeRing.setVisible(false);
      if (this.diveFx) this.diveFx.setVisible(false);
      if (this.hero) this.hero.setVelocity(0, 0);
      if (this.touchUI) this.touchUI.setVisible(false);
      this.buildRelicStatsLayer();
      if (this.relicStatsLayer) {
        this.relicStatsLayer.setAlpha(0);
        this.tweens.add({ targets: this.relicStatsLayer, alpha: 1, duration: 180 });
      }
      sfx('click');
      this.syncUiBarVisibility();
    }

    closeRelicPanel() {
      if (!this.relicOpen) return;
      this.relicOpen = false;
      // ⚠️ 两张卡片都要收：它们同属「遗物」这一个面板、在同一时刻只有一张存在，
      //    但关闭路径只有这一条 —— 只销毁 relicLayer 的话，从属性页关掉时
      //    relicStatsLayer 会留在场景里（每开一次多留一层显示对象与一颗按钮）。
      this.destroyLayer('relicLayer');
      this.destroyLayer('relicStatsLayer');
      this.panelButtons.relic = [];
      this.panelButtons.relicStats = [];
      this.relicRects2 = [];
      sfx('click');
      if (this._pausedForRelic) {
        this._pausedForRelic = false;
        try { this.physics.world.resume(); } catch (e) { /* 忽略 */ }
      }
      if (this.mapOpen) { this.buildMapLayer(); return; }
      if (this.deathOpen) return;
      if (this.touchUI) this.touchUI.setVisible(this._lastInputWasTouch === true);
      this.syncUiBarVisibility();
    }

    /** 一行遗物的文字按可用宽度缩字号；实在放不下才截断（下限 9px） */
    fitRelicText(str, baseFs, availW) {
      if (!this._measure) this._measure = this.add.text(0, 0, '', { fontSize: '12px' }).setVisible(false);
      var m = this._measure;
      m.setText(str);
      m.setFontSize(baseFs);
      var w = m.width;
      if (w <= availW || availW <= 8) return { fs: baseFs, text: str };
      var fs = Math.max(9, Math.floor(baseFs * availW / w));
      m.setFontSize(fs);
      if (m.width <= availW) return { fs: fs, text: str };
      var cut = str, guard = 0;
      while (cut.length > 2 && m.width > availW && guard++ < 90) {
        cut = cut.slice(0, -1);
        m.setText(cut + '…');
      }
      return { fs: fs, text: cut + '…' };
    }

    buildRelicLayer(sizeW, sizeH) {
      var self = this;
      var W = (sizeW && sizeW >= 40) ? sizeW : this.scale.width;
      var H = (sizeH && sizeH >= 40) ? sizeH : this.scale.height;
      if (W < 40 || H < 40) { fixCanvasSize(); return null; }
      if (this.relicLayer) this.destroyLayer('relicLayer');

      var rel = (this.relics || []).slice();
      var mini = W < 700 || H < 420;
      var L = this.add.container(0, 0).setDepth(2320).setScrollFactor(0);
      this.relicLayer = L;
      this.panelButtons.relic = [];
      this.relicRects2 = [];

      this.addDim(L, W, H, 0.8);
      var pad = mini ? 14 : 20;
      var pw = Math.min(W - (mini ? 16 : 80), mini ? 640 : 720);

      // 高度**按内容算**，不是固定值：
      // 一局通常只拿 3~8 件遗物，固定 560 会在只有两件时留下半屏空白
      // （第一版就是这样，看起来像个坏掉的对话框）。清单类面板的规矩是
      // 「有多少内容就占多少地方」，留白只该出现在内容多到需要翻页时。
      var rowH = mini ? 38 : 44;
      var headH = mini ? 46 : 56;          // 标题行 + 与列表的间距
      var footH = mini ? 40 : 46;
      var listPadY = mini ? 14 : 18;       // 列表卡自身的内边距（上下各一份）
      var wantRows = Math.max(rel.length, 1);
      var listH = wantRows * rowH + listPadY;
      // 上限：不能顶出画面（内容真多时走分页）
      var maxListH = H - (mini ? 90 : 150) - headH - footH;
      if (listH > maxListH) listH = maxListH;
      var ph = Math.min(headH + listH + footH, H - (mini ? 16 : 60));
      var px = Math.round((W - pw) / 2), py = Math.round((H - ph) / 2);
      this.addPanel(L, px, py, pw, ph, {});

      // ---- 页眉：标题 + 件数 ----
      var titleFs = mini ? 16 : 20;
      L.add(this.add.text(px + pad, py + (mini ? 14 : 18), '本局遗物', {
        fontSize: titleFs + 'px', color: UI.title, fontStyle: 'bold', letterSpacing: mini ? 2 : 3
      }).setOrigin(0, 0.5));
      var cntTxt = rel.length + ' / ' + Object.keys(RELIC_VIS).length + ' 件';
      L.add(this.add.text(px + pw - pad, py + (mini ? 14 : 18), cntTxt, {
        fontSize: (mini ? 11 : 12) + 'px', color: UI.sub
      }).setOrigin(1, 0.5));

      var headY = py + (mini ? 30 : 38);
      var bodyTop = headY;
      var bodyBottom = py + ph - footH;

      if (!rel.length) {
        L.add(this.add.text(px + pw / 2, (bodyTop + bodyBottom) / 2,
          '本局还没有遗物\n\n精英战与层主必掉一件；宝箱有概率、商店可买、\n深渊裂隙的三选一也会给。', {
            fontSize: (mini ? 12 : 13) + 'px', color: UI.muted, align: 'center', lineSpacing: 7
          }).setOrigin(0.5));
        this.relicPageCount = 1;
      } else {
        // ---- 内嵌列表卡 ----
        // 左边内缩 14：遗物行开头有流派色条 + 图标，贴着圆角边会让色条像被切掉。
        var listPadX = 14, listPadY2 = 8;
        this.addPanel(L, px + pad, bodyTop, pw - pad * 2, bodyBottom - bodyTop, {
          fill: UI.box, fillAlpha: 0.42, radius: Math.max(8, UI.boxR), lineAlpha: 0.06
        });
        var listX = px + pad + listPadX, listY = bodyTop + listPadY2;
        var listW = pw - pad * 2 - listPadX * 2;
        var innerH = bodyBottom - bodyTop - listPadY2 * 2;
        var perPage = Math.max(1, Math.floor(innerH / rowH));
        this._relicPerPage = perPage;
        var pageCount = Math.max(1, Math.ceil(rel.length / perPage));
        this.relicPageCount = pageCount;
        if (!(this.relicPage >= 0)) this.relicPage = 0;
        if (this.relicPage >= pageCount) this.relicPage = pageCount - 1;
        var start = this.relicPage * perPage;
        for (var i = 0; i < perPage; i++) {
          var r = rel[start + i];
          if (!r) break;
          this.relicCardRow(L, listX, listY + i * rowH, listW, rowH - 3, r, mini);
        }
        // 分页提示放在列表卡下沿之内（与图鉴同一处理：写在外侧会压住页脚按钮）
        if (pageCount > 1) {
          L.add(this.add.text(px + pw / 2, bodyBottom - 8,
            '第 ' + (this.relicPage + 1) + ' / ' + pageCount + ' 页', {
              fontSize: '11px', color: UI.muted
            }).setOrigin(0.5));
        }
      }

      // ---- 页脚：属性 / 翻页 / 关闭 ----
      var fy = py + ph - footH / 2 - (mini ? 2 : 4);
      var bw = mini ? 84 : 96, bh = mini ? 30 : 34;
      // 左边那颗是「属性」而不是「关闭」：手机横屏时属性面板被整块收起，
      // 这批数值在画面上没有任何别的入口 —— 入口放在第一颗，别让玩家去找。
      this.uiButton(L, this.panelButtons.relic, 'relic:stats', '属性明细', px + pad, fy, bw + 8, bh, false);
      if (this.relicPageCount > 1) {
        var pw2 = mini ? 66 : 78;
        this.uiButton(L, this.panelButtons.relic, 'relic:prev', '‹ 上页', px + pad + bw + 16, fy, pw2, bh, false);
        this.uiButton(L, this.panelButtons.relic, 'relic:next', '下页 ›', px + pad + bw + 24 + pw2, fy, pw2, bh, false);
      }
      this.uiButton(L, this.panelButtons.relic, 'relic:close', '返回战斗', px + pw - pad - bw, fy, bw, bh, true);
      return L;
    }

    /**
     * 详情卡片里的一行遗物：图标 + 名称 + 品质 + **完整效果描述**
     * ------------------------------------------------------------
     * 描述必须完整：玩家点开这张卡片就是为了读它。所以文本按可用宽度
     * 自动缩字号，而不是先截断再省略号（截断会把"每损失 10% 生命，伤害 +7%"
     * 这种关键条件吃掉一半）。
     */
    relicCardRow(L, x, y, w, h, r, mini) {
      var id = (typeof r === 'string') ? r : (r && r.id);
      var vis = relicVis(id);
      var school = vis.school || '';
      var tint = SCHOOL_COLOR[school] || SCHOOL_COLOR[''];

      var g = this.add.graphics();
      g.fillStyle(0xffffff, 0.03);
      g.fillRoundedRect(x, y, w, h, 8);
      g.lineStyle(1, 0xffffff, 0.05);
      g.strokeRoundedRect(x + 0.5, y + 0.5, w - 1, h - 1, 8);
      // 左侧流派色条：与图鉴选中态同一套语言（一眼扫出流派分布）
      g.fillStyle(tint, 0.9);
      g.fillRoundedRect(x + 3, y + 5, 3, h - 10, 1.5);
      L.add(g);

      // 图标
      var d = mini ? 20 : 22;
      var tex = relicTexKey(id) || 'rt_rl___missing';
      if (this.textures.exists(tex)) {
        L.add(this.add.image(x + 14 + d / 2, y + h / 2, tex).setOrigin(0.5).setDisplaySize(d, d));
      }
      var tx = x + 14 + d + 8;

      // 名称
      var name = vis.label || id || '?';
      L.add(this.add.text(tx, y + h / 2, name, {
        fontSize: (mini ? 12 : 13) + 'px', color: UI.text, fontStyle: 'bold'
      }).setOrigin(0, 0.5));
      var nameW = (mini ? 12 : 13) * name.length + 4;

      // 品质
      var q = QUALITY_STYLE[vis.quality] || QUALITY_STYLE.common;
      var qx = tx + nameW + 6;
      L.add(this.add.text(qx, y + h / 2 + 1, q.name, {
        fontSize: '10px', color: q.color
      }).setOrigin(0, 0.5));
      var qw = 10 * q.name.length + 4;

      // 效果：占满剩余宽度，字号自适应
      var descX = qx + qw + 10;
      var availW = x + w - 12 - descX;
      if (availW > 60) {
        var fit = this.fitRelicText(vis.desc || '—', mini ? 11 : 12, availW);
        L.add(this.add.text(descX, y + h / 2, fit.text, {
          fontSize: fit.fs + 'px', color: UI.sub
        }).setOrigin(0, 0.5));
      }
    }

    /**
     * 属性明细（第二页）：手机横屏时属性面板被整块收起，这里是它唯一的出口
     */
    buildRelicStatsLayer(sizeW, sizeH) {
      var self = this;
      var W = (sizeW && sizeW >= 40) ? sizeW : this.scale.width;
      var H = (sizeH && sizeH >= 40) ? sizeH : this.scale.height;
      if (W < 40 || H < 40) { fixCanvasSize(); return null; }
      if (this.relicStatsLayer) this.destroyLayer('relicStatsLayer');

      var mini = W < 700 || H < 420;
      var hasRelics = !!(this.relics || []).length;   // 底部按钮要不要给「返回遗物」留位，见下
      var L = this.add.container(0, 0).setDepth(2330).setScrollFactor(0);
      this.relicStatsLayer = L;
      this.panelButtons.relicStats = [];

      // 先把要显示的属性算出来 —— 面板高度要**按内容算**。
      // 固定 300 高的第一版在宽屏上留了大半屏空白，看起来像个没做完的对话框。
      var hero = this.hero || {};
      var items = (this.statItems || []).map(function (it) {
        var v = hero[it.key];
        v = (typeof v === 'number') ? Math.round(v) : 0;
        return { label: it.label, v: v + (it.suffix || ''), color: it.text ? it.text.style.color : '#ffffff', on: it.always || v > 0 };
      });
      items.push({ label: '生命上限', v: String(hero.maxHp || 0), color: UI.hpFrom, on: true });
      items.push({ label: '体力上限', v: String(hero.maxStamina || 0), color: UI.stamFrom, on: true });
      var cols2 = mini ? 2 : 3;
      var rowsN = Math.max(1, Math.ceil(items.length / cols2));

      this.addDim(L, W, H, 0.82);
      var pad = mini ? 14 : 20;
      var rowH = mini ? 22 : 26;
      var bw2 = mini ? 84 : 96, bh2 = mini ? 30 : 34;
      // 宽度也要跟着列数走：2 列时 560 宽会让每一行空出小半截
      var pw = Math.min(W - (mini ? 16 : 120), mini ? (cols2 === 2 ? 460 : 460) : 520);
      var contentH = rowsN * rowH + 44;                     // 属性行 + 上下说明
      var ph = Math.min(contentH + (mini ? 84 : 98), H - (mini ? 16 : 80));
      var px = Math.round((W - pw) / 2), py = Math.round((H - ph) / 2);
      this.addPanel(L, px, py, pw, ph, {});

      L.add(this.add.text(px + pad, py + (mini ? 14 : 18), '属性明细', {
        fontSize: (mini ? 16 : 19) + 'px', color: UI.title, fontStyle: 'bold', letterSpacing: 2
      }).setOrigin(0, 0.5));
      L.add(this.add.text(px + pw - pad, py + (mini ? 14 : 18), '实时数值', {
        fontSize: '11px', color: UI.muted
      }).setOrigin(1, 0.5));

      var headY = py + (mini ? 32 : 40);
      var footH = mini ? 38 : 44;
      var bodyTop = headY;
      var bodyBottom = py + ph - footH;
      this.addPanel(L, px + pad, bodyTop, pw - pad * 2, bodyBottom - bodyTop, {
        fill: UI.box, fillAlpha: 0.42, radius: Math.max(8, UI.boxR), lineAlpha: 0.06
      });

      // 分列：i 落在第几列由「每列行数」决定，不是 item 数的一半 ——
      // 用 half 的写法在 3 列时会算出负行号（10 项 / 3 列 → 第 3 列 row = -2），
      // 结果就是「吸 / 连 / 斩」那几个被画到面板外面去。
      var colW = (pw - pad * 2 - 24) / cols2;
      var top = bodyTop + 12;
      for (var i = 0; i < items.length; i++) {
        var col = Math.floor(i / rowsN);
        var row = i - col * rowsN;
        if (col >= cols2) break;
        var ix = px + pad + 12 + col * (colW + 12);
        var iy = top + row * rowH;
        var it = items[i];
        L.add(this.add.text(ix, iy, it.label, {
          fontSize: (mini ? 11 : 12) + 'px', color: it.on ? UI.sub : UI.muted
        }).setOrigin(0, 0.5));
        L.add(this.add.text(ix + colW - 12, iy, it.v, {
          fontSize: (mini ? 12 : 13) + 'px',
          color: it.on ? it.color : UI.muted, fontStyle: 'bold'
        }).setOrigin(1, 0.5));
      }
      L.add(this.add.text(px + pad + 12, bodyBottom - 14,
        '灰色的项当前为 0；数值会随遗物与增益实时变化。', {
          fontSize: '10px', color: UI.muted
        }).setOrigin(0, 0.5));

      var fy = py + ph - footH / 2;
      // 左边那颗是「返回遗物」，只在**真的有遗物列表可退**时才出现。
      // 一件遗物都没有时它是多余的：那时玩家是从「属性」按钮直接进来的，
      // 没有列表可退，右边那颗「返回战斗」已经把出口给全了 ——
      // 摆两颗都写着"返回战斗"的按钮只会让玩家犹豫点哪个。
      if (hasRelics) {
        this.uiButton(L, this.panelButtons.relicStats, 'relic:statsBack', '返回遗物', px + pad, fy, bw2, bh2, false);
      }
      this.uiButton(L, this.panelButtons.relicStats, 'relic:close', '返回战斗', px + pw - pad - bw2, fy, bw2, bh2, true);
      return L;
    }

    showFloat(x, y, text, color, size) {
      if (state.settings && state.settings.floatText === false) return;
      var t = this.floatPool.pop();
      if (!t) {
        t = this.add.text(0, 0, '', {
          fontSize: '17px', color: '#ffffff', fontStyle: 'bold',
          stroke: '#000000', strokeThickness: 3
        }).setOrigin(0.5).setDepth(60);
      }
      t.setVisible(true);
      t.setText(text);
      t.setColor(color || '#ffffff');
      t.setFontSize(size || 17);
      t.setPosition(x, y);
      t.setAlpha(1);
      t._life = 750;
      this.floats.push(t);
    }

    /** 飘字逐帧更新：复用对象，长时间战斗不产生垃圾 */
    updateFloats(dt) {
      var arr = this.floats;
      for (var i = arr.length - 1; i >= 0; i--) {
        var t = arr[i];
        t._life -= dt;
        t.y -= 0.075 * dt;
        t.setAlpha(clamp(t._life / 750, 0, 1));
        if (t._life <= 0) {
          t.setVisible(false);
          arr.splice(i, 1);
          if (this.floatPool.length < 60) this.floatPool.push(t);
          else t.destroy();
        }
      }
    }

    /** 火花发射器池：3 个轮转复用，不再每次命中都创建/销毁发射器 */
    getSparkEmitter() {
      if (!qp().particles || (state.settings && state.settings.particles === false)) return null;
      if (!this._sparkEmitters) {
        this._sparkEmitters = [];
        try {
          for (var i = 0; i < 3; i++) {
            var em = this.add.particles(0, 0, TEX.spark, {
              speed: { min: 70, max: 220 }, lifespan: 380, quantity: qp().count,
              scale: { start: 0.9, end: 0 }, blendMode: 'ADD', emitting: false
            });
            em.setDepth(50);
            this._sparkEmitters.push(em);
          }
        } catch (e) { this._sparkEmitters = []; }
      }
      if (!this._sparkEmitters.length) return null;
      this._sparkIdx = (this._sparkIdx || 0) + 1;
      return this._sparkEmitters[this._sparkIdx % this._sparkEmitters.length];
    }

    spark(x, y, color) {
      var em = this.getSparkEmitter();
      if (!em) return;
      try {
        if (typeof em.setParticleTint === 'function') em.setParticleTint(color);
        em.setPosition(x, y);
        em.explode(qp().count);
      } catch (e) { /* 忽略 */ }
    }

    showCenter(text, color) {
      // 长提示自动缩字号：脉冲横幅可能一口气列出四五条结算，30px 会在窄屏上横穿整屏
      var n = String(text || '').length;
      var size = n > 26 ? 20 : (n > 18 ? 24 : (n > 12 ? 27 : 30));
      this.centerMsg.setFontSize(size);
      this.centerMsg.setText(text).setColor(color || '#ffd76a').setAlpha(1).setScale(0.85);
      this.tweens.add({ targets: this.centerMsg, scale: 1, duration: 220, ease: 'Back.easeOut' });
      this.tweens.add({ targets: this.centerMsg, alpha: 0, delay: 1100, duration: 500 });
    }

    refreshHud() {
      var h = this.hero;
      // 生命 / 护盾：数值同步（补间由 updateMeters 逐帧推进）
      this.setMeterValue(this.heroMeter, h.hp / h.maxHp);
      this.setMeterValue(this.shieldMeter, h.shield / Math.max(1, h.maxHp));
      this.hpText.setText(Math.max(0, Math.round(h.hp)) + ' / ' + h.maxHp);
      this.shieldText.setText(h.shield > 0 ? '盾 ' + Math.round(h.shield) : '');
      var hx = this.meterTextX(this.heroMeter, this._hpTextGap);
      if (hx == null) hx = 286;
      var hy = this._hpTextY != null ? this._hpTextY : 34;
      this.hpText.setPosition(hx, hy);
      this.shieldText.setPosition(hx + this.hpText.width + 8, hy);
      this.updateStaminaText();
      // 狂怒数值也在这个刷新点定一次位 —— 与生命 / 体力完全同步（第 10 条）。
      // 之前它只由 paintFuryMeter 负责，一旦某条路径只走了 refreshHud（条被重排、
      // 自定义布局生效、窗口尺寸变化），狂怒数字就会留在原地不跟条。
      this.placeFuryText();
      if (this._lastFloorShown !== this.floor) {
        this._lastFloorShown = this.floor;
        this.floorText.setText('第 ' + this.floor + ' 层');
        this.floorText.setScale(1.35);
        this.tweens.add({ targets: this.floorText, scale: 1, duration: 260, ease: 'Back.easeOut' });
      }
      this.pointText.setText('金币 ' + this.points);
      var alive = this.enemies.filter(function (e) { return e.alive; }).length;
      // 机制房复用这一行 HUD 显示目标进度（不新增 HUD 元素，施工清单 §1.3）
      if (this.collapse && this.roomObjective) {
        var co = this.roomObjective;
        this.enemyCountText.setText('魂晶 ' + co.got + '/' + co.need +
          (co.done ? ' · 已解封' : (alive > 0 ? ' · 敌人 ' + alive : '')));
      } else if (this.holdZone && this.roomObjective) {
        var hz = this.holdZone;
        if (TOGGLES.holdGate && !hz.started) {
          this.enemyCountText.setText('待启动 · 核心 ' + Math.round(this.coreRatio() * 100) + '%');
        } else {
          this.enemyCountText.setText('袭击 ' + Math.max(0, Math.ceil((hz.dur - hz.t) / 1000)) + 's · 核心 ' +
            Math.round(this.coreRatio() * 100) + '%' + (alive > 0 ? ' · 敌人 ' + alive : ''));
        }
      } else if (this.timedRoom && this.roomObjective) {
        // 2.9.4 B1：倒计时在屏幕中央独占一处，这里只保留敌人数量
        this.enemyCountText.setText('敌人 ' + alive);
      } else {
        this.enemyCountText.setText(alive > 0 ? '剩余敌人 ' + alive
          : (this.roomGoal && !this.roomGoal.done ? '开启房间目标后开放传送门' : '已清空 → 传送门（打开地图）'));
      }
      // 触摸设备没有键盘，[L] 这个快捷键提示只是噪音
      this.potionText.setText('药水 ×' + this.hero.potions + (this.isTouch ? '' : '   [L]'));

      // 属性面板（为 0 的项淡出，只突出当前生效的属性）
      if (this.statItems) {
        this.statItems.forEach(function (it) {
          var v = h[it.key];
          v = (typeof v === 'number') ? Math.round(v) : 0;
          it.text.setText(it.label + ' ' + v + it.suffix);
          var show = it.always || v > 0;
          it.text.setAlpha(show ? 1 : 0.26);
          it.box.setAlpha(show ? 1 : 0.22);
        });
      }

      // 当前房间信息
      // 塌陷房也走同一条路径（「房间:普通房间 · 塌陷」），和守点 / 限时写法一致。
      // 原来塌陷单独分支写成「房间:塌陷回廊」—— 那是样板房 / 预览页的名字，
      // 泄漏进了正式局，同一个机制体系出现了两种写法。预览页保留样板房名。
      if (this.roomText) {
        if (this.collapse && this.previewMode) {
          this.roomText.setText('房间:塌陷回廊 · 样板房');
        } else {
          var rt = this.roomNode ? (ROOM_TYPES[this.roomNode.type] || ROOM_TYPES.enemy) : null;
          var progress = '';
          if (this.floorMap) {
            var total = this.floorMap.nodes.length;
            var seen = this.floorMap.nodes.filter(function (n) { return n.visited; }).length;
            progress = ' · 已探索 ' + seen + '/' + total;
          }
          var mechName = this._roomMechanic ? (MECHANIC.names[this._roomMechanic] || '') : '';
          var roomLabel = mechName ? (mechName + '房') : (rt ? rt.name : '');
          this.roomText.setText(rt ? ('房间:' + roomLabel + progress) : '');
        }
      }

      if (this.boss && this.boss.alive) {
        this.setMeterValue(this.bossMeter, this.boss.hp / this.boss.maxHp);
        this.bossText.setText('生命 ' + Math.max(0, Math.round(this.boss.hp)) + ' / ' + this.boss.maxHp);
      }

      // 遗物条：遗物增减 / 密度设置变化 / 属性面板收起状态变化都要在这里同步。
      // refreshRelicStrip 自带「状态没变就早退」的守卫，每帧调用的代价只有一次比较。
      this.refreshRelicStrip();
    }

    // ---------- 主循环 ----------
    /**
     * WebGL 上下文被系统回收后恢复时的补丁
     * Phaser 自己会重传纹理（textureManager.restoreContext），这里只把
     * 尺寸与布局补一遍 —— iOS 从后台回来时可视区基本都变了。
     */
    /**
     * 密度变化后重建"按密度生成一次"的资产
     * ------------------------------------------------------------
     * 只有两类：血条纹理（名字里带密度，自然换新的）、文字分辨率。
     * 图标纹理**不重建**（理由见 iconTextureReady）。
     * ⚠️ 不在这里调 onResize：它可能重建整个关卡，而密度变化和尺寸变化不是一回事。
     */
    refreshDensityAssets() {
      state._dprDirty = false;
      applyTextDensity(this.children.list);
      // 血条：宽度没变也要重算纹理，所以先把 m.px 清掉
      var self = this;
      ['heroMeter', 'shieldMeter', 'staminaMeter', 'furyMeter', 'bossMeter', 'targetMeter']
        .forEach(function (k) {
          var m = self[k];
          if (!m || !m.fill) return;
          m.px = 0;
          try { self.placeMeter(m, m.x, m.y, m.wLogical || m.w); } catch (e3) { /* 单条失败不影响其它 */ }
        });
    }

    onContextRestored() {
      try { if (this.scale && this.scale.refresh) this.scale.refresh(); } catch (e) { /* 忽略 */ }
      if (this.ready && this.onResize) {
        this.onResize({ width: this.scale.width, height: this.scale.height });
      }
    }

    update(time, delta) {
      if (!this.ready) return;
      var dt = Math.min(delta, 40);
      this._dt = dt;

      // 密度变了（换屏 / 系统缩放 / 旋屏后限流档变化）：图标与血条纹理是"按密度
      // 生成一次"的，必须重建。只在真的变了的那一帧跑一次，平时就一个布尔判断。
      if (state._dprDirty) this.refreshDensityAssets();
      // 保险：画布像素与渲染器尺寸对不上时补一次（Phaser 只在 baseSize 变化时
      // 才会调 renderer.resize，而"画布变大、逻辑尺寸不变"不触发它）。
      var gm = state.game;
      if (gm && gm.renderer && gm.canvas && gm.renderer.width !== gm.canvas.width) {
        try { gm.renderer.resize(gm.scale.baseSize.width, gm.scale.baseSize.height); } catch (e) { /* 忽略 */ }
      }

      // 常驻功能按钮行让位：地图 / 商店 / 图鉴 / 死亡结算 / 撤离确认 / 设置弹窗
      // 打开时，它（depth 2600）会压在这些面板之上，必须先收起来。
      // 放在 running 判断之前：结算 / 死亡时 running 可能已经为 false。
      this.syncUiBarVisibility();

      // 背景星点缓慢左移（每 3 帧更新一次，降低 CPU 占用）
      this._starTick = (this._starTick || 0) + 1;
      if (this._starTick % 3 === 0) {
        var W = this.scale.width;
        var step = dt * 3;
        this.bgStars.forEach(function (s) {
          s.x -= (0.05 + s._layer * 0.06) * step * 0.02;
          if (s.x < -5) s.x = W + 5;
        });
      }

      // 血条补间要一直推进：倒下 / 结算动画期间血条也要落到真实数值
      this.updateMeters(dt, time);
      // 布局编辑：外框走包围盒缓存，每帧只重画描边；被拖动的那一个由
      // layoutEditMove 单独更新（见「拖动热路径」的说明）
      if (this.editMode) this.drawEditOverlay();
      if (!this.running) return;
      // 宿主漏回话时宁可放行也别卡门；玩家正常看奖励面板时不计时强放
      if (this._awaitClearAck && time >= (this._awaitClearAckUntil || 0) &&
          !this.choiceOpen && !this.mapOpen && !this.shopOpen && !this.codexOpen &&
          !this.deathOpen && !this.confirmOpen && !this.pauseOpen) {
        console.warn('[战斗2D] 清房奖励超过 3 秒未收到 ack，自动放行');
        this.ackRoomCleared();
      }
      this.updateFloats(dt);
      if (this._viewPaused) { this.clearStaleInput(); return; }   // 被 DOM 全屏面板盖住时冻结
      if (this.mapOpen || this.shopOpen || this.codexOpen || this.deathOpen || this.confirmOpen ||
          this.choiceOpen || this.pauseOpen) {
        this.clearStaleInput();   // 面板里按下的键不该在关闭后立刻生效
        this.updateEnemyMeters();     // 面板打开时只刷新敌人血条
        return;
      }

      // 自愈：房间已清空但传送门不可用（例如刚关掉地图）→ 自动恢复，玩家不会被困住
      if (time - (this._portalCheckAt || 0) > 500) {
        this._portalCheckAt = time;
        if (!this.portalOpen) this.checkFloorClear(true);
      }
      // 腐化脉冲：诅咒与环境的「每回合」类效果按 5 秒一拍结算
      this.updatePulseHud();
      if ((this.curses && this.curses.length) || this.worldEnv) {
        if (!this.pulseAt) this.pulseAt = time + PULSE.period;
        if (time >= this.pulseAt) {
          this.pulseAt = time + PULSE.period;
          this.applyPulse();
        }
      }
      this.updateStamina(dt);
      this.updateFury(dt);
      this.paintLinkMeter();   // 连携点跟着主角走（0 点时内部立刻返回，几乎不花钱）
      this.updateWebFx();      // 织网者的缠身状态（同上，没被缠时不做任何事）
      this.updateHero(dt);
      if (this.collapse) this.updateCollapse(dt, time);
      if (this.holdZone) this.updateHold(dt, time);
      // 断桥的活体装饰（雾 / 落石 / 残板）：只在有断桥的房间里才有内容
      if (this._bridgeActive) this.updateBridgeFx(dt, time);
      if (this.timedRoom) this.updateTimed(dt, time);
      this.updateSkillProjectiles();
      this.updateShots(dt);
      this.updateGuide();
      this.updateEnemies(dt, time);
      this.updateEnemyMeters();
      this.updateOffscreenEnemyMarkers();
      this.updateProjectiles(dt);
      this.updateCombo(dt);
    }

    // ---------- 敌人属性显示 ----------
    /** 头顶血条 + 名字/攻击标签 + 目标面板（最近敌人：生命 / 攻击 / 速度 / 行为） */
    updateEnemyMeters() {
      var h = this.hero;
      var dt = this._dt || 16.7, now = this.time.now;
      var nearest = null, nd = 1e9;
      var self = this;
      var cam = this.cameras.main;
      var viewL = cam.scrollX - 80, viewR = cam.scrollX + this.scale.width + 80;

      this.enemies.forEach(function (e) {
        if (!e.alive || !e.meter) return;
        var d = Math.abs(e.sprite.x - h.x);
        if (d < nd) { nd = d; nearest = e; }
        var onScreen = e.sprite.x > viewL && e.sprite.x < viewR;
        var show = onScreen && (e.tier !== 'normal' || e === nearest || e.hp < e.maxHp);
        self.setMeterValue(e.meter, e.hp / e.maxHp);
        if (show) {
          var bw = e.barW;
          var by = e.sprite.y - e.sprite.displayHeight - 13;
          self.placeMeter(e.meter, Math.round(e.sprite.x - bw / 2), Math.round(by), bw);
          self.updateMeter(e.meter, dt, now);
          // 名字 + 攻击：两段不同语义色，合起来在血条上方居中
          var mid = e.sprite.x;
          var nw = e.nameLbl.width, aw = e.atkLbl.width, gap = 6;
          var start = mid - (nw + aw + gap) / 2;
          e.nameLbl.setPosition(Math.round(start + nw), Math.round(by - 10));
          e.atkLbl.setPosition(Math.round(start + nw + gap), Math.round(by - 10));
          e.nameLbl.setVisible(e === nearest || e.tier !== 'normal' || e.hp < e.maxHp);
          e.atkLbl.setVisible(e.nameLbl.visible);
        } else if (e.meter.visible !== false) {
          e.nameLbl.setVisible(false);
          e.atkLbl.setVisible(false);
        }
        self.setMeterVisible(e.meter, !!show);
      });
      this.nearestEnemy = nearest;

      if (!this.targetPanel) return;
      if (!nearest || this.heroDead) {
        if (this.targetPanel.visible) this.targetPanel.setVisible(false);
        return;
      }
      this.targetPanel.setVisible(true);
      this.setMeterValue(this.targetMeter, nearest.hp / nearest.maxHp);
      this.updateMeter(this.targetMeter, dt, now);

      // 内容变化才重排（避免逐帧重算文字与胶囊宽度）
      var hpNow = Math.max(0, Math.round(nearest.hp));
      var key = nearest.name + '|' + nearest.tier + '|' + nearest.atk + '|' + nearest.def.speed +
        '|' + nearest.behavior + '|' + nearest.maxHp + '|' + hpNow;
      if (this._targetKey !== key) {
        this._targetKey = key;
        var tierColor = UI.tier[nearest.tier] || UI.tier.normal;
        this.targetName.setText(nearest.name).setColor(tierColor);
        this.targetTier.setText(TIER_NAMES[nearest.tier] || '普通').setColor(tierColor);
        this.targetHp.setText(hpNow + ' / ' + nearest.maxHp);
        this._targetTags = [
          { text: '攻 ' + Math.round(nearest.atk), color: UI.danger },
          { text: '速 ' + nearest.def.speed, color: UI.sub },
          { text: BEHAVIOR_NAMES[nearest.behavior] || '追击', color: UI.accent }
        ];
        this.layoutTargetPanel();
      }
    }

    updateHero(dt) {
      var h = this.hero, k = this.keys;
      if (this.heroDead) return;

      // v2.9 P3：掉进断桥缺口 / 掉出地面 → 扣血 + 传送到缺口右侧安全段
      if (h.y > this.groundY + PIT.triggerY) { this.handlePitFall(); return; }

      var onGround = h.body.blocked.down || h.body.touching.down;

      // ===== 闪避（翻滚）：冲刺期间不接受其他操作 =====
      if (this.dodging) {
        this.updateDodge(dt, onGround);
        return;
      }
      if (!this.diving && Phaser.Input.Keyboard.JustDown(k.dodge)) {
        if (this.tryDodge()) return;
      }
      if (Phaser.Input.Keyboard.JustDown(k.skill)) this.useSkill();

      // ===== 跳劈：下落攻击（滞空挥砍触发），期间不接受其他操作 =====
      if (this.diving) {
        this.updateDive(onGround);
        h.setAlpha(this.invulnAlpha());
        return;
      }

      if (onGround) this.coyoteUntil = this.time.now + CHARGE.coyote;

      // 落地反馈：音效 + 扬尘
      if (onGround && this._wasAirborne) {
        this._wasAirborne = false;
        sfx('land');
        this.spark(h.x, h.y - 2, 0xb8c8d8);
        // 远程英雄没有跳劈，但「空中射击 → 落地」接得上同一套节奏：落地开踏地箭窗口
        if (this._airShotAt && this.heroRanged()) {
          this._airShotAt = 0;
          this.diveCounterUntil = this.time.now + CHAIN.diveWindow;
        }
      } else if (!onGround) {
        this._wasAirborne = true;
      }

      // ===== v2.9 P1：空中按下 = 加速下坠 + 穿过单向平台 =====
      // 地面按下仍然走防御（updateGuard 只在着地时成立）——两个状态互斥，
      // 触屏摇杆下推 / 键盘 S·↓ / 防御按钮都能触发，不需要新按钮。
      var ti = this.touchInput;
      var downHeld = k.guard.isDown || k.guard2.isDown || ti.guardHeld || ti.downHeld;
      var fastFall = !onGround && downHeld && !this.diving && !this.dodging && !this.isCharging && !this.heroDead;
      if (fastFall) {
        h.setVelocityY(Math.min(FASTFALL.speed, Math.max(h.body.velocity.y, 0) + FASTFALL.accel * dt / 1000));
        this.setPlatformPassThrough(true);
      } else if (this._platformPass) {
        this.setPlatformPassThrough(false);
      }

      // ===== 防御（举盾）：按住 S / ↓ =====
      var guardState = this.updateGuard(dt, onGround);
      var guarding = this.guarding;

      // ===== 蓄力跳输入（键盘 + 触摸）=====
      var jumpDown = Phaser.Input.Keyboard.JustDown(k.jump) || Phaser.Input.Keyboard.JustDown(k.jump2)
        || Phaser.Input.Keyboard.JustDown(k.jump3)
        || ti.jumpPressed;
      var jumpHeld = k.jump.isDown || k.jump2.isDown || k.jump3.isDown || ti.jumpHeld || ti.joyJumpHeld;
      ti.jumpPressed = false;

      // 在地面（或土狼宽限内）按下 → 开始蓄力：此时不下蹲起跳，只积蓄力量
      // 举盾时不能起跳（要先收盾）—— 避免「举盾跳」这种既挡又躲的无脑操作
      if (jumpDown && !this.isCharging && !guarding && (onGround || this.time.now < this.coyoteUntil)) {
        this.isCharging = true;
        this.chargeStart = this.time.now;
        this.chargeRatio = 0;
      }

      var leftDown = k.left.isDown || k.left2.isDown || ti.left;
      var rightDown = k.right.isDown || k.right2.isDown || ti.right;
      var speed = 250;
      if (this.attacking) speed *= 0.45;
      if (guarding) speed *= GUARD.moveScale;
      if (this.furyActive()) speed *= FURY.moveMult;   // 狂怒：移动速度 +25%
      // 织网者：被网缠住时移动大减 —— 解法是**闪避**（tryDodge 里会切断），
      // 而不是硬扛着走完它
      if (this.time.now < (this.webUntil || 0)) speed *= WEB.moveScale;

      // ===== 蓄力中：放慢移动 + 视觉反馈；松开瞬间才起跳 =====
      if (this.isCharging) {
        if (jumpHeld) {
          // 持续蓄力（有上限，按住不放保持满蓄力）
          this.chargeRatio = clamp((this.time.now - this.chargeStart) / CHARGE.max, 0, 1);
          speed *= 0.5;
          if (onGround && Math.random() < 0.4) {
            this.spark(h.x + rnd(-14, 14), h.y - 2, this.chargeRatio > 0.75 ? 0xffd76a : 0x8ad8ff);
          }
        } else {
          // 松开 → 按蓄力量起跳（轻点也有小跳保底）
          var ratio = this.chargeRatio;
          var power = CHARGE.minPower + (CHARGE.maxPower - CHARGE.minPower) * ratio;
          h.setVelocityY(-power);
          this.isCharging = false;
          this.coyoteUntil = 0;
          this.spark(h.x, h.y - 4, ratio > 0.75 ? 0xffd76a : 0xa8e6ff);
          sfx('jump');
          if (ratio > 0.85 && state.settings.screenShake2D !== false) {
            this.cameras.main.shake(90, 0.004);
          }
        }
      }

      if (leftDown && !rightDown) { h.setVelocityX(-speed); h.setFlipX(true); }
      else if (rightDown && !leftDown) { h.setVelocityX(speed); h.setFlipX(false); }
      else h.setVelocityX(h.body.velocity.x * 0.72);

      // 蓄力光圈：半径与亮度随蓄力增长，满蓄力转金
      if (this.chargeRing) {
        if (this.isCharging) {
          this.chargeRing.setVisible(true);
          this.chargeRing.setPosition(h.x, h.y - 3);
          this.chargeRing.setRadius(16 + this.chargeRatio * 34);
          this.chargeRing.setFillStyle(this.chargeRatio >= 0.999 ? 0xffd76a : 0xa8e6ff,
            0.16 + this.chargeRatio * 0.34);
        } else if (this.chargeRing.visible) {
          this.chargeRing.setVisible(false);
        }
      }

      // 触摸跳按钮同步蓄力反馈（按钮或摇杆上推都会点亮）
      if (this.isTouch && this.btnJump) {
        if (this.isCharging) {
          this.btnJump.setFillStyle(this.chargeRatio >= 0.999 ? 0xffd76a : 0x8ad8ff, 0.55);
        } else if (this.touchInput && !(this.touchInput.jumpHeld || this.touchInput.joyJumpHeld)) {
          this.btnJump.setFillStyle(0x73f0b4, 0.26);
        }
      }

      if (this.attacking) { /* 攻击动画优先 */ }
      // 砸地姿势：落地后短暂定格在「下坠」帧上 —— 没有专门的落地帧，
      // 把 7 号 fall 帧当作蹲伏姿势顶一下，比落地瞬间就弹回待机有分量得多
      else if (this.time.now < (this._landingUntil || 0)) h.play('hero_fall', true);
      else if (guarding) h.play('hero_guard', true);
      else if (!onGround) h.play(h.body.velocity.y < 0 ? 'hero_jump' : 'hero_fall', true);
      else if (this.isCharging) h.play('hero_idle', true);
      else if (Math.abs(h.body.velocity.x) > 24) h.play('hero_run', true);
      else h.play('hero_idle', true);

      if (Phaser.Input.Keyboard.JustDown(k.attack)) this.tryAttack();
      if (Phaser.Input.Keyboard.JustDown(k.potion)) this.usePotion();
      if (Phaser.Input.Keyboard.JustDown(k.fury)) this.tryFury();
      this.updateChainHint();
      this.updateCrystals(dt);

      h.setAlpha(this.invulnAlpha());

      // 房间目标物（宝箱 / 祭坛）：走近即触发
      var goal = this.roomGoal;
      if (goal && !goal.done && Math.abs(h.x - goal.x) < 58 && Math.abs(h.y - goal.y) < 120) {
        this.resolveRoomGoal();
      }

      if (this.portalOpen && this.portal && Math.abs(h.x - this.portal.x) < 54 &&
        this.time.now >= (this._portalGraceUntil || 0)) this.nextFloor();

      // 记下这一帧开始时的下坠速度：踩头判定在物理碰撞回调里发生，
      // 而碰撞已经把速度归零了 —— 只能看"碰之前"的速度。
      this._prevVy = h.body.velocity.y;
    }

    /**
     * 主角 ↔ 敌人碰撞（P2 踩头弹跳）
     * ------------------------------------------------------------
     * 从上方砸到敌人头顶 → 弹起 + 重置空中攻击（跳劈 / 挥砍都可立刻再用）。
     * 判定用"碰撞前的下坠速度"（this._prevVy），因为 Arcade 分离后速度已经归零。
     * 同一只怪 400ms 内只触发一次，避免贴着敌人连续弹射。
     */
    onHeroEnemyContact(heroSprite, enemySprite) {
      if (!this.running || this.heroDead || this.diving) return;
      if (!TOGGLES.stomp) return;   // 回退：踩头不弹跳（2.8 手感）
      var now = this.time.now;
      if ((this._prevVy || 0) < RHYTHM.stompWindowVy) return;
      var e = null;
      for (var i = 0; i < this.enemies.length; i++) {
        var cand = this.enemies[i];
        if (cand && cand.alive && cand.sprite === enemySprite) { e = cand; break; }
      }
      if (!e) return;
      if (now < (e._stompAt || 0) + RHYTHM.stompCd) return;
      // 碰撞后英雄的中心要落在敌人头顶附近（防止从侧面擦过去也触发）。
      // 敌人 origin 是 (0.5, 1)：spr.y 是脚底，body 顶 = spr.y - def.h。
      var enemyTop = e.sprite.y - (e.def.h || 44);
      if (this.hero.y > enemyTop + 10) return;

      e._stompAt = now;
      this._stompCount = (this._stompCount || 0) + 1;
      this.hero.setVelocityY(-RHYTHM.stompBounce);
      this.attackReadyAt = now;          // 重置空中攻击
      this.diveReadyAt = now;
      this.attacking = false;
      var dmg = Math.max(1, Math.round(this.hero.attack * RHYTHM.stompDamage));
      this.damageEnemy(e, { dmg: dmg, crit: false }, false);
      this.showFloat(e.sprite.x, e.sprite.y - 80, '踩头!', '#ffd76a', 18);
      this.spark(e.sprite.x, e.sprite.y - 26, 0xffd76a);
      sfx('jump');
    }

    /* ============================================================
       v2.9 P3：断桥坠落
       ============================================================ */

    /** 是否在缺口上方（怪不能生成在这里） */
    isOverGap(x) {
      var segs = this.groundSegments;
      if (!segs || !segs.length) return false;
      for (var i = 0; i < segs.length; i++) {
        if (x >= segs[i].x0 - 8 && x <= segs[i].x1 + 8) return false;
      }
      return true;
    }

    /** 把出生点挪到最近的安全地面（缺口右侧优先，保持"向前"） */
    adjustSpawnX(x) {
      if (!this.isOverGap(x)) return x;
      var segs = this.groundSegments;
      for (var i = 0; i < segs.length; i++) {
        if (x < segs[i].x0) return segs[i].x0 + 60;
      }
      return Math.max(0, this.levelWidth - 160);
    }

    /**
     * 某个横坐标处的地面**上表面** y
     * ------------------------------------------------------------
     * 断桥允许三段桥面 ±32px 落差（反馈 §4.2"有落差的断桥才像断桥"），
     * 于是「地面高度」不再是全局常量 groundY。凡是"把东西放到地上 / 判断谁沉到地底"
     * 的地方都要走这里，否则差一段就会把怪吸到上一层或者判它掉出关卡。
     */
    groundSurfaceAt(x) {
      var segs = this.groundSegments;
      if (segs && segs.length) {
        for (var i = 0; i < segs.length; i++) {
          if (x >= segs[i].x0 - 8 && x <= segs[i].x1 + 8) {
            return this.groundY + (segs[i].dy || 0);
          }
        }
      }
      return this.groundY;
    }

    /** 掉落传送目标：缺口**右侧**最近的安全段（不往回送） */
    pitRespawnX(x) {
      var segs = (this.groundSegments && this.groundSegments.length)
        ? this.groundSegments : [{ x0: 0, x1: this.levelWidth }];
      for (var i = 0; i < segs.length; i++) {
        if (x < segs[i].x0) return segs[i].x0 + 70;
      }
      return Math.min(this.levelWidth - 140, Math.max(segs[segs.length - 1].x0 + 70, x));
    }

    /** 把英雄放到指定 x 的地面上（含 0.6s 无敌 + 防连触锁） */
    teleportHeroTo(x, opts) {
      var h = this.hero, now = this.time.now;
      opts = opts || {};
      h.body.reset(x, this.groundY - 80);
      h.setVelocity(0, 0);
      this.invulnUntil = Math.max(this.invulnUntil || 0, now + (opts.invuln != null ? opts.invuln : PIT.invuln));
      this._pitLockUntil = now + (opts.lock != null ? opts.lock : PIT.lock);
      this._platformPass = false;
      this.diving = false;
      this.dodging = false;
      this.attacking = false;
      this.isCharging = false;
      if (this.chargeRing) this.chargeRing.setVisible(false);
      if (this.diveFx) this.diveFx.setVisible(false);
    }

    /**
     * 掉出地面：扣最大生命百分比（单次不致死）+ 传送回缺口右侧
     * P4 的塌陷回廊会接管这条路径（它有自己的"前沿 + 1"与"等崩解不扣血"）。
     */
    handlePitFall() {
      var now = this.time.now;
      if (now < (this._pitLockUntil || 0)) return;
      if (this.collapse && typeof this.collapse.onPitFall === 'function') {
        this.collapse.onPitFall();
        return;
      }
      var h = this.hero;
      var pct = PIT.dmgPct[this.difficulty] || PIT.dmgPct.normal;
      var dmg = Math.max(1, Math.round(h.maxHp * pct));
      h.hp = Math.max(1, h.hp - dmg);           // 单次不致死
      this._hurtAt = now;                        // 同时打断魂晶读条
      this.showFloat(h.x, h.y - 60, '坠落 -' + dmg + '（' + Math.round(pct * 100) + '%）', '#ff8a7a', 18);
      this.teleportHeroTo(this.pitRespawnX(h.x));
      this.cameras.main.flash(140, 120, 30, 40);
      sfx('land');
      this.refreshHud();
    }

    /* ============================================================
       v2.9 P4：塌陷回廊（样板房间 → 机制）
       ------------------------------------------------------------
       房间的支点不是"怪围住你"，而是「出口锁着，钥匙散落在地面与空中」：
         · 地面从左到右逐段塌，最后一段预警时强制解锁（兜底）
         · 钥匙：need 颗在地面（停下来读条）+ 2 颗浮空（跳跃触碰即收）
         · 没有任何浮台 —— 浮台会让"站上去等塌完"变成安全区（设计反馈）
         · 地面段塌掉时，未拾取的地面钥匙会被抛到前沿安全段
         · 掉进深渊 → 扣血 + 传送到「塌陷前沿 + 1」（永远向前）
         · 被困兜底保留（未来若有骨架带回平台）
       视觉上地面仍是**一整条** TileSprite，塌陷只是移动遮罩（施工清单 §10.2）。
       ============================================================ */

    /**
     * 调试入口：直接起一个房间（不走楼层序列）
     * 预览页与自动化验收共用。调用前需要引擎已 startRun。
     */
    buildDebugRoom(opts) {
      opts = opts || {};
      if (!this.ready) return false;
      var floor = opts.floor || 10;
      this.floor = floor;
      if (this.floorMap) this.floorMap.floor = floor;
      this.levelWidth = opts.levelWidth || Math.max(2200, Math.round(this.scale.width * 2));
      this.groundY = this.scale.height - 96;
      this.applyCameraBounds();
      this.previewMode = true;
      // 骨架可由调试入口指定（预览页的「骨架」下拉）：flat / double / bridge
      var sk = opts.skeleton || 'flat';
      this._forceSkeleton = (sk === 'double' || sk === 'bridge') ? sk : 'flat';
      // 断桥生成时靠它把缺口固定成 1 处（方案 §6.2）—— 调试房走 buildLevel 之外的路，
      // 所以单独给一个提示位，buildLevel 里会被清掉。
      this._mechGapCap = opts.mechanic || 'collapse';
      var node = {
        type: 'enemy', col: 1, row: 1, visited: true, links: [],
        noEnemies: true, noCrystals: true, noPlatforms: true, debugRoom: true,
        mechanic: opts.mechanic || 'collapse'
      };
      this.roomNode = node;
      if (this.floorMap) this.floorMap.current = node;
      this.running = true;
      this.heroDead = false;
      // 调试重开必须干净：上一局可能死在死亡面板里，死亡状态不清掉 updateHero 会直接返回，
      // 表现为"人站着不动、魂晶读条永远 0%"。
      this.deathOpen = false; this.mapOpen = false; this.shopOpen = false;
      this.confirmOpen = false; this.pauseOpen = false; this.choiceOpen = false;
      this.codexOpen = false; this.relicOpen = false;
      var layers = ['deathLayer', 'mapLayer', 'shopLayer', 'confirmLayer', 'pauseLayer', 'choiceLayer', 'codexLayer'];
      for (var li = 0; li < layers.length; li++) {
        if (this[layers[li]]) { try { this.destroyLayer(layers[li]); } catch (e) { /* 忽略 */ } }
      }
      try { this.physics.world.resume(); } catch (e) { /* 忽略 */ }
      this.hero.setAlpha(1).setAngle(0).setVisible(true);
      if (this.hero.body) this.hero.body.checkCollision.none = false;
      this.hero.hp = this.hero.maxHp;
      this.buildLevel(node);          // clearLevel → buildTerrain（强制骨架）→ portal
      this._forceSkeleton = null;
      this._mechGapCap = null;
      this._roomMechanic = opts.mechanic || 'collapse';   // 调试房默认就是塌陷（样板房叫「塌陷回廊」）
      // 每次预览都从干净的一局开始（否则上一局的护盾 / 狂怒 / 金币会污染对照数据）
      this.points = 0; this.kills = 0; this.roomsCleared = 0;
      this.hero.hp = this.hero.maxHp;
      this.hero.shield = 0;
      this.hero.stamina = this.hero.maxStamina;
      this.fury = 0; this.furyUntil = 0; this.link = 0;
      this.invulnUntil = 0; this._hurtAt = 0; this._pitLockUntil = 0;
      this.startCollapse(opts);
      return true;
    }

    /**
     * 把当前房间变成塌陷房（2.9.1 起支持三种骨架）
     * @param {object} opts { segments, interval, warn, need, crystalCount, floor, maxEnemies, deckWarn }
     *
     * 地形模型：「地形块列表」而不是「按 x 均分 N 段」。
     *   平厅：地面按 x 均分 N 块
     *   断桥：按缺口之间的连续地面切区，每区再分块；**缺口本身是"已塌块"**（开局就是深色）
     *   双层：下层同平厅；**上层整块算 1 块**，在下层塌到一半时整块崩塌（不是第二条时间轴）
     * 一条时间轴从左到右推进，遇到已塌的块就跳过（C.order 里只有还要塌的块）。
     */
    startCollapse(opts) {
      opts = opts || {};
      this.destroyCollapse();
      // 塌陷房不允许"安全岛"：平厅浮台一律清掉（站上去等地面塌完，机制就失效了）。
      // ⚠️ 双层上层（_solidDeck）**不清** —— 它有自己的寿命（半程整块崩塌），
      // 见 C.deck 与 collapseDeck()。它不再是安全区，而是"限时楼层"。
      var keepDeck = function (t) { return !!t._solidDeck; };
      this.platformTiles.forEach(function (t) { if (!keepDeck(t)) t.destroy(); });
      this.platformTiles = this.platformTiles.filter(keepDeck);
      if (this.platformStrips) {
        this.platformStrips.forEach(function (s) { if (!s._solidDeck) s.destroy(); });
        this.platformStrips = this.platformStrips.filter(function (s) { return !!s._solidDeck; });
      }
      // 附属视觉同理：上层的柱子/侧壁跟着上层留下，其余的（以后若加）清掉
      if (this.platformDecor) {
        this.platformDecor.forEach(function (s) { if (!keepDeck(s) && s.destroy) s.destroy(); });
        this.platformDecor = this.platformDecor.filter(keepDeck);
      }
      this.platformPerches = this.platformPerches.filter(function (p) { return !!p.deck; });
      var W = this.levelWidth, N = clamp(Math.round(opts.segments || 8), 3, 10);
      var interval = clamp(opts.interval || 4000, 1500, 8000);
      var warn = clamp(opts.warn || 800, 400, 1600);
      var need = clamp(Math.round(opts.need || 3), 1, 5);
      var keyCount = Math.max(need + 2, Math.round(opts.crystalCount || 5));
      var now = this.time.now;

      // ---- 地形块列表 ----
      var blocks = this.buildCollapseBlocks(N, W);
      var groups = blocks.groups;
      var order = blocks.order;

      var self = this;
      var C = {
        params: {
          segments: order.length, interval: interval, warn: warn, need: need, crystalCount: keyCount,
          deckWarn: clamp(Math.round(opts.deckWarn || warn * 2.5), 900, 4000)
        },
        skeleton: this.roomSkeleton || 'flat',
        groups: groups,
        order: order,
        nextOrder: 0,
        warnIndex: -1,
        warnUntil: 0,
        nextWarnAt: now + 900,
        frontier: -1,
        unlocked: false,
        forced: false,
        ended: false,
        elapsed: 0,
        lastSparkAt: 0,
        lastRuneGot: -1,
        spawnAt: now + 1400,
        spawnCd: 3000,
        maxEnemies: clamp(opts.maxEnemies || 3, 1, 5),
        stuckMs: 0,
        hintShown: false,
        crackShown: false,
        deck: null,
        stats: {
          falls: 0, trappedMs: 0, interrupts: 0, damage: 0,
          killsStart: this.kills || 0, freeEscapes: 0
        },
        maskGfx: this.add.graphics().setDepth(1.5),
        warnGfx: this.add.graphics().setDepth(1.6),
        runeGfx: this.add.graphics().setDepth(12),
        lockText: null,
        exitLedge: null
      };
      C.onPitFall = function () { self.collapseFallIntoPit(); };
      this.collapse = C;

      // ---- 双层：上层挂一个控制器（整块、半程崩、只有一条时间轴）----
      if (C.skeleton === 'double' && this.deckY && this.platformTiles.length) {
        C.deck = {
          y: this.deckY,
          fallen: false,
          warned: false,
          warnAt: 0,
          fallAt: 0,
          // 下层塌到一半时上层同步预警：8 块时是第 4 块（下标 3）
          warnGroup: Math.max(0, Math.min(order.length - 2, Math.floor(order.length / 2) - 1)),
          tiles: this.platformTiles.slice(),
          strips: (this.platformStrips || []).slice(),
          perches: this.platformPerches.slice(),
          fx: this.add.graphics().setDepth(6)
        };
      }

      // 目标：收集 N 颗魂晶 → 开门
      this.roomObjective = { type: 'collect', need: need, got: 0, done: false };

      // 钥匙：三种骨架三种铺法（每种都保证"不去另一层/另一侧就凑不齐"）
      this.clearCrystals();
      this.spawnCollapseKeys(keyCount, need);

      // 门先锁上：看得见、进不去
      this.portalOpen = false;
      if (this.portal) this.portal.setVisible(true).setAlpha(0.35);
      this.drawCollapseMask();   // 断桥的缺口开局就是"已塌"，必须立刻画上
      this.updateCollapseRunes(true);

      var skName = (C.skeleton === 'double') ? '双层' : (C.skeleton === 'bridge' ? '断桥' : '平厅');
      this.showCenter('塌陷 · ' + skName + ' · 收集 ' + need + ' 颗魂晶解除封印', '#c79aff');
      sfx('collapseWarn');
      this.refreshHud();
      return true;
    }

    /**
     * 切地形块（2.9.1 的「块列表」抽象）
     * @returns {{groups: Array, order: Array<number>}}
     *   groups 按 x 从左到右（含"已塌"的缺口块），order 是**还要塌**的块下标（时间轴顺序）
     */
    buildCollapseBlocks(wantN, W) {
      W = W || this.levelWidth;
      // 1) 先算连续地面区（断桥按缺口切，平厅/双层整条）
      var regions = [];
      var gaps = (this.roomSkeleton === 'bridge' && this.bridgeGaps) ? this.bridgeGaps : [];
      var cur = 0;
      gaps.forEach(function (g) {
        if (g.x0 > cur) regions.push({ x0: cur, x1: g.x0 });
        cur = Math.max(cur, g.x1);
      });
      if (cur < W) regions.push({ x0: cur, x1: W });
      regions = regions.filter(function (r) { return r.x1 - r.x0 >= 160; });
      if (!regions.length) regions = [{ x0: 0, x1: W }];

      // 2) 分配块数：每区先保底 2 块（短的一侧塌一次就断，不能只给 1 块），剩下的按长度分
      var n = Math.max(wantN, regions.length * 2);
      var counts = regions.map(function () { return 2; });
      var rest = n - regions.length * 2;
      if (rest > 0) {
        var totalLen = regions.reduce(function (a, r) { return a + (r.x1 - r.x0); }, 0) || 1;
        var acc = 0;
        regions.forEach(function (r, i) {
          var share = Math.round(rest * (r.x1 - r.x0) / totalLen);
          counts[i] += share; acc += share;
        });
        var left = rest - acc;
        if (left > 0) {
          var longest = 0;
          for (var q = 1; q < regions.length; q++) {
            if ((regions[q].x1 - regions[q].x0) > (regions[longest].x1 - regions[longest].x0)) longest = q;
          }
          counts[longest] += left;
        }
      }

      // 3) 每区按块数均分（边界吸附 64 网格，遮罩边缘与碰撞格对齐）
      var groups = [];
      var grid = function (v) { return Math.round(v / 64) * 64; };
      regions.forEach(function (r, ri) {
        var k = counts[ri];
        var bounds = [grid(r.x0)];
        for (var bi = 1; bi < k; bi++) bounds.push(grid(r.x0 + (r.x1 - r.x0) * bi / k));
        bounds.push(grid(r.x1));
        for (var gi = 0; gi < k; gi++) {
          if (bounds[gi + 1] - bounds[gi] < 32) continue;   // 网格吸掉的碎块
          groups.push({ x0: bounds[gi], x1: bounds[gi + 1], tiles: [], state: 'safe' });
        }
      });

      // 4) 缺口 = 初始就是"已塌"的块（不参与时间轴，开局就画深色）
      gaps.forEach(function (g) {
        groups.push({ x0: g.x0, x1: g.x1, tiles: [], state: 'fallen', pre: true });
      });
      groups.sort(function (a, b) { return a.x0 - b.x0; });
      groups.forEach(function (g, i) { g.i = i; });

      // 5) 把地砖分到块里（缺口块没有地砖）
      this.groundTiles.forEach(function (t) {
        if (!t.body || !t.body.enable || t.x > W) return;
        for (var q = 0; q < groups.length; q++) {
          if (groups[q].pre) continue;
          if (t.x >= groups[q].x0 && t.x < groups[q].x1) { groups[q].tiles.push(t); break; }
        }
      });

      // 6) 时间轴顺序：只要还要塌的块，从左到右
      var order = [];
      groups.forEach(function (g, i) { if (!g.pre && g.tiles.length) order.push(i); });
      if (!order.length) {
        // 兜底：没有可塌的块（极端生成）→ 按原分组再均分一次
        groups.forEach(function (g, i) { if (!g.pre) order.push(i); });
      }
      return { groups: groups, order: order };
    }

    /**
     * 投放钥匙魂晶
     * ------------------------------------------------------------
     * 平厅：need 颗在**地面**（必须停下来读条）+ 超出部分浮空（一碰即收）。
     *   设计反馈：塌陷房不能有浮台 —— 站上去等于安全区；而空中又站不住，
     *   所以地面钥匙必须读条、空中钥匙改成"跳跃触碰"。
     * 双层：下层 1 颗 + **上层 need 颗** + 空中 1 颗 —— 下层+空中只有 2 颗，
     *   少于需求，玩家必须上去；上层有寿命（约 17s 崩），这才是这骨架的压力。
     * 断桥：出生侧 2 颗（1 地面 + 1 空中）+ 另一侧 need 颗 —— 同侧永远凑不齐，必须跨缺口。
     */
    spawnCollapseKeys(count, need) {
      var C = this.collapse;
      if (!C) return;
      var groups = C.groups, self = this;
      var keys = [];
      var safeGroups = groups.filter(function (g) { return !g.pre && g.tiles.length; });
      var midOf = function (g, k) { return g.x0 + Math.max(50, Math.min(110, (g.x1 - g.x0) * (k == null ? 0.5 : k))); };
      var pickGroup = function (t) {
        if (!safeGroups.length) return null;
        var i = clamp(Math.round(1 + t * (safeGroups.length - 1)), 0, safeGroups.length - 1);
        return safeGroups[i];
      };

      if (C.deck) {
        // ---- 双层 × 塌陷 ----
        var gDeck = pickGroup(0.45);
        if (gDeck) keys.push({ x: midOf(gDeck), y: this.groundY - 34, kind: 'blue', airborne: false });
        // 上层：均匀撒 need 颗（读条），必须在上层崩落前拿到至少 1 颗
        var dp = C.deck.perches && C.deck.perches.length ? C.deck.perches : null;
        var deckXs = [];
        if (dp) {
          dp.forEach(function (p) { deckXs.push(p.x); });
          deckXs.sort(function (a, b) { return a - b; });
        }
        if (!deckXs.length) {
          deckXs = [this.levelWidth * 0.35, this.levelWidth * 0.5, this.levelWidth * 0.65];
        }
        for (var d = 0; d < need; d++) {
          var t2 = need <= 1 ? 0.5 : d / (need - 1);
          var dx = deckXs[clamp(Math.round(t2 * (deckXs.length - 1)), 0, deckXs.length - 1)];
          keys.push({ x: dx, y: C.deck.y - 34, kind: 'blue', airborne: false });
        }
        // 空中 1 颗放在连通口下方（顺便把玩家引到上去的位置）
        var gapX = this.levelWidth * 0.5;
        if (this.deckGaps && this.deckGaps.length) gapX = (this.deckGaps[0].x0 + this.deckGaps[0].x1) / 2;
        var airN = Math.max(0, count - need - 1);
        for (var a = 0; a < airN; a++) {
          keys.push({ x: gapX, y: this.groundY - 170 - a * 18, kind: (a % 2 === 0 ? 'abyss' : 'corrupt'), airborne: true });
        }
      } else if (C.skeleton === 'bridge' && groups.some(function (g) { return g.pre; })) {
        // ---- 断桥 × 塌陷：出生侧固定 2 颗，另一侧补齐 ----
        var preG = groups.filter(function (g) { return g.pre; })[0];
        var left = preG ? safeGroups.filter(function (g) { return g.x1 <= preG.x0; }) : [];
        if (!left.length) left = safeGroups.slice(0, 1);
        var right = safeGroups.filter(function (g) { return left.indexOf(g) < 0; });
        var l1 = left[0];
        var lLast = left[left.length - 1];
        keys.push({ x: midOf(l1, 0.55), y: this.groundY - 34, kind: 'blue', airborne: false });
        // 空中那颗放在出生侧**最右**的块上（靠近缺口）：跳过去时顺手拿，也提示"再往前就是坑"
        keys.push({ x: midOf(lLast, 0.7), y: this.groundY - 170, kind: 'abyss', airborne: true });
        var rightTotal = Math.max(0, count - 2);
        var rightGround = Math.max(1, need - 1);
        var rightAir = Math.max(0, rightTotal - rightGround);
        for (var r1 = 0; r1 < rightGround; r1++) {
          var t3 = rightGround <= 1 ? 0.5 : r1 / (rightGround - 1);
          var gr = right.length ? right[clamp(Math.round(t3 * (right.length - 1)), 0, right.length - 1)] : null;
          if (!gr) break;
          keys.push({ x: midOf(gr, t3 < 0.5 ? 0.35 : 0.65), y: this.groundY - 34, kind: 'blue', airborne: false });
        }
        // 另一侧的空中钥匙：放在缺口**右侧第一块的边缘**（不是缺口正上方）——
        // 放在缺口上方会变成"站在出生侧边缘起跳就能捞到"，同侧凑齐 3 颗，跨缺口就白设计了。
        var firstRight = right[0] || null;
        for (var r2 = 0; r2 < rightAir; r2++) {
          keys.push({
            x: firstRight ? Math.min(firstRight.x1 - 60, firstRight.x0 + 70) : this.levelWidth * 0.6,
            y: this.groundY - 170 - r2 * 18,
            kind: (r2 % 2 === 0 ? 'abyss' : 'corrupt'), airborne: true
          });
        }
      } else {
        // ---- 平厅 × 塌陷（现状，行为不变）----
        for (var i = 0; i < need; i++) {
          var t = need <= 1 ? 0.5 : i / (need - 1);
          var g = pickGroup(t);
          if (!g) break;
          keys.push({ x: midOf(g), y: this.groundY - 34, kind: 'blue', airborne: false });
        }
        var air = Math.max(0, count - need);
        for (var j = 0; j < air; j++) {
          var g2 = pickGroup((j + 1) / (air + 1));
          if (!g2) break;
          keys.push({
            x: midOf(g2, 0.65),
            y: this.groundY - 170 - j * 18,
            kind: (j % 2 === 0 ? 'abyss' : 'corrupt'), airborne: true
          });
        }
      }

      keys.forEach(function (k) {
        self.spawnCrystal(k.x, clamp(k.y, 60, self.groundY - 20), k.kind);
        var c = self.crystals[self.crystals.length - 1];
        if (c) { c.isKey = true; c.airborne = !!k.airborne; }
      });
    }

    /** 地面块塌掉时，把还没拿的地面钥匙抛到右侧安全块（避免死局） */
    relocateCollapseKey(c, fallenIndex) {
      var C = this.collapse;
      if (!C || !c || c.taken) return;
      // 目标：这块右侧最近的安全块（断桥跨区时也成立）；没有就退回最近的
      var from = C.groups[fallenIndex];
      var idx = from ? this.nextSafeBlockAfter(from.x1 - 1) : -1;
      if (idx < 0) idx = this.nearestCollapseBlockIndex(c.core ? c.core.x : this.hero.x);
      var next = C.groups[idx];
      if (!next) return;
      var nx = next.x0 + Math.max(60, Math.min(110, (next.x1 - next.x0) * 0.5));
      // 连续塌两段会连续抛两颗到同一段 —— 原来都落在同一个点上，看起来像一颗。
      // 这里按 56px 往右找空位（段内 clamp），最多挪 3 格。
      for (var off = 0; off < 4; off++) {
        var cand = Math.min(next.x1 - 40, nx + off * 56);
        var busy = this.crystals.some(function (c2) {
          return c2 && !c2.taken && c2.isKey && !c2.airborne && c2.core &&
            Math.abs(c2.core.x - cand) < 40;
        });
        if (!busy) { nx = cand; break; }
      }
      var ny = this.groundY - 34;
      var kind = c.kind || 'blue';
      c.taken = true;
      this.cleanCrystalFx(c);
      if (c.core) c.core.destroy();
      this.spawnCrystal(nx, ny, kind);
      var nc = this.crystals[this.crystals.length - 1];
      if (nc) { nc.isKey = true; nc.airborne = false; }
      this.showFloat(nx, ny - 24, '魂晶被抛向前方', '#c79aff', 14);
    }

    /** 塌陷计数：魂晶拾取时由 takeCrystal 调用 */
    onCollapseCollect() {
      var C = this.collapse;
      if (!C || C.ended) return;
      var o = this.roomObjective;
      if (!o || o.type !== 'collect') return;
      if (o.got >= o.need) return;
      o.got++;
      if (o.got >= o.need) { o.done = true; this.unlockCollapse(false); }
      this.updateCollapseRunes(true);
    }

    /** 出口解锁（强制 = 兜底，无速度奖励） */
    unlockCollapse(forced) {
      var C = this.collapse;
      if (!C || C.unlocked) return;
      C.unlocked = true;
      C.forced = !!forced;
      // ⚠️ 只标 done，不改 got —— got 是"实际收集数"，强制解锁时玩家可能只拿到 1 颗，
      // 结算/统计必须显示真实值（把 got 改成 need 会伪造成绩）。
      if (this.roomObjective) this.roomObjective.done = true;
      if (this.portal) { this.portal.setVisible(true).setAlpha(1); }
      this.updateCollapseRunes(true);
      sfx('doorUnlock');
      var pulse = this.add.circle(this.portal ? this.portal.x : this.levelWidth - 100,
        this.portal ? this.portal.y - 30 : this.groundY - 70, 10, 0x73f0b4, 0.3).setDepth(11);
      pulse.setStrokeStyle(2, 0xffffff, 0.9);
      this.tweens.add({ targets: pulse, radius: 90, alpha: 0, duration: 420, onComplete: function () { pulse.destroy(); } });
      var remaining = C.groups.filter(function (g) { return g.state !== 'fallen'; }).length;
      C.exitRemaining = remaining;
      if (!forced) {
        // ===== 奖励（初步设想 §9.6 四条，2.9.2 补齐后两条）=====
        //   基础 → 由 onRoomCleared → settleRoomGold 发（下面 openPortal 触发）
        //   提前 → 剩余段数 × 2
        //   收集 → 超出需求的每颗 +3 金币
        //   无伤 → 全程没掉进深渊：额外 1 颗普通魂晶，放在出口左侧地面上
        //          （不放天上：门已经开了，玩家可能直接进门，够得着才有意义）
        var bonus = remaining * 2;
        var gotN = (this.roomObjective && this.roomObjective.got) || 0;
        var overCollect = Math.max(0, gotN - C.params.need);
        var collectBonus = overCollect * 3;
        var noHit = (C.stats.falls || 0) === 0;
        this.points += bonus + collectBonus;
        var parts = ['速度 +' + bonus];
        if (collectBonus > 0) parts.push('收集 +' + collectBonus);
        if (noHit) {
          parts.push('无伤 · 魂晶 +1');
          var ax = Math.max(160, (this.portal ? this.portal.x : this.levelWidth - 100) - 150);
          this.spawnCrystal(ax, this.groundY - 40, 'blue');
          var gift = this.crystals[this.crystals.length - 1];
          if (gift) { gift.isKey = false; gift.airborne = false; }
        }
        this.showCenter('封印解除 · 出口开启（' + parts.join(' · ') + '）', '#73f0b4');
      } else {
        this.showCenter('封印崩解 · 出口开启（无速度奖励）', '#ff8a7a');
      }
      // ===== 结算（2.9.1 修）=====
      // 「门开了」必须等于「这间房清空了」：原来这里直接 this.portalOpen = true，
      // 绕过了 openPortal 里的 if (first) 整块 —— 于是宿主收不到 rt:room-cleared
      // （金币 / 经验 / 三选一 / 精英遗物全都不发）、也不自动存档、腐化脉冲不加速。
      // 先置 false 再 openPortal(true)，让 openPortal 认领 first，
      // quiet=true 是为了不用「房间已清空」盖掉上面这句机制自己的提示。
      this.portalOpen = false;
      this.openPortal(true);
      this.refreshHud();
    }

    /** 这一块是不是时间轴上的最后一块（出口所在的那一块） */
    isLastCollapseBlock(i) {
      var C = this.collapse;
      if (!C || !C.order || !C.order.length) return false;
      return i === C.order[C.order.length - 1];
    }

    /** 塌陷一块：关掉这一块的碰撞、盖上遮罩 */
    collapseFallGroup(i) {
      var C = this.collapse;
      if (!C) return;
      var g = C.groups[i];
      if (!g || g.state === 'fallen') return;
      g.state = 'fallen';
      g.tiles.forEach(function (t) {
        if (t.body) t.body.enable = false;
      });
      C.frontier = Math.max(C.frontier, i);
      // 这一块上还没拿的地面钥匙 → 抛到右侧安全块（否则会跟着地面一起消失，变成死局）
      // ⚠️ 最后一块不抛：出口就在它上面，抛过去反而把钥匙扔进虚空
      if (!this.isLastCollapseBlock(i)) {
        var self = this;
        this.crystals.forEach(function (c) {
          if (!c || c.taken || !c.isKey || c.airborne) return;
          if (c.core && c.core.x >= g.x0 && c.core.x <= g.x1) self.relocateCollapseKey(c, i);
        });
      }
      this.drawCollapseMask();
      sfx('collapseFall');
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(180, 0.007);
      for (var s = 0; s < 6; s++) {
        this.spark(g.x0 + rnd(0, g.x1 - g.x0), this.groundY - 6, 0xc86a4a);
      }
      this.showFloat((g.x0 + g.x1) / 2, this.groundY - 90, '地面塌陷！', '#ff8a7a', 16);
      if (this.isLastCollapseBlock(i)) this.endCollapse();
    }

    collapseWarnGroup(i) {
      var C = this.collapse;
      if (!C) return;
      var g = C.groups[i];
      if (!g) return;
      g.state = 'warn';
      C.warnIndex = i;
      C.warnUntil = this.time.now + C.params.warn;
      sfx('collapseWarn');
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(70, 0.002);
      // 双层：下层塌到一半 → 上层同步预警（整块崩塌，只有这一条时间轴）
      if (C.deck && !C.deck.fallen && !C.deck.warned && i === C.order[C.deck.warnGroup]) {
        C.deck.warned = true;
        C.deck.warnAt = this.time.now;
        C.deck.fallAt = this.time.now + C.params.deckWarn;
        this.showFloat(this.hero.x, Math.max(80, C.deck.y - 40), '上层开始崩解！', '#5fd0e0', 17);
      }
      // 最后一块（出口所在块）开始预警 → 强制解锁兜底
      if (this.isLastCollapseBlock(i)) this.unlockCollapse(true);
    }

    /** 上层（双层）每帧推进：青裂纹预警 → 到点整块崩塌 */
    updateCollapseDeck(dt, time) {
      var C = this.collapse, D = C && C.deck;
      if (!D || D.fallen) return;
      var g = D.fx;
      if (g) {
        g.clear();
        if (D.warned) {
          var left = Math.max(0, D.fallAt - time);
          var k = 1 - left / Math.max(1, C.params.deckWarn);
          var a = 0.06 + 0.14 * k + 0.05 * Math.sin(time / 60);
          D.fx.setVisible(true);
          D.tiles.forEach(function (c) {
            // 青色裂纹：逐块描一圈，整体抖动靠相机
            g.lineStyle(2, 0x5fd0e0, Math.min(0.9, a + 0.35));
            g.strokeRect(c.x - 32, c.y - 32, 64, 64);
          });
        }
      }
      if (D.warned && time >= D.fallAt) this.collapseDeck();
    }

    /**
     * 双层：上层整块崩塌
     * 三条规则（方案 §5.4）：
     *   1. 玩家在上层 → 震落到当前安全块，**不扣血**，0.6s 无敌
     *   2. 上层没拿的钥匙 → 抛到下层右侧安全块
     *   3. 上层站着的怪 → 掉到下层，落地 0.5s 硬直（直接消失会让"清怪"太便宜）
     */
    collapseDeck() {
      var C = this.collapse, D = C && C.deck;
      if (!D || D.fallen) return;
      D.fallen = true;
      var now = this.time.now;
      D.tiles.forEach(function (t) { if (t && t.destroy) t.destroy(); });
      D.strips.forEach(function (s) { if (s && s.destroy) s.destroy(); });
      if (D.fx) { D.fx.clear(); D.fx.destroy(); D.fx = null; }
      this.platformTiles = this.platformTiles.filter(function (t) { return D.tiles.indexOf(t) < 0; });
      this.platformStrips = (this.platformStrips || []).filter(function (s) { return D.strips.indexOf(s) < 0; });
      this.platformPerches = this.platformPerches.filter(function (p) { return !p.deck; });
      // 支撑柱 / 段端侧壁必须跟着上层一起消失 —— 否则半空中会漂着几根柱子和两条侧壁，
      // 玩家会以为"上面还有东西"（实机第一眼就是这个观感）
      if (this.platformDecor && this.platformDecor.length) {
        this.platformDecor.forEach(function (o) { if (o && o.destroy) o.destroy(); });
        this.platformDecor = [];
      }

      // 1) 玩家在上层 → 震落（不扣血，不算掉落）
      var h = this.hero;
      if (!this.heroDead && h.y < D.y + 24) {
        this.teleportHeroTo(this.collapseRespawnX(), { invuln: 600, lock: 200 });
        this.showFloat(h.x, h.y - 80, '你被震落', '#5fd0e0', 16);
      }
      // 2) 上层还没拿的钥匙 → 抛到下层安全块
      var self = this;
      this.crystals.forEach(function (c) {
        if (!c || c.taken || !c.isKey) return;
        if (!c.core || c.core.y >= D.y + 30) return;
        self.relocateCollapseKey(c, self.nearestCollapseBlockIndex(c.core.x));
      });
      // 3) 上层站着的怪 → 掉到下层（飞行怪直接下移，否则悬空）
      this.enemies.forEach(function (e) {
        if (!e || !e.alive || !e.sprite) return;
        if (e.sprite.y >= D.y + 60) return;
        if (e.def && e.def.fly) {
          e.sprite.y = self.groundY - 130;
          e.sprite.setVelocity(0, 0);
        } else {
          e.sprite.setVelocityY(120);
        }
        e.hurtUntil = Math.max(e.hurtUntil || 0, now + 500);
      });

      // 时间轴缓冲 1.5s：让玩家落地站稳，再继续塌下层
      C.warnUntil += 1500;
      C.nextWarnAt += 1500;
      this.drawCollapseMask();
      sfx('collapseFall');
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(360, 0.008);
      this.showCenter('上层崩塌 · 房间退化为平厅塌陷', '#5fd0e0');
    }

    /** 离 x 最近的「还要塌或还安全」的块下标（用于震落 / 抛钥匙） */
    nearestCollapseBlockIndex(x) {
      var C = this.collapse;
      if (!C) return 0;
      var best = -1, bestD = Infinity;
      for (var i = 0; i < C.groups.length; i++) {
        var g = C.groups[i];
        if (g.pre || g.state === 'fallen') continue;
        var d = (x >= g.x0 && x <= g.x1) ? 0 : Math.min(Math.abs(x - g.x0), Math.abs(x - g.x1));
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) {
        for (var j = 0; j < C.groups.length; j++) { if (C.groups[j].state !== 'fallen') return j; }
        return 0;
      }
      return best;
    }

    /** 遮罩：一条整地面 + 若干深色矩形盖住已塌的块（绘制次数不随块数增长） */
    drawCollapseMask() {
      var C = this.collapse, g = C && C.maskGfx;
      if (!g) return;
      g.clear();
      C.groups.forEach(function (grp) {
        if (grp.state !== 'fallen') return;
        // 断桥的天然缺口：更暗一档，和"刚塌的"区分开（一个是陈年，一个是正在发生）
        g.fillStyle(grp.pre ? 0x02040a : 0x04060d, 1);
        g.fillRect(grp.x0, this.groundY - 2, grp.x1 - grp.x0, 96);
      }, this);
      // 不再描紫色断面线：相邻已塌段之间会留下一条条竖线，看起来像地面被切开。
      // 深色遮罩本身就形成了清晰的断口，不需要额外描边。
    }

    /** 预警覆盖层（每帧重画，带呼吸） */
    drawCollapseWarn(time) {
      var C = this.collapse, g = C && C.warnGfx;
      if (!g) return;
      g.clear();
      if (!C || C.warnIndex < 0) return;
      var grp = C.groups[C.warnIndex];
      if (!grp) return;
      var left = Math.max(0, C.warnUntil - time);
      var k = 1 - left / Math.max(1, C.params.warn);
      var a = 0.10 + 0.16 * (0.5 + 0.5 * Math.sin(time / 70)) + k * 0.12;
      g.fillStyle(0xc83a4a, Math.min(0.5, a));
      // 预警层高度随视口（§2.10）：短屏上 72px 占 20% 屏高，太厚
      g.fillRect(grp.x0, this.groundY - 2, grp.x1 - grp.x0, Math.max(48, Math.round(72 * this.mechScale())));
      g.lineStyle(2, 0xff8a7a, 0.55 + 0.3 * k);
      g.beginPath(); g.moveTo(grp.x0, this.groundY - 2); g.lineTo(grp.x1, this.groundY - 2); g.strokePath();
      if (time - C.lastSparkAt > 120) {
        C.lastSparkAt = time;
        this.spark(rnd(grp.x0, grp.x1), this.groundY - 4, 0xc86a4a);
      }
    }

    /** 门上的 3 个符文凹槽 + 小字进度（不新增 HUD） */
    updateCollapseRunes(force) {
      var C = this.collapse;
      if (!C || !C.runeGfx || !this.portal) return;
      var got = (this.roomObjective && this.roomObjective.got) || 0;
      var key = got + '|' + (C.unlocked ? 1 : 0);
      if (!force && C.lastRuneGot === key) return;
      C.lastRuneGot = key;
      var g = C.runeGfx, px = this.portal.x, py = this.portal.y - 92;
      var slots = this.roomObjective ? Math.max(1, this.roomObjective.need) : 3;
      // 尺寸随视口（§2.10）：短屏收一档，但宽度不低于 10、高度不低于 12（施工清单 §9.3）
      var k = this.mechScale();
      var w = Math.max(10, Math.round((slots > 3 ? 10 : 12) * k));
      var gap = Math.max(4, Math.round((slots > 3 ? 5 : 7) * k));
      var hh = Math.max(12, Math.round(14 * k));
      var total = w * slots + gap * (slots - 1);
      g.clear();
      for (var i = 0; i < slots; i++) {
        var x = px - total / 2 + i * (w + gap);
        var lit = C.unlocked || i < got;
        g.fillStyle(lit ? 0x5fd0e0 : 0x3a1a4a, lit ? 0.95 : 0.8);
        g.fillRect(x, py, w, hh);
        g.lineStyle(1, lit ? 0xbff4ff : 0x6a3a8a, lit ? 0.9 : 0.5);
        g.strokeRect(x + 0.5, py + 0.5, w - 1, hh - 1);
      }
      if (!C.lockText) {
        C.lockText = this.add.text(px, py + 24, '', {
          fontFamily: FONT, fontSize: '12px', color: UI.accent, fontStyle: 'bold'
        }).setOrigin(0.5).setDepth(12);
        C.lockText.setShadow(0, 1, '#04060f', 4, false, true);
      }
      C.lockText.setPosition(px, py + 24);
      C.lockText.setText(C.unlocked ? '已解封' : ('封印 · ' + got + '/' + (this.roomObjective ? this.roomObjective.need : 3)));
      C.lockText.setColor(C.unlocked ? '#73f0b4' : (got > 0 ? '#8ad8ff' : '#c79aff'));
    }

    /** 右侧最近的安全块下标（没有就 -1） */
    nextSafeBlockAfter(x) {
      var C = this.collapse;
      if (!C) return -1;
      for (var i = 0; i < C.groups.length; i++) {
        var g = C.groups[i];
        if (g.pre || g.state === 'fallen') continue;
        if (g.x1 > x + 8) return i;
      }
      return -1;
    }

    /**
     * 掉进深渊后的落点：**坑右侧最近的安全块**
     * ------------------------------------------------------------
     * 平厅的坑都是"刚塌出来的"，所以「前沿 + 1」永远在右边，两者等价；
     * 但断桥的天然缺口在未塌区域 —— 玩家掉进去时前沿可能还在缺口左侧，
     * 用「前沿 + 1」会把人往左送（违反"不往回送"）。统一成"坑右侧最近安全块"就都对了。
     */
    collapseRespawnX() {
      var C = this.collapse;
      if (!C) return this.pitRespawnX(this.hero.x);
      var x = this.hero.x;
      var idx = this.nextSafeBlockAfter(x);
      if (idx >= 0) {
        var g = C.groups[idx];
        return Math.max(g.x0 + 70, Math.min(g.x1 - 40, x + 60));
      }
      // 右侧没有安全块（已经塌到出口段）→ 退回出口
      return Math.min(this.levelWidth - 150, this.portal ? this.portal.x - 40 : this.levelWidth - 160);
    }

    /** 掉进塌陷深渊：扣血 + 前沿 + 1（被困时可由机制改成不扣血） */
    collapseFallIntoPit() {
      var C = this.collapse, now = this.time.now;
      if (!C || C.ended) {
        this.teleportHeroTo(this.collapseRespawnX(), { invuln: 800 });
        return;
      }
      var h = this.hero;
      var pct = PIT.dmgPct[this.difficulty] || PIT.dmgPct.normal;
      var dmg = Math.max(1, Math.round(h.maxHp * pct));
      h.hp = Math.max(1, h.hp - dmg);
      C.stats.falls++;
      C.stats.damage += dmg;
      this._hurtAt = now;
      this.showFloat(h.x, h.y - 60, '深渊 · -' + dmg, '#ff8a7a', 18);
      this.teleportHeroTo(this.collapseRespawnX(), { invuln: PIT.invuln, lock: PIT.lock });
      this.cameras.main.flash(150, 120, 30, 40);
      sfx('land');
      this.refreshHud();
    }

    /** 塌陷房结束：最后一段塌了 → 在出口生成临时踏板，把玩家抛向出口 */
    endCollapse() {
      var C = this.collapse;
      if (!C || C.ended) return;
      C.ended = true;
      C.exitRemaining = 0;
      this.unlockCollapse(true);
      // 最后一段没了，门下面也没地面 —— 补两格临时踏板，避免"门开了却站不住"
      if (!C.exitLedge) {
        var px = (this.portal ? this.portal.x : this.levelWidth - 100);
        var ly = this.groundY - 10;
        for (var li = 0; li < 2; li++) {
          var lx = px - 144 + 32 + li * 64;
          C.exitLedge = this.solids.create(lx, ly, TEX.platform);
          C.exitLedge.setOrigin(0.5, 0.5).setVisible(false);
          C.exitLedge.refreshBody();
          C.exitLedge._solidDeck = true;
          this.skeletonParts.push(C.exitLedge);
        }
        C.exitLedgeStrip = this.add.tileSprite(px - 144, ly, 128, 64, TEX.platform).setOrigin(0, 0.5).setDepth(3);
        this.skeletonParts.push(C.exitLedgeStrip);
      }
      this.teleportHeroTo(Math.max(20, (this.portal ? this.portal.x : this.levelWidth - 100) - 96), { invuln: 1200 });
      this.showCenter('回廊塌陷 · 你被抛向出口（无速度奖励）', '#ff8a7a');
      this.finishCollapseRun('collapsed');
    }

    /** 完成一局：记录统计（预览页导出 / P5 验收用） */
    finishCollapseRun(reason) {
      var C = this.collapse;
      if (!C || C.recorded) return;
      C.recorded = true;
      C.ended = true;
      C.result = {
        reason: reason || 'exit',
        difficulty: this.difficulty || 'normal',
        time: Math.round(C.elapsed / 100) / 10,
        falls: C.stats.falls,
        collected: this.roomObjective ? this.roomObjective.got : 0,
        need: C.params.need,
        forced: !!C.forced,
        trappedMs: Math.round(C.stats.trappedMs),
        damage: C.stats.damage,
        kills: (this.kills || 0) - C.stats.killsStart,
        interrupts: C.stats.interrupts,
        exitCollapsed: C.exitRemaining != null ? C.exitRemaining : 0,
        freeEscapes: C.stats.freeEscapes,
        roomSkeleton: C.skeleton,
        params: JSON.parse(JSON.stringify(C.params))
      };
      if (!this.collapseRecords) this.collapseRecords = [];
      this.collapseRecords.push(C.result);
      if (this.collapseRecords.length > 300) this.collapseRecords.shift();
      if (this.previewMode) {
        this.previewEnded = true;
        // 预览房结算后定格：结果由页面侧栏展示，不再让敌人把"已完成"的玩家打死
        this.running = false;
        try { this.physics.world.pause(); } catch (e) { /* 忽略 */ }
        this.showCenter('房间结束 · 用时 ' + C.result.time + 's' + (C.result.forced ? '（强制解锁）' : ''), '#f0d06a');
      }
    }

    /** 预览模式：走进传送门 = 完成一局，不打开地图 */
    finishPreviewRun() {
      if (!this.previewMode) return false;
      this.finishCollapseRun('exit');
      return true;
    }

    /** 每帧推进塌陷时间轴 / 刷怪 / 被困检测 / 统计 */
    updateCollapse(dt, time) {
      var C = this.collapse;
      if (!C) return;
      if (!C.ended) C.elapsed += dt;
      this.drawCollapseWarn(time);
      this.updateCollapseRunes(false);

      // --- 时间轴（只走 order：缺口块开局就是已塌，不参与）---
      if (!C.ended) {
        if (C.warnIndex < 0) {
          if (C.nextOrder < C.order.length && time >= C.nextWarnAt) {
            var gi = C.order[C.nextOrder++];
            this.collapseWarnGroup(gi);
          }
        } else if (time >= C.warnUntil) {
          var fallIdx = C.warnIndex;
          C.warnIndex = -1;
          this.collapseFallGroup(fallIdx);
          C.nextWarnAt = time + C.params.interval;
        }
        this.updateCollapseDeck(dt, time);

        // --- 右侧持续刷怪（上限 3，解锁后停止）---
        if (!C.unlocked) {
          var alive = this.enemies.filter(function (e) { return e.alive; }).length;
          if (time >= C.spawnAt && alive < C.maxEnemies) {
            C.spawnAt = time + C.spawnCd;
            this.spawnCollapseEnemy();
          }
        }
      }

      // --- 被困在平台：3s 提示 / 8s 崩解 / 10s 无伤脱困 ---
      // 现在只有「双层」会触发：上层崩掉之后，玩家如果还站在别的残留物上、脚下那块地面已经塌了，
      // 才会被判为被困（平厅没有浮台，这段恒不触发）。
      var h = this.hero;
      var onPlatform = !this.heroDead && (h.body.blocked.down || h.body.touching.down) && h.y < this.groundY - 90;
      var deckAlive = !!(C.deck && !C.deck.fallen);
      var underFallen = false;
      if (onPlatform && !deckAlive) {
        var seg = C.groups.filter(function (g) { return h.x >= g.x0 && h.x < g.x1; })[0];
        underFallen = !!(seg && seg.state === 'fallen');
      }
      if (underFallen && !C.ended) {
        C.stuckMs += dt;
        C.stats.trappedMs += dt;
        if (C.stuckMs >= 3000 && !C.hintShown) {
          C.hintShown = true;
          this.showFloat(h.x, h.y - 110, '深渊会把你送回前方 · 跳下去', '#c79aff', 16);
        }
        if (C.stuckMs >= 8000 && !C.crackShown) {
          C.crackShown = true;
          this.showFloat(h.x, h.y - 110, '平台开始崩解！', '#ff8a7a', 17);
          if (state.settings.screenShake2D !== false) this.cameras.main.shake(400, 0.004);
          for (var s = 0; s < 5; s++) this.spark(h.x + rnd(-40, 40), h.y + 10, 0xc86a4a);
        }
        if (C.stuckMs >= 10000) {
          C.stats.freeEscapes++;
          this.teleportHeroTo(this.collapseRespawnX(), { invuln: 900, lock: 600 });
          this.showFloat(h.x, h.y - 90, '深渊吞噬了这块地面', '#c79aff', 16);
          sfx('collapseFall');
          C.stuckMs = 0; C.hintShown = false; C.crackShown = false;
        }
      } else {
        C.stuckMs = 0; C.hintShown = false; C.crackShown = false;
      }

      // --- 锁着的门：走近提示（3 秒冷却，不刷屏）---
      if (!C.unlocked && this.portal && !this.heroDead &&
        Math.abs(h.x - this.portal.x) < 70 && time >= (C.lockHintAt || 0)) {
        C.lockHintAt = time + 3000;
        var left = (this.roomObjective ? this.roomObjective.need - this.roomObjective.got : 0);
        this.showFloat(h.x, h.y - 110, '出口封印 · 还差 ' + Math.max(0, left) + ' 颗魂晶', '#c79aff', 16);
      }
    }

    /** 刷一只干扰怪：在"下一个还没塌的块"里出，不会一出生就在坑里 */
    spawnCollapseEnemy() {
      var C = this.collapse;
      var pool = poolForFloor(this.floor);
      // 双层：上层还没崩时，有概率把远程怪摆在上面（上层压制 + 崩落后掉下来）
      if (C.deck && !C.deck.fallen && this.platformPerches.length && Math.random() < 0.45) {
        var pc = this.platformPerches[ri(0, this.platformPerches.length - 1)];
        var pick = Math.random() < 0.5 ? 'necro' : 'skeleton';
        var de = this.spawnEnemy(pick, pc.x, pc.y - 4, this.floor);
        if (de) { de.collapseSpawn = true; de.onDeck = true; }
        return;
      }
      var key = pool[ri(0, pool.length - 1)];
      var idx = this.nextSafeBlockAfter(C.frontier >= 0 ? C.groups[C.frontier].x1 - 1 : 140);
      if (idx < 0) idx = this.nearestCollapseBlockIndex(this.hero.x);
      var seg = C.groups[idx];
      var x = seg ? clamp(seg.x0 + 90, 200, this.levelWidth - 160) : this.levelWidth - 240;
      var e = this.spawnEnemy(key, x, this.groundY - 100, this.floor);
      if (e) e.collapseSpawn = true;
    }

    /** 清理塌陷房的对象（换房 / 重开必须调用） */
    destroyCollapse() {
      var C = this.collapse;
      if (!C) return;
      if (C.maskGfx) C.maskGfx.destroy();
      if (C.warnGfx) C.warnGfx.destroy();
      if (C.runeGfx) C.runeGfx.destroy();
      if (C.lockText) C.lockText.destroy();
      if (C.exitLedgeStrip) C.exitLedgeStrip.destroy();
      if (C.deck && C.deck.fx) C.deck.fx.destroy();
      this.collapse = null;
    }

    /* ============================================================
       P4.1 / P4.2 / P4.3：机制选择 + 守点 + 限时
       ============================================================ */

    /** 机制选择（与骨架正交；同一房最多 1 种） */
    pickMechanic(node) {
      if (!node || node.debugRoom || node.noMechanics) return null;
      if (MECHANIC.noMechanicRooms[node.type] || nonCombatRoom(node.type)) return null;
      if (this.floor < MECHANIC.minFloor) return null;
      if (node.mechanic) return node.mechanic;
      // ① 教学三连（2.9.2 F2）：第 3 / 4 / 5 层的第一个可挂机制的房间，固定教一种。
      //    关掉该机制的回退开关时跳过（否则关掉塌陷却还在教塌陷）。
      var teach = MECHANIC.teach[this.floor];
      if (teach && !(this._floorMechanicCount > 0) && this.mechanicEnabled[teach]) return teach;
      // ② 每层保底 1 间（2.9.2 F2）：本层还没有机制房 → 给一间。
      //    这一条取代了原来的「第 5 / 10 / 15… 层保底」—— 那是按 5 层算的，
      //    实测 0.74 间/层，玩家在 10 层里只碰得到 2~3 次机制。
      if (this.floor >= MECHANIC.guaranteeFromFloor && !(this._floorMechanicCount > 0)) {
        return this.pickGuaranteedMechanic();
      }
      var r = Math.random(), acc = 0;
      var order = ['collapse', 'hold', 'timed'];
      for (var i = 0; i < order.length; i++) {
        var k = order[i];
        if (!this.mechanicEnabled[k]) continue;
        acc += MECHANIC.rates[k] || 0;
        if (r < acc) return k;
      }
      return null;
    }

    /**
     * 保底机制的选择（2.9.2 · F2 第 2 条）
     * 优先本层还没出现过的机制 —— 一层里连着两间塌陷，等于把"每层保底"
     * 变成了"每层同一道题"。三种都出现过才回到随便挑。
     */
    pickGuaranteedMechanic() {
      var kinds = this._floorMechanicKinds || {};
      var all = ['collapse', 'hold', 'timed'];
      var self = this;
      var fresh = all.filter(function (k) { return !kinds[k] && self.mechanicEnabled[k]; });
      var pool = fresh.length ? fresh : all.filter(function (k) { return self.mechanicEnabled[k]; });
      if (!pool.length) return null;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    /** 当前难度下的机制参数表（未知难度一律按普通） */
    mechTuning(kind) {
      var d = this.difficulty || 'normal';
      var table = MECH_DIFF[d] || MECH_DIFF.normal;
      return table[kind] || MECH_DIFF.normal[kind];
    }

    /**
     * 机制参数
     * 普通难度 = 预览页实测默认档（8 段 / 4.0s / 3 颗 / 0.8s 预警）；
     * 简单 / 困难 / 地狱在此基准上缩放（见 MECH_DIFF）。
     * 层数只用于奖励与敌人强度，不再改机制参数 —— 实测数据表明
     * 8/4.0/3 这一档在普通难度下节奏成立，先以难度为唯一缩放轴。
     */
    mechanicParams(kind, node) {
      var f = this.floor || 1;
      var tune = this.mechTuning(kind);
      if (kind === 'collapse') {
        return {
          floor: f, segments: tune.segments, interval: tune.interval, warn: tune.warn,
          need: tune.need, crystalCount: Math.max(5, tune.need + 2), maxEnemies: tune.enemies
        };
      }
      if (kind === 'hold') {
        var wc = CORE.waveCurve;
        var curveT = clamp((f - wc.floorLo) / (wc.floorHi - wc.floorLo), 0, 1);
        var base = wc.lo + (wc.hi - wc.lo) * curveT;
        var perWave = clamp(Math.round(base * tune.waveMul), 3, 24);
        var cap = clamp(Math.round(perWave * 0.8), 3, 14);
        return {
          floor: f, waves: tune.waves, waveMul: tune.waveMul, perWave: perWave, cap: cap,
          dur: tune.dur, hp: tune.hp, mul: tune.mul,
          // 核心血量 = 基准 + 层数 × 2（只随层数线性小涨；单次伤害才随层数放大）
          coreMax: Math.round(tune.hp + f * 2)
        };
      }
      if (kind === 'timed') {
        return { floor: f, need: tune.need };
      }
      return { floor: f };
    }

    startMechanic(node) {
      var k = this._roomMechanic;
      if (!k) return;
      var p = this.mechanicParams(k, node);
      if (k === 'collapse') {
        // 断桥：可站立面积比平厅小、跨缺口还要蓄力跳 —— 块数 −2、间隔 ×1.125（方案 §6.2）。
        // 只对这一格生效；断桥 × 守点 / 限时 不受影响。
        if (this.roomSkeleton === 'bridge') {
          p.segments = Math.max(4, p.segments - 2);
          p.interval = Math.round(p.interval * 1.125);
        }
        // 双层：上层整块崩塌的预警时长（方案 §5.1 的 2.0s，按难度缩放）
        p.deckWarn = Math.round(p.warn * 2.5);
        this.startCollapse(p);
      }
      else if (k === 'hold') this.startHold(p);
      else if (k === 'timed') this.startTimed(p);
    }

    /* ============================================================
       守点 · 守住核心（2.9.2 §3）
       ------------------------------------------------------------
       旧版是「站进圈里凑 8 秒」：站着不动就能过，圈还优先放在最高的平台上，
       近战怪爬不上来 —— 三件事叠起来，这间房等于没有压力（反馈 §3.1）。
       新规则（反馈 §3.2–§3.9）：
         · 圈心生成核心，尸潮从两侧涌入并**优先打核心**；袭击持续 dur 毫秒；
         · 时间到就结束，不看玩家站了多久；按核心剩余血量发奖；
         · 圈从「目标」变成「护罩范围」：站进去，核心受伤减半；
         · 核心碎 ≠ 卡关：门照开，只是没有奖励。
       ============================================================ */
    startHold(opts) {
      this.destroyHoldZone();
      var p0 = opts || {};
      var tune = this.mechTuning('hold');
      var dur = p0.dur || tune.dur;
      var coreMax = p0.coreMax || Math.round((p0.hp || tune.hp) + this.floor * 2);
      // 圈半径随视口（§2.10）：同一间房在 360 和 720 上占屏比例差一倍，判定宽严也跟着变
      var r0 = Math.round(clamp(this.scale.height / 720 * 72, 58, 86));
      var spot = this.pickCoreSpot(r0);
      var x = spot.x, surface = spot.surface;
      // 圈心略高于地表：护罩是一顶罩子，圆心不该贴在地面线上
      var cy = surface - 24;
      var self = this;

      // ---------- 美术：核心 / 血条 / 护罩穹顶 ----------
      var sprite = this.add.image(x, surface + 4, TEX.coreOk).setOrigin(0.5, 1).setDepth(6);
      var barY = surface - 72;
      var barPlate = this.add.image(x, barY, TEX.coreBar).setOrigin(0.5, 0).setDepth(13);
      var barG = this.add.graphics().setDepth(13);
      var shield = this.add.image(x, cy, TEX.shieldCalm).setDepth(3).setAlpha(0.55);
      shield.setScale(r0 / 86);
      var warnRing = this.add.image(x, cy, TEX.warnRing).setDepth(12).setAlpha(0).setVisible(false);
      var gfx = this.add.graphics().setDepth(4);
      // 屏幕两侧裂纹：scrollFactor(0) 贴在画框上，跟房间内位置无关
      var mkCrack = function (tex, px) {
        var img = self.add.image(px, self.scale.height * 0.5, tex)
          .setScrollFactor(0).setDepth(900).setAlpha(0).setVisible(false);
        img.setOrigin(px < self.scale.width / 2 ? 0 : 1, 0.5);
        return img;
      };
      var crackL = mkCrack(TEX.warnCrackL, 0);
      var crackR = mkCrack(TEX.warnCrackR, this.scale.width);

      var text = this.add.text(x, barY - 14, '走近核心 · 未启动', {
        fontFamily: FONT, fontSize: '13px', color: '#5fd0e0', fontStyle: 'bold'
      }).setOrigin(0.5).setDepth(14);
      text.setShadow(0, 1, '#04060f', 4, false, true);

      var waveAt = CORE.waveAt.map(function (v) { return Math.round(dur * v); });

      this.holdZone = {
        x: x, y: cy, surface: surface, r: r0, r0: r0,
        coreX: x, coreY: surface - 40,
        dur: dur, t: 0, prog: 0,
        // 2.9.4 H1-H3：第一次踏入护罩才启动计时、波次与核心仇恨
        started: false, startAt: 0,
        // 兼容字段：need = 总时长（进度弧用它），got = 已过去的毫秒
        need: dur, got: 0,
        coreHp: coreMax, coreMax: coreMax, coreAlive: true,
        waveIdx: 0, waveAt: waveAt, queue: [], nextSpawnAt: 0, spawnStartAt: 0,
        spawnSide: 1, waveSpawned: 0, forceRanged: !!spot.forceRanged, spotWhere: spot.where,
        mul: p0.mul || tune.mul,
        perWave: p0.perWave || this.mechanicParams('hold').perWave,
        cap: p0.cap || this.mechanicParams('hold').cap,
        ended: false, unlocked: false, outcome: null, goldMul: 1, frozen: false,
        sprite: sprite, barPlate: barPlate, barG: barG, barX: x, barY: barY,
        shield: shield, warnRing: warnRing, cracks: [crackL, crackR],
        gfx: gfx, text: text, lastHudAt: 0, nextHitAt: 0, hitFlashUntil: 0,
        lastInputAt: 0, idleAt: 0, critTween: null
      };
      this.roomObjective = { type: 'hold', need: dur, got: 0, done: false };
      this.portalOpen = false;
      if (this.portal) this.portal.setVisible(true).setAlpha(0.35);
      this.paintCoreState();
      this.paintCoreBar();
      this.showCenter('守点房 · 走进青色护罩，袭击才会开始', '#5fd0e0');
      this.refreshHud();
    }

    /**
     * 圈心选址（反馈 §3.5 —— "发呆"的根因就在这里）
     * 优先级：地面段 > 中低平台 > 高台（且强制远程/飞行）> 兜底地面中央。
     * 旧实现是「合格里取最高」，而圈=护罩之后，圈放在怪爬不上的高台上等于白给。
     */
    pickCoreSpot(r0) {
      var self = this;
      var safeTop = this.hudSafeTop();
      var needTop = safeTop + r0 + 30;      // 30 = 血条 + 文字 + 间隙
      var needW = r0 * 2 + 80;              // 圈所在的段至少要放得下圈 + 两侧留白
      var midX = this.levelWidth * 0.55;

      // ① 地面段：非缺口、离出口 ≥300px、可用宽度 ≥ 2r+80
      //    两端按"放得下圈"收边（左 200 / 右 300），而不是要求整段都落在这个区间 ——
      //    平厅的地面段本来就从 0 拉到关卡外，整段判会把所有平厅都排掉。
      var segs = (this.groundSegments && this.groundSegments.length)
        ? this.groundSegments : [{ x0: 0, x1: this.levelWidth }];
      var okSegs = [];
      segs.forEach(function (s) {
        var a = Math.max(200, s.x0);
        var b = Math.min(self.levelWidth - 300, s.x1);
        if (b - a >= needW) okSegs.push({ a: a, b: b });
      });
      if (okSegs.length) {
        okSegs.sort(function (a, b) {
          return Math.abs((a.a + a.b) / 2 - midX) - Math.abs((b.a + b.b) / 2 - midX);
        });
        var s0 = okSegs[0];
        var px = Math.round(clamp((s0.a + s0.b) / 2, s0.a + r0 + 40, s0.b - r0 - 40));
        return { x: px, surface: this.groundSurfaceAt(px), forceRanged: false, where: 'ground' };
      }

      // ② 中低平台（y ≥ groundY − 160）：低处才够得着、护罩才有意义
      var perches = (this.platformPerches || []).slice().filter(function (p) {
        return p.x > 260 && p.x < self.levelWidth - 260;
      });
      var low = perches.filter(function (p) {
        return p.y >= self.groundY - 160 && p.y - 6 >= needTop;
      });
      if (low.length) {
        low.sort(function (a, b) { return b.y - a.y; });   // 最低的优先
        return { x: Math.round(low[0].x), surface: low[0].y - 6, forceRanged: false, where: 'perch-low' };
      }

      // ③ 高台：只能用高台时，本波**强制**至少 2 远程 + 1 飞行（否则又是白给）
      var high = perches.filter(function (p) { return p.y - 6 >= needTop; });
      if (high.length) {
        high.sort(function (a, b) { return b.y - a.y; });
        return { x: Math.round(high[0].x), surface: high[0].y - 6, forceRanged: true, where: 'perch-high' };
      }

      // ④ 全都不合格：退到地面中央（不出屏优先）
      var fx = Math.round(midX);
      return { x: fx, surface: this.groundSurfaceAt(fx), forceRanged: false, where: 'fallback' };
    }

    /** 核心血量比例 0~1 */
    coreRatio() {
      var H = this.holdZone;
      return H ? clamp(H.coreHp / Math.max(1, H.coreMax), 0, 1) : 0;
    }

    /** 玩家是否站在护罩里（圈的唯一作用） */
    coreShielded() {
      var H = this.holdZone, h = this.hero;
      if (!H || !h || this.heroDead) return false;
      return Math.abs(h.x - H.x) <= H.r && Math.abs((h.y - 20) - H.y) <= H.r * 0.9;
    }

    /** 核心受击：同一核心 0.3s 内最多结算 1 次 */
    damageCore(amount, source) {
      var H = this.holdZone;
      if (!H || !H.coreAlive || H.ended || H.frozen) return 0;
      // 2.9.4 H2：进圈前的任何伤害来源都不能碰核心
      if (TOGGLES.holdGate && !H.started) return 0;
      var now = this.time.now;
      if (now < (H.nextHitAt || 0)) return 0;
      H.nextHitAt = now + CORE.hitCd;
      // 单次伤害 = 基础 × 难度系数 × (1 + 层数 × 0.03)；护罩内减半
      var mul = (H.mul || 1) * (1 + this.floor * 0.03);
      if (this.coreShielded()) mul *= CORE.shieldMul;
      var dmg = Math.max(1, Math.round(amount * mul));
      H.coreHp = Math.max(0, H.coreHp - dmg);
      H.hitFlashUntil = now + 150;
      this.showFloat(H.x + rnd(-12, 12), H.coreY - 30, '-' + dmg, '#ff8a7a', 16);
      this.cameras.main.flash(80, 110, 36, 46);
      this.paintCoreState();
      this.paintCoreBar();
      this.refreshHud();
      if (H.coreHp <= 0) this.breakCore();
      return dmg;
    }

    /** 核心碎裂 → 失守（不是死亡）：门照开，没有奖励 */
    breakCore() {
      var H = this.holdZone;
      if (!H || !H.coreAlive) return;
      H.coreAlive = false;
      this.finishHold('break');
    }

    /** 按血量比例换核心状态图 + 濒碎的红闪抖动 */
    paintCoreState() {
      var H = this.holdZone;
      if (!H || !H.sprite) return;
      var ratio = this.coreRatio();
      var key = ratio >= 0.7 ? TEX.coreOk
        : ratio >= 0.35 ? TEX.coreHurt
          : (H.coreHp > 0 ? TEX.coreCrit : TEX.coreBroken);
      if (H.sprite.texture.key !== key) H.sprite.setTexture(key);
      if (H.critTween) { H.critTween.stop(); H.critTween = null; H.sprite.setAlpha(1); }
      if (ratio < 0.35 && H.coreHp > 0) {
        H.critTween = this.tweens.add({
          targets: H.sprite, alpha: 0.62, duration: 210, yoyo: true, repeat: -1
        });
      }
    }

    /** 核心血条：就地画（不进 HUD），段位颜色按比例变 */
    paintCoreBar() {
      var H = this.holdZone;
      if (!H || !H.barG) return;
      var g = H.barG;
      g.clear();
      if (!H.barPlate || !H.barPlate.active) return;
      var ratio = this.coreRatio();
      var col = ratio >= 0.7 ? 0x73f0b4 : ratio >= 0.35 ? 0xffd76a : 0xff6a6a;
      var w = Math.round(62 * ratio);
      if (w <= 0) return;
      g.fillStyle(col, 0.95);
      g.fillRect(H.barX - 31, H.barY + 1, w, 8);
      g.fillStyle(0xffffff, 0.22);
      g.fillRect(H.barX - 31, H.barY + 1, w, 1);
    }

    /** 守点圈：圆 + 袭击进度弧 + 护罩穹顶。每帧重画（一个 Graphics，成本可忽略） */
    drawHoldZone(time) {
      var H = this.holdZone;
      if (!H || !H.gfx) return;
      var g = H.gfx;
      var shielded = this.coreShielded();
      var dormant = TOGGLES.holdGate && !H.started && !H.ended;
      var k = Math.min(1, H.t / H.dur);
      g.clear();
      g.fillStyle(0x5fd0e0, dormant ? 0.035 :
        (shielded ? 0.13 : 0.06) + 0.03 * (0.5 + 0.5 * Math.sin(time / 260)));
      g.fillCircle(H.x, H.y, H.r);
      g.lineStyle(2, shielded ? 0x73f0b4 : 0x5fd0e0, dormant ? 0.30 : (shielded ? 0.72 : 0.40));
      g.strokeCircle(H.x, H.y, H.r);
      // 未启动不画进度弧：圈是"走进去的开关"，不是已经在跑的计时器
      if (!dormant) {
        g.lineStyle(4, H.ended ? 0x73f0b4 : 0xffd76a, 0.9);
        g.beginPath();
        g.arc(H.x, H.y, H.r - 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k, false);
        g.strokePath();
      }
      // 穹顶格架：常态 / 收缩中 / 受击闪 三张图，随护罩半径缩放
      var sh = H.shield;
      if (sh && sh.active) {
        var key = time < (H.hitFlashUntil || 0) ? TEX.shieldHit
          : (H.r < H.r0 ? TEX.shieldTight : TEX.shieldCalm);
        if (sh.texture.key !== key) sh.setTexture(key);
        sh.setPosition(H.x, H.y).setScale(H.r / 86);
        if (dormant) {
          sh.setAlpha(0.28 + 0.07 * (0.5 + 0.5 * Math.sin(time / 1600 * Math.PI * 2)));
        } else {
          sh.setAlpha(shielded ? 0.95 : (H.r < H.r0 ? 0.70 : 0.55));
        }
      }
    }

    /** 2.9.4 H1：第一次踏进护罩，计时 / 波次 / 核心仇恨同时启动 */
    tryStartHold(H, time) {
      var h = this.hero;
      if (!H || H.started || !h || this.heroDead) return false;
      // 用 r0 与初始护罩同口径；启动后才允许收缩到 0.8r
      if (Math.abs(h.x - H.x) > H.r0) return false;
      if (Math.abs((h.y - 20) - H.y) > H.r0 * 0.9) return false;
      H.started = true;
      H.startAt = time;
      H.t = 0; H.prog = 0; H.got = 0;
      H.waveIdx = 0;
      H.lastInputAt = time; H.idleAt = 0;
      if (this.roomObjective) this.roomObjective.got = 0;
      this.showCenter('袭击开始 · 守住核心 ' + Math.round(H.dur / 1000) + ' 秒', '#ffd76a');
      sfx('holdStart');
      this.refreshHud();
      return true;
    }

    updateHold(dt, time) {
      var H = this.holdZone;
      if (!H) return;
      if (H.ended) { this.drawHoldZone(time); return; }

      // 没进圈：时间不走、波次不刷、核心不挨打、挂机不判定，只画休眠护罩
      if (TOGGLES.holdGate && !H.started) {
        this.tryStartHold(H, time);
        this.drawHoldZone(time);
        return;
      }

      // 时间轴推进：启动后不看玩家状态，跑出圈也不会暂停
      H.t = Math.min(H.dur, H.t + dt);
      H.prog = H.t / H.dur;
      H.got = H.t;
      if (this.roomObjective) this.roomObjective.got = H.t;

      // 波次：0% / 25% / 50% 各一波。上一波没清完也照刷 —— 压力叠加，只受同屏上限约束
      while (H.waveIdx < H.waveAt.length && H.t >= H.waveAt[H.waveIdx]) {
        H.waveIdx++;
        this.queueWave(H, time);
      }
      this.updateWaveQueue(H, time);

      // 护罩收缩（60% 进度起缩小 20%）：后期必须贴着核心打
      var want = H.prog >= CORE.shrinkAt ? Math.round(H.r0 * CORE.shrinkMul) : H.r0;
      if (want !== H.r) {
        H.r = want;
        if (H.warnRing) H.warnRing.setScale(H.r / 86);
      }

      // 挂机判定：读输入层，不读位移（原地攻击 / 喝药 / 放技能都不算挂机）
      this.checkHoldIdle(H, time);

      this.drawHoldZone(time);
      var pct = Math.round(this.coreRatio() * 100);
      H.text.setText('袭击 ' + Math.ceil((H.dur - H.t) / 1000) + 's · 核心 ' + pct + '%');
      H.text.setColor(this.coreShielded() ? '#73f0b4' : '#5fd0e0');
      // 濒碎：偶尔抖一下镜头（图给不了"快没了"的紧迫感，镜头可以）
      if (this.coreRatio() < 0.35 && Math.random() < 0.03) {
        this.cameras.main.shake(60, 0.002);
      }
      if (time - H.lastHudAt > 200) { H.lastHudAt = time; this.refreshHud(); }

      // 三个出口（反馈 §3.7）：时间到 / 核心碎 / 最后一波被清光
      if (H.t >= H.dur) { this.finishHold('time'); return; }
      if (H.waveIdx >= H.waveAt.length && !H.queue.length) {
        var alive = this.enemies.filter(function (e) { return e.alive; }).length;
        if (alive === 0) this.finishHold('clear');
      }
    }

    /** 一波的出场顺序：本波内洗牌，至少 2 只远程；第 6 层起带 1~2 只影 */
    rollWaveKinds(H) {
      var n = Math.max(1, H.perWave);
      var pool = poolForFloor(this.floor) || ['claw'];
      var ranged = ['necro', 'weaver'];
      var out = [];
      var wantRanged = Math.min(n, H.forceRanged ? 3 : 2);
      for (var i = 0; i < wantRanged; i++) out.push(ranged[i % ranged.length]);
      if (this.floor >= CORE.flyerFromFloor && out.length < n) {
        out.push('shade');
        if (Math.random() < 0.4 && out.length < n) out.push('shade');
      }
      var guard = 0;
      while (out.length < n && guard++ < 200) {
        var k = pool[ri(0, pool.length - 1)];
        // 相邻两只不同：连着两只一样的，玩家读不出"这是一波"
        if (out.length && out[out.length - 1] === k) continue;
        out.push(k);
      }
      // 洗牌：远程/飞行不该永远排在最前面（玩家会背位置而不是看场面）
      for (var s = out.length - 1; s > 0; s--) {
        var j = ri(0, s), tmp = out[s];
        out[s] = out[j]; out[j] = tmp;
      }
      return out;
    }

    /** 排队一波：先给 0.8s 预警（圈边闪 3 下 + 两侧裂纹 + 音效），再开始涌进来 */
    queueWave(H, time) {
      var kinds = this.rollWaveKinds(H);
      H.queue = H.queue.concat(kinds);
      H.spawnStartAt = time + CORE.waveWarn;
      H.nextSpawnAt = 0;
      this.warnWave(H, kinds.length);
    }

    warnWave(H, n) {
      var self = this;
      this.showCenter('袭击逼近 · 第 ' + H.waveIdx + ' 波 · ' + n + ' 只', '#ffd76a');
      sfx('holdStart');
      if (H.warnRing && H.warnRing.active) {
        H.warnRing.setVisible(true).setAlpha(0).setScale(H.r / 86).setPosition(H.x, H.y);
        this.tweens.killTweensOf(H.warnRing);
        this.tweens.add({
          targets: H.warnRing, alpha: 1, duration: 130, yoyo: true, repeat: 2,
          onComplete: function () { if (H.warnRing && H.warnRing.active) H.warnRing.setAlpha(0).setVisible(false); }
        });
      }
      (H.cracks || []).forEach(function (img) {
        if (!img || !img.active) return;
        img.setVisible(true).setAlpha(0);
        self.tweens.killTweensOf(img);
        self.tweens.add({
          targets: img, alpha: 0.9, duration: 150, yoyo: true, repeat: 2,
          onComplete: function () { if (img.active) img.setAlpha(0).setVisible(false); }
        });
      });
      if (state.settings.screenShake2D !== false) {
        self.cameras.main.shake(90, 0.003);
      }
    }

    /** 队列补怪：左右交替、260~520px、0.35s 一只、受同屏上限约束 */
    updateWaveQueue(H, time) {
      if (!H.queue.length || H.ended) return;
      if (!H.spawnStartAt) H.spawnStartAt = time + CORE.waveWarn;
      if (time < H.spawnStartAt) return;
      if (time < (H.nextSpawnAt || 0)) return;
      var alive = this.enemies.filter(function (e) { return e.alive; }).length;
      if (alive >= H.cap) return;      // 超出的排队：上限只限制同屏，不减少总压力

      var key = H.queue.shift();
      H.spawnSide = -(H.spawnSide || 1);
      var side = H.spawnSide;
      var dist = rnd(CORE.spawnMin, CORE.spawnMax);
      var sx = clamp(H.x + side * dist, 160, this.levelWidth - 160);
      // 不刷在圈里贴脸；也不刷在缺口上方（地面怪从上方落下）
      if (Math.abs(sx - H.x) < H.r + 80) sx = H.x + side * (H.r + 100);
      sx = clamp(sx, 160, this.levelWidth - 160);
      if (this.isOverGap(sx)) sx = this.adjustSpawnX(sx);
      var sy = this.groundSurfaceAt(sx) - 100;
      var e = this.spawnEnemy(key, sx, sy, this.floor);
      if (e) e._holdRoom = true;
      H.nextSpawnAt = time + CORE.queueCd;
      H.waveSpawned++;
      if (!H.queue.length) H.spawnStartAt = 0;
    }

    /** 这 3 秒内有没有任何输入（读输入层，不读位移） */
    inputActiveNow() {
      var k = this.keys || {};
      var ids = ['left', 'left2', 'right', 'right2', 'jump', 'jump2', 'jump3',
        'attack', 'potion', 'dodge', 'skill', 'guard', 'guard2', 'fury'];
      for (var i = 0; i < ids.length; i++) {
        if (k[ids[i]] && k[ids[i]].isDown) return true;
      }
      var t = this.touchInput;
      if (t && (t.left || t.right || t.jumpHeld || t.joyJumpHeld || t.guardHeld || t.downHeld)) return true;
      if (this.input && this.input.activePointer && this.input.activePointer.isDown) return true;
      // 点一下就松开的键（攻击）在 isDown 采样之间可能整段漏掉 —— 补一个按键时间戳
      var now = this.time ? this.time.now : 0;
      if (this._keyTapAt && now - this._keyTapAt < 300) return true;
      return false;
    }

    /** 挂机惩罚：每 3 秒判一次，没有输入就扣 1% 最大生命（不致死），并在头顶提示 */
    checkHoldIdle(H, time) {
      if (this.heroDead || !this.hero) return;
      if (this.inputActiveNow()) H.lastInputAt = time;
      if (!H.idleAt) H.idleAt = time + CORE.idleCheck;
      if (time < H.idleAt) return;
      H.idleAt = time + CORE.idleCheck;
      if (time - H.lastInputAt < CORE.idleCheck) return;
      var h = this.hero;
      var loss = Math.max(1, Math.round(h.maxHp * CORE.idlePct));
      var before = h.hp;
      h.hp = Math.max(1, h.hp - loss);          // 不致死：最低留 1 点
      if (h.hp !== before) {
        this.showFloat(h.x, h.y - 104, '请积极守护核心', '#8a9aa8', 13);
        this.refreshHud();
      }
    }

    /**
     * 结束袭击并结算（反馈 §3.7）
     * 时间到那一帧就冻结核心受伤 —— 否则"最后一帧被补刀"会把 80% 打成 79%
     * 档位抖一格，玩家会觉得奖励是随机的。
     */
    finishHold(reason) {
      var H = this.holdZone;
      if (!H || H.ended) return;
      H.ended = true;
      H.frozen = true;
      H.outcome = reason;
      var ratio = this.coreRatio();
      var pct = Math.round(ratio * 100);
      var band, goldMul = 0, crystal = 0;
      if (reason === 'break' || H.coreHp <= 0) {
        band = '失守'; goldMul = 0;
      } else if (ratio >= 0.8) {
        band = '完美守住'; goldMul = CORE.reward.perfect; crystal = 1;
      } else if (ratio >= 0.5) {
        band = '守住'; goldMul = CORE.reward.normal; crystal = Math.random() < 0.3 ? 1 : 0;
      } else {
        band = '惨胜'; goldMul = CORE.reward.narrow;
      }
      H.goldMul = goldMul;
      // 金币基准公式在宿主里（settleRoomGold），引擎只把倍率带过去，不重复发一份
      this._roomGoldMul = goldMul;
      this._roomHoldFailed = (reason === 'break');
      if (goldMul > 0) this.points += Math.round((10 + this.floor * 2) * goldMul);
      // 深渊魂晶直接落在核心旁，走既有拾取管线（不掉一件新的"待实现"奖励）
      for (var i = 0; i < crystal; i++) {
        this.spawnCrystal(H.x + (i ? 28 : -28), H.surface - 40, 'abyss');
      }
      if (goldMul > 0 && !this.heroDead && this.hero) {
        var heal = Math.max(1, Math.round(this.hero.maxHp * 0.1));
        this.hero.hp = Math.min(this.hero.maxHp, this.hero.hp + heal);
        this.showFloat(this.hero.x, this.hero.y - 112, '守住 · 回复 ' + heal + ' 生命', '#73f0b4', 15);
      }
      H.unlocked = true;
      this.paintCoreState();
      this.paintCoreBar();
      if (H.text) H.text.setText(reason === 'break' ? '核心碎裂' : '守住了 · ' + pct + '%');
      if (reason === 'break') {
        H.coreAlive = false;
        this.showCenter('核心碎裂 · 失守（门已开，无奖励）', '#ff8a7a');
        sfx('execute');
        this.cameras.main.shake(240, 0.008);
      } else {
        this.showCenter((reason === 'clear' ? '尸潮被清空 · ' : '袭击结束 · ') + band + ' · 核心 ' + pct + '%', '#73f0b4');
        sfx('doorUnlock');
      }
      if (this.roomObjective) {
        this.roomObjective.done = true;
        this.roomObjective.got = this.roomObjective.need;
      }
      // 走 openPortal：宿主靠 rt:room-cleared 发金币 / 经验 / 三选一（理由见 unlockCollapse）
      this.portalOpen = false;
      this.openPortal(true);
      this.refreshHud();
    }

    /** 兼容旧入口（调试 / 一键通过）：按当前核心血量结算并开门 */
    unlockHold() { this.finishHold('debug'); }

    /* ---------- 限时 ---------- */
    startTimed(opts) {
      this.destroyTimedRoom();
      var need = opts.need || 25000;
      var cx = this.scale.width / 2, cy = this.hudSafeTop() + 44;
      var barW = Math.round(clamp(this.scale.width * 0.30, 150, 260));
      var text = this.add.text(cx, cy, '', {
        fontFamily: FONT, fontSize: '15px', color: '#ffd76a', fontStyle: 'bold'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(900);
      text.setShadow(0, 2, '#04060f', 5, false, true);
      var gfx = this.add.graphics().setScrollFactor(0).setDepth(900);
      // 入口蜡烛是"这房有时限"的第一眼信号；走远后由贴屏倒计时接手。
      // 放在角色前方而不是屏幕最左：最左会被触控摇杆压住，进门第一眼反而看不到。
      var candleX = Math.min(this.levelWidth - 80, (this.hero ? this.hero.x : 140) + 96);
      var candle = this.add.image(candleX, this.groundY + 2, TEX.candleFull)
        .setOrigin(0.5, 1).setDepth(5).setScale(1.08);
      this.timedRoom = {
        left: need, need: need, expired: false, unlocked: false,
        lastHudAt: 0, killsStart: this.kills || 0,
        text: text, gfx: gfx, candle: candle,
        barW: barW, barX: cx - barW / 2, barY: cy + 15, barWidth: barW,
        expiredAt: 0, lastTickSec: 0
      };
      this.roomObjective = { type: 'timed', need: need, got: 0, done: false };
      this.showCenter('限时房 · ' + Math.round(need / 1000) + ' 秒内清空', '#ffd76a');
      this.paintTimedRoom(this.time.now);
      this.refreshHud();
    }

    /** 限时房的贴屏倒计时 / 进度条 / 入口蜡烛三态 */
    paintTimedRoom(time) {
      var T = this.timedRoom;
      if (!T || !T.text || !T.gfx) return;
      if (T.unlocked) {
        T.text.setVisible(false); T.gfx.setVisible(false);
        return;
      }
      T.text.setVisible(true); T.gfx.setVisible(true);
      var left = Math.max(0, T.left);
      var ratio = clamp(left / T.need, 0, 1);
      var color = T.expired || left <= 5000 ? '#ff5d7a' : (left <= 10000 ? '#ffa25a' : '#ffd76a');
      var label = T.expired
        ? (time - T.expiredAt < 2500 ? '时间到 · 敌人强化' : '超时 · 敌人强化')
        : ('限时 ' + Math.ceil(left / 1000) + 's');
      T.text.setText(label).setColor(color);
      T.barWidth = Math.round(T.barW * (T.expired ? 0 : ratio));
      var col = parseInt(color.slice(1), 16);
      var g = T.gfx;
      g.clear();
      g.fillStyle(0x080c16, 0.86);
      g.fillRoundedRect(T.barX - 4, T.barY - 3, T.barW + 8, 12, 5);
      g.lineStyle(1, col, 0.42);
      g.strokeRoundedRect(T.barX - 4, T.barY - 3, T.barW + 8, 12, 5);
      if (T.barWidth > 0) {
        g.fillStyle(col, 0.94);
        g.fillRoundedRect(T.barX, T.barY, T.barWidth, 6, 3);
        g.fillStyle(0xffffff, 0.22);
        g.fillRect(T.barX + 2, T.barY + 1, Math.max(0, T.barWidth - 4), 1);
      }
      if (!T.expired && left > 0 && left <= 5000) {
        var tickSec = Math.ceil(left / 1000);
        if (tickSec !== T.lastTickSec) {
          T.lastTickSec = tickSec;
          this.tweens.killTweensOf(T.text);
          T.text.setScale(1.18);
          this.tweens.add({ targets: T.text, scale: 1, duration: 220, ease: 'Cubic.easeOut' });
          sfx('tick');
        }
      }
      if (T.candle && T.candle.active) {
        var key = T.expired ? TEX.candleOut : (ratio <= 0.34 ? TEX.candleLow : TEX.candleFull);
        if (T.candle.texture.key !== key) T.candle.setTexture(key);
        T.candle.setAlpha(T.expired ? 0.72 : 0.92 + 0.08 * Math.sin(time / 130));
      }
    }

    updateTimed(dt, time) {
      var T = this.timedRoom;
      if (!T) return;
      if (T.unlocked) { this.paintTimedRoom(time); return; }
      if (!T.expired) {
        T.left = Math.max(0, T.left - dt);
        if (T.left <= 0) {
          T.expired = true;
          T.expiredAt = time;
          this.empowerRoomEnemies();
          this.showCenter('时间到 · 敌人强化（仍可清空通关）', '#ff8a7a');
          this.cameras.main.flash(120, 120, 30, 40);
        }
      }
      var alive = this.enemies.filter(function (e) { return e.alive; }).length;
      if (alive === 0 && !this.roomObjective.done) {
        this.roomObjective.done = true;
        this.roomObjective.got = this.roomObjective.need;
        T.unlocked = true;
        if (!T.expired) {
          var bonus = Math.ceil(T.left / 1000) * 3 + ((this.kills || 0) - T.killsStart) * 2;
          this.points += bonus;
          this.showCenter('限时完成 · 奖励 +' + bonus, '#73f0b4');
        }
        this.checkFloorClear(true);
      }
      this.paintTimedRoom(time);
      if (time - T.lastHudAt > 220) { T.lastHudAt = time; this.refreshHud(); }
    }

    /* ---------- 机制清理 ---------- */
    destroyHoldZone() {
      var H = this.holdZone;
      if (!H) return;
      var kill = function (objs) {
        objs.forEach(function (o) { if (o && o.active !== false && o.destroy) o.destroy(); });
      };
      if (H.critTween) { H.critTween.stop(); H.critTween = null; }
      var all = [H.gfx, H.text, H.sprite, H.barPlate, H.barG, H.shield, H.warnRing];
      // 裂纹是 scrollFactor(0) 的画框元素：不拆掉会跟着玩家走进下一个房间
      if (H.cracks) all = all.concat(H.cracks);
      all.forEach(function (o) {
        if (!o) return;
        try { this.tweens.killTweensOf(o); } catch (e) { /* 忽略 */ }
      }, this);
      kill(all);
      this.holdZone = null;
    }
    destroyTimedRoom() {
      var T = this.timedRoom;
      if (!T) return;
      [T.text, T.gfx, T.candle].forEach(function (o) {
        if (!o) return;
        try { this.tweens.killTweensOf(o); } catch (e) { /* 忽略 */ }
        if (o.active !== false && o.destroy) o.destroy();
      }, this);
      this.timedRoom = null;
    }

    /** 出口指引：清空房间后若出口在屏幕外，在屏幕边缘提示方向 */
    updateGuide() {
      if (!this.guideArrow) return;
      if (!this.running || this.mapOpen || this.shopOpen || this.codexOpen || this.deathOpen || this.confirmOpen || !this.portalOpen || !this.portal) {
        if (this.guideArrow.visible) this.guideArrow.setVisible(false);
        return;
      }
      var cam = this.cameras.main;
      var sx = this.portal.x - cam.scrollX;
      if (sx > this.scale.width - 30) {
        this.guideArrow.setText('▶ 出口').setColor('#73f0b4')
          .setPosition(this.scale.width - 48, this.scale.height * 0.45).setVisible(true);
      } else if (sx < 30) {
        this.guideArrow.setText('◀ 出口').setColor('#73f0b4')
          .setPosition(48, this.scale.height * 0.45).setVisible(true);
      } else if (this.guideArrow.visible) {
        this.guideArrow.setVisible(false);
      }
    }

    updateCombo(dt) {
      if (this.comboTimer > 0) {
        this.comboTimer -= dt;
        if (this.comboTimer <= 0) { this.comboCount = 0; this.comboText.setAlpha(0); }
      }
    }

    /**
     * 投射物逐帧（敌方弹幕 / 投掷物）
     * 投掷物（长矛）自己算抛物线并朝速度方向旋转，落地或撞墙后插住，过一会儿消失。
     */
    updateProjectiles(dt) {
      var self = this, now = this.time.now;
      dt = dt || 16.7;
      this.projectiles = this.projectiles.filter(function (p) {
        if (!p || !p.active) return false;

        if (p._grounded) {
          if (now > p._stickUntil) { self.spark(p.x, p.y, 0xd8d8e8); p.destroy(); return false; }
          return true;                       // 插在地上：不再判伤害，只等消失
        }

        if (p._grav) {                       // 抛物线（手动积分：弹丸不该吃满世界重力）
          p.setVelocityY(p.body.velocity.y + p._grav * dt / 1000);
          if (p._spin) p.setRotation(Math.atan2(p.body.velocity.y, p.body.velocity.x));
        }
        if (p.x < -80 || p.x > self.levelWidth + 80 || p.y > self.groundY + 800 || p.y < -400) {
          p.destroy(); return false;
        }
        // 有寿命的弹丸（蛛网）：到点自己消失，不会一直飘在场上
        if (p._lifeUntil && now > p._lifeUntil) { p.destroy(); return false; }

        // 触地 / 撞墙 → 插住（不挂碰撞体，直接查静态砖块）
        if (self.projectileGroundY(p.x, p.y) !== null || p.body.blocked.left || p.body.blocked.right || p.body.blocked.down) {
          p._grounded = true;
          p.setVelocity(0, 0);
          p._stickUntil = now + (p._stick || 700);
          self.spark(p.x, p.y, 0xd8d8e8);
          return true;
        }

        // 守点房：打向核心的弹丸先判核心。核心不"格挡"弹道，只按 0.3s 的结算间隔吃伤害 ——
        // 所以远程怪是真实威胁，但不会在一帧里被几只同时打成 0。
        if (p._core) {
          var Hc = self.holdZone;
          if (Hc && Hc.coreAlive && !Hc.ended &&
            Phaser.Geom.Intersects.RectangleToRectangle(p.getBounds(),
              new Phaser.Geom.Rectangle(Hc.coreX - 24, Hc.coreY - 26, 48, 52))) {
            self.damageCore(p._dmg || CORE.dmgShooter, null);
            self.spark(p.x, p.y, 0xff8a7a);
            p.destroy();
            return false;
          }
        }

        if (!self.heroDead && Phaser.Geom.Intersects.RectangleToRectangle(p.getBounds(), self.hero.getBounds())) {
          // 织网者的网：不掉血、只缠人 —— 解法是闪避（见 tryDodge）
          if (p._web) {
            self.applyWeb(p.x, p.y);
            p.destroy();
            return false;
          }
          // 传弹丸的 x 进去：举盾时才知道这一下是从正面还是背后打来的
          self.damageHero(p._dmg || 6, null, false, p.x);
          self.spark(p.x, p.y, 0xd8b0ff);
          p.destroy();
          return false;
        }
        return true;
      });
    }

    /** 被织网者的网缠住：移动大减，直到**闪避**把它撕开或时间耗尽 */
    applyWeb(x, y) {
      var now = this.time.now;
      var already = now < (this.webUntil || 0);
      this.webUntil = now + WEB.duration;
      this.spark(x, y, 0xa8e88a);
      this.cameras.main.flash(90, 110, 190, 100);
      if (!already) {
        // 第一次被缠住时把"解法"直接写进飘字 —— 不指望玩家去图鉴里翻
        this.showFloat(this.hero.x, this.hero.y - 120, '被蛛网缠住 · 闪避可撕开', '#a8e88a', 17);
        sfx('thorn');
      }
    }

    /** 缠身状态的可见性（跟着主角走；到期自动消失） */
    updateWebFx() {
      var on = this.time.now < (this.webUntil || 0);
      if (!this.webFx) {
        if (!on) return;
        this.webFx = this.add.circle(0, 0, 26, 0xa8e88a, 0.16).setDepth(9);
        this.webFx.setStrokeStyle(2, 0xd8ff9a, 0.5);
      }
      this.webFx.setVisible(on && this.running && !this.heroDead);
      if (on && this.hero) this.webFx.setPosition(this.hero.x, this.hero.y - 30);
    }

    /** 投掷物的落点：命中地面砖块 / 平台时返回台面 y，否则 null */
    projectileGroundY(x, y) {
      var surf = null;
      this.groundTiles.forEach(function (t) {
        if (Math.abs(t.x - x) > 32) return;
        var top = t.y - 32;
        if (y >= top - 2 && y <= top + 46 && (surf === null || top > surf)) surf = top;
      });
      this.platformTiles.forEach(function (t) {
        if (Math.abs(t.x - x) > 32) return;
        var top = t.y - 10;
        if (y >= top - 2 && y <= top + 16 && (surf === null || top > surf)) surf = top;
      });
      return surf;
    }

    /** 开放传送门（门对象丢失时补建，保证界面状态与场景一致） */
    openPortal(quiet) {
      if (!this.portal) this.spawnPortal();
      if (!this.portal) return false;
      var first = !this.portalOpen;
      var settleNow = !TOGGLES.settleAtDoor || this._roomMechanic === 'hold';
      this.portalOpen = true;
      this.portal.setVisible(true).setAlpha(1);
      if (!quiet && first) {
        var def = this.roomNode ? (ROOM_TYPES[this.roomNode.type] || ROOM_TYPES.enemy) : ROOM_TYPES.enemy;
        this.showCenter(def.name + (settleNow ? '已清空 · 领取奖励后打开地图' : '已清空 · 走向右方传送门'), '#73f0b4');
      }
      // 2.9.4：守点房达成即结算（选完奖励由宿主直接开地图）；其他房型仍过门结算。
      // 门始终亮着，所以守点房关掉地图后也能走门兜底。
      if (first && settleNow) this.settleRoomClear();
      this.refreshHud();
      return true;
    }

    /** 选完奖励后是否由宿主直接开地图：只有守点房走这条捷径 */
    shouldAutoMapAfterChoice() {
      return this._roomMechanic === 'hold' && !!this._roomSettled;
    }

    /** 每间房唯一一次的清房结算；_roomSettled 的唯一写入点 */
    settleRoomClear() {
      if (this._roomSettled) return false;
      this._roomSettled = true;
      // 遗物：命运轮盘 —— 每清一个房间抛一次：多半给金币，偶尔咬你一口
      if (this.hasPerk('fateWheel')) {
        if (Math.random() < 0.65) {
          var wheelGold = ri(2, 8);
          this.points += wheelGold;
          this.showFloat(this.hero.x, this.hero.y - 104, '命运轮盘 +' + wheelGold + ' 金币', '#ffd76a', 16);
        } else {
          this.hero.hp = Math.max(1, this.hero.hp - 1);
          this.showFloat(this.hero.x, this.hero.y - 104, '命运轮盘 -1 生命', UI.danger, 16);
        }
      }
      this._floorRoomsCleared = (this._floorRoomsCleared || 0) + 1;
      this.pulseAt = this.time.now + this.pulseInterval();
      var snap = this.checkpointState('room-cleared');
      snap.roomsClearedThisFloor = this._floorRoomsCleared;
      snap.pulseInterval = this.pulseInterval();
      this.emitRt('rt:room-cleared', snap);
      this.notifyCheckpoint('room-cleared');
      return true;
    }

    /** 宿主处理完奖励 / 遗物 / 裂隙 / 结局后回话，引擎才继续过门 */
    ackRoomCleared() {
      if (!TOGGLES.settleAtDoor || !this._awaitClearAck) return false;
      this._awaitClearAck = false;
      this._awaitClearAckUntil = 0;
      this.nextFloor();
      return true;
    }

    /* ============================================================
       2.9 · P0：统一房间目标
       ------------------------------------------------------------
       完成条件从"敌人数量是否为 0"抽成 { type, need, got, done }。
       P0 只实现 clear；arrive / collect / hold / timed 由 P4 的机制房填。
       ⚠️ 非战斗房不建 objective：它们的完成条件仍是 roomGoal（宝箱/祭坛/
          商店/休整/事件），同一件事只留一个真值来源，否则两边会打架。
       ============================================================ */

    /** 房间目标初始化（buildLevel 调用） */
    initRoomObjective(roomType) {
      if (nonCombatRoom(roomType)) { this.roomObjective = null; return; }
      this.roomObjective = { type: 'clear', need: 1, got: 0, done: false };
    }

    /** 推进房间目标；返回 true 表示"刚刚完成"（P4 的表现层会用） */
    updateRoomObjective() {
      var o = this.roomObjective;
      if (!o || o.done) return false;
      if (o.type === 'clear') {
        var alive = 0;
        for (var i = 0; i < this.enemies.length; i++) {
          var e = this.enemies[i];
          if (e && e.alive) alive++;
        }
        o.got = alive === 0 ? o.need : 0;
        if (alive === 0) { o.done = true; return true; }
      }
      if (o.type === 'collect') {
        // got 由 takeCrystal 累加（塌陷回廊的钥匙）
        if (o.got >= o.need) { o.done = true; return true; }
      }
      // P4.2 / P4.3：hold / timed 在各自控制器里推进 got
      return false;
    }

    /** 房间是否已达成目标（统一目标 + 非战斗房目标物） */
    isRoomCleared() {
      this.updateRoomObjective();
      if (this.roomObjective && !this.roomObjective.done) return false;
      // 没有 objective（非战斗房 / 旧存档路径）：退回"敌人全灭"的旧判定
      if (!this.roomObjective) {
        var alive = this.enemies.filter(function (e) { return e.alive; }).length;
        if (alive > 0) return false;
      }
      if (this.roomGoal && !this.roomGoal.done) return false;
      return true;
    }

    checkFloorClear(quiet) {
      if (!this.isRoomCleared()) return;
      // 塌陷回廊：目标达成不等于门自己开 —— 要由控制器播完解封表现再开门
      if (this.collapse && !this.collapse.unlocked) { this.unlockCollapse(false); return; }
      if (this.portalOpen && this.portal) return;
      this.openPortal(quiet);
    }

    /** 走进传送门：打开地图选择下一个房间；Boss 房间则深入下一层 */
    nextFloor() {
      if (!this.portalOpen || this.mapOpen) return;
      // 调试单房间（塌陷回廊预览页）：没有宿主回话，必须排在等待 ack 之前
      if (this.previewMode) { if (this.finishPreviewRun()) return; }
      // 守点房已在开门时结算，过门只负责开地图；其他房型在这里结算并等宿主回话。
      var settleAtDoor = TOGGLES.settleAtDoor && this._roomMechanic !== 'hold';
      if (settleAtDoor && !this._roomSettled) {
        // 先立门闩再发事件：失守 / 非战斗房会在事件里同步 ack，不能发生重入后又被盖回 true
        this._awaitClearAck = true;
        this._awaitClearAckUntil = this.time.now + 3000;
        this.settleRoomClear();
        return;
      }
      // updateHero 每帧都会尝试过门；奖励面板没处理完时停在这里
      if (settleAtDoor && this._awaitClearAck) return;
      this.portalOpen = false;
      var node = this.roomNode;
      if (node) { node.visited = true; node.cleared = true; }
      this.roomsCleared = (this.roomsCleared || 0) + 1;

      if (node && node.type === 'boss') {
        this.points += 8;
        var next = this.floor + 1;
        this.floor = next;
        this.floorMap = this.makeFloorMap(next);
        this._floorRoomsCleared = 0;   // 新一层：脉冲节拍从头计
        this._floorMechanicCount = 0;  // 新一层：机制房保底计数重置
        this._floorMechanicKinds = {}; // 新一层：机制种类也重置（保底优先挑没出现过的）
        this._totemUsedFloor = false;  // 不朽图腾：每层一次
        this.resetSkill(false);   // 每层一次：深入下一层后技能可再次使用
        // 深渊侵蚀：每深入一层扣 3 点生命（文字版试炼的规则，实时里同样保留）
        var erode = 3;
        this.hero.hp = Math.max(1, this.hero.hp - erode);
        this.showFloat(this.hero.x, this.hero.y - 96, '深渊侵蚀 -' + erode, '#c79aff', 16);
        // 诅咒与环境效果换层重掷：交给宿主（它持有内核的诅咒池与环境池），
        // 掷完会通过 setCursesEnv 回传，保证 2D 与内核（文字模式）用的是同一份数据
        if (this.game && this.game.events) this.game.events.emit('trial2d:floor', { floor: next });
        this.emitRt('rt:floor', {
          floor: next, points: Math.round(this.points),
          roomsCleared: this.roomsCleared || 0,
          rooms: this.floorMap.nodes.length,
          plan: !!this.floorMap.fromPlan
        });
        this.roomNode = this.floorMap.current;
        this.refreshHud();
        this.showCenter('层主已陨落 · 深入第 ' + next + ' 层', '#ffd76a');
        sfx('floor');
        setBgmScene('explore');
        console.log('[战斗2D] Boss 击败，进入第 ' + next + ' 层 · 金币 ' + this.points);
        // ⚠️ 换层存档必须放在**这里**，不能放在上面（原来就在 rt:floor 之前）
        // ------------------------------------------------------------
        // 上面那句 `rt:floor` 会让宿主：生成新层的房间序列 → 重掷环境 → 下发新规划
        // → 让引擎按新规划重建地图。在那之前存盘，写进去的是
        // 「新层数 + **旧层**的房间序列 + 旧环境」这种自相矛盾的组合 ——
        // 读档后地图与房间类型会整个错位（"2D 存档有问题"的另一面）。
        // 放到这里，state 与引擎都已经是新层的一致状态。
        this.notifyCheckpoint('floor');
        // 击败层主后：先在画面内打开商店，关闭后再进入地图选下一个房间
        this.pendingMapAfterShop = true;
        this.openShop();
        return;
      }
      this.openMap();
    }

    // ---------- 地图界面（房间网格 / 悬停信息 / 点击进入）----------
    openMap() {
      if (this.mapOpen || !this.floorMap) return;
      this.mapOpen = true;
      this.attacking = false;
      this.isCharging = false;
      this.dodging = false;
      this.dodgeReadyAt = 0;
      if (this.chargeRing) this.chargeRing.setVisible(false);
      this.hero.setVelocity(0, 0);
      if (this.touchInput) { this.touchInput.left = false; this.touchInput.right = false; this.touchInput.downHeld = false; this.touchInput.jumpHeld = false; this.touchInput.joyJumpHeld = false; }
      if (this.touchUI) this.touchUI.setVisible(false);
      try { this.physics.world.pause(); } catch (e) { /* 忽略 */ }
      this.buildMapLayer();
      if (this.mapLayer) {
        this.mapLayer.setAlpha(0);
        this.tweens.add({ targets: this.mapLayer, alpha: 1, duration: 200 });
      }
      sfx('click');
    }

    closeMap() {
      this.mapOpen = false;
      this.destroyLayer('mapLayer');
      if (this.panelButtons) this.panelButtons.map = [];
      try { this.physics.world.resume(); } catch (e) { /* 忽略 */ }
      if (this.touchUI) this.touchUI.setVisible(this._lastInputWasTouch === true);
      // 关上地图后：房间已清空就要能再次进入传送门，否则玩家会被困在房间里
      this.checkFloorClear(true);
      this._portalGraceUntil = this.time.now + 500;   // 站在门口时不要立刻又弹开地图
      this.syncUiBarVisibility();
    }

    /** 地图界面的按钮（目前只有一颗「返回房间」） */
    onMapAction(action) {
      if (action === 'close') { sfx('click'); this.closeMap(); }
    }

    buildMapLayer(sizeW, sizeH) {
      var W = (sizeW && sizeW >= 40) ? sizeW : this.scale.width;
      var H = (sizeH && sizeH >= 40) ? sizeH : this.scale.height;
      if (W < 40 || H < 40) { fixCanvasSize(); return null; }
      var map = this.floorMap;
      var self = this;

      this.mapLayer = this.add.container(0, 0).setDepth(2000).setScrollFactor(0);
      if (!this.panelButtons) this.panelButtons = { confirm: [], shop: [], death: [], map: [], choice: [], pause: [] };
      this.panelButtons.map = [];

      var dim = this.add.rectangle(W / 2, H / 2, W, H, UI.dim, UI.dimAlpha);
      var mini = W < 620;
      var title = this.add.text(W / 2, mini ? 34 : 48, '第 ' + map.floor + ' 层 · 深渊地图', {
        fontSize: (mini ? 19 : 26) + 'px', color: UI.title, fontStyle: 'bold', letterSpacing: 2
      }).setOrigin(0.5);
      var status = this.add.text(W / 2, mini ? 58 : 78,
        '生命 ' + Math.max(0, Math.round(this.hero.hp)) + '/' + this.hero.maxHp +
        '　金币 ' + this.points + '　药水 ×' + this.hero.potions, {
        fontSize: (mini ? 11 : 14) + 'px', color: UI.good
      }).setOrigin(0.5);
      this.mapLayer.add([dim, title, status]);

      // 网格坐标：列 → x，行 → y（小屏自动收紧间距并缩小方块）
      this._mapCompact = W < 620;
      var compact = this._mapCompact;
      // ⚠️ 列间距与方块尺寸必须按**实际用到的列数**算，不能写死 MAP_COLS
      // ------------------------------------------------------------
      // MAP_COLS=4 是引擎"自造地图"时代的固定列数；而经典模式是用 `cols` 形式把
      // 内核的房间序列**整份下发**的 —— 第 1 层 4 间、第 2 层 5 间、第 3 层起 6 间
      //（自定义难度「每层房间数」还能到 12）。
      // 写死 4 的话 colGap 只按 3 段来分，从**第 2 层**开始节点就一路排到屏幕外：
      // 玩家既看不到也点不到 → 进不了下一间房 → 整局卡死。
      // 这正是用户反馈的"小地图有问题"。
      var maxCol = 0;
      map.nodes.forEach(function (n) { if (n.col > maxCol) maxCol = n.col; });
      var cols = Math.max(1, maxCol + 1);
      var padX = compact ? 28 : Math.min(W * 0.42, Math.max(56, W * 0.08));
      var colGap = cols > 1 ? (W - padX * 2) / (cols - 1) : 0;
      // 方块尺寸随列数自适应：列多时缩小，保证相邻节点间留得下间隙、且末端不出画
      var nodeSize = Math.round(Math.max(28, Math.min(compact ? 44 : 56, colGap * 0.62)));
      this._mapNodeSize = nodeSize;
      var rowGap = compact ? Math.min(96, H * 0.16) : Math.min(120, H * 0.18);
      var gridTop = H * 0.52 - rowGap;
      var pos = {};
      map.nodes.forEach(function (n) {
        pos[n.id] = { x: padX + n.col * colGap, y: gridTop + n.row * rowGap };
      });

      // 连线（当前房间的出路高亮）
      var g = this.add.graphics();
      map.nodes.forEach(function (n) {
        var active = map.current && n.id === map.current.id;
        n.links.forEach(function (tid) {
          var t = map.nodes[tid];
          if (!t) return;
          g.lineStyle(active ? 4 : 2, active ? 0x73f0b4 : 0x3a3a4a, active ? 0.95 : 0.55);
          g.beginPath();
          g.moveTo(pos[n.id].x, pos[n.id].y);
          g.lineTo(pos[t.id].x, pos[t.id].y);
          g.strokePath();
        });
      });
      this.mapLayer.add(g);

      // 房间节点
      map.nodes.forEach(function (n) {
        self.buildRoomNode(n, pos[n.id].x, pos[n.id].y,
          !!(map.current && n.id === map.current.id),
          !!(map.current && map.current.links.indexOf(n.id) >= 0));
      });

      // 悬停信息 + 图例（小屏只留色块，避免文字重叠）
      this.mapDefaultInfo = mini ? '点击发光房间继续深入' : '点击发光的房间继续深入　·　绿色勾选表示已通过';
      // 手机横屏（宽而不高，800×360）时地图格子从 y≈100 一直排到 y≈275，底部提示原来在 272：
      // 上面撞第一行格子的图标，下面撞最后一行的房间名。唯一空着的地方是图例下面那条 ——
      // 所以矮屏时把提示压到最底部，而不是硬塞在两行格子中间。
      var tight = H < 520;
      this.mapInfo = this.add.text(W / 2, tight ? H - 22 : (mini ? H - 74 : H - 88), this.mapDefaultInfo, {
        fontSize: (mini ? 11 : 15) + 'px', color: '#c8cede'
      }).setOrigin(0.5);

      // 图例：把并入经典模式时新增的三种房间（商店 / 休整 / 事件）也补上 ——
      // 它们在地图上会出现，却不在图例里，玩家只能靠图标猜。
      var legendKeys = ['start', 'enemy', 'elite', 'mirror', 'boss', 'treasure', 'shrine', 'shop', 'rest', 'event'];
      var step = Math.min(mini ? 42 : 122, (W - 60) / legendKeys.length);
      var lx = W / 2 - step * (legendKeys.length - 1) / 2;
      var legend = [this.mapInfo];
      legendKeys.forEach(function (k, i) {
        var d = ROOM_TYPES[k];
        var x = lx + i * step;
        if (mini) {
          legend.push(self.add.rectangle(x, H - 40, 12, 12, d.fill, 1).setStrokeStyle(2, d.line, 1));
        } else {
          legend.push(self.add.rectangle(x - 26, H - 52, 12, 12, d.fill, 1).setStrokeStyle(2, d.line, 1));
          legend.push(self.add.text(x - 16, H - 52, d.name.replace('房间', ''), {
            fontSize: '11px', color: '#a8b0c0'
          }).setOrigin(0, 0.5));
        }
      });
      this.mapLayer.add(legend);

      // 右上角「返回房间」
      // ------------------------------------------------------------
      // 常驻功能按钮行（uiBar）现在只要面板一打开就整行收起，地图也不例外 ——
      // 而地图原来没有任何自己的退出口，玩家不点房间就走不了。补这一颗，
      // 不想深入时可以先退出去买点东西 / 看状态，再回来走传送门。
      var backW = mini ? 80 : 100, backH = mini ? 26 : 30;
      // uiButton 的 x 是**左边缘**，不是中心 —— 这里原来写的是 W - 12 - backW / 2
      // （中心坐标），按钮整个右移了半个宽度，在 800 宽的手机横屏上会溢出画布 13px。
      this.uiButton(this.mapLayer, this.panelButtons.map, 'close', '返回房间',
        W - 12 - backW, mini ? 34 : 48, backW, backH, false);

      return this.mapLayer;
    }

    buildRoomNode(n, px, py, isCurrent, selectable) {
      var def = ROOM_TYPES[n.type] || ROOM_TYPES.enemy;
      var self = this;
      // 方块尺寸由 buildMapLayer 按**实际列数**算好（见那里的说明）；
      // 图标与字号跟着方块等比缩放，列多时不会挤成一团。
      var compact = !!this._mapCompact;
      var size = this._mapNodeSize || (compact ? 44 : 56);
      var iconFont = Math.max(11, Math.round(size * 0.36));
      var nameFont = Math.max(8, Math.round(size * 0.19));

      var box = this.add.rectangle(px, py, size, size, def.fill, selectable ? 1 : (n.visited ? 0.8 : 0.5));
      box.setStrokeStyle(isCurrent ? 3 : 2, isCurrent ? 0xffffff : def.line, isCurrent ? 1 : (selectable ? 1 : 0.45));
      // 无滚动因子：地图随屏幕固定；也是点击命中判定所必需的
      box.setScrollFactor(0);
      var icon = this.add.text(px, py - size * 0.16, def.icon, { fontSize: iconFont + 'px', color: '#ffffff' }).setOrigin(0.5);
      var name = this.add.text(px, py + size * 0.3, def.name.replace('房间', ''), {
        fontSize: nameFont + 'px', color: '#e8ecf6'
      }).setOrigin(0.5);
      this.mapLayer.add([box, icon, name]);

      if (n.cleared) {
        var mark = this.add.text(px + size / 2 - 9, py - size / 2 + 9, '✓', {
          fontSize: '14px', color: '#73f0b4', fontStyle: 'bold'
        }).setOrigin(0.5);
        this.mapLayer.add(mark);
      }

      if (isCurrent) {
        var glow = this.add.rectangle(px, py, size + 16, size + 16).setStrokeStyle(2, 0xffd76a, 0.9);
        this.mapLayer.add(glow);
        this.tweens.add({ targets: glow, alpha: { from: 0.95, to: 0.3 }, duration: 900, yoyo: true, repeat: -1 });
      }

      if (selectable) {
        box.setInteractive({ useHandCursor: true });
        this.tweens.add({ targets: [box, icon], scaleX: 1.09, scaleY: 1.09, duration: 660, yoyo: true, repeat: -1 });
        var info = def.name + '　' + def.desc;
        box.on('pointerover', function () {
          self.mapInfo.setText(info).setColor(def.center || '#ffffff');
        });
        box.on('pointerout', function () {
          self.mapInfo.setText(self.mapDefaultInfo).setColor('#c8cede');
        });
        box.on('pointerdown', function () { self.enterRoom(n); });
      }
      return box;
    }

    /** 点击地图上的房间进入 */
    enterRoom(n) {
      if (!this.mapOpen || !n || !this.floorMap) return;
      var cur = this.floorMap.current;
      if (!cur || cur.links.indexOf(n.id) < 0) return;   // 只能走进相邻房间

      this.floorMap.current = n;
      n.visited = true;
      this.closeMap();
      this.cameras.main.flash(300, 6, 6, 18);
      this.buildLevel(n);

      var def = ROOM_TYPES[n.type] || ROOM_TYPES.enemy;
      this.showCenter('第 ' + this.floor + ' 层 · ' + def.name, def.center || '#ffd76a');
      console.log('[战斗2D] 进入房间：' + def.name + '（第 ' + this.floor + ' 层 · 第 ' + (n.col + 1) + ' 列 第 ' + (n.row + 1) + ' 行）');

      // 环境效果：每进一个房间重掷一次（宿主用袋抽发牌，掷完通过 setCursesEnv 回传）
      this.rollRoomEnv(n.type);

      // 音效：开门 + 按房间类型切 BGM 与登场音
      sfx('door');
      setBgmScene(bgmForRoom(n.type));
      if (n.type === 'elite') sfx('elite');
      else if (n.type === 'mirror') sfx('mirror');
      else if (n.type === 'boss') sfx('boss');
      else if (n.type === 'shop') sfx('coin');
      else if (n.type === 'rest') sfx('heal');
      else if (n.type === 'event') sfx('door');
      // 进房存档：中途刷新 / 崩溃只回退到房间入口，不丢整层
      this.notifyCheckpoint('room');
    }

    /**
     * 通知宿主为本房间重掷环境效果
     * 2D 不自己掷：环境的名字与数值都由经典模式的池子生成（难度、层数都影响强度），
     * 掷完宿主会通过 setCursesEnv 回传，内核（文字模式）读到的也就是同一份。
     */
    rollRoomEnv(type) {
      if (!this.running) return false;
      if (!this.game || !this.game.events || typeof this.game.events.emit !== 'function') return false;
      this.game.events.emit('trial2d:room', { floor: this.floor, type: type || null });
      // 新名（P1）：载荷升级为**完整房间对象**，宿主据此分发商店目录 / 事件数据
      this.emitRt('rt:room', {
        floor: this.floor,
        type: type || null,
        room: this.roomNode ? {
          type: this.roomNode.type, col: this.roomNode.col, row: this.roomNode.row,
          name: this.roomNode.name || null, desc: this.roomNode.desc || null,
          payload: (this.roomNode.payload !== undefined) ? this.roomNode.payload : null
        } : null
      });
      return true;
    }

    // ============================================================
    //  宿主主权接口（P1 交接层）
    //  ============================================================

    /** 发一个宿主事件（宿主没监听也无害） */
    emitRt(name, payload) {
      if (!this.game || !this.game.events || typeof this.game.events.emit !== 'function') return false;
      try { this.game.events.emit(name, payload || {}); return true; } catch (e) { return false; }
    }

    /**
     * 把宿主下发的楼层规划铺成一张地图
     * ------------------------------------------------------------
     * 两种写法：
     *   { rooms: ['enemy','elite','treasure'] }            简写：引擎自动补入口与 Boss
     *   { cols: [['start'],['enemy','mirror'],['boss']] }  全权控制（引擎只负责连线）
     * 元素既可以是类型名，也可以是 { type, name, desc, payload }；
     * payload 会原样带到 rt:room 事件与 debug() 里，供宿主携带商店目录 / 事件数据。
     * 返回 null 表示规划不可用，调用方退回内置自造地图（不会把玩家困住）。
     */
    floorMapFromPlan(plan, floor) {
      if (!plan) return null;
      var spec = plan.cols;
      if (!spec && plan.rooms && plan.rooms.length) {
        spec = [[{ type: 'start' }]].concat(plan.rooms.map(function (r) { return [r]; }));
        var tail = spec[spec.length - 1][0];
        var tailType = (typeof tail === 'string') ? tail : (tail && tail.type);
        if (tailType !== 'boss') spec.push([{ type: 'boss' }]);
      }
      if (!spec || !spec.length) return null;

      var nodes = [], cols = [], id = 0;
      spec.forEach(function (colSpec, c) {
        var list = (colSpec instanceof Array) ? colSpec : [colSpec];
        var col = list.map(function (s0, i) {
          var o = (typeof s0 === 'string') ? { type: s0 } : (s0 || {});
          var n = {
            id: id++, col: c, row: i,
            type: ROOM_TYPES[o.type] ? o.type : 'enemy',
            links: [], visited: false, cleared: false,
            name: o.name || null, desc: o.desc || null,
            payload: (o.payload !== undefined) ? o.payload : null
          };
          nodes.push(n);
          return n;
        });
        if (col.length) cols.push(col);
      });
      if (!cols.length) return null;
      linkCols(cols);
      var start = cols[0][0];
      start.visited = true;
      return { floor: floor, cols: cols, nodes: nodes, current: start, fromPlan: true };
    }

    /** 取本层的房间图：宿主下发过规划就用宿主的，否则退回内置自造地图 */
    makeFloorMap(floor) {
      var m = this.floorMapFromPlan(HOST.floorPlan, floor);
      return m || generateFloorMap(floor);
    }

    /**
     * 用**当前下发的规划**重取本层地图（宿主换层后调用）
     * ------------------------------------------------------------
     * 为什么需要它：nextFloor() 的顺序是「先 makeFloorMap(next) → 再 emit rt:floor
     * → 最后 roomNode = floorMap.current」。宿主只有在收到 rt:floor 时才知道层数变了、
     * 才能生成并下发新一层的房间序列 —— 那时地图已经用旧规划造好了。
     * 于是宿主在该事件里调本函数替换 floorMap，后面那句 roomNode = floorMap.current
     * 自然就指到新地图的入口，不需要引擎再做任何协调。
     */
    rebuildFloorMap() {
      if (!this.running || !this.floorMap) return false;
      var m = this.makeFloorMap(this.floor);
      if (!m) return false;
      this.floorMap = m;
      this.roomNode = m.current;
      this.refreshHud();
      return true;
    }

    /**
     * 当前腐化脉冲间隔（ms）—— 回合上限取消后的压力旋钮（规划 §3.12）
     *   interval = clamp(基准 − (层数−1)×50 − 本层已清房间数×步长, 下限, 基准)
     */
    pulseInterval() {
      var p = HOST.pulse || PULSE_BY_DIFFICULTY[this.difficulty] || PULSE_BY_DIFFICULTY.normal;
      var start = p.start || PULSE.period;
      var step = p.step || 0;
      var min = (p.min == null) ? start : p.min;
      var v = start - (this.floor - 1) * 50 - (this._floorRoomsCleared || 0) * step;
      return Math.round(clamp(v, Math.min(min, start), start));
    }

    /** 脉冲预警窗口（HUD 变红的提前量），随间隔同步缩放 */
    pulseWarn() {
      if (HOST.pulse && HOST.pulse.warn != null) return HOST.pulse.warn;
      return Math.min(PULSE.warn, Math.round(this.pulseInterval() * 0.30));
    }

    /* ---------- 遗物（承载点 + 三个钩子）---------- */

    /** 宿主下发本局遗物（获得 / 失去后重新下发整份即可） */
    setRelics(list) {
      HOST.relics = (list || []).slice();
      this.relics = HOST.relics;
      this.recomputeRelicFx();
      this.refreshHud();
      return HOST.relics.length;
    }

    /** 把遗物折成一组系数（每次下发只算一次，不进每帧热路径） */
    recomputeRelicFx() {
      var fx = { perk: {} };
      // 双套遗物（2.9.2 F7）：按**当前英雄**的攻击方式取一份。
      // 只在这里判一次武器 —— 下游全部读摊平后的 fx，所以热路径不用知道武器是什么。
      var variant = this.heroRanged() ? 'ranged' : 'melee';
      (HOST.relics || []).forEach(function (r) {
        var id = (typeof r === 'string') ? r : (r && r.id);
        var raw = RELIC_FX[id];
        if (!raw) return;
        var def = (raw.melee || raw.ranged)
          ? (raw[variant] || raw.melee || raw.ranged)     // 只取当前武器那一份
          : raw;
        for (var k in def) {
          if (!Object.prototype.hasOwnProperty.call(def, k)) continue;
          if (typeof def[k] === 'string') fx.perk[def[k]] = true;
          else fx[k] = (fx[k] || 0) + def[k];
        }
      });
      HOST.relicFx = fx;
      // 机制型遗物（完美窗口 / 连招 / 跳劈 / 体力 / 狂怒 / 远程）直接写回常量，
      // 好处是几十处热路径读取点一行都不用改（见 MECH_BASE 的说明）
      try { applyMechRelics(); } catch (e) { console.warn('[战斗2D] 应用机制遗物失败：', e); }
      return fx;
    }

    /** 读一个遗物系数（没有则用 base） */
    relicFx(key, base) {
      var v = HOST.relicFx ? HOST.relicFx[key] : undefined;
      return (typeof v === 'number') ? v : (base || 0);
    }

    hasPerk(name) { return !!(HOST.relicFx && HOST.relicFx.perk && HOST.relicFx.perk[name]); }

    /* ---------- 中途存档 ---------- */

    /**
     * 中途存档快照：层 / 房间 / 生命 / 金币 / 诅咒 / 遗物 / 时间
     * 引擎自身**不落盘**（实时局是帧级数据，写进存档只会互相打架），
     * 交宿主写进存档 —— 否则刷新或崩溃会整层进度丢失（风险 R8）。
     */
    checkpointState(reason) {
      var h = this.hero, room = this.roomNode;
      return {
        reason: reason || 'room',
        floor: this.floor,
        points: Math.round(this.points),
        hp: Math.round(h.hp), maxHp: h.maxHp, shield: Math.round(h.shield),
        potions: h.potions, stamina: Math.round(h.stamina),
        kills: this.kills || 0, roomsCleared: this.roomsCleared || 0,
        roomType: room ? room.type : null,
        room: room ? { type: room.type, col: room.col, row: room.row, visited: !!room.visited } : null,
        // 本房间挂的机制：不带的话，中途存档再进会把这间房变回普通房（和「这个房间重来」的表述不一致）
        mechanic: this._roomMechanic || null,
        curses: (this.curses || []).slice(),
        env: this.worldEnv ? this.worldEnv.name : null,
        // 2.9.2 §3：守点（守住核心）的结算倍率 / 失守标记。
        // 金币基准公式在宿主里，引擎只把"这一房该乘多少"带过去 ——
        // 否则引擎与宿主各发一份，金币会翻倍。
        goldMul: (this._roomGoldMul == null ? 1 : this._roomGoldMul),
        holdFailed: !!this._roomHoldFailed,
        core: this.holdZone ? {
          hp: Math.round(this.holdZone.coreHp), max: this.holdZone.coreMax,
          ratio: Math.round(this.coreRatio() * 100) / 100,
          outcome: this.holdZone.outcome || null
        } : null,
        relics: (HOST.relics || []).map(function (r) { return (typeof r === 'string') ? r : (r && r.id); }),
        elapsed: this.runStartedAt ? Math.round(this.time.now - this.runStartedAt) : 0
      };
    }

    /**
     * 把快照交给宿主落盘
     * ⚠️ bridge 与事件**二选一**：两个都发会让"既接 bridge 又监听事件"的宿主收到两次
     *    （实测表现为同一处存档连写两遍）。
     */
    notifyCheckpoint(reason) {
      var snap = this.checkpointState(reason);
      if (hasBridge('checkpoint')) { callBridge('checkpoint', snap); return true; }
      return this.emitRt('rt:checkpoint', snap);
    }

    // ---------- 敌人 AI ----------
    /**
     * 敌人的当前目标（2.9.2 §3.4）
     * 核心优先；被玩家打中（_aggroHeroUntil）后 1.5s 内转火玩家。
     * 袭击结束 / 核心已碎 → 全部回到玩家身上，残留的怪不会对着空地挥空。
     */
    enemyAim(e, time) {
      var H = this.holdZone, h = this.hero;
      if (!H || !H.coreAlive || H.ended || this.heroDead || !h) {
        return { x: h ? h.x : 0, y: h ? h.y : 0, core: false };
      }
      // 2.9.4 H2：袭击未启动时完全退回原来的玩家索敌
      if (TOGGLES.holdGate && !H.started) return { x: h.x, y: h.y, core: false };
      if (time < (e._aggroHeroUntil || 0)) return { x: h.x, y: h.y, core: false };
      return { x: H.coreX, y: H.coreY, core: true };
    }

    updateEnemies(dt, time) {
      var self = this;
      this.enemies.forEach(function (e) {
        if (!e.alive) {
          if (e.throwFx) { e.throwFx.destroy(); e.throwFx = null; }
          return;
        }
        var spr = e.sprite, def = e.def;
        // 本帧是否处于"追击"状态：只有追击分支会写飞行怪的垂直速度，
        // 其余状态（巡逻 / 前摇 / 攻击 / 受击 / 玩家死亡）都要把 vy 清零（F4，见 fixFlyers）
        e._flyChase = false;

        // 献祭者给的护盾环跟着它走（不跟随的话环会留在原地，看不出谁有盾）
        if (e.shieldRing && e.shieldRing.visible) e.shieldRing.setPosition(spr.x, spr.y - 26);

        // 兜底：万一它还是被挤进了地面（物理意外、穿模）。
        // 沉在地面以下的敌人打不到、也清不掉 —— 整局卡死；而且它还在视野里，
        // 连方向箭头都不会给，玩家只能看着「剩余敌人 1」发呆。
        // 所以这里拉回地面，而不是判它「脱离战斗」把房间草草清空。
        // 兜底判据按**这一格真实的地面高度**算：断桥的段落有 ±32px 落差，
        // 用全局 groundY 会把站在低一段的怪吸回上一层，或者把正常打斗判成掉出地面。
        var surfY = self.groundSurfaceAt(spr.x);
        if (spr.y > surfY + 40 && spr.y <= self.groundY + 700) {
          spr.y = surfY;
          if (spr.body) { try { spr.body.reset(spr.x, surfY); } catch (err) { /* 忽略 */ } }
          spr.setVelocityY(0);
        }

        // 掉出关卡范围（被击退甩出去 / 从边缘坠落）→ 视为脱离战斗，避免房间永远清不空。
        // 这一条必须排在硬直检查**之前**：硬直期间敌人不受控地飞，等硬直结束再查，
        // 它已经飞出去很远了。阈值也跟着从 ±400 收到 ±120 —— 那是「已经离开关卡」，
        // 而不是「跑出去两个屏幕」。正常情况下有 world bounds 兜着，这里只接住坠落。
        if (spr.y > self.groundY + 700 || spr.x < -120 || spr.x > self.levelWidth + 120) {
          self.dropEnemy(e);
          return;
        }

        // 受击硬直期间不受控
        if (time < e.hurtUntil) {
          spr.setFlipX(spr.body.velocity.x < 0);
          return;
        }

        // 完美闪避定身：完全静止（与受击硬直区分，不吃惯性）
        if (time < e.stunUntil) {
          spr.setVelocityX(0);
          if (def.fly) spr.setVelocityY(0);
          return;
        }

        // ===== 目标选择（2.9.2 §3.4 围攻核心）=====
        // 守点房里默认目标就是核心；被玩家打中后 1.5s 内转火玩家（"打怪会拉仇恨"）。
        // 下游所有分支用的都是 dx/dy/dist/dirToHero 这四个数 —— 换目标只需要换这四个，
        // 不必在每个 behavior 里各写一遍"如果守点房则……"。
        var tgt = self.enemyAim(e, time);
        e._aimCore = !!tgt.core;
        var dx = tgt.x - spr.x;
        var dy = tgt.y - spr.y;
        var dist = Math.abs(dx);
        var dirToHero = dx >= 0 ? 1 : -1;

        if (!self.running || self.heroDead) {
          spr.setVelocityX(0);
          spr.play(self.mobAnimKey(e, 'walk'), true);
          return;
        }

        // --- 攻击后摇 / 判定 ---
        if (e.state === 'attack') {
          spr.setVelocityX(0);
          if (time >= e.attackAt && !e.didHit) { e.didHit = true; self.enemyStrike(e); }
          if (time >= e.recoverUntil) { e.state = 'chase'; e.attackAt = time + 300; }
          return;
        }

        // --- 起手（前摇）---
        if (e.state === 'windup') {
          spr.setVelocityX(0);
          if (e.willThrow) {
            // 掷矛：定在「后仰蓄力」帧不动，出手瞬间才切到「前倾发力」帧（动作读得出蓄与发）
            spr.setFlipX(dirToHero < 0);
            spr.anims.stop();
            spr.setFrame(ENEMY_FRAMES.attack[0]);
          } else {
            spr.play(self.mobAnimKey(e, 'attack'), true);
          }
          // 掷矛前摇：手里多一支矛，出手前一直看得见（给玩家闪避的余地）
          if (e.throwFx && e.throwFx.active) {
            var flip = spr.flipX;
            e.throwFx.setPosition(spr.x + (flip ? -12 : 12), spr.y - 42);
            e.throwFx.setFlipX(flip);
            e.throwFx.setRotation(flip ? 0.6 : -0.6);
          }
          if (time >= e.windupUntil) {
            if (e.pounce) {
              // 对空扑击：起手结束 → 朝玩家方向起跳（不是瞬移，轨迹看得见、可以闪）
              e.pounce = false;
              e.state = 'pounce';
              e.pounceUntil = time + RHYTHM.pounceTime;
              e.didHit = false;
              spr.setVelocityX(dirToHero * RHYTHM.pounceSpeedX);
              spr.setVelocityY(-RHYTHM.pounceSpeedY);
              spr.play(self.mobAnimKey(e, 'attack'), true);
            } else if (e.willThrow) {
              e.willThrow = false;
              self.enemyThrowSpear(e);
              e.state = 'attack'; e.attackAt = time; e.didHit = true; e.recoverUntil = time + def.recover;
            } else if (def.behavior === 'shooter') {
              self.enemyShoot(e);
              e.state = 'attack'; e.attackAt = time; e.didHit = true; e.recoverUntil = time + def.recover;
            } else if (def.behavior === 'charger' && !e._aimCore) {
              spr.setVelocityX(dirToHero * def.speed * 3.1);
              e.state = 'charge'; e.chargeUntil = time + 420; e.didHit = false;
            } else if (def.behavior === 'charger') {
              // 打核心时冲锋没意义：核心不会躲，冲过去只会穿过它。
              // 改成一次普通挥击，让「岩浆行者 / 精英守卫进守点房」也有真实压力。
              e.state = 'attack'; e.attackAt = time + 90; e.didHit = false; e.recoverUntil = time + 90 + def.recover;
            } else {
              e.state = 'attack'; e.attackAt = time + 90; e.didHit = false; e.recoverUntil = time + 90 + def.recover;
            }
          }
          return;
        }

        // --- 冲锋 ---
        if (e.state === 'charge') {
          spr.setFlipX(spr.body.velocity.x < 0);
          // P2：冲锋的纵向判定加高 —— 玩家"跳过去"不再是无条件安全。
          // 注意只加高判定，不加速度、不改前摇，命中窗口仍是看得见的冲撞。
          // ⚠️ 敌人精灵 origin 是 (0.5, 1)，spr.y 是脚底：判定要从脚底往上算。
          var eh = def.h || 46;
          var chargeRect = (def.behavior === 'charger')
            ? new Phaser.Geom.Rectangle(spr.x - 32, spr.y - eh - 90, 64, eh + 100)
            : spr.getBounds();
          if (!e.didHit && Phaser.Geom.Intersects.RectangleToRectangle(chargeRect, self.hero.getBounds())) {
            e.didHit = true;
            self.damageHero(Math.round(def.atk * 1.5), e, false);
          }
          if (time >= e.chargeUntil || spr.body.blocked.left || spr.body.blocked.right) {
            e.state = 'chase'; spr.setVelocityX(0); e.attackAt = time + 500;
          }
          return;
        }

        // --- 对空扑击（滞空扑一次，落地/超时结束）---
        if (e.state === 'pounce') {
          spr.setFlipX(spr.body.velocity.x < 0);
          if (!e.didHit && Phaser.Geom.Intersects.RectangleToRectangle(spr.getBounds(), self.hero.getBounds())) {
            e.didHit = true;
            self.damageHero(Math.round(def.atk * 1.2), e, false);
            self.showFloat(spr.x, spr.y - 80, '扑中!', '#ff9a5a', 15);
          }
          if (spr.body.blocked.down || time >= e.pounceUntil) {
            e.state = 'chase'; spr.setVelocityX(0); e.attackAt = time + 400;
          }
          return;
        }

        // 索敌的纵向窗口：原来 240 太窄 —— 玩家站在高台上时，飞在下面的影
        // 对他是"隐身"的（永远不进入追击，只能乱飘）。放宽到 320（2.9.1 F4）。
        var aware = dist < def.detect && Math.abs(dy) < 320;

        // --- 远程 / 辅助单位保持距离 ---
        if (aware && (def.behavior === 'shooter' || def.behavior === 'support') && dist < (def.keepDist || 200)) {
          spr.setVelocityX(-dirToHero * def.speed);
          spr.setFlipX(dirToHero < 0);
          spr.play(self.mobAnimKey(e, 'walk'), true);
          return;
        }

        if (aware) {
          e.state = 'chase';
          spr.setFlipX(dirToHero < 0);

          // 铁壁兵：盾面朝向独立维护 + **转身慢半拍**。
          // 少了这段延迟，它每帧都转向玩家 → 永远正面 → "绕后"这条解法等于不存在
          // （只剩跳劈一条路，而设计意图是两条解法）。这段延迟窗口就是绕后的机会。
          if (def.shieldFront) {
            if (!e.faceDir) e.faceDir = spr.flipX ? -1 : 1;
            if (e.faceDir !== dirToHero) {
              if (!e._turnAt) e._turnAt = time + SHIELD_TURN;
              else if (time >= e._turnAt) { e.faceDir = dirToHero; e._turnAt = 0; }
            } else {
              e._turnAt = 0;
            }
            spr.setFlipX(e.faceDir < 0);   // 视觉与判定用同一个值，否则玩家看不懂
          }

          // 骷髅骑兵：中远距离有概率改掷长矛（贴脸不掷；每次决策只掷一次判定）
          if (def.throw && dist >= MOB_THROW.minDist && dist <= MOB_THROW.maxDist &&
            Math.abs(dy) < 150 && time >= (e.throwAt || 0)) {
            e.throwAt = time + MOB_THROW.cd;
            if (Math.random() < MOB_THROW.chance) {
              e.willThrow = true;
              e.state = 'windup';
              e.windupUntil = time + def.windup;
              e.windupStart = time; e.windupDur = def.windup;
              spr.setVelocityX(0);
              spr.setFlipX(dirToHero < 0);
              self.showThrowWindup(e);
              return;
            }
          }

          // ===== P2：近战怪对空手段 =====
          // 玩家能踩头反复滞空之后，chaser 类必须能把人从空中打下来，否则就是无解打法。
          // 起跳前有 300ms 前摇 + 头顶「扑击!」提示，可闪、可走位躲开。
          if (def.behavior === 'chaser' && !def.fly && !tgt.core && spr.body.blocked.down &&
            self.floor >= RHYTHM.pounceMinFloor && self.difficulty !== 'easy' &&
            dy < -RHYTHM.pounceRise && dy > -360 && dist <= RHYTHM.pounceRange &&
            time >= (e.pounceAt || 0)) {
            e.pounceAt = time + RHYTHM.pounceCd;
            e.pounce = true;
            e.willThrow = false;
            e.state = 'windup';
            e.windupUntil = time + RHYTHM.pounceWindup;
            e.windupStart = time; e.windupDur = RHYTHM.pounceWindup;
            spr.setVelocityX(0);
            spr.setFlipX(dirToHero < 0);
            self.showFloat(spr.x, spr.y - 88, '扑击!', '#ffd76a', 15);
            sfx('spearwind');
            return;
          }

          if (dist <= def.attackRange && Math.abs(dy) < 90 && time >= (e.attackAt || 0)) {
            e.willThrow = false;
            e.state = 'windup';
            e.windupUntil = time + def.windup;
            e.windupStart = time; e.windupDur = def.windup;
            spr.setVelocityX(0);
            return;
          }

          var vx = dirToHero * def.speed;
          if (def.fly) {
            spr.setVelocityY(clamp(dy * 1.7, -170, 170));
            e._flyChase = true;          // 本帧唯一允许改飞行怪 vy 的地方
          } else if (spr.body.blocked.left || spr.body.blocked.right) {
            spr.setVelocityY(-560);
          }
          spr.setVelocityX(vx);
          spr.play(self.mobAnimKey(e, 'walk'), true);
        } else {
          // 巡逻
          if (time > e.patrolUntil) {
            e.patrolUntil = time + ri(900, 2200);
            e.dir = Math.random() < 0.5 ? -1 : 1;
          }
          if (spr.body.blocked.left) e.dir = 1;
          if (spr.body.blocked.right) e.dir = -1;
          if (!def.fly && spr.body.blocked.down && !self.groundAhead(spr, e.dir)) e.dir *= -1;
          spr.setVelocityX(e.dir * def.speed * 0.5);
          spr.setFlipX(e.dir < 0);
          spr.play(self.mobAnimKey(e, 'walk'), true);
        }

        // --- 献祭者：周期性给周围同伴套血盾（它自己不追不打）---
        //     它制造的不是伤害压力，而是"你打不动别的怪了" —— 逼玩家换目标。
        //     排在这里（而不是塞进 windup）是因为它**不攻击**，只是周期施法。
        if (def.auraShield && aware) {
          if (!e.nextSpecial) e.nextSpecial = time + ri(2400, 3600);
          if (time >= e.nextSpecial) {
            e.nextSpecial = time + ri(3000, 4200);
            self.sacrificeShield(e);
          }
        }

        // --- Boss 特殊：周期性跳跃砸地 ---
        if (def.behavior === 'boss' && aware) {
          if (!e.nextSpecial) e.nextSpecial = time + ri(2800, 4400);
          if (time >= e.nextSpecial && spr.body.blocked.down) {
            e.nextSpecial = time + ri(2800, 4400);
            self.bossSlam(e);
          }
        }
      });

      // 飞行怪的垂直收敛 / 位置夹取 / 离屏回追（2.9.1 F4）
      // 必须放在 forEach **之后**：上面有一半分支是裸 return，逐条补 setVelocityY(0)
      // 早晚会漏掉以后新加的那一种。
      this.fixFlyers(time);
    }

    /**
     * 飞行怪的垂直收敛 + 位置夹取 + 离屏回追（2.9.1 F4）
     * ------------------------------------------------------------
     * 现象：影偶尔飞出画面，远程也打不到，房间清不掉 → 卡关。
     * 根因：飞行怪的**垂直速度只在追击分支里写**，而它 setAllowGravity(false) ——
     *      没有重力，残留的 vy 会永久生效。一旦它比玩家高出检索窗口，
     *      就永远进不了追击状态，只能继续巡逻；巡逻也不改 vy，于是永久停在画面外。
     * 三道闸（顺序即优先级）：
     *   ① 非追击状态把 vy 归零 —— 从源头掐死"惯性飞走"；
     *   ② 每帧夹进 [hudSafeTop+20, groundY-16] × [40, levelWidth-40] —— 兜底，
     *      任何漏掉的分支都翻不出去；
     *   ③ 连续 2 秒不在可视区 → 送回玩家附近并淡入 —— 兜底之上再兜一层。
     */
    fixFlyers(time) {
      var cam = this.cameras && this.cameras.main;
      var view = cam ? cam.worldView : null;
      var top = this.hudSafeTop() + 20;
      var bot = this.groundY - 16;
      for (var i = 0; i < this.enemies.length; i++) {
        var e = this.enemies[i];
        if (!e || !e.alive) continue;
        var spr = e.sprite, def = e.def;
        if (!spr || !spr.active || !spr.body || !def || !def.fly) continue;

        // ① 非追击 → 垂直速度归零
        if (!e._flyChase) spr.setVelocityY(0);

        // ② 硬夹取（越界那一帧直接搬回来，不让它在墙外积累速度）
        var x = spr.x, y = spr.y, moved = false;
        if (y < top) { y = top; moved = true; }
        else if (y > bot) { y = bot; moved = true; }
        if (x < 40) { x = 40; moved = true; }
        else if (x > this.levelWidth - 40) { x = this.levelWidth - 40; moved = true; }
        if (moved) {
          spr.body.reset(x, y);
          if (e._flyChase && y === top) spr.setVelocityY(0);   // 贴上沿就不要再往上顶
        }

        // ③ 离屏 2 秒 → 回追
        if (view && view.width > 0) {
          var inView = x > view.x - 120 && x < view.right + 120 &&
            y > view.y - 120 && y < view.bottom + 120;
          if (inView) {
            e._offscreenSince = 0;
          } else if (!e._offscreenSince) {
            e._offscreenSince = time;
          } else if (time - e._offscreenSince > 2000) {
            this.recallFlyer(e);
          }
        }
      }
    }

    /** 把卡在画面外的飞行怪送回玩家附近（带 0.4s 淡入，避免突然贴脸） */
    recallFlyer(e) {
      var spr = e.sprite;
      if (!spr || !spr.body || !spr.active) return;
      var dir = Math.random() < 0.5 ? -1 : 1;
      var x = clamp(this.hero.x + dir * rnd(220, 340), 60, this.levelWidth - 60);
      var y = clamp(this.groundY - 200, this.hudSafeTop() + 30, this.groundY - 40);
      // body.reset 同时搬 body 与 sprite 并清零速度，比 setPosition 可靠
      spr.body.reset(x, y);
      spr.setAlpha(0);
      this.tweens.add({ targets: spr, alpha: 1, duration: 400, ease: 'Quad.easeOut' });
      e.state = 'chase';
      e.attackAt = this.time.now + 300;
      e._offscreenSince = 0;
    }

    /** 前方是否有落脚点（防止走下悬崖） */
    groundAhead(spr, dir) {
      var probeX = spr.x + dir * 42;
      var probeY = spr.y + 14;
      var found = false;
      this.groundTiles.forEach(function (t) {
        if (!found && Math.abs(t.x - probeX) < 42 && Math.abs(t.y - probeY) < 70) found = true;
      });
      if (!found) {
        this.platformTiles.forEach(function (t) {
          if (!found && Math.abs(t.x - probeX) < 46 && Math.abs(t.y - probeY) < 40) found = true;
        });
      }
      return found;
    }

    enemyStrike(e) {
      var spr = e.sprite, def = e.def;
      // 守点房：目标是核心时挥向核心（核心不还手、不移动，但会被打掉血）
      var H = this.holdZone;
      if (e._aimCore && H && H.coreAlive && !H.ended) {
        var cdir = H.coreX >= spr.x ? 1 : -1;
        var creach = def.attackRange + 20;
        var cx = spr.x + cdir * (def.attackRange * 0.55);
        var crect = new Phaser.Geom.Rectangle(cx - creach / 2, spr.y - 54, creach, 64);
        var coreRect = new Phaser.Geom.Rectangle(H.coreX - 24, H.coreY - 26, 48, 52);
        if (Phaser.Geom.Intersects.RectangleToRectangle(crect, coreRect)) {
          this.damageCore(def.tier === 'elite' ? CORE.dmgElite : CORE.dmgNormal, e);
        } else {
          this.showFloat(spr.x + cdir * 30, spr.y - 48, '落空', '#8a8a9a', 14);
        }
        return;
      }
      var dir = this.hero.x >= spr.x ? 1 : -1;
      var reach = def.attackRange + 20;
      var hx = spr.x + dir * (def.attackRange * 0.55);
      var rect = new Phaser.Geom.Rectangle(hx - reach / 2, spr.y - 54, reach, 64);
      if (Phaser.Geom.Intersects.RectangleToRectangle(rect, this.hero.getBounds())) {
        this.damageHero(e.atk, e, false);
      } else {
        this.showFloat(spr.x + dir * 30, spr.y - 48, '落空', '#8a8a9a', 14);
      }
    }

    /** 掷矛前摇：手里亮出长矛 + 一声提示（玩家有时间闪避） */
    showThrowWindup(e) {
      var spr = e.sprite;
      var color = this.throwColor();
      var tex = 角色形象.ensureShotTexture(this, 'spear', color);
      if (e.throwFx) e.throwFx.destroy();
      e.throwFx = this.add.image(spr.x, spr.y - 42, tex).setDepth(10).setFrame(0);
      e.throwFx.setFlipX(spr.flipX);
      e.throwFx.setRotation(spr.flipX ? 0.6 : -0.6);
      this.showFloat(spr.x, spr.y - 96, '掷矛!', '#ffd76a', 15);
      sfx('spearwind');
    }

    /** 骷髅骑兵的长矛颜色（骨头白，取自形象表） */
    throwColor() {
      var m = 角色形象.MOB_SHOTS && 角色形象.MOB_SHOTS.skeleton;
      return (m && m.color) || 0xd8d8e8;
    }

    /**
     * 骷髅骑兵：掷出长矛
     * 自己算抛物线（世界重力对弹丸太重），落点按玩家当前位置解算 —— 不做提前量，
     * 所以「看到矛 → 按 K 闪开」永远有效。
     */
    enemyThrowSpear(e) {
      var spr = e.sprite;
      if (e.throwFx) { e.throwFx.destroy(); e.throwFx = null; }
      spr.setFrame(ENEMY_FRAMES.attack[1]);      // 发力帧：前倾把矛送出去
      var color = this.throwColor();
      var tex = 角色形象.ensureShotTexture(this, 'spear', color);
      var anim = 角色形象.ensureShotAnim(this, 'spear', color, 10);
      // 守点房：矛也掷向核心（骷髅骑兵进了守点房不该只对着墙扔）
      var H = this.holdZone;
      var aimCore = !!(e._aimCore && H && H.coreAlive && !H.ended && !this.heroDead);
      var tx = aimCore ? H.coreX : this.hero.x;
      var ty = aimCore ? H.coreY : (this.hero.y - 34);
      var dir = tx >= spr.x ? 1 : -1;
      var mx = spr.x + dir * 18, my = spr.y - 40;

      var p = this.physics.add.sprite(mx, my, tex, 0);
      p.setDepth(9);
      p.play(anim);
      p.body.setAllowGravity(false);
      var szs = 角色形象.shotSize('spear');
      p.body.setSize(szs.bw, szs.bh, true);

      var dx = tx - mx;
      var dy = ty - my;
      var t = clamp(Math.abs(dx) / MOB_THROW.speed, 0.3, 1.1);        // 飞行时间
      var vx = dx / t;
      var vy = (dy - 0.5 * MOB_THROW.gravity * t * t) / t;            // 抛物线解算
      p.setVelocity(vx, vy);
      p.setRotation(Math.atan2(vy, vx));

      p._dmg = aimCore ? CORE.dmgNormal : Math.round(e.atk * MOB_THROW.mult);
      p._core = aimCore;
      p._grav = MOB_THROW.gravity;
      p._stick = MOB_THROW.stick;
      p._spin = true;
      this.projectiles.push(p);
      this.spark(mx, my, color);
      sfx('spear');
    }

    /**
     * 织网者吐网：一张缓慢的、不打伤害的网 —— 命中后把玩家缠住（移动掉到 45%）。
     * 刻意做得比伤害弹**更慢、更大、更亮**：它不负责掉血，
     * 负责逼玩家在"闪掉这一发"和"先吃一下换个输出窗口"之间做选择。
     */
    enemyWeave(e) {
      var spr = e.sprite;
      var dir = this.hero.x >= spr.x ? 1 : -1;
      var mx = spr.x + dir * 26, my = spr.y - 34;
      var p = this.add.circle(mx, my, 10, 0xa8e88a, 0.45).setDepth(9);
      p.setStrokeStyle(2, 0xd8ff9a, 0.9);
      this.physics.add.existing(p);
      p.body.setAllowGravity(false);
      try { p.body.setCircle(12); } catch (err) { /* 忽略 */ }
      // Arc（Shape）没有 setVelocity，而 updateProjectiles 是按"有 setVelocity 的弹丸"
      // 写的（触地插住、抛物线积分都会调它）—— 在这里补一个同名方法，
      // 整条弹丸管线就不必为蛛网开特例。
      p.setVelocity = function (vx, vy) { if (this.body) this.body.setVelocity(vx, vy); return this; };
      var ang = Math.atan2((this.hero.y - 30) - my, this.hero.x - mx);
      p.setVelocity(Math.cos(ang) * WEB.speed, Math.sin(ang) * WEB.speed);
      p._web = true;
      p._dmg = 0;
      p._lifeUntil = this.time.now + 3600;
      this.projectiles.push(p);
      this.showFloat(spr.x, spr.y - 86, '吐网', '#a8e88a', 15);
      sfx('shot');
    }

    /**
     * 献祭者：给周围同伴套一层"血盾"（吸伤），自己也吃一半。
     * 关键设计：它自己**几乎不构成威胁**，威胁是"你打不动别的怪了"。
     * 所以必须同时满足两条，否则它只是烦躁来源而不是机制：
     *   · 看得见 —— 每个中盾的怪身上有青色环 + 飘字
     *   · 杀得掉 —— 血量不高，而且它自己不还手
     */
    sacrificeShield(e) {
      var self = this;
      var amount = Math.round(6 + this.floor * 1.2);
      var radius = 320;
      var n = 0;
      this.enemies.forEach(function (o) {
        if (!o.alive || o === e) return;
        if (Math.abs(o.sprite.x - e.sprite.x) > radius) return;
        o.shield = Math.max(o.shield || 0, amount);
        self.refreshEnemyShieldRing(o);
        self.showFloat(o.sprite.x, o.sprite.y - 88, '血盾 +' + amount, '#ff8aa0', 14);
        n++;
      });
      // 自己也吃一半：完全不给，它一被集火就没了、机制撑不到玩家做决定；
      // 给满又会让"优先击杀"变成纯耗时间
      e.shield = Math.max(e.shield || 0, Math.round(amount * 0.5));
      this.refreshEnemyShieldRing(e);

      var ring = this.add.circle(e.sprite.x, e.sprite.y - 26, 16, 0xff8aa0, 0.22).setDepth(11);
      ring.setStrokeStyle(3, 0xff8aa0, 0.9);
      this.tweens.add({ targets: ring, radius: radius, alpha: 0, duration: 380, onComplete: function () { ring.destroy(); } });
      this.showFloat(e.sprite.x, e.sprite.y - 106, '血祭 · 护佑 ' + n + ' 名同伴', '#ff8aa0', 16);
      sfx('levelUp');
      if (state.settings.screenShake2D !== false) this.cameras.main.shake(80, 0.003);
    }

    enemyShoot(e) {
      var spr = e.sprite, def = e.def;
      // 守点房：朝核心射击（§3.4 "站 260–340px 外朝核心射击；弹道不做格挡"）
      var H = this.holdZone;
      var aimCore = !!(e._aimCore && H && H.coreAlive && !H.ended && !this.heroDead);
      var tx = aimCore ? H.coreX : this.hero.x;
      var ty = aimCore ? H.coreY : (this.hero.y - 30);
      var dir = tx >= spr.x ? 1 : -1;

      // 织网者不发普通弹：它的"攻击"是一张网（见上）。网永远缠玩家 —— 核心不会走位
      if (def.web) { this.enemyWeave(e); return; }

      // 镜像怪：用玩家英雄的同一种弹道（颜色换成镜像紫），慢一档，看得见、闪得掉
      if (def.rangedKind && 角色形象.SHOTS[def.rangedKind]) {
        var kind = def.rangedKind;
        var color = 角色形象.LOOKS.mimic.colors.acc;
        var tex = 角色形象.ensureShotTexture(this, kind, color);
        var anim = 角色形象.ensureShotAnim(this, kind, color, kind === 'wave' ? 9 : 16);
        var mx = spr.x + dir * 26, my = spr.y - 34;
        var s = this.physics.add.sprite(mx, my, tex, 0);
        s.setDepth(9);
        s.play(anim);
        s.body.setAllowGravity(false);
        var sz = 角色形象.shotSize(kind);
        s.body.setSize(sz.bw, sz.bh, true);
        var dx = tx - mx, dy = ty - my;
        if (Math.abs(dx) < 8) dx = dir * 8;
        var ang = Math.atan2(dy, dx);
        var sp = def.rangedSpeed || 520;
        s.setVelocity(Math.cos(ang) * sp, Math.sin(ang) * sp);
        if (kind !== 'orb') s.setRotation(ang);
        s._dmg = Math.round(e.atk * 0.9);
        s._core = aimCore;
        this.projectiles.push(s);
        this.spark(mx, my, color);
        return;
      }

      var p = this.physics.add.image(spr.x + dir * 24, spr.y - 34, TEX.projectile);
      p.setDepth(9);
      p.body.setAllowGravity(false);
      p.setVelocity(dir * 330, clamp((ty - (spr.y - 34)) * 0.9, -170, 170));
      p._dmg = aimCore ? CORE.dmgShooter : Math.round(e.atk * 0.9);
      p._core = aimCore;
      this.projectiles.push(p);
      this.spark(spr.x + dir * 24, spr.y - 34, 0xd8b0ff);
    }

    bossSlam(e) {
      var spr = e.sprite;
      spr.setVelocityY(-820);
      var self = this;
      this.tweens.add({ targets: spr, angle: 12, duration: 200, yoyo: true });
      this.showFloat(spr.x, spr.y - 96, '砸地!', '#ff8a7a', 18);
      var check = this.time.addEvent({
        delay: 60, repeat: 34, callback: function () {
          if (!spr.active) { check.remove(); return; }
          if (spr.body.blocked.down && spr.body.velocity.y >= 0) {
            check.remove();
            self.cameras.main.shake(260, 0.014);
            self.spark(spr.x, spr.y, 0xff8a7a);
            if (Math.abs(self.hero.x - spr.x) < 160 && self.hero.body.blocked.down) {
              self.damageHero(Math.round(e.atk * 1.2), e, false);
            }
          }
        }
      });
    }
  }

  /**
   * 创建 Phaser.Game
   * 渲染器由调用方决定，失败时可以换另一种再试一次 —— Phaser.AUTO 内部不会这么做。
   */
  /**
   * 渲染配置：标称档 / 极简档
   * ------------------------------------------------------------
   * 标称档就是原来那一套。极简档是给「WebGL 检测得到、真建 context 就翻脸」的
   * 设备准备的 —— iOS 省电模式、Safari 里关掉硬件加速、WebGL context 名额被上一个
   * 页面占着、低内存机型，这些情况下标称参数会直接创建失败，而失败就等于
   * 「被丢回文字界面」，对玩家来说就是"苹果玩不了 2D"。
   *
   * 极简档只动渲染与显存相关的开关，**完全不动 scale / physics / scene**，
   * 所以退到极简档只是画面糙一点（关抗锯齿、关像素吸附以外的修饰），玩法一模一样。
   *   · preserveDrawingBuffer / desynchronized：iOS 上最吃显存的两项
   *   · powerPreference 压到 low-power：省电模式下 high-performance 会被直接拒绝
   *   · batchSize 减半：顶点缓冲占用减半
   */
  function renderConfig(minimal) {
    if (!minimal) return { antialias: false, pixelArt: true, roundPixels: false };
    return {
      antialias: false,
      pixelArt: false,
      roundPixels: true,
      preserveDrawingBuffer: false,
      desynchronized: false,
      failIfMajorPerformanceCaveat: false,
      clearBeforeRender: true,
      powerPreference: 'low-power',
      batchSize: 2048
    };
  }

  function createGame(container, Phaser, renderType, minimal) {
    return new Phaser.Game({
      type: renderType,
      parent: container,
      width: 960,
      height: 540,
      backgroundColor: '#07070f',
      scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.NO_CENTER },
      physics: { default: 'arcade', arcade: { gravity: { y: GRAVITY }, debug: false } },
      render: renderConfig(minimal),
      audio: { noAudio: true },
      scene: [BattleScene]
    });
  }

  // ============================================================
  //  苹果设备（iOS / iPadOS / macOS Safari）专项适配
  // ============================================================

  /** 是否苹果移动端。iPadOS 13+ 的 UA 伪装成 Mac，靠「Mac + 多指触摸」识别 */
  function isAppleTouch() {
    try {
      var ua = navigator.userAgent || '';
      if (/iPad|iPhone|iPod/.test(ua)) return true;
      if (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1) return true;
      return false;
    } catch (e) { return false; }
  }

  /** 是否已经从主屏幕启动（iOS 上这是唯一能拿到「真全屏 + 无地址栏」的方式） */
  function isStandalone() {
    try {
      if (navigator.standalone) return true;
      if (window.matchMedia) {
        if (window.matchMedia('(display-mode: standalone)').matches) return true;
        if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
      }
      return false;
    } catch (e) { return false; }
  }

  /**
   * 手势守卫
   * ------------------------------------------------------------
   * iOS Safari 从 10 开始就**忽略** user-scalable=no：双指捏合、双击仍然会缩放页面。
   * 在横版动作里这是灾难 —— 玩家手指一并拢，画面就被放大到只剩半个屏幕，
   * 而界面上没有任何入口能缩回去（只能刷新重进）。
   * Safari 专有的 gesture* 事件是唯一能拦住它的钩子，双指 touchmove 作为兜底。
   *
   * 这里刻意**不碰 touchend**：在 touchend 上 preventDefault 会连带吃掉 DOM 按钮的
   * click 合成，设置 / 图鉴 / 退出试炼就全都点不动了。双击缩放交给 CSS 的
   * touch-action: manipulation（iOS 13+ 生效）去解决。
   */
  function installGestureGuard() {
    if (state._gestureGuard) return;
    state._gestureGuard = true;
    try {
      ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) {
        document.addEventListener(ev, function (e) {
          if (e && e.cancelable) e.preventDefault();
        }, { passive: false });
      });
      document.addEventListener('touchmove', function (e) {
        // 双指 = 缩放意图，一律拦；单指放行，交给画布里的摇杆
        if (e.touches && e.touches.length > 1 && e.cancelable) e.preventDefault();
      }, { passive: false });
    } catch (e) { /* 老浏览器不支持 passive 选项：忽略，CSS 那一层仍在 */ }
  }

  /**
   * 渲染健康看门狗
   * ------------------------------------------------------------
   * iOS 上「切出去看一眼消息 / 锁屏 / 来电横幅」之后回来，WebGL context 被系统回收
   * 是常态（Safari 比安卓激进得多）。原来的表现是全黑，只能刷新页面重进。
   * 这里补三件事：
   *   · 拦 webglcontextlost 并 preventDefault —— 不拦的话浏览器根本不会再发 restored
   *   · restored 之后刷新尺寸 + 唤醒循环（Phaser 自己会重传纹理，这里只补外围）
   *   · 回到前台主动 wake + refresh，修掉 iOS 上 rAF 被系统掐掉后不再续上的情况
   */
  function bindRenderHealth(game) {
    if (game && game.canvas && !game.canvas.__dshRenderHealth) {
      game.canvas.__dshRenderHealth = true;
      game.canvas.addEventListener('webglcontextlost', function (e) {
        if (e && e.cancelable) e.preventDefault();
        state.contextLost = true;
        console.warn('[战斗2D] WebGL 上下文被系统回收，等待自动恢复…');
      }, false);
      game.canvas.addEventListener('webglcontextrestored', function () {
        state.contextLost = false;
        console.log('[战斗2D] WebGL 上下文已恢复');
        API.show();
        fixCanvasSize();
        if (state.scene && state.scene.onContextRestored) {
          try { state.scene.onContextRestored(); } catch (e) { /* 恢复辅助失败不影响主流程 */ }
        }
      }, false);
    }

    if (state._visibilityBound) return;
    state._visibilityBound = true;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      // 回到前台：rAF 停过、visualViewport 变了，尺寸与循环都要补一手
      try { if (state.game && state.game.loop) state.game.loop.wake(); } catch (e) { /* 忽略 */ }
      try { if (typeof global._updateTrial2DVh === 'function') global._updateTrial2DVh(); } catch (e) { /* 忽略 */ }
      fixCanvasSize();
      try { if (state.game && state.game.scale) state.game.scale.refresh(); } catch (e) { /* 忽略 */ }
    });
  }

  // ============================================================
  //  公开 API
  // ============================================================
  var API = {
    available: function () { return state.available; },
    isBooted: function () { return !!state.booted; },
    isEnabled: function () { return state.enabled !== false; },
    isReady: function () { return !!(state.available && state.scene && state.scene.ready); },
    getGame: function () { return state.game; },
    /** 实际落地的渲染器：'webgl' | 'canvas' | null（未启动） */
    getRenderMode: function () { return state.renderMode; },
    /** 初始化失败原因（宿主可直接显示给玩家，替代干巴巴的 console） */
    lastError: function () { return state.lastInitError || null; },
    /** 当前画质档位 */
    getQuality: function () { return state.quality; },
    getSettings: function () { return state.settings || loadSettings(); },

    setSettings: function (patch) {
      var before = (state.settings && state.settings.hudDensity) || 'auto';
      var s = saveSettings(patch);
      // HUD 密度会改变画面上"哪些信息常驻"，必须**当场**重排，
      // 否则玩家在设置里切了档，回到战斗却什么都没变（要等下次开局才生效）。
      var after = (s && s.hudDensity) || 'auto';
      if (before !== after && state.scene && state.scene.ready) {
        try { state.scene.applyHudDensity(); } catch (e) { console.warn('[战斗2D] 应用 HUD 密度失败：', e); }
      }
      if (s.enabled === false) API.hide(); else if (state.booted) API.show();
      return s;
    },
    setEnabled: function (f) { return API.setSettings({ enabled: !!f }); },
    setActionHandler: function (fn) { state.actionHandler = fn; },

    /**
     * 注册宿主桥接（持有内核状态的宿主）：
     *   exit(result)          结束本局并把结果交回宿主（宿主负责回写与收尾）
     *   toggleView(snapshot)  遗留键：原本用于切到文字界面，v2.8 删掉那颗按钮后
     *                         引擎已无调用点（键名保留，宿主自己实现不受影响）
     *   shopData(points)      取商店目录（含金币同步）
     *   shopBuy(id, points)   购买商品（返回 {ok,msg,points,name}）
     */
    setBridge: function (b) {
      if (!b) { state.bridge = {}; return state.bridge; }
      for (var k in b) {
        if (typeof b[k] === 'function') state.bridge[k] = b[k];
      }
      return state.bridge;
    },

    init: function (container, force) {
      if (state.booted) return true;
      var Phaser = global.Phaser;
      if (!Phaser) {
        state.lastInitError = '未检测到 Phaser（vendor/phaser.min.js 未加载）';
        console.warn('[战斗2D] ' + state.lastInitError);
        state.available = false;
        return false;
      }
      if (!container) {
        state.lastInitError = '缺少画布容器';
        console.warn('[战斗2D] ' + state.lastInitError);
        state.available = false;
        return false;
      }

      // 这几步原本裸奔在 try 之外：任意一步抛异常都会直接冒泡出去，
      // 绕过下面的降级逻辑（表现为「点了没反应」或直接回退文字模式）。
      try {
        loadSettings();
        if (force) probeWebGL(true);      // 强制重试时重新探测 WebGL
        state.quality = detectQuality();
        state.container = container;
        installFontDefault();
      } catch (e) {
        state.lastInitError = '初始化前置步骤失败：' + e;
        console.error('[战斗2D] ' + state.lastInitError, e);
        state.available = false;
        return false;
      }
      state.available = true;

      // 逐个尝试渲染方案：标称 WebGL → 标称 Canvas → 极简 WebGL → 极简 Canvas。
      // 为什么排满四种而不是「探测到什么就用什么」：
      //   苹果设备上「探测得到 WebGL、真建 context 却失败」非常常见 ——
      //   省电模式、Safari 里关掉硬件加速、WebGL context 名额被上一个页面占着、
      //   低内存机型，探测那一下是能过的（只建了 1×1 的小 context），
      //   真建 960×540 的游戏 context 时就翻脸。反过来某些老 WebKit 上
      //   Canvas 渲染器会因像素格式不兼容而失败。
      //   四条里只要有一条能过，玩家就能进 2D，而不是被丢回文字界面。
      var plans = [
        { type: Phaser.WEBGL,  minimal: false, label: 'WebGL' },
        { type: Phaser.CANVAS, minimal: false, label: 'Canvas' },
        { type: Phaser.WEBGL,  minimal: true,  label: 'WebGL(兼容)' },
        { type: Phaser.CANVAS, minimal: true,  label: 'Canvas(兼容)' }
      ];
      var tried = [];

      for (var i = 0; i < plans.length; i++) {
        var plan = plans[i];
        try {
          // 换档前重新探测：上一轮失败可能刚刚把 context 用掉，缓存会误导画质决策
          if (plan.minimal) probeWebGL(true);
          // 建引擎**之前**先把这一档密度算出来：场景 create() 里的图标 / 血条纹理
          // 都是"按密度生成一次"的，开机后再变就会出现纹理与大盘不同口径。
          preseedDensity(container, plan.type === Phaser.WEBGL);
          state.game = createGame(container, Phaser, plan.type, plan.minimal);
          state.booted = true;
          installDensity(state.game);
          state.renderMode = (state.game.renderer && state.game.renderer.type === Phaser.WEBGL) ? 'webgl' : 'canvas';
          state.compatMode = !!plan.minimal;
          // Canvas 渲染器是纯 CPU 光栅化：强制最低画质，否则移动端必掉帧
          if (state.renderMode === 'canvas') state.quality = 'low';
          state.lastInitError = null;
          bindRenderHealth(state.game);
          installGestureGuard();
          // 场景引导兜底（热刷新时序问题会导致场景不入队）
          scheduleBootGuard();
          console.log('========================================');
          console.log(' 深渊回廊 · 2D 实时战斗引擎 启动成功');
          console.log(' 引擎: Phaser ' + Phaser.VERSION);
          console.log(' 渲染: ' + (state.renderMode === 'webgl' ? 'WebGL' : 'Canvas（已自动降画质）') +
            (state.compatMode ? ' · 兼容模式' : '') + ' · 画质 ' + state.quality);
          console.log(' 设备: ' + (isAppleTouch() ? '苹果移动端' : '其他') + (isStandalone() ? '（主屏幕启动）' : ''));
          console.log(' 操作: A/D 或 ←/→ 移动 · W/空格 跳跃 · J/鼠标 挥砍 · L 药水');
          console.log('========================================');
          return true;
        } catch (e) {
          var why = (e && (e.message || e.name)) || String(e);
          tried.push(plan.label + '（' + why + '）');
          console.warn('[战斗2D] ' + plan.label + ' 创建引擎失败，换下一种渲染方式重试：', e);
          try { if (state.game && state.game.destroy) state.game.destroy(true); } catch (e2) { /* 忽略 */ }
          state.game = null;
          state.booted = false;
        }
      }

      // 把四条路各自的失败原因全部留下来：苹果设备上玩家看不到 console，
      // 只有把原文摆到界面上，才可能一次说清「到底哪一步过不去」。
      state.lastInitError = '四种渲染方式都失败 → ' + tried.join('；');
      console.error('[战斗2D] 初始化失败：' + state.lastInitError);
      state.available = false; state.booted = false;
      return false;
    },

    show: function () {
      if (state.container) state.container.classList.remove('trial2d-hidden');
      if (state.game && state.game.loop) state.game.loop.wake();
      fixCanvasSize();
    },
    hide: function () {
      if (state.container) state.container.classList.add('trial2d-hidden');
      if (state.game && state.game.loop) state.game.loop.sleep();
    },
    enter: function () { if (!state.available || !state.enabled) return false; API.show(); return true; },
    exit: function () { API.hide(); },

    /** 开始一局（场景未就绪时自动缓存） */
    startRun: function (d) {
      state.pendingStart = d || {};
      ensureSceneBooted(state.game, BattleScene);
      if (state.scene && state.scene.ready) {
        state.scene.beginRun(state.pendingStart);
        state.pendingStart = null;
        return true;
      }
      return false;
    },

    /** 更新英雄技能（宿主换英雄 / 状态变化时调用） */
    setSkill: function (skill) {
      if (!state.scene || !state.scene.ready) return false;
      var s = state.scene;
      s.skill = skill || null;
      s.skillId = (skill && skill.id) || '';
      s.skillUsed = !!(skill && skill.used);
      s.updateSkillHud();
      return true;
    },

    /**
     * 更新诅咒与环境效果（宿主在换层 / 状态变化时调用）
     * curses 传名字数组（与内核同一份），environment 传 generateEnvironmentEffect 的结果
     */
    setCursesEnv: function (curses, env) {
      if (!state.scene || !state.scene.ready) return null;
      return state.scene.setCursesAndEnv(curses, env);
    },

    /* ============================================================
       宿主主权接口（P1）
       ------------------------------------------------------------
       引擎是表现层：楼层规划 / 诅咒池 / 遗物 / 脉冲节拍由宿主决定，
       决策面板的内容也由宿主给。不接这些接口也不影响老宿主 ——
       不接就退回引擎内置行为（自造地图 / 内置诅咒池 / 默认节拍）。
       ============================================================ */

    /**
     * 局内切换难度时重设场景主题（星雾 / 火星 / 雾色）
     * ------------------------------------------------------------
     * ⚠️ 原来只有 beginRun 里调一次 applyEnvironment —— 于是"进 2D 前选的是地狱、
     *    画面有上升火星；局内把难度改成地狱却什么变化都没有"（用户反馈）。
     *    宿主在难度签名变化时会调这里。
     */
    setDifficultyTheme: function (diff) {
      if (!state.scene || !state.scene.ready) return false;
      state.scene.applyEnvironment(diff);
      return true;
    },

    /** 换层后按新下发的规划重取本层地图（时序说明见 Scene.rebuildFloorMap） */
    rebuildFloorMap: function () {
      var s = state.scene;
      if (!s || !s.ready) return false;
      return s.rebuildFloorMap();
    },

    /** 楼层 / 房间序列由宿主决定（写法见 Scene.floorMapFromPlan）；传 null 恢复内置自造地图 */
    setFloorPlan: function (plan) {
      HOST.floorPlan = plan || null;
      return HOST.floorPlan;
    },
    getFloorPlan: function () { return HOST.floorPlan; },

    /** 诅咒池（唯一来源：表外的名字会被静默丢弃）；传 null / 空数组恢复内置 10 条 */
    setCursePool: function (list) {
      HOST.cursePool = (list && list.length) ? list.slice() : null;
      var s = state.scene;
      if (s && s.ready) s.setCursesAndEnv(s.curses, s.worldEnv);   // 按新池重新过滤一遍
      return HOST.cursePool ? HOST.cursePool.length : null;
    },
    getCursePool: function () { return HOST.cursePool ? HOST.cursePool.slice() : null; },

    /** 遗物（字符串 id 或 { id, name, quality }）；获得 / 失去后重新下发整份即可 */
    setRelics: function (list) {
      var s = state.scene;
      if (s && s.ready) return s.setRelics(list);
      HOST.relics = (list || []).slice();
      HOST.relicFx = null;
      return HOST.relics.length;
    },
    getRelics: function () { return (HOST.relics || []).slice(); },
    getRelicFx: function () { return HOST.relicFx; },

    /* ============================================================
       2.9 · P0 骨架开关与布局采样
       ------------------------------------------------------------
       setSkeletonMode('legacy') 即完全回到 2.8 的平厅生成器（施工清单 §3.3），
       不需要回滚代码。布局采样走纯函数，不建对象，供验收脚本统计分布。
       ============================================================ */
    setSkeletonMode: function (mode) {
      SKELETON.mode = (mode === 'legacy') ? 'legacy' : 'skeleton';
      var s = state.scene;
      if (s && s.ready && s.levelWidth) {
        // 已经在对局里：立刻按新模式重建当前房间，方便当场对比（代价同 onResize 重建）
        try { s.buildLevel(s.roomNode); } catch (e) { console.warn('[战斗2D] 重建房间失败：', e); }
      }
      return SKELETON.mode;
    },
    getSkeletonMode: function () { return SKELETON.mode; },

    /**
     * 机制与流程的独立开关（单向平台 / 三色 / 读条 / 踩头 / 守点门闩 / 过门结算）
     * 只接受 TOGGLES 里已有的键；未知键忽略。返回合并后的完整状态。
     * 例：API.setToggles({ oneWay:false, stomp:false, holdGate:false })
     */
    setToggles: function (obj) {
      if (obj) {
        for (var k in obj) { if (k in TOGGLES) TOGGLES[k] = !!obj[k]; }
      }
      var out = {};
      for (var k2 in TOGGLES) out[k2] = TOGGLES[k2];
      return out;
    },
    getToggles: function () {
      var out = {};
      for (var k in TOGGLES) out[k] = TOGGLES[k];
      return out;
    },
    /**
     * 屏幕中央飘一行提示（宿主用来报"遗物已集齐 → 折成金币"这类补偿）
     * 宿主原来没有这个能力，只能在文字日志里写 —— 而 2D 玩家看不到日志。
     */
    toast: function (text, color) {
      var s = state.scene;
      if (!s || !s.showCenter || !text) return false;
      try { s.showCenter(String(text), color || '#ffd76a'); return true; } catch (e) { return false; }
    },
    /**
     * 机制参数默认值（按难度给整张表）
     * 预览页 / 调参工具直接读它，别再手抄一份 MECH_DIFF —— 抄的那份改引擎就会过期。
     */
    getMechanicDefaults: function () {
      var out = {};
      for (var d in MECH_DIFF) {
        out[d] = {
          segments: MECH_DIFF[d].collapse.segments,
          interval: MECH_DIFF[d].collapse.interval,
          warn: MECH_DIFF[d].collapse.warn,
          need: MECH_DIFF[d].collapse.need,
          enemies: MECH_DIFF[d].collapse.enemies,
          holdNeed: MECH_DIFF[d].hold.need,
          holdEnemies: MECH_DIFF[d].hold.enemies,
          timedNeed: MECH_DIFF[d].timed.need
        };
      }
      return out;
    },
    /**
     * 图鉴数据（P5）
     * 说明文字直接由运行时常量拼出来，不在主程序里另抄一份 ——
     * 改 MECH_DIFF / CRYSTAL / RHYTHM 时，图鉴会跟着变。
     */
    getCodexData: function () {
      // 与画布内图鉴同源：全部条目来自 codexTerrainEntries()，
      // 这里只把 [标签, 值] 拼成一句话（DOM 图鉴只要 title + description）。
      var entries = codexTerrainEntries().map(function (e) {
        var desc = e.rows.map(function (r) { return r[0] + '：' + r[1]; }).join('；');
        return { title: e.title, description: desc + (e.note ? '。' + e.note : '') };
      });
      return { entries: entries };
    },
    /** 机制回退开关：关掉后新房间不再抽到该机制（已在场上的不受影响） */
    setMechanicEnabled: function (name, on) {
      var s = state.scene;
      if (!s || !s.mechanicEnabled) return null;
      if (!(name in s.mechanicEnabled)) return null;
      s.mechanicEnabled[name] = !!on;
      return JSON.parse(JSON.stringify(s.mechanicEnabled));
    },
    /**
     * 塌陷 × 骨架的回退开关（方案 §11）
     * setCollapseSkeleton('double', false) → 双层房不再被抽成塌陷房（回到"塌陷只能挂平厅"）
     */
    setCollapseSkeleton: function (name, on) {
      if (name === 'double') MECHANIC.collapseOnDouble = !!on;
      else if (name === 'bridge') MECHANIC.collapseOnBridge = !!on;
      else return null;
      return { double: MECHANIC.collapseOnDouble, bridge: MECHANIC.collapseOnBridge };
    },
    /** 采样一份平厅布局（纯计算）：不传的参数用桌面基准值补齐 */
    sampleFlatLayout: function (opts) {
      var p = {
        floor: 1, nonCombat: false, viewW: 1280, viewH: 720,
        levelWidth: 2560, groundY: 624
      };
      if (opts) for (var k in opts) p[k] = opts[k];
      return flatSkeletonLayout(p);
    },

    /* ============================================================
       2.9 P4：调试单房间（塌陷回廊预览页 / 自动化验收）
       ------------------------------------------------------------
       调用前需要引擎已 startRun（预览页会自己起一局）。
       不进入楼层序列：buildLevel 之后直接挂机制，重开 = 再调一次。
       ============================================================ */
    startDebugRoom: function (opts) {
      var s = state.scene;
      if (!s || !s.ready) return false;
      return s.buildDebugRoom(opts || {});
    },
    getCollapseRecords: function () {
      var s = state.scene;
      return (s && s.collapseRecords) ? s.collapseRecords.slice() : [];
    },
    clearCollapseRecords: function () {
      var s = state.scene;
      if (s) s.collapseRecords = [];
      return true;
    },

    /** 脉冲节拍曲线 { start, step, min, warn }（规划 §3.12）；传 null 恢复按难度的默认表 */
    setPulseProfile: function (p) {
      HOST.pulse = p || null;
      var s = state.scene;
      if (s && s.ready) {
        s.pulseAt = s.time.now + s.pulseInterval();
        s.refreshHud();
      }
      return HOST.pulse;
    },
    /**
     * 敌人属性函数由宿主下发（数值统一的唯一落点）
     * ------------------------------------------------------------
     * 回调入参：{ key, tier, baseHp, baseAtk, floor, roomType }
     *   baseHp / baseAtk 是该敌人在 ENEMY_TYPES 里的**原始基数** ——
     *   宿主据此保留引擎内部的"种类相对强弱"，只把**量级**换成自己的公式。
     * 返回 { hp, atk }；返回假值或抛异常都会自动退回引擎内置曲线
     * （刷怪是核心路径，不能因为宿主算错就一只怪都不出）。
     */
    setEnemyScaler: function (fn) {
      HOST.enemyScaler = (typeof fn === 'function') ? fn : null;
      return !!HOST.enemyScaler;
    },

    getPulseInterval: function () {
      var s = state.scene;
      return (s && s.ready) ? s.pulseInterval() : null;
    },

    /**
     * 切 BGM 场景（宿主的合法入口）
     * 场景名见 AbyssAudio 的 SCENES：menu / explore / battle / boss / elite / mirror /
     * shop / rest / choice（层间抉择）/ ending。传不认识的名字会被 AbyssAudio 忽略。
     */
    setBgmScene: function (scene) {
      if (!scene) return false;
      setBgmScene(String(scene));
      return true;
    },

    /** 无敌（作弊面板 / 开发者命令）。开着时 damageHero 直接免疫，不改任何数值 */
    setGodMode: function (on) {
      HOST.godMode = !!on;
      var s = state.scene;
      if (s && s.ready) s.showCenter(HOST.godMode ? '无敌已开启' : '无敌已关闭', HOST.godMode ? '#ffd76a' : UI.muted);
      return HOST.godMode;
    },
    isGodMode: function () { return !!HOST.godMode; },

    /** 直接跳到本层第 index 个房间（作弊面板 / 开发者命令的「跳房」） */
    gotoRoom: function (index) {
      var s = state.scene;
      if (!s || !s.ready) return false;
      return s.gotoRoomByIndex(index);
    },

    /** 中途存档快照（宿主也可在任意时刻主动取；引擎自身不落盘） */
    checkpoint: function (reason) {
      var s = state.scene;
      return (s && s.ready) ? s.checkpointState(reason) : null;
    },

    /* ---- 决策面板（内容由宿主给，选择结果从 bridge.choiceResult 回传）---- */

    /** 三选一奖励：{ title, desc, cards, actions } */
    openRewardChoice: function (data) { return API.openChoicePanel('reward', data); },
    /** 诅咒抉择（深渊裂隙）：同上 */
    openCurseChoice: function (data) { return API.openChoicePanel('curse', data); },
    /** 事件面板 / 休整点：kind = 'event' | 'rest' */
    openEventPanel: function (kind, data) { return API.openChoicePanel(kind || 'event', data); },
    openChoicePanel: function (kind, data) {
      var s = state.scene;
      if (!s || !s.ready) return false;
      return s.openChoicePanel(kind, data);
    },
    closeChoicePanel: function (result) {
      var s = state.scene;
      if (!s || !s.ready) return false;
      return s.closeChoicePanel(result || null);
    },
    isChoiceOpen: function () { return !!(state.scene && state.scene.choiceOpen); },
    getChoiceCards: function () { return (state.scene && state.scene.choiceCards) || []; },

    /** 非战斗房间（商店 / 休整 / 事件）处理完：收尾并开放传送门 */
    finishRoomGoal: function () {
      var s = state.scene;
      if (!s || !s.ready) return false;
      return s.finishRoomGoal();
    },

    /** 2.9.4：宿主的奖励 / 遗物 / 裂隙 / 结局流程结束，允许引擎继续过门 */
    ackRoomCleared: function () {
      var s = state.scene;
      if (!s || !s.ready) return false;
      return s.ackRoomCleared();
    },
    /** 只有守点房：选完奖励直接开地图，不必再走到门 */
    shouldAutoMapAfterChoice: function () {
      var s = state.scene;
      if (!s || !s.ready) return false;
      return s.shouldAutoMapAfterChoice();
    },

    /* ---- 暂停菜单（画内）---- */
    openPauseMenu: function () {
      var s = state.scene;
      if (!s || !s.ready) return false;
      return s.openPauseMenu();
    },
    closePauseMenu: function () {
      var s = state.scene;
      if (!s || !s.ready) return false;
      return s.closePauseMenu();
    },
    isPaused: function () { return !!(state.scene && state.scene.pauseOpen); },

    /** 图鉴：打开 / 关闭（宿主按钮或触摸都能用） */
    openCodex: function (tab) {
      if (!state.scene || !state.scene.ready) return false;
      if (state.scene.codexOpen) state.scene.closeCodex();
      else state.scene.openCodex({ tab: tab });
      return true;
    },
    isCodexOpen: function () { return !!(state.scene && state.scene.codexOpen); },

    /** 狂怒：宿主（商店的「狂怒燃料」）用这个直接把怒槽充满 */
    fillFury: function () {
      if (!state.scene || !state.scene.ready) return false;
      return state.scene.addFury(FURY.max) > 0;
    },
    getFury: function () {
      if (!state.scene || !state.scene.ready) return null;
      return { fury: Math.round(state.scene.fury), max: FURY.max, active: state.scene.furyActive() };
    },

    /** 连携（技巧资源）：回归脚本用它验「攒 / 消费 / 挨打清零」，作弊面板也能直接塞 */
    getLink: function () {
      if (!state.scene || !state.scene.ready) return null;
      var s = state.scene;
      return { link: s.link || 0, max: Math.max(1, LINK.max), dmgMult: LINK.dmgMult };
    },
    setLink: function (n) {
      if (!state.scene || !state.scene.ready) return false;
      var s = state.scene;
      s.link = Math.max(0, Math.min(Math.max(1, LINK.max), Math.round(n || 0)));
      s.paintLinkMeter();
      return true;
    },

    stopRun: function () {
      state.pendingStart = null;
      if (state.scene && state.scene.ready) state.scene.abortRun();
    },

    /** 整场景停更（`scene.pause()`）：宿主需要「让 2D 彻底停住」时用（DOM 面板走 freezeForDom） */
    pauseRun: function () {
      if (state.scene && state.scene.ready) state.scene.pauseForView();
      return true;
    },

    /** 解除 pauseRun 的整场景停更 */
    resumeRun: function () {
      if (state.scene && state.scene.ready) state.scene.resumeFromView();
      return true;
    },

    /**
     * DOM 面板停战 / 复战（宿主打开侧边栏、设置、作弊等 DOM 面板时用）
     * ------------------------------------------------------------
     * 与 pauseRun/resumeRun 的区别：那一对会 scene.pause()（整场景停更，
     * 必须严格配对，漏一次就永久卡死）；这一对只做**逻辑冻结 + 停物理**，
     * 幂等、可重复调用。宿主 经典2D.js 的 freezeForDomPanel / watchDomPanels 用它。
     */
    freezeForDom: function () {
      if (state.scene && state.scene.ready) return state.scene.freezeForDom();
      return false;
    },

    thawForDom: function () {
      if (state.scene && state.scene.ready) return state.scene.thawForDom();
      return false;
    },

    /** 当前是否处于 DOM 面板冻结中（自动化回归用） */
    isDomFrozen: function () {
      return !!(state.scene && state.scene.ready && state.scene._viewPaused);
    },

    /** 实时战况快照（对外读取用；文字界面移除后引擎内已无调用点） */
    snapshot: function () {
      if (state.scene && state.scene.ready) return state.scene.buildSnapshot();
      return null;
    },

    /** 直接设置当前金币（宿主结算后回写：经典2D.js 的 syncPoints 把内核金币推给引擎） */
    setPoints: function (n) {
      if (!state.scene || !state.scene.ready || typeof n !== 'number' || !isFinite(n)) return false;
      state.scene.points = Math.max(0, Math.round(n));
      state.scene.refreshHud();
      return true;
    },

    /** 直接打开 / 关闭画面内商店（供宿主或测试调用） */
    openShop: function () {
      if (state.scene && state.scene.ready) { state.scene.openShop(); return true; }
      return false;
    },
    closeShop: function () {
      if (state.scene && state.scene.ready) { state.scene.closeShop(); return true; }
      return false;
    },

    /** 运行时同步玩家属性（商店/遗物生效） */
    syncPlayer: function (p) {
      if (state.scene && state.scene.ready) state.scene.applyPlayerStats(p);
    },

    debug: function () {
      var s = state.scene;
      var o = {
        available: state.available, enabled: state.enabled, booted: state.booted,
        quality: state.quality, ready: API.isReady(),
        renderType: (state.game && state.game.renderer && global.Phaser)
          ? (state.game.renderer.type === global.Phaser.WEBGL ? 'WebGL' : 'Canvas') : null,
        fps: state.game && state.game.loop ? Math.round(state.game.loop.actualFps) : null,
        // 苹果设备排障用：兼容模式 / 上下文回收 / 是否主屏幕启动，一眼能看出退到了哪一档
        compatMode: !!state.compatMode,
        contextLost: !!state.contextLost,
        appleTouch: isAppleTouch(),
        standalone: isStandalone(),
        // 高密度屏：真机"还是糊"时先看这两个数
        deviceDpr: realDeviceDpr(),
        renderDpr: Math.round(renderDpr() * 100) / 100
      };
      if (s && s.ready) {
        o.floor = s.floor;
        o.points = s.points;
        o.kills = s.kills || 0;
        o.roomsCleared = s.roomsCleared || 0;
        o.running = s.running;
        o.finished = !!s._finished;
        o.difficulty = s.difficulty;
        o.env = s.env ? s.env.name : null;
        o.mapOpen = !!s.mapOpen;
        o.shopOpen = !!s.shopOpen;
        o.deathOpen = !!s.deathOpen;
        o.confirmOpen = !!s.confirmOpen;
        o.viewPaused = !!s._viewPaused;
        o.roomGoal = s.roomGoal ? { kind: s.roomGoal.kind, done: s.roomGoal.done, awaiting: !!s.roomGoal.awaiting } : null;
        // --- 2.9 P0：骨架 / 统一房间目标 ---
        o.skeleton = {
          mode: SKELETON.mode,
          room: s.roomSkeleton || null,
          names: SKELETON.names,
          samples: SKELETON.samples,
          last: SKELETON.last ? { skeleton: SKELETON.last.skeleton, floor: SKELETON.last.floor, roomType: SKELETON.last.roomType } : null
        };
        // P3：地形结构（验收用：上层高度 / 缺口 / 地面分段）
        o.terrain = {
          deckY: s.deckY != null ? Math.round(s.deckY) : null,
          deckGaps: (s.deckGaps || []).map(function (g) { return { x0: Math.round(g.x0), x1: Math.round(g.x1) }; }),
          bridgeGaps: (s.bridgeGaps || []).map(function (g) { return { x0: Math.round(g.x0), x1: Math.round(g.x1) }; }),
          groundSegments: (s.groundSegments || []).map(function (g) { return { x0: Math.round(g.x0), x1: Math.round(g.x1) }; }),
          hudSafeTop: s.hudSafeTop ? s.hudSafeTop() : null
        };
        o.objective = s.roomObjective ? {
          type: s.roomObjective.type, need: s.roomObjective.need,
          got: s.roomObjective.got, done: !!s.roomObjective.done
        } : null;
        // 平台摆位（分布统计 / 100 房抽样验收用）
        o.platformSpots = (s.platformSpots || []).map(function (p) {
          return { x0: Math.round(p.x0), x1: Math.round(p.x1), y: Math.round(p.y), len: p.len };
        });
        // v2.9 P1：魂晶状态（三色 / 读条进度 / 剩余）与单向平台开关
        o.crystals = (s.crystals || []).map(function (c) {
          return {
            kind: c.kind, x: Math.round(c.core ? c.core.x : c.x), y: Math.round(c.core ? c.core.y : c.y),
            taken: !!c.taken, charge: Math.round((c.chargeMs || 0) / CRYSTAL.channelMs * 100) / 100,
            stillMs: Math.round(c.stillMs || 0)
          };
        });
        o.platformPass = !!s._platformPass;
        o.platformOneWay = s.platformTiles.length ? {
          up: s.platformTiles[0].body ? s.platformTiles[0].body.checkCollision.up : null,
          down: s.platformTiles[0].body ? s.platformTiles[0].body.checkCollision.down : null,
          left: s.platformTiles[0].body ? s.platformTiles[0].body.checkCollision.left : null,
          right: s.platformTiles[0].body ? s.platformTiles[0].body.checkCollision.right : null
        } : null;
        // v2.9 P4：塌陷回廊（预览页 / 验收读这一份）
        o.collapse = s.collapse ? {
          params: s.collapse.params,
          need: s.roomObjective ? s.roomObjective.need : s.collapse.params.need,
          got: s.roomObjective ? s.roomObjective.got : 0,
          elapsed: Math.round(s.collapse.elapsed / 100) / 10,
          segments: s.collapse.params.segments,
          blocks: s.collapse.groups.length,
          order: (s.collapse.order || []).slice(),
          skeleton: s.collapse.skeleton || null,
          collapsed: s.collapse.groups.filter(function (g) { return g.state === 'fallen'; }).length,
          nextOrder: s.collapse.nextOrder,
          deck: s.collapse.deck ? {
            y: Math.round(s.collapse.deck.y), fallen: !!s.collapse.deck.fallen,
            warned: !!s.collapse.deck.warned, warnGroup: s.collapse.deck.warnGroup
          } : null,
          warnIndex: s.collapse.warnIndex,
          frontier: s.collapse.frontier,
          unlocked: !!s.collapse.unlocked,
          forced: !!s.collapse.forced,
          ended: !!s.collapse.ended,
          falls: s.collapse.stats.falls,
          trappedMs: Math.round(s.collapse.stats.trappedMs),
          interrupts: s.collapse.stats.interrupts,
          damage: s.collapse.stats.damage,
          freeEscapes: s.collapse.stats.freeEscapes,
          kills: (s.kills || 0) - s.collapse.stats.killsStart,
          result: s.collapse.result || null
        } : null;
        o.collapseRecords = (s.collapseRecords || []).slice(-50);
        o.previewEnded = !!s.previewEnded;
        o.mechanic = s._roomMechanic || null;
        o.mechanicEnabled = s.mechanicEnabled ? JSON.parse(JSON.stringify(s.mechanicEnabled)) : null;
        o.hold = s.holdZone ? {
          x: Math.round(s.holdZone.x), y: Math.round(s.holdZone.y), r: s.holdZone.r, r0: s.holdZone.r0,
          started: !!s.holdZone.started, startAt: Math.round(s.holdZone.startAt || 0),
          got: Math.round(s.holdZone.t), need: s.holdZone.dur, unlocked: !!s.holdZone.unlocked,
          // 2.9.2 §3：核心 / 波次 / 结算（验收与预览页都读这一份）
          coreHp: Math.round(s.holdZone.coreHp), coreMax: s.holdZone.coreMax,
          coreAlive: !!s.holdZone.coreAlive, ratio: Math.round(s.coreRatio() * 100) / 100,
          prog: Math.round((s.holdZone.prog || 0) * 100) / 100,
          waveIdx: s.holdZone.waveIdx, waveAt: (s.holdZone.waveAt || []).slice(),
          queue: (s.holdZone.queue || []).length, cap: s.holdZone.cap,
          perWave: s.holdZone.perWave, dur: s.holdZone.dur,
          ended: !!s.holdZone.ended, outcome: s.holdZone.outcome || null,
          goldMul: s.holdZone.goldMul, shielded: s.coreShielded(),
          forceRanged: !!s.holdZone.forceRanged, spotWhere: s.holdZone.spotWhere || null
        } : null;
        o.timed = s.timedRoom ? {
          left: Math.max(0, Math.round(s.timedRoom.left)), need: s.timedRoom.need,
          expired: !!s.timedRoom.expired, unlocked: !!s.timedRoom.unlocked,
          text: s.timedRoom.text ? s.timedRoom.text.text : '',
          color: s.timedRoom.text ? s.timedRoom.text.style.color : null,
          barWidth: s.timedRoom.barWidth || 0,
          screenLocked: !!(s.timedRoom.text && s.timedRoom.gfx &&
            s.timedRoom.text.scrollFactorX === 0 && s.timedRoom.gfx.scrollFactorX === 0),
          candle: s.timedRoom.candle ? s.timedRoom.candle.texture.key : null
        } : null;
        o.settled = !!s._roomSettled;
        o.awaitAck = !!s._awaitClearAck;
        o.autoMapAfterChoice = s.shouldAutoMapAfterChoice();
        o.portalOpen = !!s.portalOpen;
        o.room = s.roomNode ? {
          type: s.roomNode.type, col: s.roomNode.col, row: s.roomNode.row,
          name: s.roomNode.name || null, payload: (s.roomNode.payload !== undefined) ? s.roomNode.payload : null
        } : null;
        // --- P1 交接状态：宿主主权 / 面板 / 遗物 / 脉冲 ---
        o.pauseOpen = !!s.pauseOpen;
        o.choiceOpen = !!s.choiceOpen;
        o.choiceKind = s.choiceKind || null;
        o.choiceCards = (s.choiceCards || []).map(function (c) { return c && c.id; });
        o.relics = (HOST.relics || []).map(function (r) { return (typeof r === 'string') ? r : (r && r.id); });
        o.relicFx = HOST.relicFx ? JSON.parse(JSON.stringify(HOST.relicFx)) : null;
        o.pulseProfile = HOST.pulse ? JSON.parse(JSON.stringify(HOST.pulse)) : null;
        o.pulse = {
          interval: s.pulseInterval ? s.pulseInterval() : null,
          leftMs: s.pulseAt ? Math.max(0, Math.round(s.pulseAt - s.time.now)) : null
        };
        o.floorRoomsCleared = s._floorRoomsCleared || 0;
        o.floorPlan = !!HOST.floorPlan;
        o.floorMapFromPlan = !!s.floorMap && !!s.floorMap.fromPlan;
        o.cursePool = HOST.cursePool ? HOST.cursePool.length : null;
        // 机制常量：遗物就是靠改这些生效的（见 applyMechRelics）。
        // 摆在这里是为了验遗物时能直接看数字，不用去猜某个窗口到底有没有被改。
        o.mech = {
          dodgePerfect: DODGE.perfect, dodgeInvuln: DODGE.invuln,
          dodgeSharp: DODGE.sharp, dodgeSharpMult: Math.round(DODGE.sharpMult * 100) / 100,
          dodgeAirDrag: Math.round(DODGE.airDrag * 100) / 100,
          guardPerfect: GUARD.perfect, guardCounterMult: GUARD.counterMult,
          guardShieldGain: GUARD.shieldGain,
          chainWindow: CHAIN.window, chainSweepMult: Math.round(CHAIN.sweepMult * 100) / 100,
          diveMult: DIVE.mult, diveBury: Math.round(DIVE.buryChance * 100) / 100,
          staminaMax: STAMINA.max, staminaRegen: Math.round(STAMINA.regen),
          furyKill: FURY.gainKill, rangedPierce: RANGED_ATTACK.ranger.pierce,
          rangedSpeed: RANGED_ATTACK.ranger.speed,
          linkMax: Math.max(1, LINK.max), linkDmgMult: Math.round(LINK.dmgMult * 100) / 100,
          // 2.9.2 F7：双套遗物 —— 当前武器是哪一套，以及"只有这一套"生效的证据
          weapon: (s.heroRanged && s.heroRanged()) ? 'ranged' : 'melee',
          swingWidth: s.relicFx ? Math.round(s.relicFx('swingWidth', 0)) : 0,
          sweepExtra: s.relicFx ? Math.round(s.relicFx('sweepExtra', 0)) : 0,
          thirdShotMult: s.relicFx ? Math.round(s.relicFx('thirdShotMult', 0) * 100) / 100 : 0
        };
        // 连携（技巧资源）：验「完美判定 → 攒 → 消费 → 挨打清零」这条链全靠这几个数
        o.link = s.link || 0;
        o.linkMax = Math.max(1, LINK.max);
        o.linkPips = s.linkPips ? s.linkPips.filter(function (p) { return p && p.visible; }).length : 0;
        o.target = s.nearestEnemy ? {
          name: s.nearestEnemy.name, hp: Math.round(s.nearestEnemy.hp),
          atk: Math.round(s.nearestEnemy.atk), tier: s.nearestEnemy.tier,
          behavior: s.nearestEnemy.behavior,
          panelVisible: s.targetPanel ? s.targetPanel.visible : null,
          barVisible: s.nearestEnemy.meter ? s.nearestEnemy.meter.fill.visible : null,
          barWidth: s.nearestEnemy.meter ? s.nearestEnemy.meter.w : null
        } : null;
        o.meters = {
          hero: s.heroMeter ? {
            w: s.heroMeter.w, shown: Math.round(s.heroMeter.shown * 1000) / 1000,
            trail: Math.round(s.heroMeter.trail * 1000) / 1000, h: s.heroMeter.trackH
          } : null,
          shield: s.shieldMeter ? { shown: Math.round(s.shieldMeter.shown * 1000) / 1000 } : null,
          boss: s.bossMeter ? { visible: s.bossMeter.track ? s.bossMeter.track.visible : null } : null,
          target: s.targetMeter ? { w: s.targetMeter.w } : null,
          enemyBars: s.enemies.filter(function (e) {
            return e.meter && e.meter.fill && e.meter.fill.visible;
          }).length
        };
        o.hudButtons = (s.hudButtons || []).map(function (b) {
          return { id: b.id, w: b.w, h: b.h, x: b.x, y: b.y, state: b.state };
        });
        o.shop = s.shopOpen ? {
          tab: s.shopTab, page: s.shopPage,
          groups: (s.shopData && s.shopData.groups) ? s.shopData.groups.map(function (g) {
            return { title: g.title, count: (g.items || []).length };
          }) : [],
          items: s.shopItemRects ? s.shopItemRects.length : 0
        } : null;
        o.buttons = {
          hud: (s.hudButtons || []).map(function (b) { return b.id; }),
          death: (s.panelButtons && s.panelButtons.death ? s.panelButtons.death : []).map(function (b) { return b.action; }),
          shop: (s.panelButtons && s.panelButtons.shop ? s.panelButtons.shop : []).map(function (b) { return b.action; }),
          confirm: (s.panelButtons && s.panelButtons.confirm ? s.panelButtons.confirm : []).map(function (b) { return b.action; })
        };
        o.map = s.floorMap ? {
          floor: s.floorMap.floor,
          total: s.floorMap.nodes.length,
          visited: s.floorMap.nodes.filter(function (n) { return n.visited; }).length,
          currentType: s.floorMap.current ? s.floorMap.current.type : null,
          selectable: (s.floorMap.current && s.floorMap.current.links) ? s.floorMap.current.links.map(function (id) {
            var n = s.floorMap.nodes[id];
            return n ? n.type : null;
          }) : []
        } : null;
        o.enemiesAlive = s.enemies.filter(function (e) { return e.alive; }).length;
        o.enemiesTotal = s.enemies.length;
        o.bossHp = s.boss ? Math.round(s.boss.hp) : null;
        o.hero = {
          hp: Math.round(s.hero.hp), maxHp: s.hero.maxHp, shield: Math.round(s.hero.shield),
          x: Math.round(s.hero.x), y: Math.round(s.hero.y),
          vx: Math.round(s.hero.body.velocity.x), vy: Math.round(s.hero.body.velocity.y),
          onGround: !!(s.hero.body.blocked.down || s.hero.body.touching.down),
          facing: s.hero.flipX ? -1 : 1,
          attacking: s.attacking,
          potions: s.hero.potions,
          dead: s.heroDead,
          charging: !!s.isCharging,
          chargeRatio: Math.round((s.chargeRatio || 0) * 100) / 100,
          diving: !!s.diving,
          stamina: Math.round(s.hero.stamina),
          maxStamina: s.hero.maxStamina,
          dodging: !!s.dodging,
          dodgeReady: s.time.now >= s.dodgeReadyAt,
          perfectLeft: Math.max(0, Math.round(s.perfectUntil - s.time.now)),
          perfectCount: s.hero.perfectCount || 0,
          perfectWindow: s.perfectWindowOpen(),
          skillId: s.skillId || null,
          skillName: (s.skill && s.skill.activeName) || null,
          skillUsed: !!s.skillUsed,
          skillPowerLeft: Math.max(0, Math.round((s.skillPowerUntil || 0) - s.time.now)),
          skillPowerMult: s.skillPowerMult || 1,
          skillBridge: hasBridge('skillUsed')
        };
        o.enemySample = s.enemies.filter(function (e) { return e.alive; }).slice(0, 3).map(function (e) {
          return {
            name: e.name, hp: Math.round(e.hp), state: e.state, x: Math.round(e.sprite.x),
            windupLeft: e.state === 'windup' ? Math.max(0, Math.round(e.windupUntil - s.time.now)) : 0,
            windupDur: e.windupDur || 0,
            armored: s.armorActive ? s.armorActive(e, s.time.now) : false,
            pounce: !!e.pounce
          };
        });
        o.stompCount = s._stompCount || 0;
      }
      return o;
    },

    /** 只读设备诊断（真机排查用：分辨率 / 密度 / 相机到底落在哪一档） */
    设备诊断: function () { return densityReport(); },
    deviceDiagnostics: function () { return densityReport(); },

    /** 模拟按键（自动化测试用） */
    press: function (action) {
      var s = state.scene;
      if (!s || !s.ready) return false;
      if (action === 'dodge') return s.tryDodge();
      if (action === 'skill') return s.useSkill();
      if (action === 'guard') { s.touchInput.guardHeld = true; return true; }
      if (action === 'guardOff') { s.touchInput.guardHeld = false; return true; }
      if (action === 'guardState') return { guarding: s.guarding, ready: s.guardReadyAt > 0 }; 
      if (action === 'chain') return s.pickChain(s.time.now);
      if (action === 'crystals') return (s.crystals || []).map(function (c) { return { x: Math.round(c.x), y: Math.round(c.y), taken: c.taken, near: c.near }; });
      if (action === 'pickCrystal') {
        var list = (s.crystals || []).filter(function (c) { return !c.taken; });
        var c0 = list[arguments[1] || 0];
        if (!c0) return false;
        // 放在魂晶上方 70px，让重力把角色落到平台/地面上。
        // 原来的 +26 会把角色塞进平台体内（单向平台可能直接穿下去），测试会偶发读条为 0。
        c0.stillMs = 0; c0.chargeMs = 0;
        s.hero.body.reset(c0.core.x, c0.core.y + 70);
        s.hero.setVelocity(0, 0);
        return true;
      }
      if (action === 'perches') return (s.platformPerches || []).map(function (p) { return { x: Math.round(p.x), y: Math.round(p.y) }; });
      if (action === 'perfect') { s.onPerfectDodge(); return true; }
      if (action === 'attack') { s.tryAttack(); return true; }
      if (action === 'potion') { s.usePotion(); return true; }
      if (action === 'jump') {
        // 轻点：以最小力度起跳
        if (s.hero.body.blocked.down || s.hero.body.touching.down) {
          s.hero.setVelocityY(-CHARGE.minPower);
          s.spark(s.hero.x, s.hero.y - 4, 0xa8e6ff);
        }
        return true;
      }
      if (action === 'charge') {
        // 开始蓄力（需在地面）
        if (s.hero.body.blocked.down || s.hero.body.touching.down) {
          s.isCharging = true; s.chargeStart = s.time.now; s.chargeRatio = 0;
        }
        return true;
      }
      if (action === 'jumpFull') {
        // 以蓄力比例起跳（默认满蓄力）
        var ratio = (s.chargeRatio !== undefined) ? s.chargeRatio : 1;
        s.isCharging = false;
        s.hero.setVelocityY(-(CHARGE.minPower + (CHARGE.maxPower - CHARGE.minPower) * ratio));
        s.spark(s.hero.x, s.hero.y - 4, ratio > 0.75 ? 0xffd76a : 0xa8e6ff);
        return true;
      }
      // 测试辅助：打开地图 / 进入第 idx 个可选房间（默认第一个）
      if (action === 'map') { s.openMap(); return true; }
      if (action === 'mapClose') { s.closeMap(); return true; }
      if (action === 'enterRoom') {
        if (!s.floorMap || !s.floorMap.current) return false;
        var linkIds = s.floorMap.current.links;
        if (!linkIds.length) return false;
        var target = s.floorMap.nodes[linkIds[0]];
        s.openMap();
        s.enterRoom(target);
        return true;
      }
      if (action === 'clear') {
        // 测试辅助：直接清空当前房间的敌人
        // ⚠️ 不能走 damageEnemy：铁壁兵正面免伤会把 999999 也挡掉，测试会"清不干净"。
        s.enemies.forEach(function (e) {
          if (e && e.alive) { e.hp = 0; s.killEnemy(e); }
        });
        return true;
      }
      // ===== 画面内界面（死亡 / 商店 / 确认框）测试辅助 =====
      if (action === 'dive') {
        // 跳劈：滞空时挥砍（需先离地，否则为普通挥砍）
        s.tryAttack();
        return !!s.diving;
      }
      if (action === 'shop') { s.openShop(); return true; }
      if (action === 'shopClose') { s.closeShop(); return true; }
      // ===== 图鉴 / 诅咒 / 环境 测试辅助 =====
      if (action === 'codex') { if (s.codexOpen) s.closeCodex(); else s.openCodex(); return true; }
      if (action === 'codexTab') { s.codexTab = arguments[1] || 'hero'; s.codexPage = 0; s.codexIndex = 0; if (s.codexOpen) s.rebuildCodex(); return true; }
      if (action === 'codexSelect') { s.selectCodexEntry(arguments[1] || 0); return true; }
      if (action === 'codexEntries') return s.codexEntries(s.codexTab).map(function (e) { return { id: e.id, name: e.name, cn: e.cn || '', rows: (e.rows || []).length, note: (e.note || '').slice(0, 30) }; });
      if (action === 'codexClick') {
        var r0 = (s.codexRects || [])[arguments[1] || 0];
        if (!r0) return false;
        return s.handleCodexClick({ x: r0.x + r0.w / 2, y: r0.y + r0.h / 2 });
      }
      if (action === 'setCurses') { return s.setCursesAndEnv(arguments[1] || [], arguments[2] || null); }
      if (action === 'curseState') return {
        curses: (s.curses || []).slice(), env: s.worldEnv ? s.worldEnv.name : null,
        envSummary: s.envSummaryText ? s.envSummaryText() : '',
        envPanelVisible: s.envPanel ? s.envPanel.visible : null,
        envPanelX: s.envPanel ? s.envPanel.x : null, envPanelY: s.envPanel ? s.envPanel.y : null,
        envPanelW: s._envPanelW || null, envPanelH: s._envPanelH || null,
        envPanelPinned: !!(s.envPanel && s.envPanel.parentContainer),
        envName: s.envName ? s.envName.text : null, envValue: s.envValueText ? s.envValueText.text : null,
        cursePanelVisible: s.cursePanel ? s.cursePanel.visible : null,
        cursePanelY: s.cursePanel ? s.cursePanel.y : null,
        cursePanelH: s._cursePanelH || null,
        cursePanelPinned: !!(s.cursePanel && s.cursePanel.parentContainer === s.hud),
        curseLabel: s.curseLabel ? s.curseLabel.text : null,
        curseY: s._curseTop != null ? s._curseTop : null,
        pulseY: s.pulseText ? s.pulseText.y : null,
        roomY: s.roomText ? s.roomText.y : null,
        flashLeftMs: Math.max(0, Math.round((s.envFlashUntil || 0) - s.time.now)),
        curseFlashLeftMs: Math.max(0, Math.round((s.curseFlashUntil || 0) - s.time.now)),
        centerText: s.centerMsg ? s.centerMsg.text : null,
        centerAlpha: s.centerMsg ? Number(s.centerMsg.alpha.toFixed(2)) : null,
        pulseInMs: Math.max(0, Math.round(s.pulseAt - s.time.now)),
        hudVisible: s.cursePanel ? s.cursePanel.visible : null,
        hudText: s.curseText ? s.curseText.text : null
      };
      if (action === 'envRoll') { s.rollRoomEnv(arguments[1] || null); return true; }
      // 左侧 HUD 竖排几何：属性面板 → 英雄技能 → 常驻按钮（验"三层不重叠"用）
      if (action === 'layoutState') {
        var boxOf = function (o) {
          return o ? { x: o.x, y: o.y, w: o.w, h: o.h, top: o.y - o.h / 2, bottom: o.y + o.h / 2, right: o.x + o.w } : null;
        };
        var items = s.statItems || [];
        var btns = (s.hudButtons || []).map(function (b) {
          var g = boxOf(b); g.id = b.label; return g;
        });
        return {
          statFirstY: items[0] ? items[0].text.y : null,
          statLastY: items[items.length - 1] ? items[items.length - 1].text.y : null,
          statBottom: s.hudStatBottom, statRows: s.statPanelMetrics(s.scale.width).rows,
          skill: boxOf(s.skillBtn), buttons: btns, rowBottom: s._hudRowBottom,
          targetPanelY: s.targetPanel ? s.targetPanel.y : null
        };
      }
      if (action === 'pulse') { s.applyPulse(); return true; }
      if (action === 'fury') return s.tryFury();
      if (action === 'furyAdd') { return s.addFury(arguments[1] || 0); }
      if (action === 'furyState') return {
        fury: Math.round(s.fury), max: FURY.max, active: s.furyActive(),
        leftMs: Math.round(s.furyLeft()),
        text: s.furyText ? s.furyText.text : null, hintVisible: s.furyHint ? s.furyHint.visible : null, ringVisible: s.furyRing ? s.furyRing.visible : null
      };
      if (action === 'shopTab') { s.onShopAction('tab' + (s.shopTab + 1)); return true; }
      if (action === 'shopNext') { s.onShopAction('next'); return true; }
      if (action === 'shopBuy') {
        var id = arguments[1];
        if (!id) { var it = (s.shopItemRects || [])[0]; id = it ? it.id : null; }
        if (!id) return false;
        s.buyShopItem(id);
        return true;
      }
      if (action === 'shopClick') {
        // 走真实点击路径（命中测试）
        var r = (s.shopItemRects || [])[arguments[1] || 0];
        if (!r) return false;
        s.handleUiClick({ x: r.x + r.w / 2, y: r.y, id: -1 });
        return true;
      }
      if (action === 'clickHud') {
        var name = arguments[1] || 'shop';
        var btn = (s.hudButtons || []).filter(function (b) { return b.id === name; })[0];
        if (!btn) return false;
        s.handleUiClick({ x: btn.x + btn.w / 2, y: btn.y, id: -2 });
        return true;
      }
      if (action === 'clickDeath') {
        var want = arguments[1];
        var d = (s.panelButtons.death || []).filter(function (b) { return b.action === want; })[0];
        if (!d) return false;
        s.handleUiClick({ x: d.x + d.w / 2, y: d.y, id: -3 });
        return true;
      }
      if (action === 'clickShop') {
        var wantS = arguments[1];
        var sb = (s.panelButtons.shop || []).filter(function (b) { return b.action === wantS; })[0];
        if (!sb) return false;
        s.handleUiClick({ x: sb.x + sb.w / 2, y: sb.y, id: -4 });
        return true;
      }
      if (action === 'clickConfirm') {
        var wantC = arguments[1];
        var c = (s.panelButtons.confirm || []).filter(function (b) { return b.action === wantC; })[0];
        if (!c) return false;
        s.handleUiClick({ x: c.x + c.w / 2, y: c.y, id: -5 });
        return true;
      }
      if (action === 'kill') {
        // 测试辅助：直接击杀主角（触发画面内死亡结算）
        s.damageHero(999999, null, true);
        return true;
      }
      // ===== P1 交接接口（宿主主权 / 决策面板 / 暂停 / 存档）测试辅助 =====
      if (action === 'pause') { return s.openPauseMenu(); }
      if (action === 'pauseClose') { return s.closePauseMenu(); }
      if (action === 'clickPause') {
        var wp = arguments[1];
        var pbtn = (s.panelButtons.pause || []).filter(function (b) { return b.action === wp; })[0];
        if (!pbtn) return false;
        return s.handleUiClick({ x: pbtn.x + pbtn.w / 2, y: pbtn.y, id: -6 });
      }
      if (action === 'choice') { return s.openChoicePanel(arguments[1] || 'reward', arguments[2] || null); }
      if (action === 'choiceClose') { return s.closeChoicePanel(null); }
      if (action === 'choiceCards') return (s.choiceCards || []).map(function (c) { return c && c.id; });
      if (action === 'clickChoice') {
        var cc = (s.panelButtons.choice || [])[arguments[1] || 0];
        if (!cc) return false;
        return s.handleUiClick({ x: cc.x + cc.w / 2, y: cc.y, id: -7 });
      }
      if (action === 'choiceState') return {
        open: !!s.choiceOpen, kind: s.choiceKind || null,
        cards: (s.choiceCards || []).map(function (c) { return c && c.id; }),
        buttons: (s.panelButtons.choice || []).map(function (b) { return b.action; })
      };
      if (action === 'finishGoal') { return s.finishRoomGoal(); }
      if (action === 'checkpoint') return s.checkpointState(arguments[1] || 'manual');
      if (action === 'roomPlan') return s.floorMap ? s.floorMap.nodes.map(function (n) { return n.type; }) : null;
      if (action === 'relics') return API.getRelics();
      if (action === 'pulseState') return {
        interval: s.pulseInterval(), leftMs: Math.max(0, Math.round(s.pulseAt - s.time.now)),
        floorRoomsCleared: s._floorRoomsCleared || 0
      };
      if (action === 'roomAction') return {
        kind: s.roomGoal ? s.roomGoal.kind : null,
        done: s.roomGoal ? !!s.roomGoal.done : null,
        awaiting: s.roomGoal ? !!s.roomGoal.awaiting : null
      };
      if (action === 'hint') { return { text: s.hintText ? s.hintText.text : '' }; }
      return false;
    },

    /* ---- 自定义布局（设置 → 2D 试炼按键自定义）---- */
    enterLayoutEdit: function () {
      var s = state.scene;
      return s ? s.enterLayoutEdit() : false;
    },
    exitLayoutEdit: function (save) {
      var s = state.scene;
      if (s) s.exitLayoutEdit(save);
    },
    isLayoutEditing: function () { return !!(state.scene && state.scene.editMode); },
    /** 列出所有可编辑单元及其当前自定义值（工具条用） */
    getLayoutUnits: function () {
      var s = state.scene;
      if (!s) return [];
      return s.editableUnits().map(function (u) {
        var c = (s.customLayout || {})[u.id] || {};
        return {
          id: u.id, label: u.label, group: u.group,
          dx: c.dx || 0, dy: c.dy || 0,
          s: c.s == null ? 1 : c.s,
          a: c.a == null ? 1 : c.a,
          v: c.v !== false,
          changed: s.isCustomized(u.id),
          sel: s.editSel === u.id
        };
      });
    },
    selectLayoutUnit: function (id) {
      var s = state.scene; if (!s || !s.editMode) return;
      s.editSel = id; s.drawEditOverlay(); s.notifyLayoutBar();
    },
    setLayoutValue: function (id, key, v) {
      var s = state.scene; if (s && s.editMode) s.setLayoutValue(id, key, v);
    },
    resetLayout: function (id) {
      var s = state.scene; if (s) s.resetCustomLayout(id);
    },
    exportLayout: function () { var s = state.scene; return s ? s.exportCustomLayout() : '{}'; },
    importLayout: function (text) { var s = state.scene; return s ? s.importCustomLayout(text) : false; },

    destroy: function () {
      if (state.game) { try { state.game.destroy(true); } catch (e) { /* 忽略 */ } state.game = null; }
      state.scene = null; state.booted = false; state.pendingStart = null;
      console.log('[战斗2D] 引擎已销毁');
    }
  };

  /* ============================================================
     布局自定义工具条（DOM 层）
     ------------------------------------------------------------
     分工：画布内拖动负责「位置」，工具条负责「缩放 / 透明度 / 显隐 /
     重置 / 导入导出」。滑杆这类控件放 DOM 上既好点又好调，画布内
     只需要画外框。
     ============================================================ */
  var LayoutBar = {
    scene: null,
    bound: false,
    ioMode: null,      // 'export' | 'import'：导入导出面板当前模式

    el: function (id) { return document.getElementById(id); },

    open: function (scene) {
      this.scene = scene;
      var bar = this.el('trial2dLayoutBar');
      if (!bar) return;
      if (!this.bound) { this.bind(); this.bound = true; }
      bar.classList.remove('hidden');
      this.buildList();
      this.sync(scene);
    },

    close: function () {
      this.scene = null;
      this.hideIO();
      var bar = this.el('trial2dLayoutBar');
      if (bar) bar.classList.add('hidden');
    },

    /** 单元列表（横向滚动的胶囊）：比在画面上点更准，小元素也不怕点不到 */
    buildList: function () {
      var list = this.el('trial2dLbList');
      if (!list) return;
      var units = (global.战斗2D && global.战斗2D.getLayoutUnits) ? global.战斗2D.getLayoutUnits() : [];
      list.innerHTML = '';
      units.forEach(function (u) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 't2d-lb-chip';
        b.textContent = u.label;
        b.setAttribute('data-unit', u.id);
        b.addEventListener('click', function () {
          if (global.战斗2D && global.战斗2D.selectLayoutUnit) global.战斗2D.selectLayoutUnit(u.id);
        });
        list.appendChild(b);
      });
    },

    selUnit: function () {
      var units = (global.战斗2D && global.战斗2D.getLayoutUnits) ? global.战斗2D.getLayoutUnits() : [];
      for (var i = 0; i < units.length; i++) if (units[i].sel) return units[i];
      return null;
    },

    sync: function (scene) {
      if (scene) this.scene = scene;
      if (!this.scene) return;
      var units = (global.战斗2D && global.战斗2D.getLayoutUnits) ? global.战斗2D.getLayoutUnits() : [];
      var sel = this.selUnit();

      var nameEl = this.el('trial2dLbName');
      if (nameEl) {
        nameEl.textContent = sel
          ? (sel.label + (sel.changed ? ' · 已改' : '') + (sel.v === false ? ' · 已隐藏' : ''))
          : '点选面板或按钮';
      }

      var s = sel ? sel.s : 1, a = sel ? sel.a : 1;
      var sr = this.el('trial2dLbScale'), sv = this.el('trial2dLbScaleVal');
      var ar = this.el('trial2dLbAlpha'), av = this.el('trial2dLbAlphaVal');
      var vb = this.el('trial2dLbVisible');
      if (sr) { sr.value = Math.round(s * 100); sr.disabled = !sel; }
      if (sv) sv.textContent = Math.round(s * 100) + '%';
      if (ar) { ar.value = Math.round(a * 100); ar.disabled = !sel; }
      if (av) av.textContent = Math.round(a * 100) + '%';
      if (vb) { vb.checked = sel ? sel.v : true; vb.disabled = !sel; }

      var byId = {};
      units.forEach(function (u) { byId[u.id] = u; });
      document.querySelectorAll('#trial2dLbList .t2d-lb-chip').forEach(function (c) {
        var u = byId[c.getAttribute('data-unit')];
        c.classList.toggle('sel', !!(u && u.sel));
        c.classList.toggle('changed', !!(u && u.changed));
        c.classList.toggle('off', !!(u && u.v === false));
      });
    },

    /* ============================================================
       导入 / 导出
       ------------------------------------------------------------
       刻意不用 window.prompt：系统对话框会把页面顶出全屏，而 2D 试炼的横屏
       锁定是绑在全屏上的 —— 一弹 prompt，屏幕就转回竖屏而且再也回不来
       （方向锁随全屏一起失效）。另外 prompt 里看不了带缩进换行的长 JSON，
       手机上也几乎没法长按选中复制。
       ============================================================ */
    showIO: function (mode, text) {
      var self = this;
      var panel = this.el('trial2dIoPanel');
      var ta = this.el('trial2dIoText');
      // HTML 没跟着更新（或浏览器还在用旧缓存）时退回提示框：难看，但功能不能丢
      if (!panel || !ta) {
        if (mode === 'export') {
          window.prompt('布局 JSON（可复制备份）：', text || '');
        } else {
          var t = window.prompt('粘贴布局 JSON：');
          if (t && global.战斗2D) {
            this.toast(global.战斗2D.importLayout(t) ? '导入成功' : '格式不对，已忽略');
          }
        }
        return;
      }

      var isExport = (mode !== 'import');
      this.ioMode = isExport ? 'export' : 'import';

      var title = this.el('trial2dIoTitle'), hint = this.el('trial2dIoHint');
      if (title) title.textContent = isExport ? '导出布局' : '导入布局';
      if (hint) {
        hint.textContent = isExport
          ? '复制后存到别处，换机时再导入'
          : '粘贴之前导出的 JSON，会覆盖当前布局';
      }

      ta.value = text || '';
      ta.readOnly = isExport;   // 导出只读：手抖改了它就不再是原布局了

      var show = function (id, on) {
        var e = self.el(id);
        if (e) e.classList.toggle('hidden', !on);
      };
      show('trial2dIoCopy', isExport);
      show('trial2dIoPaste', !isExport);
      show('trial2dIoOk', !isExport);

      panel.classList.remove('hidden');
      if (!isExport) { try { ta.focus(); } catch (e) { /* 忽略 */ } }
    },

    hideIO: function () {
      var panel = this.el('trial2dIoPanel');
      if (panel) panel.classList.add('hidden');
      this.ioMode = null;
    },

    /** 剪贴板 API 不可用（局域网 http 不是安全上下文）时的退路：全选，让玩家长按复制 */
    selectIO: function () {
      var ta = this.el('trial2dIoText');
      if (!ta) return;
      try { ta.focus(); ta.select(); } catch (e) { /* 忽略 */ }
      this.toast('已全选，长按复制');
    },

    bind: function () {
      var self = this;
      function on(id, ev, fn) { var e = self.el(id); if (e) e.addEventListener(ev, fn); }
      function withSel(fn) {
        return function () { var u = self.selUnit(); if (u && global.战斗2D) fn(u, this); };
      }

      on('trial2dLbScale', 'input', withSel(function (u, el) {
        global.战斗2D.setLayoutValue(u.id, 's', el.value / 100);
      }));
      on('trial2dLbAlpha', 'input', withSel(function (u, el) {
        global.战斗2D.setLayoutValue(u.id, 'a', el.value / 100);
      }));
      on('trial2dLbVisible', 'change', withSel(function (u, el) {
        global.战斗2D.setLayoutValue(u.id, 'v', el.checked);
      }));
      on('trial2dLbSnap', 'change', function () {
        if (self.scene) self.scene.editSnap = this.checked;
      });
      on('trial2dLbResetItem', 'click', withSel(function (u) {
        global.战斗2D.resetLayout(u.id);
      }));
      on('trial2dLbResetAll', 'click', function () {
        if (global.战斗2D) global.战斗2D.resetLayout(null);
        self.toast('已恢复默认布局');
      });
      on('trial2dLbDone', 'click', function () {
        if (global.战斗2D) global.战斗2D.exitLayoutEdit(true);
      });
      on('trial2dLbExport', 'click', function () {
        var json = global.战斗2D ? global.战斗2D.exportLayout() : '{}';
        self.showIO('export', json);
      });
      on('trial2dLbImport', 'click', function () {
        self.showIO('import', '');
      });
      on('trial2dIoCopy', 'click', function () {
        var ta = self.el('trial2dIoText');
        if (!ta) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(ta.value).then(
            function () { self.toast('已复制到剪贴板'); self.hideIO(); },
            function () { self.selectIO(); });
        } else {
          self.selectIO();
        }
      });
      on('trial2dIoPaste', 'click', function () {
        var ta = self.el('trial2dIoText');
        if (!ta) return;
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(
            function (t) { ta.value = t || ''; },
            function () { try { ta.focus(); } catch (e) { /* 忽略 */ } });
        } else {
          try { ta.focus(); } catch (e) { /* 忽略 */ }
        }
      });
      on('trial2dIoOk', 'click', function () {
        var ta = self.el('trial2dIoText');
        var ok = !!(ta && global.战斗2D && global.战斗2D.importLayout(ta.value));
        self.hideIO();
        self.toast(ok ? '导入成功' : '格式不对，已忽略');
      });
      on('trial2dIoClose', 'click', function () { self.hideIO(); });
    },

    toast: function (msg) {
      var el = this.el('trial2dLbToast');
      if (!el) return;
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(this._t);
      this._t = setTimeout(function () { el.classList.remove('show'); }, 1800);
    }
  };
  global.战斗2DLayoutBar = LayoutBar;
  global.Trial2DLayoutBar = LayoutBar;   // 旧名保留：老宿主与旧测试脚本仍在用

  loadSettings();
  global.战斗2D = API;
  global.试炼2D = API;   // 兼容别名：试炼宿主（试炼程序.js）按旧名取引擎；P5 关停试炼后删除
  global.Trial2D = API;

})(window);
