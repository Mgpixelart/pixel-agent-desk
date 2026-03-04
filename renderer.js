/**
 * Pixel Agent Desk Renderer - Multi-Agent Support
 * 멀티 에이전트 그리드 레이아웃 및 개별 상태 관리
 */

// --- DOM Elements ---
const agentGrid = document.getElementById('agent-grid');

// --- 스프라이트 시트 설정 ---
const SHEET = {
  cols: 9,
  width: 48,
  height: 64
};

// --- 애니메이션 시퀀스 ---
const ANIM_SEQUENCES = {
  working: { frames: [1, 2, 3, 4], fps: 8, loop: true },
  complete: { frames: [20, 21, 22, 23, 24, 25, 26, 27], fps: 6, loop: true },
  waiting: { frames: [32], fps: 1, loop: true },
  alert: { frames: [0, 31], fps: 4, loop: true }
};

// --- 상태별 맵핑 ---
const stateConfig = {
  'Working': { anim: 'working', class: 'state-working', label: 'Working...' },
  'Thinking': { anim: 'working', class: 'state-working', label: 'Working...' },
  'Done': { anim: 'complete', class: 'state-complete', label: 'Done!' },
  'Waiting': { anim: 'waiting', class: 'state-waiting', label: 'Waiting...' },
  'Error': { anim: 'alert', class: 'state-alert', label: 'Error!' },
  'Help': { anim: 'alert', class: 'state-alert', label: 'Help!' }
};

// --- 에이전트별 상태 관리 ---
const agentStates = new Map(); // agentId -> { animName, frameIdx, interval, startTime, timerInterval, lastFormattedTime }

// --- 유틸리티 함수 ---

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function drawFrame(element, frameIndex) {
  if (!element) return;
  const col = frameIndex % SHEET.cols;
  const row = Math.floor(frameIndex / SHEET.cols);
  const x = col * -SHEET.width;
  const y = row * -SHEET.height;
  element.style.backgroundPosition = `${x}px ${y}px`;
}

function playAnimation(agentId, element, animName) {
  const sequence = ANIM_SEQUENCES[animName];
  if (!sequence) return;

  const state = agentStates.get(agentId) || {};
  const prevAnim = state.animName;

  if (prevAnim === animName) return; // Already playing this animation

  // Clear previous interval
  if (state.interval) {
    clearInterval(state.interval);
  }

  // Update state
  state.animName = animName;
  state.frameIdx = 0;
  agentStates.set(agentId, state);

  // Draw first frame immediately
  drawFrame(element, sequence.frames[0]);

  // Start animation loop
  const interval = setInterval(() => {
    const currentState = agentStates.get(agentId);
    if (!currentState) {
      clearInterval(interval);
      return;
    }

    currentState.frameIdx++;

    if (currentState.frameIdx >= sequence.frames.length) {
      if (sequence.loop) {
        currentState.frameIdx = 0;
      } else {
        clearInterval(interval);
        return;
      }
    }

    drawFrame(element, sequence.frames[currentState.frameIdx]);
  }, 1000 / sequence.fps);

  // Store interval in state
  state.interval = interval;
  agentStates.set(agentId, state);
}

function updateAgentState(agentId, container, state) {
  const config = stateConfig[state] || stateConfig['Waiting'];
  const bubble = container.querySelector('.agent-bubble');
  const character = container.querySelector('.agent-character');

  // Update container class
  container.className = `agent-card ${config.class}`;

  // Play animation
  playAnimation(agentId, character, config.anim);

  // Get agent state
  let agentState = agentStates.get(agentId);
  if (!agentState) {
    agentState = {
      animName: null,
      frameIdx: 0,
      interval: null,
      startTime: null,
      timerInterval: null,
      lastFormattedTime: ''
    };
    agentStates.set(agentId, agentState);
  }

  // Timer logic
  if (config.anim === 'working') {
    if (!agentState.startTime) {
      agentState.startTime = Date.now();
      if (agentState.timerInterval) {
        clearInterval(agentState.timerInterval);
      }

      agentState.timerInterval = setInterval(() => {
        const elapsed = Date.now() - agentState.startTime;
        agentState.lastFormattedTime = formatTime(elapsed);
        if (bubble) {
          bubble.textContent = `${config.label} (${agentState.lastFormattedTime})`;
        }
      }, 1000);
    }

    // Immediate display
    const elapsed = Date.now() - agentState.startTime;
    agentState.lastFormattedTime = formatTime(elapsed);
    if (bubble) {
      bubble.textContent = `${config.label} (${agentState.lastFormattedTime})`;
    }

  } else if (config.anim === 'complete') {
    // Task complete - stop timer and keep final time
    if (agentState.timerInterval) {
      clearInterval(agentState.timerInterval);
      agentState.timerInterval = null;
    }
    if (bubble) {
      const finalTime = agentState.lastFormattedTime || '00:00';
      bubble.textContent = `${config.label} (${finalTime})`;
    }
    agentState.startTime = null;

  } else {
    // Other states - clear timer
    if (agentState.timerInterval) {
      clearInterval(agentState.timerInterval);
      agentState.timerInterval = null;
    }
    agentState.startTime = null;
    agentState.lastFormattedTime = '';
    if (bubble) {
      bubble.textContent = config.label;
    }
  }

  agentStates.set(agentId, agentState);
  console.log(`[Renderer] ${agentId.slice(0, 8)}: ${state} -> ${config.label}`);
}

// --- 에이전트 카드 생성/관리 ---

function createAgentCard(agent) {
  const card = document.createElement('div');
  card.className = 'agent-card';
  card.dataset.agentId = agent.id;

  // 서브에이전트 표시
  if (agent.isSubagent) {
    card.classList.add('is-subagent');
  }

  // Create bubble
  const bubble = document.createElement('div');
  bubble.className = 'agent-bubble';
  bubble.textContent = 'Waiting...';

  // Create character
  const character = document.createElement('div');
  character.className = 'agent-character';

  // dismissBtn 관련 코드 삭제됨

  // 카드 타입 구분 (배지 및 테두리)
  let typeLabel = 'Main';
  let typeClass = 'type-main';
  if (agent.isSubagent) {
    typeLabel = 'Sub';
    typeClass = 'type-sub';
  } else if (agent.isTeammate) {
    typeLabel = 'Team';
    typeClass = 'type-team';
  }
  card.classList.add(typeClass);

  // 상단 배지 (프로젝트명 + 타입)
  const header = document.createElement('div');
  header.className = 'agent-header';

  const projectTag = document.createElement('span');
  projectTag.className = 'project-tag';
  projectTag.textContent = agent.projectPath ? agent.projectPath.split(/[\\/]/).pop() : 'Default';
  projectTag.title = agent.projectPath || ''; // 긴 경로 네이티브 툴팁으로 표시

  const typeTag = document.createElement('span');
  typeTag.className = `type-tag ${typeClass}`;
  typeTag.textContent = typeLabel;

  header.appendChild(projectTag);
  header.appendChild(typeTag);
  card.appendChild(header);

  // Create agent name (직책/이름 표시)
  const nameBadge = document.createElement('div');
  nameBadge.className = 'agent-name';
  nameBadge.textContent = agent.displayName || typeLabel;
  nameBadge.title = agent.displayName; // 긴 이름일 경우 기본 툴팁

  // 만약 위 프로젝트 태그(폴더명)와 직책명(displayName)이 완전히 똑같거나 'Agent' 기본값이면 하단 배지를 숨김
  const projectNameStr = agent.projectPath ? agent.projectPath.split(/[\\/]/).pop() : 'Default';
  if (!agent.displayName || agent.displayName === projectNameStr || agent.displayName === 'Agent') {
    nameBadge.style.display = 'none';
  }

  // Assemble card
  card.appendChild(header);
  card.appendChild(bubble);
  card.appendChild(character);
  card.appendChild(nameBadge);

  // 캐릭터 영역에만 클릭 이벤트 (터미널 표출 및 상호작용) 할당
  character.style.cursor = 'pointer';

  // 찌르기(Poke) 상호작용 - 터미널 포커스 대신 재미있는 반응 추가
  const pokeMessages = [
    "앗, 깜짝이야!",
    "열심히 일하는 중입니다!",
    "코드 짜는 중... 💻",
    "커피가 필요해요 ☕",
    "이 부분 버그 아니죠?",
    "간지러워요!",
    "제 타수 엄청 빠르죠?",
    "칭찬해주세요! 🌟"
  ];

  let pokeTimeout = null;
  character.onclick = (e) => {
    e.stopPropagation(); // 카드 밖 영역 등 상위로 전파 방지

    // 1. 터미널 포커스 호출 (실제 PID 활용)
    if (window.electronAPI && window.electronAPI.focusTerminal) {
      window.electronAPI.focusTerminal(agent.id);
    }

    // 2. 찌르기 반응 (시각적 피드백)
    if (pokeTimeout) return;
    const originalText = bubble.textContent;
    const originalBorder = bubble.style.borderColor;

    const randomMsg = pokeMessages[Math.floor(Math.random() * pokeMessages.length)];
    bubble.textContent = randomMsg;
    bubble.style.borderColor = '#ff4081';

    pokeTimeout = setTimeout(() => {
      bubble.style.borderColor = '';
      pokeTimeout = null;
      bubble.textContent = originalText;
    }, 2000);
  };

  return card;
}

function addAgent(agent) {
  // Check if already exists
  if (document.querySelector(`[data-agent-id="${agent.id}"]`)) {
    return;
  }

  const card = createAgentCard(agent);
  agentGrid.appendChild(card);

  // 전역 데이터 캐시 업데이트 (정렬용)
  if (!window.lastAgents) window.lastAgents = [];
  if (!window.lastAgents.some(a => a.id === agent.id)) {
    window.lastAgents.push(agent);
  }

  // Set initial state
  updateAgentState(agent.id, card, agent.state || 'Waiting');

  // Update grid layout
  updateGridLayout();

  console.log(`[Renderer] Agent added: ${agent.displayName} (${agent.id.slice(0, 8)})`);
}

function updateAgent(agent) {
  const card = document.querySelector(`[data-agent-id="${agent.id}"]`);
  if (!card) return;

  updateAgentState(agent.id, card, agent.state || 'Waiting');
}

function removeAgent(data) {
  const card = document.querySelector(`[data-agent-id="${data.id}"]`);
  if (!card) return;

  // Clean up intervals
  const state = agentStates.get(data.id);
  if (state) {
    if (state.interval) clearInterval(state.interval);
    if (state.timerInterval) clearInterval(state.timerInterval);
    agentStates.delete(data.id);
  }

  card.remove();

  // Update grid layout
  updateGridLayout();

  console.log(`[Renderer] Agent removed: ${data.displayName} (${data.id.slice(0, 8)})`);
}

function cleanupAgents(data) {
  updateGridLayout();
  console.log(`[Renderer] Cleaned up ${data.count} agents`);
}

// --- 빈 상태(에이전트 0개) 대기 아바타 ---
const idleContainer = document.getElementById('container');
const idleCharacter = document.getElementById('character');
const idleBubble = document.getElementById('speech-bubble');
let idleAnimInterval = null;

function startIdleAnimation() {
  if (!idleCharacter) return;
  const seq = ANIM_SEQUENCES.waiting; // frame 32
  drawFrameOn(idleCharacter, seq.frames[0]);
  idleBubble.textContent = 'Waiting...';
}

function drawFrameOn(el, frameIndex) {
  if (!el) return;
  const col = frameIndex % SHEET.cols;
  const row = Math.floor(frameIndex / SHEET.cols);
  el.style.backgroundPosition = `${col * -SHEET.width}px ${row * -SHEET.height}px`;
}

function updateGridLayout() {
  const cards = Array.from(agentGrid.querySelectorAll('.agent-card'));
  if (cards.length === 0) {
    agentGrid.classList.remove('has-multiple');
    if (idleContainer) idleContainer.style.display = 'flex';
    return;
  }

  if (idleContainer) idleContainer.style.display = 'none';
  agentGrid.classList.add('has-multiple');

  // 같은 프로젝트끼리, 그 안에서 Main -> Sub -> Team 순으로 정렬
  cards.sort((a, b) => {
    const agentA = [...agentStates.keys()].find(id => id.startsWith(a.dataset.agentId)) || a.dataset.agentId; // 실제 ID 매칭
    const dataA = window.lastAgents?.find(ag => ag.id === a.dataset.agentId);
    const dataB = window.lastAgents?.find(ag => ag.id === b.dataset.agentId);

    if (!dataA || !dataB) return 0;

    // 1. 프로젝트명 정렬
    const projA = dataA.projectPath || '';
    const projB = dataB.projectPath || '';
    if (projA !== projB) return projA.localeCompare(projB);

    // 2. 타입 정렬 (Main < Sub < Team)
    const score = (d) => d.isSubagent ? 1 : (d.isTeammate ? 2 : 0);
    return score(dataA) - score(dataB);
  });

  // DOM 순서 재배치 및 그룹별 시각적 분리 (마진 추가)
  let lastProject = null;
  cards.forEach(card => {
    const data = window.lastAgents?.find(ag => ag.id === card.dataset.agentId);
    const currProject = data ? data.projectPath : null;

    if (lastProject !== null && currProject !== lastProject) {
      card.classList.add('group-start');
    } else {
      card.classList.remove('group-start');
    }
    lastProject = currProject;

    agentGrid.appendChild(card);
  });
}

// --- 이벤트 리스너 등록 ---

async function init() {
  if (!window.electronAPI) {
    console.error('[Renderer] electronAPI not available');
    return;
  }

  // 로드 전 즉시 대기 아바타 표시
  if (idleContainer) {
    idleContainer.style.display = 'flex';
    startIdleAnimation();
  }

  // Register event listeners
  window.electronAPI.onAgentAdded(addAgent);
  window.electronAPI.onAgentUpdated(updateAgent);
  window.electronAPI.onAgentRemoved(removeAgent);
  window.electronAPI.onAgentsCleaned(cleanupAgents);

  // Load existing agents
  try {
    const agents = await window.electronAPI.getAllAgents();
    window.lastAgents = [...agents]; // 정렬용 전역 보관
    console.log(`[Renderer] Loaded ${agents.length} existing agents`);
    for (const agent of agents) {
      addAgent(agent);
    }
    updateGridLayout();
  } catch (err) {
    console.error('[Renderer] Failed to load agents:', err);
  }

  // Signal renderer ready
  window.electronAPI.rendererReady();
  console.log('[Renderer] Initialized');
}

// --- Visibility handling ---

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Pause all animations when hidden
    for (const [agentId, state] of agentStates.entries()) {
      if (state.interval) {
        clearInterval(state.interval);
        state.interval = null;
      }
    }
  } else {
    // Resume animations when visible
    for (const [agentId, state] of agentStates.entries()) {
      if (state.animName) {
        const card = document.querySelector(`[data-agent-id="${agentId}"]`);
        const character = card?.querySelector('.agent-character');
        if (character) {
          const tempAnim = state.animName;
          state.animName = null; // Reset to force replay
          playAnimation(agentId, character, tempAnim);
        }
      }
    }
  }
});

// --- Start ---
init();
