import { expect, test } from "bun:test"
import { renderTool } from "../src/render-tool"

const directory = "/workspace"

test("renders common tools like run, including shell output", () => {
  expect(renderTool({ directory, name: "grep", input: { pattern: "TODO", path: "/workspace/src" }, metadata: { matches: 2 } }))
    .toBe('✱ Grep "TODO" in src · 2 matches\n')
  expect(renderTool({ directory, name: "glob", input: { pattern: "**/*.ts" }, metadata: { count: 6 }, color: true }))
    .toBe('✱ Glob "**/*.ts" \x1b[90m6 matches\x1b[0m\n')
  expect(renderTool({ directory, name: "grep", input: { pattern: "TODO", path: "/workspace/src" }, metadata: { matches: 1 }, color: true }))
    .toBe('✱ Grep "TODO" \x1b[90min src · 1 match\x1b[0m\n')
  expect(renderTool({ directory, name: "shell", input: { command: "bun test" }, content: [{ type: "text", text: "4 pass" }] }))
    .toBe("\n$ bun test\n4 pass\n\n")
  expect(renderTool({ directory, name: "edit", input: { path: "/workspace/src/a.ts" }, metadata: { diff: "-a\n+b" } }))
    .toBe("\n← Edit src/a.ts\n-a\n+b\n\n")
})

test("renders subagent completion labels like opencode run", () => {
  expect(renderTool({ directory, name: "subagent", input: { agent: "general", description: "Say hi from subagent one" } }))
    .toBe("✓ Say hi from subagent one General Agent\n")
  expect(renderTool({ directory, name: "subagent", input: { agent: "general", description: "Say hi from subagent one" }, color: true }))
    .toBe("✓ Say hi from subagent one \x1b[90mGeneral Agent\x1b[0m\n")
  expect(renderTool({ directory, name: "subagent", input: { agent: "code-review" } }))
    .toBe("✓ Code-Review Subagent\n")
  expect(renderTool({ directory, name: "subagent", input: { agent: "general", description: "reviewer" }, prefixed: true }))
    .toBe("✓ General Agent\n")
  expect(renderTool({ directory, name: "task", input: { subagent_type: "general", description: "reviewer" }, prefixed: true }))
    .toBe("✓ General Agent\n")
})

test("renders read options and paths like opencode run", () => {
  expect(renderTool({ directory, name: "read", input: { path: "/workspace/src/app.ts", offset: 1235, limit: 35 } }))
    .toBe('→ Read src/app.ts [offset=1235, limit=35]\n')
  expect(renderTool({ directory, name: "read", input: { filePath: "../shared/app.ts", limit: 10 }, color: true }))
    .toBe('→ Read /shared/app.ts \x1b[90m[limit=10]\x1b[0m\n')
  expect(renderTool({ directory, name: "list", input: {} })).toBe("→ List\n")
  expect(renderTool({ directory, name: "read", input: { path: "/workspace" } })).toBe("→ Read .\n")
})

test("renders provider, LSP, aliases, and edit metadata like opencode run", () => {
  expect(renderTool({ directory, name: "websearch", input: { query: "docs" }, metadata: { provider: "google" } }))
    .toBe('◈ Web Search via Google "docs"\n')
  expect(renderTool({ directory, name: "websearch", input: {} })).toBe("◈ Web Search\n")
  expect(renderTool({ directory, name: "lsp", input: { operation: "definition", filePath: "/workspace/src/a.ts", line: 4, character: 2 } }))
    .toBe("→ LSP definition src/a.ts:4:2\n")
  expect(renderTool({ directory, name: "bash", input: { command: "pwd" }, content: [{ type: "text", text: "/workspace" }] }))
    .toBe("\n$ pwd\n/workspace\n\n")
  expect(renderTool({ directory, name: "apply_patch", input: {}, metadata: { files: [{ file: "a.ts" }] } }))
    .toBe("% Patch 1 file\n")
  expect(renderTool({ directory, name: "edit", input: { path: "src/a.ts" }, metadata: { files: [{ patch: "-old\n+new" }] } }))
    .toBe("\n← Edit src/a.ts\n-old\n+new\n\n")
  expect(renderTool({ directory, name: "batch", input: { tool_calls: [{}, {}] }, content: [{ type: "text", text: "done" }] }))
    .toBe("\n# Batch 2 tools\ndone\n\n")
})

test("preserves failure diagnostics before the failure label", () => {
  const result = renderTool({ directory, name: "shell", input: { command: "bun test" },
    content: [{ type: "text", text: "Assertion failed at test.ts:42" }, { type: "text", text: "model-only status" }], error: "Exit code 1" })
  expect(result).toBe("\n$ bun test\nAssertion failed at test.ts:42\n\n✗ bun test failed\nExit code 1\n")
})

test("joins all non-shell text blocks and uses the upstream provider name", () => {
  expect(renderTool({ directory, name: "write", input: { path: "a.ts" }, content: [
    { type: "text", text: "first" }, { type: "image" }, { type: "text", text: "second" },
  ] })).toContain("first\nsecond")
  expect(renderTool({ directory, name: "websearch", input: { query: "docs" }, metadata: { provider: "opencode" } }))
    .toBe('◈ Web Search via OpenCode "docs"\n')
})
