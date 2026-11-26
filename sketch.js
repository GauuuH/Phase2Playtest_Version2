/* ============================================================
 * 格子漫游 · Grid Walker —— sketch.js
 *
 * 24×24 格子地图 + Camera Follow（只跟随自己的角色）
 * 手机竖屏游戏，电脑仅用于开发调试
 *
 * ── 多人架构（p5-phone-share = p5-phone 1.15.0 的 Share 功能） ──
 * 没有“电脑 Host 大屏”：每部手机运行同一个页面，显示同一张共享地图，
 * 摄像机只跟随自己的角色。共享状态全部由 p5-phone 的同步服务器
 * （Cloudflare PartyServer Worker）作为唯一数据源：
 *
 *   me     —— 本机玩家的状态（x, y, color）。写入 me.x / me.y 时，
 *             p5-phone 会自动把它同步给房间里其他手机；断线期间改动
 *             保存在本地，重连时随 hello 消息补发（已核实 1.15.0 源码）。
 *   guests —— 其他在线玩家的 me 快照数组（每个带 id），由 p5-phone
 *             的 welcome / presence 消息自动维护，加入、离开、断线重连
 *             都不需要我们处理。
 *
 * 关键约定（避免设备间互相覆盖）：
 *   · 每台手机只写自己的 me，绝不写别人的状态；
 *   · 位置冲突天然不存在：每个玩家的坐标只属于他自己的 me；
 *   · 颜色/出生点：新玩家连接后从共享可见的 guests 里找第一个空闲颜色，
 *     出生点由颜色下标确定（所有设备用同一张表，结果一致）；
 *     若两人同时拿到同色，id 字典序大的那台让位重选，自动收敛。
 *
 * 移动同步不需要 shareEmit / shared：me 的自动补丁已覆盖全部需求。
 *
 * ── 占地（Territory）同步方案 —— 已核实 1.15.0 源码后选择 ──
 * 可用 API 事实：
 *   · shared 是房间级 Proxy：按路径写入补丁，worker 回显（echo）+
 *     未确认写保护（_sharePending），保证所有设备收敛到 worker 的同一份值；
 *   · welcome 消息携带完整 shared → 中途加入的玩家直接拿到完整地图；
 *   · 断线重连时 hello 消息重发完整 shared/me；
 *   · shareEmit / shareEvent 是一次性事件：不存储、不重放，
 *     迟到加入的玩家收不到 → 不适合承载地图持久状态，故不使用。
 * 方案：shared.cells["x,y"] = { o: 玩家ID, c: 颜色下标 }
 *   · 每次移动只写实际进入的格子（顶墙不动不写）→ 站立不重复触发；
 *   · 同一格同时占领：worker 按到达顺序 last-write-wins，
 *     所有手机最终显示同一结果（一致性优先，平手由服务器裁决）；
 *   · 主人 ID 与颜色同一条记录一起写，不存在字段撕裂。
 * 未连接服务器时不做本地占地（加入后地图以服务器为准，避免各设备不一致）。
 *
 * ── Object（拾取/携带/交付）同步方案 —— 已核实 1.15.0 源码后选择 ──
 * 状态：shared.objects[objId] = { state: 'ground'|'carried'|'delivered', by: 携带者ID }
 *   · 拾取 = 写 { state:'carried', by:我的ID }；交付 = 写 { state:'delivered', by:我的ID }；
 *   · 每台手机只写自己参与的转移，绝不替别人改状态；
 *   · 自己携带什么放在 me.carryingObject（Object ID 或 null），随 me 自动同步。
 *
 * 【关于“同时拾取同一 Object 只有一人成功”（要求 10）的如实说明】
 *   p5-phone 1.15.0 / 现有 Worker 没有提供 CAS（原子比较交换）或专门的服务端
 *   裁决 API。它提供的保证是：同 key 的补丁由 worker 按到达顺序串行应用
 *   （last-write-wins），并且所有设备都会收敛到 worker 的同一份值。
 *   因此本实现采用「宣告 + 回滚」：
 *     1. 双方都可能先写出 { carried, by:自己 } 并短暂以为自己成功；
 *     2. worker 按到达顺序定出唯一赢家（写入 shared.objects[objId].by）；
 *     3. 输家看到 by ≠ 自己 → 自动放下（resolveObjectConflicts，每帧检查）。
 *   结果：所有设备最终一致，只有一个携带者；但存在亚秒级的“双携带”过渡窗口
 *   （手机上前台传播 <1s）。这不是严格意义上的互斥锁，是“服务器定序 + 客户端
 *   回滚”的最终一致性方案——如实记录，不冒充原子操作。
 *   未来若需要严格互斥，需要 Worker 增加 CAS 语义（当前版本没有）。
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
 *   并发（不冒充原子性）：worker 按到达顺序定出唯一 by，输家自动放下；
 *   已交付的 Object 由交付者本会话守护（assertDelivered），
 *   被迟到的抢夺宣告复活时重新写回 delivered。
 *
 * ── 操作方式（手机） ──
 *   · Swipe：画面上滑/下滑，每次移动一格
 *   · Tilt ：左右倾斜横向移动（死区 + 定间隔），CALIBRATE 校准中立角
 *   · 方向按钮：备用操作
 *   · JOIN：加入共享房间（iPhone 等也通过它完成必要的手势）
 * ── 操作方式（桌面调试） ──
 *   · 方向键 / WASD
 * ============================================================ */

'use strict';

/* ---------------- 世界配置 ---------------- */
const GRID   = 24;            // 24 × 24 格子地图
const CELL   = 40;            // 每格像素
const WORLD_W = GRID * CELL;  // 地图总宽 960px
const WORLD_H = GRID * CELL;  // 地图总高 960px（大于手机屏幕）

/* ---------------- 操作配置 ---------------- */
const SWIPE_DIST   = 30;    // 滑动判定距离（px）
const TILT_DEADZONE = 5;    // 倾斜死区（°），防止手抖误触发
const TILT_INTERVAL = 220;  // 倾斜越过死区后的固定移动间隔（ms）
const TILT_SIGN = 1;        // 个别设备若左右方向颠倒，改成 -1

/* ---------------- 联机配置 ---------------- */
const SHARE_CONFIG = {
  host: 'https://p5-phone-share.npuckett.workers.dev',  // 课堂共享服务器（p5-phone-share）
  room: 'grid-walker',   // 房间名：同一房间的手机互相可见
  app: 'phase2-playtest'
};

const MAX_PLAYERS = 7;   // 架构预留：最多 7 名玩家（先支持 2 部手机测试）

/* 7 种玩家颜色（下标 = 颜色编号，全部设备一致） */
const PALETTE = [
  [255, 118, 87],    // 0 珊瑚红
  [255, 199, 89],    // 1 琥珀
  [111, 194, 255],   // 2 天蓝
  [151, 220, 121],   // 3 草绿
  [206, 131, 255],   // 4 紫
  [255, 140, 199],   // 5 粉
  [117, 230, 218]    // 6 青
];

/* 7 个出生点（下标 = 颜色编号，所有设备一致）；同时是各玩家的基地。
 * 全部在地图外围（不允许出生在中央），且到中央 Object 区最近一格的
 * 曼哈顿距离都等于 11（8 个等距候选点中取 7 个），保证公平。 */
const SPAWNS = [
  { x: 0,  y: 9  },   // 左
  { x: 23, y: 9  },   // 右
  { x: 0,  y: 14 },   // 左
  { x: 23, y: 14 },   // 右
  { x: 9,  y: 0  },   // 上
  { x: 14, y: 0  },   // 上
  { x: 9,  y: 23 }    // 下
];

/* 4 个公共 Object：唯一 ID + 固定初始位置（地图中央区域，避开出生点） */
const OBJECTS = [
  { id: 'o1', x: 10, y: 10 },
  { id: 'o2', x: 13, y: 10 },
  { id: 'o3', x: 10, y: 13 },
  { id: 'o4', x: 13, y: 13 }
];

/* ---------------- 游戏状态（摄像机等本地状态） ---------------- */
/* 玩家状态不在本地对象里：自己在 p5-phone 的 me 里，他人在 guests 里 */
const gameState = {
  camera: { x: 0, y: 0 }   // 摄像机左上角的世界坐标（像素）
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
  calibratePressed: false,
  pendingCalibrate: false, // 按下校准时还没数据 → 等第一条数据到达再校准
  dir: 0,                  // 当前倾斜方向：-1 左 / 0 停 / 1 右
  lastMoveAt: 0            // 上次倾斜移动的时间（millis）
};

/* ============================================================
 * 联机工具
 * ============================================================ */
function isShareConfigured() {
  if (SHARE_CONFIG.host && SHARE_CONFIG.host.trim()) return true;
  try { return !!new URLSearchParams(location.search).get('shareHost'); }
  catch (e) { return false; }
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
 * 移动逻辑 —— 唯一入口，与输入方式无关
 * 只写自己的 me；边界检查在这里做（0 ~ GRID-1）。
 * 每次移动只处理“实际进入”的格子：顶墙没动时不触发占地/拾取。
 * ============================================================ */
function moveMe(dx, dy) {
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
  if (me.carryingObject) return;   // 携带 Object 时不能占领

  const key  = x + ',' + y;
  const mine = myOwnerId();
  if (!mine) return;               // 还没连上服务器：不写本地占地（以服务器地图为准）

  const cells = window.shared.cells || (window.shared.cells = {});
  const cur = cells[key];
  if (cur && cur.o === mine) return;   // 已属于自己：不重复触发

  // 写入共享状态 → p5-phone 自动同步给所有手机
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
 * ============================================================ */

// 每帧调用：补齐缺失的 Object 条目（老房间/新加入时自愈）
function healObjects() {
  if (!window.shared.objects) window.shared.objects = {};
  for (const o of OBJECTS) {
    if (!window.shared.objects[o.id]) {
      window.shared.objects[o.id] = { state: 'ground' };
    }
  }
}

function objectAt(x, y) {
  for (const o of OBJECTS) {
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
}

/* 拾取宣告（同时是未来双指抢夺的转移入口，本阶段不接线）：
 * 写入 { carried, by:我的ID }；若同时有人抢同一 Object，
 * worker 按到达顺序定出唯一 by，输家由 resolveObjectConflicts() 自动放下。 */
function claimObject(objId) {
  const mine = myOwnerId();
  if (!mine) return;
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
  window.shared.objects[objId] = { state: 'delivered', by: myOwnerId() };
  me.carryingObject = null;                     // 清空 → 恢复占地能力
  me.delivered = (typeof me.delivered === 'number' ? me.delivered : 0) + 1;
  steal.deliveredByMe.add(objId);               // 守护：防止被迟到的抢夺宣告复活
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
    setStealFeedback('失去 ' + lost + '!', FEEDBACK_FAIL);
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
 * 并发说明（不冒充原子性）：双方同时抢同一携带者时，worker 按到达顺序
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
    setStealFeedback('冷却中…', FEEDBACK_COOL);
    return;
  }
  steal.cooldownUntil = now + STEAL_COOLDOWN;   // 每次尝试都进入冷却

  if (!isConnected()) {
    setStealFeedback('未连接房间', FEEDBACK_FAIL);
    return;
  }
  if (me.carryingObject) {
    setStealFeedback('必须空手才能抢夺', FEEDBACK_FAIL);
    return;
  }
  const t = nearestCarrier();
  if (!t) {
    setStealFeedback('周围无人携带 Object', FEEDBACK_FAIL);
    return;
  }
  if (t.d > 1) {
    setStealFeedback('距离不足 · 需相邻 1 格', FEEDBACK_FAIL);
    return;
  }
  const objId = t.g.carryingObject;
  const st = window.shared.objects && window.shared.objects[objId];
  if (!st || st.state !== 'carried') {
    setStealFeedback('Object 已不在对方手上', FEEDBACK_FAIL);   // 已被交付/转移
    return;
  }
  claimObject(objId);   // 所有权转移：原携带者会自动放下
  setStealFeedback('抢到 ' + objId + '!', FEEDBACK_OK);
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
 * 颜色 / 出生点分配（每帧调用，仅在已连接时生效）
 * 说明：1.15.0 没有 shareJoined 回调，所以用轻量轮询；
 *       guests 最多 7 人，每帧扫一遍开销可忽略。
 * ============================================================ */
function ensureMyColor() {
  if (!isConnected()) return;
  const myId = getMyId();
  const gs = window.guests || [];
  const myColor = typeof me.color === 'number' ? me.color : -1;

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

  const isNew = myColor < 0;
  me.color = idx;
  if (isNew) {
    const s = SPAWNS[idx % SPAWNS.length];
    me.x = s.x;   // 新玩家放到自己的出生点；重连玩家保留原位置
    me.y = s.y;
    me.baseX = s.x;   // 基地 = 出生点（随 me 同步给其他玩家）
    me.baseY = s.y;
    captureCell(s.x, s.y);   // 出生格子自动归自己所有
  }
}

/* ============================================================
 * 摄像机 —— Camera Follow（只跟随自己的角色 me）
 * ============================================================ */
function clampCam(tx, ty) {
  return {
    x: WORLD_W <= width  ? (WORLD_W - width)  / 2 : constrain(tx, 0, WORLD_W - width),
    y: WORLD_H <= height ? (WORLD_H - height) / 2 : constrain(ty, 0, WORLD_H - height)
  };
}

function camTarget(p) {
  return {
    x: p.x * CELL + CELL / 2 - width / 2,
    y: p.y * CELL + CELL / 2 - height / 2
  };
}

function updateCamera() {
  const cam = gameState.camera;
  const t   = clampCam(camTarget(me).x, camTarget(me).y);
  cam.x = lerp(cam.x, t.x, 0.18);   // 平滑跟随
  cam.y = lerp(cam.y, t.y, 0.18);
}

/* ============================================================
 * 倾斜传感器 —— 权限 / 校准 / 死区 / 定间隔移动
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

  sensors.latest = tilt * TILT_SIGN;
  sensors.available = true;

  if (sensors.pendingCalibrate) {
    sensors.pendingCalibrate = false;
    sensors.neutral = tilt * TILT_SIGN;
    sensors.calibrated = true;
    sensors.dir = 0;
  }
}

function calibrateTilt() {
  sensors.calibratePressed = true;
  if (sensors.latest != null) {
    sensors.neutral = sensors.latest;   // 当前握持姿态 = 中立角度
    sensors.calibrated = true;
    sensors.dir = 0;
  } else {
    sensors.pendingCalibrate = true;
  }
}

// CALIBRATE 按钮：iPhone（iOS 13+）通过按钮请求传感器授权；
// 授权成功直接以当前姿态校准；被拒绝则 HUD 提示，不报错。
function onCalibratePress() {
  tryLockPortrait();

  if (needsSensorPermission() && !sensors.permissionAsked) {
    sensors.permissionAsked = true;
    DeviceOrientationEvent.requestPermission()
      .then((state) => {
        if (state === 'granted') {
          sensors.denied = false;
          calibrateTilt();
        } else {
          sensors.denied = true;
        }
      })
      .catch(() => { sensors.denied = true; });
  } else {
    calibrateTilt();
  }
}

// 每帧调用：越过死区立即移动一格，之后按固定间隔连续移动；回到中立停止
function updateTilt() {
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
 * ============================================================ */
function drawTiles() {
  noStroke();
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      fill(cellFillColor(x, y));
      rect(x * CELL, y * CELL, CELL, CELL);
      drawLandmark(x, y);
    }
  }

  stroke(0, 0, 0, 25);
  strokeWeight(1);
  for (let i = 0; i <= GRID; i++) {
    line(i * CELL, 0, i * CELL, WORLD_H);
    line(0, i * CELL, WORLD_W, i * CELL);
  }
}

// 确定性地标（石头 / 树）
function drawLandmark(x, y) {
  const h = Math.floor(Math.abs(Math.sin(x * 127.1 + y * 311.7) * 43758.5453)) % 100;
  const cx = x * CELL + CELL / 2;
  const cy = y * CELL + CELL / 2;

  if (h < 8) {
    fill(140, 140, 152);
    circle(cx, cy, CELL * 0.34);
    fill(108, 108, 120);
    circle(cx, cy + 2, CELL * 0.2);
  } else if (h < 18) {
    fill(60, 110, 66);
    circle(cx, cy - CELL * 0.08, CELL * 0.55);
    fill(46, 88, 52);
    rect(cx - CELL * 0.05, cy + CELL * 0.08, CELL * 0.1, CELL * 0.2);
  }
}

// 格子颜色：中立 = 棋盘绿；被占领 = 主人的代表色（浅色调，网格线仍清晰）
function cellFillColor(x, y) {
  const cell = cellOwner(x, y);
  if (!cell) {
    return (x + y) % 2 === 0 ? [143, 174, 107] : [132, 163, 98];
  }
  const c = PALETTE[
    (typeof cell.c === 'number' && cell.c >= 0) ? cell.c % PALETTE.length : 0
  ];
  return [
    Math.round(c[0] * 0.55 + 255 * 0.45),
    Math.round(c[1] * 0.55 + 255 * 0.45),
    Math.round(c[2] * 0.55 + 255 * 0.45)
  ];
}

function drawBorder() {
  noFill();
  stroke(255, 255, 255, 90);
  strokeWeight(3);
  rect(0, 0, WORLD_W, WORLD_H);
}

/* 地面上的 Object（state = ground 才画）：金色礼物盒 + ID 标签 */
function drawObjects() {
  for (const o of OBJECTS) {
    const st = window.shared.objects && window.shared.objects[o.id];
    if (!st || st.state !== 'ground') continue;   // 被携带 / 已交付的不画在地上

    const cx = o.x * CELL + CELL / 2;
    const cy = o.y * CELL + CELL / 2;
    noStroke();
    fill(255, 209, 102);
    rect(cx - CELL * 0.26, cy - CELL * 0.2, CELL * 0.52, CELL * 0.4, 4);
    fill(230, 170, 60);
    rect(cx - CELL * 0.04, cy - CELL * 0.3, CELL * 0.08, CELL * 0.6);
    fill(60, 45, 20);
    textSize(10);
    textAlign(CENTER, TOP);
    text(o.id, cx, cy + CELL * 0.24);
  }
}

/* 各玩家基地标记（小旗）：自己 + 其他在线玩家 */
function drawBaseMarkers() {
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
    text('基地', cx + CELL * 0.16, cy - CELL * 0.5);
  }
}

function colorOf(i) {
  return PALETTE[typeof i === 'number' && i >= 0 && i < PALETTE.length ? i : 0];
}

// 渲染自己（me）+ 所有在线玩家（guests，由 p5-phone 自动维护）
function drawPlayers() {
  drawOnePlayer({ x: me.x, y: me.y, color: colorOf(me.color), obj: me.carryingObject || null }, true);

  const gs = window.guests || [];
  for (const g of gs) {
    // 新玩家还没完成颜色分配（color 仍为 -1）时不画，避免灰圈闪烁
    if (typeof g.color !== 'number' || g.color < 0) continue;
    drawOnePlayer({ x: g.x, y: g.y, color: colorOf(g.color), obj: g.carryingObject || null }, false);
  }
}

function drawOnePlayer(p, isSelf) {
  const cx = p.x * CELL + CELL / 2;
  const cy = p.y * CELL + CELL / 2;

  // 影子
  noStroke();
  fill(0, 0, 0, 60);
  ellipse(cx, cy + CELL * 0.3, CELL * 0.72, CELL * 0.26);

  // 角色：彩色圆形（自己描边更醒目）
  fill(p.color);
  stroke(255, 255, 255, isSelf ? 255 : 180);
  strokeWeight(isSelf ? 3 : 2);
  circle(cx, cy, CELL * 0.66);

  // 自己头顶的标记
  if (isSelf) {
    noStroke();
    fill(255);
    textSize(12);
    textAlign(CENTER, BOTTOM);
    text('你', cx, cy - CELL * 0.5);
  }

  // 携带 Object：头顶金色标记（其他玩家同样可见，因为 obj 来自共享状态）
  if (p.obj) {
    const y0 = cy - (isSelf ? CELL * 0.78 : CELL * 0.62);
    const s = isSelf ? 9 : 7;
    noStroke();
    fill(255, 209, 102);
    quad(cx, y0 - s, cx + s, y0, cx, y0 + s, cx - s, y0);
    fill(60, 45, 20);
    textSize(isSelf ? 10 : 9);
    textAlign(CENTER, CENTER);
    text(p.obj, cx, y0);
  }
}

/* 屏幕边缘指向自己基地的箭头（基地在屏幕内时不画；携带 Object 时更醒目） */
function drawBaseArrow() {
  const bx = me.baseX, by = me.baseY;
  if (bx == null || by == null) return;

  // 基地的世界坐标 → 屏幕坐标
  const sx = bx * CELL + CELL / 2 - gameState.camera.x;
  const sy = by * CELL + CELL / 2 - gameState.camera.y;
  const margin = 30;
  if (sx > margin && sx < width - margin && sy > margin && sy < height - margin) {
    return;   // 基地在屏幕内：不用箭头
  }

  const ang = Math.atan2(sy - height / 2, sx - width / 2);
  const tx = Math.cos(ang), ty = Math.sin(ang);
  // 从屏幕中心沿方向与边缘矩形（含 margin）求交点
  const kx = Math.abs(tx) < 1e-6 ? Infinity : ((tx > 0 ? width - margin : margin) - width / 2) / tx;
  const ky = Math.abs(ty) < 1e-6 ? Infinity : ((ty > 0 ? height - margin : margin) - height / 2) / ty;
  const k = Math.min(kx, ky);
  const ax = width / 2 + tx * k;
  const ay = height / 2 + ty * k;

  const carrying = !!me.carryingObject;
  const pulse = carrying ? 1 + 0.15 * Math.sin(millis() / 180) : 1;
  const s = (carrying ? 17 : 12) * pulse;

  push();
  translate(ax, ay);
  rotate(ang);
  noStroke();
  fill(carrying ? [255, 209, 102] : [255, 255, 255, 140]);
  triangle(s, 0, -s * 0.6, -s * 0.6, -s * 0.6, s * 0.6);
  pop();
}

// HUD：坐标 + 倾斜 + 联机 + 占地/交付（开发测试用，无全局排名）
function drawHUD() {
  let line5 = '占地 ' + myCellCount() + ' · 交付 ' + (typeof me.delivered === 'number' ? me.delivered : 0);
  if (me.carryingObject) line5 += ' · 携带 ' + me.carryingObject;
  const lines = [
    'X ' + me.x + ' · Y ' + me.y,
    sensorStatusText(),
    connectionText(),
    line5
  ];

  textSize(14);
  textAlign(LEFT, TOP);
  let w = 0;
  for (const l of lines) w = Math.max(w, textWidth(l));
  w += 20;

  noStroke();
  fill(0, 0, 0, 0.45);
  rect(8, 8, w, lines.length * 16 + 16, 8);
  fill(255);
  for (let i = 0; i < lines.length; i++) {
    text(lines[i], 18, 14 + i * 16);
  }
}

function sensorStatusText() {
  if (sensors.denied) {
    return '倾斜: 权限被拒 · 用按钮/滑动';
  }
  if (sensors.needPermission && !sensors.permissionAsked) {
    return '倾斜: 点 CALIBRATE 授权';
  }
  if (sensors.calibrated) {
    if (sensors.latest == null) return '倾斜: 已校准';
    const d = sensors.latest - sensors.neutral;
    const arrow = d > TILT_DEADZONE ? '→' : d < -TILT_DEADZONE ? '←' : '·';
    return '倾斜: ' + arrow + ' ' + Math.round(d) + '°';
  }
  if (sensors.calibratePressed && !sensors.available) {
    return '倾斜: 无传感器 · 用按钮/滑动';
  }
  return '倾斜: 点 CALIBRATE 校准';
}

function connectionText() {
  if (!isShareConfigured()) return '联机: 未配置服务器';
  const st = window.shareStatus;
  if (st === 'connected') return '联机: 已连接 · 在线 ' + onlineCount() + '/' + MAX_PLAYERS;
  if (st === 'connecting') return '联机: 连接中…';
  if (st === 'error') return '联机: 连接失败 · 检查服务器';
  if (st === 'unsupported') return '联机: 浏览器不支持';
  return '联机: 点 JOIN 加入房间';
}

/* JOIN 按钮状态跟随连接状态变化 */
let lastJoinBtnState = null;
function updateJoinButton() {
  const btn = document.getElementById('btn-join');
  if (!btn) return;
  const state = !isShareConfigured() ? 'noconfig' : (isConnected() ? 'joined' : 'join');
  if (state === lastJoinBtnState) return;
  lastJoinBtnState = state;
  btn.disabled = state !== 'join';
  btn.textContent = state === 'noconfig' ? '无服务器' : state === 'joined' ? '已连接 ✓' : 'JOIN';
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

// 备用方向按钮：每按一次移动一格
function bindDpad() {
  const dirs = {
    'btn-up':    { dx: 0, dy: -1 },
    'btn-down':  { dx: 0, dy: 1 },
    'btn-left':  { dx: -1, dy: 0 },
    'btn-right': { dx: 1, dy: 0 }
  };

  for (const id in dirs) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const dir = dirs[id];
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      moveMe(dir.dx, dir.dy);
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

// 桌面调试：方向键 / WASD
function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
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

// JOIN：加入共享房间（必须在用户手势里调用 shareConnect）
function bindJoin() {
  const btn = document.getElementById('btn-join');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!isShareConfigured() || isConnected()) return;
    if (typeof shareConnect === 'function') {
      shareConnect().catch(() => {});
    }
  });
}

function bindInput() {
  const canvasEl = document.querySelector('#canvas-container canvas');
  bindSwipe(canvasEl);
  bindTwoFingerTap(canvasEl);   // 双指点击 = 抢夺（不触发 Swipe/缩放）
  bindDpad();
  bindKeyboard();
  bindJoin();

  const calBtn = document.getElementById('btn-calibrate');
  if (calBtn) calBtn.addEventListener('click', onCalibratePress);

  window.addEventListener('deviceorientation', onDeviceOrientation);

  // 阻止 Swipe / 触摸导致页面滚动与浏览器缩放
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

/* ============================================================
 * p5 生命周期
 * ============================================================ */
function setup() {
  const holder = document.getElementById('canvas-container');
  const canvas = createCanvas(holder.clientWidth, holder.clientHeight);
  canvas.parent(holder);
  textFont('monospace');

  // p5-phone：锁定手机手势（embedded 模式只作用于画布）
  if (typeof lockGestures === 'function') {
    lockGestures({ mode: 'embedded', element: canvas.elt });
  }

  sensors.needPermission = needsSensorPermission();

  // 多人共享状态初始化（p5-phone Share）
  if (isShareConfigured()) {
    shareSetup({
      host: SHARE_CONFIG.host,       // URL 参数 ?shareHost= 优先于这里
      room: SHARE_CONFIG.room,
      app: SHARE_CONFIG.app,
      shared: {
        cells: {},                  // 占地地图：cells["x,y"] = { o: 玩家ID, c: 颜色下标 }
        objects: {                  // 4 个公共 Object（新房间的初始状态）
          o1: { state: 'ground' },
          o2: { state: 'ground' },
          o3: { state: 'ground' },
          o4: { state: 'ground' }
        }
      },
      me: {
        x: 12, y: 12, color: -1,    // color -1 = 未分配，连接后自动分配
        carryingObject: null,       // 携带的 Object ID（null = 空手）
        delivered: 0                // 已交付数量（自己）
      }
    });
    if (typeof showDesktopQr === 'function') showDesktopQr();  // 桌面二维码邀请（手机端自动不显示）
  } else {
    // 单机模式：未配置服务器时仍可本地游玩（me / shared 为普通对象）
    window.me = {
      x: 12, y: 12, color: 0,
      baseX: 12, baseY: 12,
      carryingObject: null,
      delivered: 0
    };
    window.guests = window.guests || [];
    window.shared.cells = {};
    window.shared.objects = {};
  }

  // 摄像机初始就对正玩家
  const t = clampCam(camTarget(me).x, camTarget(me).y);
  gameState.camera.x = t.x;
  gameState.camera.y = t.y;

  bindInput();
}

function draw() {
  background('#181b26');   // 地图外区域的颜色

  updateTilt();
  healObjects();            // 补齐缺失的 Object 条目
  ensureMyColor();          // 连接后：分配颜色/出生点/基地、解决颜色冲突
  resolveObjectConflicts(); // 裁决回滚：抢拾/被抢的输家自动放下
  assertDelivered();        // 守护已交付的 Object 不被迟到宣告复活
  updateJoinButton();
  updateCamera();

  push();
  translate(-gameState.camera.x, -gameState.camera.y); // 摄像机跟随
  drawTiles();
  drawBorder();
  drawBaseMarkers();
  drawObjects();
  drawPlayers();
  pop();

  drawBaseArrow();          // 屏幕边缘指向自己基地的箭头
  drawHUD();
  drawStealFeedback();      // 抢夺成功/失败/冷却/距离提示
}

// 手机旋转 / 窗口尺寸变化时重新适配画布
function windowResized() {
  const holder = document.getElementById('canvas-container');
  resizeCanvas(holder.clientWidth, holder.clientHeight);
}
