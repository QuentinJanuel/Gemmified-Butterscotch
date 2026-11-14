/**
 * Where the runner's files are in WASMFS, and where the same files are in the GEMS store
 * (SPEC §13.5, the `gms1`/`gms2` profile).
 *
 * The plugin puts the game at `/game/` (so `working_directory` is the `game` root string) and
 * tells the runner to save under `/appdata/<Name>/`. Upstream's overlay sends a relative write to
 * the save folder but a write to a `working_directory`-prefixed path into `/game/` itself, and the
 * profile puts both in `appdata` at `<Name>/…`; so a stored file is placed back in both places.
 */

import type { VPath } from "../gems/vfs";

const GAME = "/game/";
const APPDATA = "/appdata/";

/** The store path of a WASMFS path the runner changed, or null for one outside the profile. */
export function storePath(name: string, path: string): VPath | null {
  const save = `${APPDATA}${name}`;
  if (path === save) return { mount: "appdata", segments: [name] };
  let rest: string;
  if (path.startsWith(`${save}/`)) rest = path.slice(save.length + 1);
  else if (path.startsWith(GAME)) rest = path.slice(GAME.length);
  else return null;
  const segments = rest.split("/").filter(Boolean);
  return segments.length === 0 ? null : { mount: "appdata", segments: [name, ...segments] };
}

/** Every WASMFS path the runner may read a stored file from. */
export function wasmfsPaths(name: string, path: VPath): string[] {
  if (path.mount === "game") return [GAME + path.segments.join("/")];
  if (path.mount !== "appdata" || path.segments[0]?.toLowerCase() !== name.toLowerCase()) return [];
  const rest = path.segments.slice(1).join("/");
  if (rest === "") return [`${APPDATA}${name}`];
  return [`${APPDATA}${name}/${rest}`, GAME + rest];
}
