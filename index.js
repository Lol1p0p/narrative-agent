/**
 * Narrative Agent — 多Agent叙事系统v0.2.0
 */

// =============================================================================
// 常量
// =============================================================================

const PLACEHOLDER = "__NA_PLACEHOLDER__";
const EXTENSION_ID = "narrative-agent";

const DEFAULT_CONFIG = {
  enabled: true,
  presetMode: "none",
  worldbookSource: "auto",
  pipeline: {
    recentTurnsForPlanning: 4,
    planningGrowthMargin: 4,
    recentTurnsForWriting: 3,
    writingGrowthMargin: 4,
    parallelExecutionEnabled: false,
  },
  agents: {
    planning:       {},
    writing:        {},
    mergedAnalysis: { antiHallucination: true },
  },
  state: { autoSyncWorldInfo: true, persistToLocalStorage: true },
};

const CANONICAL_CONTEXT_ORDER = [
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

// =============================================================================
// 工具函数
// =============================================================================

function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  return text.substring(0, maxLen) + "...";
}

function stripStatePanel(text) {
  if (!text) return text;
  return text.replace(/<state_panel>[\s\S]*?<\/state_panel>/g, "").trim();
}

function stripMvuTags(text) {
  if (!text) return text;
  let result = text;
  result = result.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g, "").trim();
  const contentMatch = result.match(/<content>([\s\S]*?)<\/content>/);
  if (contentMatch) result = contentMatch[1].trim();
  return result;
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function getSTContext() {
  try { return window.SillyTavern?.getContext() ?? null; } catch { return null; }
}

function extractPresetContext(chat, formattingSet) {
  const systemContext = [];
  let activeModePrompt = "";

  for (const msg of chat) {
    if (msg.role === "system" && msg.content && msg.content.trim()) {
      const trimmed = msg.content.trim();
      if (_isEntryExcluded(trimmed, formattingSet)) continue;
      const cleaned = _stripFormattingContent(trimmed, formattingSet);
      if (cleaned) systemContext.push(cleaned);
    }
    if (msg.role === "user" && msg.content && msg.content.length > 100) {
      activeModePrompt = msg.content;
    }
  }

  return {
    planningContext: systemContext.length > 0 ? systemContext.join("\n\n") : "",
    writingSystemContext: systemContext.length > 0 ? systemContext.join("\n\n") : "",
    writingUserContext: activeModePrompt || "",
  };
}

function _stripFormattingContent(text, formattingSet) {
  if (!text || typeof text !== "string") return text;
  if (!formattingSet || formattingSet.size === 0) return text;
  let result = text;
  for (const fmt of formattingSet) {
    if (!fmt || fmt.length === 0) continue;
    let idx;
    while ((idx = result.indexOf(fmt)) !== -1) {
      result = result.slice(0, idx) + result.slice(idx + fmt.length);
    }
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

function _isEntryExcluded(content, formattingSet) {
  if (_isToolEntryContent(content)) return true;
  if (formattingSet && formattingSet.has(content)) return true;
  return false;
}

function _isToolEntryContent(content) {
  if (!content.startsWith("{")) return false;
  const hasType = content.includes('"type":"llm"') || content.includes('"type":"code"');
  const hasFunction = content.includes('"function":');
  return hasType && hasFunction;
}

function parseTextToVariables(text) {
  if (!text || typeof text !== "string") return null;
  const lines = text.split("\n");
  const stack = [{ indent: -1, key: null, obj: {} }];
  const root = stack[0].obj;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    const colonIdx = content.indexOf(":");

    if (colonIdx === -1) continue;

    const key = content.substring(0, colonIdx).trim();
    const value = content.substring(colonIdx + 1).trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];

    if (value === "") {
      const newObj = {};
      if (Array.isArray(parent.obj)) {
        parent.obj.push(newObj);
      } else {
        parent.obj[key] = newObj;
      }
      stack.push({ indent, key, obj: newObj });
    } else {
      let parsed;
      if (value === "true" || value === "false") {
        parsed = value === "true";
      } else if (/^-?\d+$/.test(value)) {
        parsed = parseInt(value, 10);
      } else if (/^-?\d+\.\d+$/.test(value)) {
        parsed = parseFloat(value);
      } else {
        parsed = value;
      }
      if (Array.isArray(parent.obj)) {
        parent.obj.push(parsed);
      } else {
        parent.obj[key] = parsed;
      }
    }
  }

  return Object.keys(root).length > 0 ? root : null;
}

// =============================================================================
// StateManager
// =============================================================================

class StateManager {
  constructor(state) {
    this.state = state || {
      time: { day: 1, hour: 0, minute: 0 },
      location: "起点",
      inventory: {},
      relationships: {},
      quests: {},
      flags: {},
      eventLog: [],
    };
    this._knownLocations = new Set();
    this._knownNpcs = new Set();
  }

  move(location) {
    if (!location || typeof location !== "string" || location.trim() === "") return false;
    if (this._knownLocations.size > 0 && !this._knownLocations.has(location)) {
      this._knownLocations.add(location);
    }
    this.state.location = location;
    this._log("move", { location }, true);
    return true;
  }

  addItem(item, quantity) {
    if (!item || typeof item !== "string" || item.trim() === "") return false;
    const qty = typeof quantity === "number" && quantity > 0 ? quantity : 1;
    this.state.inventory[item] = (this.state.inventory[item] || 0) + qty;
    this._log("add_item", { item, quantity: qty }, true);
    return true;
  }

  removeItem(item, quantity) {
    if (!item || typeof item !== "string") return false;
    const qty = typeof quantity === "number" && quantity > 0 ? quantity : 1;
    const current = this.state.inventory[item] || 0;
    if (current < qty) {
      this._log("remove_item", { item, quantity: qty }, false, `库存不足: 需要${qty}, 当前${current}`);
      return false;
    }
    this.state.inventory[item] -= qty;
    if (this.state.inventory[item] <= 0) delete this.state.inventory[item];
    this._log("remove_item", { item, quantity: qty }, true);
    return true;
  }

  setRelationship(npc, value) {
    if (!npc || typeof npc !== "string" || npc.trim() === "") return false;
    if (typeof value !== "number" || value < -100 || value > 100) return false;
    if (this._knownNpcs.size > 0 && !this._knownNpcs.has(npc)) this._knownNpcs.add(npc);
    this.state.relationships[npc] = value;
    this._log("set_relationship", { npc, value }, true);
    return true;
  }

  modifyRelationship(npc, delta) {
    if (!npc || typeof npc !== "string") return false;
    if (typeof delta !== "number") return false;
    if (this._knownNpcs.size > 0 && !this._knownNpcs.has(npc)) this._knownNpcs.add(npc);
    const current = this.state.relationships[npc] || 0;
    this.state.relationships[npc] = Math.max(-100, Math.min(100, current + delta));
    this._log("modify_relationship", { npc, delta }, true);
    return true;
  }

  startQuest(questId, initialStage) {
    if (!questId || typeof questId !== "string") return false;
    if (this.state.quests[questId] && this.state.quests[questId].status === "active") return false;
    this.state.quests[questId] = { status: "active", stage: initialStage || "start" };
    this._log("start_quest", { quest_id: questId, stage: initialStage || "start" }, true);
    return true;
  }

  advanceQuest(questId, stage) {
    if (!questId || typeof questId !== "string") return false;
    if (!stage || typeof stage !== "string") return false;
    const q = this.state.quests[questId];
    if (!q || q.status !== "active") {
      this._log("advance_quest", { quest_id: questId, stage }, false, "任务不存在或非活跃");
      return false;
    }
    q.stage = stage;
    this._log("advance_quest", { quest_id: questId, stage }, true);
    return true;
  }

  completeQuest(questId, outcome) {
    if (!questId || typeof questId !== "string") return false;
    const oc = outcome || "success";
    if (oc !== "success" && oc !== "failure") return false;
    const q = this.state.quests[questId];
    if (!q || q.status !== "active") return false;
    q.status = oc === "success" ? "completed" : "failed";
    q.outcome = oc;
    this._log("complete_quest", { quest_id: questId, outcome: oc }, true);
    return true;
  }

  setFlag(key, value) {
    if (!key || typeof key !== "string" || key.trim() === "") return false;
    this.state.flags[key] = value;
    this._log("set_flag", { flag: key, value }, true);
    return true;
  }

  passTime(amount, unit) {
    const a = (typeof amount === "number" && amount > 0) ? amount : 0;
    const u = ["minutes", "hours", "days"].includes(unit) ? unit : "minutes";
    let minutes = a;
    if (u === "hours") minutes = a * 60;
    else if (u === "days") minutes = a * 1440;
    this._advanceClock(minutes);
    this._log("pass_time", { amount: a, unit: u }, true);
    return true;
  }

  applyEvents(events) {
    const accepted = [];
    const rejected = [];
    for (const event of events) {
      const record = this._processOne(event);
      if (record.accepted) accepted.push(record);
      else rejected.push(record);
    }
    return { accepted, rejected };
  }

  addKnownLocation(loc) { this._knownLocations.add(loc); }
  addKnownNpc(npc) { this._knownNpcs.add(npc); }

  getKnownContext() {
    return {
      locations: [...this._knownLocations].sort(),
      npcs: [...this._knownNpcs].sort(),
      items: Object.keys(this.state.inventory).sort(),
      quests: Object.keys(this.state.quests).sort(),
    };
  }

  getSummary() {
    const s = this.state;
    const lines = [];
    lines.push(`时间：第${s.time.day}天 ${String(s.time.hour).padStart(2, "0")}:${String(s.time.minute).padStart(2, "0")}`);
    lines.push(`地点：${s.location}`);
    const inv = Object.entries(s.inventory).map(([k, v]) => `${k}x${v}`).join(", ") || "无";
    lines.push(`物品：${inv}`);
    const rel = Object.entries(s.relationships).map(([k, v]) => `${k}: ${v}`).join(", ") || "无";
    lines.push(`NPC关系：${rel}`);
    const quests = Object.entries(s.quests).map(([id, q]) => `${id}(${q.status}@${q.stage || ""})`).join(", ") || "无";
    lines.push(`任务：${quests}`);
    const flags = Object.entries(s.flags).map(([k, v]) => `${k}=${v}`).join(", ") || "无";
    lines.push(`标记：${flags}`);
    return lines.join("\n");
  }

  toDict() {
    return {
      time: { ...this.state.time },
      location: this.state.location,
      inventory: { ...this.state.inventory },
      relationships: { ...this.state.relationships },
      quests: JSON.parse(JSON.stringify(this.state.quests)),
      flags: JSON.parse(JSON.stringify(this.state.flags)),
      eventLog: this.state.eventLog.slice(-200),
      knownLocations: [...this._knownLocations],
      knownNpcs: [...this._knownNpcs],
    };
  }

  static fromDict(data) {
    const sm = new StateManager();
    if (!data) return sm;
    const s = sm.state;
    if (data.time) { s.time.day = data.time.day || 1; s.time.hour = data.time.hour || 0; s.time.minute = data.time.minute || 0; }
    s.location = data.location || "起点";
    s.inventory = data.inventory || {};
    s.relationships = data.relationships || {};
    s.quests = data.quests || {};
    s.flags = data.flags || {};
    s.eventLog = Array.isArray(data.eventLog) ? data.eventLog : [];
    if (Array.isArray(data.knownLocations)) data.knownLocations.forEach(loc => sm._knownLocations.add(loc));
    if (Array.isArray(data.knownNpcs)) data.knownNpcs.forEach(npc => sm._knownNpcs.add(npc));
    return sm;
  }

  reset(state) { this.state = state || new StateManager().state; this.state.eventLog = []; }

  _advanceClock(minutes) {
    if (minutes <= 0) return;
    let total = this.state.time.minute + minutes;
    this.state.time.minute = total % 60;
    let hours = this.state.time.hour + Math.floor(total / 60);
    this.state.time.hour = hours % 24;
    this.state.time.day += Math.floor(hours / 24);
  }

  _validateOnly(event) {
    const params = event.params || {};
    switch (event.type) {
      case "move": {
        const loc = params.location;
        if (!loc || typeof loc !== "string" || loc.trim() === "") return { accepted: false, reason: "location 必须是非空字符串" };
        return { accepted: true };
      }
      case "add_item": {
        if (!params.item || typeof params.item !== "string" || params.item.trim() === "") return { accepted: false, reason: "item 必须是非空字符串" };
        return { accepted: true };
      }
      case "remove_item": {
        if (!params.item || typeof params.item !== "string") return { accepted: false, reason: "item 必须是非空字符串" };
        const qty = params.quantity || 1;
        if (typeof qty !== "number" || qty <= 0) return { accepted: false, reason: "quantity 必须为正数" };
        if ((this.state.inventory[params.item] || 0) < qty) return { accepted: false, reason: `物品 "${params.item}" 库存不足` };
        return { accepted: true };
      }
      case "set_relationship": {
        if (!params.npc || typeof params.npc !== "string") return { accepted: false, reason: "npc 必须是非空字符串" };
        if (typeof params.value !== "number" || params.value < -100 || params.value > 100) return { accepted: false, reason: "value 必须在 -100 到 100 之间" };
        return { accepted: true };
      }
      case "modify_relationship": {
        if (!params.npc || typeof params.npc !== "string") return { accepted: false, reason: "npc 必须是非空字符串" };
        if (typeof params.delta !== "number") return { accepted: false, reason: "delta 必须是数字" };
        return { accepted: true };
      }
      case "advance_quest": {
        if (!params.quest_id || typeof params.quest_id !== "string") return { accepted: false, reason: "quest_id 必须是非空字符串" };
        if (!params.stage || typeof params.stage !== "string") return { accepted: false, reason: "stage 必须是非空字符串" };
        const q = this.state.quests[params.quest_id];
        if (!q) return { accepted: false, reason: `任务 "${params.quest_id}" 不存在` };
        if (q.status !== "active") return { accepted: false, reason: `任务 "${params.quest_id}" 状态为 ${q.status}，无法推进` };
        return { accepted: true };
      }
      case "complete_quest": {
        if (!params.quest_id || typeof params.quest_id !== "string") return { accepted: false, reason: "quest_id 必须是非空字符串" };
        const outcome = params.outcome || "success";
        if (outcome !== "success" && outcome !== "failure") return { accepted: false, reason: "outcome 必须是 success 或 failure" };
        const q = this.state.quests[params.quest_id];
        if (!q) return { accepted: false, reason: `任务 "${params.quest_id}" 不存在` };
        if (q.status !== "active") return { accepted: false, reason: `任务 "${params.quest_id}" 状态为 ${q.status}，无法完成` };
        return { accepted: true };
      }
      case "start_quest": {
        if (!params.quest_id || typeof params.quest_id !== "string") return { accepted: false, reason: "quest_id 必须是非空字符串" };
        const existing = this.state.quests[params.quest_id];
        if (existing && existing.status === "active") return { accepted: false, reason: `任务 "${params.quest_id}" 已在进行中` };
        return { accepted: true };
      }
      case "set_flag": {
        if (!params.flag || typeof params.flag !== "string" || params.flag.trim() === "") return { accepted: false, reason: "flag 必须是非空字符串" };
        return { accepted: true };
      }
      case "pass_time": return { accepted: true };
      default: return { accepted: false, reason: `不支持的事件类型：${event.type}` };
    }
  }

  _applyState(event) {
    const params = event.params || {};
    switch (event.type) {
      case "move": this.state.location = params.location; break;
      case "add_item": { const item = params.item; this.state.inventory[item] = (this.state.inventory[item] || 0) + (params.quantity || 1); break; }
      case "remove_item": { const item = params.item; this.state.inventory[item] = (this.state.inventory[item] || 0) - (params.quantity || 1); if (this.state.inventory[item] <= 0) delete this.state.inventory[item]; break; }
      case "set_relationship": this.state.relationships[params.npc] = params.value; break;
      case "modify_relationship": { const npc = params.npc; const current = this.state.relationships[npc] || 0; this.state.relationships[npc] = Math.max(-100, Math.min(100, current + params.delta)); break; }
      case "advance_quest": { const q = this.state.quests[params.quest_id]; if (q) q.stage = params.stage; break; }
      case "complete_quest": { const q = this.state.quests[params.quest_id]; if (q) { const oc = params.outcome || "success"; q.status = oc === "failure" ? "failed" : "completed"; q.outcome = oc; } break; }
      case "start_quest": this.state.quests[params.quest_id] = { status: "active", stage: "start" }; break;
      case "set_flag": this.state.flags[params.flag] = params.value; break;
      case "pass_time": {
        let minutes = 0;
        if (typeof params.amount === "number" && params.amount > 0) {
          const unit = ["minutes", "hours", "days"].includes(params.unit) ? params.unit : "minutes";
          minutes = params.amount;
          if (unit === "hours") minutes *= 60; else if (unit === "days") minutes *= 1440;
        } else if (typeof params.minutes === "number" && params.minutes > 0) {
          minutes = params.minutes;
        } else if (typeof params.duration === "number" && params.duration > 0) {
          minutes = params.duration;
        } else if (typeof params.hours === "number" && params.hours > 0) {
          minutes = params.hours * 60;
        }
        if (minutes > 0) this._advanceClock(minutes);
        break;
      }
    }
  }

  _processOne(event) {
    const timestamp = { ...this.state.time };
    const validation = this._validateOnly(event);
    if (!validation.accepted) {
      const record = { timestamp, type: event.type, params: event.params || {}, accepted: false, reason: validation.reason };
      this.state.eventLog.push(record);
      return record;
    }
    this._applyState(event);
    const record = { timestamp, type: event.type, params: event.params || {}, accepted: true };
    this.state.eventLog.push(record);
    return record;
  }

  _log(type, params, accepted, reason) {
    this.state.eventLog.push({ timestamp: { ...this.state.time }, type, params, accepted, reason: reason || "" });
  }
}

// =============================================================================
// SummaryStore
// =============================================================================

class SummaryStore {
  constructor() { this._entries = []; }

  getCurrentSummary() { return this._entries.join("\n"); }
  getAllSummaries() { return this._entries.length > 0 ? this._entries.join("\n") : "（尚无故事摘要）"; }
  getEntryCount() { return this._entries.length; }

  appendEntries(newEntries) {
    for (const entry of newEntries) {
      this._entries.push(entry);
    }
    return { addedCount: newEntries.length };
  }

  reset(state = null) {
    if (state && state._entries) {
      this._entries = [...state._entries];
    } else {
      this._entries = [];
    }
  }

  toDict() { return { entries: this._entries }; }

  static fromDict(data) {
    const store = new SummaryStore();
    if (!data) return store;
    if (Array.isArray(data.entries)) {
      store._entries = data.entries;
    } else if (typeof data.summary === "string" && data.summary.length > 0) {
      store._entries = data.summary.split("\n");
    }
    return store;
  }
}

// =============================================================================
// FileManager
// =============================================================================

const STORAGE_PREFIX = "na:";

class FileManager {
  constructor(conversationId) { this.basePath = `conversations/${conversationId}`; }

  async save(turnId, category, data) {
    const dir = `${this.basePath}/${category}`;
    const ext = (category === "narratives" || category === "summaries") ? ".txt" : ".json";
    const filename = `${turnId}${ext}`;
    const content = ext === ".txt" ? String(data) : JSON.stringify(data, null, 2);
    this._ensureCapacity(content.length);
    const key = `${STORAGE_PREFIX}${dir}/${filename}`;
    try {
      localStorage.setItem(key, content);
    } catch (err) {
      if (err instanceof DOMException && err.name === "QuotaExceededError") {
        console.warn("[FileManager] localStorage quota exceeded, pruning...");
        this._pruneOldest(50);
        localStorage.setItem(key, content);
      } else { throw err; }
    }
  }

  async load(turnId, category) {
    const dir = `${this.basePath}/${category}`;
    const ext = (category === "narratives" || category === "summaries") ? ".txt" : ".json";
    const key = `${STORAGE_PREFIX}${dir}/${turnId}${ext}`;
    const content = localStorage.getItem(key);
    if (!content) return null;
    return ext === ".txt" ? content : JSON.parse(content);
  }

  saveCheckpoint(turnId, stateDict, summaryDict, mvuData = null) {
    const key = `${STORAGE_PREFIX}${this.basePath}/checkpoints/${turnId}.json`;
    const data = JSON.stringify({ state: stateDict, summary: summaryDict, mvuData });
    try {
      localStorage.setItem(key, data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "QuotaExceededError") {
        console.warn("[FileManager] localStorage quota exceeded, pruning...");
        this._pruneOldest(50);
        localStorage.setItem(key, data);
      } else { throw err; }
    }
  }

  loadCheckpoint(turnId) {
    const key = `${STORAGE_PREFIX}${this.basePath}/checkpoints/${turnId}.json`;
    const content = localStorage.getItem(key);
    if (!content) return null;
    try { return JSON.parse(content); } catch { return null; }
  }

  deleteCheckpointsFrom(fromTurnId) {
    const prefix = `${STORAGE_PREFIX}${this.basePath}/checkpoints/`;
    const fromNum = parseInt(String(fromTurnId).replace("turn_", ""), 10);
    if (isNaN(fromNum)) return;
    const keysToDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const filename = key.replace(prefix, "").replace(".json", "");
      const num = parseInt(filename.replace("turn_", ""), 10);
      if (!isNaN(num) && num >= fromNum) keysToDelete.push(key);
    }
    for (const key of keysToDelete) localStorage.removeItem(key);
  }

  deleteTurnFiles(turnId) {
    const cats = ["plans", "narratives", "events", "state"];
    for (const cat of cats) {
      const ext = (cat === "narratives") ? ".txt" : ".json";
      const key = `${STORAGE_PREFIX}${this.basePath}/${cat}/${turnId}${ext}`;
      localStorage.removeItem(key);
    }
  }

  async exportConversation() {
    const data = {};
    const cats = ["plans", "narratives", "events", "summaries", "state"];
    for (const cat of cats) {
      data[cat] = {};
      const prefix = `${STORAGE_PREFIX}${this.basePath}/${cat}/`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) {
          const filename = key.replace(prefix, "");
          const content = localStorage.getItem(key);
          data[cat][filename] = filename.endsWith(".txt") ? content : JSON.parse(content || "null");
        }
      }
    }
    return data;
  }

  _pruneOldest(count) {
    const prefix = `${STORAGE_PREFIX}${this.basePath}/`;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    const catPriority = { summaries: 0, state: 1, plans: 2, events: 3, narratives: 4 };
    keys.sort((a, b) => {
      const catA = a.replace(prefix, "").split("/")[0] || "";
      const catB = b.replace(prefix, "").split("/")[0] || "";
      return (catPriority[catB] ?? 9) - (catPriority[catA] ?? 9);
    });
    for (let i = 0; i < Math.min(count, keys.length); i++) localStorage.removeItem(keys[i]);
  }

  _ensureCapacity(neededBytes) {
    let used = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) used += (localStorage.getItem(k) || "").length * 2;
    }
    if (used + neededBytes * 2 > 4 * 1024 * 1024) {
      console.warn(`[FileManager] localStorage near capacity: ~${(used / 1024 / 1024).toFixed(1)}MB used`);
    }
  }
}

function getConversationId() {
  try { const ctx = getSTContext(); return ctx?.chatId || ctx?.characterId || "default"; } catch { return "default"; }
}

// =============================================================================
// CharacterReader
// =============================================================================

class CharacterReader {
  constructor() { this._cache = null; this._cacheId = null; this._fullCache = null; this._fullCacheId = null; }

  _getCard() {
    const ctx = getSTContext();
    if (!ctx) return null;
    const id = ctx.characterId;
    if (this._cacheId === id && this._cache) return this._cache;
    this._cacheId = id;
    this._cache = ctx.characters?.[id];
    return this._cache;
  }

  async _getFullCard() {
    const ctx = getSTContext();
    if (!ctx) return null;
    const id = ctx.characterId;
    if (id == null) return null;
    if (this._fullCacheId === id && this._fullCache) return this._fullCache;
    const card = ctx.characters?.[id];
    if (!card) return null;
    if (card.shallow && typeof ctx.getOneCharacter === "function") {
      try {
        const fullCard = await ctx.getOneCharacter(card.avatar);
        if (fullCard) {
          this._fullCache = fullCard;
          this._fullCacheId = id;
          return fullCard;
        }
      } catch (e) { console.warn("[NA] getOneCharacter failed:", e); }
    }
    if (typeof ctx.getCharacterCardFields === "function") {
      try {
        const fields = ctx.getCharacterCardFields({ chid: id });
        if (fields) {
          const merged = { ...card };
          if (fields.description) merged.description = fields.description;
          if (fields.personality) merged.personality = fields.personality;
          if (fields.scenario) merged.scenario = fields.scenario;
          if (fields.mesExamples) merged.mes_example = fields.mesExamples;
          if (fields.system) merged.data = { ...merged.data, system_prompt: fields.system };
          if (fields.jailbreak) merged.data = { ...merged.data, post_history_instructions: fields.jailbreak };
          if (fields.creatorNotes) merged.data = { ...merged.data, creator_notes: fields.creatorNotes };
          this._fullCache = merged;
          this._fullCacheId = id;
          return merged;
        }
      } catch (e) { console.warn("[NA] getCharacterCardFields failed:", e); }
    }
    this._fullCache = card;
    this._fullCacheId = id;
    return card;
  }

  getSummary() {
    const card = this._getCard();
    if (!card) return { name: "角色", personality: "", keySetting: "", scenario: "" };
    const data = card.data || {};
    const get = (field) => data[field] || card[field] || "";
    return {
      name: get("name") || "角色",
      personality: get("personality"),
      keySetting: truncate(get("description"), 500),
      scenario: get("scenario"),
    };
  }

  getCoreInfo() {
    const card = this._getCard();
    if (!card) return { name: "角色", personality: "", description: "", systemPrompt: "", postHistoryInstructions: "" };
    const data = card.data || {};
    const get = (field) => data[field] || card[field] || "";
    return {
      name: get("name") || "角色",
      personality: get("personality"),
      description: get("description"),
      systemPrompt: get("system_prompt"),
      postHistoryInstructions: get("post_history_instructions"),
    };
  }

  async getFullInfo() {
    const card = await this._getFullCard();
    if (!card) return "";
    const data = card.data || {};
    const get = (field) => data[field] || card[field] || "";
    const parts = [];
    const name = data.name || card.name || "";
    if (name) parts.push(`【名称】${name}`);
    if (get("description")) parts.push(`【描述】\n${get("description")}`);
    if (get("personality")) parts.push(`【性格】\n${get("personality")}`);
    if (get("scenario")) parts.push(`【场景】\n${get("scenario")}`);
    if (get("first_mes")) parts.push(`【开场白】\n${get("first_mes")}`);
    if (get("mes_example")) parts.push(`【对话示例】\n${get("mes_example")}`);
    if (get("system_prompt")) parts.push(`【系统提示词】\n${get("system_prompt")}`);
    if (get("post_history_instructions")) parts.push(`【历史后指令】\n${get("post_history_instructions")}`);
    if (get("creator_notes")) parts.push(`【作者备注】\n${get("creator_notes")}`);
    const tags = data.tags || card.tags;
    if (tags && tags.length > 0) parts.push(`【标签】${tags.join(", ")}`);
    return parts.join("\n\n");
  }

  getName() {
    const card = this._getCard();
    const data = card?.data || card || {};
    return data.name || card?.name || "角色";
  }
}

// =============================================================================
// UserPersonaReader
// =============================================================================

class UserPersonaReader {
  constructor() { this._cache = null; this._cacheKey = null; }

  _getKey() {
    const ctx = getSTContext();
    if (!ctx?.powerUserSettings) return null;
    const pu = ctx.powerUserSettings;
    return pu.persona_description + "|" + (pu.personas ? Object.keys(pu.personas).length : 0);
  }

  getPersonaInfo() {
    const key = this._getKey();
    if (key === this._cacheKey && this._cache) return this._cache;
    this._cacheKey = key;

    const ctx = getSTContext();
    if (!ctx?.powerUserSettings) {
      console.warn("[NA] UserPersonaReader: powerUserSettings 不可用");
      this._cache = "";
      return "";
    }

    const pu = ctx.powerUserSettings;
    const parts = [];

    const name = ctx.name1;
    if (name) parts.push(`【用户名】${name}`);

    let desc = pu.persona_description || "";
    if (!desc) {
      const avatarId = this._getCurrentAvatarId(pu);
      if (avatarId && pu.persona_descriptions?.[avatarId]?.description) {
        desc = pu.persona_descriptions[avatarId].description;
      }
    }
    if (desc && typeof ctx.substituteParams === "function") {
      desc = ctx.substituteParams(desc);
    }
    if (desc) parts.push(`【用户设定】\n${desc}`);

    this._cache = parts.join("\n\n");
    return this._cache;
  }

  _getCurrentAvatarId(pu) {
    try {
      const block = document.querySelector("#user_avatar_block");
      const selected = block?.querySelector(".avatar-container.selected") || block?.querySelector("[data-avatar-id]");
      return selected?.getAttribute("data-avatar-id") || pu.default_persona || null;
    } catch { return pu.default_persona || null; }
  }
}

// =============================================================================
// WorldInfoResolver
// =============================================================================

class WorldInfoResolver {
  constructor(stateManager, worldbookSource) {
    this.stateManager = stateManager;
    this.worldbookSource = worldbookSource || "auto";
    this._entriesCache = null;
    this._entriesCacheKey = null;
    this._formattingContentSet = null;
  }

  async _getAll() {
    try {
      const ctx = getSTContext();
      if (!ctx) return [];

      if (this.worldbookSource === "card") {
        return this._getAllFromCard(ctx);
      }
      if (this.worldbookSource === "world") {
        return this._getAllFromWorld(ctx);
      }

      const cardEntries = this._getAllFromCard(ctx);
      if (cardEntries.length > 0) return cardEntries;
      return this._getAllFromWorld(ctx);
    } catch (e) { console.error("[NA] _getAll error:", e); return []; }
  }

  _getAllFromCard(ctx) {
    try {
      const card = ctx.characters?.[ctx.characterId];
      const charBook = card?.data?.character_book;
      if (!charBook?.entries) return [];
      const cacheKey = `card:${ctx.characterId}`;
      if (this._entriesCacheKey === cacheKey && this._entriesCache !== null) return this._entriesCache;
      const entries = Object.values(charBook.entries);
      this._entriesCache = entries;
      this._entriesCacheKey = cacheKey;
      console.log("[NA] WorldInfo loaded from card:", entries.length, "entries");
      return entries;
    } catch (e) { console.error("[NA] _getAllFromCard error:", e); return []; }
  }

  async _getAllFromWorld(ctx) {
    try {
      const worldName = this._getWorldName();
      if (!worldName) return [];
      if (this._entriesCacheKey === worldName && this._entriesCache !== null) return this._entriesCache;
      if (typeof ctx.loadWorldInfo !== "function") return [];
      const data = await ctx.loadWorldInfo(worldName);
      if (!data?.entries) { this._entriesCache = []; this._entriesCacheKey = worldName; return []; }
      this._entriesCache = Object.values(data.entries);
      this._entriesCacheKey = worldName;
      console.log("[NA] WorldInfo loaded:", worldName, this._entriesCache.length, "entries");
      return this._entriesCache;
    } catch (e) { console.error("[NA] _getAllFromWorld error:", e); return []; }
  }

  _isEnabled(e) { return !e.disable; }

  async getSummary() {
    const entries = await this._getAll();
    return entries
      .filter(e => this._isEnabled(e))
      .map(e => `- ${e.comment || e.key?.[0] || "未命名"}: ${truncate(e.content, 80)}`)
      .join("\n");
  }

  async getActiveEntries() {
    const entries = await this._getAll();
    const recentText = this._getRecentChatText(2);
    return entries
      .filter(e => {
        if (!this._isEnabled(e)) return false;
        if (e.constant) return true;
        return this._matchesKeys(e, recentText);
      })
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(e => e.content)
      .join("\n\n");
  }

  async getActiveRules() {
    const entries = await this._getAll();
    const recentText = this._getRecentChatText(2);
    return entries
      .filter(e => this._isEnabled(e) && this._isRule(e) && (e.constant || this._matchesKeys(e, recentText)))
      .map(e => e.content);
  }

  async getFullContent() {
    const entries = await this._getAll();
    const active = entries
      .filter(e => this._isEnabled(e) && !this._isFormattingEntry(e))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    if (active.length === 0) return "";
    return active.map(e => {
      const label = e.comment || e.key?.[0] || "未命名";
      return `--- ${label} ---\n${e.content}`;
    }).join("\n\n");
  }

  async getWorldContentForAgents() {
    const entries = await this._getAll();
    const active = entries
      .filter(e => this._isEnabled(e) && !this._isFormattingEntry(e))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    if (active.length === 0) return "";
    return active.map(e => {
      const label = e.comment || e.key?.[0] || "未命名";
      return `--- ${label} ---\n${e.content}`;
    }).join("\n\n");
  }

  async syncToStateManager() {
    const entries = await this._getAll();
    for (const entry of entries) {
      if (!entry.enabled) continue;
      if (this._isQuest(entry)) {
        const questId = entry.key?.[0];
        if (questId && !this.stateManager.state.quests[questId]) {
          this.stateManager.state.quests[questId] = { status: "active", stage: "未开始" };
        }
      }
    }
    const ctx = await this.getKnownContext();
    for (const loc of ctx.locations) this.stateManager.addKnownLocation(loc);
    for (const npc of ctx.npcs) this.stateManager.addKnownNpc(npc);
  }

  async getKnownContext() {
    const entries = await this._getAll();
    const locations = [];
    const npcs = [];
    for (const entry of entries) {
      if (!entry.enabled) continue;
      if ((entry.comment || "").startsWith("[LOCATION]") && entry.key?.[0]) locations.push(entry.key[0]);
      if ((entry.comment || "").startsWith("[NPC]") && entry.key?.[0]) npcs.push(entry.key[0]);
    }
    return {
      locations,
      npcs,
      items: Object.keys(this.stateManager.state.inventory),
      quests: Object.keys(this.stateManager.state.quests),
    };
  }

  _isQuest(e) { return (e.comment || "").startsWith("[QUEST]"); }
  _isRule(e) { return (e.comment || "").startsWith("[RULE]"); }
  _isMvuUpdate(e) { return (e.comment || "").startsWith("[mvu_update]"); }
  _isInitVar(e) { return (e.comment || "").startsWith("[initvar]"); }
  _isTool(e) { return (e.comment || "").startsWith("[TOOL:") || this._isToolLikeContent(e); }
  _isFormattingEntry(e) {
    const c = e.comment || "";
    if (c.startsWith("[TOOL:") || c.startsWith("[UI]") || c.startsWith("[initvar]") || c.startsWith("[mvu_update]")) {
      return true;
    }
    if (e.content && typeof e.content === "string" && _isToolEntryContent(e.content)) {
      return true;
    }
    return false;
  }

  _isToolLikeContent(e) {
    const content = e.content;
    if (!content || typeof content !== "string") return false;
    return _isToolEntryContent(content);
  }

  async buildFormattingSet() {
    const entries = await this._getAll();
    this._formattingContentSet = new Set();
    for (const e of entries) {
      if (this._isFormattingEntry(e) && e.content && e.content.trim()) {
        this._formattingContentSet.add(e.content.trim());
      }
    }
    console.log("[NA] Formatting content set built:", this._formattingContentSet.size, "entries");
  }

  getFormattingSet() {
    if (this._formattingContentSet !== null) return this._formattingContentSet;
    this._trySyncBuildFormattingSet();
    return this._formattingContentSet || new Set();
  }

  _trySyncBuildFormattingSet() {
    try {
      const ctx = getSTContext();
      if (ctx) {
        const card = ctx.characters?.[ctx.characterId];
        const charBook = card?.data?.character_book;
        if (charBook?.entries) {
          const entries = Object.values(charBook.entries);
          this._formattingContentSet = new Set();
          for (const e of entries) {
            if (this._isFormattingEntry(e) && e.content && e.content.trim()) {
              this._formattingContentSet.add(e.content.trim());
            }
          }
          console.log("[NA] Formatting content set lazy-built (sync from charBook):", this._formattingContentSet.size, "entries");
          return;
        }
      }
      this._tryBuildFromCache();
    } catch (e) {
      console.warn("[NA] _trySyncBuildFormattingSet failed:", e.message);
    }
  }

  _tryBuildFromCache() {
    if (!this._entriesCache || this._entriesCache.length === 0) return;
    this._formattingContentSet = new Set();
    for (const e of this._entriesCache) {
      if (this._isFormattingEntry(e) && e.content && e.content.trim()) {
        this._formattingContentSet.add(e.content.trim());
      }
    }
    console.log("[NA] Formatting content set built from entriesCache:", this._formattingContentSet.size, "entries");
  }

  async refreshFormattingSet() {
    this._formattingContentSet = null;
    await this.buildFormattingSet();
  }

  _parseToolEntry(entry) {
    const comment = entry.comment || "";
    const match = comment.match(/^\[TOOL:(\w+)\]/);
    if (!match) return null;
    const funcName = match[1];
    try {
      const rawContent = entry.content || "{}";
      const parsed = JSON.parse(rawContent);
      if (!parsed.type || !parsed.function || !parsed.function.name) {
        console.warn(`[NA] [TOOL:${funcName}] 条目解析失败: 缺少必需字段 type/function/function.name, parsed=`, JSON.stringify(parsed).substring(0, 200));
        return null;
      }
      const prompt = parsed.system_prompt || parsed.user_persona || "";
      if (parsed.user_persona && !parsed.system_prompt) {
        console.warn(`[NA] [TOOL:${funcName}] 检测到 user_persona 字段，已自动映射为 system_prompt。建议改为 system_prompt 以匹配规范。`);
      }
      const isCustomCode = parsed.type === "code" && parsed.function.name !== "roll_dice";
      let userCode = "";
      if (isCustomCode) {
        userCode = (parsed.code || "").trim();
        if (!userCode) {
          console.warn(`[NA] [TOOL:${funcName}] 自定义 code 工具缺少 code 字段`);
          return null;
        }
        if (!this._validateUserCode(userCode)) {
          return null;
        }
      }
      return {
        type: parsed.type,
        trigger: parsed.trigger || "planning",
        function: {
          name: parsed.function.name,
          description: parsed.function.description || "",
          parameters: parsed.function.parameters || { type: "object", properties: {}, required: [] },
        },
        context: parsed.context || [],
        system_prompt: prompt,
        userCode,
      };
    } catch (e) {
      console.warn(`[NA] [TOOL:${funcName}] 条目 content JSON 解析失败:`, e.message, "content preview:", (entry.content || "").substring(0, 200));
      return null;
    }
  }

  _validateUserCode(code) {
    try {
      new Function("params", "state", code);
      return true;
    } catch (e) {
      console.warn(`[NA] code 语法校验失败:`, e.message);
      console.warn(`[NA] 代码片段:`, code.substring(0, 200));
      return false;
    }
  }

  async getActiveTools() {
    const entries = await this._getAll();
    const recentText = this._getRecentChatText(2);
    const tools = [];
    const seenNames = new Set();

    let hasInitVar = false;
    let hasMvuUpdate = false;
    let toolEntriesTotal = 0;
    let toolEntriesParsed = 0;

    for (const entry of entries) {
      if (!this._isEnabled(entry)) continue;

      if (this._isInitVar(entry)) hasInitVar = true;
      if (this._isMvuUpdate(entry)) hasMvuUpdate = true;

      if (this._isTool(entry)) {
        toolEntriesTotal++;
        const comment = entry.comment || "";
        const constant = entry.constant;
        console.log(`[NA] toolEntry #${toolEntriesTotal}: comment="${comment}" constant=${constant} disable=${entry.disable}`);
        if (!entry.constant && !this._matchesKeys(entry, recentText)) {
          console.log(`[NA] toolEntry #${toolEntriesTotal}: SKIPPED (not constant and no key match)`);
          continue;
        }
        const tool = this._parseToolEntry(entry);
        if (!tool) {
          console.log(`[NA] toolEntry #${toolEntriesTotal}: SKIPPED (_parseToolEntry returned null)`);
          continue;
        }
        console.log(`[NA] toolEntry #${toolEntriesTotal}: PARSED as "${tool.function.name}" trigger=${tool.trigger}`);
        if (seenNames.has(tool.function.name)) {
          console.warn(`[NA] 工具 "${tool.function.name}" 重复注册，已跳过后续同名条目`);
          continue;
        }
        seenNames.add(tool.function.name);
        tools.push(tool);
        toolEntriesParsed++;
      }
    }

    console.log(`[NA] getActiveTools summary: ${toolEntriesTotal} tool entries found, ${toolEntriesParsed} parsed`);

    if ((hasInitVar || hasMvuUpdate) && typeof Mvu !== "undefined") {
      const mvuRules = entries
        .filter(e => this._isEnabled(e) && this._isMvuUpdate(e) && (e.constant || this._matchesKeys(e, recentText)))
        .map(e => e.content).join("\n\n");
      tools.push({
        type: "llm",
        trigger: "post_pipeline",
        function: {
          name: "mvu_extract",
          description: "从叙事文本中提取变量状态变更，输出 JSON Patch 格式",
          parameters: { type: "object", properties: {}, required: [] },
        },
        context: ["narrative_text", "state_summary"],
        system_prompt: `${SHARED_ANALYSIS_PREFIX}\n\n【任务：变量状态提取】\n从叙事文本中提取世界状态变更，输出 JSON Patch 格式。\n\n输出严格的 JSON 格式：\n{\n  "patches": [\n    { "op": "replace", "path": "/世界/当前地点", "value": "矿洞" },\n    { "op": "delta", "path": "/主角/信用点数", "value": -200 },\n    { "op": "insert", "path": "/主角/改件仓库/-", "value": "涡轮增压器V2" },\n    { "op": "remove", "path": "/主角/改件仓库/0" }\n  ]\n}\n\nJSON Patch 操作类型：\n- replace: 替换字段值，path 指向已有字段，value 为新值\n- delta: 数值增减，path 指向数值字段，value 为变化量（可为负）\n- insert: 创建新字段或向数组追加，path 指向新位置，value 为新值\n- remove: 删除字段，path 指向要删除的字段\n- move: 移动字段，from 为源路径，path 为目标路径\n\npath 使用 / 分隔的 JSON Pointer 路径，对应变量树中的层级。\n\n如果没有状态变更，输出：{ "patches": [] }\n\n补充规则：\n- 仅对「当前变量状态」中列出的已有路径执行操作，不要凭空创建新的一级分类\n${mvuRules ? "\n\n以下是变量更新规则，请严格遵循：\n" + mvuRules : ""}`,
      });
    }

    console.log("[NA] getActiveTools:", tools.length, "tools, planning:", tools.filter(t => t.trigger === "planning").length, "post_pipeline:", tools.filter(t => t.trigger === "post_pipeline").length);
    return tools;
  }

  async getInitVar() {
    const entries = await this._getAll();
    const initEntry = entries.find(e => this._isEnabled(e) && this._isInitVar(e));
    return initEntry ? initEntry.content : null;
  }

  _getWorldName() {
    try {
      const ctx = getSTContext();
      const card = ctx?.characters?.[ctx?.characterId];
      if (!card) return "";
      return card.data?.extensions?.world || card.extensions?.world || ctx.chatMetadata?.world_info || "";
    } catch { return ""; }
  }

  _matchesKeys(entry, text) {
    if (!entry.key || entry.key.length === 0) return false;
    const keys = Array.isArray(entry.key) ? entry.key : [entry.key];
    return keys.some(k => text.toLowerCase().includes(k.toLowerCase()));
  }

  _getRecentChatText(rounds) {
    try {
      const ctx = getSTContext();
      const chat = ctx?.chat || [];
      const msgs = [];
      for (let i = chat.length - 1; i >= 0 && msgs.length < rounds * 2; i--) msgs.unshift(chat[i].mes || "");
      return msgs.join(" ");
    } catch { return ""; }
  }

  async getConstantSystemEntries() {
    const entries = await this._getAll();
    return entries
      .filter(e => this._isEnabled(e) && !this._isFormattingEntry(e) && e.constant === true && e.position === 4 && e.role === 0)
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(e => e.content);
  }

  async getConstantBeforeCharEntries() {
    const entries = await this._getAll();
    return entries
      .filter(e => this._isEnabled(e) && !this._isFormattingEntry(e) && e.constant === true && e.position === 0)
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(e => e.content);
  }

  async getSelectiveActivatedEntries(chatText) {
    const entries = await this._getAll();
    return entries
      .filter(e => this._isEnabled(e) && !this._isFormattingEntry(e) && !e.constant && !e.vectorized && (e.key?.length > 0) && this._matchesKeys(e, chatText))
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(e => e.content);
  }
}

// =============================================================================
// LLM 客户端
// =============================================================================

let llmCallCount = 0;

async function callLLM(messages, options) {
  llmCallCount++;
  const label = (options && options.label) || `call_${llmCallCount}`;
  const maxRetries = (options && options.retries) || 1;

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) console.log(`[LLMClient] ${label} 重试 ${attempt}/${maxRetries}`);
      console.log(`[LLMClient] ${label} 调用, messages 数量:`, messages.length);
      const ctx = getSTContext();
      if (!ctx) throw new Error("SillyTavern context not available");
      const result = await ctx.generateRaw({ prompt: messages });
      const text = extractText(result);
      if (!text || (typeof text === "string" && text.trim().length === 0)) {
        throw new Error("[LLMClient] generateRaw 返回空内容，请求可能被取消或API错误");
      }
      console.log(`[LLMClient] ${label} 返回, 长度:`, text.length);
      return text;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) break;
    }
  }
  console.error(`[LLMClient] ${label} 失败:`, lastErr);
  throw lastErr || new Error(`[LLMClient] ${label} failed`);
}

function extractText(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    if (result.choices?.[0]?.message?.content) return result.choices[0].message.content;
    if (result.message?.content) return result.message.content;
  }
  return String(result || "");
}

function isRetryable(err) {
  const msg = (err && err.message) || "";
  if (msg.includes("fetch") || msg.includes("network") || msg.includes("ECONN")) return true;
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) return true;
  if (msg.includes("429") || msg.includes("rate")) return true;
  if (/\b5\d{2}\b/.test(msg)) return true;
  return false;
}

// =============================================================================
// 输出解析器
// =============================================================================

function parsePlanningOutput(rawText) {
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[NA] parsePlanningOutput: 未找到JSON, rawText前100字:", rawText?.substring(0, 100));
      return getDefaultPlan();
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      narrative_direction: parsed.narrative_direction || "",
      key_points: Array.isArray(parsed.key_points) ? parsed.key_points : [],
      tone: parsed.tone || "中",
      pacing: ["快", "中", "慢"].includes(parsed.pacing) ? parsed.pacing : "中",
      continuity_notes: Array.isArray(parsed.continuity_notes) ? parsed.continuity_notes : [],
      tool_calls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [],
    };
  } catch (e) {
    console.warn("[NA] parsePlanningOutput: JSON解析失败,", e.message, "rawText前100字:", rawText?.substring(0, 100));
    return getDefaultPlan();
  }
}

function getDefaultPlan() {
  return { narrative_direction: "", key_points: [], tone: "中", pacing: "中", continuity_notes: [], tool_calls: [] };
}

function parseExtractionOutput(rawText) {
  if (!rawText || typeof rawText !== "string") return { events: [] };
  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { events: [] };
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { events: [] };
    if (!Array.isArray(parsed.events)) return { events: [] };
    return { events: parsed.events.filter(ev => ev && typeof ev === "object" && typeof ev.type === "string") };
  } catch { return { events: [] }; }
}

// =============================================================================
// Agent: 规划
// =============================================================================

const PLANNING_SYSTEM_SUFFIX = `你是叙事规划引擎。根据全局信息生成本轮的写作指导，并在需要时声明工具调用。

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

规则：
- 只输出 JSON，不输出其他文字
- narrative_direction 和 key_points 必须足够详细，使写作引擎可以直接据此展开叙事而无需自行补充关键信息
- scene_setting 应明确时间和地点，不可省略
- key_points 要按叙事顺序排列，每个要点包含具体可写的内容
- continuity_notes 必须引用具体的人名、物件或事件
- 如果用户输入是日常行为，key_points 可以为空`;

const WRITING_SYSTEM_SUFFIX = `你是叙事写作引擎。根据写作指导和上下文续写故事。

规则：
- 只输出叙事正文，不输出任何元数据、指令或标注
- 保持行文风格与最近叙事一致
- 单次输出 200-400 字
- 不要重复已有内容
- 严格遵守世界设定中的限制
- 自然地融入写作指导中的要点`;

const MERGED_WRITING_SYSTEM_SUFFIX = `你是叙事引擎。根据上下文直接续写故事。

输入包含：
- 角色和世界设定
- 故事进展摘要
- 用户角色设定
- 最近叙事片段
- 当前游戏状态
- 玩家最新输入

规则：
- 直接输出叙事正文，不输出任何元数据、指令或标注
- 保持行文风格与最近叙事一致
- 综合考虑故事进展节奏和角色状态，确保叙事连贯合理
- 注意场景转换的平滑性和时间流逝的自然感
- 不要重复已有内容
- 严格遵守世界设定中的限制`;

// =============================================================================
// 掷骰工具
// =============================================================================

const MAX_EXPLODING_DEPTH = 10;

function rollSingleDie(sides) {
  return Math.floor(Math.random() * sides) + 1;
}

function rollDice(expression, mode) {
  mode = mode || "normal";
  const match = expression.match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!match) return { expression, total: 0, rolls: [], mode, error: "无法解析骰子表达式" };

  const count = parseInt(match[1], 10);
  const sides = parseInt(match[2], 10);
  const modifier = match[3] ? parseInt(match[3], 10) : 0;

  if (mode === "advantage" || mode === "disadvantage") {
    const set1 = [];
    const set2 = [];
    for (let i = 0; i < count; i++) {
      set1.push(rollSingleDie(sides));
      set2.push(rollSingleDie(sides));
    }
    const sum1 = set1.reduce((a, b) => a + b, 0);
    const sum2 = set2.reduce((a, b) => a + b, 0);
    const takeHigher = mode === "advantage";
    const chosenSet = takeHigher ? (sum1 >= sum2 ? set1 : set2) : (sum1 <= sum2 ? set1 : set2);
    const chosenSum = takeHigher ? Math.max(sum1, sum2) : Math.min(sum1, sum2);
    const total = chosenSum + modifier;

    return {
      expression, total, rolls: chosenSet, modifier, mode,
      allRolls: [set1, set2],
      allSums: [sum1, sum2],
      chosenIndex: (takeHigher ? (sum1 >= sum2 ? 0 : 1) : (sum1 <= sum2 ? 0 : 1)),
    };
  }

  if (mode === "exploding") {
    const rolls = [];
    const explosions = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      let roll = rollSingleDie(sides);
      rolls.push(roll);
      total += roll;
      let depth = 0;
      while (roll === sides && depth < MAX_EXPLODING_DEPTH) {
        roll = rollSingleDie(sides);
        explosions.push(roll);
        total += roll;
        depth++;
      }
    }
    total += modifier;
    return { expression, total, rolls, modifier, mode, explosions };
  }

  const rolls = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const roll = rollSingleDie(sides);
    rolls.push(roll);
    total += roll;
  }
  total += modifier;

  return { expression, total, rolls, modifier, mode };
}

async function runPlanningAgent(ctx) {
  const recentText = ctx.recentTurns
    .map((t) => `[轮${t.turnNum}] 用户: ${t.user}\n[轮${t.turnNum}] AI: ${t.assistant}`)
    .join("\n\n");

  let systemContent = "";

  if (ctx.presetContext) {
    systemContent += ctx.presetContext;
  }

  if (ctx.systemEntries && ctx.systemEntries.length > 0) {
    if (systemContent) systemContent += "\n\n";
    systemContent += "<worldinfo1>\n" + ctx.systemEntries.join("\n\n") + "\n</worldinfo1>";
  }

  if (systemContent) systemContent += "\n\n";
  systemContent += PLANNING_SYSTEM_SUFFIX;

  if (ctx.toolListText) {
    systemContent += "\n\n" + ctx.toolListText;
  }

  let userContent = "";
  if (ctx.beforeCharEntries && ctx.beforeCharEntries.length > 0) {
    userContent += "<worldinfo2>\n" + ctx.beforeCharEntries.join("\n\n") + "\n</worldinfo2>\n\n";
  }
  userContent += `<story_summary>\n${ctx.storySummaries}\n</story_summary>`;
  if (ctx.userPersona) {
    userContent += `\n\n<user_persona>\n${ctx.userPersona}\n</user_persona>`;
  }
  userContent += `\n\n<recent_turns>\n${recentText}\n</recent_turns>`;
  if (ctx.selectiveEntries && ctx.selectiveEntries.length > 0) {
    userContent += "\n\n<worldinfo3>\n" + ctx.selectiveEntries.join("\n\n") + "\n</worldinfo3>";
  }
  userContent += `\n\n<state_summary>\n${ctx.stateSummary}\n</state_summary>`;
  userContent += `\n\n<user_input>\n${ctx.userInput}\n</user_input>`;
  userContent += "\n\n请生成写作指导。";

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  return parsePlanningOutput(await callLLM(messages, { label: "planning" }));
}

// =============================================================================
// Agent: 正文写作
// =============================================================================

async function runWritingAgent(ctx) {
  const guide = ctx.writingGuide;
  const hasToolResults = ctx.toolResultsText && ctx.toolResultsText.length > 0;

  let systemContent = "";

  if (ctx.writingSystemPreset) {
    systemContent += ctx.writingSystemPreset;
  }

  if (ctx.systemEntries && ctx.systemEntries.length > 0) {
    if (systemContent) systemContent += "\n\n";
    systemContent += "<worldinfo1>\n" + ctx.systemEntries.join("\n\n") + "\n</worldinfo1>";
  }

  if (systemContent) systemContent += "\n\n";
  systemContent += WRITING_SYSTEM_SUFFIX;

  if (hasToolResults) {
    systemContent += "\n- 工具执行结果已由系统确定，必须严格按照结果中的走向来写作，不得自行改变工具执行结果";
  }

  const recentText = ctx.recentNarratives
    .map((t) => `[轮${t.turnNum}] 用户: ${t.user}\n[轮${t.turnNum}] AI: ${t.assistant}`)
    .join("\n\n");

  let userContent = "";

  if (ctx.writingUserPreset) {
    userContent += "<user_preset>\n" + ctx.writingUserPreset + "\n</user_preset>";
  }

  if (ctx.beforeCharEntries && ctx.beforeCharEntries.length > 0) {
    if (userContent) userContent += "\n\n";
    userContent += "<worldinfo2>\n" + ctx.beforeCharEntries.join("\n\n") + "\n</worldinfo2>";
  }

  if (ctx.userPersona) {
    if (userContent) userContent += "\n\n";
    userContent += `<user_persona>\n${ctx.userPersona}\n</user_persona>`;
  }

  if (userContent) userContent += "\n\n";
  userContent += `<recent_turns>\n${recentText}\n</recent_turns>`;

  if (ctx.selectiveEntries && ctx.selectiveEntries.length > 0) {
    userContent += "\n\n<worldinfo3>\n" + ctx.selectiveEntries.join("\n\n") + "\n</worldinfo3>";
  }

  let guideBlock = "<writing_guide>\n叙事方向：" + (guide.narrative_direction || "（无特定方向，延续当前叙事）");
  if (guide.scene_setting) {
    guideBlock += "\n场景设置：" + guide.scene_setting;
  }
  guideBlock += "\n要点：" + (guide.key_points.length > 0 ? guide.key_points.join("；") : "无特定要点");
  guideBlock += "\n基调：" + guide.tone + "，节奏：" + guide.pacing;
  guideBlock += "\n延续细节：" + (guide.continuity_notes.length > 0 ? guide.continuity_notes.join("；") : "无");
  guideBlock += "\n</writing_guide>";
  userContent += "\n\n" + guideBlock;

  if (hasToolResults) {
    userContent += "\n\n" + ctx.toolResultsText;
  }

  userContent += `\n\n<user_input>\n${ctx.userInput}\n</user_input>`;

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  const raw = await callLLM(messages, { label: "writing" });
  return raw.trim();
}

// =============================================================================
// Agent: 合并写作 (无工具时的规划+写作合并)
// =============================================================================

async function runMergedWritingAgent(ctx) {
  let systemContent = "";

  if (ctx.presetContext) {
    systemContent += ctx.presetContext;
  }

  if (ctx.systemEntries && ctx.systemEntries.length > 0) {
    if (systemContent) systemContent += "\n\n";
    systemContent += "<worldinfo1>\n" + ctx.systemEntries.join("\n\n") + "\n</worldinfo1>";
  }

  if (systemContent) systemContent += "\n\n";
  systemContent += MERGED_WRITING_SYSTEM_SUFFIX;

  const recentText = ctx.recentTurns
    .map((t) => `[轮${t.turnNum}] 用户: ${t.user}\n[轮${t.turnNum}] AI: ${t.assistant}`)
    .join("\n\n");

  let userContent = "";

  if (ctx.writingUserPreset) {
    userContent += "<user_preset>\n" + ctx.writingUserPreset + "\n</user_preset>";
  }

  if (ctx.beforeCharEntries && ctx.beforeCharEntries.length > 0) {
    if (userContent) userContent += "\n\n";
    userContent += "<worldinfo2>\n" + ctx.beforeCharEntries.join("\n\n") + "\n</worldinfo2>";
  }

  if (ctx.userPersona) {
    if (userContent) userContent += "\n\n";
    userContent += `<user_persona>\n${ctx.userPersona}\n</user_persona>`;
  }

  if (userContent) userContent += "\n\n";
  userContent += `<story_summary>\n${ctx.storySummaries}\n</story_summary>`;

  userContent += `\n\n<recent_turns>\n${recentText}\n</recent_turns>`;

  if (ctx.selectiveEntries && ctx.selectiveEntries.length > 0) {
    userContent += "\n\n<worldinfo3>\n" + ctx.selectiveEntries.join("\n\n") + "\n</worldinfo3>";
  }

  userContent += `\n\n<state_summary>\n${ctx.stateSummary}\n</state_summary>`;

  userContent += `\n\n<user_input>\n${ctx.userInput}\n</user_input>`;

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  const raw = await callLLM(messages, { label: "merged-writing" });
  return raw.trim();
}

// =============================================================================
// Agent: 合并分析 (事件提取 + 压缩)
// =============================================================================

const SHARED_ANALYSIS_PREFIX = `你是一个叙事分析助手。你的任务是从叙事文本中提取结构化信息，用于维护故事世界的状态记录。

核心原则：
- 只提取文本中明确描述或合理推断的信息
- 不要编造文本中完全没有依据的内容
- 时间流逝必须考虑：如果叙事中描述了耗时行为，应推断合理的时间流逝`;

const MERGED_ANALYSIS_SYSTEM = `${SHARED_ANALYSIS_PREFIX}

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
1. 用户意图：用一句话概括用户输入的核心意图
2. 叙事要点：保留影响后续理解的核心事实（关键事件、人物状态变化、线索、目标、悬念），去除修饰、日常寒暄、角色扮演动作描述。叙述应为对故事的精确浓缩，而非对角色扮演过程的描述，如应将用户作为故事中的角色描述，而不是直接称呼为用户。
3. 严格使用输入中标注的轮次编号，不要重新编号
4. 只输出条目，不要任何解释、前缀或后缀

最终输出严格的 JSON 格式：
{
  "events": [
    { "type": "move", "params": { "location": "矿洞" } }
  ],
  "summary_entries": [
    "[第3轮] 用户意图：探索矿洞 | 叙事要点：玩家进入矿洞，发现墙壁上有奇怪符文"
  ]
}

如果没有事件或摘要，对应字段为空数组。
只输出 JSON，不输出其他文字。`;

async function runMergedAnalysisAgent(ctx) {
  const turnLabel = ctx.turnId ? `第${parseInt(String(ctx.turnId).replace("turn_", ""), 10)}轮` : "本轮";
  const messages = [
    { role: "system", content: MERGED_ANALYSIS_SYSTEM },
    { role: "user", content: `<story_summary>\n${ctx.oldSummary}\n</story_summary>\n\n<state_summary>\n${ctx.currentStateSummary}\n</state_summary>\n\n<narrative_text>\n${ctx.currentDialogue}\n</narrative_text>\n\n请提取事件并生成摘要。` },
  ];

  const raw = await callLLM(messages, { label: "merged_analysis" });
  return parseMergedOutput(raw);
}

function parseMergedOutput(rawText) {
  const result = { events: [], summary_entries: [] };
  if (!rawText || typeof rawText !== "string") return result;

  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[NA] parseMergedOutput: 未找到JSON");
      return result;
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed.events)) {
      result.events = parsed.events.filter(ev => ev && typeof ev === "object" && typeof ev.type === "string");
    }
    if (Array.isArray(parsed.summary_entries)) {
      result.summary_entries = parsed.summary_entries.filter(s => typeof s === "string" && s.trim().length > 0);
    }
  } catch (e) {
    console.warn("[NA] parseMergedOutput: JSON解析失败", e.message);
  }
  return result;
}

// =============================================================================
// 工具执行器
// =============================================================================

function buildToolUserMessage(tool, availableContext) {
  const requested = tool.context || [];
  const ordered = CANONICAL_CONTEXT_ORDER.filter(key => requested.includes(key));

  const parts = [];
  for (const key of ordered) {
    const content = availableContext[key];
    if (content && content.trim()) {
      parts.push(`<${key}>\n${content}\n</${key}>`);
    }
  }

  if (parts.length === 0) {
    parts.push("（无可用上下文）");
  }

  parts.push(`请根据上述内容执行工具 ${tool.function.name}。`);

  return parts.join("\n\n");
}

class ToolExecutor {
  execute(toolDef, params, state) {
    if (toolDef.function.name === "roll_dice") {
      return this._executeRollDice(params);
    }
    if (toolDef.userCode) {
      return this._executeUserCode(toolDef, params, state);
    }
    throw new Error(`未注册的 code 工具: ${toolDef.function.name}`);
  }

  _executeRollDice(params) {
    const mode = params.mode || "normal";
    const expr = params.expr || "";
    const dc = params.dc != null ? params.dc : null;

    if (!expr) {
      return { tool: "roll_dice", success: false, error: "缺少骰子表达式" };
    }

    const rollResult = rollDice(expr, mode);
    const success = dc != null ? rollResult.total >= dc : null;

    let critical = null;
    if (mode !== "exploding" && rollResult.rolls.length === 1 && rollResult.rolls[0] === 20) {
      critical = "success";
    } else if (mode !== "exploding" && rollResult.rolls.length === 1 && rollResult.rolls[0] === 1) {
      critical = "failure";
    }

    return {
      tool: "roll_dice",
      success: true,
      result: { ...rollResult, dc, success, critical },
    };
  }

  _executeUserCode(toolDef, params, state) {
    try {
      const fn = new Function("params", "state", toolDef.userCode);
      const raw = fn(params, state || {});
      if (raw === undefined) {
        return { tool: toolDef.function.name, success: true, result: null };
      }
      return { tool: toolDef.function.name, success: true, result: raw };
    } catch (e) {
      console.error(`[NA] 工具 ${toolDef.function.name} 执行失败:`, e);
      return { tool: toolDef.function.name, success: false, error: e.message };
    }
  }
}

function formatToolResultsForWriting(toolResults) {
  if (!toolResults || toolResults.length === 0) return "";

  const parts = [];
  parts.push("<tool_results>");

  for (const tr of toolResults) {
    if (tr.tool === "roll_dice" && tr.result) {
      const r = tr.result;
      const modeLabel = r.mode === "advantage" ? " [优势]" : (r.mode === "disadvantage" ? " [劣势]" : (r.mode === "exploding" ? " [爆炸]" : ""));
      const criticalLabel = r.critical === "success" ? " ★大成功！" : (r.critical === "failure" ? " ★大失败！" : "");
      const successText = r.critical === "success" ? "大成功" : (r.critical === "failure" ? "大失败" : (r.success === true ? "成功" : (r.success === false ? "失败" : "无DC")));

      let rollDetail;
      if (r.mode === "advantage" || r.mode === "disadvantage") {
        rollDetail = `${r.allRolls[0].join(", ")} 和 ${r.allRolls[1].join(", ")}，取${r.mode === "advantage" ? "高" : "低"}值`;
      } else if (r.mode === "exploding" && r.explosions && r.explosions.length > 0) {
        rollDetail = `${r.rolls.join(", ")}，爆炸: ${r.explosions.join(", ")}`;
      } else {
        rollDetail = r.rolls.join(", ");
      }

      parts.push(`检定结果：${r.expression} = [${rollDetail}]${r.modifier >= 0 ? "+" : ""}${r.modifier} = ${r.total}${r.dc != null ? ` (DC ${r.dc})` : ""} → ${successText}${criticalLabel}`);
    } else if (tr.result !== undefined) {
      const formatted = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result, null, 2);
      parts.push(`${tr.tool}：${formatted}`);
    } else if (tr.output) {
      parts.push(tr.output);
    } else if (tr.error) {
      parts.push(`工具错误：${tr.error}`);
    }
  }

  parts.push("</tool_results>");
  return parts.join("\n");
}

// =============================================================================
// MVU 工具函数 (保留用于状态显示和 post_pipeline 工具输出)
// =============================================================================

function getMvuStateSummary(mvuData) {
  if (!mvuData || !mvuData.stat_data) return "（无 MVU 数据）";

  const s = mvuData.stat_data;
  const lines = [];

  function walk(obj, prefix, depth) {
    if (depth > 4) return;
    if (obj === null || obj === undefined) return;

    if (typeof obj === "object" && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj)) {
        if (key.startsWith("_")) continue;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          lines.push(`${prefix}${key}:`);
          walk(value, prefix + "  ", depth + 1);
        } else if (Array.isArray(value)) {
          lines.push(`${prefix}${key}: [${value.join(", ")}]`);
        } else {
          lines.push(`${prefix}${key}: ${value}`);
        }
      }
    }
  }

  walk(s, "", 0);
  return lines.join("\n") || "（空状态）";
}

class ContextRouter {
  constructor(deps) {
    this.stateManager = deps.stateManager;
    this.summaryStore = deps.summaryStore;
    this.characterReader = deps.characterReader;
    this.worldInfoResolver = deps.worldInfoResolver;
    this.userPersonaReader = deps.userPersonaReader;
  }

  async buildPlanningContext(userInput, recentTurns, systemEntries, beforeCharEntries, selectiveEntries, stateSummary, presetContext, planningTools) {
    let toolListText = "";
    if (planningTools && planningTools.length > 0) {
      const toolLines = planningTools.map(t => {
        const params = t.function.parameters;
        let paramDesc = "";
        if (params && params.properties) {
          const props = Object.entries(params.properties).map(([k, v]) => `${k}(${v.description || v.type || "any"})`).join(", ");
          paramDesc = `参数: ${props}`;
        } else {
          paramDesc = "无参数";
        }
        return `- ${t.function.name}: ${t.function.description}。${paramDesc}`;
      });
      toolListText = "可用工具：\n" + toolLines.join("\n");
    } else {
      toolListText = "当前没有可用工具，tool_calls 必须为空数组 []。不要自行发明任何工具。";
    }

    return {
      systemEntries: systemEntries || [],
      beforeCharEntries: beforeCharEntries || [],
      selectiveEntries: selectiveEntries || [],
      userPersona: this.userPersonaReader.getPersonaInfo(),
      storySummaries: this.summaryStore.getAllSummaries(),
      recentTurns,
      stateSummary,
      userInput,
      presetContext: presetContext?.planningContext || "",
      toolListText,
    };
  }

  async buildWritingContext(writingGuide, userInput, recentNarratives, systemEntries, selectiveEntries, writingSystemPreset, writingUserPreset, toolResultsText, beforeCharEntries) {
    return {
      userPersona: this.userPersonaReader.getPersonaInfo(),
      writingGuide,
      recentNarratives,
      systemEntries: systemEntries || [],
      selectiveEntries: selectiveEntries || [],
      writingSystemPreset: writingSystemPreset || "",
      writingUserPreset: writingUserPreset || "",
      userInput,
      toolResultsText: toolResultsText || "",
      beforeCharEntries: beforeCharEntries || [],
    };
  }

  buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary) {
    return {
      currentStateSummary: stateSummary || this.stateManager.getSummary(),
      oldSummary: this.summaryStore.getCurrentSummary(),
      currentDialogue: `用户：${userInput}\n叙事：${narrativeText}`,
      turnId,
    };
  }
}

// =============================================================================
// Orchestrator
// =============================================================================

class Orchestrator {
  constructor(deps) {
    this.stateManager = deps.stateManager;
    this.summaryStore = deps.summaryStore;
    this.fileManager = deps.fileManager;
    this.characterReader = deps.characterReader;
    this.worldInfoResolver = deps.worldInfoResolver;
    this.userPersonaReader = deps.userPersonaReader;
    this.config = deps.config || DEFAULT_CONFIG;
    this.turnCounter = 0;
    this._mvuInitialized = false;
    this._isRunning = false;
    this.presetContext = null;
    this.turnHistory = [];
    this.contextRouter = new ContextRouter(deps);
    this.toolExecutor = new ToolExecutor();
  }

  setPresetContext(ctx) {
    this.presetContext = ctx;
  }

  async pipeline(userInput, isRegeneration = false) {
    if (this._isRunning) throw new Error("Pipeline already running");
    this._isRunning = true;

    let turnId;
    if (isRegeneration) {
      turnId = `turn_${String(this.turnCounter).padStart(3, "0")}`;
      await this._rollbackToCheckpoint(turnId);
    } else {
      turnId = `turn_${String(this.turnCounter + 1).padStart(3, "0")}`;
    }

    if (!isRegeneration && !this._mvuInitialized) {
      await this._initMvuFromWorldbook();
      this._mvuInitialized = true;
    }

    const historyLenBefore = this.turnHistory.length;
    try {
      const result = await this._fullPipeline(userInput, turnId);
      if (!isRegeneration) this.turnCounter++;
      this._mvuInitialized = true;
      return result;
    } catch (error) {
      console.error("[NarrativeAgent] Pipeline error:", error);
      if (this.turnHistory.length > historyLenBefore) {
        console.warn("[NarrativeAgent] Rolling back turnHistory from failed pipeline (length:", this.turnHistory.length, "->", historyLenBefore, ")");
        this.turnHistory = this.turnHistory.slice(0, historyLenBefore);
      }
      const result = await this._fallbackPipeline(userInput, turnId);
      if (!isRegeneration) this.turnCounter++;
      return result;
    } finally {
      this._isRunning = false;
    }
  }

  async _getStateSummary() {
    if (typeof Mvu !== "undefined") {
      try {
        const mvuData = await Mvu.getMvuData({ type: "message", message_id: "latest" });
        const mvuSummary = getMvuStateSummary(mvuData);
        if (mvuSummary && mvuSummary !== "（无 MVU 数据）" && mvuSummary !== "（空状态）") {
          return mvuSummary;
        }
      } catch (e) {
        console.warn("[NarrativeAgent] MVU状态读取失败，回退到stateManager:", e.message);
      }
    }
    return this.stateManager.getSummary();
  }

  async _fullPipeline(userInput, turnId) {
    const cfg = this.config.pipeline;

    const sharedWorld = await this.worldInfoResolver.getFullContent();
    const allTools = await this.worldInfoResolver.getActiveTools();

    const planningTools = allTools.filter(t => t.trigger === "planning");
    const postPipelineTools = allTools.filter(t => t.trigger === "post_pipeline");

    if (planningTools.length === 0) {
      console.log("[NarrativeAgent] 无 planning 工具，切换为合并输出模式");
      return await this._mergedPipeline(userInput, turnId);
    }

    // 1. Planning
    console.log("[NarrativeAgent] Phase 1: Planning");
    const recentTurns = this._getStableRecentTurns(cfg.recentTurnsForPlanning, cfg.planningGrowthMargin || 3);

    const systemEntries = await this.worldInfoResolver.getConstantSystemEntries();
    const beforeCharEntries = await this.worldInfoResolver.getConstantBeforeCharEntries();
    const chatText = this.worldInfoResolver._getRecentChatText(2);
    const selectiveEntries = await this.worldInfoResolver.getSelectiveActivatedEntries(chatText);

    const stateSummary = await this._getStateSummary();
    if (stateSummary && !stateSummary.startsWith("（无")) {
      console.log("[NarrativeAgent] state loaded:", stateSummary.substring(0, 80));
    }

    const planningCtx = await this.contextRouter.buildPlanningContext(
      userInput, recentTurns, systemEntries, beforeCharEntries, selectiveEntries,
      stateSummary, this.presetContext, planningTools
    );
    const writingGuide = await runPlanningAgent(planningCtx);
    await this.fileManager.save(turnId, "plans", writingGuide);

    // 1.5 Tool Execution (trigger=planning)
    const codeToolResults = [];
    const llmToolOutputs = [];
    let toolResultsText = "";
    if (writingGuide.tool_calls && writingGuide.tool_calls.length > 0) {
      console.log("[NarrativeAgent] Phase 1.5: Tool Execution, count:", writingGuide.tool_calls.length);

      const availableContext = await this._buildAvailableContext(sharedWorld, userInput, writingGuide);

      for (const tc of writingGuide.tool_calls) {
        const toolDef = planningTools.find(t => t.function.name === tc.tool);
        if (!toolDef) {
          console.warn(`[NarrativeAgent] 工具 "${tc.tool}" 未注册，跳过`);
          continue;
        }

        if (toolDef.type === "code") {
          try {
            const result = this.toolExecutor.execute(toolDef, tc.params || {}, this.stateManager.toDict());
            codeToolResults.push({ tool: tc.tool, ...result });
          } catch (e) {
            codeToolResults.push({ tool: tc.tool, error: e.message });
          }
        } else if (toolDef.type === "llm") {
          try {
            const userMsg = buildToolUserMessage(toolDef, availableContext);
            const messages = [
              { role: "system", content: toolDef.system_prompt },
              { role: "user", content: userMsg },
            ];
            const output = await callLLM(messages, { label: `tool:${tc.tool}` });
            const trimmed = output.trim();
            codeToolResults.push({ tool: tc.tool, output: trimmed });
          } catch (e) {
            console.warn(`[NarrativeAgent] LLM工具 ${tc.tool} 执行失败:`, e);
          }
        }
      }

      toolResultsText = formatToolResultsForWriting(codeToolResults);
    }

    // 2. Writing
    console.log("[NarrativeAgent] Phase 2: Writing");
    const recentNarratives = this._getStableRecentTurns(cfg.recentTurnsForWriting, cfg.writingGrowthMargin || 4);

    const writingSystemPreset = (typeof this.presetContext === 'object')
      ? (this.presetContext.writingSystemContext || "")
      : "";
    const writingUserPreset = (typeof this.presetContext === 'object')
      ? (this.presetContext.writingUserContext || "")
      : "";

    const writingCtx = await this.contextRouter.buildWritingContext(
      writingGuide, userInput, recentNarratives,
      systemEntries, selectiveEntries,
      writingSystemPreset, writingUserPreset,
      toolResultsText,
      beforeCharEntries
    );
    const narrativeText = await runWritingAgent(writingCtx);
    await this.fileManager.save(turnId, "narratives", narrativeText);

    this.turnHistory.push({ userInput, narrativeText });

    // 3. Merged Analysis (extraction + compression) + Post-pipeline tools
    const { independent, dependent } = this._classifyPostPipelineTools(postPipelineTools);
    let merged;
    let applicationResult;

    if (this.config.pipeline.parallelExecutionEnabled && independent.length > 0) {
      console.log("[NarrativeAgent] Phase 3+4 (parallel): Analysis + independent tools, independent:", independent.length, "dependent:", dependent.length);

      const preAnalysisContext = await this._buildAvailableContext(sharedWorld, userInput, writingGuide, narrativeText);

      const [analysisResult] = await Promise.all([
        (async () => {
          const stateSummary = await this._getStateSummary();
          const ctx = this.contextRouter.buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary);
          try {
            return await runMergedAnalysisAgent(ctx);
          } catch (e) {
            console.error("[NarrativeAgent] Merged Analysis (parallel) 失败，跳过事件提取与摘要压缩:", e.message);
            return { events: [], summary_entries: [] };
          }
        })(),
        this._runPostPipelineToolsGroup(independent, preAnalysisContext, llmToolOutputs),
      ]);
      merged = analysisResult;

      applicationResult = this.stateManager.applyEvents(merged.events);
      await this.fileManager.save(turnId, "events", merged);
      await this.fileManager.save(turnId, "state", this.stateManager.toDict());

      if (merged.summary_entries.length > 0) {
        this.summaryStore.appendEntries(merged.summary_entries);
      }

      if (dependent.length > 0) {
        console.log("[NarrativeAgent] Phase 4 (dependent): Post-pipeline tools, count:", dependent.length);
        const postAnalysisContext = await this._buildAvailableContext(sharedWorld, userInput, writingGuide, narrativeText);
        await this._runPostPipelineToolsGroup(dependent, postAnalysisContext, llmToolOutputs);
      }
    } else {
      console.log("[NarrativeAgent] Phase 3: Merged Analysis (serial)");
      const stateSummary = await this._getStateSummary();
      const analysisCtx = this.contextRouter.buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary);
      try {
        merged = await runMergedAnalysisAgent(analysisCtx);
      } catch (e) {
        console.error("[NarrativeAgent] Merged Analysis 失败，跳过事件提取与摘要压缩:", e.message);
        merged = { events: [], summary_entries: [] };
      }

      applicationResult = this.stateManager.applyEvents(merged.events);
      await this.fileManager.save(turnId, "events", merged);
      await this.fileManager.save(turnId, "state", this.stateManager.toDict());

      if (merged.summary_entries.length > 0) {
        this.summaryStore.appendEntries(merged.summary_entries);
      }

      if (postPipelineTools.length > 0) {
        console.log("[NarrativeAgent] Phase 4: Post-pipeline tools, count:", postPipelineTools.length);
        const availableContext = await this._buildAvailableContext(sharedWorld, userInput, writingGuide, narrativeText);
        await this._runPostPipelineToolsGroup(postPipelineTools, availableContext, llmToolOutputs);
      }
    }

    // 5. Assemble final output
    console.log("[NarrativeAgent] Phase 5: Assembly");

    const summaryText = merged.summary_entries.length > 0
      ? merged.summary_entries.join("\n")
      : "";

    const parts = [];
    parts.push(`<context>\n${narrativeText}\n</context>`);
    if (summaryText) {
      parts.push(`<summary>\n${summaryText}\n</summary>`);
    }
    if (llmToolOutputs.length > 0) {
      parts.push(llmToolOutputs.join("\n\n"));
    }
    const finalOutput = parts.join("\n\n");

    this.fileManager.saveCheckpoint(turnId, this.stateManager.toDict(), this.summaryStore.toDict());

    return {
      narrative: narrativeText,
      formatted: null,
      events: applicationResult,
      writingGuide,
      finalOutput,
      codeToolResults,
    };
  }

  /**
   * 将 post_pipeline 工具按是否依赖合并分析输出分组。
   * story_summary / state_summary / known_context 由 Phase 3.5/3.6 修改，
   * 若工具的 context 声明了其中任一字段，则必须在合并分析之后运行。
   */
  _classifyPostPipelineTools(tools) {
    const ANALYSIS_DEPENDENT_KEYS = ["story_summary", "state_summary", "known_context"];
    const independent = [];
    const dependent = [];
    for (const tool of tools) {
      const ctx = tool.context || [];
      const depends = ANALYSIS_DEPENDENT_KEYS.some(k => ctx.includes(k));
      if (depends) {
        dependent.push(tool);
      } else {
        independent.push(tool);
      }
    }
    return { independent, dependent };
  }

  async _runPostPipelineToolsGroup(tools, availableContext, outputArray) {
    for (const toolDef of tools) {
      try {
        const userMsg = buildToolUserMessage(toolDef, availableContext);
        const messages = [
          { role: "system", content: toolDef.system_prompt },
          { role: "user", content: userMsg },
        ];
        const output = await callLLM(messages, { label: `post:${toolDef.function.name}` });
        const trimmed = output.trim();
        outputArray.push(trimmed);

        if (toolDef.function.name === "mvu_extract") {
          await this._processMvuOutput(trimmed);
        }
      } catch (e) {
        console.warn(`[NarrativeAgent] Post-pipeline tool ${toolDef.function.name} failed:`, e);
      }
    }
  }

  async _buildAvailableContext(sharedWorld, userInput, writingGuide, narrativeText = "") {
    const isPostPipeline = narrativeText !== "";
    return {
      world_full: sharedWorld || "",
      story_summary: this.summaryStore.getAllSummaries(),
      recent_turns: isPostPipeline ? "" : this._getRecentTurnsAsText(6),
      narrative_text: narrativeText,
      writing_guide: writingGuide ? (writingGuide.narrative_direction || "") : "",
      state_summary: await this._getStateSummary(),
      user_persona: this.userPersonaReader.getPersonaInfo(),
      user_input: userInput || "",
      dice_results: "",
      known_context: JSON.stringify(this.stateManager.getKnownContext()),
    };
  }

  _getRecentTurnsAsText(count) {
    const turns = this._getRecentTurns(count);
    if (turns.length === 0) return "";
    return turns.map((t) => `[轮${t.turnNum}] 用户: ${t.user}\n[轮${t.turnNum}] AI: ${t.assistant}`).join("\n\n");
  }

  async _processMvuOutput(output) {
    try {
      let patchesStr = null;

      const jsonPatchMatch = output.match(/<JSONPatch>\s*(\[[\s\S]*?\])\s*<\/JSONPatch>/);
      if (jsonPatchMatch) {
        patchesStr = jsonPatchMatch[1];
        console.log("[NarrativeAgent] MVU: extracted patches from <JSONPatch> tag");
      }

      if (!patchesStr) {
        const patchesMatch = output.match(/"patches"\s*:\s*(\[[\s\S]*?\])/);
        if (patchesMatch) {
          patchesStr = patchesMatch[1];
          console.log("[NarrativeAgent] MVU: extracted patches from JSON object");
        }
      }

      if (!patchesStr) {
        const braceMatch = /^\s*\{/.test(output.trim()) ? this._extractFirstJSON(output) : null;
        if (braceMatch) {
          try {
            const parsed = JSON.parse(braceMatch);
            if (parsed.patches) {
              patchesStr = JSON.stringify(parsed.patches);
              console.log("[NarrativeAgent] MVU: extracted patches from top-level JSON");
            }
          } catch (e) {
            console.warn("[NarrativeAgent] MVU: failed to parse top-level JSON fallback:", e.message);
          }
        }
      }

      if (patchesStr) {
        const patches = JSON.parse(patchesStr);
        if (patches && patches.length > 0) {
          console.log("[NarrativeAgent] MVU patches extracted:", patches.length);
          try {
            const mvuData = await Mvu.getMvuData({ type: "message", message_id: "latest" });
            const statData = mvuData?.stat_data || {};
            this._applyPatches(statData, patches);
            await Mvu.replaceMvuData({ stat_data: statData, initialized_lorebooks: mvuData?.initialized_lorebooks || {} }, { type: "message", message_id: "latest" });
            console.log("[NarrativeAgent] MVU patches applied, state keys:", Object.keys(statData).length);
          } catch (e) {
            console.warn("[NarrativeAgent] Failed to apply MVU patches:", e);
          }
        }
      } else {
        console.log("[NarrativeAgent] MVU: no patches found in output, length:", output.length);
      }
    } catch (e) {
      console.warn("[NarrativeAgent] Failed to parse MVU output:", e);
    }
  }

  _extractFirstJSON(str) {
    let depth = 0;
    let start = -1;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "{") {
        if (start === -1) start = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          return str.substring(start, i + 1);
        }
      }
    }
    return null;
  }

  _applyPatches(data, patches) {
    for (const patch of patches) {
      const path = (patch.path || "").replace(/^\//, "").split("/");
      if (path.length === 0 || path[0] === "") continue;
      switch (patch.op) {
        case "replace":
        case "add":
        case "insert":
          this._setByPath(data, path, patch.value);
          break;
        case "remove":
          this._removeByPath(data, path);
          break;
        case "delta": {
          const current = this._getByPath(data, path);
          if (typeof current === "number" && typeof patch.value === "number") {
            this._setByPath(data, path, current + patch.value);
          }
          break;
        }
      }
    }
  }

  _getByPath(obj, path) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[path[i]];
    }
    return cur?.[path[path.length - 1]];
  }

  _setByPath(obj, path, value) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
      if (!(path[i] in cur) || typeof cur[path[i]] !== "object" || cur[path[i]] === null) {
        cur[path[i]] = {};
      }
      cur = cur[path[i]];
    }
    cur[path[path.length - 1]] = value;
  }

  _removeByPath(obj, path) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
      if (cur == null || typeof cur !== "object") return;
      cur = cur[path[i]];
    }
    if (cur && typeof cur === "object") {
      delete cur[path[path.length - 1]];
    }
  }

  async _initMvuFromWorldbook() {
    if (typeof Mvu === "undefined") return;
    try {
      const initJson = await this.worldInfoResolver.getInitVar();
      if (!initJson) return;
      let initData;
      try {
        initData = JSON.parse(initJson);
      } catch (jsonErr) {
        initData = parseTextToVariables(initJson);
        if (!initData || Object.keys(initData).length === 0) {
          console.warn("[NarrativeAgent] [initvar] entry content is neither valid JSON nor parsable text, skipping MVU init. Content preview:", initJson.substring(0, 120));
          return;
        }
        console.log("[NarrativeAgent] [initvar] parsed from text format, keys:", Object.keys(initData).join(", "));
      }
      const current = await Mvu.getMvuData({ type: "message", message_id: "latest" });
      const existing = current?.stat_data || {};
      if (Object.keys(existing).length > 0) {
        console.log("[NarrativeAgent] MVU已有数据，跳过[initvar]初始化");
        return;
      }
      await Mvu.replaceMvuData({ stat_data: initData, initialized_lorebooks: current?.initialized_lorebooks || {} }, { type: "message", message_id: "latest" });
      console.log("[NarrativeAgent] MVU initialized from [initvar]:", Object.keys(initData).join(", "));
    } catch (e) {
      console.warn("[NarrativeAgent] [initvar] MVU initialization failed:", e);
    }
  }

  async _fallbackPipeline(userInput, turnId) {
    console.log("[NarrativeAgent] Using fallback pipeline");
    try {
      const fallbackGuide = { narrative_direction: "", key_points: [], tone: "中", pacing: "中", continuity_notes: [], tool_calls: [] };
      const recentNarratives = this._getRecentTurns(3);
      const writingCtx = {
        userPersona: this.userPersonaReader.getPersonaInfo(),
        writingGuide: fallbackGuide,
        recentNarratives,
        systemEntries: [],
        selectiveEntries: [],
        writingSystemPreset: "",
        writingUserPreset: "",
        userInput,
        toolResultsText: "",
      };
      const narrativeText = await runWritingAgent(writingCtx);

      this.turnHistory.push({ userInput, narrativeText });

      const analysisCtx = this.contextRouter.buildMergedAnalysisContext(narrativeText, userInput, turnId);
      const merged = await runMergedAnalysisAgent(analysisCtx);
      const applicationResult = this.stateManager.applyEvents(merged.events);

      if (merged.summary_entries.length > 0) {
        this.summaryStore.appendEntries(merged.summary_entries);
      }

      this.fileManager.saveCheckpoint(turnId, this.stateManager.toDict(), this.summaryStore.toDict());

      const summaryText = merged.summary_entries.length > 0
        ? merged.summary_entries.join("\n")
        : "";
      const parts = [];
      parts.push(`<context>\n${narrativeText}\n</context>`);
      if (summaryText) {
        parts.push(`<summary>\n${summaryText}\n</summary>`);
      }
      const finalOutput = parts.join("\n\n");

      return {
        narrative: narrativeText,
        formatted: null,
        events: applicationResult,
        writingGuide: fallbackGuide,
        finalOutput,
        codeToolResults: [],
      };
    } catch (fallbackErr) {
      console.error("[NarrativeAgent] Fallback pipeline 也执行失败:", fallbackErr);
      return {
        narrative: "[多Agent叙事系统出错：正常流水线和fallback流水线均执行失败，请检查控制台日志和API连接。]",
        formatted: null,
        events: { applied: 0, rejected: 0 },
        writingGuide: { narrative_direction: "", key_points: [], tone: "中", pacing: "中", continuity_notes: [], tool_calls: [] },
        finalOutput: "[多Agent叙事系统出错：正常流水线和fallback流水线均执行失败，请检查控制台日志和API连接。]",
        codeToolResults: [],
      };
    }
  }

  async _mergedPipeline(userInput, turnId) {
    const cfg = this.config.pipeline;

    const sharedWorld = await this.worldInfoResolver.getFullContent();
    const allTools = await this.worldInfoResolver.getActiveTools();
    const postPipelineTools = allTools.filter(t => t.trigger === "post_pipeline");

    console.log("[NarrativeAgent] Phase 1+2: Merged Writing (合并模式)");

    const systemEntries = await this.worldInfoResolver.getConstantSystemEntries();
    const beforeCharEntries = await this.worldInfoResolver.getConstantBeforeCharEntries();
    const chatText = this.worldInfoResolver._getRecentChatText(2);
    const selectiveEntries = await this.worldInfoResolver.getSelectiveActivatedEntries(chatText);
    const recentTurns = this._getStableRecentTurns(cfg.recentTurnsForWriting, cfg.writingGrowthMargin || 4);
    const stateSummary = await this._getStateSummary();

    const narrativeText = await runMergedWritingAgent({
      userInput,
      recentTurns,
      systemEntries,
      beforeCharEntries,
      selectiveEntries,
      stateSummary,
      storySummaries: this.summaryStore.getAllSummaries(),
      userPersona: this.userPersonaReader.getPersonaInfo(),
      presetContext: (typeof this.presetContext === "object")
        ? (this.presetContext.planningContext || "")
        : "",
      writingUserPreset: (typeof this.presetContext === "object")
        ? (this.presetContext.writingUserContext || "")
        : "",
    });

    await this.fileManager.save(turnId, "narratives", narrativeText);

    const mergedGuide = {
      narrative_direction: "",
      key_points: [],
      tone: "中",
      pacing: "中",
      continuity_notes: [],
      tool_calls: [],
      scene_setting: "",
    };
    await this.fileManager.save(turnId, "plans", mergedGuide);
    this.turnHistory.push({ userInput, narrativeText });

    console.log("[NarrativeAgent] Phase 3: Merged Analysis");
    const analysisCtx = this.contextRouter.buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary);
    let merged;
    try {
      merged = await runMergedAnalysisAgent(analysisCtx);
    } catch (e) {
      console.error("[NarrativeAgent] Merged Analysis 失败，跳过事件提取与摘要压缩:", e.message);
      merged = { events: [], summary_entries: [] };
    }

    const applicationResult = this.stateManager.applyEvents(merged.events);
    await this.fileManager.save(turnId, "events", merged);
    await this.fileManager.save(turnId, "state", this.stateManager.toDict());

    if (merged.summary_entries.length > 0) {
      this.summaryStore.appendEntries(merged.summary_entries);
    }

    const llmToolOutputs = [];
    if (postPipelineTools.length > 0) {
      console.log("[NarrativeAgent] Phase 4: Post-pipeline tools, count:", postPipelineTools.length);
      const availableContext = await this._buildAvailableContext(sharedWorld, userInput, mergedGuide, narrativeText);
      await this._runPostPipelineToolsGroup(postPipelineTools, availableContext, llmToolOutputs);
    }

    console.log("[NarrativeAgent] Phase 5: Assembly");

    const summaryText = merged.summary_entries.length > 0
      ? merged.summary_entries.join("\n")
      : "";

    const parts = [];
    parts.push(`<context>\n${narrativeText}\n</context>`);
    if (summaryText) {
      parts.push(`<summary>\n${summaryText}\n</summary>`);
    }
    if (llmToolOutputs.length > 0) {
      parts.push(llmToolOutputs.join("\n\n"));
    }
    const finalOutput = parts.join("\n\n");

    this.fileManager.saveCheckpoint(turnId, this.stateManager.toDict(), this.summaryStore.toDict());

    return {
      narrative: narrativeText,
      formatted: null,
      events: applicationResult,
      writingGuide: mergedGuide,
      finalOutput,
      codeToolResults: [],
    };
  }

  _getRecentTurns(count) {
    const history = this.turnHistory;
    if (history.length === 0) return [];
    const start = Math.max(0, history.length - count);
    return history.slice(start).map((t, i) => ({ user: t.userInput, assistant: t.narrativeText, turnNum: start + i + 1 }));
  }

  _getStableRecentTurns(n, m) {
    const history = this.turnHistory;
    if (history.length === 0) return [];
    const window = [];
    let globalIdx = 0;
    for (const turn of history) {
      window.push({ user: turn.userInput, assistant: turn.narrativeText, turnNum: globalIdx + 1 });
      if (window.length > n + m) {
        window.splice(0, m + 1);
      }
      globalIdx++;
    }
    return window;
  }

  async _rollbackToCheckpoint(turnId) {
    const prevTurnNum = parseInt(String(turnId).replace("turn_", ""), 10) - 1;
    if (prevTurnNum <= 0) {
      this.stateManager.reset();
      this.summaryStore.reset();
      this.turnHistory = [];
      try { await Mvu.replaceMvuData({ stat_data: {} }, { type: "chat" }); } catch (e) { console.warn("[NA] MVU reset failed:", e); }
      return;
    }
    const prevTurnId = `turn_${String(prevTurnNum).padStart(3, "0")}`;
    const checkpoint = this.fileManager.loadCheckpoint(prevTurnId);
    if (!checkpoint) {
      console.warn("[NarrativeAgent] No checkpoint found for", prevTurnId, ", performing full reset");
      this.stateManager.reset();
      this.summaryStore.reset();
      this.turnHistory = [];
      try { await Mvu.replaceMvuData({ stat_data: {} }, { type: "chat" }); } catch (e) { console.warn("[NA] MVU reset failed:", e); }
      return;
    }
    this.stateManager.reset(StateManager.fromDict(checkpoint.state).state);
    this.summaryStore.reset(SummaryStore.fromDict(checkpoint.summary));
    if (checkpoint.mvuData) {
      try {
        await Mvu.replaceMvuData(checkpoint.mvuData, { type: "chat" });
        console.log("[NarrativeAgent] MVU data restored from checkpoint:", prevTurnId);
      } catch (e) {
        console.warn("[NarrativeAgent] Failed to restore MVU data:", e);
      }
    }
    this.turnHistory = this.turnHistory.slice(0, prevTurnNum);
    console.log("[NarrativeAgent] Rolled back to checkpoint:", prevTurnId, ", turnHistory trimmed to", prevTurnNum);
  }

  async rollbackToTurn(targetTurn) {
    if (targetTurn < 0) targetTurn = 0;
    const targetTurnId = targetTurn === 0 ? null : `turn_${String(targetTurn).padStart(3, "0")}`;

    if (targetTurn === 0) {
      this.stateManager.reset();
      this.summaryStore.reset();
      try { await Mvu.replaceMvuData({ stat_data: {} }, { type: "chat" }); } catch (e) { console.warn("[NA] MVU reset failed:", e); }
    } else {
      const checkpoint = this.fileManager.loadCheckpoint(targetTurnId);
      if (checkpoint) {
        this.stateManager.reset(StateManager.fromDict(checkpoint.state).state);
        this.summaryStore.reset(SummaryStore.fromDict(checkpoint.summary));
        if (checkpoint.mvuData) {
          try {
            await Mvu.replaceMvuData(checkpoint.mvuData, { type: "chat" });
            console.log("[NarrativeAgent] MVU data restored to turn:", targetTurn);
          } catch (e) {
            console.warn("[NarrativeAgent] Failed to restore MVU data:", e);
          }
        }
      } else {
        console.warn("[NarrativeAgent] No checkpoint for", targetTurnId, ", resetting");
        this.stateManager.reset();
        this.summaryStore.reset();
        try { await Mvu.replaceMvuData({ stat_data: {} }, { type: "chat" }); } catch (e) { console.warn("[NA] MVU reset failed:", e); }
      }
    }

    this.turnCounter = targetTurn;
    this._mvuInitialized = targetTurn > 0;
    this.turnHistory = this.turnHistory.slice(0, targetTurn);

    if (targetTurn > 0) {
      this.fileManager.deleteCheckpointsFrom(`turn_${String(targetTurn + 1).padStart(3, "0")}`);
    }

    console.log("[NarrativeAgent] Rolled back to turn:", targetTurn);
  }

  switchToChat(stateManager, summaryStore, fileManager) {
    this.stateManager = stateManager;
    this.summaryStore = summaryStore;
    this.fileManager = fileManager;
    this.turnCounter = 0;
    this._mvuInitialized = false;
    this.turnHistory = [];
    this.presetContext = null;
    this.worldInfoResolver._entriesCache = null;
    this.worldInfoResolver._entriesCacheKey = null;
    this.worldInfoResolver._formattingContentSet = null;
    this.contextRouter = new ContextRouter({
      stateManager,
      summaryStore,
      characterReader: this.characterReader,
      worldInfoResolver: this.worldInfoResolver,
      userPersonaReader: this.userPersonaReader,
    });
    console.log("[NarrativeAgent] Switched to chat:", fileManager.basePath);
  }
}

// =============================================================================
// ST Bridge
// =============================================================================

class SillyTavernBridge {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    this.enabled = true;
    this.wasIntercepted = false;
    this.isPipelineRunning = false;
    this._generationType = null;
    this._savedUserInput = null;
    this._generationCompleted = true;
    this._pipelineCompleteCbs = [];
    this._boundOnPromptReady = this._onPromptReady.bind(this);
    this._boundOnGenerationEnded = this._onGenerationEnded.bind(this);
    this._boundOnGenerationStarted = this._onGenerationStarted.bind(this);
    this._boundOnMessageDeleted = this._onMessageDeleted.bind(this);
  }

  onPipelineComplete(cb) { this._pipelineCompleteCbs.push(cb); }

  install() {
    const ctx = getSTContext();
    if (!ctx) { console.error("[NarrativeAgent] ST context not available"); return; }
    ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, this._boundOnPromptReady);
    ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED, this._boundOnGenerationEnded);
    ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, this._boundOnGenerationStarted);
    ctx.eventSource.on(ctx.eventTypes.MESSAGE_DELETED, this._boundOnMessageDeleted);
    console.log("[NarrativeAgent] Bridge installed, enabled:", this.enabled);
  }

  uninstall() {
    const ctx = getSTContext();
    if (!ctx) return;
    ctx.eventSource.removeListener(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, this._boundOnPromptReady);
    ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_ENDED, this._boundOnGenerationEnded);
    ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_STARTED, this._boundOnGenerationStarted);
    ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_DELETED, this._boundOnMessageDeleted);
  }

  _onGenerationStarted(type) {
    this._generationType = type;
    this._generationCompleted = false;
    console.log("[NarrativeAgent] GENERATION_STARTED, type:", type);
  }

  _onMessageDeleted(newChatLength) {
    if (!this.enabled || this.isPipelineRunning) return;

    if (newChatLength <= 1) {
      console.log("[NarrativeAgent] MESSAGE_DELETED, chat near-empty, full reset. newChatLength:", newChatLength);
      this.orchestrator.rollbackToTurn(0);
      return;
    }

    console.log("[NarrativeAgent] MESSAGE_DELETED, newChatLength:", newChatLength,
      "turnCounter:", this.orchestrator.turnCounter, "— relay模式下聊天结构已变更，部分删除不触发回退");
  }

  _onPromptReady(data) {
    if (!this.enabled || this.isPipelineRunning) return;
    console.log("[NarrativeAgent] 拦截 CHAT_COMPLETION_PROMPT_READY, 原始消息数:", data.chat?.length);

    this.orchestrator.worldInfoResolver.buildFormattingSet().catch(e => console.warn("[NA] buildFormattingSet in _onPromptReady failed:", e.message));

    this._savedUserInput = getLatestUserInput(data.chat);
    console.log("[NarrativeAgent] 已保存用户输入:", this._savedUserInput?.substring(0, 80));

    if (this.orchestrator.config.presetMode === "split") {
      const formattingSet = this.orchestrator.worldInfoResolver.getFormattingSet();
      const presetCtx = extractPresetContext(data.chat, formattingSet);
      this.orchestrator.setPresetContext(presetCtx);
      console.log("[NarrativeAgent] 预设上下文已提取, planningContext长度:", presetCtx.planningContext.length, "writingSystemContext长度:", presetCtx.writingSystemContext.length, "writingUserContext长度:", presetCtx.writingUserContext.length);
    } else {
      this.orchestrator.setPresetContext(null);
    }

    data.chat.splice(0, data.chat.length);
    data.chat.push({ role: "system", content: "You are a relay. You must output exactly the following text and nothing else: " + PLACEHOLDER });
    data.chat.push({ role: "user", content: "Relay the designated text now." });
    this.wasIntercepted = true;
  }

  async _onGenerationEnded() {
    this._generationCompleted = true;

    if (!this.enabled || this.isPipelineRunning || !this.wasIntercepted) return;
    this.wasIntercepted = false;

    const ctx = getSTContext();
    if (!ctx) return;

    const lastMsg = ctx.chat[ctx.chat.length - 1];
    if (!lastMsg || lastMsg.is_user || !(lastMsg.mes || "").includes(PLACEHOLDER)) {
      console.warn("[NarrativeAgent] 中继未正常完成（可能被用户取消或API错误），跳过Pipeline");
      return;
    }

    this.isPipelineRunning = true;

    const chat = ctx.chat;
    const isRegeneration = this._generationType === "swipe" || this._generationType === "regenerate";
    this._generationType = null;

    try {
      let userInput = getLatestUserInput(chat);
      if (!userInput && this._savedUserInput) {
        userInput = this._savedUserInput;
        console.log("[NarrativeAgent] 使用保存的用户输入:", userInput?.substring(0, 80));
      }
      this._savedUserInput = null;
      console.log("[NarrativeAgent] Pipeline start, userInput preview:", userInput?.substring(0, 60), "isRegeneration:", isRegeneration);
      const result = await this.orchestrator.pipeline(userInput, isRegeneration);

      if (lastMsg && !lastMsg.is_user) {
        lastMsg.mes = result.finalOutput || result.narrative;
        lastMsg.extra = lastMsg.extra || {};
        lastMsg.extra.state_panel = null;
        lastMsg.extra.writing_guide = result.writingGuide;
        lastMsg.extra.events = result.events;
        ctx.updateMessageBlock(chat.length - 1, lastMsg);
      }

      if (typeof ctx.saveChat === "function") await ctx.saveChat();
      console.log("[NarrativeAgent] Pipeline 执行完成, 输出长度:", result.finalOutput.length);

      for (const cb of this._pipelineCompleteCbs) {
        try { await cb(result); } catch (err) { console.error("[NarrativeAgent] Callback error:", err); }
      }
    } catch (err) {
      console.error("[NarrativeAgent] Pipeline 执行失败:", err);
      if (lastMsg) { lastMsg.mes = "[多Agent叙事系统执行出错，请检查控制台日志。]"; ctx.updateMessageBlock(chat.length - 1, lastMsg); }
    } finally {
      this.isPipelineRunning = false;
    }
  }
}

function getLatestUserInput(chat) {
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i].is_user) return chat[i].mes || "";
  }
  return "";
}

// =============================================================================
// UI Renderer
// =============================================================================

// =============================================================================
// 配置
// =============================================================================

function loadConfig() {
  try {
    const ctx = getSTContext();
    if (!ctx) return { ...DEFAULT_CONFIG };
    const saved = ctx.extensionSettings?.[EXTENSION_ID]?.config;
    if (saved && typeof saved === "object") return deepMerge({ ...DEFAULT_CONFIG }, saved);
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  try {
    const ctx = getSTContext();
    if (!ctx) return;
    ctx.extensionSettings[EXTENSION_ID] = ctx.extensionSettings[EXTENSION_ID] || {};
    ctx.extensionSettings[EXTENSION_ID].config = config;
    ctx.extensionSettings[EXTENSION_ID].enabled = config.enabled;
    if (typeof ctx.saveSettingsDebounced === "function") ctx.saveSettingsDebounced();
  } catch { /* ignore */ }
}

// =============================================================================
// 主入口
// =============================================================================

let orchestrator = null;
let bridge = null;
let config = { ...DEFAULT_CONFIG };
let currentChatId = null;

async function initExtension() {
  console.log("[NarrativeAgent] Initializing...");
  config = loadConfig();

  currentChatId = getConversationId();
  const stateManager = loadOrCreateState(currentChatId);
  const summaryStore = loadOrCreateSummary(currentChatId);
  const fileManager = new FileManager(currentChatId);
  const characterReader = new CharacterReader();
  const worldInfoResolver = new WorldInfoResolver(stateManager, config.worldbookSource);
  const userPersonaReader = new UserPersonaReader();

  if (config.state.autoSyncWorldInfo) await worldInfoResolver.syncToStateManager();

  orchestrator = new Orchestrator({ stateManager, summaryStore, fileManager, characterReader, worldInfoResolver, userPersonaReader, config });

  bridge = new SillyTavernBridge(orchestrator);
  bridge.enabled = config.enabled;
  bridge.onPipelineComplete(() => { persistState(); refreshStateDisplay(); });
  await worldInfoResolver.buildFormattingSet();
  bridge.install();

  installChatChangeHandler();

  await registerSettingsPane();
  console.log("[NarrativeAgent] Initialization complete, enabled:", config.enabled);
}

function installChatChangeHandler() {
  const ctx = getSTContext();
  if (!ctx) return;
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, async () => {
    if (!orchestrator || !bridge) return;
    console.log("[NarrativeAgent] Chat changed, saving current state for:", currentChatId);
    persistState(currentChatId);

    const newChatId = getConversationId();
    const newStateManager = loadOrCreateState(newChatId);
    const newSummaryStore = loadOrCreateSummary(newChatId);
    const newFileManager = new FileManager(newChatId);

    orchestrator.switchToChat(newStateManager, newSummaryStore, newFileManager);
    await orchestrator.worldInfoResolver.buildFormattingSet();
    currentChatId = newChatId;
    refreshStateDisplay();
    console.log("[NarrativeAgent] Chat switch complete, new chatId:", newChatId);
  });
}

function loadOrCreateState(chatId) {
  try {
    const ctx = getSTContext();
    const ext = ctx?.extensionSettings?.[EXTENSION_ID];
    const chatStates = ext?.chatStates;
    if (chatStates && chatStates[chatId] && chatStates[chatId].gameState) {
      return StateManager.fromDict(chatStates[chatId].gameState);
    }
    if (ext?.gameState) {
      console.log("[NarrativeAgent] Migrating legacy global state to chat:", chatId);
      return StateManager.fromDict(ext.gameState);
    }
  } catch { /* ignore */ }
  return new StateManager();
}

function loadOrCreateSummary(chatId) {
  try {
    const ctx = getSTContext();
    const ext = ctx?.extensionSettings?.[EXTENSION_ID];
    const chatStates = ext?.chatStates;
    if (chatStates && chatStates[chatId] && chatStates[chatId].summaryStore) {
      return SummaryStore.fromDict(chatStates[chatId].summaryStore);
    }
    if (ext?.summaryStore) {
      console.log("[NarrativeAgent] Migrating legacy global summary to chat:", chatId);
      return SummaryStore.fromDict(ext.summaryStore);
    }
  } catch { /* ignore */ }
  return new SummaryStore();
}

function persistState(chatIdOverride = null) {
  try {
    const ctx = getSTContext();
    if (!ctx || !orchestrator) return;
    const chatId = chatIdOverride || currentChatId || getConversationId();
    ctx.extensionSettings[EXTENSION_ID] = ctx.extensionSettings[EXTENSION_ID] || {};
    ctx.extensionSettings[EXTENSION_ID].chatStates = ctx.extensionSettings[EXTENSION_ID].chatStates || {};
    ctx.extensionSettings[EXTENSION_ID].chatStates[chatId] = {
      gameState: orchestrator.stateManager.toDict(),
      summaryStore: orchestrator.summaryStore.toDict(),
    };
    ctx.extensionSettings[EXTENSION_ID].enabled = config.enabled;

    if (ctx.extensionSettings[EXTENSION_ID].summaryStore) {
      delete ctx.extensionSettings[EXTENSION_ID].summaryStore;
    }
    if (ctx.extensionSettings[EXTENSION_ID].gameState) {
      delete ctx.extensionSettings[EXTENSION_ID].gameState;
    }

    if (typeof ctx.saveSettingsDebounced === "function") ctx.saveSettingsDebounced();
  } catch { /* ignore */ }
}

async function registerSettingsPane() {
  try {
    const ctx = getSTContext();
    if (!ctx?.renderExtensionTemplateAsync) { console.warn("[NarrativeAgent] renderExtensionTemplateAsync not available"); return; }

    const html = await ctx.renderExtensionTemplateAsync("narrative-agent", "settings");
    const $html = $(html);

    $html.find("#na_enabled").prop("checked", config.enabled);
    $html.find("#na_enabled").on("change", function () {
      config.enabled = $(this).prop("checked");
      if (bridge) bridge.enabled = config.enabled;
      saveConfig(config);
      persistState();
      refreshStateDisplay($html);
    });

    $html.find("#na_preset_mode").val(config.presetMode || "none");
    $html.find("#na_preset_mode").on("change", function () {
      config.presetMode = $(this).val();
      if (orchestrator) orchestrator.config = config;
      saveConfig(config);
      persistState();
      console.log("[NarrativeAgent] 预设模式切换为:", config.presetMode);
    });

    $html.find("#na_worldbook_source").val(config.worldbookSource || "auto");
    $html.find("#na_worldbook_source").on("change", function () {
      config.worldbookSource = $(this).val();
      if (orchestrator) {
        orchestrator.config = config;
        orchestrator.worldInfoResolver.worldbookSource = config.worldbookSource;
        orchestrator.worldInfoResolver._entriesCache = null;
        orchestrator.worldInfoResolver._entriesCacheKey = null;
      }
      saveConfig(config);
      persistState();
      console.log("[NarrativeAgent] 世界书来源切换为:", config.worldbookSource);
    });

    $html.find("#na_parallel_execution").prop("checked", config.pipeline?.parallelExecutionEnabled === true);
    $html.find("#na_parallel_execution").on("change", function () {
      if (!config.pipeline) config.pipeline = {};
      config.pipeline.parallelExecutionEnabled = $(this).prop("checked");
      if (orchestrator) orchestrator.config = config;
      saveConfig(config);
      persistState();
      console.log("[NarrativeAgent] 并行处理切换为:", config.pipeline.parallelExecutionEnabled);
    });

    // Import data
    $html.find("#na_import_data").on("click", function () {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = async function (e) {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (data.state && orchestrator) {
            orchestrator.stateManager.reset(StateManager.fromDict(data.state).state);
          }
          if (data.summary && orchestrator) {
            orchestrator.summaryStore = SummaryStore.fromDict(data.summary);
          }
          persistState();
          refreshStateDisplay($html);
          toastr.info("数据已导入");
        } catch (err) {
          console.error("[NarrativeAgent] Import failed:", err);
          toastr.error("数据导入失败: " + err.message);
        }
      };
      input.click();
    });

    $html.find("#na_reset_state").on("click", function () {
      if (orchestrator) {
        orchestrator.stateManager.reset();
        orchestrator.summaryStore.reset();
        orchestrator.turnCounter = 0;
        orchestrator._mvuInitialized = false;
        persistState();
        refreshStateDisplay($html);
        toastr.info("游戏状态和摘要已重置");
      }
    });

    $html.find("#na_refresh_state").on("click", function () { refreshStateDisplay($html); });

    $html.find("#na_export_data").on("click", async function () {
      if (!orchestrator) return;
      const data = await orchestrator.fileManager.exportConversation();
      data.state = orchestrator.stateManager.toDict();
      data.summary = orchestrator.summaryStore.toDict();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `narrative_agent_export_${Date.now()}.json`;
      a.click(); URL.revokeObjectURL(url);
      toastr.info("数据已导出");
    });

    $("#extensions_settings").append($html);
    refreshStateDisplay($html);
  } catch (err) { console.error("[NarrativeAgent] Failed to register settings pane:", err); }
}

function refreshStateDisplay($html) {
  const $display = $html ? $html.find("#na_state_display") : $("#na_state_display");
  if ($display.length && orchestrator) {
    const summary = orchestrator.stateManager.getSummary();
    const logCount = orchestrator.stateManager.state.eventLog.length;
    const turnCount = orchestrator.turnCounter;
    const summaryCount = orchestrator.summaryStore.getEntryCount();
    $display.text(summary + "\n\n" +
      `轮次: ${turnCount} | 事件日志: ${logCount} 条 | 摘要条目: ${summaryCount}`);
  }
}

// =============================================================================
// Bootstrap — 与 MVP 完全相同的启动方式
// =============================================================================

(function () {
  function bootstrap() {
    initExtension().catch(err => console.error("[NarrativeAgent] Bootstrap failed:", err));
  }
  if (typeof $ !== "undefined") {
    $(bootstrap);
  } else {
    const interval = setInterval(() => {
      if (typeof $ !== "undefined") { clearInterval(interval); $(bootstrap); }
    }, 100);
  }
})();
