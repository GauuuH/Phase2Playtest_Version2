/* ============================================================
 * 格子漫游 · Grid Walker —— sketch.js
 *
 * 24×24 格子地图 + 摄像机跟随（Camera Follow）
 * 手机竖屏，屏幕方向按钮控制，每按一次移动一格
 *
 * ── 为将来接入 p5-phone-share（p5-phone 的 Share 功能）预留的结构 ──
 * 本文件刻意把「数据 / 逻辑 / 渲染 / 输入」分层：
 *
 *   gameState      —— 游戏的唯一数据源（所有玩家位置、摄像机）。
 *                     将来多人时把每个玩家都放进 gameState.players，
 *                     Host（大屏）负责绘制与同步，手机页面只做手柄。
 *
 *   movePlayer()   —— 唯一的移动入口：只改数据，不碰输入和渲染。
 *                     现在方向按钮直接调用它；将来改成：
 *                       手机：shareEmit('move', { dx, dy }) 发送按键；
 *                       Host：在 shareEvent(name, data, from) 回调里
 *                            收到后调用 movePlayer(from, data.dx, data.dy)。
 *                     其余代码（渲染、摄像机）完全不用改。
 *
 *   drawWorld() / drawPlayers() —— 渲染与逻辑分离，
 *                     Host 大屏可原样复用这些绘制函数。
 *
 * 将来接入步骤（现在不需要做）：
 *   1. index.html 里取消 p5-phone <script> 的注释；
 *   2. setup() 中加入：
 *        shareSetup({ host: 'https://你的.workers.dev', room: 'grid-walker' });
 *        enableShareTap();          // 手机点一下屏幕加入房间
 *   3. 用 shareEmit / shareEvent 把按钮按键转发给 Host。
 * ============================================================ */

'use strict';

/* ---------------- 世界配置 ---------------- */
const GRID   = 24;            // 24 × 24 格子地图
const CELL   = 40;            // 每格像素
const WORLD_W = GRID * CELL;  // 地图总宽 960px
const WORLD_H = GRID * CELL;  // 地图总高 960px（大于手机屏幕）

/* ---------------- 游戏状态（未来多人同步的唯一数据源） ---------------- */
const gameState = {
  players: {
    // 出生在地图正中央 (12, 12)
    me: { x: GRID / 2, y: GRID / 2, color: [255, 118, 87] }
  },
  camera: { x: 0, y: 0 }   // 摄像机左上角的世界坐标（像素）
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
 * 摄像机 —— Camera Follow
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

// 屏幕左上角 HUD：当前格子坐标
function drawHUD() {
  const me = gameState.players.me;
  noStroke();
  fill(0, 0, 0, 0.45);
  rect(8, 8, 106, 28, 8);
  fill(255);
  textSize(14);
  textAlign(LEFT, TOP);
  text('X ' + me.x + ' · Y ' + me.y, 18, 14);
}

/* ============================================================
 * 输入 —— 屏幕方向按钮（手机触摸）+ 键盘（桌面调试）
 * 将来接入多人同步时，按钮只负责发消息，不再直接调用 movePlayer
 * ============================================================ */
function bindInput() {
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
      e.preventDefault();                 // 阻止长按菜单 / 触摸模拟鼠标二次触发
      movePlayer('me', dir.dx, dir.dy);   // 每按一次移动一格
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // 桌面调试：方向键 / WASD
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

/* ============================================================
 * p5 生命周期
 * ============================================================ */
function setup() {
  const holder = document.getElementById('canvas-container');
  const canvas = createCanvas(holder.clientWidth, holder.clientHeight);
  canvas.parent(holder);
  textFont('monospace');

  // 摄像机初始就对正玩家，避免开局从 (0,0) 飞过来
  const me = gameState.players.me;
  const t  = clampCam(camTarget(me).x, camTarget(me).y);
  gameState.camera.x = t.x;
  gameState.camera.y = t.y;

  bindInput();
}

function draw() {
  background('#181b26');   // 地图外区域的颜色

  updateCamera();

  push();
  translate(-gameState.camera.x, -gameState.camera.y); // 摄像机跟随
  drawTiles();
  drawBorder();
  drawPlayers();
  pop();

  drawHUD();
}

function windowResized() {
  const holder = document.getElementById('canvas-container');
  resizeCanvas(holder.clientWidth, holder.clientHeight);
}
