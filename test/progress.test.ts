import { expect, test } from "bun:test"
import { aborted, deferred, fixture } from "./helpers"

test("prints starts before tool results and reports timeouts and exit status", async () => {
  const f = fixture()
  const data = { sessionID: "root", assistantMessageID: "message", id: "test" }
  f.client.event.subscribe = async function* ({ signal }) {
    yield { type: "server.connected", data: {} }
    await f.prompted.promise
    yield { type: "session.tool.input.started", data: { ...data, name: "shell" } }
    yield { type: "session.tool.called", data: { ...data, input: { command: "kool run test", timeout: 1_200_000, workdir: "/tests" } } }
    expect(f.output.join("")).toContain("$ kool run test · running · cwd=/tests · timeout=20m 0s")
    expect(f.output.join("")).not.toContain("test result")
    yield { type: "session.tool.progress", data: { ...data, metadata: { shellID: "shell_1" } } }
    expect(f.output.join("")).not.toContain("shellID=shell_1")
    yield { type: "session.tool.success", data: { ...data, content: [{ type: "text", text: "test result" }], metadata: { timeout: true, exit: 130 } } }
    yield { type: "session.execution.succeeded", data: { sessionID: "root" } }
    f.eventsDone.resolve()
    await aborted(signal)
  }
  await f.execute()
  expect(f.output.join("")).toContain("$ kool run test · timed out · 0s · exit=130")
  expect(f.output.join("")).not.toContain("message:test")
  expect(f.output.join("").match(/test result/g)).toHaveLength(1)
})

test("progress identifies active work, remaining time, and cancellation; timer stops", async () => {
  const controller = new AbortController()
  const heartbeat = deferred()
  const output: string[] = []
  const f = fixture({ signal: controller.signal, progressInterval: 10, deadline: Date.now() + 60_000, write: (text) => {
    output.push(text)
    if (text.includes("$ sleep 100 · running · 0s")) heartbeat.resolve()
  } })
  const data = { sessionID: "root", assistantMessageID: "message", id: "test" }
  f.client.event.subscribe = async function* ({ signal }) {
    yield { type: "server.connected", data: {} }
    await f.prompted.promise
    yield { type: "session.tool.input.started", data: { ...data, name: "shell" } }
    yield { type: "session.tool.called", data: { ...data, input: { command: "sleep 100" } } }
    await aborted(signal)
  }
  f.client.session.wait.mockImplementation(async (_, request) => {
    await aborted(request!.signal!)
    request!.signal!.throwIfAborted()
  })
  const pending = f.execute()
  await heartbeat.promise
  controller.abort(new Error("SIGTERM"))
  await expect(pending).rejects.toThrow("SIGTERM")
  expect(output.join("")).toContain("remaining=")
  expect(output.join("")).toContain("active tools=1")
  expect(output.join("")).toContain("$ sleep 100")
  expect(output.join("")).toContain("[run] Cancelled")
  expect(output.join("")).toContain("interruption acknowledged")
  const count = output.length
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(output).toHaveLength(count)
})

test("debug reports event types without dumping event payloads", async () => {
  const f = fixture({ debug: true, progressInterval: 0 })
  f.events.push({ type: "session.step.started", data: { sessionID: "root", assistantMessageID: "message", agent: "build", model: { id: "model" }, private: "not-printed" } })
  await f.execute()
  expect(f.output.join("")).toContain("[debug] session.step.started")
  expect(f.output.join("")).not.toContain("not-printed")
})
