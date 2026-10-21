/**
 * agent-guide.js — 各 agent / 客户端的接入配置文案（纯函数，零 IO）。
 *
 * 「模型清单」查看功能（scripts/models.js 的表格末尾与 --guide 模式）共用：
 * 教用户用三件套（Base URL / API Key / 模型 id）把任意支持 OpenAI 兼容
 * 接口的 agent 接到本代理上。端口、默认模型等事实由调用方传入，避免
 * 文案与实际服务配置漂移。
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1';

const RULE = '-'.repeat(58);

/**
 * 返回接入配置指南的文本行数组（调用方逐行打印）。
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]      服务地址（含 /v1 后缀）
 * @param {string|null} [opts.defaultModel] 代理默认模型；null 时省略该提示
 * @returns {string[]}
 */
export function agentGuideLines({ baseUrl = DEFAULT_BASE_URL, defaultModel = null } = {}) {
  // 个别客户端会自己补 /v1，此时要填的是去掉后缀的 host 部分
  const host = baseUrl.replace(/\/v1\/?$/, '');
  const modelLine = defaultModel
    ? `    模型 id     上表任选一个；不填 model 时用代理默认：${defaultModel}`
    : `    模型 id     清单里的任意 id（完整清单：控制台 [6] 或 node scripts/models.js）`;

  return [
    `  ${RULE}`,
    '  Agent / 客户端接入配置（OpenAI 兼容三件套）',
    `  ${RULE}`,
    '',
    `    Base URL    ${baseUrl}`,
    '    API Key     任意值（服务不校验；客户端强制必填时填 local）',
    modelLine,
    '',
    '  常见 agent 的填法：',
    '  · Cherry Studio / ChatBox / LobeChat 等聊天客户端：',
    '      设置 → 模型服务 → 添加提供方，类型选 OpenAI 兼容；',
    `      API 地址填上面的 Base URL（客户端自动补 /v1 的填 ${host}），`,
    '      密钥填 local，再手动添加模型 id。',
    '  · Cline / Roo Code（VS Code 编码 agent）：',
    '      API Provider 选 OpenAI Compatible，',
    '      Base URL / API Key / Model ID 按三件套填。',
    '  · aider（终端编码 agent）：',
    `      aider --openai-api-base ${baseUrl} --openai-api-key local --model openai/<模型id>`,
    '  · Open WebUI / Dify 等自建平台：',
    '      渠道类型选 OpenAI，接口地址 = Base URL，密钥任意，模型列表填上表 id。',
    '',
    '  验证（curl，把 <模型id> 换成上表任意 id；Git Bash / Linux）：',
    `    curl ${baseUrl}/chat/completions -H "Content-Type: application/json" -d '{"model":"<模型id>","messages":[{"role":"user","content":"hi"}]}'`,
    '',
    '  提示：',
    '  · 优先用 x0.00 的免费模型；收费模型按系数消耗积分。',
    '  · 不同 API Key（乱填也算不同）会隔离各自的会话池，同一客户端固定用一个。',
    '  · 客户端发不了 Authorization 头时，可用查询参数 ?apiKey=xxx 等效隔离。',
    '  · 其他设备接入：服务以 HOST=0.0.0.0 启动，并把 127.0.0.1 换成本机 IP。',
    ''
  ];
}
