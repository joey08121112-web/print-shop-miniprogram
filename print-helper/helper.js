// ============================================================
// milo 打印助手（本地小助手）
//
// 作用：让网页后台可以一键打开文件 —— 点「一键打开」后，
//       本程序把云存储里的文件下载下来，并调用系统默认程序
//       （WPS 设为默认就是 WPS）自动打开，和微信里点文件一样。
//
// 使用方法：
//   1. 在打印电脑上安装 Node.js（https://nodejs.org 下载 LTS 版，一次性）
//   2. 双击 start-helper.bat（Windows）或 start-helper.command（Mac），
//      或在终端执行：node helper.js
//   3. 保持窗口开着（想开机自启见文件底部说明）
//   4. 网页后台右上角显示「打印助手：已连接」即表示生效
//
// 安全说明：
//   - 只监听 127.0.0.1，外网无法访问
//   - 用 TOKEN 防止其他网页误触发，需与 admin-web/index.html
//     顶部 CONFIG.helperToken 保持一致
//   - 校验请求来源（Origin）：只放行本机页面发起的请求；你在浏览器里
//     打开的其他网站无法再借本助手下载并打开任意文件
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const PORT = 9527;
const TOKEN = 'milo-print-helper'; // 与 admin-web 的 CONFIG.helperToken 一致
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'milo-print');

// 来源校验：只放行「本机页面」的请求，拒绝浏览器里其他网站的跨站调用。
//   - 无 Origin 头：curl / 系统级请求（正常情况）
//   - Origin 为 'null' 或 file:// 开头：本地双击打开的 admin-web/index.html
//     （file:// 页面发 fetch 时浏览器会带 Origin: null）
//   - 其他 http(s) Origin：来自某个网站页面 → 一律拒绝，防止「路过的网页」
//     借本助手下载并自动打开任意文件
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === 'null' || origin.startsWith('file://');
}

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// 下载文件（跟随跳转），返回保存路径
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    // 重定向可能落到 http://，按协议选模块
    const lib = String(url).startsWith('http:') ? http : https;
    lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(dest, () => {});
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error('下载失败，HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// 用系统默认程序打开文件（WPS 设为默认即进 WPS）
function openFile(filePath) {
  const platform = process.platform;
  if (platform === 'win32') {
    // Windows：start 命令调起默认程序
    exec(`start "" "${filePath}"`, { shell: 'cmd.exe' });
  } else if (platform === 'darwin') {
    // macOS：open 调起默认程序
    exec(`open "${filePath}"`);
  } else {
    // Linux 桌面
    exec(`xdg-open "${filePath}"`);
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');

  // 心跳检测：网页后台据此显示「已连接」
  if (u.pathname === '/ping') {
    if (u.searchParams.get('token') !== TOKEN) {
      return sendJson(res, 403, { code: -1, message: 'token 错误' });
    }
    if (!originAllowed(req)) {
      return sendJson(res, 403, { code: -1, message: '来源不被允许（仅限本机页面调用）' });
    }
    return sendJson(res, 200, { code: 0, platform: process.platform });
  }

  // 打开文件：/open?token=...&url=...&name=...
  if (u.pathname === '/open') {
    if (u.searchParams.get('token') !== TOKEN) {
      return sendJson(res, 403, { code: -1, message: 'token 错误' });
    }
    if (!originAllowed(req)) {
      return sendJson(res, 403, { code: -1, message: '来源不被允许（仅限本机页面调用）' });
    }
    const fileUrl = u.searchParams.get('url');
    if (!fileUrl) {
      return sendJson(res, 400, { code: -1, message: '缺少 url' });
    }
    // 域名白名单：只允许打开腾讯云端的打印文件（云存储临时链接 / 云函数触发器）。
    // <img> 等标签发请求不带 Origin，能绕过上面的来源校验，且 token 是随代码公开的，
    // 所以必须限制下载目标——否则路过的网页可让本机下载并自动打开任意文件（比如恶意程序）
    let host = '';
    try { host = new URL(fileUrl).hostname; } catch (e) {}
    if (!/(^|\.)myqcloud\.com$|(^|\.)tcloudbase\.com$/.test(host)) {
      console.warn(`[已拒绝] 非云端地址: ${host || fileUrl.slice(0, 80)}`);
      return sendJson(res, 403, { code: -1, message: '仅允许打开云端打印文件' });
    }
    // 文件名清理：去掉 Windows 不允许的字符
    let name = u.searchParams.get('name') || 'file';
    name = name.replace(/[\\/:*?"<>|]/g, '_').substring(0, 120);

    const dest = path.join(DOWNLOAD_DIR, `${Date.now()}-${name}`);
    try {
      await download(fileUrl, dest);
      openFile(dest);
      console.log(`[已打开] ${name}`);
      return sendJson(res, 200, { code: 0, path: dest });
    } catch (err) {
      console.error(`[打开失败] ${name}:`, err.message);
      return sendJson(res, 500, { code: -1, message: err.message });
    }
  }

  sendJson(res, 404, { code: -1, message: '未知接口' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('============================================');
  console.log('  milo 打印助手已启动');
  console.log(`  地址: http://127.0.0.1:${PORT}`);
  console.log(`  下载目录: ${DOWNLOAD_DIR}`);
  console.log('  保持本窗口开着，网页后台即可一键打开文件');
  console.log('============================================');
});

// ============================================================
// 开机自启（可选）：
//   Windows：把 start-helper.bat 的快捷方式放进
//            「shell:startup」（Win+R 输入）文件夹
//   Mac：系统设置 → 通用 → 登录项 → 添加 start-helper.command
// ============================================================
