/* =========================================================
 * 摸鱼计时排行榜 - 前端逻辑
 * ========================================================= */

const PRESET_AVATARS = ['🐟','🐸','🦊','🐼','🐶','🐱','👻','🤡','🐧','🦄','🐰','🐯','🦁','🐨','🐵','🐷','🐔','🐙','💩','👽'];

const TIPS = [
  '💡 摸鱼有益身心健康（假的）',
  '⚠️ 小心老板突袭！',
  '🐟 带薪摸鱼，是打工人最后的倔强',
  '☕ 喝口水，伸个懒腰，再摸一会儿',
  '📉 工作量不会自己减少，但快乐会',
  '🤫 别让同事发现你比他摸得久',
  '🎣 愿者上钩，摸者上榜',
  '🛋️ 工位即沙发，摸鱼即修行'
];

const TITLES = [
  { min: 7200, name: '🐉 摸鱼之神' },
  { min: 3600, name: '👑 摸鱼宗师' },
  { min: 1800, name: '🏅 摸鱼大师' },
  { min: 900,  name: '🌊 摸鱼积极分子' },
  { min: 300,  name: '🚶 带薪闲逛' },
  { min: 1,    name: '😪 带薪发呆' },
  { min: 0,    name: '🥚 摸鱼萌新' }
];

const ROASTS = [
  '🥲 劳模叛徒，毫无摸鱼灵魂',
  '🐌 再摸亿点就能出人头地了',
  '📝 别人摸鱼你打工，鉴定为冤种',
  '😇 老板看了都感动'
];

// 小红书每日爆款 Top30（后端实时拉取；拉不到时用这份精选榜兜底）
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
  '打工人的电子木鱼功德+1'
].map((title, i) => ({ rank: i + 1, title, hot: '' }));

// 抓摸鱼成功后的趣味提示（{n}=被抓者昵称）
const CATCH_TOASTS = [
  '🤚 抓到 {n} 在摸鱼！证据已截图（假的）',
  '🚨 {n} 被当场抓获，摸鱼现场一览无余',
  '📸 咔嚓！{n} 的摸鱼英姿已存档',
  '👮 {n}：我只是在思考人生（已被抓）',
  '🕵️ {n} 摸鱼手法过于熟练，建议通报老板'
];

/* ---------- 用户身份（localStorage 持久化） ---------- */
let myId = localStorage.getItem('moyu_id') || null;
let myNick = localStorage.getItem('moyu_nick') || '';
let myAvatar = localStorage.getItem('moyu_avatar') || '🐟';

if (!myId) {
  myId = (crypto.randomUUID ? crypto.randomUUID() : 'u' + Math.random().toString(36).slice(2) + Date.now());
  localStorage.setItem('moyu_id', myId);
}

/* ---------- 本地状态（降级模式用，localStorage 持久化） ---------- */
let localState = loadLocal();
function loadLocal() {
  try { return JSON.parse(localStorage.getItem('moyu_local_state')) || { users: {} }; }
  catch (e) { return { users: {} }; }
}
function saveLocal() {
  try { localStorage.setItem('moyu_local_state', JSON.stringify(localState)); } catch (e) {}
}

/* ---------- 网络模式 ---------- */
let mode = 'online';            // 'online' | 'local'
let wsConnected = false;        // ws 是否已成功建立
let serverState = { users: [] };

/* ---------- 当前查看的榜单维度 ---------- */
let currentView = 'total';     // 'total' | 'today' | 'week' | 'month'

/* ---------- 聊天记录（在线模式由后端下发） ---------- */
let chatHistory = [];          // [{id, uid, nick, avatar, text, ts}]

/* ---------- 小红书热榜（后端下发，离线用兜底） ---------- */
let xhsItems = [];
let xhsLive = false;
let xhsUpdated = 0;

/* ---------- WebSocket ---------- */
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProto}//${location.host}`);
let clockOffset = 0; // serverNow - clientNow，用于校正时钟漂移
let prevRank = {};
let lastTotal = {}; // 记录上次展示的时长，用于触发数字 pop 动画

ws.onopen = () => {
  wsConnected = true;
  clearTimeout(connectTimer);
  if (myNick) { sendJoin(); hideModal(); }
  else showModal();
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'state') {
    clockOffset = msg.serverNow - Date.now();
    serverState = msg;
    if (msg.chats) chatHistory = msg.chats.slice(-50);
    render();
    renderChat();
  } else if (msg.type === 'chat') {
    chatHistory.push(msg.msg);
    if (chatHistory.length > 50) chatHistory = chatHistory.slice(-50);
    renderChat();
  } else if (msg.type === 'catch') {
    catchFx(msg.target);
  } else if (msg.type === 'merit') {
    const u = serverState.users.find((x) => x.id === msg.id);
    if (u) u.merit = msg.merit;
    renderMerit();
  } else if (msg.type === 'xhs') {
    xhsItems = msg.items || [];
    xhsLive = !!msg.live;
    xhsUpdated = msg.updated || 0;
    renderXhs();
  }
};
ws.onerror = () => { if (!wsConnected) enterLocalMode(); };
ws.onclose = () => {
  if (!wsConnected) enterLocalMode();
  else setTimeout(() => location.reload(), 2000); // 在线模式中途断线，尝试重连
};

// 若 3 秒内连不上后端（例如纯静态托管/无后端环境），自动降级为本地模式
const connectTimer = setTimeout(() => { if (!wsConnected) enterLocalMode(); }, 3000);

// 本地模式：无后端时，用 localStorage 维护本机多人榜（同浏览器切换昵称即可多身份）
function enterLocalMode() {
  if (mode === 'local') return;
  mode = 'local';
  serverState = { users: Object.values(localState.users) };
  toast('📱 本地模式：本机多人（同浏览器切换昵称出榜）');
  if (myNick) { handleLocal({ type: 'join', id: myId, nickname: myNick, avatar: myAvatar }); hideModal(); }
  else showModal();
  render();
  renderChat();
  renderXhs();
}
function handleLocal(obj) {
  const id = obj.id || myId;
  const now = Date.now();
  if (obj.type === 'join') {
    const u = localState.users[id] || { id, running: false, runStart: null, pending: 0, totalBase: 0, todayBase: 0, weekBase: 0, monthBase: 0 };
    u.nickname = obj.nickname; u.avatar = obj.avatar;
    localState.users[id] = u;
  } else if (obj.type === 'start') {
    const u = localState.users[id]; if (!u) return;
    u.running = true; u.runStart = now;
  } else if (obj.type === 'pause' || obj.type === 'stop') {
    const u = localState.users[id]; if (!u) return;
    let add = u.pending || 0;
    if (u.running && u.runStart) add += (now - u.runStart) / 1000;
    u.totalBase += add; u.todayBase += add; u.weekBase += add; u.monthBase += add;
    u.pending = 0; u.running = false; u.runStart = null;
  } else if (obj.type === 'reset') {
    localState.users = {};
  }
  saveLocal();
  serverState = { users: Object.values(localState.users) };
  render();
}

function send(obj) {
  if (mode === 'online' && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  } else if (mode === 'local') {
    handleLocal(obj);
  }
}
function sendJoin() {
  send({ type: 'join', id: myId, nickname: myNick, avatar: myAvatar });
}

/* ---------- 时间计算 ---------- */
function adjustedNow() { return Date.now() + clockOffset; }

function sessionLive(u) {
  let e = 0;
  if (u.running && u.runStart) e = (adjustedNow() - u.runStart) / 1000;
  return (u.pending || 0) + e;
}
function totalLive(u) { return (u.totalBase || 0) + sessionLive(u); }
function todayLive(u) { return (u.todayBase || 0) + sessionLive(u); }
function weekLive(u) { return (u.weekBase || 0) + sessionLive(u); }
function monthLive(u) { return (u.monthBase || 0) + sessionLive(u); }

// 按当前查看维度取"实时累计值"
function viewLive(u, view) {
  if (view === 'today') return todayLive(u);
  if (view === 'week') return weekLive(u);
  if (view === 'month') return monthLive(u);
  return totalLive(u);
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}

function titleFor(sec) {
  for (const t of TITLES) if (sec >= t.min) return t.name;
  return TITLES[TITLES.length - 1].name;
}

/* ---------- 渲染头像 ---------- */
function avatarHTML(avatar) {
  if (avatar && avatar.startsWith('data:')) {
    return `<img src="${avatar}" alt="avatar" />`;
  }
  return avatar || '🐟';
}

/* ---------- 渲染主界面 ---------- */
const $ = (id) => document.getElementById(id);

function render() {
  const users = serverState.users.slice().sort((a, b) => viewLive(b, currentView) - viewLive(a, currentView));
  const me = users.find((u) => u.id === myId);

  renderTimer(me);
  renderBoard(users);
  renderMerit();
  const co = $('chatOnline');
  if (co) co.textContent = mode === 'local' ? '· 本地' : '· 在线';
}

function renderTimer(me) {
  const big = $('bigTimer');
  const startBtn = $('btnStart');
  const pauseBtn = $('btnPause');
  const stopBtn = $('btnStop');

  if (!me) {
    big.textContent = '00:00:00';
    $('sessionLabel').textContent = '先加入摸鱼场吧～';
    startBtn.disabled = true; pauseBtn.disabled = true; stopBtn.disabled = true;
    $('meLive').classList.add('hidden');
    return;
  }

  const sess = sessionLive(me);
  big.textContent = fmt(sess);

  if (me.running) {
    $('sessionLabel').textContent = '正在快乐摸鱼中……';
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
    $('meLive').classList.remove('hidden');
  } else {
    $('sessionLabel').textContent = sess > 0 ? '摸鱼暂停，随时继续～' : '还没开始摸鱼哦～';
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    stopBtn.disabled = sess <= 0;
    $('meLive').classList.add('hidden');
  }

  $('meName').textContent = me.nickname || '匿名咸鱼';
  $('meAvatar').innerHTML = avatarHTML(me.avatar);
  $('meTitle').textContent = titleFor(totalLive(me));
  $('myToday').textContent = fmt(todayLive(me));
  $('myTotal').textContent = fmt(totalLive(me));
}

function renderBoard(users) {
  const board = $('leaderboard');
  if (!users.length) {
    board.innerHTML = '<div class="empty-tip">还没有人摸鱼，快来当第一名！</div>';
    return;
  }

  const frag = document.createDocumentFragment();

  users.forEach((u, i) => {
    const rank = i + 1;
    const row = document.createElement('div');
    row.className = 'row';
    if (u.id === myId) row.classList.add('me');

    let rankCell;
    if (rank === 1) {
      row.classList.add('first');
      rankCell = '<span class="medal">🥇</span>';
    } else if (rank === 2) {
      rankCell = '<span class="medal">🥈</span>';
    } else if (rank === 3) {
      rankCell = '<span class="medal">🥉</span>';
    } else {
      rankCell = `<span>${rank}</span>`;
    }

    // 主显示值 = 当前查看维度
    const mainVal = viewLive(u, currentView);
    // 副行：给出参照（非总榜时显示总时长，总榜时显示今日）
    let subStr;
    if (currentView === 'total') subStr = '今日 ' + fmt(todayLive(u));
    else if (currentView === 'today') subStr = '总 ' + fmt(totalLive(u));
    else if (currentView === 'week') subStr = '月 ' + fmt(monthLive(u)) + ' · 总 ' + fmt(totalLive(u));
    else subStr = '总 ' + fmt(totalLive(u));

    // 称号 / 吐槽
    let badge = `<span class="badge">${titleFor(mainVal)}</span>`;
    if (rank === users.length && users.length > 1) {
      const roast = ROASTS[Math.floor(Math.random() * ROASTS.length)];
      badge = `<span class="badge roast">${roast}</span>`;
    }
    const liveBadge = u.running ? '<span class="badge live">🌊 摸鱼中</span>' : '';
    const caughtBadge = u.caught > 0 ? `<span class="badge caught">🚨被抓${u.caught}</span>` : '';

    const mainStr = fmt(mainVal);
    // 数字变化触发 pop 动画
    const popped = lastTotal[u.id] !== undefined && Math.floor(lastTotal[u.id]) !== Math.floor(mainVal);
    const popCls = popped ? ' pop' : '';

    row.innerHTML = `
      ${rank === 1 ? '<span class="crown">👑</span>' : ''}
      <div class="rank">${rankCell}</div>
      <div class="ava">${avatarHTML(u.avatar)}</div>
      <div class="info">
        <div class="nick">${escapeHTML(u.nickname || '匿名咸鱼')}</div>
        ${badge}${liveBadge}${caughtBadge}
      </div>
      <div class="times">
        <div class="t-total${popCls}">${mainStr}</div>
        <div class="t-today">${subStr}</div>
      </div>
      <button class="catch-btn" data-target="${u.id}" ${u.id === myId ? 'disabled' : ''} title="抓ta摸鱼">🤚</button>
    `;

    // 排名变动 -> bump 动画
    if (prevRank[u.id] !== undefined && prevRank[u.id] !== rank) {
      row.classList.add('bump');
    }

    frag.appendChild(row);
    lastTotal[u.id] = mainVal;
    prevRank[u.id] = rank;
  });

  board.innerHTML = '';
  board.appendChild(frag);
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 榜单维度切换：总榜 / 今日 / 本周 / 本月 ---------- */
document.querySelectorAll('.vtab').forEach((tab) => {
  tab.onclick = () => {
    currentView = tab.dataset.view;
    document.querySelectorAll('.vtab').forEach((t) => t.classList.toggle('active', t === tab));
    render();
  };
});

/* ---------- 暗黑模式 ---------- */
let darkMode = localStorage.getItem('moyu_dark') === '1';
function applyDark() {
  document.body.classList.toggle('dark', darkMode);
  const dt = $('darkToggle');
  if (dt) dt.textContent = darkMode ? '☀️' : '🌙';
}
$('darkToggle').onclick = () => {
  darkMode = !darkMode;
  localStorage.setItem('moyu_dark', darkMode ? '1' : '0');
  applyDark();
  toast(darkMode ? '🌙 夜间摸鱼模式已开启' : '☀️ 切回白天啦');
};
applyDark();

/* ---------- 计时按钮 ---------- */
$('btnStart').onclick = () => { send({ type: 'start', id: myId }); };
$('btnPause').onclick = () => { send({ type: 'pause', id: myId }); };
$('btnStop').onclick = () => {
  send({ type: 'stop', id: myId });
  toast('🎣 本局摸鱼已入账，干得漂亮');
};

/* ---------- 重置 ---------- */
$('btnReset').onclick = () => {
  if (confirm('⚠️ 确定要清空所有人的摸鱼记录吗？\n此操作无法撤销，全员回到起点！')) {
    send({ type: 'reset' });
    toast('🧹 记录已清空，大家重新做人');
  }
};

/* ---------- 切换用户（生成全新身份，旧身份记录留在榜上） ---------- */
$('switchUser').onclick = () => {
  myId = (crypto.randomUUID ? crypto.randomUUID() : 'u' + Math.random().toString(36).slice(2) + Date.now());
  localStorage.setItem('moyu_id', myId);
  myNick = '';
  myAvatar = '🐟';
  showModal();
};

/* ---------- 弹窗：加入 / 切换 ---------- */
let selectedAvatar = myAvatar;

function showModal() {
  $('joinModal').classList.remove('hidden');
  $('nickInput').value = myNick || '';
  buildAvatarGrid();
  highlightSelected();
}
function hideModal() { $('joinModal').classList.add('hidden'); }

function buildAvatarGrid() {
  const row = $('avatarRow');
  row.innerHTML = '';
  PRESET_AVATARS.forEach((emoji) => {
    const d = document.createElement('div');
    d.className = 'avatar-opt';
    d.dataset.avatar = emoji;
    d.textContent = emoji;
    d.onclick = () => {
      selectedAvatar = emoji;
      // 清掉上传预览的选中态
      row.querySelectorAll('.avatar-opt').forEach((x) => x.classList.remove('sel'));
      d.classList.add('sel');
    };
    row.appendChild(d);
  });
}
function highlightSelected() {
  const row = $('avatarRow');
  row.querySelectorAll('.avatar-opt').forEach((x) => {
    x.classList.toggle('sel', x.dataset.avatar === selectedAvatar && !selectedAvatar.startsWith('data:'));
  });
}

// 上传头像：客户端压缩到 96px，避免数据过大
$('avatarUpload').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const size = 96;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // 居中裁剪为正方形
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      const data = canvas.toDataURL('image/jpeg', 0.8);
      selectedAvatar = data;
      // 在网格里加一个选中预览
      const row = $('avatarRow');
      row.querySelectorAll('.avatar-opt').forEach((x) => x.classList.remove('sel'));
      let prev = row.querySelector('.avatar-opt.uploaded');
      if (!prev) {
        prev = document.createElement('div');
        prev.className = 'avatar-opt uploaded sel';
        row.appendChild(prev);
      }
      prev.classList.add('sel');
      prev.innerHTML = `<img src="${data}" />`;
      prev.dataset.avatar = data;
      prev.onclick = () => {
        selectedAvatar = data;
        row.querySelectorAll('.avatar-opt').forEach((x) => x.classList.remove('sel'));
        prev.classList.add('sel');
      };
      toast('📷 头像已选好');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
};

$('joinBtn').onclick = () => {
  const nick = $('nickInput').value.trim() || '匿名咸鱼';
  myNick = nick;
  myAvatar = selectedAvatar;
  localStorage.setItem('moyu_nick', myNick);
  localStorage.setItem('moyu_avatar', myAvatar);
  sendJoin();
  hideModal();
  toast(`🐟 欢迎进场，${nick}！`);
};

/* ---------- 轻提示 ---------- */
let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

/* ---------- 趣味提示轮播 ---------- */
let tipIdx = 0;
setInterval(() => {
  tipIdx = (tipIdx + 1) % TIPS.length;
  $('tips').textContent = TIPS[tipIdx];
}, 4000);

/* ---------- 本地平滑滚动 + 本地模式跨期清零 ---------- */
function clientWeekStr() {
  const d = new Date();
  const diff = (d.getDay() + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
  const year = monday.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const weekNum = Math.ceil((((monday - jan1) / 86400000) + 1) / 7);
  return `${year}-W${weekNum}`;
}
function clientMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}
let localWeek = clientWeekStr();
let localMonth = clientMonthStr();
function checkLocalPeriods() {
  const w = clientWeekStr();
  if (localWeek !== w) { localWeek = w; for (const id in localState.users) localState.users[id].weekBase = 0; }
  const m = clientMonthStr();
  if (localMonth !== m) { localMonth = m; for (const id in localState.users) localState.users[id].monthBase = 0; }
}

setInterval(() => { checkLocalPeriods(); render(); }, 250);

/* ---------- 在线聊天室（茶水间） ---------- */
function renderChat() {
  const list = $('chatList');
  if (mode === 'local') {
    list.innerHTML = '<div class="chat-hint">📱 本地模式不支持聊天，部署到带后端服务即可实时聊天</div>';
    return;
  }
  if (!chatHistory.length) {
    list.innerHTML = '<div class="chat-hint">还没有人说话，来当第一个摸鱼嘴替～</div>';
    return;
  }
  list.innerHTML = chatHistory.map((m) => {
    const me = m.uid === myId;
    const time = new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return `<div class="chat-row ${me ? 'me' : ''}">
      <span class="chat-ava">${avatarHTML(m.avatar)}</span>
      <div class="chat-body">
        <div class="chat-meta"><b>${escapeHTML(m.nick)}</b><span>${time}</span></div>
        <div class="chat-text">${escapeHTML(m.text)}</div>
      </div>
    </div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}

function sendChat() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (mode === 'local') { toast('📱 本地模式不支持聊天'); return; }
  if (!myNick) { toast('先加入摸鱼场才能聊天哦'); return; }
  send({ type: 'chat', id: myId, text });
  input.value = '';
}
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

/* ---------- 抓摸鱼（互动举报） ---------- */
$('leaderboard').addEventListener('click', (e) => {
  const b = e.target.closest('.catch-btn');
  if (b && b.dataset.target) sendCatch(b.dataset.target);
});
function sendCatch(targetId) {
  if (mode === 'local') { toast('📱 本地模式暂不支持抓人'); return; }
  if (!myNick) { toast('先加入摸鱼场才能抓人哦'); return; }
  send({ type: 'catch', id: myId, target: targetId });
  const t = serverState.users.find((u) => u.id === targetId);
  const name = t ? (t.nickname || '匿名咸鱼') : '某人';
  const line = CATCH_TOASTS[Math.floor(Math.random() * CATCH_TOASTS.length)].replace('{n}', name);
  catchFx(name);
  toast(line);
}
function catchFx() {
  const el = document.createElement('div');
  el.className = 'catch-fx';
  el.textContent = '🤚';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 950);
}

/* ---------- 电子木鱼 + 功德榜 ---------- */
let audioCtx = null;
function playKnock() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'triangle';
    o.frequency.value = 440;
    o.connect(g); g.connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.frequency.exponentialRampToValueAtTime(230, t + 0.18);
    o.start(t); o.stop(t + 0.2);
  } catch (e) {}
}
function knock() {
  playKnock();
  meritPop();
  if (mode === 'online' && ws.readyState === 1) {
    if (!myNick) { toast('先加入摸鱼场才能积功德'); return; }
    send({ type: 'merit', id: myId });
  } else if (mode === 'local') {
    const u = localState.users[myId] || { id: myId, running: false, runStart: null, pending: 0, totalBase: 0, todayBase: 0, weekBase: 0, monthBase: 0, caught: 0, catchCount: 0, merit: 0 };
    u.merit = (u.merit || 0) + 1;
    localState.users[myId] = u;
    saveLocal();
    renderMerit();
  }
}
function meritPop() {
  const wf = $('woodfish');
  if (wf) { wf.classList.remove('knock'); void wf.offsetWidth; wf.classList.add('knock'); }
  const wrap = document.querySelector('.woodfish-wrap');
  if (wrap) {
    const pop = document.createElement('div');
    pop.className = 'merit-pop';
    pop.textContent = '功德 +1';
    wrap.appendChild(pop);
    setTimeout(() => pop.remove(), 900);
  }
}
let lastMeritSig = '';
function renderMerit() {
  const src = mode === 'local' ? Object.values(localState.users) : serverState.users;
  const users = src.slice().sort((a, b) => (b.merit || 0) - (a.merit || 0));
  const me = users.find((u) => u.id === myId);
  const mine = $('myMerit');
  if (mine) mine.textContent = me ? (me.merit || 0) : 0;
  const board = $('meritBoard');
  if (!board) return;
  const sig = users.map((u) => u.id + ':' + (u.merit || 0)).join(',');
  if (sig === lastMeritSig) return; // 数据没变则不重绘，避免滚动跳动
  lastMeritSig = sig;
  const ranked = users.filter((u) => (u.merit || 0) > 0);
  if (!ranked.length) {
    board.innerHTML = '<div class="empty-tip">还没人敲木鱼，来做第一个积功德的～</div>';
    return;
  }
  board.innerHTML = ranked.map((u, i) => {
    const rank = i + 1;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
    return `<div class="merit-row ${u.id === myId ? 'me' : ''}">
      <span class="m-rank">${medal}</span>
      <span class="m-ava">${avatarHTML(u.avatar)}</span>
      <span class="m-nick">${escapeHTML(u.nickname || '匿名咸鱼')}</span>
      <span class="m-val">🪷 ${u.merit}</span>
    </div>`;
  }).join('');
}
$('woodfish').onclick = knock;

/* ---------- 小红书每日爆款 Top30 ---------- */
function renderXhs() {
  const list = $('xhsList');
  if (!list) return;
  const items = (xhsItems && xhsItems.length) ? xhsItems : XHS_FALLBACK;
  list.innerHTML = items.slice(0, 30).map((it) => `
    <a class="xhs-item" href="https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(it.title)}" target="_blank" rel="noopener">
      <span class="xhs-rank">${it.rank || ''}</span>
      <span class="xhs-title">${escapeHTML(it.title)}</span>
      ${it.hot ? `<span class="xhs-hot">🔥${escapeHTML(it.hot)}</span>` : ''}
    </a>`).join('');
  const tip = $('xhsTip');
  if (tip) {
    const tstr = xhsUpdated ? new Date(xhsUpdated).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    tip.textContent = (xhsLive ? '🔴 实时热榜' : '📋 精选榜（实时源暂不可达）') + (tstr ? ` · 更新于 ${tstr}` : '');
  }
}
renderXhs();
