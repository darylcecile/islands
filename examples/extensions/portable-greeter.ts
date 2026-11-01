import { defineExtension } from "@islands/sdk";

// This artifact is shared by the JavaScript, browser, Go and Python hosts.
export default defineExtension({
  activate(ctx) {
    let calls = 0;
    ctx.handle("greet", async (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.name !== "string") {
        throw new Error("greet expects { name: string }");
      }
      const message = "Hello, " + input.name + "!";
      calls += 1;
      await ctx.call("log.write", { message });
      return { message, calls };
    });
  },
});
