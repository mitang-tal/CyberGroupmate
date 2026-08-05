<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';

  // ─── Stability ───
  let chaosResults = { results: [], summary: null, activeInjections: [] };
  let chaosLoading = false;
  let suiteRunning = false;
  let chaosRunning = false;
  let recoveryRunning = false;
  let injectFaultType = 'tool_failure';
  let injectTarget = 'runtime';
  let injectDuration = 30000;
  let injectResult = null;
  let injectError = '';
  let injectLoading = false;
  let costUsage = null;
  const FAULT_TYPES = ['agent_offline', 'tool_failure', 'llm_timeout', 'host_call_error', 'memory_corruption'];

  onMount(() => {
    refreshChaos();
  });

  async function refreshChaos() {
    chaosLoading = true;
    try {
      const [chaos, cost] = await Promise.all([
        api('/validation/chaos-results').catch(() => null),
        api('/validation/cost-usage').catch(() => null),
      ]);
      chaosResults = chaos || { results: [], summary: null, activeInjections: [] };
      costUsage = cost || null;
    } catch (err) {
      console.error('Chaos load error:', err);
    } finally {
      chaosLoading = false;
    }
  }

  async function runFullSuite() {
    suiteRunning = true;
    try {
      await api('/validation/run-full-suite', { method: 'POST' });
      await refreshChaos();
    } catch (err) { console.error('Full suite error:', err); } finally { suiteRunning = false; }
  }

  async function runChaosTests() {
    chaosRunning = true;
    try {
      await api('/validation/run-chaos', { method: 'POST' });
      await refreshChaos();
    } catch (err) { console.error('Chaos test error:', err); } finally { chaosRunning = false; }
  }

  async function runRecoveryTests() {
    recoveryRunning = true;
    try {
      await api('/validation/run-recovery', { method: 'POST' });
      await refreshChaos();
    } catch (err) { console.error('Recovery test error:', err); } finally { recoveryRunning = false; }
  }

  async function injectFault() {
    if (!injectTarget.trim()) { injectError = '目标组件必填'; return; }
    injectLoading = true;
    injectError = '';
    injectResult = null;
    try {
      injectResult = await api('/validation/chaos-inject', {
        method: 'POST',
        body: { faultType: injectFaultType, targetComponent: injectTarget.trim(), durationMs: injectDuration },
      });
      await refreshChaos();
    } catch (err) {
      injectError = String(err);
    } finally {
      injectLoading = false;
    }
  }

  async function removeInjection(id) {
    try {
      await api('/validation/chaos-remove', { method: 'POST', body: { id } });
      await refreshChaos();
    } catch (err) { console.error(err); }
  }

  async function resetChaos() {
    try {
      await api('/validation/chaos-reset', { method: 'POST' });
      await refreshChaos();
    } catch (err) { console.error(err); }
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

  function fmtMoney(cents) {
    if (cents == null) return '-';
    return `$${(cents / 100).toFixed(2)}`;
  }

  function short(text, len = 80) {
    const s = String(text || '');
    return s.length > len ? `${s.slice(0, len)}…` : s;
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between mb-2">
    <h2 class="text-lg font-bold">稳定性验证</h2>
    <button class="btn btn-xs btn-ghost" title="刷新全部" onclick={refreshChaos}>
      <i class="fa-solid fa-rotate"></i>
    </button>
  </div>

  <!-- Stats -->
  <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
    <div class="stat bg-base-100 rounded p-3">
      <div class="stat-title text-xs">总测试</div>
      <div class="stat-value text-xl">{chaosResults.summary?.totalTests ?? 0}</div>
    </div>
    <div class="stat bg-base-100 rounded p-3">
      <div class="stat-title text-xs">通过</div>
      <div class="stat-value text-xl text-success">{chaosResults.summary?.passed ?? 0}</div>
    </div>
    <div class="stat bg-base-100 rounded p-3">
      <div class="stat-title text-xs">通过率</div>
      <div class="stat-value text-xl">{chaosResults.summary?.passRate ?? 0}%</div>
    </div>
    <div class="stat bg-base-100 rounded p-3">
      <div class="stat-title text-xs">活跃注入</div>
      <div class="stat-value text-xl text-warning">{chaosResults.activeInjections?.length ?? 0}</div>
    </div>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <div class="card bg-base-100">
      <div class="card-body p-4">
        <h3 class="card-title text-sm">验证操作</h3>
        <div class="flex flex-col gap-2 mt-3">
          <button class="btn btn-sm btn-primary" onclick={runFullSuite} disabled={suiteRunning}>
            {#if suiteRunning}<span class="loading loading-spinner loading-xs"></span>{/if}
            运行全套验证
          </button>
          <button class="btn btn-sm btn-warning" onclick={runChaosTests} disabled={chaosRunning}>
            {#if chaosRunning}<span class="loading loading-spinner loading-xs"></span>{/if}
            运行 Chaos 测试
          </button>
          <button class="btn btn-sm btn-info" onclick={runRecoveryTests} disabled={recoveryRunning}>
            {#if recoveryRunning}<span class="loading loading-spinner loading-xs"></span>{/if}
            运行恢复测试
          </button>
          <button class="btn btn-sm btn-ghost" onclick={resetChaos}>清除注入与结果</button>
        </div>

        <div class="divider my-2"></div>
        <h3 class="card-title text-sm">注入故障</h3>
        <div class="form-control w-full mt-2">
          <select class="select select-xs select-bordered" bind:value={injectFaultType}>
            {#each FAULT_TYPES as f}<option value={f}>{f}</option>{/each}
          </select>
        </div>
        <div class="form-control w-full mt-2">
          <label class="label py-1"><span class="label-text text-xs">目标组件 *</span></label>
          <input class="input input-sm input-bordered" bind:value={injectTarget} placeholder="如 runtime / sandbox" />
        </div>
        <div class="form-control w-full mt-2">
          <label class="label py-1"><span class="label-text text-xs">持续时长 (ms)</span></label>
          <input class="input input-sm input-bordered" type="number" min="1000" bind:value={injectDuration} />
        </div>
        <button class="btn btn-sm btn-error mt-3" onclick={injectFault} disabled={injectLoading}>
          {#if injectLoading}<span class="loading loading-spinner loading-xs"></span>{/if}
          注入
        </button>
        {#if injectError}
          <div class="alert alert-error py-2 text-xs mt-3">{injectError}</div>
        {/if}
        {#if injectResult}
          <div class="text-xs mt-2 opacity-70">已注入: <span class="font-mono">{injectResult.id}</span></div>
        {/if}
      </div>
    </div>

    <div class="card bg-base-100 md:col-span-2">
      <div class="card-body p-4">
        <div class="flex items-center gap-2 mb-3">
          <h3 class="card-title text-sm">Chaos 结果
            {#if chaosLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
          </h3>
          <button class="btn btn-xs btn-outline ml-auto" onclick={refreshChaos}>刷新</button>
        </div>
        {#if (chaosResults.activeInjections || []).length}
          <div class="mb-3">
            <div class="text-xs font-bold mb-1">活跃注入</div>
            <div class="flex flex-wrap gap-1">
              {#each chaosResults.activeInjections as inj}
                <span class="badge badge-sm badge-warning">
                  {inj.faultType} → {inj.targetComponent}
                  <button class="ml-1 opacity-70" onclick={() => removeInjection(inj.id)}>✕</button>
                </span>
              {/each}
            </div>
          </div>
        {/if}
        {#if (chaosResults.results || []).length}
          <div class="overflow-x-auto">
            <table class="table table-xs">
              <thead><tr>
                <th>测试名</th><th>故障类型</th><th>目标</th><th>存活</th><th>恢复时间</th><th>观察</th>
              </tr></thead>
              <tbody>
                {#each chaosResults.results as r}
                  <tr>
                    <td class="text-xs">{r.testName || '-'}</td>
                    <td><span class="badge badge-xs badge-error">{r.faultType}</span></td>
                    <td class="text-xs font-mono">{r.targetComponent}</td>
                    <td>
                      {#if r.systemSurvived}
                        <span class="badge badge-xs badge-success">存活</span>
                      {:else}
                        <span class="badge badge-xs badge-error">崩溃</span>
                      {/if}
                    </td>
                    <td class="text-xs">{fmtMs(r.recoveryTimeMs)}</td>
                    <td class="text-xs max-w-[200px] truncate" title={(r.observations || []).join('; ')}>
                      {short((r.observations || []).join('; '), 40)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="text-xs opacity-60">暂无 Chaos 结果</div>
        {/if}
      </div>
    </div>
  </div>

  {#if costUsage}
    <div class="card bg-base-100">
      <div class="card-body p-4">
        <div class="flex items-center justify-between">
          <h3 class="card-title text-sm">成本护栏</h3>
          <span class="text-xs opacity-60">重置于 {fmtTime(costUsage.lastResetAtMs)}</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
          <div class="stat bg-base-200 rounded p-3">
            <div class="stat-title text-xs">24h Token</div>
            <div class="stat-value text-lg">{costUsage.tokenUsed24h?.toLocaleString?.() ?? costUsage.tokenUsed24h}</div>
            <div class="stat-desc">{costUsage.budgetUtilization?.tokenPct ?? 0}% 预算</div>
          </div>
          <div class="stat bg-base-200 rounded p-3">
            <div class="stat-title text-xs">24h API 调用</div>
            <div class="stat-value text-lg">{costUsage.apiCalls24h ?? 0}</div>
            <div class="stat-desc">{costUsage.budgetUtilization?.apiPct ?? 0}% 预算</div>
          </div>
          <div class="stat bg-base-200 rounded p-3">
            <div class="stat-title text-xs">今日费用</div>
            <div class="stat-value text-lg">{fmtMoney(costUsage.dailyCostCents)}</div>
            <div class="stat-desc">{costUsage.budgetUtilization?.costPct ?? 0}% 预算</div>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>