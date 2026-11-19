#!/usr/bin/env node
/**
 * Build a self-contained demo workspace: three teammates, four conversations,
 * a task ledger and a few todos. Nothing here touches `~/.pi`, `agents/` or
 * `data/` — the board is started with `WAKER_AGENTS` / `WAKER_DATA` / `PI_HOME`
 * pointing at the demo directory.
 *
 * Usage:
 *   node scripts/demo-seed.mjs [dir]
 *
 * The directory defaults to `$TMPDIR/revolver-demo`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(process.argv[2] ?? process.env.WAKER_DEMO_DIR ?? join(tmpdir(), 'revolver-demo'));
if (root === '/' || root === process.env.HOME) {
  console.error(`拒绝写入 ${root}`);
  process.exit(1);
}
rmSync(root, { recursive: true, force: true });

const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
const at = (hour) => {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const dayOffset = (days, hour) => {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const write = (path, content) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
};
const jsonl = (path, rows) => write(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

const agents = {
  atlas: {
    name: 'Atlas',
    role: 'Research assistant: reads sources, keeps notes, drafts summaries',
    soul: [
      'Lead with the conclusion, then the evidence.',
      'Say "not verified" when something is not verified.',
      'Prefer three strong sources over ten weak ones.',
    ],
  },
  pilot: {
    name: 'Pilot',
    role: 'Ops assistant: runs scheduled checks and keeps the board tidy',
    soul: [
      'Every morning: report what changed since yesterday.',
      'A failed check is only useful if it says what to do next.',
      'Never touch production credentials.',
    ],
  },
};

for (const [id, a] of Object.entries(agents)) {
  const dir = join(root, 'agents', id);
  write(
    join(dir, 'waker.yaml'),
    `name: "${a.name}"
role: "${a.role}"
model: auto
cwd: "."
enabled: true
policy:
  sandbox: false
  commandAllow: ["ls", "cat", "grep", "find", "git", "node"]
  commandDeny: ["rm ", "sudo", "chmod"]
  pathAllow: ["."]
  pathDeny: [".ssh", ".env"]
  requireConfirm: ["delete files", "push to remote"]
  selfEdit: false
`,
  );
  write(join(dir, 'SOUL.md'), `# Soul\n\n${a.soul.map((l) => `- ${l}`).join('\n')}\n`);
  write(join(dir, 'identity.md'), `# Identity\n\nI am ${a.name}, a local teammate.\n`);
  write(join(dir, 'persona.md'), `# Working style\n\n- Short status bullets, evidence before opinion.\n`);
  write(join(dir, 'bible.md'), `# Red lines\n\n- Never delete files or push without confirmation.\n`);
  write(join(dir, 'MEMORY.md'), `# Long-term memory\n\n(Empty in the demo.)\n`);
}

const sessions = {
  atlas: [
    {
      id: 'default',
      name: 'Japan trip',
      title: 'Japan trip planning',
      piSessionId: 'waker-atlas',
      cardSummary: 'Comparing Kyoto and Osaka for a five-day April trip: rail pass, ryokan vs hotel, and a rainy-day plan.',
      createdAt: ago(60 * 26),
      lastActiveAt: ago(14),
      messageCount: 12,
      nameSource: 'auto',
      nameFrom: 'card',
    },
    {
      id: 'esp32',
      name: 'ESP32 glasses',
      title: 'Camera glasses prototype',
      piSessionId: 'waker-atlas-esp32',
      cardSummary: 'Power budget and camera module notes for the ESP32 glasses prototype; next step is a two-hour battery test.',
      createdAt: ago(60 * 50),
      lastActiveAt: ago(95),
      messageCount: 8,
      nameSource: 'auto',
      nameFrom: 'card',
    },
    {
      id: 'ui',
      name: 'UI refactor notes',
      title: 'Refactoring UI notes',
      piSessionId: 'waker-atlas-ui',
      cardSummary: 'Collected rules about spacing, hierarchy and desaturated colour scales for the console redesign.',
      createdAt: ago(60 * 120),
      lastActiveAt: ago(60 * 5),
      messageCount: 6,
      nameSource: 'auto',
      nameFrom: 'card',
    },
  ],
  pilot: [
    {
      id: 'default',
      name: 'Weekly ops review',
      title: 'Weekly ops review',
      piSessionId: 'waker-pilot',
      cardSummary: 'Friday review: disk usage, backup freshness and open todos. Two items carried over.',
      createdAt: ago(60 * 200),
      lastActiveAt: ago(45),
      messageCount: 4,
      nameSource: 'auto',
      nameFrom: 'card',
      externalKey: 'feishu:u_demo_user',
    },
  ],
};

write(join(root, 'data', 'sessions.json'), `${JSON.stringify(sessions, null, 2)}\n`);
write(
  join(root, 'data', 'conversations.json'),
  `${JSON.stringify(
    {
      pilot: {
        'feishu:u_demo_user': {
          key: 'feishu:u_demo_user',
          wakerId: 'pilot',
          activeSessionId: 'default',
          history: ['default'],
          rejectStreak: 0,
          updatedAt: ago(45),
        },
      },
    },
    null,
    2,
  )}\n`,
);
write(
  join(root, 'data', 'config.json'),
  `${JSON.stringify(
    { piAgents: false, context: { enabled: true, maxTokens: 30000, keepTokens: 6000 }, preventSleep: false },
    null,
    2,
  )}\n`,
);

const task = (id, wakerId, sessionId, source, status, prompt, minutesAgo, extra = {}) => ({
  taskId: `demo-${id}`,
  wakerId,
  sessionId,
  source,
  status,
  prompt,
  createdAt: ago(minutesAgo),
  startedAt: ago(minutesAgo),
  endedAt: status === 'success' || status === 'failed' ? ago(minutesAgo - 1) : undefined,
  durationMs: status === 'success' || status === 'failed' ? 6200 : undefined,
  ...extra,
});

jsonl(join(root, 'data', 'tasks.jsonl'), [
  task('t1', 'atlas', 'default', 'im', 'success', 'Which is better for a five-day April trip, Kyoto or Osaka?', 14, {
    result: 'Kyoto for temples and walkability; Osaka as a base for day trips. Split 3/2 and keep one rainy-day plan.',
  }),
  task('t2', 'atlas', 'esp32', 'web', 'success', 'Draft a two-hour battery test plan for the glasses.', 95),
  task('t3', 'atlas', 'ui', 'cli', 'success', 'Collect spacing and hierarchy rules from the UI notes.', 300),
  task('t4', 'pilot', 'default', 'im', 'success', 'Run the Friday ops review and list anything overdue.', 45, {
    result: 'Disk 71%, backup 6h old, two carried-over todos.',
  }),
  task('t5', 'pilot', 'default', 'cron', 'failed', 'Check backup freshness.', 60 * 26, {
    error: 'backup host unreachable: timeout after 30s',
  }),
  task('t6', 'atlas', 'default', 'web', 'success', 'Compare rail pass options.', 60 * 30),
  task('t7', 'atlas', 'ui', 'web', 'success', 'Shorten the colour palette to five steps.', 60 * 48),
  task('t8', 'pilot', 'default', 'cron', 'success', 'Morning digest.', 60 * 26),
]);

jsonl(join(root, 'data', 'todos.jsonl'), [
  {
    id: 'demo-todo-1',
    wakerId: 'atlas',
    assignee: 'human',
    title: 'Book the ryokan in Kyoto',
    detail: 'Two nights, 12–14 April. Cancellation policy must allow changes.',
    dueAt: at(18),
    status: 'pending',
    source: 'web',
    createdAt: ago(120),
  },
  {
    id: 'demo-todo-2',
    wakerId: 'pilot',
    assignee: 'human',
    title: 'Rotate the backup drive',
    detail: 'Carried over from last week. Swap the USB drive and label the old one.',
    dueAt: dayOffset(-1, 10),
    status: 'pending',
    source: 'im',
    createdAt: ago(60 * 30),
  },
  {
    id: 'demo-todo-3',
    wakerId: 'atlas',
    assignee: 'human',
    title: 'Ask the vendor about lens distortion',
    detail: 'Need the datasheet before the next prototype run.',
    dueAt: dayOffset(1, 12),
    status: 'pending',
    source: 'cli',
    createdAt: ago(200),
  },
  {
    id: 'demo-todo-4',
    wakerId: 'pilot',
    assignee: 'agent',
    title: 'Summarize this week’s ops review',
    detail: 'Post the summary back to the Feishu thread.',
    dueAt: dayOffset(0, 16),
    status: 'done',
    source: 'im',
    createdAt: ago(60 * 8),
    doneAt: ago(60 * 2),
    note: 'Posted: disk 71%, backup 6h old, two carry-overs.',
    externalKey: 'feishu:u_demo_user',
  },
]);

const message = (role, text, minutesAgo, extra = {}) => ({
  type: 'message',
  timestamp: ago(minutesAgo),
  message: { role, timestamp: now - minutesAgo * 60_000, content: [{ type: 'text', text }], ...extra },
});
const assistant = (text, minutesAgo, { model = 'deepseek-v4-flash', input = 1800, output = 240, args } = {}) => ({
  type: 'message',
  timestamp: ago(minutesAgo),
  message: {
    role: 'assistant',
    model,
    timestamp: now - minutesAgo * 60_000,
    content: [
      ...(args ? [{ type: 'thinking', thinking: `Let me check ${args}` }] : []),
      ...(args ? [{ type: 'toolCall', name: 'bash', arguments: { command: args } }] : []),
      { type: 'text', text },
    ],
    usage: {
      input,
      output,
      cacheRead: 1200,
      cacheWrite: 0,
      totalTokens: input + output + 1200,
      cost: { total: 0.0004 },
    },
  },
});

const transcripts = {
  'waker-atlas': [
    message('user', 'I have five days in April. Kyoto or Osaka?', 26 * 60),
    assistant('Kyoto for temples and walkability; Osaka is a better base for day trips. Split 3/2 and keep one rainy-day plan.', 26 * 60 - 2),
    message('user', 'Which ryokan area is quiet but still walkable?', 30),
    assistant('Higashiyama, north of Gion. Ask for a room away from the street; cancellation policy matters more than breakfast.', 14, {
      args: 'ls ~/notes/japan',
    }),
  ],
  'waker-atlas-esp32': [
    message('user', 'What is the realistic battery life for the glasses prototype?', 150),
    assistant('With the current camera module, about 90 minutes of continuous capture. A two-hour test will tell you whether the buffer or the radio is the real drain.', 95, {
      args: 'ls ~/notes/esp32',
    }),
  ],
  'waker-atlas-ui': [
    message('user', 'Condense the UI notes into rules I can apply.', 60 * 6),
    assistant('1) Spacing scale of 4/8/16/24/32. 2) One accent colour, desaturated. 3) Borders only when elevation is ambiguous.', 60 * 5),
  ],
  'waker-pilot': [
    message('user', 'Friday ops review, please.', 60),
    assistant('Disk 71%, backup 6h old, two carried-over todos. Nothing failed since Tuesday.', 45, {
      args: 'df -h / && ls ~/backups',
    }),
  ],
};

for (const [piSessionId, rows] of Object.entries(transcripts)) {
  const file = join(root, 'pi', 'agent', 'sessions', '-demo-project', `2026-11-01T09-00-00-000Z_${piSessionId}.jsonl`);
  jsonl(file, rows);
}

write(
  join(root, 'README.txt'),
  `Revolver demo workspace
=======================

Agents : ${Object.keys(agents).join(', ')}
Data   : data/
Pi home: pi/

Start the board with:

  bash scripts/demo.sh

(or point a normal board at it)

  WAKER_AGENTS=${join(root, 'agents')} \\
  WAKER_DATA=${join(root, 'data')} \\
  PI_HOME=${join(root, 'pi')} \\
  node --experimental-strip-types bin/waker.ts board --port 8799
`,
);

console.log(`demo workspace ready: ${root}`);
console.log(`agents: ${Object.keys(agents).join(', ')} | sessions: ${Object.values(sessions).flat().length}`);
console.log(`local day: ${localDay(new Date())}`);
