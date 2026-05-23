export class StateManager {
  constructor(state) {
    this.state = state || {
      time: { day: 1, hour: 0, minute: 0 },
      location: "\u8d77\u70b9",
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
      this._log("remove_item", { item, quantity: qty }, false, `\u5e93\u5b58\u4e0d\u8db3: \u9700\u8981${qty}, \u5f53\u524d${current}`);
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
      this._log("advance_quest", { quest_id: questId, stage }, false, "\u4efb\u52a1\u4e0d\u5b58\u5728\u6216\u975e\u6d3b\u8dc3");
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
    lines.push(`\u65f6\u95f4\uff1a\u7b2c${s.time.day}\u5929 ${String(s.time.hour).padStart(2, "0")}:${String(s.time.minute).padStart(2, "0")}`);
    lines.push(`\u5730\u70b9\uff1a${s.location}`);
    const inv = Object.entries(s.inventory).map(([k, v]) => `${k}x${v}`).join(", ") || "\u65e0";
    lines.push(`\u7269\u54c1\uff1a${inv}`);
    const rel = Object.entries(s.relationships).map(([k, v]) => `${k}: ${v}`).join(", ") || "\u65e0";
    lines.push(`NPC\u5173\u7cfb\uff1a${rel}`);
    const quests = Object.entries(s.quests).map(([id, q]) => `${id}(${q.status}@${q.stage || ""})`).join(", ") || "\u65e0";
    lines.push(`\u4efb\u52a1\uff1a${quests}`);
    const flags = Object.entries(s.flags).map(([k, v]) => `${k}=${v}`).join(", ") || "\u65e0";
    lines.push(`\u6807\u8bb0\uff1a${flags}`);
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
    s.location = data.location || "\u8d77\u70b9";
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
        if (!loc || typeof loc !== "string" || loc.trim() === "") return { accepted: false, reason: "location \u5fc5\u987b\u662f\u975e\u7a7a\u5b57\u7b26\u4e32" };
        return { accepted: true };
      }
      case "add_item": {
        if (!params.item || typeof params.item !== "string" || params.item.trim() === "") return { accepted: false, reason: "item \u5fc5\u987b\u662f\u975e\u7a7a\u5b57\u7b26\u4e32" };
        return { accepted: true };
      }
      case "remove_item": {
        if (!params.item || typeof params.item !== "string") return { accepted: false, reason: "item \u5fc5\u987b\u662f\u975e\u7a7a\u5b57\u7b26\u4e32" };
        const qty = params.quantity || 1;
        if (typeof qty !== "number" || qty <= 0) return { accepted: false, reason: "quantity \u5fc5\u987b\u4e3a\u6b63\u6570" };
        if ((this.state.inventory[params.item] || 0) < qty) return { accepted: false, reason: `\u7269\u54c1 "${params.item}" \u5e93\u5b58\u4e0d\u8db3` };
        return { accepted: true };
      }
      case "set_relationship": {
        if (!params.npc || typeof params.npc !== "string") return { accepted: false, reason: "npc \u5fc5\u987b\u662f\u975e\u7a7a\u5b57\u7b26\u4e32" };
        if (typeof params.value !== "number" || params.value < -100 || params.value > 100) return { accepted: false, reason: "value \u5fc5\u987b\u5728 -100 \u5230 100 \u4e4b\u95f4" };
        return { accepted: true };
      }
      case "modify_relationship": {
        if (!params.npc || typeof params.npc !== "string") return { accepted: false, reason: "npc \u5fc5\u987b\u662f\u975e\u7a7a\u5b57\u7b26\u4e32" };
        if (typeof params.delta !== "number") return { accepted: false, reason: "delta \u5fc5\u987b\u662f\u6570\u5b57" };
        return { accepted: true };
      }
      case "advance_quest": {
        if (!params.quest_id || typeof params.quest_id !== "string") return { accepted: false, reason: "quest_id \u5fc5\u987b\u662f\u975e\u7a7a\u5b57\u7b26\u4e32" };
        if (!params.stage || typeof params.stage !== "string") return { accepted: false, reason: "stage \u5fc5\u987b\u662f\u975e\u7a7a\u5b57\u7b26\u4e32" };
        const q = this.state.quests[params.quest_id];
        if (!q) return { accepted: false, reason: `\u4efb\u52a1 "${params.quest_id}" \u4e0d\u5b58\u5728` };
        if (q.status !== "active") return { accepted: false, reason: `\u4efb\u52a1 "${params.quest_id}" \u72b6\u6001\u4e3a ${q.status}\uff0c\u65e0\u6cd5\u63a8\u8fdb` };
        return { accepted: true };
      }
      case "complete_quest": {
        if (!params.quest_id || typeof params.quest_id !== "string") return { accepted: false, reason: "quest_id \u5fc5\u987b\u662f\u975e\u7a7a\u5b57\u7b26\u4e32" };
        const outcome = params.outcome || "success";
        if (outcome !== "success" && outcome !== "failure") return { accepted: false, reason: "outcome \u5fc5\u987b\u662f success \u6216 failure" };
        const q = this.state.quests[params.quest_id];
        if (!q) return { accepted: false, reason: `\u4efb\u52a1 "${params.quest_id}" \u4e0d\u5b58\u5728` };
        if (q.status !== "active") return { accepted: false, reason: `\u4efb\u52a1 "${params.quest_id}" \u72b6\u6001\u4e3a ${q.status}\uff0c\u65e0\u6cd5\u5b8c\u6210` };
        return { accepted: true };
      }
      case "start_quest": {
        if (!params.quest_id || typeof params.quest_id !== "string") return { accepted: false, reason: "quest_id \u5fc5\u987b\u662f\u975e\u7a7a\u5b57\u7b26\u4e32" };
        const existing = this.state.quests[params.quest_id];
        if (existing && existing.status === "active") return { accepted: false, reason: `\u4efb\u52a1 "${params.quest_id}" \u5df2\u5728\u8fdb\u884c\u4e2d` };
        return { accepted: true };
      }
      case "set_flag": {
        if (!params.flag || typeof params.flag !== "string" || params.flag.trim() === "") return { accepted: false, reason: "flag \u5fc5\u987b\u662f\u975e\u7a7a\u5b57\u7b26\u4e32" };
        return { accepted: true };
      }
      case "pass_time": return { accepted: true };
      default: return { accepted: false, reason: `\u4e0d\u652f\u6301\u7684\u4e8b\u4ef6\u7c7b\u578b\uff1a${event.type}` };
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

export class SummaryStore {
  constructor() { this._entries = []; }

  getCurrentSummary() { return this._entries.join("\n"); }
  getAllSummaries() { return this._entries.length > 0 ? this._entries.join("\n") : "\uff08\u5c1a\u65e0\u6545\u4e8b\u6458\u8981\uff09"; }
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