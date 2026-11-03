import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    // У розробці запити /api йдуть на локальний бекенд
    proxy: { "/api": "http://localhost:8787" },
  },
});
