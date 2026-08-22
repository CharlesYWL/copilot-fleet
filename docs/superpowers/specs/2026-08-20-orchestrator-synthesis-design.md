# Fleet Orchestrator — 合成设计

> 状态：已评审（2026-08-21，三方 review + 代码核对），已按裁决修订，§16 三份 P2 合同均已定案。P0/P1 与 P2 皆可开工。
> 日期：2026-08-20，修订 2026-08-21。
>
> **取代** `2026-08-18-fleet-orchestrator-design.md` 的控制面形状，以及 `2026-08-18-orchestrator-design.md` 的「Lead 只吐一次计划」。
> **保留** 前者的判断层（编排者是模型、MCP 门面、category、role 闸门、hub-and-spoke）和后者的机械层（run 表、`planNextActions`、重启不误判、回执≠完成）。
> **几乎整份保留** `2026-08-18-orchestrator-harness-choice.md`：MCP 是合同，第一只 Lead 用 Copilot，Pi 推迟；工具名单改成本文的带收据 spawn 动词。**一处推翻**：该稿判定 `--additional-mcp-config` 比 threading ACP `mcpServers` 更小，核对 SDK 后不成立——`mcpServers` 是 `session/new` 的原生入参，见 §16.1。
>
> ACP 无 peer 通道，Host 是唯一编排者。`SessionLink` 保持作废。

## 1. 需求

原始句子（判断，不是查找表）：

> I don't want the flow fixed like PR → Review. When I give it work or an ADO item, it should know which Nodes are occupied and assign a different VM. Once ACP returns done, it should know whether to open a review session — maybe with a different model — or, on a simple PR, just agree.

做不到这件事的两极：

- 固定边（SessionLink）和「批准后冻结的 DAG」都装不下 *maybe*。
- 模型直接打 `POST /api/sessions`，Host 重启后无人知道派生到哪一步，也没有预算可执行。（那条路并非无鉴权——`request-guard.ts` 有 operator cookie 闸门——但它**没有 run 记账**，这才是它当不了编排接口的原因。）

## 2. 一句话

**Lead 调用 `fleet_session_start` 来派 session；Host 先在一笔事务里把 `run_step` 写成 `starting`（收据先落地），再对 Node 发 `start_session`。Lead 派完就睡。worker settle 后引擎把 run 打成 `awaiting_lead`，再灌一条有界信封叫醒它。**

Propose / dispose。英文稿的动词，中文稿的收据。

写库和发命令**不可能**在同一笔事务里：SQLite 事务包不住 WebSocket I/O。收据先落地，`starting` 就是那个必须存在的中间态——Node ACK（`command_result`）后转 `running`；发送失败当场回 `pending`；ACK 前 Node 掉线由 deadline 扫成 `failed`。工具因此返回 `accepted`，不返回 `running`（§8）。

```text
        ┌──────────────── Host ────────────────┐
        │                                      │
 Lead ──fleet_session_start──▶ Engine ──start_session──▶ Worker
 (普通 session,               （确定性、写收据、        (普通 session,
  仅 lead 持有 MCP)            选点、认完成、叫醒)        无 fleet 工具)
        ▲                            │
        └── fleet-wake prompt ◀──────┘   仅当 awaiting_lead 且 Lead idle
```

### 2.1 两个方向是两条通道（别把它们混成一条）

图里那两条箭头用的**不是**同一个机制，这是最容易读错的一处：

| 方向 | 通道 | 要 MCP 吗 |
| --- | --- | --- |
| Lead → Host（派活、prompt、finish、escalate） | MCP 工具调用 | **要**。这是 MCP 存在的**唯一**理由 |
| Host → Lead（叫醒） | 普通 `prompt` NodeCommand | **不要**。今天就有的路径，一个字节不改 |

叫醒不是任何人「调用」出来的，是 Host 主动灌一条普通 prompt（§6.1：不伪造 session 事件）。所以：

- **MCP 只是 propose 那一侧的入口**，不参与 dispose，也不参与叫醒。
- **worker 拿 `mcpServers: []` 不是因为它不需要汇报**，而是因为它不该有能力主动联系任何人。worker 的「汇报」是被动事实：它 `turn_complete` 然后 `idle`，Host 观察到，Host 自己去叫醒 Lead。
- 因此「给 worker 一个工具让它叫醒 Lead」是错的方向——那是 §13 排除的嵌套编排，而且会把完成判定从 Host 手里交给一个可能撒谎或崩溃的模型。

## 3. 职责切分

### 3.1 Lead（模型）允许做的

- `fleet_session_start`：现在派一个 worker / reviewer。
- `fleet_session_prompt`：给**本 run** 里卡住的 session 追加一轮。
- `fleet_finish` / `fleet_escalate`：结束或交给人。
- 只读：`fleet_list_nodes`、`fleet_list_sessions`、`fleet_transcript`、`fleet_note_*`。
- 自己的 shell 读 ADO。Host 不集成工作项跟踪器。
- cwd 必须是 scratch，禁止改业务仓库。**这是约定加审计，不是沙箱。** Lead 带 shell + YOLO 就能 `cd` 到同机任意路径；更实的一条是 Node 磁盘上存着 node secret（`apps/node/src/config.ts`），而 node 凭证可达 `POST /api/workspaces` 和 `POST /api/placements`（`request-guard.ts` 的 `NODE_METHOD_PATHS`），足以自造指向任意本地路径的 placement。要真隔离只有两条路：Lead 专用 Node + 独立执行身份，或撤掉 Lead 的 shell/YOLO。v1 选约定，但本文不得把 cwd 描述成防火墙。

### 3.2 Lead 不允许做的

- 绕过 run 记账起 session（MCP ≠ 今天的 `POST /api/sessions`）。
- 在 worker 跑的整段时间里靠 `fleet_await` 空转续命。短 `fleet_await`（上限 60s）只允许出现在**同一 turn** 里，不是耐久机制。
- 对他人 session 发 `cancel` 来回收容量。超时和取消 run 由引擎发 `stop`。
- 给 worker 再套一层 fleet 工具（`run_role` 闸门）。
- 改自己的硬限额（预算、hop、role）。限额住在 Host。

### 3.3 引擎（Host）独占的

- 持有 `runs` / `run_steps`。
- 选点：在线、`reservedSessionCount` headroom、`host-yolo`、同仓库亲和。**首个有副作用的 step 落地后，run 被钉在那个 `placementId` 上**（§4 `runs.placement_id`），之后所有 step 复用它；`placementId` 若由 Lead 给出，只做校验，不合格则结构化拒绝并附上当前容量表。
- 完成判定：`turn_complete` 然后 `idle`。`command_result{ok:true}` 只表示命令收到，作用是把 step 从 `starting` 推到 `running`。
- 派 step 只发 `start_session`（它自带首轮 prompt），禁止立刻再补一条 `prompt`。
- 超时 / 取消 run → `stop`，不是 `cancel`。deadline 由引擎自己的低频 sweeper 触发（§7）。
- run 进终态时 `stop` 本 run 全部非终态 session，包括成功后闲着的 worker——非终态 session 一直吃 `reservedSessionCount`（`session-policy.ts`：*anything not terminal reserves a slot*），不回收就会几个 run 之内把 Node 占满。
- Host 重启：`offline` = 未知。boot 时不得 settle。
- category → model + effort + mode。`review-deep` 定义为与 implementer 不同的模型家族。落法是 `session/new` 之后、首轮 prompt 之前发 `set_config_option`（ACP 的 category 枚举里 `model` / `mode` / `thought_level` 都是具名的）；模型 id 由 agent 当轮报出，解析不到请求的家族就让这一步结构化失败，**不静默降级**。见 §16.1。
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
  placement_id TEXT NOT NULL DEFAULT '',
  -- 钉住的工作面。首个有副作用的 step 落地时写死，之后不再重选。
  policy TEXT NOT NULL,
  -- JSON: {maxParallel, maxSessions, maxWakes, maxOutputChars, yolo,
  --        onStepFailure, wakePolicy, stepTimeoutMs, staleAfterMs}
  failure_reason TEXT NOT NULL DEFAULT '',
  settle_seq INTEGER NOT NULL DEFAULT 0,
  wake_seq INTEGER NOT NULL DEFAULT 0,
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
  state TEXT NOT NULL,               -- pending|starting|running|succeeded|failed|skipped|cancelled
  session_id TEXT,
  placement_id TEXT,
  output TEXT NOT NULL DEFAULT '',
  event_seq_from INTEGER NOT NULL DEFAULT 0,
  -- 信封取产物的水位线；同一 session 被再次 prompt 时防止重灌上一轮
  attempts INTEGER NOT NULL DEFAULT 0,
  dispatched_at TEXT NOT NULL DEFAULT '',   -- 进入 starting 的时刻，deadline 从这里算
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_run_steps_session ON run_steps(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
```

两处刻意的选择：

- **`settle_seq` / `wake_seq` 是单调整数，不是时间戳。** §12 不变量 6（恰好一条 wake）整个压在这个比较上，而 TEXT 时间戳会被同毫秒双 settle、时钟回拨、重启后 skew 打穿。整数计数器同样只有两列，还不需要时钟。
- **`step_key` 语义由 Lead 决定。** `fleet_session_start` 接受可选 `stepKey`：同 key = 重试，复用同一行并 `attempts++`；省略则引擎生成唯一 key，`attempts` 恒为 1。不定这条，`UNIQUE(run_id, step_key)` 和 `attempts` 两边都悬着。

`sessions` 加列：

```ts
this.addColumnIfMissing("sessions", "run_id", "TEXT NOT NULL DEFAULT ''");
this.addColumnIfMissing("sessions", "run_role", "TEXT NOT NULL DEFAULT ''");
// '' | lead | worker | reviewer
```

`run_role=lead` 是 MCP 闸门的唯一依据。Worker / reviewer 的 `session/new` 继续 `mcpServers: []`——那不是「关掉了工具」，而是**从没给过**：ACP 里工具是按 session 注入的，没注入就不存在。这也不妨碍 worker 被观察到完成：完成是 Host 从 `turn_complete` + `idle` 认出来的事实，不需要 worker 主动说话（§2.1）。

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

- `maxParallel`: 3（只在跨 placement 时可达，见下）
- `maxSessions`: 8（本 run 累计 spawn，含 Lead）
- `maxWakes`: 12。耗尽不自动 finish：停在 `awaiting_lead`，UI Needs You，与两轮空转同一个出口
- `maxOutputChars`: 8000（信封里单个 step 产物的上限，§6.1）
- `yolo`: true（Node 必须有 `host-yolo`）
- `onStepFailure`: 不自动 finish；settle 后叫醒 Lead
- `wakePolicy`: `on_any_settle`（手写 DAG 夹具用 `none`）
- `stepTimeoutMs`: 明显长于 Node 的 `permissionTimeoutMs`
- `startingTimeoutMs`: 120_000。只约束「发帧 + 拉起 Copilot + `session/new`」这一段，与 `stepTimeoutMs` 差一个量级，理由见 §16.2d
- `staleAfterMs`: 明显长于 `HEARTBEAT_TIMEOUT_MS`（15s）

并发锁的轴是 **placement，不是 workspace**。文件竞态发生在物理路径上：一个 workspace 在 N 台 Node 上是 N 个 `createPlacement(workspaceId, nodeId, localPath)`，也就是 N 个独立 checkout，跨 placement 并行零风险；同一 placement 上的两个写 session 才是真竞态（relay 稿那一刀）。

于是 v1 规则是：**同一 placement 上，会写盘的 category（`implement` / `test`）上限 1**；`review-*` / `explore` 是只读的，不计入写锁，可以与 writer 共用同一 placement——而这正是 reviewer 能看见改动的**唯一**前提（§3.3 的 run 钉 placement）。放开并发但不钉 placement 会更糟：两个 reviewer 并行去看两棵陈旧的树。

按 workspace 加锁则是错的轴：会把「人在 A 机开着 session」变成「B 机也不许派活」。fan-out / worktree 仍是后一刀。

## 5. 状态机

```text
Run:  awaiting_approval ─▶ planning ─▶ running ⇄ awaiting_lead ─▶ aggregating ─▶ completed
              │                │           │            │
              └────────────────┴───────────┴────────────┴──▶ failed | cancelled

Step: pending ─▶ starting ─▶ running ─▶ succeeded
                                   └─▶ failed | cancelled

      pending  ─▶ skipped | cancelled
      starting ─▶ pending   （命令没发出去，回滚重排）
      starting ─▶ failed    （ACK 前 Node 掉线，由 deadline 判）
```

- `POST /api/runs` 创建即 `awaiting_approval`；**批准是入口，不是中途**。人批准 objective 后才起 Lead（`run_role=lead`，挂 MCP），run 进 `planning`。Lead 第一次 `fleet_session_start` 被 Node ACK 后进 `running`。

Lead 的 cwd 是 Host 上预配的 **scratch placement**：一个专用 workspace，路径在编排用的那台 Node 上，里面没有业务仓库。没有 scratch placement 就拒绝创建 run，而不是把 Lead 丢进目标仓库。
- `running`：至少一步在飞（`starting` 也算在飞）。Lead **idle**。
- `awaiting_lead`：有新的 settle，且 `wakePolicy=on_any_settle`。引擎试图叫醒 Lead。
- Lead 再 `fleet_session_start` → 回到 `running`。
- `fleet_finish` → `aggregating`（可选：再灌 Lead 写总结）→ `completed`。v1 允许 `fleet_finish` 直接 `completed`，总结就是 Lead 本轮散文。
- 手写 DAG（`wakePolicy=none`）：批准后直接进 `running`，引擎按依赖派完，从不进 `planning`（没有 Lead，也就没什么可 plan 的——计划是 REST 送进来的），也从不进 `awaiting_lead`。这是 P0/P1 的测试夹具，不是 Lead 主路径。

## 6. 叫醒协议

叫醒走的是**普通 `prompt` NodeCommand**，不是 MCP，也不是新的事件类型（§2.1）。`NodeCommandSchema` 里那个成员今天就在用，这条协议不给 wire 加任何东西。

任意一步 settle 后：

1. `runs.settle_seq++`。
2. `wakePolicy=none`：只做 DAG tick，不叫醒。
3. 否则 run → `awaiting_lead`。
4. 仅当 Lead `idle` **且** `settle_seq > wake_seq` 时发一条 `prompt`，发出后 `wake_seq = settle_seq`。
5. Lead `running`：挂起。`state → idle` 时再冲。对忙目标最多一条 pending，payload 以当前快照为准 coalesce。禁止对 busy Lead 发 prompt（`CommandRefused`）。

Lead 自身状态：

| Lead 状态 | 引擎 |
| --- | --- |
| idle | 发 fleet-wake |
| running / cancelling | 等 idle |
| offline | 未知，等重连。boot 时禁止 settle/finish |
| 终态但可 resume | 停在 `awaiting_lead`，UI Needs You。resume 变 idle 后再发。Auto-resume **只挂上不发 prompt**，必须由引擎补这一下 |
| 不可 resume 的终态 | run → `failed`，理由 `lead lost` |

幂等靠 `settle_seq` / `wake_seq` 两个单调计数器，不靠时间戳，也不靠内存里「我记得发过」。Host 重启后 reconcile Node，Lead idle 且 `settle_seq > wake_seq` → 恰好补一条。

### 6.1 信封

不伪造 session 事件。就是一条普通 prompt，用信封让 `SKILL.md` 认得出这是决策拍。Lead cwd 是 scratch，读不到 worker 磁盘。v1 不新增 Node git 命令。

产物取 `listEvents(sessionId)` 中 **`sequence > step.event_seq_from`** 的 `agent_text` 拼接。水位线不能省：`fleet_session_prompt` 会在同一个 session 上开新一轮，不带范围的话第二次 wake 会把上一轮的产物再灌一遍，白烧 wake 预算和上下文。**不用** `session.lastText`（只有 500 字），**不混** `agent_thought`。

超长时按 **头 60% + `[... N chars elided ...]` + 尾 40%** 截到 `maxOutputChars`，不做纯头部截断：失败场景（编译错误、测试失败、堆栈）里最有用的一段稳定落在尾部，砍掉尾巴等于把信封变成噪声。

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

完整日志按需 `fleet_transcript`。

**reviewer 怎么看见改动**：不靠信封，靠 §4 的 placement 钉死。review step 跑在与 implement step **同一台 Node 的同一个 localPath** 上，于是 reviewer 自己的 shell 就能 `git diff`——不需要跨 Node 传 artifact，也不需要新增 Node git 命令。把 diff 塞进信封是 isolation 那一刀之后的质量目标；v1 信封里只放产物文本，diff 由 reviewer 就地取。

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
  | { type: "stop_session"; sessionId: string; reason: string }
  | { type: "wake_lead"; runId: string; prompt: string }
  | { type: "aggregate"; summary: string }
  | { type: "finish_run"; state: RunState; reason: string };
```

`stop_session` 是超时、取消 run、以及 run 进终态时回收闲置 worker 的唯一出口——`stop`，不是 `cancel`。

Tick 触发：`handleEvent` 收到本 run session 的 `turn_complete` / `state`；session 终态；node 上线；REST（创建/批准/取消 run）；MCP 工具返回之后；**外加一个低频 deadline sweeper**。

最后这条不是打脸「不轮询」——那句话管的是 **Lead 不许空转烧 token**，不是 Host 不能有时钟。超时的本质是「什么都没发生」，没有时钟就永远没人来触发那个 tick，`stepTimeoutMs` / `staleAfterMs` 就是死代码，第一次 Node 掉电即永久 `running`。范式照抄 `apps/host/src/presence.ts`（`startPresenceMonitor` + `sweepInterval` + `timer.unref()`），新增 `startRunDeadlineMonitor`。deadline 全部可从 `run_steps.dispatched_at` / `updated_at` 重建，所以 Host 启动时补跑过期的即可，不需要持久化定时器。

`FleetService` 只暴露 `onSessionEvent`。引擎在 `server.ts` 注册。`FleetService` 不 import 编排器。

抽出 `createAndStartSession`（今天写在 `routes/sessions.ts`），供 REST、引擎、MCP 共用。

选点规则抄中文稿 §4.4，外加：**pin 只由「会写盘的 step」设置**，含义是「这个 task 的改动在哪」，不是「这只 orchestrator 只能在这」。命名了 `workspace` 就换地方；没命名就留在 pin 上（`implement` / `test` 的后续同样要看得见前面的改动，不只是 review）。同一 placement 上已有非终态的**写** step 时，v1 拒绝第二条写 step（结构化错误 `placement_busy`）。`review-*` / `explore` 只读，不受这条限制；`review-*` 且**必须**落在被 review 那个 step 的 placement 上。Lead 撞到 `placement_busy` 应结束本轮去睡，等 `awaiting_lead` 再派；不要靠短 `fleet_await` 把 Lead 卡在 running。不同 placement 不受这条限制。

把 pin 读成「每一步的硬约束」是实机上炸过的：一只 orchestrator 被第一条 explore 钉在了它最初碰到的 checkout 上，此后新加的 workspace **永远派不进去**，而 `explore` 这种只读工作根本没有理由去争那把写锁。除了「只有写盘的 step 才设 pin」，判定时还要**再问一次这个 run 到底写过没有**：没有任何写 step 的 run，它库里那个 pin 不是关于「改动在哪」的事实，直接忽略。这样规则自己就能纠正历史遗留的坏值，不需要一次性数据迁移。

选点这件事因此只有一份实现（`schedule.ts` 的 `decidePlacement`），工具与引擎共用——两边各写一份的时候它们已经漂了：工具回给模型一个路径，引擎再自己决定一次，可能落到另一个 checkout。工具选完把 `placementId` 写在 step 上，引擎照办，这才让那句回答是真的。

必须留一格 headroom。吃满 `maxSessions` 会撞 Node 侧 fatal `"Node is at capacity"`。

## 8. MCP 工具

HTTP MCP，per-session bearer，只发给 `run_role=lead`。token 由 Host 用一把落盘的密钥签出 `sessionId`，库里**不存 token 表**；撤销靠 session 自身的状态而非名单（理由与实机教训见 §16.2e，语义见 §16.3）。Facade 覆盖 `FleetService` + 引擎，不是第二套行为。浏览器继续走 REST（有 operator cookie 闸门）；Lead 不走 REST，因为那条路没有 run 记账。

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
  stepKey?: string,      // 同 key = 重试，复用同一行并 attempts++；省略则引擎生成
  reviewOf?: string,     // review-* 必填：被 review 的 stepId，引擎据此强制继承 placement
  placementId?: string,  // 提示；省略则引擎选（run 已钉则忽略）
  yolo?: boolean,
}): { stepId: string; sessionId: string; placementId: string; state: "accepted" }

// state 是 accepted，不是 running：此刻 step 处于 starting，Node 还没 ACK。
// 声称 running 会让 Lead 以为活已经在跑，而实际可能连命令都没发出去。

fleet_session_prompt({ runId, sessionId, prompt })  // 仅本 run；目标必须 idle
fleet_session_stop({ runId, sessionId })            // 仅本 run；引擎发 stop

fleet_finish({ runId, summary? })   // 有非终态 worker 时不拒绝：引擎先 stop 它们再收尾
fleet_escalate({ runId, reason })   // → awaiting_lead + Needs You，可恢复，不是终态

// 可选、同一 turn 内、上限 60s。Host 重启会掐断，不是叫醒机制。
fleet_await({ runId, sessionIds, until: "idle" | "terminal", timeoutSeconds })
```

启动 Lead：per-session MCP 走 ACP `session/new` 的 `mcpServers` 入参（`McpServerHttp` 带 `url` + `headers`，正好放 scoped token），不走 `--additional-mcp-config`，也不用 `~/.copilot/mcp-config.json` 退路——理由与核验见 §16.1。**`session/load` 也带 `mcpServers`，所以 resume 时必须重新供给**，否则被 auto-resume 的 Lead 会醒来却没有工具；供给方式是**当场重新签发**而不是把 token 存下来（§16.2e）。Custom agent markdown（`tools:` allowlist）是第二道闸门。编排政策写成 `SKILL.md`，即便第一只 Lead 是 Copilot。

预算耗尽、role 不符、`placement_busy`、无 headroom：工具返回结构化拒绝，模型应上报而不是盲重试。`fleet_session_prompt` 打到 busy 目标返回 `TargetSessionBusy`，`SKILL.md` 要教对应动作：要么 `fleet_session_stop` 中断，要么结束本轮去睡等下一次 settle——不许原地重试成死循环。

## 9. 协议与兼容

| 改动 | 风险 |
| --- | --- |
| `BrowserMessageSchema` 加 `run` / `run_steps` | 无（UI 与 Host 同部署） |
| `SessionSchema` 加 `runId` / `runRole`，`.default("")` | 无；Node 不消费 SessionSchema |
| 新 Run / RunStep / RunNote 类型 | 无；不进 Node wire union |
| `NodeCommandSchema` / `HostToNodeMessageSchema` | P0/P1 **不动**；P2 给 `start_session` 加可选 `model?` / `effort?` / `mode?` / `mcpServers?`（见 §16.1）。加可选成员对 Node 是兼容的，未知 `type` 才会 1008 关连接 |
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

### 10.1 Orchestration 是一个顶层视图，不是 workspace 里的一项

侧边栏第一行就是 **Orchestration**，在所有 workspace 之上，带一个「在飞的活」计数。它是**整个 fleet 的界面**——你要交代的那个会话，加上它撒在各台机器上的工作——所以把它塞进某个仓库下面既埋没了它，也暗示它属于那个仓库。

视图本身是**左边对话、右边 rail**：对话是真正在用的东西，rail 是它的上下文。点 rail 上的一步能进到那个 worker 的 transcript，但那不是默认动作——把 orchestrator 叫醒的那段摘要通常已经够了。

因此三条规则：

1. **`runRole !== ""` 的 session 全部不进 workspace 树**，orchestrator 也不进。它有自己的家了。
2. **过滤必须做两层**：`groupSessionsByWorkspace` 管树和网格的分组，`filterVisibleSessions` 管可见集合与自动选中。只做树那一层，操作员会看到「树里空的」+「一个 worker 的 transcript 和一个 Resume 按钮」——按下去就在 run 的记账之外重启了它。
3. **steps 不进 snapshot，走 `GET /api/runs`**。它们变化太频繁；但只靠实时广播也不行——**已完成的 run 永远不会再广播**，于是刷新后每个 run 都显示「0 steps」。

视觉稿：`docs/superpowers/design/2026-08-21-orchestration-ui.html`（OpenDesign 生成的高保真原型）。它是方向参考，不是像素合同。

原型里另外两个值得采纳的决定：

- **列表的过滤轴是「自己在跑 / 等你」**（`All · Autonomous · Needs you`），不是状态枚举。状态枚举是给引擎的，不是给人的。
- **run 行上直接显示占用了哪几台机器**，这是 placement 钉死的可见化。

### 10.2 P2：Lead session 长什么样

这一节此前是空的，而它有三个不写下来就会被实现踩错的地方。

**a) Lead 会自动混进 workspace 树里，必须挡掉。** 侧边栏是 `groupSessionsByWorkspace(sessions, nodes, workspaces, placements)`，按 workspace → node → session 铺开。Lead 是一只跑在 scratch placement 上的普通 session，所以**什么都不做的话，操作员的树里会多出一个叫「scratch」的 workspace**，里面躺着一只不该手动打扰的 session；worker 同理，会散落在业务 workspace 下面，和人自己开的 session 混在一起、无法分辨。

规则：`runRole !== ""` 的 session **不进 Agents 树**，只在 Runs 面板里出现。它们已经有归属了——归属是 run，不是 workspace。这条不需要新数据，`runId` / `runRole` 已经在 `SessionSchema` 上（§4）。

**过滤必须做两层，只做树那一层是坏的。** 真机验证时踩到：树按 `groupSessionsByWorkspace` 过滤后显示「No sessions」，而主面板的自动选中走的是另一条路（`filterVisibleSessions`），于是操作员看到的是「树里什么都没有」+「一个 worker 的 transcript 和一个 **Resume** 按钮」——按下去就会在 run 的记账之外把它重启。所以两处都要过滤：`groupSessionsByWorkspace` 管树和网格的分组，`filterVisibleSessions` 管可见集合与自动选中，后者保留「显式打开的那一个仍可见」，这样从 Runs 面板点进 step 仍然能看 transcript。

**b) Lead 的 transcript 要能读，但默认不该是入口。** Lead 的对话是一串 `<fleet-wake>` 信封和工具调用收据，对人的价值远低于 worker 的实际产出。所以 Runs 面板的主体是 **steps**，Lead 作为一行「Lead · {state}」放在 run 头部，点开才进 `TerminalView`。人想看它为什么这么派活时能看到，但不必每次都先穿过它。

打开之后的关键处理：**引擎写的和 Lead 写的必须在视觉上分开**。原型的做法是两种气泡——`ENGINE WAKE`（等宽、带时间戳、框起来的 `step_settled` 收据）对 `LEAD DECISION`（散文 + 下面一条 `dispatch(...)` 收据）。这样人是在读一条决策链，而不是一段自言自语。这一条不只是好看：§6.2 判空转看的就是「这一轮有没有工具收据」，UI 与引擎的判据因此对齐。

**c) 人怎么跟 Lead 说话。** §6.2 已经允许「人在 worker 飞行时跟 Lead 说话」，但没说走哪个入口。答案是**不新增入口**：点进 Lead 的 `TerminalView`，用现有的 `PromptRail`。Lead busy 时组合框照常被现有逻辑挡住（§6 的 `CommandRefused` 是给引擎的，不是给人的——人这一条走的是 UI 已有的忙碌态）。引擎那边的规则不变：Lead 闲下来时若有未叫醒的 settle，先冲 fleet-wake，再轮到人的话。

### 10.3 「Needs You」是新概念，不是现成的

正文多处（§4 policy、§6、§6.2、§8、§16.3）说「计入顶栏 Needs You」，但**顶栏今天没有这个东西**：`TopBar` 的三个 `Stat` 是 `nodes online` / `live sessions` / `permissions`，而 `permissions` 数的是 `waitingPermissions`（`App.tsx`），语义是「有 session 在等授权」。

要么把 `permissions` 泛化成 `needs you`（等授权 + `awaiting_lead` 且已停止自动叫醒的 run），要么并排加第四个 `Stat`。倾向前者：对操作员来说这两件事是同一个问题——**有东西卡住了，等你**——分成两个数字只会让人多看一眼。做法上是把 `waitingPermissions` 这个 memo 扩成一个 `needsAttention` 列表，`usePermissionAlerts` / `useSessionChimes` 都吃它，声音和跳转因此自动覆盖 run。

注意别把「run 处于 `awaiting_lead`」当成 Needs You：那只是正常的在途状态，引擎马上会叫醒 Lead。真正要人的是**引擎已经放弃自动推进**的那三种（两轮空转、`maxWakes` 耗尽、`fleet_escalate`），它们共用同一个出口（§16.3）。

## 11. 分期

| 阶段 | 内容 | 可验证 |
| --- | --- | --- |
| P0 引擎 | 表 + 状态机 + `planNextActions`（含 `wake_lead`、重启不误判） | 纯函数单测全绿，不碰网络 |
| P1 夹具 | `POST /plan` + 引擎接线 + Runs 面板（§10.1）+ `--mock-agent` | 两 mock node 上 `audit→fix→test`，Host 重启后续跑 |
| P2 MCP + Lead | MCP 门面、`createAndStartSession` 抽出、custom agent、`SKILL.md`、叫醒信封、Lead session UI（§10.2）+ Needs You（§10.3） | 一句 objective → Lead 派 worker → settle → 叫醒 → finish 或**在同一 placement 上**再派 reviewer |
| P3 | 失败重试、跨 node artifact、worktree 后的同仓库并行 / fan-out、Pi 作为 agent kind | — |

**P2 有开工闸门**：§16 三份合同（启动配置 / durable dispatch+wake / terminal+cleanup）**均已定案**，P2 可以照 §16 接线。

P0+P1 零 LLM，用来锁中文稿那些会在生产重启时才爆的不变量。P2 才把英文稿的判断接上。REST **不是**无鉴权（`request-guard.ts` 有 operator cookie 闸门 + host 名单 + origin 检查），但它是给人的接口：Lead 走 MCP，因为那里才有 run 记账和 per-session bearer。用 curl 打 REST 做 hours-scale 人工 spike 可以，那不是合同。

第一只 Lead 用 Copilot。Pi 作为 Host 旁路进程只适合 spike（看不见卡片）。真正要 Pi 时做成 agent kind + 先 probe `pi-acp`。不要通用 harness 抽象。不要让 Lead 改自己的限额；Pi 的自我改装在 orchestrator 角色上关闭。把 Lead 换成常驻式 agent 是 §17.1 的待办，不影响本文任何一条不变量。

## 12. P0 不变量（各对应一个真实坑）

1. 全员 `offline` 时不得 `settle_step` / `finish_run` / `wake_lead`。
2. step `running` 且无 `turn_complete` 时不得判成功。
3. 终态 step 的迟到事件：无视。
4. 剩余容量 0 或不留 headroom：不派发。
5. 同一 placement 已有非终态**写** step：第二条写 `start_step` 拒绝（v1）；只读 category 不受限。
6. `settle_seq > wake_seq` 且 Lead idle：恰好一条 `wake_lead`；两步同时 settle 且 Lead busy：coalesce 成一条。
7. Auto-resume 后 Lead idle、run 仍 `awaiting_lead`：补一条 wake。
8. 两轮空转：不再自动 wake，保持 `awaiting_lead`。
9. 派发 step 只产生一个 `start_session`，不附带 `prompt`。
10. 超时动作是 `stop` 不是 `cancel`。
11. step 先写 `starting` 再发命令；发送失败回 `pending`，ACK 前掉线由 deadline 判 `failed`。**任何时候都不得先发命令再写收据。**
12. run 钉了 `placement_id` 之后，后续 step 一律复用；Node 丢失时升级给人，**不换机重派**（换机 = reviewer 看一棵陈旧的树）。
13. run 进终态时，本 run 全部非终态 session 必须收到 `stop`；不留闲置 worker 占 `reservedSessionCount`。
14. 信封只取 `sequence > step.event_seq_from` 的 `agent_text`。

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
- `2026-08-18-orchestrator-harness-choice.md`：在 MCP 注入那一节加一条批注，指向本文 §16.1——`--additional-mcp-config` 不再是选定路线。

## 15. 已关闭的选择

| 问题 | 决定 |
| --- | --- |
| 谁调用 start | Lead 调 `fleet_session_start`；Host 写收据再派 |
| MCP 给谁、干什么 | 只给 Lead，只用于 Lead→Host 的 propose；叫醒是 Host→Lead 的普通 prompt，与 MCP 无关 |
| 计划是一次 DAG 还是逐步派 | Lead 主路径逐步派；手写 DAG 仅夹具 |
| 模型是否空转等待 | 否。短 await 可选；耐久叫醒靠 `awaiting_lead` |
| 何时叫醒 | `on_any_settle` + coalesce |
| 灌什么 | 有界 `<fleet-wake>` 信封，产物来自 `agent_text` |
| 空转 | 两圈后 Needs You，不自动 finish |
| 人工闸门 | 批准 objective，不批准每一次 spawn |
| 并发锁的轴 | **placement**（物理路径），不是 workspace；只读 category 不计入写锁 |
| 同一 placement 写并行 | v1 上限 1 |
| reviewer 怎么看见改动 | run 钉死 placement，reviewer 就地 `git diff`；不传 artifact |
| 派发原子性 | 收据先落地（`starting`），再发命令；工具返回 `accepted` |
| 幂等 | `settle_seq` / `wake_seq` 单调整数，不用时间戳 |
| 超时怎么触发 | 低频 deadline sweeper（照抄 `presence.ts`）；「不轮询」只约束 Lead |
| 失败默认 | 叫醒 Lead，不默认 fail-fast 整 run |
| Harness | Copilot 第一；MCP 合同；Pi 推迟。换成常驻式 agent 见 §17.1 |
| per-session MCP 怎么注入 | ACP `session/new` 的 `mcpServers`（原生、typed）；**不用** `--additional-mcp-config` |
| 模型怎么指定 | `session/new` 之后、首轮 prompt 之前 `set_config_option`；`session/new` 本身不收模型 |
| 记忆 | Host notes + 事件日志；不引进外部 memory |
| Lead 隔离强度 | 约定 + 审计，不是沙箱；真隔离留给专用 Node/身份 |

## 16. P2 的三份合同（均已定案）

评审留下的三个真空，均已在 2026-08-21 对着代码核实并定案。三份都不改 P0/P1 的形状——`starting`、placement 钉死、seq 计数器已经进了 P0 schema，剩下的都是 P2 的接线决定。

### 16.1 启动配置合同（**已定**）

2026-08-21 对着 `@agentclientprotocol/sdk@1.3` 的 `types.gen.d.ts` 核过，结论比原判乐观。

**ACP `session/new` 不接受模型。** 实际形状只有四个字段：

```ts
NewSessionRequest = { cwd, additionalDirectories?, mcpServers, _meta? }
```

模型不是入参，是**回参**：`NewSessionResponse.configOptions: SessionConfigOption[]`，随后用 `session/set_config_option({ sessionId, configId, value })` 改。而 `SessionConfigOptionCategory = "mode" | "model" | "model_config" | "thought_level" | string`——我们要的三个维度在枚举里都是**具名**的，不是自己发明的约定。

**但 `mcpServers` 就在 `session/new` 的入参里**，且 `McpServerHttp = { name, url, headers: HttpHeader[] }` 是 typed 的。所以 per-session MCP + scoped bearer 是原生能力，**不需要** `--additional-mcp-config` 那条 CLI flag 路线，也不需要 `~/.copilot/mcp-config.json` 退路和版本探测。今天 Node 把它写死成 `mcpServers: []`（`apps/node/src/agents.ts`），这是**未用的容量，不是缺失的功能**。这一条推翻 `2026-08-18-orchestrator-harness-choice.md` 里「flag 比 threading ACP `mcpServers` 更小」的判断：threading 就是 NodeCommand 加一个字段再传下去，端到端有类型，而 flag 是个要探测版本的 JSON 字符串。

**「没有窗口插配置」的顾虑是我上一轮读错了。** §12 不变量 9 禁止的是第二条 Host→Node 的 **`prompt` NodeCommand**，它不管 Node 内部在 `session/new` 与首个 `session/prompt` 之间做什么。而那个窗口确实存在，`apps/node/src/router.ts` 里是两步：

```ts
const agent = await this.factory.start(sessionId, cwd, sink, { yolo });  // session/new 在这里面
if (command.type === "start_session") void agent.prompt(command.prompt); // 首轮 prompt 在这之后
```

`recoverConfigOptions()`（`agents.ts`）已经在**恰好这个窗口**里发 `set_config_option` 了。所以配置有地方落，不变量 9 也不用动。

**裁决：选 (a)**，且成本比原先估的低。`NodeCommandSchema.start_session` 加四个可选字段 —— `model?` / `effort?` / `mode?` / `mcpServers?`；Node 把 `mcpServers` 直接交给 `session/new`，把 model/effort/mode 在首轮 prompt 之前用 `set_config_option` 施加。§9 的表因此改成「P0/P1 不动，P2 加可选成员」。

落地时四个必须处理的真实边角：

1. **模型 id 是 agent 按机器报的，不是我们定的。** category→model 只能对着**当轮返回的** `configOptions` 解析，请求的家族不在列表里就结构化失败，不能硬编码 id。
2. **`session/new` 有时不返回 `configOptions`。** 这不是假设：`agents.ts` 里已有注释记录了本 fleet 一台真机上的这个行为，`recoverConfigOptions` 就是为它写的。所以顺序必须是 recover → set → 仍拿不到就**让这一步结构化失败**，不许静默跑在默认模型上——`review-deep` 的全部价值就是「换一个模型家族」，静默降级等于这次 review 白做。
3. **`LoadSessionRequest` 同样带 `mcpServers`，resume 必须重新供给。** 这条三份 review 都没提到，但它直接打在 §6 上：Lead 被 auto-resume 后如果没重新挂上 fleet MCP，就会被叫醒却**无工具可调**，正好落进 §6.2 的空转计数，两轮之后 run 停在 Needs You——症状离病因很远。供给方式见 §16.2e：token 是签出来的，所以重新供给只是把同一份配置再递一次，不需要任何持久化的票据。
4. **MCP 的地址由 Node 定，不由 Host 猜。** Host 必须往命令里填一个地址，但它无从知道这个地址在那台机器上通不通：可能有 tunnel、可能是内网 IP、可能是 loopback，每个 Node 的答案还不一样。Host 原本复用 enrollment 那套解析，而那套**优先选公网 tunnel**——于是同机的 agent 会被指着绕一圈公网，去连一个它本地就能碰到的端口。Node 这边没有这个问题：它此刻就连在 `settings.hostUrl` 上，这是唯一被证明可达的地址。所以约定是 **Host 只负责给出路径，Node 把它接到自己那条连接上**（`resolveMcpServers`）。

### 16.2 durable dispatch + wake 合同（**已定**）

`starting` 中间态已在 §5。其余五点按现有机制定死，不新增基础设施：

**a) `commandId` 不落库。** 今天它在 `dispatch()` 里 `randomUUID()` 生成后即丢弃，`command_result` 只在 `!ok` 时记日志（`gateway/node-socket.ts`）。有人会想「重启后要认领迟到的 `command_result`」——不需要，因为**已经有一个更强的事实源**：Node 在每次 hello **和每次 heartbeat** 都上报 `activeSessionIds`，`FleetService.reconcile(nodeId, activeSessionIds, busySessionIds)` 就是权威对账。`starting` 窗口要回答的唯一问题是「这个 session 到底起来没有」，而 inventory 直接回答它，比事后匹配一个陈旧的 commandId 可靠得多。加相关表是给自己造第二个真相源。

**b) 步骤状态机对齐 session 状态机，不发明新词。** `sessionStates` 已经是 `queued | starting | running | idle | cancelling | offline | stopped | completed | failed`——**`starting` 早就在里面**，而且是为同一个理由存在的：命令发了，还没被确认。所以 step 的 `starting` 不是新概念，是把既有词汇用在第二层。评审时不必再论证它该不该存在。

**c) 收据先落地已经是本仓的既定写法，照抄即可。** `routes/sessions.ts` 是 `createSession` → `publishSession` → `dispatch` → 未送出则 503；而 `dispatch(nodeId, request, fallback)` 的第三个参数**本身就是补偿路径**（送不出去时把 session 打成 `fallback.state` 并广播）。step 只需要同款：写 `starting` → `dispatch` → `sent === false` 就回 `pending`。

**d) `startingTimeoutMs` 与 `stepTimeoutMs` 是两个量级，必须分开。** 前者约束「发帧 + Node 拉起 Copilot + `session/new`」，秒到分钟级；后者是一小时级的干活时长。用后者兜前者，等于一个从没起来的 step 要占着 placement 写锁一小时。默认给 `startingTimeoutMs: 120_000`，且只在**节点在线**时判死——节点 offline 时 `starting` 保持不动（offline = 未知）。

**e) Lead 的 MCP token 是签出来的，不是记下来的。** §16.1 指出 `session/load` 也要 `mcpServers`，但结论既不是「把 bearer 存起来」，也不是最初写的「resume 时重新签发」——后者已被实机推翻，改成现在这样：

token = `flt_<base64url(sessionId)>.<HMAC-SHA256>`，签名密钥落在 settings 里（`orchestrator.tokenKey`）。校验只做验签，Host 不持有任何 token 列表。

原来那版把 hash 记在内存 Map 里，实机上直接炸了，值得写下来：**一只被 Node 养着的 orchestrator 永远不会 settle**，所以既不会被 auto-resume（那条路只捞 `failed`），也就永远等不到「resume 时重新签发」。Host 一重启，Map 空了，agent 还拿着那张旧票——每一次工具调用 401，而 Copilot 端的表现是**那台 MCP server 整个从工具列表里消失**，症状是「`fleet_start_work` 不可用」，离病因隔了三层。开发时跑 `tsx watch`，等于每存一次盘就废掉一只 orchestrator。

签名没有这个寿命问题：密钥落了盘，重启什么都不改变，也没有一张会跟 session 走散的表。**撤销于是从「表里有没有」变成「这只 session 还算不算数」**：验签只回答「这是谁」，随后必须再查该 session 存在、`run_role=lead`、且非终态。停掉一只 orchestrator，它的工具下一次调用就没了——这是这里唯一需要的撤销。

wake 的重启恢复不需要新东西：`settle_seq > wake_seq` 且 Lead idle 就补一条，这本来就是纯函数的输入。需要的是一条明确的 boot 路径测试，见 P0 计划。

### 16.3 terminal + cleanup 合同（**已定**）

- **`fleet_finish` 遇活跃 worker**：先 `stop` 再收尾（§3.3、不变量 13），不拒绝。Lead 不该为了收尾去逐个关 worker。
- **`fleet_escalate`**：run 停在 `awaiting_lead` + UI Needs You，**不是终态**。人可以补一句话继续（走既有的对 Lead 发 prompt 的路径），也可以取消整个 run。它和「两轮空转」「`maxWakes` 耗尽」共用同一个出口，UI 只需要一种「等人」的呈现。
- **`cancel`**：立即终态。级联 `stop` 本 run 全部非终态 session（含 Lead），steps 打 `cancelled`。
- **settle 即回收**：step 一进终态，它那只 worker 立刻 `stop`。原稿把回收挂在「run 进终态」上，对一次性的批处理 run 成立，对常驻 orchestrator 不成立——它的 run 永远不结束，于是 `idle` 的 worker 一直占着 slot（`idle` 是「等下一轮」，不是「干完了」），三条 explore 之后整个节点就满了，报的还是「节点满」这种离病因很远的话。transcript 在库里，`stop` 不会让 `fleet_transcript` 少读到任何东西。
  - **判据是状态，不是那一次跃迁。** 只在「settle 的那一刻」回收是不够的：step 一旦终态，后面每一轮都会跳过它，于是任何错过那一刻的 worker——Host 在 settle 和 stop 之间重启、`stop` 没送到节点、以及这条规则上线之前就已经结束的那些——都会永远占着槽。对着状态问，重复发 `stop` 无害，漏发才有害。节点 offline 时不发（offline = 未知）。
  - 连带结论：**step 终态之后不能再 follow-up**。原本这条路会回一句「完成后会叫醒你」，但那一轮已经没有任何 step 在跟踪，永远不会 settle、也永远不会有 wake。要接着做就是新开一步——它会落在同一个 checkout 上。
- **删 run**：先 `stop` 后删，无 `ON DELETE CASCADE`（§4），顺序是 sessions → run_steps / run_notes → run。
- **Lead token**：不设过期，因为它本来就不是一张要维护的票。每次调用都要求该 session 存在、`run_role=lead` 且非终态——run 一结束、orchestrator 一被停掉，同一个 token 就什么也打不开。签发方式与它为何不能记在内存里，见 §16.2e。
- **backup/restore**：`HostBackupSchema` 是显式数组（nodes/workspaces/placements/sessions/events），所以要加 `runs` / `runSteps` / `runNotes` 三个数组，**全部 `.default([])`**，否则旧备份文件直接解析失败（`runNotes` 随 notes 一起在 P2 加）。`sessions` 走 `HostBackupSessionSchema = SessionSchema.extend({position})`，`runId` / `runRole` 带默认值即自动跟随。导入时 `sessionFieldsForHostImport` 会把非终态 session 压成 `offline`，所以**导入后的 run 也必须被压成不在飞的状态**：`running` / `awaiting_lead` 一律落到 `awaiting_lead` + Needs You，`starting` / `running` 的 step 落到 `failed`。否则那个 run 会以为自己还有 worker 在跑，而所有 session 都是 offline——永远不会有东西来 settle 它，也没有活节点来 tick 它。

### 16.4 明确不在 v1 解决

Lead 因模型故障 / OOM 被强杀时 run 直接 `failed`（理由 `lead lost`）。可以接受，但**不要把它做成不可逆的形状**：将来要能在同一个 run 上重挂一只新 Lead，所以 schema 与 UI 都别假设 `lead_session_id` 只写一次。

## 17. 任务阶段：由 Orchestrator 推进（**已实现**）

一次请求变成一个 **task**（= run），task 带一串**它自己命名的 phase**。不是固定的 plan/exe/review/done——几个、叫什么，是规划的一部分：一次改动配 plan/implement/review，一个问题配一个 phase 加一次签收。写死成枚举，等于逼它为了凑形状去编没有活的阶段。

推进的主体是 **Orchestrator，不是人**：

```
人提一句 → fleet_plan_task 开任务并定阶段
         → fleet_start_work 派本阶段的活 → 结束这一轮
         → worker settle → 叫醒 → 它读产物并判断
             ├ 够了 → fleet_advance_task 进下一阶段
             └ 不够 → 继续派活（同一个判断，反过来做）
         → 最后一个阶段完 → fleet_submit_task → run 进 awaiting_human
人只在这里出现：Approve → completed；Send back → 带上原话回到 running
```

要点：

- **`advance` 有活在跑就拒绝。** 没看到结果的阶段没法判，这不是保守而是定义。
- **退回的话原样成为一轮 `<fleet-review>`。** 从第一轮起 orchestrator 就把 `<fleet-...>` 当成「要照做的事实」，一句白话的人类留言会被它当成「可以讨论的意见」。形状本身在传达语气。
- **`awaiting_human` 不是终态。** 退回要能回到 running 接着做，而不是重开一个 task 丢掉全部上下文。
- **`awaiting_human` 期间只停派发与叫醒，不停结算。** 早期写法是整个 `planNextActions` 直接 return——那样这段时间内 settle 的 step 永远不会被关掉，它那只 worker 就按人类看多久占多久槽。结算和回收是「已经发生的事」的记账，跟等不等人无关。
- **phase 记在 step 上**（`run_steps.phase_index`），因为阶段会往前走，而「这一步当时属于哪个阶段」不该跟着变。
- **`run_notes`**：每次 advance / submit 落一条它自己写的话。最后交付时人读的是这串短句，而不是去拼十几个 worker 的 transcript。

## 18. Future work
> 待办清单，不是设计。这里的条目**尚未研究**，写下来只是为了不丢，也为了让 v1 的形状别把它们挡死。开工前每一条都要单独出稿。

### 18.1 把 Lead 从 vanilla Copilot 换成 Sisyphus 式常驻 agent

今天的 Lead 是一只普通 Copilot session，靠 `SKILL.md` + custom agent allowlist 约束（§8）。想要的方向是 `oh-my-openagent` 那类 **Sisyphus agent**：有自己的循环、自己的记忆、自己的重试观，而不是每次被 prompt 叫醒后从散文里重新推断处境。

为什么现在不做：v1 的价值在于**确定性机械层**（收据、叫醒、不变量），而机械层对 Lead 是什么完全无所谓——这正是 §2 propose/dispose 那一刀的意义。先把机械层锁死，Lead 的形态才可以随便换。

已经为它留好的门（不需要重新设计）：

- **MCP 是合同，不是实现**（§8）。任何能说 MCP 的 harness 都能当 Lead。
- **叫醒是普通 prompt**（§2.1、§6）。不依赖 Copilot 的任何特性。
- **`run_role=lead` 是唯一闸门**（§4）。换 harness 不动权限模型。
- **`agent kind` 已经是设想中的扩展点**（§11 P3、§13「不要通用多 harness 抽象」）。这一条是说不要**预先**抽象，不是说不能有第二种。

真要做时才需要回答的问题（现在不答）：

1. Sisyphus 自带循环，与 Host 的 `awaiting_lead` 叫醒**谁是主循环**？两个循环叠在一起是 §3.2 禁止 `fleet_await` 空转的同一类问题的升级版。
2. 它自己的记忆与 Host 的 `run_notes` + 事件日志（§15「记忆」那一行）如何划界，才不会出现两份互相矛盾的进度。
3. 自我改装（self-modification）在编排者角色上**必须关闭**——§11 已经就 Pi 写下这条，对 Sisyphus 同样适用：Lead 不得改自己的硬限额。
4. 它若不是 ACP agent，`start_session` / `session/new` 这条链就不适用，那 §16.1 的启动配置合同要重签一份。

### 18.2 其他已知但未排期

散落在正文里，集中列一下以便检索：跨 node artifact 与 worktree 后的同仓库并行 / fan-out（§11 P3）、失败重试（P3）、Lead lost 后在原 run 上重挂新 Lead（§16.4）、Lead 的真隔离（专用 Node + 独立执行身份，§3.1）。
