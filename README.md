# check-github-first

> **动手造轮子之前，先看看有没有人已经做过。**

开发前探查 GitHub 的 agent skill / CLI：输入一个开发想法（中文随意说），
输出「该不该造、站在谁肩上、怎么借鉴」的决策依据——候选项目卡片
（多通道检索 + 公式排序）与选中仓库的借鉴卡（技术栈 / 架构 / 源码直链）。

```
$ node scout.mjs "手机照片自动备份到家里NAS的工具，智能分类整理，人脸聚类" --keywords "self-hosted photo backup"

🎯 开发前探查 —— 候选池卡片
| # | 项目                     | star  | 语言       | 预排 | 简介 |
| 1 | immich-app/immich        | 118.4k| TypeScript | 8.20 | High performance self-hosted photo and video management…
| 2 | photoprism/photoprism    | 40.4k | Go         | 7.57 | AI-Powered Photos App…
| 4 | LibrePhotos/librephotos  | 8.1k  | Python     | 6.63 | A self-hosted open source photo management service…
```

（↑ V 轮实测：教科书答案 Immich/PhotoPrism/LibrePhotos 全部命中）

## 为什么需要它

GitHub 官方 MCP Server / REST API 提供的是**手脚**（原子工具），但缺一个**探查大脑**：

| 手脚层（官方 API/MCP） | 大脑层（本 skill） |
|---|---|
| `search_repositories` 一个工具 | 三通道查询规划：anchor（宽词+stars 够头部）/ precise（长 AND 链字面命中）/ tail（同查询+updated，两排序结果集**不相交**——stars 版 0 个 <100★ 时 updated 版 28 个，够到 star 排序永远看不见的活跃小项目） |
| 返回原始 JSON | 候选池卡片：预排序公式 + 通道多样性席位（防 star 偏置淹没垂直项目）+ 诚实边界说明 |
| 搜不到就是搜不到 | 知名项目缺口检查：`--probe` 反查头部项目的 topics 作为查询种子（实测 litemall 0 → #1） |
| 中文想法直接搜（搜不到） | 中文→英文检索词：LLM 翻译优先，词典兜底，都不行则拒绝并教你（GitHub 头部项目几乎都用英文自我描述） |
| 裸 fetch（企业网全超时） | 代理自动探测（env → Windows 注册表 → 直连），真实企业网验证通过 |
| README 正文不索引 | readme 补召回（仅候选池 <10 时，带全量硬约束限定，实测不带限定是毒药） |

## 安装

### 作为 agent skill（DSH / Claude 等）

把本仓库克隆到 skill 目录：

```bash
git clone https://github.com/SuTn/check-github-first.git ~/.agents/skills/check-github-first
cd ~/.agents/skills/check-github-first && npm i
```

agent 按 `SKILL.md` 里的五步工作流执行：需求分诊 → 检索 → 打分 → 深读 → 结论。

### 作为独立 CLI（无 agent）

```bash
git clone https://github.com/SuTn/check-github-first.git
cd check-github-first && npm i
export GITHUB_TOKEN=github_pat_xxx   # 可选；无 token 自动降级匿名 REST
node scout.mjs "本地优先的 Markdown 笔记应用，支持双向链接"
```

- 依赖：Node ≥ 20，`undici`（唯一运行时依赖）
- Token：fine-grained PAT，public repo 只读即可
  （github.com/settings/personal-access-tokens → Generate → Public repos read-only）。
  有 token 走官方远程 MCP 端点（api.githubcopilot.com/mcp/），
  无 token 降级 REST api.github.com（10 搜索/分钟/IP）
- 企业网/国内网络无需配置，脚本自动探测系统代理

## 用法

```bash
# 探查：候选池卡片（stdout）+ 过程日志（stderr）
node scout.mjs "想法描述" [--keywords "english terms"] [--lang typescript]
                          [--license mit] [--min-stars 100] [--active]
                          [--anchor owner/repo] [--quick]

# 深读选中仓库：树 + manifest + README → 借鉴卡（每仓库 ≤3 请求）
node scout.mjs --inspect immich-app/immich logseq/logseq

# 锚点反查：拿参照项目的 topics 做查询种子（词面检索够不到的救星）
node scout.mjs --probe grafana/loki
```

## 五步流水线（SKILL.md 有完整 agent 指令）

1. **需求分诊**：三层拷问（找来用还是参考写？硬约束？锚点项目？）把想法
   变成检索参数——每个问题必须落地为一个检索变量，否则不问
2. **语言处理**：中文想法 → 英文检索词（LLM 翻译优先，~75 词条词典兜底）。
   关键词顺序 = 通道权重：前 2 词进 anchor、前 4 词进 precise。专名是锚点
   不是检索词（「像 Obsidian 那样」→ knowledge base）；多意图想法先拆分
3. **查询规划**：三通道 + 两个自适应补召回（候选池 <10 → readme 补召回；
   precise 0 行 → 链后段独有词补一搜，意图分词不随通道全灭）
4. **执行**：3 次搜索/想法的配额纪律，瞬时失败自动重试 1 次，429 立即停
5. **打分与深读**：LLM 给 relevance（0-10）+ 理由，代码算
   `relevance × (1 + log10(max(stars,10)+1)) / 2`，两区物理隔离；
   深读每仓库 ≤3 请求输出借鉴卡

## 诚实性纪律（不可违反）

1. **空结果 ≠ 不存在**——GitHub 搜索只匹配 name/description/topics，
   检索够不到就说「这条查询够不到」
2. **公式分不可由 LLM 指定**——relevance 是判断（可错），final 是代码算的（可复算）
3. **未测过的数字不写成 0**——失败通道显示「行数未知」
4. **拒绝 > 垃圾**——没有英文检索词时宁可拒绝并教用户，不返回无关结果

## 设计原则：CLI 与 agent 的分工

- **CLI 层只做**：执行、配额纪律、公式计算、信号传递（词典未命中的中文
  片段数、含知名产品专名等 → stderr 提示上层）
- **语义判断留给 agent**：专名在语境里是目标平台还是参照物、多意图怎么
  拆、概念怎么翻译——词典/黑名单永远覆盖不全世界知识，这是 ~38 个测试
  用例反复验证出的边界（V2：专名直通导致 top10 里 8 个是插件生态配件；
  V4：42 字 4 意图输入塌缩成单个歧义词 "nas"）

## 测试记录

~38 个用例、24 项修复，全部在真实企业网 + 官方远程 MCP 端点下实测：

- ✅ 中文想法全链路：「本地优先 Markdown 笔记+双链」→ siyuan/logseq/
  note-gen/MiaoYan/reor/TriliumNext 全命中
- ✅ 锚点反查：probe litemall topics 后 0 → #1；probe miniflux → #3
- ✅ 双跑一致性：同参数隔 10s 跑两次，33 行卡片逐字一致（含并列分内部顺序）
- ✅ 多意图拆分（SKILL.md 规则生效后）：Immich #1 / PhotoPrism #2 / LibrePhotos #4
- ✅ 防御层：专名输入不再塌缩成生态配件清单（outline #1、doca #2）
- ✅ monorepo 深读：plane（6171 项树 + apps/admin 栈）、memos（web 栈 + Go 入口）

## 与 dsh-find-ideas 的关系

查询规划 / 排序公式 / 诚实性原则借鉴自
[tianyao2003/dsh-find-ideas](https://github.com/tianyao2003/dsh-find-ideas)
（DSH 插件，13.4k 行 TypeScript，工程严谨度极高，强烈推荐读它的源码注释）。

| | dsh-find-ideas | check-github-first |
|---|---|---|
| 传输 | 直连 REST（自管限流/重试） | 官方远程 MCP 端点（协议层官方维护），REST 降级 |
| 代理 | 检测到只提示不解决 | 自动探测（env→Windows 注册表→直连） |
| 形态 | DSH 插件（仅 DSH 可用） | 通用 skill（任何 agent + Node） |
| 规模 | 13.4k 行，四工具全链路 | ~600 行，聚焦探查核心价值 |

## 目录结构

```
check-github-first/
├── SKILL.md          # agent 指令：五步工作流 + 诚实性纪律
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

## License

MIT
