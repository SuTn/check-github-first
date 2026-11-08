---
name: check-github-first
description: 开发之前，先探查 GitHub 有没有同类开源项目——站在巨人的肩膀上，不从零造轮子。输入一个开发想法（中文随意），输出候选项目卡片（多通道检索+公式排序）和选中仓库的借鉴卡（技术栈/架构/源码链接）。当用户说"我想做个X，帮我看看有没有现成的"、"有没有类似的开源项目"、"开工前先调研一下同类"、"don't reinvent the wheel"、"prior art search"时使用。
license: MIT
---

# Check GitHub First — 开发前探查 GitHub

## 核心理念

**动手造轮子之前，先看看有没有人已经做过。** 本 skill 是一个"探查大脑"：
底层用 GitHub 官方 API / 远程 MCP 端点（api.githubcopilot.com/mcp/）做手脚
（带 token 时搜索优先走远程 MCP，树/文件/元数据主要走 REST），
上层做它不做的事——多通道查询规划、公式排序、仓库阅读策略、诚实呈现。

## 环境要求

- Node ≥ 20.18.1；首次使用在本 skill 目录跑一次 `npm i undici`（唯一依赖）
- `GITHUB_TOKEN`（fine-grained PAT，public repo 只读即可，免费创建：
  github.com/settings/personal-access-tokens → Generate → Public repos read-only）
- 企业网/国内网络：无需配置，脚本自动探测系统代理
  （环境变量 → Windows 注册表 → 直连），已在真实企业网环境验证通过
- 无 token 也能跑：自动降级匿名 REST（10 搜索/分钟/IP，够单次探查）

## 工作流程（agent 执行）

### 第 0 步：需求分诊（分层拷问，把想法变成可检索的参数）

**原则：每个问题必须能落地为一个检索变量（语言/license/topic/检索词），否则不问。**
节奏：一次一问（或一次一组选项），不连环轰炸；用户表现不耐烦时跳到默认值直接探查。

**第 1 层 · 意图分诊（必问，1 问）**

> "你是想找个现成的直接用，还是参考着自己写？"

- 找来用 → 探查偏成熟度：star/维护/license 优先，深读看文档完整度
- 参考写 → 探查偏借鉴度：架构/数据模型优先，license 只看兼容性

**第 2 层 · 硬约束（选项制，一次抛出，用户可跳过任何项）**

> "几个快速筛选（都可以说'无所谓'）：
> ① 编程语言？ ② license（MIT 宽松 / GPL 系 / 无所谓）？ ③ 形态（CLI / Web / 桌面 / 库 / 扩展）？
> ④ 部署（自托管 / 本地优先 / 云 / 无所谓）？ ⑤ 活跃底线（半年内有更新 / 100+ star / 无所谓）？"

每个答案变成检索参数：`language:typescript` `license:mit` `stars:>100` `pushed:>2026-05`，
执行时用 `--lang --license --min-stars --active` 传入（`--active` 即半年内有推送）。
`topic:` 只能由第 3 层锚点反查得到（CLI 没有 `--topic` 参数）；部署形态
（自托管 / 本地优先）作为检索词进 `--keywords`。

**第 3 层 · 锚点拷问（最有价值，尽量问）**

> "有没有你觉得『最像你想要的』那个项目？说个名字就行，哪怕是竞品。"

拿到锚点后跑 `node scout.mjs --probe owner/repo`（1 次请求）反查它的
topics/description/language，把 topics 直接变成 `topic:` 查询种子——
这比任何关键词翻译都准（实测 `topic:note-taking topic:markdown` 直接命中
memos/siyuan/logseq 三巨头）。

**第 4 层 · 反差澄清（收敛循环，最多 2 轮）**

约束收集完先跑快检索（`--quick`，1 次搜索预算；卡片仍按主区 top20 + 席位输出，
可能 20+ 行，你取前 5 给用户看）：

> "先给你看 5 个，这些是你要的方向吗？"
> - 是 → 进入正式探查（第 1 步）
> - 不全是 → "哪个最接近？差在哪？"——把「差在哪」变成新检索词，重跑
> - 全不是 → 检查语言处理层（通常是检索词偏了），换词重跑

用户看 5 个真实项目比回答 10 个抽象问题更能表达清楚需求。

### 第 1 步：拿到英文检索词（关键！中文搜不到头部项目）

GitHub 头部项目几乎都用英文自我描述，中文查询在任何精度下都够不到它们
（实测：中文查询返回的是政治文档库和动漫仓库）。所以：

1. 若想法纯英文 → 直接进第 2 步
2. 若想法含中文 → **你（LLM）把核心概念翻成 2-4 个英文检索词**，
   形如 `local-first note-taking`。不是整句翻译，是检索词提炼。
3. 用 `--keywords` 传入。脚本自带 99 词条小词典可兜底（笔记应用→note-taking、
   照片备份→photo backup 等），但你的翻译质量远高于词典，**优先用你的翻译**。
4. **关键词顺序 = 通道权重**：前 2 词进 anchor 宽检索、前 4 词进 precise
   AND 链。把「是什么」的领域词放最前，设备名/专名/修饰词放后或去掉。
5. **专名是锚点不是检索词**（V2 教训：「像 Obsidian 那样的知识库」直通后
   top10 里 8 个是 Obsidian 插件/生态配件）。区分语境：「做个 Obsidian
   插件」→ X 是目标平台，保留；「做个像 X 的产品」→ 把 X 翻译成领域词
   （Obsidian/Notion→knowledge base、Linear→project management），或
   `--probe` X 的官方仓库拿 topics 做 `--anchor`。
6. **多意图想法先拆分**（V4 教训：「照片备份+智能分类+人脸聚类+NAS」塞进
   一次查询会塌缩成单个歧义词，Immich/PhotoPrism 全漏）。拆成 2-3 次聚焦
   探查、各自 `--keywords`（如 `self-hosted photo backup`、`photo face
   recognition clustering`）——拆分是搜索预算的正当理由，不算浪费。

### 第 2 步：跑探查（候选池）

本 skill 的脚本就在 SKILL.md 所在目录（下称 `$SKILL_DIR`）：

```bash
cd "$SKILL_DIR"
GITHUB_TOKEN=xxx node scout.mjs "用户想法原文" --keywords "english terms" [--lang go] [--license mit] [--min-stars 100] [--active]
# Windows PowerShell: $env:GITHUB_TOKEN='xxx'; node scout.mjs "想法" --keywords "terms"

# 帮助 / 版本
node scout.mjs --help   # 或 -h
node scout.mjs --version
```

- stderr 是过程日志（语言处理/查询计划/执行结果），stdout 是卡片
- 脚本自动做：三通道查询（anchor宽词+stars / precise长链 / tail+updated——
  有 precise 时 tail 用 precise 前 3 词 + updated，否则用 anchor 核心词 + updated；
  两排序结果集不相交，实测 stars 版 0 个<100★ 而 updated 版 28 个）
- 基础 3 次搜索/想法；429 立即停。自动补搜（脚本自己控制，上限 5 次）：
  瞬时网络失败重试 1 次（不计入）；precise 0 行时用链后段独有词补一搜（+1）；
  候选池 <10 时 readme 补召回（+1）
- stderr 里的「词典未命中」「⚠️ 含知名产品专名」是给你的信号：未命中的
  中文片段不进查询；专名处理见第 1 步第 5 条。信号携带核心意图时换
  `--keywords` 重跑，不要把有缺陷的卡片当结论

### 第 2.5 步：锚点反查与快检索（分诊阶段用）

```bash
# 锚点反查：拿参照项目的 topics/描述/语言，作为查询种子
node scout.mjs --probe logseq/logseq

# 快检索：1 次搜索预算；卡片仍可能 20+ 行，取前 5 给用户看（反差澄清循环用）
node scout.mjs "想法" --keywords "terms" --quick --lang typescript
```

### 第 3 步：你给候选打 relevance（0-10）

读卡片，对每个候选判断与想法的相关性。卡片里的「预排」只是 CLI 的预排序
（star 权重 × 新鲜度 × 词位），不是最终分。**必须给理由**，但理由是给用户
看的，不进公式。然后按下面的公式自己算最终分：

```
final = relevance × (1 + log10(max(stars, 10) + 1)) / 2
```

（例：relevance 9 / 47k★ → 9×5.67/2 ≈ 25.5；relevance 6 / 7★ → 6×2.04/2 ≈ 6.1）

**知名项目缺口检查**（打分前必做）：对照你对该领域的知识，卡片是否漏掉了
你确知存在的头部项目？（如 RSS 漏 miniflux、笔记漏 memos、项目管理漏 Plane）
漏掉的原因几乎总是"它的 name/description/topics 不含当前检索词"——GitHub
搜索只匹配这三个字段，这是检索面边界不是项目不存在。补救：拿漏掉的项目
跑 `node scout.mjs --probe owner/repo` 反查它的 topics，把 topics 变成
`--anchor` 或并入 `--keywords` 重跑一轮（按新一轮预算计，仅在确认缺口时用）。

向用户呈现最终榜单时**必须**：
- 每行保留：项目、relevance、stars、最终分、一句中文理由（标注[LLM判断]）
- 区分【CLI 预排序】（卡片里的预排）和【LLM 判断区】（你的 relevance 与按公式算出的最终分）
- 长尾提示：卡片里的预排序有 star 偏置，更贴题但冷门的项目要靠你从池里挑出

### 第 4 步：深读选中仓库（用户挑 2-5 个）

```bash
cd "$SKILL_DIR"
GITHUB_TOKEN=xxx node scout.mjs --inspect owner/repo1 owner/repo2
```

一次最多深读 5 个仓库（多传的会在 stderr 提示未处理）。每个仓库 ≤4 请求（典型 2–3 次：一次递归树 + manifest + README/入口；monorepo
可能补读 1 个子包 manifest），输出借鉴卡：
技术栈（框架依赖）、定位摘要、源码直链。

### 第 5 步：综合结论（你的核心价值）

基于候选池+借鉴卡，给用户三个判断：
1. **该不该造**：已有项目覆盖度多高？差异化空间在哪？
2. **站在谁肩上**：最值得借鉴的 2-3 个项目，各自借鉴什么
   （架构/数据模型/特定模块，引用借鉴卡里的证据）
3. **风险**：license（借鉴卡可再查 LICENSE 文件）、活跃度（卡片 pushed_at）、
   技术栈匹配度

## 诚实性纪律（不可违反）

1. **空结果 ≠ 不存在**。GitHub 搜索只匹配 name/description/topics，
   不索引 README 正文。检索够不到就说"这条查询够不到"，不说"没有同类"。
2. **最终分不可直接指定**。relevance 是你的判断（可错），
   final 由你按上面的公式算（可复算），CLI 只输出预排序。两区物理隔离。
3. **未测过的数字不写成 0**。查询词没单独测过就写"未知"。
4. **拒绝 > 垃圾**。没有英文检索词时宁可拒绝并教用户，不返回无关结果。

## 已知边界

- 带 token 时树优先走 REST 递归树（`/git/trees?recursive=1`，一次请求拿全树，
  可能被 GitHub 截断）；MCP 目录列举仅作兜底；远程 MCP 的工具数/配额以官方说明为准
- 深读典型读 2 个文件（manifest + 入口或 README），不是通读；monorepo 根清单
  信息薄时补读 1 个子包 manifest（最多 3 个）
- 匿名模式（无 token）：自动降级 REST api.github.com，10 搜索/分钟/IP
- 词典 99 词条，覆盖应用类/技术属性/领域/游戏/照片备份词；未命中靠你的翻译
- readme 补召回层只在候选池 <10 时触发（`in:readme` 不带 topic 限定
  是毒药——实测 `bidirectional links in:readme` 返回 youtube-dl/imgui
  这类 README 里"提到过"的巨无霸；带 `topic:` 限定后 24 个结果全是金矿）

## 目录结构

```
check-github-first/
├── SKILL.md          # 本文件
├── scout.mjs         # 入口：探查 + 深读
└── src/
    ├── net.mjs       # 代理探测（env→注册表→直连）+ 端点选择
    ├── transport.mjs # MCP(官方远程)/REST 双实现，统一出口
    ├── plan.mjs      # anchor/precise/tail 三通道规划
    ├── lexicon.mjs   # 中英小词典（兜底）
    ├── card.mjs      # 候选池卡片渲染（预排序+边界说明）
    └── inspect.mjs   # 深读：树→挑文件→借鉴卡
```
