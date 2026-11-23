// The Arabic font for A4 pages, inlined so a page drawn on its own (a PDF, the print frame)
// needs nothing from outside it. A chunk of its own, loaded the first time an A4 page is made.
import regular from "@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-400-normal.woff2?inline";
import semibold from "@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-600-normal.woff2?inline";
import bold from "@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-700-normal.woff2?inline";

const face = (weight: number, url: string) =>
  `@font-face { font-family: "IBM Plex Sans Arabic"; font-weight: ${weight}; src: url(${url}) format("woff2"); }`;

export const A4_FONT_CSS = [face(400, regular), face(600, semibold), face(700, bold)].join("\n");
