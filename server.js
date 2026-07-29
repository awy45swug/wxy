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
// 词库数据（你画我猜 WORD_BANK / 谁是卧底 SPY_BANKS）抽到独立模块，便于维护与去重
const { WORD_BANK, CAT_LABEL, SPY_BANKS, SPY_BANK_LABEL } = require('./wordbank');

// ===== 进程级异常兜底：避免任何未捕获异常 / 未处理 Promise 直接杀死整个服务 =====
// 本服务常作为无 supervisor 的长驻进程运行，单点异常不应拖垮所有在线用户，
// 因此统一捕获并记录日志，让进程继续存活（关键逻辑另有局部 try-catch 兜底）。
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e && e.stack || e); });

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
// 数据落盘文件：
//  - 默认写在程序目录 data.json；
//  - 若检测到 CloudBase 云托管挂载的文件存储卷 /data（CFS），自动改用 /data/data.json，
//    这样容器重启 / 重新部署都不会丢数据（在云托管控制台把文件存储挂到 /data 即可，无需改代码）。
//  - 也可用环境变量 DATA_FILE 自定义绝对路径（指向任意持久卷）。
const DATA_DIR_HINT = '/data';
const DATA_FILE = process.env.DATA_FILE ||
  (fs.existsSync(DATA_DIR_HINT) && fs.statSync(DATA_DIR_HINT).isDirectory()
    ? path.join(DATA_DIR_HINT, 'data.json')
    : path.join(__dirname, 'data.json'));
// 写盘临时文件：先写 .tmp 再 rename 覆盖，保证 data.json 原子替换（中途崩溃可回退）
const DATA_TMP = DATA_FILE + '.tmp';

// 你画我猜：即使不是当前画师，这些昵称也拥有「下一轮」按钮权限
const DRAW_NEXT_ALLOW = ['羡温言', 'LL', '水果刀', '慢慢'];
// 进场禁用的匿名昵称（防止"匿名闲鱼/匿名咸鱼"这类无意义名）
const FORBIDDEN_NICKS = ['匿名闲鱼', '匿名咸鱼'];
const CHAT_KEEP = 200; // 聊天记录滚动上限（保留最近 N 条）
const CHAT_CD = 1000, MERIT_CD = 150, CATCH_CD = 3000; // 操作冷却：发言 / 敲木鱼 / 抓鱼

// 你画我猜：单局时长与首字拼音提示时机（毫秒）。
// 可用环境变量 DRAW_TEST_FAST=1 加速自动化测试（2 秒一局 / 1 秒提示）。
const DRAW_ROUND_MS = process.env.DRAW_TEST_FAST ? 2000 : 180000;
const DRAW_HINT_AT_MS = process.env.DRAW_TEST_FAST ? 1000 : 150000;
// 词库首字拼音映射（自动生成，见 scripts/gen_pinyin_map.js），用于"150 秒首字拼音提示"
const DRAW_PINYIN_MAP = require('./draw_pinyin_map');

// 谁是卧底：拥有「开始游戏」权限的昵称（与画师下一轮白名单一致）
const SPY_HOST_ALLOW = DRAW_NEXT_ALLOW;
const SPY_MIN = 3, SPY_MAX = 8;
// 发言阶段每位玩家的描述倒计时（毫秒），超时自动跳到下一位
const SPY_SPEAK_MS = process.env.SPY_TEST_FAST ? 5000 : 30000;
// 断线宽限：玩家掉线后保留游戏身份多久（毫秒），期间重连则恢复，超时则真正退出本局
const SPY_RECONNECT_GRACE = process.env.SPY_TEST_FAST ? 4000 : 15000;
// 双词库：每组含平民词 civ 与近似的卧底词 spy

// 根据参与者 id 生成稳定的随机代号（匿名模式用）
function codeFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return '玩家' + (h % 9000 + 1000);
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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
// 题库分三类，每类再分 easy(简单)/hard(困难)：
//   easy 70%：实物 / 动作 / 大众梗（直接可画）
//   hard 30%：轻度抽象但有强象征符号（如 内卷=赛跑、摆烂=躺地、摸鱼=鱼）
// 入库校验：2-4 字、普通人能简笔画/火柴人画出让人看懂、有 1-2 个标志性画面、
//   大众都认识、无负面低俗、非纯抽象概念。英文缩写仅保留 OKR/KPI；PPT/Excel 为产品名。
//   已删除：纯情绪词(破防/绝绝子)、歧义词(糊/格局)、5字+、互联网黑话(赋能/闭环/抓手)、
//   冷门梗(泰裤辣/尊嘟假嘟)、纯抽象(氛围感/仪式感)。

// 防重复：记录已抽过的词，全库抽完一轮才重置（持久化到 data.json，重启也接着防）
// preferCat 可选：指定只从该分类抽（你画我猜支持选词库分类）
function pickWord(preferCat) {
  const cats = Object.keys(WORD_BANK);
  const totalCount = cats.reduce((n, c) => n + WORD_BANK[c].easy.length + WORD_BANK[c].hard.length, 0);
  const used = state.usedWords || (state.usedWords = []);
  if (used.length >= totalCount) {
    // 整库用完，重置一轮；但保留刚用过的词，避免「重置瞬间立刻又抽到同一个」
    const lastW = used[used.length - 1];
    used.length = 0;
    if (lastW) used.push(lastW);
  }
  const tryPick = (catList) => {
    const catOrder = catList.slice().sort(() => Math.random() - 0.5);
    for (const cat of catOrder) {
      const bank = WORD_BANK[cat];
      const easyLeft = bank.easy.filter(w => !used.includes(w));
      const hardLeft = bank.hard.filter(w => !used.includes(w));
      if (!easyLeft.length && !hardLeft.length) continue;
      const useHard = (Math.random() < 0.3 && hardLeft.length > 0) || !easyLeft.length;
      const arr = useHard ? hardLeft : easyLeft;
      const word = arr[Math.floor(Math.random() * arr.length)];
      used.push(word);
      return { word, cat: CAT_LABEL[cat] };
    }
    return null;
  };
  if (preferCat && WORD_BANK[preferCat]) {
    const r = tryPick([preferCat]);
    if (r) return r; // 指定分类优先；该分类抽光则回退全库
  }
  const r = tryPick(cats);
  if (r) return r;
  const lastW = used[used.length - 1];
  used.length = 0; // 兜底：全库抽光，重置后重试
  if (lastW) used.push(lastW);
  const cat = cats[0];
  const w = WORD_BANK[cat].easy[0];
  used.push(w);
  return { word: w, cat: CAT_LABEL[cat] };
}
// 推送当前画猜局状态（含最近笔画，供晚进的人回放）
// 注意：词（word）只发给画师本人，其他人只拿到字数（wordLen），防止偷看
function drawStateForClient(id) {
  const g = state.game || {};
  const amDrawer = !!(g.drawerId && g.drawerId === id);
  // 词：画师本人可见；本轮已揭晓（有人猜中）则全员可见，防止偷看
  const reveal = amDrawer || !!g.solved;
  const joined = (g.players || []).includes(id);
  const players = (g.players || []).map(pid => {
    const u = state.users[pid];
    return { id: pid, name: (u && u.nickname) || '匿名咸鱼', avatar: (u && u.avatar) || '🐟' };
  });
  const spectators = [...drawPresent].filter(pid => !(g.players || []).includes(pid) && state.users[pid]).map(pid => {
    const u = state.users[pid];
    return { id: pid, name: (u && u.nickname) || '匿名咸鱼', avatar: (u && u.avatar) || '🐟' };
  });
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
    solvedBy: g.solvedBy || null,
    joined, players, spectators,
    deadline: g.deadline || 0,
    settled: !!g.settled,
    hint: g.hint || null
  };
}
function broadcastDraw() {
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    c.send(JSON.stringify(drawStateForClient(c.userId)));
  }
}

// ---------- 谁是卧底 ----------
// 词/身份只发给本人；其他人（含围观者）只看到代号/昵称与是否出局，看不到角色与词语
function spyStateForClient(id) {
  const s = state.spy || {};
  const isPlayer = (s.players || []).includes(id);
  const myWord = isPlayer && s.words && s.words[id] ? s.words[id] : null;
  const me = myWord ? { role: myWord.role, word: myWord.word, code: myWord.code } : null;
  const players = (s.players || []).map(pid => {
    const u = state.users[pid];
    const w = (s.words && s.words[pid]) || {};
    const code = w.code || codeFor(pid);
    const name = s.anonymous ? code : (u ? (u.nickname || '匿名') : '已离开');
    return {
      id: pid, name, code,
      isMe: pid === id,
      alive: !w.out,
      out: !!w.out,
      disconnected: !!(s.disconnected && s.disconnected[pid]),
      voted: !!(s.votes && s.votes[pid] !== undefined),
      role: (s.phase === 'over') ? (w.role || null) : null  // 仅结算时全员可见身份
    };
  });
  const speeches = (s.speeches || []).map(sp => ({
    id: sp.id,
    name: s.anonymous ? codeFor(sp.id) : ((state.users[sp.id] && state.users[sp.id].nickname) || '玩家'),
    text: sp.text
  }));
  const tally = {};
  Object.values(s.votes || {}).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
  return {
    type: 'spyState',
    phase: s.phase || 'lobby',
    bank: s.bank || 'career',
    anonymous: !!s.anonymous,
    hostId: s.hostId || null,
    players,
    me,
    order: s.order || [],
    speakIdx: s.speakIdx || 0,
    speeches,
    votes: (s.phase === 'over') ? (s.votes || {}) : {},   // 投票去向仅结算时公开
    tally: (s.phase === 'vote' || s.phase === 'over') ? tally : {},
    round: s.round || 0,
    speakDeadline: s.speakDeadline || 0,
    result: s.result || null,
    min: SPY_MIN, max: SPY_MAX,
    bankLabel: SPY_BANK_LABEL[s.bank || 'career']
  };
}
function broadcastSpy() {
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    c.send(JSON.stringify(spyStateForClient(c.userId)));
  }
}
// 进入发言阶段：把 speakIdx 指向第一个仍存活的玩家，并启动发言倒计时
let spySpeakTimer = null;
function clearSpySpeakTimer() {
  if (spySpeakTimer) { clearTimeout(spySpeakTimer); spySpeakTimer = null; }
}
function spyGotoSpeak() {
  const s = state.spy;
  clearSpySpeakTimer();
  s.speakIdx = 0;
  while (s.speakIdx < s.order.length && s.words[s.order[s.speakIdx]] && s.words[s.order[s.speakIdx]].out) s.speakIdx++;
  if (s.speakIdx >= s.order.length) { s.phase = 'vote'; s.votes = {}; s.speakDeadline = 0; return; }
  s.phase = 'speak';
  s.speakDeadline = now() + SPY_SPEAK_MS;
  spySpeakTimer = setTimeout(onSpySpeakTimeout, SPY_SPEAK_MS);
}
// 发言倒计时超时：当前发言者未描述，跳过进入下一位或投票阶段
function onSpySpeakTimeout() {
  const s = state.spy;
  spySpeakTimer = null;
  if (!s || s.phase !== 'speak') return;
  s.speakIdx++;
  while (s.speakIdx < s.order.length && s.words[s.order[s.speakIdx]] && s.words[s.order[s.speakIdx]].out) s.speakIdx++;
  if (s.speakIdx >= s.order.length) { s.phase = 'vote'; s.votes = {}; s.speakDeadline = 0; }
  else { s.phase = 'speak'; s.speakDeadline = now() + SPY_SPEAK_MS; spySpeakTimer = setTimeout(onSpySpeakTimeout, SPY_SPEAK_MS); }
  saveState();
  broadcastSpy();
}
// 投票结束后结算本轮：淘汰最高票玩家，判定胜负或进入下一轮
function spyTally() {
  const s = state.spy;
  const alive = s.players.filter(p => s.words[p] && !s.words[p].out);
  const tally = {};
  Object.values(s.votes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
  let max = 0; Object.values(tally).forEach(v => { if (v > max) max = v; });
  const top = Object.keys(tally).filter(k => tally[k] === max);
  const eliminated = top[Math.floor(Math.random() * top.length)]; // 平票随机淘汰一人
  if (s.words[eliminated]) s.words[eliminated].out = true;
  const aliveSpies = s.players.filter(p => s.words[p] && !s.words[p].out && s.words[p].role === 'spy').length;
  const aliveTotal = s.players.filter(p => s.words[p] && !s.words[p].out).length;
  if (aliveSpies === 0) return spyFinish('civ', eliminated);
  if (aliveTotal === aliveSpies) return spyFinish('spy', eliminated);
  // 继续下一轮
  s.round = (s.round || 0) + 1;
  s.speeches = [];
  s.votes = {};
  spyGotoSpeak();
  return null;
}
function spyFinish(winner, eliminated) {
  const s = state.spy;
  s.phase = 'over';
  const undercovers = s.players.filter(p => s.words[p].role === 'spy');
  const words = {};
  s.players.forEach(p => {
    const u = state.users[p];
    words[p] = {
      role: s.words[p].role,
      word: s.words[p].word,
      code: s.words[p].code,
      name: s.anonymous ? s.words[p].code : (u ? (u.nickname || '匿名') : '已离开')
    };
  });
  s.result = { winner, undercovers, words, eliminated };
}

function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

// 共享状态：users 以 id 为 key，chats 为聊天记录
let state = {
  day: todayStr(), week: weekStr(), month: monthStr(), users: {}, usedWords: [], chats: [],
  game: { word: null, cat: null, drawerId: null, round: 0, ops: [], wordLen: 0, swapsLeft: 0, guessLog: [], solved: false, solvedBy: null, players: [], deadline: 0, settled: false, hint: null, hintGiven: false },
  spy: { phase: 'lobby', bank: 'career', anonymous: false, hostId: null, players: [], words: {}, order: [], speakIdx: 0, speeches: [], votes: {}, round: 0, result: null }
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && typeof raw.users === 'object') state = raw;
      else throw new Error('结构无效，尝试备份');
    }
  } catch (e) {
    console.error('读取主存档失败，尝试 .tmp 备份:', e.message);
    try {
      if (fs.existsSync(DATA_TMP)) {
        const raw = JSON.parse(fs.readFileSync(DATA_TMP, 'utf8'));
        if (raw && typeof raw.users === 'object') { state = raw; console.error('已从 data.json.tmp 备份恢复'); }
      }
    } catch (e2) { console.error('备份恢复也失败，使用空状态:', e2.message); }
  }
  if (!state.day) state.day = todayStr();
  if (!state.week) state.week = weekStr();
  if (!state.month) state.month = monthStr();
  if (!state.users) state.users = {};
  if (!Array.isArray(state.usedWords)) state.usedWords = [];
  if (!Array.isArray(state.chats)) state.chats = [];
  if (!state.game || typeof state.game !== 'object') state.game = { word: null, cat: null, drawerId: null, round: 0, ops: [], wordLen: 0, swapsLeft: 0, guessLog: [], solved: false, solvedBy: null, players: [], deadline: 0, settled: false, hint: null, hintGiven: false };
  if (!state.spy || typeof state.spy !== 'object') state.spy = { phase: 'lobby', bank: 'career', anonymous: false, hostId: null, players: [], words: {}, order: [], speakIdx: 0, speeches: [], votes: {}, round: 0, result: null };
}
loadState();

// 重启后清理失效的计时状态，避免卡在"进行中"却无计时器
if (state.game && state.game.deadline && state.game.deadline < now()) {
  state.game.deadline = 0;
  if (state.game.drawerId) { state.game.settled = true; state.game.solved = true; }
}

let saveTimer = null;
// 原子写盘：先写临时文件再 rename 覆盖，避免进程在写入中途崩溃导致 data.json 损坏、全部存档丢失
function writeStateFileAtomic(content) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_TMP, content);
  fs.renameSync(DATA_TMP, DATA_FILE);
}
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeStateFileAtomic(JSON.stringify(state)); }
    catch (e) { console.error('存档写入失败:', e.message); }
  }, 800);
}
// 立即落盘（绕过 800ms 防抖），用于定时兜底与关键时点
function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { writeStateFileAtomic(JSON.stringify(state)); }
  catch (e) { console.error('存档写入失败:', e.message); }
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
  if (urlPath === '/health' || urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, ts: now(), users: Object.keys(state.users || {}).length }));
    return;
  }
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
    // 关键：sw.js / app.js / style.css / index.html 不允许浏览器启发式缓存，
    // 否则改了前端代码后老用户的浏览器一直拿旧文件（尤其是 sw.js 有 24h 更新节流）。
    const noCache = (ext === '.js' || ext === '.css' || ext === '.html');
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (noCache) headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

// 当前已点进「你画我猜」页面的用户 id 集合。
// 只有在这个集合里的用户，才能认领画师座位、或保持画师身份（即必须"点进你画我猜页面"才行）。
const drawPresent = new Set();
// 谁是卧底：玩家断线后的宽限计时（uid -> setTimeout handle），宽限内重连则恢复身份
const pendingSpyLeave = new Map();

// 你画我猜：当前局的计时器（归零自动结算 / 150 秒出首字拼音提示）
let drawTimer = null, drawHintTimer = null;
function clearDrawTimers() {
  if (drawTimer) { clearTimeout(drawTimer); drawTimer = null; }
  if (drawHintTimer) { clearTimeout(drawHintTimer); drawHintTimer = null; }
}
function startDrawRoundTimer() {
  clearDrawTimers();
  const g = state.game;
  if (!g || !g.drawerId) return;
  g.deadline = now() + DRAW_ROUND_MS;
  g.settled = false; g.hint = null; g.hintGiven = false;
  drawTimer = setTimeout(onDrawTimeout, DRAW_ROUND_MS);
  drawHintTimer = setTimeout(sendDrawHint, DRAW_HINT_AT_MS);
}
function onDrawTimeout() {
  const g = state.game;
  if (!g || !g.drawerId) { clearDrawTimers(); return; }
  g.settled = true;
  g.solved = true;       // 归零自动公布正确答案
  g.deadline = 0;
  clearDrawTimers();
  saveState();
  broadcastDraw();
  const word = g.word || '？';
  const sys = {
    id: (crypto.randomUUID ? crypto.randomUUID() : 'c' + now() + Math.random().toString(36).slice(2)),
    uid: 'system', nick: '🎨 你画我猜', avatar: '🎨',
    text: `⏰ 时间到！本轮答案「${word}」已揭晓，点「下一轮」继续 🎨`,
    ts: now()
  };
  state.chats.push(sys);
  if (state.chats.length > CHAT_KEEP) state.chats = state.chats.slice(-CHAT_KEEP);
  broadcastChat(sys);
}
function sendDrawHint() {
  const g = state.game;
  if (!g || !g.drawerId || g.settled || g.hintGiven) return;
  const word = g.word || '';
  const first = [...String(word)][0];
  if (!first) return;
  const py = DRAW_PINYIN_MAP[first];
  g.hint = py ? { char: first, pinyin: py } : { char: first, pinyin: '' };
  g.hintGiven = true;
  saveState();
  broadcastDraw();
}

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
  // 心跳保活：标记存活，收到 pong 时复位（配合下方定时 ping 清理僵死连接）
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
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
      drawPresent.delete(uid); // 退出"在场"
      // 画师掉线：释放座位（drawerId 置空），等下一位用户主动点「我要当画师」接棒，不再自动轮转
      if (state.game && state.game.drawerId === uid) {
        state.game.drawerId = null;
        clearDrawTimers(); state.game.deadline = 0; state.game.settled = false;
        saveState();
        broadcastDraw();
      }
      // 谁是卧底：断开先宽限保留身份（用于重连恢复），宽限超时或人数不足才真正退出
      const sp = state.spy;
      if (sp && sp.players.includes(uid)) {
        sp.disconnected = sp.disconnected || {};
        sp.disconnected[uid] = true;
        if (pendingSpyLeave.has(uid)) clearTimeout(pendingSpyLeave.get(uid));
        pendingSpyLeave.set(uid, setTimeout(() => {
          pendingSpyLeave.delete(uid);
          const s2 = state.spy;
          if (!s2 || !s2.players.includes(uid)) return;
          s2.players = s2.players.filter(p => p !== uid);
          s2.order = (s2.order || []).filter(p => p !== uid);
          delete s2.words[uid];
          if (s2.disconnected) delete s2.disconnected[uid];
          if (s2.phase === 'speak' && s2.order[s2.speakIdx] === uid) {
            s2.speakIdx++;
            while (s2.speakIdx < s2.order.length && s2.words[s2.order[s2.speakIdx]] && s2.words[s2.order[s2.speakIdx]].out) s2.speakIdx++;
            if (s2.speakIdx >= s2.order.length) { s2.phase = 'vote'; s2.votes = {}; }
          }
          const aliveLeft = s2.players.filter(p => s2.words[p] && !s2.words[p].out).length;
          if (s2.phase !== 'lobby' && s2.phase !== 'over' && aliveLeft < SPY_MIN) {
            s2.phase = 'lobby'; s2.words = {}; s2.order = []; s2.speakIdx = 0;
            s2.speeches = []; s2.votes = {}; s2.round = 0; s2.result = null; s2.hostId = null; clearSpySpeakTimer();
          }
          saveState();
          broadcastSpy();
        }, SPY_RECONNECT_GRACE));
        saveState();
        broadcastSpy();
      }
    }
  });

  // 底层 socket 出错（如连接被重置）必须监听，否则会变成未捕获异常直接拖垮整个进程
  ws.on('error', (e) => { console.error('[ws error]', ws.userId || '?', e && e.message); });

  // 新连接先发一份当前榜单（含服务端时间，用于客户端校正时钟漂移）+ 最近聊天记录
  try {
  ws.send(JSON.stringify({
    type: 'state',
    serverNow: now(),
    users: Object.values(state.users).map(toClientUser),
    chats: state.chats.slice(-CHAT_KEEP)
  }));

  // 若当前已有画猜局，把局状态（含最近笔画）单独发给新连接，方便晚进的人回放
  if (state.game && state.game.drawerId) {
    ws.send(JSON.stringify(drawStateForClient(ws.userId)));
  }
  // 谁是卧底：把当前局状态发给新连接（围观者 me=null，参与者拿到自己的词）
  ws.send(JSON.stringify(spyStateForClient(ws.userId)));
  } catch (e) { console.error('[init send]', e && e.message); }

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (e) { return; }

    const id = msg.id;
    if (!id) return;
    try {

    if (msg.type === 'join') {
      const rawNick = String(msg.nickname || '').trim();
      let safeNick = (rawNick && !FORBIDDEN_NICKS.includes(rawNick))
        ? rawNick
        : ('摸鱼咸鱼' + Math.floor(Math.random() * 900 + 100));
      // 昵称可重复（数据按 id 隔离），但若与某在线用户完全相同，加后缀避免混淆
      const onlineNicks = new Set();
      for (const c of wss.clients) {
        if (c.readyState === 1 && c.userId && state.users[c.userId]) onlineNicks.add(state.users[c.userId].nickname);
      }
      if (onlineNicks.has(safeNick)) {
        let n = 2; while (onlineNicks.has(safeNick + '#' + n)) n++;
        safeNick = safeNick + '#' + n;
      }
      let u = state.users[id];
      if (!u) {
        u = {
          id,
          totalBase: 0, todayBase: 0, weekBase: 0, monthBase: 0, pending: 0,
          running: false, runStart: null,           caught: 0, catchCount: 0, merit: 0,
          stolen: 0, stealCount: 0, lastSteal: 0, drawScore: 0,
          nickname: safeNick,
          avatar: msg.avatar || '🐟',
          lastActive: now()
        };
        state.users[id] = u;
      } else {
        if (rawNick && !FORBIDDEN_NICKS.includes(rawNick)) u.nickname = rawNick;
        if (msg.avatar) u.avatar = msg.avatar;
        u.lastActive = now();
      }
      // 进入网页自动开始计时（双保险：即便前端 start 消息因连接时机丢失也生效）
      if (u && !u.running) { u.running = true; u.runStart = now(); }
      saveState();
      ws.userId = id; // 绑定连接与用户，供 close 时自动暂停
      // 重连恢复：清除卧底断线宽限标记（若刚重连回来）
      if (state.spy && state.spy.disconnected && state.spy.disconnected[id]) {
        delete state.spy.disconnected[id];
        if (pendingSpyLeave.has(id)) { clearTimeout(pendingSpyLeave.get(id)); pendingSpyLeave.delete(id); }
        saveState(); broadcastSpy();
      }
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
      const nowTs = now();
      if (u.lastChat && nowTs - u.lastChat < CHAT_CD) return; // 发言冷却防刷屏
      u.lastChat = nowTs;
      const m = {
        id: crypto.randomUUID ? crypto.randomUUID() : 'c' + now() + Math.random().toString(36).slice(2),
        uid: u.id,
        nick: u.nickname || '匿名咸鱼',
        avatar: u.avatar || '🐟',
        text,
        ts: now()
      };
      state.chats.push(m);
      if (state.chats.length > CHAT_KEEP) state.chats = state.chats.slice(-CHAT_KEEP);
      saveState();
      const payload = JSON.stringify({ type: 'chat', msg: m });
      for (const c of wss.clients) {
        if (c.readyState === 1) c.send(payload);
      }
    } else if (msg.type === 'catch') {
      // 抓摸鱼：举报别人在摸鱼（不能抓自己）
      const u = state.users[id];
      if (!u) return;
      const nowTs = now();
      if (u.lastCatch && nowTs - u.lastCatch < CATCH_CD) return; // 抓鱼冷却防刷
      u.lastCatch = nowTs;
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
      if (state.chats.length > CHAT_KEEP) state.chats = state.chats.slice(-CHAT_KEEP);
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
      if (state.chats.length > CHAT_KEEP) state.chats = state.chats.slice(-CHAT_KEEP);
      broadcastChat(sys); // 系统播报实时进茶水间
      broadcast();
    } else if (msg.type === 'merit') {
      // 电子木鱼：敲一下功德+1
      const u = state.users[id];
      if (!u) return;
      const nowTs = now();
      if (u.lastMerit && nowTs - u.lastMerit < MERIT_CD) return; // 防狂敲
      u.lastMerit = nowTs;
      u.merit = (u.merit || 0) + 1;
      saveState();
      const mp = JSON.stringify({ type: 'merit', id: u.id, merit: u.merit });
      for (const c of wss.clients) if (c.readyState === 1) c.send(mp);
    } else if (msg.type === 'drawEnter') {
      // 用户点进了「你画我猜」页面：登记为"在场"，之后才能认领画师 / 保持画师身份
      if (state.users[id]) drawPresent.add(id);
    } else if (msg.type === 'drawLeave') {
      // 用户关掉了「你画我猜」页面：退出"在场"；若 TA 正是当前画师，则释放座位（无法作画）
      drawPresent.delete(id);
      if (state.game && state.game.drawerId === id) {
        state.game.drawerId = null;
        saveState();
        broadcastDraw();
      }
    } else if (msg.type === 'drawStart') {
      // ★ 画师产生逻辑：画师【只】由用户主动点击「我要当画师」后发来的 drawStart 产生，
      //   服务端不做任何自动轮转 / 自动指派。画师掉线时仅把 drawerId 置空（释放座位），
      //   等下一位用户自己点「我要当画师」接棒，绝不自动选人。
      // 「我要当画师」：用户主动认领画师座位。
      // 必要条件：① 已加入网页房间；② 当前已点进「你画我猜」页面（在 drawPresent 集合）；
      //   ③ 座位空闲（无画师 / 画师已离线 / 本轮已揭晓待接棒）时才允许；
      // 若已有在线画师且本轮未揭晓，则拒绝，必须由画师自己点「下一轮」或等揭晓后他人接棒。
      const u = state.users[id];
      if (!u) return;
      if (!drawPresent.has(id)) return; // 必须点进「你画我猜」页面才能认领画师
      if (!(state.game.players || []).includes(id)) return; // 必须先「参与游戏」才能当画师
      const g = state.game || (state.game = {});
      const drawerOnline = g.drawerId && state.users[g.drawerId] &&
        [...wss.clients].some(c => c.readyState === 1 && c.userId === g.drawerId);
      if (drawerOnline && !g.solved && g.drawerId !== id) return;
      const w = pickWord(msg.bank);
      state.game.word = w.word;
      state.game.cat = w.cat;
      state.game.wordLen = [...String(w.word)].length;
      state.game.drawerId = id;
      state.game.round = (state.game.round || 0) + 1;
      state.game.ops = [];
      state.game.swapsLeft = 2;   // 画师最多换词 2 次
      state.game.solved = false; state.game.solvedBy = null;
      state.game.guessLog = [];   // 新开一局重置猜词记录
      state.game.settled = false; state.game.hint = null; state.game.hintGiven = false;
      startDrawRoundTimer();      // 开局启动 180s 倒计时
      saveState();
      broadcastDraw();
    } else if (msg.type === 'drawSwap') {
      // 画师换词：最多 2 次；猜词记录（聊天框）保留，不清空
      const g = state.game;
      if (!g || !g.drawerId || g.drawerId !== id) return; // 仅画师可换
      if ((g.swapsLeft || 0) <= 0) return;               // 次数已用完
      const w = pickWord(msg.bank);
      g.word = w.word; g.cat = w.cat;
      g.wordLen = [...String(w.word)].length;
      g.swapsLeft = (g.swapsLeft || 0) - 1;
      saveState();
      broadcastDraw();
      const dname = (state.users[id] && state.users[id].nickname) || '匿名咸鱼';
      const sp = JSON.stringify({ type: 'drawSwap', drawerId: id, name: dname, left: g.swapsLeft });
      for (const c of wss.clients) if (c.readyState === 1) c.send(sp);
    } else if (msg.type === 'drawStroke') {
      // 画师作画：仅画师可发，实时转发给其他人，并留存最近笔画供回放；支持 sid 单步撤销
      const g = state.game;
      if (!g || !g.drawerId || g.drawerId !== id) return;
      if (g.settled) return; // 本轮已结束（超时）不可再画
      let maxSid = 0;
      for (const s of (g.ops || [])) if (typeof s.sid === 'number' && s.sid > maxSid) maxSid = s.sid;
      const segs = Array.isArray(msg.segs) ? msg.segs.slice(0, 60).map(s => ({ ...s, sid: s.sid != null ? s.sid : ++maxSid })) : [];
      if (!segs.length) return;
      g.ops = (g.ops || []).concat(segs);
      if (g.ops.length > 600) g.ops = g.ops.slice(-600);
      const payload = JSON.stringify({ type: 'draw', from: id, segs });
      for (const c of wss.clients) {
        if (c.readyState !== 1) continue;
        if (c.userId === id) continue; // 不发回给作画者本人（本人已本地绘制）
        c.send(payload);
      }
    } else if (msg.type === 'drawClear') {
      // 画师清空画布
      const g = state.game;
      if (!g || g.drawerId !== id) return;
      if (g.settled) return;
      g.ops = [];
      const payload = JSON.stringify({ type: 'drawClear' });
      for (const c of wss.clients) {
        if (c.readyState !== 1) continue;
        if (c.userId === id) continue; // 本人已本地清空
        c.send(payload);
      }
    } else if (msg.type === 'drawGuess') {
      // 猜词：非画师才能猜。首个猜中 +10 分、画师 +5 分并揭晓答案；后续猜中不计分
      const g = state.game;
      if (!g || !g.drawerId) return;
      if (id === g.drawerId) return;
      if (!(g.players || []).includes(id)) return; // 围观用户不能猜词
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
          clearDrawTimers(); g.deadline = 0; // 已揭晓：停止本轮倒计时，避免之后误触发"时间到"
          g.guessLog = (g.guessLog || []).concat([{ id, name, text: g.word, ok: true }]).slice(-30);
          saveState();
          const sys = {
            id: crypto.randomUUID ? crypto.randomUUID() : 'c' + now() + Math.random().toString(36).slice(2),
            uid: 'system', nick: '🎨 你画我猜', avatar: '🎨',
            text: `✅ ${name} 猜对了「${g.word}」！+10 分，画师 +5 分 🎉`,
            ts: now()
          };
          state.chats.push(sys);
          if (state.chats.length > CHAT_KEEP) state.chats = state.chats.slice(-CHAT_KEEP);
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
      // 下一轮：画师本人，或特权昵称（羡温言/LL/水果刀/慢慢）可触发。
      // 不自动轮转画师——保持当前画师，仅换词开新一轮（想换画师需当前画师点「下一轮」后，下一位点「我要当画师」接棒）。
      const g = state.game;
      if (!g || !g.drawerId) return;
      const u = state.users[id];
      if (!u) return;
      const isDrawer = g.drawerId === id;
      const isPriv = DRAW_NEXT_ALLOW.includes(u.nickname);
      if (!isDrawer && !isPriv) return; // 既不是画师也不是特权昵称 → 忽略
      const w = pickWord(msg.bank);
      g.word = w.word; g.cat = w.cat;
      g.wordLen = [...String(w.word)].length;
      g.round = (g.round || 0) + 1;
      g.ops = [];
      g.swapsLeft = 2; // 新一轮重置换词次数
      g.solved = false; g.solvedBy = null;
      g.guessLog = []; // 新一轮重置猜词记录
      g.settled = false; g.hint = null; g.hintGiven = false;
      startDrawRoundTimer();      // 新一轮重启 180s 倒计时
      saveState();
      broadcastDraw();
    } else if (msg.type === 'drawJoin') {
      // 点「参与游戏」才正式加入本局（打开面板只是围观，不能画画/猜词）
      const u = state.users[id];
      if (!u) return;
      const g = state.game || (state.game = {});
      if (!Array.isArray(g.players)) g.players = [];
      if (!g.players.includes(id)) g.players.push(id);
      if (!drawPresent.has(id)) drawPresent.add(id); // 参与即视为在场观看
      saveState();
      broadcastDraw();
    } else if (msg.type === 'drawQuit') {
      // 退出本局：回到围观。若是画师则释放座位并清理计时
      const g = state.game;
      if (!g) return;
      if (g.players) g.players = g.players.filter(p => p !== id);
      if (g.drawerId === id) {
        g.drawerId = null;
        clearDrawTimers(); g.deadline = 0; g.settled = false;
      }
      saveState();
      broadcastDraw();
    } else if (msg.type === 'drawUndo') {
      // 撤销：仅画师可操作，移除最近一笔（同 sid 的所有段）
      const g = state.game;
      if (!g || !g.drawerId || g.drawerId !== id) return;
      if (g.settled) return;
      if (!Array.isArray(g.ops) || !g.ops.length) return;
      let maxSid = -1;
      for (const s of g.ops) if (typeof s.sid === 'number' && s.sid > maxSid) maxSid = s.sid;
      let removedSid = maxSid;
      if (removedSid < 0) {
        g.ops = g.ops.slice(0, -1); // 旧数据无 sid：退最后一段
        removedSid = null;
      } else {
        g.ops = g.ops.filter(s => s.sid !== removedSid);
      }
      saveState();
      const payload = JSON.stringify({ type: 'drawUndo', sid: removedSid });
      for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
    } else if (msg.type === 'spyJoin') {
      // 点「参与游戏」才正式加入本局（打开网页 / 进入面板不会自动加入）
      const u = state.users[id];
      if (!u) return;
      const s = state.spy;
      if (s.phase !== 'lobby' && s.phase !== 'over') return; // 游戏进行中不能中途加入
      if (s.players.includes(id)) return;
      if (s.players.length >= SPY_MAX) return;
      s.players.push(id);
      saveState();
      broadcastSpy();
    } else if (msg.type === 'spyLeave') {
      // 退出本局（仅大厅 / 结算阶段允许）
      const s = state.spy;
      if (s.phase !== 'lobby' && s.phase !== 'over') return;
      s.players = s.players.filter(p => p !== id);
      delete s.words[id];
      saveState();
      broadcastSpy();
    } else if (msg.type === 'spySetBank') {
      const s = state.spy;
      if (s.phase !== 'lobby') return;
      if (SPY_BANKS[msg.bank]) { s.bank = msg.bank; saveState(); broadcastSpy(); }
    } else if (msg.type === 'spySetAnon') {
      const s = state.spy;
      if (s.phase !== 'lobby') return;
      s.anonymous = !!msg.anonymous;
      saveState(); broadcastSpy();
    } else if (msg.type === 'spyStart') {
      // 仅特权昵称（羡温言 / LL / 水果刀 / 慢慢）可开始；人数须 3~8
      const u = state.users[id];
      if (!u) return;
      const s = state.spy;
      if (s.phase !== 'lobby') return;
      if (!SPY_HOST_ALLOW.includes(u.nickname)) return;
      if (s.players.length < SPY_MIN || s.players.length > SPY_MAX) return;
      // 词条不重复：记住本词库已用过的组，全部用完才重置重新轮
      s.usedPairs = (s.usedPairs && typeof s.usedPairs === 'object') ? s.usedPairs : {};
      const bankArr = SPY_BANKS[s.bank];
      let used = Array.isArray(s.usedPairs[s.bank]) ? s.usedPairs[s.bank] : [];
      let avail = bankArr.map((_, i) => i).filter(i => !used.includes(i));
      if (!avail.length) {
        // 用完一轮重置，但排除刚用过的那一组，避免「重置瞬间立刻又抽到同一个」
        const lastUsed = used.length ? used[used.length - 1] : -1;
        used = [];
        avail = bankArr.map((_, i) => i).filter(i => i !== lastUsed);
      }
      const pairIdx = avail[Math.floor(Math.random() * avail.length)];
      s.usedPairs[s.bank] = used.concat(pairIdx);
      const pair = bankArr[pairIdx];
      // 身份分配与发言顺序独立洗牌，避免"发言第一位必是卧底"
      const roleOrder = shuffle(s.players);   // 决定谁是卧底
      const order = shuffle(s.players);       // 决定发言顺序（与身份无关）
      const spyCount = s.players.length <= 5 ? 1 : 2; // 3~5 人 1 卧底，6~8 人 2 卧底
      const spySet = new Set(roleOrder.slice(0, spyCount));
      s.words = {};
      s.players.forEach(pid => {
        const role = spySet.has(pid) ? 'spy' : 'civ';
        s.words[pid] = { role, word: role === 'spy' ? pair.spy : pair.civ, code: codeFor(pid), out: false };
      });
      s.order = order;
      s.hostId = id;
      s.speeches = [];
      s.votes = {};
      s.round = 1;
      s.result = null;
      spyGotoSpeak();
      saveState();
      broadcastSpy();
    } else if (msg.type === 'spySpeak') {
      const s = state.spy;
      if (s.phase !== 'speak') return;
      const cur = s.order[s.speakIdx];
      if (cur !== id) return;                 // 必须轮到本人
      if (s.words[id].out) return;
      const text = String(msg.text || '').trim().slice(0, 120);
      if (!text) return;
      s.speeches.push({ id, text });
      s.speakIdx++;
      while (s.speakIdx < s.order.length && s.words[s.order[s.speakIdx]] && s.words[s.order[s.speakIdx]].out) s.speakIdx++;
      if (s.speakIdx >= s.order.length) { s.phase = 'vote'; s.votes = {}; s.speakDeadline = 0; clearSpySpeakTimer(); }
      else { s.phase = 'speak'; s.speakDeadline = now() + SPY_SPEAK_MS; clearSpySpeakTimer(); spySpeakTimer = setTimeout(onSpySpeakTimeout, SPY_SPEAK_MS); }
      saveState();
      broadcastSpy();
    } else if (msg.type === 'spyVote') {
      const s = state.spy;
      if (s.phase !== 'vote') return;
      if (!s.words[id] || s.words[id].out) return;     // 出局者 / 非参与者不能投
      const t = msg.target;
      if (t === undefined || t === null) return;
      if (t === '') { s.votes[id] = ''; }              // 弃票：记为已投，但不指向任何人
      else {
        if (t === id) return;                          // 不能投自己
        if (!s.words[t] || s.words[t].out) return;     // 只能投存活参与者
        s.votes[id] = t;
      }
      const aliveCount = s.players.filter(p => s.words[p] && !s.words[p].out && !(s.disconnected && s.disconnected[p])).length;
      if (Object.keys(s.votes).length >= aliveCount) spyTally();
      saveState();
      broadcastSpy();
    } else if (msg.type === 'spyRestart') {
      // 仅房主（特权昵称）可重新开局；重置回大厅，保留参与者/词库/匿名/房主身份
      const u = state.users[id];
      if (!u) return;
      const s = state.spy;
      if (!SPY_HOST_ALLOW.includes(u.nickname)) return; // 非房主不可重开
      s.phase = 'lobby';
      s.words = {};
      s.order = [];
      s.speakIdx = 0;
      s.speeches = [];
      s.votes = {};
      s.round = 0;
      s.result = null;
      // 保留 hostId：房主身份延续，方便继续主持下一局
      saveState();
      broadcastSpy();
    }
    } catch (e) { console.error('[msg handler]', e && e.stack || e); }
  });
});

// 每秒广播一次，保证排行榜实时滚动、跨天/跨周/跨月清零能及时生效
setInterval(() => { try { broadcast(); } catch (e) { console.error('[broadcast]', e && e.stack || e); } }, 1000);
setInterval(() => { try { flushSave(); } catch (e) { console.error('[flushSave]', e && e.message || e); } }, 5000); // 定时兜底落盘，防止崩溃丢失超过 800ms 的数据
// 心跳保活：每 30s 清理僵死连接（如被网关因空闲断开），避免连接堆积与内存泄漏
const PING_MS = 30000;
setInterval(() => {
  try {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    }
  } catch (e) { console.error('[ping]', e && e.message || e); }
}, PING_MS);

server.listen(PORT, () => {
  console.log(`🐟 摸鱼排行榜已启动： http://localhost:${PORT}`);
  console.log(`   局域网内其他人访问 http://<你的IP>:${PORT} 即可一起摸鱼`);
  flushSave(); // 启动即落盘：确保初始状态持久化，也便于崩溃恢复
});
