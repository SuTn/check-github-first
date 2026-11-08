// inspect.mjs — 深读：选中的仓库 → 借鉴卡
//
// 阅读策略（每仓库 ≤4 次请求：树 + 最多 2 个文件 + monorepo 可选补读 1）：
//   1. 递归树 → 挑文件（manifest > 入口 > README）
//   2. 读 manifest（依赖=技术栈）+ 入口或 README（结构=架构）
//   3. 根 manifest 信息薄时，补读 monorepo 子包 manifest（+1）
// 借鉴卡输出：技术栈 / 架构信号 / 关键文件（带链接）/ 请求数
//
// T2 测试教训（第三轮）：
//   - monorepo 根 package.json 几乎无信息（plane 只有 pkg:plane）——必须嗅探
//     apps/*/package.json 或 packages/*/package.json 子包清单
//   - README 前 15 行常是赞助商/徽标区——跳过品牌区取首段正文
//   - stderr 无逐请求日志，预算纪律（≤N 请求）不可审计——加日志
//
// 2026-11-08 修复：
//   - MANIFESTS 匹配改为大小写不敏感（旧版 Cargo.toml / Gemfile 永远选不中）
//   - 预算按真实 HTTP 次数计（树若走两步兜底算 2）
//   - 树被 GitHub 截断（truncated:true）时如实标注

import { getTree, getFile } from './transport.mjs'

export const MANIFESTS = [
  'package.json', 'go.mod', 'cargo.toml', 'pyproject.toml', 'requirements.txt',
  'pom.xml', 'composer.json', 'gemfile', 'mix.exs', 'pubspec.yaml',
]
const ENTRY_RE = /(^|\/)(main|index|app|server|entry|cli)\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|php)$/i

/** 从树里挑值得读的文件（≤2）：
 *  1. 根 manifest（技术栈）
 *  2. 入口文件 或 README */
export function pickFiles(tree) {
  const paths = tree.map((e) => e.path)
  const lower = paths.map((p) => p.toLowerCase())

  // manifest：按 MANIFESTS 顺序优先，文件名/路径比较一律小写
  const manifest = MANIFESTS.map((m) => {
    const idx = lower.findIndex((lp) => lp === m || lp.endsWith('/' + m))
    return idx >= 0 ? paths[idx] : null
  }).find(Boolean)

  const entry = paths.find((p) => {
    const lp = p.toLowerCase()
    return ENTRY_RE.test(p) && !lp.includes('test') && !lp.includes('node_modules')
  })
  const readme = paths.find((p) => /^readme(\.md|\.txt)?$/i.test(p))

  const files = []
  if (manifest) files.push({ path: manifest, why: 'manifest（技术栈与依赖）' })
  if (files.length < 2 && entry) files.push({ path: entry, why: '入口文件（架构与模块组织）' })
  if (files.length < 2 && readme) files.push({ path: readme, why: 'README（定位与特性）' })
  return files.slice(0, 2)
}

/** monorepo 嗅探：根 package.json 信息薄时，找最有信息量的子包清单。
 *  优先 apps 下 web、frontend、server 等常见命名，其次任意子包清单。 */
export function pickMonorepoManifest(tree) {
  const pkgPaths = tree.map((e) => e.path).filter((p) => /^(apps|packages)\/[^/]+\/package\.json$/i.test(p))
  if (pkgPaths.length === 0) return null
  const prefer = ['web', 'frontend', 'client', 'server', 'api', 'app', 'desktop', 'mobile']
  for (const k of prefer) {
    const hit = pkgPaths.find((p) => p.toLowerCase().includes('/' + k))
    if (hit) return hit
  }
  return pkgPaths[0]
}

/** 从 package.json 等提取技术栈信号。 */
function stackOf(path, text) {
  const out = []
  try {
    if (path.toLowerCase().endsWith('package.json')) {
      // 大 package.json（124+ deps）截 4000 字符会把 JSON 截断——
      // 先剥出 dependencies/devDependencies 段再解析，失败则退化为关键词抓取
      let pkg = null
      try {
        pkg = JSON.parse(text)
      } catch {
        // 截断的 JSON：剥 dependencies 段
        const depMatch = text.match(/"dependencies"\s*:\s*\{([\s\S]*?)\}/)
        if (depMatch) {
          try { pkg = { dependencies: JSON.parse('{' + depMatch[1]) } } catch { /* fallthrough */ }
        }
      }
      if (pkg) {
        const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })
        const notable = deps.filter((d) => /^(react|vue|svelte|next|nuxt|vite|webpack|electron|tauri|express|fastify|koa|typescript|esbuild|rollup|astro|solid|preact|d3|three|nest|prisma|trpc)/.test(d))
        out.push(...notable.slice(0, 8))
        if (pkg.name) out.unshift(`pkg:${pkg.name}`)
      } else {
        // 关键词退化：直接扫描文本里出现的框架名
        const known = ['react', 'vue', 'svelte', 'next', 'nuxt', 'vite', 'electron', 'tauri', 'express', 'typescript', 'astro', 'nest', 'prisma']
        out.push(...known.filter((k) => new RegExp(`"${k}"`, 'i').test(text)).slice(0, 8))
      }
    } else {
      // go.mod / cargo.toml / pyproject 等：抓前几行非注释
      const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('//')).slice(0, 6)
      out.push(...lines.map((l) => l.trim().slice(0, 50)))
    }
  } catch { out.push('（manifest 解析失败）') }
  return out
}

/** README 摘要：跳过品牌区（徽标/赞助商/图片行）取首段正文。
 *  T2 教训：memos 的 README 前 15 行全是 CodeRabbit 赞助+品牌图，
 *  定位句在截断之后。 */
function readmeDigest(text) {
  const lines = text.split('\n')
  const meaningful = []
  let skipped = 0
  for (const l of lines) {
    const t = l.trim()
    if (!t) continue
    // 品牌区特征：徽标行、图片行、赞助商表格、纯链接行、HTML 标签行
    if (/^<|!\[|^\[!\[|^\|\s*[-:|]+\s*\|$/i.test(t) || (t.startsWith('[') && t.endsWith(')') && !/\s/.test(t.replace(/\[|\]|#|\(|\)/g, '').slice(0, 20)))) {
      skipped += 1
      continue
    }
    meaningful.push(t)
    if (meaningful.join(' ').length > 300) break
  }
  return meaningful.slice(0, 4).join(' ⏎ ').slice(0, 400) + (skipped > 0 ? `（跳过 ${skipped} 行品牌区）` : '')
}

/**
 * 深读一个仓库。返回 { ok, text }：
 *   ok=false 表示这个仓库整体深读失败（scout 据此决定退出码）。
 * 预算：树 ≤2 + ≤2 文件，monorepo 补读占剩余预算，总计 ≤4 次。
 */
export async function inspectRepo(fullName, budget = 4) {
  const [owner, repo] = String(fullName || '').split('/')
  const lines = []
  let used = 0
  const log = (m) => process.stderr.write(`   [inspect ${used}] ${m}\n`)
  try {
    if (!owner || !repo) throw new Error('需要 owner/repo 形式')
    const tree = await getTree(owner, repo)
    used += tree.requests ?? 1
    const truncated = tree.truncated === true
    log(`树 ${tree.length} 项${truncated ? '（GitHub 返回截断）' : ''}`)
    const files = pickFiles(tree)
    lines.push(`### ${fullName}`)
    lines.push(`   目录规模: ${tree.length} 项${truncated ? '（GitHub 返回截断：只看到部分文件）' : ''}`)

    // 根 manifest 读了之后若技术栈信息薄（只有 pkg:name），补读 monorepo 子包清单
    let rootStackThin = false
    for (const f of files) {
      if (used >= budget) break
      try {
        const { text } = await getFile(owner, repo, f.path)
        used += 1
        log(`读 ${f.path}`)
        const isManifest = MANIFESTS.some((m) => f.path.toLowerCase().endsWith(m))
        if (isManifest) {
          const stack = stackOf(f.path, text.slice(0, 20000))
          lines.push(`   技术栈（${f.path}）: ${stack.join(', ') || '无显著依赖'}`)
          if (f.path.toLowerCase().endsWith('package.json')) {
            const hasFramework = stack.some((s) => !s.startsWith('pkg:'))
            rootStackThin = !hasFramework
          }
        } else {
          lines.push(`   ${f.why} [${f.path}]: ${/readme/i.test(f.path) ? readmeDigest(text) : text.split('\n').filter((l) => l.trim()).slice(0, 15).join(' ⏎ ').slice(0, 400)}`)
        }
        lines.push(`   源码: https://github.com/${fullName}/blob/HEAD/${f.path}`)
      } catch (e) {
        lines.push(`   ⚠️ 读 ${f.path} 失败: ${e.message}`)
      }
    }
    // monorepo 补读：根清单薄 → 嗅探子包
    if (rootStackThin && used < budget) {
      const sub = pickMonorepoManifest(tree)
      if (sub && sub !== files[0]?.path) {
        try {
          const { text } = await getFile(owner, repo, sub)
          used += 1
          log(`monorepo 子包 ${sub}`)
          const stack = stackOf(sub, text.slice(0, 20000))
          lines.push(`   技术栈（${sub}，monorepo 子包）: ${stack.join(', ') || '无显著依赖'}`)
          lines.push(`   源码: https://github.com/${fullName}/blob/HEAD/${sub}`)
        } catch (e) {
          lines.push(`   ⚠️ 读 ${sub} 失败: ${e.message}`)
        }
      }
    }
    if (files.length === 0) lines.push('   （树里没找到 manifest/入口——可能是空仓库或非常规布局）')
    lines.push(`   请求预算: 用了 ${used}/${budget}`)
    return { ok: true, text: lines.join('\n') }
  } catch (e) {
    lines.push(`### ${fullName}`)
    lines.push(`   ⚠️ 深读失败: ${e.message}`)
    return { ok: false, text: lines.join('\n') }
  }
}
