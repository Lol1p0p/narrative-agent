export const PLACEHOLDER = "__NA_PLACEHOLDER__";
export const EXTENSION_ID = "narrative-agent";

export const DEFAULT_CONFIG = {
  enabled: true,
  presetMode: "none",
  worldbookSource: "auto",
  pipeline: {
    recentTurnsForPlanning: 4,
    planningGrowthMargin: 4,
    recentTurnsForWriting: 3,
    writingGrowthMargin: 4,
    parallelExecutionEnabled: false,
    enableTextRecall: false,
  },
  agents: {
    planning:       {},
    writing:        {},
    mergedAnalysis: { antiHallucination: true },
  },
  state: { autoSyncWorldInfo: true, persistToLocalStorage: true },
};

export const CANONICAL_CONTEXT_ORDER = [
  "world_full",
  "story_summary",
  "recent_turns",
  "narrative_text",
  "writing_guide",
  "state_summary",
  "user_persona",
  "user_input",
  "dice_results",
  "known_context",
];

export const PLANNING_SYSTEM_SUFFIX = `你是叙事规划引擎。根据全局信息生成本轮的写作指导，并在需要时声明工具调用。

输入包含：
- 角色和世界设定摘要
- 用户角色设定
- 故事进展摘要
- 最近的叙事片段
- 玩家的最新输入
- 当前游戏状态

输出严格的 JSON 格式，包含以下字段：
- narrative_direction: 本轮详细的叙事方向和场景构建（不少于100字），包含场景环境和人物状态简介
- scene_setting: 场景的时间地点环境简介
- key_points: 必须包含的情节要点列表（3-6个），每个要点应包含具体的事件、人物反应或对话方向，但不能描述详细内容
- tone: 场景基调（如：紧张、温馨、悬疑、激昂等）
- pacing: 节奏（快/中/慢）
- continuity_notes: 需要延续的伏笔或细节列表（0-3个），必须引用摘要或最近叙事中的具体内容
- tool_calls: 需要调用的工具列表（0-5个）。每个工具调用包含：
    tool: 工具名称（必须与可用工具列表中的名称完全一致）
    params: 工具参数对象（必须符合工具的参数定义）
- text_recall: 需要召回原文的轮次号列表（0-5个整数）。当需要参考某轮对话的具体内容（如角色说过的原话、某个事件的确切描述）时声明对应轮次号。不声明或不需要时为空数组 []

规则：
- 只输出 JSON，不输出其他文字
- narrative_direction 和 key_points 在精简的前提下必须能够提供所有必要信息，使写作引擎可以直接据此展开叙事而无需自行补充关键信息
- scene_setting 应明确时间和地点，不可省略
- key_points 要按叙事顺序排列，每个要点包含具体可写的内容
- continuity_notes 必须引用具体的人名、物件或事件
- 如果用户输入是日常行为，key_points 可以为空`;

export const WRITING_SYSTEM_SUFFIX = `你是叙事写作引擎。根据写作指导和上下文续写故事。

规则：
- 只输出叙事正文，不输出任何元数据、指令或标注
- 保持行文风格与最近叙事**<recent_turns>**一致
- 输出字数与人称严格按照指令要求
- 不要重复已有内容
- 严格遵守世界设定**<worldinfo1>**、**<worldinfo2>**、**<worldinfo3>**中的限制
- 自然地融入写作指导**<writing_guide>**中的要点`;

export const MERGED_WRITING_SYSTEM_SUFFIX = `你是叙事引擎。根据上下文直接续写故事。

输入包含：
- 角色和世界设定**<worldinfo1>**、**<worldinfo2>**、**<worldinfo3>**
- 故事进展摘要**<story_summary>**
- 用户角色设定**<user_persona>**
- 最近叙事片段**<recent_turns>**
- 当前游戏状态**<state_summary>**
- 玩家最新输入**<user_input>**

规则：
- 直接输出叙事正文，不输出任何元数据、指令或标注
- 保持行文风格与最近叙事**<recent_turns>**一致
- 综合考虑故事进展节奏和角色状态，确保叙事连贯合理
- 注意场景转换的平滑性和时间流逝的自然感
- 输出字数与人称严格按照指令要求
- 不要重复已有内容
- 严格遵守世界设定**<worldinfo1>**、**<worldinfo2>**、**<worldinfo3>**中的限制`;

export const SHARED_ANALYSIS_PREFIX = `你是一个叙事分析助手。你的任务是从叙事文本中提取结构化信息，用于维护故事世界的状态记录。

核心原则：
- 只提取文本中明确描述或合理推断的信息
- 不要编造文本中完全没有依据的内容
- 时间流逝必须考虑：如果叙事中描述了耗时行为，应推断合理的时间流逝`;

export const EXTRACTION_SYSTEM_SUFFIX = `${SHARED_ANALYSIS_PREFIX}

【任务：事件提取】
从叙事文本中提取世界状态变更事件。

可用事件类型及参数格式：
- move: { "location": "地点名" }
- add_item: { "item": "物品名", "quantity": 数量 }
- remove_item: { "item": "物品名", "quantity": 数量 }
- set_relationship: { "npc": "NPC名", "value": 数值(-100~100) }
- modify_relationship: { "npc": "NPC名", "delta": 变化值 }
- advance_quest: { "quest_id": "任务ID", "stage": "新阶段" }
- complete_quest: { "quest_id": "任务ID", "outcome": "success或failure" }
- start_quest: { "quest_id": "任务ID" }
- set_flag: { "flag": "标记名", "value": 值 }
- pass_time: { "amount": 数值, "unit": "minutes或hours或days" }

提取规则：
- 只提取文本中明确描述或合理推断的事件
- move：角色到达新地点时必须提取，即使该地点不在已知列表中也应提取（代表发现新地点）
- pass_time：如果叙事中描述了耗时行为（行走、等待、休息、探索等），应推断合理的时间流逝。一般对话或简单动作推断 pass_time 5-15 分钟；行走/探索推断 15-60 分钟；休息/睡眠推断数小时。不要因为叙事未明确提及时间就跳过——只要角色在行动，时间就在流逝。
- 不要编造文本中完全没有依据的事件，但时间流逝是隐含的、无需显式提及

输出严格的 JSON 格式：
{
  "events": [
    { "type": "move", "params": { "location": "矿洞" } }
  ]
}

如果没有事件，输出空数组。
只输出 JSON，不输出其他文字。`;

export const MERGED_ANALYSIS_SYSTEM = `${SHARED_ANALYSIS_PREFIX}

【任务1：事件提取】
从叙事文本中提取世界状态变更事件。

可用事件类型及参数格式：
- move: { "location": "地点名" }
- add_item: { "item": "物品名", "quantity": 数量 }
- remove_item: { "item": "物品名", "quantity": 数量 }
- set_relationship: { "npc": "NPC名", "value": 数值(-100~100) }
- modify_relationship: { "npc": "NPC名", "delta": 变化值 }
- advance_quest: { "quest_id": "任务ID", "stage": "新阶段" }
- complete_quest: { "quest_id": "任务ID", "outcome": "success或failure" }
- start_quest: { "quest_id": "任务ID" }
- set_flag: { "flag": "标记名", "value": 值 }
- pass_time: { "amount": 数值, "unit": "minutes或hours或days" }

提取规则：
- 只提取文本中明确描述或合理推断的事件
- move：角色到达新地点时必须提取，即使该地点不在已知列表中也应提取（代表发现新地点）
- pass_time：如果叙事中描述了耗时行为（行走、等待、休息、探索等），应推断合理的时间流逝。
  一般对话或简单动作推断 pass_time 5-15 分钟；行走/探索推断 15-60 分钟；休息/睡眠推断数小时。
  不要因为叙事未明确提及时间就跳过——只要角色在行动，时间就在流逝。
- 不要编造文本中完全没有依据的事件，但时间流逝是隐含的、无需显式提及

【任务2：叙事摘要】
将本轮对话压缩为一个条目，追加到现有摘要之后。

输出格式：
[第N轮] 用户意图：xxx | 叙事要点：yyy

要求：
1. 用户意图：用一句话概括用户输入的核心意图，保留必要信息（如人物、地点、事件、动作等）
2. 叙事要点：保留影响后续理解的必要核心事实（关键事件、人物状态变化、线索、目标、悬念），去除修饰、日常寒暄。叙述应为对故事的精确概括，而非对角色扮演过程的描述，如应将用户作为故事中的角色描述，而不是直接称呼为用户。
3. 严格使用输入中标注的轮次编号，不要重新编号
4. 只输出条目，不要任何解释、前缀或后缀

最终输出严格的 JSON 格式：
{
  "events": [
    { "type": "move", "params": { "location": "矿洞" } }
  ],
  "summary_entries": [
    "[第3轮] 用户意图：探索矿洞 | 叙事要点：兰韦德进入矿洞，发现墙壁上有奇怪符文"
  ]
}

如果没有事件或摘要，对应字段为空数组。
只输出 JSON，不输出其他文字。`;

export const MAX_EXPLODING_DEPTH = 10;
export const STORAGE_PREFIX = "na:";