/**
 * Store Routes — /api/store/* 路由
 *
 * 遵循现有 HTTP API contract：
 * - 错误: { ok: false, error: "..." }
 * - 成功: 原始 payload 或 { ok: true, data: ... }
 *
 * 所有路由通过 handleStoreApi() 分发，由 server.mjs 的 handleApi 调用。
 */

import { GitHubSkillsAdapter, McpAdapter, McpPresetAdapter, PluginAdapter, RegistryAdapter, SkillAdapter } from "./store-adapters.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
const DEFAULT_REGISTRY_SOURCE_URL = (
  process.env.OPENCLAW_CLAWHUB_URL ||
  process.env.CLAWHUB_URL ||
  "https://clawhub.ai"
).replace(/\/+$/, "");
const SOURCE_KIND_ALLOWED_TABS = {
  registry: ["skill", "plugin"],
  "github-skills": ["skill"],
  "mcp-presets": ["mcp"]
};
const BUILTIN_SOURCES = [
  {
    id: "clawhub",
    name: "ClawHub",
    kind: "registry",
    url: DEFAULT_REGISTRY_SOURCE_URL,
    builtin: true,
    tabs: ["skill", "plugin"]
  },
  {
    id: "builtin-mcp",
    name: "内置 MCP 预置",
    kind: "mcp-presets",
    url: "builtin://mcp-presets",
    builtin: true,
    tabs: ["mcp"]
  }
];

// ── 仓库源管理 ──────────────────────────────────────────────────

const SOURCES_FILE = path.join(__dirname, "..", "data", "store-sources.json");

function normalizeSourceTabs(kind, tabs) {
  const allowedTabs = SOURCE_KIND_ALLOWED_TABS[kind] || ["skill"];
  const requestedTabs = Array.isArray(tabs)
    ? tabs.map((tab) => String(tab)).filter((tab) => allowedTabs.includes(tab))
    : [];
  return requestedTabs.length > 0 ? requestedTabs : [...allowedTabs];
}

function inferSourceKind(source) {
  if (source?.kind) return String(source.kind);
  const url = String(source?.url || "").trim();
  const name = String(source?.name || "").trim().toLowerCase();

  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  if (parsed && /github\.com$/i.test(parsed.hostname)) {
    const segments = parsed.pathname.split("/").filter(Boolean);
    const repoName = String(segments[1] || "").toLowerCase();
    if (segments.length >= 2 && (repoName === "skills" || name.includes("skills"))) {
      return "github-skills";
    }
  }

  if ((parsed && /\.json$/i.test(parsed.pathname)) || name.includes("mcp")) {
    return "mcp-presets";
  }

  return "registry";
}

function normalizeSourceRecord(source, { builtin = false } = {}) {
  const kind = inferSourceKind(source);
  const normalized = {
    id: String(source?.id || "").trim(),
    name: String(source?.name || "").trim(),
    kind,
    url: String(source?.url || "").trim().replace(/\/+$/, ""),
    builtin: builtin || source?.builtin === true,
    tabs: normalizeSourceTabs(kind, source?.tabs)
  };

  if (kind === "github-skills") {
    normalized.ref = String(source?.ref || "main").trim() || "main";
    normalized.skillsPath = String(source?.skillsPath || "skills").trim() || "skills";
  }

  return normalized;
}

function readSources() {
  let customSources = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("invalid source list");
    customSources = parsed.map((source) => normalizeSourceRecord(source));
  } catch {
    customSources = [];
  }

  const merged = [];
  const seen = new Set();
  for (const source of [...BUILTIN_SOURCES.map((source) => normalizeSourceRecord(source, { builtin: true })), ...customSources]) {
    if (!source.id || seen.has(source.id)) continue;
    seen.add(source.id);
    merged.push(source);
  }
  return merged;
}

function writeSources(sources) {
  const dir = path.dirname(SOURCES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = sources
    .filter((source) => source?.builtin !== true)
    .map((source) => normalizeSourceRecord(source));
  fs.writeFileSync(SOURCES_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function resolveSource(sourceId, tab) {
  const normalizedId = String(sourceId || "clawhub").trim() || "clawhub";
  const sources = readSources();
  const source = sources.find((entry) => entry?.id === normalizedId) || null;
  if (!source) return null;
  if (tab && (!Array.isArray(source.tabs) || !source.tabs.includes(tab))) return null;
  return source;
}

// ── MCP 预置列表 ────────────────────────────────────────────────

let mcpPresetsCache = null;

function readMcpPresets() {
  if (mcpPresetsCache) return mcpPresetsCache;
  try {
    mcpPresetsCache = JSON.parse(
      fs.readFileSync(path.join(publicDir, "mcp-presets.json"), "utf8")
    );
  } catch {
    mcpPresetsCache = [];
  }
  return mcpPresetsCache;
}

// ── Route Handler ───────────────────────────────────────────────

/**
 * @param {object} ctx — { req, res, pathname, query, parseBody, jsonResponse, withGateway }
 * @returns {boolean} true if route was handled, false if not matched
 */
export async function handleStoreApi(ctx) {
  const { req, res, pathname, parseBody, jsonResponse, withGateway } = ctx;

  // ── Skills: Registry ──

  if (req.method === "GET" && pathname === "/api/store/skills/search") {
    const q = ctx.query.get("q") || "";
    const limit = ctx.query.get("limit") || "20";
    const source = resolveSource(ctx.query.get("source"), "skill");
    if (!q) return jsonResponse(res, 400, { ok: false, error: "q (搜索关键词) 不能为空" });
    if (!source) return jsonResponse(res, 404, { ok: false, error: "仓库源不存在" });
    const results = source.kind === "github-skills"
      ? await GitHubSkillsAdapter.searchSkills(source, q, Number(limit))
      : await RegistryAdapter.searchSkills(q, Number(limit), { baseUrl: source.url });
    return jsonResponse(res, 200, results);
  }

  if (req.method === "GET" && pathname === "/api/store/skills/list") {
    const limit = ctx.query.get("limit") || "50";
    const source = resolveSource(ctx.query.get("source"), "skill");
    if (!source) return jsonResponse(res, 404, { ok: false, error: "仓库源不存在" });
    const items = source.kind === "github-skills"
      ? await GitHubSkillsAdapter.listSkills(source)
      : await RegistryAdapter.listSkills(Number(limit), { baseUrl: source.url });
    return jsonResponse(res, 200, items);
  }

  if (req.method === "GET" && pathname.startsWith("/api/store/skills/detail/")) {
    const slug = decodeURIComponent(pathname.slice("/api/store/skills/detail/".length));
    const source = resolveSource(ctx.query.get("source"), "skill");
    if (!slug) return jsonResponse(res, 400, { ok: false, error: "slug 不能为空" });
    if (!source) return jsonResponse(res, 404, { ok: false, error: "仓库源不存在" });
    const detail = source.kind === "github-skills"
      ? await GitHubSkillsAdapter.skillDetail(source, slug)
      : await RegistryAdapter.skillDetail(slug, { baseUrl: source.url });
    return jsonResponse(res, 200, detail);
  }

  // ── Skills: Management ──

  if (req.method === "POST" && pathname === "/api/store/skills/install") {
    const body = await parseBody(req);
    if (!body.slug) return jsonResponse(res, 400, { ok: false, error: "slug 不能为空" });
    const source = resolveSource(body.source, "skill");
    if (!source) return jsonResponse(res, 404, { ok: false, error: "技能仓库源不存在" });
    const result = source.kind === "github-skills"
      ? await SkillAdapter.installFromGitHub(withGateway, source, { slug: body.slug })
      : await SkillAdapter.installFromClawHub(withGateway, {
        slug: body.slug,
        version: body.version,
        force: body.force,
        source: body.source,
      });
    return jsonResponse(res, 200, { ok: true, data: result });
  }

  if (req.method === "POST" && pathname === "/api/store/skills/uninstall") {
    const body = await parseBody(req);
    if (!body.slug) return jsonResponse(res, 400, { ok: false, error: "slug 不能为空" });
    const result = await SkillAdapter.uninstall(withGateway, { slug: body.slug });
    return jsonResponse(res, 200, { ok: true, data: result });
  }

  if (req.method === "POST" && pathname === "/api/store/skills/update") {
    const body = await parseBody(req);
    if (body.source === "clawhub") {
      const result = await SkillAdapter.updateFromClawHub(withGateway, {
        slug: body.slug,
        all: body.all,
      });
      return jsonResponse(res, 200, { ok: true, data: result });
    }
    // 普通配置更新
    const result = await SkillAdapter.update(withGateway, {
      skillKey: body.skillKey,
      enabled: body.enabled,
      apiKey: body.apiKey,
      env: body.env,
    });
    return jsonResponse(res, 200, { ok: true, data: result });
  }

  if (req.method === "POST" && pathname === "/api/store/skills/install-dep") {
    const body = await parseBody(req);
    if (!body.name || !body.installId) {
      return jsonResponse(res, 400, { ok: false, error: "name 和 installId 不能为空" });
    }
    const result = await SkillAdapter.installDep(withGateway, {
      name: body.name,
      installId: body.installId,
      timeoutMs: body.timeoutMs,
    });
    return jsonResponse(res, 200, { ok: true, data: result });
  }

  // ── Plugins: Registry ──

  if (req.method === "GET" && pathname === "/api/store/plugins/search") {
    const q = ctx.query.get("q") || "";
    const family = ctx.query.get("family") || "";
    const limit = ctx.query.get("limit") || "20";
    const source = resolveSource(ctx.query.get("source"), "plugin");
    if (!q) return jsonResponse(res, 400, { ok: false, error: "q (搜索关键词) 不能为空" });
    if (!source) return jsonResponse(res, 404, { ok: false, error: "仓库源不存在" });
    const results = await RegistryAdapter.searchPackages(q, family, Number(limit), { baseUrl: source.url });
    return jsonResponse(res, 200, results);
  }

  if (req.method === "GET" && pathname.startsWith("/api/store/plugins/detail/")) {
    const name = decodeURIComponent(pathname.slice("/api/store/plugins/detail/".length));
    const source = resolveSource(ctx.query.get("source"), "plugin");
    if (!name) return jsonResponse(res, 400, { ok: false, error: "插件名不能为空" });
    if (!source) return jsonResponse(res, 404, { ok: false, error: "仓库源不存在" });
    const detail = await RegistryAdapter.packageDetail(name, { baseUrl: source.url });
    return jsonResponse(res, 200, detail);
  }

  // ── Plugins: Management ──

  if (req.method === "GET" && pathname === "/api/store/plugins/list") {
    const data = await PluginAdapter.list(withGateway);
    return jsonResponse(res, 200, data);
  }

  if (req.method === "POST" && pathname === "/api/store/plugins/install") {
    const body = await parseBody(req);
    if (!body.spec) return jsonResponse(res, 400, { ok: false, error: "spec (安装来源) 不能为空" });
    const result = await PluginAdapter.install(body.spec);
    return jsonResponse(res, 200, { ok: true, data: result });
  }

  if (req.method === "POST" && pathname === "/api/store/plugins/uninstall") {
    const body = await parseBody(req);
    if (!body.id) return jsonResponse(res, 400, { ok: false, error: "插件 ID 不能为空" });
    const result = await PluginAdapter.uninstall(body.id);
    return jsonResponse(res, 200, { ok: true, data: result });
  }

  if (req.method === "POST" && pathname === "/api/store/plugins/toggle") {
    const body = await parseBody(req);
    if (!body.id || typeof body.enabled !== "boolean") {
      return jsonResponse(res, 400, { ok: false, error: "id 和 enabled (boolean) 不能为空" });
    }
    const result = await PluginAdapter.setEnabled(withGateway, body.id, body.enabled);
    return jsonResponse(res, 200, { ok: true, data: result });
  }

  if (req.method === "POST" && pathname === "/api/store/plugins/config") {
    const body = await parseBody(req);
    if (!body.id || !body.config) {
      return jsonResponse(res, 400, { ok: false, error: "id 和 config 不能为空" });
    }
    const result = await PluginAdapter.updateConfig(withGateway, body.id, body.config);
    return jsonResponse(res, 200, { ok: true, data: result });
  }

  // ── MCP ──

  if (req.method === "GET" && pathname === "/api/store/mcp/capability") {
    const data = await McpAdapter.capability(withGateway);
    return jsonResponse(res, 200, data);
  }

  if (req.method === "GET" && pathname === "/api/store/mcp/list") {
    const data = await McpAdapter.list(withGateway);
    return jsonResponse(res, 200, data);
  }

  if (req.method === "GET" && pathname === "/api/store/mcp/presets") {
    if (ctx.query.get("builtin") === "1") {
      return jsonResponse(res, 200, readMcpPresets());
    }
    const source = resolveSource(ctx.query.get("source") || "builtin-mcp", "mcp");
    if (!source) return jsonResponse(res, 404, { ok: false, error: "MCP 预置源不存在" });
    const presets = source.id === "builtin-mcp" ? readMcpPresets() : await McpPresetAdapter.list(source);
    return jsonResponse(res, 200, presets);
  }

  if (req.method === "POST" && pathname === "/api/store/mcp/set") {
    const body = await parseBody(req);
    if (!body.name || !body.config) {
      return jsonResponse(res, 400, { ok: false, error: "name 和 config 不能为空" });
    }
    const result = await McpAdapter.set(withGateway, body.name, body.config);
    return jsonResponse(res, 200, { ok: true, data: result });
  }

  if (req.method === "POST" && pathname === "/api/store/mcp/remove") {
    const body = await parseBody(req);
    if (!body.name) return jsonResponse(res, 400, { ok: false, error: "MCP server 名称不能为空" });
    const result = await McpAdapter.remove(withGateway, body.name);
    return jsonResponse(res, 200, { ok: true, data: result });
  }

  // ── Sources (仓库源管理) ──

  if (req.method === "GET" && pathname === "/api/store/sources") {
    return jsonResponse(res, 200, readSources());
  }

  if (req.method === "POST" && pathname === "/api/store/sources") {
    const body = await parseBody(req);
    const kind = String(body.kind || "registry");
    const allowedTabs = SOURCE_KIND_ALLOWED_TABS[kind];
    if (!allowedTabs) {
      return jsonResponse(res, 400, { ok: false, error: "不支持的仓库源类型" });
    }
    if (!body.name || !body.url) {
      return jsonResponse(res, 400, { ok: false, error: "name 和 url 不能为空" });
    }
    const sources = readSources();
    const id = body.id || body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (sources.some((s) => s.id === id)) {
      return jsonResponse(res, 409, { ok: false, error: `仓库源 "${id}" 已存在` });
    }
    sources.push(normalizeSourceRecord({
      id,
      name: body.name,
      kind,
      url: body.url,
      tabs: body.tabs,
      ref: body.ref,
      skillsPath: body.skillsPath,
      builtin: false
    }));
    writeSources(sources);
    return jsonResponse(res, 200, { ok: true, data: sources });
  }

  if (req.method === "DELETE" && pathname === "/api/store/sources") {
    const body = await parseBody(req);
    if (!body.id) return jsonResponse(res, 400, { ok: false, error: "仓库源 ID 不能为空" });
    const sources = readSources();
    const target = sources.find((s) => s.id === body.id);
    if (!target) return jsonResponse(res, 404, { ok: false, error: `仓库源 "${body.id}" 未找到` });
    if (target.builtin) {
      return jsonResponse(res, 400, { ok: false, error: "内置仓库源不能删除" });
    }
    const filtered = sources.filter((s) => s.id !== body.id);
    writeSources(filtered);
    return jsonResponse(res, 200, { ok: true, data: filtered });
  }

  // Not matched
  return null;
}
