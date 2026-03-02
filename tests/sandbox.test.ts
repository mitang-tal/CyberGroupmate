/**
 * sandbox.test.ts — Sandbox + Worker 集成测试
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { Sandbox } from "../src/sandbox/sandbox.js";

describe("Sandbox", () => {
    const sandboxes: Sandbox[] = [];

    async function makeSandbox(): Promise<Sandbox> {
        const sb = new Sandbox();
        sandboxes.push(sb);
        await sb.start();
        return sb;
    }

    after(async () => {
        for (const sb of sandboxes) {
            await sb.stop().catch(() => { });
        }
    });

    it("should start and report isAlive", async () => {
        const sb = await makeSandbox();
        assert.equal(sb.isAlive(), true);
    });

    it("should execute simple code and capture console.log", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute('console.log("hello world")');
        assert.equal(result.error, false);
        assert.equal(result.output, "hello world");
    });

    it("should capture multiple console.log calls", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute(
            'console.log("line1"); console.log("line2"); console.log("line3")'
        );
        assert.equal(result.error, false);
        assert.equal(result.output, "line1\nline2\nline3");
    });

    it("should capture console.warn and console.error", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute(
            'console.warn("warning"); console.error("error")'
        );
        assert.equal(result.error, false);
        assert.equal(result.output, "warning\nerror");
    });

    it("should handle objects in console.log", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute('console.log({ a: 1, b: "two" })');
        assert.equal(result.error, false);
        const parsed = JSON.parse(result.output);
        assert.deepEqual(parsed, { a: 1, b: "two" });
    });

    it("should return error for invalid code", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute("throw new Error('test error')");
        assert.equal(result.error, true);
        assert.ok(result.output.includes("test error"));
    });

    it("should return error with stack trace for runtime errors", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute("undeclaredVariable.foo()");
        assert.equal(result.error, true);
        assert.ok(
            result.output.includes("ReferenceError") ||
            result.output.includes("not defined")
        );
    });

    it("should maintain ctx across executions (persistent namespace)", async () => {
        const sb = await makeSandbox();

        // First execution: set ctx.myValue
        const r1 = await sb.execute('ctx.myValue = 42; console.log("set")');
        assert.equal(r1.error, false);
        assert.equal(r1.output, "set");

        // Second execution: read ctx.myValue
        const r2 = await sb.execute("console.log(ctx.myValue)");
        assert.equal(r2.error, false);
        assert.equal(r2.output, "42");
    });

    it("should support top-level await", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute(`
      const result = await Promise.resolve("async hello");
      console.log(result);
    `);
        assert.equal(result.error, false);
        assert.equal(result.output, "async hello");
    });

    it("should support runtime.notify", async () => {
        const sb = await makeSandbox();

        const notifyPromise = new Promise<Record<string, unknown>>((resolve) => {
            sb.once("notify", resolve);
        });

        await sb.execute(
            'runtime.notify({ type: "test.event", data: "hello" })'
        );

        const event = await notifyPromise;
        assert.equal(event.type, "test.event");
        assert.equal(event.data, "hello");
    });

    it("should stop cleanly", async () => {
        const sb = new Sandbox();
        await sb.start();
        assert.equal(sb.isAlive(), true);

        await sb.stop();
        assert.equal(sb.isAlive(), false);
    });

    it("should handle execution timeout", async () => {
        const sb = await makeSandbox();
        await assert.rejects(
            () =>
                sb.execute(
                    "await new Promise(resolve => setTimeout(resolve, 10000))",
                    500
                ),
            { message: /timed out/ }
        );
    });
});
