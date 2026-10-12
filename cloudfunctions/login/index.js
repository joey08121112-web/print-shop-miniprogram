// 云函数入口文件 - login
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

// 云函数入口函数 — 同时返回 openid 和用户资料，减少一次网络请求
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  let userInfo = null;
  let isAdmin = false;

  try {
    const userRes = await db.collection('users').where({ _openid: openid }).get();
    if (userRes.data.length > 0) {
      userInfo = userRes.data[0];
      isAdmin = userInfo.role === 'admin';
    } else {
      // 新用户，自动创建
      // 如果并发调用导致重复插入，后面的 re-query 会取到已有的那条，不影响功能
      try {
        await db.collection('users').add({
          // 云函数端 add 不自动写 _openid（显式写入，不依赖平台的未文档化注入）
          data: { _openid: openid, role: 'user', createdAt: db.serverDate() }
        });
      } catch (addErr) {
        console.warn('创建用户记录失败（可能已存在）:', addErr);
      }
      // 无论 add 是否成功，都重新查一次，确保拿到正确的用户记录
      const newUserRes = await db.collection('users').where({ _openid: openid }).get();
      if (newUserRes.data.length > 0) {
        userInfo = newUserRes.data[0];
        isAdmin = userInfo.role === 'admin';
      }
    }
  } catch (err) {
    console.error('获取用户资料失败:', err);
  }

  return {
    openid,
    userInfo,
    isAdmin
  };
};
