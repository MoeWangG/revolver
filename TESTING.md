# 发布前测试：两台电脑

目标：**先在私有仓库里走一遍「推送 → 另一台电脑克隆 → 安装 → 跑起来」**，确认陌生人（另一台干净机器）能复现，再把仓库改成公开。

> 公开和私有的区别只有一个：私有仓库没人能搜到。代码内容、历史、Actions 行为完全一样，所以这是最接近真实用户的一次预演。

## 一、建私有仓库并推送（当前这台电脑）

1. GitHub → New repository
   - 名字：`revolver`
   - 可见性：**Private**
   - 不要勾选 "Add a README / .gitignore / license"（仓库已有）
2. 终端执行：

```bash
git remote add origin git@github.com:MoeWangG/revolver.git
git push -u origin main
```

3. 推完在 Actions 里等 CI 变绿。红了先修，别进入下一步。

## 二、在另一台电脑上测试（模拟真实用户）

### 1. 装前置（只做一次）

```bash
# Node 22+（推荐 nvm 或 homebrew）
node --version          # 需要 v22 或更高
npm i -g pnpm
npm i -g @earendil-works/pi-coding-agent
pi --version
```

Python 3.9+ 只有想测记忆服务时才需要。

### 2. 克隆并安装

```bash
git clone git@github.com:MoeWangG/revolver.git
cd revolver
bash scripts/setup.sh
```

`setup.sh` 应当依次输出 ①~⑧ 全绿，并把 `waker` 装到 `~/.local/bin`（不需要 sudo）。

### 3. 自动冒烟（最重要的一步）

```bash
bash scripts/smoke.sh
```

它会在**不碰你真实数据**的前提下检查：

- 仓库里没有个人绝对路径、没有明文 API key
- Node / pnpm / pi 就绪
- 依赖安装、`tsc` 零错误、15 个测试文件全过、前端能构建
- 用 `/tmp` 里的演示数据起看板，`/api/health`、`/api/sessions`、`/api/board` 都能读

最后一行必须是 `SMOKE PASS`。失败时把对应日志发回来：

```
/tmp/revolver-smoke-test.log
/tmp/revolver-smoke-build.log
/tmp/revolver-smoke-board.log
```

### 4. 人工看一眼（5 分钟）

```bash
bash scripts/demo.sh        # http://127.0.0.1:8799
```

- 左侧应有 Atlas / Pilot 两个员工
- 会话列表应有 4 个会话，点开能看到对话和「执行过程」
- 待办区应有「已过期 / 到期 / 待办」三种状态
- 全程不出现 `/Users/<你的用户名>` 这类路径

想测真实对话：

```bash
waker agent new tester --role "测试员工"
waker chat tester
# 说一句：用 ls 看一下当前目录
```

### 5. 记录结果（建议直接填在 Issue 或备忘录里）

| 检查 | 目标 |
|---|---|
| `setup.sh` 总耗时 | < 5 分钟（不含下载 Node/Pi） |
| `smoke.sh` 结果 | `SMOKE PASS` |
| 看板首屏 | < 3 秒打开，4 个会话 |
| 真实对话 | 能拿到模型回复，权限门禁生效 |
| 有没有需要手动改的路径 | 应该没有 |

## 三、测完再把仓库改成公开

公开前建议二选一：

**A. 保留提交历史（推荐，适合求职展示）**

旧提交里仍能看到早期 `agents/*/waker.yaml` 的个人路径（不是密钥）。如果介意，用 `git filter-repo` 清掉这些路径后再公开；不介意就直接改 Public。

**B. 只保留当前代码（最干净）**

```bash
git checkout --orphan public
git add -A
git commit -m "Initial public release"
git push -f origin public:main
```

代价是丢掉之前的提交记录。求职展示时，提交历史是加分项，能保留就保留。

然后：

1. 仓库 Settings → 底部 **Change visibility → Public**
2. About 填：`A local, self-hosted AI teammate platform: topic-aware sessions, Feishu-native, built on Pi.`
3. Topics 加：`agent` `ai` `feishu` `pi` `typescript` `self-hosted`
4. 把仓库置顶到 GitHub 主页

## 四、绝对不要提交的东西

`.gitignore` 已经挡住，但推之前仍建议确认：

```bash
git status --short          # 应为空
git ls-files | grep -E "^(agents/|data/|\.env)"   # 应为空
```

- `agents/`：你的员工档案与长期记忆
- `data/`：任务、会话指针、待办、routing 流水
- `~/.pi/agent/sessions/`：真实对话（本来就不在仓库里）
- `vendor/multi-pi-memory/memory-server/data/`：记忆库 `memory.db`
- `vendor/multi-pi-memory/memory-server/config.yaml`：本机后端配置
- `*.secrets.json` / `.env*`

## 五、如果另一台电脑跑不起来

按这个顺序排查，基本能定位：

1. `node --version` 是否 22+（低了 `setup.sh` 会直接报错）
2. `pi --version` 是否可用（看板不依赖，但对话依赖）
3. `pnpm --version` 是否可用（`setup.sh` 会尝试 corepack 启用）
4. `web/dist/index.html` 是否存在（没有就是前端构建失败，看日志）
5. 端口是否被占：`lsof -i :8787` / `:8799`
6. 看板能开但没有回复：检查 `waker doctor` 的 pi / 模型配置

把 `setup.sh` 的完整输出和 `smoke.sh` 的失败项贴回来即可，不需要截整个屏幕。
