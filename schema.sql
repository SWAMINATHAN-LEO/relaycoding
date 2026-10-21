-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- 1. ENUMS
create type session_status as enum ('waiting', 'active', 'paused', 'finished', 'terminated', 'disqualified');
create type violation_type as enum ('fullscreen_exit', 'tab_switch', 'window_blur', 'clipboard_attempt', 'context_menu', 'devtools_open', 'blocked_key');

-- 2. PROFILES & ROLES
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  role text not null check (role in ('admin', 'team')),
  created_at timestamptz default now()
);

-- 3. TEAMS TABLE
create table public.teams (
  id uuid default gen_random_uuid() primary key,
  auth_id uuid references auth.users(id) on delete cascade unique,
  name text not null unique,
  username text not null unique,
  members jsonb not null default '[]'::jsonb, -- Array of strings e.g. ["Alice", "Bob", "Charlie"]
  current_member_index int not null default 0,
  is_online boolean default false,
  is_blocked boolean default false,
  block_message text default 'Screen locked by Administrator.',
  created_at timestamptz default now()
);

-- 4. PROBLEMS
create table public.problems (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  description text not null,
  sample_input text default '',
  sample_output text default '',
  hidden_tests jsonb not null default '[]'::jsonb, -- [{"stdin": "2\n3", "expected": "5"}]
  points int default 100,
  created_at timestamptz default now()
);

-- 5. SESSIONS (Authoritative server clock)
create table public.sessions (
  id uuid default gen_random_uuid() primary key,
  team_id uuid references public.teams(id) on delete cascade unique,
  problem_id uuid references public.problems(id),
  status session_status not null default 'waiting',
  duration int not null default 900, -- 15 mins in seconds per relay leg
  started_at timestamptz,
  paused_at timestamptz,
  accumulated_pause int not null default 0,
  violation_count int not null default 0,
  current_code text not null default '# Write your Python code here\n',
  updated_at timestamptz default now()
);

-- 6. RUN LOGS & SUBMISSIONS
create table public.run_logs (
  id uuid default gen_random_uuid() primary key,
  team_id uuid references public.teams(id) on delete cascade,
  code text not null,
  stdin text default '',
  stdout text default '',
  stderr text default '',
  execution_time_ms int default 0,
  created_at timestamptz default now()
);

create table public.submissions (
  id uuid default gen_random_uuid() primary key,
  team_id uuid references public.teams(id) on delete cascade,
  problem_id uuid references public.problems(id),
  code text not null,
  passed_cases int not null default 0,
  total_cases int not null default 0,
  status text not null, -- 'AC', 'WA', 'TLE', 'ERROR'
  submitted_at timestamptz default now()
);

-- 7. AUDIT VIOLATIONS
create table public.violations (
  id uuid default gen_random_uuid() primary key,
  team_id uuid references public.teams(id) on delete cascade,
  violation_type violation_type not null,
  details jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- 8. GLOBAL BROADCASTS & ALARMS
create table public.broadcasts (
  id uuid default gen_random_uuid() primary key,
  message text not null,
  alarm_sound boolean default false,
  created_at timestamptz default now()
);

-- ENABLE REALTIME ON KEY TABLES
alter publication supabase_realtime add table public.teams;
alter publication supabase_realtime add table public.sessions;
alter publication supabase_realtime add table public.broadcasts;
alter publication supabase_realtime add table public.violations;

-- ROW LEVEL SECURITY (RLS)
alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.problems enable row level security;
alter table public.sessions enable row level security;
alter table public.run_logs enable row level security;
alter table public.submissions enable row level security;
alter table public.violations enable row level security;
alter table public.broadcasts enable row level security;

-- Admin Helper Function
create or replace function public.is_admin()
returns boolean as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$ language sql security definer;

-- RLS POLICIES
create policy "Admins full access on all tables" on public.profiles for all using (is_admin());
create policy "Admins access teams" on public.teams for all using (is_admin());
create policy "Teams read own data" on public.teams for select using (auth_id = auth.uid());

create policy "Admins access problems" on public.problems for all using (is_admin());
create policy "Teams read assigned problems" on public.problems for select using (true);

create policy "Admins access sessions" on public.sessions for all using (is_admin());
create policy "Teams select own session" on public.sessions for select using (
  team_id in (select id from public.teams where auth_id = auth.uid())
);
-- Teams can only save their current_code if session is active
create policy "Teams update code when active" on public.sessions for update using (
  team_id in (select id from public.teams where auth_id = auth.uid()) 
  and status = 'active'
);

create policy "Admins read violations" on public.violations for all using (is_admin());
create policy "Teams insert violations" on public.violations for insert with check (
  team_id in (select id from public.teams where auth_id = auth.uid())
);

create policy "Broadcasts read by everyone" on public.broadcasts for select using (true);
create policy "Admins insert broadcasts" on public.broadcasts for insert with check (is_admin());

create policy "Admins read run logs" on public.run_logs for all using (is_admin());
create policy "Teams insert own run logs" on public.run_logs for insert with check (
  team_id in (select id from public.teams where auth_id = auth.uid())
);

create policy "Submissions read by all" on public.submissions for select using (true);
create policy "Teams insert submissions" on public.submissions for insert with check (
  team_id in (select id from public.teams where auth_id = auth.uid())
);

-- SERVER-AUTHORITATIVE RPC FUNCTIONS
create or replace function public.start_session(target_team_id uuid)
returns void as $$
begin
  if not public.is_admin() then raise exception 'Unauthorized'; end if;
  update public.sessions
  set status = 'active', started_at = coalesce(started_at, now()), updated_at = now()
  where team_id = target_team_id and status in ('waiting', 'paused');
end;
$$ language plpgsql security definer;

create or replace function public.pause_session(target_team_id uuid)
returns void as $$
begin
  if not public.is_admin() then raise exception 'Unauthorized'; end if;
  update public.sessions
  set status = 'paused', paused_at = now(), updated_at = now()
  where team_id = target_team_id and status = 'active';
end;
$$ language plpgsql security definer;

create or replace function public.resume_session(target_team_id uuid)
returns void as $$
begin
  if not public.is_admin() then raise exception 'Unauthorized'; end if;
  update public.sessions
  set status = 'active',
      accumulated_pause = accumulated_pause + extract(epoch from (now() - paused_at))::int,
      paused_at = null,
      updated_at = now()
  where team_id = target_team_id and status = 'paused';
end;
$$ language plpgsql security definer;

create or replace function public.adjust_session_time(target_team_id uuid, delta_seconds int)
returns void as $$
begin
  if not public.is_admin() then raise exception 'Unauthorized'; end if;
  update public.sessions
  set duration = duration + delta_seconds, updated_at = now()
  where team_id = target_team_id;
end;
$$ language plpgsql security definer;

create or replace function public.record_violation(v_team_id uuid, v_type violation_type, v_details jsonb)
returns void as $$
declare
  curr_violations int;
begin
  insert into public.violations(team_id, violation_type, details)
  values (v_team_id, v_type, v_details);

  update public.sessions
  set violation_count = violation_count + 1
  where team_id = v_team_id
  returning violation_count into curr_violations;

  -- Default strict termination limit: 3 violations
  if curr_violations >= 3 then
    update public.sessions set status = 'terminated', updated_at = now() where team_id = v_team_id;
  end if;
end;
$$ language plpgsql security definer;

create or replace function public.reinstate_team(target_team_id uuid)
returns void as $$
begin
  if not public.is_admin() then raise exception 'Unauthorized'; end if;
  update public.sessions
  set status = 'paused', violation_count = 0, updated_at = now()
  where team_id = target_team_id;
end;
$$ language plpgsql security definer;

create or replace function public.handover_next_member(target_team_id uuid)
returns void as $$
declare
  mem_count int;
  curr_idx int;
begin
  select jsonb_array_length(members), current_member_index into mem_count, curr_idx
  from public.teams where id = target_team_id;

  if curr_idx + 1 < mem_count then
    update public.teams set current_member_index = curr_idx + 1 where id = target_team_id;
    update public.sessions 
    set started_at = now(), paused_at = null, accumulated_pause = 0, status = 'active', updated_at = now()
    where team_id = target_team_id;
  else
    update public.sessions set status = 'finished', updated_at = now() where team_id = target_team_id;
  end if;
end;
$$ language plpgsql security definer;

-- SEED DATA
insert into public.problems (title, description, sample_input, sample_output, hidden_tests)
values (
  'Array Multi-Sum Relay',
  'Write a Python program that reads a list of space-separated integers from stdin and prints the sum of all even numbers multiplied by the count of odd numbers.',
  '1 2 3 4 5',
  '18',
  '[{"stdin": "1 2 3 4 5", "expected": "18"}, {"stdin": "2 4 6", "expected": "0"}, {"stdin": "1 3 5", "expected": "0"}, {"stdin": "10 5 2 3", "expected": "24"}]'::jsonb
);