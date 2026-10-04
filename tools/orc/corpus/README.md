# 官方 KARDS 全卡语料

来源：https://www.kards.com/zh/decks/collection

抓取时间：2026-10-03T05:36:22Z。官方公开页面使用的查询端点为 `https://herokuapi.kards.com/graphql`；它不是稳定的公开 SDK 合约，抓取脚本会校验分页总量，端点变化需重新核对。

当前原始快照包含 1,646 条唯一卡牌记录，查询开启预备、衍生及流亡牌。SHA256：`a12d3d5685c368939404f4e2e221bacd017dfd75070bf9d59c2ee2f5666ec4aa`。

更新语料：`node tools/orc/fetch-official.js`。只在完整抓取并检查总数后写入文件；不下载美术图、不写玩家卡池。

只读审计：`node tools/orc/audit-official.js`。严格完成检查：追加 `--require-complete`，任何记录未完成时返回 2。结构检查不能代替对战语义验证，逐项诊断见生成的 `dist/orc-official-audit.json`。
