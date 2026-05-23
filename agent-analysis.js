import { callLLM } from "./llm.js";
import { parseExtractionOutput, parseMergedOutput } from "./parser.js";
import { EXTRACTION_SYSTEM_SUFFIX, MERGED_ANALYSIS_SYSTEM, SHARED_ANALYSIS_PREFIX } from "./constants.js";

export async function runExtractionAgent(ctx) {
  const systemContent = EXTRACTION_SYSTEM_SUFFIX;
  const userContent = `<narrative_text>\n${ctx.narrativeText}\n</narrative_text>\n\n<existing_state>\n${ctx.stateSummary}\n</existing_state>\n\n\u8bf7\u63d0\u53d6\u4e8b\u4ef6`;

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  return parseExtractionOutput(await callLLM(messages, { label: "extraction" }));
}

export async function runMergedAnalysisAgent(ctx) {
  const eventsText = ctx.events
    .map((e) => `- [${e.type}] ${e.summary || "\u65e0\u63cf\u8ff0"} ${e.detail ? "(" + e.detail + ")" : ""}`)
    .join("\n");

  let systemContent = MERGED_ANALYSIS_SYSTEM;

  if (ctx.postPipelineToolSuffix) {
    systemContent += "\n\n" + ctx.postPipelineToolSuffix;
  }

  let userContent = "";
  if (ctx.openingNarrative) {
    userContent += `<opening_narrative>\n${ctx.openingNarrative}\n</opening_narrative>\n\n`;
  }
  userContent += `<user_input>\n${ctx.userInput}\n</user_input>\n\n`;
  userContent += `<narrative_output>\n${ctx.narrativeText}\n</narrative_output>\n\n`;
  userContent += `<events_extracted>\n${eventsText}\n</events_extracted>\n\n`;
  userContent += `<state_summary>\n${ctx.stateSummary}\n</state_summary>\n\n`;
  if (ctx.changedPatches && ctx.changedPatches.trim()) {
    userContent += `<world_state_changes>\n${ctx.changedPatches}\n</world_state_changes>\n\n`;
  }
  userContent += "\u8bf7\u8f93\u51fa\u5206\u6790\u7ed3\u679c\u3002";

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  return parseMergedOutput(await callLLM(messages, { label: "merged-analysis" }));
}

export async function runMergedAnalysisAntiHallucination(ctx) {
  const eventsText = ctx.events
    .map((e) => `- [${e.type}] ${e.summary || "\u65e0\u63cf\u8ff0"} ${e.detail ? "(" + e.detail + ")" : ""}`)
    .join("\n");

  let systemContent = SHARED_ANALYSIS_PREFIX;
  if (ctx.postPipelineToolSuffix) {
    systemContent += "\n\n" + ctx.postPipelineToolSuffix;
  }

  let userContent = "";
  if (ctx.openingNarrative) {
    userContent += `<opening_narrative>\n${ctx.openingNarrative}\n</opening_narrative>\n\n`;
  }
  userContent += `<user_input>\n${ctx.userInput}\n</user_input>\n\n`;
  userContent += `<narrative_text>\n${ctx.narrativeText}\n</narrative_text>\n\n`;
  userContent += `<events_extracted>\n${eventsText}\n</events_extracted>\n\n`;
  userContent += `<state_summary>\n${ctx.stateSummary}\n</state_summary>\n\n`;
  if (ctx.changedPatches && ctx.changedPatches.trim()) {
    userContent += `<world_state_changes>\n${ctx.changedPatches}\n</world_state_changes>\n\n`;
  }
  userContent += "\u8bf7\u8f93\u51fa\u5206\u6790\u7ed3\u679c\u3002";

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  return parseMergedOutput(await callLLM(messages, { label: "merged-analysis-anti-hallucination" }));
}