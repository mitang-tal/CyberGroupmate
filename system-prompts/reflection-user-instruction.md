## 任务

请根据以下数据，对群聊进行反思总结，输出结构化的 JSON 对象。

## 输入数据格式

你收到的数据由以下章节组成（用 `---` 分隔），部分章节可能缺失：

### 群组信息
```
- 群名: <群名>
- 当前 agent 角色: <角色>
- 活跃度: high|medium|low
- 热点话题: <话题1>, <话题2>, ...
- 上次反思: <ISO日期 或 "从未">
```

### 近期话题 (N 个)
```
1. **<话题标签>** (<日期>)
   摘要: <话题摘要>
   参与者: <userId1>, <userId2>, ...
   关键词: <kw1>, <kw2>, ...
   情感: positive|neutral|negative|mixed
   Agent 介入: 是 (N次) | 否
   消息数: <数字>
```

### 近期交互 (N 条)
```
- [<日期>] <type>: <摘要> (情感:<sentiment>, 重要度:<0-1>)
```
type 为: agent_replied | agent_mentioned | direct_message | reaction

### 参与者统计
```
- <userId>: <N> 条消息, <N> 个话题, <N> 天活跃
```

### 现有画像 (N 人)
```
- **<userId>** (Tier <1-4>): traits=[<t1>, <t2>], interests=[<i1>, <i2>], style="<风格>", relation="<关系>"
```

## 输出 JSON Schema

输出一个**严格的 JSON 对象**，不要包含 markdown 代码块或额外文本：

```json
{
  "personUpdates": [
    {
      "userId": "string (用户ID)",
      "traits": ["string (性格特点，可选)"],
      "interests": ["string (兴趣话题，可选)"],
      "communicationStyle": "string (说话风格，可选)",
      "relationToAgent": "string (与 agent 的关系，可选)",
      "dunbarTier": 1|2|3|4,
      "dunbarReason": "string (分层理由)"
    }
  ],
  "groupUpdates": {
    "agentRole": "string (agent 在群中的角色，可选)",
    "engagementLevel": "high|medium|low (可选)",
    "hotTopics": ["string (最近热点话题，可选)"],
    "recentFeedback": "string (群成员对 agent 的反馈，可选)"
  },
  "newFacts": [
    {
      "subject": "string (事实主体，通常是 userId)",
      "content": "string (事实内容)",
      "category": "preference|biographical|anecdote|relationship|skill|opinion"
    }
  ],
  "topicsSummary": [
    {
      "label": "string (话题标签)",
      "summary": "string (1-2句摘要)",
      "participants": ["userId"],
      "sentiment": "positive|neutral|negative|mixed"
    }
  ],
  "insights": "string (对未来行为的反思建议)"
}
```

## 输出原则

1. **personUpdates**：只包含有实质性变化的画像字段。如果某人的 traits 没有新发现，不要重复已有内容
2. **newFacts**：只提取值得长期记忆的具体信息（如"alice 下周去东京"），避免模糊概括
3. **anecdote**：特别注意标注有趣的轶事（category='anecdote'）——永不过期，是 agent "翻黑历史"的关键素材
4. **dunbarTier**：基于交互频率和深度综合判断，不要仅凭单次对话升降，需提供具体 dunbarReason
5. **topicsSummary**：每个话题摘要简洁（1-2句），sentiment 反映话题整体氛围
6. **insights**：提供具体、可操作的建议（如"alice 对旅行话题很感兴趣，下次可以主动聊"），不要泛泛而谈
7. **groupUpdates.engagementLevel**：基于消息频率和参与人数综合判断，hotTopics 取最近最活跃的 3-5 个
