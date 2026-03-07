# Type Safety

> 本文件不适用于当前项目。

---

## Not Applicable

本项目是 **纯 JavaScript** 项目，不使用 TypeScript，没有类型定义文件，也没有运行时类型验证库（Zod、Yup 等）。

---

## 项目中的防御性编程模式

虽然无类型系统，项目通过以下模式保证数据安全：

### 1. 运行时类型检查

```js
// public/app.js — cloneProviderConfig (约第 943 行)
function cloneProviderConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return {}; }
}
```

### 2. 安全取值与默认值

```js
// 常见模式：可选链 + 空值合并
const cpu = data?.system?.cpu || {};
const memPercent = Number(memory.usagePercent || 0);
const mode = String(health?.gateway?.authMode || "unknown").toLowerCase();
```

### 3. Number 安全验证

```js
// public/gateway-client.js — 构造函数
this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
  ? options.requestTimeoutMs : 15000;
```

### 4. 输入消毒

```js
// public/app.js — escapeHtml (约第 454 行)
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
```

---

## 约定

- 所有函数参数使用 `typeof` / `Array.isArray` / `Number.isFinite` 进行防御性检查
- 对象属性访问使用可选链 `?.`
- 将外部输入强制转换为期望类型：`String(value)`, `Number(value)`
- 不依赖 JSDoc 类型注解
