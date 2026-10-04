/* ==========================================================================
 * KG AI —— 启发式电脑对手
 * 与人类共用同一套引擎 API：所有选择都通过 chooser 回调同步给出
 * ========================================================================== */
(function (global) {
  'use strict';
  const KG = global.KG = global.KG || {};
  const AI = KG.ai = KG.ai || {};

  function def(state, id) { return KG.cardDef(state, id); }

  /* ------------------------------------------------------------ 威胁度评分 */
  function threat(u) {
    if (!u) return 0;
    let s = u.attack * 2 + u.defense;
    if (KG.hasKw(u, 'guard')) s += 2;
    if (KG.hasKw(u, 'fury') || KG.hasKw(u, 'valor')) s += 2;  // 狂怒 / 奋战：同一个词条
    if (KG.hasKw(u, 'impact')) s += 3;
    if (u.zone === 'frontline') s += 1;
    return s;
  }

  function canKill(a, t) {
    const dmg = KG.attackPowerAgainst ? KG.attackPowerAgainst(null, a, t) : a.attack;
    const eff = Math.max(0, dmg - KG.armorOf(t));
    return eff >= t.defense;
  }

  /* --------------------------------------------------------------- 选择器 */
  AI.chooser = function (state, pi, rng) {
    rng = rng || state.rng;
    return function (req) {
      const opts = req.options || [];
      if (!opts.length) return null;
      switch (req.kind) {
        case 'target': {
          const spec = req.spec || {};
          const side = spec.side || 'any';
          // 敌方目标：优先能打死的、威胁最大的
          const enemyOpts = opts.filter(o => o.kind === 'hq' ? false : o.unit && o.unit.owner !== pi);
          const ownOpts = opts.filter(o => o.unit && o.unit.owner === pi);
          if (spec.side === 'friendly' && ownOpts.length) {
            const buffish = spec.prompt && /获得|增益|\+/.test(spec.prompt);
            ownOpts.sort((a, b) => (b.unit.attack + b.unit.defense) - (a.unit.attack + a.unit.defense));
            return ownOpts[0].value;
          }
          if (enemyOpts.length) {
            enemyOpts.sort((a, b) => {
              const ka = a.unit.attack <= 0 ? 1 : 0, kb = b.unit.attack <= 0 ? 1 : 0;
              if (ka !== kb) return ka - kb;
              return threat(b.unit) - threat(a.unit);
            });
            return enemyOpts[0].value;
          }
          if (spec.kind === 'hq' || spec.allowHQ) {
            const hq = opts.find(o => o.kind === 'hq' && o.player !== pi);
            if (hq) return hq.value;
          }
          return opts[0].value;
        }
        case 'chooseOne':
        case 'discover': {
          // 简单启发：取数值/费用最高的一项
          const scored = opts.map(o => {
            let s = 0;
            const label = String(o.label || '');
            s += (label.match(/(\d+)/) ? parseInt(RegExp.$1, 10) : 0);
            if (/消灭|造成|伤害/.test(label)) s += 6;
            if (/抽|加入手牌|获得/.test(label)) s += 3;
            return { o, s };
          });
          scored.sort((a, b) => b.s - a.s);
          return scored[0].o.value;
        }
        case 'mulligan':
          return [];
        default:
          return opts[0].value;
      }
    };
  };

  /* ------------------------------------------------------------ 单回合决策 */
  AI.takeTurn = async function (state, pi, hooks) {
    const chooser = AI.chooser(state, pi);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // ★ 准备阶段守卫：AI 在 mulligan 阶段不行动。先完成 AI 自己的换牌（不换），
    //   若人类也已完成则正式开局；否则直接返回，等人类确认。
    if (state.phase === 'mulligan') {
      if (!state.mulligan.done[pi]) {
        const n = KG.mulliganReplace(state, pi, []);   // AI 默认不换（返回 0）
        KG.mulliganDone(state, pi);
      }
      return;
    }
    // 动作后的 UI 钩子：让玩家看见 AI 每一步在做什么。
    // info 带上"这一步是什么动作、作用于谁"，UI 才能演出对应的动画。
    const afterStep = async (info) => {
      if (hooks && hooks.afterStep) { try { await hooks.afterStep(state, pi, info); } catch (e) { console.error('afterStep', e); } }
      else if (hooks && hooks.delay) await sleep(hooks.delay);
    };
    let guard = 0;
    while (!state.over && state.active === pi && guard++ < 60) {
      if (hooks && hooks.delay && !hooks.afterStep) await sleep(hooks.delay);
      const played = await playBestCard(state, pi, chooser, hooks);
      if (played) { await afterStep(played); continue; }
      const attacked = await doAttack(state, pi, chooser);
      if (attacked) { await afterStep(attacked); continue; }
      const moved = await doMove(state, pi, hooks);
      if (moved) { await afterStep(moved); continue; }
      break;
    }
    // 僵局保护：实在没别的可做时，强行打一次（哪怕亏），避免双方互相过牌到天荒地老
    if (!state.over && state.active === pi) {
      const forced = await doAttack(state, pi, chooser, true);
      if (forced) await afterStep(forced);
    }
    if (!state.over && state.active === pi) await KG.endTurn(state, chooser);
  };

  /* -------------------------------------------------------------- 出牌决策 */
  async function playBestCard(state, pi, chooser, hooks) {
    const p = state.players[pi];
    const foe = state.players[1 - pi];
    let best = null;
    for (let i = 0; i < p.hand.length; i++) {
      const chk = KG.canPlayCard(state, pi, i);
      if (!chk.ok) continue;
      const inst = p.hand[i];
      const d = def(state, inst.id);
      const isOrder = d.cardType === 'order' || d.cardType === 'counter';    // 反制也是"非单位牌"，按指令的方式评估
      let score = 10 + (d.cost || 0);
      if (isOrder) {
        // 指令评分：基于文本关键词估计价值
        const text = (d.text || '');
        if (/伤害|消灭/.test(text)) score += 8;
        if (/抽/.test(text)) score += 5;
        if (/获得|增益|\+/.test(text)) score += 4;
        if (/压制|钉住/.test(text)) score += 3;
        if (/治疗|恢复/.test(text)) score += 3;
        if (/所有|全体/.test(text)) score += 2;
        // 斩杀时优先出指令
        if (foe.hq <= 8 && /伤害|消灭/.test(text)) score += 10;
        score += 1; // 指令的基础价值（不占场面位）
      } else {
        score += ((d.attack || 0) + (d.defense || 0)) * 0.8;
        // 场面已满时降低单位优先级
        if (p.support.length >= KG.RULES.supportMax - 1) score -= 4;
      }
      if (d.kwMap && d.kwMap.blitz) score += 1.5;
      if (!best || score > best.score) best = { i, score, cost: chk.cost };
    }
    if (!best) return false;
    if (hooks && hooks.beforePlay) hooks.beforePlay(state, pi, best.i);
    const handIdx = best.i;
    const inst = p.hand[handIdx];
    const playDef = inst ? def(state, inst.id) : null;
    const ok = await KG.playCard(state, pi, handIdx, chooser);
    if (!ok) return false;
    return {
      kind: 'play',
      cardName: playDef ? playDef.name : '',
      cardType: playDef ? playDef.cardType : 'unit',
      handIndex: handIdx,
    };
  }

  /* -------------------------------------------------------------- 攻击决策 */
  async function doAttack(state, pi, chooser, force) {
    const p = state.players[pi];
    const foe = state.players[1 - pi];
    const myUnits = KG.allUnitsOf(state, pi).filter(u => u.canAct && u.actionsLeft > 0 && u.attack > 0);
    if (!myUnits.length) return false;

    // 1) 能直接斩杀总部
    for (const u of myUnits) {
      const chk = KG.canAttack(state, pi, u.uid, { kind: 'hq', player: 1 - pi });
      if (chk.ok && u.attack >= foe.hq) {
        await KG.attack(state, pi, u.uid, { kind: 'hq', player: 1 - pi }, chooser);
        return { kind: 'attack', attackerUid: u.uid, target: { kind: 'hq' }, lethal: true };
      }
    }

    // 2) 评估所有交换
    let bestTrade = null, bestHq = null;
    for (const u of myUnits) {
      const hqChk = KG.canAttack(state, pi, u.uid, { kind: 'hq', player: 1 - pi });
      if (hqChk.ok && !bestHq) bestHq = u;
      for (const t of KG.allUnitsOf(state, 1 - pi)) {
        if (t.dead) continue;
        const chk = KG.canAttack(state, pi, u.uid, { kind: 'unit', uid: t.uid });
        if (!chk.ok) continue;
        const kills = canKill(u, t);
        const noRetal = KG.RULES.noRetaliationTypes.indexOf(u.unitType) >= 0 || (u.mods && u.mods.noRetal);
        const back = noRetal ? 0 : t.attack;
        const dies = back >= u.defense;
        let score = 0;
        if (kills) score += threat(t) + 5;
        if (dies) score -= threat(u) * 0.9;
        if (!kills) score -= 1.5;
        if (KG.hasKw(t, 'guard')) score += 1.5;          // 打通前线
        if (t.defense <= u.attack - KG.armorOf(t)) score += 1;
        if (t.attack >= u.defense) score -= 1;            // 会被反杀
        if (!bestTrade || score > bestTrade.score) bestTrade = { u, t, score };
      }
    }
    // 3) 有前线单位就打总部（除非有更划算的交换）
    if (bestHq && (force || !bestTrade || bestTrade.score < 2.5)) {
      await KG.attack(state, pi, bestHq.uid, { kind: 'hq', player: 1 - pi }, chooser);
      return { kind: 'attack', attackerUid: bestHq.uid, target: { kind: 'hq' } };
    }
    // 强制模式：挑分数最高的一次攻击（哪怕亏），打破僵局
    if (bestTrade && (force || bestTrade.score > -0.5)) {
      await KG.attack(state, pi, bestTrade.u.uid, { kind: 'unit', uid: bestTrade.t.uid }, chooser);
      return { kind: 'attack', attackerUid: bestTrade.u.uid, target: { kind: 'unit', uid: bestTrade.t.uid } };
    }
    if (force) {
      // 连交换都算不出来（例如只能打固守以外的东西）：随便挑一个合法攻击
      for (const u of myUnits) {
        for (const t of KG.allUnitsOf(state, 1 - pi)) {
          if (t.dead) continue;
          if (KG.canAttack(state, pi, u.uid, { kind: 'unit', uid: t.uid }).ok) {
            await KG.attack(state, pi, u.uid, { kind: 'unit', uid: t.uid }, chooser);
            return { kind: 'attack', attackerUid: u.uid, target: { kind: 'unit', uid: t.uid } };
          }
        }
      }
    }
    return false;
  }

  /* -------------------------------------------------------------- 移动决策 */
  async function doMove(state, pi, hooks) {
    const p = state.players[pi];
    // 前线是双方共抢的一条线（总格数有限）
    if (KG.frontlineOf(state, pi).length >= KG.RULES.frontlineMax) return false;
    const mineOnFront = KG.frontlineOf(state, pi).length;
    if (mineOnFront >= 3) return false;          // 别把家底全压上去
    const cands = p.support.filter(u => u.canAct && u.actionsLeft > 0)
      .sort((a, b) => (b.defense + b.attack) - (a.defense + a.attack));
    for (const u of cands) {
      const chk = KG.canMove(state, pi, u.uid, 'frontline');
      if (chk.ok) {
        await KG.move(state, pi, u.uid, 'frontline');
        return { kind: 'move', unitUid: u.uid, unitName: u.name, to: 'frontline' };
      }
    }
    return false;
  }

  /* ---------------------------------------------------------- 自动构筑卡组 */
  KG.autoDeck = function (pool, opts) {
    opts = opts || {};
    /* ★ 可注入的随机源（2026-10-01，为原生移植的可复现对拍而加）。
     *   评分里那一句 `Math.random() * 0.35` 是**全项目唯一没有种子来源的随机**——
     *   它让 autoDeck / sim 的结果无法复现（同一个 seed 也救不了，因为
     *   createGame 的 seed 传给的是 state.rng，管不到这里）。
     *   原生端要跟这套逻辑逐字段对拍，就必须让这个随机可注入。
     *
     *   ⚠ 默认行为**完全不变**：不传 opts.rng 时仍然用 Math.random，
     *     所以调用方（ui.js / engine-rpc.js）不需要任何改动。
     *   传 opts.rng 时，调用方提供一个「与 mulberry32 同流」的函数即可
     *     （Kotlin 侧用 state.rng，JS 侧用 KG.mulberry32(seed)）。 */
    const rng = (typeof opts.rng === 'function') ? opts.rng : Math.random;
    const sets = opts.sets || null;
    const useOrders = opts.useOrders !== false;
    let list = (pool || []).filter(c => !c.referenceCard && c.cardType && (c.cost != null || c.attack != null || c.cardType !== 'unit'));
    if (sets) list = list.filter(c => sets.indexOf(c.set) >= 0);
    if (opts.maxCost) list = list.filter(c => (c.cost || 0) <= opts.maxCost);
    if (!useOrders) list = list.filter(c => c.cardType === 'unit');
    // 数值评分：费用效率 + 词条加成
    const scored = list.map(c => {
      const stats = (c.attack || 0) + (c.defense || 0);
      const cost = Math.max(1, c.cost || 1);
      let s = stats / cost;
      if (c.kwMap && c.kwMap.blitz) s += 0.3;
      if (c.kwMap && c.kwMap.guard) s += 0.2;
      if (c.kwMap && c.kwMap.deathrattle) s += 0.2;
      if (c.cardType !== 'unit') s += 0.5 + (c.text ? c.text.length * 0.05 : 0);
      if ((c.cost || 0) > 10) s -= 0.5;
      return { c, s: s + rng() * 0.35 };
    });
    scored.sort((a, b) => b.s - a.s);
    const deck = [];
    const counts = {};
    const target = KG.RULES.deckSize;
    const limitOf = c => (KG.copyLimit ? KG.copyLimit(c) : KG.RULES.maxCopies);
    // 低费曲线保底
    const cheap = scored.filter(x => (x.c.cost || 0) <= 3 && limitOf(x.c) > 0);
    cheap.slice(0, 10).forEach(x => { addCard(deck, counts, x.c.id, limitOf(x.c)); });
    for (const x of scored) {
      if (deck.length >= target) break;
      const lim = limitOf(x.c);
      if (lim <= 0) continue;
      addCard(deck, counts, x.c.id, lim);
    }
    let i = 0;
    const usable = scored.filter(x => limitOf(x.c) > 0);
    while (deck.length < target && usable.length) { deck.push(usable[i % usable.length].c.id); i++; }
    // ★ 反制保底：反制是**独立卡牌种类**，但没有身材 → 评分公式里它天然排在后面，
    //   40 张的贪心构筑永远轮不到它 ⇒ "自动构筑/AI 卡组里一张反制都没有"，
    //   玩家在实战里根本见不到反制（bug6："反制全部不能用"的真正可复现来源）。
    //   这里从尾部（评分最低的牌）换出最多 3 张，各塞 1 张不同的反制。
    if (useOrders) {
      const cs = scored.filter(x => x.c.cardType === 'counter' && limitOf(x.c) > 0);
      let have = deck.filter(id => cs.some(x => x.c.id === id)).length;
      let tail = deck.length - 1;
      for (const x of cs) {
        if (have >= 3 || deck.indexOf(x.c.id) >= 0) continue;
        while (tail >= 0 && cs.some(y => y.c.id === deck[tail])) tail--;   // 别把已放进的反制又换掉
        if (tail < 0) break;
        deck[tail] = x.c.id; tail--; have++;
      }
    }
    return deck.slice(0, target);
  };

  function addCard(deck, counts, id, max) {
    if (max <= 0) return;
    while ((counts[id] || 0) < max && deck.length < KG.RULES.deckSize) {
      deck.push(id);
      counts[id] = (counts[id] || 0) + 1;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
})(typeof window !== 'undefined' ? window : globalThis);
