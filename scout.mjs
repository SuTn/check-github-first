#!/usr/bin/env node
// scout.mjs — check-github-first 入口
//
// 用法:
//   node scout.mjs "想法描述"                    # 默认：词典+内置关键词
//   node scout.mjs "想法" --keywords "k1 k2"     # 显式英文检索词（LLM 翻译好的）
//   node scout.mjs --inspect owner/repo ...      # 深读选中仓库，输出借鉴卡
//   node scout.mjs --probe owner/repo            # 锚点反查：topics/描述/语言 → 查询种子
//   过滤器（需求分诊的答案）:
//     --lang typescript      语言硬约束
//     --license mit          license 约束
//     --min-stars 100        star 底线
//     --active               半年内有推送（同时排 archived）
//     --anchor logseq/logseq 锚点仓库（反查其 topics 作 topic: 查询）
//     --quick                快检索：只跑 anchor/precise 中的第一条（1 次搜索预算）
//   node scout.mjs --help / --version
//   GITHUB_TOKEN=xxx node scout.mjs "想法"       # 启用官方远程 MCP 端点（搜索）
//
// 行为要点：瞬时网络失败自动重试 1 次；precise 通道 0 行时用链后段独有词
//   补一搜（+1 预算）；候选池 <10 时 readme 补召回（+1 预算）；stderr 提示
//   词典未命中 / 产品专名 / 塌缩风险等信号给上层 agent
//
// 输出: 候选池卡片（stdout），供 agent / 人直接读
//
// 退出方式（2026-11-08 修复）：全程用 return + process.exitCode，最后 closeNet()
// 关掉 undici 连接池自然退出。**不要用 process.exit()**：Windows 上 fetch 失败后
// 立刻 process.exit 会触发 libuv 断言（UV_HANDLE_CLOSING / win async.c:76），
// 进程以 0xC0000409 崩溃，退出码不可用。

import { readFileSync } from 'node:fs'
import { ArgError, parseArgs, USAGE } from './src/args.mjs'

async function main() {
  // ---- 参数解析（纯函数，无依赖，--help/--version 不依赖 undici） ----
  let cli
  try {
    cli = parseArgs(process.argv.slice(2))
  } catch (e) {
    if (e instanceof ArgError) {
      console.error(`参数错误: ${e.message}`)
      console.error('')
      console.error(USAGE)
      return 1
    }
    throw e
  }

  if (cli.mode === 'help') {
    console.log(USAGE)
    return 0
  }
  if (cli.mode === 'version') {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    console.log(pkg.version)
    return 0
  }

  // 依赖自检必须在任何静态 import ./src/net.mjs 之前：
  // net.mjs 顶层 import undici，缺依赖时先抛 ERR_MODULE_NOT_FOUND 堆栈，
  // 后面的友好提示永远执行不到。
  try {
    await import('undici')
  } catch {
    console.error('缺少依赖 undici。在本 skill 目录跑一次:')
    console.error('  npm i undici')
    return 3
  }

  const { detectProxy } = await import('./src/net.mjs')
  const { searchRepos, getRepoMeta, endpointNote } = await import('./src/transport.mjs')
  const { significantTerms, planQueries, readmeRecallQuery, preciseRelaxedQuery } = await import('./src/plan.mjs')
  const { lexiconLookup, KNOWN_PRODUCTS } = await import('./src/lexicon.mjs')
  const { renderPool } = await import('./src/card.mjs')

  // ---- --inspect 模式：深读仓库 ----
  if (cli.mode === 'inspect') {
    const repos = cli.repos
    const MAX = 5
    console.error(`── 深读 ${Math.min(repos.length, MAX)} 个仓库（每个 ≤4 请求）`)
    if (repos.length > MAX) console.error(`   ⚠️ 只深读前 ${MAX} 个（另有 ${repos.length - MAX} 个未处理）`)
    console.error(`   端点: ${endpointNote()}`)
    const { inspectRepo } = await import('./src/inspect.mjs')
    const cards = []
    let failed = 0
    for (const r of repos.slice(0, MAX)) {
      process.stderr.write(`   读 ${r} ...\n`)
      const card = await inspectRepo(r)
      if (!card.ok) failed += 1
      cards.push(card.text)
    }
    console.log('📖 借鉴卡')
    console.log(cards.join('\n\n'))
    // 全部失败才算失败（部分成功仍是有用的结果）
    return failed === cards.length ? 1 : 0
  }

  // ---- --probe 模式：锚点反查 ----
  if (cli.mode === 'probe') {
    const target = cli.values.probe
    try {
      console.error(`── 锚点反查 ${target}（1 次请求）`)
      const meta = await getRepoMeta(...target.split('/'))
      console.log('⚓ 锚点卡片')
      console.log(JSON.stringify(meta, null, 2))
      console.error('')
      console.error('agent 用法提示：把 topics 变成 --anchor 参数或直接告诉规划层；')
      console.error('description 里的高频词可并入 --keywords。')
      return 0
    } catch (e) {
      console.error(`   ⚠️ 锚点反查失败: ${e.message}`)
      if (e.rateLimited) console.error('   GitHub 限流：设置 GITHUB_TOKEN 可提高配额，或稍后重试。')
      return 1
    }
  }

  // ---- 主流程 ----
  const { idea, flags, values } = cli
  const keywords = values.keywords

  // 过滤器（需求分诊答案 → 检索参数）
  const filters = {
    lang: values.lang || '',
    license: values.license || '',
    minStars: values.minStars || 0,
    active: flags.active,
    anchorTopics: [],
  }
  const filterNote = [
    filters.lang && `language:${filters.lang}`,
    filters.license && `license:${filters.license}`,
    filters.minStars && `stars:>${filters.minStars}`,
    filters.active && 'pushed:>半年内 archived:false',
  ].filter(Boolean).join(' ')

  // ---- ① 语言处理 ----
  const proxy = detectProxy()
  const terms = significantTerms(idea)
  const latinTerms = terms.filter((t) => t.kind === 'latin').map((t) => t.term)
  const cjkTerms = terms.filter((t) => t.kind === 'cjk').map((t) => t.term.replace(/"/g, ''))

  let englishTerms = []
  let langNote = ''
  let cjkMisses = [] // 未命中词典的中文片段（多意图/意图塌缩信号）
  if (keywords) {
    englishTerms = significantTerms(keywords).filter((t) => t.kind === 'latin').map((t) => t.term)
    langNote = '检索词来自 --keywords（调用方提供）'
  } else {
    const parts = []
    const notes = []
    if (latinTerms.length > 0) {
      parts.push(...latinTerms)
      notes.push(`想法自带英文词 ${latinTerms.length} 个`)
    }
    if (cjkTerms.length > 0) {
      const { hits, misses } = lexiconLookup(cjkTerms)
      parts.push(...hits)
      if (hits.length) notes.push(`词典命中 ${hits.length} 词`)
      if (misses.length) notes.push(`词典未命中: ${misses.join('、')}`)
      cjkMisses = misses
    }
    englishTerms = [...new Set(parts)]
    langNote = notes.join('；') || '（想法里没有可检索的词）'
  }

  console.error(`── ① 语言处理`)
  console.error(`   想法: ${idea}`)
  console.error(`   ${langNote}`)
  // V4 教训：未翻译片段 ≥2 是「意图可能塌缩」的信号。词典是兜底不是语义
  // 翻译——多意图拆分、概念翻译是上层 agent 的活，这里只负责把信号递上去。
  if (!keywords && cjkMisses.length >= 2) {
    console.error(`   ⚠️ ${cjkMisses.length} 个中文片段未命中词典（不进查询）。若其中携带核心意图，`)
    console.error('      请用 --keywords 传入英文检索词；多意图想法建议拆成 2-3 次聚焦探查。')
  }
  // V2 教训：专名直通 → 召回生态配件而非竞品。只提示不降权，语境判断留给上层。
  const prodHits = englishTerms.filter((t) => KNOWN_PRODUCTS.has(t.toLowerCase()))
  if (prodHits.length > 0) {
    console.error(`   ⚠️ 检索词含知名产品专名: ${prodHits.join(', ')}`)
    console.error('      若意图是「做类似 X 的产品」而非「X 的插件/生态」，请把 X 翻译成领域词')
    console.error('      （如 obsidian→knowledge base），或 --probe X 官方仓库反查 topics 后重跑。')
  }

  if (englishTerms.length === 0 && !values.anchor) {
    console.error('')
    console.error('拒绝执行：没有英文检索词就搜不到用英文自我描述的项目（GitHub 头部项目几乎都是）。')
    console.error('请把想法的核心概念翻成 2-4 个英文词，用 --keywords 传入。')
    console.error('例如: node scout.mjs "本地优先的笔记应用" --keywords "local-first note-taking"')
    return 2
  }

  // ---- ② 锚点反查（--anchor 传入时）----
  const anchorRepo = values.anchor
  if (anchorRepo) {
    if (!anchorRepo.includes('/')) {
      console.error('--anchor 需要 owner/repo 形式')
      return 1
    }
    console.error(`── ②' 锚点反查 ${anchorRepo}`)
    try {
      const meta = await getRepoMeta(...anchorRepo.split('/'))
      // topics 里去掉太宽的（github, awesome, hacktoberfest 等）
      const GENERIC = new Set(['github', 'awesome', 'awesome-list', 'hacktoberfest', 'open-source', 'opensource', 'readme'])
      filters.anchorTopics = meta.topics.filter((t) => !GENERIC.has(t.toLowerCase()))
      if (meta.topics.length === 0) {
        console.error(`   ⚠️ 锚点仓库没有设置任何 topics——锚点通道落空，退回关键词通道。`)
        console.error(`      建议：换一个有 topics 的同类仓库做锚点（往往是该领域的开源竞品而非官方 SDK 仓库，`)
        console.error(`      例如想做 Linear 替代品时锚 makeplane/plane 而不是 linear/linear）。`)
      } else if (filters.anchorTopics.length === 0) {
        console.error(`   ⚠️ 锚点的 ${meta.topics.length} 个 topics 全是泛词（github/awesome 等），无法用作查询种子。`)
      } else {
        console.error(`   拿到 ${meta.topics.length} 个 topics，筛后 ${filters.anchorTopics.length} 个: ${filters.anchorTopics.slice(0, 6).join(', ')}`)
      }
      console.error(`   描述: ${meta.description.slice(0, 100)}`)
    } catch (e) {
      console.error(`   ⚠️ 锚点反查失败（${e.message}），退回关键词通道`)
    }
  }

  // ---- ③ 查询规划 ----
  let steps = planQueries(englishTerms, filters)
  if (flags.quick) steps = steps.filter((s) => s.role === 'anchor' || s.role === 'precise').slice(0, 1)

  console.error(`── ② 查询规划 (${steps.length} 通道${filterNote ? `，过滤器: ${filterNote}` : ''})`)
  for (const s of steps) console.error(`   [${s.role}] "${s.query}" sort=${s.sort}`)

  // ---- ④ 执行 ----
  console.error(`── ③ 执行`)
  console.error(`   端点: ${endpointNote()}`)
  console.error(`   代理: ${proxy || '无（直连）'}`)

  const results = []
  let rateLimitedSeen = false
  for (const step of steps) {
    // 瞬时网络失败自动重试 1 次（V5 双跑实测：一次 fetch failed 就丢整个通道，
    // “行数未知”的诚实展示救不了召回——重试可以）
    let rows = null
    let lastErr = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        rows = await searchRepos(step.query, step.sort, 30)
        break
      } catch (err) {
        lastErr = err
        if (err.rateLimited) rateLimitedSeen = true
        if (err.rateLimited || attempt >= 2) break
        console.error(`   [${step.role}] "${step.query}" ⚠️ ${err.message}——2 秒后重试一次`)
        console.error('') // 视觉分隔
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    if (rows) {
      results.push({ step, rows, error: null })
      console.error(`   [${step.role}] "${step.query}" → ${rows.length} 行`)
    } else {
      results.push({ step, rows: [], error: lastErr.message })
      console.error(`   [${step.role}] "${step.query}" ⚠️ ${lastErr.message}`)
      if (lastErr.rateLimited) {
        console.error('   限流：停止后续搜索（配额纪律优先于召回）')
        break
      }
    }
  }

  // ---- ④' precise 0 行补独词（V2 教训，+1 搜索预算仅此一次） ----
  // precise AND 链的第 3、4 词只存在于 precise 通道；链 0 行时这些意图词随
  // 通道全灭（obsidian web knowledge base collaborative 返 0 → collaborative
  // 在整个候选池零代表）。用后段独有词单独补一搜；限流后不补。
  if (!flags.quick && !rateLimitedSeen) {
    const dead = results.find((r) => r.step.role === 'precise' && !r.error && r.rows.length === 0)
    if (dead) {
      const rq = preciseRelaxedQuery(englishTerms, filters, results.map((r) => r.step.query))
      if (rq) {
        console.error(`   [precise] 0 行 → 用链后段独有词补一搜: "${rq}"`)
        try {
          const rows = await searchRepos(rq, 'stars', 30)
          results.push({ step: { role: 'precise', query: rq, sort: 'stars', why: 'precise 0 行补独词（后段意图词单独一搜）' }, rows, error: null })
          console.error(`   [precise] "${rq}" → ${rows.length} 行`)
        } catch (err) {
          if (err.rateLimited) rateLimitedSeen = true
          console.error(`   [precise] "${rq}" ⚠️ ${err.message}`)
        }
      }
    }
  }

  // ---- ④'' 自适应 readme 补召回：候选池 <10 时触发（+1 搜索预算） ----
  const poolCount = new Set(results.flatMap((r) => r.rows.map((x) => x.full_name))).size
  if (!flags.quick && !rateLimitedSeen && poolCount < 10) {
    const rq = readmeRecallQuery(englishTerms, filters)
    if (rq) {
      console.error(`   候选池仅 ${poolCount}，触发 readme 补召回: "${rq}"`)
      try {
        const rows = await searchRepos(rq, 'stars', 30)
        results.push({ step: { role: 'readme-recall', query: rq, sort: 'stars', why: 'readme 补召回（候选池不足）' }, rows, error: null })
        console.error(`   [readme-recall] "${rq}" → ${rows.length} 行`)
      } catch (err) {
        console.error(`   [readme-recall] ⚠️ ${err.message}`)
      }
    }
  }

  // ---- ⑤ 渲染 ----
  console.error(`── ④ 卡片`)
  console.log(renderPool(results, {
    endpoint: endpointNote(),
    terms: englishTerms,
  }))
  return 0
}

let code = 1
try {
  code = await main()
} catch (e) {
  console.error(e && e.stack ? e.stack : String(e))
  code = 1
}

// 关掉 undici 连接池，让 keep-alive 连接不拖住进程（自然退出，不用 process.exit）
try {
  const { closeNet } = await import('./src/net.mjs')
  await closeNet()
} catch {
  /* 没有网络层（help/version/缺依赖）时忽略 */
}
process.exitCode = code
