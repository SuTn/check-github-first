// net.mjs — 网络层：代理自动探测 + 端点选择
//
// 设计原则（来自 2026-11-06 实测）：
//  1. 企业/国内环境：浏览器有网但 Node fetch 超时 —— 系统代理在注册表里，
//     Node 默认不读。探测顺序：env -> Windows 注册表（reg query，不拉
//     PowerShell）-> 裸连。
//  2. Windows schannel 会因吊销检查离线失败 (CRYPT_E_REVOCATION_OFFLINE)，
//     Node 的 undici 不走 schannel，通常没这个问题；curl 有。这里用 Node fetch。
//  3. 端点：有 token → 远程 MCP（搜索用）；否则匿名 REST。
//
// 鲁棒性（2026-11-08 修复）：
//  - 所有请求默认 30s 超时（CGF_TIMEOUT_MS 可覆盖），坏代理不会挂到 undici 默认 300s；
//  - ProxyAgent 按代理 URL 缓存复用，不再每次请求新建连接池；
//  - socks5:// 等非 HTTP(S) 代理直接忽略（undici ProxyAgent 只能走 CONNECT，
//    旧实现会拼出 `http://socks5://...` 这种无效 URL）；
//  - 注册表 ProxyServer 的多协议格式 `http=h:p;https=h:p` 会被解析；
//  - 非 Windows 不再尝试 spawn powershell。

import { fetch as undiciFetch, ProxyAgent, getGlobalDispatcher } from 'undici'
import { execSync } from 'node:child_process'

/** 已探测的代理（缓存，避免每次请求都读注册表） */
let cachedProxy = null
let probed = false

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

/**
 * 把各种代理写法归一成 undici ProxyAgent 可用的 URL；不支持则返回 null。
 * 裸 `host:port` 补 http://；socks5 等非 HTTP(S) 协议忽略。
 */
export function normalizeProxy(raw) {
  if (!raw) return null
  let v = String(raw).trim()
  if (!v) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `http://${v}`
  let url
  try {
    url = new URL(v)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  return url.toString().replace(/\/$/, '')
}

/** 从 Windows 注册表读当前用户代理（ProxyEnable=1 才生效）。 */
function readWindowsProxy() {
  if (process.platform !== 'win32') return null
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  try {
    const enabled = execSync(`reg query "${key}" /v ProxyEnable`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled)) return null

    const server = execSync(`reg query "${key}" /v ProxyServer`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = server.match(/ProxyServer\s+REG_SZ\s+(.+)/)
    if (!m) return null
    const raw = m[1].trim()
    if (!raw) return null
    // 多协议格式：http=127.0.0.1:7890;https=127.0.0.1:7890
    if (raw.includes('=')) {
      const map = {}
      for (const part of raw.split(';')) {
        const [k, ...rest] = part.trim().split('=')
        if (k && rest.length) map[k.trim().toLowerCase()] = rest.join('=').trim()
      }
      return map.https || map.http || null
    }
    return raw
  } catch {
    return null
  }
}

/**
 * 探测系统代理。顺序：环境变量（大小写各查）→ Windows 注册表 → null（裸连）。
 * 返回归一化后的 "http://host:port" 或 null。
 */
export function detectProxy() {
  if (probed) return cachedProxy
  probed = true

  for (const key of PROXY_ENV_KEYS) {
    const normalized = normalizeProxy(process.env[key])
    if (normalized) {
      cachedProxy = normalized
      return cachedProxy
    }
  }

  cachedProxy = normalizeProxy(readWindowsProxy())
  return cachedProxy
}

/** 单测/嵌入场景重置探测缓存。 */
export function resetProxyCache() {
  cachedProxy = null
  probed = false
}

export const DEFAULT_TIMEOUT_MS = (() => {
  const n = Number(process.env.CGF_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : 30000
})()

/** ProxyAgent 按代理 URL 复用（保持连接池）。 */
const proxyAgents = new Map()
function agentFor(proxy) {
  if (!proxyAgents.has(proxy)) proxyAgents.set(proxy, new ProxyAgent(proxy))
  return proxyAgents.get(proxy)
}

/**
 * 关闭所有 undici 连接池，供 CLI 结尾自然退出（避免 keep-alive 拖住进程）。
 * 不要依赖 process.exit——Windows 上 fetch 失败后立刻 exit 会触发 libuv 断言。
 */
export async function closeNet() {
  const agents = [...proxyAgents.values()]
  proxyAgents.clear()
  await Promise.all([
    ...agents.map((a) => a.close().catch(() => {})),
    getGlobalDispatcher().close().catch(() => {}),
  ])
}

/**
 * 带代理与超时的 fetch。undici 的 ProxyAgent 走 CONNECT 隧道。
 * options.timeoutMs 可覆盖单次超时；显式传 signal 时不覆盖。
 */
export async function netFetch(url, options = {}) {
  const { timeoutMs, ...rest } = options
  const proxy = detectProxy()
  const init = { ...rest }
  if (proxy && !init.dispatcher) init.dispatcher = agentFor(proxy)
  if (!init.signal) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS
    init.signal = AbortSignal.timeout(ms)
  }
  return undiciFetch(url, init)
}

/** 端点状态。 */
export const EndpointState = {
  MCP_REMOTE: 'mcp-remote', // 官方远程 MCP，需 token
  REST_ANON: 'rest-anon', // 匿名 REST 降级
}

let endpointMode = null

/**
 * 选择端点：有 GITHUB_TOKEN（或 GH_TOKEN）→ 远程 MCP（搜索、MCP 兜底）；
 * 否则匿名 REST。树/文件/元数据始终走 REST（同一 token 时配额更宽，
 * 且返回字段更全——MCP 的 minimal 输出可能缺 topics/pushed_at）。
 */
export function selectEndpoint() {
  if (endpointMode) return endpointMode
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  endpointMode = {
    mode: token ? EndpointState.MCP_REMOTE : EndpointState.REST_ANON,
    token,
    note: token
      ? '官方远程 MCP 端点（api.githubcopilot.com/mcp/）；树/文件/元数据走同一 token 的 REST'
      : '匿名 REST 降级（api.github.com，10 搜索/分钟/IP）——设置 GITHUB_TOKEN 可启用远程 MCP 端点',
  }
  return endpointMode
}

/** 单测用：重置端点缓存。 */
export function resetEndpointCache() {
  endpointMode = null
}
