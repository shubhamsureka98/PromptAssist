import { g as getSettings, d as defaultModelFor, s as setSettings, D as DEFAULT_SETTINGS, M as MODELS_BY_PROVIDER } from "../chunks/settings-DQva-Qam.js";
const KEY_HINTS = {
  openrouter: 'Get a key at <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai/keys</a>. Starts with <code>sk-or-…</code>',
  anthropic: 'Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>. Starts with <code>sk-ant-…</code>',
  openai: 'Get a key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>. Starts with <code>sk-…</code>',
  google: 'Get a key at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>'
};
function $(id) {
  return document.getElementById(id);
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
function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}
async function loadTokenStats(budget) {
  const s = await getSettings();
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth()}`;
  const used = s.tokenResetDate === monthKey ? (s.tokensUsed || 0) : 0;
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  const color = pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "#4f46e5";
  $("token-bar").style.width = pct + "%";
  $("token-bar").style.background = color;
  $("token-used-label").textContent = `${fmtTokens(used)} / ${fmtTokens(budget)} tokens used this month (${pct}%)`;
  $("token-used-label").style.color = pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "";
  $("token-bar-label").textContent = `${fmtTokens(budget - used)} tokens remaining. Resets automatically on the 1st of each month.`;
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
  const budget = s.tokenBudget || 100000;
  $("tokenBudget").value = budget;
  await loadTokenStats(budget);
}
async function save() {
  const provider = $("apiProvider").value;
  const current = await getSettings();
  const apiKeys = { ...current.apiKeys, [provider]: $("apiKey").value.trim() };
  const model = $("apiModel").value || defaultModelFor(provider);
  const budget = parseInt($("tokenBudget").value, 10) || 100000;
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
    await setSettings({ tokensUsed: 0, tokenResetDate: null });
    const budget = parseInt($("tokenBudget").value, 10) || 100000;
    await loadTokenStats(budget);
    flashSaved();
  });
});
