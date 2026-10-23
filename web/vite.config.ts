import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = "http://localhost:9292";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { "/api": backend, "/o": backend, "/s": backend },
  },
});
