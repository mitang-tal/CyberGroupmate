/**
 * docs.ts — Agent 文档读取模块
 *
 * 让 Agent 在 sandbox 中可以通过 docs.read("topic") 读取参考文档。
 * 避免 Agent 浪费 token 搜索互联网找用法。
 *
 * 在整体架构中的位置：
 * - Bootstrap 时注入到 sandbox 的 ctx.docs 上
 * - 文档存放在 docs/ 目录下
 * - Agent 可以通过 docs.list() 查看可用文档
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";

/** 文档目录 */
const DOCS_DIR = "docs";

/** 可用文档的索引 */
interface DocIndex {
    /** 文档 slug（如 "mtcute"） */
    slug: string;
    /** 文档标题 */
    title: string;
    /** 文件路径 */
    path: string;
}

/**
 * 列出所有可用的参考文档
 */
export function listDocs(): DocIndex[] {
    if (!existsSync(DOCS_DIR)) return [];

    return readdirSync(DOCS_DIR)
        .filter((f) => f.endsWith(".md") && !f.startsWith("CHANGELOG"))
        .map((f) => {
            const path = join(DOCS_DIR, f);
            const slug = basename(f, extname(f));

            // 提取第一行 # 标题
            const content = readFileSync(path, "utf-8");
            const titleMatch = content.match(/^#\s+(.+)$/m);
            const title = titleMatch ? titleMatch[1] : slug;

            return { slug, title, path };
        });
}

/**
 * 读取指定文档
 *
 * @param slug - 文档 slug（如 "mtcute-guide"、"scene-authoring"）
 * @returns 文档内容或未找到提示
 */
export function readDoc(slug: string): string {
    // 尝试几种可能的文件名
    const candidates = [
        join(DOCS_DIR, `${slug}.md`),
        join(DOCS_DIR, `${slug}-guide.md`),
        join(DOCS_DIR, `${slug}-reference.md`),
    ];

    for (const path of candidates) {
        if (existsSync(path)) {
            return readFileSync(path, "utf-8");
        }
    }

    // 列出可用文档帮助 agent 找到正确的文档
    const available = listDocs();
    if (available.length === 0) {
        return `文档 "${slug}" 不存在，且没有可用的文档。`;
    }

    const list = available
        .map((d) => `  - ${d.slug}: ${d.title}`)
        .join("\n");
    return `文档 "${slug}" 不存在。可用文档：\n${list}`;
}

/**
 * 生成 docs 对象的代码字符串（注入到 sandbox）
 *
 * @example
 * ```ts
 * // 在 sandbox 中可用：
 * const content = docs.read("mtcute");
 * const list = docs.list();
 * ```
 */
export function getDocsInjectionCode(): string {
    return `
// docs — 参考文档读取
// 用法：docs.list() 查看可用文档，docs.read("slug") 读取文档
const docs = {
  list: () => ${JSON.stringify(listDocs())},
  read: (slug) => {
    const fs = require("node:fs");
    const path = require("node:path");
    const DOCS_DIR = "docs";
    const candidates = [
      path.join(DOCS_DIR, slug + ".md"),
      path.join(DOCS_DIR, slug + "-guide.md"),
      path.join(DOCS_DIR, slug + "-reference.md"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, "utf-8");
      }
    }
    const files = fs.readdirSync(DOCS_DIR)
      .filter(f => f.endsWith(".md") && !f.startsWith("CHANGELOG"))
      .map(f => f.replace(".md", ""));
    return "文档 \\"" + slug + "\\" 不存在。可用文档: " + files.join(", ");
  }
};
`;
}
