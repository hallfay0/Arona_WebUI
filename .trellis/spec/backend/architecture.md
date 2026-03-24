# Backend Architecture

> Arona WebUI backend: minimal Node.js HTTP server (`src/server.mjs`)

---

## Overview

A single-file server using raw `node:http` — **no framework**. Serves both the API and static files.

- **Entry point**: `src/server.mjs`
- **Port**: `18790` (env `PORT`)
- **Static files**: `public/` directory with path traversal protection
- **No database layer**: persistent state lives in gateway config / files, plus in-memory browser session tokens
- **Gateway-first**: most routes adapt HTTP requests to gateway RPC and reuse a pooled WebSocket session

---

## GatewaySession & Pool

The `GatewaySession` class manages the gateway wire protocol. HTTP handlers do **not** open a fresh socket per request; they lease a pooled session through `withGateway()`.

- Implements the gateway wire protocol (JSON frames with `type: "req"/"res"/"event"`, UUID `id` correlation)
- 15-second request timeout per gateway call
- `withGateway()` reuses a pooled session when alive, otherwise reconnects
- Idle pooled session is cleaned up by `GATEWAY_POOL_IDLE_MS` + `GATEWAY_POOL_CLEANUP_INTERVAL_MS`
- Connection URL from env `GATEWAY_URL` (default: `ws://100.68.146.126:18789`)

---

## Auth

Session-token auth stored in a `SESSIONS` Map.

- Token issued at `POST /api/login`
- Passed as `Authorization: Bearer <token>` on subsequent requests
- Token is an **opaque UUID session id**, not JWT
- Auth is **only enforced** when `GATEWAY_PASSWORD` or `GATEWAY_TOKEN` is configured
- If neither is set, all requests pass through without auth
- When auth is enabled, `/api/login` and `/api/health` stay public; other `/api/*` routes require a valid session and extend session TTL on each request

---

## API Routes

| Route | Method | Gateway? | Description |
|---|---|---|---|
| `/api/login` | POST | No | Issue session token |
| `/api/health` | GET | No | Health check |
| `/api/system-load` | GET | No | CPU/memory via `node:os` |
| `/api/gateway-auth` | GET | No | Return browser gateway WS bootstrap config |
| `/api/overview` | GET | Yes | Gateway overview stats |
| `/api/models` | GET | Yes | List models |
| `/api/models/save` | POST | Yes | Save model config |
| `/api/skills` | GET | Yes | List skills |
| `/api/skills/install` | POST | Yes | Install skill dependency bundle |
| `/api/skills/update` | POST | Yes | Update skill config |
| `/api/agents` | GET | Yes | List persona agents |
| `/api/agents/create\|update\|delete` | POST | Yes | Manage persona agents |
| `/api/agents/files` | GET | Yes | List persona/prompt files for an agent |
| `/api/agents/file` | GET/POST | Yes | Read or save a persona/prompt file |
| `/api/cron/list` | GET | Yes | List cron jobs (adds `schedule.human`) |
| `/api/cron/runs` | GET | Yes | List execution runs for one cron job |
| `/api/cron/add\|update\|remove\|run` | POST | Yes | Manage cron jobs |
| `/api/nodes` | GET | Yes | List nodes |
| `/api/nodes/describe` | GET | Yes | Fetch node details |
| `/api/nodes/invoke` | POST | Yes | Invoke node action |
| `/api/logs` | GET | Yes | Fetch logs (polled by frontend) |
| `/api/gateway/restart` | POST | Partial | Restart gateway: hot (via config.patch RPC) or hard (SIGTERM via shell) |
| `/api/gateway/doctor` | GET | Yes | Run diagnostics (health, channels, memory status) |
| `/api/gateway/doctor/fix` | POST | No | Execute auto-fix (placeholder) |
| `/api/store/skills/search\|list\|detail/*` | GET | Mixed | Skill 商店浏览，`registry` 源走外部 `/api/v1/*`，`github-skills` 源走 GitHub repo |
| `/api/store/skills/install\|uninstall\|update\|install-dep` | POST | Mixed | Skill 安装与配置；ClawHub 安装走 gateway RPC，GitHub 安装写入本地 skills 目录 |
| `/api/store/plugins/search\|detail/*` | GET | Mixed | Plugin 商店浏览，当前仅 `registry` 源有效 |
| `/api/store/plugins/list\|install\|uninstall\|toggle\|config` | GET/POST | Mixed | Plugin 管理；list/toggle/config 走 gateway config，安装/卸载走本机 CLI |
| `/api/store/mcp/capability\|list\|presets\|set\|remove` | GET/POST | Mixed | MCP 能力探测、预置列表和配置；对旧网关会先返回“不支持”能力结果 |
| `/api/store/sources` | GET/POST/DELETE | No | 扩展中心 source 清单（runtime 文件：`data/store-sources.json`） |

---

## Configuration

Env vars (see `.env.example`):

| Var | Default | Description |
|---|---|---|
| `WEBUI_USERNAME` | `GATEWAY_USERNAME` or `admin` | Login username override |
| `WEBUI_PASSWORD` | `GATEWAY_PASSWORD`/`GATEWAY_TOKEN` | Login password override |
| `GATEWAY_URL` | `ws://100.68.146.126:18789` | Gateway WebSocket URL |
| `GATEWAY_USERNAME` | `admin` | WebUI login username |
| `GATEWAY_PASSWORD` | — | Gateway auth + WebUI password |
| `GATEWAY_TOKEN` | — | Alternative to password |
| `GATEWAY_ORIGIN` | `https://openclaw.lingshichat.top` | Origin header for gateway |
| `GATEWAY_PUBLIC_WS_URL` | — | Force browser-visible WS URL for `/api/gateway-auth` |
| `SESSION_TTL_MS` | `86400000` | Browser session TTL |
| `SESSION_CLEANUP_INTERVAL_MS` | `300000` | Expired session cleanup interval |
| `GATEWAY_POOL_IDLE_MS` | `30000` | Close pooled gateway session after this idle time |
| `GATEWAY_POOL_CLEANUP_INTERVAL_MS` | `10000` | Idle gateway cleanup interval |
| `PORT` | `18790` | Server port |

Notes:

- `.env.local` only fills keys that are missing from `process.env`; it never overwrites existing env.
- **`.env.local` 包含完整的本地开发凭证**（WEBUI 登录 + 网关鉴权），可用于直接请求服务器 API 调试，无需手动操作浏览器。
- Production server also reads `/root/.openclaw/openclaw.json` as fallback.
- Browser Chat bootstrap uses `GATEWAY_PUBLIC_WS_URL` first, then reverse-proxy headers, then `GATEWAY_URL`.

---

## OpenClaw Gateway Source

`openclaw-src/` 包含 OpenClaw 网关完整源码，可用于分析网关 RPC 协议和数据结构。当需要了解某个 gateway method 的返回格式时，应直接查阅网关源码而非猜测。

### 强制规范：后端改动必须先查阅网关源码

**任何涉及后端改动或功能新增的任务，在实现前必须先查阅 `openclaw-src/` 中的相关源码**，确认：

1. **RPC 方法签名和返回格式** — 查看 `openclaw-src/src/gateway/server-methods/` 下对应的 handler
2. **配置结构** — 查看 `openclaw-src/src/config/` 了解 config schema 和字段定义
3. **业务逻辑** — 查看相关模块理解网关侧的处理流程和约束
4. **已有能力** — 确认网关是否已提供所需 RPC，避免重复造轮子

不遵守此规范可能导致：字段名猜错、返回格式不匹配、遗漏网关已有能力、超时时间不合理等问题。

已知数据结构：
- `cron.runs` → `{ entries: [{ ts, jobId, action, status, error, runAtMs, durationMs, nextRunAtMs, model, provider, usage, ... }] }`

---

## Patch Files

`patch_*.cjs` and `src/server_patch*.mjs` are **historical migration scripts**. They are not part of the running application. Do not modify or execute unless reapplying a specific transformation.
