import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    formatTsForPrompt,
    normalizeProgrammaticTimestamps,
    sanitizePromptTimestamps,
    setGlobalTimezone,
} from "../src/core/timezone.js";

describe("timezone prompt formatting", () => {
    it("formats narrative prompt timestamps in the configured timezone", () => {
        setGlobalTimezone("Asia/Shanghai");
        const reference = "2026-05-13T12:00:00.000Z";

        assert.equal(formatTsForPrompt("2026-05-13T03:00:00.000Z", reference), "11:00");
        assert.equal(formatTsForPrompt("2026-05-12T03:00:00.000Z", reference), "5月12日 11:00");
        assert.equal(formatTsForPrompt("2025-05-12T03:00:00.000Z", reference), "2025年5月12日 11:00");
    });

    it("keeps programmatic time fields as epoch milliseconds", () => {
        setGlobalTimezone("Asia/Shanghai");

        assert.equal(
            sanitizePromptTimestamps('createdAt: "2026-05-13T03:00:00.000Z"; prose 2026-05-12T03:00:00.000Z'),
            "createdAt: 1778641200000; prose 5月12日 11:00",
        );
        assert.deepEqual(
            normalizeProgrammaticTimestamps({
                createdAt: "2026-05-13T03:00:00.000Z",
                nested: { timestamp: "2026-05-12T03:00:00.000Z" },
            }),
            {
                createdAt: 1778641200000,
                nested: { timestamp: 1778554800000 },
            },
        );
    });
});
