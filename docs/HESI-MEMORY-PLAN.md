# Hesi 跨会话长期记忆 + 自动总结压缩 工程方案

> 目标：给 Hesi 增加「跨会话 AI 长期记忆」与「会话自动总结压缩」两类能力，并重构会话呈现方式。
> 约束：**杜绝单体臃肿文件**（每个模块单一职责，行数预算 ≤ 220 行，超限即拆）；**离线优先 / 本地优先**（与 Hesi 定位一致，不依赖外部云服务）；**向后兼容**（旧的单全局对话不丢）；**确定性降级**（无 LLM / 无嵌入模型时核心功能仍可用）。
>
> 本文档足够详细，新开会话可直接照「实施里程碑」逐步执行；所有接入点均给出真实文件路径与行号。

---

## 0. 为什么做（现状与缺口，已代码实证）

通过核查现有代码确认：

- `public/components/chat-panel.js`
  - `this.messages` 是**单一全局对话**（无 session 概念）。
  - `_saveHistory()`（685–698 行）：仅把 `user/assistant` 消息 `slice(-50)` 存进 `localStorage['qcli-chat-history']`；刷新可恢复，但**清浏览器即丢**、且**最多 50 条**、无服务端落盘。
  - `sendMessage()`（783 行）：`this.messages.slice(-50)` 发给后端。
- `public/chat-api.js`
  - `sendMessage()`（111–142 行）：`POST /api/chat`，body 只含 `messages` + 鉴权，**没有 sessionId**。
- `routes/chat/index.js`
  - `POST /api/chat`（263 行起）：从 `req.body.messages` 收全量，**后端不存储任何会话状态**（无 Map / DB / 文件）。
  - `routes/chat/tools.js`：**无** `memory/remember/recall` 类工具。
- `routes/chat/utils.js`
  - `trimHistory()`（30–36 行）：历史 > 10 万 token 时**截断**（只留 system + 最近 20 条，丢弃中间），**不是摘要压缩**。
- `routes/chat/discuss.js`：仅「圆桌讨论」模式结尾 `runSummary()` 一次性汇总，**非常规聊天的自动压缩**。

**结论**：当前 Hesi 无跨会话记忆、无自动摘要；唯一的"压缩"是粗暴截断。本方案替换这套机制。

---

## 1. 设计原则

1. **模块化、反单体**：按职责拆成 `lib/memory/*` 小模块，单一入口 `lib/memory/index.js` 对外暴露门面；路由与前端只依赖门面。每个文件 ≤ 220 行，超则拆子模块。
2. **后端拥有记忆（服务端落盘）**：记忆存 `data/memory/`（已有 `data/` 目录，存 jsonl/json，重启/清浏览器都不丢）。原因：记忆应跨浏览器刷新与重启持久；AI 跑在服务端，由它在拼 system 时注入召回内容最自然。
3. **前端只负责呈现与会话管理**：发起 `sessionId`、渲染会话列表、记忆抽屉；不负责记忆算法。
4. **离线优先**：默认检索用纯 JS 的 BM25（零依赖）；语义向量检索做成**可选插件**（`embed.js` 懒加载，仅当 `HESI_MEMORY_EMBED=1` 且配置了本地模型路径才启用）。
5. **确定性降级**：LLM 不可用时，归档/检索/会话列表照常工作，仅「摘要/画像」退化为"保留最近 N 条原文"。
6. **幂等追加**：前端可重复发窗口消息，后端按消息稳定 `id` 去重合并，避免重复追加。

---

## 2. 参考：桌面版 WorkBuddy 的记忆与会话呈现（直接对标）

WorkBuddy 自身即最佳参考实现（来自其运行架构）：

**记忆三层（要照搬其形态，改为本地化）：**
- **Layer A 自动画像（Auto Profile）**：服务端生成的用户长期画像摘要，只读、自动注入每次会话上下文。→ Hesi 对应 `data/memory/profile.md` + `facts.json`。
- **Layer B 历史会话检索（Conversation Retrieval）**：服务端对所有历史会话做排序检索，按需召回相关片段注入。→ Hesi 对应 `recall.relevant()` 读 `sessions/*.json` 的摘要/事实。
- **Layer C 工作区/用户记忆（Curated Notes）**：人工维护的长期笔记（如 `MEMORY.md`、每日日志）。→ Hesi 对应 `data/memory/daily/*.md` + `notes.md`。

**会话呈现（UI 对标）：**
- 持久、可续聊的会话列表在侧栏；
- 每个会话用**首条用户消息自动生成标题**；
- 按时间分组（今天 / 昨天 / 更早）；
- 顶部有**搜索框**；
- 记忆是**隐式自动注入**的，同时提供一处可查看/遗忘的「记忆」表面；
- 显示状态/规模指示（消息数、token 估算、是否贡献了画像的 🧠 标记）。

本方案第 9 节的 UI 即按上述形态实现，使 Hesi 与桌面版 WorkBuddy 体感一致。

---

## 3. 总体架构（数据流）

```
┌─────────── 前端 (browser) ───────────┐         ┌────────── 后端 (Node) ──────────┐
│ chat-panel.js                          │         │ routes/chat/index.js           │
│  - 管理 sessionId / 会话列表           │  POST    │  POST /api/chat                │
│  - 发消息(带 sessionId)                │ ───────▶ │   1. session.ensure(sessionId) │
│  - 记忆抽屉 / 搜索框                   │          │   2. archive.append(sessionId, │
│                                         │          │        deltaMsgs)  ←幂等      │
│ memory/                                │          │   3. recall.relevant(          │
│  - session-list.js (左栏列表)          │ ◀─────── │        lastUserMsg) → 注入      │
│  - memory-panel.js (🧠抽屉)            │  GET/POST │      <memory> system 块        │
│                                         │          │   4. compaction.maybeCompact( │
│                                         │          │        sessionId)  ←超限摘要   │
│                                         │          │   5. 调 LLM，SSE 回传         │
│                                         │          │   6. archive.commit(session) │
│                                         │          │   7. profile/抽取(异步/空闲)  │
└─────────────────────────────────────────┘         └──────────┬────────────────────┘
                                                              │ 落盘
                                                        data/memory/
                                                         ├─ sessions/<id>.json
                                                         ├─ facts.json
                                                         ├─ profile.md
                                                         ├─ daily/<YYYY-MM-DD>.md
                                                         └─ index.json (轻量检索索引)
```

---

## 4. 目录结构与文件职责（模块化，反单体）

```
lib/memory/
  index.js          # 门面：导出 MemoryStore 对象（ensure/append/commit/recall/compact/...）
  config.js         # 路径、阈值、模型选择、特性开关（HESI_MEMORY_EMBED 等）
  schema.js         # 数据结构校验 + 稳定 id 生成（createMessageId）
  storage.js        # 低层文件 IO：原子写（写临时文件+rename）、读取、迁移、锁
  session.js        # 单会话模型：加载/保存/追加(幂等)/切分 working window
  archive.js        # 会话归档编排：list/get/create/rename/delete/search（调 storage+session）
  recall.js         # 跨会话召回：汇总 facts + 相关历史摘要，产出 <memory> 文本块
  index-store.js    # 轻量检索索引：构建/更新/查询（BM25 over 标题+摘要+事实）
  compaction.js     # 自动总结压缩引擎：触发判定 + 调 LLM 生成摘要 + 滚动合并
  profile.js        # Layer A：从摘要抽取持久事实 → upsert facts.json + 重生成 profile.md
  embed.js          # 可选本地向量：懒加载；无依赖时整体禁用（不报错）
  llm-bridge.js     # 统一调用 LLM 做摘要/抽取（复用 routes/chat 的 provider/key 解析）

routes/memory/        # 独立路由模块，挂载到 /api/memory
  index.js           # 聚合 router
  sessions.js        # GET/POST/DELETE /api/memory/sessions[/:id]，rename
  recall.js          # POST /api/memory/recall（前端记忆抽屉/调试用）
  compact.js         # POST /api/memory/compact（手动触发压缩）
  facts.js           # GET/DELETE /api/memory/facts（查看/遗忘事实）

public/memory/
  session-store.js   # 前端会话状态（当前 sessionId、列表缓存），替代 localStorage 单历史
  session-list.js    # 左栏「会话」组件：搜索框 + 时间分组 + 项渲染 + 新建/删除/改名
  session-item.js    # 单个会话行：标题、相对时间、规模、🧠 标记、active 高亮
  memory-panel.js    # 「🧠 记忆」抽屉：本会话召回内容 + 用户画像 + 遗忘按钮

scripts/
  memory-migrate.js  # 一次性迁移：把 localStorage['qcli-chat-history'] 导入为首个 session
  memory-smoke.js    # 冒烟：建会话→追加→召回→压缩→读回，验证全链路（供 CI/手动）
```

> **行数纪律**：任一 `lib/memory/*.js` 超过 220 行即拆（如 `compaction.js` 若膨胀，把「LLM 提示词」抽到 `compaction-prompts.js`；`index-store.js` 检索算法复杂则拆 `bm25.js`）。路由文件只做参数校验与转发，不含业务逻辑。

---

## 5. 数据模型（schema，存 `data/memory/`）

### 5.1 `sessions/<sessionId>.json`
```json
{
  "id": "s_20260723_a1b2",
  "title": "如何给 Hesi 加记忆？",
  "createdAt": 1753200000000,
  "updatedAt": 1753203600000,
  "model": "gpt-4o-mini",
  "provider": "openai",
  "tokenEstimate": 18200,
  "summary": "用户想给 Hesi 做跨会话记忆与自动压缩；已确认现状无记忆、只有截断。",
  "summaryUpdatedAt": 1753203500000,
  "workingWindow": 24,
  "messages": [
    { "id": "m_001", "role": "user", "content": "...", "ts": 1753200001000, "tokens": 12 },
    { "id": "m_002", "role": "assistant", "content": "...", "ts": 1753200003000, "tokens": 240 }
  ]
}
```
- `messages` 仅存 **working window**（最近 N 条原文）；更旧的已被压缩进 `summary`。
- `id` 为稳定消息 id（前端生成，见 7.1），用于幂等追加去重。

### 5.2 `facts.json`（Layer A 持久事实）
```json
[
  { "id": "f_001", "fact": "用户偏好中文回复", "source": "s_20260723_a1b2",
    "confidence": 0.9, "createdAt": 1753200000000, "lastSeen": 1753203600000 }
]
```

### 5.3 `profile.md`（人类可读自动画像，由 facts 生成）
```markdown
# 用户画像（自动生成，请勿手改）
- 偏好中文回复
- 在做 Hesi 本地 AI 终端项目，关注记忆/压缩/离线
- 重视模块化、拒绝单体大文件
```

### 5.4 `daily/<YYYY-MM-DD>.md`（可选，追加式日志，对标 WorkBuddy 每日记忆）
### 5.5 `index.json`（检索索引，结构见 7.3）

---

## 6. 配置项（`lib/memory/config.js`）

```js
module.exports = {
  ROOT: path.join(__dirname, '../../data/memory'),   // 落盘根
  WORKING_WINDOW: 24,        // 保留原文的最近轮数
  COMPACT_THRESHOLD: 60000,  // token 估算超此值触发压缩（约 70% 上下文）
  IDLE_COMPACT_MS: 120000,   // 空闲 2 分钟也触发一次
  TOPK_RECALL: 5,            // 召回相关事实/历史条数
  PROFILE_MIN_FACTS: 3,      // 累计多少条事实后重生成 profile.md
  EMBED_ENABLED: process.env.HESI_MEMORY_EMBED === '1',
  EMBED_MODEL_PATH: process.env.HESI_MEMORY_EMBED_MODEL || '',
};
```

---

## 7. 核心算法

### 7.1 会话归档与幂等追加（`session.js` + `archive.js`）
- 前端每条消息带稳定 `id`（`schema.createMessageId()` = `m_<递增序号或hash>`），首次发会话时若 `sessionId` 为空，由前端生成 `s_<YYYYMMDD>_<随机>` 并缓存到 `session-store.js`。
- 后端 `archive.append(sessionId, delta)`：
  1. `session.ensure(sessionId)`：文件不存在则建（标题取 delta 中首条 user 消息前 20 字）。
  2. 按 `id` 合并 `delta` 到 `session.messages`，已存在则跳过（幂等）。
  3. 重算 `tokenEstimate`（复用 `utils.estimateTokenCount` 的单句估算 `Math.ceil(len/2)`）。
  4. 原子写回（`storage.atomicWrite`）。
- 前端不再 `slice(-50)` 发给后端；改为发 `{ sessionId, messages: this.messages }`（或全部，后端自行去重）。**替换点**：`chat-panel.js:783` 与 `chat-api.js:119`。

### 7.2 自动总结压缩（`compaction.js`）—— 取代 `trimHistory` 的截断
**触发条件（满足任一）：**
- `session.tokenEstimate > COMPACT_THRESHOLD`；
- 距 `summaryUpdatedAt` 超过 `IDLE_COMPACT_MS` 且会话有新消息；
- 会话「结束」（前端发 `session/close` 或 WebSocket 断开）。

**执行（仅在 LLM 可用时；否则跳过，保留原文）：**
1. 取 `messages` 中超出 `workingWindow` 的**旧消息段** `oldSeg`。
2. 调 `llm-bridge.summarize(oldSeg, prevSummary)`：提示词要求产出**结构化紧凑摘要**（保留：决策、事实、用户偏好、未决事项、关键代码/路径），语言与用户一致。
3. **滚动合并**：若已有 `summary`，把「旧 summary + 新段摘要」再让 LLM 压成一段（避免摘要无限增长）；否则直接采用新摘要。
4. 把 `oldSeg` 从 `messages` 移除，仅留 `workingWindow` 条原文；写回 `summary` 与 `summaryUpdatedAt`。

**注入**：每次新请求时，若存在 `summary`，后端在 system 前插入：
```
<session_summary>（本会话早期内容的压缩摘要，仅作背景参考）
…summary…
</session_summary>
```
> 这样上下文 = `[SELF_AWARE] + [session_summary] + [recalled memory] + workingWindow`，既保留近期原文、又保留远期语义，**不再有信息硬丢失**。`routes/chat/utils.js` 的 `trimHistory` 在接好 compaction 后改为「仅兜底」（超过模型硬上限才截断），不再作为主路径。

### 7.3 跨会话召回（`recall.js` + `index-store.js`）
- **索引构建**（`index-store.js`）：对每个 session 提取 `title + summary + facts` 作为可检索文档；对 `facts.json` 每条事实也建索引。`index.json` 存 `{ docs:[{ref, type, text, tokens, vec?}], ... }`。BM25 纯 JS 实现，零依赖。
- **查询** `recall.relevant(query, {topK})`：
  1. BM25 打分 `index.json` 中所有 doc，取 topK。
  2. 若 `EMBED_ENABLED`，用 `embed.js` 算 query 向量，对带 `vec` 的 doc 做余弦重排（向量缺失的 doc 不参与向量排序，但保留 BM25 结果）。
  3. 产出 `<memory>` 文本块：先列命中事实（来自 facts），再列相关历史会话摘要（标注来源 session 标题）。
- **注入**：后端在 `routes/chat/index.js` 拼 `contextMessages` 时（现约 300–353 行注入 terminal/SELF_AWARE 之处），调用 `recall.relevant(lastUserMsg)` 并插入 `<memory>` 块。**这就是"AI 记住你"的落地**。

### 7.4 用户画像 / 事实抽取（Layer A，`profile.js`）
- 每次 compaction 或会话 close 后（异步、不阻塞响应）：调 `llm-bridge.extractFacts(oldSeg)` 抽取持久事实。
- `upsertFacts(facts)`：按语义去重（相同 fact 累加 `confidence`、更新 `lastSeen`；低置信且长期未见的老化删除）。
- 当 facts 数 ≥ `PROFILE_MIN_FACTS` 或变更时，重生成 `profile.md`。
- `recall` 优先读 `facts.json` + `profile.md`，实现跨会话记忆。

---

## 8. 精确接入点（未来会话照做）

**后端：**
- `routes/chat/index.js`
  - `POST /api/chat`（263 行）：`req.body` 解构增加 `sessionId`（`264` 行附近）。
  - 在注入 `SELF_AWARE_PROMPT`（312–353 行）**之前**，插入：
    ```js
    const MemoryStore = require('../../lib/memory');
    await MemoryStore.ensure(sessionId);
    await MemoryStore.append(sessionId, deltaFromMessages(messages));
    const memoryBlock = await MemoryStore.recall(lastUserText);
    // 把 memoryBlock 作为 system 消息插入 contextMessages 最前
    const summaryBlock = await MemoryStore.getSummaryBlock(sessionId);
    ```
  - 移除/弱化 `trimHistory` 主路径（保留为硬上限兜底）。
  - 响应结束（`onDone`/SSE `[DONE]`）后：`MemoryStore.commit(sessionId)` + 异步 `compactIfNeeded` + `extractFacts`。
- `server.js` 或 `routes/index.js`：挂载 `require('./memory')(router)` 到 `/api/memory`（新增 `routes/memory/index.js`）。

**前端：**
- `public/chat-api.js` `sendMessage`（111–142 行）：参数加 `sessionId`，`body.sessionId = sessionId`（119 行附近）。
- `public/components/chat-panel.js`：
  - 用 `public/memory/session-store.js` 替代 `localStorage['qcli-chat-history']`（`_loadHistory` 685–693、`_saveHistory` 695–698 整段替换）。
  - `sendMessage`（757–849）：每条消息生成稳定 `id`；`msgs` 不再 `slice(-50)`，改为带 `sessionId` 发全量（或增量）；调用 `MemorySession.switch/create`。
  - 在聊天面板左侧挂载 `session-list.js` 组件（参考 WorkBuddy 侧栏）。
- 新增「🧠 记忆」入口按钮 → 打开 `memory-panel.js` 抽屉。

---

## 9. 会话显示 UI（参考桌面版 WorkBuddy）

**左栏「会话」列表（`public/memory/session-list.js`）：**
- 顶部**搜索框**（实时过滤标题/摘要，走 `GET /api/memory/sessions?q=`）。
- 列表按时间分组：**今天 / 昨天 / 更早 7 天 / 更早**。
- 每项（`session-item.js`）：
  - 标题（自动首条消息生成，可双击改名 → `PATCH /api/memory/sessions/:id`）
  - 相对时间（如「3 分钟前」）
  - 规模指示（消息数 / token 估算）
  - 🧠 标记：若该会话贡献过 facts 则显示
  - active 高亮；hover 显示删除（带确认）
- 顶部「＋ 新建会话」按钮（新建即生成新 `sessionId`，清空当前消息数组）。

**「🧠 记忆」抽屉（`public/memory/memory-panel.js`）：**
- 展示**本会话本次召回内容**（`<memory>` 实际注入了什么，便于用户理解 AI 为何"记得"）。
- 展示**用户画像**（`GET /api/memory/facts` 渲染 `profile.md` 摘要）。
- 每条事实带「遗忘」按钮（`DELETE /api/memory/facts/:id`）。
- 只读为主，符合 WorkBuddy「记忆自动注入、可查看可遗忘」的体感。

**呈现一致性**：配色/圆角沿用现有 `public/components/chat-panel.js` 与 `agui` 风格；不引入新 UI 框架。

---

## 10. 迁移（`scripts/memory-migrate.js`）
- 读取浏览器侧旧 `localStorage['qcli-chat-history']`（通过一次性前端钩子导出，或约定用户首次打开新版时前端检测并 `POST /api/memory/import`）。
- 后端 `archive.importLegacy(msgs)`：生成首个 session（标题取首条 user 消息），全量追加，跑一次 compaction 生成初始 summary。
- 无旧数据时脚本为 **no-op**，不报错。
- 该脚本**只运行一次**（用 `data/memory/.migrated` 标记防重跑）。

---

## 11. 测试策略（`node --test`，复用现有 `npm test`）
- `lib/memory/storage.test.js`：原子写、并发写、损坏文件恢复。
- `lib/memory/session.test.js`：幂等追加（同 id 不重复）、working window 切分。
- `lib/memory/index-store.test.js`：BM25 排序正确性（用固定语料）。
- `lib/memory/compaction.test.js`：**用桩 LLM**（`llm-bridge` 注入 fake）验证触发条件与「旧段移出 messages、summary 生成」逻辑；验证 LLM 不可用时的降级（保留原文）。
- `lib/memory/recall.test.js`：召回返回 topK、`<memory>` 块格式。
- 这些测试文件分置、小巧，符合"反单体"。运行：`npm test`（已配置 `node --test`）。

---

## 12. 实施里程碑（顺序，每步可独立验证）

1. **M1 地基**：`config.js` / `schema.js` / `storage.js`（原子写）。验证：单测通过。
2. **M2 会话归档**：`session.js` / `archive.js` / `routes/memory/sessions.js` + `scripts/memory-smoke.js`。验证：建/追加/读回/列表。
3. **M3 会话 UI（先呈现，对标 WorkBuddy）**：`session-store.js` / `session-list.js` / `session-item.js`，替换 `chat-panel.js` 的 localStorage 逻辑。验证：左栏出现会话列表、可新建/续聊/搜索/改名/删除；旧历史经迁移脚本导入。
4. **M4 召回注入**：`index-store.js` / `recall.js` + 在 `routes/chat/index.js` 注入 `<memory>` 块。验证：跨会话提问能召回旧事实（用 `scripts/memory-smoke.js` 与 `/api/memory/recall`）。
5. **M5 自动压缩**：`compaction.js` / `llm-bridge.js`，替换 `trimHistory` 主路径。验证：长会话触发摘要、旧段移出、上下文含 `<session_summary>`；LLM 不可用时降级。
6. **M6 画像/事实（Layer A）**：`profile.js` + `routes/memory/facts.js` + `memory-panel.js` 抽屉。验证：facts 抽取/去重/遗忘；跨会话"记得你"。
7. **M7 可选向量**：`embed.js`（懒加载、可禁用）。验证：`HESI_MEMORY_EMBED=1` 时走余弦重排，否则纯 BM25。
8. **M8 打磨**：迁移脚本收尾、性能（大索引分页）、文档（更新 `README.md` 的记忆说明）。

> 每步结束都跑 `npm run check:server`（已覆盖 `routes/chat/discuss.js` 等）与 `npm test`，确保不破坏现有构建。

---

## 13. 风险与回退
- **向后兼容**：旧单全局对话通过 M3 迁移保留为首会话；未迁移前 `sessionId` 为空时后端退化为"无记忆直连"（与现状一致）。
- **性能**：`index.json` 过大时 `index-store` 分页/惰性加载；BM25 为 O(n) 可接受（会话量级为个人使用，千级以内）。
- **LLM 成本**：compaction/抽取为异步、低频（按阈值/空闲触发），不在关键路径阻塞响应。
- **隐私**：所有记忆在 `data/memory/` 本地；不外接云。`profile.md`/`facts.json` 用户可手动编辑或删除。
- **回退开关**：`config.js` 增加 `MEMORY_ENABLED` 总开关，置 false 时全部走原 `trimHistory` 逻辑，零行为变化。

---

## 14. 验收标准（Done）
- [ ] 刷新/重启服务后，历史会话可从服务端恢复（不止浏览器 localStorage）。
- [ ] 可新建多个会话、搜索、改名、删除；UI 对标 WorkBuddy 侧栏。
- [ ] 长对话不再"截断丢信息"，而是压缩成 `<session_summary>` 注入，且近期原文保留。
- [ ] 跨会话能召回既往事实/摘要（AI"记得你"），并有「🧠 记忆」抽屉可查看/遗忘。
- [ ] 无 LLM / 无向量模型时核心功能仍可用（确定性降级）。
- [ ] 所有新增 `lib/memory/*.js` 单文件 ≤ 220 行；路由只做转发；测试随 `npm test` 通过。
- [ ] `npm run check:server` 与现有构建不破。

---

## 15. 附录：关键接口契约（门面 `lib/memory/index.js`）
```js
module.exports = {
  ensure(sessionId),                 // 建会话（若不存在）
  append(sessionId, msgs),           // 幂等追加（msgs 带稳定 id）
  getSummaryBlock(sessionId),        // 返回 {role:'system', content:'<session_summary>…'}
  recall(query, {topK}),             // → {role:'system', content:'<memory>…'}
  commit(sessionId),                 // 落盘收尾
  compactIfNeeded(sessionId),        // 异步压缩（触发判定 + LLM）
  extractFacts(sessionId),           // 异步抽取持久事实 → facts.json/profile.md
};
```
路由层与前端只依赖上述门面，内部模块细节隔离——这是"反单体"的关键：改动压缩算法不影响路由，改动检索不影响归档。
