/* ==========================================================================
 * 回归：抑制 / 移除 / 洗切 三条新机制（2026-10-02 Alan 定义）
 * --------------------------------------------------------------------------
 * ① 抑制（silence 升格）：失去所有对战词条/效果/属性增益，光环也算效果（被抑制期间
 *    不接收任何光环），后续可以再次贴膜；mods.noSuppress 免疫。
 * ② 移除（新 op removeUnit）：单位离场不算被消灭（亡计不触发、不进弃牌堆、不计 unitsLost），
 *    卡进 removed 区；派发 unitLeft（撤退回手牌、手牌满转移除也派发）。
 * ③ 洗切（触发词 shuffle）：洗入卡组 / 洗切卡组类动作成功后派发，本身无效果。
 *
 * 用法: node tools/dsl/check-suppress-shuffle-remove.js [--dist]
 *   --dist = 用 dist 那份引擎跑（验证发行版真的带上了修复）
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIST = process.argv.indexOf('--dist') >= 0;
const REPO = DIST ? path.resolve(__dirname,'../../resources/app')
  : (process.env.KG_REPO || path.resolve(__dirname,'../../electron'));
const GAME = path.join(REPO, 'game');
['js/engine.js', 'js/primitives-extra.js', 'js/primitives.js', 'js/effects.js', 'js/effect-primitives.js',
  'js/compiler.js', 'js/ai.js', 'js/cards.js', 'js/effects-data.js']
  .forEach(f => vm.runInThisContext(fs.readFileSync(fs.existsSync(path.join(GAME,f))?path.join(GAME,f):path.resolve(__dirname,'../../resources/app/game',f), 'utf8'), { filename: f }));

const KG = globalThis.KG;
const overlay = globalThis.KG_EFFECT_OVERLAY || {};
const results = [];
const ok = (name, cond, detail) => { results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   → ' + detail : '')); return cond; };

/* 合成卡：body 只用于本测试 */
const EXTRA = [
  { id: '__t_trooper', name: '回归·列兵', cardType: 'unit', unitType: 'infantry', cost: 1, attack: 2, defense: 3, text: '', effects: [] },
  { id: '__t_aura', name: '回归·光环兵', cardType: 'unit', unitType: 'infantry', cost: 2, attack: 1, defense: 1, text: '友方单位具有+1攻击力',
    effects: [{ trigger: 'passive', aura: { target: { sel: 'all', side: 'friendly' }, attack: 1 } }] },
  { id: '__t_deathrattle', name: '回归·亡计兵', cardType: 'unit', unitType: 'infantry', cost: 1, attack: 1, defense: 1, text: '亡计：抽一张牌',
    effects: [{ trigger: 'death', actions: [{ op: 'damageHQ', amount: 1, side: 'enemy' }] }] },
  { id: '__t_leftlisten', name: '回归·离场监听', cardType: 'unit', unitType: 'infantry', cost: 1, attack: 1, defense: 1, text: '单位不因消灭离开战场时，抽一张牌',
    effects: [{ trigger: 'unitLeft', actions: [{ op: 'damageHQ', amount: 1, side: 'enemy' }] }] },
  { id: '__t_shufflelisten', name: '回归·洗切监听', cardType: 'unit', unitType: 'infantry', cost: 1, attack: 1, defense: 1, text: '友方洗切卡组时，抽一张牌',
    effects: [{ trigger: 'shuffle', actions: [{ op: 'damageHQ', amount: 1, side: 'enemy' }] }] },
];

const base = globalThis.KG_CARDS.map(c => (overlay[c.id] ? Object.assign({}, c, overlay[c.id]) : Object.assign({}, c)));
const all = base.concat(EXTRA);
KG.setPool(all);
const filler = base.filter(c => c.cardType === 'unit' && !c.referenceCard).slice(0, 40).map(c => c.id);

function newGame() {
  const st = KG.createGame({ decks: [filler, filler], seed: 7, pool: all });
  st.players[0].kredits = 20; st.players[1].kredits = 20;
  return st;
}
function put(st, pi, cardId) {
  const u = KG.makeUnit(st, cardId, pi);
  u.zone = 'support'; u.summonedTurn = 0; u.canAct = true;
  st.players[pi].support.push(u);
  KG.recomputeAuras(st);
  return u;
}
const ctx0 = st => ({ owner: 0, unit: null, source: null, vars: {}, targets: {}, chooser: null });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main() {
  /* ── ① 抑制 ─────────────────────────────────────────────── */
  {
    const st = newGame();
    const t = put(st, 0, '__t_trooper');
    const ctx = ctx0(st);
    ctx.targets.t = [{ kind: 'unit', value: t.uid, unit: t }];
    ctx.unit = t; ctx.source = t;
    // 贴膜：+2+2 + 词条
    await KG.effects.OPS.buff(st, ctx, { op: 'buff', target: { sel: 'ref', ref: 't' }, attack: 2, defense: 2, keyword: 'guard' });
    ok('前置：贴膜后攻/防 = 4/5，带守护', t.attack === 4 && t.defense === 5 && !!t.kws.guard, t.attack + '/' + t.defense + ' kws=' + Object.keys(t.kws));
    // 抑制
    await KG.effects.OPS.silence(st, ctx, { op: 'silence', target: { sel: 'ref', ref: 't' } });
    ok('抑制：属性增益回滚到基础 2/3（无光环场）', t.attack === 2 && t.defense === 3, t.attack + '/' + t.defense);
    ok('抑制：词条清空、silenced 标记', Object.keys(t.kws).length === 0 && t.silenced === true, 'kws=' + JSON.stringify(t.kws));
    // 再贴膜
    await KG.effects.OPS.buff(st, ctx, { op: 'buff', target: { sel: 'ref', ref: 't' }, attack: 1, defense: 1 });
    ok('抑制：后续可以再次贴膜（3/4）', t.attack === 3 && t.defense === 4, t.attack + '/' + t.defense);
  }
  { /* 免疫：noSuppress */
    const st = newGame();
    const t = put(st, 0, '__t_trooper');
    t.mods.noSuppress = true; t.kws.guard = true;
    const ctx = ctx0(st); ctx.targets.t = [{ kind: 'unit', value: t.uid, unit: t }]; ctx.unit = t; ctx.source = t;
    await KG.effects.OPS.silence(st, ctx, { op: 'silence', target: { sel: 'ref', ref: 't' } });
    ok('抑制：noSuppress 免疫（词条保留、未标记）', !!t.kws.guard && !t.silenced, 'kws=' + Object.keys(t.kws));
  }
  { /* 光环也算效果：抑制那一瞬被清掉；但光环是持续效果，抑制过后重新罩上（= 重新贴膜包括光环）。
       区分信号：buff(+2) 被清**不再回来**，光环(+1) 会回来 → 攻 = 基础2 + 光环1 = 3（而不是 2 或 5） */
    const st = newGame();
    const aura1 = put(st, 0, '__t_aura');
    const t = put(st, 0, '__t_trooper');
    const ctx = ctx0(st); ctx.targets.t = [{ kind: 'unit', value: t.uid, unit: t }]; ctx.unit = t; ctx.source = t;
    await KG.effects.OPS.buff(st, ctx, { op: 'buff', target: { sel: 'ref', ref: 't' }, attack: 2, defense: 2 });
    ok('前置：基础2 + buff2 + 光环1 = 攻 5', t.attack === 5, String(t.attack));
    await KG.effects.OPS.silence(st, ctx, { op: 'silence', target: { sel: 'ref', ref: 't' } });
    ok('抑制：buff 清掉不再回来、光环重新罩上 → 攻 3（不是 2 也不是 5）', t.attack === 3, String(t.attack));
    ok('抑制：词条/silenced 仍是清空状态', Object.keys(t.kws).length === 0 && t.silenced === true);
    put(st, 0, '__t_aura');                 // 又一个光环源登场
    ok('抑制：之后新光环源照常生效 → 攻 4', t.attack === 4, String(t.attack));
    ok('对照：未被抑制的单位照常吃光环', aura1.attack === 1 + 2, String(aura1.attack));
  }

  /* ── ② 移除 ─────────────────────────────────────────────── */
  {
    const st = newGame();
    const victim = put(st, 0, '__t_deathrattle');     // 它有亡计：抽一张牌
    const listener = put(st, 0, '__t_leftlisten');    // 监听 unitLeft
    const lost0 = st.players[0].unitsLostThisGame || 0;
    const foeHq0 = st.players[1].hq;
    const ctx = ctx0(st); ctx.unit = listener; ctx.source = listener;
    await KG.effects.OPS.removeUnit(st, ctx, { op: 'removeUnit', target: { sel: 'all', side: 'friendly', filter: { cardId: '__t_deathrattle' } } });
    await sleep(50);
    ok('移除：单位离场（dead、不在阵线）', victim.dead === true && st.players[0].support.indexOf(victim) < 0);
    ok('移除：卡进 removed 区（不算消灭）', st.players[0].removed.indexOf('__t_deathrattle') >= 0, JSON.stringify(st.players[0].removed));
    ok('移除：亡计**没有**触发、unitLeft 触发（敌 HQ 只 -1 而不是 -2）',
      st.players[1].hq === foeHq0 - 1, 'HQ ' + foeHq0 + ' → ' + st.players[1].hq);
    ok('移除：不计入 unitsLost', (st.players[0].unitsLostThisGame || 0) === lost0);
    ok('移除：不进弃牌堆', st.players[0].discard.indexOf('__t_deathrattle') < 0);
  }
  { /* 撤退回手牌遇手牌满 → 移除；未满 → 正常回手 + unitLeft */
    const st = newGame();
    const t = put(st, 0, '__t_trooper');
    const listen = put(st, 0, '__t_leftlisten');
    while (st.players[0].hand.length < KG.RULES.handMax) st.players[0].hand.push(KG.makeHandInst(filler[0]));
    const handFull = st.players[0].hand.length;
    const ctx = ctx0(st); ctx.unit = listen; ctx.source = listen;
    await KG.effects.OPS.returnToHand(st, ctx, { op: 'retreat', target: { sel: 'all', side: 'friendly', filter: { cardId: '__t_trooper' } } });
    await sleep(50);
    ok('撤退：手牌满 → 改为移除（removed 区、手牌数不变）',
      st.players[0].removed.indexOf('__t_trooper') >= 0 && st.players[0].hand.length === handFull,
      'removed=' + JSON.stringify(st.players[0].removed) + ' hand=' + st.players[0].hand.length);

    const st2 = newGame();
    const t2 = put(st2, 0, '__t_trooper');
    const listen2 = put(st2, 0, '__t_leftlisten');
    const h0 = st2.players[0].hand.length;
    const foe0 = st2.players[1].hq;
    const ctx2 = ctx0(st2); ctx2.unit = listen2; ctx2.source = listen2;
    await KG.effects.OPS.returnToHand(st2, ctx2, { op: 'retreat', target: { sel: 'all', side: 'friendly', filter: { cardId: '__t_trooper' } } });
    await sleep(50);
    ok('撤退：未满 → 正常回手（+1）且派发 unitLeft（监听打 HQ 1 点）',
      st2.players[0].hand.length === h0 + 1 && st2.players[1].hq === foe0 - 1,
      'hand ' + h0 + ' → ' + st2.players[0].hand.length + '  HQ ' + foe0 + ' → ' + st2.players[1].hq);
  }

  /* ── ③ 洗切 ─────────────────────────────────────────────── */
  {
    const st = newGame();
    const listen = put(st, 0, '__t_shufflelisten');
    const foe0 = st.players[1].hq;
    const ctx = ctx0(st); ctx.unit = listen; ctx.source = listen;
    await KG.effects.OPS.shuffleIn(st, ctx, { op: 'shuffleIn', cardId: filler[0], count: 1, side: 'self' });
    await sleep(50);
    ok('洗切：洗入卡组触发 shuffle 监听（HQ -1）', st.players[1].hq === foe0 - 1, 'HQ ' + foe0 + ' → ' + st.players[1].hq);
    await KG.effects.OPS.shuffleHandIntoDeck(st, ctx, { op: 'shuffleHandIntoDeck', side: 'self' });
    await sleep(50);
    ok('洗切：手牌洗入卡组同样触发（HQ 再 -1）', st.players[1].hq === foe0 - 2, 'HQ ' + foe0 + ' → ' + st.players[1].hq);
  }

  results.forEach(r => console.log(r));
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  console.log('\n' + (results.length - fails) + '/' + results.length + (fails ? '  ❌  (' + REPO + ')' : '  ✅  (' + REPO + ')'));
  process.exit(fails ? 1 : 0);
})();
