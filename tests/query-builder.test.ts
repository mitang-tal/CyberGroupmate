/**
 * tests/query-builder.test.ts — 类型安全查询构建器测试
 *
 * 覆盖：
 * - COLUMN_WHITELIST 校验（合法/非法列名）
 * - SafeUpdateBuilder SQL 生成 + 参数顺序
 * - SafeSelectBuilder WHERE / IN 构建
 * - 边界条件（空 SET、空 WHERE、空 IN）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    SafeUpdateBuilder,
    SafeSelectBuilder,
    COLUMN_WHITELIST,
} from "../src/memory-v2/query-builder.js";

// ─── COLUMN_WHITELIST ───

describe("COLUMN_WHITELIST", () => {
    it("包含所有核心表", () => {
        const tables = Object.keys(COLUMN_WHITELIST);
        assert.ok(tables.includes("topics"));
        assert.ok(tables.includes("core_facts"));
        assert.ok(tables.includes("person_identities"));
        assert.ok(tables.includes("person_group_profiles"));
        assert.ok(tables.includes("group_models"));
        assert.ok(tables.includes("interactions"));
        assert.ok(tables.includes("message_log"));
    });

    it("每张表至少有 3 个列", () => {
        for (const [table, cols] of Object.entries(COLUMN_WHITELIST)) {
            assert.ok(cols.length >= 3, `表 ${table} 列数 ${cols.length} < 3`);
        }
    });
});

// ─── SafeUpdateBuilder ───

describe("SafeUpdateBuilder", () => {
    it("生成正确的 UPDATE SQL + 参数", () => {
        const { sql, params } = new SafeUpdateBuilder("topics")
            .set("label", "新标签")
            .set("summary", "新摘要")
            .set("updated_at", "2026-01-01")
            .where("id", "topic_123")
            .build();

        assert.equal(sql, "UPDATE topics SET label = ?, summary = ?, updated_at = ? WHERE id = ?");
        assert.deepEqual(params, ["新标签", "新摘要", "2026-01-01", "topic_123"]);
    });

    it("多个 WHERE 条件用 AND 连接", () => {
        const { sql, params } = new SafeUpdateBuilder("person_group_profiles")
            .set("dunbar_tier", 2)
            .where("user_id", "u1")
            .where("chat_id", "c1")
            .build();

        assert.equal(sql, "UPDATE person_group_profiles SET dunbar_tier = ? WHERE user_id = ? AND chat_id = ?");
        assert.deepEqual(params, [2, "u1", "c1"]);
    });

    it("hasSets 反映是否有 SET", () => {
        const builder = new SafeUpdateBuilder("topics");
        assert.equal(builder.hasSets, false);
        builder.set("label", "test");
        assert.equal(builder.hasSets, true);
    });

    it("非法列名抛出错误", () => {
        assert.throws(() => {
            new SafeUpdateBuilder("topics")
                .set("hacked_column" as any, "value");
        }, /非法列名.*hacked_column/);
    });

    it("SQL 注入列名被拒绝", () => {
        assert.throws(() => {
            new SafeUpdateBuilder("topics")
                .set("label; DROP TABLE topics--" as any, "value");
        }, /非法列名/);
    });

    it("无 SET 子句时 build 抛错", () => {
        assert.throws(() => {
            new SafeUpdateBuilder("topics")
                .where("id", "x")
                .build();
        }, /无 SET 子句/);
    });

    it("无 WHERE 子句时 build 抛错", () => {
        assert.throws(() => {
            new SafeUpdateBuilder("topics")
                .set("label", "x")
                .build();
        }, /无 WHERE 子句/);
    });

    it("支持所有表的合法列", () => {
        // topics
        const t = new SafeUpdateBuilder("topics")
            .set("label", "test").set("summary", "x")
            .set("chat_id", "c").set("sentiment", "neutral")
            .where("id", "1").build();
        assert.ok(t.sql.includes("UPDATE topics SET"));

        // person_identities
        const pi = new SafeUpdateBuilder("person_identities")
            .set("display_name", "alice")
            .where("user_id", "1").build();
        assert.ok(pi.sql.includes("UPDATE person_identities SET"));

        // group_models
        const gm = new SafeUpdateBuilder("group_models")
            .set("chat_title", "test")
            .where("chat_id", "1").build();
        assert.ok(gm.sql.includes("UPDATE group_models SET"));
    });
});

// ─── SafeSelectBuilder ───

describe("SafeSelectBuilder", () => {
    it("生成正确的 SELECT WHERE SQL", () => {
        const { sql, params } = new SafeSelectBuilder("topics")
            .from("SELECT * FROM topics")
            .where("embedding IS NOT NULL")
            .whereEq("chat_id", "chat_123")
            .build();

        assert.equal(sql, "SELECT * FROM topics WHERE embedding IS NOT NULL AND chat_id = ?");
        assert.deepEqual(params, ["chat_123"]);
    });

    it("whereIn 生成 IN 子句", () => {
        const { sql, params } = new SafeSelectBuilder("core_facts")
            .from("SELECT * FROM core_facts WHERE embedding IS NOT NULL")
            .whereIn("category", ["preference", "biographical"])
            .build();

        assert.ok(sql.includes("AND category IN (?, ?)"));
        assert.deepEqual(params, ["preference", "biographical"]);
    });

    it("空 whereIn 不添加条件", () => {
        const { sql, params } = new SafeSelectBuilder("core_facts")
            .from("SELECT * FROM core_facts")
            .whereIn("category", [])
            .build();

        assert.equal(sql, "SELECT * FROM core_facts");
        assert.deepEqual(params, []);
    });

    it("无条件时返回原始 SQL", () => {
        const { sql, params } = new SafeSelectBuilder("topics")
            .from("SELECT * FROM topics")
            .build();

        assert.equal(sql, "SELECT * FROM topics");
        assert.deepEqual(params, []);
    });

    it("非法列名在 whereEq 中抛错", () => {
        assert.throws(() => {
            new SafeSelectBuilder("topics")
                .from("SELECT * FROM topics")
                .whereEq("hacked" as any, "x");
        }, /非法列名/);
    });

    it("主键列不经白名单校验", () => {
        // id, user_id, chat_id 是 PK，不在白名单中但允许使用
        const { sql } = new SafeSelectBuilder("topics")
            .from("SELECT * FROM topics")
            .whereEq("id", "123")
            .build();
        assert.ok(sql.includes("id = ?"));
    });
});
