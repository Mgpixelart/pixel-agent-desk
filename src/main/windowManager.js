/**
 * Window Manager
 * Main window, dashboard window, keep-alive, resize, dashboard server management
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');

function createWindowManager({ agentManager, sessionScanner, heatmapScanner, debugLog, adaptAgentToDashboard, errorHandler, getWindowSizeForAgents }) {
  let mainWindow = null;
  let dashboardWindow = null;
  let pipWindow = null;
  let keepAliveInterval = null;
  let dashboardServer = null;

  function resizeWindowForAgents(agentsOrCount) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { width, height } = getWindowSizeForAgents(agentsOrCount);
    const bounds = mainWindow.getBounds();
    if (width === bounds.width && height === bounds.height) return;
    const wa = screen.getDisplayMatching(bounds).bounds;
    const dh = height - bounds.height;
    const newY = Math.max(wa.y, Math.min(bounds.y - dh, wa.y + wa.height - height));
    const newX = Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - width));
    mainWindow.setBounds({ x: newX, y: newY, width, height });
    const info = Array.isArray(agentsOrCount) ? agentsOrCount.length : agentsOrCount;
    debugLog(`[Main] Window → ${width}x${height} (${info} agents)`);
  }

  function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const winSize = getWindowSizeForAgents(0);

    mainWindow = new BrowserWindow({
      width: winSize.width,
      height: winSize.height,
      x: Math.round((width - winSize.width) / 2),
      y: Math.round((height - winSize.height) / 2),
      transparent: true,
      frame: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: true,
      focusable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    mainWindow.loadFile(path.join(__dirname, '..', '..', 'index.html'));

    errorHandler.setMainWindow(mainWindow);

    // Constrain window to display bounds after drag (multi-monitor aware)
    let constraining = false;
    mainWindow.on('moved', () => {
      if (constraining || mainWindow.isDestroyed()) return;
      const b = mainWindow.getBounds();
      const wa = screen.getDisplayMatching(b).bounds;
      const cx = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - b.width));
      const cy = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height));
      if (cx !== b.x || cy !== b.y) {
        constraining = true;
        mainWindow.setPosition(cx, cy);
        constraining = false;
      }
    });

    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      // DevTools: only when --dev argument or npm run dev
      if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    });

    // Main window (avatar) closed -> close dashboard and quit app
    mainWindow.on('closed', () => {
      mainWindow = null;
      closeDashboardWindow();
      const { app } = require('electron');
      app.quit();
    });

    startKeepAlive();
  }

  function startKeepAlive() {
    if (keepAliveInterval) return;
    keepAliveInterval = setInterval(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    }, 5000);
    debugLog('[Main] Keep-alive interval started');
  }

  function stopKeepAlive() {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
      debugLog('[Main] Keep-alive interval stopped');
    }
  }

  function createDashboardWindow() {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      debugLog('[MissionControl] Window already open, focusing existing window');
      if (dashboardWindow.isMinimized()) {
        dashboardWindow.restore();
      }
      dashboardWindow.focus();
      return { success: true, alreadyOpen: true };
    }

    try {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;

      // Map(864) + sidebar(240) + padding = 1104+, height: generous for pixel art
      const minDashW = 1280;
      const minDashH = 980;
      const dashW = Math.min(Math.max(minDashW, Math.floor(width * 0.9)), width - 20);
      const dashH = Math.min(Math.max(minDashH, Math.floor(height * 0.95)), height - 10);

      dashboardWindow = new BrowserWindow({
        width: dashW,
        height: dashH,
        x: Math.floor((width - dashW) / 2),
        y: Math.floor((height - dashH) / 2),
        title: 'Pixel Agent Desk',
        backgroundColor: '#ffffff',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          preload: path.join(__dirname, '..', 'dashboardPreload.js')
        }
      });

      // Load via HTTP server (instead of file://) — needed for serving office module static files
      dashboardWindow.loadURL('http://localhost:3000/');

      dashboardWindow.webContents.on('did-finish-load', () => {
        debugLog('[MissionControl] Window loaded successfully');

        if (agentManager) {
          const agents = agentManager.getAllAgents();
          const adaptedAgents = agents.map(agent => adaptAgentToDashboard(agent));
          debugLog(`[MissionControl] Sending ${adaptedAgents.length} agents to dashboard`);
          dashboardWindow.webContents.send('dashboard-initial-data', adaptedAgents);
        }
      });

      dashboardWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        debugLog(`[MissionControl] Failed to load: ${errorCode} - ${errorDescription}`);
        dashboardWindow.destroy();
        dashboardWindow = null;
      });

      dashboardWindow.on('closed', () => {
        debugLog('[MissionControl] Window closed');
        dashboardWindow = null;
      });

      debugLog('[MissionControl] Window created');
      return { success: true };

    } catch (error) {
      debugLog(`[MissionControl] Failed to create window: ${error.message}`);
      dashboardWindow = null;
        return { success: false, error: error.message };
    }
  }

  function createPipWindow() {
    if (pipWindow && !pipWindow.isDestroyed()) {
      pipWindow.focus();
      return;
    }

    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    // Office map is 864x800 → aspect ~1.08
    const pipW = 432;
    const pipH = 400;
    const margin = 20;

    pipWindow = new BrowserWindow({
      width: pipW,
      height: pipH,
      x: width - pipW - margin,
      y: height - pipH - margin,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#0d1117',
        symbolColor: '#8b949e',
        height: 28
      },
      alwaysOnTop: true,
      resizable: true,
      maximizable: false,
      minWidth: 200,
      minHeight: 200,
      skipTaskbar: false,
      title: 'Office PiP',
      backgroundColor: '#050709',
      hasShadow: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: path.join(__dirname, '..', 'pipPreload.js')
      }
    });

    pipWindow.setAspectRatio(864 / 800);
    pipWindow.setAlwaysOnTop(true, 'floating');

    pipWindow.loadURL('http://localhost:3000/pip');

    // Notify dashboard: PiP opened → show placeholder
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('pip-state-changed', true);
    }

    pipWindow.on('closed', () => {
      pipWindow = null;
      // Notify dashboard: PiP closed → restore canvas
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('pip-state-changed', false);
      }
    });

    debugLog('[PiP] Window created');
  }

  function closePipWindow() {
    if (pipWindow && !pipWindow.isDestroyed()) {
      pipWindow.close();
      debugLog('[PiP] Window closed by request');
    }
    pipWindow = null;
  }

  function closeDashboardWindow() {
    closePipWindow();
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.close();
      debugLog('[MissionControl] Window closed by request');
    }
    dashboardWindow = null;
  }

  function startDashboardServer() {
    if (dashboardServer) {
      debugLog('[Dashboard] Server is already running.');
      return;
    }

    debugLog('[Dashboard] Starting server...');

    try {
      const serverModule = require('../dashboard-server.js');

      if (agentManager) {
        serverModule.setAgentManager(agentManager);
      }
      if (sessionScanner) {
        serverModule.setSessionScanner(sessionScanner);
      }
      if (heatmapScanner) {
        serverModule.setHeatmapScanner(heatmapScanner);
      }

      dashboardServer = serverModule.startServer();

      debugLog('[Dashboard] Server started (port 3000)');
    } catch (error) {
      debugLog(`[Dashboard] Failed to start: ${error.message}`);
    }
  }

  function stopDashboardServer() {
    if (dashboardServer) {
      debugLog('[Dashboard] Shutting down server...');
      try {
        dashboardServer.close(() => {
          debugLog('[Dashboard] Server shutdown complete');
        });
      } catch (error) {
        debugLog(`[Dashboard] Error during shutdown: ${error.message}`);
      }
      dashboardServer = null;
    }
  }

  return {
    get mainWindow() { return mainWindow; },
    get dashboardWindow() { return dashboardWindow; },
    get pipWindow() { return pipWindow; },
    createWindow,
    startKeepAlive,
    stopKeepAlive,
    createDashboardWindow,
    closeDashboardWindow,
    createPipWindow,
    closePipWindow,
    startDashboardServer,
    stopDashboardServer,
    resizeWindowForAgents,
  };
}

module.exports = { createWindowManager };
