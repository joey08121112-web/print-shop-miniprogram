// 云函数：createOrder
// 服务端计算价格，防止客户端篡改
// PDF 页数服务端自动解析：仅当用户未手动核对页数（isEstimated=true）时，用解析结果覆盖；
// 用户手动改过的页数一律尊重（可能是只打印部分页）
// 注意：解析 PDF 需要下载文件，建议在云开发控制台把本函数超时时间调到 20 秒
const cloud = require('wx-server-sdk');
const { PDFDocument } = require('pdf-lib');

// PDF 解析超时保护：超过 2.5 秒放弃自动解析，保证 createOrder 主体能在 3 秒内返回
const PDF_PARSE_TIMEOUT_MS = 2500;
// 多个 PDF 串行解析的总预算：耗尽后剩余 PDF 直接跳过解析（按缺页数处理），
// 防止「解析总耗时 + 挪目录耗时」超过云端函数超时，导致整个下单请求被掐断
const PDF_PARSE_TOTAL_BUDGET_MS = 8000;

// ===== 订阅消息模板 ID =====
// 环境变量优先（控制台配置了就用控制台的）；否则用下面引号里的值。
// 拿到模板 ID 后直接填进引号即可，无需去控制台配环境变量。
// 模板「备忘录任务提醒」：任务编号=character_string7、任务名称=thing1、提醒时间=time4
const TPL_ORDER = process.env.SUBSCRIBE_TEMPLATE_ID_ORDER || 'esqwD6QCpY6TF0H_BW0d-nWMpyYffKava45krI1-qNQ'; // 下单成功

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// ===== 定价规则（和服务端一致）=====
// 黑白单面：0.25 元/页
// 彩色单面：0.5 元/页
// 黑白双面：0.4 元/张（每张 2 页）+ 剩余单页 0.25
// 彩色双面：0.8 元/张（每张 2 页）+ 剩余单页 0.5
// 计价：printPages(实际打印页数) × copies(份数) × 单页价
function calculateFilePrice(printPages, copies, color, doubleSided) {
  const copiesN = Math.max(1, parseInt(copies) || 1);
  let unit;
  if (doubleSided) {
    const sheets = Math.floor(printPages / 2);
    const remaining = printPages % 2;
    const doubleRate = color ? 0.8 : 0.4;
    const singleRate = color ? 0.5 : 0.25;
    unit = (sheets * doubleRate) + (remaining * singleRate);
  } else {
    const rate = color ? 0.5 : 0.25;
    unit = printPages * rate;
  }
  return Math.round(unit * copiesN * 100) / 100;
}

// 解析打印范围（服务端权威，仅做格式校验，不校验是否超过总页数：范围即顾客打印意图，直接采用）
// 返回 { printPages, error }；无范围时 printPages 为 null（调用方按「打印全部」处理）
function parsePrintRange(rangeStr) {
  const tokens = String(rangeStr || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return { printPages: null, error: null };
  let total = 0;
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      const n = parseInt(tok);
      if (n < 1) return { error: `页码 ${n} 无效（须≥1）` };
      total += 1;
    } else {
      const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
      if (!m) return { error: `打印范围格式有误：${tok}` };
      const a = parseInt(m[1]), b = parseInt(m[2]);
      if (a < 1 || a > b) return { error: `打印范围 ${tok} 无效` };
      total += (b - a + 1);
    }
  }
  return { printPages: total, error: null };
}

// 解析 PDF 实际页数，失败返回 null（不影响下单，保持用户填的页数）
async function tryParsePdfPages(fileID, name) {
  if (!fileID || !/\.pdf$/i.test(name || '')) return null;
  try {
    const res = await cloud.downloadFile({ fileID });
    const doc = await PDFDocument.load(res.fileContent, { ignoreEncryption: true });
    const count = doc.getPageCount();
    return count >= 1 ? count : null;
  } catch (err) {
    console.warn('PDF 页数解析失败:', name, err.message);
    return null;
  }
}

// 带超时的 PDF 解析：超过 2.5 秒放弃，保证 createOrder 主体能在 3 秒内返回
// 超时时清除 timer；正常完成时清除 timer；异常分支也要清除（避免内存泄漏）
function parsePdfWithTimeout(fileID, name, timeoutMs) {
  let timer = null;
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
  });
  const workPromise = tryParsePdfPages(fileID, name).then(
    pages => ({ __timeout: false, pages }),
    err => ({ __timeout: false, pages: null, err })
  );
  return Promise.race([timeoutPromise, workPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// 订阅消息 time 字段要求的格式：「2026年8月22日 10:30」（斜杠格式会被微信拒收）
function fmtTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 统一北京时间
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 发送订阅消息（下单/核价/打印完成/取消）。模板 ID 见文件顶部 TPL_*（环境变量可覆盖），未配置则跳过。
async function sendSubscribe(openid, templateId, data, page) {
  if (!templateId || !openid) return false;
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: templateId,
      page: page || 'pages/orders/orders',
      data: data
    });
    return true;
  } catch (err) {
    console.warn('订阅消息发送失败（不影响主流程）:', err.message);
    return false;
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const { files, delivery, pickupMode, pickupTime, remark, address, phone } = event;

  // 参数校验
  if (!Array.isArray(files) || files.length === 0) {
    return { code: -1, message: '请上传至少一个文件' };
  }
  if (files.length > 20) {
    return { code: -1, message: '一次最多 20 个文件' };
  }

  // 防灌单：同一用户最多 5 笔待处理订单（待核价/待付款都算），防止恶意刷单撑爆后台
  try {
    const pendingCnt = await db.collection('orders').where({ _openid: openid, status: 'pending' }).count();
    if (pendingCnt.total >= 5) {
      return { code: -1, message: '您有多笔订单待处理，请等老板核价完成后再下单' };
    }
  } catch (e) { /* 统计失败不阻断下单 */ }

  // 取件方式校验
  const validPickupMode = pickupMode === 'delivery' || pickupMode === 'pickup' ? pickupMode : (delivery ? 'delivery' : '');
  if (!validPickupMode) {
    return { code: -1, message: '请选择取件方式' };
  }

  // 店主休息中：服务端兜底拦截（网页后台「休息中」写入 settings/shop.open=false）。
  // 小程序首页的提示只是前端拦截，页面停留中的顾客仍可能提交订单，必须以服务端为准；
  // settings 集合未建 / 读取失败 → 按营业中处理（查询故障不阻断生意，与 getShopStatus 口径一致）
  try {
    const shopRes = await db.collection('settings').doc('shop').get();
    if (shopRes.data && shopRes.data.open === false) {
      return { code: -1, message: '店主休息中，暂停接单，请营业后再下单' };
    }
  } catch (err) {
    // 读取失败视为营业中
  }

  // 配送订单必须有地址和手机号
  const useDelivery = validPickupMode === 'delivery';
  if (useDelivery) {
    if (!address || !String(address).trim()) {
      return { code: -1, message: '请填写配送地址' };
    }
    if (!phone || !String(phone).trim()) {
      return { code: -1, message: '请填写手机号' };
    }
  }

  // 逐个文件校验并重新算价
  // 计价规则（范围优先）：
  //  - 顾客填了打印范围 → 直接按范围页数计价，无需总页数（老板也不用填页数）
  //  - 顾客没填范围（打全部）→ 需要总页数（PDF 服务端自动识别；Word/图片等老板核款时填）
  const processedFiles = [];
  let subtotal = 0;
  let priceAdjusted = false;
  let orderPricePending = false;
  const parseBudgetStart = Date.now();

  for (const f of files) {
    // 轻校验：fileID 必须是本云存储的文件（cloud:// 前缀），防止下单时引用外部或他人上传的资源
    if (f.fileID && !String(f.fileID).startsWith('cloud://')) {
      return { code: -1, message: `文件「${f.name || '未命名'}」的存储标识无效，请删除后重新上传` };
    }
    const copies = Math.max(1, parseInt(f.copies) || 1);
    if (copies > 999) {
      return { code: -1, message: '份数超出限制（单文件最多 999 份），如有特殊需求请联系店主' };
    }
    // 输入收紧：截断超长字符串，防构造超大单据（数据库单文档有大小上限）
    const safeName = String(f.name || '未知文件').substring(0, 80);
    const safeFileID = String(f.fileID || '').substring(0, 200);
    const safeRange = String(f.printRange || '').substring(0, 100);
    const safeId = String(f.id || '').substring(0, 40);
    const color = !!f.color;
    const doubleSided = !!f.doubleSided;

    // 解析打印范围（仅格式校验，不校验是否超过总页数）
    const rangeRes = parsePrintRange(f.printRange);
    if (rangeRes.error) {
      return { code: -1, message: `文件「${f.name}」${rangeRes.error}` };
    }
    const hasRange = rangeRes.printPages !== null;

    // 总页数（顾客/PDF 自动识别给出；未填则为 null）
    let pages = (f.pages !== null && f.pages !== undefined && f.pages !== '' && !isNaN(parseInt(f.pages))) ? parseInt(f.pages) : null;
    let autoParsed = false;
    let pdfParseSkipped = false;

    // 仅在「无范围 + 缺页数」时才需要服务端自动解析 PDF 页数（PDF 自动识别精确）
    if (!hasRange && pages === null && f.isEstimated && /\.pdf$/i.test(f.name || '')) {
      if (Date.now() - parseBudgetStart > PDF_PARSE_TOTAL_BUDGET_MS) {
        pdfParseSkipped = true; // 总预算耗尽：跳过解析，按缺页数留给老板核款时人工填
        console.warn('PDF 解析总预算耗尽，已跳过:', f.name);
      } else {
        const result = await parsePdfWithTimeout(f.fileID, f.name, PDF_PARSE_TIMEOUT_MS);
        if (result.__timeout) {
          pdfParseSkipped = true;
          console.warn('PDF 解析超时，已跳过:', f.name);
        } else if (result.pages) {
          if (pages !== null && result.pages !== pages) priceAdjusted = true;
          pages = result.pages;
          autoParsed = true;
        }
      }
    }

    // 有范围 → 记录顾客的打印意图（printRange + printPages），但仍需老板核价后最终确认价格
    // 原因：手机上页数可能不准，且老板需要核对范围是否合理；核款时 recalcPrice 会按范围优先直接算价
    if (hasRange) {
      const printPages = rangeRes.printPages;
      orderPricePending = true;
      processedFiles.push({
        id: safeId,
        name: safeName,
        fileID: safeFileID,
        pages: null,
        copies: copies,
        color: color,
        doubleSided: doubleSided,
        price: 0,
        printRange: safeRange,
        printPages: printPages,
        isEstimated: true,
        pricePending: true,
        pdfParseSkipped: false
      });
      continue;
    }

    // 无范围 → 打印全部，需要总页数
    if (pages === null) {
      orderPricePending = true;
      processedFiles.push({
        id: safeId,
        name: safeName,
        fileID: safeFileID,
        pages: null,
        copies: copies,
        color: color,
        doubleSided: doubleSided,
        price: 0,
        printRange: '',
        printPages: null,
        isEstimated: true,
        pricePending: true,
        pdfParseSkipped: false
      });
      continue;
    }

    const price = calculateFilePrice(pages, copies, color, doubleSided);
    subtotal += price;
    processedFiles.push({
      id: safeId,
      name: safeName,
      fileID: safeFileID,
      pages: pages,
      copies: copies,
      color: color,
      doubleSided: doubleSided,
      price: Math.round(price * 100) / 100, // 避免浮点精度问题
      printRange: '',
      printPages: pages,
      isEstimated: autoParsed ? false : !!f.isEstimated,
      pricePending: false,
      pdfParseSkipped: pdfParseSkipped
    });
  }

  // 配送费：满 10 元免配送费（自取免费）；价格待定时先不计费，待 recalcPrice 重算
  const deliveryFee = (useDelivery && !orderPricePending) ? (subtotal < 10 ? 1 : 0) : 0;
  const totalPrice = orderPricePending ? null : Math.round((subtotal + deliveryFee) * 100) / 100;

  // 读取下单人头像昵称，冗余写入订单（自取订单老板靠昵称认人；改名不影响历史订单）
  let customer = { nickname: '', avatarFileID: '' };
  try {
    const userRes = await db.collection('users').where({ _openid: openid }).get();
    if (userRes.data.length > 0) {
      customer = {
        nickname: String(userRes.data[0].nickname || '').substring(0, 20),
        avatarFileID: String(userRes.data[0].avatarFileID || '').substring(0, 200)
      };
    }
  } catch (err) {
    console.warn('读取用户昵称失败（不影响下单）:', err.message);
  }

  try {
    const addRes = await db.collection('orders').add({
      data: {
        _openid: openid,
        customer: customer,
        files: processedFiles,
        delivery: useDelivery,
        deliveryFee: deliveryFee,
        totalPrice: totalPrice,
        pricePending: orderPricePending,
        pickupMode: validPickupMode,
        pickupTime: pickupTime ? String(pickupTime).trim().substring(0, 50) : '',
        address: useDelivery ? String(address).trim().substring(0, 100) : '',
        phone: useDelivery ? String(phone).trim().substring(0, 20) : '',
        remark: (remark || '').substring(0, 200),
        status: 'pending',
        paymentStatus: 'unpaid',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });

    // ===== 把仍留在 pending/ 预览目录的文件挪到正式目录 =====
    // 下单前顾客预览时 PDF 传在 print-files/pending/，订单会长期引用它；
    // 挪到 print-files/order/ 后，pending/ 里剩下的就都是「传了但没下单」的可清理残留。
    // 安全顺序：先传新 → 改订单指向 → 删旧，任一步失败都保持旧文件可用（清理逻辑有订单引用保护兜底）。
    const movedOldIDs = []; // 挪成功的旧 fileID（订单更新后统一删除）
    const moveStart = Date.now();
    for (const pf of processedFiles) {
      if (Date.now() - moveStart > 8000) break; // 时间预算：大文件拖慢下单就放弃，留给清理兜底
      const oldID = pf.fileID;
      if (!oldID || !oldID.includes('/pending/')) continue;
      try {
        const dl = await cloud.downloadFile({ fileID: oldID });
        const parts = String(oldID).replace(/^cloud:\/\//, '').split('/');
        const newPath = parts.slice(1).join('/').replace('/pending/', '/order/');
        const up = await cloud.uploadFile({ cloudPath: newPath, fileContent: dl.fileContent });
        movedOldIDs.push(oldID);
        pf.fileID = up.fileID;
      } catch (e) {
        console.warn('文件挪目录失败（保留原 pending 文件，不影响订单）:', oldID, e.message);
      }
    }
    // 订单已入库：挪目录/改指向一旦失败不能让整个下单报错——
    // 否则客户端显示「下单失败」但订单实际已存在，用户重试会产生重复订单。
    // 失败时订单仍指向 pending/ 旧文件，清理函数有订单引用保护，不会误删。
    try {
      if (movedOldIDs.length > 0) {
        // 订单先指向新文件，确认更新成功后才删 pending/ 里的旧文件
        await db.collection('orders').doc(addRes._id).update({
          data: { files: processedFiles, updatedAt: db.serverDate() }
        });
        await cloud.deleteFile({ fileList: movedOldIDs }).catch(() => {});
      }
    } catch (postErr) {
      console.warn('下单后挪目录失败（订单已创建，不影响使用）:', postErr.message);
    }

    // 下单成功通知（订阅消息，模板未配置则跳过）——「备忘录任务提醒」字段编号
    await sendSubscribe(openid, TPL_ORDER, {
      character_string7: { value: addRes._id.slice(-6).toUpperCase() },
      thing1: { value: '订单已提交，等待核款' },
      time4: { value: fmtTime() }
    });

    return {
      code: 0,
      message: '下单成功',
      orderId: addRes._id,   // 供客户端展示「转账备注 #后6位」对账号
      totalPrice: totalPrice,
      // pricePending=true 表示有文件未提供页数，需老板核款时填真实页数重算价格
      pricePending: orderPricePending,
      // priceAdjusted=true 表示有 PDF 被服务端按实际页数重新核价，客户端可据此提示用户
      priceAdjusted: priceAdjusted,
      // pdfParseSkipped=true 表示有 PDF 因解析超时未自动核对，客户端需提示用户自行核对页数
      pdfParseSkipped: processedFiles.some(f => f.pdfParseSkipped),
      files: processedFiles.map(f => ({ name: f.name, pages: f.pages, price: f.price, pricePending: f.pricePending }))
    };
  } catch (err) {
    console.error('创建订单失败:', err);
    return { code: -1, message: '下单失败，请重试' };
  }
};
