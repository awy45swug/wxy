/**
 * 摸鱼计时排行榜 - 轻量多人联机服务端
 * 仅依赖 ws（WebSocket）。静态文件用 Node 内置 http 提供。
 *
 * 设计要点：
 * - 每个用户自带 id（客户端生成并持久化），服务端按 id 维护共享状态。
 * - 计时状态服务端权威：running / runStart 由服务端记录，
 *   避免客户端各算各的导致排行榜不一致。
 * - 实时广播：任意事件（加入/开始/暂停/结束/重置）都向所有人推送最新榜单。
 * - 持久化：状态写入 data.json，重启不丢数据。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// 共享状态：users 以 id 为 key
let state = { day: todayStr(), users: {} };

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && typeof raw.users === 'object') state = raw;
    }
  } catch (e) {
    console.error('读取存档失败，使用空状态:', e.message);
  }
  if (!state.day) state.day = todayStr();
  if (!state.users) state.users = {};
}
loadState();

let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DATA_FILE, JSON.stringify(state), (err) => {
      if (err) console.error('存档写入失败:', err.message);
    });
  }, 800);
}

const now = () => Date.now();

// 跨天自动清零今日数据
function checkDay() {
  const t = todayStr();
  if (state.day !== t) {
    state.day = t;
    for (const id in state.users) state.users[id].todayBase = 0;
    saveState();
  }
}

// 把服务端内部状态转成可下发的前端结构（保留 base 字段，便于客户端平滑滚动）
function toClientUser(u) {
  return {
    id: u.id,
    nickname: u.nickname,
    avatar: u.avatar,
    running: !!u.running,
    runStart: u.runStart || null,
    pending: u.pending || 0,
    totalBase: u.totalBase || 0,
    todayBase: u.todayBase || 0
  };
}

function broadcast() {
  checkDay();
  const payload = JSON.stringify({
    type: 'state',
    serverNow: now(),
    users: Object.values(state.users).map(toClientUser)
  });
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(payload);
  }
}

// ---------- 静态文件服务 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  // 新连接先发一份当前榜单（含服务端时间，用于客户端校正时钟漂移）
  ws.send(JSON.stringify({
    type: 'state',
    serverNow: now(),
    users: Object.values(state.users).map(toClientUser)
  }));

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (e) { return; }

    // 重置不需要 id，且应最先处理（清空所有人）
    if (msg.type === 'reset') {
      state.users = {};
      saveState();
      broadcast();
      return;
    }

    const id = msg.id;
    if (!id) return;

    if (msg.type === 'join') {
      let u = state.users[id];
      if (!u) {
        u = {
          id,
          totalBase: 0, todayBase: 0, pending: 0,
          running: false, runStart: null,
          nickname: msg.nickname || '匿名咸鱼',
          avatar: msg.avatar || '🐟',
          lastActive: now()
        };
        state.users[id] = u;
      } else {
        if (msg.nickname) u.nickname = msg.nickname;
        if (msg.avatar) u.avatar = msg.avatar;
        u.lastActive = now();
      }
      saveState();
      broadcast();
    } else if (msg.type === 'start') {
      const u = state.users[id];
      if (!u) return;
      if (!u.running) {
        u.running = true;
        u.runStart = now();
        saveState();
        broadcast();
      }
    } else if (msg.type === 'pause') {
      const u = state.users[id];
      if (!u || !u.running) return;
      u.pending = (u.pending || 0) + (now() - u.runStart) / 1000;
      u.running = false;
      u.runStart = null;
      saveState();
      broadcast();
    } else if (msg.type === 'stop') {
      const u = state.users[id];
      if (!u) return;
      let add = u.pending || 0;
      if (u.running && u.runStart) add += (now() - u.runStart) / 1000;
      u.totalBase = (u.totalBase || 0) + add;
      u.todayBase = (u.todayBase || 0) + add;
      u.pending = 0;
      u.running = false;
      u.runStart = null;
      saveState();
      broadcast();
    }
  });
});

// 每秒广播一次，保证排行榜实时滚动、跨天清零能及时生效
setInterval(broadcast, 1000);

server.listen(PORT, () => {
  console.log(`🐟 摸鱼排行榜已启动： http://localhost:${PORT}`);
  console.log(`   局域网内其他人访问 http://<你的IP>:${PORT} 即可一起摸鱼`);
});
