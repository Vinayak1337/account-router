const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  dialog,
  shell,
} = require("electron");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs/promises");
app.setName("Account Router");
const args = process.argv.slice(app.isPackaged ? 1 : 2),
  dataIndex = args.indexOf("--data-dir");
const root = resolve(
  dataIndex >= 0 && args[dataIndex + 1]
    ? args[dataIndex + 1]
    : join(
        process.env.LOCALAPPDATA || app.getPath("appData"),
        "Account Router",
      ),
);
let window,
  tray,
  router,
  lockPath,
  key,
  owns = false,
  quitting = false;
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("window-all-closed", () => {});
  app.on("activate", () => window?.show());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    (async () => {
      if (owns && router) {
        await router.drain();
        await cleanupLock();
      }
      app.quit();
    })().catch(() => {
      quitting = false;
      dialog.showErrorBox(
        "Account Router",
        "Could not finish shutdown. Requests and account data were preserved.",
      );
    });
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox(
        "Account Router",
        error.code === "EADDRINUSE"
          ? "This port is already in use. Close the other router, then reopen Account Router."
          : error.message || "Could not start the router.",
      );
      quitting = true;
      cleanupLock().finally(() => app.quit());
    });
}
async function cleanupLock() {
  if (!lockPath || !owns) return;
  try {
    if ((await fs.readFile(lockPath, "utf8")).trim() === String(process.pid))
      await fs.unlink(lockPath);
  } catch {}
}
async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "X-Local-Router-Key": key },
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
async function start() {
  const project = resolve(__dirname, "..");
  const { createRouter, localKey, atomicJson } = await import(
    pathToFileURL(join(project, "router.mjs")).href
  );
  const { protectStorage } = await import(
    pathToFileURL(join(__dirname, "login.mjs")).href
  );
  await protectStorage(root);
  await protectStorage(join(root, ".runtime"));
  await protectStorage(join(root, "accounts"));
  let config;
  try {
    config = JSON.parse(
      (await fs.readFile(join(root, "router.config.json"), "utf8")).replace(
        /^\uFEFF/,
        "",
      ),
    );
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(
        "Router configuration is invalid. The original file was preserved.",
      );
    config = {
      port: 18891,
      strategy: "exhaust-first",
      freeSolRouting: false,
      accounts: [],
    };
    await atomicJson(join(root, "router.config.json"), config);
  }
  key = await localKey(root);
  const existing = await health(config.port);
  if (existing) {
    if (resolve(existing.root).toLowerCase() !== root.toLowerCase() || existing.draining)
      throw new Error(
        "A different or shutting-down router owns this port. Reopen Account Router after it stops.",
      );
  } else {
    lockPath = join(root, ".runtime/router.lock");
    let handle;
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await fs.readFile(lockPath, "utf8"));
      let alive = false;
      try {
        if (pid > 0) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {}
      if (alive)
        throw new Error("This router is already starting. Reopen it shortly.");
      await fs.unlink(lockPath);
      handle = await fs.open(lockPath, "wx");
    }
    owns = true;
    await handle.writeFile(String(process.pid));
    await handle.close();
    router = await createRouter(config, { root, key });
    await new Promise((accept, reject) => {
      router.server.once("error", reject);
      router.server.listen(config.port, "127.0.0.1", accept);
    });
    router.server.once("close", async () => {
      await router.drain();
      await cleanupLock();
      if (!quitting) {
        quitting = true;
        app.quit();
      }
    });
  }
  const origin = `http://127.0.0.1:${config.port}`;
  window = new BrowserWindow({
    width: 1240,
    height: 900,
    minWidth: 540,
    minHeight: 540,
    title: "Account Router",
    backgroundColor: "#161719",
    autoHideMenuBar: true,
    show: false,
    icon: join(__dirname, "icon.png"),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const external = (url) => {
    try {
      const u = new URL(url);
      if (u.protocol === "https:" && u.hostname === "auth.openai.com")
        shell.openExternal(url);
    } catch {}
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(origin + "/dashboard")) {
      event.preventDefault();
      external(url);
    }
  });
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.once("ready-to-show", () => window.show());
  await window.loadURL(origin + "/dashboard");
  tray = new Tray(nativeImage.createFromPath(join(__dirname, "icon.png")));
  tray.setToolTip("Account Router");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Account Router",
        click: () => {
          window.show();
          window.focus();
        },
      },
      { type: "separator" },
      { label: "Quit · finish active requests", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", () => {
    window.show();
    window.focus();
  });
  if (args.includes("--smoke-test")) {
    await fs.writeFile(
      join(root, ".runtime/smoke-result.json"),
      JSON.stringify({
        ok: true,
        packaged: app.isPackaged,
        port: config.port,
        accounts: config.accounts.length,
        node: process.versions.node,
        electron: process.versions.electron,
      }),
    );
    setTimeout(() => app.quit(), 2000);
  }
}
