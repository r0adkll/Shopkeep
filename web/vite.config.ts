import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Bind all interfaces: inside the devcontainer, Node's "localhost" resolves to
    // IPv6 ::1 only, which VS Code's IPv4 port forwarder can't reach.
    host: true,
    proxy: {
      // Ktor dev server (vault: D15 inner loop)
      "/api": "http://localhost:8080",
    },
  },
});
