# 图标资源说明

## 需要的图标文件

### TabBar 图标（必须）
以下图标用于底部导航栏，尺寸建议 81x81 像素，格式 PNG：

1. `home.png` - 首页图标（未选中状态，灰色 #86868b）
2. `home-active.png` - 首页图标（选中状态，橙色 #FF6700）
3. `orders.png` - 订单图标（未选中状态，灰色 #86868b）
4. `orders-active.png` - 订单图标（选中状态，橙色 #FF6700）
5. `admin.png` - 管理图标（未选中状态，灰色 #86868b）
6. `admin-active.png` - 管理图标（选中状态，橙色 #FF6700）

### 页面内图标（可选）
以下图标用于页面内显示，尺寸 48x48 或 64x64 像素：

- `upload.png` - 上传文件图标
- `file.png` - 文件图标
- `warning.png` - 警告/感叹号图标
- `plus.png` - 加号图标
- `close.png` - 关闭/X 图标
- `delivery.png` - 配送/卡车图标
- `info.png` - 信息图标
- `success.png` - 成功/勾选图标
- `qrcode.png` - **重要！** 您的微信收款二维码
- `clock.png` - 时钟图标
- `package.png` - 包裹图标
- `truck.png` - 卡车图标
- `check.png` - 勾选图标
- `bag.png` - 购物袋图标
- `user.png` - 用户图标

## 如何获取图标

### 方法一：使用图标库（推荐）
1. 访问 [Iconfont](https://www.iconfont.cn/) 或 [Flaticon](https://www.flaticon.com/)
2. 搜索对应图标名称
3. 下载 PNG 格式，选择合适的尺寸
4. 重命名为上述文件名，放入此目录

### 方法二：使用微信开发者工具自带图标
1. 在微信开发者工具中，点击「详情」->「本地设置」
2. 勾选「使用 npm 模块」
3. 可以使用 `@vant/weapp` 组件库中的图标

### 方法三：使用在线图标生成器
1. 访问 [Favicon.io](https://favicon.io/)
2. 生成简单的图标
3. 下载后重命名使用

## 重要提示

**收款二维码**（首页支付弹窗 + 订单页长按识别用）：
- 首页支付弹窗和订单页会从 `qrcode0.png`、`qrcode1.png` 中**随机展示一张，两张都必须是有效收款码**——替换时请把两张都换成您自己的微信收款二维码。
- 建议尺寸 300×300 像素以上，PNG 格式。
- ⚠️ 这两张都是真实收款码，**请勿覆盖/误删**——图标生成脚本 `generate-icons.js` 只生成界面图标，**不**生成二维码。
- 🔒 三张收款码图（含历史备份 `qrcode.png`）含个人信息，**已加入 `.gitignore` 不随 git 分发**；本地文件保留，小程序打包不受影响。换电脑克隆仓库后需手动放回。
- `qrcode.png` 是历史备份，已无代码引用，可忽略或删除。

## 临时解决方案

如果暂时没有图标，可以：
1. 删除 `app.json` 中的 `iconPath` 和 `selectedIconPath` 配置
2. 只保留 `text` 字段，TabBar 将只显示文字
3. 页面内图标可以暂时用文字替代

或者，您可以将以下代码替换 `app.json` 中的 tabBar 配置：

```json
"tabBar": {
  "color": "#86868b",
  "selectedColor": "#FF6700",
  "backgroundColor": "#ffffff",
  "borderStyle": "white",
  "list": [
    {
      "pagePath": "pages/home/home",
      "text": "首页"
    },
    {
      "pagePath": "pages/orders/orders",
      "text": "我的订单"
    },
    {
      "pagePath": "pages/admin/admin",
      "text": "管理"
    }
  ]
}
```

这样 TabBar 将只显示文字，不需要图标文件。
