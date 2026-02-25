/**
 * notification-center.test.ts — NotificationCenter 单元测试
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { NotificationCenter } from "../src/notification-center.js";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

function createTempPath(): string {
    return join(tmpdir(), `nc-test-${randomUUID()}`, "events.jsonl");
}

describe("NotificationCenter", () => {
    const tempPaths: string[] = [];

    function makeNC(): NotificationCenter {
        const p = createTempPath();
        tempPaths.push(p);
        return new NotificationCenter(p);
    }

    after(() => {
        // Cleanup temp files
        for (const p of tempPaths) {
            const dir = join(p, "..");
            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    describe("push", () => {
        it("should add _id and _ts to the event", () => {
            const nc = makeNC();
            const event = nc.push({ type: "test.event", data: "hello" });

            assert.ok(event._id, "_id should be set");
            assert.ok(event._ts, "_ts should be set");
            assert.equal(event.type, "test.event");
            assert.equal(event.data, "hello");
        });

        it("should generate monotonically increasing ULIDs", () => {
            const nc = makeNC();
            const e1 = nc.push({ type: "test.a" });
            const e2 = nc.push({ type: "test.b" });
            const e3 = nc.push({ type: "test.c" });

            assert.ok(e1._id < e2._id, "ULID should be monotonically increasing");
            assert.ok(e2._id < e3._id, "ULID should be monotonically increasing");
        });

        it("should increment pendingCount", () => {
            const nc = makeNC();
            assert.equal(nc.pendingCount, 0);
            nc.push({ type: "test.a" });
            assert.equal(nc.pendingCount, 1);
            nc.push({ type: "test.b" });
            assert.equal(nc.pendingCount, 2);
        });
    });

    describe("JSONL persistence", () => {
        it("should append events to the JSONL file", () => {
            const p = createTempPath();
            tempPaths.push(p);
            const nc = new NotificationCenter(p);

            nc.push({ type: "test.one", value: 1 });
            nc.push({ type: "test.two", value: 2 });

            const lines = readFileSync(p, "utf-8").trim().split("\n");
            assert.equal(lines.length, 2);

            const parsed1 = JSON.parse(lines[0]);
            assert.equal(parsed1.type, "test.one");
            assert.equal(parsed1.value, 1);
            assert.ok(parsed1._id);
            assert.ok(parsed1._ts);

            const parsed2 = JSON.parse(lines[1]);
            assert.equal(parsed2.type, "test.two");
            assert.equal(parsed2.value, 2);
        });
    });

    describe("drain", () => {
        it("should return immediately if events are in queue", async () => {
            const nc = makeNC();
            nc.push({ type: "test.a" });
            nc.push({ type: "test.b" });

            const events = await nc.drain(5000, 50);
            assert.equal(events.length, 2);
            assert.equal(events[0].type, "test.a");
            assert.equal(events[1].type, "test.b");
            assert.equal(nc.pendingCount, 0);
        });

        it("should respect maxBatch limit", async () => {
            const nc = makeNC();
            nc.push({ type: "test.1" });
            nc.push({ type: "test.2" });
            nc.push({ type: "test.3" });

            const events = await nc.drain(0, 2);
            assert.equal(events.length, 2);
            assert.equal(nc.pendingCount, 1);

            const remaining = await nc.drain(0, 10);
            assert.equal(remaining.length, 1);
            assert.equal(remaining[0].type, "test.3");
        });

        it("should wait for push and return immediately when event arrives", async () => {
            const nc = makeNC();
            const start = Date.now();

            // Start drain that waits up to 5 seconds
            const drainPromise = nc.drain(5000, 10);

            // Push after 50ms
            setTimeout(() => {
                nc.push({ type: "test.delayed" });
            }, 50);

            const events = await drainPromise;
            const elapsed = Date.now() - start;

            assert.equal(events.length, 1);
            assert.equal(events[0].type, "test.delayed");
            // Should complete much faster than the 5s timeout
            assert.ok(elapsed < 1000, `Should complete quickly, took ${elapsed}ms`);
        });

        it("should return empty array on timeout with no events", async () => {
            const nc = makeNC();
            const start = Date.now();

            const events = await nc.drain(100, 10);
            const elapsed = Date.now() - start;

            assert.equal(events.length, 0);
            assert.ok(elapsed >= 90, `Should wait ~100ms, took ${elapsed}ms`);
        });

        it("should return immediately with timeout=0 and no events", async () => {
            const nc = makeNC();
            const events = await nc.drain(0, 10);
            assert.equal(events.length, 0);
        });
    });
});
