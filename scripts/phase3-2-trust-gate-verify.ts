/**
 * Audit Fix Phase 3.2 — Dispatcher Trust Gate 独立验收脚本
 *
 * 验证内容：
 * 1. exact match：trusted + untrusted 注册相同 capability，dispatch 只命中 trusted
 * 2. rule match：category 匹配路径排除 untrusted
 * 3. fallback match：无 tags/category 时排除 untrusted
 * 4. listCandidates：不包含 untrusted agent
 * 5. 极端场景：唯一可用 agent 是 untrusted → dispatch 返回 undefined（不降级给 untrusted）
 * 6. 未注入 reputationProvider：保持原行为（不误伤无信任系统的环境）
 */
import { CapabilityRegistry } from "../src/capability-registry/capability-registry.js";
import { CapabilityDispatcher } from "../src/capability-registry/capability-dispatcher.js";

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

function registerMediaAgent(registry: CapabilityRegistry, name: string) {
    return registry.register({
        name,
        capabilities: [
            { name: "media_send", category: "media", tags: ["send", "media"], description: "媒体发送" },
        ],
    });
}

function main() {
    // ─── 场景 A：trusted + untrusted 同时在线，相同 capability ───
    console.log("\n[A] trusted + untrusted 相同 capability");
    {
        const registry = new CapabilityRegistry();
        const trusted = registerMediaAgent(registry, "Trusted Agent");
        const untrusted = registerMediaAgent(registry, "Untrusted Agent");

        const dispatcher = new CapabilityDispatcher(registry);
        dispatcher.setReputationProvider((agentId) => {
            if (agentId === untrusted.agentId) return { trustScore: 0.1, trustState: "untrusted", reliability: 0.2 };
            return { trustScore: 0.9, trustState: "trusted", reliability: 0.9 };
        });

        // 1. exact match（tag 完全匹配）
        const exact = dispatcher.dispatch({ taskType: "media_send", tags: ["send", "media"] });
        check("exact match 命中 trusted", exact?.agentId === trusted.agentId, JSON.stringify(exact));

        // 2. rule match（category 匹配）
        const rule = dispatcher.dispatch({ taskType: "media_send", category: "media" });
        check("rule match 命中 trusted", rule?.agentId === trusted.agentId, JSON.stringify(rule));

        // 3. fallback match（无 tags / category）
        const fallback = dispatcher.dispatch({ taskType: "media_send" });
        check("fallback match 命中 trusted", fallback?.agentId === trusted.agentId, JSON.stringify(fallback));

        // 4. listCandidates 不含 untrusted
        const candidates = dispatcher.listCandidates({ taskType: "media_send", tags: ["send", "media"] });
        check(
            "listCandidates 不含 untrusted",
            candidates.length > 0 && candidates.every((c) => c.agentId !== untrusted.agentId),
            JSON.stringify(candidates),
        );
    }

    // ─── 场景 B：唯一可用 agent 是 untrusted → 拒绝派发 ───
    console.log("\n[B] 唯一候选 untrusted → 拒绝派发");
    {
        const registry = new CapabilityRegistry();
        registerMediaAgent(registry, "Untrusted Only");

        const dispatcher = new CapabilityDispatcher(registry);
        dispatcher.setReputationProvider(() => ({ trustScore: 0.1, trustState: "untrusted", reliability: 0.2 }));

        const exact = dispatcher.dispatch({ taskType: "media_send", tags: ["send", "media"] });
        check("唯一 untrusted 时 exact 返回 undefined", exact === undefined, JSON.stringify(exact));
        const rule = dispatcher.dispatch({ taskType: "media_send", category: "media" });
        check("唯一 untrusted 时 rule 返回 undefined", rule === undefined, JSON.stringify(rule));
        const fallback = dispatcher.dispatch({ taskType: "media_send" });
        check("唯一 untrusted 时 fallback 返回 undefined", fallback === undefined, JSON.stringify(fallback));
        check(
            "唯一 untrusted 时 listCandidates 为空",
            dispatcher.listCandidates({ taskType: "media_send" }).length === 0,
        );
    }

    // ─── 场景 C：未注入 reputationProvider → 保持原行为 ───
    console.log("\n[C] 无 reputationProvider 保持原行为");
    {
        const registry = new CapabilityRegistry();
        const plain = registerMediaAgent(registry, "Plain Agent");

        const dispatcher = new CapabilityDispatcher(registry);
        const match = dispatcher.dispatch({ taskType: "media_send", tags: ["send", "media"] });
        check("无 provider 时仍可派发", match?.agentId === plain.agentId, JSON.stringify(match));
    }

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

main();
