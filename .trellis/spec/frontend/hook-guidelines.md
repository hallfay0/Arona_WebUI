# Hook Guidelines

> 本文件不适用于当前项目。

---

## Not Applicable

本项目是 **vanilla JS SPA**，不使用 React、Vue 或任何组件框架，因此没有 hooks 概念。

**数据获取和状态共享的替代模式**请参见：

- [State Management](./state-management.md) — `state` 对象和状态更新模式
- [Component Guidelines](./component-guidelines.md) — 视图加载函数和 DOM 操作模式

### 项目中等效于 hooks 的模式

| 框架 Hook 概念 | 本项目等效实现 |
|---|---|
| `useState` / `useReducer` | 直接修改 `state` 对象属性 |
| `useEffect` | 在 `load*()` 视图函数中手动管理副作用和定时器 |
| `useFetch` / `useQuery` | `api()` 辅助函数 + `load*()` 视图加载函数 |
| `useContext` | 模块级 `state` 对象（全局可访问） |
| `useCallback` / `useMemo` | 不需要（无虚拟 DOM 重渲染） |
