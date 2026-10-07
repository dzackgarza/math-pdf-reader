import { fileURLToPath } from "node:url";
import { FONT_CDN_URLS } from "@embedpdf/engines/pdfium";
import { fontsMeta as arabic } from "@embedpdf/fonts-arabic";
import { fontsMeta as hebrew } from "@embedpdf/fonts-hebrew";
import { fontsMeta as jp } from "@embedpdf/fonts-jp";
import { fontsMeta as kr } from "@embedpdf/fonts-kr";
import { fontsMeta as latin } from "@embedpdf/fonts-latin";
import { fontsMeta as sc } from "@embedpdf/fonts-sc";
import { fontsMeta as tc } from "@embedpdf/fonts-tc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { type Target, viteStaticCopy } from "vite-plugin-static-copy";

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// EmbedPDF's fallback fonts, which the reader names (reader/fallbackFonts.ts): each font package
// lists its files, which sit in the package's fonts/ beside its dist/. Each goes to fonts/<name>,
// one name for each of EmbedPDF's CDN font directories.
const FONT_PACKAGE = "@embedpdf/fonts-";
const fontPackages = [arabic, hebrew, jp, kr, latin, sc, tc];
const fontNames = fontPackages.map((meta) => meta.name.slice(FONT_PACKAGE.length));
if (fontNames.toSorted().join() !== Object.keys(FONT_CDN_URLS).toSorted().join()) {
  throw new Error(
    `EmbedPDF's CDN fonts ${Object.keys(FONT_CDN_URLS)} differ from the font packages ${fontNames}`,
  );
}
const fontTargets: Target[] = fontPackages.flatMap((meta) =>
  meta.fonts.map((font) => ({
    src: fileURLToPath(new URL(`../fonts/${font.file}`, import.meta.resolve(meta.name))),
    dest: `fonts/${meta.name.slice(FONT_PACKAGE.length)}`,
    rename: { stripBase: true },
  })),
);

// https://vite.dev/config/
// Two entries: the library (index.html) and the reader page, whose HTML the server renders
// (server/templates/reader.html) and which loads /reader.js by a fixed name.
export default defineConfig({
  root: entry("."),
  plugins: [react(), tailwindcss(), viteStaticCopy({ targets: fontTargets })],
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
