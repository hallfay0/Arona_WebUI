# Directory Structure

> Arona WebUI 前端目录组织。

---

## Overview

前端为**零构建**的 vanilla JS SPA，所有文件位于 `public/` 并由 Node.js 服务器直接静态伺服。没有打包工具、没有转译步骤。

---

## Directory Layout

```
public/
├── index.html              # SPA 主壳页，含所有 view section
├── login.html              # 独立登录页（自包含样式和脚本）
├── app.js                  # 核心 SPA 逻辑（~4600 行单体文件）
├── chat-transport.js       # Chat transport 抽象（http-sse / http-poll / legacy-ws）
├── gateway-client.js       # WebSocket 网关客户端（GatewayClient 类）
├── auth-check.js           # 页面加载前的登录守卫（检查 localStorage token）
├── theme.js                # 暗色/亮色主题切换
├── styles.css              # 全局样式（CSS 自定义属性体系，~4800 行）
└── assets/
    ├── arona-avatar.svg     # Arona 头像 SVG
    ├── avatar.jpg           # 登录页头像
    ├── bg.jpg               # 登录页背景
    ├── blog-bg.jpg          # 备用背景
    └── fontawesome/         # FontAwesome 6 离线包
        ├── css/all.min.css
        └── webfonts/...
```

后端为单文件：

```
src/
└── server.mjs              # Node.js HTTP 服务器（~785 行）
```

---

## Module Organization

- **单体 JS 架构**：所有 SPA 逻辑集中在 `app.js` 中，按功能区域以注释分隔
- **独立模块仅在有明确边界时拆分**：`chat-transport.js`（Chat transport 抽象）、`gateway-client.js`（legacy Gateway WS 通信）、`auth-check.js`（认证守卫）、`theme.js`（主题）
- **视图以函数组织**：每个导航视图对应一组 `load*` / `render*` 函数（如 `loadOverview()`、`loadModels()`、`loadSkills()`）
- **新功能应在 `app.js` 中按区域添加**，除非是完全独立的基础设施级功能才考虑拆分新文件

---

## Naming Conventions

| 类型 | 命名规则 | 示例 |
|---|---|---|
| JS 文件 | 小写 kebab-case `.js` | `gateway-client.js`, `auth-check.js` |
| HTML 文件 | 小写 kebab-case `.html` | `index.html`, `login.html` |
| CSS 文件 | 小写 `.css` | `styles.css` |
| 静态资源 | 小写 kebab-case | `arona-avatar.svg`, `blog-bg.jpg` |
| JS 函数 | camelCase | `loadOverview()`, `renderTable()` |
| DOM ID | kebab-case | `#view-overview`, `#nav-menu`, `#toast-container` |
| CSS 类名 | kebab-case (BEM 变体) | `.glass-panel`, `.stat-card-icon`, `.btn-primary-strong` |

---

## Examples

- 视图组织：`public/app.js` 中 `viewLoaders` 映射表（约第 151 行）定义了所有视图入口
- 独立模块拆分示例：`public/chat-transport.js` 统一封装 `HttpSseChatTransport` / `HttpPollingChatTransport` / `LegacyGatewayChatTransport`
- 认证守卫示例：`public/auth-check.js` 在 `index.html` 最顶部 `<script>` 引入，页面加载前检查 token
