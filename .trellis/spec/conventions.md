# Project Conventions

> Arona WebUI coding and workflow conventions.

---

## Project Identity

- **Name**: Arona WebUI (internal: `openclaw-mvp`)
- **Type**: Single-page admin dashboard for OpenClaw AI gateway
- **Stack**: Node.js (raw `node:http`) + vanilla JS (no framework, no build step)

---

## Commands

```bash
npm install     # Install dependencies
npm start       # Run server (or: node src/server.mjs)
```

No tests or lint scripts exist in this project.

---

## Git Workflow

- Single `main` branch, local merge, push to remote
- Commit messages: English verb prefix + Chinese description
  - Examples: `feat(chat): 新增Playground对话`, `fix(auth): 恢复登录页`
- Merge commits: `merge(main): 合并 feat/xxx`

---

## Code Style

- Backend: single file `src/server.mjs`, ESM (`import`/`export`)
- Frontend: vanilla JS ES modules in `public/`, no transpilation
- No TypeScript — plain JavaScript throughout
- Chinese-language UI strings

---

## Deployment

- Server on `127.0.0.1:18790`
- Reverse-proxied by Nginx with BasicAuth for public access
- Production reads `/root/.openclaw/openclaw.json` for gateway config fallback
