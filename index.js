import { PLACEHOLDER, EXTENSION_ID, DEFAULT_CONFIG } from "./constants.js";
import { StateManager, SummaryStore } from "./state.js";
import { FileManager } from "./store.js";
import { CharacterReader, UserPersonaReader } from "./readers.js";
import { WorldInfoResolver } from "./worldbook.js";
import { Orchestrator } from "./orchestrator.js";
import { SillyTavernBridge } from "./bridge.js";
import { loadConfig, saveConfig, loadOrCreateState, loadOrCreateSummary, persistState } from "./settings.js";
import { getSTContext, getConversationId, deepMerge } from "./utils.js";

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
  bridge.onPipelineComplete(() => { persistState(orchestrator, config, currentChatId); refreshStateDisplay(); });
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

    bridge._aborted = true;

    if (orchestrator._isRunning) {
      console.log("[NarrativeAgent] Chat changed, 正在终止运行中的pipeline...");
      orchestrator._shouldCancel = true;
      const startTime = Date.now();
      while (orchestrator._isRunning && Date.now() - startTime < 30000) {
        await new Promise(r => setTimeout(r, 100));
      }
      if (orchestrator._isRunning) {
        console.warn("[NarrativeAgent] Pipeline终止超时，强制继续切换");
        orchestrator._isRunning = false;
        orchestrator._shouldCancel = true;
      } else {
        console.log("[NarrativeAgent] Pipeline已终止");
      }
    }

    console.log("[NarrativeAgent] Chat changed, saving current state for:", currentChatId);
    persistState(orchestrator, config, currentChatId);

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
      persistState(orchestrator, config, currentChatId);
      refreshStateDisplay($html);
    });

    $html.find("#na_preset_mode").val(config.presetMode || "none");
    $html.find("#na_preset_mode").on("change", function () {
      config.presetMode = $(this).val();
      if (orchestrator) orchestrator.config = config;
      saveConfig(config);
      persistState(orchestrator, config, currentChatId);
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
      persistState(orchestrator, config, currentChatId);
      console.log("[NarrativeAgent] 世界书来源切换为:", config.worldbookSource);
    });

    $html.find("#na_parallel_execution").prop("checked", config.pipeline?.parallelExecutionEnabled === true);
    $html.find("#na_parallel_execution").on("change", function () {
      if (!config.pipeline) config.pipeline = {};
      config.pipeline.parallelExecutionEnabled = $(this).prop("checked");
      if (orchestrator) orchestrator.config = config;
      saveConfig(config);
      persistState(orchestrator, config, currentChatId);
      console.log("[NarrativeAgent] 并行处理切换为:", config.pipeline.parallelExecutionEnabled);
    });

    $html.find("#na_text_recall").prop("checked", config.pipeline?.enableTextRecall === true);
    $html.find("#na_text_recall").on("change", function () {
      if (!config.pipeline) config.pipeline = {};
      config.pipeline.enableTextRecall = $(this).prop("checked");
      if (orchestrator) orchestrator.config = config;
      saveConfig(config);
      persistState(orchestrator, config, currentChatId);
      console.log("[NarrativeAgent] 原文召回切换为:", config.pipeline.enableTextRecall);
    });

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
          persistState(orchestrator, config, currentChatId);
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
        persistState(orchestrator, config, currentChatId);
        refreshStateDisplay($html);
        toastr.info("游戏状态和摘要已重置");
      }
    });

    $html.find("#na_refresh_state").on("click", function () { refreshStateDisplay($html); });

    $html.find("#na_reload_worldbook_cache").on("click", function () {
      if (!orchestrator) return;
      orchestrator.worldInfoResolver.invalidateCache();
      orchestrator.worldInfoResolver.buildFormattingSet().catch(e => console.warn("[NA] 重建格式化集失败:", e.message));
      toastr.info("世界书缓存已刷新");
    });

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