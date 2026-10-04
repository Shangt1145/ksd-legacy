# 卡牌效果 DSL 规范 v1（供效果编码员使用）

## 0. 三层写法（推荐顺序，从简到繁）

1. **原语组合（首选）**：卡面中文按关键词拆解后自动组合，见 §0.1。
   `node game/tools/coverage.js` 随时给出覆盖率与未解析句式清单。
2. **手写 DSL JSON**（下面第 1 节起的 op 列表）。
3. **JS 脚本逃生舱**（任何写不出来的效果都能兜住）：
   ```json
   { "trigger": "attack", "script": "targets[0].attack = 0; log('把 ' + targets[0].name + ' 攻击力设为 0')" }
   ```
   可用变量：`state`（整局状态）`ctx`（owner/unit/event/card）`a`（本条动作）`targets`（按 `a.target` 选出的单位数组）
   `KG`（引擎全部 API）`log(t)` `num(v)` `ask(req)`。改数值直接改对象字段（持久化在单位上）。
   等价写法：`{"op":"script","code":"..."}`。

## 0.1 原语组合语法

一句话 = `[选靶方式] + [阵营] + [区域] + [限定条件] + [动作] + [数值]`，顺序自由、可任意排列组合：

| 卡面写法 | 拆解 | 生成的效果 |
|---|---|---|
| 随机消灭一个单位 | 选靶:随机 + 动作:消灭 | `destroy` + `{sel:'random', side:'enemy'}` |
| 消灭前线所有单位 | 动作:消灭 + 区域:前线 + 选靶:所有 | `destroy` + `{sel:'all', zone:'frontline'}` |
| 对一个花费不大于4的敌方单位造成3点伤害 | 数量:一个 + 条件:花费≤4 + 阵营:敌方 + 动作:伤害(3) | 声明目标 + `damage 3` |
| 使所有友方太空单位获得+2+2 | 选靶:所有 + 阵营:友方 + 兵种:太空 + 动作:增益 | `buff` + `{sel:'all', side:'friendly', filter:{unitType:'space'}}` |
| 抽两张牌并使其获得闪击 | 复合句（并） | `draw 2` + `grant blitz` |
| 如果剩余指挥点不小于4，随机消灭一个敌方单位 | 条件句 | `conditional` |
| 若在手牌中，友方每使用一张指令，获得-2花费 | 卡面属性 | `cardFields:{costModPerOrder:-2}` |

约定：**指向性**（"一个"）默认 `side:'any'`（由玩家选目标）；**非指向性**（"所有/随机"）没写阵营时，
增益类默认友方、伤害/消灭类默认敌方。

词表位置：`game/js/primitives.js`（选靶 QUANT / 阵营 SIDE / 区域 ZONE / 条件 FILTERS / 动作 ACTIONS）。
**加新机制只需往词表里加一条**，不用再写整句正则。

## 0.2 原语组合器（铁律）

> **能分解成原语词汇的就分解成原语；如果没办法拆分的，才做成一个单独的原语。**

四个注册表构成本引擎的全部词汇：

| 注册表 | 位置 | 形态 | 数量 |
|---|---|---|---|
| 动作原语 `OPS` | `effects.js` | `OPS[name] = async (state, ctx, a) => {}` | 101 |
| 条件原语 `CONDS` | `effects.js` | `CONDS[name] = (state, ctx, c) => boolean` | 40 |
| 组合器 | `effects.js` | `and` / `or` / `not` / `forEach` / `repeat` / `conditional` | 6 |
| 选靶 / 阵营 / 区域 / 兵种 | `primitives.js` | `UNIT_TYPES` 为唯一权威兵种词表 | — |

判定与执行各有一条**总入口**，任何未登记的名字都会被点名而不是静默放过：

- `evalCond(state, ctx, c)` —— 查 `CONDS[c.op]`。查不到 → 记 `⚠ 未实现的条件原语: X` 的 **error** 日志（旧版是静默 `return true`，等于把写错的条件当成恒真，本仓库历史上真被这个坑过）。
- `runAction` —— 查 `OPS[a.op]`。查不到 → 记 `⚠ 未实现的动作原语: X`。

**什么样叫"拆得开"**：`如果剩余指挥点不小于4` = `{op:'compare', left:{kredits:'self'}, cmp:'>=', value:4}`；
`本单位可以在同一回合内移动并攻击` = `{op:'canMoveAndAttack'}`；`造成20点伤害平均分配至敌方所有目标` = `{op:'damageSplit', total:20, evenTo:'hq'}`。

**什么样叫"拆不开"**（保留为独立原语，只做规范化命名）：
`orderDoubleTurn`（6 分护卫舰"指令效果翻倍"）、`setLastAddedCost`（强力支援"花费减为0"）、
`conditionalRandomSplit`（仅作兼容别名存在）——它们要么依赖引擎内部的整回合结算钩子，要么改的是"刚刚加入手牌那张牌"这种上下文状态，
拆成通用词汇反而会丢掉语义。这类原语必须：① 登记在注册表里；② 在 `EFFECT_DSL.md` 有参数说明；③ 名字按 `动作+对象` 规范命名。

**通用比较原语 `compare`**：条件里凡是要比大小的，一律用它，不要为每个资源单独造一个带 `cmp` 的 op
（那正是 `deran/units/_5` 出 bug 的根源——`kreditsAtLeast` 只读 `value` 不读 `cmp`，卡面"若无剩余指挥点"退化成恒真）。
`left`/`right`/`value` 都走 `num()`，支持 `{kredits:'self'}`、`{hand}`、`{deck}`、`{hq}`、`{stat, of}`、`{count, spec}`、`{turn:true}` 等取值器。

**同一概念只能有一个名字**。新增原语前先搜注册表；能复用就复用，不能复用才新增，且同时补上 `fxcheck.js` 的自检条目。

---

引擎已经实现好了一个效果虚拟机。你的任务：**读卡面文本，写出精确的 DSL JSON**。

引擎源码：`game/js/engine.js`（规则）、`game/js/effects.js`（操作原语）、`game/js/primitives.js`（原语词表）。
常用效果优先走"原语组合"；确实需要新原语时，写进该卡的 `notes`，必要时用 JS 脚本兜底。

---

## 1. 输出格式

每张卡一条记录，写进你负责的 `game/data/effects/<你的文件名>.json`：

```json
{
  "cards": {
    "<卡片 id>": {
      "effects": [ ...效果列表... ],
      "targetsNeeded": [ ...可选，打出手牌时就需要选目标... ],
      "upgradeTo": "另一张卡的 id",
      "upgradeKills": 2,
      "referenceCard": true,
      "notes": "不确定的地方"
    }
  }
}
```

- 卡片 id 见 `game/data/cards.json`（也见 `game/data/_texts.txt` 的行首 `### <id> | 名称 ...`）。
- 只要写出**有内容的字段**，没有的字段省略。
- 卡面文本在 `game/data/cards.json` 的 `text` 字段（已逐字转写，含原始错别字，不要"修正"语义）。

---

## 2. 效果结构

```js
{
  trigger: 'order' | 'deploy' | 'mobilize' | 'death' | 'turnStart' | 'turnEnd'
         | 'attack' | 'attacked' | 'afterAttack' | 'damaged'
         | 'unitDeployed' | 'orderPlayed' | 'hqDamaged' | 'counter' | 'passive',
  // ↓ 仅 counter（反制卡）用
  on: 'unitDeployed' | 'friendlyDeath' | 'friendlyDamaged' | 'orderPlayed' | 'unitActed' | [...],
                                             // 响应哪个事件；不写 = 对手的任何行动。别名 deploy→unitDeployed
  owner: 'foe' | 'self' | 'any',             // 这是"谁的事件"（默认 foe = 对手的事件）
  interrupt: 'deathrattle' | 'fatalDamage',  // 打断型反制：由引擎在事件【发生前】同步消费，不需要 actions
  targets: [ { id:'t', side:'enemy'|'friendly'|'any', kind:'unit'|'hq'|'any',
               filter:{...}, count:1, optional:false, prompt:'选择目标' } ],  vars: { x: <数值表达式> },                  // 卡面变量 x/y/z
  condition: <条件>,
  actions: [ <动作> ],
  else: [ <动作> ],                            // condition 不成立时
  aura: { target:{sel:'all',side:'friendly',filter:{unitType:'tank'}}, attack:1, defense:0, keyword:'guard' },
  passiveRules: { noAttackHQ:true },           // 常驻自我修正
  noAttackIfNameOnBoard: '钳级巡地舰',           // 特例：场上有同名时无法被攻击
  unimplemented: true
}
```

### 触发器语义

| trigger | 何时触发 |
|---|---|
| `order` | 指令牌（`cardType:'order'`）被打出时（效果主体）。反制卡不走这条 |
| `deploy` | 单位进入战场时（卡面写"部署："） |
| `mobilize` | 单位移动到前线时（**只有正在移动的这个单位自己**，卡面写"本单位移至前线时/动员"） |
| `unitMobilized` | 友方任意单位移动到前线时（监听类，卡面写"友方单位移至前线时"） |
| `death` | 单位被消灭时（"亡计："） |
| `turnStart` / `turnEnd` | 该单位拥有者回合开始/结束时 |
| `attack` | 本单位攻击时 |
| `afterAttack` | 本单位攻击结算完成后 |
| `attacked` | 本单位攻击之后（同 attack，用于"攻击后"） |
| `damaged` | 本单位受到伤害后 |
| `unitDeployed` | 友方（owner 方）任意单位部署时 |
| `friendlyDeath` | 友方单位被消灭时（写 `death` 也可以：监听类效果会同时匹配 `friendlyDeath` 与 `death`；单位自身的亡计仍然只在自己死亡时触发） |
| `orderPlayed` | 友方使用任意指令时 |
| `hqDamaged` | 友方总部受到伤害时 |
| `counter` | **反制卡**（`cardType:'counter'`）被触发时：花指挥点埋下 → 挂起 → 满足 `on`/`owner` 的事件发生时结算**一次** → 进弃牌堆 |
| `counterSet` | 反制卡被埋设（挂起）时 |
| `passive` | 常驻（光环/静态修正），引擎会持续重算 |

### 总部附魔条目支持的额外字段

`hqEnchant` 里的每个效果条目可以写：

- `forOpponent: true` —— 监听**对手**的事件（例如"敌方部署空军时，将其压制"）
- `unitType: 'fighter'` —— 只在该兵种部署时触发
- `filter: {unitType, cardType}` —— 更细的过滤

事件里的单位可用 `"eventUnit"` 在动作中引用（例如 `{"op":"pin","target":"eventUnit"}`）。

### 反制卡（cardType:'counter'）示例

```jsonc
// 远程打击：对手部署单位时，消灭它
{ "trigger": "counter", "on": "unitDeployed", "owner": "foe",
  "actions": [ { "op": "destroy", "target": { "sel": "ref", "ref": "eventUnit" } } ] }

// 突袭：一个单位的亡计触发前，将其抑制（打断型，不需要 actions）
{ "trigger": "counter", "on": "friendlyDeath", "owner": "any", "interrupt": "deathrattle" }

// 偏转护盾：友方目标将受到致命伤害时，随机转给另一个单位（打断型）
{ "trigger": "counter", "on": "friendlyDamaged", "owner": "self", "interrupt": "fatalDamage" }
```

两个打断型的结算点（都是**同步**的，在事件发生之前）：
`interrupt:'deathrattle'` → `engine.killUnit`（先问对手、再问自己有没有埋这张）；
`interrupt:'fatalDamage'` → `engine.damageUnit`（伤害 ≥ 当前防御力时触发，转移目标不分敌我）。

### 手牌 / 卡组附魔

- `buffCardsInPiles`：`{side, filter:{cardType,unitType,set,maxCost,name}, attack, defense, keyword|keywords[], piles:'hand'|'deck'}`
  给手牌 / 卡组里的牌永久强化，打出时生效。
- `setHandCost`：`{side, count, filter:{cardType,maxCost}, mode:'set'|'reduce', value|amount}`
- `handToField`：`{side, filter:{maxCost,unitType}, to:'frontline'|'support', removeKeywords:[], prompt}`（"从手牌选一张单位放进阵线"）
- `chooseFromHand`：`{side, filter:{cardType,unitType,maxCost,name}, mode:'keep'|'discard'|'toField'|'duplicate', to, prompt, actions?}`
  让玩家从手牌里选一张，然后弃掉 / 上场 / 复制；选中的卡可在后续动作里用 `{'stat':'cost','of':'target'}` 等引用。
  （另：`OPS.chooseFromHand` 会把选中手牌放在 `ctx.chosenHandIndex/chosenHandInst/chosenHandCard`）

### 其它新增

- `orderDoubleTurn`：`{side}` —— 本回合该玩家的指令效果执行两次（"友方使用的指令效果翻倍"）
- `endTurnNow`：立刻结束当前回合（"部署：结束回合"）
- `matchFilter` 新过滤键：`adjacentTo:'self'`（与效果来源单位在同一条阵线且相邻）、`damagedBySelf:true`（曾被本单位造成过伤害的单位）
- `"eventUnit"` 可作为目标引用"本次事件的单位"（配合 `hqEnchant` / `counter` 使用）
- `upgradeOn`：`{trigger:'unitDeployed', side:'self', nameIncludes:'Mk', count:1, unitType}` —— 事件驱动的老兵升级
- `targetIsUnit` / `targetIsHQ` 条件：判断已选目标是单位还是总部

### 数值表达式

| 写法 | 含义 |
|---|---|
| `3` | 常数 |
| `"x"` | 引用 `vars.x` |
| `{"count":{"side":"friendly","filter":{"unitType":"space"}}}` | 符合条件的单位数量 |
| `{"stat":"attack","of":"self"}` | 引用单位属性（`attack`/`defense`/`maxDefense`/`missing`/`armor`），of 可为 `self`/`target` |
| `{"hand":"enemy"}` / `{"deck":"self"}` | 手牌/牌库张数 |
| `{"hq":"enemy","mode":"missing"}` | 总部数值（`missing` = 缺失值） |
| `{"turn":true}` | 当前回合数 |
| `{"kredits":"self"}` | 当前指挥点 |
| `{"sum":{"items":[...]}}` / `{"mul":{"items":[...]}}` / `{"min":...}` / `{"max":...}` | 运算 |

### 条件

> **设计原则**：能拆的拆成原语组合，拆不了的才做成一个独立原语。
> 条件原语登记在 `KG.effects.CONDS` 里（`tools/fxcheck.js` 会自动审计"数据里用到的条件是否都登记了"）。
> 复合条件是**组合器**：`and` / `or` / `not` 把子条件接起来。

```js
// ── 通用比较原语（推荐）─────────────────────────────────────────────
// 凡是"某个量 > / >= / < / <= / == / != 某个数"，都用 compare：
{"op":"compare","left":{"kredits":"self"},"cmp":">=","value":5}   // 剩余指挥点不小于5
{"op":"compare","left":{"kredits":"self"},"cmp":"==","value":0}   // 若无剩余指挥点
{"op":"compare","left":{"hand":"self"},"cmp":">=","value":3}      // 手牌数
{"op":"compare","left":{"deck":"enemy"},"cmp":"<=","value":5}     // 敌方卡组数
{"op":"compare","left":{"hq":"enemy"},"cmp":"<","value":10}       // 敌方总部
{"op":"compare","left":{"turn":true},"cmp":">=","value":5}        // 回合数
{"op":"compare","left":{"stat":"attack","of":"self"},"cmp":">=","value":4}   // 单位攻击力
{"op":"compare","left":{"count":{"sel":"all","side":"enemy","filter":{"unitType":"tank"}}},"cmp":">=","value":2}
// left 的所有取值形态见「数值表达式」一节（num() 支持的全部形式）

// ── 复合条件（组合器）─────────────────────────────────────────────
{"op":"and","items":[...]} / {"op":"or","items":[...]} / {"op":"not","item":{...}}

// ── 场面 / 资源 ──────────────────────────────────────────────────
{"op":"controlFrontline"}                     // 我控制前线（前线有我的单位）
{"op":"frontlineControl","value":1}           // 1 我控制 / -1 敌方控制 / 0 争夺中
{"op":"frontlineEmpty","side":"enemy"}
{"op":"frontlineEnemyOrFull"}                 // 敌方占着前线 或 我的前线已满
{"op":"hasRoom","side":"self","zone":"frontline"}   // 前线还有空位
{"op":"hqBelow","side":"enemy","value":10}    // 等价 compare left:{hq:'enemy'} cmp:'<'
{"op":"hqAbove","side":"self","value":5}
{"op":"handSize","side":"enemy","cmp":">=","value":3}
{"op":"deckSize","side":"self","cmp":">=","value":10}
{"op":"kreditsAtLeast","side":"self","value":4,"cmp":">="}   // 兼容写法；cmp 会被读取
{"op":"kreditsAtMost","side":"self","value":4,"cmp":"<="}

// ── 单位 ─────────────────────────────────────────────────────────
{"op":"unitCount","cmp":">=","value":3,"spec":{"side":"enemy","filter":{"unitType":"tank"}}}
{"op":"unitCountLess"}                        // 友方单位数少于敌方（第989步兵团）
{"op":"controlsType","side":"friendly","unitType":"space","cmp":">=","value":1}
{"op":"hasKeyword","target":"self","keyword":"impact"}
{"op":"isUnitType","target":"self","unitType":"tank"}
{"op":"damaged","target":"self"}
{"op":"undamaged","target":"self"}
{"op":"targetAlive","target":"t"}
{"op":"targetDead","target":"t"}              // "若其被消灭"
{"op":"targetIsUnit","target":"t"} / {"op":"targetIsHQ","target":"t"}

// ── 卡牌 ─────────────────────────────────────────────────────────
{"op":"handHasCard","side":"self","name":"补给"}
{"op":"cardInDeck","name":"电离"}
{"op":"discoveredCardNotInDeck"}              // 「开发出的那张不在构筑内」（生产）
{"op":"revealedInEnemyHand"}                  // 「敌方手中具有明牌」

// ── 事件（触发时"这次的当事者是谁"）──────────────────────────────
{"op":"eventUnitIs","name":"Mk","unitType":"tank"}   // "友方部署一辆Mk坦克后"
{"op":"eventCardIs","name":"进攻"}                   // "若使用的是一张进攻"
{"op":"deadUnitCostAtLeast","value":5}               // "若被消灭的单位花费不小于5"
{"op":"defenderIsType","type":"tank"}                // "若攻击的目标是坦克"

// ── 回合节奏 / 随机 / 变量 ────────────────────────────────────────
{"op":"playedUnitThisTurn","value":1} / {"op":"firstUnitThisTurn"}
{"op":"turnAtLeast","value":5}
{"op":"var","name":"x","cmp":">=","value":3}
{"op":"random","chance":0.5}
```
`cmp` 默认 `>=`，可取 `>=` `>` `<` `<=` `==` `!=`。
⚠️ **需要比较方向时请用 `compare`**：`kreditsAtLeast` 这类老写法虽然也读 `cmp`，但语义上叫"AtLeast"却传 `cmp:'=='` 很别扭，也容易被误读。


### 选择器（动作里的 target）

```js
"t"                                             // 引用 targets 里声明的目标
"self"                                          // 效果来源单位自身
{"sel":"all","side":"enemy","filter":{"unitType":"tank"}}
{"sel":"all","side":"friendly","filter":{"keyword":"guard"},"excludeSelf":true}
{"sel":"random","side":"enemy","count":1,"filter":{"maxAttack":3}}
{"sel":"choose","side":"enemy","prompt":"选择一个敌方单位"}   // 效果执行中临时询问
{"sel":"all","side":"both","zone":"frontline"}
```
filter 支持：`unitType`（可为数组）`notUnitType` `keyword` `notKeyword` `maxAttack` `minAttack` `maxDefense` `minDefense` `maxCost` `minCost` `zone` `damaged` `name`（名称包含）`set` `cardId`。
`side` 可取 `friendly` `enemy` `both`。

### 声明目标的 kind（能不能指向总部）

`targets[].kind` 决定**总部**是否在候选里：

| kind | 候选 | 卡面写法（原语自动判定） |
|---|---|---|
| `unit` | 只有单位 | `对一个单位造成X点伤害` —— 这就是"不能指向总部" |
| `any` | 单位 + 总部 | `对一个目标造成X点伤害` / 光写 `造成X点伤害` |
| `hq` | 只有总部 | （一般不用；直接用 `damageHQ` 更直接） |

- 玩家若在 `kind:'any'` 的提示里选了总部，`damage` 会自动改成打总部（`FX.targetEntryHQ`）。
- `对所有目标造成X点伤害` 会被原语拆成 `damage`(所有单位) + `damageHQ`(各方总部)；`对所有敌方目标造成X点伤害` = `damageAll(enemy)` + `damageHQ(enemy)`。
- 只有伤害类动作会把总部算进候选；消灭 / 压制 / 增益仍只列单位。

---

## 3. 动作 op 清单

### 伤害 / 治疗 / 消灭
| op | 参数 |
|---|---|
| `damage` | `target`, `amount` |
| `damageAll` | 同 damage（对选择器里所有单位生效） |
| `heal` / `healAll` | `target`, `amount` |
| `destroy` / `destroyAll` | `target` |
| `damageHQ` | `side`（`enemy`/`self`）, `amount` |
| `healHQ` | `side`, `amount` |
| `setStats` | `target`, `attack?`, `defense?`（直接设置） |
| `setDefense` | 同 setStats |
| `debuff` | `target`, `attack`, `defense`（负数扣减） |
| `buff` / `buffAll` | `target`, `attack?`, `defense?`, `keyword?`, `opCostMod?`, `duration:'turn'?` |
| `armorBonus` | `target`, `amount` |
| `damageSplit` | `total`（或 `amount`）, `target`(选择器), `evenTo:'hq'?` —— «造成 N 点伤害，平均分配至 X»。先算分母 `单位数 (+ evenTo:'hq' ? 1)`，每份 `floor(total/denom)`，余数从前往后逐个 +1 地分掉；`evenTo:'hq'` 时总部也占一份。目标为空时伤害全额转给总部。**不要再为单张卡写专用分配原语**，一律走这条 |
| `conditionalRandomSplit` | `total`, `target?` —— `damageSplit`(`evenTo:'hq'`) 的**兼容别名**，仅为老数据保留；新数据请直接写 `damageSplit` |

### 卡牌与资源
| op | 参数 |
|---|---|
| `draw` | `count`, `side` |
| `drawUntil` | `handSize`, `side` |
| `discard` | `side`, `count`, `mode:'random'\|'first'` |
| `discardAll` | `side`, `filter:{cardType}` |
| `discardFromDeck` | `side`, `filter:{cardType}`（"弃掉卡组中的所有单位"） |
| `mill` | `side`, `count` |
| `shuffleIn` | `cardId`\|`name`, `count`, `side`, `to:'top'?` |
| `shuffleInUntil` | `name`\|`cardId`, `deckSize`（"洗入卡组直至卡组数为39"） |
| `removeDeckTop` | `count`, `side`, `to:'discard'\|'hand'\|'removed'` |
| `deckToHand` | `count`, `side`, `filter:{cardType,set,maxCost}` |
| `deckToField` | `filter`, `to:'support'\|'frontline'`, `buff:{attack,defense}?`, `keyword`? |
| `enemyDeckToHand` | —（"将敌方卡组顶的卡牌置于手牌中"） |
| `addCardToHand` | `name`\|`cardId`\|`self:true`（复制自己）, `count`, `side`, `random:true`?（同名/包含匹配里随机取） |
| `copyToDeck` | `of:'self'`, `cardId?`, `halve:true`?（数值减半的复制） |
| `transformHandCard` | `filter:{cardType,set,maxCost}`, `mode:'random'\|'first'`, `side` |

**取卡顺序**（`addCardToHand` / `summon` / `shuffleIn` / `shuffleInUntil` 共用 `FX.opCardId`）：
`cardId` → `self:true`（这张卡自己）→ `name`（精确 → `aliases.json` 别名 → 互相包含 → **名称包含**，会剥掉
`单位/卡牌/卡/牌` 后缀，`X单位` 时只找单位；带 `random:true` 时在多个候选里随机取）→ `filter:{set,cardType,unitType}`
（按条件从卡池随机取）→ 都失败才记日志。**绝不会**再打出「卡池中找不到「undefined」」。
| `salvage` | `count`, `side`（弃牌堆随机取回） |
| `discover` | `filter:{cardType,set,maxCost,minCost}`, `prompt`（"开发一张…"） |
| `intel` | —（查看对手手牌） |
| `reveal` | `target` |
| `noDrawNextTurn` | `side` |
| `gainKredits` | `amount`, `side` |
| `gainKreditSlot` | `amount`, `side` |
| `loseKredits` / `loseKreditSlots` | `amount`, `side` |
| `setKreditSlots` | `value`, `side` |
| `nextTurnKredits` / `nextTurnSlots` | `amount`, `side` |
| `nextTurnDrawPending` | `amount`, `side`（下个己方回合开始时额外抽 N 张） |
| `costReduce` | `amount`, `side`（本回合手牌费用修正） |

### 场面与词条
| op | 参数 |
|---|---|
| `summon` | `name`\|`cardId`, `count`, `side` |
| `returnToHand` | `target`（「撤退」语义：前线→支援线；支援线→手牌） |
| `retreat` | `returnToHand` 的别名（卡面/原语里写的就是「撤退」） |
| `move` | `target`, `to:'frontline'\|'support'`（效果驱动的强制移动，不受"非游击不能退回支援线"限制） |
| `pin` / `unpin` | `target`, `turns?` |
| `grant` / `grantAll` | `target`, `keyword`, `value?` |
| `grantRandomCombatKw` | `target` 或 `side` |
| `removeKeyword` | `target`, `keyword` |
| `silence` | `target` |
| `opCostMod` | `target` 或 `side`, `amount`（负数为减） |
| `setOpCost` | `target`, `value` |
| `globalOpCostMod` | `side`, `amount` |
| `grantMod` | `target` 或 `side`, `mod`, `value`/`unitType`/`attack`/`damage`/`takeDamage`/`double` |
| `canMoveAndAttack` | `target?`（默认：有 `ctx.unit` 则自身，否则 `{sel:'all', side: a.side \|\| 'self'}`）—— «本单位可以在同一回合内移动并攻击»。写 `u.mods.canMoveAndAttack = true` 并压入 `dynMods`；`engine.move` 读这个标记来决定**移动不消耗行动**。**这是「能力」不是「身份」**：绝不要用 `extraTypes:['tank']` 去冒充坦克骗过 `RULES.tankMoveAndAttack`——那会让该单位对所有"针对坦克"的效果也变成坦克 |

`grantMod` 的 mod 取值：`noAttackHQ`（无法攻击总部）`noAttackAir`（无法攻击空军）
`immuneOrder`（**无法被指令指向**：不能被指定为目标，但**仍然会被群体/非指向性指令影响**）
`ignoreOrders`（**无视指令**：完全不受指令影响 —— 既不能被指定，群体指令也打不到）
`immuneUnitEffects` / `ignoreEnemyEffects`（无视敌方单位效果）`noPin`（无法被压制/抑制）`noRetal`（不受到反击伤害）
`pierce`（无视护甲）`ignoreCombatKw`（无视对战词条，等同硬铝弹）`orderDamageDouble`（受到指令伤害翻倍）
`immune`（免疫）`vsType`（对战某类型修正）

### 总部 / 附魔
| op | 参数 |
|---|---|
| `hqEnchant` | `name`, `effects:[...]`（"使友方总部获得：……"持续效果） |
| `hqKeyword` | `keyword`, `value`（如 `immune`） |
| `hqArmor` | `amount` |
| `hqMaxUp` | `amount`（+N 防御力）, `side:'self'\|'enemy'`（"使双方总部获得加N防御力"= 拆成 self + enemy 两条） |

### 流程控制
| op | 参数 |
|---|---|
| `chooseOne` | `prompt`, `options:[{label, actions:[...]}]`（卡面"抉择"） |
| `conditional` | `condition`, `then:[...]`, `else:[...]` |
| `forEach` | `target`(选择器), `as:'t2'`, `actions:[...]` |
| `repeat` | `times`, `actions:[...]` |
| `randomPick` | `options:[{label, actions}]` |
| `setVar` | `name`, `value` |
| `log` | `text`（仅调试用） |

---

## 4. 硬性要求

1. **忠实**：效果以卡面文字为准。卡面写"一点伤害"就是 `1`。卡面文字自相矛盾或明显笔误（如"我烦额外获得3个指挥点槽"）→ 按最合理语义实现，并在 `notes` 里写原句。
2. **不要漏**：一张卡面有多段效果时，写成多个 action，或 `chooseOne`。注意"部署：X。Y。"这种一段触发+一段常驻的，应拆成 `deploy` 效果 + `passive`/光环效果。
3. **纯词条卡**（文本只是词条名，如"闪击 游击"）→ `effects` 写 `[]`（引擎已按 keywords 处理），只填 `notes` 说明。
4. **无法精确实现的**（涉及引擎没有的原语）：用最接近的原语实现 + `"unimplemented": true` + `notes` 写清差距。**不要留空**。
5. `x`/`y`/`z` 变量卡：在 `vars` 里给出可玩的计算方式（例如 `{"count":{"side":"friendly","filter":{"unitType":"space"}}}` 或常数 3），并在 `notes` 写明这是推测。
6. 全部 JSON 必须合法：用
   `node -e "JSON.parse(require('fs').readFileSync('game/data/effects/你的文件.json','utf8'));console.log('ok')"` 自检。
7. 只写你负责的文件，不要动别人的文件。

---

## 5. 范例（照着这个风格写）

卡面：`部署：对一个敌方单位造成2点伤害。`
```json
{"trigger":"deploy","targets":[{"id":"t","side":"enemy","kind":"unit","prompt":"选择一个敌方单位"}],
 "actions":[{"op":"damage","target":"t","amount":2}]}
```

卡面：`使场上所有太空单位获得游击和+2+2`
```json
{"trigger":"order","actions":[
 {"op":"buff","target":{"sel":"all","side":"both","filter":{"unitType":"space"}},"attack":2,"defense":2},
 {"op":"grant","target":{"sel":"all","side":"both","filter":{"unitType":"space"}},"keyword":"guerrilla"}]}
```

卡面：`抉择：将三张星盟通用大驱加入手牌 或者两张奋起反抗`
```json
{"trigger":"order","actions":[{"op":"chooseOne","prompt":"抉择","options":[
 {"label":"三张星盟通用大驱","actions":[{"op":"addCardToHand","name":"星盟通用大驱","count":3}]},
 {"label":"两张奋起反抗","actions":[{"op":"addCardToHand","name":"奋起反抗","count":2}]}]}]}
```

卡面：`部署：若场上有友方步兵，获得-2行动花费`
```json
{"trigger":"deploy",
 "condition":{"op":"controlsType","side":"friendly","unitType":"infantry","cmp":">=","value":1},
 "actions":[{"op":"opCostMod","target":"self","amount":-2}]}
```

卡面：`亡计：随机消灭一个攻击力不大于3的敌方单位`
```json
{"trigger":"death","actions":[{"op":"destroy","target":{"sel":"random","side":"enemy","count":1,"filter":{"maxAttack":3}}}]}
```

卡面：`友方坦克具有+1攻击力`
```json
{"trigger":"passive","aura":{"target":{"sel":"all","side":"friendly","filter":{"unitType":"tank"}},"attack":1}}
```

卡面：`无法攻击总部` / `无法被压制`
```json
{"trigger":"passive","passiveRules":{"noAttackHQ":true}}
{"trigger":"passive","passiveRules":{"noPin":true}}
```

卡面：`本单位受到指令重甲减伤`（语义不明，按"受到指令伤害减半"处理）
```json
{"trigger":"passive","passiveRules":{"orderDamageDouble":true},"notes":"原文不通，按受到指令伤害翻倍实现"}
```

卡面：`造成 20点伤害，平均分配至敌方所有目标`
```json
{"trigger":"order","actions":[{"op":"conditionalRandomSplit","total":20}]}
```

卡面：`如果剩余指挥点不小于4，随机消灭一个敌方单位`（接在其它效果之后）
```json
{"trigger":"order","condition":{"op":"kreditsAtLeast","side":"self","value":4},
 "actions":[{"op":"destroy","target":{"sel":"random","side":"enemy","count":1}}]}
```

卡面：`开发一张花费不小于7的单位，并使其加入战场。回合结束时，将其消灭`
```json
{"trigger":"order","actions":[
 {"op":"discover","filter":{"cardType":"unit","minCost":7},"prompt":"开发一张花费不小于7的单位","thenSummon":true}]}
```
> 若 `discover` 需要"入手后再上场"，写成 `discover` + `notes` 说明由玩家随后打出；把差距写进 `notes`。

卡面：`一回合一次，友方使用指令时，抽一张牌`
```json
{"trigger":"orderPlayed","oncePerTurn":true,"actions":[{"op":"draw","count":1,"side":"self"}]}
```
> `oncePerTurn` 若引擎不支持，写进 `notes` 并标 `unimplemented`。
