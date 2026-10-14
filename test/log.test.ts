import { expect, test } from "bun:test"
import { duration, renderLog } from "../src/log"
import { createOutput } from "../src/mask"

test("quiet internal SDK events by default, detailed diagnostics with debug", () => {
  const entry = { level: "info", message: "spawning process", attributes: { command: "git", args: ["status"], cwd: "/workspace" } }
  expect(renderLog(entry)).toBe("")
  expect(renderLog({ level: "info", message: "event" })).toBe("")
  expect(renderLog({ level: "debug", message: "internal" })).toBe("")
  expect(renderLog(entry, true)).toContain('"command":"git"')
  expect(renderLog(entry, true)).toContain('"cwd":"/workspace"')
})

test("warnings retain server/plugin context and error causes", () => {
  const output = renderLog({ level: "warn", message: "mcp connect failed", attributes: { server: "search" }, cause: new Error("connection refused") })
  expect(output).toContain('"server":"search"')
  expect(output).toContain("connection refused")
})

test("debug SDK events show identity without configuration payloads", () => {
  const output = renderLog({ level: "info", message: "event", attributes: {
    event: { type: "config.updated", id: "evt_1", data: { prompt: "private prompt", access: "unknown-access" } },
  } }, true)
  expect(output).toContain("config.updated")
  expect(output).toContain("evt_1")
  expect(output).not.toContain("private prompt")
  expect(output).not.toContain("unknown-access")
})

test("diagnostics redact sensitive fields, handle cycles, and pass through the output mask", () => {
  const attributes: Record<string, unknown> = { token: "unknown-token", config: { apiKey: "unknown-key" }, command: "echo known-secret", env: { VALUE: "unknown-env" } }
  attributes.self = attributes
  const captured: string[] = []
  const stream = { write: (text: string) => { captured.push(text); return true } }
  const output = createOutput({ GH_TOKEN: "known-secret" }, stream, stream)
  output.writeStatus(renderLog({ level: "warn", message: "failed", attributes }))
  const text = captured.join("")
  for (const value of ["unknown-token", "unknown-key", "unknown-env", "known-secret"]) expect(text).not.toContain(value)
  expect(text).toContain("[REDACTED]")
  expect(text).toContain("[circular]")
})

test("durations are readable and remaining time is clamped", () => {
  expect(duration(-1)).toBe("0s")
  expect(duration(59_999)).toBe("59s")
  expect(duration(1_200_000)).toBe("20m 0s")
})

test("long diagnostic strings do not truncate a secret before masking", () => {
  const secret = "secret-".repeat(40)
  const captured: string[] = []
  const stream = { write: (text: string) => { captured.push(text); return true } }
  const output = createOutput({ GH_TOKEN: secret }, stream, stream)
  output.writeStatus(renderLog({ level: "info", message: "spawning process", attributes: { command: `${"x".repeat(1950)}${secret}` } }, true))
  expect(captured.join("")).toContain("[REDACTED]")
  expect(captured.join("")).not.toContain("secret-")
})
