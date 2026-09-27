import { relative, resolve, isAbsolute, sep } from "node:path"

type Tool = {
  name: string
  input: Record<string, unknown>
  content?: ReadonlyArray<{ type: string; text?: string }>
  metadata?: Record<string, unknown>
  error?: string
  directory: string
  prefixed?: boolean
  color?: boolean
}

// The SDK exposes tool data, not @opencode/tui's private toolInlineInfo renderer.
// Keep the common run-style display rules here without depending on TUI internals.
export function renderTool(tool: Tool) {
  const input = tool.input
  const text = (value: unknown) => typeof value === "string" ? value : ""
  const name = ({ bash: "shell", task: "subagent", apply_patch: "patch" } as Record<string, string>)[tool.name] ?? tool.name
  const path = text(input.path) || text(input.filePath)
  const file = path ? (() => {
    const full = resolve(tool.directory, path)
    const local = relative(tool.directory, full)
    return local === "" ? "." : local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local) ? local : full
  })() : ""
  const output = (name === "shell"
    ? tool.content?.find((item) => item.type === "text")?.text ?? ""
    : tool.content?.flatMap((item) => item.type === "text" && item.text ? [item.text] : []).join("\n") ?? "").trim()
  const count = (value: unknown, label: string) => typeof value === "number" ? `${value} ${label}${value === 1 ? "" : "es"}` : ""
  const summary = (omit: string[]) => {
    const values = Object.entries(input).filter(([key, value]) => !omit.includes(key) && ["string", "number", "boolean"].includes(typeof value))
    return values.length ? `[${values.map(([key, value]) => `${key}=${value}`).join(", ")}]` : ""
  }
  const label = (() => {
    if (name === "shell") return { icon: "$", title: text(input.command), body: output, block: true }
    if (name === "read") return { icon: "→", title: `Read ${file}`, description: summary(["path", "filePath"]) }
    if (name === "list") return { icon: "→", title: file ? `List ${file}` : "List" }
    if (name === "write") return { icon: "←", title: `Write ${file}`, body: output, block: true }
    if (name === "edit") {
      const first = Array.isArray(tool.metadata?.files) ? tool.metadata.files[0] as { patch?: unknown } | undefined : undefined
      return { icon: "←", title: `Edit ${file}`, body: text(first?.patch) || text(tool.metadata?.diff), block: true }
    }
    if (name === "glob" || name === "grep") {
      const title = name === "glob" ? "Glob" : "Grep"
      const matches = name === "glob" ? tool.metadata?.count : tool.metadata?.matches
      const location = file ? `in ${file}` : ""
      const total = count(matches, "match")
      return { icon: "✱", title: `${title} "${text(input.pattern)}"`, description: [location, total].filter(Boolean).join(" · ") }
    }
    if (name === "subagent") {
      const agent = (text(input.agent) || text(input.subagent_type) || "unknown").replace(/\b\w/g, (letter) => letter.toUpperCase())
      return tool.prefixed || !input.description
        ? { icon: "✓", title: tool.prefixed ? `${agent} Agent` : `${agent} Subagent` }
        : { icon: "✓", title: text(input.description), description: `${agent} Agent` }
    }
    if (name === "skill") return { icon: "→", title: `Skill "${text(tool.metadata?.name) || text(input.id)}"` }
    if (name === "webfetch") return { icon: "%", title: ["WebFetch", text(input.url)].filter(Boolean).join(" ") }
    if (name === "websearch") {
      const provider = text(tool.metadata?.provider)
      const title = provider ? `Web Search via ${provider === "opencode" ? "OpenCode" : provider[0]!.toUpperCase() + provider.slice(1)}` : "Web Search"
      return { icon: "◈", title: text(input.query) ? `${title} "${text(input.query)}"` : title }
    }
    if (name === "patch") {
      const files = Array.isArray(tool.metadata?.files) ? tool.metadata.files.length : 0
      return { icon: "%", title: files ? `Patch ${files} file${files === 1 ? "" : "s"}` : "Patch" }
    }
    if (name === "question") {
      const questions = Array.isArray(input.questions) ? input.questions.length : 0
      return { icon: "→", title: `Asked ${questions} question${questions === 1 ? "" : "s"}` }
    }
    if (name === "lsp") {
      const position = typeof input.line === "number" && typeof input.character === "number" ? `:${input.line}:${input.character}` : ""
      return { icon: "→", title: `LSP ${text(input.operation) || "request"}${file ? ` ${file}${position}` : ""}` }
    }
    if (name === "batch") {
      const calls = Array.isArray(input.tool_calls) ? input.tool_calls.length : 0
      return { icon: "#", title: calls ? `Batch ${calls} tool${calls === 1 ? "" : "s"}` : "Batch", body: output, block: true }
    }
    if (name === "invalid") return { icon: "✗", title: "Invalid Tool", body: output, block: true }
    return { icon: "⚙", title: `${name} ${Object.keys(input).length ? JSON.stringify(input) : "Unknown"}` }
  })()

  const title = `${label.icon} ${label.title}`
  const description = "description" in label && label.description
    ? ` ${tool.color ? `\x1b[90m${label.description}\x1b[0m` : label.description}` : ""
  const block = "block" in label && label.block
  const rendered = `${block ? "\n" : ""}${title}${description}\n${block && "body" in label && label.body?.trim() ? `${label.body.trim()}\n` : ""}${block ? "\n" : ""}`
  return tool.error ? `${output ? rendered : ""}✗ ${label.title} failed\n${tool.error}\n` : rendered
}
