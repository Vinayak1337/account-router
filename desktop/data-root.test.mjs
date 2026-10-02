import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import dataRootModule from "./data-root.cjs";

const { dataRoot, migrateLegacyData } = dataRootModule;

test("default account store is stable across launch environments", () => {
  const home = join(os.tmpdir(), "router-home");
  assert.equal(dataRoot([], home), resolve(home, ".account-router"));
  assert.equal(dataRoot(["--data-dir", home], home), resolve(home));
  assert.throws(() => dataRoot(["--data-dir"], home));
});

test("legacy store migrates without copying a stale lock or replacing existing data", async (t) => {
  const home = await fs.mkdtemp(join(os.tmpdir(), "router-data-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const legacy = join(home, "AppData", "Local", "Account Router");
  const root = dataRoot([], home);
  await fs.mkdir(join(legacy, ".runtime"), { recursive: true });
  await fs.writeFile(join(legacy, "router.config.json"), '{"accounts":[1]}');
  await fs.writeFile(join(legacy, ".runtime", "local-key"), "key");
  await fs.writeFile(join(legacy, ".runtime", "router.lock"), "stale");

  await migrateLegacyData(root, home);
  assert.equal(await fs.readFile(join(root, "router.config.json"), "utf8"), '{"accounts":[1]}');
  assert.equal(await fs.readFile(join(root, ".runtime", "local-key"), "utf8"), "key");
  await assert.rejects(fs.access(join(root, ".runtime", "router.lock")), { code: "ENOENT" });
  await fs.writeFile(join(root, "router.config.json"), '{"accounts":[2]}');
  await migrateLegacyData(root, home);
  assert.equal(await fs.readFile(join(root, "router.config.json"), "utf8"), '{"accounts":[2]}');
  assert.equal(await fs.readFile(join(legacy, "router.config.json"), "utf8"), '{"accounts":[1]}');
});
