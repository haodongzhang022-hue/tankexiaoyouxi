import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    // 与源码同目录的单元测试（tests/ 被 .gitignore 忽略，仅本机用）。
    // ⚠ 这里**不收** src/net/entry-match.test.mjs：它是 node --test 写的（真起服务器 + 真发 HTTP），
    //   vitest 加载它会报 "No test suite found"。它由 `npm test` 的第二段
    //   （node --test src/net/entry-match.test.mjs）+ CI 阶段显式跑 —— 见 Issue #11 评审 🟡2 的收口方式。
    include: ["tests/**/*.test.ts", "net-sync-core/tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts"],
    },
  },
});
