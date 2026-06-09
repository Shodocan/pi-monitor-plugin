# Pi Extension API Cheat-Sheet — Background Jobs / Monitors / Loops / Scheduled Prompts / External Events

All paths relative to package root `<PKG>` = `<pi-install>/node_modules/@earendil-works/pi-coding-agent`.
Authoritative type file: `<PKG>/dist/core/extensions/types.d.ts` (cited as `types.d.ts`). Docs: `<PKG>/docs/extensions.md` (cited as `extensions.md`).

---

## 1. Core API signatures

### Extension module shape

```ts
// Default-export factory; sync or async. pi awaits async factories before startup continues.
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;   // types.d.ts:1029
export default function (pi: ExtensionAPI) { ... }
```
- Factory contract: extensions.md:153-180. Async factories complete **before** `session_start` and `resources_discover` (extensions.md:180).
- Extensions are TypeScript, loaded via **jiti** — no compilation needed (extensions.md:178; loader: `<PKG>/dist/core/extensions/loader.js:264-275`).
- Available imports: `@earendil-works/pi-coding-agent`, `typebox`, `@earendil-works/pi-ai` (`StringEnum`), `@earendil-works/pi-tui`, Node built-ins (`node:fs`, `node:child_process`, …), plus npm deps from a sibling `package.json`/`node_modules` (extensions.md:138-151).

### Lifecycle events (full `pi.on` overload list, types.d.ts:809-838)

| Event | Payload type | Handler can return | Cite |
|---|---|---|---|
| `project_trust` | `ProjectTrustEvent` | `{trusted:"yes"|"no"|"undecided", remember?}` | types.d.ts:809,376-391 |
| `resources_discover` | `{cwd, reason:"startup"|"reload"}` | `{skillPaths?,promptPaths?,themePaths?}` | types.d.ts:810,392-403 |
| `session_start` | `{reason:"startup"|"reload"|"new"|"resume"|"fork", previousSessionFile?}` | — | types.d.ts:811,404-411 |
| `session_before_switch` | `{reason:"new"|"resume", targetSessionFile?}` | `{cancel?}` | types.d.ts:812,413-417 |
| `session_before_fork` | `{entryId, position:"before"|"at"}` | `{cancel?, skipConversationRestore?}` | types.d.ts:813,419-423 |
| `session_before_compact` / `session_compact` | see types | `{cancel?, compaction?}` | types.d.ts:814-815,425-437 |
| `session_shutdown` | `{reason:"quit"|"reload"|"new"|"resume"|"fork", targetSessionFile?}` | — | types.d.ts:816,439-444 |
| `session_before_tree` / `session_tree` | see types | `{cancel?, summary?, ...}` | types.d.ts:817-818,460-472 |
| `context` | `{messages: AgentMessage[]}` (deep copy) | `{messages?}` | types.d.ts:819,475-478,735-737 |
| `before_provider_request` / `after_provider_response` | payload / `{status, headers}` | replacement payload / — | types.d.ts:820-821,480-489 |
| `before_agent_start` | `{prompt, images?, systemPrompt, systemPromptOptions}` | `{message?, systemPrompt?}` | types.d.ts:822,491-501,760-764 |
| `agent_start` / `agent_end` | `{}` / `{messages}` | — | types.d.ts:823-824,503-510 |
| `turn_start` / `turn_end` | `{turnIndex,timestamp}` / `{turnIndex,message,toolResults}` | — | types.d.ts:825-826,512-523 |
| `message_start` / `message_update` / `message_end` | message; update adds `assistantMessageEvent` | end: `{message?}` | types.d.ts:827-829,525-539 |
| `tool_execution_start` / `_update` / `_end` | `{toolCallId,toolName,args[,partialResult|result,isError]}` | — | types.d.ts:830-832,541-562 |
| `model_select` / `thinking_level_select` | see types | — | types.d.ts:833-834,563-576 |
| `tool_call` | `ToolCallEvent` (mutable `event.input`) | `{block?, reason?}` | types.d.ts:835,611-653,739-743 |
| `tool_result` | `ToolResultEvent` | `{content?, details?, isError?}` (patch, chained) | types.d.ts:836,654-694,751-755 |
| `user_bash` | `{command, excludeFromContext, cwd}` | `{operations?}` or `{result?}` | types.d.ts:837,578-586,744-750 |
| `input` | `{text, images?, source:"interactive"|"rpc"|"extension", streamingBehavior?:"steer"|"followUp"}` | `{action:"continue"|"transform"|"handled"}` | types.d.ts:838,588-610 |

Lifecycle order diagram: extensions.md:268-336. Critical: `/new` and `/resume` and `/fork` all emit `session_shutdown` → reload+rebind extensions → `session_start` (extensions.md:307-317, 408-409, 425-426).

### Message injection

```ts
// types.d.ts:859-862 (fire-and-forget, returns void)
pi.sendMessage<T>(message: Pick<CustomMessage<T>, "customType"|"content"|"display"|"details">,
  options?: { triggerTurn?: boolean; deliverAs?: "steer"|"followUp"|"nextTurn" }): void;

// types.d.ts:867-869 — "Always triggers a turn"
pi.sendUserMessage(content: string | (TextContent|ImageContent)[],
  options?: { deliverAs?: "steer"|"followUp" }): void;

// types.d.ts:871 — persisted state, NOT sent to LLM
pi.appendEntry<T>(customType: string, data?: T): void;
```
- `sendMessage` options doc: extensions.md:1314-1335. `triggerTurn: true` — if idle, triggers an LLM response immediately; ignored for `"nextTurn"` (extensions.md:1335).
- `sendUserMessage` doc: extensions.md:1337-1363. **"When streaming without `deliverAs`, throws an error"** (extensions.md:1361). The actual throw: `<PKG>/dist/core/agent-session.js:738-739` — `"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."` (`sendUserMessage` delegates to `prompt()` with `streamingBehavior: options?.deliverAs`, agent-session.js:1036-1041).
- Custom messages render via `pi.registerMessageRenderer(customType, (message, {expanded}, theme) => Component)` (types.d.ts:857, 789-792; extensions.md:1486-1488, 2492-2521).

### Tool registration — **schema style is TypeBox** (`typebox` package), not zod / not raw JSON schema

```ts
// types.d.ts:840
pi.registerTool<TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>): void;

// ToolDefinition, types.d.ts:335-366
{
  name: string; label: string; description: string;
  promptSnippet?: string;            // one-liner in "Available tools" (types.d.ts:343)
  promptGuidelines?: string[];       // bullets in Guidelines while active (types.d.ts:345)
  parameters: TParams;               // TypeBox TSchema (types.d.ts:346-347)
  renderShell?: "default" | "self";  // types.d.ts:349
  prepareArguments?: (args: unknown) => Static<TParams>;   // pre-validation shim (types.d.ts:351)
  executionMode?: "sequential" | "parallel";               // per-tool override (types.d.ts:353-359)
  execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
          onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
          ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>;   // types.d.ts:361
  renderCall?(args, theme, context): Component;     // types.d.ts:363
  renderResult?(result, {expanded,isPartial}, theme, context): Component;  // types.d.ts:365
}
```
- Use `import { Type } from "typebox"` and `StringEnum` from `@earendil-works/pi-ai` for enums (Google API compat — `Type.Union`/`Type.Literal` breaks Gemini) (extensions.md:60-61, 1822).
- `registerTool` works during load **and at runtime** (inside `session_start`, commands, events) — tools are refreshed immediately, no `/reload` (extensions.md:1267).
- `defineTool(...)` helper preserves param inference for standalone definitions (types.d.ts:375).

### Command registration with arg completion

```ts
// types.d.ts:842 + RegisteredCommand types.d.ts:793-799
pi.registerCommand(name: string, {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) =>
    AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;   // types.d.ts:797
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;  // types.d.ts:798
}): void;
```
Doc + completion example: extensions.md:1418-1451. Duplicate names get suffixes `/review:1` (extensions.md:1422).

### Shortcuts & flags

```ts
pi.registerShortcut(shortcut: KeyId, { description?, handler: (ctx: ExtensionContext) => Promise<void>|void }): void;  // types.d.ts:844-847
pi.registerFlag(name, { description?, type: "boolean"|"string", default? }): void;  // types.d.ts:849-853
pi.getFlag(name): boolean | string | undefined;  // types.d.ts:855
```

### Other ExtensionAPI methods (types.d.ts:808-963)

`pi.exec(command, args, options?) => Promise<ExecResult>` (types.d.ts:879; `result.stdout/.stderr/.code/.killed`, extensions.md:1520-1527) · `getActiveTools()/getAllTools()/setActiveTools(names)` (types.d.ts:881-885) · `getCommands()` (887) · `setModel` (889) · `get/setThinkingLevel` (891-893) · `setSessionName/getSessionName` (873-875) · `setLabel` (877) · `registerProvider/unregisterProvider` (946,960) · **`pi.events: EventBus`** (962).

### Events bus (inter-extension / in-process pub-sub)

```ts
// <PKG>/dist/core/event-bus.d.ts:1-8
interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;  // returns unsubscribe
}
```
Doc: extensions.md:1579-1586. Example: `examples/extensions/event-bus.ts`. The bus is shared across extensions in the same process.

### ExtensionContext (handed to every handler; types.d.ts:208-241)

```ts
{
  ui: ExtensionUIContext;            // :210
  mode: "tui"|"rpc"|"json"|"print";  // :212 (ExtensionMode, :207)
  hasUI: boolean;                    // :214 (true in tui+rpc)
  cwd: string;                       // :216
  sessionManager: ReadonlySessionManager;  // :218
  modelRegistry: ModelRegistry;      // :220
  model: Model<any> | undefined;     // :222
  isIdle(): boolean;                 // :224
  isProjectTrusted(): boolean;       // :226
  signal: AbortSignal | undefined;   // :228 (undefined when agent not streaming)
  abort(): void;                     // :230
  hasPendingMessages(): boolean;     // :232
  shutdown(): void;                  // :234
  getContextUsage(): ContextUsage | undefined;  // :236
  compact(options?: CompactOptions): void;      // :238
  getSystemPrompt(): string;         // :240
}
```

`ExtensionCommandContext extends ExtensionContext` (command handlers only, types.d.ts:246-283): `getSystemPromptOptions()` (:248), **`waitForIdle(): Promise<void>`** (:250), `newSession()` (:252), `fork()` (:260), `navigateTree()` (:267), `switchSession()` (:276), `reload()` (:282). These exist only on commands "because they can deadlock if called from event handlers" (extensions.md:1009).

### UI surfaces (ExtensionUIContext, types.d.ts:67-191)

```ts
ctx.ui.select(title, options, opts?) => Promise<string|undefined>      // :69
ctx.ui.confirm(title, message, opts?) => Promise<boolean>              // :71
ctx.ui.input(title, placeholder?, opts?) => Promise<string|undefined>  // :73
ctx.ui.notify(message, type?: "info"|"warning"|"error") => void        // :75
ctx.ui.onTerminalInput(handler) => unsubscribe                         // :77
ctx.ui.setStatus(key, text|undefined) => void                          // :79 (footer)
ctx.ui.setWorkingMessage(msg?) / setWorkingVisible(b) / setWorkingIndicator(opts?)  // :81-92
ctx.ui.setWidget(key, string[]|factory|undefined, {placement?: "aboveEditor"|"belowEditor"})  // :96-99 (WidgetPlacement :42)
ctx.ui.setFooter(factory|undefined) / setHeader(factory|undefined)     // :106,:110
ctx.ui.setTitle(title)                                                 // :114
ctx.ui.custom<T>(factory, {overlay?, overlayOptions?, onHandle?}) => Promise<T>  // :116-126
ctx.ui.editor(title, prefill?) => Promise<string|undefined>            // :134
ctx.ui.setEditorText / getEditorText / pasteToEditor                   // :128-132
ctx.ui.addAutocompleteProvider(factory)                                // :136
ctx.ui.theme  // current Theme                                         // :174
```
Dialog `opts`: `{ signal?: AbortSignal; timeout?: number }` (ExtensionUIDialogOptions, types.d.ts:35-40; timeout returns `undefined`/`false`, extensions.md:2199-2202).

---

## 2. Idle/busy detection & delivery decision tree

**Detection:** `ctx.isIdle()` is literally `() => !this.session.isStreaming` (`<PKG>/dist/modes/interactive/interactive-mode.js:1287`; `AgentSession.isStreaming` getter at `<PKG>/dist/core/agent-session.d.ts:266`). `ctx.signal` is `undefined` exactly when not streaming (types.d.ts:227-228). `ctx.hasPendingMessages()` reports queued steer/followUp messages (types.d.ts:232).

**Semantics (exact, from source):**
- **`steer`** — queued; "Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call" (agent-session.d.ts:337-344; extensions.md:1332). I.e. interrupts the reasoning loop at the next turn boundary.
- **`followUp`** — "Delivered only when agent has no more tool calls or steering messages" (agent-session.d.ts:345-352; extensions.md:1333) — waits for the entire agent run to wind down.
- **`nextTurn`** (`sendMessage` only) — "Queued for next user prompt. Does not interrupt or trigger anything" (extensions.md:1334); implementation pushes to `_pendingNextTurnMessages` (agent-session.js:985-987).
- Steering delivery granularity is configurable: `"all"` vs `"one-at-a-time"` (default) — rpc.md:318-332.

**`sendCustomMessage` runtime decision tree (agent-session.js:976-1005):**
```
deliverAs === "nextTurn"        → buffer for next user prompt           (:985-987)
else if streaming:
    deliverAs === "followUp"    → agent.followUp(msg)                   (:989-991)
    else (incl. "steer"/omitted)→ agent.steer(msg)   ← steer is default (:992-994)
else (idle):
    triggerTurn === true        → run agent prompt now (new turn)       (:996-998)
    else                        → append to session/state only, no turn (:999-1004)
```

**`sendUserMessage` decision tree:**
```
idle                  → sends immediately, always triggers a turn (extensions.md:1339,1361)
streaming + "steer"   → queued as steering message
streaming + "followUp"→ queued as follow-up
streaming + no option → THROWS (agent-session.js:738-739)
```

**Recommended pattern for external-event notifiers** (e.g. GitHub watcher):
```ts
if (ctx.isIdle()) {
  pi.sendUserMessage(text);                                  // new turn now
} else {
  pi.sendUserMessage(text, { deliverAs: "followUp" });       // don't derail current work
  // use "steer" instead if the event must redirect the in-flight task
}
```
Or non-user-attributed: `pi.sendMessage({customType, content, display: true}, { triggerTurn: true })` — safe in both states because streaming falls back to steer-queueing (agent-session.js:988-994). This is exactly what the shipped `file-trigger.ts` does (examples/extensions/file-trigger.ts:22-29).

---

## 3. Tool registration details — results, async, background

- **Result shape:** `execute` resolves `AgentToolResult<TDetails>` = `{ content: (TextContent|ImageContent)[], details?: TDetails, terminate?: boolean }` — `content` goes to the LLM; `details` is for rendering/state reconstruction (extensions.md:1793-1799). Type imported from `@earendil-works/pi-agent-core` (types.d.ts:10).
- **Errors:** throw from `execute` → caught, reported to LLM with `isError: true`; returning a value never sets the error flag (extensions.md:1808, 2558-2560).
- **Streaming progress:** call `onUpdate?.({ content, details })` — surfaces as `tool_execution_update` events and partial renders (extensions.md:1782-1786; types.d.ts:548-554).
- **Cancellation:** honor the `signal` parameter (Esc aborts; extensions.md:1778-1781).
- **Early termination of agent loop:** `terminate: true` skips the follow-up LLM call when every tool result in the batch terminates (extensions.md:1795-1799, 1810).
- **Async / fire-and-return background tools: YES.** The agent only awaits the promise returned by `execute`. A background-jobs tool can `spawn()` a detached child, store the handle in extension-closure state, and **return immediately** with "job started (id=…)" — work continues after the tool result is finalized. Later, notify completion with `pi.sendMessage(..., {triggerTurn:true})` or `pi.sendUserMessage(..., {deliverAs:"followUp"})` (the file-trigger pattern). The shipped `subagent` example shows the long-running-spawn machinery (`spawn` + `signal.addEventListener("abort", killProc)` + chained `onUpdate`, examples/extensions/subagent/index.ts:329,393-402,533-554), though it awaits completion; dropping the await is the background variant.
- **Parallel-mode safety:** tools run in parallel by default; set `executionMode: "sequential"` (types.d.ts:353-359) or wrap mutations in `withFileMutationQueue(absolutePath, fn)` (extensions.md:1719-1747).
- **Output discipline:** truncate to 50KB/2000 lines using `truncateHead`/`truncateTail`/`DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES`, write full output to a temp file and tell the LLM where (extensions.md:1953-2002) — essential for background-job log retrieval tools.
- **State reconstruction:** store job state in result `details` and rebuild in `session_start` by scanning `ctx.sessionManager.getBranch()` toolResult messages (extensions.md:1673-1705).

---

## 4. Extension loading story

- **Discovery locations** (extensions.md:108-136; loader impl `<PKG>/dist/core/extensions/loader.js:443-480`): project `.pi/extensions/` first, then global `~/.pi/agent/extensions/`, then `settings.json` `"extensions": [...]` paths and `"packages": ["npm:@foo/bar@1.0.0", "git:..."]`. Per-dir rules (loader.js:402-411): direct `*.ts`/`*.js`; subdir `index.ts`/`index.js`; subdir `package.json` with `"pi": { "extensions": [...] }` manifest (loader.js:348-401). No recursion beyond one level.
- **npm-installed pi packages:** `pi install npm:@scope/pkg@ver` writes to settings (`<PKG>/docs/packages.md:23-41`); pi runs production `npm install` so runtime deps must be in `dependencies` (packages.md:167; extensions.md:149); pi-bundled packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-agent-core`, `typebox`) go in `peerDependencies` with `"*"` (packages.md:169).
- **Module loading:** jiti with **`moduleCache: false`** (loader.js:265-271) — the module is re-imported and the **factory re-runs from scratch on every load, `/reload`, `/new`, `/resume`, `/fork`**. Therefore top-level module state does **NOT** survive session switches or reloads. Persist via `pi.appendEntry` + reconstruct in `session_start` (extensions.md:1365-1380), or stash truly process-global things on `globalThis` (unsupported but the only way to survive reload, e.g. keeping a detached child process registry).
- **Runtime binding:** `pi.*` action methods are throwing stubs during load ("Extension runtime not initialized…", loader.js:98-123) — you may *register* (on/registerTool/registerCommand) at load time, but only *act* (sendMessage etc.) from handlers after binding.
- **Module format/Node:** the package is ESM (`"type": "module"`, `<PKG>/package.json:5`); engines `node >= 22.19.0` (`<PKG>/package.json:92-94`). Extensions can use ESM/TS freely (jiti handles transform).

### Driving pi from outside (for the external watcher side)
- **SDK:** `createAgentSession()` → `session.prompt(text, {streamingBehavior?})`, `session.steer()`, `session.followUp()`, `session.subscribe(listener)` (`<PKG>/docs/sdk.md:19-37, 77-84, 205-238`; "During streaming without `streamingBehavior`: Throws", sdk.md:224).
- **RPC mode (`pi --mode rpc`):** JSON commands `{"type":"prompt","message":...,"streamingBehavior":"steer"|"followUp"}`, `{"type":"steer"}`, `{"type":"followup"}`, `set_steering_mode` (`<PKG>/docs/rpc.md:43-115, 318-332`). Extension commands execute immediately even during streaming (rpc.md:67).

---

## 5. Shipped examples worth copying (in `<PKG>/examples/extensions/`)

| File | Pattern for this plugin |
|---|---|
| `file-trigger.ts` | **The external-event notification skeleton**: `session_start` → `fs.watch(triggerFile)` → read+clear file → `pi.sendMessage({customType,content,display:true},{triggerTurn:true})` (lines 14-41). Replace fs.watch with your GitHub poller. |
| `send-user-message.ts` | Idle/busy-aware delivery: `ctx.isIdle()` gate, `deliverAs:"steer"` vs `"followUp"` commands (lines 28-33, 46-53, 65-72). |
| `git-merge-and-resolve.ts` | **Prompt-loop trigger**: on `agent_end`, inspect state, re-inject `pi.sendUserMessage(..., { deliverAs: "followUp" })` (lines 74, 113) — the loop primitive. |
| `subagent/index.ts` | Long-running `spawn()` with abort wiring + streamed `onUpdate` progress (lines 329, 393-402, 533-554) and concurrency limiting (213-229). |
| `status-line.ts` | `ctx.ui.setStatus(key, themed)` updated from `session_start`/`turn_start`/`turn_end` — the job-status footer pattern. |
| `todo.ts` | Stateful tool + `details`-based state reconstruction across branches/restarts. |
| `interactive-shell.ts` | `user_bash` interception + child processes. |
| `truncated-tool.ts` | Output truncation for log-tail tools. |
| `event-bus.ts` | `pi.events` cross-extension signalling. |
| `dynamic-tools.ts` | Registering tools after startup (e.g. per-job "kill_job" tools). |
| `reload-runtime.ts` | Command → `ctx.reload()`, and the tool→`sendUserMessage("/cmd",{deliverAs:"followUp"})` trampoline (extensions.md:1229-1255). |
| `working-indicator.ts`, `widget-placement.ts` | Streaming indicator and above/below-editor widgets for monitor UI. |

Full table: extensions.md:2573-2656.

---

## 6. Pitfalls

1. **Streaming throw:** `pi.sendUserMessage` without `deliverAs` while `isStreaming` throws `"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')..."` (agent-session.js:738-739). Always branch on `ctx.isIdle()` first. `pi.sendMessage` never throws for this (defaults to steer-queue when streaming, agent-session.js:988-994), but extension commands (`/foo`) can't be queued as steer/followUp text (agent-session.js:956-961).
2. **ctx/pi staleness:** On `/new`, `/resume`, `/fork`, `/reload`, and `AgentSession.dispose()`, the old runtime is invalidated (agent-session.js:483; runner.js:323-333; loader.js:127-131). Any later call through a captured `pi` or `ctx` throws: *"This extension ctx is stale after session replacement or reload…"*. Timer callbacks holding old `pi` references will start throwing — exactly why timers must be re-created.
3. **Timers across `/reload` & session switches:** jiti loads with `moduleCache: false` (loader.js:266), so the factory re-runs and module top-level state resets — but **`setInterval`/`fs.watch`/child processes created by the old instance are NOT cleaned up automatically**; they leak and their `pi` is stale. Correct lifecycle: create watchers/intervals in `session_start`, clear them in `session_shutdown` (fires for `"quit" | "reload" | "new" | "resume" | "fork"`, types.d.ts:439-444; guidance extensions.md:408-409, 425-426). Keep handles in factory-closure variables, not globals.
4. **Session-replacement footguns:** after `ctx.newSession()/fork()/switchSession()`, only use the fresh `ReplacedSessionContext` passed to `withSession` (types.d.ts:289-297); captured `sessionManager` objects are the old session even though they don't throw (extensions.md:1158-1199). After `await ctx.reload()` treat the handler as terminal (extensions.md:1215-1223).
5. **Event handlers vs commands:** `waitForIdle`, `newSession`, `fork`, `switchSession`, `reload` exist only on `ExtensionCommandContext` — calling-pattern equivalents from event handlers can deadlock (extensions.md:1009). Tools get plain `ExtensionContext`; to reload from a tool, queue a command via `sendUserMessage("/cmd", {deliverAs:"followUp"})` (extensions.md:1225-1255).
6. **Headless modes:** guard UI with `ctx.hasUI` (false in `-p`/json modes) and `ctx.mode === "tui"` for `ctx.ui.custom()`/editor/terminal-input (types.d.ts:212-214; extensions.md:2562-2571). In RPC mode `custom()` returns `undefined`.
7. **Schema gotchas:** TypeBox only; use `StringEnum` from `@earendil-works/pi-ai`, not `Type.Union(Type.Literal(...))` (Google API incompatibility, extensions.md:1822). Strip a leading `@` from path args (extensions.md:1717).
8. **Parallel tools:** default execution is parallel — `tool_call` may not see sibling results (extensions.md:700); file-mutating tools need `withFileMutationQueue` (extensions.md:1719-1726) or `executionMode: "sequential"` (types.d.ts:353-359).
9. **Output size:** untruncated background-job logs in tool results cause context overflow; enforce 50KB/2000-line caps with the exported helpers (extensions.md:1953-2002).
10. **Module/runtime constraints:** Node `>=22.19.0` (package.json:92-94), ESM package; npm-distributed extension deps must be `dependencies` (dev deps absent at runtime, extensions.md:149); pi-bundled libs are peer deps `"*"` (packages.md:169).
