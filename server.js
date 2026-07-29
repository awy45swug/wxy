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

// 你画我猜：即使不是当前画师，这些昵称也拥有「下一轮」按钮权限
const DRAW_NEXT_ALLOW = ['羡温言', 'LL', '水果刀', '慢慢'];
// 进场禁用的匿名昵称（防止"匿名闲鱼/匿名咸鱼"这类无意义名）
const FORBIDDEN_NICKS = ['匿名闲鱼', '匿名咸鱼'];

// 你画我猜：单局时长与首字拼音提示时机（毫秒）。
// 可用环境变量 DRAW_TEST_FAST=1 加速自动化测试（2 秒一局 / 1 秒提示）。
const DRAW_ROUND_MS = process.env.DRAW_TEST_FAST ? 2000 : 180000;
const DRAW_HINT_AT_MS = process.env.DRAW_TEST_FAST ? 1000 : 150000;
// 词库首字拼音映射（自动生成，见 scripts/gen_pinyin_map.js），用于"150 秒首字拼音提示"
const DRAW_PINYIN_MAP = require('./draw_pinyin_map');

// 谁是卧底：拥有「开始游戏」权限的昵称（与画师下一轮白名单一致）
const SPY_HOST_ALLOW = DRAW_NEXT_ALLOW;
const SPY_MIN = 3, SPY_MAX = 8;
// 双词库：每组含平民词 civ 与近似的卧底词 spy
const SPY_BANKS = {
  career: [
    { civ: '加班', spy: '值班' }, { civ: '周报', spy: '月报' }, { civ: '摸鱼', spy: '划水' },
    { civ: '开会', spy: '培训' }, { civ: '工资', spy: '奖金' }, { civ: '简历', spy: '名片' },
    { civ: '同事', spy: '搭档' }, { civ: '出差', spy: '旅行' }, { civ: 'KPI', spy: 'OKR' },
    { civ: '团建', spy: '聚餐' }, { civ: '报销', spy: '发票' }, { civ: '离职', spy: '请假' },
    { civ: '面试', spy: '笔试' }, { civ: '工位', spy: '卡座' }, { civ: '调休', spy: '年假' }
  ],
  meme: [
    { civ: '绝绝子', spy: 'yyds' }, { civ: '躺平', spy: '摆烂' }, { civ: 'emo', spy: '破防' },
    { civ: '显眼包', spy: '社牛' }, { civ: '搭子', spy: '朋友' }, { civ: '雪糕刺客', spy: '价格刺客' },
    { civ: '电子榨菜', spy: '下饭剧' }, { civ: '班味', spy: '人夫感' }, { civ: '听劝', spy: '劝分' },
    { civ: 'CPU你', spy: 'PUA你' }, { civ: '硬控', spy: '控场' }, { civ: '冤种', spy: '铁憨憨' },
    { civ: '上头', spy: '上瘾' }, { civ: 'i人', spy: 'e人' }, { civ: '尊嘟', spy: '假嘟' }
  ]
};
const SPY_BANK_LABEL = { career: '职场词库', meme: '网络热梗词库' };
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
// 350 词题库：职场 150 / 网络热梗 120 / 生活休闲 80（2-6 字、可画、无低俗暴力）
const WORD_BANK = {
  career: ["摸鱼","画饼","周报","月报","年报","加班","KPI","OKR","甩锅","背锅","复盘","团建","改需求","带薪拉屎","划水","打卡","汇报","提案","立项","裁员","优化","拉通","对齐","闭环","赋能","落地","跟进","推进","拉齐","同步","梳理","拆解","盘点","冲刺","救火","攻坚","突击","转正","实习","面试","跳槽","升职","加薪","降薪","调岗","离职","入职","内推","报销","请假","出差","培训","调休","早会","例会","站会","周会","月会","季度会","总结会","启动会","评审会","复盘会","庆功宴","散伙饭","头脑风暴","一对一","背靠背","视频会","PPT","Excel","文档","表格","邮件","群聊","语音","钉钉","飞书","企微","腾讯会议","屏幕共享","云文档","知识库","键盘","鼠标","显示器","工牌","工位","会议室","白板","投影仪","打印机","咖啡机","饮水机","老板","同事","甲方","乙方","客户","需求","排期","猎头","简历","竞业","合同","工资","年终奖","绩效","奖金","五险一金","公积金","社保","个税","绿植","升降桌","人体工学椅","防窥膜","降噪耳机","下午茶","零食","发票","摸鱼神器","抓手","颗粒度","组合拳","方法论","护城河","第二曲线","信息差","认知差","年假","保密","报税","共享文档","在线表格","需求评审","发版","Bug","测试","提测","改bug","背锅侠","摸鱼怪","划水王","画饼侠","卷王","内卷","准点下班","咖啡杯","订书机","摸鱼学","带薪摸鱼","线上会议","需求变更","版本迭代","灰度发布","AB测试","周报文学","画大饼","甩锅侠","职场PUA","向上管理","向下兼容","早八","日报","晨会","摸鱼搭子","工位摸鱼","摸鱼学","带薪健身","工位养生","假装忙","已读不回","消息红点","撤回键","表情包","需求池","排期表","大会员","键盘侠","打工魂","居家办公","弹性打卡","在线摸鱼","摸鱼文学","准点跑路"],
  meme: ["摆烂","显眼包","发疯","CPU","泰裤辣","躺平","内卷","润了","绝绝子","emo","破防","裂开","蚌埠住了","栓Q","冤种","尊嘟假嘟","退退退","耶斯莫拉","集美","宝子","家人们","完了芭比Q","典中典","小丑竟是我","卷王","佛系","社恐","社牛","社死","雪王","蜜雪冰城","爷青回","真香","打脸","凡尔赛","阴阳怪气","绿茶","海王","渣男","普信","油腻","社畜","工具人","打工人","尾款人","干饭人","搬砖","韭菜","割韭菜","智商税","氛围感","仪式感","松弛感","钝感力","情绪价值","精神状态","发疯文学","废话文学","孔乙己的长衫","鼠鼠我啊","修行","修仙","电子木鱼","赛博","赛博朋克","元宇宙","蹭热度","流量","热搜","出圈","顶流","网红","种草","安利","上头","下头","躺赢","带飞","躺枪","翻车","翻盘","逆袭","逆天","离谱","抽象","小丑","吃瓜","吃瓜群众","爆料","实锤","塌房","洗白","翻红","黑红","毒唯","唯粉","路人粉","梦女","私生饭","脱粉","爬墙","墙头","本命","C位","出道","成团","限定","联名","周边","二创","鬼畜","名场面","高能","泪崩","治愈","解压","萌宠","手工","露营","飞盘","芭比Q了","听我说谢谢你","雪豹","泼天的富贵","遥遥领先","City不City","班味","硬控","尊嘟","公主请上车","废话文学","momo","已读乱回","啊对对对","细思极恐","精神离职","职场演技","暴风吸入","KFC你","背刺","上分","班味","硬控","已读乱回","啊对对对","细思极恐","精神离职","职场演技","暴风吸入","KFC你","电子榨菜","CPU你","公主请","i人","e人","搭子","听劝","多巴胺","酱香拿铁","茅台","演唱会","音乐节","美拉德"],
  life: ["奶茶","火锅","猫咪","可乐","雨伞","咖啡","啤酒","炸鸡","烧烤","串串","麻辣烫","螺蛳粉","煎饼","包子","饺子","面条","寿司","披萨","汉堡","薯条","蛋糕","面包","甜甜圈","冰淇淋","水果","苹果","香蕉","西瓜","草莓","葡萄","橙子","芒果","榴莲","桃子","樱桃","小狗","兔子","仓鼠","乌龟","金鱼","鹦鹉","多肉","鲜花","玫瑰","向日葵","书本","小说","漫画","电影","电视剧","综艺","游戏","钢琴","吉他","跑步","健身","瑜伽","游泳","篮球","足球","羽毛球","骑行","钓鱼","旅行","拍照","自拍","美甲","化妆","香水","口红","面膜","睡衣","枕头","被子","大床","沙发","抱枕","台灯","蜡烛","香薰","露营车","骑行服","钓鱼佬","猫罐头","狗狗","仓鼠球","盲盒","手办","汉服","洛丽塔","奶茶杯","瑞幸","蜜雪","螺蛳粉","麻辣香锅","烤冷面","煎饼果子","章鱼小丸子","钵仔糕","麻薯","司康","可颂","巴斯克","猫窝","狗窝","猫爬架","逗猫棒","腰旗橄榄球","桨板","滑雪","冲浪","攀岩","密室逃脱","剧本杀","桌游","麻将","掼蛋","围炉煮茶","多巴胺穿搭","露营帐篷","天幕","野餐","滑板","陆冲","猫咖","狗咖","撸猫","撸狗","手作","陶艺","烘焙","咖啡拉花","精酿","微醺","露营椅"]
};
const CAT_LABEL = { career: '职场', meme: '网络热梗', life: '生活休闲' };
function pickWord() {
  const cats = Object.keys(WORD_BANK);
  const cat = cats[Math.floor(Math.random() * cats.length)];
  const arr = WORD_BANK[cat];
  return { word: arr[Math.floor(Math.random() * arr.length)], cat: CAT_LABEL[cat] };
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
// 进入发言阶段：把 speakIdx 指向第一个仍存活的玩家
function spyGotoSpeak() {
  const s = state.spy;
  s.speakIdx = 0;
  while (s.speakIdx < s.order.length && s.words[s.order[s.speakIdx]].out) s.speakIdx++;
  if (s.speakIdx >= s.order.length) { s.phase = 'vote'; s.votes = {}; }
  else s.phase = 'speak';
}
// 投票结束后结算本轮：淘汰最高票玩家，判定胜负或进入下一轮
function spyTally() {
  const s = state.spy;
  const alive = s.players.filter(p => !s.words[p].out);
  const tally = {};
  Object.values(s.votes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
  let max = 0; Object.values(tally).forEach(v => { if (v > max) max = v; });
  const top = Object.keys(tally).filter(k => tally[k] === max);
  const eliminated = top[Math.floor(Math.random() * top.length)]; // 平票随机淘汰一人
  s.words[eliminated].out = true;
  const aliveSpies = s.players.filter(p => !s.words[p].out && s.words[p].role === 'spy').length;
  const aliveTotal = s.players.filter(p => !s.words[p].out).length;
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

// 共享状态：users 以 id 为 key，chats 为聊天记录（保留最近 50 条），xhs 为小红书热榜缓存
let state = {
  day: todayStr(), week: weekStr(), month: monthStr(), users: {}, chats: [], xhs: { updated: 0, items: [] },
  game: { word: null, cat: null, drawerId: null, round: 0, ops: [], wordLen: 0, swapsLeft: 0, guessLog: [], solved: false, solvedBy: null, players: [], deadline: 0, settled: false, hint: null, hintGiven: false },
  spy: { phase: 'lobby', bank: 'career', anonymous: false, hostId: null, players: [], words: {}, order: [], speakIdx: 0, speeches: [], votes: {}, round: 0, result: null }
};

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
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); } catch (e) {}
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

// 当前已点进「你画我猜」页面的用户 id 集合。
// 只有在这个集合里的用户，才能认领画师座位、或保持画师身份（即必须"点进你画我猜页面"才行）。
const drawPresent = new Set();

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
  if (state.chats.length > 50) state.chats = state.chats.slice(-50);
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
      // 谁是卧底：断开则退出本局；若人数不足则回大厅，避免卡死
      const sp = state.spy;
      if (sp && sp.players.includes(uid)) {
        sp.players = sp.players.filter(p => p !== uid);
        sp.order = (sp.order || []).filter(p => p !== uid);
        delete sp.words[uid];
        if (sp.phase === 'speak' && sp.order[sp.speakIdx] === uid) {
          sp.speakIdx++;
          while (sp.speakIdx < sp.order.length && sp.words[sp.order[sp.speakIdx]].out) sp.speakIdx++;
          if (sp.speakIdx >= sp.order.length) { sp.phase = 'vote'; sp.votes = {}; }
        }
        const aliveLeft = sp.players.filter(p => sp.words[p] && !sp.words[p].out).length;
        if (sp.phase !== 'lobby' && sp.phase !== 'over' && aliveLeft < SPY_MIN) {
          sp.phase = 'lobby'; sp.words = {}; sp.order = []; sp.speakIdx = 0;
          sp.speeches = []; sp.votes = {}; sp.round = 0; sp.result = null; sp.hostId = null;
        }
        saveState();
        broadcastSpy();
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
  // 谁是卧底：把当前局状态发给新连接（围观者 me=null，参与者拿到自己的词）
  ws.send(JSON.stringify(spyStateForClient(ws.userId)));

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (e) { return; }

    const id = msg.id;
    if (!id) return;

    if (msg.type === 'join') {
      const rawNick = String(msg.nickname || '').trim();
      const safeNick = (rawNick && !FORBIDDEN_NICKS.includes(rawNick))
        ? rawNick
        : ('摸鱼咸鱼' + Math.floor(Math.random() * 900 + 100));
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
      state.game.settled = false; state.game.hint = null; state.game.hintGiven = false;
      startDrawRoundTimer();      // 开局启动 180s 倒计时
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
      // 下一轮：画师本人，或特权昵称（羡温言/LL/水果刀/慢慢）可触发。
      // 不自动轮转画师——保持当前画师，仅换词开新一轮（想换画师需当前画师点「下一轮」后，下一位点「我要当画师」接棒）。
      const g = state.game;
      if (!g || !g.drawerId) return;
      const u = state.users[id];
      if (!u) return;
      const isDrawer = g.drawerId === id;
      const isPriv = DRAW_NEXT_ALLOW.includes(u.nickname);
      if (!isDrawer && !isPriv) return; // 既不是画师也不是特权昵称 → 忽略
      const w = pickWord();
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
      const pair = SPY_BANKS[s.bank][Math.floor(Math.random() * SPY_BANKS[s.bank].length)];
      const order = shuffle(s.players);
      const spyCount = order.length <= 5 ? 1 : 2; // 3~5 人 1 卧底，6~8 人 2 卧底
      s.words = {};
      order.forEach((pid, i) => {
        const role = i < spyCount ? 'spy' : 'civ';
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
      while (s.speakIdx < s.order.length && s.words[s.order[s.speakIdx]].out) s.speakIdx++;
      if (s.speakIdx >= s.order.length) { s.phase = 'vote'; s.votes = {}; }
      saveState();
      broadcastSpy();
    } else if (msg.type === 'spyVote') {
      const s = state.spy;
      if (s.phase !== 'vote') return;
      if (!s.words[id] || s.words[id].out) return;     // 出局者 / 非参与者不能投
      const t = msg.target;
      if (!t || t === id) return;                     // 不能投自己
      if (!s.words[t] || s.words[t].out) return;      // 只能投存活参与者
      s.votes[id] = t;
      const aliveCount = s.players.filter(p => !s.words[p].out).length;
      if (Object.keys(s.votes).length >= aliveCount) spyTally();
      saveState();
      broadcastSpy();
    } else if (msg.type === 'spyRestart') {
      // 所有人可见：重置回大厅（保留参与者、词库、匿名设置，方便直接再来一局）
      const s = state.spy;
      s.phase = 'lobby';
      s.words = {};
      s.order = [];
      s.speakIdx = 0;
      s.speeches = [];
      s.votes = {};
      s.round = 0;
      s.result = null;
      s.hostId = null;
      saveState();
      broadcastSpy();
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
