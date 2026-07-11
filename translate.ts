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
import { getDocument } from "~/lib/document.server";
import { getMembership } from "~/lib/workspace.server";
import { hasSharedAccess } from "~/lib/sharing.server";

async function authorizeDoc(request: Request, params: { id?: string }) {
  const doc = getDocument(params.id!);
  if (!doc) throw new Response("Not found", { status: 404 });

  const isPublic = !!(doc.public_token || doc.edit_token);
  if (!isPublic) {
    const user = getSessionUser(request);
    if (!user) throw new Response("Not found", { status: 404 });
    const role = getMembership(doc.workspace_id, user.id, user.is_admin);
    const shared = doc.folder_id ? hasSharedAccess(doc.folder_id, user.id) : false;
    if (!role && !shared) throw new Response("Not found", { status: 404 });
  }

  return doc;
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
  await authorizeDoc(request, params);

  const { text, targetLang, sourceLang } = (await request.json()) as {
    text?: string;
    targetLang?: string;
    sourceLang?: string;
  };
  if (!targetLang || !targetLang.trim()) {
    return Response.json({ error: "targetLang is required" }, { status: 400 });
  }
  if (!text || !text.trim()) {
    return Response.json({ error: "No text to translate." }, { status: 400 });
  }
  if (text.length > 8000) {
    return Response.json(
      { error: "Selection too long — translate a paragraph or two at a time." },
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
          { role: "system", content: systemPrompt(targetLang.trim(), sourceLang?.trim() || undefined) },
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
