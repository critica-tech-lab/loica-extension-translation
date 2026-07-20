import { route, type RouteConfigEntry } from "@react-router/dev/routes";

// Discovered by the glob in `app/extensions/routes.ts`. Installed as a git
// submodule (see README), so this file is physically under `app/` like any
// other extension — the route points straight at `translate.ts`, no shim. React
// Router runs its server/client split on it directly, keeping server-only
// imports off the client bundle.
export default [
  route("api/translate/:id", "extensions/translation/translate.ts"),
] satisfies RouteConfigEntry[];
