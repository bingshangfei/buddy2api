/**
 * model-policy.js — 模型 id 策略唯一 module interface（纯函数，无 IO 无状态）。
 *
 * 拆出理由：Anthropic 协议层（anthropic-protocol.js）也需要「代理默认模型」，
 * 而它又被 openai-handler.js 导入——若继续从 handler 导入会形成循环依赖。
 * 独立成模块后两条协议路径共用同一份默认值，避免 'hy4-preview-f' 字面量在两处漂移。
 *
 * 第三批（refactor-20260930-arch-deepening3 批1）补全为 model id 策略全归属：
 * default 解析 / 请求解析 / 回退排序 / 未公布免费 id 白名单 / 兜底列表——
 * router / index / 测试直连本模块，不再为 2 行纯函数加载 openai-handler 模块图。
 */

/**
 * 代理默认模型：客户端**没有**显式指定模型（或写 `auto` / `default`）时使用。
 *
 * 默认取免费的 `hy4-preview-f`。网关的 `auto` 会路由到收费模型——实测一条
 * 3.2k prompt 的极短请求扣 0.52 积分，而多数客户端习惯不带 model 或写 auto，
 * 放任不管等于默认烧积分。要恢复网关的自动路由，设
 * `BUDDY2API_DEFAULT_MODEL=auto`。
 */
export function resolveDefaultModel(env = process.env) {
  return env.BUDDY2API_DEFAULT_MODEL || 'hy4-preview-f';
}

/**
 * 解析客户端请求的模型：显式给了具体 id 就原样透传（不做映射/替换），
 * 只有缺省或 `auto`/`default` 才回落到代理默认模型。
 */
export function resolveRequestedModel(requested, fallback = resolveDefaultModel()) {
  return !requested || requested === 'auto' || requested === 'default' ? fallback : requested;
}

/**
 * 已知免费但不在网关列表的遗留 id：setModel 接受、实测 credit=0（2026-09-16 实测记录）。
 * 对这些 id 的「不在网关列表」告警降级为 info——原文案暗示会按 auto 计费，与实测不符。
 */
export const KNOWN_FREE_UNLISTED = new Set(['hy4-preview-f']);

/**
 * 兜底模型列表（动态列表不可用时使用；codebuddy --serve 实际模型以 session/new 为准）
 *
 * coefficient 抄自网关在模型 description 里的标注（x0.00 = 免费），仅作兜底展示；
 * 真实清单与计费以运行时 /v1/models 为准——不同账号套餐的可用模型和系数会不同。
 * 维护提示：这份列表要与 `node scripts/models.js` 的输出保持一致，否则兜底时会
 * 对外宣称根本不存在的模型 id。
 */
export const FALLBACK_MODELS = [
  { id: 'auto', name: 'Auto' },
  { id: 'hy4-preview-f', name: 'Hy4 preview', coefficient: 0, free: true },
  { id: 'hy3', name: 'Hy3', coefficient: 0, free: true },
  { id: 'hy3-x', name: 'Hy3', coefficient: 0.05, free: false },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', coefficient: 0.03, free: false },
  { id: 'glm-5.3', name: 'GLM-5.3', coefficient: 0.79, free: false },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', coefficient: 0.06, free: false },
  { id: 'glm-5.2', name: 'GLM-5.2', coefficient: 0.79, free: false },
  { id: 'glm-5.1', name: 'GLM-5.1', coefficient: 0.79, free: false },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', coefficient: 0.71, free: false },
  { id: 'minimax-m3', name: 'MiniMax-M3', coefficient: 0.25, free: false },
  { id: 'kimi-k3-1', name: 'Kimi-K3', coefficient: 1.62, free: false },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', coefficient: 0.57, free: false },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', coefficient: 0.52, free: false },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', coefficient: 0.51, free: false },
  { id: 'custom-local:deepseek-v4-flash', name: 'DeepSeek-V4 Flash' },
  { id: 'custom-local:qwen3.7-plus', name: 'qwen3.7-plus' }
];

/**
 * 从模型列表挑一个回退模型（用户指定模型服务异常时自动顶上）。
 *
 * 优先级（用户指定，字典序）：免费 > 费率低 > 多模态。
 *
 * @param {Array<{id,name,coefficient?,free?}>} models 模型列表（网关 configOptions 解析结果）
 * @param {string} failedModel 失败的模型 id（从候选中排除）
 * @returns {string|null} 回退模型 id；无可选时 null
 */
export function pickFallbackModel(models, failedModel) {
  if (!Array.isArray(models) || models.length === 0) return null;
  const candidates = models.filter(m => m && m.id && m.id !== failedModel);
  if (candidates.length === 0) return null;
  const multimodal = (m) => /vision|vl|multi|multimodal|多模态|image|图片|4v/i.test(`${m.id} ${m.name || ''}`);
  const key = (m) => [
    m.free ? 0 : 1,                                              // 1. 免费优先
    typeof m.coefficient === 'number' ? m.coefficient : Infinity, // 2. 费率低优先（未标注视为最贵）
    multimodal(m) ? 0 : 1                                        // 3. 多模态优先
  ];
  candidates.sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return 0;
  });
  return candidates[0].id;
}
