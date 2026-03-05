#!/usr/bin/env npx tsx
/**
 * tests/scripts/bootstrap-dryrun-db.ts — 创建 dry-run 验证用轻量数据库
 *
 * 用法：
 *   npx tsx tests/scripts/bootstrap-dryrun-db.ts [output-path]
 *
 * 默认输出到 workspace/test-memory.db
 * 创建一个预填充种子数据的 Memory V2 数据库，可直接用于：
 *   - CLI 手动验证: npx tsx src/cli.ts memory recall "京都"
 *   - dry-run 回放测试
 *   - 开发调试
 */

import { existsSync, unlinkSync } from "node:fs";
import { MemoryStoreV2 } from "../../src/memory-v2/index.js";
import { seedTestData } from "../helpers/test-db.js";

const outputPath = process.argv[2] ?? "workspace/test-memory.db";

// 清理旧文件
for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(outputPath + suffix)) unlinkSync(outputPath + suffix);
}

console.log(`🔧 创建 dry-run 测试数据库: ${outputPath}`);

const memory = new MemoryStoreV2(outputPath);
seedTestData(memory, "-100001");
memory.close();

console.log(`✅ 数据库创建完成！包含：`);
console.log(`   - 3 个话题（京都旅行/Python调试/新番推荐）`);
console.log(`   - 12 条消息日志`);
console.log(`   - 5 条核心事实`);
console.log(`   - 3 个用户身份（alice/bob/carol）`);
console.log(`   - 3 个群内画像`);
console.log(`   - 1 个群组画像`);
console.log();
console.log(`📖 验证命令：`);
console.log(`   npx tsx src/cli.ts memory recall "京都"`);
console.log(`   npx tsx src/cli.ts memory browse "谁推荐过动漫"`);
console.log(`   npx tsx src/cli.ts memory status`);
