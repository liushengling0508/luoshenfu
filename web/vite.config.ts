import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname),
  server: { port: 1421, strictPort: true },
  build: {
    outDir: path.resolve(__dirname, "../dist/web"),
    emptyOutDir: true,
    // 两个入口：主看板与贾维斯粒子窗口各自独立，粒子渲染不拖慢看板。
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        avatar: path.resolve(__dirname, "avatar.html"),
      },
    },
  },
  clearScreen: false,
});
