/* game/data/nations/*.json（唯一存储） -> game/js/cards.js（运行时纯产物）
 * 同时输出报告：未知词条、低置信度、变量卡、行动花费推测
 * 用法: node game/tools/merge.js
 *
 * ★ 2026-09-27 存储唯一化（Alan）：卡牌数据只允许存在于 data/nations/<国家>.json。
 *   - 每张卡在 nations 里是【合成态全字段】（转写数值 + 卡面文本 + 效果编码 + 别名 + 招安标记）。
 *   - 本工具【只读 nations】，产物 js/cards.js 只是浏览器加载用的重建视图，随时可由 nations 一键重建。
 *   - 旧的多源存储（raw/batch_*.json、extra-cards.json、builtin-edits.json、cards.json、data/effects/）
 *     已全部归档到 _attic_2026-09-27/storage-purge/ —— 不许再生成。
 *   - 效果覆盖层 → js/effects-data.js 由 build-effects.js 从 nations 重建。
 *   - 任何会写 nations / 写这些旧存储的脚本已全部禁用（见各脚本头部守卫）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.KG_DATA_ROOT || path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'game', 'data');
const NATIONS = path.join(DATA, 'nations');
const OUT_JS = path.join(ROOT, 'game', 'js', 'cards.js');
const OUT_REPORT = path.join(DATA, '_report.md');
const OUT_TEXTS = path.join(DATA, '_texts.txt');

if (!fs.existsSync(NATIONS)) {
  console.error('✗ 找不到 ' + NATIONS + ' —— 卡牌数据唯一存储 = nations/<国家>.json。');
  process.exit(1);
}

/* ---------------------------------------------------------------- 读 nations */
// 卡上的 meta 字段（adopted/adoptedAt/overlayFields/aliases）不进产物；
// overlayFields 名单里的字段属于效果覆盖层（build-effects.js 重建 overlay 时取）。
const META_FIELDS = ['adopted', 'adoptedAt', 'overlayFields', 'aliases'];
const cards = [];
const nationsFiles = fs.readdirSync(NATIONS).filter(f => f.endsWith('.json') && f !== '_meta.json').sort();
const stats = { unknownKw: {}, lowConf: [], varCards: [], opCosts: [], types: {}, sets: {}, noEffects: [] };
let overlayFieldCount = 0;

for (const f of nationsFiles) {
  const doc = JSON.parse(fs.readFileSync(path.join(NATIONS, f), 'utf8'));
  const nation = doc.nation || f.replace(/\.json$/, '');
  for (const card of Object.values(doc.cards || {})) {
    const ovFields = Array.isArray(card.overlayFields) ? card.overlayFields : [];
    const base = {};
    for (const [k, v] of Object.entries(card)) {
      if (META_FIELDS.includes(k)) continue;
      if (ovFields.includes(k)) continue;
      base[k] = v;
    }
    // 基础态兜底字段（与旧 merge 产物形态一致）：效果层的 effects 归 overlay；
    // 制卡台手动写的 effects（不在 overlayFields）保留在基础态。
    if (!Array.isArray(base.effects)) { base.effects = []; if (card.compiled == null) base.compiled = false; }
    if (base.compiled == null) base.compiled = false;
    // 国家一致性守卫：卡上的 set 与所在文件不符 = 数据错位，宁可报错也不悄悄归错国
    if ((card.set || 'misc') !== nation) {
      console.error('✗ ' + card.id + ' 的 set="' + card.set + '" 与所在文件 ' + f + ' 不符 —— 请人工核对 nations 数据');
      process.exit(1);
    }
    cards.push(base);
    overlayFieldCount += ovFields.length;
    stats.types[base.cardType + (base.unitType ? ':' + base.unitType : '')] = (stats.types[base.cardType + (base.unitType ? ':' + base.unitType : '')] || 0) + 1;
    stats.sets[base.set] = (stats.sets[base.set] || 0) + 1;
    if (base.confidence === 'low') stats.lowConf.push(base.id);
    if (base.variableStats) stats.varCards.push(base.id);
    if (!base.text && base.cardType === 'order') stats.noEffects.push(base.id);
    // 未知词条统计（keywords 里的 unknown: 前缀，供人工定语义）
    (base.keywords || []).forEach(k => {
      if (String(k).startsWith('unknown:')) stats.unknownKw[k] = (stats.unknownKw[k] || 0) + 1;
    });
  }
}

cards.sort((a, b) => a.id.localeCompare(b.id, 'zh'));

// ★ 数据戳：每次 merge 记录生成时间。卡池信息栏直接显示它。
const GENERATED_AT = new Date().toISOString();

// 浏览器可直接 <script> 加载的版本（无 fetch，file:// 也能跑）—— 字段列表与旧版完全一致
const jsBody = '/* 自动生成，勿手改：node game/tools/merge.js（唯一存储：data/nations/*.json） */\n' +
  '(function (g) {\n' +
  'g.KG_CARDS = ' + JSON.stringify(cards.map(c => ({
    id: c.id, src: c.src, art: c.art, name: c.name, set: c.set, sub: c.sub,
    system: c.system || null,
    cardType: c.cardType, unitType: c.unitType, cost: c.cost, attack: c.attack, defense: c.defense,
    opCost: c.opCost, keywords: c.keywords, kwMap: c.kwMap, kwValues: c.kwValues, keywordsRaw: c.keywordsRaw,
    rarity: c.rarity, token: c.token,
    text: c.text, flavor: c.flavor, variableStats: c.variableStats, confidence: c.confidence, notes: c.notes,
    effects: c.effects,
    dualAttack: c.dualAttack || null,
    costModByStat: c.costModByStat || null,
    costModPerOrder: c.costModPerOrder || null,
    costModPerIntel: c.costModPerIntel || null,
    costModPerKeyword: c.costModPerKeyword || null,
    upgradeTo: c.upgradeTo || null,
    upgradeKills: c.upgradeKills || null,
    upgradeOn: c.upgradeOn || null,
    targetsNeeded: c.targetsNeeded || null,
    showName: c.showName || false,
    drawOnTurn: c.drawOnTurn || null,
    startInHand: !!c.startInHand,
    autoUse: !!c.autoUse,
    referenceCard: c.referenceCard || null,
  })), null, 0) + ';\n' +
  'g.KG_CARD_INDEX = {}; (g.KG_CARDS||[]).forEach(function(c){g.KG_CARD_INDEX[c.id]=c;});\n' +
  'g.KG_CARDS.generatedAt = ' + JSON.stringify(GENERATED_AT) + ';\n' +
  '})(typeof window !== "undefined" ? window : globalThis);\n';
fs.writeFileSync(OUT_JS, jsBody, 'utf8');

// 效果文本语料，供编译器与人眼检查
fs.writeFileSync(OUT_TEXTS, cards.map(c =>
  `### ${c.id} | ${c.name} | ${c.cardType}${c.unitType ? '/' + c.unitType : ''} | cost=${c.cost} atk=${c.attack} def=${c.defense} op=${c.opCost} | kw=${c.keywordsRaw.join(',')}\n${c.text || '(无)'}`
).join('\n\n'), 'utf8');

const rpt = [];
rpt.push('# 卡池合并报告');
rpt.push('');
rpt.push('总卡数：**' + cards.length + '**（唯一存储：nations ' + nationsFiles.length + ' 个国家文件）');
rpt.push('');
rpt.push('## 分布');
rpt.push('| 分类 | 数量 |');
rpt.push('|---|---|');
Object.entries(stats.types).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => rpt.push('| ' + k + ' | ' + v + ' |'));
rpt.push('');
rpt.push('| 系列 | 数量 |');
rpt.push('|---|---|');
Object.entries(stats.sets).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => rpt.push('| ' + k + ' | ' + v + ' |'));
rpt.push('');
rpt.push('## 未识别词条（需人工定语义）');
Object.entries(stats.unknownKw).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => rpt.push('- `' + k + '` × ' + v));
rpt.push('');
rpt.push('## 变量数值卡（x/y/z）');
stats.varCards.forEach(id => rpt.push('- ' + id));
rpt.push('');
rpt.push('## low 置信度（建议人工复核）');
stats.lowConf.forEach(id => rpt.push('- ' + id));
rpt.push('');
rpt.push('## 命令卡但无效果文本');
stats.noEffects.forEach(id => rpt.push('- ' + id));
fs.writeFileSync(OUT_REPORT, rpt.join('\n'), 'utf8');

console.log('卡数:', cards.length, '（唯一存储 nations：', nationsFiles.length, '个国家文件，效果层字段', overlayFieldCount, '处）');
console.log('未知词条:', JSON.stringify(stats.unknownKw));
console.log('low:', stats.lowConf.length);
console.log('输出:', OUT_JS, OUT_REPORT, OUT_TEXTS, '（不再生成 cards.json —— 已归档）');
