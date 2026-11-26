/* ============================================================
 * 格子漫游 · Grid Walker —— sketch.js
 *
 * 24×24 格子地图 + Camera Follow（只跟随自己的角色）
 * 手机竖屏游戏，电脑仅用于开发调试
 *
 * ── 架构（为将来 p5-phone-share 多人同步预留） ──
 * 本游戏没有“电脑 Host 大屏”：
 *   未来每位玩家都在自己的手机上运行同一个页面，
 *   显示同一张共享地图，摄像机只跟随自己的角色。
 * 多人接入时：
 *   - gameState.players 会放进所有玩家的位置（现在只有 me）；
 *   - 手机间用 p5-phone-share 的 shared 状态 / shareEmit 同步按键，
 *     每台手机收到别人的按键后调用同一个 movePlayer(id, dx, dy)；
 *   - 渲染与摄像机代码不需要改动（drawPlayers 已按多人循环写）。
 * 电脑在本项目中仅用于开发与调试（键盘 WASD / 方向键）。
 *
 * ── 操作方式（手机） ──
 *   · Swipe：在游戏画面上向上/向下滑动，每次移动一格
 *   · Tilt ：左右倾斜手机横向移动；越过死区立即走一格，
 *            之后按固定间隔连续移动，回到中立角度停止
 *   · CALIBRATE：把当前握持姿态设为倾斜中立角
 *            （iPhone 上同时通过按钮请求方向传感器授权）
 *   · 屏幕方向按钮：备用操作，保证不支持倾斜的设备也能玩
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
const SWIPE_DIST   = 30;    // 滑动判定距离（px），小于此距离不算滑动
const TILT_DEADZONE = 5;    // 倾斜死区（°），|当前 - 中立| < 死区不移动，防止手抖误触发
const TILT_INTERVAL = 220;  // 倾斜越过死区后的固定移动间隔（ms）
const TILT_SIGN = 1;        // 个别设备若左右方向颠倒，改成 -1

/* ---------------- 游戏状态（未来多人同步的唯一数据源） ---------------- */
const gameState = {
  players: {
    // 出生在地图正中央 (12, 12)
    me: { x: GRID / 2, y: GRID / 2, color: [255, 118, 87] }
  },
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
 * 移动逻辑 —— 唯一入口，与输入方式无关
 * 角色不能离开地图边界（0 ~ GRID-1）
 * ============================================================ */
function movePlayer(id, dx, dy) {
  const p = gameState.players[id];
  if (!p) return;
  p.x = constrain(p.x + dx, 0, GRID - 1);
  p.y = constrain(p.y + dy, 0, GRID - 1);
}

/* ============================================================
 * 摄像机 —— Camera Follow（只跟随自己的角色）
 * 目标位置：让玩家保持在屏幕中央；
 * 靠近地图边缘时钳制摄像机，不显示地图外的区域；
 * 地图比屏幕小时则居中显示地图。
 * ============================================================ */
function clampCam(tx, ty) {
  return {
    x: WORLD_W <= width  ? (WORLD_W - width)  / 2 : constrain(tx, 0, WORLD_W - width),
    y: WORLD_H <= height ? (WORLD_H - height) / 2 : constrain(ty, 0, WORLD_H - height)
  };
}

function camTarget(me) {
  return {
    x: me.x * CELL + CELL / 2 - width / 2,
    y: me.y * CELL + CELL / 2 - height / 2
  };
}

function updateCamera() {
  const me  = gameState.players.me;
  const cam = gameState.camera;
  const t   = clampCam(camTarget(me).x, camTarget(me).y);

  // 平滑跟随，让移动观感更舒服
  cam.x = lerp(cam.x, t.x, 0.18);
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
// 新 API 用 screen.orientation.angle；旧 iOS Safari 用 window.orientation
function screenAngle() {
  if (window.screen && screen.orientation && typeof screen.orientation.angle === 'number') {
    return screen.orientation.angle;
  }
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

function onDeviceOrientation(e) {
  const g = e.gamma, b = e.beta;
  if (g == null || b == null || isNaN(g) || isNaN(b)) return;

  // 竖屏：gamma 即左右倾斜（正值 = 向右）；
  // 横屏：旋转轴对调，改用 beta（尽力而为，本游戏以竖屏为主）
  const angle = Math.abs(screenAngle());
  const tilt = (angle === 90 || angle === 270) ? -b : g;

  sensors.latest = tilt * TILT_SIGN;
  sensors.available = true;

  // 按下校准时还没有数据 → 现在用第一条数据完成校准
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
    sensors.pendingCalibrate = true;    // 等第一条传感器数据
  }
}

// CALIBRATE 按钮：
//  · iPhone（iOS 13+）需要用户手势请求传感器授权 → 通过按钮完成，
//    授权成功后直接以当前姿态校准；被拒绝则 HUD 提示，不报错
//  · Android / 桌面无需授权 → 直接校准
function onCalibratePress() {
  tryLockPortrait();   // 借用户手势尽力锁定竖屏（不支持则静默失败）

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
    movePlayer('me', dir, 0);            // 刚越过阈值：立即走一格
  } else if (now - sensors.lastMoveAt >= TILT_INTERVAL) {
    sensors.lastMoveAt = now;
    movePlayer('me', dir, 0);            // 保持倾斜：按固定间隔走格
  }
}

// 尽力把屏幕锁定为竖屏；需要全屏 / 用户手势的浏览器会拒绝 → 静默忽略，
// 布局本身自适应，横屏只是降级而不是崩溃
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
      // 棋盘格底色，便于看清每一格和摄像机的移动
      fill((x + y) % 2 === 0 ? '#8fae6b' : '#84a362');
      rect(x * CELL, y * CELL, CELL, CELL);
      drawLandmark(x, y);
    }
  }

  // 淡淡的网格线
  stroke(0, 0, 0, 25);
  strokeWeight(1);
  for (let i = 0; i <= GRID; i++) {
    line(i * CELL, 0, i * CELL, WORLD_H);
    line(0, i * CELL, WORLD_W, i * CELL);
  }
}

// 确定性“随机”地标（石头 / 树），验证移动和摄像机时更直观
function drawLandmark(x, y) {
  const h = Math.floor(Math.abs(Math.sin(x * 127.1 + y * 311.7) * 43758.5453)) % 100;
  const cx = x * CELL + CELL / 2;
  const cy = y * CELL + CELL / 2;

  if (h < 8) {                      // ~8% 石头
    fill(140, 140, 152);
    circle(cx, cy, CELL * 0.34);
    fill(108, 108, 120);
    circle(cx, cy + 2, CELL * 0.2);
  } else if (h < 18) {              // ~10% 树
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

function drawPlayers() {
  for (const id in gameState.players) {
    const p  = gameState.players[id];
    const cx = p.x * CELL + CELL / 2;
    const cy = p.y * CELL + CELL / 2;

    // 影子
    noStroke();
    fill(0, 0, 0, 60);
    ellipse(cx, cy + CELL * 0.3, CELL * 0.72, CELL * 0.26);

    // 角色：彩色圆形
    fill(p.color);
    stroke(255, 255, 255, 230);
    strokeWeight(3);
    circle(cx, cy, CELL * 0.66);
  }
}

// 屏幕左上角 HUD：当前格子坐标 + 倾斜传感器状态
function drawHUD() {
  const me = gameState.players.me;
  const line1 = 'X ' + me.x + ' · Y ' + me.y;
  const line2 = sensorStatusText();

  textSize(14);
  textAlign(LEFT, TOP);
  const w = Math.max(textWidth(line1), textWidth(line2)) + 20;

  noStroke();
  fill(0, 0, 0, 0.45);
  rect(8, 8, w, 46, 8);
  fill(255);
  text(line1, 18, 14);
  text(line2, 18, 30);
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

/* ============================================================
 * 输入
 * ============================================================ */

// Swipe：在游戏画面上向上/向下滑动，每次移动一格
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
    if (Math.abs(dy) < SWIPE_DIST) return;      // 距离不够 → 忽略
    if (Math.abs(dy) <= Math.abs(dx)) return;   // 横向为主 → 忽略（横向留给倾斜）
    movePlayer('me', 0, dy < 0 ? -1 : 1);       // 上滑向上走一格，下滑向下走一格
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
      movePlayer('me', dir.dx, dir.dy);
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
      movePlayer('me', dir.dx, dir.dy);
    }
  });
}

function bindInput() {
  bindSwipe(document.querySelector('#canvas-container canvas'));
  bindDpad();
  bindKeyboard();

  const calBtn = document.getElementById('btn-calibrate');
  if (calBtn) calBtn.addEventListener('click', onCalibratePress);

  window.addEventListener('deviceorientation', onDeviceOrientation);

  // 阻止 Swipe / 触摸导致页面滚动与浏览器缩放
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());   // iOS 双指缩放
}

/* ============================================================
 * p5 生命周期
 * ============================================================ */
function setup() {
  const holder = document.getElementById('canvas-container');
  const canvas = createCanvas(holder.clientWidth, holder.clientHeight);
  canvas.parent(holder);
  textFont('monospace');

  sensors.needPermission = needsSensorPermission();

  // 摄像机初始就对正玩家，避免开局从 (0,0) 飞过来
  const me = gameState.players.me;
  const t  = clampCam(camTarget(me).x, camTarget(me).y);
  gameState.camera.x = t.x;
  gameState.camera.y = t.y;

  bindInput();
}

function draw() {
  background('#181b26');   // 地图外区域的颜色

  updateTilt();
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
