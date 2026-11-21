/** An exchange rate typed by a person ("48.5", "48.50", "٤٨٫٥") as integer millionths, or null if it is not one. */
export function parseRate(text: string): number | null {
  const western = text.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace("٫", ".");
  const match = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(western);
  if (!match) return null;
  const rate = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
  return rate > 0 ? rate : null;
}

/** A rate in millionths for display, with at least two decimals: 48_500_000 is "48.50". */
export function formatRate(rate: number): string {
  const whole = Math.floor(rate / 1_000_000);
  const fraction = String(rate % 1_000_000).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fraction}`;
}
