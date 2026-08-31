"use client";

/** Wires Monaco's completion to the Salesforce language servers behind
 * /api/lang-suggest.
 *
 * Two things here are less obvious than they look.
 *
 * ONE - registration must happen exactly once for the whole app, not per
 * editor. monaco.languages.registerCompletionItemProvider is GLOBAL per
 * language, and every pane in Dhruva stays mounted (tabs hide with CSS rather
 * than unmounting), so registering on mount would add a provider per open tab
 * and show every suggestion two, three, four times over.
 *
 * TWO - the provider is handed a model, and it needs the FILE PATH to know
 * whether this is an LWC template or an unrelated .html, and to tell the server
 * which file to index against. Models here have generated URIs
 * (inmemory://model/1) because the editor is created without a `path`, so the
 * path has to be bound explicitly when a pane mounts. Deriving it from the URI
 * is not an option, and switching the editor to path-based models would change
 * how buffers are retained across the whole app. */

interface Binding {
  root: string;
  file: string;
}

/** Keyed by model id. Bounded by the number of open tabs, and entries remove
 * themselves when Monaco disposes the model. */
const bindings = new Map<string, Binding>();

let registered = false;

/** Tell the completion provider which project file a model holds. Call from a
 * pane's onMount, for every editor whose buffer the user can type into. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bindModelFile(model: any, root: string, file: string) {
  if (!model?.id) return;
  bindings.set(model.id, { root, file });
  model.onWillDispose?.(() => bindings.delete(model.id));
}

/** Languages the Salesforce servers can answer for. Registering per language
 * rather than with a wildcard keeps the provider off files it cannot help. */
const LANGUAGES = ["html", "javascript", "typescript", "css"];

const TRIGGERS = ["<", " ", "-", ":", ".", '"', "'", "/", "{", "!"];

/** Status of the most recent request, for a UI hint ("indexing the project"). */
let lastStatus: { ready: boolean; reason?: string; server?: string } = { ready: true };
export function lspStatus() {
  return lastStatus;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerLspCompletions(monaco: any) {
  if (registered) return;
  registered = true;

  for (const language of LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: TRIGGERS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async provideCompletionItems(model: any, position: any, _ctx: any, token: any) {
        const bound = bindings.get(model.id);
        if (!bound) return { suggestions: [] };

        const controller = new AbortController();
        // Monaco cancels as soon as the user types the next character; without
        // this every keystroke leaves a request running and the answers arrive
        // out of order.
        token?.onCancellationRequested?.(() => controller.abort());

        let data: {
          ready?: boolean;
          reason?: string;
          server?: string;
          items?: {
            label: string;
            kindName: string;
            detail: string;
            doc: string;
            insertText: string;
            snippet: boolean;
            filterText?: string;
            sortText?: string;
          }[];
        };
        try {
          const res = await fetch("/api/lang-suggest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              root: bound.root,
              file: bound.file,
              text: model.getValue(),
              line: position.lineNumber - 1, // LSP is 0-based, Monaco is 1-based
              character: position.column - 1,
            }),
            signal: controller.signal,
          });
          if (!res.ok) return { suggestions: [] };
          data = await res.json();
        } catch {
          return { suggestions: [] };
        }

        lastStatus = { ready: data.ready !== false, reason: data.reason, server: data.server };

        // Still indexing: no suggestions, and `incomplete` so Monaco asks
        // again on the next character instead of caching the empty answer.
        if (data.ready === false) return { suggestions: [], incomplete: true };

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const Kind = monaco.languages.CompletionItemKind;
        const snippetRule = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

        return {
          suggestions: (data.items ?? []).map((it) => ({
            label: it.label,
            // The kind arrives as a NAME because Monaco and LSB number these
            // enums differently; looking it up on the live enum survives a
            // Monaco upgrade renumbering them.
            kind: Kind[it.kindName as keyof typeof Kind] ?? Kind.Property,
            detail: it.detail || undefined,
            documentation: it.doc ? { value: it.doc } : undefined,
            insertText: it.insertText,
            insertTextRules: it.snippet ? snippetRule : undefined,
            filterText: it.filterText,
            sortText: it.sortText,
            range,
          })),
        };
      },
    });
  }
}
