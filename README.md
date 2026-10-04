# KARDS DIY 桌面版

基于 Electron 的 DIY 卡牌对战游戏。仓库包含游戏源码和运行资源，不附带任何卡牌数据或卡图；首次启动使用空卡池，可自行创建或导入卡牌。

## 运行

安装 Node.js 的 LTS 版本后，在本仓库目录运行：

```powershell
npm ci
npm start
```

`npm start` 会先同步维护中的代码，再打开游戏。玩家卡牌、卡组和存档写入独立的用户数据目录；游戏菜单中的「打开数据目录」可以查看它。

## 设计卡牌效果

进入游戏，点击「效果检查器」→「新建卡」。已有自行创建或导入的卡牌时，也可以直接选中编辑。

1. 展开「从常见效果开始」，选抽牌、加攻防、选目标伤害或总部治疗。
2. 调整发生时机、对象和数字。
3. 点击「保存修改」，返回游戏试玩。

例子会追加效果，保留原有内容；新卡的空白效果会直接替换。撤销按钮可退回上一步。修改卡面说明不会自动修改实际效果。

默认界面只展开常用填写项。点击「显示进阶设置」可查看完整取值设置；变量、属性、算式和原始效果数据仍可使用。简单抽牌直接填写张数，不需要手工搭循环。旧效果继续保留，尚无专用表单的动作可在原始数据中编辑。

完整教程见 [Inspector 新手教程](docs/INSPECTOR_BEGINNER_GUIDE.md)，也可在检查器顶部直接打开。

## 验证

```powershell
npm test
npm run desktop:test-ui
npm run desktop:test-delete
npm run desktop:test-orc
npm run desktop:check
```

检查器测试使用临时存档，验证入门例子、中文输入、撤销重做、目标引用、草稿恢复、保存及桌面和手机布局。手机目录在本仓库中用于共享界面的回归测试，不包含 Android 安装包。

## 打包

Windows 上运行：

```powershell
npm run dist  # 便携目录
npm run zip   # ZIP 便携包
npm run nsis  # 安装包
```

构建会将完整运行资源复制到暂存目录，再覆盖维护中的代码。输出在 `dist/`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `electron/game/` | 维护中的游戏、界面与效果源码 |
| `resources/app/` | 本地服务器、空卡池启动文件与界面资源 |
| `main.js`、`preload.js`、`player-storage.js` | Electron 窗口与自动存档 |
| `tools/` | 同步、构建和验证工具 |
| `kards-mobile/www/` | 手机界面回归测试所用源码 |
| `docs/` | 新手教程和功能说明 |

修改 `electron/game/`，然后运行 `npm start`，会自动同步到运行资源。依赖、构建输出和本机存档不提交到仓库。
