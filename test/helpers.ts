import { mock } from "bun:test"
import { run, type RunOptions } from "../src/run"

export function deferred() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, resolve }
}

export function aborted(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

export function assistant(id: string, ...content: Record<string, unknown>[]) {
  return { id, type: "assistant", agent: "build", model: { id: "test-model" }, content }
}

export function subagent(id: string, description: string, sessionID: string) {
  return {
    type: "tool", id, name: "subagent",
    state: { status: "completed", input: { agent: "general", description }, metadata: { sessionID }, content: [] },
  }
}

export type Event = { type: string; data: Record<string, unknown>; location?: { directory: string } }

export function toolEvents(id: string, description: string, sessionID: string): Event[] {
  const data = { sessionID: "root", assistantMessageID: "msg_root", id }
  return [
    { type: "session.tool.input.started", data: { ...data, name: "subagent" } },
    { type: "session.tool.called", data: { ...data, input: { agent: "general", description } } },
    { type: "session.tool.success", data: { ...data, metadata: { sessionID }, content: [] } },
  ]
}

export function fixture(options: Partial<RunOptions> = {}) {
  const output: string[] = []
  const events: Event[] = []
  const prompted = deferred()
  const eventsDone = deferred()
  const sessions = new Map<string, { id: string; parentID?: string; title?: string; outcome?: string }>()
  sessions.set("root", { id: "root", outcome: "succeeded" })
  const messages = new Map<string, ReturnType<typeof assistant>[]>()
  messages.set("root", [assistant("msg_root", { type: "text", text: "summary" })])
  const client = {
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }): AsyncGenerator<Event> {
        yield { type: "server.connected", data: {} }
        await Promise.race([prompted.promise, aborted(signal)])
        if (signal.aborted) return
        for (const event of events) yield event
        eventsDone.resolve()
        await aborted(signal)
      },
    },
    session: {
      create: mock(async (value: unknown) => ({ id: "root" })),
      command: mock(async (value: unknown) => { prompted.resolve() }),
      prompt: mock(async (value: unknown) => { prompted.resolve() }),
      wait: mock(async ({ sessionID }: { sessionID: string }, request?: { signal?: AbortSignal }) => {
        if (sessionID === "root") await eventsDone.promise
        request?.signal?.throwIfAborted()
      }),
      list: mock(async ({ parentID }: { parentID: string }) => ({
        data: [...sessions.values()].filter((session) => session.parentID === parentID), cursor: { next: null as string | null },
      })),
      get: mock(async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID) ?? { outcome: "succeeded" }),
      interrupt: mock(async (value: { sessionID: string }) => {}),
      form: {
        list: mock(async (value: { sessionID: string }): Promise<{ id: string; sessionID: string }[]> => []),
        cancel: mock(async (value: { sessionID: string; formID: string }, request?: unknown) => {}),
      },
    },
    skill: { list: mock(async () => ({ data: [{ id: "review" }] })) },
    model: { default: mock(async () => ({ data: { providerID: "openai", id: "test-model" } })) },
    permission: {
      list: mock(async (): Promise<{ id: string; sessionID: string; action: string; resources: string[] }[]> => []),
      reply: mock(async (value: unknown) => {}),
    },
    form: { list: mock(async () => ({ location: { directory: "/workspace" }, data: [] as { id: string; sessionID: string }[] })) },
    message: {
      list: mock(async (params: { sessionID: string; limit?: number; cursor?: string; order?: string }) => {
        if (params.cursor && params.order) throw new Error("Cursor cannot be combined with order")
        return { data: messages.get(params.sessionID) ?? [], cursor: { next: null as string | null } }
      }),
    },
  }
  const execute = () => run(client as unknown as Parameters<typeof run>[0], {
    directory: "/workspace", prompt: "Review", write: (text) => output.push(text), ...options,
  })
  return { client, execute, output, events, sessions, messages, prompted, eventsDone }
}
