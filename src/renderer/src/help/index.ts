import { currentLanguage } from "../strings";
import { helpAr } from "./ar";
import { helpEn } from "./en";
import type { HelpContent, HelpField, HelpScreen } from "./types";

export type { HelpContent, HelpField, HelpScreen } from "./types";

/** The help in the screen language. */
export function help(): HelpContent {
  return currentLanguage() === "en" ? helpEn : helpAr;
}

/** Folds the letters a search should not tell apart: Arabic diacritics, alef and yaa forms, taa marbuta, and case. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

export type HelpHit =
  | { kind: "screen"; id: HelpScreen; title: string; text: string }
  | { kind: "guide"; id: string; title: string; text: string }
  | { kind: "concept"; id: string; title: string; text: string }
  | { kind: "field"; id: HelpField; title: string; text: string };

/** Everything in the help as one list, each entry with its title and all its words. */
export function entries(content: HelpContent): HelpHit[] {
  return [
    ...(Object.entries(content.screens) as [HelpScreen, HelpContent["screens"][HelpScreen]][]).map(([id, s]) => ({
      kind: "screen" as const,
      id,
      title: s.title,
      text: [s.purpose, ...s.points].join(" "),
    })),
    ...content.guides.map((g) => ({ kind: "guide" as const, id: g.id, title: g.title, text: [g.summary, ...g.steps.map((s) => s.text)].join(" ") })),
    ...content.concepts.map((c) => ({ kind: "concept" as const, id: c.id, title: c.title, text: c.paragraphs.join(" ") })),
    ...(Object.keys(content.fields) as HelpField[]).map((id) => ({ kind: "field" as const, id, title: content.fieldNames[id], text: content.fields[id] })),
  ];
}

/** The entries holding every word of the query, those with the words in their title first. */
export function searchHelp(content: HelpContent, query: string): HelpHit[] {
  const words = fold(query).split(" ").filter((w) => w !== "");
  if (words.length === 0) return [];
  const scored = entries(content)
    .map((e) => {
      const title = fold(e.title);
      const all = `${title} ${fold(e.text)}`;
      if (!words.every((w) => all.includes(w))) return null;
      return { e, score: words.filter((w) => title.includes(w)).length };
    })
    .filter((x): x is { e: HelpHit; score: number } => x !== null);
  return scored.sort((a, b) => b.score - a.score).map((x) => x.e);
}
