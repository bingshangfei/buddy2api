/**
 * http-utils.js — HTTP 传输工具（零依赖叶）。
 *
 * resWriter 原是 stream-driver.js 的传输词汇（断连保护写入），因 sink-base（底层
 * 抽象）反向依赖 stream-driver（高层编排）的 resWriter，故提取至此——底层与高层
 * 各自从本模块导入，依赖方向修正（架构深化十批 D6）。
 */

/**
 * 构造一个带断连保护的响应写入函数。
 * 原本是三条消费路径 + _suspendForToolCall 各自复制的 write 闭包，收敛于此。
 */
export function resWriter(res) {
  return (chunk) => {
    if (res && !res.writableEnded) {
      try { res.write(chunk); } catch { /* client gone */ }
    }
  };
}
