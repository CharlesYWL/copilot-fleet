# Copilot Fleet Orchestrator — 设计方案

> 状态：提案（待评审）。目标形态：**Lead/Worker 编排**，大脑放在 **Host 侧确定性引擎**，LLM 只负责「生成计划」和「汇总结论」。

## 1. 现状盘点：我们已经有什么

先说结论：**编排器的 v1 几乎不需要动 Node 和 Node↔Host 协议。** 现有代码已经把最难的部分做完了。

| 编排器需要的能力         | 现有实现                                                              | 位置                                    |
| ------------------------ | --------------------------------------------------------------------- | --------------------------------------- |
| 起一个 agent 进程        | `start_session` 命令 + `AcpAgentFactory`                              | `apps/node/src/agents.ts`               |
| 追加一轮对话             | `POST /api/sessions/:id/prompt`                                       | `apps/host/src/routes/sessions.ts:107`  |
| **知道一轮跑完了**       | `turn_complete` 事件 + `state` 事件转 `idle`                          | `agents.ts:269,546,552`                 |
| 拿到 agent 的输出        | `events` 表（有序、可重放）+ `session.lastText`                       | `store.ts`                              |
| 容量/调度约束            | `reservedSessionCount()` + `node.maxSessions`                         | `apps/host/src/session-policy.ts:42`    |
| 工作目录解析             | Placement `(workspace, node) -> localPath`                            | `store.ts` / `PlacementSchema`          |
| 崩溃恢复                 | SQLite 持久化 + `reconcileOfflineSessions()`                          | `store.ts`, `fleet-service.ts:253`      |
| 事件总线（所有事件汇流） | `FleetService.handleEvent()`                                          | `apps/host/src/fleet-service.ts:283`    |

所以编排器 = **Host 侧的一层新状态机**，订阅 `handleEvent`，按 DAG 依赖去调用「创建 session / 发 prompt」。

### 1.1 三个必须尊重的现有约束

1. **协议没有版本号，兼容性全靠 capability 字符串。**
   `NodeToHostMessageSchema` / `HostToNodeMessageSchema` / `NodeCommandSchema` 都是 `z.discriminatedUnion`，两端各自校验，遇到不认识的 `type` 直接 `close(1008)`。
   → **给 `NodeCommandSchema` 加成员会踢掉所有旧 Node。** v1 因此坚决不加。
   → `BrowserMessageSchema` 可以自由加：UI 由 Host 静态托管，同一个部署单元，不存在版本漂移。

2. **迁移机制是 `addColumnIfMissing`，没有 version 表。**
   加表用 `CREATE TABLE IF NOT EXISTS`，加列用 `addColumnIfMissing(table, column, "TYPE NOT NULL DEFAULT ...")`。新方案照此办理，不引入迁移框架。

3. **`ARCHITECTURE.md` 目前把 "Agent-to-agent DAGs" 列为 non-goal。**
   本方案是对该条目的正式修订，落地时需同步改 `ARCHITECTURE.md` 和 `PRODUCT.md`，否则文档会和代码打架。

---

## 2. 核心设计

### 2.1 职责切分（这是整个方案的关键决策）

```text
        ┌──────────────── Host ────────────────┐
        │                                       │
 Lead Session ──plan(JSON)──▶ OrchestratorEngine ──▶ Worker Session A
 (一个普通的                  （确定性、无 LLM、    ├─▶ Worker Session B
  Copilot session）            纯函数 + SQLite）    └─▶ Worker Session C
        ▲                             │
        └────── 汇总 prompt ◀─────────┘
```

- **Lead 只做两件事**：把目标拆成结构化计划；最后把各 worker 的产出汇总成结论。它**不直接创建 session**，不持有控制面权限。
- **Engine 做全部调度**：拓扑排序、容量选点、派发、超时、失败传播、重放。全是确定性代码，可单测、可重放、Host 重启后可恢复。
- **Worker 就是普通 session**：在现有 UI 里照常显示、照常可以人工介入（发 prompt、cancel、批权限）。

**为什么 Lead 不自己派生 session？** 因为那要求给 agent 开放控制面 API，且 Host 重启后无人知道它派生到哪一步了。计划变成数据落库，编排才可重放——这正是「Host 侧确定性引擎」的价值。

### 2.2 Lead 如何输出计划：不加协议，用结构化文本块

Lead session 被要求在回复里输出一个 fenced block：

````text
```fleet-plan
{
  "steps": [
    { "id": "audit",  "title": "审计 auth 模块",  "prompt": "...", "dependsOn": [] },
    { "id": "fix",    "title": "修复发现的问题",  "prompt": "...", "dependsOn": ["audit"] },
    { "id": "test",   "title": "补测试",          "prompt": "...", "dependsOn": ["fix"] }
  ]
}
```
````

Host 从该 session 的 `agent_text` 事件里提取并用 zod 校验。

- **好处**：零协议改动，任何 Copilot 版本都能用，mock-agent 也能跑通测试。
- **代价**：依赖模型遵守格式。对策：校验失败时自动回一条「格式错误 + 具体 zod 报错」的 prompt 让它重试，上限 2 次，仍失败则整个 run 转 `failed` 并把原文留给人看。
- **后续可选**：Phase 3 可换成 MCP tool call，届时再走 capability gate。

### 2.3 上下文如何跨 step 传递

v1 用**文本注入**：worker 启动时的 prompt 由 Engine 拼装：

```text
<Engine 注入的依赖产出>
## 上游 "audit" 的结论
{截断到 N KB 的 audit session 最终输出}

<Lead 写的 step.prompt>
```

- 同 workspace + 同 node 的 worker 共享文件系统，天然可以用文件传递大产物；prompt 里只放摘要和文件路径。
- 跨 node 的大产物传递属于 Phase 3（需要 artifact 存储），v1 明确不做，调度器会**优先把有依赖关系的 step 排到同一个 node**。

**产物从哪里取？** 不能用 `session.lastText` —— 它被 `appendEvent` 截成**最后 500 字符**，只够渲染卡片预览。正确做法是 `listEvents(sessionId)` 取该 session 的 `agent_text` 事件，按 sequence 拼接出本轮完整输出，再按 `maxOutputChars` 截断存进 `run_steps.output`。注意 `agent_thought` 是思考链，**不要**混进产物。

### 2.4 权限与无人值守

编排跑起来最容易卡死的地方是：worker 弹了一个权限请求，没人点，turn 永远不结束。

- 编排 run 默认 `yolo: true`（需要 Node 具备 `host-yolo` capability，`yoloUnsupportedReason()` 已有检查）。
- **非 yolo 模式下不需要 Host 做超时** —— `AcpAgent` 自带 `permissionTimeoutMs` 定时器，到点**自动 deny**（`agents.ts:391-397`）并发 `permission_result` 事件，turn 随之结束。这是 Node 侧设置（`settings.permissionTimeoutMs`），**不是 run 级配置**，Host 改不了它。
- 所以编排器对权限**什么都不用做**：要么 yolo 直通，要么等 Node 自己 deny 掉，turn 一定会结束。这也意味着 run 的 `stepTimeoutMs` 应当明显长于 Node 的 `permissionTimeoutMs`，否则会在 Node 正常兜底之前抢先把 step 判死。
- UI 顶栏的「waiting permissions」对编排 session 同样生效，人可以随时接管。

---

## 3. 数据模型

### 3.1 新表（`apps/host/src/store.ts`，沿用 `CREATE TABLE IF NOT EXISTS`）

```sql
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  state TEXT NOT NULL,              -- planning|awaiting_approval|running|aggregating|completed|failed|cancelled
  lead_session_id TEXT,             -- 无 FK：session 被 dismiss 后 run 历史仍要可读
  policy TEXT NOT NULL,             -- JSON: {maxParallel, yolo, onStepFailure, maxReplans, ...}
  failure_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 注意：不用 ON DELETE CASCADE。全库没有一处用它，删除一律在 transaction()
-- 里手工按序进行（见 deleteWorkspace/deleteNode）。这里也必须手工删，因为删 run
-- 之前得先 stop 掉还活着的 worker session——cascade 做不到这件事。
CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  step_key TEXT NOT NULL,           -- lead 起的 "audit"，用于 dependsOn 引用
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  depends_on TEXT NOT NULL,         -- JSON string[] of step_key
  state TEXT NOT NULL,              -- pending|running|succeeded|failed|skipped|cancelled
  session_id TEXT,                  -- 派发后回填
  placement_id TEXT,                -- 调度器选定后回填
  output TEXT NOT NULL DEFAULT '',  -- 截断后的最终输出，供下游注入
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

### 3.2 给 `sessions` 加两列（`addColumnIfMissing`）

```ts
this.addColumnIfMissing("sessions", "run_id", "TEXT NOT NULL DEFAULT ''");
this.addColumnIfMissing("sessions", "run_role", "TEXT NOT NULL DEFAULT ''"); // ''|lead|worker
```

`SessionSchema` 对应加 `runId: z.string().default("")` 和 `runRole: z.string().default("")`。
有默认值 ⇒ 旧数据、旧前端都不炸；Node 不消费 `SessionSchema`，无影响。

**为什么把 run 归属放在 session 上而不只放在 run_steps 上？** 因为 UI 的 session 卡片、侧边栏树、告警都是以 session 为中心遍历的，反查 `run_steps` 会让每个渲染点都多一次 join。

### 3.3 必须遵守的 store 既有约定

新代码要和 `store.ts` 现有风格一致，否则会踩到几个真实的坑：

- **`transaction()` 不可重入。** 它是裸的 `BEGIN IMMEDIATE`，嵌套调用直接报错。现有代码（`deleteWorkspace`、`deleteNode`）的做法是：公开方法开事务，内部调用**非事务版私有 helper**。编排器的 `cancelRun`/`deleteRun` 要级联改多张表，必须照此拆分。
- **所有查询走 `this.statement(sql)`**，它带 prepared-statement 缓存；不要直接 `db.prepare()`。
- **行 → 领域对象一律经 zod `parse()`**，在文件底部按 `runFromRow(row)` / `runStepFromRow(row)` 的既有 mapper 模式写。`depends_on` 这类 JSON 列用现成的 `parseJsonList` 辅助。
- **时间戳一律 ISO 字符串**（`new Date().toISOString()`），**id 一律 `randomUUID()`**。
- 状态过滤复用现有的 `terminalStateList` / `settledStateList` 常量 + `placeholders()` 拼 `NOT IN (?,?,…)`，不要另起一套。

### 3.4 状态机

```text
Run:   planning ─▶ awaiting_approval ─▶ running ─▶ aggregating ─▶ completed
          │                │               │            │
          └────────────────┴───────────────┴────────────┴──▶ failed | cancelled

Step:  pending ─▶ running ─▶ succeeded
          │          │
          │          └─▶ failed ─▶(policy: continue)─▶ 下游 skipped
          └─▶ skipped | cancelled
```

沿用现有 `canTransition()` 的写法，为 run/step 各写一张转移表 + 纯函数校验。

### 3.5 Host 重启：引擎必须晚于 Node 重连才能判断

`FleetStore` 构造完成后，`server.ts:62` 会立刻调用 `store.resetConnectivity()`，它把**所有非终态 session 一律打成 `offline`**，活动写成 "Host restarted"。此时数据库里没有任何信息能区分「agent 还在跑」和「agent 已经死了」——`ARCHITECTURE.md` 专门解释过，Host 无权猜测，只能等 Node 重连时用 hello/heartbeat 里的 `activeSessionIds` / `busySessionIds` 来还原（`reconcileOfflineSessions()`）。

对编排器的直接后果：

- **引擎绝不能在 boot 时扫一遍 run 就下结论。** 那时候每个 worker session 都是 `offline`，任何「按 session 状态重判 step」的逻辑都会把还在跑的 step 误判成失败。
- 正确做法：boot 时只做一件事——把 `running` 的 run 标记为**待重连确认**，然后什么都不做。真正的重判发生在 `reconcileOfflineSessions()` 之后，由它返回的 session 列表驱动一次 tick。
- 因此 `planNextActions()` 必须把 `offline` 视作**「未知，继续等」**，而不是失败。这也顺带让心跳丢失、Node 短暂掉线这些情况自动走同一条路径。
- 兜底：run 上记一个 `staleAfter` 时间；重连迟迟不来的话，超时才把 step 判失败。这个超时应当明显长于心跳超时（`HEARTBEAT_TIMEOUT_MS`，默认 15s）。

这一条是整个方案里最容易写错、且错了以后只在生产重启时才暴露的地方，实现时应当有专门的单测：**「Host 重启 → 所有 session offline → 引擎不得产生任何 settle_step/finish_run action」**。

---

## 4. 引擎设计（确定性核心）

### 4.1 纯函数 + 薄壳

把调度逻辑写成**无副作用的纯函数**，这样它可以脱离 SQLite、WebSocket、Node 被完整单测：

```ts
// apps/host/src/orchestrator/schedule.ts
export type ScheduleInput = {
  run: Run;
  steps: readonly RunStep[];
  sessions: readonly FleetSession[];
  nodes: readonly FleetNode[];
  placements: readonly Placement[];
};

export type ScheduleAction =
  | { type: "start_step"; stepId: string; placementId: string; prompt: string }
  | { type: "settle_step"; stepId: string; state: RunStepState; output: string }
  | { type: "skip_step"; stepId: string; reason: string }
  | { type: "aggregate"; summary: string }
  | { type: "finish_run"; state: RunState; reason: string };

/** 给定当前世界的快照，下一步该做什么。同样的输入永远得到同样的输出。 */
export function planNextActions(input: ScheduleInput): ScheduleAction[];
```

外层 `OrchestratorEngine` 只负责：读快照 → `planNextActions` → 逐个执行 action（写库 + 派发命令 + 广播）。

### 4.2 触发时机（tick）

引擎在这些时刻跑一次 tick，**不做轮询**：

- `FleetService.handleEvent()` 收到 `turn_complete` 或 `state` 事件，且该 session 属于某个 run；
- session 转入终态（`stopped`/`completed`/`failed`）——可能腾出容量，唤醒别的 run；
- node 上线 / 心跳恢复容量；
- REST 显式操作（创建 run、批准计划、取消 run）。

为避免依赖倒置，`FleetService` 只暴露一个监听器数组：

```ts
// fleet-service.ts
private readonly sessionListeners: ((s: FleetSession, e: SessionEvent) => void)[] = [];
onSessionEvent(fn): void
```

引擎在 `server.ts` 里注册。`FleetService` 不 import 编排器，方向保持单向。

### 4.3 step 完成只能由事件判定，绝不能由命令回执判定

这是实现时最容易写错的一条，且错了以后表现为「编排跑飞」而不是报错。

`CommandRouter.execute` 的 `prompt` 分支是 **fire-and-forget**：

```ts
void agent.prompt(command.prompt, command.attachments).catch(() => undefined);
// 立刻返回 ok
```

也就是说 **`command_result{ok:true}` 只代表「命令收到了」，不代表这一轮跑完了**。同理 `start_session` 在 `factory.start` 之后会**自动发出第一条 prompt**（`router.ts:198-202`），回执同样是提前返回的。

引擎因此必须遵守：

- **派发只看 `ok:false`**（判失败）；`ok:true` 只用来把 step 从 `pending` 推进到 `running`，**不能**当成完成。
- **完成的唯一判据是事件**：`turn_complete` 到达，且随后 session `state` 转 `idle`。
- **不要给 worker 发第二条 prompt 去「催」**。busy 的 agent 会 `CommandRefused` 而不是排队（`router.ts:121`），Node 上没有任何队列。

另外两条来自 Node 自治行为的推论：

- `start_session` 自带首轮 prompt，所以引擎派 step 时**只发 `start_session`，不要再补一条 `prompt`** —— 否则第二条必被拒。
- prompt 失败时 `AcpAgent` 会**自行 `stop()`**（`agents.ts:276`）杀掉进程并发终态事件。引擎不用额外清理，但要能接住「没发 stop 却收到 stopped」这件事。

### 4.4 选点（placement 选择）

```text
候选 = 该 workspace 的所有 placement
  ├ 过滤：node.online
  ├ 过滤：reservedSessionCount(node) < node.maxSessions
  ├ 过滤：run.policy.yolo 时要求 node 具备 host-yolo capability
  ├ 加权：与已完成的上游 step 同 node → +大权重（文件系统共享）
  └ 排序：剩余容量多的优先；平票按 placement.position 稳定排序
```

拿不到候选就**不派发、不报错**，step 留在 `pending`，等下一次 tick。这利用了现有 `reservedSessionCount` 的语义：非终态 session 都占坑。

**必须留一格余量。** Node 侧 `CommandRouter.startSession` 会**再查一次容量**，超了就抛 `"Node is at capacity"` —— 而这是个 **fatal 错误**（不是 `CommandRefused`），会被 `failFromCommandResult()` 直接把 session 判 `failed`。Host 的 `reservedSessionCount` 和 Node 的 `slots.size` 之间存在窗口（比如人工同时在建 session），所以引擎选点时应当留一格 headroom，而不是把 `maxSessions` 吃满。真撞上了也不算灾难——step 判失败后可重试——但那是本可避免的噪声。

### 4.5 必须防住的失控

| 风险               | 对策                                                             |
| ------------------ | ---------------------------------------------------------------- |
| 计划里有环         | 接收计划时做拓扑排序，有环直接拒绝，报出环上的 step_key          |
| 无限 fan-out       | `maxSteps`（默认 20）、`maxParallel`（默认 3）、`maxReplans`（默认 1） |
| 依赖引用不存在     | 校验 `dependsOn` ⊆ `step_key` 集合                               |
| 一个 step 卡死     | `stepTimeoutMs`，超时 → `stop`（**不是 `cancel`**，见下）→ step `failed` |
| 占满整个 fleet     | 全局 `orchestrator.maxConcurrentSteps` 设置项，给人工 session 留余量 |
| Host 重启          | **不能在 boot 时 reconcile**，见 §3.5；要等 Node 重连后由事件驱动重判 |
| run 删了 session 还在 | 取消 run 时对所有非终态 worker 发 `stop`                          |

### 4.6 超时用 `stop` 而不是 `cancel`

`cancel` 的语义是「中止当前 turn，进程留着，回到 `idle`」——`ARCHITECTURE.md` 明确写了它**不是终态**。对编排器来说这有两个后果：

1. `cancel` 后 session 回到 `idle`，仍然**占着 `reservedSessionCount` 的坑**（只有终态才释放），卡死的 step 会永久吃掉一个并发额度。
2. `cancel` 之后 ACP 仍可能继续推送 update，直到 prompt 返回最终 stopReason；引擎若此时已判 `failed`，会收到属于一个「已死」step 的后续事件。

所以超时和取消 run 一律发 `stop`（终态、释放容量）。`cancel` 只保留给**人工介入**——操作员想打断某个 worker 的当前 turn 再手动接管，这条路径照常可用。

引擎还必须容忍「step 判死之后仍有事件到达」：`planNextActions()` 对已处于终态的 step 收到事件时应当**无视**，而不是报错或重复 settle。

---

## 5. 对外接口

### 5.1 REST（`apps/host/src/routes/runs.ts`，新文件）

```text
GET    /api/runs                    列表
POST   /api/runs                    创建 run（objective + workspaceId + policy）
GET    /api/runs/:id                run + steps 详情
POST   /api/runs/:id/plan           直接提交计划（跳过 lead，给 Phase 1 和测试用）
POST   /api/runs/:id/approve        批准 lead 生成的计划，进入 running
POST   /api/runs/:id/cancel         取消整个 run（级联 stop worker）
DELETE /api/runs/:id                删除历史
```

### 5.2 Browser 消息（加到 `BrowserMessageSchema`，安全）

```ts
{ type: "run", run: RunSchema }
{ type: "run_steps", runId: string, steps: RunStepSchema[] }
```

### 5.3 协议改动清单（对照既有兼容性契约）

`@fleet/protocol` 没有版本号，兼容性靠 capability + `.default()` 两件事撑着。本方案的改动逐条对照：

| 改动                                          | 风险 | 说明                                                        |
| --------------------------------------------- | ---- | ----------------------------------------------------------- |
| `BrowserMessageSchema` 加 `run` / `run_steps`  | 无   | 前端资产随 Host 一起发布，不存在版本漂移                     |
| `SessionSchema` 加 `runId` / `runRole`         | 无   | 必须带 `.default("")`；Node 根本不消费 `SessionSchema`       |
| 新增 `RunSchema` / `RunStepSchema` 等类型      | 无   | 纯新增，不进任何 wire union                                  |
| **`NodeCommandSchema`**                        | —    | **不动**。派 worker 完全复用 `start_session` / `prompt`      |
| **`HostToNodeMessageSchema`**                  | —    | **不动**                                                     |
| **新增 SessionEvent 类型**                     | —    | **不做**，见下                                               |

**为什么不加 `orchestrator` 类的 SessionEvent 类型？** 加一个新 event type 要同时改 `SessionEventSchema` 的 `z.enum` 和 `sessionEventPayloadSchemas`（两者必须同步，否则 `SessionEventPayload<T>` 查找类型会崩），而且事件是 **Node 产生的** —— 编排事件由 Host 产生，塞进 session 事件流等于伪造 Node 的输出，还会打乱 `appendEvent` 的 per-session 序号契约。编排的进展走 `run` / `run_steps` 这两个 browser 消息，与 session 事件流彻底分开。

**顺带该修的一处不对称**：`host-yolo` 和 `copilot-acp` 是裸字符串，另外五个 capability 都有导出常量。编排器要读 `host-yolo`（yolo 派发前的检查），实现时顺手补一个 `HOST_YOLO_CAPABILITY` 常量，别再散一处字面量。

### 5.4 需要的一处重构

`POST /api/sessions` 的创建逻辑目前直接写在路由里（`routes/sessions.ts:34-66`）。引擎不该走 HTTP 自调用，需把它抽成：

```ts
// fleet-service.ts
createAndStartSession(input: {
  placement: Placement; prompt: string; yolo: boolean;
  name?: string; runId?: string; runRole?: string;
}): { ok: true; session: FleetSession } | { ok: false; status: number; error: string }
```

路由和引擎共用它。这是本方案唯一触及现有逻辑的改动，其余全是新增。

### 5.5 UI

- 侧边栏加 **Runs** 入口；run 展开为 step 列表，step 点进去就是现有的 session 详情（复用 `TerminalView`）。
- Run 详情页画一个简单 DAG / 阶梯图，节点着色复用 `session-status.ts` 的色板。
- `awaiting_approval` 状态下把 lead 生成的计划渲染成可编辑表格 + 「批准并执行」按钮——**人工闸门是 v1 的默认行为**。

---

## 6. 分期落地

| 阶段        | 内容                                                                                       | 可验证结论                                                    |
| ----------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **P0 骨架** | `runs`/`run_steps` 表 + store 方法 + 状态机纯函数 + `planNextActions` 单测                  | `npm test` 里 DAG 排程、环检测、容量等待、**重启后全 offline 不误判**全绿，不碰 UI 和网络 |
| **P1 手写 DAG** | `POST /api/runs/:id/plan` + 引擎接线 + Runs UI；用 `--mock-agent` 跑三步流水线            | 两个 mock node 上跑通 `audit → fix → test`，Host 重启后能续跑  |
| **P2 Lead 规划** | lead session + `fleet-plan` 解析 + 格式重试 + 人工批准闸门 + 汇总回灌                   | 给一句目标，自动出计划，人点批准后自动跑完并产出汇总           |
| **P3 进阶** | 失败重试策略、replan、跨 node artifact、best-of-N 扇出对比、MCP tool 替代文本块             | —                                                             |

P0+P1 是「值得先做完」的一刀：拿到它，编排的骨架已经能真跑，而且没有任何 LLM 不确定性混在里面。

### 6.1 P0 必过的不变量（每条对应一个真实踩过的坑）

这些全部是 `planNextActions()` 的纯函数单测，不需要 SQLite、不需要网络：

1. **重启不误判** —— 所有 session 为 `offline` 时，不得产生任何 `settle_step` / `finish_run`。
2. **回执不等于完成** —— step 已 `running` 且尚无 `turn_complete` 时，不得判成功。
3. **终态 step 收到迟到事件** —— 静默无视，不重复 settle、不抛错。
4. **容量留余量** —— 剩余容量为 0 时不派发；且不得把 `maxSessions` 吃满（留 headroom）。
5. **环检测** —— 有环的计划被拒，错误信息含环上的 step_key。
6. **依赖悬空** —— `dependsOn` 引用不存在的 step_key 被拒。
7. **fail-fast 传播** —— 一个 step 失败后，其下游转 `skipped`，无关分支继续。
8. **首轮不重发 prompt** —— 派发 step 只产生一个 `start_session` 动作。

## 7. 需要同步修订的文档

- `ARCHITECTURE.md`：删掉 non-goal 里的 "Agent-to-agent DAGs"，新增「Orchestration」章节。
- `PRODUCT.md`：领域模型加 Run / RunStep；用户流程加编排流程。
- `README.md`：加一节 orchestrator 的 proof of concept（mock-agent 版）。

## 8. 待确认

1. **人工闸门**默认开（计划要人批准）还是可配置全自动？本方案默认开。
2. **step 粒度**：一个 step = 一个全新 session（本方案选择，隔离干净），还是允许复用同一 session 跑多个 step？
3. **失败策略**默认值：`fail-fast`（一个 step 挂，整个 run 停）还是 `continue`（下游 skip，其余继续）？本方案默认 fail-fast。
4. 是否需要 **run 模板**（把常用流水线存下来复用）——建议放 P3。
