import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
export default defineConfig({
  cacheDir: ".candidate-cache/server-status",
  plugins: [react()],
  test: {
    setupFiles: ["src/test/setupCache.ts"],
    include: [
      "src/app/shell/passiveStatus.test.tsx",
      "src/app/shell/StatusBar.test.tsx",
      "src/app/shell/TaskList.test.tsx",
      "src/app/shell/TaskList.manualStatus.test.tsx",
      "src/app/shell/serverStatus.test.ts",
      "src/app/shell/useServerStatus.test.tsx",
    ],
  },
});
