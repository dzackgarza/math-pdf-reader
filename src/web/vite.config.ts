import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// https://vite.dev/config/
// Two entries: the library (index.html) and the reader page, whose HTML the server renders
// (server/templates/reader.html) and which loads /reader.js by a fixed name.
export default defineConfig({
  root: entry("."),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: entry("../../dist/web"),
    emptyOutDir: true,
    // The reader's chunk holds EmbedPDF's viewer (@embedpdf/snippet), which ships as one bundle of
    // about 1.4 MB that no split makes smaller; the bucket serves it from the loopback address.
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      input: { index: entry("index.html"), reader: entry("reader/main.tsx") },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "reader" ? "reader.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
