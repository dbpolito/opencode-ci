import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { OpenCode } from "@opencode/sdk"
import packageJSON from "../package.json" with { type: "json" }
import { noninteractive } from "../src/noninteractive.ts"

// Keep stdin open: the CLI's own timeout must cancel the read before SDK startup.
const stdinTimeout = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["dist/cli.js", "run", "--timeout", "0.05", "Hello"], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text })
  child.on("error", reject)
  const deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI did not time out while reading stdin")) }, 15_000)
  child.on("close", (code) => { clearTimeout(deadline); resolve({ code, stderr }) })
})
assert.equal(stdinTimeout.code, 124, stdinTimeout.stderr)
assert.match(stdinTimeout.stderr, /Timed out after 0.05s/)

const help = spawnSync(process.execPath, ["dist/cli.js", "--help"], { encoding: "utf8" })
assert.equal(help.status, 0, help.stderr)
assert.match(help.stdout, /Usage: opencode-ci/)
const runHelp = spawnSync(process.execPath, ["dist/cli.js", "run", "--help"], { encoding: "utf8" })
assert.equal(runHelp.status, 0, runHelp.stderr)
assert.match(runHelp.stdout, /--auth-output/)
assert.match(runHelp.stdout, /--skip-project-config/)
const version = spawnSync(process.execPath, ["dist/cli.js", "--version"], { encoding: "utf8" })
assert.equal(version.status, 0, version.stderr)
assert.equal(version.stdout.trim(), packageJSON.version)
const missingCommand = spawnSync(process.execPath, ["dist/cli.js", "Hello"], { encoding: "utf8" })
assert.equal(missingCommand.status, 1, missingCommand.stderr)
assert.match(missingCommand.stderr, /unknown command 'Hello'/)
const conflict = spawnSync(process.execPath, ["dist/cli.js", "run", "--auth-file", "unused.json", "--auth-env", "TEST_AUTH", "Hello"], { encoding: "utf8" })
assert.equal(conflict.status, 1, conflict.stderr)
assert.match(conflict.stderr, /cannot be used with option/)

const maskedArgument = spawnSync(process.execPath, ["dist/cli.js", "test-api-key-value"], {
  encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "test-api-key-value", GITHUB_ACTIONS: "false" },
})
assert.equal(maskedArgument.status, 1, maskedArgument.stderr)
assert.match(maskedArgument.stderr, /unknown command '\[REDACTED\]'/)
assert.ok(!maskedArgument.stderr.includes("test-api-key-value"))

const invalid = spawnSync(process.execPath, ["dist/cli.js", "run", "--model", "invalid", "Hello"], {
  encoding: "utf8", timeout: 60_000,
})
assert.equal(invalid.status, 1, invalid.error?.message ?? invalid.stderr)
assert.match(invalid.stderr, /Invalid model reference/)

const unavailable = spawnSync(process.execPath, ["dist/cli.js", "run", "--model", "missing/test", "--timeout", "15", "Hello"], {
  encoding: "utf8", timeout: 30_000,
})
assert.equal(unavailable.status, 1, unavailable.error?.message ?? unavailable.stderr)
assert.match(unavailable.stderr, /Model unavailable: missing\/test/)

const catalog = spawnSync(process.execPath, ["--input-type=module", "-e", `
  import assert from 'node:assert/strict';
  import { OpenCode } from '@opencode/sdk';
  const host = await OpenCode.create({ database: { path: ':memory:' }, config: { project: false } });
  try {
    await host.integration.list();
    const models = await host.model.list();
    assert.ok(models.data.some(model => model.providerID === 'openai' && model.id === 'gpt-6.1-sol'), 'SDK catalog must support the configured review model');
  } finally { await host.close(); }
`], { encoding: "utf8", timeout: 30_000, env: { ...process.env, OPENAI_API_KEY: "smoke-test-key" } })
assert.equal(catalog.status, 0, catalog.error?.message ?? catalog.stderr)

const temp = mkdtempSync(join(tmpdir(), "opencode-ci-smoke-"))
try {
  const auth = {
    openai: { type: "oauth", methodID: "chatgpt-browser", access: "test-access", refresh: "test-refresh", expires: 123456, metadata: { accountID: "test-account" } },
    anthropic: { type: "key", key: "test-key" },
  }
  const output = join(temp, "refreshed.json")
  const failed = spawnSync(process.execPath, ["dist/cli.js", "run", "--auth-env", "TEST_AUTH", "--auth-output", output, "--model", "test-access:test-refresh:test-key:test-account", "Hello"], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, TEST_AUTH: JSON.stringify(auth), GITHUB_ACTIONS: "false" },
  })
  assert.equal(failed.status, 1, failed.error?.message ?? failed.stderr)
  assert.match(failed.stderr, /Invalid model reference/)
  assert.match(failed.stderr, /\[REDACTED\]:\[REDACTED\]:\[REDACTED\]:\[REDACTED\]/)
  for (const value of [auth.openai.access, auth.openai.refresh, auth.anthropic.key, auth.openai.metadata.accountID]) {
    assert.ok(!(failed.stdout + failed.stderr).includes(value))
  }
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), auth)
  assert.equal(statSync(output).mode & 0o777, 0o600)

  const dbPath = join(temp, "opencode.db")
  let tools = []
  const host = await OpenCode.create({ database: { path: dbPath }, plugins: [noninteractive, {
    id: "opencode-ci.smoke",
    async setup(ctx) { tools = (await ctx.tool.list()).map((tool) => tool.id) },
  }] })
  try {
    const session = await host.session.create({ location: { directory: temp } })
    const child = await host.session.create({ parentID: session.id })
    await host.integration.list({ location: child.location })
    assert.ok(tools.includes("shell"), "SDK tools were not activated")
    assert.ok(!tools.includes("question"), "question must not be registered, including for child sessions")

    const variables = { CI: "true", GITHUB_ACTIONS: "true", PR_NUMBER: "123", OPENCODE_CI_TEST: "inherited" }
    const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]))
    try {
      Object.assign(process.env, variables)
      const script = `require('node:fs').writeFileSync('environment.json', JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(variables))}.map(key => [key, process.env[key]]))))`
      await host.session.shell({ sessionID: session.id, command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` })
      await host.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15_000) })
      assert.deepEqual(JSON.parse(readFileSync(join(temp, "environment.json"), "utf8")), variables)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  } finally { await host.close() }
  for (const provider of [undefined, "exa", false]) {
    const directory = join(temp, `websearch-${String(provider)}`)
    mkdirSync(directory)
    const configuration = provider === undefined ? {} : { websearch: provider === false ? false : { provider } }
    const script = `
      import assert from 'node:assert/strict';
      import { OpenCode } from ${JSON.stringify(import.meta.resolve("@opencode/sdk"))};
      import { noninteractive } from ${JSON.stringify(new URL("../src/noninteractive.ts", import.meta.url).href)};
      const host = await OpenCode.create({
        config: { project: false, content: ${JSON.stringify(JSON.stringify(configuration))} },
        database: { path: ${JSON.stringify(join(directory, "opencode.db"))} },
        plugins: [noninteractive, {
          id: 'opencode-ci.smoke.websearch',
          async setup(ctx) {
            await ctx.websearch.transform(editor => {
              for (const id of ['exa', 'firecrawl', 'parallel', 'tavily', 'tinyfish'])
                editor.add({ id, name: id, execute: async () => [] });
            });
          },
        }],
      });
      try {
        await host.integration.list();
        await host.websearch.providers();
        ${provider === false ? `await assert.rejects(host.websearch.query({ query: 'smoke' }), /disabled/i);` : `const result = await host.websearch.query({ query: 'smoke' });
        ${provider === undefined ? `assert.ok(['exa', 'firecrawl', 'parallel', 'tavily', 'tinyfish'].includes(result.data.providerID));` : `assert.equal(result.data.providerID, ${JSON.stringify(provider)});`}`}
      } finally { await host.close(); }
    `
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: directory, encoding: "utf8", timeout: 60_000 })
    assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  }
  const db = new DatabaseSync(dbPath)
  try {
    const insert = db.prepare(`INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)
      VALUES (?, ?, ?, ?, 1, ?, ?)`)
    insert.run("cred_test_openai", "openai", "OAuth", JSON.stringify(auth.openai), Date.now(), Date.now())
    insert.run("cred_test_anthropic", "anthropic", "Key", JSON.stringify(auth.anthropic), Date.now(), Date.now())
  } finally { db.close() }
  const exported = join(temp, "export.json")
  const result = spawnSync(process.execPath, ["dist/cli.js", "auth", "export", "--db", dbPath, "--integration", "openai", "--integration", "anthropic", "--output", exported], { encoding: "utf8" })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(exported, "utf8")), auth)
  assert.equal(statSync(exported).mode & 0o777, 0o600)

  const project = join(temp, "project")
  mkdirSync(project)
  const plugin = join(temp, ".opencode", "plugins", "smoke")
  mkdirSync(plugin, { recursive: true })
  const marker = join(temp, "plugin-loaded")
  writeFileSync(join(plugin, "index.js"), `import { writeFileSync } from "node:fs";
    export default { id: "smoke.project", async setup(ctx) {
      writeFileSync(${JSON.stringify(marker)}, "loaded");
      await ctx.command.transform(editor => editor.add({ name: "noop", execute: async () => {} }));
    } }`)
  const noop = spawnSync(process.execPath, ["dist/cli.js", "run", "--directory", project, "--timeout", "15", "/noop"], {
    encoding: "utf8", timeout: 30_000,
  })
  assert.equal(noop.status, 0, noop.error?.message ?? noop.stderr)
  for (const skip of [false, true]) {
    rmSync(marker, { force: true })
    const host = await OpenCode.create({
      database: { path: join(temp, `config-${skip}.db`) },
      ...(skip ? { config: { project: false } } : {}),
    })
    try {
      await host.integration.list({ location: { directory: project } }, { signal: AbortSignal.timeout(15_000) })
      assert.equal(existsSync(marker), !skip, "project plugin discovery must follow config.project")
    } finally { await host.close() }
  }
} finally { rmSync(temp, { recursive: true, force: true }) }
console.log("Node CLI and embedded OpenCode SDK smoke test passed")
