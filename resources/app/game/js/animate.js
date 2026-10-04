/* ==========================================================================
 * KG Animate —— 动画工具层（FLIP / 飞行 / 冲刺 / 死亡 / 抽牌 / 回合横幅）
 * 依赖：无（纯 DOM + CSS 过渡，不引入 rAF 循环）
 * 被 ui.js 使用；引擎层完全不感知这里的存在。
 *
 * 设计要点
 *  - 全部返回 Promise，调用方 await 即可串起"连续过程动画"。
 *  - 用 CSS transition + transform，不用 requestAnimationFrame（保持全项目一致）。
 *  - 时长常量集中在 ANIM，方便统一调节奏。
 * ========================================================================== */
(function (global) {
  'use strict';
  const A = global.KGAnim = global.KGAnim || {};

  /* ------------------------------------------------------------- 时长常量 */
  const ANIM = A.ANIM = {
    fast: 120,
    base: 260,
    slow: 420,
    fly: 420,       // 手牌飞向棋盘
    lunge: 150,     // 攻击冲刺
    die: 380,       // 死亡淡出
    move: 360,      // 单位在阵线之间移动（支援线 ↔ 前线）的平滑位移
  };
  A.ANIM = ANIM;

  /* --------------------------------------------------- 演出速度档位 */
  // 原版的演出偏慢偏重；给一个全局倍率，把"所有时长"一起缩放。
  //   normal(原版)=1 · fast(快)=0.6 · faster(极快)=0.32
  // CSS 侧的固定动画时长由 <body> 上的 fx-fast / fx-faster 覆盖（见 style.css 尾部）。
  const SPEEDS = A.SPEEDS = { normal: 1, fast: 0.6, faster: 0.32 };
  let speedName = 'normal';
  try {
    const saved = global.localStorage && global.localStorage.getItem('kg_fx_speed');
    if (saved && SPEEDS[saved]) speedName = saved;
  } catch (e) { }
  A.speedName = function () { return speedName; };
  A.speedScale = function () { return SPEEDS[speedName] || 1; };
  // 缩放一个毫秒数（下限 30ms，免得极快档把动画压成 0 帧）
  A.ms = function (n) { return Math.max(30, Math.round((Number(n) || 0) * (SPEEDS[speedName] || 1))); };
  A.setSpeed = function (name) {
    if (!SPEEDS[name]) name = 'normal';
    speedName = name;
    try {
      const b = (typeof document !== 'undefined') ? document.body : null;
      if (b && b.classList) {
        b.classList.remove('fx-fast', 'fx-faster');
        if (name === 'fast') b.classList.add('fx-fast');
        else if (name === 'faster') b.classList.add('fx-faster');
      }
    } catch (e) { }
    try { if (global.localStorage) global.localStorage.setItem('kg_fx_speed', name); } catch (e) { }
    return name;
  };

  /* --------------------------------------------- 兵种 → 演出风格 */
  // 单位共用同一套"出手/落地/阵亡"骨架，按兵种换材质与位移方式：
  //   步兵·坦克 = 撞击式突进；火炮 = 原地开火 + 弹道；舰船 = 平推 + 尾浪；
  //   战斗机/太空战机 = 俯冲；轰炸机 = 临空投弹。
  const KIND = A.KIND = {
    infantry: { fam: 'ground', style: 'melee' },
    tank: { fam: 'ground', style: 'melee' },
    structure: { fam: 'ground', style: 'gun' },
    artillery: { fam: 'ground', style: 'gun' },
    cruiser: { fam: 'ship', style: 'gun' },
    landcruiser: { fam: 'ship', style: 'gun' },
    bomber: { fam: 'air', style: 'bomb' },
    fighter: { fam: 'air', style: 'dive' },
    spacefighter: { fam: 'air', style: 'dive' },
  };
  function kindOf(unit) {
    if (!unit) return 'infantry';
    const t = unit.unitType || (unit.def && unit.def.unitType);
    if (t && KIND[t]) return t;
    if (t === 'ship') return 'cruiser';
    if (t === 'space') return 'landcruiser';
    return 'infantry';
  }
  function familyOf(kind) { return (KIND[kind] || KIND.infantry).fam; }
  function styleOf(kind) { return (KIND[kind] || KIND.infantry).style; }
  A.kindOf = kindOf;
  A.familyOf = familyOf;
  // 命中材质：由**攻击方**兵种决定（炮弹 / 炸弹 / 枪弹 / 能量）
  function hitKindOf(kind) {
    if (kind === 'spacefighter') return 'energy';
    const s = styleOf(kind);
    if (s === 'gun') return 'shell';
    if (s === 'bomb') return 'bomb';
    return 'bullet';
  }
  A.hitKindOf = hitKindOf;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  A.sleep = sleep;

  const motionVersion = new WeakMap();
  let activeOrderCancel = null;
  function claimMotion(el) {
    try { if (el && el.getAnimations) el.getAnimations().forEach(a => a.cancel()); } catch (e) { }
    const id = (motionVersion.get(el) || 0) + 1;
    motionVersion.set(el, id);
    return id;
  }
  A.interrupt = function (el) {
    if (!el) return;
    if (activeOrderCancel) activeOrderCancel();
    claimMotion(el);
    try { if (el.getAnimations) el.getAnimations().forEach(a => a.cancel()); } catch (e) { }
    if (el.classList) el.classList.remove('enter', 'played', 'dying', 'slam', 'slam-light', 'slam-mid', 'slam-heavy', 'slam-air', 'slam-ship', 'attack-lunge', 'atk-dive', 'atk-gun', 'aiming-from', 'pulse', 'hit', 'flash-buff');
    if (el.style) { el.style.transition = ''; el.style.transform = ''; el.style.zIndex = ''; }
  };

  function rectOf(el) { try { return el && el.getBoundingClientRect(); } catch (e) { return null; } }
  A.rectOf = rectOf;

  /* ★ 布局位置（2026-09-27 中山师乱窜修复）：rectOf 返回的 getBoundingClientRect
   *   是**含 transform 的视觉位置**。lunge / flipByUid 都在写内联 transform 位移，
   *   一个元素上连续两段动画（新 lunge 抢占旧 lunge、FLIP 撞上 lunge 残留）时，
   *   用视觉位置算 dx/dy 会把上一段的残留 transform 混进位移量 → 落点 = 目标 − 残留，
   *   每次抢占偏移量都漂移 → 表现就是"触发几次后到处乱窜"。
   *   这里把 computed transform 的平移分量（matrix 的 e/f，translate 在最前时精确）
   *   从视觉位置里扣掉，得到干净的布局位置 —— 位移计算一律以它为基准。 */
  function layoutRectOf(el) {
    const r = rectOf(el);
    if (!r) return null;
    let ox = 0, oy = 0;
    try {
      const tf = getComputedStyle(el).transform;
      if (tf && tf !== 'none') {
        const m2 = tf.match(/^matrix\(([^)]+)\)$/);
        if (m2) {
          const p = m2[1].split(',').map(parseFloat);
          ox = p[4] || 0; oy = p[5] || 0;
        } else {
          const m3 = tf.match(/^matrix3d\(([^)]+)\)$/);
          if (m3) {
            const p = m3[1].split(',').map(parseFloat);
            ox = p[12] || 0; oy = p[13] || 0;
          }
        }
      }
    } catch (e) { }
    return { left: r.left - ox, top: r.top - oy, width: r.width, height: r.height,
      right: r.right - ox, bottom: r.bottom - oy };
  }
  A.layoutRectOf = layoutRectOf;

  // 判断一个元素是否被 CSS 动画/过渡"正在占用 transform"。
  // 用到 transform 的动画（.enter / .dying / .slam …）会和 FLIP 的 transform 互踩，
  // 所以这两种动画不能同时施加在同一个节点上。
  // ⚠ .moved-in / .glide-land 已从名单里删掉：这两个类已经不存在了
  //   （阵线间移动现在只走 flipByUid 的弧线关键帧，不再叠任何 CSS transform 动画）。
  function isAnimating(el) {
    if (!el || !el.classList) return false;
    return el.classList.contains('enter') || el.classList.contains('dying') ||
      el.classList.contains('played') ||
      el.classList.contains('attack-lunge') ||
      // 拍桌 / 箭头源单位：都在用 transform，FLIP 必须让位
      el.classList.contains('slam') || el.classList.contains('slam-light') ||
      el.classList.contains('slam-mid') || el.classList.contains('slam-heavy') ||
      el.classList.contains('aiming-from');
  }
  A.isAnimating = isAnimating;

  /* --------------------------------------------------------------- FLIP */
  // First-Last-Invert-Play：记录变更前的位置 → 执行 mutate() → 反推位移并播放过渡。
  // targets: 选择器或元素数组；只对"变更前后都在场"的元素做位移动画。
  function flip(targets, mutate, opts) {
    opts = opts || {};
    const dur = opts.duration == null ? ANIM.base : opts.duration;
    const ease = opts.easing || 'cubic-bezier(.2,.8,.3,1)';
    const els = toEls(targets);
    const first = new Map();
    els.forEach(el => {
      // 正在播 CSS transform 动画（入场/死亡）的节点不参与 FLIP：
      // 它自身的 animation 会覆盖 inline transform，FLIP 要么无效要么闪一下。
      if (isAnimating(el)) return;
      // ★ 布局位置（扣残留 transform）：与 flipByUid 同理，位移量不能混进 lunge 等内联位移的残留
      const r = layoutRectOf(el);
      if (r) first.set(el, r);
    });
    const ret = mutate ? mutate() : null;
    // mutate 可能是 async 的（引擎动作），等它落地再测 Last
    return Promise.resolve(ret).then(() => {
      const movers = [];
      first.forEach((r0, el) => {
        if (!el.isConnected) return;
        if (isAnimating(el)) return;      // 变更后进入动画态的，也让位给 CSS 动画
        const r1 = layoutRectOf(el);
        if (!r1) return;
        const dx = r0.left - r1.left;
        const dy = r0.top - r1.top;
        if (Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5) return;
        movers.push({ el, dx, dy });
      });
      if (!movers.length) return;
      // Invert：瞬间移回原位（关掉过渡）
      movers.forEach(m => {
        const { el, dx, dy } = m;
        m.motionId = claimMotion(el);
        el.style.transition = 'none';
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        el.style.zIndex = '20';
      });
      void document.body.offsetWidth;          // 强制回流，让上面的 transform 生效
      // Play：放回真实位置
      movers.forEach(({ el, dx, dy }) => {
        el.style.transition = 'transform ' + dur + 'ms ' + ease;
        el.style.transform = '';
      });
      return sleep(dur + 20).then(() => {
        // 清掉内联样式；清完后如果该节点正被 CSS 动画占用，就让 CSS 接手
        movers.forEach(m => {
          const { el } = m;
          if (motionVersion.get(el) !== m.motionId) return;
          el.style.transition = '';
          el.style.transform = '';
          el.style.zIndex = '';
        });
      });
    });
  }
  A.flip = flip;

  function toEls(t) {
    if (!t) return [];
    if (typeof t === 'string') return Array.prototype.slice.call(document.querySelectorAll(t));
    if (t.nodeType === 1) return [t];
    return Array.prototype.slice.call(t).filter(e => e && e.nodeType === 1);
  }
  A.toEls = toEls;

  /* ------------------------------------------- 跨容器 FLIP（按 uid 关联） */
  // 单位在**阵线之间移动**时（支援线 ↔ 前线），它所在的 .slot 会被从旧线删掉、
  // 在新线**新建一个 DOM 节点**。普通 flip 用"同一个 DOM 节点"做 key，于是新节点
  // 没有"变更前坐标" → **完全没有位移过渡 = 瞬移**。
  //
  // 这里改成按 `data-uid` 关联"旧坐标 → 新节点"：mutate 前记下每个 uid 的位置，
  // mutate 后用**同一个 uid**找到新节点，再反推位移。
  // 有没有 Web Animations API（能用关键帧画弧线，且动画结束后**不留内联 transform**）。
  // 沙箱（uitest 的迷你 DOM）没有它 → 自动退回"内联 transition 走直线"的老路径。
  function canAnimate() {
    try {
      return typeof Element !== 'undefined' && Element.prototype &&
        typeof Element.prototype.animate === 'function';
    } catch (e) { return false; }
  }

  // 弧线：跨阵线移动走一条"平滑抛物线"，而不是生硬的直线平移。
  //   中点沿**垂直于行进方向**偏移 lift 像素；位移太小的（同线换位、微调）不画弧。
  //   方向由行进方向决定（副法线取 -dy,+dx），所以上行和下行各自朝自己那一侧鼓，
  //   视觉上始终是"绕过去"而不是"弹过去"。
  function arcMidOf(dx, dy, opts) {
    if (!opts || opts.arc === false) return null;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 40) return null;                       // 小位移不值得画弧
    const lift = Math.min(52, len * 0.18);
    return { x: (-dy / len) * lift, y: (dx / len) * lift };
  }
  A.arcMidOf = arcMidOf;

  function flipByUid(selector, mutate, opts) {
    opts = opts || {};
    const dur = A.ms(opts.duration == null ? ANIM.base : opts.duration);
    const ease = opts.easing || 'cubic-bezier(.2,.8,.3,1)';
    // key 可以是**数组**（按顺序回退）：单位卡用 uid，总部卡用 hq
    const keys = opts.key ? (Array.isArray(opts.key) ? opts.key : [opts.key]) : ['uid'];
    const keyOf = function (el) {
      if (!el || !el.dataset) return null;
      for (const k of keys) { if (el.dataset[k]) return String(el.dataset[k]); }
      return null;
    };
    const snap = function () {
      const m = new Map();
      toEls(selector).forEach(function (el) {
        const k = keyOf(el);
        if (!k) return;
        // ★ 变更前**不跳过正在播动画的节点**：
        //   刚从手里打出的单位身上还挂着 .slam/.played（约 300ms），而它常常紧接着就移动
        //   （部署→移前线、AI 部署后同回合推进）。以前这里 isAnimating 就 return →
        //   这个 uid 没有"变更前坐标" → 变更后配不到 → **移动变成瞬移**（Alan 报的就是这个）。
        //   让位逻辑放在**变更后**那一步：那时如果新节点自己在播 CSS 动画，才跳过（避免 transform 互踩）。
        //   变更前坐标用**布局位置**（扣残留 transform）：节点若正在播 lunge 类内联位移，
        //   视觉 rect 会把残留 transform 混进 FLIP 的位移量 → 滑到错误位置（乱窜根源之二）。
        const r = layoutRectOf(el);
        if (r) m.set(k, { rect: r, el: el });
      });
      return m;
    };
    const first = snap();
    const ret = mutate ? mutate() : null;
    return Promise.resolve(ret).then(function () {
      const movers = [];
      // mutate 后再按 uid 取一次（此时是新的 DOM 节点）
      toEls(selector).forEach(function (el) {
        const k = keyOf(el);
        if (!k) return;
        const prev = first.get(k);
        if (!prev) return;                    // 变更前不存在（新进场）→ 交给 enter 动画
        if (isAnimating(el)) return;
        const r1 = layoutRectOf(el);
        if (!r1) return;
        const dx = prev.rect.left - r1.left;
        const dy = prev.rect.top - r1.top;
        if (Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5) return;
        movers.push({ el: el, dx: dx, dy: dy, w0: prev.rect.width, w1: r1.width });
      });
      if (!movers.length) return;
      // 测试钩子：把"真正播放位移的节点数"回报出去（用于断言移动动画真的发生了）。
      //   生产代码不传这个回调，零开销。
      if (typeof opts.onMove === 'function') { try { opts.onMove(movers.length); } catch (e) { } }
      // ★ 跨阵线移动（支援线 ↔ 前线）：优先走 Web Animations 关键帧 —— 可以画**弧线**，
      //   而且动画播完**不留任何内联 style**（不会被后面的 CSS 动画抢走 transform）。
      //   ⚠ 以前这里只有"内联 transition + 直线"，配合 animateDiff 里的 .glide-land 压扁
      //     （CSS 动画优先级 > 内联 transform）→ 位移播到一半被强行拉回终点 = "滑一半跳过去"。
      const useArc = canAnimate() && movers.some(function (m) { return arcMidOf(m.dx, m.dy, opts); });
      if (useArc) {
        movers.forEach(function (m) {
          m.motionId = claimMotion(m.el);
          m.el.style.zIndex = '20';
          const mid = arcMidOf(m.dx, m.dy, opts);
          const kf = mid
            ? [
              { transform: 'translate(' + m.dx + 'px,' + m.dy + 'px)', offset: 0 },
              { transform: 'translate(' + (m.dx / 2 + mid.x) + 'px,' + (m.dy / 2 + mid.y) + 'px)', offset: 0.5 },
              { transform: 'translate(0,0)', offset: 1 },
            ]
            : [
              { transform: 'translate(' + m.dx + 'px,' + m.dy + 'px)', offset: 0 },
              { transform: 'translate(0,0)', offset: 1 },
            ];
          try {
            m.anim = m.el.animate(kf, {
              duration: dur,
              easing: opts.easing || 'cubic-bezier(.34,.78,.24,1)',
              fill: 'none',
            });
          } catch (e) { m.anim = null; }
        });
        return sleep(dur + 20).then(function () {
          movers.forEach(function (m) {
            if (motionVersion.get(m.el) !== m.motionId) return;
            try { if (m.anim) m.anim.cancel(); } catch (e) { }
            m.el.style.zIndex = '';
          });
        });
      }
      movers.forEach(function (m) {
        m.motionId = claimMotion(m.el);
        m.el.style.transition = 'none';
        m.el.style.transform = 'translate(' + m.dx + 'px,' + m.dy + 'px)';
        m.el.style.zIndex = '20';
      });
      void document.body.offsetWidth;
      movers.forEach(function (m) {
        m.el.style.transition = 'transform ' + dur + 'ms ' + ease;
        m.el.style.transform = '';
      });
      return sleep(dur + 20).then(function () {
        movers.forEach(function (m) {
          if (motionVersion.get(m.el) !== m.motionId) return;
          m.el.style.transition = '';
          m.el.style.transform = '';
          m.el.style.zIndex = '';
        });
      });
    });
  }
  A.flipByUid = flipByUid;

  /* ------------------------------------------------ 指向箭头（拖单位时伸出） */
  // 拖拽自己的单位时**不再拖动卡牌本身**，而是从单位中心伸出一条带弹性的曲线箭头
  // 指向光标。返回一个句柄：{ set(x,y), aim(on), destroy() }。
  //
  // 设计
  //  - 用 SVG 画贝塞尔曲线（曲线控制点由"起点→终点"的垂直方向偏移决定），
  //    所以是弧线而不是直线。
  //  - 弹性：句柄内部保存"当前终点"，每次 set() 把目标终点写入，
  //    用 rAF-ish 的定时器做**阻尼跟随**（终点缓慢追上光标），产生"橡皮筋"手感。
  //  - 箭头跟随终点切线方向旋转，指向感明确。
  function arrow(opts) {
    opts = opts || {};
    const sx = opts.x || 0, sy = opts.y || 0;
    const color = opts.color || '#ff9a6a';
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'aim-arrow');
    // 用固定大画布 + 负向偏移容纳"光标跑到起点左/上方"的情况
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    if (svg.style) { svg.style.position = 'fixed'; svg.style.left = '0'; svg.style.top = '0'; }
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('class', 'aim-arrow-path');
    const head = document.createElementNS(svgNS, 'path');
    head.setAttribute('class', 'aim-arrow-head');
    const dot = document.createElementNS(svgNS, 'circle');
    dot.setAttribute('class', 'aim-arrow-dot');
    dot.setAttribute('cx', String(sx)); dot.setAttribute('cy', String(sy));
    dot.setAttribute('r', '6');
    svg.appendChild(path); svg.appendChild(head); svg.appendChild(dot);
    document.body.appendChild(svg);
    svg.style.color = color;

    // 起点固定（单位中心），终点做阻尼跟随
    const start = { x: sx, y: sy };
    let target = { x: sx, y: sy + 0.001 };
    let cur = { x: sx, y: sy + 0.001 };
    // 弓形弯向：opts.bend 固定给 1/-1（让箭头绕开自己那一排）；
    // 没给就按"终点落在起点左边还是右边"动态决定（左右对称，手感一致）。
    let curving = opts.bend === 1 || opts.bend === -1 ? opts.bend : 0;
    let alive = true;

    function draw() {
      if (!alive) return;
      // 阻尼跟随：每帧向目标推进 34%，越近越慢 → 橡皮筋感
      cur.x += (target.x - cur.x) * 0.34;
      cur.y += (target.y - cur.y) * 0.34;
      const dx = cur.x - start.x, dy = cur.y - start.y;
      const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const dir = curving || ((dx >= 0) ? 1 : -1);
      // 曲线控制点：把中点沿**垂直方向**推开，推出量随长度增长但设上限 → 好看的弓形
      const bend = Math.min(46, len * 0.22) * dir;
      const nx = -dy / len, ny = dx / len;             // 单位法线
      const mx = (start.x + cur.x) / 2, my = (start.y + cur.y) / 2;
      const cx = mx + nx * bend, cy = my + ny * bend;
      path.setAttribute('d', 'M' + start.x + ',' + start.y + ' Q' + cx + ',' + cy + ' ' + cur.x + ',' + cur.y);
      path.setAttribute('fill', 'none');
      // 箭头：贴在终点，朝曲线末端切线方向
      const tdx = cur.x - cx, tdy = cur.y - cy;
      const tl = Math.max(1, Math.sqrt(tdx * tdx + tdy * tdy));
      const ux = tdx / tl, uy = tdy / tl;
      const size = 9, half = 6;
      const bx = cur.x - ux * size, by = cur.y - uy * size;
      head.setAttribute('d', 'M' + cur.x + ',' + cur.y +
        ' L' + (bx - uy * half) + ',' + (by + ux * half) +
        ' L' + (bx + uy * half) + ',' + (by - ux * half) + ' Z');
      requestAnimationFrame(draw);
    }
    let raf = null;
    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(draw);
    else raf = setTimeout(draw, 16);

    return {
      el: svg,
      set: function (x, y) {
        target.x = x; target.y = y;
      },
      // 指向合法目标时变色/加粗（由调用方判定）
      aim: function (on) {
        svg.classList.toggle('aiming', !!on);
        svg.style.color = on ? (opts.aimColor || '#ff5a44') : color;
      },
      destroy: function () {
        alive = false;
        if (typeof cancelAnimationFrame === 'function') { try { cancelAnimationFrame(raf); } catch (e) { } }
        else clearTimeout(raf);
        kill(svg);
      },
    };
  }
  A.arrow = arrow;

  /* ------------------------------------------------- 指向性出牌：伸箭头 + 收 */
  // 从源卡中心向目标伸一条箭头（阻尼跟随 ~340ms 基本到位）→ 变红闪一下 → 收掉。
  // 用于"拖指令到敌方单位/总部"——以前这类出牌是静默结算，没有任何动画。
  function aimShot(sourceEl, targetEl, opts) {
    opts = opts || {};
    const a = rectOf(sourceEl), b = rectOf(targetEl);
    if (!a || !b) return Promise.resolve();
    const sx = a.left + a.width / 2, sy = a.top + a.height / 2;
    const h = arrow({ x: sx, y: sy, color: opts.color || '#ffb27a' });
    h.set(b.left + b.width / 2, b.top + b.height / 2);
    return sleep(opts.holdMs || 340).then(function () {
      h.aim(true);
      return sleep(opts.flashMs || 140);
    }).then(function () { h.destroy(); });
  }
  A.aimShot = aimShot;

  /* ------------------------------------------------------------ 拍桌（部署） */
  // 单位部署时的"拍桌"动画：从上方拍下 → 落位时压扁回弹 + 震屏 + 灰尘。
  // 力度由**防御力**分级（皮越厚砸得越沉）：
  //   def <= 2 轻拍 | 3..5 中拍 | >= 6 重拍
  // 只用 CSS 类 + 时长控制，不写死在元素上，方便统一调节。
  function slam(el, defense, opts) {
    opts = opts || {};
    if (!el || !el.classList) return Promise.resolve();
    const motionId = claimMotion(el);
    const d = Math.max(1, Number(defense) || 1);
    const tier = d <= 2 ? 'light' : (d <= 5 ? 'mid' : 'heavy');
    const kind = kindOf(opts.unit);
    const fam = familyOf(kind);
    // 空中单位是"缓缓降下"而不是拍桌，时长比地面慢半拍
    const dur = A.ms(opts.duration || (tier === 'heavy' ? 620 : tier === 'mid' ? 520 : 420) * (fam === 'air' ? 1.25 : 1));
    // 音效：部署落地（拍桌）。轻拍音量小一些，重拍更沉。
    //   opts.unit 有值时还会按防御力调音调（皮越厚越沉）。
    try {
      if (global.KGSfx) {
        global.KGSfx.deploy({ gain: tier === 'heavy' ? 1 : tier === 'mid' ? 0.85 : 0.6, unit: opts.unit || null });
      }
    } catch (e) { }
    el.classList.remove('slam', 'slam-light', 'slam-mid', 'slam-heavy', 'slam-air', 'slam-ship');
    void el.offsetWidth;
    el.classList.add('slam', 'slam-' + tier);
    if (fam === 'air') el.classList.add('slam-air');
    else if (fam === 'ship') el.classList.add('slam-ship');
    // 重拍才震屏 + 灰尘（轻拍克制，不抢戏）
    let shake = null, dust = [];
    if (tier !== 'light' && fam !== 'air') {
      const board = (opts.boardEl && opts.boardEl.nodeType === 1) ? opts.boardEl : null;
      if (board && board.classList) {
        shake = board;
        board.classList.remove('board-shake', 'board-shake-strong');
        void board.offsetWidth;
        board.classList.add(tier === 'heavy' ? 'board-shake-strong' : 'board-shake');
      }
      // 灰尘：在卡底边撒几撮
      const r = rectOf(el);
      if (r) {
        const n = tier === 'heavy' ? 5 : 3;
        for (let i = 0; i < n; i++) {
          const p = A.card('slam-dust');
          p.style.left = (r.left + r.width * (0.2 + 0.6 * (i / Math.max(1, n - 1)))) + 'px';
          p.style.top = (r.top + r.height * 0.86) + 'px';
          p.style.animationDelay = (i * 26) + 'ms';
          dust.push(p);
        }
      }
    }
    return sleep(dur).then(function () {
      if (motionVersion.get(el) !== motionId) {
        if (shake) shake.classList.remove('board-shake', 'board-shake-strong');
        dust.forEach(kill);
        return;
      }
      el.classList.remove('slam', 'slam-light', 'slam-mid', 'slam-heavy', 'slam-air', 'slam-ship');
      if (shake) {
        // 震屏比拍击晚一点结束，避免"卡已经稳稳落位了桌子还在抖"
        return sleep(A.ms(tier === 'heavy' ? 160 : 90)).then(function () {
          shake.classList.remove('board-shake', 'board-shake-strong');
        });
      }
    }).then(function () { dust.forEach(function (p) { setTimeout(function () { kill(p); }, A.ms(480)); }); });
  }
  A.slam = slam;

  /* --------------------------------------------------- 平移（单位阵线间移动） */
  // ★ 单位在阵线之间移动：**位移本身 100% 交给 flipByUid**（平滑缓动 + 弧线）。
  //   本函数只负责"落地那一刻"的反馈：落地音 + 扬尘/浪花。
  //
  //   ⚠ 制作者口径（2026-09-21）：**移动后不需要落地压扁**。
  //     原来这里会在 dur-120ms 给卡面加 `.glide-land`（scale 压扁回弹），而
  //     **CSS 动画的优先级高于内联 transform** → FLIP 的位移播到一半就被强行拉回终点，
  //     表现就是"滑一段然后跳过去"。现在压扁整段删掉，反馈只留音效 + 粒子
  //     （粒子是独立浮层，不碰卡面 transform）。
  //   ⚠ 打点时机从 dur-120 改成 **dur**：位移走完才落地，才符合"落地"的语义。
  function glide(el, opts) {
    opts = opts || {};
    if (!el || !el.classList) return Promise.resolve();
    const dur = A.ms(opts.duration || ANIM.move);
    const kind = kindOf(opts.unit);
    const fam = familyOf(kind);
    el.classList.remove('glide-land');            // 清掉历史遗留类（老版本可能已经挂上）
    return sleep(dur).then(function () {
      if (!el.isConnected) return;
      // 音效：移动落地（脚步/闷响）。有单位信息就按防御力调音调。
      try { if (global.KGSfx) global.KGSfx.move({ unit: opts.unit || null }); } catch (e) { }
      // 落地反馈按兵种分材质：地面扬土、舰船推浪、飞机只留一道尾迹
      const r = rectOf(el);
      if (r) {
        const cx = r.left + r.width / 2, cy = r.top + r.height * 0.85;
        if (fam === 'ground') dustPuff(cx, cy);
        else if (fam === 'ship') wakePuff(cx, cy);
      }
    });
  }
  A.glide = glide;

  /* ------------------------------------------------------------- 落地尘土 */
  function dustPuff(x, y) {
    if (typeof document === 'undefined' || !document.body) return;
    if (!budgetOk()) return;
    for (let i = 0; i < 5; i++) {
      const p = document.createElement('div');
      p.className = 'dust';
      const ang = Math.PI + (Math.PI * i) / 4;      // 只向上半圈扩散
      const dist = 10 + Math.random() * 18;
      const sz = 6 + Math.random() * 8;
      p.style.left = x + 'px';
      p.style.top = y + 'px';
      p.style.width = sz + 'px';
      p.style.height = sz + 'px';
      document.body.appendChild(p);
      void p.offsetWidth;
      p.style.opacity = '0';
      p.style.transform = 'translate(' + (Math.cos(ang) * dist).toFixed(1) + 'px,' +
        (-Math.abs(Math.sin(ang)) * dist).toFixed(1) + 'px) scale(1.6)';
      setTimeout(function () { kill(p); }, 560);
    }
  }
  A.dustPuff = dustPuff;

  /* --------------------------------------------------- 卡面飞入（出牌动画） */
  // 从一个屏幕坐标飞向目标元素位置，然后消失。返回 Promise。
  function flyCard(srcRect, dstEl, artHtml, opts) {
    opts = opts || {};
    if (!srcRect || !dstEl) return Promise.resolve();
    const dst = rectOf(dstEl);
    if (!dst) return Promise.resolve();
    const fdur = A.ms(opts.duration || ANIM.fly);
    const g = document.createElement('div');
    g.className = 'fly-card' + (opts.cls ? ' ' + opts.cls : '');
    g.innerHTML = artHtml || '';
    g.style.left = (srcRect.left + srcRect.width / 2) + 'px';
    g.style.top = (srcRect.top + srcRect.height / 2) + 'px';
    g.style.width = srcRect.width + 'px';
    g.style.height = srcRect.height + 'px';
    document.body.appendChild(g);
    const dx = (dst.left + dst.width / 2) - (srcRect.left + srcRect.width / 2);
    const dy = (dst.top + dst.height / 2) - (srcRect.top + srcRect.height / 2);
    const s = Math.max(0.4, Math.min(1.25, dst.width / Math.max(1, srcRect.width)));
    void g.offsetWidth;
    g.style.transition = 'transform ' + fdur + 'ms cubic-bezier(.2,.85,.25,1), opacity ' + fdur + 'ms ease';
    g.style.transform = 'translate(-50%,-50%) translate(' + dx + 'px,' + dy + 'px) scale(' + s + ')';
    if (opts.fade !== false) g.style.opacity = '0.15';
    return sleep(Math.max(30, fdur - 40)).then(() => { kill(g); });
  }
  A.flyCard = flyCard;

  // 从某个元素（手牌卡）飞向目标元素
  function flyFromEl(srcEl, dstEl, opts) {
    const src = rectOf(srcEl);
    const art = srcEl && srcEl.querySelector && srcEl.querySelector('img');
    const html = art ? '<img src="' + art.getAttribute('src') + '" alt="">'
      : '<div class="fly-text">' + ((srcEl && srcEl.querySelector('.card-name') && srcEl.querySelector('.card-name').textContent) || '') + '</div>';
    return flyCard(src, dstEl, html, opts);
  }
  A.flyFromEl = flyFromEl;

  /* ------------------------------------------------------- 攻击冲刺（撞上去） */
  // 攻击者向目标推进 → 命中回调 → 弹回。全程 await。
  function lunge(sourceEl, targetEl, opts) {
    opts = opts || {};
    // ★ 用布局位置（扣掉残留 transform）算位移：同一段位移动画被抢占/叠加时，
    //   视觉位置带着上一段的 transform 中间态，按它算 dx/dy 会越算越偏（乱窜根源）。
    const a = layoutRectOf(sourceEl), b = layoutRectOf(targetEl);
    if (!a || !b || !sourceEl || !sourceEl.style) return Promise.resolve();
    const motionId = claimMotion(sourceEl);
    // 音效：出手（开火）。放在真正开始位移之前，听感与动作同步。
    //   opts.unit = 攻击者 → 按兵种选炮声/枪声，并按防御力调音调。
    try { if (global.KGSfx) global.KGSfx.attack({ unit: opts.unit || null, target: opts.target || null }); } catch (e) { }
    const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
    const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    const kind = kindOf(opts.unit);
    const style = styleOf(kind);
    const dur = A.ms(opts.duration || ANIM.lunge);
    sourceEl.style.zIndex = '30';
    const moveTo = function (x, y, ms, ease, sc) {
      sourceEl.style.transition = 'transform ' + ms + 'ms ' + (ease || 'ease');
      sourceEl.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)' + (sc ? ' scale(' + sc + ')' : '');
    };
    const clear = function () {
      sourceEl.style.transition = '';
      sourceEl.style.transform = '';
      sourceEl.style.zIndex = '';
      sourceEl.classList.remove('atk-dive', 'atk-gun');
    };
    // 命中瞬间才真正结算（引擎动作），然后弹回
    const hitThenBack = function (backMs, ease) {
      let hit = null;
      if (typeof opts.onHit === 'function') { try { hit = opts.onHit(); } catch (e) { console.error(e); } }
      return Promise.resolve(hit).then(function () {
        if (motionVersion.get(sourceEl) !== motionId) return;
        moveTo(0, 0, A.ms(backMs), ease || 'cubic-bezier(.3,1.4,.5,1)');
        return sleep(A.ms(backMs) + 20);
      }).then(function () { if (motionVersion.get(sourceEl) === motionId) clear(); });
    };

    // ① 火炮 / 舰船 / 工事：原地开火（后坐 + 炮口闪光 + 弹道），不发冲锋
    if (style === 'gun') {
      sourceEl.classList.add('atk-gun');
      try { muzzleFlash(sourceEl, b, kind); } catch (e) { }
      const kick = opts.kick == null ? 0.07 : opts.kick;
      moveTo(-dx * kick, -dy * kick, A.ms(100), 'ease-out');
      const travel = Math.max(A.ms(120), Math.round(dur * 1.3));
      try { tracer(a, b, kind, travel); } catch (e) { }
      return sleep(travel).then(function () {
        if (motionVersion.get(sourceEl) === motionId) moveTo(0, 0, A.ms(160), 'ease-out');
        return hitThenBack(140);
      });
    }

    // ② 轰炸机：爬升 → 掠到目标上空 → 投弹
    if (style === 'bomb') {
      sourceEl.classList.add('atk-dive');
      const up = -Math.abs(a.height) * 1.15;
      const rise = Math.max(A.ms(70), Math.round(dur * 0.7));
      moveTo(dx * 0.3, up, rise, 'ease-out');
      return sleep(rise).then(function () {
        if (motionVersion.get(sourceEl) !== motionId) return hitThenBack(0);
        moveTo(dx * 0.92, dy * 0.5, dur, 'cubic-bezier(.3,0,.6,1)', 1.06);
        return sleep(dur);
      }).then(function () { return hitThenBack(dur + 60); });
    }

    // ③ 战斗机 / 太空战机：拉起 → 俯冲
    if (style === 'dive') {
      sourceEl.classList.add('atk-dive');
      const up = -Math.abs(a.height) * 0.9;
      const rise = Math.max(A.ms(60), Math.round(dur * 0.55));
      moveTo(0, up, rise, 'ease-out');
      return sleep(rise).then(function () {
        if (motionVersion.get(sourceEl) !== motionId) return hitThenBack(0);
        moveTo(dx * 0.94, dy * 0.94, dur, 'cubic-bezier(.4,0,.7,1)', 1.05);
        return sleep(dur);
      }).then(function () { return hitThenBack(dur + 40); });
    }

    // ④ 步兵 / 坦克：撞击式突进 + 起步扬尘
    const reach = opts.reach == null ? 0.52 : opts.reach;   // 推进比例，1.0 会完全压到目标身上
    moveTo(dx * reach, dy * reach, dur, 'cubic-bezier(.35,0,.6,1)', 1.1);
    try { dustPuff(a.left + a.width / 2, a.top + a.height * 0.8); } catch (e) { }
    return sleep(dur).then(function () { return hitThenBack(dur + 40); });
  }
  A.lunge = lunge;

  /* ----------------------------------------------------------- 命中冲击波 */
  function impact(el, kind, opts) {
    opts = opts || {};
    const r = rectOf(el);
    if (!r) return;
    // 弹着材质：没显式给就按**攻击方兵种**推（炮弹/炸弹/枪弹/能量）
    const k = kind || hitKindOf(kindOf(opts.unit));
    // 音效：命中撞击。有 target 就按目标兵种选弹着材质（打装甲=金属、打散兵坑=泥土）。
    try { if (global.KGSfx) global.KGSfx.hit({ target: opts.target || null, unit: opts.unit || null }); } catch (e) { }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const d = document.createElement('div');
    d.className = 'impact' + (k ? ' ' + k : '');
    d.style.left = cx + 'px';
    d.style.top = cy + 'px';
    document.body.appendChild(d);
    setTimeout(() => kill(d), A.ms(520));
    // 视觉特效：冲击环（炮弹/炸弹/能量才有）+ 迸射粒子 + 炸弹的烟
    if (k === 'shell' || k === 'bomb' || k === 'energy') shockRing(cx, cy, k);
    sparkBurst(cx, cy, k);
    if (k === 'bomb') smokePuff(cx, cy);
  }
  A.impact = impact;

  /* ------------------------------------------------------- 命中火花粒子 */
  // 在 (x,y) 处生成一圈向外飞散的小粒子，纯 DOM + CSS 过渡，不引入 canvas。
  function sparkBurst(x, y, kind) {
    if (typeof document === 'undefined' || !document.body) return;
    if (!budgetOk()) return;
    const n = kind === 'death' ? 14 : (kind === 'bomb' ? 18 : (kind === 'shell' ? 12 : (kind === 'death-air' ? 12 : 9)));
    for (let i = 0; i < n; i++) {
      const p = document.createElement('div');
      p.className = 'spark' + (kind ? ' ' + kind : '');
      const ang = (Math.PI * 2 * i) / n + Math.random() * 0.6;
      const dist = 26 + Math.random() * 34;
      const dx = Math.cos(ang) * dist;
      const dy = Math.sin(ang) * dist - 8;             // 略微上扬，像溅射
      const sz = 3 + Math.random() * 4;
      p.style.left = x + 'px';
      p.style.top = y + 'px';
      p.style.width = sz + 'px';
      p.style.height = sz + 'px';
      document.body.appendChild(p);
      // 触发过渡（下一帧改 transform）；不加 CSS 变量，避免依赖 style.setProperty
      void p.offsetWidth;
      p.style.opacity = '0';
      p.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(.4)';
      setTimeout(function () { kill(p); }, 620);
    }
  }
  A.sparkBurst = sparkBurst;

  /* --------------------------------------------------------- 飘伤害/增益数字 */
  function floatAt(x, y, text, kind) {
    if (typeof document === 'undefined' || !document.body) return;
    const d = document.createElement('div');
    d.className = 'dmg-float' + (kind ? ' ' + kind : '');
    d.textContent = text;
    d.style.left = x + 'px';
    d.style.top = y + 'px';
    document.body.appendChild(d);
    setTimeout(() => kill(d), A.ms(950));
  }
  function floatValue(el, text, kind) {
    const r = rectOf(el);
    if (!r) return;
    floatAt(r.left + r.width / 2, r.top + r.height * 0.3, text, kind);
  }
  A.floatAt = floatAt;
  // HUD 数字跳动（指挥点/上限/牌库/反制数）：原版回合开始时指挥点是跳字 +N 的
  A.kreditFloat = function (anchorEl, text, kind) {
    const r = rectOf(anchorEl);
    if (!r) return;
    floatAt(r.left + r.width / 2, r.top + r.height * 0.1, text, kind || 'gain');
  };
  A.floatValue = floatValue;

  /* ------------------------------------------------------------- 死亡淡出 */
  // 在元素被移除**之前**调用：标记 .dying，等动画播完再由调用方清理。
  function die(el, opts) {
    opts = opts || {};
    if (!el || !el.classList) return Promise.resolve();
    const dur = A.ms(opts.duration || ANIM.die);
    const fam = familyOf(kindOf(opts.unit));
    // 音效：被消灭。有单位信息就按它的防御力调音调（重单位炸得更沉）。
    try { if (global.KGSfx) global.KGSfx.die({ unit: opts.unit || null }); } catch (e) { }
    // 视觉特效：地面炸碎片 / 空中拖着烟坠落 / 舰船翻沉
    const r = rectOf(el);
    if (r) {
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      sparkBurst(cx, cy, fam === 'air' ? 'death-air' : fam === 'ship' ? 'death-ship' : 'death');
      if (fam === 'air') smokePuff(cx, cy);
      else if (fam === 'ship') wakePuff(cx, cy + r.height * 0.3);
    }
    // ★ 动画类必须挂在**卡面**上：CSS 是 '.card.dying'（淡出 + 灰化 + 旋转）。
    //   调用方（renderLine）传进来的是外层 '.slot' —— 类挂在 .slot 上时选择器不匹配，
    //   **死亡动画永远不播**，只剩下面的爆点粒子（用户报的"被消灭时没特效"）。
    const visual = (el.classList && el.classList.contains('card'))
      ? el : ((el.querySelector && el.querySelector('.card')) || el);
    visual.classList.remove('dying-air', 'dying-ship');
    if (fam === 'air') visual.classList.add('dying-air');
    else if (fam === 'ship') visual.classList.add('dying-ship');
    visual.classList.add('dying');
    return sleep(dur).then(() => { kill(el); });
  }
  A.die = die;

  /* ------------------------------------------------ 抽牌：从手牌区最右边滑入
   * 制作者口径：抽到的牌**从手牌区域的最右边开始**，平滑地平移到它在手牌里的位置
   * （不再从牌库飞过来）。直接动**真实的手牌元素**，不造 ghost —— 手感更连贯。 */
  A.slideInFromRight = function (el, handEl, opts) {
    opts = opts || {};
    if (!el || !el.style) return;
    const hr = rectOf(handEl), cr = rectOf(el);
    let from = 150;
    if (hr && cr) from = Math.max(48, Math.round(hr.right - cr.left));   // 起点：手牌区右边缘之外
    try { if (el.style.setProperty) el.style.setProperty('--draw-from', from + 'px'); } catch (e) { }
    if (el.classList) el.classList.add('drawn-in');
    setTimeout(function () { if (el.classList) el.classList.remove('drawn-in'); }, A.ms(opts.duration || 460) + 90);
  };

  /* ------------------------------------------------------------ 烧牌（手牌已满）
   * 和抽牌同款"从最右边滑进来"，然后焦化飞进弃牌堆 —— 让"烧了哪张"看得见。 */
  A.burnCard = function (handEl, discardEl, artHtml, opts) {
    opts = opts || {};
    if (typeof document === 'undefined' || !document.body) return Promise.resolve();
    try { if (global.KGSfx && global.KGSfx.burn) global.KGSfx.burn(); } catch (e) { }
    const hr = rectOf(handEl);
    if (!hr) return Promise.resolve();
    const dr = rectOf(discardEl);
    const w = opts.width || 96, h = opts.height || 132;
    const y = Math.round(hr.top + Math.max(0, (hr.height - h) / 2));
    const g = A.card('fly-card burn-card');
    g.innerHTML = artHtml || '<div class="fly-text">烧牌</div>';
    g.style.width = w + 'px';
    g.style.height = h + 'px';
    g.style.left = '0px';
    g.style.top = '0px';
    A.tf(g, 'translate(' + Math.round(hr.right + w * 0.55) + 'px,' + y + 'px) translate(-50%,-50%)');
    g.style.opacity = '0';
    void g.offsetWidth;
    g.style.transition = 'transform ' + A.ms(340) + 'ms cubic-bezier(.2,.85,.25,1), opacity ' + A.ms(150) + 'ms ease';
    g.style.opacity = '1';
    A.tf(g, 'translate(' + Math.round(hr.right - w * 0.5) + 'px,' + y + 'px) translate(-50%,-50%)');
    return sleep(A.ms(420)).then(function () {
      g.classList.add('burning');
      const dx = dr ? Math.round(dr.left + dr.width / 2) : Math.round(hr.right - 60);
      const dy = dr ? Math.round(dr.top + dr.height / 2) : Math.round(y - 60);
      g.style.transition = 'transform ' + A.ms(520) + 'ms ease-in, opacity ' + A.ms(520) + 'ms ease-in, filter ' + A.ms(400) + 'ms ease';
      A.tf(g, 'translate(' + dx + 'px,' + dy + 'px) translate(-50%,-50%) scale(.4)');
      g.style.opacity = '0';
      return sleep(A.ms(560));
    }).then(function () { kill(g); });
  };

  /* ------------------------------------------------------------ 抽牌飞入（旧接口，保留） */
  function drawToHand(deckEl, handEl, artHtml, opts) {
    const src = rectOf(deckEl) || rectOf(handEl);
    const dst = rectOf(handEl);
    if (!src || !dst) return Promise.resolve();
    return flyCard(
      { left: src.left, top: src.top, width: Math.min(60, src.width), height: Math.min(84, src.height) },
      handEl, artHtml, Object.assign({ cls: 'fly-draw', duration: ANIM.fly }, opts || {})
    );
  }
  A.drawToHand = drawToHand;

  /* ------------------------------------------------------------ 回合横幅 */
  function turnBanner(text, sub, kind) {
    const d = document.createElement('div');
    d.className = 'turn-banner' + (kind ? ' ' + kind : '');
    d.innerHTML = '<div class="tb-main">' + (text || '') + '</div>' +
      (sub ? '<div class="tb-sub">' + sub + '</div>' : '');
    document.body.appendChild(d);
    void d.offsetWidth;
    d.classList.add('show');
    return sleep(A.ms(1150)).then(() => {
      d.classList.remove('show');
      d.classList.add('out');
      return sleep(A.ms(360));
    }).then(() => kill(d));
  }
  A.turnBanner = turnBanner;

  /* -------------------------------------------------------- 阵线闪光/高亮 */
  function pulse(el, cls, ms) {
    if (!el || !el.classList) return Promise.resolve();
    const motionId = claimMotion(el);
    const c = cls || 'pulse';
    el.classList.remove(c);
    void el.offsetWidth;
    el.classList.add(c);
    return sleep(A.ms(ms || 520)).then(() => { if (motionVersion.get(el) === motionId) el.classList.remove(c); });
  }
  A.pulse = pulse;

  /* ------------------------------------------------ 对手指令：过场式演出 */
  // 对手打出一张指令牌时的标准演出（三段式）：
  //   ① 从屏幕上方落下、停在画面中央偏上（"亮牌"）
  //   ② 横移到画面左侧
  //   ③ 停留 holdMs 后，继续向左移出屏幕外
  // 全程 Promise 化，调用方 await 完再走下一步。
  /* 指令牌过场动画（敌我通用）
   *   opts.side: 'foe'（默认，停靠**左侧**）| 'self'（停靠**右侧**）
   *
   * 三段式：
   *   ① 从屏幕上方落下（带回弹）
   *   ② 横移到屏侧停靠（左/右由 side 决定）+ 呼吸光晕
   *   ③ 停留 holdMs（默认 1s）→ 移出屏幕外
   *
   * 历史上本函数写死"左侧停靠"、只给 AI 用（名字叫 playOpponentOrder）。
   * 现在敌我共用：AI 停左、我方停右，其余时长/缓动/光晕完全一致。
   */
  function playOrderCard(opts) {
    opts = opts || {};
    const artHtml = opts.artHtml || '';
    const name = opts.name || '指令';
    const w = opts.width || 196, h = opts.height || 276;   // 放大过场亮牌（132×186 太小看不清卡面）
    const isSelf = opts.side === 'self';
    // 演出速度档位：四段时长一起缩放
    opts = Object.assign({}, opts, {
      dropMs: A.ms(opts.dropMs || 420), slideMs: A.ms(opts.slideMs || 460),
      holdMs: A.ms(opts.holdMs == null ? 1000 : opts.holdMs), exitMs: A.ms(opts.exitMs || 520),
    });

    const vw = (typeof innerWidth === 'number' ? innerWidth : 1280);
    const vh = (typeof innerHeight === 'number' ? innerHeight : 800);

    // ★ 矮屏（手机横屏）：196×276 的过场亮牌按"卡顶 = 0.42*vh"停靠，卡底必然伸到
    //   0.42*vh + 276 —— vh≈290 时底部约 45% 在屏幕外（制作者："一半都在屏幕底下"）。
    //   矮屏（放不下：yTop + h > vh - 16）时**缩小并上移**：卡降到 160×224，停靠点取
    //   "卡高之外空间"的 38% 偏上，顶底都留呼吸位。桌面（放得下）不进这个分支，
    //   PC 演出保持原样（制作者 2026-09-25 要求）。
    let cw = w, ch = h;
    let yTop = Math.round(vh * 0.42);
    if (yTop + h > vh - 16) {
      cw = 160; ch = 224;
      yTop = Math.max(12, Math.round((vh - ch) * 0.38));
    }

    if (activeOrderCancel) activeOrderCancel();
    const g = A.card('fly-card opp-order' + (isSelf ? ' mine' : '') + (opts.cls ? ' ' + opts.cls : ''));
    g.innerHTML = artHtml || '<div class="fly-text">' + name + '</div>';
    g.style.width = cw + 'px';
    g.style.height = ch + 'px';

    // 停靠点：屏外上方 → 画面中央偏上 → 左侧或右侧 → 屏外（对应的一侧）
    const centerLeft = Math.round(vw * 0.5);
    // sideStop 是"停靠时那张牌的**左边缘 x**"。右侧停靠要再减掉牌宽，让它贴右边。
    const ratio = opts.sideRatio != null ? opts.sideRatio : 0.13;
    const leftStop = Math.round(vw * ratio);
    const rightStop = Math.round(vw - vw * ratio - cw);
    const sideStop = isSelf ? Math.min(rightStop, vw - cw - 24) : Math.max(24, leftStop);
    const offTop = -Math.round(ch * 0.9);
    // 移出方向与此侧一致
    const offSide = isSelf ? Math.round(vw + cw * 0.2) : -Math.round(cw * 1.2);

    g.style.left = '0px';
    g.style.top = '0px';
    g.style.opacity = '0';

    // ① 从拖牌松手位置飞入；AI / 自动触发仍从屏幕上方落下。
    const src = opts.sourceRect;
    const startX = src ? (src.left + src.width / 2) : centerLeft;
    const startY = src ? (src.top + src.height / 2) : offTop;
    const startScale = src ? Math.max(.3, Math.min(.62, src.width / cw)) : 1;
    A.tf(g, src
      ? 'translate(' + startX + 'px,' + startY + 'px) translate(-50%,-50%) scale(' + startScale + ') rotate(-8deg)'
      : 'translate(' + startX + 'px,' + startY + 'px) rotate(0deg)');
    void g.offsetWidth;
    g.style.transition = 'transform ' + (opts.dropMs || 420) + 'ms cubic-bezier(.25,1.15,.4,1), opacity 200ms ease';
    g.style.opacity = '1';
    A.tf(g, 'translate(' + centerLeft + 'px,' + yTop + 'px) rotate(0deg)');

    const tilt = isSelf ? 2.5 : -2.5;                    // 镜像倾斜，视觉对称
    const exitTilt = isSelf ? 8 : -8;

    let canceled = false, cancelWait;
    const canceledSignal = new Promise(resolve => { cancelWait = resolve; });
    const cancel = function () {
      if (canceled) return;
      canceled = true;
      g.classList.add('interrupted');
      try { g.style.transform = getComputedStyle(g).transform; } catch (e) { }
      g.style.transition = 'none';
      void g.offsetWidth;
      g.style.transition = 'opacity 110ms ease, filter 110ms ease';
      g.style.opacity = '0';
      setTimeout(function () { kill(g); }, 130);
      cancelWait();
    };
    activeOrderCancel = cancel;
    const wait = ms => Promise.race([A.sleep(ms).then(() => true), canceledSignal.then(() => false)]);
    return (async function () {
      if (!(await wait(opts.dropMs || 420))) return;
      // ② 横移到屏侧
      g.classList.add('settled');
      g.style.transition = 'transform ' + (opts.slideMs || 460) + 'ms cubic-bezier(.3,.75,.25,1)';
      A.tf(g, 'translate(' + sideStop + 'px,' + yTop + 'px) rotate(' + tilt + 'deg)');
      if (!(await wait(opts.slideMs || 460))) return;
      // ③ 停留 → 移出屏幕外
      if (!(await wait(opts.holdMs == null ? 1000 : opts.holdMs))) return;
      g.classList.add('leaving');
      g.style.transition = 'transform ' + (opts.exitMs || 520) + 'ms cubic-bezier(.5,0,.85,.3), opacity ' + (opts.exitMs || 520) + 'ms ease';
      g.style.opacity = '0';
      A.tf(g, 'translate(' + offSide + 'px,' + yTop + 'px) rotate(' + exitTilt + 'deg) scale(.9)');
      await wait((opts.exitMs || 520) - 40);
    })().finally(function () {
      if (!canceled) kill(g);
      if (activeOrderCancel === cancel) activeOrderCancel = null;
    });
  }
  A.playOrderCard = playOrderCard;
  // 兼容旧名（AI 出指令用；等价于 side:'foe'）
  function playOpponentOrder(opts) {
    return playOrderCard(Object.assign({}, opts || {}, { side: 'foe' }));
  }
  A.playOpponentOrder = playOpponentOrder;

  // 统一设置 transform（带 -webkit- 兼容位，某些内核需要）
  function tf(el, v) {
    el.style.transform = v;
    el.style.webkitTransform = v;
  }
  A.tf = tf;

  // 小工具：造一个临时浮层节点（不参与文档流）
  function card(cls) {
    const d = document.createElement('div');
    d.className = cls;
    document.body.appendChild(d);
    return d;
  }
  A.card = card;

  /* --------------------------------------------------------- 粒子预算 */
  // 极快档 + 连续出牌时，粒子节点会叠成一片（又糊又费性能）。超过预算就不再生成新粒子，
  // 但**不**影响冲击环/震屏这类"有语义"的反馈。
  const FX_NODE_SEL = '.spark, .dust, .smoke, .wake, .puff, .shell';
  const FX_NODE_MAX = 140;
  function budgetOk() {
    try {
      if (typeof document === 'undefined' || !document.querySelectorAll) return true;
      return document.querySelectorAll(FX_NODE_SEL).length < FX_NODE_MAX;
    } catch (e) { return true; }
  }
  A.budgetOk = budgetOk;

  /* ================================================= 弹道 / 炮口 / 冲击环 */
  // 一个沿直线飞向目标的弹丸（炮弹/能量弹）。纯 transform 过渡，无 canvas。
  function tracer(a, b, kind, ms) {
    if (typeof document === 'undefined' || !document.body) return;
    const p = document.createElement('div');
    p.className = 'shell' + (kind === 'spacefighter' ? ' energy' : kind === 'bomber' ? ' bomb' : '');
    p.style.left = (a.left + a.width / 2) + 'px';
    p.style.top = (a.top + a.height / 2) + 'px';
    document.body.appendChild(p);
    const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
    const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    void p.offsetWidth;
    p.style.transition = 'transform ' + ms + 'ms cubic-bezier(.3,.1,.6,1), opacity ' + ms + 'ms linear';
    p.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    setTimeout(function () { kill(p); }, ms + 140);
  }
  A.tracer = tracer;

  // 炮口闪光：出现在攻击者朝目标那一侧的边缘
  function muzzleFlash(el, b, kind) {
    const r = rectOf(el);
    if (!r || typeof document === 'undefined' || !document.body) return;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const tx = b.left + b.width / 2, ty = b.top + b.height / 2;
    const ang = Math.atan2(ty - cy, tx - cx);
    const off = Math.min(r.width, r.height) * 0.42;
    const w = document.createElement('div');
    w.className = 'muzzle-wrap';
    w.style.left = (cx + Math.cos(ang) * off) + 'px';
    w.style.top = (cy + Math.sin(ang) * off) + 'px';
    w.style.transform = 'translate(-50%,-50%) rotate(' + (ang * 180 / Math.PI).toFixed(1) + 'deg)';
    const d = document.createElement('div');
    d.className = 'muzzle' + (kind === 'spacefighter' ? ' energy' : '');
    w.appendChild(d);
    document.body.appendChild(w);
    setTimeout(function () { kill(w); }, A.ms(300));
  }
  A.muzzleFlash = muzzleFlash;

  // 冲击环：从命中点向外扩散的一圈白光
  function shockRing(x, y, kind) {
    if (typeof document === 'undefined' || !document.body) return;
    const d = document.createElement('div');
    d.className = 'shock' + (kind ? ' ' + kind : '');
    d.style.left = x + 'px';
    d.style.top = y + 'px';
    document.body.appendChild(d);
    void d.offsetWidth;
    d.classList.add('go');
    setTimeout(function () { kill(d); }, A.ms(560));
  }
  A.shockRing = shockRing;

  // 烟：炸弹/坠机用，几团灰黑向上升散
  function smokePuff(x, y) {
    if (typeof document === 'undefined' || !document.body) return;
    if (!budgetOk()) return;
    for (let i = 0; i < 6; i++) {
      const p = document.createElement('div');
      p.className = 'smoke';
      const sz = 14 + Math.random() * 18;
      p.style.left = (x + (Math.random() - 0.5) * 34) + 'px';
      p.style.top = (y + (Math.random() - 0.5) * 22) + 'px';
      p.style.width = sz + 'px';
      p.style.height = sz + 'px';
      document.body.appendChild(p);
      void p.offsetWidth;
      p.style.opacity = '0';
      p.style.transform = 'translate(' + ((Math.random() - 0.5) * 40).toFixed(0) + 'px,' +
        (-24 - Math.random() * 30).toFixed(0) + 'px) scale(1.9)';
      setTimeout(function () { kill(p); }, A.ms(900));
    }
  }
  A.smokePuff = smokePuff;

  // 尾浪：舰船落地/翻沉时向两侧推开的白色水花
  function wakePuff(x, y) {
    if (typeof document === 'undefined' || !document.body) return;
    if (!budgetOk()) return;
    for (let i = 0; i < 4; i++) {
      const p = document.createElement('div');
      p.className = 'wake';
      const dir = i % 2 ? 1 : -1;
      p.style.left = x + 'px';
      p.style.top = y + 'px';
      document.body.appendChild(p);
      void p.offsetWidth;
      p.style.opacity = '0';
      p.style.transform = 'translate(' + (dir * (16 + Math.random() * 22)).toFixed(0) + 'px,-6px) scale(1.7)';
      setTimeout(function () { kill(p); }, A.ms(700));
    }
  }
  A.wakePuff = wakePuff;

  /* ========================================== 指令（法术）：按效果分类的演出 */
  // 原版里每类指令的出场演出不一样：伤害是"火光 + 震屏"，消灭是"碎裂"，
  // 增益是"金光上升"，抽牌是"卡牌飞入手牌"，情报是"扫描"…
  // 这张表把效果 op 归成九类，ui.js 用它决定播哪一套演出。
  const CAT_RULES = [
    ['destroy', /^(destroy|destroyAll|silence|suppressHQ|mill|discard|discardAll|discardFromDeck|discardChosenHand|loseDefense)$/],
    ['fire', /^(damage|damageAll|damageHQ|damageSplit|fight|setDefense|debuff|debuffTemp)$/],
    ['heal', /^(heal|healAll|healHQ|armorBonus|hqArmor|hqMaxUp)$/],
    ['intel', /^(intel|reveal)$/],
    ['buff', /^(buff|buffAll|buffCardsInPiles|buffDeckAndHand|grant|grantAll|grantMod|grantEffect|aura|auraBuff|hqKeyword|hqEnchant|setStats|setHandCost|setOpCost|opCostMod|opCostModAll|handOpCostMod|globalOpCostMod|gainKreditSlot|gainKredits|nextTurnSlots|nextTurnKredits)$/],
    ['debuff', /^(pin|unpin|loseKredits|loseKreditSlots|removeKeyword|suppress|cannotAct)$/],
    ['summon', /^(summon|summonFromHand|deckToField|handToField|handUnitToFrontline|move|returnToHand|retreat|upgradeSelf|transformHandCard|reposition)$/],
    ['supply', /^(draw|drawUntil|discover|develop|addCardToHand|deckToHand|shuffleIn|shuffleInUntil|shuffleRandomSet|copyToDeck|copyHandCard|chooseOne|chooseHandCard|chooseFromHand|randomPick)$/],
  ];
  const CAT_CN = A.CAT_CN = {
    destroy: '消灭', fire: '伤害', heal: '治疗', intel: '情报',
    buff: '增益', debuff: '削弱', summon: '调度', supply: '补给', generic: '指令',
  };
  // 收集一棵效果树里所有 op 名（条件/抉择/循环都是嵌套对象）
  A.collectOps = function (node, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!node || depth > 8) return out;
    if (Array.isArray(node)) { node.forEach(function (n) { A.collectOps(n, out, depth + 1); }); return out; }
    if (typeof node !== 'object') return out;
    if (typeof node.op === 'string') out.push(node.op);
    Object.keys(node).forEach(function (k) {
      const v = node[k];
      if (v && typeof v === 'object') A.collectOps(v, out, depth + 1);
    });
    return out;
  };
  A.classifyOps = function (ops) {
    const list = (ops || []).map(function (s) { return String(s).split('.').pop(); });
    for (let i = 0; i < CAT_RULES.length; i++) {
      const name = CAT_RULES[i][0], re = CAT_RULES[i][1];
      for (let j = 0; j < list.length; j++) { if (re.test(list[j])) return name; }
    }
    return 'generic';
  };

  function boardRectOf(opts) {
    const el = (opts && opts.boardEl) || (typeof document !== 'undefined' ? document.querySelector('#boardScroll') : null);
    const r = rectOf(el);
    if (r && r.width) return r;
    const w = (typeof innerWidth === 'number' ? innerWidth : 1280);
    const h = (typeof innerHeight === 'number' ? innerHeight : 800);
    return { left: 0, top: 0, width: w, height: h };
  }
  // 一撮粒子：从 (x,y) 向四周（up=true 时向上半圈）散开
  function puffAt(x, y, cls, n, spread, up) {
    if (!budgetOk()) return;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('div');
      p.className = cls;
      const ang = up ? (-Math.PI / 2 + (Math.random() - 0.5) * 1.7) : (Math.random() * Math.PI * 2);
      const dist = spread * (0.45 + Math.random());
      const sz = 5 + Math.random() * 9;
      p.style.left = x + 'px';
      p.style.top = y + 'px';
      p.style.width = sz + 'px';
      p.style.height = sz + 'px';
      document.body.appendChild(p);
      void p.offsetWidth;
      p.style.opacity = '0';
      p.style.transform = 'translate(' + (Math.cos(ang) * dist).toFixed(1) + 'px,' +
        (-Math.abs(Math.sin(ang)) * dist).toFixed(1) + 'px) scale(1.5)';
      setTimeout(function () { kill(p); }, A.ms(760));
    }
  }

  // 分类演出：在棋盘上铺一层"效果层"，再按类别撒粒子/震屏
  A.orderFx = function (cat, opts) {
    opts = opts || {};
    if (typeof document === 'undefined' || !document.body) return Promise.resolve();
    const c = CAT_CN[cat] ? cat : 'generic';
    const r = boardRectOf(opts);
    const layer = document.createElement('div');
    layer.className = 'fx-layer fx-' + c;
    layer.style.left = r.left + 'px';
    layer.style.top = r.top + 'px';
    layer.style.width = r.width + 'px';
    layer.style.height = r.height + 'px';
    document.body.appendChild(layer);
    const board = (opts.boardEl && opts.boardEl.nodeType === 1) ? opts.boardEl : document.querySelector('#boardScroll');
    const foeLine = document.querySelector('#foeSupport');
    const myLine = document.querySelector('#mySupport');
    if (c === 'fire' || c === 'destroy') {
      const rr = rectOf(foeLine) || r;
      const num = c === 'destroy' ? 5 : 3;
      for (let i = 0; i < num; i++) {
        const x = rr.left + rr.width * (0.12 + 0.76 * Math.random());
        const y = rr.top + rr.height * (0.2 + 0.6 * Math.random());
        shockRing(x, y, c === 'destroy' ? 'death' : 'shell');
        sparkBurst(x, y, c === 'destroy' ? 'death' : 'shell');
        if (c === 'fire') smokePuff(x, y);
      }
      if (board && board.classList) {
        board.classList.remove('board-shake', 'board-shake-strong');
        void board.offsetWidth;
        board.classList.add(c === 'destroy' ? 'board-shake-strong' : 'board-shake');
        setTimeout(function () { board.classList.remove('board-shake', 'board-shake-strong'); }, A.ms(c === 'destroy' ? 620 : 380));
      }
    } else if (c === 'buff' || c === 'heal') {
      const rr = rectOf(myLine) || r;
      puffAt(rr.left + rr.width / 2, rr.top + rr.height * 0.72, c === 'heal' ? 'puff heal' : 'puff buff', 12, 62, true);
    } else if (c === 'debuff') {
      const rr = rectOf(foeLine) || r;
      puffAt(rr.left + rr.width / 2, rr.top + rr.height * 0.3, 'puff debuff', 12, 56, false);
    } else if (c === 'intel') {
      puffAt(r.left + r.width * 0.5, r.top + r.height * 0.1, 'puff intel', 10, 72, false);
    } else if (c === 'supply') {
      const deck = document.querySelector('#myDeck');
      const rr = rectOf(deck) || { left: r.left + 60, top: r.top + r.height * 0.82, width: 20, height: 20 };
      puffAt(rr.left + rr.width / 2, rr.top, 'puff supply', 10, 48, true);
    } else if (c === 'summon') {
      const rr = rectOf(myLine) || r;
      puffAt(rr.left + rr.width * 0.5, rr.top + rr.height * 0.5, 'puff summon', 12, 54, true);
    }
    setTimeout(function () { kill(layer); }, A.ms(c === 'destroy' ? 940 : 760));
    return sleep(A.ms(opts.ms || 520));
  };

  /* =============================== 反馈类演出：情报 / 反制 / 老兵 / 牌库 */
  // 情报扫描：在指定区域上扫过一道青色光带（"看到对手手牌"的可见反馈）
  A.intelScan = function (el, opts) {
    opts = opts || {};
    if (typeof document === 'undefined' || !document.body) return Promise.resolve();
    try { if (global.KGSfx && global.KGSfx.intel) global.KGSfx.intel(); } catch (e) { }
    const r = el ? rectOf(el) : null;
    if (!r) return Promise.resolve();
    const d = document.createElement('div');
    d.className = 'scan' + (opts.cls ? ' ' + opts.cls : '');
    d.style.left = r.left + 'px';
    d.style.top = (r.top - 8) + 'px';
    d.style.width = r.width + 'px';
    d.style.height = Math.max(12, r.height + 16) + 'px';
    document.body.appendChild(d);
    void d.offsetWidth;
    d.classList.add('go');
    setTimeout(function () { kill(d); }, A.ms(820));
    return sleep(A.ms(opts.ms || 520));
  };

  // 反制「埋设」：在反制堆上盖一个琥珀色封印环
  A.counterSet = function (el, opts) {
    opts = opts || {};
    if (typeof document === 'undefined' || !document.body) return Promise.resolve();
    try { if (global.KGSfx && global.KGSfx.counterSet) global.KGSfx.counterSet(); } catch (e) { }
    const r = el ? rectOf(el) : null;
    if (!r) return Promise.resolve();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const d = document.createElement('div');
    d.className = 'seal';
    d.style.left = cx + 'px';
    d.style.top = cy + 'px';
    document.body.appendChild(d);
    void d.offsetWidth;
    d.classList.add('go');
    setTimeout(function () { kill(d); }, A.ms(760));
    return sleep(A.ms(opts.ms || 460));
  };

  // 反制「触发」：琥珀色爆闪 + 冲击环 + 飘字
  A.counterFire = function (el, text) {
    if (typeof document === 'undefined' || !document.body) return Promise.resolve();
    try { if (global.KGSfx && global.KGSfx.counterFire) global.KGSfx.counterFire(); } catch (e) { }
    const r = el ? rectOf(el) : null;
    if (!r) return Promise.resolve();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    shockRing(cx, cy, 'gold');
    sparkBurst(cx, cy, 'shell');
    floatAt(cx, cy, text || '反制触发', 'kredit');
    return sleep(A.ms(520));
  };

  // 老兵升级：金色光环 + 向上金光（替换原单位时用，别再用"拍桌"）
  A.veteranUp = function (el) {
    if (typeof document === 'undefined' || !document.body) return Promise.resolve();
    try { if (global.KGSfx && global.KGSfx.veteran) global.KGSfx.veteran(); } catch (e) { }
    const r = el ? rectOf(el) : null;
    if (r) {
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // 双金环（错开一点时间）+ 光柱 + 向上金光，让"升为老兵"在一屏里认得出来
      shockRing(cx, cy, 'gold');
      setTimeout(function () { shockRing(cx, cy, 'gold'); }, A.ms(180));
      const beam = document.createElement('div');
      beam.className = 'veteran-beam';
      beam.style.left = cx + 'px';
      beam.style.top = (r.top + r.height) + 'px';
      beam.style.height = Math.round(r.height * 1.6) + 'px';
      document.body.appendChild(beam);
      setTimeout(function () { kill(beam); }, A.ms(900));
      puffAt(cx, cy + r.height * 0.4, 'puff buff', 16, 78, true);
      floatAt(cx, cy, '老兵', 'kredit');
    }
    if (el && el.classList) {
      el.classList.remove('veteran-up');
      void el.offsetWidth;
      el.classList.add('veteran-up');
      setTimeout(function () { el.classList.remove('veteran-up'); }, A.ms(1150));
    }
    return sleep(A.ms(760));
  };

  // 洗入卡组：几张卡影从上方飞进牌库 + 牌库脉冲
  A.deckShuffle = function (deckEl, n) {
    if (typeof document === 'undefined' || !document.body) return Promise.resolve();
    try { if (global.KGSfx && global.KGSfx.shuffle) global.KGSfx.shuffle(); } catch (e) { }
    const r = rectOf(deckEl);
    if (!r) return Promise.resolve();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const cnt = Math.max(1, Math.min(4, n || 1));
    for (let i = 0; i < cnt; i++) {
      const p = A.card('shuffle-chip');
      p.style.left = (cx + (Math.random() - 0.5) * 240) + 'px';
      p.style.top = (cy - 130 - Math.random() * 80) + 'px';
      void p.offsetWidth;
      p.style.transition = 'transform ' + A.ms(560) + 'ms cubic-bezier(.3,.7,.3,1), opacity ' + A.ms(560) + 'ms ease';
      p.style.transform = 'translate(' + ((Math.random() - 0.5) * 40).toFixed(0) + 'px,' + (120 + Math.random() * 40).toFixed(0) + 'px) scale(.72)';
      p.style.opacity = '0';
      setTimeout(function () { kill(p); }, A.ms(760));
    }
    A.pulse(deckEl, 'pulse', 420);
    return sleep(A.ms(420));
  };

  // 反制触发：把那张反制牌从"反制"堆飞出来亮一下卡面（原版触发反制会展示卡面）
  A.counterReveal = function (artHtml, pileEl, opts) {
    opts = opts || {};
    if (typeof document === 'undefined' || !document.body) return Promise.resolve();
    try { if (global.KGSfx && global.KGSfx.counterFire) global.KGSfx.counterFire({ gain: 0.9 }); } catch (e) { }
    const r = rectOf(pileEl);
    const vw = (typeof innerWidth === 'number' ? innerWidth : 1280);
    const vh = (typeof innerHeight === 'number' ? innerHeight : 800);
    const sx = r ? (r.left + r.width / 2) : vw * 0.12;
    const sy = r ? (r.top + r.height / 2) : vh * 0.6;
    const ex = Math.round(vw * 0.5), ey = Math.round(vh * 0.42);
    const w = opts.width || 132, h = opts.height || 186;
    const g = A.card('fly-card counter-reveal');
    g.innerHTML = artHtml || '<div class="fly-text">反制</div>';
    g.style.width = w + 'px';
    g.style.height = h + 'px';
    // ★ 必须显式给 left/top=0：position:fixed 且偏移为 auto 时，元素会停在"它本该在的文档流位置"
    //   （append 到 body 末尾 = 屏幕底部之外），下面的 translate 就白算了。（playOrderCard 早就这么写）
    g.style.left = '0px';
    g.style.top = '0px';
    A.tf(g, 'translate(' + sx + 'px,' + sy + 'px) translate(-50%,-50%) scale(.4) rotate(-8deg)');
    g.style.opacity = '0';
    void g.offsetWidth;
    g.style.transition = 'transform ' + A.ms(420) + 'ms cubic-bezier(.25,1.15,.4,1), opacity ' + A.ms(200) + 'ms ease';
    g.style.opacity = '1';
    A.tf(g, 'translate(' + ex + 'px,' + ey + 'px) translate(-50%,-50%) scale(1) rotate(0deg)');
    return sleep(A.ms(420) + A.ms(opts.holdMs == null ? 700 : opts.holdMs)).then(function () {
      g.style.transition = 'transform ' + A.ms(360) + 'ms ease, opacity ' + A.ms(360) + 'ms ease';
      g.style.opacity = '0';
      A.tf(g, 'translate(' + ex + 'px,' + (ey - 30) + 'px) translate(-50%,-50%) scale(.94)');
      return sleep(A.ms(360));
    }).then(function () { kill(g); });
  };

  // 反制挂起：一枚小牌影从手牌飞向"反制"堆，落点盖一个封印环（比只让数字 +1 有实感）
  A.holdCounter = function (srcRect, pileEl, opts) {
    opts = opts || {};
    if (typeof document === 'undefined' || !document.body) return Promise.resolve();
    const dst = rectOf(pileEl);
    if (!dst) return Promise.resolve();
    const src = srcRect || { left: dst.left, top: dst.top - 120, width: 34, height: 48 };
    const chip = A.card('counter-chip counter-flight');
    if (opts.artHtml) chip.innerHTML = opts.artHtml;
    chip.style.margin = '0';
    chip.style.left = (src.left + src.width / 2) + 'px';
    chip.style.top = (src.top + src.height / 2) + 'px';
    if (src.width) { chip.style.width = Math.min(46, src.width) + 'px'; chip.style.height = Math.min(64, src.height) + 'px'; }
    const dx = (dst.left + dst.width / 2) - (src.left + src.width / 2);
    const dy = (dst.top + dst.height / 2) - (src.top + src.height / 2);
    A.tf(chip, 'translate(-50%,-50%) scale(1)');
    void chip.offsetWidth;
    const ms = A.ms(420);
    chip.style.transition = 'transform ' + ms + 'ms cubic-bezier(.3,.8,.3,1), opacity ' + ms + 'ms ease';
    A.tf(chip, 'translate(-50%,-50%) translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(.55)');
    return sleep(ms).then(function () {
      kill(chip);
    });
  };

  /* ------------------------------------------------------------- 工具函数 */
  function kill(el) { try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) { } }
  A.kill = kill;
})(typeof window !== 'undefined' ? window : globalThis);
