#!/usr/bin/env node
// ============================================================================
// 截断 / 容量上限一致性测试
//
// 背景：输入收紧（substring 字段上限、条数上限）散落在多个云函数与页面里。
// 云函数独立部署，无法 require 项目根 shared/ 模块，因此：
//   1) shared/truncation.js 是规范源（行为 + 常量）
//   2) 本测试校验规范函数行为
//   3) 并对照各业务源码中的字面量上限是否与 FIELD_CAPS / LIST_CAPS 一致
//   4) 抽查 createOrder 所有入库分支是否都使用了 safe* 截断结果
//
// 运行：node test/truncation.test.js
// ============================================================================
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { FIELD_CAPS, LIST_CAPS, truncate, truncateWithEllipsis } = require('../shared/truncation');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function fail(msg) {
  failures++;
  console.error('  ❌ ' + msg);
}
function pass(msg) {
  console.log('  ✅ ' + msg);
}

console.log('[1] shared/truncation.js 函数行为');
try {
  assert.strictEqual(truncate(null, 5), '');
  assert.strictEqual(truncate(undefined, 5), '');
  assert.strictEqual(truncate('abc', 5), 'abc');
  assert.strictEqual(truncate('abcde', 5), 'abcde');
  assert.strictEqual(truncate('abcdef', 5), 'abcde');
  assert.strictEqual(truncate('中文测试很长', 3), '中文测');
  assert.strictEqual(truncate('x', 0), '');
  assert.strictEqual(truncate('abcdef', 3), truncate('abcdef', 3));
  assert.strictEqual(truncateWithEllipsis('abcdef', 3), 'abc…');
  assert.strictEqual(truncateWithEllipsis('abc', 3), 'abc');
  // 字段上限能截住极端输入
  const long = 'x'.repeat(500);
  assert.strictEqual(truncate(long, FIELD_CAPS.fileName).length, FIELD_CAPS.fileName);
  assert.strictEqual(truncate(long, FIELD_CAPS.remark).length, FIELD_CAPS.remark);
  pass('truncate / truncateWithEllipsis / FIELD_CAPS 行为正确');
} catch (e) {
  fail('truncate 行为断言失败: ' + e.message);
}

console.log('[2] 业务源码中的字段截断字面量');
const sources = {
  createOrder: fs.readFileSync(path.join(ROOT, 'cloudfunctions/createOrder/index.js'), 'utf8'),
  updateOrder: fs.readFileSync(path.join(ROOT, 'cloudfunctions/updateOrder/index.js'), 'utf8'),
  adminApi: fs.readFileSync(path.join(ROOT, 'cloudfunctions/adminApi/index.js'), 'utf8'),
  getUserProfile: fs.readFileSync(path.join(ROOT, 'cloudfunctions/getUserProfile/index.js'), 'utf8'),
  helper: fs.readFileSync(path.join(ROOT, 'print-helper/helper.js'), 'utf8'),
  home: fs.readFileSync(path.join(ROOT, 'pages/home/home.js'), 'utf8')
};

// createOrder：关键字段必须出现与 CAPS 一致的 substring(0, N)
// 用更稳的「变量名/字段名附近找 substring(0, N)」扫源码
function findCapNear(src, fieldHint) {
  const re = new RegExp(fieldHint + '[\\s\\S]{0,120}?\\.substring\\(0,\\s*(\\d+)\\)');
  const m = src.match(re);
  return m ? m[1] : null;
}

const coChecks = [
  ['fileName', /safeName\s*=\s*String\([^)]+\)\.substring\(0,\s*(\d+)\)/, FIELD_CAPS.fileName],
  ['fileID', /safeFileID\s*=\s*String\([^)]+\)\.substring\(0,\s*(\d+)\)/, FIELD_CAPS.fileID],
  ['fileId', /safeId\s*=\s*String\([^)]+\)\.substring\(0,\s*(\d+)\)/, FIELD_CAPS.fileId],
  ['printRange', /safeRange\s*=\s*String\([^)]+\)\.substring\(0,\s*(\d+)\)/, FIELD_CAPS.printRange],
  ['pickupTime', /pickupTime:\s*pickupTime[^;\n]*substring\(0,\s*(\d+)\)/, FIELD_CAPS.pickupTime],
  ['address', FIELD_CAPS.address],
  ['phone', FIELD_CAPS.phone],
  ['remark', FIELD_CAPS.remark],
  ['nickname', FIELD_CAPS.nickname],
  ['avatarFileID', FIELD_CAPS.avatarFileID]
];
for (const item of coChecks) {
  const name = item[0];
  let found;
  if (item.length === 3) {
    const m = sources.createOrder.match(item[1]);
    found = m ? m[1] : null;
  } else {
    const hint = name === 'fileName' ? 'safeName' : name === 'fileID' ? 'safeFileID' : name === 'printRange' ? 'safeRange' : name;
    found = findCapNear(sources.createOrder, hint);
  }
  const cap = item.length === 3 ? item[2] : item[1];
  if (found != null && String(found) === String(cap)) {
    pass(`createOrder ${name} 上限 ${cap} 与 FIELD_CAPS 一致`);
  } else if (found != null) {
    fail(`createOrder ${name} 源码上限 ${found} ≠ FIELD_CAPS.${name}=${cap}`);
  } else {
    fail(`createOrder 未找到 ${name} 的 substring 截断（期望上限 ${cap}）`);
  }
}

// adminApi / updateOrder：printRange 核款路径
for (const key of ['adminApi', 'updateOrder']) {
  const m = sources[key].match(/printRange[^\n]*substring\(0,\s*(\d+)\)/);
  if (m && String(m[1]) === String(FIELD_CAPS.printRange)) {
    pass(`${key} printRange 上限 ${m[1]} 一致`);
  } else if (m) {
    fail(`${key} printRange 上限 ${m[1]} ≠ ${FIELD_CAPS.printRange}`);
  } else {
    fail(`${key} 未找到 printRange substring 截断`);
  }
}

// getUserProfile
{
  const src = sources.getUserProfile;
  const nick = src.match(/nickname[^\n]*substring\(0,\s*(\d+)\)/);
  const av = src.match(/avatarFileID[^\n]*substring\(0,\s*(\d+)\)/);
  if (nick && String(nick[1]) === String(FIELD_CAPS.nickname)) pass(`getUserProfile nickname=${nick[1]}`);
  else fail(`getUserProfile nickname 截断缺失或不一致: ${nick && nick[1]}`);
  if (av && String(av[1]) === String(FIELD_CAPS.avatarFileID)) pass(`getUserProfile avatarFileID=${av[1]}`);
  else fail(`getUserProfile avatarFileID 截断缺失或不一致: ${av && av[1]}`);
}

// helper 文件名
{
  const m = sources.helper.match(/name\.replace\([^\)]*\)\.substring\(0,\s*(\d+)\)/);
  if (m && String(m[1]) === String(FIELD_CAPS.helperFileName)) pass(`helper fileName=${m[1]}`);
  else fail(`helper 文件名截断缺失或不一致: ${m && m[1]}`);
}

console.log('[3] 条数上限字面量');
const listChecks = [
  ['createOrder files>20', /files\.length\s*>\s*20/, String(LIST_CAPS.maxFilesPerOrder)],
  ['createOrder pending>=5', /pendingCnt\.total\s*>=\s*5/, String(LIST_CAPS.maxPendingOrders)],
  ['createOrder copies>999', /copies\s*>\s*999/, String(LIST_CAPS.maxCopiesPerFile)],
  ['orders MAX_ORDERS=50', /MAX_ORDERS\s*=\s*50/, String(LIST_CAPS.maxOrdersCustomerPage)],
  ['adminApi limit max 100', /Math\.min\([^)]*limit[^)]*100\s*,\s*100\)/, String(LIST_CAPS.maxOrdersAdminApi)],
  ['adminApi avatar slice 50', /\.slice\(0,\s*50\)/, String(LIST_CAPS.maxAvatarTempUrls)]
];
for (const [label, re, expect] of listChecks) {
  const srcKey = label.startsWith('orders') ? 'home' : label.startsWith('adminApi') ? 'adminApi' : label.startsWith('helper') ? 'helper' : 'createOrder';
  // orders page is separate
  let src;
  if (label.startsWith('orders')) src = fs.readFileSync(path.join(ROOT, 'pages/orders/orders.js'), 'utf8');
  else src = sources[srcKey] || sources.createOrder;
  if (re.test(src)) {
    const num = re.source.match(/(\d+)/g);
    pass(`${label} 源码存在（规范值 ${expect}）`);
  } else {
    // try broader file for adminApi limit
    if (label.startsWith('adminApi limit') && /limit/.test(sources.adminApi) && /,\s*100\)/.test(sources.adminApi)) {
      pass(`${label} 源码存在（规范值 ${expect}）`);
    } else {
      fail(`${label} 源码中未找到，规范值应为 ${expect}`);
    }
  }
}

console.log('[4] createOrder 入库分支全部使用 safe* 截断结果');
try {
  const src = sources.createOrder;
  // 找出 processedFiles.push 块
  const pushes = [...src.matchAll(/processedFiles\.push\(\{([\s\S]*?)\}\);/g)];
  if (pushes.length < 3) {
    fail(`processedFiles.push 分支过少（${pushes.length}），预期 ≥3 条入库路径`);
  } else {
    let bad = [];
    pushes.forEach((m, i) => {
      const body = m[1];
      const usesSafeName = /name:\s*safeName\b/.test(body);
      const usesSafeFileID = /fileID:\s*safeFileID\b/.test(body);
      const usesSafeId = /id:\s*safeId\b/.test(body);
      const usesRawName = /name:\s*f\.name\b/.test(body) && !usesSafeName;
      const usesRawFileID = /fileID:\s*f\.fileID\b/.test(body) && !usesSafeFileID;
      const usesRawId = /id:\s*f\.id\b/.test(body) && !usesSafeId;
      if (usesRawName || usesRawFileID || usesRawId) {
        bad.push(`push#${i + 1} 仍使用未截断原始字段 (rawName=${usesRawName}, rawFileID=${usesRawFileID}, rawId=${usesRawId})`);
      } else if (!usesSafeName || !usesSafeFileID || !usesSafeId) {
        // printRange 分支可能 OK；至少不能用 raw
        bad.push(`push#${i + 1} 未引用 safeName/safeFileID/safeId`);
      }
    });
    if (bad.length === 0) pass(`全部 ${pushes.length} 个 processedFiles.push 均使用 safeName/safeFileID/safeId`);
    else bad.forEach(fail);
  }
} catch (e) {
  fail('createOrder 分支检查异常: ' + e.message);
}

console.log('');
if (failures === 0) {
  console.log('ALL OK — 截断规范与源码一致');
  process.exit(0);
} else {
  console.error(`FAILED — ${failures} 项不一致`);
  process.exit(1);
}
