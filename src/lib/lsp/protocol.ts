/** The wire format for talking to a language server, and the mapping from what
 * one answers into what Monaco expects.
 *
 * Kept pure and separate from the process handling, because this is the part
 * with fiddly details worth testing directly: length-prefixed framing that has
 * to survive a chunk boundary landing anywhere, and two enums that number the
 * same concepts differently. */

export interface LspMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** LSP frames a message as `Content-Length: N\r\n\r\n<json>`. */
export function encodeMessage(msg: object): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** Incremental decoder over a byte stream.
 *
 * A stdio pipe gives no guarantee about where chunks split: a header can arrive
 * without its body, two whole messages can arrive in one chunk, and a multibyte
 * UTF-8 character can be cut in half across the boundary. So the buffer stays a
 * Buffer (never a string) until a full body is in hand, and Content-Length is
 * counted in BYTES, which is what the header actually means. Decoding to a
 * string first is the classic way to get this subtly wrong the moment a
 * component name contains a non-ASCII character. */
export function createDecoder(): (chunk: Buffer) => LspMessage[] {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk: Buffer): LspMessage[] => {
    buf = buf.length === 0 ? chunk : (Buffer.concat([buf, chunk]) as Buffer);
    const out: LspMessage[] = [];
    // A rogue or confused server must not grow this buffer without bound: no
    // legitimate LSP message here (completions, configuration) approaches this.
    const MAX_MESSAGE = 64_000_000;
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) {
        // headers never arriving must not accumulate forever either
        if (buf.length > MAX_MESSAGE) buf = Buffer.alloc(0);
        return out;
      }
      const header = buf.subarray(0, sep).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Unparseable header: drop it rather than stall forever on a stream
        // that can never satisfy the loop.
        buf = buf.subarray(sep + 4);
        continue;
      }
      const len = Number(m[1]);
      if (!Number.isFinite(len) || len > MAX_MESSAGE) {
        // a claimed 10GB body would buffer until OOM; the stream cannot be
        // resynced past a length we refuse to read, so drop what we hold
        buf = Buffer.alloc(0);
        return out;
      }
      const start = sep + 4;
      if (buf.length < start + len) return out;
      const body = buf.subarray(start, start + len).toString("utf8");
      buf = buf.subarray(start + len);
      try {
        out.push(JSON.parse(body) as LspMessage);
      } catch {
        /* a malformed body is skipped - the stream stays in sync because the
           length told us exactly how much to discard */
      }
    }
  };
}

/** Monaco and LSP both have a CompletionItemKind enum, and they number the
 * same concepts DIFFERENTLY - LSP Text is 1, Monaco Text is 18. Passing an LSP
 * number straight to Monaco silently mislabels every item, so the mapping goes
 * through a NAME and the caller looks the name up on the live
 * monaco.languages.CompletionItemKind. Names rather than numbers because a
 * Monaco upgrade may renumber; it will not rename. */
const LSP_KIND_NAMES: Record<number, string> = {
  1: "Text",
  2: "Method",
  3: "Function",
  4: "Constructor",
  5: "Field",
  6: "Variable",
  7: "Class",
  8: "Interface",
  9: "Module",
  10: "Property",
  11: "Unit",
  12: "Value",
  13: "Enum",
  14: "Keyword",
  15: "Snippet",
  16: "Color",
  17: "File",
  18: "Reference",
  19: "Folder",
  20: "EnumMember",
  21: "Constant",
  22: "Struct",
  23: "Event",
  24: "Operator",
  25: "TypeParameter",
};

export function lspKindName(kind: unknown): string {
  return (typeof kind === "number" && LSP_KIND_NAMES[kind]) || "Property";
}

/** An LSP completion item, narrowed to the fields this app uses. */
export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind?: string; value?: string };
  insertText?: string;
  insertTextFormat?: number; // 1 = plain, 2 = snippet
  filterText?: string;
  sortText?: string;
  textEdit?: { range?: unknown; newText?: string };
}

/** Documentation arrives either as a plain string or as a MarkupContent
 * object; a caller that assumes one renders "[object Object]" for the other. */
export function docText(doc: LspCompletionItem["documentation"]): string {
  if (typeof doc === "string") return doc;
  if (doc && typeof doc === "object" && typeof doc.value === "string") return doc.value;
  return "";
}

/** True when the item's text is a snippet template rather than literal text. */
export function isSnippet(item: LspCompletionItem): boolean {
  return item.insertTextFormat === 2;
}

/** What to actually insert. LSP allows the text to live in three places, in
 * this precedence, and servers do use all three. */
export function insertTextFor(item: LspCompletionItem): string {
  if (item.textEdit && typeof item.textEdit.newText === "string") return item.textEdit.newText;
  if (typeof item.insertText === "string") return item.insertText;
  return item.label;
}

/** A completion response is either a bare array or a CompletionList. */
export function itemsOf(result: unknown): LspCompletionItem[] {
  if (Array.isArray(result)) return result as LspCompletionItem[];
  const list = result as { items?: unknown } | null;
  if (list && Array.isArray(list.items)) return list.items as LspCompletionItem[];
  return [];
}

/** file:// URI for an absolute path, in the form these servers expect.
 *
 * Windows paths are the whole reason this is a function: backslashes are not
 * URI separators, and a drive letter needs the third slash - file:///D:/x, not
 * file://D:\x, which a server reads as a host named "d". */
export function pathToUri(abs: string): string {
  const norm = abs.replace(/\\/g, "/");
  const withSlash = norm.startsWith("/") ? norm : "/" + norm;
  return "file://" + encodeURI(withSlash).replace(/#/g, "%23").replace(/\?/g, "%3F");
}
