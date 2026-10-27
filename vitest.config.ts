import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globalSetup: ["./tests/global-setup.ts"],
        setupFiles: ["./tests/setup.ts"],
        // One shared database; files run sequentially to keep state predictable.
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 120_000,
    },
});
