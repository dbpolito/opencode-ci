import { expect, test } from "bun:test"
import { stripVTControlCharacters } from "node:util"
import { aborted, assistant, deferred, fixture, subagent, toolEvents } from "./helpers"
import type { RunOptions } from "../src/run"

function childrenFixture(options: Partial<RunOptions> = {}, titles = ["First task", "Second task"]) {
  const f = fixture(options)
  titles.forEach((title, index) => {
    const id = `child_${index}`
    f.sessions.set(id, { id, title, parentID: "root", outcome: "succeeded" })
    f.messages.set(id, [assistant(`msg_${id}`, { type: "text", text: `Reply from ${id}` })])
  })
  f.messages.set("root", [assistant("msg_root", ...titles.map((title, index) => subagent(`tool_${index}`, title, `child_${index}`)))])
  return f
}

test("recovers parallel child transcripts before their completion without duplicate output", async () => {
  const f = childrenFixture()
  await f.execute()
  const output = stripVTControlCharacters(f.output.join(""))
  for (const [index, title] of ["First task", "Second task"].entries()) {
    expect(output.indexOf(`${title} Reply from child_${index}`)).toBeGreaterThan(-1)
    expect(output.indexOf(`${title} Reply from child_${index}`)).toBeLessThan(output.indexOf(`${title} ✓ General Agent`))
  }
  expect(output.match(/✓ General Agent/g)).toHaveLength(2)
  expect(output.match(/Reply from/g)).toHaveLength(2)
})

test("prints alternating child events live before either child completes", async () => {
  const f = childrenFixture({ thinking: true })
  f.client.event.subscribe = async function* ({ signal }) {
    yield { type: "server.connected", data: {} }
    await f.prompted.promise
    for (const [index, title] of ["First task", "Second task"].entries()) {
      yield { type: "session.created", data: { sessionID: `child_${index}`, parentID: "root", title } }
    }
    for (const [index, type, text] of [
      [0, "reasoning", "First thinking"],
      [1, "reasoning", "Second thinking"],
      [0, "text", "Reply from child_0"],
      [1, "text", "Reply from child_1"],
    ] as const) {
      yield { type: `session.${type}.ended`, data: {
        sessionID: `child_${index}`, assistantMessageID: `msg_child_${index}`, ordinal: 0, text,
      } }
      expect(f.output.at(-1)).toContain(text)
      expect(f.output.join("")).not.toContain("✓")
      expect(f.client.message.list).not.toHaveBeenCalled()
    }
    f.eventsDone.resolve()
    await aborted(signal)
  }
  await f.execute()
  expect(f.output.join("").match(/Reply from/g)).toHaveLength(2)
})

test("keeps reading other children while completion recovery is waiting", async () => {
  const release = deferred()
  const output: string[] = []
  const f = childrenFixture({ write: (text) => {
    text = stripVTControlCharacters(text)
    output.push(text)
    if (text.includes("Second task Reply")) release.resolve()
  } })
  const list = f.client.session.list.getMockImplementation()!
  let held = false
  f.client.session.list.mockImplementation(async (params) => {
    if (!held) { held = true; await release.promise }
    return list(params)
  })
  f.events.push(
    { type: "session.created", data: { sessionID: "child_1", parentID: "root", title: "Second task" } },
    ...toolEvents("tool_0", "First task", "child_0"),
    { type: "session.text.ended", data: { sessionID: "child_1", assistantMessageID: "msg_child_1", ordinal: 0, text: "Reply from child_1" } },
  )
  await f.execute()
  expect(output.join("").indexOf("Second task Reply")).toBeLessThan(output.join("").indexOf("First task ✓"))
  expect(output.join("").match(/Reply from child_1/g)).toHaveLength(1)
}, 2000)

test("matches child IDs when descriptions are identical", async () => {
  const release = deferred()
  const output: string[] = []
  const f = childrenFixture({ write: (text) => {
    text = stripVTControlCharacters(text)
    output.push(text)
    if (text.includes("Same task ✓")) release.resolve()
  } }, ["Same task", "Same task"])
  const wait = f.client.session.wait.getMockImplementation()!
  f.client.session.wait.mockImplementation(async (params, request) => {
    if (params.sessionID === "child_1") await release.promise
    return wait(params, request)
  })
  f.events.push(...toolEvents("tool_0", "Same task", "child_0"))
  await f.execute()
  const text = output.join("")
  expect(text.indexOf("Reply from child_0")).toBeLessThan(text.indexOf("Same task ✓"))
  expect(text.indexOf("Same task ✓")).toBeLessThan(text.indexOf("Reply from child_1"))
}, 2000)

test("replays a resumed child's new messages before its next completion", async () => {
  const first = deferred()
  const second = deferred()
  const output: string[] = []
  const f = childrenFixture({ write: (text) => {
    text = stripVTControlCharacters(text)
    output.push(text)
    if (text.includes("First task ✓")) first.resolve()
    if (text.includes("Follow-up ✓")) second.resolve()
  } }, ["First task"])
  f.client.event.subscribe = async function* ({ signal }) {
    yield { type: "server.connected", data: {} }
    await f.prompted.promise
    yield* toolEvents("tool_0", "First task", "child_0")
    await first.promise
    f.messages.get("child_0")!.unshift(assistant("msg_followup", { type: "text", text: "Follow-up reply" }))
    yield* toolEvents("tool_1", "Follow-up", "child_0")
    await second.promise
    f.eventsDone.resolve()
    await aborted(signal)
  }
  await f.execute()
  const text = output.join("")
  expect(text.indexOf("Follow-up reply")).toBeGreaterThan(-1)
  expect(text.indexOf("Follow-up reply")).toBeLessThan(text.indexOf("Follow-up ✓"))
  expect(text.match(/Follow-up reply/g)).toHaveLength(1)
}, 2000)

test("fails when a child session fails", async () => {
  const f = childrenFixture()
  f.sessions.get("child_0")!.outcome = "failed"
  await expect(f.execute()).rejects.toThrow("Session child_0 failed")
})

test("uses dim child prefixes in terminals and Actions, respecting NO_COLOR", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
  const github = process.env.GITHUB_ACTIONS
  const noColor = process.env.NO_COLOR
  try {
    for (const tty of [false, true]) {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty })
      process.env.GITHUB_ACTIONS = "true"
      delete process.env.NO_COLOR
      const f = childrenFixture({ thinking: true }, ["First task"])
      f.messages.get("child_0")![0]!.content.push({ type: "reasoning", text: "checking" })
      await f.execute()
      expect(f.output.join("")).toContain("\x1b[90mFirst task\x1b[0m")
      if (tty) expect(f.output.join("")).toContain("\x1b[3mThinking: checking")
    }
    process.env.NO_COLOR = "1"
    const f = childrenFixture()
    await f.execute()
    expect(f.output.join("")).not.toContain("\x1b[")
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor)
    else Reflect.deleteProperty(process.stdout, "isTTY")
    if (github === undefined) delete process.env.GITHUB_ACTIONS
    else process.env.GITHUB_ACTIONS = github
    if (noColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = noColor
  }
})
