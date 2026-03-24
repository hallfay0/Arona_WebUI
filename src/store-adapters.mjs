/**
 * Store Adapters — 扩展中心后端适配层
 *
 * 四个 adapter，每种组件用最合适的通道：
 * - SkillAdapter:    gateway RPC (skills.install/update/status)
 * - PluginAdapter:   execFile CLI --json + config.patch
 * - McpAdapter:      config.get/patch (mcp.servers)
 * - RegistryAdapter: 代理 ClawHub REST API
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REGISTRY_BASE_URL = (
  process.env.OPENCLAW_CLAWHUB_URL ||
  process.env.CLAWHUB_URL ||
  "https://clawhub.ai"
).replace(/\/+$/, "");
const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_RAW_BASE_URL = "https://raw.githubusercontent.com";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_LOCAL_SKILLS_DIR = path.resolve(__dirname, "..", "..", "openclaw-repo", "skills");
const OPENCLAW_SKILLS_DIR = process.env.OPENCLAW_SKILLS_DIR || (fs.existsSync(DEFAULT_LOCAL_SKILLS_DIR) ? DEFAULT_LOCAL_SKILLS_DIR : "");

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const CLI_TIMEOUT_MS = 15_000;

// ── Helpers ──────────────────────────────────────────────────────

// ── ClawHub API 缓存 (5 分钟 TTL) ──
const _apiCache = new Map();
const _inFlightCache = new Map();
const API_CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedOrNull(key) {
  const entry = _apiCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > API_CACHE_TTL_MS) {
    _apiCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  _apiCache.set(key, { data, ts: Date.now() });
  // 限制缓存大小
  if (_apiCache.size > 100) {
    const oldest = _apiCache.keys().next().value;
    _apiCache.delete(oldest);
  }
}

function getHeaderValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withInFlightCache(key, loader) {
  if (_inFlightCache.has(key)) {
    return _inFlightCache.get(key);
  }
  const promise = Promise.resolve()
    .then(loader)
    .finally(() => {
      _inFlightCache.delete(key);
    });
  _inFlightCache.set(key, promise);
  return promise;
}

function getRetryDelayMs(result, attempt) {
  const retryAfter = Number.parseInt(getHeaderValue(result?.headers, "retry-after"), 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }

  const rateReset = Number.parseInt(getHeaderValue(result?.headers, "x-ratelimit-reset"), 10);
  if (Number.isFinite(rateReset) && rateReset > 0) {
    const delay = rateReset * 1000 - Date.now();
    if (delay > 0) {
      return Math.min(delay, 15_000);
    }
  }

  return Math.min(1500 * (attempt + 1), 10_000);
}

async function requestUrlRawWithRetry(parsedUrl, headers, { retries = 1 } = {}) {
  let attempt = 0;
  while (true) {
    const result = await requestUrlRaw(parsedUrl, headers);
    const rateLimited = result.statusCode === 429
      || (result.statusCode === 403 && getHeaderValue(result.headers, "x-ratelimit-remaining") === "0");
    if (!rateLimited || attempt >= retries) {
      return result;
    }
    await sleep(getRetryDelayMs(result, attempt));
    attempt += 1;
  }
}

function requestUrlRaw(parsedUrl, headers = { Accept: "application/json" }) {
  const transport = parsedUrl.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.get(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: { "User-Agent": "Arona-WebUI-Store/1.0", ...headers },
        timeout: 15_000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return requestUrlRaw(new URL(res.headers.location), headers).then(resolve, reject);
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("ClawHub API request timeout")); });
  });
}

async function clawHubFetch(urlPath, query = {}, { baseUrl } = {}) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(query).filter(([, v]) => v != null && v !== ""))
  ).toString();
  const fullPath = qs ? `${urlPath}?${qs}` : urlPath;
  const resolvedBaseUrl = String(baseUrl || DEFAULT_REGISTRY_BASE_URL).replace(/\/+$/, "");
  const cacheKey = `${resolvedBaseUrl}::${fullPath}`;

  // 检查缓存
  const cached = getCachedOrNull(cacheKey);
  if (cached) return cached;

  const parsed = new URL(fullPath, resolvedBaseUrl);
  let result = await requestUrlRaw(parsed);

  // 429 重试：等 2 秒后重试一次
  if (result.statusCode === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    result = await requestUrlRaw(parsed);
  }

  if (result.statusCode >= 400) {
    throw new Error(`ClawHub API ${result.statusCode}: ${result.body.toString("utf8").slice(0, 200)}`);
  }

  try {
    const data = JSON.parse(result.body.toString("utf8"));
    setCache(cacheKey, data);
    return data;
  } catch {
    throw new Error("ClawHub API: invalid JSON response");
  }
}

async function fetchJson(url, headers = {}) {
  const parsed = new URL(url);
  const result = await requestUrlRawWithRetry(parsed, { Accept: "application/json", ...headers }, { retries: 2 });
  if (result.statusCode >= 400) {
    throw new Error(`请求失败 ${result.statusCode}: ${result.body.toString("utf8").slice(0, 200)}`);
  }
  return JSON.parse(result.body.toString("utf8"));
}

function normalizeRepoPath(repoPath = "") {
  return String(repoPath || "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

function parseGitHubRepoUrl(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("GitHub 仓库地址不能为空");

  if (/^[^/]+\/[^/]+$/.test(value)) {
    const [owner, repo] = value.split("/");
    return { owner, repo: repo.replace(/\.git$/i, "") };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("GitHub 仓库地址格式不正确");
  }

  if (!/github\.com$/i.test(parsed.hostname)) {
    throw new Error("目前只支持 github.com 仓库地址");
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error("GitHub 仓库地址需要包含 owner/repo");
  }
  return {
    owner: segments[0],
    repo: segments[1].replace(/\.git$/i, "")
  };
}

function parseSkillMarkdown(markdown, slug) {
  const text = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const titleLine = lines.find((line) => /^#\s+/.test(line.trim())) || "";
  const displayName = titleLine.replace(/^#\s+/, "").trim() || slug;
  const summaryLine = lines.find((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("```") && !trimmed.startsWith("---");
  }) || "";

  return {
    slug,
    displayName,
    summary: summaryLine.trim(),
    description: text.trim()
  };
}

function getGitHubSourceCacheKey(source, suffix) {
  return `github-source::${source.url}::${source.ref || "main"}::${source.skillsPath || "skills"}::${suffix}`;
}

async function githubApiFetch(apiPath) {
  const parsed = new URL(apiPath, GITHUB_API_BASE_URL);
  return fetchJson(parsed.toString(), {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  });
}

async function githubListDirectory(source, repoPath) {
  const { owner, repo } = parseGitHubRepoUrl(source.url);
  const normalizedPath = normalizeRepoPath(repoPath);
  const query = new URLSearchParams();
  if (source.ref) query.set("ref", source.ref);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const cacheKey = getGitHubSourceCacheKey(source, `dir:${normalizedPath}`);
  const cached = getCachedOrNull(cacheKey);
  if (cached) return cached;

  return withInFlightCache(cacheKey, async () => {
    const result = await githubApiFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${normalizedPath}${suffix}`);
    setCache(cacheKey, result);
    return result;
  });
}

async function githubReadFile(source, repoPath) {
  const { owner, repo } = parseGitHubRepoUrl(source.url);
  const normalizedPath = normalizeRepoPath(repoPath);
  const ref = encodeURIComponent(source.ref || "main");
  const rawUrl = `${GITHUB_RAW_BASE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${ref}/${normalizedPath}`;
  const cacheKey = getGitHubSourceCacheKey(source, `file:${normalizedPath}`);
  const cached = getCachedOrNull(cacheKey);
  if (typeof cached === "string") {
    return { buffer: Buffer.from(cached, "utf8"), data: null };
  }

  return withInFlightCache(cacheKey, async () => {
    const result = await requestUrlRawWithRetry(new URL(rawUrl), { Accept: "text/plain" }, { retries: 2 });
    if (result.statusCode >= 400) {
      throw new Error(`GitHub 文件读取失败 ${result.statusCode}: ${normalizedPath}`);
    }
    const text = result.body.toString("utf8");
    setCache(cacheKey, text);
    return { buffer: Buffer.from(text, "utf8"), data: null };
  });
}

async function listGitHubSkills(source) {
  const cacheKey = getGitHubSourceCacheKey(source, "list");
  const cached = getCachedOrNull(cacheKey);
  if (cached) return cached;

  return withInFlightCache(cacheKey, async () => {
    const skillsRoot = normalizeRepoPath(source.skillsPath || "skills");
    const entries = await githubListDirectory(source, skillsRoot);
    const dirs = Array.isArray(entries) ? entries.filter((entry) => entry?.type === "dir") : [];

    const items = [];
    for (const entry of dirs) {
      const slug = String(entry.name || "").trim();
      if (!slug) continue;
      try {
        const { buffer } = await githubReadFile(source, `${skillsRoot}/${slug}/SKILL.md`);
        items.push({
          ...parseSkillMarkdown(buffer.toString("utf8"), slug),
          sourceRepo: source.url
        });
      } catch {
        // Ignore directories without a readable SKILL.md
      }
    }

    setCache(cacheKey, items);
    return items;
  });
}

async function resolveSkillInstallRoot(withGateway) {
  try {
    const status = await withGateway((gw) => gw.request("skills.status", {}));
    const skills = Array.isArray(status?.skills) ? status.skills : [];
    const inferredFile = skills.find((skill) => skill?.filePath && !skill?.bundled)?.filePath;
    if (inferredFile) {
      return path.dirname(path.dirname(inferredFile));
    }
  } catch {
    // ignore inference errors and fall back to local defaults
  }

  if (OPENCLAW_SKILLS_DIR) return OPENCLAW_SKILLS_DIR;
  throw new Error("未找到本地 skills 目录，请设置 OPENCLAW_SKILLS_DIR");
}

async function copyGitHubDirectoryToLocal(source, repoPath, destDir) {
  const entries = await githubListDirectory(source, repoPath);
  if (!Array.isArray(entries)) {
    throw new Error(`GitHub 路径不是目录: ${repoPath}`);
  }

  await mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    const targetPath = path.join(destDir, entry.name);
    if (entry.type === "dir") {
      await copyGitHubDirectoryToLocal(source, entry.path, targetPath);
    } else if (entry.type === "file") {
      const { buffer } = await githubReadFile(source, entry.path);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, buffer);
    }
  }
}

function execCli(args, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      OPENCLAW_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr?.trim() || stdout?.trim() || error.message;
          return reject(new Error(message));
        }
        resolve(stdout);
      }
    );
  });
}

function parseCliJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// ── SkillAdapter ─────────────────────────────────────────────────

export const SkillAdapter = {
  /** 列出已安装技能状态（gateway RPC） */
  async status(withGateway) {
    return withGateway((gw) => gw.request("skills.status", {}));
  },

  /** 从 ClawHub 安装技能（gateway RPC） */
  async installFromClawHub(withGateway, { slug, version, force, source }) {
    return withGateway((gw) =>
      gw.request("skills.install", {
        source: source || "clawhub",
        slug,
        ...(version ? { version } : {}),
        ...(force ? { force: true } : {}),
        timeoutMs: CLI_TIMEOUT_MS,
      })
    );
  },

  /** 从 GitHub skills 仓库安装技能 */
  async installFromGitHub(withGateway, source, { slug }) {
    const installRoot = await resolveSkillInstallRoot(withGateway);
    const skillRoot = normalizeRepoPath(source.skillsPath || "skills");
    const targetDir = path.join(installRoot, slug);
    await rm(targetDir, { recursive: true, force: true });
    await copyGitHubDirectoryToLocal(source, `${skillRoot}/${slug}`, targetDir);
    return {
      ok: true,
      installed: targetDir,
      source: source.url,
      ref: source.ref || "main"
    };
  },

  /** 安装技能依赖（gateway RPC，原有逻辑） */
  async installDep(withGateway, { name, installId, timeoutMs }) {
    return withGateway((gw) =>
      gw.request("skills.install", {
        name,
        installId,
        timeoutMs: timeoutMs || 120_000,
      })
    );
  },

  /** 更新技能配置（gateway RPC） */
  async update(withGateway, params) {
    return withGateway((gw) => gw.request("skills.update", params));
  },

  /** 从 ClawHub 更新技能（gateway RPC） */
  async updateFromClawHub(withGateway, { slug, all }) {
    return withGateway((gw) =>
      gw.request("skills.update", {
        source: "clawhub",
        ...(all ? { all: true } : { slug }),
      })
    );
  },

  /** 卸载技能 — 通过 gateway 获取 workspaceDir 后删除文件 */
  async uninstall(withGateway, { slug }) {
    const status = await this.status(withGateway);
    const skill = status?.skills?.find(
      (s) => s.skillKey === slug || s.name === slug
    );
    if (!skill || !skill.filePath) {
      throw new Error(`技能 "${slug}" 未找到或无法确定安装路径`);
    }
    if (skill.bundled) {
      throw new Error(`内置技能 "${slug}" 不支持卸载`);
    }
    // Skill filePath points to SKILL.md, parent dir is the skill directory
    const { dirname } = await import("node:path");
    const skillDir = dirname(skill.filePath);

    const { rm } = await import("node:fs/promises");
    await rm(skillDir, { recursive: true, force: true });
    return { ok: true, removed: skillDir };
  },
};

// ── PluginAdapter ────────────────────────────────────────────────

export const PluginAdapter = {
  /** 列出已安装插件（config.get 读取配置） */
  async list(withGateway) {
    return withGateway(async (gw) => {
      const config = await gw.request("config.get", {});
      const entries = config?.parsed?.plugins?.entries || {};
      const installs = config?.parsed?.plugins?.installs || {};
      const plugins = [];
      // Merge entries and installs info
      const allIds = new Set([...Object.keys(entries), ...Object.keys(installs)]);
      for (const id of allIds) {
        const entry = entries[id] || {};
        const install = installs[id] || {};
        const configSchema =
          install.configSchema ||
          install.ui?.configSchema ||
          install.meta?.configSchema ||
          null;
        plugins.push({
          id,
          name: install.name || id,
          packageName: install.packageName || install.package || install.name || id,
          description: install.description || "",
          version: install.version || "",
          enabled: entry.enabled !== false,
          status: entry.enabled === false ? "disabled" : "loaded",
          source: install.source || "unknown",
          config: entry.config && typeof entry.config === "object" ? entry.config : {},
          configSchema,
          uiHints: install.uiHints || install.ui?.hints || install.meta?.uiHints || null,
          author: install.author || install.ownerHandle || "",
          homepage: install.homepage || install.repository || "",
        });
      }
      return plugins;
    });
  },

  /** 安装插件（CLI） */
  async install(spec) {
    const stdout = await execCli(["plugins", "install", spec]);
    return { ok: true, output: stdout.trim() };
  },

  /** 卸载插件（CLI） */
  async uninstall(id) {
    const stdout = await execCli(["plugins", "uninstall", id, "--force"]);
    return { ok: true, output: stdout.trim() };
  },

  /** 启用/禁用插件（config.patch） */
  async setEnabled(withGateway, id, enabled) {
    return withGateway(async (gw) => {
      const snapshot = await gw.request("config.get", {});
      const baseHash = snapshot?.hash || snapshot?.baseHash;
      return gw.request("config.patch", {
        raw: JSON.stringify({ plugins: { entries: { [id]: { enabled } } } }),
        baseHash,
        note: `Store: ${enabled ? "enable" : "disable"} plugin ${id}`,
      });
    });
  },

  /** 更新插件配置（config.patch） */
  async updateConfig(withGateway, id, config) {
    return withGateway(async (gw) => {
      const snapshot = await gw.request("config.get", {});
      const baseHash = snapshot?.hash || snapshot?.baseHash;
      return gw.request("config.patch", {
        raw: JSON.stringify({ plugins: { entries: { [id]: { config } } } }),
        baseHash,
        note: `Store: update plugin config for ${id}`,
      });
    });
  },
};

// ── McpAdapter ───────────────────────────────────────────────────

export const McpAdapter = {
  async capability(withGateway) {
    try {
      await withGateway((gw) => gw.request("config.schema.lookup", { path: "mcp" }));
      return { supported: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        supported: false,
        error: "当前连接的 OpenClaw 网关版本不支持 MCP 配置管理，通常需要 2026-03-16 之后的版本。",
        detail: message
      };
    }
  },

  async ensureSupported(withGateway) {
    const capability = await this.capability(withGateway);
    if (!capability.supported) {
      throw new Error(capability.error);
    }
  },

  /** 列出已配置的 MCP servers（config.get） */
  async list(withGateway) {
    await this.ensureSupported(withGateway);
    return withGateway(async (gw) => {
      const config = await gw.request("config.get", {});
      const servers = config?.parsed?.mcp?.servers || {};
      return { servers };
    });
  },

  /** 添加或更新 MCP server（config.patch） */
  async set(withGateway, name, serverConfig) {
    await this.ensureSupported(withGateway);
    return withGateway(async (gw) => {
      const snapshot = await gw.request("config.get", {});
      const baseHash = snapshot?.hash || snapshot?.baseHash;
      return gw.request("config.patch", {
        raw: JSON.stringify({ mcp: { servers: { [name]: serverConfig } } }),
        baseHash,
        note: `Store: set MCP server ${name}`,
      });
    });
  },

  /** 删除 MCP server（config.patch with null tombstone） */
  async remove(withGateway, name) {
    await this.ensureSupported(withGateway);
    return withGateway(async (gw) => {
      const snapshot = await gw.request("config.get", {});
      const baseHash = snapshot?.hash || snapshot?.baseHash;
      return gw.request("config.patch", {
        raw: JSON.stringify({ mcp: { servers: { [name]: null } } }),
        baseHash,
        note: `Store: remove MCP server ${name}`,
      });
    });
  },
};

// ── RegistryAdapter ──────────────────────────────────────────────

export const RegistryAdapter = {
  /** 搜索 ClawHub 技能 */
  async searchSkills(query, limit = 20, options = {}) {
    const data = await clawHubFetch("/api/v1/search", { q: query, limit: String(limit) }, options);
    return data?.results || [];
  },

  /** 列出 ClawHub 技能 */
  async listSkills(limit = 50, options = {}) {
    const data = await clawHubFetch("/api/v1/skills", { limit: String(limit) }, options);
    return data?.items || [];
  },

  /** ClawHub 技能详情 */
  async skillDetail(slug, options = {}) {
    return clawHubFetch(`/api/v1/skills/${encodeURIComponent(slug)}`, {}, options);
  },

  /** 搜索 ClawHub 插件包 */
  async searchPackages(query, family, limit = 20, options = {}) {
    const families = String(family || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (families.length <= 1) {
      return clawHubFetch("/api/v1/packages/search", {
        q: query,
        ...(families[0] ? { family: families[0] } : {}),
        limit: String(limit),
      }, options);
    }

    const responses = await Promise.all(
      families.map((entry) => clawHubFetch("/api/v1/packages/search", {
        q: query,
        family: entry,
        limit: String(limit),
      }, options))
    );
    const merged = [];
    const seen = new Set();
    for (const response of responses) {
      const results = Array.isArray(response?.results) ? response.results : [];
      for (const item of results) {
        const pkg = item?.package || item;
        const key = String(pkg?.name || pkg?.displayName || "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }
    return { results: merged };
  },

  /** ClawHub 插件包详情 */
  async packageDetail(name, options = {}) {
    return clawHubFetch(`/api/v1/packages/${encodeURIComponent(name)}`, {}, options);
  },
};

export const GitHubSkillsAdapter = {
  async listSkills(source) {
    return listGitHubSkills(source);
  },

  async searchSkills(source, query, limit = 20) {
    const keyword = String(query || "").trim().toLowerCase();
    const items = await listGitHubSkills(source);
    if (!keyword) return items.slice(0, limit);
    return items
      .filter((item) => [item.slug, item.displayName, item.summary]
        .some((value) => String(value || "").toLowerCase().includes(keyword)))
      .slice(0, limit);
  },

  async skillDetail(source, slug) {
    const items = await listGitHubSkills(source);
    const existing = items.find((item) => item.slug === slug);
    if (existing) return existing;
    const skillRoot = normalizeRepoPath(source.skillsPath || "skills");
    const { buffer } = await githubReadFile(source, `${skillRoot}/${slug}/SKILL.md`);
    return {
      ...parseSkillMarkdown(buffer.toString("utf8"), slug),
      sourceRepo: source.url
    };
  }
};

export const McpPresetAdapter = {
  async list(source) {
    if (!source?.url) return [];
    const cacheKey = `mcp-presets::${source.id || source.url}`;
    const cached = getCachedOrNull(cacheKey);
    if (cached) return cached;
    const data = await fetchJson(source.url);
    const presets = Array.isArray(data) ? data : [];
    setCache(cacheKey, presets);
    return presets;
  }
};
