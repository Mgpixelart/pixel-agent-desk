/**
 * PiP Window Logic
 * JS-based drag (bypasses -webkit-app-region bugs on Windows),
 * SSE connection, agent sync, window controls
 */

(function () {
  const api = window.pipAPI;

  // ─── JS-based Window Drag ───
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;

  document.addEventListener('mousedown', (e) => {
    // Don't start drag on control buttons
    if (e.target.closest('.pip-controls')) return;
    dragging = true;
    dragStartX = e.screenX;
    dragStartY = e.screenY;
    document.body.classList.add('dragging');
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - dragStartX;
    const dy = e.screenY - dragStartY;
    dragStartX = e.screenX;
    dragStartY = e.screenY;
    if (api && api.dragWindow) api.dragWindow(dx, dy);
  });

  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.classList.remove('dragging');
  });

  // ─── SSE Connection ───
  let sseSource = null;
  let sseDelay = 1000;

  function connectSSE() {
    if (sseSource) { sseSource.close(); sseSource = null; }
    const es = new EventSource('/api/events');
    sseSource = es;

    es.onopen = () => { sseDelay = 1000; };

    es.onerror = () => {
      es.close();
      sseSource = null;
      setTimeout(connectSSE, sseDelay);
      sseDelay = Math.min(sseDelay * 2, 30000);
    };

    es.addEventListener('connected', () => fetchAgents());
    es.addEventListener('agent.created', (e) => {
      const d = JSON.parse(e.data).data;
      if (typeof officeOnAgentCreated === 'function') officeOnAgentCreated(d);
    });
    es.addEventListener('agent.updated', (e) => {
      const d = JSON.parse(e.data).data;
      if (typeof officeOnAgentUpdated === 'function') officeOnAgentUpdated(d);
    });
    es.addEventListener('agent.removed', (e) => {
      const d = JSON.parse(e.data).data;
      if (typeof officeOnAgentRemoved === 'function') officeOnAgentRemoved(d);
    });
  }

  async function fetchAgents() {
    try {
      const res = await fetch('/api/agents');
      const agents = await res.json();
      agents.forEach((a) => {
        if (typeof officeOnAgentCreated === 'function') officeOnAgentCreated(a);
      });
    } catch (e) {
      console.error('[PiP] Failed to fetch agents:', e);
    }
  }

  // ─── Window Controls ───
  document.getElementById('pipMinBtn').addEventListener('click', () => {
    if (api && api.minimize) api.minimize();
  });

  document.getElementById('pipExpandBtn').addEventListener('click', () => {
    if (api && api.backToDashboard) api.backToDashboard();
  });

  document.getElementById('pipCloseBtn').addEventListener('click', () => {
    if (api && api.close) api.close();
  });

  // ─── Boot ───
  async function boot() {
    if (typeof initOffice === 'function') {
      await initOffice();
    }
    connectSSE();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
