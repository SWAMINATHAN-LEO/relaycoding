/**
 * js/database.js - Supabase Client & Shared Logic
 */
const SUPABASE_URL = "https://krgnmkarbeqioapyllpn.supabase.co";[span_0](start_span)[span_0](end_span)
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyZ25ta2FyYmVxaW9hcHlsbHBuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1NDU4ODMsImV4cCI6MjEwODEyMTg4M30.xfDtO9Bif3670BoR-eKowxlCy8dJ0PqzgLV2n5wveGg";

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const RelayDB = {
  // Authoritative server remaining time calculation
  computeRemainingTime(sessionRow) {
    if (!sessionRow || sessionRow.status === 'waiting') return sessionRow?.duration || 900;
    if (sessionRow.status === 'finished' || sessionRow.status === 'terminated') return 0;
    
    const now = Math.floor(Date.now() / 1000);
    const started = Math.floor(new Date(sessionRow.started_at).getTime() / 1000);
    const accumPause = sessionRow.accumulated_pause || 0;
    
    if (sessionRow.status === 'paused') {
      const pausedAt = Math.floor(new Date(sessionRow.paused_at).getTime() / 1000);
      const elapsedActiveBeforePause = pausedAt - started - accumPause;
      return Math.max(0, sessionRow.duration - elapsedActiveBeforePause);
    }

    const totalElapsed = now - started - accumPause;
    return Math.max(0, sessionRow.duration - totalElapsed);
  },

  // Remote Procedure Calls matching your SQL schema
  async startSession(teamId) {
    return await supabase.rpc('start_session', { target_team_id: teamId });
  },

  async pauseSession(teamId) {
    return await supabase.rpc('pause_session', { target_team_id: teamId });
  },

  async resumeSession(teamId) {
    return await supabase.rpc('resume_session', { target_team_id: teamId });
  },

  async recordViolation(teamId, type) {
    return await supabase.rpc('record_violation', {
      v_team_id: teamId,
      v_type: type
    });
  },

  async handover(teamId) {
    return await supabase.rpc('handover_next_member', { target_team_id: teamId });
  },

  // Global Realtime Channel Listener
  subscribeToAll(onSessionChange, onTeamChange, onBroadcast) {
    return supabase.channel('relay_global_feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, payload => onSessionChange?.(payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, payload => onTeamChange?.(payload))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'broadcasts' }, payload => onBroadcast?.(payload.new))
      .subscribe();
  }
};
