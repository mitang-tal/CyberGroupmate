# 场景编写指南 (Scene Authoring)

本文档说明如何为 CyberGroupmate 编写和注册新场景。

## 什么是场景

场景（Scene）控制 agent 在某一时刻可以执行的操作。每个场景提供一组 TypeScript 类型定义（`.d.ts`），agent 通过这些类型了解可用的 API。

场景系统类似于 AVG 游戏中进入不同房间 —— 进入不同场景，能施展的动作不同。

## 文件结构

```
src/scenes/
├── index.ts            # 场景注册表（在此注册新场景）
├── home.d.ts           # Home 场景类型定义 (L1)
├── telegram.d.ts       # Telegram 场景类型定义 (L1)
├── telegram.full.d.ts  # Telegram 完整类型 (L2, 可选)
└── memory.d.ts         # Memory 场景类型定义 (L1)
```

## 类型定义编写规范

### L1 精简类型（必须）

- **控制在 100-200 行以内**
- 只包含 agent 常用的方法和核心数据结构
- 每个 interface 和方法都有 JSDoc 注释
- 注释中包含使用示例（`@example`）
- 包含所有场景共用的类型声明：`scene`, `runtime`, `ctx`

### L2 完整类型（可选）

- 更详细的类型定义，包含进阶方法
- Agent 遇到 L1 类型不够用时通过 `scene.showFullTypes()` 请求

### 编写原则

1. **注释即文档**：Agent 读注释来理解用法，要写清楚
2. **类型即约束**：精确的参数和返回值类型帮助 agent 写出正确代码
3. **包含示例**：每个重要方法都要有 `@example`
4. **共用类型**：`scene`, `runtime`, `ctx` 在每个 `.d.ts` 中都要声明

## 场景定义格式

```javascript
interface SceneDefinition {
  name: string;         // 场景标识符
  description: string;  // 一句话描述
  typeDefs: string;     // L1 类型定义（.d.ts 内容）
  fullTypeDefs?: string; // L2 完整类型（可选）
  contextSetup?: string; // 进入场景时的额外说明
  prelude?: string;      // 进入场景时自动执行的代码
}
```

## 注册新场景

在 `src/scenes/index.ts` 中添加注册：

```javascript
// 1. 创建 src/scenes/my-scene.d.ts 类型定义文件
// 2. 在 registerBuiltinScenes 函数中添加：

sm.register({
  name: "my-scene",
  description: "一句话描述这个场景做什么",
  typeDefs: readTypeDefs("my-scene.d.ts"),
  fullTypeDefs: readTypeDefs("my-scene.full.d.ts"), // 可选
  contextSetup: "进入场景时 agent 看到的额外说明",
  prelude: "// 进入场景时自动执行的代码（可选）",
});
```

## 示例：添加 Discord 场景

1. 创建 `src/scenes/discord.d.ts`：

```javascript
declare const scene: { enter(name: string): void; /* ... */ };
declare const runtime: { /* ... */ };
declare const ctx: Record<string, any>;

interface DiscordClient {
  sendMessage(channelId: string, text: string): Promise<Message>;
  getMessages(channelId: string, limit?: number): Promise<Message[]>;
  // ...
}

declare const discord: DiscordClient;
```

2. 在 `src/scenes/index.ts` 注册
3. Agent 就可以通过 `scene.enter("discord")` 使用了

## 注意事项

- 新增场景**不需要修改框架代码**，只需添加 `.d.ts` 文件和注册调用
- Agent 未来可以通过 `scene.register()` 自己注册新场景
- 类型定义文件不会被 TypeScript 编译器使用，它们是以字符串形式读取并展示给 agent 的
