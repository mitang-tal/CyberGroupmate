import type { HarnessManager } from "../../harness/manager.js";

export function createBackgroundApi(getHarnessManager: () => HarnessManager | null) {
    return {
        enqueue: async (content: string, source?: string) => {
            const hm = getHarnessManager();
            if (!hm) return { queued: false, reason: "Background Agent not configured" };
            const contentStr = typeof content === "string" ? content : JSON.stringify(content);
            hm.enqueue({ content: contentStr, source: source ?? "meta" });
            return { queued: true, queueLength: hm.queueLength };
        },
        getStatus: async () => {
            const hm = getHarnessManager();
            if (!hm) return { enabled: false };
            return { enabled: true, ...hm.getStatus() };
        },
    };
}
