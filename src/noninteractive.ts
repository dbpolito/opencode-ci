import type { OpenCode } from "@opencode/sdk"

export const noninteractive = {
  id: "opencode-ci.noninteractive",
  async setup(ctx) {
    await ctx.tool.transform((editor) => editor.remove("question"))
  },
} satisfies NonNullable<OpenCode.CreateOptions["plugins"]>[number]
