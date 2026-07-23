# Hesi 记忆工程方案 —— 影响评估与实施指南

> 本文档是 `docs/HESI-MEMORY-PLAN.md` 的**补充件**，聚焦于「方案对现有功能的影响面」与「UI 呈现一致性」。
> 核心问题：加入跨会话记忆后，AI 讨论、工具调用、全局连接、思考/工具提示是否会受影响？如何保证不退化？

---

## 一、需修改的文件清单（精确到行号 + 影响面）

### 1. 后端文件（6 个）

| # | 文件 | 改动位置 | 改什么 | 影响 |
|---|------|---------|--------|------|
| B1 | `routes/chat/index.js` | L263（POST /api/chat 入口） | 解构 `sessionId`；在 L300-353 注入记忆召回块 | **高影响**——每次对话的 system prompt 构成变了；必须保证 `<memory>` 块不破坏现有终端上下文和 SELF_AWARE 的顺序 |
| B2 | `routes/chat/utils.js` | L30-36（trimHistory） | 降级为兜底（仅超硬上限截断） | **中影响**——现有截断行为变弱，长会话依赖 compaction 接管 |
| B3 | `server.js` 或 `routes/index.js` | 路由挂载处 | 新增 `app.use('/api/memory', require('./memory'))` | **低影响**——纯新增路由，不影响已有路由 |
| B4 | `routes/chat/tools.js` | 新增 remember/recall 工具注册 | 在工具表中加 2 条 entry | **低影响**——新增工具，不影响已有工具的分发逻辑 |
| B5 | `routes/chat/discuss.js` | L252-357（runDiscussion） | 讨论结束后归档 session（含讨论气泡） | **中影响**——讨论模式当前无持久化，加归档后讨论记录可跨会话保留 |
| B6 | **新建** `lib/memory/*.js`（10个模块）+ `routes/memory/*`（4个路由） | 全新目录 | 记忆核心逻辑 | **零影响旧代码**——全新模块，通过门面接入 |

### 2. 前端文件（5 个修改 + 4 个新建）

| # | 文件 | 改动位置 | 改什么 | 影响 |
|---|------|---------|--------|------|
| F1 | `public/chat-api.js` | L111-142（sendMessage） | body 加 `sessionId` | **低影响**——纯字段扩展，SSE 消费逻辑不变 |
| F2 | `public/components/chat-panel.js` | L685-698（_loadHistory/_saveHistory） | 替换 localStorage 为 session-store.js | **高影响**——消息持久化机制根本性改变；但 UI 渲染层不变 |
| F3 | `public/components/chat-panel.js` | L757-849（sendMessage） | 不再 slice(-50)；每条消息生成稳定 id | **中影响**——发给后端的消息量变大（全量 vs 50条），需确认后端能承受 |
| F4 | `public/components/chat-panel.js` | L1287-1335（showThinking/removeThinking） | **不改**——思考指示器保持原样 | **无影响**（见§二详述） |
| F5 | `public/components/chat-panel.js` | DOM 挂载点 | 左侧挂载 session-list.js；顶部加 🧠 按钮 | **中影响**——布局变化，需适配现有 CSS grid/flex |
| F6-F9 | **新建** `public/memory/{session-store,session-list,session-item,memory-panel}.js` | 全新 | 会话管理 UI | **零影响旧代码** |

### 3. 构建与配置（2 个）

| # | 文件 | 改动 | 影响 |
|---|------|------|------|
| C1 | `package.json`（esbuild 配置或 scripts/build） | 把 `public/memory/*.js` 纳入 bundle 或 `<script>` 引入 | **关键**——漏加则新模块不生效且无报错 |
| C2 | `.gitignore` | 加 `data/memory/`（本地落盘不入库） | **低影响** |

---

## 二、对「思考提示 / 工具调用提示」呈现的影响分析

### 2.1 当前实现回顾（来自代码实证）

用户截图展示的 WorkBuddy 界面效果：
```
🤖 AI
─────────────────────────────
等待模型响应  ·  比起快，我更想给你一个不出错的答案
```

Hesi 当前的等价物是 `#thinking-indicator`（`chat-panel.js:1287` 创建），包含：
- **动画三点**（`.thinking-dot` × 3，CSS `think-bounce` 动画）
- **状态文案**（`.thinking-status`，默认隐藏，有内容时显示）
- **Agent 实时输出容器**（`.agent-sessions`，由 AgentSessionRenderer 管理）

状态文案的赋值路径：
```
后端 SSE 事件 → chat-api.js 解析 → chat-panel.js 回调 → .thinking-status.textContent
  status type       → onStatus()        → L871-884           → "🔧 正在查询..."
  tool_call_start   → onToolCall()      → L897-908           → "🔧 正在调用: X"
  tool_call_end     → onToolCall()      → L897-908           → "✅ X 完成 (Nms)"
  tool_live         → onToolLive()      → L921-939           → "⚡ X 已启动" / "📜 X：..."
```

收到首个 token 时（`onToken`, L885）：气泡从 `.thinking` 态切换为正文渲染态。

### 2.2 加入记忆后的影响结论：**几乎为零**

| 现有组件 | 是否受记忆功能影响 | 原因 |
|---------|-------------------|------|
| `showThinking()` / `removeThinking()` | ❌ 不影响 | 记忆注入发生在**后端拼 system prompt 阶段**（B1），在前端看到任何响应之前已完成。思考指示器的生命周期（发消息→显示→收token→移除）完全不变 |
| `.thinking-status` 文案 | ❌ 不影响 | status/tool_call 事件由 SSE 流式通道推送，与记忆召回走不同的代码路径。记忆不会产生新的 SSE event type |
| `.agent-sessions` Agent 实时容器 | ❌ 不影响 | WS `mcp_metric` 旁路独立于记忆系统。Agent 进度事件不经记忆模块 |
| `tool-call-trace` 折叠块 | ❌ 不影响 | 在 `onDone` → `appendToDOM` 时生成（L1252-1271），基于 `_activeToolCalls` 数组。记忆不触碰此数组 |
| typing-cursor 光标闪烁 | ❌ 不影响 | 纯 CSS 动画，附加在正文 bubble 上 |

**唯一需要注意的点**：如果记忆召回导致 system prompt 显著变长（比如召回了大量历史摘要），模型的首个 token 响应可能**延迟稍增加**（模型需要处理更长的上下文）。这会导致 `.thinking` 思考指示器显示时间稍长——这是**预期行为**，不是 bug。建议在 `.thinking-status` 中可选地显示「正在检索记忆…」提示（仅在召回耗时 >500ms 时闪现）。

### 2.3 截图中「比起快，我更想给你一个不出错的答案」的实现

这是 WorkBuddy 桌面版的**思考过程展示**（thinking content / reasoning trace）。Hesi 当前**没有等效功能**——`.thinking` 只是加载动画。

**是否在本期实现？**
- **不建议 M1-M4 阶段做**。这需要模型支持 extended thinking（Claude）或 chain-of-thought 输出（OpenAI o-series），且需要新的 SSE event type（如 `thinking_content`）+ 前端渲染逻辑。
- **可作为 M8 打磨阶段的增强项**。若要做，接入点是：
  - 后端：`stream-openai.js` 解析 `reasoning_content` delta（OpenAI o-series）或 `content_block_delta` type=`thinking`（Claude）
  - 新增 SSE type: `{type:'thinking', content:'...'}`
  - 前端：`chat-api.js` 新增 `onThinking` 回调 → 在 `#thinking-indicator` 内渲染思考文本（灰色斜体，可折叠）
  - CSS：新增 `.thinking-content` 类（参考截图中的简洁单行样式）

---

## 三、对「AI 讨论」（圆桌模式）的影响

### 3.1 当前讨论模式的完整链路

```
前端 {discuss:true, partners, maxTurns}
  → POST /api/chat
    → routes/chat/index.js: 检测 discuss → runDiscussion()
      → routes/chat/discuss.js:
        - 循环 round 1..maxTurns
        - 每轮: AI发言(discuss_start→token→discuss_end) + 各CLI Agent发言
        - 最后: summary 汇总
      ← SSE 事件流回前端
    ← 前端 _handleDiscussEvent() 渲染独立气泡
    ← onDone: _discussPendingMsg push 到 this.messages + _saveHistory()
```

### 3.2 记忆功能的影响

| 方面 | 影响 | 处理建议 |
|------|------|---------|
| **讨论记录持久化** | 当前讨论结束仅存入 localStorage 50条窗口，多Agent多轮讨论会挤掉早期内容 | **M2 阶段**：讨论结束时（discuss.js L357 附近）调用 `MemoryStore.commit(sessionId)`，把完整 transcript 归档。讨论气泡（role='tool'/_speaker='cli'）一并纳入 |
| **讨论中的记忆召回** | 讨论模式下每次 AI 发言都是独立的 LLM 调用；可以在每轮注入 `<memory>` 块 | **M4 阶段**：在 `runDiscussion` 的 AI 发言循环内（discuss.js L305 附近），同样调用 `recall.relevant(currentTopic)` 并注入 |
| **讨论参与者的上下文** | CLI Agent 通过 `agent.js` 的 `context` 参数获取上下文，目前不含记忆 | **可选增强**（非 M1-M8 必需）：在委派 CLI Agent 前，把 recall 结果拼入 `context` 参数。注意控制长度（复用 token-budget.js 思路） |
| **讨论 UI 呈现** | 讨论气泡的渲染（_handleDiscussEvent）与记忆 UI（session-list / memory-panel）是不同 DOM 区域 | **无冲突**。左栏会话列表和 🧠 抽屉不影响讨论气泡的渲染 |

### 3.3 关键风险：讨论消息的角色标记

讨论气泡落盘时的格式：
```js
// chat-panel.js L1181
this.messages.push({
  role: 'tool',          // ← 不是 'assistant'！
  content: this._discussText || '（无内容）',
  _speaker: 'cli',       // 或 'ai' / 'summary'
  _label: '终端助手'
});
```

**风险**：`_saveHistory()` 的过滤条件是 `m.role === 'user' || m.role === 'assistant'`（L697）。**讨论气泡 role='tool' 不会被保存！**

等等——让我再确认一下：

```js
// chat-panel.js L695-698
_saveHistory() {
  const toSave = this.messages.filter(m => m.role === 'user' || m.role === 'assistant');
  safeStorage.setJSON('qcli-chat-history', toSave.slice(-50));
}
```

**确认：讨论气泡确实不会被 localStorage 持久化！** 这是一个已有的 bug/限制。

**修复方案**（在 M3 替换 _saveHistory 时一并处理）：
```js
// 新版 _saveHistory (session-store.js)
const toSave = this.messages.filter(m =>
  ['user', 'assistant', 'tool'].includes(m.role)  // 包含讨论气泡
);
```

---

## 四、对「工具调用」流程的影响

### 4.1 完整工具调用链路

```
用户发消息 → SSE → stream-openai.js 逐块解析
  → 检测到 tool_calls → res.write({type:'tool_call_start', names})
  → executeToolCall(toolName, args)     // tools.js L67
  → 广播 mcp_metric {ev:'tool_call_start'}
  → 工具执行完成 → res.write({type:'tool_call_end', name, durMs})
  → 广播 mcp_metric {ev:'tool_call_end'}
  → 继续解析后续 token（可能再次触发工具调用，最多50轮）
  → 最终: usage + [DONE]
```

### 4.2 记忆功能的影响

| 方面 | 影响 | 详细说明 |
|------|------|---------|
| **工具执行本身** | ❌ 无影响 | `executeToolCall`（tools.js）的分发逻辑完全不经过记忆模块。新加的 remember/recall 工具只是**新增两个工具名**，不影响已有工具的注册和执行 |
| **工具调用提示（前端）** | ❌ 无影响 | `onToolCall` 回调（L897-908）只读写 `_activeToolCalls` 数组和 `.thinking-status` 文案。记忆系统不触碰这些 |
| **工具调用折叠trace** | ❌ 无影响 | `appendToDOM` 中的 `tool-call-trace` 生成逻辑（L1252-1271）基于 `_activeToolCalls`，与记忆无关 |
| **工具结果中的记忆写入** | ✅ 这是新功能 | 当 AI 调用 `remember` 工具时，tools.js 分发到 `lib/memory` 的 `append()` 方法。这是**新增路径**，不影响已有工具 |
| **工具调用轮次上限（50轮）** | ⚠️ 间接影响 | 如果记忆召回使 system prompt 变长，模型可能在更少轮次内触及 token 上限。但实际上 compaction 会压缩历史，**净效应应该是正面的**（压缩后上下文更精炼） |

### 4.3 新增工具的定义

计划在 `routes/chat/tools.js` 中注册两个新工具：

```js
// 记忆工具定义（伪代码，待实现）
{
  name: 'remember',
  description: '将重要信息长期保存到记忆中供未来会话使用',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '要记住的内容' },
      category: { type: 'string', enum: ['preference', 'fact', 'decision', 'context'] }
    }
  }
},
{
  name: 'recall',
  description: '搜索历史记忆中的相关信息',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      topK: { type: 'number', default: 5 }
    }
  }
}
```

这两个工具的执行函数分别调用 `MemoryStore.appendFact()` 和 `MemoryStore.recall()`，**不经过 MCP、不经过 WS、不影响其他工具**。

---

## 五、对「全局连接」（MCP/WS/连接器）的影响

### 5.1 MCP 连接器

**结论：零影响。**

证据：
- `mcp/hub.js` 的 `live Map` 存储连接器实例，生命周期由 WS 连接/断开事件管理
- `mcp-server.js` 和 `mcp/` 目录下所有文件 grep memory/history/context **无相关命中**
- 连接器状态与聊天记忆是完全独立的子系统

唯一可能的间接交互：如果未来做了「连接器运行上下文喂给记忆召回」的高级功能（比如记住"上次用了哪个数据库连接器"），那才产生关联。但这不在 M1-M8 范围内。

### 5.2 WebSocket 连接与重连

**结论：几乎零影响，但有一个同步问题需注意。**

当前 WS 重连流程（`ws-manager.js`）：
```
断线 → _onClose() → 不清终端标签（服务端 PTY 存活 grace window）
     → 退避重连 → _onOpen() → flushMessageQueue()
                     → _reconnectTerminals()（按 tabId 重连 PTY）
                     → _reconnectAgents()（重新 launch 未完成 Agent）
```

**问题**：WS 重连时**不会重新拉取聊天历史**（因为当前历史只在 localStorage）。

加入记忆后：
- 聊天历史主要存在**服务端** `data/memory/sessions/<id>.json`
- 前端 localStorage 只作为**缓存层**
- WS 重连成功后，前端应该**主动从 `/api/memory/sessions/:id` 拉取最新消息增量**

**建议实施点**（M3 阶段）：
```js
// ws-manager.js _onOpen() 中追加
if (MemorySession.currentId) {
  MemorySession.syncFromServer();  // GET /api/memory/sessions/:id → 合并增量
}
```

### 5.3 服务端内存态（activePTYs / orphanedTabs）

**结论：零影响。**

这些数据结构在 `ws-handler.js` 中，管理终端 PTY 生命周期，与聊天记忆完全无关。

---

## 六、UI 呈现一致性检查清单

### 6.1 必须保持不变的体验

- [x] 发消息后立即显示「等待模型响应」+ 弹跳点动画
- [x] 工具调用时显示「🔧 正在调用: X」→「✅ X 完成 (Nms)」
- [x] Agent 执行时显示实时输出容器（.agent-sessions）
- [x] 收到首个 token 时平滑切换为正文渲染 + 闪烁光标
- [x] 完成后 tool-call-trace 折叠块正确显示
- [x] 错误时容错提示正常工作
- [x] 保活心跳防止长工具期间断开

### 6.2 记忆功能新增的 UI（不应干扰上述体验）

| 新组件 | 位置 | 与现有组件的关系 | 干扰风险评估 |
|--------|------|-------------------|-------------|
| 左栏会话列表 | 聊天面板左侧（需腾出空间） | 与现有侧栏（sidebar.js）并列 | **中**——需确认布局不下穿；建议用 `<aside>` 独立区域 |
| 🧠 记忆按钮 | 聊天输入框上方或顶部栏 | 新增按钮，不影响输入区 | **低** |
| 记忆抽屉 | Overlay/drawer（点击 🧠 打开） | 浮层，不占主布局 | **低** |
| 「正在检索记忆…」闪现提示 | .thinking-status 内 | 复用现有状态文案机制 | **极低**——只是多了种 status 内容 |

### 6.3 布局兼容性关键点

当前聊天区域的 DOM 结构（`index.html` L229-275）：
```html
<div id="chat-drawer">           <!-- 主容器 -->
  <div id="chat-messages"></div>  <!-- 消息列表 -->
  <div id="chat-input">...</div>  <!-- 输入区 -->
</div>
```

左栏会话列表的建议插入方式：
```html
<div id="chat-drawer" style="display:flex">
  <aside id="session-sidebar" width="240px">  <!-- 新增 -->
    <!-- session-list.js 渲染 -->
  </aside>
  <main style="flex:1">
    <div id="chat-messages"></div>   <!-- 不变 -->
    <div id="chat-input">...</div>    <!-- 不变 -->
  </main>
</div>
```

这样**消息列表和输入区的 DOM 路径不变**，现有的 `showThinking()` / `appendToDOM()` / 所有选择器都不用改。

---

## 七、实施顺序与风险缓解建议

### 7.1 推荐实施顺序（考虑影响最小化）

```
M1 地基（config/schema/storage）     → 零影响，纯新建
  ↓
M2 会话归档（session/archive/routes） → 零影响，纯新建+路由挂载
  ↓
M3 会话 UI（替换 localStorage）       → ★ 最高风险点
  │  缓解：保留 MEMORY_ENABLED=false 开关
  │  缓解：先并行运行（双写 localStorage + session-store）
  │  缓解：_saveHistory 过滤条件修复（包含 role='tool'）
  ↓
M4 召回注入（<memory> 块）            → 中风险（system prompt 变化）
  │  缓解：先只加不删（保留 trimHistory 兜底）
  │  缓解：memoryBlock 有最大长度限制（如 2000 tokens）
  ↓
M5 自动压缩（compaction）             → 中风险（替代 trimHistory）
  │  缓解：LLM 不可用时降级为保留原文
  ↓
M6 画像/事实（Layer A）               → 低风险（纯新增功能）
  ↓
M7 可选向量                          → 零风险（完全可选插件）
  ↓
M8 打磨                             → UX 微调
```

### 7.2 每个里程碑的回归测试要点

| 里程碑 | 必须验证的功能 |
|--------|---------------|
| M1 | `npm test` 通过；`npm run check:server` 通过 |
| M2 | `scripts/memory-smoke.js` 冒烟通过；原有 `/api/chat` 仍正常（不带 sessionId 时退化为无记忆） |
| M3 | **重点**：普通对话正常；讨论模式正常；工具调用提示正常；思考指示器正常；刷新后历史恢复；**MEMORY_ENABLED=false 时完全退回旧行为** |
| M4 | 跨会话提问能召回；单会话对话不受影响；工具调用不受影响 |
| M5 | 长会话触发压缩；压缩后上下文含 `<session_summary>`；LLM 不可用时保留原文 |
| M6 | facts 抽取/遗忘；🧠 抽屉可打开 |
| M7 | `HESI_MEMORY_EMBED=1` 时向量排序生效；不设置时不报错 |
| M8 | 迁移脚本；性能；文档 |

---

## 八、总结：核心结论

### 不会受影响的功能（放心改）

1. **思考提示 / 等待模型响应指示器** —— 记忆注入在后端 prompt 拼接阶段完成，前端思考指示器的生命周期、DOM 结构、CSS 动画**完全不变**
2. **工具调用提示与折叠 trace** —— SSE 的 `tool_call_*` 事件流和前端的 `_activeToolCalls` 数组**不经过记忆模块**
3. **Agent 实时输出容器** —— WS `mcp_metric` 旁路独立运行
4. **MCP 连接器** —— 完全独立子系统
5. **保活心跳与错误容错** —— SSE 心跳和 `res('close')` 中断检测不受影响

### 需要注意的点（但不难处理）

1. **讨论模式气泡的持久化**（`role='tool'` 被 `_saveHistory` 过滤掉）——M3 时一并修复
2. **WS 重连后的记忆同步**——M3 时追加 `syncFromServer()` 调用
3. **system prompt 变长导致的首 token 延迟**——预期行为，可加闪现提示
4. **构建链路**——改了被 bundle 的源码后**必须 `npm run build`**

### 截图功能的实现优先级

用户截图中展示的「比起快，我更想给你一个不出错的答案」属于**模型推理过程可视化**（thinking content 展示），这依赖于模型原生能力（extended thinking）。**建议放在 M8 或更后期版本**，不属于记忆核心功能范畴。
