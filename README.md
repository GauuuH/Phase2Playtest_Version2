# Phase2Playtest_Version2

A redesigned multiplayer game based on DECIDER, featuring territory control and object stealing. All player-facing UI is in English.

## Current Prototype — DECIDER (Grid Walker)

原型阶段：验证地图、摄像机、手机操作与多人同步（界面全英文）。

- `index.html` / `style.css` / `sketch.js` / `js/net.js` / `js/vendor/mqtt.min.js`（HTML + CSS + JavaScript + p5.js + MQTT.js，无其他框架）
- 24×24 二维格子地图，Camera Follow 只跟随自己的角色，边缘正确钳制
- 手机竖屏适配（`100dvh`、安全区、触摸手势处理）

### 操作方式

| 操作 | 说明 |
|---|---|
| Swipe | 画面上滑/下滑，每次移动一格 |
| Tilt | 左右倾斜横向移动（5° 死区 + 180ms 定间隔）；无需校准——首次读数自动作为中立角；iOS 在点击 JOIN/READY 时自动请求授权 |
| Two-Finger Tap | 双指同时点击画面：抢夺相邻玩家携带的 Object（1.5s 冷却） |
| JOIN / READY | 加入共享房间 / 切换准备状态；全员就绪自动 3 秒倒计时开赛 |
| 键盘（桌面调试） | WASD / 方向键 |

### 多人同步（SharedRoom / MQTT，复用 DECIDER Phase2 旧项目方案）

- **没有电脑 Host**：每部手机直接加入同一个共享房间（公共 MQTT broker 上的 topic），摄像机只跟随自己；联机层为 `js/net.js` + `js/vendor/mqtt.min.js`
- 连接地址（顺序尝试）：`wss://broker.emqx.io:8084/mqtt` → `wss://broker.hivemq.com:8884/mqtt`；房间 = topic `gridwalker/phase2/<ROOM>`（`?room=` URL 参数可覆盖，默认 `GRIDWALKER`）
- 每台手机只写自己的 `me`（x/y/color/携带/交付），`net.js` 以 pstate 消息广播（兼 1.5 秒心跳）；其他玩家从 `guests` 读取渲染；4 秒无消息自动移除
- JOIN 反馈：Connecting… / Connected ✓ / Connection Failed（附具体原因）
- 新玩家自动分配颜色（30 色调色板，冲突按玩家 ID 字典序确定性让位）；加入/离开/断线重连由 `net.js` 处理（hello / bye / 心跳超时 / mqtt 自动重连）
- HUD 显示连接状态与在线人数

### 占地（Territory）

- 中立格子 owner 初始为 null；空手玩家进入格子即占领（owner = 玩家 ID，颜色 = 玩家颜色）；进入他人格子立即转移
- 每次移动只处理实际进入的格子；出生格子自动归自己所有
- 同步：`shared.cells["x,y"] = { o: 玩家ID, c: 颜色下标 }`，由 `net.js` 广播 cell 消息（带 (ts,id) 时间戳），所有设备按统一规则收敛到同一份值；中途加入的玩家通过 hello/room-ping 获得完整 room-state 快照
- `me.carryingObject` 携带 Object 时不占领
- HUD 显示自己拥有的格子数（开发测试用，无全局排名）
- **基地按本局人数动态分配**（写入 `shared.game.bases`，所有设备一致）：2 人左右对称、4 人四角、8 人四角+四边中点、其他人数沿地图外圈均匀分布；开赛前统一落位，比赛期间锁定

### Object（拾取 / 携带 / 交付）

- 地图中部动态生成 Object（数量按参与人数查表 2~13 个，Emoji 视觉）；空手进入 Object 格自动拾取，每人最多携带一个
- `shared.objects[objId] = { state, by }`（ground / carried / delivered）同步给所有手机；`me.carryingObject` 记录 Object ID
- 携带者头顶显示金色 Object 标记（所有玩家可见）；携带时移动不占地
- 基地 = 出生点（`me.baseX/baseY`）；携带回到自己基地自动交付 → Object 标记 delivered（暂不刷新），`me.delivered` +1，恢复占地
- 屏幕边缘显示指向自己基地的箭头（基地在屏幕内时不显示），携带时更醒目
- **双指抢夺**：两根手指同时点击画面触发；目标携带者曼哈顿距离 ≤ 1、抢夺者空手才能抢；成功即转移所有权（原携带者自动放下并恢复占地）；1.5s 冷却；成功/失败/距离/冷却均有屏幕反馈；双指点击不触发 Swipe 或缩放
- **同时拾取/抢夺**：MQTT 公共 broker 没有 CAS 或服务端裁决 API；采用「宣告 + 回滚」——各设备按 (ts,id) 统一裁决出唯一携带者，输家自动放下（最终一致，有亚秒级双携带过渡窗口，非严格互斥）。已交付的 Object 由交付者守护，不被迟到的抢夺宣告复活。详见 `sketch.js` 头部注释
- `claimObject(objId)` 即所有权转移入口（拾取与抢夺共用）

### 赛制（READY / 倒计时 / 计分 / 排名）

- 房间内每名玩家点 **READY** 切换准备状态；至少 2 名玩家且全员就绪后自动进入 3 秒倒计时（3 · 2 · 1 · GO!），随后统一开始 120 秒比赛
- 倒计时期间有人取消准备 / 断线 / 新玩家加入 → 自动取消并回到等待状态
- 比赛开始时锁定本局参与者名单：中途加入者观战（不能移动/占地/拾取/抢夺/交付，不参与计分）；PLAY AGAIN 后所有人恢复 Not Ready
- 每局 120 秒：倒计时由共享状态驱动（`shared.game = { phase, round, startAt, readyAt, participants, objects }`），各设备在收到 running 时以本地时刻锁定起点、等长计时；任一台归零写 ended，所有设备同时冻结
- 结束后：HTML 结算覆盖层（FINAL RESULTS）——放大的正方形完整地图 + 可滚动排行榜（排名/颜色/编号/总分与明细），PLAY AGAIN 固定在底部
- **PLAY AGAIN**：清空地图与物品、所有玩家回基地并清空携带/交付数、恢复 Not Ready，回到大厅
- 同时 READY / 结束 / PLAY AGAIN：阶段转换写入 + (ts,id) LWW 收敛 + 局号去重（每局每台只重置/锁定一次）

### Object（动态数量 + Emoji）

- 数量按本局参与人数查表：1–3 人 → 2 个，4–6 → 3，7–9 → 4，10–12 → 5，13–15 → 7，16–20 → 9，21–25 → 11，26–30 → 13
- 布局（id / emoji / 坐标）在比赛开始时由共享状态 `shared.game.objects` 决定，所有设备完全一致；位置在地图中部区域随机不重叠、避开基地；PLAY AGAIN 后按新人数重新生成
- 每个 Object 用不同 Emoji（📺📻📷🎮💻📱🎸🧸📼💿📚🕹️🎧），地上有轻微浮动动画，携带者头顶显示对应 Emoji

### 联机（SharedRoom，无需自建服务器）

联机走公共 MQTT broker（WebSocket），不需要部署任何服务器：

- `wss://broker.emqx.io:8084/mqtt`（首选）→ `wss://broker.hivemq.com:8884/mqtt`（备用）
- 库与房间机制复用 DECIDER Phase 2 旧项目（my-project-phase-2，自提交 a734abe 起实际使用）
- 公共 broker 无鉴权：知道房间名的人都能读写房间消息（原型阶段可接受）

### 用两部手机测试

1. 仓库 Settings → Pages → Source 选 **GitHub Actions**（推送后自动发布，约 1 分钟）
2. 两部手机打开 `https://gauuuh.github.io/Phase2Playtest_Version2/`（HTTPS 是传感器与 WebSocket 的前提）
3. 两台都点 **JOIN** → 进入同一房间（同 URL 即同房间，默认 `GRIDWALKER`；测试隔离可用 `?room=XXXX`）
4. HUD 显示"Connected · 在线 2/7"；任一台移动（滑动/倾斜/按钮），另一台立即看到

### 运行（本地）

直接用浏览器打开 `index.html`（`?debug=local` 为纯单机诊断模式；联机与传感器建议用 HTTPS 页面）。
