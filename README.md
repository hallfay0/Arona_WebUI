# Arona WebUI

A single-page admin dashboard for [OpenClaw](https://github.com/nicepkg/openclaw) AI gateway.
Monitor, configure, and interact with your OpenClaw instance from the browser.

**English** | [中文](./README.zh-CN.md)

<!-- ![Dashboard](docs/screenshots/dashboard.png) -->

## Features

- **Dashboard** — system overview with real-time CPU / memory monitoring
<img width="2560" height="1347" alt="image" src="https://github.com/user-attachments/assets/8d5aacdd-a6a7-4f95-a69f-b81b2440c8e3" />

- **Model Management** — configure AI model providers and routing
<img width="2560" height="1346" alt="image" src="https://github.com/user-attachments/assets/ff37b8bf-d063-4be2-b7e9-6895b45834eb" />
- **Skills** — manage agent skills and API keys
<img width="2560" height="1339" alt="image" src="https://github.com/user-attachments/assets/53f10f4d-44b9-475a-bef1-bfc0834a184c" />

- **Cron Jobs** — scheduled tasks (cron / at / interval) with run history
<img width="2560" height="1344" alt="image" src="https://github.com/user-attachments/assets/60ad6ed1-a8b0-4aa2-8e8b-5195c70b53f5" />

- **Chat Playground** — real-time chat with gateway sessions via WebSocket
<img width="2560" height="1337" alt="image" src="https://github.com/user-attachments/assets/cbeae770-23e4-41cb-a43e-8b58eda9fc9d" />

- **Persona & Prompts** — agent identity and prompt file management
<img width="2560" height="1341" alt="image" src="https://github.com/user-attachments/assets/c907776d-184c-42d2-9b40-b710506b09b4" />

- **Node Topology** — device and node monitoring
<img width="2560" height="1340" alt="image" src="https://github.com/user-attachments/assets/dfb43347-cc8a-4b84-aad5-f0e1bfb71180" />

- **Usage Stats** — model and channel usage analytics
<img width="2560" height="1337" alt="image" src="https://github.com/user-attachments/assets/31846c72-a3dc-420b-9003-8e62fa6d2c70" />

- **Live Logs** — real-time log streaming with keyword search
<img width="2560" height="1331" alt="image" src="https://github.com/user-attachments/assets/a28898bd-bc5f-4e9e-86d7-845e2694c94b" />

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A running [OpenClaw](https://github.com/nicepkg/openclaw) gateway instance

## Quick Start

```bash
git clone https://github.com/nicepkg/arona-webui.git
cd arona-webui
npm install
```

Create a `.env.local` (or export env vars) with your gateway connection info:

```env
GATEWAY_URL=ws://127.0.0.1:18789
GATEWAY_PASSWORD=your-gateway-password
```

Start the server:

```bash
npm start
# Open http://localhost:18790
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_URL` | `ws://127.0.0.1:18789` | Gateway WebSocket URL |
| `GATEWAY_USERNAME` | `admin` | WebUI login username |
| `GATEWAY_PASSWORD` | — | Gateway password |
| `GATEWAY_TOKEN` | — | Alternative: token-based auth |
| `GATEWAY_ORIGIN` | `http://localhost:18790` | Allowed browser origin for CORS |
| `GATEWAY_PUBLIC_WS_URL` | *(auto-detected)* | Override the WebSocket URL sent to browser clients |
| `PORT` | `18790` | Server listen port |

> **Note**: `GATEWAY_PASSWORD` and `GATEWAY_TOKEN` are mutually exclusive — set one or the other depending on your gateway auth mode.

## Screenshots

<!-- Replace the commented-out image references below with actual screenshots -->

<!-- ![Dashboard](docs/screenshots/dashboard.png) -->
<!-- ![Models](docs/screenshots/models.png) -->
<!-- ![Chat Playground](docs/screenshots/chat.png) -->
<!-- ![Persona Editor](docs/screenshots/persona.png) -->

## Tech Stack

- **Backend** — Node.js (`node:http`, no framework)
- **Frontend** — vanilla JavaScript ES modules, no build step
- **Transport** — WebSocket (gateway control protocol)
- **Styling** — CSS custom properties with dark / light theme support

## License

MIT
