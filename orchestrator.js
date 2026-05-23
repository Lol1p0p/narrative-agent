import { StateManager, SummaryStore } from "./state.js";
import { ContextRouter } from "./context-router.js";
import { callLLM } from "./llm.js";
import { runPlanningAgent } from "./agent-planning.js";
import { runWritingAgent, runMergedWritingAgent } from "./agent-writing.js";
import { runMergedAnalysisAgent } from "./agent-analysis.js";
import { getMvuStateSummary } from "./mvu.js";
import { rollDice } from "./dice.js";
import { getSTContext, extractPresetContext, parseTextToVariables } from "./utils.js";
import { DEFAULT_CONFIG, CANONICAL_CONTEXT_ORDER } from "./constants.js";

export class ToolExecutor {
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

export function formatToolResultsForWriting(toolResults) {
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

export function buildToolUserMessage(tool, availableContext) {
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

export class Orchestrator {
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
    this._progressCb = null;
    this.contextRouter = new ContextRouter(deps);
    this.toolExecutor = new ToolExecutor();
  }

  setPresetContext(ctx) {
    this.presetContext = ctx;
  }

  onProgress(cb) {
    this._progressCb = cb;
  }

  _reportProgress(status) {
    if (typeof this._progressCb === "function") {
      try { this._progressCb(status); } catch (e) { /* ignore */ }
    }
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
      this._reportProgress("API请求超时或被打断，工作流意外终止！");
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

    this.worldInfoResolver.ensureFreshCardCache();

    let openingNarrative = "";
    if (this.turnCounter === 0) {
      const stCtx = getSTContext();
      openingNarrative = this._extractContextContent(stCtx?.chat);
      if (openingNarrative) {
        console.log("[NarrativeAgent] 首轮开场白已提取, 长度:", openingNarrative.length);
      }
    }

    const recentTurns = this._getStableRecentTurns(cfg.recentTurnsForPlanning, cfg.planningGrowthMargin || 3);
    const narrativeMatchText = [
      openingNarrative,
      ...recentTurns.map(t => t.user + " " + t.assistant)
    ].filter(Boolean).join(" ");

    const sharedWorld = await this.worldInfoResolver.getFullContent();
    const allTools = await this.worldInfoResolver.getActiveTools(narrativeMatchText);

    const planningTools = allTools.filter(t => t.trigger === "planning");
    const postPipelineTools = allTools.filter(t => t.trigger === "post_pipeline");

    if (planningTools.length === 0) {
      console.log("[NarrativeAgent] 无 planning 工具，切换为合并输出模式");
      return await this._mergedPipeline(userInput, turnId);
    }

    console.log("[NarrativeAgent] Phase 1: Planning");
    this._reportProgress("正在生成写作指导...");

    const systemEntries = await this.worldInfoResolver.getConstantSystemEntries();
    const beforeCharEntries = await this.worldInfoResolver.getConstantBeforeCharEntries();
    const selectiveEntries = await this.worldInfoResolver.getSelectiveActivatedEntries(narrativeMatchText);

    const stateSummary = await this._getStateSummary();
    if (stateSummary && !stateSummary.startsWith("（无")) {
      console.log("[NarrativeAgent] state loaded:", stateSummary.substring(0, 80));
    }

    const planningCtx = await this.contextRouter.buildPlanningContext(
      userInput, recentTurns, systemEntries, beforeCharEntries, selectiveEntries,
      stateSummary, this.presetContext, planningTools
    );
    planningCtx.openingNarrative = openingNarrative;
    const writingGuide = await runPlanningAgent(planningCtx);
    await this.fileManager.save(turnId, "plans", writingGuide);

    const codeToolResults = [];
    const llmToolOutputs = [];
    let toolResultsText = "";
    if (writingGuide.tool_calls && writingGuide.tool_calls.length > 0) {
      console.log("[NarrativeAgent] Phase 1.5: Tool Execution, count:", writingGuide.tool_calls.length);
      this._reportProgress("正在调用工具...");

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

    console.log("[NarrativeAgent] Phase 2: Writing");
    this._reportProgress("正在创作故事...");
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
    writingCtx.openingNarrative = openingNarrative;
    const narrativeText = await runWritingAgent(writingCtx);
    await this.fileManager.save(turnId, "narratives", narrativeText);

    this.turnHistory.push({ userInput, narrativeText });

    this._reportProgress("正在总结整理...");
    const { independent, dependent } = this._classifyPostPipelineTools(postPipelineTools);
    let merged;
    let applicationResult;

    if (this.config.pipeline.parallelExecutionEnabled && independent.length > 0) {
      console.log("[NarrativeAgent] Phase 3+4 (parallel): Analysis + independent tools, independent:", independent.length, "dependent:", dependent.length);

      const preAnalysisContext = await this._buildAvailableContext(sharedWorld, userInput, writingGuide, narrativeText);

      const [analysisResult] = await Promise.all([
        (async () => {
          const stateSummary = await this._getStateSummary();
          const ctx = this.contextRouter.buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary, openingNarrative);
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
      const analysisCtx = this.contextRouter.buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary, openingNarrative);
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

      let openingNarrative = "";
      if (this.turnCounter === 0) {
        const stCtx = getSTContext();
        openingNarrative = this._extractContextContent(stCtx?.chat);
      }

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
        openingNarrative,
      };
      const narrativeText = await runWritingAgent(writingCtx);

      this.turnHistory.push({ userInput, narrativeText });

      const analysisCtx = this.contextRouter.buildMergedAnalysisContext(narrativeText, userInput, turnId, this.stateManager.getSummary(), openingNarrative);
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

    this.worldInfoResolver.ensureFreshCardCache();

    const recentTurns = this._getStableRecentTurns(cfg.recentTurnsForWriting, cfg.writingGrowthMargin || 4);

    let openingNarrative = "";
    if (this.turnCounter === 0) {
      const stCtx = getSTContext();
      openingNarrative = this._extractContextContent(stCtx?.chat);
      if (openingNarrative) {
        console.log("[NarrativeAgent] 首轮开场白已提取, 长度:", openingNarrative.length);
      }
    }

    const narrativeMatchText = [
      openingNarrative,
      ...recentTurns.map(t => t.user + " " + t.assistant)
    ].filter(Boolean).join(" ");

    const sharedWorld = await this.worldInfoResolver.getFullContent();
    const allTools = await this.worldInfoResolver.getActiveTools(narrativeMatchText);
    const postPipelineTools = allTools.filter(t => t.trigger === "post_pipeline");

    console.log("[NarrativeAgent] Phase 1+2: Merged Writing (合并模式)");
    this._reportProgress("正在创作故事...");

    const systemEntries = await this.worldInfoResolver.getConstantSystemEntries();
    const beforeCharEntries = await this.worldInfoResolver.getConstantBeforeCharEntries();
    const selectiveEntries = await this.worldInfoResolver.getSelectiveActivatedEntries(narrativeMatchText);
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
      openingNarrative,
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
    this._reportProgress("正在总结整理...");
    const analysisCtx = this.contextRouter.buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary, openingNarrative);
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

  _extractContextContent(chat) {
    if (!chat || chat.length === 0) return "";
    const parts = [];
    for (const msg of chat) {
      if (!msg || msg.is_user) continue;
      const text = msg.mes || "";
      const contextRegex = /<context>([\s\S]*?)<\/context>/g;
      let match;
      while ((match = contextRegex.exec(text)) !== null) {
        let inner = match[1];
        inner = inner.replace(/```[\s\S]*?```/g, "");
        inner = inner.replace(/<[\p{L}_\|][^>]*>[\s\S]*?<\/[\p{L}_\|][^>]*>/gu, "");
        inner = inner.replace(/<[\p{L}_\|][^>]*\/>/gu, "");
        inner = inner.replace(/\n{3,}/g, "\n\n").trim();
        if (inner) parts.push(inner);
      }
    }
    return parts.join("\n\n");
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