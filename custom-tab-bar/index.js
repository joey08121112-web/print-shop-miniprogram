const app = getApp();

Component({
  data: {
    selected: 0,
    list: []
  },

  attached() {
    this.updateTabBar();
  },

  pageLifetimes: {
    show() {
      this.updateTabBar();
    }
  },

  methods: {
    updateTabBar() {
      const isAdmin = app.globalData.isAdmin;
      const list = [
        { pagePath: '/pages/home/home', text: '首页', icon: 'home', iconActive: 'home-active' },
        { pagePath: '/pages/orders/orders', text: '我的订单', icon: 'orders', iconActive: 'orders-active' }
      ];
      if (isAdmin) {
        list.push({ pagePath: '/pages/admin/admin', text: '管理', icon: 'admin', iconActive: 'admin-active' });
      }
      this.setData({ list });
    },

    switchTab(e) {
      const url = e.currentTarget.dataset.path;
      wx.switchTab({ url });
    }
  }
});
