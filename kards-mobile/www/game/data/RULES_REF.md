# KARDS 对战规则与词条语义权威参考

> 目的：为 KARDS 风格引擎（本仓库 `game/`）提供**可执行**的规则描述。每条结论一行，附**可信度**与**来源 URL**。
> 本文只描述规则，不含营销内容。

## 0. 使用约定

**可信度分级**

| 级别 | 含义 |
|---|---|
| `confirmed` | ≥2 个互相独立的来源一致，或来源为官方新手教程原文转述，且与其它来源无冲突 |
| `likely` | 单一高质量来源（含社区 wiki / 官方教程转述）明确记载，或由多条记载共同推出，但缺少第二独立来源 |
| `unverified` | 未找到权威说法，或仅有单一过时/低质量来源；**不要**据此实现关键逻辑 |

**本次检索的环境限制（影响证据强度，请务必知晓）**

- 这些域名在本环境**无法直连**：`kards.fandom.com`（英/中文 wiki，含 Keywords / 词条 / 交战线 页）、`www.kards.com`（官网 how-to-play）、`kards-v2.vercel.app`（官网镜像，含官方文章《Homefront: Combat Keywords》）、`store.steampowered.com` / `steamcommunity.com`（Steam 公告与指南）、`web.archive.org`（快照）、`en.wikipedia.org` / `zh.wikipedia.org`。
- 因此官方英文词条原文（例如 Homefront 版本《Combat Keywords》一文）**未能逐字获取**；英文关键词的权威原文属于「未直接取得」。
- 本文实际取证的来源（均可直连、已抓取正文）：biligame KARDS wiki（中文社区 wiki，首页词条表 2025-12 更新 / 游戏知识页含 2026 年编辑记录）、一个完整转载了**官方游戏内新手教程中文文本**的第三方页面、namu wiki 快照（`readonly.wiki`，覆盖 2021 前后版本，部分条目已过时）、Level Winner 新手攻略（2023）、机核专栏（2020）、网易号专栏（2020）、ACGO 社区规则帖（2025-12）、WARDS 卡牌资料站（卡面字段与词条筛选表）。
- **版本差异警告**：KARDS 在 2023（Homefront）与 2024（Territory 等）有多次规则/词条改动。凡旧来源（2020–2021）与 2025 来源冲突，本文以 2025 来源为准并标注。

---

## A. 基础框架

### 1. 总部 / 牌库 / 同名上限 / 先手后手

- **1.1 总部初始防御力（HP）**：双方总部开局各 **20** 点防御力，可被治疗并**超过 20**；把对方总部降到 0 或以下即获胜。— **可信度：confirmed** · 来源：[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)、[ACGO 规则帖](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)、[机核](https://www.gcores.com/articles/119041)
- **1.2 牌库张数**：构筑卡组固定 **40 张**，其中**恰好 1 张总部 + 39 张单位/指令**（总部不算在 39 张可用卡内）。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)
- **1.3 同名卡上限（按稀有度）**：普通 4 张 / 限定 3 张 / 特殊 2 张 / 精英 1 张；同名金卡与普通卡**合并计数**（普通 4 + 金卡 1 不能凑成 5）。— **可信度：confirmed** · 来源：[namu 快照](https://readonly.wiki/w/KARDS)、[机核](https://www.gcores.com/articles/119041)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **1.4 盟国（副国）配额**：副国卡最多 **12 张**，且**副国精英卡不可用**；40 张中其余为主要国家卡。— **可信度：likely** · 来源：[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)、[机核](https://www.gcores.com/articles/119041)
- **1.5 起手与重调度**：先手 **4** 张、后手 **5** 张起手；双方各有**一次**重调度（mulligan）机会，可替换**任意张数**，替换不损失手牌数。— **可信度：likely** · 来源：[Level Winner](https://www.levelwinner.com/kards-the-ww2-card-game-beginners-guide-tips-tricks-strategies/)、[namu 快照](https://readonly.wiki/w/KARDS)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **1.6 先手不抽首牌**：**先手玩家的第一回合不抽牌**；此后（含后手玩家的第一回合）每人每回合开始时抽 1 张。— **可信度：likely** · 来源：[Level Winner](https://www.levelwinner.com/kards-the-ww2-card-game-beginners-guide-tips-tricks-strategies/)、[namu 快照](https://readonly.wiki/w/KARDS)
- **1.7 后手补偿的精确内容**：可确认的补偿只有「起手多 1 张」，**是否还存在额外补偿（额外指挥点/额外抽牌/特殊标记）未证实**，未找到权威说明。— **可信度：unverified** · 来源：（无；请勿在引擎里假定后手有额外资源）
- **1.8 手牌上限**：手牌上限 **9** 张，超出上限的抽牌**直接销毁且不触发任何效果**（旧 namu 快照写 10，属过时数据）。— **可信度：likely** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)

### 2. 克雷迪特（Kredit / 指挥点）成长曲线

- **2.1 成长曲线**：每名玩家在每个**自己的回合开始时获得 +1 指挥点槽**，自然上限 **12**。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)、[Level Winner](https://www.levelwinner.com/kards-the-ww2-card-game-beginners-guide-tips-tricks-strategies/)
- **2.2 上限可被卡牌突破**：卡牌效果可继续增加指挥点槽，**硬上限 24**（12 是「自然」上限而非绝对上限）。— **可信度：likely** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[机核](https://www.gcores.com/articles/119041)
- **2.3 每回合充满、不累积**：回合开始时当前指挥点**回满至当前槽数**；**回合结束时未用完的指挥点不保留**（不存在跨回合存费）。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[Level Winner](https://www.levelwinner.com/kards-the-ww2-card-game-beginners-guide-tips-tricks-strategies/)、[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)
- **2.4 第 1 回合只有 1 点**：因此先手第 1 回合只能打出 0–1 费牌。— **可信度：likely** · 来源：[Level Winner](https://www.levelwinner.com/kards-the-ww2-card-game-beginners-guide-tips-tricks-strategies/)（「每回合 +1 直到 12」+「无法在第 1 回合打出最强的牌」的直接推论）

> 引擎注记：指挥点 = 每回合刷新的资源（类似法力），**不是**炉石的「水晶槽 + 未用尽累积」。付费点有两类：**部署花费**（从手牌打出）与**行动花费**（在场单位移动/攻击），见第 10 节。

### 3. 疲劳 / 抽空牌库的惩罚

- **3.1 抽空牌库 → 总部承受递增伤害**：当需要抽牌而牌库已空时，改为对**该玩家总部**造成伤害，且**第 1 次 1 点、第 2 次 2 点、第 3 次 3 点**……逐次 +1（旧来源只说「受到伤害」，未写递增）。— **可信度：likely** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)（「第一次抽牌受到 1 点伤害，第二次受到 2 点伤害，以此类推」）、[biligame 首页](https://wiki.biligame.com/kards/首页)（词条「士气伤害：从 1 开始递增 1（1,2,3,4...）」）
- **3.2 抽空不判负**：牌库抽空**不会立即判负**，惩罚以总部掉血的形式结算，因此疲劳可以被治疗拉回来。— **可信度：likely** · 来源：[namu 快照](https://readonly.wiki/w/KARDS)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **3.3 「士气伤害」是同一个计数器的词条名**：游戏内的空牌库惩罚与「协力」等卡牌效果共用 **morale damage** 这一词条，计数从 1 起逐次 +1。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)

---

## B. 前线机制（最重要）

### 3.9 兵种术语：什么叫「地面单位」

**「地面单位」= 非太空单位。** 这是卡面用词，不是"陆军（步兵/坦克/火炮）"的同义词。— **可信度：confirmed** · 来源：制作者 Alan 定稿（2026-09-16）

- **3.9.1 太空系（判定的补集）**：`landcruiser`（巡地舰）、`cruiser`（巡航舰）、`spacefighter`（太空战机）。引擎里这三类构成 `TYPE_ALIAS.space` 族，卡面写「太空单位」按此族判定。
- **3.9.2 地面系（其余全部）**：`infantry` / `tank` / `artillery` / `fighter` / `bomber` / `structure`，以及任何未归类（`unknown`）单位。**战斗机与轰炸机也算地面单位**（它们不是太空系）。
- **3.9.3 与「陆军」的区别**：`陆军` = `infantry + tank + artillery`（不含空军与工事）；`地面单位` 比它更宽。卡面若写「对陆军…」用陆军族，若写「对地面单位…」用非太空。
- **3.9.4 引擎实现**：`KG.isType(u, 'nonspace')` 是**否定判定**（不是枚举数组）；编译器词表把「地面单位 / 地面」映射到 `'nonspace'`（primitives.js 的 `UNIT_TYPES`），引擎在 `TYPE_ALIAS` 之外单独处理它，这样将来新增兵种时"地面"自动覆盖、不会漏项。
- **3.9.5 踩过的坑**：「地面」两个字曾不在编译器词表里，`vsTypeFromText` 返回 `null` 后下游兜底成 `infantry`，导致 UNTED-LPD-7 的「对地面单位造成的伤害+4」只对步兵生效。排查这类"加成数值不对/只在部分目标上生效"的问题时，先确认族词是否命中。

### 4. 战场分区与容量上限

- **4.1 三条战线**：战场由**双方各自的支援阵线**（总部所在处）+ **中间一条共享前线**组成。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)、[机核](https://www.gcores.com/articles/119041)
- **4.2 支援阵线容量 = 4 个单位（+1 个总部位置 = 5 个位置）**：支援阵线最多容纳 **4 个单位**；官方教程表述为「每条阵线包括总部在内最多 5 张卡牌」。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **4.3 前线容量 = 5 个单位**：前线最多容纳 **5 个单位**。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **4.4 支援阵线不可被侵入**：**玩家不可将单位移动到对方的支援阵线**，敌方地面单位永远无法进入你的支援阵线（只有指令/效果能直接伤害后排）。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **4.5 前线为单方占用（同一时间只有一方占领）**：前线是**一行共享格**，但**同一时间只能由一方占领**；官方教程与社区规则页均写作「同一时间只能有一名玩家控制/占领前线」。— **可信度：likely** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)、[网易号](https://m.163.com/dy/article/FB66PD77052693KJ.html)
  - 残留不确定性：这些来源用词是「占领/控制」，未逐字说明「敌方已有单位时能否把单位移进前线」。**引擎建议**：把「前线占用方」实现为单值枚举（none/playerA/playerB），并允许在占用方为本方或空置时移入；夺取前线必须先在前线清空敌方单位。若后续拿到官方英文原文，应优先复核这一条。
  - 与旧版一致性：旧 namu 快照同样写「双方的部队不能走进对手的基地区，前线区同时也只能被一方所占据」。

### 5. 单位部署到哪个区 / 攻击敌方总部的条件（前线控制的精确定义）

- **5.1 部署位置**：**单位只能部署到己方支援阵线**，不能直接部署到前线（不能「空降」占线）。— **可信度：confirmed** · 来源：[机核](https://www.gcores.com/articles/119041)、[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **5.2 地面单位攻击总部的条件**：**步兵与坦克必须先移动到前线**，才能攻击「敌方支援阵线上的敌方总部与敌方单位」。— **可信度：confirmed** · 来源：[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[机核](https://www.gcores.com/articles/119041)
- **5.3 前线控制权的可执行定义**：**你控制前线 ⇔ 前线格上有你至少 1 个单位**（由 4.5 的单方占用推得：此时敌方前线为空）。反之，敌方前线有单位时你不控制前线，你的地面单位无法攻击敌方总部。— **可信度：likely** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **5.4 火炮/空军不需要前线即可打脸**：**火炮、战斗机、轰炸机不需要进入前线**，可从己方支援阵线直接攻击敌方支援阵线内的单位**与敌方总部**。— **可信度：confirmed** · 来源：[机核](https://www.gcores.com/articles/119041)（「空中单位可以越过前线直击敌方 HQ」）、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 炮兵卡表](https://readonly.wiki/w/KARDS/포병)（存在「无法攻击敌方 HQ」的限制卡，反证默认可打 HQ）
- **5.5 总部不是单位**：总部没有攻击力、不能被指定为「单位目标」的效果目标，也不参与反击；它只承受伤害/被治疗，且位于其拥有者的支援阵线。— **可信度：likely** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[Level Winner](https://www.levelwinner.com/kards-the-ww2-card-game-beginners-guide-tips-tricks-strategies/)

### 6. 攻击的合法目标范围

- **6.1 步兵 / 坦克只能打「相邻战线」**：位于**己方支援阵线**时只能攻击**前线**上的敌人；位于**前线**时可以攻击**敌方支援阵线**的单位与总部。=> **支援阵线里的步兵/坦克不能直接攻击敌方支援阵线的单位**。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)（「步兵只能攻击相邻战线中的敌人」「坦克……只能攻击相邻战线中的敌人」）、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[机核](https://www.gcores.com/articles/119041)
- **6.2 火炮 / 轰炸机可打任意战线，并无视「被守护」**；但**轰炸机**若目标战线内有敌方**战斗机**，则**只能以该战斗机为目标**（且此时会受到反击）。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 轰炸机](https://readonly.wiki/w/KARDS/폭격기)
- **6.3 战斗机可打任意战线，但受「被守护」限制**（战斗机**不能**越过固守去打被守护目标，只能打固守单位本身）。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)（「和炮兵一样，尽管他们会受到守护效果的影响，但战斗机依旧可以攻击战场上不相邻战线中的敌方单位」）
- **6.4 「支援线单位能否攻击敌方支援线单位」**：**火炮/战斗机/轰炸机可以，步兵/坦克不可以**（后者必须先进前线）。— **可信度：confirmed** · 来源：[机核](https://www.gcores.com/articles/119041)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **6.5 「能否攻击前线单位」**：**任何单位类型都可以攻击前线单位**——对地面单位而言前线就是其唯一可达战线；对空/炮而言前线属于任意可达战线。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **6.6 固守如何改变目标合法性**：与固守单位**相邻**的非固守单位（含相邻的总部位置）获得「被守护」，**只能被火炮与轰炸机攻击**；**固守单位自身仍然可以被普通单位攻击**，且固守单位不能被「被守护」保护。— **可信度：confirmed** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[namu 快照](https://readonly.wiki/w/KARDS)

**引擎：一次攻击的目标合法性判定顺序（建议实现顺序）**

1. 攻击方是否支付得起**行动花费**（不足 → 非法）。
2. 攻击方当回合是否已行动过（已移动的地面单位不能再攻击；已攻击的不能再攻击，除非**奋战**允许第 2 次；**坦克**允许「移动 + 攻击」各一次）。
3. 攻击方当回合是否仍受**部署失调**限制（本回合刚部署且无**闪击** → 非法）。
4. 由攻击方类型算出**可达战线集合**：步兵/坦克 = 相邻战线；火炮/轰炸机/战斗机 = 任意战线。
5. 目标自身是否处于**烟幕**（不可被敌方单位攻击 → 非法）。
6. 目标是否处于**被守护**，且攻击方不是火炮/轰炸机（→ 非法）。
7. 轰炸机特例：若目标所在战线上有敌方**战斗机**，则只能选该战斗机。
8. 目标处于**免疫**时：可以成为目标但不能受到伤害（建议实现为「结算时伤害归零」）。
9. 目标为敌方总部：仅当地面单位位于前线，或攻击方为火炮/战斗机/轰炸机时才合法。

### 7. 移动

- **7.1 可移动方向**：单位只能在**己方支援阵线 ⇄ 前线**之间机动，且实际上只有**前进（支援阵线 → 前线）**这一种主动移动；**不可主动从前线撤回支援阵线**（撤回只能由效果/【撤退】词条产生）。敌方支援阵线永远不可进入。— **可信度：likely** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)（【撤退】词条专门规定「从前线撤退 → 回到支援阵线」，说明常规移动不含后退）、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **7.2 移动花费**：每次移动都要支付该单位的**行动花费**。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[网易号](https://m.163.com/dy/article/FB66PD77052693KJ.html)、[机核](https://www.gcores.com/articles/119041)
- **7.3 每回合移动次数**：一个单位每回合最多**移动 1 次**（不存在反复横跳）。— **可信度：likely** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)（「步兵每次行动只能在攻击和移动中选一个」）
- **7.4 移动后还能否攻击**：**坦克可以**（同一回合「移动 + 攻击」，顺序不限，但要**付两次行动花费**）；**步兵/火炮/战斗机/轰炸机不可以**（移动或攻击二选一）。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)、[网易号](https://m.163.com/dy/article/FB66PD77052693KJ.html)
- **7.5 部署当回合不能行动**：刚部署的单位当回合**不能移动也不能攻击**（部署失调），除非它有**闪击**。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)、[Level Winner](https://www.levelwinner.com/kards-the-ww2-card-game-beginners-guide-tips-tricks-strategies/)
- **7.6 「移动到前线时」的触发**：存在大量以「该单位移动到前线时……」为条件的卡牌能力，说明**移动本身是一个可触发事件**（引擎应抛出 on_move / on_move_to_frontline 事件）。— **可信度：likely** · 来源：[namu 步兵卡表](https://readonly.wiki/w/KARDS/보병)（例：第 361 阿非利加团「移动到前线时对敌方 HQ 造成 3 点伤害」）、[namu 反制表](https://readonly.wiki/w/KARDS/대응방어)（Missing：敌方单位移动到前线时将其消灭）

---

## C. 战斗结算

### 8. 攻击时双方是否互相造成伤害（含总部）

- **8.1 地面近战为互伤**：单位攻击单位时，**攻方对守方造成等同攻方攻击力的伤害，同时守方对攻方造成等同守方攻击力的伤害**（结算上视为同时；防御力 ≤0 即被消灭）。— **可信度：confirmed** · 来源：[Level Winner](https://www.levelwinner.com/kards-the-ww2-card-game-beginners-guide-tips-tricks-strategies/)（「Combat is simultaneous」）、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)
- **8.2 打总部不反击**：攻击敌方总部时，**总部不造成任何反击伤害**（总部无攻击力），攻方只把攻击力打进总部。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[Level Winner](https://www.levelwinner.com/kards-the-ww2-card-game-beginners-guide-tips-tricks-strategies/)
- **8.3 重甲减免反击与普攻伤害**：「重甲 X」使该单位**被其他单位攻击时**受到的伤害 -X（可叠加，单卡最多 3），**不减免指令（Order）伤害**。— **可信度：confirmed** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)
- **8.4 不受反击的四种例外**：① **炮兵**攻击时不受反击；② **轰炸机**攻击**非战斗机**目标时不受反击；③ 带**冲击**的单位攻击时目标不造成任何反击；④ **伏击**单位把攻方打死时，攻方不造成伤害。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[biligame 首页](https://wiki.biligame.com/kards/首页)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 炮兵](https://readonly.wiki/w/KARDS/포병)

**引擎：一次攻击的结算顺序（建议实现顺序）**

1. 校验并支付攻方**行动花费**；标记攻方本回合已行动。
2. 判定「先手方」：
   1. 攻方有**冲击** → 守方（及其反击）完全被压制（且**冲击优先级高于伏击**，伏击也不触发反击）；本次攻击后移除**冲击**。
   2. 否则若守方有**伏击**且本回合是它第一次被攻击 → **守方先结算反击伤害**；若攻方因此被消灭，则**攻方不造成伤害**，结算结束。
   3. 否则按互伤同时结算。
3. 计算伤害：
   - 对守方：`max(0, 攻方攻击力 − 守方重甲)`（攻击力类增伤/减伤在此步骤并入）。
   - 对攻方（反击）：`max(0, 守方攻击力 − 攻方重甲)`；若守方为**炮兵**，或守方为**轰炸机**且攻方不是战斗机 → 反击为 0。
4. 同时扣除防御力（同一次结算内两边都按结算前的攻击力计算，不因对方先死而改变）。
5. 结算死亡（防御力 ≤0）→ 触发**亡计**、以及「被消灭时/消灭单位后」类效果（注意：**老兵**升级、「收缴」等都在此步骤触发）。
6. 触发攻击后事件（例如「该单位攻击时……」类效果在步骤 1–2 之间或之后按卡面文本执行）。

### 9. 炮兵攻击时是否受到反击伤害

- **9.1 炮兵攻击时不受反击伤害，并可无视「被守护」**。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)（「炮兵在攻击时不会受到反击伤害，且能够无视『被守护』状态」）、[namu 炮兵](https://readonly.wiki/w/KARDS/포병)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[biligame 首页](https://wiki.biligame.com/kards/首页)
- **9.2 炮兵被攻击时是否反击**：旧 namu 快照称「炮兵被攻击时与步兵一样既承受伤害也造成伤害」，但 2025 年的两份来源只描述了**攻击时**不受反击，未复述防守行为；**请勿据此实现**，建议按「炮兵防守时照常反击」并留开关。— **可信度：unverified** · 来源：[namu 炮兵](https://readonly.wiki/w/KARDS/포병)（单一且过时）
- **9.3 炮兵的机动限制**：与步兵一致（一回合只能移动或攻击），且**大多数炮兵没有闪击**，因此常常「部署后要等一回合才能开火」。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[ACGO](https://www.acgo.cn/discuss/rest/62946)

### 10. 空军（战斗机 / 轰炸机）的「行动花费」机制

- **10.1 术语与存在范围**：KARDS 里**每个单位都有「行动花费 / 行动费用」（action cost，英文资料亦称 operation cost）**——即该单位在场时的行动价；中文客户端把它标为「行动费用」。并非只在空军身上。— **可信度：confirmed** · 来源：[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)（「单位的指挥点字段中字体较小的数字为单位的行动花费」）、[WARDS 卡页](https://qwq.wards.mom/card/45_mm_antitank_gun)（卡面字段明确标注「行动费用 1」）、[机核](https://www.gcores.com/articles/119041)
- **10.2 卡面显示位置**：**左上角费用格**内：大数字是**部署花费**，旁边/下方的小数字是**行动花费**；单位一旦部署到场上，该费用格**只显示行动花费**。— **可信度：confirmed** · 来源：[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)、[机核](https://www.gcores.com/articles/119041)（「行动费用会在单位左上角的费用数字下方以小字标注」）
- **10.3 何时支付**：**每次移动或攻击前支付一次**；坦克同回合「移动 + 攻击」要付**两次**。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[机核](https://www.gcores.com/articles/119041)、[网易号](https://m.163.com/dy/article/FB66PD77052693KJ.html)、[namu 快照](https://readonly.wiki/w/KARDS)
- **10.4 不支付能否攻击**：**不能**。行动花费是指挥点支付，付不起就无法移动/攻击（部署花费不足同样无法出牌）。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)
- **10.5 空军的行动花费特征**：战斗机/轰炸机**同样有行动花费且普遍偏高**（轰炸机尤其贵），它们**不需要进入前线**，但每次攻击仍要支付行动花费。— **可信度：likely** · 来源：[网易号](https://m.163.com/dy/article/FB66PD77052693KJ.html)（「轰炸机就是典型的耗油大户」）、[namu 轰炸机卡表](https://readonly.wiki/w/KARDS/폭격기)（卡表统一列「소환코스트 / 행동코스트」＝部署花费/行动花费）、[机核](https://www.gcores.com/articles/119041)（空军行动费略高）
- **10.6 行动花费可被卡牌修改**：存在「使敌方空军单位行动花费 +2」「使本单位本回合行动花费 -1」等效果；引擎需把行动花费做成**可变属性**而非静态字段。— **可信度：confirmed** · 来源：[namu 炮兵卡表](https://readonly.wiki/w/KARDS/포병)（37mm 高射炮）、[namu 步兵卡表](https://readonly.wiki/w/KARDS/보병)（第 144 步兵联队）、[namu 轰炸机](https://readonly.wiki/w/KARDS/폭격기)（A-20 Havoc）
- **10.7 「隐蔽」状态下的行动费为 1**：社区规则帖称隐蔽单位在隐蔽阶段「行动费 1」，未找到官方依据。— **可信度：unverified** · 来源：[ACGO](https://www.acgo.cn/discuss/rest/62946)

### 11. 闪击单位当回合能否「先移动到前线再攻击」

- **11.1 闪击的语义**：**闪击 = 取消部署失调**，单位可以在**加入战场的同一回合行动（移动或攻击）**。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)、[机核](https://www.gcores.com/articles/119041)
- **11.2 闪击 ≠ 坦克的「移动 + 攻击」**：**闪击步兵当回合仍然只能「移动」或「攻击」二选一，不能先移动到前线再攻击**；只有**坦克**（天生允许同回合移动 + 攻击）**加上闪击**时，才能落地当回合「移动 + 攻击」（两次行动花费）。— **可信度：likely** · 来源：[namu 快照](https://readonly.wiki/w/KARDS)脚注（以苏联 BT-7 与德国装甲掷弹兵对比论证「闪击」与「坦克机动」是两件事，坦克 + 闪击才能落地即移动并攻击）、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)
- **11.3 闪击不提供额外攻击次数**：闪击单位当回合攻击 1 次（奋战才有第 2 次），闪击**不叠加**攻击次数。— **可信度：likely** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)

---

## D. 词条逐条语义

> 命名说明：中文客户端把 **Fury** 译作**奋战**（本仓库已转写的卡面文本用「奋战」，同时也见到「狂怒」的译法）；把 **Guard** 译作**固守/守护**；**Pin** 译作**压制/钉住**。英文 id 以本仓库 `SCHEMA.md` 为准。

### 12. 对战词条（单位）

- **12.1 闪击 Blitz**：取消部署失调，入场当回合即可行动（动作种类仍受单位类型限制）。触发时机：持续状态，仅影响其入场的那一个回合。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)
- **12.2 固守 Guard**：**位置型守护**——与固守单位**相邻（左右两侧）**的非固守单位、以及相邻的**总部**获得「被守护」；固守单位**自身不能获得「被守护」**，因此可以被普通单位攻击（要打被守护的目标，先打掉固守单位或用火炮/轰炸机）。— **可信度：confirmed** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[namu 快照](https://readonly.wiki/w/KARDS)
- **12.3 被守护 Guarded**：该目标**只能被火炮与轰炸机攻击**（步兵/坦克/战斗机都不能选它）。持续时长＝产生该状态的固守单位留在场上的期间。— **可信度：confirmed** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)
- **12.4 烟幕 Smokescreen**：该单位**不能被敌方单位攻击**；单位**移动或攻击后立即失去烟幕**；**前线上的单位、固守单位、战斗机不能拥有烟幕**（若单位移动到前线或获得固守，烟幕失效）。失去烟幕**只影响能否被攻击**，与「已行动」互不冲突；烟幕**不阻止指令（Order）指向**（旧来源表述为「不能被攻击」，未提及指令免疫）。— **可信度：confirmed**（「不能被攻击 / 行动后失去 / 三类单位不能有」）· 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[biligame 首页](https://wiki.biligame.com/kards/首页)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)
  - 「烟幕单位能否被指令指定」：**未证实**（来源只说不能被单位攻击）。— **可信度：unverified**
  - **实现状态（2026-09-29）**：**已实现「前线单位」「守护/固守单位」两条禁则** —— `engine.js` 的 `smokeBanned()` / `inSmoke()` / `enforceSmokeBans()`（后者挂在 `recomputeAuras` 末尾），写入侧由 `effects.js` 的 `grantKw` 直接拒发。**「战斗机不能拥有烟幕」制作者明确要求不做**，勿擅自补上。探针：`_audit/probe_smoke.js`（23 项）。
- **12.5 伏击 Ambush**：**每回合第一次被攻击时**，该单位**先结算自己的反击伤害**；若攻方因此被消灭，则**攻方不造成任何伤害**（守方不掉血）；同一回合的第 2 次及以后的攻击不再触发伏击；**冲击优先级高于伏击**（冲击攻击时伏击不反击）。— **可信度：confirmed** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)
- **12.6 动员 Mobilize**：在其**控制者回合开始时 +1/+1**；单位**一旦受到伤害就永久失去动员**（此后不再成长）。触发时机＝回合开始，持续＝直到受伤或离场。— **可信度：confirmed** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)
- **12.7 奋战/狂怒 Fury**：**该单位一回合可以攻击两次**（第 2 次要**再付一次行动花费**）；**不是**「每次攻击 +1 攻击力」，也不是「攻击力翻倍」。持续＝只要该单位具有该词条。— **可信度：confirmed** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)（明确写「一回合可攻击 2 次，但行动花费也要多付」）、[机核](https://www.gcores.com/articles/119041)（「狂怒（每回合可攻击两次）」）
- **12.8 部署 Deployment**：**该单位被部署到战场时触发一次**，结算完再进入正常状态（等同于「战吼」）。— **可信度：confirmed** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)
- **12.9 亡计 Destruction**：**该单位被消灭时触发**（等同于「亡语」）。— **可信度：confirmed** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)
- **12.10 行动 Operation**：**未发现「行动」作为独立词条存在**；文献中只有「行动花费 / 行动费用」（operation / action cost，见第 10 节）。本仓库 `SCHEMA.md` 的 `operation` id 目前没有可核对的官方语义。— **可信度：unverified** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)词条表未收录、[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)只作为费用概念出现
- **12.11 维修 Repair**：对单位或总部生效的**治疗**效果，恢复卡面指定点数，**不能超过其最大生命值/初始上限**。— **可信度：likely** · 来源：[ACGO](https://www.acgo.cn/discuss/rest/62946)（「修复：……生命值恢复后不会超过单位或总部的初始最大生命值上限」）
- **12.12 打捞 Salvage**：**未证实**——在可访问的全部来源（biligame 词条表、社区规则帖、namu 快照、官方教程转述）中都没有该词条定义；只有第三方卡牌资料站的筛选标签里出现「回收」，无法确认其与 Salvage 的对应关系及效果。**引擎请勿实现为已确认语义。** — **可信度：unverified** · 来源：[WARDS 图鉴筛选表](https://qwq.wards.mom/collection.html)（仅出现「回收」标签，无定义）
- **12.13 情报 Intel X**：使用后**查看/明牌对手手牌中的 X 张牌**（X 为后缀数字，单卡最多 3）。触发时机＝卡牌结算时；结果持续到这些手牌离开手牌区。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **12.14 揭示 Reveal / 明牌**：**隐蔽单位在攻击或被攻击时被「揭示」**（翻正面、触发揭示效果）；**明牌**指因情报等效果已向对手展示的手牌，可被「若敌方手中具有明牌……」类效果引用。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **12.15 压制 / 钉住 Pin**：被压制的单位**不能移动或攻击**；状态在**其拥有者的下一个回合结束时解除**（即至少损失一个完整回合的行动机会）。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[biligame 首页](https://wiki.biligame.com/kards/首页)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)
- **12.16 老兵 Veteran**：满足卡面写明的条件后，该单位**升级为老兵形态**，并**重置攻击力与防御力**（换成老兵版本的数值/能力）。触发时机＝卡面条件达成时（例：「本单位消灭一个敌方单位后，升为老兵」「友方部署一辆 Mk 坦克后，升为老兵」）。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)（「达到一定条件后会升为老兵，会重置攻击力和防御力」）、本仓库卡面转写 `game/data/_texts.txt`（「本单位消灭一个敌方单位后，升为老兵」等条件句式）、[fandom「老兵卡牌」分类页](https://kards.fandom.com/zh/wiki/Category:老兵卡牌)（仅搜索结果可见，正文未能直连，佐证该词条存在）
- **12.17 重甲 / 装甲 Heavy Armor X**：**被其他单位攻击时受到的伤害 -X**；X 可叠加、**单卡最多 3**；**不减免指令（Order）造成的伤害**。— **可信度：confirmed** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)
- **12.18 冲击 Shock**：该单位**攻击时，被攻击单位不造成任何反击伤害**；**攻击后移除冲击**（一次性）；**优先级高于伏击**（伏击单位也不会反击）。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[biligame 首页](https://wiki.biligame.com/kards/首页)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **12.19 流亡 Exile**：流亡卡可以加入**其家乡国家**或**其流亡所属国家**的卡组（典型如波兰流亡卡）。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **12.20 抉择 Choose One**：卡面以「**抉择：**」前缀列出若干互斥选项，使用时**选其一结算**（本仓库已转写卡面普遍是这种「抉择：A，或 B」的指令写法）。外部**未找到**权威词条定义，请按「模式化指令」处理并保留扩展位。— **可信度：unverified**（外部无权威来源）· 来源：[biligame 首页词条表](https://wiki.biligame.com/kards/首页)（**未收录**该词条）、本仓库卡面转写 `game/data/_texts.txt`（「抉择：」作为指令卡文本前缀大量出现）
- **12.21 隐蔽 Hidden**：单位**部署时以卡背朝上**，对手不知道是哪张牌，且**不受指令影响**；**移动不会失去隐蔽**；**攻击或被攻击时被揭示**并触发揭示效果。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **12.22 钳击 Pincer**：部署该单位时**选择另一个友方单位**组成钳击；**两者同时在场**时都获得钳击加成；**其中一个离场，另一个立即失去**该加成。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **12.23 控制 Control**：控制权转移给新玩家，新控制者可自由指挥；**原所有者不变**（「所有者」类判定仍指原拥有者）。位置规则：**若它是前线上的唯一单位则留在原地，否则加入新控制者的支援阵线**。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **12.24 抑制 Suppress**：被抑制的单位**失去所有词条、关键字与加成效果**，并**重置攻击力、防御值与行动花费**（是一种状态，而非单位词条）。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)（[ACGO](https://www.acgo.cn/discuss/rest/62946) 未收录）
- **12.25 收缴 Seize**：**你的回合中**，具收缴的单位（或具收缴的指令）**消灭敌方单位**时，把该单位的 **1 攻 1 防复制品**加入你的手牌，其**花费不超过 3**，并带「被收缴」词条；复制品的**国籍变为收缴它的那张牌的国籍**。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **12.26 协力 Cooperation**：使用该卡时，**除非本回合开始时场上已有同国家的友方单位**，否则**总部受到士气伤害**（部分卡另有附加效果）。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **12.27 士气伤害 Morale damage**：**从 1 开始、每次递增 1**（1,2,3,4…）的总部伤害计数；空牌库抽牌与「协力」共用该计数。— **可信度：confirmed** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)
- **12.28 山地 Alpine / Mountain**：**部署（或新加入）山地单位时**，你在场上**每有 1 个其他山地单位**，该新单位 **+1/+1**（首个山地单位无加成；第 X+1 个获得 +X/+X）。— **可信度：confirmed** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)、[namu 快照](https://readonly.wiki/w/KARDS)
- **12.29 免疫 Immunity**：处于免疫状态的**单位或总部不会受到任何伤害**。— **可信度：likely** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)
- **12.30 撤退 Retreat**：单位**从前线撤退 → 回到其拥有者的支援阵线**；若**支援阵线已满**或它本来就在支援阵线，则**返回手牌**；**被控制的单位撤退时回到原拥有者的手牌**。— **可信度：likely** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)
- **12.31 被动效果 / 特殊词条 Passive**：在场上持续生效、改变游戏规则的常驻效果，**优先级高于手牌效果**（biligame 表述为「特殊词条优先级大于手牌效果」）。— **可信度：likely** · 来源：[biligame 首页](https://wiki.biligame.com/kards/首页)、[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)

**引擎：词条状态的可变性与清理（建议实现顺序）**

1. 每个单位维护：`keywords`（可增删的集合）、`buffs`（攻防加成）、`armor`（0–3）、`status`（pin/suppress/hidden/immune/mobilize/shock/smokescreen/guarded/veteran）。
2. **移动/攻击后**依次处理：失去烟幕 → 移除冲击（仅攻击后）→ 触发移动/攻击事件。
3. **回合开始**（其控制者）：动员 +1/+1、老兵条件检查、计时类状态递减。
4. **回合结束**（其拥有者）：压制在「拥有者的下一个回合结束」时解除（注意是「下一个」，即被压制当回合不解除）。
5. **受伤后**：动员永久移除。
6. **离场**：钳击伙伴失去加成；控制类效果结算回原拥有者。

### 13. 「指令 Order」与「反制措施 Countermeasure」

- **13.1 指令 Order**：从手牌**一次性结算**的效果牌，**不会被部署到战场**、不占战线格，结算后进弃牌堆。— **可信度：confirmed** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[官方教程中文文本转载](https://www.sjwyx.com/youxi/136002.html)、[namu 快照](https://readonly.wiki/w/KARDS)
- **13.2 反制指令（反制措施）的埋伏与触发**：支付指挥点后以**隐藏状态**放置，**在对手回合满足条件时自动触发**；**你为此支付的指挥点对手看不见**；**可以再次使用已激活的反制指令来取消激活**（收回埋伏状态）。— **可信度：likely** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[Level Winner](https://www.levelwinner.com/kards-the-ww2-card-game-beginners-guide-tips-tricks-strategies/)、[namu 快照](https://readonly.wiki/w/KARDS)
- **13.3 触发条件基于对手的具体行为**：例：对手**部署单位**（Careless Talk：对该单位造成 3 伤害／From the Deep：消灭该单位）、对手**单位移动到前线**（Missing：消灭该单位）、对手**攻击我方 HQ**（Counter Strike：消灭该单位）、对手**使用指向我方单位的指令**（Interception：反制该指令）、对手**占领前线**（Enemy Spotted：抽 3 张）。— **可信度：confirmed** · 来源：[namu 反制表](https://readonly.wiki/w/KARDS/대응방어)
- **13.4 反制措施能否被反制**：**未发现通用机制**——可被「反制」的是**指令**（如 Interception / Ultra 专门响应敌方指令），**没有任何来源描述「反制另一个反制指令」的通用规则**。引擎建议：仅把「反制指令」实现为对特定事件（含「敌方使用指令」事件）的响应，不默认提供互反。— **可信度：unverified** · 来源：[namu 反制表](https://readonly.wiki/w/KARDS/대응방어)（只列出对指令的反制）
- **13.5 反制指令占位与上限**：**是否占用支援阵线槽位、同时最多可激活几张，均未证实**（来源只说明它隐藏、需要指挥点、可取消）。— **可信度：unverified** · 来源：[biligame 游戏知识](https://wiki.biligame.com/kards/游戏知识)、[ACGO](https://www.acgo.cn/discuss/rest/62946)（均未提及）
- **13.6 反制措施的可见性**：对手**能看到你有一张埋伏中的反制指令**（知道存在），但**不知道具体是哪张、也不知道你花了多少指挥点**，只能按国家/环境推测。— **可信度：likely** · 来源：[Level Winner](https://www.levelwinner.com/kards-the-ww2-card-game-beginners-guide-tips-tricks-strategies/)、[namu 快照](https://readonly.wiki/w/KARDS)、[namu 反制表](https://readonly.wiki/w/KARDS/대응방어)

---

## 附录 A：回合结构（引擎实现顺序）

1. **回合开始（当前回合玩家）**：指挥点槽 +1（自然上限 12，绝对上限 24）→ 指挥点**回满至槽数** → 触发「回合开始时」效果（动员 +1/+1、老兵条件检查等）。
2. **抽牌阶段**：抽 1 张；**先手玩家的第 1 个回合跳过抽牌**；牌库为空则改为对总部造成**士气伤害**（计数 +1 累加）；手牌超过 9 张时超出部分**直接销毁、不触发效果**。
3. **行动阶段**（任意顺序，受资源与单位状态约束）：
   1. 打出手牌中的单位（支付**部署花费**，只能落在**己方支援阵线**，占 1 格，最多 4 个单位）。
   2. 打出手牌中的指令（支付花费，一次性结算）。
   3. 激活/取消**反制指令**（支付花费，埋伏状态）。
   4. 移动单位到前线（支付**行动花费**；只有「支援阵线 → 前线」方向；前线必须空置或由本方占用）。
   5. 攻击（支付**行动花费**；按第 6 节合法性顺序校验；按第 8 节结算顺序结算）。
   6. 每个单位每回合：移动 ≤1 次、攻击 ≤1 次（**奋战**允许攻击 2 次；**坦克**允许移动 1 次 + 攻击 1 次）。
4. **回合结束**：清除「直到回合结束」的临时加成；解除符合时机的压制（其拥有者的**下一个**回合结束时）。
5. **对手回合**：己方埋伏的**反制指令**在其事件条件被满足时自动触发并结算。

## 附录 B：与 `SCHEMA.md` 词条 id 的对照（供引擎标注用）

| SCHEMA id | 中文 | 本文结论 |
|---|---|---|
| `blitz` | 闪击 | 12.1 confirmed |
| `guard` | 固守 | 12.2 / 12.3 confirmed（位置型，非全局嘲讽） |
| `smokescreen` | 烟幕 | 12.4 confirmed |
| `ambush` | 伏击 | 12.5 confirmed |
| `mobilize` | 动员 | 12.6 confirmed |
| `fury` | 狂怒 / 奋战 | 12.7 confirmed（一回合攻击两次） |
| `deployment` | 部署 | 12.8 confirmed |
| `operation` | 行动 | 12.10 unverified（疑似只是「行动花费」概念） |
| `intel` | 情报 | 12.13 likely |
| `pin` | 压制 / 钉住 | 12.15 confirmed |
| `veteran` | 老兵 | 12.16 likely |
| `armor` | 装甲 / 重甲 | 12.17 confirmed（≤3，不减免指令伤害） |
| `shock` | 震慑 / 冲击 | 12.18 confirmed |
| `repair` | 维修 | 12.11 likely（治疗且不超上限） |
| `salvage` | 打捞 | 12.12 **unverified** |
| `retreat` | 撤退 | 12.30 likely |
| `guerrilla` | 游击 | **unverified**（可访问来源均未收录该词条定义） |
| `fortify` | 加固 | **unverified** |
| `spy` | 间谍 | **unverified** |
| `supply` | 补给 | **unverified**（仅见卡面文本引用，无词条定义） |
| `airdrop` | 空投 | **unverified** |
| `antiAir` | 防空 | **unverified** |
| `pierce` | 穿甲 | **unverified** |
| `rally` | 集结 | **unverified** |
| `entrench` | 挖掘 | **unverified** |
| （无 id） | 抉择 | 12.20 unverified（外部无权威定义；卡面上是「抉择：」前缀式模式选择） |
| （无 id） | 亡计 Destruction | 12.9 confirmed |
| （无 id） | 钳击 Pincer | 12.22 likely |
| （无 id） | 控制 Control | 12.23 likely |
| （无 id） | 抑制 Suppress | 12.24 likely |
| （无 id） | 收缴 Seize | 12.25 likely |
| （无 id） | 协力 Cooperation | 12.26 likely |
| （无 id） | 士气伤害 Morale damage | 12.27 confirmed |
| （无 id） | 山地 Alpine | 12.28 confirmed |
| （无 id） | 免疫 Immunity | 12.29 likely |
| （无 id） | 隐蔽 / 揭示 Hidden / Reveal | 12.21 / 12.14 likely |
| （无 id） | 被动 Passive | 12.31 likely |

---

## E. 来源列表（14）

> 每条给出 URL + 它**支持了本文哪些结论**。标注 `[已抓取正文]` 的是本次实际读取过内容的页面；标注 `[仅搜索结果]` 的是未能直连、只能确认其存在与标题的页面。

1. **https://www.sjwyx.com/youxi/136002.html** `[已抓取正文]` — 完整转载了 **KARDS 官方游戏内新手教程中文文本**：总部 20 点、指挥点每回合 +1 至 12、支援阵线/前线说明（每阵线含总部最多 5 张卡）、前线只能由一方控制、步兵/坦克必须进前线才能打敌方支援阵线与 HQ、**行动花费＝单位费用字段中的小数字、部署后只显示该数字**、卡组 40 张、盟国 ≤12 张。支持结论：1.1、1.2、2.1、2.3、4.1–4.5、5.1、5.2、6.4、10.1、10.2、10.4、13.1。
2. **https://wiki.biligame.com/kards/游戏知识** `[已抓取正文（含 wikitext 原文）]` — 中文社区 wiki 的规则页：战线容量（支援阵线 4 单位／前线 5 单位）、指挥点规则（+1/回合、上限 12、卡牌可至 24、回合结束不保留）、手牌上限 9、重调度、士气伤害递增、撤退、构筑 40 张、反制指令隐藏与取消、以及全部词条（钳击/守护/伏击/闪击/部署/亡计/奋战/被守护/重甲/免疫/动员/烟幕/冲击/压制/山地/控制）与五种单位类型的攻击规则。支持结论：1.2、1.8、2.1–2.3、3.1、3.3、4.1–4.5、6.1、6.2、6.5、6.6、7.1–7.5、8.1–8.4、9.1、10.3–10.6、11.1、11.3、12.2–12.9、12.15、12.17、12.18、12.22、12.23、12.27、12.28、12.29、12.30、12.31、13.1、13.2、13.5。
3. **https://wiki.biligame.com/kards/首页** `[已抓取正文]` — 词条速查表（2025-12 更新，含最新词条）：守护/被守护的**位置**语义、烟幕的三条禁则（前线单位/固守单位/战斗机不能有烟幕）、冲击优先级高于伏击、抑制、收缴、协力、士气伤害递增、山地、控制、流亡、老兵、情报、单位类型总述（火炮无视守护不被反击、轰炸机被战斗机拦截等）。支持结论：3.1、3.3、6.3、6.6、9.3、10.6、12.2–12.7、12.10、12.13、12.14、12.16、12.17、12.18、12.19、12.20、12.21、12.22、12.23、12.24、12.25、12.26、12.27、12.28、12.31。
4. **https://www.acgo.cn/discuss/rest/62946** `[已抓取正文]` — 2025-12 中文社区规则总整理：起手 4/5 与重调度、指挥点 12/24、手牌 9、疲劳递增、战线容量、五类单位的射击距离与反击规则、以及**维修/修复**（治疗不超上限）、隐蔽/揭示、老兵、收缴、钳击、流亡、控制、情报、冲击、协力、压制、免疫。支持结论：1.1、1.2、1.3、1.4、1.5、1.8、2.2、3.2、4.2–4.5、5.1–5.4、6.1、6.2、6.4、6.5、7.1、7.3–7.5、8.1–8.4、9.1、9.3、10.7、11.1、11.3、12.4、12.11、12.13、12.14、12.15、12.16、12.17、12.18、12.19、12.21、12.22、12.23、12.25、12.26、12.27、12.28、13.5。
5. **https://readonly.wiki/w/KARDS** `[已抓取正文]` — namu wiki（韩）快照，覆盖较早版本但词条语义详细：总部 20、卡组 40（含 1 张 HQ）、稀有度 4/3/2/1、起点手牌 4/5 与先手不抽牌、指挥点 12、疲劳、五种单位类型的行为差异、以及 Smokescreen / Ambush / Fury / Blitz / Pin / Guard / Heavy Armor / Deployment / Destruction / Mobilize / Alpine 的逐条说明。支持结论：1.1–1.3、1.5、1.6、3.2、4.5、6.6、7.4、7.5、8.1、10.3、11.1、11.2、12.1、12.5–12.8、12.15、12.17、13.1、13.2、13.6。
6. **https://readonly.wiki/w/KARDS/포병** `[已抓取正文]` — 炮兵专页：攻击时不受反击伤害、可攻击被守护单位、被攻击时按步兵规则；并给出大量炮兵卡的行动花费与「无法攻击敌方 HQ」「使敌方空军行动花费 +2」等卡面，用于反证空/炮默认可打 HQ 与行动花费可被修改。支持结论：5.4、8.4、9.1、9.2、10.6。
7. **https://readonly.wiki/w/KARDS/폭격기** `[已抓取正文]` — 轰炸机专页：攻非战斗机不受反击、被战斗机拦截时只能打战斗机且受反击、被攻击时不反击；卡表统一标注「소환코스트/행동코스트」（部署花费/行动花费）。支持结论：6.2、10.5、10.6。
8. **https://readonly.wiki/w/KARDS/보병** `[已抓取正文]` — 步兵专页：移动与攻击二选一、卡表含大量 Blitz / Guard / Ambush / Smokescreen 实例与「移动到前线时」触发效果，支持行动花费可被修改与移动事件设计。支持结论：7.6、10.6。
9. **https://readonly.wiki/w/KARDS/대응방어** `[已抓取正文]` — 反制指令卡表（Careless Talk / From the Deep / Missing / Counter Strike / Interception / Ultra / Enemy Spotted 等），给出全部触发条件样式。支持结论：7.6、13.3、13.4、13.6。
10. **https://www.levelwinner.com/kards-the-ww2-card-game-beginners-guide-tips-tricks-strategies/** `[已抓取正文]` — 新手攻略：起手 4/5、先手首回合不抽牌、指挥点 +1 至 12 且回满、疲劳、**「Combat is simultaneous」**、每线 5 张、单位移动或攻击二选一（坦克例外）、反制措施的指挥点消耗对对手不可见。支持结论：1.5–1.8、2.1、2.3、2.4、5.5、8.1、8.2、13.2、13.6。
11. **https://www.gcores.com/articles/119041** `[已抓取正文]` — 机核专栏（2020）：**行动费用标注在左上角费用数字下方以小字**、步兵/坦克需进前线、空/炮越过前线直击 HQ、轰炸机攻非战斗机不受反击且被攻击时不反击、卡组 40 张（主国 40 含 HQ、副国 ≤12 且无精英）、稀有度 4/3/2/1、HQ 初始 20、关键字举例（闪击/重甲 2/守护/烟幕/狂怒＝每回合可攻击两次/伏击）。支持结论：1.1–1.4、2.2、5.1、5.2、5.4、6.1、6.4、7.2、7.4、10.1–10.3、10.5、11.1、12.7。
12. **https://m.163.com/dy/article/FB66PD77052693KJ.html** `[已抓取正文]` — 网易号专栏（2020）：三区战场、前线只能被一方占据、站住前线才能打脸、HQ 20 点、**行动耗费**（步兵需多回合推进、坦克需付两次）、轰炸机行动耗费高。支持结论：4.5、7.2、7.4、10.3、10.5。
13. **https://qwq.wards.mom/card/45_mm_antitank_gun** 与 **https://qwq.wards.mom/collection.html** `[已抓取正文]` — 第三方 KARDS 卡牌资料站：卡面字段明确列出「**行动费用**」（证明该数值是每张单位卡的通用字段），图鉴筛选表列出当前词条集合（山地/伏击/闪击/隐秘/狂怒/守护/动员/钳击/**回收**/震慑/烟幕/重甲/部署/情报）。支持结论：10.1、12.12（反证：只有「回收」标签、无定义）。
14. **https://kards.fandom.com/wiki/Keywords** · **https://kards.fandom.com/zh/wiki/词条** · **https://kards.fandom.com/zh/wiki/交战线** · **https://kards-v2.vercel.app/news/homefront-combat-keywords** · **https://kards-v2.vercel.app/zh/how-to-play** `[仅搜索结果——本环境无法直连]` — 官方《Homefront: Combat Keywords》与 fandom 的 Keywords/词条/交战线页面（含「Category:老兵卡牌」分类）确认了这些词条**确实存在**（标题与页面结构可检索到），但正文未能取得；因此凡只能靠这些页面支撑的结论在本文中一律标为 `likely` 或 `unverified`。支持结论：12.16（老兵分类页存在）、0 节的环境限制说明。

### 已明确标注为「未证实」的条目汇总

`1.7`（后手是否有额外补偿）、`9.2`（炮兵被攻击时是否反击）、`10.7`（隐蔽状态行动费＝1）、`12.10`（「行动」作为独立词条）、`12.12`（打捞 Salvage）、`12.4` 中的子项（烟幕是否免疫指令）、`12.20`（抉择 Choose One 的权威定义）、`13.4`（反制措施能否被反制）、`13.5`（反制指令占位与数量上限），以及附录 B 中标为 unverified 的 11 个 SCHEMA 词条 id（`operation`、`salvage`、`guerrilla`、`fortify`、`spy`、`supply`、`airdrop`、`antiAir`、`pierce`、`rally`、`entrench`）。
