/**
 * js/player.js - APOZL Arena Workspace
 */
import { supabase, RelayDB } from './database.js';

let currentTeam = null;
let currentSession = null;
let pyodideWorker = null;
let autosaveTimer = null;
let graceCountdown = null;
let graceSeconds = 10;
let isEnforcingFullscreen = false;

async function init() {
  await populateTeamSelector();

  // Load Problem
  const { data: prob } = await supabase.from('problems').select('*').limit(1).single();
  if (prob) {
    document.getElementById('problem-title').innerText = prob.title;
    document.getElementById('problem-desc').innerText = prob.description;
    document.getElementById('sample-input').innerText = prob.sample_input;
    document.getElementById('sample-output').innerText = prob.sample_output;
  }

  setupWorker();
  setupFullscreenTrigger();
  setInterval(syncTimer, 1000);
}

async function populateTeamSelector() {
  const { data: teams } = await supabase.from('teams').select('id, name');
  const selector = document.getElementById('team-selector');
  if (teams) {
    selector.innerHTML = '<option value="">-- Choose your team --</option>' +
      teams.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  }
}

// Fullscreen API with standard, webkit, and moz fallbacks
async function requestBrowserFullscreen() {
  const elem = document.documentElement;
  if (elem.requestFullscreen) {
    return await elem.requestFullscreen();
  } else if (elem.webkitRequestFullscreen) {
    return await elem.webkitRequestFullscreen();
  } else if (elem.msRequestFullscreen) {
    return await elem.msRequestFullscreen();
  }
}

function setupFullscreenTrigger() {
  const enterBtn = document.getElementById('btn-enter-arena');

  enterBtn.onclick = async () => {
    const selectedTeamId = document.getElementById('team-selector').value;
    if (!selectedTeamId) {
      alert('Please select your team name before entering.');
      return;
    }

    try {
      // Direct call immediately inside the user click event handler
      await requestBrowserFullscreen();
    } catch (err) {
      console.warn('Fullscreen request blocked or not supported on this browser:', err);
    }

    // Load team and session data
    const { data: teamData } = await supabase.from('teams').select('*').eq('id', selectedTeamId).single();
    currentTeam = teamData;
    document.getElementById('team-name-badge').innerText = currentTeam.name;

    const { data: sessData } = await supabase.from('sessions').select('*').eq('team_id', currentTeam.id).single();
    currentSession = sessData;
    document.getElementById('code-editor').value = currentSession?.current_code || '';

    document.getElementById('rules-modal').classList.add('hidden');
    isEnforcingFullscreen = true;

    setupStrictProctoring();
    setupRealtimeListeners();
    setupEditorAutosave();
  };

  document.getElementById('btn-resume-fs').onclick = async () => {
    try {
      await requestBrowserFullscreen();
    } catch (e) {
      console.error(e);
    }
    clearInterval(graceCountdown);
    document.getElementById('countdown-overlay').classList.add('hidden');
  };
}

function setupStrictProctoring() {
  const checkFullscreen = () => {
    if (!isEnforcingFullscreen) return;
    const isFs = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
    if (!isFs) {
      triggerViolationOverlay('fullscreen_exit');
    }
  };

  document.addEventListener('fullscreenchange', checkFullscreen);
  document.addEventListener('webkitfullscreenchange', checkFullscreen);

  window.addEventListener('blur', () => {
    if (isEnforcingFullscreen) triggerViolationOverlay('window_blur');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && isEnforcingFullscreen) triggerViolationOverlay('tab_switch');
  });

  // Block shortcuts
  window.addEventListener('keydown', (e) => {
    if (
      e.key === 'F12' ||
      (e.ctrlKey && e.shiftKey && ['I', 'J', 'C'].includes(e.key.toUpperCase())) ||
      (e.ctrlKey && ['s', 'p', 'u'].includes(e.key.toLowerCase()))
    ) {
      e.preventDefault();
      RelayDB.recordViolation(currentTeam.id, 'blocked_key');
    }
  });

  // Block copy/paste
  ['copy', 'cut', 'paste', 'contextmenu'].forEach(evt => {
    window.addEventListener(evt, (e) => {
      e.preventDefault();
      RelayDB.recordViolation(currentTeam.id, 'clipboard_attempt');
    });
  });
}

function triggerViolationOverlay(type) {
  RelayDB.recordViolation(currentTeam.id, type);
  const overlay = document.getElementById('countdown-overlay');
  overlay.classList.remove('hidden');
  graceSeconds = 10;
  document.getElementById('countdown-val').innerText = graceSeconds;

  clearInterval(graceCountdown);
  graceCountdown = setInterval(() => {
    graceSeconds--;
    document.getElementById('countdown-val').innerText = graceSeconds;
    if (graceSeconds <= 0) {
      clearInterval(graceCountdown);
      RelayDB.recordViolation(currentTeam.id, 'blocked_key');
    }
  }, 1000);
}

function setupWorker() {
  pyodideWorker = new Worker('js/pyodide-worker.js');
  pyodideWorker.onmessage = (e) => {
    const { type, data, error, duration } = e.data;
    const consoleEl = document.getElementById('console-output');
    if (type === 'stdout') consoleEl.innerText += data + '\n';
    if (type === 'stderr') consoleEl.innerText += '[STDERR] ' + data + '\n';
    if (type === 'error') consoleEl.innerText += '[ERROR] ' + error + '\n';
    if (type === 'finished') consoleEl.innerText += `\n[Exited in ${duration}ms]`;
  };

  document.getElementById('btn-run').onclick = () => {
    document.getElementById('console-output').innerText = '';
    const code = document.getElementById('code-editor').value;
    const stdin = document.getElementById('custom-stdin').value;
    pyodideWorker.postMessage({ code, stdin, runId: Date.now() });
  };
}

function setupEditorAutosave() {
  const editor = document.getElementById('code-editor');
  editor.addEventListener('input', () => {
    document.getElementById('save-status').innerText = 'Saving...';
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      if (currentSession?.status === 'active') {
        await supabase.from('sessions').update({ current_code: editor.value }).eq('team_id', currentTeam.id);
        document.getElementById('save-status').innerText = 'Saved';
      }
    }, 1200);
  });
}

function setupRealtimeListeners() {
  supabase.channel(`team_live_${currentTeam.id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'teams', filter: `id=eq.${currentTeam.id}` }, payload => {
      currentTeam = payload.new;
      const overlay = document.getElementById('blockout-overlay');
      if (currentTeam.is_blocked) {
        document.getElementById('blockout-msg').innerText = currentTeam.block_message;
        overlay.classList.remove('hidden');
      } else {
        overlay.classList.add('hidden');
      }
      const member = currentTeam.members[currentTeam.current_member_index] || 'Finished';
      document.getElementById('current-member-name').innerText = `Member: ${member}`;
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `team_id=eq.${currentTeam.id}` }, payload => {
      currentSession = payload.new;
      if (currentSession.status === 'terminated') {
        alert('Session terminated due to violations.');
        window.location.reload();
      }
    })
    .subscribe();
}

function syncTimer() {
  if (currentSession) {
    const rem = RelayDB.computeRemainingTime(currentSession);
    const mm = String(Math.floor(rem / 60)).padStart(2, '0');
    const ss = String(rem % 60).padStart(2, '0');
    document.getElementById('player-timer').innerText = `${mm}:${ss}`;

    if (rem === 0 && currentSession.status === 'active') {
      RelayDB.handover(currentTeam.id);
    }
  }
}

init();