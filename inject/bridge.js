// Runs in MAIN page world — intercepts fetch to read SSE token/usage data.
// Communicates back to content script via window.postMessage.
(function () {
  if (window.__PA_BRIDGE__) return;
  window.__PA_BRIDGE__ = true;

  const POST = (msg) => window.postMessage({ source: "PromptAssistBridge", ...msg }, "*");
  const origFetch = window.fetch.bind(window);

  // ── Claude.ai endpoint patterns ───────────────────────────────────────────
  const CLAUDE_COMPLETION = /\/api\/organizations\/([^/?#]+)\/chat_conversations\/[^/?#]+\/completion/;
  const CLAUDE_USAGE      = /\/api\/organizations\/[^/?#]+\/usage/;

  // ── ChatGPT endpoint patterns ─────────────────────────────────────────────
  const GPT_CONVERSATION = /\/backend-api\/conversation/;

  // ── Gemini endpoint patterns ──────────────────────────────────────────────
  const GEMINI_STREAM = /\/v\d+[^?]*:(stream)?[Gg]enerate[Cc]ontent/;

  window.fetch = async function (resource, init) {
    const url = (typeof resource === "string" ? resource : resource?.url) || "";
    const response = await origFetch(resource, init);

    try {
      // Claude completion SSE
      const cMatch = url.match(CLAUDE_COMPLETION);
      if (cMatch && (init?.method || "GET").toUpperCase() === "POST") {
        const orgId = cMatch[1];
        interceptSSE(response.clone(), (data) => handleClaudeEvent(data, orgId));
        return response;
      }

      // ChatGPT conversation SSE
      if (GPT_CONVERSATION.test(url) && (init?.method || "GET").toUpperCase() === "POST") {
        interceptSSE(response.clone(), handleGPTEvent);
        return response;
      }

      // Gemini streaming
      if (GEMINI_STREAM.test(url) && (init?.method || "GET").toUpperCase() === "POST") {
        interceptJSON(response.clone(), handleGeminiResponse);
        return response;
      }

      // Passively capture claude.ai's own /usage responses
      const uMatch = url.match(CLAUDE_USAGE);
      if (uMatch && response.ok) {
        const orgId = (url.match(/organizations\/([^/?#]+)\/usage/) || [])[1] || null;
        response.clone().json().then((data) => {
          POST({ type: "claude_usage_data", data, orgId });
        }).catch(() => {});
      }
    } catch {}

    return response;
  };

  // ── SSE reader ────────────────────────────────────────────────────────────
  function interceptSSE(cloned, handler) {
    const reader = cloned.body?.getReader();
    if (!reader) return;
    const dec = new TextDecoder();
    let buf = "";
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop(); // keep incomplete last line
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (raw === "[DONE]") continue;
            try { handler(JSON.parse(raw)); } catch {}
          }
        }
      } catch {}
    })();
  }

  function interceptJSON(cloned, handler) {
    cloned.json().then(handler).catch(() => {});
  }

  // ── Claude event handler ──────────────────────────────────────────────────
  function handleClaudeEvent(data, orgId) {
    // Real token counts from the API response
    if (data.type === "message_start" && data.message?.usage) {
      POST({ type: "claude_message_start", orgId,
        inputTokens: data.message.usage.input_tokens || 0,
        outputTokens: data.message.usage.output_tokens || 0,
        cacheReadTokens: data.message.usage.cache_read_input_tokens || 0,
        cacheWriteTokens: data.message.usage.cache_creation_input_tokens || 0 });
    }
    if (data.type === "message_delta" && data.usage) {
      POST({ type: "claude_message_delta",
        outputTokens: data.usage.output_tokens || 0 });
    }
    // Claude's own session limit info (shows messages remaining)
    if (data.type === "message_limit") {
      POST({ type: "claude_message_limit", limit: data.message_limit });
    }
  }

  // ── ChatGPT event handler ─────────────────────────────────────────────────
  function handleGPTEvent(data) {
    if (data.usage) {
      POST({ type: "gpt_usage",
        promptTokens:     data.usage.prompt_tokens     || 0,
        completionTokens: data.usage.completion_tokens || 0,
        totalTokens:      data.usage.total_tokens      || 0 });
    }
  }

  // ── Gemini response handler ───────────────────────────────────────────────
  function handleGeminiResponse(data) {
    // Gemini returns an array of candidates; usageMetadata is at root or per item
    const usage = (Array.isArray(data) ? data[data.length - 1] : data)?.usageMetadata;
    if (usage) {
      POST({ type: "gemini_usage",
        promptTokens:     usage.promptTokenCount      || 0,
        candidateTokens:  usage.candidatesTokenCount  || 0,
        totalTokens:      usage.totalTokenCount        || 0 });
    }
  }

  // ── Active Claude usage fetch (page context = full credentials/CSRF) ───────
  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function getClaudeOrgId() {
    // 1. lastActiveOrg cookie (most reliable, what claude.ai itself uses)
    const cookieOrg = getCookie("lastActiveOrg");
    if (cookieOrg) return cookieOrg;
    // 2. /api/organizations
    try {
      const r = await origFetch("/api/organizations", { credentials: "include", headers: { accept: "application/json" } });
      if (r.ok) {
        const orgs = await r.json();
        const list = Array.isArray(orgs) ? orgs : [orgs];
        // prefer an org that has chat capability
        const best = list.find((o) => o?.uuid) || list[0];
        if (best?.uuid) return best.uuid;
      }
    } catch {}
    return null;
  }

  async function fetchClaudeUsageActive() {
    if (location.hostname !== "claude.ai" && !location.hostname.endsWith(".claude.ai")) return;
    let orgId = null;
    try {
      orgId = await getClaudeOrgId();
      if (!orgId) { POST({ type: "claude_usage_error", error: "Could not find your organization ID (not logged in?)." }); return; }

      const res = await origFetch(`/api/organizations/${orgId}/usage`, {
        credentials: "include",
        headers: { accept: "application/json" }
      });
      if (!res.ok) {
        POST({ type: "claude_usage_error", error: `Usage API returned ${res.status}.`, orgId });
        return;
      }
      const data = await res.json();
      POST({ type: "claude_usage_data", data, orgId });
    } catch (e) {
      POST({ type: "claude_usage_error", error: (e && e.message) || String(e), orgId });
    }
  }

  // Respond to explicit refresh requests from the content script
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (e.data?.source === "PromptAssistContent" && e.data?.type === "refresh_claude_usage") {
      void fetchClaudeUsageActive();
    }
  });

  // Initial fetch shortly after load
  setTimeout(() => void fetchClaudeUsageActive(), 600);
})();
