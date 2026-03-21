import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      "/kujiman-api": {
        target: "https://api.kujiman.com",
        changeOrigin: true,
        secure: true,
        rewrite: (path) =>
          path.replace(/^\/kujiman-api/, "/api_mini_apps/reward"),
      },
    },
  },
});