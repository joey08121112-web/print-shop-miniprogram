const app = getApp();

const STATUS_LABELS = {
  pending: { label: '待核款', color: '#f59e0b', bgColor: 'rgba(245,158,11,0.1)' },
  processing: { label: '打印中', color: '#3b82f6', bgColor: 'rgba(59,130,246,0.1)' },
  ready: { label: '待领取', color: '#FF6700', bgColor: 'rgba(255,103,0,0.1)' },
  delivered: { label: '已完成', color: '#22c55e', bgColor: 'rgba(34,197,94,0.1)' },
  cancelled: { label: '已取消', color: '#9ca3af', bgColor: 'rgba(156,163,175,0.1)' }
};

const NEXT_STEP = {
  pending: 'processing',
  processing: 'ready',
  ready: 'delivered',
  delivered: null,
  cancelled: null
};

const PAGE_SIZE = 20;

Page({
  data: {
    orders: [],
    loading: true,
    isAdmin: false,
    statusLabels: STATUS_LABELS,
    hasMore: true,
    loadingMore: false,
    recalcInputs: {} // 核款计价时各文件实时填入的页数/范围，key = `${orderId}_${fileId}_pages|range`
  },

  _offset: 0,

  onLoad() {
    app.onReady((data) => {
      const isAdmin = data.isAdmin;
      this.setData({ isAdmin });
      if (isAdmin) {
        this._offset = 0;
        this.loadOrders();
      } else {
        this.setData({ loading: false });
      }
    });
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateTabBar();
      this.getTabBar().setData({ selected: 2 });
    }
    if (this.data.isAdmin) {
      this._offset = 0;
      this.loadOrders();
    }
  },

  loadOrders(append) {
    // 分页：offset 为已加载条数，翻页时向后取
    const offset = append ? this._offset : 0;
    if (!append) {
      this._offset = 0;
    }

    this.setData({ loadingMore: !!append });

    // 通过云函数查询，服务端验证管理员身份
    wx.cloud.callFunction({
      name: 'updateOrder',
      data: {
        action: 'queryAllOrders',
        data: { limit: PAGE_SIZE, offset: offset }
      }
    }).then(res => {
      if (res.result.code !== 0) {
        wx.showToast({ title: res.result.message || '加载失败', icon: 'none' });
        this.setData({ loading: false, loadingMore: false });
        return;
      }

      const newOrders = (res.result.data || []).map(order => {
        const label = STATUS_LABELS[order.status] || STATUS_LABELS.pending;
        const next = NEXT_STEP[order.status];
        const nextLabel = next ? STATUS_LABELS[next].label : '';

        let createdAtStr = '';
        if (order.createdAt) {
          const date = new Date(order.createdAt);
          createdAtStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        }

        const files = (order.files || []).map(f => ({
          ...f,
          priceStr: f.price ? f.price.toFixed(2) : '0.00'
        }));

        return {
          ...order,
          label,
          next,
          nextLabel,
          createdAtStr,
          files,
          pricePending: !!order.pricePending,
          totalPriceStr: order.totalPrice ? order.totalPrice.toFixed(2) : '0.00',
          orderIdShort: order._id ? order._id.slice(-6).toUpperCase() : '------'
        };
      });

      const orders = append ? this.data.orders.concat(newOrders) : newOrders;
      this._offset = orders.length;
      this.setData({
        orders: orders,
        loading: false,
        loadingMore: false,
        hasMore: newOrders.length === PAGE_SIZE
      });
    }).catch(err => {
      console.error('获取订单失败:', err);
      this.setData({ loading: false, loadingMore: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    });
  },

  // 加载更多
  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.loadOrders(true);
  },

  // 推进订单状态 — 通过云函数，服务端校验权限
  advanceStatus(e) {
    const { id, status } = e.currentTarget.dataset;
    const next = NEXT_STEP[status];
    if (!next) return;

    wx.showModal({
      title: '确认操作',
      content: `将订单状态推进为「${STATUS_LABELS[next].label}」？`,
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...' });
          wx.cloud.callFunction({
            name: 'updateOrder',
            data: { orderId: id, action: 'advanceStatus', data: { nextStatus: next } }
          }).then(res => {
            wx.hideLoading();
            if (res.result.code === 0) {
              wx.showToast({ title: '状态已更新', icon: 'success' });
              this._offset = 0;
              this.loadOrders();
            } else {
              wx.showToast({ title: res.result.message || '更新失败', icon: 'none' });
            }
          }).catch(err => {
            wx.hideLoading();
            console.error('更新失败:', err);
            wx.showToast({ title: '更新失败', icon: 'none' });
          });
        }
      }
    });
  },

  // 确认收款 — 通过云函数
  confirmPayment(e) {
    const { id } = e.currentTarget.dataset;

    wx.showModal({
      title: '确认收款',
      content: '确认已收到该订单的转账？',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...' });
          wx.cloud.callFunction({
            name: 'updateOrder',
            data: { orderId: id, action: 'confirmPayment' }
          }).then(res => {
            wx.hideLoading();
            if (res.result.code === 0) {
              wx.showToast({ title: '收款已确认', icon: 'success' });
              this._offset = 0;
              this.loadOrders();
            } else {
              wx.showToast({ title: res.result.message || '操作失败', icon: 'none' });
            }
          }).catch(err => {
            wx.hideLoading();
            console.error('确认收款失败:', err);
            wx.showToast({ title: '操作失败', icon: 'none' });
          });
        }
      }
    });
  },

  // 取消订单 — 通过云函数
  cancelOrder(e) {
    const { id } = e.currentTarget.dataset;

    wx.showModal({
      title: '取消订单',
      content: '确定要取消此订单吗？此操作不可撤销。',
      confirmColor: '#ef4444',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...' });
          wx.cloud.callFunction({
            name: 'updateOrder',
            data: { orderId: id, action: 'cancelOrder' }
          }).then(res => {
            wx.hideLoading();
            if (res.result.code === 0) {
              wx.showToast({ title: '订单已取消', icon: 'success' });
              this._offset = 0;
              this.loadOrders();
            } else {
              wx.showToast({ title: res.result.message || '操作失败', icon: 'none' });
            }
          }).catch(err => {
            wx.hideLoading();
            console.error('取消失败:', err);
            wx.showToast({ title: '操作失败', icon: 'none' });
          });
        }
      }
    });
  },

  // 查看文件（下载并预览）
  previewFile(e) {
    const { fileid, name } = e.currentTarget.dataset;
    if (!fileid) {
      wx.showToast({ title: '文件不存在', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '加载中...' });
    wx.cloud.downloadFile({
      fileID: fileid
    }).then(res => {
      wx.hideLoading();
      const filePath = res.tempFilePath;
      wx.openDocument({
        filePath: filePath,
        showMenu: true,
        fail: (err) => {
          console.error('打开文件失败:', err);
          wx.showToast({ title: '无法预览此文件', icon: 'none' });
        }
      });
    }).catch(err => {
      wx.hideLoading();
      console.error('下载文件失败:', err);
      wx.showToast({ title: '下载失败', icon: 'none' });
    });
  },

  // 核款计价：记录每个文件实时填入的页数/范围
  onRecalcPages(e) {
    const { orderid, fileid } = e.currentTarget.dataset;
    const key = `${orderid}_${fileid}_pages`;
    this.setData({ [`recalcInputs.${key}`]: e.detail.value });
  },

  onRecalcRange(e) {
    const { orderid, fileid } = e.currentTarget.dataset;
    const key = `${orderid}_${fileid}_range`;
    this.setData({ [`recalcInputs.${key}`]: e.detail.value });
  },

  // 核款计价：老板填真实页数后，调 recalcPrice 重算最终价格
  recalcPrice(e) {
    const { id: orderId } = e.currentTarget.dataset;
    const order = this.data.orders.find(o => o._id === orderId);
    if (!order) return;

    const inputs = this.data.recalcInputs;
    const files = (order.files || []).map(f => {
      const base = `${orderId}_${f.id}`;
      const pagesVal = inputs[`${base}_pages`];
      const rangeVal = inputs[`${base}_range`];
      return {
        id: f.id,
        pages: (pagesVal !== undefined && pagesVal !== '') ? pagesVal : (f.pages != null ? f.pages : ''),
        printRange: (rangeVal !== undefined) ? rangeVal : (f.printRange || '')
      };
    });

    wx.showLoading({ title: '核价中...' });
    wx.cloud.callFunction({
      name: 'updateOrder',
      data: { orderId, action: 'recalcPrice', data: { files } }
    }).then(res => {
      wx.hideLoading();
      if (res.result.code === 0) {
        const result = res.result;
        if (result.pricePending) {
          wx.showModal({
            title: '金额仍待定',
            content: result.message || '还有文件未填页数，请在文件行补齐页数后重新核款',
            showCancel: false
          });
        } else {
          wx.showToast({ title: result.message || '价格已更新', icon: 'success' });
        }
        this.loadOrders();
      } else {
        wx.showToast({ title: res.result.message || '核价失败', icon: 'none' });
      }
    }).catch(err => {
      wx.hideLoading();
      console.error('核款计价失败:', err);
      wx.showToast({ title: '核价失败', icon: 'none' });
    });
  },

  onPullDownRefresh() {
    if (this.data.isAdmin) {
      this._offset = 0;
      this.loadOrders();
    }
    wx.stopPullDownRefresh();
  },

  onReachBottom() {
    this.loadMore();
  }
});
