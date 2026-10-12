const app = getApp();

const STATUS_CONFIG = {
  pending: { label: '待核价', color: '#f59e0b', bgColor: 'rgba(245,158,11,0.08)', desc: '老板核价后会通知你付款' },
  processing: { label: '打印中', color: '#3b82f6', bgColor: 'rgba(59,130,246,0.08)', desc: '文件正在高速打印中' },
  ready: { label: '待领取', color: '#FF6700', bgColor: 'rgba(255,103,0,0.08)', desc: '打印已完成，请取件' },
  delivered: { label: '已完成', color: '#22c55e', bgColor: 'rgba(34,197,94,0.08)', desc: '感谢您的支持' },
  cancelled: { label: '已取消', color: '#9ca3af', bgColor: 'rgba(156,163,175,0.08)', desc: '订单已关闭' }
};

const STATUS_STEPS = [
  { status: 'pending', label: '审核', est: '尽快' },
  { status: 'processing', label: '打印', est: '稍候' },
  { status: 'ready', label: '取件', est: '随时' },
  { status: 'delivered', label: '完成', est: '完成' }
];

const MAX_ORDERS = 50;

Page({
  data: {
    orders: [],
    loading: true,
    statusConfig: STATUS_CONFIG,
    statusSteps: STATUS_STEPS
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateTabBar();
      this.getTabBar().setData({ selected: 1 });
    }
    this.loadOrders();
  },

  loadOrders() {
    if (!app.globalData.openid) {
      // 等待 ready，最多等 5 秒
      if (!this._retryCount) this._retryCount = 0;
      if (this._retryCount >= 10) {
        this._retryCount = 0;
        this.setData({ loading: false });
        wx.showToast({ title: '加载超时，请下拉刷新', icon: 'none' });
        return;
      }
      this._retryCount++;
      setTimeout(() => this.loadOrders(), 500);
      return;
    }

    this._retryCount = 0;

    const db = wx.cloud.database();
    db.collection('orders')
      .where({ _openid: app.globalData.openid })
      .orderBy('createdAt', 'desc')
      .limit(MAX_ORDERS)
      .get()
      .then(res => {
        const orders = res.data.map(order => {
          const config = STATUS_CONFIG[order.status] || STATUS_CONFIG.pending;
          const currentStepIndex = STATUS_STEPS.findIndex(s => s.status === order.status);
          const isCancelled = order.status === 'cancelled';

          let createdAtStr = '';
          if (order.createdAt) {
            const date = new Date(order.createdAt);
            createdAtStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
          }

          const files = (order.files || []).map(f => ({
            ...f,
            priceStr: f.pricePending ? '待定' : (f.price ? f.price.toFixed(2) : '0.00'),
            printPagesStr: f.printPages || f.pages || '?'
          }));

          // 按订单号哈希固定选一张收款码：同一订单刷新/重进不变，避免顾客付款途中「码变了」
          // （两张码均有效；首页支付弹窗仍是下单时随机二选一）
          let qrIndex = 0;
          if (order._id) {
            let h = 0;
            for (let i = 0; i < order._id.length; i++) h = (h * 31 + order._id.charCodeAt(i)) >>> 0;
            qrIndex = h % 2;
          }

          return {
            ...order,
            config,
            currentStepIndex,
            isCancelled,
            createdAtStr,
            files,
            totalPriceStr: order.totalPrice ? order.totalPrice.toFixed(2) : '0.00',
            orderIdShort: order._id ? order._id.slice(-6).toUpperCase() : '------',
            // 已取消的订单不再出现任何收款引导（码、待核价提示、待收款徽标）
            paymentLabel: order.paymentStatus === 'confirmed' ? '支付已确认' : (isCancelled ? '订单已取消' : '待老板确认收款'),
            paymentColor: order.paymentStatus === 'confirmed' ? '#22c55e' : (isCancelled ? '#9ca3af' : '#f59e0b'),
            // 付款二维码：价格已确定且尚未确认收款时展示，供「核价成功」通知跳转后扫码转账
            showPayQr: !isCancelled && !order.pricePending && order.paymentStatus !== 'confirmed' && order.totalPrice > 0,
            payQrUrl: qrIndex === 0 ? '/images/qrcode0.png' : '/images/qrcode1.png'
          };
        });

        this.setData({ orders, loading: false });
      })
      .catch(err => {
        console.error('获取订单失败:', err);
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败', icon: 'none' });
      });
  },

  cancelOrder(e) {
    const orderId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '取消订单',
      content: '确定取消该订单吗？取消后需重新下单。',
      success: async (res) => {
        if (res.confirm) {
          try {
            const callRes = await wx.cloud.callFunction({
              name: 'updateOrder',
              data: { orderId, action: 'userCancelOrder' }
            });
            const result = callRes.result || {};
            if (result.code !== 0) {
              wx.showToast({ title: result.message || '取消失败', icon: 'none' });
              return;
            }
            wx.showToast({ title: '已取消' });
            this.loadOrders();
          } catch (err) {
            wx.showToast({ title: err.errMsg || '取消失败', icon: 'none' });
          }
        }
      }
    });
  },

  onPullDownRefresh() {
    this.loadOrders();
    wx.stopPullDownRefresh();
  }
});
