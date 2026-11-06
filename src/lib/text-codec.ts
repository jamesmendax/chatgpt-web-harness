/**
 * Text files keep the encoding they already have. Reading everything as UTF-8
 * turned every GBK/ANSI or UTF-16 character into U+FFFD, and the edit tools then
 * wrote those replacement characters back over the original bytes.
 *
 * Detection: BOM (UTF-8, UTF-16LE/BE), then strict UTF-8, then strict GBK
 * (Windows code page 936, the usual legacy encoding on Chinese Windows). A file
 * is only writable in GBK if decoding and re-encoding reproduce its bytes, so
 * untouched text can never change.
 */
export type TextEncodingName = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "gbk";

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
  /** True when the bytes are not valid in any supported encoding (shown lossy, not safely writable). */
  lossy: boolean;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);
let gbkTable: Map<string, number> | null = null;

// Node only ships a GBK decoder; derive the encoder from it once.
function gbkEncoderTable(): Map<string, number> {
  if (gbkTable) return gbkTable;
  const table = new Map<string, number>();
  const decoder = new TextDecoder("gbk");
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      pair[0] = lead; pair[1] = trail;
      const char = decoder.decode(pair);
      if (char.length === 1 && char !== REPLACEMENT_CHARACTER && !table.has(char)) table.set(char, (lead << 8) | trail);
    }
  }
  table.set(String.fromCharCode(0x20ac), 0x80);
  gbkTable = table;
  return table;
}

function encodeGbk(text: string): Buffer {
  const table = gbkEncoderTable();
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) { bytes.push(code); continue; }
    const pair = table.get(char);
    if (pair === undefined) {
      throw new Error(`TEXT_ENCODING_UNREPRESENTABLE: this file is GBK-encoded and cannot store ${JSON.stringify(char)} (U+${code.toString(16).toUpperCase().padStart(4, "0")}). Use characters GBK can represent, or rewrite the whole file as UTF-8 with write_file.`);
    }
    if (pair <= 0xff) bytes.push(pair); else bytes.push(pair >> 8, pair & 0xff);
  }
  return Buffer.from(bytes);
}

function strictDecode(label: string, bytes: Uint8Array): string | null {
  try { return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}

export function decodeText(bytes: Buffer): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = strictDecode("utf-8", bytes.subarray(3));
    return text === null
      ? { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8-bom", lossy: true }
      : { text, encoding: "utf-8-bom", lossy: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le", { ignoreBOM: true }).decode(bytes.subarray(2)), encoding: "utf-16le", lossy: (bytes.length - 2) % 2 !== 0 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be", { ignoreBOM: true }).decode(bytes.subarray(2)), encoding: "utf-16be", lossy: (bytes.length - 2) % 2 !== 0 };
  }
  const utf8 = strictDecode("utf-8", bytes);
  if (utf8 !== null) return { text: utf8, encoding: "utf-8", lossy: false };
  const gbk = strictDecode("gbk", bytes);
  if (gbk !== null) {
    let roundTrips = false;
    try { roundTrips = encodeGbk(gbk).equals(bytes); } catch { roundTrips = false; }
    return { text: gbk, encoding: "gbk", lossy: !roundTrips };
  }
  return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8", lossy: true };
}

export function encodeText(text: string, encoding: TextEncodingName): Buffer {
  switch (encoding) {
    case "utf-8": return Buffer.from(text, "utf8");
    case "utf-8-bom": return Buffer.concat([UTF8_BOM, Buffer.from(text, "utf8")]);
    case "utf-16le": return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    case "utf-16be": {
      const body = Buffer.from(text, "utf16le");
      body.swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    }
    case "gbk": return encodeGbk(text);
  }
}

/** Refuse to rewrite bytes that could not be decoded exactly; writing them back would destroy them. */
export function assertWritable(decoded: DecodedText, filePath: string): void {
  if (!decoded.lossy) return;
  throw new Error(`TEXT_ENCODING_UNKNOWN: ${filePath} is not valid UTF-8, UTF-16 or GBK text, so an in-place edit would corrupt the bytes it cannot read. Read it with read_file_base64, or rewrite it completely with write_file if replacing its content is intended.`);
}
