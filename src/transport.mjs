// transport.mjs — 传输层：把"搜仓库/读文件/读树"统一抽象，MCP 与 REST 双实现
//
// MCP 模式（需 token）：官方远程端点 https://api.githubcopilot.com/mcp/
//   - 协议：MCP Streamable HTTP（POST JSON-RPC，响应可能是 SSE 流）
//   - 用途：search_repositories；get_file_contents 作 REST 失败时的兜底
// REST 模式：api.github.com（匿名或同一 token）
//   - 匿名搜索限 10 次/分钟/IP；带 token 30 次/分钟
//   - 树/文件/元数据统一走 REST：字段更全（topics/pushed_at），配额更宽
//
// 统一出口（供规划器调用）：
//   searchRepos(query, sort, limit) -> [{full_name, stars, pushed_at, description, language, url, topics, matchTier}]
//   getTree(owner, repo)            -> [{path, type}] + .truncated / .requests
//   getFile(owner, repo, path, ref) -> {text, ok, truncated}
//   getRepoMeta(owner, repo)        -> {full_name, description, topics, ...}

import { readFileSync } from 'node:fs'
import { netFetch, selectEndpoint, EndpointState, DEFAULT_TIMEOUT_MS } from './net.mjs'

const MCP_URL = 'https://api.githubcopilot.com/mcp/'
const API = 'https://api.github.com'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const UA = `check-github-first/${pkg.version}`

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
  if (!res.ok) {
    // 429 必须带 rateLimited 标记：scout 靠它决定"立即停止后续搜索"
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || '60')
      throw Object.assign(new Error(`MCP 限流（HTTP 429），retry-after ${retryAfter}s`), {
        rateLimited: true,
        retryAfter,
      })
    }
    throw new Error(`MCP ${method} HTTP ${res.status}`)
  }
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
    clientInfo: { name: 'check-github-first', version: pkg.version },
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

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function restFetch(path, token, timeoutMs) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/vnd.github+json',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await netFetch(`${API}${path}`, { headers, timeoutMs })
  const text = await res.text()

  if (res.status === 403 || res.status === 429) {
    const body = parseJson(text)
    const remaining = res.headers.get('x-ratelimit-remaining')
    const rateLimited = res.status === 429 || remaining === '0' || /rate limit/i.test(body?.message || '')
    if (rateLimited) {
      const retryAfter = Number(res.headers.get('retry-after') || '60')
      throw Object.assign(new Error(`REST 限流（HTTP ${res.status}），retry-after ${retryAfter}s`), {
        rateLimited: true,
        retryAfter,
      })
    }
    // 403 不一定是限流：大文件 contents API 会以 403 + message 返回
    throw new Error(`REST ${path} HTTP 403: ${(body?.message || text.slice(0, 120)).trim()}`)
  }
  if (!res.ok) throw new Error(`REST ${path} HTTP ${res.status}`)
  if (!text) return null
  const data = parseJson(text)
  if (data === null) throw new Error(`REST ${path} 返回非 JSON 响应（${text.slice(0, 80)}）`)
  return data
}

// ---------------------------------------------------------------------------
// 统一出口
// ---------------------------------------------------------------------------

/** 不是语义匹配词的 qualifier：过滤器/范围限定，不能进 matchTier 打分。
 *  （旧实现把 license:mit → "mit"、language:typescript → "typescript" 一起
 *  塞进词位判断——仓库描述里含 "commit" 就因 "mit" 拿到 tier 加成。） */
const NON_SEMANTIC_QUALIFIERS = new Set([
  'language', 'license', 'stars', 'pushed', 'created', 'updated', 'size',
  'followers', 'forks', 'fork', 'archived', 'in', 'user', 'org', 'repo',
  'is', 'mirror', 'template', 'good-first-issues', 'help-wanted-issues',
])

/**
 * 从查询串提取词位分级用的语义词：裸词 + topic:/topics: 的值；
 * 其它 qualifier（language/license/stars/pushed/...）一律丢弃。
 */
export function extractQueryTerms(query) {
  const out = []
  for (const raw of String(query || '').toLowerCase().split(/\s+/)) {
    if (!raw) continue
    if (raw.includes(':')) {
      const idx = raw.indexOf(':')
      const key = raw.slice(0, idx)
      const value = raw.slice(idx + 1)
      if (!value || value.startsWith('>') || value.startsWith('<')) continue
      if (key === 'topic' || key === 'topics') {
        out.push(value.replace(/[^a-z0-9-]/g, ''))
      } else if (NON_SEMANTIC_QUALIFIERS.has(key)) {
        continue
      } else {
        out.push(value.replace(/[^a-z0-9-]/g, ''))
      }
      continue
    }
    out.push(raw.replace(/[^a-z0-9-]/g, ''))
  }
  return [...new Set(out.filter((w) => w.length >= 3))]
}

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
export function matchTierOf(fullName, description, topics, queryTerms) {
  if (!queryTerms || queryTerms.length === 0) return 0
  const name = String(fullName || '').toLowerCase()
  const desc = String(description || '').toLowerCase()
  const topicStr = (topics || []).join(' ').toLowerCase()
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
 * queryTerms：检索词（用于词位分级），从 query 里剥出纯语义词。
 */
export async function searchRepos(query, sort = 'stars', limit = 30) {
  const { mode, token } = selectEndpoint()
  const queryTerms = extractQueryTerms(query)
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
  return (d?.items || []).map((it) => repoRow(it, queryTerms))
}

/** 读仓库树。优先 REST 递归树（1 次请求拿全树，可能被 GitHub 截断）；
 *  HEAD 不被接受时退回「元数据 + 树」两步；带 token 时 MCP 根目录仅作兜底。
 *  返回的数组带 .truncated / .requests 两个附加属性（供预算与诚实展示）。 */
export async function getTree(owner, repo) {
  const { mode, token } = selectEndpoint()
  let lastErr = null
  // 大仓库（nodejs/node 全树 19MB）的树请求单独放宽超时：取 90s 与全局默认的较大者
  //（CGF_TIMEOUT_MS 设得更大时仍然生效），其余请求仍用全局默认
  const TREE_TIMEOUT_MS = Math.max(90000, DEFAULT_TIMEOUT_MS)

  // 1) 单请求递归树：/git/trees/{tree_sha} 接受分支名/HEAD
  try {
    const d = await restFetch(`/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, token, TREE_TIMEOUT_MS)
    const tree = (d?.tree || []).map((e) => ({ path: e.path, type: e.type }))
    if (tree.length > 0) {
      tree.truncated = d?.truncated === true
      tree.requests = 1
      return tree
    }
    lastErr = new Error('空仓库：没有可读文件')
  } catch (e) {
    lastErr = e
    if (e.rateLimited) throw e
  }

  // 2) 两步兜底：先取默认分支，再取树（HEAD 解析失败/默认分支不是 HEAD 的场景）
  try {
    const meta = await restFetch(`/repos/${owner}/${repo}`, token)
    const ref = meta?.default_branch || meta?.commit?.sha
    if (ref) {
      const d = await restFetch(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, token, TREE_TIMEOUT_MS)
      const tree = (d?.tree || []).map((e) => ({ path: e.path, type: e.type }))
      if (tree.length > 0) {
        tree.truncated = d?.truncated === true
        tree.requests = 2
        return tree
      }
    }
    lastErr = new Error('仓库为空或默认分支没有文件')
  } catch (e) {
    lastErr = e
    if (e.rateLimited) throw e
  }

  // 3) MCP 根目录兜底（只一层；仅在 token 模式且 REST 树不可用时）。
  // 诚实性：这一层不等于完整树——必须标记 truncated，让上层如实告知
  //「只看到根目录」，而不是冒充全树（2026-11-09：nodejs/node 19MB 树
  // 在默认 30s 超时下超时，兜底返回的 51 项曾被当成完整树展示）。
  if (mode === EndpointState.MCP_REMOTE) {
    try {
      const out = await mcpTool('get_file_contents', { owner, repo, path: '.' }, token)
      if (Array.isArray(out) && out.length > 0 && out[0]?.path !== undefined) {
        const tree = out.map((e) => ({ path: e.path, type: e.type }))
        tree.truncated = true
        tree.rootOnly = true
        tree.requests = 1
        return tree
      }
    } catch {
      // 工具缺失/调用失败 —— 保留 lastErr
    }
  }
  throw lastErr || new Error(`读不到 ${owner}/${repo} 的目录树`)
}

/** contents API 路径。ref 缺省/HEAD 时不要拼 `?ref=undefined`——那会让
 *  GitHub 直接返 500（旧实现匿名深读必挂的根因）。 */
export function contentsPath(owner, repo, path, ref) {
  const suffix = ref && ref !== 'HEAD' ? `?ref=${encodeURIComponent(ref)}` : ''
  const encoded = String(path).split('/').map(encodeURIComponent).join('/')
  return `/repos/${owner}/${repo}/contents/${encoded}${suffix}`
}

/** 读单个文件内容（窗口由上层裁剪）。REST JSON 形态优先：
 *  不再请求 raw media type——那会让 res.json() 抛 SyntaxError。 */
export async function getFile(owner, repo, path, ref) {
  const { mode, token } = selectEndpoint()
  try {
    const d = await restFetch(contentsPath(owner, repo, path, ref), token)
    if (typeof d === 'string') return { text: d, ok: true, truncated: false }
    if (!d || typeof d !== 'object') throw new Error(`文件 ${path} 内容为空`)
    if (typeof d.content !== 'string') {
      throw new Error(`文件 ${path} 没有内联内容（可能是子模块或超过 1MB）`)
    }
    const text = d.encoding === 'base64' ? Buffer.from(d.content, 'base64').toString('utf8') : d.content
    return { text, ok: true, truncated: d.truncated === true }
  } catch (e) {
    if (mode !== EndpointState.MCP_REMOTE || e.rateLimited) throw e
  }

  // REST 失败且配置了 token：用 MCP get_file_contents 兜底
  const args = { owner, repo, path }
  if (ref && ref !== 'HEAD') args.ref = ref
  const out = await mcpTool('get_file_contents', args, token)
  if (typeof out === 'string') return { text: out, ok: true, truncated: false }
  if (out && typeof out === 'object' && typeof out.content === 'string') {
    const text = out.encoding === 'base64' ? Buffer.from(out.content, 'base64').toString('utf8') : out.content
    return { text, ok: true, truncated: false }
  }
  return { text: JSON.stringify(out).slice(0, 2000), ok: true, truncated: false }
}

/** 锚点反查：拿参照仓库的元数据（topics/description/language/license），
 *  供查询规划器提取 topic: 种子。1 次请求。 */
export async function getRepoMeta(owner, repo) {
  const { token } = selectEndpoint()
  const d = await restFetch(`/repos/${owner}/${repo}`, token)
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
