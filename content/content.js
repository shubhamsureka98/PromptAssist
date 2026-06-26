(function() {
  "use strict";
  function isContentEditable(el) {
    return el.isContentEditable || el.getAttribute("contenteditable") === "true";
  }
  function readValue(el) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      return el.value ?? "";
    }
    return el.innerText ?? "";
  }
  function writeValue(el, text) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      setNativeInputValue(el, text);
      return;
    }
    if (isContentEditable(el)) {
      writeContentEditable(el, text);
      return;
    }
    el.textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function setNativeInputValue(el, text) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function writeContentEditable(el, text) {
    el.focus();
    const sel = window.getSelection();
    if (!sel) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand("insertText", false, text);
    if (ok) return;
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
    );
  }
  function findLikelyPromptInput() {
    const active = document.activeElement;
    if (active && looksLikePromptBox(active)) return active;
    const candidates = [];
    const queue = [document];
    while (queue.length) {
      const root = queue.shift();
      root.querySelectorAll(
        'textarea, div[contenteditable="true"], [role="textbox"], [contenteditable="plaintext-only"]'
      ).forEach((el) => {
        if (isVisible(el)) candidates.push(el);
      });
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) queue.push(el.shadowRoot);
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => score(b) - score(a));
    return candidates[0];
  }
  function looksLikePromptBox(el) {
    if (el instanceof HTMLTextAreaElement) return true;
    if (isContentEditable(el)) return true;
    if (el.getAttribute("role") === "textbox") return true;
    return false;
  }
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 16) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }
  function pickFirstVisible(selectors) {
    for (const sel of selectors) {
      const list = document.querySelectorAll(sel);
      for (const el of list) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }
  function pickFirstVisibleDeep(selectors) {
    const queue = [document];
    while (queue.length) {
      const root = queue.shift();
      for (const sel of selectors) {
        const list = root.querySelectorAll(sel);
        for (const el of list) {
          if (isVisible(el)) return el;
        }
      }
      const all = root.querySelectorAll("*");
      for (const el of all) {
        if (el.shadowRoot) queue.push(el.shadowRoot);
      }
    }
    return null;
  }
  function collectFilenamesNear(input, selectors) {
    const root = input?.closest("form") ?? document.body;
    const seen = /* @__PURE__ */ new Set();
    for (const sel of selectors) {
      root.querySelectorAll(sel).forEach((el) => {
        const name = extractFilename(el);
        if (name) seen.add(name);
      });
    }
    return [...seen];
  }
  const FILENAME_RE = new RegExp(
    "[\\w\\u00C0-\\u024F .\\-()_,&]+\\.[a-zA-Z0-9]{1,8}"
  );
  function extractFilename(el) {
    const attrs = ["data-filename", "data-name", "title", "aria-label", "alt"];
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v && FILENAME_RE.test(v)) {
        const m2 = v.match(FILENAME_RE);
        if (m2) return m2[0].trim();
      }
    }
    const txt = (el.innerText || "").trim();
    if (!txt) return null;
    const m = txt.match(FILENAME_RE);
    return m ? m[0].trim() : null;
  }
  function score(el) {
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    const offscreenPenalty = rect.bottom < 0 || rect.top > window.innerHeight ? 1e6 : 0;
    const bottomBias = Math.max(0, window.innerHeight - rect.bottom);
    return area - bottomBias - offscreenPenalty;
  }
  const END_MARKER_RE = /###\s*END\s*###/i;
  const REWRITE_START_RE = /###\s*REWRITE\s*###/i;
  const CLARIFY_START_RE = /###\s*CLARIFY\s*###/i;
  async function waitForNextAssistantMessage(opts) {
    const { messageSelector, timeoutMs, quietMs = 1500 } = opts;
    const baselineCount = document.querySelectorAll(messageSelector).length;
    const start = Date.now();
    const newNode = await waitFor(() => {
      const nodes = document.querySelectorAll(messageSelector);
      if (nodes.length <= baselineCount) return null;
      return nodes[nodes.length - 1] ?? null;
    }, timeoutMs);
    if (!newNode) return null;
    let lastText = (newNode.innerText || "").trim();
    let lastChange = Date.now();
    let bestText = lastText;
    return new Promise((resolve) => {
      const tick = () => {
        const elapsed = Date.now() - start;
        const current = (newNode.innerText || "").trim();
        if (current) bestText = current;
        if (END_MARKER_RE.test(current) && (REWRITE_START_RE.test(current) || CLARIFY_START_RE.test(current))) {
          cleanup();
          resolve(current);
          return;
        }
        if (current !== lastText) {
          lastText = current;
          lastChange = Date.now();
        } else if (current && Date.now() - lastChange >= quietMs) {
          cleanup();
          resolve(current);
          return;
        }
        if (elapsed > timeoutMs) {
          cleanup();
          resolve(bestText || null);
          return;
        }
      };
      const id = window.setInterval(tick, 200);
      const cleanup = () => window.clearInterval(id);
    });
  }
  async function waitFor(predicate, timeoutMs) {
    const start = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const v = predicate();
        if (v) {
          window.clearInterval(id);
          resolve(v);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          window.clearInterval(id);
          resolve(null);
        }
      };
      const id = window.setInterval(tick, 150);
      tick();
    });
  }
  const claudeAdapter = {
    id: "claude",
    matches: (host) => host === "claude.ai" || host.endsWith(".claude.ai"),
    findInput() {
      return pickFirstVisible([
        'div.ProseMirror[contenteditable="true"]',
        'div[contenteditable="true"][aria-label*="prompt" i]',
        'div[contenteditable="true"][aria-label*="message" i]',
        'div[contenteditable="true"][role="textbox"]'
      ]) ?? findLikelyPromptInput();
    },
    getValue: readValue,
    setValue: writeValue,
    findAttachments() {
      const input = this.findInput();
      return collectFilenamesNear(input, [
        '[data-testid*="file" i]',
        '[data-testid*="attachment" i]',
        'div[aria-label*="attachment" i]',
        'button[aria-label*="remove" i]'
      ]);
    },
    submit(input) {
      const sendBtn = document.querySelector(
        'button[aria-label*="Send" i]:not([disabled])'
      );
      if (sendBtn) {
        sendBtn.click();
        return true;
      }
      input.focus();
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true
        })
      );
      return true;
    },
    waitForReply(timeoutMs) {
      return waitForNextAssistantMessage({
        messageSelector: [
          'div[data-testid="conversation-turn-assistant"]',
          "div.font-claude-message",
          'div[data-testid="user-message"] ~ div'
        ].join(","),
        timeoutMs,
        quietMs: 1800
      });
    },
    newChatUrl() {
      return "https://claude.ai/new";
    },
    readPlatformQuota() {
      // Claude Pro shows usage as text or progress bar in various places
      // Try ARIA / data attributes first, then text scanning
      const platformLabel = "Claude";

      // 1. Progress bar with aria-valuenow / aria-valuemax
      const progressEl = document.querySelector('[role="progressbar"][aria-valuemax]');
      if (progressEl) {
        const used = parseFloat(progressEl.getAttribute("aria-valuenow") || "0");
        const total = parseFloat(progressEl.getAttribute("aria-valuemax") || "0");
        const label = progressEl.getAttribute("aria-label") || progressEl.closest("[aria-label]")?.getAttribute("aria-label") || "";
        const period = extractPeriod(label) || "this period";
        if (total > 0) return { platformLabel, used, total, unit: "messages", period };
      }

      // 2. Text scan: "X of Y messages", "X messages left", "X remaining"
      const quota = scanQuotaText(document.body, [
        /(\d+)\s+of\s+(\d+)\s+(messages?|requests?|queries|prompts?)/i,
        /(\d+)\s+(messages?|requests?|queries?|prompts?)\s+(left|remaining)/i,
        /(\d+)\s+(messages?|requests?|queries?|prompts?)\s+(?:left|remaining)\s+(?:today|this hour|this week|per day)/i,
        /usage[:\s]+(\d+)%/i
      ]);
      if (quota) return { platformLabel, ...quota };

      return null;
    }
  };
  const chatgptAdapter = {
    id: "chatgpt",
    matches: (host) => host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com" || host.endsWith(".chat.openai.com"),
    findInput() {
      return pickFirstVisible([
        "#prompt-textarea",
        'textarea[data-id="root"]',
        'div[contenteditable="true"]#prompt-textarea',
        "form textarea",
        'main div[contenteditable="true"][role="textbox"]'
      ]) ?? findLikelyPromptInput();
    },
    getValue: readValue,
    setValue: writeValue,
    findAttachments() {
      const input = this.findInput();
      return collectFilenamesNear(input, [
        '[data-testid*="attachment" i]',
        'div[role="presentation"][aria-label]',
        'div[aria-label*="file" i]',
        'button[aria-label*="Remove" i]'
      ]);
    },
    submit(input) {
      const sendBtn = document.querySelector(
        'button[data-testid="send-button"]:not([disabled]), button[aria-label*="Send" i]:not([disabled])'
      );
      if (sendBtn) {
        sendBtn.click();
        return true;
      }
      input.focus();
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true
        })
      );
      return true;
    },
    waitForReply(timeoutMs) {
      return waitForNextAssistantMessage({
        messageSelector: [
          'div[data-message-author-role="assistant"]',
          'article[data-testid^="conversation-turn"][data-testid$="assistant"]'
        ].join(","),
        timeoutMs,
        quietMs: 1500
      });
    },
    newChatUrl() {
      return "https://chatgpt.com/?temporary-chat=true";
    },
    readPlatformQuota() {
      const platformLabel = "ChatGPT";

      // 1. Progress bar
      const progressEl = document.querySelector('[role="progressbar"][aria-valuemax]');
      if (progressEl) {
        const used = parseFloat(progressEl.getAttribute("aria-valuenow") || "0");
        const total = parseFloat(progressEl.getAttribute("aria-valuemax") || "0");
        const label = progressEl.getAttribute("aria-label") || "";
        if (total > 0) return { platformLabel, used, total, unit: "messages", period: extractPeriod(label) || "per period" };
      }

      // 2. Model usage chips — ChatGPT sometimes shows "X/40" in model picker
      const modelUsage = document.querySelector('[data-testid*="usage"], [class*="usage-bar"], [class*="message-cap"]');
      if (modelUsage) {
        const text = modelUsage.innerText?.trim();
        if (text) {
          const q = scanQuotaText(modelUsage, [/(\d+)\s*\/\s*(\d+)/]);
          if (q) return { platformLabel, ...q, unit: "messages" };
          return { platformLabel, raw: text, period: "per period" };
        }
      }

      // 3. Full-page text scan
      const quota = scanQuotaText(document.body, [
        /(\d+)\s+of\s+(\d+)\s+(messages?|requests?)/i,
        /(\d+)\s+(messages?|requests?)\s+(left|remaining)/i,
        /(\d+)\s*\/\s*(\d+)\s+(messages?)/i,
        /reached\s+(?:your\s+)?(?:message\s+)?limit/i,
        /GPT-?4[o\d]*[:\s]+(\d+)\s+(messages?)\s+(left|remaining)/i
      ]);
      if (quota) return { platformLabel, ...quota };

      return null;
    }
  };
  const perplexityAdapter = {
    id: "perplexity",
    matches: (host) => host === "perplexity.ai" || host === "www.perplexity.ai" || host.endsWith(".perplexity.ai"),
    findInput() {
      return pickFirstVisibleDeep([
        // Lexical / contenteditable, most-specific first
        'div[contenteditable="true"][aria-label*="Ask follow-up" i]',
        'div[contenteditable="true"][aria-label*="Ask anything" i]',
        'div[contenteditable="true"][aria-label*="Ask" i]',
        'div[contenteditable="true"][role="textbox"]',
        '[data-lexical-editor="true"]',
        'div[contenteditable="true"]',
        // Textarea variants
        "textarea#ask-input",
        'textarea[id*="ask" i]',
        'textarea[placeholder*="Ask anything" i]',
        'textarea[placeholder*="Ask" i]',
        'textarea[placeholder*="follow-up" i]',
        'textarea[placeholder*="Follow up" i]',
        'textarea[placeholder*="Reply" i]',
        'textarea[placeholder*="What do you want to know" i]',
        "main textarea",
        "form textarea",
        "textarea",
        // Anything that says it's a textbox
        '[role="textbox"]'
      ]) ?? findLikelyPromptInput();
    },
    getValue: readValue,
    setValue: writeValue,
    findAttachments() {
      const input = this.findInput();
      return collectFilenamesNear(input, [
        'div[aria-label*="file" i]',
        '[data-testid*="attachment" i]',
        '[data-testid*="file" i]',
        'button[aria-label*="Remove" i]'
      ]);
    },
    submit(input) {
      const candidates = [
        'button[aria-label*="submit" i]:not([disabled])',
        'button[aria-label*="Send" i]:not([disabled])',
        'button[type="submit"]:not([disabled])',
        'button[data-testid*="submit" i]:not([disabled])',
        // Perplexity's "send" sometimes is the right-most button in the form footer.
        "form button:not([disabled]):last-of-type",
        "form button:not([disabled])"
      ];
      for (const sel of candidates) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          return true;
        }
      }
      input.focus();
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        })
      );
      return true;
    },
    waitForReply(timeoutMs) {
      return waitForNextAssistantMessage({
        messageSelector: [
          'div[id^="markdown-content"]',
          "div.prose",
          '[data-testid="answer-text"]',
          'div[class*="answer"][class*="text"]'
        ].join(","),
        timeoutMs,
        quietMs: 2500
      });
    },
    newChatUrl() {
      return "https://www.perplexity.ai/";
    },
    readPlatformQuota() {
      const platformLabel = "Perplexity";
      const quota = scanQuotaText(document.body, [
        /(\d+)\s+(Pro\s+)?(searches?|queries?|requests?)\s+(left|remaining)/i,
        /(\d+)\s+of\s+(\d+)\s+(Pro\s+)?(searches?|queries?)/i,
        /(\d+)\s+(searches?|queries?)\s+(?:left\s+)?(?:today|this\s+day|per\s+day)/i
      ]);
      if (quota) return { platformLabel, ...quota };
      return null;
    }
  };
  const geminiAdapter = {
    id: "gemini",
    matches: (host) => host === "gemini.google.com" || host.endsWith(".gemini.google.com"),
    findInput() {
      return pickFirstVisible([
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][aria-label*="prompt" i]'
      ]) ?? findLikelyPromptInput();
    },
    getValue: readValue,
    setValue: writeValue,
    findAttachments() {
      const input = this.findInput();
      return collectFilenamesNear(input, [
        'div[aria-label*="file" i]',
        '[data-test-id*="attachment" i]',
        '[role="img"][aria-label]'
      ]);
    },
    submit(input) {
      const sendBtn = document.querySelector(
        'button[aria-label*="Send" i]:not([disabled]), button.send-button:not([disabled])'
      );
      if (sendBtn) {
        sendBtn.click();
        return true;
      }
      input.focus();
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true
        })
      );
      return true;
    },
    waitForReply(timeoutMs) {
      return waitForNextAssistantMessage({
        messageSelector: [
          "model-response",
          "message-content[model-response]",
          "div.model-response-text"
        ].join(","),
        timeoutMs,
        quietMs: 1800
      });
    },
    newChatUrl() {
      return "https://gemini.google.com/app";
    },
    readPlatformQuota() {
      const platformLabel = "Gemini";
      // Gemini Advanced may show usage in some variants
      const progressEl = document.querySelector('[role="progressbar"][aria-valuemax]');
      if (progressEl) {
        const used = parseFloat(progressEl.getAttribute("aria-valuenow") || "0");
        const total = parseFloat(progressEl.getAttribute("aria-valuemax") || "0");
        if (total > 0) return { platformLabel, used, total, unit: "requests", period: "per day" };
      }
      const quota = scanQuotaText(document.body, [
        /(\d+)\s+(requests?|queries?|messages?)\s+(left|remaining)/i,
        /(\d+)\s+of\s+(\d+)\s+(requests?|queries?|messages?)/i
      ]);
      if (quota) return { platformLabel, ...quota };
      return null;
    }
  };
  const genericAdapter = {
    id: "generic",
    matches: () => true,
    findInput: findLikelyPromptInput,
    getValue: readValue,
    setValue: writeValue
  };
  const DEFAULT_SETTINGS = {
    mode: "api",
    apiProvider: "openrouter",
    apiKeys: {},
    apiModel: "anthropic/claude-haiku-4.5",
    tone: "neutral",
    verbosity: "standard",
    promptStyle: "auto",
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
  const HOST_ID$1 = "promptassist-trigger-host";
  const POS_KEY = (host) => `promptassist.pos.${host}`;
  async function getSavedPos() {
    const k = POS_KEY(location.host);
    try {
      const obj = await chrome.storage.local.get(k);
      return obj[k] ?? null;
    } catch {
      return null;
    }
  }
  async function savePos(p) {
    const k = POS_KEY(location.host);
    if (p === null) {
      await chrome.storage.local.remove(k);
    } else {
      await chrome.storage.local.set({ [k]: p });
    }
  }
  function mountTriggerButton(input, onClick) {
    document.getElementById(HOST_ID$1)?.remove();
    const host = document.createElement("div");
    host.id = HOST_ID$1;
    host.setAttribute("data-pa-pill", "1");
    host.style.cssText = [
      "position: fixed",
      "z-index: 2147483647",
      "margin: 0",
      "padding: 0",
      "border: 0",
      "background: transparent",
      "pointer-events: auto"
    ].join(";");
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
        font: 500 12px/1 -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
      }
      .pill {
        display: inline-flex;
        align-items: stretch;
        background: rgba(17, 24, 39, 0.86);
        color: #ffffff;
        border-radius: 999px;
        box-shadow: 0 1px 2px rgba(17,24,39,0.10), 0 4px 12px rgba(17,24,39,0.18);
        backdrop-filter: blur(8px);
        opacity: 0.94;
        transition: opacity 100ms ease, box-shadow 100ms ease;
        overflow: hidden;
      }
      .pill:hover { opacity: 1; }
      .pill.dragging {
        box-shadow: 0 4px 8px rgba(17,24,39,0.20), 0 12px 28px rgba(17,24,39,0.28);
      }

      .grip {
        cursor: grab;
        padding: 0 6px 0 8px;
        display: flex; align-items: center;
        opacity: 0.5;
        transition: opacity 100ms ease;
      }
      .grip:hover { opacity: 0.95; }
      .grip.dragging { cursor: grabbing; }
      .grip-icon {
        display: inline-block;
        width: 6px; height: 12px;
        background-image:
          radial-gradient(circle, #fff 1px, transparent 1.2px),
          radial-gradient(circle, #fff 1px, transparent 1.2px);
        background-size: 3px 3px;
        background-position: 0 1px, 3px 1px;
        background-repeat: repeat-y;
      }

      button {
        all: unset;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font: inherit;
        color: inherit;
        transition: background 90ms ease;
      }
      button:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }

      .btn-main { padding: 5px 10px 5px 8px; border-left: 1px solid rgba(255,255,255,0.10); }
      .btn-main:hover { background: rgba(99, 102, 241, 0.4); }
      .btn-chev {
        padding: 5px 9px 5px 7px;
        border-left: 1px solid rgba(255, 255, 255, 0.10);
        font-size: 9px;
        opacity: 0.85;
      }
      .btn-chev:hover { background: rgba(99, 102, 241, 0.4); opacity: 1; }
      .dot { width: 5px; height: 5px; border-radius: 50%; background: #a5b4fc; flex: none; }

      .menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        min-width: 230px;
        background: #ffffff;
        color: #111827;
        border: 1px solid rgba(17, 24, 39, 0.08);
        border-radius: 12px;
        box-shadow: 0 8px 28px rgba(17,24,39,0.18), 0 1px 2px rgba(17,24,39,0.05);
        padding: 8px;
        opacity: 0;
        transform: translateY(-2px);
        pointer-events: none;
        transition: opacity 120ms ease, transform 120ms ease;
      }
      .menu.open { opacity: 1; transform: translateY(0); pointer-events: auto; }
      .menu .row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 10px; padding: 6px 6px;
      }
      .menu label { color: #6b7280; font-size: 11.5px; font-weight: 500; }
      .menu select {
        font: inherit; font-size: 12px;
        padding: 4px 6px; border-radius: 6px;
        border: 1px solid rgba(17, 24, 39, 0.10);
        background: #ffffff; color: #111827;
        max-width: 140px;
      }
      .menu .footer {
        margin-top: 4px; padding-top: 6px;
        border-top: 1px solid rgba(17, 24, 39, 0.06);
        display: flex; justify-content: space-between; align-items: center; gap: 8px;
        padding-left: 6px; padding-right: 6px;
      }
      .quota-wrap { padding: 8px 6px 4px; border-top: 1px solid rgba(17,24,39,0.08); margin-top: 2px; }
      .quota-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
      .quota-header span:first-child { font-size: 11.5px; font-weight: 600; color: #111827; }
      .quota-period { font-size: 10.5px; color: #6b7280; }
      .quota-bar-track { height: 5px; background: rgba(17,24,39,0.08); border-radius: 3px; overflow: hidden; margin-bottom: 4px; }
      .quota-bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
      .quota-detail { font-size: 11px; color: #374151; }
      .token-bar-wrap { padding: 6px 6px 2px; border-top: 1px solid rgba(17,24,39,0.06); margin-top: 4px; }
      .token-bar-labels { display: flex; justify-content: space-between; font-size: 10.5px; color: #6b7280; margin-bottom: 3px; }
      .token-bar-track { height: 4px; background: rgba(17,24,39,0.08); border-radius: 2px; overflow: hidden; }
      .token-bar-fill { height: 100%; background: #4f46e5; border-radius: 2px; transition: width 0.4s ease; }
      .token-bar-sub { font-size: 10px; color: #6b7280; margin-top: 3px; }
      .link {
        color: #4f46e5; cursor: pointer;
        font-size: 11.5px; font-weight: 600;
        background: transparent; border: 0; padding: 4px 0;
      }
      .link:hover { text-decoration: underline; }
      .link.subtle { color: #6b7280; }
      .link.subtle:hover { color: #111827; }

      @media (prefers-color-scheme: dark) {
        .menu {
          background: #14161b; color: #e5e7eb;
          border-color: rgba(255, 255, 255, 0.08);
          box-shadow: 0 8px 28px rgba(0,0,0,0.5);
        }
        .menu label { color: #9ca3af; }
        .menu select {
          background: #0b0d11; color: #e5e7eb;
          border-color: rgba(255, 255, 255, 0.10);
        }
        .menu .footer { border-color: rgba(255, 255, 255, 0.06); }
        .quota-wrap { border-color: rgba(255,255,255,0.07); }
        .quota-header span:first-child { color: #e5e7eb; }
        .quota-period { color: #6b7280; }
        .quota-bar-track { background: rgba(255,255,255,0.08); }
        .quota-detail { color: #9ca3af; }
        .token-bar-wrap { border-color: rgba(255,255,255,0.06); }
        .token-bar-track { background: rgba(255,255,255,0.08); }
        .token-bar-labels, .token-bar-sub { color: #9ca3af; }
        .link { color: #a5b4fc; }
        .link.subtle { color: #9ca3af; }
        .link.subtle:hover { color: #f3f4f6; }
      }
    </style>
    <div class="wrap" part="wrap">
      <div class="pill">
        <div class="grip" title="Drag to move" aria-label="Drag to move">
          <span class="grip-icon" aria-hidden="true"></span>
        </div>
        <button class="btn-main" type="button" aria-label="Optimize prompt" title="Optimize (Cmd/Ctrl+Shift+O)">
          <span class="dot" aria-hidden="true"></span>
          <span>Optimize</span>
        </button>
        <button class="btn-chev" type="button" aria-haspopup="true" aria-label="PromptAssist menu" title="Settings">
          <span aria-hidden="true">&#x25BE;</span>
        </button>
      </div>
      <div class="menu" role="menu" aria-label="Quick settings">
        <div class="row">
          <label for="pp-mode">Mode</label>
          <select id="pp-mode">
            <option value="api">API rewrite</option>
            <option value="chat">In this chat</option>
          </select>
        </div>
        <div class="row" id="pp-row-model">
          <label for="pp-model">Model</label>
          <select id="pp-model"></select>
        </div>
        <div class="row">
          <label for="pp-style">Style</label>
          <select id="pp-style">
            <option value="auto">Auto</option>
            <option value="refine">Refine</option>
            <option value="structure">Structure</option>
          </select>
        </div>
        <div class="quota-wrap" id="pp-quota-wrap" style="display:none">
          <div class="quota-header">
            <span id="pp-quota-platform"></span>
            <span id="pp-quota-period" class="quota-period"></span>
          </div>
          <div class="quota-bar-track" id="pp-quota-bar-track" style="display:none">
            <div class="quota-bar-fill" id="pp-quota-bar-fill"></div>
          </div>
          <div class="quota-detail" id="pp-quota-detail"></div>
        </div>
        <div class="footer">
          <button class="link subtle" id="pp-reset-pos" type="button">Reset position</button>
          <button class="link" id="pp-export-ctx" type="button">Export chat</button>
          <button class="link" id="pp-open-options" type="button">All settings</button>
        </div>
        <div class="token-bar-wrap" id="pp-token-wrap" style="display:none">
          <div class="token-bar-labels">
            <span id="pp-token-label">PromptAssist API usage</span>
            <span id="pp-token-pct"></span>
          </div>
          <div class="token-bar-track"><div class="token-bar-fill" id="pp-token-fill"></div></div>
          <div class="token-bar-sub" id="pp-token-sub"></div>
        </div>
      </div>
    </div>
  `;
    const pill = shadow.querySelector(".pill");
    const grip = shadow.querySelector(".grip");
    const btnMain = shadow.querySelector(".btn-main");
    const btnChev = shadow.querySelector(".btn-chev");
    const menu = shadow.querySelector(".menu");
    const modeSel = shadow.getElementById("pp-mode");
    const modelSel = shadow.getElementById("pp-model");
    const styleSel = shadow.getElementById("pp-style");
    const rowModel = shadow.getElementById("pp-row-model");
    const openOptionsBtn = shadow.getElementById("pp-open-options");
    const resetPosBtn = shadow.getElementById("pp-reset-pos");
    const exportCtxBtn = shadow.getElementById("pp-export-ctx");
    const tokenWrap = shadow.getElementById("pp-token-wrap");
    const tokenLabel = shadow.getElementById("pp-token-label");
    const tokenPct = shadow.getElementById("pp-token-pct");
    const tokenFill = shadow.getElementById("pp-token-fill");
    const tokenSub = shadow.getElementById("pp-token-sub");
    const quotaWrap = shadow.getElementById("pp-quota-wrap");
    const quotaPlatform = shadow.getElementById("pp-quota-platform");
    const quotaPeriod = shadow.getElementById("pp-quota-period");
    const quotaBarTrack = shadow.getElementById("pp-quota-bar-track");
    const quotaBarFill = shadow.getElementById("pp-quota-bar-fill");
    const quotaDetail = shadow.getElementById("pp-quota-detail");
    function renderPlatformQuota(q) {
      if (!q) { quotaWrap.style.display = "none"; return; }
      quotaWrap.style.display = "";
      quotaPlatform.textContent = q.platformLabel || adapter.id;
      quotaPeriod.textContent = q.period ? `· ${q.period}` : "";
      if (q.used != null && q.total != null && q.total > 0) {
        const pct = Math.min(100, Math.round((q.used / q.total) * 100));
        const remaining = q.total - q.used;
        const color = pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "#22c55e";
        quotaBarTrack.style.display = "";
        quotaBarFill.style.width = pct + "%";
        quotaBarFill.style.background = color;
        quotaDetail.textContent = `${remaining} of ${q.total} ${q.unit || "message"}s remaining`;
        quotaDetail.style.color = pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "";
      } else if (q.remaining != null) {
        quotaBarTrack.style.display = "none";
        quotaDetail.textContent = `${q.remaining} ${q.unit || "message"}s remaining`;
        quotaDetail.style.color = q.remaining <= 3 ? "#ef4444" : "";
      } else if (q.raw) {
        quotaBarTrack.style.display = "none";
        quotaDetail.textContent = q.raw;
        quotaDetail.style.color = "";
      } else {
        quotaWrap.style.display = "none";
      }
    }
    void hydrate();
    const storageListener = (changes) => {
      if (changes["promptpolish.settings.v1"]) void hydrate();
    };
    chrome.storage.onChanged.addListener(storageListener);
    function updateTokenBar(byPlatform, budget) {
      const platformUsed = (byPlatform || {})[adapter.id] || 0;
      const totalUsed = Object.values(byPlatform || {}).reduce((a, b) => a + b, 0);
      if (!totalUsed && !platformUsed) { tokenWrap.style.display = "none"; return; }
      tokenWrap.style.display = "";
      const pct = budget > 0 ? Math.min(100, Math.round((totalUsed / budget) * 100)) : 0;
      const color = pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "#4f46e5";
      tokenFill.style.width = pct + "%";
      tokenFill.style.background = color;
      tokenPct.textContent = pct + "%";
      tokenPct.style.color = color;
      const siteLabel = adapter.id !== "generic" ? ` (${adapter.id}: ${fmtTokens(platformUsed)})` : "";
      tokenSub.textContent = `Total: ${fmtTokens(totalUsed)} / ${fmtTokens(budget)}${siteLabel}`;
      tokenSub.style.color = pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "";
    }
    async function hydrate() {
      let s;
      try {
        s = await getSettings();
      } catch {
        return;
      }
      modeSel.value = s.mode;
      rowModel.style.display = s.mode === "api" ? "" : "none";
      modelSel.innerHTML = "";
      for (const m of MODELS_BY_PROVIDER[s.apiProvider]) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label;
        modelSel.appendChild(opt);
      }
      modelSel.value = s.apiModel;
      styleSel.value = s.promptStyle ?? "auto";
      if (s.mode === "api" && isContextValid()) {
        chrome.runtime.sendMessage({ type: "GET_TOKEN_STATS" }).then((r) => {
          if (r) updateTokenBar(r.byPlatform, r.tokenBudget);
        }).catch(() => {});
      }
      // Read platform's own usage quota from the page DOM
      try {
        const quota = adapter.readPlatformQuota?.();
        renderPlatformQuota(quota || null);
      } catch { renderPlatformQuota(null); }
    }
    btnMain.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    btnChev.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      menu.classList.toggle("open");
      if (menu.classList.contains("open")) {
        if (adapter.id === "claude") {
          // Show loading + ask the page-context bridge for fresh usage
          const els = quotaEls();
          if (els?.wrap) {
            els.wrap.style.display = "";
            if (els.hdr) els.hdr.textContent = "Claude usage";
            if (els.det && !els.det.textContent) { els.det.textContent = "Loading…"; els.det.style.color = "#6b7280"; }
          }
          refreshClaudeUsage();
        } else {
          try { renderPlatformQuota(adapter.readPlatformQuota?.()); } catch {}
        }
      }
    });
    pill.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {
      });
    });
    openOptionsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {
      });
      menu.classList.remove("open");
    });
    resetPosBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await savePos(null);
      userPlacedPos = false;
      menu.classList.remove("open");
      void reposition();
    });
    exportCtxBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      menu.classList.remove("open");
      void showExportOverlay();
    });
    const onDocPointer = (e) => {
      if (!menu.classList.contains("open")) return;
      const path = e.composedPath();
      if (!path.includes(host)) menu.classList.remove("open");
    };
    document.addEventListener("mousedown", onDocPointer, true);
    modeSel.addEventListener("change", async () => {
      await setSettings({ mode: modeSel.value });
      rowModel.style.display = modeSel.value === "api" ? "" : "none";
    });
    modelSel.addEventListener("change", () => setSettings({ apiModel: modelSel.value }));
    styleSel.addEventListener("change", () => setSettings({ promptStyle: styleSel.value }));
    let dragState = null;
    let userPlacedPos = false;
    const onGripDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        hostStartX: parseFloat(host.style.left) || 0,
        hostStartY: parseFloat(host.style.top) || 0
      };
      grip.setPointerCapture?.(e.pointerId);
      pill.classList.add("dragging");
      grip.classList.add("dragging");
    };
    const onGripMove = (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      let newLeft = dragState.hostStartX + dx;
      let newTop = dragState.hostStartY + dy;
      const r = host.getBoundingClientRect();
      newLeft = Math.max(2, Math.min(window.innerWidth - r.width - 2, newLeft));
      newTop = Math.max(2, Math.min(window.innerHeight - r.height - 2, newTop));
      host.style.left = `${Math.round(newLeft)}px`;
      host.style.top = `${Math.round(newTop)}px`;
    };
    const onGripUp = (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      grip.releasePointerCapture?.(e.pointerId);
      pill.classList.remove("dragging");
      grip.classList.remove("dragging");
      userPlacedPos = true;
      void savePos({
        top: parseFloat(host.style.top) || 0,
        left: parseFloat(host.style.left) || 0
      });
      dragState = null;
    };
    grip.addEventListener("pointerdown", onGripDown);
    grip.addEventListener("pointermove", onGripMove);
    grip.addEventListener("pointerup", onGripUp);
    grip.addEventListener("pointercancel", onGripUp);
    const reposition = async () => {
      if (!input.isConnected) return;
      if (userPlacedPos) {
        const r2 = host.getBoundingClientRect();
        let top2 = parseFloat(host.style.top) || 0;
        let left2 = parseFloat(host.style.left) || 0;
        top2 = Math.max(4, Math.min(window.innerHeight - r2.height - 4, top2));
        left2 = Math.max(8, Math.min(window.innerWidth - r2.width - 8, left2));
        host.style.top = `${Math.round(top2)}px`;
        host.style.left = `${Math.round(left2)}px`;
        return;
      }
      const r = input.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        host.style.display = "none";
        return;
      }
      host.style.display = "";
      const pillRect = pill.getBoundingClientRect();
      const pillW = pillRect.width || 130;
      const pillH = pillRect.height || 26;
      const margin = 8;
      let top = r.top + (r.height - pillH) / 2;
      let left = r.right + margin;
      if (left + pillW > window.innerWidth - 8) {
        left = r.right - pillW - margin;
      }
      if (left + pillW > window.innerWidth - 8) {
        left = window.innerWidth - pillW - 8;
        top = r.top - pillH - margin;
      }
      top = Math.max(4, Math.min(window.innerHeight - pillH - 4, top));
      left = Math.max(8, Math.min(window.innerWidth - pillW - 8, left));
      host.style.top = `${Math.round(top)}px`;
      host.style.left = `${Math.round(left)}px`;
    };
    void getSavedPos().then((p) => {
      if (p) {
        userPlacedPos = true;
        host.style.top = `${p.top}px`;
        host.style.left = `${p.left}px`;
      }
      void reposition();
    });
    const ro = new ResizeObserver(() => void reposition());
    ro.observe(input);
    ro.observe(document.documentElement);
    const onScroll = () => void reposition();
    const onResize = () => void reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    let n = 0;
    const settle = window.setInterval(() => {
      void reposition();
      if (++n > 12) window.clearInterval(settle);
    }, 120);
    return () => {
      window.clearInterval(settle);
      ro.disconnect();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("mousedown", onDocPointer, true);
      chrome.storage.onChanged.removeListener(storageListener);
      host.remove();
    };
  }
  function unmountTriggerButton() {
    document.getElementById(HOST_ID$1)?.remove();
  }
  const HOST_ID = "promptassist-overlay-host";
  function showOverlay(opts) {
    document.getElementById(HOST_ID)?.remove();
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "position: fixed; z-index: 2147483646; pointer-events: auto;";
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    let currentAnchor = opts.anchor;
    const close = () => {
      cleanup();
      host.remove();
    };
    const reposition = () => {
      if (!currentAnchor.isConnected) {
        close();
        return;
      }
      const r = currentAnchor.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        host.style.display = "none";
        return;
      }
      host.style.display = "";
      const panel = shadow.querySelector(".panel");
      if (!panel) return;
      const width = Math.min(680, Math.max(440, Math.round(r.width)));
      const margin = 12;
      const panelHeight = panel.getBoundingClientRect().height || 240;
      const spaceAbove = r.top - margin;
      const placeBelow = spaceAbove < 220 && window.innerHeight - r.bottom > spaceAbove;
      let top = placeBelow ? r.bottom + margin : Math.max(8, r.top - margin - panelHeight);
      let left = r.left;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
      if (left < 8) left = 8;
      host.style.top = `${Math.round(top)}px`;
      host.style.left = `${Math.round(left)}px`;
      panel.style.width = `${width}px`;
      panel.style.maxHeight = `${Math.min(560, Math.round(window.innerHeight * 0.6))}px`;
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    const onScrollResize = () => reposition();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    function cleanup() {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
    }
    const update = (o) => {
      currentAnchor = o.anchor;
      shadow.innerHTML = template(o);
      wire(shadow, o, close);
      requestAnimationFrame(reposition);
    };
    update(opts);
    setTimeout(reposition, 50);
    return { close, update };
  }
  function template(o) {
    const base = baseStyles();
    if (o.mode === "loading") {
      return `${base}
      <div class="panel small" role="dialog" aria-label="Optimizing prompt">
        <div class="body center">
          <div class="spinner"></div>
          <p class="muted">Optimizing\u2026</p>
        </div>
        ${o.onCancel ? `<div class="footer"><span class="spacer"></span><button data-action="cancel" class="link">Cancel</button></div>` : ""}
      </div>`;
    }
    if (o.mode === "chat-loading") {
      return `${base}
      <div class="panel small" role="dialog" aria-label="Rewriting via chat">
        <div class="body center">
          <div class="spinner"></div>
          <p class="muted">${esc(o.message)}</p>
          <p class="muted tiny">Your draft will be restored after.</p>
        </div>
        <div class="footer"><span class="spacer"></span><button data-action="cancel" class="link">Cancel</button></div>
      </div>`;
    }
    if (o.mode === "error") {
      return `${base}
      <div class="panel small" role="alertdialog">
        <div class="body"><p class="error">${esc(o.message)}</p></div>
        <div class="footer">
          <span class="spacer"></span>
          <button data-action="settings" class="link">Settings</button>
          <button data-action="cancel" class="primary">Close</button>
        </div>
      </div>`;
    }
    if (o.mode === "clarify") {
      const items = o.questions.map(
        (q, i) => `
        <li class="qa">
          <label for="pp-ans-${i}">${esc(q)}</label>
          <textarea id="pp-ans-${i}" data-qa="${i}" rows="2" placeholder="Your answer (optional)"></textarea>
        </li>`
      ).join("");
      return `${base}
      <div class="panel" role="dialog" aria-label="Clarifying questions">
        <div class="body">
          <p class="muted">Answer any of these to sharpen the rewrite. Leave blank to skip.</p>
          <ol class="qs">${items}</ol>
        </div>
        <div class="footer">
          <span class="spacer"></span>
          <button data-action="cancel" class="link">Cancel</button>
          <button data-action="continue" class="primary">Continue</button>
        </div>
      </div>`;
    }
    if (o.mode === "export") {
      const turns = o.turns || [];
      const turnCount = turns.length;
      const preview = buildExportMarkdown(turns, "");
      const est = estimateTokens(preview);
      const noTurns = turnCount === 0;
      const targetBtns = EXPORT_TARGETS.filter((t) => t.id !== adapter.id).map((t) =>
        `<button data-action="export-to" data-target-id="${t.id}" data-target-url="${t.url}" data-target-label="${t.label}" class="export-target-btn">${t.icon} ${t.label}</button>`
      ).join("");
      return `${base}
      <div class="panel" role="dialog" aria-label="Export chat context">
        <div class="body stack">
          ${noTurns
            ? `<div class="export-warn">⚠ Could not read messages from this page. Try scrolling up to load older messages, then try again.</div>`
            : `<div class="export-stats">${turnCount} messages captured &middot; ~${fmtTokens(est)} tokens</div>`
          }
          ${!noTurns ? `<p class="muted tiny" style="margin:4px 0 10px">Choose where to continue — PromptAssist will copy the conversation and open the tool:</p>
          <div class="export-targets">${targetBtns}</div>
          <details style="margin-top:10px">
            <summary class="refine-toggle" style="font-size:11.5px">Preview / copy manually</summary>
            <textarea class="text edit" spellcheck="false" id="pp-export-ta" style="min-height:100px;font-size:11px;font-family:monospace;margin-top:6px">${esc(preview)}</textarea>
            <button data-action="copy-export" class="primary" style="margin-top:6px;width:100%">Copy to clipboard</button>
          </details>` : ""}
        </div>
        <div class="footer">
          <span class="spacer"></span>
          <button data-action="cancel" class="link">Close</button>
        </div>
      </div>`;
    }
    const attachHint = o.attachmentsCount && o.attachmentsCount > 0 ? `<span class="meta">\xB7 ${o.attachmentsCount} attachment${o.attachmentsCount > 1 ? "s" : ""}</span>` : "";
    const tokenHint = o.tokens ? `<span class="meta">\xB7 ${fmtTokens(o.tokens)} tokens</span>` : "";
    return `${base}
    <div class="panel" role="dialog" aria-label="Review optimized prompt">
      <div class="body stack">
        <textarea class="text edit" data-id="opt-text" spellcheck="false" aria-label="Optimized prompt (editable)">${esc(o.optimized)}</textarea>
        <details class="orig">
          <summary>Show original ${attachHint}${tokenHint}</summary>
          <pre class="text muted">${esc(o.original)}</pre>
        </details>
        <details class="refine-section">
          <summary class="refine-toggle">Not quite? Add more context</summary>
          <div class="refine-body">
            <textarea class="refine-input" data-id="refine-text" rows="2" placeholder="e.g. make it shorter, for a technical audience, focus on X…"></textarea>
            <button data-action="reoptimize" class="primary" style="margin-top:6px;width:100%">Re-optimize →</button>
          </div>
        </details>
      </div>
      <div class="footer">
        ${o.onRegenerate ? `<button data-action="regen" class="link">Regenerate</button>` : ""}
        <button data-action="settings" class="link" title="Settings">Settings</button>
        <span class="spacer"></span>
        <button data-action="cancel" class="link">Cancel</button>
        ${o.onOpenInNewChat ? `<button data-action="newchat" class="link">New chat</button>` : ""}
        <button data-action="insert" class="link">Insert</button>
        <button data-action="replace" class="primary">Replace</button>
      </div>
    </div>`;
  }
  function wire(shadow, o, close) {
    const click = (action, fn) => {
      shadow.querySelector(`[data-action="${action}"]`)?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
    };
    click("cancel", () => {
      if (o.mode === "loading" || o.mode === "chat-loading") {
        o.onCancel?.();
      }
      close();
    });
    click("settings", () => {
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {
      });
    });
    if (o.mode === "diff" || o.mode === "result") {
      const getCurrent = () => {
        const ta = shadow.querySelector('textarea[data-id="opt-text"]');
        return ta?.value ?? o.optimized;
      };
      click("replace", () => {
        o.onReplace(getCurrent());
        close();
      });
      click("insert", () => {
        o.onInsertBelow(getCurrent());
        close();
      });
      if (o.onOpenInNewChat) {
        click("newchat", () => {
          o.onOpenInNewChat(getCurrent());
          close();
        });
      }
      if (o.onRegenerate) click("regen", () => o.onRegenerate());
      click("reoptimize", () => {
        const refineText = shadow.querySelector('[data-id="refine-text"]')?.value?.trim();
        if (refineText) o.onReoptimize?.(getCurrent(), refineText);
      });
    }
    if (o.mode === "export") {
      click("copy-export", () => {
        const ta = shadow.querySelector("#pp-export-ta");
        navigator.clipboard.writeText(ta?.value || "").catch(() => {});
        const btn = shadow.querySelector('[data-action="copy-export"]');
        if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy to clipboard"; }, 1800); }
      });
      shadow.querySelectorAll('[data-action="export-to"]').forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetLabel = btn.dataset.targetLabel;
          const targetUrl = btn.dataset.targetUrl;
          const targetId = btn.dataset.targetId;
          const md = buildExportMarkdown(o.turns || [], targetLabel);
          btn.textContent = "Saving…";
          btn.disabled = true;
          // Store for auto-paste when target tab loads
          await chrome.runtime.sendMessage({ type: "STORE_PENDING_IMPORT", payload: { text: md, targetId } }).catch(() => {});
          // Also copy to clipboard as fallback
          await navigator.clipboard.writeText(md).catch(() => {});
          btn.textContent = "✓ Opening — will auto-paste";
          setTimeout(() => { window.open(targetUrl, "_blank", "noopener"); }, 300);
        });
      });
    }
    if (o.mode === "clarify") {
      click("continue", () => {
        const inputs = shadow.querySelectorAll("textarea[data-qa]");
        const answers = [];
        inputs.forEach((ta) => answers.push(ta.value.trim()));
        o.onContinue(answers);
      });
    }
  }
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function baseStyles() {
    return `
  <style>
    :host, * { box-sizing: border-box; }
    .panel {
      position: relative;
      width: 520px;
      max-height: 56vh;
      background: #ffffff;
      color: #111827;
      border: 1px solid rgba(17, 24, 39, 0.08);
      border-radius: 14px;
      box-shadow: 0 1px 2px rgba(17, 24, 39, 0.04), 0 8px 24px rgba(17, 24, 39, 0.10);
      font: 13.5px/1.55 -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
      display: flex; flex-direction: column;
      overflow: hidden;
      animation: pp-fade 140ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .panel.small { width: 360px; }
    @keyframes pp-fade {
      from { opacity: 0; transform: translateY(2px) scale(0.99); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .spacer { flex: 1; }
    .body { padding: 14px; overflow: auto; }
    .body.center { padding: 22px 16px 18px; text-align: center; }
    .body.stack { display: flex; flex-direction: column; gap: 8px; }

    .text {
      margin: 0; padding: 11px 13px; white-space: pre-wrap; word-break: break-word;
      font: inherit; color: #111827; background: transparent;
      border: 1px solid rgba(17, 24, 39, 0.10);
      border-radius: 10px;
      max-height: 30vh; overflow: auto;
    }
    .text.muted { background: rgba(17, 24, 39, 0.03); color: #6b7280; }
    textarea.text {
      display: block; width: 100%; min-height: 132px; max-height: 36vh;
      resize: vertical; outline: none;
      transition: border-color 100ms ease, box-shadow 100ms ease;
    }
    textarea.text:focus {
      border-color: #6366f1;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    .orig { margin-top: 2px; }
    .orig summary {
      cursor: pointer; padding: 4px 2px;
      font-size: 11.5px; color: #6b7280; user-select: none;
      list-style: none;
    }
    .orig summary::-webkit-details-marker { display: none; }
    .orig summary::before {
      content: "\\203A"; display: inline-block; margin-right: 6px;
      transition: transform 120ms ease; color: #9ca3af;
    }
    .orig[open] summary::before { transform: rotate(90deg); }
    .orig summary:hover { color: #374151; }
    .orig pre { margin-top: 6px; }
    .meta { color: #9ca3af; margin-left: 4px; }
    .tiny { font-size: 11px !important; }
    .export-targets { display: flex; flex-direction: column; gap: 6px; }
    .export-target-btn {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px; border-radius: 9px; border: 1px solid rgba(79,70,229,0.25);
      background: rgba(79,70,229,0.06); color: #4f46e5;
      font: 600 13px/1.4 -apple-system,sans-serif; cursor: pointer; text-align: left;
      transition: background 120ms, border-color 120ms;
    }
    .export-target-btn:hover { background: rgba(79,70,229,0.14); border-color: rgba(79,70,229,0.5); }
    .export-stats { font-size: 13px; font-weight: 600; color: #111827; margin-bottom: 4px; }
    .export-warn { padding: 10px 12px; background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3); border-radius: 8px; font-size: 12.5px; color: #92400e; }
    @media (prefers-color-scheme: dark) {
      .export-target-btn { border-color: rgba(165,180,252,0.2); background: rgba(79,70,229,0.1); color: #a5b4fc; }
      .export-target-btn:hover { background: rgba(79,70,229,0.22); border-color: rgba(165,180,252,0.4); }
      .export-stats { color: #e5e7eb; }
      .export-warn { background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.2); color: #fbbf24; }
    }
    .refine-section { margin-top: 4px; }
    .refine-toggle {
      cursor: pointer; padding: 4px 2px;
      font-size: 11.5px; color: #6b7280; user-select: none;
      list-style: none;
    }
    .refine-toggle::-webkit-details-marker { display: none; }
    .refine-toggle::before {
      content: "\\203A"; display: inline-block; margin-right: 6px;
      transition: transform 120ms ease; color: #9ca3af;
    }
    .refine-section[open] .refine-toggle::before { transform: rotate(90deg); }
    .refine-toggle:hover { color: #374151; }
    .refine-body { display: flex; flex-direction: column; margin-top: 6px; }
    .refine-input {
      width: 100%; padding: 7px 9px; border-radius: 8px; resize: vertical;
      border: 1px solid rgba(17,24,39,0.15);
      font: 13px/1.5 -apple-system, system-ui, sans-serif;
      background: #f9fafb; color: #111827;
    }
    .refine-input:focus { outline: none; border-color: #4f46e5; background: #fff; }

    .footer {
      display: flex; align-items: center; gap: 4px;
      padding: 8px 10px;
      border-top: 1px solid rgba(17, 24, 39, 0.06);
    }

    button.primary, button.link {
      all: unset; cursor: pointer;
      font: 500 12.5px/1 inherit;
      border-radius: 8px;
      transition: background 90ms ease, color 90ms ease, transform 90ms ease;
    }
    button.link {
      color: #6b7280; padding: 7px 10px;
    }
    button.link:hover { color: #111827; background: rgba(17, 24, 39, 0.04); }
    button.primary {
      color: white; background: #4f46e5; padding: 8px 14px; font-weight: 600;
    }
    button.primary:hover { background: #4338ca; }
    button.primary:active { transform: translateY(1px); }

    .qs { padding-left: 22px; margin: 8px 0 0; display: flex; flex-direction: column; gap: 10px; }
    .qa { list-style: decimal; }
    .qa label {
      display: block; margin-bottom: 4px; color: #374151; font-size: 13px;
    }
    .qa textarea {
      width: 100%; resize: vertical;
      font: inherit;
      padding: 7px 10px; border-radius: 8px;
      border: 1px solid rgba(17, 24, 39, 0.10);
      background: #ffffff; color: #111827;
      outline: none;
      transition: border-color 100ms ease, box-shadow 100ms ease;
    }
    .qa textarea:focus {
      border-color: #6366f1;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    .muted { color: #6b7280; margin: 8px 0 0; font-size: 12.5px; }
    .muted.tiny { font-size: 11.5px; margin-top: 4px; }
    .error { color: #b91c1c; margin: 0; }

    .spinner {
      width: 22px; height: 22px; border-radius: 50%;
      border: 2px solid rgba(17, 24, 39, 0.10); border-top-color: #4f46e5;
      animation: spin 700ms linear infinite;
      margin: 0 auto 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    @media (prefers-color-scheme: dark) {
      .panel {
        background: #14161b; color: #e5e7eb;
        border-color: rgba(255, 255, 255, 0.08);
        box-shadow: 0 1px 2px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.45);
      }
      .text { color: #e5e7eb; border-color: rgba(255, 255, 255, 0.10); }
      .text.muted { background: rgba(255, 255, 255, 0.03); color: #9ca3af; }
      textarea.text:focus { border-color: #818cf8; box-shadow: 0 0 0 3px rgba(129, 140, 248, 0.20); }
      .orig summary { color: #9ca3af; }
      .orig summary:hover { color: #e5e7eb; }
      .meta { color: #6b7280; }
      .footer { border-color: rgba(255, 255, 255, 0.06); }
      button.link { color: #9ca3af; }
      button.link:hover { color: #f3f4f6; background: rgba(255, 255, 255, 0.06); }
      .muted { color: #9ca3af; }
      .qa label { color: #d1d5db; }
      .qa textarea {
        background: #0b0d11; color: #e5e7eb;
        border-color: rgba(255, 255, 255, 0.10);
      }
      .refine-toggle { color: #9ca3af; }
      .refine-toggle:hover { color: #e5e7eb; }
      .refine-input { background: #0b0d11; color: #e5e7eb; border-color: rgba(255,255,255,0.10); }
      .refine-input:focus { border-color: #818cf8; background: #111827; }
    }
  </style>
  `;
  }
  const META = `You are an expert prompt engineer. Transform the USER DRAFT into an optimized prompt using best practices from Anthropic (Claude), OpenAI, and Google (Gemini).

\u2501\u2501\u2501 REFINE MODE \u2014 for short, clear prompts (\u2264 ~150 words or simple intent) \u2501\u2501\u2501
Polish the draft: fix typos, sharpen clarity, add missing specificity.
Keep the original voice and intent. Do not add heavy structure.

\u2501\u2501\u2501 STRUCTURE MODE \u2014 for complex, large, or multi-step tasks (\u2265 ~150 words, technical/creative tasks, or when role context helps) \u2501\u2501\u2501
Apply full prompt engineering:
\u2022 Role / Persona \u2014 "You are a [specific expert]..."
\u2022 Context \u2014 essential background the AI needs to succeed
\u2022 Task \u2014 clear, specific description; break into steps if needed
\u2022 Constraints \u2014 what to avoid, tone, scope, limitations
\u2022 Output format \u2014 structure, length, sections, style
\u2022 Examples (optional) \u2014 only if they genuinely clarify the expected output

\u2501\u2501\u2501 WHICH MODE TO USE \u2501\u2501\u2501
Prompt style setting: {{promptStyle}}
- "auto" \u2192 assess the draft: choose REFINE for short/clear, STRUCTURE for complex/large
- "refine" \u2192 always use REFINE MODE regardless of length
- "structure" \u2192 always use STRUCTURE MODE regardless of length

\u2501\u2501\u2501 ALWAYS REWRITE \u2014 NO EXCEPTIONS \u2501\u2501\u2501
You ALWAYS produce a rewrite. Never ask questions. Never output a CLARIFY block.

For vague or incomplete drafts: make reasonable assumptions and produce the best rewrite possible. Add a brief parenthetical note at the end stating key assumptions \u2014 e.g. "(Assumed: professional audience, formal tone \u2014 use 'Add more context' below to refine.)"

For URLs in the draft: include them verbatim as reference anchors. Never ask what they contain.
For missing details: infer the most reasonable interpretation and proceed.

HARD RULES:
- Never invent proper nouns, names, dates, or numbers not in the draft
- URLs are reference anchors \u2014 include verbatim, never question them
- Do not pad with fictional context
- Preserve the user's original intent

OUTPUT \u2014 output ONLY this format, nothing else:

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
  const ATTACH_BLOCK = `ATTACHMENTS (the user attached these files; the rewrite should reference them naturally \u2014 e.g. "based on the attached <filename>"):
{{list}}

`;
  function buildMetaPrompt(draft, settings, site, attachments = []) {
    const attach2 = attachments.length ? ATTACH_BLOCK.replace("{{list}}", attachments.map((f) => `- ${f}`).join("\n")) : "";
    return META
      .replaceAll("{{tone}}", settings.tone)
      .replaceAll("{{verbosity}}", settings.verbosity)
      .replaceAll("{{promptStyle}}", settings.promptStyle || "auto")
      .replaceAll("{{site}}", site)
      .replaceAll("{{attachments_block}}", attach2)
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
  const PRIORITY = [
    claudeAdapter,
    chatgptAdapter,
    perplexityAdapter,
    geminiAdapter
  ];
  const adapter = PRIORITY.find((a) => a.matches(location.host)) ?? genericAdapter;
  let currentInput = null;
  let teardown = null;
  let chatRewriteAborted = false;
  const PENDING_KEY = "promptpolish.pending.v1";
  const PENDING_TTL_MS = 3e4;
  async function savePending(site, text) {
    const entry = { site, text, ts: Date.now() };
    await chrome.storage.local.set({ [PENDING_KEY]: entry });
  }
  async function consumePendingIfMatching() {
    const obj = await chrome.storage.local.get(PENDING_KEY);
    const entry = obj[PENDING_KEY];
    if (!entry) return null;
    if (Date.now() - entry.ts > PENDING_TTL_MS) {
      await chrome.storage.local.remove(PENDING_KEY);
      return null;
    }
    if (entry.site !== adapter.id) return null;
    await chrome.storage.local.remove(PENDING_KEY);
    return entry.text;
  }
  function attach() {
    if (currentInput && !currentInput.isConnected) {
      currentInput = null;
      teardown?.();
      teardown = null;
      unmountTriggerButton();
    }
    const input = adapter.findInput();
    if (!input) {
      if (currentInput) {
        currentInput = null;
        teardown?.();
        teardown = null;
        unmountTriggerButton();
      }
      return;
    }
    if (input === currentInput && teardown) return;
    currentInput = input;
    teardown?.();
    teardown = mountTriggerButton(input, () => void onOptimize());
  }
  function extractPeriod(text) {
    if (!text) return null;
    const m = text.match(/per\s+(day|week|hour|month)|today|this\s+(day|week|hour|month)|every\s+(\d+)\s+hours?/i);
    return m ? m[0].toLowerCase() : null;
  }
  function scanQuotaText(root, patterns) {
    // Walk visible text nodes in leaves looking for quota patterns
    // Avoid scanning inside script/style/hidden elements
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName?.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim() || "";
      if (text.length < 3 || text.length > 200) continue;
      for (const pat of patterns) {
        const m = text.match(pat);
        if (!m) continue;
        // Pattern "X of Y unit" or "X/Y unit"
        if (m[1] && m[2] && /^\d+$/.test(m[1]) && /^\d+$/.test(m[2])) {
          const used = parseInt(m[1], 10);
          const total = parseInt(m[2], 10);
          if (total > 0 && used <= total) {
            const unit = m[3]?.replace(/s$/, "") || "message";
            return { used, total, unit, period: extractPeriod(text) || "", raw: text };
          }
        }
        // Pattern "X remaining/left"
        if (m[1] && /^\d+$/.test(m[1])) {
          const remaining = parseInt(m[1], 10);
          const unit = m[2]?.replace(/s$/, "") || "message";
          return { remaining, unit, period: extractPeriod(text) || "", raw: text };
        }
        // Limit reached pattern
        if (!m[1]) {
          return { raw: text, period: "" };
        }
      }
    }
    return null;
  }
  function fmtTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(n);
  }
  function estimateTokens(text) {
    return Math.ceil((text || "").length / 4);
  }
  function mergeByDocOrder(humanEls, aiEls) {
    const tagged = [
      ...humanEls.map((el) => ({ role: "Human", el })),
      ...aiEls.map((el) => ({ role: "Assistant", el }))
    ];
    tagged.sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    const result = [];
    for (const item of tagged) {
      const isNested = result.some((r) => r.el.contains(item.el) || item.el.contains(r.el));
      if (!isNested) {
        const text = item.el.innerText?.trim();
        if (text) result.push({ role: item.role, el: item.el, text });
      }
    }
    return result.map(({ role, text }) => ({ role, text }));
  }
  function readConversationHistory() {
    const id = adapter.id;
    try {
      if (id === "claude") {
        const human = [...document.querySelectorAll(
          '[data-testid="human-turn"], [data-testid="user-message"]'
        )];
        const ai = [...document.querySelectorAll(
          'div.font-claude-message, [data-testid="ai-turn"], [data-testid="conversation-turn-assistant"]'
        )];
        const merged = mergeByDocOrder(human, ai);
        if (merged.length) return merged;
        // Fallback: all turn containers in order
        const all = [...document.querySelectorAll('[data-testid^="conversation-turn"]')];
        return all.map((el) => ({
          role: (el.dataset.testid || "").includes("human") ? "Human" : "Assistant",
          text: el.innerText?.trim()
        })).filter((t) => t.text);
      }
      if (id === "chatgpt") {
        // Each message div carries data-message-author-role — direct and reliable
        const msgs = [...document.querySelectorAll('[data-message-author-role]')];
        // Filter out nested duplicates
        return msgs
          .filter((el) => !msgs.some((p) => p !== el && p.contains(el)))
          .map((el) => ({
            role: el.dataset.messageAuthorRole === "user" ? "Human" : "Assistant",
            text: el.innerText?.trim()
          }))
          .filter((t) => t.text);
      }
      if (id === "gemini") {
        const human = [...document.querySelectorAll("user-query")];
        const ai = [...document.querySelectorAll("model-response")];
        return mergeByDocOrder(human, ai);
      }
      if (id === "perplexity") {
        // Perplexity: user questions are in elements with "UserMessage" in class names
        // answers in divs with id^="markdown-content" or class prose
        const human = [...document.querySelectorAll(
          '[class*="UserMessage"], [class*="userMessage"], [data-testid*="user-query"]'
        )];
        const ai = [...document.querySelectorAll(
          '[id^="markdown-content"], div.prose, [data-testid="answer-text"], [class*="AnswerBody"]'
        )];
        return mergeByDocOrder(human, ai);
      }
    } catch {}
    return [];
  }
  function buildExportMarkdown(turns, targetTool) {
    const site = adapter.id || location.hostname;
    const date = new Date().toLocaleString();
    const intro = targetTool
      ? `Continue this conversation in ${targetTool}. The full chat history is below.\n\n`
      : "";
    let md = `${intro}# Chat Export — ${site}\n_Exported via PromptAssist on ${date}_\n\n---\n\n`;
    for (const t of turns) {
      md += `**${t.role}:**\n${t.text}\n\n---\n\n`;
    }
    md += `\n_Total turns: ${turns.length}_\n`;
    return md;
  }
  const EXPORT_TARGETS = [
    { id: "claude", label: "Claude", url: "https://claude.ai/new", icon: "✦" },
    { id: "chatgpt", label: "ChatGPT", url: "https://chatgpt.com/", icon: "🤖" },
    { id: "gemini", label: "Gemini", url: "https://gemini.google.com/app", icon: "✨" },
    { id: "perplexity", label: "Perplexity", url: "https://www.perplexity.ai/", icon: "🔍" }
  ];
  function showExportOverlay() {
    const turns = readConversationHistory();
    const anchor = currentInput || document.body;
    const handle = showOverlay({
      mode: "export",
      turns,
      anchor
    });
    return handle;
  }
  async function onOptimize() {
    attach();
    if (!currentInput) {
      showOverlay({
        mode: "error",
        message: "Couldn't find the chat input on this page. Click into it first, then try again.",
        anchor: document.body
      });
      return;
    }
    const draft = adapter.getValue(currentInput).trim();
    const attachments = adapter.findAttachments?.() ?? [];
    if (!draft && attachments.length === 0) {
      showOverlay({
        mode: "error",
        message: "Type a draft prompt first, then click Optimize.",
        anchor: currentInput
      });
      return;
    }
    const settings = await getSettings();
    if (settings.mode === "chat") {
      if (!adapter.submit || !adapter.waitForReply) {
        showOverlay({
          mode: "error",
          message: "Chat-rewrite isn't supported on this site. Switch to API mode in the menu.",
          anchor: currentInput
        });
        return;
      }
      await runChatRewrite(draft, attachments);
      return;
    }
    let cancelled = false;
    const handle = showOverlay({
      mode: "loading",
      anchor: currentInput,
      onCancel: () => {
        cancelled = true;
      }
    });
    try {
      const req = {
        type: "OPTIMIZE",
        payload: { draft, site: adapter.id, attachments }
      };
      const res = await chrome.runtime.sendMessage(req);
      if (cancelled) return;
      showResult(handle, draft, attachments.length, res);
    } catch (err) {
      if (cancelled) return;
      handle.update({
        mode: "error",
        message: err instanceof Error ? err.message : String(err),
        anchor: currentInput
      });
    }
  }
  function showResult(handle, originalDraft, attachmentsCount, res) {
    if (!currentInput) return;
    if (!res) {
      handle.update({
        mode: "error",
        message: "No response from background worker.",
        anchor: currentInput
      });
      return;
    }
    if (res.kind === "error") {
      handle.update({ mode: "error", message: res.message, anchor: currentInput });
      return;
    }
    handle.update({
      mode: "diff",
      original: originalDraft,
      optimized: res.optimized,
      tokens: res.tokens || 0,
      anchor: currentInput,
      attachmentsCount,
      canOpenInNewChat: !!adapter.newChatUrl,
      onReplace: (text) => adapter.setValue(currentInput, text),
      onInsertBelow: (text) => adapter.setValue(currentInput, `${originalDraft}

${text}`),
      onOpenInNewChat: adapter.newChatUrl ? (text) => {
        void savePending(adapter.id, text).then(() => {
          window.open(adapter.newChatUrl(), "_blank", "noopener");
        });
      } : void 0,
      onRegenerate: () => void onOptimize(),
      onReoptimize: (currentOpt, refineText) => {
        const refinedDraft = `${currentOpt}\n\nAdditional refinement requested: ${refineText}`;
        handle.update({ mode: "loading", anchor: currentInput });
        chrome.runtime.sendMessage({
          type: "OPTIMIZE",
          payload: { draft: refinedDraft, site: adapter.id, attachments: adapter.findAttachments?.() ?? [] }
        }).then((result) => {
          if (!currentInput) return;
          showResult(handle, refinedDraft, 0, result ?? { kind: "error", message: "No response." });
        }).catch((err) => {
          if (currentInput) handle.update({ mode: "error", message: err instanceof Error ? err.message : String(err), anchor: currentInput });
        });
      }
    });
  }
  function combineDraftAndAnswers(draft, questions, answers) {
    const pairs = questions.map((q, i) => ({ q, a: answers[i]?.trim() ?? "" })).filter((p) => p.a);
    if (pairs.length === 0) return draft;
    const lines = pairs.map((p) => `- ${p.q}: ${p.a}`).join("\n");
    return `${draft}

Additional context:
${lines}`;
  }
  async function runChatRewrite(draft, attachments) {
    if (!currentInput) return;
    chatRewriteAborted = false;
    const settings = await getSettings();
    const meta = buildMetaPrompt(draft, settings, adapter.id, attachments);
    const handle = showOverlay({
      mode: "chat-loading",
      message: "Asking this chat to rewrite your prompt\u2026",
      anchor: currentInput,
      onCancel: () => {
        chatRewriteAborted = true;
        if (currentInput) adapter.setValue(currentInput, draft);
      }
    });
    adapter.setValue(currentInput, meta);
    await sleep(150);
    if (chatRewriteAborted) return;
    const submitted = adapter.submit?.(currentInput) ?? false;
    if (!submitted) {
      adapter.setValue(currentInput, draft);
      handle.update({
        mode: "error",
        message: "Couldn't find the Send button on this site. Try API mode instead.",
        anchor: currentInput
      });
      return;
    }
    let raw = null;
    try {
      raw = await adapter.waitForReply?.(45e3) ?? null;
    } catch (err) {
      raw = null;
      console.warn("[PromptAssist] waitForReply failed:", err);
    }
    if (chatRewriteAborted) return;
    adapter.setValue(currentInput, draft);
    if (!raw) {
      handle.update({
        mode: "error",
        message: "Timed out waiting for the chat to reply. The rewrite may still appear in the conversation above \u2014 copy it and use Insert.",
        anchor: currentInput
      });
      return;
    }
    const parsed = parseMetaResponse(raw);
    const optimized = parsed.optimized?.trim() || raw.trim();
    showResult(handle, draft, attachments.length, { kind: "ok", optimized });
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  async function consumePendingPrompt() {
    const text = await consumePendingIfMatching();
    if (!text) return;
    const input = await waitForElement(() => adapter.findInput(), 8e3);
    if (!input) {
      console.warn("[PromptAssist] pending prompt: input never appeared");
      return;
    }
    adapter.setValue(input, text);
    await sleep(180);
    adapter.submit?.(input);
  }
  function waitForElement(fn, timeoutMs) {
    const start = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const v = fn();
        if (v) {
          clearInterval(id);
          resolve(v);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(id);
          resolve(null);
        }
      };
      const id = setInterval(tick, 150);
      tick();
    });
  }
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg && msg.type === "TRIGGER_OPTIMIZE") void onOptimize();
  });

  // ── Bridge injection (MAIN world fetch interceptor) ───────────────────────
  function injectBridge() {
    if (document.getElementById("__pa-bridge__")) return;
    const s = document.createElement("script");
    s.id = "__pa-bridge__";
    s.src = chrome.runtime.getURL("inject/bridge.js");
    (document.head || document.documentElement).appendChild(s);
  }
  if (adapter.id === "claude" || adapter.id === "chatgpt" || adapter.id === "gemini") {
    injectBridge();
  }

  // ── Session token counter (bridge postMessage → floating button) ──────────
  const sessionTokens = { input: 0, output: 0, platform: adapter.id };
  function fmtT(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  }
  function updateSessionCounter() {
    // Find quota detail in any open floating button shadow root
    const pill = document.querySelector("[data-pa-pill]");
    if (!pill || !pill.shadowRoot) return;
    const el = pill.shadowRoot.getElementById("pp-quota-detail");
    const hdr = pill.shadowRoot.getElementById("pp-quota-platform");
    const wrap = pill.shadowRoot.getElementById("pp-quota-wrap");
    if (!el) return;
    const total = sessionTokens.input + sessionTokens.output;
    if (total === 0) return;
    if (wrap) wrap.style.display = "";
    if (hdr && !hdr.textContent.includes("session")) hdr.textContent = hdr.textContent || adapter.id;
    el.textContent = `Session: ${fmtT(sessionTokens.input)} in · ${fmtT(sessionTokens.output)} out · ${fmtT(total)} total`;
  }

  // Shadow-root element helpers
  function quotaEls() {
    const pill = document.querySelector("[data-pa-pill]");
    if (!pill?.shadowRoot) return null;
    return {
      wrap: pill.shadowRoot.getElementById("pp-quota-wrap"),
      hdr:  pill.shadowRoot.getElementById("pp-quota-platform"),
      per:  pill.shadowRoot.getElementById("pp-quota-period"),
      bar:  pill.shadowRoot.getElementById("pp-quota-bar-track"),
      fill: pill.shadowRoot.getElementById("pp-quota-bar-fill"),
      det:  pill.shadowRoot.getElementById("pp-quota-detail")
    };
  }

  window.addEventListener("message", (e) => {
    if (e.data?.source !== "PromptAssistBridge") return;
    const d = e.data;

    if (d.type === "claude_message_start") {
      sessionTokens.input += d.inputTokens || 0;
      sessionTokens.output += d.outputTokens || 0;
      updateSessionCounter();
    }
    if (d.type === "claude_message_delta") {
      sessionTokens.output += d.outputTokens || 0;
      updateSessionCounter();
    }
    if (d.type === "claude_message_limit") {
      showClaudeMessageLimit(d.limit);
    }
    if (d.type === "claude_usage_data") {
      showClaudeUsageBars(d.data);
    }
    if (d.type === "claude_usage_error") {
      const els = quotaEls();
      if (els?.wrap && els.det) {
        els.wrap.style.display = "";
        if (els.hdr) els.hdr.textContent = "Claude usage";
        if (els.bar) els.bar.style.display = "none";
        els.det.textContent = "Couldn't load usage: " + (d.error || "unknown error");
        els.det.style.color = "#f59e0b";
      }
    }
    if (d.type === "gpt_usage") {
      sessionTokens.input = Math.max(sessionTokens.input, d.promptTokens || 0);
      sessionTokens.output += d.completionTokens || 0;
      updateSessionCounter();
    }
    if (d.type === "gemini_usage") {
      sessionTokens.input = Math.max(sessionTokens.input, d.promptTokens || 0);
      sessionTokens.output += d.candidateTokens || 0;
      updateSessionCounter();
    }
  });

  function refreshClaudeUsage() {
    window.postMessage({ source: "PromptAssistContent", type: "refresh_claude_usage" }, "*");
  }

  // ── Adaptive usage renderer — handles whatever shape Claude returns ────────
  // Recursively searches an object for {used/limit} or {percent} + reset time.
  function findUsageWindows(obj, depth = 0, found = []) {
    if (!obj || typeof obj !== "object" || depth > 4) return found;
    const keys = Object.keys(obj);
    // Detect a usage-window-like object
    const hasPct = "utilization" in obj || "percent_used" in obj || "percentage" in obj || "percent" in obj;
    const hasUsedLimit = ("used" in obj || "count" in obj) && ("limit" in obj || "max" in obj || "total" in obj);
    const resetKey = keys.find((k) => /reset|expires|refresh|window_end|ends_at/i.test(k));
    if (hasPct || hasUsedLimit) {
      let pct = null;
      const rawPct = obj.utilization ?? obj.percent_used ?? obj.percentage ?? obj.percent;
      if (rawPct != null) pct = rawPct <= 1 ? Math.round(rawPct * 100) : Math.round(rawPct);
      else {
        const used = obj.used ?? obj.count;
        const lim = obj.limit ?? obj.max ?? obj.total;
        if (lim > 0) pct = Math.round((used / lim) * 100);
      }
      if (pct != null) {
        found.push({ pct, resetsAt: resetKey ? obj[resetKey] : null, used: obj.used ?? obj.count, limit: obj.limit ?? obj.max ?? obj.total });
        return found; // don't recurse into a matched window
      }
    }
    for (const k of keys) {
      const v = obj[k];
      if (v && typeof v === "object") findUsageWindows(v, depth + 1, found);
    }
    return found;
  }

  function showClaudeUsageBars(data) {
    const els = quotaEls();
    if (!els?.wrap) return;
    els.wrap.style.display = "";
    if (els.hdr) els.hdr.textContent = "Claude usage";
    if (els.per) els.per.textContent = "";

    // Try the documented 5h / 7d shape first
    const d5 = data?.["5h"] || data?.["5_hour"] || data?.five_hour || null;
    const d7 = data?.["7d"] || data?.["7_day"] || data?.seven_day || null;
    const parts = [];
    let primaryPct = null;

    const pctOf = (w) => {
      if (!w) return null;
      const raw = w.utilization ?? w.percent_used ?? w.percentage ?? w.percent;
      if (raw != null) return raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
      if ((w.limit ?? w.max) > 0) return Math.round(((w.used ?? w.count ?? 0) / (w.limit ?? w.max)) * 100);
      return null;
    };

    const pct5 = pctOf(d5);
    const pct7 = pctOf(d7);
    if (pct5 != null) {
      const r = formatTimeUntil(d5.resets_at || d5.resets || d5.expires_at);
      parts.push(`5h: ${pct5}% used${r ? ` · resets in ${r}` : ""}`);
      primaryPct = pct5;
    }
    if (pct7 != null) {
      const r = formatTimeUntil(d7.resets_at || d7.resets || d7.expires_at);
      parts.push(`7d: ${pct7}% used${r ? ` · resets in ${r}` : ""}`);
      primaryPct = primaryPct == null ? pct7 : Math.max(primaryPct, pct7);
    }

    // Fallback: adaptive search for any usage windows
    if (parts.length === 0) {
      const windows = findUsageWindows(data);
      for (const w of windows.slice(0, 3)) {
        const r = formatTimeUntil(w.resetsAt);
        const detail = w.used != null && w.limit != null ? `${w.used}/${w.limit}` : `${w.pct}%`;
        parts.push(`${detail} used${r ? ` · resets in ${r}` : ""}`);
        primaryPct = primaryPct == null ? w.pct : Math.max(primaryPct, w.pct);
      }
    }

    if (parts.length === 0) {
      // Last resort: show top-level keys so we can adapt next iteration
      if (els.bar) els.bar.style.display = "none";
      if (els.det) {
        const keys = data && typeof data === "object" ? Object.keys(data).slice(0, 6).join(", ") : typeof data;
        els.det.textContent = `Usage loaded (fields: ${keys})`;
        els.det.style.color = "#6b7280";
      }
      return;
    }

    const pct = primaryPct ?? 0;
    const color = pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "#22c55e";
    if (els.bar) els.bar.style.display = "";
    if (els.fill) { els.fill.style.width = pct + "%"; els.fill.style.background = color; }
    if (els.det) {
      els.det.textContent = parts.join("   ·   ");
      els.det.style.color = pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "";
    }
  }

  function showClaudeMessageLimit(limit) {
    if (!limit) return;
    const els = quotaEls();
    if (!els?.det) return;
    els.wrap.style.display = "";
    if (els.hdr) els.hdr.textContent = "Claude usage";
    if (limit.type === "approaching_limit" && limit.remaining != null) {
      const n = limit.remaining;
      els.det.textContent = `⚠ ${n} message${n === 1 ? "" : "s"} remaining this session`;
      els.det.style.color = n <= 3 ? "#ef4444" : "#f59e0b";
    } else if (limit.type === "exceeded_limit" || limit.type === "at_limit") {
      els.det.textContent = "🚫 Message limit reached";
      els.det.style.color = "#ef4444";
      if (els.bar) els.bar.style.display = "";
      if (els.fill) { els.fill.style.width = "100%"; els.fill.style.background = "#ef4444"; }
    }
  }

  function formatTimeUntil(isoStr) {
    if (!isoStr) return null;
    const t = typeof isoStr === "number" ? (isoStr < 1e12 ? isoStr * 1000 : isoStr) : Date.parse(isoStr);
    if (isNaN(t)) return null;
    const diff = t - Date.now();
    if (diff <= 0) return null;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // ── Export: auto-paste into target platform ───────────────────────────────
  async function consumePendingImport() {
    if (!chrome.runtime?.id) return;
    try {
      const pi = await chrome.runtime.sendMessage({ type: "GET_PENDING_IMPORT" });
      if (!pi || pi.targetId !== adapter.id) return;
      const input = await waitForElement(() => adapter.findInput(), 8e3);
      if (!input) return;
      adapter.setValue(input, pi.text);
      // Show a subtle toast
      const toast = document.createElement("div");
      toast.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#4f46e5;color:#fff;padding:10px 18px;border-radius:10px;font:600 13px/1 -apple-system,sans-serif;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.3)";
      toast.textContent = "✦ Chat context pasted — review and send";
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 4000);
    } catch {}
  }
  void consumePendingImport();

  const observer = new MutationObserver(() => attach());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  attach();
  setInterval(attach, 1e3);
  void consumePendingPrompt();
})();
