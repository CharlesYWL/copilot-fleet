# Fleet Orchestrator — 合成设计

> 状态：提案（待评审）。
> 日期：2026-08-20。
>
> **取代** `2026-08-18-fleet-orchestrator-design.md` 的控制面形状，以及 `2026-08-18-orchestrator-design.md` 的「Lead 只吐一次计划」。
> **保留** 前者的判断层（编排者是模型、MCP 门面、category、role 闸门、hub-and-spoke）和后者的机械层（run 表、`planNextActions`、重启不误判、回执≠完成）。
> **几乎整份保留** `2026-08-18-orchestrator-harness-choice.md`：MCP 是合同，第一只 Lead 用 Copilot，Pi 推迟；工具名单改成本文的带收据 spawn 动词。
>
> ACP 无 peer 通道，Host 是唯一编排者。`SessionLink` 保持作废。

## 1. 需求

原始句子（判断，不是查找表）：

> I don't want the flow fixed like PR → Review. When I give it work or an ADO item, it should know which Nodes are occupied and assign a different VM. Once ACP returns done, it should know whether to open a review session — maybe with a different model — or, on a simple PR, just agree.

做不到这件事的两极：

- 固定边（SessionLink）和「批准后冻结的 DAG」都装不下 *maybe*。
- 模型直接打无鉴权的 `POST /api/sessions`，Host 重启后无人知道派生到哪一步，也没有预算可执行。

## 2. 一句话

**Lead 调用 `fleet_session_start` 来派 session；Host 在同一笔事务里先写 `run_step` 再对 Node 发真正的 `start_session`。Lead 派完就睡。worker settle 后引擎把 run 打成 `awaiting_lead`，再灌一条有界信封叫醒它。**

Propose / dispose。英文稿的动词，中文稿的收据。

```text
        ┌──────────────── Host ────────────────┐
        │                                      │
 Lead ──fleet_session_start──▶ Engine ──start_session──▶ Worker
 (普通 session,               （确定性、写收据、        (普通 session,
  仅 lead 持有 MCP)            选点、认完成、叫醒)        无 fleet 工具)
        ▲                            │
        └── fleet-wake prompt ◀──────┘   仅当 awaiting_lead 且 Lead idle
```

## 3. 职责切分

### 3.1 Lead（模型）允许做的

- `fleet_session_start`：现在派一个 worker / reviewer。
- `fleet_session_prompt`：给**本 run** 里卡住的 session 追加一轮。
- `fleet_finish` / `fleet_escalate`：结束或交给人。
- 只读：`fleet_list_nodes`、`fleet_list_sessions`、`fleet_transcript`、`fleet_note_*`。
- 自己的 shell 读 ADO。Host 不集成工作项跟踪器。
- cwd 必须是 scratch，禁止改业务仓库。

### 3.2 Lead 不允许做的

- 绕过 run 记账起 session（MCP ≠ 今天的 `POST /api/sessions`）。
- 在 worker 跑的整段时间里靠 `fleet_await` 空转续命。短 `fleet_await`（上限 60s）只允许出现在**同一 turn** 里，不是耐久机制。
- 对他人 session 发 `cancel` 来回收容量。超时和取消 run 由引擎发 `stop`。
- 给 worker 再套一层 fleet 工具（`run_role` 闸门）。
- 改自己的硬限额（预算、hop、role）。限额住在 Host。

### 3.3 引擎（Host）独占的

- 持有 `runs` / `run_steps`。
- 选点：在线、`reservedSessionCount` headroom、`host-yolo`、同仓库亲和。`placementId` 若由 Lead 给出，只做校验，不合格则结构化拒绝并附上当前容量表。
- 完成判定：`turn_complete` 然后 `idle`。`command_result{ok:true}` 只表示命令收到。
- 派 step 只发 `start_session`（它自带首轮 prompt），禁止立刻再补一条 `prompt`。
- 超时 / 取消 run → `stop`，不是 `cancel`。
- Host 重启：`offline` = 未知。boot 时不得 settle。
- category → model + effort + mode。`review-deep` 定义为与 implementer 不同的模型家族。
- 叫醒 Lead：见 §6。

人工闸门在 **run 的 objective**，不在每一次 spawn。人批准「做这件事 + 预算」；之后 Lead 在预算内自己派。工人权限横幅照常；人随时取消整个 run。

## 4. 数据模型

沿用 `CREATE TABLE IF NOT EXISTS` + `addColumnIfMissing`。不用 `ON DELETE CASCADE`：删 run 之前必须先 `stop` 活着的 worker。`transaction()` 不可重入，公开方法开事务，内部走非事务 helper。

```sql
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  state TEXT NOT NULL,
  -- planning | awaiting_approval | running | awaiting_lead
  -- | aggregating | completed | failed | cancelled
  lead_session_id TEXT NOT NULL DEFAULT '',
  policy TEXT NOT NULL,
  -- JSON: {maxParallel, maxSessions, maxWakes, yolo, onStepFailure,
  --        wakePolicy, stepTimeoutMs, staleAfterMs}
  failure_reason TEXT NOT NULL DEFAULT '',
  last_settled_at TEXT NOT NULL DEFAULT '',
  last_wake_at TEXT NOT NULL DEFAULT '',
  empty_wake_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  step_key TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  depends_on TEXT NOT NULL,          -- JSON string[]；手写 DAG 夹具用。Lead 按步派发时通常为 []
  state TEXT NOT NULL,               -- pending|running|succeeded|failed|skipped|cancelled
  session_id TEXT,
  placement_id TEXT,
  output TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_run_steps_session ON run_steps(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
```

`sessions` 加列：

```ts
this.addColumnIfMissing("sessions", "run_id", "TEXT NOT NULL DEFAULT ''");
this.addColumnIfMissing("sessions", "run_role", "TEXT NOT NULL DEFAULT ''");
// '' | lead | worker | reviewer
```

`run_role=lead` 是 MCP 闸门的唯一依据。Worker / reviewer 的 `session/new` 继续 `mcpServers: []`。

Notes（英文稿的 notepads）v1 就做，很小，且叫醒信封放不下的东西靠它：

```sql
CREATE TABLE IF NOT EXISTS run_notes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  topic TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, topic)
);
```

Policy 默认值：

- `maxParallel`: 3
- `maxSessions`: 8（本 run 累计 spawn，含 Lead）
- `maxWakes`: 12
- `yolo`: true（Node 必须有 `host-yolo`）
- `onStepFailure`: 不自动 finish；settle 后叫醒 Lead
- `wakePolicy`: `on_any_settle`（手写 DAG 夹具用 `none`）
- `stepTimeoutMs`: 明显长于 Node 的 `permissionTimeoutMs`
- `staleAfterMs`: 明显长于 `HEARTBEAT_TIMEOUT_MS`（15s）

同 workspace 并行 step v1 **上限 1**。文件系统竞态（relay 稿）未解；fan-out / worktree 是后一刀。不同 workspace 可以并行。

## 5. 状态机

```text
Run:  planning ─▶ awaiting_approval ─▶ running ─▶ awaiting_lead ─▶ aggregating ─▶ completed
                     │                    │              │
                     └────────────────────┴──────────────┴──▶ failed | cancelled

Step: pending ─▶ running ─▶ succeeded
         │          │
         │          └─▶ failed | cancelled
         └─▶ skipped | cancelled
```

- 人批准 objective 后：起 Lead（`run_role=lead`，挂 MCP），run 进 `planning`。Lead 第一次 `fleet_session_start` 成功后进 `running`。

Lead 的 cwd 是 Host 上预配的 **scratch placement**：一个专用 workspace，路径在编排用的那台 Node 上，里面没有业务仓库。没有 scratch placement 就拒绝创建 run，而不是把 Lead 丢进目标仓库。
- `running`：至少一步在飞。Lead **idle**。
- `awaiting_lead`：有新的 settle，且 `wakePolicy=on_any_settle`。引擎试图叫醒 Lead。
- Lead 再 `fleet_session_start` → 回到 `running`。
- `fleet_finish` → `aggregating`（可选：再灌 Lead 写总结）→ `completed`。v1 允许 `fleet_finish` 直接 `completed`，总结就是 Lead 本轮散文。
- 手写 DAG（`wakePolicy=none`）：批准后引擎按依赖派完，从不进 `awaiting_lead`。这是 P0/P1 的测试夹具，不是 Lead 主路径。

## 6. 叫醒协议

任意一步 settle 后：

1. 写 `runs.last_settled_at = now`。
2. `wakePolicy=none`：只做 DAG tick，不叫醒。
3. 否则 run → `awaiting_lead`。
4. 仅当 Lead `idle` **且** `last_settled_at > last_wake_at` 时发一条 `prompt`。
5. Lead `running`：挂起。`state → idle` 时再冲。对忙目标最多一条 pending，payload 以当前快照为准 coalesce。禁止对 busy Lead 发 prompt（`CommandRefused`）。

Lead 自身状态：

| Lead 状态 | 引擎 |
| --- | --- |
| idle | 发 fleet-wake |
| running / cancelling | 等 idle |
| offline | 未知，等重连。boot 时禁止 settle/finish |
| 终态但可 resume | 停在 `awaiting_lead`，UI Needs You。resume 变 idle 后再发。Auto-resume **只挂上不发 prompt**，必须由引擎补这一下 |
| 不可 resume 的终态 | run → `failed`，理由 `lead lost` |

幂等靠 `last_settled_at` / `last_wake_at` 两列，不靠内存里「我记得发过」。Host 重启后 reconcile Node，Lead idle 且 `last_settled_at > last_wake_at` → 恰好补一条。

### 6.1 信封

不伪造 session 事件。就是一条普通 prompt，用信封让 `SKILL.md` 认得出这是决策拍。Lead cwd 是 scratch，读不到 worker 磁盘。v1 不新增 Node git 命令。

产物取 `listEvents(sessionId)` 的 `agent_text` 按 sequence 拼接，截到 `maxOutputChars`。**不用** `session.lastText`（只有 500 字），**不混** `agent_thought`。

```text
<fleet-wake runId=... wakes=2/12 sessions=3/8>
Just settled:
- implement (sess abc): succeeded
  output: {truncated agent_text}

Still running:
- tests (sess def): running 8m

Call one of: fleet_session_start | fleet_session_prompt | fleet_finish | fleet_escalate
Need more: fleet_transcript({sessionId})
</fleet-wake>
```

完整日志按需 `fleet_transcript`。`git diff` 进信封是 isolation 那一刀的质量目标；v1 用产物文本。

### 6.2 空转

看工具收据，不看散文。零 fleet 工具的一轮结束：`empty_wake_count++`，再叫醒一次并附「必须调用工具」。第二次仍空：停在 `awaiting_lead`，UI Needs You，**不**自动 `finish`。

人在 worker 飞行时可以跟 Lead 说话。Lead 忙则 settlement 排队；闲下来若有未叫醒的 settle，先冲 fleet-wake。

## 7. 引擎

纯函数 + 薄壳，与中文稿 §4 相同，增加叫醒动作：

```ts
export type ScheduleAction =
  | { type: "start_step"; stepId: string; placementId: string; prompt: string }
  | { type: "settle_step"; stepId: string; state: RunStepState; output: string }
  | { type: "skip_step"; stepId: string; reason: string }
  | { type: "wake_lead"; runId: string; prompt: string }
  | { type: "aggregate"; summary: string }
  | { type: "finish_run"; state: RunState; reason: string };
```

Tick 触发（不轮询）：`handleEvent` 收到本 run session 的 `turn_complete` / `state`；session 终态；node 上线；REST（创建/批准/取消 run）；MCP 工具返回之后。

`FleetService` 只暴露 `onSessionEvent`。引擎在 `server.ts` 注册。`FleetService` 不 import 编排器。

抽出 `createAndStartSession`（今天写在 `routes/sessions.ts`），供 REST、引擎、MCP 共用。

选点规则抄中文稿 §4.4，外加：同一 workspace 已有非终态 step 时，v1 拒绝第二条并行（结构化错误 `workspace_busy`）。Lead 应结束本轮去睡，等 `awaiting_lead` 再派；不要靠短 `fleet_await` 把 Lead 卡在 running。不同 workspace 不受这条限制。

必须留一格 headroom。吃满 `maxSessions` 会撞 Node 侧 fatal `"Node is at capacity"`。

## 8. MCP 工具

HTTP MCP，per-session bearer，只发给 `run_role=lead`。Facade 覆盖 `FleetService` + 引擎，不是第二套行为。浏览器继续走 REST；Lead 禁止走无鉴权 REST。

```ts
// 只读
fleet_list_nodes()
fleet_list_placements()
fleet_list_sessions({ runId })
fleet_transcript({ sessionId, since?, types?, maxBytes? })
fleet_note_read({ runId, topic? })
fleet_note_write({ runId, topic, body })

// 派发（有收据）
fleet_session_start({
  runId: string,
  category: "implement" | "review-deep" | "review-quick" | "explore" | "test",
  prompt: string,
  name?: string,
  placementId?: string,  // 提示；省略则引擎选
  yolo?: boolean,
}): { stepId: string; sessionId: string; placementId: string; state: "running" }

fleet_session_prompt({ runId, sessionId, prompt })  // 仅本 run；目标必须 idle
fleet_session_stop({ runId, sessionId })            // 仅本 run；引擎发 stop

fleet_finish({ runId, summary? })
fleet_escalate({ runId, reason })

// 可选、同一 turn 内、上限 60s。Host 重启会掐断，不是叫醒机制。
fleet_await({ runId, sessionIds, until: "idle" | "terminal", timeoutSeconds })
```

启动 Lead：Host 用 `--additional-mcp-config`（先探测 Copilot 是否接受该 flag）注入 fleet 服务器和 scoped token。退路是该 Node 上的 `~/.copilot/mcp-config.json`，只适合第一台手配机器。Custom agent markdown（`tools:` allowlist）是第二道闸门。编排政策写成 `SKILL.md`，即便第一只 Lead 是 Copilot。

预算耗尽、role 不符、workspace_busy、无 headroom：工具返回结构化拒绝，模型应上报而不是盲重试。

## 9. 协议与兼容

| 改动 | 风险 |
| --- | --- |
| `BrowserMessageSchema` 加 `run` / `run_steps` | 无（UI 与 Host 同部署） |
| `SessionSchema` 加 `runId` / `runRole`，`.default("")` | 无；Node 不消费 SessionSchema |
| 新 Run / RunStep / RunNote 类型 | 无；不进 Node wire union |
| `NodeCommandSchema` / `HostToNodeMessageSchema` | **不动** |
| 新 SessionEvent 类型 | **不做**。编排进展走 browser 的 `run` 消息 |
| 顺手导出 `HOST_YOLO_CAPABILITY` 常量 | 无 |

## 10. REST 与 UI

浏览器（人）：

```text
GET    /api/runs
POST   /api/runs                 创建（objective + workspaceId + policy）
GET    /api/runs/:id
POST   /api/runs/:id/plan        手写 DAG 夹具（wakePolicy=none）
POST   /api/runs/:id/approve
POST   /api/runs/:id/cancel      级联 stop worker + lead
DELETE /api/runs/:id
```

UI：侧边栏 Runs；step 点进现有 `TerminalView`。`awaiting_lead` 和等待权限一样计入顶栏 Needs You。Run 上显示预算消耗和「停止整个 run」。

## 11. 分期

| 阶段 | 内容 | 可验证 |
| --- | --- | --- |
| P0 引擎 | 表 + 状态机 + `planNextActions`（含 `wake_lead`、重启不误判） | 纯函数单测全绿，不碰网络 |
| P1 夹具 | `POST /plan` + 引擎接线 + Runs UI + `--mock-agent` | 两 mock node 上 `audit→fix→test`，Host 重启后续跑 |
| P2 MCP + Lead | MCP 门面、`createAndStartSession` 抽出、custom agent、`SKILL.md`、叫醒信封 | 一句 objective → Lead 派 worker → settle → 叫醒 → finish 或再派 reviewer |
| P3 | 失败重试、跨 node artifact、worktree 后的同仓库并行 / fan-out、Pi 作为 agent kind | — |

P0+P1 零 LLM，用来锁中文稿那些会在生产重启时才爆的不变量。P2 才把英文稿的判断接上。不要用 curl 打无鉴权 REST 当接口；hours-scale 的人工 spike 可以，但那不是合同。

第一只 Lead 用 Copilot。Pi 作为 Host 旁路进程只适合 spike（看不见卡片）。真正要 Pi 时做成 agent kind + 先 probe `pi-acp`。不要通用 harness 抽象。不要让 Lead 改自己的限额；Pi 的自我改装在 orchestrator 角色上关闭。

## 12. P0 不变量（各对应一个真实坑）

1. 全员 `offline` 时不得 `settle_step` / `finish_run` / `wake_lead`。
2. step `running` 且无 `turn_complete` 时不得判成功。
3. 终态 step 的迟到事件：无视。
4. 剩余容量 0 或不留 headroom：不派发。
5. 同 workspace 已有非终态 step：第二条 `start_step` 拒绝（v1）。
6. `last_settled_at > last_wake_at` 且 Lead idle：恰好一条 `wake_lead`；两步同时 settle 且 Lead busy：coalesce 成一条。
7. Auto-resume 后 Lead idle、run 仍 `awaiting_lead`：补一条 wake。
8. 两轮空转：不再自动 wake，保持 `awaiting_lead`。
9. 派发 step 只产生一个 `start_session`，不附带 `prompt`。
10. 超时动作是 `stop` 不是 `cancel`。

## 13. 明确不做（v1）

- SessionLink 固定边
- 无收据的 MCP→REST 直通
- 围栏块 `fleet-plan` 作为长期合同（P1 夹具可以继续用 JSON 计划，那是 REST `/plan`，不是 Lead 主路径）
- Peer mailbox
- 自动 git worktree
- ADO 进 Host
- 嵌套编排（worker 持有 fleet 工具）
- 通用多 harness 抽象
- 让编排者编辑硬限额
- 替换 Copilot 工人

## 14. 落地时改的文档

- `ARCHITECTURE.md`：删除 non-goal「Agent-to-agent DAGs」，加 Orchestration 节（propose/dispose、叫醒、offline=未知）。
- `PRODUCT.md`：领域模型加 Run / RunStep；用户流程加编排。
- `README.md`：mock-agent 流水线作为 proof of concept。

## 15. 已关闭的选择

| 问题 | 决定 |
| --- | --- |
| 谁调用 start | Lead 调 `fleet_session_start`；Host 写收据再派 |
| 计划是一次 DAG 还是逐步派 | Lead 主路径逐步派；手写 DAG 仅夹具 |
| 模型是否空转等待 | 否。短 await 可选；耐久叫醒靠 `awaiting_lead` |
| 何时叫醒 | `on_any_settle` + coalesce |
| 灌什么 | 有界 `<fleet-wake>` 信封，产物来自 `agent_text` |
| 空转 | 两圈后 Needs You，不自动 finish |
| 人工闸门 | 批准 objective，不批准每一次 spawn |
| 同仓库并行 | v1 上限 1 |
| 失败默认 | 叫醒 Lead，不默认 fail-fast 整 run |
| Harness | Copilot 第一；MCP 合同；Pi 推迟 |
| 记忆 | Host notes + 事件日志；不引进外部 memory |
