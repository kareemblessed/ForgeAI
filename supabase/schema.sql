-- ============================================================
-- FORGE AI — Supabase Schema
-- Run this entire file once in your Supabase SQL Editor
-- Project: https://app.supabase.com → SQL Editor → New Query
-- ============================================================

-- ── EXTENSIONS ──────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ============================================================
-- TABLES
-- ============================================================

-- ── PROFILES ────────────────────────────────────────────────
-- Auto-created when a user signs up via Supabase Auth
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Student',
  avatar_color text not null default '#534AB7',
  created_at   timestamptz not null default now()
);

-- ── ROOMS ───────────────────────────────────────────────────
-- A Forge study room. Created by a host, joined via share link.
create table if not exists public.rooms (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  join_token    text not null unique default substr(md5(random()::text), 1, 8),
  host_id       uuid not null references public.profiles(id) on delete cascade,
  topic_context jsonb,        -- stores the AnalysisResult so the room knows what's being studied
  is_active     boolean not null default true,
  daily_room_url text,        -- Daily.co room URL set after creation
  created_at    timestamptz not null default now()
);

-- ── ROOM MEMBERS ────────────────────────────────────────────
-- Tracks who is in a room right now
create table if not exists public.room_members (
  id         uuid primary key default uuid_generate_v4(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  unique(room_id, user_id)
);

-- ── ROOM MESSAGES ───────────────────────────────────────────
-- Persistent chat messages per room
create table if not exists public.room_messages (
  id          uuid primary key default uuid_generate_v4(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  content     text not null,
  created_at  timestamptz not null default now()
);

-- ── SHARED AI MESSAGES ──────────────────────────────────────
-- AI tutor conversation visible to everyone in the room
create table if not exists public.shared_ai_messages (
  id          uuid primary key default uuid_generate_v4(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  asked_by    uuid not null references public.profiles(id) on delete cascade,
  question    text not null,
  answer      text,           -- null while AI is generating
  created_at  timestamptz not null default now()
);

-- ── QUIZ SESSIONS ───────────────────────────────────────────
-- Group quiz battles
create table if not exists public.quiz_sessions (
  id          uuid primary key default uuid_generate_v4(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  host_id     uuid not null references public.profiles(id) on delete cascade,
  topic       text not null,
  questions   jsonb not null default '[]',  -- array of QuizQuestion
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ── QUIZ ANSWERS ────────────────────────────────────────────
-- Individual answers submitted during a quiz battle
create table if not exists public.quiz_answers (
  id               uuid primary key default uuid_generate_v4(),
  quiz_session_id  uuid not null references public.quiz_sessions(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  question_index   int not null,
  selected_answer  text not null,
  is_correct       boolean not null,
  answered_at      timestamptz not null default now(),
  unique(quiz_session_id, user_id, question_index)
);

-- ── FLASHCARD SETS ──────────────────────────────────────────
-- AI-generated flashcards per topic per user
create table if not exists public.flashcard_sets (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  topic       text not null,
  cards       jsonb not null default '[]',   -- [{front, back, interval, nextReview}]
  created_at  timestamptz not null default now()
);

-- ── PROGRESS ────────────────────────────────────────────────
-- Per-user quiz score history for the analytics dashboard
create table if not exists public.progress (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  topic       text not null,
  score       int not null,
  total       int not null,
  mode        text not null,  -- 'calm' | 'warn' | 'zoom'
  created_at  timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- Critical: without this, any user can read all data
-- ============================================================

alter table public.profiles          enable row level security;
alter table public.rooms             enable row level security;
alter table public.room_members      enable row level security;
alter table public.room_messages     enable row level security;
alter table public.shared_ai_messages enable row level security;
alter table public.quiz_sessions     enable row level security;
alter table public.quiz_answers      enable row level security;
alter table public.flashcard_sets    enable row level security;
alter table public.progress          enable row level security;

-- ── PROFILES policies ───────────────────────────────────────
create policy "Users can view any profile"
  on public.profiles for select using (true);

create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles for insert with check (auth.uid() = id);

-- ── ROOMS policies ──────────────────────────────────────────
create policy "Anyone authenticated can view rooms"
  on public.rooms for select using (auth.role() = 'authenticated');

create policy "Authenticated users can create rooms"
  on public.rooms for insert with check (auth.uid() = host_id);

create policy "Only host can update room"
  on public.rooms for update using (auth.uid() = host_id);

create policy "Only host can delete room"
  on public.rooms for delete using (auth.uid() = host_id);

-- ── ROOM MEMBERS policies ───────────────────────────────────
create policy "Room members can view other members"
  on public.room_members for select using (auth.role() = 'authenticated');

create policy "Authenticated users can join rooms"
  on public.room_members for insert with check (auth.uid() = user_id);

create policy "Users can leave (delete own membership)"
  on public.room_members for delete using (auth.uid() = user_id);

-- ── ROOM MESSAGES policies ──────────────────────────────────
create policy "Room members can read messages"
  on public.room_messages for select using (auth.role() = 'authenticated');

create policy "Authenticated users can send messages"
  on public.room_messages for insert with check (auth.uid() = user_id);

-- ── SHARED AI MESSAGES policies ─────────────────────────────
create policy "Room members can read AI messages"
  on public.shared_ai_messages for select using (auth.role() = 'authenticated');

create policy "Authenticated users can ask AI questions"
  on public.shared_ai_messages for insert with check (auth.uid() = asked_by);

create policy "Service role can update AI answers"
  on public.shared_ai_messages for update using (auth.role() = 'service_role');

-- ── QUIZ policies ───────────────────────────────────────────
create policy "Room members can view quiz sessions"
  on public.quiz_sessions for select using (auth.role() = 'authenticated');

create policy "Authenticated users can create quiz sessions"
  on public.quiz_sessions for insert with check (auth.uid() = host_id);

create policy "Users can view all quiz answers in session"
  on public.quiz_answers for select using (auth.role() = 'authenticated');

create policy "Users can submit own answers"
  on public.quiz_answers for insert with check (auth.uid() = user_id);

-- ── FLASHCARDS policies ─────────────────────────────────────
create policy "Users can only view own flashcards"
  on public.flashcard_sets for select using (auth.uid() = user_id);

create policy "Users can create own flashcards"
  on public.flashcard_sets for insert with check (auth.uid() = user_id);

create policy "Users can update own flashcards"
  on public.flashcard_sets for update using (auth.uid() = user_id);

create policy "Users can delete own flashcards"
  on public.flashcard_sets for delete using (auth.uid() = user_id);

-- ── PROGRESS policies ───────────────────────────────────────
create policy "Users can view own progress"
  on public.progress for select using (auth.uid() = user_id);

create policy "Users can insert own progress"
  on public.progress for insert with check (auth.uid() = user_id);

-- ============================================================
-- REALTIME
-- Enable realtime on the tables that need live sync
-- ============================================================

alter publication supabase_realtime add table public.room_members;
alter publication supabase_realtime add table public.room_messages;
alter publication supabase_realtime add table public.shared_ai_messages;
alter publication supabase_realtime add table public.quiz_sessions;
alter publication supabase_realtime add table public.quiz_answers;

-- ============================================================
-- TRIGGER: Auto-create profile on signup
-- When a user signs up via Supabase Auth, their profile row
-- is created automatically so we never have missing profiles.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- DONE
-- Your Forge AI database is ready.
-- Next step: copy your Supabase project URL and anon key
-- into your .env.local file.
-- ============================================================
