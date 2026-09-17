import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    // src/**/*.test.ts：与源码同目录的单元测试（tests/ 被 .gitignore 忽略，仅本机用）
    include: ["tests/**/*.test.ts", "net-sync-core/tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts"],
    },
  },
});
