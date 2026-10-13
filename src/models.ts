import type { OpenCode } from "@opencode/sdk"

export async function listModels(
  client: Pick<OpenCode.Interface, "integration" | "model">,
  options: { directory: string; provider?: string; json?: boolean; signal?: AbortSignal },
) {
  const location = { directory: options.directory }
  const request = { signal: options.signal }
  // Model snapshots can precede plugin settlement. Activate this location first,
  // including credential-specific catalogs and project model overrides.
  await client.integration.list({ location }, request)
  const result = await client.model.list({ location }, request)
  const models = result.data
    .filter((model) => !options.provider || model.providerID === options.provider)
    // Do not dump provider settings, headers, or bodies: they can contain secrets.
    .map((model) => ({ id: `${model.providerID}/${model.id}`, name: model.name }))
    .sort((a, b) => a.id.localeCompare(b.id))
  if (options.json) return `${JSON.stringify(models, null, 2)}\n`
  return models.map((model) => `${model.id}\n`).join("")
}
