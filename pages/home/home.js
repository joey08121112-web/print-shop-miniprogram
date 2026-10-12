const app = getApp();

// 订阅消息模板 ID（已在微信公众平台「订阅消息」选用并核实字段编号）：
//   order  → 备忘录任务提醒（下单成功）          字段: character_string7/thing1/time4
//   price  → 审核结果通知（核价成功/待支付）      字段: character_string3/thing7/time9
//   ready  → 会议通知（打印完成/可取可配送）      字段: thing5/time2/thing3
//   cancel → 行程提醒（取消订单）                 字段: thing2/thing6/time3
// 需与云函数环境变量一一对应；全部留空则跳过授权请求，不影响下单。
const SUBSCRIBE_TEMPLATES = {
  order: 'esqwD6QCpY6TF0H_BW0d-nWMpyYffKava45krI1-qNQ',
  price: 'IuwLBfln0tbBgtYPxNwb0MlQ3yboqGskhDDMBPDCXIk',
  ready: 'Hwfd_N2xvrUZ3XSuNnaDQ-a3eCPKNeDSmwQAAdeX3UI',
  cancel: 'acRg2KnTv0ST1f0lBIAFjUtOQ8SUgDctsBELAB-HgB8'
};

Page({
  data: {
    files: [],
    pickupMode: '',       // 'delivery' | 'pickup' | ''
    selectedTime: '',     // 选中的时间段，如 '14:00'
    timeSlots: [],        // 可选时间段列表
    address: '',          // 配送地址（配送必填）
    phone: '',            // 手机号（配送必填）
    remark: '',           // 备注
    paidAmount: 0,        // 下单成功后的实际金额（用于支付弹窗）
    priceAdjusted: false, // 服务端是否按 PDF 实际页数重新核价（用于支付弹窗提示）
    payQrIndex: 0,        // 随机选中的付款码
    payNoteId: '',        // 转账备注号（订单号后6位，方便老板对账）
    isSubmitting: false,
    showPaymentModal: false,
    isParsing: false,
    subtotal: 0,
    deliveryFee: 0,
    totalPrice: 0,
    totalBump: '', // 动效3：合计金额跳动标记（a/b 交替触发 CSS 动画）
    pricePending: false, // 有文件未定页数时，合计显示「待核款」
    isAdmin: false,
    shopClosed: false,   // 老板休息中（网页后台切换），为 true 时禁止下单
    profile: { nickname: '', avatarFileID: '' }, // 顾客微信身份（自取订单老板靠昵称认人）
    nicknameInput: '',
    tempAvatarPath: '',
    showProfileModal: false,
    savingProfile: false
  },

  onLoad() {
    app.onReady((data) => {
      this.setData({ isAdmin: data.isAdmin });
      this.syncProfile(data.userInfo);
      // 登录结果晚于首页渲染返回时刷新自定义 tabBar（管理入口按 isAdmin 动态显示）
      if (typeof this.getTabBar === 'function' && this.getTabBar()) {
        this.getTabBar().updateTabBar();
      }
    });
  },

  // 从全局用户资料同步昵称头像到身份卡
  syncProfile(userInfo) {
    if (userInfo && userInfo.nickname) {
      this.setData({
        profile: {
          nickname: String(userInfo.nickname).substring(0, 20),
          avatarFileID: userInfo.avatarFileID || ''
        }
      });
    }
  },

  onShow() {
    this.setData({ isAdmin: app.globalData.isAdmin });
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateTabBar();
      this.getTabBar().setData({ selected: 0 });
    }
    this.checkShopStatus();
  },

  // 查询营业状态（老板在网页后台切换「休息中」时禁止下单）；查询失败不阻断，默认营业中
  checkShopStatus() {
    wx.cloud.callFunction({
      name: 'getShopStatus'
    }).then(res => {
      const result = (res && res.result) || {};
      const open = result.code === 0 ? result.open !== false : true;
      this.setData({ shopClosed: !open });
    }).catch(() => {
      // 云函数未部署 / 网络失败：按营业中处理
    });
  },

  // 计算单个文件价格
  // 计价：printPages(实际打印页数) × copies(份数) × 单页价
  calculateFilePrice(printPages, copies, color, doubleSided) {
    const copiesN = Math.max(1, parseInt(copies) || 1);
    let unit;
    if (doubleSided) {
      const doubleSidedSheets = Math.floor(printPages / 2);
      const remainingPages = printPages % 2;
      const doubleRate = color ? 0.8 : 0.4;
      const singleRate = color ? 0.5 : 0.25;
      unit = (doubleSidedSheets * doubleRate) + (remainingPages * singleRate);
    } else {
      const singleRate = color ? 0.5 : 0.25;
      unit = printPages * singleRate;
    }
    return Math.round(unit * copiesN * 100) / 100;
  },

  // 重新计算总价
  recalculateTotal() {
    const files = this.data.files;
    const hasPending = files.some(f => f.pricePending);
    const subtotal = hasPending ? 0 : files.reduce((sum, f) => sum + (f.price || 0), 0);
    const deliveryFee = (this.data.pickupMode === 'delivery' && !hasPending) ? (subtotal < 10 ? 1 : 0) : 0;
    const totalPrice = hasPending ? null : subtotal + deliveryFee;
    // 动效3：合计金额变化时跳动一下（含「待核款」→ 有价的切换）
    const patch = { subtotal, deliveryFee, totalPrice, pricePending: hasPending };
    if (!hasPending && totalPrice !== null && totalPrice !== this.data.totalPrice) {
      patch.totalBump = this.data.totalBump === 'a' ? 'b' : 'a';
    }
    this.setData(patch);
  },

  // 解析打印范围（客户端预览用，与服务端同规则：页码须≥1；不做上限校验）
  // 返回 { printPages, valid, error }
  parsePrintRange(rangeStr) {
    if (!rangeStr || !String(rangeStr).trim()) return { printPages: null, valid: true, error: null };
    const tokens = String(rangeStr).split(/[,，]/).map(s => s.trim()).filter(Boolean);
    let total = 0;
    for (const tok of tokens) {
      if (/^\d+$/.test(tok)) {
        const n = parseInt(tok);
        if (n < 1) return { printPages: null, valid: false, error: `页码 ${tok} 无效（须≥1）` };
        total += 1;
      } else {
        const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
        if (!m) return { valid: false, error: `格式有误：${tok}` };
        const a = parseInt(m[1]), b = parseInt(m[2]);
        if (a < 1 || a > b) return { valid: false, error: `范围 ${tok} 无效` };
        total += (b - a + 1);
      }
    }
    return { printPages: total, valid: true, error: null };
  },

  // 给定文件（含 pages/printRange/color/doubleSided），重算 printPages 与 price
  // 范围优先：顾客填了打印范围 → 直接按范围计价（无需总页数）；无范围才需要总页数
  recomputeFile(f) {
    const parsed = this.parsePrintRange(f.printRange);
    if (parsed.error) {
      return { ...f, printPages: null, price: 0, pricePending: true, rangeError: parsed.error };
    }
    // 有范围 → 直接按范围计价（无需总页数）
    if (parsed.printPages !== null) {
      const price = this.calculateFilePrice(parsed.printPages, f.copies, f.color, f.doubleSided);
      return { ...f, printPages: parsed.printPages, price, pricePending: false, rangeError: null };
    }
    // 无范围 → 需要总页数
    const hasPages = f.pages !== null && f.pages !== undefined && f.pages !== '' && !isNaN(parseInt(f.pages));
    if (!hasPages) {
      return { ...f, printPages: null, price: 0, pricePending: true, rangeError: null };
    }
    const price = this.calculateFilePrice(parseInt(f.pages), f.copies, f.color, f.doubleSided);
    return { ...f, printPages: parseInt(f.pages), price, pricePending: false, rangeError: null };
  },

  // 选择文件
  chooseFile() {
    wx.chooseMessageFile({
      count: 9,
      type: 'file',
      extension: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'jpg', 'jpeg', 'png', 'bmp'],
      success: (res) => {
        this.setData({ isParsing: true });
        const newFiles = [];

        res.tempFiles.forEach(file => {
          let pages = 1;
          let isEstimated = true;

          // 计算文件扩展名与各展示属性
          const ext = file.name.split('.').pop().toLowerCase();
          const isImage = /\.(jpg|jpeg|png|bmp|gif|webp)$/i.test(file.name);
          let typeBadge = '';
          let badgeClass = '';
          if (ext === 'pdf') {
            typeBadge = 'PDF';
            badgeClass = 'pdf';
          } else if (ext === 'doc' || ext === 'docx') {
            typeBadge = 'DOC';
            badgeClass = 'doc';
          } else if (ext === 'ppt' || ext === 'pptx') {
            typeBadge = 'PPT';
            badgeClass = 'ppt';
          } else if (ext === 'xls' || ext === 'xlsx') {
            typeBadge = 'XLS';
            badgeClass = 'xls';
          }

          // 判断文件类型
          if (/\.(pdf)$/i.test(file.name)) {
            // PDF 先标需手动核对，随后客户端调 parsePdfPreview 自动回填真实页数
            pages = 1;
            isEstimated = true;
          } else if (isImage) {
            pages = 1;
            isEstimated = false;
          } else {
            // Word 或其他格式：默认不填页数，交由老板核款时确认（顾客无需数页数）
            pages = null;
            isEstimated = true;
          }

          newFiles.push({
            id: Math.random().toString(36).substr(2, 9),
            name: file.name,
            path: file.path,
            size: file.size,
            type: file.type,
            isImage: isImage,
            typeBadge: typeBadge,
            badgeClass: badgeClass,
            pages: pages,
            copies: 1,
            color: false,
            doubleSided: false,
            price: pages ? this.calculateFilePrice(pages, 1, false, false) : 0,
            isEstimated: isEstimated,
            printRange: '',
            printPages: pages,
            pricePending: !pages
          });
        });

        this.setData({
          files: [...this.data.files, ...newFiles],
          isParsing: false
        });
        this.recalculateTotal();

        // 对新加进来的 PDF 文件异步触发上传 + 页数解析（不阻塞用户操作）
        const pdfFiles = newFiles.filter(f => /\.pdf$/i.test(f.name));
        pdfFiles.forEach(f => this._uploadAndParsePdf(f));
        // 注：docx / 图片等非 PDF 文件不再自动解析页数，默认 1 页并标「需核对」，
        // 由用户手动输入真实页数（PDF 自动解析精确，故保留）。
      },
      fail: (err) => {
        console.log('选择文件取消或失败:', err);
        this.setData({ isParsing: false });
      }
    });
  },

  // 更新份数（+/- 按钮）；份数最小 1，不设上限
  updateFileCopies(e) {
    const { id, action } = e.currentTarget.dataset;
    const files = this.data.files.map(f => {
      if (f.id === id) {
        let copies = f.copies;
        if (action === 'minus') {
          if (copies <= 1) return f;
          copies = copies - 1;
        } else {
          copies = (copies || 0) + 1;
        }
        return { ...this.recomputeFile({ ...f, copies }), bumpAnim: f.bumpAnim === 'a' ? 'b' : 'a' };
      }
      return f;
    });
    this.setData({ files });
    this.recalculateTotal();
  },

  // 手动输入份数（实时）；空或非法值暂存为空，失焦时归一到 1
  inputFileCopies(e) {
    const { id } = e.currentTarget.dataset;
    const raw = e.detail.value;
    let n = parseInt(raw, 10);
    const val = (raw === '') ? '' : ((isNaN(n) || n < 1) ? 1 : n);
    const files = this.data.files.map(f => {
      if (f.id === id) return { ...this.recomputeFile({ ...f, copies: val }), bumpAnim: f.bumpAnim === 'a' ? 'b' : 'a' };
      return f;
    });
    this.setData({ files });
    this.recalculateTotal();
  },

  // 份数失焦：空/非法值归一到 1
  blurFileCopies(e) {
    const { id } = e.currentTarget.dataset;
    const raw = e.detail.value;
    let n = parseInt(raw, 10);
    const val = (raw === '' || isNaN(n) || n < 1) ? 1 : n;
    const files = this.data.files.map(f => {
      if (f.id === id) {
        const bump = val !== f.copies ? { bumpAnim: f.bumpAnim === 'a' ? 'b' : 'a' } : {};
        return { ...this.recomputeFile({ ...f, copies: val }), ...bump };
      }
      return f;
    });
    this.setData({ files });
    this.recalculateTotal();
  },

  // 切换彩色/黑白
  toggleColor(e) {
    const { id } = e.currentTarget.dataset;
    const files = this.data.files.map(f => {
      if (f.id === id) {
        const color = !f.color;
        return { ...this.recomputeFile({ ...f, color }), bumpAnim: f.bumpAnim === 'a' ? 'b' : 'a' };
      }
      return f;
    });
    this.setData({ files });
    this.recalculateTotal();
  },

  // 切换单面/双面
  toggleDoubleSided(e) {
    const { id } = e.currentTarget.dataset;
    const files = this.data.files.map(f => {
      if (f.id === id) {
        const doubleSided = !f.doubleSided;
        return { ...this.recomputeFile({ ...f, doubleSided }), bumpAnim: f.bumpAnim === 'a' ? 'b' : 'a' };
      }
      return f;
    });
    this.setData({ files });
    this.recalculateTotal();
  },

  // 输入打印范围（实时解析并提示实际打印页数 / 格式错误）
  inputPrintRange(e) {
    const { id } = e.currentTarget.dataset;
    const val = e.detail.value;
    const files = this.data.files.map(f => f.id === id ? this.recomputeFile({ ...f, printRange: val }) : f);
    this.setData({ files });
    this.recalculateTotal();
  },

  // 删除文件
  removeFile(e) {
    const { id } = e.currentTarget.dataset;
    const files = this.data.files.filter(f => f.id !== id);
    this.setData({ files });
    this.recalculateTotal();
  },

  // 异步上传 + 解析 PDF 页数（不阻塞用户操作）
  // 失败 / 超时给用户轻量 toast 提示（用 wx.nextTick 推到下一 tick，避免与 setData 冲突）
  async _uploadAndParsePdf(f) {
    try {
      console.log('[PDF-PARSE] 进入 _uploadAndParsePdf, f.name=', f.name, 'f.id=', f.id, 'f.path存在=', !!f.path);
      // 1) 上传到云存储（pending 目录，与下单目录区分，便于垃圾清理）
      let uploadRes;
      try {
        console.log('[PDF-PARSE] 开始上传文件, cloudPath=', `print-files/pending/${f.id}_${f.name}`);
        uploadRes = await wx.cloud.uploadFile({
          cloudPath: `print-files/pending/${f.id}_${f.name}`,
          filePath: f.path
        });
        console.log('[PDF-PARSE] 上传成功 fileID前20=', String(uploadRes.fileID).slice(0, 20));
      } catch (uploadErr) {
        console.error('[PDF-PARSE] 上传失败 err=', uploadErr);
        console.warn('PDF 上传失败:', f.name, uploadErr);
        wx.nextTick(() => {
          wx.showToast({ title: '文件上传失败，请重试', icon: 'none' });
        });
        return;
      }
      f.fileID = uploadRes.fileID;

      // 登记到 pendingFiles 台账：供云端 cleanupStorage 定时清理「没下单的孤儿文件」
      this._registerPendingFile(uploadRes.fileID);

      // 2) 调 parsePdfPreview 解析页数
      console.log('[PDF-PARSE] callFunction parsePdfPreview, fileID=', uploadRes.fileID);
      const parseRes = await wx.cloud.callFunction({
        name: 'parsePdfPreview',
        data: { fileID: uploadRes.fileID }
      });
      console.log('[PDF-PARSE] parseRes.result = ', JSON.stringify(parseRes.result));

      // 3) 成功且有页数 → 回写 pages + isEstimated=false，并用 recomputeFile 同步刷新价格/打印页数
      const result = (parseRes && parseRes.result) || {};
      if (result.code === 0 && result.pages) {
        console.log('[PDF-PARSE] 回写 pages=', result.pages, 'f.id=', f.id);
        const files = this.data.files.map(x => x.id === f.id
          ? this.recomputeFile({
              ...x,
              pages: result.pages,
              isEstimated: false,
              fileID: uploadRes.fileID
            })
          : x);
        this.setData({ files });
        this.recalculateTotal();
      } else {
        console.error('[PDF-PARSE] 解析失败/超时 result=', JSON.stringify(result));
        // 解析失败 / 超时：至少把 fileID 记下，handleOrder 不用重复上传
        const files = this.data.files.map(x => x.id === f.id ? { ...x, fileID: uploadRes.fileID } : x);
        this.setData({ files });
        if (result.timedOut) {
          // 大 PDF 下载+解析超过云函数代码超时（8s）：提示用户手动核对页数
          wx.nextTick(() => {
            wx.showToast({ title: 'PDF 页数较多，识别超时请手动核对', icon: 'none', duration: 2000 });
          });
        } else {
          // 其他失败（code !== 0 或 pages 为空）：保持原提示
          wx.nextTick(() => {
            wx.showToast({ title: 'PDF 自动识别页数失败，请核对', icon: 'none', duration: 2000 });
          });
        }
      }
    } catch (err) {
      console.error('[PDF-PARSE] 外层异常 err=', err, err && err.stack ? err.stack : '');
      console.warn('PDF 预览解析失败:', f.name, err);
      wx.nextTick(() => {
        wx.showToast({ title: 'PDF 页数识别失败，请手动核对', icon: 'none' });
      });
    }
  },

  // 登记到 pendingFiles 台账：供云端 cleanupStorage 定时清理「传了但没下单」的孤儿文件。
  // 下单后该 fileID 会出现在订单里，清理函数会自动跳过它。登记失败不影响主流程。
  _registerPendingFile(fileID) {
    try {
      const pdb = wx.cloud.database();
      pdb.collection('pendingFiles').add({
        data: { fileID: fileID, createdAt: pdb.serverDate() }
      }).catch(() => {});
    } catch (e) { /* 台账不可用时忽略 */ }
  },

  previewFile(e) {
    const id = e.currentTarget.dataset.id;
    const f = this.data.files.find(x => x.id === id);
    if (!f) return;
    const name = (f.name || '').toLowerCase();
    // 图片走 wx.previewImage（支持双指缩放、左右滑）
    if (/\.(jpe?g|png|gif|bmp|webp)$/i.test(name)) {
      wx.previewImage({ urls: [f.path] });
      return;
    }
    // PDF/Word/PPT/Excel 走 wx.openDocument
    if (/\.(pdf|docx?|pptx?|xlsx?)$/i.test(name)) {
      wx.openDocument({
        filePath: f.path,
        showMenu: true,
        success: () => {
          // 成功打开就什么都不用做
        },
        fail: (err) => {
          // 失败（典型场景：用户手机没装 WPS、临时路径失效等）
          wx.showToast({ title: '无法预览该文件', icon: 'none' });
        }
      });
      return;
    }
    // 兜底：其他类型直接提示
    wx.showToast({ title: '暂不支持预览此类型', icon: 'none' });
  },

  // 生成可选时间段：今天起共 4 天（今天/明天/后天/大后天），每天 8:00 ~ 21:00 整点
  // 今天已过的时段直接不展示；未来几天全时段可选，顾客可预约「明天 12:00」这类时间
  generateTimeSlots() {
    const now = new Date();
    const currentHour = now.getHours();
    const dayNames = ['今天', '明天', '后天', '大后天'];
    const slots = [];
    dayNames.forEach((day, d) => {
      for (let h = 8; h <= 21; h++) {
        if (d === 0 && h <= currentHour) continue; // 今天已过的时段跳过
        const label = `${day} ${h}:00`;
        slots.push({ label: label, value: label });
      }
    });
    this.setData({ timeSlots: slots });
  },

  // 选择取件方式
  selectPickupMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (this.data.pickupMode === mode) {
      // 取消选择
      this.setData({ pickupMode: '', selectedTime: '', timeSlots: [] });
    } else {
      this.setData({ pickupMode: mode, selectedTime: '' });
      this.generateTimeSlots();
    }
    this.recalculateTotal();
  },

  // 选择时间段
  selectTime(e) {
    if (e.currentTarget.dataset.disabled) return;
    const value = e.currentTarget.dataset.value;
    this.setData({ selectedTime: this.data.selectedTime === value ? '' : value });
  },

  // 输入备注
  inputRemark(e) {
    this.setData({ remark: e.detail.value });
  },

  // 输入配送地址
  inputAddress(e) {
    this.setData({ address: e.detail.value });
  },

  // 输入手机号
  inputPhone(e) {
    this.setData({ phone: e.detail.value });
  },

  // ==================== 头像昵称（顾客身份） ====================
  openProfileModal() {
    this.setData({
      showProfileModal: true,
      nicknameInput: this.data.profile.nickname || '',
      tempAvatarPath: ''
    });
  },

  closeProfileModal() {
    this.setData({ showProfileModal: false });
  },

  // 微信「头像昵称填写能力」：点头像由微信给出用户自己的头像
  onChooseAvatar(e) {
    this.setData({ tempAvatarPath: e.detail.avatarUrl });
  },

  onNicknameInput(e) {
    this.setData({ nicknameInput: e.detail.value });
  },

  async saveProfile() {
    if (this.data.savingProfile) return;
    const nickname = (this.data.nicknameInput || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请填一个昵称', icon: 'none' });
      return;
    }
    this.setData({ savingProfile: true });
    try {
      // 新选的头像是临时文件，先传云存储；没换头像则沿用旧的
      let avatarFileID = this.data.profile.avatarFileID || '';
      if (this.data.tempAvatarPath) {
        const uploadRes = await wx.cloud.uploadFile({
          cloudPath: `avatars/${app.globalData.openid || 'user'}_${Date.now()}.png`,
          filePath: this.data.tempAvatarPath
        });
        avatarFileID = uploadRes.fileID;
      }
      const res = await wx.cloud.callFunction({
        name: 'getUserProfile',
        data: { action: 'update', nickname, avatarFileID }
      });
      if (!res.result || res.result.code !== 0) {
        throw new Error((res.result && res.result.message) || '保存失败');
      }
      app.globalData.userInfo = res.result.data;
      this.setData({
        showProfileModal: false,
        profile: { nickname, avatarFileID }
      });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      console.error('保存头像昵称失败:', err);
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ savingProfile: false });
    }
  },

  // 提交订单 — 通过云函数，服务端计算价格
  handleOrder() {
    if (!app.globalData.openid) {
      wx.showToast({ title: '正在获取用户信息，请稍后', icon: 'none' });
      return;
    }

    if (this.data.files.length === 0) {
      wx.showToast({ title: '请先选择文件', icon: 'none' });
      return;
    }

    // 店主休息中：拦截下单
    if (this.data.shopClosed) {
      wx.showModal({
        title: '店主休息中',
        content: '现在暂停接单，请营业后再来看看～',
        showCancel: false,
        confirmText: '我知道了'
      });
      return;
    }

    // 自取订单没留昵称：轻提醒一次（老板将不知道是谁的单子），不强制
    if (this.data.pickupMode === 'pickup' && !this.data.profile.nickname) {
      wx.showModal({
        title: '还没设置头像昵称',
        content: '自取订单老板将不知道是谁的，建议先设置一下（几秒钟就好）。',
        confirmText: '直接下单',
        cancelText: '去设置',
        success: (r) => {
          if (r.confirm) {
            this._submitOrder();
          } else {
            this.openProfileModal();
          }
        }
      });
      return;
    }

    this._submitOrder();
  },

  async _submitOrder() {
    if (!this.data.pickupMode) {
      wx.showToast({ title: '请选择取件方式', icon: 'none' });
      return;
    }

    if (this.data.pickupMode === 'delivery') {
      if (!this.data.address.trim()) {
        wx.showToast({ title: '请填写配送地址', icon: 'none' });
        return;
      }
      if (!this.data.phone.trim()) {
        wx.showToast({ title: '请填写手机号', icon: 'none' });
        return;
      }
    }

    // 订阅消息授权：微信单次最多允许申请 3 个模板，4 个分两批申请
    // （第二批在第一批的 complete 回调里发起，仍在用户点击手势链上，可正常弹窗；
    //   顺序即重要性：下单/核价/打印完成在前，取消通知放第二批）
    const tmplIds = Object.values(SUBSCRIBE_TEMPLATES).filter(Boolean);
    const requestBatch = (ids, onDone) => {
      if (!ids.length) { if (onDone) onDone(); return; }
      wx.requestSubscribeMessage({
        tmplIds: ids,
        complete: () => { if (onDone) onDone(); },
        fail: (err) => console.warn('订阅授权失败（不影响下单）:', err && err.errMsg)
      });
    };
    requestBatch(tmplIds.slice(0, 3), () => requestBatch(tmplIds.slice(3)));

    this.setData({ isSubmitting: true });

    try {
      // 第一步：上传所有文件到云存储
      // 预览阶段已上传过的 PDF 自带 fileID，这里直接复用，避免重复上传
      const uploadedFiles = [];
      for (const f of this.data.files) {
        let fileID = f.fileID;
        if (!fileID) {
          // 与预览上传一致：传到 pending/ 目录并登记台账。
          // 这样下单被服务端拒绝（休息中/防灌单/超数量）或中途失败时，
          // 残留文件能被 cleanupStorage 定时清掉，不会变成永久孤儿。
          const uploadRes = await wx.cloud.uploadFile({
            cloudPath: `print-files/pending/${f.id}_${f.name}`,
            filePath: f.path
          });
          fileID = uploadRes.fileID;
          this._registerPendingFile(fileID);
        }
        uploadedFiles.push({
          id: f.id,
          name: f.name,
          fileID: fileID,
          pages: f.pages,
          copies: f.copies || 1,
          color: f.color,
          doubleSided: f.doubleSided,
          isEstimated: f.isEstimated,
          printRange: f.printRange || ''
        });
      }

      // 第二步：调云函数下单（价格由服务端计算，不传 price）
      const res = await wx.cloud.callFunction({
        name: 'createOrder',
        data: {
          files: uploadedFiles,
          delivery: this.data.pickupMode === 'delivery',
          pickupMode: this.data.pickupMode,
          pickupTime: this.data.selectedTime,
          address: this.data.address.trim(),
          phone: this.data.phone.trim(),
          remark: this.data.remark.trim()
        }
      });

      if (res.result.code !== 0) {
        throw new Error(res.result.message || '下单失败');
      }

      // 保存订单金额，重置前先记录（价格待核款时 paidAmount 为 null）
      const paidAmount = res.result.totalPrice;
      const pricePending = !!res.result.pricePending;
      const payQrIndex = Math.random() < 0.5 ? 0 : 1;
      const payNoteId = (res.result.orderId || '').slice(-6).toUpperCase();

      if (res.result.pdfParseSkipped) {
        wx.showToast({ title: '部分 PDF 自动核页超时，请确认页数', icon: 'none', duration: 2500 });
      }

      this.setData({
        showPaymentModal: true,
        isSubmitting: false,
        paidAmount: paidAmount,
        pricePending: pricePending,
        priceAdjusted: !!res.result.priceAdjusted,
        payQrIndex: payQrIndex,
        payNoteId: payNoteId,
        files: [],
        pickupMode: '',
        selectedTime: '',
        timeSlots: [],
        address: '',
        phone: '',
        remark: '',
        subtotal: 0,
        deliveryFee: 0,
        totalPrice: 0
      });

      wx.showToast({ title: '下单成功！', icon: 'success' });
    } catch (err) {
      console.error('下单失败:', err);
      // 完整展示失败原因（文件名 / 打印范围 / 具体问题），用弹窗替代 toast，
      // 避免长消息被截断且一闪而过看不清
      wx.showModal({
        title: '下单失败',
        content: err.message || '下单失败，请检查订单信息后重试',
        showCancel: false,
        confirmText: '我知道了'
      });
      this.setData({ isSubmitting: false });
    }
  },

  // 关闭支付弹窗
  closePaymentModal() {
    this.setData({ showPaymentModal: false });
  },

  // 跳转到订单页
  goToOrders() {
    this.setData({ showPaymentModal: false });
    wx.switchTab({ url: '/pages/orders/orders' });
  },

  // 阻止事件冒泡
  preventBubble() {
    // 空函数，仅用于阻止事件冒泡
  }
});
