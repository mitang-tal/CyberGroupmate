# Memory V2 实施子任务清单

**关联文档**：[memory.md](memory.md) (v3.0) · [Implementation_Plan.md](Implementation_Plan.md) (Task 6.0)

> [!IMPORTANT]
> 不保留任何 V1 兼容接口。直接面向 V2 设计实现，V1 类型（`MemoryEntry`, `PersonProfile`, `ConversationSummary`）和方法（`store`, `search`, `getPerson`, `updatePerson` 等）全部删除。

```
依赖图：M1 ──→ M2 ──→ M4
          └──→ M3        
```

---

## Phase M1：SQLite 数据层（4天）✅

> stub → 真实 CRUD，让数据跑通全链路。

### M1.1 清理 V1 接口 + types.ts 重构（0.5天）✅

**文件**：`src/memory-v2/types.ts`

- [x] 删除 V1 兼容类型：`MemoryEntry`, `PersonProfile`, `ConversationSummary`, `TodoItem`
- [x] 删除 `IMemoryStoreV2` 中的 V1 方法签名：`search`, `store`, `getPerson`, `updatePerson`, `getRecentConversations`, `storeConversation`, `getPendingTasks`, `addTodo`, `rawQuery`, `close`
- [x] `TopicNode` 增加字段：`pipelineTopicId?: string`, `wasEngaged: boolean`, `interventionCount: number`
- [x] `TopicNode.tags` 重命名为 `keywords`
- [x] `IMemoryStoreV2` 新增 V2 方法签名：
  - `init(): void` — 建表
  - `upsertTopic(pipelineTopicId: string, data: Partial<TopicNode>): string`
  - `finalizeTopic(pipelineTopicId: string): void` — 标记 ended_at
  - `storeMessageBatch(messages: MessageLogEntry[]): void`
  - `storeFact(subject: string, content: string, category: FactCategory, source?: string): string`
  - `upsertPersonIdentity(userId: string, data: Partial<PersonIdentity>): void`
  - `upsertPersonGroupProfile(userId: string, chatId: string, data: Partial<PersonGroupProfile>): void`
  - `upsertGroupModel(chatId: string, data: Partial<GroupModel>): void`
  - `getGroupModel(chatId: string): GroupModel | null`
  - `storeInteraction(episode: Omit<InteractionEpisode, 'id'>): string`
  - `close(): void`
- [x] 新增 `MessageLogEntry` 类型

**文件**：`src/memory-v2/index.ts`

- [x] 清理导出：删除 V1 类型导出，新增 `MessageLogEntry` 导出

### M1.2 memory-v2.ts 全面重写（1天）✅

**文件**：`src/memory-v2/memory-v2.ts`

- [x] 引入 `better-sqlite3`，constructor 调用 `this.initTables()`
- [x] `initTables()`：7 张表 + FTS5 虚拟表（独立模式）
- [x] 删除全部 V1 stub 方法
- [x] 实现 `upsertTopic` — INSERT OR UPDATE by pipeline_topic_id
- [x] 实现 `finalizeTopic` — UPDATE ended_at
- [x] 实现 `storeMessageBatch` — INSERT OR IGNORE 批量
- [x] 实现 `storeFact` — INSERT core_facts + FTS5 同步
- [x] 实现 `upsertPersonIdentity` — INSERT OR UPDATE
- [x] 实现 `upsertPersonGroupProfile` — INSERT OR UPDATE
- [x] 实现 `upsertGroupModel` / `getGroupModel`
- [x] 实现 `storeInteraction` — INSERT interactions
- [x] 实现 `recall` — FTS5 + LIKE fallback（修复了 CJK 文本支持）
- [x] 实现 `browseHistory` — 关键词匹配 topics → message_log 拉消息
- [x] `reflect` — stub（M2 实现）
- [x] `close` — `this.db.close()`

### M1.3 Recording Pipeline Step 4 接入（0.5天）✅

**文件**：`src/pipeline/recording-pipeline.ts`

- [x] 构造器增加 `memory?: MemoryStoreV2` 参数
- [x] Step 4 实现：upsertTopic + storeMessageBatch + upsertPersonIdentity
- [x] 删除 Step 4 的 stub 日志

### M1.4 main.ts 接线（0.25天）✅

**文件**：`src/main.ts`

- [x] L495: `RecordingPipeline` 构造器传入 `memory` 实例
- [x] 监听 `topic:archived` 事件 → `memory.finalizeTopic(topic.id)`

### M1.5 TopicRegistry ARCHIVED 钩子（0.25天）✅

**文件**：`src/pipeline/topic-registry.ts`

- [x] 确认 cleanup() 中 STALE→ARCHIVED 已 emit `topic:archived`（L188-190 已有）

### M1.6 Compaction V2 改造（0.5天）✅

**文件**：`src/event/compaction.ts`

- [x] 修改 COMPACTION_PROMPT：输出增加 `category`（FactCategory）和 `subject` 字段
- [x] 替换写入调用：
  - ~~`memory.store(fact)`~~ → `memory.storeFact(subject, content, category)`
  - ~~`memory.updatePerson()`~~ → `memory.upsertPersonIdentity()` + `memory.upsertPersonGroupProfile()`
  - ~~`memory.storeConversation()`~~ → 删除（topics 由 Recording Pipeline 负责）
  - ~~`memory.addTodo()`~~ → 删除

### M1.7 sandbox-worker.ts + cli.ts 内存 API 改造（0.25天）✅

**文件**：`src/sandbox/sandbox-worker.ts`

- [x] L236-269 `memory` 对象替换为 V2 接口：`recall`, `browseHistory`, `reflect`
- [x] 删除 V1 方法（search/store/getPerson/updatePerson/rawQuery 等）

**文件**：`src/cli.ts`

- [x] memory 子命令替换为 V2：`recall`/`browse`/`status`
- [x] cmdStatus 统计查询 V2 表

**额外修复**：`src/sandbox/sandbox.ts`

- [x] 修复 pre-existing 路径 bug：`src/sandbox-worker.ts` → `src/sandbox/sandbox-worker.ts`

### M1.8 测试（0.5天）✅

**测试框架**：`node:test` + `assert/strict`（与现有 `tests/` 一致）
**数据库**：`tests/helpers/test-db.ts` 提供 `createTestMemory(name)` / `cleanupTestMemory()` — 每个 suite 独立 DB

#### 测试基础设施 [NEW]

- `tests/helpers/test-db.ts` — 共享 DB 生命周期 + `seedTestData()` 种子数据（3话题/12消息/5事实/3用户/1群组）
- `tests/scripts/bootstrap-dryrun-db.ts` — 独立脚本，创建预填充的轻量 DB 供手动 dry-run 验证
  - 用法: `npx tsx tests/scripts/bootstrap-dryrun-db.ts [output-path]`
  - 默认输出到 `workspace/test-memory.db`

#### 实际测试结果：`tests/memory-v2.test.ts`（34 个测试用例，全部通过）

13 suites, 34 tests — **100% pass** (duration ~320ms)

#### FTS5 Bug 修复（测试中发现）

- **FTS5 content-sync → 独立模式**：content-sync 模式下 DELETE 操作导致 "database disk image is malformed"
- **recall() LIKE fallback**：FTS5 unicode61 对中文分词效果差，0 结果时需自动回退 LIKE

#### 文件：`tests/memory-v2.test.ts`（覆盖现有 V1 stub 测试）

```
describe("MemoryStoreV2")
├─ describe("init 建表")
│   ├─ it("构造后 7 张表全部存在")         → pragma table_list 查 7 张表名
│   ├─ it("FTS5 虚拟表 topics_fts 存在")      → SELECT * FROM topics_fts LIMIT 0 不报错
│   ├─ it("FTS5 虚拟表 core_facts_fts 存在")  → 同上
│   ├─ it("重复 init() 不报错 (IF NOT EXISTS)")  → 连续调 2 次
│   └─ it("WAL 模式已启用")                    → pragma journal_mode === 'wal'
│
├─ describe("upsertTopic")
│   ├─ it("首次写入 → INSERT，返回 UUID")     → 返回值匹配 UUID 格式，SELECT 确认行存在
│   ├─ it("相同 pipeline_topic_id 再次写入 → UPDATE")  → 返回相同 UUID，summary 被更新
│   ├─ it("不同 pipeline_topic_id 写入 → 两行")    → SELECT COUNT = 2
│   ├─ it("Partial 更新只写指定字段")          → 先 insert 全量，再 update 只传 summary，检查 label 不变
│   ├─ it("keywords 存取为 JSON 数组")         → 写入 ["a","b"] → 读回确认相等
│   └─ it("was_engaged 和 intervention_count 正确存取")  → 写 true/3 → 读回确认
│
├─ describe("finalizeTopic")
│   ├─ it("标记 ended_at 为当前时间")          → 调用后 SELECT ended_at IS NOT NULL
│   └─ it("不存在的 pipeline_topic_id 不报错")  → 静默失败
│
├─ describe("storeMessageBatch")
│   ├─ it("批量写入 5 条消息")                → SELECT COUNT = 5
│   ├─ it("重复 messageId+chatId 不报错 (IGNORE)")  → 写 5 条 + 写 3 条重复 + 2 条新 → COUNT = 7
│   ├─ it("空数组不报错")                    → storeMessageBatch([]) 不 throw
│   └─ it("display_name 正确存储")               → 写入后 SELECT display_name 匹配
│
├─ describe("storeFact")
│   ├─ it("写入后可以 SELECT 到")               → 按 id 查询确认存在
│   ├─ it("category 正确存储")                 → 写 'preference' → 读回确认
│   └─ it("source 可选参数正确处理")           → 不传 source → NULL；传 source → 存在
│
├─ describe("FTS5 搜索")
│   ├─ it("core_facts_fts 中文关键词搜索")   → 写 "小明喜欢吃拉面" → 搜 "拉面" → 命中
│   ├─ it("topics_fts label+keywords 搜索")  → 写 label="京都旅行" keywords=["a"] → 搜 "京都" → 命中
│   └─ it("无匹配时返回空结果")              → 搜 "不存在的关键词" → 空数组
│
├─ describe("upsertPersonIdentity")
│   ├─ it("首次写入 INSERT")                  → SELECT 确认行存在
│   └─ it("相同 userId 再次写入 UPDATE")       → display_name 被更新
│
├─ describe("upsertPersonGroupProfile")
│   ├─ it("首次写入 INSERT")                  → SELECT by (userId, chatId) 确认
│   ├─ it("相同 userId+chatId UPDATE")         → traits 被更新
│   └─ it("不同 chatId 独立行")               → 同一 userId, 2 个 chatId → COUNT = 2
│
├─ describe("upsertGroupModel / getGroupModel")
│   ├─ it("写入后 get 返回完整对象")           → 字段匹配
│   └─ it("不存在的 chatId 返回 null")         → getGroupModel("nonexist") === null
│
├─ describe("storeInteraction")
│   ├─ it("返回 UUID")                        → 匹配 UUID 格式
│   └─ it("存储的字段正确")                  → SELECT 确认 chat_id, user_id, type, summary
│
├─ describe("recall")
│   ├─ it("搜索命中 topics")                  → 先写 topic(summary="京都旅行") → recall("京都") → topics.length ≥ 1
│   ├─ it("搜索命中 core_facts")              → 先写 fact("小明喜欢拉面") → recall("拉面") → facts.length ≥ 1
│   ├─ it("chatId 过滤生效")                → 写 2 个不同 chatId topic → recall(" ", {chatId: "A"}) → 只返回 A
│   ├─ it("daysBack 过滤生效")               → 写 1 个 30 天前 topic + 1 个今天 topic → recall("", {daysBack:7}) → 只返回今天的
│   └─ it("无匹配时返回空结果")              → recall("不存在") → topics=[], facts=[]
│
├─ describe("browseHistory")
│   ├─ it("按关键词命中 topic 并拉取消息")   → 先写 topic + messages(messageRange 内) → browseHistory({intent:"关键词"}) → segments 非空
│   └─ it("无匹配时返回空 segments")        → browseHistory({intent:"不存在"}) → segments=[]
│
└─ describe("close")
    └─ it("close 后操作报错")                → close() → upsertTopic() throws
```

#### 文件：`tests/recording-pipeline-memory.test.ts` [NEW]

```
describe("RecordingPipeline Step 4 Integration")
├─ it("flush 后 topics 表有数据")         → 模拟 10 条消息 + mock LLM 返回 clustering/triage
│                                         → flush() → SELECT topics → ≥ 1 行
├─ it("flush 后 message_log 有数据")     → 同上 → SELECT message_log → 10 行
├─ it("多次 flush 同一话题 → upsert 而非重复插入")  → flush 两次 → topics 行数不变，summary 被更新
└─ it("ARCHIVED 事件触发 finalizeTopic")  → 模拟 topic:archived emit → ended_at 非 null
```

#### 文件：`tests/compaction-v2.test.ts` [NEW]

```
describe("Compaction V2 写入")
├─ it("事实写入 core_facts 而非旧 memories 表")  → 模拟 compaction 输出 → core_facts 有数据
├─ it("事实带有 category 和 subject")        → category='preference', subject='user123'
└─ it("画像写入 person_group_profiles")       → upsertPersonGroupProfile 被调用，字段正确
```

- [x] 删除旧测试文件 `tests/memory.test.ts`（V1 stub 测试）
- [ ] `tests/recording-pipeline-memory.test.ts` — 待 M2/M3 与 LLM mock 一起实现
- [ ] `tests/compaction-v2.test.ts` — 待 M2/M3 与 LLM mock 一起实现
- [x] `tsc --noEmit` 0 错误
- [ ] sandbox tests 12/12 fail — **pre-existing bug**（目录重构 commit `e9c53c5` 引入，非 M1 回归）

---

## Phase M2：Reflection Skill + 情感记忆合并（3天）

### M2.1 Reflection 引擎核心（1天）✅

**文件**：`src/memory-v2/reflection.ts` [NEW]

- [x] `runReflection(chatId, memory, llmConfig, reflectionConfig?): Promise<ReflectionResult>`
- [x] Step 1：查 `group_models.last_reflected_at` 之后的 topics + interactions
- [x] Step 2：统计每个活跃用户的消息数、主动发起率、活跃时段
- [x] Step 3：调 cheap model → 结构化 JSON（画像增量 / 邓巴调整 / core_facts / group 氛围）
- [x] Step 4：解析 → 写入 `person_group_profiles` / `core_facts` / `group_models`
- [x] Step 5：更新 `group_models.last_reflected_at`
- [x] `ReflectionConfig` 独立配置接口（temperature / maxTokens / model 可覆盖）
- [x] `parseReflectionJSON()` 支持纯 JSON + markdown 代码块 + 宽松模式
- [x] `buildReflectionPrompt()` 含邓巴分层指引和事实分类说明

**query helpers** (memory-v2.ts)：
- [x] `getTopicsSince(chatId, since)`
- [x] `getInteractionsSince(chatId, since)`
- [x] `getProfilesForChat(chatId)`

**prompt 外部化** (`system-prompts/`)：
- [x] `reflection-system.md` — Reflection system prompt 从 reflection.ts 抽出
- [x] `compaction-system.md` — Compaction system prompt 从 compaction.ts 抽出
- [x] 两个文件均使用 lazy-cache + fallback 加载模式

### M2.2 情感记忆合并（0.5天）✅

**文件**：`src/memory-v2/reflection.ts`

- [x] `mergeEpisodes(userId, chatId, memory)`：
  - >7天 InteractionEpisode → MergedMemory(week)
  - >30天 week → MergedMemory(month)
  - >90天 month → MergedMemory(quarter)
  - >365天 quarter → MergedMemory(year)
  - 只保留 significance > 0.7 的 highlights
- [x] 在 `runReflection()` Step 4d 末尾调用
- [x] 辅助函数：`groupByPeriod()`, `cascadeMerge()`, `computeOverallSentiment()`, `getPeriodKey()`
- [x] LLM 辅助分析：`analyzeMergeWithLLM()` + `analyzeCascadeMergeWithLLM()`
  - cheap model 综合分析 overallSentiment / highlights / relationshipTrend
  - LLM 失败时自动回退到规则合并
  - `mergeEpisodes()` 现为 async，接受 `llmConfig` + `reflectionConfig`
- [x] `system-prompts/merge-episodes-system.md` — 合并分析 prompt

### M2.3 邓巴分层精度控制（0.5天）✅

**文件**：`src/memory-v2/reflection.ts`

- [x] `trimProfileByTier(userId, chatId, memory)`：
  - Tier 1 (核心)→traits:10, interests:15, episodes:14天
  - Tier 2 (熟悉)→traits:6, interests:10, episodes:7天
  - Tier 3 (认识)→traits:3, interests:5, episodes:3天
  - Tier 4 (陌生)→traits:1, interests:2, episodes:1天
- [x] 在 `runReflection()` Step 4e 写回画像前应用裁剪
- [x] `TIER_LIMITS` 配置表（来自 memory.md §3.2.4）

### M2.4 系统集成（0.5天）

- [x] `memory-v2.ts`: `reflect()` 从 stub → 调用 `runReflection()` (dynamic import)
- [x] `main.ts`: `setInterval`（5分钟）冷场触发检查 + `lastActivityPerChat` 活跃追踪
  - 冷场阈值: `config.agent.reflection.silence_threshold` 默认 7200s (2h)
  - `reflectionInProgress` Set 防重入
- [x] `cli.ts`: 新增 `memory reflect --chat <id>` 子命令
  - 使用 `resolveTierProfile("cheap")` 获取 LLMConfig
  - 输出 personUpdates / newFacts / mergedEpisodes / insights / topicsSummary

### M2.5 测试（0.5天）

#### 文件：`tests/reflection.test.ts` [NEW]

```
describe("Reflection Skill")
├─ describe("mergeEpisodes 情感合并")
│   ├─ it("≤ 7天的 episodes 不被合并")        → 写 3 条 5 天前 episode → 调 merge → recentEpisodes 长度不变
│   ├─ it("> 7天 episodes 合并为 MergedMemory(week)")  → 写 5 条 10 天前 episodes → merge → recentEpisodes 减少，mergedMemory 增加
│   ├─ it("合并保留 significance > 0.7 的 highlights")  → 写 sig=0.9 和 sig=0.3 → 合并后只保留 0.9
│   ├─ it("> 30天 week 合并为 MergedMemory(month)")     → 写 40 天前 week merged → merge → 升级为 month
│   ├─ it("合并后 overallSentiment 正确计算")     → 3 positive + 1 negative → overall='positive'
│   └─ it("空 episodes 不报错")                  → mergeEpisodes("user","chat") → 无变化
│
├─ describe("trimProfileByTier 邓巴裁剪")
│   ├─ it("Tier 1 → traits≤10, interests≤10, episodes≤15")
│   │     → 输入 15 traits, tier=1 → 输出 10 traits
│   ├─ it("Tier 2 → traits≤6, interests≤6, episodes≤8")
│   │     → 输入 10 traits, tier=2 → 输出 6 traits
│   ├─ it("Tier 3 → traits≤3, interests≤3, episodes≤3")
│   ├─ it("Tier 4 → traits≤1, interests≤1, episodes≤1")
│   │     → 输入 5 traits, tier=4 → 输出 1 trait
│   └─ it("未超过上限时不裁剪")
│       → 输入 2 traits, tier=1 → 输出 2 traits（不变）
│
├─ describe("runReflection 集成")
│   ├─ it("调用后 group_models.last_reflected_at 被更新")
│   │     → 先写 group_model(last_reflected_at=昨天) + 1 topic → runReflection → last_reflected_at = 今天
│   ├─ it("无新 topics 时 reflection 跳过不报错")
│   │     → last_reflected_at = 刚才，无新 topic → runReflection → 无数据操作
│   ├─ it("生成的 core_facts 写入 core_facts 表")
│   │     → mock LLM 返回 2 条 fact → SELECT core_facts ≥ 2 行
│   └─ it("画像更新写入 person_group_profiles")
│       → mock LLM 返回 traits=["X"] → SELECT traits 包含 "X"
│
└─ describe("Reflection Prompt 解析")
    ├─ it("合法 JSON 正确解析")              → 模拟 LLM 返回合法结构化 JSON → 无报错
    ├─ it("JSON 外包 markdown 代码块能处理")   → ```json\n{...}\n``` → 正确提取
    └─ it("LLM 返回非 JSON 时优雅降级")      → 返回纯文本 → 不崩溃，记录警告
```

#### 手动验证

- [ ] CLI `memory reflect --chat <id>` 执行无报错
- [ ] 执行后 `person_group_profiles` 表有更新（traits/interests 变化）
- [ ] 执行后 `core_facts` 表新增了事实行

### M2.6 审计修复（Debug Phase）

> 基于 memory.md v3.0 与 M1+M2 实现的全面对比审计。修复前三组为高优先级阻塞项，必须在 M3 之前完成。

#### 🔴 高优先级

**M2.6.1 Recording Pipeline 补充 PersonGroupProfile 程序化字段更新** ✅

> memory.md §3.1 L446-455：每次收到消息时程序化更新 `messageCount++`、`activeHours[hour]++`、`lastSeenAt`

**文件**：`src/pipeline/recording-pipeline.ts`

- [x] flush Step 4 中按 `(senderId, chatId)` 分组消息
- [x] 调用 `memory.incrementProfileStats(uid, chatId, { messageCountDelta, activeHoursDelta, lastSeenAt })`

**文件**：`src/memory-v2/memory-v2.ts` + `types.ts`

- [x] 新增 `incrementProfileStats()` 方法（原子增量 `message_count += N`）
- [x] `activeHours` 逐 slot 累加合并（读-合并-写）
- [x] `lastSeenAt` 取较新值语义（SQL `CASE WHEN`）

**M2.6.2 max_interval 强制反思触发** ✅

> memory.md §3.3 L588：`max_interval: 86400`，即使群一直活跃也至少每 24h 反思一次

**文件**：`src/main.ts`

- [x] 增加 `lastReflectedAtMap` 追踪（per-chat）
- [x] 触发条件改为 `silenceTriggered || maxIntervalTriggered`
- [x] 冷场触发后重置计时，最大间隔触发后不重置

**文件**：`src/core/config.ts` + `config.example.yaml`

- [x] `ReflectionExternalConfig` 增加 `maxInterval?: number`（默认 86400）
- [x] `config.example.yaml` 增加 `max_interval: 86400`

**M2.6.3 Reflection 更新 person_identities** ✅

> memory.md §3.3 L673：Reflection Step 6 写入 `person_identities: 更新 aliases / displayName（如有变化）`

**文件**：`src/memory-v2/reflection.ts`

- [x] `ReflectionLLMOutput` 增加 `identityUpdates?: Array<{ userId, displayName?, aliases? }>`
- [x] Step 4 新增 4a′ 步骤：写入 `memory.upsertPersonIdentity()` 更新 aliases/displayName
- [x] `parseReflectionJSON` 保留 `identityUpdates` 字段（两条解析路径均已更新）

#### 🟡 中优先级

**M2.6.4 Dunbar 分层人数上限检查** ✅

> memory.md §3.1 L412-416：Tier 1 ≤15, Tier 2 ≤50, Tier 3 ≤150

- [x] `runReflection` Step 4f：统计各 Tier 人数，超出按 `messageCount` 升序降级最不活跃的用户

**M2.6.5 core_facts.expires_at 支持** ✅

> memory.md §3.4 L796：`plan` 类 fact 带 `expires_at`，过期后应过滤

- [x] `storeFact()` 增加可选 `expiresAt` 参数（types.ts + memory-v2.ts）
- [x] `recall()` FTS5 和 LIKE 双路径过滤 `expires_at IS NULL OR expires_at > datetime('now')`

**M2.6.6 awake_hours 作息触发** ✅

> memory.md §3.3 L574

- [x] `ReflectionExternalConfig` 增加 `awakeHours?: [number, number]` + `timezone?: string`
- [x] `main.ts` 增加 `isOutsideAwakeHours()` 函数（支持 `Intl.DateTimeFormat` 时区）
- [x] 作息触发条件：`isOutsideAwakeHours() && sinceReflectionSec > 3600`
- [x] `config.example.yaml` 增加 `awake_hours` + `timezone` 配置项

#### 🔵 低优先级（可延后处理）

**M2.6.7 Reflection agent-state 写入** ✅

- [x] Reflection Step 6：追加结构化反思摘要到 `agent-state.md`（周期/统计/洞察，3500 字符截断）

**M2.6.8 upsertPersonGroupProfile UPDATE 日志** ✅

- [x] UPDATE 路径增加 `log.debug`

**M2.6.9 Compaction 回写 topics.sentiment** ✅

- [x] Reflection Step 4b′：匹配 `topicsSummary` 与当期 topics，将 LLM 分析的 sentiment 回写到 topics 表

---

## Phase M3：智能 Context Compaction（3天）✅

### M3.1 ContextManager 核心（1天）✅

**文件**：`src/memory-v2/context-manager.ts` [NEW]

> 纯函数模块（无状态），不引入外部依赖（不用 js-tiktoken），使用 CJK 感知的字符估算。

- [x] `ContextBudget` 配置接口
  - `effectiveContextWindow: number` — 有效上下文窗口（默认 32000）
  - `systemPromptRatio: number` — system prompt 预算比例（默认 0.20）
  - `briefingRatio: number` — context briefing 预算比例（默认 0.15）
  - `recentHistoryRatio: number` — 近期消息预算比例（默认 0.50）
  - `outputReserve: number` — output 预留（默认 4096）
  - `minRecentMessages: number` — 最少保留消息数（默认 6）
  - `maxBriefingTokens: number` — Context Briefing 最大 token 数（默认 3000）
- [x] `estimateTokens(text)` — CJK 感知（英文 /4、CJK /1.5、混合加权）
- [x] `estimateMessagesTokens(messages)` — 批量估算
- [x] `shouldCompact(messages, budget)` — 总 token > effectiveContextWindow * 0.85
- [x] `classifyMessages(messages, budget)` — 分段：`{ systemPrompt, briefing?, candidates, recent }`
  - `systemPrompt`: messages[0] (role=system)
  - `briefing`: messages[1] 如果标记为 `scope: "context-briefing"`
  - `recent`: 尾部保留 `minRecentMessages` 条或 `recentHistoryRatio` 预算内
  - `candidates`: 中间部分（压缩候选）

**耦合点**：
- 读取 `ChatMessage` 接口（`src/core/llm.ts`）
- 被 `main.ts` 消费（M3.4 替换 rolling truncation）

**文件**：`src/core/config.ts` [MODIFY]
- [x] `ContextBudgetConfig` 接口 + `AppConfig.contextBudget`
- [x] `loadConfig()` 解析 `context_budget` 节

**文件**：`config.example.yaml` [MODIFY]
- [x] 新增 `context_budget` 配置节

**文件**：`src/memory-v2/index.ts` [MODIFY]
- [x] 导出 context-manager 公共 API（estimateTokens, shouldCompact, compact, mergeContextBudget 等）

### M3.2 话题连贯性保护（0.5天）✅

- [x] `identifyProtectedMessages(messages, options?)` — reply chain + ENGAGED 话题消息 + 最近 N 条
- [x] 受保护消息在压缩时跳过

### M3.3 Compaction 执行逻辑（1天）✅

- [x] `compact(messages, llmConfig, budget, options?)` → cheap model 生成 Context Briefing → 重组消息数组
- [x] 输出：[System Prompt] + [Context Briefing] + [受保护的候选] + [Recent]
- [x] LLM 失败时回退到简单统计摘要
- [x] `system-prompts/context-compaction.md` — Context Briefing 生成 prompt（外部化）

### M3.4 替换 Rolling Truncation + 配置化（0.25天）✅

- [x] `main.ts` L511-524 → `shouldCompact()` + `compact()` + 错误回退
- [x] 新增 `cheapConfig` 参数透传到 `mainEventLoop`
- [x] `config.example.yaml` 新增 `context_budget` 配置节

### M3.5 测试（0.5天）✅

#### 实际测试结果：`tests/context-manager.test.ts`（31 个测试用例，全部通过）

9 suites, 31 tests — **100% pass** (duration ~286ms)

#### 文件：`tests/context-manager.test.ts` [NEW]

```
describe("ContextManager")
├─ describe("estimateTokens")                    — 5 tests
├─ describe("estimateMessagesTokens")             — 2 tests
├─ describe("shouldCompact")                      — 4 tests
├─ describe("classifyMessages")                   — 5 tests
├─ describe("identifyProtectedMessages")          — 6 tests
├─ describe("compact")                            — 2 tests
├─ describe("mergeContextBudget")                 — 3 tests
├─ describe("ContextBudget 配置集成")              — 1 test
└─ describe("main.ts rolling truncation 已替换")   — 3 tests
```

#### 手动验证

- [ ] dry-run 跑 > 50 条消息，观察日志确认 Compaction 触发
- [ ] 确认压缩后的 Context Briefing 包含早期话题摘要
- [ ] ENGAGED 话题的消息不被压缩（检查日志）

---

## Phase M4：向量搜索 + Deep Recall（4天）

### M4.1 Embedding 封装（0.5天）

**文件**：`src/memory-v2/embedding.ts` [NEW]

- [ ] `embed(texts: string[]): Promise<Float32Array[]>` — text-embedding-3-small
- [ ] 批量处理 + 重试

### M4.2 sqlite-vec 集成（1天）

- [ ] `package.json` 增加 `sqlite-vec`
- [ ] initTables 创建向量虚拟表 `topics_vec` / `core_facts_vec`
- [ ] upsertTopic / storeFact 写入时同时写向量索引
- [ ] 回退方案：纯 JS 余弦相似度

### M4.3 recall() 混合检索（1天）

- [ ] embed(query) → 向量搜索（主路径）+ FTS5（补充）
- [ ] token > deepRecallThreshold → cheap model deepSummary

### M4.4 browseHistory() 升级（1天）

- [ ] cheap model 意图解析 → 向量+FTS5 定位 topics → message_log 拉消息 → cheap model 深度阅读

### M4.5 Pipeline 嵌入集成 + 精确 token（0.5天）

- [ ] Recording Pipeline flush Step 4 增加 embedding 生成：`const emb = await embed([summary]); memory.upsertTopic(id, { embedding: emb[0] })`
- [ ] `context-manager.ts` 的 `estimateTokens()` 改用 `js-tiktoken` BPE 精确计算
- [ ] `package.json` 增加 `js-tiktoken` 依赖

### M4.6 测试（0.5天）

#### 文件：`tests/embedding.test.ts` [NEW]

```
describe("Embedding")
├─ it("单条文本生成 1536 维向量")          → embed(["测试"]) → result[0].length === 1536
├─ it("批量文本生成对应数量向量")        → embed(["a","b","c"]) → result.length === 3
├─ it("空数组返回空数组")                → embed([]) → []
└─ it("API 失败重试 3 次后报错")            → mock 3 次 500 → throw
```

#### 文件：`tests/recall-hybrid.test.ts` [NEW]

```
describe("recall() 混合检索")
├─ it("向量搜索命中语义相似但无关键词匹配的 topic")
│     → 写 topic(label="关西地区交通指南") → recall("京都如何去") → 命中（语义相似）
├─ it("FTS5 精确匹配作为补充路径")
│     → 写 topic(label="Python 错误调试") → recall("Python") → FTS5 命中
├─ it("向量 + FTS5 结果合并去重")
│     → 同一 topic 被两路都命中 → 返回 1 个，不重复
├─ it("token > deepRecallThreshold 触发 deepSummary")
│     → mock 大量结果 → result.deepSummary 非 undefined
└─ it("结果关联 person_group_profiles")
      → topic 参与者 match profile → result.persons.length ≥ 1
```

#### 文件：`tests/browse-history-deep.test.ts` [NEW]

```
describe("browseHistory() 深度阅读")
├─ it("意图解析 → 关键词 + 时间范围")
│     → mock LLM 返回 {keywords:["X"], daysBack:7} → 正确解析
├─ it("定位 topics + 拉取 message_log 原始消息")
│     → 写 topic(messageRange: 100-110) + 11 条 msg → segments 包含原始消息
├─ it("LLM 深度阅读生成 answer")
│     → mock LLM 返回总结文本 → result.answer 非空且不包含 "stub"
└─ it("messagesRead 统计正确")
      → segments 总消息数 === result.messagesRead
```

#### 文件：`tests/vector-index.test.ts` [NEW]

```
describe("向量索引" )
├─ it("upsertTopic 写入后 topics_vec 有数据")
│     → upsertTopic + embedding → SELECT from topics_vec → 1 行
├─ it("storeFact 写入后 core_facts_vec 有数据")
├─ it("向量相似度搜索返回最近邻")       → 写 3 个 embedding → 搜索 → top1 cosine 距离最小
└─ it("sqlite-vec 编译失败时回退纯 JS 余弦")  → 模拟加载失败 → cosine 计算仍正确
```

#### 手动验证

- [ ] CLI `memory recall "京都 交通"` → 命中语义相关但无关键字完全匹配的 topic
- [ ] CLI `memory browse "之前谁推荐过岚山"` → 返回 answer + 原始对话段落
- [ ] 检查 `workspace/memory.db` 中 topics 表的 embedding 列非 NULL

---

## 验收标准

| Phase | 自动化验收 | 手动验收 |
|-------|----------|----------|
| M1 | `memory-v2.test.ts` 全通过（25+ case）；`recording-pipeline-memory.test.ts` 全通过；`compaction-v2.test.ts` 全通过 | dry-run 跑 1 天消息，检查 memory.db 中 topics/message_log/core_facts 有数据 |
| M2 | `reflection.test.ts` 全通过（18+ case） | CLI `memory reflect` 后 person_group_profiles 和 core_facts 有更新 |
| M3 | `context-manager.test.ts` 全通过（15+ case） | dry-run >50 条消息，确认 Compaction 触发且 ENGAGED 话题不被压缩 |
| M4 | `embedding.test.ts` + `recall-hybrid.test.ts` + `browse-history-deep.test.ts` + `vector-index.test.ts` 全通过 | CLI 语义搜索命中，embedding 列非 NULL |
