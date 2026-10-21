/**
 * prompt-builder.js — OpenAI messages → ACP prompt 的构建（纯函数，从 openai-handler.js 拆出）。
 */

// 提示词净化：转发给 WorkBuddy 前，把客户端注入的身份字样替换为 workbuddy
const PROMPT_IDENTITY_RE = /\b(ZCode|zcode|opencode|OpenCode|OPENCODE|Claude Code)\b/g;

/**
 * 净化提示词文本：把 ZCode / opencode 等客户端身份字样替换为 workbuddy。
 * 支持字符串或 ACP content block 数组。
 */
export function sanitizePrompt(text) {
  if (typeof text === 'string') {
    return text.replace(PROMPT_IDENTITY_RE, 'workbuddy');
  }
  if (Array.isArray(text)) {
    return text.map(block => {
      if (block && typeof block.text === 'string') {
        return { ...block, text: block.text.replace(PROMPT_IDENTITY_RE, 'workbuddy') };
      }
      return block;
    });
  }
  return text;
}

/**
 * Convert a single OpenAI message to text
 */
export function messageToText(msg) {
  if (!msg || !msg.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text)
      .join('\n');
  }
  return '';
}

// ---------- 图片内容块 ----------

// data URL：data:image/png;base64,<base64 数据>
const DATA_URL_RE = /^data:([^;,]*)(;base64)?,([\s\S]*)$/;

/**
 * OpenAI 的 data URL 字符串 → ACP image 块。
 *
 * ACP 图像块形状（WorkBuddy 实测，codebuddy-headless.js 中多处构造/解析均为此形状）：
 *   { type: 'image', data: '<base64>', mimeType: 'image/png' }
 * 注意：块上的 uri 字段只作显示名/文件名用，WorkBuddy 不会据它去下载，
 * 因此远程 URL 必须先由调用方抓成 data URL（见 handler._resolveRemoteImages）。
 *
 * @returns {{type:'image', data:string, mimeType:string}|null} 非 base64 data URL 返回 null
 */
export function dataUrlToImageBlock(url) {
  if (typeof url !== 'string') return null;
  const m = DATA_URL_RE.exec(url);
  if (!m || !m[2]) return null; // 非 base64（如 data:image/svg+xml,<svg…>）无法直接内联
  const data = m[3];
  if (!data) return null;
  return { type: 'image', data, mimeType: m[1] || 'image/png' };
}

/**
 * 单个 OpenAI 内容块 → ACP image 块。兼容三种客户端写法：
 *   - OpenAI：   {type:'image_url', image_url:{url}}（url 也可能是裸字符串）
 *   - Anthropic：{type:'image', source:{type:'base64', media_type, data}}
 *   - ACP 原生： {type:'image', data, mimeType}
 *
 * @returns {{type:'image', data:string, mimeType:string}|null} 非图片或无法内联时返回 null
 */
export function contentPartToAcpBlock(part) {
  if (!part || typeof part !== 'object') return null;

  if (part.type === 'image_url') {
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    return dataUrlToImageBlock(url);
  }

  if (part.type === 'image') {
    const src = part.source;
    if (src && src.type === 'base64' && typeof src.data === 'string') {
      return { type: 'image', data: src.data, mimeType: src.media_type || 'image/png' };
    }
    if (typeof part.data === 'string' && part.data) {
      return { type: 'image', data: part.data, mimeType: part.mimeType || 'image/png' };
    }
  }
  return null;
}

/**
 * OpenAI 消息的 content（字符串或块数组）→ ACP 内容块数组。
 * 连续的文本合并为一个 text 块；图片块保持与文本的相对顺序。
 * 认不出的图片写法（如未经抓取的远程 URL）会被丢弃——调用方需先转 data URL。
 */
export function contentToAcpBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }];

  const blocks = [];
  let textParts = [];

  const flushText = () => {
    if (textParts.length > 0) {
      blocks.push({ type: 'text', text: textParts.join('\n') });
      textParts = [];
    }
  };

  for (const part of content) {
    if (typeof part === 'string') {
      textParts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;

    // 无 type 但带 text 的裸文本块，OpenAI 规范里等价于 {type:'text'}
    if (part.type === 'text' || (!part.type && typeof part.text === 'string')) {
      if (part.text) textParts.push(part.text);
      continue;
    }

    const image = contentPartToAcpBlock(part);
    if (image) {
      flushText();
      blocks.push(image);
    }
  }
  flushText();

  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

/**
 * Build ACP prompt content blocks from OpenAI messages
 */
export function buildPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [{ type: 'text', text: '' }];
  }

  // 单条消息不特判：必须走与多轮相同的格式化分支，否则首轮文本（裸文本）不是
  // 第二轮文本（带 [User] 前缀）的前缀，会话亲和的 startsWith 判定必然失败，
  // 每轮对话的第二轮都会冷启动重烧整个 prompt 前缀。
  const blocks = [];
  let pending = [];

  const flushText = () => {
    if (pending.length > 0) {
      blocks.push({ type: 'text', text: pending.join('\n\n') });
      pending = [];
    }
  };

  for (const msg of messages) {
    if (!msg) continue;
    const parts = contentToAcpBlocks(msg.content);
    const images = parts.filter(p => p.type === 'image');
    const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');

    const role = msg.role || 'user';
    if (role === 'system') {
      if (text) pending.push(`[System instructions]\n${text}`);
    } else if (role === 'assistant') {
      // 带 tool_calls 的 assistant 消息：保留调用意图
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (const tc of calls) {
        pending.push(`[Assistant tool call: ${tc.function?.name}(${tc.function?.arguments || ''})]`);
      }
      if (text) {
        pending.push(`${calls.length > 0 ? '[Assistant]' : '[Assistant previous reply]'}\n${text}`);
      }
    } else if (role === 'tool') {
      if (text) pending.push(`[Tool result for ${msg.tool_call_id || 'tool'}]\n${text}`);
    } else if (text) {
      pending.push(`[User]\n${text}`);
    }

    // 图片必须紧跟其所属消息的文本之后，否则多轮多图时模型会张冠李戴
    if (images.length > 0) {
      flushText();
      blocks.push(...images);
    }
  }
  flushText();

  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

/**
 * 把 ACP 内容块序列化为纯文本，用于会话亲和的前缀比对（见 conversation-cache.js）。
 *
 * 只要含非文本块（如图片）就返回 null——含图片的请求不参与复用，避免增量切片
 * 破坏图片与文本的相对顺序。文本块之间用 '\n\n' 连接（与 buildPrompt 合并口径一致）。
 *
 * @param {Array} blocks
 * @returns {string|null}
 */
export function blocksToPlainText(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const parts = [];
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return null;
    parts.push(block.text);
  }
  return parts.join('\n\n');
}
