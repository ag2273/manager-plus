/** The serials and warranty end printed under a line's name, or "" for an untracked item. */
export function serialNote(line: { serials: string[]; warrantyEnds: string | null }, lang: "ar" | "en" = "ar"): string {
  if (line.serials.length === 0) return "";
  const warranty = line.warrantyEnds ? `\n${lang === "en" ? "Warranty until" : "ضمان حتى"} ${line.warrantyEnds}` : "";
  return `\nS/N: ${line.serials.join(lang === "en" ? ", " : "، ")}${warranty}`;
}
