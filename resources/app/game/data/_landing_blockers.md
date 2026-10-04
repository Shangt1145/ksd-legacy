# 落盘阻塞项清单（编译器产物 vs 手写覆盖的行为差异）

> 产生方式：把 `effects-data.js` 换成"全编译器产物"版（只保留「进攻」+ 词条参照卡的手写），
> 跑 `tools/fxcheck.js`。**119 条行为测试里 17 条失败** —— 这 17 条就是编译器必须先修好的差异。
> 结论：**在这些差异清零之前，落盘会破坏游戏行为**（已回滚）。

## ★ 差异性质分析：是"缺规则"还是"缺原语"？（逐 op 统计）

对全部有手写覆盖的卡，逐条对比"手写有、编译没有"的动作 op，并判断该 op 是否**已存在**：

| 分类 | 条目数 | 说明 | 该做什么 |
|---|---|---|---|
| **A. 原语已存在，只缺解析规则** | **213** | 如 `draw`/`discover`/`conditional`/`repeat`/`forEach`/`damageAll`/`destroyAll`/`buffAll`/`chooseOne`/`chooseHandCard`/`transformHandCard`/`copyToDeck`/`randomPick`/`shuffleIn`/`nextTurnKredits`/`setHandCost`/`hqMaxUp`/`endTurnNow`/`randomPick`/`auraBuff`/`grantMod(...)` 等，**全部已在 `effects.js` 的 OPS 里实现** | **补 `primitives.js` 的句式解析规则**（纯工程量） |
| **B. 卡牌定义修正字段** | 6 | `dualAttack`/`token`/`rarity`/`upgradeTo`/`upgradeKills`/`upgradeOn`/`targetsNeeded`/`$oncePerTurn`/`mod:frontlineMaxOverride` | **不是效果**，是卡牌数据 → 落盘时 `Object.assign` 原样保留 |
| **C. 手写字段引擎不读** | 2 | `noRetreat`（星盟/u/-1）、`counterImmune`（USG/units/_31）—— 连引擎都没有读取路径 | 属**引擎缺口**（手写也无效）；卡面语义需引擎补字段 |
| **D. 词条参照卡** | 3 | `gue`/`sms`/`tsekep`（`cost=null` 的说明卡） | 本就不该有效果 → `compile()` 跳过 |

### 结论
- **需要"新增原语"的：0 条**。所有差异都能落到**已有 op** 或**引擎已支持的 mod 字段**上。
- 95% 的差异是"**原语有了，只是还没写这条句式的解析规则**" —— 是**工程量**问题，不是**能力**问题。
- 所以落盘路径 = **分批补解析规则，每批用「落盘 → fxcheck」验证**，而不是去发明新原语。

## 失败清单（17 条）

| # | 测试 | 现象 | 涉及 |
|---|---|---|---|
| 1 | 洗入卡组：牌库变厚 | 崛起 牌库 35→35（没洗入） | 星盟/c/-17 |
| 2 | 游击战术（所有太空单位）只强化我方 | 我方 4→4、敌方 4→4（没强化） | — |
| 3 | 指向性增益（兵贵神速）仍可选择任意目标 | 没有目标声明 | av76/command/… |
| 4 | 别人上前线不会给 UNTED-236 加攻击力 | 监听没触发 | av76/units/… |
| 5 | 「友方单位移至前线时」监听效果正常触发 | 国际后勤组织 指挥点无变化 | — |
| 6 | 「无视单位效果」不会免疫战斗伤害 | 卡池里没有这类卡 | 编译丢了 grantMod |
| 7 | 「开发」用该卡自己的卡池 | 近地支援 提供的选项错 | — |
| 8 | 「从卡组中开发」是复制（卡组牌不消失） | 老旧资产 提供 []，卡组 2→2 | — |
| 9 | 头进气道试验机：受伤后行动花费只 +3 一次 | 1→4→7（应第二次不变） | — |
| 10 | 指名卡池：帝国坦克 / 新星联盟 | 帝国统治/联合宣言 提供 [] | — |
| 11 | 斯卡塔尔轰炸机：攻击时把目标攻击力设为 0 | 3→3（没生效） | — |
| 12 | zbk1母舰：召唤随机战斗机并获得其攻击力 | 母舰攻击 0→0 | deran/units/_18 |
| 13 | 戒严令：总部免疫由该单位提供 | 免疫来源=null | — |
| 14 | 手牌减费只从"进手之后"开始算 | MR-80 进手时就已减费 | — |
| 15 | 新建"太空战机"分类 + 可跨阵线 | 只找到 3 张（应 7 张） | — |
| 16 | 延迟抽牌：单位行动 → 下个回合额外抽牌 | 附魔=0、待抽=0、指挥点超出 0 | — |
| 17 | canMoveAndAttack 原语：移动后仍可行动 | 能力=false | av76/units/-4 |

## 修复方向（按类归并）

1. **被动/常驻规则没被编译出来**（#2 #6 #15 #17）：`passiveRules` 类字段（`canMoveAndAttack`、
   `ignoreEnemyEffects`、`extraTypes`/`unitType` 修正）需要编译器产出，或保留在卡牌定义里。
2. **监听触发没接上**（#4 #5 #16 #13）：`friendlyMoved`/`hqImmune`/`extraDraw` 等触发器。
3. **卡池/开发类**（#7 #8 #10）：`discover` 的 `cardIds`/`setIn` 过滤没编译出来。
4. **带条件的重复修正**（#9 #14）：`oncePerTurn`/时间窗口类。
5. **动作缺失**（#1 #12 #11）：`copyToDeck`/`randomPick`/`setStats(0)` 等 op 没被规则覆盖。

## 关键教训

- **覆盖率（99%）≠ 语义正确率**。覆盖率只衡量"句子能不能被解析出点东西"，
  不衡量"解析出的效果对不对"。落盘必须看**行为测试**，不能看覆盖率。
- **`data/effects/*.json` 混装了两类字段**：
  - **效果**（`effects`）→ 可以让编译器生成
  - **卡牌定义修正**（`dualAttack`/`unitType`/`token`/`rarity`/`upgradeTo`/`targetsNeeded`/`cost`/`attack`/`defense`/`referenceCard`…）
    → **必须原样保留**（它们不是效果，是卡牌数据）
  落盘脚本只应替换 `effects`，其余字段 `Object.assign` 保留。
- **落盘脚本要从源头读手写**（`data/effects/*.json`），不能从 `effects-data.js` 读 ——
  否则第二次运行会读到上一次被覆盖的产物，字段自举丢失（曾丢掉 `dualAttack`，fxcheck 直接崩）。
