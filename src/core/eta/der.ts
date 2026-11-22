/** Just enough ASN.1 DER to build and read the CMS signature the ETA asks for. */

export type Der = Uint8Array;

function length(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function tlv(tag: number, content: Uint8Array): Der {
  return concat(Uint8Array.from([tag, ...length(content.length)]), content);
}

export const sequence = (...items: Der[]) => tlv(0x30, concat(...items));

/** A SET OF, its members sorted by their encoding as DER requires. */
export function set(...items: Der[]): Der {
  const sorted = [...items].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  });
  return tlv(0x31, concat(...sorted));
}

export function integer(value: number | Uint8Array): Der {
  if (value instanceof Uint8Array) return tlv(0x02, value);
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(0x02, Uint8Array.from(bytes));
}

export function oid(dotted: string): Der {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [first! * 40 + second!];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

export const nul = (): Der => Uint8Array.from([0x05, 0x00]);
export const octets = (bytes: Uint8Array): Der => tlv(0x04, bytes);
export const bits = (bytes: Uint8Array): Der => tlv(0x03, concat(Uint8Array.from([0]), bytes));
export const utf8 = (text: string): Der => tlv(0x0c, new TextEncoder().encode(text));
/** Context-specific constructed tag [n], explicit or implicit alike: the caller passes what goes inside. */
export const context = (n: number, content: Uint8Array): Der => tlv(0xa0 + n, content);

/** UTCTime, as CMS uses for signing times before 2050: "261121081500Z". */
export function utcTime(at: Date): Der {
  const p = (n: number) => String(n).padStart(2, "0");
  const text = `${p(at.getUTCFullYear() % 100)}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(text));
}

/** One element read from DER: its tag, where its content starts, and the whole element's bytes. */
export type Element = { tag: number; content: Uint8Array; whole: Uint8Array };

export function read(bytes: Uint8Array, at = 0): Element {
  const tag = bytes[at]!;
  let size = bytes[at + 1]!;
  let start = at + 2;
  if (size & 0x80) {
    const count = size & 0x7f;
    size = 0;
    for (let i = 0; i < count; i++) size = size * 256 + bytes[start + i]!;
    start += count;
  }
  return { tag, content: bytes.subarray(start, start + size), whole: bytes.subarray(at, start + size) };
}

/** The elements inside a constructed element (a SEQUENCE, a SET, a context tag). */
export function children(element: Element): Element[] {
  const out: Element[] = [];
  for (let at = 0; at < element.content.length; ) {
    const child = read(element.content, at);
    out.push(child);
    at += child.whole.length;
  }
  return out;
}
