// ============================================================
// milo 打印小店 · 图标生成器（Apple SF Symbols 风格）
//
// 设计体系：
//   - 统一 24x24 网格，统一线宽（1.8 / 1.9），圆角端点 + 圆角拐角
//   - 底部 tab：未选中 = 线性灰 #86868b；选中 = 实心填充品牌橙 #FF6700
//     （与 iOS 原生 tab bar 一致：outline → filled）
//   - 页内图标：单色小符号，语义色仅 warning(amber) / success、check(green)
//
// 运行：node generate-icons.js   （依赖 node-canvas，项目已装）
// 注意：本脚本不再生成 qrcode*.png，避免覆盖真实收款码。
// ============================================================
const fs = require('fs');
const path = require('path');

const IMAGES_DIR = path.join(__dirname, 'images');

function generateIcons() {
  const { createCanvas } = require('canvas');
  const canvas = (size) => {
    const c = createCanvas(size, size);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    return { c, ctx, size };
  };

  const save = (cv, filename) => {
    fs.writeFileSync(path.join(IMAGES_DIR, filename), cv.c.toBuffer('image/png'));
    console.log(`  ✓ ${filename}`);
  };

  console.log('Generating Apple SF Symbols style icons (v2)...\n');

  const GRAY = '#86868b';    // 未选中 / 一般页内图标
  const ACTIVE = '#FF6700';  // 品牌橙（选中态、upload）
  const DARK = '#5F5E5A';    // truck/package/delivery（激活态会被 CSS 反白）
  const AMBER = '#F59E0B';   // 警告
  const GREEN = '#22C55E';   // 成功

  const TAB = 81;   // tab 图标尺寸
  const MID = 96;   // 页内图标尺寸

  // ============ 基础：24 格线性图标 ============
  // strokes: [{ draw(ctx), lw?, fill? }]
  function line(size, strokes, color, defaultLw = 1.8) {
    const cv = canvas(size);
    const ctx = cv.ctx;
    ctx.scale(size / 24, size / 24);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.beginPath();
      s.draw(ctx);
      if (s.fill) {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = s.lw || defaultLw;
        ctx.stroke();
      }
    }
    return cv;
  }

  // ============ 基础：填充剪影图标（可镂空） ============
  // erases: [{ draw(ctx), lw? }] 以 destination-out 镂空（stroke 或 fill）
  function filled(size, drawFill, color, erases = []) {
    const cv = canvas(size);
    const ctx = cv.ctx;
    ctx.scale(size / 24, size / 24);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.fillStyle = color;
    ctx.beginPath();
    drawFill(ctx);
    ctx.fill();
    if (erases.length) {
      ctx.globalCompositeOperation = 'destination-out';
      for (const e of erases) {
        ctx.beginPath();
        e.draw(ctx);
        if (e.lw) {
          ctx.lineWidth = e.lw;
          ctx.stroke();
        } else {
          ctx.fill();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    return cv;
  }

  // ============ 图标路径（24 格） ============

  // 首页：带门的小房子
  const homeLine = [
    { draw: c => { c.moveTo(3.8, 11); c.lineTo(12, 4); c.lineTo(20.2, 11); } },
    { draw: c => { c.moveTo(6, 9.2); c.lineTo(6, 19.5); c.lineTo(18, 19.5); c.lineTo(18, 9.2); } },
    { draw: c => { c.moveTo(10, 19.5); c.lineTo(10, 14.2); c.lineTo(14, 14.2); c.lineTo(14, 19.5); } }
  ];
  const homeFill = c => {
    c.moveTo(3.4, 11); c.lineTo(12, 3.4); c.lineTo(20.6, 11);
    c.lineTo(18.2, 11); c.lineTo(18.2, 20); c.lineTo(5.8, 20); c.lineTo(5.8, 11);
    c.closePath();
  };
  const homeFillErase = [
    { draw: c => { c.rect(10.2, 14.2, 3.6, 5.8); } } // 镂空中门
  ];

  // 订单：折角文档 + 三行文字
  const docLine = [
    { draw: c => { c.moveTo(7, 3.8); c.lineTo(14.8, 3.8); c.lineTo(17.2, 6.2); c.lineTo(17.2, 20.2); c.lineTo(7, 20.2); c.closePath(); } },
    { draw: c => { c.moveTo(14.8, 3.8); c.lineTo(14.8, 6.2); c.lineTo(17.2, 6.2); } },
    { draw: c => { c.moveTo(9.6, 11); c.lineTo(14.4, 11); } },
    { draw: c => { c.moveTo(9.6, 14.2); c.lineTo(14.4, 14.2); } },
    { draw: c => { c.moveTo(9.6, 17.4); c.lineTo(12.6, 17.4); } }
  ];
  const docFill = c => {
    c.moveTo(7, 3.6); c.lineTo(14.6, 3.6); c.lineTo(17.4, 6.4);
    c.lineTo(17.4, 20.4); c.lineTo(7, 20.4); c.closePath();
  };
  const docFillErase = [
    { draw: c => { c.moveTo(9.6, 11); c.lineTo(14.4, 11); }, lw: 1.7 },
    { draw: c => { c.moveTo(9.6, 14.2); c.lineTo(14.4, 14.2); }, lw: 1.7 },
    { draw: c => { c.moveTo(9.6, 17.4); c.lineTo(12.6, 17.4); }, lw: 1.7 }
  ];

  // 管理 / 用户：人形
  const personLine = [
    { draw: c => { c.arc(12, 7.6, 3.4, 0, Math.PI * 2); } },
    { draw: c => { c.moveTo(5.2, 19.8); c.bezierCurveTo(5.2, 15.4, 8.3, 13.4, 12, 13.4); c.bezierCurveTo(15.7, 13.4, 18.8, 15.4, 18.8, 19.8); } }
  ];
  const personFillHead = c => { c.arc(12, 7.3, 3.7, 0, Math.PI * 2); };
  const personFillBody = c => {
    c.moveTo(5, 20.2);
    c.bezierCurveTo(5, 15, 8.2, 13, 12, 13);
    c.bezierCurveTo(15.8, 13, 19, 15, 19, 20.2);
    c.closePath();
  };

  // 配送：小货车
  const truckLine = [
    { draw: c => { c.moveTo(2.8, 6.8); c.lineTo(13.6, 6.8); c.lineTo(13.6, 15.6); c.lineTo(2.8, 15.6); c.closePath(); } },
    { draw: c => { c.moveTo(13.6, 10); c.lineTo(17.6, 10); c.lineTo(20.4, 13); c.lineTo(20.4, 15.6); c.lineTo(13.6, 15.6); } },
    { draw: c => { c.arc(7.2, 17.8, 1.9, 0, Math.PI * 2); }, fill: true },
    { draw: c => { c.arc(16.8, 17.8, 1.9, 0, Math.PI * 2); }, fill: true }
  ];

  // 自取：立体纸箱
  const packageLine = [
    { draw: c => { c.moveTo(12, 3.2); c.lineTo(20.2, 7.6); c.lineTo(20.2, 16.4); c.lineTo(12, 20.8); c.lineTo(3.8, 16.4); c.lineTo(3.8, 7.6); c.closePath(); } },
    { draw: c => { c.moveTo(3.8, 7.6); c.lineTo(12, 12); c.lineTo(20.2, 7.6); } },
    { draw: c => { c.moveTo(12, 12); c.lineTo(12, 20.8); } },
    { draw: c => { c.moveTo(7.9, 5.4); c.lineTo(16.1, 9.8); } }
  ];

  // 上传：square.and.arrow.up
  const uploadLine = [
    { draw: c => { c.moveTo(4, 13.5); c.lineTo(4, 18.5); c.quadraticCurveTo(4, 20.5, 6, 20.5); c.lineTo(18, 20.5); c.quadraticCurveTo(20, 20.5, 20, 18.5); c.lineTo(20, 13.5); } },
    { draw: c => { c.moveTo(12, 15.5); c.lineTo(12, 4.5); } },
    { draw: c => { c.moveTo(7.5, 9); c.lineTo(12, 4.2); c.lineTo(16.5, 9); } }
  ];

  // 关闭：xmark
  const closeLine = [
    { draw: c => { c.moveTo(6.5, 6.5); c.lineTo(17.5, 17.5); }, lw: 2.1 },
    { draw: c => { c.moveTo(17.5, 6.5); c.lineTo(6.5, 17.5); }, lw: 2.1 }
  ];

  // 加号：plus
  const plusLine = [
    { draw: c => { c.moveTo(12, 5.5); c.lineTo(12, 18.5); }, lw: 2.1 },
    { draw: c => { c.moveTo(5.5, 12); c.lineTo(18.5, 12); }, lw: 2.1 }
  ];

  // 时钟：clock
  const clockLine = [
    { draw: c => { c.arc(12, 12, 8.2, 0, Math.PI * 2); } },
    { draw: c => { c.moveTo(12, 7.4); c.lineTo(12, 12); c.lineTo(15.4, 14); } }
  ];

  // 信息：info.circle
  const infoLine = [
    { draw: c => { c.arc(12, 12, 8.2, 0, Math.PI * 2); } },
    { draw: c => { c.arc(12, 7.7, 1.05, 0, Math.PI * 2); }, fill: true },
    { draw: c => { c.moveTo(12, 11); c.lineTo(12, 16.4); }, lw: 1.9 }
  ];

  // 对勾：checkmark
  const checkLine = [
    { draw: c => { c.moveTo(5.5, 12.8); c.lineTo(10, 17); c.lineTo(18.5, 7.5); }, lw: 2.6 }
  ];

  // 购物袋（空订单）：bag
  const bagLine = [
    { draw: c => { c.moveTo(5.6, 8.2); c.lineTo(18.4, 8.2); c.lineTo(19.4, 20.4); c.quadraticCurveTo(19.5, 21.6, 18.2, 21.6); c.lineTo(5.8, 21.6); c.quadraticCurveTo(4.5, 21.6, 4.6, 20.4); c.closePath(); } },
    { draw: c => { c.moveTo(8.6, 8.2); c.bezierCurveTo(8.6, 5.4, 10, 3.6, 12, 3.6); c.bezierCurveTo(14, 3.6, 15.4, 5.4, 15.4, 8.2); } }
  ];

  // 带箱货车（delivery 备用）：box.truck
  const deliveryLine = [
    { draw: c => { c.moveTo(2.8, 7.4); c.lineTo(13.2, 7.4); c.lineTo(13.2, 15.6); c.lineTo(2.8, 15.6); c.closePath(); } },
    { draw: c => { c.moveTo(13.2, 10.4); c.lineTo(17.2, 10.4); c.lineTo(20, 13.2); c.lineTo(20, 15.6); c.lineTo(13.2, 15.6); } },
    { draw: c => { c.moveTo(5.6, 9.8); c.lineTo(9.4, 9.8); c.lineTo(9.4, 13.2); c.lineTo(5.6, 13.2); c.closePath(); } },
    { draw: c => { c.arc(7, 17.7, 1.8, 0, Math.PI * 2); }, fill: true },
    { draw: c => { c.arc(16.6, 17.7, 1.8, 0, Math.PI * 2); }, fill: true }
  ];

  // ============ 生成：底部 tab（线性灰 + 实心橙） ============
  save(line(TAB, homeLine, GRAY), 'home.png');
  save(filled(TAB, homeFill, ACTIVE, homeFillErase), 'home-active.png');
  save(line(TAB, docLine, GRAY), 'orders.png');
  save(filled(TAB, docFill, ACTIVE, docFillErase), 'orders-active.png');
  save(line(TAB, personLine, GRAY), 'admin.png');
  // admin-active = 头 + 身体两个填充块
  save((() => {
    const cv = canvas(TAB);
    const ctx = cv.ctx;
    ctx.scale(TAB / 24, TAB / 24);
    ctx.fillStyle = ACTIVE;
    ctx.beginPath(); personFillHead(ctx); ctx.fill();
    ctx.beginPath(); personFillBody(ctx); ctx.fill();
    return cv;
  })(), 'admin-active.png');

  // ============ 生成：页内图标 ============
  save(line(MID, truckLine, DARK, 1.9), 'truck.png');
  save(line(MID, packageLine, DARK, 1.9), 'package.png');
  save(line(MID, deliveryLine, DARK, 1.9), 'delivery.png');
  save(line(MID, uploadLine, ACTIVE, 1.9), 'upload.png');
  save(line(MID, docLine, GRAY), 'file.png');
  save(line(MID, closeLine, GRAY), 'close.png');
  save(line(MID, plusLine, GRAY), 'plus.png');
  save(line(MID, clockLine, GRAY), 'clock.png');
  save(line(MID, infoLine, GRAY), 'info.png');
  save(line(MID, checkLine, GREEN), 'check.png');
  save(line(MID, bagLine, GRAY), 'bag.png');
  save(line(MID, personLine, GRAY), 'user.png');

  // 警告：exclamationmark.triangle.fill（圆角琥珀三角 + 白色叹号）
  save((() => {
    const cv = canvas(MID);
    const ctx = cv.ctx;
    ctx.scale(MID / 24, MID / 24);
    ctx.lineJoin = 'round';
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.moveTo(10.8, 5.8);
    ctx.lineTo(3.4, 17.6);
    ctx.quadraticCurveTo(2.4, 19.2, 4.2, 19.2);
    ctx.lineTo(19.8, 19.2);
    ctx.quadraticCurveTo(21.6, 19.2, 20.6, 17.6);
    ctx.lineTo(13.2, 5.8);
    ctx.quadraticCurveTo(12, 4.2, 10.8, 5.8);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.9;
    ctx.beginPath(); ctx.moveTo(12, 8.8); ctx.lineTo(12, 14.6); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(12, 17.2, 1.15, 0, Math.PI * 2); ctx.fill();
    return cv;
  })(), 'warning.png');

  // 成功：checkmark.circle.fill（绿圆 + 白勾）
  save((() => {
    const cv = canvas(MID);
    const ctx = cv.ctx;
    ctx.scale(MID / 24, MID / 24);
    ctx.fillStyle = GREEN;
    ctx.beginPath(); ctx.arc(12, 12, 9.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.1;
    ctx.beginPath(); ctx.moveTo(7.8, 12.3); ctx.lineTo(10.9, 15.4); ctx.lineTo(16.3, 9.5); ctx.stroke();
    return cv;
  })(), 'success.png');

  console.log('\n✅ All icons generated (Apple SF Symbols style).');
  console.log('ℹ️  qrcode*.png 未重新生成，真实收款码不受影响。');
}

if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

generateIcons();
