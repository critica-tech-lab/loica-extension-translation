import { route, type RouteConfigEntry } from "@react-router/dev/routes";

// Discovered by the glob in `app/extensions/routes.ts`. Points at a shim under
// `app/routes/` (not directly at `translate.ts`) because this extension is
// symlinked in from an out-of-root repo: React Router only runs its
// server/client split on route modules physically under `app/`. The shim
// (`app/routes/api.translate.$id.ts`, source in `route-shim.ts`) re-exports the
// action, keeping server-only imports off the client bundle.
export default [
  route("api/translate/:id", "routes/api.translate.$id.ts"),
] satisfies RouteConfigEntry[];
