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
    render();
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
        ${badge}${liveBadge}
      </div>
      <div class="times">
        <div class="t-total${popCls}">${mainStr}</div>
        <div class="t-today">${subStr}</div>
      </div>
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
