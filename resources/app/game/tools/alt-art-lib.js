/* 异画扫描 —— **唯一真源**（命令行与服务器共用同一份逻辑，别各写一遍）
 *
 * 约定：卡的图是 `A/B/-13.png`，异画就是 `A/B/-13y.png`（同名 + 后缀 y）。
 * 复用方：
 *   · game/tools/scan-alt-art.js  → 生成 game/js/alt-art.js（静态兜底表，file:// 下也能用）
 *   · game/tools/serve.js         → GET /__alt-art 现扫文件系统（刷新页面即生效，不用跑脚本）
 *
 * 返回：{ 卡id: '../A/B/-13y.png' }（路径相对 game/ 目录，与卡数据的 art 字段同一惯例）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function readCards(root) {
  try {
    const box = {};
    vm.runInNewContext(fs.readFileSync(path.join(root, 'game', 'js', 'cards.js'), 'utf8'), box);
    return box.KG_CARDS || [];
  } catch (e) { return []; }
}

function scanAltArt(root) {
  const alt = {};
  readCards(root).forEach(function (c) {
    const src = c && (c.src || (c.art ? String(c.art).replace(/^\.\.\//, '') : null));
    if (!src || !/\.png$/i.test(src)) return;
    const altSrc = src.replace(/\.png$/i, 'y.png');
    if (fs.existsSync(path.join(root, altSrc))) alt[c.id] = '../' + altSrc.replace(/\\/g, '/');
  });
  return alt;
}

/* 异画**对位**配置（手填，可选）：game/data/alt-art-ui.json
 *   { "卡id": { "atk": {x,y,w,h,fs}, "def": {…} } }     单位：x/y 是块**中心**位置（%），w/h 是块宽高（%），fs 是字号倍数
 * 为什么需要它：卡图是原版 500×701 模板，UI 叠加的攻防块按"图内画的块"对位（左 25% / 右 76%）。
 *   异画可能换了模板，攻防块画在别处 → 切异画时叠加块也得跟着挪，否则**数字和图上画的块错位两层**。
 * 没这项配置的卡沿用默认对位，行为和以前完全一样。 */
function readAltUi(root) {
  const file = path.join(root, 'game', 'data', 'alt-art-ui.json');
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
  const out = {};
  Object.keys(raw || {}).forEach(function (k) {
    if (k.charAt(0) === '_') return;                       // _note 之类的说明键
    const v = raw[k];
    if (!v || typeof v !== 'object') return;
    const one = {};
    ['atk', 'def'].forEach(function (g) {
      const g2 = v[g];
      if (!g2 || typeof g2 !== 'object') return;
      const o = {};
      ['x', 'y', 'w', 'h', 'fs'].forEach(function (f) {
        if (typeof g2[f] === 'number' && isFinite(g2[f])) o[f] = g2[f];
      });
      // bg：0 = 不画底（异画自带数字时用）；1 = **实心底，盖住图内画的数字**（2026-09-24：
      //   图里画的攻防值跟真实值不一致时用它）；也可以直接给颜色字符串（自定义底色）
      if (g2.bg === 0 || g2.bg === false) o.bg = 0;
      else if (g2.bg === 1 || g2.bg === true) o.bg = 1;
      else if (typeof g2.bg === 'string' && /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(g2.bg.trim())) o.bg = g2.bg.trim();
      if (typeof g2.color === 'string' && /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(g2.color.trim())) o.color = g2.color.trim();
      if (Object.keys(o).length) one[g] = o;
    });
    if (Object.keys(one).length) out[k] = one;
  });
  return out;
}

module.exports = { scanAltArt, readCards, readAltUi };
