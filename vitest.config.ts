import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "licence-server/**/*.test.ts"],
    environment: "node",
  },
});
