/* P0：把「画布按 DPR 渲染」的正确接法写进 战斗2D.js
 *
 * 背景（实测得到，不是推测）：
 *   第一版只把 canvas.width 放大到物理像素，结果 DPR≥2 时整屏发黑。
 *   逐帧插桩读 gl.VIEWPORT 后确认，Phaser 的 WebGL 管线里
 *     renderer.width/height 同时决定【GL 视口】与【投影矩阵】，
 *   而世界坐标是逻辑坐标 —— 三者只能这样配：
 *     canvas 物理 = 逻辑×DPR、renderer = 物理、投影 = 逻辑、viewport = 物理
 *   但 renderer.width 一变，Phaser 内部拿它算的裁剪/遮罩/渲染目标
 *   又会与逻辑尺寸打架，于是改为更彻底的一条路：
 *     **让 Phaser 整条管线都在物理像素空间工作**（updateScale 输出物理尺寸），
 *     再只对游戏代码暴露逻辑口径（scale.width / scale.height）。
 *   这样 Phaser 内部完全自洽，游戏侧的 40 处布局代码一行都不用改。
 */
const fs = require('fs');
const path = 'D:\\深渊回廊\\战斗2D.js';
let s = fs.readFileSync(path, 'utf8');
const eol = s.includes('\r\n') ? '\r\n' : '\n';

const START = '  /** 当前该用的设备像素比（1 ~ 3）。取不到就当 1 */';
const END = '  /**\n   * 只读设备诊断（真机排查用）';
// 统一按 \n 处理再还原，避免 CRLF 干扰定位
const norm = s.replace(/\r\n/g, '\n');
const a = norm.indexOf(START);
const b = norm.indexOf(END);
if (a < 0) { console.log('!! 找不到起点'); process.exit(1); }
if (b < 0 || b <= a) { console.log('!! 找不到终点'); process.exit(1); }
console.log('替换区间：' + norm.slice(0, a).split('\n').length + ' 行 → ' + norm.slice(0, b).split('\n').length + ' 行');

const block = `  /** 当前该用的设备像素比（1 ~ 3）。取不到就当 1 */
  function deviceDpr() {
    var d = 1;
    try {
      if (typeof global.devicePixelRatio === 'number' && global.devicePixelRatio > 0) {
        d = global.devicePixelRatio;
      }
    } catch (e) { /* 忽略 */ }
    return Math.max(1, Math.min(3, d));
  }

  /**
   * 让画布按**设备像素比**渲染（高 DPI 屏幕上整屏发糊的根因）
   * ============================================================
   * 用户反馈："手机上整个战斗画面轻微发糊，文字边缘不锐利"，PC 上正常。
   *
   * 根因：Phaser 3 的 ScaleManager 是**按 CSS 像素**写 canvas.width 的 ——
   * 整个 vendor/phaser.min.js 里 devicePixelRatio 只出现 1 次（Device 模块存了个
   * pixelRatio 字段，没有任何地方读它）。Phaser 3 也**没有** Phaser 2 那个
   * resolution 配置项（ScaleManager.parseConfig 读的是 width / height / zoom /
   * mode / autoRound / autoCenter / min / max / snap，没有 resolution），
   * 所以"给 new Phaser.Game 传 resolution"是无效的。
   * 于是 DPR=2 的手机上：画布物理 390×844、CSS 也写 390×844，浏览器只好把这块
   * 位图拉成 780×1688 个物理像素去显示 —— 每个画出来的像素被放大成 2×2。
   * 更糟的是 renderConfig 里 antialias:false 会让 Phaser 给画布写上
   * \`image-rendering: pixelated\`（setCrisp 那一步），放大用的是**最近邻**插值，
   * 于是不是"发虚"而是"发块"，这正是"放大变马赛克"的来源。
   *
   * ------------------------------------------------------------
   * 接法（⚠️ 这里有一条踩过的坑，别改回去）
   * ------------------------------------------------------------
   * 只把 canvas.width 放大到物理像素是**不够**的：Phaser 的 WebGL 管线里
   * renderer.width / height 同时决定两件事 —— GL 的视口尺寸**和**投影矩阵。
   * 只放大 canvas 而不管 renderer，gl.viewport 会停在逻辑尺寸，画面只画进
   * 物理缓冲的左下一块，其余全黑（DPR≥2 的机器上就是整屏黑）。
   *
   * 而把投影矩阵也一起换成物理尺寸同样不行 —— 世界坐标本身是逻辑坐标
   * （关卡按 scale.width 铺的），投影一换，画面就整体放大一倍。
   *
   * 所以这里走的是更彻底的一条路：**让 Phaser 整条管线都工作在物理像素空间**，
   * 只把「逻辑口径」留给游戏代码：
   *   · scale.gameSize / baseSize / displaySize / canvas.width → 物理尺寸
   *     （由此 renderer、投影、视口、裁剪、遮罩、渲染目标全部自洽）
   *   · scale.width / scale.height → 逻辑尺寸
   *     （40 处布局代码、uiHitTest、命中矩形、onResize 全都吃这两个值，
   *      一行都不用改）
   * 两者相差一个 deviceDpr()，而 deviceDpr() === 1 时它们完全相等，
   * 所以 PC（DPR=1）上这次改动是**零行为差异**。
   *
   * 逻辑口径只在 applyDprResolution 里按当前 DPR 现算，因为它必须跟着
   * DPR 变化走（跨屏拖窗口、系统缩放改变、手机浏览器缩放）。
   */
  function applyDprResolution() {
    var game = state.game;
    if (!game || !game.canvas || !game.scale || !game.renderer) return false;
    if (state._dprBusy) return false;              // updateScale 里会再进一次，防重入
    state._dprBusy = true;
    try {
      var sc = game.scale, r = game.renderer, canvas = game.canvas;
      var dpr = deviceDpr();

      // 逻辑尺寸的源头是父容器（#trial2DCanvasHost）的 CSS 尺寸。
      // 这里刻意**不读 scale.width** —— 那个值已经被上一轮改写成逻辑口径，
      // 用它当输入会把「上一轮的逻辑值 × 新 DPR」越乘越大。
      var logicalW = Math.max(1, Math.round(sc.parentSize.width ||
        (canvas.parentNode && canvas.parentNode.clientWidth) || 0));
      var logicalH = Math.max(1, Math.round(sc.parentSize.height ||
        (canvas.parentNode && canvas.parentNode.clientHeight) || 0));
      // 画布尚不可见（舞台被 .hidden 收起）时父容器是 0，别在这里做任何事
      if (logicalW < 40 || logicalH < 40) return false;

      // 物理像素上限：iOS 的单张画布有硬上限，超了整个画布会变白屏。
      // 高 DPR 的大屏上主动退一档（宁可稍糊也不能白屏）。1920×1016 的桌面上
      // DPR=3 就会撞到这个上限，实测正是退到 2.5 生效。
      var MAX_PIXELS = 16777216;                   // 4096×4096
      while (dpr > 1 && logicalW * dpr * logicalH * dpr > MAX_PIXELS) dpr -= 0.5;
      if (dpr < 1) dpr = 1;

      var physW = Math.max(1, Math.round(logicalW * dpr));
      var physH = Math.max(1, Math.round(logicalH * dpr));

      // 1) 逻辑口径：游戏代码读 scale.width / height 拿到的就是这两个值
      sc._dprW = logicalW;
      sc._dprH = logicalH;
      sc._dpr = dpr;
      if (!sc._dprLogicalWidth) {
        sc._dprLogicalWidth = true;
        Object.defineProperty(sc, 'width', {
          configurable: true, get: function () { return sc._dprW || 0; }
        });
        Object.defineProperty(sc, 'height', {
          configurable: true, get: function () { return sc._dprH || 0; }
        });
      }

      // 2) 物理口径：先把尺寸摆正（scale.resize 是公开 API，会自动走
      //    updateScale → refresh，把 gameSize / baseSize / displaySize
      //    与 canvas.width 一起推到物理尺寸）
      if (canvas.width !== physW || canvas.height !== physH) {
        canvas.width = physW;
        canvas.height = physH;
        try { sc.resize(physW, physH); } catch (e) { /* 老版本没有这个入口：忽略 */ }
      }

      // 3) CSS 显示尺寸钉回**逻辑**尺寸，这样浏览器拿到的物理像素正好是
      //    逻辑像素 × DPR，1:1 映射，不再有放大。
      //    ⚠️ 必须 !important：主样式.css 里有
      //       \`.trial-screen.realtime-mode .trial2d-canvas-host canvas { width:100%!important }\`
      //       那条会按容器大小拉伸画布；内联 style 压不过 !important，
      //       所以插一张规则更靠后的表。
      if (!state._dprStyle) {
        state._dprStyle = document.createElement('style');
        state._dprStyle.id = 'trial2d-canvas-dpr';
        (document.head || document.documentElement).appendChild(state._dprStyle);
      }
      var css = '#trial2DCanvasHost canvas{width:' + logicalW +
        'px !important;height:' + logicalH + 'px !important;max-width:none !important;}';
      if (state._dprStyle.textContent !== css) state._dprStyle.textContent = css;

      // 4) 渲染器兜底对齐。scale.resize 已经把这些算过一遍了，这里是
      //    防「阶段尺寸还没生效」的保险，幂等、无害。
      r.width = physW;
      r.height = physH;
      r.setProjectionMatrix(logicalW, logicalH);   // 世界坐标是逻辑坐标，投影必须跟着它
      try {
        if (r.gl) r.gl.viewport(0, 0, physW, physH);
        else if (r.currentContext) r.currentContext.setTransform(1, 0, 0, 1, 0, 0);
      } catch (e) { /* 忽略 */ }
      r.drawingBufferHeight = physH;
      if (r.defaultScissor) { r.defaultScissor[2] = logicalW; r.defaultScissor[3] = logicalH; }
      // 遮罩缓冲按逻辑尺寸重建：尺寸不一致时遮罩边缘会被硬件过滤放大
      if (r.maskTarget && r.maskTarget.resize && !state._dprMaskResized) {
        state._dprMaskResized = true;
        try { r.maskTarget.resize(logicalW, logicalH); } catch (e) { /* 忽略 */ }
      }

      state._dprInfo = {
        dpr: dpr, physical: physW + '×' + physH, logical: logicalW + '×' + logicalH,
        limited: dpr !== deviceDpr()
      };
      return true;
    } catch (e) {
      console.warn('[战斗2D] DPR 缩放失败（画面会退回按 CSS 像素渲染）：', e);
      return false;
    } finally {
      state._dprBusy = false;
    }
  }

  /**
   * 挂 DPR 同步
   * ------------------------------------------------------------
   * 两件事：
   *   ① 把 ScaleManager.updateScale 换成输出**物理尺寸**的版本。
   *      原来那一版（RESIZE 模式）是 displaySize / gameSize / baseSize /
   *      canvas.width 全写 parentSize —— 一个纯 CSS 像素的实现，没有 DPR 概念。
   *      这里只把输出乘上 deviceDpr()，其余逻辑一字不动。
   *   ② 监听 RESIZE 与 DPR 变化，把逻辑口径与 CSS 尺寸重新算一遍。
   *
   * ⚠️ 为什么必须连 updateScale 一起换：只改 canvas.width 的话，
   * 下一次 refresh()（窗口缩放 / 旋屏 / 从后台回来 / 地址栏收起）就会用
   * parentSize 把它写回 CSS 像素，画面又开始糊 —— 而且不会有任何报错。
   */
  function installDprResolution(game) {
    if (!game || !game.scale || state._dprHooked) return;
    state._dprHooked = true;
    var sc = game.scale;

    sc.updateScale = function () {
      var ds = deviceDpr();
      var pw = Math.max(1, Math.round(this.parentSize.width * ds));
      var ph = Math.max(1, Math.round(this.parentSize.height * ds));
      this.displaySize.setSize(pw, ph);
      this.gameSize.setSize(pw, ph);
      this.baseSize.setSize(pw, ph);
      this.canvas.width = pw;
      this.canvas.height = ph;
    };

    // RESIZE 在 refresh() 里是「updateScale → updateBounds → displayScale →
    // emit(RESIZE)」的最后一步，所以挂在这里时画布尺寸已经就位。
    sc.on('resize', function () { applyDprResolution(); });

    // DPR 变化：matchMedia 的 resolution 查询只在 DPR 真的变了时触发。
    // 每次变化后都要重新挂（查询串里的 dppx 是写死的当前值）。
    var attach = function () {
      try {
        if (!global.matchMedia) return;
        var mq = global.matchMedia('(resolution: ' + deviceDpr() + 'dppx)');
        var onChange = function () {
          try { sc.refresh(); } catch (e) { applyDprResolution(); }
          attach();
        };
        if (mq && mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq && mq.addListener) mq.addListener(onChange);
      } catch (e) { /* 不支持 matchMedia 的设备：窗口 resize 那条路仍在 */ }
    };
    attach();
  }

`;
const out = norm.slice(0, a) + block + norm.slice(b);
fs.writeFileSync(path, eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out, 'utf8');
console.log('ok 已写入，新长度 ' + out.length);
