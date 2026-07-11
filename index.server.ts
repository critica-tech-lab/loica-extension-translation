/**
 * Translation extension (server registry entry).
 *
 * Registers the extension server-side so it appears in `serverExtensions` and
 * can be enabled by an admin — which gates the client editor plugin +
 * selection-menu item. The work lives in the `/api/translate/:id` route
 * (`routes.ts` → `translate.ts` → Ollama).
 *
 * Auto-discovered by the host registry glob — `export default` a
 * `LoicaExtension` (no core edits).
 */
import type { LoicaExtension } from "~/extensions/types";
import { LOICA_EXTENSION_API_VERSION } from "~/extensions/types";

const translationServerExtension: LoicaExtension = {
  id: "translation",
  apiVersion: LOICA_EXTENSION_API_VERSION,
  version: "2.0.0",
  description:
    "Translate the selected passage into another language via a local/remote LLM (Ollama), streamed inline. Read-only — never edits the original.",
  defaultEnabled: false,
};

export default translationServerExtension;
