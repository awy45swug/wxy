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

// 第一名摸鱼夸奖文案（与垫底吐槽一样每 2 秒轮播一次）
const PRAISES = [
  '🏆 摸鱼之王就是你，膜拜！',
  '👑 榜首の从容，老板看了沉默',
  '🌟 带薪摸鱼天花板，慕了',
  '💪 这摸鱼时长，是被天赋眷顾',
  '🐟 鱼生赢家，摸得优雅又持久',
  '🔥 第一名实至名归，继续摸！'
];

// 吐槽 / 夸奖轮播索引：每 2 秒切一次
let rotateIdx = 0;

/* ---------- 偷摸鱼（开心农场风） ---------- */
const STEAL_MIN = 60;    // 对方总时长低于 60 秒不可偷
const STEAL_CD = 5000;   // 冷却 5 秒
let myLastSteal = 0;     // 上次偷的时间戳（用于前端禁用按钮）

/* ---------- 每日摸鱼运势抽签 ---------- */
const FORTUNE_YI = ['划水', '带薪发呆', '摸鱼一小时', '摸鱼划水两不误', '提前溜号', '假装开会', '工位养生', '云吸猫', '带薪emo'];
const FORTUNE_JI = ['加班', '写周报', '开长会', '被拉群', '背锅', '无效社交', '周末加班', '接急活'];
let currentFortune = null;
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 131 + s.charCodeAt(i)) >>> 0;
  return h;
}
function dayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function computeFortune(id) {
  const seed = hashStr((id || '') + dayKey());
  const yi = FORTUNE_YI[seed % FORTUNE_YI.length];
  const ji = FORTUNE_JI[Math.floor(seed / 7) % FORTUNE_JI.length];
  const luck = 60 + (seed % 40); // 60~99
  return { yi, ji, luck };
}
function renderFortune() {
  if (!myId) return;
  const f = computeFortune(myId);
  currentFortune = f;
  const yi = $('fortuneYi'), ji = $('fortuneJi'), luck = $('fortuneLuck');
  if (yi) yi.textContent = f.yi;
  if (ji) ji.textContent = f.ji;
  if (luck) {
    luck.textContent = f.luck;
    luck.className = 'fortune-luck-val ' + (f.luck >= 90 ? 'luck-high' : f.luck >= 75 ? 'luck-mid' : 'luck-low');
  }
}

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

// 进场禁用的匿名昵称
const FORBIDDEN_NICKS = ['匿名闲鱼', '匿名咸鱼'];
// 你画我猜：非画师但拥有「下一轮」按钮权限的特权昵称
const DRAW_NEXT_ALLOW = ['羡温言', 'LL', '水果刀', '慢慢'];

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

/* ---------- WebSocket ---------- */
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
let ws;                 // 当前 WebSocket（断线后可重建，支持平滑重连）
let reconnectDelay = 1000;  // 重连退避时间，连上后重置
function scheduleReconnect() {
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}
function showConnBar() { const b = $('connBar'); if (b) b.classList.remove('hidden'); }
function hideConnBar() { const b = $('connBar'); if (b) b.classList.add('hidden'); }
function connect() {
  ws = new WebSocket(`${wsProto}//${location.host}`);
let clockOffset = 0; // serverNow - clientNow，用于校正时钟漂移
let prevRank = {};
let lastTotal = {}; // 记录上次展示的时长，用于触发数字 pop 动画

  ws.onopen = () => {
    wsConnected = true;
    hideConnBar();            // 重连成功，隐藏断线横幅
    reconnectDelay = 1000;     // 连上即重置退避
    clearTimeout(connectTimer);
    if (myNick) { sendJoin(); hideModal(); }
    else showModal();
    // 断线重连后恢复"你画我猜"在场状态（服务端 close 时已清 drawPresent）
    if (!$('drawGame').classList.contains('hidden')) send({ type: 'drawEnter', id: myId });
  };
ws.onmessage = (e) => {
  let msg;
  try { msg = JSON.parse(e.data); } catch (err) { return; }
  if (!msg || typeof msg !== 'object') return;
  try {
  if (msg.type === 'state') {
    clockOffset = msg.serverNow - Date.now();
    serverState = msg;
    if (msg.chats) chatHistory = msg.chats.slice(-200);
    render();
    renderChat();
  } else if (msg.type === 'chat') {
    chatHistory.push(msg.msg);
    if (chatHistory.length > 200) chatHistory = chatHistory.slice(-200);
    renderChat();
  } else if (msg.type === 'catch') {
    catchFx(msg.target);
  } else if (msg.type === 'merit') {
    const u = serverState.users.find((x) => x.id === msg.id);
    if (u) u.merit = msg.merit;
    renderMerit();
  } else if (msg.type === 'drawState') {
    applyDrawState(msg);
  } else if (msg.type === 'draw') {
    drawRemoteSegs(msg.segs);
  } else if (msg.type === 'drawClear') {
    dgOps = [];
    drawClearCanvas();
  } else if (msg.type === 'drawUndo') {
    dgUndoLocal(msg.sid);
  } else if (msg.type === 'drawGuess') {
    if (msg.id !== myId) toast(`💬 ${msg.name} 猜：“${msg.text}”`);
    dgPushGuess(msg.id, msg.name, msg.text, false);
  } else if (msg.type === 'drawSolved') {
    onDrawSolved(msg);
  } else if (msg.type === 'drawSwap') {
    onDrawSwap(msg);
  } else if (msg.type === 'spyState') {
    applySpyState(msg);
  }
  } catch (err) { console.error('[onmessage]', err && err.message || err); }
};
ws.onerror = () => { if (!wsConnected) enterLocalMode(); };
  ws.onclose = () => {
    if (!wsConnected) { enterLocalMode(); return; }
    wsConnected = false;            // 在线中途断线：不整页刷新，指数退避重连
    showConnBar();               // 顶部显示「重连中」横幅，让用户有感知
    scheduleReconnect();
  };
}
connect();

// 若 3 秒内连不上后端（例如纯静态托管/无后端环境），自动降级为本地模式
const connectTimer = setTimeout(() => { if (!wsConnected) enterLocalMode(); }, 3000);

// 本地模式：无后端时，用 localStorage 维护本机多人榜（同浏览器切换昵称即可多身份）
function enterLocalMode() {
  if (mode === 'local') return;
  mode = 'local';
  // 注意：先建 u 再覆盖 serverState，避免 render 时拿到旧（空）serverState
  if (myNick) {
    handleLocal({ type: 'join', id: myId, nickname: myNick, avatar: myAvatar });
    handleLocal({ type: 'start', id: myId }); // 本地模式也自动开始计时
    renderFortune(); // 进屋抽今日运势
    hideModal();
  }
  else showModal();
  toast('📱 本地模式：本机多人（同浏览器切换昵称出榜）');
  render();
  renderChat();
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
  } else if (obj.type === 'steal') {
    const t = localState.users[obj.target]; const u = localState.users[id];
    if (!t || !u || id === obj.target) return;
    if ((t.totalBase || 0) < STEAL_MIN) return;
    let amt = Math.max(STEAL_MIN, Math.round((t.totalBase || 0) * 0.05));
    amt = Math.min(amt, t.totalBase);
    const tamt = Math.min(amt, t.todayBase || 0);
    t.totalBase -= amt; u.totalBase += amt;
    t.todayBase -= tamt; u.todayBase += tamt;
    t.weekBase = (t.weekBase || 0) - tamt; u.weekBase = (u.weekBase || 0) + tamt;
    t.monthBase = (t.monthBase || 0) - tamt; u.monthBase = (u.monthBase || 0) + tamt;
    t.stolen = (t.stolen || 0) + 1; u.stealCount = (u.stealCount || 0) + 1;
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
  send({ type: 'start', id: myId }); // 进入网页自动开始计时
  renderFortune(); // 进屋抽今日运势
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

    // 称号 / 夸奖 / 吐槽（第一名夸奖 + 垫底吐槽，每 2 秒轮播一次）
    let badge = `<span class="badge">${titleFor(mainVal)}</span>`;
    if (rank === 1) {
      const praise = PRAISES[rotateIdx % PRAISES.length];
      badge += `<span class="badge praise">${praise}</span>`;
    } else if (rank === users.length && users.length > 1) {
      const roast = ROASTS[rotateIdx % ROASTS.length];
      badge = `<span class="badge roast">${roast}</span>`;
    }
    const liveBadge = u.running ? '<span class="badge live">🌊 摸鱼中</span>' : '';
    const caughtBadge = u.caught > 0 ? `<span class="badge caught">🚨被抓${u.caught}</span>` : '';
    const stolenBadge = u.stolen > 0 ? `<span class="badge stolen">🚨被偷${u.stolen}</span>` : '';
    // 抓摸鱼：只有对方正在摸鱼中才能抓，否则按钮暗掉不可点
    const canCatch = u.running && u.id !== myId;
    // 偷摸鱼：对方攒够时长且自己不在冷却，才能偷
    const stealCdLeft = myLastSteal ? Math.max(0, STEAL_CD - (Date.now() - myLastSteal)) : 0;
    const canSteal = u.id !== myId && (u.totalBase || 0) >= STEAL_MIN && stealCdLeft <= 0;

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
        ${badge}${liveBadge}${caughtBadge}${stolenBadge}
      </div>
        <div class="times">
          <div class="t-total${popCls}">${mainStr}</div>
          <div class="t-today">${subStr}</div>
        </div>
      <div class="acts">
        <button class="steal-btn" data-target="${u.id}" ${canSteal ? '' : 'disabled'} title="${u.id === myId ? '不能偷自己' : ((u.totalBase || 0) >= STEAL_MIN ? (stealCdLeft > 0 ? '手速太快，歇会儿再偷' : '偷ta一点摸鱼时长') : 'ta还没攒够，偷不动')}">🥷</button>
        <button class="catch-btn" data-target="${u.id}" ${canCatch ? '' : 'disabled'} title="${u.id === myId ? '不能抓自己' : (u.running ? '抓ta摸鱼！' : 'ta没在摸鱼，抓不了')}">🤚</button>
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

/* ---------- 退出网页自动暂停计时 ---------- */
function autoPause() {
  if (mode === 'online' && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'pause', id: myId }));
  } else if (mode === 'local') {
    handleLocal({ type: 'pause', id: myId });
  }
}
window.addEventListener('beforeunload', autoPause);
window.addEventListener('pagehide', autoPause);

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
  const nick = $('nickInput').value.trim();
  if (!nick) { toast('🐟 取个名字才能进场哦（不能匿名）'); $('nickInput').focus(); return; }
  if (FORBIDDEN_NICKS.includes(nick)) { toast('🐟 这个昵称不能用作匿名，换一个吧～'); $('nickInput').focus(); return; }
  myNick = nick;
  myAvatar = selectedAvatar;
  localStorage.setItem('moyu_nick', myNick);
  localStorage.setItem('moyu_avatar', myAvatar);
  sendJoin();
  hideModal();
  toast(`🐟 欢迎进场，${nick}！`);
};

/* ---------- 晒运势 ---------- */
$('shareFortune').onclick = () => {
  if (!currentFortune) renderFortune();
  if (!myNick) { toast('先加入摸鱼场才能晒运势'); return; }
  const f = currentFortune;
  const text = `🔮 ${myNick} 的今日摸鱼运势｜宜${f.yi} · 忌${f.ji} · 幸运值 ${f.luck}`;
  if (mode === 'online' && ws.readyState === 1) {
    send({ type: 'chat', id: myId, text });
  } else if (mode === 'local') {
    toast('📱 本地模式不支持晒到茶水间');
  }
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  toast('🔮 运势已晒，也帮你复制到剪贴板啦～');
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

/* ---------- 第一名夸奖 / 垫底吐槽 每 2 秒轮播 ---------- */
setInterval(() => {
  rotateIdx = (rotateIdx + 1) % Math.max(ROASTS.length, PRAISES.length);
  render();
}, 2000);

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
  const cb = e.target.closest('.catch-btn');
  if (cb && cb.dataset.target) sendCatch(cb.dataset.target);
  const sb = e.target.closest('.steal-btn');
  if (sb && sb.dataset.target) sendSteal(sb.dataset.target);
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

/* ---------- 偷摸鱼（开心农场风） ---------- */
function sendSteal(targetId) {
  if (mode === 'local') { toast('📱 本地模式暂不支持偷摸鱼'); return; }
  if (!myNick) { toast('先加入摸鱼场才能偷'); return; }
  if (myLastSteal && Date.now() - myLastSteal < STEAL_CD) { toast('🥷 手速太快，歇会儿再偷'); return; }
  send({ type: 'steal', id: myId, target: targetId });
  myLastSteal = Date.now();
  render();
  const t = serverState.users.find((u) => u.id === targetId);
  const name = t ? (t.nickname || '匿名咸鱼') : '某人';
  stealFx();
  toast(`🥷 偷偷摸了 ${name} 一把！`);
}
function stealFx() {
  const el = document.createElement('div');
  el.className = 'catch-fx';
  el.textContent = '🥷';
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

/* ---------- 电子木鱼功德 ---------- */
renderFortune(); // 启动即抽今日运势（待加入也会随 join 刷新）

/* =========================================================
 * 你画我猜（并入摸鱼网页，复用同一 WebSocket 房间，真·多人实时）
 * 画师看词作画，其他人猜词；笔画实时同步、晚进者可回放最近笔画
 * ========================================================= */
let dgState = { word: null, cat: null, drawerId: null, round: 0, ops: [], wordLen: 0, swapsLeft: 0, guessLog: [], solved: false, solvedBy: null, settled: false, hint: null };
let dgDrawing = false, dgLast = null, dgColor = '#1C1C1E', dgBrush = 6, dgErase = false;
let dgReady = false; // 画布是否已初始化
let dgOps = [];       // 本地笔迹栈（每笔含 sid，用于单步撤销 / 重绘）
let dgStrokeId = 0;  // 当前笔画 id（每次落笔 +1）
let dgJoined = false;// 是否已「参与游戏」（否则为围观，不能画/猜）
let dgDeadline = 0;  // 本轮结束时间戳（ms），0 表示未计时
let dgTimerInterval = null; // 倒计时刷新定时器
const dgCanvas = () => $('dgBoard');

// 高 DPI 画布初始化
function dgSetupCanvas() {
  const cv = dgCanvas();
  if (!cv) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  cv._ctx = ctx; cv._w = r.width; cv._h = r.height;
  dgReady = true;
}

// 把屏幕坐标转成 0~1 归一化坐标（跨设备分辨率一致）
function dgNorm(e) {
  const cv = dgCanvas(); const r = cv.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  return { nx: (t.clientX - r.left) / r.width, ny: (t.clientY - r.top) / r.height };
}
// 在本地画一条归一化线段
function dgDrawSeg(seg) {
  const cv = dgCanvas(); if (!cv || !cv._ctx) return;
  const ctx = cv._ctx;
  ctx.strokeStyle = seg.c || '#1C1C1E';
  // 线宽按画布宽度等比缩放（以 400px 宽为基准），保证不同设备上粗细比例一致
  ctx.lineWidth = (seg.w || 6) * (cv._w / 400);
  ctx.beginPath();
  ctx.moveTo(seg.x1 * cv._w, seg.y1 * cv._h);
  ctx.lineTo(seg.x2 * cv._w, seg.y2 * cv._h);
  ctx.stroke();
}
function drawRemoteSegs(segs) {
  if (!dgReady) return;
  (segs || []).forEach(s => { dgOps.push(s); dgDrawSeg(s); });
}
function drawClearCanvas() {
  const cv = dgCanvas(); if (!cv || !cv._ctx) return;
  cv._ctx.clearRect(0, 0, cv.width, cv.height);
}

// 画师作画
function dgStart(e) {
  if (!dgAmDrawer() || dgState.settled) return; // 本轮结束（超时）不可再画
  dgDrawing = true; dgLast = dgNorm(e); dgStrokeId++; e.preventDefault();
}
function dgMove(e) {
  if (!dgDrawing || !dgAmDrawer() || dgState.settled) return;
  const p = dgNorm(e);
  const seg = { x1: dgLast.nx, y1: dgLast.ny, x2: p.nx, y2: p.ny,
    c: dgErase ? '#FCFCFD' : dgColor, w: dgErase ? dgBrush * 2.2 : dgBrush, sid: dgStrokeId };
  dgDrawSeg(seg);
  dgOps.push(seg); // 本地留存，供撤销 / 重绘
  // 实时发给其他人（归一化坐标）；服务端会排除本人回显，避免重绘
  send({ type: 'drawStroke', id: myId, segs: [seg] });
  dgLast = p; e.preventDefault();
}
function dgEnd() { dgDrawing = false; }

// 单步撤销：移除最近一笔（同 sid 的所有段）并重绘
function dgUndoLocal(sid) {
  if (sid == null) dgOps = dgOps.slice(0, -1);
  else dgOps = dgOps.filter(s => s.sid !== sid);
  drawClearCanvas(); dgOps.forEach(dgDrawSeg);
}

function dgAmDrawer() { return dgState.drawerId && dgState.drawerId === myId; }
function dgActive() { return !!dgState.drawerId; }

// 应用后端下发的局状态
function applyDrawState(s) {
  dgState = {
    word: s.word, cat: s.cat, drawerId: s.drawerId, round: s.round || 0, ops: s.ops || [],
    wordLen: s.wordLen || 0, swapsLeft: s.swapsLeft || 0, guessLog: s.guessLog || [],
    solved: !!s.solved, solvedBy: s.solvedBy || null,
    settled: !!s.settled, hint: s.hint || null
  };
  dgJoined = Array.isArray(s.players) && s.players.some(p => p.id === myId);
  dgDeadline = s.deadline || 0;
  dgRender();
  // 回放最近笔画（清空后重画）
  drawClearCanvas();
  dgOps = (s.ops || []).slice();
  dgOps.forEach(dgDrawSeg);
  dgRenderGuessLog();
  startDgCountdown();
}
function dgRender() {
  const round = $('dgRound'); if (round) round.textContent = dgState.round || 1;
  const cat = $('dgCat'); if (cat) cat.textContent = dgState.cat || '职场';
  const drawerUser = serverState.users.find(u => u.id === dgState.drawerId);
  const roleEl = $('dgRole');
  if (roleEl) {
    if (!dgActive()) roleEl.textContent = '⏳ 等待开始';
    else if (dgAmDrawer()) roleEl.textContent = '🎨 你是画师';
    else roleEl.textContent = '🖌️ 画师：' + (drawerUser ? (drawerUser.nickname || '匿名咸鱼') : '—');
    roleEl.classList.toggle('me', dgAmDrawer());
  }
  const wm = document.querySelector('.dg-wordmask');
  if (wm) wm.classList.toggle('drawer', dgAmDrawer());
  const wordEl = $('dgWord');
  const wordLenEl = $('dgWordLen');
  const startBtn = $('dgStartBtn'), nextBtn = $('dgNextBtn'), swapBtn = $('dgSwap');
  const tools = $('dgTools'), guessInput = $('dgGuessInput'), guessSend = $('dgGuessSend');
  const hint = $('dgHint');

  // 字数提示：画师/猜词人都显示"共 N 个字"
  const lenTxt = dgState.wordLen ? `（共 ${dgState.wordLen} 个字）` : '';

  if (!dgActive()) {
    if (wordEl) { wordEl.textContent = '点下方按钮开局'; wordEl.classList.remove('hide'); }
    if (wordLenEl) wordLenEl.textContent = '';
    if (startBtn) {
      startBtn.classList.remove('hidden');
      if (!dgJoined) { startBtn.classList.add('disabled'); startBtn.textContent = '👀 围观中（先参与游戏）'; }
      else { startBtn.classList.remove('disabled'); startBtn.textContent = '🙋 我要当画师'; }
    }
    if (nextBtn) nextBtn.classList.add('hidden');
    if (swapBtn) swapBtn.classList.add('hidden');
    if (tools) tools.classList.add('dim');
    if (guessInput) { guessInput.disabled = true; guessInput.placeholder = dgJoined ? '还没开局呢～' : '围观中，参与游戏后才能猜词'; }
    if (guessSend) guessSend.disabled = true;
    if (hint) hint.textContent = dgJoined ? '点「我要当画师」开局，你来画大家猜 🎨' : '当前是围观模式，点「参与游戏」加入本局 👀';
  } else if (dgAmDrawer()) {
    if (wordEl) { wordEl.textContent = dgState.word || '—'; wordEl.classList.remove('hide'); }
    if (wordLenEl) wordLenEl.textContent = lenTxt;
    if (startBtn) startBtn.classList.add('hidden');
    if (nextBtn) { nextBtn.classList.remove('hidden'); nextBtn.classList.remove('disabled'); nextBtn.textContent = '下一轮'; }
    if (swapBtn) {
      swapBtn.classList.remove('hidden');
      if ((dgState.swapsLeft || 0) > 0) {
        swapBtn.classList.remove('disabled');
        swapBtn.textContent = `🔄 换词（剩 ${dgState.swapsLeft}）`;
      } else {
        swapBtn.classList.add('disabled');
        swapBtn.textContent = '🔄 换词已用完';
      }
    }
    if (tools) tools.classList.remove('dim');
    if (guessInput) { guessInput.disabled = true; guessInput.placeholder = '你是画师，不能猜自己的词 🤫'; }
    if (guessSend) guessSend.disabled = true;
    if (hint) hint.textContent = dgState.solved
      ? `本轮答案：「${dgState.word}」已被猜出，点「下一轮」继续 🎨`
      : '你正在画，安静作画，等其他人猜～（看不清可换词，最多 2 次）';
  } else {
    // 非画师：未揭晓用掩码框显示字数（绝不泄露真实词）；已揭晓则显示答案
    if (dgState.solved) {
      if (wordEl) { wordEl.textContent = dgState.word || '—'; wordEl.classList.remove('hide'); }
    } else {
      if (wordEl) { wordEl.textContent = dgState.wordLen ? Array(dgState.wordLen).fill('＿').join(' ') : '？ ？ ？'; wordEl.classList.add('hide'); }
    }
    if (wordLenEl) wordLenEl.textContent = lenTxt;
    // 非画师分支：按「座位状态」决定"我要当画师"是否可点
    const drawerName = (serverState.users.find(u => u.id === dgState.drawerId) || {}).nickname || '画师';
    if (startBtn) {
      startBtn.classList.remove('hidden');
      if (!dgJoined) {
        // 围观用户：不能接棒当画师
        startBtn.classList.add('disabled');
        startBtn.textContent = '👀 围观中（先参与游戏）';
      } else if (dgState.solved) {
        // 本轮已揭晓，座位开放 → 可接棒当画师
        startBtn.classList.remove('disabled');
        startBtn.textContent = '🙋 我要当画师（接棒）';
      } else {
        // 有画师在作画 → 不能抢，显示画师名并禁用
        startBtn.classList.add('disabled');
        startBtn.textContent = `🙋 画师：${drawerName}（等ta画完）`;
      }
    }
    if (nextBtn) {
      nextBtn.classList.remove('hidden');
      // 画师本人，或特权昵称（羡温言/LL/水果刀/慢慢）可点「下一轮」
      const canAdvance = DRAW_NEXT_ALLOW.includes(myNick);
      if (canAdvance) {
        nextBtn.classList.remove('disabled');
        nextBtn.textContent = '下一轮（你有权限）';
      } else {
        nextBtn.classList.add('disabled');
        nextBtn.textContent = '下一轮（等画师）';
      }
    }
    if (swapBtn) swapBtn.classList.add('hidden');
    if (tools) tools.classList.add('dim');
    if (guessInput) {
      if (!dgJoined) {
        guessInput.disabled = true;
        guessInput.placeholder = '围观中，参与游戏后才能猜词 👀';
      } else {
        guessInput.disabled = !!dgState.settled && !dgState.solved;
        guessInput.placeholder = dgState.settled
          ? `⏰ 时间到！答案：${dgState.word}，等下一轮`
          : (dgState.solved
            ? `答案已揭晓：${dgState.word}（继续猜不计分）`
            : `看画猜词（${dgState.wordLen || '?'}个字），输入后点猜…`);
      }
    }
    if (guessSend) guessSend.disabled = !dgJoined;
    if (hint) hint.textContent = dgState.settled
      ? `⏰ 时间到！本轮答案：「${dgState.word}」，点「下一轮」继续 🎨`
      : (dgState.solved
        ? `本轮答案：「${dgState.word}」，等画师点「下一轮」继续 🎨`
        : `画师正在作画，猜对了积分 +10 🔍（共 ${dgState.wordLen || '?'} 个字）`);
  }
  dgRenderJoinBtn();
  dgRenderTimer();
  dgRenderScore();
}

// 「参与游戏 / 退出围观」按钮 + 围观横幅 + 撤销按钮显隐
function dgRenderJoinBtn() {
  const btn = $('dgJoinBtn');
  if (btn) {
    if (dgJoined) { btn.textContent = '🚪 退出游戏（转围观）'; btn.classList.add('joined'); }
    else { btn.textContent = '🙌 参与游戏'; btn.classList.remove('joined'); }
  }
  const banner = $('dgSpecBanner');
  if (banner) banner.classList.toggle('hidden', dgJoined);
  const undoBtn = $('dgUndo');
  if (undoBtn) undoBtn.classList.toggle('hidden', !dgAmDrawer());
}

// 顶部倒计时 + 150 秒首字拼音提示
function dgRenderTimer() {
  const el = $('dgTimer');
  if (el) {
    if (!dgActive() || !dgDeadline || dgState.settled || dgState.solved) {
      if (dgActive() && (dgState.settled || dgState.solved)) {
        el.classList.remove('hidden', 'warn');
        el.textContent = '⏰ 本轮结束';
      } else {
        el.classList.add('hidden');
      }
    } else {
      const left = Math.max(0, Math.ceil((dgDeadline - Date.now()) / 1000));
      const m = Math.floor(left / 60), s = left % 60;
      el.classList.remove('hidden');
      el.textContent = `⏱ ${m}:${String(s).padStart(2, '0')}`;
      el.classList.toggle('warn', left <= 30);
    }
  }
  // 拼音提示（150 秒时后端下发；画师和已揭晓不显示）
  const py = $('dgPinyin');
  if (py) {
    if (dgState.hint && !dgState.solved && !dgState.settled && !dgAmDrawer()) {
      py.classList.remove('hidden');
      py.textContent = dgState.hint.pinyin
        ? `💡 提示：第一个字拼音「${dgState.hint.pinyin}」`
        : `💡 提示：第一个字是「${dgState.hint.char}」`;
    } else {
      py.classList.add('hidden');
    }
  }
}
function startDgCountdown() {
  if (dgTimerInterval) { clearInterval(dgTimerInterval); dgTimerInterval = null; }
  dgRenderTimer();
  if (dgActive() && dgDeadline > 0 && !dgState.settled && !dgState.solved) {
    dgTimerInterval = setInterval(dgRenderTimer, 500);
  }
}
function dgRenderScore() {
  const list = $('dgScoreList'); if (!list) return;
  const users = (serverState.users || []).slice().sort((a, b) => (b.drawScore || 0) - (a.drawScore || 0));
  const ranked = users.filter(u => (u.drawScore || 0) > 0);
  if (!ranked.length) { list.innerHTML = '<span class="it" style="color:#8E8E93">还没人得分</span>'; return; }
  list.innerHTML = ranked.map(u => {
    const av = avatarHTML(u.avatar);
    return `<span class="it ${u.id === myId ? 'me' : ''}"><span>${av}</span><span>${escapeHTML(u.nickname || '匿名咸鱼')}</span><b>${u.drawScore}</b></span>`;
  }).join('');
}
function onDrawSolved(msg) {
  dgState.solved = true;
  dgState.solvedBy = msg.solvedBy;
  if (msg.word) dgState.word = msg.word; // 揭晓答案给所有人
  const me = msg.solvedBy === myId;
  dgPushGuess(msg.solvedBy, msg.solvedName, msg.word, true); // 在猜词记录里标记"猜对答案的人和答案"
  if (me) {
    toast('✅ 你猜对了！+10 分 🎉');
    dgPop('✅', '猜对了 +10');
  } else {
    const drawerGets = (dgState.drawerId && dgState.drawerId !== msg.solvedBy);
    toast(`🎨 ${msg.solvedName} 猜对了「${msg.word}」+10${drawerGets ? '，画师 +5' : ''}`);
  }
  dgRender();
  startDgCountdown(); // 已揭晓：停掉倒计时刷新
}
function dgPop(big, tx) {
  let p = $('dgPopEl');
  if (!p) {
    p = document.createElement('div'); p.id = 'dgPopEl'; p.className = 'dg-pop';
    p.innerHTML = '<div class="big"></div><div class="tx"></div>';
    document.body.appendChild(p);
  }
  p.querySelector('.big').textContent = big;
  p.querySelector('.tx').textContent = tx;
  p.classList.add('show');
  setTimeout(() => p.classList.remove('show'), 1100);
}

// 猜词记录（聊天框）：实时把每个人猜的词写进底部列表，全员可见
function dgPushGuess(id, name, text, ok) {
  dgState.guessLog = (dgState.guessLog || []).concat([{ id, name, text, ok }]).slice(-30);
  dgRenderGuessLog();
}
function dgRenderGuessLog() {
  const box = $('dgGuessLog'); if (!box) return;
  const log = dgState.guessLog || [];
  if (!log.length) {
    box.innerHTML = '<div class="dg-gl-empty">还没有人猜，快来当第一个猜词王～</div>';
    return;
  }
  box.innerHTML = log.map((g) => {
    const me = g.id === myId;
    let mark = '❌ 猜错';
    if (g.ok) mark = '✅ 猜对';
    else if (g.dup) mark = '🔁 已揭晓';
    return `<div class="dg-gl-row ${g.ok ? 'ok' : ''} ${g.dup ? 'dup' : ''} ${me ? 'me' : ''}">
      <span class="dg-gl-ava">${avatarHTML(g.name)}</span>
      <span class="dg-gl-name">${escapeHTML(g.name)}</span>
      <span class="dg-gl-mark">${mark}</span>
      <span class="dg-gl-text">${escapeHTML(g.text)}</span>
    </div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
function onDrawSwap(msg) {
  if (msg.drawerId === myId) toast(`🔄 你换了一个新词（还能换 ${msg.left} 次）`);
  else toast(`🎨 ${msg.name} 换了一个新词，快看画！`);
  dgRenderGuessLog();
}

// 打开 / 关闭游戏层
function openDrawGame() {
  // 需求①：只有联网房间、且已加入网页摸鱼场的用户才能玩你画我猜
  if (mode !== 'online' || !wsConnected) {
    toast('🎨 你画我猜需要联网房间，当前未连接后端～');
    return;
  }
  if (!myNick) { toast('先加入摸鱼场才能玩你画我猜哦'); showModal(); return; }
  $('drawGame').classList.remove('hidden');
  pushLayerState();
  // 进入「你画我猜」页面：登记在场，之后才能认领画师 / 保持画师身份
  if (ws && ws.readyState === 1) send({ type: 'drawEnter', id: myId });
  // 画布需在可见后才能取到尺寸
  setTimeout(() => { dgSetupCanvas(); drawClearCanvas(); (dgState.ops || []).forEach(dgDrawSeg); dgRender(); dgRenderGuessLog(); }, 30);
}
function closeDrawGame(fromPop) {
  // 按钮关闭时若有历史层，先回退历史，由 popstate 真正执行关闭（保持返回键行为一致）
  if (!fromPop && layerPushed) { history.back(); return; }
  $('drawGame').classList.add('hidden');
  if (dgTimerInterval) { clearInterval(dgTimerInterval); dgTimerInterval = null; } // 停掉画猜倒计时空转
  // 离开「你画我猜」页面：退出在场（若自己是画师则释放座位，由服务端处理）
  if (ws && ws.readyState === 1) send({ type: 'drawLeave', id: myId });
}

$('openDraw').onclick = openDrawGame;
$('drawClose').onclick = () => closeDrawGame();
$('dgJoinBtn').onclick = () => {
  if (dgJoined) {
    send({ type: 'drawQuit', id: myId });
    toast('已退出本局，转为围观 👀');
  } else {
    send({ type: 'drawJoin', id: myId });
    toast('🙌 已参与游戏，可以画画 / 猜词啦');
  }
};
$('dgUndo').onclick = () => {
  if (!dgAmDrawer()) { toast('只有画师能撤销 🤫'); return; }
  if (dgState.settled) { toast('本轮已结束，不能再画了'); return; }
  send({ type: 'drawUndo', id: myId });
};
$('dgStartBtn').onclick = () => {
  // 「我要当画师」：先参与游戏，再发后端判定座位是否开放
  if (!dgJoined) { toast('先点「参与游戏」加入本局，才能当画师 👀'); return; }
  if (dgActive() && !dgAmDrawer() && !dgState.solved) {
    const drawerName = (serverState.users.find(u => u.id === dgState.drawerId) || {}).nickname || '画师';
    toast(`画师是 ${drawerName}，等 TA 画完这轮，或揭晓后你再接棒 🤫`);
    return;
  }
  send({ type: 'drawStart', id: myId, bank: dgBank });
};
$('dgNextBtn').onclick = () => {
  // 画师本人，或特权昵称（羡温言/LL/水果刀/慢慢）可点「下一轮」
  const canAdvance = dgAmDrawer() || DRAW_NEXT_ALLOW.includes(myNick);
  if (!canAdvance) { toast('只有画师或指定管理员能点「下一轮」🤫'); return; }
  send({ type: 'drawNext', id: myId, bank: dgBank });
};
$('dgSwap').onclick = () => {
  if (!dgAmDrawer()) { toast('只有画师能换词 🤫'); return; }
  if ((dgState.swapsLeft || 0) <= 0) { toast('换词次数已用完啦'); return; }
  send({ type: 'drawSwap', id: myId, bank: dgBank });
};

// 词库分类选择（你画我猜）
let dgBank = '';
document.querySelectorAll('.dg-bank').forEach(b => {
  b.onclick = () => {
    dgBank = b.dataset.bank || '';
    document.querySelectorAll('.dg-bank').forEach(x => x.classList.toggle('active', x === b));
    const label = { '': '随机', career: '职场', meme: '热梗', life: '生活' }[dgBank] || '随机';
    toast(`📚 词库已切换：${label}（下一轮出词生效）`);
  };
});

// 画作导出 PNG
const dgExportBtn = document.getElementById('dgExport');
if (dgExportBtn) dgExportBtn.onclick = () => {
  const cv = dgCanvas();
  if (!cv) return;
  // 白底导出，避免透明背景
  const out = document.createElement('canvas');
  out.width = cv.width; out.height = cv.height;
  const octx = out.getContext('2d');
  octx.fillStyle = '#FFFFFF';
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(cv, 0, 0);
  const a = document.createElement('a');
  const word = (dgState && dgState.solved && dgState.word) ? dgState.word : '摸鱼画作';
  a.download = `你画我猜_${word}_第${dgState.round || 1}轮.png`;
  a.href = out.toDataURL('image/png');
  a.click();
  toast('🖼️ 画作已保存～');
};

// ===================== 谁是卧底 =====================
let spyState = { phase: 'lobby', players: [], bank: 'career', anonymous: false, min: 3, max: 8 };
let spyPrevPhase = 'lobby';
function spyEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function getSpyScore() { return parseInt(localStorage.getItem('moyu_spy_score_' + myNick) || '0', 10) || 0; }
function addSpyScore(n) { const s = getSpyScore() + n; localStorage.setItem('moyu_spy_score_' + myNick, String(s)); return s; }

function openSpy() {
  if (mode !== 'online' || !wsConnected) { toast('🕵️ 谁是卧底需要联网房间，当前未连接后端～'); return; }
  if (!myNick) { toast('先加入摸鱼场才能玩谁是卧底哦'); showModal(); return; }
  $('spyGame').classList.remove('hidden');
  pushLayerState();
  // 围观者进入面板即可看到大厅；只有点「参与游戏」才正式加入本局
  setTimeout(() => spyRender(), 30);
}
function closeSpy(fromPop) {
  if (!fromPop && layerPushed) { history.back(); return; }
  $('spyGame').classList.add('hidden');
  if (spyTickTimer) { clearInterval(spyTickTimer); spyTickTimer = null; } // 关闭面板即停掉发言倒计时空转
}

let spyTickTimer = null;
function updateSpyTick() {
  const el = document.getElementById('spTick');
  if (!el || spyState.phase !== 'speak') { if (spyTickTimer) { clearInterval(spyTickTimer); spyTickTimer = null; } return; }
  const left = Math.max(0, Math.round((spyState.speakDeadline - adjustedNow()) / 1000));
  el.textContent = left + 's';
}
function applySpyState(msg) {
  spyState = msg;
  // 结算瞬间结算本地积分（仅参与者、每人只加一次）
  if (spyPrevPhase !== 'over' && spyState.phase === 'over' && spyState.result) {
    const mine = spyState.result.words[myId];
    if (mine) {
      let add = 0;
      if (spyState.result.winner === 'civ' && mine.role === 'civ') add = 10;
      else if (spyState.result.winner === 'spy' && mine.role === 'spy') add = 15;
      if (add) { const total = addSpyScore(add); toast(`🏆 你 +${add} 分！卧底积分累计 ${total}`); }
    }
  }
  spyPrevPhase = spyState.phase;
  spyRender();
}

function spyIsPlayer() { return (spyState.players || []).some(p => p.id === myId); }
function spyCurSpeakerId() {
  if (spyState.phase !== 'speak') return null;
  return spyState.order[spyState.speakIdx];
}

function spyRender() {
  const s = spyState;
  if (s.phase !== 'speak' && spyTickTimer) { clearInterval(spyTickTimer); spyTickTimer = null; }
  const inLobby = s.phase === 'lobby';
  const inOver = s.phase === 'over';
  const playing = s.phase === 'speak' || s.phase === 'vote';
  const host = DRAW_NEXT_ALLOW.includes(myNick);

  // 阶段进度条：大厅隐藏；描述/投票/结算 三步走
  const stepsEl = $('spySteps');
  if (stepsEl) {
    stepsEl.classList.toggle('hidden', inLobby);
    const order = ['speak', 'vote', 'over'];
    const curIdx = inOver ? 2 : (s.phase === 'vote' ? 1 : 0);
    stepsEl.querySelectorAll('.sp-step').forEach(st => {
      const i = order.indexOf(st.dataset.step);
      st.classList.toggle('done', i < curIdx);
      st.classList.toggle('active', i === curIdx && s.phase !== 'lobby');
    });
  }

  // 我的积分
  $('spyMyScore').textContent = '积分 ' + getSpyScore();

  // 顶部词库 / 匿名开关（仅大厅可改）
  document.querySelectorAll('.spy-bank').forEach(b => {
    b.classList.toggle('active', b.dataset.bank === s.bank);
    b.disabled = !inLobby;
  });
  const anon = $('spyAnon');
  anon.checked = !!s.anonymous;
  anon.disabled = !inLobby;
  $('spyTopCtrl').classList.toggle('locked', !inLobby);

  // 我的词条（游戏中且我是参与者才可见；不揭示身份）
  const myWordEl = $('spyMyWord');
  if (playing && s.me && s.me.word) {
    myWordEl.classList.remove('hidden');
    myWordEl.innerHTML = `<div class="sp-w-lbl">你的词条</div><div class="sp-w-word">${spyEsc(s.me.word)}</div><div class="sp-w-tip">别直接说出这个词，描述给其他人听～</div>`;
  } else {
    myWordEl.classList.add('hidden');
  }

  // 玩家列表
  const playersEl = $('spyPlayers');
  const curId = spyCurSpeakerId();
  if (!s.players || !s.players.length) {
    playersEl.innerHTML = '<div class="spy-empty">还没有人参与，点下方「参与游戏」加入本局</div>';
  } else {
    playersEl.innerHTML = s.players.map(p => {
      const cls = ['sp-p'];
      if (p.isMe) cls.push('me');
      if (!p.alive) cls.push('out');
      if (p.id === curId) cls.push('speaking');
      const tag = p.id === s.hostId ? '<span class="sp-tag host">房主</span>' : '';
      const meTag = p.isMe ? '<span class="sp-tag me">你</span>' : '';
      const st = !p.alive ? '<span class="sp-tag out">出局</span>'
        : (p.disconnected ? '<span class="sp-tag dc">重连中</span>'
          : (p.id === curId ? '<span class="sp-tag sp">发言中</span>'
            : (s.phase === 'vote' && p.voted ? '<span class="sp-tag voted">已投</span>' : '')));
      const voteCount = (s.tally && s.tally[p.id]) ? `<span class="sp-vote">${s.tally[p.id]}票</span>` : '';
      const ava = spyEsc((p.name || '?').charAt(0));
      return `<div class="${cls.join(' ')}"><span class="sp-ava">${ava}</span><span class="sp-name">${spyEsc(p.name)}</span>${meTag}${tag}${st}${voteCount}</div>`;
    }).join('');
  }
  $('spyPlayerCount').textContent = (s.players || []).length;

  // 围观人员（网页在线、但未点参与）
  const specIds = new Set((s.players || []).map(p => p.id));
  const specs = (serverState.users || []).filter(u => u.id && !specIds.has(u.id));
  const specEl = $('spySpec');
  if (!specs.length) specEl.innerHTML = '<span class="spy-empty">还没有人围观，叫上小伙伴一起玩～</span>';
  else specEl.innerHTML = specs.map(u => `<span class="sp-spec">${spyEsc(u.nickname || '匿名')}</span>`).join('');

  // 发言区
  const speakArea = $('spySpeakArea');
  const voteArea = $('spyVoteArea');
  speakArea.classList.toggle('hidden', !playing && !inOver);
  voteArea.classList.toggle('hidden', s.phase !== 'vote');

  if (s.phase === 'speak') {
    const cur = s.players.find(p => p.id === curId);
    const left = Math.max(0, Math.round((s.speakDeadline - adjustedNow()) / 1000));
    $('spyCur').innerHTML = cur ? `轮到 <b>${spyEsc(cur.name)}</b> 发言… <span class="sp-tick" id="spTick">${left}s</span>` : '等待发言';
    const imCur = curId === myId;
    $('spySpeakInputWrap').classList.toggle('hidden', !imCur);
    if (imCur) setTimeout(() => { const i = $('spySpeakInput'); if (i && document.activeElement !== i) i.focus(); }, 50);
    if (!spyTickTimer) spyTickTimer = setInterval(updateSpyTick, 250);
  } else if (s.phase === 'vote') {
    $('spyCur').textContent = '';
    $('spySpeakInputWrap').classList.add('hidden');
  }
  // 发言记录
  $('spySpeeches').innerHTML = (s.speeches || []).map(sp =>
    `<div class="sp-line"><span class="sp-line-name">${spyEsc(sp.name)}</span><span class="sp-line-text">${spyEsc(sp.text)}</span></div>`
  ).join('') || '<div class="spy-empty">还没有人发言</div>';

  // 投票区
  if (s.phase === 'vote') {
    const me = s.players.find(p => p.id === myId);
    const iVoted = !!(me && me.voted);
    const tip = $('spyVoteTip');
    if (iVoted) tip.textContent = '你已投票，等待其他人…';
    else if (me && me.alive) tip.textContent = '投票给你怀疑的卧底（不能投自己）';
    else tip.textContent = '等待玩家投票…';
    const candidates = s.players.filter(p => p.alive && p.id !== myId);
    $('spyVoteList').innerHTML = candidates.map(p => {
      const cnt = (s.tally && s.tally[p.id]) || 0;
      const dis = iVoted ? 'disabled' : '';
      return `<button class="sp-vote-btn" data-target="${p.id}" ${dis}>${spyEsc(p.name)} <span class="sp-vc">${cnt}</span></button>`;
    }).join('') || '<div class="spy-empty">没有可投的人</div>';
    // 弃票按钮（仅存活且未投票时可用）
    if (me && me.alive) {
      $('spyVoteList').innerHTML += `<button class="sp-vote-btn sp-abstain" data-target="" ${iVoted ? 'disabled' : ''}>🙅 弃票</button>`;
    }
    document.querySelectorAll('.sp-vote-btn').forEach(b => {
      b.onclick = () => { send({ type: 'spyVote', id: myId, target: b.dataset.target || '' }); };
    });
  }

  // 结算区
  const resultEl = $('spyResultArea');
  if (s.phase === 'over' && s.result) {
    resultEl.classList.remove('hidden');
    const r = s.result;
    const winTxt = r.winner === 'civ' ? '🎉 平民胜利！' : '🕵️ 卧底胜利！';
    const underNames = r.undercovers.map(id => (r.words[id] && r.words[id].name) || '玩家').join('、');
    const rows = Object.keys(r.words).map(id => {
      const w = r.words[id];
      const roleTag = w.role === 'spy' ? '<span class="sp-tag spy">卧底</span>' : '<span class="sp-tag civ">平民</span>';
      const meTag = id === myId ? '<span class="sp-tag me">你</span>' : '';
      return `<div class="sp-r-row"><span class="sp-name">${spyEsc(w.name)}</span>${meTag}${roleTag}<span class="sp-r-word">${spyEsc(w.word)}</span></div>`;
    }).join('');
    resultEl.innerHTML = `<div class="sp-win ${r.winner}">${winTxt}</div>
      <div class="sp-unders">卧底是：<b>${spyEsc(underNames)}</b></div>
      <div class="sp-r-title">本局词条</div>${rows}`;
  } else {
    resultEl.classList.add('hidden');
  }

  // 提示
  const hint = $('spyHint');
  if (inLobby) hint.textContent = host
    ? `点「参与游戏」凑齐 ${s.min}~${s.max} 人，你（房主）即可开始`
    : '等房主（羡温言/LL/水果刀/慢慢）凑齐 3~8 人开始游戏';
  else if (playing) hint.textContent = '轮流描述自己的词，全部发言后投票揪出卧底';
  else hint.textContent = '';

  // 底部操作
  const joinBtn = $('spyJoinBtn'), startBtn = $('spyStartBtn'), restartBtn = $('spyRestartBtn');
  // 参与游戏
  if (inLobby || inOver) {
    joinBtn.classList.remove('hidden');
    if (spyIsPlayer()) { joinBtn.textContent = '已参与 ✓'; joinBtn.disabled = true; }
    else { joinBtn.textContent = '参与游戏'; joinBtn.disabled = false; }
  } else { joinBtn.classList.add('hidden'); }
  // 开始游戏（仅房主 + 大厅 + 人数达标）
  if (inLobby && host) {
    startBtn.classList.remove('hidden');
    const ok = s.players.length >= s.min && s.players.length <= s.max;
    startBtn.disabled = !ok;
    startBtn.textContent = ok ? '开始游戏' : `需 ${s.min}~${s.max} 人（${s.players.length}）`;
  } else {
    startBtn.classList.add('hidden');
  }
  // 重新开局（仅房主可操作；游戏中隐藏）
  if (playing) {
    restartBtn.classList.add('hidden');
  } else {
    restartBtn.classList.remove('hidden');
    restartBtn.disabled = !host;
    restartBtn.textContent = host ? '🔄 重新开局' : '等房主重新开局';
  }
}

// 事件绑定
$('openSpy').onclick = openSpy;
$('spyClose').onclick = () => closeSpy();
$('spyJoinBtn').onclick = () => {
  if (spyIsPlayer()) return;
  send({ type: 'spyJoin', id: myId });
};
$('spyStartBtn').onclick = () => { send({ type: 'spyStart', id: myId }); };
$('spyRestartBtn').onclick = () => { send({ type: 'spyRestart', id: myId }); };
$('spyAnon').onchange = (e) => { send({ type: 'spySetAnon', id: myId, anonymous: e.target.checked }); };
document.querySelectorAll('.spy-bank').forEach(b => {
  b.onclick = () => { send({ type: 'spySetBank', id: myId, bank: b.dataset.bank }); };
});
$('spySpeakSend').onclick = () => {
  const inp = $('spySpeakInput');
  const text = inp.value.trim();
  if (!text) return;
  send({ type: 'spySpeak', id: myId, text });
  inp.value = '';
};
$('spySpeakInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('spySpeakSend').click(); } });

// 猜词
function dgSendGuess() {
  const inp = $('dgGuessInput');
  const text = inp.value.trim();
  if (!text) return;
  if (!dgJoined) { toast('围观中～点「参与游戏」加入后才能猜词 👀'); return; }
  if (dgAmDrawer()) { toast('你是画师，不能猜自己的词 🤫'); return; }
  if (!dgActive()) { toast('还没开局，点「开始游戏」先'); return; }
  if (dgState.settled && !dgState.solved) { toast('⏰ 本轮已结束，等下一轮吧'); return; }
  send({ type: 'drawGuess', id: myId, text });
  inp.value = '';
}
$('dgGuessSend').onclick = dgSendGuess;
$('dgGuessInput').addEventListener('keydown', e => { if (e.key === 'Enter') dgSendGuess(); });

// 工具：颜色 / 橡皮 / 清空 / 笔刷
document.querySelectorAll('.dg-sw').forEach(sw => {
  sw.onclick = () => {
    document.querySelectorAll('.dg-sw').forEach(s => s.classList.remove('active'));
    sw.classList.add('active'); dgColor = sw.dataset.c; dgErase = false;
  };
});
$('dgEraser').onclick = () => { dgErase = !dgErase; toast(dgErase ? '橡皮开' : '橡皮关'); };
$('dgClear').onclick = () => {
  if (!dgAmDrawer()) { toast('只有画师能清空画布'); return; }
  drawClearCanvas(); send({ type: 'drawClear', id: myId });
};
$('dgBrush').oninput = e => dgBrush = +e.target.value;

// 画布事件（鼠标 + 触屏）
(function bindDgCanvas() {
  const cv = dgCanvas();
  if (!cv) return;
  cv.addEventListener('mousedown', dgStart);
  cv.addEventListener('mousemove', dgMove);
  window.addEventListener('mouseup', dgEnd);
  cv.addEventListener('touchstart', dgStart, { passive: false });
  cv.addEventListener('touchmove', dgMove, { passive: false });
  cv.addEventListener('touchend', dgEnd);
  cv.addEventListener('touchcancel', dgEnd);
  // 绘画过程中禁止页面滚动/缩放（配合 CSS touch-action:none 双保险）
  cv.style.touchAction = 'none';
})();

// 窗口变化时重设画布并回放
window.addEventListener('resize', () => {
  if ($('drawGame').classList.contains('hidden')) return;
  dgSetupCanvas(); drawClearCanvas(); (dgState.ops || []).forEach(dgDrawSeg);
});

// ===================== D块：页面粘性 =====================

// ---------- D2 PWA：注册 Service Worker ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------- D5 手机返回键关闭游戏层 ----------
let layerPushed = false;
function pushLayerState() {
  if (layerPushed) return; // 已有游戏层历史，不重复压栈
  history.pushState({ moyuLayer: 1 }, '');
  layerPushed = true;
}
window.addEventListener('popstate', () => {
  layerPushed = false;
  if (!$('drawGame').classList.contains('hidden')) closeDrawGame(true);
  if (!$('spyGame').classList.contains('hidden')) closeSpy(true);
});

// ---------- D1 新手引导（首次访问） ----------
(function initTour() {
  const mask = $('tourMask');
  if (!mask) return;
  if (localStorage.getItem('moyu_tour_v1')) return;
  mask.classList.remove('hidden');
  $('tourGo').onclick = () => {
    localStorage.setItem('moyu_tour_v1', '1');
    mask.classList.add('hidden');
  };
})();

// ---------- D4 连续打卡 streak + 徽章 ----------
function dateStr(offsetDays) {
  const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function todayStr() { return dateStr(0); }
function streakKey() { return 'moyu_streak_' + (myNick || ''); }
function getStreak() {
  try { return JSON.parse(localStorage.getItem(streakKey())) || { last: '', n: 0 }; }
  catch (e) { return { last: '', n: 0 }; }
}
function streakBadge(n) {
  if (n >= 30) return '🏅 摸鱼老油条';
  if (n >= 14) return '🥈 摸鱼达人';
  if (n >= 7) return '🥉 摸鱼常客';
  if (n >= 3) return '✨ 渐入佳境';
  return '';
}
function recordStreak() {
  if (!myNick) return;
  const t = todayStr();
  const st = getStreak();
  if (st.last === t) return; // 今天已打卡
  st.n = (st.last === dateStr(-1)) ? st.n + 1 : 1;
  st.last = t;
  localStorage.setItem(streakKey(), JSON.stringify(st));
  updateStreakUI();
  const b = streakBadge(st.n);
  toast(`🔥 连续打卡 ${st.n} 天${b ? ' · ' + b : ''}！`);
}
function updateStreakUI() {
  const el = $('myStreak');
  if (!el) return;
  const st = getStreak();
  // 今天或昨天打过卡视为「连续中」，否则归零显示
  const alive = (st.last === todayStr() || st.last === dateStr(-1)) ? st.n : 0;
  const b = streakBadge(alive);
  el.textContent = alive + '天' + (b ? ' ' + b.split(' ')[0] : '');
}
// 开始摸鱼 = 打卡
(function hookStreak() {
  const btn = $('btnStart');
  const orig = btn.onclick;
  btn.onclick = () => { if (orig) orig(); recordStreak(); };
})();
updateStreakUI();
setInterval(updateStreakUI, 10000); // 昵称加入后 / 跨天自动刷新

// ---------- D3 排行榜分享图（晒榜） ----------
function shareRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
(function initShareBoard() {
  const btn = $('shareBoard');
  if (!btn) return;
  btn.onclick = (e) => {
    e.stopPropagation();
    const users = serverState.users.slice()
      .sort((a, b) => viewLive(b, currentView) - viewLive(a, currentView))
      .slice(0, 10);
    if (!users.length) { toast('榜上还没人，先摸会儿鱼再来晒～'); return; }
    const W = 640, rowH = 58, top = 150, H = top + users.length * rowH + 70;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    // 背景渐变
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#EAF7F0'); g.addColorStop(1, '#FFF7EC');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 标题
    ctx.textAlign = 'center';
    ctx.fillStyle = '#1C1C1E';
    ctx.font = 'bold 30px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('🐟 摸鱼英雄榜', W / 2, 56);
    const viewLbl = { total: '总榜', today: '今日榜', week: '本周榜', month: '本月榜' }[currentView] || '总榜';
    ctx.font = '15px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#8E8E93';
    ctx.fillText(`${viewLbl} · ${todayStr()} · 带薪摸鱼，理直气壮`, W / 2, 88);
    // 榜单行
    users.forEach((u, i) => {
      const y = top + i * rowH;
      ctx.fillStyle = i === 0 ? 'rgba(255,227,140,.55)' : 'rgba(255,255,255,.75)';
      shareRoundRect(ctx, 24, y - 36, W - 48, 48, 12);
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.font = 'bold 20px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#1C1C1E';
      const medal = ['🥇', '🥈', '🥉'][i] || String(i + 1);
      ctx.fillText(medal, 44, y - 3);
      ctx.font = '17px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText(String(u.nickname || '匿名').slice(0, 10), 100, y - 3);
      ctx.textAlign = 'right';
      ctx.font = 'bold 17px Menlo, Consolas, monospace';
      ctx.fillStyle = '#2E8B5F';
      ctx.fillText(fmt(viewLive(u, currentView)), W - 44, y - 3);
    });
    // 页脚
    ctx.textAlign = 'center';
    ctx.font = '13px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#B0B0B5';
    ctx.fillText('—— 摸鱼计时排行榜 · 卷什么卷，摸鱼才是本事 ——', W / 2, H - 26);
    // 下载
    const a = document.createElement('a');
    a.download = `摸鱼英雄榜_${viewLbl}_${todayStr()}.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
    toast('📸 榜单图已保存，快去群里嘚瑟～');
  };
})();
