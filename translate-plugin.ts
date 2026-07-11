/**
 * ProseMirror plugin: on-demand translation of the current selection, shown
 * INLINE in a clean popover next to the passage — read-only, the document is
 * never modified.
 *
 * Flow: select a passage → "Translate" in Loica's native selection menu
 * (`selectionMenuItems`, see `index.ts`). The plugin detects the source
 * language, picks a sensible default target (Spanish↔English, else English),
 * and streams the translation into a popover anchored to the selection. The
 * header reads "🌐 Source → Target ▾"; the caret opens a subtle dropdown to pick
 * any other language. The source passage stays highlighted in the doc behind
 * the popover for comparison. Closing clears the highlight; nothing is written.
 *
 * Runs in the host's ProseMirror instance (bare `prosemirror-*` imports + vite
 * `dedupe`). Every callback self-guards so a failure can't break the editor.
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

export const translatePluginKey = new PluginKey<DecorationSet>("translation");

// English + Spanish are the default pair; the rest fill the "▾" dropdown.
const ALL_LANGS = [
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Dutch",
  "Catalan",
  "Chinese (Simplified)",
  "Japanese",
  "Korean",
  "Arabic",
  "Russian",
] as const;

const MIN_CHARS = 1;

// Cache translations by `${lang}\n${text}` so re-translating an unchanged
// passage into the same language is instant. Capped, module-level.
const cache = new Map<string, string>();
function cacheSet(key: string, val: string) {
  cache.set(key, val);
  if (cache.size > 200) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
}

// ── language detection (cheap, self-contained) ───────────────────────────────

// Common function words per language — enough to separate the Latin-script
// languages this UI offers. Overlaps (es/pt share "de", "que") are broken by
// the special-character bonuses below.
const STOPWORDS: Record<string, string[]> = {
  English: ["the", "and", "of", "to", "in", "is", "that", "for", "it", "with", "as", "was", "on", "are", "this", "be", "at", "by"],
  Spanish: ["el", "la", "de", "que", "y", "en", "un", "una", "los", "las", "por", "con", "para", "del", "se", "no", "es", "su", "lo"],
  French: ["le", "la", "les", "de", "et", "un", "une", "des", "que", "qui", "dans", "pour", "pas", "est", "au", "ce", "il", "vous"],
  German: ["der", "die", "das", "und", "ist", "den", "von", "zu", "mit", "sich", "auf", "für", "nicht", "ein", "eine", "im", "dem"],
  Portuguese: ["de", "que", "e", "do", "da", "em", "um", "para", "com", "não", "uma", "os", "no", "se", "na", "por", "mais", "como"],
  Italian: ["di", "che", "e", "la", "il", "un", "in", "per", "non", "una", "con", "del", "le", "si", "sono", "come", "ma", "anche"],
  Dutch: ["de", "het", "een", "en", "van", "ik", "te", "dat", "die", "is", "in", "niet", "op", "aan", "met", "zijn", "voor"],
  Catalan: ["el", "la", "de", "que", "i", "en", "un", "una", "els", "les", "amb", "per", "no", "és", "al", "del", "als", "seva"],
};

// Script / diacritic signals — a strong nudge for the ambiguous Latin cases.
const CHAR_BONUS: Array<{ lang: string; re: RegExp; w: number }> = [
  { lang: "Spanish", re: /[ñ¿¡]/i, w: 4 },
  { lang: "Portuguese", re: /[ãõç]/i, w: 4 },
  { lang: "French", re: /[çœàèùêâî]/i, w: 3 },
  { lang: "German", re: /[äöüß]/i, w: 4 },
  { lang: "Italian", re: /[àèìòù]/i, w: 2 },
  { lang: "Catalan", re: /[·ïçò]/i, w: 2 },
];

/** Best-guess language name, or "" when unsure / non-Latin script. */
function detectLanguage(text: string): string {
  const sample = text.slice(0, 1200);
  // Non-Latin scripts: match directly by Unicode range.
  if (/[一-鿿]/.test(sample)) return "Chinese (Simplified)";
  if (/[぀-ヿ]/.test(sample)) return "Japanese";
  if (/[가-힯]/.test(sample)) return "Korean";
  if (/[؀-ۿ]/.test(sample)) return "Arabic";
  if (/[Ѐ-ӿ]/.test(sample)) return "Russian";

  const words = sample.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  if (words.length === 0) return "";
  const counts = new Set(words);
  const score: Record<string, number> = {};
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    let s = 0;
    for (const w of list) if (counts.has(w)) s++;
    score[lang] = s;
  }
  for (const { lang, re, w } of CHAR_BONUS) if (re.test(sample)) score[lang] = (score[lang] ?? 0) + w;

  let best = "", bestScore = 0;
  for (const [lang, s] of Object.entries(score)) {
    if (s > bestScore) { best = lang; bestScore = s; }
  }
  // Need a minimum of evidence, else leave it unknown (→ default target).
  return bestScore >= 2 ? best : "";
}

/** Sensible default target given the detected source (Spanish↔English, else English). */
function defaultTarget(source: string): string {
  if (source === "Spanish") return "English";
  if (source === "English") return "Spanish";
  return "English";
}

// ── selection → plain text ───────────────────────────────────────────────────

/** Serialise the selection [from, to] to plain text (block breaks → "\n"). */
function selectionToText(doc: PMNode, from: number, to: number): string {
  let text = "";
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText && node.text) {
      const a = Math.max(pos, from);
      const b = Math.min(pos + node.text.length, to);
      if (b > a) text += node.text.slice(a - pos, b - pos);
      return false;
    }
    if (node.isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
    return true;
  });
  return text;
}

// ── decorations (source highlight + pending pulse) ───────────────────────────

function setDecos(view: EditorView, decos: DecorationSet) {
  try {
    view.dispatch(view.state.tr.setMeta(translatePluginKey, decos));
  } catch {
    /* ignore */
  }
}

function sourceDecos(doc: PMNode, from: number, to: number, pending: boolean): DecorationSet {
  try {
    return DecorationSet.create(doc, [
      Decoration.inline(from, to, { class: pending ? "loica-tr-pending" : "loica-tr-source" }),
    ]);
  } catch {
    return DecorationSet.empty;
  }
}

// ── styles ───────────────────────────────────────────────────────────────────

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
@keyframes loica-tr-pulse { 0%,100% { background: color-mix(in srgb, var(--fg,#111) 6%, transparent); } 50% { background: color-mix(in srgb, var(--fg,#111) 16%, transparent); } }
.loica-tr-pending { animation: loica-tr-pulse 1.1s ease-in-out infinite; border-radius: 3px; }
.loica-tr-source { background: color-mix(in srgb, var(--fg,#111) 8%, transparent); border-radius: 3px; }
@keyframes loica-tr-spin { to { transform: rotate(360deg); } }
.loica-tr-spinner { display:inline-block; width:11px; height:11px; border:2px solid currentColor; border-top-color: transparent; border-radius:50%; animation: loica-tr-spin .7s linear infinite; vertical-align:-1px; }
.loica-tr-menu-item:hover { background: color-mix(in srgb, var(--fg,#111) 8%, transparent); }
`;
  document.head.appendChild(s);
}

// ── streaming fetch ──────────────────────────────────────────────────────────

/**
 * Translate `text` into `targetLang`, streaming deltas to `onText(full)`.
 * Returns the final text + model tag. Cache hits resolve instantly.
 */
async function streamTranslate(
  docId: string,
  text: string,
  sourceLang: string,
  targetLang: string,
  onText: (full: string) => void,
): Promise<{ text: string; model: string }> {
  const key = `${targetLang}\n${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    onText(cached);
    return { text: cached, model: "" };
  }

  const res = await fetch(`/api/translate/${docId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, targetLang, sourceLang: sourceLang || undefined }),
  });

  const ct = res.headers.get("content-type") || "";
  if (!res.ok || ct.includes("application/json")) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  const model = res.headers.get("X-Model") || "";
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response stream.");
  const decoder = new TextDecoder();
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    full += decoder.decode(value, { stream: true });
    onText(full);
  }
  full = full.trim();
  onText(full);
  cacheSet(key, full);
  return { text: full, model };
}

// ── popover ──────────────────────────────────────────────────────────────────

interface Popover {
  el: HTMLElement;
  destroy: () => void;
}
let active: Popover | null = null;

function closePopover() {
  if (active) {
    active.destroy();
    active = null;
  }
}
function onDocMouseDown(e: MouseEvent) {
  if (active && !active.el.contains(e.target as Node)) closePopover();
}

function btnBase(el: HTMLElement) {
  Object.assign(el.style, {
    border: "none", background: "transparent", color: "var(--fg, #111)",
    cursor: "pointer", font: "inherit",
  } as CSSStyleDeclaration);
}

function openTranslator(view: EditorView, docId: string, from: number, to: number) {
  closePopover();
  injectStyles();

  const text = selectionToText(view.state.doc, from, to);
  const source = detectLanguage(text);

  const pop = document.createElement("div");
  Object.assign(pop.style, {
    position: "fixed",
    width: "min(380px, 92vw)",
    background: "var(--bg, #fff)",
    color: "var(--fg, #111)",
    border: "1px solid var(--border, #ccc)",
    borderRadius: "10px",
    boxShadow: "0 8px 30px rgba(0,0,0,0.22)",
    zIndex: "2000",
    fontSize: "13px",
    lineHeight: "1.5",
    display: "flex",
    flexDirection: "column",
    overflow: "visible",
  } as CSSStyleDeclaration);

  // ── header: 🌐 Source → Target ▾ ·········· copy · × ──
  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex", alignItems: "center", gap: "6px",
    padding: "9px 11px", borderBottom: "1px solid var(--border, #ccc)",
    position: "relative",
  } as CSSStyleDeclaration);

  const globe = document.createElement("span");
  globe.innerHTML =
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="display:block"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 6 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-6-3.5-9s1-6.5 3.5-9z"/></svg>`;

  const srcLabel = document.createElement("span");
  srcLabel.textContent = source || "Auto";
  Object.assign(srcLabel.style, { opacity: "0.6", fontWeight: "500" } as CSSStyleDeclaration);

  const arrow = document.createElement("span");
  arrow.textContent = "→";
  arrow.style.opacity = "0.5";

  // Target picker: label + caret, opens the dropdown.
  const targetBtn = document.createElement("button");
  targetBtn.type = "button";
  btnBase(targetBtn);
  Object.assign(targetBtn.style, {
    display: "inline-flex", alignItems: "center", gap: "3px",
    fontWeight: "600", padding: "2px 4px", borderRadius: "6px",
  } as CSSStyleDeclaration);
  const targetText = document.createElement("span");
  const caret = document.createElement("span");
  caret.textContent = "▾";
  caret.style.opacity = "0.6";
  caret.style.fontSize = "11px";
  targetBtn.append(targetText, caret);

  const spacer = document.createElement("div");
  spacer.style.flex = "1";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.title = "Copy translation";
  copyBtn.textContent = "Copy";
  btnBase(copyBtn);
  copyBtn.disabled = true;
  Object.assign(copyBtn.style, {
    padding: "3px 9px", borderRadius: "999px", border: "1px solid var(--border, #ccc)",
    fontSize: "12px", opacity: "0.5",
  } as CSSStyleDeclaration);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  closeBtn.textContent = "×";
  btnBase(closeBtn);
  Object.assign(closeBtn.style, { fontSize: "18px", lineHeight: "1", padding: "0 2px" } as CSSStyleDeclaration);
  closeBtn.addEventListener("click", () => closePopover());

  header.append(globe, srcLabel, arrow, targetBtn, spacer, copyBtn, closeBtn);

  // ── dropdown (subtle), anchored under the target picker ──
  const menu = document.createElement("div");
  Object.assign(menu.style, {
    position: "absolute", top: "36px", left: "8px", zIndex: "10",
    minWidth: "150px", maxHeight: "240px", overflow: "auto",
    background: "var(--bg, #fff)", color: "var(--fg, #111)",
    border: "1px solid var(--border, #ccc)", borderRadius: "8px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.22)", padding: "4px", display: "none",
  } as CSSStyleDeclaration);
  for (const l of ALL_LANGS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "loica-tr-menu-item";
    item.textContent = l;
    btnBase(item);
    Object.assign(item.style, {
      display: "block", width: "100%", textAlign: "left",
      padding: "5px 9px", borderRadius: "6px", fontSize: "13px",
    } as CSSStyleDeclaration);
    item.addEventListener("click", () => { menu.style.display = "none"; run(l); });
    menu.appendChild(item);
  }
  header.appendChild(menu);
  targetBtn.addEventListener("click", () => {
    menu.style.display = menu.style.display === "none" ? "block" : "none";
  });

  // ── body: translation only ──
  const body = document.createElement("div");
  Object.assign(body.style, {
    padding: "12px", maxHeight: "44vh", overflow: "auto",
    whiteSpace: "pre-wrap", wordBreak: "break-word",
  } as CSSStyleDeclaration);

  // ── footer ──
  const footer = document.createElement("div");
  Object.assign(footer.style, {
    padding: "6px 11px", borderTop: "1px solid var(--border, #ccc)",
    fontSize: "11px", opacity: "0.55",
  } as CSSStyleDeclaration);
  footer.textContent = "Read-only — the original is unchanged.";

  pop.append(header, body, footer);
  document.body.appendChild(pop);

  // Anchor below the selection end; flip above if it would overflow the viewport.
  try {
    const c = view.coordsAtPos(to);
    const left = Math.max(8, Math.min(c.left, window.innerWidth - 380 - 8));
    pop.style.left = `${left}px`;
    const below = c.bottom + 10;
    if (below + 260 > window.innerHeight && c.top > 280) {
      pop.style.top = `${Math.max(8, c.top - 270)}px`;
    } else {
      pop.style.top = `${below}px`;
    }
  } catch {
    pop.style.left = "50%";
    pop.style.top = "90px";
  }

  let currentText = "";
  let seq = 0; // guards against a stale in-flight request updating the body

  function run(target: string) {
    targetText.textContent = target;
    setDecos(view, sourceDecos(view.state.doc, from, to, true));
    copyBtn.disabled = true;
    copyBtn.style.opacity = "0.5";
    currentText = "";
    body.innerHTML = `<span class="loica-tr-spinner"></span> <span style="opacity:.6">Translating to ${target}…</span>`;
    const mySeq = ++seq;

    streamTranslate(docId, text, source, target, (full) => {
      if (mySeq !== seq) return;
      currentText = full;
      body.textContent = full;
    })
      .then(({ model }) => {
        if (mySeq !== seq) return;
        setDecos(view, sourceDecos(view.state.doc, from, to, false));
        if (!currentText) body.innerHTML = `<span style="opacity:.6">(empty translation)</span>`;
        copyBtn.disabled = !currentText;
        copyBtn.style.opacity = currentText ? "1" : "0.5";
        footer.textContent = `Read-only — the original is unchanged${model ? ` · ${model}` : ""}.`;
      })
      .catch((err: unknown) => {
        if (mySeq !== seq) return;
        setDecos(view, sourceDecos(view.state.doc, from, to, false));
        body.innerHTML = "";
        const p = document.createElement("div");
        p.style.color = "var(--danger, #c0392b)";
        p.textContent = err instanceof Error ? err.message : "Translation failed.";
        body.appendChild(p);
      });
  }

  copyBtn.addEventListener("click", () => {
    if (!currentText) return;
    try {
      navigator.clipboard?.writeText(currentText);
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
    } catch {
      /* ignore */
    }
  });

  active = {
    el: pop,
    destroy: () => {
      seq++; // invalidate any in-flight request
      pop.remove();
      setDecos(view, DecorationSet.empty);
      document.removeEventListener("mousedown", onDocMouseDown, true);
    },
  };
  document.addEventListener("mousedown", onDocMouseDown, true);

  // Auto-translate into the smart default target immediately.
  run(defaultTarget(source));
}

// ── selection-menu action ────────────────────────────────────────────────────

function flash(view: EditorView, msg: string) {
  try {
    let left = window.innerWidth / 2, top = 80;
    try {
      const c = view.coordsAtPos(view.state.selection.to);
      left = c.left; top = c.bottom + 8;
    } catch {
      /* centre-top */
    }
    const t = document.createElement("div");
    t.textContent = msg;
    Object.assign(t.style, {
      position: "fixed", left: `${Math.min(left, window.innerWidth - 200)}px`, top: `${top}px`,
      zIndex: "1600", padding: "4px 10px", fontSize: "12px",
      background: "var(--fg, #111)", color: "var(--bg, #fff)",
      borderRadius: "8px", boxShadow: "0 2px 8px rgba(0,0,0,0.2)", pointerEvents: "none",
    } as CSSStyleDeclaration);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  } catch {
    /* ignore */
  }
}

/**
 * "Translate" — invoked from the native selection menu (`index.ts`). Detects the
 * language, opens the inline popover, and streams the default translation. No-op
 * if nothing is selected.
 */
export function runTranslate(view: EditorView, opts: TranslatePluginOptions): void {
  const s = view.state.selection;
  if (s.empty || s.to - s.from < MIN_CHARS) {
    flash(view, "Select some text first");
    return;
  }
  const text = selectionToText(view.state.doc, s.from, s.to);
  if (!text.trim()) {
    flash(view, "Select some text first");
    return;
  }
  openTranslator(view, opts.docId, s.from, s.to);
}

// ── plugin ───────────────────────────────────────────────────────────────────

export interface TranslatePluginOptions {
  docId: string;
}

export function translatePlugin(_opts: TranslatePluginOptions): Plugin {
  return new Plugin<DecorationSet>({
    key: translatePluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr: Transaction, old: DecorationSet) {
        try {
          const meta = tr.getMeta(translatePluginKey) as DecorationSet | undefined;
          if (meta) return meta;
          return old.map(tr.mapping, tr.doc);
        } catch {
          return DecorationSet.empty;
        }
      },
    },
    props: {
      decorations(state: EditorState) {
        return translatePluginKey.getState(state) ?? DecorationSet.empty;
      },
    },
    view() {
      // No UI of its own — the trigger lives in the selection menu
      // (`runTranslate`). Tidy up any open popover on teardown.
      return { destroy: () => closePopover() };
    },
  });
}
