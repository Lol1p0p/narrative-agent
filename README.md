# 多Agent叙事系统

SillyTavern 扩展，通过多个**上下文隔离**的 Agent 处理用户输入，将 LLM 从"直接续写"升级为"规划—写作—分析"的结构化叙事流水线并提供自定义工具编写与调用接口。

***

# 第一部分：插件介绍

## 概述

本插件拦截 SillyTavern 默认的文本生成流程，替换为多 Agent 协作的叙事 Pipeline。每轮对话依次经过以下阶段：

**串行模式（默认）**：

```
用户输入 → 规划 → [工具执行] → 写作 → 合并分析 → [post_pipeline 工具] → 输出
```

**合并输出模式（无 planning 工具时自动切换）**：

```
用户输入 → 合并写作（规划+写作二合一） → 合并分析 → [post_pipeline 工具] → 输出
```

**并行模式（可选）**：

```
用户输入 → 规划 → [工具执行] → 写作 → (合并分析 || 独立工具) → 状态更新 → [依赖工具] → 输出
```

插件会自动检测 post\_pipeline 工具的 context 依赖：声明了 `story_summary` / `state_summary` / `known_context` 的工具在合并分析之后执行，其余工具与合并分析并行。

**核心特点**：

- **上下文隔离**：每个 Agent 只看到完成任务所需的最小上下文，减少噪声引入
- **确定性状态管理**：LLM 只建议状态变更，代码层负责验证和写入，杜绝幻觉篡改
- **工具系统**：世界书作者可通过 `[TOOL:name]` 条目定义 Planning 阶段工具和 Post-Pipeline 工具，无需修改插件代码。支持内置 `roll_dice` 与自定义 code 工具（通过 `code` 字段定义 JavaScript 计算逻辑）
- **世界书条目分类注入**：条目根据位置（system / before_char / after_char）和激活策略（永久 / 关键词）自动路由到对应 Agent 的正确 message 位置
- **分段稳定前缀缓存**：对话历史窗口采用 n+m 分段生长策略，历史对话部分的token 级缓存命中率达 72%+，显著降低 API 使用成本
- **零开销默认**：无工具时自动切换为合并输出模式（规划+写作二合一，单次 LLM 调用），比默认模式减少 1 次 API 请求
- **对话级状态隔离**：每个对话独立维护游戏状态和摘要，切换对话自动保存/恢复

## 安装

1. 将本文件夹复制到 SillyTavern 的 `public/scripts/extensions/narrative-agent/` 目录下
2. 重启 SillyTavern 或在扩展管理中刷新
3. 在扩展设置中启用「Narrative Agent」

**文件清单**：

```
narrative-agent/
├── index.js              # 主入口，扩展初始化与设置面板注册
├── manifest.json         # 扩展清单
├── settings.html         # 设置面板 HTML
├── style.css             # 状态面板样式
│
├── orchestator.js        # 核心编排器，完整 Pipeline 调度逻辑
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
├── utils.js              # 通用工具函数（ST 上下文获取/文本截断/预设拆分等）
├── settings.js           # 配置加载/保存/对话状态持久化
│
├── README.md             # 本文档
└── TUTORIAL.html         # 世界书作者教程
```

## 架构概览

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
  │   ├─ getConstantSystemEntries()      → system 条目（position=4, role=0, 永久激活）
  │   ├─ getConstantBeforeCharEntries()  → before_char 条目（position=0, 永久激活）
  │   ├─ getConstantAfterCharEntries()   → after_char 条目（position=1, 永久激活）
  │   ├─ getSelectiveActivatedEntries()  → 关键词匹配条目（匹配最近对话文本 + 游戏状态摘要，含主/副关键词）
  │   └─ getActiveTools()                → [TOOL:*] 条目
  │
  ├─ ★ 无 planning 工具时：合并写作模式 ────→ 直接叙事正文（规划+写作二合一，单次 LLM 调用）
  │   system: {planningContext} + {systemEntries} + MERGED_WRITING_SUFFIX
  │   user:   {writingUserPreset} + {beforeCharEntries} + 用户角色 + 故事摘要 + 最近叙事片段 + {selectiveEntries} + 游戏状态 + 用户输入
  │   ※ 跳过独立的规划和写作阶段，直接输出叙事文本
  │
  ├─ Agent 1: 规划 (Planning) ──────→ 写作指导 JSON + tool_calls[]
  │   system: {presetContext} + {systemEntries} + PLANNING_SUFFIX + {toolList}
  │   user:   故事摘要 + {beforeCharEntries} + 用户角色 + 最近叙事片段 + {selectiveEntries} + 游戏状态 + 用户输入
  │   ※ 检测到 [TOOL:xxx] 时自动注入工具声明列表
  │   ※ 仅当有 planning 工具时执行，否则启动合并写作模式
  │
  ├─ Planning 工具执行 ──────────────→ codeToolResults / llmToolOutputs
  │   ※ 仅当 planning agent 返回 tool_calls[] 时执行
  │   ※ code 工具：代码层确定性执行，不调用 LLM
  │   ※ llm 工具（trigger=planning）：调用 LLM，结果传递给写作 agent 但不显示给用户
  │
  ├─ Agent 2: 写作 (Writing) ───────→ 叙事正文
  │   system: {writingSystemPreset} + {systemEntries} + WRITING_SUFFIX
  │   user:   {writingUserPreset} + 用户角色 + 最近叙事片段 + {selectiveEntries} + 写作指导 + [工具结果] + 用户输入
  │   ※ system 与规划 agent 共享 systemEntries
  │   ※ writingSystemPreset / writingUserPreset 由 extractPresetContext() 分拆
  │
  ├─ Agent 3: 合并分析 (Merged Analysis) ─→ 事件 JSON + 摘要条目
  │   system: SHARED_ANALYSIS_PREFIX + 事件提取任务 + 压缩任务
  │   user:   已有摘要 + 当前世界状态 + 本轮对话 + 指令
  │   ※ 事件提取与压缩合并为单一 LLM 调用，减少 API 请求次数
  │   ※ 已有摘要置顶以提升缓存命中率（每轮仅尾部追加）
  │
  ├─ 状态更新 ──────────────────────────→ 应用事件 + 追加摘要
  │   ※ stateManager.applyEvents() 变更游戏状态
  │   ※ summaryStore.appendEntries() 追加摘要条目
  │
  ├─ Post-pipeline 工具（串行模式）──────→ llmToolOutputs (对用户可见)
  │   ※ trigger=post_pipeline 的 llm 工具，在状态更新后执行
  │   ※ 结果拼接到最终 chat[] 末尾
  │   ※ 并行模式下：不依赖分析结果的工具与 Agent 3 并行执行
  └─ 整合输出 ──→ 写入 chat[] → SillyTavern 前端渲染
      finalOutput = narrative + post_pipeline 工具结果
```

### 模块结构说明

本扩展按功能划分为以下核心模块：

- **桥接层**（bridge.js）：拦截 SillyTavern 的生成事件，替换默认流程并注入自定义输出。
- **编排器**（orchestator.js）：协调 Pipeline 各阶段的执行顺序与数据流转。
- **上下文路由**（context-router.js）：为规划、写作、分析等 Agent 构造隔离的 messages 数组。
- **Agent 层**：
  - agent-planning.js / agent-writing.js / agent-analysis.js：分别实现规划、写作与合并分析 Agent。
  - 内置合并写作模式（agent-writing.js 中），无工具时自动融合规划与写作。
- **状态管理**（state.js / store.js）：StateManager 负责确定性游戏状态，SummaryStore 管理压缩摘要，FileManager 负责持久化。
- **世界书解析**（worldbook.js）：WorldInfoResolver 分类加载世界书条目并按规则注入各 Agent 上下文。
- **工具系统**（tools.js / dice.js）：解析并执行 \[TOOL:\*] 定义的工具，支持 code、llm、roll\_dice 三类。
- **辅助模块**（parser.js / llm.js / constants.js / utils.js / settings.js）：JSON 解析、LLM 调用封装、常量与默认配置、通用工具函数以及配置管理。

### LLM 调用次数

| 阶段                   | 是否调 LLM | 说明                                |
| -------------------- | ------- | --------------------------------- |
| 规划                   | 是       | 有工具时；无工具时与写作合并为单次调用               |
| Planning code 工具     | 否       | 代码层执行（内置 roll\_dice 或自定义 code 工具） |
| Planning llm 工具      | 是       | 仅当有 trigger=planning 工具           |
| 写作                   | 是       | 有工具时；无工具时与规划合并                    |
| 合并分析                 | 是       | 事件提取 + 压缩合并                       |
| Post-pipeline llm 工具 | 是       | 仅当有 trigger=post\_pipeline        |
| 合并写作（合并模式）           | 是       | 无工具时规划+写作二合一，单次 LLM 调用            |

默认 3 次 LLM 调用（有工具），无工具时自动切换合并输出模式降至 2 次。有工具时额外增加。启用并行处理后，不依赖分析结果的 post\_pipeline 工具与合并分析同时调用，可缩短整体耗时至约原来的 60-70%。

## 配置

```javascript
{
  enabled: true,
  presetMode: "none",           // 预设处理模式: none / split
  worldbookSource: "auto",      // 世界书来源: auto / card / world
  pipeline: {
    recentTurnsForPlanning: 4,  // 规划 Agent 最小窗口轮数 (n)
    planningGrowthMargin: 4,    // 规划 Agent 生长缓冲区 (m)
    recentTurnsForWriting: 3,   // 写作 Agent 最小窗口轮数 (n)
    writingGrowthMargin: 4,     // 写作 Agent 生长缓冲区 (m)
    parallelExecutionEnabled: false, // 启用并行处理（不依赖分析结果的 post_pipeline 工具与合并分析并行）
  },
  agents: {
    planning:       {},
    writing:        {},
    mergedAnalysis: { antiHallucination: true },
  },
  state: { autoSyncWorldInfo: true, persistToLocalStorage: true },
}
```

n 和 m 控制分段稳定前缀窗口：窗口从 n 轮开始生长，达到 n+m 后截断最早 m+1 轮回到 n。token 级缓存命中率 H = 1 - 2(n+m)/((2n+m)(m+1))。

当前配置：规划 H≈73.3%（峰值 8 轮），写作 H≈72.0%（峰值 7 轮）。

## 使用方式

1. 在 SillyTavern 中正常选择角色卡和世界书
2. 确保扩展已启用
3. 正常发送消息，插件会自动拦截并执行 Pipeline
4. 状态面板默认折叠在正文下方，点击可展开查看当前游戏状态
5. 切换对话时，游戏状态和摘要自动保存到当前对话、从新对话恢复

## 核心组件

### StateManager（状态管理器）

确定性游戏状态引擎。LLM 只建议状态变更，确定性代码负责验证和写入。

**状态字段**：

| 字段              | 类型                           | 说明                             |
| --------------- | ---------------------------- | ------------------------------ |
| `time`          | `{day, hour, minute}`        | 游戏内时钟，初始第1天 00:00              |
| `location`      | `string`                     | 当前位置，初始 "起点"                   |
| `inventory`     | `Record<string, number>`     | 物品 → 数量                        |
| `relationships` | `Record<string, number>`     | NPC名 → 关系值 (-100..100)         |
| `quests`        | `Record<string, QuestState>` | 任务状态 (active/completed/failed) |
| `flags`         | `Record<string, any>`        | 任意键值标记                         |
| `eventLog`      | `EventRecord[]`              | 事件日志（持久化最近200条）                |

**支持的事件类型**（10种）：move, add\_item, remove\_item, set\_relationship, modify\_relationship, start\_quest, advance\_quest, complete\_quest, set\_flag, pass\_time

### SummaryStore（摘要存储）

管理故事压缩摘要。每轮对话后，合并分析 agent 将本轮对话压缩为一个条目追加到摘要列表。

### UserPersonaReader（用户角色读取器）

从 SillyTavern 的 `powerUserSettings` 读取当前用户角色设定（persona\_description），自动处理 `{{user}}` 等宏替换。

### WorldInfoResolver（世界书解析器）

从 SillyTavern 世界书读取并分类条目。支持三种加载来源（`auto`/`card`/`world`），内部维护缓存。

**用于 Agent 上下文注入的分类方法**：

| 方法                               | 返回内容                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| `getConstantSystemEntries()`     | 永久激活、position=4 (atDepth)、role=0 (system) 的条目，排序后注入 system |
| `getConstantBeforeCharEntries()` | 永久激活、position=0 (before_char) 的条目，排序后注入 user              |
| `getConstantAfterCharEntries()`  | 永久激活、position=1 (after_char) 的条目，排序后注入 user（与关键词条目合并）   |
| `getSelectiveActivatedEntries()` | 关键词触发的非永久条目，匹配最近对话文本 + 游戏状态摘要后注入 user。同时匹配主关键词（key）和副关键词（keysecondary） |
| `getActiveTools()`               | 所有 `[TOOL:name]` 前缀的条目，按 trigger 分两类                       |

自动过滤格式条目（`[TOOL:*]`、`[UI]`、`[initvar]`、`[mvu_update]` 等用于系统功能而非叙事注入的条目）。此外，即使条目的 comment 字段被意外清除，插件也会通过 content 的 JSON 结构（`{"type":"llm"/"code", "function":...}`）自动识别工具条目并过滤。

**世界书来源**：

| 来源   | 配置值     | 说明                                        |
| ---- | ------- | ----------------------------------------- |
| 自动   | `auto`  | 优先读取卡包内嵌，无则回退到世界书库（默认）                    |
| 卡包内嵌 | `card`  | 仅从角色卡 PNG 内嵌的 `character_book.entries` 读取 |
| 世界书库 | `world` | 仅从世界书库按名称加载                               |

### 世界书条目分类与 Agent 注入策略

条目通过 SillyTavern UI 中的位置和角色设定来决定注入目标 Agent 和 message 角色：

| UI 设置                  | position | role | 注入目标                              |
| ---------------------- | -------- | ---- | --------------------------------- |
| @D⚙（atDepth，角色=system） | 4        | 0    | 规划 Agent system + 写作 Agent system |
| ↑Char（before_char）    | 0        | 任意   | 规划 Agent user + 写作 Agent user     |
| ↓Char（after_char）     | 1        | 任意   | 写作 Agent user（与关键词条目合并为 worldinfo3） |

激活策略决定是否注入：

| 激活策略  | 世界书设置          | 注入条件                                      |
| ----- | -------------- | ----------------------------------------- |
| 永久激活  | constant=true  | 始终注入（position/role 决定位置）                  |
| 关键词激活 | constant=false | 主关键词（key）或副关键词（keysecondary）匹配最近对话文本 + 游戏状态摘要时注入 |

### 工具系统

世界书作者通过 `[TOOL:name]` 条目定义自定义工具，按 trigger 分为两类：

| trigger         | 执行时机             | 结果可见性               |
| --------------- | ---------------- | ------------------- |
| `planning`      | 规划 Agent 之后、写作之前 | 仅传递给写作 Agent，用户不可见  |
| `post_pipeline` | 写作 + 分析之后        | 拼接到 chat\[] 末尾，用户可见 |

工具类型：

| type   | 执行方式        | 说明                                        |
| ------ | ----------- | ----------------------------------------- |
| `code` | 代码层确定性执行    | 内置 `roll_dice` 或自定义 JS 代码（通过 `code` 字段定义） |
| `llm`  | 调用 LLM 生成内容 | 通过 name 区分用途，同名按 priority 排序              |

**自定义 code 工具**：在 JSON content 中提供 `code` 字段，内容为 JavaScript 函数体。代码接收两个变量：

| 变量       | 说明                                     |
| -------- | -------------------------------------- |
| `params` | 规划 Agent 传入的工具参数对象                     |
| `state`  | 当前 MVU 状态快照 `{}`，可通过 `state.变量名` 访问状态值 |

通过 `return` 语句输出结果。注册前自动进行语法校验，运行时异常不会中断 Pipeline。

详见 [世界书作者教程](TUTORIAL.md)。

### 预设处理

通过 `presetMode` 控制 SillyTavern 预设中 AI 回复设定文本的注入方式：

| 模式      | 说明                                                                        |
| ------- | ------------------------------------------------------------------------- |
| `none`  | 忽略预设，不注入任何 Agent。默认模式                                                     |
| `split` | 将预设中的 system 消息注入规划 Agent system + 写作 Agent system；user 消息注入写作 Agent user |

### 分段稳定前缀缓存

叙事片段窗口采用 n+m 分段策略替代传统的硬性滑动窗口：

- 窗口从 n 轮开始自然积累，逐步生长到 n+m 轮
- 达到 n+m+1 轮时截断最早 m+1 轮，回到 n 轮
- 生长阶段内前缀完全稳定，每次仅尾部追加 1 轮新内容
- 叙事片段置于 selectiveEntries 之前，确保缓存锚点不被不稳定内容打断

最近对话部分的缓存命中率可由公式估计：H = 1 - 2(n+m)/\[(2n+m)(m+1)], 当前默认配置下写作agent prompt中该部分的理想命中率约为 72%。

### ContextRouter（上下文路由层）

为每个 Agent 构造独立的 messages 数组，确保每个 Agent 只看到完成任务所需的最小上下文。

### 三个 Agent

| Agent | 职责                                         | 输出格式                                                                                   |
| ----- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| 规划    | 综合全局信息，输出结构化写作指导。检测到工具时额外输出 `tool_calls[]` | JSON (narrative\_direction, key\_points, tone, pacing, continuity\_notes, tool\_calls) |
| 写作    | 根据写作指导和上下文生成叙事正文                           | 纯文本                                                                                    |
| 合并分析  | 从叙事正文提取结构化事件 + 将本轮压缩为摘要条目（单次 LLM 调用完成两项任务） | JSON `{events: [...], summary_entries: [...]}`                                         |
| 合并写作  | 无规划工具时自动启用，融合规划与写作职责，一次性输出叙事正文             | 纯文本（与写作 Agent 输出格式一致）                                                                  |

### 合并分析 Agent

事件提取和压缩合并为单次 LLM 调用。system message 共享前缀以提高连续调用时的缓存命中，user message 中已有摘要置顶以利用其稳定前缀特征。

输出格式：

```json
{
  "events": [
    { "type": "move", "params": { "location": "矿洞" } }
  ],
  "summary_entries": [
    "[第3轮] 用户意图：探索矿洞 | 叙事要点：玩家进入矿洞，发现墙壁上有奇怪符文"
  ]
}
```

### MVU 变量管理

当世界书提供 `[initvar]` 和 `[mvu_update]` 条目时，使用 MVU 框架管理游戏状态（需要酒馆助手插件）。事件提取 agent 输出 JSON Patch，通过 `Mvu.replaceMvuData()` 写入变量框架。

## 拦截机制

```
CHAT_COMPLETION_PROMPT_READY
  → 清空 data.chat
  → 推入中继占位符
  → 设置 wasIntercepted = true

GENERATION_ENDED
  → 执行 Orchestrator.pipeline()
  → 替换 chat 中最后一条消息的 mes 字段
  → 写入 extra.state_panel 供前端渲染
  → 手动 saveChat() 持久化
```

## 状态持久化与对话隔离

- **chatStates**：以 chatId 为键，存储每个对话的 `gameState` 和 `summaryStore`
- **对话切换**：监听 `CHAT_CHANGED` 事件，自动保存/恢复
- **消息删除**：监听 `MESSAGE_DELETED` 事件，自动回滚状态到对应轮次

## 已知限制

1. **generateRaw 参数共享**：所有 Agent 共享 ST 全局 temperature/max\_tokens
2. **部分并行**：默认串行执行；开启并行处理后独立 post\_pipeline 工具与合并分析并行，但规划→写作→分析的核心链路仍串行，Pipeline 执行期间阻塞用户交互
3. **localStorage 持久化**：大量对话数据可能触及 quota 限制（\~5MB），已内置修剪机制
4. **角色卡内容不参与推理**：角色设定应通过世界书条目提供
5. **无流式输出**：Pipeline 在 GENERATION\_ENDED 后执行，无法逐字流式显示
6. **世界书格式依赖 UI 配置**：条目分类依赖世界书作者在 SillyTavern UI 中正确设置位置（position）和角色（role）
7. **工具条目标识依赖 comment**：`[TOOL:xxx]` 类的条目通过 comment 前缀识别，若 comment 被意外清除，插件会通过 content 的 JSON 结构兜底检测；非 JSON 格式的格式条目（如 `[initvar]`、`[mvu_update]`）需要保持 comment 前缀完整

