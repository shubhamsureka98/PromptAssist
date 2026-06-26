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
})();
