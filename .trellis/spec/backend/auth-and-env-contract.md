# Auth and Env Contract

> Executable contract for browser login, in-memory session auth, Chat transport bootstrap, and proxy ticket lifecycle.

---

## Scenario: WebUI Login, Session TTL, and Chat Gateway Bootstrap

### 1. Scope / Trigger
- Trigger: changes to `/api/login`, `/api/health`, `/api/gateway-auth`, `/api/chat/ws`, env wiring, session TTL, or reverse-proxy deployment.
- Why code-spec depth is required: these values are shared across backend runtime, browser auth flow, Chat proxy upgrade, and direct/proxy transport fallback. A small drift here breaks the whole Chat UI.

### 2. Signatures
- `POST /api/login`
  ```json
  { "username": "<string>", "password": "<string>" }
  ```
- `GET /api/health`
  ```json
  {
    "ok": true,
    "gateway": {
      "url": "<gatewayConfig.url>",
      "origin": "<gatewayConfig.origin>",
      "authMode": "enabled | none"
    }
  }
  ```
- `GET /api/gateway-auth`
  - Proxy-first response:
    ```json
    {
      "ok": true,
      "transport": "proxy",
      "allowDirectFallback": false,
      "proxy": {
        "url": "/api/chat/ws",
        "ticket": "<opaque uuid>",
        "expiresAt": 1760000000000
      },
      "direct": null,
      "meta": {
        "version": 1,
        "source": "endpoint"
      }
    }
    ```
  - Direct response:
    ```json
    {
      "ok": true,
      "transport": "direct",
      "allowDirectFallback": false,
      "proxy": null,
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
- `GET /api/chat/ws?ticket=<opaque>`
  - HTTP upgrade to WebSocket
  - `ticket` is mandatory in proxy mode
- Runtime env keys:
  - Login/env precedence: `WEBUI_USERNAME`, `WEBUI_PASSWORD`, `GATEWAY_USERNAME`, `GATEWAY_PASSWORD`, `GATEWAY_TOKEN`
  - Gateway endpoint/origin: `GATEWAY_URL`, `GATEWAY_ORIGIN`, `GATEWAY_PUBLIC_WS_URL`
  - Session/pool lifecycle: `SESSION_TTL_MS`, `SESSION_CLEANUP_INTERVAL_MS`, `GATEWAY_POOL_IDLE_MS`, `GATEWAY_POOL_CLEANUP_INTERVAL_MS`
  - Chat transport: `CHAT_TRANSPORT_MODE`, `CHAT_ALLOW_DIRECT_FALLBACK`, `CHAT_PROXY_TICKET_TTL_MS`, `CHAT_PROXY_TICKET_CLEANUP_INTERVAL_MS`
  - Server port: `PORT`

### 3. Contracts

#### Env loading and precedence
- `.env.local` is loaded early, but **only** fills keys that are missing from `process.env`.
- Gateway defaults are loaded from `/root/.openclaw/openclaw.json` when available.
- Effective runtime precedence is:
  1. real `process.env`
  2. `.env.local` fallback
  3. `/root/.openclaw/openclaw.json`
  4. hardcoded defaults in `src/server.mjs`

#### Login credential resolution
- Effective username:
  1. `WEBUI_USERNAME`
  2. `GATEWAY_USERNAME`
  3. `"admin"`
- Effective password:
  1. `WEBUI_PASSWORD`
  2. `gatewayConfig.password`
  3. `gatewayConfig.token`
  4. `""`
- The issued `openclaw_token` is an **opaque UUID session id** stored in the server `SESSIONS` map. Do not decode it as JWT.

#### Auth gating matrix
- `/api/login`: always public.
- `/api/health`: always public.
- All other `/api/*` routes require `Authorization: Bearer <token>` **only when** `gatewayConfig.password || gatewayConfig.token` is truthy.
- `/api/chat/ws` is not covered by the generic `/api/*` middleware path. It authenticates through the proxy ticket:
  - ticket contains the bearer session token that requested `/api/gateway-auth`
  - upgrade re-checks that token with `getSessionRecord()`
  - successful upgrade refreshes session TTL through `touchSessionRecord()`
- When auth is disabled, backend routes pass through without session checks and proxy tickets are accepted without session lookup.
- When auth is enabled, every successful authenticated request extends `expiresAt` by `SESSION_TTL_MS`.

#### Session lifecycle
- `createToken()` stores `{ createdAt, lastActivityAt, expiresAt }` in `SESSIONS`.
- `getSessionRecord()` removes expired records eagerly.
- `cleanupExpiredSessions()` runs on an interval and prunes stale tokens.
- `POST /api/login` reuses the shared status mapping for malformed JSON / oversize bodies.

#### `/api/health` and `/api/gateway-auth`
- `/api/health.gateway.authMode` remains **coarse-grained**: `enabled | none`.
  - It does **not** distinguish `password` vs `token`.
  - Browser Chat must use `/api/gateway-auth.direct.authMode` instead of guessing from `/api/health`.
- `/api/gateway-auth` is the **only supported Chat bootstrap source** for current WebUI.
  - Frontend must require `transport`
  - Frontend must reject missing / malformed `proxy` or `direct` blocks
  - Frontend must not treat `404`, bad JSON, or any other failure as permission to direct-connect
- `meta.version` is currently fixed to `1`.

#### Transport bootstrap contract
- `CHAT_TRANSPORT_MODE=proxy` (default):
  - `/api/gateway-auth.transport === "proxy"`
  - `proxy.url === "/api/chat/ws"`
  - `proxy.ticket` is a one-time opaque UUID
  - `direct` is only present when `CHAT_ALLOW_DIRECT_FALLBACK=true`
- `CHAT_TRANSPORT_MODE=direct`:
  - `/api/gateway-auth.transport === "direct"`
  - `proxy === null`
  - `direct.url` comes from `GATEWAY_PUBLIC_WS_URL` or reverse-proxy resolution
- `CHAT_ALLOW_DIRECT_FALLBACK` only affects the bootstrap payload. It does **not** auto-switch the backend. Frontend chooses whether to attempt fallback after proxy connect failure.

#### Proxy ticket contract
- Ticket store is in-memory `CHAT_PROXY_TICKETS`.
- Each record contains:
  - `ticket`
  - `issuedAt`
  - `expiresAt`
  - `sessionToken`
  - `allowDirectFallback`
- TTL defaults:
  - `CHAT_PROXY_TICKET_TTL_MS=60000`
  - `CHAT_PROXY_TICKET_CLEANUP_INTERVAL_MS=30000`
- Tickets are **single-consume**:
  - `consumeChatProxyTicketRecord()` deletes the record before validating TTL
  - expired, missing, or reused tickets all fail upgrade
- Browser must request a fresh bootstrap before every manual reconnect because old tickets are not reusable.

#### Browser-visible websocket URL resolution
- `GATEWAY_PUBLIC_WS_URL` wins if non-empty.
- Otherwise resolve from reverse-proxy headers:
  - protocol: `x-forwarded-proto` (`https` / `wss` => `wss`, else `ws`)
  - host: `x-forwarded-host` first, then `Host`
  - direct result: `<wsProto>://<host>/gateway/`
- Chat proxy URL is always browser-relative `/api/chat/ws`; frontend appends `?ticket=<ticket>` locally.

### 4. Validation & Error Matrix

| Condition | HTTP / Upgrade | Response / Behavior |
|---|---:|---|
| Login credentials mismatch | 401 | `{ "ok": false, "error": "..." }` |
| Auth required but bearer token missing/expired on `/api/*` | 401 | `{ "ok": false, "error": "Unauthorized" }` |
| Invalid JSON body on `POST /api/login` | 400 | `{ "ok": false, "error": "invalid JSON body: ..." }` |
| Request body exceeds `2_000_000` bytes on `POST /api/login` | 413 | `{ "ok": false, "error": "payload too large" }` |
| Invalid JSON / oversize body on `handleApi()` routes | 400 / 413 | shared `handleApi()` error mapping |
| `/api/gateway-auth` hit while auth enabled without bearer | 401 | same unauthorized envelope |
| `CHAT_TRANSPORT_MODE=direct` | 200 | `/api/gateway-auth.transport === "direct"` and `proxy === null` |
| `CHAT_TRANSPORT_MODE=proxy` | 200 | `/api/gateway-auth.transport === "proxy"` and fresh `proxy.ticket` returned |
| `GATEWAY_PUBLIC_WS_URL` configured | 200 | `/api/gateway-auth.direct.url` must equal the override exactly |
| `/api/chat/ws` without `ticket` | 401 upgrade reject | `{ "ok": false, "error": "invalid or expired chat proxy ticket" }` |
| expired / reused ticket | 401 upgrade reject | same invalid ticket response |
| auth enabled and ticket session expired | 401 upgrade reject | `{ "ok": false, "error": "chat proxy ticket session expired" }` |
| `CHAT_TRANSPORT_MODE !== proxy` but browser hits `/api/chat/ws` | 409 upgrade reject | `{ "ok": false, "error": "chat proxy transport is disabled" }` |
| unknown upgrade path | 404 upgrade reject | `{ "ok": false, "error": "upgrade endpoint not found" }` |

### 5. Good / Base / Bad Cases
- Good:
  - deployment behind HTTPS reverse proxy only exposes WebUI; browser gets `/api/chat/ws` ticket and never needs direct Gateway reachability
  - WebUI auth is enabled; `/api/gateway-auth` and `/api/chat/ws` both remain session-bound through the bearer token + ticket pairing
  - developer enables `CHAT_ALLOW_DIRECT_FALLBACK=true`, frontend still starts with proxy and only falls back explicitly after proxy failure
- Base:
  - auth disabled (`GATEWAY_PASSWORD` and `GATEWAY_TOKEN` both empty) means API routes are public and proxy tickets do not carry meaningful session binding
  - `CHAT_TRANSPORT_MODE=direct` is allowed for local/dev deployments
- Bad:
  - client assumes `openclaw_token` is JWT
  - client expects `/api/health.authMode` to tell password vs token
  - client reuses an old proxy ticket after reconnect
  - backend silently treats `/api/gateway-auth` failure as permission to direct-connect

### 6. Tests Required
- Login precedence
  - `WEBUI_USERNAME/PASSWORD` override `GATEWAY_*`
  - fallback to `GATEWAY_USERNAME` and `GATEWAY_PASSWORD` still works when `WEBUI_*` absent
- Session contract
  - returned token is opaque and accepted as Bearer token
  - authenticated request extends TTL
  - expired session becomes 401 and is removed from `SESSIONS`
- Auth gating
  - `/api/health` remains public when auth enabled
  - `/api/gateway-auth` requires Bearer when auth enabled
  - `/api/chat/ws` rejects upgrade when the session bound to the ticket has expired
- Transport bootstrap
  - proxy-only response
  - proxy + direct-fallback response
  - direct-only response
  - `meta.version === 1`
- Proxy ticket
  - ticket TTL enforced
  - ticket single consumption enforced
  - ticket session binding enforced
- Reverse proxy
  - `GATEWAY_PUBLIC_WS_URL` exact override
  - forwarded headers resolve to `ws://` or `wss://` correctly

### 7. Wrong vs Correct

#### Wrong
```js
if (res.status === 404) {
  return { url: resolveWsUrl(""), source: "fallback" };
}
```

#### Correct
```js
const bootstrap = await fetch("/api/gateway-auth", {
  headers: { Authorization: `Bearer ${token}` }
}).then((res) => res.json());

if (bootstrap.transport === "proxy") {
  connect(`/api/chat/ws?ticket=${bootstrap.proxy.ticket}`);
}
```

#### Wrong
```js
const ticket = cachedTicketFromPreviousConnect;
ws = new WebSocket(`/api/chat/ws?ticket=${ticket}`);
```

#### Correct
```js
const bootstrap = await fetchGatewayAuthConfig();
ws = new WebSocket(bootstrap.proxy.connectUrl);
```
