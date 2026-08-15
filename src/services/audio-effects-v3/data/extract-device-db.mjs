// 从 原应用 反编译产物 x/ht.java 提取设备频响数据库（Node 脚本）
// 用法: node extract-device-db.mjs <ht.java路径> <输出json路径>
// 输出: [{brand, devices:[{category, code, model, curveA(128), curveB(64), range}]}]
const fs = require('node:fs');

const [,, srcPath = 'decompiled/sources/x/ht.java', outPath = 'device-db.json'] = process.argv;
const src = fs.readFileSync(srcPath, 'utf8');
const arrStart = src.indexOf('= {new c4(');
const arrEnd = src.indexOf('})};', arrStart);
const body = src.slice(arrStart + 2, arrEnd + 3);

function splitTop(s, open, close) {
  const parts = []; let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) { parts.push(s.slice(start, i + 1)); start = i + 1; } }
    else if (ch === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  if (start < s.length) parts.push(s.slice(start));
  return parts;
}

function parseFloatArray(expr) {
  let m = expr.match(/^\s*l\(([\s\S]*)\)\s*$/);
  if (m) return m[1].split(',').map(x => parseFloat(x.trim().replace(/f$/, '')));
  m = expr.match(/^\s*g\(([\s\S]*)\)\s*$/);
  if (m) return m[1].split(',').map(x => parseFloat(x.trim().replace(/f$/, '')));
  if (/^\s*new float\[\s*\d+\s*\]\s*$/.test(expr)) return null; // 占位
  return null;
}

function parseGt(expr) {
  const m = expr.match(/^\s*[jk]\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*([\s\S]+?)\)\s*$/);
  if (!m) return null;
  const [, category, code, model, restRaw] = m;
  let ub = null; let inner = restRaw.trim();
  const hm = inner.match(/,\s*h\(\s*([\d.]+)f\s*,\s*([\d.]+)f\s*\)\s*$/);
  if (hm) { ub = { low: parseFloat(hm[1]), high: parseFloat(hm[2]) }; inner = inner.slice(0, hm.index); }
  const arrs = splitTop(inner.trim(), '(', ')').filter(p => p.trim().length > 0);
  return {
    category, code, model,
    curveA: arrs.length > 0 ? parseFloatArray(arrs[0].trim()) : null,
    curveB: arrs.length > 1 ? parseFloatArray(arrs[1].trim()) : null,
    range: ub,
  };
}

const brands = []; let pos = 0;
while (true) {
  const start = body.indexOf('new c4(', pos);
  if (start < 0) break;
  let depth = 0, end = -1;
  for (let i = start; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) break;
  const block = body.slice(start, end);
  const nameM = block.match(/new c4\(\s*"([^"]*)"/);
  const gtM = block.match(/new gt\[\]\{([\s\S]*)\}/);
  const devices = [];
  if (gtM) {
    for (const gp of splitTop(gtM[1], '(', ')').filter(p => p.trim().length > 0)) {
      const d = parseGt(gp.trim());
      if (d) devices.push(d);
    }
  }
  brands.push({ brand: nameM ? nameM[1] : 'unknown', devices });
  pos = end;
}
fs.writeFileSync(outPath, JSON.stringify(brands, null, 1), 'utf8');
console.log(`saved ${outPath}: ${brands.length} brands / ${brands.reduce((n, b) => n + b.devices.length, 0)} devices`);
