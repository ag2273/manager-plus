/** Amounts written out in Arabic words, as printed on Egyptian invoices. */

const ONES = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"];
const TEENS = ["عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
const TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
const HUNDREDS = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"];

/** Scales: [one, two, three to ten, eleven and up]. */
const SCALES: [string, string, string, string][] = [
  ["ألف", "ألفان", "آلاف", "ألف"],
  ["مليون", "مليونان", "ملايين", "مليون"],
  ["مليار", "ملياران", "مليارات", "مليار"],
];

/** 1–999 in words. */
function belowThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(HUNDREDS[hundreds]!);
  if (rest > 0 && rest < 10) parts.push(ONES[rest]!);
  else if (rest >= 10 && rest < 20) parts.push(TEENS[rest - 10]!);
  else if (rest >= 20) {
    const ones = rest % 10;
    parts.push(ones > 0 ? `${ONES[ones]} و${TENS[Math.floor(rest / 10)]}` : TENS[Math.floor(rest / 10)]!);
  }
  return parts.join(" و");
}

/** A whole number from 0 up to 999,999,999,999 in Arabic words. */
export function numberInWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n >= 1e12) throw new RangeError(`Cannot write ${n} in words`);
  if (n === 0) return "صفر";
  const groups: string[] = [];
  let rest = n;
  for (let scale = -1; rest > 0; scale++) {
    const group = rest % 1000;
    rest = Math.floor(rest / 1000);
    if (group === 0) continue;
    if (scale < 0) {
      groups.unshift(belowThousand(group));
      continue;
    }
    const [one, two, few, many] = SCALES[scale]!;
    if (group === 1) groups.unshift(one);
    else if (group === 2) groups.unshift(two);
    else if (group <= 10) groups.unshift(`${belowThousand(group)} ${few}`);
    else groups.unshift(`${belowThousand(group)} ${many}`);
  }
  return groups.join(" و");
}

/** Piastres as "فقط … جنيه مصري و… قرش لا غير". */
export function amountInWords(piastres: number): string {
  if (!Number.isSafeInteger(piastres) || piastres < 0) throw new RangeError(`Cannot write ${piastres} in words`);
  const pounds = Math.floor(piastres / 100);
  const rest = piastres % 100;
  const parts: string[] = [];
  if (pounds > 0 || rest === 0) parts.push(`${numberInWords(pounds)} جنيه مصري`);
  if (rest > 0) parts.push(`${numberInWords(rest)} قرش`);
  return `فقط ${parts.join(" و")} لا غير`;
}
