# PromptAssist

A Chrome extension that rewrites and optimizes your AI prompts before you send them — using best practices from Anthropic, OpenAI, and Google.

![PromptAssist in action](docs/screenshot.png)

---

## Features

- **Instant rewrite** — click the floating ✦ button (or press `⌘/Ctrl + Shift + O`) to optimize any prompt in the text box
- **Two rewrite modes**
  - **Refine** — polishes short, clear prompts (fixes typos, sharpens clarity)
  - **Structure** — applies full prompt engineering for complex tasks (Role, Context, Task, Constraints, Output Format)
  - **Auto** — picks the right mode based on prompt length and complexity
- **Not quite right?** — inline "Add more context" refinement lets you tweak the rewrite without starting over
- **Multi-provider API support** — OpenRouter, Anthropic, OpenAI, Google Gemini
- **Works on** — Claude, ChatGPT, Perplexity, Gemini, and most other text input fields
- **Dark mode** — fully themed to match the host page
- **Keyboard shortcut** — `⌘ Shift O` / `Ctrl Shift O`

---

## Installation

### From source (developer mode)

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right)
4. Click **Load unpacked**
5. Select the folder containing `manifest.json`

> Chrome Web Store submission coming soon.

---

## Setup

1. Click the PromptAssist icon in your Chrome toolbar
2. Click **All settings…**
3. Choose your **API Provider** (OpenRouter is recommended — one key for all models)
4. Paste your API key
5. Select a model and save

### Getting an API key

| Provider | URL | Key format |
|----------|-----|------------|
| OpenRouter (recommended) | [openrouter.ai/keys](https://openrouter.ai/keys) | `sk-or-…` |
| Anthropic | [console.anthropic.com](https://console.anthropic.com/settings/keys) | `sk-ant-…` |
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `sk-…` |
| Google | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | — |

---

## Usage

1. Go to any supported site (Claude, ChatGPT, Perplexity, Gemini, etc.)
2. Type your draft prompt in the chat input
3. Click the **✦** floating button, or press `⌘/Ctrl + Shift + O`
4. Review the optimized prompt in the overlay panel
5. Click **Replace** to swap your draft, or **Insert** to append below

### Refining the result

- Edit the text directly in the result panel
- Click **"Not quite? Add more context"** to give the model extra instructions and re-optimize
- Click **Regenerate** to run the optimization again from scratch

### Settings (right-click the floating button)

- **Mode** — API rewrite (uses your key) or In-chat rewrite (uses the page's own AI)
- **Style** — Auto / Refine / Structure
- **Length** — Concise / Standard / Detailed
- **Model** — choose from available models for your provider

---

## Supported Sites

| Site | Status |
|------|--------|
| claude.ai | ✅ Full support |
| chatgpt.com | ✅ Full support |
| gemini.google.com | ✅ Full support |
| perplexity.ai | ✅ Full support |
| Other sites | ✅ Generic fallback (floating button only) |

---

## Privacy & Security

- **Your API key never leaves your browser** — all API calls are made directly from the extension to the provider
- **No backend server** — the extension has no server component; everything runs locally
- **Keys stored in `chrome.storage.local`** — isolated to this extension, not accessible by web pages
- **No analytics or tracking** of any kind
- **Content Security Policy** enforced on all extension pages

---

## Development

```
PromptAssist/
├── manifest.json          # Extension manifest (MV3)
├── background/
│   └── service-worker.js  # API calls, message handling
├── content/
│   └── content.js         # Floating button, overlay UI, site adapters
├── popup/
│   ├── popup.html
│   └── popup.js           # Quick settings popup
├── options/
│   ├── options.html
│   └── options.js         # Full settings page
├── chunks/
│   └── settings-DQva-Qam.js  # Shared settings/storage helpers
└── icons/
```

### Architecture notes

- **Manifest V3** service worker — no persistent background page
- Content script is a **self-contained IIFE** (no ES module imports) — shared logic is duplicated between `service-worker.js` and `content.js` intentionally
- UI rendered in a **Shadow DOM** — fully isolated from host page styles
- Site adapters in `content.js` — each supported site has a small adapter implementing `findInput()`, `getValue()`, `setValue()`, `submit()`, `waitForReply()`

---

## Contributing

Pull requests are welcome. For major changes, please open an issue first.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## License

[MIT](LICENSE) © 2025 Shubham
