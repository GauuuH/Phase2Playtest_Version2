# Phase2Playtest_Version2

A redesigned multiplayer game based on DECIDER, featuring territory control and object stealing.

## Current Prototype — 格子漫游 (Grid Walker)

第一阶段原型：验证地图、摄像机与手机操作交互。

- `index.html` / `style.css` / `sketch.js`（HTML + CSS + JavaScript + p5.js，无其他框架）
- 24×24 二维格子地图（960×960px，大于手机屏幕），棋盘格 + 确定性随机地标（石头/树）
- Camera Follow：只跟随自己的角色，角色尽量保持在屏幕中央，靠近地图边缘时摄像机正确钳制
- 角色不能离开地图边界，地图不能无限滚动
- 手机竖屏适配（`100dvh`、安全区、`touch-action` 手势锁定、尽力锁定竖屏 + 横屏降级）

### 操作方式

| 操作 | 说明 |
|---|---|
| Swipe | 在游戏画面上向上/向下滑动，每次移动一格 |
| Tilt | 左右倾斜手机横向移动；越过死区立即走一格，之后按固定间隔连续移动，回到中立角度停止 |
| CALIBRATE | 以当前握持姿态作为倾斜中立角；iPhone 上通过该按钮请求方向传感器授权，未授权时 HUD 提示，不会报错 |
| 方向按钮 | 备用操作，保证不支持倾斜传感器的设备也能玩 |
| 键盘（桌面调试） | WASD / 方向键 |

### 架构（为将来 p5-phone-share 多人同步预留）

- **没有电脑 Host 大屏**：未来每位玩家都在自己的手机上运行同一个页面，显示同一张共享地图，摄像机只跟随自己的角色；电脑仅用于开发调试
- `gameState` —— 唯一数据源（所有玩家位置、摄像机）
- `movePlayer(id, dx, dy)` —— 唯一移动入口，与输入方式无关（滑动/倾斜/按钮/键盘最终都调用它）
- 将来接入 p5-phone-share：手机间用 `shared` 状态 / `shareEmit` 同步按键，收到别人的按键后调用同一个 `movePlayer()`，渲染代码无需改动

### 运行

直接用浏览器打开 `index.html`，或部署到 GitHub Pages 后用手机访问。
