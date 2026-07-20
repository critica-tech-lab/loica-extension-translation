/**
 * POST /api/translate/:id — translate the SELECTED passage into a target
 * language with a local/remote LLM (Ollama), streamed back token-by-token.
 * Read-only: nothing is ever persisted to the document — the client shows the
 * result in an inline popover next to the selection.
 *
 * This module exports the route `action`. React Router's route-module
 * client/server split only runs for route files physically under `app/`, so a
 * thin shim at `app/routes/api.translate.$id.ts` (source: `route-shim.ts`)
 * re-exports this `action`, keeping the Ollama call off the client bundle.
 * Auth mirrors the AI-proofreader route.
 *
 * Body: { text: string, targetLang: string, sourceLang?: string }
 *   text       the selected passage (plain text with block breaks as "\n")
 *   targetLang human-readable language name, e.g. "Spanish"
 *   sourceLang optional detected source language (enriches the prompt)
 * Returns: a streamed `text/plain` body of the translation as it is generated.
 *   Header `X-Model` carries the model tag. Errors before the stream starts are
 *   returned as `{ error }` JSON with a non-2xx status.
 *
 * Config via env (all optional):
 *   OLLAMA_URL             base url   (default http://localhost:11434)
 *   OLLAMA_TRANSLATE_MODEL model tag  (default gemma3:12b)
 *   OLLAMA_KEEP_ALIVE      resident   (default 30m)
 */
import type { ActionFunctionArgs } from "react-router";
import { getSessionUser } from "~/lib/auth.server";
import { getDocument, getDocumentByToken } from "~/lib/document.server";
import { getMembership } from "~/lib/workspace.server";
import { hasSharedAccess } from "~/lib/sharing.server";

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const trimmed = part.trim();
      const eq = trimmed.indexOf("=");
      if (eq < 1) return [];
      return [[trimmed.slice(0, eq).trim(), decodeURIComponent(trimmed.slice(eq + 1).trim())]];
    }),
  );
}

/**
 * Grant access only to a workspace member, a folder-share recipient, or a caller
 * who actually presents a valid share token for *this* document.
 *
 * The earlier version treated "the document has a share token" as "no auth
 * needed", without the caller ever proving they held it — so knowing a document
 * id was enough to reach the LLM anonymously, and expired or password-protected
 * links kept working. Resolving the token via `getDocumentByToken` is the same
 * path `routes/s.$token.tsx` uses, which also enforces `share_expires_at`.
 */
async function authorizeDoc(
  request: Request,
  params: { id?: string },
  shareToken?: string,
) {
  const doc = getDocument(params.id!);
  if (!doc) throw new Response("Not found", { status: 404 });

  const user = getSessionUser(request);
  if (user) {
    const role = getMembership(doc.workspace_id, user.id, user.is_admin);
    const shared = doc.folder_id ? hasSharedAccess(doc.folder_id, user.id) : false;
    if (role || shared) return { doc, rateKey: `u:${user.id}` };
  }

  const token = shareToken?.trim();
  if (token) {
    const viaToken = getDocumentByToken(token);
    // Must resolve, and must resolve to *this* document — a valid token for some
    // other document is not access to this one.
    if (viaToken && viaToken.document.id === doc.id) {
      const passwordOk =
        !viaToken.hasPassword ||
        parseCookies(request.headers.get("Cookie") ?? "")[`__share_pwd_${token}`] === "1";
      if (passwordOk) return { doc, rateKey: `t:${token}` };
    }
  }

  throw new Response("Not found", { status: 404 });
}

/** Tailscale CGNAT address (100.64.0.0 – 100.127.255.255). */
function isTailscale(host: string): boolean {
  const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

/** Refuse to send text over plaintext to the open internet (see README topology). */
function assertSafeUrl(base: string): void {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`OLLAMA_URL is not a valid URL: ${base}`);
  }
  if (url.protocol === "https:") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol === "http:" && (loopback || isTailscale(host))) return;
  throw new Error(
    `Refusing to send text to ${base} over ${url.protocol.replace(":", "")}. ` +
      `Use https:// (or a loopback / Tailscale host) for the LLM server.`,
  );
}

// Ceiling on a single selection. Not a model limit — a patience limit: the
// default 12B model sustains ~48 source characters/second on Apple silicon, so
// 3,000 chars is a little over a minute. The old 8,000 took ~3 minutes, which
// technically worked but nobody waits that long staring at a popover.
const MAX_CHARS = 3000;

// Mirrors ALL_LANGS in translate-plugin.ts. Both language fields land inside the
// *system* prompt, so free-form values let a caller rewrite the model's
// instructions and turn this route into a general-purpose LLM. An allowlist is
// the only reliable defence: reject anything that is not a language we offer.
const SUPPORTED_LANGS = [
  "English", "Spanish", "French", "German", "Portuguese", "Italian", "Dutch",
  "Catalan", "Chinese (Simplified)", "Japanese", "Korean", "Arabic", "Russian",
] as const;

/** Canonical language name, or null if it is not one we support. */
function canonicalLang(value: string | undefined): string | null {
  if (!value) return null;
  const needle = value.trim().toLowerCase();
  return SUPPORTED_LANGS.find((l) => l.toLowerCase() === needle) ?? null;
}

// Each request pins the GPU for up to a minute, so an unthrottled caller can
// starve everyone else even with valid credentials. Sliding window, in-memory:
// this is per-process, so a multi-instance deployment needs a shared store.
const RATE_LIMIT = { max: 20, windowMs: 5 * 60_000 };
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= RATE_LIMIT.windowMs)) hits.delete(k);
  }
  return recent.length > RATE_LIMIT.max;
}

function systemPrompt(targetLanguage: string, sourceLanguage?: string): string {
  const from = sourceLanguage ? `from ${sourceLanguage} ` : "";
  return (
    `You are a professional translator. Translate the user's text ${from}into ${targetLanguage}. ` +
    `Preserve the meaning and tone. Keep any Markdown structure (headings, lists, links, ` +
    `code blocks, tables), and leave code, names, numbers and URLs unchanged. ` +
    `Output ONLY the translation — no preamble, no explanation, no surrounding quotes.`
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { text, targetLang, sourceLang, shareToken } = (await request.json()) as {
    text?: string;
    targetLang?: string;
    sourceLang?: string;
    shareToken?: string;
  };

  // The share token travels in the body, so parse before authorizing.
  const { rateKey } = await authorizeDoc(request, params, shareToken);

  if (rateLimited(rateKey)) {
    return Response.json(
      { error: "Too many translations — wait a few minutes and try again." },
      { status: 429 },
    );
  }

  const target = canonicalLang(targetLang);
  if (!target) {
    return Response.json(
      { error: `Unsupported target language. Choose one of: ${SUPPORTED_LANGS.join(", ")}.` },
      { status: 400 },
    );
  }
  // Unlike the target, an unrecognised source is just dropped: it only enriches
  // the prompt, and client-side detection is a guess to begin with.
  const source = canonicalLang(sourceLang) ?? undefined;

  if (!text || !text.trim()) {
    return Response.json({ error: "No text to translate." }, { status: 400 });
  }
  if (text.length > MAX_CHARS) {
    return Response.json(
      {
        error:
          `Selection is ${text.length.toLocaleString()} characters — the limit is ` +
          `${MAX_CHARS.toLocaleString()}. Translate a few paragraphs at a time.`,
      },
      { status: 413 },
    );
  }

  const base = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
  try {
    assertSafeUrl(base);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid OLLAMA_URL." },
      { status: 400 },
    );
  }
  const model = process.env.OLLAMA_TRANSLATE_MODEL || "gemma3:12b";

  // Size the context window to the selection instead of leaving gemma3's 128K
  // default: a small passage gets a small KV cache (less VRAM, faster). ×3 (not
  // ×2 as for the same-length proofread rewrite) because a translation can
  // expand vs the source; still capped so big passages fit without truncation.
  const estTokens = Math.ceil(text.length / 4);
  const numCtx = Math.min(8192, Math.max(2048, estTokens * 3 + 500));

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        // Keep the model resident so a translate after a pause skips a cold reload.
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
        options: { temperature: 0.2, num_ctx: numCtx },
        messages: [
          { role: "system", content: systemPrompt(target, source) },
          { role: "user", content: text },
        ],
      }),
    });
  } catch (err) {
    return Response.json(
      {
        error: `Could not reach the LLM at ${base}. Is Ollama running? (${
          err instanceof Error ? err.message : String(err)
        })`,
      },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return Response.json(
      { error: `LLM returned ${upstream.status}: ${detail.slice(0, 300)}` },
      { status: 502 },
    );
  }

  // Transform Ollama's NDJSON stream (`{ message: { content }, done }` per line)
  // into a plain-text stream of just the content deltas, which the client
  // appends live into the popover.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const j = JSON.parse(line) as { message?: { content?: string } };
              const piece = j.message?.content;
              if (piece) controller.enqueue(encoder.encode(piece));
            } catch {
              /* partial/non-JSON line — ignore */
            }
          }
        }
      } catch {
        /* upstream dropped — end the stream with whatever arrived */
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Model": model,
      "Cache-Control": "no-store",
    },
  });
}
