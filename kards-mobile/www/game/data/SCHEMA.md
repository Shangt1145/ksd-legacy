# 卡图转写规范 (v1)

目标：把每一张 PNG 卡图**逐字**转写为结构化 JSON。**只描述你在图片上真实看到的内容，绝不猜测、不补全、不脑补。**

## 严禁事项

- 不要打开 `.xlsx`、`.MOV`、`.zip`、`.exe`。只看分配给自己的 PNG。
- 不要"美化"卡牌文本：错别字、奇怪的用词、多余空格都按原样抄。
- 不要用 KARDS 官方卡牌的已知效果去替换卡图上写的内容。
- 读不清的字符用 `?` 占位，并在 `notes` 里说明。

## 输出

为分配到的每一张图产出一条记录，写入指定的 `batch_XX.json`，格式：

```json
{
  "cards": [ { ...记录... }, { ...记录... } ]
}
```

文件必须是合法 JSON（UTF-8，无注释、无尾逗号）。记录数量必须等于 list 文件行数。

## 记录字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `src` | string | list 文件里的相对路径，原样照抄，例如 `USG/units/_1.png` |
| `name` | string | 卡名（中文，含英文副标题则写 `中文 / English`）。看不清用 `?` |
| `cost` | number\|null | 左上角的花费数字（旁边通常有个 `K`）。没有就是 `null` |
| `attack` | number\|null | 底部左侧数字。命令卡/无攻击力的卡是 `null` |
| `defense` | number\|null | 底部右侧数字。命令卡是 `null` |
| `cardType` | `"unit"` \| `"order"` | 底部有 攻击/类型/防御 三个格子的，是 `"unit"`；没有数值、只有一段效果文字的，是 `"order"` |
| `unitType` | string\|null | 单位图标辨认：`infantry`(步兵/士兵剪影) `tank`(坦克) `artillery`(火炮) `fighter`(战斗机) `bomber`(轰炸机) `ship`(舰船) `space`(太空/星舰) `structure`(工事/建筑) `unknown`。order 卡填 `null` |
| `keywords` | string[] | 卡面上**独立图标/独立词条**表示的词条，用下面的规范 id |
| `keywordsRaw` | string[] | 卡面上出现的词条中文原词（去重，原样） |
| `text` | string | 效果区文字逐字转写，多个句子用 `\n` 分隔。没有文字就是 `""` |
| `flavor` | string | 风味文字（斜体/引用类），没有就 `""` |
| `variableStats` | boolean | 攻/防位置写的是字母变量（如 `x`、`y`、`z`）而非数字时为 `true`，且把 `attack`/`defense` 填 `null`，在 `notes` 里写清 `attack=x, defense=z` 之类 |
| `confidence` | `"high"`\|`"medium"`\|`"low"` | 你对这条记录整体的把握 |
| `notes` | string | 不确定之处；没有就 `""` |

## 关键词规范 id（尽量用这些）

| id | 中文 |
|---|---|
| `blitz` | 闪击 |
| `guard` | 固守 |
| `smokescreen` | 烟幕 |
| `ambush` | 伏击 |
| `mobilize` | 动员 |
| `fury` | 狂怒 |
| `repair` | 维修 |
| `salvage` | 打捞 |
| `deployment` | 部署 |
| `operation` | 行动 |
| `intel` | 情报 |
| `pin` | 压制 / 钉住 |
| `guerrilla` | 游击 |
| `fortify` | 加固 |
| `veteran` | 老兵 |
| `shock` | 震慑 |
| `spy` | 间谍 |
| `supply` | 补给 |
| `airdrop` | 空投 |
| `antiAir` | 防空 |
| `armor` | 装甲 |
| `pierce` | 穿甲 |
| `retreat` | 撤退 |
| `rally` | 集结 |
| `entrench` | 挖掘 |

遇到表里没有的词条：`keywords` 里写 `"other:<中文原词>"`，例如 `"other:闪电战"`，同时在 `keywordsRaw` 里保留原词。

## 判定要点

- **花费**：左上角方块里的数字 + `K`。有些卡花费格是空灰方块 → `cost: null`。
- **右上角**通常是阵营/势力徽记，不是数字，不要当数值。
- **x / y / z**：如果攻防位置是字母，说明是变量卡，务必设 `variableStats: true` 并把字母写进 `notes`。
- **命令卡（order）**：没有攻防数字，中间只有一个类型图标（方框内感叹号之类），下面卡名 + 效果文字。
- 卡面有"部署：" "动员：" "狂怒：" 这类**触发前缀**时，前缀属于 `text` 的一部分，照抄在 text 里。
- 如果同一张图里有两个卡面（拼图/对比图），只转写主体那一张，并在 `notes` 注明。

## 转写 text 的示例

- `"部署：对一个敌方单位造成2点伤害。"`
- `"使所有太空单位获得游击和+2+2"`
- `"攻击太空单位时造成x点伤害\n否则造成y点伤害"`
- `"若你控制前线，抽1张牌。"`
