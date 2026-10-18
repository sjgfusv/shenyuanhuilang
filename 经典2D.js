/**
 * ============================================================
 *  深渊回廊 · 经典模式 2D 实时宿主（经典2D.js）
 * ------------------------------------------------------------
 *  分工（P2 确立，后续阶段不变）：
 *    内核 主程序.js   楼层 / 经济 / 难度 / 遗物池 / 结局 / 存档 / 图鉴 —— 规则与数据
 *    宿主 经典2D.js   房间映射 / payload 映射 / 事件回写 / 面板内容
 *    表现 战斗2D.js   实时动作 / HUD / 画内面板 —— 不含任何经典规则
 *
 *  接入方式（薄接入，与 试炼程序.js 同款）：
 *    主程序 render() 第一行调 经典2D.render()，返回 true 即吞掉本次 DOM 渲染；
 *    handleAction() 在试炼分支之后交给 经典2D.handleAction()。
 *    于是 12000+ 行回合制代码整份留下当内核，一行都不用重写。
 *
 *  ⚠️ 内核接入点（实测行号；主程序.js 共 12359 行，规划里的行号已整体 +53 漂移）
 *    render()       8348 —— early-return 必须在**函数体第一行**：
 *                            scheduleRender 会在商店/事件路径高频调用它
 *    handleAction() 9160 —— 必须放在 state.detailMode 拦截（9173）之前
 *    ⚠️ 不要替换 window.render：开发者模式在 11950-11965 已经包了一层
 *    ⚠️ handleAction 有 3 个注册点（9471 / 9783 / 2689），2689 会 cloneNode 换掉
 *       actionArea 节点 —— 宿主不要把自己绑在 actionArea 上
 *
 *  ⚠️ 内核字段陷阱（踩了就静默失败）
 *    · 金币是 state.player.gold，**没有 state.gold**
 *    · 通关是 state.mode === 'finished' + state.endResult，**没有 state.finished**
 *    · 成长字段散在 state 顶层（luckyLevel / dodgeLevel / thornLevel / vampireLevel /
 *      comboLevel / executeLevel / critDamage），不在 state.player 上
 *    · 遗物没有 id、只有中文 label，且每条带 apply 函数；而 setSlotData 是裸
 *      JSON.stringify → **读档后 relic.apply 会变 undefined**（内核 loadGame 没有重绑，
 *      这是既有 bug）。宿主写回遗物时只写 label 数组，需要时按 label 查表重建
 *    · 顶层 const（difficultyModifiers / ENVIRONMENT_EFFECTS ...）不挂 window，
 *      一律通过 window.经典2D内核 取，不要直接摸全局（摸到 undefined 是静默的）
 *    · enterCurrentRoom() 不处理 elite（它只认 enemy/mirror）——在 2D 里 elite 就是战斗房
 *
 *  回退：引擎四种渲染方式全失败、或显式关闭时 active() 返回 false，
 *        主程序自动走回合制，玩家不会卡死。
 *        关闭方式：URL 加 ?classic2d=0，或 localStorage.abyss27_classic2d = '0'
 * ============================================================
 */
(function (global) {
  'use strict';

  var K = null;              // 内核窄接口（window.经典2D内核）
  var engineRef = null;      // window.战斗2D
  var booted = false;        // 引擎已 init 成功
  var running = false;       // 本局正在跑
  var booting = false;       // 正在启动（防重入）
  var unavailable = false;   // 四种渲染方式全失败 → 永久回退回合制
  var retryTimer = null;
  var retryCount = 0;
  var evBound = false;       // 引擎事件只绑一次（引擎销毁重建后不能再绑）
  var lastError = null;
  var stageShown = false;    // 画布当前是否露着（用来判断"不接管时要不要收起来"）

  var MODE_TAG = 'classic2d';
  var DISABLE_KEY = 'abyss27_classic2d';
  var RETRY_DELAYS = [350, 1400, 3200];   // 照抄试炼程序.js 的三级重试节奏

  /* ============================================================
     工具
     ============================================================ */
  function kernel() {
    if (!K) K = global.经典2D内核 || null;
    return K;
  }
  function S() {
    var k = kernel();
    if (k) return k.state();
    return global.state || null;
  }
  function engine() {
    if (!engineRef) engineRef = global.战斗2D || global.试炼2D || null;
    return engineRef;
  }
  function log() {
    try {
      var a = ['[经典2D]'].concat(Array.prototype.slice.call(arguments));
      console.log.apply(console, a);
    } catch (e) { /* 忽略 */ }
  }
  function warn() {
    try {
      var a = ['[经典2D]'].concat(Array.prototype.slice.call(arguments));
      console.warn.apply(console, a);
    } catch (e) { /* 忽略 */ }
  }
  function sfx(name) {
    try {
      if (global.AbyssAudio && typeof global.AbyssAudio.sfx === 'function') global.AbyssAudio.sfx(name);
    } catch (e) { /* 忽略 */ }
  }

  /** 引擎是否被玩家显式关掉 */
  function enabled() {
    try {
      if (global.location && /[?&]classic2d=0(&|$)/.test(global.location.search)) return false;
      if (global.localStorage && global.localStorage.getItem(DISABLE_KEY) === '0') return false;
    } catch (e) { /* 无痕模式等：按启用处理 */ }
    return true;
  }

  /**
   * 现在该不该由宿主管画面
   * 选英雄 / 选增益 / 开始界面仍归内核 DOM；一旦进了房间就交给 2D。
   */
  function shouldTakeOver() {
    var s = S();
    if (!s || !s.hero) return false;
    if (s.gameOver) return false;
    // ⚠️ 这里**不能**再判 state.trial.active：试炼的代码已经删了，但 state.trial 是
    //    **存档里的纯数据**，loadGame 的 Object.assign 会把它带回来 ——
    //    一份「试炼进行中」的旧档会让本函数永远返回 false，玩家在两台设备上都会
    //    一路回退到文字模式（实测就是这么撞到的）。
    if (s.mode === 'heroSelect' || s.mode === 'bonusSelect' || s.mode === 'start') return false;
    if (s.mode === 'gameover' || s.mode === 'finished') return false;
    if (!s.currentRoom) return false;   // 还没进第一间房
    return true;
  }

  function active() {
    if (!enabled() || unavailable) return false;
    return running && booted;
  }

  /* ============================================================
     画布显隐
     ------------------------------------------------------------
     #trial2DStage 在 .app-shell 之内（主界面.html:802），所以不能靠隐藏外壳来
     露出画布 —— 反过来做：让画布（全屏 fixed 覆盖层）盖住 DOM 游戏区。
     这条路径与试炼模式完全一致，样式复用 .trial2d-stage，不新增 CSS 约定。
     ============================================================ */
  /**
   * 画布显隐
   * ------------------------------------------------------------
   * ⚠️ #trial2DStage 在 #trialScreen 内部（主界面.html:802 在 756 之后），
   *    而 #trialScreen 是 `.hidden`（opacity/scale，不是 display:none）——
   *    试炼未激活时它的高度会塌掉，Phaser RESIZE 跟着父容器走，画布实测只剩
   *    1279×214（而 --trial2d-vh 是 797px）。后果不是"看不见"，而是
   *    画内面板在小画布上算不出卡片、奖励三选一直接不弹（静默失败，极难排查）。
   *    所以这里**不走 CSS**：直接把 stage 钉成全屏 fixed，退出时清掉 inline style
   *    还给试炼模式的原有 CSS（试炼那边的行为一个字节都没动）。
   */
  var STAGE_INLINE = ['position', 'left', 'top', 'right', 'bottom', 'width', 'height',
    'zIndex', 'display', 'opacity', 'visibility', 'transform', 'pointerEvents', 'inset',
    // 全屏时也必须清掉的"内嵌舞台"遗留样式（见 showStage 里的说明）
    'border', 'borderRadius', 'margin', 'padding', 'boxShadow', 'background'];

  function showStage(show) {
    var stage = document.getElementById('trial2DStage');
    if (!stage) return;

    /* ⚠️ 只有"状态真的变了"才动 DOM —— 这是"画面像网卡一样一抽一抽"的真根因
       ------------------------------------------------------------
       render() 是**每帧**被内核调用的（scheduleRender → rAF），而它每次都会走到这里。
       原实现无条件做 14 次 inline style 赋值 + 一次 `game.scale.refresh()`，
       实测（真实浏览器）：
         · 120 次 render() → **触发 130 次 Phaser 的 resize 事件**
         · render() 单次纯 JS 耗时 **4.196ms**（引擎自己的 update 才 1.25ms）
       16.67ms 的帧预算被吃掉四分之一，而每次 refresh 还会带着引擎的 onResize
       重排一遍 HUD —— 帧时间被拖长且不均匀，玩家的体感就是"网很卡"。
       画布尺寸的变化本来另有来源（窗口 resize / 转屏 / 地址栏收缩），
       由 onViewportChange() 按需处理，功能一个不少（见那里的说明）。 */
    var changed = (!!show !== stageShown);
    if (changed) {
      stageShown = !!show;
      stage.classList.toggle('hidden', !show);
      try { document.body.classList.toggle(MODE_TAG, !!show); } catch (e) { /* 忽略 */ }
      // html 上也要锁滚动：body{overflow:hidden} 挡不住"内容比视口高时由
      // 根元素接管滚动条"—— 表现就是 2D 画面里页面还能上下滑（用户报过）。
      try {
        document.documentElement.style.overflow = show ? 'hidden' : '';
        document.documentElement.style.overscrollBehavior = show ? 'none' : '';
      } catch (e) { /* 忽略 */ }
      if (show) {
        updateVh();
        var h = viewportHeight();
        if (!(h > 0)) h = 720;
        stage.style.position = 'fixed';
        stage.style.inset = '0';
        stage.style.left = '0';
        stage.style.top = '0';
        stage.style.width = '100%';
        stage.style.height = Math.round(h) + 'px';
        stage.style.zIndex = '9000';
        stage.style.display = 'block';
        stage.style.opacity = '1';
        stage.style.visibility = 'visible';
        stage.style.transform = 'none';
        stage.style.pointerEvents = 'auto';
        // ⚠️ `.trial2d-stage` 原本是"嵌在文字界面里的一个小舞台"的样式：
        //    1px 边框 / 14px 圆角 / 10px 下边距 / 外阴影。
        //    钉成全屏时只覆盖了定位与尺寸，**这几样留了下来** ——
        //    边框与圆角会在四周和四个角上透出下面的 DOM 文字界面
        //    （用户反馈的"在标题处隐约看见文字界面的画面"就是这个），
        //    下边距还会把底部顶起来 10px。全屏接管时必须一并清掉。
        stage.style.border = 'none';
        stage.style.borderRadius = '0';
        stage.style.margin = '0';
        stage.style.padding = '0';
        stage.style.boxShadow = 'none';
        stage.style.background = 'transparent';
        // inline style 不会触发 Phaser 的 resize 监听，必须手动让它按新容器重算 ——
        // 否则画布会停在旧尺寸（实测 0×0），而画内面板有尺寸守卫，结果又是"静默不弹"。
        // 只在"刚露出来"这一帧做一次就够了（之后交给 onViewportChange + 热身校验）。
        refreshStageScale();
        stageWarmup = 12;
        ensureHostObserver();
        /* 进入 2D 的**这一帧**就要把横屏提示条对齐一次（详见 updateRotateHint 的说明）
           ------------------------------------------------------------
           少了这一句，就是"iPhone 进了 2D 却连一句提示都没有"的真根因：
           updateRotateHint() 全项目只有 4 个调用点（exitLandscape 收尾 / 视口变化 /
           全屏变化 / 切回前台），而"刚进 2D 战斗画面"这一瞬间这四件事**一件都不会发生**
           —— 尺寸没变、全屏在 iOS 上根本进不去、也没切过后台。于是苹果玩家看到的是：
           屏幕竖着、没有全屏、也没有任何解释（实测复现：手动补一次 resize 提示条才出现）。
           这里刻意不动 syncLandscape()：它管的是"能自动横屏的设备"，语义是"只在状态变化时
           动手"，往里加副作用会牵连全屏自愈链路；而 updateRotateHint() 本身是幂等的。 */
        bindRotateHint();
        rotateHintDismissed = false;   // 新一次进入 2D：重新给一次提示（刻意不持久化，见变量声明）
        updateRotateHint();
      } else {
        STAGE_INLINE.forEach(function (k) { stage.style[k] = ''; });
        stageWarmup = 0;
      }
    } else if (stageWarmup > 0) {
      // 热身帧：见 checkStageSize 的说明（稳定期零开销）
      stageWarmup--;
      checkStageSize();
    }

    /* 横屏 / 全屏跟着画布一起对齐（第 6 条 + 第 9 条）
       ------------------------------------------------------------
       把横屏状态挂在 showStage 上，是因为它本来就是画布显隐的**唯一入口** ——
       于是"画布收起来了却没解锁横屏"这类漏网分支从结构上就不存在了：
       死亡结算 / 结局 / 选英雄 / 主动退出 / 降级 全会走到 false 分支。
       want = 画布露着 **且** 本局在跑。
       这一步**每帧都要走**（它自带短路判断、开销可忽略），因为它是"该横屏却没横屏
       → 记一个待补标记、等下次手势"的唯一检查点。 */
    syncLandscape(!!show && running);
  }

  /** 视口高度：移动端要用 visualViewport，地址栏收缩后它才是真实可用高度 */
  function viewportHeight() {
    try {
      var vv = global.visualViewport;
      return (vv && vv.height) ? vv.height : global.innerHeight;
    } catch (e) { return 0; }
  }

  /** 让 Phaser 按当前容器尺寸重算画布（只该在"尺寸真的变了"时调，见 showStage 的说明） */
  function refreshStageScale() {
    try {
      var e0 = engine();
      var gg = (e0 && e0.getGame) ? e0.getGame() : null;
      if (gg && gg.scale && gg.scale.refresh) gg.scale.refresh();
    } catch (err) { /* 忽略 */ }
  }

  /**
   * 画布尺寸热身校验（只在"刚显示出来"之后的前若干帧执行）
   * ------------------------------------------------------------
   * showStage(true) 有可能发生在**引擎场景还没 create** 的那一帧 —— 那时
   * scale.refresh() 是空转，画布会停在 0×0，而 Phaser 的 RESIZE 模式会把渲染
   * 缩放算错（表现是画面整体错位/抖动，很容易被当成"相机没修好"）。
   * 原代码靠"每帧无脑 refresh"兜住了这种情况，而那是把帧预算吃掉的元凶
   * （实测 render() 4.2ms/帧、120 帧触发 130 次 resize）。
   * 折中：显示后的前 12 帧各校验一次尺寸，不符才补 refresh；之后彻底不管 ——
   * 稳定期零开销，而"画布塌成 0×0"这段窗口恰好就在这 12 帧里。
   */
  var stageWarmup = 0;
  function checkStageSize() {
    var stage = document.getElementById('trial2DStage');
    var host = document.getElementById('trial2DCanvasHost');
    if (!stage || !host) return;
    var e0 = engine();
    var gg = (e0 && e0.getGame) ? e0.getGame() : null;
    if (!gg || !gg.scale) return;
    // ① 顺带校正**舞台高度**（这是"2D 画面里页面还能滚动"的根因）
    // ------------------------------------------------------------
    // 舞台高度写成像素是有意为之：纯 `inset: 0` 用的是 layout viewport，
    // 移动端会把底部按钮顶到地址栏底下（--trial2d-vh 就是为它而生的）。
    // 但视口是会变的（地址栏伸缩、旋屏、窗口缩放），而 showStage 现在只在
    // "状态变化时"设置高度 —— 过期的像素高度就成了**多出来的可滚动区域**。
    var vh = viewportHeight();
    if (vh > 0) {
      var px = Math.round(vh) + 'px';
      if (stage.style.height !== px) stage.style.height = px;
    }
    // ② ⚠️ 比的是 **canvas host** 而不是 stage：stage 里还有标题条（.trial2d-stage-head），
    //    高度天然比画布大，拿它比会每帧都判定"不匹配"、等于没优化掉每帧 refresh。
    // ③ ⚠️ 比的是 **scale.width（逻辑尺寸）**：引擎的高密度屏适配只放大画布的
    //    **后备像素**（canvas.width = 逻辑 × 设备像素比），而 scale.width 报的仍然是
    //    逻辑尺寸 = host 的 clientWidth —— 所以这里与旧版一致，直接和 host 比。
    //    （不要再改成比 canvas.width：那是物理像素，永远不等于 host 的 CSS 宽度。）
    var w = host.clientWidth, h = host.clientHeight;
    if (!(w > 0) || !(h > 0)) return;
    if (Math.abs((gg.scale.width || 0) - w) > 1 || Math.abs((gg.scale.height || 0) - h) > 1) {
      refreshStageScale();
    }
  }

  /**
   * canvas host 尺寸监听 —— 画布尺寸的**最终保险**
   * ------------------------------------------------------------
   * 为什么必须有它：舞台被收起时（死亡结算 / 结局 / 降级）`#trial2DStage` 会
   * 隐藏 → 容器尺寸变 0 → Phaser 在 RESIZE 模式下把画布也缩成 **0×0**；
   * 再次显示时如果那一帧浏览器还没算完布局（clientWidth 仍是 0），
   * `scale.refresh()` 就是空转 —— 画布会**永久停在 0×0**，渲染缩放全错，
   * 表现是画面错位 / 抖动 / 拉伸。
   * 原代码靠"每帧无脑 refresh"兜住了它（代价 4.2ms/帧，见 N8），
   * 现在改用 ResizeObserver：容器尺寸**真的变了**才补一次 refresh，稳定期零开销。
   * （observe 的是 host 而不是 canvas：canvas 尺寸由 Phaser 自己写，
   *   观察它会形成自激循环。）
   */
  var hostObserver = null;
  function ensureHostObserver() {
    if (hostObserver || typeof ResizeObserver === 'undefined') return;
    var host = document.getElementById('trial2DCanvasHost');
    if (!host) return;
    try {
      hostObserver = new ResizeObserver(function () {
        if (!stageShown || !running) return;
        checkStageSize();
      });
      hostObserver.observe(host);
    } catch (e) { /* 忽略 */ }
  }

  /** 移动端底部按钮靠 --trial2d-vh 才不被地址栏压住（试炼程序.js 的同名逻辑） */
  function updateVh() {
    try {
      var h = viewportHeight();
      if (h > 0) document.documentElement.style.setProperty('--trial2d-vh', Math.round(h) + 'px');
    } catch (e) { /* 忽略 */ }
  }

  /* ============================================================
     楼层规划：把内核的房间序列交给引擎（**带分支**）
     ------------------------------------------------------------
     引擎的 setFloorPlan({rooms:[...]}) 会自动在最前补「入口」、末尾补 Boss，
     而经典序列第 1 位就是房间、末位已是 Boss —— 会多出一间、两边对不上，
     所以用 cols 形式全权控制。

     ⚠️ **每列放几个，决定了地图有没有分支**（用户反馈："怎么没有房间的分支了"）：
       · 每列只放 1 个（合并时的旧写法）→ 地图退化成一条直线，
         玩家体感是"一关一关往下走"，完全没有选路感；
       · 每列放 2 个 → 引擎的 linkCols 会按相邻行自动连出分叉，
         玩家在两次开门之间可以**选一条路走**。

     分支只增加"候选"，不改内核语义：
       · 内核的 state.rooms 仍是"每列的主线房间"，roomIndex 仍按**列号**推进
         （onRoom 用引擎给的 room.col 定位，col 严格等于内核下标）；
       · 支线类型从同一套房间池里抽，所以难度与内容口径完全一致；
       · 末列（Boss）不分叉 —— 否则会出现两个层主；
       · 玩家走了支线时，onRoom 会把**实际房型**写回内核的 rooms[col]，
         于是存档 / 读档 / 结算看到的都是"真正打过的那间"。
     ============================================================ */
  function planFromRooms(rooms, floor) {
    if (!rooms || !rooms.length) return null;
    var f = Math.max(1, Math.round(floor || 1));
    return {
      floor: f,
      cols: rooms.map(function (r, i) {
        var type = (r && r.type) || 'enemy';
        var col = [{ type: type }];
        var isLast = (i === rooms.length - 1);
        // 起点列与 Boss 列都**不分叉**：
        //   · 起点列是玩家开局所在的房间，多给它一个候选等于放一个永远进不去的门；
        //   · Boss 列分叉会变成"两个层主"。
        // 中间的列才给支线候选 —— 玩家每次开门都能在两个方向里挑一个。
        if (isLast || i === 0 || rooms.length < 2) return col;
        var alt = pickAltRoomType(type, f);
        if (alt) col.push({ type: alt });                // 支线候选
        return col;
      })
    };
  }

  /**
   * 支线房间类型
   * 与内核 generateFloorRooms 同一套池子（enemy 权重更高），
   * 并沿用它的两条规则：第 1 层不出现商店 / 休整；不会给出 Boss。
   */
  var BRANCH_POOL = ['enemy', 'enemy', 'enemy', 'mirror', 'elite', 'treasure', 'rest', 'shop', 'event', 'shrine'];
  function pickAltRoomType(mainType, floor) {
    var pool = BRANCH_POOL.filter(function (t) {
      if (t === 'boss' || t === mainType) return false;
      if (floor <= 1 && (t === 'shop' || t === 'rest')) return false;   // 与内核首层规则一致
      return true;
    });
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** 下发当前层的规划；引擎在 nextFloor 里会用 HOST.floorPlan 重取地图 */
  function pushFloorPlan() {
    var e = engine(), s = S();
    if (!e || !s) return false;
    var plan = planFromRooms(s.rooms, s.floor);
    if (!plan) return false;
    e.setFloorPlan(plan);
    return true;
  }

  /** 换层后：让引擎按新下发的规划重取当前层地图 */
  function rebuildEngineMap() {
    var e = engine();
    if (e && typeof e.rebuildFloorMap === 'function') return e.rebuildFloorMap();
    return false;
  }

  /* ============================================================
     属性映射（照抄 试炼程序.js:1834 / 1853，把 _state.trial 换成 state）
     ============================================================ */
  function derivedStats(s) {
    var p = s.player || {};
    return {
      critRate: Math.min((s.luckyLevel || 0) * 10 + (p.luckyBonus || 0), 100),
      critDamage: (s.critDamage || 150) + (p.critDamageBonus || 0),
      dodge: Math.min((s.dodgeLevel || 0) * 5, 50),
      thorn: s.thornLevel || 0,
      vampire: s.vampireLevel || 0,
      combo: Math.min((s.comboLevel || 0) * 5, 40),
      execute: Math.min((s.executeLevel || 0) * 5, 40)
    };
  }

  function playerStats(s) {
    var p = s.player || {};
    var base = {
      hp: p.hp, maxHp: p.maxHp, attack: p.attack,
      shield: p.shield || 0, potions: p.potions || 0
    };
    var d = derivedStats(s);
    for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) base[k] = d[k];
    return base;
  }

  function heroSkillPayload(s) {
    var h = s.hero;
    if (!h || !h.skill) return null;
    return {
      id: h.id || '',
      name: h.skill.name || '',
      activeName: (h.skill.active && h.skill.active.name) || '',
      activeDesc: (h.skill.active && h.skill.active.description) || '',
      used: !!s.heroSkillUsed
    };
  }

  /** 环境效果载荷：引擎只认名字与数值（引擎侧按名字查 WORLD_ENVS） */
  function envPayload(s) {
    var env = s.environment;
    if (!env || !env.name) return null;
    var desc = '';
    try { desc = kernel().formatEnvDescription(env); } catch (e) { desc = env.description || ''; }
    return {
      name: env.name,
      values: env.values || {},
      displayValue: env.displayValue || '',
      description: desc
    };
  }

  function realtimeDifficulty(s) {
    var d = s.difficulty || 'normal';
    if (d !== 'custom') return d;
    // 自定义难度：引擎只认四档（影响星雾/火星主题与默认节拍），按环境强度归一下档
    try {
      var c = kernel().normalizeCustomDifficulty(s.customDifficulty);
      var sc = c ? (c.environmentScale || 1) : 1;
      if (sc >= 1.2) return 'hell';
      if (sc >= 1.05) return 'hard';
      return 'normal';
    } catch (e) { return 'hard'; }
  }

  /* ============================================================
     脉冲节拍（规划 §3.12）：宿主按难度下发曲线
     ============================================================ */
  function pushPulseProfile() {
    var e = engine(), s = S();
    if (!e || !s || typeof e.setPulseProfile !== 'function') return false;
    var byDiff = {
      easy:   { start: 6000, step: 250, min: 3200 },
      normal: { start: 5000, step: 350, min: 2600 },
      hard:   { start: 4400, step: 450, min: 2200 },
      hell:   { start: 3800, step: 550, min: 1800 }
    };
    var p = byDiff[s.difficulty] || byDiff.normal;
    if (s.difficulty === 'custom') {
      // 自定义难度：pulseScale 缩放间隔（越高越慢 = 越轻松），pulseAccel 缩放加速
      var c = null;
      try { c = kernel().normalizeCustomDifficulty(s.customDifficulty); } catch (err) { c = null; }
      var scale = (c && c.pulseScale != null) ? c.pulseScale : 1;
      var accel = (c && c.pulseAccel != null) ? c.pulseAccel : 1;
      var base = byDiff.normal;
      p = {
        start: Math.round(base.start * scale),
        step: Math.round(base.step * accel),
        min: Math.round(base.min * scale)
      };
    }
    e.setPulseProfile({
      start: p.start, step: p.step, min: p.min,
      warn: Math.min(1500, Math.round(p.start * 0.30))
    });
    return true;
  }

  /* ============================================================
     诅咒系统（规划 §3.5 · 风险收益）
     ------------------------------------------------------------
     经典模式没有诅咒（诅咒原本只属于试炼），所以这一层的**数据**放在宿主的
     state._rtCurses 里（纯字符串数组，可安全存档），**效果**由引擎既有的
     10 条实时化诅咒承担（每 5 秒一次腐化脉冲结算，见引擎 RT_CURSES）。
     分级沿用规划 §3.5：轻诅咒是"慢慢磨"，重诅咒是"真咬人"。
     ============================================================ */
  var CURSE_LIGHT = ['脆弱', '护甲腐蚀', '药水衰减', '迟钝'];
  var CURSE_HEAVY = ['荆棘诅咒', '易伤', '生命流失', '虚弱', '吸血反噬', '贪婪'];
  var CURSE_ALL = CURSE_LIGHT.concat(CURSE_HEAVY);

  function rtCurses(s) {
    return (s && s._rtCurses) ? s._rtCurses.slice() : [];
  }

  /** 从候选里挑一条还没中的诅咒 */
  function pickUnused(list, used) {
    var free = list.filter(function (n) { return used.indexOf(n) < 0; });
    if (!free.length) return null;
    return free[Math.floor(Math.random() * free.length)];
  }

  /** 施加诅咒（轻 nLight 条 + 重 nHeavy 条）并同步给引擎 */
  function addCurses(nLight, nHeavy) {
    var s = S();
    if (!s) return [];
    if (!s._rtCurses) s._rtCurses = [];
    var got = [], i, n;
    for (i = 0; i < nLight; i++) { n = pickUnused(CURSE_LIGHT, s._rtCurses); if (n) { s._rtCurses.push(n); got.push(n); } }
    for (i = 0; i < nHeavy; i++) { n = pickUnused(CURSE_HEAVY, s._rtCurses); if (n) { s._rtCurses.push(n); got.push(n); } }
    if (got.length) {
      try { kernel().addLog('深渊裂隙的代价：' + got.join('、')); } catch (e) { /* 忽略 */ }
    }
    pushCursesEnv();
    return got;
  }

  /**
   * 深渊裂隙：清完层主房、进下一层之前的抉择（规划 §3.5 表）
   * A 浅尝：1 条轻诅咒 → 1 件遗物
   * B 沉沦：2 条（至少 1 条重）→ 1 件遗物 + 金币 ×(层数 × 8)
   * C 拒绝：无代价 → 本层商店价格 −10%
   */
  function openRiftPanel() {
    var s = S(), e = engine();
    if (!s || !e || typeof e.openChoicePanel !== 'function') return false;
    log('深渊裂隙：弹出风险收益抉择（第 ' + s.floor + ' 层）');
    bgm('choice');
    return e.openChoicePanel('rift', {
      title: '深渊裂隙',
      desc: '第 ' + s.floor + ' 层 · 想要更多，就得先交出些什么',
      cards: [
        { id: 'light', name: '浅尝', desc: '接受 1 条轻诅咒 · 获得 1 件遗物', quality: 'common', tag: '代价小' },
        { id: 'deep', name: '沉沦', desc: '接受 2 条诅咒（至少 1 条重）· 遗物 + ' + (s.floor * 8) + ' 金币', quality: 'rare', tag: '代价大' },
        { id: 'refuse', name: '拒绝', desc: '不接受诅咒 · 本层商店价格 −10%', quality: 'common', tag: '稳妥' }
      ],
      actions: []
    });
  }

  /* ============================================================
     敌人数值：用经典公式定标（P3 数值统一 · 规划 §3.6 / 风险 R1-R3）
     ------------------------------------------------------------
     为什么两套数值必须合一：经典层 1 普通怪 hp **6**、层主 **16**；而引擎的
     ENEMY_TYPES 是 claw 24 / lord 160 —— 不统一的话"第一层就要砍 3~6 刀、
     Boss 要砍 32 刀"，与经典手感完全脱节；成长曲线也不同（经典线性斜率 2，
     引擎斜率随基数放大，层 999 相差 16 倍）。

     做法：**量级听经典、相对强弱听引擎**。
       · 经典公式只按 tier 给一个绝对量级（base = floor*2+4）
       · 引擎内部各敌人的强弱差异用"种类系数"保留
         （系数 = def.baseHp ÷ 该 tier 的引擎基准）
     于是层 1 的 claw = 6、lord = 16（与经典逐项相等），而 skeleton 仍比 claw
     厚、guard 仍比普通怪硬 —— 引擎按 hp 24 调好的动作参数（windup / recover /
     attackRange）也不会因为血量口径换了而失衡。
     ============================================================ */
  var TIER_REF = { normal: 24, mirror: 42, elite: 72, boss: 160 };

  function enemyScaler(info) {
    var s = S(), k = kernel();
    if (!s || !k || !info) return null;
    var floor = info.floor || s.floor || 1;

    // --- 难度修正（与内核 startCombat 的 modifier 同源）---
    var mods = null;
    try { mods = k.difficultyModifiers(); } catch (e) { mods = null; }
    // 本档的难度行：内置难度与自定义都要用它取 enemyAi（见下面 return）
    var diffRow = (mods && mods[s.difficulty]) || (mods && mods.normal) || {};
    var hpMul = 1, atkMul = 1, growth = 1;
    if (s.difficulty === 'custom') {
      try {
        var c = k.normalizeCustomDifficulty(s.customDifficulty);
        hpMul = c.enemyHp || 1;
        atkMul = c.enemyAtk || 1;
        growth = 1 + (floor - 1) * ((c.enemyGrowthCurve || 1) - 1) * 0.12;   // 同 getCustomEnemyGrowthFactor
        var cl = c.curseLevel || 0;
        hpMul *= 1 + 0.04 * cl;                    // 诅咒层级：血 +4%/级
        atkMul *= 1 + 0.08 * cl;                   //             攻 +8%/级
        if (c.escalatingPressure) {                // 递增压迫：每层 +8%
          var esc = 1 + 0.08 * (floor - 1);
          hpMul *= esc; atkMul *= esc;
        }
      } catch (e) { /* 归一化失败就用默认倍率 */ }
    } else {
      hpMul = diffRow.enemyHp || 1;
      atkMul = diffRow.enemyAtk || 1;
    }

    // --- 经典量级（内核 startCombat 的 tier 表）---
    // v2.8 全面加强：两条曲线都提了斜率，修的是「后期的怪跟不上玩家成长」——
    // 原来 base 只有 floor×2+4，玩家攻击一涨，前期怪和后期怪就都是两三刀的事。
    //   HP ：floor×2+4   → floor×2.5+5   （第 1 层 6→8，第 50 层 104→130）
    //   ATK：floor÷2     → floor×0.62    （第 10 层 5→6，第 50 层 25→31）
    var base = floor * 2.5 + 5;
    var half = Math.round(floor * 0.62);
    var tier = info.tier || 'normal';
    var hpBase, atkBase;
    if (tier === 'boss') { hpBase = base + 10; atkBase = 5 + half; }
    else if (tier === 'elite') { hpBase = base + 6; atkBase = 4 + half; }
    else if (tier === 'mirror') {
      // 镜像怪照玩家定标（经典：血量 50%~90%、攻击 40%~75%，取低档）
      var p = s.player || {};
      hpBase = Math.max(1, Math.round((p.maxHp || p.hp || 20) * 0.5));
      atkBase = Math.max(1, Math.round((p.attack || 5) * 0.4));
    } else { hpBase = base; atkBase = 3 + half; }

    // --- 种类相对系数 ---
    var ref = TIER_REF[tier] || TIER_REF.normal;
    var kHp = (info.baseHp || ref) / ref;
    // 攻击只取一半强度：实时战斗里玩家要靠走位与格挡扛伤害，完全照搬引擎的
    // 相对差（lord 是 claw 的 3.5 倍）会让 Boss 一下秒人；完全抹平又丢掉
    // "法师脆、守卫硬"的手感。
    var kAtk = 1 + ((info.baseAtk || 4) / 4 - 1) * 0.5;

    return {
      hp: Math.min(99999, Math.max(1, Math.round(hpBase * kHp * hpMul * growth))),
      atk: Math.min(200, Math.max(1, Math.round(atkBase * kAtk * atkMul * growth))),
      // AI 倍率包（更主动的那一层加强）。引擎拿到后换一份 def 副本，
      // 于是移速 / 前摇 / 后摇 / 索敌全都跟着难度走 —— 见 战斗2D.js 的 boostEnemyDef。
      // 上限 1.5：索敌太远会让怪隔着半个房间就冲过来，"一个一个引"的节奏就没了。
      ai: (function () {
        var a = diffRow.enemyAi;
        if (!a) return null;
        return {
          speed: a.speed || 1,
          windup: a.windup || 1,
          recover: a.recover || 1,
          detect: Math.min(1.5, a.detect || 1)
        };
      })()
    };
  }

  function pushEnemyScaler() {
    var e = engine();
    if (!e || typeof e.setEnemyScaler !== 'function') return false;
    try { return e.setEnemyScaler(enemyScaler); } catch (err) { return false; }
  }

  /* ============================================================
     遗物：内核 label → 引擎 id
     ------------------------------------------------------------
     内核遗物没有 id（只有中文 label），引擎的 RELIC_FX 只认英文 id。
     这张表是两边唯一的桥。P2 只映射语义能直接对上的；
     P3 按规划 §3.4 重做 24 件时会替换这张表。
     ============================================================ */
  /* ============================================================
     遗物池（A 项「遗物构筑化」）
     ------------------------------------------------------------
     与引擎的 RELIC_FX 一一对应：这里放 label / 品质 / **流派** / 卡片文案，
     引擎放实际效果。改造要点：
       · 每条 desc 都写清**条件**（什么时候生效）与**同流派搭配** ——
         玩家在三选一卡片上就能看出"这件是往哪个方向堆"
       · school 决定卡片上的流派标签，是"我正在凑哪一套"的唯一提示
       · 新增 3 件连携流（连携之心 / 不屈意志 / 回响精通）：不是为了加数量，
         而是因为连携是本次新增的资源，**必须**有遗物能围绕它构筑，
         否则它就是一条没有深度的孤立机制
     流派：blood 血怒 / perfect 完美 / link 连携 / greed 贪婪（空串 = 通用）
     ============================================================ */
  /** 流派显示名：三选一卡片的短标签用它（品质已由卡片配色表达） */
  var SCHOOL_NAME = { blood: '血怒', perfect: '完美', link: '连携', greed: '贪婪' };

  var RELIC_POOL = [
    // ===== 血怒流：主动掉血换输出 =====
    { id: 'desperateStrike', label: '破釜沉舟', quality: 'rare',      school: 'blood',   desc: '每损失 10% 生命，伤害 +7%（残血最多 +56%）· 与血之饥渴、荆棘之心成套' },
    { id: 'bloodThirst',     label: '血之饥渴', quality: 'rare',      school: 'blood',   desc: '吸血等级 +1；生命 ≤50% 时吸血翻倍' },
    { id: 'thornHeart',      label: '荆棘之心', quality: 'rare',      school: 'blood',   desc: '被命中反弹 +3；生命 ≤50% 时反伤翻倍' },
    { id: 'furyBlood',       label: '狂热之血', quality: 'common',    school: 'blood',   desc: '狂怒获取 +35%；生命 ≤50% 时再 +35%' },
    { id: 'immortalTotem',   label: '不朽图腾', quality: 'legendary', school: 'blood',   desc: '致命伤保留 1 血（每层一次）· 敢残血作战的前提' },
    { id: 'soulDrinker',     label: '汲魂者',   quality: 'common',    school: 'blood',   desc: '击杀回复 2 生命；生命 ≤50% 时回复 4' },

    // ===== 完美流：判定窗口与判定收益 =====
    { id: 'perfectInstinct', label: '完美直觉', quality: 'rare',      school: 'perfect', desc: '完美闪避窗口 +80ms，锐利持续 +2s' },
    { id: 'ironWall',        label: '铁壁',     quality: 'common',    school: 'perfect', desc: '完美格挡窗口 +80ms' },
    { id: 'counterBlade',    label: '反击之刃', quality: 'rare',      school: 'perfect', desc: '盾反伤害 ×2 → ×3，盾反回 3 护盾' },
    { id: 'sharpCore',       label: '锐利核心', quality: 'legendary', school: 'perfect', desc: '完美闪避的锐利倍率 2.2 → 3.0' },
    { id: 'windShadow',      label: '疾风残影', quality: 'rare',      school: 'perfect', desc: '闪避无敌帧 +120ms，冲刺距离 +15%' },

    // ===== 连携流：新资源（攒 → 选 → 险）的三个旋钮 =====
    { id: 'linkHeart',       label: '连携之心', quality: 'rare',      school: 'link',    desc: '连携上限 3 → 5，能一口气攒更多' },
    { id: 'unbroken',        label: '不屈意志', quality: 'legendary', school: 'link',    desc: '挨打时连携只 −1 而非清零 · 与连携之心成套' },
    { id: 'echoMaster',      label: '回响精通', quality: 'rare',      school: 'link',    desc: '连携招式倍率 1.6 → 2.2' },
    { id: 'executioner',     label: '处决者',   quality: 'rare',      school: 'link',    desc: '斩杀线 +10%；斩杀成功回 1 连携' },
    { id: 'heavyStrike',     label: '重击',     quality: 'common',    school: 'link',    desc: '跳劈 +0.4 倍、埋人 +12%；跳劈消耗连携时倍率再 +0.6' },

    // ===== 贪婪流：收益换风险 =====
    { id: 'greedyHeart',     label: '贪婪之心', quality: 'rare',      school: 'greed',   desc: '金币获取 +60%；受到的伤害 +20%' },
    { id: 'merchantEye',     label: '商人眼光', quality: 'common',    school: 'greed',   desc: '商店价格 −25%' },
    { id: 'fateWheel',       label: '命运轮盘', quality: 'legendary', school: 'greed',   desc: '每清一个房间随机 +2~8 金币 或 −1 生命' },

    // ===== 通用 =====
    { id: 'lightBoots',      label: '轻盈之靴', quality: 'common',    school: '',        desc: '体力上限 +30，停手回复 +30%' },
    { id: 'airFeather',      label: '滞空之羽', quality: 'rare',      school: '',        desc: '空中闪避保留的坠速更小，且不消耗体力' },
    { id: 'shieldResonance', label: '护盾共鸣', quality: 'common',    school: '',        desc: '任何来源获得的护盾 +2；完美格挡额外 +3' },
    { id: 'chainMaster',     label: '连击大师', quality: 'rare',      school: '',        desc: '连招窗口 +250ms，第 3 段横扫 +50%' },
    { id: 'huntMark',        label: '猎杀标记', quality: 'legendary', school: '',        desc: '斩杀线提升至 50%' },
    { id: 'trackingCharm',   label: '追踪符',   quality: 'rare',      school: '',        desc: '远程普攻追踪 +50%，弹速 +10%' },
    { id: 'piercingArrow',   label: '穿透之矢', quality: 'rare',      school: '',        desc: '远程普攻穿透 +1' },
    { id: 'abyssMark',       label: '深渊印记', quality: 'rare',      school: '',        desc: '遗物三选一变四选一' }
  ];

  var RELIC_BY_ID = {};
  RELIC_POOL.forEach(function (r) { RELIC_BY_ID[r.id] = r; });

  /**
   * 旧遗物（内核的 17 件，只有中文 label）→ 新遗物 id
   * 规划 §3.4 的映射表；映到 null 的表示"效果由内核自己继续处理"或已废弃。
   */
  var LEGACY_RELIC_MAP = {
    '战斗怒火': 'heavyStrike',
    '铁卫纹章': 'ironWall',
    '生命结晶': 'soulDrinker',
    '幸运硬币': 'greedyHeart',
    '坚固护符': 'shieldResonance',
    '恢复之心': 'soulDrinker',
    '回声之环': 'soulDrinker',
    '神圣庇护': null,            // 休整回复 +2：内核侧的 countRelic 继续生效
    '猎人本能': null,            // 死遗物（firstStrikeReduction 从未被写入），不再映射
    '狂战之心': 'chainMaster',
    '双刃匕首': 'windShadow',
    '猎杀标记': 'huntMark',
    '完美之刃': 'sharpCore',
    '不死图腾': 'immortalTotem',
    '斩杀之镰': 'executioner',
    '命运轮盘': 'fateWheel',
    '商人眼光': 'merchantEye'
  };

  var QUALITY_NAME = { common: '普通', rare: '稀有', legendary: '传说' };
  var QUALITY_TAG = { common: '强化', rare: '进阶', legendary: '传说' };

  /** 把 state.relics 里的元素统一取成引擎认识的 id（新遗物直接有 id，旧的走映射表） */
  function relicIds() {
    var s = S(), out = [];
    (s && s.relics ? s.relics : []).forEach(function (r) {
      var id = (typeof r === 'string') ? r : (r && r.id);
      if (!id) {
        var label = (r && r.label) || '';
        id = LEGACY_RELIC_MAP[label] || null;
      }
      if (id && out.indexOf(id) < 0) out.push(id);
    });
    return out;
  }

  /** 切 BGM 场景（面板氛围用）。引擎不认识的名字会被 AbyssAudio 忽略，不会报错 */
  function bgm(scene) {
    var e = engine();
    if (e && typeof e.setBgmScene === 'function') {
      try { e.setBgmScene(scene); } catch (err) { /* 忽略 */ }
    }
  }

  function hasRelic(id) {
    var s = S();
    return !!(s && (s.relics || []).some(function (r) { return (r && r.id) === id; }));
  }

  function pushRelics() {
    var e = engine();
    if (!e || typeof e.setRelics !== 'function') return false;
    e.setRelics(relicIds());
    return true;
  }

  /**
   * 抽 n 件候选遗物（不重复、排除已拥有、走自定义难度的权重与黑名单）
   * 权重与内核 getRandomRelicByRarity 同源（common 10 / rare 5 / legendary 1）。
   */
  function relicChoices(n) {
    var s = S(), k = kernel();
    var weights = { common: 10, rare: 5, legendary: 1 };
    var blacklist = [];
    if (s.difficulty === 'custom') {
      try {
        var c = k.normalizeCustomDifficulty(s.customDifficulty);
        weights = {
          common: c.commonWeight || 10,
          rare: c.rareWeight || 5,
          legendary: c.legendaryWeight || 1
        };
        blacklist = (c.relicBlacklist || []).map(function (x) { return String(x).toLowerCase(); }).filter(Boolean);
      } catch (e) { /* 用默认权重 */ }
    }
    var owned = {};
    (s.relics || []).forEach(function (r) { if (r && r.id) owned[r.id] = true; });
    var pool = RELIC_POOL.filter(function (r) {
      if (owned[r.id]) return false;
      for (var i = 0; i < blacklist.length; i++) {
        if (r.label.toLowerCase().indexOf(blacklist[i]) >= 0 || r.id.toLowerCase().indexOf(blacklist[i]) >= 0) return false;
      }
      return true;
    });
    var out = [];
    for (var j = 0; j < n && pool.length; j++) {
      var total = 0;
      pool.forEach(function (r) { total += weights[r.quality] || 1; });
      var pick = Math.random() * total, acc = 0, idx = 0;
      for (var m = 0; m < pool.length; m++) {
        acc += weights[pool[m].quality] || 1;
        if (pick <= acc) { idx = m; break; }
      }
      out.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return out;
  }

  /** 获得一件遗物：写内核 state + 重新下发给引擎（效果立刻生效） */
  function addRelic(r) {
    var s = S();
    if (!s || !r) return false;
    if (!s.relics) s.relics = [];
    if (s.relics.some(function (x) { return (x && x.id) === r.id; })) return false;
    s.relics.push({ id: r.id, label: r.label, quality: r.quality, description: r.desc });
    try { kernel().addLog('获得遗物：' + r.label + '（' + (QUALITY_NAME[r.quality] || '') + '）'); } catch (e) { /* 忽略 */ }
    pushRelics();
    pushStats();
    return true;
  }

  /**
   * 遗物三选一（精英必掉 / Boss 必掉 / 宝箱概率 / 商店购买）
   * 深渊印记会把 3 张变 4 张（规划 §3.4 第 23 条）。
   */
  function openRelicPanel(reason) {
    var s = S(), e = engine();
    if (!s || !e || typeof e.openRewardChoice !== 'function') return false;
    var n = hasRelic('abyssMark') ? 4 : 3;
    var choices = relicChoices(n);
    if (!choices.length) return false;          // 池子抽干了：直接放行，不要卡住流程
    s._relicChoices = choices;
    log('遗物三选一（' + reason + '）· 候选 ' + choices.length + ' 件');
    bgm('shop');
    // ⚠️ 必须走 openEventPanel('relic', …)：openRewardChoice 把 kind 写死成 'reward'，
    //    用它开遗物面板的话宿主永远收不到 kind==='relic'（实测：Boss 房领完奖励后
    //    又弹了一次奖励面板，遗物根本没发出去）。
    return e.openEventPanel('relic', {
      title: '遗物',
      desc: reason + ' · 选一件带走（或跳过换 20 金币）',
      cards: choices.map(function (r, i) {
        return {
          id: String(i), name: r.label, desc: r.desc,
          quality: r.quality,
          // 有流派的优先显示流派（品质已由卡片配色承担），没流派的退回原来的品质标签。
          // 这一格标签是"我正在凑哪一套"在界面上唯一的提示，所以让给流派。
          tag: (r.school && SCHOOL_NAME[r.school]) ? (SCHOOL_NAME[r.school] + '流') : (QUALITY_TAG[r.quality] || '强化')
        };
      }),
      actions: [{ id: 'skip', label: '跳过（+20 金币）' }]
    });
  }

  /* ============================================================
     引擎生命周期
     ============================================================ */
  function bindEvents() {
    var e = engine();
    if (!e || evBound) return;
    var g = e.getGame();
    if (!g || !g.events) return;

    g.events.on('rt:room', onRoom);
    g.events.on('rt:floor', onFloor);
    g.events.on('rt:room-cleared', onRoomCleared);
    g.events.on('rt:checkpoint', onCheckpoint);
    g.events.on('rt:room-action', onRoomAction);
    g.events.on('rt:pause', onPause);
    evBound = true;
    log('引擎事件已绑定');
  }

  /**
   * 启动本局 2D 战斗
   * 照抄 试炼程序.js 的 _realtimeTryStart：失败自动重试三级，全失败才放弃回退。
   */
  function startRun(silent) {
    if (booting || running) return running ? 'running' : 'booting';
    var e = engine(), s = S();
    if (!e) { giveUp(); return 'failed'; }
    if (unavailable) return 'failed';

    booting = true;
    var host = document.getElementById('trial2DCanvasHost');
    if (!host) { booting = false; giveUp(); return 'failed'; }

    if (!booted) {
      var ok = false;
      try { ok = e.init(host, retryCount > 0); } catch (err) { lastError = String(err); ok = false; }
      if (!ok) {
        booting = false;
        lastError = e.lastError ? e.lastError() : lastError;
        scheduleRetry(silent);
        return 'retry';
      }
      booted = true;
      e.setBridge(makeBridge());
      bindEvents();
    }

    // 环境与画幅
    try { e.show(); } catch (err) { /* 忽略 */ }

    var g = e.getGame();
    if (g && g.events && !evBound) bindEvents();

    // 先把"本层规划 / 诅咒池 / 遗物 / 节拍"下发，再开局
    pushFloorPlan();
    pushRelics();
    pushPulseProfile();
    pushCursePool();
    pushEnemyScaler();

    // 读档续玩的关键：层数与起始房间来自**存档**（N20）
    // ------------------------------------------------------------
    // 引擎的 beginRun 原来写死从第 1 层第 0 间开局，而这里又无条件把 roomIndex 归零 ——
    // 两者叠加的后果就是"2D 画面里存的档形同虚设，重进必须从第一层重新打"（用户反馈）。
    // 现在把这两个值交给引擎，开局就落在存档所在的位置上。
    var startFloor = Math.max(1, Math.round(s.floor || 1));
    var roomCount = (s.rooms || []).length;
    var startIdx = Math.max(0, Math.min(Math.round(s.roomIndex || 0), Math.max(0, roomCount - 1)));

    var started = false;
    try {
      started = e.startRun({
        heroName: (s.hero && s.hero.name) || '冒险者',
        points: (s.player && s.player.gold) || 0,
        player: playerStats(s),
        difficulty: realtimeDifficulty(s),
        skill: heroSkillPayload(s),
        heroId: (s.hero && s.hero.id) || '',
        // ⚠️ 诅咒要跟着存档一起带进来：原来这里写死空数组，于是读档续玩时
        //    存档里的诅咒**全部失效**（引擎的 curses 是空的，腐化脉冲也就不会结算它们）。
        //    实测：存档里 2 条诅咒 → 读档后引擎 curses = []。
        curses: rtCurses(s),
        environment: envPayload(s),
        relics: relicIds(),
        // 起始位置（读档续玩）：层数 / 本层第几间 / 本层已清房间数（脉冲节拍要用）
        floor: startFloor,
        roomIndex: startIdx,
        roomsClearedThisFloor: startIdx
      });
    } catch (err) {
      lastError = String(err);
      warn('startRun 抛出异常：', err);
      started = false;
    }

    booting = false;
    running = true;              // 场景未就绪时引擎会缓存 payload，这里视为已接管
    retryCount = 0;
    s.mode = MODE_TAG;           // 内核不认识这个 mode，但宿主已吞掉 render
    s.combat = null;             // 回合制战斗态不参与，清掉避免存档污染
    // 内核镜像对齐到与引擎**同一个位置**（引擎的开局房不会发 rt:room，只有 enterRoom 才发）
    s.floor = startFloor;
    s.roomIndex = startIdx;
    s.currentRoom = { type: (s.rooms && s.rooms[startIdx] && s.rooms[startIdx].type) || 'enemy' };
    showStage(true);
    log('本局 2D 已启动 · 第', startFloor, '层 第', (startIdx + 1), '间 ·', roomCount, '间房');
    return started ? 'started' : 'pending';
  }

  function scheduleRetry(silent) {
    if (retryTimer) return;
    var delay = RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)];
    retryCount += 1;
    if (retryCount > RETRY_DELAYS.length) { giveUp(); return; }
    if (!silent) log('引擎启动失败，' + delay + 'ms 后重试（第 ' + retryCount + ' 次）');
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (!running && enabled()) startRun(true);
    }, delay);
  }

  /**
   * 彻底放弃：退回文字界面 + 弹出降级提示
   * ------------------------------------------------------------
   * 用户第 3 条要求："把降级加回来，但提示用户切换老版"。
   * 这里**不做自动跳转** —— 两版存档命名空间不同（新版 abyss27_ / 老版 abyss_），
   * 自动跳过去玩家会看到另一份进度、还以为自己的档丢了。所以：
   *   降级 = 退回内核的回合制文字界面（照常能玩完一局）+ 一张说明面板，
   *   出路（重试 2D / 切老版 / 继续文字模式）由玩家自己点。
   */
  function giveUp() {
    unavailable = true;
    running = false;
    booting = false;
    showStage(false);
    warn('2D 引擎不可用，已回退回合制界面：', lastError || '(未知原因)');
    // 手机上看不到 console —— 把原因直接说给玩家听，
    // 否则"怎么突然变文字界面了"只能靠猜（这次就是靠用户反馈才定位到存档残留）。
    try {
      var k = kernel();
      if (k && typeof k.showToast === "function") {
        k.showToast('2D 实时战斗启动失败，已退回文字模式');
      }
    } catch (e) { /* 忽略 */ }
    showFallback(lastError);
    var s = S();
    if (s && s.mode === MODE_TAG) s.mode = 'event';
    try { if (global.render) global.render(); } catch (e) { /* 忽略 */ }
    // ⑥：退回文字界面就不该再锁着横屏 / 全屏（面板与文字界面都是竖屏友好的）
    exitLandscape();
  }

  /* ============================================================
     降级提示面板（用户第 3 条）
     ------------------------------------------------------------
     面板在 #trial2DStage **之外**（主界面.html 的 body 下，见那里的说明）：
     降级的第一步就是把整个舞台收起来，留在舞台里的面板会跟着一起消失。
     三条出路都由这里绑，且**只在第一次降级时绑一次**（引擎是全局单例，
     反复重试会多次进入 giveUp）。
     ============================================================ */
  var fallbackBound = false;

  function showFallback(reason) {
    var el = document.getElementById('trial2DFallback');
    if (!el) return;
    bindFallback();
    var why = document.getElementById('trial2DFallbackWhy');
    if (why) {
      var txt = reason ? String(reason).trim() : '';
      // 原因可能长到几十行（引擎会把四条渲染路径的失败原因串起来），
      // 面板里给的是可滚动区域，这里按原样塞进去
      why.textContent = txt ? ('失败原因：' + txt) : '已尝试全部渲染方式（含兼容模式），仍无法启动。';
    }
    el.classList.remove('hidden');
  }

  function hideFallback() {
    var el = document.getElementById('trial2DFallback');
    if (el) el.classList.add('hidden');
  }

  /** 切老版 2.6：先解锁横屏 / 全屏再跳（新页面不该继承一个锁死的方向） */
  function goLegacy() {
    try { exitLandscape(); } catch (e) { /* 忽略 */ }
    try { global.location.href = '老版2.6/主界面.html'; } catch (e) { /* 忽略 */ }
  }

  function bindFallback() {
    if (fallbackBound) return;
    fallbackBound = true;
    var retry = document.getElementById('trial2DFallbackRetry');
    if (retry) {
      retry.addEventListener('click', function () {
        hideFallback();
        // 重试 = 把"已放弃"的全部状态复位，再走一遍四种渲染路径
        unavailable = false;
        retryCount = 0;
        lastError = null;
        booted = false;          // 强制重新 init（换渲染方式）
        engineRef = null;        // 让 engine() 重新取全局（引擎可能已被重建）
        var s = S();
        if (s && !s.gameOver && s.mode !== 'heroSelect' && s.mode !== 'bonusSelect') {
          s.mode = MODE_TAG;
        }
        startRun(false);
        render();
      });
    }
    var legacy = document.getElementById('trial2DFallbackLegacy');
    if (legacy) legacy.addEventListener('click', goLegacy);
    var dismiss = document.getElementById('trial2DFallbackDismiss');
    if (dismiss) dismiss.addEventListener('click', hideFallback);
  }

  function stop() {
    running = false;
    booting = false;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    showStage(false);
    var e = engine();
    if (e && booted) { try { e.stopRun(); } catch (err) { /* 忽略 */ } }
  }

  /* ============================================================
     宿主桥（引擎回调宿主；setBridge 只收函数，非函数字段会被丢弃）
     ============================================================ */
  function makeBridge() {
    return {
      exit: function (result) { onRunEnded(result || {}); },
      checkpoint: function (snap) { onCheckpoint(snap, true); },
      choiceResult: function (r) { onChoiceResult(r || {}); },
      roomAction: function (p) { onRoomAction(p || {}); },
      /**
       * 引擎**内置**商店面板的数据源（Boss 后 nextFloor 会自动 openShop）
       * 不接的话那块面板会显示"商店数据不可用"。数据与宿主自己的商店面板同源，
       * 保证两边看到的商品、价格、限购完全一致。
       */
      shopData: function (points) {
        var s = S();
        var items = shopItemsFor();
        var gold = (typeof points === 'number') ? points : ((s.player && s.player.gold) || 0);
        return {
          groups: [{
            title: '补给',
            items: items.map(function (it, i) {
              var cost = shopCostOf(it);
              var owned = (s.shopPurchaseCount && s.shopPurchaseCount[it.label]) || 0;
              var max = it.maxPurchase || 0;
              // 限购 90 是「不限购」的哨兵值（与 主程序.js 的 buildShopOptions 同一约定）
              var limited = max > 0 && max < 90;
              var soldOut = limited && owned >= max;
              var afford = gold >= cost;
              return {
                id: String(i),
                label: it.label + '　' + cost + ' 金币' + (limited ? '（限购 ' + owned + '/' + max + '）' : ''),
                // desc / tag 是给引擎商店面板用的：引擎那两行的字段名是 desc 与 tag，
                // 之前一个都没给 —— 商品说明整行空白，右上角还会因为缺字段显示 undefined
                // （引擎旧代码读 it.price，而这里给的是 cost，见 战斗2D.js 的注释）。
                desc: it.desc || '',
                tag: soldOut ? '已售罄' : (afford ? '可购买' : '金币不足'),
                cost: cost,
                affordable: afford,
                owned: soldOut,
                rarity: it.rarity
              };
            })
          }]
        };
      },
      shopBuy: function (id, points) {
        var s = S();
        var idx = parseInt(id, 10);
        var it = (s.shopOptions || [])[idx];
        if (!it) return { ok: false, msg: '商品不存在' };
        var cost = shopCostOf(it);
        var gold = (s.player && s.player.gold) || 0;
        var owned = (s.shopPurchaseCount && s.shopPurchaseCount[it.label]) || 0;
        if (it.maxPurchase > 0 && it.maxPurchase < 90 && owned >= it.maxPurchase) {
          return { ok: false, msg: '已达限购' };
        }
        if (gold < cost) return { ok: false, msg: '金币不足' };
        s.player.gold = gold - cost;
        if (!s.shopPurchaseCount) s.shopPurchaseCount = {};
        s.shopPurchaseCount[it.label] = owned + 1;
        if (typeof it.apply === 'function') { try { it.apply(); } catch (e) { warn('商品生效失败：', e); } }
        try { kernel().addLog('购买了 ' + it.label + '（-' + cost + ' 金币）'); } catch (e) { /* 忽略 */ }
        syncPoints();
        pushStats();
        return { ok: true, msg: '已购买 ' + it.label, points: s.player.gold, name: it.label };
      },
      skillUsed: function (used) {
        var s = S();
        if (s) s.heroSkillUsed = !!used;
      },
      rewardPreview: function () { return null; },
      /**
       * 打开 DOM 侧边栏
       * v2.8 起 HUD 上不再有「更多」按钮（它和「退出」合并成了「菜单」），
       * 所以这里已无引擎调用点 —— 保留是因为开始界面 / 文字界面仍在用同一套侧边栏，
       * 而宿主内部的任何入口都可以继续走它。
       */
      openMenu: function () { return openSidePanel(); },
      /**
       * 画布菜单里的系统功能 → 打开对应的 DOM 面板
       * ------------------------------------------------------------
       * 引擎只传一个 id（它不认识"作弊面板"这类业务语义），由宿主决定开哪个、怎么开。
       * 这里**直接调宿主自己的函数**，而不是去 click 侧边栏那些按钮：
       * 那些按钮的处理器里都夹着"先收侧边栏"的动作，而从画布菜单过来时
       * 根本没有侧边栏需要收 —— 复用处理器会把一个不相关的副作用带进来。
       *
       * 战斗的冻结 / 解冻不用这边管：面板一开，anyDomPanelOpen() 就为真，
       * watchDomPanels() 挂上的观察器会在**全部关干净**之后才解冻
       * （于是"菜单 → 设置 → 从设置里开按键编辑器"这种连续切换不会中途放回战斗）。
       */
      openPanel: function (id) {
        var fn = null;
        switch (id) {
          case 'condition': fn = global.openConditionsModal; break;
          case 'codex': fn = global.openEncyclopediaModal; break;
          case 'tutorial': fn = global.startTutorial; break;
          case 'settings': fn = global.openSettingsModal; break;
          case 'save': fn = global.openSaveManager; break;
          case 'cheat': fn = global.openCheatModal; break;
          // 切老版会直接跳转页面，不需要冻结（跳走了就没有战斗要停）
          case 'legacy': return switchToLegacy();
          default: return false;
        }
        if (typeof fn !== 'function') return false;
        // ⚠️ 必须**先冻结再打开**。DOM 面板的显示靠一次 class 切换，而观察器是
        //    异步回调的：等它发现面板开了，中间已经过去若干帧 —— 那几帧里敌人
        //    照样在打你，而玩家以为画面已经暂停了。
        //    先冻住之后，观察器只会负责"全部关干净才解冻"的另一半。
        freezeForDomPanel();
        try {
          fn();
          return true;
        } catch (e) {
          warn('[菜单] 打开面板失败（' + id + '）：', e);
          return false;
        }
      },
      /**
       * 菜单里改难度
       * ------------------------------------------------------------
       * 与侧边栏那个下拉**同一条路径**：驱动顶栏 #difficultySelect 走它原有的
       * change 处理器。"难度怎么变"只有一个实现，两边不可能漂移。
       * 改完引擎的 difficulty 会由既有的难度签名比对自动跟上（不用这里手动推）。
       */
      setDifficulty: function (v) {
        var sel = document.getElementById('difficultySelect');
        if (!sel || !v) return false;
        if (sel.value === v) return true;      // 已经是这个难度：算成功，不重复触发
        sel.value = v;
        sel.dispatchEvent(new Event('change'));
        return true;
      },
      /**
       * 图鉴补充数据（遗物 / 商品 / 增益 / 事件）
       * ------------------------------------------------------------
       * 画内图鉴原来只有 6 类（英雄/怪物/技巧/连招/诅咒/环境），
       * 而文字界面的图鉴有 10 类 —— 这里把缺的 4 类数据交给引擎。
       * 全部**现算**（遗物读宿主的池、其余问内核），所以图鉴不可能和实现漂移。
       */
      codexExtra: function () {
        var k = kernel();
        var out = { relics: [], shop: [], bonus: [], events: [] };
        try {
          out.relics = RELIC_POOL.map(function (r) {
            return {
              name: r.label, quality: QUALITY_NAME[r.quality] || r.quality, desc: r.desc,
              // 图鉴里也带上流派：不然玩家看不出"这套遗物是往哪个方向堆的"
              school: SCHOOL_NAME[r.school] || ''
            };
          });
        } catch (e) { /* 忽略 */ }
        try { out.shop = k.shopCatalog() || []; } catch (e) { /* 忽略 */ }
        try { out.bonus = k.bonusPool() || []; } catch (e) { /* 忽略 */ }
        try { out.events = k.eventPool() || []; } catch (e) { /* 忽略 */ }
        return out;
      }
    };
  }

  /* ============================================================
     2D 画面里的 DOM 面板调度 + 停战 / 复战
     ------------------------------------------------------------
     v2.8 起侧边栏那批功能**画进了画布内的「菜单」界面**（见 战斗2D.js 的
     buildPauseLayer / menuFunctionGrid）。引擎不认识"作弊面板"这类业务语义，
     只把一个 id 交给 bridge.openPanel，由这里决定开哪个、怎么开 ——
     "引擎只画界面，宿主管业务"的边界没有破。

     侧边栏本体（`#sidebar`）保留：开始界面 / 文字界面照旧用它，
     它的 z-index（100002）本来就高于画布（9000）。

     冻结：侧边栏 / 任何 DOM 模态框打开期间必须停住战斗，否则玩家在调设置时
     会被看不见的敌人打死。统一用 anyDomPanelOpen() 判定，**关干净了才恢复** ——
     这样"菜单 → 点设置 → 从设置里开按键编辑器"这种连续切换不会中途把战斗放回去。
     ============================================================ */
  var DOM_MODAL_IDS = [
    'saveManagerModal', 'conditionsModal', 'encyclopediaModal', 'changelogModal',
    'cheatModal', 'settingsModal', 'attributeDetailModal', 'customDifficultyPanel'
  ];
  var panelObs = null;

  function sidebarEl() { return document.getElementById('sidebar'); }

  /** 是否有任何 DOM 面板（含侧边栏）正开着 */
  function anyDomPanelOpen() {
    var sb = sidebarEl();
    if (sb && sb.classList.contains('open')) return true;
    for (var i = 0; i < DOM_MODAL_IDS.length; i++) {
      var el = document.getElementById(DOM_MODAL_IDS[i]);
      if (el && !el.classList.contains('hidden')) return true;   // .hidden = 收起（与模态框同一约定）
    }
    return false;
  }

  /** 打开侧边栏（v2.8 起画布内已无入口，改由开始界面 / 文字界面使用） */
  function openSidePanel() {
    if (!sidebarEl()) return false;
    if (!global.sidebar || typeof global.sidebar.open !== 'function') return false;
    freezeForDomPanel();
    try {
      global.sidebar.open();
      return true;
    } catch (e) { return false; }
  }

  /**
   * 切到 2.6 老版（画布菜单里的「切换老版 2.6」）
   * ------------------------------------------------------------
   * 与侧边栏那颗同名按钮**同一套语义**：先存一次盘再跳走，否则这一次切换
   * 会把当前进度丢掉。也特意不用 confirm —— 系统对话框会把页面顶出全屏，
   * 破坏实时战斗的横屏 / 全屏状态。老版是 老版2.6/ 下一份完整独立的快照，
   * 两版存档互相隔离（见 主程序.js 的 migrateFromLegacyNamespace）。
   */
  function switchToLegacy() {
    try {
      var s = S();
      if (s && s.mode && s.mode !== 'start' && typeof global.saveGame === 'function') {
        global.saveGame();
      }
    } catch (e) { /* 存不上也让玩家走，总比卡在原地强 */ }
    try {
      global.location.href = '老版2.6/主界面.html';
      return true;
    } catch (e2) { return false; }
  }

  /** 冻结战斗并挂上"关干净才恢复"的观察器 */
  function freezeForDomPanel() {    watchDomPanels();
    var e = engine();
    if (e && typeof e.freezeForDom === 'function') {
      try { e.freezeForDom(); } catch (err) { /* 忽略 */ }
    }
  }

  function watchDomPanels() {
    if (panelObs || typeof MutationObserver === 'undefined') return;
    var targets = [];
    var sb = sidebarEl();
    if (sb) targets.push(sb);
    DOM_MODAL_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) targets.push(el);
    });
    if (!targets.length) return;
    panelObs = new MutationObserver(function () {
      if (anyDomPanelOpen()) return;      // 还有别的面板开着：继续冻结
      panelObs.disconnect();
      panelObs = null;
      var e = engine();
      if (e && running && typeof e.thawForDom === 'function') {
        try { e.thawForDom(); } catch (err) { /* 忽略 */ }
      }
    });
    targets.forEach(function (el) {
      panelObs.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  }

  /* ============================================================
     引擎事件 → 内核写回
     ============================================================ */

  /** 进房：内核的 roomIndex / currentRoom 跟着 2D 走 */
  function onRoom(p) {
    var s = S();
    if (!s) return;
    var type = (p && p.type) || 'enemy';
    s.currentRoom = { type: type };
    // 房间下标用引擎给的**列号**定位：宿主用 planFromRooms 把每间房单独放一列，
    // 于是 col 严格等于内核的房间下标（一一对应）。
    // ⚠️ 早先是"按类型 + 从当前下标往后找"，一层里出现两个同类型房间时会把后一个
    //    认成前一个（实测 rest 连排时中招：第 4 间被记成第 3 间），所以不能再用它做主判据。
    var col = (p && p.room && typeof p.room.col === 'number') ? p.room.col : -1;
    if (col >= 0 && col < (s.rooms || []).length) {
      s.roomIndex = col;
      // 玩家走的可能是**支线**（每列 2 个候选，见 planFromRooms）：
      // 把实际房型写回内核的房间表，于是存档 / 读档 / 结算看到的
      // 都是"真正打过的那一间"，而不是主线那一间。
      if (type && s.rooms[col] && s.rooms[col].type !== type) {
        s.rooms[col] = { type: type };
      }
    } else {
      for (var i = 0; i < (s.rooms || []).length; i++) {
        if (s.rooms[i] && s.rooms[i].type === type && i >= (s.roomIndex || 0)) { s.roomIndex = i; break; }
      }
    }
    log('进房 ' + type + ' · 第 ' + (s.roomIndex + 1) + '/' + (s.rooms || []).length + ' 间');
    // 每进一个房间重掷环境（引擎的 rollRoomEnv 会发 rt:room，这里同步给引擎）
    pushCursesEnv();
  }

  /** 换层：对齐 advanceRoom() 的全部副作用 */
  function onFloor(p) {
    var s = S(), k = kernel();
    if (!s || !k) return;
    var floor = (p && p.floor) || (s.floor + 1);
    s.floor = floor;
    s.roomIndex = 0;
    s.rooms = k.generateFloorRooms(floor);
    s.environment = k.generateEnvironmentEffect(floor, s.difficulty);
    s.heroSkillUsed = false;
    s._riftDoneThisFloor = false;   // 每层一次：深渊裂隙的抉择
    k.addLog('你闯入了第 ' + floor + ' 层。');
    // 先下发新层规划，再让引擎按它重取地图（引擎在发完本事件后才设 roomNode，
    // 所以这里替换 floorMap 是安全的）
    pushFloorPlan();
    rebuildEngineMap();
    pushPulseProfile();
    if (s.hero && s.hero.skill && s.hero.skill.active) {
      var e = engine();
      if (e && e.setSkill) e.setSkill(heroSkillPayload(s));
    }
  }

  /**
   * 清房
   * ① 以经典公式重算本房金币，覆盖引擎自己的击杀金币（经济统一，规划 §3.6/R8）
   * ② 战斗房清空后弹「奖励三选一」（经典语义：打完一场选一个）
   */
  function onRoomCleared(p) {
    var s = S(), e = engine();
    if (!s) return;
    if (p && typeof p.hp === 'number') syncHp(p.hp);
    // ⚠️ 房型一律以**引擎载荷**为准（p.roomType 来自引擎的 roomNode），
    //    不要信 s.currentRoom —— 它是宿主在 rt:room 里镜像出来的，
    //    遇到"引擎换了房而宿主还没收到 rt:room"的时序就会错，表现为该弹结算的房间
    //    错弹成奖励三选一（实测踩过）。
    var roomType = (p && p.roomType) || (s.currentRoom && s.currentRoom.type) || 'enemy';
    settleRoomGold(roomType);
    if (s.gameOver) return;
    var combat = isCombatRoom(roomType);
    log('清房 ' + roomType + ' → ' + (combat ? '弹奖励三选一' : '非战斗房，直接放行') +
        '（引擎 roomNode=' + roomType + '，宿主镜像=' + (s.currentRoom && s.currentRoom.type) + '）');
    // 遗物产出（规划 §3.4）：精英必掉、Boss 必掉；宝箱房走概率
    if (roomType === 'elite') s._pendingRelic = '精英遗物';
    else if (roomType === 'boss') s._pendingRelic = '层主遗物';
    else if (roomType === 'treasure' && Math.random() < 0.45) s._pendingRelic = '宝箱遗物';
    else s._pendingRelic = null;
    if (combat) openRewardPanel();
    else if (e && e.setPoints) e.setPoints(s.player.gold);
  }

  function onCheckpoint(snap, fromBridge) {
    var s = S();
    if (!s || !snap) return;
    if (typeof snap.hp === 'number') syncHp(snap.hp);
    if (typeof snap.floor === 'number' && snap.floor !== s.floor) s.floor = snap.floor;
    // 房间位置以**引擎快照**为准（它是权威）：进房时的 rt:room 已经同步过一次，
    // 这里再对一次是防御 —— 万一事件没绑上 / 顺序有变，存档的位置依然是准的。
    if (snap.room && typeof snap.room.col === 'number') s.roomIndex = snap.room.col;
    try { kernel().saveGame(); } catch (e) { /* 忽略 */ }
  }

  /** 非战斗房间的目标物被触碰：商店 / 休整 / 事件（宝箱由引擎自己结算） */
  function onRoomAction(p) {
    var s = S();
    if (!s) return;
    var kind = (p && p.kind) || (s.currentRoom && s.currentRoom.type) || 'event';
    log('房间交互 ' + kind);
    if (kind === 'shop') openShopPanel();
    else if (kind === 'rest') openRestPanel();
    else if (kind === 'shrine') openShrinePanel();
    else openEventPanel();
  }

  function onPause() { /* P4 再接：暂停时冻结内核输入 */ }

  /** 一局结束：写回内核（死亡或主动结束） */
  function onRunEnded(result) {
    var s = S(), e = engine();
    if (!s) return;
    running = false;
    showStage(false);
    if (typeof result.hp === 'number') syncHp(result.hp);
    s.player.hp = Math.max(0, Math.round(result.hp || 0));
    s.gameOver = true;
    s.mode = 'gameover';
    s.combat = null;
    // 日志按**真实原因**措辞：玩家自己点「结束本局」时不该写"你倒下了"
    // （引擎的 result.reason：'dead' = 战死，'manual' = 主动结束）
    var died = String(result.reason || 'dead') === 'dead';
    var endFloor = result.floor || s.floor;
    try {
      kernel().addLog(died
        ? ('你倒在了第 ' + endFloor + ' 层。')
        : ('你结束了这次冒险 —— 止步第 ' + endFloor + ' 层。'));
    } catch (err) { /* 忽略 */ }
    try { kernel().updateRecords(false); } catch (err) { /* 忽略 */ }
    try { kernel().saveGame(); } catch (err) { /* 忽略 */ }
    sfx('defeat');
    if (e && e.stopRun) { try { e.stopRun(); } catch (err) { /* 忽略 */ } }
    try { if (global.render) global.render(); } catch (err) { /* 忽略 */ }
  }

  /** 面板选择结果回写内核 */
  function onChoiceResult(r) {
    var s = S();
    if (!s) return;
    var kind = r.kind, id = r.id;
    if (kind === 'reward') {
      var idx = parseInt(id, 10);
      var opt = (s.rewardOptions || [])[idx];
      if (opt && typeof opt.apply === 'function') {
        try { opt.apply(); } catch (e) { warn('奖励生效失败：', e); }
        try { kernel().addLog('你选择了：' + opt.label); } catch (e) { /* 忽略 */ }
      }
      s.rewardOptions = [];
      // 属性奖励领完，若本房还有遗物产出就接着弹（精英 / Boss 必掉）
      if (s._pendingRelic) {
        var why = s._pendingRelic;
        s._pendingRelic = null;
        if (openRelicPanel(why)) return;
      }
      advanceToNextRoom();
      return;
    }
    if (kind === 'rift') {
      if (id === 'light') {
        addCurses(1, 0);
        if (openRelicPanel('裂隙遗物')) return;
      } else if (id === 'deep') {
        addCurses(1, 1);
        var bonus = s.floor * 8;
        s.player.gold = (s.player.gold || 0) + bonus;
        syncPoints();
        try { kernel().addLog('沉沦的回报：+' + bonus + ' 金币。'); } catch (e) { /* 忽略 */ }
        if (openRelicPanel('裂隙遗物')) return;
      } else {
        s._shopDiscount = 0.10;      // 本层商店 −10%（P3-5 的商店面板消费它）
        try { kernel().addLog('你拒绝了裂隙，本层商店价格 −10%。'); } catch (e) { /* 忽略 */ }
      }
      advanceToNextRoom();
      return;
    }
    if (kind === 'relic') {
      var rix = parseInt(id, 10);
      var picked = (s._relicChoices || [])[rix];
      if (id === 'skip') {
        s.player.gold = (s.player.gold || 0) + 20;
        syncPoints();
        try { kernel().addLog('跳过遗物，换成 20 金币。'); } catch (e) { /* 忽略 */ }
      } else if (picked) {
        addRelic(picked);
      }
      s._relicChoices = [];
      // 宝箱房是"非战斗房"，要走 finishRoomGoal 才开门；精英/Boss 房已经开过门了
      finishNonCombatRoom();
      advanceToNextRoom();
      return;
    }
    if (kind === 'shop' && id && id.indexOf('buy:') === 0) { buyShopItem(id.slice(4)); return; }
    if (kind === 'rest') { restAction(id); return; }
    if (kind === 'shrine') { shrineAction(id); return; }
    if (kind === 'ending') {
      var ix = parseInt(id, 10);
      if (id === 'stay') { s.endOptions = []; finishNonCombatRoom(); advanceToNextRoom(); return; }
      var endOpt = (s.endOptions || [])[ix];
      if (endOpt) {
        s.endResult = endOpt;
        s.mode = 'finished';
        try { kernel().updateRecords(true); } catch (e) { /* 忽略 */ }
        try { kernel().addLog('结局：' + (endOpt.title || '')); } catch (e) { /* 忽略 */ }
        try { kernel().saveGame(); } catch (e) { /* 忽略 */ }
        // 交还给内核：关掉画布并退出接管，让内核渲染结局页
        running = false;
        stop();
        try { if (global.render) global.render(); } catch (e) { /* 忽略 */ }
      }
      s.endOptions = [];
      return;
    }
    if (kind === 'event') {
      var ei = parseInt(id, 10);
      var ev = (s.eventOptions || [])[ei];
      if (ev && typeof ev.apply === 'function') {
        try { ev.apply(); } catch (e) { warn('事件生效失败：', e); }
        try { kernel().addLog('事件：' + ev.label); } catch (e) { /* 忽略 */ }
      }
      s.eventOptions = [];
      finishNonCombatRoom();
      advanceToNextRoom();
      return;
    }
    finishNonCombatRoom();
    advanceToNextRoom();
  }

  /** 非战斗房处理完 → 让引擎收尾（开放传送门） */
  function finishNonCombatRoom() {
    var e = engine();
    if (e && e.finishRoomGoal) { try { e.finishRoomGoal(); } catch (err) { /* 忽略 */ } }
  }

  /**
   * 走向下一间房（引擎的传送门已开）
   * ⚠️ Boss 房**不能**在这里打开地图：引擎 nextFloor() 开头就是
   *    `if (!this.portalOpen || this.mapOpen) return` —— 地图一开，玩家就再也走不进传送门，
   *    整局直接卡死（实测踩过）。Boss 房交给引擎自己走：
   *    清房开门 → 玩家走进传送门 → nextFloor →（开商店）→ 关商店后自动开地图。
   */
  function advanceToNextRoom() {
    var e = engine(), s = S();
    if (!e || !s) return;
    syncPoints();
    var type = s.currentRoom && s.currentRoom.type;
    if (type === 'boss') {
      // 层主房清完、进下一层之前：先弹「深渊裂隙」抉择（规划 §3.5）。
      // 用 _riftDoneThisFloor 挡住递归 —— 这个函数会被裂隙选择的结果再次调到，
      // 不挡的话会在同一层无限弹下去。
      if (!s._riftDoneThisFloor) {
        s._riftDoneThisFloor = true;
        if (openRiftPanel()) return;
      }
      // 结局面板的触发口径见 openEndingPanel 的说明（原来只在上限层弹，等于"没有胜利"）。
      // 楼层上限与 openEndingPanel 的 force 参数配合：到上限就是"必须结算"。
      // 第 5 条：打完层主 = 一次"通关条件"检查点（不是只有 999 层才检查）。
      //   · 有新达成的结局 → 弹结局面板（选结局 = 胜利结算，或"继续战斗"）；
      //   · 已到楼层上限 → force = true，全部可用结局都摆出来（必须结算）；
      //   · 两者都不成立 → 放行，玩家自己走进传送门换层（引擎 nextFloor 处理）。
      if (openEndingPanel(s.floor >= floorLimit(s))) return;
      return;
    }
    try { e.press('map'); } catch (err) { warn('打开地图失败：', err); }
  }

  /* ============================================================
     经济对齐（规划 §3.6 / 风险 R8）
     ------------------------------------------------------------
     内核的"一场战斗"= 2D 的"一间房"。所以以经典公式为准重算本房金币，
     再把权威值写回引擎（引擎自己的击杀金币被覆盖掉，避免两套账）。
     ============================================================ */
  function goldMultiplier(s) {
    var mods = null;
    try { mods = kernel().difficultyModifiers(); } catch (e) { mods = null; }
    if (s.difficulty === 'custom') {
      try { return kernel().normalizeCustomDifficulty(s.customDifficulty).goldReward || 1; } catch (e) { return 1; }
    }
    var m = (mods && mods[s.difficulty]) || (mods && mods.normal) || { goldReward: 1 };
    return m.goldReward || 1;
  }

  function settleRoomGold(roomType) {
    var s = S(), e = engine();
    if (!s || !s.player) return 0;
    var gain = 0;
    var mult = goldMultiplier(s);
    if (roomType === 'treasure') {
      gain = 15;                                             // 内核宝箱房：+15
    } else if (roomType === 'shop' || roomType === 'rest' || roomType === 'event' || roomType === 'shrine') {
      gain = 0;                                              // 非战斗房（含祭坛）不给战斗金币
    } else if (roomType === 'boss') {
      gain = Math.max(1, Math.round((8 + s.floor) * mult)) * 2;
    } else {
      gain = Math.max(1, Math.round((8 + s.floor) * mult));   // enemy / elite / mirror
    }
    if (gain > 0) {
      if (s.player.gold == null) s.player.gold = 0;
      s.player.gold += gain;
      try { kernel().addLog('战斗胜利，获得 ' + gain + ' 金币。'); } catch (err) { /* 忽略 */ }
    }
    // 经验：沿用内核公式，保证成长的另一半不落空
    var xp = Math.max(1, Math.round((5 + s.floor) * (s.hasExpBoost ? 1.5 : 1)));
    s.player.xp = (s.player.xp || 0) + xp;
    syncPoints();
    return gain;
  }

  /** 把内核金币推给引擎（引擎 HUD 显示的才是真数） */
  function syncPoints() {
    var e = engine(), s = S();
    if (!e || !s || !s.player || typeof e.setPoints !== 'function') return false;
    try { e.setPoints(Math.max(0, Math.round(s.player.gold || 0))); return true; } catch (err) { return false; }
  }

  function syncHp(hp) {
    var s = S();
    if (!s || !s.player) return;
    var v = Math.max(0, Math.round(hp));
    s.player.hp = v;
    if (s.player.maxHp && v > s.player.maxHp) s.player.hp = s.player.maxHp;
  }

  /* ============================================================
     画内面板内容（引擎只画，宿主决定内容）
     ============================================================ */
  function isCombatRoom(type) {
    // ⚠️ elite 在内核 enterCurrentRoom 里不被当成战斗房（会掉进 event 分支），
    //    但在 2D 里它就是战斗房 —— 这里按 2D 的语义判定
    return type === 'enemy' || type === 'elite' || type === 'mirror' || type === 'boss';
  }

  /** 奖励标签 → 卡片文案（内容都在内核 label 里，这里只补一句人话） */
  var REWARD_DESC = {
    '攻击 +1': '挥砍伤害提高，所有招式都受益',
    '生命上限 +4': '上限与当前生命同时提升',
    '护盾 +3': '优先抵扣伤害，可叠加',
    '治疗药水 +1': '按 L 立刻回复生命',
    '力量药水': '下一场战斗攻击大幅提升',
    '金币 +12': '立刻入账',
    '暴击 +10%': '提高暴击触发概率',
    '暴击伤害 +5%': '暴击时的倍率更高',
    '荆棘 +1': '被命中时反弹伤害',
    '吸血 +1': '造成伤害时回复生命',
    '闪避 +5%': '受击有概率完全躲开',
    '连击 +5%': '提高连段触发率',
    '斩杀 +5%': '提高对残血敌人的处决线'
  };
  var REWARD_QUALITY = {
    '暴击 +10%': 'rare', '暴击伤害 +5%': 'rare', '荆棘 +1': 'rare',
    '吸血 +1': 'rare', '闪避 +5%': 'rare', '连击 +5%': 'rare', '斩杀 +5%': 'rare',
    '力量药水': 'rare'
  };

  function openRewardPanel() {
    var s = S(), e = engine(), k = kernel();
    if (!s || !e || typeof e.openRewardChoice !== 'function') return false;
    var opts = [];
    try { opts = k.buildRewardOptions() || []; } catch (err) { opts = []; }
    s.rewardOptions = opts;                                  // 供 choiceResult 回查 apply
    if (!opts.length) { advanceToNextRoom(); return false; }
    var cards = opts.map(function (o, i) {
      return {
        id: String(i),
        name: o.label,
        desc: REWARD_DESC[o.label] || '立即生效',
        quality: REWARD_QUALITY[o.label] || 'common',
        tag: REWARD_QUALITY[o.label] === 'rare' ? '成长' : '强化'
      };
    });
    var gold = (s.player && s.player.gold) || 0;
    return e.openRewardChoice({
      title: '战斗奖励',
      desc: '第 ' + s.floor + ' 层 · ' + roomName(s.currentRoom && s.currentRoom.type) +
            '　金币 ' + gold,
      cards: cards,
      actions: [{ id: 'skip', label: '跳过（+15 金币）' }]
    });
  }

  /**
   * 本层商店的商品表
   * 内核的 buildShopOptions()（每层随机上架 4 件、含限购）再**追加「净化」**——
   * 那是诅咒系统的解除途径之一（规划 §3.5），有诅咒时才上架。
   * 结果存进 s.shopOptions，购买时按同一份下标回查 apply —— 顺序必须保持一致。
   */
  function shopItemsFor() {
    var s = S(), k = kernel();
    var items = [];
    try { items = k.buildShopOptions() || []; } catch (err) { items = []; }
    items = items.slice();
    if (rtCurses(s).length) {
      items.push({
        label: '净化',
        cost: 25 + s.floor * 5,
        expCost: 0,
        rarity: 'rare',
        maxPurchase: 99,
        purify: true,
        apply: function () { purifyOneCurse(); }
      });
    }
    s.shopOptions = items;
    return items;
  }

  /** 单件商品的实际价格：内核的难度/商人眼光修正 + 深渊裂隙「拒绝」给的 −10% */
  function shopCostOf(it) {
    var s = S(), k = kernel();
    var cost = it.cost;
    try { cost = k.getShopItemCost(it); } catch (err) { cost = it.cost; }
    // 「拒绝裂隙」的补偿：本层商店价格 −10%（商人眼光的 −2 金币由内核那边算，别重复扣）
    if (s._shopDiscount) cost = Math.max(0, Math.round(cost * (1 - s._shopDiscount)));
    return cost;
  }

  /** 解除一条诅咒（净化商品 / 祭坛献祭共用） */
  function purifyOneCurse() {
    var s = S();
    if (!s || !s._rtCurses || !s._rtCurses.length) return false;
    var removed = s._rtCurses.shift();
    try { kernel().addLog('解除了诅咒「' + removed + '」。'); } catch (e) { /* 忽略 */ }
    pushCursesEnv();
    return removed;
  }

  function openShopPanel() {
    var s = S(), e = engine();
    if (!s || !e || typeof e.openEventPanel !== 'function') return false;
    var items = shopItemsFor();
    var gold = (s.player && s.player.gold) || 0;
    var cards = items.map(function (it, i) {
      var cost = shopCostOf(it);
      var owned = (s.shopPurchaseCount && s.shopPurchaseCount[it.label]) || 0;
      var max = it.maxPurchase || 0;
      var soldOut = max > 0 && owned >= max;
      var afford = gold >= cost;
      return {
        id: 'buy:' + i,
        name: it.label,
        desc: (it.rarity === 'rare' ? '稀有 · ' : '') + cost + ' 金币' +
              (max > 0 ? '　限购 ' + owned + '/' + max : ''),
        quality: it.rarity === 'rare' ? 'rare' : 'common',
        tag: soldOut ? '已售罄' : (afford ? '可购买' : '金币不足'),
        disabled: soldOut || !afford
      };
    });
    if (!cards.length) cards.push({ id: 'none', name: '暂无商品', desc: '', quality: 'common', disabled: true });
    return e.openEventPanel('shop', {
      title: '商店',
      desc: '金币 ' + gold + '　第 ' + s.floor + ' 层',
      cards: cards,
      actions: [{ id: 'leave', label: '离开', primary: true }]
    });
  }

  function buyShopItem(idxStr) {
    var s = S(), k = kernel();
    if (!s) return;
    var idx = parseInt(idxStr, 10);
    var it = (s.shopOptions || [])[idx];
    if (!it) return;
    var cost = shopCostOf(it);
    var gold = (s.player && s.player.gold) || 0;
    var owned = (s.shopPurchaseCount && s.shopPurchaseCount[it.label]) || 0;
    if (it.maxPurchase > 0 && owned >= it.maxPurchase) return;
    if (gold < cost) return;
    s.player.gold = gold - cost;
    if (!s.shopPurchaseCount) s.shopPurchaseCount = {};
    s.shopPurchaseCount[it.label] = owned + 1;
    if (typeof it.apply === 'function') { try { it.apply(); } catch (e) { warn('商品生效失败：', e); } }
    try { k.addLog('购买了 ' + it.label + '（-' + cost + ' 金币）'); } catch (e) { /* 忽略 */ }
    syncPoints();
    pushStats();
    openShopPanel();       // 重开一次刷新可购买状态
  }

  function openRestPanel() {
    var s = S(), e = engine(), k = kernel();
    if (!s || !e || typeof e.openEventPanel !== 'function') return false;
    var mods = null;
    try { mods = k.difficultyModifiers(); } catch (err) { mods = null; }
    var restBonus = 0;
    if (s.difficulty === 'custom') {
      try { restBonus = k.normalizeCustomDifficulty(s.customDifficulty).restBonus || 0; } catch (err) { restBonus = 0; }
    } else {
      restBonus = ((mods && mods[s.difficulty]) || (mods && mods.normal) || {}).restBonus || 0;
    }
    var extra = 0;
    try { extra = k.countRelic('神圣庇护') * 2; } catch (err) { extra = 0; }
    var restore = 5 + extra + restBonus;
    var potions = (s.player && s.player.potions) || 0;
    var actions = [{ id: 'rest', label: restore >= 0 ? ('歇息（+' + restore + ' 生命）') : ('歇息（-' + Math.abs(restore) + ' 生命）'), primary: true }];
    if (potions > 0) actions.push({ id: 'potion', label: '用药水（+8 生命）' });
    actions.push({ id: 'leave', label: '直接离开' });
    return e.openEventPanel('rest', {
      title: '休整点',
      desc: '生命 ' + Math.round(s.player.hp) + '/' + s.player.maxHp + '　药水 ×' + potions,
      cards: [{ id: 'info', name: '营地', desc: '安静地喘口气', quality: 'common', disabled: true }],
      actions: actions
    });
  }

  function restAction(id) {
    var s = S(), k = kernel();
    if (!s) return;
    if (id === 'potion') {
      if (s.player.potions > 0) {
        s.player.potions -= 1;
        s.player.hp = Math.min(s.player.maxHp, s.player.hp + 8);
        try { k.addLog('你在休整点喝下药水，恢复 8 点生命。'); } catch (e) { /* 忽略 */ }
      }
    } else if (id === 'rest') {
      var mods = null;
      try { mods = k.difficultyModifiers(); } catch (e) { mods = null; }
      var restBonus = 0;
      if (s.difficulty === 'custom') {
        try { restBonus = k.normalizeCustomDifficulty(s.customDifficulty).restBonus || 0; } catch (e) { restBonus = 0; }
      } else {
        restBonus = ((mods && mods[s.difficulty]) || (mods && mods.normal) || {}).restBonus || 0;
      }
      var extra = 0;
      try { extra = k.countRelic('神圣庇护') * 2; } catch (e) { extra = 0; }
      var restore = 5 + extra + restBonus;
      if (restore >= 0) {
        s.player.hp = Math.min(s.player.maxHp, s.player.hp + restore);
        try { k.addLog('你在休整点恢复了 ' + restore + ' 点生命。'); } catch (e) { /* 忽略 */ }
      } else {
        var dmg = Math.abs(restore);
        s.player.hp = Math.max(1, s.player.hp - dmg);
        try { k.addLog('休整点环境侵蚀，你失去了 ' + dmg + ' 点生命。'); } catch (e) { /* 忽略 */ }
      }
    }
    pushStats();
    finishNonCombatRoom();
    advanceToNextRoom();
  }

  /**
   * 祭坛房（shrine）
   * 祈祷：回最大生命的 35%（引擎的祭坛就是这数值）
   * 献祭：以生命换解除一条诅咒 —— 诅咒系统的第二条解除途径（规划 §3.5）
   */
  function openShrinePanel() {
    var s = S(), e = engine();
    if (!s || !e || typeof e.openEventPanel !== 'function') return false;
    var curses = rtCurses(s);
    var heal = Math.round((s.player.maxHp || 20) * 0.35);
    var sacrifice = Math.max(3, Math.round((s.player.maxHp || 20) * 0.15));
    var actions = [{ id: 'pray', label: '祈祷（+' + heal + ' 生命）', primary: true }];
    if (curses.length) {
      actions.push({ id: 'sacrifice', label: '献祭 ' + sacrifice + ' 生命 · 解除一条诅咒' });
    }
    actions.push({ id: 'leave', label: '离开' });
    var cards = [{
      id: 'info', name: '祭坛', quality: 'common', disabled: true,
      desc: curses.length ? ('身上有 ' + curses.length + ' 条诅咒：' + curses.join('、')) : '身上没有诅咒'
    }];
    return e.openEventPanel('shrine', {
      title: '祭坛',
      desc: '生命 ' + Math.round(s.player.hp) + '/' + s.player.maxHp + '　第 ' + s.floor + ' 层',
      cards: cards,
      actions: actions
    });
  }

  function shrineAction(id) {
    var s = S(), k = kernel();
    if (!s) return;
    if (id === 'pray') {
      var heal = Math.round((s.player.maxHp || 20) * 0.35);
      s.player.hp = Math.min(s.player.maxHp, s.player.hp + heal);
      try { k.addLog('在祭坛祈祷，恢复 ' + heal + ' 点生命。'); } catch (e) { /* 忽略 */ }
    } else if (id === 'sacrifice') {
      var cost = Math.max(3, Math.round((s.player.maxHp || 20) * 0.15));
      if (s.player.hp <= cost) {
        try { k.addLog('生命太低，祭坛不接受这次献祭。'); } catch (e) { /* 忽略 */ }
      } else {
        s.player.hp -= cost;
        try { k.addLog('献祭了 ' + cost + ' 点生命。'); } catch (e) { /* 忽略 */ }
        purifyOneCurse();
      }
    }
    pushStats();
    finishNonCombatRoom();
    advanceToNextRoom();
  }

  function openEventPanel() {
    var s = S(), e = engine(), k = kernel();
    if (!s || !e || typeof e.openEventPanel !== 'function') return false;
    var opts = [];
    try { opts = k.getRandomEvent() || []; } catch (err) { opts = []; }
    s.eventOptions = opts;
    var cards = opts.map(function (o, i) {
      return {
        id: String(i),
        name: o.label,
        desc: o.description || '',
        quality: 'common',
        tag: '事件'
      };
    });
    if (!cards.length) { finishNonCombatRoom(); advanceToNextRoom(); return false; }
    return e.openEventPanel('event', {
      title: '随机事件',
      desc: '第 ' + s.floor + ' 层 · 选择你的应对',
      cards: cards,
      actions: [{ id: 'leave', label: '不理会' }]
    });
  }

  /** 楼层上限（内核 MAX_FLOOR=999，或自定义难度的 floorCap），到达即走结局流程 */
  function floorLimit(s) {
    if (s && s.difficulty === 'custom') {
      try {
        var c = kernel().normalizeCustomDifficulty(s.customDifficulty);
        if (c && c.floorCap > 0) return c.floorCap;
      } catch (e) { /* 用默认上限 */ }
    }
    return 999;
  }

  /**
   * 结局面板 —— 也就是**游戏胜利**
   * ------------------------------------------------------------
   * 第 5 条：合并后"只有失败没有胜利"。真因不是结局面板缺失（P3-2 就做好了），
   * 而是它只在 `floor >= floorLimit()`（默认 **999**）时才弹 —— 正常一局根本到不了。
   *
   * 现在改成按**侧边栏「通关条件」**那套条目来判（用户指定）：
   *   · 每打完一层的**层主**就检查一次（`advanceToNextRoom` 的 boss 分支）；
   *   · 只在"这次新解锁了结局"时才弹 —— 用 `s._endingShownIds` 记本局已展示过的，
   *     否则第 3 层之后每一层都会弹同一张面板；
   *   · 面板**永远保留**「继续战斗」，所以"达成通关条件"不等于被迫结束
   *     （用户原话："达成后仍可选择继续战斗"）；
   *   · 到楼层上限（999 / 自定义 floorCap）时传 force = true，把全部可用结局摆出来，
   *     那是"必须结算"的场合。
   *
   * 选完 → 关画布、把 mode 交还内核，由内核渲染结局页。
   */
  function openEndingPanel(force) {
    var s = S(), e = engine(), k = kernel();
    if (!s || !e || typeof e.openEventPanel !== 'function') return false;
    var opts = [];
    try { opts = k.getEndOptions() || []; } catch (err) { opts = []; }
    if (!opts.length) return false;

    // 本局已展示过的结局（纯字符串数组，存档安全）
    var shown = s._endingShownIds || (s._endingShownIds = []);
    var fresh = opts.filter(function (o) { return shown.indexOf(o.id) < 0; });
    // ⚠️ force 之外，**没有新结局就不弹**：这正是"防每层都弹"的那道闸
    if (!force && !fresh.length) return false;
    var list = force ? opts : fresh;

    // 面板卡片用下标做 id（onChoiceResult 按 s.endOptions 回查），
    // 所以 s.endOptions 必须与 cards **同一份顺序**。
    s.endOptions = list;
    list.forEach(function (o) { if (shown.indexOf(o.id) < 0) shown.push(o.id); });

    var cards = list.map(function (o, i) {
      return {
        id: String(i),
        name: o.title || ('结局 ' + (i + 1)),
        desc: o.description || '',
        quality: 'legendary',
        tag: force ? '结局' : '新达成'
      };
    });
    log((force ? '到达楼层上限' : '通关条件已达成') + ' → 弹结局面板（' +
        cards.length + ' 个可用结局' + (force ? '' : '，全部为新达成') + '）');
    bgm('ending');
    return e.openEventPanel('ending', {
      title: '深渊尽头',
      desc: '第 ' + s.floor + ' 层 · 选一个结局结束冒险，或继续战斗',
      cards: cards,
      actions: [{ id: 'stay', label: '继续战斗' }]
    });
  }

  function roomName(type) {
    var map = {
      enemy: '敌袭', elite: '精英战', mirror: '镜像', boss: 'BOSS',
      treasure: '宝箱', shop: '商店', rest: '休整点', event: '随机事件'
    };
    return map[type] || '房间';
  }

  /* ============================================================
     状态同步
     ============================================================ */
  function pushStats() {
    var e = engine(), s = S();
    if (!e || !s || typeof e.syncPlayer !== 'function') return false;
    try { e.syncPlayer(playerStats(s)); return true; } catch (err) { return false; }
  }

  function pushCursesEnv() {
    var e = engine(), s = S();
    if (!e || !s || typeof e.setCursesEnv !== 'function') return false;
    try { e.setCursesEnv(rtCurses(s), envPayload(s)); return true; } catch (err) { return false; }
  }

  function pushCursePool() {
    var e = engine();
    if (!e || typeof e.setCursePool !== 'function') return false;
    // ⚠️ 必须把 10 条全下发：引擎的诅咒池是**白名单**，表外的名字会被静默丢弃
    //    （风险 R9：不报错、不生效，最难查）。开局发一次，之后只改"当前生效"的那几条。
    try {
      e.setCursePool(CURSE_ALL.map(function (n) { return { name: n }; }));
      return true;
    } catch (err) { return false; }
  }

  /* ============================================================
     对外接口：主程序只调这四个
     ============================================================ */

  /**
   * render() 的接管入口
   * 返回 true 表示"这次 DOM 渲染由我处理，你别画了"。
   * ⚠️ 必须能在**未启动**时返回 false，否则选英雄/选增益界面会白屏。
   */
  function render() {
    if (!enabled() || unavailable) {
      // 回退：宿主可能已经把 state.mode 改成自己的标记、并被自动存档带走；
      // 内核不认识 'classic2d'，会把界面渲染成空白。这里还它一个内核认识的状态
      // （'event' 是内核的通用「房间进行中」态，玩家点「继续前进」即可回到正常流程）。
      var s0 = S();
      if (s0 && s0.mode === MODE_TAG) s0.mode = 'event';
      if (stageShown) showStage(false);   // 不接管了就别再盖着 DOM
      return false;
    }
    var s = S();
    if (!s) return false;
    // 旧存档带回来的 state.trial 是纯数据残留（试炼代码已删）——顺手清掉，
    // 免得它继续干扰判定；delete 失败也不影响（判定那边已经不看它了）。
    if (s.trial) { try { delete s.trial; } catch (e) { s.trial = undefined; } }
    if (!shouldTakeOver()) {
      // 不接管的每一帧都要把画布收起来：**选英雄 / 选增益、开始界面、死亡结算都归 DOM**。
      // 少这一句的后果是实测出来的 —— 一局打到一半重置存档回到选英雄，画布还盖在最上面，
      // 玩家看到的是一张"冻住的战斗画面"，DOM 的英雄按钮全被压在下面，点都点不到。
      // 只在确实开着时收（渲染调用很频繁，别每次都重排）。
      //
      // ⚠️ 还要把 mode 还给内核（兜底）：'classic2d' 是**宿主自己的标记**，
      //    内核完全不认识它。如果因为"不该接管"而就此 return，mode 会一直停在那儿，
      //    内核的渲染分支一个都不匹配 → **空白界面**，玩家既玩不了 2D 也看不到文字界面。
      //    实测触发路径：存档里的 hero 丢了（存档被写坏 / 旧档异常）→ shouldTakeOver 因
      //    'no-hero' 返回 false，而 mode 仍是 classic2d。
      //    选英雄 / 选增益 / 结算这些正常不接管的情形，mode 本来就是内核认识的，不受影响。
      if (s.mode === MODE_TAG) s.mode = s.gameOver ? 'gameover' : 'event';
      if (stageShown) showStage(false);
      return false;
    }
    if (!running) {
      if (!booting && !retryTimer) startRun(true);
      // 启动中也要吞掉本次渲染：否则会闪一帧回合制战斗界面
      return true;
    }
    // 难度下拉与真实难度对齐（N18）
    // ------------------------------------------------------------
    // 顶栏与侧边栏两个 select 的同步原本写在内核的 render() 里，而 2D 接管期间
    // 内核 render 根本不执行 —— 于是"存档难度是地狱、下拉却显示普通"，
    // 玩家照着显示去改，一改就把难度意外改成了别的档。这里以 state 为准补上。
    syncDifficultySelects(s);
    // 难度可能在局内被改（顶栏下拉，或侧边栏里那个共用同一逻辑的下拉）——
    // 变了就重新下发给引擎，否则"改了难度但新刷的敌人没变化"会被当成没生效（第 11 条）。
    // 放在这里而不是改内核：宿主本来就是"规则 → 引擎"的唯一翻译层。
    var sig = diffSignature(s);
    if (sig !== lastDiffSig) {
      // ⚠️ 用宽松判空：首次调用时 lastDiffSig 是 undefined（var 提升），
      //    严格比较 null 会让它误判成"难度变过"、白下发一次。
      if (lastDiffSig != null) {      // 第一帧只记录：开局时 startRun 已经下发过一遍
        pushEnemyScaler();
        pushPulseProfile();
        pushCursesEnv();
        // 场景主题也要跟着换：星雾 / 上升火星 / 雾色是按难度定的，
        // 只在 beginRun 里设过一次 —— 局内改难度不重设的话，
        // "进 2D 前选地狱有火星、局内改成地狱却毫无变化"（用户反馈）。
        var en = engine();
        if (en && typeof en.setDifficultyTheme === 'function') {
          try { en.setDifficultyTheme(realtimeDifficulty(s)); } catch (err) { /* 忽略 */ }
        }
        log('难度已变更，重新下发给引擎：', sig);
        try { kernel().showToast('难度已切换 · 新刷新的敌人按新难度计算'); } catch (err) { /* 忽略 */ }
      }
      lastDiffSig = sig;
    }
    showStage(true);
    return true;
  }

  /** 难度变更的轻量签名（render 每帧都会比对，别用 JSON.stringify） */
  var lastDiffSig = null;
  /** 上一次同步到两个下拉里的难度值（避免每帧碰 DOM） */
  var lastDiffUI = null;

  /**
   * 把真实难度同步到两个下拉（N18）
   * 只在值真的变了时写 DOM —— render 是每帧调用的。
   */
  function syncDifficultySelects(s) {
    var d = String((s && s.difficulty) || 'normal');
    if (d === lastDiffUI) return;
    lastDiffUI = d;
    ['difficultySelect', 'sidebarDifficultySelect'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.value !== d) el.value = d;
    });
  }

  function diffSignature(s) {
    var c = (s && s.customDifficulty) || {};
    return [s && s.difficulty, c.enemyHp, c.enemyAtk, c.enemyGrowthCurve, c.curseLevel,
      c.escalatingPressure, c.pulseScale, c.pulseAccel, c.floorCap, c.roomCount,
      c.environmentScale, c.glassCannon, c.oneHitKill].join('|');
  }

  /**
   * 动作接管：返回 true 表示已消费
   * 2D 模式下 DOM 的动作按钮都被画布盖住了，能点到的多是顶栏（图鉴/设置），
   * 那些应该继续交给内核 —— 所以默认返回 false 放行。
   */
  function handleAction(action) {
    if (!active()) return false;
    if (action === 'restart' || action === 'toggle-2d') return false;
    return false;
  }

  /** 新开一局（内核 resetCurrentSlot / initGame 之后调用） */
  function reset() {
    stop();
    // ⚠️ 不要清 booted / evBound：引擎实例并没有被销毁（引擎是全局单例），
    //    清了会让下次 startRun 重新走 init 并再绑一遍引擎事件 ——
    //    监听器翻倍，表现为"面板弹两次、存档写两遍"这类诡异现象。
    retryCount = 0;
    unavailable = false;
    lastError = null;
    lastDiffSig = null;   // 新一局：难度签名与下拉缓存都作废，下一帧重新对齐
    lastDiffUI = null;
    // 新一局：本局"已展示过的结局"归零，否则第二局打完层主不会再弹结局面板
    // （_endingShownIds 见 openEndingPanel）——只有**新开一局**才清，
    // 读档续玩要保留，不然同一局里会重复弹同一批结局。
    var s0 = S();
    if (s0) s0._endingShownIds = [];
    hideFallback();   // 降级提示不该跨局留存
  }

  /**
   * 没接管时，指出**到底是哪一条**不满足
   * 只回一个 false 的话，"回退文字模式"就没法定位 —— 实测用户反馈时，
   * 光看 debug() 的 takeOver:false 完全看不出是 hero 没了还是模式不对。
   */
  function takeOverReason() {
    var s = S();
    if (!enabled()) return 'disabled';
    if (unavailable) return 'engine-unavailable';
    if (!s) return 'no-state';
    if (!s.hero) return 'no-hero';
    if (s.gameOver) return 'gameOver=true';
    if (s.mode === 'heroSelect') return 'mode=heroSelect';
    if (s.mode === 'bonusSelect') return 'mode=bonusSelect';
    if (s.mode === 'start') return 'mode=start';
    if (s.mode === 'gameover') return 'mode=gameover';
    if (s.mode === 'finished') return 'mode=finished';
    if (!s.currentRoom) return 'currentRoom=null';
    if (running) return null;
    return 'ready-to-start';
  }

  function debug() {
    var e = engine();
    var d = null;
    try { d = (e && e.debug) ? e.debug() : null; } catch (err) { d = null; }
    return {
      enabled: enabled(),
      active: active(),
      floorLimit: floorLimit(S() || {}),
      booted: booted,
      running: running,
      booting: booting,
      unavailable: unavailable,
      retryCount: retryCount,
      lastError: lastError,
      engine: d,
      takeOver: shouldTakeOver(),
      takeOverReason: takeOverReason()   // null = 条件都满足（已在接管或可接管）
    };
  }

  global.经典2D = {
    render: render,
    handleAction: handleAction,
    active: active,
    reset: reset,
    stop: stop,
    start: function () { return startRun(false); },
    syncPoints: syncPoints,

    /** 遗物池 —— 内核图鉴直接读它，避免"图鉴手抄一份、迟早和实现漂移" */
    relicPool: function () {
      return RELIC_POOL.map(function (r) {
        return { id: r.id, label: r.label, quality: r.quality, desc: r.desc, school: r.school || '', schoolName: SCHOOL_NAME[r.school] || '' };
      });
    },
    /** 诅咒分级（轻 / 重）—— 同上，图鉴用它而不是自己再列一份 */
    curseTiers: function () {
      return { light: CURSE_LIGHT.slice(), heavy: CURSE_HEAVY.slice() };
    },

    /* ============================================================
       作弊面板 / 开发者命令用的实时战斗接口（P4）
       ------------------------------------------------------------
       写内核 state 之后统一 pushStats() / pushRelics() / pushCursesEnv()，
       保证画布上的数值立刻跟着变 —— 作弊面板最怕的就是"改了但看不出来"。
       ============================================================ */
    cheat: {
      snapshot: function () {
        var s = S(), d = null;
        try { d = engine() ? engine().debug() : null; } catch (e) { d = null; }
        return {
          hp: s && s.player ? Math.round(s.player.hp) : null,
          maxHp: s && s.player ? s.player.maxHp : null,
          shield: (d && d.hero) ? d.hero.shield : null,
          attack: s && s.player ? s.player.attack : null,
          floor: s ? s.floor : null,
          roomIndex: s ? s.roomIndex : null,
          roomCount: (s && s.rooms) ? s.rooms.length : null,
          relics: ((s && s.relics) || []).map(function (r) { return r && r.label; }),
          curses: s ? rtCurses(s) : [],
          god: (typeof engine().isGodMode === 'function') ? engine().isGodMode() : false
        };
      },
      setHp: function (v) {
        var s = S();
        if (!s || !s.player) return false;
        s.player.hp = Math.max(0, Math.min(s.player.maxHp || 999, Math.round(v)));
        pushStats();
        return s.player.hp;
      },
      setMaxHp: function (v) {
        var s = S();
        if (!s || !s.player) return false;
        var n = Math.max(1, Math.round(v));
        var diff = n - s.player.maxHp;
        s.player.maxHp = n;
        s.player.hp = Math.min(n, s.player.hp + Math.max(0, diff));
        pushStats();
        return n;
      },
      setShield: function (v) {
        var s = S();
        if (!s || !s.player) return false;
        s.player.shield = Math.max(0, Math.round(v));
        pushStats();
        return s.player.shield;
      },
      setAttack: function (v) {
        var s = S();
        if (!s || !s.player) return false;
        s.player.attack = Math.max(1, Math.round(v));
        pushStats();
        return s.player.attack;
      },
      /** 加遗物：接受英文 id 或中文名（面板上玩家更可能写中文） */
      addRelic: function (key) {
        if (!key) return false;
        var k = String(key).trim();
        var def = RELIC_BY_ID[k];
        if (!def) {
          for (var i = 0; i < RELIC_POOL.length; i++) {
            if (RELIC_POOL[i].label === k) { def = RELIC_POOL[i]; break; }
          }
        }
        if (!def) return false;
        return addRelic(def);
      },
      addCurse: function (name) {
        var s = S();
        var n = String(name || '').trim();
        if (!s || !n) return false;
        if (CURSE_ALL.indexOf(n) < 0) return false;   // 表外名字引擎会静默丢弃，这里先挡掉
        if (!s._rtCurses) s._rtCurses = [];
        if (s._rtCurses.indexOf(n) < 0) s._rtCurses.push(n);
        pushCursesEnv();
        return true;
      },
      clearCurses: function () {
        var s = S();
        if (!s) return false;
        s._rtCurses = [];
        pushCursesEnv();
        return true;
      },
      /** 跳层：副作用与 onFloor 完全一致（重生成房间 / 重掷环境 / 下发规划 / 重建地图） */
      gotoFloor: function (n) {
        var s = S(), k = kernel();
        if (!s || !k) return false;
        var floor = Math.max(1, Math.round(n));
        s.floor = floor;
        s.roomIndex = 0;
        s.rooms = k.generateFloorRooms(floor);
        s.environment = k.generateEnvironmentEffect(floor, s.difficulty);
        s.heroSkillUsed = false;
        s._riftDoneThisFloor = false;
        pushFloorPlan();
        rebuildEngineMap();
        pushPulseProfile();
        pushCursesEnv();
        k.addLog('（作弊）跳到第 ' + floor + ' 层。');
        return true;
      },
      /** 跳房：本层第 index 间 */
      gotoRoom: function (index) {
        var e = engine();
        if (!e || typeof e.gotoRoom !== 'function') return false;
        return e.gotoRoom(Math.max(0, Math.round(index)));
      },
      god: function (on) {
        var e = engine();
        if (!e || typeof e.setGodMode !== 'function') return false;
        return e.setGodMode(!!on);
      }
    },

    /**
     * 检查"通关条件"是否达成并弹结局面板（第 5 条）
     * 正式流程由 advanceToNextRoom 在打完**每一层层主**后自动调用；
     * 这里暴露出来是为了自动化回归与开发者命令能直接验结局分支。
     * @param force true = 强制把全部可用结局摆出来（楼层上限场合）
     */
    checkEnding: function (force) {
      var s = S();
      if (!s) return false;
      return openEndingPanel(force === true || s.floor >= floorLimit(s));
    },
    getFloorLimit: function () { return floorLimit(S() || {}); },
    pushStats: pushStats,
    pushRelics: pushRelics,
    pushFloorPlan: pushFloorPlan,
    debug: debug,
    setEnabled: function (on) {
      try { global.localStorage.setItem(DISABLE_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
      if (!on) stop();
      return enabled();
    }
  };

  /* ============================================================
     移动端横屏 / 全屏状态机（第 6 条 + 第 9 条）
     ------------------------------------------------------------
     只有一个目标状态变量 landscapeWanted：**只有真正在 2D 战斗画面上**才为 true。
     选英雄 / 选增益 / 死亡结算 / 结局 / 开始界面 / 降级后 / 切老版 一律 false（第 6 条）。
     旧代码把请求挂在「开始游戏」上，而那时可能先进选英雄界面 —— 并且 exitLandscape() 从无调用者。
     自愈（第 9 条）：状态变成"该横屏"时先试一次（微任务内发起），被拒就记 fsRetryPending，
     交给**下一次任意手势的捕获阶段**重发；fullscreenchange / visibilitychange 各自再补一次。
     老版（老版2.6/）走的是它自己那份 试炼程序.js，本节改动与它无关。
     ============================================================ */
  function isTouchDevice() {
    try { return ('ontouchstart' in global) || (navigator.maxTouchPoints > 0); } catch (e) { return false; }
  }

  /**
   * 是否苹果移动端（iPhone / iPad / iPod）
   * ------------------------------------------------------------
   * iPadOS 13+ 的 UA 会伪装成 Mac，所以只看 UA 会把 iPad 漏掉，
   * 用「MacIntel + 多指触摸」这条组合特征补上（桌面 Mac 的 maxTouchPoints 是 0）。
   * 与 战斗2D.js / 试炼程序.js 里各自的同名函数同源同写法 —— 三处都是独立 IIFE，
   * 拿不到彼此的私有函数，所以各留一份；改判定条件时三处要一起改。
   *
   * 用途只有一个：**提示条文案分档**。苹果设备上"自动横屏"从 API 层面就不存在
   * （iPhone 没有元素全屏，于是要求先全屏的 orientation.lock 也用不了），
   * 文案必须说"做不到"而不是"建议"，否则玩家会以为游戏偷懒不做。
   */
  function isAppleTouch() {
    try {
      var ua = navigator.userAgent || '';
      if (/iPad|iPhone|iPod/.test(ua)) return true;
      if (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1) return true;
      return false;
    } catch (e) { return false; }
  }

  function lockOrientation() {
    try {
      var so = global.screen && global.screen.orientation;
      if (so && typeof so.lock === 'function') {
        var p = so.lock('landscape');
        if (p && p.catch) p.catch(function () { /* 不支持（iOS）：静默兜底 */ });
      }
    } catch (e) { /* 忽略 */ }
  }

  /* 目标状态：该不该锁着横屏 + 全屏（只有真正在 2D 战斗画面上才为 true） */
  var landscapeWanted = false;
  /* 全屏被系统顶掉 / 请求被拒 → 等下一次用户手势补回来（第 9 条的自愈核心） */
  var fsRetryPending = false;

  /* 玩家点过提示条上的"知道了"：**本局内**不再弹。
     ⚠️ 刻意**不落 localStorage**（对比 DISABLE_KEY 那种跨会话开关）：
        写进存储就会变成"点过一次就永远看不到提示"，换设备 / 清了数据 / 换个浏览器
        访问更是彻底见不到 —— 而这条提示恰好在"自动横屏失败"时才是玩家唯一的说明。
        所以它每次进 2D 都重置一次（见 showStage 里的复位）。 */
  var rotateHintDismissed = false;
  /* 提示条按钮只绑一次（showStage 每帧都会走到，别重复挂监听） */
  var rotateHintBound = false;
  /* iOS 转屏时 resize 偶尔比新尺寸先到 → 延迟复查一次提示条（见 onViewportChange） */
  var hintRecheckTimer = null;

  /**
   * 发起「全屏 + 锁横屏」
   * @param force true = 不看 landscapeWanted（调用方保证时机合适，即用户手势内）
   */
  function ensureLandscape(force) {
    if (!force && !landscapeWanted) return false;
    if (!isTouchDevice()) return false;
    try {
      var el = document.documentElement;
      if (el.requestFullscreen && !document.fullscreenElement) {
        var p = el.requestFullscreen({ navigationUI: 'hide' });
        if (p && p.then) {
          p.then(function () { fsRetryPending = false; lockOrientation(); },
                 function () { fsRetryPending = true; lockOrientation(); });
        } else { fsRetryPending = false; lockOrientation(); }
      } else {
        fsRetryPending = false;
        lockOrientation();
      }
      return true;
    } catch (e) {
      fsRetryPending = true;
      lockOrientation();
      return false;
    }
  }

  /**
   * 目标状态对齐（由 showStage 调用 —— 它本来就是画布显隐的唯一入口）
   * 只在状态**变化**时动手；没变时只检查"该全屏却没全屏"，记一个待补标记。
   */
  function syncLandscape(active) {
    var want = !!active;
    if (want === landscapeWanted) {
      if (want && !document.fullscreenElement) fsRetryPending = true;
      return;
    }
    landscapeWanted = want;
    if (want) {
      // 两次机会：① 当前调用栈（render 有时正好还在手势链里）
      //           ② 微任务（仍在用户激活窗口内，点"增益"进 2D 的那一下走这条）
      ensureLandscape(true);
      try {
        Promise.resolve().then(function () {
          if (landscapeWanted && !document.fullscreenElement) ensureLandscape(true);
        });
      } catch (e) { /* 没有 Promise 的环境：上面那次已经尽力 */ }
    } else {
      exitLandscape();
    }
  }

  function exitLandscape() {
    landscapeWanted = false;
    fsRetryPending = false;
    try {
      var so = global.screen && global.screen.orientation;
      if (so && typeof so.unlock === 'function') so.unlock();
    } catch (e) { /* 忽略 */ }
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        var p = document.exitFullscreen();
        if (p && p.catch) p.catch(function () { /* 忽略 */ });
      }
    } catch (e) { /* 忽略 */ }
    updateRotateHint();
  }

  /**
   * 提示条上的「知道了」：只绑一次
   * ------------------------------------------------------------
   * 这段绑定原本在 试炼程序.js 的 _bindRotateHint() 里，而该脚本已随试炼关停整体下线
   * （主界面.html 现在只加载 主程序.js，2D 四件套按需加载），绑定**没有迁移过来** ——
   * 后果是提示条一旦出现就点不掉（实测：点"知道了"纹丝不动，只能等它被别的事件收走）。
   * 放在 showStage(show=true) 时调用而不是脚本顶层：那时按钮一定已经在 DOM 里。
   */
  function bindRotateHint() {
    if (rotateHintBound) return;
    rotateHintBound = true;
    var close = document.getElementById('trial2DRotateClose');
    if (!close) return;
    close.addEventListener('click', function () {
      rotateHintDismissed = true;
      var el = document.getElementById('trial2DRotateHint');
      if (el) el.classList.add('hidden');
    });
  }

  /**
   * 竖屏兜底提示条：仅「画布真的在眼前 + 触摸设备 + 竖屏 + 本局没点过知道了」时显示
   * ------------------------------------------------------------
   * 幂等：重复调用只是把 class 与文案对齐到当前状态，可以随便多调
   * （进 2D / 转屏 / 切回前台 / 全屏变化都会经过它）。
   *
   * 显示条件里的 stageShown 不是多余的：只看 running 会漏一种情况 —— 画布已经收起、
   * 而 running 还挂着 true（例如局内读档回到了选英雄：render() 走 !shouldTakeOver()
   * 分支把画布收掉，但 running 要等引擎回调才会变 false）。
   * 那一刻提示条会留在**文字界面**上，玩家在选英雄页面看到"请旋转手机"只能一脸问号。
   */
  function updateRotateHint() {
    var el = document.getElementById('trial2DRotateHint');
    if (!el) return;
    var portrait = false;
    try { portrait = global.innerHeight > global.innerWidth; } catch (e) { portrait = false; }

    var show = running && stageShown && isTouchDevice() && portrait && !rotateHintDismissed;
    el.classList.toggle('hidden', !show);
    if (!show) return;

    /* 文案按设备分档。
       原来这段文案**写死在 HTML 里**，苹果玩家看到的是"建议旋转手机"—— 而苹果上
       "自动横屏"从 API 层面就做不到（iPhone 没有元素全屏 → 要求先全屏的
       orientation.lock 也用不上），说"建议"等于把技术限制说成了游戏偷懒。
       非苹果设备保持原文案：那边确实只是"建议"，不该跟着改成"做不到"。 */
    var txt = el.querySelector('.trial2d-rotate-text');
    if (txt) {
      txt.textContent = isAppleTouch()
        ? '本机无法自动横屏，请手动旋转手机'
        : '横屏视野更开阔，建议旋转手机';
    }
  }

  /**
   * 视口变化：画布是全屏钉死的，得跟着重算（旋转屏幕 / 地址栏收缩 / 分屏）
   * ------------------------------------------------------------
   * 这是**画布尺寸变化的唯一来源** —— showStage 已经不再每帧 refresh 了
   * （那个每帧 refresh 是"画面像网卡"的根因，实测 120 次 render 触发 130 次 resize）。
   * 同时挂 window.resize 与 visualViewport.resize：移动端地址栏收缩时
   * 有些浏览器只发后者，只挂前者会留下"底部按钮被地址栏压住"的旧毛病。
   */
  function onViewportChange() {
    if (!running) return;
    var stage = document.getElementById('trial2DStage');
    if (!stage || !stage.style.height) return;
    updateVh();
    var h = viewportHeight();
    if (h > 0) {
      var px = Math.round(h) + 'px';
      if (stage.style.height !== px) stage.style.height = px;
    }
    // 旋转屏幕 / 地址栏收缩后全屏可能已经被系统顶掉：标一个待补，等下一次手势（第 9 条）
    if (landscapeWanted && !document.fullscreenElement) fsRetryPending = true;
    updateRotateHint();
    /* iOS 转屏时 resize 偶尔比新尺寸先到（这一刻读到的 innerWidth/innerHeight 还是旧值）——
       250ms 后再对齐提示条一次，免得它卡在错的状态上、之后没有任何事件来纠正
       （"手动转屏 → 提示条自动收起/出现"是必须走对的一条路径）。
       连续 resize 只保留最后一次定时器，开销可忽略。 */
    try {
      if (hintRecheckTimer) clearTimeout(hintRecheckTimer);
      hintRecheckTimer = setTimeout(function () { hintRecheckTimer = null; updateRotateHint(); }, 250);
    } catch (e) { /* 忽略 */ }
    refreshStageScale();
  }

  try { global.addEventListener('resize', onViewportChange); } catch (e) { /* 忽略 */ }
  try {
    if (global.visualViewport && global.visualViewport.addEventListener) {
      global.visualViewport.addEventListener('resize', onViewportChange);
    }
  } catch (e) { /* 忽略 */ }

  /* 手势自愈（第 9 条）
     ------------------------------------------------------------
     原来只在「开始游戏」按钮上请求一次全屏，被拒 / 被系统顶掉就再也没有第二次机会。
     现在改成：**任何手势**的捕获阶段都检查一次"该横屏却没横屏"，
     是就借这次用户激活重发。捕获阶段而不是冒泡 —— 内核的按钮处理器可能 stopPropagation。
     只在真有需要时才动手（landscapeWanted 且未全屏），平时零开销。 */
  try {
    var gestureRelock = function () {
      if (!landscapeWanted) return;
      if (document.fullscreenElement && !fsRetryPending) return;
      ensureLandscape(true);
    };
    document.addEventListener('pointerdown', gestureRelock, true);
    document.addEventListener('click', gestureRelock, true);
    document.addEventListener('touchend', gestureRelock, true);
  } catch (e) { /* 忽略 */ }

  /* 全屏状态变化：被系统弹窗 / 切后台 / 用户按 Esc 顶掉时，
     标记"待补"，交给下一次手势；重新拿到全屏时顺手把方向锁补上。 */
  try {
    document.addEventListener('fullscreenchange', function () {
      if (!landscapeWanted) { updateRotateHint(); return; }
      if (!document.fullscreenElement) {
        fsRetryPending = true;
      } else {
        fsRetryPending = false;
        lockOrientation();
      }
      updateRotateHint();
    });
  } catch (e) { /* 忽略 */ }

  /* 切回前台：先直接补一次（部分浏览器允许），补不上就落到 pending 等手势 */
  try {
    document.addEventListener('visibilitychange', function () {
      if (!landscapeWanted || document.hidden) return;
      ensureLandscape(true);
      updateRotateHint();
      try {
        var e2 = engine();
        var g2 = (e2 && e2.getGame) ? e2.getGame() : null;
        if (g2 && g2.scale && g2.scale.refresh) g2.scale.refresh();
      } catch (err) { /* 忽略 */ }
    });
  } catch (e) { /* 忽略 */ }

  /* Esc = 菜单开关（与 HUD 的「菜单」按钮走同一个入口，行为一致）
     ------------------------------------------------------------
     再按一次要能关掉：Esc 在任何一个界面里都是"退回去"，只开不关的话
     玩家按 Esc 之后还得去找按钮，键盘操作就成了半截。
     ⚠️ 只对**画布菜单**做这件事：商店 / 图鉴 / 地图 / 撤离确认这些画内面板
        各有自己的关闭语义（有的要确认、有的要读档），在这里替它们做决定
        会把"取消"变成"误关"。 */
  try {
    document.addEventListener('keydown', function (ev) {
      if (!running) return;
      if (ev.key !== 'Escape' && ev.key !== 'Esc') return;
      var en = engine();
      if (!en || typeof en.openPauseMenu !== 'function') return;
      if (typeof en.isPaused === 'function' && en.isPaused()) {
        if (typeof en.closePauseMenu === 'function' && en.closePauseMenu()) ev.preventDefault();
        return;
      }
      if (en.openPauseMenu()) ev.preventDefault();
    });
  } catch (e) { /* 忽略 */ }

  log('宿主已就绪（等待 render 接管）');
})(window);
