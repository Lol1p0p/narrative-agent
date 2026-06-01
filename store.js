import { STORAGE_PREFIX } from "./constants.js";

export class FileManager {
  constructor(conversationId) { this.basePath = `conversations/${conversationId}`; }

  saveCheckpoint(turnId, stateDict, summaryDict, mvuData = null) {
    const key = `${STORAGE_PREFIX}${this.basePath}/checkpoints/${turnId}.json`;
    const data = JSON.stringify({ state: stateDict, summary: summaryDict, mvuData });
    try {
      localStorage.setItem(key, data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "QuotaExceededError") {
        console.warn("[FileManager] localStorage quota exceeded, pruning...");
        this._pruneOldest(20);
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

  async exportConversation() {
    const data = { checkpoints: {} };
    const prefix = `${STORAGE_PREFIX}${this.basePath}/checkpoints/`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        const filename = key.replace(prefix, "");
        const content = localStorage.getItem(key);
        data.checkpoints[filename] = content ? JSON.parse(content) : null;
      }
    }
    return data;
  }

  static cleanupChat(chatId) {
    if (!chatId) return;
    const prefix = `${STORAGE_PREFIX}conversations/${chatId}/checkpoints/`;
    const keysToDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) keysToDelete.push(key);
    }
    for (const key of keysToDelete) localStorage.removeItem(key);
    console.log(`[FileManager] 清理已删除聊天的 checkpoints: ${chatId}, 删除 ${keysToDelete.length} 个快照`);
  }

  _pruneOldest(count) {
    const prefix = `${STORAGE_PREFIX}${this.basePath}/checkpoints/`;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    keys.sort((a, b) => a.localeCompare(b));
    for (let i = 0; i < Math.min(count, keys.length); i++) {
      const removed = keys[i].replace(prefix, "");
      console.log(`[FileManager] pruned checkpoint: ${removed}`);
      localStorage.removeItem(keys[i]);
    }
  }
}
