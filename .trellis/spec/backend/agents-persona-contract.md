# Agents / Persona Contract

> Executable contract for `/api/agents*`, workspace resolution, default-agent protection, and persona file editing.

---

## Scenario: Agent Metadata, Workspace Merge, and Persona Files

### 1. Scope / Trigger
- Trigger: changes to `/api/agents`, `config.get`, default-agent rules, file whitelist, or Persona editor browser flow.
- Why code-spec depth is required: backend merges gateway payloads into a richer browser contract. If these rules drift, Persona UI points at the wrong workspace or edits the wrong files.

### 2. Signatures
- `GET /api/agents`
- `POST /api/agents/create`
  ```json
  { "name": "<string>", "workspace": "<string>", "emoji": "<optional>", "avatar": "<optional>" }
  ```
- `POST /api/agents/update`
  ```json
  { "agentId": "<string>", "name": "<optional>", "workspace": "<optional>", "model": "<optional>", "avatar": "<optional>" }
  ```
- `POST /api/agents/delete`
  ```json
  { "agentId": "<string>", "deleteFiles": true }
  ```
- `GET /api/agents/files?agentId=<id>`
- `GET /api/agents/file?agentId=<id>&name=<file>`
- `POST /api/agents/file`
  ```json
  { "agentId": "<string>", "name": "<whitelisted file>", "content": "<string>" }
  ```

### 3. Contracts

#### `GET /api/agents` merge behavior
- Backend calls both `agents.list` and `config.get`.
- Returned agent entries are currently treated as strings or objects; array/tuple entries are **not** a documented supported shape in the current browser contract.
- Each normalized agent entry may include:
  - `workspace`
  - `defaultWorkspace`
  - `effectiveWorkspace`
  - `workspaceSource`
  - `memorySearch`

#### Workspace precedence
- Effective workspace resolution is:
  1. workspace present in `agents.list` payload (`workspace | root | path | dir`)
  2. matching `config.get.parsed.agents.list[].workspace`
  3. `config.get.parsed.agents.defaults.workspace`
  4. `~/.openclaw/workspace`
- `workspaceSource` values used by the browser are:
  - `agents.list.workspace`
  - `agents.defaults.workspace`
  - `default`

#### Memory search merge
- `memorySearch` contract returned to browser:
  ```json
  {
    "backend": "builtin | <other backend>",
    "defaultExtraPaths": ["..."],
    "agentExtraPaths": ["..."],
    "effectiveExtraPaths": ["...deduped..."],
    "hasAgentOverride": true
  }
  ```
- `effectiveExtraPaths` is a de-duplicated concatenation of default + agent overrides.
- Current Persona UI surfaces this contract as a read-only memory-search note for the selected agent (backend + effective extra paths), while the enriched agent payload remains the backend truth source.

#### Create / update / delete rules
- Create requires non-empty `name` and `workspace`.
- Update requires non-empty `agentId` and at least one of `name | workspace | model | avatar`.
- Provided `name` / `workspace` / `model` values must be strings and remain non-empty after trimming.
- Default agent cannot have its workspace changed. Backend returns `409` with a protection error.
- Default agent cannot be deleted. Backend returns `409` with a protection error.
- `deleteFiles` is optional input. Only `true` is forwarded downstream as “also remove files”; `false` / absence omits the field.
- `model` is passed through to gateway `agents.update` as a plain `provider/model` string; the current Persona UI does not surface it yet, but the browser route contract supports it.

#### Persona file whitelist and missing-file behavior
- `/api/agents/files` may also return a `workspace` field alongside `files[]`.
- After file-list load, the browser may temporarily treat that `workspace` as the most concrete current workspace label/source for the selected agent (`agents.files.list.workspace`), ahead of the previously merged metadata value.
- Supported file names are:
  - `AGENTS.md`
  - `SOUL.md`
  - `TOOLS.md`
  - `IDENTITY.md`
  - `USER.md`
  - `HEARTBEAT.md`
  - `BOOTSTRAP.md`
  - `MEMORY.md`
  - `memory.md`
- Exact canonical casing is preserved when provided.
- Non-exact casing is normalized by case-insensitive lookup; callers should prefer canonical names to avoid ambiguity around `MEMORY.md` vs `memory.md`.
- Missing file/list errors that look like ENOENT / “no such file” / “missing file” are normalized to **HTTP 200 empty success**, not hard failures:
  - files list:
    ```json
    { "ok": true, "agentId": "<id>", "files": [] }
    ```
  - single file:
    ```json
    { "ok": true, "agentId": "<id>", "file": { "name": "<file>", "content": "", "missing": true } }
    ```
- `POST /api/agents/file` requires `content` to exist and be a string.

### 4. Validation & Error Matrix

| Condition | HTTP | Response / Behavior |
|---|---:|---|
| Create missing `name` or `workspace` | 400 | `{ "ok": false, "error": "name and workspace are required" }` |
| Update missing `agentId` | 400 | `{ "ok": false, "error": "agentId is required" }` |
| Update provides no mutable field | 400 | `{ "ok": false, "error": "at least one field to update is required" }` |
| `emoji`, `avatar`, `name`, `workspace`, `model` provided with wrong type | 400 | `{ "ok": false, "error": "... must be a string ..." }` |
| Update tries to change default-agent workspace | 409 | protection error |
| Delete targets default agent | 409 | protection error |
| File name not in whitelist | 400 | `{ "ok": false, "error": "unsupported agent file name" }` |
| File save missing string `content` | 400 | `{ "ok": false, "error": "content must be a string" }` |
| File/list lookup hits ENOENT-style error | 200 | normalized empty / missing success payload |

### 5. Good / Base / Bad Cases
- Good:
  - browser uses `effectiveWorkspace` for display and write-target hints
  - default agent is editable for metadata like name/avatar but workspace field stays protected
  - missing `IDENTITY.md` opens as a creatable empty draft, not a hard error
- Base:
  - `GET /api/agents` may return object or array agents from gateway; browser only depends on normalized shape
- Bad:
  - browser assumes `agents.list` workspace is the only source of truth
  - browser lets user delete default agent because it ignores `defaultId`
  - backend returns 404 for missing persona file and breaks editor bootstrap

### 6. Tests Required
- Merge / workspace
  - `effectiveWorkspace` precedence across gateway payload, config agent override, config default, fallback default
  - `workspaceSource` matches the branch that won
  - `memorySearch.effectiveExtraPaths` is deduped and ordered
- Protection rules
  - updating default-agent workspace returns 409
  - deleting default agent returns 409
- Update contract
  - `model`-only updates are accepted and forwarded to gateway `agents.update`
  - omitted `model` preserves legacy `name/workspace/avatar` update behavior
- File contract
  - whitelist allows only documented file names
  - missing file/list errors become HTTP 200 success payloads with `missing:true` / `files:[]`
  - `content` must be a string for save

### 7. Wrong vs Correct

#### Wrong
```js
const agent = data.agents.find((item) => item.agentId === selectedId);
const workspace = agent.workspace;
```

#### Correct
```js
const agent = data.agents.find((item) => item.agentId === selectedId);
const workspace = agent.effectiveWorkspace || agent.workspace || agent.defaultWorkspace;
```

#### Wrong
```js
await api(`/api/agents/file?agentId=${id}&name=README.md`);
```

#### Correct
```js
await api(`/api/agents/file?agentId=${id}&name=${encodeURIComponent("IDENTITY.md")}`);
// Use only whitelisted Persona/Prompt files.
```
