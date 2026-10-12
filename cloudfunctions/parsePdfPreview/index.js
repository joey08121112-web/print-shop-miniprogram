// 轻量 PDF 页数解析，仅用于客户端选完文件后的预览提示。放宽到 8 秒以兼容二三百页的大 PDF。
// 【重要】云函数的「执行超时」是在微信云开发控制台配置的（默认仅 3 秒），
//   该云端超时须 ≥ 15 秒，否则云端会在代码超时（8s）之前先掐断函数，导致大 PDF 始终解析失败。
//   此超时只能由用户在「云开发控制台 → 云函数 → parsePdfPreview → 配置 → 超时时间」中设置，
//   代码无法修改云端配置。若遇到问题，请提醒用户去控制台把超时调大。
const cloud = require('wx-server-sdk');
const { PDFDocument } = require('pdf-lib');

// 代码层超时：大 PDF（下载 + pdf-lib 解析）放宽到 8 秒（createOrder 下单主流程用 2.5s 兼顾速度）
const PDF_PARSE_TIMEOUT_MS = 8000;

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 下载并解析 PDF 实际页数；失败（加密 / 畸形 / 下载出错）返回 null，交给上层保持占位
async function tryParsePdfPages(fileID) {
  try {
    const res = await cloud.downloadFile({ fileID });
    const doc = await PDFDocument.load(res.fileContent, { ignoreEncryption: true });
    const count = doc.getPageCount();
    return count >= 1 ? count : null;
  } catch (err) {
    // 加密 / 畸形 / 下载失败：捕获后返回 null，不向上抛，避免中断主流程
    console.warn('PDF 页数解析失败:', fileID, err && err.message);
    return null;
  }
}

// 带超时的 PDF 解析：超过 8 秒放弃（云端执行超时必须 ≥ 15s 才不会先掐断，见顶部说明）。
// 复用 createOrder 的 parsePdfWithTimeout 模式（Promise.race + setTimeout，.finally 清 timer）。
// 超时时清除 timer；正常完成时清除 timer；异常分支也要清除（避免内存泄漏）。
function parsePdfWithTimeout(fileID, timeoutMs) {
  let timer = null;
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
  });
  const workPromise = tryParsePdfPages(fileID).then(
    pages => ({ __timeout: false, pages }),
    err => ({ __timeout: false, pages: null, err })
  );
  return Promise.race([timeoutPromise, workPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

exports.main = async (event, context) => {
  const { fileID } = event || {};
  if (!fileID) {
    return { code: -1, message: '缺少 fileID 参数' };
  }

  const result = await parsePdfWithTimeout(fileID, PDF_PARSE_TIMEOUT_MS);

  if (result.__timeout) {
    // 超时：客户端拿到后保持 isEstimated=true，让用户手动核对
    return { code: 0, pages: null, timedOut: true };
  }

  if (result.pages) {
    // 成功：返回真实页数，客户端可去掉「需手动核对」徽标
    return { code: 0, pages: result.pages, isEstimated: false };
  }

  // 解密失败 / 畸形 PDF：返回 error，客户端同样保持占位（isEstimated 仍为 true）
  return { code: 0, pages: null, error: (result.err && result.err.message) || 'PDF 解析失败' };
};
