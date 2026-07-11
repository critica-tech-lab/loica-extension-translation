/**
 * Translation extension (client registry entry).
 *
 * Adds a "Translate" action to Loica's native text-selection menu
 * (`selectionMenuItems`): select a passage → Translate → the translation
 * streams into an inline popover next to it. Read-only — the document is NEVER
 * modified. The editor plugin (`editorPlugins`) renders the source highlight +
 * popover.
 *
 * Auto-discovered by the host registry glob — this file just `export default`s a
 * `LoicaExtension` (no core edits, mirrors the AI-proofreader extension).
 * Server half in `index.server.ts`; the route lives in `routes.ts`.
 */
import type { LoicaExtension, ExtensionEditorPluginContext } from "~/extensions/types";
import { LOICA_EXTENSION_API_VERSION } from "~/extensions/types";
import type { EditorView } from "prosemirror-view";
import { translatePlugin, runTranslate } from "./translate-plugin";

const translationExtension: LoicaExtension = {
  id: "translation",
  apiVersion: LOICA_EXTENSION_API_VERSION,
  version: "2.0.0",
  description:
    "Translate the selected passage into another language via a local/remote LLM (Ollama), streamed inline. Read-only — never edits the original.",
  // Off until an admin turns it on: it needs a reachable LLM server.
  defaultEnabled: false,
  // Renders the source highlight + inline translation popover in the editor.
  editorPlugins: (ctx: ExtensionEditorPluginContext) => [
    translatePlugin({ docId: ctx.docId }),
  ],
  // Trigger lives in Loica's native text-selection menu (not a floating button).
  selectionMenuItems: (ctx: ExtensionEditorPluginContext) => [
    {
      label: "Translate",
      title: "Translate the selection (read-only — does not edit it)",
      run: (view) => runTranslate(view as EditorView, { docId: ctx.docId }),
    },
  ],
};

export default translationExtension;
