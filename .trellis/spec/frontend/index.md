# Frontend Guidelines

> Arona WebUI frontend: vanilla JS SPA in `public/`

---

## Overview

**No framework, no build step.** All frontend code is vanilla ES modules served directly from `public/`.

---

## Start Here

Read these files before making frontend or fullstack changes:

| File | Purpose |
|---|---|
| `.trellis/spec/frontend/component-guidelines.md` | DOM/template/modal construction rules |
| `.trellis/spec/frontend/state-management.md` | Global `state`, timer lifecycle, auth helper rules |
| `.trellis/spec/frontend/design-system.md` | Design tokens, shared CSS component families, motion/a11y contract |
| `.trellis/spec/frontend/persona-editor-state.md` | Persona request-id guards, draft protection, file editor state machine |
| `.trellis/spec/frontend/quality-guidelines.md` | Security and review checklist |

---

## Key Files

| File | Role |
|---|---|
| `public/app.js` | Main SPA logic: `state` object, `viewLoaders` map, view switching, `api()` helper |
| `public/gateway-client.js` | Browser Chat gateway bootstrap + WebSocket transport client |
| `public/auth-check.js` | Injected at top of `index.html` — redirects to `/login.html` if no token in `localStorage` |
| `public/theme.js` | Dark/light toggle, persisted as `localStorage['openclaw-theme']`, applied via CSS custom properties on `:root` |
| `public/styles.css` | Global styles using CSS custom properties for theming |
| `public/index.html` | Main SPA shell with `<section>` elements for each view |
| `public/login.html` | Login page |

---

## Views

Rendered into `index.html` sections by `app.js`:

| Nav item | Section ID | API used |
|---|---|---|
| 仪表盘 (Overview) | `#view-overview` | `GET /api/overview` + `GET /api/system-load` |
| 模型管理 (Models) | `#view-models` | `GET /api/models`, `POST /api/models/save` |
| 技能状态 (Skills) | `#view-skills` | `GET /api/skills`, `POST /api/skills/update`, `POST /api/skills/install` |
| 任务计划 (Cron) | `#view-cron` | `GET /api/cron/list`, `GET /api/cron/runs`, `POST /api/cron/add\|update\|remove\|run` |
| 节点拓扑 (Nodes) | `#view-nodes` | `GET /api/nodes`, `GET /api/nodes/describe`, `POST /api/nodes/invoke` |
| 实时日志 (Logs) | `#view-logs` | `GET /api/logs` (polled) |
| Playground (Chat) | `#view-chat` | `GET /api/gateway-auth` + Gateway WS RPC (`sessions.list`, `sessions.patch`, `chat.history`, `chat.send`) |
| 人格与提示词 (Persona) | `#view-persona` | `GET /api/agents`, `POST /api/agents/*`, `GET /api/agents/files`, `GET/POST /api/agents/file` |

---

## Patterns

- **State**: simple `state` object (no library) — holds current view, loaded data
- **Routing**: `viewLoaders` map — key is view 名（如 `overview`、`chat`），对应 DOM section 为 `#view-${view}`
- **API calls**: `api()` helper attaches `Authorization: Bearer <token>`, redirects to `/login.html` on 401
- **Auth token**: opaque Bearer session token stored in `localStorage['openclaw_token']`
- **Theming**: CSS custom properties toggled by `theme.js`
- **Chat transport**: browser bootstraps from `/api/gateway-auth`, then `GatewayClient` talks to gateway WS directly

---

## Conventions

- No TypeScript, no JSX — plain `.js` ES modules
- No build step — files served as-is
- UI text is in Chinese
