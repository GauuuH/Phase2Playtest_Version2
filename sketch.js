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
  host: '',              // ← 老师提供的 Worker URL（https://xxx.workers.dev）填这里；
                         //   也可不改代码，用 ?shareHost=…&room=… 链接参数覆盖（p5-phone 原生支持）
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

/* 7 个出生点（下标 = 颜色编号，所有设备一致） */
const SPAWNS = [
  { x: 12, y: 12 },  // 中央
  { x: 2,  y: 2  },  // 左上
  { x: 21, y: 2  },  // 右上
  { x: 2,  y: 21 },  // 左下
  { x: 21, y: 21 },  // 右下
  { x: 12, y: 2  },  // 上中
  { x: 12, y: 21 }   // 下中
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

function onlineCount() {
  if (!isConnected()) return 1;
  return 1 + (Array.isArray(window.guests) ? window.guests.length : 0);
}

/* ============================================================
 * 移动逻辑 —— 唯一入口，与输入方式无关
 * 只写自己的 me；边界检查在这里做（0 ~ GRID-1）。
 * p5-phone 会把 me 的改动自动同步给其他手机。
 * ============================================================ */
function moveMe(dx, dy) {
  const nx = constrain(me.x + dx, 0, GRID - 1);
  const ny = constrain(me.y + dy, 0, GRID - 1);
  me.x = nx;   // 已连接：自动同步；未连接：本地保存，连接时随 hello 补发
  me.y = ny;
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

  // 新玩家分配 / 冲突让位：找第一个空闲颜色
  const used = new Set();
  for (const g of gs) if (typeof g.color === 'number') used.add(g.color);
  let idx = 0;
  while (used.has(idx) && idx < PALETTE.length) idx++;
  idx = idx % PALETTE.length;

  const isNew = myColor < 0;
  me.color = idx;
  if (isNew) {
    const s = SPAWNS[idx % SPAWNS.length];
    me.x = s.x;   // 新玩家放到自己的出生点；重连玩家保留原位置
    me.y = s.y;
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
      fill((x + y) % 2 === 0 ? '#8fae6b' : '#84a362');
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

// 确定性“随机”地标（石头 / 树）
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

function drawBorder() {
  noFill();
  stroke(255, 255, 255, 90);
  strokeWeight(3);
  rect(0, 0, WORLD_W, WORLD_H);
}

function colorOf(i) {
  return PALETTE[typeof i === 'number' && i >= 0 && i < PALETTE.length ? i : 0];
}

// 渲染自己（me）+ 所有在线玩家（guests，由 p5-phone 自动维护）
function drawPlayers() {
  drawOnePlayer({ x: me.x, y: me.y, color: colorOf(me.color) }, true);

  const gs = window.guests || [];
  for (const g of gs) {
    drawOnePlayer({ x: g.x, y: g.y, color: colorOf(g.color) }, false);
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
}

// HUD：坐标 + 倾斜状态 + 联机状态
function drawHUD() {
  const lines = [
    'X ' + me.x + ' · Y ' + me.y,
    sensorStatusText(),
    connectionText()
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

// Swipe：画面上滑/下滑，每次移动一格
function bindSwipe(canvasEl) {
  let start = null;

  canvasEl.addEventListener('pointerdown', (e) => {
    if (start === null) start = { x: e.clientX, y: e.clientY };
  });

  const finish = (e) => {
    if (start === null) return;
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
  bindSwipe(document.querySelector('#canvas-container canvas'));
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
      me: { x: 12, y: 12, color: -1 }   // color -1 = 未分配，连接后自动分配
    });
    if (typeof showDesktopQr === 'function') showDesktopQr();  // 桌面二维码邀请（手机端自动不显示）
  } else {
    // 单机模式：未配置服务器时仍可本地游玩（me 为普通对象）
    window.me = { x: 12, y: 12, color: 0 };
    window.guests = window.guests || [];
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
  ensureMyColor();         // 连接后：分配颜色/出生点、解决颜色冲突
  updateJoinButton();
  updateCamera();

  push();
  translate(-gameState.camera.x, -gameState.camera.y); // 摄像机跟随
  drawTiles();
  drawBorder();
  drawPlayers();
  pop();

  drawHUD();
}

// 手机旋转 / 窗口尺寸变化时重新适配画布
function windowResized() {
  const holder = document.getElementById('canvas-container');
  resizeCanvas(holder.clientWidth, holder.clientHeight);
}
