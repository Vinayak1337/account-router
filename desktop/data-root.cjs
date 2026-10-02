const { join, resolve, basename } = require("node:path");
const fs = require("node:fs/promises");

function dataRoot(args, home) {
  const index = args.indexOf("--data-dir");
  if (index >= 0) {
    if (!args[index + 1]) throw new Error("--data-dir needs a directory.");
    return resolve(args[index + 1]);
  }
  return resolve(home, ".account-router");
}

async function migrateLegacyData(root, home) {
  const legacy = resolve(home, "AppData", "Local", "Account Router");
  if (root.toLowerCase() === legacy.toLowerCase()) return;
  try {
    await fs.access(join(root, "router.config.json"));
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await fs.access(join(legacy, "router.config.json"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  try {
    await fs.access(root);
    throw new Error("Account Router data is incomplete. Existing files were preserved.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stage = `${root}.migrating-${process.pid}-${Date.now()}`;
  await fs.cp(legacy, stage, {
    recursive: true,
    filter: (source) => basename(source) !== "router.lock",
  });
  await fs.rename(stage, root);
}

module.exports = { dataRoot, migrateLegacyData };
