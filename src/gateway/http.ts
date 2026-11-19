import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { buildSnapshot, buildSessionList, listTasks, getTask, updateTask, reapOrphanTasks } from '../scheduler/board.ts';
import { loadAllWakers, loadWaker } from '../core/registry.ts';
import { describeWaker } from '../core/identity.ts';
import { createWaker, archiveWaker } from '../core/create.ts';
import { importPiWaker, listImportablePiAgents } from '../core/importPi.ts';
import { loadConfig, parseContext, saveConfig } from '../core/config.ts';
import { applySleepGuard, getSleepGuard, setPreventSleep } from '../core/power.ts';
import { compactConfig, compactSession, sessionSize } from '../core/compact.ts';
import { isEditable, listAgentFiles, readAgentFile, writeAgentFile } from '../core/files.ts';
import {
  permissionWarnings,
  readPermissions,
  readProfile,
  updatePermissions,
  updateProfile,
  type PermissionsPatch,
  type ProfilePatch,
} from '../core/profile.ts';
import {
  listSessions,
  createSession,
  deleteSession,
  renameSession,
  resolveSession,
  touchSession,
  clearSession,
  isDeletable,
} from '../core/sessions.ts';
import { readSessionImage, readSessionMessages, type ChatStep } from '../core/sessionHistory.ts';
import { channelManager } from '../channels/manager.ts';
import { readChannelConfig, writeChannelConfig } from '../core/channelConfig.ts';
import { llmArgs, runWaker } from '../core/runner.ts';
import {
  attachmentKind,
  cleanupWebInbox,
  DEFAULT_ATTACHMENT_PROMPT,
  MAX_ATTACHMENT_BYTES,
  normalizeTalkAttachments,
  prepareFileForModel,
  removeWebInboxFile,
  sanitizeFileName,
  webInboxPath,
  writeWebInbox,
} from '../core/attachments.ts';
import { fireApi } from '../scheduler/trigger.ts';
import {
  startScheduler,
  scheduleOnce,
  reloadScheduler,
  loadAutomations,
  createAutomation,
  deleteAutomation,
  setAutomationEnabled,
} from '../scheduler/cron.ts';
import { DEFAULT_SNOOZE_MS, createTodo, dismissTodo, finishTodo, listTodos, snoozeTodo } from '../core/todos.ts';
import { startTodoScheduler } from '../scheduler/todos.ts';
import { loadPlugins } from '../core/plugins.ts';
import { listSkills, getEnabledSkills, setEnabledSkills } from '../core/skills.ts';
import { PLATFORM_ROOT } from '../core/paths.ts';
import { readAvatar, removeAvatar, saveAvatar } from '../core/avatars.ts';
import { readArchitecture } from '../core/architecture.ts';
import { buildUsage, sessionUsage } from '../core/usage.ts';
import { killProc, listProcs } from '../core/procs.ts';
import { cancelWaiting, queueSnapshot } from '../core/queue.ts';

const WEB_DIST = join(PLATFORM_ROOT, 'web', 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(payload);
}

/**
 * 读请求体。`maxBytes` 可按路由放宽：附件上传走 base64，体积约为原文件的 1.33 倍，
 * 用默认的 2MB 会直接把一张普通截图挡掉。
 *
 * 用 Buffer 累积而不是 `data += String(c)`：后者在大请求体上是反复拼接长字符串，
 * 27MB 的 base64 会明显拖慢甚至触发内存抖动。
 */
async function readBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      total += c.length;
      if (total > maxBytes) {
        aborted = true;
        req.destroy();
        resolvePromise('');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(aborted ? '' : Buffer.concat(chunks).toString('utf-8')));
    req.on('error', () => resolvePromise(''));
  });
}

function serveStatic(res: ServerResponse, urlPath: string): boolean {
  if (!existsSync(WEB_DIST)) return false;
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  let file = join(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST)) return false; // 目录穿越保护
  if (!existsSync(file) || !statSync(file).isFile()) file = join(WEB_DIST, 'index.html'); // SPA 回退
  if (!existsSync(file)) return false;

  /**
   * 缓存策略必须分清两类文件，否则会踩"改了前端但页面没变"的坑：
   *   - `index.html`（含 SPA 回退）：**绝不缓存**。它是入口，必须每次拿到最新的
   *     bundle 引用，否则浏览器一直用旧的 JS，看板上看到的还是上一版界面；
   *   - `/assets/*`：Vite 产物带内容 hash，可以长缓存（内容变了文件名就变）。
   */
  const isIndex = file.endsWith('index.html');
  const cache = isIndex
    ? 'no-store'
    : urlPath.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': cache,
  });
  res.end(readFileSync(file));
  return true;
}

export interface GatewayOptions {
  port: number;
  host: string;
  /** 网关起来时顺带启动调度器，让定时任务真正生效。 */
  withScheduler: boolean;
}

export function startGateway(opts: GatewayOptions): void {
  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      if (method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
        res.end();
        return;
      }

      // —— 数据源 ——
      if (method === 'GET' && path === '/api/board') return sendJson(res, 200, await buildSnapshot());

      // 会话粒度视图：看板主列表用它（不是逐条消息）
      if (method === 'GET' && path === '/api/sessions') return sendJson(res, 200, buildSessionList());

      // —— 待办：人类任务与 agent 任务是同一种对象 ——
      if (method === 'GET' && path === '/api/todos') {
        return sendJson(
          res,
          200,
          listTodos({
            wakerId: url.searchParams.get('wakerId') ?? undefined,
            assignee: (url.searchParams.get('assignee') ?? undefined) as never,
            status: (url.searchParams.get('status') ?? undefined) as never,
            dueOnly: url.searchParams.get('due') === '1',
          }),
        );
      }

      if (method === 'POST' && path === '/api/todos') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          wakerId?: string;
          title?: string;
          dueAt?: string;
          assignee?: 'agent' | 'human';
          detail?: string;
          sessionId?: string;
          externalKey?: string;
          sourceTaskId?: string;
        };
        if (!body.wakerId?.trim() || !body.title?.trim() || !body.dueAt?.trim()) {
          return sendJson(res, 400, { error: '需要 wakerId / title / dueAt' });
        }
        if (!loadWaker(body.wakerId.trim())) {
          return sendJson(res, 400, { error: `员工不存在：${body.wakerId}` });
        }
        try {
          return sendJson(
            res,
            200,
            createTodo({
              wakerId: body.wakerId.trim(),
              title: body.title,
              dueAt: body.dueAt,
              assignee: body.assignee,
              detail: body.detail,
              sessionId: body.sessionId,
              externalKey: body.externalKey,
              sourceTaskId: body.sourceTaskId,
              source: 'web',
            }),
          );
        } catch (e) {
          return sendJson(res, 400, { error: (e as Error)?.message ?? String(e) });
        }
      }

      if (method === 'POST' && path.startsWith('/api/todos/')) {
        const m = path.slice('/api/todos/'.length).match(/^([^/]+)\/(done|dismiss|snooze)$/);
        if (m) {
          const id = decodeURIComponent(m[1]!);
          if (m[2] === 'done') {
            const body = JSON.parse((await readBody(req)) || '{}') as { note?: string };
            const t = finishTodo(id, body.note);
            return t ? sendJson(res, 200, t) : sendJson(res, 404, { error: '待办不存在' });
          }
          if (m[2] === 'dismiss') {
            const t = dismissTodo(id);
            return t ? sendJson(res, 200, t) : sendJson(res, 404, { error: '待办不存在' });
          }
          const body = JSON.parse((await readBody(req)) || '{}') as { ms?: number };
          const ms = typeof body.ms === 'number' && body.ms > 0 ? body.ms : DEFAULT_SNOOZE_MS;
          const t = snoozeTodo(id, ms);
          return t ? sendJson(res, 200, t) : sendJson(res, 404, { error: '待办不存在' });
        }
      }

      if (method === 'GET' && path === '/api/wakers') {
        return sendJson(res, 200, loadAllWakers().map(describeWaker));
      }

      // 话题建议：只判定不执行。网页端在发送前调它，决定要不要弹"切到《X》"的卡片。
      // 与 IM 的区别：IM 是异步的可以边收边问；网页要先把判断拿到手再决定发不发。
      if (method === 'POST' && path.startsWith('/api/agents/') && path.endsWith('/route')) {
        const id = decodeURIComponent(path.slice('/api/agents/'.length, -'/route'.length));
        const rec = loadWaker(id);
        if (!rec) return sendJson(res, 404, { error: '员工不存在' });
        const body = JSON.parse((await readBody(req)) || '{}') as {
          sessionId?: string;
          message?: string;
        };
        if (!body.sessionId?.trim() || !body.message?.trim()) {
          return sendJson(res, 400, { error: '缺少 sessionId 或 message' });
        }
        try {
          const { suggestForSession } = await import('../core/topicSuggest.ts');
          return sendJson(res, 200, await suggestForSession(rec, body.sessionId.trim(), body.message.trim()));
        } catch (e) {
          // 判定失败不该挡住发送：返回 continue，前端照常发
          return sendJson(res, 200, {
            action: 'continue',
            confidence: 0,
            reason: `判定失败：${(e as Error)?.message ?? e}`,
            regime: 'lexical',
            current: { id: body.sessionId, title: body.sessionId },
          });
        }
      }

      // 附件上传：base64 走 JSON，**不解析 multipart**。
      // 理由：Node 没有内置 multipart 解析，手写边界切分在中文文件名编码与分块边界上
      // 最容易埋坑；而本平台是本地/局域网访问，base64 的 33% 膨胀无感。
      if (method === 'POST' && path === '/api/upload') {
        // 20MB 文件 → base64 约 27MB，这里给足包装余量
        const raw = await readBody(req, 40 * 1024 * 1024);
        if (!raw) return sendJson(res, 413, { error: '请求体过大' });
        let body: { name?: string; dataBase64?: string };
        try {
          body = JSON.parse(raw) as { name?: string; dataBase64?: string };
        } catch {
          return sendJson(res, 400, { error: '请求体不是合法 JSON' });
        }
        const name = String(body.name ?? '').trim();
        // 前端可能直接传 readAsDataURL 的结果，兼容 data URL 前缀
        const b64 = String(body.dataBase64 ?? '').replace(/^data:[^;]*;base64,/, '');
        if (!name || !b64) return sendJson(res, 400, { error: '缺少 name 或 dataBase64' });
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length) return sendJson(res, 400, { error: '文件内容为空或 base64 非法' });
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          return sendJson(res, 413, { error: `文件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB 上限` });
        }
        // id 带随机串：中文名会被清洗成下划线，同名文件靠前缀区分
        const id = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}-${sanitizeFileName(name)}`;
        writeWebInbox(id, buf);
        return sendJson(res, 200, { id, name, size: buf.length, kind: attachmentKind(name) });
      }

      // 看板内对话：与员工在**指定会话**里说一句话。
      // 未指定 sessionId 时落到默认会话（pi 会话 id 仍为 waker-<id>，与旧版兼容）。
      if (method === 'POST' && path === '/api/talk') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          wakerId?: string;
          message?: string;
          sessionId?: string;
          /** 兼容旧参数：fresh=true 等价于"新建一个会话再聊"。 */
          fresh?: boolean;
          /**
           * 附件 id（/api/upload 的返回），只在这一轮有效，用完即删。
           * 也接受 `{id,name}`：`name` 是**用户看到的原始文件名**，写进会话文本时用它，
           * 否则历史里只剩一串 `m3k2j1-a1b2c3d4-____.png` 这种清洗后的 id，人看不懂。
           * 旧客户端只传 string[]，仍然可用（回落到 id）。
           */
          attachments?: Array<string | { id?: string; name?: string }>;
        };
        const attachItems = normalizeTalkAttachments(body.attachments);
        const attachIds = attachItems.map((a) => a.id);
        // 允许"只有附件、没有文字"：这类消息由 DEFAULT_ATTACHMENT_PROMPT 兜底
        if (!body.wakerId?.trim() || (!body.message?.trim() && attachIds.length === 0)) {
          return sendJson(res, 400, { error: '缺少 wakerId 或 message' });
        }
        const wakerId = body.wakerId.trim();
        const session = body.fresh ? createSession(wakerId) : resolveSession(wakerId, body.sessionId);

        // 网页也算一个"窗口"：记下现在对着哪个会话，切换到别的会话时才拍得出离场快照。
        // 不能等前端点切换——用户切过去不发消息，就没有"离开"这件事；
        // 口径定在"这条消息实际发到了别的会话"，与 IM 那边一致。
        void import('../core/conversations.ts')
          .then((m) => m.noteActiveWindow(wakerId, `web:${wakerId}`, session.id))
          .catch(() => {
            /* 指针只是快照的触发线索，写失败不影响这一轮对话 */
          });

        // 附件：id → 路径 → 文档转 txt。单个失败只降级成提示，不打断整轮对话。
        // 加工时也传原始文件名：文档抽出的 `.txt` 开头有一行 `【文件名】`，
        // 用清洗后的 id 会让模型和用户都看到 `m3k2j1-…-____.pdf`。
        const attachments: string[] = [];
        const notes: string[] = [];
        for (const item of attachItems) {
          const p = webInboxPath(item.id);
          const shownName = item.name?.trim() || item.id;
          if (!p || !existsSync(p)) {
            notes.push(`附件「${shownName}」不存在或已过期`);
            continue;
          }
          const prepared = await prepareFileForModel(p, shownName);
          // `path: null` = 这份附件不能交给模型（HEIC 转码失败、二进制等），只留一句人话提示
          if (prepared.path) attachments.push(prepared.path);
          if (prepared.note) notes.push(prepared.note);
        }

        // 纯附件补默认话术；并在 prompt 末尾留一行附件清单 ——
        // 会话历史只存 prompt 文本，不留这一行的话，刷新后就看不到自己发过什么。
        // 清单用**原始文件名**：id 是"时间戳-随机串-清洗名"，直接展示等于给用户看乱码。
        const text = body.message?.trim() || (attachments.length ? DEFAULT_ATTACHMENT_PROMPT : '');
        const label = attachItems.map((a) => a.name?.trim() || a.id).join('、');
        const prompt = attachIds.length ? `${text}\n\n【附件：${label}】` : text;

        try {
          const task = await runWaker({
            wakerId,
            prompt,
            source: 'web',
            attachments,
            sessionId: session.piSessionId,
            wakerSessionId: session.id,
          });
          touchSession(wakerId, session.id);
          // 本次答复用到的工具步骤，前端会在正文前以引用格式展示
          let steps: ChatStep[] = [];
          try {
            const hist = readSessionMessages(wakerId, session.id, 40);
            steps = [...hist].reverse().find((m) => m.role === 'assistant')?.steps ?? [];
          } catch {
            /* 步骤解析失败不影响回复本身 */
          }
          const body0 = task.result ?? '';
          return sendJson(res, 200, {
            status: task.status,
            result: notes.length ? `${body0}\n\n（${notes.join('；')}）`.trim() : body0,
            steps,
            blockedCount: task.blockedCount ?? 0,
            guardLog: task.guardLog ?? [],
            error: task.error,
            taskId: task.taskId,
            sessionId: session.id,
            sessionName: session.name,
          });
        } catch (e) {
          return sendJson(res, 400, { error: (e as Error)?.message ?? String(e) });
        } finally {
          // 附件只服务于这一轮：pi 启动时已把图片内联、文档正文已读入上下文
          for (const a of attachments) removeWebInboxFile(a);
          for (const id of attachIds) {
            const p = webInboxPath(id);
            if (p) removeWebInboxFile(p);
          }
        }
      }

      // —— 员工管理 ——
      // 与 CLI 共用 core/create.ts，保证两条创建路径行为一致
      if (method === 'POST' && path === '/api/agents') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          id?: string;
          role?: string;
          cwd?: string;
          name?: string;
        };
        if (!body.id?.trim()) return sendJson(res, 400, { error: '缺少员工 id' });
        try {
          const rec = createWaker({ id: body.id.trim(), role: body.role, cwd: body.cwd, name: body.name });
          return sendJson(res, 200, describeWaker(rec));
        } catch (e) {
          return sendJson(res, 400, { error: (e as Error)?.message ?? String(e) });
        }
      }

      // 平台级开关：piAgents（是否自动纳管 Pi 侧 agent）+ context（会话瘦身阈值）
      if (path === '/api/config') {
        if (method === 'GET') return sendJson(res, 200, loadConfig());
        if (method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}') as { piAgents?: unknown; context?: unknown };
          if (body.piAgents !== undefined && typeof body.piAgents !== 'boolean') {
            return sendJson(res, 400, { error: 'piAgents 必须是布尔值' });
          }
          if (body.context !== undefined && (typeof body.context !== 'object' || body.context === null)) {
            return sendJson(res, 400, { error: 'context 必须是对象' });
          }
          return sendJson(res, 200, {
            ...saveConfig({
              piAgents: body.piAgents as boolean | undefined,
              // 逐字段校验后合并，非法值回落默认，避免把阈值写成 0（= 每轮都压缩）
              context: body.context === undefined ? undefined : parseContext(body.context),
            }),
          });
        }
      }

      // 常驻防睡眠开关（看板「工具 → 系统」）。
      // 单独一个端点而不是塞进 /api/config：改这个开关要**真的起停 caffeinate 进程**，
      // 不是"写个值就完事"；状态里还要带 active/pid/不支持的原因给界面显示。
      if (path === '/api/power') {
        if (method === 'GET') return sendJson(res, 200, getSleepGuard());
        if (method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}') as { preventSleep?: unknown };
          if (typeof body.preventSleep !== 'boolean') {
            return sendJson(res, 400, { error: 'preventSleep 必须是布尔值' });
          }
          return sendJson(res, 200, setPreventSleep(body.preventSleep));
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      // 会话瘦身：手动触发（自动瘦身在每次任务结束后按阈值跑）
      if (method === 'POST' && path.startsWith('/api/agents/') && path.endsWith('/compact')) {
        const id = decodeURIComponent(path.slice('/api/agents/'.length, -'/compact'.length));
        const rec = loadWaker(id);
        if (!rec) return sendJson(res, 404, { error: `未找到员工：${id}` });
        const body = JSON.parse((await readBody(req)) || '{}') as { sessionId?: string; force?: boolean };
        const session = resolveSession(id, body.sessionId);
        const cfg = compactConfig();
        const before = sessionSize(session.piSessionId);
        if (!body.force && before.tokens < cfg.maxTokens) {
          return sendJson(res, 200, {
            skipped: `未达阈值（${before.tokens} < ${cfg.maxTokens} token）`,
            sessionId: session.id,
            ...before,
          });
        }
        try {
          const r = await compactSession(rec, session.id, llmArgs(rec));
          if ('skipped' in r) return sendJson(res, 200, { skipped: r.skipped, sessionId: session.id });
          return sendJson(res, 200, {
            sessionId: session.id,
            piSessionId: r.piSessionId,
            tokensBefore: r.tokensBefore,
            tokensAfter: sessionSize(r.piSessionId).tokens,
            memoChars: r.memo.length,
            memoPath: r.memoPath,
            note: '压缩由 pi 原生完成：记录中插入压缩节点，历史一条未删',
          });
        } catch (e) {
          return sendJson(res, 400, { error: (e as Error)?.message ?? String(e) });
        }
      }

      // 可导入的本机 Pi agent（含"已导入"标记），供看板弹窗列表
      if (method === 'GET' && path === '/api/pi-agents') {
        return sendJson(res, 200, listImportablePiAgents());
      }

      // 导入本机 Pi agent 为平台员工。必须排在 /api/agents/:id 系列之前，
      // 否则 'import' 会被当成员工 id。
      if (method === 'POST' && path === '/api/agents/import') {
        const body = JSON.parse((await readBody(req)) || '{}') as { id?: string; cwd?: string };
        if (!body.id?.trim()) return sendJson(res, 400, { error: '缺少 agent id' });
        try {
          const { rec } = importPiWaker(body.id.trim(), { cwd: body.cwd });
          return sendJson(res, 200, describeWaker(rec));
        } catch (e) {
          return sendJson(res, 400, { error: (e as Error)?.message ?? String(e) });
        }
      }

      // 员工基本信息（名称 / 岗位 / 模型）。纳管自 Pi 的 profile 只读。
      if (path.startsWith('/api/agents/') && path.endsWith('/profile')) {
        const id = decodeURIComponent(path.slice('/api/agents/'.length, -'/profile'.length));
        if (method === 'GET') {
          const profile = readProfile(id);
          return profile ? sendJson(res, 200, profile) : sendJson(res, 404, { error: '员工不存在' });
        }
        if (method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}') as ProfilePatch;
          try {
            const before = loadWaker(id)?.def.cwd;
            const next = updateProfile(id, body);
            const warnings: string[] = [];
            // 换工作目录有个**不明显但很致命**的副作用：pi 按 cwd 生成会话目录
            //（`--Users-you-project--` 这种 slug），换目录等于换了一个会话仓库——
            // 历史会话没丢，但这个员工的会话列表会突然变短。不说清楚就会被当成"记录又没了"。
            if (before && next.cwd !== before) {
              warnings.push(
                `工作目录已从 ${before} 改为 ${next.cwd}。` +
                  '注意：pi 的会话按目录存放，历史会话仍留在旧目录（不会丢，但本员工的会话列表会变短）；' +
                  '若 waker.yaml 配了 policy.pathAllow，请确认它仍覆盖新目录。',
              );
            }
            return sendJson(res, 200, { ...next, warnings });
          } catch (e) {
            return sendJson(res, 400, { error: (e as Error)?.message ?? String(e) });
          }
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      // 权限：可读写目录范围（pathAllow/pathDeny）+ 档案自改开关（selfEdit）。
      // 与 /profile 分开的理由：这一组改的是 waker.yaml 的 policy 段，落盘后会**重新编译**——
      // guard 读的正是编译产物 data/policy/<id>.policy.json，不重编译等于"界面上改了、门禁没变"。
      if (path.startsWith('/api/agents/') && path.endsWith('/permissions')) {
        const id = decodeURIComponent(path.slice('/api/agents/'.length, -'/permissions'.length));
        if (method === 'GET') {
          const perms = readPermissions(id);
          return perms ? sendJson(res, 200, perms) : sendJson(res, 404, { error: '员工不存在' });
        }
        if (method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}') as PermissionsPatch;
          try {
            const before = readPermissions(id);
            const next = updatePermissions(id, body);
            return sendJson(res, 200, { ...next, warnings: before ? permissionWarnings(before, next) : [] });
          } catch (e) {
            return sendJson(res, 400, { error: (e as Error)?.message ?? String(e) });
          }
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      // 档案文件读写。必须排在 DELETE /api/agents/:id 之前，
      // 否则会被它的 startsWith 抢先匹配。
      if (path.startsWith('/api/agents/') && path.includes('/files')) {
        const seg = path.slice('/api/agents/'.length).split('/');
        const id = decodeURIComponent(seg[0] ?? '');
        const name = seg[2] ? decodeURIComponent(seg[2]) : null;
        if (seg[1] !== 'files') return sendJson(res, 404, { error: 'not found' });

        if (method === 'GET' && !name) return sendJson(res, 200, listAgentFiles(id));

        if (!name || !isEditable(name)) {
          return sendJson(res, 400, { error: `不允许编辑该文件：${name ?? '(未指定)'}` });
        }
        if (method === 'GET') return sendJson(res, 200, readAgentFile(id, name));
        if (method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}') as { content?: string };
          if (typeof body.content !== 'string') return sendJson(res, 400, { error: '缺少 content' });
          try {
            return sendJson(res, 200, writeAgentFile(id, name, body.content));
          } catch (e) {
            return sendJson(res, 400, { error: (e as Error)?.message ?? String(e) });
          }
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      // 历史消息里的图片：`/messages/:line/images/:index` 按需取二进制。
      // 不内联进历史响应：一张截图 base64 1–3MB，一屏几十张就是几十 MB JSON。
      // 必须排在下面 /messages 路由之前（那条靠 endsWith('/messages') 匹配，虽不冲突，但顺序更稳妥）。
      if (
        method === 'GET' &&
        path.startsWith('/api/agents/') &&
        path.includes('/sessions/') &&
        path.includes('/images/')
      ) {
        const seg = path.slice('/api/agents/'.length).split('/');
        const id = decodeURIComponent(seg[0] ?? '');
        const sid = decodeURIComponent(seg[2] ?? '');
        const lineNo = Number(seg[4] ?? '');
        const imgIdx = Number(seg[6] ?? '');
        if (
          seg[1] !== 'sessions' ||
          seg[3] !== 'messages' ||
          seg[5] !== 'images' ||
          !id ||
          !sid ||
          !seg[4] ||
          !seg[6]
        ) {
          return sendJson(res, 404, { error: 'not found' });
        }
        const img = readSessionImage(id, sid, lineNo, imgIdx);
        if (!img) return sendJson(res, 404, { error: '图片不存在或已不可读' });
        res.writeHead(200, {
          'content-type': img.mimeType,
          'content-length': img.data.length,
          // 会话文件只追加不改写，同一条目的图片内容不变，可以放心长缓存
          'cache-control': 'private, max-age=86400',
          'access-control-allow-origin': '*',
        });
        res.end(img.data);
        return;
      }

      // 会话历史对话（从 pi 会话文件还原）。必须排在下面 /sessions 路由之前，否则会被它抢先匹配。
      if (path.startsWith('/api/agents/') && path.includes('/sessions/') && path.endsWith('/messages')) {
        const seg = path.slice('/api/agents/'.length).split('/');
        const id = decodeURIComponent(seg[0] ?? '');
        const sid = decodeURIComponent(seg[2] ?? '');
        if (seg[1] !== 'sessions' || seg[3] !== 'messages' || !id || !sid) {
          return sendJson(res, 404, { error: 'not found' });
        }
        return sendJson(res, 200, readSessionMessages(id, sid));
      }

      // 单个会话的用量：token 与费用，按模型拆分（费用按模型价格表计算）
      if (path.startsWith('/api/agents/') && path.includes('/sessions/') && path.endsWith('/usage')) {
        const seg = path.slice('/api/agents/'.length).split('/');
        const id = decodeURIComponent(seg[0] ?? '');
        const sid = decodeURIComponent(seg[2] ?? '');
        if (seg[1] !== 'sessions' || seg[3] !== 'usage' || !id || !sid) {
          return sendJson(res, 404, { error: 'not found' });
        }
        const session = resolveSession(id, sid);
        return sendJson(res, 200, {
          ...sessionUsage(session.piSessionId),
          sessionId: session.id,
          name: session.name,
        });
      }

      // 员工会话（1:N）。必须排在 DELETE /api/agents/:id 之前，否则会被它抢先匹配。
      if (path.startsWith('/api/agents/') && path.includes('/sessions')) {
        const seg = path.slice('/api/agents/'.length).split('/');
        const id = decodeURIComponent(seg[0] ?? '');
        if (seg[1] !== 'sessions') return sendJson(res, 404, { error: 'not found' });
        const sid = seg[2] ? decodeURIComponent(seg[2]) : null;

        if (method === 'GET' && !sid) return sendJson(res, 200, listSessions(id));
        if (method === 'POST' && !sid) {
          const body = JSON.parse((await readBody(req)) || '{}') as { name?: string };
          return sendJson(res, 200, createSession(id, body.name));
        }
        // 带 sid 的 POST 表示重命名（避免引入 PATCH 触发额外预检）
        // 带 sid 的 POST：/clear 表示清空上下文，否则表示重命名
        if (method === 'POST' && sid) {
          if (seg[3] === 'clear') {
            const r = clearSession(id, sid);
            return r.ok
              ? sendJson(res, 200, { ...r })
              : sendJson(res, 404, { error: '会话不存在' });
          }
          const body = JSON.parse((await readBody(req)) || '{}') as { name?: string };
          if (!body.name?.trim()) return sendJson(res, 400, { error: '缺少 name' });
          const updated = renameSession(id, sid, body.name);
          return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: '会话不存在' });
        }
        if (method === 'DELETE' && sid) {
          if (!isDeletable(sid)) {
            return sendJson(res, 400, {
              error: '默认会话是兜底会话（不指定会话的调用都落到它），删除后会被立刻重建。要重置上下文请用「清空」。',
            });
          }
          return deleteSession(id, sid)
            ? sendJson(res, 200, { ok: true })
            : sendJson(res, 400, { error: '会话不存在' });
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      // 员工技能勾选：编辑页面里选"自己用得上的"
      if (path.startsWith('/api/agents/') && path.endsWith('/skills')) {
        const id = decodeURIComponent(path.slice('/api/agents/'.length, -'/skills'.length));
        if (!loadWaker(id)) return sendJson(res, 404, { error: '员工不存在' });
        if (method === 'GET') return sendJson(res, 200, { all: listSkills(), enabled: getEnabledSkills(id) });
        if (method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}') as { enabled?: unknown };
          if (!Array.isArray(body.enabled)) return sendJson(res, 400, { error: '缺少 enabled 数组' });
          setEnabledSkills(id, body.enabled.filter((x): x is string => typeof x === 'string'));
          return sendJson(res, 200, { ok: true, enabled: body.enabled });
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      // 渠道配置读写：看板编辑 bot 时直接改飞书信息
      if (path.startsWith('/api/agents/') && path.endsWith('/channel')) {
        const id = decodeURIComponent(path.slice('/api/agents/'.length, -'/channel'.length));
        if (!loadWaker(id)) return sendJson(res, 404, { error: '员工不存在' });
        if (method === 'GET') return sendJson(res, 200, readChannelConfig(id));
        if (method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}') as { feishu?: unknown; appSecret?: unknown };
          if (!body.feishu || typeof body.feishu !== 'object') return sendJson(res, 400, { error: '缺少 feishu 配置' });
          writeChannelConfig(
            id,
            body.feishu as Parameters<typeof writeChannelConfig>[1],
            typeof body.appSecret === 'string' ? body.appSecret : undefined,
          );
          return sendJson(res, 200, readChannelConfig(id));
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      if (method === 'DELETE' && path.startsWith('/api/agents/')) {
        const id = decodeURIComponent(path.slice('/api/agents/'.length));
        try {
          const result = archiveWaker(id);
          // 它若挂着渠道，归档后那条长连接得立刻停掉（渠道列表是按现存员工重建的）
          await channelManager.sync();
          return sendJson(res, 200, { ok: true, ...result });
        } catch (e) {
          return sendJson(res, 404, { error: (e as Error)?.message ?? String(e) });
        }
      }

      if (method === 'GET' && path === '/api/automations') return sendJson(res, 200, loadAutomations());

      // 插件入口（本机已有的 pi 生态页面），看板点击跳转
      if (method === 'GET' && path === '/api/plugins') return sendJson(res, 200, loadPlugins());

      // 新建定时任务（看板里选员工 + cron + 任务描述）
      if (method === 'POST' && path === '/api/automations') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          name?: string;
          wakerId?: string;
          cron?: string;
          prompt?: string;
        };
        if (!body.wakerId?.trim() || !body.cron?.trim() || !body.prompt?.trim()) {
          return sendJson(res, 400, { error: '需要提供 wakerId / cron / prompt' });
        }
        if (!loadWaker(body.wakerId.trim())) return sendJson(res, 400, { error: `员工不存在：${body.wakerId}` });
        const def = createAutomation({
          name: body.name?.trim() || `${body.wakerId.trim()} 定时任务`,
          wakerId: body.wakerId.trim(),
          promptTemplate: body.prompt.trim(),
          triggers: [{ kind: 'cron', cron: body.cron.trim() }],
          enabled: true,
        });
        // 立即注册，无需重启看板
        reloadScheduler();
        return sendJson(res, 200, def);
      }

      if (method === 'DELETE' && path.startsWith('/api/automations/')) {
        const id = decodeURIComponent(path.slice('/api/automations/'.length));
        const ok = deleteAutomation(id);
        // 必须重载：否则已注册的定时器会继续跑（任务"删不掉"）
        if (ok) reloadScheduler();
        return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: '任务不存在' });
      }

      if (method === 'POST' && path.startsWith('/api/automations/') && path.endsWith('/toggle')) {
        const id = decodeURIComponent(path.slice('/api/automations/'.length, -'/toggle'.length));
        const body = JSON.parse((await readBody(req)) || '{}') as { enabled?: boolean };
        const updated = setAutomationEnabled(id, body.enabled !== false);
        if (updated) reloadScheduler();
        return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: '任务不存在' });
      }

      if (method === 'GET' && path === '/api/tasks') {
        const wakerId = url.searchParams.get('wakerId') ?? undefined;
        const status = (url.searchParams.get('status') ?? undefined) as never;
        const source = (url.searchParams.get('source') ?? undefined) as never;
        return sendJson(res, 200, listTasks({ wakerId, status, source, limit: 200 }));
      }

      if (method === 'GET' && path.startsWith('/api/tasks/')) {
        const id = path.slice('/api/tasks/'.length);
        const task = getTask(id);
        return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: 'task not found' });
      }

      // 终止：只停止后续执行，不撤销已产生的文件变更
      if (method === 'POST' && path.startsWith('/api/tasks/') && path.endsWith('/cancel')) {
        const id = path.slice('/api/tasks/'.length).replace(/\/cancel$/, '');
        const task = getTask(id);
        if (!task) return sendJson(res, 404, { error: 'task not found' });
        // 排队中的任务还没拉起进程，直接从队列里摘掉（会唤醒等待的 acquire）
        const wasQueued = cancelWaiting(id);
        // 正在跑的：优先杀本进程拉起的子进程（登记表里才有 child 句柄）；
        // CLI 等外部进程拉起的只能靠 pid，可能落空（跨进程不可见）
        if (!wasQueued && !killProc(id) && task.pid) {
          try {
            process.kill(task.pid, 'SIGTERM');
          } catch {
            /* 进程可能已退出，忽略 */
          }
        }
        return sendJson(res, 200, updateTask(id, { status: 'cancelled', endedAt: new Date().toISOString() }));
      }

      // —— 触发入口 ——
      if (method === 'POST' && path === '/api/run') {
        const body = JSON.parse((await readBody(req)) || '{}') as { wakerId?: string; prompt?: string };
        if (!body.wakerId || !body.prompt) return sendJson(res, 400, { error: '缺少 wakerId 或 prompt' });
        const task = await runWaker({ wakerId: body.wakerId, prompt: body.prompt, source: 'api' });
        return sendJson(res, 200, task);
      }

      if (method === 'POST' && path.startsWith('/api/trigger/')) {
        const name = decodeURIComponent(path.slice('/api/trigger/'.length));
        const payload = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        const task = await fireApi(name, payload);
        return sendJson(res, 200, task);
      }

      // —— 使用统计：token 消耗与费用（来源 pi 原生会话文件，只读聚合）——
      if (method === 'GET' && path === '/api/usage') {
        const days = Number(url.searchParams.get('days') ?? '182');
        const wakerId = url.searchParams.get('wakerId') ?? undefined;
        return sendJson(res, 200, buildUsage({ days: Number.isFinite(days) ? days : 182, wakerId }));
      }

      // —— 员工头像：GET 取图 / PUT 保存（PNG data URL）/ DELETE 清除 ——
      if (path.startsWith('/api/avatars/')) {
        const id = decodeURIComponent(path.slice('/api/avatars/'.length));
        if (!id) return sendJson(res, 400, { error: '缺少员工 id' });
        if (method === 'GET') {
          const buf = readAvatar(id);
          if (!buf) return sendJson(res, 404, { error: '该员工还没有头像' });
          res.writeHead(200, {
            'content-type': 'image/png',
            // 头像可变，但查询串带版本号，这里只做短缓存
            'cache-control': 'no-cache',
            'access-control-allow-origin': '*',
          });
          res.end(buf);
          return;
        }
        if (method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}') as { dataUrl?: string };
          if (!body.dataUrl) return sendJson(res, 400, { error: '缺少 dataUrl' });
          try {
            saveAvatar(id, body.dataUrl);
            return sendJson(res, 200, { ok: true });
          } catch (e) {
            return sendJson(res, 400, { error: (e as Error)?.message ?? String(e) });
          }
        }
        if (method === 'DELETE') return sendJson(res, 200, { ok: removeAvatar(id) });
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      // 运行时视图：本进程拉起的 pi 子进程（含实时输出尾部）+ 排队情况 + 进程自身开销
      if (method === 'GET' && path === '/api/runtime') {
        return sendJson(res, 200, {
          generatedAt: new Date().toISOString(),
          uptime: process.uptime(),
          memoryMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
          procs: listProcs(),
          queue: queueSnapshot(),
        });
      }

      if (method === 'GET' && path === '/api/health') return sendJson(res, 200, { ok: true, uptime: process.uptime() });

      // 架构与版本：分层说明 + package.json 版本 + CHANGELOG 解析结果。
      // 每次请求重读文件，改完 CHANGELOG 刷新即见，不必重启看板。
      if (method === 'GET' && path === '/api/architecture') return sendJson(res, 200, readArchitecture());

      // 渠道状态（飞书等），供看板展示
      if (method === 'GET' && path === '/api/channels') return sendJson(res, 200, channelManager.statuses());

      // 按最新配置重建并重启渠道：改完渠道配置调它即生效，无需重启看板进程
      if (method === 'POST' && path === '/api/channels/reload') return sendJson(res, 200, await channelManager.sync());

      // 未知的 /api/* 必须回 JSON 404，不能落到下面的 SPA 回退：
      // 否则前端拿到一段 HTML 去 JSON.parse，报"Unexpected token '<'"，
      // 而真实原因是路由写错或网关还是旧进程（没重启）。这类排查很费时间，一行就挡住。
      if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

      // —— 静态前端 ——
      if (method === 'GET' && serveStatic(res, path)) return;

      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error)?.message ?? String(e) });
    }
  });

  // 启动时把存量会话上的 externalKey 反填进 conversation 映射表（幂等）。
  // 放在启动而不是首次使用：出问题时能立刻在日志与数据文件里看到，
  // 不用等第一条飞书消息来"触发"。失败不阻塞启动——映射缺失时 ensureConversation 仍会收养。
  void import('../core/conversations.ts')
    .then((m) => {
      const n = m.migrateLegacyKeys();
      if (n) console.log(`[conversations] 已迁移存量映射 ${n} 条`);
    })
    .catch((e: unknown) => console.error('[conversations] 迁移失败（忽略）:', (e as Error)?.message ?? e));

  // 会话卡扫描器：每分钟挑一个"闲置且待摘要"的会话生成，**全局串行**。
  // 串行是刻意的：后台任务排队没有成本，并发会让"模型被占满"和"用户任务排队"同时发生。
  void import('../core/sessionSummary.ts')
    .then((m) => {
      m.startSummaryScanner();
      console.log('[summary] 会话卡扫描器已启动（闲置触发，全局串行）');
    })
    .catch((e: unknown) => console.error('[summary] 扫描器启动失败（忽略）:', (e as Error)?.message ?? e));

  server.listen(opts.port, opts.host, () => {
    console.log(`waker 网关已启动: http://${opts.host}:${opts.port}`);
    // 上一轮进程遗留的 running/queued 不可能还在跑（子进程随进程退出），先收尾再开工。
    // 只在网关启动时做：CLI 是另一个进程，误判会把看板正在跑的任务标成失败。
    const reaped = reapOrphanTasks();
    if (reaped) console.log(`已收尾 ${reaped} 个上一轮遗留的中断任务`);
    // 上传了但没发送的附件（关掉页面 / 进程被强杀）不会走到 talk 的 finally，这里兜底清
    try {
      const purged = cleanupWebInbox();
      if (purged) console.log(`已清理 ${purged} 个过期的上传附件`);
    } catch {
      /* 清理失败不影响网关启动 */
    }
    // 常驻防睡眠：按上次的开关恢复断言（launchd 重启后不用人再点一次）
    applySleepGuard();
    if (opts.withScheduler) {
      const cronCount = startScheduler();
      const onceCount = scheduleOnce();
      // agent 待办自己有一条 30s 扫描（不寄生在 cron 上：它的时间是一次性的，不是周期）
      startTodoScheduler();
      console.log(`调度器已注册 ${cronCount} 个周期任务、${onceCount} 个一次性任务；待办扫描已启动`);
      // 渠道随看板一起启动：按各 profile 的 channels 配置拉起（无配置则空跑）
      void channelManager.sync().then((list) => {
        const running = list.filter((c) => c.state === 'running').length;
        if (list.length) {
          console.log(`渠道已启动 ${running}/${list.length}：${list.map((c) => `${c.name}[${c.state}]`).join('、')}`);
        }
      });
    }
    if (!existsSync(WEB_DIST)) {
      console.log('未找到前端构建产物（web/dist），可先执行 pnpm web:build');
    }
  });
}
