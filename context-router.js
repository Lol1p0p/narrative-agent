export class ContextRouter {
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

  async buildWritingContext(writingGuide, userInput, recentNarratives, systemEntries, selectiveEntries, writingSystemPreset, writingUserPreset, toolResultsText, beforeCharEntries, textRecall = null) {
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
      textRecall: textRecall || null,
    };
  }

  buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary) {
    return {
      turnId: turnId || "",
      events: [],
      userInput,
      narrativeText,
      stateSummary: stateSummary || this.stateManager.getSummary(),
      changedPatches: "",
      postPipelineToolSuffix: "",
    };
  }
}