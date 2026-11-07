// plan.mjs — 查询规划器：想法 → 三通道查询计划
//
// 三通道角色制（dsh-find-ideas 验证过的召回结构）：
//   anchor  宽词组 + sort=stars —— 够到领域头部（头部项目用不同的词自我描述，
//           精确查询永远够不到它们）
//   precise 长词链 AND + sort=stars —— 字面命中"就是这么做的"项目
//   tail    同/窄查询 + sort=updated —— stars 与 updated 的结果集不相交
//           （实测同一 14,388 人口：stars 版 0 个 <100★，updated 版 28 个），
//           够到 star 排序永远看不见的小项目
//
// 约束：匿名模式 3 次搜索/想法（10/分钟/IP）；带 token 也是 3 次（30/分钟），
//       省下的配额留给深读。MAX_TERMS=6 是防呆护栏（每多一词 = 一次 AND 收缩）。

export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'with', 'without', 'to', 'of', 'in', 'on', 'at',
  'by', 'from', 'as', 'is', 'are', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'my', 'me', 'we', 'our', 'you', 'your', 'they', 'them', 'their',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'do', 'does', 'did',
  'app', 'application', 'tool', 'project', 'program', 'software', 'system', 'platform',
  'build', 'create', 'make', 'want', 'need', 'like', 'similar', 'simple', 'new', 'using', 'use',
  'based', 'support', 'supports', 'supporting', 'able', 'help', 'helps', 'allow', 'allows',
  // 中文停用词（直接忽略，不进查询）
  '一个', '一种', '这个', '那个', '支持', '可以', '能够', '用来', '用于', '想要', '开发', '实现',
  '我想', '帮我', '看看', '一下', '应用', '工具', '软件', '系统', '平台', '项目', '简单的', '轻量',
  // 连接词（V4 教训：孤立的连接词碎片未命中词典会被计为 miss，制造假信号）
  '但是', '而且', '然后', '另外', '还有', '以及', '或者', '并且', '同时', '例如', '比如',
])

/** 实现技术类 topic（语言/框架/构建工具）——锚点反查时降权，
 *  因为用户要找的是"同类产品"不是"同技术栈实现"。
 *  领域词（note-taking/knowledge-base）才是分类学信号。 */
const IMPL_TECH_RE = /^(clojure|clojurescript|typescript|javascript|python|golang|rust|java|kotlin|swift|ruby|php|c|cpp|csharp|fsharp|elixir|erlang|haskell|scala|dart|vue|react|angular|svelte|solid|nextjs|nuxt|sveltekit|webpack|vite|rollup|esbuild|tauri|electron|wasm|webassembly|nodejs|node-js|django|flask|fastapi|spring|spring-boot|rails|laravel|aspnet)$/

// 部署/基础设施词：表达"怎么部署"而非"是什么"（T6 教训：锚点 memos 时
// topic:docker 压过了 memo/microblog/timeline 真正的定位词）
const DEPLOY_TECH_RE = /^(docker|kubernetes|k8s|container|devops|ci-cd|github-actions|helm|terraform|ansible|self-hosted|homelab|vps)$/

/**
 * 把一段文本切成检索词。拉丁词按空白切；CJK 连续段保持一个引号短语。
 * 中文词不经词典翻译不进英文通道（由 lexicon/LLM 层负责），这里只负责结构。
 */
export function significantTerms(text) {
  const seen = new Set()
  const out = []
  for (const raw of text.toLowerCase().replace(/[^\p{L}\p{N}\s-]+/gu, ' ').split(/\s+/)) {
    if (!raw) continue
    const han = raw.match(/\p{Script=Han}/gu)?.length ?? 0
    if (han > 0 && han >= raw.length / 2) {
      if (raw.length < 2 || STOPWORDS.has(raw)) continue
      if (seen.has(raw)) continue
      seen.add(raw)
      out.push({ term: `"${raw}"`, kind: 'cjk' })
      continue
    }
    const t = raw.replace(/^-+|-+$/g, '')
    if (t.length < 2 || STOPWORDS.has(t) || seen.has(t)) continue
    seen.add(t)
    out.push({ term: t, kind: 'latin' })
  }
  return out
}

/**
 * 规划三通道。输入：英文检索词数组（已翻译），可选约束。
 * filters: { lang, license, minStars, active, anchorTopics }
 *   - lang/license → 追加 language:xx / license:xx（所有通道）
 *   - minStars/active → 质量护栏 stars:>N / pushed:>半年前
 *   - anchorTopics → 锚点反查来的 topics，anchor 通道升级为 topic:a topic:b
 * 返回 [{role, query, sort, why}]，最多 3 条。
 */
export function planQueries(englishTerms, filters = {}) {
  const latin = englishTerms.filter((t) => /^[a-z0-9 -]+$/i.test(t))
  if (latin.length === 0 && !filters.anchorTopics?.length) return []

  // 公共过滤器后缀（filterSuffix 与 preciseRelaxedQuery 共用同一实现）
  const tailGuard = filterSuffix(filters)

  const steps = []

  // anchor 通道：有锚点 topics 时升级为 topic: 查询（精度之王，实测
  // topic:note-taking topic:markdown 直接命中 memos/siyuan/logseq）。
  // 挑选规则：领域语义词优先（note-taking/knowledge-base），实现技术词
  // （clojure/rust/react）靠后——用锚点找同类，不是找同语言实现。
  if (filters.anchorTopics?.length) {
    // 与检索词相关的 topic 排最前。R2 教训：keywords "issue tracker" 与
    // topic "issue-tracker" 精确相等永不命中——子串双向匹配才对
    // （"issue" ⊂ "issue-tracker"、"kanban" 与 "board" 无关）。
    const kwLower = latin.map((t) => t.toLowerCase())
    const scored = filters.anchorTopics.map((t) => {
      const lower = t.toLowerCase()
      let score = 0
      for (const k of kwLower) {
        if (lower.includes(k) || k.includes(lower)) { score += 10; break }
      }
      if (IMPL_TECH_RE.test(lower)) score -= 5                // 实现技术词降权
      if (DEPLOY_TECH_RE.test(lower)) score -= 4              // 部署/基础设施词降权（T6 教训：
      //  topic:docker 只表达"可 docker 部署"，不表达领域——锚点 memos 时它压过了
      //  memo/microblog/timeline 这些真正的定位词）
      if (lower.length > 3) score += 1                        // 太短的 topic 泛
      return { t, score }
    }).sort((a, b) => b.score - a.score || a.t.localeCompare(b.t))
    const picked = scored.slice(0, 2).map((s) => s.t)
    const topicQ = picked.map((t) => `topic:${t}`).join(' ')
    // 单 topic 时再放宽一个 OR，避免 AND 收窄到个位数（R2：boards AND bug-tracker
    // 全网仅 7 仓，若两个 topic 高度同义则丢召回）——保留原 AND（精度优先），
    // 但当 AND 人口 <10 时 scout 会触发 readme 补召回兜底。
    steps.push({
      role: 'anchor',
      query: topicQ + tailGuard,
      sort: 'stars',
      why: `锚点反查的 topics「${picked.join(', ')}」——维护者手工标注，比关键词准`,
    })
    // precise 通道用原检索词
    if (latin.length >= 1) {
      const precise = latin.slice(0, 3).join(' ')
      steps.push({ role: 'precise', query: precise + tailGuard, sort: 'stars', why: `检索词「${precise}」+过滤，字面命中` })
    }
  } else if (latin.length > 0) {
    const core = latin.slice(0, 2).join(' ')
    steps.push({ role: 'anchor', query: core + tailGuard, sort: 'stars', why: `宽词「${core}」+按 star 排序，够到领域头部项目` })

    const precise = latin.slice(0, 4).join(' ')
    if (precise !== core && latin.length >= 3) {
      steps.push({ role: 'precise', query: precise + tailGuard, sort: 'stars', why: `精确 AND 链「${precise}」，字面命中同类实现` })
    }
  }

  // tail 通道：同核心 + updated（结果集与 stars 版不相交）。
  // 差异化（第二轮修复）：有 precise 词时 tail 改用 precise 词 + updated——
  // anchor 词 + updated 在交叉域实测与 anchor 无差异化增益（用例 7），
  // 而 precise 词 + updated 恰好命中"垂直且活跃"的小项目。
  const hasPrecise = steps.some((s) => s.role === 'precise')
  const tailBase = hasPrecise ? latin.slice(0, 3).join(' ') : (latin.length >= 2 ? latin.slice(0, 2).join(' ') : latin[0])
  if (tailBase) {
    steps.push({
      role: 'tail',
      query: tailBase + tailGuard,
      sort: 'updated',
      why: hasPrecise
        ? `「${tailBase}」（precise 词）按最近更新排序，垂直且活跃的小项目`
        : `「${tailBase}」按最近更新排序，够到 star 少但活跃的小项目`,
    })
  }

  return steps.slice(0, 3)
}

/** 过滤器后缀（lang/license/minStars/active → 查询限定词）。
 *  planQueries 与 preciseRelaxedQuery 共用，保证补搜查询带同样的硬约束。 */
export function filterSuffix(filters = {}) {
  const suffix = []
  if (filters.lang) suffix.push(`language:${filters.lang}`)
  if (filters.license) suffix.push(`license:${filters.license}`)
  if (filters.minStars) suffix.push(`stars:>${filters.minStars}`)
  if (filters.active) suffix.push(`pushed:>${new Date(Date.now() - 183 * 86400000).toISOString().slice(0, 10)}`)
  const guard = filters.active || filters.minStars ? ' archived:false' : ''
  return (suffix.length ? ' ' + suffix.join(' ') : '') + guard
}

/**
 * precise 通道 0 行时的补独词查询（V2 教训）。
 * precise AND 链 = 前 4 词，其中第 3、4 词不进 anchor/tail 通道——链 0 行时
 * 这些意图词随通道全灭（"obsidian web knowledge base collaborative" 返 0 后
 * collaborative 在整个候选池零代表）。补搜 = 第 3、4 词 + 同过滤器。
 * 返回 null：词数 <4（后段不足两词），或与已执行查询重复（浪费配额）。
 */
export function preciseRelaxedQuery(englishTerms, filters = {}, executedQueries = []) {
  const latin = englishTerms.filter((t) => /^[a-z0-9 -]+$/i.test(t))
  if (latin.length < 4) return null
  const core = latin.slice(2, 4).join(' ')
  const query = core + filterSuffix(filters)
  return executedQueries.includes(query) ? null : query
}

/**
 * readme 补召回查询（仅在候选池 <10 时由 scout.mjs 触发）。
 * 铁律 1：必须带限定——topic: 优先，没有锚点 topics 时退回用户过滤器
 * （实测不带限定时 `bidirectional links in:readme` 返回 youtube-dl 级噪音，
 * 带了以后 24 个结果全是金矿）。
 * 铁律 2：短语加引号防词序打散。
 * 铁律 3（10 用例测试教训）：用户全部硬约束都传导——min-stars/active 不带
 * 时 in:readme 会召回 0★ 的 fork/mirror 刷屏（用例 6：top10 里 7 个 fork）。
 */
export function readmeRecallQuery(englishTerms, filters = {}) {
  if (englishTerms.length === 0 && !filters.anchorTopics?.length) return null
  const phrase = englishTerms.length > 0 ? `"${englishTerms.slice(0, 2).join(' ')}"` : ''
  const parts = []
  if (phrase) parts.push(phrase)
  parts.push('in:readme')
  if (filters.anchorTopics?.length) {
    parts.push(`topic:${filters.anchorTopics[0]}`)
  }
  // 硬约束全量传导（license/lang/topic 可共存，star/活跃是质量护栏）
  if (filters.license) parts.push(`license:${filters.license}`)
  if (filters.lang) parts.push(`language:${filters.lang}`)
  if (filters.minStars) parts.push(`stars:>${filters.minStars}`)
  if (filters.active) parts.push(`pushed:>${new Date(Date.now() - 183 * 86400000).toISOString().slice(0, 10)}`)
  parts.push('fork:false archived:false')
  return parts.join(' ')
}
