# Phase 6.3 — Dynamic Task Planning & Auto-Repair v1

## 完成时间

2026-07-30

## Commit

```
3414201d498e13345cffe9013b5f1dcc86ec37ff
```

## 目标

实现动态任务规划与深度修复。当 Agent 在复杂多步骤执行链中遇到无法通过简单重试恢复的业务级中断时，Meta 结合 Trace Tree 上下文对后续未完成的任务节点进行实时重新拆解与热替换。

## 架构

```
Execution Failure / Trace Breakpoint
        │
        ▼
DynamicReplanner (断点分析 + Patch 生成)
        │
        ▼
TaskPatch (replace / skip / insert / truncate)
        │
        ▼
Hot-Swap Engine → ReplanPlan → Resume Execution
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/task-planner/types.ts` | **新文件** — TaskPatch, ExecutionReplanPlan, ReplacementStep, PatchType/PatchStatus 类型 |
| `src/task-planner/task-patch-store.ts` | **新文件** — TaskPatchStore 接口 |
| `src/task-planner/sqlite-task-patch-store.ts` | **新文件** — SQLite 实现：`task_patches` + `execution_replan_plans` 表 |
| `src/task-planner/dynamic-replanner.ts` | **新文件** — 重规划引擎：断点定位、4 策略 Patch 生成、步骤热替换、ReplanPlan 构建 |
| `src/dashboard/types.ts` | DashboardDeps 新增 `dynamicReplanner` |
| `src/dashboard/api-routes.ts` | 新增 5 个 `/api/task-planner/*` 路由 |
| `src/dashboard/public/task-replanning.html` | **新文件** — Task Re-planning Dashboard |

## Patch 策略

| 策略 | 触发条件 | 行为 |
|------|----------|------|
| `replace_step` | 超时/TimeoutError | 用替代实现替换失败步骤（通过 CapabilityDispatcher 寻址） |
| `skip_step` | policy_denied | 跳过非关键步骤继续执行 |
| `insert_fallback_step` | host_call 失败 | 插入 fallback handler 使用缓存/默认值 |
| `truncate_and_complete` | 非关键路径失败 | 截断剩余链，已完成步骤足够交付 |

## 断点分析

1. 从 Trace Tree 定位失败节点
2. 收集已完成步骤的 Output 作为上下文
3. 提取失败步骤之后的剩余节点 ID
4. 根据错误类型和 Source 选择 Patch 策略
5. 通过 CapabilityDispatcher 生成替代步骤路由

## 热替换流程

1. `generateTaskPatch()` → 生成 draft 状态的 TaskPatch
2. `applyTaskPatch()` → 状态更新为 applied，生成 ExecutionReplanPlan
3. ReplanPlan 记录完成步骤 ID / 剩余步骤 ID / Patches

## API 端点

| 路由 | 方法 | 说明 |
|------|------|------|
| `POST /api/task-planner/generate-patch` | 生成 | body: `{ executionId, failedStepId }` |
| `POST /api/task-planner/apply-patch/:patchId` | 应用 | 生成 ReplanPlan |
| `GET /api/task-planner/patches` | 查询 | 支持 executionId/status 过滤 |
| `GET /api/task-planner/plans` | 查询 | 支持 executionId 过滤 |
| `GET /api/task-planner/:executionId/history` | 历史 | 完整重规划历史 |

## Dashboard 功能

- **Generate Patch** 表单：输入 Execution ID + Failed Step ID，一键生成 Patch
- **Patch 列表**：Type 彩色标签、Status、Execution/Step ID、Reasoning、Apply 按钮
- **Patch 详情弹窗**：完整信息 + Diff 视图（显示 removed failed step → added replacement steps）

## 验收标准

| 标准 | 状态 |
|------|------|
| 断点提取与 Patch 生成 | ✅ findNodeById + selectPatchType + generateReplacementSteps |
| 热替换与恢复 | ✅ applyTaskPatch → ReplanPlan |
| 前端对比展示 | ✅ Diff 视图显示 removed → added |

## 当前 Phase 6 总进度

```
6.1 Capability Registry & Dispatch    ✅
6.2 Autonomous Decision Engine        ✅
6.3 Dynamic Task Planning             ✅
6.4 Global Guardrails                 ⬜
```

## 已知问题

1. **Hot-Swap 仅生成计划**：`applyTaskPatch` 生成 ReplanPlan 记录替换节点，但实际重新调度执行需要在 Phase 6.4 中通过 Guardrails + Dispatch 联动完成。
2. **断点分析依赖 Trace Tree**：如果 Trace Tree 中节点顺序不准确（例如并行执行），`traverseIds` 的 before/after 划分可能有偏差。
3. **API 受 `DashboardDeps` 可选保护**：如果 `dynamicReplanner` 未注入，路由自动跳过。

## 回滚指南

```bash
git revert 3414201d498e13345cffe9013b5f1dcc86ec37ff
```
