const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const LogMonitor = require('./logMonitor');
const AgentManager = require('./agentManager');

// Debug logging to file
const debugLog = (msg) => {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${msg}\n`;
  fs.appendFileSync(path.join(__dirname, 'debug.log'), logMsg);
  console.log(msg);
};

let mainWindow;
let logMonitor = null;
let agentManager = null;

// =====================================================
// 에이전트 수에 따른 동적 윈도우 크기 (P1-6)
// =====================================================
function getWindowSizeForAgents(count) {
  if (count <= 1) return { width: 220, height: 200 };

  // 멀티 에이전트: 카드 90px × N + 갭 + 외부 패딩
  const CARD_W = 90;
  const GAP = 10;
  const OUTER = 20;
  const HEIGHT = 195;

  const width = Math.max(220, count * CARD_W + (count - 1) * GAP + OUTER);
  return { width, height: HEIGHT };
}

function resizeWindowForAgents(count) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { width, height } = getWindowSizeForAgents(count);
  mainWindow.setSize(width, height);
  console.log(`[Main] Window → ${width}×${height} (${count} agents)`);
}

// =====================================================
// 윈도우 생성
// =====================================================
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
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  });

  // 작업표시줄 복구 폴링 (250ms)
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  }, 250);
}

// =====================================================
// 앱 설정
// ============================================================
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-logging');
app.commandLine.appendSwitch('log-level', '3');
process.env.ELECTRON_DISABLE_LOGGING = '1';
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// =====================================================
// Claude CLI 훅 자동 등록 & 프로세스 PID 모니터링
// =====================================================
function setupClaudeHooks() {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      const rawContent = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '');
      settings = JSON.parse(rawContent);
    }
    if (!settings.hooks) settings.hooks = {};

    const startScript = path.join(__dirname, 'sessionstart_hook.js').replace(/\\/g, '/');
    const endScript = path.join(__dirname, 'sessionend_hook.js').replace(/\\/g, '/');

    const startCmd = `node "${startScript}"`;
    const endCmd = `node "${endScript}"`;

    const upsertHook = (eventName, cmd) => {
      let eventHooks = settings.hooks[eventName] || [];
      eventHooks = eventHooks.filter(container => {
        if (!container.hooks) return true;
        return !container.hooks.some(h => h.type === 'command' && h.command && h.command.includes(path.basename(cmd)));
      });
      eventHooks.push({ matcher: "*", hooks: [{ type: "command", command: cmd }] });
      settings.hooks[eventName] = eventHooks;
    };

    upsertHook('SessionStart', startCmd);
    upsertHook('SessionEnd', endCmd);

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
    debugLog('[Main] Registered SessionStart & SessionEnd hooks to settings.json');
  } catch (e) {
    debugLog(`[Main] Failed to setup hooks: ${e.message}`);
  }
}

function startPidMonitoring() {
  const pidFile = path.join(os.homedir(), '.claude', 'agent_pids.json');
  const { execFile } = require('child_process');
  const SCAN_INTERVAL = 5000;          // 5초마다 스캔
  const GRACE_PERIOD_MS = 15000;       // 에이전트 등록 후 15초간 보호
  const MAX_ABSENT_COUNT = 3;          // 3회 연속 미발견 시 DEAD 판정
  const absentCounts = new Map();      // agentId → 연속 미발견 횟수

  // agent_pids.json이 없으면 빈 파일로 자동 생성
  if (!fs.existsSync(pidFile)) {
    try {
      fs.writeFileSync(pidFile, '{}', 'utf-8');
      debugLog('[Main] Created agent_pids.json (empty)');
    } catch (e) {
      debugLog(`[Main] Failed to create agent_pids.json: ${e.message}`);
    }
  }

  // 시스템에서 claude-code CLI node.exe 프로세스 목록을 가져오는 함수
  function scanClaudeProcesses(callback) {
    const psCmd = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*claude-code*cli.js*' } | ForEach-Object { $_.ProcessId }`;
    execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        debugLog(`[Main] Scan error: ${err.message}`);
        callback([]);
        return;
      }
      const pids = stdout.trim().split('\n')
        .map(l => parseInt(l.trim(), 10))
        .filter(p => p > 0);
      callback(pids);
    });
  }

  setInterval(() => {
    if (!agentManager) return;
    const agents = agentManager.getAllAgents();
    if (agents.length === 0) return;

    scanClaudeProcesses((livePids) => {
      debugLog(`[Main] Scan: ${livePids.length} claude proc(s), ${agents.length} agent(s)`);

      // 활성 에이전트 중 Grace Period 제외한 것만 체크 대상
      const checkable = agents.filter(a => {
        if (a.firstSeen && (Date.now() - a.firstSeen < GRACE_PERIOD_MS)) {
          absentCounts.delete(a.id);
          return false;
        }
        return true;
      });

      if (checkable.length === 0) return;

      // 에이전트 수 ≤ 프로세스 수 → 모두 살아있다고 판단
      if (livePids.length >= checkable.length) {
        for (const a of checkable) absentCounts.delete(a.id);
        return;
      }

      // 에이전트 수 > 프로세스 수 → 초과분을 제거해야 함
      // JSONL 파일 mtime 기준: 터미널이 닫히면 파일 갱신이 즉시 멈추므로
      // mtime이 가장 오래된 에이전트가 죽은 것일 확률이 높음
      const excessCount = checkable.length - livePids.length;

      // JSONL mtime 가져오기 (파일이 없으면 0)
      const withMtime = checkable.map(a => {
        let mtime = 0;
        try {
          if (a.jsonlPath) mtime = fs.statSync(a.jsonlPath).mtimeMs;
        } catch (e) { }
        return { agent: a, mtime };
      });

      // mtime 오름차순 (가장 오래된 것 = 죽었을 확률 높음)
      withMtime.sort((a, b) => a.mtime - b.mtime);

      const suspect = withMtime.slice(0, excessCount).map(w => w.agent);
      const alive = withMtime.slice(excessCount).map(w => w.agent);

      for (const a of alive) absentCounts.delete(a.id);

      for (const agent of suspect) {
        const count = (absentCounts.get(agent.id) || 0) + 1;
        absentCounts.set(agent.id, count);

        if (count < MAX_ABSENT_COUNT) {
          debugLog(`[Main] Agent ${agent.id.slice(0, 8)} suspect (excess), absent ${count}/${MAX_ABSENT_COUNT}`);
          continue;
        }

        // ── 3회 연속: DEAD 확정 ──
        debugLog(`[Main] Agent ${agent.id.slice(0, 8)} DEAD — excess agent removed after ${count} scans`);
        absentCounts.delete(agent.id);

        // JSONL에 SessionEnd 기록 (좀비 방지)
        if (agent.jsonlPath && fs.existsSync(agent.jsonlPath)) {
          try {
            fs.appendFileSync(agent.jsonlPath, JSON.stringify({
              type: "system", subtype: "SessionEnd", sessionId: agent.id, timestamp: new Date().toISOString()
            }) + '\n');
          } catch (e) { }
        }

        agentManager.removeAgent(agent.id);

        // agent_pids.json에서도 삭제
        try {
          const pidsInfo = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
          delete pidsInfo[agent.id];
          const tmpFile = pidFile + '.tmp';
          fs.writeFileSync(tmpFile, JSON.stringify(pidsInfo, null, 2));
          fs.renameSync(tmpFile, pidFile);
        } catch (e) { }
      }
    });
  }, SCAN_INTERVAL);
}

app.whenReady().then(() => {
  debugLog('Pixel Agent Desk started');
  setupClaudeHooks();
  startPidMonitoring();
  createWindow();


  ipcMain.once('renderer-ready', () => {
    debugLog('[Main] renderer-ready event received!');

    agentManager = new AgentManager();
    agentManager.start();
    debugLog('[Main] AgentManager started');

    // 에이전트 이벤트 → renderer IPC 전달 + 동적 리사이징
    agentManager.on('agent-added', (agent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-added', agent);
        resizeWindowForAgents(agentManager.getAgentCount());
      }
    });

    agentManager.on('agent-updated', (agent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-updated', agent);
      }
    });

    agentManager.on('agent-removed', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-removed', data);
        resizeWindowForAgents(agentManager.getAgentCount());
      }
    });

    agentManager.on('agents-cleaned', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agents-cleaned', data);
        resizeWindowForAgents(agentManager.getAgentCount());
      }
    });

    logMonitor = new LogMonitor(agentManager);
    debugLog('[Main] Starting LogMonitor...');
    logMonitor.start();
    debugLog('[Main] LogMonitor started');

    // =====================================================
    // 비활성 에이전트 정리: JSONL mtime 기반 (P3-Active)
    // Claude가 실행 중이면 로그 파일이 계속 갱신됨
    // 30분 이상 로그 변경이 없으면 비활성으로 간주 → 제거
    // =====================================================
    const INACTIVE_MS = 30 * 60 * 1000; // 30분

    function checkInactiveAgents() {
      if (!agentManager || !logMonitor) return;
      const now = Date.now();
      const agents = agentManager.getAllAgents();

      for (const agent of agents) {
        if (!agent.jsonlPath) continue;

        try {
          const stat = require('fs').statSync(agent.jsonlPath);
          const mtime = stat.mtimeMs;
          const age = now - mtime;

          if (age > INACTIVE_MS) {
            debugLog(`[Main] Agent '${agent.displayName}' inactive for ${Math.round(age / 60000)}min, removing...`);
            agentManager.removeAgent(agent.id);
          }
        } catch (e) {
          // 파일이 없어진 경우도 제거
          debugLog(`[Main] Agent '${agent.displayName}' jsonl missing, removing...`);
          agentManager.removeAgent(agent.id);
        }
      }
    }

    // 시작 5분 후 첫 체크 (앱 시작 직후엔 로그가 오래됐을 수 있음)
    setTimeout(() => checkInactiveAgents(), 5 * 60 * 1000);

    // 이후 5분마다 주기적 체크
    setInterval(() => checkInactiveAgents(), 5 * 60 * 1000);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (logMonitor) logMonitor.stop();
  if (agentManager) agentManager.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (logMonitor) logMonitor.stop();
  if (agentManager) agentManager.stop();
});

// =====================================================
// IPC 핸들러
// =====================================================

ipcMain.on('get-work-area', (event) => {
  event.reply('work-area-response', screen.getPrimaryDisplay().workArea);
});

ipcMain.on('constrain-window', (event, bounds) => {
  const wa = screen.getPrimaryDisplay().workArea;
  const { width, height } = mainWindow.getBounds();
  mainWindow.setPosition(
    Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - width)),
    Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - height))
  );
});

ipcMain.on('get-all-agents', (event) => event.reply('all-agents-response', agentManager?.getAllAgents() ?? []));
ipcMain.on('get-agent-stats', (event) => event.reply('agent-stats-response', agentManager?.getStats() ?? {}));

// 에이전트 수동 퇴근 IPC 핸들러
ipcMain.on('dismiss-agent', (event, agentId) => {
  if (agentManager) agentManager.dismissAgent(agentId);
});
