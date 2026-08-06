/**
 * i18n.js — 治理中心英文推理 / 执行结果 → 中文展示
 *
 * 后端治理相关字符串（护栏 / Meta 决策 / 任务重规划 / 推演 / 自检 / 自愈）为确定性英文模板，
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

  // ─── 沙盒推演 reasoningText ───
  [/\[(.+)\] Evaluated (\d+) option\(s\) for "(.+?)"\./,
    '[$1] 为 "$3" 评估了 $2 个方案。'],
  [/Selected: "(.+?)" \(score=(.+), success=(\d+)%, cost=(\d+)tokens\)\./,
    '选中："$1"（评分=$2，成功率=$3%，成本=$4 tokens）。'],
  [/(\d+) experience rules applied\./,
    '应用了 $1 条经验规则。'],
  [/Avoided known failure patterns: (.+)\./,
    '已规避已知失败模式：$1。'],
  [/(\d+) experiences matched this option\./,
    '有 $1 条经验与该方案匹配。'],

  // ─── Meta 自检探针 details ───
  [/Deadlock detection: circular dispatch A→B→A correctly identified and blocked\./,
    '死锁检测：循环派发 A→B→A 被正确识别并阻断。'],
  [/Deadlock detection: no response or timeout - manual audit recommended\./,
    '死锁检测：无响应或超时——建议人工审计。'],
  [/Deadlock probe error: (.+)/,
    '死锁探针错误：$1'],
  [/Guardrail system not available - cannot test respect\./,
    '护栏系统不可用——无法测试遵守情况。'],
  [/Guardrail respect: Kill switch and loop prevention both correctly block Meta actions\./,
    '护栏遵守：Kill switch 与循环预防均正确阻止 Meta 操作。'],
  [/Guardrail partial failure: killSwitch=(.+), loopPrevention=(.+)\.,/,
    '护栏部分失败：killSwitch=$1, loopPrevention=$2。'],
  [/Guardrail probe error: (.+)/,
    '护栏探针错误：$1'],
  [/Experience system not available - rigidity check skipped\./,
    '经验系统不可用——跳过僵化检查。'],
  [/Over-constrained capabilities detected: (.+)\.,/,
    '检测到过度约束的能力：$1。'],
  [/Recommendation: review avoid rules for these capabilities\./,
    '建议：审查这些能力的避免规则。'],
  [/No rigidity detected\. (\d+) avoid rules across all capabilities\./,
    '未检测到僵化。全部能力共 $1 条避免规则。'],
  [/Rigidity probe error: (.+)/,
    '僵化探针错误：$1'],
  [/Guardrail system not available - self-kill test skipped\./,
    '护栏系统不可用——跳过自毁测试。'],
  [/Self-kill: Kill switch correctly blocked all actions \(meta_decision, task_patch, dispatch\) and restored after disengage\./,
    '自毁：Kill switch 正确阻止所有操作（meta_decision、task_patch、dispatch），解除后恢复正常。'],
  [/Self-kill partial: blocked=(.+), restored=(.+)\.,/,
    '自毁部分失败：blocked=$1, restored=$2。'],
  [/Self-kill probe error: (.+)/,
    '自毁探针错误：$1'],
  [/Deadlock detection failed: review CapabilityDispatcher route logic for circular dispatch paths\./,
    '死锁检测失败：请审查 CapabilityDispatcher 路由中的循环派发路径。'],
  [/Guardrail respect degraded: verify GlobalGuardrailEvaluator is wired into all decision entry points\./,
    '护栏遵守降级：请确认 GlobalGuardrailEvaluator 已接入所有决策入口。'],
  [/Experience rigidity detected: review avoid rules in Experience Store, consider decaying over-constrained rules\./,
    '检测到经验僵化：请审查经验库中的避免规则，考虑衰减过度约束的规则。'],
  [/Self-kill test failed: verify toggleKillSwitch\(\) correctly propagates to evaluateGuardrails\(\)\./,
    '自毁测试失败：请确认 toggleKillSwitch() 正确传播至 evaluateGuardrails()。'],
  [/All probes passed\. Meta health is nominal\./,
    '全部探针通过。Meta 健康正常。'],

  // ─── 自愈决策原因 decisionReason ───
  [/Guardrail limit reached: Exceeded (\d+) healing attempts in (\d+)min for execution (.+)/,
    '护栏限制已达：执行 $3 在 $2 分钟内自愈尝试超过 $1 次'],
  [/Auto-healing triggered: retry for (.+) on (.+)/,
    '自动自愈触发：对 $2 上的 $1 采用重试策略'],
  [/Auto-healing triggered: fallback for (.+) on (.+)/,
    '自动自愈触发：对 $2 上的 $1 采用回退策略'],
  [/Auto-healing triggered: meta_diagnosis for (.+) on (.+)/,
    '自动自愈触发：对 $2 上的 $1 采用 Meta 诊断策略'],
  [/Auto-healing triggered: escalate for (.+) on (.+)/,
    '自动自愈触发：对 $2 上的 $1 采用升级策略'],
  [/Auto-healing blocked: (.+)/,
    '自动自愈被阻止：$1'],

  // ─── Chaos 稳定性观测 ───
  [/System withstood (.+) on (.+)/,
    '系统在 $2 上经受住了 $1 故障'],
  [/System failed under (.+) on (.+)/,
    '系统在 $2 上因 $1 故障而失败'],
];

const TERMS = {
  // 执行记录状态
  pending: '待处理',
  running: '执行中',
  success: '成功',
  failure: '失败',
  interrupted: '中断',
  policy_denied: '策略拒绝',
  timed_out: '超时',
  // 来源
  sandbox: '沙盒',
  meta: 'Meta',
  adapter: '适配器',
  system: '系统',
  agent: 'Agent',
  host_call: '宿主调用',
  // 严重级别
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  // 告警状态
  active: '活跃',
  acknowledged: '已确认',
  resolved: '已解决',
  // 信任状态
  trusted: '可信',
  normal: '正常',
  probation: '考察',
  untrusted: '不可信',
  // 健康状态
  healthy: '健康',
  degraded: '降级',
  // 探针分类
  deadlock: '死锁',
  guardrail: '护栏',
  rigidity: '僵化',
  kill_switch: '熔断',
  // 经验状态
  decayed: '已衰减',
  expired: '已过期',
  revoked: '已撤销',
  // 联邦状态
  candidate: '候选',
  quarantined: '隔离',
  quarantine: '隔离',
  validated: '已验证',
  federated: '已联邦',
  // 自愈策略 / 状态
  retry: '重试',
  fallback: '回退',
  meta_diagnosis: 'Meta 诊断',
  escalate: '升级',
  succeeded: '已成功',
  in_progress: '进行中',
  // 演化提案状态
  pending_approval: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  // 探针名称
  'Deadlock & Loop Detection': '死锁与循环检测',
  'Guardrail Respect': '护栏遵守检查',
  'Experience Rigidity': '经验僵化检查',
  'Self-Kill Simulation': '自毁模拟',
  // 故障类型（稳定性）
  agent_offline: 'Agent 离线',
  tool_failure: '工具故障',
  llm_timeout: 'LLM 超时',
  host_call_error: '宿主调用错误',
  memory_corruption: '记忆损坏',
  // 匹配类型
  exact: '精确匹配',
  rule: '规则匹配',
  fallback: '兜底匹配',
  fallback_type: '兜底匹配',
  // 失败分类
  tool_capability_mismatch: '工具能力不匹配',
  parameter_invalid: '参数无效',
  resource_exhausted: '资源耗尽',
  logic_deadlock: '逻辑死锁',
  // Agent 状态
  online: '在线',
  busy: '忙碌',
  offline: '离线',
  maintenance: '维护',
  // Meta 决策类型 / 状态
  switch_policy: '切换策略',
  redispatch: '重派发',
  degrade: '降级',
  scale_agent: '扩展 Agent',
  executing: '执行中',
  executed: '已执行',
  verified: '已验证',
  failed: '失败',
  // Patch 类型 / 状态
  replace_step: '替换步骤',
  skip_step: '跳过步骤',
  insert_fallback_step: '插入回退步骤',
  truncate_and_complete: '截断并完成',
  draft: '草稿',
  applied: '已应用',
  discarded: '已丢弃',
  // 规则类型
  budget_limit: '预算限制',
  rate_limit: '频率限制',
  loop_prevention: '循环预防',
  // 违规处置动作
  blocked: '已阻止',
  terminated: '已终止',
};

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
 * 术语（枚举值）→ 中文。未命中返回原值（如 ID / 方法名等保留英文）。
 */
export function termZh(value) {
  if (value == null) return '';
  const s = String(value);
  return TERMS[s] || s;
}

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
  // 残余英文 token 兜底（如 matchType / actionTaken / strategy）
  out = out.replace(/\b(exact|rule|fallback|success|failure|pending|verified|blocked|terminated|retry|escalate)\b/g, (m) => TOKEN_ZH[m] || m);
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
    outcome: TERMS[parsed.outcome] || parsed.outcome || '',
    detailZh: detail.zh,
    detailEn: detail.en,
    translated: detail.translated,
    executionId: parsed.executionId,
    raw: parsed,
  };
}
