# 多 Agent 叙事系统（Narrative Agent）

SillyTavern 扩展，通过多个**上下文隔离**的 Agent 将 LLM 从「直接续写」升级为「规划—写作—分析」的结构化叙事流水线，并提供可扩展的自定义工具接口。

***

## 目录

- [概述](#概述)
- [插件特点](#插件特点)
- [整体架构设计与重要配置参数](#整体架构设计与重要配置参数)
- [预设条目注意事项](#预设条目注意事项)
- [世界书条目分类](#世界书条目分类)
- [各 Agent 的 Prompt 构成](#各-agent-的-prompt-构成)
- [拼接 Prompt 的默认顺序与缓存命中策略](#拼接-prompt-的默认顺序与缓存命中策略)
- [工具系统介绍与示例](#工具系统介绍与示例)
- [MVU 变量管理](#mvu-变量管理)
- [最佳实践](#最佳实践)
- [已知限制](#已知限制)

***

## 概述

本插件拦截 SillyTavern 默认的文本生成流程，替换为多 Agent 协作的叙事 Pipeline。每轮对话依次经过以下阶段：

**串行模式（默认）**：

```
用户输入 → 规划 → [工具执行] → 写作 → 合并分析 → [post_pipeline 工具] → 输出
```

**合并输出模式（无 planning 工具且未启用原文召回时自动切换）**：

```
用户输入 → 合并写作（规划+写作二合一） → 合并分析 → [post_pipeline 工具] → 输出
```

**并行模式（可选）**：

```
用户输入 → 规划 → [工具执行] → 写作 → (合并分析 ‖ 独立工具) → 状态更新 → [依赖工具] → 输出
```

- 插件检测 post\_pipeline 工具的 `context` 依赖：声明了 `story_summary` / `state_summary` / `known_context` 的工具在合并分析之后执行，其余工具可与合并分析并行。

***

## 插件特点

- **上下文隔离**：每个 Agent 仅看到完成任务所需的最小上下文，减少噪声引入，提升指令遵循度
- **确定性状态管理**：默认提供确定性状态管理工具，LLM 只建议状态变更（10 种事件类型），代码层负责校验和写入，杜绝幻觉篡改；可通过声明MVU相关条目无缝替代
- **可扩展工具系统**：世界书作者可通过在世界书中添加 `[TOOL:name]` 条目定义 Planning 阶段工具和 Post-Pipeline 工具，无需修改插件代码；支持内置 `roll_dice` 与自定义 `code` 工具（JavaScript 计算逻辑）
- **世界书条目分类注入**：条目根据 position（`4=atDepth` / `0=before_char` / `1=after_char`）和激活策略（永久 / 关键词）自动路由到对应 Agent 的正确 message 位置，作者无需关心 Agent 内部结构
- **分段稳定前缀缓存**：对话历史窗口采用 n+m 分段生长策略，理想情况下历史对话部分的 token 级缓存命中率达 \~74%，显著降低 API 使用成本
- **轻量化默认**：无 planning 工具时自动切换为合并输出模式，比默认模式减少 1 次 API 请求
- 历史消息压缩：自动压缩每轮对话的正文部分，提供summary作为主要的上下文存在形式
- **原文召回**：规划 Agent 可声明需要参考的历史轮次，插件从对话中提取对应轮次正文原文注入写作 Agent，启用后强制分离规划与写作 Agent
- **对话级状态隔离**：每个对话独立维护游戏状态和摘要，切换对话自动保存/恢复，删除聊天时自动清理残留数据（settings.json 中 chatStates + localStorage 中 checkpoints）
- **JS-Slash-Runner 渲染兼容**：Pipeline 完成后手动发射 `MESSAGE_EDITED`、`MESSAGE_UPDATED`、`CHARACTER_MESSAGE_RENDERED` 事件，确保 JS-Slash-Runner 等依赖事件系统的插件能正确检测到消息内容变更
- **LLM 调用次数透明**：默认 3 次（有 planning 工具时），无工具时自动降至 2 次，post\_pipeline 工具按需额外增加

***

## 整体架构设计与重要配置参数

### 模块结构

```
narrative-agent/
├── index.js              # 主入口，扩展初始化与设置面板注册
├── manifest.json         # 扩展清单
├── settings.html         # 设置面板 HTML
├── style.css             # 状态面板样式
│
├── orchestrator.js       # 核心编排器，完整 Pipeline 调度逻辑
├── bridge.js             # SillyTavern 事件桥接（拦截/替换/输出）
├── context-router.js     # 上下文路由层，为各 Agent 构造隔离 messages
│
├── agent-planning.js     # 规划 Agent，输出结构化写作指导
├── agent-writing.js      # 写作 Agent + 合并写作 Agent
├── agent-analysis.js     # 合并分析 Agent（事件提取 + 摘要压缩）
│
├── state.js              # StateManager（确定性游戏状态）+ SummaryStore（摘要存储）
├── store.js              # FileManager，localStorage 持久化与对话文件管理
├── readers.js            # CharacterReader（角色卡读取）+ UserPersonaReader（用户角色）
├── worldbook.js          # WorldInfoResolver，世界书条目加载/分类/缓存
│
├── tools.js              # 工具执行引擎（code/llm/roll_dice 三类工具）
├── dice.js               # 骰子引擎（普通/优势/劣势/爆炸四种模式）
├── mvu.js                # MVU 变量框架状态摘要生成
├── parser.js             # JSON 输出解析（规划/事件提取/合并分析）
├── llm.js                # LLM 调用封装（重试/错误处理）
│
├── constants.js          # 全局常量、默认配置、系统 Prompt 模板
├── utils.js              # 通用工具函数
├── settings.js           # 配置加载/保存/对话状态持久化
│
├── TUTORIAL.md           # 世界书作者教程
└── README.md             # 本文档
```

### 核心数据流

```
用户输入
  │
  ▼
SillyTavern (CHAT_COMPLETION_PROMPT_READY)
  │  拦截默认 prompt，替换为中继占位符
  ▼
GENERATION_ENDED — 执行完整 Pipeline
  │
  ├─ [一次性加载] WorldInfoResolver 分类加载世界书条目
  │   ├─ getConstantSystemEntries()      → position=4, constant=true 的条目 → 注入 system
  │   ├─ getConstantBeforeCharEntries()  → position=0, constant=true 的条目 → 注入 user
  │   ├─ getConstantAfterCharEntries()   → position=1, constant=true 的条目 → 注入 user
  │   ├─ getSelectiveActivatedEntries()  → constant=false, 主/副关键词匹配 → 注入 user
  │   └─ getActiveTools()                → [TOOL:*] 条目
  │
  ├─ ★ 无 planning 工具且未启用原文召回：合并写作模式
  │
  ├─ Agent 1: 规划 (Planning) ──→ 写作指导 JSON + tool_calls[] + text_recall[]
  │
  ├─ Planning 工具执行 ──→ codeToolResults / llmToolOutputs
  │
  ├─ ★ 原文召回 ──→ 从 chat 历史提取指定轮次原文
  │
  ├─ Agent 2: 写作 (Writing) ──→ 叙事正文
  │
  ├─ Agent 3: 合并分析 (Merged Analysis) ─→ 事件 JSON + 摘要条目
  │
  ├─ 状态更新 ──→ applyEvents() + appendEntries()
  │
  ├─ Post-pipeline 工具 ──→ llmToolOutputs（对用户可见）
  │
  └─ 整合输出 ──→ 写入 chat[] ──→ 发射 MESSAGE_EDITED / MESSAGE_UPDATED ──→ SillyTavern 前端渲染
```

### 配置参数全览

```javascript
{
  enabled: true,                         // 启用/禁用插件
  presetMode: "none",                    // 预设处理: none | split
  worldbookSource: "auto",               // 世界书来源: auto | card | world
  pipeline: {
    recentTurnsForPlanning: 4,           // 规划 Agent 最小窗口轮数 (n)
    planningGrowthMargin: 4,             // 规划 Agent 生长缓冲区 (m)
    recentTurnsForWriting: 3,            // 写作 Agent 最小窗口轮数 (n)
    writingGrowthMargin: 4,              // 写作 Agent 生长缓冲区 (m)
    parallelExecutionEnabled: false,     // 并行处理开关
    enableTextRecall: false,             // 原文召回开关
  },
  agents: {
    planning:       {},                  // 规划 Agent 预留配置
    writing:        {},                  // 写作 Agent 预留配置
    mergedAnalysis: { antiHallucination: true }, // 反幻觉标记
  },
  state: {
    autoSyncWorldInfo: true,             // 自动同步世界书到游戏状态
    persistToLocalStorage: true,         // 持久化到 localStorage
  },
}
```

### n 和 m 参数含义

`recentTurnsForXxx`（n）和 `xxxGrowthMargin`（m）控制分段稳定前缀窗口的行为：

- 窗口从 n 轮开始自然积累，逐步生长到 n+m 轮
- 达到 n+m+1 轮时截断最早 m+1 轮，回到 n 轮
- 这种策略使历史对话部分的 token 序列在多数轮次之间保持稳定，从而最大化 LLM API 的前缀缓存命中率

当前默认值：规划 n=4, m=4（窗口 4\~8 轮），写作 n=3, m=4（窗口 3\~7 轮）。

### 状态管理器（StateManager）

确定性游戏状态引擎，LLM 只建议变更，代码负责校验写入。状态字段：

| 字段              | 类型                           | 说明                             |
| --------------- | ---------------------------- | ------------------------------ |
| `time`          | `{day, hour, minute}`        | 游戏内时钟，初始第1天 00:00              |
| `location`      | `string`                     | 当前位置，初始 `"起点"`                 |
| `inventory`     | `Record<string, number>`     | 物品 → 数量                        |
| `relationships` | `Record<string, number>`     | NPC名 → 关系值 (-100..100)         |
| `quests`        | `Record<string, QuestState>` | 任务状态 (active/completed/failed) |
| `flags`         | `Record<string, any>`        | 任意键值标记                         |
| `eventLog`      | `EventRecord[]`              | 事件日志（持久化最近 200 条）              |

支持 10 种事件类型：`move`、`add_item`、`remove_item`、`set_relationship`、`modify_relationship`、`start_quest`、`advance_quest`、`complete_quest`、`set_flag`、`pass_time`。

### 摘要存储（SummaryStore）

每轮合并分析 Agent 将本轮对话压缩为一条摘要追加到列表。摘要格式为 `[第N轮] 用户意图：xxx | 叙事要点：yyy`。摘要置顶注入上下文以提升缓存命中率（每轮仅在尾部追加新条目，历史条目不变）。

### LLM 调用次数

| 阶段                   | 是否调 LLM | 说明                            |
| -------------------- | ------- | ----------------------------- |
| 规划                   | 是       | 有 planning 工具或启用原文召回时；否则与写作合并 |
| Planning code 工具     | 否       | 代码层执行                         |
| Planning llm 工具      | 是       | 仅当有 trigger=planning 的 llm 工具 |
| 写作                   | 是       | 有工具时；否则与规划合并                  |
| 合并分析                 | 是       | 事件提取 + 摘要压缩合并为单次调用            |
| Post-pipeline llm 工具 | 是       | 按工具数量逐个调用                     |
| 合并写作                 | 是       | 无工具时规划+写作二合一                  |

***

## 预设条目注意事项

### 预设处理模式

通过 `presetMode` 控制 SillyTavern 预设中 AI 回复设定文本的注入方式：

| 模式      | 说明                                                                                    |
| ------- | ------------------------------------------------------------------------------------- |
| `none`  | 忽略预设，不注入任何 Agent。**默认模式**                                                             |
| `split` | 将预设中的 system 消息注入**规划 Agent system** + **写作 Agent system**；user 消息注入**写作 Agent user** |

### 注入位置

**`split`** **模式下预设注入具体位置**：

- `presetContext.planningContext`（system 消息） → 规划 Agent system prompt 的**最开头**（在所有 `<worldinfo1>` 之前）
- `presetContext.writingSystemContext`（system 消息） → 写作 Agent system prompt 的**最开头**（在所有 `<worldinfo1>` 之前）
- `presetContext.writingUserContext`（user 消息） → 写作 Agent user prompt 的**最开头**（在所有 `<worldinfo2>` 之前）

### 注意事项

1. **split 模式下的预设不是万能的**：预设文本会注入 Agent 的 prompt，可能与 Agent 内置的任务指令产生冲突（如预设要求「只输出简短回复」但 Agent 指令要求「200-400 字」），**应避免在预设中给出与 Agent 任务相矛盾的长度/格式约束**
2. **合并输出模式下的预设注入**：`none` 模式下预设不注入任何 Agent；`split` 模式下的合并写作 Agent 的 prompt 可以认为是取规划和写作两个 agent 的并集

***

## 世界书条目分类

### 条目注入策略总览

条目通过 SillyTavern UI 中的 position 和 constant 设置决定注入目标：

| UI 设置                 | position | constant | 注入目标 Agent | 注入 message 角色    |
| --------------------- | -------- | -------- | ---------- | ---------------- |
| @D（atDepth，角色=system） | 4        | true     | 规划 + 写作    | system           |
| ↑Char（before\_char）   | 0        | true     | 规划 + 写作    | user             |
| ↓Char（after\_char）    | 1        | true     | 写作         | user（worldinfo3） |
| 关键词激活                 | 任意       | false    | 规划 + 写作    | user（worldinfo3） |

### 具体分类逻辑

#### 1. `getConstantSystemEntries()` — 注入 system 层

**筛选条件**：

- `constant === true`
- `position === 4`（atDepth）
- 非格式化条目

**注入目标**：规划 Agent 和写作 Agent 的 system message，包裹在 `<worldinfo1>` 标签内。按 `order` 排序。

**典型用途**：叙事规则、全局世界观设定、写作风格约束等需要在系统层面固定注入的内容。

#### 2. `getConstantBeforeCharEntries()` — 注入 user 层

**筛选条件**：

- `constant === true`
- `position === 0`（before\_char）
- 非格式化条目

**注入目标**：规划 Agent 和写作 Agent 的 user message，包裹在 `<worldinfo2>` 标签内。

**典型用途**：重要角色相关设定、背景描述等需要在常态化出现的内容。

#### 3. `getConstantAfterCharEntries()` — 注入 user 层（worldinfo3）

**筛选条件**：

- `constant === true`
- `position === 1`（after\_char）
- 非格式化条目

**注入目标**：写作 Agent 的 user message，与关键词条目合并包裹在 `<worldinfo3>` 标签内。

#### 4. `getSelectiveActivatedEntries()` — 关键词匹配注入

**筛选条件**：

- `constant === false`
- 主关键词（`key`）或副关键词（`keysecondary`）匹配最近对话文本 + 游戏状态摘要

**注入目标**：规划 Agent 和写作 Agent 的 user message，包裹在 `<worldinfo3>` 标签内。按 `order` 排序。

**匹配文本构成**：最近 n 轮对话的 `user + assistant` 拼接 + 当前 `stateSummary`。

### 自动过滤的条目类型

以下 comment 前缀或 content 格式的条目会被自动过滤，**不会注入任何 Agent**：

| comment 前缀         | 用途                                                                          |
| ------------------ | --------------------------------------------------------------------------- |
| `[TOOL:*]`         | 工具定义                                                                        |
| `[UI]`             | UI 显示（暂无功能，等待后续更新）                                                          |
| `[initvar]`        | MVU 初始化变量                                                                   |
| `[mvu_update]`     | MVU 变量更新规则                                                                  |
| content 为有效工具 JSON | 即使 comment 被清除，content 中的 `{"type":"llm"/"code","function":...}` 结构也会被识别并过滤 |

### 世界书来源选择

| 来源   | 配置值     | 说明                                        |
| ---- | ------- | ----------------------------------------- |
| 自动   | `auto`  | 优先读取卡包内嵌，无则回退到世界书库（默认）                    |
| 卡包内嵌 | `card`  | 仅从角色卡 PNG 内嵌的 `character_book.entries` 读取 |
| 世界书库 | `world` | 仅从世界书库按名称加载                               |

### 缓存机制

`WorldInfoResolver` 内部维护条目缓存：卡包来源时通过条目特征指纹（comment、keys、content 等简单哈希）判断是否需要刷新，世界书来源通过世界书名称作为缓存键。切换对话或手动刷新时清除缓存。

***

## 各 Agent 的 Prompt 构成

### Agent 1：规划 Agent（Planning）

**触发条件**：存在 `trigger=planning` 的工具，或启用了原文召回。

**System Prompt 构成**（按拼接顺序）：

```
{presetContext.planningContext}          ← 预设 system 消息（split 模式）
<worldinfo1>                             ← constantSystemEntries（position=4 永久条目）
{条目1}
{条目2}
...
</worldinfo1>
PLANNING_SYSTEM_SUFFIX                   ← 内置规划引擎指令（constants.js）
{toolListText}                           ← 当前可用的 planing 工具列表（仅检测到工具时注入）
```

**User Prompt 构成**（按拼接顺序）：

```
<worldinfo2>                             ← constantBeforeCharEntries（position=0 永久条目）
{条目1}
{条目2}
...
</worldinfo2>
<story_summary>                          ← SummaryStore 全部摘要
{摘要列表}
</story_summary>
<user_persona>                           ← 用户角色设定
{persona描述}
</user_persona>
<recent_turns>                           ← 最近 n 轮对话（分段稳定窗口）
[轮1] 用户: ... | AI: ...
[轮2] 用户: ... | AI: ...
</recent_turns>
<worldinfo3>                             ← constantAfterCharEntries + selectiveActivatedEntries
{条目1}
{条目2}
...
</worldinfo3>
<state_summary>                          ← 当前游戏状态（来自 StateManager 或 MVU）
时间：第1天 00:00
地点：起点
物品：无
...
</state_summary>
<user_input>                             ← 用户最新输入
{用户消息}
</user_input>
请生成写作指导。
```

**输出格式**（JSON）：

```json
{
  "narrative_direction": "不少于100字的叙事方向和场景构建",
  "scene_setting": "场景的时间地点环境简介",
  "key_points": ["要点1", "要点2", ...],
  "tone": "紧张",
  "pacing": "中",
  "continuity_notes": ["伏笔1", "细节2"],
  "tool_calls": [{ "tool": "name", "params": {} }],
  "text_recall": [1, 3]
}
```

### Agent 2：写作 Agent（Writing）

**触发条件**：规划阶段完成后执行。合并输出模式下使用 `runMergedWritingAgent`。

**System Prompt 构成**（按拼接顺序）：

```
{presetContext.writingSystemContext}     ← 预设 system 消息（split 模式）
<worldinfo1>                             ← constantSystemEntries（与规划 Agent 共享）
{条目1}
{条目2}
...
</worldinfo1>
WRITING_SYSTEM_SUFFIX                    ← 内置写作引擎指令（constants.js）
（若有工具结果）系统追加：工具执行结果已由系统确定，必须严格按结果走向写作
```

**User Prompt 构成**（按拼接顺序）：

```
{presetContext.writingUserContext}       ← 预设 user 消息（split 模式）【最开头】
<worldinfo2>                             ← constantBeforeCharEntries
{条目1}
...
</worldinfo2>
<user_persona>                           ← 用户角色设定
{persona描述}
</user_persona>
<recent_turns>                           ← 最近 n 轮对话（分段稳定窗口）
[轮1] 用户: ... | AI: ...
</recent_turns>
<worldinfo3>                             ← constantAfterCharEntries + selectiveActivatedEntries
{条目1}
...
</worldinfo3>
<text_recall>                            ← 原文召回结果（仅启用 textRecall 且有命中时）
[第N轮]
原文内容...
</text_recall>
<writing_guide>                          ← 规划 Agent 的 JSON 输出格式化
叙事方向：...
场景设置：...
要点：...
基调：...，节奏：...
延续细节：...
</writing_guide>
<tool_results>                           ← Planning 工具执行结果（仅当有工具调用时）
检定结果：1d20 = [15]+2 = 17 (DC 12) → 成功
</tool_results>
<user_input>                             ← 用户最新输入
{用户消息}
</user_input>
```

### Agent 3：合并分析 Agent（Merged Analysis）

**触发条件**：每轮叙事生成后必然执行。

**System Prompt**（完整片段，来自 `constants.js` 的 `MERGED_ANALYSIS_SYSTEM`）：

包含 `SHARED_ANALYSIS_PREFIX`（核心原则） + 事件提取任务 + 摘要压缩任务两者合一。

**User Prompt 构成**（由 `context-router.js` 构建）：

```
{已有摘要}                                ← 置顶以提升缓存命中
{当前世界状态}
本轮对话内容 + 指令
```

**输出格式**（JSON）：

```json
{
  "events": [{ "type": "move", "params": { "location": "矿洞" } }],
  "summary_entries": ["[第3轮] 用户意图：探索矿洞 | 叙事要点：兰韦德进入矿洞..."]
}
```

### 合并写作 Agent（Merged Writing）

**触发条件**：无 planning 工具且未启用原文召回时，跳过独立规划，直接使用合并写作。

**System Prompt 构成**：

```
{presetContext.planningContext}          ← 预设 system 消息
<worldinfo1>                             ← constantSystemEntries
{条目1}
...
</worldinfo1>
MERGED_WRITING_SYSTEM_SUFFIX             ← 内置合并写作指令
```

**User Prompt 构成**（与写作 Agent 类似，多 `<story_summary>` 和 `<state_summary>`）：

```
{presetContext.writingUserContext}
<worldinfo2>
...
</worldinfo2>
<user_persona>
...
</user_persona>
<story_summary>
{摘要列表}
</story_summary>
<recent_turns>
...
</recent_turns>
<worldinfo3>
...
</worldinfo3>
<text_recall>                            ← 合并模式下同样支持原文召回
...
</text_recall>
<state_summary>
{游戏状态}
</state_summary>
<user_input>
{用户消息}
</user_input>
【思维模式要求】...
```

***

## 拼接 Prompt 的默认顺序与缓存命中策略

### 各 Agent User Prompt 片段的拼接顺序

#### 规划 Agent user prompt 顺序

| 序号 | 片段   | 标签                | 数据来源                                                               |
| -- | ---- | ----------------- | ------------------------------------------------------------------ |
| 1  | 前置条目 | `<worldinfo2>`    | `getConstantBeforeCharEntries()`                                   |
| 2  | 故事摘要 | `<story_summary>` | `summaryStore.getAllSummaries()`                                   |
| 3  | 用户角色 | `<user_persona>`  | `userPersonaReader.getPersonaInfo()`                               |
| 4  | 最近叙事 | `<recent_turns>`  | 分段稳定窗口中的最近轮次                                                       |
| 5  | 匹配条目 | `<worldinfo3>`    | `getConstantAfterCharEntries()` + `getSelectiveActivatedEntries()` |
| 6  | 游戏状态 | `<state_summary>` | `StateManager.getSummary()` 或 MVU 摘要                               |
| 7  | 用户输入 | `<user_input>`    | 用户消息原文                                                             |
| 8  | 指令   | 纯文本               | `"请生成写作指导。"`                                                       |

#### 写作 Agent user prompt 顺序

| 序号 | 片段      | 标签                | 数据来源                                                               |
| -- | ------- | ----------------- | ------------------------------------------------------------------ |
| 1  | 预设 user | `<user_preset>`   | `presetContext.writingUserContext`（split 模式）                       |
| 2  | 前置条目    | `<worldinfo2>`    | `getConstantBeforeCharEntries()`                                   |
| 3  | 用户角色    | `<user_persona>`  | `userPersonaReader.getPersonaInfo()`                               |
| 4  | 最近叙事    | `<recent_turns>`  | 分段稳定窗口中的最近轮次                                                       |
| 5  | 匹配条目    | `<worldinfo3>`    | `getConstantAfterCharEntries()` + `getSelectiveActivatedEntries()` |
| 6  | 原文召回    | `<text_recall>`   | 从 chat\[索引] 中提取的 `<context>` 原文                                    |
| 7  | 写作指导    | `<writing_guide>` | 规划 Agent 输出的格式化指导                                                  |
| 8  | 工具结果    | `<tool_results>`  | Planning 阶段 code/llm 工具执行结果                                        |
| 9  | 用户输入    | `<user_input>`    | 用户消息原文                                                             |

#### 合并分析 Agent user prompt 顺序

| 序号 | 片段     | 说明                          |
| -- | ------ | --------------------------- |
| 1  | 已有摘要   | **置顶**，提升缓存命中率（每轮仅在尾部追加新条目） |
| 2  | 当前世界状态 | stateSummary                |
| 3  | 本轮对话内容 | narrativeText + userInput   |
| 4  | 指令     | 事件提取 + 摘要压缩指令               |

### 分段稳定前缀缓存策略

#### 工作原理

传统的滑动窗口每轮都会丢弃最早一轮并添加最新一轮，导致整个对话历史的 token 序列完全变化，**前缀缓存命中率为 0%**。

本插件采用 n+m 分段生长策略：

```
轮次 1:  窗口 [1]              (1轮)
...
轮次 n:  窗口 [1,2,...,n]      (n轮)
轮次 n+1: 窗口 [1,2,...,n+1]    (n+1轮，生长中)
...
轮次 n+m: 窗口 [1,...,n+m]      (n+m轮，达到上限)
轮次 n+m+1: 窗口 [m+2,...,n+m+1] (截断前 m+1 轮，回退到 n 轮)
轮次 n+m+2: 窗口 [m+2,...,n+m+2] (继续生长)
```

在第 n+2 到 n+m 轮之间，窗口仅追加新轮，历史部分完全不变 → 缓存命中。在第 n+m+1 轮截断时缓存失效，但随后又重新进入生长阶段。

#### 理论缓存命中率

历史消息部分的 token 级缓存命中率 H = 1 − (2(2(n+m)-1)) / ((2n+m)(m+1))

**默认配置下的命中率**：

| Agent | n | m | 窗口范围   | 缓存命中率  |
| ----- | - | - | ------ | ------ |
| 规划    | 4 | 5 | 4\~9 轮 | 无意义    |
| 写作    | 3 | 6 | 3\~9 轮 | ≈60% |

#### 设计考量

- **与 Agent 职责匹配**：规划 Agent 需要更多上下文来生成全局指导，写作 Agent 更聚焦近期叙事
- **m 不宜过大**：m 越大窗口变化周期越长，缓存效益越好，但峰值输入 token 数越高。默认 m=4 表现均衡
- **合并分析不受影响**：合并分析的已有摘要在 prompt 中**置顶**，每轮仅尾部追加本轮的新条目，头部几乎完全不变，天然具备高缓存命中

***

## 工具系统介绍与示例

### 工具定义方式

世界书作者通过 `[TOOL:name]` comment 前缀的条目定义工具。条目的 `content` 字段为 JSON 格式。

### 工具分类

按 `trigger` 字段分为两类：

| trigger         | 执行时机                    | 结果可见性               | 典型用途           |
| --------------- | ----------------------- | ------------------- | -------------- |
| `planning`      | 规划 Agent 之后、写作 Agent 之前 | 仅传递给写作 Agent，用户不可见  | 骰子检定、数值计算、内部查询 |
| `post_pipeline` | 写作 + 分析之后               | 拼接到 chat\[] 末尾，用户可见 | 状态面板生成、外部输出    |

按 `type` 字段分为两类：

| type   | 执行方式      | 说明                                      |
| ------ | --------- | --------------------------------------- |
| `code` | 代码层确定性执行  | 内置 `roll_dice` 或自定义 JS 代码（通过 `code` 字段） |
| `llm`  | 调用 LLM 生成 | 通过 `system_prompt` 定义行为                 |

### 条目 content JSON 结构

```jsonc
{
  "type": "code",                        // "code" | "llm"
  "trigger": "planning",                 // "planning" | "post_pipeline"
  "function": {
    "name": "my_tool",                   // 工具唯一名称，规划 Agent 通过 tool_calls 引用
    "description": "工具用途描述，注入规划 Agent 的 toolListText",
    "parameters": {                      // 参数 schema，注入规划 Agent
      "type": "object",
      "properties": {
        "param1": { "type": "string", "description": "参数说明" }
      },
      "required": ["param1"]
    }
  },
  "context": ["state_summary", "user_input"],  // llm 工具的上下文声明（可选）
  "system_prompt": "\n你是一个...",               // llm 工具的 system prompt
  "code": "return params.a + params.b;",        // code 工具的 JS 代码（仅自定义 code 工具）
  "output_tag": "state_panel",                  // post_pipeline llm 工具的输出 XML 标签名（可选）
  "tag_lookback": 3                             // 回看前 N 轮的 output_tag 内容（可选）
}
```

### 内置工具：roll\_dice

`roll_dice` 是内置的 code 工具，`type=code` 且 `function.name="roll_dice"`，无需提供 `code` 字段。支持四种模式：

| 模式             | 说明            | 表达式示例           |
| -------------- | ------------- | --------------- |
| `normal`       | 普通掷骰          | `1d20`, `2d6+3` |
| `advantage`    | 优势（掷两次取高）     | `1d20`          |
| `disadvantage` | 劣势（掷两次取低）     | `1d20`          |
| `exploding`    | 爆炸骰（掷出最大值时追加） | `1d6`           |

规划 Agent 在 `tool_calls` 中声明 `{"tool": "roll_dice", "params": {"expr": "1d20+5", "mode": "advantage", "dc": 15}}`。

### 自定义 code 工具

插件通过 `new Function("params", "state", code)` 执行代码，代码接收两个变量：

| 变量       | 说明                                             |
| -------- | ---------------------------------------------- |
| `params` | 规划 Agent 传入的工具参数对象                             |
| `state`  | 当前 `StateManager` 状态快照 `{}`，可通过 `state.变量名` 访问 |

通过 `return` 输出结果。注册前自动进行语法校验（`new Function` 解析），运行时异常不会中断 Pipeline。

**示例**：计算伤害减免

```jsonc
// comment: [TOOL:calc_damage]
// content:
{
  "type": "code",
  "trigger": "planning",
  "function": {
    "name": "calc_damage",
    "description": "计算最终伤害：基础伤害 - 护甲值，最低为 1",
    "parameters": {
      "type": "object",
      "properties": {
        "base_damage": { "type": "number", "description": "基础伤害值" },
        "armor": { "type": "number", "description": "护甲值" }
      },
      "required": ["base_damage"]
    }
  },
  "code": "const dmg = params.base_damage - (params.armor || 0); return Math.max(1, dmg);"
}
```

*注意 * 世界书条目内容要求是完整且正确的json结构，如果您的内容（prompt/code）已经被默认结构的双引号包裹，则需要自行将内容中的双引号做转义

### llm 工具与上下文声明

llm 工具通过 `context` 数组声明需要注入的上下文片段。支持的 context key 定义在 `constants.js` 的 `CANONICAL_CONTEXT_ORDER` 中：

```
world_full → story_summary → recent_turns → narrative_text → writing_guide
→ state_summary → user_persona → user_input → dice_results → known_context
```

声明中的 key 按此固定顺序排列后注入 tool 的 user message。

### Post-pipeline llm 工具的 output\_tag 机制

当 post\_pipeline 工具声明 `output_tag` 和 `tag_lookback` 后，插件从 `ctx.chat` 中提取最近 `tag_lookback` 轮该标签的内容，拼接为 `<tool_history>` 块注入工具自身的 LLM 上下文。

**典型用例**：state\_panel 工具声明 `"output_tag": "state_panel"`, `"tag_lookback": 3`，每轮可回顾前三轮自己输出的面板内容，实现跨轮连贯性。此内容仅工具自身可见，不会暴露给规划、写作、分析等 Agent。

### 工具执行时机总结

```
规划 Agent 输出 tool_calls[]
        │
        ▼
  ┌─ code 工具 → ToolExecutor.execute() → 代码层执行 → 结果注入写作 Agent
  │
  └─ llm 工具 (trigger=planning) → callLLM → 结果注入写作 Agent
        │
        ▼
  写作 Agent 生成叙事正文
        │
        ▼
  合并分析 Agent 提取事件 + 压缩摘要
        │
        ▼
  ┌─ post_pipeline llm 工具 → callLLM → 结果追加到 chat[]
  │
  └─（如有 MVU 条目）mvu_extract 自动工具 → 应用 patches
```

***

## MVU 变量管理

### 概述

插件与 SillyTavern 的 MVU（Message Variable Update）变量框架集成，提供结构化的变量状态管理。当世界书中存在 `[initvar]` 或 `[mvu_update]` 条目时，插件自动启用 MVU 集成。

### 初始化变量：\[initvar]

`[initvar]` 条目定义初始变量树。插件在首个对话轮次时自动读取并初始化 MVU 的 `stat_data`。

**content 格式**：JSON 对象或缩进文本（通过 `parseTextToVariables()` 解析）。

```jsonc
// comment: [initvar]
// content:
{
  "主角": {
    "生命值": 100,
    "信用点数": 500,
    "改装仓库": ["基础扫描器", "维修工具包"]
  },
  "世界": {
    "当前地点": "起点",
    "天气": "晴朗"
  }
}
```

**执行逻辑**：

1. Pipeline 首轮时检查 MVU 是否已有数据，有则跳过初始化
2. 解析 `[initvar]` 条目的 content（优先 JSON，回退 YAML 式文本）
3. 通过 `Mvu.replaceMvuData()` 写入 `stat_data`

### 变量更新规则：\[mvu\_update]

`[mvu_update]` 条目定义变量更新的约束规则，其 content 会注入 `mvu_extract` 自动工具的 system prompt 中，指导 LLM 如何提取变量变更。

```jsonc
// comment: [mvu_update]
// content:
当角色受到伤害时，减少 /主角/生命值
当角色获得信用时，增加 /主角/信用点数
当角色获得新装备时，向 /主角/改装仓库 末尾插入
```

**规则格式**为自然语言，由 LLM 理解后转换为 JSON Patch 操作。

### 自动工具：mvu\_extract

当世界书中存在 `[initvar]` 或 `[mvu_update]` 条目时，插件自动注册 `mvu_extract` 工具（`trigger=post_pipeline`，`type=llm`）。

**System Prompt 构成**：

```
SHARED_ANALYSIS_PREFIX
【任务：变量状态提取】
从叙事文本中提取世界状态变更，输出 JSON Patch 格式。

JSON Patch 操作类型：
- replace: 替换字段值
- delta: 数值增减
- insert: 创建新字段或向数组追加
- remove: 删除字段
- move: 移动字段

path 使用 / 分隔的 JSON Pointer 路径，对应变量树中的层级。

如果没有状态变更，输出：{ "patches": [] }

补充规则：
- 仅对「当前变量状态」中列出的已有路径执行操作，不要凭空创建新的一级分类

以下为变量更新规则：
{mvuRules}
```

**输出格式**（JSON Patch）：

```json
{
  "patches": [
    { "op": "replace", "path": "/世界/当前地点", "value": "矿洞" },
    { "op": "delta", "path": "/主角/信用点数", "value": -200 },
    { "op": "insert", "path": "/主角/改装仓库/-", "value": "涡轮增压器V2" }
  ]
}
```

### 状态摘要生成

`getMvuStateSummary()` 函数（`mvu.js`）将 MVU 变量树递归展开为扁平文本，供 Agent 的 `<state_summary>` 使用。当 MVU 数据不可用时，自动回退到 `StateManager.getSummary()`。

### MVU 与 StateManager 的关系

- **StateManager**：插件内置的确定性状态引擎，管理 10 种标准事件类型
- **MVU**：SillyTavern 社区常用变量框架，提供更灵活的自定义变量树
- **优先级**：`_getStateSummary()` 先尝试从 MVU 读取，失败时回退到 StateManager
- **回滚同步**：对话回滚（重生成）时，MVU 数据从 checkpoint 恢复

***
## 最佳实践

### 1. 保持预设条目最小化启用

本插件绕过了sillytavern原生的prompt拼接流程，直接读取预设条目与世界书条目内容并进行拼接，且拼接时已经进行了XML标签包裹。使用时，应当将预设中所有XML标签条目以及所有包含格式要求的条目*全部关闭*，以免引入噪音。
预设中，只需要保留注入system message的元认知/破甲条目以及您需要的文风条目，请关闭对思维链结构提出要求的条目！！！

### 2. 优化世界书条目结构

对于所有开启的条目，插件默认会将位置为`系统`的条目作为`worldinfo1`注入`system message`;将所有的位置为`before_char`且*永久激活*（蓝灯）的条目作为`worldinfo2`注入`user message`;将所有的位置为`after_char`或*关键词激活*（绿灯）的非系统条目作为`worldinfo3`注入`user message`。
在编排世界书条目时，您应当将最关键的核心设定设置为`系统`条目，将篇幅较大且剧情强依赖的条目设置为`before_char`位置的蓝灯条目。由于`worldinfo3`在多次重新生成以外的情况均无法命中缓存，您应当精简这部分的条目内容。
尽量不要让`worldinfo1`和`worldinfo2`中的条目在对话过程中发生变化，变化的条目应当尽量设置为`after_char`位置。

### 3. 精简TOOL上下文与输出

在设计`TOOL`时，您应当遵循最小化上下文注入原则，即仅注入必要的上下文，避免引入噪音。
对于`TOOL`的输出，仍然建议您在prompt中明确XML标签包裹，以便可能的工具输出回顾以及正则化处理。
依然建议您使用`TOOL`时只获取XML包裹的关键内容，HTML格式使用正则化处理，这是出于LLM输出速度的考量。输出token量将主导任务完成时长，轻量化的LLM输出将显著提升响应速度。

***
## 已知限制

### 1. 世界书条目数量影响上下文长度

所有 `constant=true` 的条目均为无条件全量注入。若世界书体量庞大（条目数 > 50），每轮注入的 token 数可能超过数千，**影响 API 成本与响应速度**。建议：

- 将大段设定文本拆分到关键词触发的 `selective` 条目中，而非全量注入
- 合理使用 `order` 排序：不改变的关键设定置前以利用缓存，频繁变化的内容置后

### 2. 规划 Agent 仅感知世界书摘要

规划 Agent 只能看到 `story_summary`（摘要）而非完整叙事历史。对于需要精确引用几年前对话细节的场景，建议启用**原文召回**功能并让规划 Agent 声明 `text_recall`。

### 3. 工具系统的 code 执行沙箱有限

`new Function("params", "state", code)` 在浏览器主线程中执行，**无真正沙箱隔离**。自定义 code 工具的作者应确保代码无副作用（不修改全局变量、不发起网络请求）。插件仅做语法校验，不做静态安全检查。

### 4. 合并分析的事件提取依赖 LLM 理解力

事件提取（10 种类型）完全依赖 LLM 对叙事文本的理解。当 LLM 能力较弱或上下文过长时，可能出现：

- 遗漏关键事件（如角色移动未提取 `move` 事件）
- 时间推断偏差（`pass_time` 的 amount 不准确）
- 物品增减参数错误（`quantity` 与实际不符）

StateManager 层会校验参数合法性，但不合法的事件会被**拒绝**而非修正，可能导致状态与叙事脱节。

### 5. 并行模式下的确定性

启用 `parallelExecutionEnabled` 后，独立 post\_pipeline 工具与合并分析 Agent 并发调用，但写入 `chat[]` 的顺序需要桥接层处理。当前实现中并行仅缩短耗时，输出结果仍按串行顺序拼接，但若两个并发的 LLM 调用产生冲突性内容（如状态面板与叙事摘要描述矛盾），**无自动协调机制**。

### 6. 预设 split 模式的局限性

`split` 模式下预设的 system 消息注入规划和写作两个 Agent，但无法选择性注入。例如无法实现「某条规则仅规划 Agent 可见而写作 Agent 不可见」的细粒度控制。如有此需求，建议将对应的内容以世界书条目的形式实现。

### 7. 用户角色设定仅注入规划与写作 Agent

`userPersonaReader` 读取的 `persona_description` 仅注入规划 Agent 和写作 Agent 的 user prompt，不会注入合并分析 Agent。这意味着合并分析 Agent 无法感知用户角色的具体设定，可能在 `summary_entries` 中将用户行为概括得不够精确。

### 8. 无内置上下文长度警告

插件不监控各 Agent prompt 的最终 token 数是否超出模型限制。当世界书条目过多、对话轮次过长时，可能导致 prompt 超出模型上下文窗口而截断。建议通过 API 侧设置合理 `max_tokens` 或监控控制台日志中的请求失败信息。

### 9. 仅有文字状态，无内置数值系统

`StateManager` 提供的是结构化键值状态管理，但本身不带数值计算（如伤害公式、等级系统）。需要此类功能的世界书作者应通过自定义 code 工具实现，或使用 MVU 变量框架。

### 10. 无法在正文中添加格式化信息

当前插件不允许在pipeline内对写作agent生成的<context>内容做修改与格式化输出，因此正文内容将是纯文本的。
未来将会考虑在pipeline尾部追加由[UI]条目指导的agent对<context>内的正文进行格式化内容添加或重构，单独提供<UI>字段以供前端展示，<context>字段使用正则化隐藏。
