#!/usr/bin/env node
import { OpenCode } from "@opencode/sdk"
import { Command, Option } from "commander"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { text } from "node:stream/consumers"
import { addAbortSignal } from "node:stream"
import packageJSON from "../package.json" with { type: "json" }
import { getAuth, loadAuth, loadAuthIfExists, parseAuth, saveAuth, setAuth, type Auth } from "./auth"
import { run } from "./run"
import { noninteractive } from "./noninteractive"
import { createMask, githubMask } from "./mask"

const mask = createMask(process.env, process.env.GITHUB_ACTIONS === "true"
  ? (value) => { process.stderr.write(githubMask(value)) }
  : undefined)
let currentAuth: (() => Auth) | undefined
const output = (stream: NodeJS.WriteStream, text: string) => {
  // Credentials can rotate during the run, before the final auth write-back.
  if (currentAuth) mask.auth(currentAuth())
  stream.write(mask.redact(text))
}
const write = (text: string) => output(process.stdout, text)
const writeStatus = (text: string) => output(process.stderr, text)

const collect = (value: string, previous: string[]) => [...previous, value]

type RunFlags = {
  directory?: string
  model?: string
  variant?: string
  agent?: string
  skill: string[]
  file: string[]
  title?: string
  thinking?: boolean
  auto?: boolean
  timeout: string
  authFile?: string
  authEnv?: string
  authOutput?: string
}

let cancellation: "SIGINT" | "SIGTERM" | "timeout" | undefined
let timeoutSeconds = 2700

async function executeRun(words: string[], options: RunFlags) {
  const defaultAuthFile = join(homedir(), "opencode-ci.auth.json")
  const directory = resolve(options.directory ?? process.cwd())
  const files = options.file.map((file) => resolve(directory, file))
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
    const piped = process.stdin.isTTY ? "" : (await text(addAbortSignal(controller.signal, process.stdin))).trim()
    const prompt = [words.join(" "), piped].filter(Boolean).join("\n")
    if (!prompt.trim()) throw new Error("Provide a prompt or pipe one through stdin")
    controller.signal.throwIfAborted()
    const implicitAuth = !options.authFile && !options.authEnv
    const auth = options.authFile ? await loadAuth(options.authFile) : options.authEnv ? parseAuth(process.env[options.authEnv] ?? "") : await loadAuthIfExists(defaultAuthFile)
    if (auth) mask.auth(auth)
    if (options.authOutput && !auth) throw new Error("--auth-output requires an auth file or --auth-env")
    const authOutput = options.authOutput ?? (implicitAuth && auth ? defaultAuthFile : undefined)
    const temp = await mkdtemp(join(tmpdir(), "opencode-ci-"))
    const db = join(temp, "opencode.db")
    try {
      const opencode = await OpenCode.create({ database: { path: db }, plugins: [noninteractive] })
      try {
        if (auth) {
          setAuth(db, auth)
          currentAuth = () => getAuth(db, Object.keys(auth))
        }
        controller.signal.throwIfAborted()
        await run(opencode, {
          directory, model: options.model, variant: options.variant, agent: options.agent, skills: options.skill, files,
          title: options.title, thinking: options.thinking, auto: options.auto, prompt, signal: controller.signal,
          write, writeStatus,
        })
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
  .option("--timeout <seconds>", "timeout in seconds", "2700")
  .addOption(new Option("--auth-file <path>", "read auth JSON from a file (default: ~/opencode-ci.auth.json if present)").conflicts("authEnv"))
  .addOption(new Option("--auth-env <name>", "read auth JSON from an environment variable").conflicts("authFile"))
  .option("--auth-output <path>", "save refreshed auth JSON to a file (default: update ~/opencode-ci.auth.json when used)")

command.action(async (words: string[], options: RunFlags) => {
  await executeRun(words, options)
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
