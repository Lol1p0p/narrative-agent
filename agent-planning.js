import { callLLM } from "./llm.js";
import { parsePlanningOutput } from "./parser.js";
import { PLANNING_SYSTEM_SUFFIX } from "./constants.js";

export async function runPlanningAgent(ctx) {
  const recentText = ctx.recentTurns
    .map((t) => `[\u8f6e${t.turnNum}] \u7528\u6237: ${t.user}\n[\u8f6e${t.turnNum}] AI: ${t.assistant}`)
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
  if (ctx.openingNarrative) {
    userContent += `\n\n<opening_narrative>\n${ctx.openingNarrative}\n</opening_narrative>`;
  }
    userContent += `\n\n<recent_turns>\n${recentText}\n</recent_turns>`;
  if (ctx.selectiveEntries && ctx.selectiveEntries.length > 0) {
    userContent += "\n\n<worldinfo3>\n" + ctx.selectiveEntries.join("\n\n") + "\n</worldinfo3>";
  }
  userContent += `\n\n<state_summary>\n${ctx.stateSummary}\n</state_summary>`;
  userContent += `\n\n<user_input>\n${ctx.userInput}\n</user_input>`;
  userContent += "\n\n\u8bf7\u751f\u6210\u5199\u4f5c\u6307\u5bfc\u3002";

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  return parsePlanningOutput(await callLLM(messages, { label: "planning" }));
}