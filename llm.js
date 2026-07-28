import { getSTContext } from "./utils.js";

let llmCallCount = 0;

export async function callLLM(messages, options) {
  llmCallCount++;
  const label = (options && options.label) || `call_${llmCallCount}`;
  const maxRetries = (options && options.retries) || 1;

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) console.log(`[LLMClient] ${label} \u91cd\u8bd5 ${attempt}/${maxRetries}`);
      console.log(`[LLMClient] ${label} \u8c03\u7528, messages \u6570\u91cf:`, messages.length);
      const ctx = getSTContext();
      if (!ctx) throw new Error("SillyTavern context not available");
      const result = await ctx.generateRaw({ prompt: messages });
      const text = extractText(result);
      if (!text || (typeof text === "string" && text.trim().length === 0)) {
        throw new Error("[LLMClient] generateRaw \u8fd4\u56de\u7a7a\u5185\u5bb9\uff0c\u8bf7\u6c42\u53ef\u80fd\u88ab\u53d6\u6d88\u6216API\u9519\u8bef");
      }
      console.log(`[LLMClient] ${label} \u8fd4\u56de, \u957f\u5ea6:`, text.length);
      return text;
    } catch (err) {
      lastErr = err;
      if (isAbortError(err)) throw new Error("Pipeline cancelled");
      if (!isRetryable(err)) break;
    }
  }
  console.error(`[LLMClient] ${label} \u5931\u8d25:`, lastErr);
  throw lastErr || new Error(`[LLMClient] ${label} failed`);
}

export function extractText(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    if (result.choices?.[0]?.message?.content) return result.choices[0].message.content;
    if (result.message?.content) return result.message.content;
  }
  return String(result || "");
}

export function isAbortError(err) {
  const msg = (err && err.message) || "";
  return msg.includes("abort") || msg.includes("Abort") || msg.includes("Cancelled by stop");
}

export function isRetryable(err) {
  const msg = (err && err.message) || "";
  if (msg.includes("fetch") || msg.includes("network") || msg.includes("ECONN")) return true;
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) return true;
  if (msg.includes("429") || msg.includes("rate")) return true;
  if (/\b5\d{2}\b/.test(msg)) return true;
  return false;
}