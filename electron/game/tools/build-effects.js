/* 把 game/data/nations/*.json 的效果层字段重建为 game/js/effects-data.js（KG_EFFECT_OVERLAY + KG_ALIASES）
 * 同时生成覆盖率报告 game/data/_effects_report.md
 * 用法: node game/tools/build-effects.js
 *
 * ★ 2026-09-27 存储改制：效果真源已并入 nations/<国家>.json 的卡定义
 *   （卡上 overlayFields 名单列出的字段 = 效果覆盖层内容，效果编码无论来自编译器自动解析
 *   还是人工手写，全部固化在 nations 卡上，且已招安 —— 本工具只读不写）。
 *   本工具职责：从合成态剥离出 overlay（与旧版 effects/*.json 合并产物等价）+ 重建别名表。
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.KG_DATA_ROOT || path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'game', 'data');
const NATIONS = path.join(DATA, 'nations');
const OUT_JS = path.join(ROOT, 'game', 'js', 'effects-data.js');
const OUT_RPT = path.join(DATA, '_effects_report.md');

if (!fs.existsSync(NATIONS)) {
  console.error('✗ 找不到 ' + NATIONS + ' —— 卡牌数据唯一存储 = nations/<国家>.json');
  process.exit(1);
}

// ★ 2026-09-27 存储唯一化：不再读 cards.json（已归档）。卡池名单直接从产物 js/cards.js 取
//   （KG_CARDS 与 nations 完全同源，由 merge.js 一键重建）。
global.window = global.window || global;
require(path.join(ROOT, 'game', 'js', 'cards.js'));
const cards = global.KG_CARDS || [];
const byId = {};
cards.forEach(c => { byId[c.id] = c; });

/* ------------------------------------------------- 从 nations 重建 overlay */
const overlay = {};
const nationsFiles = fs.readdirSync(NATIONS).filter(f => f.endsWith('.json') && f !== '_meta.json').sort();
const problems = [];

for (const f of nationsFiles) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(NATIONS, f), 'utf8')); }
  catch (e) { problems.push(`❌ ${f} JSON 解析失败：${e.message}`); continue; }
  for (const card of Object.values(doc.cards || {})) {
    if (!byId[card.id]) { problems.push(`⚠️ ${f}: 卡 ${card.id} 不在卡池（先跑 merge.js 重建产物）`); continue; }
    const ovFields = Array.isArray(card.overlayFields) ? card.overlayFields : [];
    if (!ovFields.length) continue;
    // 深拷贝：后续补丁逻辑（老兵形态）会改 overlay 对象，不能牵连 nations 数据
    const patch = JSON.parse(JSON.stringify(
      Object.fromEntries(ovFields.map(k => [k, card[k]]).filter(([, v]) => v !== undefined))));
    // 自动推导 targetsNeeded（打出手牌前就要选目标的卡）—— nations 里已固化的跳过
    if (!patch.targetsNeeded && Array.isArray(patch.effects)) {
      const tn = [];
      patch.effects.forEach(ef => {
        if (['order', 'deploy', 'counter'].includes(ef.trigger) || !ef.trigger) {
          (ef.targets || []).forEach(t => tn.push(t));
        }
      });
      if (tn.length) patch.targetsNeeded = tn;
    }
    overlay[card.id] = Object.assign({}, overlay[card.id] || {}, patch);
  }
}

/* ----------------------------------------------------------------- 别名表 */
// 真源 = nations 卡上的 aliases 数组；_meta.json 的 orphanAliases 是指向池外 id 的兜底
const aliases = {};
const meta = JSON.parse(fs.readFileSync(path.join(NATIONS, '_meta.json'), 'utf8'));
for (const f of nationsFiles) {
  const doc = JSON.parse(fs.readFileSync(path.join(NATIONS, f), 'utf8'));
  for (const card of Object.values(doc.cards || {})) {
    (card.aliases || []).forEach(a => { aliases[a] = card.id; });
  }
}
Object.assign(aliases, meta.orphanAliases || {});

/* ----------------------------------------------------------------- 覆盖率统计 */
let withFx = 0, textButNoFx = [], unimplemented = [], refCards = [], upgrades = [];
const KW_ONLY = /^((闪击|固守|守护|烟幕|隐蔽|伏击|动员|压制|抑制|老兵|流亡|奋战|冲击|游击|重甲\d*|轻甲\d*|亡计|强磁护盾|硬铝弹|空投|磁反应装甲\d*|收缴|免疫|情报|维修|打捞|抉择)(\s|　|,|，)*)+$/;
cards.forEach(c => {
  const o = overlay[c.id];
  const has = o && Array.isArray(o.effects) && o.effects.length > 0;
  if (has) withFx++;
  const text = (c.text || '').trim();
  const isEmptyish = !text || /^\(无\)$/.test(text);
  const pureKw = text && text.split(/\n/).every(line => KW_ONLY.test(line.trim()));
  const fieldOnly = o && (o.upgradeTo || o.upgradeOn || o.costModPerOrder || o.selfCostMod);
  if (!has && !isEmptyish && !pureKw && !fieldOnly) textButNoFx.push(c.id + '  «' + text.replace(/\n/g, ' ') + '»');
  if (o && o.unimplemented) unimplemented.push(c.id);
  if (o && o.referenceCard) refCards.push(c.id);
  if (o && o.upgradeTo) upgrades.push(c.id + ' → ' + o.upgradeTo + '（' + (o.upgradeKills || (o.upgradeOn ? '事件' : '?')) + '）');
});

/* ------------------------------------------------------------- 老兵形态补丁 */
// 老兵形态：只能由普通形态升级得到，不能单独放进卡组。
// ⚠ nations 里补丁已固化的卡（notes 已带说明）不重复拼接 —— 本工具只读 nations，补丁只进产物。
const upgradeTargets = {};
Object.entries(overlay).forEach(([id, o]) => { if (o && o.upgradeTo) upgradeTargets[o.upgradeTo] = id; });
Object.entries(upgradeTargets).forEach(([id, from]) => {
  if (!byId[id]) return;
  const o = overlay[id] = overlay[id] || {};
  o.token = true;
  o.rarity = 'token';
  if (!String(o.notes || '').includes('老兵形态：')) {
    o.notes = ((o.notes ? o.notes + ' ' : '') +
      '老兵形态：不能单独放入卡组，只能由「' + (byId[from] ? byId[from].name : from) + '」升级得到。');
  }
});

/* ------------------------------------------------------------- 引用卡名扫描 */
const nameRefs = {};
function collectNames(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(collectNames); return; }
  if (typeof node.name === 'string' && (node.op === 'summon' || node.op === 'addCardToHand' || node.op === 'shuffleIn' || node.op === 'shuffleInUntil' || node.op === 'deckToField')) {
    nameRefs[node.name] = (nameRefs[node.name] || 0) + 1;
  }
  Object.keys(node).forEach(k => collectNames(node[k]));
}
Object.values(overlay).forEach(o => collectNames(o.effects));
const names = cards.map(c => String(c.name || '').replace(/[“”"「」]/g, ''));
const missing = Object.keys(nameRefs).filter(n => {
  const clean = n.replace(/[“”"「」]/g, '');
  if (aliases[clean] && byId[aliases[clean]]) return false;
  return !names.some(x => x === clean || x.indexOf(clean) >= 0 || clean.indexOf(x) >= 0) &&
    !Object.keys(aliases).some(k => clean.indexOf(k) >= 0 || k.indexOf(clean) >= 0);
});
if (missing.length) {
  const lines = ['# 卡面引用了、但卡池里没有的卡', '',
    '这些卡在效果里被引用（`summon` / `addCardToHand` / `shuffleIn`），但没有对应卡图。',
    '对局中会打出明确的日志警告，或按别名映射到相近的卡。',
    '想让它们真正生效：在 nations 对应国家文件里补卡定义，或改写引用它的效果编码。', ''];
  missing.forEach(n => lines.push('- 「' + n + '」被引用 ' + nameRefs[n] + ' 次'));
  fs.writeFileSync(path.join(DATA, '_missing_cards.md'), lines.join('\n'), 'utf8');
} else {
  fs.writeFileSync(path.join(DATA, '_missing_cards.md'),
    '# 卡面引用了、但卡池里没有的卡\n\n（无）所有被引用的卡名都能在卡池或 nations 别名表里解析。\n', 'utf8');
}

/* --------------------------------------------------------------------- 输出 */
const body = '/* 自动生成，勿手改：node game/tools/build-effects.js（真源：data/nations/*.json） */\n' +
  '(function (g) {\n' +
  'g.KG_EFFECT_OVERLAY = ' + JSON.stringify(overlay) + ';\n' +
  'g.KG_ALIASES = ' + JSON.stringify(aliases) + ';\n' +
  'if (g.KG) { g.KG.aliases = g.KG_ALIASES; g.KG.setPool(g.KG_CARDS ? g.KG_CARDS.map(function (c) { var o = g.KG_EFFECT_OVERLAY[c.id]; return o ? Object.assign({}, c, o) : Object.assign({}, c); }) : []); }\n' +
  '})(typeof window !== "undefined" ? window : globalThis);\n';
fs.writeFileSync(OUT_JS, body, 'utf8');

const rpt = [];
rpt.push('# 效果编码报告');
rpt.push('');
rpt.push('- 卡池总数：**' + cards.length + '**');
rpt.push('- 已写效果的卡：**' + withFx + '**（效果真源：nations 卡定义，overlayFields 重建）');
rpt.push('- 覆盖层条目：' + Object.keys(overlay).length + ' · 别名：' + Object.keys(aliases).length);
rpt.push('- 参考卡：' + refCards.length + '（' + refCards.join(', ') + '）');
rpt.push('');
rpt.push('## 有文本但效果为空（需要补编码）');
textButNoFx.forEach(x => rpt.push('- ' + x));
rpt.push('');
rpt.push('## 标记为 unimplemented（用了近似实现）');
unimplemented.forEach(x => rpt.push('- ' + x));
rpt.push('');
rpt.push('## 老兵升级链');
upgrades.forEach(x => rpt.push('- ' + x));
rpt.push('');
rpt.push('## 编码器报告的问题');
problems.forEach(x => rpt.push('- ' + x));
fs.writeFileSync(OUT_RPT, rpt.join('\n'), 'utf8');

console.log('覆盖层条目:', Object.keys(overlay).length, '/', cards.length, ' 别名:', Object.keys(aliases).length);
console.log('有文本但无效果:', textButNoFx.length);
console.log('unimplemented:', unimplemented.length, ' 问题:', problems.length);
console.log('输出:', OUT_JS);
console.log('报告:', OUT_RPT);
