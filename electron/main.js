/** Dhruva desktop shell — boots the bundled Next server, then opens it in a
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
  // Electron's own binary doubles as node via ELECTRON_RUN_AS_NODE — no
  // system Node required for the UI (sf/agent CLIs still need their installs)
  serverProc = spawn(process.execPath, [serverJs], {
    cwd: path.join(root, ".next", "standalone"),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT,
      HOSTNAME: "127.0.0.1",
      // standards/ is resolved from cwd by the app — point it at the bundle
      DHRUVA_STANDARDS_DIR: path.join(root, "standards"),
    },
    stdio: "ignore",
    windowsHide: true,
  });
}

function waitForServer(retries = 120) {
  return new Promise((resolve, reject) => {
    const tick = (left) => {
      const req = http.get(`http://127.0.0.1:${PORT}`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (left <= 0) reject(new Error("Dhruva server did not start"));
        else setTimeout(() => tick(left - 1), 500);
      });
    };
    tick(retries);
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "Dhruva",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  // external links (Salesforce logins, GitHub) open in the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  await win.loadURL(`http://127.0.0.1:${PORT}`);
}

app.whenReady().then(async () => {
  try {
    startServer();
    await waitForServer();
    await createWindow();
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
      process.kill(serverProc.pid);
    } catch {
      /* already gone */
    }
  }
});
