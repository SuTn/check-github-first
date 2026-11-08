// args.mjs — CLI 参数解析（纯函数，便于单测）
//
// 旧实现有三个坑：
//   1. positional() 遇到第一个 `-` 开头的 token 就 break——`--quick "想法"` 会
//      得到 idea="" 直接报用法，参数顺序不该影响语义；
//   2. optval() 在下一个 token 以 `-` 开头时静默返回 ''，`--min-stars` 缺值
//      会被当成 0，悄悄丢掉用户的硬约束；
//   3. `--inspect` 之后的位置参数混进 idea，只能靠 `includes('/')` 猜。
//
// 这里做一遍完整解析：位置参数可出现在任意 flag 前后；支持 `--flag=value`；
// `--inspect` 之后的位置参数明确归为 owner/repo 列表。

export class ArgError extends Error {}

const VALUE_FLAGS = new Map([
  ['--keywords', 'keywords'],
  ['--lang', 'lang'],
  ['--license', 'license'],
  ['--min-stars', 'minStars'],
  ['--anchor', 'anchor'],
  ['--probe', 'probe'],
])

const BOOL_FLAGS = new Map([
  ['--quick', 'quick'],
  ['--active', 'active'],
  ['--inspect', 'inspect'],
  ['--help', 'help'],
  ['-h', 'help'],
  ['--version', 'version'],
  ['-v', 'version'],
])

export const USAGE = `用法:
  node scout.mjs "想法描述" [选项]
  node scout.mjs --inspect owner/repo [owner/repo2 ...]
  node scout.mjs --probe owner/repo
  node scout.mjs --help | --version

选项:
  --keywords "k1 k2"     显式英文检索词（跳过词典翻译）
  --lang typescript      语言硬约束
  --license mit          license 约束
  --min-stars 100        star 底线（非负整数）
  --active               半年内有推送（同时排除 archived）
  --anchor owner/repo    锚点仓库：反查其 topics 作 topic: 查询种子
  --quick                快检索：只跑 anchor/precise 中的第一条（1 次搜索预算）
  --inspect owner/repo   深读仓库，输出借鉴卡（最多 5 个）
  --probe owner/repo     锚点反查：输出 topics/描述/语言/star
  --help, -h             显示本帮助
  --version, -v          显示版本`

/**
 * 解析 argv（不含 node 与脚本路径）。
 * 返回 { mode: 'search'|'inspect'|'probe'|'help'|'version', idea, flags,
 *        values, repos }；非法输入抛 ArgError。
 */
export function parseArgs(argv) {
  const flags = { quick: false, active: false, inspect: false, help: false, version: false }
  const values = { keywords: '', lang: '', license: '', minStars: '', anchor: '', probe: '' }
  const positional = []
  const repos = []

  let i = 0
  while (i < argv.length) {
    const raw = argv[i]
    if (raw === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (raw.startsWith('-') && raw !== '-') {
      const eq = raw.indexOf('=')
      const name = eq >= 0 ? raw.slice(0, eq) : raw
      const inline = eq >= 0 ? raw.slice(eq + 1) : undefined

      if (BOOL_FLAGS.has(name)) {
        if (inline !== undefined) throw new ArgError(`${name} 不接受取值`)
        flags[BOOL_FLAGS.get(name)] = true
        i += 1
        continue
      }
      if (VALUE_FLAGS.has(name)) {
        let value = inline
        if (value === undefined) {
          if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
            throw new ArgError(`${name} 缺少取值`)
          }
          value = argv[i + 1]
          i += 2
        } else {
          i += 1
        }
        values[VALUE_FLAGS.get(name)] = value
        continue
      }
      throw new ArgError(`未知参数: ${name}`)
    }

    if (flags.inspect) repos.push(raw)
    else positional.push(raw)
    i += 1
  }

  if (values.minStars !== '') {
    const n = Number(values.minStars)
    if (!Number.isInteger(n) || n < 0) throw new ArgError('--min-stars 需要非负整数')
    values.minStars = n
  }
  const idea = positional.join(' ').trim()

  if (flags.help) return { mode: 'help', idea, flags, values, repos }
  if (flags.version) return { mode: 'version', idea, flags, values, repos }
  if (flags.inspect) {
    if (repos.length === 0) throw new ArgError('--inspect 需要至少一个 owner/repo')
    if (!repos.every((r) => r.includes('/'))) throw new ArgError('--inspect 参数需要 owner/repo 形式')
    return { mode: 'inspect', idea, flags, values, repos }
  }
  if (values.probe) {
    if (!values.probe.includes('/')) throw new ArgError('--probe 需要 owner/repo 形式')
    return { mode: 'probe', idea, flags, values, repos }
  }
  if (!idea) throw new ArgError('缺少想法描述')
  return { mode: 'search', idea, flags, values, repos }
}
