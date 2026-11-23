/**
 * Reads the cells of an Excel (.xlsx) or CSV file as text, sheet by sheet, for the import. Only
 * values are read: formulas give their saved result, and formatting is ignored.
 */
export type ReadSheet = { name: string; rows: string[][] };
/** Inflates raw deflate data (zip method 8): Node's zlib in the tests, the webview's DecompressionStream in the app. */
export type Inflate = (data: Uint8Array) => Uint8Array;
export type InflateAsync = (data: Uint8Array) => Promise<Uint8Array>;

const utf8 = new TextDecoder();

type Entry = { name: string; method: number; raw: Uint8Array };

/** The files in a zip, as stored, read through its central directory. */
function entries(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip file");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("broken zip directory");
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    files.push({ name, method, raw });
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) =>
    name[0] === "#"
      ? String.fromCodePoint(name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1)))
      : (ENTITIES[name] ?? whole),
  );
/** All the text runs in a piece of XML, joined: a shared or inline string, rich text included. */
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1]!)).join("");
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? "") n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/** A number cell as text, without the float noise Excel stores (1140.0000000001 → 1140). */
function numberText(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return Number.isInteger(n) && Math.abs(n) < 1e15 ? n.toFixed(0) : String(Number(n.toFixed(6)));
}

export function readXlsx(bytes: Uint8Array, inflate: Inflate): ReadSheet[] {
  const files = new Map<string, Uint8Array>();
  for (const e of entries(bytes)) {
    if (e.method === 0) files.set(e.name, e.raw);
    else if (e.method === 8) files.set(e.name, inflate(e.raw));
  }
  return sheetsOf(files);
}

/** `readXlsx` with an inflate that answers later, as the webview's does. */
export async function readXlsxAsync(bytes: Uint8Array, inflate: InflateAsync): Promise<ReadSheet[]> {
  const files = new Map<string, Uint8Array>();
  for (const e of entries(bytes)) {
    if (e.method === 0) files.set(e.name, e.raw);
    else if (e.method === 8) files.set(e.name, await inflate(e.raw));
  }
  return sheetsOf(files);
}

function sheetsOf(files: Map<string, Uint8Array>): ReadSheet[] {
  const text = (name: string) => {
    const data = files.get(name);
    return data ? utf8.decode(data) : "";
  };
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!));
  const targets = new Map(
    [...text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      attr(m[0], "Id")!,
      attr(m[0], "Target")!.replace(/^\/?(xl\/)?/, "xl/"),
    ]),
  );
  return [...text("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const xml = text(targets.get(attr(m[0], "r:id") ?? "") ?? "");
    const rows: string[][] = [];
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const number = Number(attr(row[1]!, "r") ?? rows.length + 1);
      const cells: string[] = [];
      for (const c of (row[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = c[1]!;
        const body = c[2] ?? "";
        const type = attr(tag, "t");
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        const value =
          type === "s"
            ? (shared[Number(v)] ?? "")
            : type === "inlineStr"
              ? texts(body)
              : type === "str" || type === "e"
                ? unescape(v ?? "")
                : type === "b"
                  ? v === "1"
                    ? "TRUE"
                    : "FALSE"
                  : v === undefined
                    ? ""
                    : numberText(v);
        const ref = attr(tag, "r");
        cells[ref ? columnIndex(ref) : cells.length] = value;
      }
      while (rows.length < number - 1) rows.push([]);
      rows.push(Array.from(cells, (x) => x ?? ""));
    }
    return { name: unescape(attr(m[0], "name") ?? ""), rows };
  });
}

/**
 * Splits CSV text into rows: quoted fields with doubled quotes, commas or semicolons (whichever
 * the header line uses), CRLF or LF.
 */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
  const separator = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === separator) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) rows.push([...row, field]);
  return rows;
}

/** CSV bytes as text: UTF-8 when valid (Excel's "CSV UTF-8"), else Windows Arabic (1256), as Arabic Excel saves plain CSV. */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1256").decode(bytes);
  }
}
