import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Ktor dev server (vault: D15 inner loop)
      "/api": "http://localhost:8080",
    },
  },
});
