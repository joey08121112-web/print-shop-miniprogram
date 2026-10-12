// 云函数入口文件 - updateOrder
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

// ===== 订阅消息模板 ID =====
// 环境变量优先（控制台配置了就用控制台的）；否则用下面引号里的值。
// 拿到模板 ID 后直接填进引号即可，无需去控制台配环境变量。
// 「审核结果通知」：工单号=character_string3、备注=thing7、通知时间=time9
// 「会议通知」：    会议内容=thing5、时间=time2、地点=thing3
// 「行程提醒」：    行程名称=thing2、地点=thing6、计划时间=time3
const TPL_PRICE = process.env.SUBSCRIBE_TEMPLATE_ID_PRICE || 'IuwLBfln0tbBgtYPxNwb0MlQ3yboqGskhDDMBPDCXIk';   // 核价完成·待支付（审核结果通知）
const TPL_READY = process.env.SUBSCRIBE_TEMPLATE_ID || 'Hwfd_N2xvrUZ3XSuNnaDQ-a3eCPKNeDSmwQAAdeX3UI';         // 打印完成·可取（会议通知）
const TPL_CANCEL = process.env.SUBSCRIBE_TEMPLATE_ID_CANCEL || 'acRg2KnTv0ST1f0lBIAFjUtOQ8SUgDctsBELAB-HgB8'; // 订单取消（行程提醒）

// ===== 定价规则（与 createOrder 一致）=====
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

// 解析打印范围：仅做格式校验（范围即顾客打印意图，直接采用，不再校验是否超过总页数）
// 返回 { printPages, error }；无范围时 printPages 为 null（调用方决定按全部处理）
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

const NEXT_STATUS = {
  pending: 'processing',
  processing: 'ready',
  ready: 'delivered'
};

const VALID_ACTIONS = ['advanceStatus', 'confirmPayment', 'cancelOrder', 'queryAllOrders', 'userCancelOrder', 'recalcPrice'];

// 订阅消息 time 字段要求的格式：「2026年8月22日 10:30」（斜杠格式会被微信拒收）
function fmtTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 统一北京时间
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 通用订阅消息发送（模板未配置 / openid 缺失则跳过，不影响主流程）
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

// 打印完成（可取/可配送）通知 ——「会议通知」字段：会议内容=thing5、时间=time2、地点=thing3
async function sendReadyNotify(order, orderId) {
  if (!TPL_READY || !order._openid) return;
  await sendSubscribe(order._openid, TPL_READY, {
    thing5: { value: '打印完成，可以取件了' },
    time2: { value: fmtTime() },
    thing3: { value: order.pickupMode === 'delivery' ? String(order.address || '配送上门').substring(0, 20) : '到店自取' }
  });
}

// 核款计价（事务化）：事务内重读订单 → 按范围/页数重算 → 一次性写回价格相关字段。
// 有打印范围就按范围计价（不用填页数）；无范围（打全部）才需填总页数。重算最终价并清 pricePending。
// 返回 { rejected } 或 { ok, order, files, anyPending, totalPrice }
async function recalcPriceTransaction(orderId, data) {
  return db.runTransaction(async t => {
    const orderRef = t.collection('orders').doc(orderId);
    const orderRes = await orderRef.get();
    const order = orderRes.data;
    if (!order) return { rejected: '订单不存在' };
    // 已取消/已完成的订单不再核价：防止给顾客发「请付款」通知、改动已成定局的价格
    if (order.status === 'cancelled') return { rejected: '订单已取消，无需核价' };
    if (order.status === 'delivered') return { rejected: '订单已完成，不能改价' };

    const recalcFiles = (data && data.files) || [];
    if (!Array.isArray(recalcFiles) || recalcFiles.length === 0) {
      return { rejected: '缺少文件页数' };
    }

    const files = (order.files || []).map(of => {
      const rf = recalcFiles.find(x => x.id === of.id);
      if (!rf) return of;
      // 老板可在核价时纠正彩黑/单双面（学生常选错）；未传则沿用原值
      const color = (rf.color === undefined || rf.color === null) ? !!of.color : !!rf.color;
      const doubleSided = (rf.doubleSided === undefined || rf.doubleSided === null) ? !!of.doubleSided : !!rf.doubleSided;
      const printRange = String((rf.printRange !== undefined && rf.printRange !== null) ? rf.printRange : (of.printRange || '')).substring(0, 100);
      const pages = parseInt(rf.pages, 10);
      const rangeRes = parsePrintRange(printRange);
      if (rangeRes.error) {
        return { ...of, printRange, pricePending: true, rangeError: rangeRes.error };
      }
      // 有范围 → 直接按范围计价，老板无需填总页数
      if (rangeRes.printPages !== null) {
        const printPages = rangeRes.printPages;
        const price = calculateFilePrice(printPages, of.copies, color, doubleSided);
        return {
          ...of,
          pages: pages || of.pages || null,
          printRange,
          printPages,
          color,
          doubleSided,
          price: Math.round(price * 100) / 100,
          pricePending: false,
          isEstimated: false,
          rangeError: null
        };
      }
      // 无范围 → 打印全部，需要老板填总页数
      if (!pages || pages < 1) {
        return { ...of, pages: pages || null, printRange, pricePending: true, rangeError: null };
      }
      const price = calculateFilePrice(pages, of.copies, color, doubleSided);
      return {
        ...of,
        pages,
        printRange,
        printPages: pages,
        color,
        doubleSided,
        price: Math.round(price * 100) / 100,
        pricePending: false,
        isEstimated: false,
        rangeError: null
      };
    });

    const anyPending = files.some(f => f.pricePending);
    const subtotal = anyPending ? 0 : files.reduce((s, f) => s + (f.price || 0), 0);
    // 加收/优惠（可正可负，非法值按 0 处理）；未传时沿用订单已存的值，防止二次核价把之前的优惠清零
    const rawAdjustment = data ? data.adjustment : undefined;
    const adjustmentNum = (rawAdjustment === undefined || rawAdjustment === null || rawAdjustment === '') ? NaN : Number(rawAdjustment);
    const prevAdjustment = Number.isFinite(Number(order.adjustment)) ? Math.round(Number(order.adjustment) * 100) / 100 : 0;
    const adjustment = Number.isFinite(adjustmentNum) ? Math.round(adjustmentNum * 100) / 100 : prevAdjustment;
    // 配送费覆盖：传入合法的 ≥0 数字时采用老板指定值；未传/非法则维持自动逻辑（自取 0，配送且小计<10 收 1）
    const rawDeliveryFee = data ? data.deliveryFee : undefined;
    const deliveryFeeNum = (rawDeliveryFee === undefined || rawDeliveryFee === null || rawDeliveryFee === '') ? NaN : Number(rawDeliveryFee);
    const autoDeliveryFee = (order.pickupMode === 'delivery' && !anyPending) ? (subtotal < 10 ? 1 : 0) : 0;
    const deliveryFee = (Number.isFinite(deliveryFeeNum) && deliveryFeeNum >= 0)
      ? Math.round(deliveryFeeNum * 100) / 100
      : autoDeliveryFee;
    // 合计最低 0 元：大额优惠不允许把总价打成负数
    const totalPrice = anyPending ? null : Math.max(0, Math.round((subtotal + deliveryFee + adjustment) * 100) / 100);

    await orderRef.update({
      data: { files, totalPrice, deliveryFee, adjustment, pricePending: anyPending, updatedAt: db.serverDate() }
    });
    return { ok: true, order, files, anyPending, totalPrice };
  });
}

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { orderId, action, data } = event;

  try {
    if (!VALID_ACTIONS.includes(action)) {
      return {
        code: -1,
        message: '参数错误'
      };
    }

    // queryAllOrders 不需要 orderId
    if (action !== 'queryAllOrders' && (!orderId || typeof orderId !== 'string')) {
      return {
        code: -1,
        message: '缺少订单ID'
      };
    }

    // 普通用户取消自己的 pending 订单（不需要管理员权限）
    // 事务化：读-判-写打包，防止与老板端「确认收款/推进状态」并发操作时互相覆盖
    if (action === 'userCancelOrder') {
      const txResult = await db.runTransaction(async t => {
        const orderRef = t.collection('orders').doc(orderId);
        const orderRes = await orderRef.get();
        const order = orderRes.data;
        if (!order) return { rejected: '订单不存在' };
        if (order._openid !== openid) return { rejected: '无权取消此订单' };
        if (order.status !== 'pending') return { rejected: '该订单已开始处理，无法取消' };
        // 已确认收款的订单钱已到店家微信，顾客不能单方面取消（防止「钱收了、单没了」的退款扯皮）
        if (order.paymentStatus === 'confirmed') {
          return { rejected: '订单已确认收款，如需取消请联系店家' };
        }
        await orderRef.update({
          data: { status: 'cancelled', updatedAt: db.serverDate() }
        });
        return { ok: true };
      });
      if (txResult.rejected) return { code: -1, message: txResult.rejected };
      return { code: 0, message: '已取消' };
    }

    // 检查是否为管理员
    const userResult = await db.collection('users').where({
      _openid: openid
    }).get();

    if (userResult.data.length === 0 || userResult.data[0].role !== 'admin') {
      return {
        code: -1,
        message: '无权限执行此操作'
      };
    }

    // 查询所有订单（仅管理员；offset 分页供管理页「加载更多」）
    if (action === 'queryAllOrders') {
      const limit = Math.min(data && data.limit || 50, 100);
      const offset = Math.max(0, parseInt(data && data.offset, 10) || 0);
      const ordersRes = await db.collection('orders')
        .orderBy('createdAt', 'desc')
        .skip(offset)
        .limit(limit)
        .get();
      return { code: 0, data: ordersRes.data };
    }

    // ===== 以下动作全部事务化：事务内重读订单做状态检查并写入，提交成功后再发订阅消息 =====
    // （不在事务内做外部调用；手机管理页 / 网页后台 / 顾客端三方并发同一订单时不会互相覆盖）

    let txResult;
    if (action === 'recalcPrice') {
      txResult = await recalcPriceTransaction(orderId, data);
    } else {
      txResult = await db.runTransaction(async t => {
        const orderRef = t.collection('orders').doc(orderId);
        const orderRes = await orderRef.get();
        const order = orderRes.data;
        if (!order) return { rejected: '订单不存在' };

        const updateData = {
          updatedAt: db.serverDate()
        };

        if (action === 'advanceStatus') {
          const nextStatus = data && data.nextStatus;
          if (NEXT_STATUS[order.status] !== nextStatus) {
            return { rejected: '不允许的状态流转' };
          }
          // 未确认收款不允许从待核价推进到打印中（防止漏收款直接开印）
          if (order.status === 'pending' && nextStatus === 'processing' && order.paymentStatus !== 'confirmed') {
            return { rejected: '尚未确认收款，不能开始打印' };
          }
          updateData.status = nextStatus;
          // 完成时间：网页端今日营业额按完成时间统计
          if (nextStatus === 'delivered') {
            updateData.deliveredAt = db.serverDate();
          }
        } else if (action === 'confirmPayment') {
          // 已取消的订单不能再确认收款（单都没了，不存在收款）
          if (order.status === 'cancelled') {
            return { rejected: '订单已取消，无需确认收款' };
          }
          // 未核价的订单不能确认收款（金额没定，收了也对不上账）
          if (order.pricePending) {
            return { rejected: '订单尚未核价，请先核款计价' };
          }
          if (order.paymentStatus === 'confirmed') {
            return { ok: true, idempotent: true, order };
          }
          updateData.paymentStatus = 'confirmed';
        } else if (action === 'cancelOrder') {
          if (order.status === 'delivered') {
            return { rejected: '已完成订单不能取消' };
          }
          // 已取消的订单重复取消：幂等返回，不再改写、不再重发取消通知
          if (order.status === 'cancelled') {
            return { ok: true, idempotent: true, order };
          }
          updateData.status = 'cancelled';
        }

        await orderRef.update({ data: updateData });
        return { ok: true, order, updateData };
      });
    }

    if (txResult.rejected) {
      return { code: -1, message: txResult.rejected };
    }
    const order = txResult.order;

    // 核价成功 → 待支付通知（仅当价格已确定，可支付时才发）——「审核结果通知」字段编号
    if (action === 'recalcPrice') {
      const { files, anyPending, totalPrice } = txResult;
      if (!anyPending) {
        await sendSubscribe(order._openid, TPL_PRICE, {
          character_string3: { value: orderId.slice(-6).toUpperCase() },
          thing7: { value: '核价完成，请付款' },
          time9: { value: fmtTime() }
        });
      }
      const pendingFiles = files.filter(f => f.pricePending).map(f => ({
        name: f.name,
        reason: f.rangeError ? f.rangeError : '未填总页数'
      }));
      const message = anyPending
        ? `以下文件未能核价：${pendingFiles.map(p => `${p.name}（${p.reason}）`).join('、')}`
        : `价格已更新 ¥${totalPrice.toFixed(2)}`;
      return { code: 0, totalPrice, pricePending: anyPending, pendingFiles, message };
    }

    // 推进到「待领取」时，给用户发取件通知
    if (action === 'advanceStatus' && txResult.updateData.status === 'ready') {
      await sendReadyNotify(order, orderId);
    }

    // 管理员取消订单 → 给用户发取消通知（幂等取消时不重发）——「行程提醒」字段：行程名称=thing2、地点=thing6、计划时间=time3
    if (action === 'cancelOrder' && !txResult.idempotent) {
      await sendSubscribe(order._openid, TPL_CANCEL, {
        thing2: { value: '订单已取消' },
        thing6: { value: order.pickupMode === 'delivery' ? String(order.address || '配送上门').substring(0, 20) : '到店自取' },
        time3: { value: fmtTime() }
      });
    }

    // 幂等确认收款（重复点击时友好返回，不报错）
    if (action === 'confirmPayment' && txResult.idempotent) {
      return { code: 0, message: '收款已确认' };
    }

    return {
      code: 0,
      message: '更新成功'
    };
  } catch (err) {
    return {
      code: -1,
      message: err.message
    };
  }
};
