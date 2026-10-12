App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    wx.cloud.init({
      env: '替换成你的云环境ID', // 开通云开发后改成你的环境 ID（形如 cloud1-xxxxxx）
      traceUser: true
    });

    // 合并调用：一次云函数同时获取 openid + 用户资料
    this._initUser();
  },

  globalData: {
    openid: '',
    userInfo: null,
    isAdmin: false,
    ready: false
  },

  // ready 回调队列 — 页面注册回调等待 globalData 就绪
  _readyCallbacks: [],

  // 页面调用此方法，globalData 就绪后立即执行回调
  onReady(callback) {
    if (this.globalData.ready) {
      callback(this.globalData);
    } else {
      this._readyCallbacks.push(callback);
    }
  },

  _notifyReady() {
    this.globalData.ready = true;
    this._readyCallbacks.forEach(cb => cb(this.globalData));
    this._readyCallbacks = [];
  },

  _initUser() {
    wx.cloud.callFunction({
      name: 'login',
      success: res => {
        const { openid, userInfo, isAdmin } = res.result;
        this.globalData.openid = openid;
        this.globalData.userInfo = userInfo;
        this.globalData.isAdmin = isAdmin;
        console.log('用户就绪:', openid, isAdmin ? '(管理员)' : '');
        this._notifyReady();
      },
      fail: err => {
        console.error('登录失败:', err);
        // 失败也标记 ready，让页面可以正常降级
        this._notifyReady();
      }
    });
  }
});
