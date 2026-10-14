import type { OpenCode } from "@opencode/sdk"
import { preparePrompt } from "./prepare"
import { renderTool } from "./render-tool"
import { duration } from "./log"

type Client = Pick<OpenCode.Interface, "session" | "message" | "event" | "skill" | "permission" | "model" | "form">

export type RunOptions = {
  directory: string
  prompt: string
  agent?: string
  skills?: string[]
  title?: string
  model?: string
  variant?: string
  thinking?: boolean
  auto?: boolean
  files?: string[]
  signal?: AbortSignal
  write?: (text: string) => void
  writeStatus?: (text: string) => void
  progressInterval?: number
  deadline?: number
  debug?: boolean
}

/** Run one CI turn against the OpenCode service. */
export async function run(client: Client, options: RunOptions) {
  const write = options.write ?? ((text: string) => process.stdout.write(text))
  const writeStatus = options.writeStatus ?? options.write ?? ((text: string) => process.stderr.write(text))
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
  const events = client.event.subscribe({ signal })[Symbol.asyncIterator]()
  let consume = Promise.resolve()

  const sessions = new Map<string, { label: string; parentID?: string }>()
  const printed = new Map<string, string>()
  const headings = new Set<string>()
  const attachedSkills = new Map<string, string[]>()
  const renderedTools = new Set<string>()
  const tools = new Map<string, { name: string; input: Record<string, unknown> }>()
  const active = new Map<string, { sessionID: string; name: string; input: Record<string, unknown>; started: number; shellID?: string }>()
  const executing = new Set<string>()
  const started = Date.now()
  let lastActivity = started
  let lastEvent = "connecting"
  let completed = false
  let progress: ReturnType<typeof setInterval> | undefined
  let failure: Error | undefined
  let rootID: string | undefined
  const terminal = Promise.withResolvers<void>()
  let interrupting: Promise<unknown> | undefined
  const stop = () => {
    if (rootID && !interrupting)
      interrupting = client.session.interrupt({ sessionID: rootID }, { signal: AbortSignal.timeout(5000) })
        .then(() => writeStatus("[run] Session interruption acknowledged\n"))
        .catch((error: unknown) => writeStatus(`[run] Session interruption failed: ${error instanceof Error ? error.message : String(error)}\n`))
  }
  options.signal?.addEventListener("abort", stop, { once: true })
  const checkCancelled = () => signal.throwIfAborted()

  const print = (sessionID: string, messageID: string, ordinal: number, text: string) => {
    const key = `${messageID}:text:${ordinal}`
    const previous = printed.get(key) ?? ""
    if (previous === text) return
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text
    printed.set(key, text)
    if (!delta.trim()) return
    textLine(sessionID, delta.trim())
  }

  const reasoning = (sessionID: string, messageID: string, ordinal: number, text: string) => {
    if (!options.thinking) return
    const key = `${messageID}:reasoning:${ordinal}`
    const previous = printed.get(key) ?? ""
    if (previous === text) return
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text
    printed.set(key, text)
    if (!delta.trim()) return
    const thought = `Thinking: ${delta.trim()}`
    textLine(sessionID, process.stdout.isTTY && color() ? `\x1b[90m\x1b[3m${thought}\x1b[0m` : thought)
  }

  const textLine = (sessionID: string, text: string) => {
    line(sessionID, `${text}\n`, process.stdout.isTTY ? writeStatus : write)
  }

  const line = (sessionID: string, text: string, output = writeStatus) => {
    const session = sessions.get(sessionID)
    if (!session?.parentID) return output(text)
    output(prefix(session.label, text))
  }

  const color = () => !process.env.NO_COLOR && (process.stdout.isTTY || process.env.GITHUB_ACTIONS === "true")
  const prefix = (name: string, text: string) => {
    const label = color() ? `\x1b[90m${name}\x1b[0m` : name
    return text.split("\n").map((row) => row ? `${label} ${row}` : "").join("\n")
  }

  const heading = (sessionID: string, messageID: string, agent: string, model: string) => {
    if (headings.has(messageID)) return
    headings.add(messageID)
    const skills = sessionID === rootID ? ` · ${attachedSkills.get(sessionID)?.join(", ") || "no skills"}` : ""
    line(sessionID, `> ${agent} · ${model}${skills}\n`)
  }

  const toolLine = (sessionID: string, messageID: string, id: string, name: string, input: Record<string, unknown>, content?: ReadonlyArray<{ type: string; text?: string }>, metadata?: Record<string, unknown>, error?: string, elapsed?: number) => {
    const key = `${messageID}:${id}`
    if (renderedTools.has(key)) return
    renderedTools.add(key)
    const description = (name === "subagent" || name === "task") && typeof input.description === "string" ? input.description : ""
    const text = renderTool({ name, input, content, metadata, error, directory: options.directory, prefixed: !!description, color: color(),
      phase: elapsed === undefined ? undefined : "completed", elapsed, callID: options.debug ? key : undefined })
    line(sessionID, description ? prefix(description, text) : text)
  }

  const activity = () => {
    const now = Date.now()
    const remaining = options.deadline === undefined ? "" : ` · remaining=${duration(options.deadline - now)}`
    writeStatus(`[run] elapsed=${duration(now - started)}${remaining} · active tools=${active.size} · active sessions=${executing.size} · last activity=${lastEvent} ${duration(now - lastActivity)} ago\n`)
    for (const [key, tool] of active) {
      toolStarted(tool.sessionID, key, tool, "running", now - tool.started)
    }
    for (const id of executing) {
      if (![...active.values()].some((tool) => tool.sessionID === id))
        line(id, `[running] Session ${id} · waiting for model or next tool\n`)
    }
  }

  const toolStarted = (sessionID: string, key: string, tool: { name: string; input: Record<string, unknown> }, phase: "started" | "running", elapsed?: number) => {
    const description = (tool.name === "subagent" || tool.name === "task") && typeof tool.input.description === "string" ? tool.input.description : ""
    const text = renderTool({ ...tool, directory: options.directory, prefixed: !!description, color: color(), phase, elapsed, callID: options.debug ? key : undefined })
    line(sessionID, description ? prefix(description, text) : text)
  }

  const children = new Map<string, string[]>()
  const discover = async (parentID: string) => {
    const ids: string[] = []
    let cursor: string | undefined
    do {
      const result = await client.session.list({ parentID, limit: 200, ...(cursor ? { cursor } : {}) }, { signal })
      for (const child of result.data) {
        ids.push(child.id)
        sessions.set(child.id, { label: child.title ?? child.id, parentID })
      }
      cursor = result.cursor.next ?? undefined
    } while (cursor)
    children.set(parentID, ids)
  }

  const replay = async (id: string) => {
    let cursor: string | undefined
    const messages = [] as Awaited<ReturnType<Client["message"]["list"]>>["data"][number][]
    do {
      const page = await client.message.list({ sessionID: id, limit: 200, ...(cursor ? { cursor } : { order: "desc" }) }, { signal })
      messages.push(...page.data)
      cursor = page.cursor.next ?? undefined
    } while (cursor)
    for (const message of messages.reverse()) {
      if (message.type !== "assistant") continue
      if (message.content.length) heading(id, message.id, message.agent, message.model.id)
      let ordinal = 0
      let reasoningOrdinal = 0
      for (const content of message.content) {
        if (content.type === "text") print(id, message.id, ordinal++, content.text)
        if (content.type === "reasoning") reasoning(id, message.id, reasoningOrdinal++, content.text)
        if (content.type === "tool" && (content.state.status === "completed" || content.state.status === "error")) {
          if (renderedTools.has(`${message.id}:${content.id}`)) continue
          if (content.name === "subagent" || content.name === "task") await flushChild(id, content.state.input, content.state.metadata)
          toolLine(id, message.id, content.id, content.name, content.state.input, content.state.content, content.state.metadata,
            content.state.status === "error" ? content.state.error.message : undefined)
        }
      }
      if (message.error) failure = new Error(message.error.message)
    }
  }

  const flushing = new Map<string, Promise<void>>()
  const flushChild = async (parentID: string, input: Record<string, unknown>, metadata?: Record<string, unknown>) => {
    const description = input.description
    if (typeof description !== "string") return
    // Tool metadata identifies the exact child, even when multiple calls use
    // the same description. Fall back to matching session titles for older data.
    const childID = typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
    if (!childID || !sessions.has(childID)) await discover(parentID)
    for (const id of childID ? [childID] : children.get(parentID) ?? []) {
      if (!childID && sessions.get(id)?.label !== description) continue
      if (!sessions.has(id)) sessions.set(id, { label: description, parentID })
      let pending = flushing.get(id)
      if (!pending) {
        pending = (async () => {
          await client.session.wait({ sessionID: id }, { signal })
          await replay(id)
        })().finally(() => flushing.delete(id))
        flushing.set(id, pending)
      }
      await pending
    }
  }

  const finishing = new Set<Promise<void>>()
  const drainFinishes = async () => {
    while (finishing.size) await Promise.all(finishing)
  }

  const handledForms = new Set<string>()
  const cancelForm = async (form: { id: string; sessionID: string }) => {
    if (handledForms.has(form.id)) return
    handledForms.add(form.id)
    try {
      await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id }, {
        signal,
        ...(form.sessionID === "global" ? { headers: { "x-opencode-directory": encodeURIComponent(options.directory) } } : {}),
      })
    } catch (error) {
      if (error && typeof error === "object" && "_tag" in error && error._tag === "FormAlreadySettledError") return
      throw error
    }
    failure ??= new Error("Interactive input is unavailable in CI")
    line(form.sessionID, "Interactive input requested; cancelling in CI\n")
  }

  const handledPermissions = new Set<string>()
  const replyPermission = async (request: { sessionID: string; id: string; action: string; resources: ReadonlyArray<string> }) => {
    if (handledPermissions.has(request.id)) return
    handledPermissions.add(request.id)
    await client.permission.reply({ sessionID: request.sessionID, requestID: request.id, decision: options.auto ? "once" : "reject" }, { signal })
    line(request.sessionID, `Permission ${options.auto ? "approved once" : "rejected"}: ${request.action} (${request.resources.join(", ")})\n`)
    if (options.auto) return
    failure ??= new Error(`Permission denied: ${request.action} (${request.resources.join(", ")})`)
    await client.session.interrupt({ sessionID: request.sessionID }, { signal })
  }

  const consumeEvents = async () => {
    while (!signal.aborted) {
      const item = await events.next()
      if (item.done) {
        if (!signal.aborted) throw new Error("OpenCode event stream disconnected")
        return
      }
      const event = item.value
      if (event.type === "session.created" && event.data.parentID && sessions.has(event.data.parentID)) {
        sessions.set(event.data.sessionID, { label: event.data.title ?? event.data.sessionID, parentID: event.data.parentID })
        line(event.data.sessionID, `Subagent session created · ${event.data.sessionID}\n`)
      }
      if (event.type === "form.created") {
        if (sessions.has(event.data.form.sessionID) ||
          (rootID && event.data.form.sessionID === "global" && event.location?.directory === options.directory))
          await cancelForm(event.data.form)
        continue
      }
      if (!("sessionID" in event.data) || !sessions.has(event.data.sessionID)) continue
      lastActivity = Date.now()
      lastEvent = event.type
      if (options.debug) line(event.data.sessionID, `[debug] ${event.type}\n`)
      if (event.type === "session.execution.started") {
        executing.add(event.data.sessionID)
        line(event.data.sessionID, "Execution started\n")
      }
      if (event.type === "session.text.ended") {
        print(event.data.sessionID, event.data.assistantMessageID, event.data.ordinal, event.data.text)
      }
      if (event.type === "session.reasoning.ended") {
        reasoning(event.data.sessionID, event.data.assistantMessageID, event.data.ordinal, event.data.text)
      }
      if (event.type === "session.step.started") {
        executing.add(event.data.sessionID)
        heading(event.data.sessionID, event.data.assistantMessageID, event.data.agent, event.data.model.id)
      }
      if (event.type === "session.tool.input.started") {
        tools.set(`${event.data.assistantMessageID}:${event.data.id}`, { name: event.data.name, input: {} })
      }
      if (event.type === "session.tool.called") {
        const key = `${event.data.assistantMessageID}:${event.data.id}`
        const tool = { name: tools.get(key)?.name ?? "tool", input: event.data.input }
        tools.set(key, tool)
        if (!active.has(key)) {
          active.set(key, { ...tool, sessionID: event.data.sessionID, started: Date.now() })
          toolStarted(event.data.sessionID, key, tool, "started")
        }
      }
      if (event.type === "session.tool.progress") {
        const key = `${event.data.assistantMessageID}:${event.data.id}`
        const tool = active.get(key)
        const shellID = event.data.metadata?.shellID
        if (tool && typeof shellID === "string" && tool.shellID !== shellID) {
          tool.shellID = shellID
          if (options.debug) line(event.data.sessionID, `[process · ${key}] shellID=${shellID}\n`)
        }
      }
      if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
        const key = `${event.data.assistantMessageID}:${event.data.id}`
        const tool = tools.get(key)
        tools.delete(key)
        const running = active.get(key)
        active.delete(key)
        const elapsed = running ? Date.now() - running.started : undefined
        const finish = () => toolLine(event.data.sessionID, event.data.assistantMessageID, event.data.id, tool?.name ?? "tool", tool?.input ?? {}, event.data.content, event.data.metadata, event.type === "session.tool.failed" ? event.data.error.message : undefined, elapsed)
        if (tool?.name === "subagent" || tool?.name === "task") {
          // Recovery can involve I/O. Do not stop reading other children's live events.
          const pending = flushChild(event.data.sessionID, tool.input, event.data.metadata).then(finish).catch((error: unknown) => {
            failure ??= error instanceof Error ? error : new Error(String(error))
          })
          finishing.add(pending)
          void pending.finally(() => finishing.delete(pending))
        } else finish()
      }
      if (event.type === "session.execution.failed") {
        line(event.data.sessionID, `Error: ${event.data.error.message}\n`)
        failure = new Error(event.data.error.message)
      }
      if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
        executing.delete(event.data.sessionID)
        line(event.data.sessionID, `Execution ${event.type.slice("session.execution.".length)}\n`)
      }
      if ((event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") && event.data.sessionID === rootID)
        terminal.resolve()
      if (event.type === "permission.asked") {
        await replyPermission(event.data)
      }
    }
  }

  try {
    writeStatus(`[run] Connecting event stream · directory=${options.directory}\n`)
    if ((options.progressInterval ?? 30_000) > 0) {
      progress = setInterval(activity, options.progressInterval ?? 30_000)
      progress.unref()
    }
    checkCancelled()
    // Subscribe before creating the session: subscriptions are live-only.
    const connected = await events.next()
    checkCancelled()
    if (connected.done) throw new Error("OpenCode event stream disconnected")
    consume = consumeEvents().catch((error: unknown) => {
      if (signal.aborted) return
      failure = error instanceof Error ? error : new Error(String(error))
      controller.abort(failure)
      stop()
    })
    const model = resolveModel(options.model, options.variant)
      ?? (options.variant ? await client.model.default({ location: { directory: options.directory } }, { signal }).then((result) => {
        if (!result.data) throw new Error("Cannot select a variant before selecting a model")
        return { providerID: result.data.providerID, id: result.data.id, variant: options.variant }
      }) : undefined)
    const session = await client.session.create({
      location: { directory: options.directory },
      agent: options.agent,
      model,
      title: options.title,
    }, { signal })
    rootID = session.id
    sessions.set(rootID, { label: "main" })
    writeStatus(`[run] Session created · ${rootID}\n`)
    if (signal.aborted) stop()
    checkCancelled()

    const { text: prompt, files } = await preparePrompt(options.prompt, options.files, signal)
    checkCancelled()
    const slash = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/.exec(prompt)
    if (slash) {
      if (options.skills?.length) throw new Error("--skill cannot be used with slash commands")
      await client.session.command({ sessionID: rootID, name: slash[1]!, text: slash[2] ?? "", files: files.length ? files : undefined }, { signal })
    } else {
      const mentions = [...prompt.matchAll(/(^|\s)@(?:skill:)?([\w.-]+)/g)]
      const available = mentions.length ? await client.skill.list({ location: { directory: options.directory } }, { signal }) : undefined
      const names = new Set(available?.data.map((skill) => skill.id) ?? [])
      const skills = [...new Set(options.skills ?? [])].map((id) => ({ id }))
      skills.push(...mentions
        .filter((match) => names.has(match[2]!))
        .filter((match) => !skills.some((skill) => skill.id === match[2]))
        .map((match) => ({
          id: match[2]!,
          mention: { start: match.index + match[1]!.length, end: match.index + match[0]!.length, text: match[0]!.trim() },
        })))
      attachedSkills.set(rootID, [...new Set(skills.map((skill) => skill.id))])
      await client.session.prompt({ sessionID: rootID, text: prompt, files: files.length ? files : undefined, skills }, { signal })
    }

    checkCancelled()
    // Reconcile ephemeral blockers that may have arrived during prompt admission.
    const [permissions, forms, globals] = await Promise.all([
      client.permission.list({ sessionID: rootID }, { signal }),
      client.session.form.list({ sessionID: rootID }, { signal }),
      client.form.list({ location: { directory: options.directory } }, { signal }),
    ])
    await Promise.all([
      ...permissions.map(replyPermission),
      ...forms.map(cancelForm),
      ...(globals.location.directory === options.directory ? globals.data.filter((form) => form.sessionID === "global").map(cancelForm) : []),
    ])
    await client.session.wait({ sessionID: rootID }, { signal })
    // The wait endpoint can settle before SSE delivers the terminal event.
    // Drain through that event before closing the stream, especially when an
    // early failure has no assistant message to recover during replay.
    // Plugin commands may finish without ever executing the root session.
    const root = await client.session.get({ sessionID: rootID }, { signal })
    if (root.outcome !== undefined) {
      const cancelled = Promise.withResolvers<never>()
      const abortTerminal = () => cancelled.reject(signal.reason)
      signal.addEventListener("abort", abortTerminal, { once: true })
      try {
        checkCancelled()
        await Promise.race([terminal.promise, cancelled.promise])
      } finally { signal.removeEventListener("abort", abortTerminal) }
    }
    checkCancelled()
    await drainFinishes()

    // Child sessions are separate streams. Reconcile persisted messages as well as
    // live events so fast children and event-stream gaps do not hide their output.
    const pending = [rootID]
    for (const id of pending) {
      checkCancelled()
      await discover(id)
      for (const child of children.get(id) ?? []) if (!pending.includes(child)) pending.push(child)
    }
    for (const id of pending.slice(1)) {
      checkCancelled()
      await client.session.wait({ sessionID: id }, { signal })
    }
    for (const id of pending) {
      checkCancelled()
      await replay(id)
      const result = await client.session.get({ sessionID: id }, { signal })
      if (result.outcome === "failed" || result.outcome === "interrupted")
        failure ??= new Error(`Session ${id} ${result.outcome}`)
    }
    await drainFinishes()
    checkCancelled()
    if (failure) throw failure
    completed = true
    return session.id
  } finally {
    clearInterval(progress)
    writeStatus(`[run] ${completed ? "Completed" : options.signal?.aborted ? "Cancelled" : "Failed"} · elapsed=${duration(Date.now() - started)} · active tools=${active.size}\n`)
    if (!completed) activity()
    options.signal?.removeEventListener("abort", stop)
    controller.abort()
    void events.return?.(undefined).catch(() => {})
    await consume
    await Promise.allSettled(finishing)
    await interrupting
  }
}

export function resolveModel(input?: string, variant?: string) {
  if (!input) return undefined
  const match = /^([^/#]+)\/([^#]+)(?:#([^#]+))?$/.exec(input)
  if (!match) throw new Error(`Invalid model reference: ${input} (expected provider/model#variant)`)
  if (variant && match[3] && variant !== match[3]) throw new Error("--variant conflicts with the variant in --model")
  return { providerID: match[1]!, id: match[2]!, variant: variant ?? match[3] }
}
