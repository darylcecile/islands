import { defineExtension } from "@islands/sdk";

export default defineExtension({
  activate(ctx) {
    ctx.handle("slug.create", async (input) => {
      if (!input || typeof input.title !== "string" || !input.title.trim()) {
        throw new Error("slug.create expects a non-empty title");
      }
      const slug = input.title.toLowerCase().normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!slug) throw new Error("The title must contain a Latin letter or a number");
      await ctx.call("log.write", { message: `Created slug: ${slug}` });
      return { slug };
    });
  },
});
