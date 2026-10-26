// ============================================================
// 音效系统预加载
// ============================================================

// 在脚本开始时立即加载音效系统
(function() {
  if (!window.AbyssAudio) {
    const script = document.createElement('script');
    script.src = 'AbyssAudio.js?t=' + Date.now();
    script.async = true;
    script.onload = function() {
      console.log('[音效] AbyssAudio.js 预加载完成');
    };
    script.onerror = function() {
      console.warn('[音效] AbyssAudio.js 预加载失败');
    };
    document.head.appendChild(script);
  }
})();

// ============================================================
// 多存档系统常量
// ============================================================
const SLOT_COUNT = 5;                     // 槽位数量
// 2.7：新版与老版（2.6）的存档**完全隔离**
// 老版继续用 abyss_* 原键，新版用 abyss27_*。为什么要隔离：新版把战斗从回合制换成
// 实时 2D，存档 schema 会随之变化（战斗态、遗物、诅咒、房间结构都不同）；共用一套键的话，
// 任一版写出的存档都可能让另一版读崩。首启只做「复制」不做「移动」，
// 老版仍然看得到它自己的进度，两边此后各自独立（详见 migrateFromLegacyNamespace）。
const SAVE_NS = 'abyss27_';
const PREV_SAVE_NS = 'abyss_';
const SAVE_KEY_PREFIX = SAVE_NS + 'save_slot_';   // 槽位数据键名前缀
const META_KEY = SAVE_NS + 'save_meta';           // 元数据键名
const ACTIVE_SLOT_KEY = SAVE_NS + 'save_active';  // 当前活跃槽位键名
const LEGACY_SAVE_KEY = 'abyss_autosave';         // 2.6 之前的单档键（用于迁移）
const NS_MIGRATED_FLAG = SAVE_NS + 'ns_migrated'; // 「已从老版命名空间复制过」标记
// 迁移时必须保留老版单档键：老版也要能自己把它迁进 abyss_* 命名空间。
// 删掉的话，只在新版启动过的玩家切回老版时会丢掉那份单档存档。
const KEEP_LEGACY_SINGLE_SAVE = true;

// 设置界面部分
// 设置存储键
const SETTINGS_KEY = 'abyss_settings';
// 默认设置
const DEFAULT_SETTINGS = {
  screenShake: true,
  floatText: true,
  backgroundEffects: true,
  glowEffect: true,
  restartConfirm: true,
  bgm: true,        // 背景音乐
  sfx: true,        // 游戏音效
  bgmVolume: 100,   // 背景音乐音量（1~200）
  sfxVolume: 100,   // 音效音量（1~200）
  // v2.8.1：删掉了 battleAnimation / animationSpeed 两个键。
  //   它们只在 2.6 的 试炼程序.js 里被读过，而那份代码从 2.7 起就不再加载
  //   （主界面.html 里已经没有任何地方引用它）—— 也就是说这两个开关在
  //   设置面板里拨了**不会影响任何东西**。留着键只会让"设置能改变游戏"
  //   这件事变得不可信，所以键与界面项一起删。
  //   旧存档里存着的这两个值读进来也不会报错（loadSettings 只回填已知键）。
  fontSize: 'normal',       // 文字大小: small | normal | large
};

// 音效系统加载
function loadAbyssAudio() {
  return new Promise((resolve, reject) => {
    // 检查是否已经加载
    if (window.AbyssAudio) {
      resolve();
      return;
    }
    
    // 检查是否已经有脚本正在加载
    if (window._abyssAudioLoading) {
      // 等待现有脚本加载完成
      const checkInterval = setInterval(() => {
        if (window.AbyssAudio) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
      
      // 超时保护
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 5000);
      return;
    }
    
    window._abyssAudioLoading = true;
    
    const script = document.createElement('script');
    script.src = 'AbyssAudio.js?t=' + Date.now(); // 添加时间戳避免缓存
    script.onload = () => {
      console.log('[音效] AbyssAudio.js 加载完成');
      window._abyssAudioLoading = false;
      resolve();
    };
    script.onerror = () => {
      console.warn('[音效] AbyssAudio.js 加载失败，将使用静音模式');
      window._abyssAudioLoading = false;
      resolve();
    };
    document.head.appendChild(script);
  });
}

// 默认元数据结构
const DEFAULT_META = {};
for (let i = 1; i <= SLOT_COUNT; i++) {
    DEFAULT_META[`slot_${i}`] = null;
}

// ============================================================
// 多存档系统核心
// ============================================================

// 获取当前活跃槽位编号（如 "slot_1"），若无则返回 null
function getActiveSlot() {
    try {
        return localStorage.getItem(ACTIVE_SLOT_KEY) || null;
    } catch {
        return null;
    }
}

// 设置当前活跃槽位
function setActiveSlot(slotId) {
    if (!slotId) {
        localStorage.removeItem(ACTIVE_SLOT_KEY);
        return;
    }
    localStorage.setItem(ACTIVE_SLOT_KEY, slotId);
}

// 获取元数据
function getMeta() {
    try {
        const data = localStorage.getItem(META_KEY);
        if (data) {
            const parsed = JSON.parse(data);
            // 确保所有槽位都存在
            for (let i = 1; i <= SLOT_COUNT; i++) {
                const key = `slot_${i}`;
                if (!(key in parsed)) {
                    parsed[key] = null;
                }
            }
            return parsed;
        }
    } catch (e) {
        console.warn('读取元数据失败:', e);
    }
    // 返回默认元数据
    return JSON.parse(JSON.stringify(DEFAULT_META));
}
// 保存元数据
function setMeta(meta) {
    try {
        localStorage.setItem(META_KEY, JSON.stringify(meta));
        console.log('[存档] 元数据已保存:', meta);
    } catch (e) {
        console.error('[存档] 保存元数据失败:', e);
    }
}

// 获取某个槽位的数据（返回完整 state 对象）
function getSlotData(slotId) {
    try {
        const data = localStorage.getItem(SAVE_KEY_PREFIX + slotId);
        if (data) {
            return JSON.parse(data);
        }
    } catch (e) {
        console.warn(`读取槽位 ${slotId} 失败:`, e);
    }
    return null;
}

// 保存某个槽位的数据
function setSlotData(slotId, data) {
    localStorage.setItem(SAVE_KEY_PREFIX + slotId, JSON.stringify(data));
}

// 删除某个槽位
function deleteSlot(slotId) {
    localStorage.removeItem(SAVE_KEY_PREFIX + slotId);
    const meta = getMeta();
    if (meta[slotId]) {
        meta[slotId] = null;
        setMeta(meta);
    }
    // 如果当前活跃槽位被删除，清除活跃标记
    if (getActiveSlot() === slotId) {
        setActiveSlot(null);
    }
}

// 重命名槽位（仅修改元数据中的显示名称）
function renameSlot(slotId, newName) {
    const meta = getMeta();
    if (meta[slotId]) {
        meta[slotId].name = newName.trim() || '未命名存档';
        setMeta(meta);
    }
}

// 获取槽位的显示信息（用于界面）
function getSlotInfo(slotId) {
    const meta = getMeta();
    const info = meta[slotId];
    if (!info) return null;
    // 尝试从实际存档中读取更详细的数据（用于展示）
    const data = getSlotData(slotId);
    if (data) {
        const heroName = data.hero?.name || '无英雄';
        const floor = data.floor || 1;
        const difficulty = data.difficulty || 'normal';
        const mode = data.trial?.active ? '试炼模式' : '经典模式';
        return {
            ...info,
            hero: heroName,
            floor: floor,
            difficulty: difficulty,
            mode: mode,
            hasData: true
        };
    }
    return {
        ...info,
        hasData: false
    };
}

// ===== 设置管理 =====
function loadSettings() {
  try {
    const data = localStorage.getItem(SETTINGS_KEY);
    if (data) {
      const parsed = JSON.parse(data);
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (e) {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function applySettings(settings) {
  // 1. 背景特效
  const nebula = document.querySelector('.nebula-layer');
  const stars = document.getElementById('starsLayer');
  const particles = document.getElementById('particleContainer');
  const bgElements = [nebula, stars, particles];
  bgElements.forEach(el => {
    if (el) {
      el.style.display = settings.backgroundEffects ? '' : 'none';
    }
  });

  // 2. 光晕
  const glow = document.getElementById('mouseGlow');
  if (glow) {
    glow.style.display = settings.glowEffect ? '' : 'none';
  }

  // 2.5 文字大小（缩放根字号，rem 单位整体跟随）
  const fs = settings.fontSize;
  document.documentElement.style.fontSize =
      fs === 'small' ? '15px' : (fs === 'large' ? '17px' : '');

  // 3. 窗口抖动 - 通过全局变量控制
  window._settings = settings;

  // 4. 音频（背景音乐 / 音效开关）
  if (window.AbyssAudio && typeof window.AbyssAudio.applySettings === 'function') {
    try {
      window.AbyssAudio.applySettings(settings);
    } catch (error) {
      console.warn('[音效] 应用设置失败:', error);
    }
  } else {
    console.warn('[音效] 音效系统未完全加载，设置将延迟应用');
    // 延迟应用设置
    setTimeout(() => {
      if (window.AbyssAudio && typeof window.AbyssAudio.applySettings === 'function') {
        try {
          window.AbyssAudio.applySettings(settings);
          console.log('[音效] 音效设置已延迟应用');
        } catch (error) {
          console.warn('[音效] 延迟应用设置失败:', error);
        }
      }
    }, 1000);
  }

  // 5. 试炼模式 2D 实时战斗（试炼即 2D，始终启用）
  if (window.试炼2D && typeof window.试炼2D.setSettings === 'function') {
    try {
      window.试炼2D.setSettings({
        enabled: true,
        particles: settings.trial2DParticles !== false,
        screenShake2D: settings.screenShake !== false,
        floatText: settings.floatText !== false,
        // HUD 密度：战斗画面上"常驻多少信息"由它决定（遗物条 / 属性面板是否显示）。
        // 它属于 2D 引擎的设置域，而 SETTINGS_DEFS 住在主程序这边 ——
        // 不显式转交的话，引擎那边永远是默认值，设置里切了也看不出变化。
        hudDensity: settings.hudDensity || 'auto'
      });
    } catch (error) {
      console.warn('[试炼2D] 应用设置失败:', error);
    }
  }
}

// 检查某个设置是否开启
function isSettingEnabled(key) {
  if (!window._settings) {
    window._settings = loadSettings();
  }
  return window._settings[key] !== false;
}

// ============================================================
// 设置界面（5 个开关）
// ============================================================
const SETTINGS_DEFS = [
    { key: 'screenShake',       label: '窗口抖动', desc: '战斗受击时窗口轻微震动' },
    { key: 'floatText',         label: '飘字特效', desc: '伤害、治疗等数字从屏幕飘出' },
    { key: 'backgroundEffects', label: '背景特效', desc: '背景中闪烁漂移的光点与星云' },
    { key: 'glowEffect',        label: '光晕',     desc: '跟随鼠标指针移动的柔光' },
    { key: 'restartConfirm',    label: '重开提示', desc: '点击重新开始时弹出二次确认框' },
    { key: 'bgm',               label: '背景音乐', desc: '随场景变化的程序生成环境音乐' },
    { key: 'sfx',               label: '游戏音效', desc: '攻击、受伤、金币、按钮等反馈音效' },
    { key: 'bgmVolume',         label: '背景音乐音量', type: 'number', min: 1, max: 200 },
    { key: 'sfxVolume',         label: '音效音量', type: 'number', min: 1, max: 200 },
    { key: 'trial2DParticles',  label: '2D粒子特效', desc: '实时战斗中的暴击、技能粒子与光效' },
    { key: 'fontSize',          label: '文字大小', desc: '界面文字整体缩放（小/标准/大）', type: 'segmented', options: [['small', '小'], ['normal', '标准'], ['large', '大']] },
    // v2.8.1：战斗画面的信息密度。遗物栏与属性面板是否常驻由它决定 ——
    // 「想看更多信息」和「要画面干净」是一对真实矛盾，交给玩家自己选，
    // 而不是替他拍板。
    //
    // layout:'cards' —— 这一项不走「左文字右一排胶囊」的标准排版，理由见
    //   主样式.css 的 .settings-item-cards：四档各档含义差得远，光给四个词
    //   玩家选不出来，得把「每档常驻什么」写在选项里面；而四张卡片需要整行
    //   宽度才排得开，塞进右半边只会让文字被压成两行、按钮那条窄带空得发慌。
    // notes 里的文案与 战斗2D.js 的 applyHudDensity / relicStripWanted 实际
    //   行为逐条对应，改行为时这里要一起改（否则设置界面会开始说谎）。
    { key: 'hudDensity',        label: 'HUD 密度', desc: '战斗中常驻多少信息。收起的内容仍可点画面里的「属性」按钮查看', type: 'segmented', layout: 'cards',
      options: [['auto', '自动'], ['full', '完整'], ['compact', '精简'], ['minimal', '极简']],
      notes: {
        auto: '按屏幕尺寸自动挑一档',
        full: '属性面板与遗物栏都常驻，信息最全',
        compact: '收起属性面板，保留遗物栏',
        minimal: '只留生命 / 体力 / 狂怒三条'
      } },
];

function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) {
        console.warn('[设置] 未找到设置模态框元素');
        return;
    }

    const contentEl = modal.querySelector('.modal-content');

    // 渲染开关列表（复用现有 CSS：.settings-list / .setting-item / .toggle-switch）
    let listHost = modal.querySelector('.settings-list');
    if (!listHost && contentEl) {
        listHost = document.createElement('div');
        listHost.className = 'settings-list';
        // 插到关闭按钮的后面
        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn && closeBtn.parentNode) {
            closeBtn.parentNode.insertBefore(listHost, closeBtn.nextSibling);
        } else {
            contentEl.appendChild(listHost);
        }
    }

    const current = loadSettings();
    listHost.innerHTML = '';

    // ===== 横版排版：按类别分列 =====
    // 14 项平铺成一列会变成一条又窄又长的竖条（原来 max-width 440px）：
    // 一屏看不全、还得滚动，而这里面全是"一眼扫过就调完"的开关。
    // 按类别分成 3 列之后弹窗变成「宽而扁」的一块，与 2D 画面的横版布局同构。
    //
    // 分类**只是呈现**：SETTINGS_DEFS 仍是唯一数据源，这里只声明"哪个 key 落在哪一列"。
    // 漏写的 key 会被兜底逻辑收进「其他」列 —— 宁可多显示一列，
    // 也不能让某一项设置因为没人给它归类就从界面上消失。
    const SETTINGS_GROUPS = [
      { id: 'visual', title: '画面', keys: ['screenShake', 'floatText', 'backgroundEffects', 'glowEffect', 'trial2DParticles'] },
      { id: 'audio', title: '音频', keys: ['bgm', 'sfx', 'bgmVolume', 'sfxVolume'] },
      { id: 'system', title: '系统与操作', keys: ['restartConfirm', 'fontSize', 'hudDensity'] }
    ];
    const groupOf = {};
    const groupEls = {};
    SETTINGS_GROUPS.forEach(g => {
      g.keys.forEach(k => { groupOf[k] = g.id; });
      const col = document.createElement('div');
      col.className = 'settings-group';
      const title = document.createElement('div');
      title.className = 'settings-group-title';
      title.textContent = g.title;
      col.appendChild(title);
      listHost.appendChild(col);
      groupEls[g.id] = col;
    });
    /** 某一项该进哪一列；没归类的落到「其他」 */
    const hostFor = key => {
      const gid = groupOf[key];
      if (gid && groupEls[gid]) return groupEls[gid];
      if (!groupEls.__rest) {
        const col = document.createElement('div');
        col.className = 'settings-group';
        const title = document.createElement('div');
        title.className = 'settings-group-title';
        title.textContent = '其他';
        col.appendChild(title);
        listHost.appendChild(col);
        groupEls.__rest = col;
      }
      return groupEls.__rest;
    };

    SETTINGS_DEFS.forEach(def => {
        // 卡片式选择（多档 + 每档含义不同）：纵向铺满整行，理由见 SETTINGS_DEFS 里
        // hudDensity 的注释与 主样式.css 的 .settings-item-cards
        if (def.type === 'segmented' && def.layout === 'cards') {
            const item = document.createElement('div');
            item.className = 'setting-item settings-item-cards';
            const currentVal = current[def.key] !== undefined ? current[def.key] : def.options[0][0];
            const info = document.createElement('div');
            info.className = 'setting-info';
            info.innerHTML = `<span class="setting-label">${def.label}</span>
                <span class="setting-desc">${def.desc || ''}</span>`;
            item.appendChild(info);
            const group = document.createElement('div');
            group.className = 'card-choice';
            def.options.forEach(opt => {
                const [val, label] = opt;
                const note = (def.notes && def.notes[val]) || '';
                const card = document.createElement('button');
                card.type = 'button';
                card.className = 'card-choice-option' + (currentVal === val ? ' active' : '');
                card.dataset.settingKey = def.key;
                card.dataset.settingValue = val;
                // 档位名与说明都在按钮里 —— 玩家读的是「这一档会发生什么」，
                // 不是一个代号
                card.innerHTML = `<span class="card-choice-label">${label}</span>` +
                    (note ? `<span class="card-choice-note">${note}</span>` : '');
                group.appendChild(card);
            });
            item.appendChild(group);
            // 这一项**不放进任何一列**，而是作为 .settings-list 的直接子项独占一行。
            // 原因：四张卡片挤在三列布局的其中一列里，会变成一条又窄又高的竖条
            // （实测每列只有 268px、卡片 171px 宽）。
            // ⚠️ 跨列（grid-column: 1/-1）只对 .settings-list 的直接子元素生效 ——
            //    加在列上会把**整列**撑成整行，把别的设置全挤到下面去。
            item.classList.add('settings-item-wide');
            listHost.appendChild(item);
            return;
        }
        // 分段选择型设置（动画速度 / 文字大小）
        if (def.type === 'segmented') {
            const item = document.createElement('div');
            item.className = 'setting-item setting-item-segmented';
            const currentVal = current[def.key] !== undefined ? current[def.key] : def.options[1][0];
            let segHtml = '';
            def.options.forEach(opt => {
                const [val, label] = opt;
                const active = currentVal === val ? ' active' : '';
                segHtml += `<button type="button" class="seg-option${active}" data-setting-key="${def.key}" data-setting-value="${val}">${label}</button>`;
            });
            item.innerHTML =
                `<div class="setting-info">
                    <span class="setting-label">${def.label}</span>
                    <span class="setting-desc">${def.desc}</span>
                </div>
                <div class="seg-control">${segHtml}</div>`;
            hostFor(def.key).appendChild(item);
            return;
        }
        // 数字输入框型设置（音量）：范围提示以小字形式悬浮在输入框内右侧
        if (def.type === 'number') {
            const item = document.createElement('div');
            item.className = 'setting-item';
            const currentVal = current[def.key] !== undefined ? current[def.key] : 100;
            item.innerHTML =
                `<div class="setting-info">
                    <span class="setting-label">${def.label}</span>
                    ${def.desc ? `<span class="setting-desc">${def.desc}</span>` : ''}
                </div>
                <div class="number-control">
                    <input type="number" data-setting-key="${def.key}" value="${currentVal}" min="${def.min}" max="${def.max}" inputmode="numeric">
                    <span class="number-range-hint">${def.min}~${def.max}</span>
                </div>`;
            hostFor(def.key).appendChild(item);
            return;
        }
        const item = document.createElement('label');
        item.className = 'setting-item';
        item.innerHTML =
            `<div class="setting-info">
                <span class="setting-label">${def.label}</span>
                <span class="setting-desc">${def.desc}</span>
            </div>
            <div class="toggle-switch">
                <input type="checkbox" data-setting-key="${def.key}" ${current[def.key] !== false ? 'checked' : ''}>
                <div class="toggle-slider"></div>
            </div>`;
        hostFor(def.key).appendChild(item);
    });

    // ===== 2D 试炼布局自定义（独立入口）=====
    // 它不是「开/关」一项，而是一整块编辑器（拖动 + 缩放 + 显隐），
    // 所以不塞进 SETTINGS_DEFS，单独渲染一个入口。
    {
        const layoutItem = document.createElement('div');
        layoutItem.className = 'setting-item';
        layoutItem.innerHTML =
            `<div class="setting-info">
                <span class="setting-label">2D 战斗按键自定义</span>
                <span class="setting-desc">拖动移动任意面板与按钮，可缩放 / 调透明度 / 隐藏</span>
            </div>
            <button type="button" class="action-button secondary" id="open2DLayoutEditorBtn" style="flex:0 0 auto;padding:8px 14px;">打开编辑器</button>`;
        // 布局编辑器是"一整块工具"，不是开关 —— 放进「系统与操作」列
        groupEls.system.appendChild(layoutItem);
        const layoutBtn = layoutItem.querySelector('#open2DLayoutEditorBtn');
        if (layoutBtn) {
            layoutBtn.addEventListener('click', function () {
                const t2d = window.试炼2D;
                if (!t2d || !t2d.enterLayoutEdit) {
                    showToast('2D 模块未加载，无法打开布局编辑器');
                    return;
                }
                if (!t2d.isReady || !t2d.isReady()) {
                    // 编辑器必须挂在运行中的 2D 场景上：它要按真实布局算基准位置
                    showToast('请先进入 2D 试炼（试炼 → 2D 画面），再回来打开编辑器');
                    return;
                }
                modal.classList.add('hidden');
                const ok = t2d.enterLayoutEdit();
                showToast(ok ? '编辑模式：拖动面板或按钮即可移动' : '进入编辑模式失败');
            });
        }
    }

    // 绑定开关切换（每次打开重绑前先摘除旧的，防止叠加监听）
    if (listHost._settingsHandler) {
        listHost.removeEventListener('change', listHost._settingsHandler);
        listHost.removeEventListener('click', listHost._settingsHandler);
    }
    listHost._settingsHandler = function(e) {
        // 分段选择按钮
        const segBtn = e.target.closest('button[data-setting-key][data-setting-value]');
        if (segBtn) {
            const key = segBtn.dataset.settingKey;
            const val = segBtn.dataset.settingValue;
            const settings = loadSettings();
            settings[key] = val;
            saveSettings(settings);
            applySettings(settings);
            window._settings = settings;
            listHost.querySelectorAll(`button[data-setting-key="${key}"]`).forEach(b => {
                b.classList.toggle('active', b.dataset.settingValue === val);
            });
            const def = SETTINGS_DEFS.find(d => d.key === key) || {};
            showToast(`✅ 已切换「${def.label}」为「${segBtn.textContent}」`);
            return;
        }
        const input = e.target.closest('input[data-setting-key]');
        if (!input) return;
        const key = input.dataset.settingKey;
        const def = SETTINGS_DEFS.find(d => d.key === key) || {};

        // 数字输入框型设置：仅在 change（失焦/回车）时提交，避免点击输入框就触发
        if (def.type === 'number') {
            if (e.type !== 'change') return;
            const settings = loadSettings();
            let val = parseInt(input.value, 10);
            if (isNaN(val)) val = settings[key] !== undefined ? settings[key] : 100;
            // 验证范围并回写，输入框始终显示合法值
            if (val < def.min) val = def.min;
            if (val > def.max) val = def.max;
            input.value = val;
            settings[key] = val;
            saveSettings(settings);
            applySettings(settings);
            window._settings = settings;
            showToast(`✅ 已设置「${def.label}」为 ${val}`);
            return;
        }

        // 复选框开关只处理 change 事件，避免 click+change 双触发导致重复提示
        if (e.type !== 'change') return;
        const settings = loadSettings();
        settings[input.dataset.settingKey] = input.checked;
        saveSettings(settings);
        applySettings(settings);      // 背景/光晕立即生效
        window._settings = settings;
        showToast(`✅ 已${input.checked ? '开启' : '关闭'}「${def.label}」`);
    };
    listHost.addEventListener('change', listHost._settingsHandler);
    listHost.addEventListener('click', listHost._settingsHandler);

    // 关闭绑定（用标记防重复挂载）
    if (!modal.dataset.settingsBound) {
        modal.dataset.settingsBound = 'true';
        modal.addEventListener('click', function(e) {
            if (e.target.closest('.modal-close') ||
                e.target.dataset.action === 'close-settings' ||
                e.target.classList.contains('modal-backdrop')) {
                modal.classList.add('hidden');
            }
        });
    }

    modal.classList.remove('hidden');
}

// 迁移旧存档（仅在首次打开时调用）
function migrateOldSave() {
    const oldData = localStorage.getItem(LEGACY_SAVE_KEY);
    if (!oldData) return false;
    try {
        const parsed = JSON.parse(oldData);
        // 检查是否已经迁移过（已有元数据或任意槽位有数据）
        const meta = getMeta();
        let hasAnySlot = false;
        for (let i = 1; i <= SLOT_COUNT; i++) {
            if (meta[`slot_${i}`]) {
                hasAnySlot = true;
                break;
            }
        }
        if (hasAnySlot) {
            // 已经有存档，删除旧存档避免重复迁移
            if (!KEEP_LEGACY_SINGLE_SAVE) localStorage.removeItem(LEGACY_SAVE_KEY);
            return false;
        }
        // 保存到 slot_1
        const slotId = 'slot_1';
        setSlotData(slotId, parsed);
        // 生成元数据
        const heroName = parsed.hero?.name || '冒险者';
        const floor = parsed.floor || 1;
        const difficulty = parsed.difficulty || 'normal';
        const mode = parsed.trial?.active ? '试炼模式' : '经典模式';
        meta[slotId] = {
            name: `${heroName}的存档`,
            hero: heroName,
            floor: floor,
            difficulty: difficulty,
            mode: mode
        };
        setMeta(meta);
        setActiveSlot(slotId);
        // 删除旧存档
        if (!KEEP_LEGACY_SINGLE_SAVE) localStorage.removeItem(LEGACY_SAVE_KEY);
        console.log('✅ 旧存档已迁移到 slot_1');
        return true;
    } catch (e) {
        console.warn('旧存档迁移失败:', e);
        return false;
    }
}

/**
 * 2.7 新版启动时：把 2.6（老版）命名空间下的存档**复制**到新版命名空间
 * ------------------------------------------------------------
 * · 只复制、不删除 —— 老版切回去时仍然看得到自己的进度，两版此后各自独立
 * · 只在新版命名空间还空着的时候做一次（用 NS_MIGRATED_FLAG 记住，避免重复覆盖）
 * · 设置（abyss_settings）、开发者开关（abyss_dev_mode）、按键布局
 *   （abyss_trial2d_layout）**有意共用**：这些是无害的偏好项，两版一致反而更省心
 * 返回：实际复制过来的键数量（>0 表示确实继承了老版存档）
 */
function migrateFromLegacyNamespace() {
    try {
        if (localStorage.getItem(NS_MIGRATED_FLAG)) return 0;
        // 新版已经有槽位数据 → 玩家已经在新版里玩过，不覆盖
        for (let i = 1; i <= SLOT_COUNT; i++) {
            if (localStorage.getItem(SAVE_KEY_PREFIX + `slot_${i}`) !== null) {
                localStorage.setItem(NS_MIGRATED_FLAG, 'skip:already-has-data');
                return 0;
            }
        }
        const keys = [];
        for (let i = 1; i <= SLOT_COUNT; i++) keys.push('save_slot_' + `slot_${i}`);
        keys.push('save_meta', 'save_active');
        let copied = 0;
        for (const suffix of keys) {
            const v = localStorage.getItem(PREV_SAVE_NS + suffix);
            if (v === null) continue;
            localStorage.setItem(SAVE_NS + suffix, v);
            copied++;
        }
        localStorage.setItem(NS_MIGRATED_FLAG, copied > 0 ? `copied:${copied}` : 'empty');
        if (copied > 0) console.log(`✅ 已从老版（2.6）复制 ${copied} 项存档到新版命名空间 ${SAVE_NS}`);
        return copied;
    } catch (e) {
        console.warn('老版存档继承失败（不影响新版新开局）：', e);
        return 0;
    }
}

// 脚本一加载就执行：必须早于任何一次 ensureDefaultSlot / saveGame，
// 否则新版会先落下一个空槽位，把「继承老版存档」的机会挡掉。
const NS_INHERITED_KEYS = migrateFromLegacyNamespace();
function getNewestSlotId() {
    let newestSlot = null, newestTime = -1;
    for (let i = 1; i <= SLOT_COUNT; i++) {
        const slotId = `slot_${i}`;
        const data = getSlotData(slotId);
        if (data && (data._savedAt || 0) > newestTime) {
            newestTime = data._savedAt || 0;
            newestSlot = slotId;
        }
    }
    // 兜底：没有槽位带时间戳（全是旧存档），取第一个有数据的
    if (!newestSlot) {
        for (let i = 1; i <= SLOT_COUNT; i++) {
            const slotId = `slot_${i}`;
            if (getSlotData(slotId)) { newestSlot = slotId; break; }
        }
    }
    return newestSlot;
}
// 确保至少有一个存档槽位可用（自动创建默认槽位或修复元数据）
function ensureDefaultSlot() {
    console.log('[存档] 执行 ensureDefaultSlot');
    const meta = getMeta();
    let hasAnySlot = false;
    for (let i = 1; i <= SLOT_COUNT; i++) {
        if (meta[`slot_${i}`]) { hasAnySlot = true; break; }
    }
    // ---- 分支A：元数据完好，只需检查活跃标记 ----
    if (hasAnySlot) {
        console.log('[存档] 元数据中存在槽位，检查活跃槽位');
        const activeSlot = getActiveSlot();
        if (!activeSlot) {
            const newest = getNewestSlotId();
            if (newest) {
                setActiveSlot(newest);
                console.log(`[存档] 活跃标记丢失，自动切换到最新槽位 ${newest}`);
            }
        }
        return;
    }
    // ---- 分支B：元数据丢失，从实际槽位数据重建 ----
    let hasData = false;
    for (let i = 1; i <= SLOT_COUNT; i++) {
        const slotId = `slot_${i}`;
        if (localStorage.getItem(SAVE_KEY_PREFIX + slotId) !== null) { hasData = true; break; }
    }
    if (hasData) {
        console.log('[存档] 检测到槽位数据但元数据丢失，正在重建...');
        for (let i = 1; i <= SLOT_COUNT; i++) {
            const slotId = `slot_${i}`;
            const data = getSlotData(slotId);
            if (data) {
                const heroName = data.hero?.name || '冒险者';
                const floor = data.floor || 1;
                const difficulty = data.difficulty || 'normal';
                const mode = data.trial?.active ? '试炼模式' : '经典模式';
                meta[slotId] = { name: `${heroName}的存档`, hero: heroName, floor: floor, difficulty: difficulty, mode: mode };
            }
        }
        setMeta(meta);
        console.log('[存档] 重建后的元数据:', meta);
        const currentActive = getActiveSlot();
        if (currentActive && meta[currentActive]) {
            // 活跃标记仍然指向有效槽位，直接恢复
            setActiveSlot(currentActive);
            console.log(`[存档] 恢复活跃槽位 ${currentActive}`);
        } else {
            const newest = getNewestSlotId();
            if (newest) {
                setActiveSlot(newest);
                console.log(`[存档] 切换到最新槽位 ${newest}`);
            }
        }
        return;
    }
    // ---- 分支C：完全没有任何数据，创建默认槽位 ----
    console.log('[存档] 无任何数据，创建默认槽位 slot_1');
    const slotId = 'slot_1';
    const heroName = state.hero?.name || '冒险者';
    const defaultName = `${heroName}的存档`;
    meta[slotId] = {
        name: defaultName,
        hero: heroName,
        floor: state.floor || 1,
        difficulty: state.difficulty || 'normal',
        mode: state.trial?.active ? '试炼模式' : '经典模式'
    };
    setMeta(meta);
    setActiveSlot(slotId);
    console.log('[存档] 元数据已写入，准备保存游戏');
    saveGame(); // 保存当前状态（saveGame 内部会写入 _savedAt 和 _sessionId）
    console.log('[存档] 默认槽位创建完成');
}

// ============================================================
// 自动存档系统
// ============================================================

const SAVE_ID = 'abyss_autosave';

// 保存游戏（自动保存到当前活跃槽位）
function saveGame() {
    try {
        // 保存前截断日志
        if (state.log && state.log.length > 100) {
            state.log = state.log.slice(-100);
        }
        if (!state.player) {
            console.warn('保存失败: state.player 不存在');
            return;
        }
        // ⚠️ "还没开始的局"绝不写盘
        // ------------------------------------------------------------
        // 判据就是**有没有英雄**：一局的开始以"选定英雄"为准，此前的一切状态
        // （mode 可能是 start / heroSelect / bonusSelect，甚至被宿主标成别的）
        // 都不该落盘。旧版没有这道守卫，于是启动阶段任何一次 saveGame() 都会
        // 凭空写出一份"没有英雄"的空档；下次启动读到它，界面直接空白
        // （实测踩到：清空存档重启后必现）。
        // 规划里给「切换老版」按钮加的同类守卫只保护了那一个入口，saveGame 本身一直没有。
        if (!state.hero) {
            console.log('跳过保存：尚未选定英雄（不产生空存档）');
            return;
        }
        let activeSlot = getActiveSlot();
        if (!activeSlot) {
            // 尝试自动创建默认槽位
            ensureDefaultSlot();
            activeSlot = getActiveSlot();
            if (!activeSlot) {
                console.warn('没有活跃槽位，无法保存');
                return;
            }
        }
        // 写入保存时间与会话标记（必须在 setSlotData 之前，否则存进文件的是旧时间戳）
        state._savedAt = Date.now(); // 本次保存时间：供槽位选择排序与诊断日志使用
        if (window._sessionId) {
            state._sessionId = window._sessionId; // 会话标记：下次载入时若与本页不同，说明存档曾被其他标签页写过
        }
        // 保存到对应槽位
        setSlotData(activeSlot, state);
        // 同时更新元数据中的楼层/难度等信息（保持同步）
        const meta = getMeta();
        if (meta[activeSlot]) {
            const heroName = state.hero?.name || '冒险者';
            const floor = state.floor || 1;
            const difficulty = state.difficulty || 'normal';
            const mode = state.trial?.active ? '试炼模式' : '经典模式';
            meta[activeSlot] = { ...meta[activeSlot], hero: heroName, floor: floor, difficulty: difficulty, mode: mode };
            setMeta(meta);
        }
        console.log(`✅ 游戏已自动保存到 ${activeSlot}`);
    } catch (e) {
        console.warn('自动保存失败:', e);
    }
}

// 打开存档管理界面
function manualSave() {
    openSaveManager();
}

// ============================================================
// 存档管理界面
// ============================================================

// 打开存档管理模态框
function openSaveManager() {
    const modal = document.getElementById('saveManagerModal');
    if (!modal) return;

    // 检查元数据是否为空，若为空则强制重建
    const meta = getMeta();
    let hasAny = false;
    for (let i = 1; i <= SLOT_COUNT; i++) {
        if (meta[`slot_${i}`]) {
            hasAny = true;
            break;
        }
    }
    if (!hasAny) {
        console.log('[存档管理] 元数据为空，调用 ensureDefaultSlot 重建');
        ensureDefaultSlot();
    }

    modal.classList.remove('hidden');
    renderSaveManager();
}

// 关闭存档管理模态框
function closeSaveManager() {
    const modal = document.getElementById('saveManagerModal');
    if (modal) modal.classList.add('hidden');
}

// 渲染存档管理界面
function renderSaveManager() {
    const container = document.getElementById('saveManagerList');
    if (!container) {
        console.warn('[存档管理] 未找到 saveManagerList');
        return;
    }

    // 移除旧的事件监听
    if (container._saveHandler) {
        container.removeEventListener('click', container._saveHandler);
        container._saveHandler = null;
    }

    const meta = getMeta();
    console.log('[存档管理] 当前元数据:', meta);

    const activeSlot = getActiveSlot();
    let html = '';
    for (let i = 1; i <= SLOT_COUNT; i++) {
        const slotId = `slot_${i}`;
        const info = meta[slotId];
        const isActive = activeSlot === slotId;
        if (info) {
            const displayName = info.name || `槽位 ${i}`;
            const hero = info.hero || '未知';
            const floor = info.floor || 1;
            const difficulty = info.difficulty || 'normal';
            const mode = info.mode || '经典模式';
            const diffLabel = { easy: '简单', normal: '普通', hard: '困难', hell: '地狱' }[difficulty] || difficulty;
            html += `
                <div class="save-slot-card ${isActive ? 'active' : ''}" data-slot="${slotId}">
                    <div class="save-slot-header">
                        <span class="save-slot-name">${displayName}</span>
                        <span class="save-slot-badge">${isActive ? '当前使用' : ''}</span>
                    </div>
                    <div class="save-slot-info">
                        ${hero} · 第${floor}层 · ${diffLabel} · ${mode}
                    </div>
                    <div class="save-slot-actions">
                        <button class="save-action-btn load" data-slot="${slotId}">加载</button>
                        <button class="save-action-btn save" data-slot="${slotId}">覆盖</button>
                        <button class="save-action-btn rename" data-slot="${slotId}">改名</button>
                        <button class="save-action-btn delete" data-slot="${slotId}">删除</button>
                    </div>
                </div>
            `;
        } else {
            html += `
                <div class="save-slot-card empty" data-slot="${slotId}">
                    <div class="save-slot-header">
                        <span class="save-slot-name">槽位 ${i} (空)</span>
                    </div>
                    <div class="save-slot-info" style="color:var(--muted);">暂无存档</div>
                    <div class="save-slot-actions">
                        <button class="save-action-btn create" data-slot="${slotId}">新建</button>
                    </div>
                </div>
            `;
        }
    }
    container.innerHTML = html;

    // 显示当前使用槽位
    const activeDisplay = document.getElementById('saveManagerActive');
    if (activeDisplay) {
        const activeInfo = activeSlot ? meta[activeSlot] : null;
        activeDisplay.textContent = activeInfo ? `当前使用：${activeInfo.name || activeSlot}` : '当前使用：无';
    }

    // ---- 绑定新的事件监听（只绑定一次） ----
    const handler = function(e) {
        const btn = e.target.closest('.save-action-btn');
        if (!btn) return;
        const slotId = btn.dataset.slot;
        if (!slotId) return;
        const action = btn.classList.contains('load') ? 'load' :
                       btn.classList.contains('save') ? 'save' :
                       btn.classList.contains('rename') ? 'rename' :
                       btn.classList.contains('delete') ? 'delete' :
                       btn.classList.contains('create') ? 'create' : null;
        if (!action) return;
        e.stopPropagation();
        handleSaveAction(action, slotId);
    };
    container._saveHandler = handler;
    container.addEventListener('click', handler);
}

// 处理存档操作
function handleSaveAction(action, slotId) {
    switch (action) {
        case 'load':
            // 加载存档
            if (confirm(`确定要加载此存档吗？当前未保存的进度将丢失。`)) {
                const data = getSlotData(slotId);
                if (data) {
                    setActiveSlot(slotId);
                    // 换了存档 = 换了本局 → 先让 2D 宿主停掉旧局，再重开
                    notifyHostRunReset();
                    // 重新加载
                    if (loadGame()) {
                        showToast(`已加载存档 ${slotId}`);
                        closeSaveManager();
                        // 与导入路径同一套顺序：补标记 → render → 补拉
                        ensureHostRoomMark();
                        render();
                        ensureHostRunAlive();
                        renderLog();
                        renderRelics();
                    } else {
                        showToast('加载失败，存档数据损坏');
                    }
                } else {
                    showToast('该存档无数据');
                }
            }
            break;
        case 'save':
            // 覆盖存档
            if (confirm(`确定要覆盖此存档吗？`)) {
                const meta = getMeta();
                if (!meta[slotId]) {
                    // 如果元数据不存在（理论上不会），先创建
                    meta[slotId] = { name: `存档 ${slotId}` };
                }
                // 保存当前游戏状态到该槽位
                setActiveSlot(slotId);
                saveGame();
                // 更新元数据中的信息
                const info = meta[slotId];
                info.hero = state.hero?.name || '冒险者';
                info.floor = state.floor || 1;
                info.difficulty = state.difficulty || 'normal';
                info.mode = state.trial?.active ? '试炼模式' : '经典模式';
                setMeta(meta);
                showToast(`已保存到 ${slotId}`);
                renderSaveManager();
            }
            break;
        case 'rename':
            // 改名
            const meta = getMeta();
            const currentName = meta[slotId]?.name || `槽位 ${slotId}`;
            const newName = prompt(`请输入新的存档名称：`, currentName);
            if (newName !== null && newName.trim() !== '') {
                renameSlot(slotId, newName.trim());
                renderSaveManager();
                showToast('存档已重命名');
            }
            break;
        case 'delete':
            // 删除
            if (confirm(`确定要删除此存档吗？此操作不可恢复！`)) {
                deleteSlot(slotId);
                // 如果删除的是当前活跃槽位，清除状态
                if (getActiveSlot() === slotId) {
                    setActiveSlot(null);
                    // 重置游戏状态（回到初始界面）
                    initGame();
                }
                renderSaveManager();
                showToast(`已删除 ${slotId}`);
            }
            break;
        case 'create':
            // 新建：将当前游戏状态保存到空槽位
            const meta2 = getMeta();
            if (meta2[slotId]) {
                showToast('该槽位已有存档，请使用覆盖');
                return;
            }
            // 确保当前有游戏进度（如果处于初始界面，先创建默认进度）
            if (!state.hero || state.mode === 'heroSelect') {
                showToast('请先开始游戏再新建存档');
                return;
            }
            // 保存到该槽位
            setActiveSlot(slotId);
            // 设置默认名称
            const heroName = state.hero?.name || '冒险者';
            const defaultName = `${heroName}的存档`;
            const meta3 = getMeta();
            meta3[slotId] = {
                name: defaultName,
                hero: heroName,
                floor: state.floor || 1,
                difficulty: state.difficulty || 'normal',
                mode: state.trial?.active ? '试炼模式' : '经典模式'
            };
            setMeta(meta3);
            saveGame();
            showToast(`已创建新存档 ${slotId}`);
            renderSaveManager();
            break;
    }
}

// ============================================================
// 外部存档同步 (File System Access API)
// ============================================================

let folderHandle = null;
let externalSaves = [];

// 从 IndexedDB 恢复文件夹句柄
async function restoreFolderHandle() {
  try {
    const request = indexedDB.open('AbyssSaveDB', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('handles')) {
        db.createObjectStore('handles');
      }
    };
    return new Promise((resolve) => {
      request.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('handles', 'readonly');
        const store = tx.objectStore('handles');
        const get = store.get('folderHandle');
        get.onsuccess = () => {
          const handle = get.result;
          if (handle) {
            // 验证权限是否仍然有效
            handle.requestPermission({ mode: 'readwrite' }).then((perm) => {
              if (perm === 'granted') {
                folderHandle = handle;
                resolve(true);
              } else {
                resolve(false);
              }
            }).catch(() => resolve(false));
          } else {
            resolve(false);
          }
        };
        get.onerror = () => resolve(false);
      };
      request.onerror = () => resolve(false);
    });
  } catch (e) {
    console.warn('恢复文件夹句柄失败:', e);
    return false;
  }
}

// 保存文件夹句柄到 IndexedDB
async function saveFolderHandle(handle) {
  try {
    const request = indexedDB.open('AbyssSaveDB', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('handles')) {
        db.createObjectStore('handles');
      }
    };
    return new Promise((resolve) => {
      request.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('handles', 'readwrite');
        const store = tx.objectStore('handles');
        const put = store.put(handle, 'folderHandle');
        put.onsuccess = () => resolve(true);
        put.onerror = () => resolve(false);
      };
      request.onerror = () => resolve(false);
    });
  } catch (e) {
    console.warn('保存文件夹句柄失败:', e);
    return false;
  }
}

// 绑定文件夹按钮处理
async function bindFolder() {
  if (!window.showDirectoryPicker) {
    showToast('当前浏览器或系统不支持文件夹绑定，请使用下载与导入按钮');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker();
    // 请求读写权限
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      folderHandle = handle;
      await saveFolderHandle(handle);
      showToast('文件夹绑定成功');
      refreshExternalSaves();
    } else {
      showToast('权限被拒绝，无法绑定');
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.warn('绑定文件夹失败:', e);
      showToast('绑定取消或失败');
    }
  }
}

// 扫描外部文件夹内的 JSON 存档
async function scanExternalFolder() {
  if (!folderHandle) return [];
  const saves = [];
  try {
    const entries = [];
    for await (const entry of folderHandle.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.json')) {
        entries.push(entry);
      }
    }
    // 按修改时间排序（降序）
    for (const entry of entries) {
      try {
        const file = await entry.getFile();
        const lastModified = file.lastModified;
        saves.push({ name: entry.name, handle: entry, lastModified });
      } catch (e) {
        console.warn('读取文件信息失败:', entry.name);
      }
    }
    saves.sort((a, b) => b.lastModified - a.lastModified);
    return saves;
  } catch (e) {
    console.warn('扫描文件夹失败:', e);
    return [];
  }
}

// 刷新外部存档列表
async function refreshExternalSaves() {
  const listContainer = document.getElementById('externalSaveList');
  const infoEl = document.getElementById('externalSaveInfo');
  if (!listContainer) return;

  if (!folderHandle) {
    listContainer.innerHTML = '';
    infoEl.textContent = '未绑定文件夹';
    return;
  }

  try {
    const saves = await scanExternalFolder();
    externalSaves = saves;
    if (saves.length === 0) {
      listContainer.innerHTML = '<div style="color:var(--muted);font-size:0.75rem;padding:4px 0;">文件夹内无 JSON 存档</div>';
      infoEl.textContent = `已绑定：${folderHandle.name}（0 个存档）`;
    } else {
      let html = '';
      saves.forEach((item, index) => {
        const date = new Date(item.lastModified).toLocaleString();
        html += `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 6px; background:rgba(255,255,255,0.03); border-radius:6px; font-size:0.75rem;">
            <span style="color:var(--text-secondary);">${item.name} (${date})</span>
            <div style="display:flex; gap:6px;">
              <button class="external-load-btn" data-index="${index}" style="background:rgba(115,240,180,0.15); border:none; color:var(--accent); padding:2px 10px; border-radius:4px; cursor:pointer; font-size:0.7rem;">加载</button>
              <button class="external-delete-btn" data-index="${index}" style="background:rgba(232,104,120,0.15); border:none; color:var(--danger); padding:2px 10px; border-radius:4px; cursor:pointer; font-size:0.7rem;">删除</button>
            </div>
          </div>
        `;
      });
      listContainer.innerHTML = html;
      infoEl.textContent = `已绑定：${folderHandle.name}（${saves.length} 个存档）`;

      // 绑定按钮事件（委托方式，避免多次绑定）
      listContainer.querySelectorAll('.external-load-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const idx = parseInt(btn.dataset.index);
          loadExternalSave(idx);
        });
      });
      listContainer.querySelectorAll('.external-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const idx = parseInt(btn.dataset.index);
          deleteExternalSave(idx);
        });
      });
    }
  } catch (e) {
    console.warn('刷新外部存档失败:', e);
    listContainer.innerHTML = '<div style="color:var(--danger);font-size:0.75rem;">读取失败，请重新绑定</div>';
    infoEl.textContent = '读取失败';
  }
}

// 加载外部存档
async function loadExternalSave(index) {
  if (!folderHandle || index < 0 || index >= externalSaves.length) return;
  const item = externalSaves[index];
  try {
    const file = await item.handle.getFile();
    const text = await file.text();
    const data = JSON.parse(text);
    // 覆盖当前 state
    Object.assign(state, data);
    // 重新绑定英雄技能等
    restoreHeroSkillBinding(state.hero);
    restoreHeroSkillBinding(state.trial && state.trial.hero);
    // 刷新界面
    render();
    renderLog();
    renderRelics();
    showToast(`已加载外部存档：${item.name}`);
    // 同时保存到当前槽位（覆盖）
    saveGame();
    // 关闭存档管理
    closeSaveManager();
  } catch (e) {
    console.warn('加载外部存档失败:', e);
    showToast('加载失败，文件可能已损坏');
  }
}

// 删除外部存档
async function deleteExternalSave(index) {
  if (!folderHandle || index < 0 || index >= externalSaves.length) return;
  if (!confirm(`确定要删除 ${externalSaves[index].name} 吗？`)) return;
  try {
    await folderHandle.removeEntry(externalSaves[index].name);
    showToast(`已删除 ${externalSaves[index].name}`);
    await refreshExternalSaves();
  } catch (e) {
    console.warn('删除外部存档失败:', e);
    showToast('删除失败，请检查权限');
  }
}

// 导出当前存档到外部文件夹
async function exportToExternalFolder() {
  if (!folderHandle) {
    showToast('请先绑定文件夹');
    return;
  }

  // 获取当前存档名称
  const activeSlot = getActiveSlot();
  let slotName = '';
  if (activeSlot) {
    const meta = getMeta();
    if (meta[activeSlot] && meta[activeSlot].name) {
      slotName = meta[activeSlot].name;
    }
  }

  // 生成时间戳
  const now = new Date();
  const ts = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') +
              '_' + String(now.getHours()).padStart(2,'0') + '-' + String(now.getMinutes()).padStart(2,'0');

  // 构建文件名
  let fileName = `深渊回廊_存档_${ts}.json`;
  if (slotName) {
    // 移除 Windows/Linux 文件名中的非法字符（保留中文和空格）
    const safeName = slotName.replace(/[\\/:*?"<>|]/g, '').trim();
    if (safeName) {
      fileName = `深渊回廊_存档_${safeName}_${ts}.json`;
    }
  }

  try {
    const exportData = safeClone(state);
    const jsonStr = JSON.stringify(exportData, null, 2);
    const fileHandle = await folderHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(jsonStr);
    await writable.close();
    showToast(`存档已导出至外部文件夹：${fileName}`);
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try { AbyssAudio.sfx('save'); } catch (e) { console.warn('[音效] 存档音效播放失败:', e); }
    }
    await refreshExternalSaves();
  } catch (e) {
    console.warn('导出到外部文件夹失败:', e);
    showToast('导出失败，请检查文件夹权限');
  }
}

// 检查浏览器是否支持 File System Access API（供 UI 显示）
function isFileSystemAccessSupported() {
  return !!window.showDirectoryPicker;
}

// 初始化外部同步（页面加载时恢复句柄）
async function initExternalSync() {
  const restored = await restoreFolderHandle();
  if (restored) {
    await refreshExternalSaves();
  } else {
    const infoEl = document.getElementById('externalSaveInfo');
    if (infoEl) infoEl.textContent = '未绑定（点击绑定文件夹）';
  }
  // 绑定按钮事件
  const bindBtn = document.getElementById('bindFolderBtn');
  if (bindBtn) bindBtn.addEventListener('click', bindFolder);
  const exportBtn = document.getElementById('exportToFolderBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportToExternalFolder);

  // ===== 传统导入绑定 =====
  const importBtn = document.getElementById('legacyImportBtn');
  const fileInput = document.getElementById('legacyFileInput');
  if (importBtn && fileInput) {
    importBtn.addEventListener('click', function(e) {
      fileInput.click();
    });
    fileInput.addEventListener('change', function(e) {
      const file = this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(ev) {
        try {
          const data = JSON.parse(ev.target.result);
          Object.assign(state, data);
          // 与 loadGame() 同一个坑：浅合并不会删掉旧键，外来档没有的字段会留下
          // 上一局的残留（最容易看出来的就是诅咒）。
          if (!Object.prototype.hasOwnProperty.call(data, '_rtCurses')) {
            state._rtCurses = [];
          }
          // 重新绑定英雄技能
          restoreHeroSkillBinding(state.hero);
          restoreHeroSkillBinding(state.trial && state.trial.hero);
          // 换了存档 = 换了本局 → 先让 2D 宿主停掉旧局（否则画布上还是旧战场）
          notifyHostRunReset();
          // ⚠️ 顺序不能动：补标记 → render → 补拉。
          //    补标记必须早于 render()，否则 render() 会因 currentRoom 为空而
          //    判定"不接管"，改写 mode 并收起画布（2D 就再也回不来了）。
          ensureHostRoomMark();
          render();
          ensureHostRunAlive();
          renderLog();
          renderRelics();
                showToast(`已成功导入存档：${file.name}`);
          saveGame();
          closeSaveManager();
        } catch (err) {
          console.warn('导入失败:', err);
          showToast('导入失败，文件格式不正确或已损坏');
        }
      };
      reader.onerror = function() {
        showToast('读取文件失败');
      };
      reader.readAsText(file);
      this.value = '';
    });
  }
  // ===== 下载存档（直接触发浏览器下载） =====
  const downloadBtn = document.getElementById('downloadArchiveBtn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', async function(e) {
      // 获取选中的导出格式
      const formatRadios = document.querySelectorAll('input[name="exportFormat"]');
      let format = 'json';
      for (const radio of formatRadios) {
        if (radio.checked) {
          format = radio.value;
          break;
        }
      }

      const activeSlot = getActiveSlot();
      let slotName = '';
      if (activeSlot) {
        const meta = getMeta();
        if (meta[activeSlot] && meta[activeSlot].name) {
          slotName = meta[activeSlot].name;
        }
      }
      const now = new Date();
      const ts = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') +
                  '_' + String(now.getHours()).padStart(2,'0') + '-' + String(now.getMinutes()).padStart(2,'0');
      let fileName = `深渊回廊_存档_${ts}.${format}`;
      if (slotName) {
        const safeName = slotName.replace(/[\\/:*?"<>|]/g, '').trim();
        if (safeName) {
          fileName = `深渊回廊_存档_${safeName}_${ts}.${format}`;
        }
      }

      try {
        const exportData = safeClone(state);
        const jsonStr = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonStr], { type: format === 'txt' ? 'text/plain' : 'application/json' });

        if (window.showSaveFilePicker) {
          try {
            const handle = await window.showSaveFilePicker({
              suggestedName: fileName,
              types: [{
                description: format === 'txt' ? '文本文件' : 'JSON 存档',
                accept: { [format === 'txt' ? 'text/plain' : 'application/json']: ['.' + format] }
              }]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            showToast('✅ 存档已保存到您选择的位置');
            return;
          } catch (err) {
            if (err.name === 'AbortError') return;
            console.warn('showSaveFilePicker 失败，回退到下载:', err);
          }
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        const extMsg = format === 'txt' ? '' : '';
        showToast(`✅ 存档下载触发：${fileName} ${extMsg}`);
      } catch (e) {
        console.warn('导出存档失败:', e);
        showToast('❌ 导出失败，请重试');
      }
    });
  }
}

// ============================================================
// 作弊系统
// ============================================================
const CHEAT_PASSWORD = '114514';  // 作弊密码
let cheatUnlocked = false;        // 是否已解锁
// 打开作弊面板
// 打开作弊面板
function openCheatModal() {
  if (!refs.cheatModal) return;
  // 重置状态
  cheatUnlocked = false;
  refs.cheatPasswordLayer.style.display = 'block';
  refs.cheatContentLayer.style.display = 'none';
  refs.cheatPasswordInput.value = '';
  refs.cheatPasswordError.style.display = 'none';
  
  // 填充当前数值到输入框（提前填充好，解锁后直接显示）
  const p = state.trial?.active ? state.trial.player : state.player;
  refs.cheatHp.value = p.hp;
  refs.cheatMaxHp.value = p.maxHp;
  refs.cheatAttack.value = p.attack;
  refs.cheatShield.value = p.shield;
  refs.cheatGold.value = p.gold;
  refs.cheatPotions.value = p.potions;
  refs.cheatStrengthPotions.value = p.strengthPotions;
  refs.cheatLucky.value = Math.min((state.luckyLevel || 0) * 10, 100);
  refs.cheatCritDamage.value = state.critDamage || 150;
  refs.cheatThorn.value = state.thornLevel || 0;
  refs.cheatVampire.value = state.vampireLevel || 0;
  refs.cheatDodge.value = Math.min((state.dodgeLevel || 0) * 5, 50);
  refs.cheatCombo.value = Math.min((state.comboLevel || 0) * 5, 40);
  refs.cheatExecute.value = Math.min((state.executeLevel || 0) * 5, 40);
  refs.cheatXp.value = state.player.xp || 0;
  
  // 试炼修改输入框填充
  const trialPointsInput = document.getElementById('cheatTrialPoints');
  const trialRoundsInput = document.getElementById('cheatTrialRounds');
  const trialFuryInput = document.getElementById('cheatTrialFury');
  if (state.trial?.active) {
    const t = state.trial;
    if (trialPointsInput) trialPointsInput.value = t.points;
    if (trialRoundsInput) trialRoundsInput.value = t.rounds;
    if (trialFuryInput) trialFuryInput.value = t.fury;
  }

  // 填充遗物下拉
  populateCheatRelicSelect();
  populateCheatBonusSelect();

  // ⚠️ 这里原来还有一段「填充永久解锁数据」（loadTrialUnlocks + cheatPermAttack 等 6 个输入框）。
  //    那两块内容在 P4-1 就已经从 DOM 里删掉了（试炼关停），但**这段填充代码当时漏删** ——
  //    后果不是"少填几个框"，而是 openCheatModal() 一进来就抛 ReferenceError，
  //    后面那句 `refs.cheatModal.classList.remove('hidden')` 永远执行不到 →
  //    **新版作弊面板根本打不开**。这正是第 8 条"作弊没有正确完整合并"的真身。

  refs.cheatModal.classList.remove('hidden');
  refs.cheatPasswordInput.focus();
}

// 验证密码
function verifyCheatPassword() {
  const input = refs.cheatPasswordInput;
  const error = refs.cheatPasswordError;
  
  if (input.value === CHEAT_PASSWORD) {
    cheatUnlocked = true;
    refs.cheatPasswordLayer.style.display = 'none';
    refs.cheatContentLayer.style.display = 'block';
    error.style.display = 'none';
    addLog('🔓 作弊面板已解锁');
  } else {
    error.style.display = 'block';
    input.value = '';
    input.focus();
    // 3秒后自动隐藏错误提示
    setTimeout(() => {
      error.style.display = 'none';
    }, 3000);
  }
}

// 关闭作弊面板
function closeCheatModal() {
  if (!refs.cheatModal) return;
  
  // 获取模态框内容元素
  const modalContent = refs.cheatModal.querySelector('.modal-content');
  const backdrop = refs.cheatModal.querySelector('.modal-backdrop');
  
  // 添加淡出动画（和打开时相反）
  if (modalContent) {
    modalContent.style.animation = 'contentOut 0.3s ease forwards';
  }
  if (backdrop) {
    backdrop.style.animation = 'backdropOut 0.3s ease forwards';
  }
  
  // 延迟真正的关闭，让动画完成
  setTimeout(() => {
    refs.cheatModal.classList.add('hidden');
    // 重置动画，以便下次打开
    if (modalContent) {
      modalContent.style.animation = '';
    }
    if (backdrop) {
      backdrop.style.animation = '';
    }
  }, 300);
}

// 填充遗物下拉
function populateCheatRelicSelect() {
  const select = refs.cheatRelicSelect;
  if (!select) return;
  select.innerHTML = '';
  const relics = getRelicOptions();
  relics.forEach((relic, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = `${relic.label} (${relic.rarity === 'rare' ? '稀有' : '普通'})`;
    select.appendChild(option);
  });
}

// 填充增益下拉
function populateCheatBonusSelect() {
  const select = refs.cheatBonusSelect;
  if (!select) return;
  select.innerHTML = '';
  const allBonuses = getBonusChoices();
  // 获取完整的增益列表
  const fullBonuses = [
    { id: 'start_shield', title: '初始护盾', description: '开局获得 5 点额外护盾' },
    { id: 'start_hp', title: '生命强化', description: '开局生命上限 +5' },
    { id: 'start_attack', title: '攻击强化', description: '开局攻击 +2' },
    { id: 'start_potion', title: '药水优势', description: '开局获得 1 瓶额外治疗药水' },
    { id: 'start_gold', title: '财富起点', description: '开局获得 15 金币' },
    { id: 'start_relic', title: '遗物预感', description: '开局获得一件随机遗物' },
    { id: 'start_potions2', title: '药剂充足', description: '开局获得 2 瓶额外治疗药水' },
    { id: 'start_luck', title: '幸运开端', description: '开局获得 20 金币' },
    { id: 'start_toughness', title: '铁血体质', description: '开局生命上限 +8' },
    { id: 'start_relic2', title: '遗物侥幸', description: '开局获得两件随机遗物' },
    { id: 'start_shield2', title: '坚韧护盾', description: '开局获得 8 点护盾' },
    { id: 'start_heal', title: '活力冲刺', description: '开局恢复 10 点生命' },
    { id: 'start_power', title: '战斗冲锋', description: '开局攻击 +3' },
    { id: 'start_explorer', title: '探索者', description: '开局获得 10 金币和 1 瓶治疗药水' },
    { id: 'start_fortify', title: '防御强化', description: '开局获得 3 点额外护盾和 2 点攻击' },
    { id: 'start_vigor', title: '生命活力', description: '开局生命上限 +6 并恢复 6 点生命' },
    { id: 'crit_damage', title: '致命打击', description: '暴击伤害 +20%' },
    { id: 'vampire', title: '吸血之刃', description: '攻击时恢复 2 点生命' },
    { id: 'thorn', title: '荆棘护甲', description: '受到攻击反弹 2 点伤害' },
    { id: 'life_shield', title: '生命护盾', description: '每回合获得 2 点护盾' },
    { id: 'double_gold', title: '双倍金币', description: '战斗金币 +50%' },
    { id: 'exp_boost', title: '经验加成', description: '获得额外经验' },
    { id: 'lucky', title: '会心一击', description: '暴击率 +10%' },
    { id: 'ancient_bless', title: '古神眷顾', description: '古老祭坛25%不扣血,15%双倍遗物,1%四倍遗物' },
    { id: 'lucky2', title: '暴击强化', description: '暴击率 +10%' },
    { id: 'thorn2', title: '荆棘强化', description: '反弹伤害 +1' },
    { id: 'vampire2', title: '吸血强化', description: '吸血 +1' },
  ];
  fullBonuses.forEach((bonus) => {
    const option = document.createElement('option');
    option.value = bonus.id;
    option.textContent = `${bonus.title} (${bonus.description})`;
    select.appendChild(option);
  });
}

// 应用数值修改
function applyCheatStats() {
  // 判断试炼模式
  if (state.trial?.active) {
    const tp = state.trial.player;
    // 读取输入框值，修改 trial.player
    tp.hp = Math.max(1, parseInt(refs.cheatHp.value) || tp.hp);
    tp.maxHp = Math.max(1, parseInt(refs.cheatMaxHp.value) || tp.maxHp);
    tp.attack = Math.max(0, parseInt(refs.cheatAttack.value) || tp.attack);
    tp.shield = Math.max(0, parseInt(refs.cheatShield.value) || tp.shield);
    tp.gold = Math.max(0, parseInt(refs.cheatGold.value) || tp.gold);
    tp.potions = Math.max(0, parseInt(refs.cheatPotions.value) || tp.potions);
    tp.strengthPotions = Math.max(0, parseInt(refs.cheatStrengthPotions.value) || tp.strengthPotions);
    tp.xp = Math.max(0, parseInt(refs.cheatXp.value) || 0);

    const luckyVal = Math.min(100, Math.max(0, parseInt(refs.cheatLucky.value) || 0));
    state.trial.luckyLevel = luckyVal / 10;
    const dodgeVal = Math.min(50, Math.max(0, parseInt(refs.cheatDodge.value) || 0));
    state.trial.dodgeLevel = dodgeVal / 5;
    const comboVal = Math.min(40, Math.max(0, parseInt(refs.cheatCombo.value) || 0));
    state.trial.comboLevel = comboVal / 5;
    const executeVal = Math.min(40, Math.max(0, parseInt(refs.cheatExecute.value) || 0));
    state.trial.executeLevel = executeVal / 5;

    state.trial.critDamage = Math.max(100, parseInt(refs.cheatCritDamage.value) || 150);
    state.trial.thornLevel = Math.max(0, parseInt(refs.cheatThorn.value) || 0);
    state.trial.vampireLevel = Math.max(0, parseInt(refs.cheatVampire.value) || 0);

    tp.hp = Math.min(tp.hp, tp.maxHp);

    addLog('🔧 已通过作弊修改试炼数值');
    showToast('✅ 试炼数值已修改！');
    if (state.trial?.active && state.environment) {
      const envEl = document.getElementById('trialEnvironment');
      if (envEl && state.environment.displayValue) {
        envEl.textContent = `环境：${state.environment.name} (${state.environment.displayValue})`;
      }
    }
    saveGame();
    return; // 结束
  }

  // ===== 经典模式 =====
  const p = state.player;
  p.hp = Math.max(1, parseInt(refs.cheatHp.value) || p.hp);
  p.maxHp = Math.max(1, parseInt(refs.cheatMaxHp.value) || p.maxHp);
  p.attack = Math.max(0, parseInt(refs.cheatAttack.value) || p.attack);
  p.shield = Math.max(0, parseInt(refs.cheatShield.value) || p.shield);
  p.gold = Math.max(0, parseInt(refs.cheatGold.value) || p.gold);
  p.potions = Math.max(0, parseInt(refs.cheatPotions.value) || p.potions);
  p.strengthPotions = Math.max(0, parseInt(refs.cheatStrengthPotions.value) || p.strengthPotions);
  p.xp = Math.max(0, parseInt(refs.cheatXp.value) || 0);

  const luckyVal = Math.min(100, Math.max(0, parseInt(refs.cheatLucky.value) || 0));
  state.luckyLevel = luckyVal / 10;
  const dodgeVal = Math.min(50, Math.max(0, parseInt(refs.cheatDodge.value) || 0));
  state.dodgeLevel = dodgeVal / 5;
  const comboVal = Math.min(40, Math.max(0, parseInt(refs.cheatCombo.value) || 0));
  state.comboLevel = comboVal / 5;
  const executeVal = Math.min(40, Math.max(0, parseInt(refs.cheatExecute.value) || 0));
  state.executeLevel = executeVal / 5;

  state.critDamage = Math.max(100, parseInt(refs.cheatCritDamage.value) || 150);
  state.thornLevel = Math.max(0, parseInt(refs.cheatThorn.value) || 0);
  state.vampireLevel = Math.max(0, parseInt(refs.cheatVampire.value) || 0);

  p.hp = Math.min(p.hp, p.maxHp);

  addLog('🔧 已通过作弊修改数值');
  showToast('✅ 数值已修改！');
  render();
  saveGame();
}

function cheatClearCurses() {
  if (!state.trial?.active) return;
  state.trial.curses = [];
  addLog('🔧 已清除所有诅咒');
  renderTrialUI();
  showToast('✅ 诅咒已清除');
  saveGame();
}

// 应用试炼修改（作弊面板）
function applyCheatTrial() {
  if (!state.trial?.active) {
    showToast('⚠️ 当前未处于试炼模式');
    return;
  }

  const t = state.trial;

  const pointsInput = document.getElementById('cheatTrialPoints');
  const roundsInput = document.getElementById('cheatTrialRounds');
  const furyInput = document.getElementById('cheatTrialFury');
  const curseInput = document.getElementById('cheatTrialCurseInput');

  if (pointsInput) {
    const val = parseInt(pointsInput.value);
    if (!isNaN(val) && val >= 0) t.points = val;
  }
  if (roundsInput) {
    const val = parseInt(roundsInput.value);
    if (!isNaN(val) && val >= 0) t.rounds = val;
  }
  if (furyInput) {
    const val = parseInt(furyInput.value);
    if (!isNaN(val) && val >= 0 && val <= t.furyMax) t.fury = val;
  }
  if (curseInput) {
    const curseNames = curseInput.value.split(',').map(s => s.trim()).filter(Boolean);
    curseNames.forEach(name => {
      const curse = window.TRIAL_CURSES.find(c => c.name === name);
      if (curse && !t.curses.some(c => c.name === name)) {
        t.curses.push({ ...curse });
        addLog(`作弊添加诅咒：${name}`);
      }
    });
    applyTrialCurses();
  }

  renderTrialUI();
  showToast('✅ 试炼修改已应用');
  saveGame();
}

// 试炼模式下应用遗物效果（手动映射）
function applyTrialRelicEffect(relic) {
  const t = state.trial;
  const label = relic.label;
  switch (label) {
    case '战斗怒火':
      t.player.attack += 1;
      break;
    case '幸运硬币':
      t.player.gold += 10;
      addLog('幸运硬币给予了你 10 金币。');
      break;
    case '坚固护符':
      t.player.shield += 3;
      addLog('坚固护符为你提供了 3 点护盾。');
      break;
    case '生命结晶':
      t.player.maxHp += 6;
      t.player.hp = Math.min(t.player.maxHp, t.player.hp + 6);
      addLog('生命结晶提升了你的生命上限并恢复生命。');
      break;
    case '铁卫纹章':
      t.player.attack += 1;
      addLog('铁卫纹章使你的攻击力提升。');
      break;
    case '狂战之心':
      if ((t.comboLevel || 0) < 8) {
        t.comboLevel = Math.min((t.comboLevel || 0) + 1, 8);
        t.comboDamageBonus = (t.comboDamageBonus || 0) + 10;
        addLog(`狂战之心：连击率+5%，连击伤害+10%，当前连击伤害 ${50 + (t.comboDamageBonus || 0)}%`);
      } else {
        addLog('连击率已达上限40%，狂战之心无法生效。');
      }
      break;
    case '双刃匕首':
      if ((t.comboLevel || 0) < 8) {
        t.comboLevel = Math.min((t.comboLevel || 0) + 1, 8);
      }
      t.hasFirstAttackCombo = true;
      addLog(`双刃匕首：连击率+5%，首次攻击必定连击！`);
      break;
    case '猎杀标记':
      t.executeThreshold = 0.5;
      addLog(`猎杀标记：斩杀线提升至 50%！`);
      break;
    case '完美之刃':
      let anyApplied = false;
      if ((t.dodgeLevel || 0) < 10) {
        t.dodgeLevel = Math.min((t.dodgeLevel || 0) + 2, 10);
        anyApplied = true;
      }
      if ((t.comboLevel || 0) < 8) {
        t.comboLevel = Math.min((t.comboLevel || 0) + 2, 8);
        anyApplied = true;
      }
      if ((t.executeLevel || 0) < 8) {
        t.executeLevel = Math.min((t.executeLevel || 0) + 2, 8);
        anyApplied = true;
      }
      if (anyApplied) {
        addLog(`完美之刃：属性全面提升！`);
      } else {
        addLog('完美之刃：所有属性均已达到上限，遗物无效。');
      }
      break;
    case '不死图腾':
      t.hasTotem = true;
      addLog(`不死图腾：你获得了一次免死机会！`);
      break;
    case '斩杀之镰':
      t.hasKillScythe = true;
      addLog(`斩杀之镰：斩杀成功后攻击 +1！`);
      break;
    case '命运轮盘':
      t.hasFateWheel = true;
      addLog(`命运轮盘已装备！`);
      break;
    case '试炼护盾':
      t.hasTrialShield = true;
      break;
    case '试炼印记':
      t.hasTrialPoint = true;
      break;
    case '试炼生命':
      t.hasTrialHeal = true;
      break;
    case '试炼利刃':
      t.player.attack += 1;
      break;
    case '试炼幸运':
      if ((t.luckyLevel || 0) < 10) {
        t.luckyLevel = Math.min((t.luckyLevel || 0) + 0.5, 10); // +5% 暴击
        addLog(`试炼幸运：暴击率提升 5%，当前 ${(t.luckyLevel * 10).toFixed(0)}%`);
      } else {
        addLog('暴击率已达 100%，试炼幸运无效');
      }
      break;
    case '丰饶印记':
      t.hasTrialSeed = true;
      break;
    case '契约印记':
      t.hasFloorContract = true;
      break;
    default:
      // 若未匹配，可尝试调用原始 apply
      addLog(`试炼模式暂未适配遗物 "${label}" 的直接效果，但已添加到遗物列表。`);
      break;
  }
}

function cheatAddRelic() {
  const select = refs.cheatRelicSelect;
  if (!select) return;
  const index = parseInt(select.value);
  const relics = getRelicOptions();
  if (index >= 0 && index < relics.length) {
    const relic = relics[index];

    if (state.trial?.active) {
      // 试炼模式：添加到 trial.relics 并手动应用效果
      state.trial.relics.push({ ...relic });
      applyTrialRelicEffect(relic);
      addLog(`🔧 通过作弊获得遗物：${relic.label}（试炼）`);
      showToast(`✅ 获得遗物：${relic.label}`);
        saveGame();
      return;
    }

    // ---------- 经典模式 ----------
    state.relics.push(relic);
    relic.apply();
    addLog(`🔧 通过作弊获得遗物：${relic.label}`);
    showToast(`✅ 获得遗物：${relic.label}`);
    render();
    renderRelics();
    saveGame();
  }
}

// 试炼模式下应用增益效果（根据 bonusId 手动映射）
function applyTrialBonusEffect(bonusId) {
  const t = state.trial;
  switch (bonusId) {
    case 'start_shield':
      t.player.shield += 5;
      break;
    case 'start_hp':
      t.player.maxHp += 5;
      t.player.hp += 5;
      break;
    case 'start_attack':
      t.player.attack += 2;
      break;
    case 'start_potion':
      t.player.potions += 1;
      break;
    case 'start_gold':
      t.player.gold += 15;
      break;
    case 'start_relic':
      // 遗物预感：添加一件随机遗物（试炼版本）
      // 由于遗物添加逻辑较复杂，这里简单提示，或可调用通用遗物添加
      addLog('试炼模式暂不支持通过增益“遗物预感”添加遗物，请使用遗物作弊。');
      break;
    case 'start_potions2':
      t.player.potions += 2;
      break;
    case 'start_luck':
      t.player.gold += 20;
      break;
    case 'start_toughness':
      t.player.maxHp += 8;
      t.player.hp += 8;
      break;
    case 'start_relic2':
      addLog('试炼模式暂不支持通过增益“遗物侥幸”添加遗物，请使用遗物作弊。');
      break;
    case 'start_shield2':
      t.player.shield += 8;
      break;
    case 'start_heal':
      t.player.hp = Math.min(t.player.maxHp, t.player.hp + 10);
      break;
    case 'start_power':
      t.player.attack += 3;
      break;
    case 'start_explorer':
      t.player.gold += 10;
      t.player.potions += 1;
      break;
    case 'start_fortify':
      t.player.shield += 3;
      t.player.attack += 2;
      break;
    case 'start_vigor':
      t.player.maxHp += 6;
      t.player.hp += 6;
      break;
    case 'crit_damage':
      t.critDamage = (t.critDamage || 150) + 20;
      addLog(`💢 暴击伤害提升至 ${t.critDamage}%`);
      break;
    case 'vampire':
      t.vampireLevel = (t.vampireLevel || 0) + 1;
      addLog('获得吸血之刃，攻击恢复2点生命');
      break;
    case 'thorn':
      t.thornLevel = (t.thornLevel || 0) + 1;
      addLog('获得荆棘护甲，反弹2点伤害');
      break;
    case 'life_shield':
      t.hasLifeShield = true;
      addLog('获得生命护盾，每回合+2护盾');
      break;
    case 'double_gold':
      t.hasDoubleGold = true;
      addLog('获得双倍金币');
      break;
    case 'exp_boost':
      t.hasExpBoost = true;
      addLog('获得经验加成');
      break;
    case 'lucky':
      if ((t.luckyLevel || 0) < 10) {
        t.luckyLevel = Math.min((t.luckyLevel || 0) + 1, 10);
        addLog(`🎯 暴击率提升 10%，当前 ${(t.luckyLevel * 10).toFixed(1)}%`);
      } else {
        addLog('暴击率已达100%，无法继续提升。');
      }
      break;
    case 'ancient_bless':
      t.hasAncientBless = true;
      addLog('获得古神眷顾');
      break;
    case 'lucky2':
      if ((t.luckyLevel || 0) < 10) {
        t.luckyLevel = Math.min((t.luckyLevel || 0) + 1, 10);
        addLog(`🎯 暴击率提升 10%，当前 ${(t.luckyLevel * 10).toFixed(1)}%`);
      } else {
        addLog('暴击率已达100%，无法继续提升。');
      }
      break;
    case 'thorn2':
      t.thornLevel = (t.thornLevel || 0) + 1;
      addLog('反弹伤害+1');
      break;
    case 'vampire2':
      t.vampireLevel = (t.vampireLevel || 0) + 1;
      addLog('吸血+1');
      break;
    case 'dodge':
      if ((t.dodgeLevel || 0) < 10) {
        t.dodgeLevel = Math.min((t.dodgeLevel || 0) + 1, 10);
        addLog(`💨 闪避率提升 5%，当前 ${(t.dodgeLevel * 5).toFixed(0)}%`);
      } else {
        addLog('闪避率已达50%，无法继续提升。');
      }
      break;
    case 'combo':
      if ((t.comboLevel || 0) < 8) {
        t.comboLevel = Math.min((t.comboLevel || 0) + 1, 8);
        addLog(`⚡ 连击率提升 5%，当前 ${(t.comboLevel * 5).toFixed(0)}%`);
      } else {
        addLog('连击率已达40%，无法继续提升。');
      }
      break;
    case 'execute':
      if ((t.executeLevel || 0) < 8) {
        t.executeLevel = Math.min((t.executeLevel || 0) + 1, 8);
        addLog(`🗡️ 斩杀率提升 5%，当前 ${(t.executeLevel * 5).toFixed(0)}%`);
      } else {
        addLog('斩杀率已达40%，无法继续提升。');
      }
      break;
    default:
      addLog(`试炼模式未适配增益 "${bonusId}"`);
      break;
  }
}

// 通过作弊添加增益
function cheatAddBonus() {
  const select = refs.cheatBonusSelect;
  if (!select) return;
  const bonusId = select.value;

  // ===== 试炼模式分支 =====
  if (state.trial?.active) {
    // 应用效果
    applyTrialBonusEffect(bonusId);
    
    // 查找增益标题（用于显示）
    const fullBonuses = [
      { id: 'start_shield', title: '初始护盾' },
      { id: 'start_hp', title: '生命强化' },
      { id: 'start_attack', title: '攻击强化' },
      { id: 'start_potion', title: '药水优势' },
      { id: 'start_gold', title: '财富起点' },
      { id: 'start_relic', title: '遗物预感' },
      { id: 'start_potions2', title: '药剂充足' },
      { id: 'start_luck', title: '幸运开端' },
      { id: 'start_toughness', title: '铁血体质' },
      { id: 'start_relic2', title: '遗物侥幸' },
      { id: 'start_shield2', title: '坚韧护盾' },
      { id: 'start_heal', title: '活力冲刺' },
      { id: 'start_power', title: '战斗冲锋' },
      { id: 'start_explorer', title: '探索者' },
      { id: 'start_fortify', title: '防御强化' },
      { id: 'start_vigor', title: '生命活力' },
      { id: 'crit_damage', title: '致命打击' },
      { id: 'vampire', title: '吸血之刃' },
      { id: 'thorn', title: '荆棘护甲' },
      { id: 'life_shield', title: '生命护盾' },
      { id: 'double_gold', title: '双倍金币' },
      { id: 'exp_boost', title: '经验加成' },
      { id: 'lucky', title: '会心一击' },
      { id: 'ancient_bless', title: '古神眷顾' },
      { id: 'lucky2', title: '暴击强化' },
      { id: 'thorn2', title: '荆棘强化' },
      { id: 'vampire2', title: '吸血强化' },
      { id: 'dodge', title: '闪避之舞' },
      { id: 'combo', title: '连击之刃' },
      { id: 'execute', title: '斩杀之心' },
    ];
    const bonusInfo = fullBonuses.find(b => b.id === bonusId);
    const title = bonusInfo ? bonusInfo.title : bonusId;
    
    // 添加到 trial.bonuses 以便显示
    if (!state.trial.bonuses.some(b => b.title === title)) {
      state.trial.bonuses.push({ title, description: '' });
    }
    addLog(`🔧 通过作弊获得增益：${title}（试炼）`);
    showToast(`✅ 获得增益：${title}`);
    saveGame();
    return;
  }

  // ===== 经典模式 =====
  const fullBonuses = [
    { id: 'start_shield', title: '初始护盾', apply: () => { state.player.shield += 5; } },
    { id: 'start_hp', title: '生命强化', apply: () => { state.player.maxHp += 5; state.player.hp += 5; } },
    { id: 'start_attack', title: '攻击强化', apply: () => { state.player.attack += 2; } },
    { id: 'start_potion', title: '药水优势', apply: () => { addPotion('heal', 1); } },
    { id: 'start_gold', title: '财富起点', apply: () => { state.player.gold += 15; } },
    { id: 'start_relic', title: '遗物预感', apply: () => { chooseRelic(Math.floor(Math.random() * getRelicOptions().length), false); } },
    { id: 'start_potions2', title: '药剂充足', apply: () => { addPotion('heal', 2); } },
    { id: 'start_luck', title: '幸运开端', apply: () => { state.player.gold += 20; } },
    { id: 'start_toughness', title: '铁血体质', apply: () => { state.player.maxHp += 8; state.player.hp += 8; } },
    { id: 'start_relic2', title: '遗物侥幸', apply: () => { chooseRelic(Math.floor(Math.random() * getRelicOptions().length), false); chooseRelic(Math.floor(Math.random() * getRelicOptions().length), false); } },
    { id: 'start_shield2', title: '坚韧护盾', apply: () => { state.player.shield += 8; } },
    { id: 'start_heal', title: '活力冲刺', apply: () => { state.player.hp = Math.min(state.player.maxHp, state.player.hp + 10); } },
    { id: 'start_power', title: '战斗冲锋', apply: () => { state.player.attack += 3; } },
    { id: 'start_explorer', title: '探索者', apply: () => { state.player.gold += 10; addPotion('heal', 1); } },
    { id: 'start_fortify', title: '防御强化', apply: () => { state.player.shield += 3; state.player.attack += 2; } },
    { id: 'start_vigor', title: '生命活力', apply: () => { state.player.maxHp += 6; state.player.hp += 6; } },
    { id: 'crit_damage', title: '致命打击', apply: () => { state.critDamage = (state.critDamage || 150) + 20; addLog(`💢 暴击伤害提升至 ${state.critDamage}%`); spawnDamageFloat('+20%', 'crit'); } },
    { id: 'vampire', title: '吸血之刃', apply: () => { state.vampireLevel = (state.vampireLevel || 0) + 1; addLog('获得吸血之刃，攻击恢复2点生命'); spawnDamageFloat(2, 'vampire'); } },
    { id: 'thorn', title: '荆棘护甲', apply: () => { state.thornLevel = (state.thornLevel || 0) + 1; addLog('获得荆棘护甲，反弹2点伤害'); spawnDamageFloat(2, 'thorn'); } },
    { id: 'life_shield', title: '生命护盾', apply: () => { state.hasLifeShield = true; addLog('获得生命护盾，每回合+2护盾'); } },
    { id: 'double_gold', title: '双倍金币', apply: () => { state.hasDoubleGold = true; addLog('获得双倍金币'); } },
    { id: 'exp_boost', title: '经验加成', apply: () => { state.hasExpBoost = true; addLog('获得经验加成'); } },
    { id: 'lucky', title: '会心一击', apply: () => { addLuckyLevel(1, '开局增益'); } },
    { id: 'ancient_bless', title: '古神眷顾', apply: () => { state.hasAncientBless = true; addLog('获得古神眷顾'); } },
    { id: 'lucky2', title: '暴击强化', apply: () => { addLuckyLevel(1, '开局增益'); } },
    { id: 'thorn2', title: '荆棘强化', apply: () => { state.thornLevel = (state.thornLevel || 0) + 1; addLog('反弹伤害+1'); spawnDamageFloat(1, 'thorn'); } },
    { id: 'vampire2', title: '吸血强化', apply: () => { state.vampireLevel = (state.vampireLevel || 0) + 1; addLog('吸血+1'); spawnDamageFloat(1, 'vampire'); } },
    // { id: 'dodge', title: '闪避之舞', apply: () => { addDodgeLevel(1, '开局增益'); } },
    // { id: 'combo', title: '连击之刃', apply: () => { addComboLevel(1, '开局增益'); } },
    // { id: 'execute', title: '斩杀之心', apply: () => { addExecuteLevel(1, '开局增益'); } },
  ];
  const bonus = fullBonuses.find(b => b.id === bonusId);
  if (bonus) {
    // 创建一个模拟的 bonus 对象并应用
    const mockBonus = {
      title: bonus.title,
      description: bonus.description || '',
      apply: bonus.apply
    };
    bonus.apply();
    // 添加到 bonuses 列表以便显示
    if (!state.bonuses.some(b => b.title === bonus.title)) {
      state.bonuses.push(mockBonus);
    }
    addLog(`🔧 通过作弊获得增益：${bonus.title}`);
    showToast(`✅ 获得增益：${bonus.title}`);
    render();
    renderBonusAndStats();
    saveGame();
  }
}

// ===== 应用永久修改（全局） =====
// ⚠️ 试炼永久解锁在 P5 已随试炼整体关停：DOM（cheatPerm* 输入框）、
//    loadTrialUnlocks / saveTrialUnlocks 三个东西现在都不存在了。
//    这里保留同名函数但改为安全提示 —— 一旦哪天又有人把按钮绑回来，
//    得到的是"一句说明"，而不是一个 ReferenceError 把整个面板带崩。
function applyCheatPerm() {
  showToast('永久解锁修改已随试炼模式关停');
}

// ===== 重置所有永久数据（全局） =====
// 同上：试炼永久解锁已关停，保留同名安全实现（原因见 applyCheatPerm 上方注释）。
function resetCheatPerm() {
  showToast('永久解锁修改已随试炼模式关停');
}


// ============================================================
// 统一事件绑定
// ============================================================
function bindAllEvents() {
  if (window._allEventsBound) return;
  window._allEventsBound = true;
  if (!window._unloadBound) {
    window._unloadBound = true;
    window.addEventListener('beforeunload', () => { try { saveGame(); } catch (e) {} });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { try { saveGame(); } catch (e) {} }
    });
  }

  // 存档管理模态框
  if (refs.saveManagerModal) {
      refs.saveManagerModal.addEventListener('click', function(e) {
          if (e.target.dataset.action === 'close-save-manager') {
              closeSaveManager();
          }
          if (e.target.classList.contains('modal-backdrop')) {
              closeSaveManager();
          }
      });
  }

  // ===== 图鉴返回按钮 =====
  if (refs.encyclopediaBackButton) {
    refs.encyclopediaBackButton.addEventListener('click', function backHandler() {
      if (state.encyclopediaState.viewMode === 'entries') {
        const list = refs.encyclopediaList;
        list.classList.add('fade-out');
        setTimeout(() => {
          state.encyclopediaState.viewMode = 'categories';
          state.encyclopediaState.currentCategory = null;
          renderEncyclopedia();
        }, 200);
      }
    });
  }

  // ===== 模式切换按钮 =====
  if (refs.modeToggle && !window._modeToggleBound) {
    refs.modeToggle.addEventListener('click', function modeHandler() {
      state.detailMode = !state.detailMode;
      addLog(state.detailMode ? '已切换到【详情模式】' : '已切换到【正常模式】');
      render();
    });
    window._modeToggleBound = true;
  }
  // ===== 教程按钮 =====
  // 入口位于侧边栏：点击时先关闭侧边栏，再启动新手引导
  if (refs.tutorialButton && !window._tutorialBtnBound) {
    window._tutorialBtnBound = true;
    refs.tutorialButton.addEventListener('click', function tutorialHandler() {
      if (window.sidebar && typeof window.sidebar.close === 'function') {
        window.sidebar.close();
      }
      startTutorial();
    });
  }

  // ===== 图鉴按钮 =====
  if (refs.encyclopediaButton) {
    refs.encyclopediaButton.addEventListener('click', openEncyclopediaModal);
  }

  // ===== 通关条件按钮 =====
  /*if (refs.conditionButton) {
    refs.conditionButton.addEventListener('click', openConditionsModal);
  }*/

  // ===== 更新日志按钮 =====
  if (refs.changelogButton) {
    refs.changelogButton.addEventListener('click', function changelogHandler(e) {
      e.stopPropagation();
      openChangelogModal();
    });
  }

  // ===== 手动存档按钮 =====
  if (refs.saveButton) {
    refs.saveButton.addEventListener('click', openSaveManager);
  }

  // ===== 难度选择下拉 =====
  if (refs.difficultySelect) {
    refs.difficultySelect.addEventListener('change', function diffHandler(event) {
      state.difficulty = event.target.value;
      const panel = document.getElementById('customDifficultyPanel');
      if (state.difficulty === 'custom') {
        panel.classList.remove('hidden');
      } else {
        panel.classList.add('hidden');
      }
      addLog(`难度调整为：${refs.difficultySelect.options[refs.difficultySelect.selectedIndex].text}`);
      render();
    });
  }

  // ===== 进入试炼按钮 =====
  // 试炼入口已关停（P5）：#trialButton 与它的绑定一并移除。
  // 注意这里没有留"兜底绑定"—— Trial.start 现在是空壳，绑上去只会多一个假入口。

  // ===== 模态框关闭事件 =====
  // 图鉴模态框
  if (refs.encyclopediaModal) {
    refs.encyclopediaModal.addEventListener('click', function encModalHandler(event) {
      if (event.target.dataset.action === 'close-encyclopedia') {
        closeEncyclopediaModal();
      }
      if (event.target.classList.contains('modal-backdrop')) {
        closeEncyclopediaModal();
      }
    });
  }

  // 通关条件模态框
  if (refs.conditionsModal) {
    refs.conditionsModal.addEventListener('click', function condModalHandler(event) {
      if (event.target.dataset.action === 'close-conditions') {
        closeConditionsModal();
      }
      if (event.target.classList.contains('modal-backdrop')) {
        closeConditionsModal();
      }
    });
  }

  // 更新日志模态框
  if (refs.changelogModal && !window._changelogEventsBound) {
    refs.changelogModal.addEventListener('click', function changelogModalHandler(event) {
      // 使用 closest 检测关闭按钮（兼容点击按钮内部文本的情况）
      const closeBtn = event.target.closest('[data-action="close-changelog"]');
      if (closeBtn) {
        closeChangelogModal();
        return;
      }
      if (event.target.classList.contains('modal-backdrop')) {
        closeChangelogModal();
        return;
      }
    });
    window._changelogEventsBound = true;
  }

  // 作弊模态框（内部按钮绑定在 openCheatModal 里，这里只处理关闭）
  if (refs.cheatModal) {
    refs.cheatModal.addEventListener('click', function cheatModalHandler(event) {
      if (event.target.dataset.action === 'close-cheat') {
        closeCheatModal();
      }
      if (event.target.classList.contains('modal-backdrop')) {
        closeCheatModal();
      }
    });
  }

  // ===== 侧边栏 =====
  initSidebar();

  // ===== 自定义难度折叠 =====
  initCustomDifficultyCollapse();

  // ===== 属性点击事件 =====
  bindAttributeClickEvents();

  // ===== 侧边栏中的作弊按钮 =====
  const sidebarCheatBtn = document.getElementById('cheatButton');
  if (sidebarCheatBtn) {
    sidebarCheatBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      // 关闭侧边栏
      if (window.sidebar && typeof window.sidebar.close === 'function') {
        window.sidebar.close();
      }
      // 打开作弊面板
      openCheatModal();
    });
  }
  // ===== 侧边栏中的通关条件按钮 =====
  const sidebarConditionBtn = document.getElementById('sidebarConditionButton');
  if (sidebarConditionBtn) {
    sidebarConditionBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (window.sidebar && typeof window.sidebar.close === 'function') {
        window.sidebar.close();
      }
      openConditionsModal();
    });
  }
  // ===== 侧边栏中的设置按钮 =====
  if (!window._settingsBtnBound) {
      window._settingsBtnBound = true;
      const sidebarSettingsBtn = document.getElementById('settingsButton');
      if (sidebarSettingsBtn) {
          sidebarSettingsBtn.addEventListener('click', function(e) {
              e.stopPropagation();
              if (window.sidebar && typeof window.sidebar.close === 'function') {
                  window.sidebar.close();
              }
              openSettingsModal();
          });
      }
  }
}
// ============================================================
// 重新绑定作弊面板事件
// ============================================================
function rebindCheatEvents() {
  // 密码确认按钮
  if (refs.cheatPasswordConfirm) {
    // 移除旧监听器（通过替换整个元素或使用新的监听器）
    const newBtn = refs.cheatPasswordConfirm.cloneNode(true);
    refs.cheatPasswordConfirm.parentNode.replaceChild(newBtn, refs.cheatPasswordConfirm);
    refs.cheatPasswordConfirm = newBtn;
    refs.cheatPasswordConfirm.addEventListener('click', verifyCheatPassword);
  }
  
  // 密码输入框
  if (refs.cheatPasswordInput) {
    const newInput = refs.cheatPasswordInput.cloneNode(true);
    refs.cheatPasswordInput.parentNode.replaceChild(newInput, refs.cheatPasswordInput);
    refs.cheatPasswordInput = newInput;
    refs.cheatPasswordInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        verifyCheatPassword();
      }
    });
  }
  
  // 密码显示切换按钮
  if (refs.cheatPasswordToggle) {
    const newToggle = refs.cheatPasswordToggle.cloneNode(true);
    refs.cheatPasswordToggle.parentNode.replaceChild(newToggle, refs.cheatPasswordToggle);
    refs.cheatPasswordToggle = newToggle;
    refs.cheatPasswordToggle.addEventListener('click', () => {
      const input = refs.cheatPasswordInput;
      if (input.type === 'password') {
        input.type = 'text';
        refs.cheatPasswordToggle.textContent = '🙈';
      } else {
        input.type = 'password';
        refs.cheatPasswordToggle.textContent = '👁';
      }
    });
  }
  
  // 应用数值按钮
  if (refs.cheatApplyStats) {
    const newBtn = refs.cheatApplyStats.cloneNode(true);
    refs.cheatApplyStats.parentNode.replaceChild(newBtn, refs.cheatApplyStats);
    refs.cheatApplyStats = newBtn;
    refs.cheatApplyStats.addEventListener('click', applyCheatStats);
  }
  
  // 添加遗物按钮
  if (refs.cheatAddRelic) {
    const newBtn = refs.cheatAddRelic.cloneNode(true);
    refs.cheatAddRelic.parentNode.replaceChild(newBtn, refs.cheatAddRelic);
    refs.cheatAddRelic = newBtn;
    refs.cheatAddRelic.addEventListener('click', cheatAddRelic);
  }
  
  // 添加增益按钮
  if (refs.cheatAddBonus) {
    const newBtn = refs.cheatAddBonus.cloneNode(true);
    refs.cheatAddBonus.parentNode.replaceChild(newBtn, refs.cheatAddBonus);
    refs.cheatAddBonus = newBtn;
    refs.cheatAddBonus.addEventListener('click', cheatAddBonus);
  }

  // 应用试炼修改按钮
  const applyTrialBtn = document.getElementById('cheatApplyTrial');
  if (applyTrialBtn) {
    const newBtn = applyTrialBtn.cloneNode(true);
    applyTrialBtn.parentNode.replaceChild(newBtn, applyTrialBtn);
    newBtn.addEventListener('click', applyCheatTrial);
  }

  // 清除试炼诅咒按钮
  const clearCursesBtn = document.getElementById('cheatClearCurses');
  if (clearCursesBtn) {
    const newBtn = clearCursesBtn.cloneNode(true);
    clearCursesBtn.parentNode.replaceChild(newBtn, clearCursesBtn);
    newBtn.addEventListener('click', cheatClearCurses);
  }

  // 应用永久修改按钮
  const applyPermBtn = document.getElementById('cheatApplyPerm');
  if (applyPermBtn) {
    const newBtn = applyPermBtn.cloneNode(true);
    applyPermBtn.parentNode.replaceChild(newBtn, applyPermBtn);
    newBtn.addEventListener('click', applyCheatPerm);
  }

  // 重置永久修改按钮（元素已在 P4 移除 → 这里的 if 会静默跳过，留着不碍事）
  const resetPermBtn = document.getElementById('cheatResetPerm');
  if (resetPermBtn) {
    const newBtn = resetPermBtn.cloneNode(true);
    resetPermBtn.parentNode.replaceChild(newBtn, resetPermBtn);
    newBtn.addEventListener('click', resetCheatPerm);
  }

  // ===== 实时战斗区（P4：替代原「试炼修改 / 永久解锁修改」两块）=====
  bindCheatRealtimeEvents();
}

/**
 * 实时战斗区的绑定（P4）
 * 全部委托给宿主的 window.经典2D.cheat —— 内核不直接碰 2D 引擎的内部状态，
 * 这样"哪些作弊项在实时模式下真的有效"只有一处实现，不会两边漂移。
 */
function bindCheatRealtimeEvents() {
  function rb(id, ev, fn) {
    const el = document.getElementById(id);
    if (!el) return;
    const nl = el.cloneNode(true);
    el.parentNode.replaceChild(nl, el);
    nl.addEventListener(ev, fn);
  }
  rb('cheatRtApply', 'click', applyCheatRealtime);
  rb('cheatRtClearCurses', 'click', function () {
    const c = realtimeCheat();
    if (!c) return;
    c.clearCurses();
    addLog('（作弊）已清除所有诅咒');
    renderLog();
    showToast('已清除所有诅咒');
  });
  rb('cheatRtGod', 'change', function () {
    const c = realtimeCheat();
    if (!c) return;
    const on = c.god(this.checked);
    addLog('（作弊）无敌：' + (on ? '开' : '关'));
    renderLog();
  });
}

/** 取宿主的实时战斗接口；不在实时模式时给一句明确提示，而不是静默无效 */
function realtimeCheat() {
  if (window.经典2D && window.经典2D.cheat) return window.经典2D.cheat;
  showToast('实时战斗尚未启动（当前是回合制界面）');
  return null;
}

/** 应用实时战斗区的改动 */
function applyCheatRealtime() {
  const c = realtimeCheat();
  if (!c) return;
  const num = (id) => {
    const el = document.getElementById(id);
    if (!el || el.value === '') return null;
    const v = Number(el.value);
    return isFinite(v) ? v : null;
  };
  const hp = num('cheatRtHp');
  const maxHp = num('cheatRtMaxHp');
  const shield = num('cheatRtShield');
  const attack = num('cheatRtAttack');
  const floor = num('cheatRtFloor');
  const room = num('cheatRtRoom');
  // 先提上限再设当前值，否则「把血设成 999」会被旧上限截掉
  if (maxHp != null) c.setMaxHp(maxHp);
  if (hp != null) c.setHp(hp);
  if (shield != null) c.setShield(shield);
  if (attack != null) c.setAttack(attack);
  const relicInput = document.getElementById('cheatRtRelicInput');
  if (relicInput && relicInput.value.trim()) {
    const names = relicInput.value.split(/[，,;；|]/).map(x => x.trim()).filter(Boolean);
    let ok = 0;
    names.forEach(n => { if (c.addRelic(n)) ok += 1; });
    addLog(`（作弊）添加遗物 ${ok}/${names.length} 件`);
  }
  const curseInput = document.getElementById('cheatRtCurseInput');
  if (curseInput && curseInput.value.trim()) {
    const names = curseInput.value.split(/[，,;；|]/).map(x => x.trim()).filter(Boolean);
    let ok = 0;
    names.forEach(n => { if (c.addCurse(n)) ok += 1; });
    addLog(`（作弊）添加诅咒 ${ok}/${names.length} 条`);
  }
  if (floor != null) c.gotoFloor(floor);
  if (room != null) c.gotoRoom(room);
  renderLog();
  render();
  saveGame();
  showToast('实时战斗改动已应用');
}
// 加载游戏（从当前活跃槽位加载）
/**
 * 通知 2D 宿主：本局已经换了（切换存档 / 重置槽位 / 导入存档）
 * ------------------------------------------------------------
 * 引擎是**全局单例**、自己跑着自己那一局。内核这边把 state 换成另一份之后，
 * 如果不让宿主停下来重开，画面里还是**旧的那一局** ——
 * 实测：在 2D 里打开存档管理切槽位，数值确实变了，但战场纹丝不动、
 * 怪物还是原来那批，玩家会以为"切档没生效"。
 *
 * `经典2D.reset()` 会停掉引擎并清掉"已展示过的结局"等本局状态，
 * 随后的 render() 会用**新的 state** 重新开局（startRun 读的就是 state）。
 * 宿主不存在时静默跳过（老版 / 引擎被显式关掉的情况）。
 */
function notifyHostRunReset() {
    try {
        if (window.经典2D && typeof window.经典2D.reset === 'function') {
            window.经典2D.reset();
        }
    } catch (e) {
        console.warn('[2D] 重置宿主失败：', e);
    }
}

/**
 * 换局之后补一次「入场标记」
 * ------------------------------------------------------------
 * 引擎的接管判定里有一条：`if (!s.currentRoom) return false;`
 * （经典2D.js 的 shouldTakeOver —— "还没进第一间房就不接管"，对正常流程是对的）。
 * 而 currentRoom 是 **2D 自己的 rt:room 回调**写进 state 的：换进来的存档如果
 * 存的时候恰好不在房间里（刚打完层主、正在选结局、包抽/居间时刻），它就是 null。
 * 于是形成死锁：
 *
 *     不接管 → 不会 startRun → 永远不会产生 currentRoom → 永远不接管
 *
 * 表现就是「读档之后文字界面变了、2D 再也回不去」：render() 判定不接管之后
 * 会把 mode 从 'classic2d' 改回内核的 'event' 并把画布收起来，
 * 引擎则停在旧局原地不动（实测复现：takeOverReason='currentRoom=null'、
 * 引擎停在第 9 层，而 state.floor 已经是 12）。
 *
 * 这里按存档自己的 rooms / roomIndex 补一个入场标记，让判定能过。
 * ⚠️ 必须在 render() **之前**调 —— render() 一旦判定"不接管"就会改写 mode、
 *    收起画布，那时候再补就晚了（下一帧虽然会重新接管，但玩家已经看到画面闪没）。
 */
function ensureHostRoomMark() {
    try {
        var s = state;
        if (!s || s.currentRoom) return false;
        // 判据要与引擎的 shouldTakeOver() 对齐 —— 也就是"除了 currentRoom 之外，
        // 接管条件本来就都满足"。这里有三个坑：
        //  ① 不能拿 `mode === 'classic2d'` 当门票：'classic2d' 是**宿主自己的标记**，
        //     而引擎一旦判定不接管就会把它改回内核的 'event'（见 经典2D.js 的 render），
        //     于是"第一次没接上"之后，这个标记永远回不来 —— 修复本身被卡死。
        //     实测：一份正常存档里的 mode 就是 'event'。
        //  ② 内核自己的界面态（选英雄 / 选增益 / 开始 / 结算）确实不该补。
        //  ③ 必须真的在跑局：有房间表才算，否则可能是半截数据。
        if (!s.hero) return false;
        if (s.gameOver) return false;
        if (s.mode === 'heroSelect' || s.mode === 'bonusSelect' || s.mode === 'start' ||
            s.mode === 'gameover' || s.mode === 'finished') return false;
        if (!s.rooms || !s.rooms.length) return false;
        var idx = Math.max(0, Math.round(s.roomIndex || 0));
        var t = (s.rooms[idx] && s.rooms[idx].type) || 'enemy';
        s.currentRoom = { type: t };
        console.log('[存档] 换局后缺少入场标记（currentRoom=null），已按存档的房间表补上：第',
            (idx + 1), '间 ·', t, '· mode=' + s.mode);
        return true;
    } catch (e) {
        console.warn('[存档] 补入场标记失败：', e);
        return false;
    }
}

/**
 * 换局之后补一刀：该接管却没接管时，直接把 2D 重新拉起来
 * ------------------------------------------------------------
 * 为什么光靠 render() 不够：render() 里的接管判定（经典2D 的 shouldTakeOver）
 * 看的是 **state 自己的字段** —— mode / currentRoom / hero / gameOver。
 * 而"换局"的三种来源（切槽位 / 重置槽位 / **导入外部存档**）都是把一个**外来**
 * 的对象 Object.assign 到 state 上：外来档如果来自旧版本、或者存的时候正好不在
 * 房间里，这些字段就可能不满足判定。后果很难看懂 ——
 * 文字界面照常重绘（所以"看起来变了"），而 **2D 画面停在上一局的最后一帧**
 * （引擎根本没重开，canvas 上还是旧的一帧，不刷新永远不变）。用户反馈就是这个。
 *
 * 这里只做一件事：**先问引擎"你到底该不该接管、现在跑没跑"**，
 * 该接管却没跑才补一次 start()。判定交给引擎自己（debug().takeOver），
 * 所以选英雄 / 选增益 / 结算这些**本来就不该接管**的情形不会被误拉起来。
 */
function ensureHostRunAlive() {
    try {
        var h = window.经典2D;
        if (!h || typeof h.debug !== 'function' || typeof h.start !== 'function') return false;
        var d = h.debug();
        if (!d.enabled || !d.takeOver) return false;   // 本来就不该由 2D 接管
        if (d.running || d.booting) return true;        // 已经在跑 / 正在启动
        var ok = !!h.start();
        console.log('[存档] 换局后 2D 未接管，已补拉一次：', ok ? '成功' : '失败',
            '· takeOverReason=' + (d.takeOverReason || 'ready-to-start'));
        return ok;
    } catch (e) {
        console.warn('[2D] 补拉 2D 失败：', e);
        return false;
    }
}

function loadGame() {
    const activeSlot = getActiveSlot();
    if (!activeSlot) {
        console.log('没有活跃槽位，无法加载');
        return false;
    }
    const savedData = getSlotData(activeSlot);
    if (!savedData) {
        console.log(`槽位 ${activeSlot} 无数据`);
        return false;
    }
    try {
        Object.assign(state, savedData);
        // ⚠️ Object.assign 是**浅合并**：它只覆盖存进去有的键，**不会删除** state 上
        //    已有的键。于是"旧版本导出的档"（没有某些新字段）会把上一局的残留留下 ——
        //    与「重新开始后诅咒还在」是同一类问题，只是入口不同。
        //    这里对已知的本局性字段做一次兜底：档里没有就归零，而不是沿用旧值。
        if (!Object.prototype.hasOwnProperty.call(savedData, '_rtCurses')) {
            state._rtCurses = [];
        }
        // ===== 复活存档兼容：角色有生命值则视为存活 =====
        if (state.player && state.player.hp > 0) {
            state.gameOver = false;
        }
        state.customDifficulty = normalizeCustomDifficulty(state.customDifficulty || {});
        
        // 恢复试炼中的英雄技能
        if (state.trial && state.trial?.active && state.trial.hero && state.trial.hero.id) {
            restoreHeroSkillBinding(state.trial.hero);
        }
        
        // 恢复经典模式的英雄技能
        if (state.hero && state.hero.id) {
            const matchedHero = heroOptions.find(h => h.id === state.hero.id);
            if (matchedHero) {
                state.hero.name = matchedHero.name;
                state.hero.description = matchedHero.description;
                state.hero.stats = matchedHero.stats;
            }
            restoreHeroSkillBinding(state.hero);
        }
        
        // ===== 恢复 environment 钩子 =====
        if (state.environment && state.environment.name) {
        // 使用当前楼层和难度重新生成环境，但保持相同的 name
        const floor = state.floor || 1;
        const diff = state.difficulty || 'normal';
        // 重新生成环境
        const newEnv = generateEnvironmentEffect(floor, diff);
        // 如果新生成的环境名称与存档中的不同，则使用存档中的名称强制生成
        if (newEnv.name !== state.environment.name) {
            // 从 ENVIRONMENT_EFFECTS 中找到对应的模板
            const template = ENVIRONMENT_EFFECTS.find(e => e.name === state.environment.name);
            if (template) {
                const diffScale = (function() {
                    if (diff === 'easy') return 0.8;
                    if (diff === 'normal') return 1.0;
                    if (diff === 'hard') return 1.15;
                    if (diff === 'hell') return 1.25;
                    if (diff === 'custom') return state.customDifficulty.environmentScale || 1.0;
                    return 1.0;
                })();
                const envData = template.create(floor, diffScale);
                const restoredEnv = {
                    name: template.name,
                    description: template.description.replace('{value}', envData.display),
                    values: envData.values,
                    displayValue: envData.display,
                    damageModifier: envData.damageModifier || 0,
                    onCombatStart: envData.onCombatStart || null,
                    onPlayerAttack: envData.onPlayerAttack || null,
                    onEnemyTurn: envData.onEnemyTurn || null,
                    applyTurnEffects: envData.applyTurnEffects || null,
                    onHeal: envData.onHeal || null,
                    onVictory: envData.onVictory || null,
                    onPlayerDefend: envData.onPlayerDefend || null,
                    _floor: floor,
                    _diffScale: diffScale
                };
                state.environment = restoredEnv;
                console.log('✅ 环境效果已恢复（强制匹配）:', state.environment.name);
            } else {
                // 找不到对应模板，使用新生成的
                state.environment = newEnv;
                console.log('✅ 环境效果已恢复（使用新生成）:', state.environment.name);
            }
        } else {
            // 名称匹配，直接使用新生成的
            state.environment = newEnv;
            console.log('✅ 环境效果已恢复:', state.environment.name);
        }
      }
        
        // 恢复战斗中的环境
        if (state.combat && state.combat.environment && state.combat.environment.name) {
            const original = ENVIRONMENT_EFFECTS.find(e => e.name === state.combat.environment.name);
            if (original) {
                const floor = state.combat.environment._floor || state.floor || 1;
                const diffScale = state.combat.environment._diffScale || 1;
                const envData = original.create(floor, diffScale);
                const restoredEnv = {
                    name: original.name,
                    description: original.description.replace('{value}', envData.display),
                    values: envData.values,
                    displayValue: envData.display,
                    damageModifier: envData.damageModifier || 0,
                    onCombatStart: envData.onCombatStart || null,
                    onPlayerAttack: envData.onPlayerAttack || null,
                    onEnemyTurn: envData.onEnemyTurn || null,
                    applyTurnEffects: envData.applyTurnEffects || null,
                    onHeal: envData.onHeal || null,
                    onVictory: envData.onVictory || null,
                    onPlayerDefend: envData.onPlayerDefend || null,
                    _floor: floor,
                    _diffScale: diffScale
                };
                state.combat.environment = restoredEnv;
            }
        }

        // ===== 非战斗状态下清除残留的临时加成 =====
        if (state.mode !== 'combat') {
            if (state.player) {
                state.player.tempAttackBonus = 0;
                state.player.luckyBonus = 0;
                state.player.critDamageBonus = 0;
                state.player.comboBonus = 0;
                state.player.dodgeBonus = 0;
            }
        }

        state.records = state.records || {
            easy: { bestFloor: 0, clears: 0, deaths: 0 },
            normal: { bestFloor: 0, clears: 0, deaths: 0 },
            hard: { bestFloor: 0, clears: 0, deaths: 0 },
            hell: { bestFloor: 0, clears: 0, deaths: 0 }
        };
        state.log = state.log || [];
        state.shopPurchaseCount = state.shopPurchaseCount || {};
        state.shopLimitBonus = state.shopLimitBonus || 0;
        
        // 恢复 bonusSelect 界面
        if (state.mode === 'bonusSelect' && state.availableBonuses && state.availableBonuses.length > 0) {
            getBonusChoices();
            const allBonuses = window.__ALL_BONUSES || [];
            state.availableBonuses = state.availableBonuses.map(saved => {
                const matched = allBonuses.find(b => b.id === saved.id || b.title === saved.title);
                return matched || saved;
            }).filter(b => typeof b.apply === 'function');
            if (state.availableBonuses.length === 0) {
                addLog('⚠️ 存档中的增益选项已失效，已重新抽取。');
                state.availableBonuses = getBonusChoices();
            }
        }
        
        // 恢复 eventChoice 界面
        if (state.mode === 'eventChoice' && state.eventOptions && state.eventOptions.length > 0) {
            state.eventOptions = state.eventOptions.map(savedEvent => {
                const matched = ALL_EVENT_OPTIONS.find(e => e.label === savedEvent.label);
                if (matched && typeof matched.apply === 'function') {
                    return {
                        label: savedEvent.label,
                        description: savedEvent.description || matched.description,
                        apply: matched.apply
                    };
                }
                return {
                    ...savedEvent,
                    apply: () => {
                        addLog(`⚠️ 事件 "${savedEvent.label}" 无法恢复，已跳过`);
                        state.eventOptions = [];
                        state.mode = 'event';
                        advanceRoom();
                    }
                };
            });
        }
        
        // 恢复 reward 界面
        if (state.mode === 'reward' && state.rewardOptions && state.rewardOptions.length > 0) {
            const allRewards = buildRewardOptions();
            const savedLabels = state.rewardOptions.map(r => r.label === '药水 +1' ? '治疗药水 +1' : r.label);
            const matchedRewards = allRewards.filter(r => savedLabels.includes(r.label));
            if (matchedRewards.length === savedLabels.length) {
                state.rewardOptions = matchedRewards;
            } else {
                state.rewardOptions = state.rewardOptions.map(savedReward => {
                    const matched = allRewards.find(r => r.label === (savedReward.label === '药水 +1' ? '治疗药水 +1' : savedReward.label));
                    if (matched) {
                        return {
                            label: savedReward.label,
                            apply: matched.apply
                        };
                    }
                    return {
                        label: savedReward.label,
                        apply: () => {
                            addLog(`⚠️ 奖励 "${savedReward.label}" 已失效，跳过`);
                            state.rewardOptions = [];
                            state.mode = 'event';
                            advanceRoom();
                        }
                    };
                });
            }
        }
        
        // 恢复 bossVictory 界面
        if (state.mode === 'bossVictory' && state.rewardOptions && state.rewardOptions.length > 0) {
            const allRewards = buildRewardOptions();
            const savedLabels = state.rewardOptions.map(r => r.label === '药水 +1' ? '治疗药水 +1' : r.label);
            const matchedRewards = allRewards.filter(r => savedLabels.includes(r.label));
            if (matchedRewards.length === savedLabels.length) {
                state.rewardOptions = matchedRewards;
            } else {
                state.rewardOptions = state.rewardOptions.map(savedReward => {
                    const matched = allRewards.find(r => r.label === (savedReward.label === '药水 +1' ? '治疗药水 +1' : savedReward.label));
                    if (matched) {
                        return {
                            label: savedReward.label,
                            apply: matched.apply
                        };
                    }
                    return {
                        label: savedReward.label,
                        apply: () => {
                            addLog(`⚠️ 奖励 "${savedReward.label}" 已失效，跳过`);
                            state.rewardOptions = [];
                            if (state.endOptions && state.endOptions.length > 0) {
                                render();
                            } else {
                                state.mode = 'event';
                                advanceRoom();
                            }
                        }
                    };
                });
            }
        }
        
        // 加载后重新绑定界面功能
        setTimeout(() => {
            bindCustomDifficultyInputs();
            initSidebar();
            bindAttributeClickEvents();
            bindAllEvents();
            rebindCheatEvents();
            // 强制重新绑定 actionArea
            if (refs.actionArea) {
                const newActionArea = refs.actionArea.cloneNode(true);
                refs.actionArea.parentNode.replaceChild(newActionArea, refs.actionArea);
                refs.actionArea = newActionArea;
                refs.actionArea.addEventListener('click', handleAction);
            }
            render();
            renderLog();
            renderRelics();
            initTestPanelCommunication();
            initExternalSync();
        }, 100);
        if (state._savedAt) {
          console.log(`📥 存档时间：${new Date(state._savedAt).toLocaleString()}，槽位：${activeSlot}`);
        }
        if (state._sessionId && state._sessionId !== window._sessionId) {
          showToast('⚠️ 此存档曾被其他页面/标签页修改过，可能存在进度覆盖');
        }
        return true;
    } catch (e) {
        console.warn(`加载槽位 ${activeSlot} 失败:`, e);
        return false;
    }
}

// 删除存档（重新开始时调用，删除当前活跃槽位）
function deleteSave() {
    const activeSlot = getActiveSlot();
    if (activeSlot) {
        deleteSlot(activeSlot);
        setActiveSlot(null);
    }
    // 同时也清除旧存档（兼容）
    localStorage.removeItem(LEGACY_SAVE_KEY);
}

//统一"重新开始"入口：仅重置当前活跃槽位，其他槽位不受影响
function restartCurrentRun() {
    const s = getActiveSlot();
    const info = s ? getMeta()[s] : null;
    const desc = info
        ? `【${info.name || s}】${info.hero || '无英雄'} · 第 ${info.floor || 1} 层 ·${info.difficulty || 'normal'} · ${info.mode || '经典模式'}`
        : (s || '当前槽位');
    if (isSettingEnabled('restartConfirm')) {
      if (!confirm(`即将重置当前槽位 ${desc}\n\n其他存档槽不会受影响，确定继续？`)) return;
    }
    resetCurrentSlot();
}

// 重置当前存档（保留槽位，只清空进度）
function resetCurrentSlot() {
    const activeSlot = getActiveSlot();
    if (!activeSlot) {
        showToast('没有活跃存档可重置');
        return;
    }
    // 强制重置雾气
    const fog = document.querySelector('.fog-layer');
    if (fog) fog.classList.remove('active');
    // 重置 state 到初始状态
    state.player.hp = 24;
    state.player.maxHp = 24;
    state.player.attack = 5;
    state.player.shield = 0;
    state.player.gold = 0;
    state.player.level = 1;
    state.player.potions = 1;
    state.player.strengthPotions = 0;
    state.player.xp = 0;
    state.floor = 1;
    state.roomIndex = 0;
    state.vampireLevel = 0;
    state.thornLevel = 0;
    state.hasLifeShield = false;
    state.hasDoubleGold = false;
    state.hasExpBoost = false;
    state.luckyLevel = 0;
    state.critDamage = 150;
    state.hasAncientBless = false;
    state.dodgeLevel = 0;
    state.comboLevel = 0;
    state.executeLevel = 0;
    state.comboDamageBonus = 0;
    state.executeThreshold = 0.3;
    state.hasFirstAttackCombo = false;
    state.hasKillScythe = false;
    state.hasTotem = false;
    state.hasFateWheel = false;
    state.hasShadowDeal = false;
    state.isFirstAttack = true;
    state.rooms = generateFloorRooms(1);
    state.difficulty = 'normal';
    state.currentRoom = null;
    state.combat = null;
    state.rewardOptions = [];
    state.eventOptions = [];
    state.shopOptions = [];
    state.relics = [];
    state.shopPurchaseCount = {};
    state.shopLimitBonus = 0;
    state.gameOver = false;
    state.hero = null;
    state.heroSkillUsed = false;
    state.heroSkillBonus = 0;
    state.heroPendingHeal = 0;
    state.availableBonuses = [];
    state.bonuses = [];
    state.endOptions = [];
    state.endResult = null;
    state.mode = 'heroSelect';
    state.gugugagaAttackCount = 0;
    state._pendingGugugaga = false;
    state.log = [];
    state.pendingAttackBoost = 0;
    state.comboCount = 0;
    state.executeCount = 0;
    state.dodgeCount = 0;
    state.critCount = 0;
    state.enemyThorn = 0;
    state.enemyDodge = 0;
    state.enemyVampire = 0;
    state.enemyCombo = 0;
    state.enemyCrit = 0;
    state.enemyCritDamage = 150;
    state.hasKillScythe = false;
    state.hasFateWheel = false;
    state.hasShadowDeal = false;
    state.detailMode = false;
    state.encyclopediaState = { currentCategory: null, viewMode: 'categories' };
    state.environment = generateEnvironmentEffect(1, 'normal');
    // 实时化诅咒一并清空（第 1 条）：只重置 environment 不够 ——
    // 诅咒存在 state._rtCurses 里，不清的话「重新开始」之后新一局开局
    // 会把上一局的诅咒原样带进引擎（startRun 的 curses: rtCurses(s)）。
    state._rtCurses = [];
    state.customDifficulty = normalizeCustomDifficulty({ enabled: true });
    // 试炼状态重置


    // 更新元数据中的信息（保留名称，重置其他字段）
    const meta = getMeta();
    if (meta[activeSlot]) {
        meta[activeSlot].hero = '无';
        meta[activeSlot].floor = 1;
        meta[activeSlot].difficulty = 'normal';
        meta[activeSlot].mode = '经典模式';
        setMeta(meta);
    }

    // 保存新状态到当前槽位
    saveGame();

    // 重置试炼模块的依赖 —— 试炼已关停（P5），整块移除。

    // ⚠️ 本局已被重置（回到选英雄）→ 必须让 2D 宿主停掉旧局，
    //    否则画布还盖在最上面、显示着上一局的战场，玩家点不到下面的英雄按钮。
    notifyHostRunReset();

    // 关闭所有模态框
    closeSaveManager();
    closeCheatModal();
    // 隐藏试炼界面
    const trialScreen = document.getElementById('trialScreen');
    if (trialScreen) trialScreen.classList.add('hidden');
    // 显示经典界面
    const appShell = document.querySelector('.app-shell');
    if (appShell) appShell.style.display = '';
    const classicTopbar = document.querySelector('.topbar');
    if (classicTopbar) classicTopbar.style.display = '';

    // 强制刷新界面到英雄选择
    render();
    renderLog();
    renderRelics();

    // 同步难度下拉
    if (refs.difficultySelect) {
        refs.difficultySelect.value = 'normal';
    }
    // 隐藏自定义难度面板
    const customPanel = document.getElementById('customDifficultyPanel');
    if (customPanel) customPanel.classList.add('hidden');

    showToast('存档已重置，请选择英雄开始新游戏');
    addLog('🔄 当前存档已重置');
}

const roomTypeNames = {
  enemy: '敌袭',
  shop: '商店',
  rest: '休整点',
  treasure: '宝箱',
  event: '随机事件',
  elite: '精英战',
  boss: 'BOSS',
  mirror: '镜像',
  // ⚠️ shrine（祭坛）是 2.7 新增的房间类型（generateFloorRooms 会生成它），
  //    但这张表当时漏了它 —— 于是祭坛房在**事件标题**与**房间列表徽章**里
  //    显示成 "undefined · 第 N 层"（roomTypeNames['shrine'] === undefined）。
  //    用户反馈的"会出现 undefined 房间"就是这里。
  shrine: '祭坛',
};

const MAX_FLOOR = 999;

const heroOptions = [
  {
    id: 'warrior',
    name: '战士',
    description: '高生命，适合正面抗伤。',
    stats: { hp: 28, attack: 4, potions: 1, gold: 10 },
    skill: {
      name: '坚韧之盾',
      description: '每次战斗开始获得 3 点护盾。',
      onCombatStart: () => {
        state.player.shield += 3;
        addLog('你的坚韧之盾在战斗开始时出现，获得 3 点护盾。');
      },
      active: {
        name: '战吼',
        description: '立刻获得 6 点护盾，并且本回合可继续攻击。',
        execute: () => {
          state.player.shield += 6;
          addLog('你发动了战吼，立刻获得 6 点护盾。');
          return false;
        }
      }
    }
  },
  {
    id: 'rogue',
    name: '刺客',
    description: '高爆发，首回合伤害更高。',
    stats: { hp: 20, attack: 7, potions: 1, gold: 8 },
    skill: {
      name: '迅捷突袭',
      description: '首回合攻击额外造成 2 点伤害。',
      onAttack: (damage, turn) => {
        if (turn === 1) {
          addLog('你的迅捷突袭发挥作用，首回合造成额外伤害。');
          return damage + 2;
        }
        return damage;
      },
      active: {
        name: '影舞突袭',
        description: '下一次攻击额外造成 5 点伤害，并且本回合可继续攻击。',
        execute: () => {
          state.heroSkillBonus += 5;
          addLog('你准备了影舞突袭，下一次攻击将造成额外 5 点伤害。');
          return false;
        }
      }
    }
  },
  {
    id: 'sage',
    name: '贤者',
    description: '魔法与支持兼备，战胜后恢复生命。',
    stats: { hp: 22, attack: 5, potions: 2, gold: 6 },
    skill: {
      name: '灵能回响',
      description: '每次战斗胜利后恢复 2 点生命。',
      onVictory: () => {
        const heal = 2;
        state.player.hp = Math.min(state.player.maxHp, state.player.hp + heal);
        addLog(`灵能回响恢复了 ${heal} 点生命。`);
      },
      active: {
        name: '法力灌注',
        description: '下一次攻击额外造成 4 点伤害，并恢复 3 点生命，本回合可继续攻击。',
        execute: () => {
          state.heroSkillBonus += 4;
          state.heroPendingHeal = 3;
          addLog('你激发了法力灌注，下一次攻击将附带治疗效果。');
          return false;
        }
      }
    }
  },
  {
    id: 'guardian',
    name: '守护者',
    description: '擅长防守，反击时更难被击倒。',
    stats: { hp: 26, attack: 4, potions: 1, gold: 8 },
    skill: {
      name: '坚壁防御',
      description: '每次防御时额外获得 2 点护盾。',
      onDefend: () => {
        state.player.shield += 2;
        addLog('坚壁防御触发，额外获得 2 点护盾。');
      },
      active: {
        name: '护盾壁垒',
        description: '立刻获得 6 点护盾，本回合可继续攻击。',
        execute: () => {
          state.player.shield += 6;
          addLog('你构筑了护盾壁垒，立刻获得 6 点护盾。');
          return false;
        }
      }
    }
  },
  {
    id: 'ranger',
    name: '游侠',
    description: '灵活机动，善于搜刮宝藏。',
    stats: { hp: 24, attack: 6, potions: 1, gold: 12 },
    skill: {
      name: '寻宝天赋',
      description: '每次战斗胜利后额外获得 5 金币。',
      onVictory: () => {
        const bonusGold = 5;
        state.player.gold += bonusGold;
        addLog(`寻宝天赋为你带来了 ${bonusGold} 金币。`);
      },
      active: {
        name: '精准射击',
        description: '下一次攻击额外造成 4 点伤害，并且本回合可继续攻击。',
        execute: () => {
          state.heroSkillBonus += 4;
          addLog('你蓄力了一记精准射击，下一次攻击将造成额外 4 点伤害。');
          return false;
        }
      }
    }
  },
  {
    id: 'mage',
    name: '法师',
    description: '掌控元素，法术攻击更具破坏性。',
    stats: { hp: 20, attack: 6, potions: 2, gold: 6 },
    skill: {
      name: '奥术爆发',
      description: '每次攻击有 30% 概率造成额外 3 点伤害。',
      onAttack: (damage) => {
        if (Math.random() < 0.3) {
          addLog('奥术爆发命中，造成额外 3 点伤害。');
          return damage + 3;
        }
        return damage;
      },
      active: {
        name: '元素风暴',
        description: '下一次攻击额外造成 6 点伤害，并且本回合可继续攻击。',
        execute: () => {
          state.heroSkillBonus += 6;
          addLog('你召唤了元素风暴，下一次攻击将造成额外 6 点伤害。');
          return false;
        }
      }
    }
  },
  {
    id: 'berserker',
    name: '狂战士',
    description: '血气方刚，生命越低输出越高。',
    stats: { hp: 26, attack: 5, potions: 1, gold: 8 },
    skill: {
      name: '嗜血狂暴',
      description: '生命低于 50% 时攻击增加 2。',
      onAttack: (damage) => {
        if (state.player.hp <= state.player.maxHp / 2) {
          addLog('嗜血狂暴激活，攻击力额外提升。');
          return damage + 2;
        }
        return damage;
      },
      active: {
        name: '破釜沉舟',
        description: '下一次攻击额外造成 5 点伤害，并且本回合可继续攻击。',
        execute: () => {
          state.heroSkillBonus += 5;
          addLog('你进入破釜沉舟状态，下一次攻击额外造成 5 点伤害。');
          return false;
        }
      }
    }
  },
  {
    id: 'paladin',
    name: '圣骑士',
    description: '攻守兼备，自带护盾。',
    stats: { hp: 28, attack: 4, potions: 2, gold: 10 },
    skill: {
      name: '圣光护盾',
      description: '每次战斗开始获得 4 点护盾。',
      onCombatStart: () => {
        state.player.shield += 4;
        addLog('圣光护盾在战斗开始时出现，获得 4 点护盾。');
      },
      active: {
        name: '神圣审判',
        description: '立刻获得 8 点护盾并恢复 4 点生命，本回合可继续攻击。',
        execute: () => {
          state.player.shield += 8;
          state.player.hp = Math.min(state.player.maxHp, state.player.hp + 4);
          addLog('你发动了神圣审判，获得 8 点护盾并恢复 4 点生命。');
          return false;
        }
      }
    }
  },
  {
    id: 'shadow',
    name: '暗影',
    description: '高闪避，暴击率高。',
    stats: { hp: 18, attack: 8, potions: 1, gold: 12, dodge: 5},
    skill: {
      name: '暗影步',
      description: '首回合攻击必定暴击（150% 伤害）。',
      onAttack: (damage, turn) => {
        if (turn === 1) {
          const critMultiplier = (state.critDamage || 150) / 100;
          const critDamage = Math.round(damage * critMultiplier);
          addLog(`暗影步触发！暴击！造成 ${critDamage} 点伤害！`);
          return critDamage;
        }
        return damage;
      },
      active: {
        name: '暗影突袭',
        description: '下一次攻击额外造成 7 点伤害，本回合可继续攻击。',
        execute: () => {
          state.heroSkillBonus += 7;
          addLog('你遁入暗影，下一次攻击将造成额外 7 点伤害。');
          return false;
        }
      }
    }
  }
];

window.heroOptions = heroOptions;

const DEFAULT_CUSTOM_DIFFICULTY = {
  enabled: true,
  enemyHp: 1,
  enemyAtk: 1,
  goldReward: 1,
  shopCost: 0,
  restBonus: 0,
  enemyExtra: 1,
  environmentScale: 1,
  trialMaxRounds: 0,
  rewardCount: 3,
  fixedEnvironment: 'random',
  environmentPreset: 'random',
  roomCount: 3,
  floorCap: 0,
  dangerWarning: false,
  glassCannon: false,
  oneHitKill: false,
  escalatingPressure: false,
  enemyThornInject: 0,
  enemyDodgeInject: 0,
  enemyVampireInject: 0,
  enemyComboInject: 0,
  enemyCritInject: 0,
  enemyArmorInject: 0,
  gugugagaChance: 0,
  deadBodyChance: 0,
  eliteChance: 0,
  enemyGrowthCurve: 1,
  curseLevel: 0,
  commonWeight: 10,
  rareWeight: 5,
  legendaryWeight: 1,
  relicBlacklist: []
};

function clampCustomNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

function normalizeCustomDifficulty(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const safe = { ...DEFAULT_CUSTOM_DIFFICULTY };
    safe.enabled = source.enabled === undefined ? true : Boolean(source.enabled);
    safe.enemyHp = clampCustomNumber(source.enemyHp, 0.1, 20, 1);
    safe.enemyAtk = clampCustomNumber(source.enemyAtk, 0.1, 20, 1);
    safe.goldReward = clampCustomNumber(source.goldReward, -10, 20, 1);
    safe.shopCost = clampCustomNumber(source.shopCost, -25, 50, 0);
    safe.restBonus = clampCustomNumber(source.restBonus, -20, 20, 0);
    safe.enemyExtra = clampCustomNumber(source.enemyExtra, 0.1, 20, 1);
    safe.environmentScale = clampCustomNumber(source.environmentScale, 0, 10, 1);
    safe.trialMaxRounds = clampCustomNumber(source.trialMaxRounds, 0, 200, 0);
    safe.rewardCount = Math.max(2, Math.min(5, Math.round(Number(source.rewardCount) || 3)));
    safe.fixedEnvironment = ['random', 'fixed', 'disabled'].includes(source.fixedEnvironment) ? source.fixedEnvironment : 'random';
    safe.environmentPreset = source.environmentPreset && typeof source.environmentPreset === 'string' && source.environmentPreset !== 'random' ? source.environmentPreset : 'random';
    const rawRoomCount = Number(source.roomCount);
    safe.roomCount = (!Number.isFinite(rawRoomCount) || rawRoomCount < 1)
        ? 3
        : Math.min(12, Math.round(rawRoomCount));
    safe.floorCap = clampCustomNumber(source.floorCap, 0, 200, 0);
    safe.dangerWarning = Boolean(source.dangerWarning);
    safe.glassCannon = Boolean(source.glassCannon);
    safe.oneHitKill = Boolean(source.oneHitKill);
    safe.escalatingPressure = Boolean(source.escalatingPressure);
    safe.enemyThornInject = clampCustomNumber(source.enemyThornInject, 0, 20, 0);
    safe.enemyDodgeInject = clampCustomNumber(source.enemyDodgeInject, 0, 50, 0);
    safe.enemyVampireInject = clampCustomNumber(source.enemyVampireInject, 0, 20, 0);
    safe.enemyComboInject = clampCustomNumber(source.enemyComboInject, 0, 40, 0);
    safe.enemyCritInject = clampCustomNumber(source.enemyCritInject, 0, 40, 0);
    safe.enemyArmorInject = clampCustomNumber(source.enemyArmorInject, 0, 99, 0);
    safe.gugugagaChance = clampCustomNumber(source.gugugagaChance, 0, 100, 0);
    safe.deadBodyChance = clampCustomNumber(source.deadBodyChance, 0, 100, 0);
    safe.eliteChance = clampCustomNumber(source.eliteChance, 0, 100, 0);
    safe.enemyGrowthCurve = clampCustomNumber(source.enemyGrowthCurve, 0.5, 3, 1);
    safe.curseLevel = clampCustomNumber(source.curseLevel, 0, 5, 0);
    safe.commonWeight = clampCustomNumber(source.commonWeight, 1, 30, 10);
    safe.rareWeight = clampCustomNumber(source.rareWeight, 1, 30, 5);
    safe.legendaryWeight = clampCustomNumber(source.legendaryWeight, 1, 30, 1);
    if (source.relicBlacklist && typeof source.relicBlacklist === 'string') {
        safe.relicBlacklist = source.relicBlacklist.split(/[，,;；|]/).map(item => item.trim()).filter(Boolean);
    } else if (Array.isArray(source.relicBlacklist)) {
        safe.relicBlacklist = source.relicBlacklist.map(item => String(item).trim()).filter(Boolean);
    } else {
        safe.relicBlacklist = [];
    }
    return safe;
}

function getCustomRelicWeights() {
  const custom = normalizeCustomDifficulty(state.customDifficulty || {});
  const weights = {
    common: custom.commonWeight || 10,
    rare: custom.rareWeight || 5,
    legendary: custom.legendaryWeight || 1
  };
  return weights;
}

function getCustomRelicBlacklist() {
  const custom = normalizeCustomDifficulty(state.customDifficulty || {});
  return Array.isArray(custom.relicBlacklist) ? custom.relicBlacklist : [];
}

// 规则变体：低侵入式乘算，关闭总开关时直接回落默认逻辑。
// 这样既能保留原本难度节奏，也能让玩家自由组合出极限挑战。
function getCustomEnemyInjection() {
  const custom = normalizeCustomDifficulty(state.customDifficulty || {});
  if (!isCustomDifficultyEnabled()) {
    return { thorn: 0, dodge: 0, vampire: 0, combo: 0, crit: 0, armor: 0 };
  }
  return {
    thorn: custom.enemyThornInject || 0,
    dodge: custom.enemyDodgeInject || 0,
    vampire: custom.enemyVampireInject || 0,
    combo: custom.enemyComboInject || 0,
    crit: custom.enemyCritInject || 0,
    armor: custom.enemyArmorInject || 0
  };
}

function getCustomEnemyGrowthFactor(floor) {
  const custom = normalizeCustomDifficulty(state.customDifficulty || {});
  if (!isCustomDifficultyEnabled()) return 1;
  const curve = custom.enemyGrowthCurve || 1;
  const depth = Math.max(0, (floor || 1) - 1);
  return 1 + depth * (curve - 1) * 0.12;
}

function getCustomDifficultyRuleEffects() {
  const custom = normalizeCustomDifficulty(state.customDifficulty || {});
  if (!isCustomDifficultyEnabled()) {
    return {
      playerHpMultiplier: 1,
      enemyHpMultiplier: 1,
      playerAttackMultiplier: 1,
      enemyAttackMultiplier: 1,
      damageMultiplier: 1,
      pressureMultiplier: 1,
      glassCannon: false,
      oneHitKill: false,
      escalatingPressure: false
    };
  }

  let playerHpMultiplier = 1;
  let enemyHpMultiplier = 1;
  let playerAttackMultiplier = 1;
  let enemyAttackMultiplier = 1;
  let damageMultiplier = 1;
  let pressureMultiplier = 1;

  if (custom.glassCannon) {
    playerHpMultiplier *= 0.7;
    enemyHpMultiplier *= 0.7;
    playerAttackMultiplier *= 1.5;
    enemyAttackMultiplier *= 1.5;
    damageMultiplier *= 1.5;
  }

  if (custom.oneHitKill) {
    damageMultiplier *= 8;
  }

  if (custom.escalatingPressure) {
    pressureMultiplier = 1 + Math.max(0, (state.floor || 1) - 1) * 0.08;
    playerAttackMultiplier *= pressureMultiplier;
    enemyAttackMultiplier *= pressureMultiplier;
    damageMultiplier *= pressureMultiplier;
  }

  if (custom.curseLevel > 0) {
    const cursePressure = 1 + custom.curseLevel * 0.08;
    enemyHpMultiplier *= 1 + custom.curseLevel * 0.04;
    enemyAttackMultiplier *= cursePressure;
    pressureMultiplier *= cursePressure;
  }

  return {
    playerHpMultiplier,
    enemyHpMultiplier,
    playerAttackMultiplier,
    enemyAttackMultiplier,
    damageMultiplier,
    pressureMultiplier,
    glassCannon: custom.glassCannon,
    oneHitKill: custom.oneHitKill,
    escalatingPressure: custom.escalatingPressure,
    curseLevel: custom.curseLevel
  };
}

function isCustomDifficultyEnabled() {
  if (!state || state.difficulty !== 'custom') return false;
  return normalizeCustomDifficulty(state.customDifficulty).enabled;
}

function applyCustomDifficultyDefaults() {
  state.customDifficulty = normalizeCustomDifficulty(state.customDifficulty || {});
  if (state.difficulty === 'custom' && !state.customDifficulty.enabled) {
    state.customDifficulty.enabled = false;
  }
}

function getEffectiveCustomDifficulty() {
  const obj = state && state.customDifficulty ? state.customDifficulty : {};
  return normalizeCustomDifficulty(obj);
}

// 难度系数
// enemyArmor：敌人减伤属性随难度的强度倍率（easy 偏弱、hell 偏强，custom 下由"敌人属性强度"倍率控制）
/* ============================================================
   难度修正表
   ------------------------------------------------------------
   v2.8 全面加强敌人（用户反馈：「怪物太弱了，所有难度下都全面加强」）。
   三个维度一起动，只提倍率是不够的：
     · enemyHp / enemyAtk —— 更耐打、更痛（本表的数值）
     · 层数成长 —— 后期不掉队（经典2D.js 的 enemyScaler 里那条 base 公式）
     · enemyAi —— 更主动：更早发现你、追得更紧、出手更频繁
   后两项都不在这张表里，但都从这张表取值，所以调难度只需要改这一个地方。

   enemyAi 是「倍率包」，缺省视为全 1：
     speed  移速倍率      windup 前摇倍率（<1 = 出手更快）
     recover 后摇倍率     detect 索敌范围倍率
   ⚠️ 前摇在引擎侧有 200ms 硬下限（战斗2D.js 的 boostEnemyDef）：
      完美闪避窗口固定 150ms，前摇压到窗口附近就变成没法反应的抽奖。
   ============================================================ */
const difficultyModifiers = {
  easy: { enemyHp: 1.10, enemyAtk: 1.00, goldReward: 1.2, shopCost: -2, restBonus: 1, enemyArmor: 0.6,
    enemyAi: { speed: 1.02, windup: 0.98, recover: 0.96, detect: 1.10 } },
  normal: { enemyHp: 1.30, enemyAtk: 1.22, goldReward: 1, shopCost: 0, restBonus: 0, enemyArmor: 0.8,
    enemyAi: { speed: 1.08, windup: 0.94, recover: 0.90, detect: 1.22 } },
  hard: { enemyHp: 1.55, enemyAtk: 1.50, goldReward: 0.9, shopCost: 2, restBonus: -1, enemyArmor: 1.0,
    enemyAi: { speed: 1.16, windup: 0.88, recover: 0.82, detect: 1.36 } },
  hell: { enemyHp: 1.85, enemyAtk: 1.80, goldReward: 0.8, shopCost: 4, restBonus: -2, enemyArmor: 1.2,
    enemyAi: { speed: 1.24, windup: 0.82, recover: 0.76, detect: 1.50 } },
  // 自定义难度：敌人强度完全由玩家那几张滑杆决定，这里不给额外加成
  custom: { enemyHp: 1, enemyAtk: 1, goldReward: 1, shopCost: 0, restBonus: 0, enemyExtra: 1, enemyArmor: 1,
    enemyAi: { speed: 1, windup: 1, recover: 1, detect: 1 } }
};

// 环境效果池
const ENVIRONMENT_EFFECTS = [
  {
    name: '荆棘之地',
    description: '每次攻击时受到 {value} 当前生命的反弹伤害（无视护盾）',
    create: function(floor, diffScale) {
      const value = Math.min(0.05 + floor * 0.005, 0.15) * diffScale;
      const display = (value * 100).toFixed(1) + '%';
      return {
        values: { rebound: value },
        display: display,
        damageModifier: 0,
        onPlayerAttack: function(player, enemy) {
          const dmg = Math.max(1, Math.round(player.hp * this.values.rebound));
          if (typeof DEV_MODE !== 'undefined' && DEV_MODE.godMode) return; // 无敌模式免疫反弹
          player.hp = Math.max(1, player.hp - dmg);
        },
        onEnemyTurn: function(player, enemy) {
          if (enemy.attack > 0) {
            const dmg = Math.max(1, Math.round(enemy.hp * this.values.rebound));
            enemy.hp = Math.max(0, enemy.hp - dmg);
          }
        }
      };
    }
  },
  {
    name: '虚弱之雾',
    description: '所有单位攻击力 {value}（最低1）',
    create: function(floor, diffScale) {
      const value = Math.min(0.15 + floor * 0.005, 0.30) * diffScale;
      const display = '-' + (value * 100).toFixed(1) + '%';
      return {
        values: { attackReduction: value },
        display: display,
        damageModifier: 0,
        applyTurnEffects: function(player, enemy) {
          const reduction = this.values.attackReduction;
          if (player.tempAttackBonus === undefined) player.tempAttackBonus = 0;
          if (enemy.tempAttackBonus === undefined) enemy.tempAttackBonus = 0;
          // 使用临时加成来模拟百分比削减（在攻击计算时应用）
          player.attackPercentMod = (player.attackPercentMod || 1) * (1 - reduction);
          enemy.attackPercentMod = (enemy.attackPercentMod || 1) * (1 - reduction);
        }
      };
    }
  },
  {
    name: '护盾崩坏',
    description: '每回合失去 {value} 当前护盾（至少1点）',
    create: function(floor, diffScale) {
      const value = Math.min(0.20 + floor * 0.005, 0.50) * diffScale;
      const display = (value * 100).toFixed(1) + '%';
      return {
        values: { shieldLoss: value },
        display: display,
        damageModifier: 0,
        applyTurnEffects: function(player, enemy) {
          if (player.shield > 0) {
            const loss = Math.max(1, Math.round(player.shield * this.values.shieldLoss));
            player.shield = Math.max(0, player.shield - loss);
          }
        }
      };
    }
  },
  {
    name: '治疗抑制',
    description: '所有治疗效果 {value}（治疗药水、吸血、技能）',
    create: function(floor, diffScale) {
      const value = Math.min(0.30 + floor * 0.005, 0.60) * diffScale;
      const display = '-' + (value * 100).toFixed(1) + '%';
      return {
        values: { healReduction: value },
        display: display,
        damageModifier: 0,
        onHeal: function(amount) {
          const reduction = this.values.healReduction;
          return Math.floor(amount * (1 - reduction));
        }
      };
    }
  },
  {
    name: '能量涌动',
    description: '攻击力 {attackBonus}，每回合自伤 {selfDamage} 最大生命',
    create: function(floor, diffScale) {
      const attackBonus = Math.min(0.20 + floor * 0.005, 0.40) * diffScale;
      const selfDmg = Math.min(0.03 + floor * 0.005, 0.08) * diffScale;
      const display = '+' + (attackBonus * 100).toFixed(1) + '% / -' + (selfDmg * 100).toFixed(1) + '%';
      return {
        values: { attackBonus: attackBonus, selfDamage: selfDmg },
        display: display,
        damageModifier: 0,
        onCombatStart: function(player, enemy) {
          if (player.tempAttackBonus === undefined) player.tempAttackBonus = 0;
          if (enemy.tempAttackBonus === undefined) enemy.tempAttackBonus = 0;
          // 用临时加成存储百分比修正
          player.attackPercentMod = (player.attackPercentMod || 1) * (1 + this.values.attackBonus);
          enemy.attackPercentMod = (enemy.attackPercentMod || 1) * (1 + this.values.attackBonus);
        },
        applyTurnEffects: function(player, enemy) {
          const dmg = Math.max(1, Math.round(player.maxHp * this.values.selfDamage));
          if (typeof DEV_MODE === 'undefined' || !DEV_MODE.godMode) {
            player.hp = Math.max(1, player.hp - dmg);
          }
          if (enemy.hp > 0) {
            const eDmg = Math.max(1, Math.round(enemy.maxHp * this.values.selfDamage));
            enemy.hp = Math.max(0, enemy.hp - eDmg);
          }
        }
      };
    }
  },
  {
    name: '闪避领域',
    description: '所有单位闪避率 {value}（上限50%）',
    create: function(floor, diffScale) {
      const value = Math.min(0.15 + floor * 0.005, 0.30) * diffScale;
      const display = '+' + (value * 100).toFixed(1) + '%';
      return {
        values: { dodgeBonus: value },
        display: display,
        damageModifier: 0,
        onCombatStart: function(player, enemy) {
          if (player.dodgeBonus === undefined) player.dodgeBonus = 0;
          if (enemy.dodgeBonus === undefined) enemy.dodgeBonus = 0;
          player.dodgeBonus += this.values.dodgeBonus * 100;
          enemy.dodgeBonus += this.values.dodgeBonus * 100;
        }
      };
    }
  },
  {
    name: '暴击共振',
    description: '所有单位暴击伤害 {value}',
    create: function(floor, diffScale) {
      const value = Math.min(0.30 + floor * 0.005, 0.60) * diffScale;
      const display = '+' + (value * 100).toFixed(1) + '%';
      return {
        values: { critDamageBonus: value },
        display: display,
        damageModifier: 0,
        onCombatStart: function(player, enemy) {
          if (player.critDamageBonus === undefined) player.critDamageBonus = 0;
          if (enemy.critDamageBonus === undefined) enemy.critDamageBonus = 0;
          player.critDamageBonus += this.values.critDamageBonus * 100;
          enemy.critDamageBonus += this.values.critDamageBonus * 100;
        }
      };
    }
  },
  {
    name: '连击风暴',
    description: '所有单位连击率 {value}（上限40%）',
    create: function(floor, diffScale) {
      const value = Math.min(0.15 + floor * 0.005, 0.30) * diffScale;
      const display = '+' + (value * 100).toFixed(1) + '%';
      return {
        values: { comboBonus: value },
        display: display,
        damageModifier: 0,
        onCombatStart: function(player, enemy) {
          if (player.comboBonus === undefined) player.comboBonus = 0;
          if (enemy.comboBonus === undefined) enemy.comboBonus = 0;
          player.comboBonus += this.values.comboBonus * 100;
          enemy.comboBonus += this.values.comboBonus * 100;
        }
      };
    }
  },
  {
    name: '死亡回响',
    description: '敌人死亡时，对玩家造成 {value} 最大生命的伤害（无视护盾）',
    create: function(floor, diffScale) {
      const value = Math.min(0.08 + floor * 0.005, 0.15) * diffScale;
      const display = (value * 100).toFixed(1) + '%';
      return {
        values: { deathDamage: value },
        display: display,
        damageModifier: 0,
        onVictory: function(player, enemy) {
          const dmg = Math.max(1, Math.round(player.maxHp * this.values.deathDamage));
          player.hp = Math.max(1, player.hp - dmg);
        }
      };
    }
  },
  {
    name: '吸血诅咒',
    description: '所有单位攻击时恢复 {value} 最大生命（至少1点）',
    create: function(floor, diffScale) {
      const value = Math.min(0.02 + floor * 0.005, 0.05) * diffScale;
      const display = (value * 100).toFixed(1) + '%';
      return {
        values: { lifesteal: value },
        display: display,
        damageModifier: 0,
        onPlayerAttack: function(player, enemy) {
          const heal = Math.max(1, Math.round(player.maxHp * this.values.lifesteal));
          player.hp = Math.min(player.maxHp, player.hp + heal);
        },
        onEnemyTurn: function(player, enemy) {
          if (enemy.attack > 0) {
            const heal = Math.max(1, Math.round(enemy.maxHp * this.values.lifesteal));
            enemy.hp = Math.min(enemy.maxHp, enemy.hp + heal);
          }
        }
      };
    }
  },
  {
    name: '缓慢凋零',
    description: '每回合所有单位失去 {value} 最大生命（至少1点）',
    create: function(floor, diffScale) {
      const value = Math.min(0.03 + floor * 0.005, 0.08) * diffScale;
      const display = (value * 100).toFixed(1) + '%';
      return {
        values: { decay: value },
        display: display,
        damageModifier: 0,
        applyTurnEffects: function(player, enemy) {
          const pLoss = Math.max(1, Math.round(player.maxHp * this.values.decay));
          if (typeof DEV_MODE === 'undefined' || !DEV_MODE.godMode) {
            player.maxHp = Math.max(1, player.maxHp - pLoss);
            player.hp = Math.min(player.hp, player.maxHp);
          }
          if (enemy.hp > 0) {
            const eLoss = Math.max(1, Math.round(enemy.maxHp * this.values.decay));
            enemy.maxHp = Math.max(1, enemy.maxHp - eLoss);
            enemy.hp = Math.min(enemy.hp, enemy.maxHp);
          }
        }
      };
    }
  },
  {
    name: '能量导管',
    description: '每回合所有单位获得 {value} 最大生命的护盾（至少1点）',
    create: function(floor, diffScale) {
      const value = Math.min(0.10 + floor * 0.005, 0.20) * diffScale;
      const display = (value * 100).toFixed(1) + '%';
      return {
        values: { shieldGain: value },
        display: display,
        damageModifier: 0,
        applyTurnEffects: function(player, enemy) {
          const gain = Math.max(1, Math.round(player.maxHp * this.values.shieldGain));
          player.shield += gain;
        }
      };
    }
  },
  {
    name: '厄运',
    description: '所有单位受到伤害 {value}',
    create: function(floor, diffScale) {
      const value = Math.min(0.20 + floor * 0.005, 0.40) * diffScale;
      const display = '+' + (value * 100).toFixed(1) + '%';
      return {
        values: { extraDamage: value },
        display: display,
        damageModifier: value,
        onCombatStart: function(player, enemy) {
          // 无额外逻辑，damageModifier 已设置
        }
      };
    }
  },
  {
    name: '幸运',
    description: '所有单位暴击率 {value}',
    create: function(floor, diffScale) {
      const value = Math.min(0.15 + floor * 0.005, 0.30) * diffScale;
      const display = '+' + (value * 100).toFixed(1) + '%';
      return {
        values: { luckyBonus: value },
        display: display,
        damageModifier: 0,
        onCombatStart: function(player, enemy) {
          if (player.luckyBonus === undefined) player.luckyBonus = 0;
          if (enemy.luckyBonus === undefined) enemy.luckyBonus = 0;
          player.luckyBonus += this.values.luckyBonus * 100;
          enemy.luckyBonus += this.values.luckyBonus * 100;
        }
      };
    }
  },
  {
    name: '时间扭曲',
    description: '每回合所有单位额外消耗 {value} 当前生命（无视护盾）',
    create: function(floor, diffScale) {
      const value = Math.min(0.02 + floor * 0.005, 0.05) * diffScale;
      const display = (value * 100).toFixed(1) + '%';
      return {
        values: { timeLoss: value },
        display: display,
        damageModifier: 0,
        applyTurnEffects: function(player, enemy) {
          const pLoss = Math.max(1, Math.round(player.hp * this.values.timeLoss));
          player.hp = Math.max(1, player.hp - pLoss);
          if (enemy.hp > 0) {
            const eLoss = Math.max(1, Math.round(enemy.hp * this.values.timeLoss));
            enemy.hp = Math.max(0, enemy.hp - eLoss);
          }
        }
      };
    }
  }
];

// 格式化环境描述：将 {占位符} 替换为实际数值（如 能量涌动 的 {attackBonus}/{selfDamage}）
function formatEnvDescription(env) {
  let desc = env.description || '';
  if (env.values) {
    desc = desc.replace(/\{(\w+)\}/g, (m, k) => {
      let v = env.values[k];
      // 兼容 {value} 占位符：若 values 中没有名为 value 的键，取唯一数值字段
      if ((v === undefined || v === null) && k === 'value') {
        const keys = Object.keys(env.values);
        if (keys.length === 1) v = env.values[keys[0]];
      }
      if (v === undefined || v === null) return m;
      if (typeof v === 'number') {
        // 绝对值小于1的数值按百分比显示
        return Math.abs(v) < 1 ? (v * 100).toFixed(1) + '%' : String(v);
      }
      return String(v);
    });
  }
  return desc;
}

// 生成随机环境效果
// forceName：只从指定的那个模板生成（试炼 2D 的「袋抽」按名字点单）；
//            不传就是原来的随机，经典模式的调用点行为完全不变。
let lastEnvironment = null;
function generateEnvironmentEffect(floor, difficulty, forceName) {
  floor = floor || state.floor || 1;
  difficulty = difficulty || state.difficulty || 'normal';

  let diffScale = 1.0;
  if (difficulty === 'easy') diffScale = 0.8;
  else if (difficulty === 'normal') diffScale = 1.0;
  else if (difficulty === 'hard') diffScale = 1.15;
  else if (difficulty === 'hell') diffScale = 1.25;
  else if (difficulty === 'custom') {
    const custom = normalizeCustomDifficulty(state.customDifficulty);
    diffScale = custom.environmentScale || 1.0;
    if (custom.fixedEnvironment === 'disabled' && isCustomDifficultyEnabled()) {
      const silentEnv = {
        name: '静谧空间',
        description: '本层环境效果已关闭。',
        values: {},
        displayValue: '无',
        damageModifier: 0,
        onCombatStart: null,
        onPlayerAttack: null,
        onEnemyTurn: null,
        applyTurnEffects: null,
        onHeal: null,
        onVictory: null,
        onPlayerDefend: null,
        _floor: floor,
        _diffScale: diffScale
      };
      lastEnvironment = silentEnv;
      return silentEnv;
    }
    if (isCustomDifficultyEnabled() && custom.fixedEnvironment === 'fixed' && custom.environmentPreset && custom.environmentPreset !== 'random') {
      const template = ENVIRONMENT_EFFECTS.find(e => e.name === custom.environmentPreset);
      if (template) {
        const envData = template.create(floor, diffScale);
        const env = {
          name: template.name,
          description: template.description.replace('{value}', envData.display),
          values: envData.values,
          displayValue: envData.display,
          damageModifier: envData.damageModifier || 0,
          onCombatStart: envData.onCombatStart || null,
          onPlayerAttack: envData.onPlayerAttack || null,
          onEnemyTurn: envData.onEnemyTurn || null,
          applyTurnEffects: envData.applyTurnEffects || null,
          onHeal: envData.onHeal || null,
          onVictory: envData.onVictory || null,
          onPlayerDefend: envData.onPlayerDefend || null,
          _floor: floor,
          _diffScale: diffScale
        };
        lastEnvironment = env;
        return env;
      }
    }
  }

  // 候选池：默认全池；forceName 命中时收窄成那一个（试炼 2D 的房间级袋抽用它点单）
  let pool = ENVIRONMENT_EFFECTS;
  if (forceName) {
    const forced = ENVIRONMENT_EFFECTS.find(e => e.name === forceName);
    if (forced) pool = [forced];
  }

  // 过滤掉上次出现的效果，避免连续重复
  let available = pool.filter(function(e) {
    return e.name !== lastEnvironment?.name;
  });
  if (available.length === 0) available = pool;

  const chosen = available[Math.floor(Math.random() * available.length)];
  const envData = chosen.create(floor, diffScale);

  // 构建完整的环境对象
  const env = {
    name: chosen.name,
    description: chosen.description.replace('{value}', envData.display),
    values: envData.values,
    displayValue: envData.display,
    damageModifier: envData.damageModifier || 0,
    onCombatStart: envData.onCombatStart || null,
    onPlayerAttack: envData.onPlayerAttack || null,
    onEnemyTurn: envData.onEnemyTurn || null,
    applyTurnEffects: envData.applyTurnEffects || null,
    onHeal: envData.onHeal || null,
    onVictory: envData.onVictory || null,
    onPlayerDefend: envData.onPlayerDefend || null,
    _floor: floor,
    _diffScale: diffScale
  };

  lastEnvironment = chosen;
  return env;
}

const state = {
  player: {
    name: '冒险者',            // 玩家名称
    hp: 24,                    // 当前生命值
    maxHp: 24,                 // 生命上限
    attack: 5,                 // 基础攻击力
    shield: 0,                 // 当前护盾值
    gold: 0,                   // 金币数量
    level: 1,                  // 等级（暂未使用）
    potions: 1,                // 治疗药水数量
    strengthPotions: 0,        // 力量药水数量
    xp: 0                      // 当前经验值
  },
  pendingAttackBoost: 0,       // 待生效的攻击加成（力量药水）
  heroSkillUsed: false,        // 本层是否已使用英雄主动技能
  heroSkillBonus: 0,           // 英雄主动技能提供的攻击加成
  heroPendingHeal: 0,          // 英雄主动技能待回复的生命值
  floor: 1,                    // 当前所在层数
  roomIndex: 0,                // 当前房间在该层房间列表中的索引
  rooms: [],                   // 当前层的房间列表
  currentRoom: null,           // 当前房间对象
  mode: 'start',               // 游戏模式（start / heroSelect / combat / event / shop / rest / reward / bossVictory / victoryChoice / finished / gameover 等）
  combat: null,                // 战斗状态对象
  rewardOptions: [],           // 战斗胜利后的奖励选项列表
  eventOptions: [],            // 随机事件的选项列表
  shopOptions: [],             // 商店商品列表
  relics: [],                  // 已获得的遗物列表
  log: [],                     // 战斗日志（字符串数组）
  gameOver: false,             // 是否游戏结束
  difficulty: 'normal',        // 当前难度（easy / normal / hard / hell / custom）
  hero: null,                  // 当前选择的英雄对象
  endOptions: [],              // 通关后可选的结局列表
  endResult: null,             // 玩家选择的结局结果
  bonuses: [],                 // 本局已获得的开局增益列表
  availableBonuses: [],        // 开局时待选择的增益列表
  unlockedBonuses: [],         // 已解锁的增益（暂未使用）
  environment: null,           // 当前楼层环境效果对象
  // 实时化诅咒（经典 2D 模式）：由 经典2D.js 读写，纯字符串数组、可安全存档。
  // ⚠️ 必须在这里声明：它原先只由 经典2D.js 在第一次中诅咒时**随手挂到 state 上**，
  //    于是「重新开始」那条路（resetCurrentSlot）根本不知道有这个字段，
  //    重置后旧诅咒原样留在 state 里 → 新一局开局就带着上一局的诅咒。
  _rtCurses: [],
  records: {                   // 各难度记录
    easy: { bestFloor: 0, clears: 0, deaths: 0 },   // 简单难度
    normal: { bestFloor: 0, clears: 0, deaths: 0 }, // 普通难度
    hard: { bestFloor: 0, clears: 0, deaths: 0 },   // 困难难度
    hell: { bestFloor: 0, clears: 0, deaths: 0 }    // 地狱难度
  },
  vampireLevel: 0,             // 吸血等级（每次攻击回复生命值）
  thornLevel: 0,               // 荆棘等级（反弹伤害）
  hasLifeShield: false,        // 是否拥有生命护盾（每回合+2护盾）
  hasDoubleGold: false,        // 是否拥有双倍金币（战斗金币+50%）
  hasExpBoost: false,          // 是否拥有经验加成（战斗经验+50%）
  luckyLevel: 0,               // 暴击率等级（每级+10%，上限100%）
  critDamage: 150,             // 暴击伤害百分比（默认150%）
  hasAncientBless: false,      // 是否拥有古神眷顾（祭坛事件特殊效果）
  dodgeLevel: 0,               // 闪避等级（每级+5%，上限50%）
  comboLevel: 0,               // 连击等级（每级+5%，上限40%）
  executeLevel: 0,             // 斩杀等级（每级+5%，上限40%）
  comboDamageBonus: 0,         // 连击伤害额外加成（百分比）
  executeThreshold: 0.3,       // 斩杀触发阈值（默认30%血量）
  isFirstAttack: true,         // 是否为本场战斗首次攻击
  hasTotem: false,             // 是否拥有不死图腾（致命伤保留1血）
  detailMode: false,           // 是否开启详情模式（点击按钮显示详情）
  hasFirstAttackCombo: false,  // 首次攻击是否必定连击（双刃匕首）
  encyclopediaState: {         // 图鉴界面状态
    currentCategory: null,     // 当前查看的分类
    viewMode: 'categories'     // 视图模式（categories / entries）
  },
  comboCount: 0,               // 本场战斗连击触发次数
  executeCount: 0,             // 本场战斗斩杀触发次数
  dodgeCount: 0,               // 本场战斗闪避触发次数
  critCount: 0,                // 本场战斗暴击触发次数
  enemyThorn: 0,               // 当前敌人荆棘值（战斗中）
  enemyDodge: 0,               // 当前敌人闪避率（战斗中）
  enemyVampire: 0,             // 当前敌人吸血值（战斗中）
  enemyCombo: 0,               // 当前敌人连击率（战斗中）
  enemyCrit: 0,                // 当前敌人暴击率（战斗中）
  enemyCritDamage: 150,        // 当前敌人暴击伤害（战斗中）
  hasKillScythe: false,        // 是否拥有斩杀之镰（斩杀成功+1攻击）
  hasFateWheel: false,         // 是否拥有命运轮盘（战斗开始随机效果）
  hasShadowDeal: false,        // 是否拥有暗影交易（事件触发）
  customDifficulty: normalizeCustomDifficulty({ enabled: true }),
  shopLimitBonus: 0,           // 商店限购次数额外加成（商队护送事件）
  // 试炼模式状态

  // 跨战斗 debuff 状态（经典模式和试炼模式共用）
  burnRounds: 0,               // 灼烧剩余回合数（岩浆行者）
  charmRounds: 0,              // 魅惑剩余回合数（影·魅）
  nextDamageIncrease: 0,       // 下次受伤增加百分比（整数，如 30 表示 30%）
  damageReduction: 0,          // 伤害减免百分比（魅惑效果，整数，如 10 表示 10%）
  shadowKingSealBackup: null   // 影之皇封印前的其他数值备份
};

window.state = state;
window.heroOptions = heroOptions;

const refs = {
  playerName: document.getElementById('playerName'),
  playerHp: document.getElementById('playerHp'),
  playerAttack: document.getElementById('playerAttack'),
  playerShield: document.getElementById('playerShield'),
  playerGold: document.getElementById('playerGold'),
  playerPotions: document.getElementById('playerPotions'),
  heroSkill: document.getElementById('heroSkill'),
  floorLabel: document.getElementById('floorLabel'),
  roomProgress: document.getElementById('roomProgress'),
  roomList: document.getElementById('roomList'),
  eventTitle: document.getElementById('eventTitle'),
  difficultySelect: document.getElementById('difficultySelect'),
  encyclopediaButton: document.getElementById('encyclopediaButton'),
  conditionButton: document.getElementById('conditionButton'),
  conditionsModal: document.getElementById('conditionsModal'),
  conditionsList: document.getElementById('conditionsList'),
  encyclopediaModal: document.getElementById('encyclopediaModal'),
  encyclopediaList: document.getElementById('encyclopediaList'),
  encyclopediaCategories: document.getElementById('encyclopediaCategories'),
  encyclopediaBackButton: document.getElementById('encyclopediaBackButton'),
  bonusList: document.getElementById('bonusList'),
  difficultyStats: document.getElementById('difficultyStats'),
  eventText: document.getElementById('eventText'),
  actionArea: document.getElementById('actionArea'),
  logList: document.getElementById('logList'),
  restartButton: document.getElementById('restartButton'),
  changelogButton: document.getElementById('changelogButton'),
  changelogModal: document.getElementById('changelogModal'),
  changelogList: document.getElementById('changelogList'),
  modeToggle: document.getElementById('modeToggle'),
  saveButton: document.getElementById('saveButton'),
  cheatButton: document.getElementById('cheatButton'),
  cheatModal: document.getElementById('cheatModal'),
  cheatPasswordLayer: document.getElementById('cheatPasswordLayer'),
  cheatContentLayer: document.getElementById('cheatContentLayer'),
  cheatPasswordInput: document.getElementById('cheatPasswordInput'),
  cheatPasswordConfirm: document.getElementById('cheatPasswordConfirm'),
  cheatPasswordError: document.getElementById('cheatPasswordError'),
  cheatHp: document.getElementById('cheatHp'),
  cheatMaxHp: document.getElementById('cheatMaxHp'),
  cheatAttack: document.getElementById('cheatAttack'),
  cheatShield: document.getElementById('cheatShield'),
  cheatGold: document.getElementById('cheatGold'),
  cheatPotions: document.getElementById('cheatPotions'),
  cheatStrengthPotions: document.getElementById('cheatStrengthPotions'),
  cheatLucky: document.getElementById('cheatLucky'),
  cheatCritDamage: document.getElementById('cheatCritDamage'),
  cheatThorn: document.getElementById('cheatThorn'),
  cheatVampire: document.getElementById('cheatVampire'),
  cheatRelicSelect: document.getElementById('cheatRelicSelect'),
  cheatBonusSelect: document.getElementById('cheatBonusSelect'),
  cheatApplyStats: document.getElementById('cheatApplyStats'),
  cheatAddRelic: document.getElementById('cheatAddRelic'),
  cheatAddBonus: document.getElementById('cheatAddBonus'),
  cheatPasswordToggle: document.getElementById('cheatPasswordToggle'),
  tutorialButton: document.getElementById('tutorialButton'),
  cheatDodge: document.getElementById('cheatDodge'),
  cheatCombo: document.getElementById('cheatCombo'),
  cheatExecute: document.getElementById('cheatExecute'),
  cheatXp: document.getElementById('cheatXp'),
  saveManagerModal: document.getElementById('saveManagerModal'),
  saveManagerList: document.getElementById('saveManagerList'),
  saveManagerActive: document.getElementById('saveManagerActive'),
};

// 渲染合并调度器 - 防止高频渲染导致卡死
let renderPending = false;
function scheduleRender() {
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(function() {
      renderPending = false;
      render();
    });
  }
}

function countRelic(label) {
  return state.relics.filter(r => r.label === label).length;
}

function addLuckyLevel(amount, source = '') {
  const currentChance = (state.luckyLevel || 0) * 10;
  if (currentChance >= 100) {
    const sourceText = source ? `（${source}）` : '';
    addLog(`⚠️ 暴击率已达 100%${sourceText}，无法继续提升。`);
    return false;
  }
  const newLevel = Math.min((state.luckyLevel || 0) + amount, 10);
  const added = newLevel - (state.luckyLevel || 0);
  state.luckyLevel = newLevel;
  addLog(`🎯 暴击率提升 ${(added * 10).toFixed(1)}%，当前 ${(state.luckyLevel * 10).toFixed(1)}%`);
  spawnDamageFloat((added * 10).toFixed(1)+'%', 'lucky');
  return true;
}

// ===== 闪避系统 =====
function addDodgeLevel(amount, source = '') {
  const currentChance = Math.min((state.dodgeLevel || 0) * 5, 50);
  if (currentChance >= 50) {
    const sourceText = source ? `（${source}）` : '';
    addLog(`⚠️ 闪避率已达 50%${sourceText}，无法继续提升。`);
    return false;
  }
  const newLevel = Math.min((state.dodgeLevel || 0) + amount, 10);
  const added = newLevel - (state.dodgeLevel || 0);
  state.dodgeLevel = newLevel;
  addLog(`💨 闪避率提升 ${(added * 5).toFixed(0)}%，当前 ${(state.dodgeLevel * 5).toFixed(0)}%`);
  spawnDamageFloat(`+${(added * 5).toFixed(0)}%`, 'dodge');
  return true;
}

// ===== 连击系统 =====
function addComboLevel(amount, source = '') {
  const currentChance = Math.min((state.comboLevel || 0) * 5, 40);
  if (currentChance >= 40) {
    const sourceText = source ? `（${source}）` : '';
    addLog(`⚠️ 连击率已达 40%${sourceText}，无法继续提升。`);
    return false;
  }
  const newLevel = Math.min((state.comboLevel || 0) + amount, 8);
  const added = newLevel - (state.comboLevel || 0);
  state.comboLevel = newLevel;
  addLog(`⚡ 连击率提升 ${(added * 5).toFixed(0)}%，当前 ${(state.comboLevel * 5).toFixed(0)}%`);
  spawnDamageFloat(`+${(added * 5).toFixed(0)}%`, 'combo');
  return true;
}

// ===== 斩杀系统 =====
function addExecuteLevel(amount, source = '') {
  const currentChance = Math.min((state.executeLevel || 0) * 5, 40);
  if (currentChance >= 40) {
    const sourceText = source ? `（${source}）` : '';
    addLog(`⚠️ 斩杀率已达 40%${sourceText}，无法继续提升。`);
    return false;
  }
  const newLevel = Math.min((state.executeLevel || 0) + amount, 8);
  const added = newLevel - (state.executeLevel || 0);
  state.executeLevel = newLevel;
  addLog(`🗡️ 斩杀率提升 ${(added * 5).toFixed(0)}%，当前 ${(state.executeLevel * 5).toFixed(0)}%`);
  spawnDamageFloat(`+${(added * 5).toFixed(0)}%`, 'execute');
  return true;
}

// ===== 自定义难度面板折叠切换 =====
function initCustomDifficultyCollapse() {
  const body = document.getElementById('customDifficultyBody');
  const btn = document.getElementById('customDifficultyToggle') || document.getElementById('customDifficultyCollapseBtn');
  const panel = document.getElementById('customDifficultyPanel');

  if (!body || !btn || !panel) return;

  // ⚠️ 这颗按钮原来是「收起 / 展开」——只折叠面板的**主体**，把面板外壳永远留在屏幕上。
  //    在文字界面里还凑合（外壳不挡内容），但 2D 画面里这个面板是浮层
  //    （position: fixed + z-index 9500，见 主样式.css 末尾），
  //    于是它**挡住整个战场、而且怎么也关不掉**（用户反馈）。
  //    现在改成真正的「关闭」：整块面板收起来。
  function closePanel() {
    panel.classList.add('hidden');
    body.classList.remove('collapsed');   // 下次打开时是展开状态，不留上次的折叠记忆
    body.style.maxHeight = '';
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closePanel();
  });

  // 把面板叫回来的两条路：
  //   ① 把难度切到「自定义」（内核的 change 处理里会 remove('hidden')）；
  //   ② 值**已经是**「自定义」时再点一次下拉 —— change 在值没变时不触发，
  //      所以这里补一个 click 兜底，否则关掉之后就再也打不开了。
  ['difficultySelect', 'sidebarDifficultySelect'].forEach(function (id) {
    const sel = document.getElementById(id);
    if (!sel || sel.dataset.customReopen === '1') return;
    sel.dataset.customReopen = '1';
    sel.addEventListener('click', function () {
      if (sel.value === 'custom') panel.classList.remove('hidden');
    });
  });

  // 面板标题栏不再整条可点：浮层形态下"点标题就折叠"极易误触。
}

// ===== 侧边栏控制 =====
function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const toggle = document.getElementById('sidebarToggle');
  const close = document.getElementById('sidebarClose');
  
  console.log('initSidebar 被调用', { sidebar, overlay, toggle, close });
  
  if (!sidebar || !overlay || !toggle || !close) {
    console.warn('侧边栏元素未找到');
    return;
  }
  
  let isOpen = false;
  
  function openSidebar() {
    console.log('打开侧边栏');
    isOpen = true;
    sidebar.classList.add('open');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    // 侧边栏里的难度下拉与顶栏共用同一份状态：每次打开都同步一次，
    // 否则玩家在顶栏改过难度后，侧边栏里显示的还是打开前的旧值（第 11 条）。
    try {
      const ds = document.getElementById('sidebarDifficultySelect');
      if (ds && refs && refs.difficultySelect) ds.value = refs.difficultySelect.value;
    } catch (e) { /* 忽略 */ }
  }
  
  function closeSidebar() {
    console.log('关闭侧边栏');
    isOpen = false;
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }
  
  function toggleSidebar(e) {
    e.stopPropagation();
    console.log('切换侧边栏, 当前状态:', isOpen);
    isOpen ? closeSidebar() : openSidebar();
  }
  
  toggle.addEventListener('click', toggleSidebar);
  close.addEventListener('click', closeSidebar);
  overlay.addEventListener('click', closeSidebar);
  
  // ESC 键关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      closeSidebar();
    }
  });
  
  // 暴露到全局
  window.sidebar = { open: openSidebar, close: closeSidebar, toggle: toggleSidebar };

  // ===== 侧边栏里新增的三个入口（第 8 / 11 条）=====
  // 图鉴 / 存档管理 / 难度：它们原来只在顶栏，而 2D 画面里顶栏被画布整个盖住，
  // 等于够不着。这里把它们接进侧边栏 —— 于是开始界面 / 文字界面用侧边栏时，
  // 与顶栏是**同一批按钮、同一套逻辑**（不是复制一份实现）。
  // （2D 画面走的是另一条路：那些功能画在画布内的「菜单」里，由 bridge.openPanel
  //   直接调下面的函数，不经过侧边栏，也不需要先"收侧边栏"。）
  // 绑定与其它侧边栏按钮一致：先收侧边栏，再开目标面板。
  (function bindSidebarExtras() {
    const sbEnc = document.getElementById('sidebarEncyclopediaButton');
    if (sbEnc && !window._sbEncBound) {
      window._sbEncBound = true;
      sbEnc.addEventListener('click', function () {
        closeSidebar();
        openEncyclopediaModal();
      });
    }
    const sbSave = document.getElementById('sidebarSaveButton');
    if (sbSave && !window._sbSaveBound) {
      window._sbSaveBound = true;
      sbSave.addEventListener('click', function () {
        closeSidebar();
        openSaveManager();
      });
    }
    const sbDiff = document.getElementById('sidebarDifficultySelect');
    if (sbDiff && !window._sbDiffBound) {
      window._sbDiffBound = true;
      sbDiff.addEventListener('change', function (ev) {
        // 不改写状态，直接驱动顶栏那个 select 走它原有的 change 逻辑 ——
        // "难度怎么变"只有一个实现，两边不可能漂移。
        if (!refs.difficultySelect) return;
        refs.difficultySelect.value = ev.target.value;
        refs.difficultySelect.dispatchEvent(new Event('change'));
      });
    }
  })();
  
  console.log('侧边栏初始化完成');
}

// ===== 战斗中实时应用自定义难度到当前敌人 =====
function applyCustomDifficultyToCombat() {
    if (state.mode !== 'combat' || !state.combat || !state.combat.enemy) return;
    const c = state.customDifficulty;
    const enemy = state.combat.enemy;
    const name = enemy.name || '';
    const isBoss = name.includes('层主') || state.currentRoom?.type === 'boss';
    const isElite = name.includes('精英') || state.currentRoom?.type === 'elite';
    const base = state.floor * 2 + 4;
    const extraLevel = Math.max(0, state.floor - 10);
    const extraPerLevel = (isBoss ? 0.8 : (isElite ? 0.5 : 0.3)) * (c.enemyExtra || 1);
    const growthFactor = getCustomEnemyGrowthFactor(state.floor);
    enemy.hp = Math.max(1, Math.round(((isBoss ? base + 10 : isElite ? base + 6 : base) * growthFactor) * (c.enemyHp || 1)));
    enemy.maxHp = enemy.hp;
    enemy.attack = Math.max(1, Math.round(((isBoss ? 5 + Math.floor(state.floor / 2) : isElite ? 4 + Math.floor(state.floor / 2) : 3 + Math.floor(state.floor / 2)) * growthFactor) * (c.enemyAtk || 1)));
    const inj = isCustomDifficultyEnabled() ? c : {};
    enemy.thorn = Math.min(5, Math.max(Math.round(extraLevel * extraPerLevel * 0.5), inj.enemyThornInject || 0));
    enemy.dodge = Math.min(30, Math.max(Math.round(extraLevel * extraPerLevel * 0.8), inj.enemyDodgeInject || 0));
    enemy.vampire = Math.min(3, Math.max(Math.round(extraLevel * extraPerLevel * 0.3), inj.enemyVampireInject || 0));
    enemy.combo = Math.min(25, Math.max(Math.round(extraLevel * extraPerLevel * 0.6), inj.enemyComboInject || 0));
    enemy.crit = Math.min(30, Math.max(Math.round(extraLevel * extraPerLevel * 0.7), inj.enemyCritInject || 0));
    enemy.critDamage = 150 + Math.min(50, Math.round(extraLevel * extraPerLevel * 0.5));
    enemy.armor = Math.min(99, Math.max(Math.round(extraLevel * extraPerLevel * 0.5), inj.enemyArmorInject || 0));
}
// 自定义难度悬浮提示
// 说明：key = 对应的输入框/开关/下拉的 DOM id，value = 鼠标悬浮时显示的文字
// 绑定逻辑在 bindCustomDifficultyInputs 中自动套用
const CUSTOM_DIFFICULTY_HELP = {
    customDifficultyEnabled: '【开关】自定义规则总开关：关闭时仅"参数"类数值生效，所有"规则"类参数失效。',
    customEnemyHp: '【参数】敌人生命倍率：1.00为原版，2.0=敌人生成时生命翻倍，0.5=减半。无需打开总开关即生效；战斗中修改会按新倍率重算当前敌人生命。',
    customEnemyAtk: '【参数】敌人攻击倍率：1.00为原版，1.5=敌人攻击提高50%。无需打开总开关即生效。',
    customGoldReward: '【参数】金币奖励倍率：战斗胜利获得的金币按此倍率结算，0.5=金币减半。',
    customShopCost: '【参数】商店价格修正：正数为全体商品加价，负数为降价；实际价格=原价+此值-商人眼光×2，最低为0（免费）。',
    customRestBonus: '【参数】休整加成：在休息点休息时额外恢复的生命值，负数则减少恢复。',
    customEnemyExtra: '【参数】敌人属性强度：10层后敌人随机附加属性（荆棘/闪避/吸血/减伤等）的强度倍率。',
    customEnvironmentScale: '【参数】环境强度：环境效果数值的缩放倍率，2.0=环境数值翻倍。下一层生效。',
    customTrialRounds: '【参数】试炼回合上限：试炼模式的最大回合数，0=随难度默认。下次进入试炼生效。',
    customRewardCount: '【参数】奖励数量：战斗胜利后的奖励选项数量，默认3。',
    customGlassCannon: '【规则】玻璃大炮：开战瞬间双方生命上限降至70%、攻击提升50%，战斗结束恢复。只在开战瞬间生效。',
    customOneHitKill: '【规则】一击必杀：双方每次攻击伤害都压至足以致命，先手方几乎必胜。每次攻击实时判定。',
    customEscalatingPressure: '【规则】递增压迫：每深入一层，双方伤害放大8%，越往后越容易互秒。按当前层数实时计算。',
    customCurseLevel: '【规则】诅咒层级：全体敌人生命+4%/级、攻击+8%/级。实时读取，修改后下一次敌方行动即生效。',
    customRoomCount: '【规则】每层房间数：默认3间（最后一间固定为 Boss）。固定为该值，修改后从下一层开始生效。',
    customFloorCap: '【规则】楼层上限：到达该层后无法继续深入。下一次推进房间时生效。',
    customEnemyThornInject: '【规则】荆棘注入：给所有敌人固定附加反伤（与原版随机属性取较高者）。下一场战斗生效。',
    customEnemyDodgeInject: '【规则】闪避注入：给所有敌人固定附加闪避率。下一场战斗生效。',
    customEnemyVampireInject: '【规则】吸血注入：给所有敌人固定附加吸血等级。下一场战斗生效。',
    customEnemyComboInject: '【规则】连击注入：给所有敌人固定附加连击率。下一场战斗生效。',
    customEnemyCritInject: '【规则】暴击注入：给所有敌人固定附加暴击率。下一场战斗生效。',
    customEnemyArmorInject: '【规则】减伤注入：给所有敌人固定附加减伤（受到的攻击按百分比减免，上限99%）。下一场战斗生效。',
    customGugugagaChance: '【规则】咕咕嘎嘎概率：每个敌袭房间有该概率变成咕咕嘎嘎；对它攻击两刀未死时，下一间也会强制生成咕咕嘎嘎。',
    customDeadBodyChance: '【规则】死尸概率：精英战生成时有该概率变成死尸。下一场精英战生效。',
    customEliteChance: '【规则】精英化概率：普通敌人房间有该概率升级为精英战。下一场战斗生效。',
    customEnemyGrowthCurve: '【规则】敌人成长曲线：敌人属性随楼层数增长的速度倍率，2.0=成长速度翻倍。只影响新生成的敌人。',
    customCommonWeight: '【规则】普通权重：调高后抽遗物时更容易出现普通品质。',
    customRareWeight: '【规则】稀有权重：调高后更容易出现稀有品质。',
    customLegendaryWeight: '【规则】传说权重：调高后更容易出现传说品质。',
    customRelicBlacklist: '【规则】遗物黑名单：填写遗物名（逗号分隔），名单中的遗物不会出现在任何遗物选项里。仅总开关开启时过滤。',
    customEnvironmentPreset: '【规则】固定环境：选"随机"则每层随机环境；选定具体环境后，每层都固定为该环境。下一层生效。'
};

// ===== 自定义难度输入框绑定 =====
function bindCustomDifficultyInputs() {
    const isFirstBind = !window._customDifficultyInputsBound;
    window._customDifficultyInputsBound = true;

    const inputs = [
        { id: 'customEnemyHp', key: 'enemyHp', display: 'customEnemyHpValue', format: (v) => parseFloat(v).toFixed(2) + 'x' },
        { id: 'customEnemyAtk', key: 'enemyAtk', display: 'customEnemyAtkValue', format: (v) => parseFloat(v).toFixed(2) + 'x' },
        { id: 'customGoldReward', key: 'goldReward', display: 'customGoldRewardValue', format: (v) => parseFloat(v).toFixed(2) + 'x' },
        { id: 'customShopCost', key: 'shopCost', display: 'customShopCostValue', format: (v) => (parseFloat(v) >= 0 ? '+' : '') + v },
        { id: 'customRestBonus', key: 'restBonus', display: 'customRestBonusValue', format: (v) => (parseFloat(v) >= 0 ? '+' : '') + v },
        { id: 'customEnemyExtra', key: 'enemyExtra', display: 'customEnemyExtraValue', format: (v) => parseFloat(v).toFixed(2) + 'x' },
        { id: 'customEnvironmentScale', key: 'environmentScale', display: 'customEnvironmentScaleValue', format: (v) => parseFloat(v).toFixed(2) + 'x' },
        { id: 'customTrialRounds', key: 'trialMaxRounds', display: 'customTrialRoundsValue', format: (v) => v > 0 ? `${v} 回合` : '随难度' },
        { id: 'customRewardCount', key: 'rewardCount', display: 'customRewardCountValue', format: (v) => `${v} 选 1` },
        { id: 'customRoomCount', key: 'roomCount', display: 'customRoomCountValue', format: (v) => `${v} 间` },
        { id: 'customFloorCap', key: 'floorCap', display: 'customFloorCapValue', format: (v) => v > 0 ? `第 ${v} 层` : '无上限' },
        { id: 'customEnemyThornInject', key: 'enemyThornInject', display: 'customEnemyThornInjectValue', format: (v) => `${v}` },
        { id: 'customEnemyDodgeInject', key: 'enemyDodgeInject', display: 'customEnemyDodgeInjectValue', format: (v) => `${v}%` },
        { id: 'customEnemyVampireInject', key: 'enemyVampireInject', display: 'customEnemyVampireInjectValue', format: (v) => `${v}` },
        { id: 'customEnemyComboInject', key: 'enemyComboInject', display: 'customEnemyComboInjectValue', format: (v) => `${v}%` },
        { id: 'customEnemyCritInject', key: 'enemyCritInject', display: 'customEnemyCritInjectValue', format: (v) => `${v}%` },
        { id: 'customEnemyArmorInject', key: 'enemyArmorInject', display: 'customEnemyArmorInjectValue', format: (v) => `${v}%` },
        { id: 'customGugugagaChance', key: 'gugugagaChance', display: 'customGugugagaChanceValue', format: (v) => `${v}%` },
        { id: 'customDeadBodyChance', key: 'deadBodyChance', display: 'customDeadBodyChanceValue', format: (v) => `${v}%` },
        { id: 'customEliteChance', key: 'eliteChance', display: 'customEliteChanceValue', format: (v) => `${v}%` },
        { id: 'customEnemyGrowthCurve', key: 'enemyGrowthCurve', display: 'customEnemyGrowthCurveValue', format: (v) => parseFloat(v).toFixed(2) + 'x' },
        { id: 'customCurseLevel', key: 'curseLevel', display: 'customCurseLevelValue', format: (v) => `${v} 级` },
        { id: 'customCommonWeight', key: 'commonWeight', display: 'customCommonWeightValue', format: (v) => `${v}` },
        { id: 'customRareWeight', key: 'rareWeight', display: 'customRareWeightValue', format: (v) => `${v}` },
        { id: 'customLegendaryWeight', key: 'legendaryWeight', display: 'customLegendaryWeightValue', format: (v) => `${v}` },
    ];

    const enabledToggle = document.getElementById('customDifficultyEnabled');
    const resetBtn = document.getElementById('resetCustomDifficultyBtn');
    const warningEl = document.getElementById('customDifficultyWarning');
    let warningTimer = null;
    let hasShownWarning = false;

    const ruleToggles = [
        { id: 'customGlassCannon', key: 'glassCannon' },
        { id: 'customOneHitKill', key: 'oneHitKill' },
        { id: 'customEscalatingPressure', key: 'escalatingPressure' }
    ];

    const advancedSettings = document.getElementById('customAdvancedSettings');

    // 给所有输入框/开关/下拉及其所在行挂上 title 提示。
    Object.keys(CUSTOM_DIFFICULTY_HELP).forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const text = CUSTOM_DIFFICULTY_HELP[id];
        el.title = text;
        const row = el.closest('.custom-diff-item')
                 || el.closest('.custom-rule-item')
                 || el.closest('label')
                 || el.closest('div');
        if (row && row !== el) row.title = text;
    });

    // 输入框：每次调用同步当前值（保证重开/载入后输入框与 state 一致），监听只挂一次
    inputs.forEach(({ id, key, display, format }) => {
        const input = document.getElementById(id);
        const displayEl = document.getElementById(display);
        if (!input || !displayEl) return;

        // 值同步（幂等，每次执行）
        state.customDifficulty = normalizeCustomDifficulty(state.customDifficulty);
        const val0 = state.customDifficulty[key] ?? 0;
        input.value = val0;
        displayEl.textContent = format(val0);

        if (!isFirstBind) return; // 监听绑定（仅首次）

        // 输入中：实时更新数值显示 + 应用到战斗中的敌人
        input.addEventListener('input', function() {
            let val = parseFloat(this.value);
            if (this.value === '' || isNaN(val)) {
                displayEl.textContent = format(0);
                state.customDifficulty[key] = 0;
                if (state.mode !== 'heroSelect' && state.mode !== 'bonusSelect' && state.mode !== 'start') {
                    render();
                }
                return;
            }
            displayEl.textContent = format(val);
            state.customDifficulty[key] = val;
            applyCustomDifficultyToCombat();
            if (state.mode !== 'heroSelect' && state.mode !== 'bonusSelect' && state.mode !== 'start') {
                render();
            }
            showWarningOnce();
        });

        // 失焦：规范化数值并写回输入框
        input.addEventListener('blur', function() {
            let val = parseFloat(this.value);
            if (this.value === '' || isNaN(val)) val = 0;
            this.value = val;
            displayEl.textContent = format(val);
            state.customDifficulty[key] = val;
            if (state.mode !== 'heroSelect' && state.mode !== 'bonusSelect' && state.mode !== 'start') {
                render();
            }
            showWarningOnce();
        });

        // change：兜底同步（应对拖动 number 输入框步进按钮等场景）
        input.addEventListener('change', function() {
            let val = parseFloat(this.value);
            if (this.value === '' || isNaN(val)) val = 0;
            this.value = val;
            displayEl.textContent = format(val);
            state.customDifficulty[key] = val;
            applyCustomDifficultyToCombat();
            if (state.mode !== 'heroSelect' && state.mode !== 'bonusSelect' && state.mode !== 'start') {
                render();
            }
        });
    });

    // 刷新输入框可用状态
    const NEW_INPUT_IDS = new Set([
        'customRoomCount', 'customFloorCap',
        'customEnemyThornInject', 'customEnemyDodgeInject', 'customEnemyVampireInject',
        'customEnemyComboInject', 'customEnemyCritInject', 'customEnemyArmorInject',
        'customGugugagaChance', 'customDeadBodyChance', 'customEliteChance',
        'customEnemyGrowthCurve', 'customCurseLevel',
        'customCommonWeight', 'customRareWeight', 'customLegendaryWeight'
    ]);

    function refreshInputsState() {
        const enabled = normalizeCustomDifficulty(state.customDifficulty).enabled;
        inputs.forEach(({ id }) => {
            const input = document.getElementById(id);
            if (input) input.disabled = !enabled && NEW_INPUT_IDS.has(id);
        });
        const envPreset = document.getElementById('customEnvironmentPreset');
        if (envPreset) envPreset.disabled = !enabled;
        ruleToggles.forEach(({ id }) => {
            const checkbox = document.getElementById(id);
            if (checkbox) checkbox.disabled = !enabled;
        });
        const blacklistInput = document.getElementById('customRelicBlacklist');
        if (blacklistInput) blacklistInput.disabled = !enabled;
        if (advancedSettings) {
            advancedSettings.classList.toggle('collapsed', !enabled);
            advancedSettings.style.display = enabled ? '' : 'none';
        }
        if (enabledToggle) enabledToggle.checked = enabled;
    }

    function checkAllValues() {
        let hasLargeValue = false;
        inputs.forEach(({ id }) => {
            const input = document.getElementById(id);
            if (input) {
                const val = parseFloat(input.value);
                if (!isNaN(val) && Math.abs(val) > 999) {
                    hasLargeValue = true;
                }
            }
        });
        return hasLargeValue;
    }

    function showWarningOnce() {
        if (!warningEl) return;
        if (hasShownWarning) return;
        if (warningTimer) {
            clearTimeout(warningTimer);
            warningTimer = null;
        }
        if (checkAllValues()) {
            hasShownWarning = true;
            warningEl.classList.remove('hidden');
            warningTimer = setTimeout(() => {
                warningEl.classList.add('hidden');
                warningTimer = null;
            }, 3000);
        }
    }

    // 总开关
    if (enabledToggle && isFirstBind) {
        enabledToggle.addEventListener('change', function() {
            state.customDifficulty.enabled = this.checked;
            state.customDifficulty = normalizeCustomDifficulty(state.customDifficulty);
            refreshInputsState();
            if (!this.checked && advancedSettings) {
                advancedSettings.classList.add('collapsed');
                advancedSettings.style.display = 'none';
            }
            if (!this.checked) {
                if (warningEl) warningEl.classList.add('hidden');
            }
            if (state.mode !== 'heroSelect' && state.mode !== 'bonusSelect' && state.mode !== 'start') {
                render();
            }
        });
    }

    // 重置按钮
    if (resetBtn) {
        if (isFirstBind) {
            resetBtn.addEventListener('click', function() {
                state.customDifficulty = normalizeCustomDifficulty({ enabled: state.customDifficulty.enabled !== false });
                const envPresetEl = document.getElementById('customEnvironmentPreset');
                if (envPresetEl) {
                    envPresetEl.value = state.customDifficulty.environmentPreset || 'random';
                }
                const blInput = document.getElementById('customRelicBlacklist');
                if (blInput) {
                    blInput.value = (state.customDifficulty.relicBlacklist || []).join(', ');
                }
                ruleToggles.forEach(({ id, key }) => {
                    const checkbox = document.getElementById(id);
                    if (checkbox) {
                        checkbox.checked = Boolean(state.customDifficulty[key]);
                    }
                });
                inputs.forEach(({ id, display, format, key }) => {
                    const input = document.getElementById(id);
                    const displayEl = document.getElementById(display);
                    if (!input || !displayEl) return;
                    const value = state.customDifficulty[key];
                    input.value = value;
                    displayEl.textContent = format(value);
                });
                refreshInputsState();
                applyCustomDifficultyToCombat();
                render();
            });
        }
    }

    // 固定环境下拉：每次调用重建选项并同步值，监听只挂一次
    const environmentPreset = document.getElementById('customEnvironmentPreset');
    if (environmentPreset) {
        const names = ['random', ...ENVIRONMENT_EFFECTS.map(env => env.name)];
        environmentPreset.innerHTML = names.map(name => `<option value="${name}">${name === 'random' ? '随机' : name}</option>`).join('');
        environmentPreset.value = normalizeCustomDifficulty(state.customDifficulty).environmentPreset || 'random';
        if (isFirstBind) {
            environmentPreset.addEventListener('change', function() {
                state.customDifficulty.environmentPreset = this.value;
                if (this.value !== 'random') {
                    state.customDifficulty.fixedEnvironment = 'fixed';
                } else {
                    state.customDifficulty.fixedEnvironment = 'random';
                }
                state.customDifficulty = normalizeCustomDifficulty(state.customDifficulty);
                if (state.mode !== 'heroSelect' && state.mode !== 'bonusSelect' && state.mode !== 'start') {
                    render();
                }
            });
        }
    }

    // 遗物黑名单：每次调用同步值，监听只挂一次
    const blacklistInput = document.getElementById('customRelicBlacklist');
    if (blacklistInput) {
        blacklistInput.value = (normalizeCustomDifficulty(state.customDifficulty).relicBlacklist || []).join(', ');
        if (isFirstBind) {
            blacklistInput.addEventListener('input', function() {
                state.customDifficulty.relicBlacklist = String(this.value)
                    .split(/[，,;；|]/)
                    .map(item => item.trim())
                    .filter(Boolean);
                state.customDifficulty = normalizeCustomDifficulty(state.customDifficulty);
                if (state.mode !== 'heroSelect' && state.mode !== 'bonusSelect' && state.mode !== 'start') {
                    render();
                }
            });
        }
    }

    // 规则开关（玻璃大炮/一击必杀/递增压迫）：每次调用同步勾选，监听只挂一次
    ruleToggles.forEach(({ id, key }) => {
        const checkbox = document.getElementById(id);
        if (!checkbox) return;
        checkbox.checked = Boolean(normalizeCustomDifficulty(state.customDifficulty)[key]);
        if (isFirstBind) {
            checkbox.addEventListener('change', function() {
                state.customDifficulty[key] = this.checked;
                state.customDifficulty = normalizeCustomDifficulty(state.customDifficulty);
                if (state.mode !== 'heroSelect' && state.mode !== 'bonusSelect' && state.mode !== 'start') {
                    render();
                }
            });
        }
    });

    refreshInputsState();
}


function openCustomDifficultyHelp() {
    let overlay = document.getElementById('customHelpOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'customHelpOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
        overlay.innerHTML = '<div id="customHelpBox" style="background:#1a1f2e;color:#dfe6f5;border-radius:12px;max-width:560px;width:100%;max-height:80vh;overflow-y:auto;padding:20px;box-shadow:0 8px 30px rgba(0,0,0,.5);"></div>';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    }
    const groups = [
      ['开关', (t) => t.startsWith('【开关】')],
      ['基础数值（无需打开开关，始终生效）', (t) => t.startsWith('【参数】')],
      ['自定义规则（需打开总开关）', (t) => t.startsWith('【规则】')]
    ];
    const html = groups.map(([title, match]) => {
        const items = Object.entries(CUSTOM_DIFFICULTY_HELP)
            .filter(([, t]) => match(t))
            .map(([, t]) => '<li style="margin:6px 0;line-height:1.55;">'
                + t.replace('【', '<b>【').replace('】', '】</b>') + '</li>')
            .join('');
        return items ? '<h4 style="margin:14px 0 6px;">' + title + '</h4><ul style="padding-left:18px;margin:0;">' + items + '</ul>' : '';
    }).join('');
    overlay.querySelector('#customHelpBox').innerHTML =
        '<h3 style="margin:0 0 4px;">自定义难度说明</h3>'
        + '<p style="margin:0 0 8px;font-size:0.8rem;opacity:.7;">点击弹窗外部空白处关闭</p>' + html;
}

// ===== 创建低血量雾气层 =====
function updateLowHpFog() {
  let fog = document.querySelector('.fog-layer');
  if (!fog) {
    fog = document.createElement('div');
    fog.className = 'fog-layer';
    document.body.appendChild(fog);
    console.log('雾层已在 updateLowHpFog 中重新创建');
  }

  let hp, maxHp;
  if (state.trial && state.trial?.active && state.trial.player) {
    hp = state.trial.player.hp;
    maxHp = state.trial.player.maxHp;
  } else if (state.player) {
    hp = state.player.hp;
    maxHp = state.player.maxHp;
  } else {
    // 玩家不存在时强制隐藏雾气
    fog.classList.remove('active');
    return;
  }

  if (maxHp > 0 && hp / maxHp <= 0.3) {
    fog.classList.add('active');
  } else {
    fog.classList.remove('active');
  }
}

/* ============================================================
   （已废弃的 Trial 空壳说明）
   试炼关停期间这里曾放过一个 no-op 空壳，用来兜住历史遗留的 Trial.* 调用。
   调用点现已全部清理，空壳随之删除 —— 下面这段保留作记录：
   ------------------------------------------------------------
   新版不再加载 试炼程序.js：它的职责已经全部并入 ——
     · 实时战斗 → 战斗2D.js + 经典2D.js
     · 横屏/全屏 → 经典2D.js 的 requestLandscape（挂在开始按钮的手势链上）
     · --trial2d-vh → 经典2D.js 的 updateVh
   但主程序里历史遗留的 Trial.* 调用点还有若干处（清理要分步走，
   一次全删的风险是"漏一处就整局崩"）。这里先用一个**空壳**兜住：
   所有入口退化成无害的 no-op 或一句说明，玩家看不到报错。
   这份空壳会在 §7 清单清理完毕后一并删除。
   ============================================================ */
// Trial 空壳已删除：调用点全部清理完毕（P5）。

function initGame() {
  window._sessionId = Math.random().toString(36).slice(2);// 多标签页防护
  // 强制重置雾气
  const fog = document.querySelector('.fog-layer');
  if (fog) fog.classList.remove('active');

  // 如果开始界面还在显示，不启动游戏
  const startScreen = document.getElementById('startScreen');
  if (startScreen && !startScreen.classList.contains('hidden')) {
      console.log('⏳ 等待开始界面...');
      return;
  }

  // ===== 2D 引擎预载（阶段3优化）=====
  // 能走到这里，说明玩家已经点了「开始游戏」。接下来不是进选英雄、就是读档直接进
  // 房间 —— 两种情况迟早都要 2D 引擎。现在就开始后台下载：不 await、不阻塞下面任何
  // 流程，首屏那 417 KB 早已渲染完毕，这 1467 KB 是白捡的时间。
  // 加载失败只在 console 留一行警告，游戏照旧走原有的文字界面降级路径。
  if (window.__加载2D引擎) {
      try { window.__加载2D引擎(); } catch (e) { console.warn('[2D] 预载启动失败：', e); }
  }

  // 尝试迁移旧存档
  migrateOldSave();

  // 首启提示：确实从老版（2.6）复制过存档才提示，且只提示一次（复制只发生一次）
  if (NS_INHERITED_KEYS > 0) {
    setTimeout(() => {
      showToast(`📂 已继承 2.6 存档（${NS_INHERITED_KEYS} 项）· 新版与老版进度各自独立`, 'info');
    }, 700);
  }

  // ===== 试炼模块已关停（P5）：不再需要注入依赖 =====

  // ===== 尝试加载当前活跃槽位 =====
  if (loadGame()) {
      // ⚠️ 读到的是"尚未开始"的档（没有英雄 / mode 还停在 start）→ **直接进选英雄**。
      //    不能就这么交给 render()：它对 'start' 没有任何渲染分支，结果是一片空白，
      //    玩家既看不到开始界面也进不了游戏（实测踩到）。
      //    这类档正是旧版 saveGame 没有守卫时写出来的空档。
      if (!state.hero || state.mode === 'start') {
          console.log('存档尚未开始 → 进入选英雄');
          state.mode = 'heroSelect';
          state.gameOver = false;
          state.endResult = null;
          state.currentRoom = null;
          state.rooms = [];
          render();
          renderLog();
          setTimeout(() => {
              bindCustomDifficultyInputs();
              initSidebar();
              bindAttributeClickEvents();
              bindAllEvents();
              rebindCheatEvents();
              initTestPanelCommunication();
          }, 50);
          return;
      }
      // ===== 存档已经开局 → 进来就是 2D 画面，必须等引擎就绪（阶段3优化）=====
      // 这条路径没有「选英雄 / 选增益」那段缓冲（玩家读的是打到一半的档），
      // 所以这里必须兜一道。引擎已就绪时 __确保2D引擎 会**同步**回调，
      // 走的还是原来那几行、行为完全一致；只有确实没下完时才显示「正在启动 2D…」。
      var _继续读档 = function () {
          // 补入场标记必须早于 render()：引擎一旦判定"不接管"，就会把 mode 改回
          // 内核的 'event' 并收起画布 —— 那之后再补也来不及，2D 起不来（详见函数注释）
          ensureHostRoomMark();
          render();
          renderLog();
          addLog('📂 已加载存档，继续冒险！');
          setTimeout(() => {
              bindCustomDifficultyInputs();
              initSidebar();
              bindAttributeClickEvents();
              bindAllEvents();
              rebindCheatEvents();
              initTestPanelCommunication();
          }, 50);
      };
      if (window.__确保2D引擎) { window.__确保2D引擎(_继续读档); } else { _继续读档(); }
      return;
  }

  // ===== 加载失败，先重置 state 到初始状态 =====
  // 重置玩家属性
  state.player.hp = 24;
  state.player.maxHp = 24;
  state.player.attack = 5;
  state.player.shield = 0;
  state.player.gold = 0;
  state.player.level = 1;
  state.player.potions = 1;
  state.player.strengthPotions = 0;
  state.player.xp = 0;
  state.floor = 1;
  state.roomIndex = 0;
  state.vampireLevel = 0;
  state.thornLevel = 0;
  state.hasLifeShield = false;
  state.hasDoubleGold = false;
  state.hasExpBoost = false;
  state.luckyLevel = 0;
  state.critDamage = 150;
  state.hasAncientBless = false;
  state.dodgeLevel = 0;
  state.comboLevel = 0;
  state.executeLevel = 0;
  state.comboDamageBonus = 0;
  state.executeThreshold = 0.3;
  state.hasFirstAttackCombo = false;
  state.hasKillScythe = false;
  state.hasTotem = false;
  state.hasFateWheel = false;
  state.hasShadowDeal = false;
  state.isFirstAttack = true;
  state.rooms = generateFloorRooms(1);
  state.environment = generateEnvironmentEffect(1, state.difficulty || 'normal');
  // 新开一局 = 诅咒也必须从零开始（第 1 条）：
  // 上面这一行只重掷了环境，而实时化诅咒挂在 state._rtCurses 上，
  // 漏掉它就会有「重开之后身上还带着上一局诅咒」。
  state._rtCurses = [];
  const envDesc = state.environment.displayValue ? 
    `${state.environment.name} - ${formatEnvDescription(state.environment)} (${state.environment.displayValue})` :
    `${state.environment.name} - ${formatEnvDescription(state.environment)}`;
  addLog(`当前楼层环境效果：${envDesc}`);
  state.currentRoom = null;
  state.combat = null;
  state.rewardOptions = [];
  state.eventOptions = [];
  state.shopOptions = [];
  state.relics = [];
  state.log = [];
  state.shopPurchaseCount = {};
  state.shopLimitBonus = 0;
  state.gameOver = false;
  state.hero = null;
  state.heroSkillUsed = false;
  state.heroSkillBonus = 0;
  state.heroPendingHeal = 0;
  state.availableBonuses = [];
  state.bonuses = [];
  state.endOptions = [];
  state.endResult = null;
  state.mode = 'heroSelect';
  state.gugugagaAttackCount = 0;
  state._pendingGugugaga = false;

  // 试炼已关停（P5）：原先这里要重新初始化试炼模块，现在整块移除。

  // ===== 然后创建默认槽位（此时 state 是全新的） =====
  ensureDefaultSlot();

  // ===== 再次尝试加载（应该成功） =====
  if (loadGame()) {
      render();
      renderLog();
      addLog('📂 已创建新存档，开始冒险！');
      setTimeout(() => {
          bindCustomDifficultyInputs();
          initSidebar();
          bindAttributeClickEvents();
          bindAllEvents();
          rebindCheatEvents();
          initTestPanelCommunication();
      }, 50);
      return;
  }

  // ===== 极少数情况：仍然失败，直接渲染新游戏 =====
  addLog('一条被遗忘的通道在你眼前打开了。');
  render();
  bindAttributeClickEvents();
  bindCustomDifficultyInputs();
  initCustomDifficultyCollapse();
  initExternalSync();
  initSidebar();
  bindAllEvents();
  // ⚠️ 原来这里还调了一次 createFogLayer()，但那个函数已随试炼一起在 P5 清理掉了，
  //    调用点漏删 —— 它会抛 ReferenceError **打断 initGame() 的收尾**，
  //    下面的 initTestPanelCommunication() 永远执行不到（实测：选完开局增益后进不了 2D）。
  //    雾层是试炼时代的氛围元素，新版不再需要，直接去掉调用。
  initTestPanelCommunication();
}

function loadRecordsFromStorage() {
  try {
    const stored = localStorage.getItem('abyssRecords');
    if (!stored) return;
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === 'object') {
      const difficulties = ['easy', 'normal', 'hard', 'hell'];
      difficulties.forEach(diff => {
        if (!parsed[diff]) {
          parsed[diff] = { bestFloor: 0, clears: 0, deaths: 0 };
        } else if (parsed[diff].deaths === undefined) {
          parsed[diff].deaths = 0;
        }
      });
      state.records = parsed;
    }
  } catch (error) {
    console.warn('读取记录失败：', error);
  }
}

function saveRecordsToStorage() {
  try {
    localStorage.setItem('abyssRecords', JSON.stringify(state.records));
  } catch (error) {
    console.warn('保存记录失败：', error);
  }
}

function addPotion(type, amount = 1) {
  if (type === 'strength') {
    state.player.strengthPotions += amount;
    addLog(`你获得了 ${amount} 瓶力量药水。`);
  } else {
    state.player.potions += amount;
    addLog(`你获得了 ${amount} 瓶治疗药水。`);
  }
  return amount;
}

function generateFloorRooms(floor) {
  const rooms = [];
  const custom = state && state.difficulty === 'custom' && isCustomDifficultyEnabled()
    ? normalizeCustomDifficulty(state.customDifficulty)
    : null;
  const defaultCount = 4 + Math.min(2, floor - 1);
  const count = custom && custom.roomCount > 0 ? custom.roomCount : defaultCount;

  for (let i = 0; i < count; i += 1) {
    if (i === count - 1) {
      rooms.push({ type: 'boss' });
    } else {
      const previousType = rooms[rooms.length - 1]?.type;
      // shrine（祭坛）：2.7 新增。经典原本没有祭坛房，但 2D 引擎有现成的祭坛，
      // 而诅咒系统需要一条「献祭生命解除诅咒」的解除途径（规划 §3.5）。
      const pool = ['enemy', 'mirror', 'rest', 'treasure', 'shop', 'event', 'shrine'];
      if (floor > 1) pool.push('elite');
      let available = pool.filter(type => !(type === 'shop' && previousType === 'shop'));
      if (floor === 1 && i === 0) {
        available = available.filter(type => type !== 'shop' && type !== 'rest');
      }
      const picked = available[Math.floor(Math.random() * available.length)];
      rooms.push({ type: picked });
    }
  }
  return rooms;
}

function enterCurrentRoom() {
  state.currentRoom = state.rooms[state.roomIndex];
  if (!state.currentRoom) {
    advanceRoom();
    return;
  }

  if (state._pendingGugugaga) {
    state._pendingGugugaga = false;
    state.currentRoom.type = 'enemy';
    state.currentRoom.isGugugaga = true;
    addLog('咕咕嘎嘎发力了，下一间变成了咕咕嘎嘎！');
  }

  if (state.currentRoom.type === 'boss') {
    state.mode = 'bossPrep';
    state.combat = null;
    return;
  }

  if (state.currentRoom.type === 'enemy' || state.currentRoom.type === 'mirror') {
    startCombat();
  } else {
    state.mode = 'event';
    state.combat = null;
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try { AbyssAudio.sfx('door'); } catch (e) { console.warn('[音效] 开门音效播放失败:', e); }
    }
  }
}

// ===== 从模板重建环境对象（保留钩子函数，替代 JSON 克隆） =====
function rebuildEnvironmentFromTemplate(env, fallbackFloor) {
    if (!env || !env.name) return null;
    const template = ENVIRONMENT_EFFECTS.find(e => e.name === env.name);
    if (!template) return env;
    const floor = env._floor || fallbackFloor || state.floor || 1;
    const diffScale = env._diffScale || 1;
    const d = template.create(floor, diffScale);
    return {
        name: template.name,
        description: template.description.replace('{value}', d.display),
        values: d.values, displayValue: d.display,
        damageModifier: d.damageModifier || 0,
        onCombatStart: d.onCombatStart || null, onPlayerAttack: d.onPlayerAttack || null,
        onEnemyTurn: d.onEnemyTurn || null, applyTurnEffects: d.applyTurnEffects || null,
        onHeal: d.onHeal || null, onVictory: d.onVictory || null,
        onPlayerDefend: d.onPlayerDefend || null,
        _floor: floor, _diffScale: diffScale
    };
}


// 清除战斗临时加成（所有战斗结束出口统一调用）
function clearTempCombatBonuses() {
    // 玩家侧临时加成清零
    if (state.player) {
        state.player.tempAttackBonus = 0;
        state.player.luckyBonus = 0;
        state.player.critDamageBonus = 0;
        state.player.comboBonus = 0;
        state.player.dodgeBonus = 0;
        state.player.attackPercentMod = 1;
        // 缓慢凋零：恢复战斗开始时的生命上限
        if (state.combat && state.combat.playerMaxHpSnapshot != null) {
            state.player.maxHp = state.combat.playerMaxHpSnapshot;
            state.player.hp = Math.min(state.player.hp, state.player.maxHp);
            state.combat.glassCannonHpSnapshot = null;
        }
    }
    // 敌人侧（敌人对象随战斗销毁，保险起见一并清零）
    if (state.combat && state.combat.enemy) {
        const e = state.combat.enemy;
        e.tempAttackBonus = 0;
        e.dodgeBonus = 0;
        e.critBonus = 0;
        e.critDamageBonus = 0;
        e.comboBonus = 0;
        e.attackPercentMod = 1;
    }
}

function startCombat(isElite = false, forceType = null) {
    // ===== 初始化玩家临时加成（每场战斗前清零） =====
    state.player.tempAttackBonus = 0;
    state.player.luckyBonus = 0;
    state.player.critDamageBonus = 0;
    state.player.comboBonus = 0;
    state.player.dodgeBonus = 0;

    // ===== 获取当前房间类型 =====
    let roomType = state.currentRoom ? state.currentRoom.type : 'enemy';
    const customRuleEffects = getCustomDifficultyRuleEffects();

    // 如果 forceType 指定，覆盖 roomType（用于特殊召唤）
    if (forceType) {
        if (forceType === 'boss') roomType = 'boss';
        else if (forceType === 'elite') roomType = 'elite';
        else if (forceType === 'gugugaga') roomType = 'gugugaga';
        else if (forceType === 'enemy') roomType = 'enemy';
    }

    // ===== 判断是否为咕咕嘎嘎（特殊处理） =====
    let isGugugaga = false;
    if (forceType === 'gugugaga' || (state.currentRoom && state.currentRoom.isGugugaga)) {
        isGugugaga = true;
    }

    // ===== 获取难度修正 =====
    let modifier = difficultyModifiers[state.difficulty] || difficultyModifiers.normal;
    if (state.difficulty === 'custom') {
        const c = normalizeCustomDifficulty(state.customDifficulty);
        modifier = {
            enemyHp: c.enemyHp || 1,
            enemyAtk: c.enemyAtk || 1,
            goldReward: c.goldReward || 1,
            shopCost: c.shopCost || 0,
            restBonus: c.restBonus || 0,
            enemyExtra: c.enemyExtra || 1
        };
    }

    const floor = state.floor;
    const base = floor * 2 + 4;
    const extraLevel = Math.max(0, floor - 10);
    const extraPerLevel = 0.3 * (modifier.enemyExtra || 1);

    // ===== 辅助函数：生成基础敌人属性（与黑暗爪牙一致） =====
    function generateBaseEnemy(hpBase, atkBase, isBoss, isElite) {
        const growthFactor = getCustomEnemyGrowthFactor(floor);
        const hp = Math.max(1, Math.round((hpBase * growthFactor) * modifier.enemyHp * (customRuleEffects.enemyHpMultiplier || 1)));
        const atk = Math.max(1, Math.round((atkBase * growthFactor) * modifier.enemyAtk));
        const extraMult = isBoss ? 0.8 : (isElite ? 0.5 : 0.3);
        const armorMult = (difficultyModifiers[state.difficulty]?.enemyArmor ?? 1);
        const thorn = Math.min(5, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.5));
        const dodge = Math.min(30, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.8));
        const vampire = Math.min(3, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.3));
        const combo = Math.min(25, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.6));
        const crit = Math.min(30, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.7));
        const critDamage = 150 + Math.min(50, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.5));
        const armor = Math.min(99, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * armorMult * 0.5));
        const injections = getCustomEnemyInjection();
        return {
            hp, atk,
            thorn: Math.max(thorn, injections.thorn),
            dodge: Math.max(dodge, injections.dodge),
            vampire: Math.max(vampire, injections.vampire),
            combo: Math.max(combo, injections.combo),
            crit: Math.max(crit, injections.crit),
            critDamage,
            armor: Math.max(armor, injections.armor)
        };
    }

    // ===== 概率掷骰：必须在生成敌人之前执行 =====
    // 精英化概率 → 咕咕嘎嘎概率，普通敌人房间依次判定
    const custom = state && state.difficulty === 'custom' && isCustomDifficultyEnabled() ? normalizeCustomDifficulty(state.customDifficulty) : null;
    if (!isGugugaga && roomType === 'enemy' && custom && custom.eliteChance > 0 && Math.random() < custom.eliteChance / 100) {
        roomType = 'elite';
    }
    if (!isGugugaga && roomType === 'enemy' && custom && custom.gugugagaChance > 0 && Math.random() < custom.gugugagaChance / 100) {
        isGugugaga = true;
    }

    // ===== 根据房间类型生成敌人 =====
    let enemy = null;
    let isShadowKing = false;
    let shadowKingSealBackup = null; // 用于临时存储被封印的属性

    if (isGugugaga) {
        const gStats = generateBaseEnemy(40, 3, false, false);
        enemy = {
            name: '咕咕嘎嘎',
            hp: gStats.hp, maxHp: gStats.hp, attack: gStats.atk,
            thorn: gStats.thorn, dodge: gStats.dodge, vampire: gStats.vampire,
            combo: gStats.combo, crit: gStats.crit, critDamage: gStats.critDamage,
            armor: gStats.armor,
            firstStrikeReduction: 0, tempAttackBonus: 0, dodgeBonus: 0,
            critBonus: 0, critDamageBonus: 0, comboBonus: 0, attackPercentMod: 1,
            isGugugaga: true
        };
    }

    if (!enemy && roomType === 'mirror') {
      // ----- 镜像房间 -----
      const isMirror = Math.random() < 0.8; // 80% 镜像怪，20% 复制法师
      const attackPercent = isMirror ? 0.4 : 0.75;
      const hpPercent = isMirror ? 0.5 : 0.9;
      const mirrorScale = customRuleEffects.glassCannon ? 0.7 : 1;
      const baseAtk = Math.max(1, Math.round(state.player.attack * attackPercent * (customRuleEffects.glassCannon ? 1.5 : 1)));
      const baseHp = Math.max(1, Math.round(state.player.hp * hpPercent * mirrorScale));
      const injections = getCustomEnemyInjection();
      const extraMult = 0.3;
      const armorMult = (difficultyModifiers[state.difficulty]?.enemyArmor ?? 1);
      const thorn = Math.min(5, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.5));
      const dodge = Math.min(30, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.8));
      const vampire = Math.min(3, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.3));
      const combo = Math.min(25, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.6));
      const crit = Math.min(30, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.7));
      const critDamage = 150 + Math.min(50, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.5));
      const armor = Math.min(99, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * armorMult * 0.5));
      const name = isMirror ? '镜像怪' : '复制法师';
      enemy = {
          name: name,
          hp: baseHp, maxHp: baseHp, attack: baseAtk,
          thorn: Math.max(thorn, injections.thorn), dodge: Math.max(dodge, injections.dodge),
          vampire: Math.max(vampire, injections.vampire), combo: Math.max(combo, injections.combo),
          crit: Math.max(crit, injections.crit), critDamage,
          armor: Math.max(armor, injections.armor),
          firstStrikeReduction: 0, tempAttackBonus: 0, dodgeBonus: 0,
          critBonus: 0, critDamageBonus: 0, comboBonus: 0, attackPercentMod: 1,
          isMirror: true,
      };
    } else if (roomType === 'boss') {
        // ----- Boss 房间 -----
        const isShadowKing = Math.random() < 0.3; // 30% 影之皇
        if (isShadowKing) {
            const hpBase = base + 10;
            const atkBase = 5 + Math.floor(floor / 2);
            const baseStats = generateBaseEnemy(hpBase, atkBase, true, false);
            enemy = {
                name: '影之皇',
                hp: baseStats.hp, maxHp: baseStats.hp, attack: baseStats.atk,
                thorn: baseStats.thorn, dodge: baseStats.dodge, vampire: baseStats.vampire,
                combo: baseStats.combo, crit: baseStats.crit, critDamage: baseStats.critDamage,
                armor: baseStats.armor,
                firstStrikeReduction: 0, tempAttackBonus: 0, dodgeBonus: 0,
                critBonus: 0, critDamageBonus: 0, comboBonus: 0, attackPercentMod: 1,
                isShadowKing: true,
            };
            // 触发影之皇进场效果
            const roll = Math.random();
            if (roll < 0.3) {
                state.nextDamageIncrease = 40;
                addLog('你被影之皇的深渊能量污染，下次受到的伤害增加40%');
            } else if (roll < 0.6) {
                state.player.shield = 0;
                addLog('你被影之皇的深渊能量污染，护盾值归零');
            } else if (roll < 0.9) {
                shadowKingSealBackup = {
                    luckyLevel: state.luckyLevel || 0,
                    critDamage: state.critDamage || 150,
                    thornLevel: state.thornLevel || 0,
                    vampireLevel: state.vampireLevel || 0,
                    dodgeLevel: state.dodgeLevel || 0,
                    comboLevel: state.comboLevel || 0,
                    executeLevel: state.executeLevel || 0,
                };
                state.luckyLevel = 0;
                state.critDamage = 150;
                state.thornLevel = 0;
                state.vampireLevel = 0;
                state.dodgeLevel = 0;
                state.comboLevel = 0;
                state.executeLevel = 0;
                state.shadowKingSealBackup = shadowKingSealBackup;
                addLog('你被影之皇的深渊能量污染，部分力量被影之皇封印');
            } else {
                addLog('无事发生');
            }
        } else {
            // 正常层主
            const hpBase = base + 10;
            const atkBase = 5 + Math.floor(floor / 2);
            const baseStats = generateBaseEnemy(hpBase, atkBase, true, false);
            enemy = {
                name: `层主 ${floor}`,
                hp: baseStats.hp, maxHp: baseStats.hp, attack: baseStats.atk,
                thorn: baseStats.thorn, dodge: baseStats.dodge, vampire: baseStats.vampire,
                combo: baseStats.combo, crit: baseStats.crit, critDamage: baseStats.critDamage,
                armor: baseStats.armor,
                firstStrikeReduction: 0, tempAttackBonus: 0, dodgeBonus: 0,
                critBonus: 0, critDamageBonus: 0, comboBonus: 0, attackPercentMod: 1,
            };
        }
    } else if (roomType === 'elite') {
        // ----- 精英战 -----
        const elitePool = ['精英守卫', '死尸', '岩浆行者', '影（窃）', '影（附身）', '影（魅）', '死灵法师'];
        let chosen = elitePool[Math.floor(Math.random() * elitePool.length)];
        if (custom && custom.deadBodyChance > 0 && Math.random() < custom.deadBodyChance / 100) {
            chosen = '死尸';
        }
        let hpBase, atkBase;
        switch (chosen) {
            case '精英守卫': hpBase = base + 6; atkBase = 4 + Math.floor(floor / 2); break;
            case '死尸': hpBase = base + 6; atkBase = 4 + Math.floor(floor / 2); break;
            case '岩浆行者': hpBase = base + 6; atkBase = 4 + Math.floor(floor / 2); break;
            case '影（窃）': hpBase = base + 3; atkBase = 3 + Math.floor(floor / 2); break;
            case '影（附身）': hpBase = base - 1; atkBase = 5 + Math.floor(floor / 2) + 2; break;
            case '影（魅）': hpBase = base + 2; atkBase = 3 + Math.floor(floor / 2); break;
            case '死灵法师': hpBase = base + 1; atkBase = 5 + Math.floor(floor / 2) + 2; break;
        }
        const baseStats = generateBaseEnemy(hpBase, atkBase, false, true);
        enemy = {
            name: chosen,
            hp: baseStats.hp, maxHp: baseStats.hp, attack: baseStats.atk,
            thorn: baseStats.thorn, dodge: baseStats.dodge, vampire: baseStats.vampire,
            combo: baseStats.combo, crit: baseStats.crit, critDamage: baseStats.critDamage,
            armor: baseStats.armor,
            firstStrikeReduction: 0, tempAttackBonus: 0, dodgeBonus: 0,
            critBonus: 0, critDamageBonus: 0, comboBonus: 0, attackPercentMod: 1,
        };
        if (chosen === '死尸') { enemy.isDeadBody = true; enemy.thorn = 1; }
        else if (chosen === '岩浆行者') { enemy.isLavaWalker = true; }
        else if (chosen === '影（窃）') { enemy.isShadowThief = true; }
        else if (chosen === '影（附身）') { enemy.isShadowPossess = true; }
        else if (chosen === '影（魅）') { enemy.isShadowCharm = true; }
        else if (chosen === '死灵法师') { enemy.isNecromancer = true; }
    } else if (!enemy) {
        // ----- 普通敌袭（enemy） -----
        const isSkeleton = Math.random() < 0.5; // 50% 骷髅骑兵
        if (isSkeleton) {
            const hpBase = base;
            const atkBase = 3 + Math.floor(floor / 2);
            const baseStats = generateBaseEnemy(hpBase, atkBase, false, false);
            enemy = {
                name: '骷髅骑兵',
                hp: baseStats.hp, maxHp: baseStats.hp, attack: baseStats.atk,
                thorn: baseStats.thorn, dodge: 50, vampire: baseStats.vampire,
                combo: 40, crit: 40, critDamage: 150,
                armor: baseStats.armor,
                firstStrikeReduction: 0, tempAttackBonus: 0, dodgeBonus: 0,
                critBonus: 0, critDamageBonus: 0, comboBonus: 0, attackPercentMod: 1,
            };
        } else {
            const hpBase = base;
            const atkBase = 3 + Math.floor(floor / 2);
            const baseStats = generateBaseEnemy(hpBase, atkBase, false, false);
            enemy = {
                name: '黑暗爪牙',
                hp: baseStats.hp, maxHp: baseStats.hp, attack: baseStats.atk,
                thorn: baseStats.thorn, dodge: baseStats.dodge, vampire: baseStats.vampire,
                combo: baseStats.combo, crit: baseStats.crit, critDamage: baseStats.critDamage,
                armor: baseStats.armor,
                firstStrikeReduction: 0, tempAttackBonus: 0, dodgeBonus: 0,
                critBonus: 0, critDamageBonus: 0, comboBonus: 0, attackPercentMod: 1,
            };
        }
    }

    // ===== 设置战斗环境 =====
    state.combat = { enemy, turn: 1 };
    state.combat.playerMaxHpSnapshot = state.player.maxHp;
    if (customRuleEffects.glassCannon) {
        state.combat.glassCannonHpSnapshot = state.player.maxHp;
        state.player.maxHp = Math.max(1, Math.round(state.player.maxHp * 0.7));
        state.player.hp = Math.min(state.player.hp, state.player.maxHp);
    }
    state.combat.environment = state.environment ? rebuildEnvironmentFromTemplate(state.environment, state.floor) : null;

    // 初始化攻击百分比修正
    state.player.attackPercentMod = 1;
    enemy.attackPercentMod = 1;
    const env = state.combat.environment;
    if (env && typeof env.onCombatStart === 'function') {
        env.onCombatStart(state.player, enemy);
        if (env.values) {
            const bonusText = Object.entries(env.values)
                .filter(([k, v]) => v !== 0)
                .map(([k, v]) => `${k}: +${(v * 100).toFixed(0)}%`)
                .join(', ');
            if (bonusText) {
                console.log(`环境效果“${env.name}”已生效：${bonusText}`);
            }
        }
    }

    // 玩家闪避：上限 50%
    state.player.dodge = Math.min(50, ((state.dodgeLevel || 0) * 5) + (state.player.dodgeBonus || 0));
    state.player.dodgeBonus = 0;
    // 玩家暴击率：上限 100%
    state.player.lucky = Math.min(100, ((state.luckyLevel || 0) * 10) + (state.player.luckyBonus || 0));
    state.player.luckyBonus = 0;
    // 玩家连击：上限 40%
    state.player.combo = Math.min(40, ((state.comboLevel || 0) * 5) + (state.player.comboBonus || 0));
    state.player.comboBonus = 0;
    // 敌人闪避：上限 30%
    enemy.dodge = Math.min(30, (enemy.dodge || 0) + (enemy.dodgeBonus || 0));
    enemy.dodgeBonus = 0;
    // 敌人暴击率：上限 30%
    enemy.crit = Math.min(30, (enemy.crit || 0) + (enemy.critBonus || 0));
    enemy.critBonus = 0;
    // 敌人连击：上限 25%
    enemy.combo = Math.min(25, (enemy.combo || 0) + (enemy.comboBonus || 0));
    enemy.comboBonus = 0;
    // 敌人减伤：上限 99%（百分比，受到的攻击按此比例减免）
    enemy.armor = Math.min(99, (enemy.armor || 0) + (enemy.armorBonus || 0));
    enemy.armorBonus = 0;

    state.mode = 'combat';
    state.heroSkillBonus = 0;
    state.heroPendingHeal = 0;
    state.isFirstAttack = true;
    state.comboCount = 0;
    state.executeCount = 0;
    state.dodgeCount = 0;
    state.critCount = 0;

    addLog(`${enemy.name} 出现在你面前。`);

    // 战斗开始音效：Boss 专属号角 / 精英战鼓 / 镜像诡异音 / 普通战鼓号角
    // （战斗 BGM 场景由 render() 内 syncScene 按房间类型自动切换）
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try {
        if (roomType === 'boss') AbyssAudio.sfx('boss');
        else if (roomType === 'elite') AbyssAudio.sfx('elite');
        else if (roomType === 'mirror') AbyssAudio.sfx('mirror');
        else AbyssAudio.sfx('battleStart');
      } catch (error) {
        console.warn('[音效] 战斗开始音效播放失败:', error);
      }
    }

    if (state.hero?.skill?.onCombatStart) {
        state.hero.skill.onCombatStart();
    }

    // 命运轮盘效果（保留）
    if (state.hasFateWheel) {
        if (Math.random() < 0.5) {
            state.player.shield += 20;
            addLog(`🎡 命运轮盘：获得 20 点护盾！`);
            spawnDamageFloat(20, 'shield');
        } else {
            state.player.hp = Math.max(1, state.player.hp - 5);
            addLog(`🎡 命运轮盘：扣除 5 点生命...`);
            spawnDamageFloat(5, 'damage');
        }
        state.hasFateWheel = false;
    }

    render();
}


function applyCombatDebuffs() {
    // 灼烧（岩浆行者）
    if (state.burnRounds > 0) {
        const damage = 3;
        const maxHpLoss = 1;
        state.player.hp = Math.max(1, state.player.hp - damage);
        state.player.maxHp = Math.max(1, state.player.maxHp - maxHpLoss);
        if (state.player.hp > state.player.maxHp) state.player.hp = state.player.maxHp;
        addLog(`你被岩浆行者残留的灼烧所伤，生命-${damage}，生命上限-${maxHpLoss}`);
        state.burnRounds--;
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('burn'); } catch (e) { console.warn('[音效] 灼烧音效播放失败:', e); }
        }
    }
    // 魅惑（影·魅）
    if (state.charmRounds > 0) {
        state.charmRounds--;
        if (state.charmRounds === 0) {
            state.damageReduction = 0;
            addLog('魅惑效果已消失');
        }
    }
}

// ===== 敌人死亡统一处理（攻击击杀 / 环境击杀 / 荆棘反杀 共用） =====
function handleEnemyDefeat(enemy) {
    const env = state.combat && state.combat.environment ? state.combat.environment : {};
    addLog(`${enemy.name} 被击败。`);
    // 击败音效：Boss 用号角，普通敌人用胜利动机
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try {
        const sfxType = state.currentRoom?.type === 'boss' ? 'boss' : 'victory';
        AbyssAudio.sfx(sfxType);
      } catch (error) {
        console.warn('[音效] 胜利音效播放失败:', error);
      }
    }
    if (env && typeof env.onVictory === 'function') {
        env.onVictory(state.player, enemy);
    }
    clearTempCombatBonuses();   // ← 出口清理（胜利）

    // 影之皇特殊处理（仅在击败时触发）
    if (state.combat && state.combat.enemy && state.combat.enemy.isShadowKing) {
        // 1. 如果有封印备份，恢复原值
        if (state.shadowKingSealBackup) {
            const backup = state.shadowKingSealBackup;
            state.luckyLevel = backup.luckyLevel;
            state.critDamage = backup.critDamage;
            state.thornLevel = backup.thornLevel;
            state.vampireLevel = backup.vampireLevel;
            state.dodgeLevel = backup.dodgeLevel;
            state.comboLevel = backup.comboLevel;
            state.executeLevel = backup.executeLevel;
            state.shadowKingSealBackup = null;
            addLog('能力反还');
        }
        // 2. 全属性 +5%（至少+1 或 +5%）
        const applyPercent = 1.05;
        
        // 数值型属性：至少+1
        function applyMin1(value) {
            const result = Math.round(value * applyPercent);
            return value === 0 ? 1 : Math.max(result, value + 1);
        }
        // 百分比型属性：至少+5%（按等级计算，1级=5%）
        function applyMin5(value, max) {
            const result = Math.round(value * applyPercent);
            return value === 0 ? 1 : Math.min(Math.max(result, value + 1), max);
        }
        
        state.player.hp = Math.min(applyMin1(state.player.hp), state.player.maxHp * 2);
        state.player.maxHp = applyMin1(state.player.maxHp);
        state.player.attack = applyMin1(state.player.attack);
        state.player.shield = applyMin1(state.player.shield);
        state.player.gold = applyMin1(state.player.gold);
        state.player.xp = applyMin1(state.player.xp || 0);
        
        state.luckyLevel = Math.min(applyMin5(state.luckyLevel || 0, 10), 10);
        state.critDamage = Math.round((state.critDamage || 150) * applyPercent);
        if (state.critDamage === 150) state.critDamage = 155; // 保底+5
        state.thornLevel = applyMin1(state.thornLevel || 0);
        state.vampireLevel = applyMin1(state.vampireLevel || 0);
        state.dodgeLevel = Math.min(applyMin5(state.dodgeLevel || 0, 10), 10);
        state.comboLevel = Math.min(applyMin5(state.comboLevel || 0, 8), 8);
        state.executeLevel = Math.min(applyMin5(state.executeLevel || 0, 8), 8);

        state.player.hp = Math.min(state.player.hp, state.player.maxHp);
        addLog('影之皇被击败，深渊回应了你，全属性提升5%！');
    }

    // ===== 精英怪物技能（击败后触发） =====
    // 岩浆行者：灼烧
    if (enemy.isLavaWalker) {
        state.burnRounds = 3;
        addLog('击败岩浆行者，你被灼烧缠身，接下来3回合每回合损失3生命和1生命上限');
    }
    // 影（窃）：窃取金币
    if (enemy.isShadowThief && state.player.gold > 0) {
        const lost = Math.floor(state.player.gold * 0.15);
        state.player.gold -= lost;
        addLog(`你击败了影(窃)，但失去了 ${lost} 金币`);
    }
    // 影（附身）：下次受伤增加
    if (enemy.isShadowPossess) {
        state.nextDamageIncrease = 30;
        addLog('你击败了影（附身），但被其附身，下次受到的伤害增加30%');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('curse'); } catch (e) { console.warn('[音效] 诅咒音效播放失败:', e); }
        }
    }
    // 影（魅）：魅惑
    if (enemy.isShadowCharm) {
        state.charmRounds = 3;
        state.damageReduction = 10;
        addLog('你击败了影（魅），但被其魅惑，之后3回合伤害减少10%');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('curse'); } catch (e) { console.warn('[音效] 诅咒音效播放失败:', e); }
        }
    }

    // 死灵法师：影响下一个房间（移到死亡判断内部）
    if (state.combat && state.combat.enemy && state.combat.enemy.isNecromancer) {
        const nextIndex = state.roomIndex + 1;
        if (nextIndex < state.rooms.length) {
            const nextRoom = state.rooms[nextIndex];
            if (nextRoom.type !== 'enemy' && nextRoom.type !== 'elite') {
                nextRoom.type = Math.random() < 0.5 ? 'enemy' : 'elite';
            }
            addLog('下一个房间被死灵法师影响');
        }
    }

    let goldMultiplier = difficultyModifiers[state.difficulty]?.goldReward || 1;
    if (state.difficulty === 'custom') {
        goldMultiplier = normalizeCustomDifficulty(state.customDifficulty).goldReward || 1;
    }
    let goldGain = Math.max(1, Math.round((8 + state.floor) * goldMultiplier));
    if (state.hasDoubleGold) {
        goldGain = Math.round(goldGain * 1.5);
        addLog('💰 双倍金币生效！');
    }
    state.player.gold += goldGain;
    addLog(`你获得了 ${goldGain} 金币。`);
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try { AbyssAudio.sfx('coin'); } catch (e) { console.warn('[音效] 金币音效播放失败:', e); }
    }
    if (state.hero?.skill?.onVictory) {
        state.hero.skill.onVictory();
    }
    let xpGain = Math.max(1, Math.round((5 + state.floor) * (state.hasExpBoost ? 1.5 : 1)));
    state.player.xp = (state.player.xp || 0) + xpGain;
    addLog(`⭐ 你获得了 ${xpGain} 点经验。`);
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try { AbyssAudio.sfx('xp'); } catch (e) { console.warn('[音效] 经验音效播放失败:', e); }
    }
    if (state.currentRoom.type === 'boss') {
        state.endOptions = getEndOptions();
        state.rewardOptions = buildRewardOptions();
        state.mode = 'bossVictory';
        addLog('你击败了 Boss，先选择一个奖励。');
    } else {
        state.mode = 'reward';
        state.rewardOptions = buildRewardOptions();
    }
    render();
}

function attackEnemy() {
    if (state.mode !== 'combat' || !state.combat) return;
    const env = state.combat.environment || {};
    const enemy = state.combat.enemy;
    const customRuleEffects = getCustomDifficultyRuleEffects();

    // 计算基础伤害
    let damage = Math.max(1, state.player.attack
        + Math.floor(Math.random() * 3)
        + (state.player.tempAttackBonus || 0));
    damage = Math.max(1, Math.round(damage * (customRuleEffects.playerAttackMultiplier || 1)));
    // 魅惑减伤（影·魅）
    if (state.damageReduction > 0) {
        damage = Math.max(1, Math.round(damage * (1 - state.damageReduction / 100)));
        // 注：damageReduction 为整数百分比，如 10 表示减少 10%
    }
    // 应用攻击百分比修正（虚弱之雾、能量涌动等）
    if (state.environment) {
      // 检查是否有攻击百分比修正（由环境效果的 applyTurnEffects 设置）
      if (state.player.attackPercentMod !== undefined && state.player.attackPercentMod !== 1) {
        damage = Math.max(1, Math.round(damage * state.player.attackPercentMod));
      }
    }

    // 敌人闪避（基础 + 环境加成，读 enemy.dodgeBonus）
    const enemyDodge = (enemy.dodge || 0) + (enemy.dodgeBonus || 0);
    if (enemyDodge > 0 && Math.random() < enemyDodge / 100) {
        addLog(`💨 ${enemy.name} 闪避了你的攻击！`);
        spawnDamageFloat('闪避!', 'dodge');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try {
            AbyssAudio.sfx('dodge');
          } catch (error) {
            console.warn('[音效] 闪避音效播放失败:', error);
          }
        }
        enemyTurn();
        return;
    }

    let usedHeroSkillBonus = false;

    // 玩家暴击（基础 + 环境加成，读 player.luckyBonus / player.critDamageBonus）
    const luckyChance = Math.min((state.luckyLevel || 0) * 10 + (state.player.luckyBonus || 0), 100);
    if (luckyChance > 0 && Math.random() < luckyChance / 100) {
        const critMultiplier = ((state.critDamage || 150) + (state.player.critDamageBonus || 0)) / 100;
        damage = Math.round(damage * critMultiplier);
        state.critCount = (state.critCount || 0) + 1;
        addLog(`💥 暴击！造成 ${damage} 点伤害！（${(state.critDamage || 150) + (state.player.critDamageBonus || 0)}% 伤害）`);
        spawnDamageFloat('暴击!', 'crit');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try {
            AbyssAudio.sfx('crit');
          } catch (error) {
            console.warn('[音效] 暴击音效播放失败:', error);
          }
        }
    }

    // 敌人减伤：受到的攻击按百分比减免（与闪避、荆棘同源，上限 99%）
    const enemyArmor = (enemy.armor || 0) + (enemy.armorBonus || 0);
    if (enemyArmor > 0 && damage > 1) {
        const reduced = Math.max(1, Math.round(damage * (1 - enemyArmor / 100)));
        if (reduced < damage) {
            addLog(`🛡️ ${enemy.name} 的减伤抵消了 ${damage - reduced} 点伤害！`);
            damage = reduced;
        }
    }

    if (customRuleEffects.oneHitKill) {
        damage = Math.max(damage, enemy.hp + 1);
        addLog(`💥 一击必杀：本次攻击直接压至 ${damage} 点，足以击穿敌人防线。`);
    }

    if (state.pendingAttackBoost > 0) {
        damage += state.pendingAttackBoost;
        addLog(`力量药水的效果增强了本次攻击，额外造成 ${state.pendingAttackBoost} 点伤害。`);
        state.pendingAttackBoost = 0;
    }

    if (state.heroSkillBonus > 0) {
        const bonusAmount = state.heroSkillBonus;
        damage += bonusAmount;
        addLog(`英雄主动技能生效，额外造成 ${bonusAmount} 点伤害。`);
        usedHeroSkillBonus = true;
        state.heroSkillBonus = 0;
        state.heroSkillUsed = true;
    }

    if (state.hero?.skill?.onAttack) {
        damage = state.hero.skill.onAttack(damage, state.combat.turn);
    }

    if (state.heroPendingHeal > 0) {
      let healAmount = state.heroPendingHeal;
      const env = state.combat.environment;
      if (env && typeof env.onHeal === 'function') {
          healAmount = env.onHeal(healAmount);
      }
      state.player.hp = Math.min(state.player.maxHp, state.player.hp + healAmount);
      addLog(`英雄技能恢复了 ${healAmount} 点生命。`);
      state.heroPendingHeal = 0;
    }

    // 应用环境伤害修正（厄运等）
    if (state.environment && state.environment.damageModifier) {
      const mod = state.environment.damageModifier;
      damage = Math.round(damage * (1 + mod));
      if (mod !== 0) {
        addLog(`环境效果使伤害 ${mod > 0 ? '增加' : '减少'} ${Math.abs(mod * 100).toFixed(1)}%`);
      }
    }

    enemy.hp -= damage;
    addLog(`你挥出 ${damage} 点伤害。`);
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try {
        AbyssAudio.sfx('attack');
      } catch (error) {
        console.warn('[音效] 攻击音效播放失败:', error);
      }
    }

    if (enemy.isGugugaga && enemy.hp > 0) {
        state.gugugagaAttackCount = (state.gugugagaAttackCount || 0) + 1;
        if (state.gugugagaAttackCount >= 2) {
            state._pendingGugugaga = true;
            addLog('咕咕嘎嘎发力了，下一间房间将被替换为咕咕嘎嘎！');
            spawnDamageFloat('咕咕嘎嘎!', 'relic');
        }
    }

    // 敌人荆棘反弹
    const enemyThorn = enemy.thorn || 0;
    if (enemyThorn > 0 && damage > 0) {
        const thornDamage = Math.min(enemyThorn, Math.max(1, Math.round(damage * 0.3)));
        if (DEV_MODE.godMode) {
            addLog(`🛡️ 无敌模式：免疫 ${enemy.name} 的荆棘反弹 ${thornDamage} 点伤害！`);
        } else {
            state.player.hp -= thornDamage;
            state.player.hp = Math.max(0, state.player.hp);
            addLog(`🌿 ${enemy.name} 的荆棘反弹 ${thornDamage} 点伤害！`);
        }
        spawnDamageFloat(thornDamage, 'damage');
        if (state.player.hp <= 0 && state.hasTotem) {
            state.player.hp = 1;
            state.hasTotem = false;
            addLog(`🪬 不死图腾触发！你以 1 点生命存活下来！`);
            spawnDamageFloat('🪬 不死!', 'heal');
            if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
              try { AbyssAudio.sfx('revive'); } catch (e) { console.warn('[音效] 图腾音效播放失败:', e); }
            }
        }
        if (state.player.hp <= 0) {
            state.gameOver = true;
            state.mode = 'gameover';
            addLog('你在深渊中倒下了。');
            clearTempCombatBonuses();   // ← 出口清理
            updateRecords(false);
            render();
            return;
        }
    }

    // 连击判定（基础 + 环境加成，读 player.comboBonus）
    const comboChance = Math.min((state.comboLevel || 0) * 5 + (state.player.comboBonus || 0), 40);
    let isCombo = false;
    if (state.isFirstAttack && state.hasFirstAttackCombo) {
        isCombo = true;
        state.isFirstAttack = false;
        addLog(`⚡ 双刃匕首效果触发！首次攻击必定连击！`);
    } else if (comboChance > 0 && Math.random() < comboChance / 100) {
        isCombo = true;
    }
    if (isCombo) {
        let comboDamagePercent = 0.5 + (state.comboDamageBonus || 0) / 100;
        const comboDamage = Math.max(1, Math.round(damage * comboDamagePercent));
        enemy.hp -= comboDamage;
        state.comboCount = (state.comboCount || 0) + 1;
        addLog(`⚡ 连击！额外造成 ${comboDamage} 点伤害！（${Math.round(comboDamagePercent * 100)}% 伤害）`);
        spawnDamageFloat(comboDamage, 'combo');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('combo'); } catch (e) { console.warn('[音效] 连击音效播放失败:', e); }
        }
    }
    if (state.isFirstAttack) {
        state.isFirstAttack = false;
    }

    // 敌人连击反击
    const enemyCombo = enemy.combo || 0;
    if (enemyCombo > 0 && enemy.hp > 0 && Math.random() < enemyCombo / 100) {
        const comboCounterDmg = Math.max(1, Math.round(enemy.attack * 0.4));
        if (DEV_MODE.godMode) {
            addLog(`🛡️ 无敌模式：免疫 ${enemy.name} 的连击反击 ${comboCounterDmg} 点伤害！`);
        } else {
            state.player.hp -= comboCounterDmg;
            state.player.hp = Math.max(0, state.player.hp);
            addLog(`⚡ ${enemy.name} 连击反击！造成 ${comboCounterDmg} 点伤害！`);
        }
        spawnDamageFloat(comboCounterDmg, 'damage');
        if (state.player.hp <= 0 && state.hasTotem) {
            state.player.hp = 1;
            state.hasTotem = false;
            addLog(`🪬 不死图腾触发！你以 1 点生命存活下来！`);
            spawnDamageFloat('🪬 不死!', 'heal');
            if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
              try { AbyssAudio.sfx('revive'); } catch (e) { console.warn('[音效] 图腾音效播放失败:', e); }
            }
        }
        if (state.player.hp <= 0) {
            state.gameOver = true;
            state.mode = 'gameover';
            addLog('你在深渊中倒下了。');
            clearTempCombatBonuses();   // ← 出口清理
            updateRecords(false);
            render();
            return;
        }
    }

    // 斩杀判定
    const executeChance = Math.min((state.executeLevel || 0) * 5, 40);
    const threshold = state.executeThreshold || 0.3;
    const enemyHpPercent = enemy.hp / (enemy.maxHp || enemy.hp + 1);
    if (executeChance > 0 && enemy.hp > 0 && enemyHpPercent <= threshold) {
        if (Math.random() < executeChance / 100) {
            enemy.hp = 0;
            state.executeCount = (state.executeCount || 0) + 1;
            addLog(`🗡️ 斩杀触发！秒杀了 ${enemy.name}！（斩杀线 ${Math.round(threshold * 100)}%）`);
            spawnDamageFloat('💀斩杀!', 'execute');
            if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
              try { AbyssAudio.sfx('execute'); } catch (e) { console.warn('[音效] 斩杀音效播放失败:', e); }
            }
            if (state.hasKillScythe) {
                state.player.attack += 1;
                addLog(`🗡️ 斩杀之镰：攻击力 +1，当前攻击 ${state.player.attack}`);
                spawnDamageFloat(1, 'attack');
            }
        }
    }

    // 玩家吸血
    if ((state.vampireLevel || 0) > 0) {
      let heal = state.vampireLevel;
      const env = state.combat.environment;
      if (env && typeof env.onHeal === 'function') {
          heal = env.onHeal(heal);
      }
      state.player.hp = Math.min(state.player.maxHp, state.player.hp + heal);
      addLog(`🩸 吸血恢复 ${heal} 点生命。`);
      spawnDamageFloat(heal, 'heal');
    }

    if (usedHeroSkillBonus) {
        state.heroSkillBonus = 0;
        state.heroSkillUsed = true;
    }

    spawnDamageFloat(damage, 'attack');
    const btns = document.querySelectorAll('.action-button');
    btns.forEach(btn => {
        if (btn.textContent.includes('攻击')) {
            btn.classList.add('hit-flash');
            setTimeout(() => btn.classList.remove('hit-flash'), 300);
        }
    });

    // ===== 环境：玩家攻击钩子 =====
    if (env && typeof env.onPlayerAttack === 'function') {
        env.onPlayerAttack(state.player, enemy);
    }

    // 死尸·尸变（攻击触发）
    if (enemy.isDeadBody && damage > 0 && enemy.hp > 0) {
        if (Math.random() < 0.75) {
            // 扣属性（单局内）
            state.player.maxHp = Math.max(1, state.player.maxHp - 2);
            state.player.hp = Math.min(state.player.hp, state.player.maxHp);
            state.player.attack = Math.max(0, state.player.attack - 1);
            addLog('💀 尸变！生命上限 -2，攻击 -1！');
            spawnDamageFloat('💀 -2HP -1ATK', 'damage');
        } else {
            state.player.gold += 100;
            addLog('💰 这么幸运？你获得了 100 金币！');
            spawnDamageFloat('💰 +100', 'gold');
        }
    }
    // 应用跨战斗 debuff（灼烧、魅惑）
    applyCombatDebuffs();
    // ===== 检查敌人是否死亡 =====
    if (enemy.hp <= 0) {
        handleEnemyDefeat(enemy);
        return;
    }

    enemyTurn();
}

function defend() {
  if (state.mode !== 'combat' || !state.combat) return;
  state.player.shield += 3;
  const env = state.combat.environment;
  if (env && typeof env.onPlayerDefend === 'function') {
    env.onPlayerDefend(state.player);
  }
  if (state.hero?.skill?.onDefend) {
    state.hero.skill.onDefend();
  }
  addLog('你举盾防御，护盾增加。');
  if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
    try {
      AbyssAudio.sfx('block');
    } catch (error) {
      console.warn('[音效] 格挡音效播放失败:', error);
    }
  }
  
  setTimeout(() => {
    spawnDamageFloat(3, 'shield');
  }, 50);
  // 死尸·尸变（防御触发）
  if (state.combat && state.combat.enemy && state.combat.enemy.isDeadBody) {
      if (Math.random() < 0.5) {
          state.player.maxHp = Math.max(1, state.player.maxHp - 2);
          state.player.hp = Math.min(state.player.hp, state.player.maxHp);
          state.player.attack = Math.max(0, state.player.attack - 1);
          addLog('💀 尸变触发！生命上限 -2，攻击 -1！');
          spawnDamageFloat('💀 -2HP -1ATK', 'damage');
      } else {
          state.player.gold += 100;
          addLog('💰 尸变反噬：你获得了 100 金币！');
          spawnDamageFloat('💰 +100', 'gold');
      }
  }

  enemyTurn();
}

function usePotion() {
  if (state.mode !== 'combat' || !state.combat) return;
  if (state.player.potions <= 0) {
    addLog('你没有治疗药水了。');
    return;
  }
  state.player.potions -= 1;
  let healAmount = 8;
  const env = state.combat.environment;
  if (env && typeof env.onHeal === 'function') {
    healAmount = env.onHeal(healAmount);
  }
  state.player.hp = Math.min(state.player.maxHp, state.player.hp + healAmount);
  addLog(`你喝下治疗药水，恢复了 ${healAmount} 点生命。`);
  if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
    try {
      AbyssAudio.sfx('potion');
    } catch (error) {
      console.warn('[音效] 药水音效播放失败:', error);
    }
  }
  
  document.getElementById('playerHp').classList.remove('low');
  
  setTimeout(() => {
    spawnDamageFloat(healAmount, 'heal');
  }, 50);
  
  enemyTurn();
}

/**
 * 把「英雄技能」的函数接回来
 * ------------------------------------------------------------
 * state.hero 会在这些地方经过 JSON 序列化：存档、外部存档、导入文件、开发者快照、
 * 以及进入试炼时的 _backup —— 而 JSON 不保存函数。序列化之后 skill.active 这个
 * **对象还在**（所以 render 里「要不要显示技能按钮」的判断照样通过），但 execute
 * 已经变成 undefined：按钮好端端地摆在那，点了什么都不发生，日志也没有，
 * 玩家只能看到「技能用不了」。
 * 所以凡是把 state 从序列化数据里恢复回来的地方，都要调用这个函数。
 */
function restoreHeroSkillBinding(hero) {
  const h = hero || state.hero;
  if (!h || !h.id) return false;
  const src = (window.heroOptions || []).find(x => x.id === h.id);
  if (!src || !src.skill) return false;
  // 直接引用英雄表里的 skill：英雄表是常量，代码里从不就地修改它，
  // 现有各处的手写重绑也都是这么赋值的。
  h.skill = src.skill;
  return true;
}

function activateHeroSkill() {
  if (state.mode !== 'combat' || !state.combat) {
    addLog('只能在战斗中使用主动技能。');
    render();
    return;
  }
  if (!state.hero?.skill?.active) {
    addLog('当前英雄没有可用的主动技能。');
    render();
    return;
  }
  if (state.heroSkillUsed) {
    addLog('本层战斗主动技能已使用。');
    render();
    return;
  }
  // 兜底：哪条恢复路径漏了重绑，都在这里补一次
  if (typeof state.hero.skill.active.execute !== 'function') restoreHeroSkillBinding();
  if (typeof state.hero.skill.active.execute !== 'function') {
    // 以前这里没有 else，直接掉到函数末尾 —— 按钮在、点了没反应、日志也没有。
    // 宁可明说一句，也不要让玩家对着一个死按钮猜。
    addLog(`「${state.hero.skill.active.name || '主动技能'}」的技能数据丢失了（存档不保存函数），请重新选择英雄。`);
    render();
    return;
  }
  if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
    try {
      AbyssAudio.sfx('skill');
    } catch (error) {
      console.warn('[音效] 技能音效播放失败:', error);
    }
  }
  const consumeTurn = state.hero.skill.active.execute() !== false;
  state.heroSkillUsed = true;
  render();
  if (consumeTurn) {
    enemyTurn();
  }
}

function prepareStrengthPotion() {
  if (state.mode !== 'bossPrep') return;
  if (state.player.strengthPotions <= 0) {
    addLog('你没有力量药水可使用。');
    return;
  }
  if (state.pendingAttackBoost > 0) {
    addLog('力量药水已经准备，无法再次使用。');
    return;
  }
  state.player.strengthPotions -= 1;
  state.pendingAttackBoost = 3;
  addLog('你在开战前饮下了力量药水，下一回合攻击力将提升。');
  if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
    try { AbyssAudio.sfx('potion'); } catch (e) { console.warn('[音效] 药水音效播放失败:', e); }
  }
}

function enemyTurn() {
    const enemy = state.combat.enemy;
    const env = state.combat.environment || {};
    const customRuleEffects = getCustomDifficultyRuleEffects();

    // 玩家闪避（基础 + 环境加成，读 player.dodgeBonus）
    const dodgeChance = Math.min((state.dodgeLevel || 0) * 5 + (state.player.dodgeBonus || 0), 50);
    if (dodgeChance > 0 && Math.random() < dodgeChance / 100) {
        state.dodgeCount = (state.dodgeCount || 0) + 1;
        addLog(`💨 你闪避了 ${enemy.name} 的攻击！`);
        spawnDamageFloat('闪避!', 'dodge');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try {
            AbyssAudio.sfx('dodge');
          } catch (error) {
            console.warn('[音效] 闪避音效播放失败:', error);
          }
        }
        state.combat.turn += 1;
        render();
        return;
    }
    // 重置攻击百分比修正，由 applyTurnEffects 重新设置
    state.player.attackPercentMod = 1;
    if (enemy) enemy.attackPercentMod = 1;
    // 环境回合效果
    if (env && typeof env.applyTurnEffects === 'function') {
        env.applyTurnEffects(state.player, enemy);
    }
    if (env && typeof env.onEnemyTurn === 'function') {
        env.onEnemyTurn(state.player, enemy);
    }

    // ===== 环境效果可能将敌人生命降至0，立即判定死亡 =====
    if (enemy.hp <= 0) {
        addLog(`${enemy.name} 被环境之力击溃。`);
        handleEnemyDefeat(enemy);
        return;
    }

    // 基础攻击力 + 环境临时加成（虚弱之雾最低1）
    let adjustedAttack = Math.max(1, enemy.attack + (enemy.tempAttackBonus || 0));
    adjustedAttack = Math.max(1, Math.round(adjustedAttack * (customRuleEffects.enemyAttackMultiplier || 1)));

    // 应用攻击百分比修正（虚弱之雾、能量涌动等）
    if (state.environment && state.combat && state.combat.enemy) {
      if (state.combat.enemy.attackPercentMod !== undefined && state.combat.enemy.attackPercentMod !== 1) {
        adjustedAttack = Math.max(1, Math.round(adjustedAttack * state.combat.enemy.attackPercentMod));
      }
    }

    // 猎人本能减伤（首回合）
    if (enemy.firstStrikeReduction > 0 && state.combat.turn === 1) {
        adjustedAttack = Math.max(1, adjustedAttack - enemy.firstStrikeReduction);
    }

    if (customRuleEffects.oneHitKill) {
        adjustedAttack = Math.max(adjustedAttack, state.player.hp + 1);
        addLog(`💥 一击必杀：敌人以 ${adjustedAttack} 点伤害直接压制你。`);
    }

    // 敌人暴击（基础 + 环境加成，读 enemy.critBonus / enemy.critDamageBonus）
    const enemyCrit = (enemy.crit || 0) + (enemy.critBonus || 0);
    if (enemyCrit > 0 && Math.random() < enemyCrit / 100) {
        const critMultiplier = ((enemy.critDamage || 150) + (enemy.critDamageBonus || 0)) / 100;
        adjustedAttack = Math.round(adjustedAttack * critMultiplier);
        addLog(`💥 ${enemy.name} 暴击！造成 ${adjustedAttack} 点伤害！（${Math.round((enemy.critDamage || 150) + (enemy.critDamageBonus || 0))}% 伤害）`);
        spawnDamageFloat('暴击!', 'crit');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try {
            AbyssAudio.sfx('crit');
          } catch (error) {
            console.warn('[音效] 暴击音效播放失败:', error);
          }
        }
    }

    // 护盾减伤
    let remainingAttack = adjustedAttack;
    let shieldAbsorbed = 0;
    if (state.player.shield > 0) {
        shieldAbsorbed = Math.min(state.player.shield, remainingAttack);
        state.player.shield -= shieldAbsorbed;
        remainingAttack -= shieldAbsorbed;
        addLog(`🛡️ 护盾吸收了 ${shieldAbsorbed} 点伤害。`);
    }

    // 应用环境伤害修正（厄运等）
    let damage = 0;
    if (remainingAttack > 0) {
        damage = remainingAttack;
        if (state.environment && state.environment.damageModifier) {
          const mod = state.environment.damageModifier;
          damage = Math.round(damage * (1 + mod));
          if (mod !== 0) {
            addLog(`环境效果使伤害 ${mod > 0 ? '增加' : '减少'} ${Math.abs(mod * 100).toFixed(1)}%`);
          }
        }
        if (DEV_MODE.godMode) {
            // 无敌模式：免疫所有伤害
            addLog(`🛡️ 无敌模式：免疫 ${enemy.name} 的 ${damage} 点伤害！`);
        } else {
            state.player.hp -= damage;
            state.player.hp = Math.max(0, state.player.hp);
            addLog(`${enemy.name} 攻击了你，造成 ${damage} 点伤害。`);
        }
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try {
            AbyssAudio.sfx('hurt');
          } catch (error) {
            console.warn('[音效] 受伤音效播放失败:', error);
          }
        }
    } else {
        addLog(`${enemy.name} 的攻击被护盾完全抵挡！`);
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
    try {
      AbyssAudio.sfx('block');
    } catch (error) {
      console.warn('[音效] 格挡音效播放失败:', error);
    }
  }
    }

    // 敌人吸血
    if (enemy.vampire && enemy.vampire > 0 && damage > 0) {
        const healAmount = enemy.vampire;
        enemy.hp = Math.min(enemy.maxHp, enemy.hp + healAmount);
        addLog(`🩸 ${enemy.name} 吸血恢复了 ${healAmount} 点生命！`);
        spawnDamageFloat(healAmount, 'heal');
    }

    // 不死图腾判定
    if (state.player.hp <= 0 && state.hasTotem) {
        state.player.hp = 1;
        state.hasTotem = false;
        addLog(`🪬 不死图腾触发！你以 1 点生命存活下来！`);
        spawnDamageFloat('🪬 不死!', 'heal');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('revive'); } catch (e) { console.warn('[音效] 图腾音效播放失败:', e); }
        }
    }

    // 玩家荆棘反伤
    if ((state.thornLevel || 0) > 0 && remainingAttack > 0) {
        const thornDmg = state.thornLevel;
        state.combat.enemy.hp -= thornDmg;
        addLog(`🌿 荆棘反弹 ${thornDmg} 点伤害！`);
        spawnDamageFloat(thornDmg, 'thorn');
        if (state.combat.enemy.hp <= 0) {
            addLog(`${state.combat.enemy.name} 被荆棘反伤击败！`);
            handleEnemyDefeat(state.combat.enemy);
            return;
        }
    }

    // 生命护盾
    if (state.hasLifeShield) {
        state.player.shield += 2;
        addLog('🛡️ 生命护盾获得 2 点护盾。');
    }

    playScreenShake();

    if (damage > 0) {
        spawnDamageFloat(damage, 'damage');
    }
    if (shieldAbsorbed > 0 && damage === 0) {
        spawnDamageFloat(shieldAbsorbed, 'shield');
    }

    if (state.player.hp <= state.player.maxHp * 0.3) {
        document.getElementById('playerHp').classList.add('low');
    }

    // 玩家死亡判定
    if (state.player.hp <= 0) {
        state.gameOver = true;
        state.mode = 'gameover';
        addLog('你在深渊中倒下了。');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try {
            AbyssAudio.sfx('defeat');
          } catch (error) {
            console.warn('[音效] 失败音效播放失败:', error);
          }
        }
        clearTempCombatBonuses();   // ← 出口清理（死亡）
        updateRecords(false);
        document.querySelector('.app-shell').style.background = 'rgba(255,0,0,0.1)';
        setTimeout(() => document.querySelector('.app-shell').style.background = '', 500);
        render();
        return;
    }

    state.combat.turn += 1;
    render();
}

function chooseReward(index) {
  if (state.mode !== 'reward' && state.mode !== 'bossVictory') return;
  const reward = state.rewardOptions[index];
  if (!reward) return;
  reward.apply();
  addLog(`你选择了：${reward.label}`);
  if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
    try {
      AbyssAudio.sfx('reward');
    } catch (error) {
      console.warn('[音效] 奖励音效播放失败:', error);
    }
  }

  const label = reward.label;
  setTimeout(() => {
    if (label.includes('生命上限')) {
      spawnDamageFloat(4, 'heal');
    } else if (label.includes('护盾')) {
      spawnDamageFloat(3, 'shield');
    } else if (label.includes('攻击')) {
      spawnDamageFloat(1, 'attack');
    } else if (label.includes('金币')) {
      spawnDamageFloat(12, 'gold');
    } else if (label.includes('药水')) {
      spawnDamageFloat(1, 'heal');
    }
  }, 50);

  const healFromRecover = countRelic('恢复之心') * 2 + countRelic('回声之环') * 1;
  if (healFromRecover > 0) {
    state.player.hp = Math.min(state.player.maxHp, state.player.hp + healFromRecover);
    addLog(`战斗胜利触发的恢复效果，额外恢复 ${healFromRecover} 点生命。`);
  }
  if (state.mode === 'bossVictory') {
    state.rewardOptions = [];
    if (state.endOptions.length > 0) {
      render();
      return;
    }
    state.mode = 'event';
    advanceRoom();
    return;
  }
  state.rewardOptions = [];
  state.mode = 'event';
  advanceRoom();
}

function chooseEvent(index) {
  if (state.mode !== 'eventChoice') return;
  const eventOption = state.eventOptions[index];
  if (!eventOption) {
    console.warn('事件选项不存在');
    state.eventOptions = [];
    state.mode = 'event';
    advanceRoom();
    return;
  }
  
  // 安全检查：如果 apply 不存在，尝试重新绑定
  if (typeof eventOption.apply !== 'function') {
    console.warn('事件选项缺少 apply 方法，尝试重新绑定:', eventOption.label);
    const allEvents = getRandomEvent();
    const matched = allEvents.find(e => e.label === eventOption.label);
    if (matched && typeof matched.apply === 'function') {
      eventOption.apply = matched.apply;
    } else {
      // 无法修复，跳过
      addLog(`⚠️ 事件 "${eventOption.label}" 无法执行，继续前进`);
      state.eventOptions = [];
      state.mode = 'event';
      advanceRoom();
      return;
    }
  }
  
  try {
    eventOption.apply();
  } catch (err) {
    console.error(`事件 "${eventOption.label}" 执行失败:`, err);
    addLog(`⚠️ 事件 "${eventOption.label}" 执行出错，继续前进。`);
  }
  state.eventOptions = [];
  if (state.mode === 'eventChoice') {
    state.mode = 'event';
  }
}

function buildRewardOptions() {
  const custom = state && state.difficulty === 'custom' ? normalizeCustomDifficulty(state.customDifficulty) : null;
  const desiredCount = custom ? custom.rewardCount : 3;

  const pool = [
    { label: '攻击 +1', apply: () => { state.player.attack += 1; } },
    { label: '生命上限 +4', apply: () => { state.player.maxHp += 4; state.player.hp += 4; } },
    { label: '护盾 +3', apply: () => { state.player.shield += 3; } },
    { label: '治疗药水 +1', apply: () => { addPotion('heal', 1); } },
    { label: '力量药水', apply: () => { addPotion('strength', 1); } },
    { label: '金币 +12', apply: () => { state.player.gold += 12; } },
    { label: '暴击 +10%', apply: () => { addLuckyLevel(1, '战斗奖励'); }, 
      available: () => (state.luckyLevel || 0) < 10 },
    { label: '暴击伤害 +5%', apply: () => { state.critDamage = (state.critDamage || 150) + 5; addLog(`💢 暴击伤害提升至 ${state.critDamage}%`); spawnDamageFloat('+5%', 'crit'); } },
    { label: '荆棘 +1', apply: () => { state.thornLevel = (state.thornLevel || 0) + 1; addLog('荆棘+1'); } },
    { label: '吸血 +1', apply: () => { state.vampireLevel = (state.vampireLevel || 0) + 1; addLog('吸血+1'); } },
    { label: '闪避 +5%', apply: () => { addDodgeLevel(1, '战斗奖励'); },
      available: () => (state.dodgeLevel || 0) < 10 },
    { label: '连击 +5%', apply: () => { addComboLevel(1, '战斗奖励'); },
      available: () => (state.comboLevel || 0) < 8 },
    { label: '斩杀 +5%', apply: () => { addExecuteLevel(1, '战斗奖励'); },
      available: () => (state.executeLevel || 0) < 8 },
  ];
  
  const availablePool = pool.filter(item => {
    if (item.available) return item.available();
    return true;
  });
  
  const options = [];
  // 从可用池补位;若所有候选都已选中,无法凑满,直接退出(防止死循环卡死)
  while (options.length < Math.max(2, desiredCount) && availablePool.length > 0) {
    const missing = availablePool.filter(item => !options.some(o => o.label === item.label));
    if (missing.length === 0) break;
    const candidate = missing[Math.floor(Math.random() * missing.length)];
    options.push(candidate);
  }
  return options;
}

/* ============================================================
   商店商品目录（模块级唯一数据源）
   ------------------------------------------------------------
   为什么提到模块级：图鉴的「道具&商品」以前是手抄一份，结果抄出了
   「强化武器」这种**商店里根本不存在**的条目，而商店真有的「护盾药剂」图鉴里反而没有。
   现在两边共用这一份，改价、加货、下架都只有一处要动。
   ⚠️ shopLimitBonus 是**运行时**才定的（商队护送事件会给 +2），
      所以这里只存基准限购值，实际限购在 buildShopOptions 里现算。
   ============================================================ */
const SHOP_ITEMS_COMMON = [
  { label: '治疗药水', cost: 10, rarity: 'common', maxPurchase: 20, desc: '立刻获得 1 瓶治疗药水，随时按 L 回复生命。', apply: () => { addPotion('heal', 1); } },
  { label: '力量药水', cost: 18, rarity: 'common', maxPurchase: 20, desc: '立刻获得 1 瓶力量药水，下一场战斗攻击大幅提升。', apply: () => { addPotion('strength', 1); } },
  { label: '护盾药剂', cost: 12, rarity: 'common', maxPurchase: 20, desc: '获得 4 点护盾，优先抵扣伤害。', apply: () => { state.player.shield += 4; addLog('你喝下护盾药剂，获得 4 点护盾。'); } },
  { label: '锐利之刃', cost: 20, rarity: 'common', maxPurchase: 20, desc: '攻击力永久 +2。', apply: () => { state.player.attack += 2; addLog('你磨砺了武器，攻击力提高 2。'); } },
  { label: '生命宝石', cost: 22, rarity: 'common', maxPurchase: 20, desc: '生命上限 +3 并立刻回复 3 点。', apply: () => { state.player.maxHp += 3; state.player.hp += 3; addLog('生命宝石提升了你的生命上限 3 点。'); } },
];

const SHOP_ITEMS_RARE = [
  { label: '巨力药剂', cost: 25, rarity: 'rare', maxPurchase: 5, desc: '攻击 +2，并回复 5 点生命。', apply: () => { state.player.attack += 2; state.player.hp = Math.min(state.player.maxHp, state.player.hp + 5); addLog('你使用了巨力药剂，攻击提高 2 并恢复 5 点生命。'); } },
  { label: '勇者铠甲', cost: 30, rarity: 'rare', maxPurchase: 5, desc: '生命上限 +8 并立刻回复 8 点。', apply: () => { state.player.maxHp += 8; state.player.hp += 8; addLog('你装备了勇者铠甲，生命上限提高 8 点。'); } },
  { label: '灵能徽章', cost: 28, rarity: 'rare', maxPurchase: 5, desc: '攻击 +1，并获得 3 点护盾。', apply: () => { state.player.attack += 1; state.player.shield += 3; addLog('你戴上了灵能徽章，攻击提高 1 并获得 3 点护盾。'); } },
  { label: '龙鳞护盾', cost: 35, rarity: 'rare', maxPurchase: 5, desc: '获得 10 点护盾。', apply: () => { state.player.shield += 10; addLog('你举起了龙鳞护盾，获得 10 点护盾！'); } },
  { label: '暗影披风', cost: 32, rarity: 'rare', maxPurchase: 5, desc: '护盾 +5，攻击 +1。', apply: () => { state.player.shield += 5; state.player.attack += 1; addLog('你披上了暗影披风，护盾+5，攻击+1。'); } },
  { label: '生命之源', cost: 38, rarity: 'rare', maxPurchase: 5, desc: '生命上限 +10 并立刻回复 10 点。', apply: () => { state.player.maxHp += 10; state.player.hp += 10; addLog('你融合了生命之源，生命上限+10！'); } },
  { label: '治愈圣典', cost: 36, rarity: 'rare', maxPurchase: 5, desc: '生命上限 +5，并回复 12 点生命。', apply: () => { state.player.maxHp += 5; state.player.hp = Math.min(state.player.maxHp, state.player.hp + 12); addLog('你阅读了治愈圣典，生命上限+5，恢复 12 点生命。'); } },
];

function buildShopOptions() {
  if (!state.shopPurchaseCount) {
    state.shopPurchaseCount = {};
  }

  // 从模块级目录现算：expCost 与 cost 同值（内核既有规则），限购加上运行时加成
  const withBonus = (it) => Object.assign({}, it, {
    expCost: it.cost,
    maxPurchase: it.maxPurchase + (state.shopLimitBonus || 0)
  });
  const common = SHOP_ITEMS_COMMON.map(withBonus);
  const rare = SHOP_ITEMS_RARE.map(withBonus);

  const availableCommon = common.filter(item => {
    const count = state.shopPurchaseCount[item.label] || 0;
    return count < item.maxPurchase;
  });

  const availableRare = rare.filter(item => {
    const count = state.shopPurchaseCount[item.label] || 0;
    return count < item.maxPurchase;
  });

  const options = [];

  if (availableRare.length > 0) {
    const shuffledRare = [...availableRare].sort(() => Math.random() - 0.5);
    const rareCount = Math.min(2, shuffledRare.length);
    for (let i = 0; i < rareCount; i++) {
      options.push(shuffledRare[i]);
    }
  }

  if (availableCommon.length > 0) {
    const shuffledCommon = [...availableCommon].sort(() => Math.random() - 0.5);
    let commonAdded = 0;
    for (let i = 0; i < shuffledCommon.length && commonAdded < 2; i++) {
      if (!options.some(item => item.label === shuffledCommon[i].label)) {
        options.push(shuffledCommon[i]);
        commonAdded++;
      }
    }
  }

  // 补位到 4 个商品;若剩余可购商品全部已上架,无法凑满 4 个,直接退出(防止死循环卡死)
  while (options.length < 4) {
    const allAvailable = [...availableCommon, ...availableRare];
    if (allAvailable.length === 0) break;
    const missing = allAvailable.filter(item => !options.some(o => o.label === item.label));
    if (missing.length === 0) break;
    const fallback = missing[Math.floor(Math.random() * missing.length)];
    options.push(fallback);
  }

  return options.sort((a, b) => (a.rarity === 'rare' ? -1 : 1));
}

function getShopItemCost(option) {
  let modifier = difficultyModifiers[state.difficulty] || difficultyModifiers.normal;
  if (state.difficulty === 'custom') {
    modifier = { shopCost: normalizeCustomDifficulty(state.customDifficulty).shopCost };
  }
  const discount = countRelic('商人眼光') * 2;
  const cost = option.cost + (modifier.shopCost || 0) - discount;
  return Math.max(0, cost); // 最低为0（免费），但不低于0
}

function getEndOptions() {
  const options = [];
  if (state.floor >= 3) {
    options.push({
      id: 'normal',
      title: '普通结局',
      description: '在胜利后结束冒险，带着战利品离开深渊。'
    });
  }
  if (state.relics.length >= 5) {
    options.push({
      id: 'relic',
      title: '遗物结局',
      description: '凭借手中遗物封印深渊，获得特殊结局。'
    });
  }
  if (state.difficulty === 'hell' && state.floor >= 3) {
    options.push({
      id: 'hell',
      title: '地狱结局',
      description: '在地狱难度下通关 3 层后获得最高难度结局。'
    });
  }
  if (state.player.gold >= 120) {
    options.push({
      id: 'rich',
      title: '富豪结局',
      description: '积累大量财富后，你选择带走黄金与荣耀，离开深渊。'
    });
  }
  if (state.floor >= 4) {
    options.push({
      id: 'conqueror',
      title: '征服者结局',
      description: '深渊已被你征服，证明你的无上勇气。'
    });
  }
  if (state.hero?.id === 'sage' && state.relics.length >= 3) {
    options.push({
      id: 'sage',
      title: '贤者结局',
      description: '你以智慧与魔力战胜深渊，成为传说中的贤者。'
    });
  }
  if (state.hero?.id === 'guardian' && countRelic('神圣庇护') > 0) {
    options.push({
      id: 'guardian',
      title: '守护者结局',
      description: '你守护深渊，成为坚不可摧的存在。'
    });
  }
  if (state.hero?.id === 'ranger' && state.player.gold >= 80) {
    options.push({
      id: 'ranger',
      title: '游侠结局',
      description: '你带着战利品与故事离开深渊，成为传说中的游侠。'
    });
  }
  if (state.hero?.id === 'mage' && state.floor >= 3) {
    options.push({
      id: 'mage',
      title: '法师结局',
      description: '你以奥术力量征服深渊，成为传说中的法师。'
    });
  }
  if (state.hero?.id === 'berserker' && state.player.hp <= state.player.maxHp / 2) {
    options.push({
      id: 'berserker',
      title: '狂战士结局',
      description: '你在半血状态下爆发，成为无法阻挡的狂战士。'
    });
  }
  // ⚠️ 门槛从 100 层下调到 10 层：实时战斗下 100 层几乎不可能达到，
  //    这条"策略大师"实际上等于永远解锁不了（第 5 条"没有胜利感"的元凶之一）。
  //    10 层是一个中期强度玩家能摸到的目标 —— 与 getConditionEntries() 必须同步改。
  if (state.floor >= 10) {
    options.push({
      id: 'strategy_master',
      title: '策略大师',
      description: '通关第 10 层后，你成为深渊中的策略大师。'
    });
  }
  if (state.player.gold >= 150) {
    options.push({
      id: 'treasure',
      title: '宝藏结局',
      description: '你在深渊中发现无尽宝藏，选择带走一切财富。'
    });
  }
  if (countRelic('恢复之心') > 0 && countRelic('商人眼光') > 0) {
    options.push({
      id: '双生结局',
      title: '双生结局',
      description: '你不仅善战还能善于交易，成为深渊传说。'
    });
  }
  return options;
}

function getConditionEntries() {
  return [
    {
      title: '第 3 层通关',
      description: '击败第 3 层 Boss 后即可选择结束冒险。',
      progress: `当前层：第 ${state.floor} 层`,
      achieved: state.floor >= 3
    },
    {
      title: '遗物结局',
      description: '收集 5 件遗物后可选择特殊遗物结局。',
      progress: `已收集遗物：${state.relics.length} / 5`, 
      achieved: state.relics.length >= 5
    },
    {
      title: '地狱结局',
      description: '在地狱难度下通关 3 层后可达成最高难度结局。',
      progress: `当前进度：${state.difficulty === 'hell' ? `第 ${state.floor} 层` : state.difficulty}`,
      achieved: state.difficulty === 'hell' && state.floor >= 3
    },
    {
      title: '富豪结局',
      description: '累计金币达到 120 后，可选择带着财富离开深渊。',
      progress: `当前金币：${state.player.gold} / 120`,
      achieved: state.player.gold >= 120
    },
    {
      title: '征服者结局',
      description: '闯过第 4 层后，可选择成为深渊的征服者。',
      progress: `当前层：第 ${state.floor} 层`,
      achieved: state.floor >= 4
    },
    {
      title: '贤者结局',
      description: '贤者在深渊中以智慧与魔力成就传说。',
      progress: `当前英雄：${state.hero?.name || '无'}`,
      achieved: state.hero?.id === 'sage' && state.relics.length >= 3
    },
    {
      title: '守护者结局',
      description: '守护者在深渊中巩固防御，成为坚不可摧的存在。',
      progress: `当前英雄：${state.hero?.name || '无'}`,
      achieved: state.hero?.id === 'guardian' && countRelic('神圣庇护') > 0
    },
    {
      title: '游侠结局',
      description: '游侠在深渊中搜刮财富，带着传奇归来。',
      progress: `当前英雄：${state.hero?.name || '无'} · 当前金币：${state.player.gold} / 80`,
      achieved: state.hero?.id === 'ranger' && state.player.gold >= 80
    },
    {
      title: '法师结局',
      description: '法师通过奥术力量征服深渊，成为传奇。',
      progress: `当前英雄：${state.hero?.name || '无'}`,
      achieved: state.hero?.id === 'mage' && state.floor >= 3
    },
    {
      title: '狂战士结局',
      description: '在濒死边缘爆发，成为深渊中的狂战士。',
      progress: `当前英雄：${state.hero?.name || '无'} · 生命低于 50%：${state.player.hp <= state.player.maxHp / 2 ? '是' : '否'}`,
      achieved: state.hero?.id === 'berserker' && state.player.hp <= state.player.maxHp / 2
    },
    {
      title: '宝藏结局',
      description: '你带着巨额宝藏离开深渊。',
      progress: `当前金币：${state.player.gold} / 150`,
      achieved: state.player.gold >= 150
    },
    {
      title: '策略大师',
      description: '通关第 10 层后，可解锁策略大师结局。',
      progress: `当前层：第 ${state.floor} 层 / 10`,
      achieved: state.floor >= 10
    },
    {
      title: '双生结局',
      description: '同时拥有恢复之心和商人眼光时，可触发独特结局。',
      progress: `已拥有：${countRelic('恢复之心') ? '恢复之心' : ''}${countRelic('恢复之心') && countRelic('商人眼光') ? '，' : ''}${countRelic('商人眼光') ? '商人眼光' : ''}`,
      achieved: countRelic('恢复之心') > 0 && countRelic('商人眼光') > 0
    }
  ];
}
// ===== 游戏图鉴数据 =====
function getEncyclopediaData() {
  return {
    '怪物': [
      { title: '黑暗爪牙', description: '普通敌人，生命和攻击随层数增长。' },
      { title: '骷髅骑兵', description: '普通敌人，拥有高额连击、闪避和暴击率。' },
      { title: '精英守卫', description: '更强的精英敌人，击败后可获得更多奖励。' },
      { title: '死尸', description: '腐朽的尸骸，攻击时75%概率扣除玩家2点生命上限和1点攻击，25%概率给予100金币。' },
      { title: '岩浆行者', description: '精英敌人，被击败后玩家将受到3回合的灼烧，每回合损失3生命和1生命上限。' },
      { title: '影（窃）', description: '精英敌人，被击败后窃取玩家15%的金币。' },
      { title: '影（附身）', description: '精英敌人，被击败后使玩家下次受到的伤害增加30%。' },
      { title: '影（魅）', description: '精英敌人，被击败后使玩家接下来3回合伤害减少10%。' },
      { title: '死灵法师', description: '精英敌人，被击败后将下一个房间变为敌袭或精英战（50%概率各半）。' },
      { title: '层主', description: '每层 Boss，通关后可选择多个结局。' },
      { title: '影之皇', description: 'Boss，30%概率出现。进场时随机触发：下次受伤+40%/护盾归零/封印属性/无事发生。击败后全属性+5%。' },
      { title: '镜像怪', description: '镜像房间出现，攻击力为玩家的40%，血量为玩家的50%。' },
      { title: '复制法师', description: '镜像房间出现，攻击力为玩家的75%，血量为玩家的90%。' },
      { title: '咕咕嘎嘎', description: '神秘的怪物，血量40攻击3。若两次攻击后未死，则会诅咒下一间房间也变成它。' },
    ],
    '遗物': (() => {
      // 数据源 = 宿主的 24 件池（唯一实现），图鉴不再手抄 ——
      // 之前那份硬编码 17 条是旧遗物，早就和实现脱节了（还漏了 2 条条件遗物）。
      const QUAL = { common: '普通', rare: '稀有', legendary: '传说' };
      const pool = (window.经典2D && typeof window.经典2D.relicPool === 'function')
        ? window.经典2D.relicPool() : [];
      if (!pool.length) {
        // 宿主没加载（理论上不会发生）：给一句说明，而不是显示一份过期的假数据
        return [{ title: '（实时战斗未加载）', description: '遗物数据来自 经典2D.js，请在游戏内查看。' }];
      }
      return pool.map(r => ({
        // 双套遗物（2.9.2 F7）：图鉴标题两套都列，描述给"近战版"——
        // 文字模式没有"当前英雄"的概念，两套都写清楚才算说明白
        title: (r.rangedLabel ? (r.label + ' / ' + r.rangedLabel) : r.label) +
          '（' + (QUAL[r.quality] || '普通') + '）',
        description: r.rangedDesc
          ? ('近战：' + r.desc + '　｜　远程：' + r.rangedDesc)
          : r.desc
      }));
    })(),
    '道具&商品': (() => {
      // 与商店共用同一份目录（SHOP_ITEMS_COMMON / SHOP_ITEMS_RARE）——
      // 以前这里是手抄的，抄出了商店里并不存在的「强化武器」。
      const list = (typeof SHOP_ITEMS_COMMON !== 'undefined' ? SHOP_ITEMS_COMMON : [])
        .concat(typeof SHOP_ITEMS_RARE !== 'undefined' ? SHOP_ITEMS_RARE : []);
      return list.map(it => ({
        title: it.label + '（' + it.cost + ' 金币）',
        description: (it.desc || '') + (it.rarity === 'rare' ? '　· 稀有' : '')
      }));
    })(),
    '增益': [
      { title: '吸血之刃', description: '攻击时恢复 2 点生命（战斗中生效）' },
      { title: '荆棘护甲', description: '受到攻击反弹 2 点伤害（战斗中生效）' },
      { title: '生命护盾', description: '每回合获得 2 点护盾（战斗中生效）' },
      { title: '双倍金币', description: '战斗金币 +50%（战斗中生效）' },
      { title: '会心一击', description: '暴击率 +10%（战斗中生效）' },
      { title: '古神眷顾', description: '古老祭坛25%不扣血,15%双倍遗物,1%四倍遗物（特殊增益）' },
      { title: '暴击强化', description: '暴击率 +10%（战斗中生效）' },
      { title: '荆棘强化', description: '反弹伤害 +1（战斗中生效）' },
      { title: '吸血强化', description: '吸血 +1（战斗中生效）' },
      { title: '致命打击', description: '暴击伤害 +20%（战斗中生效）' }
    ],
    '英雄技能': heroOptions.map(hero => ({
      title: `${hero.name}：${hero.skill.name}`,
      description: `${hero.skill.description}` + (hero.skill.active ? ` 主动技能：${hero.skill.active.name} - ${hero.skill.active.description}` : '')
    })),
    '随机事件': [
      { title: '古老祭坛', description: '献祭 6 点生命获得一件遗物。古神眷顾可免扣血或获得双倍/四倍遗物。' },
      { title: '隐秘宝箱', description: '60% 获得 18 金币，40% 受到 4 点伤害。' },
      { title: '暗影洞穴', description: '50% 获得 1 瓶治疗药水，50% 受到 5 点伤害。' },
      { title: '古树祝福', description: '恢复 7 点生命并获得 2 点护盾。' },
      { title: '商队劫掠', description: '获得 20 金币，但损失 3 点生命。' },
      { title: '神秘商人', description: '花费 30 金币购买一件随机遗物（按稀有度权重）。' },
      { title: '诅咒之井', description: '献祭 10 点生命获得 40 金币。生命不足时改为献祭 3 点生命获得 12 金币。' },
      { title: '智慧圣殿', description: '随机获得 攻击+1 或 生命上限+3。' },
      { title: '治疗之泉', description: '恢复 8-12 点生命（随机）。' },
      { title: '幸运骰子', description: '50% 获得 20 金币，50% 损失 10 金币。' },
      { title: '附魔铁砧', description: '花费 12 金币，50% 攻击+1，50% 护盾+4。' },
      { title: '幽灵低语', description: '随机获得：暴击率+5%、吸血+1 或 荆棘+1。暴击率满时自动排除该选项。' },
      { title: '暗影交易', description: '支付 20 点生命换取 5 件随机遗物（出现概率极低）。' },
      { title: '许愿池', description: '花费 20 金币，随机获得一项属性提升（含随机遗物）。' },
      { title: '知识祭坛', description: '献祭 20 点经验获得一件遗物。古神眷顾可免消耗或获得双倍/四倍遗物。' },
      { title: '战斗导师', description: '消耗经验提升属性：消耗15经验，45%概率获得攻击+1，45%概率获得生命上限+3，10%概率两者都获得' },
      { title: '恶魔低语', description: '50% 金币-10、生命-8；50% 金币+10、生命上限+8。' },
      { title: '破败祭坛', description: '50% 攻击-1；50% 获得一件随机遗物。' },
    ],
    '诅咒': (() => {
      // 数据源与玩法一致：诅咒只在「深渊裂隙」里主动换取，分轻 / 重两档（规划 §3.5）。
      // 不再读试炼的 TRIAL_CURSES —— 那套「每回合」的描述在实时里已经不成立了。
      const light = ['脆弱', '护甲腐蚀', '药水衰减', '迟钝'];
      const heavy = ['荆棘诅咒', '易伤', '生命流失', '虚弱', '吸血反噬', '贪婪'];
      const desc = {
        '脆弱': '每 5 秒失去 2 点护盾',
        '护甲腐蚀': '每 5 秒失去 1 点护盾',
        '药水衰减': '所有治疗效果减半（药水 / 祭坛 / 技能）',
        '迟钝': '每 5 秒闪避 −5%（最低 0）；清空房间后恢复',
        '荆棘诅咒': '每次被命中额外承受 1 点伤害',
        '易伤': '每次被命中额外承受 2 点伤害',
        '生命流失': '每 5 秒失去 1 点生命（无视护盾）',
        '虚弱': '每 5 秒攻击 −1（最低 1）；清空房间后恢复',
        '吸血反噬': '每次命中敌人后自身失去 1 点生命（无视护盾）',
        '贪婪': '击杀与开箱获得的金币减半'
      };
      return light.map(n => ({ title: '轻 · ' + n, description: desc[n] || '' }))
        .concat(heavy.map(n => ({ title: '重 · ' + n, description: desc[n] || '' })));
    })(),
    '地形与机制': (() => {
      // 与引擎运行时常量同源：2.9 的骨架 / 机制 / 魂晶 / 怪物节奏说明由
      // 战斗2D.getCodexData() 现拼，主程序不再手抄一份（改数值图鉴会跟着变）。
      if (!(window.战斗2D && typeof window.战斗2D.getCodexData === 'function')) {
        return [{
          title: '（进入战斗后可用）',
          description: '2.9 的地形骨架、机制房、魂晶与怪物节奏说明由 战斗2D.js 的运行时常量生成；进入一局后即可在「地形与机制」里查看。'
        }];
      }
      try {
        const data = window.战斗2D.getCodexData();
        return (data && data.entries ? data.entries : []).map(e => ({
          title: e.title, description: e.description
        }));
      } catch (err) {
        console.warn('[图鉴] 读取 2.9 地形与机制数据失败：', err);
        return [];
      }
    })(),
    '实时战斗技巧': [
      { title: '菜单与快捷键', description: 'HUD 的「菜单」按钮或 Esc 键打开本局中枢：左边是本局状态（生命 / 护盾 / 体力 / 金币 / 遗物 / 诅咒明细），右边是通关条件 / 图鉴 / 教程 / 设置 / 存档管理 / 作弊 / 切换老版 2.6 与难度切换，底部是继续战斗 / 结束本局。再按一次 Esc 收起。' },
      { title: '完美闪避', description: '敌人攻击命中的瞬间闪避 → 体力全额返还、震开周围敌人，并进入「锐利」状态（伤害 ×2.2）。' },
      { title: '完美格挡', description: '举盾成型后的短窗口内挡下攻击 → 完全免伤并反弹，同时获得护盾与盾反窗口。' },
      { title: '盾反', description: '完美格挡后的窗口内出手 → 伤害翻倍的前冲反击。' },
      { title: '跳劈', description: '滞空时挥砍 → 高速下坠斩；命中与落地都会造成范围冲击，还有概率把敌人砸进地里。' },
      { title: '狂怒', description: '挨打、连招、完美操作与击杀都会攒怒；满槽后爆发：伤害 ×1.5、移速与攻速提升，代价是受伤 +15%。' },
      { title: '连携（技巧资源）', description: '完美闪避 / 完美格挡各攒 1 点，显示在主角头顶的菱形点上（上限 3）。点数会被下一次主动攻击吃掉：伤害 ×1.6，跳劈还会连带放大落地冲击波。真掉血就全部清零 —— 所以「先攒着」本身就是一个赌注。' },
      { title: '机制型敌人', description: '三种怪各针对一种省事的打法：铁壁兵正面免疫（跳劈或绕后才行）、织网者吐网减速（闪避可撕开）、献祭者给同伴套血盾（得先点掉它，中盾的怪身上有青色环）。' },
      { title: '遗物流派', description: '遗物分血怒 / 完美 / 连携 / 贪婪四派，效果都挂在能主动去创造的状态上（残血、连携、完美判定），同派之间互相放大 —— 三选一卡片上的标签就是流派名，照着凑就是一套构筑。' },
      { title: '腐化脉冲', description: '所有「每回合」类诅咒与环境效果按固定节拍结算（默认 5 秒，越深入越快）。HUD 会显示当前节拍。' },
      { title: '深渊裂隙', description: '每层打完层主后出现：以诅咒为代价换取遗物与金币。可在商店买「净化」、或在祭坛献祭生命来解除。' },
      { title: '遗物', description: '挂在引擎既有机制上的永久强化（完美窗口 / 盾反倍率 / 连招窗口 / 跳劈倍率 / 体力 / 狂怒获取…）。精英与层主必掉。' },
    ],
    '环境效果': (() => {
      if (typeof ENVIRONMENT_EFFECTS === 'undefined') return [];
      return ENVIRONMENT_EFFECTS.map(e => ({
        title: e.name,
        description: e.description.replace(/\{[^}]+\}/g, '随楼层与难度变化')
      }));
    })(),
    '自定义难度': (() => {
      const labels = {
          customDifficultyEnabled: '启用自定义规则（总开关）',
          customEnemyHp: '敌人生命倍率', customEnemyAtk: '敌人攻击倍率',
          customGoldReward: '金币获取', customShopCost: '商店价格',
          customRestBonus: '休息恢复', customEnemyExtra: '敌人属性强度',
          customEnvironmentScale: '环境强度', customTrialRounds: '试炼回合上限',
          customRewardCount: '奖励选项数',
          customGlassCannon: '规则：玻璃大炮', customOneHitKill: '规则：一击必杀',
          customEscalatingPressure: '规则：递增压迫', customCurseLevel: '规则：诅咒层级',
          customRoomCount: '规则：每层房间数', customFloorCap: '规则：楼层上限',
          customEnemyThornInject: '规则：荆棘注入', customEnemyDodgeInject: '规则：闪避注入',
          customEnemyVampireInject: '规则：吸血注入', customEnemyComboInject: '规则：连击注入',
          customEnemyCritInject: '规则：暴击注入',
          customGugugagaChance: '规则：咕咕嘎嘎概率', customDeadBodyChance: '规则：死尸概率',
          customEliteChance: '规则：精英化概率', customEnemyGrowthCurve: '规则：敌人成长曲线',
          customCommonWeight: '规则：普通权重', customRareWeight: '规则：稀有权重',
          customLegendaryWeight: '规则：传说权重', customRelicBlacklist: '规则：遗物黑名单',
          customEnvironmentPreset: '规则：固定环境'
      };
      return Object.entries(CUSTOM_DIFFICULTY_HELP).map(([id, text]) => ({
          title: labels[id] || id,
          description: text.replace(/^【[^】]+】/, '')
      }));
    })(),
  };
}
// 获取遗物选项
function getRelicOptions(ignoreBlacklist = false) {
  // ⚠️ 这里原来调 loadTrialUnlocks() —— 试炼关停（P5）时那个函数已被删除，
  //    但调用点漏了，于是**任何抽取遗物的路径都会抛 ReferenceError**：
  //    选增益「遗物侥幸」、精英/Boss 房掉遗物，玩家看到的是"点了没反应"。
  //    试炼专属的两件遗物（试炼之刃 / 深渊之心）按规划 §3.4 在新版一并移除，
  //    所以正确的修法是**删掉这段解锁依赖**，而不是把函数补回来。
  const customBlacklist = getCustomRelicBlacklist();
  // 基础遗物列表
  const baseRelics = [
    { label: '战斗怒火', description: '每次攻击造成额外 1 点伤害。', rarity: 'common', apply: () => { state.player.attack += 1; } },
    { label: '恢复之心', description: '战斗胜利后恢复 2 点生命（可叠加）。', rarity: 'common', apply: () => { /* effect handled separately */ } },
    { label: '商人眼光', description: '商店商品价格降低 2 金币（可叠加）。', rarity: 'rare', apply: () => { /* effect handled separately */ } },
    { label: '猎人本能', description: '敌人首回合伤害降低 1 点（可叠加）。', rarity: 'rare', apply: () => { /* effect handled separately */ } },
    { label: '神圣庇护', description: '每次休整回复额外 2 点生命（可叠加）。', rarity: 'rare', apply: () => { /* effect handled separately */ } },
    { label: '幸运硬币', description: '获得时立刻获得 10 金币。', rarity: 'common', apply: () => { state.player.gold += 10; addLog('幸运硬币给予了你 10 金币。'); } },
    { label: '坚固护符', description: '获得时立刻获得 3 点护盾。', rarity: 'common', apply: () => { state.player.shield += 3; addLog('坚固护符为你提供了 3 点护盾。'); } },
    { label: '生命结晶', description: '获得时永久增加 6 点生命上限并恢复 6 点生命。', rarity: 'rare', apply: () => { state.player.maxHp += 6; state.player.hp = Math.min(state.player.maxHp, state.player.hp + 6); addLog('生命结晶提升了你的生命上限并恢复生命。'); } },
    { label: '铁卫纹章', description: '获得时永久增加 1 点攻击。', rarity: 'rare', apply: () => { state.player.attack += 1; addLog('铁卫纹章使你的攻击力提升。'); } },
    { label: '回声之环', description: '每次战斗胜利后额外恢复 1 点生命（可叠加）。', rarity: 'rare', apply: () => { /* effect handled separately */ } },
    { label: '狂战之心',description: '连击率 +5%，连击伤害 +10%（可叠加）。',rarity: 'rare',apply: () => { if ((state.comboLevel || 0) >= 8) {addLog('连击率已达上限40%，狂战之心无法生效。');return;}addComboLevel(1, '遗物：狂战之心');state.comboDamageBonus = (state.comboDamageBonus || 0) + 10;addLog(`狂战之心：连击伤害 +10%，当前连击伤害 ${(50 + (state.comboDamageBonus || 0))}%`);}},
    { label: '双刃匕首', description: '连击率 +5%，首次攻击必定连击（可叠加）。', rarity: 'rare', apply: () => { addComboLevel(1, '遗物：双刃匕首');state.hasFirstAttackCombo = true;addLog(`双刃匕首：首次攻击必定连击！`);} },
    { label: '猎杀标记', description: '斩杀线提升至 50%（不可叠加，出现概率低）。', rarity: 'legendary', apply: () => { state.executeThreshold = 0.5;addLog(`猎杀标记：斩杀线提升至 50%！`);} },
    { label: '完美之刃', description: '闪避 +10%，连击 +10%，斩杀 +10%（出现概率低）。',rarity: 'legendary', apply: () => { let anyApplied = false;if ((state.dodgeLevel || 0) < 10) {addDodgeLevel(2, '遗物：完美之刃');anyApplied = true;} else {addLog('闪避率已达上限50%');}if ((state.comboLevel || 0) < 8) {addComboLevel(2, '遗物：完美之刃');anyApplied = true;} else {addLog('连击率已达上限40%');}if ((state.executeLevel || 0) < 8) {const currentExecuteLevel = state.executeLevel || 0;const newLevel = Math.min(currentExecuteLevel + 2, 8);const added = newLevel - currentExecuteLevel;state.executeLevel = newLevel;addLog(`斩杀率提升 ${(added * 5).toFixed(0)}%，当前 ${(state.executeLevel * 5).toFixed(0)}%`);} else {addLog('斩杀率已达上限40%');}if (anyApplied) {addLog(`完美之刃：属性全面提升！`);} else {addLog('完美之刃：所有属性均已达到上限，遗物无效。');}}},
    { label: '不死图腾', description: '致命伤害保留 1 血（触发后消失，需重新获取，出现概率低）。',rarity: 'legendary',apply: () => { state.hasTotem = true; addLog(`不死图腾：你获得了一次免死机会！`);} },
    { label: '斩杀之镰', description: '斩杀成功后，本场战斗攻击 +1（可叠加）。', rarity: 'rare', apply: () => { state.hasKillScythe = true;addLog(`斩杀之镰：斩杀成功后攻击 +1！`);} },
    { label: '命运轮盘', description: '战斗开始时 50% 获得 20 护盾，50% 扣除 5 生命（出现概率低）。',  rarity: 'legendary', apply: () => { state.hasFateWheel = true;addLog(`命运轮盘已装备！`);}},
  ];

  // （试炼永久解锁在 P5 已随试炼关停整体移除：原来的
  //   `if (unlocks.unlockedRelics.includes('trial_blade'))` 与 `'abyss_heart'`
  //   两个分支连带删除 —— 它们依赖的 loadTrialUnlocks 已不存在，
  //   而这两件遗物本身就是"试炼专属"，新版不再产出。）

  if (!ignoreBlacklist && customBlacklist.length && isCustomDifficultyEnabled()) {
    return baseRelics.filter(relic => {
      const label = String(relic.label || '').toLowerCase();
      return !customBlacklist.some(name => label.includes(String(name).toLowerCase()));
    });
  }
  return baseRelics;
}

function chooseRelic(index, advance = true) {
  const relic = getRelicOptions()[index];
  if (!relic) return;
  state.relics.push(relic);
  addLog(`你获得了遗物：${relic.label}`);
  relic.apply();

  setTimeout(() => {
    const label = relic.label;
    if (label === '生命结晶' || label === '勇者铠甲') {
      spawnDamageFloat(6, 'heal');
    } else if (label === '坚固护符' || label === '灵能徽章') {
      spawnDamageFloat(3, 'shield');
    } else if (label === '战斗怒火' || label === '铁卫纹章') {
      spawnDamageFloat(1, 'attack');
    } else if (label === '幸运硬币') {
      spawnDamageFloat(10, 'gold');
    } else {
      spawnDamageFloat('✨', 'relic');
    }
  }, 50);

  if (advance) {
    advanceRoom();
  }
}

// ===== 按稀有度权重随机抽取遗物 =====
function getRandomRelicByRarity() {
  const relics = getRelicOptions();
  const custom = state && state.difficulty === 'custom' && isCustomDifficultyEnabled()
    ? normalizeCustomDifficulty(state.customDifficulty)
    : null;

  // 稀有度权重配置
  const weights = {
    'common': custom ? (custom.commonWeight || 10) : 10,
    'rare': custom ? (custom.rareWeight || 5) : 5,
    'legendary': custom ? (custom.legendaryWeight || 1) : 1
  };

  const blacklist = custom ? getCustomRelicBlacklist() : [];
  const available = relics.filter(relic => {
    if (!blacklist.length) return true;
    const label = String(relic.label || '').toLowerCase();
    return !blacklist.some(name => label.includes(String(name).toLowerCase()));
  });

  const pool = available.length > 0 ? available : relics;
  if (pool.length === 0) {
    // 遗物池为空（如自定义难度黑名单清空）：兜底返回基础遗物列表，避免返回 undefined
    return getRelicOptions(false)[0] || { label: '未知遗物', rarity: 'common', apply: () => {} };
  }
  let totalWeight = 0;
  pool.forEach(r => {
    totalWeight += weights[r.rarity] || 5;
  });

  let random = Math.random() * totalWeight;
  for (const relic of pool) {
    const w = weights[relic.rarity] || 5;
    random -= w;
    if (random <= 0) {
      return relic;
    }
  }
  return pool[pool.length - 1];
}

// 按稀有度权重选择遗物（替代原来的随机选择）
function chooseRelicByRarity(advance = true) {
  const relic = getRandomRelicByRarity();
  if (!relic) return;

  state.relics.push(relic);
  addLog(`你获得了遗物：${relic.label}`);
  relic.apply();
  
  setTimeout(() => {
    const label = relic.label;
    if (label === '生命结晶' || label === '勇者铠甲') {
      spawnDamageFloat(6, 'heal');
    } else if (label === '坚固护符' || label === '灵能徽章') {
      spawnDamageFloat(3, 'shield');
    } else if (label === '战斗怒火' || label === '铁卫纹章') {
      spawnDamageFloat(1, 'attack');
    } else if (label === '幸运硬币') {
      spawnDamageFloat(10, 'gold');
    } else {
      spawnDamageFloat('✨', 'relic');
    }
  }, 50);
  
  if (advance) {
    advanceRoom();
  }
}

// 获取开局增益选项
// 开局增益全量池（模块级：图鉴要用全量，而 getBonusChoices 只随机抽 3 个）
const BONUS_POOL = [
    { id: 'start_shield', title: '初始护盾', description: '开局获得 5 点额外护盾', apply: () => { state.player.shield += 5; } },
    { id: 'start_hp', title: '生命强化', description: '开局生命上限 +5', apply: () => { state.player.maxHp += 5; state.player.hp += 5; } },
    { id: 'start_attack', title: '攻击强化', description: '开局攻击 +2', apply: () => { state.player.attack += 2; } },
    { id: 'start_potion', title: '药水优势', description: '开局获得 1 瓶额外治疗药水', apply: () => { addPotion('heal', 1); } },
    { id: 'start_gold', title: '财富起点', description: '开局获得 15 金币', apply: () => { state.player.gold += 15; } },
    { id: 'start_relic', title: '遗物预感', description: '开局获得一件随机遗物', apply: () => { chooseRelicByRarity(false); } },
    { id: 'start_potions2', title: '药剂充足', description: '开局获得 2 瓶额外治疗药水', apply: () => { addPotion('heal', 2); } },
    { id: 'start_luck', title: '幸运开端', description: '开局获得 20 金币', apply: () => { state.player.gold += 20; } },
    { id: 'start_toughness', title: '铁血体质', description: '开局生命上限 +8', apply: () => { state.player.maxHp += 8; state.player.hp += 8; } },
    { id: 'start_relic2', title: '遗物侥幸', description: '开局获得两件随机遗物', apply: () => { chooseRelicByRarity(false); chooseRelicByRarity(false); } },
    { id: 'start_shield2', title: '坚韧护盾', description: '开局获得 8 点护盾', apply: () => { state.player.shield += 8; } },
    { id: 'start_heal', title: '活力冲刺', description: '开局恢复 10 点生命', apply: () => { state.player.hp = Math.min(state.player.maxHp, state.player.hp + 10); } },
    { id: 'start_power', title: '战斗冲锋', description: '开局攻击 +3', apply: () => { state.player.attack += 3; } },
    { id: 'start_explorer', title: '探索者', description: '开局获得 10 金币和 1 瓶治疗药水', apply: () => { state.player.gold += 10; addPotion('heal', 1); } },
    { id: 'start_fortify', title: '防御强化', description: '开局获得 3 点额外护盾和 2 点攻击', apply: () => { state.player.shield += 3; state.player.attack += 2; } },
    { id: 'start_vigor', title: '生命活力', description: '开局生命上限 +6 并恢复 6 点生命', apply: () => { state.player.maxHp += 6; state.player.hp += 6; } },
    { id: 'crit_damage', title: '致命打击', description: '暴击伤害 +20%', apply: () => { state.critDamage = (state.critDamage || 150) + 20; addLog(`💢 暴击伤害提升至 ${state.critDamage}%`); spawnDamageFloat('+20%', 'crit'); } },
    { id: 'vampire', title: '吸血之刃', description: '攻击时恢复 2 点生命', apply: () => { state.vampireLevel = (state.vampireLevel || 0) + 1; addLog('获得吸血之刃，攻击恢复2点生命'); spawnDamageFloat(2, 'vampire'); } },
    { id: 'thorn', title: '荆棘护甲', description: '受到攻击反弹 2 点伤害', apply: () => { state.thornLevel = (state.thornLevel || 0) + 1; addLog('获得荆棘护甲，反弹2点伤害'); spawnDamageFloat(2, 'thorn'); } },
    { id: 'life_shield', title: '生命护盾', description: '每回合获得 2 点护盾', apply: () => { state.hasLifeShield = true; addLog('获得生命护盾，每回合+2护盾'); } },
    { id: 'double_gold', title: '双倍金币', description: '战斗金币 +50%', apply: () => { state.hasDoubleGold = true; addLog('获得双倍金币'); } },
    { id: 'exp_boost', title: '经验加成', description: '获得额外经验', apply: () => { state.hasExpBoost = true; addLog('获得经验加成'); } },
    { id: 'lucky', title: '会心一击', description: '暴击率 +10%', apply: () => { addLuckyLevel(1, '开局增益'); } },
    { id: 'ancient_bless', title: '古神眷顾', description: '古老祭坛25%不扣血,15%双倍遗物,1%四倍遗物', apply: () => { state.hasAncientBless = true; addLog('获得古神眷顾'); } },
    { id: 'lucky2', title: '暴击强化', description: '暴击率 +10%', apply: () => { addLuckyLevel(1, '开局增益'); } },
    { id: 'thorn2', title: '荆棘强化', description: '反弹伤害 +1', apply: () => { state.thornLevel = (state.thornLevel || 0) + 1; addLog('反弹伤害+1'); spawnDamageFloat(1, 'thorn'); } },
    { id: 'vampire2', title: '吸血强化', description: '吸血 +1', apply: () => { state.vampireLevel = (state.vampireLevel || 0) + 1; addLog('吸血+1'); spawnDamageFloat(1, 'vampire'); } },
    { id: 'dodge', title: '闪避之舞', description: '闪避率 +5%', apply: () => { addDodgeLevel(1, '开局增益'); } },
    { id: 'combo', title: '连击之刃', description: '连击率 +5%', apply: () => { addComboLevel(1, '开局增益'); } },
    { id: 'execute', title: '斩杀之心', description: '斩杀率 +5%', apply: () => { addExecuteLevel(1, '开局增益'); } },
];

function getBonusChoices() {
  // ⚠️ 必须 copy 再打乱：BONUS_POOL 现在是模块级常量，原地 sort 会把它永久打乱
  //    （图鉴按这个池子列条目，顺序会跟着乱跳）。
  const allBonuses = BONUS_POOL.slice();
  const shuffled = allBonuses.sort(() => Math.random() - 0.5);

  // ==== 暴露全量列表供测试使用 ====
  window.__ALL_BONUSES = allBonuses;

  return shuffled.slice(0, 3);
}
// ===== 完整随机事件列表 =====
const ALL_EVENT_OPTIONS = [
  {
    label: '古老祭坛',
    description: '向祭坛献上一部分生命，获得一件遗物。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('sacrifice'); } catch (e) { console.warn('[音效] 献祭音效播放失败:', e); }
      }
      let shouldPayHp = true;
      let relicCount = 1;
      
      if (state.hasAncientBless && Math.random() < 0.25) {
        shouldPayHp = false;
        addLog('🙏 古神眷顾触发！这次献祭不扣血！');
      }
      
      if (shouldPayHp) {
        const hpCost = 6;
        state.player.hp = Math.max(1, state.player.hp - hpCost);
        addLog(`献祭 ${hpCost} 点生命`);
        spawnDamageFloat(hpCost, 'damage');
        playScreenShake();
        if (state.player.hp <= state.player.maxHp * 0.3) {
          document.getElementById('playerHp').classList.add('low');
        }
      }
      
      if (state.hasAncientBless) {
        if (Math.random() < 0.01) {
          relicCount = 4;
          addLog('🌟 古神大显灵！获得四倍遗物！！');
        } else if (Math.random() < 0.15) {
          relicCount = 2;
          addLog('✨ 古神眷顾触发！获得双倍遗物！');
        }
      }
      
      for (let i = 0; i < relicCount; i++) {
        chooseRelicByRarity();
      }
    }
  },
  {
    label: '隐秘宝箱',
    description: '打开宝箱，获得金币或受伤。',
    apply: () => {
      if (Math.random() < 0.6) {
        const gold = 18;
        state.player.gold += gold;
        addLog(`你找到了 ${gold} 金币。`);
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('chest'); } catch (e) { console.warn('[音效] 宝箱音效播放失败:', e); }
        }
      } else {
        state.player.hp = Math.max(1, state.player.hp - 4);
        addLog('你触发了陷阱，受到了 4 点伤害。');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('trap'); } catch (e) { console.warn('[音效] 陷阱音效播放失败:', e); }
        }
      }
      advanceRoom();
    }
  },
  {
    label: '暗影洞穴',
    description: '深入洞穴后，你要么找到珍贵补给，要么被毒烟侵蚀。',
    apply: () => {
      if (Math.random() < 0.5) {
        addPotion('heal', 1);
        addLog('你在洞穴深处找到了珍贵的治疗药水！');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('potion'); } catch (e) { console.warn('[音效] 药水音效播放失败:', e); }
        }
      } else {
        state.player.hp = Math.max(1, state.player.hp - 5);
        addLog('你吸入了毒烟，受到了 5 点伤害。');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('poison'); } catch (e) { console.warn('[音效] 毒烟音效播放失败:', e); }
        }
      }
      advanceRoom();
    }
  },
  {
    label: '古树祝福',
    description: '古树的力量恢复你部分生命，并赐予你短暂的守护。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('buff'); } catch (e) { console.warn('[音效] 祝福音效播放失败:', e); }
      }
      const heal = 7;
      state.player.hp = Math.min(state.player.maxHp, state.player.hp + heal);
      state.player.shield += 2;
      addLog(`古树祝福你，恢复 ${heal} 点生命并获得 2 点护盾。`);
      spawnDamageFloat(heal, 'heal');
      spawnDamageFloat(2, 'shield');
      advanceRoom();
    }
  },
  {
    label: '商队劫掠',
    description: '你截获一支商队，获得金币但消耗体力。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('attack'); } catch (e) { console.warn('[音效] 劫掠音效播放失败:', e); }
      }
      const gain = 20;
      state.player.gold += gain;
      state.player.hp = Math.max(1, state.player.hp - 3);
      addLog(`你抢到了 ${gain} 金币，但损失 3 点生命。`);
      spawnDamageFloat(gain, 'gold');
      spawnDamageFloat(3, 'damage');
      advanceRoom();
    }
  },
  {
    label: '神秘商人',
    description: '用 30 金币购买一件随机遗物。',
    apply: () => {
      if (state.player.gold >= 30) {
        state.player.gold -= 30;
        addLog('支付 30 金币，获得一件遗物。');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('buy'); } catch (e) { console.warn('[音效] 购买音效播放失败:', e); }
        }
        chooseRelicByRarity();
      } else {
        addLog('金币不足，神秘商人消失了。');
        advanceRoom();
      }
    }
  },
  {
    label: '诅咒之井',
    description: '献祭 10 点生命，获得 40 金币。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('sacrifice'); } catch (e) { console.warn('[音效] 献祭音效播放失败:', e); }
      }
      if (state.player.hp > 10) {
        state.player.hp -= 10;
        state.player.gold += 40;
        addLog('献祭 10 点生命，获得 40 金币。');
        spawnDamageFloat(10, 'damage');
        spawnDamageFloat(40, 'gold');
        playScreenShake();
      } else {
        state.player.hp = Math.max(1, state.player.hp - 3);
        state.player.gold += 12;
        addLog('生命不足，勉强献祭 3 点生命，获得 12 金币。');
        spawnDamageFloat(3, 'damage');
        spawnDamageFloat(12, 'gold');
      }
      if (state.player.hp <= state.player.maxHp * 0.3) {
        document.getElementById('playerHp').classList.add('low');
      }
      advanceRoom();
    }
  },
  {
    label: '智慧圣殿',
    description: '随机获得 攻击+1 或 生命上限+3。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('buff'); } catch (e) { console.warn('[音效] 圣殿音效播放失败:', e); }
      }
      if (Math.random() < 0.5) {
        state.player.attack += 1;
        addLog('智慧圣殿赐予你力量，攻击+1！');
        spawnDamageFloat(1, 'attack');
      } else {
        state.player.maxHp += 3;
        state.player.hp += 3;
        addLog('智慧圣殿赐予你生命，生命上限+3！');
        spawnDamageFloat(3, 'heal');
      }
      advanceRoom();
    }
  },
  {
    label: '治疗之泉',
    description: '恢复 8-12 点生命。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('splash'); } catch (e) { console.warn('[音效] 泉水音效播放失败:', e); }
      }
      const heal = 8 + Math.floor(Math.random() * 5);
      state.player.hp = Math.min(state.player.maxHp, state.player.hp + heal);
      addLog(`治疗之泉恢复了 ${heal} 点生命。`);
      spawnDamageFloat(heal, 'heal');
      advanceRoom();
    }
  },
  {
    label: '幸运骰子',
    description: '掷骰子：50% 获得 20 金币，50% 损失 10 金币。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('dice'); } catch (e) { console.warn('[音效] 骰子音效播放失败:', e); }
      }
      if (Math.random() < 0.5) {
        state.player.gold += 20;
        addLog('🎲 骰子点数大！获得 20 金币！');
        spawnDamageFloat(20, 'gold');
      } else {
        if (state.player.gold > 0) {
          const lost = Math.min(10, state.player.gold);
          state.player.gold -= lost;
          addLog(`🎲 骰子点数小...损失 ${lost} 金币。`);
          spawnDamageFloat(lost, 'goldLose');
        } else {
          addLog('🎲 骰子点数小...但你已经没有金币可输了。');
        }
      }
      advanceRoom();
    }
  },
  {
    label: '附魔铁砧',
    description: '支付 12 金币，随机提升攻击或护盾。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('anvil'); } catch (e) { console.warn('[音效] 铁砧音效播放失败:', e); }
      }
      if (state.player.gold >= 12) {
        state.player.gold -= 12;
        if (Math.random() < 0.5) {
          state.player.attack += 1;
          addLog('铁砧强化了武器，攻击+1！');
          spawnDamageFloat(1, 'attack');
        } else {
          state.player.shield += 4;
          addLog('铁砧强化了护甲，护盾+4！');
          spawnDamageFloat(4, 'shield');
        }
      } else {
        addLog('金币不足，铁砧碎了...');
      }
      advanceRoom();
    }
  },
  {
    label: '幽灵低语',
    description: '获得一个随机增益效果（暴击率+5% 或 吸血+1 或 荆棘+1）。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('whisper'); } catch (e) { console.warn('[音效] 低语音效播放失败:', e); }
      }
      const availableEffects = [];
      
      const currentChance = (state.luckyLevel || 0) * 10;
      if (currentChance < 100) {
        availableEffects.push(() => { 
          addLuckyLevel(0.5, '幽灵低语'); 
          spawnDamageFloat('+5%', 'lucky');
        });
      }
      
      availableEffects.push(() => { 
        state.vampireLevel = (state.vampireLevel || 0) + 1; 
        addLog('🩸 幽灵低语赐予你吸血+1！'); 
        spawnDamageFloat(1, 'vampire')
      });
      availableEffects.push(() => { 
        state.thornLevel = (state.thornLevel || 0) + 1; 
        addLog('🌿 幽灵低语赐予你荆棘+1！'); 
        spawnDamageFloat(1, 'thorn')
      });
      
      if (availableEffects.length > 0) {
        const effect = availableEffects[Math.floor(Math.random() * availableEffects.length)];
        effect();
      } else {
        addLog('幽灵低语在你耳边呢喃...但什么也没发生。');
      }
      advanceRoom();
    }
  },
  {
    label: '暗影交易',
    description: '用 20 生命换取 5 件随机遗物（出现概率极低）。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('whisper'); } catch (e) { console.warn('[音效] 暗影音效播放失败:', e); }
      }
      if (state.player.hp > 20) {
        state.player.hp -= 20;
        addLog(`你支付了 20 点生命进行暗影交易...`);
        spawnDamageFloat(20, 'damage');
        for (let i = 0; i < 5; i++) {
          const relic = getRandomRelicByRarity();
          if (!relic || typeof relic.apply !== 'function') continue;
          state.relics.push(relic);
          relic.apply();
          addLog(`获得遗物：${relic.label}`);
        }
        addLog(`暗影交易完成！获得 5 件遗物！`);
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('reward'); } catch (e) { console.warn('[音效] 暗影交易音效播放失败:', e); }
        }
      } else {
        addLog(`生命不足 20 点，暗影交易失败...`);
      }
      advanceRoom();
    }
  },
  {
    label: '许愿池',
    description: '花费 20 金币，随机获得一项属性提升。',
    apply: () => {
      if (state.player.gold < 20) {
        addLog('金币不足 20，许愿池对你无动于衷...');
        advanceRoom();
        return;
      }
      
      state.player.gold -= 20;
      addLog('你向许愿池投入了 20 金币...');
      spawnDamageFloat(20, 'goldLose');
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('wish'); } catch (e) { console.warn('[音效] 许愿音效播放失败:', e); }
      }
      
      const rewards = [
        { label: '生命上限 +5', weight: 15, apply: () => { state.player.maxHp += 5; state.player.hp += 5; addLog('❤️ 许愿池回应了你：生命上限 +5！'); spawnDamageFloat(5, 'heal'); } },
        { label: '攻击 +1', weight: 12, apply: () => { state.player.attack += 1; addLog('⚔️ 许愿池回应了你：攻击 +1！'); spawnDamageFloat(1, 'attack'); } },
        { label: '护盾 +5', weight: 12, apply: () => { state.player.shield += 5; addLog('🛡️ 许愿池回应了你：护盾 +5！'); spawnDamageFloat(5, 'shield'); } },
        { label: '金币 +30', weight: 10, apply: () => { state.player.gold += 30; addLog('💰 许愿池回应了你：金币 +30！'); spawnDamageFloat(30, 'gold'); } },
        { label: '治疗药水 +2', weight: 10, apply: () => { addPotion('heal', 2); addLog('🧪 许愿池回应了你：治疗药水 +2！'); spawnDamageFloat(2, 'heal'); } },
        { label: '暴击率 +10%', weight: 8, apply: () => { addLuckyLevel(1, '许愿池'); } },
        { label: '暴击伤害 +10%', weight: 8, apply: () => { state.critDamage = (state.critDamage || 150) + 10; addLog(`💢 许愿池回应了你：暴击伤害 +10%！当前 ${state.critDamage}%`); spawnDamageFloat('+10%', 'crit'); } },
        { label: '荆棘 +1', weight: 8, apply: () => { state.thornLevel = (state.thornLevel || 0) + 1; addLog('🌿 许愿池回应了你：荆棘 +1！'); spawnDamageFloat(1, 'thorn'); } },
        { label: '吸血 +1', weight: 8, apply: () => { state.vampireLevel = (state.vampireLevel || 0) + 1; addLog('🩸 许愿池回应了你：吸血 +1！'); spawnDamageFloat(1, 'vampire'); } },
        { label: '闪避 +5%', weight: 5, apply: () => { addDodgeLevel(1, '许愿池'); } },
        { label: '连击 +5%', weight: 5, apply: () => { addComboLevel(1, '许愿池'); } },
        { label: '斩杀 +5%', weight: 5, apply: () => { addExecuteLevel(1, '许愿池'); } },
        { label: '力量药水 +1', weight: 6, apply: () => { addPotion('strength', 1); addLog('🧪 许愿池回应了你：力量药水 +1！'); spawnDamageFloat(1, 'heal'); } },
        { label: '随机遗物', weight: 3, apply: () => { chooseRelicByRarity(false); addLog('✨ 许愿池回应了你：获得一件随机遗物！'); } },
      ];
      
      let totalWeight = 0;
      rewards.forEach(r => totalWeight += r.weight);
      
      let random = Math.random() * totalWeight;
      let selected = rewards[0];
      for (const reward of rewards) {
        random -= reward.weight;
        if (random <= 0) {
          selected = reward;
          break;
        }
      }
      
      if (selected.label === '随机遗物') {
        if (!window._wishPoolAdvance) {
          window._wishPoolAdvance = true;
          selected.apply();
          if (selected.label !== '随机遗物') {
            advanceRoom();
          }
          window._wishPoolAdvance = false;
        }
      } else {
        selected.apply();
        advanceRoom();
      }
    }
  },
  {
    label: '知识祭坛',
    description: '向祭坛献上经验，获得遗物。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('sacrifice'); } catch (e) { console.warn('[音效] 献祭音效播放失败:', e); }
      }
      let expCost = 20;
      let relicCount = 1;
      
      if (state.hasAncientBless) {
        if (Math.random() < 0.25) {
          expCost = 0;
          addLog('🙏 古神眷顾触发！这次献祭不消耗经验！');
        } else if (Math.random() < 0.15) {
          relicCount = 2;
          addLog('✨ 古神眷顾触发！获得双倍遗物！');
        } else if (Math.random() < 0.01) {
          relicCount = 4;
          addLog('🌟 古神大显灵！获得四倍遗物！！');
        }
      }
      
      if (state.player.xp < expCost) {
        addLog(`经验不足（需 ${expCost}），知识祭坛没有回应...`);
        advanceRoom();
        return;
      }
      
      if (expCost > 0) {
        state.player.xp -= expCost;
        addLog(`献祭 ${expCost} 点经验`);
        spawnDamageFloat(expCost, 'xp');
      }
      
      for (let i = 0; i < relicCount; i++) {
        chooseRelicByRarity();
      }
    }
  },
  {
    label: '战斗导师',
    description: '一位神秘的战士愿意指点你，消耗15经验随机获得属性提升。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('buff'); } catch (e) { console.warn('[音效] 指导音效播放失败:', e); }
      }
      const cost = 15;
      if (state.player.xp < cost) {
        addLog(`经验不足（需 ${cost}），战斗导师摇头离去。`);
        advanceRoom();
        return;
      }
      state.player.xp -= cost;
      const rand = Math.random();
      let msg = '';
      if (rand < 0.45) {
        state.player.attack += 1;
        msg = '攻击 +1！';
        spawnDamageFloat(1, 'attack');
      } else if (rand < 0.90) {
        state.player.maxHp += 3;
        state.player.hp += 3;
        msg = '生命上限 +3！';
        spawnDamageFloat(3, 'heal');
      } else {
        state.player.attack += 1;
        state.player.maxHp += 3;
        state.player.hp += 3;
        msg = '两者都获得！攻击 +1，生命上限 +3！';
        spawnDamageFloat(1, 'attack');
        spawnDamageFloat(3, 'heal');
      }
      addLog(`战斗导师指导你，${msg}`);
      advanceRoom();
    }
  },
  {
    label: '恶魔低语',
    description: '聆听恶魔的低语，风险与收益并存。',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('whisper'); } catch (e) { console.warn('[音效] 低语音效播放失败:', e); }
      }
      if (Math.random() < 0.5) {
        state.player.gold = Math.max(0, state.player.gold - 10);
        state.player.hp = Math.max(1, state.player.hp - 8);
        addLog('你聆听了恶魔的低语，头脑一阵眩晕，晕了过去，金币-10，生命-8');
        spawnDamageFloat(8, 'damage');
        spawnDamageFloat(10, 'goldLose');
      } else {
        state.player.gold += 10;
        state.player.maxHp += 8;
        state.player.hp += 8;
        addLog('你聆听了恶魔的低语，通过了恶魔的考验，金币+10，生命上限+8');
        spawnDamageFloat(10, 'gold');
        spawnDamageFloat(8, 'heal');
      }
      advanceRoom();
    }
  },
  {
    label: '破败祭坛',
    description: '一个荒废百年的祭坛，会不会有遗物呢？',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('debuff'); } catch (e) { console.warn('[音效] 祭坛音效播放失败:', e); }
      }
      if (Math.random() < 0.5) {
        state.player.attack = Math.max(0, state.player.attack - 1);
        addLog('你踏入了这片破败之地，长时间的探索让你十分疲倦，攻击力-1');
        spawnDamageFloat(1, 'attack');
      } else {
        const relic = getRandomRelicByRarity();
        state.relics.push(relic);
        relic.apply();
        addLog(`你踏入了这片破败之地，长时间的探索后，你发现了一件遗物：${relic.label}`);
        spawnDamageFloat('✨', 'relic');
      }
      advanceRoom();
    }
  },
  {
    label: '商队护送',
    description: '你遇到了一支商队，要不要帮忙呢？',
    apply: () => {
      if (Math.random() < 0.4) {
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('buff'); } catch (e) { console.warn('[音效] 护送成功音效播放失败:', e); }
        }
        state.shopLimitBonus = (state.shopLimitBonus || 0) + 2;
        addLog('你成功保全商队，获得了一张会员卡，所有商品限购次数+2！');
        spawnDamageFloat(2, 'relic');
      } else {
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try { AbyssAudio.sfx('trap'); } catch (e) { console.warn('[音效] 护送失败音效播放失败:', e); }
        }
        const lost = Math.floor(state.player.gold * 0.1);
        if (lost > 0) {
          state.player.gold -= lost;
          addLog(`你在护送途中遇到了一大群咕咕嘎嘎，任务失败，失去 ${lost} 金币`);
          spawnDamageFloat(lost, 'goldLose');
        } else {
          addLog('你在护送途中遇到了一大群咕咕嘎嘎，但你身无分文，它们失望地离开了。');
        }
      }
      advanceRoom();
    }
  },
  {
    label: '打抱不平',
    description: '你遇到了一个奸商，要不要讲讲价？',
    apply: () => {
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try { AbyssAudio.sfx('coin'); } catch (e) { console.warn('[音效] 讲价音效播放失败:', e); }
      }
      if (Math.random() < 0.5) {
        if (state.player.gold >= 1) {
          state.player.gold -= 1;
          addPotion('heal', 1);
          addLog('你用你惊人的口才说服了他，以1金币购买了1瓶治疗药水');
          spawnDamageFloat(1, 'goldLose');
          spawnDamageFloat(1, 'heal');
        } else {
          addLog('金币不足，你被奸商赶走了');
        }
      } else {
        if (state.player.gold >= 25) {
          state.player.gold -= 25;
          addPotion('heal', 1);
          addLog('你没有说服他，还被反将一军，以25金币购买了1瓶治疗药水');
          spawnDamageFloat(25, 'goldLose');
          spawnDamageFloat(1, 'heal');
        } else {
          addLog('金币不足，你被奸商赶走了');
        }
      }
      advanceRoom();
    }
  },
];

window.ALL_EVENT_OPTIONS = ALL_EVENT_OPTIONS;

function getRandomEvent() {
  // 拷贝后再打乱，避免原地修改全局 ALL_EVENT_OPTIONS 数组
  const shuffled = ALL_EVENT_OPTIONS.slice().sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3);
}

function resolveEvent() {
  if (state.gameOver || state.mode === 'combat' || state.mode === 'reward') return;
  const room = state.currentRoom;
  if (!room) return;
  if (room.type === 'shop') {
    state.shopOptions = buildShopOptions();
    state.mode = 'shop';
    addLog('商店里出现了稀有商品。');
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try { AbyssAudio.sfx('shop'); } catch (e) { console.warn('[音效] 商店音效播放失败:', e); }
    }
    return;
  }

  if (room.type === 'event') {
    state.eventOptions = getRandomEvent();
    state.mode = 'eventChoice';
    addLog('你遇到了一个随机事件。');
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try { AbyssAudio.sfx('event'); } catch (e) { console.warn('[音效] 随机事件音效播放失败:', e); }
    }
    return;
  }

  if (room.type === 'rest') {
    state.mode = 'rest';
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try { AbyssAudio.sfx('rest'); } catch (e) { console.warn('[音效] 休整音效播放失败:', e); }
    }
    return;
  }

  if (room.type === 'treasure') {
    state.player.gold += 15;
    addLog('你在宝箱中找到了 15 金币。');
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try { AbyssAudio.sfx('chest'); } catch (e) { console.warn('[音效] 宝箱音效播放失败:', e); }
    }
    spawnDamageFloat(15, 'gold');
  }

  if (room.type === 'boss') {
    addLog('你终于走到了最后一关。');
  }

  if (room.type === 'elite') {
    startCombat(true);
    return;
  }

  advanceRoom();
}

function buyFromShop(index) {
  if (state.mode !== 'shop') return;
  const option = state.shopOptions[index];
  if (!option) return;
  
  if (!state.shopPurchaseCount) {
    state.shopPurchaseCount = {};
  }

  const purchaseCount = state.shopPurchaseCount[option.label] || 0;
  const maxPurchase = option.maxPurchase || (option.rarity === 'rare' ? 5 : 20);
  
  if (purchaseCount >= maxPurchase) {
    addLog(`⚠️ ${option.label} 已售罄！（限购 ${maxPurchase} 次）`);
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try {
        AbyssAudio.sfx('error');
      } catch (error) {
        console.warn('[音效] 音效播放失败:', error);
      }
    }
    state.shopOptions = buildShopOptions();
    scheduleRender();
    return;
  }

  const goldCost = getShopItemCost(option);
  const expCost = option.expCost || option.cost;
  
  if (goldCost < 0) {
    const refund = Math.abs(goldCost);
    state.player.gold += refund;
    addLog(`💰 商店倒贴你 ${refund} 金币！${option.label} 白送还赚钱！`);
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try {
        AbyssAudio.sfx('coin');
      } catch (error) {
        console.warn('[音效] 音效播放失败:', error);
      }
    }
    option.apply();
    state.shopPurchaseCount[option.label] = purchaseCount + 1;
    state.shopOptions = buildShopOptions();
    scheduleRender();
    return;
  }
  
  if (goldCost === 0) {
    addLog(`${option.label} 免费获得！`);
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
    try {
      AbyssAudio.sfx('reward');
    } catch (error) {
      console.warn('[音效] 奖励音效播放失败:', error);
    }
  }
    option.apply();
    state.shopPurchaseCount[option.label] = purchaseCount + 1;
    state.shopOptions = buildShopOptions();
    scheduleRender();
    return;
  }
  
  let payWithGold = false;
  let payWithExp = false;
  
  if (state.player.gold >= goldCost) {
    payWithGold = true;
  } else if (state.player.xp >= expCost) {
    payWithExp = true;
  } else {
    addLog(`金币不足（需 ${goldCost}），经验也不足（需 ${expCost}），无法购买。`);
    if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
      try {
        AbyssAudio.sfx('error');
      } catch (error) {
        console.warn('[音效] 音效播放失败:', error);
      }
    }
    return;
  }

  if (payWithGold) {
    state.player.gold -= goldCost;
    addLog(`你花费 ${goldCost} 金币购买了 ${option.label}。`);
  } else {
    state.player.xp -= expCost;
    addLog(`你花费 ${expCost} 经验购买了 ${option.label}。`);
  }
  if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
    try {
      AbyssAudio.sfx('buy');
    } catch (error) {
      console.warn('[音效] 音效播放失败:', error);
    }
  }
  
  if (typeof option.apply === 'function') {
    option.apply();
  } else {
    addLog(`⚠️ 商品 "${option.label}" 的 apply 方法丢失，无法购买`);
    showToast('购买失败，请刷新重试');
    state.shopOptions = buildShopOptions();
    scheduleRender();
    return;
  }
  state.shopPurchaseCount[option.label] = purchaseCount + 1;
  
  const remaining = maxPurchase - (purchaseCount + 1);
  addLog(`（剩余可购 ${remaining} 次）`);
  
  state.shopOptions = buildShopOptions();
  scheduleRender();
}

function leaveShop() {
  if (state.mode !== 'shop') return;
  state.shopOptions = [];
  addLog('你离开了商店。');
  advanceRoom();
}

function advanceRoom() {
  const oldFloor = state.floor;
  const custom = state && state.difficulty === 'custom' && isCustomDifficultyEnabled()
    ? normalizeCustomDifficulty(state.customDifficulty)
    : null;
  const customFloorCap = custom && custom.floorCap > 0 ? custom.floorCap : 0;

  state.roomIndex += 1;
  if (state.roomIndex >= state.rooms.length) {
    const canContinue = customFloorCap > 0 ? state.floor < customFloorCap : state.floor < MAX_FLOOR;
    if (canContinue) {
      state.floor += 1;
      state.environment = generateEnvironmentEffect(state.floor, state.difficulty);
      if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
        try {
          AbyssAudio.sfx('floor');
        } catch (error) {
          console.warn('[音效] 音效播放失败:', error);
        }
      }
      const envDesc = state.environment.displayValue ? 
        `${state.environment.name} - ${formatEnvDescription(state.environment)} (${state.environment.displayValue})` :
        `${state.environment.name} - ${formatEnvDescription(state.environment)}`;
      addLog(`当前楼层环境效果：${envDesc}`);
      state.roomIndex = 0;
      state.rooms = generateFloorRooms(state.floor);
      state.heroSkillUsed = false;
      addLog(`你闯入了第 ${state.floor} 层。`);
      
      if (state.floor > oldFloor) {
        const banner = document.createElement('div');
        banner.className = 'floor-banner';
        banner.textContent = `⬇ 第 ${state.floor} 层 ⬇`;
        document.querySelector('.app-shell').prepend(banner);
        setTimeout(() => banner.remove(), 1500);
      }
    } else {
      addLog(customFloorCap > 0 ? `已达到自定义楼层上限：第 ${customFloorCap} 层。` : '你已经到达了深渊的最深层。');
      state.mode = 'victoryChoice';
      state.endOptions = getEndOptions();
      return;
    }
  }
  enterCurrentRoom();
}

function chooseEnding(index) {
  const choice = state.endOptions[index];
  if (!choice) return;
  state.endResult = choice;
  state.mode = 'finished';
  completeRun();
  addLog(`你选择了结局：${choice.title}`);
  if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
    try {
      AbyssAudio.sfx('finale');
    } catch (error) {
      console.warn('[音效] 音效播放失败:', error);
    }
  }
}

function continueAdventure() {
  state.endOptions = [];
  state.endResult = null;
  state.mode = 'event';
  advanceRoom();
}

function openConditionsModal() {
  if (!refs.conditionsModal || !refs.conditionsList) return;
  refs.conditionsList.innerHTML = '';
  getConditionEntries().forEach(entry => {
    const item = document.createElement('div');
    item.className = `condition-item${entry.achieved ? ' achieved' : ''}`;
    item.innerHTML = `<strong>${entry.title}</strong><p>${entry.description}</p><p class="condition-progress">${entry.progress}</p>`;
    refs.conditionsList.appendChild(item);
  });
  refs.conditionsModal.classList.remove('hidden');
}

function closeConditionsModal() {
  if (!refs.conditionsModal) return;
  refs.conditionsModal.classList.add('hidden');
}

function openEncyclopediaModal() {
  if (!refs.encyclopediaModal || !refs.encyclopediaList) return;
  
  state.encyclopediaState.viewMode = 'categories';
  state.encyclopediaState.currentCategory = null;
  
  const modalContent = refs.encyclopediaModal.querySelector('.modal-content');
  const backdrop = refs.encyclopediaModal.querySelector('.modal-backdrop');
  if (modalContent) {
    modalContent.style.animation = '';
  }
  if (backdrop) {
    backdrop.style.animation = '';
  }
  
  refs.encyclopediaModal.classList.remove('hidden');
  renderEncyclopedia();
}

function closeEncyclopediaModal() {
  if (!refs.encyclopediaModal) return;
  
  const modalContent = refs.encyclopediaModal.querySelector('.modal-content');
  const backdrop = refs.encyclopediaModal.querySelector('.modal-backdrop');
  
  if (modalContent) {
    modalContent.style.animation = 'fadeOut 0.3s ease forwards';
  }
  if (backdrop) {
    backdrop.style.animation = 'fadeOut 0.3s ease forwards';
  }
  
  setTimeout(() => {
    refs.encyclopediaModal.classList.add('hidden');
    if (modalContent) {
      modalContent.style.animation = '';
    }
    if (backdrop) {
      backdrop.style.animation = '';
    }
  }, 300);
}

function openChangelogModal() {
  if (!refs.changelogModal || !refs.changelogList) return;
  
  const modalContent = refs.changelogModal.querySelector('.modal-content');
  const backdrop = refs.changelogModal.querySelector('.modal-backdrop');
  
  // 重置所有样式，避免残留动画
  if (modalContent) {
    modalContent.style.animation = '';
    modalContent.style.pointerEvents = '';
  }
  if (backdrop) {
    backdrop.style.animation = '';
  }
  
  // 确保模态框可见
  refs.changelogModal.classList.remove('hidden');
  refs.changelogModal.style.zIndex = '114514';
  renderChangelog();
}

function closeChangelogModal() {
  if (!refs.changelogModal) return;
  
  const modal = refs.changelogModal;
  const modalContent = modal.querySelector('.modal-content');
  const backdrop = modal.querySelector('.modal-backdrop');
  
  // 如果已经隐藏，直接返回
  if (modal.classList.contains('hidden')) return;
  
  // 播放关闭动画
  if (modalContent) {
    modalContent.style.animation = 'fadeOut 0.25s ease forwards';
  }
  if (backdrop) {
    backdrop.style.animation = 'fadeOut 0.25s ease forwards';
  }
  
  // 动画结束后真正隐藏
  setTimeout(() => {
    modal.classList.add('hidden');
    // 重置动画样式，以便下次打开
    if (modalContent) {
      modalContent.style.animation = '';
      modalContent.style.pointerEvents = '';
    }
    if (backdrop) {
      backdrop.style.animation = '';
    }
  }, 300);
}

function renderChangelog() {
  const list = refs.changelogList;
  if (!list) return;
  
  list.innerHTML = '';
  
  // ===== 更新记得写日志 =====
  const changelogData = [
    {
      version: 'v0.1',
      date: '初始版本',
      changes: [
        '设计并实现基础肉鸽小游戏框架',
        '添加英雄选择、地牢层数、战斗系统、商店和休整逻辑',
        '实现普通敌人、精英守卫和层主的战斗流程',
        '记录难度和进度，支持本地存储'
      ]
    },
    {
      version: 'v0.2',
      date: '英雄技能与战斗系统强化',
      changes: [
        '实现英雄技能体系，并为各英雄添加基础被动技能',
        '添加技能描述显示到英雄选择与游戏界面中',
        '增加战斗日志与回合效果反馈'
      ]
    },
    {
      version: 'v0.3',
      date: '主动技能与楼层限制',
      changes: [
        '添加可实用的英雄主动技能',
        '主动技能调整为每层可使用一次，而非每场战斗一次',
        '修复主动技能不应消耗敌方回合的行为'
      ]
    },
    {
      version: 'v0.4',
      date: 'Boss 奖励与结局流程修复',
      changes: [
        '修复击败 Boss 后无奖励选项的问题',
        '修复 bossVictory 流程，确保击败 Boss 后进入奖励选择和结局分支',
        '优化奖励选择界面，移除多余继续按钮'
      ]
    },
    {
      version: 'v0.5',
      date: '遗物系统扩展与叠加效果',
      changes: [
        '引入遗物堆叠机制，改用 countRelic() 统计重复遗物效果',
        '修复遗物效果仅单次生效的问题，支持多件同名遗物叠加',
        '扩展遗物池，添加多种新遗物及其效果',
        '更新商店和休整效果，使遗物效果生效于对应游戏环节'
      ]
    },
    {
      version: 'v0.6',
      date: '遗物与图鉴完善',
      changes: [
        '添加遗物图鉴条目，补全遗物说明',
        '将遗物说明加入图鉴界面，便于玩家查看',
        '增加遗物、英雄技能和怪物的图鉴分类内容'
      ]
    },
    {
      version: 'v0.7',
      date: '结局与成就完善',
      changes: [
        '添加多种结局条件与描述',
        '实现结局进度显示，包含英雄身份、金币和层数要求',
        '增加特殊结局触发条件，例如复合遗物组合结局'
      ]
    },
    {
      version: 'v0.8',
      date: '细节与体验优化',
      changes: [
        '修复主动技能使用逻辑和按钮显示',
        '改进 Boss 奖励和挑战结束后的界面体验',
        '补充图鉴中遗物、道具、怪物和英雄技能的条目',
        '完成对当前游戏状态的多项修复与文档整理'
      ]
    },
    {
      version: 'v0.9',
      date: '英雄与战斗增益扩展',
      changes: [
        '新增英雄：圣骑士（攻守兼备，自带护盾）和暗影（高暴击，首回合必暴）',
        '新增开局增益：吸血之刃、荆棘护甲、生命护盾、双倍金币、会心一击、古神眷顾、暴击强化、荆棘强化、吸血强化、致命打击',
        '新增战斗奖励：暴击伤害 +20%',
        '英雄选择界面更新为"从十一位英雄中选择一位"',
        '更新图鉴，新增所有增益条目'
      ]
    },
    {
      version: 'v1.0',
      date: '暴击系统重做与修bug',
      changes: [
        '暴击率达到 100% 后自动关闭所有获取渠道，避免溢出浪费',
        '新增暴击伤害系统，默认 150%，可通过增益/奖励叠加提升',
        '暗影英雄首回合暴击现在使用暴击伤害倍数计算',
        '角色面板新增暴击率和暴击伤害实时显示',
        '暴击率达到 100% 时面板金色高亮提示',
        '新增"致命打击"增益：暴击伤害 +20%',
        '角色面板增加滚动支持，适应更多属性显示',
        '古老祭坛扣血后会有动画'
      ]
    },
    {
      version: 'v1.1',
      date: '新增随机事件与失败记录',
      changes: [
        '新增诅咒之井',
        '新增智慧圣殿',
        '新增治疗之泉',
        '新增幸运骰子',
        '新增附魔铁砧',
        '新增幽灵低语',
        '如果失败时超过最深层数，最深层数也会刷新',
        '新增失败次数'
      ]
    },
    {
      version: 'v1.2',
      date: '新增商品&商品限购与修复&新增动画',
      changes: [
        '新增普通商品锐利之刃',
        '新增普通商品生命宝石',
        '新增稀有商品龙鳞护盾',
        '新增稀有商品暗影披风',
        '新增稀有商品生命之源',
        '新增稀有商品治愈盛典',
        '普通商品限购20次',
        '稀有商品限购5次',
        '修复幸运骰子动画错误问题',
        '修复吸血没加血动画问题',
        '修复宝箱加金币没动画',
        '修复休息点加血没动画',
        '修复休息点使用药水没动画',
        '修复幽灵低语没动画',
        '新增吸血动画',
        '新增荆棘动画',
        '新增暴击率动画',
        '新增暴击伤害动画'
      ]
    },
    {
      version: 'v1.3',
      date: '重构图鉴系统与增加更新日志和模式切换',
      changes: [
        '重构图鉴系统',
        '在顶栏增加更新日志按钮',
        '新增模式切换',
        '特殊更新：可以使用网址访问同时调整了移动端UI布局'
      ]
    },
    {
      version: 'v1.4',
      date: '增加存档系统',
      changes: [
        '每3次渲染自动保存1次，重进后仍可继续游玩',
        '修复一些已知问题'
      ]
    },
    {
      version: 'v1.5',
      date: '增加作弊按钮与手动存档',
      changes: [
        '新增手动存档按钮',
        '新增作弊按钮，可以修改角色数值，选择指定遗物和增益',
        '修复一些已知问题'
      ]
    },
    {
      version: 'v1.6',
      date: '修bug与新增属性和遗物',
      changes: [
        '修复英雄技能失效这一重大bug',
        '新增属性连击',
        '新增属性闪避',
        '新增属性斩杀',
        '新增遗物狂战之心',
        '新增遗物双刃匕首',
        '新增遗物猎杀标记',
        '新增遗物完美之刃',
        '新增遗物不死图腾',
        '修复一些已知问题'
      ]
    },
    {
      version: 'v1.7',
      date: '新遗物&敌人属性&战斗统计&属性详情',
      changes: [
        '新增遗物',
        '  - 斩杀之镰：斩杀成功后，本场战斗攻击 +1（可叠加）',
        '  - 命运轮盘：战斗开始时 50% 获得 20 护盾，50% 扣除 5 生命（出现概率低）',
        '  - 暗影交易：用 20 生命换取 5 件随机遗物（出现概率极低，已加入随机事件池）',
        '敌人属性系统（10层后解锁）',
        '  - 10层后敌人开始获得额外属性，随层数逐渐增强',
        '  - 荆棘：攻击玩家时反弹伤害',
        '  - 闪避：概率闪避玩家攻击',
        '  - 吸血：攻击玩家时恢复生命',
        '  - 连击：受到攻击后概率反击',
        '  - 暴击：攻击玩家时概率造成暴击伤害',
        '战斗统计显示',
        '  - 战斗中实时显示本场暴击/连击/斩杀/闪避触发次数',
        '  - 敌人属性在战斗中可见',
        '属性详情弹窗',
        '  - 点击角色面板中的任意属性值，弹出详细说明',
        '  - 显示当前数值、本场战斗统计和相关效果说明',
        '  - 支持生命、攻击、护盾、金币、药水、暴击率、暴击伤害、荆棘、吸血、闪避、连击、斩杀、英雄技能、生命护盾、双倍金币、古神眷顾共16项属性',
        '其他优化',
        '  - 修复加载存档后属性点击事件失效的问题',
        '  - 修复属性详情弹窗被作弊面板遮挡的问题',
        '  - 优化图鉴返回按钮和模式切换按钮的稳定性',
        '修复部分已知问题'
      ]
    },
    {
      version: 'v1.8',
      date: '自定义难度&新事件&侧边栏',
      changes: [
        '新增自定义难度',
        '新增侧边栏',
        '新增随机事件许愿池',
        '优化存档部分，几乎解决了所有因存档系统引起的bug',
        '修复部分已知问题'
      ]
    },
    {
      version: 'v1.9',
      date: '不知道取什么标题了...',
      changes: [
        '新增货币经验，击败敌人后获取',
        '商品可用经验购买',
        '新增事件战斗导师',
        '新增事件知识祭坛，受古神眷顾影响',
        '新增新手引导，顶栏点教程按钮触发',
        '作弊按钮移至侧边栏',
        '性能优化，正常玩应该不会卡死了',
        '修复大量bug，大量bug哪来的你别管',
        '修复移动端看不到自定义难度确认按钮的问题',
        '修复部分已知问题'
      ]
    },
    {
      version: 'v2.0',
      date: '竟然能更到2.0',
      changes: [
        '修复自动存档失效及手动存档加载后按钮失效问题',
        '新增开始界面',
        '更新日志按钮移至开始界面右上角',
        '更新日志从引用文件改为硬编码形式',
        '修复重新开始不会重置连击，闪避，斩杀三项数值',
        '新增在作弊面板中能修改经验，连击，闪避，斩杀',
        '新增事件恶魔低语(感谢子涵玩家提供想法)',
        '新增事件破败祭坛(感谢子涵玩家提供想法)',
        '修复部分已知问题'
      ]
    },
    {
      version: 'v2.1',
      date: '开发者模式与其他',
      changes: [
        '新增开发者模式（测试用的，你们要会用的话也可以当作弊用）',
        '修复护盾抵挡伤害的计算错误',
        '新增敌人属性暴击率和吸血',
        '新增随机事件图鉴',
        '修复事件战斗导师的相关bug'
      ]
    },
    {
      version: 'v2.2',
      date:'试炼模式与其他',
      changes:[
        '新增试炼模式',
        '同步更新作弊面板，开发者模式等',
        '新增测试面板（浏览器控制台或直接运行文件打开，测bug用的，玩的时候用不到）',
        '新增怪物：咕咕嘎嘎（依旧感谢子涵）',
        '修复部分已知问题'
      ]
    },
    {
      version: 'v2.3',
      date:'样式更改与存档更新',
      changes:[
        '手动存档改为存档管理按钮，支持5个存档位与覆盖、导出、改名等功能',
        '更新开始界面样式',
        '更新经典界面样式',
        '更新试炼界面样式',
        '新增环境效果',
        '针对小米平板4等中等尺寸设备做了适配',
        '修复部分已知问题'
      ]
    },
    {
      version:'2.4',
      date:'环境、设置、试炼及子涵神了',
      changes:[
        '大改环境效果',
        '侧边栏新增设置按钮，目前可控制5项开关',
        '更改Toast提示样式',
        '修改试炼商店与试炼回合上限',
        '自定义难度取消确认按钮，改为实时计算',
        '新增房间镜像',
        '新增怪物死尸,岩浆行者,影（窃）,影（附身）,影（魅）,死灵法师,影之皇,镜像怪,复制法师',
        '新增随机事件打抱不平，商队护送',
        '大量购买商品时合并渲染，防止卡死',
        '修复部分已知问题',
        '由于技术原因，部分设备在层级进度中环境效果无法显示，河神与清言、大肥鱼等众多大佬讨论了2个小时也没解决，向你们道歉，移动端目前可在进入下一层时在战斗日志中查看当前环境效果'
      ]
    },
    {
      version:'2.5',
      date:'自定义难度拓展与其他',
      changes:[
        '拓展自定义难度',
        '存档方面优化',
        '新增背景音乐和音效及对应开关',
        '移动端层级进度中环境效果可以正常显示了',
        '暂时下架了试炼模式入口',
        '修复部分已知问题'
      ]
    },
    {
      version:'2.6',
      date:'2D试炼',
      changes:[
        '试炼模式改为2D实时画面，进入试炼默认2D实时战斗界面，若不支持会自动回退到老板文字界面，移动端按钮与信息面板都可自定义，支持导入导出',
        '多的懒得写了，自己探索吧',
        '修复部分已知问题'
      ]
    },
    {
      version:'2.7',
      date:'双版本与 2D 全面化',
      changes:[
        '新版与老版（2.6）双版本共存：侧边栏可随时切换，默认进入新版；老版就此冻结，只保留小问题修复',
        '两版存档完全隔离：新版首次启动会把 2.6 的存档复制一份过来，老版进度原样保留、互不影响',
        '修复手机横屏下跳上台阶后看不见自己与上方场景的问题（相机纵向留出余量，桌面端行为不变）',
        '经典模式全面 2D 实时化：房间 / 战斗 / 商店 / 遗物 / 诅咒 / 事件 / 结局全部在 2D 画面里进行，试炼模式并入并关停'
      ]
    },
    {
      version:'2.7.1',
      date:'合并遗留修复（12 项）',
      changes:[
        '2D 画面左上角标题改为「深渊回廊 BY HESHEN」',
        '移除画内「文字界面」按钮（试炼关停后它已无意义，切老版在侧边栏里）',
        '2D 起不来时不再只是默默退回文字界面：改为弹出说明面板，可一键重试 / 切换到老版 2.6 / 继续文字模式',
        '「退出试炼」改为「退出」；暂停菜单点「结束本局」会先关掉暂停窗再弹确认框，不再需要点两次',
        '新增「胜利」：每打完一层层主就按侧边栏「通关条件」结算一次，达成即可选结局通关，也可以「继续战斗」',
        '只有真正在 2D 战斗画面才锁横屏 + 全屏；回到选英雄 / 结算 / 结局 / 开始界面会自动解锁',
        '2D 画面 HUD 新增「更多」按钮，打开的就是文字界面那套侧边栏（作弊 / 通关条件 / 图鉴 / 教程 / 存档管理 / 难度 / 切换老版）',
        '修复新版作弊面板打不开、抽取遗物会报错（试炼关停时漏删的调用）',
        '手机横屏 / 全屏自愈：被系统弹窗或切后台顶掉后，碰一下屏幕就自动恢复',
        '狂怒条旁边的数值改为与生命 / 体力同一条规则定位，永远贴着条',
        '存档管理与难度切换补进侧边栏，2D 画面里也能用',
        '收窄相机横向死区，修掉持续行走时画面一顿一顿的问题（纵向跟随行为不变）'
      ]
    },
    {
      version:'2.7.2',
      date:'手感与显示修复',
      changes:[
        '修复画面持续抽动 / 掉帧感（宿主每帧都在重排 HUD 与重置相机参数，现已改为按需）',
        '修复舞台收起再显示后画布可能塌成 0×0、导致画面错位抖动的问题',
        '重画非战斗房间（宝箱 / 祭坛 / 商店 / 休整点 / 事件）中央的场景物件：圆角、描边、辉光、地面投影与待交互呼吸',
        '修复离开非战斗房间后场景里残留漂浮部件的问题',
        '修复祭坛房在事件标题与房间列表里显示成 “undefined” 的问题',
        '修复商店里每件商品都显示 “undefined 点” 的问题，并补上商品说明与状态（可购买 / 金币不足 / 已售罄）',
        '修复图鉴里英雄与怪物条目显示英文内部代号、装备栏显示 sword + roundShield 等英文的问题',
        '修复主动「结束本局」时日志写“你倒下了”的问题；清理死亡结算面板上早已失效的“撤离 +25%”文案',
        '关于苹果用户无法自动切换横屏+全屏已在进2D画面添加提示，如想自动：请手动点击「分享 → 添加到主屏幕」，从主屏幕图标启动'
      ]
    },
    {
      version:'2.8',
      date:'节奏、深度与菜单中枢',
      changes:[
        '【全难度加强怪物】三个维度一起提，不只是加血加攻。① 难度倍率：简单 / 普通 / 困难 / 地狱的血量 +22% / +30% / +35% / +37%、攻击 +11% / +22% / +25% / +29%（相对旧版）；② 层数成长曲线提斜率：血量 floor×2+4 → floor×2.5+5、攻击 floor÷2 → floor×0.62，第 50 层爪牙从 104 血 / 28 攻变成 169 血 / 41 攻；③ **AI 侵略性** —— 敌人的移速 / 前摇 / 后摇 / 索敌范围现在也随难度走（普通 +8% 移速、索敌 +22%、出手间隔 −8%；地狱 +24% / +50% / −18%），怪会更快发现你、追得更紧、打得更勤',
        '【全难度加强怪物】精英与层主同步加强（普通难度第 50 层：精英守卫 110→177 血，层主 114→182 血）；前摇保留 200ms 硬下限 —— 完美闪避窗口是 150ms，压到窗口附近这一击就成了没法反应的抽奖，那不是变强是变坏',
        '【全难度加强怪物】新增 测试/怪物强度测试.js：把"改了多少"变成可读的对照表，并守住四档难度的强弱顺序（防止调参时把两档调反）与两条曲线常数',
        '【房间节奏】修复后期房间长到跑不完：房间长度原来随层数无限膨胀（第 50 层 8400px、第 100 层 15400px），现已封顶 —— 第 100 层与第 50 层等长，桌面端从 8 屏收到 2 屏',
        '【房间节奏】普通房敌人数量改为跟房间长度挂钩（原来第 10 层就封顶 7 只，房间却还在变长）：第 100 层每屏可见怪从 0.4 只回到约 6 只，走廊不再空',
        '【房间节奏】敌人出生区间前移：原来整块第一屏永远是空的、每次进房都要先白跑一屏才见到第一只怪，现在进房几步就接触',
        '【连携 · 新系统】完美闪避 / 完美格挡各攒 1 点连携（主角头顶的菱形点，上限 3）。点数会被下一次主动攻击吃掉：伤害 ×1.6，跳劈还会连带放大落地冲击波；真掉血就全部清零 ——「打得好」第一次变成一种能攒、能选、有风险的资源',
        '【遗物重做】24 件从「无条件数值」改成「有条件 + 互相放大」，分血怒 / 完美 / 连携 / 贪婪四派，同派互相放大（例：破釜沉舟的伤害改成随已损失生命连续上升，配血之饥渴与荆棘之心就是一套残血流）',
        '【遗物重做】新增连携流三件：连携之心（上限 3→5）、不屈意志（挨打只 −1 不清零）、回响精通（连携倍率 1.6→2.2）；三选一卡片直接标出流派，照着凑就是构筑',
        '【新敌人】铁壁兵：正面免疫伤害，必须跳劈（从上方）或绕到背后 —— 它转身有 700ms 延迟，那个窗口就是绕后的机会',
        '【新敌人】织网者：吐出的网不打伤害、只把移动降到 45%，而**闪避可以直接把网撕开**',
        '【新敌人】献祭者：周期性给周围同伴套血盾（中盾的怪身上有青色环），它自己不还手 —— 逼你换目标，而不是按「最近的先打」',
        '【图鉴】「实时战斗技巧」补上连携 / 机制型敌人 / 遗物流派三条说明',
        '【菜单与快捷键】「实时战斗技巧」新增首条：Esc / HUD「菜单」打开本局中枢的说明',
        '【修复】读档 / 导入外部存档之后 2D 画面回不去：引擎的接管判定里有一条「存档没有 currentRoom 就不接管」（= 还没进第一间房），而 currentRoom 是 2D 自己的进房回调写进去的 —— 存档如果是在"不在房间里"的时刻存的（刚打完层主、正在选结局），它就是 null，于是形成死锁：不接管 → 不会重新开局 → 永远不会产生 currentRoom。表现是**文字界面正常重绘、2D 停在上一局的最后一帧**。现在启动读档 / 存档管理加载 / 导入外部存档三个入口都会在 render 之前按存档的房间表补上入场标记，并在之后兜底补拉一次引擎',
        '【修复】换存档时 Object.assign 浅合并留下的旧局残留：旧版本导出的档没有 _rtCurses 字段，合并时不会删掉 state 上已有的键 —— 上一局的诅咒会留在新局身上（与「重新开始后诅咒还在」同一类问题，只是入口不同）',
        '【修复】「重新开始」没重置干净、新一局身上还带着上一局的诅咒：诅咒存在 state._rtCurses 里，而它既没在 state 里声明、也没被 resetCurrentSlot / initGame 清理 —— 于是旧诅咒被 startRun 原样带进新局。现在三处一起收口，重新开始必定从零开始',
        '【修复】作弊面板的「清除诅咒」是个死按钮：它只认已关停的试炼状态（state.trial.active），在经典 2D 模式下直接返回，等于点了没反应',
        '【修复】窄屏上行尾那颗功能按钮会被推出屏幕外（字号与按钮高度都有绝对下限，一行最少约 320px，窗口更窄时最后那颗就"不见了"，连布局编辑器的框也在屏幕外点不到）。现在整行会自动等比收缩，任何宽度下都落在画面里',
        '【修复】菜单里切难度会卡死：换完难度要重画一次菜单刷新高亮，而那次重画**先建新层、不销毁旧层** —— 每切一次就叠一层（每层 55 个显示对象 + 一层暗幕，旧层的按钮仍然留在场景里被渲染，而关闭菜单只销毁最后建的那层，前面几层永远回收不掉），连点几次就拖不动了。现在重画前先销毁旧层，且切难度改为**只重画那 5 颗难度胶囊**：整层重建实测 18.2ms（比一帧还长），只重画胶囊 0.53ms',
        '【修复】布局编辑器里点「退出」的框却选中「更多」：两颗按钮的功能与名字对不上（「退出」点下去弹的其实是暂停菜单，「更多」只是开侧边栏），现已合并，问题不再存在',
        '【菜单 · 新界面】HUD 的「更多」与「退出」合并成一颗「菜单」，打开画布内的**本局中枢**：左边是本局状态（生命 / 护盾 / 体力 / 金币 / 遗物 / 诅咒明细），右边是系统功能，底部是继续战斗 / 结束本局。快捷键 Esc（再按一次收起）',
        '【菜单】侧边栏那 8 项功能整体搬进画布菜单：通关条件 / 图鉴 / 教程 / 设置 / 存档管理 / 作弊 / 切换老版 2.6 / 难度。全部按画布风格重绘（同一套圆角面板与胶囊按钮，图标是照同一笔宽新画的，不用 emoji）',
        '【菜单】难度改成菜单里的一排胶囊，当前难度高亮；点一下立即生效并与侧边栏那个下拉走同一条路径，不会出现两套难度逻辑',
        '【菜单】诅咒明细独立成区：诅咒在持续结算（腐化脉冲），只给一个计数说不清代价',
        '【设置 · 横版】设置界面从「一列 14 项的竖长条」改成**按类别分列**（画面 / 音频 / 系统与操作），宽而扁、一屏看完，与 2D 画面的横版布局同构；横屏手机上保持三列，窄屏自动降到两列 / 一列',
        '【其它】侧边栏本体保留（开始界面 / 文字界面照旧用它），仅 2D 画面里不再有它的入口'
      ]
    },
    {
      version:'2.8.1',
      date:'遗物终于看得见了',
      changes:[
        '新增遗物栏，在血条下面，每件遗物一个图标（27 件各有专属符号），外圈颜色表示它属于血怒 / 完美 / 连携 / 贪婪哪一派，一眼能看出拿了几件、在凑哪一套',
        '遗物栏的图标可以点，打开「本局遗物」，一件一件写着名字、品质和完整效果，件数多了自动分页',
        '修正遗物效果说明：之前显示的是文字模式的旧描述，和 2D 实时效果对不上，照着描述凑流派会走偏，现在和图鉴说的是同一件事',
        '设置里新增「HUD 密度」：自动 / 完整 / 精简 / 极简四档，控制战斗中常驻多少信息，默认自动按屏幕尺寸挑，改完即时生效',
        '手机横屏时属性面板会被收起，而它原来的说法是「随时切文字界面」——那个按钮 2.8 已经删了，等于手机上看不到攻击暴击闪避这些数值。现在这些数值放进了遗物卡片的「属性明细」页，另外补上生命上限和体力上限',
        '遗物栏和属性面板的刷新加了缓存，窗口最小化时不再重排 HUD，避免切回来时界面闪一下、把自定义的面板位置顶掉',
        '没拿遗物的时候界面位置和 2.8 完全一样，不会因为这次改动平白少一条画面',
        '修复部分已知问题'
      ]
    },
    {
      version:'2.8.2',
      date:'手机画面不再糊',
      changes:[
        '手机（华为浏览器、iPhone 这类高分屏）上的 2D 战斗画面不再发糊：画布改成按屏幕真实像素渲染，同一块屏幕上画出来的像素是原来的 2~3 倍，文字、血条、图标、按钮边缘都是锐利的，也不再被浏览器放大成一格一格的方块',
        '电脑上完全没变：像素密度是 1 的设备走的就是原来那一套，界面位置、字号、相机一个像素都没动',
        '清楚是有代价的（像素多了 2~3 倍），所以低配机会自动把密度降一档，宁可稍糊也不卡；降到底就是旧版的效果',
        '界面上的文字全部按屏幕密度重新渲染，属性面板、药水数量、任务提示这些中文小字在手机上能看清了',
        '修复手机横屏时 2D 画面没铺满、底下露出文字界面的问题',
        '修复部分已知问题'
      ]
    },
    {
      version:'2.8.3',
      date:'属性入口与图鉴补完',
      changes:[
        '属性入口改成正式按钮：原来它是遗物栏旁边一颗 10px 的小字「▸ 属性」，手机上常被技能按钮盖住、点不到；现在它是功能按钮行里的「属性」（属性 / 商店 / 图鉴 / 设置 / 菜单），样式和图鉴、设置一样，点开直接就是属性明细',
        '这颗「属性」按钮也能在「2D 战斗按键自定义」里单独拖动、缩放、隐藏了',
        '血条空着的那一截现在看得见了：以前只有左边填了色的部分显眼，狂怒条这种常是空的，旁边的「狂怒 0/100」就像飘在半空；底槽提亮之后是一条完整的条，数字老老实实贴在条尾',
        '图鉴补全铁壁兵、织网者、献祭者的说明（正面免疫怎么破、闪避能把网撕开、先点掉套盾的那只）',
        '狂怒不再自动爆发：以前满怒 12 秒没按 R 会自己进入狂怒，现在满怒就一直存着，等你按 R（什么时候用由你决定）',
        '修复没拿遗物时，遗物栏那排「遗物 / 暂无」小字会画在狂怒条和属性面板之间的问题',
        '修复狂怒数值在镜头移动后跑偏的问题：刚进房间时它正好贴在条尾，人一走、镜头一跟，数字就贴着条往左滑，最后压到条上。现在它和生命、体力那两个数字一样钉在屏幕上，条怎么动它都跟着条',
        '修复布局编辑器里点「重置」之后血条会变粗一点（多 4 像素）的问题',
        '修复布局编辑器里已经隐藏掉的按钮仍然点得到的问题',
        '修复部分已知问题'
      ]
    },
    {
      version:'2.9',
      date:'让房间不再是同一种房间',
      changes:[
        '新增三种地形骨架：平厅 / 双层 / 断桥。每个战斗房间都会抽一个，按层数渐进（第 1 层仍是平厅）；双层有实体上层与 1~2 个连通口，断桥地面断 1~2 处、掉下去扣血并传回缺口右侧',
        '新增「塌陷」机制房：地面从左到右逐段塌陷，出口锁着，用魂晶当钥匙。没有浮台 —— 地面钥匙必须停下来读条，浮空钥匙跳跃触碰即收；地面段塌掉时未拾取的钥匙会被抛到前沿安全段',
        '塌陷房兜底：最后一段开始预警时强制解锁（无速度奖励）；掉进深渊扣最大生命 4%/7%/10%/12% 并传送到前沿 + 1；最后一段塌完会在出口补临时踏板，不会“门开了却站不住”',
        '新增「守点」「限时」机制房：守点站进圈内累计 8 秒（简单 6 / 地狱 10），圈外暂停；限时 30 秒内清空（简单 36 / 地狱 22），超时敌人强化但仍可通关',
        '机制投放：塌陷 15% / 守点 10% / 限时 10%，同一房最多 1 种；层主房 / 精英房 / 镜像房 / 起点房不挂，第 2 层不挂（第 3 层起），每 5 层保底一次',
        '魂晶重做：从每段平台 62% 改为每房保底 1 颗 + 30% 第二颗；新增蓝 / 深渊 / 腐化三色；靠近后站住 0.2 秒开始读条 0.6 秒，移动 / 受击 / 怪贴近都会打断',
        '低血回血显性化：生命低于 60% 时蓝色魂晶变绿、提示「救命」，拾取必定回复 35% 最大生命（至少 12 点），不再藏在随机分支里',
        '手感三件套：单向平台（从下可穿、从上可踩）、空中按下加速下坠并穿平台、踩头弹跳（从上方踩怪弹起并重置空中攻击）',
        '怪物节奏：前摇不因受击重置、前摇后 40% 霸体、近战怪对空扑击（300ms 前摇可闪）、charger 冲锋纵向判定加高；简单难度与前 3 层保留沙包感',
        '塌陷按难度缩放：简单 6 段 / 5.5s / 2 颗，普通 8 段 / 4.0s / 3 颗，困难 9 段 / 3.4s / 3 颗，地狱 10 段 / 2.8s / 4 颗；普通档为实测默认值',
        '图鉴新增「地形与机制」分类（开始界面与战斗内画布图鉴同一份数据），说明文字直接由引擎运行时常量生成；另保留 2.9 的塌陷回廊预览页作为调参工具',
        '修复部分已知问题'
      ]
    },
    {
      version:'2.9.1',
      date:'机制房收尾：三种骨架、奖励、可读性',
      changes:[
        '塌陷不再只挂在平厅：双层 / 断桥也成立。双层在下层塌到一半时**上层整块崩塌**（青色裂纹预警 2 秒，崩时把你震落到下层、不掉血），之后房间退化为平厅塌陷；断桥的缺口直接算「已经塌了的那一块」，剩下 6 块继续从左往右塌',
        '断桥 × 塌陷单独收三个参数：缺口固定 1 处、块数 8 → 6、间隔 4.0 → 4.5 秒（跨缺口要蓄力跳，比平地跑更费时间）。只对这一格生效，断桥 × 守点 / 限时 不受影响',
        '两种新骨架的钥匙都做了「凑不齐」约束：双层是下层 1 颗 + 上层 3 颗 + 空中 1 颗（下层+空中只有 2 颗），断桥是出生侧 2 颗 + 另一侧 3 颗 —— 不上去 / 不跨缺口就开不了门',
        '修复塌陷房 / 守点房通关后拿不到奖励的问题：这两条路径原来绕过了「房间清空」结算，导致没有金币、没有经验、没有三选一，也不自动存档',
        '塌陷房奖励补齐四条：基础（等同敌袭房）+ 提前（剩余块数 × 2）+ 收集（超出需求每颗 +3）+ 无伤（全程没掉进深渊，出口旁多一颗魂晶）',
        '守点圈不再压进 HUD / 出屏：圈半径随视口缩放（0.8~1.2），并按高度筛平台 —— 有合格高台就守高台，矮屏退到地面',
        '机制保底改成按层算：第 5 / 10 / 15… 层的第一个能挂机制的房必挂。原来固定在「第 2 列那间」，那一间若是宝箱 / 精英房，整层就没有机制房',
        '机制房不再落在精英 / 镜像 / 起点房上：原来会把这几间的怪挤掉（精英遗物照发、镜像怪消失），起点房还会一进门就抽到双层 / 断桥',
        '新增四组独立回退开关：单向平台 / 三色魂晶 / 停留读条 / 踩头弹跳（API.setToggles），以及「塌陷 × 双层 / 断桥」各自可关（API.setCollapseSkeleton）；出问题不用改代码',
        '正式局里这个机制叫「塌陷」，HUD 显示「房间:房型 · 塌陷」；「塌陷回廊」只作为样板房 / 预览页的名字保留',
        '预览页（其他/塌陷回廊预览.html）新增「骨架」下拉，可以直接试双层 / 断桥 × 塌陷；默认参数改为从引擎读取，不再手抄一份',
        '层数变体不再做：机制参数只按难度缩放（普通 8 / 4.0 / 3 是实机反推的），层数继续影响敌人强度与奖励',
        '修复部分已知问题'
      ]
    },
    {
      version:'2.9.2',
      date:'看得懂、见得到、不再白拿',
      changes:[
        '两种「平台」终于长得不一样：能穿的是**薄、冷、下缘化掉**的青色光片（下面什么都没有）；不能穿的是**厚、暖褐砖石**的楼板，底面实心、每 256px 一根支撑柱、两端还有侧壁 —— 看底面就知道能不能穿',
        '顺带修掉一个错位：平台视觉的顶面原来比碰撞面高 22px，人站上去总有一截「陷进」平台里。现在两种平台的顶面都精确落在碰撞面上（和地面同一口径）',
        '修复「影（附身）」飞出画面、远程也打不到、房间清不掉的卡关：它的垂直速度原来只在追击时写，而飞行怪没有重力，一旦飘高就再也回不来。现在非追击状态 vy 归零、每帧夹进可视区、连续 2 秒看不见就送回玩家附近（0.4 秒淡入），索敌纵向窗口也从 240 放宽到 320',
        '修复镜像房不复制远程攻击：写镜像怪名字时用错了基底，把「按玩家武器改成远程」的那份配置整份盖掉了 —— 玩远程英雄进镜像房，镜像怪只会贴脸挥砍',
        '修复轻盈之靴「体力上限 +30」不生效：上限只在建号时复制过一次，遗物改了常量却没同步到英雄身上（HUD 永远显示 100）',
        '新玩法改成「被安排着见到」：第 3 层固定塌陷、第 4 层固定守点、第 5 层固定限时，之后才进随机池',
        '机制房从「每 5 层保底 1 间」改成「第 3 层起每层保底 1 间」，且保底优先挑本层还没出现过的机制（不会再一层连着两间塌陷）',
        '断桥提前到第 3 层：2 层仍是 75/25（先学会「上层」），3~5 层 70/15/15 —— 原来要等到第 6 层才可能见到第一个坑',
        '四件遗物按英雄攻击方式换一整套（名字、描述、图标、效果全换，同一个存档格子）：追踪符↔觅隙、穿透之矢↔裂阵、重击↔坠星、连击大师↔连珠。近战版加「刃 / 斜线」元素，远程版加「弧 / 点」，外环颜色仍归流派',
        '新图标 4 张：觅隙（斜刃 + 刀尖）、裂阵（两列被斜劈切断）、坠星（竖落轨迹 + 落地溅射）、连珠（三点成串 + 速度弧）',
        '遗物集齐（27 件拿满）不再是「白扣诅咒」：池子抽干时，遗物奖励折成「金币 = 层数 × 12」+「回复 15% 生命」，画布上会说出来；裂隙的两个选项也会提前改写描述，不再写「获得 1 件遗物」却给钱',
        '修复部分已知问题'
      ]
    },
    {
      version:'2.9.3',
      date:'守住核心、断桥像桥',
      changes:[
        '守点房重做成「守住核心」：圈心立着一颗核心，尸潮从两侧涌入并**优先打核心**（被打中后 1.5 秒才转火你）。撑到袭击结束即算守住，**按核心剩余血量发奖** —— 不再是「站进圈里凑 8 秒」，站着不动也会看着核心碎',
        '核心有四档结果：≥80% 完美（金币 ×1.5 + 1 颗深渊魂晶）/ 50–79% 守住（×1.0，30% 魂晶）/ 1–49% 惨胜（×0.6）/ 碎裂（无奖励但**门照开**，绝不卡关）。守住后再回复 10% 生命',
        '「站圈」从目标变成护罩：站在圈内核心受伤减半；袭击后半段护罩缩小 20%，后期必须贴着核心打。圈也不再优先落在最高的平台上 —— 那是「站圈发呆」的根因',
        '三波尸潮按时间轴推进（0% / 25% / 50%），每波前 0.8 秒有预警：圈边闪三下、屏幕两侧裂纹、音效、居中提示。同屏上限只管「同屏」，超出的排队涌进来，上一波没清完下一波照刷',
        '挂机不作数：3 秒内没有任何输入就扣 1% 最大生命（不致死）并在头顶提示；原地攻击 / 喝药 / 放技能都不算挂机。核心碎裂时门照开、没有奖励，也不会弹三选一',
        '断桥终于像一座断桥：断面是锯齿状断口 + 露出的钢筋 + 断掉的木梁，缺口下方是深渊渐隐与上浮雾气，桥面每 256px 一道结构缝、落脚点有撞击裂纹。三段桥面还允许 ±32px 的落差',
        '断桥缺口宽度按层数分层：10 层以前 2 格（128，轻点跳即可）、11 层起 3 格（192，必须蓄力跳）、16 层以后还可能出现两处缺口 —— 原来所有层都是 128，同一道题从第 6 层做到第 99 层',
        '断桥三样加料：对岸固定一只远程怪（先点掉还是顶着火力跳）、缺口上方周期性落石（0.6 秒地面阴影预警，可闪）、缺口中央一块残板（站上去 0.8 秒就掉，既是中继点也是陷阱）',
        '预览页判据换成「开门时剩余段数」（主指标 3~5）+ 用时 10~25s + 多拿率 20~50% + 掉落率 10~30%，并删掉恒 0 的「被困率」。原来的「平均用时 20~35s」是误报 —— 钥匙固定投放，玩家拿满就走，用时跟塌陷压力基本无关',
        '新增验证台：测试/2.9.2核心与断桥.html（53 项）、测试/2.9.2场景验证台.html（hold / bridge 场景截图）、测试/2.9.2预览判据校准.html（自动跑 20 局套新判据）',
        '修复部分已知问题'
      ]
    },
    {
      version:'2.9.4',
      date:'先读懂房间，再亲手走出门',
      changes:[
        '守点房改为「走进护罩才启动」：没进圈前核心无敌、时间不走、波次不刷、怪只追玩家；第一次进圈同时开始计时与尸潮，之后跑出圈也不会暂停。新增 holdGate 回退开关',
        '守点刷怪改为层数曲线：普通基准第 3 层每波 5 只、第 15 层 15 只并封顶，难度只改乘数。地狱第 4 层从每波 15 / 同屏 10 降为每波 9 / 同屏 7，高层则逐步加重',
        '限时房新增贴屏倒计时与进度条：暖金 / 橙 / 红三档，最后 5 秒每秒脉动并滴答；入口新增燃烧 / 将尽 / 熄灭三态蜡烛，房间名直接写「限时房」',
        '守点房保持顺手节奏：守住核心后立刻结算并弹奖励，选完直接打开地图；传送门仍然亮着，关掉地图后还能走门兜底。普通 / 塌陷 / 限时 / 商店 / Boss 仍必须走到传送门才结算',
        '修复关闭地图会重复发清房奖励的问题；每间房只结算一次。settleAtDoor 关闭时全部房间退回「开门即结算」的实验模式',
        '更新守点 / 限时 / 过门验证，7 个回归页共 365 项断言通过；另用真实主界面验证守点房完成即弹奖励、选完自动开图，普通房 / 商店 / Boss 仍必须过门，且无重复结算'
      ]
    }
  ];
  
  // 渲染所有版本
  for (const item of changelogData) {
    const div = document.createElement('div');
    div.className = 'changelog-item';
    let html = `<span class="version">${item.version} - ${item.date}</span><ul>`;
    for (const change of item.changes) {
      html += `<li>${change}</li>`;
    }
    html += '</ul>';
    div.innerHTML = html;
    list.appendChild(div);
  }
  
  if (list.children.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);">📖 暂无更新日志</div>';
  }
}

function chooseHero(index) {
  const hero = heroOptions[index];
  if (!hero) return;
  state.hero = hero;
  state.player.name = hero.name;
  state.player.maxHp = hero.stats.hp;
  state.player.hp = hero.stats.hp;
  state.player.attack = hero.stats.attack;
  state.player.potions = hero.stats.potions;
  state.player.gold = hero.stats.gold;
  state.player.shield = 0;
  state.heroSkillUsed = false;
  state.heroSkillBonus = 0;
  state.heroPendingHeal = 0;
  state.bonuses = [];
  state.availableBonuses = getBonusChoices();
  state.mode = 'bonusSelect';
  if (hero.stats.dodge !== undefined) {
    state.dodgeLevel = hero.stats.dodge / 5;
  }
  addLog(`你选择了英雄：${hero.name}。${hero.description}`);
  render();
}

function chooseBonus(index) {
  let bonus = state.availableBonuses[index];
  if (!bonus) return;
  if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
    try {
      AbyssAudio.sfx('reward');
    } catch (error) {
      console.warn('[音效] 奖励音效播放失败:', error);
    }
  }
  if (typeof bonus.apply !== 'function') {
    getBonusChoices();
    const matched = (window.__ALL_BONUSES || []).find(
        b => b.id === bonus.id || b.title === bonus.title
    );
    if (matched) {
        bonus = matched;
        state.availableBonuses[index] = matched;
    } else {
        addLog(`⚠️ 增益"${bonus.title}"已失效，已重新抽取选项。`);
        state.availableBonuses = getBonusChoices();
        render();
        return;
    }
  }
  // ===== 2D 引擎门控（阶段3优化）=====
  // 选完增益紧接着 enterCurrentRoom()，之后画面就归 2D 了。
  // 引擎已就绪时 __确保2D引擎 会**同步**回调，走的就是下面原来那四行，行为不变；
  // 只有还没下完时才显示「正在启动 2D 实时战斗…」并等它 —— 不这么做的话，
  // 玩家会先落进文字界面、甚至在里面误操作，然后才被 2D 接管。
  var _继续进房 = function () {
    bonus.apply();
    state.bonuses.push(bonus);
    state.availableBonuses = [];
    addLog(`你获得了开局增益：${bonus.title}`);
    enterCurrentRoom();
  };
  if (window.__确保2D引擎) { window.__确保2D引擎(_继续进房); } else { _继续进房(); }
}

function updateRecords(isClear = false) {
    if (!state.records[state.difficulty]) {
        state.records[state.difficulty] = { bestFloor: 0, clears: 0, deaths: 0 };
    }
    const current = state.records[state.difficulty];
    if (state.floor > current.bestFloor) {
        current.bestFloor = state.floor;
    }
    if (isClear) { current.clears += 1; }
    else { current.deaths += 1; }
    saveRecordsToStorage();
}


function completeRun() {
  const current = state.records[state.difficulty];
  current.clears += 1;
  updateRecords(true);
}

// ===== 属性详情弹窗 =====
function openAttributeDetail(attrKey) {
  const modal = document.getElementById('attributeDetailModal');
  const title = document.getElementById('attributeDetailTitle');
  const content = document.getElementById('attributeDetailContent');
  
  if (!modal || !title || !content) return;
  
  const details = getAttributeDetails(attrKey);
  title.textContent = details.title;
  content.innerHTML = details.content;
  
  modal.classList.remove('hidden');
}

function closeAttributeDetail() {
  const modal = document.getElementById('attributeDetailModal');
  if (modal) modal.classList.add('hidden');
}

function getAttributeDetails(attrKey) {
  const p = state.player;
  const details = {
    '生命': {
      title: '生命',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">当前生命</span> <strong style="color:var(--danger);float:right;">${p.hp}</strong></div>
          <div><span style="color:var(--muted);">最大生命</span> <strong style="color:var(--text);float:right;">${p.maxHp}</strong></div>
          <div><span style="color:var(--muted);">生命比例</span> <strong style="color:${p.hp/p.maxHp > 0.3 ? 'var(--accent)' : 'var(--danger)'};float:right;">${Math.round(p.hp/p.maxHp*100)}%</strong></div>
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">生命值归零时游戏结束。可通过治疗药水、休息、遗物等方式恢复。</div>
        </div>
      `
    },
    '攻击': {
      title: '攻击',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">基础攻击</span> <strong style="color:var(--text);float:right;">${p.attack}</strong></div>
          ${state.pendingAttackBoost > 0 ? `<div><span style="color:var(--muted);">力量药水加成</span> <strong style="color:#f7b731;float:right;">+${state.pendingAttackBoost}</strong></div>` : ''}
          ${state.heroSkillBonus > 0 ? `<div><span style="color:var(--muted);">技能加成</span> <strong style="color:#ff6bff;float:right;">+${state.heroSkillBonus}</strong></div>` : ''}
          ${state.hasKillScythe ? `<div><span style="color:var(--muted);">斩杀之镰</span> <strong style="color:#ff6b6b;float:right;">已装备</strong></div>` : ''}
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">攻击力影响每次普通攻击的伤害。可通过升级、遗物、药水等方式提升。</div>
        </div>
      `
    },
    '护盾': {
      title: '护盾',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">当前护盾</span> <strong style="color:#6fc3ff;float:right;">${p.shield}</strong></div>
          <div><span style="color:var(--muted);">生命护盾</span> <strong style="color:${state.hasLifeShield ? '#73f0b4' : '#666'};float:right;">${state.hasLifeShield ? '✅ 每回合+2' : '❌ 未拥有'}</strong></div>
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">护盾可抵消敌人造成的伤害。每回合结束时，护盾不会自动恢复（除非有生命护盾）。</div>
        </div>
      `
    },
    '金币': {
      title: '金币',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">当前金币</span> <strong style="color:#f7b731;float:right;">${p.gold}</strong></div>
          <div><span style="color:var(--muted);">双倍金币</span> <strong style="color:${state.hasDoubleGold ? '#f7b731' : '#666'};float:right;">${state.hasDoubleGold ? '✅ 战斗金币+50%' : '❌ 未拥有'}</strong></div>
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">金币可在商店购买道具，也是部分结局的解锁条件。</div>
        </div>
      `
    },
    '药水': {
      title: '治疗药水',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">治疗药水</span> <strong style="color:#73f0b4;float:right;">${p.potions} 瓶</strong></div>
          <div><span style="color:var(--muted);">力量药水</span> <strong style="color:#ff6b6b;float:right;">${p.strengthPotions} 瓶</strong></div>
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">治疗药水：战斗中恢复 8 点生命。力量药水：Boss战前使用，下一攻击 +3。</div>
        </div>
      `
    },
    '暴击率': {
      title: '暴击率',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">暴击率</span> <strong style="color:#ff6b6b;float:right;">${Math.min((state.luckyLevel||0)*10, 100).toFixed(0)}%</strong></div>
          <div><span style="color:var(--muted);">暴击伤害</span> <strong style="color:#ff6b6b;float:right;">${state.critDamage||150}%</strong></div>
          <div><span style="color:var(--muted);">本场暴击次数</span> <strong style="color:#f7b731;float:right;">${state.critCount||0} 次</strong></div>
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">暴击时造成 ${state.critDamage||150}% 伤害。暴击率上限 100%。</div>
        </div>
      `
    },
    '暴击伤害': {
      title: '暴击伤害',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">暴击伤害</span> <strong style="color:#ff6b6b;float:right;">${state.critDamage||150}%</strong></div>
          <div><span style="color:var(--muted);">暴击率</span> <strong style="color:#ff6b6b;float:right;">${Math.min((state.luckyLevel||0)*10, 100).toFixed(0)}%</strong></div>
          <div><span style="color:var(--muted);">本场暴击次数</span> <strong style="color:#f7b731;float:right;">${state.critCount||0} 次</strong></div>
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">暴击时额外造成 ${(state.critDamage||150)-100}% 伤害。</div>
        </div>
      `
    },
    '荆棘': {
      title: '荆棘',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">荆棘等级</span> <strong style="color:#6fc3ff;float:right;">${state.thornLevel||0}</strong></div>
          <div><span style="color:var(--muted);">反弹伤害</span> <strong style="color:#6fc3ff;float:right;">${state.thornLevel||0} 点/次</strong></div>
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">受到敌人攻击时，反弹 ${state.thornLevel||0} 点伤害给敌人。</div>
        </div>
      `
    },
    '吸血': {
      title: '吸血',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">吸血等级</span> <strong style="color:#ff6b6b;float:right;">${state.vampireLevel||0}</strong></div>
          <div><span style="color:var(--muted);">每次攻击恢复</span> <strong style="color:#ff6b6b;float:right;">${state.vampireLevel||0} 点</strong></div>
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">每次攻击命中敌人时，恢复 ${state.vampireLevel||0} 点生命。</div>
        </div>
      `
    },
    '闪避': {
      title: '闪避',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">闪避率</span> <strong style="color:#6fc3ff;float:right;">${Math.min((state.dodgeLevel||0)*5, 50).toFixed(0)}%</strong></div>
          <div><span style="color:var(--muted);">本场闪避次数</span> <strong style="color:#f7b731;float:right;">${state.dodgeCount||0} 次</strong></div>
          <div><span style="color:var(--muted);">闪避上限</span> <strong style="color:var(--muted);float:right;">50%</strong></div>
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">闪避敌人攻击时，完全免疫该次伤害。闪避率上限 50%。</div>
        </div>
      `
    },
    '连击': {
      title: '连击',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">连击率</span> <strong style="color:#f7b731;float:right;">${Math.min((state.comboLevel||0)*5, 40).toFixed(0)}%</strong></div>
          <div><span style="color:var(--muted);">连击伤害</span> <strong style="color:#f7b731;float:right;">${(50 + (state.comboDamageBonus||0))}%</strong></div>
          <div><span style="color:var(--muted);">本场连击次数</span> <strong style="color:#f7b731;float:right;">${state.comboCount||0} 次</strong></div>
          ${state.hasFirstAttackCombo ? `<div><span style="color:var(--muted);">双刃匕首</span> <strong style="color:#ff6bff;float:right;">✅ 首次攻击必连击</strong></div>` : ''}
          <div><span style="color:var(--muted);">连击上限</span> <strong style="color:var(--muted);float:right;">40%</strong></div>
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">连击时额外造成 ${(50 + (state.comboDamageBonus||0))}% 伤害。连击率上限 40%。</div>
        </div>
      `
    },
    '斩杀': {
      title: '斩杀',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">斩杀率</span> <strong style="color:#ff3b3b;float:right;">${Math.min((state.executeLevel||0)*5, 40).toFixed(0)}%</strong></div>
          <div><span style="color:var(--muted);">斩杀线</span> <strong style="color:#ff3b3b;float:right;">${Math.round((state.executeThreshold||0.3)*100)}%</strong></div>
          <div><span style="color:var(--muted);">本场斩杀次数</span> <strong style="color:#f7b731;float:right;">${state.executeCount||0} 次</strong></div>
          ${state.hasKillScythe ? `<div><span style="color:var(--muted);">斩杀之镰</span> <strong style="color:#ff6b6b;float:right;">✅ 斩杀+1攻击</strong></div>` : ''}
          <div><span style="color:var(--muted);">斩杀上限</span> <strong style="color:var(--muted);float:right;">40%</strong></div>
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">当敌人生命低于 ${Math.round((state.executeThreshold||0.3)*100)}% 时，斩杀成功直接秒杀。斩杀率上限 40%。</div>
        </div>
      `
    },
    '英雄技能': {
      title: '英雄技能',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">英雄</span> <strong style="color:var(--text);float:right;">${state.hero?.name || '未选择'}</strong></div>
          <div><span style="color:var(--muted);">被动技能</span> <strong style="color:var(--accent);float:right;">${state.hero?.skill?.name || '无'}</strong></div>
          <div style="font-size:0.85rem;color:var(--muted);">${state.hero?.skill?.description || '选择英雄后解锁被动技能'}</div>
          ${state.hero?.skill?.active ? `
            <hr style="border-color:rgba(255,255,255,0.06);">
            <div><span style="color:var(--muted);">主动技能</span> <strong style="color:#ff6bff;float:right;">${state.hero.skill.active.name}</strong></div>
            <div style="font-size:0.85rem;color:var(--muted);">${state.hero.skill.active.description}</div>
            <div><span style="color:var(--muted);">本场已使用</span> <strong style="color:${state.heroSkillUsed ? '#ff6b6b' : '#73f0b4'};float:right;">${state.heroSkillUsed ? '✅ 已使用' : '❌ 未使用'}</strong></div>
          ` : ''}
        </div>
      `
    },
    '生命护盾': {
      title: '生命护盾',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">状态</span> <strong style="color:${state.hasLifeShield ? '#73f0b4' : '#666'};float:right;">${state.hasLifeShield ? '✅ 已激活' : '❌ 未拥有'}</strong></div>
          ${state.hasLifeShield ? `<div><span style="color:var(--muted);">效果</span> <strong style="color:#73f0b4;float:right;">每回合 +2 护盾</strong></div>` : ''}
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">每回合结束时自动获得 2 点护盾。可通过开局增益或作弊获取。</div>
        </div>
      `
    },
    '双倍金币': {
      title: '双倍金币',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">状态</span> <strong style="color:${state.hasDoubleGold ? '#f7b731' : '#666'};float:right;">${state.hasDoubleGold ? '✅ 已激活' : '❌ 未拥有'}</strong></div>
          ${state.hasDoubleGold ? `<div><span style="color:var(--muted);">效果</span> <strong style="color:#f7b731;float:right;">战斗金币 +50%</strong></div>` : ''}
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">战斗胜利时获得的金币增加 50%。可通过开局增益或作弊获取。</div>
        </div>
      `
    },
    '古神眷顾': {
      title: '古神眷顾',
      content: `
        <div style="display:grid;gap:8px;">
          <div><span style="color:var(--muted);">状态</span> <strong style="color:${state.hasAncientBless ? '#ff6bff' : '#666'};float:right;">${state.hasAncientBless ? '✅ 已激活' : '❌ 未拥有'}</strong></div>
          ${state.hasAncientBless ? `
            <div><span style="color:var(--muted);">效果1</span> <strong style="color:#73f0b4;float:right;">祭坛 25% 不扣血</strong></div>
            <div><span style="color:var(--muted);">效果2</span> <strong style="color:#f7b731;float:right;">15% 双倍遗物</strong></div>
            <div><span style="color:var(--muted);">效果3</span> <strong style="color:#ff6b6b;float:right;">1% 四倍遗物</strong></div>
          ` : ''}
          <hr style="border-color:rgba(255,255,255,0.06);">
          <div style="font-size:0.85rem;color:var(--muted);">古老祭坛事件中获得特殊加成。可通过开局增益或作弊获取。</div>
        </div>
      `
    }
  };
  
  // 默认详情
  const defaultDetail = {
    title: '属性详情',
    content: `
      <div style="color:var(--muted);text-align:center;padding:20px 0;">
        点击属性名称查看详细信息
      </div>
    `
  };
  
  return details[attrKey] || defaultDetail;
}

/* ============================================================
   经典 2D 宿主（经典2D.js）可用的内核窄接口
   ------------------------------------------------------------
   为什么需要这一层：顶层 const/let **不会**挂到 window（difficultyModifiers /
   ENVIRONMENT_EFFECTS / CUSTOM_DIFFICULTY_HELP 全是 const），宿主直接摸全局会拿到
   undefined，而且这种失败是**静默**的。这里把宿主真正需要的东西显式导出，顺带把
   "哪些算稳定契约"钉下来。改动本块前先看 经典2D.js 的调用点。
   ============================================================ */
window.经典2D内核 = {
  state: function () { return state; },
  difficultyModifiers: function () { return difficultyModifiers; },
  heroOptions: function () { return heroOptions; },
  generateFloorRooms: generateFloorRooms,
  generateEnvironmentEffect: generateEnvironmentEffect,
  formatEnvDescription: formatEnvDescription,
  rebuildEnvironmentFromTemplate: rebuildEnvironmentFromTemplate,
  buildRewardOptions: buildRewardOptions,
  buildShopOptions: buildShopOptions,
  getShopItemCost: getShopItemCost,
  getRandomEvent: getRandomEvent,
  getEndOptions: getEndOptions,
  getRandomRelicByRarity: getRandomRelicByRarity,
  // 选英雄 / 选增益（把这两个界面搬进 2D 画布后，由宿主调用）
  chooseHero: chooseHero,
  chooseBonus: chooseBonus,
  getBonusChoices: getBonusChoices,
  getRelicOptions: getRelicOptions,
  countRelic: countRelic,
  normalizeCustomDifficulty: normalizeCustomDifficulty,
  addLog: addLog,
  showToast: showToast,
  spawnDamageFloat: spawnDamageFloat,
  addPotion: addPotion,
  saveGame: saveGame,
  updateRecords: updateRecords,

  /* ---- 图鉴数据（2.7.4：把画内图鉴从 6 类补到 10 类，与文字界面图鉴对齐）----
     全部现算、只读，不复制一份常量 —— 图鉴因此不可能和实现漂移。 */
  shopCatalog: function () {
    return SHOP_ITEMS_COMMON.concat(SHOP_ITEMS_RARE).map(function (it) {
      return { label: it.label, cost: it.cost, rarity: it.rarity, desc: it.desc || '' };
    });
  },
  bonusPool: function () {
    // 全量池（getBonusChoices 是"随机抽 3 个"，图鉴要的是全部）
    return BONUS_POOL.map(function (b) { return { title: b.title, description: b.description }; });
  },
  eventPool: function () {
    return ALL_EVENT_OPTIONS.map(function (e) { return { label: e.label, description: e.description || '' }; });
  }
};

function render() {
  // ===== 经典 2D 实时模式（经典2D.js）=====
  // 必须留在函数体最前面：scheduleRender 会在商店/事件路径高频调用 render。
  // 宿主返回 true = 本次 DOM 渲染由它接管（画布全屏盖在上面）；
  // 返回 false = 未接管（选英雄/选增益/死亡结算/引擎不可用回退）→ 照常走下面的回合制渲染。
  // 想临时关掉 2D：URL 加 ?classic2d=0，或 localStorage.abyss27_classic2d = '0'
  if (window.经典2D && window.经典2D.render()) return;
  // ===== BGM 场景同步（跟随游戏模式切换战斗/探索音乐） =====
  if (window.AbyssAudio && typeof window.AbyssAudio.syncScene === 'function') {
    try {
      AbyssAudio.syncScene(state);
    } catch (error) {
      console.warn('[音效] 场景同步失败:', error);
    }
  }
  updateLowHpFog();

  // ===== 环境显示更新 =====
  const envEl = document.getElementById('floorEnvironment');
  if (envEl) {
    if (state.environment) {
      // 移动端显示简短版本，完整描述放在 title 中
      const isMobile = window.innerWidth <= 768;
      const display = state.environment.displayValue ? ` (${state.environment.displayValue})` : '';
      // 移动端截断过长的环境名称
      let envName = state.environment.name;
      if (isMobile && envName.length > 6) {
        envName = envName.slice(0, 6) + '…';
      }
      envEl.textContent = `环境：${envName}${display}`;
      envEl.title = formatEnvDescription(state.environment) + (state.environment.displayValue ? ` (当前值：${state.environment.displayValue})` : '');
      envEl.style.display = 'inline-block';
      envEl.style.visibility = 'visible';
      envEl.style.opacity = '1';
    } else {
      envEl.textContent = '';
      envEl.style.display = '';
    }
  }

  // ===== 隐藏试炼信息条（确保非试炼模式下不显示） =====
  const trialInfo = document.getElementById('trialInfo');
  if (trialInfo) trialInfo.style.display = 'none';

  const trialBtn = document.getElementById('trialButton');
  if (trialBtn) {
    trialBtn.style.display = 'inline-block';
    // 入口常驻展示最深记录 —— 让试炼在经典模式里始终「有存在感」，
    // 而不是一个点进去就与主线无关的按钮
    if (typeof renderTrialEntryInfo === 'function') renderTrialEntryInfo();
  }
  const p = state.player;
  const actionArea = refs.actionArea || document.getElementById('actionArea');

  // ===== 同步模式切换按钮状态 =====
  if (refs.modeToggle) {
    refs.modeToggle.textContent = state.detailMode ? '详情模式' : '正常模式';
    refs.modeToggle.style.borderColor = state.detailMode ? 'var(--danger)' : 'var(--accent)';
  }

  refs.playerName.textContent = p.name;
  refs.playerHp.textContent = `${p.hp} / ${p.maxHp}`;
  if (p.hp <= p.maxHp * 0.3) {
    refs.playerHp.classList.add('low');
  } else {
    refs.playerHp.classList.remove('low');
  }
  const attackBonusParts = [];
  if (state.pendingAttackBoost > 0) attackBonusParts.push(`力量 +${state.pendingAttackBoost}`);
  if (state.heroSkillBonus > 0) attackBonusParts.push(`技能 +${state.heroSkillBonus}`);
  refs.playerAttack.textContent = attackBonusParts.length > 0
    ? `${p.attack} (${attackBonusParts.join('，')} 下一次)`
    : p.attack;
  refs.playerShield.textContent = p.shield;
  refs.playerGold.textContent = p.gold;
  refs.playerPotions.textContent = `治疗 ${p.potions}，力量 ${p.strengthPotions}`;
  document.querySelectorAll('#heroSkillStatus').forEach(el => {
    let skillText = state.hero?.skill?.name || '无';
    if (state.hero?.skill?.active) {
        skillText += ` | 主动: ${state.hero.skill.active.name}`;
    }
    el.textContent = skillText;
  });

  // 暴击率（含环境加成）
  const luckyText = document.getElementById('playerLucky');
  if (luckyText) {
    const baseLucky = (state.luckyLevel || 0) * 10;
    const bonusLucky = state.player.luckyBonus || 0;
    const chance = Math.min(baseLucky + bonusLucky, 100);
    luckyText.textContent = `${chance}%`;
    if (chance >= 100) {
      luckyText.style.color = '#f7b731';
      luckyText.style.textShadow = '0 0 20px rgba(247,183,49,0.3)';
    } else {
      luckyText.style.color = '';
      luckyText.style.textShadow = '';
    }
  }

  // 暴击伤害（含环境加成）
  const critDamageText = document.getElementById('playerCritDamage');
  if (critDamageText) {
    const baseCrit = state.critDamage || 150;
    const bonusCrit = state.player.critDamageBonus || 0;
    critDamageText.textContent = `${baseCrit + bonusCrit}%`;
  }

  // 荆棘（含环境加成）
  const thornText = document.getElementById('playerThorn');
  if (thornText) {
    const baseThorn = state.thornLevel || 0;
    const bonusThorn = state.player.thornBonus || 0;
    thornText.textContent = baseThorn + bonusThorn;
  }

  // 吸血（含环境加成）
  const vampireText = document.getElementById('playerVampire');
  if (vampireText) {
    const baseVampire = state.vampireLevel || 0;
    const bonusVampire = state.player.vampireBonus || 0;
    vampireText.textContent = baseVampire + bonusVampire;
  }

  document.querySelectorAll('#lifeShieldStatus').forEach(el => {
    el.textContent = state.hasLifeShield ? '✅ 已拥有' : '❌ 未拥有';
    el.style.color = state.hasLifeShield ? '#73f0b4' : '#666';
  });

  document.querySelectorAll('#doubleGoldStatus').forEach(el => {
    el.textContent = state.hasDoubleGold ? '✅ 已拥有' : '❌ 未拥有';
    el.style.color = state.hasDoubleGold ? '#f7b731' : '#666';
  });

  document.querySelectorAll('#ancientBlessStatus').forEach(el => {
    el.textContent = state.hasAncientBless ? '✅ 已拥有' : '❌ 未拥有';
    el.style.color = state.hasAncientBless ? '#ff6bff' : '#666';
  });

  // 闪避（含环境加成）
  const dodgeText = document.getElementById('playerDodge');
  if (dodgeText) {
    const baseDodge = (state.dodgeLevel || 0) * 5;
    const bonusDodge = state.player.dodgeBonus || 0;
    const chance = Math.min(baseDodge + bonusDodge, 50);
    dodgeText.textContent = `${chance}%`;
    if (chance >= 50) {
      dodgeText.style.color = '#f7b731';
      dodgeText.style.textShadow = '0 0 20px rgba(247,183,49,0.3)';
    } else {
      dodgeText.style.color = '';
      dodgeText.style.textShadow = '';
    }
  }

  // 连击（含环境加成）
  const comboText = document.getElementById('playerCombo');
  if (comboText) {
    const baseCombo = (state.comboLevel || 0) * 5;
    const bonusCombo = state.player.comboBonus || 0;
    const chance = Math.min(baseCombo + bonusCombo, 40);
    comboText.textContent = `${chance}%`;
    if (chance >= 40) {
      comboText.style.color = '#f7b731';
      comboText.style.textShadow = '0 0 20px rgba(247,183,49,0.3)';
    } else {
      comboText.style.color = '';
      comboText.style.textShadow = '';
    }
  }

  // 斩杀（暂不包含环境加成，但保留）
  const executeText = document.getElementById('playerExecute');
  if (executeText) {
    const chance = Math.min((state.executeLevel || 0) * 5, 40);
    executeText.textContent = `${chance}%`;
    if (chance >= 40) {
      executeText.style.color = '#ff6b6b';
      executeText.style.textShadow = '0 0 20px rgba(255,107,107,0.3)';
    } else {
      executeText.style.color = '';
      executeText.style.textShadow = '';
    }
  }

  if (refs.difficultySelect) {
    refs.difficultySelect.value = state.difficulty;
  }

  refs.floorLabel.textContent = `第 ${state.floor} 层 · ${state.roomIndex + 1}/${state.rooms.length} 间`;
  refs.roomProgress.textContent = `已抵达：${state.roomIndex} / ${state.rooms.length - 1}`;
  refs.roomList.innerHTML = '';
  renderRelics();
  state.rooms.forEach((room, index) => {
    const badge = document.createElement('div');
    badge.className = `room-badge${index === state.roomIndex ? ' current' : ''}`;
    badge.textContent = `${index + 1}. ${roomTypeNames[room.type]}`;
    refs.roomList.appendChild(badge);
  });

  renderBonusAndStats();
  const room = state.currentRoom;

  // ===== 游戏结束 =====
  if (state.mode === 'gameover') {
    refs.eventTitle.textContent = '战斗失败';
    refs.eventText.textContent = '你被深渊吞没，再试一次吧。';
    if (actionArea) {
      actionArea.innerHTML = '<button class="action-button danger" data-action="restart">重新开始</button>';
    }
    updateLowHpFog();
    return;
  }

  // ===== Boss 准备 =====
  if (state.mode === 'bossPrep' && state.currentRoom) {
    refs.eventTitle.textContent = `层主 ${state.floor}`;
    refs.eventText.textContent = `此刻你站在 Boss 之前，可以选择使用力量药水，效果仅持续下一回合。当前力量药水：${state.player.strengthPotions}`;
    if (actionArea) {
      actionArea.innerHTML = '';
    }
    const canUseStrength = state.player.strengthPotions > 0 && state.pendingAttackBoost === 0;
    const strengthButton = document.createElement('button');
    strengthButton.className = 'action-button';
    strengthButton.textContent = '使用力量药水';
    strengthButton.dataset.action = 'strength-potion';
    if (!canUseStrength) {
      strengthButton.disabled = true;
      strengthButton.title = state.pendingAttackBoost > 0 ? '力量药水已准备，无法再次使用。' : '你没有力量药水可使用。';
    }
    if (actionArea) {
      actionArea.appendChild(strengthButton);
    }
    const startButton = document.createElement('button');
    startButton.className = 'action-button secondary';
    startButton.textContent = state.pendingAttackBoost > 0 ? '开始战斗（已准备）' : '开始战斗';
    startButton.dataset.action = 'boss-fight';
    if (actionArea) {
      actionArea.appendChild(startButton);
    }
    updateLowHpFog();
    return;
  }

  // ===== 战斗模式（新增/修正） =====
  if (state.mode === 'combat' && state.combat) {
    const enemy = state.combat.enemy;
    refs.eventTitle.textContent = enemy.name;

    // 计算敌人实际属性（基础 + 环境加成），显示时统一四舍五入为整数
    const actualCritDamage = Math.round((enemy.critDamage || 150) + (enemy.critDamageBonus || 0));
    const displayThorn = Math.round((enemy.thorn || 0) + (enemy.thornBonus || 0));
    const displayDodge = Math.round((enemy.dodge || 0) + (enemy.dodgeBonus || 0));
    const displayVampire = Math.round((enemy.vampire || 0) + (enemy.vampireBonus || 0));
    const displayCombo = Math.round((enemy.combo || 0) + (enemy.comboBonus || 0));
    const displayCrit = Math.round((enemy.crit || 0) + (enemy.critBonus || 0));
    const displayArmor = Math.round((enemy.armor || 0) + (enemy.armorBonus || 0));

    let enemyStatsText = `生命 ${Math.round(enemy.hp)} · 攻击 ${Math.round(enemy.attack)}`;
    if (displayThorn > 0) enemyStatsText += ` · 荆棘 ${displayThorn}`;
    if (displayDodge > 0) enemyStatsText += ` · 闪避 ${displayDodge}%`;
    if (displayVampire > 0) enemyStatsText += ` · 吸血 ${displayVampire}`;
    if (displayCombo > 0) enemyStatsText += ` · 连击 ${displayCombo}%`;
    if (displayCrit > 0) enemyStatsText += ` · 暴击 ${displayCrit}% (${actualCritDamage}%)`;
    if (displayArmor > 0) enemyStatsText += ` · 减伤 ${displayArmor}%`;

    // 玩家战斗统计
    const statText = `⚔️ 暴击 ${state.critCount||0}次 · ⚡ 连击 ${state.comboCount||0}次 · 💨 闪避 ${state.dodgeCount||0}次`;
    refs.eventText.innerHTML = `${enemyStatsText}<br><span style="color:var(--muted);font-size:0.85rem;">${statText}</span>`;

    // 技能函数可能在存档 / 快照 / 试炼备份里被 JSON 序列化丢掉：这里顺手接回来。
    // 不接的话按钮会因为「没有 execute」而根本不生成 —— 玩家连点都点不到，
    // 那比「点了没反应」更难排查。只在真的缺函数时才调用，平时零开销。
    if (state.hero && state.hero.id && state.hero.skill && state.hero.skill.active &&
        typeof state.hero.skill.active.execute !== 'function') {
      restoreHeroSkillBinding(state.hero);
    }

    // 生成操作按钮
    if (actionArea) {
      actionArea.innerHTML = '';
    }
    const buttons = [
      { label: '攻击', action: 'attack', className: 'action-button' },
      { label: '防御', action: 'defend', className: 'action-button secondary' },
      { label: '治疗药水', action: 'potion', className: 'action-button' }
    ];
    // 条件里带上 execute：只有 active 对象、没有函数时，按钮就是个点了没反应的死按钮
    if (state.hero?.skill?.active && typeof state.hero.skill.active.execute === 'function' && !state.heroSkillUsed) {
      buttons.splice(1, 0, {
        label: state.hero.skill.active.name,
        action: 'hero-skill',
        className: 'action-button warning',
        title: state.hero.skill.active.description
      });
    }
    buttons.forEach(btn => {
      const button = document.createElement('button');
      button.className = btn.className;
      button.textContent = btn.label;
      button.dataset.action = btn.action;
      if (btn.title) {
        button.title = btn.title;
      }
      if (actionArea) {
        actionArea.appendChild(button);
      }
    });
    updateLowHpFog();
    return;
  }

  // ===== 休整点 =====
  if (state.mode === 'rest') {
    refs.eventTitle.textContent = '休整点';
    refs.eventText.textContent = '你可以使用治疗药水恢复生命，或继续前进。';
    if (actionArea) {
      actionArea.innerHTML = '';
    }
    if (state.player.potions > 0) {
      const usePotionBtn = document.createElement('button');
      usePotionBtn.className = 'action-button';
      usePotionBtn.textContent = '使用治疗药水';
      usePotionBtn.dataset.action = 'rest-use-potion';
      actionArea.appendChild(usePotionBtn);
    }
    const continueBtn = document.createElement('button');
    continueBtn.className = 'action-button secondary';
    continueBtn.textContent = '继续前进';
    continueBtn.dataset.action = 'rest-continue';
    actionArea.appendChild(continueBtn);
    return;
  }

  // ===== 随机事件选择 =====
  if (state.mode === 'eventChoice') {
    refs.eventTitle.textContent = '随机事件';
    refs.eventText.textContent = '选择一项结果，事件结束后继续前进。';
    if (actionArea) {
      actionArea.innerHTML = '';
    }
    state.eventOptions.forEach((option, index) => {
      const button = document.createElement('button');
      button.className = 'action-button';
      button.textContent = `${option.label}`;
      button.title = option.description;
      button.dataset.action = `event-${index}`;
      if (actionArea) {
        actionArea.appendChild(button);
      }
    });
    return;
  }

  // ===== 奖励选择 =====
  if (state.mode === 'reward') {
    refs.eventTitle.textContent = '选择奖励';
    refs.eventText.textContent = '从以下奖励中挑选一个，继续向前推进。';
    if (actionArea) {
      actionArea.innerHTML = '';
    }
    state.rewardOptions.forEach((option, index) => {
      const button = document.createElement('button');
      button.className = 'action-button';
      button.textContent = option.label;
      button.dataset.action = `reward-${index}`;
      if (actionArea) {
        actionArea.appendChild(button);
      }
    });
    return;
  }

  // ===== Boss 胜利 =====
  if (state.mode === 'bossVictory') {
    refs.eventTitle.textContent = 'Boss 胜利';
    refs.eventText.textContent = '你击败了Boss，可先选择一个奖励，之后再选择是否结束冒险。';
    if (actionArea) {
      actionArea.innerHTML = '';
    }
    if (state.rewardOptions.length > 0) {
      state.rewardOptions.forEach((option, index) => {
        const button = document.createElement('button');
        button.className = 'action-button';
        button.textContent = option.label;
        button.dataset.action = `reward-${index}`;
        if (actionArea) {
          actionArea.appendChild(button);
        }
      });
    }
    const continueButton = document.createElement('button');
    continueButton.className = 'action-button secondary';
    continueButton.textContent = '继续冒险';
    continueButton.dataset.action = 'continue-adventure';
    if (actionArea) {
      actionArea.appendChild(continueButton);
    }
    state.endOptions.forEach((option, index) => {
      const button = document.createElement('button');
      button.className = 'action-button secondary';
      button.textContent = option.title;
      button.title = option.description;
      button.dataset.action = `end-${index}`;
      if (actionArea) {
        actionArea.appendChild(button);
      }
    });
    return;
  }

  // ===== 通关选择 =====
  if (state.mode === 'victoryChoice') {
    refs.eventTitle.textContent = '通关选择';
    refs.eventText.textContent = '你可以选择结束冒险，或继续闯荡更深的深渊。';
    if (actionArea) {
      actionArea.innerHTML = '';
    }
    state.endOptions.forEach((option, index) => {
      const button = document.createElement('button');
      button.className = 'action-button';
      button.textContent = option.title;
      button.title = option.description;
      button.dataset.action = `end-${index}`;
      if (actionArea) {
        actionArea.appendChild(button);
      }
    });
    const continueButton = document.createElement('button');
    continueButton.className = 'action-button secondary';
    continueButton.textContent = '继续冒险';
    continueButton.dataset.action = 'continue-adventure';
    if (actionArea) {
      actionArea.appendChild(continueButton);
    }
    return;
  }

  // ===== 结局展示 =====
  if (state.mode === 'finished' && state.endResult) {
    refs.eventTitle.textContent = `结局：${state.endResult.title}`;
    refs.eventText.textContent = state.endResult.description;
    if (actionArea) {
      actionArea.innerHTML = '';
      const continueButton = document.createElement('button');
      continueButton.className = 'action-button secondary';
      continueButton.textContent = '继续冒险';
      continueButton.dataset.action = 'continue-adventure';
      actionArea.appendChild(continueButton);

      const restartButton = document.createElement('button');
      restartButton.className = 'action-button';
      restartButton.textContent = '重新开始';
      restartButton.dataset.action = 'restart';
      actionArea.appendChild(restartButton);
    }
    return;
  }

  // ===== 选择英雄 =====
  if (state.mode === 'heroSelect') {
    refs.eventTitle.textContent = '选择英雄';
    // 英雄数量按 heroOptions 实数走：这里原来写死“十一位”，早就和实际对不上了
    refs.eventText.textContent = `从 ${heroOptions.length} 位英雄中选择一位，每个英雄拥有专属属性与技能。` +
      '选完英雄和增益后才能进入实时战斗哦。';
    if (actionArea) {
      actionArea.innerHTML = '';
    }
    heroOptions.forEach((hero, index) => {
      const button = document.createElement('button');
      button.className = 'action-button';
      button.textContent = `${hero.name}`;
      button.title = `${hero.description} 技能：${hero.skill.name} - ${hero.skill.description}` +
        (hero.skill.active ? `\n主动技能：${hero.skill.active.name} - ${hero.skill.active.description}` : '');
      button.dataset.action = 'choose-hero';
      button.dataset.index = String(index);
      if (actionArea) {
        actionArea.appendChild(button);
      }
    });
    return;
  }

  // ===== 商店 =====
  if (state.mode === 'shop') {
    refs.eventTitle.textContent = '商店';

    let totalRemaining = 0;
    state.shopOptions.forEach(option => {
      const count = state.shopPurchaseCount?.[option.label] || 0;
      const max = option.maxPurchase || (option.rarity === 'rare' ? 5 : 20);
      totalRemaining += max - count;
    });

    refs.eventText.textContent = `${state.player.gold} 金币 | ${state.player.xp || 0} 经验。商店中还有 ${totalRemaining} 件商品可购买。`;

    if (actionArea) {
      actionArea.innerHTML = '';
    }
    state.shopOptions.forEach((option, index) => {
      const goldCost = getShopItemCost(option);
      const expCost = option.expCost || option.cost;
      const count = state.shopPurchaseCount?.[option.label] || 0;
      const max = option.maxPurchase || (option.rarity === 'rare' ? 5 : 20);
      const remaining = max - count;

      const canBuyGold = state.player.gold >= goldCost;
      const canBuyExp = state.player.xp >= expCost;
      const canBuy = canBuyGold || canBuyExp;

      const button = document.createElement('button');
      button.className = `action-button${option.rarity === 'rare' ? ' rare' : ''}`;
      let priceDisplay = '';
      if (goldCost === 0) {
        priceDisplay = '免费';
      } else if (canBuyGold) {
        priceDisplay = `💰${goldCost}`;
      } else if (canBuyExp) {
        priceDisplay = `⭐${expCost}`;
      } else {
        priceDisplay = `💰${goldCost}/⭐${expCost}`;
      }
      button.textContent = `${option.label} (${priceDisplay}) ${remaining > 0 ? `[剩余${remaining}次]` : '[已售罄]'}`;
      if (remaining <= 0 || !canBuy) {
        button.disabled = true;
        button.style.opacity = '0.4';
      }
      button.dataset.action = `shop-${index}`;
      if (actionArea) {
        actionArea.appendChild(button);
      }
    });
    const skipButton = document.createElement('button');
    skipButton.className = 'action-button secondary';
    skipButton.textContent = '离开商店';
    skipButton.dataset.action = 'skip-shop';
    if (actionArea) {
      actionArea.appendChild(skipButton);
    }
    return;
  }

  // ===== 开局增益选择 =====
  if (state.mode === 'bonusSelect') {
    refs.eventTitle.textContent = '选择开局增益';
    refs.eventText.textContent = '从三种开局增益中选择一个。选完这一项就进入实时战斗哦。';
    if (actionArea) {
      actionArea.innerHTML = '';
    }
    state.availableBonuses.forEach((bonus, index) => {
      const button = document.createElement('button');
      button.className = 'action-button';
      button.textContent = bonus.title;
      button.title = bonus.description;
      button.dataset.action = 'choose-bonus';
      button.dataset.index = String(index);
      if (actionArea) {
        actionArea.appendChild(button);
      }
    });
    return;
  }

  // ===== 普通事件房间（如宝箱、精英等） =====
  if (room) {
    refs.eventTitle.textContent = `${roomTypeNames[room.type]} · 第 ${state.floor} 层`;
    refs.eventText.textContent = getRoomDescription(room);
    if (actionArea) {
      actionArea.innerHTML = '';
    }
    if (state.mode === 'event') {
      const button = document.createElement('button');
      button.className = 'action-button';
      button.textContent = room.type === 'shop' ? '浏览商店' : '继续前进';
      button.dataset.action = 'resolve';
      if (actionArea) {
        actionArea.appendChild(button);
      }
    }
  }

  // 经验值显示
  const xpText = document.getElementById('playerXp');
  if (xpText) {
    xpText.textContent = state.player.xp || 0;
  }

  renderBonusAndStats();
  renderLog();
  updateLowHpFog();

  // ===== 自动保存 =====
  if (state.mode !== 'heroSelect' && state.mode !== 'start' && state.mode !== 'bonusSelect') {
    if (!window._saveCounter) window._saveCounter = 0;
    window._saveCounter++;
    if (window._saveCounter % 3 === 0) {
      saveGame();
    }
  }
}

function renderLog() {
  const list = refs.logList;
  if (!list) return;
  
  // 用 hash 判断是否需要更新
  const logHash = state.log.slice(-10).join('|');
  if (window._lastLogHash === logHash && !window._forceLogRender) return;
  window._lastLogHash = logHash;
  window._forceLogRender = false;
  
  const fragment = document.createDocumentFragment();
  const entries = state.log.slice(-10).reverse();
  for (const entry of entries) {
    const li = document.createElement('li');
    li.textContent = entry;
    fragment.appendChild(li);
  }
  list.innerHTML = '';
  list.appendChild(fragment);
}

function renderRelics() {
  const relicList = document.getElementById('relicList');
  if (!relicList) return;
  
  const relicHash = state.relics.map(r => r.label).join(',');
  if (window._lastRelicHash === relicHash) return;
  window._lastRelicHash = relicHash;
  
  relicList.innerHTML = '';
  if (state.relics.length === 0) {
    relicList.textContent = '暂无遗物';
    return;
  }
  
  const fragment = document.createDocumentFragment();
  for (const relic of state.relics) {
    const badge = document.createElement('div');
    badge.className = `relic-badge${relic.rarity === 'rare' ? ' rare' : ''}`;
    badge.textContent = relic.label;
    badge.title = relic.description || '';
    fragment.appendChild(badge);
  }
  relicList.appendChild(fragment);
}

function renderRoomList() {
  const container = refs.roomList;
  if (!container) return;
  
  container.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < state.rooms.length; i++) {
    const room = state.rooms[i];
    const badge = document.createElement('div');
    badge.className = `room-badge${i === state.roomIndex ? ' current' : ''}`;
    badge.textContent = `${i + 1}. ${roomTypeNames[room.type]}`;
    fragment.appendChild(badge);
  }
  container.appendChild(fragment);
}

function renderEncyclopedia() {
  const list = refs.encyclopediaList;
  const categoriesContainer = refs.encyclopediaCategories;
  const backButton = refs.encyclopediaBackButton;
  
  if (!list) return;
  
  const currentContent = list.querySelector('.condition-item') ? list : categoriesContainer;
  if (currentContent.children.length > 0) {
    currentContent.classList.add('fade-out');
  }
  
  setTimeout(() => {
    list.innerHTML = '';
    categoriesContainer.innerHTML = '';
    
    const data = getEncyclopediaData();
    const categories = Object.keys(data);
    const encState = state.encyclopediaState;
    
    if (encState.viewMode === 'categories') {
      backButton.style.display = 'none';
      categories.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = 'category-btn';
        btn.textContent = cat;
        btn.dataset.category = cat;
        btn.addEventListener('click', () => {
          list.classList.add('fade-out');
          setTimeout(() => {
            encState.currentCategory = cat;
            encState.viewMode = 'entries';
            renderEncyclopedia();
          }, 200);
        });
        categoriesContainer.appendChild(btn);
      });
      const hint = document.createElement('p');
      hint.style.cssText = 'color: var(--muted); text-align: center; padding: 20px 0;';
      hint.textContent = '选择一个分类查看详细信息';
      list.appendChild(hint);
      
      categoriesContainer.classList.remove('fade-out');
      categoriesContainer.classList.add('fade-in');
      setTimeout(() => {
        categoriesContainer.classList.remove('fade-in');
      }, 300);
      
    } else {
      backButton.style.display = 'inline-block';
      const entries = data[encState.currentCategory] || [];
      entries.forEach(entry => {
        const item = document.createElement('div');
        item.className = 'condition-item';
        item.innerHTML = `<strong>${entry.title}</strong><p>${entry.description}</p>`;
        list.appendChild(item);
      });
      if (entries.length === 0) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color: var(--muted); text-align: center; padding: 20px 0;';
        empty.textContent = '该分类暂无条目';
        list.appendChild(empty);
      }
      
      list.classList.remove('fade-out');
      list.classList.add('fade-in');
      setTimeout(() => {
        list.classList.remove('fade-in');
      }, 350);
    }
    
    currentContent.classList.remove('fade-out');
    
  }, 200);
}

function renderBonusAndStats() {
  if (refs.bonusList) {
    const bonusHash = state.bonuses.map(b => b.title).join(',');
    if (window._lastBonusHash !== bonusHash) {
      window._lastBonusHash = bonusHash;
      refs.bonusList.innerHTML = '';
      if (state.bonuses.length === 0) {
        refs.bonusList.textContent = '暂无增益';
      } else {
        const fragment = document.createDocumentFragment();
        for (const bonus of state.bonuses) {
          const badge = document.createElement('div');
          badge.className = 'relic-badge';
          badge.textContent = bonus.title;
          badge.title = bonus.description;
          fragment.appendChild(badge);
        }
        refs.bonusList.appendChild(fragment);
      }
    }
  }

  if (refs.difficultyStats) {
    const record = state.records[state.difficulty] || { bestFloor: 0, clears: 0, deaths: 0 };
    const heroName = state.hero?.name || '未选择';
    const skillName = state.hero?.skill?.name || '无';
    const diffName = state.difficulty === 'hell' ? '地狱' : state.difficulty;
    const bonusNames = state.bonuses.length > 0 ? state.bonuses.map(b => b.title).join('，') : '无';
    
    // 用数据 hash 判断是否需要更新
    const statsHash = `${heroName}|${skillName}|${diffName}|${record.bestFloor}|${record.clears}|${record.deaths}|${bonusNames}`;
    if (window._lastStatsHash === statsHash) return;
    window._lastStatsHash = statsHash;
    
    refs.difficultyStats.innerHTML = `
      <div><span>当前英雄</span><strong>${heroName}</strong></div>
      <div><span>英雄技能</span><strong>${skillName}</strong></div>
      <div><span>当前难度</span><strong>${diffName}</strong></div>
      <div><span>最深层数</span><strong>${record.bestFloor}</strong></div>
      <div><span>通关次数</span><strong>${record.clears}</strong></div>
      <div><span>失败次数</span><strong>${record.deaths}</strong></div>
      <div><span>当前增益</span><strong>${bonusNames}</strong></div>
    `;
  }
}

function getRoomDescription(room) {
  switch (room.type) {
    case 'enemy':
      return '一群黑暗生物挡住了去路。准备迎战。';
    case 'shop':
      return '一个小型商贩在裂隙边缘摆摊，似乎懂得如何帮助你。';
    case 'rest':
      return '这里有一块被遗忘的石台，能让你短暂喘息。';
    case 'treasure':
      return '一只封存多年的宝箱静静地躺在角落。';
    case 'event':
      return '前方出现了奇异的场景，可能带来奖励或危险。';
    case 'elite':
      return '一名更强的守卫正等着你，这是一场精英战。';
    case 'boss':
      return '深渊的主人正在此地等待你的到来。';
    default:
      return '新的房间在你面前展开。';
  }
}

function addLog(message) {
  state.log.push(message);
  // ===== 限制日志数量，防止内存泄漏 =====
  if (state.log.length > 200) {
    state.log.splice(0, 50); // 保留最近 150 条，删除最旧的 50 条
  }
  renderLog();
}

function handleAction(event) {
  const btn = event.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;
  if (!action) return;

  // 经典 2D 实时模式：先问宿主是否消费这个动作。
  // 必须放在 state.detailMode 拦截（下一段）之前，否则详情模式会吞掉 2D 操作。
  // 宿主默认放行（返回 false），顶栏的图鉴/设置/存档管理等照常由内核处理。
  if (window.经典2D && window.经典2D.handleAction(action)) return;

  // ===== 详情模式拦截（放行战斗操作） =====
  if (state.detailMode) {
    const isModalButton = btn.closest('.modal-content') !== null;
    const combatActions = ['attack', 'defend', 'potion', 'hero-skill', 'boss-fight', 'strength-potion'];
    if (!isModalButton && !combatActions.includes(action)) {
      const detail = btn.dataset.detail || btn.title || `按钮：${btn.textContent}`;
      showToast(detail);
      addLog(`ℹ️ ${detail}`);
      return;
    }
  }

  // ===== 涟漪效果 =====
  const rect = btn.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * 100;
  const y = ((event.clientY - rect.top) / rect.height) * 100;
  btn.style.setProperty('--ripple-x', x + '%');
  btn.style.setProperty('--ripple-y', y + '%');

  let isModalCloseAction = false;

  if (action === 'attack') {
    attackEnemy();
  } else if (action === 'defend') {
    defend();
  } else if (action === 'potion') {
    usePotion();
  } else if (action === 'resolve') {
    resolveEvent();
  } else if (action === 'restart') {
    restartCurrentRun();
    return;
  } else if (action === 'skip-shop') {
    leaveShop();
  } else if (action.startsWith('shop-')) {
    buyFromShop(Number(action.split('-')[1]));
  } else if (action.startsWith('event-')) {
    chooseEvent(Number(action.split('-')[1]));
  } else if (action.startsWith('reward-')) {
    chooseReward(Number(action.split('-')[1]));
  } else if (action.startsWith('end-')) {
    chooseEnding(Number(action.split('-')[1]));
  } else if (action === 'choose-hero') {
    chooseHero(Number(event.target.dataset.index));
  } else if (action === 'choose-bonus') {
    chooseBonus(Number(event.target.dataset.index));
  } else if (action === 'strength-potion') {
    prepareStrengthPotion();
  } else if (action === 'boss-fight') {
    startCombat();
  } else if (action === 'rest-use-potion') {
    if (state.mode === 'rest') {
      if (state.player.potions <= 0) {
        addLog('你没有治疗药水可用。');
      } else {
        state.player.potions -= 1;
        const healAmount = 8;
        state.player.hp = Math.min(state.player.maxHp, state.player.hp + healAmount);
        addLog(`你在休整点使用了治疗药水，恢复了 ${healAmount} 点生命。`);
        spawnDamageFloat(healAmount, 'heal');
        render();
      }
    }
  } else if (action === 'rest-continue') {
    if (state.mode === 'rest') {
      let modifier = difficultyModifiers[state.difficulty] || difficultyModifiers.normal;
      if (state.difficulty === 'custom') {
        modifier = { restBonus: normalizeCustomDifficulty(state.customDifficulty).restBonus };
      }
      const extra = countRelic('神圣庇护') * 2;
      const restore = 5 + extra + (modifier.restBonus || 0);
      
      if (restore >= 0) {
        state.player.hp = Math.min(state.player.maxHp, state.player.hp + restore);
        addLog(`你在休整点恢复了 ${restore} 点生命。`);
        spawnDamageFloat(restore, 'heal');
        if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try {
            AbyssAudio.sfx('heal');
          } catch (error) {
            console.warn('[音效] 音效播放失败:', error);
          }
        }
      } else {
        const damage = Math.abs(restore);
        state.player.hp = Math.max(1, state.player.hp - damage);
        addLog(`⚠️ 休整点环境恶劣，你受到了 ${damage} 点伤害！`);
        spawnDamageFloat(damage, 'damage');
        
        if (state.player.hp <= 0) {
          state.gameOver = true;
          state.mode = 'gameover';
          addLog('你在休整点倒下了...');
          if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
          try {
            AbyssAudio.sfx('defeat');
          } catch (error) {
            console.warn('[音效] 失败音效播放失败:', error);
          }
        }
          updateRecords(false);
          render();
          return;
        }
      }
      
      state.mode = 'event';
      advanceRoom();
      render();
      return;
    }
  } else if (action === 'hero-skill') {
    activateHeroSkill();
  } else if (action === 'continue-adventure') {
    continueAdventure();
  } else if (action === 'close-conditions') {
    closeConditionsModal();
    isModalCloseAction = true;
  } else if (action === 'close-encyclopedia') {
    closeEncyclopediaModal();
    isModalCloseAction = true;
  } else if (action === 'close-changelog') {
    closeChangelogModal();
    isModalCloseAction = true;
  } else if (action === 'close-attribute-detail') {
    closeAttributeDetail();
    isModalCloseAction = true;
  } else if (action === 'close-cheat') {
    closeCheatModal();
    isModalCloseAction = true;
  } else if (action === 'close-trial-shop') {
    closeTrialShop();
    isModalCloseAction = true;
  }

  if (!isModalCloseAction) {
    render();
    if (!window._saveCounter) window._saveCounter = 0;
    window._saveCounter++;
    if (window._saveCounter % 2 === 0) {
      saveGame();
    }
  }
}

// ===== 统一窗口抖动入口（尊重"窗口抖动"设置开关）=====
function playScreenShake() {
    if (!isSettingEnabled('screenShake')) return;
    const shell = document.querySelector('.app-shell');
    if (!shell) return;
    shell.classList.add('shake');
    setTimeout(() => shell.classList.remove('shake'), 300);
}

function spawnDamageFloat(value, type = 'damage') {
  // ===== 飘字音效：所有类型的数值飘字都伴随对应音效 =====
  const FLOAT_SFX = {
    damage: 'hurt',
    attack: 'attack',
    heal: 'heal',
    shield: 'shield',
    gold: 'coin',
    relic: 'reward',
    lucky: 'lucky',
    thorn: 'thorn',
    vampire: 'vampire',
    crit: 'crit',
    dodge: 'dodge',
    combo: 'combo',
    execute: 'execute',
    xp: 'xp',
    buff: 'buff',
    debuff: 'debuff',
    levelUp: 'levelUp',
    goldLose: 'goldLose',
    wish: 'wish',
    whisper: 'whisper',
    anvil: 'anvil',
    dice: 'dice',
    splash: 'splash',
    sacrifice: 'sacrifice',
    door: 'door',
  };
  const sfxName = FLOAT_SFX[type] || 'hurt';
  if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
    try {
      AbyssAudio.sfx(sfxName);
    } catch (e) {
      console.warn('[音效] 飘字音效播放失败:', e);
    }
  }
  if (!isSettingEnabled('floatText')) return;
  const el = document.createElement('div');
  el.className = `damage-float ${type}`;
  
  let color, prefix, size, left, top;
  
  if (type === 'attack') {
    color = '#f7b731';
    prefix = '⚔️ +';
    size = '2.2rem';
    left = 50 + Math.random() * 25;
    top = 25 + Math.random() * 25;
  } else if (type === 'heal') {
    color = '#73f0b4';
    prefix = '+';
    size = '2.4rem';
    left = 40 + Math.random() * 20;
    top = 30 + Math.random() * 20;
  } else if (type === 'shield') {
    color = '#6fc3ff';
    prefix = '+';
    size = '2.4rem';
    left = 40 + Math.random() * 20;
    top = 30 + Math.random() * 20;
  } else if (type === 'gold') {
    color = '#f7b731';
    prefix = '💰 +';
    size = '2rem';
    left = 40 + Math.random() * 20;
    top = 30 + Math.random() * 20;
  } else if (type === 'relic') {
    color = '#ff6bff';
    prefix = '✦ ';
    size = '2.6rem';
    left = 40 + Math.random() * 20;
    top = 30 + Math.random() * 20;
  } else if (type === 'lucky') {
    color = '#ff6b6b';
    prefix = '🎯 +';
    size = '2rem';
    left = 40 + Math.random() * 20;
    top = 30 + Math.random() * 20;
  } else if (type === 'thorn') {
    color = '#6fc3ff';
    prefix = '🌿 +';
    size = '2rem';
    left = 40 + Math.random() * 20;
    top = 30 + Math.random() * 20;
  } else if (type === 'vampire') {
    color = '#ff6b6b';
    prefix = '🩸 +';
    size = '2rem';
    left = 40 + Math.random() * 20;
    top = 30 + Math.random() * 20;
  } else if (type === 'crit') {
    color = '#ff6b6b';
    prefix = '💢 +';
    size = '2rem';
    left = 40 + Math.random() * 20;
    top = 30 + Math.random() * 20;
  } else if (type === 'dodge') {
    color = '#6fc3ff';
    prefix = '💨 ';
    size = '2.2rem';
    left = 40 + Math.random() * 20;
    top = 25 + Math.random() * 25;
  } else if (type === 'combo') {
    color = '#f7b731';
    prefix = '⚡ ';
    size = '2.2rem';
    left = 50 + Math.random() * 25;
    top = 25 + Math.random() * 25;
  } else if (type === 'execute') {
    color = '#ff3b3b';
    prefix = '💀 ';
    size = '2.6rem';
    left = 40 + Math.random() * 20;
    top = 20 + Math.random() * 20;
  } else if (type === 'xp') {
    color = '#a78bfa';
    prefix = '⭐ -';
    size = '2rem';
    left = 40 + Math.random() * 20;
    top = 30 + Math.random() * 20;
  } else if (type === 'goldLose') {
    color = '#f7b731';
    prefix = '💰 -';
    size = '2rem';
    left = 40 + Math.random() * 20;
    top = 30 + Math.random() * 20;
  }
    else {
    color = '#ff3b3b';
    prefix = '💀 -';
    size = '2.4rem';
    left = 15 + Math.random() * 20;
    top = 25 + Math.random() * 25;
  }
  
  el.textContent = `${prefix}${value}`;
  el.style.color = color;
  el.style.fontSize = size;
  el.style.left = left + '%';
  el.style.top = top + '%';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

refs.actionArea.addEventListener('click', handleAction);

// 作弊面板 - 密码验证
if (refs.cheatPasswordConfirm) {
  refs.cheatPasswordConfirm.addEventListener('click', verifyCheatPassword);
}
if (refs.cheatPasswordInput) {
  refs.cheatPasswordInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      verifyCheatPassword();
    }
  });
}

// 显示/隐藏密码
if (refs.cheatPasswordToggle) {
  refs.cheatPasswordToggle.addEventListener('click', () => {
    const input = refs.cheatPasswordInput;
    if (input.type === 'password') {
      input.type = 'text';
      refs.cheatPasswordToggle.textContent = '🙈';
    } else {
      input.type = 'password';
      refs.cheatPasswordToggle.textContent = '👁';
    }
  });
}

if (refs.cheatApplyStats) {
  refs.cheatApplyStats.addEventListener('click', applyCheatStats);
}
if (refs.cheatAddRelic) {
  refs.cheatAddRelic.addEventListener('click', cheatAddRelic);
}
if (refs.cheatAddBonus) {
  refs.cheatAddBonus.addEventListener('click', cheatAddBonus);
}

// ===== Toast 轻提示 =====
function showToast(message, type) {
  // 移除旧 Toast
  const oldContainer = document.querySelector('.toast-container');
  if (oldContainer) oldContainer.remove();

  // 如果消息为空，直接返回
  if (!message) return;

  // 类型映射：info / success / warning / error
  type = type || 'info';
  // 提示音效：错误蜂鸣 / 成功星辉
  if (window.AbyssAudio && typeof window.AbyssAudio.sfx === 'function') {
    try {
      if (type === 'error') AbyssAudio.sfx('error');
      else if (type === 'success') AbyssAudio.sfx('reward');
    } catch (error) {
      console.warn('[音效] 提示音效播放失败:', error);
    }
  }
  const iconMap = {
    info: 'ℹ',
    success: '✅',
    warning: '⚠️',
    error: '❌'
  };
  const icon = iconMap[type] || 'ℹ';

  // 创建容器
  const container = document.createElement('div');
  container.className = 'toast-container';

  // 创建 Toast 主体
  const toast = document.createElement('div');
  toast.className = `toast-message ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-text">${message}</span>
  `;

  // 点击 Toast 主体关闭
  toast.addEventListener('click', function closeToast() {
    toast.style.animation = 'toastSlideOut 0.25s ease forwards';
    setTimeout(() => {
      if (container.parentNode) container.remove();
    }, 300);
  });

  // 悬停暂停自动关闭计时器
  let autoCloseTimer = null;
  const autoCloseDelay = 2800;

  function startAutoClose() {
    if (autoCloseTimer) clearTimeout(autoCloseTimer);
    autoCloseTimer = setTimeout(() => {
      toast.style.animation = 'toastSlideOut 0.25s ease forwards';
      setTimeout(() => {
        if (container.parentNode) container.remove();
      }, 300);
    }, autoCloseDelay);
  }

  toast.addEventListener('mouseenter', () => {
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
  });

  toast.addEventListener('mouseleave', startAutoClose);

  container.appendChild(toast);
  document.body.appendChild(container);

  // 启动自动关闭
  startAutoClose();
}

// ============================================================
// 新手引导系统
// ============================================================

let tutorialActive = false;
let tutorialStep = 0;
let tutorialKeyHandlerBound = null;

const tutorialSteps = [
  {
    title: '🎯 选择你的英雄',
    content: '从九位英雄中选择一位开始冒险。每位英雄都有独特的属性和技能，鼠标悬停&图鉴&详情模式均可查看技能详情。'
  },
  {
    title: '✨ 选择开局增益',
    content: '这个增益会伴随你整局游戏。吸血之刃让你攻击回血，荆棘护甲反弹伤害，生命护盾每回合加盾……选一个适合的！'
  },
  {
    title: '⚔️ 战斗开始！',
    content: '点击「攻击」按钮对敌人造成伤害，点击「防御」获得护盾，点击「治疗药水」恢复生命。击败敌人获得金币和经验！'
  },
  {
    title: '🎁 选择奖励',
    content: '每次战斗胜利后可以从三个奖励中选一个。攻击、生命上限、护盾、治疗药水……选择当前最需要的！'
  },
  {
    title: '🏪 商店',
    content: '每个商品可以用「金币」或「经验」购买。优先用金币，不足时自动用经验。稀有商品限购5次，普通商品限购20次。'
  },
  {
    title: '🛌 休整点',
    content: '在这里恢复生命，也可以使用治疗药水。每层只有有限的休整机会，合理规划路线！'
  },
  {
    title: '👑 Boss 击败！',
    content: '你战胜了层主！可以选择「继续冒险」挑战更深层，或选择一个「结局」结束游戏。深渊的深处还有更多秘密……'
  }
];

function startTutorial() {
  if (tutorialActive) return;
  tutorialActive = true;
  tutorialStep = 0;
  showTutorialStep();
}

function showTutorialStep() {
  if (tutorialStep >= tutorialSteps.length) {
    closeTutorial();
    return;
  }
  
  const step = tutorialSteps[tutorialStep];
  const existing = document.querySelector('.tutorial-overlay');
  if (existing) existing.remove();
  
  const overlay = document.createElement('div');
  overlay.className = 'tutorial-overlay';
  overlay.innerHTML = `
    <div class="tutorial-card">
      <div class="tutorial-progress">引导 ${tutorialStep + 1}/${tutorialSteps.length}</div>
      <div class="tutorial-title">${step.title}</div>
      <div class="tutorial-content">${step.content}</div>
      <div class="tutorial-actions">
        <button class="tutorial-skip" data-action="skip-tutorial">跳过引导</button>
        <button class="tutorial-next" data-action="next-tutorial">
          ${tutorialStep === tutorialSteps.length - 1 ? '知道了' : '下一步 →'}
        </button>
      </div>
    </div>
  `;
  
  // 绑定按钮事件
  overlay.querySelector('[data-action="next-tutorial"]').addEventListener('click', nextTutorialStep);
  overlay.querySelector('[data-action="skip-tutorial"]').addEventListener('click', closeTutorial);
  
  // 点击背景不关闭（防止误触）
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) return;
  });
  
  document.body.appendChild(overlay);
  
  // ESC 键关闭
  if (tutorialKeyHandlerBound) {
    document.removeEventListener('keydown', tutorialKeyHandlerBound);
  }
  tutorialKeyHandlerBound = function(e) {
    if (e.key === 'Escape') {
      closeTutorial();
    }
  };
  document.addEventListener('keydown', tutorialKeyHandlerBound);
}

function nextTutorialStep() {
  tutorialStep++;
  showTutorialStep();
}

function closeTutorial() {
  tutorialActive = false;
  if (tutorialKeyHandlerBound) {
    document.removeEventListener('keydown', tutorialKeyHandlerBound);
    tutorialKeyHandlerBound = null;
  }
  const overlay = document.querySelector('.tutorial-overlay');
  if (overlay) overlay.remove();
  showToast('已退出引导');
}

// 导出到全局（供其他函数调用）
window.startTutorial = startTutorial;
window.nextTutorialStep = nextTutorialStep;
window.closeTutorial = closeTutorial;

// ===== 一次性绑定属性点击事件（页面加载时执行一次） =====
function bindAttributeClickEvents() {
  const attrMap = {
    'playerName': '英雄技能',
    'playerHp': '生命',
    'playerAttack': '攻击',
    'playerShield': '护盾',
    'playerGold': '金币',
    'playerPotions': '药水',
    'playerLucky': '暴击率',
    'playerCritDamage': '暴击伤害',
    'playerThorn': '荆棘',
    'playerVampire': '吸血',
    'playerDodge': '闪避',
    'playerCombo': '连击',
    'playerExecute': '斩杀',
    'heroSkillStatus': '英雄技能',
    'lifeShieldStatus': '生命护盾',
    'doubleGoldStatus': '双倍金币',
    'ancientBlessStatus': '古神眷顾',
  };

  Object.keys(attrMap).forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      // 如果已经绑定过，跳过
      if (el.dataset.bound === 'true') return;
      
      const attrKey = attrMap[id];
      el.style.cursor = 'pointer';
      el.style.transition = 'all 0.2s ease';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openAttributeDetail(attrKey);
      });
      el.addEventListener('mouseenter', () => {
        el.style.textShadow = '0 0 20px rgba(115,240,180,0.2)';
      });
      el.addEventListener('mouseleave', () => {
        el.style.textShadow = '';
      });
      el.dataset.bound = 'true';
    }
  });
}

// 作弊面板内部元素
if (refs.cheatPasswordConfirm) {
  refs.cheatPasswordConfirm.addEventListener('click', verifyCheatPassword);
}
if (refs.cheatPasswordInput) {
  refs.cheatPasswordInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      verifyCheatPassword();
    }
  });
}
if (refs.cheatPasswordToggle) {
  refs.cheatPasswordToggle.addEventListener('click', () => {
    const input = refs.cheatPasswordInput;
    if (input.type === 'password') {
      input.type = 'text';
      refs.cheatPasswordToggle.textContent = '🙈';
    } else {
      input.type = 'password';
      refs.cheatPasswordToggle.textContent = '👁';
    }
  });
}
if (refs.cheatApplyStats) {
  refs.cheatApplyStats.addEventListener('click', applyCheatStats);
}
if (refs.cheatAddRelic) {
  refs.cheatAddRelic.addEventListener('click', cheatAddRelic);
}
if (refs.cheatAddBonus) {
  refs.cheatAddBonus.addEventListener('click', cheatAddBonus);
}

// 事件委托
refs.actionArea.addEventListener('click', handleAction);

// 重新开始按钮
refs.restartButton.addEventListener('click', restartCurrentRun);

// ============================================================
// 开始界面控制
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
  document.body.style.overflow = 'hidden';

  // ===== 开始界面背景音乐：首次交互即解锁并播放菜单音乐 =====
  // 浏览器自动播放策略要求用户手势后才能出声，因此在开始界面绑定一次性手势监听：
  // 用户第一次点击/按键（任意位置）时立即解锁 AudioContext 并播放菜单场景 BGM，
  // 让标题画面停留期间就有背景音乐；已解锁后监听自动移除，不会重复绑定。
  if (!window._startMenuMusicBound) {
    window._startMenuMusicBound = true;
    const startMenuGesture = function() {
      if (window.AbyssAudio && typeof window.AbyssAudio.unlock === 'function') {
        try {
          window.AbyssAudio.unlock();
          window.AbyssAudio.setScene('menu');
          console.log('[音效] 开始界面背景音乐已启动');
        } catch (e) {
          console.warn('[音效] 开始界面背景音乐启动失败:', e);
        }
      }
      document.removeEventListener('pointerdown', startMenuGesture, true);
      document.removeEventListener('keydown', startMenuGesture, true);
      document.removeEventListener('touchstart', startMenuGesture, true);
    };
    document.addEventListener('pointerdown', startMenuGesture, true);
    document.addEventListener('keydown', startMenuGesture, true);
    document.addEventListener('touchstart', startMenuGesture, true);
  }
  
  // 延迟应用设置，确保音效系统完全加载
  const settings = loadSettings();
  
  // 延迟一段时间确保音效系统加载完成
  setTimeout(() => {
    applySettings(settings);
  }, 500);
  // ===== 版本切换：新版 ⇄ 老版（2.6）=====
  // 老版是 老版2.6/ 下一份完整独立的快照（自带 HTML/CSS/JS），直接跳过去就等于跑一份 2.6，
  // 两边 DOM 与脚本互不污染，也不需要在同一份代码里写 if(legacy) 分支。
  // 刻意不用 window.confirm：系统对话框会把页面顶出全屏，破坏主画面的横屏/全屏状态。
  (function bindVersionSwitch() {
    const btn = document.getElementById('versionSwitchButton');
    if (!btn || window._versionSwitchBound) return;
    window._versionSwitchBound = true;
    btn.addEventListener('click', function () {
      // 已经在玩就先存一次盘，别让这一次点击丢掉当前进度；
      // 还在开始界面（mode === 'start'）时绝不保存，否则会凭空写出一份空存档。
      try {
        if (state && state.mode && state.mode !== 'start') saveGame();
      } catch (e) { console.warn('[版本切换] 切换前保存失败：', e); }
      location.href = '老版2.6/主界面.html';
    });
  })();

  const startScreen = document.getElementById('startScreen');
  const startBtn = document.getElementById('startGameBtn');
  const changelogBtn = document.getElementById('startChangelogBtn');
  const fxCanvas = document.getElementById('startFxCanvas');

  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.style.display = 'none';
  if (!startScreen) return;

  // ===== 开始界面背景特效（Canvas 粒子引擎，可交互） =====
  // 深空星视差 + 萤火尘埃漂移 + 上浮光粒 + 流星 + 点击爆散/冲击波，
  // 鼠标移动产生视差与粒子斥力，点击任意处迸发粒子。
  // 屏幕隐藏（进入游戏）后引擎自动停止。
  if (fxCanvas) {
    try {
      initStartScreenFX(fxCanvas);
    } catch (err) {
      console.warn('[特效] 开始界面背景特效启动失败:', err);
    }
  }

  // ===== 开始按钮 =====
  if (startBtn) {
    const newBtn = startBtn.cloneNode(true);
    startBtn.parentNode.replaceChild(newBtn, startBtn);
    newBtn.addEventListener('click', function(e) {
      e.preventDefault();
      console.log('开始按钮被点击');
      // 解锁音频（满足浏览器自动播放策略），开始菜单音乐
      if (window.AbyssAudio && typeof window.AbyssAudio.unlock === 'function') {
        try {
            window.AbyssAudio.unlock();
            console.log('[音效] 音频解锁成功');
        } catch (error) {
            console.warn('[音效] 音频解锁失败:', error);
        }
      }
      const screen = document.getElementById('startScreen');
      if (screen) {
        screen.classList.add('hidden');
        console.log('开始界面已隐藏');
      }
      // ===== 恢复 body 滚动 =====
      document.body.style.overflow = '';
      // ===== 显示顶栏 =====
      const topbar = document.querySelector('.topbar');
      if (topbar) topbar.style.display = '';
      if (!window._gameInitialized) {
        window._gameInitialized = true;
        startGameDirectly();
      }
    });
  }

  // ===== 更新日志按钮 =====
  if (changelogBtn) {
    const newBtn = changelogBtn.cloneNode(true);
    changelogBtn.parentNode.replaceChild(newBtn, changelogBtn);
    
    newBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      e.preventDefault();
      openChangelogModal();  // 使用统一函数
    });
  }

  // ===== 绑定开始界面更新日志的关闭事件 =====
  const changelogModal = document.getElementById('changelogModal');
  if (changelogModal) {
    // 点击遮罩关闭
    changelogModal.addEventListener('click', function(e) {
      if (e.target.classList.contains('modal-backdrop')) {
        closeChangelogModal();
      }
    });
    // 点击关闭按钮关闭（使用 closest 兼容内部文本）
    changelogModal.addEventListener('click', function(e) {
      const closeBtn = e.target.closest('[data-action="close-changelog"]');
      if (closeBtn) {
        closeChangelogModal();
      }
    });
  }

  // ===== 键盘快捷键 =====
  document.addEventListener('keydown', function startKeyHandler(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      const screen = document.getElementById('startScreen');
      if (screen && !screen.classList.contains('hidden')) {
        e.preventDefault();
        const btn = document.getElementById('startGameBtn');
        if (btn) btn.click();
      }
    }
  });

    // ===== 移动设备检测与适配 =====
  function isMobileDevice() {
    return window.innerWidth <= 768 || ('ontouchstart' in window);
  }

  // 移动端侧边栏按钮自动关闭
  if (isMobileDevice()) {
    document.querySelectorAll('.sidebar-cheat-btn, .dev-toggle-btn, .ghost-button[data-action]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (window.sidebar && typeof window.sidebar.close === 'function') {
          // 延迟一点关闭，让点击事件先完成
          setTimeout(function() {
            window.sidebar.close();
          }, 150);
        }
      });
    });
  }

  // 窗口尺寸变化时重新检测
  window.addEventListener('resize', function() {
    const mobile = window.innerWidth <= 768;
    // 可以在这里添加其他响应式逻辑
  });

  console.log('✅ 移动端适配已加载');
  console.log('✅ 开始界面初始化完成');
});

// ============================================================
// 开始界面背景特效引擎（Canvas 粒子，可交互）
// 深空星（视差闪烁）+ 萤火尘埃（漂移 + 鼠标斥力）+ 上浮光粒
// + 流星 + 点击爆散/冲击波 + 鼠标追踪柔光（CSS 层）。
// 风格保持原有：暗色深渊 + 青紫渐变；屏幕隐藏后自动停止。
// ============================================================
function initStartScreenFX(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  if (canvas._abyssFxInited) return;
  canvas._abyssFxInited = true;

  const ctx = canvas.getContext('2d');
  const startScreen = document.getElementById('startScreen');
  const glow = document.getElementById('startCursorGlow');
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  let W = 0, H = 0, DPR = 1;
  let rafId = 0;
  let lastT = 0;
  let running = false;
  let shootingTimer = 3;
  let shooting = null;
  let hiddenSince = -1;

  // 指针位置（平滑值用于粒子力场，原始值用于光晕瞬移）
  const pointer = { x: -9999, y: -9999, active: false };
  const pointerRaw = { x: -9999, y: -9999 };

  // 颜色统一存 rgb 三元组字符串，便于拼 rgba()
  const C = {
    cyan: '95,208,224',
    purple: '154,142,240',
    gold: '240,208,106',
    white: '255,255,255'
  };
  const COLORS = [C.cyan, C.purple, C.gold, '143,227,240', '185,175,247'];

  const stars = [];
  const dusts = [];
  const rises = [];
  const bursts = [];
  const rings = [];

  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
  function wrap(v, max, pad) { return v < -pad ? v + max + pad * 2 : (v > max + pad ? v - max - pad * 2 : v); }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function makeStar() {
    return {
      x: rand(0, W), y: rand(0, H),
      r: rand(0.6, 1.9),
      tw: rand(0.5, 2.5),
      ph: rand(0, Math.PI * 2),
      alpha: rand(0.3, 0.9),
      parallax: rand(0.03, 0.14),
      color: Math.random() < 0.72 ? C.white : pick([C.cyan, C.purple])
    };
  }

  function makeDust() {
    return {
      x: rand(0, W), y: rand(0, H),
      r: rand(1.6, 4.6),
      vx: rand(-10, 10), vy: rand(-8, 8),
      alpha: rand(0.15, 0.45),
      parallax: rand(0.2, 0.4),
      color: pick(COLORS),
      pulse: rand(0.6, 1.8),
      pulsePh: rand(0, Math.PI * 2)
    };
  }

  function makeRise() {
    return {
      x: rand(0, W), y: rand(H + 20, H + 80),
      r: rand(1, 2.8),
      speed: rand(16, 55),
      sway: rand(0.4, 1.4),
      swayPh: rand(0, Math.PI * 2),
      alpha: rand(0.3, 0.75),
      parallax: rand(0.05, 0.15),
      color: pick(COLORS)
    };
  }

  const STAR_N = isTouch ? 70 : 130;
  const DUST_N = isTouch ? 18 : 38;
  const RISE_N = isTouch ? 12 : 24;

  function seed() {
    stars.length = 0; dusts.length = 0; rises.length = 0;
    for (let i = 0; i < STAR_N; i++) stars.push(makeStar());
    for (let i = 0; i < DUST_N; i++) dusts.push(makeDust());
    for (let i = 0; i < RISE_N; i++) rises.push(makeRise());
  }

  // ===== 交互 =====
  function onPointerMove(e) {
    const rect = canvas.getBoundingClientRect();
    pointerRaw.x = e.clientX - rect.left;
    pointerRaw.y = e.clientY - rect.top;
    if (!pointer.active) { pointer.x = pointerRaw.x; pointer.y = pointerRaw.y; }
    pointer.active = true;
  }

  function onPointerLeave() {
    pointer.active = false;
    pointer.x = -9999; pointer.y = -9999;
  }

  function onPointerDown(e) {
    if (!startScreen || startScreen.classList.contains('hidden')) return;
    const rect = canvas.getBoundingClientRect();
    burstAt(e.clientX - rect.left, e.clientY - rect.top);
  }

  // 点击处迸发彩色粒子 + 扩散冲击波
  function burstAt(x, y) {
    const n = isTouch ? 8 : 14;
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(60, 240);
      bursts.push({
        x: x, y: y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 40,
        r: rand(1, 2.6),
        life: 1,
        decay: rand(1.2, 2.2),
        color: pick(COLORS)
      });
    }
    rings.push({ x: x, y: y, r: 6, life: 1, decay: 1.1, color: pick([C.cyan, C.purple]) });
  }

  // ===== 主循环 =====
  function updatePointer(dt) {
    if (!pointer.active) return;
    pointer.x += (pointerRaw.x - pointer.x) * Math.min(1, dt * 12);
    pointer.y += (pointerRaw.y - pointer.y) * Math.min(1, dt * 12);
    if (glow) {
      glow.classList.add('visible');
      glow.style.transform = 'translate(' + (pointerRaw.x - 210) + 'px,' + (pointerRaw.y - 210) + 'px)';
    }
  }

  function step(now) {
    if (!running) return;
    rafId = requestAnimationFrame(step);

    // 屏幕隐藏：让爆散动画播完再彻底停止
    if (startScreen && startScreen.classList.contains('hidden')) {
      if (hiddenSince < 0) hiddenSince = now;
      if (now - hiddenSince > 600) { stop(); return; }
    } else {
      hiddenSince = -1;
    }

    const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016);
    lastT = now;
    const t = now / 1000;

    updatePointer(dt);
    ctx.clearRect(0, 0, W, H);
    const px = pointer.active ? (pointer.x - W / 2) : 0;
    const py = pointer.active ? (pointer.y - H / 2) : 0;

    // ---- 深空星（视差闪烁） ----
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const tw = reduceMotion ? 1 : (0.55 + 0.45 * Math.sin(t * s.tw + s.ph));
      const x = wrap(s.x + px * s.parallax, W, 4);
      const y = wrap(s.y + py * s.parallax, H, 4);
      ctx.globalAlpha = s.alpha * tw;
      ctx.fillStyle = 'rgb(' + s.color + ')';
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // ---- 萤火尘埃（漂移 + 鼠标斥力） ----
    for (let i = 0; i < dusts.length; i++) {
      const d = dusts[i];
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      const dx = d.x - pointer.x, dy = d.y - pointer.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const repel = 90;
      if (pointer.active && dist < repel && dist > 0.01) {
        const f = (1 - dist / repel) * 260 * dt;
        d.x += (dx / dist) * f;
        d.y += (dy / dist) * f;
      }
      d.x = wrap(d.x, W, 20);
      d.y = wrap(d.y, H, 20);
      const ox = px * d.parallax, oy = py * d.parallax;
      const a = d.alpha * (reduceMotion ? 1 : 0.55 + 0.45 * Math.sin(t * d.pulse + d.pulsePh));
      const g = ctx.createRadialGradient(d.x + ox, d.y + oy, 0, d.x + ox, d.y + oy, d.r * 3);
      g.addColorStop(0, 'rgba(' + d.color + ',' + a.toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + d.color + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(d.x + ox, d.y + oy, d.r * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- 上浮光粒（保留原有上浮感，带发光与斥力） ----
    ctx.shadowBlur = 8;
    for (let i = 0; i < rises.length; i++) {
      const r = rises[i];
      r.swayPh += dt * r.sway;
      r.y -= r.speed * dt;
      r.x += Math.sin(r.swayPh) * 18 * dt;
      if (r.y < -12) { r.y = H + 12; r.x = rand(0, W); }
      const dx = r.x - pointer.x, dy = r.y - pointer.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const repel = 80;
      if (pointer.active && dist < repel && dist > 0.01) {
        const f = (1 - dist / repel) * 300 * dt;
        r.x += (dx / dist) * f;
        r.y += (dy / dist) * f;
      }
      const ox = px * r.parallax, oy = py * r.parallax;
      const a = r.alpha * (reduceMotion ? 1 : 0.6 + 0.4 * Math.sin(t * 1.6 + r.swayPh));
      ctx.shadowColor = 'rgba(' + r.color + ',0.85)';
      ctx.fillStyle = 'rgba(' + r.color + ',' + a.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(r.x + ox, r.y + oy, r.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';

    // ---- 流星（随机划过：终点固定在屏幕内，全程可见，长时间渐隐熄灭） ----
    if (!reduceMotion) {
      shootingTimer -= dt;
      if (!shooting && shootingTimer <= 0) {
        // 起点：屏幕外上方或侧边（缓缓滑入画面）
        const sx = Math.random() < 0.5 ? rand(-140, W * 0.25) : rand(W * 0.75, W + 140);
        const sy = rand(-140, H * 0.2);
        // 终点：屏幕内随机点 → 流星必然在画面内滑完全程并完成熄灭，
        // 速度由 (终点-起点)/总时长 决定，不可能滑出屏幕“骤然消失”。
        const ex = rand(W * 0.2, W * 0.8);
        const ey = rand(Math.max(sy, H * 0.2), H * 0.85);
        const dur = rand(5.5, 7);        // 完整生命周期 5.5-7 秒
        shooting = {
          x: sx, y: sy,
          vx: (ex - sx) / dur, vy: (ey - sy) / dur,
          dur: dur, age: 0,
          fadeIn: 0.5,                   // 淡入 0.5 秒渐亮
          fadeStart: 0.55                // 滑行进度超过 55% 后开始熄灭，占后 45%（约 2.5-3 秒）
        };
        shootingTimer = rand(2.5, 6);
      }
      if (shooting) {
        shooting.age += dt;
        shooting.x += shooting.vx * dt;
        shooting.y += shooting.vy * dt;
        // alpha 包络：0.5s 淡入 → 全亮 → 后 45% 时间平滑熄灭（移除时 alpha 已为 0，无消失感）
        let alpha = 1;
        if (shooting.age < shooting.fadeIn) {
          alpha = shooting.age / shooting.fadeIn;
        } else {
          const prog = (shooting.age - shooting.fadeIn) / (shooting.dur - shooting.fadeIn);
          if (prog > shooting.fadeStart) {
            alpha = Math.max(0, (1 - prog) / (1 - shooting.fadeStart));
          }
        }
        const sx = shooting.x - shooting.vx * 0.32;
        const sy = shooting.y - shooting.vy * 0.32;
        const lg = ctx.createLinearGradient(sx, sy, shooting.x, shooting.y);
        lg.addColorStop(0, 'rgba(185,220,255,0)');
        lg.addColorStop(1, 'rgba(235,248,255,' + (0.95 * alpha).toFixed(3) + ')');
        ctx.strokeStyle = lg;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(shooting.x, shooting.y);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,' + (0.95 * alpha).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(shooting.x, shooting.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
        // 生命周期结束移除（此刻 alpha 已降到 0，完全透明）
        if (shooting.age >= shooting.dur) shooting = null;
      }
    }

    // ---- 点击爆散 ----
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.life -= b.decay * dt;
      if (b.life <= 0) { bursts.splice(i, 1); continue; }
      b.vy += 90 * dt;
      b.vx *= (1 - 1.8 * dt);
      b.vy *= (1 - 1.8 * dt);
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const a = Math.min(1, b.life * 1.6);
      ctx.shadowBlur = 10;
      ctx.shadowColor = 'rgba(' + b.color + ',0.9)';
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(' + b.color + ',1)';
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r * (1 + (1 - b.life) * 0.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    // ---- 冲击波光晕（点击扩散：内部柔光 + 宽光晕环 + 亮核环） ----
    for (let i = rings.length - 1; i >= 0; i--) {
      const rg = rings[i];
      rg.life -= rg.decay * dt;
      if (rg.life <= 0) { rings.splice(i, 1); continue; }
      rg.r += 280 * dt;
      const a = Math.max(0, Math.min(1, rg.life * 1.3));   // 亮度随寿命平滑淡出
      // 1) 内部柔光：扩散波内部淡淡的填充，增加体积感
      const inner = ctx.createRadialGradient(rg.x, rg.y, 0, rg.x, rg.y, rg.r * 1.1);
      inner.addColorStop(0, 'rgba(' + rg.color + ',' + (a * 0.10).toFixed(3) + ')');
      inner.addColorStop(0.75, 'rgba(' + rg.color + ',' + (a * 0.06).toFixed(3) + ')');
      inner.addColorStop(1, 'rgba(' + rg.color + ',0)');
      ctx.fillStyle = inner;
      ctx.beginPath();
      ctx.arc(rg.x, rg.y, rg.r * 1.1, 0, Math.PI * 2);
      ctx.fill();
      // 2) 外层光晕环：宽、淡，形成厚实的光圈
      ctx.globalAlpha = a * 0.30;
      ctx.strokeStyle = 'rgba(' + rg.color + ',1)';
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.arc(rg.x, rg.y, rg.r, 0, Math.PI * 2);
      ctx.stroke();
      // 3) 亮核环：窄、亮，轮廓清晰
      ctx.globalAlpha = a;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(rg.x, rg.y, rg.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function start() {
    if (running) return;
    running = true;
    lastT = 0;
    resize();
    if (!reduceMotion) shootingTimer = rand(1.5, 3);
    rafId = requestAnimationFrame(step);
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(rafId);
    window.removeEventListener('resize', resize);
    if (startScreen) {
      startScreen.removeEventListener('mousemove', onPointerMove);
      startScreen.removeEventListener('mouseleave', onPointerLeave);
      startScreen.removeEventListener('pointerdown', onPointerDown);
    }
    if (glow) glow.classList.remove('visible');
    // 清空粒子，释放内存
    stars.length = 0; dusts.length = 0; rises.length = 0;
    bursts.length = 0; rings.length = 0; shooting = null;
  }

  // ===== 绑定事件 =====
  if (!isTouch && startScreen) {
    startScreen.addEventListener('mousemove', onPointerMove, { passive: true });
    startScreen.addEventListener('mouseleave', onPointerLeave);
  }
  if (startScreen) startScreen.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('resize', resize);

  seed();
  start();
  // 暴露调试/测试句柄
  canvas._abyssFx = {
    isRunning: function() { return running; },
    stop: stop,
    start: start
  };
}

// ===== 直接启动游戏（通过 initGame 统一处理） =====
function startGameDirectly() {
  console.log('🚀 直接启动游戏');
  // 直接调用 initGame，它会处理存档加载、迁移和初始化
  initGame();
}
// ============================================================
// 开发者模式
// ============================================================

const DEV_MODE = {
  enabled: false,
  consoleOpen: false,
  monitorOpen: false,
  toolbarOpen: false,
  debugLogs: false,
  godMode: false,
  speedMultiplier: 1,
  snapshots: [],
  maxSnapshots: 20,
  log: [],
  commands: {},
  lastCommand: null,
  renderTimes: [],
};

// ===== 检查是否启用开发者模式 =====
function checkDevMode() {
  // URL 参数 ?dev=true
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('dev') === 'true') {
    return true;
  }
  // localStorage 标记
  if (localStorage.getItem('abyss_dev_mode') === 'true') {
    return true;
  }
  return false;
}

// ===== 切换开发者模式 =====
function toggleDevMode() {
  DEV_MODE.enabled = !DEV_MODE.enabled;
  localStorage.setItem('abyss_dev_mode', String(DEV_MODE.enabled));
  
  if (DEV_MODE.enabled) {
    initDevMode();
    showDevToast('🛠️ 开发者模式已启用');
    devLog('开发者模式已启用', 'info');
  } else {
    destroyDevMode();
    showDevToast('🛠️ 开发者模式已禁用');
  }
}

// ===== 初始化开发者模式 =====
function initDevMode() {
  // 创建开发者模式 UI
  createDevUI();
  
  // 注册命令
  registerDevCommands();
  
  // 绑定快捷键
  document.addEventListener('keydown', devKeyHandler);
  
  // 开始监控
  if (DEV_MODE.monitorOpen) {
    startDevMonitor();
  }
  
  // 显示指示器
  const indicator = document.createElement('div');
  indicator.className = 'dev-indicator';
  indicator.id = 'devIndicator';
  document.body.appendChild(indicator);
  
  const badge = document.createElement('div');
  badge.className = 'dev-badge';
  badge.id = 'devBadge';
  badge.textContent = '🛠 DEV';
  badge.style.cursor = 'pointer';
  badge.title = '点击打开控制台 (Ctrl+Shift+C)';
  badge.addEventListener('click', () => {
    toggleDevConsole();
  });
  document.body.appendChild(badge);
  
  // 更新侧边栏按钮状态
  updateDevButtonState();
}

// ===== 销毁开发者模式 =====
function destroyDevMode() {
  // 移除 UI
  const consoleEl = document.getElementById('devConsole');
  if (consoleEl) consoleEl.remove();
  const monitorEl = document.getElementById('devMonitor');
  if (monitorEl) monitorEl.remove();
  const toolbarEl = document.getElementById('devToolbar');
  if (toolbarEl) toolbarEl.remove();
  const indicator = document.getElementById('devIndicator');
  if (indicator) indicator.remove();
  const badge = document.getElementById('devBadge');
  if (badge) badge.remove();
  
  // 移除键盘监听
  document.removeEventListener('keydown', devKeyHandler);
  
  DEV_MODE.enabled = false;
  updateDevButtonState();
}

// ===== 创建开发者 UI =====
function createDevUI() {
  // 控制台
  if (!document.getElementById('devConsole')) {
    const consoleHTML = `
      <div class="dev-console" id="devConsole">
        <div class="dev-console-header">
          <span>🛠 开发者控制台</span>
          <button class="dev-console-close" id="devConsoleClose">✕</button>
        </div>
        <div class="dev-log-area" id="devLogArea"></div>
        <div class="dev-command-line">
          <span class="dev-prompt">❯</span>
          <input type="text" id="devCommandInput" placeholder="输入命令... (输入 help 查看帮助)" autofocus>
          <span class="dev-command-hint">Ctrl+Shift+D 切换</span>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', consoleHTML);
    
    document.getElementById('devConsoleClose').addEventListener('click', () => {
      toggleDevConsole(false);
    });
    
    document.getElementById('devCommandInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        executeDevCommand(e.target.value);
        e.target.value = '';
      }
    });
  }
  
  // 监控面板
  if (!document.getElementById('devMonitor')) {
    const monitorHTML = `
      <div class="dev-monitor" id="devMonitor">
        <div class="dev-monitor-header">
          <span>📊 实时监控</span>
          <button class="dev-monitor-close" id="devMonitorClose">✕</button>
        </div>
        <div class="dev-monitor-grid" id="devMonitorGrid">
          <div class="dev-monitor-item"><span class="dev-monitor-label">FPS</span><span class="dev-monitor-value" id="devFps">--</span></div>
          <div class="dev-monitor-item"><span class="dev-monitor-label">内存</span><span class="dev-monitor-value" id="devMemory">--</span></div>
          <div class="dev-monitor-item"><span class="dev-monitor-label">玩家 HP</span><span class="dev-monitor-value" id="devPlayerHp">--</span></div>
          <div class="dev-monitor-item"><span class="dev-monitor-label">玩家 攻击</span><span class="dev-monitor-value" id="devPlayerAtk">--</span></div>
          <div class="dev-monitor-item"><span class="dev-monitor-label">敌人 HP</span><span class="dev-monitor-value" id="devEnemyHp">--</span></div>
          <div class="dev-monitor-item"><span class="dev-monitor-label">层数</span><span class="dev-monitor-value" id="devFloor">--</span></div>
          <div class="dev-monitor-item"><span class="dev-monitor-label">遗物数</span><span class="dev-monitor-value" id="devRelicCount">--</span></div>
          <div class="dev-monitor-item"><span class="dev-monitor-label">增益数</span><span class="dev-monitor-value" id="devBonusCount">--</span></div>
          <div class="dev-monitor-item" style="grid-column: 1 / -1; margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(247,166,35,0.08);">
            <span class="dev-monitor-label">渲染耗时</span>
            <span class="dev-monitor-value" id="devRenderTime">--</span>
          </div>
        </div>
        <div class="dev-snapshot-list" id="devSnapshotList"></div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', monitorHTML);
    
    document.getElementById('devMonitorClose').addEventListener('click', () => {
      toggleDevMonitor(false);
    });
  }
  
  // 快速操作工具栏
  if (!document.getElementById('devToolbar')) {
    const toolbarHTML = `
      <div class="dev-toolbar" id="devToolbar">
        <button class="success" data-cmd="heal">❤️ 满血</button>
        <button class="danger" data-cmd="kill">💀 秒杀</button>
        <button data-cmd="god">🛡️ 无敌</button>
        <button data-cmd="monitor">📊 监控</button>
        <button data-cmd="console">💻 控制台</button>
        <button data-cmd="tp 1">⬆ 回1层</button>
        <button data-cmd="speed 2">⏩ 加速</button>
        <button data-cmd="snapshot">📸 快照</button>
        <button data-cmd="rollback">⏪ 回滚</button>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', toolbarHTML);
    
    document.getElementById('devToolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const cmd = btn.dataset.cmd;
      if (cmd) {
        // 特殊处理：如果是命令按钮，直接执行
        if (cmd === 'monitor') {
          toggleDevMonitor();
        } else if (cmd === 'console') {
          toggleDevConsole();
        } else if (cmd === 'god') {
          executeDevCommand('god');
        } else if (cmd === 'heal') {
          executeDevCommand('heal');
        } else if (cmd === 'kill') {
          executeDevCommand('kill');
        } else if (cmd === 'snapshot') {
          executeDevCommand('snapshot');
        } else if (cmd === 'rollback') {
          executeDevCommand('rollback');
        } else {
          executeDevCommand(cmd);
        }
      }
    });
  }
}

// ===== 切换控制台 =====
function toggleDevConsole(open) {
  const consoleEl = document.getElementById('devConsole');
  if (!consoleEl) return;
  
  if (open !== undefined) {
    DEV_MODE.consoleOpen = open;
  } else {
    DEV_MODE.consoleOpen = !DEV_MODE.consoleOpen;
  }
  
  consoleEl.classList.toggle('open', DEV_MODE.consoleOpen);
  
  if (DEV_MODE.consoleOpen) {
    document.getElementById('devCommandInput').focus();
  }
  
  updateDevToolbar();
}

// ===== 切换监控面板 =====
function toggleDevMonitor(open) {
  const monitorEl = document.getElementById('devMonitor');
  if (!monitorEl) return;
  
  if (open !== undefined) {
    DEV_MODE.monitorOpen = open;
  } else {
    DEV_MODE.monitorOpen = !DEV_MODE.monitorOpen;
  }
  
  monitorEl.classList.toggle('open', DEV_MODE.monitorOpen);
  
  if (DEV_MODE.monitorOpen) {
    startDevMonitor();
  }
  
  updateDevToolbar();
}

// ===== 更新工具栏状态 =====
function updateDevToolbar() {
  const toolbar = document.getElementById('devToolbar');
  if (!toolbar) return;
  toolbar.classList.toggle('open', DEV_MODE.toolbarOpen);
}

// ===== 切换工具栏 =====
function toggleDevToolbar() {
  DEV_MODE.toolbarOpen = !DEV_MODE.toolbarOpen;
  updateDevToolbar();
}

// ===== 更新侧边栏按钮状态 =====
function updateDevButtonState() {
  const btn = document.getElementById('devModeButton');
  if (btn) {
    btn.classList.toggle('active', DEV_MODE.enabled);
    btn.textContent = DEV_MODE.enabled ? '🛠 开发者模式 (开)' : '🛠 开发者模式';
  }
  
  const consoleBtn = document.getElementById('devConsoleBtn');
  if (consoleBtn) {
    consoleBtn.style.display = DEV_MODE.enabled ? 'block' : 'none';
  }
  
  // ===== 监控按钮状态同步 =====
  const monitorBtn = document.getElementById('devMonitorBtn');
  if (monitorBtn) {
    monitorBtn.style.display = DEV_MODE.enabled ? 'block' : 'none';
    // 监控面板打开时高亮
    monitorBtn.classList.toggle('active', DEV_MODE.monitorOpen);
  }
}

// ===== 开发者日志 =====
function devLog(message, level = 'info') {
  const time = new Date().toLocaleTimeString();
  DEV_MODE.log.push({ time, message, level });
  if (DEV_MODE.log.length > 1000) DEV_MODE.log.shift();
  
  // 判断是否需要显示这条日志
  // command、warn、error、state 始终显示
  const alwaysShow = ['command', 'warn', 'error', 'state'].includes(level);
  const debugShow = DEV_MODE.debugLogs && (level === 'info' || level === 'debug');
  
  if (!alwaysShow && !debugShow) {
    return;  // 不显示，但日志已存储
  }
  
  renderDevLog();
}
// ===== 渲染开发者日志 =====
function renderDevLog() {
  const area = document.getElementById('devLogArea');
  if (!area) return;
  
  // 只显示最近 100 条
  const entries = DEV_MODE.log.slice(-100);
  area.innerHTML = entries.map(entry => `
    <div class="dev-log-entry">
      <span class="dev-log-time">[${entry.time}]</span>
      <span class="dev-log-level ${entry.level}">${entry.level.toUpperCase()}</span>
      ${entry.message}
    </div>
  `).join('');
  
  area.scrollTop = area.scrollHeight;
}

// ===== 注册开发者命令 =====
function registerDevCommands() {
  // help - 显示帮助
  registerDevCommand('help', '显示所有命令', () => {
    const cmds = Object.keys(DEV_MODE.commands);
    devLog('可用命令:', 'info');
    cmds.forEach(name => {
      const cmd = DEV_MODE.commands[name];
      devLog(`  ${name} ${cmd.usage || ''} - ${cmd.description}`, 'info');
    });
  });
  
  // tp <层数> - 跳转到指定层
  registerDevCommand('tp', '跳转到指定层: tp <层数>', (args) => {
    const floor = parseInt(args[0]);
    if (isNaN(floor) || floor < 1 || floor > MAX_FLOOR) {
      devLog('❌ 请输入有效层数 (1-999)', 'error');
      return;
    }
    
    // 重置楼层相关状态
    state.floor = floor;
    state.roomIndex = 0;
    state.rooms = generateFloorRooms(floor);
    state.currentRoom = null;
    state.combat = null;
    state.rewardOptions = [];
    state.eventOptions = [];
    state.shopOptions = [];
    state.heroSkillUsed = false;
    state.mode = 'event';
    state.gameOver = false;
    
    // 清除任何残留的选项
    state.endOptions = [];
    state.endResult = null;
    
    // 重新进入当前房间
    enterCurrentRoom();
    
    devLog(`✅ 已跳转到第 ${floor} 层`, 'command');
    render();
  });
  
    // spawn <类型> <层数> - 生成敌人，可指定层数
  registerDevCommand('spawn', '生成敌人: spawn <类型> [层数] (支持: 黑暗爪牙,骷髅骑兵,精英守卫,死尸,岩浆行者,影窃,影附身,影魅,死灵法师,层主,影之皇,镜像怪,复制法师,咕咕嘎嘎)', (args) => {
      const typeInput = args[0] || 'enemy';
      const floorArg = parseInt(args[1]);
      const targetFloor = !isNaN(floorArg) && floorArg >= 1 ? floorArg : state.floor;

      // 保存当前层数
      const originalFloor = state.floor;
      state.floor = targetFloor;

      // 获取难度修正
      let modifier = difficultyModifiers[state.difficulty] || difficultyModifiers.normal;
      if (state.difficulty === 'custom') {
          const c = normalizeCustomDifficulty(state.customDifficulty);
          modifier = {
              enemyHp: c.enemyHp || 1,
              enemyAtk: c.enemyAtk || 1,
              goldReward: c.goldReward || 1,
              shopCost: c.shopCost || 0,
              restBonus: c.restBonus || 0,
              enemyExtra: c.enemyExtra || 1
          };
      }

      const floor = state.floor;
      const base = floor * 2 + 4;
      const extraLevel = Math.max(0, floor - 10);

      // ===== 辅助函数：生成基础敌人属性 =====
      function generateBaseEnemy(hpBase, atkBase, isBoss, isElite) {
          const hp = Math.max(1, Math.round(hpBase * modifier.enemyHp));
          const atk = Math.max(1, Math.round(atkBase * modifier.enemyAtk));
          const extraMult = isBoss ? 0.8 : (isElite ? 0.5 : 0.3);
          const armorMult = (difficultyModifiers[state.difficulty]?.enemyArmor ?? 1);
          const thorn = Math.min(5, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.5));
          const dodge = Math.min(30, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.8));
          const vampire = Math.min(3, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.3));
          const combo = Math.min(25, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.6));
          const crit = Math.min(30, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.7));
          const critDamage = 150 + Math.min(50, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.5));
          const armor = Math.min(99, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * armorMult * 0.5));
          return { hp, atk, thorn, dodge, vampire, combo, crit, critDamage, armor };
      }

      // ===== 怪物类型映射 =====
      // 返回值: { type: 'enemy'|'elite'|'boss'|'mirror'|'gugugaga', name: string, custom: function }
      function getMonsterConfig(input) {
          const map = {
              // 普通敌人
              '黑暗爪牙': { type: 'enemy', name: '黑暗爪牙', custom: null },
              '爪牙': { type: 'enemy', name: '黑暗爪牙', custom: null },
              'dark_claw': { type: 'enemy', name: '黑暗爪牙', custom: null },
              '骷髅骑兵': { type: 'enemy', name: '骷髅骑兵', custom: (enemy) => { enemy.dodge = 50; enemy.combo = 40; enemy.crit = 40; enemy.critDamage = 150; } },
              '骷髅': { type: 'enemy', name: '骷髅骑兵', custom: (enemy) => { enemy.dodge = 50; enemy.combo = 40; enemy.crit = 40; enemy.critDamage = 150; } },
              'skeleton': { type: 'enemy', name: '骷髅骑兵', custom: (enemy) => { enemy.dodge = 50; enemy.combo = 40; enemy.crit = 40; enemy.critDamage = 150; } },
              // 精英敌人
              '精英守卫': { type: 'elite', name: '精英守卫', custom: null },
              '守卫': { type: 'elite', name: '精英守卫', custom: null },
              'elite_guard': { type: 'elite', name: '精英守卫', custom: null },
              '死尸': { type: 'elite', name: '死尸', custom: (enemy) => { enemy.isDeadBody = true; enemy.thorn = 1; } },
              '尸体': { type: 'elite', name: '死尸', custom: (enemy) => { enemy.isDeadBody = true; enemy.thorn = 1; } },
              'dead_body': { type: 'elite', name: '死尸', custom: (enemy) => { enemy.isDeadBody = true; enemy.thorn = 1; } },
              '岩浆行者': { type: 'elite', name: '岩浆行者', custom: (enemy) => { enemy.isLavaWalker = true; } },
              '岩浆': { type: 'elite', name: '岩浆行者', custom: (enemy) => { enemy.isLavaWalker = true; } },
              'lava_walker': { type: 'elite', name: '岩浆行者', custom: (enemy) => { enemy.isLavaWalker = true; } },
              '影（窃）': { type: 'elite', name: '影（窃）', custom: (enemy) => { enemy.isShadowThief = true; } },
              '影窃': { type: 'elite', name: '影（窃）', custom: (enemy) => { enemy.isShadowThief = true; } },
              'shadow_thief': { type: 'elite', name: '影（窃）', custom: (enemy) => { enemy.isShadowThief = true; } },
              '影（附身）': { type: 'elite', name: '影（附身）', custom: (enemy) => { enemy.isShadowPossess = true; } },
              '影附身': { type: 'elite', name: '影（附身）', custom: (enemy) => { enemy.isShadowPossess = true; } },
              'shadow_possess': { type: 'elite', name: '影（附身）', custom: (enemy) => { enemy.isShadowPossess = true; } },
              '影（魅）': { type: 'elite', name: '影（魅）', custom: (enemy) => { enemy.isShadowCharm = true; } },
              '影魅': { type: 'elite', name: '影（魅）', custom: (enemy) => { enemy.isShadowCharm = true; } },
              'shadow_charm': { type: 'elite', name: '影（魅）', custom: (enemy) => { enemy.isShadowCharm = true; } },
              '死灵法师': { type: 'elite', name: '死灵法师', custom: (enemy) => { enemy.isNecromancer = true; } },
              'necromancer': { type: 'elite', name: '死灵法师', custom: (enemy) => { enemy.isNecromancer = true; } },
              // Boss
              '层主': { type: 'boss', name: '层主', custom: null },
              'floor_boss': { type: 'boss', name: '层主', custom: null },
              '影之皇': { type: 'boss', name: '影之皇', custom: (enemy) => { enemy.isShadowKing = true; } },
              'shadow_king': { type: 'boss', name: '影之皇', custom: (enemy) => { enemy.isShadowKing = true; } },
              '皇': { type: 'boss', name: '影之皇', custom: (enemy) => { enemy.isShadowKing = true; } },
              // 镜像
              '镜像怪': { type: 'mirror', name: '镜像怪', custom: null },
              '镜像': { type: 'mirror', name: '镜像怪', custom: null },
              'mirror': { type: 'mirror', name: '镜像怪', custom: null },
              '复制法师': { type: 'mirror', name: '复制法师', custom: null },
              '复制': { type: 'mirror', name: '复制法师', custom: null },
              'copy_mage': { type: 'mirror', name: '复制法师', custom: null },
              // 特殊
              '咕咕嘎嘎': { type: 'gugugaga', name: '咕咕嘎嘎', custom: null },
              'gugugaga': { type: 'gugugaga', name: '咕咕嘎嘎', custom: null },
              '嘎嘎': { type: 'gugugaga', name: '咕咕嘎嘎', custom: null },
          };

          // 检查通用类型
          if (input === 'boss' || input === 'Boss') {
              // 随机生成Boss（70%层主，30%影之皇）
              const isShadowKing = Math.random() < 0.3;
              return isShadowKing ? map['影之皇'] : map['层主'];
          }
          if (input === 'elite' || input === '精英') {
              // 随机生成精英
              const pool = ['精英守卫', '死尸', '岩浆行者', '影（窃）', '影（附身）', '影（魅）', '死灵法师'];
              const chosen = pool[Math.floor(Math.random() * pool.length)];
              return map[chosen];
          }
          if (input === 'enemy' || input === '敌袭') {
              // 随机生成普通敌人（50%黑暗爪牙，50%骷髅骑兵）
              const isSkeleton = Math.random() < 0.5;
              return isSkeleton ? map['骷髅骑兵'] : map['黑暗爪牙'];
          }

          // 精确匹配
          const matched = map[input];
          if (matched) return matched;

          // 尝试模糊匹配
          for (const [key, config] of Object.entries(map)) {
              if (key.includes(input) || input.includes(key)) {
                  return config;
              }
          }

          return null;
      }

      const config = getMonsterConfig(typeInput);
      if (!config) {
          devLog(`❌ 未知怪物类型: "${typeInput}"`, 'error');
          state.floor = originalFloor;
          return;
      }

      // ===== 根据配置生成敌人 =====
      let enemy = null;
      let isShadowKingTriggered = false;

      // 如果是随机类型（用户输入的是boss/elite/enemy），直接调用startCombat
      if (typeInput === 'boss' || typeInput === 'Boss' ||
          typeInput === 'elite' || typeInput === '精英' ||
          typeInput === 'enemy' || typeInput === '敌袭') {
          // 调用startCombat
          const isElite = (typeInput === 'elite' || typeInput === '精英');
          const forceType = (typeInput === 'boss' || typeInput === 'Boss') ? 'boss' : null;
          // 对于enemy，forceType为null
          startCombat(isElite, forceType);
          state.floor = originalFloor;
          // 如果是Boss且生成的是影之皇，需要触发进场效果（已在startCombat中处理）
          devLog(`✅ 已生成 ${typeInput} (第 ${targetFloor} 层)`, 'command');
          render();
          return;
      }

      // ===== 具体怪物：直接构造 =====
      const name = config.name;
      const type = config.type;

      if (type === 'gugugaga') {
          // 咕咕嘎嘎特殊处理
          const hp = Math.max(1, Math.round(40 * modifier.enemyHp));
          const atk = Math.max(1, Math.round(3 * modifier.enemyAtk));
          const extraMult = 0.3;
          const thorn = Math.min(5, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.5));
          const dodge = Math.min(30, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.8));
          const vampire = Math.min(3, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.3));
          const combo = Math.min(25, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.6));
          const crit = Math.min(30, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.7));
          const critDamage = 150 + Math.min(50, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * 0.5));
          const armorMult = (difficultyModifiers[state.difficulty]?.enemyArmor ?? 1);
          const armor = Math.min(99, Math.round(extraLevel * extraMult * (modifier.enemyExtra || 1) * armorMult * 0.5));
          enemy = {
              name: '咕咕嘎嘎',
              hp: hp,
              maxHp: hp,
              attack: atk,
              thorn: thorn,
              dodge: dodge,
              vampire: vampire,
              combo: combo,
              crit: crit,
              critDamage: critDamage,
              armor: armor,
              firstStrikeReduction: 0,
              tempAttackBonus: 0,
              dodgeBonus: 0,
              critBonus: 0,
              critDamageBonus: 0,
              comboBonus: 0,
              attackPercentMod: 1,
              isGugugaga: true,
          };
      } else if (type === 'mirror') {
          // 镜像怪物
          const isMirror = (name === '镜像怪');
          const attackPercent = isMirror ? 0.4 : 0.75;
          const hpPercent = isMirror ? 0.5 : 0.9;
          const baseAtk = Math.max(1, Math.round(state.player.attack * attackPercent));
          const baseHp = Math.max(1, Math.round(state.player.hp * hpPercent));
          const baseStats = generateBaseEnemy(baseHp, baseAtk, false, false);
          enemy = {
              name: name,
              hp: baseStats.hp,
              maxHp: baseStats.hp,
              attack: baseStats.atk,
              thorn: baseStats.thorn,
              dodge: baseStats.dodge,
              vampire: baseStats.vampire,
              combo: baseStats.combo,
              crit: baseStats.crit,
              critDamage: baseStats.critDamage,
              armor: baseStats.armor,
              firstStrikeReduction: 0,
              tempAttackBonus: 0,
              dodgeBonus: 0,
              critBonus: 0,
              critDamageBonus: 0,
              comboBonus: 0,
              attackPercentMod: 1,
              isMirror: true,
          };
      } else if (type === 'boss') {
          // Boss（层主或影之皇）
          const hpBase = base + 10;
          const atkBase = 5 + Math.floor(floor / 2);
          const baseStats = generateBaseEnemy(hpBase, atkBase, true, false);
          enemy = {
              name: name,
              hp: baseStats.hp,
              maxHp: baseStats.hp,
              attack: baseStats.atk,
              thorn: baseStats.thorn,
              dodge: baseStats.dodge,
              vampire: baseStats.vampire,
              combo: baseStats.combo,
              crit: baseStats.crit,
              critDamage: baseStats.critDamage,
              armor: baseStats.armor,
              firstStrikeReduction: 0,
              tempAttackBonus: 0,
              dodgeBonus: 0,
              critBonus: 0,
              critDamageBonus: 0,
              comboBonus: 0,
              attackPercentMod: 1,
          };
          if (name === '影之皇') {
              enemy.isShadowKing = true;
              // 触发影之皇进场效果
              const roll = Math.random();
              if (roll < 0.3) {
                  state.nextDamageIncrease = 40;
                  addLog('你被影之皇的深渊能量污染，下次受到的伤害增加40%');
              } else if (roll < 0.6) {
                  state.player.shield = 0;
                  addLog('你被影之皇的深渊能量污染，护盾值归零');
              } else if (roll < 0.9) {
                  const backup = {
                      luckyLevel: state.luckyLevel || 0,
                      critDamage: state.critDamage || 150,
                      thornLevel: state.thornLevel || 0,
                      vampireLevel: state.vampireLevel || 0,
                      dodgeLevel: state.dodgeLevel || 0,
                      comboLevel: state.comboLevel || 0,
                      executeLevel: state.executeLevel || 0,
                  };
                  state.luckyLevel = 0;
                  state.critDamage = 150;
                  state.thornLevel = 0;
                  state.vampireLevel = 0;
                  state.dodgeLevel = 0;
                  state.comboLevel = 0;
                  state.executeLevel = 0;
                  state.shadowKingSealBackup = backup;
                  addLog('你被影之皇的深渊能量污染，部分力量被影之皇封印');
              }
              isShadowKingTriggered = true;
          }
      } else if (type === 'elite') {
          // 精英
          let hpBase, atkBase;
          switch (name) {
              case '精英守卫':
                  hpBase = base + 6;
                  atkBase = 4 + Math.floor(floor / 2);
                  break;
              case '死尸':
                  hpBase = base + 6;
                  atkBase = 4 + Math.floor(floor / 2);
                  break;
              case '岩浆行者':
                  hpBase = base + 6;
                  atkBase = 4 + Math.floor(floor / 2);
                  break;
              case '影（窃）':
                  hpBase = 9;
                  atkBase = 4;
                  break;
              case '影（附身）':
                  hpBase = 5;
                  atkBase = 8;
                  break;
              case '影（魅）':
                  hpBase = 8;
                  atkBase = 4;
                  break;
              case '死灵法师':
                  hpBase = 7;
                  atkBase = 8;
                  break;
              default:
                  hpBase = base + 6;
                  atkBase = 4 + Math.floor(floor / 2);
          }
          const baseStats = generateBaseEnemy(hpBase, atkBase, false, true);
          enemy = {
              name: name,
              hp: baseStats.hp,
              maxHp: baseStats.hp,
              attack: baseStats.atk,
              thorn: baseStats.thorn,
              dodge: baseStats.dodge,
              vampire: baseStats.vampire,
              combo: baseStats.combo,
              crit: baseStats.crit,
              critDamage: baseStats.critDamage,
              armor: baseStats.armor,
              firstStrikeReduction: 0,
              tempAttackBonus: 0,
              dodgeBonus: 0,
              critBonus: 0,
              critDamageBonus: 0,
              comboBonus: 0,
              attackPercentMod: 1,
          };
          // 应用自定义修改
          if (config.custom) {
              config.custom(enemy);
          }
      } else {
          // 普通敌人
          const isSkeleton = (name === '骷髅骑兵');
          const hpBase = isSkeleton ? 8 : base;
          const atkBase = isSkeleton ? 4 : (3 + Math.floor(floor / 2));
          const baseStats = generateBaseEnemy(hpBase, atkBase, false, false);
          enemy = {
              name: name,
              hp: baseStats.hp,
              maxHp: baseStats.hp,
              attack: baseStats.atk,
              thorn: baseStats.thorn,
              dodge: isSkeleton ? 50 : baseStats.dodge,
              vampire: baseStats.vampire,
              combo: isSkeleton ? 40 : baseStats.combo,
              crit: isSkeleton ? 40 : baseStats.crit,
              critDamage: isSkeleton ? 150 : baseStats.critDamage,
              armor: baseStats.armor,
              firstStrikeReduction: 0,
              tempAttackBonus: 0,
              dodgeBonus: 0,
              critBonus: 0,
              critDamageBonus: 0,
              comboBonus: 0,
              attackPercentMod: 1,
          };
          // 应用自定义修改
          if (config.custom) {
              config.custom(enemy);
          }
      }

      // ===== 设置战斗 =====
      state.combat = { enemy, turn: 1 };
      state.combat.playerMaxHpSnapshot = state.player.maxHp;
      state.combat.environment = state.environment
          ? rebuildEnvironmentFromTemplate(state.environment, state.floor)
          : null;

      state.player.attackPercentMod = 1;
      enemy.attackPercentMod = 1;

      const env = state.combat.environment;
      if (env && typeof env.onCombatStart === 'function') {
          env.onCombatStart(state.player, enemy);
      }

      state.mode = 'combat';
      state.heroSkillBonus = 0;
      state.heroPendingHeal = 0;
      state.isFirstAttack = true;
      state.comboCount = 0;
      state.executeCount = 0;
      state.dodgeCount = 0;
      state.critCount = 0;

      if (state.hero?.skill?.onCombatStart) {
          state.hero.skill.onCombatStart();
      }

      // 命运轮盘效果
      if (state.hasFateWheel) {
          if (Math.random() < 0.5) {
              state.player.shield += 20;
              addLog(`🎡 命运轮盘：获得 20 点护盾！`);
              spawnDamageFloat(20, 'shield');
          } else {
              state.player.hp = Math.max(1, state.player.hp - 5);
              addLog(`🎡 命运轮盘：扣除 5 点生命...`);
              spawnDamageFloat(5, 'damage');
          }
          state.hasFateWheel = false;
      }

      // 恢复层数
      state.floor = originalFloor;

      const shadowKingMsg = isShadowKingTriggered ? ' (已触发进场效果)' : '';
      devLog(`✅ 已生成 ${name} (第 ${targetFloor} 层)${shadowKingMsg}`, 'command');
      render();
  });
  
  // add <遗物名> - 添加遗物
  registerDevCommand('add', '添加遗物: add <遗物名>', (args) => {
    const name = args.join(' ');
    if (!name) {
      devLog('❌ 请指定遗物名称', 'error');
      return;
    }
    const relics = getRelicOptions();
    const matched = relics.find(r => r.label.includes(name));
    if (matched) {
      state.relics.push(matched);
      matched.apply();
      devLog(`✅ 添加遗物: ${matched.label}`, 'command');
      render();
      renderRelics();
    } else {
      devLog(`❌ 未找到遗物: "${name}"`, 'error');
    }
  });
  
  // clear - 清空日志
  registerDevCommand('clear', '清空开发者日志', () => {
    DEV_MODE.log = [];
    renderDevLog();
    devLog('✅ 日志已清空', 'command');
  });
  
  // state - 打印状态
  registerDevCommand('state', '打印完整游戏状态', () => {
    const stateStr = JSON.stringify(state, (key, value) => {
      if (typeof value === 'function') return '[Function]';
      return value;
    }, 2);
    devLog('📊 当前游戏状态:', 'state');
    console.log('📊 游戏状态:', state);
    // 截断显示，避免日志过多
    const shortState = stateStr.length > 5000 ? stateStr.slice(0, 5000) + '... (截断)' : stateStr;
    devLog(shortState, 'state');
  });
  
  // debug <on|off> - 切换调试日志
  registerDevCommand('debug', '切换调试日志: debug <on|off>', (args) => {
    const mode = args[0];
    if (mode === 'on') {
      DEV_MODE.debugLogs = true;
      devLog('✅ 调试日志已开启 - 现在会显示所有 info 级别日志', 'command');
    } else if (mode === 'off') {
      DEV_MODE.debugLogs = false;
      devLog('✅ 调试日志已关闭 - 只显示命令和错误信息', 'command');
    } else {
      DEV_MODE.debugLogs = !DEV_MODE.debugLogs;
      devLog(`✅ 调试日志已${DEV_MODE.debugLogs ? '开启' : '关闭'}`, 'command');
    }
    renderDevLog();
  });
  
  // speed <倍数> - 动画加速
  registerDevCommand('speed', '动画加速: speed <倍数> (0.5-5)', (args) => {
    const speed = parseFloat(args[0]);
    if (isNaN(speed) || speed < 0.5 || speed > 5) {
      devLog('❌ 请输入有效倍数 (0.5-5)', 'error');
      return;
    }
    DEV_MODE.speedMultiplier = speed;
    // 修改 CSS 动画速度
    document.querySelectorAll('.damage-float, .floor-banner, .relic-badge').forEach(el => {
      el.style.animationDuration = `${0.9 / speed}s`;
    });
    devLog(`✅ 动画速度已设为 ${speed}x`, 'command');
  });
  
  // kill - 秒杀当前敌人
  registerDevCommand('kill', '秒杀当前敌人', () => {
      if (!state.combat || !state.combat.enemy) {
          devLog('❌ 没有进行中的战斗', 'error');
          return;
      }
      state.combat.enemy.hp = 0;
      devLog('💀 已秒杀敌人', 'command');
      if (state.combat.enemy.hp <= 0) {
          const enemy = state.combat.enemy;
          let goldGain = Math.max(1, Math.round((8 + state.floor) * (difficultyModifiers[state.difficulty]?.goldReward || 1)));
          if (state.hasDoubleGold) goldGain = Math.round(goldGain * 1.5);
          state.player.gold += goldGain;
          let xpGain = Math.max(1, Math.round((5 + state.floor) * (state.hasExpBoost ? 1.5 : 1)));
          state.player.xp = (state.player.xp || 0) + xpGain;
          if (state.hero?.skill?.onVictory) state.hero.skill.onVictory();
          clearTempCombatBonuses();   // ← 出口清理（开发者秒杀）
          if (state.currentRoom.type === 'boss') {
              state.endOptions = getEndOptions();
              state.rewardOptions = buildRewardOptions();
              state.mode = 'bossVictory';
          } else {
              state.mode = 'reward';
              state.rewardOptions = buildRewardOptions();
          }
          render();
      }
  });

  
  // heal - 满血
  registerDevCommand('heal', '恢复满血', () => {
    state.player.hp = state.player.maxHp;
    devLog(`✅ 已恢复满血`, 'command');
    render();
  });
  
  // god - 无敌模式
  registerDevCommand('god', '切换无敌模式', () => {
    DEV_MODE.godMode = !DEV_MODE.godMode;
    devLog(`✅ 无敌模式已${DEV_MODE.godMode ? '开启' : '关闭'}`, 'command');
    if (DEV_MODE.godMode) {
      state.player.maxHp = 9999;
      state.player.hp = 9999;
      state.player.attack = 999;
      render();
    } else {
      // 恢复正常数值（需要重新计算）
      if (state.hero) {
        state.player.maxHp = state.hero.stats.hp;
        state.player.hp = state.hero.stats.hp;
        state.player.attack = state.hero.stats.attack;
      } else {
        state.player.maxHp = 24;
        state.player.hp = 24;
        state.player.attack = 5;
      }
      render();
    }
  });
  
  // snapshot - 保存快照
  registerDevCommand('snapshot', '保存当前状态快照', () => {
    const snapshot = {
      id: Date.now(),
      time: new Date().toLocaleTimeString(),
      state: JSON.parse(JSON.stringify(state, (key, value) => {
        if (typeof value === 'function') return undefined;
        return value;
      }))
    };
    DEV_MODE.snapshots.push(snapshot);
    if (DEV_MODE.snapshots.length > DEV_MODE.maxSnapshots) {
      DEV_MODE.snapshots.shift();
    }
    devLog(`📸 已保存快照 #${DEV_MODE.snapshots.length} (${snapshot.time})`, 'command');
    renderDevSnapshots();
  });
  
  // rollback - 回滚到最新快照
  registerDevCommand('rollback', '回滚到最新快照', () => {
    if (DEV_MODE.snapshots.length === 0) {
      devLog('❌ 没有可用的快照', 'error');
      return;
    }
    const snapshot = DEV_MODE.snapshots[DEV_MODE.snapshots.length - 1];
    Object.assign(state, snapshot.state);
    // 快照是 JSON 深拷贝，函数在里面同样会丢
    restoreHeroSkillBinding(state.hero);
    restoreHeroSkillBinding(state.trial && state.trial.hero);
    devLog(`⏪ 已回滚到快照 #${DEV_MODE.snapshots.length} (${snapshot.time})`, 'command');
    render();
    renderRelics();
  });
  
  // event <关键词> [auto] 命令
  registerDevCommand('event', '触发指定事件或房间: event <关键词> [auto] (支持: 事件名, rest, treasure, shop)', (args) => {
    const keyword = args[0];
    const auto = args[1] === 'auto';
    if (!keyword) {
      devLog('❌ 请输入事件关键词或房间类型 (rest, treasure, shop)', 'error');
      return;
    }

    // 先检查是否为特殊房间类型
    const roomTypes = ['rest', 'treasure', 'shop'];
    if (roomTypes.includes(keyword)) {
      if (!state.currentRoom) {
        devLog('❌ 当前没有房间，无法触发', 'error');
        return;
      }
      // 修改当前房间类型
      state.currentRoom.type = keyword;
      // 重置模式为 event，以便 resolveEvent 处理
      state.mode = 'event';
      resolveEvent();
      render();
      devLog(`✅ 已触发 ${keyword} 房间`, 'command');
      return;
    }

    // 否则按原有逻辑匹配事件
    const matched = ALL_EVENT_OPTIONS.find(e => e.label.includes(keyword));
    if (!matched) {
      devLog(`❌ 未找到匹配的事件: "${keyword}"`, 'error');
      return;
    }
    if (auto) {
      devLog(`自动执行事件: ${matched.label}`, 'command');
      matched.apply();
      if (state.mode === 'event') {
        advanceRoom();
      }
      render();
    } else {
      state.eventOptions = [matched];
      state.mode = 'eventChoice';
      render();
      devLog(`✅ 已触发事件: ${matched.label}，点击按钮执行`, 'command');
    }
  });
  
  // battle <生命> <攻击> <荆棘> <闪避> <吸血> <连击> <暴击率> <暴击伤害> <减伤>- 设置敌人属性
  registerDevCommand('battle', '设置敌人属性: battle <生命> <攻击> <荆棘> <闪避> <吸血> <连击> <暴击率> <暴击伤害> [减伤]', (args) => {
    if (!state.combat || !state.combat.enemy) {
      devLog('❌ 没有进行中的战斗', 'error');
      return;
    }
    const enemy = state.combat.enemy;
    const hp = parseInt(args[0]);
    const atk = parseInt(args[1]);
    const thorn = parseInt(args[2]);
    const dodge = parseInt(args[3]);
    const vampire = parseInt(args[4]);
    const combo = parseInt(args[5]);
    const crit = parseInt(args[6]);
    const critDamage = parseInt(args[7]);
    const armor = parseInt(args[8]);
    
    if (!isNaN(hp) && hp > 0) {
      enemy.hp = hp;
      enemy.maxHp = hp;
    }
    if (!isNaN(atk) && atk >= 0) {
      enemy.attack = atk;
    }
    if (!isNaN(thorn) && thorn >= 0) {
      enemy.thorn = Math.min(thorn, 5);
    }
    if (!isNaN(dodge) && dodge >= 0) {
      enemy.dodge = Math.min(dodge, 30);
    }
    if (!isNaN(vampire) && vampire >= 0) {
      enemy.vampire = Math.min(vampire, 3);
    }
    if (!isNaN(combo) && combo >= 0) {
      enemy.combo = Math.min(combo, 25);
    }
    if (!isNaN(crit) && crit >= 0) {
      enemy.crit = Math.min(crit, 30);
    }
    if (!isNaN(critDamage) && critDamage >= 100) {
      enemy.critDamage = Math.min(critDamage, 300);
    }
    if (!isNaN(armor) && armor >= 0) {
      enemy.armor = Math.min(armor, 99);
    }

    devLog(`✅ 敌人属性已设置: HP ${enemy.hp}, 攻击 ${enemy.attack}, 荆棘 ${enemy.thorn}, 闪避 ${enemy.dodge}%, 吸血 ${enemy.vampire}, 连击 ${enemy.combo}%, 暴击 ${enemy.crit}%, 暴击伤害 ${enemy.critDamage}%, 减伤 ${enemy.armor}%`, 'command');
    render();
  });
  
  // monitor - 切换监控面板
  registerDevCommand('monitor', '切换监控面板', () => {
    toggleDevMonitor();
  });
  
  // console - 切换控制台
  registerDevCommand('console', '切换控制台', () => {
    toggleDevConsole();
  });
  
  // toolbar - 切换工具栏
  registerDevCommand('toolbar', '切换快速工具栏', () => {
    toggleDevToolbar();
  });
  
  // trial - 试炼相关命令
  // 试炼相关的开发者命令已随试炼关停一并移除（P5）。
  // 想看老版的试炼调试：切到 老版2.6/ 用那边的开发者模式。
  /* ===== 实时战斗（2D）专用命令（P4）=====
   * 全部委托给 window.经典2D.cheat —— 与作弊面板同一套实现，
   * 保证「面板上能改的」与「命令里能改的」永远一致。 */
  registerDevCommand('room', '跳到本层指定房间: room <序号，从 0 起>', (args) => {
    const c = window.经典2D && window.经典2D.cheat;
    if (!c) return devLog('实时战斗未启动（当前是回合制界面）');
    const i = Number(args[0]);
    if (!isFinite(i)) return devLog('用法: room <序号>');
    c.gotoRoom(i);
    devLog(`已跳到本层第 ${i} 间`);
  });

  registerDevCommand('floor', '跳到指定层: floor <层数>', (args) => {
    const c = window.经典2D && window.经典2D.cheat;
    if (!c) return devLog('实时战斗未启动（当前是回合制界面）');
    const n = Number(args[0]);
    if (!isFinite(n) || n < 1) return devLog('用法: floor <层数>');
    c.gotoFloor(n);
    devLog(`已跳到第 ${n} 层`);
  });

  registerDevCommand('relic', '添加遗物: relic <id|中文名>', (args) => {
    const c = window.经典2D && window.经典2D.cheat;
    if (!c) return devLog('实时战斗未启动（当前是回合制界面）');
    if (!args.length) return devLog('用法: relic <id|中文名>，多个用逗号分隔');
    // 命令行按空格切参数，所以「relic A,B」到这里是一整段 —— 再按逗号拆一次
    const names = args.join(' ').split(/[，,;；|]/).map(x => x.trim()).filter(Boolean);
    let ok = 0;
    names.forEach(n => { if (c.addRelic(n)) ok += 1; });
    devLog(`已获得 ${ok}/${names.length} 件遗物` + (ok ? '' : '（检查名称是否正确）'));
  });

  registerDevCommand('curse', '诅咒: curse <名称...> | curse clear', (args) => {
    const c = window.经典2D && window.经典2D.cheat;
    if (!c) return devLog('实时战斗未启动（当前是回合制界面）');
    if (!args.length) return devLog('用法: curse <名称...> 或 curse clear');
    if (args[0] === 'clear') { c.clearCurses(); return devLog('已清除所有诅咒'); }
    const names = args.join(' ').split(/[，,;；|]/).map(x => x.trim()).filter(Boolean);
    let ok = 0;
    names.forEach(n => { if (c.addCurse(n)) ok += 1; });
    devLog(`已施加 ${ok}/${names.length} 条诅咒（表外名字会被忽略）`);
  });

  registerDevCommand('rtdebug', '打印实时战斗引擎状态（含机制常量与遗物系数）', () => {
    const e = window.战斗2D;
    if (!e) return devLog('2D 引擎未加载');
    const d = e.debug();
    devLog(`2D: ready=${d.ready} running=${d.running} floor=${d.floor} room=${d.room ? d.room.type : '-'} `
      + `hp=${d.hero ? d.hero.hp : '-'} 敌=${d.enemiesAlive}/${d.enemiesTotal} 面板=${d.choiceOpen ? d.choiceKind : '-'}`);
    if (d.mech) devLog('mech: ' + JSON.stringify(d.mech));
    if (d.relicFx) devLog('遗物系数: ' + JSON.stringify(d.relicFx));
    if (d.pulse) devLog('脉冲: 间隔 ' + d.pulse.interval + 'ms · 剩余 ' + d.pulse.leftMs + 'ms');
    console.log('[DevMode.rtdebug]', d);
  });

  registerDevCommand('god2d', '实时战斗无敌: god2d [on|off]', (args) => {
    const e = window.战斗2D;
    if (!e || typeof e.setGodMode !== 'function') return devLog('2D 引擎未加载');
    const want = args[0] === 'off' ? false : (args[0] === 'on' ? true : !e.isGodMode());
    e.setGodMode(want);
    devLog('实时战斗无敌：' + (want ? '开' : '关'));
  });

  registerDevCommand('ending', '直接触发结局面板（不看楼层上限）', () => {
    const h = window.经典2D;
    if (!h || typeof h.checkEnding !== 'function') return devLog('宿主未加载');
    devLog(h.checkEnding() ? '已打开结局面板' : '当前条件不满足（或未到楼层上限）');
  });

  registerDevCommand('relics', '列出本局已有遗物与诅咒', () => {
    const c = window.经典2D && window.经典2D.cheat;
    if (!c) return devLog('实时战斗未启动（当前是回合制界面）');
    const s0 = c.snapshot();
    devLog('遗物：' + (s0.relics.length ? s0.relics.join('、') : '（无）'));
    devLog('诅咒：' + (s0.curses.length ? s0.curses.join('、') : '（无）'));
  });

  registerDevCommand('open', '打开指定页面: open <路径> (支持: 测试面板, 音频测试)', (args) => {
    const target = args[0];
    if (!target) {
      devLog('❌ 请指定要打开的页面: open 测试面板 | open 音频测试', 'error');
      return;
    }
    // 页面路径映射（测试/ 表示 测试文件夹下）
    const pageMap = {
      '测试面板': '测试/测试面板.html',
      '音频测试': '测试/音频测试.html',
      // 兼容旧指令
      '测试': '测试/测试面板.html',
      'test': '测试/测试面板.html'
    };
    if (pageMap[target]) {
      window.open(pageMap[target], '_blank');
      devLog(`✅ 已打开${target}`, 'command');
    } else {
      devLog(`❌ 未知页面: "${target}"，当前仅支持: 测试面板, 音频测试`, 'error');
    }
  });
  // 1 - 重复上一条指令
  registerDevCommand('1', '重复上一条指令: 1 [次数] (默认1次)', (args) => {
    let repeatCount = 1;
    if (args.length > 0) {
      const parsed = parseInt(args[0]);
      if (!isNaN(parsed) && parsed > 0) {
        repeatCount = parsed;
      } else {
        devLog(`❌ 无效的重复次数: "${args[0]}"，使用默认值1`, 'error');
      }
    }
    // 限制最大重复次数为100，防止意外死循环
    if (repeatCount > 100) {
      devLog(`⚠️ 重复次数超过上限100，已自动调整为100`, 'warn');
      repeatCount = 100;
    }

    if (!DEV_MODE.lastCommand || DEV_MODE.lastCommand.trim() === '') {
      devLog('输入 "help" 查看帮助', 'info');
      return;
    }

    const lastInput = DEV_MODE.lastCommand;
    const parts = lastInput.trim().split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const cmdArgs = parts.slice(1);
    const cmd = DEV_MODE.commands[cmdName];

    if (!cmd) {
      devLog(`❌ 上一条指令 "${cmdName}" 已失效`, 'error');
      return;
    }

    let successCount = 0;
    for (let i = 0; i < repeatCount; i++) {
      try {
        cmd.fn(cmdArgs);
        successCount++;
      } catch (e) {
        devLog(`❌ 第 ${i+1} 次执行失败: ${e.message}`, 'error');
        console.error('命令执行错误:', e);
        break;
      }
    }

    if (successCount > 0 && successCount !== repeatCount) {
      devLog(`⚠️ 执行了 ${successCount}/${repeatCount} 次后停止`, 'warn');
    } else if (successCount > 1) {
      // 仅在成功执行多次时输出汇总信息，避免刷屏
      devLog(`✅ 已重复执行 ${successCount} 次`, 'command');
    }
  });
}

// ===== 注册单个命令 =====
function registerDevCommand(name, description, fn, usage = '') {
  DEV_MODE.commands[name] = { description, fn, usage };
}

// ===== 执行命令 =====
function executeDevCommand(input) {
  if (!input || input.trim() === '') return;
  
  const parts = input.trim().split(/\s+/);
  const cmdName = parts[0].toLowerCase();
  const args = parts.slice(1);
  
  devLog(`❯ ${input}`, 'command');
  
  const cmd = DEV_MODE.commands[cmdName];
  if (cmd) {
    try {
      cmd.fn(args);
      // 记录上一条指令（排除自身）
      if (cmdName !== '1') {
        DEV_MODE.lastCommand = input;
      }
    } catch (e) {
      devLog(`❌ 命令执行错误: ${e.message}`, 'error');
      console.error('命令执行错误:', e);
    }
  } else {
    devLog(`❌ 未知命令: "${cmdName}" (输入 help 查看帮助)`, 'error');
  }
}

// ===== 键盘快捷键处理 =====
function devKeyHandler(e) {
  // Ctrl+Shift+D 切换开发者模式
  if (e.ctrlKey && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
    e.preventDefault();
    // 从侧边栏触发切换
    const btn = document.getElementById('devModeButton');
    if (btn) btn.click();
    return;
  }
  
  // Ctrl+Shift+C 切换控制台
  if (e.ctrlKey && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
    e.preventDefault();
    toggleDevConsole();
    return;
  }
  
  // Ctrl+Shift+M 切换监控
  if (e.ctrlKey && e.shiftKey && (e.key === 'm' || e.key === 'M')) {
    e.preventDefault();
    toggleDevMonitor();
    return;
  }
  
  // 控制台打开时，ESC 关闭
  if (e.key === 'Escape' && DEV_MODE.consoleOpen) {
    toggleDevConsole(false);
    return;
  }
}

// ===== 启动监控 =====
function startDevMonitor() {
  if (!DEV_MODE.monitorOpen) return;
  
  // 更新监控数据
  updateDevMonitor();
  
  // 每 500ms 更新一次
  if (window._devMonitorInterval) {
    clearInterval(window._devMonitorInterval);
  }
  window._devMonitorInterval = setInterval(updateDevMonitor, 500);
}

// ===== 更新监控数据 =====
function updateDevMonitor() {
  const p = state.player;
  const enemy = state.combat?.enemy;
  
  const elements = {
    'devFps': '--',
    'devMemory': '--',
    'devPlayerHp': p ? `${p.hp}/${p.maxHp}` : '--',
    'devPlayerAtk': p ? p.attack : '--',
    'devEnemyHp': enemy ? `${enemy.hp}/${enemy.maxHp}` : '--',
    'devFloor': state.floor || '--',
    'devRelicCount': state.relics?.length || 0,
    'devBonusCount': state.bonuses?.length || 0,
    'devRenderTime': '--'
  };
  
  // FPS 计算
  if (window._devFrameCount === undefined) {
    window._devFrameCount = 0;
    window._devFrameTime = performance.now();
  }
  window._devFrameCount++;
  const now = performance.now();
  if (now - window._devFrameTime > 1000) {
    elements.devFps = window._devFrameCount;
    window._devFrameCount = 0;
    window._devFrameTime = now;
  }
  
  // 内存估算（粗略）
  try {
    if (performance.memory) {
      const memMB = (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1);
      elements.devMemory = `${memMB}MB`;
    } else {
      elements.devMemory = 'N/A';
    }
  } catch (e) {
    elements.devMemory = 'N/A';
  }
  
  // 渲染耗时
  if (DEV_MODE.renderTimes.length > 0) {
    const avg = DEV_MODE.renderTimes.reduce((a, b) => a + b, 0) / DEV_MODE.renderTimes.length;
    elements.devRenderTime = `${avg.toFixed(1)}ms`;
  }
  
  // 更新 DOM
  Object.keys(elements).forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const value = elements[id];
      el.textContent = String(value);
      
      // 特殊样式
      if (id === 'devPlayerHp' && p) {
        const ratio = p.hp / p.maxHp;
        el.className = 'dev-monitor-value ' + (ratio > 0.5 ? 'good' : ratio > 0.2 ? 'warn' : 'bad');
      }
      if (id === 'devEnemyHp' && enemy) {
        const ratio = enemy.hp / enemy.maxHp;
        el.className = 'dev-monitor-value ' + (ratio > 0.5 ? 'good' : ratio > 0.2 ? 'warn' : 'bad');
      }
    }
  });
}

// ===== 渲染快照列表 =====
function renderDevSnapshots() {
  const list = document.getElementById('devSnapshotList');
  if (!list) return;
  
  if (DEV_MODE.snapshots.length === 0) {
    list.innerHTML = '<div style="color:var(--dev-muted);font-size:0.65rem;text-align:center;padding:4px 0;">暂无快照</div>';
    return;
  }
  
  list.innerHTML = DEV_MODE.snapshots.map((s, i) => `
    <div class="dev-snapshot-item">
      <span class="snapshot-time">#${i+1} ${s.time}</span>
      <span class="snapshot-actions">
        <button onclick="restoreDevSnapshot(${i})">↺</button>
        <button onclick="deleteDevSnapshot(${i})" style="color:var(--dev-danger);">✕</button>
      </span>
    </div>
  `).join('');
}

// ===== 恢复快照 =====
function restoreDevSnapshot(index) {
  const snapshot = DEV_MODE.snapshots[index];
  if (!snapshot) return;
  Object.assign(state, snapshot.state);
  // 快照是 JSON 深拷贝，函数在里面同样会丢
  restoreHeroSkillBinding(state.hero);
  restoreHeroSkillBinding(state.trial && state.trial.hero);
  devLog(`⏪ 已回滚到快照 #${index+1} (${snapshot.time})`, 'command');
  render();
  renderRelics();
}

// ===== 删除快照 =====
function deleteDevSnapshot(index) {
  DEV_MODE.snapshots.splice(index, 1);
  renderDevSnapshots();
  devLog(`🗑️ 已删除快照 #${index+1}`, 'command');
}

// ===== Toast 提示 =====
function showDevToast(message) {
  const oldToast = document.querySelector('.dev-toast');
  if (oldToast) oldToast.remove();
  
  const toast = document.createElement('div');
  toast.className = 'dev-toast';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    top: 60px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(15, 22, 44, 0.95);
    color: var(--dev-primary);
    padding: 10px 24px;
    border-radius: 10px;
    border: 1px solid var(--dev-border);
    box-shadow: 0 8px 40px rgba(0,0,0,0.5);
    z-index: 999999;
    font-size: 0.9rem;
    animation: devToastIn 0.3s ease;
    backdrop-filter: blur(8px);
    font-family: "Microsoft YaHei", sans-serif;
    max-width: 90vw;
  `;
  
  const style = document.createElement('style');
  style.textContent = `
    @keyframes devToastIn {
      from { opacity: 0; transform: translateX(-50%) translateY(-20px) scale(0.95); }
      to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
    }
    @keyframes devToastOut {
      from { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
      to { opacity: 0; transform: translateX(-50%) translateY(-20px) scale(0.95); }
    }
  `;
  document.head.appendChild(style);
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'devToastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ===== 添加侧边栏开发者按钮 =====
function addDevModeButton() {
  const sidebarBody = document.querySelector('.sidebar-body');
  if (!sidebarBody) return;
  
  // 检查是否已存在
  if (document.getElementById('devModeButton')) return;
  
  // 开发者模式切换按钮
  const btn = document.createElement('button');
  btn.id = 'devModeButton';
  btn.className = 'dev-toggle-btn';
  btn.textContent = DEV_MODE.enabled ? '🛠 开发者模式 (开)' : '🛠 开发者模式';
  btn.addEventListener('click', () => {
    toggleDevMode();
  });
  
  // 控制台快捷按钮（仅在开发者模式启用时显示）
  const consoleBtn = document.createElement('button');
  consoleBtn.id = 'devConsoleBtn';
  consoleBtn.className = 'dev-toggle-btn';
  consoleBtn.textContent = '💻 打开控制台';
  consoleBtn.style.display = DEV_MODE.enabled ? 'block' : 'none';
  consoleBtn.addEventListener('click', () => {
    if (!DEV_MODE.enabled) {
      showDevToast('⚠️ 请先启用开发者模式');
      return;
    }
    
    if (window.sidebar && typeof window.sidebar.close === 'function') {
      window.sidebar.close();
    }
    toggleDevConsole();
  });
  
  // ===== 监控面板按钮（新增） =====
  const monitorBtn = document.createElement('button');
  monitorBtn.id = 'devMonitorBtn';
  monitorBtn.className = 'dev-toggle-btn';
  monitorBtn.textContent = '📊 监控面板';
  monitorBtn.style.display = DEV_MODE.enabled ? 'block' : 'none';
  monitorBtn.addEventListener('click', () => {
    if (!DEV_MODE.enabled) {
      showDevToast('⚠️ 请先启用开发者模式');
      return;
    }
    
    if (window.sidebar && typeof window.sidebar.close === 'function') {
      window.sidebar.close();
    }
    toggleDevMonitor();
  });
  
  // 插入到作弊按钮之后
  const cheatBtn = sidebarBody.querySelector('#cheatButton');
  if (cheatBtn) {
    cheatBtn.after(btn);
    btn.after(consoleBtn);
    consoleBtn.after(monitorBtn);
  } else {
    sidebarBody.prepend(btn);
    btn.after(consoleBtn);
    consoleBtn.after(monitorBtn);
  }
}
// ===== 开始界面彩蛋：点击版本号5次触发 =====
function initDevEasterEgg() {
  let clickCount = 0;
  let timer = null;
  
  const versionEl = document.querySelector('.start-version');
  if (!versionEl) return;
  
  versionEl.addEventListener('click', () => {
    clickCount++;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { clickCount = 0; }, 2000);
    
    if (clickCount >= 5) {
      clickCount = 0;
      if (!DEV_MODE.enabled) {
        toggleDevMode();
        showDevToast('🎉 开发者模式已激活！');
      } else {
        showDevToast('🛠 开发者模式已开启');
      }
    }
  });
}

// ===== 拦截 render 函数监控性能 =====
// 在 DEV_MODE 启用后，监控 render 性能
function initDevRenderMonitor() {
  const origRender = window.render;
  if (!origRender) return;
  
  window.render = function() {
    const start = performance.now();
    origRender.apply(this, arguments);
    const end = performance.now();
    DEV_MODE.renderTimes.push(end - start);
    if (DEV_MODE.renderTimes.length > 120) {
      DEV_MODE.renderTimes.splice(0, 60);
    }
  };
}

// ===== 暴露开发者 API 到全局 =====
window.DevMode = {
  enabled: () => DEV_MODE.enabled,
  toggle: toggleDevMode,
  log: devLog,
  execute: executeDevCommand,
  snapshot: () => executeDevCommand('snapshot'),
  rollback: () => executeDevCommand('rollback'),
  state: () => executeDevCommand('state'),
};

// ===== 初始化开发者模式 =====
function initDevModeSystem() {
  // 检查是否启用
  if (checkDevMode()) {
    DEV_MODE.enabled = true;
    // 延迟初始化，确保 DOM 已加载
    setTimeout(() => {
      initDevMode();
      showDevToast('🛠 开发者模式已自动启用');
    }, 500);
  }
  
  // 添加侧边栏按钮
  addDevModeButton();
  
  // 开始界面彩蛋
  initDevEasterEgg();
  
  // 监控渲染性能
  initDevRenderMonitor();
  
  // 暴露 toggle 到全局
  window.toggleDevMode = toggleDevMode;
  
  // 渲染快照列表
  renderDevSnapshots();
}

// ===== 开发者模式启动 =====
// 在 DOM 加载完成后初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDevModeSystem);
} else {
  initDevModeSystem();
}

// ============================================================
// 辅助：安全克隆对象，移除函数
// ============================================================

function safeClone(obj) {
  if (obj === undefined || obj === null) return {};
  try {
    return JSON.parse(JSON.stringify(obj, (key, value) => {
      if (typeof value === 'function' || typeof value === 'symbol') return undefined;
      return value;
    }));
  } catch (e) {
    console.warn('安全克隆失败:', e);
    if (typeof obj === 'string') return '';
    if (typeof obj === 'number') return 0;
    if (typeof obj === 'boolean') return false;
    if (Array.isArray(obj)) return [];
    return {};
  }
}

// ============================================================
// 测试面板通信支持（使用 postMessage）
// ============================================================

let _testPanelWindow = null;
let _testTimeoutTimer = null;

function initTestPanelCommunication() {
  console.log('🔄 初始化测试面板通信...');
  // 移除旧的监听器，避免重复绑定
  if (window._testPanelHandler) {
    window.removeEventListener('message', window._testPanelHandler);
    console.log('🔄 已移除旧监听器');
  }

  window._testPanelHandler = function handler(event) {
    const data = event.data;
    if (!data) return;

    // ---------- 请求游戏上下文 ----------
    if (data.type === 'GET_GAME_CONTEXT') {
      try {
        const rawCurses = window.TRIAL_CURSES || [];
        const cursesData = rawCurses.map(c => ({
          name: c.name,
          description: c.description
        }));

        const context = {
          TRIAL_CURSES: cursesData,
          SAVE_ID: window.SAVE_ID,
          state: safeClone(window.state),
          heroOptions: safeClone(window.heroOptions),
          trialCursesCount: rawCurses.length,
        };

        event.source.postMessage({
          type: 'GAME_CONTEXT',
          payload: context
        }, '*');
        console.log('📤 已向测试面板发送游戏上下文（仅数据，已移除函数）');
      } catch (e) {
        event.source.postMessage({
          type: 'GAME_CONTEXT_ERROR',
          message: e.message
        }, '*');
        console.error('发送游戏上下文失败:', e);
      }
      return;
    }

    // ---------- 运行测试 ----------
    if (data.type === 'RUN_CURSE_TESTS' || data.type === 'RUN_TEST') {
      const testId = data.testId || 'curse';
      let scriptPath = data.scriptPath || data.testFile || '测试/诅咒测试.js';
      // 如果路径不包含斜杠，默认在 测试/ 目录下
      if (!scriptPath.includes('/') && !scriptPath.startsWith('测试/')) {
        scriptPath = '测试/' + scriptPath;
      }
      _testPanelWindow = event.source;
      runTestInGame(testId, scriptPath);
      return;
    }
  };

  window.addEventListener('message', window._testPanelHandler);
  console.log('✅ 测试面板通信已启用');
}

function runTestInGame(testId, scriptPath) {
  // 清除旧的回调和定时器
  if (window.__testCallback) {
    delete window.__testCallback;
  }
  if (_testTimeoutTimer) {
    clearTimeout(_testTimeoutTimer);
    _testTimeoutTimer = null;
  }

  // 设置超时保护（60秒）
  _testTimeoutTimer = setTimeout(() => {
    console.warn(`测试 "${testId}" 超时（60秒）`);
    if (_testPanelWindow) {
      try {
        _testPanelWindow.postMessage({
          type: 'TEST_RESULT',
          testId: testId,
          result: {
            passed: false,
            error: '测试超时（60秒）',
            logs: ['❌ 测试执行超时，请检查游戏是否卡死']
          }
        }, '*');
      } catch (e) {}
    }
    delete window.__testCallback;
    _testPanelWindow = null;
    _testTimeoutTimer = null;
  }, 60000);

  window.__testCallback = function(result) {
    console.log('📥 __testCallback 被调用，testId:', testId);
    if (_testTimeoutTimer) {
      clearTimeout(_testTimeoutTimer);
      _testTimeoutTimer = null;
    }
    if (_testPanelWindow) {
      try {
        _testPanelWindow.postMessage({
          type: 'TEST_RESULT',
          testId: testId,
          result: result
        }, '*');
        console.log(`📤 测试结果已发送至测试面板 (${testId})`);
      } catch (e) {
        console.error('发送测试结果失败:', e);
      }
    }
    delete window.__testCallback;
    _testPanelWindow = null;
  };

  // 首先加载公共模块（如果尚未加载）
  function loadCommonModule(callback) {
    // 检查是否已加载
    if (window.__Test) {
      callback();
      return;
    }
    const commonScript = document.createElement('script');
    commonScript.src = '测试/公共.js?t=' + Date.now();
    commonScript.onload = function() {
      commonScript.remove();
      // 加载后再次检查
      if (!window.__Test) {
        // 极少数情况下，脚本执行可能因缓存问题未完成，再次尝试
        const retryScript = document.createElement('script');
        retryScript.src = '测试/公共.js?t=' + Date.now() + '_retry';
        retryScript.onload = function() {
          retryScript.remove();
          callback();
        };
        retryScript.onerror = function() {
          retryScript.remove();
          callback();
        };
        document.head.appendChild(retryScript);
      } else {
        callback();
      }
    };
    commonScript.onerror = function() {
      commonScript.remove();
      // 加载失败，但继续执行测试（可能会报错，但至少不阻塞）
      console.warn('⚠️ 公共模块加载失败，测试可能无法正常运行');
      callback();
    };
    document.head.appendChild(commonScript);
  }

  // 加载公共模块后再加载测试脚本
  loadCommonModule(function() {
    const script = document.createElement('script');
    const fullPath = scriptPath.startsWith('测试/') ? scriptPath : '测试/' + scriptPath;
    script.src = fullPath + '?t=' + Date.now();
    script.onload = function() {
      console.log(`📥 测试脚本已加载: ${fullPath}`);
      script.remove();
    };
    script.onerror = function() {
      console.error(`❌ 测试脚本加载失败: ${fullPath}`);
      if (window.__testCallback) {
        window.__testCallback({
          passed: false,
          error: '脚本加载失败',
          logs: [`❌ 无法加载 ${fullPath}`]
        });
      }
      if (_testTimeoutTimer) {
        clearTimeout(_testTimeoutTimer);
        _testTimeoutTimer = null;
      }
      delete window.__testCallback;
      _testPanelWindow = null;
      script.remove();
    };
    document.head.appendChild(script);
  });
}

// 保留旧函数名兼容
function runCurseTestsInGame() {
  runTestInGame('curse', '测试/诅咒测试.js');
}


// ===== 全局视觉特效初始化 =====
function initVisualEffects() {
  // --- 1. 生成星星（180颗） ---
  const starsLayer = document.getElementById('starsLayer');
  if (starsLayer) {
    const starCount = 180;
    for (let i = 0; i < starCount; i++) {
      const star = document.createElement('div');
      const sizeClass = Math.random() < 0.6 ? 'small' : (Math.random() < 0.7 ? 'medium' : 'large');
      star.className = `star ${sizeClass}`;
      star.style.left = Math.random() * 100 + '%';
      star.style.top = Math.random() * 100 + '%';
      star.style.setProperty('--duration', (2 + Math.random() * 4) + 's');
      star.style.setProperty('--min-opacity', (0.1 + Math.random() * 0.3));
      star.style.setProperty('--max-opacity', (0.6 + Math.random() * 0.4));
      star.style.animationDelay = (Math.random() * 6) + 's';
      starsLayer.appendChild(star);
    }
  }

  // --- 2. 生成漂浮粒子（25个） ---
  const particleContainer = document.getElementById('particleContainer');
  if (particleContainer) {
    const particleCount = 25;
    for (let i = 0; i < particleCount; i++) {
      const particle = document.createElement('div');
      particle.className = 'float-particle';
      const size = 4 + Math.random() * 10;
      particle.style.width = size + 'px';
      particle.style.height = size + 'px';
      particle.style.left = Math.random() * 100 + '%';
      particle.style.top = Math.random() * 100 + '%';
      particle.style.setProperty('--float-duration', (12 + Math.random() * 18) + 's');
      particle.style.setProperty('--float-delay', (Math.random() * 15) + 's');
      particle.style.setProperty('--fx', (50 + Math.random() * 200) * (Math.random() > 0.5 ? 1 : -1) + 'px');
      particle.style.setProperty('--fy', (50 + Math.random() * 200) * (Math.random() > 0.5 ? 1 : -1) + 'px');
      particleContainer.appendChild(particle);
    }
  }

  // --- 3. 鼠标辉光 ---
  let glow = document.getElementById('mouseGlow');
  if (!glow) {
    glow = document.createElement('div');
    glow.id = 'mouseGlow';
    document.body.appendChild(glow);
  }
  let mouseX = -9999,
      mouseY = -9999;

  const updateGlow = (x, y) => {
    mouseX = x;
    mouseY = y;
    glow.style.left = mouseX + 'px';
    glow.style.top = mouseY + 'px';
  };

  document.addEventListener('mousemove', (e) => {
    updateGlow(e.clientX, e.clientY);
  });

  document.addEventListener('touchmove', (e) => {
    const touch = e.touches[0];
    if (touch) {
      updateGlow(touch.clientX, touch.clientY);
    }
  }, { passive: true });

  // 鼠标离开窗口时淡出辉光
  document.addEventListener('mouseleave', () => {
    glow.style.opacity = '0';
  });
  document.addEventListener('mouseenter', () => {
    glow.style.opacity = '1';
  });

  console.log('视觉特效已加载');
}

// ===== 音效系统初始化 =====
async function initAudioSystem() {
  try {
    // 先加载音效系统
    await loadAbyssAudio();
    
    // 等待用户交互后初始化音频（解决浏览器自动播放限制）
    function initAudioAfterUserInteraction() {
      // 初始化音效系统
      if (window.AbyssAudio) {
        console.log('[音效] 音效系统已初始化');
        
        // 设置初始场景音乐
        if (state && state.mode === 'heroSelect') {
          window.AbyssAudio.setScene('explore');
        }
      }
    }
    
    // 监听用户交互事件
    document.addEventListener('click', initAudioAfterUserInteraction, { once: true });
    document.addEventListener('keydown', initAudioAfterUserInteraction, { once: true });
    document.addEventListener('touchstart', initAudioAfterUserInteraction, { once: true });
    
    // 如果已经有过用户交互，立即初始化
    if (document.readyState !== 'loading' && document.hasInteractiveElement) {
      initAudioAfterUserInteraction();
    }
  } catch (error) {
    console.warn('[音效] 音效系统初始化失败:', error);
  }
}

// 确保音效系统在游戏开始前加载完成
async function ensureAudioReady() {
  await loadAbyssAudio();
  return window.AbyssAudio && typeof window.AbyssAudio.applySettings === 'function';
}

// ===== 在 DOM 加载完成后初始化特效和音效 =====
// 如果页面已经加载完成，立即执行；否则等待 DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    initVisualEffects();
    initAudioSystem();
  });
} else {
  initVisualEffects();
  initAudioSystem();
}