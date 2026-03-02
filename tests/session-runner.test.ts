/**
 * session-runner.test.ts — CodeAct Session Runner 单元测试
 *
 * 主要测试 response 解析逻辑。完整的 session 运行需要集成测试。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseResponse } from "../src/sandbox/session-runner.js";

describe("parseResponse", () => {
    it("should parse thinking only (no code blocks)", () => {
        const response = "I'm done processing the request. Everything looks good.";
        const { thinking, codeBlocks } = parseResponse(response);

        assert.equal(codeBlocks.length, 0);
        assert.ok(thinking.includes("done processing"));
    });

    it("should parse a single typescript code block", () => {
        const response = `Let me send a message.

\`\`\`typescript
await ctx.tg.sendText(-100123, "Hello!");
\`\`\`

That should work.`;

        const { thinking, codeBlocks } = parseResponse(response);

        assert.equal(codeBlocks.length, 1);
        assert.equal(codeBlocks[0], 'await ctx.tg.sendText(-100123, "Hello!");');
        assert.ok(thinking.includes("Let me send a message"));
        assert.ok(thinking.includes("That should work"));
    });

    it("should parse ts shorthand code block", () => {
        const response = `\`\`\`ts
console.log("hello")
\`\`\``;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
        assert.equal(codeBlocks[0], 'console.log("hello")');
    });

    it("should parse js code block", () => {
        const response = `\`\`\`js
const x = 42;
\`\`\``;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
    });

    it("should parse javascript code block", () => {
        const response = `\`\`\`javascript
const x = 42;
\`\`\``;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
    });

    it("should parse multiple code blocks", () => {
        const response = `First, let me get messages.

\`\`\`typescript
const msgs = await ctx.tg.getMessages(-100123, { limit: 10 });
console.log(msgs.map(m => m.text));
\`\`\`

Now let me reply.

\`\`\`ts
await ctx.tg.sendText(-100123, "Got it!");
\`\`\`

Done.`;

        const { thinking, codeBlocks } = parseResponse(response);

        assert.equal(codeBlocks.length, 2);
        assert.ok(codeBlocks[0].includes("getMessages"));
        assert.ok(codeBlocks[1].includes("sendText"));
        assert.ok(thinking.includes("First"));
        assert.ok(thinking.includes("Done"));
    });

    it("should ignore non-ts/js code blocks", () => {
        const response = `Here's a Python example:

\`\`\`python
print("hello")
\`\`\`

And here's the actual code:

\`\`\`typescript
console.log("hello")
\`\`\``;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
        assert.ok(codeBlocks[0].includes("console.log"));
    });

    it("should handle multiline code blocks", () => {
        const response = `\`\`\`typescript
scene.enter("telegram");

const msgs = await ctx.tg.getMessages(-100123, { limit: 5 });
for (const msg of msgs) {
  console.log(\`\${msg.sender.firstName}: \${msg.text}\`);
}
\`\`\``;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
        assert.ok(codeBlocks[0].includes("scene.enter"));
        assert.ok(codeBlocks[0].includes("for (const msg"));
    });
});
