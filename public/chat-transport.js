import { GatewayClient, fetchGatewayAuthConfig } from "./gateway-client.js?v=20260407-chat-proxy-v2";

const DEFAULT_TOKEN_KEY = "openclaw_token";

function readToken(tokenKey = DEFAULT_TOKEN_KEY) {
  return window.localStorage?.getItem(tokenKey) || "";
}

function handleUnauthorized(tokenKey = DEFAULT_TOKEN_KEY) {
  if (window.localStorage && tokenKey) {
    window.localStorage.removeItem(tokenKey);
  }
  window.location.href = "/login.html";
}

function buildHeaders({ tokenKey = DEFAULT_TOKEN_KEY, includeJson = true, extraHeaders = {} } = {}) {
  const headers = includeJson ? { "Content-Type": "application/json", ...extraHeaders } : { ...extraHeaders };
  const token = readToken(tokenKey);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJson(path, { method = "GET", body, headers = {}, tokenKey = DEFAULT_TOKEN_KEY } = {}) {
  const options = {
    method,
    headers: buildHeaders({ tokenKey, includeJson: body !== undefined, extraHeaders: headers })
  };
  if (body !== undefined) {
    options.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    handleUnauthorized(tokenKey);
    throw new Error("Unauthorized");
  }

  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `request failed (${res.status})`);
  }

  return data;
}

function buildUrl(path, params = {}) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function createNoopResult() {
  return { ok: true };
}

function parseTransportMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "legacy-ws") return "legacy-ws";
  if (mode === "http-poll") return "http-poll";
  return "http-sse";
}

function parseSyncMode(value, fallback = "events") {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "polling" || mode === "http-poll") return "polling";
  if (mode === "events" || mode === "live") return "events";
  return fallback;
}

function parseSseBlock(block) {
  const lines = String(block || "").split(/\r?\n/);
  let eventName = "message";
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    let value = separator >= 0 ? line.slice(separator + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      eventName = value || "message";
      continue;
    }
    if (field === "data") {
      dataLines.push(value);
    }
  }

  return {
    eventName,
    data: dataLines.join("\n")
  };
}

class BaseChatTransport {
  constructor(options = {}) {
    this.tokenKey = options.tokenKey || DEFAULT_TOKEN_KEY;
    this.status = "disconnected";
    this.statusListeners = new Set();
    this.eventListeners = new Set();
  }

  onEvent(callback) {
    if (typeof callback !== "function") {
      throw new Error("onEvent callback must be a function");
    }
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  onStatusChange(callback, { emitCurrent = true } = {}) {
    if (typeof callback !== "function") {
      throw new Error("onStatusChange callback must be a function");
    }
    this.statusListeners.add(callback);
    if (emitCurrent) callback({ status: this.status });
    return () => this.statusListeners.delete(callback);
  }

  emitEvent(frame) {
    for (const listener of this.eventListeners) {
      listener(frame);
    }
  }

  setStatus(status, metadata = {}) {
    this.status = String(status || "disconnected");
    const payload = { status: this.status, ...metadata };
    for (const listener of this.statusListeners) {
      listener(payload);
    }
  }
}

function performHttpChatRequest(requestJson, method, params = {}) {
  const normalizedMethod = String(method || "");
  if (normalizedMethod === "sessions.subscribe"
    || normalizedMethod === "sessions.messages.subscribe"
    || normalizedMethod === "sessions.messages.unsubscribe") {
    return createNoopResult();
  }

  if (normalizedMethod === "sessions.list") {
    return requestJson(buildUrl("/api/chat/sessions", {
      limit: params.limit,
      includeLastMessage: params.includeLastMessage
    }), { method: "GET" });
  }

  if (normalizedMethod === "chat.history") {
    return requestJson(buildUrl("/api/chat/history", {
      sessionKey: params.sessionKey,
      limit: params.limit
    }), { method: "GET" });
  }

  if (normalizedMethod === "chat.send") {
    return requestJson("/api/chat/send", {
      method: "POST",
      body: JSON.stringify(params)
    });
  }

  if (normalizedMethod === "chat.abort") {
    return requestJson("/api/chat/abort", {
      method: "POST",
      body: JSON.stringify(params)
    });
  }

  if (normalizedMethod === "sessions.patch") {
    return requestJson("/api/chat/session", {
      method: "POST",
      body: JSON.stringify(params)
    });
  }

  throw new Error(`unsupported chat method over HTTP transport: ${normalizedMethod}`);
}

export class HttpPollingChatTransport extends BaseChatTransport {
  constructor(options = {}) {
    super(options);
    this.requestJson = typeof options.requestJson === "function"
      ? options.requestJson
      : (path, requestOptions = {}) => fetchJson(path, { ...requestOptions, tokenKey: this.tokenKey });
    this.connected = false;
    this.closed = false;
  }

  isConnected() {
    return this.connected && !this.closed;
  }

  async connect() {
    this.closed = false;
    this.connected = true;
    this.setStatus("connected", { transport: "http-poll", syncMode: "polling" });
  }

  close() {
    this.closed = true;
    this.connected = false;
    this.setStatus("disconnected", {
      transport: "http-poll",
      reason: "chat transport closed",
      syncMode: "polling"
    });
  }

  async request(method, params = {}) {
    return performHttpChatRequest(this.requestJson, method, params);
  }
}

export class HttpSseChatTransport extends BaseChatTransport {
  constructor(options = {}) {
    super(options);
    this.eventsEndpoint = options.eventsEndpoint || "/api/chat/events";
    this.requestJson = typeof options.requestJson === "function"
      ? options.requestJson
      : (path, requestOptions = {}) => fetchJson(path, { ...requestOptions, tokenKey: this.tokenKey });
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : 15000;
    this.connectTimeoutMs = Number.isFinite(options.connectTimeoutMs) ? options.connectTimeoutMs : 15000;
    this.reconnectBaseDelayMs = Number.isFinite(options.reconnectBaseDelayMs)
      ? options.reconnectBaseDelayMs
      : 1000;
    this.reconnectMaxDelayMs = Number.isFinite(options.reconnectMaxDelayMs)
      ? options.reconnectMaxDelayMs
      : 10000;
    this.autoReconnect = options.autoReconnect !== false;
    this.started = false;
    this.closed = false;
    this.streamAbortController = null;
    this.streamReader = null;
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.requestsReady = false;
    this.syncMode = "events";
  }

  isConnected() {
    return this.requestsReady && !this.closed;
  }

  async connect() {
    if (this.closed) {
      this.closed = false;
    }
    if (this.started && this.connectPromise) {
      return this.connectPromise;
    }
    if (this.started && this.streamAbortController) {
      return;
    }

    this.started = true;
    this.clearReconnectTimer();
    this.setStatus("connecting", { transport: "http-sse", syncMode: this.syncMode });
    this.connectPromise = Promise.resolve(this.openEventStream({ initial: true })).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  close() {
    this.closed = true;
    this.started = false;
    this.requestsReady = false;
    this.clearReconnectTimer();
    if (this.streamAbortController) {
      this.streamAbortController.abort();
      this.streamAbortController = null;
    }
    try {
      this.streamReader?.cancel?.();
    } catch {
      // Ignore reader cancellation errors during shutdown.
    }
    this.streamReader = null;
    this.reconnectAttempt = 0;
    this.setStatus("disconnected", {
      transport: "http-sse",
      reason: "chat transport closed",
      syncMode: this.syncMode
    });
  }

  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  scheduleReconnect(reason = "") {
    if (!this.autoReconnect || this.closed || !this.started || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const attempt = this.reconnectAttempt;
    const delay = Math.min(
      this.reconnectBaseDelayMs * (2 ** Math.max(0, attempt - 1)),
      this.reconnectMaxDelayMs
    );
    this.setStatus("reconnecting", {
      reason,
      attempt,
      transport: "http-sse",
      syncMode: this.syncMode
    });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openEventStream().catch(() => {
        // openEventStream() already schedules the next retry on failure.
      });
    }, delay);
  }

  async openEventStream({ initial = false } = {}) {
    if (this.closed || !this.started) return;
    if (this.streamAbortController) return;
    const controller = new AbortController();
    this.streamAbortController = controller;
    const connectTimer = window.setTimeout(() => {
      controller.abort();
    }, this.connectTimeoutMs);

    try {
      const response = await fetch(this.eventsEndpoint, {
        method: "GET",
        headers: buildHeaders({
          tokenKey: this.tokenKey,
          includeJson: false,
          extraHeaders: { Accept: "text/event-stream" }
        }),
        cache: "no-store",
        signal: controller.signal
      });
      window.clearTimeout(connectTimer);

      if (response.status === 401) {
        handleUnauthorized(this.tokenKey);
        throw new Error("Unauthorized");
      }
      if (!response.ok) {
        throw new Error(`chat events request failed (${response.status})`);
      }
      if (!response.body) {
        throw new Error("chat events stream body is unavailable");
      }

      this.requestsReady = true;
      this.streamReader = response.body.getReader();
      if (this.status === "disconnected") {
        this.setStatus("connecting", { transport: "http-sse", syncMode: this.syncMode });
      }
      const reader = this.streamReader;
      this.consumeEventStream(reader, controller.signal)
        .catch((error) => {
          if (controller.signal.aborted || this.closed) return;
          const message = error instanceof Error ? error.message : String(error);
          this.streamReader = null;
          this.streamAbortController = null;
          this.scheduleReconnect(message);
        })
        .finally(() => {
          if (this.streamAbortController === controller) {
            this.streamAbortController = null;
          }
          if (this.streamReader === reader) {
            this.streamReader = null;
          }
        });
      return;
    } catch (error) {
      window.clearTimeout(connectTimer);
      if (this.closed) return;
      const message = controller.signal.aborted || error?.name === "AbortError"
        ? `gateway connect timeout after ${this.connectTimeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
      this.streamReader = null;
      if (initial) {
        this.started = false;
        this.requestsReady = false;
        this.setStatus("disconnected", {
          reason: message,
          transport: "http-sse",
          syncMode: this.syncMode
        });
        throw error;
      }
      this.scheduleReconnect(message);
    } finally {
      if (this.streamAbortController === controller && !this.streamReader) {
        this.streamAbortController = null;
      }
    }
  }

  async consumeEventStream(reader, signal) {
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("chat event stream closed");
      }
      buffer += decoder.decode(value, { stream: true });

      let splitIndex = buffer.search(/\r?\n\r?\n/);
      while (splitIndex >= 0) {
        const rawBlock = buffer.slice(0, splitIndex);
        buffer = buffer.slice(splitIndex + (buffer.startsWith("\r\n\r\n", splitIndex) ? 4 : 2));
        const { eventName, data } = parseSseBlock(rawBlock);
        if (data) {
          this.handleSseEvent(eventName, data);
        }
        splitIndex = buffer.search(/\r?\n\r?\n/);
      }
    }
  }

  handleSseEvent(eventName, rawData) {
    let frame;
    try {
      frame = JSON.parse(rawData);
    } catch {
      return;
    }

    if (eventName === "transport.status" || frame?.event === "transport.status") {
      const payload = frame?.payload || {};
      const status = String(payload.status || "").toLowerCase();
      const syncMode = parseSyncMode(
        payload.syncMode || payload.mode,
        status === "degraded" ? "polling" : this.syncMode
      );
      if (status === "connected" || status === "degraded") {
        this.reconnectAttempt = 0;
        this.syncMode = syncMode;
        this.setStatus("connected", {
          reason: String(payload.reason || ""),
          attempt: 0,
          transport: "http-sse",
          syncMode,
          subscriptionSupported: payload.subscriptionSupported !== false
        });
        return;
      }
      if (status === "connecting") {
        this.setStatus("connecting", {
          reason: String(payload.reason || ""),
          attempt: Number(payload.attempt || 0) || 0,
          transport: "http-sse",
          syncMode: this.syncMode
        });
        return;
      }
      if (status === "reconnecting" || status === "disconnected") {
        this.syncMode = syncMode;
        this.setStatus(status === "disconnected" ? "disconnected" : "reconnecting", {
          reason: String(payload.reason || ""),
          attempt: Number(payload.attempt || 0) || this.reconnectAttempt,
          transport: "http-sse",
          syncMode
        });
        return;
      }
    }

    this.emitEvent(frame);
  }

  async request(method, params = {}) {
    return performHttpChatRequest(this.requestJson, method, params);
  }
}

export class LegacyGatewayChatTransport extends BaseChatTransport {
  constructor(options = {}) {
    super(options);
    this.bootstrapEndpoint = options.bootstrapEndpoint || "/api/gateway-auth";
    this.client = new GatewayClient({
      requestTimeoutMs: options.requestTimeoutMs,
      connectTimeoutMs: options.connectTimeoutMs,
      reconnectBaseDelayMs: options.reconnectBaseDelayMs,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs,
      maxReconnectAttempts: options.maxReconnectAttempts,
      autoReconnect: false
    });

    this.client.onStatusChange((info) => {
      this.setStatus(info.status, {
        ...info,
        transport: String(info.transport || this.transportName || "legacy-ws")
      });
    });
    this.client.onEvent((frame) => this.emitEvent(frame));
    this.transportName = "legacy-ws";
  }

  isConnected() {
    return this.client.isConnected();
  }

  async connect() {
    if (this.client.isConnected()) return;
    const authConfig = await fetchGatewayAuthConfig({
      endpoint: this.bootstrapEndpoint,
      tokenKey: this.tokenKey
    });
    const requestedTransport = String(authConfig?.transport || "proxy");
    if (requestedTransport === "direct") {
      await this.connectWithTransport(authConfig, "direct");
      return;
    }
    try {
      await this.connectWithTransport(authConfig, "proxy");
    } catch (error) {
      if (!(authConfig?.allowDirectFallback === true && authConfig?.direct?.url)) {
        throw error;
      }
      await this.connectWithTransport(authConfig, "direct");
    }
  }

  buildConnectOptions(authConfig, transport) {
    if (transport === "proxy") {
      if (!authConfig?.proxy?.connectUrl) {
        throw new Error("chat proxy bootstrap missing connect url");
      }
      return {
        url: authConfig.proxy.connectUrl,
        auth: {},
        transport: "proxy"
      };
    }
    if (!authConfig?.direct?.url) {
      throw new Error("chat direct bootstrap missing url");
    }
    return {
      url: authConfig.direct.url,
      auth: {
        password: authConfig?.direct?.password,
        token: authConfig?.direct?.token
      },
      transport: "direct"
    };
  }

  async connectWithTransport(authConfig, transport) {
    const options = this.buildConnectOptions(authConfig, transport);
    this.transportName = options.transport;
    await this.client.connect(options.url, options.auth, { transport: options.transport });
  }

  async request(method, params = {}) {
    return this.client.request(method, params);
  }

  close() {
    this.client.close();
  }
}

export function createChatTransport(options = {}) {
  const mode = parseTransportMode(
    options.mode || "http-sse"
  );
  if (mode === "legacy-ws") {
    return new LegacyGatewayChatTransport(options);
  }
  if (mode === "http-poll") {
    return new HttpPollingChatTransport(options);
  }
  return new HttpSseChatTransport(options);
}
