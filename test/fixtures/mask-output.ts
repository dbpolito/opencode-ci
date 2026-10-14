import { createOutput } from "../../src/mask"
import type { Auth } from "../../src/auth"
import { renderLog } from "../../src/log"

// Deliberately fake credentials, including characters that need escaping.
export const installation = 'fake-installation-token"\\?scope=review&value=%'
export const diagnosticPassword = "foo'bar"
export const startup = {
  openai: {
    type: "oauth", methodID: "chatgpt-browser", expires: 123456,
    access: 'fake-startup-jwt"\\?access=one&value=%',
    refresh: 'fake-startup-refresh"\\?refresh=one&value=%',
  },
} satisfies Auth
export const refreshed = {
  openai: {
    ...startup.openai,
    access: 'fake-refreshed-jwt"\\?access=two&value=%',
    refresh: 'fake-refreshed-refresh"\\?refresh=two&value=%',
  },
} satisfies Auth

if (import.meta.main) {
  let auth: Auth = startup
  const output = createOutput(process.env, process.stdout, process.stderr, () => auth)
  output.auth(startup)
  const emit = (value: string) => {
    for (const variant of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) {
      output.write(`stdout ${variant}\n`)
      output.writeStatus(`stderr ${variant}\n`)
    }
  }
  emit(installation)
  emit(startup.openai.access)
  emit(startup.openai.refresh)
  auth = refreshed
  // First output after rotation must pick up new values without explicit registration.
  emit(refreshed.openai.access)
  emit(refreshed.openai.refresh)
  emit(startup.openai.access)
  emit(startup.openai.refresh)
  output.auth(refreshed) // Final write-back must not emit registration commands either.
  for (const value of [diagnosticPassword, installation, startup.openai.access, startup.openai.refresh, refreshed.openai.access, refreshed.openai.refresh]) {
    // The CLI's host logger uses this same renderer -> output mask boundary.
    // Both quote styles and backticks force inspect to escape the apostrophe.
    output.writeStatus(renderLog({ level: "info", message: "spawning process", attributes: {
      command: "sh", args: ["-c", `printf "%s" "${value}"; echo \`pwd\``], cwd: "/workspace",
    } }, true))
    output.writeStatus(renderLog({ level: "warn", message: "connection failed", attributes: { server: "search", detail: value }, cause: new Error(`Failed: ${value}`) }))
  }
}
