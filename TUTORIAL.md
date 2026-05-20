# 叙事Agent 世界书作者教程

本文档面向为 narrative-agent 插件编写世界书条目的作者，涵盖条目分类机制、注入策略、前缀体系、工具定义以及常见注意事项。

***

## 1. 快速开始

世界书条目影响插件行为的两个层面：

1. **叙事注入**：条目内容被注入到规划/写作 Agent 的 prompt 中，影响 LLM 的叙事决策
2. **工具定义**：`[TOOL:name]` 前缀的条目在 Pipeline 中注册为自定义工具，trigger为`plan`的可由规划 Agent 调用，trigger为`post_pipeline`的默认在pipeline尾部调用，具体规则见[4.2 Trigger：决定执行时机](#42-trigger决定执行时机)

一个条目的"身份"由两个因素决定：

- **在哪个 UI 位置**：决定了注入到 Agent 的 system 还是 user message
- **如何激活**：决定了是始终注入还是仅在关键词匹配时注入

***

## 2. 条目分类与注入策略

### 2.1 UI 位置 注入目标

在 SillyTavern 世界书条目的编辑界面中，有两个关键设置决定了条目的注入目标：

| UI 选择                  | 对应 position | 对应 role | 注入到 Agent 的哪个 message                     |
| ---------------------- | ----------- | ------- | ----------------------------------------- |
| **@D(system)**         | 4           | 0       | 规划 Agent **system** + 写作 Agent **system** |
| **Char(before\_char)** | 0           | 任意      | 规划 Agent **user** + 写作 Agent **user**     |

**设计原则**：

- system 位置(@D)适合永久性的世界规则、设定、角色定义——这些内容在跨轮对话中不变，system message 可以命中 API prefix cache
- user 位置(Char)适合叙事性设定、场景描述——这些内容每轮可能变化(比如随着故事进展新的地点、NPC 被引入)，放在 user message 中不破坏 system 的缓存稳定性

### 2.2 激活策略

| 策略        | 世界书设置            | 行为                                  |
| --------- | ---------------- | ----------------------------------- |
| **永久激活**  | constant = true  | 始终注入。适合核心世界观规则、主角设定、永久生效的系统规则       |
| **关键词激活** | constant = false | 仅在条目关键词(key)匹配最近聊天文本时注入。适合场景描述、临时状态 |

**注意**：向量化激活策略(vectorized)当前不被 narrative-agent 使用，仅支持永久和关键词两种策略。

### 2.3 格式条目自动过滤

以下 comment 前缀的条目被视为"格式条目"(用于定义系统行为而非叙事注入)，会被自动从 Agent 上下文中过滤掉：

- `[TOOL:*]` — 工具定义
- `[UI]` — UI 模板
- `[initvar]` — MVU 变量初始化
- `[mvu_update]` — MVU 变量更新规则

这意味着一个 `[TOOL:roll_dice]` 条目即使设置了 `constant=true`，其 JSON 定义内容也不会被注入到 Agent 的 prompt 中；只有工具的函数描述(`function.description`)会通过工具列表注入规划 Agent。

**兜底保护**：即使 comment 字段被意外清除，插件也会检查 content 是否为工具定义格式的 JSON（以 `{` 开头且包含 `"type":"llm"/"code"` 和 `"function":`），自动将其识别为工具条目并过滤。注意此兜底仅适用于 `[TOOL:*]` 类条目；`[initvar]` 和 `[mvu_update]` 条目的内容没有固定 JSON 格式指纹，仍需依赖 comment 前缀识别。

### 2.4 注入流程总览

```
世界书条目
  │
  ├─ constant=true, position=4, role=0 ── getConstantSystemEntries()
  │   └─ 注入：规划 Agent system + 写作 Agent system
  │
  ├─ constant=true, position=0 ── getConstantBeforeCharEntries()
  │   └─ 注入：规划 Agent user + 写作 Agent user
  │
  ├─ constant=false, 有 key ── getSelectiveActivatedEntries()
  │   └─ 注入：规划 Agent user + 写作 Agent user(仅匹配时)
  │
  └─ 格式条目([TOOL:*] 等)── 被过滤，不直接注入 Agent prompt
      └─ 通过工具系统间接参与 Pipeline
```

***

## 3. Comment 前缀体系

### 3.1 标准叙事前缀

| 前缀           | 用途     | 建议注入方式                       |
| ------------ | ------ | ---------------------------- |
| 无前缀          | 通用叙事设定 | position=0, constant         |
| `[LOCATION]` | 地点描述   | position=0, constant         |
| `[NPC]`      | NPC 描述 | position=0, constant         |
| `[QUEST]`    | 任务定义   | position=0, constant         |
| `[RULE]`     | 规则约束   | position=4, role=0, constant |

### 3.2 工具前缀

| 前缀            | 用途      |
| ------------- | ------- |
| `[TOOL:name]` | 定义自定义工具 |

### 3.3 状态前缀

| 前缀             | 用途         |
| -------------- | ---------- |
| `[initvar]`    | MVU 变量初始值  |
| `[mvu_update]` | MVU 变量更新规则 |

***

## 4. 工具定义 \[TOOL:name]

通过 `[TOOL:name]` 前缀在 Pipeline 中注册自定义工具。content 字段为 JSON 格式。

### 4.1 工具类型对比

| 属性      | code 工具    | llm 工具                 |
| ------- | ---------- | ---------------------- |
| 执行方式    | 插件代码层确定性执行 | 调用 LLM 生成内容            |
| 是否调 LLM | 否          | 是                      |
| 典型用途    | 掷骰、计算、状态机  | 行动建议、文本生成、格式转换         |
| 输出可控性   | 完全确定性      | LLM 生成，需在 prompt 中约束格式 |

### 4.2 Trigger：决定执行时机

| trigger         | 执行时机                    | 对写作 Agent 可见 | 对用户可见 |
| --------------- | ----------------------- | ------------ | ----- |
| `planning`      | 规划 Agent 之后、写作 Agent 之前 | 是            | 否     |
| `post_pipeline` | 合并分析 Agent 之后（串行模式）     | 否            | 是     |

**planning 工具的隔离语义**：结果注入写作 Agent 但不显示给用户。适合需要 AI 辅助推理但不需要用户看到中间过程的功能(如场景分析、NPC 行为推演、掷骰判定)。

**post\_pipeline 工具的展示语义**：结果拼接到 chat\[] 末尾，用户可见。适合需要用户交互的功能(如行动选项、状态面板)。

**并行模式下的时序优化**：开启并行处理后，插件会根据工具的 `context` 字段自动判断其依赖关系。声明了 `story_summary` / `state_summary` / `known_context` 的工具依赖合并分析的输出，在分析完成后串行执行；其余工具与合并分析并行调用，节省整体耗时。

### 4.3 code 工具格式

code 工具分为两类：**内置工具**（`roll_dice`）和**自定义 code 工具**。自定义 code 工具通过 `code` 字段定义确定性计算逻辑，不调用 LLM。

#### 4.3.1 内置工具：roll\_dice

```json
{
  "uid": 600,
  "comment": "[TOOL:roll_dice]",
  "key": [],
  "content": "{\n  \"type\": \"code\",\n  \"function\": {\n    \"name\": \"roll_dice\",\n    \"description\": \"执行技能检定掷骰，判断角色行动成败\",\n    \"parameters\": {\n      \"type\": \"object\",\n      \"properties\": {\n        \"mode\": { \"type\": \"string\", \"enum\": [\"normal\", \"advantage\", \"disadvantage\", \"exploding\"], \"description\": \"检定类型\" },\n        \"expr\": { \"type\": \"string\", \"description\": \"骰子表达式，如 1d20+3\" },\n        \"dc\": { \"type\": \"number\", \"description\": \"目标难度，可选\" }\n      },\n      \"required\": [\"mode\", \"expr\"]\n    }\n  }\n}",
  "constant": true,
  "enabled": true,
  "order": 600
}
```

**内容字段说明**：

| 字段                     | 必须 | 说明                    |
| ---------------------- | -- | --------------------- |
| `type`                 | 是  | 固定为 `"code"`          |
| `function.name`        | 是  | 固定为 `"roll_dice"`     |
| `function.description` | 是  | 一行描述，注入规划 Agent 的工具列表 |
| `function.parameters`  | 是  | JSON Schema 格式，定义检定参数 |

**mode 枚举值**：

| 值              | 含义            |
| -------------- | ------------- |
| `normal`       | 普通掷骰(默认)      |
| `advantage`    | 优势(2d20取高)    |
| `disadvantage` | 劣势(2d20取低)    |
| `exploding`    | 爆炸骰(出最大值追加一骰) |

#### 4.3.2 自定义 code 工具

自定义 code 工具需要额外提供 `code` 字段，内容为 JavaScript 函数体（不含函数声明）。运行时将接收两个参数：

| 参数       | 说明                                       |
| -------- | ---------------------------------------- |
| `params` | 规划 Agent 传入的工具参数对象                       |
| `state`  | 当前游戏状态快照 `{}`，可通过 `state.变量名` 访问 MVU 变量值 |

代码体通过 `return` 语句输出结果，返回值可以是任意类型（对象、字符串、数字等）。结果会以 JSON 双空格缩进格式注入写作 Agent。

```json
{
  "uid": 610,
  "comment": "[TOOL:damage_calc]",
  "key": [],
  "content": "{\n  \"type\": \"code\",\n  \"function\": {\n    \"name\": \"damage_calc\",\n    \"description\": \"根据攻防数值计算伤害结果\",\n    \"parameters\": {\n      \"type\": \"object\",\n      \"properties\": {\n        \"atk\": { \"type\": \"number\", \"description\": \"攻击力\" },\n        \"def\": { \"type\": \"number\", \"description\": \"防御力\" }\n      },\n      \"required\": [\"atk\", \"def\"]\n    }\n  },\n  \"code\": \"const damage = Math.max(0, params.atk - params.def);\\nreturn { damage, remaining_hp: Math.max(0, state.hp - damage) };\"\n}",
  "constant": true,
  "enabled": true,
  "order": 610
}
```

**字段说明**：

| 字段     | 必须 | 说明                                                                      |
| ------ | -- | ----------------------------------------------------------------------- |
| `code` | 是  | JavaScript 函数体，`return` 输出的值作为工具结果。接收 `params`（工具参数）和 `state`（状态快照）两个变量 |

**不需要的字段**：code 工具（内置和自定义）均不需要 `trigger`、`context`、`system_prompt` 字段。这些字段仅 llm 工具使用。

**代码规范**：

- 必须是有效的 JavaScript 语法，注册前会自动进行语法校验
- 通过 `params.参数名` 访问规划 Agent 传入的参数值
- 通过 `state.变量名` 访问当前 MVU 状态变量值
- 运行异常会被自动捕获为工具错误，不会导致 Pipeline 中断
- 代码在浏览器 JS 上下文中执行，可使用 JS 内置对象（`Math`、`Date`、`JSON` 等）

### 4.4 llm 工具格式

```json
{
  "uid": 700,
  "comment": "[TOOL:action_generator]",
  "key": [],
  "content": "{\n  \"type\": \"llm\",\n  \"trigger\": \"planning\",\n  \"function\": {\n    \"name\": \"action_generator\",\n    \"description\": \"根据当前场景和玩家状态生成合理的行动选项\",\n    \"parameters\": { \"type\": \"object\", \"properties\": {}, \"required\": [] }\n  },\n  \"context\": [\"narrative_text\", \"state_summary\", \"user_input\"],\n  \"system_prompt\": \"你是行动选项生成器。根据当前游戏场景和玩家状态，生成 3-5 个合理的行动选项。\\n\\n输出格式：\\n<actions>\\n<action>选项描述</action>\\n...\\n</actions>\"\n}",
  "constant": true,
  "enabled": true,
  "order": 700
}
```

**内容字段说明**：

| 字段                     | 必须 | 说明                                         |
| ---------------------- | -- | ------------------------------------------ |
| `type`                 | 是  | 固定为 `"llm"`                                |
| `trigger`              | 是  | `"planning"` 或 `"post_pipeline"`           |
| `function.name`        | 是  | 自定义，蛇形命名(snake\_case)，如 `action_generator` |
| `function.description` | 是  | 一行描述，注入规划 Agent 工具列表                       |
| `function.parameters`  | 是  | JSON Schema，无参时 properties 为空对象            |
| `context`              | 是  | 字符串数组，声明需要的上下文组分(见下方)                      |
| `system_prompt`        | 是  | 工具的 system message，定义 LLM 角色、输出格式和约束规则     |

**可用 context 值**：

| 值                | 说明               |
| ---------------- | ---------------- |
| `world_full`     | 世界书全文            |
| `story_summary`  | 故事压缩摘要           |
| `recent_turns`   | 最近叙事片段           |
| `narrative_text` | 写作 Agent 产出的叙事正文 |
| `writing_guide`  | 规划 Agent 产出的写作指导 |
| `state_summary`  | 当前游戏状态摘要         |
| `user_persona`   | 用户角色设定           |
| `user_input`     | 本轮玩家输入           |
| `dice_results`   | 掷骰检定结果           |
| `known_context`  | 已知地点/NPC/物品/任务   |

**注意**：`context` 数组中的顺序不影响实际拼接顺序。插件始终按固定规范序列组装上下文，以最大化 API 缓存命中率。

### 4.5 规划 Agent 如何调用工具

规划 Agent 在输出 JSON 中通过 `tool_calls` 字段声明需要调用的工具：

```json
{
  "narrative_direction": "角色尝试说服守卫放行",
  "key_points": ["使用话术与守卫交涉", "强调自己来自法师公会"],
  "tone": "紧张",
  "pacing": "中",
  "continuity_notes": ["守卫之前对玩家表现出怀疑态度"],
  "tool_calls": [
    {
      "tool": "roll_dice",
      "params": {
        "mode": "normal",
        "expr": "1d20+3",
        "dc": 15,
        "success_branch": "守卫被说服，点头放行",
        "failure_branch": "守卫摇头，要求出示通行证"
      },
      "reason": "说服守卫属于魅力检定"
    },
    {
      "tool": "action_generator",
      "params": {},
      "reason": "根据当前场景生成玩家可选行动"
    }
  ]
}
```

每个 tool\_call 包含：

| 字段       | 必须 | 说明                      |
| -------- | -- | ----------------------- |
| `tool`   | 是  | 工具名，对应 `function.name`  |
| `params` | 是  | 工具参数，对应 `parameters` 定义 |
| `reason` | 否  | 调用原因，用于调试和日志            |

**code 工具额外字段**(roll\_dice 专用)：

| 字段               | 必须 | 说明                    |
| ---------------- | -- | --------------------- |
| `success_branch` | 否  | 成功时的叙事走向提示，注入写作 Agent |
| `failure_branch` | 否  | 失败时的叙事走向提示，注入写作 Agent |

### 4.6 llm 工具的 system\_prompt 编写建议

1. **以"你是XXX生成器"开头**：明确 LLM 的角色身份
2. **声明输出格式**：用 XML 标签包裹输出，如 `<actions>...</actions>`、`<state_panel>...</state_panel>`
3. **自行声明包裹格式**：插件不预设包裹标签，因为无法预判每个工具的格式需求。在 system\_prompt 中显式要求 LLM 用特定标签包裹
4. **列出约束规则**：用简短的要点列出生成规则
5. **最后加一句"只输出上述格式，不输出其他文字"**：防止 LLM 添加额外解释

***

## 5. MVU 变量管理

### 5.1 \[initvar] 变量初始化

定义状态变量的初始值。content 为 JSON 对象。

```json
{
  "uid": 800,
  "comment": "[initvar] 初始状态变量",
  "key": [],
  "content": "{\n  \"hp\": 100,\n  \"maxHp\": 100,\n  \"mp\": 50,\n  \"maxMp\": 50,\n  \"level\": 1,\n  \"exp\": 0,\n  \"gold\": 100\n}",
  "constant": true,
  "enabled": true,
  "order": 800
}
```

- key 可留空(前缀直接匹配)
- 变量名自行定义，需与 \[mvu\_update] 中的路径一致

### 5.2 \[mvu\_update] 变量更新规则

定义事件提取后的变量更新规则。content 为 JSON Patch 操作数组(RFC 6902 格式)。

```json
{
  "uid": 900,
  "comment": "[mvu_update] 战斗伤害更新",
  "key": [],
  "content": "[\n  { \"op\": \"replace\", \"path\": \"/hp\", \"value\": \"{{damage_result}}\" }\n]",
  "constant": true,
  "enabled": true,
  "order": 900
}
```

- 支持的操作：`replace`、`add`、`remove`、`move`、`copy`、`test`
- `{{变量名}}` 为事件提取 agent 输出的动态值占位符
- key 可留空(前缀直接匹配)

***

## 6. 预设注入

SillyTavern 预设中的"AI 回复设定"文本可以通过 `presetMode: "split"` 注入到 Agent 中：

| 预设中的消息角色         | 注入目标                              |
| ---------------- | --------------------------------- |
| system 消息        | 规划 Agent system + 写作 Agent system |
| user 消息(长度 >100) | 写作 Agent user                     |

`presetMode: "none"` 时忽略全部预设内容。

**注意**：预设中的 user 消息通常用于在酒馆中定义副本模式(scenario mode)的提示。当 `presetMode: "split"` 时，这些提示会注入写作 Agent 的 user message 顶部。

***

## 7. Order 分组建议

建议的 order 范围分配，便于维护和阅读：

| 前缀类型                | order 范围 |
| ------------------- | -------- |
| 无前缀(叙事设定)           | 100-199  |
| `[LOCATION]`        | 200-299  |
| `[NPC]`             | 300-399  |
| `[QUEST]`           | 400-499  |
| `[RULE]`            | 500-599  |
| `[TOOL:xxx]` (code) | 600-649  |
| `[TOOL:xxx]` (llm)  | 650-799  |
| `[initvar]`         | 800-899  |
| `[mvu_update]`      | 900-999  |

***

## 8. 最佳实践

### 8.1 条目设计原则

1. **system 放规则，user 放叙事**：永久性的世界规则、系统约束放在 @D(position=4, role=system)；描述性内容(地点、NPC、场景)放在 Char(position=0)
2. **一个条目只做一件事**：不要把 NPC 描述和地点描述混在同一个条目里——这会让关键词匹配变得不可预测
3. **关键词要精准**：选择性条目(constant=false)的 key 应该覆盖实际会在对话中出现的词汇。使用别名、简称、常见错别字作为额外 key
4. **content 保持简洁**：每个条目的 content 控制在 200-500 字。过长的 content 会稀释关键词匹配的精确性，也浪费 token
5. **权衡条件激活**：永久激活的条目总会命中缓存，触发激活的条目注入位置在历史对话之后，跨轮时总是无法命中缓存。不建议在角色后的条目中使用过于复杂的内容描述，否则会导致成本显著增加。

### 8.2 工具设计原则

1. **planning 工具保持轻量**：planning 工具的结果注入写作 Agent，token 消耗会计入写作 Agent 的上下文。避免在 planning 工具中生成大量文本
2. **post\_pipeline 工具用于用户可见内容**：状态面板、行动选项、旁白点评等内容用 post\_pipeline 工具生成
3. **llm 工具的 system\_prompt 中明确输出标签**：始终声明 `<标签>内容</标签>` 格式，便于您使用正则处理后经由酒馆助手进行前端渲染。直接命令llm工具输出可被渲染的代码块也是可行的，但输出文本量过多会导致api请求的成本显著变高

### 8.3 缓存优化

1. **constant 条目放 system**：永久激活的 system 条目跨轮不变，完全命中 API prefix cache
2. **避免在关键词条目中频繁变更 content**：如果内容变化频繁，考虑拆分为多个更小粒度的条目
3. **预设中的 system 消息保持稳定**：避免在预设中放置每轮变化的动态内容

***

## 9. 常见问题

### Q: 为什么我的 \[TOOL:xxx] 条目内容出现在叙事中了？

A: 插件通过两种方式识别工具条目：(1) comment 前缀 `[TOOL:*]`；(2) content 的 JSON 结构（`{"type":"llm"/"code", "function":...}`）。满足任一条件即被识别并过滤。

如果你的工具条目内容出现在叙事中，检查以下几点：

1. comment 是否以 `[TOOL:name]` 开头——这是主要的识别方式
2. content 是否为合法的工具定义 JSON（如果 content 被改成了纯文本且 comment 也被清除，插件将无法识别）
3. 条目是否被禁用（disabled 的条目不会被注入，也不会被过滤识别）

**建议**：始终在 comment 中使用 `[TOOL:name]` 前缀，这是最可靠的识别方式。content 兜底检测是为了防御 comment 意外丢失的容错机制。

### Q: 为什么关键词条目(constant=false)不生效？

A: 检查以下三点：

1. key 是否为空(关键词条目必须有关键词)
2. 关键词是否真的出现在最近的聊天文本中(插件检查最近 2 条消息)
3. 条目是否被禁用(enabled 是否为 true)

### Q: planning 工具和 post\_pipeline 工具的区别？

A: planning 工具的输出仅供写作 Agent 参考，用户不可见。post\_pipeline 工具的输出拼接到 chat\[] 末尾，用户可见。选择标准：是否需要用户看到和交互。

### Q: 如何让写作 Agent 知道掷骰结果？

A: 当规划 Agent 返回包含 `roll_dice` 的 `tool_calls` 时，插件自动执行掷骰，并将格式化的检定结果注入写作 Agent 的 user message 末尾(`[工具结果]` 区块)。同时 system message 会追加一条约束"必须严格按照结果中的走向来写作"。

### Q: 预设注入后，为什么内容出现在奇怪的位置？

A: 预设中 system 消息注入所有 Agent 的 system message(作为前缀)；user 消息仅注入写作 Agent 的 user message。system 消息通常包含全局角色定义以及元认知，适合所有 Agent；user 消息通常是场景模式以及写作规范提示，适合写作 Agent。

### Q: order 值影响什么？

A: order 影响同一分类内条目的排序。对于永久激活的条目，order 决定注入 prompt 时的顺序(order 小的排在前面)。这会影响 LLM 阅读世界设定的顺序，建议将更基础、更通用的设定放在前面(较小的 order)。

### Q: 条目应该放在角色卡里还是世界书里？

A: 建议放在世界书中。角色卡通常包含角色扮演噪音和格式信息，插件不读取角色卡内容。世界书条目提供的设定可以精确控制注入位置和策略。如果使用卡包(PNG 内嵌世界书)，在插件设置中选择 `worldbookSource: "card"`。
