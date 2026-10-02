import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveModel } from "../src/run"
import { aborted, assistant, deferred, fixture } from "./helpers"

test("drains a delayed terminal failure after session.wait settles without an assistant message", async () => {
  const f = fixture()
  const waited = deferred()
  f.messages.set("root", [])
  f.sessions.set("root", { id: "root", outcome: "failed" })
  f.client.session.wait.mockImplementation(async () => { waited.resolve() })
  f.client.event.subscribe = async function* ({ signal }) {
    yield { type: "server.connected", data: {} }
    await waited.promise
    yield { type: "session.execution.failed", data: { sessionID: "root", error: { message: "Model unavailable: openai/test-model" } } }
    await aborted(signal)
  }
  await expect(f.execute()).rejects.toThrow("Model unavailable: openai/test-model")
  expect(f.output.join("")).toContain("Error: Model unavailable: openai/test-model")
})

test("dispatches slash commands", async () => {
  const f = fixture({ prompt: "/review important changes" })
  await f.execute()
  expect(f.client.session.command).toHaveBeenCalledWith({ sessionID: "root", name: "review", text: "important changes", files: undefined }, expect.anything())
  expect(f.client.session.prompt).not.toHaveBeenCalled()
})

test("attaches skill mentions", async () => {
  const f = fixture({ prompt: "Please @review this" })
  await f.execute()
  expect(f.client.session.prompt.mock.calls[0]?.[0]).toMatchObject({ text: "Please @review this", skills: [
    { id: "review", mention: { start: 7, end: 14, text: "@review" } },
  ] })
  expect(f.output.join("")).toContain("> build · test-model · review")
})

test("attaches required skills without a catalog lookup and deduplicates IDs", async () => {
  const f = fixture({ skills: ["review-pr", "security", "review-pr"] })
  await f.execute()
  expect(f.client.skill.list).not.toHaveBeenCalled()
  expect(f.client.session.prompt.mock.calls[0]?.[0]).toMatchObject({ skills: [{ id: "review-pr" }, { id: "security" }] })
})

test("keeps required skills when the cold catalog misses a mention", async () => {
  const f = fixture({ prompt: "Use @review-pr", skills: ["review-pr"] })
  f.client.skill.list.mockResolvedValue({ data: [] })
  await f.execute()
  expect(f.client.session.prompt.mock.calls[0]?.[0]).toMatchObject({ skills: [{ id: "review-pr" }] })
})

test("rejects required skills on slash commands", async () => {
  const f = fixture({ prompt: "/review", skills: ["review-pr"] })
  await expect(f.execute()).rejects.toThrow("--skill cannot be used with slash commands")
  expect(f.client.session.command).not.toHaveBeenCalled()
})

test("selects variants and prints reasoning only when requested", async () => {
  for (const thinking of [false, true]) {
    const f = fixture({ model: "openai/test-model#high", thinking })
    f.messages.set("root", [assistant("msg_root", { type: "reasoning", text: "checking changes" }, { type: "text", text: "summary" })])
    await f.execute()
    expect(f.client.session.create.mock.calls[0]?.[0]).toMatchObject({ model: { providerID: "openai", id: "test-model", variant: "high" } })
    expect(f.output.join("").includes("Thinking: checking changes")).toBe(thinking)
  }
})

test("variant alone selects the default model", async () => {
  const f = fixture({ variant: "high" })
  await f.execute()
  expect(f.client.session.create.mock.calls[0]?.[0]).toMatchObject({ model: { providerID: "openai", id: "test-model", variant: "high" } })
})

test("rejects invalid or conflicting model variants", () => {
  expect(() => resolveModel("not-a-model")).toThrow("Invalid model reference")
  expect(() => resolveModel("openai/test-model#high", "low")).toThrow("conflicts")
})

test("includes text files with the prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-ci-"))
  try {
    const file = join(directory, "notes.txt")
    await writeFile(file, "Check the tests")
    const f = fixture({ files: [file] })
    await f.execute()
    expect(f.client.session.prompt.mock.calls[0]?.[0]).toMatchObject({ text: 'Review\n\n<file name="notes.txt">\nCheck the tests\n</file>' })
  } finally { await rm(directory, { recursive: true }) }
})

test("paginates messages without combining cursor and order", async () => {
  const f = fixture()
  f.client.message.list.mockImplementation(async (params) => ({
    data: [assistant(params.cursor ? "older" : "newer", { type: "text", text: params.cursor ? "old reply" : "new reply" })],
    cursor: { next: params.cursor ? null : "next-page" },
  }))
  await f.execute()
  expect(f.client.message.list.mock.calls.map(([params]) => params)).toEqual([
    { sessionID: "root", limit: 200, order: "desc" }, { sessionID: "root", limit: 200, cursor: "next-page" },
  ])
  expect(f.output.join("").indexOf("old reply")).toBeLessThan(f.output.join("").indexOf("new reply"))
})

test("keeps status and tool output out of redirected assistant stdout", async () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const f = fixture({ write: (text) => stdout.push(text), writeStatus: (text) => stderr.push(text) })
  f.messages.set("root", [assistant("msg_root", {
    type: "tool", id: "read", name: "read", state: { status: "completed", input: { path: "/workspace/app.ts" }, content: [] },
  }, { type: "text", text: "summary" })])
  await f.execute()
  expect(stdout.join("")).toBe("summary\n")
  expect(stderr.join("")).toContain("→ Read app.ts")
  expect(stderr.join("")).toContain("> build · test-model · no skills")
})

test("cancels root, child and same-location global forms, ignoring unrelated forms", async () => {
  const f = fixture({ auto: true })
  f.events.push({ type: "session.created", data: { sessionID: "child", parentID: "root", title: "reviewer" } })
  for (const [id, sessionID, directory] of [
    ["root-form", "root", "/workspace"], ["child-form", "child", "/workspace"],
    ["global-form", "global", "/workspace"], ["foreign-global", "global", "/other"], ["foreign", "other", "/workspace"],
  ]) f.events.push({ type: "form.created", data: { form: { id, sessionID } }, location: { directory: directory! } })
  await expect(f.execute()).rejects.toThrow("Interactive input is unavailable in CI")
  expect(f.client.session.form.cancel.mock.calls.map(([form]) => form.formID)).toEqual(["root-form", "child-form", "global-form"])
  expect(f.client.session.form.cancel.mock.calls[2]?.[1]).toMatchObject({ headers: { "x-opencode-directory": "%2Fworkspace" } })
})

test("reconciles missed form events and tolerates an already-settled form", async () => {
  const f = fixture()
  f.client.session.form.list.mockResolvedValue([{ id: "missed", sessionID: "root" }])
  f.client.session.form.cancel.mockRejectedValue({ _tag: "FormAlreadySettledError" })
  await f.execute()
  expect(f.client.session.form.cancel).toHaveBeenCalledTimes(1)
})

test("handles blockers only once when both admission reconciliation and events see them", async () => {
  const f = fixture({ auto: true })
  const permission = { id: "permission", sessionID: "root", action: "shell", resources: ["ls"] }
  const form = { id: "form", sessionID: "global" }
  f.client.permission.list.mockResolvedValue([permission])
  f.client.form.list.mockResolvedValue({ location: { directory: "/workspace" }, data: [form] })
  f.events.push(
    { type: "permission.asked", data: permission },
    { type: "form.created", data: { form }, location: { directory: "/workspace" } },
  )
  await expect(f.execute()).rejects.toThrow("Interactive input is unavailable in CI")
  expect(f.client.permission.reply).toHaveBeenCalledTimes(1)
  expect(f.client.session.form.cancel).toHaveBeenCalledTimes(1)
})

test("rejects permissions and interrupts promptly, or approves once with --auto", async () => {
  for (const auto of [false, true]) {
    const f = fixture({ auto })
    f.events.push({ type: "permission.asked", data: { id: "permission", sessionID: "root", action: "shell", resources: ["ls"] } })
    if (auto) await f.execute()
    else await expect(f.execute()).rejects.toThrow("Permission denied")
    expect(f.client.permission.reply.mock.calls[0]?.[0]).toMatchObject({ decision: auto ? "once" : "reject" })
    expect(f.client.session.interrupt.mock.calls.length).toBe(auto ? 0 : 1)
  }
})

test("aborting interrupts the active session and cancels its wait", async () => {
  const controller = new AbortController()
  const f = fixture({ signal: controller.signal })
  f.client.session.wait.mockImplementation(async (_, request) => {
    controller.abort(new Error("SIGTERM"))
    request?.signal?.throwIfAborted()
  })
  await expect(f.execute()).rejects.toThrow("SIGTERM")
  expect(f.client.session.interrupt.mock.calls[0]?.[0]).toEqual({ sessionID: "root" })
})

test("cancels and closes a stalled initial subscription", async () => {
  const controller = new AbortController()
  const f = fixture({ signal: controller.signal })
  const connected = deferred()
  let closed = false
  f.client.event.subscribe = async function* ({ signal }) {
    try { connected.resolve(); await aborted(signal) } finally { closed = true }
  }
  const pending = f.execute()
  await connected.promise
  controller.abort(new Error("cancel connect"))
  await expect(pending).rejects.toThrow("cancel connect")
  expect(closed).toBe(true)
  expect(f.client.session.create).not.toHaveBeenCalled()
})

test("stream disconnection aborts outstanding requests instead of waiting for timeout", async () => {
  const f = fixture()
  f.client.event.subscribe = async function* () {
    yield { type: "server.connected", data: {} }
    await f.prompted.promise
  }
  f.client.session.wait.mockImplementation(async (_, request) => {
    await aborted(request!.signal!)
    request!.signal!.throwIfAborted()
  })
  await expect(f.execute()).rejects.toThrow("OpenCode event stream disconnected")
  expect(f.client.session.interrupt).toHaveBeenCalled()
})
