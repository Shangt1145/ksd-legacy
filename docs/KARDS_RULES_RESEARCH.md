# Electron 卡牌词条与效果：KARDS 原版差距调研

> 此文及配套 JSON 是修改前的调研快照。用户后来明确的 DIY 保留范围与已实施修复，以 [KARDS_ALIGNMENT.md](KARDS_ALIGNMENT.md) 为准。

调研日期：2026-10-02。对象是当前 Electron 使用的 `H:/Working Folder/Kards-Desktop/dist/win-unpacked/resources/app/game`。本轮只新增报告和内存探针，没有修改引擎、卡池、存档或 Kotlin。

结论：通用效果动作已有较广覆盖，主要差距是**同名词条的规则分叉、触发时点与状态生命周期**。还发现了不依赖原版定义就能成立的实现问题：抑制后亡计仍生效，免疫单位发出成功事件，条件不满足时提前消耗次数限制。这些应优先于全面改写 DIY 词条。

## 范围和证据强度

- 原版证据优先使用 KARDS 官网、官方帮助中心，以及开发者发布的 Steam 公告。参考 2025—2026 年规则说明；动员等历史词条单独注明来源年代。没有原版客户端实测，不能证明所有边界结算顺序。
- 本地盘点读取发行目录的 `cards.js` 和 `effects-data.js`，按界面使用的浅合并方式组成默认卡池。共有 **315 条卡牌定义**，其中 **7 条 referenceCard**、**255 条含效果定义**；效果动作使用 **61 种 op**，此次结构扫描未发现未注册动作。这不等于 61 种动作都符合原版。
- 用户手工编辑、本地自定义卡和联机主机覆盖具有更高优先级，本次没有读取或改动这些运行时数据。315 是发行文件的默认定义数，不能当作用户当前界面卡池总数。
- [探针脚本](<H:/Working Folder/Kards-Desktop/tools/dsl/probe-kards-rule-gaps.js>)在 Node 内存中加载同一套发行引擎，使用合成卡构造 **17 组场景**。结果和引擎 SHA-256 在 [JSON 快照](<H:/Working Folder/Kards-Desktop/docs/KARDS_RULES_PROBE.json>)中。记录的是当前行为，不以“全部通过”表示原版兼容。

运行方式：在项目目录执行 `node tools/dsl/probe-kards-rule-gaps.js`。需要机器可读输出时加 `--json`。探针不会连接正在运行的对局，也不会写游戏数据。

## 优先修复的实现问题

| 项目 | 已复现的当前行为 | 影响与建议 |
| --- | --- | --- |
| **P1 抑制未关闭卡面亡计** | 合成单位的亡计为“敌方总部受 1 伤害”；抑制后 `silenced=true`，再消灭它，敌方总部仍从 20 变为 19。 | `runTrigger` 跳过被抑制单位，但 `killUnit` 直接执行 `def.effects` 中的 death，未检查 `silenced`。应统一卡面能力的失效判定，并明确后续新授予能力与旧能力的区别。 |
| **P1 免疫单位仍派发成功事件** | `noSuppress` 单位未被抑制，却派发 `friendlySuppressed`；`noPin` 单位未被压制，却派发 `friendlyPinned`。 | 两个动作先派发事件，后判断免疫。监听单位可能凭空抽牌、伤害或增益。应在实际成功改变状态后派发事件。是否允许重复压制等另外定义。 |
| **P1 条件失败也耗掉次数限制** | 同一效果先以条件 false 执行，再改为 true；`once` 和 `oncePerTurn` 两种情况下都没有造成预期伤害，总部保持 20，但次数标记已写入。 | `FX.exec` 先记次数，再计算 condition。应区分“事件出现”和“效果满足条件并生效”，避免一次无效事件锁死后续效果。 |
| **P2 回手牌丢失公开信息** | 战场单位撤退回手牌后，新手牌实例 `revealed=false`。 | 官方情报规则明确：从战场撤退回手牌的卡保持公开。应恢复已知信息状态，联机显示也使用同一状态。 |
| **P2 压制状态过早消失** | 拥有者下回合开始后 `pinnedTurns=0`、pin 词条消失，但 `canAct=false`，仍不能行动。 | 行动限制部分相近，但“已被压制”的条件和解除事件在整回合内会读错。原版规则是在拥有者下回合结束解除。应把行动限制与压制状态的期限统一。 |

原版抑制会使单位失去词条和能力，回手牌后解除；上述亡计行为与这一基础定义冲突，也与本项目“一次清除自身效果”的规则冲突。[官方 Winter War 说明](https://decks.kards.com/news/winter-is-here-winter-war-has-arrived-in-kards)

回手牌后的可见性来自 [官方 Intel 帮助](https://support.kards.com/hc/en-us/articles/27798653639321-Unit-ability-Intel)。压制期限来自开发者 [2020-09-01 规则更新](https://store.steampowered.com/news/posts/?appids=544810&enddate=1599583875&feed=steam_community_announcements)；这是明确的历史规则公告，本次未找到后续变更公告，最新客户端边界仍可补验。

代码入口：[engine.js](<H:/Working Folder/Kards-Desktop/dist/win-unpacked/resources/app/game/js/engine.js:1200>) 的 `killUnit`、`beginTurn`、`runTrigger`；[effects.js](<H:/Working Folder/Kards-Desktop/dist/win-unpacked/resources/app/game/js/effects.js:1016>) 的 `OPS.pin`、`OPS.silence`、`OPS.returnToHand` 和 `FX.exec`。

## 同名词条与原版的明显分叉

下表列的是规则差距，不把已有的 DIY 定义自动归为 bug。部分机制在发行默认卡面没有直接使用，但引擎和制卡 DSL 已提供，因此也纳入调研。

| 词条或机制 | 原版定义与来源 | 当前 Electron 行为 | 判定 |
| --- | --- | --- | --- |
| **动员 Mobilize** | 历史定义：己方回合开始 +1/+1；实际受伤后失去动员，保留此前增益。[官方 Allegiance 说明](https://www.kards.com/fr/kards-allegiance) | 作为“移动到前线”的触发名使用；测试回合开始没有成长，受伤后仍有词条。默认卡面标记 2 条：鲨鱼师、第38轻装甲旅。 | 同名异义。应将移动事件与历史 Mobilize 拆开命名。动员在后续卡牌重做中已有变化，不要求把历史机制强塞进当前标准卡池。 |
| **山地 Alpine** | 部署或加入时，每个**其他**友方山地提供 +1/+1。[官方 Allegiance 说明](https://www.kards.com/fr/kards-allegiance)；2025 公告还修复过转换成山地时漏增益的问题。[官方修复记录](https://decks.kards.com/news/august-2025-update-patch-notes) | 打出路径把自身也算入；合成 1/1 的前两张变成 2/2、3/3。随后 summon 加入的第三张仍为 1/1。 | 自身计数是已有 DIY 定义；加入路径不统一是另一个独立问题。对齐原版时应让不同入场路径共享一次山地结算，同时避免重复加成。 |
| **打捞 Salvage** | 己方回合消灭敌方单位，获得该敌方单位的 1/1 副本，费用最多 3。[官方 Winter War 定义](https://decks.kards.com/news/winter-is-here-winter-war-has-arrived-in-kards) | 带 salvage 的合成单位击杀敌人后不生成卡；`OPS.salvage` 则随机取回己方弃牌。测试取回的是原 7 费 4/5 定义，非削弱副本。 | 完全不同的效果。建议保留弃牌取回动作，另行实现原版 Salvage，避免改动后原 DIY 卡失效。 |
| **流亡 Exile** | 官方卡牌以波兰/英国、波兰/美国等流亡身份与组合机制出现，例如 HURRICANE PL 和 M4 SHERMAN PL。[官方 Legions: Uprising](https://www.kards.com/news/kards-legions-uprising-is-live)、[官方双国身份示例](https://www.kards.com/ja/news/behind_enemy_lines) | 单位死亡或指令使用后进 `removed`，不进弃牌；测试销毁合成卡后 discard 为空、removed 含该卡。默认卡面标记 8 条。 | 将 KARDS 身份机制与“移出游戏”混用了。此次未取得完整官方流亡构筑计数细则，不据此臆造双国构筑算法。可以先将当前效果改用明确的 DIY 名称。 |
| **隐蔽／Covert** | 卡背入场；不受指令、反制和单位能力影响；隐蔽时操作费 1；攻击或被攻击时揭露。[官方 Covert Operations](https://www.kards.com/news/unveiling-covert-operations) | `conceal` 主要屏蔽指令；合成测试仍受单位效果伤害，操作费仍是印刷的 3，自身完成一次攻击后仍保持 conceal。代码只显式处理被攻击的一方。 | 有明确语义缺项，也有项目自己的较窄定义。若对齐原版，需同时处理费用、所有效果入口、双方揭露、揭露触发和隐蔽时长，而不是只加卡背视觉。 |
| **预报 Forecast** | 选择蓝天／薄雾／狂风三类之一，再从该类随机展示的 3 张天气中选 1；在己方下回合开始加入手牌。[2026 官方澳新风暴说明](https://decks.kards.com/pt/news/oceania-storm-overview-and-patch-notes) | 在蓝天、薄雾、狂风、落雪四个引子中随机选一，立即加入手牌；测试立即得到狂风，未排队下回合效果。引子再走项目自己的天气附加牌流程。 | 四类天气、即时引子属于既有 DIY 方案，与原版的两次选择及延迟到账不同。原版预报应该有单独入口，不直接替换现有天气系统。 |
| **随机战斗词条** | 官方限定 7 种：伏击、闪击、狂怒、守护、重甲、震慑、烟幕。[官方 Homefront 定义](https://www.kards.com/news/homefront-combat-keywords) | 两处随机池含 11 种；加入轻甲、磁性、游击、护盾、海绵等自定义词条，漏掉守护。覆盖 11 个随机区间的内存探针确认这一池。 | 类别集合不一致。官方池与 DIY 扩展池应分别定义，由效果显式选择。 |
| **“第一次”效果** | 2025 官方澄清：条件第一次达成即算第一次，即使能力来源当时尚未在场；7TP 示例明确体现这一点。[官方 August 2025 澄清](https://decks.kards.com/news/august-2025-update-patch-notes) | `onceFlags` 是单位自身的首次执行标记。合成测试先出现一次事件，再让 once 监听单位入场，第二次事件仍触发。`nthTime` 的全局计数也只在该动作被执行时增长。 | 不能把“一局一次”“本单位第一次”“本回合第一次”“全局条件第一次”合成一个 once。这里的合成事件验证引擎模型，未宣称已逐张复现原版 7TP。 |

Covert 的“隐秘／隐蔽”、Guard 的“守护／固守”、Shock 的“震慑／冲击”可能只是翻译或 DIY 用词不同。应以实际行为判断；不要因为中文名字不同就重复创建机制。

## 大方向相近的机制

以下是代码审阅得到的基础行为相近项，尚未验证所有组合边界。

| 机制 | 当前已经具备的行为 | 还需重点验证的边界 |
| --- | --- | --- |
| 闪击 | 部署回合即可行动。 | 各种“加入战场”路径、转换、返场和行动次数继承。 |
| 狂怒／奋战 | 单位内统一成 fury，允许两次攻击。 | 与坦克先移动再攻击、压制、额外行动修正组合。官方专门的 Fury 帮助优先于官网较旧的“操作两次”概述。 |
| 伏击 | 防守时先造成伤害，击杀攻击者可避免伤害。 | Shock、Fight、同回合再次受攻击、重新授予伏击。 |
| 守护 | 使用同线相邻保护，炮兵／轰炸机可绕过；额外兵种有自定义规则。 | 总部位置、双方守护邻接、改变阵线后更新保护。词条短说明仍像“保护整条线”，应与相邻规则一致。 |
| 烟幕 | 阻止单位攻击；移动／攻击后解除；指令仍可指定。 | 烟幕与守护、前线及各类效果的组合。 |
| 重甲 | 战斗伤害减免、普通指令不减免。 | 新文案“单位伤害”是否还包含特定单位能力；不要根据一句概述扩大作用域，需原版客户端场景补验。 |
| Shock／impact | 首次攻击免受反击，之后消耗。 | 与伏击先手伤害、Fight 及复制／升级的状态重置。 |
| Develop／研发 | 有随机候选与玩家选择动作。 | 与 Discover、从卡组取牌、复制、按名称加入之间的区别；选择后的来源区域是否保留。 |
| 反制措施 | 纯反制保留在手牌，支持挂起、触发消费、取消退款。 | 下一敌方回合有效期、费用对敌方保密、多张同触发反制顺序，以及隐蔽目标的完整免疫。 |

基础参照：[官方战斗词条](https://www.kards.com/news/homefront-combat-keywords)、[Fury 帮助](https://support.kards.com/hc/en-us/articles/360026228852-Unit-ability-Fury)、[Guard 帮助](https://support.kards.com/hc/en-us/articles/360026238532-Unit-ability-Guard)、[烟幕帮助](https://support.kards.com/hc/en-us/articles/360026341232-Unit-ability-Smokescreen)、[反制帮助](https://support.kards.com/hc/en-us/articles/360026404872-Countermeasure)。Develop 与 Covert 共用上述官方扩展说明。

## 还需补证的效果结算差距

1. **打出、部署、加入、召唤、转换不是同一个事件。** 当前 summon 明确执行被加入单位自身的 deploy 效果，并广播 unitDeployed。合成测试通过“加入战场”生成一个部署伤害单位，敌方总部 20→19。源码注明这来自此前 DIY 要求；不能直接覆盖。原版各入口是否触发自身部署、其他单位的部署监听和加入监听，需要逐项用官方卡牌场景对照，当前列为待补证。
2. **Fight 与 Attack 应独立。** 当前最终生效的 `OPS.fight` 简化为两次伤害，不走普通攻击流程，而且只有 self.attack>0 才让 self 受到对手伤害。合成 0 攻对 2 攻时双方防御都保持 5，这是高度可疑的单向条件。原版官方确认 Fight 可来自部署、指令或能力，但本次没有完整的零攻、同时死亡、伏击／重甲／Shock 生效范围规范；保留为实现审查项，而非编造原版结算顺序。[官方 Fight 介绍](https://www.kards.com/news/blood-iron-shock)
3. **老兵与转换的重置矩阵。** 当前老兵生成新的单位实例，重置行动资格和多种状态；还应对照费用、永久增益、伤害、临时词条、已行动次数、压制、抑制、控制权。官方 2026 年仍修复过老兵重置永久重甲的问题，可见这里不是“换图片和身材”这么简单。[官方 2026 January 说明](https://www.kards.com/news/january-2026-update-patch-notes)
4. **异步事件顺序。** beginTurn、damage、killUnit 中有不等待的 runTrigger／execEffects 调用。复杂的“死亡→抽牌→造成伤害→继续死亡”可能交错。当前探针通过清空微任务等待观察最终状态，未证明真实 UI 或联机中的顺序完全正确。后续需要定义统一事件队列并选择少量有价值的连锁场景验证。
5. **临时效果期限。** “本回合”“下回合”“下次己方回合开始”“直到下回合结束”需要分别表达，不能仅靠 state.turn+2 或一个 pinnedTurns 计数。压制已经展示了状态与行动资格不同步的实际后果。
6. **抑制后的新授予能力。** 旧 printed 能力、旧额外能力、后来授予能力和持续光环应分开存储。当前清空增益后持续光环可重新生效，是项目的既有规则；此次没有充分官方资料说明所有光环边界。不要把这部分当成已证实的原版 bug。

## 基础规则也会改变卡牌体验

| 项目 | 官方基础规则 | 当前默认值 | 影响 |
| --- | --- | --- | --- |
| 手牌上限 | 9 | 10 | 爆牌与手牌数量条件的触发不同。 |
| 支援线容量 | 总部 + 4 个单位 | `supportMax=6`，总部另算 | 召唤、守护和铺场强度显著变化。 |
| 指挥点自然增长上限 | 12，卡牌可额外提高 | 20；效果硬上限 36 | 高费卡与后期持续操作节奏不同。 |
| 同卡张数 | 标准／限定／特殊／精英分别最多 4／3／2／1 张 | `maxCopies=2` 的默认 DIY 规则 | 构筑稳定性不同；需结合项目构筑校验核对实际限制。 |
| 先手首次抽牌 | 常见原版基础规则为首回合不抽；本次未取得最新官方精确说明 | `drawOnFirstTurn=true` | 仅记录本地默认差异候选，暂不当作已核验的当前原版差距。 |

手牌来源：[官方 Hands 帮助](https://support.kards.com/hc/en-us/articles/360026500332-Battlefield-elements-Hands)。支援线与指挥点来源：[官方 How to Play](https://www.kards.com/how-to-play)、[Support Line 帮助](https://support.kards.com/hc/en-us/articles/360026757171-Battlefield-elements-The-Support-Line)。稀有度张数来源：[官方 Cards 帮助](https://support.kards.com/hc/en-us/articles/360026768151-Cards)。不能把本项目常量简单视为必须改掉的 bug。

官方撤退也有前线退支援、支援退手牌的语境；此次未发现足够证据证明项目这种区域相关撤退本身是错误。已证实的问题是回手后没有公开状态，二者应分开处理。

## 建议的落地顺序

1. **先修实现问题**：抑制亡计、免疫成功事件、条件前消费次数、回手公开状态。针对每项保存一组有意义的回归场景。压制期限纳入官方兼容定义，先明确模式差异。
2. **明确两套规则名字和来源**：已有 DIY 山地、天气、流亡、动员、太空兵种等保留为扩展机制；原版语义使用独立字段或显式规则模式。卡牌编辑器显示该机制的真实说明。
3. **统一事件与状态模型**：优先拆开 play/deploy/add/convert、attack/fight、first/once/oncePerTurn；定义原子动作成功时才派发事件，并保留事件所属回合、玩家、来源和目标。
4. **再补原版专用机制**：Covert 全套状态、7 种官方战斗词条池、Salvage 削弱副本、Forecast 两阶段选择和下一回合入手。卡池仍可完全是 DIY，不需要照搬原版卡牌数值。
5. **最后对齐展现**：词条提示、合法目标、状态剩余期限、伤害顺序、亡计动画及公开卡牌标记，都依据同一份规则数据。视觉调优才不会掩盖规则不一致。

本轮没有执行上述修复；现有授权步骤是调研。下一步可以从第一批实现问题开始，保留已明确的 DIY 规则。

后续补充：[战斗规则专项调研](<H:/Working Folder/Kards-Desktop/docs/KARDS_COMBAT_RESEARCH.md>)，包含攻击范围、兵种互伤、守护与行动、伤害事件和连锁时序的 93 个检查场景。
