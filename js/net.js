/* ============================================================
 * 格子漫游 · Grid Walker —— net.js（SharedRoom 联机层）
 *
 * 复用 DECIDER Phase 2 旧项目（my-project-phase-2）实际运行过的
 * SharedRoom 方案（旧提交 a734abe "Replace BroadcastChannel with MQTT
 * room system so real phones can join"）：
 *
 *   库       : MQTT.js 浏览器包（js/vendor/mqtt.min.js，全局 mqtt）
 *   连接地址 : 公共 MQTT broker（WebSocket），按顺序尝试：
 *              wss://broker.emqx.io:8084/mqtt
 *              wss://broker.hivemq.com:8884/mqtt
 *   初始化   : mqtt.connect(url, { clean:true, reconnectPeriod:3000,
 *              connectTimeout:8000, clientId:随机字符串 })；
 *              单个 broker 9 秒未连上自动切换下一个（与旧项目一致）。
 *   房间机制 : 所有设备订阅同一个 topic "gridwalker/phase2/<ROOM>"，
 *              无 Host——每部手机直接加入同一房间。ROOM 取值：
 *              ?room= URL 参数 → localStorage → 默认 GRIDWALKER。
 *
 * 游戏数据全部通过房间 topic 上的 JSON 消息（qos 0）同步：
 *   hello        新设备上线（带自己的玩家状态）
 *   bye          主动离开
 *   pstate       玩家状态（移动/颜色/携带/交付；同时兼任心跳，1.5s 一条）
 *   cell         占地写入 cells["x,y"] = { o, c }
 *   cells-clear  清空占地（PLAY AGAIN）
 *   obj          Object 状态写入 objects[objId] = { state, by }
 *   objs-clear   清空 Object（PLAY AGAIN）
 *   game         赛制写入 game = { phase, round, startAt }
 *   room-ping    请求房间快照（刚连上时发）
 *   room-state   房间快照（cells/objects/game，带每个键的写入时间戳）
 *
 * 一致性：公共 broker 没有中央裁决，每个写入带 (ts, id) 时间戳，
 * 所有设备用同一规则收敛——先比 ts、再比 id 字符串，较大者胜，
 * 等价于旧 Worker 的“按到达顺序 last-write-wins”（所有设备最终
 * 一致；不冒充原子性）。
 *
 * 在线状态：每 1.5 秒心跳（pstate），4 秒没收到任何消息的玩家从
 * guests 移除（HEARTBEAT_MS / OFFLINE_AFTER_MS 取自旧项目实际值）。
 *
 * 对外接口（sketch.js 使用）：
 *   netInit(opts)  —— 初始化 window.me / window.shared / window.guests
 *   netConnect()   —— 加入房间，返回 Promise；失败 reject(具体原因)
 * ============================================================ */
'use strict';

const _NET = {
  BROKERS: [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ],
  TOPIC_PREFIX: 'gridwalker/phase2/',
  ROOM_KEY: 'gridwalker-room',
  PLAYER_ID_KEY: 'gridwalker-player-id',
  DEFAULT_ROOM: 'GRIDWALKER',
  HEARTBEAT_MS: 1500,        // 心跳间隔（旧项目实际值）
  OFFLINE_AFTER_MS: 4000,    // 离线判定（旧项目实际值）
  BROKER_SWITCH_MS: 9000     // 单个 broker 未响应多久后换下一个（旧项目实际值）
};

let _client = null;          // mqtt 客户端
let _room = '';              // 规范化房间码
let _topic = '';             // 房间 topic
let _myId = '';              // 本机玩家 id
let _closedByUser = false;
let _heartbeatTimer = null;
let _pruneTimer = null;
let _lastBrokerError = '';
let _applyingRemote = false; // 应用远端消息时不回发

let _meBacking = null;       // window.me 的底层对象
let _sharedBacking = null;   // window.shared 的底层对象
let _replacingGame = false;  // window.shared.game 整体替换时，抑制逐字段广播

/* 每个写入键的 LWW 时间戳：key -> { ts, sid } */
const _stampCell = new Map();
const _stampObj = new Map();
let _stampGame = { ts: 0, sid: '' };

function _stampNow() {
  return { ts: Date.now(), sid: _myId };
}

/* a 较新返回正数：比较 (ts, sid)，sid 相同时相等 */
function _cmpStamp(a, b) {
  if (!a) return -1;
  if (!b) return 1;
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.sid === b.sid) return 0;
  return a.sid > b.sid ? 1 : -1;
}

function _send(msg) {
  if (_client && _client.connected) {
    _client.publish(_topic, JSON.stringify(msg), { qos: 0 });
  }
}

/* ---------- 房间码 / 玩家 id（机制与旧项目一致） ---------- */

function _normalizeRoom(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function _readRoom() {
  let fromUrl = null;
  try { fromUrl = new URLSearchParams(location.search).get('room'); } catch (e) { /* 忽略 */ }
  if (fromUrl && _normalizeRoom(fromUrl)) {
    const code = _normalizeRoom(fromUrl);
    try { localStorage.setItem(_NET.ROOM_KEY, code); } catch (e) { /* 忽略 */ }
    return code;
  }
  let stored = null;
  try { stored = localStorage.getItem(_NET.ROOM_KEY); } catch (e) { /* 忽略 */ }
  if (stored && _normalizeRoom(stored)) return _normalizeRoom(stored);
  return _NET.DEFAULT_ROOM;
}

function _getPlayerId() {
  let id = null;
  try { id = sessionStorage.getItem(_NET.PLAYER_ID_KEY); } catch (e) { /* 忽略 */ }
  if (!id) {
    id = 'p-' + Math.random().toString(36).slice(2, 9);
    try { sessionStorage.setItem(_NET.PLAYER_ID_KEY, id); } catch (e) { /* 忽略 */ }
  }
  return id;
}

/* ---------- 玩家状态（me / guests） ---------- */

function _meSnapshot() {
  return {
    x: _meBacking.x,
    y: _meBacking.y,
    color: _meBacking.color,
    baseX: _meBacking.baseX,
    baseY: _meBacking.baseY,
    carryingObject: _meBacking.carryingObject,
    delivered: _meBacking.delivered,
    ready: !!_meBacking.ready
  };
}

function _publishMe() {
  _send({ t: 'pstate', id: _myId, me: _meSnapshot() });
}

function _upsertGuest(s) {
  if (!s || typeof s.x !== 'number' || typeof s.y !== 'number') return;
  const id = String(s.id);
  if (id === _myId) return;
  const gs = window.guests || (window.guests = []);
  let g = null;
  for (let i = 0; i < gs.length; i++) {
    if (String(gs[i].id) === id) { g = gs[i]; break; }
  }
  if (!g) {
    g = { id: id };
    gs.push(g);
  }
  g.x = s.x;
  g.y = s.y;
  g.color = s.color;
  g.baseX = s.baseX;
  g.baseY = s.baseY;
  g.carryingObject = s.carryingObject;
  g.delivered = s.delivered;
  g.ready = !!s.ready;
  g.lastSeen = Date.now();
}

function _removeGuest(id) {
  const gs = window.guests || [];
  for (let i = gs.length - 1; i >= 0; i--) {
    if (String(gs[i].id) === String(id)) gs.splice(i, 1);
  }
}

function _pruneGuests() {
  const gs = window.guests || [];
  const gone = window.guestsOffline || (window.guestsOffline = []);
  const now = Date.now();
  for (let i = gs.length - 1; i >= 0; i--) {
    if (now - (gs[i].lastSeen || 0) > _NET.OFFLINE_AFTER_MS) {
      const g = gs.splice(i, 1)[0];
      // 保留快照：比赛中途断线的参与者仍可参与最终计分
      let dup = null;
      for (let j = 0; j < gone.length; j++) {
        if (String(gone[j].id) === String(g.id)) { dup = j; break; }
      }
      if (dup === null) {
        gone.push({
          id: g.id, x: g.x, y: g.y, color: g.color,
          baseX: g.baseX, baseY: g.baseY,
          carryingObject: g.carryingObject, delivered: g.delivered, ready: g.ready
        });
      }
    }
  }
}

/* ---------- shared 写入与 LWW 应用 ---------- */

function _snapshotGame() {
  const g = _sharedBacking.game;
  return {
    phase: g.phase,
    round: g.round,
    startAt: g.startAt,
    readyAt: g.readyAt,
    participants: g.participants,
    objects: g.objects
  };
}

/* 本地写 cells[key]（cells Proxy 的 set 陷阱调用） */
function _setCellLocal(key, value) {
  const stamp = _stampNow();
  _stampCell.set(key, stamp);
  _send({ t: 'cell', id: _myId, key: key, cell: value, ts: stamp.ts, sid: stamp.sid });
}

function _setObjLocal(key, value) {
  const stamp = _stampNow();
  _stampObj.set(key, stamp);
  _send({ t: 'obj', id: _myId, key: key, obj: value, ts: stamp.ts, sid: stamp.sid });
}

function _setGameLocal(value) {
  const stamp = _stampNow();
  _stampGame = stamp;
  _send({ t: 'game', id: _myId, game: value, ts: stamp.ts, sid: stamp.sid });
}

/* PLAY AGAIN：window.shared.cells = {} → 清空并广播 */
function _clearCellsLocal() {
  const stamp = _stampNow();
  for (const k of Object.keys(_sharedBacking.cells)) {
    if (_cmpStamp(stamp, _stampCell.get(k)) >= 0) {
      delete _sharedBacking.cells[k];
      _stampCell.set(k, stamp);
    }
  }
  _send({ t: 'cells-clear', id: _myId, ts: stamp.ts, sid: stamp.sid });
}

function _clearObjsLocal() {
  const stamp = _stampNow();
  for (const k of Object.keys(_sharedBacking.objects)) {
    if (_cmpStamp(stamp, _stampObj.get(k)) >= 0) {
      delete _sharedBacking.objects[k];
      _stampObj.set(k, stamp);
    }
  }
  _send({ t: 'objs-clear', id: _myId, ts: stamp.ts, sid: stamp.sid });
}

/* window.shared.game = {...} 整体替换（START / PLAY AGAIN） */
function _replaceGameLocal(value) {
  _replacingGame = true;
  try {
    const g = _sharedBacking.game;
    for (const k of Object.keys(g)) delete g[k];
    Object.assign(g, value || {});
  } finally { _replacingGame = false; }
  _setGameLocal(_snapshotGame());
}

/* 远端消息应用（LWW，_applyingRemote 期间不回发）。
 * 返回 true 表示本机状态确实发生了变化（用于收敛回广播）。 */

function _applyCell(key, cell, stamp) {
  if (!cell || typeof cell !== 'object') return false;
  if (_cmpStamp(stamp, _stampCell.get(key)) < 0) return false;
  _stampCell.set(key, stamp);
  _applyingRemote = true;
  try { _sharedBacking.cells[key] = cell; } finally { _applyingRemote = false; }
  return true;
}

function _applyObj(key, obj, stamp) {
  if (!obj || typeof obj !== 'object') return false;
  if (_cmpStamp(stamp, _stampObj.get(key)) < 0) return false;
  _stampObj.set(key, stamp);
  _applyingRemote = true;
  try { _sharedBacking.objects[key] = obj; } finally { _applyingRemote = false; }
  return true;
}

function _applyGame(g, stamp) {
  if (!g || typeof g !== 'object') return false;
  if (_cmpStamp(stamp, _stampGame) < 0) return false;
  _stampGame = stamp;
  _applyingRemote = true;
  try {
    const cur = _sharedBacking.game;
    for (const k of Object.keys(cur)) delete cur[k];
    Object.assign(cur, g);
  } finally { _applyingRemote = false; }
  return true;
}

function _applyCellsClear(stamp) {
  let changed = false;
  for (const k of Object.keys(_sharedBacking.cells)) {
    if (_cmpStamp(stamp, _stampCell.get(k)) >= 0) {
      _applyingRemote = true;
      try { delete _sharedBacking.cells[k]; } finally { _applyingRemote = false; }
      _stampCell.set(k, stamp);
      changed = true;
    }
  }
  return changed;
}

function _applyObjsClear(stamp) {
  let changed = false;
  for (const k of Object.keys(_sharedBacking.objects)) {
    if (_cmpStamp(stamp, _stampObj.get(k)) >= 0) {
      _applyingRemote = true;
      try { delete _sharedBacking.objects[k]; } finally { _applyingRemote = false; }
      _stampObj.set(k, stamp);
      changed = true;
    }
  }
  return changed;
}

/* 房间快照（cells/objects/game 全量 + 时间戳） */
function _roomStateMsg() {
  const cells = [];
  for (const k of Object.keys(_sharedBacking.cells)) {
    const st = _stampCell.get(k) || { ts: 0, sid: '' };
    cells.push([k, _sharedBacking.cells[k], st.ts, st.sid]);
  }
  const objects = [];
  for (const k of Object.keys(_sharedBacking.objects)) {
    const st = _stampObj.get(k) || { ts: 0, sid: '' };
    objects.push([k, _sharedBacking.objects[k], st.ts, st.sid]);
  }
  return {
    t: 'room-state',
    id: _myId,
    cells: cells,
    objects: objects,
    game: { g: _snapshotGame(), ts: _stampGame.ts, sid: _stampGame.sid }
  };
}

/* ---------- 消息分发 ---------- */

function _onMessage(msg) {
  if (!msg || typeof msg.t !== 'string') return;

  if (msg.t === 'room-state') {
    if (msg.id === _myId) return;
    let changed = false;
    if (Array.isArray(msg.cells)) {
      for (const c of msg.cells) {
        if (c && c.length >= 4 && _applyCell(c[0], c[1], { ts: c[2], sid: c[3] })) changed = true;
      }
    }
    if (Array.isArray(msg.objects)) {
      for (const o of msg.objects) {
        if (o && o.length >= 4 && _applyObj(o[0], o[1], { ts: o[2], sid: o[3] })) changed = true;
      }
    }
    if (msg.game && _applyGame(msg.game.g, { ts: msg.game.ts, sid: msg.game.sid })) changed = true;
    /* 收敛回广播：若本地状态因该快照发生了变化（例如重连设备带回了
     * 离线期间的本地写入，或本机缺少某些键），把自己的最新状态广播
     * 回去，让所有设备继续收敛。应用后无变化则不再回发（避免循环）。 */
    if (changed) _send(_roomStateMsg());
    return;
  }

  if (msg.id === _myId) return;

  switch (msg.t) {
    case 'hello':
      _upsertGuest(Object.assign({}, msg.me, { id: msg.id }));
      _publishMe();              // 让新设备立刻看到我
      _send(_roomStateMsg());    // 把房间现状同步给新设备
      break;
    case 'pstate':
      _upsertGuest(Object.assign({}, msg.me, { id: msg.id }));
      break;
    case 'bye':
      _removeGuest(msg.id);
      break;
    case 'cell':
      _applyCell(msg.key, msg.cell, { ts: msg.ts, sid: msg.sid });
      break;
    case 'cells-clear':
      _applyCellsClear({ ts: msg.ts, sid: msg.sid });
      break;
    case 'obj':
      _applyObj(msg.key, msg.obj, { ts: msg.ts, sid: msg.sid });
      break;
    case 'objs-clear':
      _applyObjsClear({ ts: msg.ts, sid: msg.sid });
      break;
    case 'game':
      _applyGame(msg.game, { ts: msg.ts, sid: msg.sid });
      break;
    case 'room-ping':
      _send(_roomStateMsg());
      break;
  }
}

/* ---------- 初始化：me / shared / guests ---------- */

function netInit(opts) {
  opts = opts || {};
  _room = _readRoom();
  _topic = _NET.TOPIC_PREFIX + _room;
  _myId = _getPlayerId();

  window.shareRoom = _room;
  window.shareClientId = _myId;
  window.shareStatus = 'idle';
  window.shareError = '';
  window.shareConnected = false;
  window.guests = [];
  window.guestsOffline = [];

  const sharedInit = opts.shared || {};
  const meInit = opts.me || {};

  _meBacking = {
    x: 12, y: 12, color: -1,
    baseX: undefined, baseY: undefined,
    carryingObject: null,
    delivered: 0,
    ready: false
  };
  Object.assign(_meBacking, meInit);

  _sharedBacking = {
    cells: Object.assign({}, sharedInit.cells || {}),
    objects: Object.assign({}, sharedInit.objects || {}),
    game: Object.assign({ phase: 'lobby', round: 0 }, sharedInit.game || {})
  };

  const initStamp = { ts: 0, sid: '' };
  _stampCell.clear();
  _stampObj.clear();
  for (const k of Object.keys(_sharedBacking.cells)) _stampCell.set(k, initStamp);
  for (const k of Object.keys(_sharedBacking.objects)) _stampObj.set(k, initStamp);
  _stampGame = initStamp;

  /* me：任何字段写入自动广播 pstate（含心跳语义） */
  window.me = new Proxy(_meBacking, {
    set(target, prop, value) {
      if (target[prop] === value) return true;
      target[prop] = value;
      _publishMe();
      return true;
    }
  });

  /* shared：cells/objects/game 写入自动广播对应消息 */
  window.shared = new Proxy(_sharedBacking, {
    set(target, prop, value) {
      if (prop === 'cells') { _clearCellsLocal(); return true; }
      if (prop === 'objects') { _clearObjsLocal(); return true; }
      if (prop === 'game') { _replaceGameLocal(value); return true; }
      target[prop] = value;
      return true;
    }
  });

  _sharedBacking.cells = new Proxy(_sharedBacking.cells, {
    set(target, key, value) {
      target[key] = value;                 // 写入底层对象，无递归
      if (!_applyingRemote) _setCellLocal(key, value);
      return true;
    }
  });

  _sharedBacking.objects = new Proxy(_sharedBacking.objects, {
    set(target, key, value) {
      target[key] = value;                 // 写入底层对象，无递归
      if (!_applyingRemote) _setObjLocal(key, value);
      return true;
    }
  });

  _sharedBacking.game = new Proxy(_sharedBacking.game, {
    set(target, key, value) {
      target[key] = value;                 // 写入底层对象，无递归
      if (!_applyingRemote && !_replacingGame) _setGameLocal(_snapshotGame());
      return true;
    }
  });

  if (!_pruneTimer) {
    _pruneTimer = setInterval(_pruneGuests, 1000);
  }
}

/* ---------- 连接：加入房间 ---------- */

function netConnect() {
  return new Promise(function (resolve, reject) {
    if (typeof mqtt === 'undefined') {
      const e = new Error('mqtt.min.js library not loaded');
      window.shareStatus = 'error';
      window.shareError = e.message;
      reject(e);
      return;
    }
    if (typeof WebSocket === 'undefined') {
      const e = new Error('WebSocket not supported by this browser');
      window.shareStatus = 'unsupported';
      window.shareError = e.message;
      reject(e);
      return;
    }

    /* 上一次失败遗留的连接先清理 */
    if (_client) {
      try { _client.end(true); } catch (e) { /* 忽略 */ }
      _client = null;
    }
    _stopTimers();

    window.shareStatus = 'connecting';
    window.shareError = '';
    window.shareConnected = false;
    _closedByUser = false;
    _lastBrokerError = '';
    _brokerIndex = 0;
    _tryBroker(resolve, reject);
  });
}

let _brokerIndex = 0;

function _tryBroker(resolve, reject) {
  if (_closedByUser) return;
  if (_brokerIndex >= _NET.BROKERS.length) {
    const reason = _lastBrokerError ? ' (last error: ' + _lastBrokerError + ')' : '';
    const e = new Error('All public MQTT brokers unreachable' + reason);
    window.shareStatus = 'error';
    window.shareError = e.message;
    reject(e);
    return;
  }

  const url = _NET.BROKERS[_brokerIndex];
  let settled = false;
  let client;
  try {
    client = mqtt.connect(url, {
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
      clientId: 'gridwalker-' + Math.random().toString(36).slice(2, 10)
    });
  } catch (e) {
    _lastBrokerError = (e && e.message) ? e.message : String(e);
    _brokerIndex++;
    _tryBroker(resolve, reject);
    return;
  }
  _client = client;

  /* 单个 broker 太久没响应：切换下一个（与旧项目一致） */
  const switchTimer = setTimeout(function () {
    if (!settled && client && !client.connected) {
      try { client.end(true); } catch (e) { /* 忽略 */ }
      _brokerIndex++;
      _tryBroker(resolve, reject);
    }
  }, _NET.BROKER_SWITCH_MS);

  client.on('connect', function () {
    clearTimeout(switchTimer);
    window.shareStatus = 'connected';
    window.shareConnected = true;
    window.shareError = '';
    client.subscribe(_topic, { qos: 0 });
    /* 重连后同样要重新打招呼 + 请求房间快照 */
    _send({ t: 'hello', id: _myId, me: _meSnapshot() });
    _send({ t: 'room-ping', id: _myId });
    _startTimers();
    if (!settled) {
      settled = true;
      resolve('connected');
    }
  });

  client.on('reconnect', function () {
    if (window.shareStatus !== 'connecting') {
      window.shareStatus = 'connecting';
      window.shareConnected = false;
    }
  });

  client.on('close', function () {
    if (_closedByUser) return;
    window.shareConnected = false;
    if (window.shareStatus === 'connected' || window.shareStatus === 'connecting') {
      window.shareStatus = 'connecting';   // mqtt.js 会自动重连（reconnectPeriod 3s）
    }
  });

  client.on('message', function (topic, payload) {
    if (topic !== _topic) return;
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
    _onMessage(msg);
  });

  client.on('error', function (err) {
    _lastBrokerError = (err && err.message) ? err.message : String(err);
    window.shareError = _lastBrokerError;
  });
}

function _startTimers() {
  if (!_heartbeatTimer) {
    _heartbeatTimer = setInterval(_publishMe, _NET.HEARTBEAT_MS);
  }
}

function _stopTimers() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

/* 离开页面：向房间广播 bye（尽力而为） */
window.addEventListener('pagehide', function () {
  _send({ t: 'bye', id: _myId });
  _stopTimers();
  _closedByUser = true;
  if (_client) {
    try { _client.end(true); } catch (e) { /* 忽略 */ }
    _client = null;
  }
});
