# multi-pi-memory

`pi-memory` 的**多租户（分人隔离）版**，随 Waker 一起分发。

原版 pi-memory 是单例记忆库：所有会话的记忆混在一个库里，检索时不做任何归属过滤。
本版在此之上加了**命名空间（namespace）**——记忆按"人/员工"隔离，同时知识库保持全局共享。

## 与原版的差异

| 维度 | 原版 | 本版 |
|---|---|---|
| 记忆归属 | 无（全库共享） | `namespace` 字段（存储上复用 `project` 列） |
| 检索过滤 | `source` | `source` + `namespace`（个人记忆）+ 知识库始终可见 |
| 写入口 | `/api/extract` 不带归属 | `namespace` 由扩展按 `WAKER_ID` 注入（默认私有；共享档需显式 `scope=shared`） |
| 默认端口 | 8970 | **8971**（与原实例并存，互不干扰） |
| 扩展地址 | `PI_MEMORY_SERVER` | `WAKER_MEMORY_SERVER`（waker 自动注入） |

隔离规则（见 `memory-server/retrieval.py` 的 `search()`）——**三档**：

```
可见 = 私有档  project == 自己的 namespace   ← 本岗位的领域积累，只有自己可见
     ∪ 共享档  project == shared_namespace  ← 用户画像 / 环境事实，所有员工可见
     ∪ 知识库  source == knowledge          ← 团队文档资产，不按人复制
```

| 档 | 写入口 | 该放什么 |
|---|---|---|
| 私有（默认） | 自动抽取（`/api/extract`）一律写 `NAMESPACE` | 素材、论点、项目决策 |
| 共享 | 仅显式 `memory_save(scope="shared")` | 「换个 bot 也成立」的用户偏好、本机环境事实 |
| 知识库 | `/api/knowledge` 导入、`knowledge_import` | 规范、参考资料等文档 |

**为什么不自动分流**：类别本身不可靠——实测一条技术决策会被抽成 `fact`，
而 `fact` 里同时混着「用户是内容创作者」（该共享）与「某项目接口返回 4 个字段」（该私有）。
按类别自动路由必然误分，所以共享档只走显式写入。

配置（`config.yaml` 的 `retrieval`）：

- `shared_namespace`（默认 `shared`）：共享档命名空间，置空字符串即关闭共享、回到纯隔离；
- `shared_slots`（默认 `1`）：注入时给共享档**预留**的条数。

> `shared_slots` 必须预留而不是"排完再补"：共享条目多是无归属的短事实，分数拼不过本岗位的长论述，
> 只靠补位必然被最后一步的 `top_n` 截断吃掉。预留占用的同类额度会从该组配额里扣，总量仍等于 `top_n`。

`namespace` 为空（未分人 / 历史数据）时退化为原行为：全局可见——**注意这也是风险**：
库里 1200+ 条无归属存量会在隔离被绕过时无差别灌进每个员工。

## 目录

```
memory-server/            FastAPI + SQLite + numpy 向量检索 + 队列 worker
├─ app.py                 HTTP 接口（extract / inject / search / memories / status）
├─ retrieval.py           检索与命名空间过滤（改造点核心）
├─ store.py               存储（project 列承载 namespace）
├─ extract_core.py        抽取入库
├─ worker.py              队列消费（独立进程，避免推理阻塞 HTTP）
└─ data/memory.db         数据库（本目录独立，与原实例互不影响）
memory-extension/index.ts pi 扩展：用 WAKER_ID 作为 namespace，收发都带上
scripts/
├─ migrate_namespace.py   存量记忆按 session_id 反推归属
├─ start.sh              启动 app + worker
└─ stop.sh               停止
```

## 启动

推荐交给 launchd 常驻（**开机自启 + 崩溃自动重启**），在平台根目录执行一条命令：

```bash
bash scripts/register-launchd.sh          # 注册 com.waker.memory 与 com.waker.memory-worker
```

临时手工启停（调试时用）：

```bash
./scripts/start.sh          # 后台拉起 app + worker
./scripts/stop.sh           # 停止
curl http://127.0.0.1:8971/api/status
```

Python 解释器优先级：`$WAKER_MEMORY_PYTHON` → `memory-server/.venv/bin/python`
→ 本机已有 pi-memory 的 venv → `python3`。依赖见 `memory-server/requirements.txt`。

> ⚠️ 配置里 `embedding.auto_load` / `extract.auto_load` 已置为 `false`：
> 自愈巡检会同步调用 `lms ps`，本机 `lms` CLI 超时（30s）时会**堵住事件循环**。
> 向量化本身仍走 LM Studio 的 HTTP 接口，不受影响。

## 与 Waker 的接线

1. `src/core/paths.ts`：`MEMORY_SERVER` 默认指向 `http://127.0.0.1:8971`；
2. `src/core/runner.ts` / `bin/waker.ts`：拉起 pi 子进程时注入
   `WAKER_MEMORY_SERVER`（地址）与 `WAKER_ID`（员工 id）；
3. `extensions/memory.ts`：软链到 `memory-extension/index.ts`，
   扩展读 `WAKER_ID` 作为命名空间，抽取与检索都带上。

## 存量记忆迁移

早期抽取没有归属信息，库里 `project` 全为空。若历史 session_id 形如
`waker-<员工id>`（waker 拉起的 pi 会话），可自动反推：

```bash
python3 scripts/migrate_namespace.py            # 干跑，只看报告
python3 scripts/migrate_namespace.py --apply    # 回填
```

反推不出来的一律保留为空，即"未分类"：按隔离规则不会被任何员工召回。

> 实测本机库：1608 条**全部反推不出** —— session_id 要么为空、要么是 pi 原生 UUID / `heartbeat`，
> 没有一条形如 `waker-<id>`。原因是这些记忆产生于 waker 之前（旧的单例 pi-memory 与定时心跳会话），
> 本就不属于任何员工。**所以自动归属这条路对存量是死的**，只能整批指定归属（见下）。

### 从旧的单例 pi-memory 搬到 waker（实际做法）

旧实例（`:8970`，`~/Document/pi/pi-memory/`）继续留给 pi-web 用，waker 用独立的 `:8971`。
搬运 + 让员工真正用得上，两步：

**搬运是增量的**——只插新库里没有的（按 `content` 判重），不覆盖、不清空，
所以可以随时重复执行；两边各自的"自己产生的新记忆"互不干扰。
插入时直接打上 `shared` 归属，省掉一次 update。

```bash
OLD=~/Document/pi/pi-memory/memory-server/data/memory.db
NEW=vendor/multi-pi-memory/memory-server/data/memory.db

cp "$NEW" "$NEW.bak-$(date +%Y%m%d-%H%M%S)"        # 先备份

sqlite3 "$NEW" "attach '$OLD' as old;
insert or ignore into main.memories
  (id, content, category, source, project, session_id, embedding, created_at, updated_at)
select o.id, o.content, o.category, o.source, 'shared',
       o.session_id, o.embedding, o.created_at, o.updated_at
from old.memories o
where not exists (select 1 from main.memories m where m.content = o.content);
select '本次搬运:', changes();"
```

> SQL 注意：跨库查询要给表起别名用 `o.content`，
> 只写库名限定（`old.content`）在 SQLite 里会报 `no such column`。

（若某次忘了带 `'shared'` 归属，事后补一句：
`update memories set project='shared' where coalesce(project,'') not in ('','shared','knowledge');`）


为什么是共享档而不是按员工分：这批记忆来自**同一个用户**的 pi 使用史，
本来就是"关于用户本人"的（背景、偏好、项目史），正是共享档的定位。
库里的 134 条 `source=knowledge` 无需处理——知识库对所有员工本来就可见。

> ⚠️ 两边分叉：pi-web 之后在 `:8970` 新写的记忆**不会**自动出现在 waker 库里，
> 需要再搬一次（重复上面第 1、2 步即可，第 2 步只影响"仍无归属"的行）。
> 判断老库有多少条还没搬过去：

```bash
sqlite3 "$OLD" "attach '$NEW' as new;
  select (select count(*) from main.memories) 老库,
         (select count(*) from main.memories a
          where not exists(select 1 from new.memories b where b.content=a.content)) 未搬运;"
```

## 把记忆复制到另一个 waker id 名下

给某个员工（例如接管来的 agent）补一份**私有**记忆时，会把原条复制一份、换个 `project`。
**向量一并复制**，不必重新嵌入：

```bash
NEW=vendor/multi-pi-memory/memory-server/data/memory.db
sqlite3 "$NEW" "attach '<源库或备份>' as src;
insert into memories (id, content, category, source, project, session_id, embedding, created_at, updated_at)
select lower(hex(randomblob(16))), s.content, s.category, s.source, '<目标 waker id>',
       s.session_id, s.embedding, s.created_at, s.updated_at
from src.memories s
where s.project in ('<源归属1>','<源归属2>')
  and not exists (select 1 from memories m where m.content=s.content and m.project='<目标 waker id>');
select '复制:', changes();"
```

同文两份会同时被可见性过滤放行、一起进候选，**若不去重就白占注入位**。
`retrieval.py` 已按内容去重（`_dedupe_content`，保留分数最高的那份），且配额循环里
同文被跳过时**不占名额**、顺延给下一条。实测同一问 5 个名额从"2 个被重复吃掉"恢复到全部有效。

## 取舍：召回要快，写入可以慢（2026-11-11）

| | 做法 | 为什么 |
|---|---|---|
| **召回** | 嵌入模型**常驻显存**（`embedding.keep_resident`） | LM Studio 的 JIT 模型**每次请求后就按 TTL 卸载**（日志实测 `Unloading model … due to TTL expiration` 紧跟每次 embed）→ 每次召回都重新加载 = **0.55s**；显式常驻后 **0.01~0.02s（快 25~50 倍）** |
| **写入** | **攒够 3000 token 再启动**（`extract.min_tokens`） | 抽取模型 6.9GB，单次 90~135s；每 2 轮抽一次纯浪费。触发条件三取一：攒够 / 等够 `max_wait_seconds`(30min) / 攒到 `max_merge_tokens` |

- **常驻判据是"延迟探针"不是 `lms ps`**：嵌入模型不出现在 `lms ps` 里，用它判断恒为 false → 每次都去加载反而更慢。`stability.start_resident_keeper` 每 `resident_check_seconds` 探一次（一次极短 embed），超过 `resident_slow_ms` 就重新 `lms load`。状态见 `GET /api/status` 的 `embedding.resident`（`last_ms` = 召回固定开销）。
- **攒批只在 worker 侧**：`peek_pending()` 先看不认领（没到点原样留在队列），够了才 `claim_ids()` 并**合并成一次抽取**；**按 `(project, session_id)` 分组**，跨员工合并会把 A 的记忆写进 B 名下。
- **抽取前必须真加载一次**（`extract.load_ttl_seconds`，默认 600s 后自动卸载）：实测踩过"模型刚被 TTL 卸载、请求同一瞬间到达"→ 整批 400 白跑；而原来的"重试"调的是 `ensure_loaded()`，在 `auto_load:false` 下**是空操作**，等于从没重试过。现在重试走 `LMStudioChat.load_now()`（真 `lms load`）。
- 平台内部调用（会话瘦身的摘要/纪要播种）带 `WAKER_MEMORY_NO_EXTRACT=1`，**不沉淀成用户记忆**。

## 嵌入失败的语义（2026-10-11 调整：不再静默降级）

以前 `embedder.embed()` 失败会**静默返回 hash 向量**（无语义、但服务不中断）—— 结果是那条记忆
或那次查询从此没有语义，**检索等于瞎搜却不报错**。实测库里真躺了 3 条这样的垃圾向量
（全非负），而外部完全看不出来。现在：

| 场景 | 行为 |
|---|---|
| 首次失败 | 退避重试 3 次（每次都会重新 HTTP 探活，能触发按需加载）；LM Studio 对"正在按需加载/刚被卸载"的模型常直接回 400，属瞬时，重试基本能成 |
| 仍失败 · 写入路径 | 存 `embedding=NULL`：**记忆仍在**（`/api/memories` 能看到），只是暂时不可召回；不写垃圾 |
| 仍失败 · 抽取路径 | 整批不入库并抛错，交给抽取队列重试（宁重试不写垃圾） |
| 仍失败 · 查询路径 | 明确报错，而不是拿噪声比出"看着合理"的假分数 |

判据与修复：

```bash
# 看一眼健康状况（真探活 + 降级向量计数）
curl -s http://127.0.0.1:8971/api/status | python3 -c "import sys,json;print(json.load(sys.stdin)['embedding'])"
# {"model":"text-embedding-bge-m3","dim":1024,"ok":true,"degraded_rows":0,...}

# 把历史垃圾向量重算回真向量（降级=全非负；真实语义向量必然含负分量）
curl -s -X POST http://127.0.0.1:8971/api/reembed
```

`/api/health` 的 `loaded` 字段现在走 **HTTP 探活**（`/v1/models` 认这个模型即可服务），
不再用 `lms ps` —— 那个 CLI 又慢又会挂（实测 >8s 无输出），而且**不列嵌入模型**，
于是恒报 `loaded:false`，外面看着像"记忆没启动"，实际一切正常。

## 排障要点

**LM Studio 里同一个嵌入模型加载了好几份（`bge-m3:2`、`:3`…）→ 常驻保活线程失控（2026-10-11 已修）。**

根因：保活线程原先只拿"embed 变慢"当信号，而**慢恰恰可能是"堆了多份互相抢内存"造成的**；
`lms load` 又不会复用已加载的那份、会**新建一个实例** → 越慢越压、越压越慢，实测堆到 8 份（约 4.3GB 常驻）。

修法（`stability.py` 的 `start_resident_keeper`）：**先查状态再动手** ——
每轮先用 `list_loaded()` 数实例：>1 就自愈卸载多余（只留一份）；=1 就什么都不做；=0 才加载，
且带冷却（≥一个巡检周期）与熔断（连续 3 次失败停手）。顺带修正一个过时假设：
`lms ps` **确实列得出嵌入模型**（当年"不列"的判断已不成立），不需要靠延迟盲猜。

排查与自救：

```bash
lms ps | grep -c text-embedding-bge-m3        # >1 就是堆积了
lms unload "text-embedding-bge-m3:2"          # 手工清多余的（REST 的 unload 接口实测不生效）
curl -s http://127.0.0.1:8971/api/status | python3 -c \
  "import sys,json;print(json.load(sys.stdin)['embedding']['resident'])"
# loaded=true, instances=1, cleaned=N（N>0 说明刚自愈过一次）
```

**检索突然全是空 / 分数低得离谱 → 先查嵌入是否可用。**

```bash
curl -s http://127.0.0.1:8971/api/status | python3 -c "import sys,json;print(json.load(sys.stdin)['embedding'])"
# ok=false → 模型/服务真有问题；degraded_rows>0 → 有历史垃圾向量，跑 POST /api/reembed
```
（2026-10-11 之前是 grep 日志里的"降级 hash 向量"—— 现在那种静默降级已经不存在了。）

`embedding.auto_load: false` 时，`embed()` 只会问 `stability.is_loaded()` —— 那走的是 `lms ps`，
而 **`lms ps` 里根本不会列出嵌入模型**（它只列 generation 模型），于是恒判"未加载"，
每次向量化都降级成 hash 向量（无语义、不报错），检索等于瞎搜。
现在 `LMStudioEmbedding.ensure_loaded()` 会先做一次 HTTP 探活（`/v1/models` 认这个模型就用），
LM Studio 在真正调用时按需加载 —— 直连 `/v1/embeddings` 是能立即返回真实向量的。

**自检**（不经过服务，直接看嵌入是否语义可用）：

```bash
./memory-server/.venv/bin/python - <<'PY'
import sys; sys.path.insert(0, '.'); import store, numpy as np
from embedder import Embedder
from config import load_config
q = Embedder(load_config()).embed(['Monkey 机器人'])[0]
meta, mat = store.load_embeddings()
s = store.cosine_similarity(np.asarray(q, dtype=np.float32), mat)
for i in np.argsort(-s)[:3]:
    print(round(float(s[i]), 3), meta[i]['content'][:40])
PY
```

分数应在 0.6~0.95；若普遍 < 0.1，就是降级了。

**另一类"整个服务起不来"**：改过 `app.py` 后务必 `python3 -m py_compile app.py`。
曾出现 `await` 写在非 async 函数里（`_import_text`），服务启动即 SyntaxError、launchd 反复重启。
