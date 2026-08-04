import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    globalSetup: ["tests/helpers/global-setup.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  // tests/account-page.test.ts renders a page component's JSX directly via
  // react-dom/server; esbuild's default classic transform expects a `React`
  // import that page components don't have (Next's own compiler supplies the
  // automatic runtime at build time). Vitest's transform needs the same mode.
  esbuild: { jsx: "automatic" },
});
