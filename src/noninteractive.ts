import type { OpenCode } from "@opencode/sdk"

export const noninteractive = {
  id: "opencode-ci.noninteractive",
  async setup(ctx) {
    await ctx.tool.transform((editor) => editor.remove("question"))
    await ctx.websearch.transform((editor) => {
      if (editor.default.get() === undefined) editor.default.set("random")
    })
  },
} satisfies NonNullable<OpenCode.CreateOptions["plugins"]>[number]
