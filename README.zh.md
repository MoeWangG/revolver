# Waker · 本地数字员工平台

[English](README.md) | 中文

以 [Pi](https://github.com/earendil-works/pi)（MIT）为内核的本地数字员工平台：岗位化的 Agent 团队，常驻在你的机器上，通过 CLI 与本地 HTTP 接口完全操控。

## 为什么是这套

| 方案 | 结论 |
|------|------|
| QoderWake | 阿里闭源商业产品，不可自托管、不可审计 |
| Octop（腾讯，MIT） | 外壳开源，但 `harness-agent` / `harness-memory` 等核心引擎**尚未开源**，属"开源壳 + 闭源内核" |
| OpenClaw（MIT） | 完整产品形态，但它本身就建在 Pi 之上（12 万+ 行），直接下沉到底层更可控 |
| **Pi + 本平台** | 全链路 MIT；内核极简（4 个工具、系统提示词 <1000 token）；外壳自研，每一行可读可改 |

核心取舍：**薄外壳 + 深复用**。不在 Pi 之上再包一层重型运行时，而是用 Pi 官方 Extension 机制注入，外壳只负责三件事——身份装配、策略下发、任务编目。

## 架构

```
入口（手动 CLI / 定时 cron / IM / HTTP API）
        │
   platform 外壳（本项目）
   ├─ registry   档案扫描与校验
   ├─ identity   身份装配（外壳侧编译，不在运行时拼装）
   ├─ guard      策略编译
   ├─ runner     pi 子进程装配、超时、中断
   ├─ scheduler  cron / 一次性 / 事件
   ├─ board      任务流水编目
   └─ gateway    HTTP 数据源 + 静态看板
        │ 软链注入（不复制代码）
   Pi 扩展
   ├─ waker-identity   before_agent_start 注入岗位人设
   └─ waker-guard      bash 拦截 + 可选 Docker 沙箱
        │
   Pi 内核（MIT）：pi-agent-core / pi-ai
```

已有的记忆服务、知识库、WAL 会话索引、飞书接入、13 个技能**全部复用，不重建**。

## 快速开始

环境要求：Node 22+、pnpm、[Pi](https://github.com/earendil-works/pi) CLI
（`npm i -g @earendil-works/pi-coding-agent`）。飞书、记忆服务、Python 都是可选项。

```bash
git clone https://github.com/MoeWangG/revolver.git
cd revolver

# 一次装好：依赖、前端构建、Pi 扩展软链、waker 命令（装到 ~/.local/bin，不需要 sudo）
bash scripts/setup.sh

waker doctor                         # 自检（pi / docker / memory-server）
waker agent new reviewer
waker chat reviewer                  # 交互式
waker board --port 8787              # 打开 http://127.0.0.1:8787
```

只想看界面、不动自己的数据：

```bash
bash scripts/demo.sh                 # 演示数据，端口 8799
```

记忆服务（可选，随仓库分发在 `vendor/`，默认不启动）：

```bash
bash vendor/multi-pi-memory/memory-server/install.sh   # 交互式，选一个 embedding 后端
bash vendor/multi-pi-memory/scripts/start.sh           # 127.0.0.1:8971
```

前端开发态：`cd web && npm run dev`（已配 `/api` 代理到 8787）。
生产态：`bash scripts/setup.sh` 会自动构建；手动构建用 `pnpm web:build`。

## 命令

| 命令 | 说明 |
|------|------|
| `waker agent list` | 列出全部员工 |
| `waker agent inspect <id>` | 查看档案与诊断 |
| `waker agent new <id> [--role "职责"] [--cwd 目录]` | 创建员工，立即编译、立即可用 |
| `waker import [<id>] [--cwd 目录]` | 列出 / **导入本机的 Pi agent 为平台员工**（不带 id 只列清单） |
| `waker config [piAgents on\|off]` | 平台开关：是否自动纳管 Pi 侧 agent（默认 **off**） |
| `waker compile <id>` | 编译身份与策略产物，不执行 |
| `waker chat <id> [--new\|--session <sid>]` | **与该员工交互式对话**，接管终端；`--new` 新开会话 |
| `waker say <id> "<msg>" [--session <sid>]` | **说一句话**，保留该员工会话上下文，适合脚本 |
| `waker sessions <id>` | 列出该员工的全部会话 |
| `waker identity <id> [restore <文件>]` | 档案自改的状态、可回滚版本与留痕；`restore` 回滚某一份 |
| `waker power [on\|off\|status]` | 常驻防睡眠开关（断言挂看板进程，看板退出即释放） |
| `waker compact <id> [--session <sid>] [--force] [--status]` | 会话瘦身：把长上下文压成纪要（默认按阈值判断，自动瘦身也在每次任务后按同一阈值跑） |
| `waker channels` | 列出各员工配置的 IM 渠道（飞书） |
| `waker run <id> "<prompt>"` | 执行一次独立任务（不进会话，无上下文） |
| `waker cron add <id> "<cron>" "<prompt>"` | 注册定时任务 |
| `waker tasks [n]` | 查看最近任务 |
| `waker memory review` | 列出记忆库里的可疑条目（可能已过期 / 碎片 / 重复） |
| `waker memory rm <id>...` | 按 id 删除记忆 |
| `waker board [--port]` | 启动看板 + 调度器 + IM 渠道 |
| `waker doctor` | 环境自检 |
| `waker link` | 软链扩展到 `~/.pi/agent/extensions/` |

## 员工档案

```
agents/<id>/
├── waker.yaml     岗位元数据：职责、模型、工作目录、权限段、渠道、llm
├── secrets.json   LLM apiKey 与飞书 appSecret（已 gitignore）
├── SOUL.md        人设总纲（判断倾向、说话方式、底线）
├── identity.md    我是谁、服务对象、主要职责
├── persona.md     工作风格、产出格式偏好
├── bible.md       红线、禁止操作、需人工确认的动作
└── MEMORY.md      长期记忆（纳入 git，可回滚）
```

每个员工**自带一套** LLM 与渠道凭证（不全局共用）：

```yaml
# waker.yaml
llm: { provider: deepseek, model: deepseek-v4-pro, thinking: medium }
channels: { feishu: { enabled: true, appId: cli_xxxxxxxx } }
```
```json
// secrets.json（已 gitignore）
{ "llm": { "apiKey": "sk-..." }, "feishu": { "appSecret": "..." } }
```

策略段示例：

```yaml
policy:
  sandbox: false              # true 则 bash 全部走 Docker 容器
  commandAllow: ["ls", "cat", "grep", "find", "git"]
  commandDeny: ["rm ", "curl", "sudo", "chmod"]
  pathAllow: ["/your/workdir"]    # 可读写目录；留空 = 不限制
  pathDeny: [".ssh", ".aws", ".env"]
  requireConfirm: ["删除文件", "推送到远程", "发布"]
  selfEdit: false             # true 则它可改自己的档案（见下）
```

### 权限也能在看板里改

看板「编辑档案 → **权限**」直接编辑上面这段，不用手改 YAML：

- **可读写目录**（`pathAllow`）：单条增删的路径清单，一键「加上工作目录」；
- **保护名单**（`pathDeny`）：写片段即可（`.ssh` / `.env`），read 与 bash 都拦；
- **允许它修改自己的档案**（`selfEdit`）：开关，见下。

保存走 yaml 的 Document API **原地改键**（注释与排版都保留），写完立即重编译
`data/policy/<id>.policy.json` —— guard 读的就是这份产物，不重编译等于"界面上改了、门禁没变"。

### 员工改自己的档案（`policy.selfEdit`）

默认关闭。开启后它拿到 `waker_self_edit` 工具，能改自己那五份文本（SOUL / 身份 / 风格 / 红线 / 长期记忆），
但有三条**不依赖它自觉**的硬约束：

| 约束 | 实现 |
|---|---|
| **改不了权限** | `waker.yaml` 不在可改之列 —— 它无法给自己扩权、也解不开自己的门禁 |
| **写前强制备份** | 旧版本落到 `data/identity-history/<id>/`，`waker identity <id> restore <文件>` 回滚 |
| **每次留痕** | 追加一行到 `data/selfedit.jsonl`（含它自己写的 `reason`） |

改动**下一次对话生效**（身份在 pi 进程启动时装载）。查状态与回滚：

```bash
waker identity <id>                             # 开关、可回滚版本、最近留痕
waker identity <id> restore MEMORY.md            # 回滚某一份（自动重新编译）
```

> 让员工能改自己的提示词，边界不在"写文件"这个动作，而在**有没有痕迹、回不回得去**。
> 所以这里宁可多写两个目录，也不放开通用的写权限。

## 安全模型

Pi 内核默认 YOLO（`executePreparedToolCall` 无条件执行）。本平台补上三道：

1. **命令门禁**：前缀白名单 + 片段黑名单 + 高危人工确认
2. **路径门禁**：目录白名单 + 凭据路径保护
3. **执行隔离**：可选 Docker 容器，无外网、随容器销毁

另有一项**默认关闭**的能力开关 `policy.selfEdit`：允许员工改自己的档案文本，
但**权限本身永远不在可改范围**（详见上文「员工改自己的档案」）。

拦截点放在**工具替换层**（`bash` 同名覆盖）而非 `tool_call` 事件层——因为事件触发时参数可能尚未解析完整，只有 `execute` 的 params 才是可靠的。

被拦截时，模型会收到明确原因并被要求**不换写法绕过**。

黑名单片段按**词边界**匹配（不是裸子串）：`"rm "` 命中 `rm -rf /tmp`，但不会命中 `cd /Users/.../platform && node x.mjs` 里的 `platfo|rm |`。

命令超时按**模型声明的 `timeout` 优先、策略值为天花板**：模型说 20 秒就 20 秒掐掉（以前被忽略、一律按策略跑满）。
收到 `SIGTERM` 时门禁会一并 SIGKILL 正在跑的子进程，避免 `sh -c` 孙进程变孤儿。

## 对话是怎么保持连续的

一个员工有**多个会话**（`data/sessions.json`），每个会话映射到一个确定的 pi `--session-id`：

- 默认会话仍映射到 `waker-<id>`（向后兼容），`chat` / `say` 默认走它
- 退出后再进来，还是同一个人，记得之前聊过什么；多次 `say` 共享上下文，可跨进程
- `--new` 新开会话，旧的保留、可命名、可回溯（`waker sessions <id>`）
- IM 会话按外部会话 key 固定映射，同一个飞书会话稳定落在同一个平台会话
- `waker run` 不进会话，每次独立——适合批处理，不适合对话

会话上下文文件仍由 pi 自己管理（`~/.pi/agent/sessions/`），可 fork、可 compact。

**长上下文会自动瘦身**（默认开）：超过 `context.maxTokens`（默认 30000，≈100KB JSONL）就
把历史压成 `keepTokens` 大小的纪要，旧文件改名归档（`*.jsonl.cleared-*`，可翻回），
再用同一个 `--session-id` 把纪要"种"回新会话 —— 之后的每轮只带纪要而不是几万 token 原文。

```bash
waker compact chat --status     # 看大小与阈值
waker compact chat --force      # 立刻压（不等阈值）
# 阈值：data/config.json 里的 context.{enabled,maxTokens,keepTokens}
```

## 员工从哪来

| 来源 | 怎么来 | 性质 |
|------|--------|------|
| 平台新建 | `waker agent new <id>` / 看板"新建员工" | 五件套档案，可改可删 |
| **导入本机 Pi agent** | `waker import <id>` / 看板"导入本机 agent" | 五件套档案，可改可删（Pi 侧文件保留） |
| 自动纳管 Pi 侧 agent | `waker config piAgents on`（默认**关**） | 只读：名称/岗位/模型由 frontmatter 决定，策略装不下，平台不能归档 |

`waker import` 把 `~/.pi/agent/agents/<id>.md` 收编成 `agents/<id>/`：frontmatter 映射为岗位字段
（`description`→role、`display_name`→name、`model`→model、`tools`→policy.toolAllow），正文**整体**进 `SOUL.md`
（不自动拆分——机器硬拆只会拆错；identity/persona/bible 是占位，人工搬段落时记得从 SOUL 删掉）。

导入**不会**替你收紧命令白名单：只复刻 `tools`，命令仍除黑名单外都可跑（与 Pi 侧一致）。
确认过工作流需要哪些命令后，再往 `waker.yaml` 加 `policy.commandAllow`。

回退：归档那个员工（或删掉 `agents/<id>/`），Pi 版立刻回来——Pi 侧文件从头到尾没被改过。

## IM 渠道（可插拔）

渠道随 `waker board` 一并启动，**不需要独立 bot 进程**：外部消息 → 会话 key → 平台会话 → 执行 → 回帖。

```yaml
# agents/<id>/waker.yaml
channels: { feishu: { enabled: true, appId: cli_xxxxxxxx } }
```

- 入站用飞书长连接（`im.message.receive_v1`），无需公网回调地址
- 收到消息**先给原消息加个表情**（默认 👍，`channels.feishu.ackEmoji` 可换），再回正文；忙锁排队时也先加
- **回帖按 Markdown 渲染**：含 `**加粗**` / `## 标题` / 列表 / 表格 / 代码块时发飞书交互卡片（否则纯文本短消息）；
  卡片发不出去会自动回落纯文本。转换规则见 `src/channels/mdCard.ts`（卡片只认 `markdown` / `hr` 元素，
  代码块必须留在 markdown 元素里用围栏语法，独立 `code` 元素会被接口拒收）
- 会话命令：IM 里直接发 `/clear`（或 `清空` / `/reset`）→ 不进模型，直接清空**这个飞书会话**的上下文；`/help` 列命令
- `GET /api/channels` 暴露状态，看板顶栏显示渠道灯；`waker channels` 查看配置
- 与旧 `feishu-bot` 争抢同一 appId 的长连接，切换时先 `launchctl unload ~/Library/LaunchAgents/dev.pi.feishu-bot.plist`

> 文档评论里没有 Markdown（评论接口只吃纯文本）；Pi 侧扩展的 `feishu_send_message` 也仍是纯文本，
> 员工**主动**发消息过去没有卡片渲染——需要时用 `feishu_request` 手动发 `msg_type=interactive`。

## 与已有资产的关系

| 已有资产 | 复用方式 |
|---------|---------|
| memory-server `:8971` | 跨会话记忆与知识库，平台不重建 |
| WAL `~/.pi/agent/wal/` | 会话索引，作为任务回溯的补充 |
| `feishu.ts` | agent 侧**出站**工具（`feishu_*`），入站收编进 `src/channels/` |
| `~/.pi/agent/skills/` | 13 个技能，按员工启用 |

新增扩展以**软链**投放（`waker-identity` / `waker-guard`），不改动任何已有文件。

共存约束（探查本机扩展后确立）：
- 避开已占用的工具名：`memory_*` / `knowledge_*` / `feishu_*`
- 避开已占用的命令名：`memory` / `wal` / `guard`
- `before_agent_start` 的 handler 串行 await，故身份文本在外壳侧预编译，运行时纯内存命中

## 目录结构

```
platform/
├── bin/waker.ts          CLI 入口
├── src/
│   ├── types.ts          核心类型契约
│   ├── core/             registry / identity / runner / sessions / usage / link / paths
│   ├── channels/         Channel 抽象 + ChannelManager + 飞书渠道
│   ├── scheduler/        board / cron / trigger
│   ├── gateway/http.ts   HTTP 数据源与静态托管
│   └── policy/
├── extensions/           自研 Pi 扩展（软链源端）
├── types/pi-shim.d.ts    ExtensionAPI 类型垫片
├── agents/               员工档案
├── data/                 任务流水与编译产物（建议 gitignore）
│                         （含 identity-history/ 与 selfedit.jsonl：档案自改的备份与留痕）
├── scripts/              bootstrap / link / register-launchd
└── web/                  看板前端（Vite + React + Tailwind）
```

## 常驻运行

```bash
# macOS：开机自启 + 崩溃重启（幂等）
bash scripts/register-launchd.sh          # 注册 / 更新
bash scripts/register-launchd.sh stop     # 暂时停止
bash scripts/register-launchd.sh remove   # 卸载
```

注册后 `launchctl list | grep com.waker` 可见三个服务，日志集中在 `~/.waker/logs/`：

**任务运行期间 Mac 不会睡**：每次拉起 pi 子进程时，平台会同步起一个
`caffeinate -i -w <pi的pid>`（`src/core/power.ts`），断言**随 pi 进程退出自动解除**——
正常结束、手动终止、崩溃都不留残留（`pmset -g assertions` 可验证）。
两个如实的边界：只防**空闲睡眠**，**合盖睡眠防不住**（电池下系统强制，接电源 + 外接显示器才行）；
想整体关闭：`WAKER_NO_CAFFEINATE=1`。

**也可以让它一直不睡**：看板「工具 → 系统」里的开关（CLI：`waker power on|off|status`），
持一条常驻断言 `caffeinate -i -s -w <看板pid>`，直到你关掉或看板进程停止。
两套互不影响：任务期间那套绑 pi 进程、任务结束就释放；常驻这套绑看板进程、不关就一直持有。
开关记在 `data/config.json`（`preventSleep`），看板重启会按配置自动恢复；合盖拦不住这条对两者同样成立。

| 服务 | 说明 |
|------|------|
| `com.waker.board` | 看板 `:8787`（含调度器与 IM 渠道） |
| `com.waker.memory` | 记忆中心 `:8971` |
| `com.waker.memory-worker` | 抽取队列消费（独立进程） |

launchd 不继承终端注入的 `NODE_OPTIONS` / `PYTHONPATH`，比 `nohup` 更可靠。

## 运行时可观测

看板在**有执行时**显示运行时面板：此刻在跑的 pi 子进程（员工 / 来源 / pid / 已运行时长）与实时输出尾部，可逐个终止。

```bash
curl -s http://127.0.0.1:8787/api/runtime   # procs[]：进程 + 输出尾部
curl -s -X POST http://127.0.0.1:8787/api/tasks/<taskId>/cancel
```

只覆盖**看板进程自己拉起**的执行；CLI（`waker say` / `run`）是独立进程，不在登记表中。

## 架构与版本页

看板顶栏「架构」（或直接开 `http://127.0.0.1:8787/#/architecture`）讲两件事：

- **结构**：入口 → 平台外壳 → Pi 扩展 → Pi 内核的分层与各模块职责（数据源 `GET /api/architecture`）；
- **变化**：`package.json` 的当前版本 + `CHANGELOG.md` 各版本条目，与当前版本一致的那段标为「本版变更」。

发版动作因此固定为两步：改 `package.json` 的 `version`，在 `CHANGELOG.md` 顶部加一段。
顶栏入口在版本变化后亮一个小圆点，看过一次即消失（记在 localStorage）。

页面自带一份**构建时快照**（`pnpm web:build` 会先跑 `scripts/gen-architecture.ts`）：
网关是常驻进程，重建前端不等于重启网关——只靠接口的话，升级后打开这一页只会报错。
所以先渲染快照，再去问 `/api/architecture` 要最新一份：拿到就覆盖（"改了 CHANGELOG 刷新即见"），
拿不到就安静地用快照，并在页头标明"来自前端构建时的快照"。

## 执行队列（并发保护）

冲突的真实单位是**一个 pi 会话文件**（两个 pi 同时写同一个会话文件会互相踩），所以串行按会话粒度：

- 同一会话严格串行；同一员工的**不同会话**照常并行（定时任务新开会话，不会被私聊堵住）
- 额外两级上限：每员工 3、全局 6，超出排队（任务状态显示为「排队中」）
- `waker board` 启动时会收尾上一轮进程遗留的 `running` / `queued`（子进程已随进程退出，那两个状态一定是假的）

跨进程也要串行（`waker say chat` 与看板用的是同一个会话，但是两个 node 进程，进程内队列看不见对方）：
补一层**文件锁**（`data/locks/<piSessionId>.lock`，记 pid）。

- 锁的主进程崩溃后会被自动清理（pid 存活检测），不会永久卡死会话
- 等不到时给出明确原因（`waker say` 等 60s，看板任务等 10min），而不是无限挂着
- `waker chat` 交互期间会**一直持有**该会话的锁——此时看板对同一会话的请求会排队

## 记忆生命周期

不做自动 TTL——记忆一旦入库会被反复注入后续会话，**误删长期记忆的代价远大于多留几条垃圾**。
改用"源头约束 + 人工审阅"：

- 抽取侧明确禁止记**进行中的临时状态**（"正在调试 X"）、一次性反馈、碎片口令；
- `waker memory review` 按高置信规则挑出可疑条目（碎片口令 / 短句进行时 / 完全重复），人工决定删哪些。

## 已知限制

- Docker 未运行时，`sandbox: true` 的员工无法执行 bash（其余能力不受影响）
- Group 多员工编排**暂不使用**（代码在 `src/core/group.ts`，未接任何入口；需要时再接 CLI）
- memory-server 未启动不影响执行，仅跨会话记忆不生效
- Group 编排当前为"成员并行 + Leader 汇总"，未实现成员间自由对话（刻意设计，避免上下文串味）
- Channel 层目前只实现飞书；微信 / Discord / 钉钉待接入（接口已留好）
- Pi 侧 agent **默认不纳管**：没导入的 `waker say <piId>` 会报"未找到员工"，看板名册里也不出现（这是刻意的，用 `waker import` 收编）

## License

MIT
