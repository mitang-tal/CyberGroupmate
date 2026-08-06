<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { termZh } from '../lib/i18n.js';

  // ─── Ecosystem Governance ───
  let egStatus = null;
  let egLoading = false;
  let egError = '';

  // ─── Experience Federation ───
  let federationItems = [];
  let fedLoading = false;

  // ─── Conflict Resolution ───
  let conflictHistory = [];
  let conflictStats = null;
  let conflictLoading = false;

  // ─── Negotiation ───
  let negotiationHistory = [];
  let negotiationStats = null;
  let neLoading = false;

  // ─── Agent Evolution ───
  let evolutionProposals = [];
  let evolutionLoading = false;

  // ─── Governance v2 ───
  let gv2Current = null;
  let gv2Snapshots = [];
  let gv2Loading = false;

  // ─── Governance v2 update form ───
  let gv2Update = null;
  let gv2QuarantineText = '';
  let gv2Origin = 'dashboard';
  let gv2Reason = '';
  let gv2Saving = false;

  // ─── Toast ───
  let toast = null;
  let toastTimer = null;
  function showToast(msg, type = 'info') {
    toast = { msg, type };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = null; }, type === 'error' ? 8000 : 5000);
  }

  let activeSection = 'governance';

  const SECTIONS = [
    { id: 'governance', label: '治理' },
    { id: 'federation', label: '联邦' },
    { id: 'conflict', label: '冲突仲裁' },
    { id: 'negotiation', label: '协商' },
    { id: 'evolution', label: '演化' },
    { id: 'governance-v2', label: '治理 v2' },
  ];

  onMount(() => {
    refreshAll();
  });

  async function refreshAll() {
    await Promise.all([
      refreshGovernance(),
      refreshFederation(),
      refreshConflict(),
      refreshNegotiation(),
      refreshEvolution(),
      refreshGovernanceV2(),
    ]);
  }

  // ─── Governance ───
  async function refreshGovernance() {
    egLoading = true;
    egError = '';
    try {
      egStatus = await api('/ecosystem/rate-limit');
    } catch (err) {
      egError = String(err);
    } finally {
      egLoading = false;
    }
  }

  async function engageKillSwitch() {
    try {
      // Phase 4.1：kill-switch 唯一写入口收敛至 /governance-v2/kill-switch
      await api('/governance-v2/kill-switch', {
        method: 'POST',
        body: { active: true, origin: 'dashboard', reason: 'kill-switch engaged from ecosystem panel' },
      });
      await refreshGovernance();
    } catch (err) { egError = String(err); }
  }

  async function disengageKillSwitch() {
    try {
      await api('/governance-v2/kill-switch', {
        method: 'POST',
        body: { active: false, origin: 'dashboard', reason: 'kill-switch disengaged from ecosystem panel' },
      });
      await refreshGovernance();
    } catch (err) { egError = String(err); }
  }

  async function resetGovernance() {
    try {
      await api('/ecosystem/reset', { method: 'POST' });
      await refreshGovernance();
    } catch (err) { egError = String(err); }
  }

  // ─── Federation ───
  async function refreshFederation() {
    fedLoading = true;
    try {
      const [items, quarantine, candidates] = await Promise.all([
        api('/federation/items'),
        api('/federation/quarantine'),
        api('/federation/candidates'),
      ]);
      federationItems = [
        ...(items || []).map(i => ({ ...i, _type: 'federated' })),
        ...(quarantine || []).map(i => ({ ...i, _type: 'quarantine' })),
        ...(candidates || []).map(i => ({ ...i, _type: 'candidate' })),
      ];
    } catch (err) {
      console.error('Federation load error:', err);
    } finally {
      fedLoading = false;
    }
  }

  // ─── Conflict ───
  async function refreshConflict() {
    conflictLoading = true;
    try {
      const [history, stats] = await Promise.all([
        api('/conflict/history'),
        api('/conflict/stats'),
      ]);
      conflictHistory = history || [];
      conflictStats = stats || null;
    } catch (err) {
      console.error('Conflict load error:', err);
    } finally {
      conflictLoading = false;
    }
  }

  // ─── Negotiation ───
  async function refreshNegotiation() {
    neLoading = true;
    try {
      const [history, stats] = await Promise.all([
        api('/negotiation/history'),
        api('/negotiation/stats'),
      ]);
      negotiationHistory = history || [];
      negotiationStats = stats || null;
    } catch (err) {
      console.error('Negotiation load error:', err);
    } finally {
      neLoading = false;
    }
  }

  // ─── Evolution ───
  async function refreshEvolution() {
    evolutionLoading = true;
    try {
      evolutionProposals = (await api('/evolution/proposals')) || [];
    } catch (err) {
      console.error('Evolution load error:', err);
    } finally {
      evolutionLoading = false;
    }
  }

  async function approveProposal(proposalId) {
    try {
      await api('/evolution/approve', { method: 'POST', body: { proposalId } });
      await refreshEvolution();
    } catch (err) { console.error(err); }
  }

  async function rejectProposal(proposalId) {
    try {
      await api('/evolution/reject', { method: 'POST', body: { proposalId } });
      await refreshEvolution();
    } catch (err) { console.error(err); }
  }

  // ─── Governance v2 ───
  async function refreshGovernanceV2() {
    gv2Loading = true;
    try {
      const [current, snapshots] = await Promise.all([
        api('/governance-v2/current'),
        api('/governance-v2/snapshots'),
      ]);
      gv2Current = current || null;
      gv2Snapshots = snapshots || [];
      if (current?.values) {
        gv2Update = { ...current.values };
        gv2QuarantineText = (current.values.quarantineCategories || []).join(', ');
      }
    } catch (err) {
      console.error('Governance v2 load error:', err);
    } finally {
      gv2Loading = false;
    }
  }

  function toNum(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function fmtDate(v, fallback = '-') {
    const ms = Number(v);
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : fallback;
  }

  async function saveGovernanceV2() {
    const reason = gv2Reason.trim();
    if (!reason) { showToast('请填写变更原因', 'error'); return; }
    gv2Saving = true;
    try {
      const values = {
        federationMinTrustScore: toNum(gv2Update?.federationMinTrustScore, 0.55),
        negotiationTimeoutMs: toNum(gv2Update?.negotiationTimeoutMs, 500),
        evolutionCoolingDays: toNum(gv2Update?.evolutionCoolingDays, 14),
        governorRateLimit: toNum(gv2Update?.governorRateLimit, 10),
        quarantineCategories: gv2QuarantineText.split(',').map(s => s.trim()).filter(Boolean),
      };
      const result = await api('/governance-v2/update', {
        method: 'POST',
        body: {
          values,
          origin: gv2Origin.trim() || 'dashboard',
          reason,
        },
      });
      if (result && result.error) throw new Error(result.error);
      await refreshGovernanceV2();
      gv2Reason = '';
      showToast(`策略已更新（版本 ${result?.snapshot?.version ?? ''}）`, 'success');
    } catch (err) {
      console.error(err);
      showToast(`更新失败：${err?.message || String(err)}`, 'error');
    } finally {
      gv2Saving = false;
    }
  }

  function resetGov2Form() {
    if (!gv2Current?.values) return;
    gv2Update = { ...gv2Current.values };
    gv2QuarantineText = (gv2Current.values.quarantineCategories || []).join(', ');
    gv2Reason = '';
  }

  async function rollbackSnapshot(version) {
    if (!confirm(`回滚到版本 ${version}？`)) return;
    try {
      const result = await api('/governance-v2/rollback', {
        method: 'POST',
        body: { targetVersion: version, origin: 'dashboard', reason: '手动回滚' },
      });
      if (result && result.error) throw new Error(result.error);
      await refreshGovernanceV2();
      showToast(`已回滚到版本 ${version}`, 'success');
    } catch (err) {
      console.error(err);
      showToast(`回滚失败：${err?.message || String(err)}`, 'error');
    }
  }
</script>

<div class="space-y-4">
  <!-- Section Tabs -->
  <div class="tabs tabs-box bg-base-100">
    {#each SECTIONS as sec}
      <button
        class="tab tab-sm"
        class:tab-active={activeSection === sec.id}
        on:click={() => activeSection = sec.id}
      >{sec.label}</button>
    {/each}
    <button class="btn btn-xs btn-ghost ml-auto" title="刷新全部" on:click={refreshAll}>
      <i class="fa-solid fa-rotate"></i>
    </button>
  </div>

  {#if activeSection === 'governance'}
    <!-- ─── Ecosystem Governance ─── -->
    <div class="card bg-base-100">
      <div class="card-body p-4">
        <h3 class="card-title text-sm">生态治理
          {#if egLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
        </h3>
        {#if egError}
          <div class="alert alert-error py-2 text-xs">{egError}</div>
        {:else if egStatus}
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div class="stat bg-base-200 rounded p-3">
              <div class="stat-title text-xs">限流阈值</div>
              <div class="stat-value text-lg">{egStatus.limit ?? '-'}</div>
            </div>
            <div class="stat bg-base-200 rounded p-3">
              <div class="stat-title text-xs">当前请求</div>
              <div class="stat-value text-lg">{egStatus.status?.current ?? 0}</div>
            </div>
            <div class="stat bg-base-200 rounded p-3">
              <div class="stat-title text-xs">Kill Switch</div>
              <div class="stat-value text-lg" class:text-error={egStatus.killSwitch}>
                {egStatus.killSwitch ? '🔴 已激活' : '🟢 正常'}
              </div>
            </div>
            <div class="stat bg-base-200 rounded p-3">
              <div class="stat-title text-xs">隔离类别</div>
              <div class="stat-value text-lg">{(egStatus.quarantineCategories || []).length}</div>
            </div>
          </div>
          <div class="flex gap-2 mt-3">
            {#if egStatus.killSwitch}
              <button class="btn btn-success btn-xs" on:click={disengageKillSwitch}>解除 Kill Switch</button>
            {:else}
              <button class="btn btn-error btn-xs" on:click={engageKillSwitch}>激活 Kill Switch</button>
            {/if}
            <button class="btn btn-warning btn-xs" on:click={resetGovernance}>重置</button>
          </div>
          {#if egStatus.quarantineCategories?.length}
            <div class="mt-3">
              <div class="text-xs font-bold mb-1">隔离类别</div>
              <div class="flex flex-wrap gap-1">
                {#each egStatus.quarantineCategories as cat}
                  <span class="badge badge-error badge-xs">{termZh(cat)}</span>
                {/each}
              </div>
            </div>
          {/if}
          {:else}
            <div class="text-xs opacity-60">生态治理未启用</div>
          {/if}
      </div>
    </div>

  {:else if activeSection === 'federation'}
    <!-- ─── Experience Federation ─── -->
    <div class="card bg-base-100">
      <div class="card-body p-4">
        <h3 class="card-title text-sm">经验联邦
          {#if fedLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
        </h3>
        {#if federationItems.length}
          <div class="overflow-x-auto">
            <table class="table table-xs">
              <thead><tr>
                <th>类型</th><th>ID</th><th>内容</th><th>来源</th>
              </tr></thead>
              <tbody>
                {#each federationItems as item}
                  <tr>
                    <td>
                      <span class="badge badge-xs"
                        class:badge-success={item._type === 'federated'}
                        class:badge-warning={item._type === 'quarantine'}
                        class:badge-info={item._type === 'candidate'}
                      >{termZh(item._type)}</span>
                    </td>
                    <td class="font-mono text-xs">{item.id || item.experienceId || '-'}</td>
                    <td class="text-xs">{item.summary || item.description || '-'}</td>
                    <td class="text-xs opacity-60">{item.source || item.originAgentId || '-'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="text-xs opacity-60">暂无联邦数据</div>
        {/if}
      </div>
    </div>

  {:else if activeSection === 'conflict'}
    <!-- ─── Conflict Resolution ─── -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card bg-base-100 md:col-span-2">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">冲突仲裁记录
            {#if conflictLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
          </h3>
          {#if conflictHistory.length}
            <div class="overflow-x-auto">
              <table class="table table-xs">
                <thead><tr>
                  <th>Case ID</th><th>资源</th><th>类型</th><th>裁决</th><th>时间</th>
                </tr></thead>
                <tbody>
                  {#each conflictHistory.slice(-20).reverse() as c}
                    <tr>
                      <td class="font-mono text-xs">{c.conflictCaseId || c.id}</td>
                      <td class="text-xs">{c.resourceId}</td>
                      <td><span class="badge badge-xs">{c.conflictType}</span></td>
                      <td class="text-xs">{c.verdict || c.resolution || '-'}</td>
                      <td class="text-xs opacity-60">{new Date(c.createdAtMs || c.timestamp).toLocaleString()}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="text-xs opacity-60">暂无冲突记录</div>
          {/if}
        </div>
      </div>
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">统计</h3>
          {#if conflictStats}
            <div class="space-y-2">
              <div class="flex justify-between text-xs"><span>总冲突数</span><span class="font-bold">{conflictStats.totalResolved ?? conflictStats.total ?? 0}</span></div>
              <div class="flex justify-between text-xs"><span>已裁决</span><span class="font-bold">{conflictStats.resolved ?? 0}</span></div>
              <div class="flex justify-between text-xs"><span>待处理</span><span class="font-bold">{conflictStats.pending ?? 0}</span></div>
            </div>
          {:else}
            <div class="text-xs opacity-60">暂无统计</div>
          {/if}
        </div>
      </div>
    </div>

  {:else if activeSection === 'negotiation'}
    <!-- ─── Contract-Net Negotiation ─── -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card bg-base-100 md:col-span-2">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">协商记录
            {#if neLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
          </h3>
          {#if negotiationHistory.length}
            <div class="overflow-x-auto">
              <table class="table table-xs">
                <thead><tr>
                  <th>Proposal ID</th><th>任务类型</th><th>中标 Agent</th><th>报价</th><th>时间</th>
                </tr></thead>
                <tbody>
                  {#each negotiationHistory.slice(-20).reverse() as n}
                    <tr>
                      <td class="font-mono text-xs">{n.proposalId || n.id}</td>
                      <td class="text-xs">{n.taskType}</td>
                      <td class="text-xs">{n.winningAgentId || n.awardedAgent || '-'}</td>
                      <td class="text-xs">{n.costEstimateToken ?? n.bid ?? '-'}</td>
                      <td class="text-xs opacity-60">{new Date(n.publishedAtMs || n.timestamp).toLocaleString()}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="text-xs opacity-60">暂无谈判记录</div>
          {/if}
        </div>
      </div>
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">统计</h3>
          {#if negotiationStats}
            <div class="space-y-2">
              <div class="flex justify-between text-xs"><span>总谈判</span><span class="font-bold">{negotiationStats.total ?? 0}</span></div>
              <div class="flex justify-between text-xs"><span>已完成</span><span class="font-bold">{negotiationStats.completed ?? 0}</span></div>
              <div class="flex justify-between text-xs"><span>进行中</span><span class="font-bold">{negotiationStats.active ?? 0}</span></div>
            </div>
          {:else}
            <div class="text-xs opacity-60">暂无统计</div>
          {/if}
        </div>
      </div>
    </div>

  {:else if activeSection === 'evolution'}
    <!-- ─── Agent Evolution ─── -->
    <div class="card bg-base-100">
      <div class="card-body p-4">
        <h3 class="card-title text-sm">Agent 演化提案
          {#if evolutionLoading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
        </h3>
        {#if evolutionProposals.length}
          <div class="overflow-x-auto">
            <table class="table table-xs">
              <thead><tr>
                <th>Proposal ID</th><th>Agent</th><th>建议</th><th>状态</th><th>操作</th>
              </tr></thead>
              <tbody>
                {#each evolutionProposals as p}
                  <tr>
                    <td class="font-mono text-xs">{p.proposalId || p.id}</td>
                    <td class="text-xs">{p.agentId || p.agentName || '-'}</td>
                    <td class="text-xs">{p.specialization || p.description || '-'}</td>
                    <td>
                      <span class="badge badge-xs"
                        class:badge-warning={p.status === 'pending_approval'}
                        class:badge-success={p.status === 'approved'}
                        class:badge-error={p.status === 'rejected'}
                      >{termZh(p.status)}</span>
                    </td>
                    <td>
                      {#if p.status === 'pending_approval'}
                        <button class="btn btn-success btn-xs mr-1" on:click={() => approveProposal(p.proposalId || p.id)}>批准</button>
                        <button class="btn btn-error btn-xs" on:click={() => rejectProposal(p.proposalId || p.id)}>拒绝</button>
                      {:else}
                        <span class="text-xs opacity-50">-</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="text-xs opacity-60">暂无进化提案</div>
        {/if}
      </div>
    </div>

  {:else if activeSection === 'governance-v2'}
    <!-- ─── Ecosystem Governance v2 (Versioning) ─── -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">当前版本
            {#if gv2Loading}<span class="loading loading-spinner loading-xs ml-1"></span>{/if}
          </h3>
          {#if gv2Current}
            <div class="space-y-2">
              <div class="flex justify-between text-xs"><span>版本</span><span class="font-bold">{gv2Current.version ?? '-'}</span></div>
              <div class="flex justify-between text-xs"><span>更新者</span><span class="font-mono text-xs">{gv2Current.origin || '-'}</span></div>
              <div class="flex justify-between text-xs"><span>原因</span><span>{gv2Current.reason || '-'}</span></div>
              <div class="flex justify-between text-xs"><span>时间</span><span>{fmtDate(gv2Current.timestamp || gv2Current.createdAtMs, '从未更新')}</span></div>
            </div>
            {#if gv2Current.values}
              <pre class="mt-2 text-xs bg-base-300 p-2 rounded overflow-auto max-h-40">{JSON.stringify(gv2Current.values, null, 2)}</pre>
            {/if}
          {:else}
            <div class="text-xs opacity-60">Governance v2 未启用</div>
          {/if}
        </div>
      </div>
      <div class="card bg-base-100">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">快照历史</h3>
          {#if gv2Snapshots.length}
            <div class="overflow-x-auto">
              <table class="table table-xs">
                <thead><tr>
                  <th>版本</th><th>来源</th><th>原因</th><th>时间</th><th>操作</th>
                </tr></thead>
                <tbody>
                  {#each gv2Snapshots.slice().reverse() as snap}
                    <tr>
                      <td class="font-bold">{snap.version}</td>
                      <td class="text-xs">{snap.origin || '-'}</td>
                      <td class="text-xs">{snap.reason || '-'}</td>
                      <td class="text-xs opacity-60">{fmtDate(snap.timestamp || snap.createdAtMs)}</td>
                      <td>
                        <button class="btn btn-warning btn-xs" on:click={() => rollbackSnapshot(snap.version)}>回滚</button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="text-xs opacity-60">暂无快照</div>
          {/if}
        </div>
      </div>
    </div>

    {#if gv2Current}
      <div class="card bg-base-100 mt-4">
        <div class="card-body p-4">
          <div class="flex items-center gap-2">
            <h3 class="card-title text-sm">编辑策略</h3>
            <span class="badge badge-sm badge-ghost">当前 v{gv2Current.version ?? '-'}</span>
          </div>
          {#if gv2Update}
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs">联邦最低信任分 (0-1)</span></label>
                <input class="input input-sm input-bordered" type="number" min="0" max="1" step="0.01" bind:value={gv2Update.federationMinTrustScore} />
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs">协商超时 (ms)</span></label>
                <input class="input input-sm input-bordered" type="number" min="0" bind:value={gv2Update.negotiationTimeoutMs} />
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs">演化冷却 (天)</span></label>
                <input class="input input-sm input-bordered" type="number" min="0" bind:value={gv2Update.evolutionCoolingDays} />
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs">治理限流 (次/窗口)</span></label>
                <input class="input input-sm input-bordered" type="number" min="0" bind:value={gv2Update.governorRateLimit} />
              </div>
            </div>
            <div class="form-control mt-3">
              <label class="label py-1"><span class="label-text text-xs">隔离分类（逗号分隔）</span></label>
              <input class="input input-sm input-bordered" bind:value={gv2QuarantineText} placeholder="resource_exhausted, logic_deadlock" />
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs">变更来源 (origin) *</span></label>
                <input class="input input-sm input-bordered" bind:value={gv2Origin} />
              </div>
              <div class="form-control">
                <label class="label py-1"><span class="label-text text-xs">变更原因 (reason) *</span></label>
                <input class="input input-sm input-bordered" bind:value={gv2Reason} placeholder="如：调高联邦信任门槛" />
              </div>
            </div>
            <div class="flex items-center gap-2 mt-3">
              <button class="btn btn-sm btn-primary" on:click={saveGovernanceV2} disabled={gv2Saving}>
                {#if gv2Saving}<span class="loading loading-spinner loading-xs"></span>{/if}
                保存策略
              </button>
              <button class="btn btn-sm btn-outline" on:click={resetGov2Form}>重置</button>
              <span class="text-xs opacity-60">保存会生成新版本快照并写入审计日志</span>
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
