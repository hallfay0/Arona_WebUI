# Auth and Env Contract

> Executable contract for browser login, in-memory session auth, env precedence, and gateway bootstrap.

---

## Scenario: WebUI Login, Session TTL, and Gateway Bootstrap

### 1. Scope / Trigger
- Trigger: changes to `/api/login`, `/api/health`, `/api/gateway-auth`, env wiring, session TTL, or reverse-proxy deployment.
- Why code-spec depth is required: these values are shared across backend runtime, browser auth flow, and Chat gateway bootstrap. A small drift here breaks the whole UI.

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
  ```json
  {
    "ok": true,
    "url": "<browser-visible websocket url>",
    "password": "<optional>",
    "token": "<optional>"
  }
  ```
- Runtime env keys:
  - Login/env precedence: `WEBUI_USERNAME`, `WEBUI_PASSWORD`, `GATEWAY_USERNAME`, `GATEWAY_PASSWORD`, `GATEWAY_TOKEN`
  - Gateway endpoint/origin: `GATEWAY_URL`, `GATEWAY_ORIGIN`, `GATEWAY_PUBLIC_WS_URL`
  - Session/pool lifecycle: `SESSION_TTL_MS`, `SESSION_CLEANUP_INTERVAL_MS`, `GATEWAY_POOL_IDLE_MS`, `GATEWAY_POOL_CLEANUP_INTERVAL_MS`
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
- When auth is disabled, backend routes pass through without session checks.
- When auth is enabled, every successful authenticated request extends `expiresAt` by `SESSION_TTL_MS`.

#### Session lifecycle
- `createToken()` stores `{ createdAt, lastActivityAt, expiresAt }` in `SESSIONS`.
- `getSessionRecord()` removes expired records eagerly.
- `cleanupExpiredSessions()` runs on an interval and prunes stale tokens.
- `POST /api/login` reuses the shared status mapping for malformed JSON / oversize bodies.

#### `/api/health` and `/api/gateway-auth`
- `/api/health.gateway.authMode` is currently **coarse-grained**: `enabled | none`.
  - It does **not** distinguish `password` vs `token`.
  - Fallback clients must treat any non-`none` value as “auth required but type unknown”.
  - Current browser fallback normalizes `enabled -> unknown` and, when it must prompt manually, treats the secret as a generic credential that defaults to the password slot unless `/api/gateway-auth` later provides an explicit token.
- `/api/gateway-auth` returns the browser-visible websocket URL plus `password` and/or `token` when available.
- `/api/gateway-auth` does **not** guarantee an `authMode` field. Browser clients must work from returned secrets first.

#### Browser-visible websocket URL resolution
- `GATEWAY_PUBLIC_WS_URL` wins if non-empty.
- Otherwise resolve from reverse-proxy headers:
  - protocol: `x-forwarded-proto` (`https` / `wss` => `wss`, else `ws`)
  - host: `x-forwarded-host` first, then `Host`
  - result: `<wsProto>://<host>/gateway/`
- If headers are unavailable, fall back to `gatewayConfig.url`.

### 4. Validation & Error Matrix

| Condition | HTTP | Response / Behavior |
|---|---:|---|
| Login credentials mismatch | 401 | `{ "ok": false, "error": "..." }` |
| Auth required but token missing/expired | 401 | `{ "ok": false, "error": "Unauthorized" }` |
| Invalid JSON body on `POST /api/login` | 400 | `{ "ok": false, "error": "invalid JSON body: ..." }` |
| Request body exceeds `2_000_000` bytes on `POST /api/login` | 413 | `{ "ok": false, "error": "payload too large" }` |
| Invalid JSON / oversize body on `handleApi()` routes | 400 / 413 | shared `handleApi()` error mapping |
| Reverse-proxy headers absent | 200 | `/api/gateway-auth` falls back to `gatewayConfig.url` |
| `GATEWAY_PUBLIC_WS_URL` configured | 200 | `/api/gateway-auth.url` must equal the override exactly |

### 5. Good / Base / Bad Cases
- Good:
  - deployment behind HTTPS reverse proxy sets `x-forwarded-proto=https` and `x-forwarded-host=example.com`, browser receives `wss://example.com/gateway/`
  - `WEBUI_*` is set separately from gateway auth, so UI login can differ from upstream gateway secret
- Base:
  - auth disabled (`GATEWAY_PASSWORD` and `GATEWAY_TOKEN` both empty) means API routes are public and `/api/login` still issues a session token if called
- Bad:
  - client assumes `openclaw_token` is JWT
  - client expects `/api/health.authMode` to tell password vs token
  - deployment forgets `GATEWAY_PUBLIC_WS_URL` while browser cannot reach internal `GATEWAY_URL`

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
  - all `/api/*` pass through when auth disabled
- Reverse proxy
  - `GATEWAY_PUBLIC_WS_URL` exact override
  - forwarded headers resolve to `ws://` or `wss://` correctly

### 7. Wrong vs Correct

#### Wrong
```js
const [, payload] = localStorage.getItem("openclaw_token").split(".");
const decoded = JSON.parse(atob(payload));
```

#### Correct
```js
const token = localStorage.getItem("openclaw_token");
await fetch("/api/gateway-auth", {
  headers: token ? { Authorization: `Bearer ${token}` } : {}
});
// Treat token as opaque session id only.
```

#### Wrong
```js
if (health.gateway.authMode === "token") {
  useTokenPrompt();
}
```

#### Correct
```js
if (authConfig.token) {
  auth.token = authConfig.token;
} else if (authConfig.password) {
  auth.password = authConfig.password;
} else if (health.gateway.authMode !== "none") {
  promptForSecret();
}
```
