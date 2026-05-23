export function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  return text.substring(0, maxLen) + "...";
}

export function stripStatePanel(text) {
  if (!text) return text;
  return text.replace(/<state_panel>[\s\S]*?<\/state_panel>/g, "").trim();
}

export function stripMvuTags(text) {
  if (!text) return text;
  let result = text;
  result = result.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g, "").trim();
  const contentMatch = result.match(/<content>([\s\S]*?)<\/content>/);
  if (contentMatch) result = contentMatch[1].trim();
  return result;
}

export function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function getSTContext() {
  try { return window.SillyTavern?.getContext() ?? null; } catch { return null; }
}

export function extractPresetContext(chat, formattingSet) {
  const systemContext = [];
  let activeModePrompt = "";

  for (const msg of chat) {
    if (msg.role === "system" && msg.content && msg.content.trim()) {
      const trimmed = msg.content.trim();
      if (_isEntryExcluded(trimmed, formattingSet)) continue;
      const cleaned = _stripFormattingContent(trimmed, formattingSet);
      if (cleaned) systemContext.push(cleaned);
    }
    if (msg.role === "user" && msg.content && msg.content.length > 100) {
      activeModePrompt = msg.content;
    }
  }

  return {
    planningContext: systemContext.length > 0 ? systemContext.join("\n\n") : "",
    writingSystemContext: systemContext.length > 0 ? systemContext.join("\n\n") : "",
    writingUserContext: activeModePrompt || "",
  };
}

export function _stripFormattingContent(text, formattingSet) {
  if (!text || typeof text !== "string") return text;
  if (!formattingSet || formattingSet.size === 0) return text;
  let result = text;
  for (const fmt of formattingSet) {
    if (!fmt || fmt.length === 0) continue;
    let idx;
    while ((idx = result.indexOf(fmt)) !== -1) {
      result = result.slice(0, idx) + result.slice(idx + fmt.length);
    }
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

export function _isEntryExcluded(content, formattingSet) {
  if (_isToolEntryContent(content)) return true;
  if (formattingSet && formattingSet.has(content)) return true;
  return false;
}

export function _isToolEntryContent(content) {
  if (!content || typeof content !== "string") return false;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const validTypes = ["llm", "code"];
    return validTypes.includes(parsed.type)
      && parsed.function
      && typeof parsed.function === "object"
      && typeof parsed.function.name === "string";
  } catch {
    return false;
  }
}

export function parseTextToVariables(text) {
  if (!text || typeof text !== "string") return null;
  const lines = text.split("\n");
  const stack = [{ indent: -1, key: null, obj: {} }];
  const root = stack[0].obj;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    const colonIdx = content.indexOf(":");

    if (colonIdx === -1) continue;

    const key = content.substring(0, colonIdx).trim();
    const value = content.substring(colonIdx + 1).trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];

    if (value === "") {
      const newObj = {};
      if (Array.isArray(parent.obj)) {
        parent.obj.push(newObj);
      } else {
        parent.obj[key] = newObj;
      }
      stack.push({ indent, key, obj: newObj });
    } else {
      let parsed;
      if (value === "true" || value === "false") {
        parsed = value === "true";
      } else if (/^-?\d+$/.test(value)) {
        parsed = parseInt(value, 10);
      } else if (/^-?\d+\.\d+$/.test(value)) {
        parsed = parseFloat(value);
      } else {
        parsed = value;
      }
      if (Array.isArray(parent.obj)) {
        parent.obj.push(parsed);
      } else {
        parent.obj[key] = parsed;
      }
    }
  }

  return Object.keys(root).length > 0 ? root : null;
}

export function getConversationId() {
  try { const ctx = getSTContext(); return ctx?.chatId || ctx?.characterId || "default"; } catch { return "default"; }
}

export function getLatestUserInput(chat) {
  if (!chat || !Array.isArray(chat) || chat.length === 0) return "";
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i] && chat[i].is_user && chat[i].mes) return chat[i].mes;
  }
  return "";
}