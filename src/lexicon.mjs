// lexicon.mjs — 轻量中英开发词典（原型版：LLM 优先，词典兜底）
//
// 定位：agent LLM 是翻译主力；这本词典在两类场景兜底：
//   1. LLM 不可用/用户在无 agent 会话中直接跑脚本
//   2. LLM 翻译结果可疑时的高频词校准
// 收录原则：只收"高频开发概念"，不收长句。短语级映射（笔记应用→note-taking），
// 因为 GitHub 搜索里中文复合词不分解。

export const LEXICON = {
  // 应用/工具类
  '笔记': 'note-taking',
  '笔记应用': 'note-taking',
  '笔记软件': 'note-taking',
  '待办': 'todo',
  '待办事项': 'todo',
  '任务管理': 'task management',
  '看板': 'kanban',
  '敏捷开发': 'agile',
  '项目管理': 'project management',
  '团队协作': 'team collaboration',
  '日历': 'calendar',
  '时间跟踪': 'time tracking',
  '番茄钟': 'pomodoro',
  '习惯打卡': 'habit tracker',
  '记账': 'personal finance',
  '记账应用': 'personal finance',
  '阅读器': 'reader',
  'rss阅读器': 'rss reader',
  '终端': 'terminal',
  '终端模拟器': 'terminal emulator',
  '编辑器': 'editor',
  '文本编辑器': 'text editor',
  '代码编辑器': 'code editor',
  '截图': 'screenshot',
  '录屏': 'screen recording',
  '下载器': 'downloader',
  '下载工具': 'downloader',
  '剪贴板': 'clipboard',
  '同步': 'sync',
  '实时同步': 'realtime sync',
  '启动器': 'launcher',
  '壁纸': 'wallpaper',
  '翻译': 'translation',
  '输入法': 'input method',
  '字体': 'font',
  '图标': 'icon',

  // 技术属性
  '本地优先': 'local-first',
  '本地存储': 'local storage',
  '离线': 'offline',
  '自托管': 'self-hosted',
  '开源': 'open source',
  '跨平台': 'cross-platform',
  '命令行': 'cli',
  '桌面应用': 'desktop app',
  '浏览器扩展': 'browser extension',
  '浏览器插件': 'browser extension',
  '微信小程序': 'wechat miniprogram',
  '实时': 'realtime',
  '协同': 'collaborative',
  '协作': 'collaborative',
  '双链': 'bidirectional links',
  '双向链接': 'bidirectional links',
  '全文搜索': 'full-text search',
  '知识库': 'knowledge base',
  '知识管理': 'knowledge management',
  '个人知识管理': 'personal knowledge management',
  '白板': 'whiteboard',
  '思维导图': 'mind map',
  '文档': 'documentation',
  '文档站': 'documentation site',
  '静态站点': 'static site',
  '博客': 'blog',
  '图床': 'image hosting',
  '监控': 'monitoring',
  '仪表盘': 'dashboard',
  '爬虫': 'crawler',
  '代理': 'proxy',
  '加速': 'accelerator',

  // 游戏（V1 教训：游戏域此前 0 词条，全靠内嵌英文词自救）
  '像素风': 'pixel art',
  '像素画': 'pixel art',
  '平台跳跃': 'platformer',
  '游戏引擎': 'game engine',
  '游戏开发': 'game development',

  // 照片/备份（V4 教训：照片域此前 0 词条，多意图输入塌缩成单个歧义词）
  '照片': 'photo',
  '照片备份': 'photo backup',
  '备份': 'backup',
  '相册': 'photo gallery',
  '照片库': 'photo library',
  '照片管理': 'photo management',
  '智能分类': 'auto classification',
  '分类': 'classification',
  '人脸聚类': 'face clustering',
  '人脸识别': 'face recognition',

  // 领域
  '机器学习': 'machine learning',
  '深度学习': 'deep learning',
  '大模型': 'llm',
  '大语言模型': 'llm',
  '推理': 'inference',
  '向量数据库': 'vector database',
  '嵌入': 'embedding',
  '语义搜索': 'semantic search',
  '语音识别': 'speech recognition',
  '语音合成': 'text to speech',
  '文字转语音': 'text to speech',
  '图像识别': 'image recognition',
  '目标检测': 'object detection',
  '工业视觉': 'machine vision',
  '机器视觉': 'machine vision',
  '缺陷检测': 'defect detection',
}

/** 知名产品专名（V2 教训：把「像 X 那样」里的 X 直通为检索词，召回的是
 *  X 的插件/生态配件而非竞品产品）。仅用于 stderr 提示，不做降权——
 *  「这个专名在语境里是目标平台还是参照物」是上层 agent 的语义判断。 */
export const KNOWN_PRODUCTS = new Set([
  'obsidian', 'notion', 'logseq', 'evernote', 'roam', 'onenote', 'anki', 'joplin',
  'vscode', 'vim', 'emacs', 'intellij', 'eclipse',
  'figma', 'sketch', 'photoshop', 'canva',
  'slack', 'discord', 'telegram', 'whatsapp', 'wechat', 'dingtalk', 'feishu', 'lark',
  'linear', 'jira', 'trello', 'asana', 'clickup',
  'github', 'gitlab', 'gitee', 'bitbucket',
  'chatgpt', 'claude', 'gemini', 'copilot', 'midjourney',
  'wordpress', 'nginx', 'docker', 'kubernetes', 'k8s',
])

/**
 * 查词典：返回命中的英文词数组（全部子串命中，长词优先，去重）。
 * 未命中的中文短语不在返回值里（调用方决定如何提示）。
 *
 * 第二轮测试教训（R6 用例）：旧版子串循环"命中第一个即 break"，
 * 「一个支持全文搜索的文档站点生成器」只换出 full-text search 一个词，
 * '文档/文档站' 词条因插入序靠后永远轮不到——意图丢一半。
 * 现改为收集全部命中；一个长 token 可换出多个英文词。
 */
export function lexiconLookup(terms) {
  const hits = []
  const misses = []
  for (const t of terms) {
    const bare = t.replace(/"/g, '')
    if (LEXICON[bare]) { hits.push(LEXICON[bare]); continue }
    // 子串匹配：收集全部命中，按中文词条长度降序，长词优先；
    // 再做一次词内去冗余（V4 回归教训：「智能分类整理」同时命中
    // 智能分类→auto classification 和 分类→classification——短词是长词
    // 的纯子串时其英文已是长词翻译的一部分，再进查询只会重复）
    const matched = Object.entries(LEXICON)
      .filter(([zh]) => zh.length >= 2 && bare.includes(zh))
      .sort((a, b) => b[0].length - a[0].length)
    const kept = []
    for (const [zh, en] of matched) {
      const shadowed = kept.some(([z2, e2]) => z2.includes(zh) || e2.includes(en))
      if (!shadowed) kept.push([zh, en])
    }
    if (kept.length > 0) {
      hits.push(...kept.map(([, en]) => en))
    } else {
      misses.push(bare)
    }
  }
  return { hits: [...new Set(hits)], misses }
}
