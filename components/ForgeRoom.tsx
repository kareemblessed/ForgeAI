/**
 * Forge AI — ForgeRoom.tsx
 *
 * Full-screen study room: participants + media controls, shared AI notes,
 * and a tabbed side panel (shared AI, live tutor, group chat, quiz battle).
 * Styles live in styles/rooms.css (.fr-*).
 *
 * - Live tutor: red tappable orb, sequential audio queue, live streaming transcript
 * - Shared AI: ensureNotes before chat creation; realtime rows are patched in place
 *   (no full-table reload per event)
 * - Mic/Cam: Daily.co when the room has a video URL, otherwise native getUserMedia
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import MD from './MD';
import { Icon, Avatar } from './icons';
import type { IconName } from './icons';
import { supabase } from '../supabase/client';
import type { Room, RoomMember, SharedAIMessage, Profile } from '../supabase/client';
import type { AnalysisResult, Topic, QuizQuestion } from '../api';
import RoomChat from './RoomChat';
import QuizBattle from './QuizBattle';
import {
  apiGeneratePracticeQuiz,
  apiGenerateStudyNotes,
  apiChatWithDocumentsStream,
  apiCreateChatForTopic,
  apiConnectLiveTutor,
  createBlob,
  decode,
  decodeAudioData,
} from '../api';
import type { LiveServerMessage } from '@google/genai';

type RightPanelTab = 'ai' | 'tutor' | 'chat' | 'quiz';
type TutorStatus = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';
type AiRow = SharedAIMessage & { profiles: Profile };

type Props = {
  roomId: string;
  userId: string;
  userProfile: Profile;
  onLeave: () => void;
};

const TABS: { id: RightPanelTab; label: string; icon: IconName }[] = [
  { id: 'ai',    label: 'AI',    icon: 'sparkles' },
  { id: 'tutor', label: 'Tutor', icon: 'mic' },
  { id: 'chat',  label: 'Chat',  icon: 'chat' },
  { id: 'quiz',  label: 'Quiz',  icon: 'trophy' },
];

const SUGGESTIONS = ['Explain this simply', 'Give me an example', 'What will the exam ask?'];

const PROFILE_COLS = 'id, display_name, avatar_color';

const ForgeRoom: React.FC<Props> = ({ roomId, userId, userProfile, onLeave }) => {

  /* ── state ─────────────────────────────────────────────────── */
  const [room,           setRoom]          = useState<Room | null>(null);
  const [members,        setMembers]       = useState<(RoomMember & { profiles: Profile })[]>([]);
  const [activeTab,      setActiveTab]     = useState<RightPanelTab>('ai');
  const [aiMessages,     setAiMessages]    = useState<AiRow[]>([]);
  const [aiInput,        setAiInput]       = useState('');
  const [isAiLoading,    setIsAiLoading]   = useState(false);
  const [currentTopic,   setCurrentTopic]  = useState<Topic | null>(null);
  const [copied,         setCopied]        = useState<'link' | 'code' | null>(null);
  const [isVideoVisible, setIsVideoVisible]= useState(false);
  const [micMuted,       setMicMuted]      = useState(false);
  const [camOff,         setCamOff]        = useState(false);
  const [notesLoading,   setNotesLoading]  = useState(false);
  const [callFrame,      setCallFrame]     = useState<any>(null);

  /* native mic/cam (works locally without Daily.co) */
  const [micStream,      setMicStream]     = useState<MediaStream | null>(null);
  const [camStream,      setCamStream]     = useState<MediaStream | null>(null);
  const localVideoRef  = useRef<HTMLVideoElement>(null);

  /* live tutor */
  const [tutorStatus,     setTutorStatus]    = useState<TutorStatus>('idle');
  const [tutorPaused,     setTutorPaused]    = useState(false);
  const [tutorTranscript, setTutorTranscript]= useState<{ role: 'user' | 'ai'; text: string; id: number }[]>([]);

  /* refs */
  const dailyRef      = useRef<HTMLDivElement>(null);
  const aiScrollRef   = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const profileCache  = useRef(new Map<string, Profile>());
  const mountedRef    = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  /* audio */
  const outCtxRef    = useRef<AudioContext | null>(null);
  const audioQueue   = useRef<Promise<void>>(Promise.resolve());
  const nextStart    = useRef<number>(0);

  /* mic */
  const micCtxRef    = useRef<AudioContext | null>(null);
  const streamRef    = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef   = useRef<any>(null);

  /* transcript buffers */
  const inTextRef  = useRef('');
  const outTextRef = useRef('');

  const isHost = room?.host_id === userId;

  // Daily.co starts with mic + cam on; the native path starts with them off.
  const micOn = callFrame ? !micMuted : !!micStream;
  const camOn = callFrame ? !camOff   : !!camStream;

  /* ── load room ─────────────────────────────────────────────── */
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('rooms').select('*').eq('id', roomId).single();
      if (!data) return;
      setRoom(data as Room);
      const topics = (data.topic_context as AnalysisResult | null)?.study_these;
      if (topics?.[0]) setCurrentTopic(topics[0]);
    })();
  }, [roomId]);

  /* ── members ───────────────────────────────────────────────── */
  // Live participants come from Realtime Presence, not a table row: presence is dropped
  // automatically when a tab closes or loses connection, so nobody lingers as a ghost.
  useEffect(() => {
    const ch = supabase.channel(`room_presence:${roomId}`, { config: { presence: { key: userId } } });
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState<{ display_name?: string; avatar_color?: string }>();
      const list = Object.entries(state).map(([key, metas]) => {
        const meta = metas[0] ?? {};
        const profile: Profile = {
          id: key, display_name: meta.display_name ?? 'Student', avatar_color: meta.avatar_color ?? '#534AB7', created_at: '',
        };
        profileCache.current.set(key, profile);
        return { id: key, room_id: roomId, user_id: key, joined_at: '', profiles: profile };
      });
      // You first, then everyone else alphabetically (stable order between syncs)
      list.sort((a, b) => (a.user_id === userId ? -1 : b.user_id === userId ? 1 : a.profiles.display_name.localeCompare(b.profiles.display_name)));
      setMembers(list);
    }).subscribe(async status => {
      if (status === 'SUBSCRIBED') await ch.track({ display_name: userProfile.display_name, avatar_color: userProfile.avatar_color });
    });
    return () => { void ch.untrack(); supabase.removeChannel(ch); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, userId]);

  /* ── shared AI messages: initial load + in-place realtime patches ── */
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('shared_ai_messages')
        .select(`*, profiles(${PROFILE_COLS})`)
        .eq('room_id', roomId)
        .order('created_at', { ascending: true });
      if (data) setAiMessages(data as any);
    })();

    const ch = supabase.channel(`shared_ai:${roomId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'shared_ai_messages', filter: `room_id=eq.${roomId}` },
        async (payload) => {
          const row = payload.new as SharedAIMessage;
          let profile = profileCache.current.get(row.asked_by);
          if (!profile) {
            const { data } = await supabase.from('profiles').select(PROFILE_COLS).eq('id', row.asked_by).single();
            if (data) { profile = data as Profile; profileCache.current.set(row.asked_by, profile); }
          }
          setAiMessages(prev => prev.some(m => m.id === row.id) ? prev : [...prev, { ...row, profiles: profile as Profile }]);
        })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'shared_ai_messages', filter: `room_id=eq.${roomId}` },
        (payload) => {
          const row = payload.new as SharedAIMessage;
          setAiMessages(prev => prev.map(m => m.id === row.id ? { ...m, answer: row.answer } : m));
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [roomId]);

  // Scroll the message list itself. scrollIntoView() would also scroll the page (which is
  // scrollable on mobile) and the room would open scrolled past the notes.
  useEffect(() => {
    const el = aiScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [aiMessages, activeTab]);
  // Transcript updates arrive many times a second — smooth scrolling here would queue animations.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tutorTranscript]);

  /* ── Daily.co — init when room has a video URL (Vercel production) ── */
  useEffect(() => {
    if (!room?.daily_room_url) return;
    let frame: any;
    let cancelled = false;
    (async () => {
      try {
        const DailyIframe = (await import('@daily-co/daily-js')).default;
        if (cancelled || !dailyRef.current) return;
        frame = DailyIframe.createFrame(dailyRef.current, {
          showLeaveButton: false, showFullscreenButton: false,
          iframeStyle: { width: '100%', height: '100%', border: 'none', borderRadius: '12px' },
        });
        frame.join({ url: room.daily_room_url!, userName: userProfile.display_name ?? undefined });
        setCallFrame(frame);
      } catch (e) { console.error('Daily init failed:', e); }
    })();
    return () => { cancelled = true; frame?.destroy(); setCallFrame(null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.daily_room_url]);

  /* ── Sync local cam stream to video element ─────────────────── */
  useEffect(() => {
    if (localVideoRef.current && camStream) {
      localVideoRef.current.srcObject = camStream;
    }
  }, [camStream]);

  /* ── Mic toggle: Daily.co if present, otherwise native getUserMedia ── */
  const toggleMic = useCallback(async () => {
    if (callFrame) {
      callFrame.setLocalAudio(micMuted); // micMuted=true means currently muted → unmute
      setMicMuted(v => !v);
      return;
    }
    if (micStream) {
      micStream.getAudioTracks().forEach(t => t.stop());
      setMicStream(null);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        setMicStream(stream);
      } catch (e) {
        console.error('Mic access denied:', e);
        alert('Microphone access was denied. Please allow it in your browser settings.');
      }
    }
  }, [callFrame, micStream, micMuted]);

  /* ── Cam toggle ─────────────────────────────────────────────── */
  const toggleCam = useCallback(async () => {
    if (callFrame) {
      callFrame.setLocalVideo(camOff); // camOff=true means currently off → turn on
      setCamOff(v => !v);
      return;
    }
    if (camStream) {
      camStream.getVideoTracks().forEach(t => t.stop());
      setCamStream(null);
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        setCamStream(stream);
      } catch (e) {
        console.error('Camera access denied:', e);
        alert('Camera access was denied. Please allow it in your browser settings.');
      }
    }
  }, [callFrame, camStream, camOff]);

  /* ── Cleanup native streams on unmount ──────────────────────── */
  useEffect(() => () => {
    micStream?.getTracks().forEach(t => t.stop());
    camStream?.getTracks().forEach(t => t.stop());
  }, [micStream, camStream]);

  /* ── ensure notes exist before AI features ─────────────────── */
  const ensureNotes = useCallback(async (topic: Topic): Promise<Topic> => {
    if (topic.notes) return topic;
    setNotesLoading(true);
    try {
      const notes = await apiGenerateStudyNotes(topic);
      const enriched = { ...topic, notes };
      setCurrentTopic(enriched);
      return enriched;
    } catch (e) {
      console.error('Note generation failed:', e);
      return topic;
    } finally { setNotesLoading(false); }
  }, []);

  /* ── shared AI chat ────────────────────────────────────────── */
  const askAI = async (raw: string) => {
    const question = raw.trim();
    if (!question || isAiLoading) return;
    setAiInput('');
    setIsAiLoading(true);

    const { data: newMsg, error } = await supabase
      .from('shared_ai_messages')
      .insert({ room_id: roomId, asked_by: userId, question })
      .select(`*, profiles(${PROFILE_COLS})`)
      .single();

    if (error || !newMsg) { setIsAiLoading(false); return; }

    // Show immediately with "Thinking…" (the realtime INSERT is de-duplicated by id)
    setAiMessages(prev => prev.some(m => m.id === newMsg.id) ? prev : [...prev, newMsg as any]);

    const finish = async (answer: string) => {
      await supabase.from('shared_ai_messages').update({ answer }).eq('id', newMsg.id);
      setAiMessages(prev => prev.map(m => m.id === newMsg.id ? { ...m, answer } : m));
    };

    try {
      const topic = currentTopic ? await ensureNotes(currentTopic) : null;
      let fullAnswer = '';
      if (topic) {
        const chat = apiCreateChatForTopic(topic);
        if (chat) {
          const stream = await apiChatWithDocumentsStream(chat, question);
          for await (const chunk of stream) fullAnswer += chunk.text ?? '';
        }
      }
      await finish(fullAnswer || 'No study notes available yet. Generate notes from the study plan first.');
    } catch (err) {
      console.error('Shared AI error:', err);
      await finish('Something went wrong. Please try again.');
    } finally { setIsAiLoading(false); }
  };

  const handleAskAI = (e: React.FormEvent) => { e.preventDefault(); askAI(aiInput); };

  /* ── sequential audio queue ────────────────────────────────── */
  const enqueueAudio = useCallback((b64: string) => {
    audioQueue.current = audioQueue.current.then(async () => {
      const ctx = outCtxRef.current;
      if (!ctx || ctx.state === 'closed') return;
      while (ctx.state === 'suspended') await new Promise(r => setTimeout(r, 80));
      try {
        const buf = await decodeAudioData(decode(b64), ctx, 24000, 1);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        const start = Math.max(ctx.currentTime, nextStart.current);
        src.start(start);
        nextStart.current = start + buf.duration;
        setTutorStatus('speaking');
        await new Promise<void>(resolve => { src.onended = () => resolve(); });
      } catch (err) { console.warn('Audio chunk error:', err); }
    });
  }, []);

  /* ── mic stop ──────────────────────────────────────────────── */
  const stopMic = useCallback(() => {
    processorRef.current?.disconnect();
    streamRef.current?.getTracks().forEach(t => t.stop());
    micCtxRef.current?.close().catch(() => {});
    processorRef.current = null; streamRef.current = null; micCtxRef.current = null;
  }, []);

  /* ── toggle orb pause/resume ───────────────────────────────── */
  const toggleTutorPause = useCallback(() => {
    const ctx = outCtxRef.current;
    if (!ctx) return;
    if (ctx.state === 'running') { ctx.suspend(); setTutorPaused(true); }
    else { ctx.resume(); setTutorPaused(false); }
  }, []);

  /* ── start live tutor ──────────────────────────────────────── */
  const startLiveTutor = useCallback(async () => {
    if (!currentTopic || tutorStatus !== 'idle') return;
    setTutorStatus('connecting');
    setTutorTranscript([]);
    inTextRef.current = ''; outTextRef.current = '';

    const topic = await ensureNotes(currentTopic);

    try {
      outCtxRef.current = new AudioContext({ sampleRate: 24000 });
      nextStart.current = 0;
      audioQueue.current = Promise.resolve();

      const session = await apiConnectLiveTutor(topic, {
        onopen: () => { setTutorStatus('listening'); },

        onmessage: (msg: LiveServerMessage) => {
          // User speech — stream live
          const inChunk = (msg as any).serverContent?.inputTranscription?.text;
          if (inChunk) {
            inTextRef.current += inChunk;
            setTutorTranscript(prev => {
              const last = prev[prev.length - 1];
              if (last?.role === 'user') return [...prev.slice(0, -1), { ...last, text: inTextRef.current }];
              return [...prev, { role: 'user', text: inTextRef.current, id: Date.now() }];
            });
          }

          // Model transcript — stream live as AI speaks
          const outChunk = (msg as any).serverContent?.outputTranscription?.text;
          if (outChunk) {
            outTextRef.current += outChunk;
            setTutorTranscript(prev => {
              const last = prev[prev.length - 1];
              if (last?.role === 'ai') return [...prev.slice(0, -1), { ...last, text: outTextRef.current }];
              return [...prev, { role: 'ai', text: outTextRef.current, id: Date.now() }];
            });
          }

          // Audio — all parts, enqueued sequentially
          const parts = (msg as any).serverContent?.modelTurn?.parts ?? [];
          for (const part of parts) {
            if (part.inlineData?.data) enqueueAudio(part.inlineData.data);
          }

          // Turn complete — reset buffers, mark listening after queue drains
          if ((msg as any).serverContent?.turnComplete) {
            inTextRef.current = ''; outTextRef.current = '';
            audioQueue.current.then(() => setTutorStatus('listening'));
          }
        },

        onerror: (e: ErrorEvent) => { console.error('Tutor error:', e); setTutorStatus('error'); },
        onclose: () => { setTutorStatus('idle'); stopMic(); },
      });

      // Left the room while connecting: nothing would ever close this session or the mic
      if (!mountedRef.current) { (session as any)?.close?.(); return; }
      sessionRef.current = session;

      // Mic at 16 kHz
      const tutorMic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!mountedRef.current) { tutorMic.getTracks().forEach(t => t.stop()); return; }
      streamRef.current = tutorMic;
      micCtxRef.current = new AudioContext({ sampleRate: 16000 });
      const source    = micCtxRef.current.createMediaStreamSource(tutorMic);
      const processor = micCtxRef.current.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = ev => {
        if (!sessionRef.current) return;
        sessionRef.current.sendRealtimeInput({ audio: createBlob(ev.inputBuffer.getChannelData(0)) });
      };
      source.connect(processor);
      processor.connect(micCtxRef.current.destination);

    } catch (err) {
      console.error('Live tutor start error:', err);
      setTutorStatus('error');
    }
  }, [currentTopic, tutorStatus, ensureNotes, enqueueAudio, stopMic]);

  /* ── stop live tutor ───────────────────────────────────────── */
  const stopLiveTutor = useCallback(() => {
    sessionRef.current?.close?.();
    sessionRef.current = null;
    stopMic();
    outCtxRef.current?.close().catch(() => {});
    outCtxRef.current = null;
    nextStart.current = 0;
    setTutorStatus('idle');
    setTutorPaused(false);
    setTutorTranscript([]);
  }, [stopMic]);

  useEffect(() => () => { stopLiveTutor(); }, [stopLiveTutor]);

  /* ── copy invite / code ────────────────────────────────────── */
  const copy = (kind: 'link' | 'code') => {
    if (!room) return;
    const value = kind === 'link' ? `${window.location.origin}?room=${room.join_token}` : room.join_token;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(kind);
      setTimeout(() => setCopied(c => (c === kind ? null : c)), 2000);
    });
  };

  /* ── quiz ──────────────────────────────────────────────────── */
  const handleGenerateQuestions = useCallback(async (topic: string): Promise<QuizQuestion[]> =>
    apiGeneratePracticeQuiz({ topic, reason: '', key_points: [] }), []);

  const availableTopics =
    (room?.topic_context as AnalysisResult | null)?.study_these?.map(t => t.topic) ?? [];

  /* ── loading ───────────────────────────────────────────────── */
  if (!room) return (
    <div className="fr-loading">
      <div className="loading-spinner" />
      <p>Joining study room…</p>
    </div>
  );

  /* ── orb icon ──────────────────────────────────────────────── */
  const orbIcon = tutorPaused ? (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
  ) : tutorStatus === 'speaking' ? (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M12 6v12"/><path d="M16 8v8"/><path d="M8 8v8"/><path d="M20 10v4"/><path d="M4 10v4"/>
    </svg>
  ) : (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8"  y1="23" x2="16" y2="23"/>
    </svg>
  );

  const tutorLabel =
    tutorStatus === 'connecting' ? 'Connecting…' :
    tutorStatus === 'error'      ? 'Connection error' :
    tutorPaused                  ? 'Paused' :
    tutorStatus === 'speaking'   ? 'Tutor speaking…' :
    tutorStatus === 'listening'  ? 'Listening — speak now' : '';

  const hasVideo = !!room.daily_room_url;
  const showDaily = hasVideo && isVideoVisible;
  const showLocalPreview = !!camStream && !hasVideo;

  /* ════════════════════════════════════════════════════════════
     RENDER
  ════════════════════════════════════════════════════════════ */
  return (
    <div className="fr">

      {/* ── TOP BAR ─────────────────────────────────────────── */}
      <header className="fr-top">
        <div className="fr-brand">
          <span className="fr-mark"><Icon name="bolt" size={16} /></span>
          <span className="fr-brand-name">Forge AI</span>
        </div>

        <div className="fr-title">
          <h1 title={room.name}>{room.name}</h1>
          <div className="fr-sub">
            <span className="fr-live"><i />{members.length} live</span>
            <button type="button" className="fr-code" onClick={() => copy('code')} title="Copy room code">
              <Icon name="hash" size={12} />{room.join_token}
              <Icon name={copied === 'code' ? 'check' : 'copy'} size={12} />
            </button>
          </div>
        </div>

        <div className="fr-actions">
          <button type="button" className="fr-btn" onClick={() => copy('link')}>
            <Icon name={copied === 'link' ? 'check' : 'link'} size={15} />
            <span>{copied === 'link' ? 'Copied!' : 'Invite'}</span>
          </button>
          <button type="button" className="fr-btn danger" onClick={onLeave}>
            <Icon name="logout" size={15} /><span>Leave</span>
          </button>
        </div>
      </header>

      {/* ── PEOPLE + MEDIA ──────────────────────────────────── */}
      <section className="fr-people" aria-label="Participants">
        <ul className="fr-avatars">
          {members.map(m => {
            const name  = m.profiles?.display_name ?? 'Student';
            const color = (m.profiles?.avatar_color as string | undefined) ?? '#534AB7';
            const isMe  = m.user_id === userId;
            const host  = m.user_id === room.host_id;
            return (
              <li key={m.id} className={`fr-person${isMe ? ' me' : ''}`}>
                <Avatar name={name} color={color} size={28} />
                <span className="fr-person-name">{isMe ? 'You' : name.split(' ')[0]}</span>
                {host && <span className="fr-host" title="Host"><Icon name="crown" size={12} /></span>}
              </li>
            );
          })}
        </ul>

        <div className="fr-media">
          <button
            type="button" className={`fr-round${micOn ? ' on' : ' off'}`} onClick={toggleMic}
            aria-pressed={micOn} aria-label={micOn ? 'Mute microphone' : 'Turn microphone on'}
            title={micOn ? 'Mute microphone' : 'Turn microphone on'}
          >
            <Icon name={micOn ? 'mic' : 'micOff'} size={18} />
          </button>
          <button
            type="button" className={`fr-round${camOn ? ' on' : ' off'}`} onClick={toggleCam}
            aria-pressed={camOn} aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
            title={camOn ? 'Turn camera off' : 'Turn camera on'}
          >
            <Icon name={camOn ? 'video' : 'videoOff'} size={18} />
          </button>
          {hasVideo && (
            <button
              type="button" className={`fr-btn${isVideoVisible ? ' active' : ''}`}
              onClick={() => setIsVideoVisible(v => !v)} aria-pressed={isVideoVisible}
            >
              <Icon name="users" size={15} /><span>{isVideoVisible ? 'Hide video' : 'Show video'}</span>
            </button>
          )}
        </div>
      </section>

      {/* Daily.co container — the iframe is mounted once and just collapsed when hidden */}
      <div ref={dailyRef} className={`fr-video${showDaily ? ' open' : ''}`} />

      {showLocalPreview && (
        <div className="fr-video open local">
          <video ref={localVideoRef} autoPlay muted playsInline />
          <span className="fr-video-tag">{userProfile.display_name ?? 'You'} · local preview</span>
        </div>
      )}

      {/* ── MAIN BODY ───────────────────────────────────────── */}
      <main className="fr-body">

        {/* LEFT: study notes */}
        <section className="fr-card fr-notes" aria-label="AI study notes">
          <div className="fr-card-head">
            <span className="fr-card-title"><Icon name="book" size={16} />Study notes</span>
            {availableTopics.length > 1 && (
              <select
                className="fr-select" aria-label="Topic"
                value={currentTopic?.topic ?? ''}
                onChange={e => {
                  const t = (room.topic_context as AnalysisResult).study_these.find(t => t.topic === e.target.value);
                  if (t) setCurrentTopic(t);
                }}
              >
                {availableTopics.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
            {notesLoading && <span className="fr-status"><span className="forge-spin small" />Generating…</span>}
          </div>

          <div className="fr-scroll">
            {currentTopic?.notes
              ? <MD text={currentTopic.notes} className="fr-md" />
              : (
                <div className="fr-empty">
                  <span className="fr-empty-icon"><Icon name="book" size={22} /></span>
                  <strong>{notesLoading ? 'Generating study notes…' : 'No notes yet'}</strong>
                  <span>
                    {notesLoading ? 'This usually takes a few seconds.'
                      : currentTopic ? 'Ask the AI a question to generate notes for this topic.'
                      : 'No study materials attached — ask the AI anything.'}
                  </span>
                </div>
              )}
          </div>
        </section>

        {/* RIGHT: tabbed panel */}
        <section className="fr-card fr-side" aria-label="Room tools">
          <div className="fr-tabs" role="tablist">
            {TABS.map(tab => (
              <button
                key={tab.id} type="button" role="tab"
                className={`fr-tab${activeTab === tab.id ? ' active' : ''}`}
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon name={tab.icon} size={16} /><span>{tab.label}</span>
              </button>
            ))}
          </div>

          <div className="fr-panel">

            {/* ── AI TAB ────────────────────────────────────── */}
            {activeTab === 'ai' && (
              <div className="fr-ai">
                <div className="fr-panel-head">
                  <span><Icon name="sparkles" size={15} />Shared AI tutor</span>
                  <span className="fr-badge">Everyone sees this</span>
                </div>
                <div className="fr-ai-msgs" ref={aiScrollRef}>
                  {aiMessages.length === 0 && (
                    <div className="fr-empty">
                      <span className="fr-empty-icon"><Icon name="sparkles" size={22} /></span>
                      <strong>Ask anything</strong>
                      <span>The whole room sees the question and the answer.</span>
                      <div className="fr-chips">
                        {SUGGESTIONS.map(s => (
                          <button key={s} type="button" className="fr-chip" disabled={isAiLoading} onClick={() => askAI(s)}>{s}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {aiMessages.map(msg => {
                    const asker = msg.profiles?.display_name ?? 'Student';
                    return (
                      <div key={msg.id} className="fr-ai-entry">
                        <div className="fr-ai-q">
                          <Avatar name={asker} color={msg.profiles?.avatar_color} size={26} />
                          <div>
                            <span className="fr-ai-asker">{msg.asked_by === userId ? 'You' : asker}</span>
                            <p>{msg.question}</p>
                          </div>
                        </div>
                        <div className="fr-ai-a">
                          <span className="fr-ai-bot"><Icon name="sparkles" size={14} /></span>
                          {msg.answer
                            ? <MD text={msg.answer} className="fr-md" />
                            : <span className="fr-typing"><i /><i /><i /><span className="sr-only">Generating answer…</span></span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <form className="fr-composer" onSubmit={handleAskAI}>
                  <input
                    className="fr-input"
                    placeholder={currentTopic ? `Ask about ${currentTopic.topic}…` : 'Ask anything…'}
                    value={aiInput} onChange={e => setAiInput(e.target.value)}
                    disabled={isAiLoading} aria-label="Ask the AI"
                  />
                  <button type="submit" className="fr-send" disabled={!aiInput.trim() || isAiLoading} aria-label="Send question">
                    {isAiLoading ? <span className="forge-spin small" /> : <Icon name="send" size={17} />}
                  </button>
                </form>
              </div>
            )}

            {/* ── LIVE TUTOR TAB ─────────────────────────────── */}
            {activeTab === 'tutor' && (
              tutorStatus === 'idle' ? (
                <div className="fr-tutor-idle">
                  <span className="fr-tutor-hero"><Icon name="mic" size={30} /></span>
                  <h3>Live AI tutor</h3>
                  <p>Speak naturally — the tutor listens and answers with voice in real time.</p>
                  <button type="button" className="fr-cta" onClick={startLiveTutor} disabled={!currentTopic}>
                    <Icon name="mic" size={16} />Start live session
                  </button>
                  {!currentTopic && <span className="fr-hint">Attach a study plan to pick a topic first.</span>}
                </div>
              ) : (
                <div className="fr-tutor-live">
                  <div className="fr-orb-wrap">
                    <button
                      type="button"
                      className={`tutor-orb${tutorPaused ? ' paused' : tutorStatus === 'speaking' ? ' speaking' : tutorStatus === 'listening' ? ' listening' : ''}`}
                      onClick={toggleTutorPause}
                      disabled={tutorStatus === 'connecting' || tutorStatus === 'error'}
                      title={tutorPaused ? 'Resume' : 'Tap to pause'}
                      aria-label={tutorPaused ? 'Resume tutor' : 'Pause tutor'}
                    >
                      {orbIcon}
                    </button>
                    <div className="fr-orb-label">{tutorLabel}</div>
                    {(tutorStatus === 'listening' || tutorStatus === 'speaking') && (
                      <div className="fr-hint">{tutorPaused ? 'tap the orb to resume' : 'tap the orb to pause'}</div>
                    )}
                  </div>

                  <div className="fr-transcript" ref={transcriptRef}>
                    {tutorTranscript.length === 0 && tutorStatus === 'listening' && (
                      <div className="fr-hint center">Say hello to start!</div>
                    )}
                    {tutorTranscript.map(m => (
                      <div key={m.id} className={`fr-bubble ${m.role}`}>{m.text}</div>
                    ))}
                  </div>

                  <button type="button" className="fr-end" onClick={stopLiveTutor}>
                    <Icon name="stop" size={14} />End session
                  </button>
                </div>
              )
            )}

            {/* ── CHAT TAB ───────────────────────────────────── */}
            {activeTab === 'chat' && (
              <RoomChat roomId={roomId} userId={userId} userProfile={userProfile} />
            )}

            {/* ── QUIZ TAB ───────────────────────────────────── */}
            {activeTab === 'quiz' && (
              <QuizBattle
                roomId={roomId} userId={userId} isHost={isHost}
                userProfile={userProfile} availableTopics={availableTopics}
                onGenerateQuestions={handleGenerateQuestions}
              />
            )}

          </div>
        </section>
      </main>
    </div>
  );
};

export default ForgeRoom;
