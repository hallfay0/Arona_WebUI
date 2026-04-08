# Backend Guidelines

> Arona WebUI backend: minimal Node.js HTTP + gateway bridge in `src/server.mjs`

---

## Overview

Backend work in this project is intentionally small and direct:

- **No framework** — raw `node:http`
- **No database layer** — state is gateway-backed or in-memory session state
- **No build step** — runtime code is plain `.mjs`
- **Gateway-first integration** — backend primarily adapts browser requests to gateway RPC / WS behavior

---

## Start Here

Read these files before making backend or fullstack changes:

| File | Purpose |
|---|---|
| `.trellis/spec/backend/architecture.md` | Server structure, pooled gateway bridge, route inventory |
| `.trellis/spec/backend/auth-and-env-contract.md` | Env precedence, login/session, `/api/health`, modern `/api/chat/*`, and legacy `/api/gateway-auth` |
| `.trellis/spec/backend/gateway-protocol.md` | Chat HTTP/SSE bridge, sync-mode fallback, and legacy WS compatibility contract |
| `.trellis/spec/backend/http-api-contracts.md` | Browser-facing JSON envelope and models/skills/cron/nodes/logs contracts |
| `.trellis/spec/backend/agents-persona-contract.md` | Agents / Persona merge rules, workspace resolution, file editing contract |

---

## Current Backend Surface

- Entry point: `src/server.mjs`
- Browser-facing auth bridge: `/api/login`, `/api/chat/*`, legacy `/api/gateway-auth`
- Health / runtime helpers: `/api/health`, `/api/system-load`
- Gateway-backed routes: overview, models, skills, agents/persona, cron, nodes, logs
- Extension-center routes: `/api/store/skills/*`, `/api/store/plugins/*`, `/api/store/mcp/*`, `/api/store/sources`
- Browser Chat transport: default `public/chat-transport.js` uses `/api/chat/events` + `/api/chat/*`; `legacy-ws` keeps `/api/gateway-auth` + `/api/chat/ws`
- Static file serving: `public/`

---

## Working Rules

- Preserve existing route shapes unless the task explicitly changes contracts
- Reuse existing gateway session and auth patterns before adding new abstractions
- Keep backend changes small, explicit, and easy to trace from route to gateway method
- Treat env vars and auth behavior as contracts that must be documented when changed
