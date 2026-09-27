import { randomUUID } from "node:crypto"
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { DatabaseSync } from "node:sqlite"

type OAuth = {
  type: "oauth"
  methodID: string
  access: string
  refresh: string
  expires: number
  metadata?: Record<string, unknown>
}
type Key = {
  type: "key"
  key: string
  metadata?: Record<string, unknown>
  configuration?: Record<string, unknown>
}
type Credential = OAuth | Key
export type Auth = Record<string, Credential>

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** One active credential per integration, keyed by OpenCode integration ID. */
export function parseAuth(source: string): Auth {
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { throw new Error("Invalid auth JSON") }
  if (!object(parsed) || !Object.keys(parsed).length) throw new Error("Expected auth JSON keyed by integration ID")
  return Object.fromEntries(Object.entries(parsed).map(([integrationID, input]) => {
    if (!integrationID.trim() || !object(input)) throw new Error(`Invalid credential for ${integrationID}`)
    const value = input as Record<string, unknown>
    const legacy = integrationID === "openai" && value.type === "oauth" && value.methodID === undefined &&
      (value.accountId === undefined || typeof value.accountId === "string")
    if (legacy) {
      value.methodID = "chatgpt-browser"
      if (value.accountId) value.metadata = { accountID: value.accountId }
      delete value.accountId
    }
    if (value.metadata !== undefined && !object(value.metadata)) throw new Error(`Invalid metadata for ${integrationID}`)
    if (value.type === "oauth") {
      if (Object.keys(value).some((field) => !["type", "methodID", "access", "refresh", "expires", "metadata"].includes(field)) ||
        typeof value.methodID !== "string" || !value.methodID || typeof value.access !== "string" || !value.access ||
        typeof value.refresh !== "string" || typeof value.expires !== "number" ||
        !Number.isSafeInteger(value.expires) || value.expires < 0)
        throw new Error(`Invalid OAuth credential for ${integrationID} (methodID, access, refresh and expires are required)`)
      return [integrationID, value as OAuth]
    }
    if (value.type === "key") {
      if (Object.keys(value).some((field) => !["type", "key", "metadata", "configuration"].includes(field)) ||
        typeof value.key !== "string" || !value.key || (value.configuration !== undefined && !object(value.configuration)))
        throw new Error(`Invalid key credential for ${integrationID}`)
      return [integrationID, value as Key]
    }
    throw new Error(`Unsupported credential type for ${integrationID}`)
  }))
}

function database(path: string, callback: (db: DatabaseSync) => void, readOnly = false) {
  const db = new DatabaseSync(path, { readOnly })
  try { callback(db) } finally { db.close() }
}

/** Only use with a private, freshly initialized SDK database. */
export function setAuth(path: string, auth: Auth) {
  database(path, (db) => {
    const insert = db.prepare(`INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)
      VALUES (?, ?, ?, ?, 1, ?, ?)`)
    const remove = db.prepare("DELETE FROM credential WHERE integration_id = ?")
    db.exec("BEGIN")
    try {
      for (const [integrationID, value] of Object.entries(auth)) {
        remove.run(integrationID)
        const now = Date.now()
        insert.run(`cred_opencode_ci_${randomUUID().replaceAll("-", "")}`, integrationID, integrationID, JSON.stringify(value), now, now)
      }
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  })
}

export function getAuth(path: string, integrations: ReadonlyArray<string>): Auth {
  const result: Auth = Object.create(null)
  database(path, (db) => {
    // Match OpenCode's preferred connection: active first, then newest.
    const query = db.prepare("SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 1")
    for (const integrationID of integrations) {
      const row = query.get(integrationID) as { value: string } | undefined
      if (!row) throw new Error(`Credential missing after run: ${integrationID}`)
      Object.defineProperty(result, integrationID, { value: JSON.parse(row.value), enumerable: true, configurable: true, writable: true })
    }
  }, true)
  return parseAuth(JSON.stringify(result))
}

/** Write a new secret file atomically with owner-only permissions. */
export async function saveAuth(path: string, auth: Auth) {
  const current = await loadAuthIfExists(path)
  if (current && isDeepStrictEqual(current, auth)) {
    await chmod(path, 0o600)
    return
  }
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(auth) + "\n", { mode: 0o600, flag: "wx" })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export async function loadAuth(path: string) {
  return parseAuth(await readFile(path, "utf8"))
}

export async function loadAuthIfExists(path: string) {
  try { return await loadAuth(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
