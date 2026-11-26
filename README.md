# Phase2Playtest_Version2

A redesigned multiplayer game based on DECIDER, featuring territory control and object stealing.

## Current Prototype — 格子漫游 (Grid Walker)

原型阶段：验证地图、摄像机、手机操作与多人同步。

- `index.html` / `style.css` / `sketch.js`（HTML + CSS + JavaScript + p5.js + p5-phone，无其他框架）
- 24×24 二维格子地图，Camera Follow 只跟随自己的角色，边缘正确钳制
- 手机竖屏适配（`100dvh`、安全区、`lockGestures` 手势锁定）

### 操作方式

| 操作 | 说明 |
|---|---|
| Swipe | 画面上滑/下滑，每次移动一格 |
| Tilt | 左右倾斜横向移动（5° 死区 + 220ms 定间隔），CALIBRATE 以当前姿态校准中立角 |
| 方向按钮 | 备用操作（不支持倾斜的设备也能玩） |
| JOIN | 加入共享房间（多人同步） |
| 键盘（桌面调试） | WASD / 方向键 |

### 多人同步（p5-phone-share = p5-phone 的 Share 功能）

- **没有电脑 Host**：每部手机显示同一张共享地图，摄像机只跟随自己；共享状态以同步服务器（Cloudflare PartyServer Worker）为唯一数据源
- 每台手机只写自己的 `me`（x/y/color），p5-phone 自动同步；其他玩家从 `guests` 读取渲染
- 新玩家自动分配颜色与出生点（最多 7 人）；加入/离开/断线重连由 p5-phone 自动处理
- HUD 显示连接状态与在线人数

### 占地（Territory）

- 中立格子 owner 初始为 null；空手玩家进入格子即占领（owner = 玩家 ID，颜色 = 玩家颜色）；进入他人格子立即转移
- 每次移动只处理实际进入的格子；出生格子自动归自己所有
- 同步：`shared.cells["x,y"] = { o: 玩家ID, c: 颜色下标 }`，由 p5-phone 按路径补丁同步，所有设备收敛到服务器的同一份值；中途加入的玩家从 welcome 消息获得完整地图
- `me.carryingObject`（默认 false）为 Object 系统预留：携带 Object 时不占领
- HUD 显示自己拥有的格子数（开发测试用，无全局排名）

### 配置共享服务器（必需，一次性）

p5-phone 的 Share 需要本项目自己部署的 Worker（免费 Cloudflare 账号）：

1. 克隆 [p5-phone 仓库](https://github.com/npuckett/p5-phone)，`cd companion/P5PhoneShare && npm install`
2. `npx wrangler login`，然后 `npx wrangler deploy`，记下输出的 `https://xxx.workers.dev`
3. 把 URL 填到 `sketch.js` 顶部的 `SHARE_CONFIG.host`（或者不改代码，用 `?shareHost=…&room=…` 链接打开页面）
4. 老师如果提供了班级共用的 Worker URL，直接填即可

### 用两部手机测试

1. 仓库 Settings → Pages → Source 选 **GitHub Actions**（推送后自动发布，约 1 分钟）
2. 两部手机打开 `https://gauuuh.github.io/Phase2Playtest_Version2/`（HTTPS 是传感器与 WebSocket 的前提）
3. 两台都点 **JOIN** → 进入同一房间（同 URL 即同房间）
4. HUD 显示"已连接 · 在线 2/7"；任一台移动（滑动/倾斜/按钮），另一台立即看到
5. 桌面打开同一页面会显示邀请二维码，手机扫码即可加入同一房间

### 运行（本地）

直接用浏览器打开 `index.html`（未配置服务器时为单机模式，可玩但无联机）。
