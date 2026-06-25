import { g as getSettings, d as defaultModelFor, s as setSettings, D as DEFAULT_SETTINGS, M as MODELS_BY_PROVIDER } from "../chunks/settings-DQva-Qam.js";
const KEY_HINTS = {
  openrouter: 'Get a key at <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai/keys</a>. Starts with <code>sk-or-…</code>',
  anthropic: 'Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>. Starts with <code>sk-ant-…</code>',
  openai: 'Get a key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>. Starts with <code>sk-…</code>',
  google: 'Get a key at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>'
};
const PLATFORM_LABELS = {
  claude: "Claude (claude.ai)",
  chatgpt: "ChatGPT (chatgpt.com)",
  gemini: "Gemini (gemini.google.com)",
  perplexity: "Perplexity (perplexity.ai)",
  generic: "Other sites"
};
function $(id) { return document.getElementById(id); }

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function repopulateModels(provider, currentModel) {
  const select = $("apiModel");
  select.innerHTML = "";
  for (const m of MODELS_BY_PROVIDER[provider]) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.note ? `${m.label} — ${m.note}` : m.label;
    select.appendChild(opt);
  }
  const known = MODELS_BY_PROVIDER[provider].some((m) => m.id === currentModel);
  select.value = known ? currentModel : defaultModelFor(provider);
}

async function loadTokenStats(budget) {
  const s = await getSettings();
  const now = new Date();
  const mk = `${now.getFullYear()}-${now.getMonth()}`;
  const active = s.tokenResetDate === mk;
  const byPlatform = active ? (s.tokensByPlatform || {}) : {};
  const total = Object.values(byPlatform).reduce((a, b) => a + b, 0);

  // Month label
  const monthName = now.toLocaleString("default", { month: "long", year: "numeric" });
  $("token-month-label").textContent = `— ${monthName}`;

  // Per-platform breakdown table
  const breakdown = $("platform-breakdown");
  const platforms = Object.entries(byPlatform).filter(([, v]) => v > 0);
  if (platforms.length === 0) {
    breakdown.innerHTML = `<p style="color:GrayText;font-size:13px;margin:0">No usage recorded yet this month. Usage appears here automatically as you optimize prompts on each platform.</p>`;
  } else {
    const rows = platforms
      .sort(([, a], [, b]) => b - a)
      .map(([id, used]) => {
        const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
        const color = pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "#4f46e5";
        const label = PLATFORM_LABELS[id] || id;
        return `<div class="platform-row">
          <div class="platform-name">${label}</div>
          <div class="platform-bar-wrap">
            <div class="platform-bar-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <div class="platform-tokens" style="color:${color}">${fmtTokens(used)}</div>
        </div>`;
      }).join("");
    breakdown.innerHTML = rows;
  }

  // Total bar
  const pct = budget > 0 ? Math.min(100, Math.round((total / budget) * 100)) : 0;
  const color = pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "#4f46e5";
  $("token-bar").style.width = pct + "%";
  $("token-bar").style.background = color;
  const remaining = Math.max(0, budget - total);
  $("token-bar-label").textContent = total > 0
    ? `Total: ${fmtTokens(total)} used · ${fmtTokens(remaining)} remaining of ${fmtTokens(budget)} monthly budget`
    : `Budget: ${fmtTokens(budget)} tokens/month`;
}

async function load() {
  const s = await getSettings();
  $("mode").value = s.mode;
  $("apiProvider").value = s.apiProvider;
  $("apiKey").value = s.apiKeys[s.apiProvider] ?? "";
  repopulateModels(s.apiProvider, s.apiModel);
  $("promptStyle").value = s.promptStyle ?? "auto";
  $("tone").value = s.tone;
  $("verbosity").value = s.verbosity;
  $("blocklist").value = s.blocklist.join("\n");
  document.getElementById("key-hint").innerHTML = KEY_HINTS[s.apiProvider];
  const budget = s.tokenBudget || 500000;
  $("tokenBudget").value = budget;
  await loadTokenStats(budget);
}

async function save() {
  const provider = $("apiProvider").value;
  const current = await getSettings();
  const apiKeys = { ...current.apiKeys, [provider]: $("apiKey").value.trim() };
  const model = $("apiModel").value || defaultModelFor(provider);
  const budget = parseInt($("tokenBudget").value, 10) || 500000;
  await setSettings({
    mode: $("mode").value,
    apiProvider: provider,
    apiKeys,
    apiModel: model,
    promptStyle: $("promptStyle").value,
    tone: $("tone").value,
    verbosity: $("verbosity").value,
    tokenBudget: budget,
    blocklist: $("blocklist").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  });
  await loadTokenStats(budget);
  flashSaved();
}

function flashSaved() {
  const el = document.getElementById("saved");
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1200);
}

async function reset() {
  if (!confirm("Reset all PromptAssist settings to defaults?")) return;
  await setSettings({ ...DEFAULT_SETTINGS });
  await load();
  flashSaved();
}

async function onProviderChange() {
  const provider = $("apiProvider").value;
  const s = await getSettings();
  $("apiKey").value = s.apiKeys[provider] ?? "";
  repopulateModels(provider, s.apiProvider === provider ? s.apiModel : defaultModelFor(provider));
  document.getElementById("key-hint").innerHTML = KEY_HINTS[provider];
}

document.addEventListener("DOMContentLoaded", () => {
  void load();
  document.getElementById("save").addEventListener("click", () => void save());
  document.getElementById("reset").addEventListener("click", () => void reset());
  $("apiProvider").addEventListener("change", () => void onProviderChange());
  document.getElementById("reset-tokens").addEventListener("click", async () => {
    if (!confirm("Reset your token counter to zero for this month?")) return;
    await setSettings({ tokensUsed: 0, tokensByPlatform: {}, tokenResetDate: null });
    const budget = parseInt($("tokenBudget").value, 10) || 500000;
    await loadTokenStats(budget);
    flashSaved();
  });
});
