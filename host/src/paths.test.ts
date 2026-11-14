import assert from "node:assert/strict";
import { test } from "node:test";
import { storePath, wasmfsPaths } from "./paths";

const NAME = "YoYoYo_Engine";

test("a write in the save folder or in the game folder is appdata/<Name>/… (SPEC §13.5)", () => {
  assert.deepEqual(storePath(NAME, `/appdata/${NAME}/save.ini`), {
    mount: "appdata",
    segments: [NAME, "save.ini"],
  });
  assert.deepEqual(storePath(NAME, "/game/Data/save1"), {
    mount: "appdata",
    segments: [NAME, "Data", "save1"],
  });
  assert.deepEqual(storePath(NAME, `/appdata/${NAME}`), { mount: "appdata", segments: [NAME] });
});

test("a path outside both folders is not persisted", () => {
  assert.equal(storePath(NAME, "/save.ini"), null);
  assert.equal(storePath(NAME, "/appdata/Other/save.ini"), null);
  assert.equal(storePath(NAME, "/game/"), null);
  assert.equal(storePath(NAME, "/game"), null);
});

test("a stored file is placed where a relative and a working_directory read each find it", () => {
  assert.deepEqual(wasmfsPaths(NAME, { mount: "appdata", segments: [NAME, "Data", "save1"] }), [
    `/appdata/${NAME}/Data/save1`,
    "/game/Data/save1",
  ]);
  assert.deepEqual(wasmfsPaths(NAME, { mount: "appdata", segments: [NAME] }), [`/appdata/${NAME}`]);
  assert.deepEqual(wasmfsPaths(NAME, { mount: "appdata", segments: ["Other", "x"] }), []);
  assert.deepEqual(wasmfsPaths(NAME, { mount: "temp", segments: ["x"] }), []);
  assert.deepEqual(wasmfsPaths(NAME, { mount: "game", segments: ["x"] }), ["/game/x"]);
});

test("the two directions agree", () => {
  const path = { mount: "appdata", segments: [NAME, "a", "b.txt"] } as const;
  for (const at of wasmfsPaths(NAME, path)) assert.deepEqual(storePath(NAME, at), path);
});
