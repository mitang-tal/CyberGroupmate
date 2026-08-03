import { SimulationEngine } from "../src/simulation/simulation-engine";

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

function main() {
    // Fake dependencies — 只 mock 用到的方法
    const fakeExtractor = {} as any;
    const fakeInjector = {
        getConstraintsForDispatch: (_: any) => ({
        constraints: { avoid: [], prefer: [] }, experiences: [] },
        ),
    } as any;

    const engine = new SimulationEngine(fakeExtractor, fakeInjector);

    // ─── 1. 初始状态 ───
    console.log("\n[1] 初始状态 totalSimulations=0");
    const m0 = engine.getHitMetrics();
    check("初始 totalSimulations=0", m0.totalSimulations === 0, String(m0.totalSimulations));

    // ─── 2. 跑第 1 次推演 ───
    console.log("\n[2] 跑 1 次推演");
    const r1 = engine.runSimulation({ triggerContext: "test-1" });
    check("返回 simulationId", !!r1.simulationId, r1.simulationId);
    const m1 = engine.getHitMetrics();
    check("totalSimulations=1", m1.totalSimulations === 1, String(m1.totalSimulations));

    // ─── 3. 跑第 2 次推演 ───
    console.log("\n[3] 跑第 2 次推演");
    engine.runSimulation({ triggerContext: "test-2" });
    const m2 = engine.getHitMetrics();
    check("totalSimulations=2", m2.totalSimulations === 2, String(m2.totalSimulations));

    // ─── 4. 报告 ───
    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
    if (fail > 0) process.exit(1);
}

main();