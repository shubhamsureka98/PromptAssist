import { g as getSettings, M as MODELS_BY_PROVIDER, s as setSettings } from "../chunks/settings-DQva-Qam.js";
async function init() {
  const s = await getSettings();
  const mode = document.getElementById("mode");
  const promptStyle = document.getElementById("promptStyle");
  const verbosity = document.getElementById("verbosity");
  const apiModel = document.getElementById("apiModel");
  const rowModel = document.getElementById("row-model");
  const openOpts = document.getElementById("open-options");
  const warn = document.getElementById("no-key-warn");
  mode.value = s.mode;
  promptStyle.value = s.promptStyle ?? "auto";
  verbosity.value = s.verbosity;
  for (const m of MODELS_BY_PROVIDER[s.apiProvider]) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    apiModel.appendChild(opt);
  }
  apiModel.value = s.apiModel;
  const refresh = () => {
    rowModel.style.display = mode.value === "api" ? "" : "none";
    const needsKey = mode.value === "api" && !s.apiKeys[s.apiProvider];
    warn.style.display = needsKey ? "" : "none";
  };
  refresh();
  mode.addEventListener("change", async () => {
    await setSettings({ mode: mode.value });
    refresh();
  });
  promptStyle.addEventListener("change", () => setSettings({ promptStyle: promptStyle.value }));
  verbosity.addEventListener(
    "change",
    () => setSettings({ verbosity: verbosity.value })
  );
  apiModel.addEventListener("change", () => setSettings({ apiModel: apiModel.value }));
  openOpts.addEventListener("click", () => chrome.runtime.openOptionsPage());
}
init();
