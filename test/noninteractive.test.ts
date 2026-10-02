import { expect, test } from "bun:test"
import { noninteractive } from "../src/noninteractive"

for (const configured of [undefined, "exa", "random", false] as const) {
  test(`web search preserves ${String(configured)} or defaults to random`, async () => {
    let provider: string | false | undefined = configured
    const removed: string[] = []
    const ctx = {
      tool: {
        transform: async (edit: (editor: { remove(id: string): void }) => void) => {
          edit({ remove: (id) => { removed.push(id) } })
        },
      },
      websearch: {
        transform: async (edit: (editor: { default: { get(): string | false | undefined; set(id: string | false): void } }) => void) => {
          edit({ default: { get: () => provider, set: (id) => { provider = id } } })
        },
      },
    }
    await noninteractive.setup(ctx as unknown as Parameters<typeof noninteractive.setup>[0])
    expect(provider).toBe(configured === undefined ? "random" : configured)
    expect(removed).toEqual(["question"])
  })
}
