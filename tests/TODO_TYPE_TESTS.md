
测试场景与明确断言（可手动或用脚本验证）

说明：以下每个场景都提供了可执行的 Node.js 伪代码与 SQL 验证语句，断言要求是确定性的（写入什么 type，读取就返回什么 type）。

准备：
- 使用独立的测试 memory.db（备份生产数据库）。
- 以 Node.js 方式加载 MemoryStoreV2（或启动服务），确保使用同一数据库文件。

测试工具提示（伪代码，Node）:
```js
// 假设 MemoryStoreV2 在 src/memory-v2/index.js 导出为 MemoryStoreV2
import { MemoryStoreV2 } from '../../src/memory-v2/index.js';
const mem = new MemoryStoreV2('path/to/test-memory.db');
const bindingId = 'test-binding';
function assert(cond, msg){ if(!cond) throw new Error(msg || 'Assertion failed'); }
```

场景 1：type 写入/读取一致性（observation）
- 操作：
  - mem.todoUpsert(bindingId, 't-observation', 'observation', '这是一个观察', null)
  - const got = mem.todoGet(bindingId, 't-observation')
- 断言（确定性）：
  - assert(got !== null, 'item must exist')
  - assert(got.type === 'observation', `expected 'observation', got ${got.type}`)
- SQL 验证：
  - SELECT type FROM todo_items WHERE chat_id = 'test-binding' AND key = 't-observation'; -- 应返回 'observation'

场景 1b：type 写入/读取一致性（log）
- 操作：
  - mem.todoUpsert(bindingId, 't-log', 'log', '这是日志记录', null)
  - const got = mem.todoGet(bindingId, 't-log')
- 断言：
  - assert(got.type === 'log')

原则：写入什么 type，读取必须返回什么 type（不允许模糊匹配）。

场景 2：缺少 type 写入应失败
- 测试 A（直接调用 memory.todoUpsert）：
  - 调用：
    try { mem.todoUpsert(bindingId, 't-missing-type', /* omit type */ undefined, '内容', null); fail } catch(e) { ok }
  - 断言：抛出包含 "type" 或 "missing required 'type'" 的错误信息
  - SQL 验证：SELECT COUNT(1) FROM todo_items WHERE chat_id='test-binding' AND key='t-missing-type'; -- 应为 0

- 测试 B（通过 host-call 接口模拟调用 todo.upsert，options 不含 type）：
  - 调用应返回异常（host 层已校验 options.type 并抛错）
  - SQL 验证同上，数据库中不应创建记录

注意：不允许自动降级为 observation/log，也不应写入默认类型。

场景 3：migration 幂等性测试
- 前置：准备一个“旧格式”的 todo_items 条目（没有 type 或 type=NULL / 'observation'）。可以用 sqlite3 CLI 插入：
  - INSERT INTO todo_items (chat_id, key, content, due_at, created_at, updated_at) VALUES ('old-binding','old1','喜欢短消息', NULL, datetime('now'), datetime('now'));
  - INSERT INTO todo_items (chat_id, key, content, created_at, updated_at) VALUES ('old-binding','old2','以后发送 Telegram 不要...', datetime('now'), datetime('now'));

- 第一次启动 MemoryStoreV2（或运行迁移逻辑）：
  - mem = new MemoryStoreV2('test-memory.db')  // 会执行迁移并写 kv_store('__migration__','todo_type_v1') = '1'
  - 验证：
    - SELECT value FROM kv_store WHERE chat_id='__migration__' AND key='todo_type_v1'; -- 应返回 '1'
    - 检查分类结果：SELECT key,type FROM todo_items WHERE chat_id='old-binding'; -- old1 应为 'preference'（匹配“喜欢”），old2 应为 'policy' 或其它按规则分类

- 第二次启动（在同一 DB 上重新 new MemoryStoreV2）：
  - mem2 = new MemoryStoreV2('test-memory.db') // 迁移应被跳过
  - 验证：
    - SELECT value FROM kv_store ... 应仍为 '1'
    - 确认 any 手动修改过的类型不被覆盖：
      -- 先人为修改 one record： UPDATE todo_items SET type='policy' WHERE key='old1' AND chat_id='old-binding';
      -- 重启 mem2
      -- SELECT type FROM todo_items WHERE key='old1' AND chat_id='old-binding'; -- 应仍为 'policy'

- 第三次启动同理，结果应一致。该测试断言迁移为幂等且受 kv_store 标记控制。

场景 4：archived_at 行为测试
- 操作：
  - mem.todoUpsert(bindingId, 'to-archive', 'task', '待完成测试', null)
  - mem.todoRemove(bindingId, 'to-archive')
- 断言：
  - SQL 验证：SELECT archived_at FROM todo_items WHERE chat_id='test-binding' AND key='to-archive'; -- archived_at IS NOT NULL
  - 默认查询不可见：调用 mem.todoList(bindingId) 返回数组中不应包含 key === 'to-archive'
  - 包含归档查询：调用 mem.todoList(bindingId, { includeExpired: false, includeArchived: true }) 或直接 SQL SELECT * WHERE archived_at IS NOT NULL 应能返回该条目，且 type/content/key 与写入时一致

当前已有测试覆盖哪些
- 原始文件 tests/TODO_TYPE_TESTS.md 提供了基础场景说明（偏好/policy/dispatch/observation），但断言不够确定性。已将其扩充为明确的断言和 SQL 验证步骤。

缺少哪些（已补充）
- 缺少确定性断言的写入/读取一致性（已补充 observation/log 的明确测试）
- 缺少缺少 type 写入失败的验证（添加了直接 todoUpsert 调用和 host-call 场景的断言）
- 缺少迁移幂等性测试的具体步骤与 SQL 断言（已补充）
- 缺少 archived_at 的行为断言与 SQL 验证（已补充）

如何把这些用脚本自动化（建议，但非强制）
- 可写一个小 Node.js 脚本 tests/run-todo-type-tests.js，按上面的伪代码逐步执行并在每一步做 assert。该脚本只需调用 MemoryStoreV2（无需改动核心架构）。

结论：
- 我已经把 tests/TODO_TYPE_TESTS.md 更新为包含明确、确定性的断言与可执行 SQL 验证步骤，覆盖你要求的 4 类测试场景。
- 不需要修改核心架构或新增功能；如果需要，我可以把伪代码转成可执行的 Node 测试脚本，但这会新建测试脚本文件（非必要）。

