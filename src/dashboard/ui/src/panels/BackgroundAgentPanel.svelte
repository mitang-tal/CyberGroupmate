<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';

  let status = null;
  let loading = true;
  let triggering = false;

  async function refresh() {
    try {
      status = await api('/background-agent');
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
    }
    triggering = false;
  }

  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  });
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-bold">Background Agent</h2>
    <button class="btn btn-sm" onclick={refresh}>Refresh</button>
  </div>

  {#if loading}
    <div class="text-base-content/50">Loading...</div>
  {:else if !status?.enabled}
    <div class="alert">
      <span>Background Agent is not enabled. Set <code>harness: "claude-code"</code> in background_agent config.</span>
    </div>
  {:else}
    <div class="stats shadow w-full">
      <div class="stat">
        <div class="stat-title">Status</div>
        <div class="stat-value text-lg">{status.running ? 'Running' : 'Idle'}</div>
        <div class="stat-desc">{status.harness ?? 'unknown'}</div>
      </div>
      <div class="stat">
        <div class="stat-title">Queue</div>
        <div class="stat-value text-lg">{status.queueLength}</div>
      </div>
      <div class="stat">
        <div class="stat-title">History</div>
        <div class="stat-value text-lg">{status.historyCount}</div>
      </div>
      <div class="stat">
        <div class="stat-title">Failures</div>
        <div class="stat-value text-lg" class:text-error={status.consecutiveFailures > 0}>{status.consecutiveFailures}</div>
      </div>
    </div>

    {#if status.lastError}
      <div class="alert alert-error">
        <span>{status.lastError}</span>
      </div>
    {/if}

    <div class="flex gap-2">
      <button class="btn btn-primary btn-sm" onclick={trigger} disabled={triggering}>
        {triggering ? 'Triggering...' : 'Trigger Dreaming'}
      </button>
    </div>

    {#if status.lastRun}
      <div class="card bg-base-200">
        <div class="card-body p-4">
          <h3 class="card-title text-sm">Last Run</h3>
          <div class="text-sm space-y-1">
            <div>Trigger: <span class="badge badge-sm">{status.lastRun.trigger}</span></div>
            <div>Started: {new Date(status.lastRun.startedAt).toLocaleString()}</div>
            {#if status.lastRun.endedAt}
              <div>Duration: {((status.lastRun.endedAt - status.lastRun.startedAt) / 1000).toFixed(1)}s</div>
              <div>Exit code: <span class="badge badge-sm" class:badge-success={status.lastRun.exitCode === 0} class:badge-error={status.lastRun.exitCode !== 0}>{status.lastRun.exitCode}</span></div>
            {:else}
              <div>Still running...</div>
            {/if}
            <div>Pending tasks consumed: {status.lastRun.pendingCount}</div>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>
