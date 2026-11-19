/**
 * 架构与版本视图的数据源。
 *
 * 三件事只在这里做：读 `package.json` 的版本、解析 `CHANGELOG.md`、列出架构分层。
 *
 * 为什么架构清单写在后端而不是前端：
 * 1. 它是**这个仓库的事实**，跟着代码走（改模块时改同一处的注释与清单，评审时一起看见）；
 * 2. 前端只负责画，不掺业务描述，换皮肤不必回头改文案；
 * 3. `waker` 只有一份服务端，CLI/别的客户端以后要读同一份描述时不必复制。
 *
 * 版本号**不写死**：一律取 `package.json`，否则页面上显示的和实际发布的一漂移，
 * 这一页就变成了误导。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM_ROOT } from './paths.ts';

/** 一条更新记录。 */
export interface ReleaseItem {
  /** 所属分节（新增 / 变更 / 修复 …），没写分节时为空串。 */
  section: string;
  text: string;
}

/** 一个版本的更新记录。 */
export interface ReleaseEntry {
  version: string;
  /** `YYYY-MM-DD`，`Unreleased` 这类没有日期时缺省。 */
  date?: string;
  items: ReleaseItem[];
}

/** 架构里的一个模块。 */
export interface ArchitectureNode {
  name: string;
  /** 一句话职责，写"它负责什么"而不是"它是什么"。 */
  role: string;
  /** 主要文件或目录（相对仓库根），便于按图索骥。 */
  path?: string;
}

/** 架构里的一层。 */
export interface ArchitectureLayer {
  id: string;
  title: string;
  /** 这一层为什么存在 / 边界在哪。 */
  caption: string;
  nodes: ArchitectureNode[];
}

export interface ArchitectureView {
  name: string;
  version: string;
  description: string;
  generatedAt: string;
  layers: ArchitectureLayer[];
  releases: ReleaseEntry[];
  /** 更新记录文件名（相对仓库根），展示给用户看"改哪里"。 */
  changelog: string;
  /** 文件不存在时为 false：页面上要如实说"还没有更新记录"，而不是装作有。 */
  changelogFound: boolean;
}

/**
 * 解析 `CHANGELOG.md`。
 *
 * 规则刻意收得很窄，只认三种写法（其余一律跳过）：
 * - `## [版本] - 日期`（日期可省）→ 新开一个版本段
 * - `### 分节` → 之后条目归属该分节
 * - `- 条目` / `* 条目` → 一条记录
 *
 * 代码块（``` / ~~~）内的内容整段跳过：这个文件开头就有一段**格式示例**，
 * 把示例解析成真改动，比不解析更糟。版本标题之前的散条目也丢弃——
 * 它们不属于任何版本。
 */
export function parseChangelog(md: string): ReleaseEntry[] {
  const releases: ReleaseEntry[] = [];
  let current: ReleaseEntry | null = null;
  let section = '';
  let inFence = false;

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();

    if (line.startsWith('```') || line.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = /^##\s+\[?([^\]\s]+)\]?(?:\s*[-–—]\s*(.+))?$/.exec(line);
    if (heading) {
      current = { version: heading[1] as string, date: heading[2]?.trim() || undefined, items: [] };
      releases.push(current);
      section = '';
      continue;
    }
    if (!current) continue;

    const sub = /^###\s+(.+)$/.exec(line);
    if (sub) {
      section = (sub[1] as string).trim();
      continue;
    }

    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item) current.items.push({ section, text: (item[1] as string).trim() });
  }

  return releases;
}

/**
 * 架构分层。
 *
 * 顺序即调用顺序：请求从最上面进来，逐层往下落到 Pi 内核；右边的复用资产是各层都可能碰到的。
 * 每层只写"为什么有这一层"，不列函数——细节在文件里，重复一遍会漂移。
 */
const LAYERS: ArchitectureLayer[] = [
  {
    id: 'entry',
    title: '入口',
    caption: '同一套执行链路，五个触发口。入口只做参数解析与转发，不装业务逻辑。',
    nodes: [
      { name: 'CLI', role: '手动执行、会话对话、运维命令（doctor / board / identity）', path: 'bin/waker.ts' },
      { name: '定时任务', role: 'cron 与一次性触发，到点投成同一形状的任务', path: 'src/scheduler/cron.ts' },
      { name: 'IM 渠道', role: '飞书长连接入站：消息 → 会话 → 执行 → 回帖', path: 'src/channels/feishu.ts' },
      { name: 'HTTP API', role: '看板与外部脚本的数据源，含任务、档案、渠道、用量', path: 'src/gateway/http.ts' },
      { name: '看板前端', role: '运维视角：名册、任务流水、运行时、用量、本页', path: 'web/src/App.tsx' },
    ],
  },
  {
    id: 'shell',
    title: '平台外壳',
    caption: '薄外壳只做三件事：身份装配、策略下发、任务编目。不在这之上再包一层运行时。',
    nodes: [
      { name: 'registry', role: '档案扫描与校验，员工 id 白名单在入口就拦', path: 'src/core/registry.ts' },
      { name: 'identity', role: '把五件套**预编译**成注入文本，运行时纯内存命中', path: 'src/core/identity.ts' },
      { name: 'profile / 权限', role: '档案与权限的读写，原地改 YAML 保留注释，写完立即重编译策略', path: 'src/core/profile.ts' },
      { name: 'runner', role: '拉起 pi 子进程：参数、超时、中断、caffeinate 断言', path: 'src/core/runner.ts' },
      { name: 'queue / lock', role: '按会话串行：进程内队列 + 跨进程文件锁，同一会话不并行写', path: 'src/core/queue.ts' },
      { name: 'sessions / conversations', role: '会话内容与"窗口指向哪个会话"分开存，切换只动指针', path: 'src/core/sessions.ts' },
      { name: 'topicRouter / arbiter', role: '语义 / 词面 / 时间窗三套刻度判定继续、切换还是新开', path: 'src/core/topicRouter.ts' },
      { name: 'compact', role: '上下文超阈值压成纪要，旧文件归档可翻回', path: 'src/core/compact.ts' },
      { name: 'board', role: '任务流水编目：状态、耗时、结果、取消', path: 'src/scheduler/board.ts' },
      { name: 'usage', role: '从 pi 原生会话文件聚合 token 与费用', path: 'src/core/usage.ts' },
      { name: 'browserBroker', role: '常驻浏览器 broker：单标签页排队，复用真实登录态', path: 'src/core/browserBroker.ts' },
    ],
  },
  {
    id: 'extensions',
    title: 'Pi 扩展（软链注入）',
    caption: '以软链投放到 Pi 扩展目录，不复制代码、不改 Pi 任何文件——所以能跟着仓库一起升级。',
    nodes: [
      { name: 'waker-identity', role: 'before_agent_start 注入岗位人设', path: 'extensions/waker-identity.ts' },
      { name: 'waker-guard', role: 'bash 同名覆盖拦截 + 可选 Docker 沙箱（拦截点选在工具层而非事件层）', path: 'extensions/waker-guard.ts' },
      { name: 'waker-selfedit', role: '员工改自己档案的唯一通道：写前备份、每次留痕', path: 'extensions/waker-selfedit.ts' },
      { name: 'memory', role: '记忆读写，命名空间按员工隔离', path: 'extensions/memory.ts' },
      { name: 'waker-compact', role: '会话瘦身的工具入口', path: 'extensions/waker-compact.ts' },
      { name: 'browser-mcp', role: '把 browser 工具（命令 DSL）暴露给员工', path: 'extensions/browser-mcp.ts' },
    ],
  },
  {
    id: 'kernel',
    title: 'Pi 内核',
    caption: 'MIT 内核，负责模型调用与工具执行。平台只通过官方扩展机制介入，不 fork、不 patch。',
    nodes: [{ name: 'pi-agent-core / pi-ai', role: '会话、工具调用、模型路由；默认 YOLO，门禁由外壳补上' }],
  },
];

function readPackage(): { name: string; version: string; description: string } {
  const file = join(PLATFORM_ROOT, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf-8')) as {
      name?: unknown;
      version?: unknown;
      description?: unknown;
    };
    return {
      name: typeof pkg.name === 'string' ? pkg.name : 'revolver',
      // 读不到版本时给 0.0.0 而不是猜：页面上显示 0.0.0 一眼就知道"这里坏了"
      version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
      description: typeof pkg.description === 'string' ? pkg.description : '',
    };
  } catch {
    return { name: 'revolver', version: '0.0.0', description: '' };
  }
}

const CHANGELOG_FILE = 'CHANGELOG.md';

/** 组装架构与版本视图。每次请求都重读文件：改完 CHANGELOG 刷新即可见，不必重启。 */
export function readArchitecture(): ArchitectureView {
  const pkg = readPackage();
  const changelogPath = join(PLATFORM_ROOT, CHANGELOG_FILE);
  const found = existsSync(changelogPath);
  let releases: ReleaseEntry[] = [];
  if (found) {
    try {
      releases = parseChangelog(readFileSync(changelogPath, 'utf-8'));
    } catch {
      // 读失败与"没有记录"不是一回事，但页面上都只能显示"暂无"，不该让整页挂掉
      releases = [];
    }
  }

  return {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    generatedAt: new Date().toISOString(),
    layers: LAYERS,
    releases,
    changelog: CHANGELOG_FILE,
    changelogFound: found,
  };
}
