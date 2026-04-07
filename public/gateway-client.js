function resolveWsUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";

  if (!input) return `${wsProto}//${window.location.host}/gateway/`;
  if (input.startsWith("ws://") || input.startsWith("wss://")) return input;
  if (input.startsWith("http://")) return `ws://${input.slice("http://".length)}`;
  if (input.startsWith("https://")) return `wss://${input.slice("https://".length)}`;
  if (input.startsWith("//")) return `${wsProto}${input}`;
  if (input.startsWith("/")) return `${wsProto}//${window.location.host}${input}`;
  return input;
}

function generateRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeAuth(auth) {
  const next = {};
  if (auth && typeof auth.password === "string" && auth.password) next.password = auth.password;
  if (auth && typeof auth.token === "string" && auth.token) next.token = auth.token;
  return next;
}

function normalizeAuthMode(value) {
  const mode = String(value || "").toLowerCase();
  if (mode === "none" || mode === "password" || mode === "token") return mode;
  return "unknown";
}

function normalizeTransport(value) {
  const transport = String(value || "").toLowerCase();
  if (transport === "proxy" || transport === "direct") return transport;
  return "";
}

function appendQueryParam(url, key, value) {
  const base = String(url || "");
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function normalizeProxyBootstrap(proxy) {
  if (!proxy || typeof proxy !== "object") return null;
  const url = resolveWsUrl(proxy.url);
  const ticket = String(proxy.ticket || "").trim();
  const expiresAt = Number(proxy.expiresAt || 0);
  if (!url || !ticket) return null;
  return {
    url,
    ticket,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    connectUrl: appendQueryParam(url, "ticket", ticket)
  };
}

function normalizeDirectBootstrap(direct) {
  if (!direct || typeof direct !== "object") return null;
  const url = resolveWsUrl(direct.url);
  if (!url) return null;
  return {
    url,
    authMode: normalizeAuthMode(direct.authMode),
    password: typeof direct.password === "string" && direct.password ? direct.password : undefined,
    token: typeof direct.token === "string" && direct.token ? direct.token : undefined
  };
}

export async function fetchGatewayAuthConfig({ endpoint = "/api/gateway-auth", tokenKey = "openclaw_token" } = {}) {
  const headers = {};
  const token = window.localStorage?.getItem(tokenKey);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(endpoint, { method: "GET", headers });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    if (window.localStorage && tokenKey) {
      window.localStorage.removeItem(tokenKey);
    }
    window.location.href = "/login.html";
    throw new Error("Unauthorized");
  }

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `request failed (${res.status})`);
  }

  const transport = normalizeTransport(data?.transport);
  const proxy = normalizeProxyBootstrap(data?.proxy);
  const direct = normalizeDirectBootstrap(data?.direct);
  const allowDirectFallback = data?.allowDirectFallback === true;

  if (!transport) {
    throw new Error("gateway auth bootstrap missing transport");
  }
  if (transport === "proxy" && !proxy) {
    throw new Error("gateway auth bootstrap missing proxy config");
  }
  if (transport === "direct" && !direct) {
    throw new Error("gateway auth bootstrap missing direct config");
  }
  if (allowDirectFallback && !direct) {
    throw new Error("gateway auth bootstrap missing fallback direct config");
  }

  return {
    transport,
    allowDirectFallback,
    proxy,
    direct,
    meta: {
      version: Number(data?.meta?.version || 0),
      source: String(data?.meta?.source || "endpoint")
    },
    source: "endpoint"
  };
}

export class GatewayClient {
  constructor(options = {}) {
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : 15000;
    this.connectTimeoutMs = Number.isFinite(options.connectTimeoutMs) ? options.connectTimeoutMs : 15000;
    this.reconnectBaseDelayMs = Number.isFinite(options.reconnectBaseDelayMs)
      ? options.reconnectBaseDelayMs
      : 500;
    this.reconnectMaxDelayMs = Number.isFinite(options.reconnectMaxDelayMs)
      ? options.reconnectMaxDelayMs
      : 10000;
    this.maxReconnectAttempts = Number.isFinite(options.maxReconnectAttempts)
      ? options.maxReconnectAttempts
      : 8;
    this.autoReconnect = options.autoReconnect !== false;

    this.ws = null;
    this.connected = false;
    this.explicitClose = false;
    this.connectionConfig = null;

    this.status = "disconnected";
    this.statusListeners = new Set();
    this.eventListeners = new Set();
    this.pending = new Map();

    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.connectTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  onEvent(callback) {
    if (typeof callback !== "function") {
      throw new Error("onEvent callback must be a function");
    }
    this.eventListeners.add(callback);
    return () => {
      this.eventListeners.delete(callback);
    };
  }

  onStatusChange(callback, { emitCurrent = true } = {}) {
    if (typeof callback !== "function") {
      throw new Error("onStatusChange callback must be a function");
    }
    this.statusListeners.add(callback);
    if (emitCurrent) {
      callback({ status: this.status });
    }
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  getStatus() {
    return this.status;
  }

  isConnected() {
    return this.connected;
  }

  async connect(url, auth = {}, meta = {}) {
    const normalizedUrl = resolveWsUrl(url);
    if (!normalizedUrl) {
      throw new Error("gateway websocket url is required");
    }

    this.connectionConfig = {
      url: normalizedUrl,
      auth: normalizeAuth(auth),
      meta: meta && typeof meta === "object" ? { ...meta } : {}
    };
    this.explicitClose = false;
    this.clearReconnectTimer();

    return this.openSocket();
  }

  async openSocket() {
    if (!this.connectionConfig) {
      throw new Error("missing gateway connection config");
    }

    if (this.connected) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.setStatus("connecting", {
      url: this.connectionConfig.url,
      reconnectAttempt: this.reconnectAttempt,
      transport: String(this.connectionConfig?.meta?.transport || "")
    });

    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      const socket = new WebSocket(this.connectionConfig.url);
      this.ws = socket;

      socket.addEventListener("open", () => {
        if (socket !== this.ws) return;
        this.sendConnectFrame();
      });

      socket.addEventListener("message", (event) => {
        if (socket !== this.ws) return;
        Promise.resolve(this.handleRawMessage(event.data)).catch(() => {
          // Ignore malformed frames; close events will still surface transport failures.
        });
      });

      socket.addEventListener("close", (event) => {
        if (socket !== this.ws) return;
        this.handleSocketClose(event.code, event.reason || "");
      });

      socket.addEventListener("error", () => {
        if (socket !== this.ws) return;
        // Browser WebSocket error events do not expose actionable details.
        // Wait for the close event so we can surface its code/reason when available.
      });

      this.connectTimer = setTimeout(() => {
        this.failConnect(new Error(`gateway connect timeout after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
    });

    return this.connectPromise;
  }

  setStatus(status, metadata = {}) {
    this.status = status;
    const payload = { status, ...metadata };
    for (const callback of this.statusListeners) {
      try {
        callback(payload);
      } catch {
        // Listener errors should not break transport handling.
      }
    }
  }

  clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  failConnect(error) {
    if (this.connected || this.explicitClose) return;

    this.clearConnectTimer();

    if (this.connectReject) {
      this.connectReject(error instanceof Error ? error : new Error(String(error)));
    }

    this.connectResolve = null;
    this.connectReject = null;
    this.connectPromise = null;
  }

  resolveConnect(payload) {
    this.clearConnectTimer();

    if (this.connectResolve) {
      this.connectResolve(payload);
    }

    this.connectResolve = null;
    this.connectReject = null;
    this.connectPromise = null;
  }

  sendConnectFrame() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "openclaw-control-ui",
        version: "p4-t01b",
        platform: navigator.platform || "web",
        mode: "ui"
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: []
    };

    const auth = normalizeAuth(this.connectionConfig?.auth || {});
    if (Object.keys(auth).length > 0) {
      params.auth = auth;
    }

    this.ws.send(
      JSON.stringify({
        type: "req",
        id: generateRequestId(),
        method: "connect",
        params
      })
    );
  }

  async handleRawMessage(rawData) {
    let decoded = rawData;
    if (typeof Blob !== "undefined" && rawData instanceof Blob) {
      decoded = await rawData.text();
    } else if (rawData instanceof ArrayBuffer) {
      decoded = new TextDecoder().decode(new Uint8Array(rawData));
    } else if (ArrayBuffer.isView(rawData)) {
      decoded = new TextDecoder().decode(rawData);
    }

    let message;
    try {
      message = JSON.parse(decoded);
    } catch {
      return;
    }

    if (message?.type === "event") {
      if (message.event === "connect.challenge") {
        this.sendConnectFrame();
      }

      for (const callback of this.eventListeners) {
        try {
          callback(message);
        } catch {
          // Listener errors should not break transport handling.
        }
      }
      return;
    }

    if (message?.type !== "res") return;

    if (!this.connected && message.ok && message.payload?.type === "hello-ok") {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.resolveConnect(message.payload);
      this.setStatus("connected", {
        protocol: message.payload?.protocol || 3,
        transport: String(this.connectionConfig?.meta?.transport || "")
      });
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timeoutId);

    if (message.ok) {
      pending.resolve(message.payload);
    } else {
      pending.reject(new Error(message.error?.message || "gateway request failed"));
    }
  }

  request(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.connected) {
      return Promise.reject(new Error("gateway websocket is not connected"));
    }

    const id = generateRequestId();
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`gateway request timeout: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeoutId, method });

      try {
        this.ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (error) {
        clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  rejectPending(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  scheduleReconnect(reason) {
    if (!this.autoReconnect || !this.connectionConfig) {
      this.setStatus("disconnected", { reason });
      return;
    }

    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.setStatus("disconnected", {
        reason,
        reconnectExhausted: true,
        attempts: this.reconnectAttempt
      });
      return;
    }

    this.reconnectAttempt += 1;
    const delayMs = Math.min(
      this.reconnectBaseDelayMs * (2 ** (this.reconnectAttempt - 1)),
      this.reconnectMaxDelayMs
    );

    this.setStatus("reconnecting", {
      reason,
      attempt: this.reconnectAttempt,
      delayMs
    });

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.connectPromise = null;
      this.openSocket().catch((error) => {
        this.setStatus("reconnecting", {
          reason: error instanceof Error ? error.message : String(error),
          attempt: this.reconnectAttempt
        });
      });
    }, delayMs);
  }

  handleSocketClose(code, reasonText) {
    const reason = `gateway websocket closed (${code}): ${reasonText || "no reason"}`;

    this.connected = false;
    this.clearConnectTimer();
    this.failConnect(new Error(reason));
    this.rejectPending(new Error(reason));

    this.ws = null;

    if (this.explicitClose) {
      this.setStatus("disconnected", { reason });
      return;
    }

    this.scheduleReconnect(reason);
  }

  close() {
    this.explicitClose = true;
    this.clearReconnectTimer();
    this.clearConnectTimer();

    this.connected = false;
    this.failConnect(new Error("gateway client closed"));
    this.rejectPending(new Error("gateway client closed"));

    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;

    this.setStatus("disconnected", { reason: "closed by client" });
  }
}
