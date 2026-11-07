// net.mjs — 网络层：代理自动探测 + 三态端点选择
//
// 设计原则（来自 2026-11-06 实测）：
//  1. 企业/国内环境：浏览器有网但 Node fetch 超时 —— 系统代理在注册表里，
//     Node 默认不读。必须自己探测：env -> Windows 注册表 -> 裸连。
//  2. Windows schannel 会因吊销检查离线失败 (CRYPT_E_REVOCATION_OFFLINE)，
//     Node 的 undici 不走 schannel，通常没这个问题；curl 有。这里用 Node fetch。
//  3. 端点三态：官方远程 MCP（api.githubcopilot.com/mcp/）需要 token；
//     没有 token 时降级直连 REST（api.github.com，匿名 10 搜索/分钟/IP）。

import { fetch as undiciFetch } from 'undici'
import { execSync } from 'node:child_process'

/** 已探测的代理（缓存，避免每次请求都读注册表） */
let cachedProxy = null
let probed = false

/**
 * 探测系统代理。
 * 顺序：环境变量（大小写各查）→ Windows 注册表 ProxyServer → null（裸连）。
 * 返回 "http://host:port" 或 null。
 */
export function detectProxy() {
  if (probed) return cachedProxy
  probed = true

  // 1. 环境变量
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = process.env[key]
    if (v && v.trim()) {
      cachedProxy = v.trim().startsWith('http') ? v.trim() : `http://${v.trim()}`
      return cachedProxy
    }
  }

  // 2. Windows 注册表（当前用户 Internet Settings）
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings').ProxyServer"`,
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
    const enabled = execSync(
      `powershell -NoProfile -Command "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings').ProxyEnable"`,
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
    if (enabled === '1' && out && !out.startsWith('ERROR') && out.length < 100) {
      cachedProxy = out.startsWith('http') ? out : `http://${out}`
      return cachedProxy
    }
  } catch {
    // 非 Windows 或 PowerShell 不可用 —— 裸连
  }

  cachedProxy = null
  return null
}

/**
 * 带代理的 fetch。undici 的 ProxyAgent 走 CONNECT 隧道。
 * 同时禁用证书吊销检查不需要 —— undici 用 OpenSSL，不依赖 Windows schannel。
 */
export async function netFetch(url, options = {}) {
  const proxy = detectProxy()
  const init = { ...options }
  if (proxy && !init.dispatcher) {
    const { ProxyAgent } = await import('undici')
    init.dispatcher = new ProxyAgent(proxy)
  }
  return undiciFetch(url, init)
}

/** 三态端点状态。 */
export const EndpointState = {
  MCP_REMOTE: 'mcp-remote',   // 官方远程 MCP，需 token
  REST_ANON: 'rest-anon',     // 匿名 REST 降级
}

let endpointMode = null

/**
 * 选择端点：有 GITHUB_TOKEN（或 GH_TOKEN）→ 远程 MCP；否则匿名 REST。
 * 返回 { mode, token, note }。
 */
export function selectEndpoint() {
  if (endpointMode) return endpointMode
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  endpointMode = {
    mode: token ? EndpointState.MCP_REMOTE : EndpointState.REST_ANON,
    token,
    note: token
      ? '官方远程 MCP 端点（api.githubcopilot.com/mcp/）'
      : '匿名 REST 降级（api.github.com，10 搜索/分钟/IP）——设置 GITHUB_TOKEN 可启用远程 MCP 端点',
  }
  return endpointMode
}
