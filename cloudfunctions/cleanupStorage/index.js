// 云函数：cleanupStorage
// 定时清理云存储「孤儿文件」：预览阶段上传到 print-files/pending/ 但最终没下单的 PDF。
// 数据来源：pendingFiles 台账集合（首页上传 PDF 预览成功时登记 fileID + createdAt）。
// 清理规则（与 README 手动清理规则一致）：台账超过 7 天 且 fileID 不在任何订单中 → 删除文件；
// 若文件已被订单引用 → 只移出台账（文件由订单自身引用保护）。
// 触发：config.json 内置每日 04:30 定时触发器；也可在控制台手动调用查看统计。
// 注意：台账上线之前的存量孤儿文件无法被枚举，需按 README 说明手动清理一次。
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const RETENTION_DAYS = 7; // 台账记录超过该天数才参与清理
const MAX_BATCH = 50;     // 单次最多处理条数（控制执行时长；如需更大批量可在控制台调高本函数超时）

exports.main = async () => {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let cleaned = 0;   // 已删除的孤儿文件数
  let released = 0;  // 已被订单引用、仅移出台账的条数
  try {
    const oldRes = await db.collection('pendingFiles')
      .where({ createdAt: _.lt(cutoff) })
      .limit(MAX_BATCH)
      .get();
    const rows = oldRes.data || [];
    if (rows.length === 0) {
      return { code: 0, cleaned, released, message: '没有过期的待清理记录' };
    }

    const toDelete = []; // { rowId, fileID }
    for (const row of rows) {
      if (!row.fileID) {
        // 脏数据：直接清掉台账行
        await db.collection('pendingFiles').doc(row._id).remove();
        continue;
      }
      // 是否已被任何订单引用（files 为对象数组，点路径匹配任一元素的 fileID）
      const usedRes = await db.collection('orders').where({ 'files.fileID': row.fileID }).count();
      if (usedRes.total > 0) {
        // 文件受订单保护 → 只删台账，绝不动文件
        await db.collection('pendingFiles').doc(row._id).remove();
        released++;
        continue;
      }
      toDelete.push({ rowId: row._id, fileID: row.fileID });
    }

    if (toDelete.length > 0) {
      await cloud.deleteFile({ fileList: toDelete.map(x => x.fileID) });
      for (const x of toDelete) {
        await db.collection('pendingFiles').doc(x.rowId).remove();
      }
      cleaned = toDelete.length;
    }

    return {
      code: 0,
      scanned: rows.length,
      cleaned,
      released,
      message: `扫描 ${rows.length} 条：删除孤儿文件 ${cleaned} 个，释放已入单文件的台账 ${released} 条`
    };
  } catch (err) {
    console.error('cleanupStorage 执行失败:', err);
    return { code: -1, message: err.message };
  }
};
