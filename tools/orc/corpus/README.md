# 官方 KARDS 全卡语料

来源：https://www.kards.com/zh/decks/collection

本仓库不附带卡牌语料快照。以下工具仅供使用者自行获取和审计数据，不在启动或构建时自动执行。

更新语料：`node tools/orc/fetch-official.js`。只在完整抓取并检查总数后写入文件；不下载美术图、不写玩家卡池。

只读审计：`node tools/orc/audit-official.js`。严格完成检查：追加 `--require-complete`，任何记录未完成时返回 2。结构检查不能代替对战语义验证，逐项诊断见生成的 `dist/orc-official-audit.json`。
