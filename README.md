# check-github-first

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.18-green.svg)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/SuTn/check-github-first/pulls)

> **动手造轮子之前，先看看有没有人已经做过。**
> **Before building the wheel, check whether someone already built it.**

[中文](#中文文档) · [English](#english)

## Demo · 43 秒看懂它是干嘛的

<video src="https://github.com/user-attachments/assets/40fa8c40-8aac-4527-9419-1d46a540b1ce" controls muted loop playsinline width="100%"></video>

---

## 中文文档

开发前探查 GitHub 的 agent skill / CLI：输入一个开发想法（中文随意说），
输出「该不该造、站在谁肩上、怎么借鉴」的决策依据——候选项目卡片
（多通道检索 + 公式排序）与选中仓库的借鉴卡（技术栈 / 架构 / 源码直链）。

```
$ node scout.mjs "手机照片自动备份到家里NAS的工具，智能分类整理，人脸聚类" --keywords "self-hosted photo backup"

🎯 开发前探查 —— 候选池卡片
| # | 项目                    | star  | 最近推送   | 语言       | 预排 | 命中通道       | 简介 |
| 1 | immich-app/immich       | 118.4k| 2026-11-07 | TypeScript | 8.20 | anchor+precise | High performance self-hosted photo and video management… |
| 2 | photoprism/photoprism   | 40.4k | 2026-11-05 | Go         | 7.57 | anchor+precise | AI-Powered Photos App… |
| 3 | LibrePhotos/librephotos | 8.1k  | 2026-10-28 | Python     | 6.63 | precise        | A self-hosted open source photo management service… |
```

（↑ 实测：教科书答案 Immich/PhotoPrism/LibrePhotos 全部命中；表为节选，命中通道列略去 seat 后缀）

### 为什么需要它

GitHub 官方 MCP Server / REST API 提供的是**手脚**（原子工具），但缺一个**探查大脑**：

| 手脚层（官方 API/MCP） | 大脑层（本 skill） |
|---|---|
| `search_repositories` 一个工具 | 三通道查询规划：anchor（宽词+stars 够头部）/ precise（长 AND 链字面命中）/ tail（有 precise 时用 precise 前 3 词 + updated，否则用 anchor 核心词 + updated；两排序结果集**不相交**——stars 版 0 个 <100★ 时 updated 版 28 个，够到 star 排序永远看不见的活跃小项目） |
| 返回原始 JSON | 候选池卡片：预排序公式 + 通道多样性席位（防 star 偏置淹没垂直项目）+ 诚实边界说明 |
| 搜不到就是搜不到 | 知名项目缺口检查：`--probe` 反查头部项目的 topics 作为查询种子（实测 litemall 0 → #1） |
| 中文想法直接搜（搜不到） | 中文→英文检索词：LLM 翻译优先，词典兜底，都不行则拒绝并教你（GitHub 头部项目几乎都用英文自我描述） |
| 裸 fetch（企业网全超时） | 代理自动探测（env → Windows 注册表 → 直连），真实企业网验证通过 |
| README 正文不索引 | readme 补召回（仅候选池 <10 时，带全量硬约束限定，实测不带限定是毒药） |

### GITHUB_TOKEN 完全可选

- **不设置** → 自动降级匿名 REST（api.github.com，10 搜索/分钟/IP，单次探查够用）
- **设置** → 官方远程 MCP 端点（api.githubcopilot.com/mcp/），远程 MCP 的配额以官方说明为准
- token 只需 fine-grained PAT + public repo 只读：
  github.com/settings/personal-access-tokens → Generate → Public repos read-only
- 企业网/国内网络无需配置，脚本自动探测系统代理

### 安装

#### 方式一：让 agent 自己装（推荐）

把仓库链接发给你的 agent，一句话即可，它会自己完成安装和验证：

```
把 https://github.com/SuTn/check-github-first 装到你的技能目录
（clone → npm i，唯一依赖 undici）→ 用 node scout.mjs "quick check" --quick 冒烟验证
→ 读一遍 SKILL.md，以后我提开发想法时按它的分步工作流帮我探查。
```

更省事的说法（agent 自己会看 README/SKILL.md 摸索出步骤）：

```
https://github.com/SuTn/check-github-first —— 装好这个 skill，
然后帮我探查「本地优先的 Markdown 笔记应用，支持双向链接」
```

常见技能目录：DSH `~/.agents/skills/`、Claude Code `~/.claude/skills/`、
其他 agent clone 到任意目录读 SKILL.md 即可。更新：`git pull`。

#### 方式二：手动安装为 agent skill

```bash
git clone https://github.com/SuTn/check-github-first.git ~/.agents/skills/check-github-first
cd ~/.agents/skills/check-github-first && npm i
```

#### 方式三：独立 CLI（无 agent）

```bash
git clone https://github.com/SuTn/check-github-first.git
cd check-github-first && npm i
export GITHUB_TOKEN=github_pat_xxx   # 可选，见上文
node scout.mjs "本地优先的 Markdown 笔记应用，支持双向链接"
```

依赖：Node ≥ 20.18.1，`undici`（唯一运行时依赖）。

### 用法

```bash
# 探查：候选池卡片（stdout）+ 过程日志（stderr）
node scout.mjs "想法描述" [--keywords "english terms"] [--lang typescript]
                          [--license mit] [--min-stars 100] [--active]
                          [--anchor owner/repo] [--quick]

# 帮助 / 版本
node scout.mjs --help      # 或 -h
node scout.mjs --version

# 深读选中仓库：树 + manifest + README → 借鉴卡（每仓库 ≤4 请求，典型 2–3 次；最多 5 个）
node scout.mjs --inspect immich-app/immich logseq/logseq

# 锚点反查：拿参照项目的 topics 做查询种子（词面检索够不到的救星）
node scout.mjs --probe grafana/loki
```

### 分步工作流（SKILL.md 有完整 agent 指令）

1. **需求分诊**：分层拷问（找来用还是参考写？硬约束？锚点项目？）把想法
   变成检索参数——每个问题必须落地为一个检索变量，否则不问
2. **语言处理**：中文想法 → 英文检索词（LLM 翻译优先，99 词条词典兜底）。
   关键词顺序 = 通道权重：前 2 词进 anchor、前 4 词进 precise。专名是锚点
   不是检索词（「像 Obsidian 那样」→ knowledge base）；多意图想法先拆分
3. **查询规划**：三通道 + 两个自适应补召回（候选池 <10 → readme 补召回；
   precise 0 行 → 链后段独有词补一搜，意图分词不随通道全灭）
4. **执行**：基础 3 次搜索，最多 2 次补搜（precise 0 行 / 候选池不足），
   上限 5 次；瞬时失败自动重试 1 次（不计入配额），429 立即停
5. **打分与深读**：CLI 只算预排序（star 权重 × 新鲜度 × 词位）；LLM 给
   relevance（0-10）+ 理由后，按 SKILL.md 的公式自行算 final（可复算），
   两区物理隔离；深读每仓库 ≤4 请求（典型 2–3 次）输出借鉴卡

### 诚实性纪律（不可违反）

1. **空结果 ≠ 不存在**——GitHub 搜索只匹配 name/description/topics，
   检索够不到就说「这条查询够不到」
2. **最终分不可由 LLM 直接指定**——relevance 是 LLM 判断（可错），final 由
   agent 套 SKILL.md 的公式计算（可复算），CLI 只输出预排序
3. **未测过的数字不写成 0**——失败通道显示「行数未知」
4. **拒绝 > 垃圾**——没有英文检索词时宁可拒绝并教用户，不返回无关结果

### 设计原则：CLI 与 agent 的分工

- **CLI 层只做**：执行、配额纪律、预排序计算、信号传递（词典未命中的中文
  片段数、含知名产品专名等 → stderr 提示上层）
- **语义判断留给 agent**：专名在语境里是目标平台还是参照物、多意图怎么
  拆、概念怎么翻译——词典/黑名单永远覆盖不全世界知识，这是 ~38 个历史测试
  用例反复验证出的边界（V2：专名直通导致 top10 里 8 个是插件生态配件；
  V4：42 字 4 意图输入塌缩成单个歧义词 "nas"）

### 测试记录

~38 个用例、24 项修复，全部在真实企业网 + 官方远程 MCP 端点下实测（历史用例为
人工执行；其中可自动化的回归子集见仓库 test/，`npm test`）：

- ✅ 中文想法全链路：「本地优先 Markdown 笔记+双链」→ siyuan/logseq/
  note-gen/MiaoYan/reor/TriliumNext 全命中
- ✅ 锚点反查：probe litemall topics 后 0 → #1；probe miniflux → #3
- ✅ 双跑一致性：同参数隔 10s 跑两次，33 行卡片逐字一致（含并列分内部顺序）
- ✅ 多意图拆分（SKILL.md 规则生效后）：Immich #1 / PhotoPrism #2 / LibrePhotos #4
- ✅ 防御层：专名输入不再塌缩成生态配件清单（outline #1、doca #2）
- ✅ monorepo 深读：plane（6171 项树 + apps/admin 栈）、memos（web 栈 + Go 入口）

### 目录结构

```
check-github-first/
├── SKILL.md          # agent 指令：分步工作流 + 诚实性纪律
├── scout.mjs         # CLI 入口：探查 / 深读 / 锚点反查
├── package.json
└── src/
    ├── net.mjs       # 代理探测（env→注册表→直连）+ 端点选择
    ├── transport.mjs # MCP(官方远程)/REST 双实现，统一出口
    ├── plan.mjs      # 三通道规划 + 补召回查询
    ├── lexicon.mjs   # 中英词典（兜底）+ 专名提示表
    ├── card.mjs      # 候选池卡片（预排序 + 席位 + 边界说明）
    └── inspect.mjs   # 深读：树 → 挑文件 → 借鉴卡
```

### License

MIT

---

## English

An agent skill / CLI that scouts GitHub **before** you start building:
describe your idea in any language (Chinese works out of the box) and get
the decision inputs — a candidate-pool card (multi-channel search +
formula ranking) and reference cards for the repos you pick
(tech stack / architecture / direct source links).

```
$ node scout.mjs "a local-first markdown note app with bidirectional links"

🎯 开发前探查 —— 候选池卡片
| # | 项目                    | star  | 最近推送   | 语言          | 预排 | 命中通道       | 简介 |
| 1 | siyuan-note/siyuan      | 36.6k | 2026-11-06 | TypeScript    | 7.60 | anchor+precise | A privacy-first personal knowledge management software… |
| 2 | logseq/logseq           | 37.2k | 2026-11-03 | ClojureScript | 7.60 | anchor+precise | A privacy-first, open-source knowledge base… |
```

The card is printed in Chinese (title and column names included); columns are
#, repo, stars, last push, language, pre-rank, hit channels, description.
Excerpt; seat suffixes omitted.

### Why it exists

The official GitHub MCP Server / REST API gives you **hands** (atomic
tools) but not a **scouting brain**:

| Hands layer (official API/MCP) | Brain layer (this skill) |
|---|---|
| A single `search_repositories` tool | Three-channel query planning: anchor (broad terms + stars, reaches domain leaders) / precise (long AND chain, literal matches) / tail (precise's first 3 terms + updated sort when precise exists, otherwise the anchor core terms + updated sort — the two result sets are **disjoint**: when the stars-sorted page holds 0 repos under 100★, the updated-sorted page holds 28, reaching active small projects star-sorting never shows) |
| Raw JSON | Candidate-pool card: pre-ranking formula + channel diversity seats (prevents star bias from drowning vertical projects) + honest boundary notes |
| "Not found" is the end of the story | Known-project gap check: `--probe` reads a domain leader's topics as query seeds (field-tested: litemall 0 → #1) |
| Non-English queries find nothing | Chinese→English search terms: LLM translation first, lexicon fallback, refuse-and-teach if both fail (top GitHub projects describe themselves in English) |
| Bare fetch (corporate networks time out) | Proxy auto-detection (env → Windows registry → direct), verified on a real corporate network |
| README bodies are not indexed | Readme recall (only when the pool <10, with every hard filter attached — field-tested: unqualified `in:readme` is poison) |

### GITHUB_TOKEN is fully optional

- **Not set** → automatic anonymous REST fallback (api.github.com, 10 searches/min/IP — enough for a single scouting run)
- **Set** → official remote MCP endpoint (api.githubcopilot.com/mcp/); the remote MCP quota follows GitHub's official documentation
- The token only needs to be a fine-grained PAT with public-repo read-only access:
  github.com/settings/personal-access-tokens → Generate → Public repos read-only
- Corporate networks need no configuration — the script auto-detects the system proxy

### Install

#### Option 1: let your agent install it (recommended)

Just send the repo URL to your agent with one sentence — it will install
and verify by itself:

```
Install https://github.com/SuTn/check-github-first into your skill directory
(clone → npm i, undici is the only dependency) → smoke-test with
node scout.mjs "quick check" --quick → read SKILL.md, then follow its
step-by-step workflow whenever I bring up a build idea.
```

Or even shorter (the agent will figure out the steps from README/SKILL.md):

```
https://github.com/SuTn/check-github-first — install this skill,
then scout "a local-first markdown note app with bidirectional links" for me.
```

Common skill directories: DSH `~/.agents/skills/`, Claude Code
`~/.claude/skills/`; any other agent can clone it anywhere and read
SKILL.md. To update: `git pull`.

#### Option 2: install manually as an agent skill

```bash
git clone https://github.com/SuTn/check-github-first.git ~/.agents/skills/check-github-first
cd ~/.agents/skills/check-github-first && npm i
```

#### Option 3: standalone CLI (no agent)

```bash
git clone https://github.com/SuTn/check-github-first.git
cd check-github-first && npm i
export GITHUB_TOKEN=github_pat_xxx   # optional, see above
node scout.mjs "a local-first markdown note app with bidirectional links"
```

Requirements: Node ≥ 20.18.1, `undici` (the only runtime dependency).

### Usage

```bash
# Scout: candidate-pool card (stdout) + process log (stderr)
node scout.mjs "your idea" [--keywords "english terms"] [--lang typescript]
                          [--license mit] [--min-stars 100] [--active]
                          [--anchor owner/repo] [--quick]

# Help / version
node scout.mjs --help      # or -h
node scout.mjs --version

# Deep-read the shortlist: tree + manifest + README → reference card (≤4 requests per repo, typically 2–3; max 5 repos)
node scout.mjs --inspect immich-app/immich logseq/logseq

# Anchor probe: read a reference repo's topics as query seeds
node scout.mjs --probe grafana/loki
```

### The step-by-step workflow (full agent instructions in SKILL.md)

1. **Requirement triage**: three rounds of questions (use as-is or as a
   reference? hard constraints? anchor project?) that turn the idea into
   search parameters — every question must map to a search variable, or it is not asked
2. **Language processing**: Chinese ideas → English search terms (LLM
   translation first, a 99-entry lexicon as fallback). Keyword order =
   channel weight: the first 2 terms feed anchor, the first 4 feed
   precise. Proper nouns are anchors, not search terms ("like Obsidian" →
   knowledge base); multi-intent ideas are split first
3. **Query planning**: three channels + two adaptive recalls (pool <10 →
   readme recall; precise returns 0 rows → a fallback search on the
   chain's tail terms, so tail intents don't die with the channel)
4. **Execution**: base 3 searches per idea, at most 2 adaptive recall
   searches (precise returns 0 / pool under 10), cap 5; one automatic
   retry on transient failures (not counted), full stop on 429
5. **Scoring & deep-read**: the CLI computes only the pre-rank (star
   weight × freshness × term position); the LLM assigns relevance (0-10)
   with reasons, then the agent computes final with SKILL.md's formula
   (reproducible); the two zones stay physically separated. Deep-read
   costs ≤4 requests per repo (typically 2–3) and emits a reference card

### Honesty rules (non-negotiable)

1. **An empty result ≠ nonexistence** — GitHub search only matches
   name/description/topics; if a query can't reach it, say exactly that
2. **Final scores are never LLM-assigned** — relevance is judgment
   (fallible); the agent computes final with SKILL.md's formula
   (reproducible); the CLI only emits the pre-rank
3. **Untested numbers are never written as 0** — failed channels show
   "row count unknown"
4. **Refuse over garbage** — with no English search terms, refuse and
   teach the user instead of returning irrelevant results

### Design principle: division of labor between CLI and agent

- **The CLI only does**: execution, quota discipline, pre-rank math, and
  signal passing (untranslated Chinese fragments, known product proper
  nouns, … → stderr hints for the upper layer)
- **Semantic judgment belongs to the agent**: whether a proper noun is
  the target platform or a reference, how to split multi-intent input,
  how to translate concepts — lexicons/blocklists can never cover world
  knowledge. This boundary was hammered out over ~38 historical test cases
  (V2: passing a proper noun through turned the top-10 into 8
  ecosystem add-ons; V4: a 42-character four-intent input collapsed
  into a single ambiguous token "nas")

### Test record

~38 cases and 24 fixes, all field-tested on a real corporate network
through the official remote MCP endpoint (historical runs were manual; the
automatable regression subset lives in test/, run with `npm test`):

- ✅ Chinese idea, full pipeline: "local-first markdown notes +
  bidirectional links" → siyuan/logseq/note-gen/MiaoYan/reor/TriliumNext all hit
- ✅ Anchor probe: probing litemall's topics took it from 0 → #1; miniflux → #3
- ✅ Double-run determinism: same args 10s apart, 33-line cards
  byte-identical (including the internal order of tied scores)
- ✅ Multi-intent split (after the SKILL.md rules): Immich #1 / PhotoPrism #2 / LibrePhotos #4
- ✅ Defensive layers: proper-noun input no longer collapses into an
  ecosystem-parts list (outline #1, doca #2)
- ✅ Monorepo deep-read: plane (6171-item tree + apps/admin stack),
  memos (web stack + Go entry)

### Repository layout

```
check-github-first/
├── SKILL.md          # agent instructions: step-by-step workflow + honesty rules
├── scout.mjs         # CLI entry: scout / deep-read / anchor probe
├── package.json
└── src/
    ├── net.mjs       # proxy detection (env→registry→direct) + endpoint selection
    ├── transport.mjs # MCP (official remote) / REST dual implementation
    ├── plan.mjs      # three-channel planning + recall queries
    ├── lexicon.mjs   # zh→en lexicon (fallback) + proper-noun hint table
    ├── card.mjs      # candidate-pool card (pre-ranking + seats + boundary notes)
    └── inspect.mjs   # deep-read: tree → pick files → reference card
```

### License

MIT
