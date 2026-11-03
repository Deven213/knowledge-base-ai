import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Component tests (.tsx) use the automatic JSX runtime, like Next.js does.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside a React Server environment; it is a no-op guard in tests.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  // Server tests run in Node; component tests opt into jsdom with `// @vitest-environment jsdom`.
  test: { environment: "node", include: ["tests/**/*.test.{ts,tsx}"] },
});
