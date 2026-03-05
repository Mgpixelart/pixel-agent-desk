# Pixel Agent Desk - 분석 요약 및 실행 계획

**작성일:** 2026-03-05
**버전:** 1.0.0
**상태:** 전문가 팀 7개 분석 완료

---

## 📊 분석 개요

총 7개 전문가 팀이 다음 영역을 심층 분석:

1. **시스템 아키텍처** - 데이터 구조 및 파이프라인
2. **훅 파싱** - JSON 처리 및 검증
3. **아바타 생명주기** - 생성부터 소멸까지
4. **SQLite vs JSON** - 저장 방식 평가
5. **Mission Control 구조** - 참고 프로젝트 분석
6. **Claude Hooks 심층** - 실제 훅 JSON 분석
7. **통합 로드맵** - 실행 계획 수립

---

## 🔴 핵심 발견사항

### 1. 실제 Claude 훅 JSON 구조 (hooks.jsonl 491개 이벤트 분석)

**공통 필드 (모든 훅):**
```json
{
  "session_id": "d695078f-c743-40ef-b230-bedecbd69fd4",
  "transcript_path": "C:\\Users\\...\\session.jsonl",      // 🔴 우리는 null 사용
  "cwd": "E:\\projects\\pixel-agent-desk-master",          // ✅ projectPath로 사용
  "permission_mode": "bypassPermissions",                   // ❌ 안 씀
  "hook_event_name": "PreToolUse",
  "_pid": 12345,                                           // ✅ 우리가 추가
  "_timestamp": 1772708821312                              // ✅ 우리가 추가
}
```

**PreToolUse/PostToolUse 추가 필드:**
```json
{
  "tool_name": "Read",                                     // ⚠️ 우리는 "tool"로 검증
  "tool_input": { "file_path": "..." },
  "tool_use_id": "call_ca45a525689544c99af3a1e5",          // ❌ 안 씀
  "tool_response": {                                       // PostToolUse만
    "type": "text",
    "file": {
      "filePath": "...",
      "content": "...",
      "numLines": 235
    },
    "token_usage": {                                       // ❌ 안 씀
      "input_tokens": 1234,
      "output_tokens": 5678
    }
  }
}
```

### 2. 우리 코드의 문제점

**main.js:handleSessionStart()**
```javascript
// 현재 코드
agentManager.updateAgent({
  sessionId,
  projectPath: cwd,
  jsonlPath: null,              // ❌ transcript_path를 안 씀
  // permission_mode 누락        // ❌
})
```

**main.js:startHookServer() - Ajv 스키마**
```javascript
const hookSchema = {
  type: 'object',
  required: ['hook_event_name'],
  properties: {
    hook_event_name: { type: 'string' },
    state: { type: 'string' },           // ❌ 실제로 없음
    tool: { type: 'string' },            // ❌ tool_name이 맞음
    // transcript_path 없음              // ❌ 항상 있음
    // permission_mode 없음             // ❌ 항상 있음
  },
  additionalProperties: true             // ❌ 너무 관대함
}
```

**이중 sessionId 필드 문제:**
```javascript
// main.js:handleSessionStart()
const sessionId = data.session_id || data.sessionId;
// ⚠️ 두 필드가 다를 때 결정적 동작 보장 안 됨
```

### 3. 실제 훅 사용량 (hooks.jsonl)

| 훅 이벤트 | 빈도 | 비율 | 우리 사용 |
|----------|------|------|-----------|
| PreToolUse | 225회 | 45.8% | ✅ |
| PostToolUse | 204회 | 41.6% | ✅ |
| UserPromptSubmit | 11회 | 2.2% | ❌ |
| TaskCompleted | 1회 | 0.2% | ✅ |
| SessionStart | 1회 | 0.2% | ✅ |
| SessionEnd | 0회 | 0% | ✅ (이벤트는 있음) |
| PermissionRequest | 0회 | 0% | ❌ |
| Notification | 1회 | 0.2% | ❌ |

### 4. mission-control-main에서 배울 점

**참고용 프로젝트 (Next.js, 완전히 별개):**

| 기능 | 설명 | 우리 적용 가능성 |
|------|------|------------------|
| 세션 JSONL 스캐너 | Claude 세션 로그 자동 스캔 | ✅ transcript_path 활용 |
| 토큰 추적 | tool_response.token_usage | ✅ 비용 추적 기능 |
| Agent Attribution | 에이전트별 작업 기록 | ✅ 작업 이력 기능 |
| SSE | 실시간 업데이트 | ✅ WebSocket → SSE 전환 고려 |

---

## 🎯 수정 우선순위

### P0 - 긴급 (이번 주)

**1. transcript_path 활용** (2시간)
```javascript
// main.js:853
agentManager.updateAgent({
  sessionId: data.session_id,
  projectPath: data.cwd,
  jsonlPath: data.transcript_path,  // null → 실제 경로
  permissionMode: data.permission_mode
}, 'http');
```

**2. 이중 sessionId 필드 통일** (4시간)
- 전체 코드베이스에서 `session_id` vs `sessionId` 검색
- 하나로 통일 (권장: `session_id` → Claude 표준 따르기)
- 충돌 감지 로직 추가

**3. JSON 파싱 에러 로깅** (2시간)
```javascript
// hook.js:16
try {
  const data = JSON.parse(Buffer.concat(chunks).toString());
} catch (e) {
  // 현재: 조용히 종료 (process.exit(0))
  // 수정: 로그 추가
  fs.appendFileSync('hook-errors.log', `${Date.now()} ${e.message}\n`);
  process.exit(0);
}
```

**4. Ajv 스키마 수정** (3시간)
```javascript
// main.js:495
const hookSchema = {
  type: 'object',
  required: ['hook_event_name', 'session_id', 'cwd', 'transcript_path'],
  properties: {
    hook_event_name: { type: 'string', enum: [...] },
    session_id: { type: 'string', format: 'uuid' },
    cwd: { type: 'string' },
    transcript_path: { type: 'string' },
    permission_mode: { type: 'string', enum: ['default', 'bypassPermissions', ...] },
    tool_name: { type: 'string' },  // 'tool'에서 수정
    tool_input: { type: 'object' },
    tool_use_id: { type: 'string' },
    tool_response: { type: 'object' }
  },
  additionalProperties: false  // true에서 수정
}
```

### P1 - 중요 (다음 주)

**5. JSONL 세션 로그 분석** (8시간)
```javascript
// mission-control-main 방식 참고
async function analyzeSession(jsonlPath) {
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.tool_response?.token_usage) {
      // 토큰 사용량 추적
      totalTokens += event.tool_response.token_usage.input_tokens;
      totalTokens += event.tool_response.token_usage.output_tokens;
    }
  }
}
```
- transcript_path로 JSONL 파일 읽기
- 토큰 사용량 추출
- 에이전트별 비용 추적

**6. token_usage 추적** (6시간)
- PostToolUse 훅에서 token_usage 추출
- 에이전트별 토큰 사용량 집계
- 비용 추적 기능 구현

**7. UserPromptSubmit 훅 도입** (4시간)
- 프롬프트 유효성 검사
- 악성 프롬프트 차단
- 프롬프트 품질 메트릭

### P2 - 개선 (2주 이내)

**8. SSE 전환** (10시간)
- 수동 WebSocket → SSE
- 더 단순하고 효율적인 실시간 업데이트

**9. 세션 로그 분석** (12시간)
- transcript_path로 세션 JSONL 읽기
- 작업 타임라인 시각화
- 대화 패턴 분석

---

## 📋 실행 계획

### Week 1: P0 수정 (11시간)

| 작업 | 시간 | 담당 | 상태 |
|------|------|------|------|
| transcript_path 활용 | 2h | backend | 예정 |
| sessionId 통일 | 4h | backend | 예정 |
| JSON 에러 로깅 | 2h | backend | 예정 |
| Ajv 스키마 수정 | 3h | backend | 예정 |

### Week 2-3: P1 기능 (18시간)

| 작업 | 시간 | 담당 | 참고 | 상태 |
|------|------|------|------|------|
| JSONL 세션 로그 분석 | 8h | backend | mission-control-main scanner | 예정 |
| token_usage 추적 | 6h | backend | tool_response.token_usage | 예정 |
| UserPromptSubmit 도입 | 4h | backend | - | 예정 |

### Week 4-5: P2 개선 (22시간)

| 작업 | 시간 | 담당 | 상태 |
|------|------|------|------|
| SSE 전환 | 10h | backend | 예정 |
| 세션 로그 분석 | 12h | frontend | 예정 |

---

## 📁 생성된 문서

1. **architecture_analysis.md** (21KB) - 시스템 아키텍처 분석
2. **hook_parsing_analysis.md** - 훅 파싱 5곳 분석
3. **avatar_lifecycle_analysis.md** - 아바타 생명주기 전 과정
4. **sqlite_vs_json_evaluation.md** - SQLite 도입 ❌ 권장
5. **mission_control_architecture_analysis.md** (46KB) - 참고 프로젝트 분석
   - **JSONL 스캐너 방식 발견** (claude-sessions.ts 308줄)
   - transcript_path 활용 방법
   - token_usage 추출 방법
6. **claude_hooks_deep_dive.md** (32KB) - 실제 훅 JSON 491개 분석
7. **integration_roadmap.md** (37KB) - 통합 실행 계획

---

## 🎯 다음 단계

1. **PRD 업데이트** - Phase 3 수정사항 반영
2. **팀 리뷰** - 실행 계획 승인
3. **P0 수정 착수** - Week 1 작업 시작

---

**작성자:** 전문가 팀 7개 (총 400,000+ 토큰 사용)
**검토자:** 프로젝트 리드
**승인자:** (대기)
