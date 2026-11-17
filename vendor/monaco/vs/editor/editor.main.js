/* SourceLook vendor patch (2026-11-15).
 *
 * Upstream `vs/editor/editor.main` pulls, besides the editor core:
 *   ../index-DZH_zysX            (75 KB)  - language-service index
 *   ../toggleHighContrast-...    (1.26 MB) - shared chunk behind that index
 *   ../monaco.contribution-*     (11 KB)  - json / css / html / ts services
 * None of those are used here: SourceLook only needs the editor core plus the
 * basic-language tokenizers (C/C++/Rust/Go/...), and those live in the editor
 * chunk + `vs/basic-languages/monaco.contribution` (15 KB, depends on the editor
 * chunk only). Loading them costs ~1.35 MB of main-thread JS at startup.
 *
 * So this shim keeps: editor core, basic languages, nls, css, default editor
 * worker. If the vendor bundle is ever regenerated, re-apply this patch.
 */
define("vs/editor/editor.main", [
  "exports",
  "require",
  "vs/nls.messages-loader!",
  "../editor-BdtEMBbM",
  "../basic-languages/monaco.contribution"
], (function (e, a, b, r) {
  "use strict";

  function wrap(t) {
    const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
    if (t) {
      for (const s in t) {
        if (s !== "default") {
          const d = Object.getOwnPropertyDescriptor(t, s);
          Object.defineProperty(n, s, d.get ? d : { enumerable: true, get: () => t[s] });
        }
      }
    }
    n.default = t;
    return Object.freeze(n);
  }

  const editor = wrap(r);
  if (typeof globalThis.require === "u" && typeof globalThis.require.config === "function") {
    globalThis.require.config({
      ignoreDuplicateModules: [
        "vscode-languageserver-types", "vscode-languageserver-types/main",
        "vscode-languageserver-textdocument", "vscode-languageserver-textdocument/main",
        "vscode-nls", "vscode-nls/vscode-nls", "jsonc-parser", "jsonc-parser/main",
        "vscode-uri", "vscode-uri/index", "vs/basic-languages/typescript/typescript"
      ]
    });
  }

  const workerUrl = "" + new URL(a.toUrl("../assets/editor.worker-_vAIFJDs.js"), document.baseURI).href;
  function blobWorker(url) {
    if (typeof url !== "string") url = url.toString();
    const src = [
      "const ttPolicy = globalThis.trustedTypes?.createPolicy('defaultWorkerFactory', { createScriptURL: value => value });",
      "globalThis.workerttPolicy = ttPolicy;",
      `importScripts(ttPolicy?.createScriptURL(${JSON.stringify(url)}) ?? ${JSON.stringify(url)});`,
      "globalThis.postMessage({ type: 'vscode-worker-ready' });"
    ].join("");
    return new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
  }
  self.MonacoEnvironment = { getWorker: function () { return blobWorker(workerUrl); } };

  globalThis.monaco = {
    editor: r.editor,
    languages: r.languages,
    KeyCode: r.KeyCode,
    KeyMod: r.KeyMod,
    Range: r.Range,
    Uri: r.Uri,
    Position: r.Position,
    Selection: r.Selection,
    SelectionDirection: r.SelectionDirection,
    Emitter: r.Emitter,
    CancellationTokenSource: r.CancellationTokenSource,
    Token: r.Token,
    MarkerSeverity: r.MarkerSeverity,
    MarkerTag: r.MarkerTag
  };

  const styleHref = a.toUrl("vs/editor/editor.main.css");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = styleHref;
  document.head.appendChild(link);

  e.editor = r.editor;
  e.languages = r.languages;
  e.KeyCode = r.KeyCode;
  e.KeyMod = r.KeyMod;
  e.Range = r.Range;
  e.Uri = r.Uri;
  e.Position = r.Position;
  e.Selection = r.Selection;
  e.Emitter = r.Emitter;
  e.Token = r.Token;
  e.MarkerSeverity = r.MarkerSeverity;
  e.MarkerTag = r.MarkerTag;
  Object.defineProperty(e, Symbol.toStringTag, { value: "Module" });
}));
