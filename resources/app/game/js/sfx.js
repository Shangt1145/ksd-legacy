/* ==========================================================================
 * KG Sfx —— 音效播放层（纯 HTMLAudio，无第三方依赖）
 * 被 ui.js 使用；引擎层完全不感知这里的存在。
 *
 * 素材：free-sound-effects.net（Royalty-free、可商用、无需署名）挑选的**二战题材**实录音效，
 *       经 game/tools/_sfx_process.js 后处理（裁剪 + 淡出 + 压缩 + 峰值对齐）后存为 mp3。
 *
 *       事件 → 素材（KARDS 是二战题材，不能用奇幻 RPG 的挥剑/法术音）：
 *         attack  **按兵种区分**：步兵=步枪/机枪、坦克=加农炮、火炮=榴弹炮、
 *                 战斗机=高射炮连射、轰炸机=俯冲轰炸、巡航舰=舰炮、
 *                 巡地舰=重型火炮、太空战机=低沉重炮/飞掠
 *         move    **按兵种区分**：步兵=军靴、坦克=履带行进、火炮=炮车牵引、
 *                 战斗机=螺旋桨引擎、轰炸机=重型螺旋桨、巡航舰=破浪航行、
 *                 巡地舰=重型机械、太空战机=飞船引擎低鸣
 *         deploy  **按兵种区分**：步兵=上膛/踏地、坦克=装甲启动、火炮=炮闩装填、
 *                 战斗机=螺旋桨启动、轰炸机=螺旋桨降落、巡航舰=汽笛、
 *                 巡地舰=重型启动、太空战机=起飞
 *         hit     子弹打装甲 / 打工事 / 打泥土（按**被击中者**的兵种选材质）
 *         die     重型爆炸（单位被摧毁）
 *         ui      老式机械开关 / 拨杆（贴合二战器械）
 *
 *  ★ attack / move / deploy 三者都**按兵种**换素材（TYPE_TABLES）。
 *    没有专属素材的兵种自动回落通用音 —— 缺素材只是"不够贴"，**永远不会没声音**。
 *
 *  ★ 同兵种内再按**防御力**调音调（playbackRate）：皮厚的更低沉、脆皮的更清脆，
 *    所以谢尔曼和三号坦克的炮声不会一模一样（见 rateForDefense）。
 *
 * 设计要点
 *  - 用 Audio 元素池预加载，play() 时挑一个空闲的复用（避免同一瞬间多次播放互相截断）。
 *  - 浏览器的自动播放策略：首次用户交互（pointerdown/keydown）后 unlock()，之后才能出声。
 *  - 每个事件有多个"变体"，随机挑一个，避免连打同一个音听起来很机械。
 *  - 全局音量 / 静音开关，存 localStorage。
 *  - ★ 各素材的 crest factor（峰值-平均值）天生 25~32dB，统一做过**峰值对齐**（峰值 -3.5dB），
 *    但平均响度仍天然不同。EVENT_GAIN 就是用来拉平听感的：开火要突出、UI 要轻。
 *    改素材后这里要跟着重调。
 * ========================================================================== */
(function (global) {
  'use strict';
  const S = global.KGSfx = global.KGSfx || {};

  const DIR = 'assets/sfx/';
  const PREFIX = (global.KG_SFX_PREFIX != null) ? global.KG_SFX_PREFIX : DIR;

  /* --------------------------------------------------------- 事件 → 变体表 */
  // 名称对应游戏语义，值是文件名（不含扩展名），随机挑一个播放。
  const TABLE = {
    attack: ['attack1', 'attack2', 'attack3'],   // 步枪单发 / 机枪点射
    hit: ['hit1', 'hit2', 'hit3'],              // 弹着：装甲 / 工事 / 泥土
    move: ['move1', 'move2', 'move3'],           // 军靴：泥土 / 土木碎屑 / 水泥
    die: ['die1', 'die2', 'die3'],              // 重型爆炸
    deploy: ['deploy1', 'deploy2'],              // 上膛 / 踏地
    ui: ['ui1', 'ui2'],                          // 机械开关 / 拨杆
    // 下面这些是"演出类"事件（复用已有素材 + 调音调/音量做出区分，不额外下载素材）
    veteran: ['ui2'],                            // 升为老兵：明亮的机械咔哒（rate 拉高）
    counterSet: ['deploy2'],                     // 反制埋设：一声闷响（rate 压低）
    counterFire: ['hit2'],                       // 反制触发：爆响
    shuffle: ['move1'],                          // 洗入卡组：纸张/摩擦声（rate 拉高、音量压低）
    intel: ['ui1'],                              // 情报扫描：极短提示音（rate 拉高）
    burn: ['hit2'],                              // 烧牌：闷响 + 纸张焦化（rate 压低、音量压小）
    order: ['ui2'],                              // 指令打出（generic 回落）：机械拨杆
  };
  S.TABLE = TABLE;

  /* ------------------------------------------------- 兵种 → 专属开火音变体
   * 没有专属素材的兵种回落到通用 attack1~3（步枪/机枪），所以永远不会"没声音"。 */
  const ATTACK_BY_TYPE = {
    infantry: ['attack1', 'attack2', 'attack3'],          // 步枪单发 / 机枪点射
    tank: ['tank1', 'tank2'],                              // 加农炮 / 速射炮
    artillery: ['artillery1', 'artillery2'],               // 榴弹炮
    fighter: ['fighter1'],                                 // 高射炮连射
    bomber: ['bomber1', 'bomber2'],                        // 俯冲轰炸 / 轰炸飞越
    cruiser: ['cruiser1', 'cruiser2'],                     // 舰炮
    landcruiser: ['landcruiser1', 'landcruiser2'],         // 重型火炮
    spacefighter: ['spacefighter1', 'spacefighter2'],      // 低沉重炮 / 飞掠
  };
  S.ATTACK_BY_TYPE = ATTACK_BY_TYPE;

  /* ------------------------------------------- 兵种 → 专属「移动」音变体
   * 步兵=军靴；坦克=履带行进；火炮=炮车拖曳；飞机=螺旋桨/引擎；
   * 舰船=破浪航行；巡地舰=重型机械；太空战机=飞船引擎。
   * 没有专属素材的兵种回落通用 move1~3，永远不会没声音。 */
  const MOVE_BY_TYPE = {
    infantry: ['move1', 'move2', 'move3'],           // 军靴：泥土/碎屑/水泥
    tank: ['mv_tank1', 'mv_tank2'],                  // 履带行进
    artillery: ['mv_artillery1', 'mv_artillery2'],   // 炮车拖曳
    fighter: ['mv_fighter1', 'mv_fighter2'],         // 螺旋桨引擎 / 飞掠
    bomber: ['mv_bomber1'],                          // 重型螺旋桨飞掠
    cruiser: ['mv_cruiser1', 'mv_cruiser2'],         // 破浪航行
    landcruiser: ['mv_landcruiser1', 'mv_landcruiser2'], // 重型机械运转
    spacefighter: ['mv_spacefighter1'],              // 飞船引擎低鸣
  };
  S.MOVE_BY_TYPE = MOVE_BY_TYPE;

  /* ------------------------------------------- 兵种 → 专属「部署」音变体
   * 步兵=上膛/踏地；坦克=装甲启动；火炮=炮闩装填；飞机=螺旋桨启动/降落；
   * 舰船=汽笛；巡地舰=重型启动；太空战机=起飞。 */
  const DEPLOY_BY_TYPE = {
    infantry: ['deploy1', 'deploy2'],
    tank: ['dp_tank1', 'dp_tank2'],
    artillery: ['dp_artillery1', 'dp_artillery2'],
    fighter: ['dp_fighter1', 'dp_fighter2'],
    bomber: ['dp_bomber1'],
    cruiser: ['dp_cruiser1', 'dp_cruiser2'],
    landcruiser: ['dp_landcruiser1'],
    spacefighter: ['dp_spacefighter1', 'dp_spacefighter2'],
  };
  S.DEPLOY_BY_TYPE = DEPLOY_BY_TYPE;

  // 事件 → 该事件的"按兵种"表（没有的返回 null，走通用 TABLE）
  const TYPE_TABLES = { attack: ATTACK_BY_TYPE, move: MOVE_BY_TYPE, deploy: DEPLOY_BY_TYPE };

  /* ----------------------------------------------- 防御力 → 音调（playbackRate）
   * HTMLAudio 的 playbackRate 同时改变**音调与速度**，正是我们要的：
   * 重甲单位听起来更低沉厚重，脆皮单位更清脆短促。
   *
   * 取值按防御力**对数**映射（防御力 1~24 跨度太大，线性会让中段挤在一起）：
   *   def 1  → 1.22（清脆）
   *   def 4  → 1.00（基准，中位）
   *   def 12 → 0.90
   *   def 24 → 0.82（低沉）
   * ⚠ 别拉太狠：低于 0.8 会明显拖沓像慢放，高于 1.3 会尖得像卡通音。
   */
  function rateForDefense(def) {
    const d = Math.max(1, Number(def) || 1);
    // log2(def) 在 def=1 时为 0、def=4 时为 2 → 以此为基准点
    const t = Math.log2(d) - 2;
    const r = 1.0 - t * 0.085;
    return Math.max(0.80, Math.min(1.30, r));
  }
  S.rateForDefense = rateForDefense;

  /* --------------------------------------------------------- 事件 → 音量增益
   * 素材已做过峰值对齐，但**平均响度**天然不同（实测 attack ≈ -26dB、die ≈ -18dB）。
   * 这里按"游戏里该多突出"来拉平听感：开火是核心反馈要突出，UI 只是点缀要轻。
   * 数值是相对倍数（1 = 素材原样），最终音量 = 全局 volume × 本表值，上限 1。 */
  const EVENT_GAIN = {
    attack: 2.0,   // 开火：主反馈，必须最响
    die: 1.2,      // 爆炸：单位阵亡，次响
    hit: 1.3,      // 弹着：命中反馈
    move: 1.0,     // 行军：中等
    deploy: 1.1,   // 部署：中等
    ui: 0.7,       // 界面：点缀，别抢戏
    veteran: 1.0,      // 升级：要听得出来"变强了"
    counterSet: 0.8,   // 埋设：中等偏轻
    counterFire: 1.2,  // 反制触发：仅次于开火
    shuffle: 0.5,      // 洗牌：背景感
    intel: 0.6,        // 情报：轻提示
    order: 1.0,        // 指令打出：基准（分类内再按 ORDER_BY_CAT 的 gain 加权）
  };
  S.EVENT_GAIN = EVENT_GAIN;

  /* ------------------------------------- 指令分类 → 打出指令时的音效
   * ui.js 的 fxCategoryOf（animate.js CAT_RULES）把指令按效果归成九类，
   * 这里每类给一套（素材 + rate + gain），和 orderFx 的分类演出对齐：
   *   fire     火光+震屏   → 榴弹炮（压低）
   *   destroy  碎裂+强震屏 → 重型爆炸
   *   buff     金光上升    → 明亮机械咔哒（同 veteran，"变强"的听感）
   *   debuff   暗紫下沉    → 闷响（压得很低）
   *   heal     绿光回复    → 轻提示音（轻柔）
   *   intel    扫描        → 极短提示音（同 intel，更尖）
   *   summon   调度进场    → 上膛/踏地
   *   supply   卡影飞入    → 纸张摩擦（同 shuffle，配抽牌）
   *   generic  （未分类）  → 机械拨杆原样
   * 复用素材 + 调音调/音量区分 —— 与 veteran/counterSet 等演出类同一模式。 */
  const ORDER_BY_CAT = {
    fire:     { name: 'artillery1', rate: 0.95, gain: 1.3 },
    destroy:  { name: 'die1',       rate: 0.90, gain: 1.4 },
    buff:     { name: 'ui2',        rate: 1.35, gain: 1.0 },
    debuff:   { name: 'deploy2',    rate: 0.70, gain: 0.8 },
    heal:     { name: 'ui1',        rate: 1.15, gain: 0.7 },
    intel:    { name: 'ui1',        rate: 1.50, gain: 0.6 },
    summon:   { name: 'deploy1',    rate: 1.00, gain: 1.0 },
    supply:   { name: 'move1',      rate: 1.30, gain: 0.5 },
    generic:  { name: 'ui2',        rate: 1.00, gain: 0.9 },
  };
  S.ORDER_BY_CAT = ORDER_BY_CAT;

  /* --------------------------------------------------------- 音量 / 静音 */
  const LS_VOL = 'kg_sfx_volume';
  const LS_MUTE = 'kg_sfx_mute';
  // 基准音量 0.45：给 EVENT_GAIN > 1 的事件（attack 2.0）留余量，
  // 否则 0.6 × 2.0 = 1.2 会被音量上限截断、开火反而不突出。
  let volume = 0.45;
  let muted = false;
  try {
    const v = parseFloat(localStorage.getItem(LS_VOL));
    if (!isNaN(v)) volume = Math.max(0, Math.min(1, v));
    muted = localStorage.getItem(LS_MUTE) === '1';
  } catch (e) { /* localStorage 不可用则用默认值 */ }
  S.getVolume = () => muted ? 0 : volume;
  S.isMuted = () => muted;
  S.setVolume = function (v) {
    volume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem(LS_VOL, String(volume)); } catch (e) { }
    applyVolumeAll();
  };
  S.setMuted = function (m) {
    muted = !!m;
    try { localStorage.setItem(LS_MUTE, muted ? '1' : '0'); } catch (e) { }
    applyVolumeAll();
  };
  S.toggleMute = function () { S.setMuted(!muted); return muted; };

  /* --------------------------------------------------------------- 池化播放 */
  // name -> { els: [Audio...], idx: 0 }  —— 每个变体预建 POOL 个 Audio 元素轮转
  const POOL = 3;
  const banks = {};
  let unlocked = false;

  function elSrc(name) { return PREFIX + name + '.mp3'; }

  function ensureBank(name) {
    if (banks[name]) return banks[name];
    const els = [];
    for (let i = 0; i < POOL; i++) {
      const a = new Audio(elSrc(name));
      a.preload = 'auto';
      a.volume = S.getVolume();
      els.push(a);
    }
    const bank = banks[name] = { els: els, idx: 0 };
    return bank;
  }

  // 预加载全部变体（在页面空闲时调用即可；失败静默——文件缺失不该让游戏崩）
  function preload() {
    const names = [];
    Object.keys(TABLE).forEach(function (evt) {
      TABLE[evt].forEach(function (nm) { names.push(nm); });
    });
    // ★ 兵种专属音不在 TABLE 里（它们按 unitType 分派），
    //   漏掉的话第一次发声才去建 Audio 元素 → 那次会哑掉/延迟。
    Object.keys(TYPE_TABLES).forEach(function (evt) {
      const t = TYPE_TABLES[evt];
      Object.keys(t).forEach(function (tp) {
        t[tp].forEach(function (nm) { names.push(nm); });
      });
    });
    names.forEach(function (nm) { try { ensureBank(nm); } catch (e) { } });
  }
  S.preload = preload;

  function applyVolumeAll() {
    const v = S.getVolume();
    Object.keys(banks).forEach(function (nm) {
      banks[nm].els.forEach(function (a) { a.volume = v; });
    });
  }

  // 首次用户交互后解锁自动播放（Chrome/Safari 策略）
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    // 静默播一个空音频把 Audio 上下文"唤醒"
    try {
      Object.keys(TABLE).forEach(function (evt) {
        const nm = TABLE[evt][0];
        const a = ensureBank(nm).els[0];
        const p = a.play();
        if (p && p.catch) p.catch(function () { });
        // 立刻暂停，避免真的响一声
        setTimeout(function () { try { a.pause(); a.currentTime = 0; } catch (e) { } }, 0);
      });
    } catch (e) { }
  }
  S.unlock = unlock;
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
  }

  /* ------------------------------------------------------------------ 播放 */
  // 直接播一个文件名（不含扩展名）
  function playName(name, opts) {
    opts = opts || {};
    if (muted) return null;
    let bank;
    try { bank = ensureBank(name); } catch (e) { return null; }
    const a = bank.els[bank.idx % bank.els.length];
    bank.idx++;
    try {
      a.volume = (opts.gain != null ? Math.max(0, Math.min(1, volume * opts.gain)) : S.getVolume());
      // 音调：按防御力调 playbackRate（重单位低沉、轻单位清脆）。缺省 1 = 原样。
      a.playbackRate = (opts.rate != null) ? Math.max(0.5, Math.min(2, opts.rate)) : 1;
      a.currentTime = 0;
      const p = a.play();
      if (p && p.catch) p.catch(function () { /* 未解锁/被拦截：静默 */ });
    } catch (e) { /* 播放失败不该影响游戏 */ }
    return a;
  }
  S.playName = playName;

  // 播一个事件（attack/hit/move/die/deploy/ui），随机挑变体
  //   opts.gain  额外的一次性系数（如按单位防御力分档），与 EVENT_GAIN 相乘
  //   opts.unit  发起/承受该事件的单位 —— 有它就按兵种挑素材、按防御力调音调
  //   opts.target 命中类事件的目标单位（打坦克和打步兵的弹着声不同）
  function play(evt, opts) {
    opts = opts || {};
    const u = opts.unit || null;
    const t = opts.target || null;
    let list = TABLE[evt];

    // attack / move / deploy：都按**当事单位的兵种**换素材
    //   （谢尔曼 ≠ 三号坦克 ≠ 步兵班；履带 ≠ 军靴 ≠ 螺旋桨）
    const tbl = TYPE_TABLES[evt];
    if (tbl && u && u.unitType && tbl[u.unitType]) list = tbl[u.unitType];
    // hit：按**目标兵种**选弹着材质（打装甲=金属、打工事=混凝土、打散兵=泥土）
    if (evt === 'hit') {
      if (t && (t.unitType === 'tank' || t.unitType === 'landcruiser' || t.unitType === 'cruiser')) list = ['hit1'];
      else if (t && (t.unitType === 'structure' || t.unitType === 'artillery')) list = ['hit2'];
      else if (t && t.unitType) list = ['hit3'];
    }
    if (!list || !list.length) return null;

    const nm = list[Math.floor(Math.random() * list.length)];
    const eg = EVENT_GAIN[evt] != null ? EVENT_GAIN[evt] : 1;
    const extra = (opts.gain != null) ? opts.gain : 1;
    // 音调主体：move/die/deploy 用**当事单位**的防御力；hit 用**目标**的（打重甲更闷）
    //   ★ 调用方显式传了 rate 就用它的（演出类事件靠 rate 把同一份素材做出区分）
    const defSrc = (evt === 'hit') ? (t || u) : u;
    const rate = (opts.rate != null) ? opts.rate : (defSrc ? rateForDefense(defSrc.defense) : 1);
    return playName(nm, Object.assign({}, opts, { gain: eg * extra, rate: rate }));
  }
  S.play = play;

  /* ------------------------------------------------------ 语义化便捷方法 */
  S.attack = function (o) { return play('attack', o); };
  S.hit = function (o) { return play('hit', o); };
  S.move = function (o) { return play('move', o); };
  S.die = function (o) { return play('die', o); };
  S.deploy = function (o) { return play('deploy', o); };
  S.ui = function (o) { return play('ui', o); };
  // 演出类（复用素材 + 固定 rate/gain，做出"这是升级/埋设/触发/洗牌/情报"的区分）
  S.veteran = function (o) { return play('veteran', Object.assign({ rate: 1.35 }, o || {})); };
  S.counterSet = function (o) { return play('counterSet', Object.assign({ rate: 0.85 }, o || {})); };
  S.counterFire = function (o) { return play('counterFire', Object.assign({ rate: 1.1 }, o || {})); };
  S.shuffle = function (o) { return play('shuffle', Object.assign({ rate: 1.3 }, o || {})); };
  S.intel = function (o) { return play('intel', Object.assign({ rate: 1.5 }, o || {})); };
  S.burn = function (o) { return play('burn', Object.assign({ rate: 0.7, gain: 0.7 }, o || {})); };
  // 指令打出：cat = animate.js CAT_RULES 的九类之一，未识别回落 generic。
  //   opts.cat 可显式覆盖（调用方一般直接传 cat 字符串）。
  S.order = function (cat, o) {
    o = o || {};
    const cfg = ORDER_BY_CAT[cat] || ORDER_BY_CAT.generic;
    return playName(cfg.name, Object.assign({ rate: cfg.rate, gain: EVENT_GAIN.order * cfg.gain }, o));
  };

})(typeof window !== 'undefined' ? window : this);
