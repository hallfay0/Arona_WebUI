# HTTP API Contracts

> Browser-facing JSON route contract for models, skills, cron, nodes, logs, and shared envelope behavior.

---

## Scenario: Shared JSON Envelope and Route-Group Contracts

### 1. Scope / Trigger
- Trigger: changes to `parseBody()`, HTTP status mapping, or any browser-facing `/api/*` route under models / skills / cron / nodes / logs.
- Why code-spec depth is required: the frontend `api()` helper depends on route-specific success shapes plus a shared failure convention. Contract drift here breaks many views at once.

### 2. Signatures

#### Shared parsing / failure contract
- JSON request bodies only.
- Empty request body resolves to `{}`.
- Failure envelope:
  ```json
  { "ok": false, "error": "<message>" }
  ```

#### Models
- `GET /api/models`
- `POST /api/models/save`
  ```json
  {
    "models": { "providers": { "<providerKey>": { "...": "..." } } },
    "baseHash": "<config hash>"
  }
  ```

#### Skills
- `GET /api/skills`
- `POST /api/skills/install`
  ```json
  { "name": "<skill name>", "installId": "<installer id>", "timeoutMs": 120000 }
  ```
- `POST /api/skills/update`
  ```json
  { "skillKey": "<key>", "enabled": true, "apiKey": "<optional>", "env": { "KEY": "VALUE" } }
  ```

#### Cron
- `GET /api/cron/list?includeDisabled=true|false`
- `GET /api/cron/runs?jobId=<id>`
- `POST /api/cron/add`
  ```json
  {
    "job": {
      "name": "<string>",
      "schedule": { "kind": "cron | at | every" },
      "payload": { "kind": "agentTurn", "message": "<string>" },
      "sessionTarget": "main | isolated",
      "enabled": true
    }
  }
  ```
- `POST /api/cron/update`
  ```json
  { "jobId": "<id>", "patch": { "...": "..." } }
  ```
- `POST /api/cron/remove`
  ```json
  { "jobId": "<id>" }
  ```
- `POST /api/cron/run`
  ```json
  { "jobId": "<id>" }
  ```

#### Nodes
- `GET /api/nodes`
- `GET /api/nodes/describe?nodeId=<id>`
- `POST /api/nodes/invoke`
  ```json
  {
    "nodeId": "<node id>",
    "command": "<command>",
    "params": { "...": "..." },
    "timeoutMs": 15000
  }
  ```

#### Logs
- `GET /api/logs?cursor=<number>&limit=<number>`

### 3. Contracts

#### Shared envelope rules
- Backend error responses use `{ ok: false, error }` plus an HTTP status.
- Success responses are **not fully uniform**:
  - some routes return raw gateway payload directly (`/api/models`, `/api/skills`, `/api/cron/list`, `/api/nodes`, `/api/nodes/describe`, `/api/nodes/invoke`, `/api/logs`)
  - some routes return `{ ok: true, data }` or `{ ok: true, result }` (`/api/models/save`, `/api/skills/install`, `/api/skills/update`, `/api/cron/add|update|remove|run`)
- Frontend callers must treat “HTTP success and not `ok:false`” as success. Do **not** require `ok:true` for every route.

#### Models contract
- `/api/models` returns:
  ```json
  {
    "modelList": "<gateway payload>",
    "configHash": "<hash>",
    "modelsConfig": { "providers": { "...": {} } }
  }
  ```
- `/api/models/save` forwards to `config.patch({ raw, baseHash, note })` with note `"MVP dashboard updated model/provider config"`.
- Browser editor depends on provider config round-tripping extra fields. Managed keys are `baseUrl|baseURL|url|apiKey|api|apiType|type|models`; everything else must survive save.
- Browser provider save normalizes legacy adapter fields `apiType` / `type` into gateway-schema `api` before calling `/api/models/save`.
- Browser provider delete / rename emits `models.providers.<key> = null` tombstones so `config.patch` actually removes old provider keys instead of merging them back.
- Browser provider model rows always serialize as object entries; when `name` is omitted in the form, save falls back to `name = id` to satisfy gateway schema.
- `__OPENCLAW_REDACTED__` is a browser-only placeholder; save callers must remove it before sending.

#### Skills contract
- `/api/skills` returns `skills[]`; browser currently reads `name`, `description`, `source`, `skillKey`, `disabled`, `eligible`, `blockedByAllowlist`, `missing`, `primaryEnv`, `install`, `emoji`.
- `/api/skills/install` requires `name` and `installId`; backend defaults `timeoutMs` to `120000`.
- `/api/skills/update` forwards whatever optional fields are provided; HTTP layer does not add extra validation beyond JSON parsing.

#### Cron contract
- `/api/cron/list` forwards `includeDisabled` to gateway and injects `schedule.human` for `schedule.kind === "cron"` when expression parsing succeeds.
- `/api/cron/runs` requires `jobId` at HTTP layer.
- Browser form builder currently emits:
  - `cron`: `{ kind: "cron", expr: "m h * * *", tz: "Asia/Shanghai" }`
  - `at`: `{ kind: "at", at: "<ISO>" }`
  - `every`: `{ kind: "every", everyMs: <positive int> }`

#### Nodes contract
- `/api/nodes` returns raw gateway payload; browser reads `nodeId`, `displayName`, `platform`, `remoteIp`, `caps`, `commands`, `connected`.
- `/api/nodes/describe` requires `nodeId` at HTTP layer.
- `/api/nodes/invoke` forwards `nodeId`, `command`, `params`, `timeoutMs`, and injects a fresh `idempotencyKey` server-side.
- HTTP layer does **not** currently validate `nodeId` / `command`; the browser validates before calling and gateway may still reject.

#### Logs contract
- `/api/logs` proxies `logs.tail` using optional numeric `cursor` and `limit`.
- Browser polling assumes response shape contains `lines` and `cursor`.
- Browser clears `state.logsCursor` when user clicks “清空” or changes keyword filter, then restarts fetch from the new tail position.

### 4. Validation & Error Matrix

| Condition | HTTP | Response / Behavior |
|---|---:|---|
| Invalid JSON body | 400 | `{ "ok": false, "error": "invalid JSON body: ..." }` |
| Payload too large | 413 | `{ "ok": false, "error": "payload too large" }` |
| `/api/skills/install` missing `name` or `installId` | 400 | `{ "ok": false, "error": "name and installId are required" }` |
| `/api/cron/runs` missing `jobId` | 400 | `{ "ok": false, "error": "jobId required" }` |
| `/api/nodes/describe` missing `nodeId` | 400 | `{ "ok": false, "error": "nodeId required" }` |
| Unknown route | 404 | `{ "ok": false, "error": "API endpoint not found" }` |
| Gateway/runtime failure after validation | 500 unless route sets a status code | `{ "ok": false, "error": "..." }` |

### 5. Good / Base / Bad Cases
- Good:
  - frontend reads `/api/models` directly from `modelList/configHash/modelsConfig`
  - logs filter resets cursor before polling so UI does not mix old and new slices
  - node invoke caller treats `idempotencyKey` as server-managed and does not send its own
- Base:
  - `/api/skills/update` with only `{ skillKey, enabled }` is valid
  - `/api/cron/list?includeDisabled=true` returns jobs with optional injected `schedule.human`
- Bad:
  - caller assumes every success payload has `ok:true`
  - caller expects backend to validate every gateway param for nodes / cron / skills updates
  - provider editor drops extra JSON keys that are not in the form

### 6. Tests Required
- Shared envelope
  - invalid JSON => 400
  - oversize body => 413
  - 404 route => `{ ok:false, error }`
- Models
  - `/api/models` returns `configHash` and `modelsConfig`
  - `/api/models/save` forwards `baseHash`
  - provider extra fields survive round-trip save
  - legacy provider `apiType` / `type` backfills and saves as `api`
  - deleting or renaming a provider removes the old provider key after reload
  - newly added provider models save as `{ id, name, ... }` objects instead of invalid string entries
- Skills
  - `/api/skills/install` default `timeoutMs=120000`
  - `/api/skills/update` accepts enable-only and env/apiKey payloads
- Cron
  - `/api/cron/list` injects `schedule.human` only for valid cron expressions
  - `/api/cron/runs` rejects missing `jobId`
- Nodes / Logs
  - `/api/nodes/describe` rejects missing `nodeId`
  - `/api/nodes/invoke` injects fresh `idempotencyKey`
  - `/api/logs` preserves cursor chaining across repeated calls

### 7. Wrong vs Correct

#### Wrong
```js
const data = await api("/api/nodes");
if (data.ok !== true) throw new Error("unexpected response");
render(data.data.nodes);
```

#### Correct
```js
const data = await api("/api/nodes");
const nodes = Array.isArray(data.nodes) ? data.nodes : [];
render(nodes);
```

#### Wrong
```js
await api("/api/skills/install", {
  method: "POST",
  body: JSON.stringify({ name: skill.name })
});
```

#### Correct
```js
await api("/api/skills/install", {
  method: "POST",
  body: JSON.stringify({ name: skill.name, installId: skill.install[0].id })
});
```
