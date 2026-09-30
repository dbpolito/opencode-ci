import { expect, test } from "bun:test"
import { stripVTControlCharacters } from "node:util"
import { createMask } from "../src/mask"
import type { Auth } from "../src/auth"
import { assistant, fixture } from "./helpers"

const auth = {
  openai: {
    type: "oauth", methodID: "chatgpt-browser", access: "oauth-access-value", refresh: "oauth-refresh-value", expires: 123456,
    metadata: { accountID: "private-account-id" },
  },
  anthropic: { type: "key", key: "provider-key-value", configuration: { headers: { authorization: "custom-header-secret" } } },
} satisfies Auth

test("masks sensitive environment values literally, longest matches first", () => {
  const mask = createMask({
    OPENAI_API_KEY: "secret.+[key]", GH_TOKEN: "opaque-token", OTHER_TOKEN: "opaque-token-extended",
    AWS_SECRET_ACCESS_KEY: "aws-secret", DATABASE_PASSWORD: "database-password", PATH: "/usr/bin",
  })
  expect(mask.redact("secret.+[key] opaque-token-extended opaque-token aws-secret database-password /usr/bin"))
    .toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] /usr/bin")
  expect(mask.redact("opaque-token again")).toBe("[REDACTED] again")
  expect(createMask({ EMPTY_TOKEN: "" }).redact("plain output")).toBe("plain output")
})

test("masks auth credentials and metadata without changing the auth data", () => {
  const mask = createMask({})
  const original = JSON.stringify(auth)
  mask.auth(auth)
  const result = JSON.parse(mask.redact(original))
  expect(result.openai.access).toBe("[REDACTED]")
  expect(result.openai.refresh).toBe("[REDACTED]")
  expect(result.openai.metadata.accountID).toBe("[REDACTED]")
  expect(result.anthropic.key).toBe("[REDACTED]")
  expect(result.anthropic.configuration.headers.authorization).toBe("[REDACTED]")
  expect(result.openai.methodID).toBe("chatgpt-browser")
  expect(JSON.stringify(auth)).toBe(original)
})

test("masks JSON-escaped, URL-encoded and prefixed multiline values", () => {
  const secret = 'secret"\\value?with=characters&more'
  const mask = createMask({ API_KEY: secret, PRIVATE_KEY: "first-private-line\nsecond-private-line" })
  expect(mask.redact(JSON.stringify({ key: secret }))).toBe('{"key":"[REDACTED]"}')
  expect(mask.redact(`https://example.com/?key=${encodeURIComponent(secret)}`))
    .toBe("https://example.com/?key=[REDACTED]")
  expect(mask.redact("child first-private-line\nchild second-private-line"))
    .toBe("child [REDACTED]\nchild [REDACTED]")
})

test("retains old masks after token rotation", () => {
  const mask = createMask({})
  mask.auth(auth)
  expect(mask.redact(auth.openai.access)).toBe("[REDACTED]")
  const refreshed = { ...auth, openai: { ...auth.openai, access: "rotated-access-value", refresh: "rotated-refresh-value" } }
  mask.auth(refreshed)
  mask.auth(refreshed)
  expect(mask.redact("oauth-access-value oauth-refresh-value rotated-access-value rotated-refresh-value"))
    .toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED]")
})

test("redacts assistant, reasoning, child and tool output on both channels", async () => {
  const mask = createMask({ OPENAI_API_KEY: "environment-key-value" })
  mask.auth(auth)
  const stdout: string[] = []
  const stderr: string[] = []
  const f = fixture({ thinking: true, write: (text) => stdout.push(mask.redact(text)), writeStatus: (text) => stderr.push(mask.redact(text)) })
  f.messages.set("root", [assistant("msg_root",
    { type: "text", text: "Using environment-key-value" },
    { type: "reasoning", text: "Checking oauth-access-value" },
    { type: "tool", id: "shell", name: "shell", state: {
      status: "error", input: { command: "echo provider-key-value" },
      content: [{ type: "text", text: JSON.stringify(auth) }], error: { message: "Failed oauth-refresh-value" },
    } },
    { type: "tool", id: "custom", name: "custom", state: {
      status: "completed", input: { credential: "custom-header-secret" }, content: [],
    } },
  )])
  f.sessions.set("child", { id: "child", parentID: "root", title: "private-account-id", outcome: "succeeded" })
  f.messages.set("child", [assistant("msg_child", { type: "text", text: "Child oauth-access-value" })])
  await f.execute()
  expect(stdout.join("")).toContain("Using [REDACTED]")
  expect(stdout.join("")).toContain("Thinking: Checking [REDACTED]")
  expect(stripVTControlCharacters(stdout.join(""))).toContain("[REDACTED] Child [REDACTED]")
  expect(stderr.join("")).toContain("$ echo [REDACTED]")
  expect(stderr.join("")).toContain("Failed [REDACTED]")
  expect(stderr.join("")).toContain('custom {"credential":"[REDACTED]"}')
  for (const secret of ["environment-key-value", auth.openai.access, auth.openai.refresh, auth.anthropic.key, "custom-header-secret", "private-account-id"]) {
    expect(stdout.join("") + stderr.join("")).not.toContain(secret)
  }
})
