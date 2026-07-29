// 清理 wordbank.js 中的脏数据（手滑混入的垃圾词 / 重复 / 前后空格）
const fs = require('fs');
const { WORD_BANK, CAT_LABEL, SPY_BANKS, SPY_BANK_LABEL } = require('./wordbank');

const JUNK = new Set(['Mini猪', '小香猪', '猫兔', '龙猫兔', '_expr_', '']);

function clean(a) {
  const seen = new Set();
  const out = [];
  for (let w of a) {
    if (typeof w !== 'string') continue;
    w = w.trim();
    if (!w) continue;
    if (JUNK.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

const outWB = {};
for (const cat of Object.keys(WORD_BANK)) {
  const easy = clean(WORD_BANK[cat].easy);
  const hardAll = clean(WORD_BANK[cat].hard);
  const easySet = new Set(easy);
  const hard = hardAll.filter(w => !easySet.has(w));
  outWB[cat] = { easy, hard };
}

const outSB = {};
for (const bank of Object.keys(SPY_BANKS)) {
  const seen = new Set();
  const pairs = [];
  for (const p of SPY_BANKS[bank]) {
    const civ = (p.civ || '').trim(), spy = (p.spy || '').trim();
    if (!civ || !spy) continue;
    const key = civ + '\u0000' + spy;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ civ, spy });
  }
  outSB[bank] = pairs;
}

const lines = [];
lines.push('// 自动生成：词库数据（你画我猜 WORD_BANK / 谁是卧底 SPY_BANKS）');
lines.push("// 来源 build_wordbank.js，已去重 + 清理脏数据。");
lines.push("'use strict';");
lines.push('');
lines.push('const WORD_BANK = {');
const cats = Object.keys(outWB);
cats.forEach((cat, i) => {
  lines.push('  ' + cat + ': {');
  lines.push('    easy: ' + JSON.stringify(outWB[cat].easy) + ',');
  lines.push('    hard: ' + JSON.stringify(outWB[cat].hard));
  lines.push('  }' + (i < cats.length - 1 ? ',' : ''));
});
lines.push('};');
lines.push('');
lines.push("const CAT_LABEL = { career: '职场', meme: '网络热梗', life: '生活休闲' };");
lines.push('');
lines.push('const SPY_BANKS = {');
const banks = Object.keys(outSB);
banks.forEach((bank, i) => {
  lines.push('  ' + bank + ': ' + JSON.stringify(outSB[bank]) + (i < banks.length - 1 ? ',' : ''));
});
lines.push('};');
lines.push('');
lines.push("const SPY_BANK_LABEL = { career: '职场词库', meme: '网络热梗词库', life: '生活休闲词库' };");
lines.push('');
lines.push('module.exports = { WORD_BANK, CAT_LABEL, SPY_BANKS, SPY_BANK_LABEL };');
lines.push('');

fs.writeFileSync('wordbank.js', lines.join('\n'), 'utf8');

let tw = 0; for (const c of cats) tw += outWB[c].easy.length + outWB[c].hard.length;
let tp = 0; for (const b of banks) tp += outSB[b].length;
console.log('清理后 你画我猜 =', tw, '(career', outWB.career.easy.length + outWB.career.hard.length, '/ meme', outWB.meme.easy.length + outWB.meme.hard.length, '/ life', outWB.life.easy.length + outWB.life.hard.length, ')');
console.log('清理后 谁是卧底 =', tp, '(career', outSB.career.length, '/ meme', outSB.meme.length, '/ life', outSB.life.length, ')');
console.log('OK');
