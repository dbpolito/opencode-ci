import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installation, startup, refreshed } from "./fixtures/mask-output"

test("GitHub Actions stdout/stderr piped through tee contains no credentials or mask commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-ci-mask-"))
  const log = join(directory, "run.log")
  try {
    const child = Bun.spawn([
      "bash", "-o", "pipefail", "-c", '"$1" "$2" 2>&1 | tee "$3"',
      "mask-test", process.execPath, join(import.meta.dir, "fixtures/mask-output.ts"), log,
    ], {
      env: { PATH: process.env.PATH, GITHUB_ACTIONS: "true", GH_TOKEN: installation },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(code).toBe(0)
    expect(stderr).toBe("")
    const captured = await readFile(log, "utf8")
    expect(captured).toBe(stdout)
    // Every form on both channels, including retained pre-rotation tokens.
    expect(captured.match(/^stdout \[REDACTED\]$/gm)).toHaveLength(21)
    expect(captured.match(/^stderr \[REDACTED\]$/gm)).toHaveLength(21)
    expect(captured).not.toContain("::add-mask::")
    for (const secret of [installation, startup.openai.access, startup.openai.refresh, refreshed.openai.access, refreshed.openai.refresh]) {
      for (const variant of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) {
        expect(captured).not.toContain(variant)
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("CLI startup on GitHub Actions never emits environment mask directives", async () => {
  const child = Bun.spawn([process.execPath, "src/cli.ts", "--version"], {
    env: { PATH: process.env.PATH, GITHUB_ACTIONS: "true", GH_TOKEN: installation },
    stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  expect(code).toBe(0)
  expect(stdout).toMatch(/^\d+\.\d+\.\d+\n$/)
  expect(stderr).toBe("")
  expect(stdout + stderr).not.toContain(installation)
  expect(stdout + stderr).not.toContain("::add-mask::")
})
