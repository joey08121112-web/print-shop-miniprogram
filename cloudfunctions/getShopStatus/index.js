// 云函数：getShopStatus
// 读取营业状态（小程序首页调用）：settings 集合里 shop 文档的 open 字段
// 老板在网页后台切换「营业中/休息中」→ adminApi 的 setShopStatus 写入
// 无记录 / 集合未建 / 读取失败 → 一律视为营业中（查询故障不阻断生意）
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  try {
    const res = await db.collection('settings').doc('shop').get();
    return { code: 0, open: res.data ? res.data.open !== false : true };
  } catch (err) {
    return { code: 0, open: true };
  }
};
