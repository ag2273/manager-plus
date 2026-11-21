/** Western digits (123) or Arabic-Indic digits (١٢٣) on screens, prints and PDFs. */
export type DigitStyle = "western" | "arabic";

let current: DigitStyle = "western";

/** Sets the style every formatted amount and quantity uses from now on, in this process. */
export function setDigitStyle(style: DigitStyle): void {
  current = style;
}

export function digitStyle(): DigitStyle {
  return current;
}

const ARABIC: Record<string, string> = { ".": "٫", ",": "٬" };

/** Writes a number already formatted in Western digits ("1,250.75") in the chosen style ("١٬٢٥٠٫٧٥"). */
export function inDigits(text: string, style: DigitStyle = current): string {
  if (style === "western") return text;
  return text.replace(/[0-9.,]/g, (c) => ARABIC[c] ?? String.fromCharCode(0x0660 + Number(c)));
}
