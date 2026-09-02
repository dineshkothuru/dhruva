/** Dhruva desktop shell - boots the bundled Next server, then opens it in a
 * native window (the Claude Code-app experience: own window, own icon, no
 * browser). Everything still runs locally with the user's own logins. */

const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

const PORT = process.env.DHRUVA_PORT || "3005";
let serverProc = null;
let win = null;

function appRoot() {
  // packaged: resources/app-bundle (extraResources); dev: repo root
  return app.isPackaged
    ? path.join(process.resourcesPath, "app-bundle")
    : path.join(__dirname, "..");
}

function startServer() {
  const root = appRoot();
  const serverJs = path.join(root, ".next", "standalone", "server.js");
  // Electron's own binary doubles as node via ELECTRON_RUN_AS_NODE - no
  // system Node required for the UI (sf/agent CLIs still need their installs)
  serverProc = spawn(process.execPath, [serverJs], {
    cwd: path.join(root, ".next", "standalone"),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT,
      HOSTNAME: "127.0.0.1",
      // standards/ and workflows/ are resolved from cwd by the app - point
      // them at the bundle
      DHRUVA_STANDARDS_DIR: path.join(root, "standards"),
      DHRUVA_WORKFLOWS_DIR: path.join(root, "workflows"),
      DHRUVA_STEPS_DIR: path.join(root, "steps"),
    },
    stdio: "ignore",
    windowsHide: true,
  });
}

function waitForServer(retries = 120) {
  return new Promise((resolve, reject) => {
    // a dead child means EADDRINUSE or a crashed boot - without this listener
    // the loop would happily accept WHATEVER else answers on the port and load
    // a stranger's app into the trusted Dhruva window
    let exited = false;
    serverProc?.on("exit", (code) => {
      exited = true;
      reject(new Error(`Dhruva server exited during startup (code ${code}) - is port ${PORT} already in use?`));
    });
    const tick = (left) => {
      if (exited) return;
      // the probe hits /api so the middleware answers - and only OUR server
      // stamps x-dhruva on it
      const req = http.get(`http://127.0.0.1:${PORT}/api/runs`, (res) => {
        res.resume();
        if (res.headers["x-dhruva"] === "1") return resolve();
        reject(
          new Error(
            `something else is already running on port ${PORT} - close it or set DHRUVA_PORT`,
          ),
        );
      });
      req.on("error", () => {
        if (left <= 0) reject(new Error("Dhruva server did not start"));
        else setTimeout(() => tick(left - 1), 500);
      });
    };
    tick(retries);
  });
}

const SPLASH = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;font-family:Segoe UI,system-ui,sans-serif">
<div style="text-align:center;color:#e2e8f0">
  <div style="font-size:44px">&#10022;</div>
  <div style="font-size:20px;font-weight:600;margin-top:8px">Dhruva</div>
  <div id="m" style="font-size:12px;color:#94a3b8;margin-top:10px">starting the local server…</div>
  <div style="margin-top:14px;width:160px;height:3px;background:#1e293b;border-radius:2px;overflow:hidden;margin-left:auto;margin-right:auto">
    <div style="width:40%;height:100%;background:#38bdf8;border-radius:2px;animation:slide 1.2s ease-in-out infinite"></div>
  </div>
</div>
<style>@keyframes slide{0%{margin-left:-40%}100%{margin-left:100%}}</style>
</body></html>`)}`;

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "Dhruva",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  // external links (Salesforce logins, GitHub) open in the real browser -
  // but ONLY web links: the page renders agent output and org data, and
  // shell.openExternal on a file://, search-ms: or custom-protocol URL is an
  // OS-level launch of whatever that protocol's handler is
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // in-window navigation stays on this app: an external page rendered inside
  // the trusted Dhruva chrome is a phishing surface even with no node bridge
  win.webContents.on("will-navigate", (event, url) => {
    const ours =
      url.startsWith(`http://127.0.0.1:${PORT}`) ||
      url.startsWith(`http://localhost:${PORT}`) ||
      url.startsWith("data:");
    if (!ours) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  await win.loadURL(SPLASH);
}

function setupAutoUpdate() {
  // packaged builds check the public GitHub releases, download in the
  // background, and offer a restart - no manual installer downloads.
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    const { dialog } = require("electron");
    autoUpdater.autoDownload = true;
    // autoUpdater is an EventEmitter: a background download failure emits
    // "error", and an unhandled 'error' event throws in the main process -
    // the .catch below covers only the checkForUpdates promise
    autoUpdater.on("error", () => {
      /* offline / transient - try again next launch */
    });
    autoUpdater.on("update-downloaded", (info) => {
      const choice = dialog.showMessageBoxSync(win, {
        type: "info",
        title: "Dhruva update",
        message: `Dhruva ${info.version} is downloaded. Restart to apply?`,
        buttons: ["Restart now", "Later (applies on next quit)"],
        defaultId: 0,
      });
      if (choice === 0) autoUpdater.quitAndInstall();
    });
    autoUpdater.checkForUpdates().catch(() => {/* offline - try next launch */});
  } catch {
    /* updater unavailable - manual installer still works */
  }
}

app.whenReady().then(async () => {
  try {
    // window FIRST - a 5-10s serverless boot with no window feels like a
    // dead click; the splash appears instantly, the app URL replaces it
    await createWindow();
    startServer();
    await waitForServer();
    await win.loadURL(`http://127.0.0.1:${PORT}`);
    setupAutoUpdate();
  } catch (e) {
    const { dialog } = require("electron");
    dialog.showErrorBox("Dhruva", String(e));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("quit", () => {
  if (serverProc && !serverProc.killed) {
    try {
      if (process.platform === "win32") {
        // kill the TREE: process.kill takes only server.js, whose own
        // children (LSP servers, sf/agent CLIs mid-step) orphan on Windows
        // and accumulate across open/close cycles, holding the port
        spawn("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], { shell: false });
      } else {
        process.kill(serverProc.pid);
      }
    } catch {
      /* already gone */
    }
  }
});
