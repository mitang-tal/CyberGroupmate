/**
 * dashboard/types.ts — Dashboard 类型定义
 */

import type { SubagentManager } from "../subagent/subagent-manager.js";
import type { CallbackQueue } from "../subagent/callback-queue.js";
import type { MainAgentLoop } from "../main-agent/main-agent-loop.js";
import type { GlobalState } from "../main-agent/global-state.js";
import type { SandboxPool } from "../sandbox/sandbox-pool.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import type { NotificationCenter } from "../event/notification-center.js";
import type { TokenStatsCollector } from "./token-stats.js";
import type { MediaDownloader } from "../core/media-downloader.js";
import type { ImageCatalog } from "../core/image-catalog.js";
import type { PlatformAdapter } from "../adapter/platform-adapter.js";
import type { AppConfig } from "../core/config.js";
import type { AttentionAccumulator } from "../accumulator/attention-accumulator.js";
import type { MetaSandbox } from "../meta-sandbox/meta-sandbox.js";
import type { ExecutionRecordService } from "../execution/execution-record-service.js";
import type { CapabilityRegistry } from "../capability-registry/capability-registry.js";
import type { CapabilityDispatcher } from "../capability-registry/capability-dispatcher.js";
import type { MetaDecisionEngine } from "../meta-decision/meta-decision-engine.js";
import type { DynamicReplanner } from "../task-planner/dynamic-replanner.js";
import type { GlobalGuardrailEvaluator } from "../governance/global-guardrail-evaluator.js";
import type { StabilityTestSuite } from "../validation/stability-test-suite.js";
import type { ChaosEngine } from "../validation/chaos-engine.js";
import type { CostGuard } from "../validation/cost-guard.js";
import type { FailureExtractor } from "../experience/failure-extractor.js";
import type { ExperienceInjector } from "../experience/experience-injector.js";
import type { SimulationEngine } from "../simulation/simulation-engine.js";
import type { ReputationEvaluator } from "../reputation/reputation-evaluator.js";
import type { MetaSelfTestEngine } from "../meta-test/meta-self-test-engine.js";
import type { EcosystemGovernor } from "../ecosystem/ecosystem-governor.js";
import type { FederationStore } from "../ecosystem/federation-store.js";
import type { ConflictResolver } from "../conflict/conflict-resolver.js";
import type { NegotiationEngine } from "../negotiation/negotiation-engine.js";
import type { EvolutionAnalyzer } from "../evolution/evolution-analyzer.js";
import type { EcosystemGovernance } from "../governance-v2/ecosystem-governance.js";

/** Dashboard 需要的所有组件引用 */
export interface DashboardDeps {
    nc: NotificationCenter;
    subagentManager: SubagentManager;
    accumulator: AttentionAccumulator;
    q5: CallbackQueue;
    mainLoop: MainAgentLoop;
    globalState: GlobalState;
    sandboxPool: SandboxPool;
    memory: MemoryStoreV2;
    tokenStats: TokenStatsCollector;
    executionRecordService: ExecutionRecordService;
    /** 媒体下载管理器（用于贴纸预览等） */
    mediaDownloader?: MediaDownloader;
    /** 图片目录（用于表情包频率追踪和预览） */
    imageCatalog?: ImageCatalog;
    /** 平台 adapter 引用（用于 mute 等控制操作） */
    adapters?: PlatformAdapter[];
    /** Meta-CodeAct sandbox（用于 Dashboard debug 执行） */
    metaSandbox?: MetaSandbox;
    /** Dashboard 保存配置后的回调（用于热应用） */
    onConfigSaved?: (config: AppConfig) => Promise<void> | void;
    /** Background Agent HarnessManager */
    harnessManager?: import("../harness/manager.js").HarnessManager;
    /** Agent 能力注册表 */
    capabilityRegistry?: CapabilityRegistry;
    /** Agent 能力调度器 */
    capabilityDispatcher?: CapabilityDispatcher;
    /** Meta 自主决策引擎 */
    metaDecisionEngine?: MetaDecisionEngine;
    /** 动态任务规划器 */
    dynamicReplanner?: DynamicReplanner;
    /** 全局安全护栏 */
    globalGuardrail?: GlobalGuardrailEvaluator;
    /** 稳定性验证套件 */
    stabilityTestSuite?: StabilityTestSuite;
    /** 故障注入引擎 */
    chaosEngine?: ChaosEngine;
    /** 成本护栏 */
    costGuard?: CostGuard;
    /** 失败智能提取器 */
    failureExtractor?: FailureExtractor;
    /** 经验注入器 */
    experienceInjector?: ExperienceInjector;
    /** 沙盒推演引擎 */
    simulationEngine?: SimulationEngine;
    /** Agent 声誉评估器 */
    reputationEvaluator?: ReputationEvaluator;
    /** Meta 自检引擎 */
    metaSelfTestEngine?: MetaSelfTestEngine;
    /** 生态治理引擎 */
    ecosystemGovernor?: EcosystemGovernor;
    /** 经验联邦服务 */
    federationStore?: FederationStore;
    /** 冲突仲裁器 */
    conflictResolver?: ConflictResolver;
    /** 协商引擎 */
    negotiationEngine?: NegotiationEngine;
    /** 演化分析器 */
    evolutionAnalyzer?: EvolutionAnalyzer;
    /** 生态治理引擎 */
    ecosystemGovernance?: EcosystemGovernance;
}

/** Dashboard 配置 */
export interface DashboardConfig {
    /** 监听地址，默认 127.0.0.1 */
    host?: string;
    port: number;
    token: string;
    enabled: boolean;
}

/** WebSocket 推送事件 */
export interface WsEvent {
    type: string;
    timestamp: string;
    data: unknown;
}
