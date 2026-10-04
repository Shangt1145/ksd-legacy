# 效果组合编辑器

面向第一次使用的玩家，请阅读 [Inspector 新手教程](INSPECTOR_BEGINNER_GUIDE.md)。游戏内在检查器顶部点击「新手教程」→「打开新手教程」，阅读窗口不会切走当前编辑器。教程源文件通过 `python tools/render-inspector-guide.py` 生成两端的离线页面。

维护入口是 `electron/game`，手机使用 `kards-mobile/www/game`。两端共用效果引擎和组合语义。Kotlin 及废弃网页版不参与本次修改。

## 组合模型

效果分为触发时机、可选的生效条件、可选的玩家选目标声明，以及顺序执行的动作。

- 取值：常量、读取属性、变量、持久记忆、查询对象、计数、列表长度、算式、随机数。
- 判断：比较两个值、属性存在、且、或、非。
- 查询：战场、支援阵线、前线、手牌、卡组、弃牌区、总部；全部符合者、随机符合者、来源和具名引用。
- 动作：单个属性、词条、规则修正、伤害、生命、资源、卡牌操作和事件绑定；再通过分支、循环和遍历组合。

查询先筛选再随机。筛选读取任意安全的属性路径，不由卡池出现过哪些字段决定合法性。`printed.attack` 读取卡面攻击力，`attack` 读取当前值；`keywords` 是当前词条列表，`opCost` 是有效行动费用。属性下拉提示不是封闭白名单。对象里的 `candidate` 指当前筛选候选，`self` 指能力来源，`current` 指遍历绑定的当前对象。

临时属性、行动费用、词条和规则修正按当前回合到期。常驻流程仅运行持续修正及其控制流程，不在每次重算时重复抽牌、造成伤害或创建单位。持续效果通过记账撤销后重新计算，不累积数值型词条。

`bindEvent` 的动作在收到事件的单位上下文中执行；需要原来源数据时应显式记录。定义变量和遍历变量属于局部作用域；`store` 的记忆可以保存在来源单位、玩家或本局状态上，用于跨事件计数。

## 示例

部署时，对所有费用不超过 3 且不具有固守的敌方单位，造成等于其当前攻击力的伤害：

```json
[
  {
    "trigger": "deploy",
    "actions": [
      {
        "op": "dealDamage",
        "target": {
          "sel": "all",
          "side": "enemy",
          "zone": "field",
          "where": {
            "test": "all",
            "items": [
              {"test": "compare", "left": {"expr": "read", "of": "candidate", "path": "cost"}, "cmp": "<=", "right": 3},
              {"test": "not", "item": {"test": "compare", "left": {"expr": "read", "of": "candidate", "path": "keywords"}, "cmp": "contains", "right": "guard"}}
            ]
          }
        },
        "amount": {"expr": "read", "of": "candidate", "path": "attack"}
      }
    ]
  }
]
```

## 兼容边界

旧的复合动作和条件仍由旧执行器兼容。打开卡牌不修改效果，也不自动升级 DSL。编辑器只对覆盖字段与语义的动作提供显式展开；未知字段和未覆盖的动作保留原样。因此当前不是旧效果全部拆分完成，也不是全原版卡支持完成。添加菜单只列出新的基本动作。

移除 `leaveUnit` 与消灭 `destroyUnit` 分开：移除不触发亡计。旧 `removeUnit` 仍保留移除语义。新增动作禁止覆盖已有操作注册项。

结构校验来自运行时能力表；通过不等于行为符合原版。未覆盖的复合动作、卡牌区域移动和复杂规则仍需后续审计，不能仅凭卡牌文本批量认定可执行。

## 输入与保存

默认使用简洁界面：先选卡，再从抽牌、加攻防、选目标伤害和总部治疗四个例子开始，调整数字后保存试玩。例子追加效果，不覆盖已有内容；只有新卡纯空白的初始效果会被替换。反复加入选目标的例子时，目标编号自动避开已有引用。单位例子使用部署时机，指令例子使用指令时机。

简单抽牌显示为「抽几张牌 / 谁来抽牌」，底层仍使用原有循环和抽牌动作。切换「显示进阶设置」只改变控件展示，不改效果数据。条件和目标声明放在可展开的选项中，原始数据与人工确认放在「更多工具」中。卡名与卡面说明独立于实际效果，修改说明不会自动编译。

普通输入不重建控件；中文输入组合结束后提交。切换卡牌、返回游戏和关闭桌面窗口用页面内确认框，并恢复编辑焦点。未保存的结构草稿写入 `kg.inspectorDraft`，重新打开时恢复。无效数据和写入失败不覆盖已保存卡牌。保存与“标记已验证”分开，结构变化不会自动获得人工验证状态。

## 验证

```powershell
node tools/dsl/check-effect-primitives.js
node tools/dsl/check-kards-compat.js
node tools/dsl/check-suppress-shuffle-remove.js
node node_modules/electron/cli.js tools/check-effect-inspector.js
node node_modules/electron/cli.js tools/check-inspector-native.js
node tools/check-mobile-touch.js
```

设置 `KG_GAME_DIR` 可将前两个执行测试切换到手机源码。Inspector UI 测试使用隔离配置和只读服务器，覆盖两端查看卡牌不改数据、中文输入、确认框焦点、原生输入、通用筛选、撤销重做、保存失败及草稿恢复；手机触摸测试在浏览器模拟设备执行，不代表真机验证。
