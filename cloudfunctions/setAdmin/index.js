// 云函数入口文件 - setAdmin
// 用于设置用户为管理员（仅在初始化时使用一次）
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { targetOpenid, secretKey } = event;

  // 安全验证：只有知道密钥的人才能设置管理员
  // 请在云函数环境变量中设置 ADMIN_SECRET_KEY
  const validSecretKey = process.env.ADMIN_SECRET_KEY;

  if (!validSecretKey) {
    return {
      code: -1,
      message: '未配置 ADMIN_SECRET_KEY，已拒绝设置管理员'
    };
  }

  if (secretKey !== validSecretKey) {
    return {
      code: -1,
      message: '密钥错误，无权执行此操作'
    };
  }

  try {
    // 查找目标用户
    const userResult = await db.collection('users').where({
      _openid: targetOpenid || openid
    }).get();

    if (userResult.data.length === 0) {
      return {
        code: -1,
        message: '用户不存在，请先使用小程序登录'
      };
    }

    // 更新用户角色为管理员
    await db.collection('users').doc(userResult.data[0]._id).update({
      data: {
        role: 'admin'
      }
    });

    return {
      code: 0,
      message: '管理员设置成功',
      openid: targetOpenid || openid
    };
  } catch (err) {
    return {
      code: -1,
      message: err.message
    };
  }
};
