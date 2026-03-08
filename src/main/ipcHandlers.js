/**
 * IPC Handlers
 * Register all ipcMain.on/handle handlers + focusTerminalByPid
 */

const { ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

function focusTerminalByPid(pid, label, debugLog) {
  const { execFile } = require('child_process');

  if (process.platform === 'win32') {
    const psScript = `
$memberDef = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);' +
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);' +
  '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);'
Add-Type -MemberDefinition $memberDef -Name W -Namespace FocusUtil -ErrorAction SilentlyContinue
$tpid = ${pid}
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 5; $i++) {
  $p = Get-Process -Id $tpid -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
    $hwnd = $p.MainWindowHandle
    break
  }
  $pp = (Get-CimInstance Win32_Process -Filter "ProcessId = $tpid" -ErrorAction SilentlyContinue).ParentProcessId
  if (-not $pp -or $pp -eq 0 -or $pp -eq $tpid) { break }
  $tpid = $pp
}
if ($hwnd -ne [IntPtr]::Zero) {
  if ([FocusUtil.W]::IsIconic($hwnd)) { [FocusUtil.W]::ShowWindow($hwnd, 9) | Out-Null }
  [FocusUtil.W]::SetForegroundWindow($hwnd) | Out-Null
}
`;
    execFile('powershell.exe', ['-NoProfile', '-Command', psScript], { timeout: 5000 }, (err) => {
      if (err) debugLog(`[${label}] Focus error: ${err.message}`);
    });

  } else if (process.platform === 'darwin') {
    // macOS: walk up parent chain to find a terminal window, then activate it
    const script = `
      tell application "System Events"
        set targetPid to ${pid}
        repeat 5 times
          try
            set proc to first process whose unix id is targetPid
            set frontmost of proc to true
            return
          end try
          try
            set targetPid to unix id of (first process whose unix id is targetPid)'s parent process
          on error
            exit repeat
          end try
        end repeat
      end tell
    `;
    execFile('osascript', ['-e', script], { timeout: 5000 }, (err) => {
      if (err) debugLog(`[${label}] Focus error: ${err.message}`);
    });

  } else {
    // Linux: use wmctrl if available, fall back to xdotool
    const { exec } = require('child_process');
    exec(`wmctrl -i -a $(wmctrl -lp | awk '$3 == ${pid} {print $1; exit}') 2>/dev/null || xdotool search --pid ${pid} --onlyvisible windowactivate 2>/dev/null`, { timeout: 5000 }, (err) => {
      if (err) debugLog(`[${label}] Focus error (install wmctrl or xdotool): ${err.message}`);
    });
  }
}

function registerIpcHandlers({ agentManager, sessionPids, windowManager, debugLog, adaptAgentToDashboard, errorHandler }) {
  ipcMain.on('resize-window', (e, size) => {
    const mw = windowManager.mainWindow;
    if (!mw || mw.isDestroyed()) return;
    const { width, height, x, y } = mw.getBounds();
    const newWidth = Math.max(150, Math.ceil(size.width ? size.width + 20 : width));
    const newHeight = Math.max(180, Math.ceil(size.height ? size.height + 30 : height));
    if (newWidth === width && newHeight === height) return;
    const wa = screen.getDisplayMatching(mw.getBounds()).bounds;
    const dh = newHeight - height;
    const newY = Math.max(wa.y, Math.min(y - dh, wa.y + wa.height - newHeight));
    const newX = Math.max(wa.x, Math.min(x, wa.x + wa.width - newWidth));
    mw.setBounds({ x: newX, y: newY, width: newWidth, height: newHeight });
    debugLog(`[Main] Resize → ${newWidth}x${newHeight}`);
  });

  ipcMain.on('get-avatars', (event) => {
    try {
      const charsDir = path.join(__dirname, '..', '..', 'public', 'characters');
      if (fs.existsSync(charsDir)) {
        const files = fs.readdirSync(charsDir);
        event.reply('avatars-response', files);
      } else {
        event.reply('avatars-response', []);
      }
    } catch (e) {
      errorHandler.capture(e, {
        code: 'E003',
        category: 'FILE_IO',
        severity: 'WARNING'
      });
      debugLog(`[Main] get-avatars error: ${e.message}`);
      event.reply('avatars-response', []);
    }
  });

  ipcMain.on('get-all-agents', (event) => event.reply('all-agents-response', agentManager?.getAllAgents() ?? []));

  ipcMain.handle('focus-terminal', async (event, agentId) => {
    const pid = sessionPids.get(agentId);
    if (!pid) {
      debugLog(`[Main] Focus: no PID for agent=${agentId.slice(0, 8)}`);
      return { success: false, reason: 'no-pid' };
    }
    debugLog(`[Main] Focus requested for agent=${agentId.slice(0, 8)} pid=${pid}`);
    focusTerminalByPid(pid, 'Main', debugLog);
    return { success: true };
  });

  // Dashboard IPC Handlers
  ipcMain.handle('open-web-dashboard', async (event) => {
    try {
      const result = windowManager.createDashboardWindow();
      return result;
    } catch (error) {
      debugLog(`[MissionControl] Error opening dashboard: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('execute-recovery-action', async () => ({ success: true }));

  ipcMain.on('dashboard-focus-agent', (event, agentId) => {
    const pid = sessionPids.get(agentId);
    if (!pid) {
      debugLog(`[Dashboard] Focus: no PID for agent=${agentId.slice(0, 8)}`);
      return;
    }
    debugLog(`[Dashboard] Focus requested for agent=${agentId.slice(0, 8)} pid=${pid}`);
    focusTerminalByPid(pid, 'Dashboard', debugLog);
  });

  ipcMain.on('get-dashboard-agents', (event) => {
    if (agentManager) {
      const agents = agentManager.getAllAgents();
      const adaptedAgents = agents.map(agent => adaptAgentToDashboard(agent));
      event.reply('dashboard-agents-response', adaptedAgents);
    } else {
      event.reply('dashboard-agents-response', []);
    }
  });

  // PiP IPC Handlers
  ipcMain.handle('toggle-pip', async () => {
    try {
      const pw = windowManager.pipWindow;
      if (pw && !pw.isDestroyed()) {
        windowManager.closePipWindow();
        return { success: true, action: 'closed' };
      } else {
        windowManager.createPipWindow();
        return { success: true, action: 'opened' };
      }
    } catch (error) {
      debugLog(`[PiP] Error toggling: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.on('pip-close', () => {
    windowManager.closePipWindow();
  });

  ipcMain.on('pip-minimize', () => {
    const pw = windowManager.pipWindow;
    if (pw && !pw.isDestroyed()) pw.minimize();
  });

  ipcMain.on('pip-back-to-dashboard', () => {
    windowManager.closePipWindow();
  });

  ipcMain.on('pip-drag', (event, dx, dy) => {
    const pw = windowManager.pipWindow;
    if (pw && !pw.isDestroyed()) {
      const [x, y] = pw.getPosition();
      pw.setPosition(x + dx, y + dy);
    }
  });
}

module.exports = { registerIpcHandlers };
