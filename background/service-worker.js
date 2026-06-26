import { d as defaultModelFor, g as getSettings } from "../chunks/settings-DQva-Qam.js";
const META = `You are an expert prompt engineer. Transform the USER DRAFT into an optimized prompt using best practices from Anthropic (Claude), OpenAI, and Google (Gemini).

━━━ REFINE MODE — for short, clear prompts (≤ ~150 words or simple intent) ━━━
Polish the draft: fix typos, sharpen clarity, add missing specificity.
Keep the original voice and intent. Do not add heavy structure.

━━━ STRUCTURE MODE — for complex, large, or multi-step tasks (≥ ~150 words, technical/creative tasks, or when role context helps) ━━━
Apply full prompt engineering:
• Role / Persona — "You are a [specific expert]..."
• Context — essential background the AI needs to succeed
• Task — clear, specific description; break into steps if needed
• Constraints — what to avoid, tone, scope, limitations
• Output format — structure, length, sections, style
• Examples (optional) — only if they genuinely clarify the expected output

━━━ WHICH MODE TO USE ━━━
Prompt style setting: {{promptStyle}}
- "auto" → assess the draft: choose REFINE for short/clear, STRUCTURE for complex/large
- "refine" → always use REFINE MODE regardless of length
- "structure" → always use STRUCTURE MODE regardless of length

━━━ ALWAYS REWRITE — NO EXCEPTIONS ━━━
You ALWAYS produce a rewrite. Never ask questions. Never output a CLARIFY block.

For vague or incomplete drafts: make reasonable assumptions and produce the best rewrite possible. Add a brief parenthetical note at the end stating key assumptions — e.g. "(Assumed: professional audience, formal tone — use 'Add more context' below to refine.)"

For URLs in the draft: include them verbatim as reference anchors. Never ask what they contain.
For missing details: infer the most reasonable interpretation and proceed.

HARD RULES:
- Never invent proper nouns, names, dates, or numbers not in the draft
- URLs are reference anchors — include verbatim, never question them
- Do not pad with fictional context
- Preserve the user's original intent

OUTPUT — output ONLY this format, nothing else:

### REWRITE ###
<the optimized prompt>
### END ###

No prose before or after the markers. No code fences. Do NOT use a CLARIFY block under any circumstances.

USER SETTINGS:
- Tone: {{tone}}
- Verbosity: {{verbosity}}
- Target site: {{site}}

{{attachments_block}}USER DRAFT:
"""
{{draft}}
"""`;
const ATTACH_BLOCK = `ATTACHMENTS (the user attached these files; the rewrite should reference them naturally — e.g. "based on the attached <filename>"):
{{list}}

`;
function buildMetaPrompt(draft, settings, site, attachments = []) {
  const attach = attachments.length ? ATTACH_BLOCK.replace("{{list}}", attachments.map((f) => `- ${f}`).join("\n")) : "";
  return META
    .replaceAll("{{tone}}", settings.tone)
    .replaceAll("{{verbosity}}", settings.verbosity)
    .replaceAll("{{promptStyle}}", settings.promptStyle || "auto")
    .replaceAll("{{site}}", site)
    .replaceAll("{{attachments_block}}", attach)
    .replaceAll("{{draft}}", draft);
}
const REWRITE_RE = /###\s*REWRITE\s*###([\s\S]*?)###\s*END\s*###/i;
function parseMetaResponse(raw) {
  const text = raw.trim();
  const rw = text.match(REWRITE_RE);
  if (rw) return { optimized: rw[1].trim() };
  const startOnly = text.match(/###\s*REWRITE\s*###([\s\S]*)$/i);
  if (startOnly) return { optimized: startOnly[1].trim() };
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === "object" && typeof obj.optimized === "string" && obj.optimized.trim()) {
      return { optimized: obj.optimized.trim() };
    }
  } catch {}
  return { optimized: text };
}
async function runApiEngine(draft, settings, site, attachments = []) {
  const provider = settings.apiProvider;
  const key = settings.apiKeys[provider];
  if (!key) {
    return {
      kind: "error",
      message: provider === "openrouter" ? "No OpenRouter API key set. Open Settings and paste your key (starts with sk-or-…)." : `No API key set for ${provider}. Open Settings to add one.`
    };
  }
  const model = settings.apiModel || defaultModelFor(provider);
  const prompt = buildMetaPrompt(draft, settings, site, attachments);
  try {
    const { content: raw, tokens } = provider === "openrouter" ? await callOpenRouter(prompt, key, model) : provider === "anthropic" ? await callAnthropic(prompt, key, model) : provider === "openai" ? await callOpenAI(prompt, key, model) : await callGoogle(prompt, key, model);
    void accumulateTokens(tokens, site);
    const parsed = parseMetaResponse(raw);
    if (parsed.optimized && parsed.optimized.trim()) {
      return { kind: "ok", optimized: parsed.optimized.trim(), tokens };
    }
    return { kind: "ok", optimized: draft.trim(), tokens };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
function monthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth()}`;
}
async function accumulateTokens(tokens, site) {
  if (!tokens || tokens <= 0) return;
  const s = await getSettings();
  const mk = monthKey();
  const resetNeeded = s.tokenResetDate !== mk;
  const byPlatform = resetNeeded ? {} : (s.tokensByPlatform || {});
  const platform = site || "generic";
  byPlatform[platform] = (byPlatform[platform] || 0) + tokens;
  const total = Object.values(byPlatform).reduce((a, b) => a + b, 0);
  await setSettings({
    tokensUsed: total,
    tokensByPlatform: byPlatform,
    tokenResetDate: mk
  });
}
async function callOpenRouter(prompt, key, model) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://github.com/promptassist",
      "X-Title": "PromptAssist"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    })
  });
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}.`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenRouter: empty response.");
  const tokens = (data?.usage?.total_tokens) || 0;
  return { content, tokens };
}
async function callAnthropic(prompt, key, model) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}.`);
  const data = await res.json();
  const content = data?.content?.[0]?.text;
  if (typeof content !== "string") throw new Error("Anthropic: empty response.");
  const tokens = (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0);
  return { content, tokens };
}
async function callOpenAI(prompt, key, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    })
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}.`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI: empty response.");
  const tokens = (data?.usage?.total_tokens) || 0;
  return { content, tokens };
}
async function callGoogle(prompt, key, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    })
  });
  if (!res.ok) throw new Error(`Google error ${res.status}.`);
  const data = await res.json();
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof content !== "string") throw new Error("Google: empty response.");
  const tokens = (data?.usageMetadata?.totalTokenCount) || 0;
  return { content, tokens };
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const t = msg?.type;
  if (t === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (t === "OPTIMIZE") {
    handleOptimize(msg).then((r) => sendResponse(r)).catch(
      (err) => sendResponse({
        kind: "error",
        message: err instanceof Error ? err.message : String(err)
      })
    );
    return true;
  }
  if (t === "GET_TOKEN_STATS") {
    getSettings().then((s) => {
      const mk = monthKey();
      const active = s.tokenResetDate === mk;
      const byPlatform = active ? (s.tokensByPlatform || {}) : {};
      const total = Object.values(byPlatform).reduce((a, b) => a + b, 0);
      sendResponse({ tokensUsed: total, byPlatform, tokenBudget: s.tokenBudget || 500000 });
    }).catch(() => sendResponse({ tokensUsed: 0, byPlatform: {}, tokenBudget: 500000 }));
    return true;
  }
  if (t === "RESET_TOKENS") {
    setSettings({ tokensUsed: 0, tokensByPlatform: {}, tokenResetDate: null }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (t === "STORE_PENDING_IMPORT") {
    const { text, targetId } = msg.payload || {};
    chrome.storage.session.set({ pendingImport: { text, targetId, expires: Date.now() + 120000 } })
      .then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (t === "GET_PENDING_IMPORT") {
    chrome.storage.session.get("pendingImport").then((obj) => {
      const pi = obj.pendingImport;
      if (!pi || Date.now() > pi.expires) { sendResponse(null); return; }
      chrome.storage.session.remove("pendingImport").catch(() => {});
      sendResponse(pi);
    }).catch(() => sendResponse(null));
    return true;
  }
  return false;
});
async function handleOptimize(msg) {
  const settings = await getSettings();
  const { draft, site, attachments = [] } = msg.payload;
  return runApiEngine(draft, settings, site, attachments);
}
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "optimize-prompt") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_OPTIMIZE" }).catch(() => {
    });
  }
});
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage().catch(() => {
    });
  }
});
