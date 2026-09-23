/**
 * Forge AI — RoomLobby.tsx
 * Create a Forge Room or join one with a code / invite link.
 * Styles live in styles/rooms.css (.lobby-*).
 */
import React, { useState } from 'react';
import { supabase } from '../supabase/client';
import type { Profile } from '../supabase/client';
import type { AnalysisResult } from '../api';
import { Icon } from './icons';

type Props = {
  userId: string;
  profile: Profile | null;
  analysis: AnalysisResult | null;
  onEnter: (roomId: string) => void;
  onBack: () => void;
};

/** Accepts a bare code ("ab3x9f2c") or a full invite link (".../?room=ab3x9f2c"). */
const extractToken = (raw: string): string => {
  const v = raw.trim();
  try {
    const t = new URL(v).searchParams.get('room');
    if (t) return t.trim().toLowerCase();
  } catch { /* not a URL */ }
  return v.toLowerCase();
};

/** Daily.co room names allow letters, digits, - and _; the suffix keeps names unique. */
const toDailyName = (name: string) => {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'forge-room';
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
};

const RoomLobby: React.FC<Props> = ({ userId, profile, analysis, onEnter, onBack }) => {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const topicCount = analysis?.study_these?.length ?? 0;
  const firstName = profile?.display_name?.split(' ')[0];

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Give your room a name first.'); return; }
    setCreating(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token;

      let dailyUrl: string | null = null;
      try {
        const res = await fetch('/api/room', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt ?? ''}` },
          body: JSON.stringify({ roomName: toDailyName(name) }),
        });
        if (res.ok) { const d = await res.json() as { url: string }; dailyUrl = d.url; }
      } catch { /* video is optional */ }

      const { data, error } = await supabase
        .from('rooms')
        .insert({ name: name.trim(), host_id: userId, topic_context: analysis ?? null, daily_room_url: dailyUrl })
        .select('id')
        .single();

      if (error) throw error;
      onEnter((data as { id: string }).id);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Failed to create room.');
    } finally { setCreating(false); }
  };

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = extractToken(token);
    if (!code) { setErr('Enter a room code or paste an invite link.'); return; }
    setJoining(true); setErr(null);
    try {
      const { data, error } = await supabase
        .from('rooms')
        .select('id')
        .eq('join_token', code)
        .eq('is_active', true)
        .maybeSingle();

      if (error || !data) { setErr('Room not found. Double-check the code.'); return; }
      onEnter((data as { id: string }).id);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Failed to join room.');
    } finally { setJoining(false); }
  };

  return (
    <section className="lobby view-container">
      <button type="button" className="lobby-back" onClick={onBack}>
        <Icon name="arrowLeft" size={16} /> Back
      </button>

      <header className="lobby-head">
        <span className="lobby-mark"><Icon name="users" size={26} /></span>
        <h1>Forge Room</h1>
        <p>
          {firstName ? `Hey ${firstName} — study` : 'Study'} together with video, a shared AI tutor and live quiz battles.
        </p>
      </header>

      {err && (
        <div className="lobby-alert" role="alert">
          <Icon name="alert" size={18} /><span>{err}</span>
        </div>
      )}

      <div className="lobby-grid">
        {/* ── Create ─────────────────────────────────────── */}
        <form className="lobby-card primary" onSubmit={create}>
          <div className="lobby-card-icon"><Icon name="bolt" size={22} /></div>
          <h2>Create a room</h2>
          <p>Start a session and share the invite link with your group.</p>

          <label className="sr-only" htmlFor="lobby-name">Room name</label>
          <input
            id="lobby-name" className="lobby-input" type="text" maxLength={60}
            placeholder="Room name, e.g. Thermo Exam Prep"
            value={name} onChange={e => setName(e.target.value)} autoComplete="off"
          />

          <div className={`lobby-topics${topicCount ? ' has' : ''}`}>
            <Icon name={topicCount ? 'checkCircle' : 'book'} size={16} />
            {topicCount
              ? `${topicCount} topic${topicCount === 1 ? '' : 's'} from your study plan will be shared`
              : 'No study plan attached — generate one first to share topics'}
          </div>

          <button type="submit" className="lobby-btn primary" disabled={creating}>
            {creating ? <><span className="forge-spin" />Creating…</> : <><Icon name="bolt" size={16} />Create room</>}
          </button>
        </form>

        <div className="lobby-or" aria-hidden="true"><span>or</span></div>

        {/* ── Join ───────────────────────────────────────── */}
        <form className="lobby-card" onSubmit={join}>
          <div className="lobby-card-icon"><Icon name="link" size={22} /></div>
          <h2>Join a room</h2>
          <p>Paste the invite link or enter the 8-character code from your friend.</p>

          <label className="sr-only" htmlFor="lobby-code">Room code</label>
          <input
            id="lobby-code" className="lobby-input code" type="text" spellCheck={false}
            placeholder="ab3x9f2c" value={token}
            onChange={e => setToken(e.target.value)} autoComplete="off"
          />

          <button type="submit" className="lobby-btn" disabled={joining}>
            {joining ? <><span className="forge-spin" />Joining…</> : <><Icon name="link" size={16} />Join room</>}
          </button>
        </form>
      </div>
    </section>
  );
};

export default RoomLobby;
