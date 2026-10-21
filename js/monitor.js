/**
 * js/monitor.js - APOZL Presenter Operations
 */
import { supabase, RelayDB } from './database.js';

let teams = [];
let sessions = {};

async function init() {
  await fetchAll();

  RelayDB.subscribeToAll(
    (payload) => handleSessionUpdate(payload),
    (payload) => handleTeamUpdate(payload),
    (broadcast) => {
      if (broadcast.alarm_sound) playSiren();
    }
  );

  setupModals();
  setupGlobalControls();
  setInterval(renderClocks, 1000);
}

async function fetchAll() {
  const { data: t } = await supabase.from('teams').select('*');
  const { data: s } = await supabase.from('sessions').select('*');
  teams = t || [];
  sessions = (s || []).reduce((acc, row) => ({ ...acc, [row.team_id]: row }), {});
  renderCards();
  renderLeaderboard();
}

function handleSessionUpdate(payload) {
  if (payload.new) {
    sessions[payload.new.team_id] = payload.new;
    renderCards();
    renderLeaderboard();
  }
}

function handleTeamUpdate(payload) {
  const idx = teams.findIndex(t => t.id === payload.new.id);
  if (idx !== -1) teams[idx] = payload.new;
  renderCards();
  renderLeaderboard();
}

function renderCards() {
  const grid = document.getElementById('teams-grid');
  grid.innerHTML = teams.map(team => {
    const s = sessions[team.id] || { status: 'waiting', duration: 900, violation_count: 0 };
    const memberName = Array.isArray(team.members) ? (team.members[team.current_member_index] || 'Finished') : 'Member 1';
    const remaining = RelayDB.computeRemainingTime(s);
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');

    return `
      <div class="team-card status-${s.status}">
        <div class="team-card-header">
          <strong>${team.name}</strong>
          <span class="badge ${s.status}">${s.status.toUpperCase()}</span>
        </div>
        <div class="timer-box" id="timer-${team.id}">${mm}:${ss}</div>
        <div class="team-stats">
          <span>Relay: <b>${memberName}</b></span>
          <span>Violations: <b style="color: ${s.violation_count > 0 ? '#ef4444' : '#10b981'}">${s.violation_count}/3</b></span>
        </div>
        <div class="team-actions">
          ${s.status === 'active' ? `<button class="btn btn-amber btn-sm" onclick="pauseTeam('${team.id}')">Pause</button>` : ''}
          ${s.status === 'paused' || s.status === 'waiting' ? `<button class="btn btn-emerald btn-sm" onclick="startTeam('${team.id}')">Start</button>` : ''}
          <button class="btn btn-sm" onclick="addTime('${team.id}', 120)">+2m</button>
          <button class="btn btn-sm" onclick="toggleScreenBlock('${team.id}', ${!team.is_blocked})">${team.is_blocked ? 'Unblock' : 'Blackout'}</button>
          <button class="btn btn-sm" onclick="inspectTeamCode('${team.id}')">View Code</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderClocks() {
  teams.forEach(t => {
    const s = sessions[t.id];
    if (s && s.status === 'active') {
      const remaining = RelayDB.computeRemainingTime(s);
      const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
      const ss = String(remaining % 60).padStart(2, '0');
      const el = document.getElementById(`timer-${t.id}`);
      if (el) el.innerText = `${mm}:${ss}`;
    }
  });
}

function renderLeaderboard() {
  const tbody = document.querySelector('#leaderboard-table tbody');
  tbody.innerHTML = teams.map(t => {
    const s = sessions[t.id];
    return `
      <tr>
        <td><strong>${t.name}</strong></td>
        <td>Leg ${(t.current_member_index || 0) + 1}</td>
        <td><span class="badge ${s?.status || 'waiting'}">${s?.status || 'waiting'}</span></td>
      </tr>
    `;
  }).join('');
}

function setupGlobalControls() {
  document.getElementById('btn-start-all').onclick = () => teams.forEach(t => RelayDB.startSession(t.id));
  document.getElementById('btn-pause-all').onclick = () => teams.forEach(t => RelayDB.pauseSession(t.id));
  
  document.getElementById('btn-alarm-all').onclick = async () => {
    playSiren();
    await supabase.from('broadcasts').insert({ message: '⚠️ TIME ALERT', alarm_sound: true });
  };

  document.getElementById('btn-broadcast').onclick = async () => {
    const msg = prompt('Enter message to broadcast to all teams:');
    if (msg) await supabase.from('broadcasts').insert({ message: msg, alarm_sound: false });
  };
}

function setupModals() {
  const teamModal = document.getElementById('add-team-modal');
  document.getElementById('btn-add-team-modal').onclick = () => teamModal.classList.remove('hidden');
  document.getElementById('modal-team-close').onclick = () => teamModal.classList.add('hidden');

  document.getElementById('btn-create-team-confirm').onclick = async () => {
    const name = document.getElementById('new-team-name').value.trim();
    const username = document.getElementById('new-team-user').value.trim();
    const membersRaw = document.getElementById('new-team-members').value;
    const members = membersRaw.split(',').map(m => m.trim()).filter(Boolean);

    if (!name || !username) {
      alert('Please fill out team name and username.');
      return;
    }

    // 1. Insert Team
    const { data: team, error } = await supabase.from('teams').insert({
      name,
      username,
      members: members.length ? members : ['Member 1', 'Member 2', 'Member 3']
    }).select().single();

    if (error) {
      alert('Error creating team: ' + error.message);
      return;
    }

    // 2. Insert Session
    const { data: problem } = await supabase.from('problems').select('id').limit(1).single();
    await supabase.from('sessions').insert({
      team_id: team.id,
      problem_id: problem ? problem.id : null,
      duration: 900
    });

    teamModal.classList.add('hidden');
    document.getElementById('new-team-name').value = '';
    document.getElementById('new-team-user').value = '';
    document.getElementById('new-team-members').value = '';
    await fetchAll();
  };

  document.getElementById('inspector-close').onclick = () => {
    document.getElementById('inspector-modal').classList.add('hidden');
  };
}

window.startTeam = (id) => RelayDB.startSession(id);
window.pauseTeam = (id) => RelayDB.pauseSession(id);
window.addTime = async (id, seconds) => {
  const s = sessions[id];
  if (s) {
    await supabase.from('sessions').update({ duration: s.duration + seconds }).eq('team_id', id);
  }
};
window.toggleScreenBlock = async (id, status) => {
  await supabase.from('teams').update({ is_blocked: status }).eq('id', id);
};
window.inspectTeamCode = (id) => {
  const s = sessions[id];
  const t = teams.find(team => team.id === id);
  document.getElementById('inspector-team-title').innerText = `Live Inspection: ${t?.name}`;
  document.getElementById('inspector-code').innerText = s?.current_code || '# No code recorded yet';
  document.getElementById('inspector-modal').classList.remove('hidden');
};

function playSiren() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(800, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.5);
  osc.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.6);
}

init();
