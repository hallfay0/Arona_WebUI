# Gateway Protocol

> WebSocket wire protocol between Arona WebUI and OpenClaw gateway.

---

## Scenario: Browser Chat Gateway Bootstrap and WS RPC

### 1. Scope / Trigger
- Trigger: changes to gateway wire format, `public/gateway-client.js`, `/api/gateway-auth`, or browser Chat RPC methods.
- Why code-spec depth is required: Chat now bypasses the old HTTP/SSE bridge and talks to gateway WS directly. Handshake or method drift breaks the entire Chat view.

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
- `GET /api/gateway-auth` -> browser-visible websocket URL plus optional `password` / `token`
- Fallback path when endpoint is missing: browser derives URL locally and uses `/api/health` only to decide whether auth is required

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
- `sessions.list({ limit, includeLastMessage })`
- `sessions.patch({ key, label })`
- `chat.history({ sessionKey, limit })`
- `chat.send({ sessionKey, message, idempotencyKey })`

#### Gateway-supported but not yet wired in current Chat UI
- `chat.abort({ sessionKey, runId? })`

### 3. Contracts

#### Handshake success criteria
- Browser must wait for a `res` frame where:
  - `ok === true`
  - `payload.type === "hello-ok"`
- Raw socket `open` is **not** sufficient to mark the client connected.
- If gateway emits `event: "connect.challenge"`, browser must resend the `connect` request.

#### Request / response rules
- Each browser request uses a fresh UUID `id`.
- Pending requests time out after `requestTimeoutMs` (currently 15s).
- When the websocket closes, all pending requests must reject.

#### Chat RPC contract
- Session inventory uses `sessions.list`, not `sessions.create` / `sessions.new`.
- Browser creates a new session by calling `sessions.patch({ key, label })` with a temporary key.
- `chat.send` minimum working payload is:
  ```json
  {
    "sessionKey": "<required>",
    "message": "<required>",
    "idempotencyKey": "<required>"
  }
  ```
- Successful `chat.send` returns a payload containing at least:
  ```json
  { "runId": "<uuid>", "status": "started" }
  ```
- Browser maps `runId -> pending assistant message id` until terminal event arrives.

#### Event contract
- Browser reacts to `event: "chat"` frames.
- Supported runtime states in current UI contract:
  - `delta`
  - `final`
  - `aborted`
  - `error`
- Structured rendering recognizes segment types:
  - `text`
  - `thinking`
  - `toolCall`
  - `toolResult`
- Browser may derive segments from `payload.message`, `payload.thinking`, `payload.reasoning`, or `payload.reasoningDelta`.

#### Methods explicitly not used by WebUI Chat
- Do **not** use these as Chat browser integration substitutes:
  - `agent.turn`
  - `sessions.send`
  - `sessions.messages`
  - `sessions.history`

### 4. Validation & Error Matrix

| Condition | Transport result | Expected behavior |
|---|---|---|
| `/api/gateway-auth` missing on older backend | HTTP 404 / not found | Browser falls back to derived WS URL + `/api/health` auth check |
| Raw socket opens but `hello-ok` not received | connect timeout / failure | Keep status as not connected |
| `connect.challenge` event received | event frame | Resend `connect` request |
| `chat.send` missing `sessionKey` or `idempotencyKey` | gateway error frame | Reject request with schema error |
| Unknown method (e.g. `agent.turn`) | gateway error frame | Reject request; do not silently substitute |
| Socket closes with pending requests | transport error | Reject all pending promises and start reconnect policy |

### 5. Good / Base / Bad Cases
- Good:
  - browser gets `/api/gateway-auth`, connects, waits for `hello-ok`, then loads `sessions.list`
  - `chat.send` creates a pending assistant bubble and resolves it through `delta/final`
  - reconnect preserves WS config and refreshes session list after reconnect
- Base:
  - old backend without `/api/gateway-auth` still works through fallback URL derivation and manual secret prompt
- Bad:
  - treating websocket `open` as “connected” before handshake response
  - using `agent.turn` because it “sounds right”
  - omitting `idempotencyKey` from `chat.send`

### 6. Tests Required
- Bootstrap
  - `/api/gateway-auth` success path
  - missing-endpoint fallback path
  - reverse-proxy URL from backend auth bootstrap
- Handshake
  - `connect.challenge` causes reconnect frame resend
  - client becomes connected only on `payload.type === "hello-ok"`
- Chat
  - `sessions.list` -> select session -> `chat.history`
  - `chat.send` rejects without `sessionKey` / `idempotencyKey`
  - `delta/final/aborted/error` each update UI state correctly
  - terminal event clears `pendingRuns` and refreshes session/history
- Reconnect
  - pending requests reject on close
  - reconnect path rehydrates sessions when view is active

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
await client.request("agent.turn", { sessionKey, message });
```

#### Correct
```js
await client.request("chat.send", {
  sessionKey,
  message,
  idempotencyKey: crypto.randomUUID()
});
```
