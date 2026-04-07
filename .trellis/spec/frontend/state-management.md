# State Management

> Arona WebUI 的状态管理模式。

---

## Overview

本项目使用**单一模块级 `state` 对象**管理所有应用状态，无任何状态管理库。状态变更通过直接赋值完成，UI 更新通过手动 DOM 操作触发。

---

## State Categories

### 1. 应用状态 — `state` 对象

定义在 `public/app.js` 顶部（约第 3 行），是整个 SPA 的唯一全局状态容器。

```js
const state = {
  currentView: "overview",
  modelsHash: "",
  modelProvidersDraft: {},
  agentsDefaultsModelsDraft: {},
  agentsDefaultModelDraft: null,
  modelsAdvancedDrafts: { ... },
  deletedModelProviderKeys: new Set(),
  deletedAllowlistModelRefs: new Set(),
  modelsApply: { ... },
  providerModalOpen: false,
  skillModalOpen: false,
  providerEditor: { ... },
  confirmDialog: { ... },
  modalFocus: { ... },
  logsCursor: null,
  logsTimer: null,
  logsLive: false,
  systemTimer: null,
  overviewTimer: null,
  nodeCommandDefaults: [],
  modelDefaultOptions: [],
  cronJsonMode: false,
  persona: { ... },
  chat: { ... }
};
```

### 2. 持久化状态 — `localStorage`

| Key | 用途 | 示例 |
|---|---|---|
| `openclaw_token` | 不透明的 session Bearer token（非 JWT） | UUID 风格 token 字符串 |
| `openclaw-theme` | 主题偏好 | `"dark"` 或 `"light"` |

### 3. 模块级缓存

```js
let _skillsCache = [];
```

业务数据应优先进入 `state`。当前仓库仍保留少量模块级 UI/runtime 运行态（例如 spotlight 指针与 reduced-motion 媒体查询结果），但不要继续把新的业务状态散落到 `state` 之外。

### 4. WebSocket 连接状态

`GatewayClient` 实例（`state.chat.client`）内部维护自己的连接状态：
- `status`：`"disconnected"` / `"connecting"` / `"connected"` / `"reconnecting"`
- `statusListeners` / `eventListeners`：回调监听器集合
- `pending`：请求-响应 Promise 映射
- `connectionConfig.meta.transport`：当前连接使用的 `"proxy"` 或 `"direct"`

### 5. Persona 编辑器异步子状态

- `state.persona` 使用 `listRequestId` / `filesRequestId` / `fileRequestId` 避免旧请求覆盖当前选择。
- 只有当「请求编号仍然匹配」且「当前选中的 agent / file 仍然一致」时，异步结果才允许落地到状态。
- 文件缺失不是异常终态：会落到 `fileMissing = true` 的“可创建态”。
- 详情见 `.trellis/spec/frontend/persona-editor-state.md`。

### 6. 模型配置热重启子状态

- `deletedModelProviderKeys`：记录用户删除或重命名后需要在 `config.patch` 中发送 `null` tombstone 的 provider key。
- `agentsDefaultsModelsDraft`：当前模型页里“Agent 可用” allowlist 的前端草稿。
- `agentsDefaultModelDraft`：当前模型页里“设为默认”对应的默认模型草稿。
- `modelsAdvancedDrafts`：当前模型页里专用模型、Embedding 与语音配置的前端草稿，包含 `imageModel` / `imageGenerationModel` / `pdfModel` / `pdfMaxBytesMb` / `pdfMaxPages` / `summarize` / `subagents` / `memorySearch` / `ttsConfig` / `audioTranscription`。
- `modelsAdvancedDrafts.summarize` 与 `modelsAdvancedDrafts.subagents` 只会被当前 UI 修改少数字段（如 `model`、`timeoutSeconds`、`thinking`）；保存时必须保留对象里原有的其他键。
- `modelsAdvancedDrafts.memorySearch` 当前 UI 只编辑 `enabled|provider|model|remote.baseUrl|remote.apiKey|fallback`；像 `remote.headers`、`remote.batch`、`local`、`store`、`chunking`、`query` 这类高级字段必须在 round-trip 时保留。
- `modelsAdvancedDrafts.ttsConfig` 当前 UI 只结构化管理 `auto|provider|summaryModel|timeoutMs|maxTextLength|openai.model|openai.voice|openai.baseUrl|openai.apiKey`；其余字段通过额外 JSON 保留并 round-trip。
- `modelsAdvancedDrafts.audioTranscription` 当前 UI 只结构化管理 `enabled|language|timeoutSeconds|maxChars` 与前两条 provider 模型 entry；更复杂的 `models[]` 链路、`headers`、`providerOptions` 等字段通过额外 JSON 保留并 round-trip。
- `deletedAllowlistModelRefs`：记录取消勾选或删除后需要在 `config.patch` 中发送 `null` tombstone 的模型引用。
- `modelsApply.phase`：`"idle" | "restarting" | "error"`，驱动“网关热重启中”状态徽标和按钮禁用 / 重试连接状态。
- `modelsApply.message`：当前热重启提示文案；在轮询恢复期间动态更新。

### 7. Chat 状态对象

当前 `state.chat` 除了会话与消息数据，还承载 transport、订阅与刷新状态：

```js
chat: {
  client: null,
  authConfig: null,
  initialized: false,
  viewActive: false,
  sessions: [],
  sessionKey: "",
  messages: [],
  pendingRuns: new Map(),
  status: "disconnected",
  needsRefresh: false,
  historyRefreshTimer: null,
  sessionsRefreshTimer: null,
  bindingsReady: false,
  mobileSessionsOpen: false,
  sending: false,
  lastStatusReason: "",
  transport: {
    requested: "proxy",
    active: "",
    allowDirectFallback: false,
    proxyUrl: "",
    proxyTicketExpiresAt: 0,
    directUrl: "",
    directAuthMode: "unknown"
  },
  subscriptions: {
    sessionEvents: false,
    messageKey: "",
    supported: true
  },
  refresh: {
    busy: false,
    reason: "",
    lastAt: 0
  },
  streamTargetByMessage: new Map(),
  streamAnimationTimer: null,
  streamAnimationIsRaf: false,
  streamAnimationLastTs: 0,
  streamLastDomUpdateTs: 0,
  streamCursorFadeIds: new Set(),
  streamCursorFadeTimers: new Map(),
  historyLimit: 10,
  historyBatchSize: 10,
  historyMaxLimit: 1000,
  hasOlderMessages: false,
  loadingOlderMessages: false,
  globalDefaultModelRef: "",
  selectedAgentId: "",
  selectedModelRef: "",
  chatAgents: [],
  chatModels: []
}
```

#### Chat transport 子状态

- `requested`
  - 最近一次 bootstrap 请求返回的目标 transport
  - 当前实现默认是 `"proxy"`
- `active`
  - 当前已实际建立的 transport：`"proxy"` 或 `"direct"`
  - 未连接时为空字符串
- `allowDirectFallback`
  - 仅由后端 bootstrap 决定
  - 前端不能本地猜测
- `proxyUrl` / `proxyTicketExpiresAt`
  - 用于显示与调试当前 proxy bootstrap
- `directUrl` / `directAuthMode`
  - 用于 direct 模式和 fallback 判定

#### Chat 订阅子状态

- `sessionEvents`
  - 当前 transport 上是否已完成 `sessions.subscribe`
- `messageKey`
  - 当前 transport 正在监听的 `sessions.messages.subscribe` 会话 key
- `supported`
  - 若订阅接口返回 unknown/unsupported/not found，则置为 `false`
  - 降级后不能再自动重试订阅，避免每次刷新都报错

#### Chat 刷新子状态

- `busy`
  - 由“刷新”按钮与统一刷新 helper 共享
- `reason`
  - 最近一次刷新原因：如 `manual` / `reconnect` / `view-activation`
- `lastAt`
  - 最近一次刷新完成时间戳

### 8. Chat 流式渲染运行态

- `state.chat.streamTargetByMessage`：按 `messageId` 记录“目标文本”；WebSocket delta 到达时直接更新这里，不再维护额外的 delta flush 队列。
- `state.chat.streamAnimationTimer` / `streamAnimationIsRaf` / `streamAnimationLastTs`：单一动画循环的调度状态；由一个 rAF / timeout 驱动逐字推进。
- `state.chat.streamLastDomUpdateTs`：流式 DOM 更新节流时间戳；用于把 Markdown 解析和 `innerHTML` 更新控制在约 80ms 一次。
- `state.chat.streamCursorFadeIds` / `streamCursorFadeTimers`：记录哪些消息处于“流式结束、光标淡出”过渡态；过渡完成后必须移除，避免旧消息长期停留在 streaming 样式上。

#### Chat 流式约束

- 流式阶段使用 `message.text` 作为当前已显示文本，`streamTargetByMessage.get(message.id)` 作为待追赶目标。
- 流式 Markdown 必须走与完成态一致的 `renderMarkdown()` 路径；如果内容暂时不完整，先通过 `autoCloseMarkdown()` 补齐未闭合 fence / inline marker，再渲染。
- 打字动画只允许存在一条主循环；不要再引入“delta flush rAF + stream rAF”双管线。
- 视图停用、连接断开、切换会话、重载历史时，必须同时清理：
  - `streamAnimationTimer`
  - `streamTargetByMessage`
  - `streamCursorFadeIds`
  - `streamCursorFadeTimers`
  - `streamAnimationLastTs`
  - `streamLastDomUpdateTs`

#### Chat 流式完成态

- final 事件到达时，先保留当前 streaming 节点，把光标切到淡出类，再延迟回到普通消息渲染；不要直接整行替换，否则看起来会像“闪一下就结束”。
- aborted / error 事件必须同步移除该消息的 streaming target 和 cursor fade 状态，避免后续会话残留旧动画。

---

## State Update Patterns

### 直接赋值 + 手动 DOM 更新

```js
function setView(view) {
  state.currentView = view;
  for (const section of document.querySelectorAll(".view")) {
    section.classList.toggle("active", section.id === `view-${view}`);
  }
  const load = viewLoaders[view];
  if (load) load();
}
```

### 视图刷新模式

视图加载函数直接从 API 获取数据并重新渲染整个视图区域：

```js
async function loadOverview() {
  const container = $("overview-content");
  container.innerHTML = renderSkeleton(5);
  const data = await api("/api/overview");
  container.innerHTML = `...渲染完整 HTML...`;
}
```

### Chat 统一刷新模式

Chat 不再把刷新逻辑散落在连接、切页、事件回调里。统一从以下 helpers 进入：

```js
async function refreshChatSessions({ reason, preserveSelection, allowReconnect })
async function refreshCurrentSessionHistory({ reason, silent, preserveScroll, allowReconnect })
async function refreshChatNow({ reason, reloadSessions, reloadHistory, silentHistory, preserveScroll, allowReconnect })
```

规则：
- “立即重连”：
  - `ensureChatClientConnected({ forceReconnect: true })`
  - 然后 `refreshChatNow({ reason: "reconnect", allowReconnect: false })`
- “刷新”：
  - 只调用 `refreshChatNow({ reason: "manual", allowReconnect: false })`
  - 当前 transport 断开时应直接报错，不做隐式重连
- `setChatViewActive(true)`：
  - 仅在 `needsRefresh=true` 时触发一次视图激活刷新

### Chat transport / subscription 模式

```js
async function ensureChatClientConnected({ forceReconnect = false } = {}) {
  if (forceReconnect) destroyChatClient();
  if (state.chat.client?.isConnected()) {
    await resubscribeChatState();
    return state.chat.client;
  }
  const authConfig = await fetchGatewayAuthConfig();
  await connectChatClientFromBootstrap(state.chat.client, authConfig);
  await resubscribeChatState();
}
```

关键约束：
- `destroyChatClient()` 必须同时：
  - 关闭 transport
  - 清空 subscription state
  - 清理 `historyRefreshTimer` / `sessionsRefreshTimer`
  - 清空 `state.chat.transport.active`
- `resubscribeChatState()` 必须在每次重建连接后重新执行
- 选中会话后必须 `ensureChatSessionSubscription(nextKey)`
- 当会话列表刷新后不再存在当前会话时，必须：
  - 清空 `state.chat.sessionKey`
  - 调用 `clearChatSessionSubscription()`

### 定时器轮询模式

部分状态通过 `setInterval` 定期从服务器刷新：

```js
function startOverviewTimers() {
  state.systemTimer = setInterval(() => loadSystemLoad(), 5000);
  state.overviewTimer = setInterval(() => loadOverview(), 30000);
}
```

Chat 当前额外使用两类 `setTimeout`：
- `historyRefreshTimer`
  - 合并 `session.message` / `chat final` 触发的静默历史刷新
- `sessionsRefreshTimer`
  - 合并 `sessions.changed` / `session.message` 的摘要刷新

---

## Server State

- **无缓存层**：每次视图切换或显式刷新时直接从 API / WS 拉取最新数据
- **API 调用通过 `api()` 辅助函数**：自动附加 auth header，401 时重定向到登录页
- **WebSocket 实时数据**：Chat/Playground 视图通过 `GatewayClient` 接收流式事件
- **Chat transport 不是全局单例服务**：其生命周期跟随 `state.chat.client` 管理

---

## Common Mistakes

- **不要把新的业务状态散落到 `state` 对象之外**：现有模块级运行态主要是 UI/媒体查询辅助，不应成为继续扩散的理由
- **不要忘记在视图切换时清理定时器**：参见 `stopOverviewTimers()` / `stopLogStream()` / `destroyChatClient()`
- **不要假设 `state.chat.client` 已连接**：始终检查 `isConnected()` 或使用 `ensureChatClientConnected()`
- **不要让“刷新”隐式重连**：手动刷新必须失败快，重连由独立按钮负责
- **不要在 transport 重建后假设订阅还在**：必须重新 `sessions.subscribe` / `sessions.messages.subscribe`
- **不要把 `openclaw_token` 当成 JWT 解析**：它只是后端 `SESSIONS` Map 里的 opaque session token
- **不要让过期的 Persona 异步结果覆盖当前编辑目标**：必须同时校验 request id 与当前选中项
