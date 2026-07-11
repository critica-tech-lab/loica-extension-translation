# loica-extension-translation

**On-demand translation** for Loica. Select a passage → **Translate** (in
Loica's native text-selection menu) → the translation **streams into an inline
popover** next to the selection, in the language you pick. **Read-only** — the
document is never modified.

Pairs with `loica-extension-ai-proofreader`: same shape (native selection menu +
inline surface + local/remote Ollama), same zero-core-edit install.

## How it works

1. **Trigger** — "Translate" in the selection menu runs on the selection (never
   on keystroke; the LLM is too slow/expensive for that).
2. **Detect + default** — the source language is detected client-side (cheap
   stopword + script heuristic) and a sensible target is chosen automatically:
   **Spanish↔English**, else English. The header reads `🌐 Source → Target`.
3. **Streamed popover** — the passage is sent to an LLM (Ollama); the
   translation streams back token-by-token into a clean popover anchored to the
   selection, while the source passage stays highlighted in the doc behind it.
4. **Change language** — the `▾` next to the target opens a subtle dropdown with
   every language; picking one re-translates. **Copy** copies the result.
5. **Read-only** — nothing is ever written back. Closing the popover clears the
   highlight and leaves the document exactly as it was.
6. **Cache** — results are cached by `(language, exact text)`; re-translating an
   unchanged passage into the same language is instant.

Detection covers the Latin-script languages the UI offers (English, Spanish,
French, German, Portuguese, Italian, Dutch, Catalan) plus CJK / Arabic /
Cyrillic by script; when unsure it defaults the target to English. The detected
source is also passed to the LLM to sharpen the prompt.

| File | Role |
|------|------|
| `index.ts` / `index.server.ts` | Registry entries (`export default`). |
| `routes.ts` + `route-shim.ts` | `/api/translate/:id` route (shim under `app/routes/`). |
| `translate-plugin.ts` | Source highlight, inline popover, language picker, streaming, cache. |
| `translate.ts` | Route `action`: auth + streams from Ollama, returns `text/plain` deltas + `X-Model`. |

### How it plugs into loica (zero core edits)

Uses only generic extension seams — core names no extension:

- **Discovery** — `export default` in `index.ts` / `index.server.ts` / `routes.ts`;
  the host globs `app/extensions/<name>/*` and registers it.
- **`editorPlugins`** — renders the source highlight + popover in the editor.
- **`selectionMenuItems`** — the "Translate" action in the native selection bubble.

> **Note:** `editorPlugins` mount on the *editable* editor only, so translation
> is available while editing a doc — not on read-only `/shared/…` views. (This
> replaced the earlier v1 "banner on every doc" model, which needed a
> `GlobalEditorBanner` core seam; the new model requires no core edits.)

## Config (env, on the loica server)

| Var | Default | Meaning |
|-----|---------|---------|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `OLLAMA_TRANSLATE_MODEL` | `gemma3:12b` | model tag (any pulled model) |
| `OLLAMA_KEEP_ALIVE` | `30m` | how long Ollama keeps the model resident |

`gemma3:12b` and `qwen2.5:7b` both do multilingual translation well. Requires a
running Ollama with the model pulled: `ollama pull gemma3:12b`.

### Efficiency

- **`num_ctx` is sized to the selection** per request (2048–8192) instead of
  leaving gemma3's 128K default — a small selection gets a small KV cache (less
  VRAM, faster); big ones still fit without truncation.
- **`keep_alive`** keeps the model loaded so a translate after a pause doesn't
  pay a cold reload.
- **Streaming** — the translation appears as it's generated, not after a full
  wait.

## Topology — running the LLM on a separate host

The LLM is heavy but on-demand, so run it on a **GPU host** (e.g. an M4 Mac),
separate from the loica server. `assertSafeUrl` refuses to send text over
plaintext to the open internet: it allows **https anywhere**, and **http only**
for loopback (`localhost`) or the Tailscale CGNAT range (`100.64.0.0/10`,
WireGuard-encrypted). Same three connection methods as the AI-proofreader
extension (Tailscale IP / reverse SSH tunnel / public HTTPS) — see that repo's
README for the tunnel setup.

## Install

Requires a loica build with the generic seams (auto-discovery + `editorPlugins`
+ `selectionMenuItems` + out-of-root `~/` alias). No loica core edits:

```bash
cd /path/to/loica
ln -s /path/to/loica-extension-translation app/extensions/translation
cp app/extensions/translation/route-shim.ts app/routes/api.translate.\$id.ts
printf '/app/extensions/translation\n/app/routes/api.translate.\$id.ts\n' >> .git/info/exclude
bun run build && restart
# then enable "translation" in the Extensions admin panel, with OLLAMA_URL set.
```

The host never tracks this extension: the symlink and shim are ignored via
`.git/info/exclude` (local, not the versioned `.gitignore`), keeping loica core
fully agnostic.

## Upgrading from v1

v1 shipped a `GlobalEditorBanner` button + side-drawer that translated the whole
document, and required core edits (a `GlobalEditorBanner` seam, an explicit
registry entry, a manual `app/routes.ts` line). v2 drops all of that for the
selection-menu + inline model above. To upgrade an existing install, revert
those v1 core edits: remove the explicit `translation` imports from
`app/extensions/index.ts` and `index.server.ts`, and remove the
`api/translate/:id` line from `app/routes.ts` (it's auto-discovered now). The
`GlobalEditorBanner` seam left in core is a harmless generic seam — remove it
only if nothing else uses it.
