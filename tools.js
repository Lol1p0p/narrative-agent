import { rollDice } from "./dice.js";
import { callLLM } from "./llm.js";

export async function executeTools(toolDefs, ctx) {
  if (!Array.isArray(toolDefs) || toolDefs.length === 0) {
    return {\u7ed3\u679c\u6587\u672c: "", \u53d8\u91cf\u53d8\u66f4: [], \u5de5\u5177\u6267\u884c\u8be6\u60c5: []};
  }

  const details = [];
  let resultText = "";
  const changes = [];

  for (const tool of toolDefs) {
    const name = tool.function?.name || "\u672a\u77e5\u5de5\u5177";
    if (name === "roll_dice") {
      const diceCtx = {
        user_input: ctx.userInput,
        userPersona: ctx.userPersona,
        stateSummary: ctx.stateSummary,
        narrativeText: ctx.narrativeText,
      };
      const detail = executeRollDiceTool(tool, diceCtx);
      details.push(detail);
      resultText += "\n\n" + detail.text;
    } else if (tool.type === "llm") {
      const detail = await executeLLMTool(tool, ctx);
      details.push(detail);
      resultText += "\n\n" + detail.text;
      if (Array.isArray(detail.changes)) changes.push(...detail.changes);
    } else if (tool.type === "code") {
      const detail = executeCodeTool(tool, ctx);
      details.push(detail);
      resultText += "\n\n" + detail.text;
      if (Array.isArray(detail.changes)) changes.push(...detail.changes);
    } else {
      console.warn(`[tools] \u672a\u77e5\u5de5\u5177\u7c7b\u578b: ${tool.type} \u7528\u4e8e ${name}\uff0c\u8df3\u8fc7`);
    }
  }

  return { \u7ed3\u679c\u6587\u672c: resultText.trim(), \u53d8\u91cf\u53d8\u66f4: changes, \u5de5\u5177\u6267\u884c\u8be6\u60c5: details };
}

function executeRollDiceTool(tool, ctx) {
  try {
    const args = (tool.function?.arguments || {});
    let expression = args.expression || args.formula || "";
    const mode = args.mode || "normal";

    if (!expression && typeof args._raw === "string") {
      try { const raw = JSON.parse(args._raw); expression = raw.expression || expression; } catch {}
    }

    if (!expression) {
      return { \u5de5\u5177: "roll_dice", \u8f93\u5165: args, \u7ed3\u679c: "\u9519\u8bef: \u672a\u63d0\u4f9b\u9ab0\u5b50\u8868\u8fbe\u5f0f", \u6587\u672c: "\u9519\u8bef: \u672a\u63d0\u4f9b\u9ab0\u5b50\u8868\u8fbe\u5f0f", \u53d8\u66f4: [] };
    }

    console.log(`[tools] roll_dice: "${expression}" mode="${mode}"`);
    const result = rollDice(expression, mode);
    if (result.error) {
      return { \u5de5\u5177: "roll_dice", \u8f93\u5165: { expression, mode }, \u7ed3\u679c: result.error, \u6587\u672c: result.error, \u53d8\u66f4: [] };
    }

    const verbose = [];
    if (result.rolls && result.rolls.length > 0) {
      verbose.push(`\u9ab0\u5b50: ${result.expression} = [${result.rolls.join(", ")}]`);
    }
    if (result.modifier !== 0) {
      verbose.push(`\u4fee\u6b63\u503c: ${result.modifier > 0 ? "+" : ""}${result.modifier}`);
    }
    verbose.push(`\u7ed3\u679c: ${result.total}`);
    const text = verbose.join("\n");

    return { \u5de5\u5177: "roll_dice", \u8f93\u5165: { expression, mode }, \u7ed3\u679c: result, \u6587\u672c: text, \u53d8\u66f4: [] };
  } catch (e) {
    console.error("[tools] roll_dice error:", e);
    return { \u5de5\u5177: "roll_dice", \u8f93\u5165: null, \u7ed3\u679c: null, \u6587\u672c: `\u9519\u8bef: ${e.message}`, \u53d8\u66f4: [] };
  }
}

async function executeLLMTool(tool, ctx) {
  const name = tool.function?.name || "\u672a\u77e5LLM\u5de5\u5177";
  const description = tool.function?.description || "";
  try {
    console.log(`[tools] llm: ${name}`);
    const systemContent = tool.system_prompt || "";
    const messages = [{ role: "system", content: systemContent }];

    const contextSources = Array.isArray(tool.context) ? tool.context : [];
    let userContent = "";

    for (const source of contextSources) {
      switch (source) {
        case "user_input":
          userContent += `<user_input>\n${ctx.userInput}\n</user_input>\n\n`;
          break;
        case "state_summary":
          userContent += `<state_summary>\n${ctx.stateSummary}\n</state_summary>\n\n`;
          break;
        case "narrative_text":
          userContent += `<narrative_text>\n${ctx.narrativeText || ""}\n</narrative_text>\n\n`;
          break;
        case "planning_output":
          userContent += `<planning_output>\n${ctx.planningOutput || ""}\n</planning_output>\n\n`;
          break;
        case "user_persona":
          if (ctx.userPersona) userContent += `<user_persona>\n${ctx.userPersona}\n</user_persona>\n\n`;
          break;
        default:
          console.warn(`[tools] ${name}: \u672a\u77e5\u4e0a\u4e0b\u6587\u6e90 "${source}"`);
      }
    }

    if (!userContent.trim()) {
      userContent = `<user_input>\n${ctx.userInput}\n</user_input>`;
    }

    const instruction = tool.function?.instruction || description;
    if (instruction) userContent += `\n<instruction>\n${instruction}\n</instruction>`;
    userContent += "\n\u8bf7\u8f93\u51fa\u5206\u6790\u7ed3\u679c\u3002";

    messages.push({ role: "user", content: userContent });
    const raw = await callLLM(messages, { label: `tool:${name}` });
    console.log(`[tools] ${name} raw output:`, raw);

    const changes = [];
    let parsed = null;
    if (typeof raw === "string") {
      const clean = raw.trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch {}
      }
    }

    const patches = parsed?.patches;
    if (Array.isArray(patches) && patches.length > 0) {
      for (const p of patches) {
        if (p && typeof p === "object" && p.op && p.path) {
          changes.push({ op: p.op, path: p.path, value: p.value ?? null, from: p.from ?? null });
        }
      }
    }

    return { \u5de5\u5177: name, \u8f93\u5165: { context: contextSources }, \u7ed3\u679c: parsed, \u6587\u672c: raw, \u53d8\u66f4: changes };
  } catch (e) {
    console.error(`[tools] ${name} error:`, e);
    return { \u5de5\u5177: name, \u8f93\u5165: null, \u7ed3\u679c: null, \u6587\u672c: `\u9519\u8bef: ${e.message}`, \u53d8\u66f4: [] };
  }
}

function executeCodeTool(tool, ctx) {
  const name = tool.function?.name || "\u672a\u77e5\u4ee3\u7801\u5de5\u5177";
  try {
    console.log(`[tools] code: ${name}`);

    const params = tool.function?.arguments || {};
    const state = {};
    if (ctx.stateSummary) state.summary = ctx.stateSummary;
    if (ctx.userInput) state.userInput = ctx.userInput;

    let result;
    if (tool.userCode && typeof tool.userCode === "string" && tool.userCode.trim()) {
      console.log(`[tools] ${name}: \u6267\u884c\u81ea\u5b9a\u4e49\u4ee3\u7801`);
      const fn = new Function("params", "state", tool.userCode);
      result = fn(params, state);
    } else {
      console.warn(`[tools] ${name}: \u4ee3\u7801\u5de5\u5177\u6ca1\u6709 userCode`);
      result = "\u9519\u8bef: \u4ee3\u7801\u5de5\u5177\u672a\u63d0\u4f9b userCode";
    }

    let text = "";
    let changes = [];
    if (result && typeof result === "object") {
      text = result.text || result.output || JSON.stringify(result);
      if (Array.isArray(result.changes)) changes = result.changes;
    } else {
      text = String(result ?? "");
    }

    return { \u5de5\u5177: name, \u8f93\u5165: null, \u7ed3\u679c: result, \u6587\u672c: text, \u53d8\u66f4: changes };
  } catch (e) {
    console.error(`[tools] ${name} error:`, e);
    return { \u5de5\u5177: name, \u8f93\u5165: null, \u7ed3\u679c: null, \u6587\u672c: `\u9519\u8bef: ${e.message}`, \u53d8\u66f4: [] };
  }
}

export function parseToolCalls(planningResult) {
  const toolCalls = [];
  if (!planningResult || !Array.isArray(planningResult.tool_calls)) return toolCalls;
  if (planningResult.tool_calls.length === 0) return toolCalls;
  return planningResult.tool_calls.map((tc, idx) => {
    let raw = tc;
    if (typeof tc === "string") {
      try { raw = JSON.parse(tc); } catch { return null; }
    }
    const name = raw.name || raw.tool || raw.function?.name || "";
    const args = raw.arguments || raw.args || raw.parameters || {};
    return { \u5e8f\u53f7: idx + 1, \u5de5\u5177\u540d\u79f0: name, \u53c2\u6570: args };
  }).filter(Boolean);
}

export function buildToolDeclarationsFromDefs(toolDefs) {
  if (!Array.isArray(toolDefs) || toolDefs.length === 0) return "";
  return toolDefs
    .map(t => {
      const fn = t.function || {};
      const params = fn.parameters && typeof fn.parameters === "object" && Object.keys(fn.parameters).length > 0
        ? JSON.stringify(fn.parameters) : "\u65e0\u53c2\u6570";
      return `- ${fn.name}: ${fn.description || "\u65e0\u63cf\u8ff0"} (${params})`;
    })
    .join("\n");
}