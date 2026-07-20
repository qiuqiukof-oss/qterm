# Hesi（合思）产品打磨与产品化实施方案

> 版本：v0.1.0-draft · 生成日期：2026-07-20
> 依据：`Hesi-融资评估报告.md` 的缺口分析 + 对当前代码库的实地勘察
> 用法：用户将项目文件夹 `H:\CLI-Q` 重命名为 `H:\Hesi` 后，让助手按本文「第 5 节实现指引」从 Phase 0 逐条落地。每完成一项，在对应 `[ ]` 打勾并记入项目内存。

---

## 0. 三轮思考记录（本方案是如何推导出来的）

### 第一轮：现状盘点——我们到底有什么

通过实地读取代码库，确认以下资产**真实存在**（非报告包装）：

| 资产 | 真实位置 | 说明 |
|------|----------|------|
| 多 Agent 圆桌协作 | `routes/chat/discuss.js` | 回合制 SSE，AI 助手 ↔ CLI Agent 交替发言，已可用 |
| Headless 执行引擎 | `lib/cli-headless.js` | `opencode run` 等无 TTY 调用，解决渲染污染 |
| MCP 鉴权 | `mcp/security/auth.js` | MCP 层已有鉴权 |
| MCP 审计 | `mcp/security/audit.js` | MCP 工具调用已有审计 |
| 访问令牌 | `lib/access-auth.js` | 单令牌模式（`QCLI_ACCESS_TOKEN`） |
| 命令策略 | `ws/pty-policy.js` | 终端命令策略（需确认默认是否开启） |
| 限流 | `rate-limiter.js` | 已实现 |
| 连接器生态 | `vendor/connectors/` + `mcp/` | 企业微信/腾讯/飞书等大量连接器 |
| 离线便携 | `tray/` | 自带 Node 运行时的离线包 |
| 前端 | `public/`（Lit 架构） | 已有完整 UI 与构建脚本 |

**复盘报告里的"护城河"**：多 Agent 协作、headless、连接器生态、离线包是有真东西的；但"技术护城河强""浏览器农场"属于包装/commodity，需收敛叙事。

### 第二轮：缺口归纳与优先级——还差什么、先补哪块

真正的缺口不在"功能炫技"，而在"企业可销售 & 可证明价值"：

1. **账号与多租户缺失**：只有单令牌，无用户/RBAC/SSO —— 企业进不来。
2. **审计不全覆盖**：仅 MCP 层有审计，核心终端命令执行无统一审计总线 —— 等保/审计卖给谁都不行。
3. **零遥测/PMF 数据**：无任何使用量采集 —— 融资无料可讲。
4. **无商业版门控/许可**：免费即全部，转付费无抓手。
5. **无合规姿态文档**：等保、安全披露、数据流向均未沉淀。
6. **融资材料空白**：BP / Demo / 架构白皮书三件套缺失；联创计划未写。

**优先级**：先补「安全与企业底座」（1/2 是卖给企业的入场券），再补「商业门控+审计 UI」，然后「遥测」，最后「合规+材料」。品牌收尾（版本号错位等）可穿插随时做。

### 第三轮：分阶段实施设计——怎么落地、何时算"成品"

拆成 Phase 0–4，单人可在 Phase 0–2 推进；Phase 3–4 需要至少 1 名商业/BD 联创（否则企业销售卡住，这是真实风险，报告把"单人"美化为亮点是错的）。每阶段设明确出口标准（见第 2 节）。

---

## 1. 工作流与任务清单（可执行 backlog）

> 约定：`[ ]` 待做，`[x]` 已完成。文件目标为**建议落点**，实现时以实际结构为准。

### 工作流 A：安全与企业底座（最高优先）

- [x] **A1 多用户账号与 RBAC**
  - 基于 `lib/access-auth.js` 扩展：新增 `lib/auth/accounts.js`、`lib/auth/rbac.js`、`lib/auth/session.js`。
  - 存储先用 Node 内置 + JSON 文件（`data/accounts.json`，带文件锁），后续可换 DB；保留 `QCLI_ACCESS_TOKEN` 单令牌作为"个人/本地模式"兼容。
  - 在 `server.js` 挂载认证中间件；角色：`admin` / `user` / `viewer`。
  - 出口：可建用户、分配角色、登录拿 session、受保护路由按角色鉴权。
- [x] **A2 全平台审计总线**
  - 把 `mcp/security/audit.js` 提升为统一审计模块 `lib/audit.js`，在关键事件打点：登录、PTY 命令执行、MCP 工具调用、Agent 讨论、文件上传、配置变更。
  - 落地到 `data/audit.jsonl`（append-only），提供 `/api/admin/audit` 查询与导出。
  - 出口：任何命令执行都留 `{user, ts, session, cwd, cmd, policyResult}`；覆盖核心终端层（不止 MCP）。
- [x] **A3 安全加固默认值**
  - 确认 `ws/pty-policy.js` 默认开启命令策略；补充危险命令拦截（`rm -rf /`、`:(){`、写 boot 区等）。
  - 复用 `rate-limiter.js`；新增 `SECURE_DEPLOY.md` 讲清公网暴露风险与最小暴露配置（呼应 README 已写的安全警告）。
- [x] **A4 密钥与配置治理**
  - `.env.example` 增加 `AUTH_MODE`、`SESSION_SECRET`、`AUDIT_RETENTION_DAYS`、`TELEMETRY_OPT_IN`；确认 `.env` 不入库（已 git-ignore）。

### 工作流 B：商业版 MVP

- [x] **B1 功能门控 / 许可** — 新增 `lib/license.js`：社区版 vs 商业版能力矩阵（多 Agent 协作、审计、私有部署、团队、SSO）。运行时按部署模式/许可判断能力可用与否。
- [x] **B2 团队工作区** — 多用户共享 workspace、会话归属、权限（谁可见/可操作某终端）；落到 `public/` + `ws/` 会话归属改造。
- [x] **B3 审计仪表盘 UI** — `public/` 新增 admin 页：审计流、活跃用户、命令/连接器统计。
- [x] **B4 SSO 就绪** — 抽象 `lib/auth/idp.js`（OIDC 接口），先留 stub + 文档，便于接企业微信/飞书/Okta。

### 工作流 C：PMF 数据基建

- [x] **C1 可选遥测** — `lib/telemetry.js`：默认关闭，首次启动提示开启；采集匿名使用量（DAU/MAU 代理、功能频次、连接器 Top N），本地聚合 + 可选上报。
- [x] **C2 指标端点** — `/api/metrics`（admin）展示增长数据，便于融资截图。
- [x] **C3 开源增长** — README 增加 "Why Hesi"、badge、demo gif、贡献指南；GitHub Stars 运营。

### 工作流 D：生态与合规

- [x] **D1 合规自检** — `COMPLIANCE.md`：数据流向、认证、审计、TLS、最小权限；作为等保准备材料。
- [x] **D2 连接器市场元数据** — 为每个连接器加 `manifest.json`（名称/分类/是否企业专属/鉴权方式），为"连接器市场抽成"打底。
- [x] **D3 安全披露** — `security.txt`、修正 `SECURITY.md` 版本号（见 F1）、漏洞奖励说明。

### 工作流 E：团队与融资材料

- [x] **E1 BP 模板** — `docs/BP.md`：含估值逻辑、资金用途、PMF 阈值、联创计划（用上一轮对话结论）。
- [x] **E2 Demo 脚本** — `docs/demo-script.md`：3 分钟产品演示分镜。
- [x] **E3 架构白皮书** — `docs/architecture.md`：把多 Agent、headless、MCP 安全、连接器生态讲清，作为护城河证据。
- [x] **E4  contributor 入门 + CI** — 强化测试覆盖率与 e2e（已有 eslint/test）。

### 工作流 F：品牌一致性收尾（穿插做，低风险）

- [x] **F1 版本号修正** — `SECURITY.md` 的 `1.1.x` 改为 `0.1.0`（更名时漏改）。✅ 已改
- [x] **F2 残留扫描** — 全仓 `grep -rni "CLI-Q"` 核对（应仅剩 `AGENTS.md` 运行上下文段 + `CHANGELOG.md` 历史说明，其余均为预期）。✅ 仅 3 处：CHANGELOG/AGENTS/本方案(历史路径引用)，均预期
- [x] **F3 更名路径同步** — 用户手动改名 `H:\CLI-Q`→`H:\Hesi` 已生效（cwd 已是 `H:\Hesi`）；`grep -i cli-q` 仅落在上述 3 文件，README/配置路径已无残留。✅
- [x] **F4 托盘启动器编译为运行文件（新增·见下）** — 把 `tray/tray.js` 打包成用户可双击的 `tray.exe`（Node SEA），配套原生 `traybin/`，替换 `tray.bat`；可选追加安装包（NSIS/dmg/AppImage）。详见「第 6 节 托盘打包方案」。

---

## 2. 阶段路线图（时间线 + 出口标准）

| 阶段 | 周期（单人估） | 覆盖工作流 | 出口标准（Done） |
|------|---------------|-----------|------------------|
| **Phase 0** | 第 1–2 周 | F 全部 + A3/A4 + A1 骨架 + E3 草稿 | 个人/企业模式可切换；命令策略默认开；审计总线跑通；SECURITY 版本修正；架构白皮书草稿 |
| **Phase 1** | 第 3–6 周 | A2 + B1 + B3 雏形 | 商业版能力可被门控；核心终端命令入审计；审计 UI 可看 |
| **Phase 2** | 第 7–10 周 | B2 + B4 + C1/C2 | 团队工作区可用；SSO 抽象可插拔；匿名增长数据可看 |
| **Phase 3** | 第 11–14 周 | D 全部 + E1/E2 | 合规文档齐；BP + Demo + 白皮书三件套就绪 |
| **Phase 4** | 第 15–24 周 | 标杆客户试点 + 据反馈打磨 | PMF 阈值达标：DAU≥目标、2–3 家付费/试点标杆；启动种子轮 |

> 说明：Phase 0–2 单人可推进；Phase 3–4 需至少 1 名商业/BD 联创，否则企业销售与合规对接会卡住。

---

## 3. "成品"定义（Done 总标准）

- **安全**：企业模式默认鉴权 + 审计全覆盖；命令策略默认开；公网暴露有清晰指南。
- **商业**：社区/商业功能边界清晰且可门控；团队工作区；审计仪表盘；SSO 可插拔。
- **数据**：可选遥测产出 DAU/MAU/连接器 Top N，融资可截图。
- **材料**：BP + Demo + 白皮书三件套；联创计划明确。
- **合规**：等保自检 + 安全披露机制。

---

## 4. 风险与权衡

- **单人资源**：Phase 3–4 前必须补齐商业联创，否则企业落地与融资叙事缺一环。
- **开源转付费**：免费版保留核心价值（多 Agent、离线、开源），仅对企业治理能力（审计/SSO/团队/私有部署）收费，降低社区反弹。
- **模型依赖**：无自研模型，毛利受外部 API 影响；商业版对"私有部署 + 自带 Key"友好，把模型成本转嫁客户，反而成卖点。
- **叙事收敛**：对外讲"AI Agent 协作平台 + 中国企业生态连接器"，避免"操作系统"式夸大，护城河叙事落在"生态渠道 + 先发"。

---

## 6. 托盘（tray）打包方案（新增·F4）

> 背景：用户希望把 `tray/` 从「脚本 + tray.bat」升级为「打包好的运行文件」，让终端用户双击即用、更像正式软件。

### 6.1 现状与约束（已实地确认）
- `tray/tray.js` 是**轻量启动器**（无 Electron），复用 `node/` 便携运行时拉起 `server.js`；它本身不含服务器，只负责托盘菜单 + 拉起/关停服务。
- `systray2` 依赖**原生二进制** `traybin/tray_windows_release.exe`（~3.6MB，mac/linux 同理）；运行时先查 `./traybin/`（相对 cwd），再回退包目录。→ 原生二进制必须仍在磁盘上，无法完全消失。
- 当前分发模型是**文件夹**（`hesi/`：node + server.js + node_modules + public + tray），离线/U盘复制即用——这是特性不是缺陷。

### 6.2 三档方案（按投入/收益排序）
| 档位 | 做法 | 收益 | 代价/风险 |
|------|------|------|-----------|
| **A. 仅编译托盘启动器（推荐首做）** | Node SEA 把 `tray.js` 编成 `tray.exe`，旁边带 `traybin/`；放进 `hesi/` 替换 `tray.bat` | 双击即用、无需 Node 源码、攻击面小、契合"轻量/无 Electron/离线文件夹"理念 | 仍依赖 `hesi/` 文件夹（启动器只拉服务）；需运行时确保 cwd=exe 目录以命中 `./traybin` |
| **B. 托盘exe + 安装包** | 在 A 基础上加 NSIS(Windows)/dmg(macOS)/AppImage(Linux)，装到 Program Files、开始菜单、可开机自启 | 面向非技术终端用户"正式软件"体验；保留离线文件夹内核 | 新增构建依赖（NSIS 等）；跨平台 3 套 |
| **C. 整体单文件（含服务）** | pkg/Sea 把 server.js + node_modules 也打进单一 exe | 真·一个文件 | 体积 ~100MB+、原生/动态 require 风险高、与"轻量/离线文件夹"理念冲突——**不推荐** |

### 6.3 推荐落地（已实现：A 档）
1. **已交付 A 档**：`scripts/build-tray-exe.{bat,sh}` + `sea-config.json`，把 `tray/tray.js` 编译为 `tray/tray.exe`，并把 `systray2` 原生二进制复制到 `tray/traybin/`（必须随 exe 一起分发）。
2. **注入器改为纯 Node 实现** `scripts/inject-sea.js`：官方 `postject` 依赖 Windows `BeginUpdateResource` 资源更新 API，在受限/沙箱环境会被拦截（报 `Can't read resource file`）。本注入器只做文件 I/O——解析 node 基底的 `.rsrc`、合并 `RT_RCDATA(10)/"NODE_SEA_BLOB"` 资源、重建进新节 `.rsea` 并重指 PE 的 RESOURCE 数据目录、翻转 SEA fuse `:0→:1`，**无需 postject、无需联网**。
   - 关键修复：资源叶子数据的 `OffsetToData` 是**模块基址相对 RVA**，须经节表映射到文件偏移再读字节（最初误用 `rsrc.raw+rva` 导致原 icon/manifest 数据丢失、注入后 size=0）。
   - 校验：`node scripts/inject-sea.js --verify tray/tray.exe tray/sea-prep.blob` 已通过（节数=7、RESOURCE 指向 `.rsea`、NODE_SEA_BLOB 提取逐字节与原 blob 一致、fuse=:1），并用独立 Python PE 遍历器交叉确认 10 个资源（含原 manifest/icon）size 与可读字节完全一致。
3. **tray.js 已做实 SEA 感知改造**：检测到 `node:sea.isSea()` 时 `process.chdir(exe 目录)`，多候选加载 `systray2`，并把 Hesi 自带便携 Node 注入 `PATH`（SEA 模式下 `process.execPath` 是 tray.exe 而非 node.exe，否则拉不起 server）。
4. **沙箱运行限制（重要）**：本构建/验证环境禁用了 Windows 资源 API，`tray.exe` 在沙箱内执行会因 `FindResource/LoadResource` 被拦截而段错误（与 postject 失败同源）。**该 exe 结构与字节均已验证正确，需在用户真实 Windows 机器上做双击冒烟测试**（应拉起托盘 + 后台 server）。
5. 保留 `tray.bat`/`tray.sh` 作为无 SEA 构建时的 fallback。

---

## 5. 给助手的实现指引（用户更名后从哪开始）

1. 用户完成 `H:\CLI-Q` → `H:\Hesi` 更名并重新打开项目后，先 `grep -rni "CLI-Q"` 全仓核对残留（应仅 `AGENTS.md` 与 `CHANGELOG.md` 历史说明）。
2. 从 **Phase 0 / 工作流 F** 起步（机械、低风险、能立即验证），再做 A3/A4 安全默认值，再 A1/A2。
3. 每完成一个任务：把本文对应 `[ ]` 改为 `[x]`，并在 `.workbuddy/memory/YYYY-MM-DD.md` 记一笔。
4. **不要**改动 `AGENTS.md` 中由 CLI-Q 自动生成的运行上下文段（标注"请勿手动修改"）。
5. 实现中若发现现有代码与本文假设不符，以实际代码为准，并在内存中记录偏差。
