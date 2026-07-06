<script>
  import MonacoEditor from "../../components/MonacoEditor.svelte";

  export let config;

  $: if (!config.chatFilter) {
    config.chatFilter = {
      enabled: false,
      mode: "blacklist",
      chatIds: [],
    };
  }
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-filter opacity-50 mr-1"></i> 聊天过滤
</h3>
<p class="text-xs opacity-50 mb-3">
  按 chatId 过滤入站消息。黑名单：列表内的会话被丢弃；白名单：仅列表内的会话被处理，其余全部丢弃。命中过滤的消息完全不落盘、不进入任何处理。chatId 支持 composite（如 <code>telegram:-100123</code>）或 raw id。
</p>

<div class="cfg-grid-3">
  <label class="cfg-check">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.chatFilter.enabled}
    />
    <span>启用</span>
  </label>
  <label class="cfg-field">
    <span class="cfg-label">模式</span>
    <select class="select select-xs select-bordered w-full" bind:value={config.chatFilter.mode}>
      <option value="blacklist">黑名单</option>
      <option value="whitelist">白名单</option>
    </select>
  </label>
  <label class="cfg-field">
    <span class="cfg-label">条目数</span>
    <input
      type="number"
      class="input input-xs input-bordered w-full"
      value={config.chatFilter.chatIds?.length ?? 0}
      disabled
    />
  </label>
</div>

<div class="cfg-field mt-3">
  <span class="cfg-label">Chat IDs（每行一个）</span>
  <MonacoEditor
    language="plaintext"
    height={180}
    value={(config.chatFilter.chatIds ?? []).join("\n")}
    on:change={(e) => {
      config.chatFilter.chatIds = e.detail.value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    }}
  />
</div>
