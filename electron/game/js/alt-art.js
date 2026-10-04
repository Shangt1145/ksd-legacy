/* 自动生成，勿手改：node game/tools/scan-alt-art.js
 * 卡 id → 异画图路径（同名图片 + y）。没有异画的卡不在表里 → 前端不给切换入口。
 * KG_ALT_ART_UI = 异画攻防块对位（源文件 game/data/alt-art-ui.json，切异画时叠加块跟着挪）。
 * （从 serve.js 打开时前端会去 GET /__alt-art 现扫，此表仅作 file:// 等场景的兜底） */
(function (g) {
g.KG_ALT_ART = {
 "av76/units/26": "../av76/units/26y.png",
 "UN/unit/-13": "../UN/unit/-13y.png",
 "USG/units/_34": "../USG/units/_34y.png"
};
g.KG_ALT_ART_UI = {
 "UN/unit/-13": {
  "atk": {
   "x": 9.5,
   "y": 19,
   "fs": 3,
   "bg": 1
  },
  "def": {
   "x": 88.9,
   "y": 19,
   "fs": 3,
   "bg": 0
  }
 },
 "USG/units/_34": {
  "atk": {
   "x": 11.7,
   "y": 19,
   "fs": 3,
   "bg": 1
  },
  "def": {
   "x": 89,
   "y": 19,
   "fs": 3,
   "bg": 0
  }
 },
 "av76/units/26": {
  "atk": {
   "x": 11,
   "y": 19,
   "fs": 3,
   "bg": 1
  },
  "def": {
   "x": 90,
   "y": 19,
   "fs": 3,
   "bg": 0
  }
 }
};
})(typeof window !== "undefined" ? window : globalThis);
