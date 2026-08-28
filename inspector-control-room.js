(() => {
  'use strict';

  const hook = document.querySelector('#control-room-hook');
  if (!hook) return;

  const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  const css = document.createElement('style');
  css.textContent = `
    .control-room { display:grid; grid-template-columns:1fr; gap:.75rem; margin:0; font-family:system-ui, -apple-system, "Segoe UI", sans-serif; }
    .control-room-card { min-width:0; padding:.6rem .7rem; background:var(--panel); border:1px solid var(--line); border-left:2px solid var(--line); border-radius:10px; box-shadow:0 1px 2px rgba(35,38,46,.05); animation:control-room-enter .2s ease-out both; }
    .control-room-card.mind { border-left-color:var(--mind); }
    .control-room-card.hands { border-left-color:var(--hands); }
    .control-room-head { display:flex; justify-content:space-between; align-items:center; gap:.5rem; }
    .control-room-eyebrow { font-family:${mono}; font-size:.625rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
    .control-room-card.mind .control-room-eyebrow { color:var(--mind); }
    .control-room-card.hands .control-room-eyebrow { color:var(--hands); }
    .control-room-chip { font-family:${mono}; font-size:.625rem; font-weight:600; letter-spacing:.08em; text-transform:uppercase; padding:.125rem .4rem; border:1px solid var(--line); border-radius:999px; color:var(--ink-2); white-space:nowrap; }
    .control-room-chip.active { color:var(--ink); border-color:var(--ink); }
    .control-room-chip.blocked { color:var(--alarm); border-color:var(--alarm); }
    .control-room-role { margin:.2rem 0 0; font-size:.75rem; color:var(--ink-2); }
    .control-room-current { margin:.35rem 0 0; font-size:.8125rem; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .control-room-footer { margin-top:.5rem; }
    .control-room-connection { font-family:${mono}; font-size:.625rem; color:var(--ink-2); }
    .control-room-connection.healthy { color:var(--vitals); }
    .control-room-connection.stale { color:var(--warn); }
    [data-control][aria-busy="true"] { cursor:wait; }
    @keyframes control-room-enter { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
    @media (prefers-reduced-motion: reduce) { .control-room-card { animation:none; } }
  `;

  const root = document.createElement('section');
  root.className = 'control-room';
  root.setAttribute('aria-label', 'Live MIND and HANDS control room');

  const state = { snapshot: null, lastSignalAt: 0, busy: false };

  function text(value, fallback = '-') {
    return value === undefined || value === null || value === '' ? fallback : String(value);
  }

  function roleOf(source) {
    const agent = String(source && (source.agent || source.active_agent) || '').toLowerCase();
    if (agent === 'mind' || agent.includes('brain')) return 'mind';
    if (agent.startsWith('hands')) return 'hands';
    return 'system';
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = text(value);
    return node;
  }

  function createCard(role, name, description) {
    const card = element('article', 'control-room-card ' + role);
    const head = element('div', 'control-room-head');
    const chip = element('span', 'control-room-chip', 'IDLE');
    chip.dataset.roleState = role;
    head.append(element('div', 'control-room-eyebrow', name), chip);
    const current = element('p', 'control-room-current', 'Waiting for activity.');
    current.dataset.roleCurrent = role;
    const footer = element('footer', 'control-room-footer');
    footer.append(element('span', 'control-room-connection', 'Connecting…'));
    card.append(head, element('p', 'control-room-role', description), current, footer);
    return card;
  }

  root.append(createCard('mind', 'MIND · Codex', 'Planning, approval, and verification'));
  root.append(createCard('hands', 'HANDS · OpenCode', 'Proposal, execution, and tool activity'));
  hook.replaceWith(root);
  document.head.append(css);

  function currentText(role, current, snapshot) {
    if (['done', 'cancelled'].includes(current.phase)) return 'Session ' + current.phase + '.';
    if (current.phase === 'blocked_user') {
      const reason = current.block_reason || (snapshot && snapshot.error);
      if (reason) return 'Blocked: ' + reason;
    }
    if (roleOf({ agent: current.active_agent }) === role) return text(current.activity && current.activity.action || current.last_summary, 'Active');
    return role === 'mind' ? 'Idle · waiting for the current HANDS result.' : 'Idle · waiting for the next approved chunk.';
  }

  function renderRole(role) {
    const current = state.snapshot && state.snapshot.state || {};
    const active = roleOf({ agent: current.active_agent }) === role;
    const isBlocked = current.phase === 'blocked_user' && active;
    const chip = root.querySelector('[data-role-state="' + role + '"]');
    const currentNode = root.querySelector('[data-role-current="' + role + '"]');
    chip.textContent = active ? (isBlocked ? 'BLOCKED' : text(current.phase, 'ACTIVE')) : 'IDLE';
    chip.className = 'control-room-chip' + (isBlocked ? ' blocked' : active ? ' active' : '');
    const line = currentText(role, current, state.snapshot);
    currentNode.textContent = line;
    currentNode.title = line;
  }

  function render(snapshot) {
    state.snapshot = snapshot || { state: {}, controls: [] };
    renderRole('mind');
    renderRole('hands');
    renderConnection();
  }

  function renderConnection() {
    const age = state.lastSignalAt ? Math.max(0, Math.round((Date.now() - state.lastSignalAt) / 1000)) : null;
    const label = age === null ? 'Connecting…' : age < 30 ? 'Live · ' + age + 's ago' : 'Stale · ' + age + 's ago';
    const tone = age === null ? '' : age < 30 ? 'healthy' : 'stale';
    root.querySelectorAll('.control-room-connection').forEach(node => {
      node.textContent = label;
      node.className = 'control-room-connection ' + tone;
    });
  }

  function setBusy(value) {
    state.busy = value;
    document.querySelectorAll('[data-control]').forEach(button => {
      button.setAttribute('aria-busy', value ? 'true' : 'false');
      if (value) button.disabled = true;
    });
  }

  function allowedControls() {
    const snapshot = window.__bridgeSnapshot || state.snapshot;
    return Array.isArray(snapshot && snapshot.controls) ? snapshot.controls : [];
  }

  function refreshControls() {
    const allowed = allowedControls();
    document.querySelectorAll('[data-control]').forEach(button => {
      button.disabled = state.busy || !allowed.includes(button.dataset.control);
    });
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const request = args[0];
    const url = typeof request === 'string' ? request : request && request.url;
    const init = args[1] || {};
    const method = String(init.method || (request && request.method) || 'GET').toUpperCase();
    if (!String(url || '').endsWith('/api/control') || method !== 'POST') return originalFetch(...args);
    setBusy(true);
    try {
      return await originalFetch(...args);
    } finally {
      setBusy(false);
      refreshControls();
    }
  };

  document.addEventListener('click', event => {
    const button = event.target && event.target.closest ? event.target.closest('[data-control]') : null;
    if (!button || !state.busy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  function receiveSnapshot(snapshot) {
    if (!snapshot) return;
    state.lastSignalAt = Date.now();
    render(snapshot);
    refreshControls();
  }

  function connect() {
    window.addEventListener('bridge-snapshot', event => receiveSnapshot(event.detail));
    window.addEventListener('bridge-ping', () => {
      state.lastSignalAt = Date.now();
      renderConnection();
    });
    window.addEventListener('bridge-connection', event => {
      const label = event.detail === 'offline' ? 'Offline' : 'Reconnecting…';
      root.querySelectorAll('.control-room-connection').forEach(node => {
        node.textContent = label;
        node.className = 'control-room-connection stale';
      });
    });
    if (window.__bridgeSnapshot) receiveSnapshot(window.__bridgeSnapshot);
  }

  window.setInterval(renderConnection, 1000);
  connect();
})();
