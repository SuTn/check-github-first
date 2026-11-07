// transport.mjs — 传输层：把"搜仓库/读文件/读树"统一抽象，MCP 与 REST 双实现
//
// MCP 模式：官方远程端点 https://api.githubcopilot.com/mcp/
//   - 协议：MCP Streamable HTTP（POST JSON-RPC，响应可能是 SSE 流）
//   - 工具：search_repositories / get_file_contents / get_repository_tree
// REST 模式：api.github.com（匿名或同一 token）
//   - 匿名搜索限 10 次/分钟/IP；带 token 30 次/分钟
//
// 统一出口（供规划器调用）：
//   searchRepos(query, sort, limit) -> [{full_name, stars, pushed_at, description, language, url, topics}]
//   getTree(owner, repo, ref)      -> [{path, type}]（截断时标记）
//   getFile(owner, repo, path, ref)-> {text, ok, truncated}

import { netFetch, selectEndpoint, EndpointState } from './net.mjs'

const MCP_URL = 'https://api.githubcopilot.com/mcp/'
const API = 'https://api.github.com'
const UA = 'check-github-first/0.1 (prototype)'

// ---------------------------------------------------------------------------
// MCP Streamable HTTP 客户端（最小实现：initialize → tools/call）
// ---------------------------------------------------------------------------

let mcpSessionId = null
let mcpInitialized = false

async function mcpCall(method, params, token) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  }
  if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId
  const res = await netFetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 1e9, method, params }),
  })
  const sid = res.headers.get('mcp-session-id')
  if (sid) mcpSessionId = sid
  if (!res.ok) throw new Error(`MCP ${method} HTTP ${res.status}`)
  // 响应可能是 JSON，也可能是 SSE
  const ctype = res.headers.get('content-type') || ''
  let payload
  if (ctype.includes('text/event-stream')) {
    const text = await res.text()
    const line = text.split('\n').find((l) => l.startsWith('data:'))
    payload = line ? JSON.parse(line.slice(5).trim()) : null
  } else {
    payload = await res.json()
  }
  if (payload && payload.error) throw new Error(`MCP ${method}: ${payload.error.message || JSON.stringify(payload.error)}`)
  return payload?.result ?? payload
}

async function ensureMcp(token) {
  if (mcpInitialized) return
  await mcpCall('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'check-github-first', version: '0.1.0' },
  }, token)
  // notifications/initialized（无 id，服务器不回复）
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  }
  if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId
  await netFetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  mcpInitialized = true
}

async function mcpTool(name, args, token) {
  await ensureMcp(token)
  const result = await mcpCall('tools/call', { name, arguments: args }, token)
  if (result?.isError) throw new Error(`MCP tool ${name} error: ${JSON.stringify(result.content)?.slice(0, 200)}`)
  // content[] 可能含多个 part：
  //   text part = 确认信息（"successfully downloaded..."）或 JSON 载荷
  //   resource part = 文件本体（resource.text / resource.blob）
  // 目录列表：text part 是 JSON 数组。文件：resource part 是本体。
  const parts = result?.content ?? []
  const resource = parts.find((c) => c.type === 'resource')?.resource
  if (resource) {
    if (resource.text) return resource.text
    if (resource.blob) return Buffer.from(resource.blob, 'base64').toString('utf8')
    throw new Error(`MCP ${name}: resource part without text/blob`)
  }
  const textPart = parts.find((c) => c.type === 'text')
  const raw = textPart?.text ?? ''
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try { return JSON.parse(raw) } catch { /* 不是合法 JSON 就原样返回 */ }
  }
  return raw
}

// ---------------------------------------------------------------------------
// REST 实现
// ---------------------------------------------------------------------------

async function restFetch(path, token, accept) {
  const headers = {
    'User-Agent': UA,
    'Accept': accept || 'application/vnd.github+json',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await netFetch(`${API}${path}`, { headers })
  if (res.status === 403 || res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') || '60')
    throw Object.assign(new Error(`REST rate limited (HTTP ${res.status})，retry-after ${retryAfter}s`), { rateLimited: true, retryAfter })
  }
  if (!res.ok) throw new Error(`REST ${path} HTTP ${res.status}`)
  return res.json()
}

// ---------------------------------------------------------------------------
// 统一出口
// ---------------------------------------------------------------------------

function repoRow(item, queryTerms = []) {
  const topics = item.topics || []
  return {
    full_name: item.full_name,
    stars: item.stargazers_count ?? 0,
    // MCP minimal 输出没有 pushed_at，只有 updated_at（语义略宽但够用）
    pushed_at: item.pushed_at || item.updated_at || '',
    description: (item.description || '').slice(0, 200),
    language: item.language || '?',
    url: item.html_url || `https://github.com/${item.full_name}`,
    topics,
    archived: item.archived === true,
    // 词位信号（10 用例测试教训）：词面噪声（diff-so-fancy 因 "fewer defects"
    // 命中 defect detection、google/fonts 因 "issue tracker" 短语命中）靠
    // star 偏置登顶。topics 是维护者手工标注的领域标签，命中权重最高；
    // name 次之（项目名即定位）；description 最弱（营销文案谁都能写）。
    matchTier: matchTierOf(item.full_name, item.description || '', topics, queryTerms),
  }
}

/**
 * 词位分级：3 = 检索词命中 topics；2 = 命中 name；1 = 仅 description；0 = 无词面命中。
 */
function matchTierOf(fullName, description, topics, queryTerms) {
  if (!queryTerms.length) return 0
  const name = fullName.toLowerCase()
  const desc = description.toLowerCase()
  const topicStr = topics.join(' ').toLowerCase()
  for (const t of queryTerms) {
    if (topicStr.includes(t)) return 3
  }
  for (const t of queryTerms) {
    if (name.includes(t)) return 2
  }
  for (const t of queryTerms) {
    if (desc.includes(t)) return 1
  }
  return 0
}

/**
 * 搜仓库。query 支持 GitHub 高级语法；sort: 'stars'|'updated'|'best'。
 * queryTerms：检索词（用于词位分级），从 query 里剥出纯词。
 */
export async function searchRepos(query, sort = 'stars', limit = 30) {
  const { mode, token } = selectEndpoint()
  // 词位分级的检索词提取（R2 教训）：qualifier（topic:boards、language:go、
  // stars:>100）的"值"才是匹配词——旧版把整个 token 剥冒号后变成
  // "topicboards" 这种无意义串，导致 topic: 查询的行 matchTier 全为 0
  // 被误罚 ×0.75（openproject 三通道命中却继承 anchor 行的 tier=0 跌出主区）。
  const queryTerms = query.toLowerCase()
    .split(/\s+/)
    .flatMap((w) => {
      if (w.includes(':')) {
        const v = (w.split(':')[1] || '')
        // stars:>100 / pushed:>2026-xx 这类范围值不是匹配词
        if (v.startsWith('>') || v.startsWith('<')) return []
        return [v.replace(/[^a-z0-9-]/g, '')]
      }
      return [w.replace(/[^a-z0-9-]/g, '')]
    })
    .filter((w) => w.length >= 3)
  if (mode === EndpointState.MCP_REMOTE) {
    const args = { query, minimal_output: true }
    if (sort !== 'best') { args.sort = sort; args.order = 'desc' }
    const out = await mcpTool('search_repositories', args, token)
    // minimal_output：{"total_count":N,"incomplete_results":b,"items":[...]}
    const items = Array.isArray(out) ? out : (out?.items || [])
    return items.slice(0, limit).map((it) => repoRow(it, queryTerms))
  }
  const q = encodeURIComponent(query)
  const s = sort === 'best' ? '' : `&sort=${sort}&order=desc`
  const d = await restFetch(`/search/repositories?q=${q}&per_page=${limit}${s}`, token)
  return (d.items || []).map((it) => repoRow(it, queryTerms))
}

/** 读仓库树。远程 MCP 端点只有 46 个工具（无 get_repository_tree），
 *  用 get_file_contents 读根目录（含 type 列），一层够挑文件用；
 *  深层树降级 REST trees API（匿名可用）。 */
export async function getTree(owner, repo, ref = 'HEAD') {
  const { mode, token } = selectEndpoint()
  // T2 教训：MCP path:"." 只返回根目录一层——monorepo 子包清单（apps/web/package.json）
  // 和深层入口文件全看不见。有 token 时优先走 REST 递归树（一次请求拿全树），
  // MCP 根目录列举仅作无 token 兜底。
  if (token) {
    try {
      const meta = await restFetch(`/repos/${owner}/${repo}`, token)
      const sha = meta.commit?.sha || meta.default_branch
      const d = await restFetch(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, token)
      const tree = (d.tree || []).map((e) => ({ path: e.path, type: e.type }))
      if (tree.length > 0) return tree
    } catch {
      // REST 树失败（私有仓/限流/网络）——落到 MCP 或匿名重试
    }
  }
  if (mode === EndpointState.MCP_REMOTE) {
    try {
      const out = await mcpTool('get_file_contents', { owner, repo, path: '.' }, token)
      if (Array.isArray(out) && out.length > 0 && out[0]?.path !== undefined) {
        return out.map((e) => ({ path: e.path, type: e.type }))
      }
    } catch {
      // 工具缺失/调用失败 —— 降级 REST
    }
  }
  // REST 匿名兜底：默认分支 HEAD 的 sha → 递归树
  const meta = await restFetch(`/repos/${owner}/${repo}`, token)
  const sha = meta.commit?.sha || meta.default_branch
  const d = await restFetch(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, token)
  return (d.tree || []).map((e) => ({ path: e.path, type: e.type }))
}

/** 读单个文件内容（窗口由上层裁剪）。
 *  远程 MCP 不接受 ref:"HEAD"（要具体分支名），不传 ref 走默认分支。 */
export async function getFile(owner, repo, path, ref) {
  const { mode, token } = selectEndpoint()
  if (mode === EndpointState.MCP_REMOTE) {
    const args = { owner, repo, path }
    if (ref && ref !== 'HEAD') args.ref = ref
    const out = await mcpTool('get_file_contents', args, token)
    // mcpTool 已解到 resource.text（字符串）或目录数组
    if (typeof out === 'string') return { text: out, ok: true, truncated: false }
    if (out && typeof out === 'object' && out.content) {
      const text = out.encoding === 'base64' ? Buffer.from(out.content, 'base64').toString('utf8') : String(out.content)
      return { text, ok: true, truncated: false }
    }
    return { text: JSON.stringify(out).slice(0, 2000), ok: true, truncated: false }
  }
  const d = await restFetch(`/repos/${owner}/${repo}/contents/${path}?ref=${ref}`, token, 'application/vnd.github.raw+json')
  if (typeof d === 'string') return { text: d, ok: true, truncated: false }
  // JSON（对象）形态
  const text = d.content ? (d.encoding === 'base64' ? Buffer.from(d.content, 'base64').toString('utf8') : d.content) : ''
  return { text, ok: true, truncated: false }
}

/** 锚点反查：拿参照仓库的元数据（topics/description/language/license），
 *  供查询规划器提取 topic: 种子。1 次请求。 */
export async function getRepoMeta(owner, repo) {
  const { mode, token } = selectEndpoint()
  let d
  if (mode === EndpointState.MCP_REMOTE) {
    // 远程 MCP 没有单一 get_repository 工具，用 REST 更直接（同 token）
    d = await restFetch(`/repos/${owner}/${repo}`, token)
  } else {
    d = await restFetch(`/repos/${owner}/${repo}`, token)
  }
  return {
    full_name: d.full_name,
    description: d.description || '',
    language: d.language || '',
    topics: d.topics || [],
    stars: d.stargazers_count ?? 0,
    license: d.license?.spdx_id || '',
    pushed_at: d.pushed_at || '',
    archived: d.archived === true,
  }
}

export function endpointNote() {
  return selectEndpoint().note
}
