(() => {
  'use strict';

  const hook = document.querySelector('#control-room-hook');
  if (!hook) return;

  const css = document.createElement('style');
  css.textContent = `
    .control-room { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin:0 0 16px; }
    .control-room-card { min-width:0; padding:18px; background:linear-gradient(145deg,#16213aee,#10182bee); border:1px solid #263556; border-radius:18px; box-shadow:0 14px 40px #0003; }
    .control-room-card.mind { border-color:#5e4d9a; }
    .control-room-card.hands { border-color:#246878; }
    .control-room-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
    .control-room-name { font-size:1rem; font-weight:700; }
    .control-room-role { color:#91a0bd; font-size:.73rem; margin-top:3px; }
    .control-room-state { color:#68d8ff; font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; white-space:nowrap; }
    .control-room-current { min-height:38px; margin:12px 0; padding:10px 12px; border:1px solid #263556; border-radius:10px; background:#0c1426aa; font-size:.82rem; }
    .control-room-events { display:grid; gap:6px; }
    .control-room-event { display:grid; grid-template-columns:64px 1fr; gap:8px; padding:8px 0; border-top:1px solid #21304d; font-size:.76rem; }
    .control-room-event time { color:#91a0bd; font: .7rem ui-monospace,monospace; }
    .control-room-event span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .control-room-footer { display:flex; justify-content:space-between; gap:8px; margin-top:12px; color:#91a0bd; font-size:.72rem; }
    .control-room-healthy { color:#75e6a1; }
    .control-room-waiting { color:#ffd166; }
    .control-room-stale { color:#ff7d8d; }
    .control-room-empty { color:#91a0bd; font-size:.76rem; }
    [data-control][aria-busy="true"] { cursor:wait; }
    @media (max-width:900px) { .control-room { grid-template-columns:1fr; } }
  `;

  const root = document.createElement('section');
  root.className = 'control-room';
  root.setAttribute('aria-label', 'Live MIND and HANDS control room');

  const state = { snapshot: null, lastSignalAt: 0, busy: false, source: null };

  function text(value, fallback = '-') {
    return value === undefined || value === null || value === '' ? fallback : String(value);
  }

  function safeDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString();
  }

  function roleOf(event) {
    const agent = String(event && (event.agent || event.active_agent) || '').toLowerCase();
    if (agent === 'mind' || agent.includes('brain')) return 'mind';
    if (agent.startsWith('hands')) return 'hands';
    return 'system';
  }

  function entries(snapshot) {
    const events = (snapshot.events || []).map(event => ({ ...event, role: roleOf(event), summary: event.summary || event.type || 'Lifecycle event' }));
    const actions = (snapshot.actions || []).map(action => ({ ...action, role: roleOf(action), summary: action.summary || action.kind || 'Action' }));
    return [...events, ...actions].sort((a, b) => String(a.at).localeCompare(String(b.at)) || Number(a.seq || 0) - Number(b.seq || 0));
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
    const identity = element('div');
    identity.append(element('div', 'control-room-name', name), element('div', 'control-room-role', description));
    const status = element('div', 'control-room-state', 'IDLE');
    status.dataset.roleState = role;
    head.append(identity, status);
    const current = element('div', 'control-room-current', 'Waiting for activity.');
    current.dataset.roleCurrent = role;
    const activity = element('div', 'control-room-events');
    activity.dataset.roleEvents = role;
    const footer = element('div', 'control-room-footer');
    footer.append(element('span', 'control-room-waiting', 'Summarized live view'), element('span', 'control-room-connection', 'Connecting...'));
    card.append(head, current, activity, footer);
    return card;
  }

  root.append(createCard('mind', 'MIND · Codex', 'Planning, approval, and verification'));
  root.append(createCard('hands', 'HANDS · OpenCode', 'Proposal, execution, and tool activity'));
  hook.replaceWith(root);
  document.head.append(css);

  function waitingText(role, current) {
    if (['done', 'cancelled'].includes(current.phase)) return 'Session ' + current.phase + '.';
    if (roleOf({ agent: current.active_agent }) === role) return text(current.activity && current.activity.action || current.last_summary, 'Active');
    return role === 'mind' ? 'Idle · waiting for the current HANDS result.' : 'Idle · waiting for the next approved chunk.';
  }

  function renderRole(role) {
    const current = state.snapshot && state.snapshot.state || {};
    const roleEntries = entries(state.snapshot || {}).filter(event => event.role === role).slice(-4);
    const active = roleOf({ agent: current.active_agent }) === role;
    const status = root.querySelector('[data-role-state="' + role + '"]');
    const currentNode = root.querySelector('[data-role-current="' + role + '"]');
    const target = root.querySelector('[data-role-events="' + role + '"]');
    status.textContent = active ? text(current.phase, 'ACTIVE') : 'IDLE';
    currentNode.textContent = waitingText(role, current);
    target.replaceChildren();
    if (!roleEntries.length) {
      target.append(element('p', 'control-room-empty', 'No ' + (role === 'mind' ? 'MIND' : 'HANDS') + ' activity yet.'));
      return;
    }
    for (const item of roleEntries) {
      const row = element('div', 'control-room-event');
      row.append(element('time', '', safeDate(item.at)), element('span', '', item.summary));
      target.append(row);
    }
  }

  function render(snapshot) {
    state.snapshot = snapshot || { state: {}, events: [], actions: [] };
    renderRole('mind');
    renderRole('hands');
    renderConnection();
  }

  function renderConnection() {
    const age = state.lastSignalAt ? Math.max(0, Math.round((Date.now() - state.lastSignalAt) / 1000)) : null;
    const label = age === null ? 'Connecting...' : age < 30 ? 'Live · ' + age + 's ago' : 'Stale · ' + age + 's ago';
    root.querySelectorAll('.control-room-connection').forEach(node => {
      node.textContent = label;
      node.className = 'control-room-connection ' + (age === null ? 'control-room-waiting' : age < 30 ? 'control-room-healthy' : 'control-room-stale');
    });
  }

  function phaseControls(phase) {
    return {
      idle: ['stop'],
      planning: ['pause', 'stop'],
      hands_proposing: ['pause', 'stop'],
      brain_approving: ['approve', 'revise', 'pause', 'stop'],
      brain_reviewing: ['done', 'pause', 'stop'],
      hands_executing: ['recover'],
      paused: ['resume', 'stop'],
      blocked_user: ['resume', 'stop']
    }[phase] || [];
  }

  function setBusy(value) {
    state.busy = value;
    document.querySelectorAll('[data-control]').forEach(button => {
      button.setAttribute('aria-busy', value ? 'true' : 'false');
      if (value) button.disabled = true;
    });
  }

  function refreshControls() {
    const allowed = phaseControls(state.snapshot && state.snapshot.state && state.snapshot.state.phase);
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
      const label = event.detail === 'offline' ? 'Offline' : 'Reconnecting...';
      root.querySelectorAll('.control-room-connection').forEach(node => {
        node.textContent = label;
        node.className = 'control-room-connection control-room-stale';
      });
    });
    if (window.__bridgeSnapshot) receiveSnapshot(window.__bridgeSnapshot);
    else root.querySelectorAll('.control-room-connection').forEach(node => { node.textContent = 'Waiting for bridge snapshot'; });
  }

  window.setInterval(renderConnection, 1000);
  void connect();
})();
