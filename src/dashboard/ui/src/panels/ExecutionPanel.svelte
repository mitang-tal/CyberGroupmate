<script>
  import { onMount, onDestroy } from 'svelte';
  import { activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';

  let activeSection = 'records';
  const SECTIONS = [
    { id: 'records', label: '执行记录' },
    { id: 'analytics', label: '执行分析' },
    { id: 'alerts', label: '异常告警' },
    { id: 'healing', label: '自愈动作' },
  ];

  let pollTimer = null;

  // ─── Records ───
  let records = [];
  let recordsLoading = false;
  let recordsError = '';
  let statusFilter = '';
  let sourceFilter = '';
  const STATUS_OPTIONS = ['pending', 'running', 'success', 'failure', 'interrupted', 'policy_denied', 'timed_out'];
  const SOURCE_OPTIONS = ['sandbox', 'meta', 'adapter', 'system', 'agent', 'host_call'];

  let selectedRecord = null;
  let recordTrace = null;
  let recordTimeline = null;
  let detailLoading = false;

  // ─── Analytics ───
  let analytics = null;
  let analyticsLoading = false;

  // ─── Alerts ───
  let alerts = [];
  let alertsLoading = false;
  let alertCount = { active: 0 };
  let alertStatusFilter = '';

  // ─── Healing ───
  let healingActions = [];
  let healingLoading = false;
  let toast = null;
  let toastTimer = null;
  let selectedHealing = null;

  $: if ($activeTab === 'execution') {
    startPolling();
  } else {
    stopPolling();
  }

  function startPolling() {
    refreshActive();
    if (!pollTimer) {
      pollTimer = setInterval(refreshActive, 8000);
    }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  onMount(() => {
    refreshAll();
  });

  onDestroy(() => stopPolling());

  function refreshActive() {
    if (activeSection === 'alerts') refreshAlerts(true);
    if (activeSection === 'records') refreshRecords(true);
  }

  async function refreshAll() {
    await Promise.allSettled([
      refreshRecords(),
      refreshAnalytics(),
      refreshAlerts(),
      refreshHealing(),
    ]);
  }

  function refreshRecords(silent = false) {
    if (!silent) recordsLoading = true;
    recordsError = '';
    const params = new URLSearchParams({ limit: '100' });
    if (statusFilter) params.set('status', statusFilter);
    if (sourceFilter) params.set('source', sourceFilter);
    return api(`/execution-records/recent?${params.toString()}`)
      .then((data) => { records = Array.isArray(data) ? data : []; })
      .catch((err) => { recordsError = String(err); })
      .finally(() => { recordsLoading = false; });
  }

  async function refreshAnalytics() {
    analyticsLoading = true;
    try {
      analytics = await api('/execution-analytics/full');
    } catch (err) {
      console.error('Analytics load error:', err);
    } finally {
      analyticsLoading = false;
    }
  }

  async function refreshAlerts(silent = false) {
    if (!silent) alertsLoading = true;
    const params = new URLSearchParams({ limit: '100' });
    if (alertStatusFilter) params.set('status', alertStatusFilter);
    try {
      const [list, count] = await Promise.all([
        api(`/execution-alerts?${params.toString()}`),
        api('/execution-alerts/count'),
      ]);
      alerts = Array.isArray(list) ? list : [];
      alertCount = count || { active: 0 };
    } catch (err) {
      console.error('Alerts load error:', err);
    } finally {
      alertsLoading = false;
    }
  }

  async function refreshHealing() {
    healingLoading = true;
    try {
      const data = await api('/execution-heal/actions?limit=100');
      healingActions = Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('Healing load error:', err);
    } finally {
      healingLoading = false;
    }
  }

  // ─── Record detail ───
  async function openRecord(record) {
    selectedRecord = record;
    detailLoading = true;
    recordTrace = null;
    recordTimeline = null;
    try {
      const [trace, timeline] = await Promise.all([
        api(`/execution-records/${record.id}/trace`),
        api(`/execution-records/${record.id}/timeline`),
      ]);
      recordTrace = trace || null;
      recordTimeline = timeline || null;
    } catch (err) {
      console.error('Record detail load error:', err);
    } finally {
      detailLoading = false;
    }
  }

  // ─── Alert actions ───
  function showToast(msg, type = 'info') {
    toast = { msg, type };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = null; }, type === 'error' ? 8000 : 5000);
  }

  async function acknowledgeAlert(alertId) {
    try {
      const result = await api(`/execution-alerts/${alertId}/acknowledge`, { method: 'POST' });
      if (result && result.error) throw new Error(result.error);
      await refreshAlerts(true);
      showToast('告警已确认', 'success');
    } catch (err) { console.error(err); showToast(`确认失败：${err?.message || String(err)}`, 'error'); }
  }

  async function resolveAlert(alertId) {
    try {
      const result = await api(`/execution-alerts/${alertId}/resolve`, { method: 'POST' });
      if (result && result.error) throw new Error(result.error);
      await refreshAlerts(true);
      showToast('告警已解决', 'success');
    } catch (err) { console.error(err); showToast(`解决失败：${err?.message || String(err)}`, 'error'); }
  }

  async function triggerHealing(alertId) {
    try {
      const result = await api(`/execution-heal/${alertId}/trigger`, { method: 'POST' });
      if (result && result.error) throw new Error(result.error);
      await Promise.all([refreshAlerts(true), refreshHealing()]);
      const actionId = result?.action?.actionId;
      showToast(`自愈已触发（${actionId ? short(actionId, 24) : '已生成自愈动作'}）`, 'success');
      activeSection = 'healing';
      const matched = healingActions.find(h => h.actionId === actionId);
      if (matched) selectedHealing = matched;
    } catch (err) { console.error(err); showToast(`自愈触发失败：${err?.message || String(err)}`, 'error'); }
  }

  async function diagnoseAlert(alertId) {
    try {
      const result = await api(`/execution-heal/diagnose/${alertId}`, { method: 'POST' });
      if (result && result.error) throw new Error(result.error);
      await Promise.all([refreshAlerts(true), refreshHealing()]);
      // 联动：toast 提示结果去向，并跳到「自愈动作」自动打开对应诊断详情
      const diag = result?.diagnosis || {};
      const root = diag.rootCause || diag.recommendedAction;
      showToast(`诊断完成（${result?.strategy || 'meta_diagnosis'}）：${root ? short(String(root), 90) : '已生成诊断动作，见自愈动作详情'}`, 'success');
      activeSection = 'healing';
      const matched = healingActions.find(h => h.actionId === result?.actionId);
      if (matched) selectedHealing = matched;
    } catch (err) { console.error(err); showToast(`诊断失败：${err?.message || String(err)}`, 'error'); }
  }

  async function openHealingDetail(action) {
    selectedHealing = action;
  }

  // ─── Helpers ───
  function statusClass(status) {
    switch (status) {
      case 'success': return 'badge-success';
      case 'running': return 'badge-info';
      case 'pending': return 'badge-warning';
      case 'failure': return 'badge-error';
      case 'timed_out': return 'badge-error';
      case 'interrupted': return 'badge-warning';
      case 'policy_denied': return 'badge-ghost';
      default: return 'badge-ghost';
    }
  }

  function severityClass(sev) {
    switch (sev) {
      case 'critical': return 'badge-error';
      case 'high': return 'badge-error';
      case 'medium': return 'badge-warning';
      case 'low': return 'badge-info';
      default: return 'badge-ghost';
    }
  }

  function strategyClass(s) {
    switch (s) {
      case 'retry': return 'badge-info';
      case 'fallback': return 'badge-warning';
      case 'meta_diagnosis': return 'badge-primary';
      case 'escalate': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  function healStatusClass(s) {
    switch (s) {
      case 'succeeded': return 'badge-success';
      case 'in_progress': return 'badge-warning';
      case 'pending': return 'badge-info';
      case 'failed': return 'badge-error';
      default: return 'badge-ghost';
    }
  }

  function fmtMs(ms) {
    if (ms == null) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
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

  function traceNodes(node, depth = 0, out = []) {
    if (!node) return out;
    out.push({ node, depth });
    for (const child of node.children || []) traceNodes(child, depth + 1, out);
    return out;
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

  {#if activeSection === 'records'}
    <!-- ─── Execution Records ─── -->
    <div class="card bg-base-100">
      <div class="card-body p-4">
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <h3 class="card-title text-sm">执行记录
            <span class="badge badge-sm badge-ghost ml-1">{records.length}</span>
            {#if recordsLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
          </h3>
          <div class="ml-auto flex flex-wrap gap-2">
            <select class="select select-xs select-bordered" bind:value={statusFilter} onchange={() => refreshRecords()}>
              <option value="">全部状态</option>
              {#each STATUS_OPTIONS as s}<option value={s}>{s}</option>{/each}
            </select>
            <select class="select select-xs select-bordered" bind:value={sourceFilter} onchange={() => refreshRecords()}>
              <option value="">全部来源</option>
              {#each SOURCE_OPTIONS as s}<option value={s}>{s}</option>{/each}
            </select>
            <button class="btn btn-xs btn-outline" onclick={() => refreshRecords()}>查询</button>
          </div>
        </div>

        {#if recordsError}
          <div class="alert alert-error py-2 text-xs">{recordsError}</div>
        {:else if records.length}
          <div class="overflow-x-auto">
            <table class="table table-xs">
              <thead><tr>
                <th>状态</th><th>方法</th><th>来源</th><th>耗时</th><th>错误</th><th>创建时间</th><th></th>
              </tr></thead>
              <tbody>
                {#each records as r}
                  <tr>
                    <td><span class="badge badge-xs {statusClass(r.status)}">{r.status}</span></td>
                    <td class="font-mono text-xs">{r.method}</td>
                    <td class="text-xs">{r.source}</td>
                    <td class="text-xs">{fmtMs(r.durationMs)}</td>
                    <td class="text-xs text-error max-w-[220px] truncate" title={r.error?.message || ''}>{r.error?.type || '-'}</td>
                    <td class="text-xs opacity-60">{fmtTime(r.createdAtMs)}</td>
                    <td><button class="btn btn-xs btn-outline" onclick={() => openRecord(r)}>详情</button></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="text-xs opacity-60">暂无执行记录</div>
        {/if}
      </div>
    </div>

    {#if selectedRecord}
      <!-- Detail Modal -->
      <div class="modal modal-open">
        <div class="modal-box max-w-4xl">
          <div class="flex items-center justify-between mb-2">
            <h3 class="card-title text-sm">执行详情
              {#if detailLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
            </h3>
            <button class="btn btn-xs btn-circle btn-ghost" onclick={() => selectedRecord = null}>✕</button>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mb-3">
            <div><div class="opacity-50">ID</div><div class="font-mono break-all">{selectedRecord.id}</div></div>
            <div><div class="opacity-50">方法</div><div class="font-mono">{selectedRecord.method}</div></div>
            <div><div class="opacity-50">来源</div><div>{selectedRecord.source}</div></div>
            <div><div class="opacity-50">状态</div><span class="badge badge-xs {statusClass(selectedRecord.status)}">{selectedRecord.status}</span></div>
            <div><div class="opacity-50">耗时</div>{fmtMs(selectedRecord.durationMs)}</div>
            <div><div class="opacity-50">runId</div><div class="font-mono">{selectedRecord.runId || '-'}</div></div>
            <div><div class="opacity-50">创建时间</div>{fmtTime(selectedRecord.createdAtMs)}</div>
            <div><div class="opacity-50">完成时间</div>{fmtTime(selectedRecord.completedAtMs)}</div>
          </div>

          {#if selectedRecord.error}
            <div class="alert alert-error py-2 text-xs mb-3">
              <b>{selectedRecord.error.type || 'Error'}:</b> {selectedRecord.error.message || '-'}
            </div>
          {/if}

          {#if recordTimeline}
            <div class="mb-3">
              <div class="text-xs font-bold mb-1">时间线</div>
              <div class="flex items-end gap-1 h-16">
                {#each recordTimeline.events || [] as ev}
                  <div class="flex flex-col items-center justify-end flex-1 h-full">
                    <div class="badge badge-xs badge-ghost mb-1">{ev.type}</div>
                    <div class="w-full bg-primary/30 rounded" style="height:{Math.max(8, ((ev.atMs - (recordTimeline.events[0]?.atMs || ev.atMs)) / Math.max(1, (recordTimeline.totalTimeMs || 1))) * 100)}%"></div>
                  </div>
                {/each}
              </div>
              <div class="text-xs opacity-60 mt-1">
                queue: {fmtMs(recordTimeline.queueTimeMs)} · run: {fmtMs(recordTimeline.runTimeMs)} · total: {fmtMs(recordTimeline.totalTimeMs)}
              </div>
            </div>
          {/if}

          {#if recordTrace}
            <div>
              <div class="text-xs font-bold mb-1">调用链 Trace</div>
              <div class="overflow-x-auto border border-base-300 rounded p-2 bg-base-200/50 max-h-80 overflow-y-auto">
                {#each traceNodes(recordTrace) as { node, depth }}
                  <div class="flex items-center gap-2 py-0.5" style="padding-left: {depth * 16}px">
                    <span class="badge badge-xs {statusClass(node.record.status)}">{node.record.status}</span>
                    <span class="font-mono text-xs">{node.record.method}</span>
                    <span class="text-xs opacity-50">{fmtMs(node.record.durationMs)}</span>
                    {#if node.record.error}
                      <span class="text-xs text-error">({node.record.error.type})</span>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}

  {:else if activeSection === 'analytics'}
    <!-- ─── Execution Analytics ─── -->
    {#if analyticsLoading}
      <div class="text-center py-10 opacity-50"><span class="loading loading-spinner loading-md"></span></div>
    {:else if analytics}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div class="stat bg-base-100 rounded p-3">
          <div class="stat-title text-xs">总执行数</div>
          <div class="stat-value text-xl">{analytics.overview?.totalExecutions ?? 0}</div>
        </div>
        <div class="stat bg-base-100 rounded p-3">
          <div class="stat-title text-xs">成功率</div>
          <div class="stat-value text-xl text-success">{pct(analytics.overview?.successRate)}</div>
        </div>
        <div class="stat bg-base-100 rounded p-3">
          <div class="stat-title text-xs">失败数</div>
          <div class="stat-value text-xl text-error">{analytics.overview?.failureCount ?? 0}</div>
        </div>
        <div class="stat bg-base-100 rounded p-3">
          <div class="stat-title text-xs">平均耗时</div>
          <div class="stat-value text-xl">{fmtMs(analytics.overview?.avgDurationMs)}</div>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="card bg-base-100">
          <div class="card-body p-4">
            <h3 class="card-title text-sm">状态分布</h3>
            {#if (analytics.statusDistribution || []).length}
              <div class="flex flex-col gap-1.5 mt-2">
                {#each analytics.statusDistribution as item}
                  {@const total = (analytics.overview?.totalExecutions || 1)}
                  <div class="flex items-center gap-2 text-xs">
                    <span class="w-24 shrink-0">{item.status}</span>
                    <div class="flex-1 h-3 bg-base-200 rounded overflow-hidden">
                      <div class="h-full bg-primary rounded" style="width:{Math.round((item.count / total) * 100)}%"></div>
                    </div>
                    <span class="w-12 text-right opacity-60">{item.count}</span>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="text-xs opacity-60 mt-2">暂无数据</div>
            {/if}
          </div>
        </div>

        <div class="card bg-base-100">
          <div class="card-body p-4">
            <h3 class="card-title text-sm">错误排行</h3>
            {#if (analytics.errorRanking || []).length}
              <div class="overflow-x-auto mt-2">
                <table class="table table-xs">
                  <thead><tr><th>错误类型</th><th>次数</th><th>最近发生</th></tr></thead>
                  <tbody>
                    {#each analytics.errorRanking as e}
                      <tr>
                        <td class="font-mono text-xs">{e.errorType}</td>
                        <td><span class="badge badge-error badge-xs">{e.count}</span></td>
                        <td class="text-xs opacity-60">{fmtTime(e.lastOccurredAtMs)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <div class="text-xs opacity-60 mt-2">暂无错误</div>
            {/if}
          </div>
        </div>
      </div>

      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">来源 / 方法统计</h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
            <div>
              <div class="text-xs font-bold mb-1">按来源</div>
              {#if (analytics.bySource || []).length}
                <table class="table table-xs">
                  <thead><tr><th>来源</th><th>次数</th><th>失败</th><th>成功率</th><th>平均耗时</th></tr></thead>
                  <tbody>
                    {#each analytics.bySource as s}
                      <tr>
                        <td>{s.source}</td>
                        <td>{s.count}</td>
                        <td class="text-error">{s.failureCount}</td>
                        <td>{pct(s.successRate)}</td>
                        <td>{fmtMs(s.avgDurationMs)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {:else}<div class="text-xs opacity-60">暂无数据</div>{/if}
            </div>
            <div>
              <div class="text-xs font-bold mb-1">按方法</div>
              {#if (analytics.byMethod || []).length}
                <table class="table table-xs">
                  <thead><tr><th>方法</th><th>次数</th><th>失败</th><th>成功率</th></tr></thead>
                  <tbody>
                    {#each analytics.byMethod.slice(0, 12) as m}
                      <tr>
                        <td class="font-mono text-xs">{m.method}</td>
                        <td>{m.count}</td>
                        <td class="text-error">{m.failureCount}</td>
                        <td>{pct(m.successRate)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {:else}<div class="text-xs opacity-60">暂无数据</div>{/if}
            </div>
          </div>
        </div>
      </div>

      {#if (analytics.slowExecutions || []).length}
        <div class="card bg-base-100">
          <div class="card-body p-4">
            <h3 class="card-title text-sm">慢执行 Top</h3>
            <div class="overflow-x-auto mt-2">
              <table class="table table-xs">
                <thead><tr><th>方法</th><th>状态</th><th>耗时</th><th>时间</th></tr></thead>
                <tbody>
                  {#each analytics.slowExecutions as s}
                    <tr>
                      <td class="font-mono text-xs">{s.method}</td>
                      <td><span class="badge badge-xs {statusClass(s.status)}">{s.status}</span></td>
                      <td class="text-warning">{fmtMs(s.durationMs)}</td>
                      <td class="text-xs opacity-60">{fmtTime(s.createdAtMs)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      {/if}
    {/if}

  {:else if activeSection === 'alerts'}
    <!-- ─── Execution Alerts ─── -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">告警概览
            {#if alertsLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
          </h3>
          <div class="grid grid-cols-3 gap-2 mt-2">
            <div class="stat bg-base-200 rounded p-2">
              <div class="stat-title text-xs">活跃</div>
              <div class="stat-value text-lg text-error">{alertCount.active ?? 0}</div>
            </div>
            <div class="stat bg-base-200 rounded p-2">
              <div class="stat-title text-xs">未解决</div>
              <div class="stat-value text-lg text-warning">{alerts.filter(a => a.status === 'active').length}</div>
            </div>
            <div class="stat bg-base-200 rounded p-2">
              <div class="stat-title text-xs">已确认</div>
              <div class="stat-value text-lg text-info">{alerts.filter(a => a.status === 'acknowledged').length}</div>
            </div>
          </div>
          <div class="flex items-center gap-2 mt-3">
            <select class="select select-xs select-bordered" bind:value={alertStatusFilter} onchange={() => refreshAlerts()}>
              <option value="">全部状态</option>
              <option value="active">active</option>
              <option value="acknowledged">acknowledged</option>
              <option value="resolved">resolved</option>
            </select>
            <button class="btn btn-xs btn-outline" onclick={() => refreshAlerts()}>刷新</button>
          </div>
        </div>
      </div>

      <div class="card bg-base-100 md:col-span-2">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">告警列表
            <span class="badge badge-sm badge-ghost ml-1">{alerts.length}</span>
          </h3>
          {#if alerts.length}
            <div class="overflow-x-auto mt-2">
              <table class="table table-xs">
                <thead><tr>
                  <th>规则</th><th>级别</th><th>状态</th><th>组件</th><th>次数</th><th>消息</th><th>操作</th>
                </tr></thead>
                <tbody>
                  {#each alerts as a}
                    <tr>
                      <td class="font-mono text-xs">{a.ruleType}</td>
                      <td><span class="badge badge-xs {severityClass(a.severity)}">{a.severity}</span></td>
                      <td><span class="badge badge-xs {statusClass(a.status)}">{a.status}</span></td>
                      <td class="text-xs">{a.sourceComponent}</td>
                      <td>{a.occurrenceCount}</td>
                      <td class="text-xs max-w-[220px] truncate" title={a.contextSummary?.message}>{short(a.contextSummary?.message, 40)}</td>
                      <td>
                        <div class="flex gap-1">
                          {#if a.status !== 'acknowledged' && a.status !== 'resolved'}
                            <button class="btn btn-xs btn-outline" onclick={() => acknowledgeAlert(a.alertId)}>确认</button>
                            <button class="btn btn-xs btn-success" onclick={() => resolveAlert(a.alertId)}>解决</button>
                          {/if}
                          <button class="btn btn-xs btn-warning" onclick={() => triggerHealing(a.alertId)}>自愈</button>
                          <button class="btn btn-xs btn-info" onclick={() => diagnoseAlert(a.alertId)}>诊断</button>
                        </div>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="text-xs opacity-60 mt-2">暂无告警</div>
          {/if}
        </div>
      </div>
    </div>

  {:else if activeSection === 'healing'}
    <!-- ─── Execution Healing ─── -->
    <div class="card bg-base-100">
      <div class="card-body p-4">
        <div class="flex items-center gap-2 mb-3">
          <h3 class="card-title text-sm">自愈动作
            <span class="badge badge-sm badge-ghost ml-1">{healingActions.length}</span>
            {#if healingLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
          </h3>
          <button class="btn btn-xs btn-outline ml-auto" onclick={refreshHealing}>刷新</button>
        </div>
        {#if healingActions.length}
          <div class="overflow-x-auto">
            <table class="table table-xs">
              <thead><tr>
                <th>策略</th><th>状态</th><th>Alert ID</th><th>Execution ID</th><th>尝试</th><th>决策原因</th><th>时间</th><th></th>
              </tr></thead>
              <tbody>
                {#each healingActions as h}
                  <tr>
                    <td><span class="badge badge-xs {strategyClass(h.strategy)}">{h.strategy}</span></td>
                    <td><span class="badge badge-xs {healStatusClass(h.status)}">{h.status}</span></td>
                    <td class="font-mono text-xs">{short(h.alertId, 20)}</td>
                    <td class="font-mono text-xs">{short(h.executionId, 20)}</td>
                    <td>{h.attemptCount}</td>
                    <td class="text-xs max-w-[240px] truncate" title={h.decisionReason}>{h.decisionReason}</td>
                    <td class="text-xs opacity-60">{fmtTime(h.createdAtMs)}</td>
                    <td><button class="btn btn-xs btn-outline" onclick={() => openHealingDetail(h)}>详情</button></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="text-xs opacity-60">暂无自愈动作（可在「异常告警」页对告警触发自愈）</div>
        {/if}
      </div>
    </div>

    {#if selectedHealing}
      <div class="modal modal-open">
        <div class="modal-box max-w-2xl">
          <div class="flex items-center justify-between mb-2">
            <h3 class="card-title text-sm">自愈详情</h3>
            <button class="btn btn-xs btn-circle btn-ghost" onclick={() => selectedHealing = null}>✕</button>
          </div>
          <div class="grid grid-cols-2 gap-2 text-xs mb-3">
            <div><div class="opacity-50">策略</div><span class="badge badge-xs {strategyClass(selectedHealing.strategy)}">{selectedHealing.strategy}</span></div>
            <div><div class="opacity-50">状态</div><span class="badge badge-xs {healStatusClass(selectedHealing.status)}">{selectedHealing.status}</span></div>
            <div class="col-span-2"><div class="opacity-50">决策原因</div><div>{selectedHealing.decisionReason}</div></div>
            <div><div class="opacity-50">Action ID</div><div class="font-mono break-all">{selectedHealing.actionId}</div></div>
            <div><div class="opacity-50">Alert ID</div><div class="font-mono break-all">{selectedHealing.alertId}</div></div>
            <div><div class="opacity-50">Execution ID</div><div class="font-mono">{selectedHealing.executionId}</div></div>
            <div><div class="opacity-50">尝试次数</div><div>{selectedHealing.attemptCount}</div></div>
            <div><div class="opacity-50">创建时间</div><div>{fmtTime(selectedHealing.createdAtMs)}</div></div>
            {#if selectedHealing.completedAtMs}
              <div><div class="opacity-50">完成时间</div><div>{fmtTime(selectedHealing.completedAtMs)}</div></div>
            {/if}
          </div>
          {#if selectedHealing.error}
            <div class="alert alert-error py-2 text-xs mb-3">{selectedHealing.error}</div>
          {/if}
          {#if selectedHealing.actionDetails}
            <div class="border border-base-300 rounded p-3 text-xs">
              <div class="flex items-center justify-between mb-2">
                <h4 class="font-bold">诊断结果</h4>
                {#if selectedHealing.actionDetails.diagnosis?.diagnosisSource}
                  {#if selectedHealing.actionDetails.diagnosis.diagnosisSource === 'heuristic'}
                    <span class="badge badge-xs badge-warning">启发式诊断</span>
                  {:else if selectedHealing.actionDetails.diagnosis.diagnosisSource === 'meta'}
                    <span class="badge badge-xs badge-primary">Meta 诊断</span>
                  {:else if selectedHealing.actionDetails.diagnosis.diagnosisSource === 'llm'}
                    <span class="badge badge-xs badge-info">LLM 诊断</span>
                  {/if}
                {/if}
              </div>
              <div class="space-y-2">
                <div>
                  <span class="opacity-50">根因:</span>
                  <div class="bg-base-200 rounded p-2 mt-0.5 font-mono">{selectedHealing.actionDetails.diagnosis?.rootCause || selectedHealing.actionDetails.contextSummary?.message || '-'}</div>
                </div>
                <div>
                  <span class="opacity-50">建议修复:</span>
                  <div class="bg-base-200 rounded p-2 mt-0.5">{selectedHealing.actionDetails.diagnosis?.recommendedAction || '-'}</div>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div><span class="opacity-50">影响组件:</span> {selectedHealing.actionDetails.diagnosis?.affectedComponent || selectedHealing.actionDetails.sourceComponent || '-'}</div>
                  <div><span class="opacity-50">严重级别:</span> {selectedHealing.actionDetails.diagnosis?.severity || '-'}</div>
                </div>
                {#if selectedHealing.actionDetails.contextSummary?.sampleErrorLogs?.length}
                  <div>
                    <span class="opacity-50">错误日志:</span>
                    <div class="mt-0.5 space-y-0.5">
                      {#each selectedHealing.actionDetails.contextSummary.sampleErrorLogs as log}
                        <div class="bg-base-300 rounded p-1 font-mono text-[10px] break-all">{log}</div>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  {/if}

  {#if toast}
    <div class="toast toast-top toast-center z-50">
      <div
        class="alert py-2 px-4 shadow-lg"
        class:alert-success={toast.type === 'success'}
        class:alert-error={toast.type === 'error'}
        class:alert-warning={toast.type === 'warning'}
        class:alert-info={toast.type === 'info'}
      >
        <span class="text-sm whitespace-pre-wrap">{toast.msg}</span>
      </div>
    </div>
  {/if}
</div>
