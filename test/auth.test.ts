import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { OpenCode } from "@opencode/sdk"
import { getAuth, loadAuthIfExists, parseAuth, saveAuth, setAuth } from "../src/auth"

const fixture = {
  openai: { type: "oauth" as const, methodID: "chatgpt-browser", access: "test-access", refresh: "test-refresh", expires: 123456, metadata: { accountID: "test-account" } },
  anthropic: { type: "key" as const, key: "test-key" },
}

test("validates credentials and upgrades legacy OpenAI auth", () => {
  expect(() => parseAuth("not json")).toThrow("Invalid auth JSON")
  expect(() => parseAuth(JSON.stringify({ openai: { type: "oauth", access: "test" } }))).toThrow("Invalid OAuth credential")
  expect(() => parseAuth(JSON.stringify({ anthropic: { type: "key", key: "secret", extra: "ignored?" } }))).toThrow("Invalid key credential")
  expect(parseAuth(JSON.stringify({ openai: { type: "oauth", access: "a", refresh: "r", expires: 123, accountId: "account" } })))
    .toEqual({ openai: { type: "oauth", methodID: "chatgpt-browser", access: "a", refresh: "r", expires: 123, metadata: { accountID: "account" } } })
})

test("loads an optional default auth file without ignoring invalid credentials", async () => {
  const temp = await mkdtemp(join(tmpdir(), "opencode-ci-optional-auth-test-"))
  const path = join(temp, "opencode-ci.auth.json")
  try {
    expect(await loadAuthIfExists(path)).toBeUndefined()
    await saveAuth(path, fixture)
    expect(await loadAuthIfExists(path)).toEqual(fixture)
    await Bun.write(path, "invalid JSON")
    await expect(loadAuthIfExists(path)).rejects.toThrow("Invalid auth JSON")
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test("does not rewrite unchanged credentials and still protects the file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "opencode-ci-unchanged-auth-test-"))
  const path = join(temp, "auth.json")
  try {
    const original = JSON.stringify(fixture, null, 2)
    await writeFile(path, original)
    await chmod(path, 0o644)
    const before = await stat(path)
    await saveAuth(path, fixture)
    const after = await stat(path)
    expect(await readFile(path, "utf8")).toBe(original)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.mode & 0o777).toBe(0o600)

    await saveAuth(path, { ...fixture, openai: { ...fixture.openai, refresh: "new-refresh" } })
    expect(JSON.parse(await readFile(path, "utf8")).openai.refresh).toBe("new-refresh")
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test("imports and exports OAuth and key credentials through an isolated SDK database", async () => {
  const temp = await mkdtemp(join(tmpdir(), "opencode-ci-auth-test-"))
  const path = join(temp, "db.sqlite")
  const output = join(temp, "auth.json")
  try {
    const host = await OpenCode.create({ database: { path } })
    try {
      setAuth(path, parseAuth(JSON.stringify(fixture)))
      const list = await host.integration.list({ location: { directory: temp } })
      const openai = list.data.find((item) => item.id === "openai")
      expect(openai?.connections.some((item) => item.type === "credential")).toBe(true)
      const anthropic = list.data.find((item) => item.id === "anthropic")
      expect(anthropic?.connections.some((item) => item.type === "credential")).toBe(true)
      // Simulate the provider persisting a rotated OAuth token during the run.
      const db = new DatabaseSync(path)
      try {
        db.prepare("UPDATE credential SET value = ? WHERE integration_id = 'openai'").run(JSON.stringify({
          ...fixture.openai, access: "rotated-access", refresh: "rotated-refresh",
        }))
      } finally { db.close() }
    } finally { await host.close() }
    const updated = { ...fixture, openai: { ...fixture.openai, access: "rotated-access", refresh: "rotated-refresh" } }
    expect(getAuth(path, Object.keys(fixture))).toEqual(updated)
    await saveAuth(output, getAuth(path, Object.keys(fixture)))
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(updated)
    expect((await stat(output)).mode & 0o777).toBe(0o600)
    execFileSync(process.execPath, ["src/cli.ts", "auth", "export", "--db", path, "--integration", "openai"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, HOME: temp },
    })
    const defaultOutput = join(temp, "opencode-ci.auth.json")
    expect(JSON.parse(await readFile(defaultOutput, "utf8"))).toEqual({ openai: updated.openai })
    expect((await stat(defaultOutput)).mode & 0o777).toBe(0o600)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
