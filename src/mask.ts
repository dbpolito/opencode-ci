import type { Auth } from "./auth"

export function createMask(env: NodeJS.ProcessEnv = process.env, register?: (value: string) => void) {
  const values = new Set<string>()
  let pattern: RegExp | undefined

  const add = (value: string) => {
    if (!value) return
    const variants = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), ...value.split(/\r?\n/)]
    for (const variant of variants) {
      if (!variant || values.has(variant)) continue
      values.add(variant)
      pattern = undefined
      register?.(variant)
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

export function githubMask(value: string) {
  return `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`
}
