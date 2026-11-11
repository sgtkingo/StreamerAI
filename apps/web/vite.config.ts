import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const workspaceRoot = resolve(import.meta.dirname, "../..");
  const env = loadEnv(mode, workspaceRoot, "");

  return {
    root: import.meta.dirname,
    envDir: workspaceRoot,
    plugins: [
      react(),
      VitePWA({
        registerType: "prompt",
        includeAssets: ["icon.svg"],
        manifest: {
          name: "StreamerAI",
          short_name: "StreamerAI",
          description: "Conversational discovery for your private home cinema.",
          theme_color: "#000000",
          background_color: "#000000",
          display: "standalone",
          start_url: "/",
          icons: [
            {
              src: "/icon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any maskable",
            },
          ],
        },
        workbox: {
          clientsClaim: true,
          navigateFallbackDenylist: [/^\/api\//],
        },
      }),
    ],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: env.VITE_API_TARGET || "http://127.0.0.1:4400",
          changeOrigin: false,
        },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      css: true,
    },
  };
});
