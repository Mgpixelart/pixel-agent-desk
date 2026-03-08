/**
 * PiP Window Logic
 * SSE connection, agent sync, back-to-dashboard button
 * Drag/minimize/close handled by native titlebar overlay
 */

(function () {
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

  // ─── Back to Dashboard Button ───
  var backBtn = document.getElementById('pipBackBtn');
  if (backBtn) {
    backBtn.addEventListener('click', function () {
      if (window.pipAPI && window.pipAPI.backToDashboard) {
        window.pipAPI.backToDashboard();
      } else {
        window.close();
      }
    });
  }

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
