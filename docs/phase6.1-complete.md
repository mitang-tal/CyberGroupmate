# Phase 6.1 — Agent Capability Registry & Dispatch

## 完成时间

2026-07-30

## Commit

```
f33e7c7f5e55a28d84ea76babaf16d17d48586fa
```

## 目标

建立 Agent 能力拓扑与动态调度机制，使 Meta 可以根据任务需求自动寻址、实例化或调度最合适的 Agent。

## 架构

```
Meta Orchestrator
        │
        ▼
CapabilityRegistry (Agent 注册表)
        │
        ▼
CapabilityDispatcher (路由调度器)
        │
   ┌────┴────┐
   ▼         ▼
 Exact    Rule     Fallback
 Match    Match    Match
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/capability-registry/types.ts` | **新文件** — AgentCapability, AgentRegistration, DispatchRequest/Match 类型 |
| `src/capability-registry/capability-registry.ts` | **新文件** — 注册服务：register/heartbeat/updateStatus/unregister, 60s 心跳超时自动 offline, 能力拓扑, 活跃任务计数 |
| `src/capability-registry/capability-dispatcher.ts` | **新文件** — 路由引擎：3 级匹配策略 (exact/rule/fallback), confidence 评分, listCandidates 排序 |
| `src/dashboard/types.ts` | DashboardDeps 新增 `capabilityRegistry` 和 `capabilityDispatcher` 可选字段 |
| `src/dashboard/api-routes.ts` | 新增 6 个 `/api/capabilities/*` 路由 |
| `src/dashboard/public/capability-registry.html` | **新文件** — Dashboard 页面：Agent 列表 + 能力拓扑 + Dispatch 测试面板 + Agent 详情弹窗 |

## 关键实现

### 3 层匹配策略

| 优先级 | 策略 | 条件 | Confidence |
|--------|------|------|------------|
| 1 | Exact Match | 请求 tags 完全命中能力 tags | 1.0 |
| 2 | Rule Match | 请求 category 匹配能力 category | 0.7 |
| 3 | Fallback | 能力名称文本相似度 | 0.2-0.3 |

同等级内按 `activeTaskCount` 升序（最少负载优先）。

### 心跳与状态管理

- Agent 注册后自动启动心跳检测计时器
- 超过 60s 未收到心跳 → 自动标记 `offline`
- 状态变化：`online` → `busy`（taskCount>0）→ `online`（taskCount=0）
- 支持手动设置 `maintenance` 状态（不被调度）

### 能力拓扑

`getCapabilityTopology()` 按 category 聚合，统计每个能力有多少在线 Agent，返回：

```json
[{ "category": "code_execution", "capabilities": [{ "name": "sandbox.run", "agentCount": 2 }] }]
```

## API 端点

| 路由 | 方法 | 说明 |
|------|------|------|
| `GET /api/capabilities/agents` | 查询 | 列出所有 Agent（支持 status 过滤） |
| `GET /api/capabilities/agents/:id` | 详情 | Agent 信息 + 能力列表 |
| `POST /api/capabilities/agents/:id/status` | 状态更新 | body: `{ status }` |
| `GET /api/capabilities/topology` | 拓扑 | 按 category 聚合的能力分布 |
| `POST /api/capabilities/dispatch` | 调度 | body: `{ taskType, tags?, category? }` → 返回最优匹配 |
| `POST /api/capabilities/candidates` | 候选 | body: `{ taskType, tags?, category? }` → 返回排序候选列表 |

## Dashboard 功能

- **Agent 列表**：名称、状态（彩色标签）、能力标签、活跃任务数、最后心跳
- **能力拓扑**：按分类展示能力名称和 Agent 数量
- **Dispatch 测试面板**：输入 taskType/category/tags，测试路由匹配结果
- **Agent 详情弹窗**：完整 Agent 信息 + 能力详情（含描述和 tags）

## 验收标准

| 标准 | 状态 |
|------|------|
| 注册与感知：Agent 注册后系统能实时感知在线状态 | ✅ registry.register() + 60s 心跳超时自动 offline |
| 准确调度：输入任务类型可返回最优 Agent 实例 | ✅ 3 层路由 + confidence 评分 |
| 接口与看板闭环：API 正常 + 前端实时查看 | ✅ 6 API + dashboard.html |

## 已知问题

1. **内存存储**：当前 `CapabilityRegistry` 使用 `Map` 在内存中存储 Agent 信息，重启后丢失。后续可接入 SQLite 持久化。
2. **Dispatch 回调**：`CapabilityDispatcher` 单纯返回最佳 Agent，未自动触发执行。需要联动 ExecutionRecordService.start() 完成端到端调度。
3. **Capability API 受 `DashboardDeps` 可选字段保护**：如果 `capabilityRegistry` 未注入，API 路由自动跳过（返回 404）。

## 回滚指南

```bash
git revert f33e7c7f5e55a28d84ea76babaf16d17d48586fa
```
