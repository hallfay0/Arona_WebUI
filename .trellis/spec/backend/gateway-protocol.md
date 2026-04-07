# Gateway Protocol

> WebSocket wire protocol between Arona WebUI Chat, the WebUI proxy, and the upstream OpenClaw gateway.

---

## Scenario: Browser Chat Bootstrap, Proxy WS Upgrade, and Gateway RPC

### 1. Scope / Trigger
- Trigger: changes to `public/gateway-client.js`, `public/app.js`, `/api/gateway-auth`, `/api/chat/ws`, or Chat request/event methods.
- Why code-spec depth is required: Chat now has two transport modes (`proxy` / `direct`) plus explicit fallback rules. Handshake drift at any boundary breaks the entire Chat view.

### 2. Signatures

#### Frame format
```json
{
  "type": "req | res | event",
  "id": "<uuid for req/res correlation>",
  "method": "<req only>",
  "params": {},
  "ok": true,
  "payload": {},
  "error": { "message": "..." },
  "event": "<event name>"
}
```

#### Browser bootstrap
```json
{
  "ok": true,
  "transport": "proxy | direct",
  "allowDirectFallback": false,
  "proxy": {
    "url": "/api/chat/ws",
    "ticket": "<opaque>",
    "expiresAt": 1760000000000
  },
  "direct": {
    "url": "wss://example.com/gateway/",
    "authMode": "password | token | none",
    "password": "<optional>",
    "token": "<optional>"
  },
  "meta": {
    "version": 1,
    "source": "endpoint"
  }
}
```

#### Browser proxy websocket URL
- Frontend derives:
  - `proxy.connectUrl = proxy.url + "?ticket=" + encodeURIComponent(proxy.ticket)`
- Current backend returns:
  - `proxy.url === "/api/chat/ws"`

#### Connect handshake request
```json
{
  "type": "req",
  "id": "<uuid>",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "openclaw-control-ui",
      "version": "<browser build id>",
      "platform": "<navigator.platform | web>",
      "mode": "ui"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write", "operator.admin"],
    "caps": [],
    "auth": {
      "password": "<optional>",
      "token": "<optional>"
    }
  }
}
```

#### Browser-used RPC methods
- `sessions.subscribe({})`
- `sessions.messages.subscribe({ key })`
- `sessions.messages.unsubscribe({ key })`
- `sessions.list({ limit, includeLastMessage })`
- `sessions.patch({ key, label, model? })`
- `chat.history({ sessionKey, limit })`
- `chat.send({ sessionKey, message, idempotencyKey })`
- `chat.abort({ sessionKey })`

### 3. Contracts

#### Bootstrap contract
- Frontend must always bootstrap from `GET /api/gateway-auth`.
- Frontend must require:
  - `transport`
  - `proxy` block when `transport === "proxy"`
  - `direct` block when `transport === "direct"`
- Frontend must not interpret `404`, malformed JSON, or missing fields as permission to direct-connect.
- `allowDirectFallback` only means:
  - **if** proxy connect fails **and** direct info exists
  - frontend may explicitly retry with direct transport

#### Transport selection contract
- Default path:
  1. fetch bootstrap
  2. if `transport === "proxy"`, connect proxy first
  3. only if proxy connect fails and `allowDirectFallback === true`, retry with direct
- Direct bootstrap path:
  - if backend returns `transport === "direct"`, frontend connects direct immediately
- Current WebUI `GatewayClient` runs with:
  - `autoReconnect: false`
  - reconnect is handled at the Chat view orchestration layer, not by the transport object itself

#### Proxy websocket contract
- Backend `ChatProxySession` creates **one upstream Gateway WebSocket per browser WebSocket**.
- Proxy forwards normal `req/res/event` frames transparently.
- Proxy only rewrites the browser `connect` request:
  - preserves `client.id`, `client.version`, `client.platform`, `client.mode`
  - preserves `role`, `scopes`, `caps`
  - removes browser-supplied `params.auth`
  - injects server-held `gatewayConfig.password` / `gatewayConfig.token`
- Upstream frames must reach the browser as JSON-compatible text for handshake parsing.
  - If Node `ws` emits a text frame as `Buffer`, proxy must convert it to UTF-8 string before sending to the browser.

#### Handshake success criteria
- Browser must wait for a `res` frame where:
  - `ok === true`
  - `payload.type === "hello-ok"`
- Raw socket `open` is **not** sufficient to mark the client connected.
- If gateway emits `event: "connect.challenge"`, browser must resend the `connect` request.
- Browser-side frame parser must accept:
  - string
  - `Blob`
  - `ArrayBuffer`
  - typed array views

#### Close code contract
- Proxy must not blindly replay every close code received from the browser or upstream.
- Only valid WebSocket close codes may be passed to `ws.close()`.
- Current normalization rules:
  - keep `1000`
  - keep `1001`, `1002`, `1003`, `1007`–`1014`
  - keep `3000`–`4999`
  - otherwise fallback to `1000` or `1011` depending on call site

#### Request / response rules
- Each browser request uses a fresh UUID `id`.
- Pending requests time out after `requestTimeoutMs` (currently `15000`).
- When the websocket closes, all pending requests must reject.
- `chatRequest()` may retry once only when:
  - reconnect is allowed for that action
  - error text indicates disconnected transport

#### Chat subscription contract
- After successful connection, frontend calls `sessions.subscribe({})`.
- When selecting a session:
  - unsubscribe old `sessions.messages` subscription if key changed
  - subscribe new `sessions.messages` key
- If subscription methods are unsupported:
  - set `state.chat.subscriptions.supported = false`
  - keep basic Chat send/history functionality
  - rely on manual refresh + `chat` event path

#### Event contract
- Browser reacts to:
  - `chat`
  - `sessions.changed`
  - `session.message`
- `chat`
  - drives delta / final / aborted / error for the pending assistant bubble
- `sessions.changed`
  - debounced refresh of session list
  - if it targets the active session and reason/phase is message-like, schedule silent history refresh
- `session.message`
  - always refresh session summaries
  - if it targets the active session, schedule silent history refresh
  - otherwise mark `needsRefresh=true`

#### Refresh / reconnect separation
- `立即重连`
  - fetches new bootstrap
  - creates a new transport
  - resubscribes
  - then triggers a reconnect-flavored data refresh
- `刷新`
  - does not rebuild transport
  - only reloads session list + current session history
  - if transport is currently down, it should fail fast instead of silently reconnecting

### 4. Validation & Error Matrix

| Condition | Transport result | Expected behavior |
|---|---|---|
| `/api/gateway-auth` missing / malformed | bootstrap error | Frontend must stop and surface error; no implicit direct fallback |
| `transport=proxy` and proxy connect succeeds | connected | frontend sets active transport to `proxy` |
| `transport=proxy` and proxy connect fails, `allowDirectFallback=false` | disconnected | show reconnect affordance, no direct retry |
| `transport=proxy` and proxy connect fails, `allowDirectFallback=true` | fallback | frontend retries once with direct |
| raw socket opens but `hello-ok` not received | connect timeout | keep status disconnected |
| `connect.challenge` event received | event frame | resend `connect` request |
| proxy forwards text frame as binary and browser doesn’t decode | bug / timeout | must be prevented by UTF-8 normalization on proxy and Blob/ArrayBuffer decoding in browser |
| browser/upstream close with reserved code (`1005/1006/1015`) | close handling | proxy must normalize to legal close code before calling `ws.close()` |
| `chat.send` missing `sessionKey` or `idempotencyKey` | gateway error frame | reject request with schema error |
| socket closes with pending requests | transport error | reject all pending promises |
| `sessions.subscribe` unsupported | degraded mode | set `subscriptions.supported=false`, preserve manual refresh path |

### 5. Good / Base / Bad Cases
- Good:
  - browser gets proxy bootstrap, connects through `/api/chat/ws`, waits for `hello-ok`, then loads `sessions.list`
  - proxy connect fails in a dev deployment with `allowDirectFallback=true`, frontend retries direct and succeeds
  - `session.message` arrives for the active session and silently refreshes history without full page reload
- Base:
  - old-style direct transport is still available only when backend explicitly returns it
  - subscription methods may be unavailable on older gateways, but send/history remain usable
- Bad:
  - treating websocket `open` as “connected” before handshake response
  - using `404` bootstrap response as implicit permission to direct-connect
  - replaying browser close code `1006` into `ws.close()`
  - assuming browser `message.data` is always a string

### 6. Tests Required
- Bootstrap
  - proxy-only response parses
  - proxy+fallback response parses
  - direct-only response parses
  - malformed bootstrap is rejected
- Proxy
  - `/api/chat/ws?ticket=` upgrade succeeds with valid ticket
  - invalid / reused ticket is rejected
  - browser `connect` frame gets auth injected server-side
  - upstream text frames arrive browser-side parseable as JSON
- Handshake
  - `connect.challenge` causes resend
  - client becomes connected only on `payload.type === "hello-ok"`
- Chat
  - `sessions.list` -> select session -> `chat.history`
  - `chat.send` rejects without `sessionKey` / `idempotencyKey`
  - `delta/final/aborted/error` each update UI state correctly
  - terminal event clears `pendingRuns` and schedules summary/history refresh
- Refresh / reconnect
  - reconnect fetches fresh bootstrap and ticket
  - manual refresh does not implicitly reconnect
  - reconnect rehydrates subscriptions
  - `sessions.changed` and `session.message` drive the expected refresh helpers

### 7. Wrong vs Correct

#### Wrong
```js
socket.addEventListener("open", () => {
  client.connected = true;
});
```

#### Correct
```js
socket.addEventListener("open", () => {
  client.sendConnectFrame();
});

if (!client.connected && message.ok && message.payload?.type === "hello-ok") {
  client.connected = true;
}
```

#### Wrong
```js
if (res.status === 404) {
  return { url: resolveWsUrl(""), source: "fallback" };
}
```

#### Correct
```js
const bootstrap = await fetchGatewayAuthConfig();
if (bootstrap.transport === "proxy") {
  await client.connect(bootstrap.proxy.connectUrl, {}, { transport: "proxy" });
}
```

#### Wrong
```js
upstreamSocket.on("message", (raw) => {
  browserSocket.send(raw); // browser may receive Blob/ArrayBuffer and fail JSON.parse
});
```

#### Correct
```js
upstreamSocket.on("message", (raw, isBinary) => {
  browserSocket.send(isBinary ? raw : Buffer.from(raw).toString("utf8"));
});
```
