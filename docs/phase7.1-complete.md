# Phase 7.1 — Failure Intelligence（经验记忆闭环）

## 完成时间

2026-07-30

## Commit

```
1f8ebdef9d43e0601c7912f6f35a231a234d09c6
```

## 目标

截至 Phase 6.5，系统已具备观测、自愈、治理与混沌验证基础。本阶段将失败记录（Alert / Trace / Chaos Result）转化为结构化经验，形成「归因提炼 → 经验沉淀 → 动态注入前置约束」闭环，让新 Agent / 新执行链直接继承"踩坑经验"，从源头避免同类错误复发。

## 核心架构

```
Alerts / Trace Breakpoints / Chaos Results
                ├──► Failure Classifier & Extractor（归因与模式提炼）
                ├──► FailurePattern（失败模式抽象）
                ├──► Experience Memory Store（隔离记忆库：frequency/confidence/TTL）
                └──► Experience Injector（Capability Dispatch & Task Planning 前置注入）
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/experience/types.ts` | 新增 `FailurePattern`、`ExperienceItem`、`FailureCategory`、`ExperienceType`、`ExperienceStatus`、`FederationStatus`、`ExperienceQuery` |
| `src/experience/failure-extractor.ts` | 新增：`FailureExtractor`（归因提炼 + 置信度/频次 + 衰减 + `queryRelevantExperience`） |
| `src/experience/experience-injector.ts` | 新增：`ExperienceInjector`（Dispatch / Replan 前置约束注入） |
| `src/experience/experience-store.ts` | 新增：`ExperienceStore` 接口 |
| `src/experience/sqlite-experience-store.ts` | 新增：基于 better-sqlite3 的持久化（`experience.db`），过期/衰减逻辑 |
| `src/execution/execution-record-service.ts` | 接入：真实失败喂给 extractor（`extractFailureExperience`），排除 policy_denied，仅 failure/timed_out；timeout→resource_exhausted、capability_error→tool_capability_mismatch |
| `src/simulation/simulation-engine.ts` | 注入 extractor（供 7.2 推演过滤经验） |
| `src/dashboard/api-routes.ts` | 新增 `/api/experience/*` 端点 |

## 关键实现

- **归因提炼**：`extractFromFailure({triggerContext,symptom,rootCause,category})` 归一化后按上下文聚频；新 pattern 由 frequency=1 起步，`confidence` 按频率表取。
- **置信度**：`CONFIDENCE_BY_FREQUENCY=[0,0.35,0.55,0.75,0.85,0.92,0.96]`，每多一个来源 +0.05（封顶 +0.15），结果封顶 0.99。仅 `MIN_CONFIDENCE_FOR_EXPERIENCE=0.6` 以上才生成 ExperienceItem（免僵化）。
- **TTL / 衰减**：`EXPERIENCE_TTL_MS=30 天`；`runDecay()` 将过期 active→expired；低频（freq<3）且 7 天未触达的 active 衰减置信度 ×0.8（下限 0.1）；再次命中强化则续期并 `decayed→active`。
- **规则推演 `inferRule`**：按 category 产出 `{avoid, prefer, constraints}`；`tool_capability_mismatch→{avoid:symptom, prefer:可行替代}`（启发式：sendPhoto→sendMedia、sendMessage→sendText 等）。
- **前置注入**：`getConstraintsForDispatch`（minConfidence 0.6）/`getConstraintsForReplan`（minConfidence 0.5）；`injectToTarget` 将规则改写为目标 `avoidMethods / preferMethods`。

## API

- `POST /api/experience/extract`
- `GET /api/experience/patterns`
- `POST /api/experience/decay`
- `POST /api/experience/inject-dispatch`
- `POST /api/experience/inject-replan`

## 验收标准

- 频繁同类报错 → 归纳出 `FailurePattern`，`confidence > 0.8` 的 `ExperienceItem`。
- 单次偶发报错（freq=1, confidence=0.35 < 0.6）不生成阻断经验。
- 超期 / 置信度衰减 → 自动转为 `decayed / expired`。
- Capability Matching 时自动拉取并注入 `avoid / prefer` 约束。

## 未实现

- Experience 效果闭环（命中/避坑收益）——移交 7.2。
- 经验联邦与跨 Agent 分发——移交 Phase 8.1。

## 回滚指南

```bash
git revert 1f8ebdef9d43e0601c7912c6f35a231a234d09c6
```