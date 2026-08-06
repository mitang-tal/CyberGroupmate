<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { termZh, translateReasoning } from '../lib/i18n.js';

  let activeSection = 'simulation';
  const SECTIONS = [
    { id: 'simulation', label: '沙盒推演' },
    { id: 'reputation', label: 'Agent 声誉' },
    { id: 'self-test', label: 'Meta 自检' },
    { id: 'failure', label: '失败智能' },
  ];

  // ─── Simulation ───
  let simTrigger = '';
  let simTaskType = '';
  let simCategory = '';
  let simResult = null;
  let simLoading = false;
  let simError = '';
  let simMetrics = null;

  // ─── Reputation ───
  let reputationAgents = [];
  let reputationLoading = false;
  let evalAgentId = '';
  let evalAgentName = '';
  let evalExecutions = 10;
  let evalAlerts = 0;
  let evalFailures = 0;
  let evalResult = null;
  let evalLoading = false;
  let evalError = '';

  // ─── Self-Test ───
  let testReport = null;
  let testHistory = [];
  let testLoading = false;
  let testRunning = false;

  // ─── Failure Intelligence ───
  let patterns = [];
  let patternsLoading = false;
  let extractTrigger = '';
  let extractSymptom = '';
  let extractRootCause = '';
  let extractCategory = 'tool_capability_mismatch';
  let extractResult = null;
  let extractError = '';
  let extractLoading = false;
  let injectDispatchTaskType = '';
  let injectDispatchResult = null;
  let injectDispatchLoading = false;
  let injectReplanExecutionId = '';
  let injectReplanMethod = '';
  let injectReplanResult = null;
  let injectReplanLoading = false;
  const CATEGORIES = ['tool_capability_mismatch', 'parameter_invalid', 'resource_exhausted', 'logic_deadlock'];

  onMount(() => {
    refreshAll();
  });

  async function refreshAll() {
    await Promise.allSettled([
      refreshSimulationMetrics(),
      refreshReputation(),
      refreshSelfTest(),
      refreshPatterns(),
    ]);
  }

  // ─── Simulation ───
  async function refreshSimulationMetrics() {
    try {
      simMetrics = await api('/simulation/metrics');
    } catch (err) { console.error('Simulation metrics error:', err); }
  }

  async function runSimulation() {
    if (!simTrigger.trim()) { simError = 'triggerContext 必填'; return; }
    simLoading = true;
    simError = '';
    simResult = null;
    try {
      simResult = await api('/simulation/run', {
        method: 'POST',
        body: {
          triggerContext: simTrigger.trim(),
          taskType: simTaskType.trim() || undefined,
          category: simCategory.trim() || undefined,
        },
      });
      await refreshSimulationMetrics();
    } catch (err) {
      simError = String(err);
    } finally {
      simLoading = false;
    }
  }

  // ─── Reputation ───
  async function refreshReputation() {
    reputationLoading = true;
    try {
      const data = await api('/reputation/agents');
      reputationAgents = Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('Reputation load error:', err);
    } finally {
      reputationLoading = false;
    }
  }

  async function runEvaluation() {
    if (!evalAgentId.trim() || !evalAgentName.trim()) {
      evalError = 'agentId 与 agentName 必填';
      return;
    }
    evalLoading = true;
    evalError = '';
    evalResult = null;
    try {
      evalResult = await api('/reputation/evaluate', {
        method: 'POST',
        body: {
          agentId: evalAgentId.trim(),
          agentName: evalAgentName.trim(),
          executions: Array.from({ length: Math.max(0, evalExecutions) }, (_, i) => ({
            capabilityId: `cap_${i % 3}`,
            capabilityName: ['code', 'media', 'memory'][i % 3],
            success: i % 10 >= evalFailures,
            latencyMs: 1000 + (i % 5) * 500,
            timestampMs: Date.now() - i * 60000,
          })),
          alerts: evalAlerts,
          failures: evalFailures,
        },
      });
      await refreshReputation();
    } catch (err) {
      evalError = String(err);
    } finally {
      evalLoading = false;
    }
  }

  // ─── Self-Test ───
  async function refreshSelfTest() {
    testLoading = true;
    try {
      const [report, history] = await Promise.all([
        api('/meta-test/report/latest').catch(() => null),
        api('/meta-test/history?limit=10').catch(() => []),
      ]);
      testReport = report || null;
      testHistory = Array.isArray(history) ? history : [];
    } catch (err) {
      console.error('Self-test load error:', err);
    } finally {
      testLoading = false;
    }
  }

  async function runSelfTest() {
    testRunning = true;
    try {
      const report = await api('/meta-test/run', { method: 'POST' });
      testReport = report;
      await refreshSelfTest();
    } catch (err) {
      console.error('Self-test run error:', err);
    } finally {
      testRunning = false;
    }
  }

  // ─── Failure Intelligence ───
  async function refreshPatterns() {
    patternsLoading = true;
    try {
      const data = await api('/experience/patterns');
      patterns = Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('Patterns load error:', err);
    } finally {
      patternsLoading = false;
    }
  }

  async function extractFailure() {
    if (!extractTrigger.trim() || !extractSymptom.trim() || !extractRootCause.trim()) {
      extractError = 'triggerContext / symptom / rootCause 必填';
      return;
    }
    extractLoading = true;
    extractError = '';
    extractResult = null;
    try {
      extractResult = await api('/experience/extract', {
        method: 'POST',
        body: {
          triggerContext: extractTrigger.trim(),
          symptom: extractSymptom.trim(),
          rootCause: extractRootCause.trim(),
          category: extractCategory,
        },
      });
      await refreshPatterns();
    } catch (err) {
      extractError = String(err);
    } finally {
      extractLoading = false;
    }
  }

  async function runDecay() {
    try {
      await api('/experience/decay', { method: 'POST' });
      await refreshPatterns();
    } catch (err) { console.error(err); }
  }

  async function injectDispatch() {
    if (!injectDispatchTaskType.trim()) return;
    injectDispatchLoading = true;
    injectDispatchResult = null;
    try {
      injectDispatchResult = await api('/experience/inject-dispatch', {
        method: 'POST',
        body: { taskType: injectDispatchTaskType.trim() },
      });
    } catch (err) {
      injectDispatchResult = { error: String(err) };
    } finally {
      injectDispatchLoading = false;
    }
  }

  async function injectReplan() {
    if (!injectReplanExecutionId.trim() || !injectReplanMethod.trim()) return;
    injectReplanLoading = true;
    injectReplanResult = null;
    try {
      injectReplanResult = await api('/experience/inject-replan', {
        method: 'POST',
        body: { executionId: injectReplanExecutionId.trim(), failedStepMethod: injectReplanMethod.trim() },
      });
    } catch (err) {
      injectReplanResult = { error: String(err) };
    } finally {
      injectReplanLoading = false;
    }
  }

  // ─── Helpers ───
  function trustClass(state) {
    switch (state) {
      case 'trusted': return 'badge-success';
      case 'normal': return 'badge-info';
      case 'probation': return 'badge-warning';
      case 'untrusted': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  function healthClass(status) {
    switch (status) {
      case 'healthy': return 'badge-success';
      case 'degraded': return 'badge-warning';
      case 'critical': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  function probeClass(category) {
    switch (category) {
      case 'deadlock': return 'badge-info';
      case 'guardrail': return 'badge-primary';
      case 'rigidity': return 'badge-warning';
      case 'kill_switch': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  function expStatusClass(s) {
    switch (s) {
      case 'active': return 'badge-success';
      case 'decayed': return 'badge-warning';
      case 'expired': return 'badge-error';
      case 'revoked': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  function fmtTime(ts) {
    return ts ? new Date(ts).toLocaleString() : '-';
  }

  function pct(v) {
    if (v == null) return '-';
    return `${Math.round(v * 100)}%`;
  }

  function fmtMs(ms) {
    if (ms == null) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function short(text, len = 80) {
    const s = String(text || '');
    return s.length > len ? `${s.slice(0, len)}…` : s;
  }

  function isPattern(item) {
    return !!item.patternId;
  }

  function isExperience(item) {
    return !!item.experienceId;
  }
</script>

<div class="space-y-4">
  <!-- Section Tabs -->
  <div class="tabs tabs-box bg-base-100">
    {#each SECTIONS as sec}
      <button
        class="tab tab-sm"
        class:tab-active={activeSection === sec.id}
        onclick={() => activeSection = sec.id}
      >{sec.label}</button>
    {/each}
    <button class="btn btn-xs btn-ghost ml-auto" title="刷新全部" onclick={refreshAll}>
      <i class="fa-solid fa-rotate"></i>
    </button>
  </div>

  {#if activeSection === 'simulation'}
    <!-- ─── Simulation Center ─── -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="stat bg-base-100 rounded p-3">
        <div class="stat-title text-xs">推演次数</div>
        <div class="stat-value text-xl">{simMetrics?.totalSimulations ?? 0}</div>
      </div>
      <div class="stat bg-base-100 rounded p-3">
        <div class="stat-title text-xs">经验命中</div>
        <div class="stat-value text-xl text-primary">{simMetrics?.totalHits ?? 0}</div>
      </div>
      <div class="stat bg-base-100 rounded p-3">
        <div class="stat-title text-xs">避免错误</div>
        <div class="stat-value text-xl text-success">{simMetrics?.avoidedErrors ?? 0}</div>
      </div>
      <div class="stat bg-base-100 rounded p-3">
        <div class="stat-title text-xs">经验 ROI</div>
        <div class="stat-value text-xl">{simMetrics?.experienceROI ?? 0}%</div>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">运行推演</h3>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">触发上下文 *</span></label>
            <input class="input input-sm input-bordered" bind:value={simTrigger} placeholder="如 telegram_media_send 失败" />
          </div>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">任务类型</span></label>
            <input class="input input-sm input-bordered" bind:value={simTaskType} placeholder="如 telegram_media_send" />
          </div>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">能力分类</span></label>
            <input class="input input-sm input-bordered" bind:value={simCategory} placeholder="如 media" />
          </div>
          <button class="btn btn-sm btn-primary mt-3" onclick={runSimulation} disabled={simLoading}>
            {#if simLoading}<span class="loading loading-spinner loading-xs"></span>{/if}
            开始推演
          </button>
          {#if simError}
            <div class="alert alert-error py-2 text-xs mt-3">{simError}</div>
          {/if}
        </div>
      </div>

      <div class="card bg-base-100 md:col-span-2">
        <div class="card-body p-4">
          <div class="flex items-center gap-2 mb-3">
            <h3 class="card-title text-sm">推演结果</h3>
            <button class="btn btn-xs btn-outline ml-auto" onclick={refreshSimulationMetrics}>刷新指标</button>
          </div>
          {#if simResult}
            {@const st = translateReasoning(simResult.reasoningText)}
            <div class="text-xs mb-3">
              <div class="font-bold mb-1">推理过程</div>
              <div class="opacity-80 bg-base-200 rounded p-2 whitespace-pre-wrap break-words">{st.zh}</div>
              {#if st.translated}
                <div class="opacity-40 text-[10px] mt-1 whitespace-pre-wrap break-words">EN: {st.en}</div>
              {/if}
            </div>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
              {#each simResult.optionsEvaluated || [] as opt}
                <div
                  class="border rounded p-3 text-xs"
                  class:border-success={opt.optionId === simResult.selectedOptionId}
                  class:border-base-300={opt.optionId !== simResult.selectedOptionId}
                >
                  <div class="flex items-center justify-between gap-1 mb-1">
                    <span class="font-bold truncate">{opt.name}</span>
                    {#if opt.optionId === simResult.selectedOptionId}
                      <span class="badge badge-xs badge-success shrink-0">选中</span>
                    {/if}
                  </div>
                  <div class="opacity-60 mb-1">类型: {opt.actionType}</div>
                  <div class="space-y-1">
                    <div class="flex justify-between"><span class="opacity-50">成功率</span><b>{pct(opt.predictedSuccessRate)}</b></div>
                    <div class="flex justify-between"><span class="opacity-50">成本</span>{opt.estimatedCostToken} tokens</div>
                    <div class="flex justify-between"><span class="opacity-50">延迟</span>{fmtMs(opt.estimatedLatencyMs)}</div>
                    <div class="flex justify-between"><span class="opacity-50">评分</span><b class="text-primary">{opt.overallScore}</b></div>
                  </div>
                  {#if (opt.riskFactors || []).length}
                    <div class="mt-2">
                      <div class="font-bold mb-1 text-warning">风险因素</div>
                      {#each opt.riskFactors as rf}
                        <div class="text-warning/80">• {rf}</div>
                      {/each}
                    </div>
                  {/if}
                  {#if (opt.matchedExperienceIds || []).length}
                    <div class="mt-2">
                      <span class="badge badge-xs badge-info">命中 {opt.matchedExperienceIds.length} 条经验</span>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <div class="text-xs opacity-60 py-6 text-center">填写左侧表单开始一次沙盒推演</div>
          {/if}
        </div>
      </div>
    </div>

  {:else if activeSection === 'reputation'}
    <!-- ─── Agent Reputation ─── -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">声誉评估</h3>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">Agent ID *</span></label>
            <input class="input input-sm input-bordered" bind:value={evalAgentId} placeholder="如 subagent-worker" />
          </div>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">Agent 名称 *</span></label>
            <input class="input input-sm input-bordered" bind:value={evalAgentName} placeholder="如 subagent-worker" />
          </div>
          <div class="grid grid-cols-3 gap-2 mt-2">
            <div class="form-control">
              <label class="label py-1"><span class="label-text text-xs">执行数</span></label>
              <input class="input input-sm input-bordered" type="number" min="0" bind:value={evalExecutions} />
            </div>
            <div class="form-control">
              <label class="label py-1"><span class="label-text text-xs">告警数</span></label>
              <input class="input input-sm input-bordered" type="number" min="0" bind:value={evalAlerts} />
            </div>
            <div class="form-control">
              <label class="label py-1"><span class="label-text text-xs">失败数</span></label>
              <input class="input input-sm input-bordered" type="number" min="0" bind:value={evalFailures} />
            </div>
          </div>
          <button class="btn btn-sm btn-primary mt-3" onclick={runEvaluation} disabled={evalLoading}>
            {#if evalLoading}<span class="loading loading-spinner loading-xs"></span>{/if}
            评估
          </button>
          {#if evalError}
            <div class="alert alert-error py-2 text-xs mt-3">{evalError}</div>
          {/if}
          {#if evalResult}
            <div class="border border-base-300 rounded p-3 mt-3 text-xs space-y-1">
              <div class="font-bold mb-1">评估结果</div>
              <div><span class="opacity-50">信任状态:</span> <span class="badge badge-xs {trustClass(evalResult.trustState)}">{termZh(evalResult.trustState)}</span></div>
              <div><span class="opacity-50">信任分:</span> <b>{pct(evalResult.trustScore)}</b></div>
              <div><span class="opacity-50">可靠性:</span> {pct(evalResult.reliability)}</div>
              <div><span class="opacity-50">风险概率:</span> {pct(evalResult.riskProbability)}</div>
              <div><span class="opacity-50">总执行:</span> {evalResult.totalExecutions}</div>
              {#if evalResult.probationUntilMs}
                <div><span class="opacity-50">考察期至:</span> {fmtTime(evalResult.probationUntilMs)}</div>
              {/if}
            </div>
          {/if}
        </div>
      </div>

      <div class="card bg-base-100 md:col-span-2">
        <div class="card-body p-4">
          <div class="flex items-center gap-2 mb-3">
            <h3 class="card-title text-sm">Agent 声誉列表
              <span class="badge badge-sm badge-ghost ml-1">{reputationAgents.length}</span>
              {#if reputationLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
            </h3>
            <button class="btn btn-xs btn-outline ml-auto" onclick={refreshReputation}>刷新</button>
          </div>
          {#if reputationAgents.length}
            <div class="overflow-x-auto">
              <table class="table table-xs">
                <thead><tr>
                  <th>Agent</th><th>信任状态</th><th>信任分</th><th>可靠性</th><th>风险</th><th>执行</th><th>失败</th><th>能力</th>
                </tr></thead>
                <tbody>
                  {#each reputationAgents as a}
                    <tr>
                      <td class="text-xs">
                        <div class="font-semibold">{a.agentName}</div>
                        <div class="font-mono opacity-50">{a.agentId}</div>
                      </td>
                      <td><span class="badge badge-xs {trustClass(a.trustState)}">{termZh(a.trustState)}</span></td>
                      <td><b>{pct(a.trustScore)}</b></td>
                      <td>{pct(a.reliability)}</td>
                      <td class="text-error">{pct(a.riskProbability)}</td>
                      <td>{a.totalExecutions}</td>
                      <td>{a.totalFailures}</td>
                      <td>
                        <div class="flex flex-wrap gap-1 max-w-[180px]">
                          {#each a.capabilityScores || [] as cs}
                            <span class="badge badge-xs badge-ghost" title="{cs.capabilityName}: {pct(cs.mastery)}">
                              {cs.capabilityName}
                            </span>
                          {/each}
                        </div>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="text-xs opacity-60">暂无声誉数据（可左侧评估一个 Agent）</div>
          {/if}
        </div>
      </div>
    </div>

  {:else if activeSection === 'self-test'}
    <!-- ─── Meta Self-Test ─── -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">自检概览</h3>
          {#if testReport}
            <div class="text-center py-4">
              <div class="text-4xl mb-2">{Math.round(testReport.overallHealthScore * 100)}</div>
              <span class="badge badge-lg {healthClass(testReport.status)}">{termZh(testReport.status)}</span>
              <div class="text-xs opacity-60 mt-2">更新时间: {fmtTime(testReport.createdAtMs)}</div>
            </div>
          {:else if testLoading}
            <div class="py-8 text-center"><span class="loading loading-spinner loading-md"></span></div>
          {:else}
            <div class="text-xs opacity-60 py-6 text-center">尚无自检报告</div>
          {/if}
          <button class="btn btn-sm btn-primary w-full mt-2" onclick={runSelfTest} disabled={testRunning}>
            {#if testRunning}<span class="loading loading-spinner loading-xs"></span>{/if}
            运行全套自检
          </button>
        </div>
      </div>

      <div class="card bg-base-100 md:col-span-2">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">探针结果
            {#if testLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
          </h3>
          {#if testReport?.probeResults?.length}
            <div class="space-y-2 mt-2">
              {#each testReport.probeResults as probe}
                {@const pd = translateReasoning(probe.details)}
                <div class="border border-base-300 rounded p-3">
                  <div class="flex items-center gap-2">
                    <span class="badge badge-xs {probeClass(probe.category)}">{termZh(probe.category)}</span>
                    <span class="font-semibold text-xs">{termZh(probe.probeName)}</span>
                    <span class="badge badge-xs ml-auto" class:badge-success={probe.passed} class:badge-error={!probe.passed}>
                      {probe.passed ? '通过' : '失败'}
                    </span>
                  </div>
                  <div class="flex items-center gap-2 mt-2">
                    <span class="text-xs opacity-50">得分:</span>
                    <div class="flex-1 h-2 bg-base-200 rounded overflow-hidden">
                      <div
                        class="h-full rounded"
                        class:bg-success={probe.passed}
                        class:bg-error={!probe.passed}
                        style="width:{Math.round(probe.score * 100)}%"
                      ></div>
                    </div>
                    <span class="text-xs">{Math.round(probe.score * 100)}%</span>
                  </div>
                  <div class="text-xs opacity-70 mt-1 whitespace-pre-wrap break-words">{pd.zh}</div>
                  {#if pd.translated}
                    <div class="opacity-40 text-[10px] whitespace-pre-wrap break-words">EN: {pd.en}</div>
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <div class="text-xs opacity-60 mt-2">运行自检后显示探针结果</div>
          {/if}

          {#if testReport?.recommendations?.length}
            <div class="mt-4">
              <div class="text-xs font-bold mb-1">建议</div>
              <div class="space-y-1">
                {#each testReport.recommendations as rec}
                  {@const rc = translateReasoning(rec)}
                  <div class="text-xs alert alert-info py-1.5">
                    <div class="w-full">
                      <div>{rc.zh}</div>
                      {#if rc.translated}
                        <div class="opacity-50 text-[10px]">EN: {rc.en}</div>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          {#if testHistory.length}
            <div class="mt-4">
              <div class="text-xs font-bold mb-1">历史报告</div>
              <div class="flex flex-wrap gap-1">
                {#each testHistory as h}
                  <span class="badge badge-sm {healthClass(h.status)}" title="{fmtTime(h.createdAtMs)}">
                    {Math.round(h.overallHealthScore * 100)} · {termZh(h.status)} · {fmtTime(h.createdAtMs)}
                  </span>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>

  {:else if activeSection === 'failure'}
    <!-- ─── Failure Intelligence ─── -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">抽取失败经验</h3>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">触发上下文 *</span></label>
            <input class="input input-sm input-bordered" bind:value={extractTrigger} placeholder="如 telegram_media_send" />
          </div>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">症状 *</span></label>
            <input class="input input-sm input-bordered" bind:value={extractSymptom} placeholder="如 unknown_method" />
          </div>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">根因 *</span></label>
            <input class="input input-sm input-bordered" bind:value={extractRootCause} placeholder="如 调用了废弃接口" />
          </div>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">分类</span></label>
            <select class="select select-xs select-bordered" bind:value={extractCategory}>
              {#each CATEGORIES as c}<option value={c}>{termZh(c)}</option>{/each}
            </select>
          </div>
          <button class="btn btn-sm btn-primary mt-3" onclick={extractFailure} disabled={extractLoading}>
            {#if extractLoading}<span class="loading loading-spinner loading-xs"></span>{/if}
            提取
          </button>
          {#if extractError}
            <div class="alert alert-error py-2 text-xs mt-3">{extractError}</div>
          {/if}
          {#if extractResult}
            <div class="border border-base-300 rounded p-3 mt-3 text-xs">
              <div class="font-bold mb-1">提取结果</div>
              <div><span class="opacity-50">Pattern ID:</span> <span class="font-mono break-all">{extractResult.pattern?.patternId}</span></div>
              <div><span class="opacity-50">置信度:</span> {pct(extractResult.pattern?.confidence)}</div>
              {#if extractResult.experience}
                <div class="mt-1"><span class="badge badge-xs badge-success">已生成经验</span></div>
              {/if}
            </div>
          {/if}

          <div class="divider my-2"></div>
          <h3 class="card-title text-sm">经验注入测试</h3>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">派发注入: 任务类型</span></label>
            <div class="flex gap-1">
              <input class="input input-sm input-bordered flex-1" bind:value={injectDispatchTaskType} placeholder="如 telegram_media_send" />
              <button class="btn btn-xs btn-outline" onclick={injectDispatch} disabled={injectDispatchLoading}>
                {#if injectDispatchLoading}<span class="loading loading-spinner loading-xs"></span>{/if}
                注入
              </button>
            </div>
          </div>
          {#if injectDispatchResult}
            <div class="border border-base-300 rounded p-2 mt-2 text-xs">
              {#if injectDispatchResult.error}
                <span class="text-error">{injectDispatchResult.error}</span>
              {:else}
                <div class="font-bold mb-1">约束</div>
                <div><span class="opacity-50">避免:</span> {injectDispatchResult.constraints?.avoid?.join(', ') || '无'}</div>
                <div><span class="opacity-50">偏好:</span> {injectDispatchResult.constraints?.prefer?.join(', ') || '无'}</div>
                <div><span class="opacity-50">命中经验:</span> {injectDispatchResult.experiences?.length || 0}</div>
              {/if}
            </div>
          {/if}
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">重规划注入: Execution ID</span></label>
            <input class="input input-sm input-bordered" bind:value={injectReplanExecutionId} placeholder="Execution ID" />
          </div>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">失败方法</span></label>
            <div class="flex gap-1">
              <input class="input input-sm input-bordered flex-1" bind:value={injectReplanMethod} placeholder="如 tool.call" />
              <button class="btn btn-xs btn-outline" onclick={injectReplan} disabled={injectReplanLoading}>
                {#if injectReplanLoading}<span class="loading loading-spinner loading-xs"></span>{/if}
                注入
              </button>
            </div>
          </div>
          {#if injectReplanResult}
            <div class="border border-base-300 rounded p-2 mt-2 text-xs">
              {#if injectReplanResult.error}
                <span class="text-error">{injectReplanResult.error}</span>
              {:else}
                <div class="font-bold mb-1">约束</div>
                <div><span class="opacity-50">避免:</span> {injectReplanResult.constraints?.avoid?.join(', ') || '无'}</div>
                <div><span class="opacity-50">偏好:</span> {injectReplanResult.constraints?.prefer?.join(', ') || '无'}</div>
              {/if}
            </div>
          {/if}
        </div>
      </div>

      <div class="card bg-base-100 md:col-span-2">
        <div class="card-body p-4">
          <div class="flex items-center gap-2 mb-3">
            <h3 class="card-title text-sm">失败模式 / 经验库
              <span class="badge badge-sm badge-ghost ml-1">{patterns.length}</span>
              {#if patternsLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
            </h3>
            <button class="btn btn-xs btn-outline ml-auto" onclick={refreshPatterns}>刷新</button>
            <button class="btn btn-xs btn-warning" onclick={runDecay}>执行衰减</button>
          </div>
          {#if patterns.length}
            <div class="space-y-2 max-h-[600px] overflow-y-auto pr-1">
              {#each patterns as item}
                <div class="border border-base-300 rounded p-3 text-xs">
                  {#if isPattern(item)}
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="badge badge-xs badge-info">模式</span>
                      <span class="font-semibold">{item.triggerContext}</span>
                      <span class="opacity-60">{item.symptom}</span>
                      <span class="ml-auto">
                        <span class="badge badge-xs badge-ghost">频率 {item.frequency}</span>
                        <span class="badge badge-xs badge-primary ml-1">{pct(item.confidence)}</span>
                      </span>
                    </div>
                    <div class="opacity-60 mt-1">根因: {item.rootCause} · 分类: {item.category}</div>
                  {:else if isExperience(item)}
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="badge badge-xs {expStatusClass(item.status)}">{termZh(item.status)}</span>
                      <span class="font-semibold">{item.context?.tool || item.patternId}</span>
                      {#if item.rule?.avoid}
                        <span class="badge badge-xs badge-error">避免: {item.rule.avoid}</span>
                      {/if}
                      {#if item.rule?.prefer}
                        <span class="badge badge-xs badge-success">偏好: {item.rule.prefer}</span>
                      {/if}
                      <span class="ml-auto">
                        <span class="badge badge-xs badge-ghost">{termZh(item.federationStatus)}</span>
                        <span class="badge badge-xs badge-primary ml-1">{pct(item.confidence)}</span>
                      </span>
                    </div>
                    <div class="opacity-60 mt-1">频率 {item.frequency} · 过期 {fmtTime(item.expiresAtMs)}</div>
                  {:else}
                    <div class="opacity-60">{JSON.stringify(item)}</div>
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <div class="text-xs opacity-60">暂无失败模式 / 经验数据</div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
