export function getMvuStateSummary(mvuData) {
  if (!mvuData || !mvuData.stat_data) return "\uff08\u65e0 MVU \u6570\u636e\uff09";

  const s = mvuData.stat_data;
  const lines = [];

  function walk(obj, prefix, depth) {
    if (depth > 4) return;
    if (obj === null || obj === undefined) return;

    if (typeof obj === "object" && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj)) {
        if (key.startsWith("_")) continue;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          lines.push(`${prefix}${key}:`);
          walk(value, prefix + "  ", depth + 1);
        } else if (Array.isArray(value)) {
          lines.push(`${prefix}${key}: [${value.join(", ")}]`);
        } else {
          lines.push(`${prefix}${key}: ${value}`);
        }
      }
    }
  }

  walk(s, "", 0);
  return lines.join("\n") || "\uff08\u7a7a\u72b6\u6001\uff09";
}