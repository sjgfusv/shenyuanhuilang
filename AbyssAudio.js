// ============================================================
// 深渊回廊 —— 音频引擎（AbyssAudio.js）
// ------------------------------------------------------------
// 纯 Web Audio API 程序化合成，不依赖任何音频文件 / 网络：
// 1. 音效（SFX）：攻击、暴击、闪避、受伤、格挡、治疗、金币……
//    全部由振荡器 + 噪声实时合成。
// 2. 背景音乐（BGM）：程序化生成的暗黑地牢氛围乐，
//    分为 menu（开始/选英雄）、explore（探索）、
//    battle（战斗）、boss（Boss 战）四个场景，自动切换。
// 3. 设置集成：读取 abyss_settings 中的 bgm / sfx 开关。
// 4. 自动播放策略：首次用户手势（点击/按键）时解锁 AudioContext。
//
// 全局接口：window.AbyssAudio
//   .unlock()              首次手势时调用，解锁并开始 BGM
//   .sfx(name)             播放指定音效
//   .setScene(scene)       切换 BGM 场景 'menu'|'explore'|'battle'|'boss'|'elite'|'mirror'|'shop'|'rest'|'ending'
//   .syncScene(state)      根据游戏 state.mode 自动映射 BGM 场景
//   .applySettings(s)      应用 { bgm: bool, sfx: bool } 设置
// ============================================================

const AbyssAudio = (function () {
    'use strict';

    // ------------------------------------------------------------
    // 内部状态
    // ------------------------------------------------------------
    let ctx = null;          // AudioContext（首次手势时创建）
    let master = null;       // 总线
    let sfxBus = null;       // 音效总线
    let bgmBus = null;       // 音乐总线
    let delayNode = null;    // BGM 回声（地牢空间感）
    let noiseBuf = null;     // 共享白噪声缓冲
    let unlocked = false;    // 是否已解锁
    let settings = { bgm: true, sfx: true, bgmVolume: 100, sfxVolume: 100 };

    // 音量工具（设置范围 1~200，100 = 原始默认增益）
    const clampVolume = (v) => Math.max(1, Math.min(200, Math.round(Number(v) || 100)));
    const bgmTargetGain = () => settings.bgmVolume / 100 * 0.45;
    const sfxTargetGain = () => settings.sfxVolume / 100 * 0.85;

    // BGM 调度器状态
    let scene = 'menu';          // 当前场景
    let scheduledScene = null;   // 已排入调度的场景（延迟到小节边界生效）
    let bgmTimer = null;         // 调度定时器
    let step = 0;                // 全局步进计数（8 分音符）
    let nextStepTime = 0;        // 下一步的时间戳
    let chordIndex = 0;          // 和弦进行索引
    let bgmRunning = false;
    let bgmPending = new Set();  // 已排入时间线的 BGM 音符（场景切换时用于取消未起播音符）
    const LOOKAHEAD = 1.5;       // 预排时长（秒），标签页切后台也不会断
    const TICK_MS = 300;         // 调度间隔

    // ------------------------------------------------------------
    // 基础工具
    // ------------------------------------------------------------
    const m2f = (m) => 440 * Math.pow(2, (m - 69) / 12); // MIDI → 频率

    function makeNoiseBuffer() {
        const len = ctx.sampleRate; // 1 秒
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        return buf;
    }

    function initGraph() {
        master = ctx.createGain();
        master.gain.value = 0.9;
        const comp = ctx.createDynamicsCompressor(); // 防止多音效叠加爆音
        comp.threshold.value = -14;
        comp.ratio.value = 6;
        master.connect(comp);
        comp.connect(ctx.destination);

        sfxBus = ctx.createGain();
        sfxBus.gain.value = sfxTargetGain();
        sfxBus.connect(master);

        bgmBus = ctx.createGain();
        bgmBus.gain.value = bgmTargetGain();
        bgmBus.connect(master);

        // 地牢回声：干声走 bgmBus，湿声在总线之后再汇入（受 BGM 开关控制）
        delayNode = ctx.createDelay(1.0);
        delayNode.delayTime.value = 0.36;
        const fb = ctx.createGain();
        fb.gain.value = 0.32;
        const wet = ctx.createGain();
        wet.gain.value = 0.22;
        bgmBus.connect(delayNode);
        delayNode.connect(fb);
        fb.connect(delayNode);
        delayNode.connect(wet);
        wet.connect(master);

        noiseBuf = makeNoiseBuffer();
    }

    // ------------------------------------------------------------
    // 音色构建器：按配方在 time 起播一个声部
    // 配方字段：w 波形 | f0/f1 频率滑动 | t 时长 | g 音量 |
    //           a 起音 | d 延迟起播 | flt {type,f0,f1,q} 滤波扫频
    // ------------------------------------------------------------
    function playVoice(v, time, bus) {
        const t0 = time + (v.d || 0);
        const dur = v.t || 0.2;
        const g = ctx.createGain();
        const peak = v.g != null ? v.g : 0.2;
        const atk = v.a != null ? v.a : 0.005;

        let src;
        if (v.w === 'noise') {
            src = ctx.createBufferSource();
            src.buffer = noiseBuf;
            src.loop = true;
        } else {
            src = ctx.createOscillator();
            src.type = v.w || 'sine';
            const f0 = v.f0 != null ? v.f0 : v.f;
            if (f0 != null) src.frequency.setValueAtTime(f0, t0);
            if (v.f1 != null && v.f1 !== f0) {
                src.frequency.exponentialRampToValueAtTime(Math.max(20, v.f1), t0 + dur);
            }
        }

        let node = src;
        if (v.flt) {
            const flt = ctx.createBiquadFilter();
            flt.type = v.flt.type || 'lowpass';
            flt.Q.value = v.flt.q != null ? v.flt.q : 0.8;
            const ff0 = v.flt.f0 != null ? v.flt.f0 : 1000;
            flt.frequency.setValueAtTime(ff0, t0);
            if (v.flt.f1 != null && v.flt.f1 !== ff0) {
                flt.frequency.exponentialRampToValueAtTime(Math.max(20, v.flt.f1), t0 + dur);
            }
            node.connect(flt);
            node = flt;
        }

        node.connect(g);
        g.connect(bus);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

        src.start(t0);
        src.stop(t0 + dur + 0.05);
        // 追踪 BGM 音符，场景立即切换时可取消尚未起播的旧音符
        if (bus === bgmBus) {
            const entry = { src, t0 };
            bgmPending.add(entry);
            src.onended = () => bgmPending.delete(entry);
        }
        return src;
    }

    // ------------------------------------------------------------
    // 音效配方表（全部实时合成）
    // ------------------------------------------------------------
    const SFX = {
        // UI 点击：机械键盘（青轴风格，噪声咔哒瞬态 + 高频腔体共鸣）
        click: [
            { w: 'noise', t: 0.02, g: 0.22, flt: { type: 'bandpass', f0: 3200, f1: 2600, q: 2 } },
            { w: 'triangle', f0: 1900, f1: 1400, t: 0.03, g: 0.12 },
        ],
        // 玩家攻击：破空声 + 低频冲击
        attack: [
            { w: 'noise', t: 0.1, g: 0.22, flt: { type: 'bandpass', f0: 900, f1: 260, q: 1.2 } },
            { w: 'sine', f0: 165, f1: 55, t: 0.12, g: 0.5 },
        ],
        // 暴击：更重的冲击 + 金属锐鸣
        crit: [
            { w: 'noise', t: 0.15, g: 0.28, flt: { type: 'bandpass', f0: 1500, f1: 300, q: 1 } },
            { w: 'sine', f0: 210, f1: 42, t: 0.22, g: 0.65 },
            { w: 'square', f0: 1900, f1: 1600, t: 0.16, g: 0.09, flt: { type: 'lowpass', f0: 3200 } },
        ],
        // 闪避：气流上扫
        dodge: [
            { w: 'noise', t: 0.2, g: 0.15, flt: { type: 'bandpass', f0: 480, f1: 2500, q: 2.5 } },
        ],
        // 玩家受伤：沉闷重击
        hurt: [
            { w: 'sawtooth', f0: 215, f1: 68, t: 0.18, g: 0.35, flt: { type: 'lowpass', f0: 950, f1: 220 } },
            { w: 'noise', t: 0.08, g: 0.26, flt: { type: 'lowpass', f0: 700 } },
        ],
        // 格挡/护盾：金属铿锵
        block: [
            { w: 'triangle', f0: 930, f1: 890, t: 0.15, g: 0.28 },
            { w: 'triangle', f0: 1395, f1: 1330, t: 0.1, g: 0.18 },
            { w: 'noise', t: 0.03, g: 0.12, flt: { type: 'highpass', f0: 3200 } },
        ],
        // 治疗：柔和上行琶音
        heal: [
            { w: 'sine', f: 523.3, d: 0, t: 0.35, g: 0.16 },
            { w: 'sine', f: 659.3, d: 0.09, t: 0.35, g: 0.16 },
            { w: 'sine', f: 784, d: 0.18, t: 0.42, g: 0.16 },
        ],
        // 喝药水：咕嘟两声
        potion: [
            { w: 'sine', f0: 330, f1: 540, d: 0, t: 0.08, g: 0.25 },
            { w: 'sine', f0: 430, f1: 660, d: 0.1, t: 0.08, g: 0.25 },
            { w: 'sine', f0: 300, f1: 230, d: 0.2, t: 0.1, g: 0.2 },
        ],
        // 金币：经典双音
        coin: [
            { w: 'square', f: 987.8, d: 0, t: 0.06, g: 0.13 },
            { w: 'square', f: 1318.5, d: 0.06, t: 0.22, g: 0.13 },
        ],
        // 购买：金币 + 收银钝响
        buy: [
            { w: 'square', f: 987.8, d: 0, t: 0.06, g: 0.12 },
            { w: 'square', f: 1318.5, d: 0.06, t: 0.18, g: 0.12 },
            { w: 'sine', f0: 190, f1: 120, d: 0.03, t: 0.12, g: 0.3 },
        ],
        // 获得奖励/遗物：星辉琶音
        reward: [
            { w: 'triangle', f: 880, d: 0, t: 0.28, g: 0.15 },
            { w: 'triangle', f: 1046.5, d: 0.07, t: 0.28, g: 0.15 },
            { w: 'triangle', f: 1318.5, d: 0.14, t: 0.3, g: 0.15 },
            { w: 'triangle', f: 1760, d: 0.21, t: 0.42, g: 0.14 },
        ],
        // 战斗胜利：短胜利动机
        victory: [
            { w: 'triangle', f: 659.3, d: 0, t: 0.16, g: 0.18 },
            { w: 'triangle', f: 784, d: 0.14, t: 0.16, g: 0.18 },
            { w: 'triangle', f: 880, d: 0.28, t: 0.55, g: 0.2 },
            { w: 'square', f: 659.3, d: 0, t: 0.14, g: 0.05 },
            { w: 'square', f: 784, d: 0.14, t: 0.14, g: 0.05 },
            { w: 'square', f: 880, d: 0.28, t: 0.5, g: 0.06 },
        ],
        // Boss 现身：低音号角 + 簇状不协和 + 鼓
        boss: [
            { w: 'sawtooth', f: 110, d: 0, t: 0.75, g: 0.26, flt: { type: 'lowpass', f0: 620 } },
            { w: 'sawtooth', f: 116.5, d: 0, t: 0.75, g: 0.22, flt: { type: 'lowpass', f0: 620 } },
            { w: 'sawtooth', f: 220, d: 0, t: 0.7, g: 0.1, flt: { type: 'lowpass', f0: 900 } },
            { w: 'sine', f0: 62, f1: 38, d: 0, t: 0.5, g: 0.55 },
        ],
        // 精英登场：厚重战鼓三连击 + 低沉号角（区别于普通战鼓号角）
        elite: [
            { w: 'sine', f0: 110, f1: 55, t: 0.16, g: 0.4 },
            { w: 'sine', f0: 110, f1: 55, d: 0.18, t: 0.16, g: 0.4 },
            { w: 'sine', f0: 110, f1: 55, d: 0.36, t: 0.18, g: 0.4 },
            { w: 'sawtooth', f: 98, d: 0.42, t: 0.85, g: 0.15, flt: { type: 'lowpass', f0: 480 } },
            { w: 'sawtooth', f: 110, d: 0.42, t: 0.85, g: 0.13, flt: { type: 'lowpass', f0: 520 } },
            { w: 'noise', t: 0.14, g: 0.12, flt: { type: 'bandpass', f0: 350, f1: 100, q: 1 } },
        ],
        // 镜像登场：诡异玻璃碎裂 + 阴冷双音微颤
        mirror: [
            { w: 'triangle', f0: 1400, f1: 900, t: 0.12, g: 0.12 },
            { w: 'triangle', f0: 1900, f1: 1300, d: 0.08, t: 0.12, g: 0.1 },
            { w: 'noise', t: 0.1, g: 0.14, flt: { type: 'highpass', f0: 3200 } },
            { w: 'noise', d: 0.07, t: 0.08, g: 0.12, flt: { type: 'highpass', f0: 2800 } },
            { w: 'sine', f0: 520, f1: 380, d: 0.1, t: 0.4, g: 0.1 },
            { w: 'sine', f0: 390, f1: 260, d: 0.2, t: 0.45, g: 0.09 },
        ],
        // 进入商店：钱袋晃动 + 金币风铃（商店场景）
        shop: [
            { w: 'noise', t: 0.1, g: 0.1, flt: { type: 'bandpass', f0: 600, f1: 350, q: 1.2 } },
            { w: 'square', f: 1174.7, d: 0.05, t: 0.06, g: 0.08 },
            { w: 'square', f: 1568, d: 0.1, t: 0.12, g: 0.08 },
            { w: 'square', f: 1046.5, d: 0.18, t: 0.1, g: 0.07 },
            { w: 'sine', f0: 200, f1: 120, d: 0.1, t: 0.2, g: 0.12 },
        ],
        // 休整点：营火噼啪 + 温暖低音（休整场景）
        rest: [
            { w: 'noise', t: 0.3, g: 0.1, flt: { type: 'lowpass', f0: 900, f1: 300 } },
            { w: 'noise', d: 0.12, t: 0.05, g: 0.12, flt: { type: 'bandpass', f0: 2400, q: 3 } },
            { w: 'noise', d: 0.27, t: 0.04, g: 0.1, flt: { type: 'bandpass', f0: 2000, q: 3 } },
            { w: 'sine', f0: 130, f1: 110, d: 0.05, t: 0.5, g: 0.14 },
        ],
        // 结局：空灵长音 + 星光琶音（结局选择/结算）
        ending: [
            { w: 'sine', f: 523.3, d: 0, t: 1.6, g: 0.1, a: 0.4 },
            { w: 'sine', f: 659.3, d: 0, t: 1.6, g: 0.1, a: 0.4 },
            { w: 'triangle', f: 1046.5, d: 0.3, t: 0.2, g: 0.1 },
            { w: 'triangle', f: 1318.5, d: 0.5, t: 0.24, g: 0.1 },
            { w: 'sine', f: 1760, d: 0.7, t: 0.4, g: 0.07 },
        ],
        // 死亡：下行小调 + 低鸣
        defeat: [
            { w: 'sawtooth', f: 440, d: 0, t: 0.3, g: 0.18, flt: { type: 'lowpass', f0: 1300, f1: 500 } },
            { w: 'sawtooth', f: 349.2, d: 0.3, t: 0.3, g: 0.18, flt: { type: 'lowpass', f0: 1200, f1: 460 } },
            { w: 'sawtooth', f: 293.7, d: 0.6, t: 0.3, g: 0.18, flt: { type: 'lowpass', f0: 1100, f1: 420 } },
            { w: 'sawtooth', f: 220, d: 0.9, t: 0.85, g: 0.2, flt: { type: 'lowpass', f0: 1000, f1: 380 } },
            { w: 'sine', f: 55, d: 0.9, t: 1.5, g: 0.28 },
        ],
        // 下潜楼层：低音下行 + 幽深气浪
        floor: [
            { w: 'sine', f0: 110, f1: 104, d: 0, t: 0.22, g: 0.38 },
            { w: 'sine', f0: 98, f1: 94, d: 0.24, t: 0.22, g: 0.38 },
            { w: 'sine', f0: 87.3, f1: 82, d: 0.48, t: 0.42, g: 0.4 },
            { w: 'noise', t: 0.7, g: 0.1, flt: { type: 'lowpass', f0: 1800, f1: 160 } },
        ],
        // 英雄技能：能量涌动上扫 + 微光
        skill: [
            { w: 'sawtooth', f0: 185, f1: 990, d: 0, t: 0.3, g: 0.22, flt: { type: 'bandpass', f0: 620, f1: 2400, q: 3 } },
            { w: 'triangle', f: 1760, d: 0.18, t: 0.2, g: 0.09 },
        ],
        // 错误/不足：粗糙蜂鸣
        error: [
            { w: 'square', f: 112, d: 0, t: 0.16, g: 0.12 },
            { w: 'square', f: 119, d: 0, t: 0.16, g: 0.12 },
        ],
        // 通关终章：A 大调和弦升华 + 胜利动机
        finale: [
            { w: 'triangle', f: 440, d: 0, t: 2.2, g: 0.12, a: 0.4 },
            { w: 'triangle', f: 554.4, d: 0, t: 2.2, g: 0.12, a: 0.4 },
            { w: 'triangle', f: 659.3, d: 0, t: 2.2, g: 0.12, a: 0.4 },
            { w: 'triangle', f: 880, d: 0, t: 2.4, g: 0.12, a: 0.5 },
            { w: 'triangle', f: 659.3, d: 0.3, t: 0.18, g: 0.16 },
            { w: 'triangle', f: 880, d: 0.45, t: 0.18, g: 0.16 },
            { w: 'triangle', f: 1108.7, d: 0.6, t: 0.9, g: 0.18 },
            { w: 'sine', f: 110, d: 0, t: 2.4, g: 0.22, a: 0.3 },
        ],
        // 开宝箱：木箱摩擦开盖 + 金币闪光
        chest: [
            { w: 'noise', t: 0.12, g: 0.16, flt: { type: 'bandpass', f0: 700, f1: 900, q: 1.5 } },
            { w: 'triangle', f0: 300, f1: 520, d: 0.06, t: 0.12, g: 0.18 },
            { w: 'square', f: 987.8, d: 0.18, t: 0.05, g: 0.1 },
            { w: 'square', f: 1318.5, d: 0.23, t: 0.2, g: 0.1 },
        ],
        // 陷阱：金属咔哒 + 尖刺弹出
        trap: [
            { w: 'square', f0: 900, f1: 300, t: 0.05, g: 0.18 },
            { w: 'noise', t: 0.06, g: 0.2, flt: { type: 'highpass', f0: 2500 } },
            { w: 'sawtooth', f0: 220, f1: 70, d: 0.05, t: 0.25, g: 0.3, flt: { type: 'lowpass', f0: 900 } },
        ],
        // 中毒/毒烟：气泡咕嘟
        poison: [
            { w: 'sine', f0: 250, f1: 320, d: 0, t: 0.12, g: 0.2 },
            { w: 'sine', f0: 280, f1: 380, d: 0.14, t: 0.12, g: 0.2 },
            { w: 'sine', f0: 240, f1: 200, d: 0.28, t: 0.2, g: 0.18 },
            { w: 'noise', t: 0.5, g: 0.08, flt: { type: 'lowpass', f0: 900 } },
        ],
        // 灼烧：火焰噼啪
        burn: [
            { w: 'noise', t: 0.4, g: 0.18, flt: { type: 'lowpass', f0: 1200, f1: 500 } },
            { w: 'noise', d: 0.1, t: 0.05, g: 0.12, flt: { type: 'bandpass', f0: 3200, q: 3 } },
            { w: 'noise', d: 0.25, t: 0.04, g: 0.1, flt: { type: 'bandpass', f0: 2800, q: 3 } },
        ],
        // 诅咒/魅惑：阴暗下行不协和
        curse: [
            { w: 'sawtooth', f0: 330, f1: 240, t: 0.3, g: 0.12, flt: { type: 'lowpass', f0: 1100 } },
            { w: 'sawtooth', f0: 350, f1: 250, d: 0.02, t: 0.3, g: 0.1, flt: { type: 'lowpass', f0: 1000 } },
            { w: 'sine', f0: 130, f1: 60, d: 0.1, t: 0.45, g: 0.22 },
        ],
        // 环境更替：空间本身的涌动（低频托底 + 泛音扫过，刻意区别于诅咒的下行不协和）
        env: [
            { w: 'noise', t: 0.5, g: 0.07, flt: { type: 'bandpass', f0: 420, f1: 1300, q: 1.2 } },
            { w: 'sine', f0: 55, f1: 92, d: 0.02, t: 0.5, g: 0.22 },
            { w: 'triangle', f0: 220, f1: 330, d: 0.08, t: 0.36, g: 0.09 },
        ],
        // 不死图腾：神圣闪光上行 + 低音支撑
        revive: [
            { w: 'triangle', f: 659.3, d: 0, t: 0.15, g: 0.16 },
            { w: 'triangle', f: 880, d: 0.08, t: 0.15, g: 0.16 },
            { w: 'triangle', f: 1174.7, d: 0.16, t: 0.2, g: 0.16 },
            { w: 'sine', f: 1760, d: 0.24, t: 0.4, g: 0.12 },
            { w: 'sine', f: 55, d: 0.1, t: 0.5, g: 0.25 },
        ],
        // 连击：快速双击
        combo: [
            { w: 'noise', t: 0.05, g: 0.16, flt: { type: 'bandpass', f0: 1400, f1: 500, q: 1.5 } },
            { w: 'sine', f0: 200, f1: 90, t: 0.08, g: 0.3 },
            { w: 'noise', d: 0.09, t: 0.05, g: 0.14, flt: { type: 'bandpass', f0: 1500, f1: 600, q: 1.5 } },
            { w: 'sine', f0: 220, f1: 100, d: 0.09, t: 0.08, g: 0.28 },
        ],
        // 斩杀：利刃出鞘 + 重击
        execute: [
            { w: 'noise', t: 0.1, g: 0.2, flt: { type: 'highpass', f0: 2000, f1: 5000 } },
            { w: 'square', f0: 700, f1: 200, d: 0.02, t: 0.12, g: 0.14, flt: { type: 'lowpass', f0: 2500 } },
            { w: 'sine', f0: 150, f1: 40, d: 0.04, t: 0.3, g: 0.55 },
            { w: 'noise', d: 0.04, t: 0.15, g: 0.22, flt: { type: 'lowpass', f0: 900, f1: 200 } },
        ],
        // 战斗开始：战鼓 + 号角
        battleStart: [
            { w: 'sine', f0: 100, f1: 45, t: 0.14, g: 0.4 },
            { w: 'sine', f0: 100, f1: 45, d: 0.2, t: 0.14, g: 0.4 },
            { w: 'sawtooth', f0: 330, f1: 440, d: 0.05, t: 0.3, g: 0.09, flt: { type: 'lowpass', f0: 900 } },
            { w: 'noise', t: 0.1, g: 0.1, flt: { type: 'bandpass', f0: 400, f1: 120, q: 1 } },
        ],
        // 存档：清脆记录音
        save: [
            { w: 'triangle', f: 1046.5, d: 0, t: 0.09, g: 0.14 },
            { w: 'triangle', f: 1568, d: 0.07, t: 0.22, g: 0.14 },
        ],
        // 护盾获得：清亮防护层展开（三角波双音 + 金属微光）
        shield: [
            { w: 'triangle', f: 620, d: 0, t: 0.12, g: 0.2 },
            { w: 'triangle', f: 880, d: 0.06, t: 0.14, g: 0.18 },
            { w: 'sine', f0: 310, f1: 640, d: 0.02, t: 0.16, g: 0.14 },
            { w: 'noise', t: 0.08, g: 0.08, flt: { type: 'highpass', f0: 3800 } },
        ],
        // 幸运/暴击率提升：欢快上行三连音
        lucky: [
            { w: 'triangle', f: 784, d: 0, t: 0.09, g: 0.16 },
            { w: 'triangle', f: 988, d: 0.07, t: 0.09, g: 0.16 },
            { w: 'triangle', f: 1318.5, d: 0.14, t: 0.16, g: 0.16 },
            { w: 'sine', f: 2637, d: 0.2, t: 0.2, g: 0.07 },
        ],
        // 荆棘：尖刺弹出（锯齿短促刮擦 + 弹跳）
        thorn: [
            { w: 'sawtooth', f0: 500, f1: 1100, t: 0.06, g: 0.14, flt: { type: 'bandpass', f0: 1400, q: 4 } },
            { w: 'triangle', f0: 260, f1: 520, d: 0.05, t: 0.1, g: 0.18 },
            { w: 'sine', f0: 180, f1: 95, d: 0.02, t: 0.14, g: 0.24 },
        ],
        // 吸血：暗红吸血音（低鸣 + 上吸）
        vampire: [
            { w: 'sine', f0: 220, f1: 90, t: 0.16, g: 0.24 },
            { w: 'sine', f0: 440, f1: 180, d: 0.05, t: 0.14, g: 0.16 },
            { w: 'triangle', f: 880, d: 0.1, t: 0.1, g: 0.1 },
            { w: 'noise', t: 0.1, g: 0.06, flt: { type: 'lowpass', f0: 500 } },
        ],
        // 经验献祭：神秘紫光上行（知识祭坛）
        xp: [
            { w: 'sine', f: 392, d: 0, t: 0.14, g: 0.16 },
            { w: 'sine', f: 523.3, d: 0.08, t: 0.14, g: 0.16 },
            { w: 'sine', f: 659.3, d: 0.16, t: 0.16, g: 0.16 },
            { w: 'sine', f: 1046.5, d: 0.24, t: 0.26, g: 0.12 },
        ],
        // 随机事件出现：神秘风铃（不确定性与机缘）
        event: [
            { w: 'sine', f: 880, d: 0, t: 0.3, g: 0.1 },
            { w: 'sine', f: 1174.7, d: 0.12, t: 0.3, g: 0.1 },
            { w: 'triangle', f: 1568, d: 0.24, t: 0.35, g: 0.08 },
            { w: 'noise', t: 0.4, g: 0.04, flt: { type: 'bandpass', f0: 2400, f1: 3200, q: 1.5 } },
        ],
        // 骰子：滚动咔哒 + 落定闷响（幸运骰子）
        dice: [
            { w: 'noise', t: 0.05, g: 0.1, flt: { type: 'bandpass', f0: 1200, f1: 900, q: 2 } },
            { w: 'noise', d: 0.09, t: 0.04, g: 0.09, flt: { type: 'bandpass', f0: 1400, f1: 1000, q: 2 } },
            { w: 'noise', d: 0.16, t: 0.04, g: 0.08, flt: { type: 'bandpass', f0: 1600, f1: 1100, q: 2 } },
            { w: 'sine', f0: 300, f1: 150, d: 0.22, t: 0.1, g: 0.3 },
        ],
        // 铁砧锻造：金属敲击 + 余韵（附魔铁砧）
        anvil: [
            { w: 'triangle', f0: 900, f1: 820, t: 0.06, g: 0.3 },
            { w: 'square', f0: 1800, f1: 1500, d: 0.01, t: 0.08, g: 0.12, flt: { type: 'highpass', f0: 1200 } },
            { w: 'noise', t: 0.05, g: 0.18, flt: { type: 'bandpass', f0: 2400, f1: 1400, q: 1.5 } },
            { w: 'sine', f0: 120, f1: 70, d: 0.02, t: 0.18, g: 0.32 },
        ],
        // 幽灵低语：气声 + 阴冷微颤（幽灵低语 / 恶魔低语）
        whisper: [
            { w: 'noise', t: 0.45, g: 0.06, flt: { type: 'bandpass', f0: 1800, f1: 2400, q: 4 } },
            { w: 'sine', f0: 240, f1: 190, d: 0.05, t: 0.4, g: 0.08 },
            { w: 'sine', f0: 260, f1: 205, d: 0.14, t: 0.4, g: 0.07 },
        ],
        // 许愿池：水花落水 + 魔法微光（许愿池）
        wish: [
            { w: 'noise', t: 0.14, g: 0.16, flt: { type: 'bandpass', f0: 900, f1: 500, q: 1.2 } },
            { w: 'sine', f0: 500, f1: 1100, d: 0.05, t: 0.14, g: 0.14 },
            { w: 'triangle', f: 1318.5, d: 0.16, t: 0.14, g: 0.12 },
            { w: 'triangle', f: 1760, d: 0.24, t: 0.26, g: 0.1 },
        ],
        // 泉水/水花：水滴叮咚（治疗之泉）
        splash: [
            { w: 'sine', f0: 660, f1: 990, t: 0.1, g: 0.16 },
            { w: 'sine', f0: 880, f1: 1320, d: 0.1, t: 0.1, g: 0.14 },
            { w: 'noise', t: 0.3, g: 0.05, flt: { type: 'bandpass', f0: 1400, f1: 800, q: 1.5 } },
        ],
        // 献祭/仪式：低沉仪式感（古老祭坛 / 知识祭坛 / 诅咒之井）
        sacrifice: [
            { w: 'sawtooth', f0: 130, f1: 85, t: 0.4, g: 0.16, flt: { type: 'lowpass', f0: 700 } },
            { w: 'sine', f0: 65, f1: 48, d: 0.06, t: 0.5, g: 0.3 },
            { w: 'triangle', f: 659.3, d: 0.18, t: 0.12, g: 0.08 },
            { w: 'triangle', f: 523.3, d: 0.3, t: 0.16, g: 0.08 },
        ],
        // 增益/提升：明亮上行琶音（属性提升、战斗导师指导）
        buff: [
            { w: 'triangle', f: 523.3, d: 0, t: 0.1, g: 0.16 },
            { w: 'triangle', f: 659.3, d: 0.07, t: 0.1, g: 0.16 },
            { w: 'triangle', f: 880, d: 0.14, t: 0.14, g: 0.16 },
            { w: 'sine', f: 1174.7, d: 0.22, t: 0.22, g: 0.1 },
        ],
        // 减益/削弱：阴暗下行（破败祭坛攻击-1、恶魔低语负面）
        debuff: [
            { w: 'sawtooth', f0: 300, f1: 180, t: 0.25, g: 0.1, flt: { type: 'lowpass', f0: 900 } },
            { w: 'sine', f0: 200, f1: 110, d: 0.08, t: 0.32, g: 0.16 },
        ],
        // 金币损失：钱袋落地 + 沉闷（损失金币）
        goldLose: [
            { w: 'noise', t: 0.06, g: 0.14, flt: { type: 'lowpass', f0: 900 } },
            { w: 'square', f0: 900, f1: 480, d: 0.02, t: 0.1, g: 0.08, flt: { type: 'lowpass', f0: 1800 } },
            { w: 'sine', f0: 130, f1: 70, d: 0.05, t: 0.2, g: 0.26 },
        ],
        // 升级：上行阶梯琶音（生命上限/暴击伤害等大幅提升）
        levelUp: [
            { w: 'triangle', f: 659.3, d: 0, t: 0.12, g: 0.16 },
            { w: 'triangle', f: 784, d: 0.09, t: 0.12, g: 0.16 },
            { w: 'triangle', f: 988, d: 0.18, t: 0.12, g: 0.16 },
            { w: 'triangle', f: 1318.5, d: 0.27, t: 0.24, g: 0.16 },
            { w: 'sine', f: 2637, d: 0.33, t: 0.3, g: 0.08 },
        ],
        // 开门/石门：沉重石门滑动（进入房间）
        door: [
            { w: 'noise', t: 0.35, g: 0.1, flt: { type: 'lowpass', f0: 600, f1: 200 } },
            { w: 'sawtooth', f0: 80, f1: 60, d: 0.02, t: 0.4, g: 0.14, flt: { type: 'lowpass', f0: 300 } },
            { w: 'sine', f0: 55, f1: 40, d: 0.12, t: 0.5, g: 0.24 },
        ],
        // 起跳：短促上扬的气流声（2D 实时战斗）
        jump: [
            { w: 'sine', f0: 320, f1: 640, t: 0.13, g: 0.22 },
            { w: 'noise', t: 0.09, g: 0.1, flt: { type: 'bandpass', f0: 700, f1: 1800, q: 1.6 } },
        ],
        // 落地：沉闷触地（低频冲击 + 扬尘噪声），力度越大越沉
        land: [
            { w: 'noise', t: 0.07, g: 0.15, flt: { type: 'lowpass', f0: 900, f1: 300 } },
            { w: 'sine', f0: 150, f1: 60, d: 0.01, t: 0.13, g: 0.3 },
        ],
        // 闪避冲刺：短促破空（高频气流被速度抹向低频）
        dash: [
            { w: 'noise', t: 0.16, g: 0.16, flt: { type: 'bandpass', f0: 1800, f1: 520, q: 2 } },
            { w: 'sine', f0: 520, f1: 180, t: 0.14, g: 0.2 },
        ],
        // 完美闪避：清脆铃音 + 上扬锐鸣（正反馈必须听得出来）
        perfect: [
            { w: 'triangle', f: 1568, t: 0.1, g: 0.16 },
            { w: 'triangle', f: 2093, d: 0.05, t: 0.3, g: 0.14 },
            { w: 'sine', f0: 740, f1: 1480, d: 0.02, t: 0.26, g: 0.2 },
        ],
        // 弓弦释放：拨弦短音 + 破空（游侠的疾风箭）
        shoot: [
            { w: 'triangle', f0: 880, f1: 320, d: 0.005, t: 0.11, g: 0.2 },
            { w: 'noise', t: 0.12, g: 0.12, flt: { type: 'highpass', f0: 1400, f1: 2600 } },
        ],
        // 法术出手：柔和的滑音 + 微亮泛音（法师的奥术弹 / 贤者的灵能波）
        magic: [
            { w: 'sine', f0: 300, f1: 900, d: 0.01, t: 0.24, g: 0.18 },
            { w: 'triangle', f0: 900, f1: 1500, d: 0.06, t: 0.3, g: 0.09 },
            { w: 'noise', t: 0.22, g: 0.05, flt: { type: 'bandpass', f0: 900, f1: 2200, q: 3 } },
        ],
        // 掷矛起手：布料摩擦 + 低闷蓄力（给玩家留出闪避的听感提示）
        spearwind: [
            { w: 'noise', t: 0.22, g: 0.1, flt: { type: 'bandpass', f0: 700, f1: 1300, q: 1.5 } },
            { w: 'sine', f0: 200, f1: 300, d: 0.02, t: 0.2, g: 0.12 },
        ],
        // 长矛脱手：硬物破空的粗糙感
        spear: [
            { w: 'noise', t: 0.2, g: 0.16, flt: { type: 'bandpass', f0: 2200, f1: 700, q: 2 } },
            { w: 'triangle', f0: 420, f1: 130, d: 0.005, t: 0.16, g: 0.18 },
        ],
        // 完美格挡：金属硬碰 + 上扬铃音（听感上要明显区别于"普通挨打"）
        parry: [
            { w: 'square', f0: 2600, f1: 1900, d: 0.005, t: 0.07, g: 0.14, flt: { type: 'bandpass', f0: 2600, q: 1.2 } },
            { w: 'noise', t: 0.1, g: 0.2, flt: { type: 'bandpass', f0: 3200, f1: 1400, q: 1.6 } },
            { w: 'triangle', f: 1318, d: 0.03, t: 0.22, g: 0.15 },
            { w: 'triangle', f: 1976, d: 0.07, t: 0.26, g: 0.11 },
        ],
        // 魂晶拾取：水晶短叮
        crystal: [
            { w: 'triangle', f: 1760, d: 0.0, t: 0.12, g: 0.13 },
            { w: 'sine', f0: 1320, f1: 2200, d: 0.04, t: 0.2, g: 0.1 },
        ],
        // ===== v2.9 P4：塌陷回廊（三个程序化音效，不引入素材） =====
        // 预警：低频抖动 + 碎石噪声，约 0.8 秒渐强（给玩家反应时间）
        collapseWarn: [
            { w: 'sawtooth', f0: 72, f1: 54, a: 0.55, t: 0.85, g: 0.1, flt: { type: 'lowpass', f0: 240, f1: 120 } },
            { w: 'noise', a: 0.6, t: 0.85, g: 0.055, flt: { type: 'bandpass', f0: 700, f1: 320, q: 1.2 } },
        ],
        // 塌陷：低频轰鸣 + 噪声爆，带一点延迟回声（第二层噪声晚 0.18s）
        collapseFall: [
            { w: 'sine', f0: 145, f1: 36, t: 0.62, g: 0.5 },
            { w: 'noise', t: 0.5, g: 0.3, flt: { type: 'lowpass', f0: 1300, f1: 160 } },
            { w: 'noise', d: 0.18, t: 0.4, g: 0.14, flt: { type: 'bandpass', f0: 420, f1: 150, q: 0.9 } },
        ],
        // 开门：上行琶音（与 crystal 同调性，A 小调音阶）
        doorUnlock: [
            { w: 'triangle', f: 523.3, t: 0.24, g: 0.14 },
            { w: 'triangle', f: 659.3, d: 0.09, t: 0.3, g: 0.14 },
            { w: 'triangle', f: 784, d: 0.18, t: 0.34, g: 0.16 },
            { w: 'sine', f: 1046.5, d: 0.28, t: 0.5, g: 0.12 },
        ],
        // 限时最后 5 秒：短促木质滴答，不复用低沉的错误蜂鸣
        tick: [
            { w: 'triangle', f0: 1180, f1: 760, t: 0.055, g: 0.075 },
            { w: 'sine', f: 1760, d: 0.018, t: 0.045, g: 0.035 },
        ],
        // 守点开始 / 机关启动：两声闷响 + 一层低频嗡鸣。
        // 原来这里直接播 doorUnlock，听起来像"门已经开了"，而守点房的圈是刚出现的。
        holdStart: [
            { w: 'sine', f0: 320, f1: 180, t: 0.18, g: 0.16 },
            { w: 'triangle', f: 392, d: 0.14, t: 0.22, g: 0.11 },
            { w: 'sine', f0: 98, f1: 72, a: 0.2, t: 0.7, g: 0.09, flt: { type: 'lowpass', f0: 420, f1: 220 } },
        ],
    };

    // 同名音效节流，避免同帧重复叠加
    const lastPlay = {};
    function sfx(name) {
        if (!ctx || !unlocked || !settings.sfx) return;
        const recipe = SFX[name];
        if (!recipe) return;
        const now = ctx.currentTime;
        if (lastPlay[name] != null && now - lastPlay[name] < 0.03) return;
        lastPlay[name] = now;
        try {
            recipe.forEach(v => playVoice(v, now + 0.001, sfxBus));
        } catch (e) { /* 音频失败不影响游戏 */ }
    }

    // ------------------------------------------------------------
    // BGM：程序化暗黑地牢氛围乐
    // A 小调（Aeolian）。步进单位 = 8 分音符，和弦每小节更换。
    // ------------------------------------------------------------
    // 和弦（MIDI 音高数组）
    const CHORDS_CALM = [
        [45, 52, 57, 60, 64],  // Am
        [41, 48, 53, 57, 64],  // F maj7
        [48, 55, 60, 64, 67],  // C
        [40, 47, 52, 55, 59],  // Em
    ];
    const CHORDS_TENSE = [
        [45, 52, 57, 60, 64],  // Am
        [45, 52, 57, 60, 64],  // Am
        [41, 48, 53, 57, 64],  // F
        [40, 44, 52, 56, 59],  // E（和声小调 V 级，带 G#）
    ];
    const ARP_SCALE = [57, 60, 62, 64, 67, 69, 72, 76]; // A 小调五声扩展

    const SCENES = {
        menu:    { barSteps: 8, stepDur: 0.55, chords: CHORDS_CALM,  pad: true, bass: 0,   arpP: 0.10, hat: 0,   drone: false },
        explore: { barSteps: 8, stepDur: 0.52, chords: CHORDS_CALM,  pad: true, bass: 0.3, arpP: 0.22, hat: 0,   drone: false },
        battle:  { barSteps: 8, stepDur: 0.26, chords: CHORDS_TENSE, pad: true, bass: 0.9, arpP: 1.0,  hat: 0.75, drone: false },
        boss:    { barSteps: 8, stepDur: 0.24, chords: CHORDS_TENSE, pad: true, bass: 0.9, arpP: 1.0,  hat: 1.0,  drone: true  },
        // 精英：比普通战斗更厚重（步进放缓、低音更沉、镲片稍疏）
        elite:   { barSteps: 8, stepDur: 0.30, chords: CHORDS_TENSE, pad: true, bass: 1.0, arpP: 0.9,  hat: 0.6,  drone: false },
        // 镜像：诡异稀疏（慢速琶音 + 持续低鸣）
        mirror:  { barSteps: 8, stepDur: 0.46, chords: CHORDS_TENSE, pad: true, bass: 0.5, arpP: 0.5,  hat: 0.15, drone: true  },
        // 商店：轻快神秘（柔和琶音 + 轻微镲片）
        shop:    { barSteps: 8, stepDur: 0.48, chords: CHORDS_CALM,  pad: true, bass: 0.45, arpP: 0.38, hat: 0.12, drone: false },
        // 休整：极简安宁（慢速铺底、几乎无鼓点）
        rest:    { barSteps: 8, stepDur: 0.68, chords: CHORDS_CALM,  pad: true, bass: 0.15, arpP: 0.12, hat: 0,    drone: false },
        // 层间抉择（深渊裂隙）：用紧张和弦 + 持续低鸣，语气与「要交出什么代价」相配；
        // 不做新曲，只调现有音色的编排（与 battle/boss 共用 CHORDS_TENSE）。
        choice:  { barSteps: 8, stepDur: 0.58, chords: CHORDS_TENSE, pad: true, bass: 0.35, arpP: 0.28, hat: 0, drone: true  },
        // 结局：空灵升华（舒缓琶音、无鼓点）
        ending:  { barSteps: 8, stepDur: 0.62, chords: CHORDS_CALM,  pad: true, bass: 0.25, arpP: 0.55, hat: 0,    drone: false },
    };

    let droneSrc = null; // boss 场景持续低鸣

    function stopDrone() {
        if (droneSrc) {
            try { droneSrc.stop(); } catch (e) {}
            droneSrc = null;
        }
    }

    function startDrone(time) {
        stopDrone();
        // A1 低鸣 + 缓慢颤音
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = m2f(33);
        const flt = ctx.createBiquadFilter();
        flt.type = 'lowpass';
        flt.frequency.value = 130;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(0.16, time + 2);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.35;
        const lfoG = ctx.createGain();
        lfoG.gain.value = 0.05;
        lfo.connect(lfoG);
        lfoG.connect(g.gain);
        osc.connect(flt);
        flt.connect(g);
        g.connect(bgmBus);
        osc.start(time);
        lfo.start(time);
        droneSrc = {
            stop: () => {
                try {
                    g.gain.cancelScheduledValues(ctx.currentTime);
                    g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.3);
                    osc.stop(ctx.currentTime + 1.2);
                    lfo.stop(ctx.currentTime + 1.2);
                } catch (e) {}
            }
        };
    }

    // 调度一个 8 分音符步
    function scheduleStep(stepIdx, time) {
        // 使用当前生效场景（待切换场景只在本小节最后一 步应用）
        const cfg = SCENES[scene] || SCENES.explore;
        const inBar = stepIdx % cfg.barSteps;
        const chord = cfg.chords[chordIndex % cfg.chords.length];
        // 战斗/BOSS/精英/镜像：音乐更突出（音量增强，鼓点更密）
        const combat = (scene === 'battle' || scene === 'boss' || scene === 'elite' || scene === 'mirror');
        const boost = combat ? 1.35 : 1;

        // 小节头：铺底和弦 + 低音根音
        if (inBar === 0) {
            if (cfg.pad) {
                chord.forEach((m, i) => {
                    playVoice({
                        w: i < 2 ? 'sawtooth' : 'triangle',
                        f: m2f(m),
                        t: cfg.stepDur * cfg.barSteps * 0.96,
                        g: (i < 2 ? 0.045 : 0.055) * boost,
                        a: cfg.stepDur * 1.6,
                        flt: { type: 'lowpass', f0: scene === 'menu' ? 620 : 760 },
                    }, time, bgmBus);
                });
            }
            playVoice({ w: 'sine', f: m2f(chord[0] - 12), t: cfg.stepDur * 0.9, g: 0.16 * boost }, time, bgmBus);
            chordIndex++;
        }

        // 战斗/BOSS：低音脉冲（每步交替八度）
        if (cfg.bass > 0) {
            const oct = inBar % 2 === 0 ? 0 : 12;
            playVoice({ w: 'triangle', f: m2f(chord[0] - 12 + oct), t: cfg.stepDur * 0.5, g: 0.14 * cfg.bass * boost }, time, bgmBus);
            // 战鼓：战斗场景每 2 步一击（更密集推进），其他场景每 4 步
            if (inBar % (combat ? 2 : 4) === 0) {
                playVoice({ w: 'sine', f0: 95, f1: 40, t: 0.13, g: 0.3 * cfg.bass * boost }, time, bgmBus);
            }
        }

        // 沙锤噪声
        if (cfg.hat > 0 && inBar % 2 === 1) {
            playVoice({ w: 'noise', t: 0.03, g: 0.05 * cfg.hat * boost, flt: { type: 'highpass', f0: 6000 } }, time, bgmBus);
        }

        // 琶音回声（探索场景稀疏点缀，战斗场景密集推进）
        if (Math.random() < cfg.arpP) {
            const note = ARP_SCALE[Math.floor(Math.random() * ARP_SCALE.length)];
            const oct = Math.random() < 0.3 ? 12 : 0;
            playVoice({ w: 'triangle', f: m2f(note + oct), t: 0.32, g: 0.075 * boost }, time, bgmBus);
        }

        // 小节边界应用待切换场景
        if (inBar === cfg.barSteps - 1 && scheduledScene && scheduledScene !== scene) {
            scene = scheduledScene;
            scheduledScene = null;
            if (SCENES[scene].drone) startDrone(time + (SCENES[scene].stepDur || 0.3));
            else stopDrone();
        }
    }

    function schedulerTick() {
        if (!bgmRunning || !ctx) return;
        while (nextStepTime < ctx.currentTime + LOOKAHEAD) {
            // 每步重新读取配置：场景可能在小节边界已切换
            const cfg = SCENES[scene] || SCENES.explore;
            scheduleStep(step, nextStepTime);
            step++;
            nextStepTime += cfg.stepDur;
        }
    }

    function startBgm() {
        if (!ctx || !settings.bgm || bgmRunning) return;
        bgmRunning = true;
        step = 0;
        chordIndex = 0;
        nextStepTime = ctx.currentTime + 0.1;
        bgmBus.gain.cancelScheduledValues(ctx.currentTime);
        bgmBus.gain.setValueAtTime(0.0001, ctx.currentTime);
        bgmBus.gain.exponentialRampToValueAtTime(bgmTargetGain(), ctx.currentTime + 1.2);
        if (bgmTimer) clearInterval(bgmTimer);
        bgmTimer = setInterval(schedulerTick, TICK_MS);
        schedulerTick();
    }

    function stopBgm(fade = 0.8) {
        if (!ctx) return;
        bgmRunning = false;
        if (bgmTimer) {
            clearInterval(bgmTimer);
            bgmTimer = null;
        }
        stopDrone();
        try {
            bgmBus.gain.cancelScheduledValues(ctx.currentTime);
            bgmBus.gain.setTargetAtTime(0.0001, ctx.currentTime, fade / 3);
        } catch (e) {}
    }

    // 切换场景：立即生效（不再等小节边界，避免进战斗后音乐迟迟不换）
    function setScene(s) {
        if (!SCENES[s]) return;
        if (scene === s && !scheduledScene) return;
        if (!ctx || !bgmRunning) {
            scene = s;
            scheduledScene = null;
            return;
        }
        scene = s;
        scheduledScene = null;
        const now = ctx.currentTime;
        // 取消已排入时间线但尚未起播的旧场景音符，避免与新场景重叠
        for (const entry of bgmPending) {
            if (entry.t0 > now + 0.02) {
                try { entry.src.stop(0); } catch (e) {}
                bgmPending.delete(entry);
            }
        }
        // 总线快速闪避：掩盖正在收尾的长音尾音，切换更干净
        try {
            bgmBus.gain.cancelScheduledValues(now);
            bgmBus.gain.setValueAtTime(bgmTargetGain(), now);
            bgmBus.gain.linearRampToValueAtTime(bgmTargetGain() * 0.18, now + 0.05);
            bgmBus.gain.linearRampToValueAtTime(bgmTargetGain(), now + 0.3);
        } catch (e) {}
        // 重置调度：从当前时刻起用新场景配置从头排步（新小节头立刻响起）
        step = 0;
        chordIndex = 0;
        nextStepTime = now + 0.3;
        if (SCENES[scene].drone) startDrone(nextStepTime);
        else stopDrone();
        schedulerTick();
    }

    // 根据游戏状态自动映射 BGM 场景
    function syncScene(state) {
        if (!state) return;
        if (state.trial && state.trial.active) return; // 试炼由试炼程序显式控制
        let target = 'explore';
        if (state.mode === 'combat' || state.mode === 'combatChoice') {
            const rt = state.currentRoom && state.currentRoom.type;
            if (rt === 'boss') target = 'boss';
            else if (rt === 'elite') target = 'elite';
            else if (rt === 'mirror') target = 'mirror';
            else target = 'battle';
        } else if (state.mode === 'bossPrep') {
            // 层主战前铺垫：直接进入 BOSS 氛围
            target = 'boss';
        } else if (state.mode === 'shop') {
            target = 'shop';
        } else if (state.mode === 'rest') {
            target = 'rest';
        } else if (state.mode === 'victoryChoice' || state.mode === 'finished') {
            target = 'ending';
        } else if (state.mode === 'start' || state.mode === 'heroSelect' || state.mode === 'gameover') {
            target = 'menu';
        }
        setScene(target);
    }

    // ------------------------------------------------------------
    // 解锁（自动播放策略）与设置
    // ------------------------------------------------------------
    function unlock() {
        if (unlocked) {
            if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
            return;
        }
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            ctx = new AC();
            initGraph();
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            unlocked = true;
            if (settings.bgm) startBgm();
        } catch (e) {
            console.warn('[音频] 初始化失败：', e);
        }
    }

    function applySettings(s) {
        if (!s) return;
        const prevBgm = settings.bgm;
        settings.bgm = s.bgm !== false;
        settings.sfx = s.sfx !== false;
        if (s.bgmVolume !== undefined) settings.bgmVolume = clampVolume(s.bgmVolume);
        if (s.sfxVolume !== undefined) settings.sfxVolume = clampVolume(s.sfxVolume);

        // 应用音量（总线未初始化时跳过，unlock 后 initGraph 会读取设置）
        if (sfxBus) sfxBus.gain.value = sfxTargetGain();
        if (bgmBus) bgmBus.gain.value = bgmTargetGain();

        if (!ctx || !unlocked) return;
        if (settings.bgm && !prevBgm) startBgm();
        if (!settings.bgm && prevBgm) stopBgm(0.5);
    }

    // 首次手势自动解锁（开始界面任意点击/按键均可激活声音）
    function bindAutoUnlock() {
        const onGesture = () => {
            unlock();
            // 解锁后移除一次性监听
            document.removeEventListener('pointerdown', onGesture, true);
            document.removeEventListener('keydown', onGesture, true);
            document.removeEventListener('touchstart', onGesture, true);
        };
        document.addEventListener('pointerdown', onGesture, true);
        document.addEventListener('keydown', onGesture, true);
        document.addEventListener('touchstart', onGesture, true);

        // 全局按钮点击音（捕获阶段，任何按钮都有轻反馈）
        document.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest && e.target.closest(
                'button, select, .toggle-slider, .room-item, .sidebar-toggle, .start-button, ' +
                '.action-button, .ghost-button, .condition-item, .save-slot-card');
            if (btn && !btn.disabled) sfx('click');
        }, true);

        // 页面切回前台时恢复上下文
        // 条件写 state !== 'running' 而不是 === 'suspended'：iOS 在来电、其他 App
        // 抢音频、锁屏之后会把 AudioContext 置成特有的 'interrupted' 状态，
        // 那一档光比 'suspended' 更死 —— 不 resume 的话回到游戏就是全场静音。
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') {
                ctx.resume().catch(() => {});
            }
        });
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', bindAutoUnlock);
        } else {
            bindAutoUnlock();
        }
    }

    // ------------------------------------------------------------
    // 对外接口
    // ------------------------------------------------------------
    // 测试页兼容：setBGM / setSFX / setMasterVolume
    function setBGM(enabled) {
        applySettings({ bgm: !!enabled, sfx: settings.sfx, bgmVolume: settings.bgmVolume, sfxVolume: settings.sfxVolume });
    }
    function setSFX(enabled) {
        applySettings({ bgm: settings.bgm, sfx: !!enabled, bgmVolume: settings.bgmVolume, sfxVolume: settings.sfxVolume });
    }
    function setMasterVolume(v) {
        if (!master) return;
        try { master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), ctx.currentTime, 0.02); } catch (e) {}
    }
    return { unlock, sfx, setScene, syncScene, applySettings, setBGM, setSFX, setMasterVolume };
})();

window.AbyssAudio = AbyssAudio;