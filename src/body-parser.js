/**
 * body-parser.js — HTTP 请求体解析（从 index.js 出仓以可单测，架构深化第 8 批 C6）。
 *
 * 解码口径：chunk 收进数组后 **Buffer.concat + 单次 toString('utf8')**——旧实现
 * `body += chunk` 按字符串累加，跨 chunk 分割的多字节 UTF-8 序列会在每个 chunk
 * 边界被独立解码成 U+FFFD（中文/emoji 大请求体必现乱码）。这是本批申报的
 * 行为白名单差异②（修复方向，见 prd 验收 1）。
 */

// 请求体上限：图片走 base64（1.33x 膨胀），给足余量但必须有界——
// 无上限时恶意/异常客户端可以用超大 body 打爆服务内存
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * 解析 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>} 解析后的 JSON（空体 → {}）
 */
export function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy(); // 直接断开：继续接收只会浪费带宽
        reject(new Error(`Request body too large (max ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
