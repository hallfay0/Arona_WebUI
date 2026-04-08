# Gateway Protocol

> Browser Chat transport contract for the WebUI HTTP/SSE bridge, compatibility polling, and legacy WS fallback.

---

## Scenario: Chat HTTP/SSE Bridge, Sync-Mode Fallback, and Legacy WS Compatibility

### 1. Scope / Trigger
- Trigger: changes to `public/chat-transport.js`, `public/app.js`, `src/server.mjs`, `/api/chat/*`, `/api/gateway-auth`, or `/api/chat/ws`.
- Why code-spec depth is required: Chat now spans browser transport orchestration, HTTP JSON request mapping, SSE event relay, and legacy compatibility. Drift at any boundary causes either “send works but no live output” or “real-time works but summaries/history drift”.

### 2. Signatures

#### Browser transport modes
- `http-sse` — default
- `http-poll` — pure HTTP compatibility mode
- `legacy-ws` — old `/api/gateway-auth` + `/api/chat/ws` compatibility mode only

#### Browser -> WebUI HTTP request mapping

```js
sessions.list({ limit, includeLastMessage })
  -> GET /api/chat/sessions?limit=<n>&includeLastMessage=true|false

chat.history({ sessionKey, limit })
  -> GET /api/chat/history?sessionKey=<key>&limit=<n>

chat.send({ sessionKey, message, idempotencyKey })
  -> POST /api/chat/send

chat.abort({ sessionKey, runId? })
  -> POST /api/chat/abort

sessions.patch({ key, label, model? })
  -> POST /api/chat/session
```

#### SSE endpoint
- `GET /api/chat/events`
- Required request headers:
  - `Authorization: Bearer <openclaw_token>` when auth is enabled
  - `Accept: text/event-stream`
- Required response headers:
  - `Content-Type: text/event-stream; charset=utf-8`
  - `Cache-Control: no-cache, no-transform`
  - `Connection: keep-alive`
  - `X-Accel-Buffering: no`

#### `transport.status` SSE frame
```json
{
  "event": "transport.status",
  "payload": {
    "status": "connecting | connected | reconnecting | disconnected",
    "reason": "<optional>",
    "attempt": 1,
    "transport": "http-sse",
    "mode": "polling",
    "subscriptionSupported": false
  }
}
```

Notes:
- `mode` is optional
- when omitted for `http-sse`, frontend treats sync mode as `"events"`
- when `mode === "polling"`, frontend must keep the SSE transport alive but switch list/history sync to background polling

#### Event relay frames from `/api/chat/events`
```json
{ "event": "chat", "payload": { "...": "..." } }
{ "event": "sessions.changed", "payload": { "...": "..." } }
{ "event": "session.message", "payload": { "...": "..." } }
```

#### Legacy compatibility endpoints
- `GET /api/gateway-auth`
- `GET /api/chat/ws?ticket=<opaque>`

These are only used when browser transport mode is explicitly `legacy-ws`.

### 3. Contracts

#### Default browser transport contract
- Current default is `http-sse`.
- Browser must create the client with `createChatTransport({ mode, requestJson: api, ... })`.
- `http-sse` and `http-poll` both send requests through `/api/chat/*`.
- Only `legacy-ws` may call `/api/gateway-auth` and `/api/chat/ws`.

#### `HttpSseChatTransport` contract
- Opens exactly one long-lived SSE request to `/api/chat/events`.
- Must treat SSE connection readiness and request readiness as the same transport connection boundary.
- Must emit `transport.status` changes to the app layer through `onStatusChange(...)`.
- Must keep using HTTP `/api/chat/*` for:
  - `sessions.list`
  - `chat.history`
  - `chat.send`
  - `chat.abort`
  - `sessions.patch`
- `sessions.subscribe` / `sessions.messages.subscribe` / `sessions.messages.unsubscribe` are no-ops on the raw HTTP request path; frontend still calls them through the unified transport API so orchestration code stays mode-agnostic.

#### `ChatEventsBridge` server contract
- `/api/chat/events` is backed by `ChatEventsBridge` in `src/server.mjs`.
- It must:
  - acquire/reuse a pooled upstream gateway session
  - relay upstream events `chat`, `sessions.changed`, `session.message`
  - emit SSE heartbeat comments
  - reconnect with backoff when upstream drops
- On a healthy upstream session it tries:
  - `sessions.subscribe({})`
- If that method is unsupported:
  - do **not** fail the SSE bridge
  - set `subscriptionSupported = false`
  - keep `status = "connected"`
  - emit `mode: "polling"`

#### Sync-mode contract
- `transport.mode`
  - identifies the transport implementation (`http-sse` / `http-poll` / `legacy-ws`)
- `transport.syncMode`
  - identifies how summaries/history are currently synchronized (`events` / `polling`)
- Valid combinations:
  - `http-sse + events` → full real-time path
  - `http-sse + polling` → assistant stream still realtime via `chat`, but summaries/history need compensation polling
  - `http-poll + polling` → no realtime events, all sync via polling
  - `legacy-ws + events` → old compatibility path

#### Realtime vs compensation contract
- Current assistant output must rely on `chat` events whenever transport mode is:
  - `http-sse`
  - `legacy-ws`
- Session summaries and history may still need polling compensation when:
  - SSE bridge is connected but `mode === "polling"`
  - transport is `connecting` / `reconnecting` / `disconnected`
  - transport mode is `http-poll`
- Frontend compensation polling cadence:
  - `1500ms` while `sending === true` or `pendingRuns.size > 0`
  - `5000ms` while idle

#### Pending-run refresh contract
- During a pending assistant run:
  - if live events are still available (`http-sse` or `legacy-ws` and client connected), `refreshCurrentSessionHistory()` must skip history reload and set `needsRefresh = true`
  - if transport is `http-poll`, history reload must continue
- Reason: background history pulls must not interrupt the realtime pending bubble.

#### Frontend refresh separation
- `refreshChatNow({ background: false })`
  - user-visible refresh only
  - sets refresh button busy state
- `refreshChatNow({ background: true })`
  - silent background sync only
  - must not spin the refresh button
- “立即重连”
  - rebuilds transport through `ensureChatClientConnected({ forceReconnect: true })`
- “刷新”
  - reloads data only
  - if transport is currently unavailable and `allowReconnect === false`, it must fail fast

#### Legacy WS contract
- `legacy-ws` remains supported for compatibility only.
- It is the only mode that may call:
  - `fetchGatewayAuthConfig()`
  - `/api/gateway-auth`
  - `/api/chat/ws?ticket=...`
- Modern `http-sse` / `http-poll` flow must not depend on bootstrap proxy/direct metadata.

### 4. Validation & Error Matrix

| Condition | Boundary | Expected behavior |
|---|---|---|
| `GET /api/chat/events` without auth while auth enabled | HTTP | 401 unauthorized |
| `GET /api/chat/sessions` / `history` without auth while auth enabled | HTTP | 401 unauthorized |
| `chat.history` missing `sessionKey` | HTTP | 400 with `{ ok:false, error:"sessionKey is required" }` |
| `/api/chat/events` upstream SSE unavailable / stream closes unexpectedly | transport | frontend enters `disconnected` / `reconnecting` |
| upstream `sessions.subscribe` unsupported | bridge | keep SSE `connected`, emit `mode:"polling"` and `subscriptionSupported:false` |
| HTTP transport receives `sessions.subscribe` request | browser transport | no-op success |
| manual refresh while transport disconnected and `allowReconnect=false` | frontend orchestration | fail fast, surface reconnect action |
| pending run + live events available | frontend refresh | skip `chat.history` pull |
| pending run + `http-poll` | frontend refresh | continue `chat.history` pull |
| SSE bridge reconnecting | browser status | compensation polling may run until real-time bridge recovers |

### 5. Good / Base / Bad Cases
- Good:
  - `http-sse` connected, `syncMode=events`: assistant bubbles stream from `chat` and summaries update from `sessions.changed` / `session.message`
  - `http-sse` connected, `syncMode=polling`: assistant bubbles still stream live, list/history quietly catch up in background
  - `http-poll` connected: user can still send, abort, switch sessions, and refresh without SSE
- Base:
  - `legacy-ws` still works when explicitly chosen
  - unsupported session subscriptions do not break basic Chat usage
- Bad:
  - treating `mode:"polling"` as “transport disconnected”
  - downgrading the whole Chat page to pure polling when current assistant output can still stream through `chat`
  - forcing `/api/gateway-auth` into the default modern Chat path
  - letting background history refresh overwrite or interrupt a pending streaming bubble

### 6. Tests Required
- SSE bridge
  - `GET /api/chat/events` returns SSE headers
  - initial `transport.status` frame arrives
  - heartbeat comments keep streaming
  - upstream reconnect emits `reconnecting` then `connected`
- Unsupported subscription fallback
  - bridge catches `sessions.subscribe` unsupported error
  - emitted status stays effectively connected but carries `mode:"polling"`
  - frontend starts compensation polling without losing `chat` realtime output
- Request mapping
  - `sessions.list` -> `/api/chat/sessions`
  - `chat.history` -> `/api/chat/history`
  - `chat.send` -> `/api/chat/send`
  - `chat.abort` -> `/api/chat/abort`
  - `sessions.patch` -> `/api/chat/session`
- Pending-run behavior
  - `http-sse` pending run skips history pull
  - `http-poll` pending run keeps history pull
- Legacy compatibility
  - `legacy-ws` still bootstraps through `/api/gateway-auth`
  - `/api/chat/ws?ticket=` still upgrades with valid ticket

### 7. Wrong vs Correct

#### Wrong
```js
if (info.status === "degraded") {
  setChatStatus("Chat 未连接");
}
```

#### Correct
```js
state.chat.transport.syncMode = resolveChatTransportSyncMode(info.syncMode || info.mode);
state.chat.transport.degraded =
  info.status !== "connected" ||
  (state.chat.transport.mode === "http-sse" && state.chat.transport.syncMode === "polling");
```

#### Wrong
```js
// SSE 不支持 sessions.subscribe，于是直接改成纯 polling 主模式
const client = new HttpPollingChatTransport(...);
```

#### Correct
```js
// 保留 http-sse 实时 chat 事件，只把列表/历史改为补偿轮询
if (transportMode === "http-sse" && syncMode === "polling") {
  scheduleChatCompensationPoll("chat-sync");
}
```

#### Wrong
```js
await refreshCurrentSessionHistory({ silent: true });
```

#### Correct
```js
const canRelyOnLiveEvents =
  (transportMode === "http-sse" || transportMode === "legacy-ws")
  && state.chat.client?.isConnected?.();

if ((state.chat.sending || state.chat.pendingRuns.size > 0) && canRelyOnLiveEvents) {
  state.chat.needsRefresh = true;
  return { skipped: true, reason: "pending-run" };
}
```
