/**
 * Audit Fix P0-2 — CostGuard 接入 LLM usage 回调 独立验收脚本
 *
 * 验证内容（复刻 src/main.ts 中的真实订阅链路）：
 * 1. 真实 llmEvents.emit("llm:response") → CostGuard 计数（token / 调用次数）
 * 2. 免费模型（无 pricing，costCents 缺省 0）同样计数 token 与调用次数
 * 3. 付费模型显式传 costCents 时费用计入 dailyCostCents
 * 4. error 响应不计数（与 event-bridge 语义一致）
 * 5. usage 缺失不计数；usage=undefined 防御性安全
 * 6. 24h token / 调用次数上限拦截仍正常
 */
import { llmEvents } from "../src/core/llm.js";
import { CostGuard } from "../src/validation/cost-guard.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
    if (cond) {
        pass++;
        console.log(`  ✅ ${name}`);
    } else {
        fail++;
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

function emitResponse(payload: {
    callId: string;
    error?: string;
    usage?: { promptTokens?: number; completionTokens?: number; cachedTokens?: number; cacheCreationTokens?: number };
}) {
    llmEvents.emit("llm:response", {
        callId: payload.callId,
        caller: "test",
        contentPreview: "",
        contentLength: 0,
        usage: payload.usage,
        durationMs: 100,
        error: payload.error,
        timestamp: new Date().toISOString(),
    } as any);
}

function main() {
    // 复刻 main.ts 的订阅链路
    const cg = new CostGuard();
    const onResponse = (data: any) => {
        if (data.error || !data.usage) return;
        cg.recordLLMUsage(data.usage);
    };
    llmEvents.on("llm:response", onResponse);

    // ─── 1. 真实 llm:response 事件被 CostGuard 计数（免费模型，costCents 缺省 0） ───
    console.log("\n[1] llm:response 事件计数（免费模型）");
    emitResponse({
        callId: "call-1",
        usage: { promptTokens: 1000, completionTokens: 500, cachedTokens: 0, cacheCreationTokens: 0 },
    });
    let u = cg.getUsage();
    check("1 次调用后 tokenUsed24h = 1500", u.tokenUsed24h === 1500, String(u.tokenUsed24h));
    check("1 次调用后 apiCalls24h = 1", u.apiCalls24h === 1, String(u.apiCalls24h));
    check("免费模型 cost 仍为 0", u.dailyCostCents === 0, String(u.dailyCostCents));

    // ─── 2. cached / cacheCreation token 也计入 ───
    console.log("\n[2] cached / cacheCreation token 计入");
    emitResponse({
        callId: "call-2",
        usage: { promptTokens: 500, completionTokens: 200, cachedTokens: 100, cacheCreationTokens: 50 },
    });
    u = cg.getUsage();
    check("第 2 次调用后 tokenUsed24h = 2350", u.tokenUsed24h === 2350, String(u.tokenUsed24h));
    check("apiCalls24h = 2", u.apiCalls24h === 2, String(u.apiCalls24h));

    // ─── 3. 付费模型显式 costCents 计入 dailyCostCents ───
    console.log("\n[3] 付费模型 cost 计入");
    cg.recordLLMUsage(
        { promptTokens: 100, completionTokens: 50, cachedTokens: 0, cacheCreationTokens: 0 },
        12.5,
    );
    u = cg.getUsage();
    check("tokenUsed24h = 2500", u.tokenUsed24h === 2500, String(u.tokenUsed24h));
    check("apiCalls24h = 3", u.apiCalls24h === 3, String(u.apiCalls24h));
    check("dailyCostCents = 12.5", u.dailyCostCents === 12.5, String(u.dailyCostCents));

    // ─── 4. error 响应不计数 ───
    console.log("\n[4] error 响应不计数");
    emitResponse({ callId: "call-err", error: "rate_limited", usage: { promptTokens: 999, completionTokens: 0 } });
    u = cg.getUsage();
    check("error 后 tokenUsed24h 不变", u.tokenUsed24h === 2500, String(u.tokenUsed24h));
    check("error 后 apiCalls24h 不变", u.apiCalls24h === 3, String(u.apiCalls24h));

    // ─── 5. usage 缺失 / undefined 防御 ───
    console.log("\n[5] usage 缺失 / undefined 防御");
    emitResponse({ callId: "call-no-usage" });
    u = cg.getUsage();
    check("无 usage 事件后 apiCalls24h 不变", u.apiCalls24h === 3, String(u.apiCalls24h));
    const guard2 = new CostGuard();
    guard2.recordLLMUsage(undefined as any);
    check("recordLLMUsage(undefined) 不抛错不计数", guard2.getUsage().apiCalls24h === 0, String(guard2.getUsage().apiCalls24h));
    guard2.destroy();

    // ─── 6. 预算上限拦截仍正常 ───
    console.log("\n[6] 预算上限拦截");
    const smallGuard = new CostGuard({ maxTokenBudget24h: 3000, maxApiCalls24h: 1 });
    const tooBig = smallGuard.checkExecution(5000);
    check("单次超限拦截", tooBig.allowed === false, tooBig.reason);
    smallGuard.recordLLMUsage({ promptTokens: 2000, completionTokens: 1000, cachedTokens: 0, cacheCreationTokens: 0 });
    const over24h = smallGuard.checkExecution(500);
    check("24h 预算耗尽拦截", over24h.allowed === false, over24h.reason);
    const overApi = smallGuard.checkExecution(10);
    check("调用次数上限拦截（未满但预检+1 超限）", overApi.allowed === false, overApi.reason);
    smallGuard.destroy();

    llmEvents.off("llm:response", onResponse);
    cg.destroy();

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

main();