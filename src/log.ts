type Entry = {
  level: string
  message: string
  attributes?: Readonly<Record<string, unknown>>
  cause?: unknown
}

// SDK attributes can include configuration and credentials unknown to our mask.
// Redact sensitive fields before formatting; the output mask still handles known tokens.
function details(value: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (depth > 6) return "[truncated]"
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[circular]"
  seen.add(value)
  if (value instanceof Error) return { name: value.name, message: value.message, cause: details(value.cause, seen, depth + 1) }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => details(item, seen, depth + 1))
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
    key, /token|secret|password|passwd|authorization|cookie|api.?key|private.?key|headers|environment|^env$|^configuration$|^auth(?:entication)?$|^credentials?$|^access$|^refresh$|^key$/i.test(key)
      ? "[REDACTED]" : details(item, seen, depth + 1),
  ]))
}

export function renderLog(entry: Entry, debug = false) {
  if (!debug && (["trace", "debug"].includes(entry.level) ||
    (entry.level === "info" && ["event", "spawning process"].includes(entry.message)))) return ""
  const context: Record<string, unknown> = {
    ...entry.attributes,
    ...(entry.cause === undefined ? {} : { cause: entry.cause }),
  }
  // Config/provider update events may contain whole settings documents. Keep
  // their identity, not their payload, even in debug logs.
  if (entry.message === "event" && context.event && typeof context.event === "object") {
    const event = context.event as Record<string, unknown>
    context.event = { type: event.type, id: event.id, sessionID: event.sessionID }
  }
  const suffix = Object.keys(context).length
    // The output mask recognizes JSON escaping, not util.inspect's JS quoting.
    ? ` ${JSON.stringify(details(context), (_, value) => typeof value === "bigint" ? String(value) : value)}` : ""
  return `[${entry.level}] ${entry.message}${suffix}\n`
}

export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
