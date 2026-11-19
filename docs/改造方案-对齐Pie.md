# 改造方案：把 Pie 的能力落地到 Waker

> 目标：在 Waker 里跑出一个**完整功能的 Pie**——多 profile、可插拔 IM 渠道、会话可管理、运行时可见。
> 本文先诊断现状，再给出对象模型与分阶段落地路径。

---

## 一、现状诊断（你提的三个问题）

### 1. 对象模型错位：agent 直接绑死单会话

现状（代码事实）：

- `runner.ts` / `bin/waker.ts` / `gateway/http.ts` 三处都把会话写死成 `waker-<id>`；
- 即"一个员工 = 一个会话"，没有"员工拥有多个会话"的概念；
- `--fresh` 是唯一的重开方式，旧上下文无法保留、无法命名、无法回溯。

**结论**：缺少 Session 这一层对象。Pie 里 profile 与 session 是一对多，Waker 目前是一对一。

### 2. 飞书接入是两套割裂的东西

| 组件 | 位置 | 职责 |
|------|------|------|
| `feishu.ts` 扩展 | `~/.pi/agent/extensions/` | 给 agent 注册**工具**（`feishu_send_message` 等），是**出站**能力 |
| `feishu-bot/` | `~/.pi/agent/feishu-bot/bot.mjs` | 独立长连接 bot 服务，**入站**：飞书消息 → spawn pi → 回帖 |

两者各管一段、各自维护会话映射（`u_<open_id>` / `g_<chat_id>`）、各自读配置，Waker 完全不知情。

**结论**：缺少 Channel 抽象层。渠道逻辑散落在 Pi 扩展和独立服务里，平台看不到、管不了。

### 3. 为什么会有 Docker

来自 Waker 自研的 `waker-guard.ts` 扩展：

- Pi 内核默认 YOLO（工具调用无审批）；
- Waker 在**工具替换层**覆盖 `bash`，当岗位策略 `policy.sandbox: true` 时，命令改走 `docker run --rm alpine` 执行；
- **默认 `sandbox: false`**，即默认不用 Docker；只有显式开启的岗位才走容器。

**结论**：Docker 不是必需依赖，而是"可选执行隔离"。定位需要说清、并在界面/文档里显式化。

---

## 二、目标对象模型（对齐 Pie）

```
Profile（员工 / Agent profile）
  ├─ 来源：local（项目档案） | pi（纳管 ~/.pi/agent/agents/*.md）
  ├─ 配置：model / tools / cwd / policy
  └─ Session（1:N）
        ├─ id / name / createdAt / lastActiveAt
        ├─ 绑定一个 pi 会话（--session-id）
        └─ Task（1:N，任务流水）

Channel（渠道，可插拔）
  ├─ feishu / wechat / discord / dingtalk ...
  ├─ 入站：外部消息 → 路由到某 Profile 的某 Session
  ├─ 出站：Profile 产出 → 回帖到外部会话
  └─ 会话映射：外部会话 key ↔ Waker Session
```

与 Pie 五层的对应：

| Pie 层 | Waker 对应 |
|--------|-----------|
| Desktop app | Web 看板（已有，需补会话/渠道/运行时视图） |
| Runtime | `runner.ts`（拉起 pi 子进程） |
| Agent Harnesses | Pi（默认）；预留多 harness 适配 |
| Channels | **待建**：`src/channels/` 抽象层 + 飞书渠道 |
| Profile state | `agents/` + 纳管的 Pi profile + `data/` |

---

## 三、分阶段落地

### P0 环境解阻（已完成）
- 剥离宿主注入的 `NODE_OPTIONS`（IDE shim 依赖已删除的 `.hermes/node`），pi 子进程不再启动即报错；
- 验证：本地员工与纳管的 Pi profile 均可对话。

### P1 会话模型（已落地）
- 新增 `src/core/sessions.ts`：员工 1:N 会话的存储与增删查（`data/sessions.json`）；
- 会话映射到确定的 pi `--session-id`，默认会话保持 `waker-<id>` 向后兼容；
- 网关新增会话接口；`/api/talk` 支持指定会话；
- CLI：`waker sessions <id>` 列会话、`waker chat <id> --new` 新开；
- 看板：对话窗增加会话列表 / 新建 / 切换。

### P2 渠道抽象（飞书统一）—— 已落地

- 新增 `src/channels/`：`Channel` 接口 + `ChannelManager` + `FeishuChannel`；
- 每个 profile 一套独立飞书应用：`channels.feishu`（`enabled` / `appId` / `agent`）+ `secrets.json` 的 `appSecret`；
- **入站**：`im.message.receive_v1`（长连接，无需公网）→ 会话 key（`u_<open_id>` / `g_<chat_id>`）→ **平台会话**（`resolveSessionByKey`）→ `runWaker` → 回帖；
- **出站**：复用 `feishu.ts` 扩展给 agent 的 `feishu_*` 工具（agent 主动发消息）；
- 渠道随 `waker board` 一起启动，无需独立 bot 进程；`GET /api/channels` 暴露状态，看板顶栏显示渠道灯；
- 会话 key 与平台会话统一：同一个飞书会话稳定落在同一个平台会话（P1 的 `externalKey`）。

迁移提示：`FeishuChannel` 与旧 `feishu-bot` 会争抢同一个 appId 的长连接，切换期间请先停掉后者
（`~/Library/LaunchAgents/dev.pi.feishu-bot.plist`，用 `launchctl unload`）。

### P1.5 per-profile 配置（已落地）

每个 bot 有**自己的一套** LLM 与渠道凭证，而不是全局共用：

- **LLM**：`waker.yaml` 的 `llm` 段（`provider` / `model` / `thinking`），`apiKey` 放同目录 `secrets.json`；
- **飞书应用**：`channels.feishu`（`enabled` / `appId`），`appSecret` 放 `secrets.json`；
- 合并优先级：`secrets.json` > `waker.yaml`；密钥文件已 gitignore（`agents/*/secrets.json`）；
- 运行期由 `llmArgs()` 映射为 pi 的 `--provider` / `--model` / `--api-key` / `--thinking`；
- `agent inspect` 脱敏展示（只暴露 `hasApiKey` / `hasAppSecret`，不返回明文）。

```yaml
# agents/<id>/waker.yaml
llm:
  provider: deepseek
  model: deepseek-v4-pro
  thinking: medium
channels:
  feishu:
    enabled: true
    appId: cli_xxxxxxxx
```

```json
// agents/<id>/secrets.json （已 gitignore）
{ "llm": { "apiKey": "sk-..." }, "feishu": { "appSecret": "..." } }
```

### P3 运行时可观测（已落地）

- 新增 `src/core/procs.ts`：进程内登记表（spawn 即登记、输出实时入尾部缓冲、结束注销）；
- `runner` 侧修掉两处运行时缺陷：`pid` 原先只在任务**结束**时才写入 → 运行期"终止"拿不到 pid；
  被终止的任务其 `cancelled` 状态会被收尾判定覆盖成 `failed`；
- 网关 `GET /api/runtime`：在跑的子进程（员工 / 来源 / pid / 已运行时长）+ 实时输出尾部 + 网关开销；
  `POST /api/tasks/:id/cancel` 改为先杀登记表里的子进程（SIGTERM，5s 后 SIGKILL）；
- 看板新增**运行时面板**：有执行时才出现，可逐个终止；
- 会话活跃度（会话列表 `lastActiveAt` / running）与渠道连接状态（`/api/channels` + 顶栏渠道灯）此前已具备。

边界：登记表只能看见**看板进程自己拉起**的执行；CLI 是独立进程，不在其中。

### P4 多 Harness（暂不做）
- `runner` 抽象出 harness 适配器，Pi 为默认，预留 Ousia / Codex 等。
- **2026-10-11 决定：暂不做更多 harness。** 代码里 `runWaker` 仍是 Pi 单实现，不预留抽象层（避免为假想需求增加间接层）。

### P5 记忆归属三档（已落地）

原先是"一个员工一个 namespace"的纯隔离，导致「关于用户的偏好」每个 bot 都要重新学一遍。
改成三档可见性：

| 档 | 判定 | 写入口 |
|---|---|---|
| 私有 | `project == WAKER_ID` | 自动抽取一律落这里 |
| 共享 | `project == shared`（`retrieval.shared_namespace`） | 仅显式 `memory_save(scope="shared")` |
| 知识库 | `source == knowledge` | `/api/knowledge`、`knowledge_import` |

- 读路径：`retrieval.py` 的可见性过滤加一档；注入路径按 `shared_slots`（默认 1）**预留位**，
  并从该组配额里扣除，避免共享条目被最后一步 `top_n` 截断；
- 写路径：默认私有，共享档只走显式写入——**不按类别自动分流**，因为类别本身不稳
  （实测一条技术决策被抽成 `fact`，而 `fact` 同时混着用户级与环境级信息）；
- 顺带修 `app.py` 的 `_import_text`：`await` 写在非 async 函数里导致服务启动即 SyntaxError。
- **同文去重**（2026-10-11 补）：把老库记忆**复制**到某个 waker id 名下时，库里会留下同文两份
  （共享一份 + 私有副本一份），两份都会过可见性过滤、一起进候选，白占注入位。
  `retrieval.py` 现在按内容去重（保留分数最高者），且配额循环内同文被跳过时**不占名额**、顺延下一条。
  实测同一问 5 个名额从"被重复吃掉 2 个"恢复到全部有效。

### P6 并发保护（已落地）

原先平台侧**没有任何并发保护**：同一个员工可以被 cron、手动、看板同时拉起多个 pi 子进程。

- 锁粒度定在 **piSessionId** 而不是员工——冲突的真实单位是"一个 pi 会话文件被两个进程同时写"；
  同一员工的不同会话本就该并行（定时任务每次新开会话，不该被飞书私聊堵住）
- 排队而非拒绝："连发两条消息"是常态，拒绝会丢消息；排队正好启用了一直躺着的 `queued` 状态
- 两级上限兜底：每员工 3、全局 6
- 网关启动时收尾上一轮遗留的 `running` / `queued`（子进程已随进程退出，状态一定是假的）
- 飞书渠道原来那个 `busy` 集合**保留但改注释**：它只做"快速回你一句稍后再发"的体验，
  正确性不再依赖它（否则会变成同一规则两处实现，迟早分叉）

**跨进程补充（同日落地）**：进程内队列管不住"CLI（另一个 node 进程）与看板用同一个会话"这种情形，
因此再叠一层文件锁 `data/locks/<piSessionId>.lock`：

- 锁文件记 pid，持锁进程崩溃后由 pid 存活检测自动清理（否则崩溃一次就永久锁死该会话）；
- 轮询等待，超时给明确报错而不是无限挂起；
- 实测：`waker say chat` 占着会话时，看板的同一会话请求显示「排队中」，CLI 结束后自动接着跑完。

### P7 记忆生命周期（第一步已落地）

**决定：不做自动 TTL。** 记忆一旦入库就会被反复注入，误删长期记忆的代价远大于多留几条垃圾；
而且刚把整库归了共享，自动判错会同时影响所有员工。改用"源头约束 + 人工审阅"：

- 抽取侧（`extractor.py` 提示词）明确禁止记**进行中的临时状态**（"正在调试 X"）、一次性反馈、碎片口令；
  要抽就抽它背后稳定的那部分。
- `waker memory review`：按高置信规则（碎片口令 / 短句进行时 / 完全重复）挑出可疑条目，
  人工决定删哪些；`waker memory rm <id>` 删除。
  规则刻意收紧过一版——第一版把 64/1611 条都标了，其中大量是「…是目前最成熟的降本策略」
  这类实质论述，只因正文出现「目前」就判过期。噪声会直接摧毁清单的可信度。
- 首次执行：1596 条里挑出 17 条可疑，人工确认后删 15 条（3 条 zephyr 碎片、9 条知识库分块重复、
  5 条过期状态），保留 2 条误报。

暂不做的：`expires_at` 自动过期、按时间衰减排序（后者会打乱现有实测标定的召回阈值）。

### Group 多员工编排（暂不使用）

- 代码在 `src/core/group.ts`（成员并行 + Leader 汇总 + 主修改者唯一校验），但**没有接任何入口**：
  无 CLI、无 HTTP、看板无界面，`data/groups.json` 从未创建过。
- **2026-10-11 决定：先不上**（暂无协作场景）。代码保留，需要时接一个
  `waker group run <id> "<目标>"` 即可（约半天）。

---

## 四、关键取舍

| 议题 | 决策 | 理由 |
|------|------|------|
| 会话存储 | 平台侧 JSON（`data/sessions.json`）+ pi 原生 session 文件 | 平台需要列表/命名/状态，pi 只管上下文 |
| 默认会话 | 保留 `waker-<id>` | 向后兼容既有对话与飞书映射 |
| 飞书 | 复用现有凭证与长连接实现，**收编**进 Channel 层 | 不重造轮子，但让平台可见可控 |
| Docker | 保留但显式化，默认关闭 | 它是可选的执行隔离，不是平台必需依赖 |
| 纳管的 Pi profile | 只读 | 不在平台内改写 Pi 侧资产 |
| Pi 侧 agent 是否自动出现 | **默认不出现**（`config.piAgents=false`） | 只读纳管出来的员工：策略装不下、不能归档、名册还被搅乱。要哪个用 `waker import` 收编 |
| 导入时是否收紧命令 | **不收紧**，只复刻 `tools` | 随手写白名单会把它的能力废掉（例如 coder 需要 `node`/`npm`）；确认过工作流再收紧 |

---

### P6 本机 agent 导入（已落地）

原来只有"自动纳管"一条路：Pi 侧全部 profile 直接以只读形式混进名册。落地为**按需收编**：

- 新增 `src/core/config.ts`：平台级开关 `data/config.json` 的 `piAgents`（默认 **false**），
  `WAKER_PI_AGENTS=on|off` 可临时覆盖；`registry` 的 `listAllWakerIds` / `loadWaker` / `loadAllWakers`
  都按它决定要不要扫 Pi 目录 —— 关掉后未导入的 Pi agent 对平台"不存在"；
- 新增 `waker import [<id>]`：不带 id 只列清单（标"可导入 / 已导入"），带 id 则把
  `~/.pi/agent/agents/<id>.md` 收编成 `agents/<id>/` 五件套（frontmatter 映射为岗位字段，
  正文整体进 SOUL 不硬拆，立即编译）；Pi 侧文件不动，归档本地档案即回退；
- 网关 `GET /api/pi-agents`、`POST /api/agents/import`、`GET/PUT /api/config`；
  看板左侧新增「导入本机 agent」入口（弹窗内含"自动纳管"开关，并把两种方式的差别写在界面上）。

---

### P7 长上下文自动瘦身 + 记忆可靠性（已落地）

**自动瘦身**：pi 的会话文件只增不减（实测一条私聊 147KB ≈ 4 万 token，之后每条消息都全量带上）。
pi 在 CLI 侧没有 compact 开关，JSONL 又带 `parentId` 链不能中间裁 —— 所以走
「让模型压成纪要 → `clearSession` 归档原文 → 用同一个 `--session-id` 把纪要种回新会话」。
阈值 `context.maxTokens`（默认 30000）/ 目标 `keepTokens`（默认 6000）落 `data/config.json`；
每次任务结束异步跑（未达阈值只一次 `statSync`），抢锁只在归档+种回那两步，并校验摘要期间会话没长新内容。

**记忆可靠性**（这轮由"LM Studio 没加载模型，你确定记忆功能启动了么"引出）：

| 问题 | 事实 | 修法 |
|---|---|---|
| `/api/health` 恒报 `loaded:false` | 判据用 `lms ps`，而它**不列嵌入模型**、又慢又会挂（实测 >8s 无输出） | 改 HTTP 探活（`/v1/models` 认这个模型即可服务），`ok` 现在为 true |
| 嵌入失败**静默降级**写 hash 向量 | 库里有 **3 条**（全非负 = 无语义），永远搜不到、外部看不出来 | 重试 3 次（含探活唤醒）→ 仍失败则写入存 `embedding=NULL`／抽取整批重试／查询明确报错；**不再写垃圾** |
| 历史垃圾向量 | 3 条 | 新增 `POST /api/reembed` 重算；实测那 3 条中的"在做内容账号，赛道是职业分享…"现在可召回（0.887） |
| 看不到嵌入是否可用 | 只有日志 | `GET /api/status` 增加 `embedding.ok` 与 `embedding.degraded_rows`（真探活，缓存 60s） |

---

## 五、验收标准（"完整 Pie 跑在 Waker 里"）

1. 一个员工可以有多个会话，可新建、切换、命名、清空；
2. 飞书在同一个平台视图里可配、可见、可控，会话与平台会话打通；
3. 看板能看到 profile / session / channel / task 四类对象的实时状态；
4. 纳管的 Pi profile 与本地员工在同一套对象模型下等价使用。
