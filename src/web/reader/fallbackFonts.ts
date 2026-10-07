// EmbedPDF's fallback fonts, served by the bucket. EmbedPDF's own configuration (`cdnFontConfig`)
// maps each charset to the files of an @embedpdf/fonts-* package on jsDelivr; the build copies each
// package's fonts/ into fonts/<package> beside the bundle (vite.config.ts), and this configuration
// is EmbedPDF's with each jsDelivr directory replaced by its copy.
import {
  cdnFontConfig,
  FONT_CDN_URLS,
  type FontEntry,
  type FontFallbackConfig,
  type FontVariant,
} from "@embedpdf/engines/pdfium";

function local(variant: FontVariant, base: URL): FontVariant {
  const found = Object.entries(FONT_CDN_URLS).find(([, cdn]) => variant.url.startsWith(`${cdn}/`));
  if (found === undefined) {throw new Error(`EmbedPDF's font ${variant.url} is in no font package`);}
  const [name, cdn] = found;
  const file = variant.url.slice(cdn.length + 1);
  return { ...variant, url: new URL(`fonts/${name}/${file}`, base).href };
}

function entry(font: FontEntry, base: URL): FontVariant[] {
  if (!Array.isArray(font)) {throw new Error("EmbedPDF's CDN font entry is not a list of variants");}
  return font.map((variant) => local(variant, base));
}

// BASE is the bundle's URL: the engine fetches the fonts from a worker, where a path names nothing.
export function fallbackFonts(base: URL): FontFallbackConfig {
  return {
    fonts: Object.fromEntries(
      Object.entries(cdnFontConfig.fonts).map(([charset, font]) => [charset, entry(font, base)]),
    ),
  };
}
