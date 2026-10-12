// 云函数入口文件 - getUserProfile
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

// 云函数入口函数
// 无 action / action='get'：查询（或创建）用户资料（原有行为）
// action='update'：保存顾客头像昵称（微信「头像昵称填写能力」提交的身份，
//                  自取订单老板靠昵称认人，createOrder 会冗余写进订单）
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  try {
    if (event.action === 'update') {
      const nickname = String(event.nickname || '').trim().substring(0, 20);
      if (!nickname) {
        return { code: -1, message: '昵称不能为空' };
      }
      const avatarFileID = String(event.avatarFileID || '').substring(0, 200);
      const userRes = await db.collection('users').where({ _openid: openid }).get();
      if (userRes.data.length === 0) {
        await db.collection('users').add({
          // 云函数端 add 不自动写 _openid（显式写入，不依赖平台的未文档化注入）
          data: { _openid: openid, role: 'user', nickname: nickname, avatarFileID: avatarFileID, createdAt: db.serverDate() }
        });
      } else {
        await db.collection('users').doc(userRes.data[0]._id).update({
          data: { nickname: nickname, avatarFileID: avatarFileID, updatedAt: db.serverDate() }
        });
      }
      const res = await db.collection('users').where({ _openid: openid }).get();
      return { code: 0, data: res.data[0] };
    }

    // 查询用户资料
    const userResult = await db.collection('users').where({
      _openid: openid
    }).get();

    if (userResult.data.length > 0) {
      return {
        code: 0,
        data: userResult.data[0]
      };
    } else {
      // 创建新用户（并发时可能重复，用 try-catch 容错）
      try {
        await db.collection('users').add({
          data: {
            _openid: openid,
            role: 'user',
            createdAt: db.serverDate()
          }
        });
      } catch (addErr) {
        console.warn('创建用户记录失败（可能已存在）:', addErr);
      }
      // 重新查询，确保返回正确的用户记录
      const res = await db.collection('users').where({ _openid: openid }).get();
      if (res.data.length > 0) {
        return { code: 0, data: res.data[0] };
      }
      return { code: -1, message: '创建用户失败' };
    }
  } catch (err) {
    return {
      code: -1,
      message: err.message
    };
  }
};
