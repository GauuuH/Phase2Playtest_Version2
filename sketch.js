/* ============================================================
 * 格子漫游 · Grid Walker —— sketch.js
 *
 * 24×24 格子地图 + Camera Follow（只跟随自己的角色）
 * 手机竖屏游戏，电脑仅用于开发调试
 *
 * ── 多人架构（SharedRoom / MQTT，复用 DECIDER Phase2 旧项目方案） ──
 * 没有“电脑 Host 大屏”：每部手机运行同一个页面，直接加入同一个共享
 * 房间（公共 MQTT broker 上的 topic），摄像机只跟随自己的角色。
 * 联机层在 js/net.js，完全复用旧项目（my-project-phase-2）实际运行过的
 * SharedRoom 机制：
 *   · 库与地址：js/vendor/mqtt.min.js（MQTT.js）→ wss://broker.emqx.io:8084/mqtt
 *     → wss://broker.hivemq.com:8884/mqtt（顺序尝试，与旧项目一致）；
 *   · 房间机制：所有设备订阅 topic "gridwalker/phase2/<ROOM>"，
 *     ROOM 取 ?room= URL 参数 → localStorage → 默认 GRIDWALKER；
 *   · 初始化：mqtt.connect(url, { clean:true, reconnectPeriod:3000,
 *     connectTimeout:8000, clientId:随机 })，单个 broker 9 秒未连上换下一个。
 *
 *   me     —— 本机玩家的状态（x, y, color, baseX/baseY, carryingObject,
 *             delivered）。写入 me 时 net.js 自动以 pstate 消息广播给房间
 *             里其他手机（同时兼任心跳，1.5 秒一条）；断线期间改动保存在
 *             本地，重连时随 hello 消息补发。
 *   guests —— 其他在线玩家的 me 快照数组（每个带 id），由 net.js 维护：
 *             收到 pstate/hello 即加入或更新，4 秒没收到任何消息的玩家
 *             自动移除（值取自旧项目 OFFLINE_AFTER_MS）。
 *   shared —— 房间级状态（cells / objects / game），net.js 用 Proxy 监听
 *             写入：每个写入带 (ts, id) 时间戳广播，所有设备按同一规则
 *             （先比 ts 再比 id）收敛到同一份值，等价于旧 Worker 的
 *             按到达顺序 last-write-wins。
 *
 * 关键约定（避免设备间互相覆盖）：
 *   · 每台手机只写自己的 me，绝不写别人的状态；
 *   · 位置冲突天然不存在：每个玩家的坐标只属于他自己的 me；
 *   · 颜色/出生点：新玩家连接后从共享可见的 guests 里找第一个空闲颜色，
 *     出生点由颜色下标确定（所有设备用同一张表，结果一致）；
 *     若两人同时拿到同色，id 字典序大的那台让位重选，自动收敛。
 *
 * ── 占地（Territory）同步 ──
 * 方案：shared.cells["x,y"] = { o: 玩家ID, c: 颜色下标 }
 *   · 每次移动只写实际进入的格子（顶墙不动不写）→ 站立不重复触发；
 *   · 同一格同时占领：各设备按 (ts, id) 统一裁决，所有手机最终显示
 *     同一结果（一致性优先，不冒充原子性）；
 *   · 主人 ID 与颜色同一条记录一起写，不存在字段撕裂；
 *   · 中途加入/重连：hello / room-ping 会触发其他设备回发完整
 *     room-state（cells/objects/game 全量快照），立即拿到完整地图。
 * 未连接服务器时不做本地占地（加入后地图以服务器为准，避免各设备不一致）。
 *
 * ── Object（拾取/携带/交付）同步 ──
 * 状态：shared.objects[objId] = { state: 'ground'|'carried'|'delivered', by: 携带者ID }
 *   · 拾取 = 写 { state:'carried', by:我的ID }；交付 = 写 { state:'delivered', by:我的ID }；
 *   · 每台手机只写自己参与的转移，绝不替别人改状态；
 *   · 自己携带什么放在 me.carryingObject（Object ID 或 null），随 me 广播。
 *
 * 【关于“同时拾取同一 Object 只有一人成功”（要求 10）的如实说明】
 *   MQTT 公共 broker 没有 CAS（原子比较交换）或专门的服务端裁决。它提供的
 *   保证是：所有设备都会收到相同的消息，并按同一规则（写入时间戳 (ts, id)
 *   较大者胜）收敛到同一份值——等价于旧 Worker 的按到达顺序 last-write-wins。
 *   因此本实现采用「宣告 + 回滚」：
 *     1. 双方都可能先写出 { carried, by:自己 } 并短暂以为自己成功；
 *     2. 各设备用 (ts, id) 定出唯一赢家（写入 shared.objects[objId].by）；
 *     3. 输家看到 by ≠ 自己 → 自动放下（resolveObjectConflicts，每帧检查）。
 *   结果：所有设备最终一致，只有一个携带者；但存在亚秒级的“双携带”过渡窗口。
 *   这不是严格意义上的互斥锁，是“统一裁决规则 + 客户端回滚”的最终一致性方案
 *   ——如实记录，不冒充原子操作。
 *
 * ── 基地与交付 ──
 *   每个玩家的基地 = 自己的出生点（me.baseX / me.baseY，加入时写入并随 me 同步）。
 *   携带 Object 走回自己基地格 → 自动交付：objects[objId] 标记 delivered，
 *   清空 carryingObject，me.delivered +1，恢复占地能力。
 *   delivered 的 Object 不再刷新（刷新规则以后再定）。
 *
 * ── 预留：双指抢夺接口 ──
 *   claimObject(objId) 即所有权转移入口：把 by 写成新携带者即可，
 *   原携带者会在 resolveObjectConflicts() 中自动放下。将来在输入层
 *   （双指手势）调用即可，无需改同步逻辑。本阶段不接线。
 *
 * ── 抢夺（已实现）──
 *   双指同时点击画布（<350ms）→ trySteal()：必须空手、目标携带者
 *   曼哈顿距离 ≤ 1、目标 Object 仍为 carried，才写所有权转移；
 *   1.5s 冷却；成功/失败/距离/冷却都有屏幕反馈。
 *   并发（不冒充原子性）：各设备按 (ts, id) 统一裁决出唯一 by，输家自动放下；
 *   已交付的 Object 由交付者本会话守护（assertDelivered），
 *   被迟到的抢夺宣告复活时重新写回 delivered。
 *
 * ── 赛制：READY 准备 → 3 秒倒计时 → 120 秒比赛 / 计分 / 排名 ──
 *   shared.game = { phase: 'lobby'|'countdown'|'running'|'ended', round, startAt,
 *                   readyAt, participants[], objects[] }
 *   · READY：每位玩家切换 me.ready（随 pstate 广播）；等待阶段显示
 *     Ready: n/m。至少 2 名玩家且全员就绪后自动进入 countdown。
 *   · countdown 的确定性启动（公共 broker 无原子事务，见下）：
 *       1) 只有「全员就绪」的上升沿（false→true）且 phase=lobby 才写
 *          { countdown, round, readyAt, participants }——多台同时写入时
 *          由 (ts,id) LWW 收敛出唯一的 readyAt 与参与者名单；
 *       2) 倒计时 3 秒期间任一玩家取消准备 / 断线 / 新玩家加入（默认
 *          Not Ready）→ 任一设备检测到「非全员就绪」就写回 lobby 取消；
 *       3) 倒计时归零 → 任何设备写 { running, round, startAt, participants,
 *          objects[] }（与 countdown 同一名单，多写幂等，LWW 收敛）；
 *       4) 所有写入都是「阶段转换」（先改本地阶段再广播），不会因消息
 *          延迟重复触发；取消后需重新出现全员就绪上升沿才会再次倒计时。
 *   · 比赛开始时锁定参与者名单：中途加入者不在名单内 → 观战（不能移动、
 *     占地、拾取、抢夺、交付，也不参与计分）；下一局重新准备。
 *   · 倒计时同步：每台设备在首次看到 running(N) 时以“本地收到时刻”起算
 *     120 秒（消除设备时钟差，各设备等长计时；开赛误差 ≈ 网络延迟）；
 *     迟到加入/重载时 startAt 已过去较久 → 改用 startAt 反推剩余时间；
 *   · 结束：任何设备倒计时归零都写 { ended }（多台同时写同一值，
 *     各设备按 (ts, id) 统一裁决收敛，先写先冻结）；所有操作在非 running 阶段被冻结；
 *   · 计分（结束时从共享状态计算，所有设备结果一致，只算本局参与者）：
 *     最终领地每格 +1；交付 Object 每个 +30；结束时仍携带每个 +15；
 *     比赛中不显示任何人的总分/排名，结束后才显示完整地图与明细；
 *   · 并发冲突（同时 READY / 同时结束 / 同时 PLAY AGAIN）：
 *     同 key 覆盖 + 局号去重（每台设备每个局号只重置/锁定一次），
 *     最终都收敛到同一份 game 状态。
 *
 * ── Object 布局（动态数量，见 OBJECT_COUNT_FOR） ──
 *   · 数量按本局参与者人数查表（2~13 个），比赛开始时生成并写入
 *     shared.game.objects（同一局所有设备看到完全相同的 id/emoji/坐标）；
 *   · 位置由共享状态决定（发起设备用带种子的 PRNG 生成），绝不由
 *     每台手机各自随机；PLAY AGAIN 后按新人数重新生成；
 *   · Emoji 仅作视觉：id → OBJECT_EMOJIS 下标映射，不进入同步逻辑。
 *
 * ── 操作方式（手机） ──
 *   · Swipe：画面上滑/下滑，每次移动一格
 *   · Tilt ：左右倾斜横向移动（死区 + 定间隔），权限自动请求、
 *            以首次读数自动校准中立角（无 CALIBRATE 按钮）
 *   · Two-Finger Tap：抢夺其他玩家携带的 Object
 *   · JOIN / READY：加入房间 / 切换准备状态（同时也是传感器授权入口）
 * ── 操作方式（桌面调试） ──
 *   · 方向键 / WASD
 * ============================================================ */

'use strict';

/* 手机端初始化防护：任何未捕获的 JS 错误显示在底部状态行 */
window.addEventListener('error', (e) => {
  try {
    const el = document.getElementById('net-status');
    if (el) el.textContent = 'JS Error: ' + (e.message || 'unknown error');
  } catch (x) { /* 忽略 */ }
});

/* ---------------- 诊断模式 (?debug=local 或 #debug=local) ----------------
 * 完全排除联机影响：不调用 netInit()/netConnect()、不访问 broker；
 * isShareConfigured() 返回 false → 所有逻辑自然走本地单机分支。
 * 状态行显示帧计数（证明 draw() 在跑），JOIN/CALIBRATE 点击给出明确反馈。 */
const debugState = {
  mode: false,
  message: ''
};

function isDebugLocal() {
  try {
    if (sessionStorage.getItem('debug') === 'local') return true;
  } catch (e) { /* 忽略 */ }
  try {
    if (new URLSearchParams(location.search).get('debug') === 'local') return true;
  } catch (e) { /* 忽略 */ }
  try {
    if (/debug=local/.test(location.hash)) return true;
  } catch (e) { /* 忽略 */ }
  return false;
}
debugState.mode = isDebugLocal();

/* ---------------- 世界配置 ---------------- */
const GRID   = 24;            // 24 × 24 格子地图
const CELL   = 40;            // 每格像素
const WORLD_W = GRID * CELL;  // 地图总宽 960px
const WORLD_H = GRID * CELL;  // 地图总高 960px（大于手机屏幕）

/* ---------------- 操作配置 ---------------- */
const SWIPE_DIST   = 30;    // 滑动判定距离（px）
const TILT_DEADZONE = 5;    // 倾斜死区（°），防止手抖误触发
const TILT_INTERVAL = 180;  // 倾斜越过死区后的固定移动间隔（ms），配合平滑动画更自然
const TILT_SIGN = 1;        // 个别设备若左右方向颠倒，改成 -1

/* ---------------- 赛制配置 ---------------- */
let GAME_DURATION = 120000;  // 每局时长（ms）= 120 秒；测试时可临时改短
const SCORE_CELL = 1;        // 最终领地每格 1 分
const SCORE_DELIVERED = 30;  // 交付一个 Object 30 分
const SCORE_CARRIED = 15;    // 结束时仍携带一个 Object 15 分
const READY_COUNTDOWN_MS = 3000;   // 全员就绪后的统一开赛倒计时（3 秒）
const READY_MIN_PLAYERS = 2;       // 联机模式至少 2 人才能开始

/* ---------------- 移动平滑（视觉坐标，逻辑坐标仍是整数格） ---------------- */
const MOVE_SMOOTH_K = 16;   // 玩家视觉位置追赶速率（1/s），约 90% 收敛 ≈ 145ms
const CAM_SMOOTH_K  = 10;   // 摄像机平滑速率（1/s），比玩家略慢、避免抖动

/* ---------------- 联机配置（SharedRoom / MQTT，实现见 js/net.js） ---------------- */
const SHARE_CONFIG = {
  room: 'GRIDWALKER'   // 房间名：同一房间的手机互相可见（?room= URL 参数可覆盖）
};

const MAX_PLAYERS = 30;   // 设计容量：最多 30 名玩家（需实际压力测试）

/* 30 种玩家颜色（下标 = 颜色编号，全部设备一致）：前 7 个保持原样，
 * 其余按色相环铺开并交替明度，保证相邻编号视觉可区分 */
const PALETTE = [
  [255, 118, 87],    // 0 珊瑚红
  [255, 199, 89],    // 1 琥珀
  [111, 194, 255],   // 2 天蓝
  [151, 220, 121],   // 3 草绿
  [206, 131, 255],   // 4 紫
  [255, 140, 199],   // 5 粉
  [117, 230, 218],   // 6 青
  [255, 90, 60],     // 7 红橙
  [90, 130, 255],    // 8 蓝
  [70, 200, 120],    // 9 绿
  [255, 210, 80],    // 10 金黄
  [200, 100, 255],   // 11 蓝紫
  [255, 100, 150],   // 12 玫红
  [100, 200, 220],   // 13 湖蓝
  [180, 150, 255],   // 14 淡紫
  [255, 160, 100],   // 15 杏橙
  [150, 220, 90],    // 16 黄绿
  [120, 160, 255],   // 17 天蓝 2
  [240, 110, 200],   // 18 品红
  [90, 220, 190],    // 19 海绿
  [220, 130, 70],    // 20 棕橙
  [130, 100, 200],   // 21 紫 2
  [200, 210, 90],    // 22 橄榄
  [90, 190, 250],    // 23 浅蓝
  [230, 150, 130],   // 24 肉粉
  [110, 190, 130],   // 25 灰绿
  [200, 120, 220],   // 26 兰紫
  [150, 130, 90],    // 27 卡其
  [120, 220, 160],   // 28 薄荷
  [240, 180, 120]    // 29 浅橙
];

/* ---------------- 地图视觉（Modern Minimalist · Premium Dark UI） ---------------- */
const MAP_BG        = '#252A32';   // 地图背景 / 格子间隙
const NEUTRAL_TILE  = [52, 58, 67];   // 中立地砖 #343A43
const TILE_BORDER   = [68, 75, 86];   // 地砖边框 #444B56
const TILE_R        = 4;              // 地砖圆角（3–5px）
const CELL_TAKE_MS  = 150;            // 领地易主颜色过渡时长（120–180ms）

/* 玩家颜色 → 地砖色：略微降低饱和度并与灰底调和，鲜明但不刺眼 */
function tileColorOfIdx(colorIdx) {
  const p = PALETTE[((colorIdx % PALETTE.length) + PALETTE.length) % PALETTE.length];
  return [
    Math.round(p[0] * 0.76 + NEUTRAL_TILE[0] * 0.24),
    Math.round(p[1] * 0.76 + NEUTRAL_TILE[1] * 0.24),
    Math.round(p[2] * 0.76 + NEUTRAL_TILE[2] * 0.24)
  ];
}

/* Object 视觉：唯一 ID（o1..o13）→ Emoji 下标固定映射，所有设备一致。
 * Emoji 仅作为视觉资源，不进入同步逻辑。 */
const OBJECT_EMOJIS = [
  '📺', '📻', '📷', '🎮', '💻', '📱', '🎸',
  '🧸', '📼', '💿', '📚', '🕹️', '🎧'
];

/* 动态 Object 数量：按本局参与玩家人数查表 */
function objectCountFor(playerCount) {
  if (playerCount <= 3) return 2;
  if (playerCount <= 6) return 3;
  if (playerCount <= 9) return 4;
  if (playerCount <= 12) return 5;
  if (playerCount <= 15) return 7;
  if (playerCount <= 20) return 9;
  if (playerCount <= 25) return 11;
  return 13;
}

/* 带种子 PRNG（mulberry32）：布局生成可复现，但实际以共享状态为准 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 生成一局 Object 布局：数量查表；位置在地图中部区域（x,y ∈ [3,20]，
 * 天然避开四周出生点）随机取不重叠格子。结果写入 shared.game.objects，
 * 所有设备读取同一份布局，绝不各自随机。 */
function generateObjectLayout(round, playerCount) {
  const count = objectCountFor(playerCount);
  const rng = mulberry32(((round * 7919 + playerCount * 131) | 0) >>> 0);
  const cands = [];
  for (let y = 3; y <= 20; y++) {
    for (let x = 3; x <= 20; x++) cands.push({ x: x, y: y });
  }
  const objs = [];
  for (let i = 0; i < count && i < cands.length; i++) {
    const j = i + Math.floor(rng() * (cands.length - i));
    const t = cands[i]; cands[i] = cands[j]; cands[j] = t;
    objs.push({
      id: 'o' + (i + 1),
      emoji: OBJECT_EMOJIS[i % OBJECT_EMOJIS.length],
      x: cands[i].x,
      y: cands[i].y
    });
  }
  return objs;
}

/* ============================================================
 * 基地分配 —— 与颜色/身份解耦，随本局人数动态计算
 * 输入：按唯一玩家 ID 字典序排序的本局参与者名单（来自共享状态，
 *       绝不依赖各设备本地 guests 数组顺序）
 * 输出：{ playerId: {x, y} }，所有设备用同一算法得到完全相同的结果，
 *       并随 countdown 一起写入 shared.game.bases 作为权威状态。
 * 布局：2 人左右水平对称；4 人四角；8 人四角+四边中点；
 *       其他人数沿地图外圈（88 个边缘格）均匀取点，互不重叠。
 * ============================================================ */
function perimeterCellList() {
  const cells = [];
  for (let x = 1; x <= 22; x++) cells.push({ x: x, y: 0 });
  for (let y = 1; y <= 22; y++) cells.push({ x: 23, y: y });
  for (let x = 22; x >= 1; x--) cells.push({ x: x, y: 23 });
  for (let y = 22; y >= 1; y--) cells.push({ x: 0, y: y });
  return cells;   // 88 个边缘格
}

function computeBases(sortedIds) {
  const bases = {};
  const n = (sortedIds || []).length;
  if (n <= 0) return bases;
  if (n === 2) {
    // 两名玩家：最左 / 最右，水平对称
    bases[sortedIds[0]] = { x: 0, y: 12 };
    bases[sortedIds[1]] = { x: 23, y: 12 };
  } else if (n === 4) {
    // 四名玩家：四个角落
    bases[sortedIds[0]] = { x: 0, y: 0 };
    bases[sortedIds[1]] = { x: 23, y: 0 };
    bases[sortedIds[2]] = { x: 0, y: 23 };
    bases[sortedIds[3]] = { x: 23, y: 23 };
  } else if (n === 8) {
    // 八名玩家：四角 + 四条边中点
    const pts = [
      { x: 0, y: 0 }, { x: 23, y: 0 }, { x: 0, y: 23 }, { x: 23, y: 23 },
      { x: 12, y: 0 }, { x: 23, y: 12 }, { x: 12, y: 23 }, { x: 0, y: 12 }
    ];
    for (let i = 0; i < 8; i++) bases[sortedIds[i]] = pts[i];
  } else {
    // 其他人数：沿外圈均匀取点
    const P = perimeterCellList();
    for (let i = 0; i < n; i++) {
      bases[sortedIds[i]] = P[Math.floor((i * P.length) / n)];
    }
  }
  return bases;
}

/* ---------------- 游戏状态（摄像机等本地状态） ---------------- */
/* 玩家状态不在本地对象里：自己在 net.js 维护的 me 里，他人在 guests 里 */
const gameState = {
  camera: { x: 0, y: 0 },       // 摄像机左上角的世界坐标（像素）
  render: { x: 0, y: 0 }        // 本机角色的视觉坐标（像素，平滑过渡用）
};

/* ---------------- 赛制本地状态（不同步，纯本机） ---------------- */
const game = {
  localRound: -1,       // 本机已锁定的局号
  lastPhase: null,      // 本机上次看到的阶段（用于锁定 running 的进入沿）
  localStartAt: 0,      // 本机倒计时起点（本地时钟，收到 running 时锁定）
  lastResetRound: -1,   // 已执行自我重置的局号（每局只重置一次）
  scores: null,         // 结束后每帧从共享状态重算（冻结期保持最新）
  lastAllReady: null,   // 全员就绪上升沿检测（false→true 才触发倒计时）
  goFlashUntil: 0       // running 刚开始时显示 GO! 的时间戳
};

/* ---------------- 倾斜传感器状态 ---------------- */
const sensors = {
  needPermission: false,   // iOS 13+：需用户手势请求授权
  permissionAsked: false,
  denied: false,           // 授权被拒绝 → HUD 提示，不报错
  available: false,        // 是否收到过传感器数据
  latest: null,            // 最近一次左右倾斜角度（°）
  neutral: null,           // 校准后的中立角度（°）
  calibrated: false,
  pendingCalibrate: false, // 等第一条数据到达后自动校准
  dir: 0,                  // 当前倾斜方向：-1 左 / 0 停 / 1 右
  lastMoveAt: 0            // 上次倾斜移动的时间（millis）
};

/* ============================================================
 * 联机工具
 * ============================================================ */
function isShareConfigured() {
  if (debugState.mode) return false;   // 诊断模式：不联机、不访问服务器
  if (SHARE_CONFIG.room && SHARE_CONFIG.room.trim()) return true;
  return false;
}

function isConnected() {
  return window.shareConnected === true;
}

function getMyId() {
  return String(window.shareClientId || '');
}

// 写入共享状态时用的“我的身份”：联机 = 服务器分配 ID；单机模式 = 'local'
function myOwnerId() {
  return isShareConfigured() ? String(window.shareClientId || '') : 'local';
}

function onlineCount() {
  if (!isConnected()) return 1;
  return 1 + (Array.isArray(window.guests) ? window.guests.length : 0);
}

/* ============================================================
 * 赛制 —— 阶段 / 倒计时 / 计分
 * ============================================================ */
function gamePhase() {
  const g = window.shared.game;
  if (!g) return 'lobby';
  const p = g.phase;
  return (p === 'running' || p === 'ended' || p === 'countdown') ? p : 'lobby';
}

function gameRound() {
  const g = window.shared.game;
  return g && typeof g.round === 'number' ? g.round : 0;
}

function gameIsRunning() {
  return gamePhase() === 'running';
}

/* 本局参与者名单（共享状态，比赛开始时锁定） */
function gameParticipants() {
  const g = window.shared.game;
  if (g && Array.isArray(g.participants) && g.participants.length > 0) {
    return g.participants.map(String);
  }
  return [];
}

/* 我是本局参与者吗（决定能否移动/计分） */
function amIParticipant() {
  if (!isShareConfigured()) return true;   // 单机/诊断：无观战概念
  const ids = gameParticipants();
  if (ids.length === 0) return true;       // 尚未锁定名单（lobby）：都在
  return ids.indexOf(myOwnerId()) >= 0;
}

/* 观战者：比赛中途加入、不在本局参与者名单内 */
function isSpectator() {
  if (!isShareConfigured()) return false;
  return gamePhase() === 'running' && !amIParticipant();
}

/* 当前在线玩家 id 列表（自己 + guests，按字典序排序，各设备一致） */
function currentParticipantIds() {
  const ids = [myOwnerId()];
  const gs = window.guests || [];
  for (const g of gs) {
    if (String(g.id)) ids.push(String(g.id));
  }
  ids.sort();
  return ids;
}

/* 全员就绪判定：自己 + 所有在线玩家都 READY，且（联机时）至少 2 人 */
function allPlayersReady() {
  if (!me.ready) return false;
  const gs = window.guests || [];
  for (const g of gs) {
    if (!g.ready) return false;
  }
  if (isShareConfigured() && onlineCount() < READY_MIN_PLAYERS) return false;
  return true;
}

function readyCount() {
  let n = me.ready ? 1 : 0;
  const gs = window.guests || [];
  for (const g of gs) if (g.ready) n++;
  return n;
}

/* 每帧：把共享状态里的基地分配应用到本机（me.baseX/baseY + 开赛前落位）。
 * 基地在 countdown 写入共享状态后锁定；比赛中断线/重连不影响其他玩家，
 * 重连参与者若仍在默认出生位置则回到自己的基地。 */
function applyMyBase() {
  const g = window.shared.game;
  if (!g || !g.bases || typeof g.bases !== 'object') return;
  const b = g.bases[myOwnerId()];
  if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') return;
  if (me.baseX === b.x && me.baseY === b.y) return;

  me.baseX = b.x;
  me.baseY = b.y;

  const p = gamePhase();
  const freshDefault = me.x === 12 && me.y === 12;
  if (p === 'lobby' || p === 'countdown' || (p === 'running' && freshDefault)) {
    me.x = b.x;
    me.y = b.y;
    gameState.render.x = (b.x + 0.5) * CELL;
    gameState.render.y = (b.y + 0.5) * CELL;
  }
}

/* 按玩家 id 找当前颜色下标：自己 → guests → 离线快照 */
function colorIdxOfPlayer(id) {
  if (String(id) === myOwnerId()) {
    return (typeof me.color === 'number' && me.color >= 0) ? me.color : -1;
  }
  const gs = window.guests || [];
  for (const g of gs) {
    if (String(g.id) === String(id)) {
      return (typeof g.color === 'number' && g.color >= 0) ? g.color : -1;
    }
  }
  const off = window.guestsOffline || [];
  for (const o of off) {
    if (String(o.id) === String(id)) {
      return (typeof o.color === 'number' && o.color >= 0) ? o.color : -1;
    }
  }
  return -1;
}

function playerColorById(id) {
  return colorOf(colorIdxOfPlayer(id));
}

function remainingMs() {
  if (!gameIsRunning()) return GAME_DURATION;
  if (game.localStartAt > 0) {
    return Math.max(0, GAME_DURATION - (Date.now() - game.localStartAt));
  }
  const g = window.shared.game;
  if (g && typeof g.startAt === 'number') {
    return Math.max(0, GAME_DURATION - (Date.now() - g.startAt));
  }
  return GAME_DURATION;
}

// 自我重置（PLAY AGAIN / 新局）：各设备只改自己的 me
function resetMyPlayer() {
  // 把带走的 Object 放回地面（重载/迟到加入的孤儿 Object 保护）
  if (me.carryingObject) {
    const st = window.shared.objects && window.shared.objects[me.carryingObject];
    if (st && st.state === 'carried' && st.by === myOwnerId()) {
      window.shared.objects[me.carryingObject] = { state: 'ground' };
    }
  }
  if (me.baseX != null && me.baseY != null) {
    me.x = me.baseX;   // 回到自己的基地
    me.y = me.baseY;
  }
  me.carryingObject = null;
  me.delivered = 0;
  me.ready = false;              // 新一局：所有人恢复 Not Ready
  steal.deliveredByMe.clear();
  window.guestsOffline = [];     // 清掉上一局的离线快照
  game.scores = null;
  game.localStartAt = 0;
  game.lastAllReady = null;
  game.goFlashUntil = 0;
  // 视觉坐标直接落位到基地（回基地不跨图滑行）
  gameState.render.x = (me.baseX != null ? me.baseX : me.x) * CELL + CELL / 2;
  gameState.render.y = (me.baseY != null ? me.baseY : me.y) * CELL + CELL / 2;
}

// 每帧调用：局号推进 / 倒计时锁定 / 结束 / 计分
function updateGameFlow() {
  if (!window.shared.game) window.shared.game = { phase: 'lobby', round: 0 };
  const g = window.shared.game;
  const round = typeof g.round === 'number' ? g.round : 0;
  const phase = gamePhase();

  // 新一局（lobby / countdown / running）→ 每台设备自我重置一次（同时处理
  // PLAY AGAIN 与中途加入的竞态：以最终看到的局号为准，只重置一次）
  if (phase !== 'ended' && round !== game.lastResetRound) {
    game.lastResetRound = round;
    resetMyPlayer();
  }

  // 进入 running（以“阶段沿”为准，而不是局号：PLAY AGAIN 换局后
  // 阶段从 lobby → countdown → running 也必须重新锁定）
  if (phase === 'running' && game.lastPhase !== 'running') {
    game.lastPhase = 'running';
    game.localRound = round;
    game.goFlashUntil = Date.now() + 900;   // 开局显示 GO!
    // 正常开赛：以“本地收到时刻”起算，消除设备时钟差（各设备等长计时）；
    // 迟到加入 / 重载：startAt 已过去较久 → 用 startAt 反推剩余时间
    const late = typeof g.startAt === 'number' && Date.now() - g.startAt > 1500;
    game.localStartAt = late ? g.startAt : Date.now();
    // 开赛瞬间：占下自己的出生格（基地）。捕获“基地格”而不是“当前格”，
    // 不受帧时机影响——即使玩家在 latch 前已移动，出生格也自动归自己，
    // 路径格由移动本身完成占地。观战者不占地。
    if (!isSpectator() && me.baseX != null && me.baseY != null) captureCell(me.baseX, me.baseY);
  } else if (phase !== 'running') {
    game.lastPhase = phase;
    game.localRound = round;
  }

  // 倒计时归零 → 写 ended（多台同时写同一值，(ts,id) 统一裁决，先写先冻结）
  const online = !isShareConfigured() || isConnected();
  if (phase === 'running' && online && remainingMs() <= 0) {
    window.shared.game.phase = 'ended';
  }

  // 结束后每帧从共享状态重算（冻结期若有迟到的裁决补丁，结果保持最新）
  if (phase === 'ended') {
    game.scores = computeScores();
  }
}

/* ============================================================
 * READY 流程 —— 确定性开赛仲裁（公共 MQTT broker 无原子事务）
 *   全员就绪上升沿（false→true，且 phase=lobby）→ 写 countdown；
 *   countdown 期间非全员就绪 → 写 lobby 取消；
 *   countdown 归零 → 写 running（参与者名单沿用 countdown 的名单）。
 *   每一步都是阶段转换：先改本地 phase 再广播，(ts,id) LWW 收敛，
 *   不会因消息延迟重复触发（取消后必须重新出现上升沿才会再倒计时）。
 * ============================================================ */
function updateReadyFlow() {
  if (isShareConfigured() && !isConnected()) return;   // 未连接：不参与仲裁
  const g = window.shared.game;
  const round = gameRound();
  const p = gamePhase();

  if (p === 'lobby') {
    const allReady = allPlayersReady();
    if (allReady && game.lastAllReady !== true) {
      game.lastAllReady = true;   // 上升沿：只写一次
      const ids = currentParticipantIds();
      window.shared.game = {
        phase: 'countdown',
        round: round,
        readyAt: Date.now(),
        participants: ids,
        bases: computeBases(ids)      // 基地分配随参与者名单一起锁定
      };
    } else if (!allReady) {
      game.lastAllReady = false;
    }
    return;
  }

  if (p === 'countdown') {
    const readyAt = (typeof g.readyAt === 'number') ? g.readyAt : Date.now();
    const remain = READY_COUNTDOWN_MS - (Date.now() - readyAt);

    // 取消：有人取消准备 / 断线 / 新玩家加入（默认 Not Ready）
    if (!allPlayersReady()) {
      game.lastAllReady = false;
      window.shared.game = { phase: 'lobby', round: round, participants: [], bases: {} };
      return;
    }

    // 到点：统一开赛。多台同时写 running（同一 round、同一名单/基地），
    // (ts,id) LWW 收敛出唯一 startAt 与 Object 布局
    if (remain <= 0) {
      const ids = (g.participants && g.participants.length > 0)
        ? g.participants.map(String)
        : currentParticipantIds();
      const bases = (g.bases && typeof g.bases === 'object')
        ? g.bases
        : computeBases(ids.slice().sort());
      window.shared.game = {
        phase: 'running',
        round: round,
        startAt: Date.now(),
        participants: ids,
        bases: bases,
        objects: generateObjectLayout(round, ids.length)
      };
    }
    return;
  }

  // running / ended：记录当前就绪态（用于下一局 lobby 的上升沿检测）
  if (p === 'ended') {
    game.lastAllReady = false;
  }
}

function scoreOf(p) {
  let cells = 0;
  const cmap = window.shared.cells || {};
  for (const k in cmap) {
    if (cmap[k] && cmap[k].o === p.id) cells++;
  }
  let carried = 0;
  const objs = window.shared.objects || {};
  for (const k in objs) {
    const o = objs[k];
    if (o && o.state === 'carried' && o.by === p.id) carried++;
  }
  const delivered = typeof p.delivered === 'number' ? p.delivered : 0;
  return {
    id: p.id,
    color: typeof p.color === 'number' ? p.color : 0,
    cells,
    delivered,
    carried,
    total: cells * SCORE_CELL + delivered * SCORE_DELIVERED + carried * SCORE_CARRIED
  };
}

/* 按 id 找玩家快照：先自己，再在线 guests，最后离线快照（比赛中断线的参与者） */
function playerSnapshotFor(id) {
  if (String(id) === myOwnerId()) {
    return { id: String(id), color: me.color, delivered: me.delivered };
  }
  const gs = window.guests || [];
  for (const g of gs) {
    if (String(g.id) === String(id)) {
      return { id: String(id), color: g.color, delivered: g.delivered };
    }
  }
  const off = window.guestsOffline || [];
  for (const o of off) {
    if (String(o.id) === String(id)) {
      return { id: String(id), color: o.color, delivered: o.delivered };
    }
  }
  return null;
}

/* 只给本局参与者计分（中途加入的观战者不参与本局排名） */
function computeScores() {
  const ids = gameParticipants();
  if (ids.length === 0) return [];
  const list = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const p = playerSnapshotFor(id);
    if (!p) continue;
    if (typeof p.color !== 'number' || p.color < 0) p.color = 0;
    list.push(scoreOf(p));
  }
  list.sort((a, b) => b.total - a.total || a.color - b.color);   // 同分按颜色下标稳定排序，各设备排名一致
  return list;
}

// HUD 用：阶段 / 倒计时
function gameStatusText() {
  const p = gamePhase();
  if (p === 'running') return 'Time: ' + Math.ceil(remainingMs() / 1000) + 's';
  if (p === 'ended') return "Time's Up";
  if (p === 'countdown') return 'Starting…';
  return 'Waiting for Players';
}

/* ============================================================
 * 移动逻辑 —— 唯一入口，与输入方式无关
 * 只写自己的 me；边界检查在这里做（0 ~ GRID-1）。
 * 每次移动只处理“实际进入”的格子：顶墙没动时不触发占地/拾取。
 * ============================================================ */
function moveMe(dx, dy) {
  if (!gameIsRunning()) return;   // 比赛未开始 / 已结束：冻结，不能移动
  if (isSpectator()) return;      // 中途加入的观战者不能移动/占地/拾取
  const nx = constrain(me.x + dx, 0, GRID - 1);
  const ny = constrain(me.y + dy, 0, GRID - 1);
  if (nx === me.x && ny === me.y) return;   // 没动（顶墙）：不占地、不拾取
  me.x = nx;   // 已连接：自动同步；未连接：本地保存，连接时随 hello 补发
  me.y = ny;
  captureCell(nx, ny);   // 空手时占领（携带 Object 时内部跳过）
  tryPickup(nx, ny);     // 空手进入 Object 格 → 自动尝试拾取
  tryDeliver(nx, ny);    // 携带回到自己基地 → 自动交付
}

/* ============================================================
 * 占地 —— shared.cells["x,y"] = { o: 玩家ID, c: 颜色下标 }
 * 规则：
 *   · 空手玩家进入格子 → 格子归其所有（owner 初始为 null = 无此 key）
 *   · 进入他人格子 → 所有权立即转移（同 key 覆盖，服务器裁决顺序）
 *   · 携带 Object 的玩家移动不占领、不抢占任何格子；原有领地保留
 * ============================================================ */
function captureCell(x, y) {
  if (!gameIsRunning()) return;   // 比赛未开始 / 已结束：不占地
  if (me.carryingObject) return;  // 携带 Object 时不能占领

  const key  = x + ',' + y;
  const mine = myOwnerId();
  if (!mine) return;               // 还没连上服务器：不写本地占地（以服务器地图为准）

  const cells = window.shared.cells || (window.shared.cells = {});
  const cur = cells[key];
  if (cur && cur.o === mine) return;   // 已属于自己：不重复触发

  // 写入共享状态 → net.js 自动广播给所有手机（(ts,id) 统一裁决）
  cells[key] = {
    o: mine,
    c: (typeof me.color === 'number' && me.color >= 0) ? me.color : 0
  };
}

function cellOwner(x, y) {
  const cells = window.shared.cells;
  if (!cells) return null;
  return cells[x + ',' + y] || null;
}

// HUD 用：自己拥有的格子数量（仅本机显示，无全局排名）
function myCellCount() {
  const mine = myOwnerId();
  if (!mine) return 0;
  const cells = window.shared.cells || {};
  let n = 0;
  for (const key in cells) {
    const c = cells[key];
    if (c && c.o === mine) n++;
  }
  return n;
}

/* ============================================================
 * Object 系统 —— shared.objects[objId] = { state, by }
 *   state: 'ground'（在地上）| 'carried'（被携带）| 'delivered'（已交付）
 *   by    : 当前携带者 ID（ground 时无此字段）
 * 布局（id / emoji / 坐标）在 shared.game.objects，比赛开始时生成并锁定。
 * ============================================================ */

/* 本局 Object 布局（共享状态，所有设备一致） */
function gameObjects() {
  const g = window.shared.game;
  if (g && Array.isArray(g.objects)) return g.objects;
  return [];
}

function objectById(id) {
  const objs = gameObjects();
  for (const o of objs) {
    if (o.id === id) return o;
  }
  return null;
}

/* Object ID → Emoji（id 的编号与 OBJECT_EMOJIS 下标固定映射，
 * 不同设备对同一 ID 必然显示相同 Emoji；仅视觉，不参与同步） */
function objectEmoji(id) {
  const o = objectById(id);
  if (o && typeof o.emoji === 'string' && o.emoji.length > 0) return o.emoji;
  const m = /^o(\d+)$/.exec(String(id));
  const idx = m ? (parseInt(m[1], 10) - 1) : 0;
  return OBJECT_EMOJIS[((idx % OBJECT_EMOJIS.length) + OBJECT_EMOJIS.length) % OBJECT_EMOJIS.length];
}

// 每帧调用：按本局布局补齐/清理 Object 条目（中途加入/断线重连时自愈）
function healObjects() {
  if (!window.shared.objects) window.shared.objects = {};
  const objs = gameObjects();
  const ids = new Set();
  for (const o of objs) {
    ids.add(o.id);
    if (!window.shared.objects[o.id]) {
      window.shared.objects[o.id] = { state: 'ground' };
    }
  }
  // 清理不在本局布局里的陈旧条目（只做本地清理，不广播）
  for (const k of Object.keys(window.shared.objects)) {
    if (!ids.has(k)) delete window.shared.objects[k];
  }
}

function objectAt(x, y) {
  const objs = gameObjects();
  for (const o of objs) {
    if (o.x === x && o.y === y) return o;
  }
  return null;
}

// 空手玩家进入 Object 所在格时自动尝试拾取
function tryPickup(x, y) {
  if (me.carryingObject) return;      // 最多携带一个
  const obj = objectAt(x, y);
  if (!obj) return;
  const st = window.shared.objects && window.shared.objects[obj.id];
  if (!st || st.state !== 'ground') return;   // 已被人拿走 / 已交付
  claimObject(obj.id);
  setStealFeedback('Object Collected · ' + objectEmoji(obj.id) + ' ' + obj.id, FEEDBACK_OK);
}

/* 拾取宣告（同时是双指抢夺的转移入口）：
 * 写入 { carried, by:我的ID }；若同时有人抢同一 Object，
 * 各设备按 (ts, id) 统一裁决出唯一 by，输家由 resolveObjectConflicts() 自动放下。 */
function claimObject(objId) {
  const mine = myOwnerId();
  if (!mine) return;
  if (!objectById(objId)) return;   // 不在本局布局：忽略陈旧宣告
  if (!window.shared.objects) window.shared.objects = {};
  window.shared.objects[objId] = { state: 'carried', by: mine };
  me.carryingObject = objId;   // 记录 Object ID（不是 true/false）
}

// 携带 Object 回到自己的基地格 → 自动交付
function tryDeliver(x, y) {
  if (!me.carryingObject) return;
  if (me.baseX == null || me.baseY == null) return;
  if (x !== me.baseX || y !== me.baseY) return;   // 只在自己基地交付

  const objId = me.carryingObject;
  const st = window.shared.objects && window.shared.objects[objId];
  if (!st || st.state !== 'carried' || st.by !== myOwnerId()) {
    // 我其实没抢到（裁决输给了别人）→ 放下即可，不交付
    me.carryingObject = null;
    return;
  }
  if (!objectById(objId)) {
    // 携带的是上一局的陈旧 Object（新局布局已变）→ 直接放下
    me.carryingObject = null;
    return;
  }
  window.shared.objects[objId] = { state: 'delivered', by: myOwnerId() };
  me.carryingObject = null;                     // 清空 → 恢复占地能力
  me.delivered = (typeof me.delivered === 'number' ? me.delivered : 0) + 1;
  steal.deliveredByMe.add(objId);               // 守护：防止被迟到的抢夺宣告复活
  setStealFeedback('Object Delivered! +30', FEEDBACK_OK);
}

// 每帧调用：裁决回滚 —— 若我携带的 Object 的 by 已不是我（服务器判定别人
// 拾取/抢夺成功），自动放下，保证所有设备最终一致、只有一个携带者
function resolveObjectConflicts() {
  if (!me.carryingObject) return;
  const st = window.shared.objects && window.shared.objects[me.carryingObject];
  if (!st) return;
  if (st.state === 'delivered') {
    me.carryingObject = null;   // 已被交付 → 放下
    return;
  }
  if (st.state === 'carried' && st.by !== myOwnerId()) {
    const lost = me.carryingObject;
    me.carryingObject = null;   // 被抢 / 抢拾输了 → 放下，恢复占地能力
    setStealFeedback('Lost ' + lost + '!', FEEDBACK_FAIL);
  }
}

/* ============================================================
 * 抢夺（Steal）—— 双指同时点击游戏画面
 * 规则：
 *   · 只有与携带 Object 的玩家曼哈顿距离 ≤ 1 格才能抢；
 *   · 抢夺者必须空手；不能抢自己；
 *   · 成功 = 复用 claimObject()（Object 所有权转移）：
 *     原携带者在 resolveObjectConflicts() 里自动放下并恢复占地；
 *   · 1.5s 冷却（每次尝试都进入冷却，防止无限来回抢）；
 *   · 双指点击不触发 Swipe（滑动手势在第二根手指落下时作废）、
 *     不触发缩放（画布 touch-action: none + gesturestart 拦截）。
 * 并发说明（不冒充原子性）：双方同时抢同一携带者时，各设备按 (ts, id)
 * 定出唯一 by，输家自动放下（同抢拾的“宣告 + 回滚”机制）。
 * ============================================================ */
const STEAL_COOLDOWN = 1500;   // 抢夺冷却（ms）

const FEEDBACK_OK   = [255, 209, 102];   // 金色：成功
const FEEDBACK_FAIL = [255, 112, 102];   // 红色：失败
const FEEDBACK_COOL = [185, 195, 215];   // 灰蓝：冷却

const steal = {
  cooldownUntil: 0,
  feedback: null,                 // { text, color, until }
  deliveredByMe: new Set()        // 我交付过的 Object（本会话，守护已交付状态）
};

// 双指点按状态：pointerId → 按下时间
const twoFinger = { pointers: new Map(), fired: false };

function setStealFeedback(text, color) {
  steal.feedback = { text, color, until: millis() + 1300 };
}

// 最近的携带者（不含自己）
function nearestCarrier() {
  let best = null, bestD = Infinity;
  const gs = window.guests || [];
  for (const g of gs) {
    if (!g.carryingObject) continue;
    const d = Math.abs(g.x - me.x) + Math.abs(g.y - me.y);   // 曼哈顿距离
    if (d < bestD) { bestD = d; best = g; }
  }
  return best ? { g: best, d: bestD } : null;
}

// 一次抢夺尝试（由双指点击触发）
function trySteal() {
  const now = millis();
  if (now < steal.cooldownUntil) {
    setStealFeedback('Cooldown…', FEEDBACK_COOL);
    return;
  }
  steal.cooldownUntil = now + STEAL_COOLDOWN;   // 每次尝试都进入冷却

  if (isShareConfigured() && !isConnected()) {
    setStealFeedback('Not Connected', FEEDBACK_FAIL);
    return;
  }
  if (!gameIsRunning()) {
    setStealFeedback('Game not started', FEEDBACK_FAIL);
    return;
  }
  if (isSpectator()) {
    setStealFeedback('Spectator · cannot steal', FEEDBACK_FAIL);
    return;
  }
  if (me.carryingObject) {
    setStealFeedback('Hands Full', FEEDBACK_FAIL);
    return;
  }
  const t = nearestCarrier();
  if (!t) {
    setStealFeedback('No carrier nearby', FEEDBACK_FAIL);
    return;
  }
  if (t.d > 1) {
    setStealFeedback('Too Far · need adjacent tile', FEEDBACK_FAIL);
    return;
  }
  const objId = t.g.carryingObject;
  const st = window.shared.objects && window.shared.objects[objId];
  if (!st || st.state !== 'carried') {
    setStealFeedback('Object no longer carried', FEEDBACK_FAIL);   // 已被交付/转移
    return;
  }
  claimObject(objId);   // 所有权转移：原携带者会自动放下
  setStealFeedback('Object Stolen · ' + objectEmoji(objId) + ' ' + objId + '!', FEEDBACK_OK);
}

// 每帧调用：守护“已交付”状态 —— 若我交付过的 Object 被迟到的抢夺宣告
// 复活成 carried，就重新写回 delivered（抢夺者会因此自动放下）。
// 这是对“已交付 Object 不允许被复活”的最终一致性保障；我离线后此守护
// 随之消失，属已知限制。
function assertDelivered() {
  if (steal.deliveredByMe.size === 0) return;
  for (const objId of steal.deliveredByMe) {
    const st = window.shared.objects && window.shared.objects[objId];
    if (st && st.state === 'carried') {
      window.shared.objects[objId] = { state: 'delivered', by: myOwnerId() };
    }
  }
}

// 抢夺/冷却/失败反馈浮层
function drawStealFeedback() {
  if (!steal.feedback) return;
  if (millis() > steal.feedback.until) {
    steal.feedback = null;
    return;
  }
  const a = constrain((steal.feedback.until - millis()) / 300, 0, 1);
  const w = 210, h = 36;
  const cx = width / 2, cy = height * 0.32;
  noStroke();
  fill(0, 0, 0, 130 * a);
  rect(cx - w / 2, cy - h / 2, w, h, 10);
  fill(steal.feedback.color[0], steal.feedback.color[1], steal.feedback.color[2], 255 * a);
  textSize(15);
  textAlign(CENTER, CENTER);
  text(steal.feedback.text, cx, cy);
}

/* ============================================================
 * FINAL RESULTS —— 独立 HTML/CSS 覆盖层（Premium Dark UI）
 * · 覆盖在 Canvas 上方，不透明深灰背景，文字高对比；
 * · 放大的 24×24 完整地图（正方形、约 92% 屏宽、与主画面一致的
 *   商务灰倒角地砖风格）；
 * · 排行榜支持纵向滚动，排名/颜色/编号/总分一眼可读，自己高亮；
 * · PLAY AGAIN 固定在面板底部，不会被滚动内容遮挡。
 * ============================================================ */
let resultsShown = false;

function updateResultsOverlay() {
  const overlay = document.getElementById('results-overlay');
  if (!overlay) return;
  if (gamePhase() === 'ended') {
    if (!resultsShown) {
      resultsShown = true;
      overlay.hidden = false;      // 先显示再构建：布局尺寸此时才可测量
      buildResultsOverlay();
    }
  } else {
    if (resultsShown) {
      resultsShown = false;
      overlay.hidden = true;
    }
  }
}

function buildResultsOverlay() {
  renderResultsMap();
  renderResultsList();
}

/* 放大地图：2D canvas 直接绘制（与主画面同一套地砖配色与倒角） */
function renderResultsMap() {
  const canvas = document.getElementById('results-map');
  const wrap = document.getElementById('results-map-wrap');
  if (!canvas || !wrap) return;
  const size = Math.floor(wrap.clientWidth);
  if (size <= 0) return;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = MAP_BG;
  ctx.fillRect(0, 0, size, size);

  const ts = size / GRID;   // 每格像素
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const cell = cellOwner(x, y);
      const idx = cell ? colorIdxOfPlayer(cell.o) : -1;
      const col = (cell && idx >= 0) ? tileColorOfIdx(idx) : NEUTRAL_TILE;
      drawTileBevel2D(ctx, x * ts + 0.5, y * ts + 0.5, ts - 1, ts - 1, col, Math.max(2, ts * 0.1));
    }
  }
}

/* 2D 版倒角地砖（供结算地图用，与 p5 版视觉一致） */
function drawTileBevel2D(ctx, x, y, w, h, col, r) {
  ctx.fillStyle = 'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')';
  roundRect2D(ctx, x, y, w, h, r);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  roundRect2D(ctx, x + 1, y + 1, w - 2, h * 0.18, Math.max(1, r - 1));
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.13)';
  roundRect2D(ctx, x + 1, y + h - 1 - h * 0.18, w - 2, h * 0.18, Math.max(1, r - 1));
  ctx.fill();

  ctx.strokeStyle = 'rgba(68,75,86,0.5)';
  ctx.lineWidth = 0.5;
  roundRect2D(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.stroke();
}

function roundRect2D(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  // 兜底：手绘圆角矩形
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function renderResultsList() {
  const listEl = document.getElementById('results-list');
  if (!listEl) return;
  const sc = game.scores || [];
  let html = '';
  for (let i = 0; i < sc.length; i++) {
    const p = sc[i];
    const col = PALETTE[p.color % PALETTE.length];
    const isMe = p.id === myOwnerId();
    const name = 'P' + (p.color + 1) + (isMe ? ' <span class="me-tag">YOU</span>' : '');
    html +=
      '<div class="rrow' + (isMe ? ' me' : '') + '">' +
        '<div class="rrank">' + (i + 1) + '</div>' +
        '<div class="rdot" style="background:rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')"></div>' +
        '<div class="rname">' + name + '</div>' +
        '<div class="rtotal">' + p.total + ' <span style="font-size:12px;color:#c6ccd8">pts</span></div>' +
      '</div>' +
      '<div class="rdetail">Territory ' + p.cells + ' &nbsp;·&nbsp; Delivered ' + p.delivered +
        ' &nbsp;·&nbsp; Carried ' + p.carried + '</div>';
  }
  listEl.innerHTML = html;
}

// 双指同时点击画布（< 350ms 内两根手指都按下）→ 触发一次抢夺尝试
function bindTwoFingerTap(canvasEl) {
  canvasEl.addEventListener('pointerdown', (e) => {
    twoFinger.pointers.set(e.pointerId, { t0: performance.now() });
    if (twoFinger.pointers.size === 2 && !twoFinger.fired) {
      const times = Array.from(twoFinger.pointers.values()).map((p) => p.t0);
      if (Math.max(...times) - Math.min(...times) < 350) {
        twoFinger.fired = true;   // 手势结束（全部抬起）前只触发一次
        trySteal();
      }
    }
  });
  const release = (e) => {
    twoFinger.pointers.delete(e.pointerId);
    if (twoFinger.pointers.size === 0) twoFinger.fired = false;
  };
  canvasEl.addEventListener('pointerup', release);
  canvasEl.addEventListener('pointercancel', release);
}

/* ============================================================
 * 颜色分配（每帧调用，仅在已连接时生效）
 * · 颜色从 30 色调色板中取第一个空闲色（确定性规则）；
 * · 冲突解决：两台同时拿到同色时，玩家 ID 字典序小者保留、大者让位
 *   重选——所有设备收敛到同一结果，不依赖随机；
 * · 比赛中冻结：参与者一旦开赛颜色不再变化（保证同一局颜色/编号稳定），
 *   观战者仍可正常解决冲突；
 * · 出生位置不再与颜色绑定：初始站在地图中央，开赛前由基地分配落位。
 * ============================================================ */
function ensureMyColor() {
  if (!isConnected()) return;
  const myId = getMyId();
  const gs = window.guests || [];
  const myColor = typeof me.color === 'number' ? me.color : -1;

  // 比赛中冻结参与者的颜色（保证同一局内颜色/编号稳定）
  if (gameIsRunning() && myColor >= 0 && amIParticipant()) return;

  // 已有颜色且不冲突 → 不动
  if (myColor >= 0 && myColor < PALETTE.length) {
    const clash = gs.find(g => g.color === myColor && String(g.id) > myId);
    if (!clash) return;
  }

  // 新玩家分配 / 冲突让位：找第一个空闲颜色（未分配 -1 和越界值不算占用）
  const used = new Set();
  for (const g of gs) {
    if (typeof g.color === 'number' && g.color >= 0 && g.color < PALETTE.length) {
      used.add(g.color);
    }
  }
  let idx = 0;
  while (used.has(idx) && idx < PALETTE.length) idx++;
  idx = idx % PALETTE.length;

  me.color = idx;
  // 位置与基地不再在这里设置：新玩家站在地图中央等待，开赛前由
  // shared.game.bases 统一落位（applyMyBase）。
}

/* ============================================================
 * 摄像机与视觉坐标 —— Camera Follow（只跟随自己的角色 me）
 * 逻辑坐标 me.x/me.y 保持整数格（占地/拾取/抢夺/交付的判断基础）；
 * 视觉坐标 gameState.render 用指数平滑追赶目标格：
 *   render += (target - render) * (1 - e^(-k·dt))
 * 基于 deltaTime，与帧率无关；k=16 时约 145ms 收敛 90%（120–160ms
 * 目标区间），ease-out 缓动，连续移动自然衔接、无逐格停顿。
 * 其他玩家的位置同样在本地插值（网络只发逻辑坐标，不发视觉坐标）。
 * ============================================================ */
function frameDelta() {
  // p5 的 deltaTime（毫秒），钳制上限避免切后台回来时的大跳变
  return Math.min((typeof deltaTime === 'number' && deltaTime > 0 ? deltaTime : 16.7), 50) / 1000;
}

function smoothStep(cur, target, k, dt) {
  return cur + (target - cur) * (1 - Math.exp(-k * dt));
}

/* 每帧：本机角色 + 所有 guests 的视觉坐标向逻辑格平滑追赶 */
function updateRender(dt) {
  const tx = (me.x + 0.5) * CELL;
  const ty = (me.y + 0.5) * CELL;
  gameState.render.x = smoothStep(gameState.render.x, tx, MOVE_SMOOTH_K, dt);
  gameState.render.y = smoothStep(gameState.render.y, ty, MOVE_SMOOTH_K, dt);

  const gs = window.guests || [];
  for (const g of gs) {
    if (typeof g.rx !== 'number' || typeof g.ry !== 'number') {
      g.rx = (g.x + 0.5) * CELL;
      g.ry = (g.y + 0.5) * CELL;
      continue;
    }
    g.rx = smoothStep(g.rx, (g.x + 0.5) * CELL, MOVE_SMOOTH_K, dt);
    g.ry = smoothStep(g.ry, (g.y + 0.5) * CELL, MOVE_SMOOTH_K, dt);
  }
}

function clampCam(tx, ty) {
  return {
    x: WORLD_W <= width  ? (WORLD_W - width)  / 2 : constrain(tx, 0, WORLD_W - width),
    y: WORLD_H <= height ? (WORLD_H - height) / 2 : constrain(ty, 0, WORLD_H - height)
  };
}

function camTarget() {
  return {
    x: gameState.render.x - width / 2,
    y: gameState.render.y - height / 2
  };
}

function updateCamera(dt) {
  const cam = gameState.camera;
  const t = clampCam(camTarget().x, camTarget().y);
  cam.x = smoothStep(cam.x, t.x, CAM_SMOOTH_K, dt);   // 平滑跟随视觉坐标
  cam.y = smoothStep(cam.y, t.y, CAM_SMOOTH_K, dt);
}

/* ============================================================
 * 倾斜传感器 —— 自动授权 / 自动校准 / 死区 / 定间隔移动
 * · 无需 CALIBRATE 按钮：首次读到传感器数据即以当前握持角度作为
 *   中立角自动校准（不会产生突然移动）；
 * · iOS 需要授权的设备：在用户点击 JOIN / READY 的用户手势里自动
 *   调用 requestPermission()（只自动请求一次，不反复弹出）；
 *   被拒绝后，再次点击 READY 会作为“重新授权入口”重试；
 * · 权限失败不影响 JOIN / 联机 / 滑动操作。
 * ============================================================ */
function needsSensorPermission() {
  return (
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function'
  );
}

// 当前屏幕方向：0 竖屏，90 / -90 横屏
function screenAngle() {
  if (window.screen && screen.orientation && typeof screen.orientation.angle === 'number') {
    return screen.orientation.angle;
  }
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

function onDeviceOrientation(e) {
  const g = e.gamma, b = e.beta;
  if (g == null || b == null || isNaN(g) || isNaN(b)) return;

  const angle = Math.abs(screenAngle());
  const tilt = (angle === 90 || angle === 270) ? -b : g;  // 横屏时轴对调（降级）

  const first = sensors.latest == null;
  sensors.latest = tilt * TILT_SIGN;
  sensors.available = true;

  // 首次读数（或授权后等待数据）→ 以当前握持角度自动校准，且 dir 归零：
  // 校准瞬间绝不会触发移动
  if (first || sensors.pendingCalibrate) {
    sensors.pendingCalibrate = false;
    sensors.neutral = sensors.latest;
    sensors.calibrated = true;
    sensors.dir = 0;
  }
}

/* 以当前姿态自动校准（仅内部调用） */
function autoCalibrate() {
  if (sensors.latest != null) {
    sensors.neutral = sensors.latest;
    sensors.calibrated = true;
    sensors.dir = 0;
  } else {
    sensors.pendingCalibrate = true;   // 还没数据：等第一条读数到达再校准
  }
}

function requestMotionPermission() {
  try {
    DeviceOrientationEvent.requestPermission()
      .then((state) => {
        if (state === 'granted') {
          sensors.denied = false;
          autoCalibrate();
          flashStatus('Motion Access Allowed', 2000);
        } else {
          sensors.denied = true;
          flashStatus('Motion Access Denied', 3000);
        }
      })
      .catch(() => {
        sensors.denied = true;
        flashStatus('Motion Access Denied', 3000);
      });
  } catch (err) {
    sensors.permissionAsked = false;   // 异常：保留下次手势再试的机会
  }
}

/* 在用户手势（JOIN / READY 点击）内调用：
 * · 首次：自动请求授权（只自动请求一次，绝不反复弹出）；
 * · 已被拒绝：用户主动点击 READY 即“重新授权入口”（iOS 若系统层面
 *   已永久拒绝，重复调用会直接返回 denied，需用户在系统设置里开启）。 */
function ensureMotionPermission() {
  if (debugState.mode) return;
  if (!needsSensorPermission()) return;   // Android/桌面：无需授权，直接监听
  if (!sensors.permissionAsked) {
    sensors.permissionAsked = true;
    requestMotionPermission();
  } else if (sensors.denied) {
    requestMotionPermission();
  }
}

// 每帧调用：越过死区立即移动一格，之后按固定间隔连续移动；回到中立停止
function updateTilt() {
  if (isSpectator()) return;             // 观战者不能用倾斜移动
  if (!sensors.calibrated || sensors.latest == null) return;
  const d = sensors.latest - sensors.neutral;
  const dir = d > TILT_DEADZONE ? 1 : d < -TILT_DEADZONE ? -1 : 0;

  if (dir === 0) {
    sensors.dir = 0;
    return;
  }

  const now = millis();
  if (dir !== sensors.dir) {
    sensors.dir = dir;
    sensors.lastMoveAt = now;
    moveMe(dir, 0);                      // 刚越过阈值：立即走一格
  } else if (now - sensors.lastMoveAt >= TILT_INTERVAL) {
    sensors.lastMoveAt = now;
    moveMe(dir, 0);                      // 保持倾斜：按固定间隔走格
  }
}

// 尽力锁定竖屏；不支持则静默忽略（布局本身自适应）
function tryLockPortrait() {
  try {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('portrait').catch(() => {});
    }
  } catch (err) { /* 忽略 */ }
}

/* ============================================================
 * 渲染 —— 只负责画，不负责改数据
 * 地砖风格：中性商务灰 + 轻微倒角（顶部/左侧高光、底部/右侧阴影）
 * + 3–5px 圆角 + 1px 间隙。被占领的地砖保持同一套倒角，仅底色换成
 * 玩家的调和色；所有权变化时做 150ms 颜色过渡（纯视觉，不触碰
 * 共享状态，不影响同步）。
 * ============================================================ */

/* 每格领地易主的视觉过渡状态（key → {from,to,t0,dur}） */
const cellVisual = {
  lastOwner: new Map(),
  trans: new Map()
};

function cellVisualColor(x, y, ownerId, target) {
  const key = x + ',' + y;
  const lastO = cellVisual.lastOwner.get(key);
  const now = millis();
  const t = cellVisual.trans.get(key);

  // 所有权变化 → 从当前显示色过渡到目标色（easeOutQuad，150ms）
  if (lastO !== ownerId) {
    const from = (t && t.to) ? t.to : target;
    cellVisual.trans.set(key, { from: from, to: target, t0: now, dur: CELL_TAKE_MS });
    cellVisual.lastOwner.set(key, ownerId);
    return from;
  }

  if (!t) return target;
  const k = constrain((now - t.t0) / t.dur, 0, 1);
  if (k >= 1) {
    cellVisual.trans.delete(key);
    return target;
  }
  const e = 1 - (1 - k) * (1 - k);
  return [
    t.from[0] + (t.to[0] - t.from[0]) * e,
    t.from[1] + (t.to[1] - t.from[1]) * e,
    t.from[2] + (t.to[2] - t.from[2]) * e
  ];
}

function drawTiles() {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const cell = cellOwner(x, y);
      // 被占领格使用“主人当前颜色”（而非 cell.c 快照），保证颜色重分配后
      // 地砖、角色、基地、结算全部一致
      const ownerColorIdx = cell ? colorIdxOfPlayer(cell.o) : -1;
      const target = (cell && ownerColorIdx >= 0)
        ? tileColorOfIdx(ownerColorIdx)
        : NEUTRAL_TILE;
      const col = cellVisualColor(x, y, cell ? cell.o : null, target);
      drawTileBevel(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2, col, TILE_R);
    }
  }
}

/* 单块倒角地砖：底色 + 上/左高光 + 下/右阴影 + 细边框 + 圆角 */
function drawTileBevel(x, y, w, h, col, r) {
  noStroke();
  fill(col[0], col[1], col[2]);
  rect(x, y, w, h, r);

  // 顶部高光
  fill(255, 255, 255, 26);
  rect(x + 1, y + 1, w - 2, h * 0.18, r - 1, r - 1, 0, 0);
  // 左侧高光
  fill(255, 255, 255, 13);
  rect(x + 1, y + 1, w * 0.18, h - 2, r - 1, 0, 0, r - 1);
  // 底部阴影
  fill(0, 0, 0, 34);
  rect(x + 1, y + h - 1 - h * 0.18, w - 2, h * 0.18, 0, 0, r - 1, r - 1);
  // 右侧阴影
  fill(0, 0, 0, 20);
  rect(x + w - 1 - w * 0.18, y + 1, w * 0.18, h - 2, 0, r - 1, r - 1, 0);

  // 细边框
  noFill();
  stroke(TILE_BORDER[0], TILE_BORDER[1], TILE_BORDER[2], 120);
  strokeWeight(1);
  rect(x + 0.5, y + 0.5, w - 1, h - 1, r);
  noStroke();
}

function drawBorder() {
  noFill();
  stroke(255, 255, 255, 60);
  strokeWeight(2);
  rect(0.5, 0.5, WORLD_W - 1, WORLD_H - 1);
}

/* 地面上的 Object（state = ground 才画）：Emoji 泡泡
 * · 统一金色强调：半透明深色泡泡 + 亮色边框 + 缓慢呼吸光晕；
 * · 轻微上下浮动，一眼区别于普通灰色地砖；
 * · Emoji 兼容性：p5 的 text() 走 canvas fillText，iPhone Safari 与
 *   Android Chrome 均自带彩色 Emoji 字体，可正常渲染。兜底：泡泡本体
 *   仍清晰标记物品位置，反馈文案中也带 Object ID。 */
function drawObjects() {
  const objs = gameObjects();
  for (const o of objs) {
    const st = window.shared.objects && window.shared.objects[o.id];
    if (!st || st.state !== 'ground') continue;   // 被携带 / 已交付的不画在地上

    const cx = o.x * CELL + CELL / 2;
    const cy = o.y * CELL + CELL / 2;
    // 轻微上下浮动 + 呼吸（相位按 id 错开，精致克制）
    const phase = (parseInt(String(o.id).slice(1), 10) || 1) * 1.7;
    const floatY = Math.sin(millis() / 340 + phase) * CELL * 0.07;
    drawEmojiBubble(objectEmoji(o.id), cx, cy + floatY, CELL * 0.7, millis(), phase);
  }
}

/* Emoji 泡泡：半透明深色圆底 + 金色亮边 + 缓慢呼吸光晕。size 为泡泡直径。 */
function drawEmojiBubble(emoji, cx, cy, size, now, phase) {
  const breathe = 1 + 0.045 * Math.sin((now || millis()) / 900 + (phase || 0));
  const r = (size * breathe) / 2;

  // 外层光晕（呼吸）
  noStroke();
  fill(255, 209, 102, 34 * (0.6 + 0.4 * Math.sin((now || millis()) / 900 + (phase || 0))));
  circle(cx, cy, size * 1.22 * breathe);

  // 泡泡主体：半透明深色
  fill(24, 28, 36, 215);
  circle(cx, cy, size * breathe);

  // 金色亮边
  noFill();
  stroke(255, 209, 102, 200);
  strokeWeight(2);
  circle(cx, cy, size * breathe);
  noStroke();

  // 顶部高光（泡泡质感）
  fill(255, 255, 255, 26);
  circle(cx - r * 0.3, cy - r * 0.35, r * 0.55);

  // Emoji
  const ch = (typeof emoji === 'string' && emoji.length > 0) ? emoji : '?';
  textAlign(CENTER, CENTER);
  textSize(size * 0.58);
  fill(255);
  text(ch, cx, cy + size * 0.02);
}

/* 各玩家基地标记（小旗）：基地位置来自共享状态 shared.game.bases
 * （与颜色解耦），颜色取该玩家当前代表色 */
function drawBaseMarkers() {
  const g = window.shared.game;
  const bases = (g && g.bases && typeof g.bases === 'object') ? g.bases : null;
  if (bases) {
    for (const id of Object.keys(bases)) {
      const b = bases[id];
      if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') continue;
      drawBaseMarker(b.x, b.y, playerColorById(id), String(id) === myOwnerId());
    }
    return;
  }
  // 兜底（无 bases 的旧状态）：用 me / guests 自带的 baseX/baseY
  if (me.baseX != null && me.baseY != null) {
    drawBaseMarker(me.baseX, me.baseY, colorOf(me.color), true);
  }
  const gs = window.guests || [];
  for (const g of gs) {
    if (typeof g.color !== 'number' || g.color < 0) continue;
    if (g.baseX == null || g.baseY == null) continue;
    drawBaseMarker(g.baseX, g.baseY, colorOf(g.color), false);
  }
}

function drawBaseMarker(x, y, col, isSelf) {
  const cx = x * CELL + CELL / 2;
  const cy = y * CELL + CELL / 2;
  noStroke();
  fill(255, 255, 255, 200);
  rect(cx + CELL * 0.18, cy - CELL * 0.32, CELL * 0.05, CELL * 0.42);   // 旗杆
  fill(col);
  triangle(cx + CELL * 0.2, cy - CELL * 0.3,          // 旗面
           cx + CELL * 0.42, cy - CELL * 0.22,
           cx + CELL * 0.2, cy - CELL * 0.14);
  if (isSelf) {
    fill(255);
    textSize(10);
    textAlign(CENTER, TOP);
    text('BASE', cx + CELL * 0.16, cy - CELL * 0.5);
  }
}

function colorOf(i) {
  return PALETTE[typeof i === 'number' && i >= 0 && i < PALETTE.length ? i : 0];
}

// 渲染自己（me）+ 所有在线玩家（guests，由 net.js 自动维护）
// 全部使用视觉坐标（本机 gameState.render，guests 的 g.rx/g.ry）
function drawPlayers() {
  drawOnePlayer(
    gameState.render.x, gameState.render.y,
    colorOf(me.color), me.carryingObject, me.color, true
  );

  const gs = window.guests || [];
  for (const g of gs) {
    // 新玩家还没完成颜色分配（color 仍为 -1）时不画，避免灰圈闪烁
    if (typeof g.color !== 'number' || g.color < 0) continue;
    if (typeof g.rx !== 'number') { g.rx = (g.x + 0.5) * CELL; g.ry = (g.y + 0.5) * CELL; }
    drawOnePlayer(g.rx, g.ry, colorOf(g.color), g.carryingObject, g.color, false);
  }
}

function drawOnePlayer(cx, cy, col, objId, colorIdx, isSelf) {
  // 影子
  noStroke();
  fill(0, 0, 0, 60);
  ellipse(cx, cy + CELL * 0.3, CELL * 0.72, CELL * 0.26);

  // 角色：彩色圆形（自己描边更醒目）
  fill(col);
  stroke(255, 255, 255, isSelf ? 255 : 180);
  strokeWeight(isSelf ? 3 : 2);
  circle(cx, cy, CELL * 0.66);

  // 编号徽章（30 人颜色相近时仍可区分，编号 = 颜色下标 + 1）
  const num = String(((colorIdx % PALETTE.length) + PALETTE.length) % PALETTE.length + 1);
  noStroke();
  fill(255);
  circle(cx + CELL * 0.22, cy - CELL * 0.22, 15);
  fill(30, 30, 42);
  textSize(9);
  textAlign(CENTER, CENTER);
  text(num, cx + CELL * 0.22, cy - CELL * 0.22 + 0.5);

  // 自己头顶的标记
  if (isSelf) {
    noStroke();
    fill(255);
    textSize(11);
    textAlign(CENTER, BOTTOM);
    text('YOU', cx, cy - CELL * 0.5);
  }

  // 携带 Object：头顶显示对应 Emoji 小泡泡（其他玩家同样可见，objId 来自共享状态）
  if (objId) {
    const y0 = cy - (isSelf ? CELL * 0.85 : CELL * 0.68);
    const s = isSelf ? CELL * 0.46 : CELL * 0.4;
    drawEmojiBubble(objectEmoji(objId), cx, y0, s, millis(), 2.2);
  }
}

/* 屏幕边缘指向自己基地的箭头：按自己基地坐标 + 摄像机实时计算方向，
 * 颜色用玩家代表色 + 白色描边保证对比；携带 Object 时更大更醒目；
 * 边距避开顶部 HUD 与底部按钮区。 */
function drawBaseArrow() {
  const bx = me.baseX, by = me.baseY;
  if (bx == null || by == null) return;

  // 基地的世界坐标 → 屏幕坐标
  const sx = bx * CELL + CELL / 2 - gameState.camera.x;
  const sy = by * CELL + CELL / 2 - gameState.camera.y;
  const marginTop = 100;      // 避开 HUD 顶栏与信息行
  const marginBot = 130;      // 避开底部按钮区
  const marginSide = 26;
  if (sx > marginSide && sx < width - marginSide &&
      sy > marginTop && sy < height - marginBot) {
    return;   // 基地在屏幕内：不用箭头
  }

  const ang = Math.atan2(sy - height / 2, sx - width / 2);
  const tx = Math.cos(ang), ty = Math.sin(ang);
  // 从屏幕中心沿方向与边缘矩形（含边距）求交点
  const kx = Math.abs(tx) < 1e-6 ? Infinity : ((tx > 0 ? width - marginSide : marginSide) - width / 2) / tx;
  const ky = Math.abs(ty) < 1e-6 ? Infinity : ((ty > 0 ? height - marginBot : marginTop) - height / 2) / ty;
  const k = Math.min(kx, ky);
  const ax = width / 2 + tx * k;
  const ay = height / 2 + ty * k;

  const carrying = !!me.carryingObject;
  const pulse = carrying ? 1 + 0.12 * Math.sin(millis() / 160) : 1;
  const s = (carrying ? 18 : 13) * pulse;

  push();
  translate(ax, ay);
  rotate(ang);
  const col = colorOf(me.color);
  noStroke();
  fill(col[0], col[1], col[2], carrying ? 255 : 235);
  triangle(s, 0, -s * 0.6, -s * 0.6, -s * 0.6, s * 0.6);
  // 白色描边：与深灰背景保持足够对比
  noFill();
  stroke(255, 255, 255, 220);
  strokeWeight(2);
  triangle(s, 0, -s * 0.6, -s * 0.6, -s * 0.6, s * 0.6);
  pop();
}

// HUD：顶栏（游戏名 / 在线人数 / 时间 + 网络状态点）+ 两行精简信息。
// 不显示 X/Y 等冗余文字，尽量少遮挡游戏画面。
function drawHUD() {
  const p = gamePhase();
  const online = onlineCount();
  const playersText = online === 1 ? '1 Player' : online + ' Players';

  // 顶栏背景
  noStroke();
  fill(0, 0, 0, 0.45);
  rect(0, 0, width, 46, 0, 0, 10, 10);

  // 左：游戏名
  textAlign(LEFT, CENTER);
  textSize(14);
  fill(255);
  text('Territory Heist', 12, 14);

  // 中：在线人数；等待阶段附 Ready: n/m
  textAlign(CENTER, CENTER);
  fill(255, 225, 140);
  textSize(14);
  text(playersText, width / 2, 14);
  if (p === 'lobby') {
    textSize(11);
    fill(190, 225, 255);
    text('Ready: ' + readyCount() + '/' + online, width / 2, 32);
  } else if (isSpectator()) {
    textSize(11);
    fill(255, 190, 130);
    text('Spectator', width / 2, 32);
  }

  // 右：时间
  textAlign(RIGHT, CENTER);
  textSize(14);
  fill(255);
  text(timeText(), width - 42, 14);

  // 网络状态小圆点（绿=已连接 / 黄=连接中 / 红=失败 / 灰=未加入）
  const dot = netDotColor();
  noStroke();
  fill(dot[0], dot[1], dot[2]);
  circle(width - 16, 22, 10);

  // 第二行：玩家状态（领地 / 交付 / 携带）
  textAlign(LEFT, TOP);
  textSize(12);
  fill(230, 230, 240);
  let info = 'Territory ' + myCellCount() + ' · Delivered ' + (typeof me.delivered === 'number' ? me.delivered : 0);
  if (me.carryingObject) info += ' · Carrying ' + objectEmoji(me.carryingObject);
  if (isSpectator()) info = 'Spectator · watching this round';
  text(info, 12, 52);

  // 第三行：倾斜状态（诊断模式不显示）
  if (!debugState.mode) {
    textSize(11);
    fill(205, 205, 220);
    text(sensorStatusText(), 12, 68);
  }
}

function timeText() {
  const p = gamePhase();
  if (p === 'running') {
    const s = Math.max(0, Math.ceil(remainingMs() / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return mm + ':' + ss;
  }
  if (p === 'countdown') return 'Starting…';
  if (p === 'ended') return "Time's Up";
  return 'Waiting';
}

function netDotColor() {
  if (debugState.mode) return [150, 155, 170];
  if (!isShareConfigured()) return [150, 155, 170];
  const st = window.shareStatus;
  if (st === 'connected') return [126, 231, 135];
  if (st === 'connecting') return [240, 198, 116];
  if (st === 'error' || st === 'unsupported') return [255, 123, 114];
  return [150, 155, 170];
}

/* 开赛倒计时：countdown 阶段显示 3 / 2 / 1，刚进入 running 显示 GO! */
function drawCountdown() {
  const p = gamePhase();
  if (p === 'countdown') {
    const g = window.shared.game;
    const readyAt = (typeof g.readyAt === 'number') ? g.readyAt : Date.now();
    const remain = READY_COUNTDOWN_MS - (Date.now() - readyAt);
    if (remain <= 0) return;
    const n = Math.min(3, Math.max(1, Math.ceil(remain / 1000)));
    bigCenterText(String(n));
  } else if (p === 'running' && Date.now() < game.goFlashUntil) {
    bigCenterText('GO!');
  }
}

function bigCenterText(str) {
  noStroke();
  fill(0, 0, 0, 150);
  rect(0, height * 0.28, width, height * 0.22);
  textAlign(CENTER, CENTER);
  textSize(100);
  fill(255, 225, 140);
  text(str, width / 2, height * 0.4);
}

function sensorStatusText() {
  if (sensors.denied) {
    return 'Motion Access Denied';
  }
  if (sensors.calibrated) {
    if (sensors.latest == null) return 'Tilt: Calibrated';
    const d = sensors.latest - sensors.neutral;
    const arrow = d > TILT_DEADZONE ? '→' : d < -TILT_DEADZONE ? '←' : '·';
    return 'Tilt: ' + arrow + ' ' + Math.round(d) + '°';
  }
  return 'Tilt: waiting for sensor…';
}

function connectionText() {
  if (debugState.mode) return 'Net: Diagnostic mode · offline';
  if (!isShareConfigured()) return 'Net: No room configured';
  if (typeof netConnect !== 'function') return 'Net: Multiplayer lib failed · single player · refresh to retry';
  const st = window.shareStatus;
  if (st === 'connected') return 'Net: Connected';
  if (st === 'connecting') return 'Net: Connecting…';
  if (st === 'error') return 'Net: Connection Failed · ' + (window.shareError || 'check network/server');
  if (st === 'unsupported') return 'Net: Connection Failed · WebSocket not supported';
  return 'Net: Tap JOIN to enter the room';
}

/* 页面底部状态行（DOM）：JOIN 反馈与失败提示不依赖画布渲染 */
function setNetStatus(text) {
  const el = document.getElementById('net-status');
  if (el) el.textContent = text;
}

function netStatusText() {
  if (fatalInitError) return 'Init failed: ' + fatalInitError;
  if (debugState.mode) {
    return 'Diagnostic · frame ' + frameCount + (debugState.message ? ' · ' + debugState.message : '');
  }
  if (statusFlash && Date.now() < statusFlash.until) return statusFlash.text;
  return connectionText();
}

// 诊断模式下按钮反馈要立即可见（updateNetStatus 按 30 帧节流，不适合即时反馈）
function setDebugMessage(text) {
  debugState.message = text;
  setNetStatus(netStatusText());
}

/* 瞬时状态提示（默认 2.5 秒后失效，回到常规状态文本）：
 * JOIN / CALIBRATE 等按钮点击的即时反馈，不依赖下一帧刷新 */
let statusFlash = null;   // { text, until }（until 为 Date.now() 毫秒时间戳）
function flashStatus(text, ms) {
  statusFlash = { text: text, until: Date.now() + (typeof ms === 'number' ? ms : 2500) };
  setNetStatus(text);
}

let lastNetText = null;
function updateNetStatus() {
  if (debugState.mode && frameCount % 30 !== 0 && lastNetText !== null) return;   // 诊断模式节流
  const t = netStatusText();
  if (t !== lastNetText) {
    lastNetText = t;
    setNetStatus(t);
  }
}

/* JOIN 按钮状态：跟随连接状态变化，点击后立即有反馈 */
let lastJoinBtnState = null;
function updateJoinButton() {
  const btn = document.getElementById('btn-join');
  if (!btn) return;
  let state;
  if (debugState.mode) state = 'debugjoin';
  else if (!isShareConfigured()) state = 'noconfig';
  else if (typeof netConnect !== 'function') state = 'nolib';
  else if (isConnected()) state = 'joined';
  else if (window.shareStatus === 'connecting') state = 'connecting';
  else if (window.shareStatus === 'error') state = 'error';
  else state = 'join';
  if (state === lastJoinBtnState) return;
  lastJoinBtnState = state;
  if (state === 'debugjoin') { btn.disabled = false; btn.textContent = 'JOIN'; }
  else if (state === 'noconfig') { btn.disabled = true; btn.textContent = 'No Room'; }
  else if (state === 'nolib') { btn.disabled = true; btn.textContent = 'No Net Lib'; }
  else if (state === 'joined') { btn.disabled = true; btn.textContent = 'Connected ✓'; }
  else if (state === 'connecting') { btn.disabled = true; btn.textContent = 'Connecting…'; }
  else if (state === 'error') { btn.disabled = false; btn.textContent = 'Retry JOIN'; }
  else { btn.disabled = false; btn.textContent = 'JOIN'; }
}

/* READY / PLAY AGAIN 按钮状态跟随连接与比赛阶段变化 */
let lastReadyBtnState = null;
function updateReadyButton() {
  const btn = document.getElementById('btn-ready');
  if (!btn) return;
  const online = !isShareConfigured() || isConnected();
  let state;
  if (!online) state = 'noconn';
  else if (gamePhase() === 'ended') state = 'ended';
  else if (gamePhase() === 'running') state = isSpectator() ? 'spectator' : 'running';
  else state = me.ready ? 'unready' : 'ready';
  if (state === lastReadyBtnState) return;
  lastReadyBtnState = state;
  if (state === 'noconn') { btn.disabled = true; btn.textContent = 'Not Connected'; }
  else if (state === 'running') { btn.disabled = true; btn.textContent = 'Running…'; }
  else if (state === 'spectator') { btn.disabled = true; btn.textContent = 'Spectator'; }
  else if (state === 'ended') { btn.disabled = false; btn.textContent = 'PLAY AGAIN'; }
  else if (state === 'unready') { btn.disabled = false; btn.textContent = 'READY ✓'; }
  else { btn.disabled = false; btn.textContent = 'READY'; }
}

/* READY：切换准备状态（me.ready 随 pstate 自动广播）；
 * countdown 期间取消准备会自动取消倒计时（updateReadyFlow 处理）；
 * PLAY AGAIN：写 lobby + 新局号并清空地图与物品（各设备自行重置 me）。 */
function bindReady() {
  const btn = document.getElementById('btn-ready');
  if (!btn) return;
  btn.addEventListener('click', () => {
    ensureMotionPermission();   // 用户手势内请求传感器授权（iOS）
    tryLockPortrait();

    const p = gamePhase();
    if (p === 'ended') {
      // PLAY AGAIN：新局号 + 清场（Object 布局在开赛时按新人数生成）
      const round = gameRound();
      window.shared.game = { phase: 'lobby', round: round + 1, participants: [] };
      window.shared.cells = {};
      window.shared.objects = {};
      flashStatus('New Round · Waiting for Players!');
      return;
    }
    if (p === 'running') return;
    if (isSpectator()) return;
    if (isShareConfigured() && !isConnected()) return;

    // lobby / countdown：切换准备状态
    me.ready = !me.ready;
    flashStatus(me.ready ? 'Ready!' : 'Not Ready', 1200);
  });
}

/* ============================================================
 * 输入
 * ============================================================ */

// Swipe：画面上滑/下滑，每次移动一格。
// 第二根手指落下时整个滑动手势作废（双指点击交给抢夺逻辑，不产生移动）。
function bindSwipe(canvasEl) {
  let start = null;

  canvasEl.addEventListener('pointerdown', (e) => {
    if (start === null) {
      start = { id: e.pointerId, x: e.clientX, y: e.clientY };
    } else {
      start = null;   // 双指 → 取消滑动
    }
  });

  const finish = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dy) < SWIPE_DIST) return;
    if (Math.abs(dy) <= Math.abs(dx)) return;
    moveMe(0, dy < 0 ? -1 : 1);
  };
  canvasEl.addEventListener('pointerup', finish);
  canvasEl.addEventListener('pointercancel', () => { start = null; });
}

// 桌面调试：方向键 / WASD（手机端没有方向按钮，用滑动 / 倾斜）
function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (howtoOpen) return;   // 说明弹窗打开时不触发移动
    const keyMap = {
      'ArrowUp': { dx: 0, dy: -1 },  'w': { dx: 0, dy: -1 }, 'W': { dx: 0, dy: -1 },
      'ArrowDown': { dx: 0, dy: 1 }, 's': { dx: 0, dy: 1 },  'S': { dx: 0, dy: 1 },
      'ArrowLeft': { dx: -1, dy: 0 }, 'a': { dx: -1, dy: 0 }, 'A': { dx: -1, dy: 0 },
      'ArrowRight': { dx: 1, dy: 0 }, 'd': { dx: 1, dy: 0 },  'D': { dx: 1, dy: 0 }
    };
    const dir = keyMap[e.key];
    if (dir) {
      e.preventDefault();
      moveMe(dir.dx, dir.dy);
    }
  });
}

// JOIN：加入共享房间（点击即调用 netConnect，net.js 负责 MQTT 连接与状态）
function bindJoin() {
  const btn = document.getElementById('btn-join');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (debugState.mode) {
      // 诊断模式：不调用 netConnect、不访问 broker，只验证按钮与事件
      setDebugMessage('JOIN button OK');
      return;
    }
    if (!isShareConfigured() || isConnected()) return;
    if (typeof netConnect !== 'function') {
      flashStatus('Net: Multiplayer lib missing · single player');
      return;
    }
    ensureMotionPermission();   // 用户手势内请求传感器授权（iOS）
    // 点击立即反馈：Connecting…（Connected / Connection Failed 由 net.js 状态驱动显示）
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    lastJoinBtnState = 'connecting';
    flashStatus('Connecting…');
    netConnect()
      .then(() => {
        flashStatus('Connected ✓ · Room ' + (window.shareRoom || ''), 3000);
      })
      .catch((err) => {
        // 不吞错误：把具体原因显示在状态行
        const msg = err && err.message ? err.message : String(err);
        flashStatus('Connection Failed · ' + msg, 5000);
      });
  });
}

function bindInput() {
  const canvasEl = document.querySelector('#canvas-container canvas');
  bindSwipe(canvasEl);
  bindTwoFingerTap(canvasEl);   // 双指点击 = 抢夺（不触发 Swipe/缩放）
  bindKeyboard();
  bindJoin();
  bindReady();
  bindHowTo();
  bindPlayAgain();

  window.addEventListener('deviceorientation', onDeviceOrientation);

  // 阻止 Swipe / 触摸导致页面滚动与浏览器缩放；
  // HOW TO PLAY 弹窗内容例外（允许纵向滚动）
  document.addEventListener('touchmove', (e) => {
    const ov = document.getElementById('howto-overlay');
    if (ov && !ov.hidden && ov.contains(e.target)) return;
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

/* ============================================================
 * HOW TO PLAY —— 简洁英文说明弹窗
 * · 首次进入自动显示一次（localStorage 记录，不重复强制弹出）；
 * · 随时点 ? 按钮查看；GOT IT 关闭；游戏进行中也能查看（不暂停比赛）；
 * · 弹窗打开时不触发移动/抢夺（覆盖层拦截触摸，键盘亦被屏蔽）。
 * ============================================================ */
let howtoOpen = false;
const HOWTO_KEY = 'decider-howto-seen';

function openHowTo() {
  const ov = document.getElementById('howto-overlay');
  if (!ov) return;
  ov.hidden = false;
  howtoOpen = true;
}

function closeHowTo() {
  const ov = document.getElementById('howto-overlay');
  if (!ov) return;
  ov.hidden = true;
  howtoOpen = false;
  try { localStorage.setItem(HOWTO_KEY, '1'); } catch (e) { /* 忽略 */ }
}

function bindHowTo() {
  const btn = document.getElementById('btn-howto');
  if (btn) btn.addEventListener('click', openHowTo);
  const close = document.getElementById('btn-howto-close');
  if (close) close.addEventListener('click', closeHowTo);
  const ov = document.getElementById('howto-overlay');
  if (ov) {
    ov.addEventListener('click', (e) => {
      if (e.target === ov) closeHowTo();   // 点背景也可关闭
    });
  }
  // 首次进入自动显示一次（localStorage 未记录时）
  let seen = false;
  try { seen = localStorage.getItem(HOWTO_KEY) === '1'; } catch (e) { /* 忽略 */ }
  if (!seen) {
    setTimeout(openHowTo, 900);   // 等游戏画面就绪后再弹出
  }
}

/* 结算面板内的 PLAY AGAIN：与底部 READY 按钮共用同一逻辑 */
function bindPlayAgain() {
  const btn = document.getElementById('btn-playagain');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const rb = document.getElementById('btn-ready');
    if (rb && !rb.disabled) rb.click();
  });
}

/* ============================================================
 * p5 生命周期
 * 说明：setup() 分 5 段，每段独立 try/catch——
 *   1) 状态初始化：me / shared / guests 最先就绪（debug=local 用本地对象，
 *      联机模式调 netInit 建立 SharedRoom 状态，失败自动降级为单机，
 *      绝不带着未初始化的状态跑游戏）；
 *   2) 画布（失败 = 致命错误，状态行持续显示具体原因）；
 *   3) 输入绑定（此后 JOIN/READY/方向键始终有效；倾斜授权在 JOIN/READY
 *      的用户手势内自动完成）；
 *   4) 摄像机（以视觉坐标落位）；
 *   5) 初始化成功提示。任何一段出错都会把具体原因显示在底部状态行。
 * 另：setup() 首行设置 window.__gameStarted，供 index.html 加载器
 * 判断“游戏已启动”，防止重复创建 p5 实例。
 * ============================================================ */
function reportInitError(stage, err) {
  const msg = err && err.message ? err.message : String(err);
  if (typeof console !== 'undefined') console.error('[init error]', stage, err);
  setNetStatus('Init error (' + stage + '): ' + msg);
}

/* 致命初始化错误（如画布创建失败）：状态行优先显示，不被常规连接状态覆盖 */
let fatalInitError = null;

/* 本地单机状态：debug=local / 联机库缺失 / netInit 失败时使用。
 * 必须在任何 draw() / 按钮回调访问 me / shared / guests 之前完成，
 * 保证不联机也能正常显示单机游戏画面。 */
function initLocalState() {
  window.me = {
    x: 12, y: 12, color: 0,            // 单机直接分配颜色 0（珊瑚红）与出生点
    baseX: 12, baseY: 12,
    carryingObject: null,
    delivered: 0,
    ready: false
  };
  if (!Array.isArray(window.guests)) window.guests = [];
  window.shared = {
    cells: {},                          // 占地地图
    objects: {},                        // Object 条目由 draw() 的 healObjects() 补齐
    game: { phase: 'lobby', round: 0 }  // 赛制：lobby / countdown / running / ended
  };
}

function setup() {
  // 启动标记：index.html 的加载器据此判断 setup() 已执行，避免重复创建 p5 实例
  window.__gameStarted = true;

  // ── 1) 游戏状态初始化：必须最先完成，任何按钮回调 / 首帧 draw() 之前
  //      me / shared / guests 都已就绪（debug=local 同样先建好再运行游戏） ──
  if (debugState.mode) {
    // 诊断模式：不调用 netInit()、不访问 broker，直接使用本地单机状态
    try {
      initLocalState();
      setNetStatus('Diagnostic mode · local state ready · offline');
    } catch (err) {
      reportInitError('state', err);
      initLocalState();   // 兜底：确保 me / shared / guests 存在
    }
  } else {
    try {
      const netLibReady = typeof netInit === 'function';
      if (netLibReady && isShareConfigured()) {
        netInit({
          room: SHARE_CONFIG.room,      // ?room= URL 参数优先于这里（见 net.js）
          shared: {
            cells: {},                  // 占地地图：cells["x,y"] = { o: 玩家ID, c: 颜色下标 }
            objects: {},                // Object 条目按本局布局自愈（见 healObjects）
            game: { phase: 'lobby', round: 0 }   // 赛制：lobby / countdown / running / ended
          },
          me: {
            x: 12, y: 12, color: -1,    // color -1 = 未分配，连接后自动分配
            carryingObject: null,       // 携带的 Object ID（null = 空手）
            delivered: 0,               // 已交付数量（自己）
            ready: false                // 加入房间默认 Not Ready
          }
        });
        // 防御：联机层已加载但未按预期创建全局状态 → 降级为单机，保证画面正常显示
        if (!window.me || !window.shared) {
          throw new Error('Net layer did not create me/shared');
        }
        if (!Array.isArray(window.guests)) window.guests = [];
      } else {
        // 未配置房间或联机库缺失：单机模式（me / shared / guests 为普通对象）
        initLocalState();
        if (!netLibReady) {
          setNetStatus('Net: Multiplayer lib failed · single player available · refresh for online');
        }
      }
    } catch (err) {
      reportInitError('network', err);
      initLocalState();   // 降级：本地单机状态，保证游戏能继续运行
    }
  }

  // ── 2) 画布 ──
  try {
    const holder = document.getElementById('canvas-container');
    const canvas = createCanvas(holder.clientWidth, holder.clientHeight);
    canvas.parent(holder);
    textFont('monospace');
    window.__gameCanvas = canvas.elt;
  } catch (err) {
    fatalInitError = 'Canvas creation failed · ' + (err && err.message ? err.message : err);
    setNetStatus('Init failed: ' + fatalInitError);
    if (typeof console !== 'undefined') console.error('[init error] canvas', err);
    return;
  }

  // ── 3) 输入绑定：状态与画布就绪后绑定，JOIN / CALIBRATE / START / 方向键始终有效 ──
  try {
    bindInput();
  } catch (err) {
    reportInitError('input', err);
  }

  sensors.needPermission = needsSensorPermission();

  // ── 4) 摄像机（以视觉坐标落位，避免开局跨图滑行） ──
  try {
    gameState.render.x = (me.x + 0.5) * CELL;
    gameState.render.y = (me.y + 0.5) * CELL;
    const t = clampCam(camTarget().x, camTarget().y);
    gameState.camera.x = t.x;
    gameState.camera.y = t.y;
  } catch (err) {
    reportInitError('camera', err);
  }

  // ── 5) 初始化完成：显示明确的成功信息（瞬时提示后回到常规状态文本） ──
  if (debugState.mode) {
    debugState.message = 'Init complete · offline';
  } else {
    flashStatus('Init complete ✓', 2500);
  }
  setNetStatus(netStatusText());
}

function draw() {
  background(MAP_BG);       // 地图外区域与地砖间隙的颜色（中性商务灰）

  const dt = frameDelta(); // 帧间隔（秒），平滑动画基于 deltaTime
  updateRender(dt);        // 本机角色 + guests 的视觉坐标平滑追赶
  updateTilt();
  healObjects();            // 按本局布局补齐/清理 Object 条目
  updateGameFlow();         // 局号推进 / 倒计时锁定 / 结束 / 计分
  updateReadyFlow();        // READY 仲裁：全员就绪 → countdown → running
  applyMyBase();            // 应用共享基地分配（开赛前统一落位）
  ensureMyColor();          // 连接后：分配颜色、解决颜色冲突
  resolveObjectConflicts(); // 裁决回滚：抢拾/被抢的输家自动放下
  assertDelivered();        // 守护已交付的 Object 不被迟到宣告复活
  updateJoinButton();
  updateReadyButton();
  updateNetStatus();        // 底部状态行：连接状态/失败提示
  updateCamera(dt);
  updateResultsOverlay();   // ended → 显示 HTML 结算覆盖层

  push();
  translate(-gameState.camera.x, -gameState.camera.y); // 摄像机跟随
  drawTiles();
  drawBorder();
  drawBaseMarkers();
  drawObjects();
  drawPlayers();
  pop();

  drawBaseArrow();          // 屏幕边缘指向自己基地的箭头
  drawCountdown();          // 3 / 2 / 1 / GO!
  drawHUD();
  drawStealFeedback();      // 抢夺成功/失败/冷却/距离提示
}

// 手机旋转 / 窗口尺寸变化时重新适配画布与结算地图
function windowResized() {
  const holder = document.getElementById('canvas-container');
  resizeCanvas(holder.clientWidth, holder.clientHeight);
  if (resultsShown) renderResultsMap();
}
