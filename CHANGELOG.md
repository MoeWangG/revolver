# 更新记录

格式固定，看板 `#/architecture` 直接渲染本文件（`GET /api/architecture`）：

```md
## [版本号] - YYYY-MM-DD
### 新增 / 变更 / 修复
- 一条一句话，写"改了什么"和"为什么值得知道"
```

发版顺序：先改 `package.json` 的 `version`，再在**本文件顶部**加一段。
版本号与 `package.json` 一致的那一段会在看板上被标成「本版变更」。

## [2.4.0] - 2026-11-11

### 新增

- **离场快照 [`episode.ts`](src/core/episode.ts)**：会话切换（含开新弹巢、网页发到另一个会话）时，
  对**被离开的那段**做一次增量摘要（只喂上次快照之后的对话，最多 24 条），拼上最后两轮原文求向量，
  落 `data/episodes.jsonl`。它是这个会话的"身份指纹"——下次开口时靠它判断"这句属于哪个会话"，
  而不是拿整段历史去比（长会话混多话题时，旧话题会把分数拉高）
- **专名命中 [`properNounScore()`](src/core/sessionIndex.ts)**：`kid-qa-box`、`esp32-cam` 这类英文/型号词
  出现在会话任一块时直接抬 `lex` 分。型号不会误伤，而领域相似会（实测「AI产品四问清单」0.639 压住了
  正确的《树莓派AI问答机落地》0.592，专名一加，错误首选掉到第 3）
- 排查工具：[`episode-smoke.ts`](scripts/episode-smoke.ts)（真跑一次快照）、
  [`episode-recall.ts`](scripts/episode-recall.ts)（同一句话，有/无快照的排序对照）
- **影子仲裁（A/B）**：[`arbitratePair()`](src/core/topicArbiter.ts) + `session.arbiter.shadow`。
  主模型（gemma）对用户可见，影子模型（laya）**在主模型之后**跑同一道题、只落
  `routing.jsonl`（`source: shadow` / `web-shadow`），一行自洽带 `agree`。
  报表 [`arbiter-ab.ts`](scripts/arbiter-ab.ts) 读这些行算一致率与各自判 new 的比例
- 为什么影子不能并行（2026-11-11 实测）：LM Studio 单进程推理，26B 主模型与 laya 同时打进去会排队，
  并行版主模型三次里两次被拖到 **6005ms 超时**（无影子时 274ms）。改成"主完成后才发影子"后
  主链路恢复 186~506ms，影子 60ms 级

### 变更

- **流程噪声不再进索引与摘要**：询问卡回退文本（「留在当前」「以上都不是」）、切换提示（「已切到《X》」）、
  纯数字选项（回 1..N）统一由 `isFlowNoise` 过滤。这些被当成用户话题，正是"随便问一句都像在聊某段"的假命中之源
- `scoreSessionChunks` 的背景分 `bg` **不再统计快照块**：快照是整段对话的压缩表示，对任何一句都天然更像，
  混进均值只会把快照带来的信号又抵掉
- `SessionMeta` 新增 `episodeCovered` / `episodeAt` 游标：反复切换不会重复摘要
  （实测同一会话第二次切换直接 `新增 0 条，不足一轮`）
- **话题裁决换模型：`laya` → 指令模型**（`session.arbiter.api: chat`）。
  laya 是 ModernBERT 编码器，做 5 选 1 时概率近似均匀：18 条真实留存样本判对 **0 条**、
  16 条最高概率 <0.4（等于弃权，argmax 在噪声里挑一个）；补「这段在聊什么」也只到 2/18，
  补「最近两轮」直接爆 512 token。同一批样本换 `gemma-4-26b-a4b-it-mlx` 走 chat 接口后
  **17/18**，另造 8 条真新话题判对 6/8，延迟 p50 575ms / p90 949ms
- 纠正一个方向的误判：**这不是 prompt 没喂好，是模型类型不对**——编码器只能对「句子 × 选项描述」
  算相似度，而选项描述里只有标题，判断所需的语义内容（这段在聊什么）没有承载空间

### 修复

- 网页端每次 `/api/talk` 记一条窗口指针（`noteActiveWindow`，**不建会话**），
  使"网页里切到另一个会话继续聊"也能触发快照；IM 侧沿用原有的 `setActive` / `openNewChamber`
- **`session.arbiter` 终于会被解析**：`SessionConfig` 一直有这个字段，但
  [`registry.ts`](src/core/registry.ts) 的逐字段白名单漏了它——waker.yaml 里写 `arbiter:`
  会被静默丢弃，实际永远跑 `DEFAULT_ARBITER_CONFIG`（laya）。换模型时踩到：以为改了配置，
  其实没生效。新增 [`scripts/arbiter-live.ts`](scripts/arbiter-live.ts) 守住这条链路

### 验证

- `npm test` 全绿：**22 个测试文件**；新增 [`tests/episode.test.ts`](tests/episode.test.ts) **35 项**
  （噪声过滤 12 例、向量文本、prompt 口径、摘要清洗、快照块不进 bg）
- 真实冒烟（隔离 `WAKER_DATA=/tmp/ep-smoke`，会话 `d8950d29`）：86 条有效对话 → 摘要 161 字 / 1024 维 /
  **4.7 秒**（后台，不在切换路径上等）；第二次调用 `新增 0 条，不足一轮`
- 召回对照（同一份索引，去掉快照 vs 保留快照）：
  - 「kid-qa-box 的 README 改好了吗」→ 错误首选《AI产品四问清单》从第 1 降到第 3
  - 「周报定时推送为什么没跑」→《周报复盘定时推送》第 1（0.201）
  - 「父亲怎么看孩子的 AI 玩具」→《树莓派AI问答机落地》第 1（0.230）

## [2.3.0] - 2026-11-10

### 新增

- **会话向量索引 [`sessionIndex.ts`](src/core/sessionIndex.ts)**：后台把每个会话的**每条用户消息**（外加标题、会话卡）算好向量，
  增量落盘 `data/session-vectors.jsonl`；查询时只 embed 当前这一句，在已算好的向量里算余弦。
  首次建库实测 **415 块 / 13 个会话 / 7.5 秒 / 3.5MB**，之后只追加新消息。
  这样"相关的那句话没被抽样抽到"不再发生——之前每个候选只有 4 块，漏一句分数就凭空低一截
- **排序不再求和**：每个会话算 `vmax`（最像那块）、`bg`（该会话全部块均值，背景）、
  `support`（去重后 top-3 均值）、`lex`（标题命中），
  `S = 0.6(vmax−bg) + 0.25(support−bg) + 0.15·lex` **只用于排序**。
  不用 top-3 求和：169 条的会话凑三个 0.55 = 1.65，会压过逐字命中的 1.00（长度偏置）
- **询问卡加「以上都不是」**：候选全错时的硬负样本（`kind: none`），比"留在当前"更能说明排序错了；
  纯文本退路则是 `回 N+3`
- **周报脚本 [`route-report.ts`](scripts/route-report.ts)**（`npm run report:route`）：读决策账本，输出
  候选名次分布、top-1 与用户选择不一致率、打扰率、"说完不对仍被切走"次数、响应延迟中位数

### 变更

- 候选池**不再按活跃度截断前 8**：全部会话参与排序，由索引分数决定谁进前 3
- **判定仍用 vmax + 原阈值**（0.58 / 0.60+0.08 / 8h），索引只改"候选怎么排"、不偷偷改判定刻度；
  索引覆盖 <60%、当前会话还没索引到、嵌入服务不可用时，自动退回 2.2.9 的现场切块 / 词面判定
- 决策账本 `route` 事件新增 `index.used / index.scored`，避免把"索引综合分"和"语义相似度"混着看

### 验证

- `npm test` 全绿：**21 个测试文件**。新增 [`tests/sessionIndex.test.ts`](tests/sessionIndex.test.ts) 20 项
  （长会话 3×0.55 综合分为 0、短会话逐字命中胜出、复述块只算一次、标题命中、当前会话未索引时返回 null）；
  [`tests/topicCard.test.ts`](tests/topicCard.test.ts) 79 项（5 个按钮、`topicNone` 与 `topic`/`topicList`/`topicChoose` 互不误判）
- `npx tsc -p tsconfig.json --noEmit` 无报错
- **真实数据验证（13 个会话 / 415 块）**：
  - 「esp32-cam」→ `sActive 0.470 / sBest 1.000` → switch（此前是 new）
  - 「明天天气怎么样」→ `sBest 0.604`，但只领先 0.06 → continue（没有误切）
  - 「我拿到硬件了，摄像头已经装到开发板上」→ 该句已在当前会话历史里（`sActive 1.000`）→ continue
- 账本首轮统计（发版前 11 条）：发卡 5 次、全部选"留在当前"、响应中位 14.7s、p90 38.4s —— 打扰率偏高，
  正好是后续用账本调参的起点
- 截图（红框标注，见下）

### 验收

> 判定链路那张图取自生产数据（真实会话内容与时间戳），开源仓库不发布；这里只保留不含个人数据的账本图。

![决策账本与可优化项](/verify/2.3.0-session-routing-log.png)

## [2.2.9] - 2026-11-08

### 新增

- **决策账本 `data/decisions.jsonl`**：一次自动推荐写成四条事件，用同一个 `id` 串起来 ——
  `route`（判定瞬间：原话、当前会话、语义分数、**候选按相似度排序的完整列表**、强匹配、仲裁的 model/ms/action/target/**verdict**/raw 概率、
  最终决策、询问门快照）→ `ask`（用户实际看到的候选与顺序）→ `answer`（candidate / stay / list / text，
  含 `sid`、`via`、`latencyMs`、直接说别的内容时的 `typed`）→ `final`（最后答在哪个会话，`why` 说明是接受、拒绝、低置信、配额耗尽还是自动切换）。
  设计动机：`routing.jsonl` 只回答"当时判了什么"，回答不了"推荐准不准、该不该问"；没有用户选择就无法优化阈值与候选排序
- **可视化说明 [`docs/session-routing.html`](docs/session-routing.html)**：把找 session 的十步链路、四个真实阈值、两个真实样本
  （0.697 vs 0.656 该丢弃、0.656 vs 0.584 该问）以及账本字段画成一张图，附按 id 汇总的排查脚本

### 变更

- `PendingAsk` 增加 `decisionId`：卡片可能在几分钟后才被点，没有它，answer/final 就挂不回原来那次判定
- 接受切换 / 列表挑选 / `/resume` 时把 `rejectStreak` 清零（此前只增不减，拒绝 2 次后**永久**不再询问）

### 验证

- `npm test` 全绿：20 个测试文件。新增 [`tests/decisionLog.test.ts`](tests/decisionLog.test.ts) 13 项
  （id 不撞号、候选快照不把"没算过向量"写成 0 分、JSONL 追加不覆盖、中文不转义）
- `npx tsc -p tsconfig.json --noEmit` 无报错
- **真实写盘验证**：用真实的 `FeishuChannel` 私有方法写临时 `WAKER_DATA`，得到三条同 id 事件
  （`route` 带 candidates/askGate、`answer` 带 `sid`/`via`/`latencyMs`、`final` 带 `sessionId`/`why: ask-accepted`）
- 页面截图（红框标注，见下）
- 看板已重启；`chat` 窗口的 `rejectStreak` 2 → 0

### 验收

> 判定链路那张图取自生产数据，开源仓库不发布；这里只保留不含个人数据的账本图。

![决策账本四个事件](/verify/2.2.9-session-routing-log.png)

## [2.2.8] - 2026-11-08

### 修复（判定逻辑）

- **仲裁的 switch 必须由语义背书**：目标要落在语义前 3、离第一名 ≤0.05、且领先当前会话 ≥0.05；
  否则丢弃这次意见、退回阈值判定（[`arbiterSwitchConsistent()`](src/core/semanticRoute.ts:200)）。
  依据是当晚的实测统计：23 次仲裁 switch 里语义可用的只有 8 次，**7 次的目标要么不是语义最像的那条、
  要么只领先当前 0.005~0.041**。最典型的一条是 03:35「我拿到硬件了，摄像头已经装到开发板上，下一步呢」——
  它对《周报复盘定时推送》0.697、对当前《esp32-cam》0.656，只领先 0.041，
  `decideSemantic` 本来判"留在当前"，是仲裁把它改成 switch，用户点「切回去」后原话被答进了周报会话
- **`rejectStreak` 只增不减（`resetReject` 一直是死代码）**：连续拒绝 2 次后**永久**不再询问，
  功能等于废掉。实测该窗口当时正好卡在 2。现在用户自己切过一次（接受切换 / 列表里挑 / `/resume`）就清零

### 变更（询问卡）

- 询问卡从「一个猜测 + 切回去 / 就在这儿继续」改成**多候选**：最多 3 条语义最像的旧话题，
  按钮直接写标题「切到《X》」；后面是「留在《当前》」与「看看全部话题」。
  判错的代价从"进错会话"降为"点另一个按钮"
- 正文去掉方位词与重复信息：不再写「要切回那边继续吗？」，改为「当前在聊《X》/ 你刚说：… / 下面按像不像排了 N 条」；
  同时删掉正文里重复的「上次到这里」（会话卡自带那行，之前同一句话会出现两次）
- 候选按钮用独立回调 `k:"topicChoose"`：有 pending 就**带原话切过去并作答**，没有就只搬指针
  （不会把原话丢进错的会话）
- 纯文本退路编号与按钮同序：`1..N` 候选、`N+1` 留在当前、`N+2` 看全部；升级瞬间的旧卡片仍按旧语义（1=切 / 2=留）解析

### 验收

- `npm test` 全绿：19 个测试文件。`tests/topicCard.test.ts` 73 项（多候选按钮文案、`topic`/`topicChoose`/`topicList` 三种回调互不误判、编号映射、空候选）；
  `tests/semanticRank.test.ts` 19 项（含两个真实样本的门禁边界：0.697 vs 0.656 丢弃、0.656 vs 0.584 采纳）
- `tsc -p tsconfig.json --noEmit` 无报错
- 真实复现（`chat` 员工，当前《周报复盘定时推送》）：
  - 「我拿到硬件了，摄像头已经装到开发板上，下一步呢」→ 语义 top3 = esp32-cam / 需求验证 / 树莓派，仲裁指向 esp32-cam，门禁 keep → 发「切到《esp32-cam》」卡
  - 「esp32-cam」→ strong-match → switch；旧 03:35 那条误切在新门禁下会被丢弃
- 看板已重启；`chat` 窗口 `rejectStreak` 2 → 0（否则询问门已退化成 stay）

## [2.2.7] - 2026-11-08

### 修复

- **飞书里"想切回某个旧话题，却被打成新话题，而且没有可选候选"**（2026-11-08 真实会话）。用户只发「esp32-cam」，期望切回同名旧会话；
  路由日志里 `semanticBest=1.0 / bestSessionId=<sid>`，最终却是 `action=new`。两个独立原因叠在一起：
  - **最像的旧话题没进仲裁的选项**：候选按"最近活跃"取前 8 个，仲裁又只读前 5 个，该会话排第 8 —— 模型根本看不到它。
    现在 [`rankCandidatesBySemantic()`](src/core/semanticRoute.ts:154) 先按与本句的语义相似度重排再喂仲裁（不增删候选，只改顺序；没分数的保持原顺序排后）
  - **询问卡只有两条死路**：「切回去 / 就在这儿继续」，判错时用户无法换目标。现在加第三个按钮**「看看全部话题」**
    （回调 `k:"topicList"`，与 yes/no 的 `k:"topic"` 分开认），点了复用 `/topics` 的列表卡（每条可展开摘要、就地「切到这儿」）；
    纯文本退路对应「回 **3** 看全部话题」，待答期间直接回 `3` / `/topics` 也能列出（不清 pending，用户仍可回 1 / 2）
- **语义几乎逐字命中时不再让小模型改判**：[`strongSemanticPick()`](src/core/topicRouter.ts:243) —— 与某条旧会话相似度 ≥0.95
  且领先当前 ≥0.25 就直接判 switch，但**仍走询问卡**，不会静默搬指针。依据：补上候选后 laya 在这个输入上概率仍近乎均匀
  （自报 `confidence` 0.056，还会把「明天天气怎么样」判成切回播客），确定性证据不该被噪声覆盖

### 已知问题（本版未处理）

- `laya` 决策模型在"只发一个短标题/专名"这类输入上几乎无判断力：实测自报 `confidence` 0.06~0.37，
  会把「明天天气怎么样」判成切回《AI产品四问清单与飞书授权》、把「现在几点了」判成切回父爱 AI 会话。
  [`decisionFromArbiter()`](src/core/topicArbiter.ts:430) 仍按固定 0.75 置信度放行（模型自报的 `confidence` 被 `raw` 的 400 字截断丢掉），
  所以这类噪声仍会**弹一次询问卡**（默认 `ask: always`，点「就在这儿继续」即可；连续拒绝 2 次后不再问）。
  下一步要么给 `/v1/systemone` 的 `state` 加信息量、要么换真正能判的模型，并让置信度参与门禁

### 验收

- `npm test` 全绿：19 个测试文件。新增 [`tests/semanticRank.test.ts`](tests/semanticRank.test.ts) 12 项（含"排第 8 但最像 → 顶到第 1"的回归用例）；
  [`tests/topicCard.test.ts`](tests/topicCard.test.ts) 63 项（三按钮、`topic`/`topicList`/`topicPick` 三种回调互不误判、退路含「回 3」）；
  `tests/routing.test.ts` 新增 `strongSemanticPick` 5 项（0.94 不命中、领先不够不命中、词面模式不生效）
- `tsc -p tsconfig.json --noEmit` 无报错
- **真实数据复现 → 修复后对比**（`chat` 员工、当前会话 `<sid>`、原话「esp32-cam」）：
  - 修复前：`data/routing.jsonl` 记 `action=new`，同一行 `bestSessionId=<sid>`、`semanticBest=1`
  - 修复后（探针复刻 `handleTopicTurn` 全链路）：`switch <sid>《esp32-cam》 | via=strong-match | conf=0.9`
- 看板进程已重启（`launchctl kickstart -k com.waker.board`），飞书渠道重新起连正常

## [2.2.6] - 2026-11-08

### 修复

- **浏览器能力全线不可用（真实故障）：`Unknown tool browser_snapshot`**。根因是上游换代，不是扩展没连：
  `@browsermcp/mcp@latest` 现在解析到 **2.4.0**，把 1.x 的 13 个原子工具合并成**单个 `browser`**（参数是多行命令 DSL），
  架构也从"server 占 9009 等扩展连"改成"扩展 → 常驻 daemon（`127.0.0.1:9010`）→ MCP 客户端"。
  平台仍按 1.x 的名字注册 `--tools`，于是工具注册成功、模型也调了、每次必失败。本机实测：broker 日志 `lastError: Unknown tool browser_snapshot`，
  9009 无监听，daemon 9010 已跑 5 天且扩展连接正常
- **上游版本钉死**（`DEFAULT_UPSTREAM_ARGS = @browsermcp/mcp@2.4.0`）：`@latest` 跨大版本漂移正是这次事故的成因。升级必须同步改工具清单并跑两个浏览器测试
- `isExtensionOffline()` 只认真正的连接失败（`No tab is connected` / `No connection to browser extension` / daemon 不可达）。
  **`There's no tab yet` 不算没连**：2.x 的 daemon 是通的、只是没选中标签页（下一步 `goto` 或 `tab list`），
  算成"未连接"会让 `waker browser status` 明明能用却报未连接

### 变更

- 工具契约：13 个 `browser_*` → **1 个 `browser`**（`src/core/browserTools.ts`）。`runner` 的 `--tools`、`guard` 的判权、
  `waker browser mcp-stdio`、`/tools` 自检全部跟着改；`waker-guard` 现在同时认 `browser` 与旧的 `browser_*` 前缀
- broker 的职责收敛为"串行化 + 多前端共享一个出口"（9009 抢端口问题随 2.x 消失），[`browserBroker.ts`](src/core/browserBroker.ts:1) 头部注释同步改写
- 文档与提示统一改口径：**不再需要手点 Connect**（Chrome 侧只要浏览器开着、扩展启用），涉及 `docs/产品说明书.md`、`agents/*/waker.yaml`、`profile.ts` 的开开关提示、`waker browser status`、看板「能力与权限」文案

### 验收

- `npm test` 全绿：18 个测试文件；`tests/browserBroker.test.ts` 16 项（工具清单=1 且名为 `browser`、参数只有 `commands`、转发/串行/超时/isError/未知工具/队列/status），`tests/browserClientAutostart.test.ts` 11 项
- `tsc -p tsconfig.json --noEmit` 无报错；`npm run web:build` 通过（v2.2.6）
- 真实上游对比：`tools/list` 返回 1 个 `browser`（`props: [commands]`）；直接 `tools/call browser {commands:"get url"}` 得到
  `There's no tab yet: use goto <url>…`（是"没有标签页"的业务提示，证明链路通了，不再是 `Unknown tool`）
- **真实 Chrome 读通了**：`POST /call {"name":"browser","args":{"commands":"tab list"}}` 返回用户当前 5 个标签页
  （含看板 8787、Tailscale 控制台等），`isError:false`。`/status` 里 `extensionConnected` 保持 `null` 而不是 `false`
  ——`no tab yet` 不再被误判成"扩展未连接"
- 看板文案截图（红框标注见下）

![能力与权限 · 浏览器文案](/verify/2.2.6-web-browser-dsl.png)

## [2.2.5] - 2026-11-08

### 新增

- **`scripts/lms-guard.mjs` + launchd `com.waker.lms-guard`**：每 5 分钟确认 LM Studio（1234）在跑、`text-embedding-bge-m3` 与 `laya` 都在 `loaded`；缺模型才 `lms get` 下载，服务没起就 `lms server start`／必要时后台 `open -a "LM Studio"`，模型被 TTL 卸掉就重新 `lms load`。此前这三种情况都**不报错**：端口探活 200、看板正常，只有语义召回和话题仲裁悄悄退化成词面判定
- 单飞锁（`~/.waker/lms-guard.lock`）与下载失败退避（30 分钟）：下载可能跑几分钟，不能每 5 分钟叠一个；网络不通时也不在每轮卡满超时
- 双击入口（`scripts/make-app.sh`）与 `register-launchd.sh` 都带上这个服务；`bootstrap.sh` 依赖自检也跑一次守门

### 修复

- **`/api/v0/models` 只挂在根路径**：写成 `${baseUrl}/api/v0/models` 时路径是 `/v1/api/v0/models`，HTTP 200 但回 `{"error":"Unexpected endpoint or method"}`，解析出来没有 `data` → 判定"模型全都不存在" → 去下载已经装好的模型。守门用 `BASE.replace(/\/v1$/,'')` 取根
- 周期脚本不能用 `KeepAlive`（跑完就退出会被 launchd 每 10s 重启）：`write_plist()` 现在支持 `START_INTERVAL` 走 `StartInterval`

### 验收

- `node scripts/lms-guard.mjs` 三条路径实测：全部已加载 → 两行 ✓ 退出 0；`lms unload laya` 后 → `laya 状态 not-loaded → lms load` → `✓ laya loaded`；`lms server stop` 后 → `LM Studio 未响应 → lms server start` → 两个模型均 `loaded`
- 仲裁真的能跑：`arbitrate()`（`DEFAULT_ARBITER_CONFIG`，laya/systemone）返回 `{action:'switch', ms:80}`，不再是降级路径
- launchd：`launchctl list | grep com.waker` 有 4 个 job，`com.waker.lms-guard` 退出码 0；plist 里是 `StartInterval 300` 而非 `KeepAlive`；`~/.waker/logs/lms-guard.log` 有 `全部就绪` 记录

## [2.2.4] - 2026-11-07

### 变更

- **员工不再需要人先手动 `waker browser start`**：`callBroker` 第一次连不上 broker 时就地拉起一个 detached broker 并重试一次（单飞，并发也只起一个）。此前 `policy.browser` 开着等于死路——agent 只有 `browser_*` 工具、没有 `waker` 命令权限，只会反复拿到"浏览器桥不可达"，把"起 broker"这件事推回给人，它还误以为自己"没有浏览器能力"。现在员工侧零配置，残留的人工步骤只有 Chrome 扩展点 Connect（扩展连 9009）。
- 新增 `WAKER_BROWSER_AUTOSTART=0` 关闭自启、`WAKER_BROWSER_ENTRY` 替换拉起入口（测试用它注入假 broker，避免碰真上游抢 9009 踢掉用户当前连接）。
- 自启输出落到 `data/browser-broker.log`；不可达时的报错直接给日志路径与手动排查命令，不再是"先运行 xxx"这种把它推回给人的话术。

## [2.2.3] - 2026-11-07

### 修复

- **发两张 iPhone 照片，整轮对话 400 上下文超限，而且连续三次被记成 success**（真实事故）：`.heic` 被算作图片原样 `@` 给 pi，可 pi 只按文件头认 JPEG/PNG/GIF/WEBP/BMP —— HEIC 掉进"文本文件"分支被 utf-8 硬读，一条消息 4,586,043 字符（7.4MB JSON，占 13.6MB 会话文件的 54%）。请求 4,135,562 token（模型上限 1,048,576）直接 400；pi 的自动压缩也救不回来，因为压缩边界只能落在消息边界，这条巨型消息被整条保留（`firstKeptEntryId` 指的就是它），压完仍请求 3,749,486 token
- **`prepareFileForModel()` 现在只放"模型真能读"的东西**：HEIC/HEIF 先用 macOS `sips` 转 JPEG（长边 2048）；转不出来就拦下并说明，**绝不退回原文件**；其它含 NUL 字节的二进制（zip/tiff/dmg/无扩展名可执行）一律拦下。判据看内容不看扩展名 —— 代码、日志、CSV、SVG 这些纯文本照旧放行
- **模型侧报错不再记成 success**：pi 遇到 provider 400 时只往会话记录写一条 `stopReason:"error"` 的 assistant 消息，**进程仍以 0 退出**；`runner` 原来只判退出码，于是 09:04、09:05 两轮 400 全被标 `success`、`result` 为空，界面上只剩「（无回复）」。现在任务结束会读会话尾部，最后一条 assistant 是 error 且写于本轮开始之后 → 标 `failed`，错误原文进 `error`（`parseRunError()` / `lastRunError()`，只读 64KB 尾部，不扫全量会话）

### 变更

- `/api/talk` 与飞书渠道共用同一条附件判定：`prepareFileForModel()` 返回 `{path: string | null, note?}`，`path: null` 表示这份附件不进上下文；两条渠道各自把 `note` 回给用户，不再静默丢附件

### 数据修复

- 会话 `chat / <sid>`（`~/.pi/agent/sessions/<cwd-slug>/<timestamp>_waker-chat-<sid>.jsonl`）：把那条消息里两段 HEIC 原始二进制换成一行说明，保留用户原话与「【附件：…】」清单。文件 13.6MB → 2.06MB，备份在 `<同名>.bak-<timestamp>`。**没有删任何消息，也没有改用户写的字**

### 验收

- 修后同一份会话副本被 pi 正常装载：`input tokens 4897`（修前 3,749,486）；HEIC 转出的 JPEG 以 `image/jpeg` 内容块进 user content（2.36MB → 522KB，文件头 `ff d8 ff`）
- 真实服务 E2E（看板 8787，重启后跑）：`POST /api/upload` 传 2.36MB HEIC → `POST /api/talk` 返回 `status: success`、`result: "收到"`、5.5s；该轮 pi 会话里 user content = `text(235 字符) + image(image/jpeg 405476 字符)`，`web-inbox` 跑完清空（原图与转出的 jpg 都删）
- `lastRunError()` 用真实历史验证：以 09:05 那轮为界 → 命中 `400: This model's maximum context length is 1048576 tokens … requested 3749547 tokens`；基准时间挪到该轮之后 → `null`；不存在的会话 → `null`
- `npm test` 全绿：17 个测试文件 224 项（新增 `tests/runError.test.ts` 8 项；`tests/attachments.test.ts` 27→34 项）；`tsc -p tsconfig.json --noEmit` 无报错

## [2.2.2] - 2026-11-07

### 修复

- **网页对话窗里发了图，聊天记录里看不到图**（真实投诉）：图片的 base64 一直完整存在 pi 会话文件的 `{type:"image"}` 内容块里，但 `readSessionMessages()` 只收 `text` 块，`ChatMessage` 也没有图片字段——于是刷新后只剩一行 `【附件：m3k2j1-a1b2c3d4-____.png】`。现在历史带 `images: {mimeType, line, index}[]` 元数据，图片本体走 `GET /api/agents/:id/sessions/:sid/messages/:line/images/:index` 按需取。**不内联进历史响应**：一张截图 1–3MB，实测存在 13MB 的带图会话，内联会让每次开窗都传几十 MB
- **附件清单里是随机 id 而不是文件名**：`/api/talk` 的 `attachments` 现在接受 `{id,name}`（旧 `string[]` 仍兼容），会话文本里写用户看到的原始文件名。归一化逻辑抽成 `normalizeTalkAttachments()`，可单测
- **只发图不打字时，刚发出去那一刻连气泡都没有**：`deliver()` 只把 text 推进消息流，而正文为空时气泡不渲染。现在消息带 `localAttachments`，缩略图直接可见；原来 `clearPending()` 会 `revokeObjectURL`，把刚发出去的图当场变成破图，改成不 revoke（blob 随组件卸载回收）
- **图片只存在于 web-inbox 的这一轮**：`finally` 里删掉原图，所以任何"给个 URL 就行"的修法都不成立——唯一可行路径是从会话文件把 base64 读回来

### 新增

- 用户气泡里的图片：历史按行号回取、刚发出用本地 blob，缩略图固定 208×128（`object-cover`），点开看原图
- `readSessionImage()`：用 `Buffer.indexOf` 逐行定位，不为一张图 split 整个几十 MB 的会话文件；MIME 白名单只放 `image/*`，单图上限 20MB
- 纯图片消息不再被"空正文"过滤掉（`filter` 条件加上 `images.length`）

### 验收

![网页对话窗历史里的图片（刷新后仍在）](/verify/2.2.2-web-chat-images-history.png)

![只发图不打字时，发送当下就能看到缩略图](/verify/2.2.2-web-chat-images-send.png)

- 第一张：① 历史消息里的第 1 张图、② 第 2 张图，③ 附件清单是 `before.png、after.png` 这类原始文件名（修复前是 `【附件：m3k2j1-…-____.png】`）
- 第二张：只发图、不打字，发送当下气泡里就有缩略图（①），该轮照常拿到回复（②）——修复前这一刻连气泡都不存在
- 接口冒烟（隔离数据：`WAKER_DATA` + `PI_HOME` + 端口 8799，未碰真实 `data/`）：`GET .../messages` 返回 `images: [{mimeType:"image/png",line:4,index:0}, {…,index:1}]`；`GET .../messages/4/images/0` → `200 image/png 488205 bytes`，`index=2`、`line=99`、非图片行 → `404 {"error":"图片不存在或已不可读"}`
- 全量 `npm test` 通过（新增 `sessionHistoryImages` 20 项、`attachments` 由 19→27 项），后端 `tsc --noEmit`、前端 `tsc -b` + `vite build` 均无报错

## [2.2.1] - 2026-11-05

### 修复

- **飞书询问卡片正文与按钮重复**：`replyAskCard` 把「回 1 / 回 2」拼进 `text` 后又把这个 `text` 当卡片正文，卡片里一行字、下面一排按钮。现在 `composeTopicAsk()` 一次产出两个产物：卡片正文只放问题，「回 1 / 回 2」只留在**卡片发不出去时的纯文本退路**里
- **点完按钮卡片一动不动**（实测反馈：不置灰、不显示点了什么、不知道还在不在处理）：`card.action.trigger` 的 ack 现在直接带回新卡片——按钮整块删掉（2.0 的 `button` 没有 disabled 语义）、写明「✅ 已选择：切回去」、加 ⏳ 进度；答完再用 `im.v1.message.patch` 刷成终态。三处例外各有专门状态：会话忙保留按钮只给警告 toast、提问已失效进 `expired`、处理抛错进 `failed`
- **网页端的话题跳转建议永远弹不出来**：`semanticInputFor` 一次批量算 10 个会话共 81 块，bge-m3 实测 3.4s，而超时是 2s → 每次超时后整条链路降级成词面；中文短句词面重合接近 0，`confidence` 到不了 0.5。现在超时 2s→6s、候选每会话只取 3 块、当前会话与候选分两批（候选失败只丢候选，仍能判"继续/新话题"）。实测同一句话：修复前 `continue / regime=lexical`，修复后 `switch / 0.56 / regime=semantic`，冷启动 1.2s、热 160ms
- 网页端建议条存在时仍能再发一条，导致两条建议叠着出现。现在有待确认建议时发送按钮置灰并提示
- **小模型仲裁（laya）从接上那天起就没跑通过**：`/v1/chat/completions` 对 decision 类型模型一律回 `No models loaded`（那句话的意思是"没有 llm/vlm 实例"，不是没加载；`lms ps` 里 laya 一直 IDLE 常驻 449MB）。早先按"轻量对话模型"接入，prompt 还要求它输出 `CONTINUE / NEW / SWITCH n`——而 laya 是 ModernBERT 编码器，没有生成能力。现在改走决策模型专用接口 `POST /v1/systemone`（choice + 概率），新增 `ArbiterConfig.api: 'systemone' | 'chat' | 'auto'`；`auto` 先试 systemone、不通再退 chat。实测 176~265ms
- 决策模型的输入必须**整段塞进一个物理 batch（512 token）**——双向编码器不能像对话模型那样分批喂 context。实测 state 342 字 = 565 token 直接被拒（`increase the physical batch size`）。现在 systemone 的 state 按 220 字硬裁，超预算先砍候选，只保留"当前话题 + 这句 + 旧话题名"
- **"切回旧话题"永远判不出来（本轮最关键的 bug）**：候选批超时会让 `semantic.candidates` 变成空数组，而挑候选的函数在"有语义"分支里直接返回这个空数组 → 喂给决策模型的是**零个旧话题**，它只能答"继续 / 新话题"。现在候选为空时退回词面排序；且候选按相似度（无语义时按词面重合、再按最近活跃）排序取前 3——不排序随便截 3 个，目标常常不在里面
- 决策模型的提问从「action + target 两个问题」改成**一个问题一次分类**（`current / c1..cN / next`）：拆两个问题时模型会给出互相矛盾的答案（实测 `action=continue` 而 `target=c1`），本来就是同一个判断
- `systemone` 请求加 `temperature: 0`：不加时同一条消息会摇摆（同一句一次判 `switch`、一次判 `new`），于是"点了建议却没切"看起来像 bug
- 候选描述从"只有标题"改成「标题 + 12 字摘要」：只给标题时「切回树莓派那个项目」面对《AI产品四问清单与飞书授权》会被判成 NEW
- 网页端判定加了**硬预算**（语义 800ms、仲裁 600ms）：LM Studio 忙时单条 embedding 要 2.8s，叠上仲裁一次发送要等 5~8 秒。超时就按"仅词面 / 判定不可用"继续发——宁可少弹一次建议，也不能让发送卡住
- 网页端每次发送都往消息流落一行判定结论（`话题判定：继续当前话题 · 0.32 · 语义`），判成"继续"时不会有建议条，不写这一行用户会以为功能没生效；同时 `/route` 也写 `data/routing.jsonl`（`source: 'web'`，含候选 id 与模型原始答案），排查不用再靠猜
- 建议条里的目标标题与会话列表统一取 `title || name`：两处名字不一致时，界面一边显示「树莓派AI问答机落地」、一边显示「另外一件事儿，我要用树莓派3b…」，用户不知道自己切到了哪

### 新增

- 网页对话窗接上 `new` 分支：判定成新话题时弹「这看着像个新话题 → 开新会话并发送 / 就在这儿发 / 取消」，与飞书「要开一个新话题吗」对齐
- 接受建议后落一行状态：`已切到《X》，正在按你刚才那句回答…` → `已处理完成`（忽略建议同样给「好，就在当前话题里回答…」）。这是网页端唯一能确认"我点的动作真的生效了"的地方
- 判定期间显示「正在判断这句该装进哪个话题…」，避免按了发送却迟迟没动静
- 网页端**建议线**比 IM 的自动判定宽 0.05（`WEB_SUGGEST_MARGIN`）：网页只弹一条可点可不点的建议，误判代价是一次点击；IM 要动指针、要耗询问配额，必须更保守。不改任何会话状态，接受才动 `activeId`
- 网页端切换"看不出切了"：头部原来只有一行 11px 灰字「话题：X」，两边标题都长时几乎无感。现在切换后头部亮 4 秒并带「刚切换」徽标，消息流里再插一条本地系统行「已从《A》切到《B》，这条提问装在这里」（两处都说，才不容易漏看）
- 网页端的 `/route` 也接上小模型仲裁（与飞书同一条链路）：之前只有向量 + 词面，判不出「新话题」；现在 `帮我把下周去京都的三天行程排一下` 能判成 `new`（0.75），`继续把需求验证的判据补上` 判成 `continue`（0.9）
- 仲裁判「新话题」时网页端再加一道向量闸门：向量认为明显还在当前话题就不弹（建议条是主动打断，误弹一次就是一次打扰；IM 那边有询问配额与拒绝计数兜着）
- `scripts/verify-shot.mjs` 支持 `type` / `submit` / `afterClick` / `waitAfterClick` / `script`（最后一项用来在执行前 stub 掉 `/route`，于是"切过去"这类分支能在**临时会话**里稳定复现，不污染真实数据）；标注改为优先命中「自己的文本节点」，两个按钮不再被圈进同一个容器

### 验收

> 这一版的两张验收图取自生产数据（真实员工名、会话内容与飞书文档链接），开源仓库不发布；下面用文字记录验收点。

- ① 发送前就识别出「这句像是在聊《esp32-cam》」，② 附相似度与上次摘要，③ 「切过去并发送」一键切回并发这条，④ 「就在这儿发」留在当前话题
- 后端同一句话直接打接口：`POST /api/agents/chat/route` → `switch 0.5 semantic`，目标会话标题正确（修复前是 `continue 0.04 lexical`）
- 新话题那条（第二张图）：`帮我把下周去京都的三天行程排一下` 被判成新话题后弹出「这看着像个新话题 → 开新会话并发送 / 就在这儿发」
- 接受/忽略路径在真实 Chrome 里点过：消息落在对应会话、`好，就在当前话题里回答…` 与 `已切到《X》…` 两行状态正常出现；验证用的临时会话已删除
- 网页端切换路径的隔离验证：stub `/route` 返回 `switch` 指向临时会话后点「切过去并发送」——消息落在**目标**会话（2 条）、原会话仍为 0 条；头部出现「刚切换」、消息流出现「已从《验收图-当前》切到《验收图-目标》，这条提问装在这里」
- 飞书侧真机验证（`scripts/card-selftest.ts` 新增 `--patch`）：卡片 2.0 结构被接受（845 字节），`im.v1.message.patch` **成功**把 `om_x100b61f00112f4accfdbdd02c66b815` 刷成「✅ 已选择：切回去 · 已处理完成」→ 完成态不需要降级方案
- 飞书新增三行排查日志：`卡片点击：yes/切到 <id>（没有可对应的窗口）（忙，未处理）`、`更新询问卡片被拒: <code>`、`询问卡片已更新为 done/failed`。卡片回调没有消息原文可看，出问题时只有日志能说清是哪一环断了
- 全量 `npm test` 通过（topicCard 56 / arbiter 47 / semantic 42 / 其余原样），`tsc --noEmit` 与 `pnpm build` 均无报错
- 仲裁接上决策模型接口后的实测（`POST /api/agents/chat/route`，会话「需求验证」）：
  - `树莓派那个 3b … 摄像头换成 ToF` → `switch 0.9`，目标《AI产品四问清单与飞书授权》
  - `那我们继续把需求验证的判据补上吧` → `continue 0.9`（仲裁 laya 216ms：继续）
  - `帮我把下周去京都的三天行程排一下` → `new 0.75`（仲裁 laya 244ms：新话题）
  - 修复前三条全是 `continue / regime=lexical`

## [2.2.0] - 2026-11-04

### 新增

- `/topics` 改发**折叠卡片**（`buildTopicListCard`）：每条话题一个 `collapsible_panel`，收起时一行「序号 + 标题 + 相对时间 · 条数（· 当前）」，展开看会话卡摘要，非当前项带「切到这儿」按钮直接落指针。卡片回调新增 `{k:'topicPick', sid}`，与 yes/no 的 `{k:'topic'}` 分开；点当前话题只回「不用切」
- 列表卡片的纯文本退路按"能区分"重写：每行带序号、标题、时间条数、当前标记，第二行缩进放摘要首句。卡片发不出去时（租户没开 `interactive` / 权限异常）信息量不降级
- `SessionMeta.nameFrom`：名字来源分档 `derive`（首句截 18 字）→ `messages`（模型读对话起的）→ `card`（会话卡首行派生）。升级单向，`manual` 永不覆盖；存量数据没有该字段时只有"明显没人起过"的名字才会被卡覆盖
- `titleFromSummary()`：会话卡生成后顺手把标题升级成卡的第一行（≤14 字），不额外调一次模型

### 修复

- **`/topics` 里所有会话都显示成"用户最后那句话的截断"**：`title` 是建会话时按首条消息派生的，而列表用 `title || name` 取值——模型起的名字（`name`）一次都没露过面。现在统一走 `displayNameOf()`：真名字 > 派生标题 > 兜底名
- 摘要模型有时在正文前多写一行「摘要：」，卡片第一句就变成这个标签。`splitSummaryOutput()` 与列表展示两处都剥掉
- 缺会话卡的会话在列表里退回「你：… 我：…」四行原文，用户反馈"看着像原文不像总结"。现在只给一句最近提问，并明写"还没有摘要（后台会补）"，同时给这些会话记一笔 dirty，后台扫描器下一轮补卡
- 「切换目标 = 当前会话」时仍会提示切换：仲裁层把 `SWITCH 指向自己` 翻成了 **NEW**（白开一个弹巢，是这条链路里最贵的错），现在退化为 `continue`
- 确认卡片（`applyPending`）落指针前不再比一次：卡片发出到用户点确认之间，指针可能已被手动切走、或目标会话被删后 `resolveSession` 回落成默认会话，于是回复「已切到《X》」而本来就在 X，还写出 `transferredTo` 自环。现在这种情况回「就是当前话题，没有切换」
- `/resume 序号` 点到当前话题不再报「已切到」；飞书路由在 switch 目标为空/相同时按继续作答，不再掉进 auto 分支的 `openNewChamber`

### 变更

- 摘要提示词改为**一次调用产出「标题 + 摘要」**：第一行 `标题：`（≤12 字短语，写话题本身而不是用户原话），后面才是摘要。标题与摘要是同一份理解的两个输出，分两次调模型等于把对话读两遍
- 自动命名闸门：首句派生的名字（`nameFrom: 'derive'`）不再被当成"已经有人起过"，第 3 轮照常起名——实测这类名字长成「你可能能从记忆里找到，我们之前聊到如…」，在列表里两条完全分不出谁是谁。存量里"以省略号结尾"或"顶到 16 字且结尾不是标点"的名字同样按派生处理（`looksDerivedName`）

### 验收

本版改的是飞书卡片与命名链路，没有 web 页面改动，因此无截图。验证口径：

- `npx tsc -p tsconfig.json --noEmit` → 0 error
- `npm test` → 15 个测试文件全绿；其中新增 `buildTopicListCard` / `composeTopicList` / `parseTopicPick` 共 22 条断言、`titleFromSummary` / `canNameFromCard` 共 12 条、`shouldAutoName` 的 `nameFrom` 分档 5 条、仲裁「切回自己 = 继续」2 条
- 真实飞书客户端的卡片渲染无法在本机复现（需要租户开启 `card.action.trigger` 与真实应用凭证），`collapsible_panel` 的展开态属首次使用，上线后第一次 `/topics` 需人工看一眼渲染是否符合预期

## [2.1.0] - 2026-11-03

### 新增

- 待办（Todos）：`data/todos.jsonl` + `GET/POST /api/todos` 与 `done / dismiss / snooze`。人类任务与 agent 任务是同一种对象，靠 `assignee` 区分；到期与过期**不入库**，由 `dueAt` 派生
- pi 扩展 `extensions/todo.ts`：`todo_add / todo_list / todo_done / todo_snooze`。直接调看板 HTTP，不经 bash（`waker-guard` 白名单不含 `waker`，走命令行必被拦）
- agent 任务到点自执行（`src/scheduler/todos.ts`，30s 扫描）：沿用留下任务时的会话执行，结果通过 `Channel.notify` 回发原飞书窗口（群聊发 `chat_id`，私聊发 `open_id`）
- 看板「待办」面板：到期橙黄呼吸 / 过期红色脉冲；`prefers-reduced-motion` 下降级为静态底色
- 待办详情弹窗：点卡片看完整说明、执行结果与来源；「定位到来源消息」跳回会话并**滚到 / 高亮留下它的那一条**（弹窗挂到 `body`，否则被 `.glass` 的 backdrop-filter 形成 stacking context 压住，按钮点不到）
- 待办记录 `sourceTaskId`：Runner 向 pi 注入 `WAKER_TASK_ID` / `WAKER_SESSION_ID`，扩展写待办时自动带上；看板按 task 反查用户原话完成定位，模型不需要额外传参
- `tests/todos.test.ts`：28 条断言，覆盖相位边界、顺延基准（过期任务不能把过期时间再往后挪）、`externalKey` 解析、状态迁移

### 变更

- `BoardSnapshot` 增加 `todos`：看板 5s 轮询一次就能拿到待办，不再单开请求
- 飞书出站新增 `chat_id` 通道（原本只有回帖与私聊 `open_id`），`Channel` 接口增加可选的 `notify()`
- 总览栏去掉「成功 / 失败」这两个历史累计值（499 / 12 这种数字没有决策价值），改为「今日提问 N 次」与「今日待办 已完成 X / 待完成 Y」
- 定时任务面板加「已完成 / 失败 / 计划中」统计：任务流水新增 `automationId`，只统计**当前仍存在**的任务，避免"0 个任务却完成 62 次"的怪数

### 修复

- 对话里「留任务」只写到工作目录的 `待办.md` 并声称"到时候提醒你"：平台没有任何记录、到点也不会触发。根因是 agent 没有创建任务的通道（bash 被前缀白名单拦掉），且工具描述没有强制"未成功不得声称已记录"——两处都已补上
- 看板「今日任务」按 **UTC 日期**切分：东八区早上 8 点前跑的任务会被算到"昨天"、晚 8 点后算到"明天"。改为按本地日期切，并在悬停说明里写清口径（执行次数，不是待办数量）
- 待办定位后 5 秒被拽回会话结尾：高亮清除时 `focusIdx` 变 null，滚动 effect 重新执行走了「滚到底」分支。现在定位滚动与自动到底彻底分开，定位后不再自动滚动（自己发消息或切会话才恢复跟随）

### 验收

总览栏三个指标（截图由 `scripts/verify-shot.mjs` 生成、红框自动标注）：

> 这两张图取自生产数据（真实员工名、会话标题与本机路径），开源仓库不发布；可用 `bash scripts/demo.sh` 生成隔离演示数据后自行复现。

状态用图标表示，不再堆文字：`✓` 完成 / `○` 待完成；`✓` 成功 / `✕` 失败 / `⏱` 计划中。

样例口径：`今天到期·还没做` + `昨天到期·逾期未做` → 待完成 2；`明天到期` 不计入；`今天到期·已完成` → 已完成 1。

## [2.0.1] - 2026-10-31

### 新增

- 飞书渠道支持非文本消息：图片走模型视觉输入，图文富文本（`post`）抽取文字与图片，文件落到 `data/feishu-inbox/` 后作为 `@附件` 交给 pi
- `RunOptions.attachments`：附件必须以独立 argv `@/abs/path` 传给 pi。写在 `-p` 的文本里**不会被解析**（实测 user content 只有 text、input 209 tokens），只有位置参数才会生成 `{"type":"image"}` 内容块
- `tests/feishuMedia.test.ts`：33 条断言覆盖全部消息类型的归一化结果，含空文本、缺 key、非法 JSON 三类异常分支
- 文档正文提取（`src/channels/docExtract.ts`）：飞书发来的 PDF / docx / pptx / xlsx / doc / rtf / odt 先抽成文本再交给模型，**零 npm 依赖** —— PDF 走本机 `python3` + pypdf，Office 走系统 `unzip` 解 XML，老格式走 macOS `textutil`
- `tests/docExtract.test.ts`：30 条断言覆盖扩展名分派、XML 还原、实体解码顺序
- 看板 web 聊天窗支持附件：**粘贴**（截图直接 Ctrl+V）、**拖拽**、**回形针选文件**三种入口，图片给缩略图、文档给文件名，可逐个移除
- `POST /api/upload`：base64 走 JSON 落盘到 `data/web-inbox/`，返回 `id / name / size / kind`；单文件 20MB、单条消息最多 6 个
- `POST /api/talk` 接受 `attachments`（上传返回的 id 数组），文档自动抽正文换成 `.txt` 再交给 pi
- `src/core/attachments.ts`：飞书与 web 共用的"落盘后加工"层，`prepareFileForModel` 只有一份实现
- `tests/attachments.test.ts`：19 条断言，重点是 `../` 路径穿越必须被挡死

### 变更

- 位置消息、分享群聊 / 分享联系人转成可读文本交给模型，不再丢弃
- `chat` 与 `Public-Opinion` 的模型改为 `deepseek/deepseek-flash`：`pi --list-models` 里只有它是 `images=yes`，`deepseek-v4-flash` / `deepseek-v4-pro` 都是 `no`
- 带附件的消息**不走话题路由**，直接落在当前会话：询问卡只存 prompt 字符串，用户隔一会儿回「切过去」时附件早已清理，硬切会静默丢图
- `readBody` 支持按路由放宽上限并改用 Buffer 累积：附件走 base64，2MB 默认值会把一张普通截图挡掉；而 27MB 的请求体用字符串反复拼接会明显拖慢
- web 端"只有附件、没有文字"也允许发送：服务端补默认话术 `帮我看看这个。`，并在 prompt 末尾留一行 `【附件：xxx】`，否则刷新会话后看不到自己发过什么

### 修复

- 发图片 / 文件 / 语音后机器人毫无反应：`onMessage` 原来是 `message_type !== 'text' → return`，且在去重、白名单、加表情**之前**就返回，日志里连痕迹都没有。现在改为"要么翻译成 text + 附件进模型，要么回一句人能看懂的话"
- 附件下载异常会被外层 `.catch` 吞成一行日志：现在自己兜住并把原因回给用户，避免"修好的静默"换个入口复发
- 附件临时文件随任务结束立即删除；进程启动时顺带清理超过 24 小时的残留（只覆盖崩溃 / 被强杀路径）

### 已知限制

- 语音、视频、表情包、卡片、合并转发只回一句提示，不进模型：语音需飞书 `speech_to_text` 权限且免费版不可用，视频只能拿到封面，表情包飞书不开放资源下载
- **扫描版 PDF**（纯图片、无文字层）提取不到正文，会明确回一句"请把关键页面截图发我"，而不是让模型对着空文本编
- xlsx 只取共享字符串池，不保留行列结构；需要精确表格请把表格截图或转成 CSV 发
- 文档正文上限 20 万字符，超出会截断（`ExtractResult.truncated` 标记，目前只记日志不提示用户）

## [2.0.0] - 2026-10-25

### 新增

- 架构与版本页（看板 `#/architecture`）：分层架构说明 + 当前版本 + 本文件的更新记录，发版后打开即知改了什么
- `GET /api/architecture`：返回 `package.json` 版本、架构分层清单与解析后的更新记录，网关重启即读到新内容
- 运行时可观测：`GET /api/runtime` 列出本进程拉起的 pi 子进程、输出尾部与排队情况
- 用量统计：按 pi 原生会话文件聚合 token 与费用，支持按员工筛选

### 变更

- 会话模型改为"一个员工多个会话"：`data/sessions.json`（有哪些会话）与 `data/conversations.json`（窗口对准哪个会话）分离
- 话题路由：语义 / 词面 / 时间窗三套刻度判定"继续 / 切换 / 新开"，低置信度时静默继续而不是打断
- 会话瘦身（compact）：超过阈值自动压成纪要，旧会话文件改名归档、可翻回
- 渠道随看板一起启动（飞书长连接），不再需要独立 bot 进程；`POST /api/channels/reload` 改完即生效
- 浏览器能力改由常驻 broker + Chrome 扩展提供，复用真实登录态；单标签页排队，队列满直接拒绝

### 修复

- 前端 `index.html` 改为 `no-store`：修掉"重新构建了但看板还是旧界面"的缓存问题
- 任务运行期间同步起 `caffeinate` 断言，任务结束自动解除，不留残留进程
- 询问配额用尽后不再"不问直接切"：`ask: always` 时退化为留在当前会话（此前会滑进 auto 分支直接搬指针）
- 新增 `session.autoSwitch`（缺省 true）：设成 false 后判定为换话题一律先问，`ask: never` 与拒绝配额都绕不过；`chat` 已启用

## [1.0.0]

### 变更

- 平台首版：档案式员工（`agents/<id>/`）、命令与路径门禁、任务流水、看板与网关。代码已冻结为存档，不再接受功能改动
