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

// 偷摸鱼（开心农场风）：从别人账上偷一点时长给自己
const STEAL_RATE = 0.05;   // 偷走对方总时长的 5%
const STEAL_MIN = 60;      // 对方总时长低于 60 秒不可偷
const STEAL_CD = 5000;     // 同一人两次偷之间冷却 5 秒

// ---------- 你画我猜（复用同一 WebSocket 房间，真·多人实时） ----------
// 350 词题库：职场 150 / 网络热梗 120 / 生活休闲 80（2-6 字、可画、无低俗暴力）
const WORD_BANK = {
  career: ["摸鱼","画饼","周报","月报","年报","加班","KPI","OKR","甩锅","背锅","复盘","团建","改需求","带薪拉屎","划水","打卡","汇报","提案","立项","裁员","优化","拉通","对齐","闭环","赋能","落地","跟进","推进","拉齐","同步","梳理","拆解","盘点","冲刺","救火","攻坚","突击","转正","实习","面试","跳槽","升职","加薪","降薪","调岗","离职","入职","内推","报销","请假","出差","培训","调休","早会","例会","站会","周会","月会","季度会","总结会","启动会","评审会","复盘会","庆功宴","散伙饭","头脑风暴","一对一","背靠背","视频会","PPT","Excel","文档","表格","邮件","群聊","语音","钉钉","飞书","企微","腾讯会议","屏幕共享","云文档","知识库","键盘","鼠标","显示器","工牌","工位","会议室","白板","投影仪","打印机","咖啡机","饮水机","老板","同事","甲方","乙方","客户","需求","排期","猎头","简历","竞业","合同","工资","年终奖","绩效","奖金","五险一金","公积金","社保","个税","绿植","升降桌","人体工学椅","防窥膜","降噪耳机","下午茶","零食","发票","摸鱼神器","抓手","颗粒度","组合拳","方法论","护城河","第二曲线","信息差","认知差","年假","保密","报税","共享文档","在线表格","需求评审","发版","Bug","测试","提测","改bug","背锅侠","摸鱼怪","划水王","画饼侠","卷王","内卷","准点下班","咖啡杯","订书机"],
  meme: ["摆烂","显眼包","发疯","CPU","泰裤辣","躺平","内卷","润了","绝绝子","emo","破防","裂开","蚌埠住了","栓Q","冤种","尊嘟假嘟","退退退","耶斯莫拉","集美","宝子","家人们","完了芭比Q","典中典","小丑竟是我","卷王","佛系","社恐","社牛","社死","雪王","蜜雪冰城","爷青回","真香","打脸","凡尔赛","阴阳怪气","绿茶","海王","渣男","普信","油腻","社畜","工具人","打工人","尾款人","干饭人","搬砖","韭菜","割韭菜","智商税","氛围感","仪式感","松弛感","钝感力","情绪价值","精神状态","发疯文学","废话文学","孔乙己的长衫","鼠鼠我啊","修行","修仙","电子木鱼","赛博","赛博朋克","元宇宙","蹭热度","流量","热搜","出圈","顶流","网红","种草","安利","上头","下头","躺赢","带飞","躺枪","翻车","翻盘","逆袭","逆天","离谱","抽象","小丑","吃瓜","吃瓜群众","爆料","实锤","塌房","洗白","翻红","黑红","毒唯","唯粉","路人粉","梦女","私生饭","脱粉","爬墙","墙头","本命","C位","出道","成团","限定","联名","周边","二创","鬼畜","名场面","高能","泪崩","治愈","解压","萌宠","手工","露营","飞盘"],
  life: ["奶茶","火锅","猫咪","可乐","雨伞","咖啡","啤酒","炸鸡","烧烤","串串","麻辣烫","螺蛳粉","煎饼","包子","饺子","面条","寿司","披萨","汉堡","薯条","蛋糕","面包","甜甜圈","冰淇淋","水果","苹果","香蕉","西瓜","草莓","葡萄","橙子","芒果","榴莲","桃子","樱桃","小狗","兔子","仓鼠","乌龟","金鱼","鹦鹉","多肉","鲜花","玫瑰","向日葵","书本","小说","漫画","电影","电视剧","综艺","游戏","钢琴","吉他","跑步","健身","瑜伽","游泳","篮球","足球","羽毛球","骑行","钓鱼","旅行","拍照","自拍","美甲","化妆","香水","口红","面膜","睡衣","枕头","被子","大床","沙发","抱枕","台灯","蜡烛","香薰"]
};
const CAT_LABEL = { career: '职场', meme: '网络热梗', life: '生活休闲' };
function pickWord() {
  const cats = Object.keys(WORD_BANK);
  const cat = cats[Math.floor(Math.random() * cats.length)];
  const arr = WORD_BANK[cat];
  return { word: arr[Math.floor(Math.random() * arr.length)], cat: CAT_LABEL[cat] };
}
// 下一轮画师：在现有用户里轮转
function nextDrawer(currentId) {
  const ids = Object.keys(state.users);
  if (!ids.length) return currentId;
  if (!currentId) return ids[0];
  const i = ids.indexOf(currentId);
  return ids[(i + 1) % ids.length];
}
// 推送当前画猜局状态（含最近笔画，供晚进的人回放）
// 注意：词（word）只发给画师本人，其他人只拿到字数（wordLen），防止偷看
function drawStateForClient(id) {
  const g = state.game || {};
  const amDrawer = !!(g.drawerId && g.drawerId === id);
  // 词：画师本人可见；本轮已揭晓（有人猜中）则全员可见，防止偷看
  const reveal = amDrawer || !!g.solved;
  return {
    type: 'drawState',
    word: reveal ? (g.word || null) : null,
    wordLen: g.word ? [...String(g.word)].length : 0,
    cat: g.cat || null,
    drawerId: g.drawerId || null,
    round: g.round || 0,
    ops: g.ops || [],
    swapsLeft: amDrawer ? (g.swapsLeft || 0) : 0,
    guessLog: g.guessLog || [],
    solved: !!g.solved,
    solvedBy: g.solvedBy || null
  };
}
function broadcastDraw() {
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    c.send(JSON.stringify(drawStateForClient(c.userId)));
  }
}

function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

// 共享状态：users 以 id 为 key，chats 为聊天记录（保留最近 50 条），xhs 为小红书热榜缓存
let state = { day: todayStr(), week: weekStr(), month: monthStr(), users: {}, chats: [], xhs: { updated: 0, items: [] }, game: { word: null, cat: null, drawerId: null, round: 0, ops: [], wordLen: 0, swapsLeft: 0, guessLog: [], solved: false, solvedBy: null } };

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
  if (!state.game || typeof state.game !== 'object') state.game = { word: null, cat: null, drawerId: null, round: 0, ops: [], wordLen: 0, swapsLeft: 0, guessLog: [], solved: false, solvedBy: null };
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
    merit: u.merit || 0,
    stolen: u.stolen || 0,
    stealCount: u.stealCount || 0,
    lastSteal: u.lastSteal || 0,
    drawScore: u.drawScore || 0
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

// 把一条聊天（含系统播报）实时推给所有在线客户端
function broadcastChat(m) {
  const payload = JSON.stringify({ type: 'chat', msg: m });
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

// 暂停某用户计时（落账 pending + 关闭 running），供 pause 按钮和连接断开兜底共用
function pauseUser(id) {
  const u = state.users[id];
  if (!u || !u.running) return;
  u.pending = (u.pending || 0) + (now() - u.runStart) / 1000;
  u.running = false;
  u.runStart = null;
  saveState();
  broadcast();
}

wss.on('connection', (ws) => {
  // 连接断开：若该用户无其他活跃连接，自动暂停计时（退出网页兜底）
  ws.on('close', () => {
    const uid = ws.userId;
    if (!uid) return;
    let stillOnline = false;
    for (const c of wss.clients) {
      if (c !== ws && c.readyState === 1 && c.userId === uid) { stillOnline = true; break; }
    }
    if (!stillOnline) {
      pauseUser(uid);
      // 画师掉线：自动轮转给下一位，避免游戏卡死（下一轮仍只能由新画师点）
      if (state.game && state.game.drawerId === uid) {
        state.game.drawerId = nextDrawer(uid);
        saveState();
        broadcastDraw();
      }
    }
  });

  // 新连接先发一份当前榜单（含服务端时间，用于客户端校正时钟漂移）+ 最近聊天记录
  ws.send(JSON.stringify({
    type: 'state',
    serverNow: now(),
    users: Object.values(state.users).map(toClientUser),
    chats: state.chats.slice(-50),
    xhs: state.xhs
  }));

  // 若当前已有画猜局，把局状态（含最近笔画）单独发给新连接，方便晚进的人回放
  if (state.game && state.game.drawerId) {
    ws.send(JSON.stringify(drawStateForClient(ws.userId)));
  }

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (e) { return; }

    const id = msg.id;
    if (!id) return;

    if (msg.type === 'join') {
      let u = state.users[id];
      if (!u) {
        u = {
          id,
          totalBase: 0, todayBase: 0, weekBase: 0, monthBase: 0, pending: 0,
          running: false, runStart: null,           caught: 0, catchCount: 0, merit: 0,
          stolen: 0, stealCount: 0, lastSteal: 0, drawScore: 0,
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
      ws.userId = id; // 绑定连接与用户，供 close 时自动暂停
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
      pauseUser(id);
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
      if (!t.running) return; // 只能抓正在摸鱼中的人
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
      broadcastChat(sys); // 系统播报实时进茶水间
      broadcast();
    } else if (msg.type === 'steal') {
      // 偷摸鱼：从别人账上偷一点时长加自己账上（开心农场风）
      const u = state.users[id];
      if (!u) return;
      const targetId = msg.target;
      if (!targetId || targetId === id) return;
      const t = state.users[targetId];
      if (!t) return;
      if ((t.totalBase || 0) < STEAL_MIN) return; // 对方还没攒够，偷不动
      const nowTs = now();
      if (u.lastSteal && nowTs - u.lastSteal < STEAL_CD) return; // 冷却中
      let amt = Math.max(STEAL_MIN, Math.round((t.totalBase || 0) * STEAL_RATE));
      amt = Math.min(amt, t.totalBase);
      const tamt = Math.min(amt, t.todayBase || 0);
      t.totalBase = (t.totalBase || 0) - amt;
      u.totalBase = (u.totalBase || 0) + amt;
      t.todayBase = (t.todayBase || 0) - tamt;
      u.todayBase = (u.todayBase || 0) + tamt;
      t.weekBase = (t.weekBase || 0) - tamt;
      u.weekBase = (u.weekBase || 0) + tamt;
      t.monthBase = (t.monthBase || 0) - tamt;
      u.monthBase = (u.monthBase || 0) + tamt;
      t.stolen = (t.stolen || 0) + 1;
      u.stealCount = (u.stealCount || 0) + 1;
      u.lastSteal = nowTs;
      saveState();
      const who = u.nickname || '匿名咸鱼';
      const victim = t.nickname || '匿名咸鱼';
      const sys = {
        id: crypto.randomUUID ? crypto.randomUUID() : 'c' + nowTs + Math.random().toString(36).slice(2),
        uid: 'system',
        nick: '🥷 摸鱼大盗',
        avatar: '🥷',
        text: `${who} 偷了 ${victim} 的摸鱼时长 ${fmtDur(amt)}！(${victim} 已被偷 ${t.stolen} 次，挂🚨)`,
        ts: nowTs
      };
      state.chats.push(sys);
      if (state.chats.length > 50) state.chats = state.chats.slice(-50);
      broadcastChat(sys); // 系统播报实时进茶水间
      broadcast();
    } else if (msg.type === 'merit') {
      // 电子木鱼：敲一下功德+1
      const u = state.users[id];
      if (!u) return;
      u.merit = (u.merit || 0) + 1;
      saveState();
      const mp = JSON.stringify({ type: 'merit', id: u.id, merit: u.merit });
      for (const c of wss.clients) if (c.readyState === 1) c.send(mp);
    } else if (msg.type === 'drawStart') {
      // 开一局：发起者当画师，服务端随机抽词。
      // 若已有人当画师（且仍在线），只有画师本人能"再来一局"；画师已离线则视为无效，任何人可重开。
      const u = state.users[id];
      if (!u) return;
      const g = state.game;
      const drawerOnline = g && g.drawerId && state.users[g.drawerId] &&
        [...wss.clients].some(c => c.readyState === 1 && c.userId === g.drawerId);
      if (drawerOnline && g.drawerId !== id) return;
      const w = pickWord();
      state.game.word = w.word;
      state.game.cat = w.cat;
      state.game.wordLen = [...String(w.word)].length;
      state.game.drawerId = id;
      state.game.round = (state.game.round || 0) + 1;
      state.game.ops = [];
      state.game.swapsLeft = 2;   // 画师最多换词 2 次
      state.game.solved = false; state.game.solvedBy = null;
      state.game.guessLog = [];   // 新开一局重置猜词记录
      saveState();
      broadcastDraw();
    } else if (msg.type === 'drawSwap') {
      // 画师换词：最多 2 次；猜词记录（聊天框）保留，不清空
      const g = state.game;
      if (!g || !g.drawerId || g.drawerId !== id) return; // 仅画师可换
      if ((g.swapsLeft || 0) <= 0) return;               // 次数已用完
      const w = pickWord();
      g.word = w.word; g.cat = w.cat;
      g.wordLen = [...String(w.word)].length;
      g.swapsLeft = (g.swapsLeft || 0) - 1;
      saveState();
      broadcastDraw();
      const dname = (state.users[id] && state.users[id].nickname) || '匿名咸鱼';
      const sp = JSON.stringify({ type: 'drawSwap', drawerId: id, name: dname, left: g.swapsLeft });
      for (const c of wss.clients) if (c.readyState === 1) c.send(sp);
    } else if (msg.type === 'drawStroke') {
      // 画师作画：仅画师可发，实时转发给他人，并留存最近笔画供回放
      const g = state.game;
      if (!g || !g.drawerId || g.drawerId !== id) return;
      const segs = Array.isArray(msg.segs) ? msg.segs.slice(0, 60) : [];
      if (!segs.length) return;
      g.ops = (g.ops || []).concat(segs);
      if (g.ops.length > 600) g.ops = g.ops.slice(-600);
      const payload = JSON.stringify({ type: 'draw', from: id, segs });
      for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
    } else if (msg.type === 'drawClear') {
      // 画师清空画布
      const g = state.game;
      if (!g || g.drawerId !== id) return;
      g.ops = [];
      const payload = JSON.stringify({ type: 'drawClear' });
      for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
    } else if (msg.type === 'drawGuess') {
      // 猜词：非画师才能猜。首个猜中 +10 分、画师 +5 分并揭晓答案；后续猜中不计分
      const g = state.game;
      if (!g || !g.drawerId) return;
      if (id === g.drawerId) return;
      const u = state.users[id];
      if (!u) return;
      const text = String(msg.text || '').trim().slice(0, 20);
      if (!text) return;
      const ans = String(g.word || '').trim().toLowerCase().replace(/\s+/g, '');
      const guess = text.toLowerCase().replace(/\s+/g, '');
      if (ans && guess === ans) {
        const name = u.nickname || '匿名咸鱼';
        if (!g.solved) {
          // 首个猜中：计分 + 标记已解 + 揭晓答案（不再自动轮转，等画师点「下一轮」）
          u.drawScore = (u.drawScore || 0) + 10;                 // 猜中者 +10
          const drawer = state.users[g.drawerId];
          if (drawer && drawer.id !== id) drawer.drawScore = (drawer.drawScore || 0) + 5; // 画师 +5
          g.solved = true; g.solvedBy = id;
          g.guessLog = (g.guessLog || []).concat([{ id, name, text: g.word, ok: true }]).slice(-30);
          saveState();
          const sys = {
            id: crypto.randomUUID ? crypto.randomUUID() : 'c' + now() + Math.random().toString(36).slice(2),
            uid: 'system', nick: '🎨 你画我猜', avatar: '🎨',
            text: `✅ ${name} 猜对了「${g.word}」！+10 分，画师 +5 分 🎉`,
            ts: now()
          };
          state.chats.push(sys);
          if (state.chats.length > 50) state.chats = state.chats.slice(-50);
          broadcastChat(sys);
          const sp = JSON.stringify({ type: 'drawSolved', word: g.word, solvedBy: id, solvedName: name });
          for (const c of wss.clients) if (c.readyState === 1) c.send(sp);
          broadcast();
        } else {
          // 已揭晓：后续猜中不计分，仅进聊天记录（标记 dup，前端提示"已揭晓"）
          g.guessLog = (g.guessLog || []).concat([{ id, name, text, ok: false, dup: true }]).slice(-30);
          saveState();
          const payload = JSON.stringify({ type: 'drawGuess', id, name, text });
          for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
        }
      } else {
        const name = u.nickname || '匿名咸鱼';
        // 记录到猜词日志（供后来者/重连者回看）；不广播整局以省流量，仅实时下发 drawGuess 提示
        g.guessLog = (g.guessLog || []).concat([{ id, name, text, ok: false }]).slice(-30);
        saveState();
        const payload = JSON.stringify({ type: 'drawGuess', id, name, text });
        for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
      }
    } else if (msg.type === 'drawNext') {
      // 下一轮：仅画师可触发（换词 + 轮转画师）。重置本轮已解状态
      const g = state.game;
      if (!g || !g.drawerId) return;
      if (g.drawerId !== id) return; // 只有画师能进入下一轮
      const w = pickWord();
      g.word = w.word; g.cat = w.cat;
      g.wordLen = [...String(w.word)].length;
      g.drawerId = nextDrawer(g.drawerId);
      g.round = (g.round || 0) + 1;
      g.ops = [];
      g.swapsLeft = 2; // 新一轮新画师，重置换词次数
      g.solved = false; g.solvedBy = null;
      saveState();
      broadcastDraw();
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
