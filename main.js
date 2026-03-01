const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const http = require('http');
const url = require('url');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow;
let httpServer;
let agentStates = new Map(); // sessionId -> state

// 포트 충돌 방지: 사용 가능한 포트 찾기
async function findAvailablePort(startPort = 3456) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(startPort, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      // 포트가 사용 중이면 다음 포트 시도
      resolve(findAvailablePort(startPort + 1));
    });
  });
}

// HTTP 서버 생성
async function createHttpServer() {
  const port = await findAvailablePort(3456);
  console.log(`HTTP 서버 시작: 포트 ${port}`);

  httpServer = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);

    // CORS 헤더
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // 상태 업데이트 엔드포인트
    if (req.method === 'POST' && parsedUrl.pathname === '/agent/status') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          if (!body || body.trim().length === 0) {
            res.writeHead(200); res.end(); return;
          }

          const data = JSON.parse(body);
          // 최신 Claude CLI 필드명 지원
          const sessionId = data.session_id || data.sessionId;
          const state = data.hook_event_name || data.state;
          // PostToolUseFailure를 Error로 매핑
          const mappedState = state === 'PostToolUseFailure' ? 'Error' : state;
          // 메시지 우선순위: 어시스턴트 메시지 > 프롬프트 > 도구명 > 일반 메시지
          let message = data.last_assistant_message || data.prompt || data.tool_name || data.message || "";

          // 메시지 길이 제한
          if (message.length > 200) message = message.substring(0, 197) + "...";

          if (sessionId && mappedState) {
            console.log(`상태 업데이트: [${mappedState}] ${message}`);
            agentStates.set(sessionId, { state: mappedState, message, timestamp: Date.now() });

            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('agent-state-update', { sessionId, state: mappedState, message });
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          console.error('데이터 파싱 오류:', error.message);
          res.writeHead(200); res.end();
        }
      });
    } else if (req.method === 'GET' && parsedUrl.pathname === '/agent/states') {
      const states = Array.from(agentStates.entries()).map(([sessionId, data]) => ({
        sessionId,
        ...data
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(states));
    } else if (req.method === 'GET' && parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(port, 'localhost');
  return port;
}

// 윈도우 생성
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 220,
    height: 200,
    x: Math.round((width - 220) / 2),
    y: Math.round((height - 200) / 2),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    titleBarStyle: 'hidden',
    resizable: false,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');

  // 태스크바 위로 올리기 (최상단 레벨)
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
}

// Claude CLI 훅 자동 등록
function registerHooks() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const serverUrl = "http://localhost:3456/agent/status";

  try {
    if (!fs.existsSync(settingsPath)) return;

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // 최신 Claude CLI 훅 명칭 (type: "http" 사용)
    const hookEvents = [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'Stop',
      'Notification'
    ];

    if (!settings.hooks) settings.hooks = {};

    let updated = false;

    // 이전 방식의 무효한 훅 제거
    ['Start', 'Error'].forEach(h => {
      if (settings.hooks[h]) { delete settings.hooks[h]; updated = true; }
    });

    // 최신 규격(type: "http")으로 훅 등록/업데이트
    hookEvents.forEach(name => {
      const target = [{
        matcher: "*",
        hooks: [{
          type: "http",
          url: serverUrl
        }]
      }];

      if (JSON.stringify(settings.hooks[name]) !== JSON.stringify(target)) {
        settings.hooks[name] = target;
        updated = true;
      }
    });

    if (updated) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log('최신 Claude CLI 훅 설정(HTTP 방식) 완료');
    }
  } catch (error) {
    console.error('훅 등록 실패:', error);
  }
}

// 앱 시작
app.disableHardwareAcceleration(); // GPU 가속 비활성화

app.whenReady().then(async () => {
  const port = await createHttpServer();
  console.log(`Pixel Agent Desk started - HTTP Server on port ${port}`);

  createWindow();
  registerHooks();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 앱 종료
app.on('window-all-closed', () => {
  if (httpServer) {
    httpServer.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (httpServer) {
    httpServer.close();
  }
});

// IPC 핸들러
ipcMain.on('get-work-area', (event) => {
  const workArea = screen.getPrimaryDisplay().workArea;
  event.reply('work-area-response', workArea);
});

ipcMain.on('constrain-window', (event, bounds) => {
  const workArea = screen.getPrimaryDisplay().workArea;
  const { width, height } = mainWindow.getBounds();

  let newX = bounds.x;
  let newY = bounds.y;

  // 화면 경계 체크 (스냅)
  if (newX < workArea.x) newX = workArea.x;
  if (newX + width > workArea.x + workArea.width) newX = workArea.x + workArea.width - width;
  if (newY < workArea.y) newY = workArea.y;
  if (newY + height > workArea.y + workArea.height) newY = workArea.y + workArea.height - height;

  mainWindow.setPosition(newX, newY);
});

ipcMain.on('get-state', (event) => {
  const state = Array.from(agentStates.entries()).map(([sessionId, data]) => ({
    sessionId,
    ...data
  }));
  event.reply('state-response', state);
});
