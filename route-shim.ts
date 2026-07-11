/**
 * Shim route source for the translation extension.
 *
 * Copy to `app/routes/api.translate.$id.ts` in the host (git-ignored there).
 * React Router only splits route modules physically under `app/`, and this
 * extension is symlinked in from an out-of-root repo — so the real `action` (in
 * `translate.ts`, importing server-only `~/lib/*`) can't be a route module
 * directly. This thin re-export is a real file under `app/routes/`, so RR marks
 * it server-only.
 */
export { action } from "~/extensions/translation/translate";
