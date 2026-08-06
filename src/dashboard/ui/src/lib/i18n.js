/**
 * i18n.js — 治理中心英文推理 / 执行结果 → 中文展示
 *
 * 后端治理相关字符串（护栏 / Meta 决策 / 任务重规划）为确定性英文模板，
 * 这里做字典式中文翻译；翻译不覆盖的原文保留原样展示。
 */

const PHRASES = [
  // ─── Meta 决策推理 reasoningText ───
  [/Component "(.+?)" triggered critical alert\. Auto-degrading to prevent cascading failures\./,
    '组件 "$1" 触发严重告警，自动降级以防止级联故障。'],
  [/Component "(.+?)" has (\d+) alternative agents\. Re-routing traffic\./,
    '组件 "$1" 有 $2 个备选 Agent，正在重新路由流量。'],
  [/Component "(.+?)" exceeded timeout threshold\. Switching to strict mode with extended timeout and retry limit\./,
    '组件 "$1" 超过超时阈值，已切换至严格模式（延长超时并限制重试）。'],

  // ─── 护栏评估推理 reasoning ───
  [/All guardrails passed/, '所有护栏检查通过'],
  [/Kill switch is active\. All autonomous operations are suspended\./,
    'Kill switch 已激活，所有自主操作已暂停。'],
  [/Loop prevention triggered: (\d+) replans detected for execution (.+?) \(max (\d+)\)\. Replanning terminated\./,
    '循环预防触发：执行 $2 检测到 $1 次重规划（上限 $3），重规划已终止。'],
  [/Rate limit exceeded: (\d+) violations in last (\d+)s\./,
    '频率限制超限：最近 $2 秒内 $1 次违规。'],

  // ─── 任务重规划推理 reasoning ───
  [/Step "(.+?)" \((.+?)\) failed with status "(.+?)"/,
    '步骤 "$1"（$2）执行失败，状态 "$3"'],
  [/Replacing step with alternative implementation\. (\d+) preceding steps preserved\./,
    '用替代实现替换该步骤，前面 $1 个步骤已保留。'],
  [/Step is non-critical, skipping to continue execution chain\./,
    '该步骤非关键，跳过以继续执行链。'],
  [/Inserting fallback handler to recover from host call failure\./,
    '插入回退处理器以从主机调用失败中恢复。'],
  [/Truncating remaining chain\. (\d+) completed steps are sufficient\./,
    '截断剩余链路，已完成的 $1 个步骤已足够。'],

  // ─── Meta 决策执行结果 detail ───
  [/no trusted online agent matched for redispatch/,
    '重派发未匹配到可信在线 Agent'],
  [/redispatch target: (.+?) \((.+?)\) via (.+)/,
    '重派发目标：$1（$2）通过 $3'],
  [/no real executor wired for decision type "(.+?)"/,
    '决策类型 "$1" 尚未接线真实执行器'],
];

const TOKEN_ZH = {
  exact: '精确匹配',
  rule: '规则匹配',
  fallback: '兜底匹配',
  success: '成功',
  failure: '失败',
  pending: '待处理',
  verified: '已验证',
  blocked: '已阻止',
  terminated: '已终止',
};

/**
 * 翻译推理文本。返回 { zh, en, translated }：
 * - zh：中文（无法匹配时保留原文）
 * - en：英文原文（用于双语对照展示）
 * - translated：是否发生了翻译（zh !== en）
 */
export function translateReasoning(text) {
  if (text == null) return { zh: '', en: '', translated: false };
  const en = String(text);
  if (!en.trim()) return { zh: en, en, translated: false };
  let out = en;
  for (const [re, zh] of PHRASES) {
    out = out.replace(re, zh);
  }
  // 残余英文 token 兜底（如 matchType / actionTaken）
  out = out.replace(/\b(exact|rule|fallback|success|failure|pending|verified|blocked|terminated)\b/g, (m) => TOKEN_ZH[m] || m);
  return { zh: out, en, translated: out !== en };
}

/**
 * 解析并翻译 Meta 决策执行结果 JSON。
 * 返回 null 表示非 JSON（原样展示）。
 */
export function translateExecutionResult(jsonStr) {
  if (jsonStr == null) return null;
  let parsed;
  try {
    parsed = JSON.parse(String(jsonStr));
  } catch {
    return null;
  }
  const detail = translateReasoning(parsed.detail || '');
  return {
    outcome: TOKEN_ZH[parsed.outcome] || parsed.outcome || '',
    detailZh: detail.zh,
    detailEn: detail.en,
    translated: detail.translated,
    executionId: parsed.executionId,
    raw: parsed,
  };
}
