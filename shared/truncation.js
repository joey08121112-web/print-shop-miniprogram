// 字段级截断与容量上限（独立模块，供测试与后续接入方共用）。
// 云函数独立部署，业务文件仍内联相同字面量；test/truncation.test.js 会对照源码强制一致。

/** 订单/用户相关字符串字段上限（字符，非字节） */
const FIELD_CAPS = {
  fileName: 80,      // 云存储文件名（入库展示用）
  fileID: 200,       // cloud:// 文件 ID
  fileId: 40,        // 文件条目 id（客户端生成，入库截断）
  printRange: 100,   // 打印范围串，如 "1-3,5"
  pickupTime: 50,    // 取件时间文案，如 "今天 14:00"
  address: 100,
  phone: 20,
  remark: 200,
  nickname: 20,
  avatarFileID: 200,
  helperFileName: 120, // print-helper 本地落盘文件名
  notifyThing: 20      // 微信订阅消息 thing 类字段
};

/** 订单/请求条数上限 */
const LIST_CAPS = {
  maxFilesPerOrder: 20,
  maxPendingOrders: 5,
  maxCopiesPerFile: 999,
  maxOrdersCustomerPage: 50,
  maxOrdersAdminApi: 100,
  maxAvatarTempUrls: 50
};

/** 按结构安全截断：超长时在 max 字符处切开，不抛错；null/undefined → 空串 */
function truncate(value, max) {
  const s = value == null ? '' : String(value);
  if (!(max > 0)) return '';
  return s.length <= max ? s : s.substring(0, max);
}

/** 截断到 max，超长时加省略号标记（总长仍 ≤ max+1 时仅加 …；展示层用） */
function truncateWithEllipsis(value, max) {
  const s = truncate(value, max);
  const raw = value == null ? '' : String(value);
  return raw.length > max ? s + '…' : s;
}

module.exports = {
  FIELD_CAPS,
  LIST_CAPS,
  truncate,
  truncateWithEllipsis
};
