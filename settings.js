import { getSTContext, getConversationId, deepMerge } from "./utils.js";
import { StateManager, SummaryStore } from "./state.js";
import { DEFAULT_CONFIG, EXTENSION_ID } from "./constants.js";

export function loadConfig() {
  try {
    const ctx = getSTContext();
    if (!ctx) return { ...DEFAULT_CONFIG };
    const saved = ctx.extensionSettings?.[EXTENSION_ID]?.config;
    if (saved && typeof saved === "object") return deepMerge({ ...DEFAULT_CONFIG }, saved);
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config) {
  try {
    const ctx = getSTContext();
    if (!ctx) return;
    ctx.extensionSettings[EXTENSION_ID] = ctx.extensionSettings[EXTENSION_ID] || {};
    ctx.extensionSettings[EXTENSION_ID].config = config;
    ctx.extensionSettings[EXTENSION_ID].enabled = config.enabled;
    if (typeof ctx.saveSettingsDebounced === "function") ctx.saveSettingsDebounced();
  } catch { /* ignore */ }
}

export function loadOrCreateState(chatId) {
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

export function loadOrCreateSummary(chatId) {
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

export function persistState(orchestrator, config, currentChatId) {
  try {
    const ctx = getSTContext();
    if (!ctx || !orchestrator) return;
    const chatId = currentChatId || getConversationId();
    ctx.extensionSettings[EXTENSION_ID] = ctx.extensionSettings[EXTENSION_ID] || {};
    ctx.extensionSettings[EXTENSION_ID].enabled = config.enabled;

    if (config.enabled) {
      ctx.extensionSettings[EXTENSION_ID].chatStates = ctx.extensionSettings[EXTENSION_ID].chatStates || {};
      ctx.extensionSettings[EXTENSION_ID].chatStates[chatId] = {
        gameState: orchestrator.stateManager.toDict(),
        summaryStore: orchestrator.summaryStore.toDict(),
      };
    }

    if (ctx.extensionSettings[EXTENSION_ID].summaryStore) {
      delete ctx.extensionSettings[EXTENSION_ID].summaryStore;
    }
    if (ctx.extensionSettings[EXTENSION_ID].gameState) {
      delete ctx.extensionSettings[EXTENSION_ID].gameState;
    }

    if (typeof ctx.saveSettingsDebounced === "function") ctx.saveSettingsDebounced();
  } catch { /* ignore */ }
}