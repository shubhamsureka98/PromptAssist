const MODELS_BY_PROVIDER = {
  openrouter: [
    { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", note: "Fast & cheap (default)" },
    { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5", note: "Best quality" },
    { id: "openai/gpt-4o-mini", label: "GPT-4o mini", note: "Cheap" },
    { id: "openai/gpt-4o", label: "GPT-4o" },
    { id: "openai/gpt-4.1-mini", label: "GPT-4.1 mini" },
    { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Fast" },
    { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
    { id: "x-ai/grok-2-1212", label: "Grok 2" }
  ],
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", note: "Fast & cheap" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: "Best quality" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" }
  ],
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o mini", note: "Cheap" },
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini" }
  ],
  google: [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }
  ]
};
function defaultModelFor(provider) {
  return MODELS_BY_PROVIDER[provider][0].id;
}
const DEFAULT_SETTINGS = {
  mode: "api",
  apiProvider: "openrouter",
  apiKeys: {},
  apiModel: "anthropic/claude-haiku-4.5",
  tone: "neutral",
  verbosity: "standard",
  promptStyle: "auto",
  tokenBudget: 100000,
  tokensUsed: 0,
  tokenResetDate: null,
  blocklist: []
};
const KEY = "promptpolish.settings.v1";
async function getSettings() {
  const obj = await chrome.storage.local.get(KEY);
  const stored = obj[KEY];
  return { ...DEFAULT_SETTINGS, ...stored ?? {} };
}
async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
export {
  DEFAULT_SETTINGS as D,
  MODELS_BY_PROVIDER as M,
  defaultModelFor as d,
  getSettings as g,
  setSettings as s
};
