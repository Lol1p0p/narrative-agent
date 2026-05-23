import { truncate, getSTContext } from "./utils.js";

export class CharacterReader {
  constructor() { this._cache = null; this._cacheId = null; this._fullCache = null; this._fullCacheId = null; }

  _getCard() {
    const ctx = getSTContext();
    if (!ctx) return null;
    const id = ctx.characterId;
    if (this._cacheId === id && this._cache) return this._cache;
    this._cacheId = id;
    this._cache = ctx.characters?.[id];
    return this._cache;
  }

  async _getFullCard() {
    const ctx = getSTContext();
    if (!ctx) return null;
    const id = ctx.characterId;
    if (id == null) return null;
    if (this._fullCacheId === id && this._fullCache) return this._fullCache;
    const card = ctx.characters?.[id];
    if (!card) return null;
    if (card.shallow && typeof ctx.getOneCharacter === "function") {
      try {
        const fullCard = await ctx.getOneCharacter(card.avatar);
        if (fullCard) {
          this._fullCache = fullCard;
          this._fullCacheId = id;
          return fullCard;
        }
      } catch (e) { console.warn("[NA] getOneCharacter failed:", e); }
    }
    if (typeof ctx.getCharacterCardFields === "function") {
      try {
        const fields = ctx.getCharacterCardFields({ chid: id });
        if (fields) {
          const merged = { ...card };
          if (fields.description) merged.description = fields.description;
          if (fields.personality) merged.personality = fields.personality;
          if (fields.scenario) merged.scenario = fields.scenario;
          if (fields.mesExamples) merged.mes_example = fields.mesExamples;
          if (fields.system) merged.data = { ...merged.data, system_prompt: fields.system };
          if (fields.jailbreak) merged.data = { ...merged.data, post_history_instructions: fields.jailbreak };
          if (fields.creatorNotes) merged.data = { ...merged.data, creator_notes: fields.creatorNotes };
          this._fullCache = merged;
          this._fullCacheId = id;
          return merged;
        }
      } catch (e) { console.warn("[NA] getCharacterCardFields failed:", e); }
    }
    this._fullCache = card;
    this._fullCacheId = id;
    return card;
  }

  getSummary() {
    const card = this._getCard();
    if (!card) return { name: "\u89d2\u8272", personality: "", keySetting: "", scenario: "" };
    const data = card.data || {};
    const get = (field) => data[field] || card[field] || "";
    return {
      name: get("name") || "\u89d2\u8272",
      personality: get("personality"),
      keySetting: truncate(get("description"), 500),
      scenario: get("scenario"),
    };
  }

  getCoreInfo() {
    const card = this._getCard();
    if (!card) return { name: "\u89d2\u8272", personality: "", description: "", systemPrompt: "", postHistoryInstructions: "" };
    const data = card.data || {};
    const get = (field) => data[field] || card[field] || "";
    return {
      name: get("name") || "\u89d2\u8272",
      personality: get("personality"),
      description: get("description"),
      systemPrompt: get("system_prompt"),
      postHistoryInstructions: get("post_history_instructions"),
    };
  }

  async getFullInfo() {
    const card = await this._getFullCard();
    if (!card) return "";
    const data = card.data || {};
    const get = (field) => data[field] || card[field] || "";
    const parts = [];
    const name = data.name || card.name || "";
    if (name) parts.push(`\u3010\u540d\u79f0\u3011${name}`);
    if (get("description")) parts.push(`\u3010\u63cf\u8ff0\u3011\n${get("description")}`);
    if (get("personality")) parts.push(`\u3010\u6027\u683c\u3011\n${get("personality")}`);
    if (get("scenario")) parts.push(`\u3010\u573a\u666f\u3011\n${get("scenario")}`);
    if (get("first_mes")) parts.push(`\u3010\u5f00\u573a\u767d\u3011\n${get("first_mes")}`);
    if (get("mes_example")) parts.push(`\u3010\u5bf9\u8bdd\u793a\u4f8b\u3011\n${get("mes_example")}`);
    if (get("system_prompt")) parts.push(`\u3010\u7cfb\u7edf\u63d0\u793a\u8bcd\u3011\n${get("system_prompt")}`);
    if (get("post_history_instructions")) parts.push(`\u3010\u5386\u53f2\u540e\u6307\u4ee4\u3011\n${get("post_history_instructions")}`);
    if (get("creator_notes")) parts.push(`\u3010\u4f5c\u8005\u5907\u6ce8\u3011\n${get("creator_notes")}`);
    const tags = data.tags || card.tags;
    if (tags && tags.length > 0) parts.push(`\u3010\u6807\u7b7e\u3011${tags.join(", ")}`);
    return parts.join("\n\n");
  }

  getName() {
    const card = this._getCard();
    const data = card?.data || card || {};
    return data.name || card?.name || "\u89d2\u8272";
  }
}

export class UserPersonaReader {
  constructor() { this._cache = null; this._cacheKey = null; }

  _getKey() {
    const ctx = getSTContext();
    if (!ctx?.powerUserSettings) return null;
    const pu = ctx.powerUserSettings;
    return pu.persona_description + "|" + (pu.personas ? Object.keys(pu.personas).length : 0);
  }

  getPersonaInfo() {
    const key = this._getKey();
    if (key === this._cacheKey && this._cache) return this._cache;
    this._cacheKey = key;

    const ctx = getSTContext();
    if (!ctx?.powerUserSettings) {
      console.warn("[NA] UserPersonaReader: powerUserSettings \u4e0d\u53ef\u7528");
      this._cache = "";
      return "";
    }

    const pu = ctx.powerUserSettings;
    const parts = [];

    const name = ctx.name1;
    if (name) parts.push(`\u3010\u7528\u6237\u540d\u3011${name}`);

    let desc = pu.persona_description || "";
    if (!desc) {
      const avatarId = this._getCurrentAvatarId(pu);
      if (avatarId && pu.persona_descriptions?.[avatarId]?.description) {
        desc = pu.persona_descriptions[avatarId].description;
      }
    }
    if (desc && typeof ctx.substituteParams === "function") {
      desc = ctx.substituteParams(desc);
    }
    if (desc) parts.push(`\u3010\u7528\u6237\u8bbe\u5b9a\u3011\n${desc}`);

    this._cache = parts.join("\n\n");
    return this._cache;
  }

  _getCurrentAvatarId(pu) {
    try {
      const block = document.querySelector("#user_avatar_block");
      const selected = block?.querySelector(".avatar-container.selected") || block?.querySelector("[data-avatar-id]");
      return selected?.getAttribute("data-avatar-id") || pu.default_persona || null;
    } catch { return pu.default_persona || null; }
  }
}