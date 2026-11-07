// card.mjs — 候选池卡片渲染 + 预排序
//
// 诚实性设计（借鉴 dsh-find-ideas 的分区原则）：
//   【代码计算区】预排序分 = log10 加权的 star 信号，纯代码算，LLM 不可指定
//   【数据区】来自 GitHub API 的原始元数据
//   待 LLM 打 relevance 后，最终排序 = relevance × (1 + log10(max(star,10)+1)) / 2
//   —— 原型阶段卡片只做预排序，最终公式在 SKILL.md 里教给 agent 执行

const MAX_DESC = 60

function fmtStars(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

/** 预排序信号：让候选池先按"词位相关性×热度×新鲜度"排。
 *  matchTier（3=topics命中/2=name/1=description/0=无）作为乘数——
 *  10 用例测试教训：纯 star 排序让 diff-so-fancy（"fewer defects" 词面）
 *  压过真正的缺陷检测项目。topics 是维护者手工标注，可信度远高于营销描述。 */
export function preScore(row) {
  const starW = 1 + Math.log10(Math.max(row.stars, 10) + 1)      // 1.04 ~ 5.3
  const days = (Date.now() - Date.parse(row.pushed_at || '2000-01-01')) / 86400000
  const fresh = days < 90 ? 1.0 : days < 365 ? 0.8 : days < 730 ? 0.6 : 0.4
  const tier = row.matchTier ?? 0
  const tierBoost = tier === 3 ? 1.35 : tier === 2 ? 1.2 : tier === 1 ? 1.0 : 0.75
  return starW * fresh * tierBoost
}

/**
 * 渲染候选池卡片。
 * rows: 统一 repo 行；queries: 已执行的查询计划；meta: 端点/配额信息。
 *
 * 展示策略（通道多样性配额）：实测（10 用例子代理测试 2026-11-07）预排序的
 * star 偏置会把 precise/tail 通道召回的垂直项目全部挤出纯排序 top30——
 * 用例 3（小程序商城）/4（RSS）/7（MCP×智能家居）top10 里 precise 贡献 0 行。
 * 解法：主区按预排序取 top20，另给 precise-only / tail-only 各 5 个专属席位
 * （席位内仍按预排序），保证每个通道的工作成果对读者可见。
 */
export function renderPool(rows, queries, meta = {}) {
  const lines = []
  const uniq = new Map()
  for (const q of queries) {
    for (const r of q.rows) {
      if (!uniq.has(r.full_name)) {
        uniq.set(r.full_name, { ...r, hitBy: [q.step.role] })
      } else {
        uniq.get(r.full_name).hitBy.push(q.step.role)
      }
    }
  }
  const pool = [...uniq.values()].sort((a, b) => preScore(b) - preScore(a))

  // 通道多样性配额。
  // 资格 = "命中该通道 且 不在主区"——不要求通道独占。
  // （R1 教训：tail 改用 precise 词后，查询人口 <单页 的垂直场景里
  // 两种排序返回同一批仓库，全部双通道命中，"独占"条件永假，席位全空——
  // 恰好是最需要席位的场景。独占性不是目的，可见性才是。）
  // anchor 席（R2 教训）：anchor 用 topic: 查询时人口可能极少（实测 7 行）
  // 且全是高精度竞品，但可能整体跌出主区——给 anchor 3 个保底席位。
  const mainRows = pool.slice(0, 20)
  const shown = new Set(mainRows.map((r) => r.full_name))
  const anchorSeat = pool.filter((r) => !shown.has(r.full_name) && r.hitBy.includes('anchor')).slice(0, 3)
  anchorSeat.forEach((r) => shown.add(r.full_name))
  const preciseOnly = pool.filter((r) => !shown.has(r.full_name) && r.hitBy.includes('precise')).slice(0, 5)
  preciseOnly.forEach((r) => shown.add(r.full_name))
  const tailOnly = pool.filter((r) => !shown.has(r.full_name) && r.hitBy.includes('tail')).slice(0, 5)
  tailOnly.forEach((r) => shown.add(r.full_name))

  lines.push('🎯 开发前探查 —— 候选池卡片')
  lines.push(`   端点: ${meta.endpoint || '?'}   检索词: ${(meta.terms || []).join(', ')}`)
  lines.push('')
  lines.push('【查询计划】')
  for (const q of queries) {
    // T4 教训：fetch failed 的通道行数写 0 会伪装成"真·空结果"——
    // 失败时行数未知，诚实显示"未知"
    lines.push(`  · [${q.step.role}] "${q.step.query}" (${q.step.sort}) → ${q.error ? '行数未知' : `${q.rows.length} 行`}${q.error ? ` ⚠️ ${q.error}` : ''}`)
  }
  lines.push(`  合并去重: ${pool.length} 个候选；展示 ${mainRows.length + anchorSeat.length + preciseOnly.length + tailOnly.length} 个（主区 20 按预排序 + anchor 保底 ${anchorSeat.length} + precise 专属 ${preciseOnly.length} + tail 专属 ${tailOnly.length}——防 star 偏置淹没垂直项目）`)
  lines.push('')
  lines.push('【代码计算区】预排序 = star权重(1+log10) × 新鲜度 × 词位加权(topics命中1.35/name 1.2/仅desc 1.0/无 0.75)；最终排序等 relevance 打分后由公式计算')
  lines.push('')
  lines.push('| # | 项目 | star | 最近推送 | 语言 | 预排 | 命中通道 | 简介 |')
  lines.push('|---|------|------|----------|------|------|----------|------|')
  let i = 0
  for (const r of [...mainRows, ...anchorSeat, ...preciseOnly, ...tailOnly]) {
    i += 1
    const d = (r.description || '').slice(0, MAX_DESC).replace(/\|/g, '/')
    const seat = i > mainRows.length + anchorSeat.length + preciseOnly.length ? ' [tail席]' :
      i > mainRows.length + anchorSeat.length ? ' [precise席]' :
      i > mainRows.length ? ' [anchor席]' : ''
    lines.push(`| ${i} | ${r.full_name} | ${fmtStars(r.stars)} | ${r.pushed_at.slice(0, 10)} | ${r.language} | ${preScore(r).toFixed(2)} | ${r.hitBy.join('+')}${seat} | ${d} |`)
  }
  lines.push('')
  lines.push('【边界说明】')
  lines.push('  · GitHub 搜索只匹配 name/description/topics，不索引 README 正文；')
  lines.push('    空结果 = "这条查询够不到"，不 = "不存在同类项目"')
  lines.push('  · 预排序含 star 偏置：更贴题但冷门的项目需要你从池里人工挑出')
  lines.push('  · 本卡片未读任何仓库内容；深读用 inspect 步骤（README/manifest/入口文件）')
  return lines.join('\n')
}
