export function parsePlanningOutput(rawText) {
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[NA] parsePlanningOutput: \u672a\u627e\u5230JSON, rawText\u524d100\u5b57:", rawText?.substring(0, 100));
      return getDefaultPlan();
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      narrative_direction: parsed.narrative_direction || "",
      key_points: Array.isArray(parsed.key_points) ? parsed.key_points : [],
      tone: parsed.tone || "\u4e2d",
      pacing: ["\u5feb", "\u4e2d", "\u6162"].includes(parsed.pacing) ? parsed.pacing : "\u4e2d",
      continuity_notes: Array.isArray(parsed.continuity_notes) ? parsed.continuity_notes : [],
      tool_calls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [],
    };
  } catch (e) {
    console.warn("[NA] parsePlanningOutput: JSON\u89e3\u6790\u5931\u8d25,", e.message, "rawText\u524d100\u5b57:", rawText?.substring(0, 100));
    return getDefaultPlan();
  }
}

export function getDefaultPlan() {
  return { narrative_direction: "", key_points: [], tone: "\u4e2d", pacing: "\u4e2d", continuity_notes: [], tool_calls: [] };
}

export function parseExtractionOutput(rawText) {
  if (!rawText || typeof rawText !== "string") return { events: [] };
  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { events: [] };
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { events: [] };
    if (!Array.isArray(parsed.events)) return { events: [] };
    return { events: parsed.events.filter(ev => ev && typeof ev === "object" && typeof ev.type === "string") };
  } catch { return { events: [] }; }
}

export function parseMergedOutput(rawText) {
  const result = { events: [], summary_entries: [] };
  if (!rawText || typeof rawText !== "string") return result;

  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[NA] parseMergedOutput: \u672a\u627e\u5230JSON");
      return result;
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed.events)) {
      result.events = parsed.events.filter(ev => ev && typeof ev === "object" && typeof ev.type === "string");
    }
    if (Array.isArray(parsed.summary_entries)) {
      result.summary_entries = parsed.summary_entries.filter(s => typeof s === "string" && s.trim().length > 0);
    }
  } catch (e) {
    console.warn("[NA] parseMergedOutput: JSON\u89e3\u6790\u5931\u8d25", e.message);
  }
  return result;
}