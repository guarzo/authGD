import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    globalSetup: ["tests/helpers/global-setup.ts"],
    // Per-file, unlike globalSetup: it seeds process.env in the same worker the
    // tests run in, so a component that reaches getConfig() during render has a
    // valid environment without every test knowing it does.
    setupFiles: ["tests/helpers/setup-env.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only`'s package exports resolve to a module that throws unless
      // the "react-server" condition is set — which Next sets for server
      // components and vitest does not, so every server-only module would fail
      // to import under test. Point at the same empty module Next would get
      // rather than adding the condition globally, which would also change how
      // react and every other conditional export resolves in the suite.
      "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
  // tests/account-page.test.ts renders a page component's JSX directly via
  // react-dom/server; esbuild's default classic transform expects a `React`
  // import that page components don't have (Next's own compiler supplies the
  // automatic runtime at build time). Vitest's transform needs the same mode.
  esbuild: { jsx: "automatic" },
});
