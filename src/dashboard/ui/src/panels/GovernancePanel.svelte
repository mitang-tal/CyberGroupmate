<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';

  let activeSection = 'capabilities';
  const SECTIONS = [
    { id: 'capabilities', label: '能力注册' },
    { id: 'meta-decisions', label: 'Meta 决策' },
    { id: 'replanning', label: '任务重规划' },
    { id: 'guardrails', label: '护栏治理' },
  ];

  // ─── Capabilities ───
  let agents = [];
  let topology = [];
  let agentsLoading = false;
  let selectedAgent = null;
  let selectedAgentLoading = false;

  // Dispatch test form
  let dispatchTaskType = '';
  let dispatchCategory = '';
  let dispatchTags = '';
  let dispatchResult = null;
  let dispatchLoading = false;
  let dispatchError = '';

  // ─── Meta Decisions ───
  let decisions = [];
  let decisionsLoading = false;
  let policyState = null;
  let decisionTypeFilter = '';
  let decisionStatusFilter = '';
  const DECISION_TYPES = ['switch_policy', 'redispatch', 'degrade', 'scale_agent'];
  const DECISION_STATUSES = ['proposed', 'approved', 'executing', 'executed', 'verified', 'rejected', 'failed'];
  let selectedDecision = null;

  // ─── Replanning ───
  let patches = [];
  let plans = [];
  let patchesLoading = false;
  let generateExecutionId = '';
  let generateFailedStepId = '';
  let generateResult = null;
  let generateLoading = false;
  let generateError = '';
  let applyResult = null;
  let applyLoading = false;

  // ─── Guardrails ───
  let killSwitch = { active: false };
  let policies = [];
  let violations = [];
  let guardrailsLoading = false;
  let evaluateSourceType = 'meta_decision';
  let evaluateSourceId = '';
  let evaluateResult = null;
  let evaluateLoading = false;
  let evaluateError = '';

  onMount(() => {
    refreshAll();
  });

  async function refreshAll() {
    await Promise.allSettled([
      refreshAgents(),
      refreshDecisions(),
      refreshPatches(),
      refreshGuardrails(),
    ]);
  }

  // ─── Capabilities ───
  async function refreshAgents() {
    agentsLoading = true;
    try {
      const [agentList, topo] = await Promise.all([
        api('/capabilities/agents'),
        api('/capabilities/topology'),
      ]);
      agents = Array.isArray(agentList) ? agentList : [];
      topology = Array.isArray(topo) ? topo : [];
      if (!selectedAgent && agents.length > 0) {
        await selectAgent(agents[0].agentId);
      }
    } catch (err) {
      console.error('Capabilities load error:', err);
    } finally {
      agentsLoading = false;
    }
  }

  async function selectAgent(agentId) {
    selectedAgentLoading = true;
    try {
      selectedAgent = await api(`/capabilities/agents/${agentId}`);
    } catch (err) {
      console.error('Agent detail load error:', err);
    } finally {
      selectedAgentLoading = false;
    }
  }

  async function setAgentStatus(agentId, status) {
    try {
      await api(`/capabilities/agents/${agentId}/status`, { method: 'POST', body: { status } });
      await refreshAgents();
    } catch (err) { console.error(err); }
  }

  async function runDispatch() {
    if (!dispatchTaskType.trim()) { dispatchError = 'taskType 必填'; return; }
    dispatchLoading = true;
    dispatchError = '';
    dispatchResult = null;
    try {
      const tags = dispatchTags.trim() ? dispatchTags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
      dispatchResult = await api('/capabilities/dispatch', {
        method: 'POST',
        body: { taskType: dispatchTaskType.trim(), category: dispatchCategory.trim() || undefined, tags },
      });
    } catch (err) {
      dispatchError = String(err);
    } finally {
      dispatchLoading = false;
    }
  }

  // ─── Meta Decisions ───
  async function refreshDecisions() {
    decisionsLoading = true;
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (decisionTypeFilter) params.set('decisionType', decisionTypeFilter);
      if (decisionStatusFilter) params.set('status', decisionStatusFilter);
      const [list, state] = await Promise.all([
        api(`/meta-decisions?${params.toString()}`),
        api('/meta-decisions/policy-state'),
      ]);
      decisions = Array.isArray(list) ? list : [];
      policyState = state || null;
    } catch (err) {
      console.error('Meta decisions load error:', err);
    } finally {
      decisionsLoading = false;
    }
  }

  async function evaluateNow() {
    try {
      const result = await api('/meta-decisions/evaluate', { method: 'POST' });
      await refreshDecisions();
      return result;
    } catch (err) { console.error(err); }
  }

  async function executeDecision(decisionId) {
    try {
      await api(`/meta-decisions/${decisionId}/execute`, { method: 'POST' });
      await refreshDecisions();
    } catch (err) { console.error(err); }
  }

  async function rejectDecision(decisionId) {
    try {
      await api(`/meta-decisions/${decisionId}/reject`, { method: 'POST' });
      await refreshDecisions();
    } catch (err) { console.error(err); }
  }

  // ─── Replanning ───
  async function refreshPatches() {
    patchesLoading = true;
    try {
      const [patchList, planList] = await Promise.all([
        api('/task-planner/patches'),
        api('/task-planner/plans'),
      ]);
      patches = Array.isArray(patchList) ? patchList : [];
      plans = Array.isArray(planList) ? planList : [];
    } catch (err) {
      console.error('Patches load error:', err);
    } finally {
      patchesLoading = false;
    }
  }

  async function generatePatch() {
    if (!generateExecutionId.trim() || !generateFailedStepId.trim()) {
      generateError = 'executionId 与 failedStepId 必填';
      return;
    }
    generateLoading = true;
    generateError = '';
    generateResult = null;
    try {
      generateResult = await api('/task-planner/generate-patch', {
        method: 'POST',
        body: { executionId: generateExecutionId.trim(), failedStepId: generateFailedStepId.trim() },
      });
      await refreshPatches();
    } catch (err) {
      generateError = String(err);
    } finally {
      generateLoading = false;
    }
  }

  async function applyPatch(patchId) {
    applyLoading = true;
    applyResult = null;
    try {
      applyResult = await api(`/task-planner/apply-patch/${patchId}`, { method: 'POST' });
      await refreshPatches();
    } catch (err) {
      applyResult = { error: String(err) };
    } finally {
      applyLoading = false;
    }
  }

  // ─── Guardrails ───
  async function refreshGuardrails() {
    guardrailsLoading = true;
    try {
      const [ks, pol, vio] = await Promise.all([
        api('/governance/kill-switch'),
        api('/governance/policies'),
        api('/governance/violations?limit=50'),
      ]);
      killSwitch = ks || { active: false };
      policies = Array.isArray(pol) ? pol : [];
      violations = Array.isArray(vio) ? vio : [];
    } catch (err) {
      console.error('Guardrails load error:', err);
    } finally {
      guardrailsLoading = false;
    }
  }

  async function toggleKillSwitch() {
    try {
      // Phase 4.1：kill-switch 唯一写入口收敛至 /governance-v2/kill-switch
      await api('/governance-v2/kill-switch', {
        method: 'POST',
        body: { active: !killSwitch.active, origin: 'dashboard', reason: 'manual kill-switch toggle' },
      });
      await refreshGuardrails();
    } catch (err) { console.error(err); }
  }

  async function runEvaluate() {
    if (!evaluateSourceId.trim()) { evaluateError = 'sourceId 必填'; return; }
    evaluateLoading = true;
    evaluateError = '';
    evaluateResult = null;
    try {
      evaluateResult = await api('/governance/evaluate', {
        method: 'POST',
        body: { sourceType: evaluateSourceType, sourceId: evaluateSourceId.trim() },
      });
      await refreshGuardrails();
    } catch (err) {
      evaluateError = String(err);
    } finally {
      evaluateLoading = false;
    }
  }

  // ─── Helpers ───
  function statusClass(status) {
    switch (status) {
      case 'online': return 'badge-success';
      case 'busy': return 'badge-warning';
      case 'offline': return 'badge-error';
      case 'maintenance': return 'badge-info';
      default: return 'badge-ghost';
    }
  }

  function decisionStatusClass(s) {
    switch (s) {
      case 'proposed': return 'badge-warning';
      case 'approved': return 'badge-info';
      case 'executing': return 'badge-info';
      case 'executed': return 'badge-success';
      case 'verified': return 'badge-success';
      case 'rejected': return 'badge-error';
      case 'failed': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  function decisionTypeClass(t) {
    switch (t) {
      case 'switch_policy': return 'badge-info';
      case 'redispatch': return 'badge-primary';
      case 'degrade': return 'badge-warning';
      case 'scale_agent': return 'badge-secondary';
      default: return 'badge-ghost';
    }
  }

  function openDecisionDetail(d) {
    selectedDecision = d;
  }

  function decisionFlow(s) {
    switch (s) {
      case 'proposed': return '提议';
      case 'approved': return '已批准';
      case 'executing': return '执行中';
      case 'executed': return '已执行';
      case 'verified': return '已验证';
      case 'rejected': return '已拒绝';
      case 'failed': return '失败';
      default: return s;
    }
  }

  function patchTypeClass(t) {
    switch (t) {
      case 'replace_step': return 'badge-info';
      case 'skip_step': return 'badge-warning';
      case 'insert_fallback_step': return 'badge-primary';
      case 'truncate_and_complete': return 'badge-secondary';
      default: return 'badge-ghost';
    }
  }

  function patchStatusClass(s) {
    switch (s) {
      case 'draft': return 'badge-warning';
      case 'applied': return 'badge-success';
      case 'discarded': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  function ruleTypeClass(t) {
    switch (t) {
      case 'budget_limit': return 'badge-warning';
      case 'rate_limit': return 'badge-info';
      case 'loop_prevention': return 'badge-primary';
      case 'kill_switch': return 'badge-error';
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

  function short(text, len = 80) {
    const s = String(text || '');
    return s.length > len ? `${s.slice(0, len)}…` : s;
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

  {#if activeSection === 'capabilities'}
    <!-- ─── Capability Registry ─── -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card bg-base-100 md:col-span-2">
        <div class="card-body p-4">
          <div class="flex items-center gap-2 mb-3">
            <h3 class="card-title text-sm">注册 Agent
              <span class="badge badge-sm badge-ghost ml-1">{agents.length}</span>
              {#if agentsLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
            </h3>
            <button class="btn btn-xs btn-outline ml-auto" onclick={refreshAgents}>刷新</button>
          </div>
          {#if agents.length}
            <div class="overflow-x-auto">
              <table class="table table-xs">
                <thead><tr>
                  <th>名称</th><th>状态</th><th>能力数</th><th>活跃任务</th><th>心跳</th><th>操作</th>
                </tr></thead>
                <tbody>
                  {#each agents as a}
                    <tr>
                      <td class="text-xs font-semibold">{a.name}</td>
                      <td><span class="badge badge-xs {statusClass(a.status)}">{a.status}</span></td>
                      <td>{a.capabilities?.length || 0}</td>
                      <td>{a.activeTaskCount}</td>
                      <td class="text-xs opacity-60">{fmtTime(a.lastHeartbeatAtMs)}</td>
                      <td>
                        <div class="flex gap-1">
                          <button class="btn btn-xs btn-outline" onclick={() => selectAgent(a.agentId)}>详情</button>
                          {#if a.status === 'online'}
                            <button class="btn btn-xs btn-warning" onclick={() => setAgentStatus(a.agentId, 'busy')}>置忙</button>
                            <button class="btn btn-xs btn-error" onclick={() => setAgentStatus(a.agentId, 'offline')}>下线</button>
                          {:else if a.status === 'busy'}
                            <button class="btn btn-xs btn-success" onclick={() => setAgentStatus(a.agentId, 'online')}>上线</button>
                          {:else if a.status === 'offline'}
                            <button class="btn btn-xs btn-success" onclick={() => setAgentStatus(a.agentId, 'online')}>上线</button>
                          {/if}
                        </div>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="text-xs opacity-60">暂无注册 Agent</div>
          {/if}
        </div>
      </div>

      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">Agent 详情
            {#if selectedAgentLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
          </h3>
          {#if selectedAgent}
            <div class="text-xs space-y-1.5 mt-2">
              <div><span class="opacity-50">ID:</span> <span class="font-mono break-all">{selectedAgent.agentId}</span></div>
              <div><span class="opacity-50">名称:</span> {selectedAgent.name}</div>
              <div><span class="opacity-50">状态:</span> <span class="badge badge-xs {statusClass(selectedAgent.status)}">{selectedAgent.status}</span></div>
              <div><span class="opacity-50">注册时间:</span> {fmtTime(selectedAgent.registeredAtMs)}</div>
              {#if selectedAgent.metadata}
                <div><span class="opacity-50">元数据:</span>
                  <pre class="bg-base-200 rounded p-2 mt-1 overflow-x-auto text-[10px]">{JSON.stringify(selectedAgent.metadata, null, 2)}</pre>
                </div>
              {/if}
              <div class="pt-2">
                <div class="font-bold mb-1">能力列表</div>
                {#if (selectedAgent.capabilities || []).length}
                  <div class="space-y-2">
                    {#each selectedAgent.capabilities as cap}
                      <div class="border border-base-300 rounded p-2">
                        <div class="font-semibold">{cap.name}</div>
                        <div class="opacity-60 mt-0.5">{cap.description}</div>
                        <div class="flex flex-wrap gap-1 mt-1">
                          <span class="badge badge-xs badge-info">{cap.category}</span>
                          {#each cap.tags || [] as t}<span class="badge badge-xs badge-ghost">{t}</span>{/each}
                        </div>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="opacity-60">无能力</div>
                {/if}
              </div>
            </div>
          {:else}
            <div class="text-xs opacity-60 mt-2">选择 Agent 查看详情</div>
          {/if}
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">能力拓扑</h3>
          {#if topology.length}
            <div class="mt-2 space-y-2">
              {#each topology as cat}
                <div class="border border-base-300 rounded p-2">
                  <div class="text-xs font-bold text-primary">{cat.category}</div>
                  <div class="flex flex-wrap gap-1 mt-1">
                    {#each cat.capabilities || [] as cap}
                      <span class="badge badge-sm badge-ghost">
                        {cap.name}
                        <span class="ml-1 opacity-50">×{cap.agentCount}</span>
                      </span>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {:else}
            <div class="text-xs opacity-60 mt-2">暂无拓扑数据</div>
          {/if}
        </div>
      </div>

      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">派发测试</h3>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">任务类型 taskType *</span></label>
            <input class="input input-sm input-bordered" bind:value={dispatchTaskType} placeholder="如 telegram_media_send" />
          </div>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">能力分类 category</span></label>
            <input class="input input-sm input-bordered" bind:value={dispatchCategory} placeholder="如 coding / media" />
          </div>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">标签 tags（逗号分隔）</span></label>
            <input class="input input-sm input-bordered" bind:value={dispatchTags} placeholder="如 python,shell" />
          </div>
          <button class="btn btn-sm btn-primary mt-3" onclick={runDispatch} disabled={dispatchLoading}>
            {#if dispatchLoading}<span class="loading loading-spinner loading-xs"></span>{/if}
            执行派发
          </button>
          {#if dispatchError}
            <div class="alert alert-error py-2 text-xs mt-3">{dispatchError}</div>
          {/if}
          {#if dispatchResult}
            <div class="border border-base-300 rounded p-3 mt-3 text-xs">
              <div class="font-bold mb-2">派发结果</div>
              <div class="space-y-1">
                <div><span class="opacity-50">Agent:</span> {dispatchResult.agentName} <span class="font-mono">({dispatchResult.agentId})</span></div>
                <div><span class="opacity-50">能力:</span> <span class="font-mono">{dispatchResult.capabilityId}</span></div>
                <div><span class="opacity-50">匹配方式:</span> <span class="badge badge-xs badge-info">{dispatchResult.matchType}</span></div>
                <div><span class="opacity-50">置信度:</span> {pct(dispatchResult.confidence)}</div>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>

  {:else if activeSection === 'meta-decisions'}
    <!-- ─── Meta Decisions ─── -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="stat bg-base-100 rounded p-3">
        <div class="stat-title text-xs">待执行决策</div>
        <div class="stat-value text-xl text-warning">{decisions.filter(d => d.status === 'proposed').length}</div>
      </div>
      <div class="stat bg-base-100 rounded p-3">
        <div class="stat-title text-xs">已执行/已验证</div>
        <div class="stat-value text-xl text-success">{decisions.filter(d => d.status === 'executed' || d.status === 'verified').length}</div>
      </div>
      <div class="stat bg-base-100 rounded p-3">
        <div class="stat-title text-xs">降级组件</div>
        <div class="stat-value text-xl text-error">{(policyState?.degradedComponents || []).length}</div>
      </div>
      <div class="stat bg-base-100 rounded p-3">
        <div class="stat-title text-xs">熔断组件</div>
        <div class="stat-value text-xl text-error">{(policyState?.circuitBrokenComponents || []).length}</div>
      </div>
    </div>

    <div class="card bg-base-100">
      <div class="card-body p-4">
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <h3 class="card-title text-sm">决策列表
            <span class="badge badge-sm badge-ghost ml-1">{decisions.length}</span>
            {#if decisionsLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
          </h3>
          <div class="ml-auto flex flex-wrap gap-2">
            <select class="select select-xs select-bordered" bind:value={decisionTypeFilter} onchange={() => refreshDecisions()}>
              <option value="">全部类型</option>
              {#each DECISION_TYPES as t}<option value={t}>{t}</option>{/each}
            </select>
            <select class="select select-xs select-bordered" bind:value={decisionStatusFilter} onchange={() => refreshDecisions()}>
              <option value="">全部状态</option>
              {#each DECISION_STATUSES as s}<option value={s}>{s}</option>{/each}
            </select>
            <button class="btn btn-xs btn-primary" onclick={evaluateNow}>立即评估</button>
            <button class="btn btn-xs btn-outline" onclick={() => refreshDecisions()}>刷新</button>
          </div>
        </div>

        {#if decisions.length}
          <div class="overflow-x-auto">
            <table class="table table-xs">
              <thead><tr>
                <th>类型</th><th>状态</th><th>目标组件</th><th>置信度</th><th>推理</th><th>时间</th><th>操作</th>
              </tr></thead>
              <tbody>
                {#each decisions as d}
                  <tr>
                    <td><span class="badge badge-xs {decisionTypeClass(d.decisionType)}">{d.decisionType}</span></td>
                    <td><span class="badge badge-xs {decisionStatusClass(d.status)}">{d.status}</span></td>
                    <td class="text-xs">{d.targetComponent}</td>
                    <td>{pct(d.confidenceScore)}</td>
                    <td class="text-xs max-w-[260px] truncate" title={d.reasoningText}>{short(d.reasoningText, 40)}</td>
                    <td class="text-xs opacity-60">{fmtTime(d.createdAtMs)}</td>
                    <td>
                      {#if d.status === 'proposed'}
                        <div class="flex gap-1">
                          <button class="btn btn-xs btn-success" onclick={() => executeDecision(d.decisionId)}>执行</button>
                          <button class="btn btn-xs btn-error" onclick={() => rejectDecision(d.decisionId)}>拒绝</button>
                          <button class="btn btn-xs btn-outline" onclick={() => openDecisionDetail(d)}>详情</button>
                        </div>
                      {:else}
                        <button class="btn btn-xs btn-outline" onclick={() => openDecisionDetail(d)}>详情</button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="text-xs opacity-60">暂无决策（点击「立即评估」触发系统评估）</div>
        {/if}
      </div>
    </div>

    {#if selectedDecision}
      <div class="modal modal-open">
        <div class="modal-box max-w-2xl">
          <div class="flex items-center justify-between mb-2">
            <h3 class="card-title text-sm">决策详情</h3>
            <button class="btn btn-xs btn-circle btn-ghost" onclick={() => selectedDecision = null}>✕</button>
          </div>
          <div class="flex items-center gap-2 mb-4 text-xs">
            <span class="badge badge-xs"
              class:badge-warning={selectedDecision.status === 'proposed'}
              class:badge-success={selectedDecision.status === 'executed'}
              class:badge-error={selectedDecision.status === 'rejected' || selectedDecision.status === 'failed'}>
              {decisionFlow(selectedDecision.status)}
            </span>
            <span class="opacity-30">→</span>
            <span class="opacity-50">决策 ID: {selectedDecision.decisionId}</span>
          </div>
          <div class="grid grid-cols-2 gap-2 text-xs mb-3">
            <div><div class="opacity-50">类型</div><span class="badge badge-xs {decisionTypeClass(selectedDecision.decisionType)}">{selectedDecision.decisionType}</span></div>
            <div><div class="opacity-50">状态</div><span class="badge badge-xs {decisionStatusClass(selectedDecision.status)}">{selectedDecision.status}</span></div>
            <div><div class="opacity-50">目标组件</div>{selectedDecision.targetComponent}</div>
            <div><div class="opacity-50">置信度</div>{pct(selectedDecision.confidenceScore)}</div>
            <div><div class="opacity-50">触发事件</div>{selectedDecision.triggerEvent?.eventType} ({selectedDecision.triggerEvent?.sourceId})</div>
            <div><div class="opacity-50">创建时间</div>{fmtTime(selectedDecision.createdAtMs)}</div>
            {#if selectedDecision.executedAtMs}
              <div><div class="opacity-50">执行时间</div>{fmtTime(selectedDecision.executedAtMs)}</div>
            {/if}
          </div>
          <div class="text-xs mb-3">
            <div class="font-bold mb-1">推理过程</div>
            <div class="bg-base-200 rounded p-2">{selectedDecision.reasoningText}</div>
          </div>
          {#if selectedDecision.actionParams}
            <div class="text-xs mb-3">
              <div class="font-bold mb-1">执行参数</div>
              <pre class="bg-base-200 rounded p-2 overflow-x-auto text-[10px]">{JSON.stringify(selectedDecision.actionParams, null, 2)}</pre>
            </div>
          {/if}
          {#if selectedDecision.executionResult}
            <div class="text-xs">
              <div class="font-bold mb-1">执行结果</div>
              <div class="alert alert-success py-2">{selectedDecision.executionResult}</div>
            </div>
          {/if}
          {#if selectedDecision.status === 'proposed'}
            <div class="flex gap-2 mt-4">
              <button class="btn btn-sm btn-success" onclick={() => { executeDecision(selectedDecision.decisionId); selectedDecision = null; }}>执行</button>
              <button class="btn btn-sm btn-error" onclick={() => { rejectDecision(selectedDecision.decisionId); selectedDecision = null; }}>拒绝</button>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if policyState}
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">策略状态
            <span class="text-xs opacity-50 font-normal ml-2">上次评估: {fmtTime(policyState.lastEvaluatedAtMs)}</span>
          </h3>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
            <div>
              <div class="text-xs font-bold mb-1">活跃决策 ({policyState.activeDecisions?.length || 0})</div>
              {#if (policyState.activeDecisions || []).length}
                <div class="space-y-1">
                  {#each policyState.activeDecisions as ad}
                    <div class="text-xs border border-base-300 rounded p-1.5">
                      <span class="badge badge-xs {decisionTypeClass(ad.decisionType)}">{ad.decisionType}</span>
                      <span class="ml-1">{ad.targetComponent}</span>
                    </div>
                  {/each}
                </div>
              {:else}<div class="text-xs opacity-60">无</div>{/if}
            </div>
            <div>
              <div class="text-xs font-bold mb-1">降级组件 ({policyState.degradedComponents?.length || 0})</div>
              <div class="flex flex-wrap gap-1">
                {#each policyState.degradedComponents || [] as c}
                  <span class="badge badge-xs badge-warning">{c}</span>
                {:else}<span class="text-xs opacity-60">无</span>{/each}
              </div>
            </div>
            <div>
              <div class="text-xs font-bold mb-1">熔断组件 ({policyState.circuitBrokenComponents?.length || 0})</div>
              <div class="flex flex-wrap gap-1">
                {#each policyState.circuitBrokenComponents || [] as c}
                  <span class="badge badge-xs badge-error">{c}</span>
                {:else}<span class="text-xs opacity-60">无</span>{/each}
              </div>
            </div>
          </div>
        </div>
      </div>
    {/if}

  {:else if activeSection === 'replanning'}
    <!-- ─── Task Replanning ─── -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">生成 Patch</h3>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">Execution ID *</span></label>
            <input class="input input-sm input-bordered" bind:value={generateExecutionId} placeholder="从执行记录获取" />
          </div>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">失败 Step ID *</span></label>
            <input class="input input-sm input-bordered" bind:value={generateFailedStepId} placeholder="Trace 节点 ID" />
          </div>
          <button class="btn btn-sm btn-primary mt-3" onclick={generatePatch} disabled={generateLoading}>
            {#if generateLoading}<span class="loading loading-spinner loading-xs"></span>{/if}
            生成
          </button>
          {#if generateError}
            <div class="alert alert-error py-2 text-xs mt-3">{generateError}</div>
          {/if}
          {#if generateResult}
            <div class="border border-base-300 rounded p-3 mt-3 text-xs">
              <div class="font-bold mb-2">Patch 结果</div>
              <div class="space-y-1">
                <div><span class="opacity-50">Patch ID:</span> <span class="font-mono break-all">{generateResult.patchId}</span></div>
                <div><span class="opacity-50">类型:</span> <span class="badge badge-xs {patchTypeClass(generateResult.patchType)}">{generateResult.patchType}</span></div>
                <div><span class="opacity-50">状态:</span> <span class="badge badge-xs {patchStatusClass(generateResult.status)}">{generateResult.status}</span></div>
                <div><span class="opacity-50">推理:</span> {generateResult.reasoning}</div>
                {#if (generateResult.replacementSteps || []).length}
                  <div class="pt-1">
                    <div class="font-bold mb-1">替换步骤</div>
                    {#each generateResult.replacementSteps as step}
                      <div class="border border-base-300 rounded p-1.5 mb-1">
                        <div class="font-semibold">{step.stepName}</div>
                        <div class="opacity-60">{step.targetCapability}</div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
              <button class="btn btn-xs btn-success mt-3" onclick={() => applyPatch(generateResult.patchId)} disabled={applyLoading}>
                {#if applyLoading}<span class="loading loading-spinner loading-xs"></span>{/if}
                应用该 Patch
              </button>
              {#if applyResult}
                <div class="mt-2 p-2 bg-base-200 rounded">
                  {#if applyResult.error}
                    <span class="text-error">{applyResult.error}</span>
                  {:else}
                    <span class="text-success">已应用 ✓ planId: {applyResult.planId || '-'} 状态: {applyResult.status || '-'}</span>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>

      <div class="card bg-base-100 md:col-span-2">
        <div class="card-body p-4">
          <div class="flex items-center gap-2 mb-3">
            <h3 class="card-title text-sm">Patch 列表
              <span class="badge badge-sm badge-ghost ml-1">{patches.length}</span>
              {#if patchesLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
            </h3>
            <button class="btn btn-xs btn-outline ml-auto" onclick={refreshPatches}>刷新</button>
          </div>
          {#if patches.length}
            <div class="overflow-x-auto">
              <table class="table table-xs">
                <thead><tr>
                  <th>类型</th><th>状态</th><th>Execution</th><th>失败步骤</th><th>推理</th><th>时间</th><th>操作</th>
                </tr></thead>
                <tbody>
                  {#each patches as p}
                    <tr>
                      <td><span class="badge badge-xs {patchTypeClass(p.patchType)}">{p.patchType}</span></td>
                      <td><span class="badge badge-xs {patchStatusClass(p.status)}">{p.status}</span></td>
                      <td class="font-mono text-xs">{short(p.executionId, 16)}</td>
                      <td class="font-mono text-xs">{short(p.failedStepId, 16)}</td>
                      <td class="text-xs max-w-[200px] truncate" title={p.reasoning}>{short(p.reasoning, 30)}</td>
                      <td class="text-xs opacity-60">{fmtTime(p.createdAtMs)}</td>
                      <td>
                        {#if p.status === 'draft'}
                          <button class="btn btn-xs btn-success" onclick={() => applyPatch(p.patchId)} disabled={applyLoading}>应用</button>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="text-xs opacity-60">暂无 Patch（可在左侧表单对失败执行生成）</div>
          {/if}

          {#if plans.length}
            <div class="mt-4">
              <div class="text-xs font-bold mb-2">重规划方案 ({plans.length})</div>
              <div class="space-y-2">
                {#each plans as pl}
                  <div class="border border-base-300 rounded p-2 text-xs">
                    <div class="flex items-center gap-2">
                      <span class="font-mono">{short(pl.planId, 16)}</span>
                      <span class="badge badge-xs badge-ghost">{pl.status}</span>
                      <span class="opacity-50">Execution: {short(pl.executionId, 20)}</span>
                      <span class="opacity-50">补丁: {pl.patches?.length || 0}</span>
                      <span class="opacity-50">剩余步骤: {pl.remainingStepIds?.length || 0}</span>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>

  {:else if activeSection === 'guardrails'}
    <!-- ─── Governance & Guardrails ─── -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <div class="flex items-center justify-between">
            <h3 class="card-title text-sm">Kill Switch</h3>
            {#if guardrailsLoading}<span class="loading loading-spinner loading-xs"></span>{/if}
          </div>
          <div class="mt-3 text-center py-4">
            <div class="text-4xl mb-2">{killSwitch.active ? '🔴' : '🟢'}</div>
            <div class="font-bold mb-1 text-sm">{killSwitch.active ? '已激活' : '正常'}</div>
            <button
              class="btn btn-sm mt-2"
              class:btn-error={killSwitch.active}
              class:btn-success={!killSwitch.active}
              onclick={toggleKillSwitch}
            >
              {killSwitch.active ? '解除 Kill Switch' : '激活 Kill Switch'}
            </button>
          </div>
        </div>
      </div>

      <div class="card bg-base-100 md:col-span-2">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">策略列表
            <span class="badge badge-sm badge-ghost ml-1">{policies.length}</span>
          </h3>
          {#if policies.length}
            <div class="overflow-x-auto mt-2">
              <table class="table table-xs">
                <thead><tr><th>名称</th><th>规则类型</th><th>状态</th><th>配置</th></tr></thead>
                <tbody>
                  {#each policies as p}
                    <tr>
                      <td class="text-xs font-semibold">{p.name}</td>
                      <td><span class="badge badge-xs {ruleTypeClass(p.ruleType)}">{p.ruleType}</span></td>
                      <td><span class="badge badge-xs {p.status === 'active' ? 'badge-success' : 'badge-ghost'}">{p.status}</span></td>
                      <td class="text-xs opacity-60">{JSON.stringify(p.config || {})}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="text-xs opacity-60 mt-2">暂无策略</div>
          {/if}
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">护栏评估测试</h3>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">来源类型</span></label>
            <select class="select select-xs select-bordered" bind:value={evaluateSourceType}>
              <option value="meta_decision">meta_decision</option>
              <option value="task_patch">task_patch</option>
              <option value="dispatch">dispatch</option>
            </select>
          </div>
          <div class="form-control w-full mt-2">
            <label class="label py-1"><span class="label-text text-xs">Source ID *</span></label>
            <input class="input input-sm input-bordered" bind:value={evaluateSourceId} placeholder="任意标识" />
          </div>
          <button class="btn btn-sm btn-primary mt-3" onclick={runEvaluate} disabled={evaluateLoading}>
            {#if evaluateLoading}<span class="loading loading-spinner loading-xs"></span>{/if}
            评估
          </button>
          {#if evaluateError}
            <div class="alert alert-error py-2 text-xs mt-3">{evaluateError}</div>
          {/if}
          {#if evaluateResult}
            <div class="border border-base-300 rounded p-3 mt-3 text-xs">
              <div class="font-bold mb-1">评估结果</div>
              <div class="mb-1">
                {#if evaluateResult.allowed}
                  <span class="badge badge-xs badge-success">允许</span>
                {:else}
                  <span class="badge badge-xs badge-error">阻止</span>
                {/if}
              </div>
              <div class="opacity-60">{evaluateResult.reasoning}</div>
              {#if (evaluateResult.violatedPolicies || []).length}
                <div class="mt-2">
                  <div class="font-bold mb-1">违反策略</div>
                  {#each evaluateResult.violatedPolicies as v}
                    <div class="text-error">{v.ruleType}: {v.reasoning}</div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>

      <div class="card bg-base-100 md:col-span-2">
        <div class="card-body p-4">
          <div class="flex items-center gap-2 mb-3">
            <h3 class="card-title text-sm">违规记录
              <span class="badge badge-sm badge-ghost ml-1">{violations.length}</span>
            </h3>
            <button class="btn btn-xs btn-outline ml-auto" onclick={refreshGuardrails}>刷新</button>
          </div>
          {#if violations.length}
            <div class="overflow-x-auto">
              <table class="table table-xs">
                <thead><tr>
                  <th>规则类型</th><th>来源</th><th>动作</th><th>推理</th><th>时间</th>
                </tr></thead>
                <tbody>
                  {#each violations as v}
                    <tr>
                      <td><span class="badge badge-xs {ruleTypeClass(v.ruleType)}">{v.ruleType}</span></td>
                      <td class="text-xs">{v.sourceType} <span class="font-mono opacity-60">({short(v.sourceId, 14)})</span></td>
                      <td><span class="badge badge-xs badge-error">{v.actionTaken}</span></td>
                      <td class="text-xs max-w-[220px] truncate" title={v.reasoning}>{short(v.reasoning, 40)}</td>
                      <td class="text-xs opacity-60">{fmtTime(v.createdAtMs)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="text-xs opacity-60">暂无违规记录</div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
