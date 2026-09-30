import type { Auth } from "./auth"

export function createMask(env: NodeJS.ProcessEnv = process.env) {
  const values = new Set<string>()
  let pattern: RegExp | undefined

  const add = (value: string) => {
    if (!value) return
    const variants = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), ...value.split(/\r?\n/)]
    for (const variant of variants) {
      if (!variant || values.has(variant)) continue
      values.add(variant)
      pattern = undefined
    }
  }

  const addStrings = (value: unknown) => {
    if (typeof value === "string") add(value)
    else if (value && typeof value === "object") Object.values(value).forEach(addStrings)
  }

  for (const [name, value] of Object.entries(env)) {
    if (value && /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|AUTH)(?:_|$)/i.test(name)) add(value)
  }

  return {
    auth(auth: Auth) {
      for (const credential of Object.values(auth)) {
        if (credential.type === "oauth") {
          add(credential.access)
          add(credential.refresh)
        } else {
          add(credential.key)
          addStrings(credential.configuration)
        }
        addStrings(credential.metadata)
      }
    },
    redact(text: string) {
      if (!values.size) return text
      pattern ??= new RegExp([...values]
        .sort((a, b) => b.length - a.length)
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"), "g")
      return text.replace(pattern, "[REDACTED]")
    },
  }
}

// Never register secrets via workflow commands: stderr can be piped to a file
// before GitHub consumes the commands. Local redaction also protects the console.
export function createOutput(
  env: NodeJS.ProcessEnv = process.env,
  stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
  currentAuth?: () => Auth | undefined,
) {
  const mask = createMask(env)
  const output = (stream: Pick<NodeJS.WriteStream, "write">, text: string) => {
    // Credentials can rotate during the run, before the final auth write-back.
    const auth = currentAuth?.()
    if (auth) mask.auth(auth)
    stream.write(mask.redact(text))
  }
  return {
    auth: mask.auth,
    write: (text: string) => output(stdout, text),
    writeStatus: (text: string) => output(stderr, text),
  }
}
