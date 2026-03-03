const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_FILE = path.join(__dirname, 'hook_debug.log');
const PID_FILE = path.join(os.homedir(), '.claude', 'agent_pids.json');

const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] (START) RAW: ${raw.slice(0, 300)}\n`, 'utf-8');

    try {
        const data = JSON.parse(raw);
        const sessionId = data.session_id || data.sessionId;
        const cwd = data.cwd;

        // PID 트리 추적은 Windows에서 구조적으로 불안정하므로 제거
        // 대신 세션 정보(cwd)만 기록하고, main.js가 직접 시스템 프로세스를 스캔

        // 기존 PID 목록 읽기
        let pidsInfo = {};
        if (fs.existsSync(PID_FILE)) {
            try { pidsInfo = JSON.parse(fs.readFileSync(PID_FILE, 'utf-8')); } catch (e) { }
        }

        // 세션 정보 저장 (pid 대신 cwd 기반으로 매칭할 것)
        pidsInfo[sessionId] = {
            pid: 0,  // main.js가 직접 스캔하여 채움
            cwd: cwd,
            timestamp: new Date().toISOString()
        };

        // Atomic Write
        const tempFile = PID_FILE + '.tmp';
        fs.writeFileSync(tempFile, JSON.stringify(pidsInfo, null, 2), 'utf-8');
        fs.renameSync(tempFile, PID_FILE);
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] (START) Saved session ${sessionId} cwd=${cwd}\n`, 'utf-8');

        process.stderr.write(`[sessionstart_hook] OK — session ${sessionId}\n`);
    } catch (err) {
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] (START) ERROR: ${err.message}\n`, 'utf-8');
        process.stderr.write(`[sessionstart_hook] ERROR: ${err.message}\n`);
    }
    process.exit(0);
});
