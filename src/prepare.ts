import { readFile, stat } from "node:fs/promises"
import { basename, extname } from "node:path"

const mimeTypes = new Map([
  [".pdf", "application/pdf"], [".png", "image/png"], [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"],
  [".svg", "image/svg+xml"], [".avif", "image/avif"], [".bmp", "image/bmp"],
])

export async function preparePrompt(prompt: string, files: string[] = [], signal?: AbortSignal) {
  const prepared = await Promise.all(files.map(async (file) => {
    signal?.throwIfAborted()
    const info = await stat(file).catch(() => { throw new Error(`File not found: ${file}`) })
    if (!info.isFile()) throw new Error(`Not a regular file: ${file}`)
    if (info.size > 10 * 1024 * 1024) throw new Error(`File larger than 10 MiB: ${file}`)
    const bytes = await readFile(file, { signal })
    const mime = mimeTypes.get(extname(file).toLowerCase()) ?? "text/plain"
    if (mime.startsWith("image/") || mime === "application/pdf") {
      return { attachment: { uri: `data:${mime};base64,${bytes.toString("base64")}`, name: basename(file) } }
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      if (bytes.includes(0)) throw new Error("binary")
      return { text: `<file name="${basename(file)}">\n${text}\n</file>` }
    } catch {
      throw new Error(`Unsupported binary file: ${file}`)
    }
  }))
  signal?.throwIfAborted()
  return {
    text: [prompt.trim(), ...prepared.flatMap((item) => item.text ? [item.text] : [])].join("\n\n"),
    files: prepared.flatMap((item) => item.attachment ? [item.attachment] : []),
  }
}
