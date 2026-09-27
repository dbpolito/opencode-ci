import { expect, test } from "bun:test"
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { preparePrompt } from "../src/prepare"

test("prepares image attachments and rejects oversized, binary and non-file inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-ci-files-"))
  try {
    const image = join(directory, "image.png")
    const binary = join(directory, "binary.dat")
    const large = join(directory, "large.txt")
    await writeFile(image, Buffer.from([137, 80, 78, 71]))
    await writeFile(binary, Buffer.from([0, 255]))
    await writeFile(large, "")
    await truncate(large, 10 * 1024 * 1024 + 1)
    expect(await preparePrompt(" Review ", [image])).toEqual({
      text: "Review", files: [{ uri: "data:image/png;base64,iVBORw==", name: "image.png" }],
    })
    await expect(preparePrompt("Review", [binary])).rejects.toThrow("Unsupported binary file")
    await expect(preparePrompt("Review", [large])).rejects.toThrow("larger than 10 MiB")
    await expect(preparePrompt("Review", [directory])).rejects.toThrow("Not a regular file")
    await expect(preparePrompt("Review", [join(directory, "missing")])).rejects.toThrow("File not found")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
