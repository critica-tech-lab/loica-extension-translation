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

### Speed, honestly

Measured on an M4 (32 GB) with `gemma3:12b` warm — a cold model adds ~5s:

| Selection | First token | Complete |
|-----------|-------------|----------|
| ~65 words | 1.5s | 7s |
| ~200 words | 2.6s | 23s |
| ~520 words | 6.7s | 71s |

Roughly **48 source characters per second**. Selections are capped at 3,000
characters (`MAX_CHARS`, ~a minute) — the cap is patience, not a model limit.
The popover shows an estimate before the first token and an elapsed/estimate
counter while streaming, so a long passage doesn't read as a hang.

A smaller model trades accuracy for speed: `translategemma:4b` runs ~3× faster
(0.6s to first token, 8.7s for 200 words) but drops terminology — in testing it
rendered "Global Majority" as "a nivel mundial" and "civic space" as "espacio
público", and it echoed prompt instructions into its output. It is not
recommended as the default; `gemma3:12b` was the only model tested that
produced no serious errors.

## Access control

`POST /api/translate/:id` fronts an Ollama instance that has **no
authentication of its own**, so this route is the only thing between a caller
and your GPU. It grants access to exactly three cases:

1. A session user who is a member of the document's workspace.
2. A session user with folder-share access.
3. A caller who **presents a valid share token for that same document** — the
   `shareToken` body field, resolved through `getDocumentByToken`, which also
   enforces `share_expires_at`. Password-protected shares additionally require
   the `__share_pwd_<token>` cookie that `routes/s.$token.tsx` sets.

Everything else gets a `404`. On top of that, `targetLang` and `sourceLang` are
matched against an allowlist (they are interpolated into the *system* prompt, so
free-form values would let a caller rewrite the model's instructions), and each
credential gets 20 translations per 5 minutes.

> **If you run a fork of this from before this was fixed, update.** The earlier
> `authorizeDoc` treated "the document has a share token" as "no auth needed"
> without the caller ever proving they held it — knowing a document id was
> enough to reach the LLM anonymously with an arbitrary prompt, and expired or
> password-protected links kept working. The same pattern exists in the
> AI-proofreader extension's `proofread.ts`; fix both.

**The rate limiter is in-memory, so it counts per process.** On a single-process
deployment (pm2 `fork` mode, a lone container) the limit holds exactly. Run N
instances — pm2 `cluster` mode, a replicated container, several machines behind
a load balancer — and each keeps its own counter, so the effective limit becomes
20 × N per credential. This is deliberate: the alternative is a shared store,
and nothing else in this extension touches the host database, which is what
keeps loica core agnostic of it. If you scale out and the limit matters, move
the counter to a store both processes can see before you do.

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
