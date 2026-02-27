

# 赛博群友 (CyberGroupMate) 

另一个架构版本的CyberGroupMate, 在 Phase 6 合入当前架构，有所取舍。本文档留作参考。

---

## 第零章：项目总览与核心原则

### 0.1 项目定位

赛博群友是一个**主动式多智能体群聊参与系统**，其核心能力是：
- **沉默记录**：持续将群聊信息结构化沉淀为本地 Markdown 知识图谱
- **读空气**：自主判断何时介入对话，何时保持沉默
- **有建设性地发言**：每次开口都携带经过内外搜索验证的增量信息

### 0.2 技术栈锁定

| 层级 | 选型 | 理由 |
|------|------|------|
| 语言 | TypeScript (strict mode) | 类型安全 + 生态活跃 |
| 运行时 | Node.js ≥ 20 (LTS) | 原生 ESM + 顶级 await |
| LLM 集成 | Vercel AI SDK (`ai` package) | 统一多模型接口 + 原生流式 + `generateObject` |
| 数据校验 | Zod | Vercel AI SDK 原生绑定 |
| 状态机 | 轻量 TypeScript enum + 转移函数（Phase 0）→ XState（Phase 4+） | 避免早期过度抽象 [[1]](file://_________________llm_agent_____pick.txt) |
| 向量存储 | LanceDB (Node binding) | Serverless + 本地文件 + 持久化向量 [[1]](file://_________________llm_agent_____pick.txt) |
| 消息缓冲 | RxJS (`bufferTime` + `bufferCount`) | 单机轻量 + 声明式流控 [[1]](file://_________________llm_agent_____pick.txt) |
| Web 搜索 | Tavily (`@tavily/core`) | 专为 LLM Agent 优化 [[1]](file://_________________llm_agent_____pick.txt) |
| LLM 追踪 | Langfuse (Node SDK) | 原生支持 Vercel AI SDK [[1]](file://_________________llm_agent_____pick.txt) |
| 应用日志 | Pino + pino-pretty | 高性能 JSON 结构化日志 [[1]](file://_________________llm_agent_____pick.txt) |
| 图谱可视化 | Obsidian（开发/调试用） | 零代码，直接打开 `.md` 目录 [[1]](file://_________________llm_agent_____pick.txt) |
| IM 适配 | discord.js / telegraf / grammy / wechaty | 根据目标平台选择 [[1]](file://_________________llm_agent_____pick.txt) |
| 包管理 | pnpm + Turborepo (monorepo) | 多模块管理 |
| 测试 | Vitest + MSW (Mock Service Worker) | 快速 + 拦截 API 调用 |

### 0.3 核心工程原则

1. **核心自研，外围调包**：记忆图谱 + 图遍历 + Air-Reading 逻辑自己写；LLM 调用、Web 搜索、IM 接入全部用成熟框架 [[1]](file://_________________llm_agent_____pick.txt)
2. **Append-Only 写入**：话题节点永远只创建新文件，不修改旧文件，避免并发冲突和时间线混乱 [[1]](file://_________________llm_agent_____pick.txt)
3. **两阶段评估**：初筛用最便宜的模型，深评用最强模型，严控成本 [[1]](file://_________________llm_agent_____pick.txt)
4. **沉默优先**：宁可不说话，也不说废话。每次发言必须经过价值校验 [[1]](file://_________________llm_agent_____pick.txt)
5. **可观测优先**：所有 Agent 的每一步决策必须可追踪、可回放

---

## 第一章：数据结构设计 (Data Schema)

### 1.1 节点类型定义 (Zod Schemas)

```typescript
// schemas/topic-node.ts
import { z } from 'zod';

export const TopicNodeSchema = z.object({
  id: z.string().regex(/^topic_\d{8}_[a-z0-9]{6}$/),
  type: z.literal('topic'),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  expires_at: z.string().datetime().optional(), // 记忆自动过期 (隐私)
  summary: z.string().max(500),
  token_count: z.number().int().nonneg(), // 正文 Token 估算，图遍历预算控制用
  linked_users: z.array(z.string()),
  linked_topics: z.array(z.string()),
  source_message_ids: z.array(z.string()), // 原始消息 ID 锚点，用于溯源
  engagement_score: z.enum(['unknown', 'high', 'low', 'negative']).default('unknown'), // 反馈回路
  platform: z.string(), // discord / telegram / wechat
  channel_id: z.string(),
});

export type TopicNode = z.infer<typeof TopicNodeSchema>;
```

```typescript
// schemas/user-node.ts
export const UserNodeSchema = z.object({
  id: z.string(),
  type: z.literal('user'),
  display_name: z.string(),
  platform: z.string(),
  linked_topics: z.array(z.string()),
  first_seen: z.string().datetime(),
  last_seen: z.string().datetime(),
  preferences: z.record(z.string()).optional(), // 用户偏好（长期积累）
});

export type UserNode = z.infer<typeof UserNodeSchema>;
```

```typescript
// schemas/topic-state.ts
export const TopicStateSchema = z.object({
  topic_id: z.string(),
  state: z.enum([
    'NEW',              // 新话题，未评估
    'PENDING_SEARCH',   // 初筛通过，正在搜集信息
    'IGNORED',          // 初筛判定无需介入
    'IGNORED_LOW_VALUE',// 深评判定信息无增量价值
    'INTERVENED',       // 已发言
    'COOLDOWN',         // 发言后的冷却期（防连续轰炸）
    'PENDING_FEEDBACK', // 等待反馈窗口结束
  ]),
  ignored_at: z.string().datetime().optional(),   // IGNORED 时间戳
  ignored_ttl_ms: z.number().default(600_000),    // IGNORED 状态存活时间 (默认10分钟)
  intervened_at: z.string().datetime().optional(),
  retry_count: z.number().default(0),
  last_evaluated_at: z.string().datetime(),
});
```

### 1.2 Markdown 文件格式规范

```markdown
---
id: topic_20260222_a3f2c1
type: topic
created_at: "2026-02-22T08:00:00Z"
updated_at: "2026-02-22T08:00:00Z"
expires_at: "2026-08-22T08:00:00Z"
summary: "讨论关于 Rust vs Go 在微服务场景下的选型"
token_count: 342
linked_users:
  - user_alice
  - user_bob
  - user_charlie
linked_topics:
  - topic_20260220_b7e4d2
  - topic_20260221_c9a1f3
source_message_ids:
  - "msg_1001"
  - "msg_1002"
  - "msg_1003"
engagement_score: unknown
platform: discord
channel_id: "123456789"
---

# Rust vs Go 微服务选型讨论

## 背景
Alice 提出团队新项目需要选择后端语言...

## 各方观点
- **Alice**: 倾向 Rust，理由是性能和内存安全
- **Bob**: 反对 Rust，认为学习曲线过陡，建议 Go
- **Charlie**: 中立，提出可以做 benchmark 对比

## 未决事项
- 尚未达成共识，等待 benchmark 结果

## 原始消息引用
> [msg_1001] Alice: 我觉得新项目应该用 Rust...
> [msg_1002] Bob: Rust 学习成本太高了吧...
> [msg_1003] Charlie: 不如我们先做个 benchmark？
```

### 1.3 目录结构

```
memory/
├── topics/
│   ├── 2026/
│   │   ├── 02/
│   │   │   ├── topic_20260222_a3f2c1.md
│   │   │   └── topic_20260222_b4d7e8.md
│   │   └── ...
├── users/
│   ├── user_alice.md
│   ├── user_bob.md
│   └── ...
├── vectors/
│   └── lance_db/          # LanceDB 本地存储目录
├── state/
│   └── topic_states.json  # 话题状态机持久化（或 SQLite）
└── index/
    └── metadata_cache.json # 内存元数据索引的持久化快照
```

---

## 第二章：Recording Agent — 异步记忆沉淀流水线

### 2.1 消息缓冲层 (Message Buffer)

```typescript
// recording/message-buffer.ts
import { Subject, bufferTime, bufferCount, merge, filter } from 'rxjs';

interface RawMessage {
  id: string;
  author_id: string;
  author_name: string;
  content: string;
  timestamp: string;
  reply_to_message_id?: string; // IM 平台的回复关系 —— 话题聚类强信号
  channel_id: string;
  platform: string;
  attachments: Attachment[]; // 非文本消息处理
}

const messageStream$ = new Subject<RawMessage>();

// 双触发策略：满 40 条 OR 静默 5 分钟，取先到者
const buffered$ = merge(
  messageStream$.pipe(bufferCount(40)),
  messageStream$.pipe(bufferTime(5 * 60 * 1000, null, 40))
).pipe(
  filter(batch => batch.length > 0)
);

buffered$.subscribe(async (batch) => {
  await processMessageBatch(batch);
});
```

**关键改进 [[1]](file://_________________llm_agent_____pick.txt)**：
- `bufferCount` 和 `bufferTime` 取先到者，兼顾活跃群和低频群
- 每条消息携带 `reply_to_message_id`，作为后续话题聚类的**强信号**，不完全依赖语义相似度

### 2.2 话题切分流水线 (两步法)

**第一步：消息级话题标注（Topic Tagging）** [[1]](file://_________________llm_agent_____pick.txt)

不要让 LLM 一步到位完成聚类 + 总结。先对每条消息打 `topic_tag`，再按 tag 分组后总结。

```typescript
// recording/topic-tagger.ts
import { generateObject } from 'ai';
import { z } from 'zod';

const TaggedMessageSchema = z.object({
  messages: z.array(z.object({
    message_id: z.string(),
    topic_tag: z.string().describe('该消息所属的话题短标签，如"Rust选型讨论"'),
    is_noise: z.boolean().describe('是否为无信息量的消息（纯表情、"哈哈"、"收到"等）'),
  }))
});

async function tagMessages(batch: RawMessage[]) {
  const result = await generateObject({
    model: cheapModel, // Gemini Flash / GPT-4o-mini
    schema: TaggedMessageSchema,
    system: `你是一个群聊消息分类器。
规则：
1. 利用消息的 reply_to_message_id 关系判断话题归属（如果消息 B 回复了消息 A，它们大概率属于同一话题）
2. 同一时间段内语义相关的消息归为同一话题
3. 纯表情包、无意义的"哈哈""收到"标记为噪声
4. 每个话题的 tag 应该是简短的中文描述（5-15字）`,
    prompt: JSON.stringify(batch.map(m => ({
      id: m.id,
      author: m.author_name,
      content: m.content,
      reply_to: m.reply_to_message_id,
      time: m.timestamp,
      attachments: m.attachments.map(a => `[${a.type}: ${a.filename || a.type}]`)
    }))),
  });
  return result.object.messages;
}
```

**第二步：按 tag 分组 → 结构化总结**

```typescript
// recording/topic-summarizer.ts
const TopicOutputSchema = z.object({
  topics: z.array(z.object({
    suggested_id: z.string(),
    summary: z.string().max(500),
    participants: z.array(z.string()),
    key_viewpoints: z.array(z.object({
      user: z.string(),
      stance: z.string(),
    })),
    has_conflict: z.boolean(),
    related_existing_topics: z.array(z.string()).describe('如果这个话题与已有话题相关，列出已有话题的 ID'),
    unresolved_questions: z.array(z.string()),
  }))
});
```

### 2.3 非文本消息处理策略 [[1]](file://_________________llm_agent_____pick.txt)

```typescript
// recording/attachment-handler.ts

interface Attachment {
  type: 'image' | 'voice' | 'file' | 'link' | 'sticker' | 'video';
  url?: string;
  filename?: string;
}

function processAttachment(attachment: Attachment): string {
  switch (attachment.type) {
    case 'image':
      return '[图片]'; // Phase 1: 占位符
      // Phase 4+: 接入多模态模型描述图片内容
    case 'voice':
      return '[语音消息]'; // Phase 4+: 接入 Whisper 转文字
    case 'file':
      return `[文件: ${attachment.filename}]`;
    case 'link':
      return `[链接: ${attachment.url}]`;
      // Phase 2+: 复用 Tavily 提取链接摘要
    case 'sticker':
      return '[表情包]';
    default:
      return `[${attachment.type}]`;
  }
}
```

### 2.4 图谱写入层 (Append-Only)

```typescript
// recording/graph-writer.ts
import { writeFile, readFile } from 'fs/promises';
import { lock, unlock } from 'proper-lockfile';
import yaml from 'yaml';

async function writeTopicNode(node: TopicNode, body: string): Promise<void> {
  const filePath = getTopicFilePath(node.id);
  const content = `---\n${yaml.stringify(node)}---\n\n${body}`;
  
  // 文件锁保护
  const release = await lock(filePath, { 
    retries: { retries: 3, minTimeout: 100 },
    stale: 10000 // 10秒后自动释放残留锁
  });
  
  try {
    await writeFile(filePath, content, 'utf-8');
    // 写入后立即更新内存索引
    metadataIndex.set(node.id, {
      ...node,
      filePath,
    });
    // 触发 LanceDB 向量更新
    await vectorStore.upsertEmbedding(node.id, node.summary);
  } finally {
    await release();
  }
}
```

### 2.5 Recording Agent System Prompt

```typescript
const RECORDING_AGENT_SYSTEM_PROMPT = `
你是"赛博群友"系统的群聊档案管理员。你的工作是客观记录，绝不参与聊天。

## 核心规则

1. **客观记录原则**：如果群聊中存在争议，你必须保留各方观点，不能自行捏造共识。
   格式示例：
   - Alice 认为应该使用方案A，理由是...
   - Bob 反对方案A，认为风险在于...

2. **信息冲突溯源**：当发现与历史话题存在矛盾时（如之前决定用方案A，现在改用方案B），在 summary 中明确标注"更新了之前的决定"。

3. **关联发现**：如果新话题与已有话题相关，你必须在 related_existing_topics 中列出关联的话题 ID。

4. **噪声过滤**：以下内容直接丢弃，不记录：
   - 纯表情包/贴纸回复
   - "收到"、"好的"、"哈哈"等无信息量消息
   - 仅包含 @ 其他用户但无实质内容的消息

5. **强制格式**：你只能输出符合指定 JSON Schema 的结构化数据，不得输出任何解释性文字。
`;
```

---

## 第三章：内存索引与检索引擎

### 3.1 内存元数据索引 (Metadata Cache)

```typescript
// retrieval/metadata-index.ts

interface CachedMetadata {
  id: string;
  type: 'topic' | 'user';
  summary: string;
  token_count: number; // 不读正文即可做 Token 预算决策
  linked_users: string[];
  linked_topics: string[];
  created_at: string;
  filePath: string;
}

class MetadataIndex {
  private cache: Map<string, CachedMetadata> = new Map();
  
  // 冷启动：扫描所有文件的 YAML 头部
  async initialize(rootDir: string): Promise<void> {
    // 只读 YAML frontmatter，不读正文
    const files = await glob(`${rootDir}/**/*.md`);
    for (const file of files) {
      const frontmatter = await extractYAMLHead(file);
      this.cache.set(frontmatter.id, { ...frontmatter, filePath: file });
    }
    logger.info({ nodeCount: this.cache.size }, 'Metadata index initialized');
  }
  
  // 文件系统监听器 —— 增量更新
  // 注意：chokidar 在大目录 + macOS 上不稳定，设置合理的 polling interval
  startWatching(rootDir: string): void {
    const watcher = chokidar.watch(`${rootDir}/**/*.md`, {
      usePolling: true,        // macOS 稳定性
      interval: 2000,          // 2秒轮询
      ignoreInitial: true,
    });
    watcher.on('add', (path) => this.handleFileChange(path));
    watcher.on('change', (path) => this.handleFileChange(path));
  }
  
  // 逃生阀门：当节点数超过阈值时提示迁移
  checkMigrationThreshold(): void {
    if (this.cache.size > 5000) {
      logger.warn({ count: this.cache.size }, 
        '⚠️ Node count exceeds 5000. Consider migrating to SQLite + LanceDB hybrid.');
    }
  }
}
```

### 3.2 向量冷启动入口 (Semantic Entry via LanceDB)

```typescript
// retrieval/vector-store.ts
import * as lancedb from '@lancedb/lancedb';

class VectorStore {
  private db: lancedb.Connection;
  private table: lancedb.Table;
  
  async initialize() {
    this.db = await lancedb.connect('memory/vectors/lance_db');
    this.table = await this.db.openTable('topic_embeddings');
  }
  
  // Embedding 缓存：只有 summary 变更时才重新计算
  async upsertEmbedding(topicId: string, summary: string): Promise<void> {
    const existing = await this.table.search([]).where(`id = '${topicId}'`).limit(1).toArray();
    if (existing.length > 0 && existing[0].summary_hash === hashSummary(summary)) {
      return; // summary 未变，跳过重新计算
    }
    const embedding = await getEmbedding(summary);
    await this.table.add([{
      id: topicId,
      vector: embedding,
      summary_hash: hashSummary(summary),
    }]);
  }
  
  // 冷启动入口：返回 Top-K 语义最相关的种子节点
  async semanticSearch(query: string, topK: number = 5): Promise<string[]> {
    const queryEmbedding = await getEmbedding(query);
    const results = await this.table.search(queryEmbedding).limit(topK).toArray();
    return results.map(r => r.id);
  }
}
```

### 3.3 受限图遍历引擎 (Constrained BFS)

```typescript
// retrieval/graph-traversal.ts

interface TraversalConfig {
  maxHops: number;           // 最大跳数，推荐 ≤ 3
  maxNodes: number;          // 最大召回节点数
  tokenBudget: number;       // Token 预算硬上限
  semanticThreshold: number; // 语义剪枝阈值 (0-1)
  decayFactor: number;       // 衰减系数 α
  rerankTopK: number;        // Reranker 精排保留数
}

const DEFAULT_CONFIG: TraversalConfig = {
  maxHops: 3,
  maxNodes: 10,
  tokenBudget: 4000,
  semanticThreshold: 0.55,
  decayFactor: 0.7,
  rerankTopK: 5,
};

interface TraversalResult {
  nodes: Array<{
    id: string;
    depth: number;
    score: number;
    content: string;
  }>;
  totalTokens: number;
  nodesVisited: number;
  nodesPruned: number;
  trace: TraversalTrace[]; // 完整的遍历路径日志
}

async function constrainedBFS(
  seedNodeIds: string[],
  query: string,
  config: TraversalConfig = DEFAULT_CONFIG,
): Promise<TraversalResult> {
  const visited = new Set<string>();
  const result: TraversalResult = { 
    nodes: [], totalTokens: 0, nodesVisited: 0, nodesPruned: 0, trace: [] 
  };
  
  // BFS 队列：[nodeId, depth, parentScore]
  const queue: Array<[string, number, number]> = 
    seedNodeIds.map(id => [id, 0, 1.0]);
  
  const queryEmbedding = await getEmbedding(query);
  
  while (queue.length > 0) {
    const [nodeId, depth, parentScore] = queue.shift()!;
    
    // 防环
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    
    // 深度限制
    if (depth > config.maxHops) continue;
    
    // 节点数量限制
    if (result.nodes.length >= config.maxNodes) break;
    
    const metadata = metadataIndex.get(nodeId);
    if (!metadata) continue;
    
    // Token 预算检查（使用 YAML 中的 token_count，不读正文）
    if (result.totalTokens + metadata.token_count > config.tokenBudget) {
      result.trace.push({ nodeId, action: 'BUDGET_EXCEEDED', depth });
      continue;
    }
    
    // 衰减得分
    const decayedScore = parentScore * Math.pow(config.decayFactor, depth);
    
    // 读取正文（只有确认通过所有检查后才触发磁盘 I/O）
    const content = await readTopicContent(metadata.filePath);
    
    result.nodes.push({
      id: nodeId,
      depth,
      score: decayedScore,
      content,
    });
    result.totalTokens += metadata.token_count;
    result.nodesVisited++;
    
    // 语义剪枝：评估所有邻居
    const neighbors = [...metadata.linked_topics, ...metadata.linked_users];
    const unvisitedNeighbors = neighbors.filter(n => !visited.has(n));
    
    if (unvisitedNeighbors.length === 0 || depth >= config.maxHops) continue;
    
    // 粗筛：Embedding 余弦相似度
    const scoredNeighbors = await Promise.all(
      unvisitedNeighbors.map(async (nId) => {
        const nMeta = metadataIndex.get(nId);
        if (!nMeta) return { id: nId, score: 0 };
        const nEmbedding = await vectorStore.getEmbedding(nId);
        const sim = cosineSimilarity(queryEmbedding, nEmbedding);
        return { id: nId, score: sim };
      })
    );
    
    // 精排 (Reranker) —— 如果邻居数量多且得分区分度低
    let topNeighbors = scoredNeighbors
      .filter(n => n.score >= config.semanticThreshold);
    
    if (topNeighbors.length > config.rerankTopK) {
      // 调用 Cohere Rerank 或 Jina Reranker API 精排
      topNeighbors = await rerankWithCrossEncoder(
        query,
        topNeighbors.map(n => ({ id: n.id, text: metadataIndex.get(n.id)!.summary })),
        config.rerankTopK
      );
    }
    
    result.nodesPruned += (unvisitedNeighbors.length - topNeighbors.length);
    
    for (const neighbor of topNeighbors) {
      queue.push([neighbor.id, depth + 1, decayedScore * neighbor.score]);
    }
    
    result.trace.push({ 
      nodeId, action: 'EXPANDED', depth,
      neighborsTotal: unvisitedNeighbors.length,
      neighborsKept: topNeighbors.length 
    });
  }
  
  return result;
}
```

---

## 第四章：Air-Reading Agent — 主动嗅探与决策引擎

### 4.1 快速路由层 (Fast Router) [[1]](file://_________________llm_agent_____pick.txt)

在消息流入口处增加一个路由层，区分"直接 @"和"普通消息"：

```typescript
// air-reading/fast-router.ts

enum RouteType {
  DIRECT_MENTION = 'DIRECT_MENTION',   // 被直接 @，走快速路径
  PASSIVE_OBSERVE = 'PASSIVE_OBSERVE', // 普通消息，走完整评估流水线
}

function routeMessage(message: RawMessage, botUserId: string): RouteType {
  // 检查是否被直接 @
  if (message.content.includes(`<@${botUserId}>`) || 
      message.content.toLowerCase().includes('@cybergroupmate')) {
    return RouteType.DIRECT_MENTION;
  }
  return RouteType.PASSIVE_OBSERVE;
}

// 快速路径：绕过 Air-Reading，直接触发 Main Agent
async function handleDirectMention(message: RawMessage): Promise<void> {
  // 仅做记忆检索，不做 Web 搜索和深度评估
  const memoryContext = await constrainedBFS(
    await vectorStore.semanticSearch(message.content, 3),
    message.content,
    { ...DEFAULT_CONFIG, maxHops: 2, tokenBudget: 2000 } // 轻量配置
  );
  
  await mainAgent.generateResponse({
    userMessage: message,
    memoryContext: memoryContext.nodes,
    webSearchResults: null, // 跳过外部搜索
    interventionType: 'DIRECT_REPLY',
  });
}
```

### 4.2 话题状态机 (Topic State Machine)

```typescript
// air-reading/state-machine.ts

interface StateTransition {
  from: TopicState;
  to: TopicState;
  condition: string;
  timestamp: string;
}

class TopicStateMachine {
  private states: Map<string, TopicStateEntry> = new Map();
  private transitions: StateTransition[] = []; // 审计日志
  
  getState(topicId: string): TopicState | null {
    const entry = this.states.get(topicId);
    if (!entry) return null;
    
    // IGNORED 状态 TTL 检查：过期则自动回退为 NEW
    if (entry.state === 'IGNORED' || entry.state === 'IGNORED_LOW_VALUE') {
      const elapsed = Date.now() - new Date(entry.ignored_at!).getTime();
      if (elapsed > entry.ignored_ttl_ms) {
        this.transition(topicId, 'NEW', 'TTL_EXPIRED');
        return 'NEW';
      }
    }
    
    return entry.state;
  }
  
  transition(topicId: string, newState: TopicState, reason: string): void {
    const entry = this.states.get(topicId) || createDefaultEntry(topicId);
    const oldState = entry.state;
    entry.state = newState;
    entry.last_evaluated_at = new Date().toISOString();
    
    if (newState.startsWith('IGNORED')) {
      entry.ignored_at = new Date().toISOString();
    }
    if (newState === 'INTERVENED') {
      entry.intervened_at = new Date().toISOString();
    }
    
    this.states.set(topicId, entry);
    this.transitions.push({ from: oldState, to: newState, condition: reason, timestamp: new Date().toISOString() });
    
    logger.info({ topicId, from: oldState, to: newState, reason }, 'State transition');
  }
  
  // 话题内容显著偏移时的重置触发器
  resetIfDrifted(topicId: string, newKeywords: string[], oldKeywords: string[]): void {
    const overlapRatio = calculateOverlap(newKeywords, oldKeywords);
    if (overlapRatio < 0.3) { // 关键词重合度低于 30%
      this.transition(topicId, 'NEW', 'TOPIC_DRIFT_DETECTED');
    }
  }
}
```

### 4.3 初筛评估 (First-Pass Triage)

```typescript
// air-reading/triage.ts

const TriageResultSchema = z.object({
  should_intervene: z.boolean(),
  reason: z.string(),
  intervention_type: z.enum([
    'FACTUAL_CORRECTION',     // 纠正事实错误
    'KNOWLEDGE_GAP',          // 填补知识盲区
    'CONFLICT_MEDIATION',     // 争议调解 / 多方观点综合
    'QUESTION_ANSWER',        // 回答明确问题
    'RESOURCE_SHARING',       // 分享相关资源/链接
    'CONSENSUS_SUMMARY',      // 总结当前共识
    'NOT_APPLICABLE',         // 不适合介入
  ]),
  confidence: z.number().min(0).max(1),
});

async function triageTopic(topicSummary: string, recentMessages: string[]): Promise<z.infer<typeof TriageResultSchema>> {
  const result = await generateObject({
    model: cheapModel, // Gemini Flash / GPT-4o-mini —— 成本控制
    schema: TriageResultSchema,
    system: `你是"赛博群友"的感知模块。你的工作是判断当前群聊话题是否值得AI介入。

## 判断标准
介入的充分条件（必须满足至少一个）：
1. 有人提出了一个客观事实性问题，且尚未得到准确回答
2. 群员之间对某个技术/事实问题存在明显分歧
3. 有人明确寻求信息/资源/建议
4. 讨论中出现了明显的事实错误

不介入的条件（满足任一则不介入）：
1. 纯闲聊、情感交流、日常寒暄
2. 话题过于私人化（如约饭、个人安排）
3. 已经有群员给出了足够好的回答
4. 话题不在AI的知识范围内

## 注意
- 宁可不介入，也不要强行介入。confidence < 0.6 时一律不介入。
- 你只输出结构化判断，不输出任何其他文字。`,
    prompt: `当前话题摘要：${topicSummary}\n\n最近消息：\n${recentMessages.join('\n')}`,
  });
  
  return result.object;
}
```

### 4.4 预热缓存 + 知识觅食 (Information Foraging) [[1]](file://_________________llm_agent_____pick.txt)

```typescript
// air-reading/forager.ts

interface ForagingResult {
  memoryContext: TraversalResult;
  webSearchResults: TavilySearchResult[] | null;
  totalLatencyMs: number;
}

async function forageInformation(
  topicSummary: string,
  interventionType: string,
): Promise<ForagingResult> {
  const startTime = Date.now();
  
  // 并行执行内搜和外搜 —— 预热缓存，不等深评
  const [memoryContext, webSearchResults] = await Promise.all([
    // 内搜：图谱检索
    constrainedBFS(
      await vectorStore.semanticSearch(topicSummary, 5),
      topicSummary,
    ),
    // 外搜：Web Search（仅对需要最新信息的话题类型执行）
    ['FACTUAL_CORRECTION', 'KNOWLEDGE_GAP', 'QUESTION_ANSWER', 'RESOURCE_SHARING']
      .includes(interventionType)
      ? tavilySearch(topicSummary)
      : Promise.resolve(null),
  ]);
  
  return {
    memoryContext,
    webSearchResults,
    totalLatencyMs: Date.now() - startTime,
  };
}
```

### 4.5 深度价值评估 (Second-Pass Assessment)

```typescript
// air-reading/deep-assessment.ts

const DeepAssessmentSchema = z.object({
  has_incremental_value: z.boolean(),
  value_description: z.string().max(200),
  suggested_angle: z.string().max(300).describe('建议 Main Agent 从什么角度切入'),
  confidence: z.number().min(0).max(1),
});

async function deepAssessment(
  topicSummary: string,
  memoryContext: TraversalResult,
  webSearchResults: TavilySearchResult[] | null,
): Promise<z.infer<typeof DeepAssessmentSchema>> {
  const result = await generateObject({
    model: strongModel, // GPT-4o / Claude Sonnet
    schema: DeepAssessmentSchema,
    system: `你是"赛博群友"的价值评估模块。你已经掌握了以下信息：
1. 群聊话题的摘要
2. 从记忆图谱中检索到的历史上下文
3. 从互联网搜索获得的最新资料

你的任务是判断：综合以上信息，AI 介入这个话题是否能提供**实质性的增量价值**。

## 判断标准
- "增量价值" 意味着：AI 能说出群聊中尚未被任何人提到的有用信息
- 如果搜索结果与群员已经说的内容高度重复 → 无增量价值
- 如果记忆中显示这个问题之前已经被讨论并达成共识 → 无增量价值（除非有新信息推翻旧共识）
- confidence < 0.6 时一律判定为无增量价值`,
    prompt: `话题：${topicSummary}
    
历史记忆：
${memoryContext.nodes.map(n => n.content).join('\n---\n')}

互联网搜索结果：
${webSearchResults ? JSON.stringify(webSearchResults) : '未执行搜索'}`,
  });
  
  return result.object;
}
```

### 4.6 最大等待时间阈值 [[1]](file://_________________llm_agent_____pick.txt)

```typescript
// air-reading/timeout-guard.ts

const MAX_PIPELINE_TIMEOUT_MS = 25_000; // 25秒硬上限

async function evaluateWithTimeout(topicId: string, summary: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAX_PIPELINE_TIMEOUT_MS);
  
  try {
    // 完整流水线
    const triage = await triageTopic(summary, recentMessages);
    if (!triage.should_intervene) {
      stateMachine.transition(topicId, 'IGNORED', triage.reason);
      return;
    }
    
    stateMachine.transition(topicId, 'PENDING_SEARCH', 'TRIAGE_PASSED');
    
    const foragingResult = await forageInformation(summary, triage.intervention_type);
    const assessment = await deepAssessment(summary, foragingResult.memoryContext, foragingResult.webSearchResults);
    
    if (!assessment.has_incremental_value || assessment.confidence < 0.6) {
      stateMachine.transition(topicId, 'IGNORED_LOW_VALUE', assessment.value_description);
      return;
    }
    
    // 交接给 Main Agent
    await mainAgent.generateResponse({
      topicId,
      summary,
      memoryContext: foragingResult.memoryContext,
      webSearchResults: foragingResult.webSearchResults,
      suggestedAngle: assessment.suggested_angle,
      interventionType: triage.intervention_type,
    });
    
    stateMachine.transition(topicId, 'INTERVENED', 'RESPONSE_SENT');
    
  } catch (error) {
    if (error.name === 'AbortError') {
      logger.warn({ topicId, timeout: MAX_PIPELINE_TIMEOUT_MS }, 
        'Pipeline timeout — choosing silence over late response');
      stateMachine.transition(topicId, 'IGNORED', 'TIMEOUT');
    } else {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}
```

---

## 第五章：Main Agent — 执行与闭环

### 5.1 回复生成

```typescript
// main-agent/responder.ts

interface ResponsePayload {
  topicId: string;
  summary: string;
  triggerMessage: RawMessage; // 触发初筛的那条核心消息
  memoryContext: TraversalResult;
  webSearchResults: TavilySearchResult[] | null;
  suggestedAngle: string;
  interventionType: string;
}

async function generateResponse(payload: ResponsePayload): Promise<string> {
  const { text } = await generateText({
    model: strongModel,
    system: `你是"赛博群友"，一个专业、客观但不失幽默的群聊参与者。

## 人格设定
- 你像一个见多识广的群友，不是一个 AI 助手
- 使用自然的对话语气，不要过于正式
- 适当使用群聊中常见的表达方式
- 如果信息来自网络搜索，自然地提及来源（如"我刚查了一下..."）
- 如果信息来自群里之前的讨论，自然地提及（如"之前群里不是讨论过..."）

## 硬性规则
1. 每次回复不超过 300 字（群聊消息不宜过长）
2. 必须提供增量信息，不能复述群里已经说过的话
3. 如果涉及事实断言，必须标明信息来源或置信度
4. 如果对某个观点不确定，明确说"我不太确定"而非编造
5. 保持中立，不偏袒争议中的任何一方`,
    prompt: `
当前话题：${payload.summary}
建议切入角度：${payload.suggestedAngle}

相关历史记忆：
${payload.memoryContext.nodes.map(n => `[${n.id}] ${n.content}`).join('\n---\n')}

互联网搜索结果：
${payload.webSearchResults ? JSON.stringify(payload.webSearchResults, null, 2) : '无'}

请生成你的群聊回复。`,
  });
  
  return text;
}
```

### 5.2 异步引用回复 + 发送 [[1]](file://_________________llm_agent_____pick.txt)

```typescript
// main-agent/sender.ts

async function sendToChat(
  payload: ResponsePayload, 
  responseText: string
): Promise<void> {
  // 引用触发消息，解决延迟导致的上下文错位
  await imAdapter.replyToMessage(
    payload.triggerMessage.channel_id,
    payload.triggerMessage.id,
    responseText,
  );
  
  // 状态闭环
  stateMachine.transition(payload.topicId, 'COOLDOWN', 'RESPONSE_SENT');
  
  // 启动反馈窗口 (2-5 分钟后评估群友反应)
  setTimeout(() => {
    evaluateFeedback(payload.topicId);
  }, 3 * 60 * 1000); // 3 分钟
}
```

### 5.3 反馈回路 (Feedback Loop) [[1]](file://_________________llm_agent_____pick.txt)

```typescript
// main-agent/feedback.ts

async function evaluateFeedback(topicId: string): Promise<void> {
  // 获取 Bot 发言后 3 分钟内的群聊消息
  const subsequentMessages = await imAdapter.getMessagesSince(
    stateMachine.getEntry(topicId).intervened_at!,
    3 * 60 * 1000 // 3 分钟窗口
  );
  
  if (subsequentMessages.length === 0) {
    // 无人回应 → 降低该类话题的介入倾向
    await updateEngagementScore(topicId, 'low');
    stateMachine.transition(topicId, 'INTERVENED', 'FEEDBACK_LOW');
    return;
  }
  
  // 判断后续消息是否是对 Bot 发言的回应
  const feedbackResult = await generateObject({
    model: cheapModel,
    schema: z.object({
      is_response_to_bot: z.boolean(),
      sentiment: z.enum(['positive', 'negative', 'neutral']),
      triggered_further_discussion: z.boolean(),
    }),
    prompt: `Bot 发言后的群聊消息：\n${subsequentMessages.map(m => `${m.author_name}: ${m.content}`).join('\n')}`,
  });
  
  if (feedbackResult.object.sentiment === 'negative') {
    await updateEngagementScore(topicId, 'negative');
    logger.warn({ topicId }, 'Negative feedback received — adjusting future behavior');
  } else if (feedbackResult.object.triggered_further_discussion) {
    await updateEngagementScore(topicId, 'high');
  }
  
  stateMachine.transition(topicId, 'INTERVENED', `FEEDBACK_${feedbackResult.object.sentiment.toUpperCase()}`);
}

// 将 engagement_score 写回 Markdown YAML
async function updateEngagementScore(topicId: string, score: string): Promise<void> {
  const metadata = metadataIndex.get(topicId);
  if (!metadata) return;
  // 更新 YAML frontmatter 中的 engagement_score
  await updateYAMLField(metadata.filePath, 'engagement_score', score);
}
```

---

## 第六章：成本控制与降级策略 [[1]](file://_________________llm_agent_____pick.txt)

### 6.1 成本监控

```typescript
// cost/budget-controller.ts

interface DailyBudget {
  maxTokens: number;
  currentTokens: number;
  maxAPICalls: number;
  currentAPICalls: number;
  date: string;
}

class BudgetController {
  private budget: DailyBudget;
  
  constructor(maxDailyTokens: number = 500_000, maxDailyAPICalls: number = 200) {
    this.budget = {
      maxTokens: maxDailyTokens,
      currentTokens: 0,
      maxAPICalls: maxDailyAPICalls,
      currentAPICalls: 0,
      date: new Date().toISOString().split('T')[0],
    };
  }
  
  recordUsage(tokens: number): void {
    this.resetIfNewDay();
    this.budget.currentTokens += tokens;
    this.budget.currentAPICalls++;
    
    if (this.isOverBudget()) {
      logger.warn({ ...this.budget }, '⚠️ Daily budget exceeded — entering passive mode');
    }
  }
  
  isOverBudget(): boolean {
    return this.budget.currentTokens >= this.budget.maxTokens ||
           this.budget.currentAPICalls >= this.budget.maxAPICalls;
  }
  
  // 预算耗尽后，只响应直接 @
  getAllowedMode(): 'FULL' | 'PASSIVE_ONLY' {
    return this.isOverBudget() ? 'PASSIVE_ONLY' : 'FULL';
  }
}
```

### 6.2 模型分层策略

| 调用点 | 推荐模型 | 原因 |
|--------|----------|------|
| Recording Agent 话题标注 | Gemini 2.0 Flash / GPT-4o-mini | 高频调用，需最低成本 |
| Recording Agent 话题总结 | Gemini 2.0 Flash / GPT-4o-mini | 同上 |
| Air-Reading 初筛 | Gemini 2.0 Flash / GPT-4o-mini | 高频，快速判断 |
| Air-Reading 深评 | Claude Sonnet / GPT-4o | 低频，需要高质量推理 |
| Main Agent 生成回复 | Claude Sonnet / GPT-4o | 低频，面向用户 |
| 反馈评估 | Gemini 2.0 Flash / GPT-4o-mini | 低复杂度分类任务 |
| Embedding | text-embedding-3-small / Gemini Embedding | 最便宜的 Embedding 模型 |

### 6.3 三级降级策略

```typescript
// resilience/degradation.ts

enum DegradationLevel {
  NORMAL = 0,       // 一切正常
  LEVEL_1 = 1,      // API 偶发超时
  LEVEL_2 = 2,      // API 持续不可用
  LEVEL_3 = 3,      // 文件系统异常
}

class ResilienceManager {
  private level: DegradationLevel = DegradationLevel.NORMAL;
  private consecutiveFailures: number = 0;
  
  recordAPIFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3 && this.consecutiveFailures < 10) {
      this.setLevel(DegradationLevel.LEVEL_1);
    } else if (this.consecutiveFailures >= 10) {
      this.setLevel(DegradationLevel.LEVEL_2);
    }
  }
  
  recordFileSystemError(): void {
    this.setLevel(DegradationLevel.LEVEL_3);
  }
  
  private setLevel(newLevel: DegradationLevel): void {
    if (newLevel === this.level) return;
    this.level = newLevel;
    logger.error({ level: newLevel }, `Degradation level changed`);
    
    switch (newLevel) {
      case DegradationLevel.LEVEL_1:
        // 自动重试 + 使用缓存的搜索结果
        break;
      case DegradationLevel.LEVEL_2:
        // Air-Reading 停止主动介入，仅保留被动 @ 响应
        // 使用纯记忆检索（无 Web Search）
        break;
      case DegradationLevel.LEVEL_3:
        // 所有 Agent 停止工作
        // 向管理员发送告警
        // Bot 在群聊中发送"暂时离线"通知
        imAdapter.sendMessage(adminChannelId, '⚠️ 赛博群友遇到系统异常，暂时离线');
        break;
    }
  }
}
```

---

## 第七章：隐私与数据生命周期管理 [[1]](file://_________________llm_agent_____pick.txt)

### 7.1 记忆自动过期

```typescript
// privacy/memory-gc.ts

// 定时任务：每天凌晨执行
async function garbageCollectExpiredMemories(): Promise<void> {
  const now = new Date();
  
  for (const [id, metadata] of metadataIndex.entries()) {
    if (metadata.expires_at && new Date(metadata.expires_at) < now) {
      // 删除文件
      await fs.unlink(metadata.filePath);
      // 从索引中移除
      metadataIndex.delete(id);
      // 从向量库中移除
      await vectorStore.delete(id);
      
      logger.info({ id, expires_at: metadata.expires_at }, 'Expired memory cleaned');
    }
  }
}
```

### 7.2 `/forget` 命令

```typescript
// privacy/forget-command.ts

async function handleForgetCommand(userId: string): Promise<string> {
  let deletedCount = 0;
  
  // 删除用户节点文件
  const userFilePath = `memory/users/${userId}.md`;
  if (await fs.exists(userFilePath)) {
    await fs.unlink(userFilePath);
    deletedCount++;
  }
  
  // 从所有话题的 linked_users 中移除该用户
  for (const [id, metadata] of metadataIndex.entries()) {
    if (metadata.linked_users.includes(userId)) {
      // 从 YAML 中移除该用户引用
      await removeUserFromTopic(metadata.filePath, userId);
      // 不删除整个话题节点，因为可能涉及其他参与者
    }
  }
  
  return `已删除与你相关的 ${deletedCount} 条记忆记录。`;
}
```

### 7.3 存储安全

- 所有 `.md` 文件存储在用户指定的目录中，建议配置为有访问控制的路径
- 生产环境建议将 `memory/` 目录放在加密卷（如 LUKS 或 FileVault）上
- `.env` 中的 API Key 使用 `dotenv` + `.gitignore` 保护

---

## 第八章：可观测性全景

### 8.1 Langfuse 集成（LLM 链路追踪）

```typescript
// observability/tracing.ts
import { Langfuse } from 'langfuse';

const langfuse = new Langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
});

// 每次 LLM 调用都创建 trace
async function tracedGenerateObject<T>(params: GenerateObjectParams<T>, traceName: string) {
  const trace = langfuse.trace({ name: traceName });
  const generation = trace.generation({
    name: `${traceName}_generation`,
    model: params.model.modelId,
    input: params.prompt,
  });
  
  const result = await generateObject(params);
  
  generation.end({
    output: result.object,
    usage: {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
    },
  });
  
  return result;
}
```

### 8.2 Pino 结构化日志

```typescript
// observability/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' 
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  // 生产环境：原始 JSON，便于接入 Elasticsearch / Loki
});

// 使用示例（附带结构化上下文）
logger.info({ 
  agent: 'air-reading', 
  topicId: 'topic_20260222_a3f2c1',
  action: 'TRIAGE',
  result: 'SHOULD_INTERVENE',
  latencyMs: 342,
}, 'Triage completed');
```

### 8.3 Obsidian 图谱可视化

无需额外代码。开发时：
1. 在 Obsidian 中打开 `memory/` 目录作为 Vault
2. 打开 Graph View → 实时查看节点关系
3. 通过搜索 YAML 属性定位问题节点

### 8.4 运行时指标仪表板（可选，Phase 4+）

```typescript
// observability/metrics.ts

interface SystemMetrics {
  totalTopicNodes: number;
  totalUserNodes: number;
  todayLLMCalls: number;
  todayTokensUsed: number;
  todayInterventions: number;
  todayIgnored: number;
  avgPipelineLatencyMs: number;
  currentDegradationLevel: DegradationLevel;
  budgetRemainingPercent: number;
}

// 暴露一个 HTTP endpoint 供 Grafana / 简单 Web UI 拉取
// 或者定期输出到 Pino 日志中
```

---

## 第九章：分阶段实施路线图

### Phase 0 — 基础设施搭建 (1-2 周)

| 任务 | 交付物 | 验收标准 |
|------|--------|----------|
| 初始化 monorepo (pnpm + Turborepo) | 项目脚手架 | `pnpm build` 通过 |
| 用 Zod 定义所有核心数据结构 | `schemas/` 目录 | 全部类型导出、单元测试通过 |
| 搭建 IM 平台适配器 | `adapters/` 目录 | 能接收群聊消息、发送回复、引用回复 |
| 接通 Vercel AI SDK + Langfuse 追踪 | `observability/` 目录 | 一次 `generateText` 调用在 Langfuse 面板中可见 |
| 搭建 Pino 结构化日志 | `logger.ts` | 开发环境彩色输出、生产环境 JSON |
| 搭建 BudgetController 骨架 | `cost/` 目录 | 能统计调用次数和 Token |
| 搭建 ResilienceManager 骨架 | `resilience/` 目录 | 三级降级逻辑可运行 |

**里程碑：Bot 能上线，能收发消息，所有调用可追踪。**

---

### Phase 1 — Recording Agent MVP (1-2 周)

| 任务 | 交付物 | 验收标准 |
|------|--------|----------|
| 实现 RxJS 消息缓冲队列 | `recording/message-buffer.ts` | `bufferTime(5min)` + `bufferCount(40)` 双触发正常工作 |
| 实现两步话题切分（标注 → 总结） | `recording/topic-tagger.ts` + `topic-summarizer.ts` | 输出符合 Zod schema 的结构化数据 |
| 实现非文本消息占位符处理 | `recording/attachment-handler.ts` | 图片/语音/文件正确标记 |
| 实现 Markdown 文件写入（Append-Only + 文件锁） | `recording/graph-writer.ts` | 并发写入测试通过（无文件损坏） |
| 用 Obsidian 打开 `memory/` 目录验证图谱质量 | 手动验证报告 | 节点关系图可视化正确 |

**里程碑：Bot 能静默记录群聊，在 Obsidian 中看到自动生成的知识图谱。**

---

### Phase 2 — 检索引擎核心 (1-2 周)

| 任务 | 交付物 | 验收标准 |
|------|--------|----------|
| 实现 MetadataIndex（冷启动 + chokidar 增量更新） | `retrieval/metadata-index.ts` | 新文件写入后 5 秒内索引可查 |
| 实现 LanceDB 向量冷启动入口 | `retrieval/vector-store.ts` | `semanticSearch()` 返回正确的 Top-K |
| 实现带四重约束的 BFS 图遍历引擎 | `retrieval/graph-traversal.ts` | 防死循环 + 防 Token 爆炸的单元测试全部通过 |
| 实现 Reranker 精排（Cohere / Jina API） | `retrieval/reranker.ts` | 精排后的 Top-5 质量明显优于粗排 |
| 编写 traversal trace 日志 | 集成到 Pino | 每次遍历的完整路径可查 |

**里程碑：能输入一个 Query，返回高质量的多跳上下文。**

---

### Phase 3 — Air-Reading Agent + Main Agent (2-3 周)

| 任务 | 交付物 | 验收标准 |
|------|--------|----------|
| 实现快速路由层（直接 @ vs 主动介入） | `air-reading/fast-router.ts` | 被 @ 时 < 5 秒响应 |
| 实现话题状态机（含 IGNORED TTL + 话题漂移检测） | `air-reading/state-machine.ts` | 状态流转测试覆盖所有分支 |
| 实现初筛（cheapModel + Zod） | `air-reading/triage.ts` | 准确率 > 80%（人工标注 50 条验证） |
| 实现知识觅食（并行内搜 + 外搜） | `air-reading/forager.ts` | 延迟 < 10 秒 |
| 实现深度价值评估 | `air-reading/deep-assessment.ts` | 能正确拒绝无增量价值的介入 |
| 实现最大等待时间阈值（25 秒硬上限） | `air-reading/timeout-guard.ts` | 超时后静默，不发迟到消息 |
| 接入 Tavily Web Search | `tools/web-search.ts` | 搜索结果正确返回 Markdown 格式 |
| 实现 Main Agent 回复生成 | `main-agent/responder.ts` | 回复 < 300 字、自然流畅 |
| 实现异步引用回复机制 | `main-agent/sender.ts` | 延迟回复正确引用原始消息 |

**里程碑：Bot 能在群聊中自主判断何时发言，并发出有建设性的回复。**

---

### Phase 4 — 闭环、打磨与高级功能 (持续迭代)

| 任务 | 优先级 | 预估工时 |
|------|--------|----------|
| 反馈回路（发言后 3 分钟评估群友反应） | 高 | 3 天 |
| 成本监控仪表板（每日 Token/API 统计） | 高 | 2 天 |
| 每日 Token 预算上限 + 自动进入被动模式 | 高 | 1 天 |
| 记忆自动过期清理（GC） | 中 | 2 天 |
| `/forget` 隐私命令 | 中 | 2 天 |
| 链接自动摘要（复用 Tavily） | 中 | 2 天 |
| 状态机迁移到 XState（如复杂度增长） | 低 | 3 天 |
| 多模态处理（图片描述、语音转文字） | 低 | 5 天 |
| 迁移脚本（MD → SQLite + LanceDB 混合方案） | 低（>5000 节点时） | 5 天 |
| 多平台适配（同时接入 Discord + Telegram） | 低 | 3 天 |

---

## 第十章：测试策略

### 10.1 单元测试 (Vitest)

| 模块 | 关键测试用例 |
|------|-------------|
| Zod Schema | 合法 YAML 解析通过 / 非法数据拒绝 |
| BFS 图遍历 | 环形图不死循环 / Token 预算触发熔断 / 语义剪枝正确过滤 |
| 状态机 | 所有状态转移路径 / TTL 过期自动回退 / 话题漂移重置 |
| 消息缓冲 | `bufferCount` 触发 / `bufferTime` 触发 / 空队列不触发 |
| BudgetController | 预算耗尽切换被动模式 / 跨天自动重置 |
| ResilienceManager | 连续失败触发降级 / 恢复后升级 |

### 10.2 集成测试 (MSW Mock)

使用 MSW (Mock Service Worker) 拦截所有 LLM API 和 Tavily 调用，返回预定义的 mock 响应。验证整条流水线从消息缓冲 → 话题切分 → 状态评估 → 回复生成的端到端逻辑。

### 10.3 人工验收 (Phase 3 末)

- 邀请 5-10 人在测试群中自由聊天 1 小时
- 收集 Bot 的所有"发言/沉默"决策
- 人工标注每个决策的正确性
- 计算准确率、误报率（不该说话时说了）和漏报率（该说话时沉默了）

---

## 附录 A：项目目录结构总览

```
cybergroupmate/
├── packages/
│   ├── core/                     # 核心业务逻辑
│   │   ├── schemas/              # Zod 数据结构定义
│   │   ├── recording/            # Recording Agent
│   │   ├── retrieval/            # 检索引擎（BFS + Vector）
│   │   ├── air-reading/          # Air-Reading Agent
│   │   ├── main-agent/           # Main Agent
│   │   ├── cost/                 # 成本控制
│   │   ├── resilience/           # 降级策略
│   │   ├── privacy/              # 隐私管理
│   │   └── observability/        # 日志 + 追踪
│   ├── adapters/                 # IM 平台适配器
│   │   ├── discord/
│   │   ├── telegram/
│   │   └── shared/               # 抽象接口层
│   └── tools/                    # 外部工具
│       ├── web-search.ts         # Tavily 封装
│       └── reranker.ts           # Cohere/Jina Reranker 封装
├── memory/                       # 数据目录（.gitignore）
│   ├── topics/
│   ├── users/
│   ├── vectors/
│   ├── state/
│   └── index/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/                 # Mock 数据
├── turbo.json
├── pnpm-workspace.yaml
├── .env.example
└── README.md
```

---

## 附录 B：关键风险清单与缓解措施

| 风险 | 严重程度 | 缓解措施 |
|------|----------|----------|
| 话题聚类质量差 → 下游全链路出错 | **高** | 两步法切分 + 利用 `reply_to_message_id` + Phase 1 人工验证 |
| `proper-lockfile` 在高并发下死锁 | 中 | 设置 `stale` 超时 + 监控锁残留 |
| chokidar 在 macOS 大目录下不稳定 | 中 | 使用 `usePolling: true` + 设置合理 interval |
| LLM API 突发故障 | 中 | 三级降级策略 + 多模型 fallback |
| Token 成本失控 | 中 | 每日预算上限 + 模型分层 + Embedding 缓存 |
| Bot 在群聊中发出令人尴尬的回复 | **高** | 两阶段评估 + 25 秒超时 + 反馈回路调权 |
| 隐私合规风险 | 中 | `expires_at` 自动清理 + `/forget` 命令 + 加密存储 |
| 节点数量超过文件系统承载能力 | 低 | >5000 节点时触发迁移告警 + 预留 SQLite 迁移脚本 |

---

这份实施计划覆盖了我们之前对话中讨论的**所有方面** [[1]](file://_________________llm_agent_____pick.txt)，包括：

- ✅ 基于 Markdown 的图谱记忆系统（含 Append-Only 写入策略）
- ✅ 两步话题切分（消息标注 → 分组总结）
- ✅ 带四重约束的 BFS 图遍历（防环 + 深度限制 + 语义剪枝 + Token 预算）
- ✅ Reranker 精排层
- ✅ Air-Reading Agent（含 IGNORED TTL + 话题漂移检测 + 最大等待时间）
- ✅ 快速路由层（直接 @ vs 主动介入）
- ✅ 预热缓存机制（初筛通过后立即并行启动搜索）
- ✅ 反馈回路（engagement_score）
- ✅ 非文本消息处理策略
- ✅ 成本控制（模型分层 + 每日预算 + Embedding 缓存）
- ✅ 三级降级策略
- ✅ 隐私与数据生命周期（自动过期 + `/forget` 命令）
- ✅ 可观测性（Langfuse + Pino + Obsidian + XState Inspector）
- ✅ 完整的 Phase 0-4 实施路线图和测试策略

如果你需要对任何具体模块进一步细化（比如某个 Agent 的完整 System Prompt、某个测试用例的 fixture 数据、或者某个平台适配器的具体实现），请告诉我。