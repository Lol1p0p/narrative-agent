import { getSTContext, truncate, _isToolEntryContent, parseTextToVariables } from "./utils.js";
import { SHARED_ANALYSIS_PREFIX } from "./constants.js";

export function _fastHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return hash >>> 0;
}

export class WorldInfoResolver {
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
      const entryDict = charBook.entries;
      const entryIds = Object.keys(entryDict).sort();
      const fingerprintParts = entryIds.map(uid => {
        const e = entryDict[uid];
        return `${uid}|${JSON.stringify(e.key)}|${e.content}|${e.comment||""}|${e.disable?"1":"0"}|${e.constant?"1":"0"}|${e.position||0}|${e.order||0}|${e.selective?"1":"0"}`;
      });
      const fingerprint = _fastHash(fingerprintParts.join("\n"));
      const cacheKey = `card:${ctx.characterId}:${fingerprint}`;
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

  invalidateCache() {
    this._entriesCache = null;
    this._entriesCacheKey = null;
    this._formattingContentSet = null;
    console.log("[NA] WorldInfo cache invalidated");
  }

  ensureFreshCardCache() {
    if (this.worldbookSource === "world") return;
    this._entriesCache = null;
    this._entriesCacheKey = null;
  }

  async getSummary() {
    const entries = await this._getAll();
    return entries
      .filter(e => this._isEnabled(e))
      .map(e => `- ${e.comment || e.key?.[0] || "\u672a\u547d\u540d"}: ${truncate(e.content, 80)}`)
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
      const label = e.comment || e.key?.[0] || "\u672a\u547d\u540d";
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
      const label = e.comment || e.key?.[0] || "\u672a\u547d\u540d";
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
          this.stateManager.state.quests[questId] = { status: "active", stage: "\u672a\u5f00\u59cb" };
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
        console.warn(`[NA] [TOOL:${funcName}] \u6761\u76ee\u89e3\u6790\u5931\u8d25: \u7f3a\u5c11\u5fc5\u9700\u5b57\u6bb5 type/function/function.name, parsed=`, JSON.stringify(parsed).substring(0, 200));
        return null;
      }
      const prompt = parsed.system_prompt || parsed.user_persona || "";
      if (parsed.user_persona && !parsed.system_prompt) {
        console.warn(`[NA] [TOOL:${funcName}] \u68c0\u6d4b\u5230 user_persona \u5b57\u6bb5\uff0c\u5df2\u81ea\u52a8\u6620\u5c04\u4e3a system_prompt\u3002\u5efa\u8bae\u6539\u4e3a system_prompt \u4ee5\u5339\u914d\u89c4\u8303\u3002`);
      }
      const isCustomCode = parsed.type === "code" && parsed.function.name !== "roll_dice";
      let userCode = "";
      if (isCustomCode) {
        userCode = (parsed.code || "").trim();
        if (!userCode) {
          console.warn(`[NA] [TOOL:${funcName}] \u81ea\u5b9a\u4e49 code \u5de5\u5177\u7f3a\u5c11 code \u5b57\u6bb5`);
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
      console.warn(`[NA] [TOOL:${funcName}] \u6761\u76ee content JSON \u89e3\u6790\u5931\u8d25:`, e.message, "content preview:", (entry.content || "").substring(0, 200));
      return null;
    }
  }

  _validateUserCode(code) {
    try {
      new Function("params", "state", code);
      return true;
    } catch (e) {
      console.warn(`[NA] code \u8bed\u6cd5\u6821\u9a8c\u5931\u8d25:`, e.message);
      console.warn(`[NA] \u4ee3\u7801\u7247\u6bb5:`, code.substring(0, 200));
      return false;
    }
  }

  async getActiveTools(matchText) {
    const entries = await this._getAll();
    const recentText = matchText !== undefined ? matchText : this._getRecentChatText(2);
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
          console.warn(`[NA] \u5de5\u5177 "${tool.function.name}" \u91cd\u590d\u6ce8\u518c\uff0c\u5df2\u8df3\u8fc7\u540e\u7eed\u540c\u540d\u6761\u76ee`);
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
          description: "\u4ece\u53d9\u4e8b\u6587\u672c\u4e2d\u63d0\u53d6\u53d8\u91cf\u72b6\u6001\u53d8\u66f4\uff0c\u8f93\u51fa JSON Patch \u683c\u5f0f",
          parameters: { type: "object", properties: {}, required: [] },
        },
        context: ["narrative_text", "state_summary"],
        system_prompt: `${SHARED_ANALYSIS_PREFIX}\n\n\u3010\u4efb\u52a1\uff1a\u53d8\u91cf\u72b6\u6001\u63d0\u53d6\u3011\n\u4ece\u53d9\u4e8b\u6587\u672c\u4e2d\u63d0\u53d6\u4e16\u754c\u72b6\u6001\u53d8\u66f4\uff0c\u8f93\u51fa JSON Patch \u683c\u5f0f\u3002\n\n\u8f93\u51fa\u4e25\u683c\u7684 JSON \u683c\u5f0f\uff1a\n{\n  "patches": [\n    { "op": "replace", "path": "/\u4e16\u754c/\u5f53\u524d\u5730\u70b9", "value": "\u77ff\u6d1e" },\n    { "op": "delta", "path": "/\u4e3b\u89d2/\u4fe1\u7528\u70b9\u6570", "value": -200 },\n    { "op": "insert", "path": "/\u4e3b\u89d2/\u6539\u4ef6\u4ed3\u5e93/-", "value": "\u6da1\u8f6e\u589e\u538b\u5668V2" },\n    { "op": "remove", "path": "/\u4e3b\u89d2/\u6539\u4ef6\u4ed3\u5e93/0" }\n  ]\n}\n\nJSON Patch \u64cd\u4f5c\u7c7b\u578b\uff1a\n- replace: \u66ff\u6362\u5b57\u6bb5\u503c\uff0cpath \u6307\u5411\u5df2\u6709\u5b57\u6bb5\uff0cvalue \u4e3a\u65b0\u503c\n- delta: \u6570\u503c\u589e\u51cf\uff0cpath \u6307\u5411\u6570\u503c\u5b57\u6bb5\uff0cvalue \u4e3a\u53d8\u5316\u91cf\uff08\u53ef\u4e3a\u8d1f\uff09\n- insert: \u521b\u5efa\u65b0\u5b57\u6bb5\u6216\u5411\u6570\u7ec4\u8ffd\u52a0\uff0cpath \u6307\u5411\u65b0\u4f4d\u7f6e\uff0cvalue \u4e3a\u65b0\u503c\n- remove: \u5220\u9664\u5b57\u6bb5\uff0cpath \u6307\u5411\u8981\u5220\u9664\u7684\u5b57\u6bb5\n- move: \u79fb\u52a8\u5b57\u6bb5\uff0cfrom \u4e3a\u6e90\u8def\u5f84\uff0cpath \u4e3a\u76ee\u6807\u8def\u5f84\n\npath \u4f7f\u7528 / \u5206\u9694\u7684 JSON Pointer \u8def\u5f84\uff0c\u5bf9\u5e94\u53d8\u91cf\u6811\u4e2d\u7684\u5c42\u7ea7\u3002\n\n\u5982\u679c\u6ca1\u6709\u72b6\u6001\u53d8\u66f4\uff0c\u8f93\u51fa\uff1a{ "patches": [] }\n\n\u8865\u5145\u89c4\u5219\uff1a\n- \u4ec5\u5bf9\u300c\u5f53\u524d\u53d8\u91cf\u72b6\u6001\u300d\u4e2d\u5217\u51fa\u7684\u5df2\u6709\u8def\u5f84\u6267\u884c\u64cd\u4f5c\uff0c\u4e0d\u8981\u51ed\u7a7a\u521b\u5efa\u65b0\u7684\u4e00\u7ea7\u5206\u7c7b\n${mvuRules ? "\n\n\u4ee5\u4e0b\u662f\u53d8\u91cf\u66f4\u65b0\u89c4\u5219\uff0c\u8bf7\u4e25\u683c\u9075\u5faa\uff1a\n" + mvuRules : ""}`,
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