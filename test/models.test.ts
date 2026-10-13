import { expect, mock, test } from "bun:test"
import { listModels } from "../src/models"

function fixture() {
  const calls: string[] = []
  const client = {
    integration: { list: mock(async () => { calls.push("integration") }) },
    model: { list: mock(async () => {
      calls.push("model")
      return { data: [
        { providerID: "openai", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", headers: { Authorization: "secret-token" } },
        { providerID: "anthropic", id: "test-model", name: "Test model" },
      ] }
    }) },
  }
  const execute = (options: { provider?: string; json?: boolean } = {}) => listModels(
    client as unknown as Parameters<typeof listModels>[0], { directory: "/workspace", ...options },
  )
  return { client, calls, execute }
}

test("lists sorted model references after activating the selected location", async () => {
  const f = fixture()
  expect(await f.execute()).toBe("anthropic/test-model\nopenai/gpt-6.1-sol\n")
  expect(f.calls).toEqual(["integration", "model"])
  expect(f.client.integration.list).toHaveBeenCalledWith({ location: { directory: "/workspace" } }, expect.anything())
  expect(f.client.model.list).toHaveBeenCalledWith({ location: { directory: "/workspace" } }, expect.anything())
})

test("filters by provider without printing provider secrets", async () => {
  const f = fixture()
  expect(JSON.parse(await f.execute({ provider: "openai", json: true }))).toEqual([
    { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol" },
  ])
  expect(await f.execute({ provider: "missing" })).toBe("")
  expect(await f.execute({ provider: "missing", json: true })).toBe("[]\n")
})
