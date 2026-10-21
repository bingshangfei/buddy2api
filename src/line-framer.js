/**
 * 增量行帧器（批9 #1）——把跨 chunk 的文本流切分为"完整行"。
 *
 * 只做一件事：按 '\n' 切分，保留末尾可能不完整的行等下一次 push 拼接。
 * 与 `text.split('\n')` 的"整串重扫"不同，内部维护已扫描游标，每个字节只
 * 扫描一次（O(n)），避免长流累积成 O(n²)。
 *
 * 语义与 `_iterSse` 原内联实现逐字一致：返回不含 '\n' 的行、保留不完整末行、
 * 消费后立即剪掉已处理前缀防止 buffer 无限增长。
 */

/**
 * @returns {{ push(chunk: string): string[] }} 帧器实例
 */
export function createLineFramer() {
  let buffer = '';    // 未处理的字节（含可能的不完整末行）
  let scanFrom = 0;   // 上一轮已扫描到的位置（新字节从这开始）

  return {
    /**
     * 追加一段文本，返回其中所有"完整行"（不含换行符）。
     * @param {string} chunk
     * @returns {string[]}
     */
    push(chunk) {
      buffer += chunk;
      const lines = [];
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n', scanFrom)) !== -1) {
        lines.push(buffer.slice(scanFrom, newlineIdx));
        scanFrom = newlineIdx + 1;
      }
      // 剪掉已扫描前缀，防止 buffer 无限增长；保留可能的不完整末行
      if (scanFrom >= buffer.length) {
        buffer = '';
      } else if (scanFrom > 0) {
        buffer = buffer.slice(scanFrom);
      }
      scanFrom = 0;
      return lines;
    }
  };
}
