/**
 * Forge AI — ForgeRoom.tsx
 *
 * Redesigned to match Deep Dive AI Study Notes aesthetic exactly:
 * - Notes pane uses forge-hub-left / forge-hub-notes-label / notes-content (same as index.tsx)
 * - Right panel uses forge-hub-right / forge-hub-tabs / forge-hub-tab / forge-hub-panel-body
 * - Live tutor: red tappable orb, sequential audio queue, live streaming transcript
 * - AI chat: ensureNotes before chat creation, local state updates immediately
 * - Mic/Cam: Daily.co inits on mount regardless of video visibility
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import MD from './MD';
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

type Props = {
  roomId: string;
  userId: string;
  userProfile: Profile;
  onLeave: () => void;
};

const ForgeRoom: React.FC<Props> = ({ roomId, userId, userProfile, onLeave }) => {

  /* ── state ─────────────────────────────────────────────────── */
  const [room,           setRoom]          = useState<Room | null>(null);
  const [members,        setMembers]       = useState<(RoomMember & { profiles: Profile })[]>([]);
  const [activeTab,      setActiveTab]     = useState<RightPanelTab>('ai');
  const [aiMessages,     setAiMessages]    = useState<(SharedAIMessage & { profiles: Profile })[]>([]);
  const [aiInput,        setAiInput]       = useState('');
  const [isAiLoading,    setIsAiLoading]   = useState(false);
  const [currentTopic,   setCurrentTopic]  = useState<Topic | null>(null);
  const [isCopied,       setIsCopied]      = useState(false);
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
  const aiBottomRef   = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('room_members')
        .select('*, profiles(id, display_name, avatar_color)')
        .eq('room_id', roomId);
      if (data) setMembers(data as any);
    };
    load();
    supabase.from('room_members').upsert({ room_id: roomId, user_id: userId }).then(load);
    const ch = supabase.channel(`room_members:${roomId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` }, load)
      .subscribe();
    return () => {
      supabase.from('room_members').delete().eq('room_id', roomId).eq('user_id', userId);
      supabase.removeChannel(ch);
    };
  }, [roomId, userId]);

  /* ── shared AI messages ────────────────────────────────────── */
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('shared_ai_messages')
        .select('*, profiles(id, display_name, avatar_color)')
        .eq('room_id', roomId)
        .order('created_at', { ascending: true });
      if (data) setAiMessages(data as any);
    };
    load();
    const ch = supabase.channel(`shared_ai:${roomId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shared_ai_messages', filter: `room_id=eq.${roomId}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [roomId]);

  useEffect(() => { aiBottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [aiMessages]);
  useEffect(() => { transcriptRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [tutorTranscript]);

  /* ── Daily.co — init when room has a video URL (Vercel production) ── */
  useEffect(() => {
    if (!room?.daily_room_url) return;
    let frame: any;
    (async () => {
      try {
        const DailyIframe = (await import('@daily-co/daily-js')).default;
        frame = DailyIframe.createFrame(dailyRef.current!, {
          showLeaveButton: false, showFullscreenButton: false,
          iframeStyle: { width: '100%', height: '100%', border: 'none', borderRadius: '10px', display: 'none' },
        });
        frame.join({ url: room.daily_room_url!, userName: userProfile.display_name ?? undefined });
        setCallFrame(frame);
      } catch (e) { console.error('Daily init failed:', e); }
    })();
    return () => { frame?.destroy(); setCallFrame(null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.daily_room_url]);

  useEffect(() => {
    if (!callFrame) return;
    try { callFrame.iframe().style.display = isVideoVisible ? 'block' : 'none'; } catch (_) {}
  }, [isVideoVisible, callFrame]);

  /* ── Sync local cam stream to video element ─────────────────── */
  useEffect(() => {
    if (localVideoRef.current && camStream) {
      localVideoRef.current.srcObject = camStream;
    }
  }, [camStream]);

  /* ── Native mic toggle (works locally + as fallback) ───────────
     If Daily.co callFrame exists use it; otherwise use getUserMedia  */
  const toggleMic = useCallback(async () => {
    if (callFrame) {
      // Daily.co path (production)
      callFrame.setLocalAudio(micMuted); // micMuted=true means currently muted → unmute
      setMicMuted(v => !v);
      return;
    }
    // Native path (local dev)
    if (micStream) {
      micStream.getAudioTracks().forEach(t => t.stop());
      setMicStream(null);
      setMicMuted(true);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        setMicStream(stream);
        setMicMuted(false);
      } catch (e) {
        console.error('Mic access denied:', e);
        alert('Microphone access was denied. Please allow it in your browser settings.');
      }
    }
  }, [callFrame, micStream, micMuted]);

  /* ── Native cam toggle ──────────────────────────────────────── */
  const toggleCam = useCallback(async () => {
    if (callFrame) {
      // Daily.co path (production)
      callFrame.setLocalVideo(camOff); // camOff=true means currently off → turn on
      setCamOff(v => !v);
      return;
    }
    // Native path (local dev)
    if (camStream) {
      camStream.getVideoTracks().forEach(t => t.stop());
      setCamStream(null);
      setCamOff(true);
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        setCamStream(stream);
        setCamOff(false);
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
  const handleAskAI = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiInput.trim() || isAiLoading) return;
    const question = aiInput.trim();
    setAiInput('');
    setIsAiLoading(true);

    const { data: newMsg, error } = await supabase
      .from('shared_ai_messages')
      .insert({ room_id: roomId, asked_by: userId, question })
      .select('*, profiles(id, display_name, avatar_color)')
      .single();

    if (error || !newMsg) { setIsAiLoading(false); return; }

    // Show immediately with "Generating…"
    setAiMessages(prev => [...prev, newMsg as any]);

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
      if (!fullAnswer) fullAnswer = 'No study notes available yet. Generate notes from the study plan first.';
      await supabase.from('shared_ai_messages').update({ answer: fullAnswer }).eq('id', newMsg.id);
      setAiMessages(prev => prev.map(m => m.id === newMsg.id ? { ...m, answer: fullAnswer } : m));
    } catch (err) {
      console.error('Shared AI error:', err);
      const errMsg = 'Something went wrong. Please try again.';
      await supabase.from('shared_ai_messages').update({ answer: errMsg }).eq('id', newMsg.id);
      setAiMessages(prev => prev.map(m => m.id === newMsg.id ? { ...m, answer: errMsg } : m));
    } finally { setIsAiLoading(false); }
  };

  /* ── sequential audio queue ────────────────────────────────── */
  const enqueueAudio = useCallback((b64: string) => {
    audioQueue.current = audioQueue.current.then(async () => {
      const ctx = outCtxRef.current;
      if (!ctx || ctx.state === 'closed') return;
      // Wait if paused
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

      sessionRef.current = session;

      // Mic at 16 kHz
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = micStream;
      micCtxRef.current = new AudioContext({ sampleRate: 16000 });
      const source    = micCtxRef.current.createMediaStreamSource(micStream);
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

  /* ── copy invite ───────────────────────────────────────────── */
  const handleCopyLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}?room=${room?.join_token}`).then(() => {
      setIsCopied(true); setTimeout(() => setIsCopied(false), 2000);
    });
  };

  /* ── quiz ──────────────────────────────────────────────────── */
  const handleGenerateQuestions = useCallback(async (topic: string): Promise<QuizQuestion[]> =>
    apiGeneratePracticeQuiz({ topic, reason: '', key_points: [] }), []);

  /* ── helpers ───────────────────────────────────────────────── */
  const getInitials = (name: string) =>
    name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

  const availableTopics =
    (room?.topic_context as AnalysisResult | null)?.study_these?.map(t => t.topic) ?? [];

  /* ── loading ───────────────────────────────────────────────── */
  if (!room) return (
    <div className="forge-room-loading">
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

  /* ════════════════════════════════════════════════════════════
     RENDER
  ════════════════════════════════════════════════════════════ */
  return (
    <div className="forge-room">

      {/* ── TOP BAR ─────────────────────────────────────────── */}
      <div className="forge-room-topbar">
        <span className="forge-room-logo">⚡ Forge AI</span>
        <div className="forge-room-meta">
          <span className="forge-room-name">{room.name}</span>
          <span className="forge-room-token">#{room.join_token}</span>
          <span className="forge-room-live">
            <span className="forge-live-dot" />{members.length} live
          </span>
        </div>
        <div className="forge-room-topbar-right">
          <button className="forge-tbtn" onClick={handleCopyLink}>
            {isCopied ? '✓ Copied!' : '🔗 Invite'}
          </button>
          <button className="forge-tbtn danger" onClick={onLeave}>Leave room</button>
        </div>
      </div>

      {/* ── PARTICIPANT STRIP ────────────────────────────────── */}
      <div className="forge-strip">
        {members.map(m => {
          const name  = m.profiles?.display_name ?? 'Student';
          const color = (m.profiles?.avatar_color as string | undefined) ?? '#534AB7';
          const isMe  = m.user_id === userId;
          return (
            <div key={m.id} className="forge-participant">
              <div className={`forge-p-ring${isMe ? ' me' : ''}`}
                style={{ borderColor: isMe ? color : 'rgba(255,255,255,0.15)' }}>
                <div className="forge-p-avatar" style={{ background: color + '28', color }}>
                  {getInitials(name)}
                </div>
              </div>
              <span className="forge-p-name">{isMe ? 'You' : name.split(' ')[0]}</span>
            </div>
          );
        })}

        <div className="forge-strip-controls">
          <button
            className={`forge-ctrl${!micMuted ? ' active' : ''}`}
            onClick={toggleMic}
            title={micMuted ? 'Turn mic on' : 'Mute mic'}
          >
            {micMuted ? '🔇 Unmuted' : '🎤 Mic on'}
          </button>
          <button
            className={`forge-ctrl${!camOff ? ' active' : ''}`}
            onClick={toggleCam}
            title={camOff ? 'Turn camera on' : 'Turn camera off'}
          >
            {camOff ? '📷 Cam off' : '📷 Cam on'}
          </button>

        </div>
      </div>

      {/* Daily.co container — used in production (Vercel) */}
      <div ref={dailyRef} style={{
        height: isVideoVisible && room.daily_room_url ? 200 : 0,
        margin: isVideoVisible && room.daily_room_url ? '0 16px 6px' : 0,
        borderRadius: 10, overflow: 'hidden', flexShrink: 0,
        border: isVideoVisible && room.daily_room_url ? '1px solid rgba(255,255,255,0.07)' : 'none',
        transition: 'height 0.2s ease',
      }} />

      {/* Native local cam preview — used locally without Daily.co */}
      {camStream && !room.daily_room_url && (
        <div style={{ margin: '0 16px 6px', borderRadius: 10, overflow: 'hidden', flexShrink: 0, height: 180, background: '#000', border: '1px solid rgba(255,255,255,0.07)', position: 'relative' }}>
          <video
            ref={localVideoRef}
            autoPlay muted playsInline
            style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 10 }}
          />
          <div style={{ position: 'absolute', bottom: 8, left: 12, fontSize: 11, color: 'rgba(255,255,255,0.6)', background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: 10 }}>
            {userProfile.display_name ?? 'You'} (local preview)
          </div>
        </div>
      )}

      {/* ── MAIN BODY — mirrors Deep Dive forge-hub-layout ── */}
      <div className="forge-room-body">

        {/* LEFT: Study Notes — uses same card as Deep Dive */}
        <div className="forge-hub-left forge-room-notes-card">
          <div className="forge-room-notes-top">
            <span className="forge-hub-notes-label">AI Study Notes</span>
            {availableTopics.length > 1 && (
              <select
                className="forge-topic-select"
                value={currentTopic?.topic ?? ''}
                onChange={e => {
                  const t = (room.topic_context as AnalysisResult).study_these
                    .find(t => t.topic === e.target.value);
                  if (t) setCurrentTopic(t);
                }}
              >
                {availableTopics.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
            {notesLoading && (
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                <span className="loading-spinner small-inline" />Generating notes…
              </span>
            )}
          </div>

          <div className="forge-room-notes-scroll">
            {currentTopic?.notes
              ? <MD text={currentTopic.notes} className="notes-content" />
              : <div className="forge-notes-empty">
                  {notesLoading ? 'Generating study notes…'
                    : currentTopic ? 'No notes yet — ask the AI a question to trigger generation.'
                    : 'No study materials attached. Ask the AI anything!'}
                </div>
            }
          </div>
        </div>

        {/* RIGHT: Tabbed panel — uses same card + tabs as Deep Dive */}
        <div className="forge-hub-right">

          {/* Tabs: AI | Live Tutor | Chat | Quiz */}
          <div className="forge-hub-tabs">
            {([
              { id: 'ai',    label: '🤖 AI'        },
              { id: 'tutor', label: '🎙 Live Tutor' },
              { id: 'chat',  label: '💬 Chat'       },
              { id: 'quiz',  label: '🏆 Quiz'       },
            ] as { id: RightPanelTab; label: string }[]).map(tab => (
              <button
                key={tab.id}
                className={`forge-hub-tab${activeTab === tab.id ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="forge-hub-panel-body">

            {/* ── AI TAB ────────────────────────────────────── */}
            {activeTab === 'ai' && (
              <div className="forge-ai-panel">
                <div className="forge-ai-header">
                  <span>🤖 Shared AI tutor</span>
                  <span className="forge-ai-badge">Everyone sees this</span>
                </div>
                <div className="forge-ai-messages">
                  {aiMessages.length === 0 && (
                    <div className="forge-ai-empty">
                      Ask anything about your topic — the whole room sees the answer.
                    </div>
                  )}
                  {aiMessages.map(msg => (
                    <div key={msg.id} className="forge-ai-entry">
                      <div className="forge-ai-q">
                        <span className="forge-ai-asker">
                          {msg.profiles?.display_name ?? 'Student'} asked
                        </span>
                        {msg.question}
                      </div>
                      <div className="forge-ai-a">
                        {msg.answer
                          ? <MD text={msg.answer} />
                          : <span className="forge-ai-generating">
                              <span className="loading-spinner small-inline" style={{ marginRight: 5 }} />
                              Generating answer…
                            </span>
                        }
                      </div>
                    </div>
                  ))}
                  <div ref={aiBottomRef} />
                </div>
                <form className="forge-ai-form" onSubmit={handleAskAI}>
                  <input
                    className="forge-ai-input"
                    placeholder={currentTopic ? `Ask about ${currentTopic.topic}…` : 'Ask anything…'}
                    value={aiInput}
                    onChange={e => setAiInput(e.target.value)}
                    disabled={isAiLoading}
                  />
                  <button type="submit" className="forge-ai-send"
                    disabled={!aiInput.trim() || isAiLoading}
                    style={{ opacity: (!aiInput.trim() || isAiLoading) ? 0.4 : 1 }}
                  >
                    {isAiLoading ? '…' : '↑'}
                  </button>
                </form>
              </div>
            )}

            {/* ── LIVE TUTOR TAB ─────────────────────────────── */}
            {activeTab === 'tutor' && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                {tutorStatus === 'idle' ? (
                  /* Start screen — identical to Deep Dive tutor tab */
                  <div className="forge-tutor-tab">
                    <div className="forge-tutor-icon">🎙️</div>
                    <p className="forge-tutor-title">Live AI Tutor</p>
                    <p className="forge-tutor-sub">
                      Speak naturally — the tutor listens and responds with voice in real-time.
                      The whole room can follow along.
                    </p>
                    <button className="forge-tutor-btn" onClick={startLiveTutor} disabled={!currentTopic}>
                      🎙️ Start live session
                    </button>
                    {!currentTopic && (
                      <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>Select a topic first</p>
                    )}
                  </div>
                ) : (
                  /* Active session */
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '16px 14px', gap: 12, overflow: 'hidden' }}>

                    {/* Red tappable orb */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, paddingTop: 8 }}>
                      <button
                        className={`tutor-orb${tutorPaused ? ' paused' : tutorStatus === 'speaking' ? ' speaking' : tutorStatus === 'listening' ? ' listening' : ''}`}
                        onClick={toggleTutorPause}
                        disabled={tutorStatus === 'connecting' || tutorStatus === 'error'}
                        title={tutorPaused ? 'Resume' : 'Tap to pause'}
                        style={{ border: 'none', padding: 0, cursor: 'pointer' }}
                      >
                        {orbIcon}
                      </button>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                        {tutorLabel}
                      </div>
                      {(tutorStatus === 'listening' || tutorStatus === 'speaking') && (
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', opacity: 0.65 }}>
                          {tutorPaused ? 'tap orb to resume' : 'tap orb to pause'}
                        </div>
                      )}
                    </div>

                    {/* Live transcript */}
                    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
                      {tutorTranscript.length === 0 && tutorStatus === 'listening' && (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', fontStyle: 'italic', paddingTop: 12 }}>
                          Say hello to start!
                        </div>
                      )}
                      {tutorTranscript.map((m, i) => (
                        <div key={i} style={{
                          padding: '7px 12px', borderRadius: 10, fontSize: 12, lineHeight: 1.5,
                          maxWidth: '90%',
                          background: m.role === 'user' ? 'rgba(83,74,183,0.28)' : 'rgba(255,255,255,0.05)',
                          color: m.role === 'user' ? '#c4bcff' : 'var(--text-secondary)',
                          alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                        }}>
                          {m.text}
                        </div>
                      ))}
                      <div ref={transcriptRef} />
                    </div>

                    {/* End session */}
                    <button onClick={stopLiveTutor} style={{
                      padding: '8px 20px', borderRadius: 20, alignSelf: 'center',
                      border: '1px solid rgba(231,76,60,0.4)', background: 'rgba(231,76,60,0.1)',
                      color: '#ff8080', fontSize: 12, cursor: 'pointer',
                    }}>
                      ⏹ End session
                    </button>
                  </div>
                )}
              </div>
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
        </div>
      </div>
    </div>
  );
};

export default ForgeRoom;