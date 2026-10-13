#!/usr/bin/env node
import { OpenCode } from "@opencode/sdk"
import { Command, Option } from "commander"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { text } from "node:stream/consumers"
import { addAbortSignal } from "node:stream"
import { format } from "node:util"
import packageJSON from "../package.json" with { type: "json" }
import { getAuth, loadAuth, loadAuthIfExists, parseAuth, saveAuth, setAuth, type Auth } from "./auth"
import { run } from "./run"
import { noninteractive } from "./noninteractive"
import { createOutput } from "./mask"
import { listModels } from "./models"

let currentAuth: (() => Auth) | undefined
const mask = createOutput(process.env, process.stdout, process.stderr, () => currentAuth?.())
const { write, writeStatus } = mask

// Some SDK/plugin diagnostics use console directly rather than the host logger.
// Keep stdout machine-readable and apply the same secret masking to those logs.
for (const method of ["log", "info", "debug", "warn", "error"] as const)
  console[method] = (...args: unknown[]) => writeStatus(`${format(...args)}\n`)

const collect = (value: string, previous: string[]) => [...previous, value]

type HostFlags = {
  directory?: string
  skipProjectConfig?: boolean
  timeout: string
  authFile?: string
  authEnv?: string
  authOutput?: string
}

type RunFlags = HostFlags & {
  model?: string
  variant?: string
  agent?: string
  skill: string[]
  file: string[]
  title?: string
  thinking?: boolean
  auto?: boolean
}

let cancellation: "SIGINT" | "SIGTERM" | "timeout" | undefined
let timeoutSeconds = 2700

async function executeWithHost(
  options: HostFlags,
  task: (client: OpenCode.Interface, directory: string, signal: AbortSignal) => Promise<void>,
  prepare?: (signal: AbortSignal) => Promise<void>,
) {
  const defaultAuthFile = join(homedir(), "opencode-ci.auth.json")
  const directory = resolve(options.directory ?? process.cwd())
  timeoutSeconds = Number(options.timeout)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds * 1000 > 2_147_483_647)
    throw new Error("--timeout must be positive seconds, at most 2147483.647")

  const controller = new AbortController()
  const cancel = (reason: "SIGINT" | "SIGTERM" | "timeout") => {
    // A second cancellation is a hard stop if a provider or cleanup is stuck.
    if (cancellation) process.exit(cancellation === "SIGTERM" ? 143 : cancellation === "SIGINT" ? 130 : 124)
    cancellation = reason
    process.exitCode = reason === "SIGINT" ? 130 : reason === "SIGTERM" ? 143 : 124
    controller.abort(new Error(reason))
    // CI may send only one signal; do not leave a stuck provider or request running forever.
    setTimeout(() => process.exit(process.exitCode ?? 1), 10_000).unref()
  }
  const interrupt = () => cancel("SIGINT")
  const terminate = () => cancel("SIGTERM")
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  const timer = setTimeout(() => cancel("timeout"), timeoutSeconds * 1000)
  try {
    await prepare?.(controller.signal)
    controller.signal.throwIfAborted()
    const implicitAuth = !options.authFile && !options.authEnv
    const auth = options.authFile ? await loadAuth(options.authFile) : options.authEnv ? parseAuth(process.env[options.authEnv] ?? "") : await loadAuthIfExists(defaultAuthFile)
    if (auth) mask.auth(auth)
    if (options.authOutput && !auth) throw new Error("--auth-output requires an auth file or --auth-env")
    const authOutput = options.authOutput ?? (implicitAuth && auth ? defaultAuthFile : undefined)
    const temp = await mkdtemp(join(tmpdir(), "opencode-ci-"))
    const db = join(temp, "opencode.db")
    try {
      const opencode = await OpenCode.create({
        database: { path: db }, plugins: [noninteractive],
        log: { emit: (entry) => writeStatus(`[${entry.level}] ${entry.message}\n`) },
        ...(options.skipProjectConfig ? { config: { project: false } } : {}),
      })
      try {
        if (auth) {
          setAuth(db, auth)
          currentAuth = () => getAuth(db, Object.keys(auth))
        }
        controller.signal.throwIfAborted()
        await task(opencode, directory, controller.signal)
      } finally {
        await opencode.close()
        // Save refreshed tokens even if the session failed. Never print secrets to stdout.
        if (auth) {
          const refreshed = getAuth(db, Object.keys(auth))
          mask.auth(refreshed)
          if (authOutput) await saveAuth(authOutput, refreshed)
        }
      }
    } finally {
      currentAuth = undefined
      await rm(temp, { recursive: true, force: true })
    }
  } finally {
    clearTimeout(timer)
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
}

async function executeRun(words: string[], options: RunFlags) {
  let prompt = ""
  await executeWithHost(options, async (client, directory, signal) => {
    const files = options.file.map((file) => resolve(directory, file))
    await run(client, {
      directory, model: options.model, variant: options.variant, agent: options.agent, skills: options.skill, files,
      title: options.title, thinking: options.thinking, auto: options.auto, prompt, signal, write, writeStatus,
    })
  }, async (signal) => {
    const piped = process.stdin.isTTY ? "" : (await text(addAbortSignal(signal, process.stdin))).trim()
    prompt = [words.join(" "), piped].filter(Boolean).join("\n")
    if (!prompt.trim()) throw new Error("Provide a prompt or pipe one through stdin")
  })
}

const program = new Command()
  .name("opencode-ci")
  .description("Run OpenCode V2 in CI with subagent output")
  .version(packageJSON.version, "-v, --version")
  .showHelpAfterError()
  .configureOutput({ writeOut: write, writeErr: writeStatus })

const command = program.command("run")
  .description("Run a prompt (or pipe one through stdin)")
  .argument("[prompt...]", "prompt text")
  .option("--directory <path>", "project directory (default: current directory)")
  .option("-m, --model <provider/model#variant>", "model and optional variant")
  .option("--variant <name>", "model variant")
  .option("--agent <name>", "agent name")
  .option("--skill <id>", "require a skill (repeatable)", collect, [])
  .option("-f, --file <path>", "include a file (repeatable)", collect, [])
  .option("--title <title>", "session title")
  .option("--thinking", "print reasoning blocks")
  .option("--auto", "approve permission requests once")
  .option("--skip-project-config", "skip project and ancestor config discovery, including project plugins")
  .option("--timeout <seconds>", "timeout in seconds", "2700")
  .addOption(new Option("--auth-file <path>", "read auth JSON from a file (default: ~/opencode-ci.auth.json if present)").conflicts("authEnv"))
  .addOption(new Option("--auth-env <name>", "read auth JSON from an environment variable").conflicts("authFile"))
  .option("--auth-output <path>", "save refreshed auth JSON to a file (default: update ~/opencode-ci.auth.json when used)")

command.action(async (words: string[], options: RunFlags) => {
  await executeRun(words, options)
})

program.command("models")
  .description("List available models using CI credentials and project configuration")
  .argument("[provider]", "filter by provider ID")
  .option("--json", "print model IDs and names as JSON")
  .option("--directory <path>", "project directory (default: current directory)")
  .option("--skip-project-config", "skip project and ancestor config discovery, including project plugins")
  .option("--timeout <seconds>", "timeout in seconds", "120")
  .addOption(new Option("--auth-file <path>", "read auth JSON from a file (default: ~/opencode-ci.auth.json if present)").conflicts("authEnv"))
  .addOption(new Option("--auth-env <name>", "read auth JSON from an environment variable").conflicts("authFile"))
  .option("--auth-output <path>", "save refreshed auth JSON to a file (default: update ~/opencode-ci.auth.json when used)")
  .action(async (provider: string | undefined, options: HostFlags & { json?: boolean }) => {
    await executeWithHost(options, async (client, directory, signal) => {
      write(await listModels(client, { directory, provider, json: options.json, signal }))
    })
  })

program.command("auth")
  .description("Manage auth JSON for CI")
  .command("export")
  .description("Export saved credentials from a local OpenCode database")
  .requiredOption("--db <path>", "OpenCode V2 database path")
  .option("--integration <id>", "integration to export (repeatable)", collect, [])
  .option("--output <path>", "destination JSON file (default: ~/opencode-ci.auth.json, mode 0600)")
  .action(async (options: { db: string; integration: string[]; output?: string }) => {
    if (!options.integration.length) throw new Error("--integration is required")
    const db = resolve(options.db)
    if (!(await stat(db)).isFile()) throw new Error(`Not a database file: ${db}`)
    const output = options.output ? resolve(options.output) : join(homedir(), "opencode-ci.auth.json")
    const auth = getAuth(db, options.integration)
    mask.auth(auth)
    await saveAuth(output, auth)
    write(`Saved credentials for ${options.integration.join(", ")} to ${output}\n`)
  })

try {
  await program.parseAsync(process.argv)
} catch (error) {
  if (cancellation === "SIGINT" || cancellation === "SIGTERM") {
    process.exitCode = cancellation === "SIGINT" ? 130 : 143
  } else if (cancellation === "timeout") {
    writeStatus(`Timed out after ${timeoutSeconds}s\n`)
    process.exitCode = 124
  } else {
    writeStatus(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
