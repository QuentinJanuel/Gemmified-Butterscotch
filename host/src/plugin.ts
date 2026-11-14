/**
 * Butterscotch as a GEMS plugin: the module a host imports, published as host.js.
 *
 * Upstream's web build (butterscotch.mjs + butterscotch.wasm) is made for a page's main thread: its
 * sound is miniaudio's Web Audio backend on the realm's own AudioContext, and its loop suspends
 * with JSPI. So the engine runs in the host's realm, drawing into the OffscreenCanvas the host hands
 * it, and nothing here is a worker. The runner owns its loop (`startRunner` returns when the game
 * ends), so the plugin declares `clock: "engine"`: a step lets the runner run to the end of its next
 * frame, through the `waitFrame` hook src/backends/web.c calls in place of its sleep.
 *
 * The game's files go into WASMFS, which forgets everything on reload; the runner reports every
 * write through `onFileChanged` (src/overlay_file_system.c) and the plugin mirrors it into the
 * GEMS store, and places the store's files back at start (paths.ts).
 */

import { API_VERSION } from "../gems";
import {
  EngineError,
  type Acceptance,
  type EnginePlugin,
  type EngineSession,
  type FileIndex,
  type GameInfo,
  type GameInput,
  type HostServices,
  type IndexedFile,
  type NetworkConnection,
} from "../gems/engine";
import type { PluginManifest } from "../gems/engine/manifest";
import { MemoryBackend, Vfs, parsePath, type VPath } from "../gems/vfs";
import { KEYS } from "./keys";
import { storePath, wasmfsPaths } from "./paths";

/** GameMaker Studio's game data. Its presence is what this engine recognises a game by. */
const DATAWIN_RE = /(^|\/)data\.win$/i;
// `FORM` is the generic IFF magic; `FORM` whose first chunk is `GEN8` is only GameMaker's. GEN8's
// second byte is the bytecode ("WAD") version; the runner reads 8 (GMS 1.0.198) to 17 (GMS 2.2+).
const FORM = 0x464f_524d;
const GEN8 = 0x4745_4e38;
const HEADER_BYTES = 18;
const WAD_MIN = 8;
const WAD_MAX = 17;

const BUTTONS = { left: 1, right: 2, middle: 3 } as const;
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
// POSIX file-type bits of a stat mode.
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

/** What the plugin uses of the Emscripten module instance. */
interface Runner {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    mkdirTree(path: string): void;
    chdir(path: string): void;
    stat(path: string): { mode: number };
  };
  specialHTMLTargets: Record<string, unknown>;
  stringToNewUTF8(text: string): number;
  UTF8ToString(pointer: number): string;
  setValue(pointer: number, value: number, type: string): void;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _startRunner(argc: number, argv: number): Promise<number>;
  _requestRunnerExit(): void;
  _parseDataWin(path: number): Promise<number>;
  _freeDataWin(dataWin: number): void;
  _getGameName(dataWin: number): number;
  _getGameDisplayName(dataWin: number): number;
  _onKeyDown(key: number): void;
  _onKeyUp(key: number): void;
  _onMouseDown(button: number): void;
  _onMouseUp(button: number): void;
  _onMouseMove(x: number, y: number): void;
}

type RunnerFactory = (options: Record<string, unknown>) => Promise<Runner>;

async function readHeader(file: IndexedFile) {
  if (file.size < HEADER_BYTES) return { isForm: false, wad: 0 };
  // A range where the host offers one: this runs while the host is still choosing an engine.
  const bytes = (await file.readRange?.(0, HEADER_BYTES)) ?? (await file.read());
  if (bytes.byteLength < HEADER_BYTES) return { isForm: false, wad: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  const isForm = view.getUint32(0, false) === FORM;
  const isGameMaker = isForm && view.getUint32(8, false) === GEN8;
  return { isForm, wad: isGameMaker ? view.getUint8(17) : 0 };
}

/**
 * Decided by reading the container: a `data.win` that is `FORM` + `GEN8` of a bytecode version the
 * runner reads is "exact", a `FORM` of something else "probable", and anything else is declined
 * rather than failed at load.
 */
async function accepts(files: FileIndex): Promise<Acceptance | null> {
  let fallback: Acceptance | null = null;
  for (const file of files.files.filter((file) => DATAWIN_RE.test(file.path))) {
    const { isForm, wad } = await readHeader(file);
    if (wad >= WAD_MIN && wad <= WAD_MAX) return { confidence: "exact", entry: file.path };
    if (isForm && wad === 0 && fallback === null)
      fallback = { confidence: "probable", entry: file.path };
  }
  return fallback;
}

async function create(host: HostServices): Promise<EngineSession> {
  if (typeof window === "undefined" || !("Suspending" in WebAssembly)) {
    throw new EngineError("unsupported-environment", "needs a page's main thread with JSPI");
  }
  // Beside this module, not at `assets.base`, which may point at a CDN holding only the payload.
  let factory: RunnerFactory;
  try {
    factory = (await import(new URL("butterscotch.mjs", import.meta.url).href)).default;
  } catch (error) {
    throw new EngineError("asset-unavailable", String(error));
  }
  return new Session(host, factory);
}

class Session implements EngineSession {
  private runner: Runner | null = null;
  private name = "";
  private ended = false;
  private failure: unknown = null;
  /** Lets the runner go on to its next frame (set while it waits in `waitFrame`). */
  private resume: (() => void) | null = null;
  /** Settles the step: the frame is over, or the runner ended. */
  private presented: (() => void) | null = null;
  private size = { width: 0, height: 0 };
  private readonly held = new Set<number>();
  private readonly pressed = new Set<number>();
  /** The game's loopback connections (SPEC §14), by the id the runner holds. */
  private readonly connections = new Map<number, NetworkConnection>();
  private nextConnection = 1;
  private readonly files: Vfs;
  private readonly onMessage = (event: MessageEvent) => {
    // src/backends/web.c posts the caption to its own window.
    if (event.source === window && event.data?.type === "windowTitle") {
      this.host.window.setTitle(String(event.data.title));
    }
  };

  constructor(
    private readonly host: HostServices,
    private readonly factory: RunnerFactory,
  ) {
    // The store over the host's replica; the bundle stays in WASMFS, so the Vfs's own is empty.
    const backend = new MemoryBackend(host.replica.seed(), (key, value) =>
      value === null ? host.replica.remove(key) : host.replica.set(key, value),
    );
    this.files = new Vfs(host.game, backend, undefined, () => host.replica.save());
  }

  async start(files: FileIndex): Promise<GameInfo> {
    const accepted = await accepts(files);
    if (!accepted) throw new EngineError("unsupported-game", "no data.win");
    const dir = accepted.entry.slice(0, accepted.entry.lastIndexOf("/") + 1);

    const { host } = this;
    let runner: Runner;
    try {
      runner = await this.factory({
        locateFile: (path: string) => `${host.assets.base}/${path}`,
        print: (line: string) => console.debug(`butterscotch: ${line}`),
        printErr: (line: string) => console.warn(`butterscotch: ${line}`),
        waitFrame: (ms: number) => this.waitFrame(ms),
        onFileChanged: (path: string) => this.changed(path),
        // The runner's network_* builtins (src/vm_builtins.c): TCP to this machine, on a port the
        // host listens on; anything else fails as it would with nothing listening.
        netConnect: (address: string, port: number) => {
          const connection = LOOPBACK.includes(address.toLowerCase())
            ? host.network.connect(port)
            : null;
          if (!connection) return 0;
          this.connections.set(this.nextConnection, connection);
          return this.nextConnection++;
        },
        netSend: (id: number, bytes: Uint8Array) => this.connections.get(id)?.send(bytes),
        netReceive: (id: number) => {
          const connection = this.connections.get(id);
          if (!connection) return null;
          const bytes = connection.receive();
          if (bytes.length === 0 && connection.closed) {
            this.connections.delete(id);
            return null;
          }
          return bytes;
        },
        netClose: (id: number) => {
          this.connections.get(id)?.close();
          this.connections.delete(id);
        },
      });
    } catch (error) {
      throw new EngineError("asset-unavailable", String(error));
    }
    this.runner = runner;
    runner.specialHTMLTargets["#canvas"] = host.surface.canvas;
    window.addEventListener("message", this.onMessage);

    // The game's own files at /game/, whited-out ones left out.
    const { FS } = runner;
    const place = (path: string, bytes: Uint8Array) => {
      FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
      FS.writeFile(path, bytes);
    };
    for (const file of files.files) {
      if (!file.path.startsWith(dir)) continue;
      const rel = file.path.slice(dir.length);
      if (this.files.store.isWhitedOut({ mount: "game", segments: rel.split("/") })) continue;
      place(`/game/${rel}`, await file.read());
    }

    const dataWin = `/game/${accepted.entry.slice(dir.length)}`;
    const path = runner.stringToNewUTF8(dataWin);
    const parsed = await runner._parseDataWin(path);
    runner._free(path);
    if (parsed === 0) throw new EngineError("corrupt-game", "the runner could not parse data.win");
    this.name = runner.UTF8ToString(runner._getGameName(parsed));
    const title = runner.UTF8ToString(runner._getGameDisplayName(parsed));
    runner._freeDataWin(parsed);

    // The saves the host kept, where the runner reads them (paths.ts); then the host's later puts.
    const seed = (at: VPath, bytes: Uint8Array) => {
      for (const target of wasmfsPaths(this.name, at)) place(target, bytes);
    };
    for (const { path } of this.files.store.list()) {
      const bytes = this.files.store.read(path);
      if (bytes) seed(path, bytes);
    }
    for (const marked of this.files.store.markedDirectories()) {
      for (const target of wasmfsPaths(this.name, marked)) FS.mkdirTree(target);
    }
    host.replica.watch({
      put: (at, bytes) => seed(parsePath(at), bytes),
      // shortcut: a host-side delete is not forwarded; no mod deletes a file a running game reads.
      drop: () => {},
    });

    // `program_directory` is the executable's directory, resolved against the cwd.
    FS.chdir("/game");
    const argv = [dataWin, "--save-folder", `/appdata/${this.name}`];
    // shortcut: the runner splits --game-args on whitespace, so an argument with a space is two.
    if (host.launchArgs.length > 0) argv.push("--game-args", host.launchArgs.join(" "));
    const strings = argv.map((arg) => runner.stringToNewUTF8(arg));
    const vector = runner._malloc(4 * strings.length);
    strings.forEach((pointer, i) => runner.setValue(vector + 4 * i, pointer, "*"));

    const first = this.nextFrame();
    runner._startRunner(strings.length, vector).then(
      (status) => {
        if (status !== 0) console.warn(`butterscotch: the runner ended with status ${status}`);
        this.finished();
      },
      (error: unknown) => {
        this.failure = error;
        this.finished();
      },
    );
    await first;
    if (this.failure) throw new EngineError("corrupt-game", String(this.failure));
    if (this.ended)
      throw new EngineError("unsupported-game", "the game ended before its first frame");
    this.reportSize();
    return { ...this.size, title: title || undefined };
  }

  async step(): Promise<boolean> {
    if (this.ended) return false;
    const frame = this.nextFrame();
    const go = this.resume;
    this.resume = null;
    go?.();
    await frame;
    if (this.failure) throw new EngineError("internal", String(this.failure));
    this.reportSize();
    return !this.ended;
  }

  /** Immediate: the runner queues it for its next frame, and this thread is free only while it waits. */
  sendInput(input: GameInput): void {
    const runner = this.runner;
    if (!runner || this.ended) return;
    switch (input.kind) {
      case "key-down":
      case "key-up": {
        const key = KEYS[input.code];
        if (key === undefined) return;
        if (input.kind === "key-down") {
          this.held.add(key);
          runner._onKeyDown(key);
        } else {
          this.held.delete(key);
          runner._onKeyUp(key);
        }
        return;
      }
      case "pointer-move":
        return runner._onMouseMove(input.x, input.y);
      case "pointer-down":
        runner._onMouseMove(input.x, input.y);
        this.pressed.add(BUTTONS[input.button]);
        return runner._onMouseDown(BUTTONS[input.button]);
      case "pointer-up":
        this.pressed.delete(BUTTONS[input.button]);
        return runner._onMouseUp(BUTTONS[input.button]);
      case "focus-lost":
        for (const key of this.held) runner._onKeyUp(key);
        for (const button of this.pressed) runner._onMouseUp(button);
        this.held.clear();
        this.pressed.clear();
        return;
      // shortcut: the web backend takes no mouse wheel; add an entry point to it if a game needs one.
      case "wheel":
        return;
    }
  }

  setSetting(): void {}

  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    window.removeEventListener("message", this.onMessage);
    // Asks the loop to end at its next frame, then lets it get there; `startRunner` returns after.
    this.runner?._requestRunnerExit();
    const go = this.resume;
    this.resume = null;
    go?.();
  }

  private nextFrame() {
    return new Promise<void>((resolve) => {
      this.presented = resolve;
    });
  }

  /** The runner's frame wait: its own pacing, then a turn of the event loop so the canvas presents. */
  private async waitFrame(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    this.presented?.();
    this.presented = null;
    if (this.ended) return;
    await new Promise<void>((resolve) => {
      this.resume = resolve;
    });
  }

  private finished(): void {
    const ended = this.ended;
    this.ended = true;
    window.removeEventListener("message", this.onMessage);
    if (!ended) this.host.events.onEnded();
    this.presented?.();
    this.presented = null;
  }

  /** The runner sizes the canvas to the game's window; the host cannot see that itself (§7.1). */
  private reportSize(): void {
    const { width, height } = this.host.surface.canvas;
    if (width === this.size.width && height === this.size.height) return;
    this.size = { width, height };
    this.host.surface.reportSize(width, height);
  }

  /** A WASMFS path the runner changed, mirrored into the store. */
  private changed(path: string): void {
    const runner = this.runner;
    const at = storePath(this.name, path);
    if (!runner || !at) return;
    let mode: number | null;
    try {
      mode = runner.FS.stat(path).mode;
    } catch {
      mode = null;
    }
    if (mode === null) {
      if (this.files.store.isMarkedDirectory(at)) this.files.removeDir(at);
      else this.files.remove(at);
    } else if ((mode & S_IFMT) === S_IFDIR) {
      this.files.createDir(at);
    } else {
      const bytes = runner.FS.readFile(path);
      // Every handle close is reported, a read-only one's included: only a real change is stored.
      const stored = this.files.store.read(at);
      if (stored && stored.length === bytes.length && stored.every((b, i) => b === bytes[i]))
        return;
      this.files.write(at, bytes);
    }
  }
}

const plugin: EnginePlugin = {
  id: "butterscotch",
  apiVersion: API_VERSION,
  // The runner paces its own loop: each step is one frame of it (SPEC §8.1).
  capabilities: { settings: [], clock: "engine" },
  accepts,
  create,
};

export default plugin;

/** This engine's manifest, as host/build.ts writes it, from the same constants as the plugin. */
export function manifest(version: string): PluginManifest {
  return {
    id: plugin.id,
    version,
    apiVersion: plugin.apiVersion,
    entry: "host.js",
    name: "Butterscotch",
    formats: ["gms1", "gms2"],
    description:
      "Runs GameMaker Studio 1 and 2 games in the browser, on a WebAssembly build of Butterscotch, a reimplementation of the GameMaker runner in C.",
    homepage: "https://github.com/QuentinJanuel/Gemmified-Butterscotch",
    author: "Dapper Mink",
    updates: "https://gemmified-butterscotch.dappermink.me/latest.json",
    credits: [
      {
        name: "Butterscotch",
        license: "AGPL-3.0",
        url: "https://github.com/QuentinJanuel/Gemmified-Butterscotch",
        copyright: "Copyright (C) the Butterscotch authors and contributors",
        upstream: "https://github.com/ButterscotchRunner/Butterscotch",
      },
    ],
    capabilities: plugin.capabilities,
  };
}
