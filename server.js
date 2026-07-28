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
const https = require('https');
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
// 周维度：以周一为一周起点（ISO 周）
function weekStr() {
  const d = new Date();
  const diff = (d.getDay() + 6) % 7; // 距本周一的天数
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
  const year = monday.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const weekNum = Math.ceil((((monday - jan1) / 86400000) + 1) / 7);
  return `${year}-W${weekNum}`;
}
function monthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

// 共享状态：users 以 id 为 key，chats 为聊天记录（保留最近 50 条），xhs 为小红书热榜缓存
let state = { day: todayStr(), week: weekStr(), month: monthStr(), users: {}, chats: [], xhs: { updated: 0, items: [] } };

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
  if (!state.week) state.week = weekStr();
  if (!state.month) state.month = monthStr();
  if (!state.users) state.users = {};
  if (!Array.isArray(state.chats)) state.chats = [];
  if (!state.xhs || !Array.isArray(state.xhs.items)) state.xhs = { updated: 0, items: [] };
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
// 跨周自动清零本周数据（周一为起点）
function checkWeek() {
  const t = weekStr();
  if (state.week !== t) {
    state.week = t;
    for (const id in state.users) state.users[id].weekBase = 0;
    saveState();
  }
}
// 跨月自动清零本月数据
function checkMonth() {
  const t = monthStr();
  if (state.month !== t) {
    state.month = t;
    for (const id in state.users) state.users[id].monthBase = 0;
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
    todayBase: u.todayBase || 0,
    weekBase: u.weekBase || 0,
    monthBase: u.monthBase || 0,
    caught: u.caught || 0,
    catchCount: u.catchCount || 0,
    merit: u.merit || 0
  };
}

function broadcast() {
  checkDay();
  checkWeek();
  checkMonth();
  const payload = JSON.stringify({
    type: 'state',
    serverNow: now(),
    users: Object.values(state.users).map(toClientUser)
  });
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(payload);
  }
}

// ---------- 小红书每日爆款 Top30（后端代理热榜聚合接口，拉不到时回落精选榜） ----------
const XHS_FALLBACK = [
  '打工人的工位减脂餐，一周不重样', '显眼包穿搭才是夏日顶流', '带薪摸鱼一小时续命一整天',
  '在家复刻网红奶茶，省下30块', '通勤包里到底装了什么', '打工人早C晚A护肤实录',
  '租房改造｜10㎡也能很高级', '周末citywalkCity不city', '摸鱼文学大赛获奖作品',
  '办公室养生茶包测评', '把Excel玩成游戏的人赢麻了', '今日份云吸猫已送达',
  '下班后的副业搞钱实录', '打工人emo瞬间大赏', '便宜好用的国货护肤品',
  '一个人也要好好吃饭', '拒绝内耗的100件小事', '工位绿植养护指南',
  '摸鱼搭子招募中', '老板画饼图鉴合集', '打工人の快乐水推荐', '县城旅游才是真香',
  '把通勤变成移动充电站', '带薪发呆的正当性论证', '电脑壁纸审美提升计划',
  '摸鱼被抓后的演技修炼', '周五下班仪式感打卡', '周末补觉睡到自然醒',
  '打工人的电子木鱼功德+1', '通勤路上听播客更快乐'
].map((title, i) => ({ rank: i + 1, title, hot: '' }));

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 7000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function normalizeXhs(json) {
  let arr = [];
  if (Array.isArray(json)) arr = json;
  else if (Array.isArray(json.data)) arr = json.data;
  else if (json.data && Array.isArray(json.data.list)) arr = json.data.list;
  else if (Array.isArray(json.list)) arr = json.list;
  return arr
    .slice(0, 30)
    .map((it, i) => ({
      rank: i + 1,
      title: String(it.title || it.name || it.word || '').trim(),
      hot: String(it.hot || it.heat || it.hotScore || it.score || '').trim()
    }))
    .filter((it) => it.title);
}

async function refreshXhs() {
  try {
    const raw = await httpGet('https://api.vvhan.com/api/hotlist?type=xiaohongshu', 8000);
    const items = normalizeXhs(JSON.parse(raw));
    if (items.length) {
      state.xhs = { updated: now(), items, live: true };
    } else {
      throw new Error('空数据');
    }
  } catch (e) {
    console.error('[xhs] 实时热榜拉取失败，使用精选榜:', e.message);
    if (!state.xhs.items.length) state.xhs = { updated: now(), items: XHS_FALLBACK, live: false };
    else state.xhs.live = false;
  }
  saveState();
  broadcastXhs();
}

function broadcastXhs() {
  const payload = JSON.stringify({ type: 'xhs', updated: state.xhs.updated, live: !!state.xhs.live, items: state.xhs.items });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
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
  // 新连接先发一份当前榜单（含服务端时间，用于客户端校正时钟漂移）+ 最近聊天记录
  ws.send(JSON.stringify({
    type: 'state',
    serverNow: now(),
    users: Object.values(state.users).map(toClientUser),
    chats: state.chats.slice(-50),
    xhs: state.xhs
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
          totalBase: 0, todayBase: 0, weekBase: 0, monthBase: 0, pending: 0,
          running: false, runStart: null, caught: 0, catchCount: 0, merit: 0,
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
      u.weekBase = (u.weekBase || 0) + add;
      u.monthBase = (u.monthBase || 0) + add;
      u.pending = 0;
      u.running = false;
      u.runStart = null;
      saveState();
      broadcast();
    } else if (msg.type === 'chat') {
      const u = state.users[id];
      if (!u) return; // 未加入不能发言
      const text = String(msg.text || '').trim().slice(0, 200);
      if (!text) return;
      const m = {
        id: crypto.randomUUID ? crypto.randomUUID() : 'c' + now() + Math.random().toString(36).slice(2),
        uid: u.id,
        nick: u.nickname || '匿名咸鱼',
        avatar: u.avatar || '🐟',
        text,
        ts: now()
      };
      state.chats.push(m);
      if (state.chats.length > 50) state.chats = state.chats.slice(-50);
      saveState();
      const payload = JSON.stringify({ type: 'chat', msg: m });
      for (const c of wss.clients) {
        if (c.readyState === 1) c.send(payload);
      }
    } else if (msg.type === 'catch') {
      // 抓摸鱼：举报别人在摸鱼（不能抓自己）
      const u = state.users[id];
      if (!u) return;
      const targetId = msg.target;
      if (!targetId || targetId === id) return;
      const t = state.users[targetId];
      if (!t) return;
      t.caught = (t.caught || 0) + 1;
      u.catchCount = (u.catchCount || 0) + 1;
      const who = u.nickname || '匿名咸鱼';
      const victim = t.nickname || '匿名咸鱼';
      // 系统播报一条聊天，全员可见
      const sys = {
        id: crypto.randomUUID ? crypto.randomUUID() : 'c' + now() + Math.random().toString(36).slice(2),
        uid: 'system',
        nick: '🚨 抓鱼员',
        avatar: '🚨',
        text: `${who} 抓到 ${victim} 在摸鱼！(已累计被抓 ${t.caught} 次)`,
        ts: now()
      };
      state.chats.push(sys);
      if (state.chats.length > 50) state.chats = state.chats.slice(-50);
      saveState();
      const fx = JSON.stringify({ type: 'catch', by: who, target: victim, targetId, caught: t.caught });
      for (const c of wss.clients) if (c.readyState === 1) c.send(fx);
      broadcast();
    } else if (msg.type === 'merit') {
      // 电子木鱼：敲一下功德+1
      const u = state.users[id];
      if (!u) return;
      u.merit = (u.merit || 0) + 1;
      saveState();
      const mp = JSON.stringify({ type: 'merit', id: u.id, merit: u.merit });
      for (const c of wss.clients) if (c.readyState === 1) c.send(mp);
    }
  });
});

// 每秒广播一次，保证排行榜实时滚动、跨天/跨周/跨月清零能及时生效
setInterval(broadcast, 1000);

server.listen(PORT, () => {
  console.log(`🐟 摸鱼排行榜已启动： http://localhost:${PORT}`);
  console.log(`   局域网内其他人访问 http://<你的IP>:${PORT} 即可一起摸鱼`);
  // 先给一份精选榜兜底，保证新连接的客户端立即可见 Top30，随后实时拉取再升级
  if (!state.xhs.items || !state.xhs.items.length) {
    state.xhs = { updated: now(), items: XHS_FALLBACK, live: false };
  }
  refreshXhs();
  setInterval(refreshXhs, 10 * 60 * 1000); // 每 10 分钟刷新一次小红书热榜
});
