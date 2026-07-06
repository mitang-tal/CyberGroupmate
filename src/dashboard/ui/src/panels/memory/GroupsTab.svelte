<script>
  import { activeTab, activeMemoryTab, pendingMemoryLink } from '../../lib/stores.js';
  import { api } from '../../lib/api.js';
  import { shortId, escapeHtml, getPlatform, platformLabel, getChatTypeLabel } from '../../lib/utils.js';

  let groups = [];

  $: if ($activeTab === 'memory' && $activeMemoryTab === 'm-groups') load();

  async function load() {
    groups = await api('/memory/groups');
  }

  // 静默模式（mention-only）切换：开启后普通群消息仍本地落盘，但不进入 recording
  // pipeline、不触发任何 LLM；只有被直接提及（DM / @ / 触发词 / 回复）时才唤醒。
  async function toggleQuiet(g) {
    const next = !g.quietMode;
    g.quietMode = next; // 乐观更新
    groups = groups;
    try {
      await api(`/memory/group/${g.chatId}`, { method: 'PUT', body: { quietMode: next } });
    } catch (err) {
      g.quietMode = !next; // 回滚
      groups = groups;
      alert('切换失败: ' + err);
    }
  }

  function editGroup(chatId) {
    window.dispatchEvent(new CustomEvent('memoryEdit', { detail: { type: 'group', chatId } }));
  }

  function jumpToProfiles(chatId) {
    pendingMemoryLink.set({ tab: 'm-profiles', chatId });
    activeMemoryTab.set('m-profiles');
  }

  function jumpToChatLog(chatId) {
    pendingMemoryLink.set({ tab: 'm-chatlog', chatId });
    activeMemoryTab.set('m-chatlog');
  }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4">
    <div class="flex justify-between items-center mb-2">
      <h3 class="card-title text-sm">群组画像 (GroupModel)</h3>
      <button class="btn btn-xs btn-primary" onclick={load}>刷新</button>
    </div>
    <div class="overflow-x-auto">
      <table class="table table-xs">
        <thead><tr>
          <th>ChatId</th><th>类型</th><th>标题</th><th>描述</th><th>角色</th><th>参与度</th><th>活跃人数</th><th>日均消息</th><th>热门话题</th><th>静默模式</th><th>操作</th>
        </tr></thead>
        <tbody>
          {#if !groups.length}
            <tr><td colspan="12" class="text-center opacity-60">暂无数据</td></tr>
          {:else}
            {#each groups as g}
              {@const chatType = getChatTypeLabel(g.chatId) || (g.isDirectMessage ? '私聊' : '群聊')}
              <tr>
                <td class="font-mono text-xs" title={g.chatId}>
                  {#if getPlatform(g.chatId)}<span class="platform-badge platform-{getPlatform(g.chatId)}">{platformLabel(getPlatform(g.chatId))}</span>{/if}
                  {shortId(g.chatId)}
                </td>
                <td>
                  <span class="badge badge-xs {g.isDirectMessage ? 'badge-ghost' : 'badge-primary'}">{chatType}</span>
                </td>
                <td>
                  <span class="cursor-pointer hover:underline" title="点击编辑" onclick={() => editGroup(g.chatId)}>
                    {g.chatTitle || '-'}
                  </span>
                </td>
                <td class="max-w-40 truncate" title={g.description || ''}>{g.description || '-'}</td>
                <td class="max-w-24 truncate" title={g.agentRole || ''}>{g.agentRole || '-'}</td>
                <td>
                  {#if g.engagementLevel}
                    <span class="badge badge-xs" class:badge-success={g.engagementLevel==='high'} class:badge-warning={g.engagementLevel==='medium'} class:badge-ghost={g.engagementLevel==='low'}>
                      {g.engagementLevel}
                    </span>
                  {:else}
                    -
                  {/if}
                </td>
                <td>{g.activeMembers ?? '-'}</td>
                <td>{g.avgMessagesPerDay != null ? g.avgMessagesPerDay.toFixed(1) : '-'}</td>
                <td class="max-w-32 truncate" title={(g.hotTopics || []).join(', ')}>{(g.hotTopics || []).join(', ') || '-'}</td>
                <td>
                  <button
                    class="btn btn-xs {g.quietMode ? 'btn-warning' : 'btn-ghost'}"
                    title={g.quietMode ? '静默模式：仅被直接提及时响应，群消息不进入 recording pipeline / LLM。点击关闭。' : '正常模式：处理全部群消息。点击开启静默（仅提及响应）。'}
                    onclick={() => toggleQuiet(g)}
                  >
                    <i class="fa-solid {g.quietMode ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>
                    {g.quietMode ? '静默' : '正常'}
                  </button>
                </td>
                <td>
                  <div class="flex gap-1">
                    <button class="btn btn-xs btn-ghost" title="群内画像列表" onclick={() => jumpToProfiles(g.chatId)}><i class="fa-solid fa-id-badge"></i></button>
                    <button class="btn btn-xs btn-ghost" title="聊天记录" onclick={() => jumpToChatLog(g.chatId)}><i class="fa-solid fa-comments"></i></button>
                    <button class="btn btn-xs btn-ghost" title="编辑群组" onclick={() => editGroup(g.chatId)}><i class="fa-solid fa-pen-to-square"></i></button>
                  </div>
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </div>
</div>
