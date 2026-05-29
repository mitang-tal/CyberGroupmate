<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';

  let status = null;
  let loading = true;
  let triggering = false;
  let selectedRunId = null;
  let autoScroll = true;
  let logEl;
  let allRuns = [];
  let selectedRun = null;
  let selectedEvents = [];
  let selectedEventsRunId = null;
  let eventLogSource = 'memory';
  let visibleEvents = [];

  $: allRuns = status?.enabled
    ? [status.currentRun, ...(status.runs ?? [])].filter(Boolean)
    : [];

  $: if (allRuns.length && !allRuns.some(run => run.id === selectedRunId)) {
    selectedRunId = allRuns[0].id;
  }

  $: selectedRun = allRuns.find(run => run.id === selectedRunId) ?? allRuns[0] ?? null;
  $: visibleEvents = selectedEventsRunId === selectedRun?.id && selectedEvents.length
    ? selectedEvents
    : selectedRun?.events ?? [];

  $: if (autoScroll && selectedRun && logEl) {
    setTimeout(() => {
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }, 0);
  }

  async function refresh() {
    try {
      const next = await api('/background-agent');
      status = next;
      const runId = selectedRunId ?? next.currentRun?.id ?? next.runs?.[0]?.id;
      if (!selectedRunId && runId) selectedRunId = runId;
      if (runId) await loadRunEvents(runId, selectedEventsRunId === runId);
    } catch (e) {
      status = { enabled: false, error: String(e) };
    }
    loading = false;
  }

  async function trigger() {
    triggering = true;
    try {
      await api('/background-agent/trigger', { method: 'POST' });
      await refresh();
    } catch (e) {
      alert('Trigger failed: ' + e);
    } finally {
      triggering = false;
    }
  }

  function selectRun(run) {
    selectedRunId = run.id;
    selectedEvents = run.events ?? [];
    selectedEventsRunId = run.id;
    eventLogSource = 'memory';
    void loadRunEvents(run.id, false);
  }

  async function loadRunEvents(runId, append) {
    if (!runId) return;
    try {
      const lastId = append && selectedEventsRunId === runId && selectedEvents.length
        ? selectedEvents[selectedEvents.length - 1].id
        : null;
      const suffix = lastId != null ? `?after=${encodeURIComponent(lastId)}` : '';
      const result = await api(`/background-agent/runs/${encodeURIComponent(runId)}/events${suffix}`);
      const events = result.events ?? [];
      selectedEventsRunId = runId;
      eventLogSource = result.source ?? 'memory';
      selectedEvents = append && lastId != null
        ? [...selectedEvents, ...events]
        : events;
    } catch {
      const fallback = allRuns.find(run => run.id === runId);
      selectedEventsRunId = runId;
      selectedEvents = fallback?.events ?? [];
      eventLogSource = 'memory';
    }
  }

  function formatDate(ts) {
    return ts ? new Date(ts).toLocaleString() : '-';
  }

  function formatTime(ts) {
    return ts ? new Date(ts).toLocaleTimeString() : '-';
  }

  function formatDuration(run) {
    if (!run?.startedAt) return '-';
    const end = run.endedAt ?? Date.now();
    return `${((end - run.startedAt) / 1000).toFixed(1)}s`;
  }

  function exitBadge(run) {
    if (!run?.endedAt) return '运行中';
    if (run.exitCode === 0) return '完成';
    return `退出 ${run.exitCode ?? '?'}`;
  }

  function eventTone(event) {
    if (event.stream === 'stderr' || event.kind === 'failure') return 'event-error';
    if (event.kind === 'result' || event.kind === 'exit') return 'event-success';
    if (event.kind === 'tool_use' || event.text?.includes('tool_use')) return 'event-tool';
    if (event.stream === 'system') return 'event-system';
    return 'event-normal';
  }

  function eventText(event) {
    if (event.text) return event.text;
    if (event.event) return JSON.stringify(event.event, null, 2);
    return '';
  }

  function eventJson(event) {
    return event.event ? JSON.stringify(event.event, null, 2) : '';
  }

  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  });
</script>

<div class="card bg-base-100">
  <div class="card-body p-4 space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-bold">做梦系统</h2>
        <p class="text-sm text-base-content/70">Background Agent harness 输出、动作和结果记录。</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-primary btn-sm" onclick={trigger} disabled={triggering || !status?.enabled}>
          {triggering ? '触发中...' : '立即做梦'}
        </button>
        <button class="btn btn-ghost btn-sm" onclick={refresh} disabled={loading}>
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>
    </div>

    {#if loading}
      <div class="text-sm text-base-content/60">正在加载做梦系统状态...</div>
    {:else if !status?.enabled}
      <div class="alert">
        <span>Background Agent 未启用。在配置编辑 → 做梦系统中选择一个 Harness 类型（Claude Code 或 Copilot CLI）。</span>
      </div>
    {:else}
      <div class="stats stats-vertical lg:stats-horizontal shadow-sm bg-base-200">
        <div class="stat py-3">
          <div class="stat-title">状态</div>
          <div class="stat-value text-2xl">{status.running ? 'Running' : 'Idle'}</div>
          <div class="stat-desc">{status.harness ?? 'unknown'}</div>
        </div>
        <div class="stat py-3">
          <div class="stat-title">队列</div>
          <div class="stat-value text-2xl">{status.queueLength}</div>
        </div>
        <div class="stat py-3">
          <div class="stat-title">运行记录</div>
          <div class="stat-value text-2xl">{status.historyCount}</div>
        </div>
        <div class="stat py-3">
          <div class="stat-title">连续失败</div>
          <div class="stat-value text-2xl" class:text-error={status.consecutiveFailures > 0}>{status.consecutiveFailures}</div>
        </div>
      </div>

      {#if status.lastError}
        <div class="alert alert-error">
          <span>{status.lastError}</span>
        </div>
      {/if}

      <div class="grid grid-cols-1 xl:grid-cols-[0.95fr_1.55fr] gap-4">
        <section class="card bg-base-200 shadow-sm">
          <div class="card-body p-4">
            <div class="flex items-center justify-between gap-3 mb-2">
              <h3 class="card-title text-base">运行批次</h3>
              <span class="badge badge-outline">{allRuns.length}</span>
            </div>

            {#if !allRuns.length}
              <div class="rounded-xl border border-dashed border-base-300 p-4 text-sm text-base-content/60">
                还没有做梦记录。可以手动触发一次。
              </div>
            {:else}
              <div class="runs space-y-2">
                {#each allRuns as run}
                  <button
                    class="run-item"
                    class:active={selectedRunId === run.id}
                    onclick={() => selectRun(run)}
                    title={run.id}
                  >
                    <div class="run-main">
                      <span class="badge badge-xs shrink-0" class:badge-success={run.exitCode === 0} class:badge-error={run.endedAt && run.exitCode !== 0} class:badge-info={!run.endedAt}>
                        {exitBadge(run)}
                      </span>
                      <span class="font-mono truncate">{run.id}</span>
                    </div>
                    <div class="run-meta">
                      <span>{run.trigger}</span>
                      <span>{formatDate(run.startedAt)}</span>
                      <span>{formatDuration(run)}</span>
                    </div>
                    <div class="run-meta">
                      <span>{run.harness}</span>
                      <span>{run.eventCount ?? run.events?.length ?? 0} events</span>
                      {#if run.costUsd != null}<span>${Number(run.costUsd).toFixed(4)}</span>{/if}
                    </div>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </section>

        <section class="card bg-base-200 shadow-sm">
          <div class="card-body p-4">
            {#if selectedRun}
              <div class="flex flex-wrap items-start justify-between gap-3 mb-3">
                <div class="min-w-0">
                  <h3 class="card-title text-base">全程记录</h3>
                  <div class="text-xs text-base-content/60 font-mono break-all">{selectedRun.id} · {eventLogSource}</div>
                </div>
                <label class="label cursor-pointer gap-2 py-0">
                  <span class="label-text text-xs">自动滚动</span>
                  <input type="checkbox" class="toggle toggle-xs" bind:checked={autoScroll} />
                </label>
              </div>

              <div class="run-summary">
                <div><span>开始</span><strong>{formatDate(selectedRun.startedAt)}</strong></div>
                <div><span>耗时</span><strong>{formatDuration(selectedRun)}</strong></div>
                <div><span>PID</span><strong>{selectedRun.pid ?? '-'}</strong></div>
                <div><span>MCP</span><strong>{(selectedRun.mcpServers ?? []).join(', ') || '-'}</strong></div>
                {#if selectedRun.harnessHome}
                  <div class="col-span-full"><span>用户 HOME</span><strong class="font-mono break-all">{selectedRun.harnessHome}</strong></div>
                {/if}
                {#if selectedRun.instructionPath}
                  <div class="col-span-full"><span>System prompt 文件</span><strong class="font-mono break-all">{selectedRun.instructionPath}</strong></div>
                {/if}
                {#if selectedRun.logPath}
                  <div class="col-span-full"><span>日志文件</span><strong class="font-mono break-all">{selectedRun.logPath}</strong></div>
                {/if}
                {#if selectedRun.resultSummary}
                  <div class="col-span-full"><span>结果</span><strong>{selectedRun.resultSummary}</strong></div>
                {/if}
              </div>

              <div class="event-log mt-3" bind:this={logEl}>
                {#if !visibleEvents.length}
                  <div class="rounded-xl border border-dashed border-base-300 p-4 text-sm text-base-content/60">
                    这个批次暂时没有输出。
                  </div>
                {:else}
                  {#each visibleEvents as event}
                    <article class="event-row {eventTone(event)}">
                      <div class="event-meta">
                        <span class="badge badge-xs">{event.stream}</span>
                        <span class="badge badge-xs badge-ghost">{event.kind}</span>
                        <span>{formatTime(event.timestamp)}</span>
                      </div>
                      <pre>{eventText(event)}</pre>
                      {#if event.event}
                        <details>
                          <summary>JSONL 原文</summary>
                          <pre class="json">{eventJson(event)}</pre>
                        </details>
                      {/if}
                    </article>
                  {/each}
                {/if}
              </div>
            {:else}
              <div class="rounded-xl border border-dashed border-base-300 p-4 text-sm text-base-content/60">
                选择一个运行批次查看输出。
              </div>
            {/if}
          </div>
        </section>
      </div>
    {/if}
  </div>
</div>

<style>
  .runs {
    max-height: 68vh;
    overflow: auto;
  }

  .run-item {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    width: 100%;
    padding: 0.75rem 1rem;
    text-align: left;
    border: 1px solid var(--color-base-300);
    border-radius: 8px;
    background: var(--color-base-100);
  }

  .run-item:hover,
  .run-item.active {
    background: color-mix(in srgb, var(--color-primary) 9%, transparent);
  }

  .run-main,
  .run-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .run-main .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .run-meta {
    flex-wrap: wrap;
    font-size: 0.72rem;
    opacity: 0.68;
  }

  .run-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--color-base-300);
    border-radius: 8px;
    background: var(--color-base-100);
  }

  .run-summary div {
    min-width: 0;
  }

  .run-summary span {
    display: block;
    font-size: 0.68rem;
    opacity: 0.6;
    margin-bottom: 0.1rem;
  }

  .run-summary strong {
    display: block;
    font-size: 0.78rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .col-span-full {
    grid-column: 1 / -1;
  }

  .event-log {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    max-height: 62vh;
    overflow: auto;
  }

  .event-row {
    border-left: 3px solid color-mix(in srgb, var(--color-base-content) 25%, transparent);
    background: var(--color-base-100);
    border-radius: 6px;
    padding: 0.65rem 0.75rem;
    min-width: 0;
  }

  .event-success { border-left-color: var(--color-success); }
  .event-error { border-left-color: var(--color-error); }
  .event-tool { border-left-color: var(--color-warning); }
  .event-system { border-left-color: var(--color-info); }

  .event-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    font-size: 0.7rem;
    opacity: 0.75;
    margin-bottom: 0.45rem;
  }

  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.75rem;
    line-height: 1.45;
  }

  details {
    margin-top: 0.5rem;
  }

  summary {
    cursor: pointer;
    font-size: 0.72rem;
    opacity: 0.7;
  }

  .json {
    margin-top: 0.45rem;
    max-height: 20rem;
    overflow: auto;
    padding: 0.5rem;
    background: color-mix(in srgb, var(--color-base-300) 62%, transparent);
    border-radius: 6px;
  }

  @media (max-width: 960px) {
    .run-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
