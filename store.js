import { STORAGE_PREFIX } from "./constants.js";

export class FileManager {
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