# Phase2Playtest_Version2

A redesigned multiplayer game based on DECIDER, featuring territory control and object stealing.

## Current Prototype — 格子漫游 (Grid Walker)

第一阶段原型：验证地图与摄像机系统。

- `index.html` / `style.css` / `sketch.js`（HTML + CSS + JavaScript + p5.js，无其他框架）
- 24×24 二维格子地图（960×960px，大于手机屏幕），棋盘格 + 确定性随机地标（石头/树）
- Camera Follow：角色尽量保持在屏幕中央，靠近地图边缘时摄像机正确钳制
- 角色：彩色圆形，出生在地图中央 (12, 12)
- 屏幕四方向按钮控制，每按一次移动一格（桌面可用方向键 / WASD 调试）
- 角色不能离开地图边界，地图不能无限滚动
- 手机竖屏适配（`100dvh`、安全区、`touch-action` 手势锁定）

### 预留的多人同步结构（p5-phone-share）

代码按「数据 / 逻辑 / 渲染 / 输入」分层，为将来接入 p5-phone-share（p5-phone 的 Share 功能）预留：

- `gameState` —— 唯一数据源（所有玩家位置、摄像机）
- `movePlayer(id, dx, dy)` —— 唯一移动入口，与输入方式无关
- 将来：手机用 `shareEmit('move', {dx, dy})` 发按键，Host 在 `shareEvent` 回调里调用 `movePlayer()`，渲染代码无需改动
- 接入步骤见 `sketch.js` 顶部注释

### 运行

直接用浏览器打开 `index.html`，或部署到 GitHub Pages 后用手机访问。
