/**
 * 能力注册表数据模型
 */

/** Agent 能力——描述一个 Agent 能做什么 */
export interface AgentCapability {
    capabilityId: string;
    name: string;
    /** 能力标签，用于精确匹配调度 */
    tags: string[];
    /** 能力分类，用于规则匹配 */
    category: string;
    /** 描述该能力适合解决什么问题 */
    description: string;
    /** 参数类型描述（schema-free，用于 Meta 决策时参考） */
    inputHint?: string;
    outputHint?: string;
}

/** Agent 运行时状态 */
export type AgentRuntimeStatus = "online" | "busy" | "offline" | "maintenance";

/** Agent 注册信息 */
export interface AgentRegistration {
    agentId: string;
    name: string;
    /** 该 Agent 具备的能力列表 */
    capabilities: AgentCapability[];
    /** 运行时状态 */
    status: AgentRuntimeStatus;
    /** 元数据 */
    metadata?: Record<string, unknown>;
    /** 最后心跳时间戳 */
    lastHeartbeatAtMs: number;
    /** 注册时间戳 */
    registeredAtMs: number;
    /** 当前正在执行的任务数 */
    activeTaskCount: number;
}

/** 调度匹配结果 */
export interface DispatchMatch {
    agentId: string;
    agentName: string;
    capabilityId: string;
    matchType: "exact" | "rule" | "fallback";
    confidence: number; // 0-1
}

/** 调度请求 */
export interface DispatchRequest {
    /** 任务类型/目标方法 */
    taskType: string;
    /** 任务标签，用于精确匹配 */
    tags?: string[];
    /** 任务需要的能力分类 */
    category?: string;
    /** 优先级 */
    priority?: number;
}
