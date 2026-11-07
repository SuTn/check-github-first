// inspect.mjs — 深读：选中的仓库 → 借鉴卡
//
// 阅读策略（每仓库 ≤4 次请求：树 + 3 文件；树走 REST recursive 时含 meta 共 2）：
//   1. 递归树 → 挑文件（manifest > monorepo 子包 manifest > 入口 > README）
//   2. 读 manifest（依赖=技术栈）+ 入口或 README（结构=架构）
// 借鉴卡输出：技术栈 / 架构信号 / 关键文件（带链接）/ 请求数
//
// T2 测试教训（第三轮）：
//   - monorepo 根 package.json 几乎无信息（plane 只有 pkg:plane）——必须嗅探
//     apps/*/package.json 或 packages/*/package.json 子包清单
//   - README 前 15 行常是赞助商/徽标区——跳过品牌区取首段正文
//   - stderr 无逐请求日志，预算纪律（≤N 请求）不可审计——加日志

import { getTree, getFile } from './transport.mjs'

const MANIFESTS = ['package.json', 'go.mod', 'cargo.toml', 'pyproject.toml', 'requirements.txt', 'pom.xml', 'composer.json', 'gemfile', 'mix.exs', 'pubspec.yaml']
const ENTRY_RE = /(^|\/)(main|index|app|server|entry|cli)\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|php)$/i

/** 从树里挑值得读的文件（≤3）：
 *  1. 根 manifest（技术栈）
 *  2. monorepo 子包 manifest（若根 manifest 信息薄——由调用方判断）
 *  3. 入口文件 或 README */
export function pickFiles(tree) {
  const paths = tree.map((e) => e.path)
  const manifest = MANIFESTS.map((m) => paths.find((p) => p === m || p.endsWith('/' + m))).find(Boolean)
  const entry = paths.find((p) => ENTRY_RE.test(p) && !p.includes('test') && !p.includes('node_modules'))
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
  const pkgPaths = tree.map((e) => e.path).filter((p) => /^(apps|packages)\/[^/]+\/package\.json$/.test(p))
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
 * 深读一个仓库，返回借鉴卡片段。
 * 预算：树 1（REST 含 meta 2）+ ≤3 文件 ≈ 4-5 请求/仓库。
 */
export async function inspectRepo(fullName, budget = 5) {
  const [owner, repo] = fullName.split('/')
  const lines = []
  let used = 0
  const log = (m) => process.stderr.write(`   [inspect ${used}] ${m}\n`)
  try {
    const tree = await getTree(owner, repo)
    used += 1
    log(`树 ${tree.length} 项`)
    const files = pickFiles(tree)
    lines.push(`### ${fullName}`)
    lines.push(`   目录规模: ${tree.length} 项${tree.__truncated ? '（树被截断）' : ''}`)

    // 根 manifest 读了之后若技术栈信息薄（只有 pkg:name），补读 monorepo 子包清单
    let rootStackThin = false
    for (const f of files) {
      if (used >= budget) break
      try {
        const { text } = await getFile(owner, repo, f.path)
        used += 1
        log(`读 ${f.path}`)
        const isManifest = MANIFESTS.some((m) => f.path.endsWith(m))
        if (isManifest) {
          const stack = stackOf(f.path, text.slice(0, 20000))
          lines.push(`   技术栈（${f.path}）: ${stack.join(', ') || '无显著依赖'}`)
          if (f.path.endsWith('package.json')) {
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
  } catch (e) {
    lines.push(`### ${fullName}`)
    lines.push(`   ⚠️ 深读失败: ${e.message}`)
  }
  return lines.join('\n')
}
