#!/usr/bin/env node
// ============================================================================
// 计价一致性测试
//
// 背景：「怎么算钱」的公式在 4 个文件里各有一份（复制粘贴关系）：
//   cloudfunctions/createOrder/index.js   下单时服务端算价
//   cloudfunctions/updateOrder/index.js   小程序管理页核款时重算
//   cloudfunctions/adminApi/index.js      网页后台核款时重算
//   pages/home/home.js                    学生端实时预览
// 本测试从这 4 份源码中直接抠出真实实现做比对——改了价目表或公式后跑一下：
//
//     node test/pricing.test.js
//
// 全部一致输出 OK；任何一份漏改/改错即失败并指出是哪个文件（退出码 1）。
// 另用 README 里的手工算例做锚点，防止「四份一起改错」也查不出来。
// 无第三方依赖，Node 直接运行。
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const PRICE_SOURCES = {
  'createOrder': path.join(ROOT, 'cloudfunctions/createOrder/index.js'),
  'updateOrder': path.join(ROOT, 'cloudfunctions/updateOrder/index.js'),
  'adminApi': path.join(ROOT, 'cloudfunctions/adminApi/index.js'),
  'home(学生端)': path.join(ROOT, 'pages/home/home.js')
};
const RANGE_SERVER_SOURCES = {
  'createOrder': PRICE_SOURCES['createOrder'],
  'updateOrder': PRICE_SOURCES['updateOrder'],
  'adminApi': PRICE_SOURCES['adminApi']
};

let failures = 0;

function fail(msg) {
  failures++;
  console.error('  ❌ ' + msg);
}

function pass(msg) {
  console.log('  ✅ ' + msg);
}

// 从源码按花括号配对抠出函数定义文本（不执行业务代码，因此无需安装 wx-server-sdk）
function extractFunction(src, name) {
  const m = src.match(new RegExp(name + '\\s*\\('));
  if (!m) throw new Error(`未找到函数 ${name}`);
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, j + 1);
    }
  }
  throw new Error(`函数 ${name} 花括号不闭合`);
}

function loadFn(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const text = extractFunction(src, name);
  // 云函数里是 function 声明；home.js 里是 Page({}) 的对象方法简写 → 包成对象取出
  const fn = text.startsWith('function ')
    ? new Function(`return (${text})`)()
    : new Function(`return ({ ${text} })`)()[name];
  if (typeof fn !== 'function') throw new Error(`${file} 中的 ${name} 无法解析为函数`);
  return fn;
}

// ---- 1. README 算例锚点：以 createOrder 的实现为基准，核对文档承诺的价格 ----
console.log('[1] README 手工算例锚点');
const refPrice = loadFn(PRICE_SOURCES['createOrder'], 'calculateFilePrice');
const anchors = [
  { desc: '黑白单面 3页×1份', args: [3, 1, false, false], expect: 0.75 },
  { desc: '黑白单面 3页×2份', args: [3, 2, false, false], expect: 1.5 },
  { desc: '彩色双面 26页×1份', args: [26, 1, true, true], expect: 10.4 },
  { desc: '黑白单面 26页×3份', args: [26, 3, false, false], expect: 19.5 },
  { desc: '黑白双面 5页×1份（余数单页）', args: [5, 1, false, true], expect: 2 * 0.4 + 0.25 },
  { desc: '彩色双面 7页×2份', args: [7, 2, true, true], expect: (3 * 0.8 + 0.5) * 2 }
];
for (const a of anchors) {
  const got = refPrice(...a.args);
  if (Math.abs(got - a.expect) < 1e-9) pass(`${a.desc} = ¥${a.expect.toFixed(2)}`);
  else fail(`${a.desc}：期望 ¥${a.expect.toFixed(2)}，实际 ¥${got.toFixed(2)} —— 价目表与 README 是否已同步？`);
}

// ---- 2. 四份 calculateFilePrice 全矩阵比对 ----
console.log('[2] calculateFilePrice 四处实现一致性');
const priceImpls = {};
for (const [label, file] of Object.entries(PRICE_SOURCES)) {
  priceImpls[label] = loadFn(file, 'calculateFilePrice');
}
let priceCases = 0;
let priceDrift = [];
for (let pages = 1; pages <= 40; pages++) {
  for (const copies of [1, 2, 3, 5]) {
    for (const color of [false, true]) {
      for (const doubleSided of [false, true]) {
        const expect = refPrice(pages, copies, color, doubleSided);
        priceCases++;
        for (const [label, fn] of Object.entries(priceImpls)) {
          if (label === 'createOrder') continue;
          const got = fn(pages, copies, color, doubleSided);
          if (Math.abs(got - expect) > 1e-9) {
            priceDrift.push(`${label}: ${pages}页×${copies}份 color=${color} double=${doubleSided} 得 ${got}，基准 ${expect}`);
          }
        }
      }
    }
  }
}
if (priceDrift.length === 0) pass(`${priceCases} 组参数 × 4 处实现全部一致`);
else priceDrift.slice(0, 10).forEach(d => fail(d));

// ---- 3. 三份服务端 parsePrintRange 一致性 ----
console.log('[3] parsePrintRange 服务端三处一致性');
const rangeImpls = {};
for (const [label, file] of Object.entries(RANGE_SERVER_SOURCES)) {
  rangeImpls[label] = loadFn(file, 'parsePrintRange');
}
const RANGE_CASES = ['', ' ', '3', '2-10', '1,3,5-7', '1，3', '0', '5-2', '-1', 'abc', '2-', '-2', '1--3', '1-,3', '99999-100000'];
let rangeDrift = [];
for (const c of RANGE_CASES) {
  const baseline = JSON.stringify(rangeImpls['createOrder'](c));
  for (const [label, fn] of Object.entries(rangeImpls)) {
    if (label === 'createOrder') continue;
    if (JSON.stringify(fn(c)) !== baseline) {
      rangeDrift.push(`范围 "${c}"：${label} 与 createOrder 结果不同`);
    }
  }
}
if (rangeDrift.length === 0) pass(`${RANGE_CASES.length} 种范围写法 × 3 处服务端实现全部一致`);
else rangeDrift.forEach(d => fail(d));

// ---- 4. 学生端预览与服务端在「合法范围」上口径一致（服务端更严属预期，如拒绝 0 页）----
console.log('[4] 学生端范围解析口径（合法场景）');
const homeRange = loadFn(PRICE_SOURCES['home(学生端)'], 'parsePrintRange');
const VALID_CASES = ['3', '2-10', '1,3,5-7', '1，3', '20-25'];
let homeDrift = [];
for (const c of VALID_CASES) {
  const server = rangeImpls['createOrder'](c);
  const client = homeRange(c);
  if (!(client.valid === true && client.printPages === server.printPages)) {
    homeDrift.push(`范围 "${c}"：服务端 ${server.printPages} 页，客户端 valid=${client.valid}/${client.printPages} 页`);
  }
}
if (homeDrift.length === 0) pass(`${VALID_CASES.length} 种合法范围，学生端显示的实际打印页数与服务端一致`);
else homeDrift.forEach(d => fail(d));

// ---- 汇总 ----
console.log('');
if (failures > 0) {
  console.error(`结果：${failures} 处不一致。请检查上面标 ❌ 的文件，保持四处计价逻辑同步。`);
  process.exit(1);
}
console.log('结果：全部通过 ✅（四处计价实现与 README 价目表完全一致）');
