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

### 4. Chat transport 连接状态

`state.chat.client` 不是固定的 `GatewayClient`，而是 `public/chat-transport.js` 创建的 transport 实例：
- `HttpSseChatTransport`
  - 默认路径
  - 通过 `GET /api/chat/events` 接收实时事件
  - 通过 `/api/chat/*` HTTP 路由发送请求
- `HttpPollingChatTransport`
  - 纯 HTTP 轮询兼容路径
- `LegacyGatewayChatTransport`
  - 仅兼容旧的 `/api/gateway-auth` + `/api/chat/ws` WebSocket 路径

统一 transport 契约：
- `status`：`"disconnected"` / `"connecting"` / `"connected"` / `"reconnecting"`
- `onStatusChange(fn)`：订阅 transport 状态变化
- `onEvent(fn)`：订阅 `chat` / `sessions.changed` / `session.message`
- `request(method, params)`：统一调用 `sessions.list` / `chat.history` / `chat.send` / `chat.abort` / `sessions.patch`
- `isConnected()`：表示当前 transport 是否可发请求

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
    requested: "http-sse",
    active: "",
    mode: "http-sse",
    syncMode: "events",
    fallbackMode: "legacy-ws",
    degraded: false
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
  compensationTimer: null,
  compensationRecovered: false,
  globalDefaultModelRef: "",
  selectedAgentId: "",
  selectedModelRef: "",
  chatAgents: [],
  chatModels: []
}
```

#### Chat transport 子状态

- `requested`
  - 最近一次请求的 transport 偏好
  - 当前默认是 `"http-sse"`
- `active`
  - 当前已实际建立的 transport：`"http-sse"` / `"http-poll"` / `"legacy-ws"`
  - 未连接时为空字符串
- `mode`
  - transport 的规范化模式
  - 只允许 `"http-sse"` / `"http-poll"` / `"legacy-ws"`
- `syncMode`
  - 当前同步方式：`"events"` / `"polling"`
  - `http-sse` 连接成功但 Gateway 不支持 `sessions.subscribe` 时，会退到 `"polling"`
- `fallbackMode`
  - 当前保留 `"legacy-ws"`，用于兼容旧路径
- `degraded`
  - 是否处于“已连上 transport，但列表/历史需要轮询补偿”的状态

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
- `compensationTimer`
  - 后台补偿轮询定时器
- `compensationRecovered`
  - 仅用于视图重新激活后补一次静默刷新，避免旧数据残留

### 8. Chat 流式渲染运行态

- `state.chat.streamTargetByMessage`：按 `messageId` 记录“目标文本”；`chat` 事件的 delta 到达时直接更新这里，不再维护额外的 delta flush 队列。
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
async function refreshChatNow({
  reason,
  reloadSessions,
  reloadHistory,
  silentHistory,
  preserveScroll,
  allowReconnect,
  background
})
```

规则：
- “立即重连”：
  - `ensureChatClientConnected({ forceReconnect: true })`
  - 然后 `refreshChatNow({ reason: "reconnect", allowReconnect: false })`
- “刷新”：
  - 只调用 `refreshChatNow({ reason: "manual", allowReconnect: false })`
  - 当前 transport 断开时应直接报错，不做隐式重连
- `setChatViewActive(true)`：
  - 如果当前同步模式需要补偿轮询，则启动 `scheduleChatCompensationPoll(...)`
  - 若 `needsRefresh=true` 或 `compensationRecovered=true`，触发一次 `background: true` 的静默刷新
- `background: true`
  - 只能用于后台同步
  - 不允许把“刷新”按钮置为 busy / spin
- `refreshCurrentSessionHistory(...)`
  - 当 transport 仍能依赖实时事件（`http-sse` 或 `legacy-ws` 且连接正常）时，pending run 阶段应跳过 history 拉取，避免打断实时流
  - 当 transport 是 `http-poll` 时，pending run 阶段必须继续拉 history

### Chat transport / subscription 模式

```js
async function ensureChatClientConnected({ forceReconnect = false } = {}) {
  if (forceReconnect) destroyChatClient();
  if (state.chat.client?.isConnected()) {
    await resubscribeChatState();
    return state.chat.client;
  }
  if (!state.chat.client) {
    state.chat.client = createChatClient();
  }
  await state.chat.client.connect();
  await resubscribeChatState();
}
```

关键约束：
- `destroyChatClient()` 必须同时：
  - 关闭 transport
  - 清空 subscription state
  - 清理 `historyRefreshTimer` / `sessionsRefreshTimer` / `compensationTimer`
  - 清空 `state.chat.transport.active`
  - 重置 `state.chat.transport.syncMode`
- `resubscribeChatState()` 必须在每次重建连接后重新执行
- 选中会话后必须 `ensureChatSessionSubscription(nextKey)`
- 当会话列表刷新后不再存在当前会话时，必须：
  - 清空 `state.chat.sessionKey`
  - 调用 `clearChatSessionSubscription()`
- `createChatClient()` 必须统一处理 transport 状态：
  - `transport.mode`
  - `transport.syncMode`
  - `transport.degraded`
  - `setChatStatus(...)`
- `HttpSseChatTransport`
  - `transport === "http-sse"` 只表示事件流 transport 已连通
  - 是否真正依赖事件做摘要同步，要看 `syncMode === "events"`
  - 若服务端状态事件返回 `mode: "polling"`，前端必须保留实时 `chat` 事件，同时对列表/历史开启后台补偿轮询
- `sessions.subscribe` / `sessions.messages.subscribe`
  - 对 HTTP transport 来说是 no-op
  - 对 `http-sse` / `legacy-ws` 来说，若上游返回 `unknown/unsupported/not found/invalid request`，必须把 `state.chat.subscriptions.supported=false`

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
- `compensationTimer`
  - 在以下场景启用后台补偿：
    - `http-poll`
    - `http-sse` 已连接但 `syncMode === "polling"`
    - transport 正在 `connecting/reconnecting/disconnected`
  - 节奏：
    - pending run / sending：约 `1500ms`
    - 空闲：约 `5000ms`

---

## Server State

- **无缓存层**：每次视图切换或显式刷新时直接从 API / WS 拉取最新数据
- **API 调用通过 `api()` 辅助函数**：自动附加 auth header，401 时重定向到登录页
- **Chat 实时数据**：Chat/Playground 默认通过 `/api/chat/events` SSE 接收 `chat` / `sessions.changed` / `session.message`
- **Chat transport 不是全局单例服务**：其生命周期跟随 `state.chat.client` 管理

---

## Common Mistakes

- **不要把新的业务状态散落到 `state` 对象之外**：现有模块级运行态主要是 UI/媒体查询辅助，不应成为继续扩散的理由
- **不要忘记在视图切换时清理定时器**：参见 `stopOverviewTimers()` / `stopLogStream()` / `destroyChatClient()`
- **不要假设 `state.chat.client` 已连接**：始终检查 `isConnected()` 或使用 `ensureChatClientConnected()`
- **不要让“刷新”隐式重连**：手动刷新必须失败快，重连由独立按钮负责
- **不要在 transport 重建后假设订阅还在**：必须重新 `sessions.subscribe` / `sessions.messages.subscribe`
- **不要把 `http-sse` 的 `connected` 简化理解成“所有同步都靠事件”**：还要结合 `syncMode` 判断当前是不是在后台补偿轮询
- **不要让后台同步把实时流打断**：pending run 阶段只有 `http-poll` 才应继续主动拉 `chat.history`
- **不要把 `openclaw_token` 当成 JWT 解析**：它只是后端 `SESSIONS` Map 里的 opaque session token
- **不要让过期的 Persona 异步结果覆盖当前编辑目标**：必须同时校验 request id 与当前选中项
