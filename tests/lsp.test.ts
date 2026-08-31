import { describe, expect, it } from "vitest";
import {
  createDecoder,
  docText,
  encodeMessage,
  insertTextFor,
  isSnippet,
  itemsOf,
  lspKindName,
  pathToUri,
} from "@/lib/lsp/protocol";
import { LANG_SERVERS, serverById, serverFor } from "@/lib/lsp/servers";

/** The two parts of the LSP integration worth testing without a live server:
 * the framing, which has to survive a chunk boundary landing anywhere, and the
 * scope rules that decide which files a server is even offered. */

describe("message framing", () => {
  it("round-trips a message", () => {
    const decode = createDecoder();
    const out = decode(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    expect(out).toHaveLength(1);
    expect(out[0].method).toBe("initialize");
  });

  it("counts Content-Length in BYTES, not characters", () => {
    // A component named with a non-ASCII character makes byte length and
    // string length differ; getting this wrong desynchronises the stream from
    // that point on and every later message is garbage.
    const msg = { jsonrpc: "2.0" as const, id: 7, result: { label: "café–ünïcode" } };
    const frame = encodeMessage(msg);
    const header = frame.subarray(0, frame.indexOf("\r\n\r\n")).toString("ascii");
    const declared = Number(/Content-Length: (\d+)/.exec(header)![1]);
    const bodyBytes = Buffer.byteLength(JSON.stringify(msg), "utf8");
    expect(declared).toBe(bodyBytes);
    expect(declared).not.toBe(JSON.stringify(msg).length);
    expect(createDecoder()(frame)[0].id).toBe(7);
  });

  it("waits for a body that has not arrived yet", () => {
    const decode = createDecoder();
    const frame = encodeMessage({ jsonrpc: "2.0", id: 1, result: { a: 1 } });
    expect(decode(frame.subarray(0, 12))).toEqual([]);
    expect(decode(frame.subarray(12))).toHaveLength(1);
  });

  it("reassembles a message split byte by byte", () => {
    // The strongest form of the chunk-boundary case: every possible split.
    const decode = createDecoder();
    const frame = encodeMessage({ jsonrpc: "2.0", id: 42, result: { deep: { x: "yø" } } });
    const seen = [];
    for (const b of frame) seen.push(...decode(Buffer.from([b])));
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe(42);
  });

  it("returns several messages arriving in one chunk", () => {
    const decode = createDecoder();
    const a = encodeMessage({ jsonrpc: "2.0", id: 1 });
    const b = encodeMessage({ jsonrpc: "2.0", id: 2 });
    const c = encodeMessage({ jsonrpc: "2.0", id: 3 });
    const out = decode(Buffer.concat([a, b, c]));
    expect(out.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("stays in sync after a malformed body", () => {
    // The length told us how much to discard, so the NEXT message must still
    // parse - otherwise one bad frame kills the session.
    const decode = createDecoder();
    const bad = Buffer.from("Content-Length: 5\r\n\r\n{{{{{", "utf8");
    const good = encodeMessage({ jsonrpc: "2.0", id: 9 });
    const out = decode(Buffer.concat([bad, good]));
    expect(out.map((m) => m.id)).toEqual([9]);
  });

  it("does not stall on a header with no Content-Length", () => {
    const decode = createDecoder();
    const junk = Buffer.from("X-Nonsense: 1\r\n\r\n", "utf8");
    const good = encodeMessage({ jsonrpc: "2.0", id: 4 });
    expect(decode(Buffer.concat([junk, good])).map((m) => m.id)).toEqual([4]);
  });
});

describe("pathToUri", () => {
  it("gives a Windows drive path three slashes", () => {
    // file://D:/x is read as a HOST named "d"; file:///D:/x is a path.
    expect(pathToUri("D:\\aging-sfdx")).toBe("file:///D:/aging-sfdx");
  });

  it("leaves a posix path alone", () => {
    expect(pathToUri("/home/dev/proj")).toBe("file:///home/dev/proj");
  });

  it("escapes characters that would otherwise change the URI's meaning", () => {
    expect(pathToUri("D:\\my proj\\a#b")).toBe("file:///D:/my%20proj/a%23b");
  });
});

describe("completion item mapping", () => {
  it("maps LSP kind numbers to names, not to Monaco numbers", () => {
    // LSP Text is 1 while Monaco Text is 18 - passing the number straight
    // through mislabels every item in the list.
    expect(lspKindName(1)).toBe("Text");
    expect(lspKindName(15)).toBe("Snippet");
    expect(lspKindName(7)).toBe("Class");
    expect(lspKindName(undefined)).toBe("Property");
    expect(lspKindName(999)).toBe("Property");
  });

  it("prefers textEdit.newText, then insertText, then the label", () => {
    expect(insertTextFor({ label: "a", insertText: "b", textEdit: { newText: "c" } })).toBe("c");
    expect(insertTextFor({ label: "a", insertText: "b" })).toBe("b");
    expect(insertTextFor({ label: "a" })).toBe("a");
  });

  it("reads documentation as a string or as MarkupContent", () => {
    expect(docText("plain")).toBe("plain");
    expect(docText({ kind: "markdown", value: "**md**" })).toBe("**md**");
    expect(docText(undefined)).toBe("");
  });

  it("detects the snippet insert format", () => {
    expect(isSnippet({ label: "a", insertTextFormat: 2 })).toBe(true);
    expect(isSnippet({ label: "a", insertTextFormat: 1 })).toBe(false);
    expect(isSnippet({ label: "a" })).toBe(false);
  });

  it("accepts a bare array or a CompletionList", () => {
    expect(itemsOf([{ label: "x" }])).toHaveLength(1);
    expect(itemsOf({ isIncomplete: true, items: [{ label: "y" }] })).toHaveLength(1);
    expect(itemsOf(null)).toEqual([]);
    expect(itemsOf({ nope: 1 })).toEqual([]);
  });
});

describe("server scoping", () => {
  it("routes LWC files to the LWC server", () => {
    for (const f of [
      "force-app/main/default/lwc/orderList/orderList.html",
      "force-app/main/default/lwc/orderList/orderList.js",
      "force-app/main/default/lwc/orderList/orderList.css",
    ]) {
      expect(serverFor(f)?.id, f).toBe("lwc");
    }
  });

  it("routes Aura files to the Aura server", () => {
    expect(serverFor("force-app/main/default/aura/MyCmp/MyCmp.cmp")?.id).toBe("aura");
    expect(serverFor("force-app/main/default/aura/MyApp/MyApp.app")?.id).toBe("aura");
  });

  it("does NOT claim an html file outside an lwc folder", () => {
    // The whole reason scoping is path-based: .html is `html` to Monaco
    // whether or not it is a component template.
    expect(serverFor("docs/readme.html")).toBeNull();
    expect(serverFor("force-app/main/default/pages/AccountView.page")).toBeNull();
  });

  it("does NOT claim a javascript file outside a component folder", () => {
    expect(serverFor("scripts/build.js")).toBeNull();
    expect(serverFor("jest.config.js")).toBeNull();
  });

  it("accepts Windows separators", () => {
    expect(serverFor("force-app\\main\\default\\lwc\\orderList\\orderList.html")?.id).toBe("lwc");
  });

  it("ignores a file type neither server handles", () => {
    expect(serverFor("force-app/main/default/lwc/orderList/orderList.svg")).toBeNull();
    expect(serverFor("force-app/main/default/classes/A.cls")).toBeNull();
  });

  it("declares the right languageId per extension", () => {
    const lwc = serverById("lwc")!;
    expect(lwc.languageId("a/lwc/x/x.html")).toBe("html");
    expect(lwc.languageId("a/lwc/x/x.js")).toBe("javascript");
    expect(lwc.languageId("a/lwc/x/x.ts")).toBe("typescript");
    const aura = serverById("aura")!;
    expect(aura.languageId("a/aura/X/X.cmp")).toBe("html");
  });

  it("resolves a spawnable entry for every configured server", () => {
    // Guards the three traps in resolution: the bin is not exported, `main`
    // points at a file that does not exist, and only the /server subpath works.
    for (const s of LANG_SERVERS) {
      const entry = s.entry();
      expect(entry, `${s.id} entry`).toBeTruthy();
      expect(entry!.replace(/\\/g, "/")).toMatch(/\/lib\/server\.js$/);
    }
  });

  it("has a unique id per server", () => {
    const ids = LANG_SERVERS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
