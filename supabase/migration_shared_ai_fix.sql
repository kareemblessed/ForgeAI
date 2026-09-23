-- ============================================================
-- FORGE AI — migration (safe to run more than once)
-- Paste into Supabase → SQL Editor → New query → Run
--
-- Do NOT re-run schema.sql on an existing project: its
-- "create policy" and "alter publication" lines aren't repeatable.
-- ============================================================

-- 1) Let the person who asked a question save the AI's answer.
--    Before this, only service_role could update the row, so the answer
--    never reached the other people in the room.
drop policy if exists "Askers can save the answer to their own question" on public.shared_ai_messages;

create policy "Askers can save the answer to their own question"
  on public.shared_ai_messages for update
  using (auth.uid() = asked_by)
  with check (auth.uid() = asked_by);

-- 2) Profile trigger: never insert a null display_name
--    (harmless for email sign-ups; only matters for users with no email).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Student'
    )
  );
  return new;
end;
$$;

-- 3) Let the host retire a finished quiz battle (so people who join later
--    don't land on an old quiz).
drop policy if exists "Host can update own quiz session" on public.quiz_sessions;

create policy "Host can update own quiz session"
  on public.quiz_sessions for update
  using (auth.uid() = host_id)
  with check (auth.uid() = host_id);
