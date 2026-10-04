/* ==========================================================================
 * KG 联机 —— 数据同步 + 确定性锁步（可在浏览器与 Node 里跑）
 *
 * 这一层解决两件事：
 *
 * 一、DIY 数据对等
 *   两个人的卡池不可能天然一样（各自导入过卡、各自改过数值/效果）。原版 KARDS 不存在
 *   这个问题（卡池在服务器上人人一致），必须自己解决：
 *     ① 一致性校验：把每张卡的**参与判定的字段**做指纹，两边比对。
 *     ② 同 id 同指纹 → 一致；同 id 不同指纹 → 冲突（不同步，两边跑出来必然不同）。
 *     ③ 一方独有的卡 → 把它的定义 + 效果 DSL 取过来，在**本地原样实现**（写进卡池与
 *        效果覆盖层），并递归带上它效果里引用到的其它卡（依赖闭包），保证引用不会悬空。
 *   判"独有"的依据是"对方有没有这张卡"，所以双方各算出"我缺的"和"我多余的"。
 *
 * 二、确定性锁步
 *   引擎里所有随机数都走 seeded mulberry32（state.rng），唯一的异步输入是 chooser
 *   （KG.ask）。所以只要两边用同一个种子、同一串动作、同一批 chooser 答案，状态必然一致。
 *   做法：
 *     · 出牌方本地照常用真实 UI 跑引擎，同时把 (动作, chooser 答案) 录下来；
 *     · 把这条"动作包"发给对方，对方用录好的答案当 chooser 回放；
 *     · 每一步之后两边各算一次状态指纹，比对不上就当场报"不同步"。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NS = global.KGNetSync = global.KGNetSync || {};

  /* ==================================================== 一、DIY 数据指纹 */

  // 参与判定的字段（改了这些，两边的结算就会不一样）
  const FINGERPRINT_FIELDS = [
    'name', 'set', 'cardType', 'unitType', 'cost', 'attack', 'defense', 'opCost',
    'keywords', 'kwMap', 'kwValues', 'text', 'rarity', 'token', 'referenceCard',
    'dualAttack', 'effects', 'targetsNeeded', 'upgrades', 'upgradeTo', 'upgradeKills',
    'startInHand', 'autoUse', 'costModPerOrder', 'costModPerIntel', 'costModPerKeyword',
    'armor', 'keywordsRaw', 'notes',
  ];

  function stableStringify(v) {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    if (typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  }
  NS.stableStringify = stableStringify;

  // djb2：够用且不依赖 crypto（浏览器/Node 都一致）
  function hash32(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  NS.hash32 = hash32;

  // 一张卡的指纹：只取参与判定的字段。
  // ⚠ 故意不含 id（id 是两边对齐用的键），也不含 art/src（美术图不影响结算）。
  function fingerprint(card) {
    if (!card) return 'none';
    const picked = {};
    FINGERPRINT_FIELDS.forEach(function (k) { if (card[k] !== undefined) picked[k] = card[k]; });
    return hash32(stableStringify(picked));
  }
  NS.fingerprint = fingerprint;

  function fingerprintPool(pool) {
    const out = {};
    (pool || []).forEach(function (c) { if (c && c.id) out[c.id] = fingerprint(c); });
    return out;
  }
  NS.fingerprintPool = fingerprintPool;

  // 整池的"总指纹"：把 id→指纹 排序后哈希，用于快速判断"是不是同一套卡池"
  function poolDigest(pool) {
    const fp = fingerprintPool(pool);
    const keys = Object.keys(fp).sort();
    return hash32(keys.map(k => k + '=' + fp[k]).join(';'));
  }
  NS.poolDigest = poolDigest;

  /* ------------------------------------------- 效果里引用的其它卡（依赖） */
  // 卡的效果可以引用别的卡（加入手牌 / 洗入卡组 / 开发 / 召唤 / 抉择分支…）。
  // 同步一张独有卡时必须把被引用的卡一起带过去，否则对方卡池里找不到 → 运行时静默失效。
  const REF_KEYS = ['cardId', 'id', 'set'];   // id 只在 {op:'addCardToHand', id:'xx'} 这种写法里当卡引用

  function collectCardRefs(card, poolMap, selfId) {
    const refs = new Set();
    const nameToId = {};
    Object.keys(poolMap || {}).forEach(function (id) {
      const n = poolMap[id] && poolMap[id].name;
      if (n && nameToId[n] === undefined) nameToId[n] = id;
    });
    const walk = function (v, key) {
      if (v == null) return;
      if (typeof v === 'string') {
        // 1) 直接写卡 id 的字段
        if ((key === 'cardId' || key === 'card' || key === 'id' || key === 'refCard') && poolMap[v]) refs.add(v);
        else if (key && poolMap[v]) refs.add(v);
        // 2) 写的是卡名（"将一张X加入手牌"）：卡名唯一时就能定位
        if (nameToId[v] && nameToId[v] !== selfId) refs.add(nameToId[v]);
        return;
      }
      if (Array.isArray(v)) { v.forEach(x => walk(x, key)); return; }
      if (typeof v === 'object') {
        Object.keys(v).forEach(function (k) {
          const val = v[k];
          // 卡名类字段（如 {"name":"航天步兵"}）单独按名字解析
          if ((k === 'name' || k === 'cardName') && typeof val === 'string' && nameToId[val] && nameToId[val] !== selfId) {
            refs.add(nameToId[val]);
          }
          walk(val, k);
        });
      }
    };
    walk(card.effects, 'effects');
    if (card.upgradeTo) refs.add(card.upgradeTo);
    refs.delete(selfId);
    return Array.from(refs);
  }
  NS.collectCardRefs = collectCardRefs;

  // 依赖闭包：给一批卡 id，把它们的引用递归展开（最多 4 层，防环）
  function dependencyClosure(ids, poolMap, depth) {
    depth = depth == null ? 4 : depth;
    const need = new Set(ids);
    let frontier = Array.from(need);
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = [];
      frontier.forEach(function (id) {
        const c = poolMap[id];
        if (!c) return;
        collectCardRefs(c, poolMap, id).forEach(function (r) {
          if (!need.has(r) && poolMap[r]) { need.add(r); next.push(r); }
        });
      });
      frontier = next;
    }
    return Array.from(need);
  }
  NS.dependencyClosure = dependencyClosure;

  /* ------------------------------------------------------------ 差异计算 */
  /* 输入两边各自的卡池（数组）：
   * { missing: [id..]   —— 我有、对方没有的（需要对方补给我的）
   *   extra:   [id..]   —— 对方有、我没有的（需要对方发给我的）
   *   conflicts: [{id, mine, theirs}] —— 同名同 id 但内容不同（改法不一致，会跑出两种结果）
   *   same: n           —— 完全一致的张数
   * }
   * mineExtra 是要"发给对方"的，missing 是要"向对方要"的。 */
  function diffPools(myPool, theirPool) {
    const my = {}, th = {};
    (myPool || []).forEach(function (c) { if (c && c.id) my[c.id] = c; });
    (theirPool || []).forEach(function (c) { if (c && c.id) th[c.id] = c; });
    const mineOnly = [], theirsOnly = [], conflicts = [];
    let same = 0;
    Object.keys(my).forEach(function (id) {
      if (!th[id]) { mineOnly.push(id); return; }
      if (fingerprint(my[id]) === fingerprint(th[id])) same++;
      else conflicts.push({ id: id, mine: fingerprint(my[id]), theirs: fingerprint(th[id]) });
    });
    Object.keys(th).forEach(function (id) { if (!my[id]) theirsOnly.push(id); });
    return {
      mineOnly: mineOnly.sort(),
      theirsOnly: theirsOnly.sort(),
      conflicts: conflicts.sort((a, b) => a.id.localeCompare(b.id)),
      same: same,
      consistent: mineOnly.length === 0 && theirsOnly.length === 0 && conflicts.length === 0,
    };
  }
  NS.diffPools = diffPools;

  /* ------------------------------------------- 打包"要发给对方的卡" */
  // 只带参与判定的字段（不含 art/src），并保证引用闭包完整。
  /* 打包要发给对方的卡。
   * needIds      : 对方缺的卡 id（mineOnly）
   * myPoolMap    : 我的完整卡池
   * theirPoolMap : 对方的卡池（用来判断"闭包里的卡对方是否已有"，已有的不用重复发）
   */
  function packCards(needIds, myPoolMap, theirPoolMap, theirFp) {
    const closure = dependencyClosure(needIds, myPoolMap);
    const cards = [], missingDeps = [];
    closure.forEach(function (id) {
      const c = myPoolMap[id];
      if (!c) return;
      // 对方已有且指纹一致 → 不用再传（theirPoolMap 是完整卡对象，theirFp 只有 id→指纹）
      if (theirPoolMap && theirPoolMap[id] && fingerprint(theirPoolMap[id]) === fingerprint(c)) return;
      if (theirFp && theirFp[id] === fingerprint(c)) return;
      cards.push(NS.pickCardFields(c));
      // 闭包里如果还有对方没有的、且不在本轮要发的卡，也要一起发
      if (!needIds.includes(id) && !cards.some(x => x.id === id)) missingDeps.push(id);
    });
    return { cards: cards, closure: closure };
  }
  NS.packCards = packCards;

  // 只保留"能在对方本地原样实现"所需的字段（去掉美术图等体积大又各不相同的）
  function pickCardFields(card) {
    const out = {};
    Object.keys(card || {}).forEach(function (k) {
      if (k === 'art' || k === 'src' || k === 'file' || k === 'image') return;
      out[k] = card[k];
    });
    return out;
  }
  NS.pickCardFields = pickCardFields;

  /* ==================================================== 二、确定性锁步 */

  /* 动作记录器：出牌方本地跑引擎时，把 chooser 的每一次回答记下来。
   *   const rec = NS.recorder(realChooser)
   *   await KG.playCard(state, pi, idx, rec.chooser, opts)
   *   const packet = rec.packet('play', { idx: idx, opts: opts })   // 可 JSON 化
   */
  NS.recorder = function (realChooser) {
    const answers = [];
    return {
      answers: answers,
      chooser: function (req) {
        return Promise.resolve(realChooser(req)).then(function (v) {
          answers.push({ kind: req && req.kind, value: v == null ? null : v });
          return v;
        });
      },
      packet: function (kind, args, extra) {
        return Object.assign({ kind: kind, args: args || {}, answers: answers.slice() }, extra || {});
      },
    };
  };

  /* 动作回放器：用录好的答案回答引擎的 chooser。
   * ⚠ 顺序敏感：引擎问的顺序必须与录制时完全一致；不一致说明两边已经跑偏，
   *   这时候要立刻暴露出来（而不是让它继续用错答案跑下去，越跑越乱）。 */
  NS.player = function (answers, onMismatch) {
    let i = 0;
    const used = [];
    return {
      index: function () { return i; },
      used: used,
      chooser: function (req) {
        if (i >= (answers || []).length) {
          if (onMismatch) onMismatch('答案用完了（引擎多问了一次 ' + (req && req.kind) + '）');
          return Promise.resolve(null);
        }
        const a = answers[i++];
        if (a.kind && req && req.kind && a.kind !== req.kind) {
          if (onMismatch) onMismatch('第 ' + i + ' 次询问类型不符：录制=' + a.kind + ' 回放=' + req.kind);
        }
        used.push(a);
        return Promise.resolve(a.value === undefined ? null : a.value);
      },
      // 回放结束后应当刚好用完（多用/少用都是不同步的信号）
      leftovers: function () { return (answers || []).length - i; },
    };
  };

  /* ★ 动作包 → 引擎调用：整个联机里**唯一**允许执行动作的入口。
   *   参数全部来自动作包本身，绝不含"本地自行判断"的成分 —— 一旦让两边各自推导
   *   "该出哪张牌"，两边就会慢慢跑偏（这是锁步最经典的坑）。 */
  NS.applyPacket = async function (KG, state, pk, chooser) {
    const a = (pk && pk.args) || {};
    switch (pk && pk.kind) {
      case 'mulliganReplace': return KG.mulliganReplace(state, a.pi, a.idxs);
      case 'mulliganDone': return KG.mulliganDone(state, a.pi);
      case 'play': return KG.playCard(state, a.pi, a.handIdx, chooser, a.opts);
      case 'attack': return KG.attack(state, a.pi, a.uid, a.ref, chooser);
      case 'move': return KG.move(state, a.pi, a.uid, a.to, chooser, a.slot == null ? null : a.slot);
      case 'reposition': return KG.reposition(state, a.pi, a.uid, a.slot == null ? null : a.slot);
      case 'unsuspend': return KG.unsuspendCounter(state, a.pi, a.cardId);
      case 'endTurn': return KG.endTurn(state, chooser);
      default: throw new Error('未知动作包类型：' + (pk && pk.kind));
    }
  };

  /* 动作包的中文描述（给"对手出牌了"这类提示用） */
  NS.describePacket = function (pk, state, KG) {
    const a = (pk && pk.args) || {};
    const cn = { play: '出牌', attack: '攻击', move: '移动', reposition: '调整位置',
      endTurn: '结束回合', mulliganReplace: '换牌', mulliganDone: '确认换牌',
      unsuspend: '取消挂起' }[pk && pk.kind] || (pk && pk.kind);
    try {
      if (pk.kind === 'play') {
        const inst = state.players[a.pi] && state.players[a.pi].hand[a.handIdx];
        const def = inst && KG.cardDef(state, inst.id);
        return cn + (def && def.name ? ('「' + def.name + '」') : '');
      }
      if (pk.kind === 'attack' || pk.kind === 'move' || pk.kind === 'reposition') {
        const u = KG.unitByUid(state, a.uid);
        return cn + (u ? ('（' + u.name + '）') : '');
      }
    } catch (e) { /* 描述失败不影响对局 */ }
    return cn;
  };

  /* 状态指纹：用于每一步之后比对两边是否还在一起。
   * 只取"公开且参与判定"的部分，避免把各自的本地噪音算进去。 */
  function stateDigest(state, KG) {
    if (!state) return 'none';
    const unitSig = function (u) {
      return [
        u.uid, u.id, u.owner, u.zone, u.slot,
        u.attack, u.defense, u.damage || 0, u.actionsLeft, u.canAct ? 1 : 0,
        u.summonedTurn, u.movedThisTurn ? 1 : 0, u.attackedThisTurn ? 1 : 0,
        u.kws ? Object.keys(u.kws).sort().join('|') : '',
        u.mods ? stableStringify(u.mods) : '',
        u.dynMods ? stableStringify(u.dynMods) : '',
      ].join(',');
    };
    // 手牌实例也带上：费用修正会存在实例上，只看 id 抓不到"减费了没有"
    const handSig = function (h) {
      return h.id + (h.costMod ? ('m' + h.costMod) : '') + (h.costSet != null ? ('s' + h.costSet) : '') +
        (h.revealed ? 'r' : '') + (h.suspendedTurn != null ? 'u' : '') +
        stableStringify({opCostMod:h.opCostMod||0,mods:h.mods||{},playEffects:h.playEffects||[]});
    };
    const playerSig = function (p) {
      return [
        p.kredits, p.maxKredits, p.deck.length, p.hand.length, p.discard.length,
        p.fatigue || 0, p.hq,                       // p.hq 就是总部血量（数字）
        // ★ 牌库/手牌/弃牌的**内容与顺序**必须进指纹：
        //   只比长度的话，"换了张牌"这种分叉会被漏掉（实测过：不同种子能算出同一个指纹）。
        hash32(p.deck.map(x=>typeof x==='string'?x:handSig(x)).join(',')), hash32(p.hand.map(handSig).join(',')), hash32(p.discard.map(x=>typeof x==='string'?x:handSig(x)).join(',')),
        p.support.map(unitSig).join(';'),
        p.counters ? p.counters.length : 0,
      ].join('|');
    };
    const parts = [
      't' + state.turn, 'a' + state.active, 'ph' + state.phase,
      state.over ? ('over' + (state.winner == null ? '' : state.winner)) : 'live',
      state.players.map(playerSig).join('||'),
      state.frontline.map(unitSig).join(';'),
    ];
    return hash32(parts.join(' # '));
  }
  NS.stateDigest = stateDigest;

  /* 完整状态指纹（含手牌/牌库的牌序）——调试用，比 stateDigest 更敏感 */
  function fullDigest(state) {
    if (!state) return 'none';
    const p = state.players.map(function (pl) {
      return [pl.name, pl.kredits, pl.maxKredits, stableStringify(pl.deck), stableStringify(pl.hand),
        pl.discard.join(','), pl.fatigue, pl.flags ? stableStringify(pl.flags) : ''].join('/');
    });
    return hash32([state.turn, state.active, state.phase, p.join('||'),
      state.frontline.map(u => u.uid + ':' + u.defense).join(';')].join(' # '));
  }
  NS.fullDigest = fullDigest;

  /* 状态差异定位：不同步时给出"第一处不一样在哪"，而不是只丢一个哈希。
   * 联机出问题时这决定了能不能当场自救（看清是手牌、牌库、还是场上单位跑偏）。 */
  function describeDiff(a, b, limit) {
    limit = limit || 6;
    const out = [];
    const push = function (path, va, vb) {
      if (out.length >= limit) return;
      out.push(path + ': ' + JSON.stringify(va) + ' ≠ ' + JSON.stringify(vb));
    };
    if (!a || !b) { push('state', !!a, !!b); return out; }
    ['turn', 'active', 'phase', 'over', 'winner'].forEach(function (k) { if (a[k] !== b[k]) push(k, a[k], b[k]); });
    const unitSig = function (u) {
      return [u.uid, u.id, u.owner, u.zone, u.slot, u.attack, u.defense, u.damage || 0,
        u.actionsLeft, !!u.canAct, u.summonedTurn, u.kws ? Object.keys(u.kws).sort().join('+') : '',
        u.mods ? stableStringify(u.mods) : ''].join('/');
    };
    for (let i = 0; i < 2; i++) {
      const pa = a.players[i], pb = b.players[i];
      if (!pa || !pb) { push('players[' + i + ']', !!pa, !!pb); continue; }
      ['kredits', 'maxKredits', 'fatigue'].forEach(function (k) { if (pa[k] !== pb[k]) push('p' + i + '.' + k, pa[k], pb[k]); });
      ['hq', 'hqMax', 'hqArmor'].forEach(function (k) { if (pa[k] !== pb[k]) push('p' + i + '.' + k, pa[k], pb[k]); });
      if (pa.hqSlot !== pb.hqSlot) push('p' + i + '.hqSlot', pa.hqSlot, pb.hqSlot);
      if ((pa.deck || []).join(',') !== (pb.deck || []).join(',')) {
        push('p' + i + '.deck 前 8 张', (pa.deck || []).slice(0, 8), (pb.deck || []).slice(0, 8));
      }
      const ha = (pa.hand || []).map(h => h.id + (h.costMod ? '(' + h.costMod + ')' : ''));
      const hb = (pb.hand || []).map(h => h.id + (h.costMod ? '(' + h.costMod + ')' : ''));
      if (ha.join(',') !== hb.join(',')) push('p' + i + '.hand', ha, hb);
      const sa = (pa.support || []).map(unitSig), sb = (pb.support || []).map(unitSig);
      if (sa.join(';') !== sb.join(';')) push('p' + i + '.support', sa, sb);
      const ca = (pa.counters || []).length, cb = (pb.counters || []).length;
      if (ca !== cb) push('p' + i + '.counters', ca, cb);
    }
    const fa = (a.frontline || []).map(unitSig), fb = (b.frontline || []).map(unitSig);
    if (fa.join(';') !== fb.join(';')) push('frontline', fa, fb);
    if (a.log && b.log && a.log.length !== b.log.length) push('log 条数', a.log.length, b.log.length);
    if (!out.length) out.push('（公开状态没发现差异 —— 可能是 rng 消耗不同步导致后续会分叉）');
    return out;
  }
  NS.describeDiff = describeDiff;

  /* 状态画像：把 stateDigest 用到的字段摊成"字段名 → 值"。
   * 用途：真的不同步时，两边交换画像就能指出**第一处**不一样的字段，
   *       而不是只丢两个看不懂的哈希（旧代码 describeDiff(state, state) 永远说"没发现差异"）。 */
  NS.stateProfile = function (state) {
    if (!state) return {};
    const handSig = function (h) {
      return h.id + (h.costMod ? ('m' + h.costMod) : '') + (h.costSet != null ? ('s' + h.costSet) : '') +
        (h.revealed ? 'r' : '');
    };
    const unitSig = function (u) {
      return [u.uid, u.cardId, u.owner, u.zone, u.slot, u.attack, u.defense, u.damage || 0,
        u.actionsLeft, u.canAct ? 1 : 0, u.summonedTurn,
        u.kws ? Object.keys(u.kws).sort().join('+') : '',
        u.mods ? stableStringify(u.mods) : ''].join('/');
    };
    const out = {};
    ['turn', 'active', 'phase', 'over', 'winner'].forEach(function (k) { out[k] = state[k]; });
    for (let i = 0; i < 2; i++) {
      const p = state.players[i];
      if (!p) continue;
      out['p' + i + '.kredits'] = p.kredits;
      out['p' + i + '.maxKredits'] = p.maxKredits;
      out['p' + i + '.hq'] = p.hq;
      // ⚠ **不采 hqSlot**：它是**UI 层**字段（ui.js 渲染时按需给 p.hqSlot 赋 defaultHqSlot），
      //   不是引擎逻辑状态。两端渲染时机不同 → 赋值时机不同 → 收进画像必然**假报不同步**
      //   （实测出现过 p0.hqSlot 我方=2 对方=0、p1.hqSlot 我方=0 对方=4 这种"布局差异"）。
      //   同类的纯视图字段都不要放进这里，画像只放**逻辑上必须一致**的东西。
      out['p' + i + '.fatigue'] = p.fatigue;
      out['p' + i + '.deckLen'] = (p.deck || []).length;
      out['p' + i + '.deck'] = (p.deck || []).join(',');
      out['p' + i + '.hand'] = (p.hand || []).map(handSig).join(',');
      out['p' + i + '.discard'] = (p.discard || []).join(',');
      out['p' + i + '.support'] = (p.support || []).map(unitSig).join(';');
      out['p' + i + '.counters'] = (p.counters || []).length;
      out['p' + i + '.flags'] = p.flags ? stableStringify(p.flags) : '';
    }
    out.frontline = (state.frontline || []).map(unitSig).join(';');
    return out;
  };

  NS.profileDiff = function (mine, theirs, limit) {
    limit = limit || 6;
    const keys = {};
    Object.keys(mine || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(theirs || {}).forEach(function (k) { keys[k] = 1; });
    const out = [];
    Object.keys(keys).sort().forEach(function (k) {
      if (out.length >= limit) return;
      const a = mine ? mine[k] : undefined, b = theirs ? theirs[k] : undefined;
      if (String(a) !== String(b)) out.push(k + '：我方=' + a + ' ｜ 对方=' + b);
    });
    return out;
  };

  /* 对局开始参数：两边必须完全一致（种子/卡组/先手） */
  function matchKey(cfg) {
    return hash32(stableStringify({
      seed: cfg.seed, decks: cfg.decks, names: cfg.names,
      pool: cfg.poolDigest, rules: cfg.rulesVersion || '',
    }));
  }
  NS.matchKey = matchKey;

  if (typeof module !== 'undefined' && module.exports) module.exports = NS;
})(typeof window !== 'undefined' ? window : globalThis);
