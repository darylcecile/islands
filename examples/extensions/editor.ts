import { defineExtension } from "@islands/sdk";

export default defineExtension({
  activate(ctx) {
    let analyses = 0;
    let saves = 0;

    // Both handlers share state for the lifetime of this extension instance.
    ctx.handle("editor.analyze", async () => {
      const document = await ctx.call("editor.read", null);
      if (!document || typeof document !== "object" || Array.isArray(document) || typeof document.text !== "string") {
        throw new Error("editor.read must return { text: string }");
      }
      const text = document.text.trim();
      const words = text ? text.split(/\s+/).length : 0;
      analyses += 1;
      const result = { words, characters: document.text.length, readingSeconds: Math.ceil(words / 200 * 60), analyses, saves };
      await ctx.call("log.write", { message: `Document analyzed: ${words} words (run ${analyses})` });
      return result;
    });

    const unsubscribe = ctx.on("document.saved", async () => {
      saves += 1;
      await ctx.call("log.write", { message: `Document saved ${saves} time(s)` });
    });
    ctx.handle("editor.stats", () => ({ analyses, saves }));
    return () => unsubscribe();
  },
});
