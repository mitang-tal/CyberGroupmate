<script>
  import { onMount } from "svelte";
  export let config;
  export let telegramEnabled = false;
  export let pwFocus;
  export let pwBlur;
  import MonacoEditor from "../../components/MonacoEditor.svelte";
  import { api } from "../../lib/api.js";

  // ─── 隐身用户（runtime 状态，独立于配置文件；立即生效，无需重启） ───
  let invisibleText = "";
  let invisibleLoading = false;
  let invisibleSaved = false;

  async function loadInvisible() {
    try {
      const res = await api("/invisible");
      invisibleText = (res.users ?? []).map((u) => u.userId).join("\n");
    } catch { /* ignore */ }
  }

  async function saveInvisible() {
    invisibleLoading = true;
    invisibleSaved = false;
    try {
      const userIds = invisibleText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const res = await api("/invisible", { method: "PUT", body: { userIds } });
      if (res.ok) {
        invisibleSaved = true;
        setTimeout(() => (invisibleSaved = false), 2000);
      } else {
        alert("保存失败: " + (res.error ?? "unknown"));
      }
      await loadInvisible();
    } catch (e) {
      alert("保存失败: " + e.message);
    } finally {
      invisibleLoading = false;
    }
  }

  // ─── 紧急拉黑（runtime 状态；LLM 触发 emergency.block，此处人工解除） ───
  $: if (!config.emergencyBlock) config.emergencyBlock = { message: "" };
  let blockedText = "";
  let blockedLoading = false;
  let blockedSaved = false;

  async function loadBlocked() {
    try {
      const res = await api("/blocked");
      blockedText = (res.users ?? []).map((u) => u.userId).join("\n");
    } catch { /* ignore */ }
  }

  async function saveBlocked() {
    blockedLoading = true;
    blockedSaved = false;
    try {
      const userIds = blockedText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const res = await api("/blocked", { method: "PUT", body: { userIds } });
      if (res.ok) {
        blockedSaved = true;
        setTimeout(() => (blockedSaved = false), 2000);
      } else {
        alert("保存失败: " + (res.error ?? "unknown"));
      }
      await loadBlocked();
    } catch (e) {
      alert("保存失败: " + e.message);
    } finally {
      blockedLoading = false;
    }
  }

  onMount(() => {
    loadInvisible();
    loadBlocked();
  });
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-paper-plane opacity-50 mr-1"></i> Telegram 设置
</h3>
<label class="cfg-check mb-2">
  <input
    type="checkbox"
    class="toggle toggle-sm"
    bind:checked={telegramEnabled}
  />
  <span class="text-sm font-medium">启用 Telegram Adapter</span>
</label>
{#if !telegramEnabled}
  <p class="text-xs opacity-40 italic mb-3">未启用，设置不会保存到配置文件。</p>
{/if}
<div class:opacity-40={!telegramEnabled} class:pointer-events-none={!telegramEnabled}>
  <p class="text-xs opacity-50 mb-3">连接参数和发送行为。</p>
  <div class="cfg-grid-2">
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> 连接模式</span
      >
      <select
        class="select select-xs select-bordered w-full"
        bind:value={config.telegram.mode}
      >
        <option value="bot">bot</option><option value="userbot">userbot</option>
      </select></label
    >
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> Bot Token</span
      >
      <input
        type="password"
        class="input input-xs input-bordered w-full"
        bind:value={config.telegram.botToken}
        on:focus={pwFocus}
        on:blur={pwBlur}
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> API ID</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.telegram.apiId}
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> API Hash</span
      >
      <input
        type="password"
        class="input input-xs input-bordered w-full"
        bind:value={config.telegram.apiHash}
        on:focus={pwFocus}
        on:blur={pwBlur}
      /></label
    >
    <label class="cfg-field col-span-2"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> 手机号 (userbot)</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.telegram.phone}
        placeholder="+86..."
      /></label
    >
  </div>
  <div class="divider text-xs opacity-50 my-3">拟人化发送延迟</div>
  <label class="cfg-check mb-2">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.telegram.humanizedDelay.enabled}
    />
    <span>启用拟人化延迟</span>
  </label>
  {#if config.telegram.humanizedDelay.enabled}
    <div class="cfg-grid-3">
      <label class="cfg-field"
        ><span class="cfg-label">每字符 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.humanizedDelay.msPerChar}
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label">最小 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.humanizedDelay.minDelay}
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label">最大 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.humanizedDelay.maxDelay}
        /></label
      >
    </div>
  {/if}
  <div class="divider text-xs opacity-50 my-3">
    入站白名单 <span class="restart-hint"
      ><i class="fa-solid fa-rotate-right"></i> 修改需重启</span
    >
  </div>
  <p class="text-xs opacity-50 mb-2">启用后仅处理列表中的群组或私聊；私聊按对方用户 ID 匹配。</p>
  <label class="cfg-check mb-2">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.telegram.whitelist.enabled}
    />
    <span>启用白名单</span>
  </label>
  <div class="cfg-grid-2">
    <div class="cfg-field col-span-2"
      ><span class="cfg-label">群组 ID（每行一个，如 -1001234567890）</span>
      <MonacoEditor
        language="plaintext"
        height={120}
        value={config.telegram.whitelist.groups.join("\n")}
        on:change={(e) => {
          config.telegram.whitelist.groups = e.detail.value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        }}
      /></div
    >
    <div class="cfg-field col-span-2"
      ><span class="cfg-label">私聊用户 ID（每行一个）</span>
      <MonacoEditor
        language="plaintext"
        height={120}
        value={config.telegram.whitelist.users.join("\n")}
        on:change={(e) => {
          config.telegram.whitelist.users = e.detail.value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        }}
      /></div
    >
  </div>

  <div class="divider text-xs opacity-50 my-3">隐身用户（全平台）</div>
  <p class="text-xs opacity-50 mb-2">
    列表中的用户消息对 Bot 完全不可见（不处理、不记录、不进入任何 pipeline / LLM）。
    等同于用户自己发 <code>/invisible</code>。ID 用 composite 格式 <code>平台:用户ID</code>（如 <code>telegram:123</code> / <code>discord:456</code> / <code>onebot:789</code>），每行一个。
    <span class="opacity-70">跨平台生效，独立保存，立即生效（不随上方「保存配置」按钮）。</span>
  </p>
  <div class="cfg-field col-span-2">
    <MonacoEditor
      language="plaintext"
      height={120}
      value={invisibleText}
      on:change={(e) => (invisibleText = e.detail.value)}
    />
  </div>
  <div class="flex items-center gap-2 mt-2">
    <button class="btn btn-xs btn-primary" disabled={invisibleLoading} on:click={saveInvisible}>
      {#if invisibleLoading}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-user-secret"></i>{/if}
      保存隐身列表
    </button>
    {#if invisibleSaved}<span class="text-xs text-success"><i class="fa-solid fa-check"></i> 已保存并生效</span>{/if}
  </div>

  <div class="divider text-xs opacity-50 my-3">紧急拉黑（全平台）</div>
  <p class="text-xs opacity-50 mb-2">
    由 LLM 通过 <code>emergency.block</code> 在无法处理的场景下触发：拉黑瞬间向对方发送一次下方预设文案，之后该用户消息与隐身一样被完全丢弃。LLM 只能拉黑、无法解除；此处为人工解除入口。ID 为 composite <code>平台:用户ID</code>，每行一个。
  </p>
  <div class="cfg-field col-span-2 mb-2">
    <span class="cfg-label">拉黑时发送的预设文案（随上方「保存配置」按钮保存）</span>
    <textarea
      class="textarea textarea-bordered textarea-xs w-full"
      rows="3"
      placeholder="留空则使用内置默认文案"
      bind:value={config.emergencyBlock.message}
    ></textarea>
  </div>
  <div class="cfg-field col-span-2">
    <span class="cfg-label">当前被拉黑的用户（可编辑以人工解除）</span>
    <MonacoEditor
      language="plaintext"
      height={120}
      value={blockedText}
      on:change={(e) => (blockedText = e.detail.value)}
    />
  </div>
  <div class="flex items-center gap-2 mt-2">
    <button class="btn btn-xs btn-primary" disabled={blockedLoading} on:click={saveBlocked}>
      {#if blockedLoading}<span class="loading loading-spinner loading-xs"></span>{:else}<i class="fa-solid fa-ban"></i>{/if}
      保存拉黑列表
    </button>
    {#if blockedSaved}<span class="text-xs text-success"><i class="fa-solid fa-check"></i> 已保存并生效</span>{/if}
  </div>
</div>
