/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forge AI — index.tsx
 * Built directly on CrammAI. All original logic is preserved.
 * Added: Supabase auth, room routing, redesigned UI.
 *
 * FIXES APPLIED:
 * 1. Removed duplicate inline MD component — now uses imported MD from './components/MD'
 * 2. finishQuiz derives score from (total - wrong.length) to avoid stale setState bug
 * 3. ResultsPage case guards against null mode before rendering (no more mode!)
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import type { LiveServerMessage, Chat } from '@google/genai';
import {
  apiGenerateStudyPlan,
  apiGenerateStudyNotes,
  apiGenerateMnemonic,
  apiGeneratePracticeQuiz,
  apiGenerateQuizReflection,
  apiCreateChatForTopic,
  apiChatWithDocumentsStream,
  apiConnectLiveTutor,
  apiFetchYoutubeTranscript,
  createBlob,
  decode,
  decodeAudioData,
} from './api';
import type { Mode, Topic, AnalysisResult, MnemonicResult, QuizQuestion, ChatMessage } from './api';
import { supabase } from './supabase/client';
import type { Profile } from './supabase/client';
import AuthPage from './components/AuthPage';
import ForgeRoom from './components/ForgeRoom';
import MD from './components/MD'; // ✅ FIX 1: import from shared component — duplicate inline MD removed below
import type { User } from '@supabase/supabase-js';

// ── Types ────────────────────────────────────────────────────
type AppView = 'home' | 'upload' | 'loading' | 'results' | 'study' | 'quiz' | 'quiz-summary' | 'room-lobby' | 'room';

type TranscriptMessage = { role: 'user' | 'model' | 'status'; text: string; id: number };
type StoredFile = { name: string; size: number; type: string };
type HistoryItem = {
  id: string;
  timestamp: number;
  mode: Mode;
  files: StoredFile[];
  youtubeUrl?: string;
  analysis: AnalysisResult;
};

// ── Constants ────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = [
  'application/pdf','text/plain','image/jpeg','image/png',
  'image/gif','image/webp','audio/mpeg','audio/mp3',
  'audio/wav','audio/mp4','audio/x-m4a',
];
const MAX_AUDIO = 20 * 1024 * 1024;
const MAX_DEFAULT = 10 * 1024 * 1024;

// ── Helpers ──────────────────────────────────────────────────
const getStatus = (mode: Mode | null) => {
  if (!mode) return { themeClass: 'theme-neutral', primary: 'var(--crammai-calm-primary)', darkBg: 'var(--crammai-calm-dark)', statusText: '', encouragement: '', modeTitle: '', icon: '' };
  switch (mode) {
    case 'zoom': return { themeClass: 'theme-zoom', primary: 'var(--crammai-zoom-primary)', darkBg: 'var(--crammai-zoom-dark)', statusText: 'ZOOM MODE ACTIVATED', encouragement: 'Time for a strategic attack.', modeTitle: 'Zoom Mode', icon: '⚡' };
    case 'warn': return { themeClass: 'theme-warn', primary: 'var(--crammai-warning-primary)', darkBg: 'var(--crammai-warning-dark)', statusText: 'TURBO MODE ENGAGED', encouragement: 'Time to block out distractions.', modeTitle: 'Turbo Mode', icon: '🚀' };
    default: return { themeClass: 'theme-calm', primary: 'var(--crammai-calm-primary)', darkBg: 'var(--crammai-calm-dark)', statusText: 'CRUISE CONTROL INITIATED', encouragement: "Plenty of time — let's get started.", modeTitle: 'Cruise Control', icon: '🧘' };
  }
};

const fmtSize = (b: number) => {
  if (!b) return '0 Bytes';
  const k = 1024, s = ['Bytes','KB','MB'], i = Math.floor(Math.log(b) / Math.log(k));
  return `${parseFloat((b / Math.pow(k, i)).toFixed(2))} ${s[i]}`;
};

const fileIcon = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return '📄';
  if (ext === 'txt') return '📋';
  if (['jpg','jpeg','png','gif'].includes(ext ?? '')) return '🖼️';
  if (['mp3','wav','m4a'].includes(ext ?? '')) return '🎧';
  return '📁';
};

const truncate = (name: string, max = 20) => {
  if (name.length <= max) return name;
  const i = name.lastIndexOf('.');
  const ext = i !== -1 ? name.slice(i) : '';
  return `${name.slice(0, max - 5 - ext.length)}...${ext}`;
};

// ── BackgroundEffects ────────────────────────────────────────
const BackgroundEffects = ({ mode }: { mode: Mode | null }) => {
  const tc = getStatus(mode).themeClass;
  const particles = useMemo(() => {
    const count = tc === 'theme-zoom' ? 50 : tc === 'theme-neutral' ? 0 : 20;
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      left: `${Math.random() * 100}%`,
      size: `${Math.random() * 3 + 1}px`,
      dur: `${Math.random() * 10 + (tc === 'theme-zoom' ? 2 : 15)}s`,
      delay: `${Math.random() * -25}s`,
      opacity: tc === 'theme-zoom' ? Math.random() * 0.3 + 0.1 : Math.random() * 0.5 + 0.2,
    }));
  }, [tc]);
  const lines = useMemo(() => {
    if (tc !== 'theme-warn') return [];
    return Array.from({ length: 10 }, (_, i) => ({
      id: i,
      width: `${Math.random() * 30 + 20}vw`,
      top: `${Math.random() * 120 - 10}%`,
      left: `${Math.random() * 120 - 10}%`,
      dur: `${Math.random() * 1 + 0.5}s`,
      delay: `${Math.random() * -1.5}s`,
    }));
  }, [tc]);
  return (
    <div id="background-animations" aria-hidden="true">
      {(tc === 'theme-calm' || tc === 'theme-zoom') && particles.map(p => (
        <div key={p.id} className="particle" style={{ left: p.left, width: p.size, height: p.size, animationDuration: p.dur, animationDelay: p.delay, opacity: p.opacity }} />
      ))}
      {tc === 'theme-warn' && lines.map(l => (
        <div key={l.id} className="line" style={{ width: l.width, top: l.top, left: l.left, animationDuration: l.dur, animationDelay: l.delay }} />
      ))}
    </div>
  );
};

// ── Upload slot ──────────────────────────────────────────────
interface SlotProps {
  file: File | null; index: number; isActive: boolean;
  onDrop: (f: File, i: number) => void;
  onChange: (f: File, i: number) => void;
  onRemove: (i: number) => void;
}
const UploadSlot: React.FC<SlotProps> = ({ file, index, isActive, onDrop, onChange, onRemove }) => {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const stop = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  return (
    <div
      className={`upload-slot ${file ? 'filled' : 'empty'} ${isActive && !file ? 'active' : ''} ${over ? 'drag-over' : ''}`}
      onDragOver={e => { stop(e); setOver(true); }}
      onDragLeave={e => { stop(e); setOver(false); }}
      onDrop={e => { stop(e); setOver(false); const f = e.dataTransfer.files[0]; if (f) onDrop(f, index); }}
    >
      <input type="file" ref={ref} onChange={e => { if (e.target.files?.[0]) { onChange(e.target.files[0], index); e.target.value = ''; } }} aria-hidden="true" />
      {file ? (
        <div className="file-preview-container">
          <div className="file-icon">{fileIcon(file.name)}</div>
          <div className="file-name" title={file.name}>{truncate(file.name)}</div>
          <div className="file-size">{fmtSize(file.size)}</div>
          <button className="remove-button" onClick={e => { e.stopPropagation(); onRemove(index); }}>&times;</button>
        </div>
      ) : (
        <div className="empty-slot-content" onClick={() => ref.current?.click()} role="button" tabIndex={0}>
          <div className="slot-number">{index + 1}</div>
          <div className="slot-text">Drop file or click</div>
        </div>
      )}
    </div>
  );
};

// ── NOTE: MD component is imported from './components/MD' ────
// ── The inline MD definition has been removed (Fix 1) ────────

// ── Loading page ─────────────────────────────────────────────
const LoadingPage = ({ mode }: { mode: Mode | null }) => {
  const quotes = useMemo(() => [
    '"The secret of getting ahead is getting started." — Mark Twain',
    '"Success is not final, failure is not fatal." — Churchill',
    '"Believe you can and you\'re halfway there." — Roosevelt',
    '"The harder I work, the more luck I seem to have." — Jefferson',
  ], []);
  const [q, setQ] = useState(quotes[0]);
  useEffect(() => {
    let i = 0;
    const t = setInterval(() => { i = (i + 1) % quotes.length; setQ(quotes[i]); }, 4000);
    return () => clearInterval(t);
  }, [quotes]);
  return (
    <div className="loading-view">
      <div className="loading-spinner" />
      <div className="loading-text">Forge AI is thinking</div>
      <p className="loading-quote">{q}</p>
    </div>
  );
};

// ── HomePage ─────────────────────────────────────────────────
const HomePage = ({ onSelectMode, onOpenRoom }: { onSelectMode: (m: Mode) => void; onOpenRoom: () => void }) => (
  <section className="view-container">
    <header className="page-header">
      <h1>Study smarter. Together.</h1>
      <p className="subtitle">Pick your mode to start, or jump into a room with friends.</p>
    </header>

    <div className="forge-mode-row">
      {([
        { mode: 'calm' as Mode, icon: '🧘', label: 'Cruise control', sub: '1+ week until exam' },
        { mode: 'warn' as Mode, icon: '🚀', label: 'Turbo mode',     sub: '2 days left' },
        { mode: 'zoom' as Mode, icon: '⚡', label: 'Zoom mode',      sub: 'Due tonight' },
      ]).map(({ mode, icon, label, sub }) => (
        <button key={mode} className={`forge-mode-card ${mode}`} onClick={() => onSelectMode(mode)}>
          <span className="forge-mode-icon">{icon}</span>
          <span className="forge-mode-label">{label}</span>
          <span className="forge-mode-sub">{sub}</span>
        </button>
      ))}
    </div>

    <div className="forge-room-cta">
      <div className="forge-room-cta-text">
        <strong>Study with friends</strong>
        <span>Video call + shared AI tutor + live quiz battles</span>
      </div>
      <button className="forge-room-cta-btn" onClick={onOpenRoom}>⚡ Start a Forge Room</button>
    </div>
  </section>
);

// ── UploadPage ───────────────────────────────────────────────
const UploadPage = ({
  mode, files, youtubeUrl, setYoutubeUrl,
  onBack, addFile, onRemoveFile, onGeneratePlan, onOpenRoom,
}: {
  mode: Mode; files: (File | null)[]; youtubeUrl: string;
  setYoutubeUrl: (u: string) => void; onBack: () => void;
  addFile: (f: File, i: number) => void; onRemoveFile: (i: number) => void;
  onGeneratePlan: () => void; onOpenRoom: () => void;
}) => {
  const { statusText, encouragement, icon } = getStatus(mode);
  const activeSlot = files.findIndex(f => f === null);
  const disabled = files.every(f => f === null) && !youtubeUrl.trim();
  return (
    <section className="view-container">
      <header className="upload-page-header">
        <button className="back-button" onClick={onBack}>&larr; Change Mode</button>
        <div className="status-message">
          <div className="status-text">{icon} {statusText}</div>
          <div className="status-subtext">{encouragement}</div>
        </div>
      </header>

      <div className="upload-section">
        <h2 className="upload-title">Drop your top 3 study materials</h2>
        <div className="upload-slots">
          {files.map((file, i) => (
            <UploadSlot key={i} file={file} index={i} isActive={i === activeSlot}
              onDrop={addFile} onChange={addFile} onRemove={onRemoveFile} />
          ))}
        </div>

        <div className="youtube-upload-section">
          <h3 className="youtube-upload-title">Or paste a YouTube URL 🎬</h3>
          <div className="forge-yt-row">
            <input className="youtube-input" type="text"
              placeholder="https://www.youtube.com/watch?v=..."
              value={youtubeUrl} onChange={e => setYoutubeUrl(e.target.value)} />
          </div>
        </div>

        <div className="smart-suggestions">
          <div className="suggestion-title">💡 What should you upload?</div>
          <div className="suggestions">
            <div className="suggestion">📋 Course syllabus (most important!)</div>
            <div className="suggestion">📝 Class notes or lecture recording</div>
            <div className="suggestion">📄 Past exam or practice test</div>
          </div>
          <div className="suggestion-note">Supported: PDF, TXT, JPG, PNG, MP3, WAV. Max 20 MB audio, 10 MB other.</div>
        </div>

        <div className="forge-action-bar">
          <button className="generate-button" disabled={disabled} onClick={onGeneratePlan}>
            ⚡ Generate Study Plan
          </button>
          <button className="forge-secondary-btn" onClick={onOpenRoom}>👥 Study with Friends</button>
        </div>
      </div>
    </section>
  );
};

// ── ResultsPage ──────────────────────────────────────────────
const ResultsPage = ({
  analysis, mode, onStudyTopic, onStartQuiz, onReset,
  highlightedTopic, setHighlightedTopic, onRetryNotes, onOpenRoom,
}: {
  analysis: AnalysisResult | null; mode: Mode;
  onStudyTopic: (t: Topic) => void; onStartQuiz: (t: Topic) => void;
  onReset: () => void; highlightedTopic: string | null;
  setHighlightedTopic: (n: string | null) => void;
  onRetryNotes: (t: Topic) => void; onOpenRoom: () => void;
}) => {
  const hlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlightedTopic && hlRef.current) {
      hlRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const t = setTimeout(() => setHighlightedTopic(null), 3000);
      return () => clearTimeout(t);
    }
  }, [highlightedTopic, setHighlightedTopic]);

  if (!analysis?.study_these?.length) {
    return (
      <section className="results-view empty-results">
        <h1 className="results-title">Analysis Complete</h1>
        <p>Couldn't identify specific topics. Try uploading a syllabus!</p>
        <button className="reset-button" onClick={onReset}>Start Over</button>
      </section>
    );
  }

  return (
    <section className="results-view">
      <header className="results-header">
        <h1 className="results-title">{getStatus(mode).modeTitle} Study Plan</h1>
        <p className="results-subtitle">Prioritised to maximise your score.</p>
      </header>

      <div className="triage-category">
        <h2 className="triage-category-title">Focus on these topics</h2>
        <div className="topic-list">
          {analysis.study_these.map((topic, i) => {
            const hl = topic.topic === highlightedTopic;
            return (
              <div
                key={i}
                ref={hl ? hlRef : null}
                className={`forge-topic-row ${hl ? 'highlighted' : ''}`}
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="forge-topic-num">{i + 1}</div>
                <div className="forge-topic-body">
                  <div className="forge-topic-name">{topic.topic}</div>
                  <div className="forge-topic-reason">{topic.reason}</div>
                </div>
                <div className="forge-topic-actions">
                  {topic.notes === undefined ? (
                    <button className="forge-topic-btn" disabled>
                      Generating <span className="loading-spinner small-inline" />
                    </button>
                  ) : topic.notes.startsWith('Error:') ? (
                    <button className="forge-topic-btn" onClick={() => onRetryNotes(topic)}>Retry 🔄</button>
                  ) : (
                    <button className="forge-topic-btn primary" onClick={() => onStudyTopic(topic)}>Deep Dive →</button>
                  )}
                  <button className="forge-topic-btn" onClick={() => onStartQuiz(topic)}>Quiz 🧠</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="forge-results-room-bar">
        <div>
          <div className="forge-results-room-label">👥 Study with your group</div>
          <div className="forge-results-room-sub">Create a room — friends join with one link, video + AI included</div>
        </div>
        <button className="forge-results-room-btn" onClick={onOpenRoom}>⚡ Create Forge Room</button>
      </div>

      <button className="reset-button" onClick={onReset}>Start Over</button>
    </section>
  );
};

// ── MnemonicStudio ────────────────────────────────────────────
const MnemonicStudio = ({ topic, onUpdate }: { topic: Topic; onUpdate: (t: Topic) => void }) => {
  const [input, setInput] = useState(topic.topic);
  const [mnemonic, setMnemonic] = useState<MnemonicResult | null>(topic.mnemonic ?? null);
  const [genFor, setGenFor] = useState<string | null>(topic.mnemonic ? topic.topic : null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const generate = async (t: string) => {
    if (!t.trim()) { setErr('Enter a topic.'); return; }
    setLoading(true); setErr(null);
    try {
      const prev = mnemonic && genFor === t ? mnemonic.mnemonic_word : undefined;
      const { mnemonic_result } = await apiGenerateMnemonic(t, prev);
      const result = { ...mnemonic_result, title: `Mnemonic for ${t}` };
      setMnemonic(result); setGenFor(t);
      if (t.toLowerCase() === topic.topic.toLowerCase()) onUpdate({ ...topic, mnemonic: result });
    } catch { setErr('Could not generate — try again.'); }
    finally { setLoading(false); }
  };

  if (loading) return <div className="mnemonic-loader-full" />;

  return (
    <div className="mnemonic-studio-inline">
      {!mnemonic ? (
        <>
          <textarea className="mnemonic-input" value={input} onChange={e => setInput(e.target.value)} rows={2} placeholder="Enter a topic or idea..." />
          {err && <div className="error-message">{err}</div>}
          <button className="generate-button generate-mnemonic-button" disabled={!input.trim()} onClick={() => generate(input)}>Generate Mnemonic</button>
        </>
      ) : (
        <div className="mnemonic-result">
          <div className="mnemonic-word">{mnemonic.mnemonic_word} 🌟</div>
          <p className="mnemonic-explanation">– {mnemonic.description}</p>
          <ul className="mnemonic-mapping-list">{mnemonic.breakdown.map((b, i) => <li key={i}>{b.replace('=', '–')}</li>)}</ul>
          <div className="mnemonic-actions">
            <button className="generate-button generate-mnemonic-button" onClick={() => generate(genFor!)}>Try Another</button>
            <button className="generate-button generate-mnemonic-button secondary" onClick={() => { setMnemonic(null); setGenFor(null); }}>New One</button>
          </div>
        </div>
      )}
    </div>
  );
};

// ── ChatStudio ────────────────────────────────────────────────
const ChatStudio = ({ topic }: { topic: Topic }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: 'model', text: "I've reviewed the notes. Ask me anything!" }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [imgFile, setImgFile] = useState<File | null>(null);
  const [imgPreview, setImgPreview] = useState<string | null>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [init, setInit] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setInit(true); setChat(apiCreateChatForTopic(topic)); setInit(false); }, [topic]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const clearImg = () => { setImgFile(null); setImgPreview(null); if (imgRef.current) imgRef.current.value = ''; };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && !imgFile) || loading || !chat) return;
    const cur = input, curImg = imgFile;
    setMessages(prev => [...prev, { role: 'user', text: input, imageUrl: imgPreview ?? undefined }, { role: 'model', text: '' }]);
    setInput(''); clearImg(); setLoading(true);
    try {
      const stream = await apiChatWithDocumentsStream(chat, cur, curImg ?? undefined);
      for await (const chunk of stream) {
        const t = chunk.text ?? '';
        setMessages(prev => { const last = prev[prev.length - 1]; return [...prev.slice(0, -1), { ...last, text: last.text + t }]; });
      }
    } catch {
      setMessages(prev => { const last = prev[prev.length - 1]; return [...prev.slice(0, -1), { ...last, text: last.text + '\n\n**Sorry, could not get a response.**' }]; });
    } finally { setLoading(false); }
  };

  const disabled = loading || init || !chat;

  return (
    <div className="forge-chat-panel">
      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}`}>
            {msg.imageUrl && <img src={msg.imageUrl} alt="upload" className="chat-image" />}
            {msg.text && <MD text={msg.text} />}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {imgPreview && (
        <div className="chat-image-preview-container">
          <img src={imgPreview} alt="preview" className="chat-image-preview" />
          <button className="chat-remove-image-button" onClick={clearImg}>&times;</button>
        </div>
      )}
      <form className="chat-input-form" onSubmit={submit}>
        <input type="file" ref={imgRef} accept="image/*" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f && f.size <= MAX_DEFAULT) { setImgFile(f); const r = new FileReader(); r.onloadend = () => setImgPreview(r.result as string); r.readAsDataURL(f); } }} />
        <button type="button" className="attach-button" onClick={() => imgRef.current?.click()} disabled={disabled} aria-label="Attach image">🖼️</button>
        <input type="text" value={input} onChange={e => setInput(e.target.value)} placeholder={init ? 'Initialising...' : 'Ask about the notes...'} disabled={disabled} />
        <button type="submit" disabled={disabled || (!input.trim() && !imgFile)}>Send</button>
      </form>
    </div>
  );
};

// ── Inline quiz panel ─────────────────────────────────────────
const InlineQuiz = ({ topic }: { topic: Topic }) => {
  const [qs, setQs] = useState<QuizQuestion[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const start = async () => {
    setLoading(true);
    try { const q = await apiGeneratePracticeQuiz(topic); setQs(q); setIdx(0); setScore(0); setPicked(null); setDone(false); }
    catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  if (!qs) return (
    <div className="inline-quiz-start">
      <div style={{ fontSize: 32 }}>🧠</div>
      <p className="inline-quiz-label">Test yourself on this topic</p>
      <button className="inline-quiz-btn" onClick={start} disabled={loading || !topic.notes}>
        {loading ? 'Generating...' : 'Start Quiz'}
      </button>
    </div>
  );

  if (done) {
    const pct = Math.round(score / qs.length * 100);
    return (
      <div className="inline-quiz-done">
        <div style={{ fontSize: 28 }}>{pct === 100 ? '🏆' : pct >= 60 ? '👍' : '📖'}</div>
        <p className="inline-quiz-label">{score}/{qs.length} — {pct}%</p>
        <button className="inline-quiz-btn" onClick={start}>Try again</button>
      </div>
    );
  }

  const q = qs[idx];
  const cls = (opt: string) => {
    if (!picked) return 'inline-quiz-opt';
    if (opt === q.correct_answer) return 'inline-quiz-opt correct';
    if (opt === picked) return 'inline-quiz-opt wrong';
    return 'inline-quiz-opt dimmed';
  };

  return (
    <div className="inline-quiz">
      <div className="inline-quiz-meta">Q {idx + 1}/{qs.length} · Score: {score}</div>
      <div className="inline-quiz-q">{q.question}</div>
      <div className="inline-quiz-opts">
        {q.options.map((opt, i) => (
          <button key={i} className={cls(opt)} disabled={!!picked}
            onClick={() => { setPicked(opt); if (opt === q.correct_answer) setScore(s => s + 1); }}>
            {opt}
          </button>
        ))}
      </div>
      {picked && (
        <>
          <div className="inline-quiz-explain">{q.explanation}</div>
          <button className="inline-quiz-next" onClick={() => { if (idx < qs.length - 1) { setIdx(i => i + 1); setPicked(null); } else setDone(true); }}>
            {idx < qs.length - 1 ? 'Next →' : 'See results'}
          </button>
        </>
      )}
    </div>
  );
};

// ── StudyPage ─────────────────────────────────────────────────
type HubTab = 'chat' | 'tutor' | 'quiz';

const StudyPage = ({ topic, onBack, onUpdate, onStartTutor }: {
  topic: Topic; onBack: () => void;
  onUpdate: (t: Topic) => void; onStartTutor: (t: Topic) => void;
}) => {
  const [tab, setTab] = useState<HubTab>('chat');
  const [mnemonicOpen, setMnemonicOpen] = useState(false);

  return (
    <section className="forge-study-hub">
      <header className="study-page-header">
        <button className="back-button" onClick={onBack}>&larr; Back to Plan</button>
        <h1 className="forge-hub-title">{topic.topic}</h1>
        <p className="forge-hub-sub">{topic.reason}</p>
      </header>

      <div className="forge-hub-layout">
        {/* Left: notes */}
        <div className="forge-hub-left">
          <div className="forge-hub-notes-label">AI Study Notes</div>
          {!topic.notes ? (
            <div className="notes-loader"><div className="loading-spinner small" /><span>Loading...</span></div>
          ) : (
            <>
              <MD text={topic.notes} className="notes-content" />

              {/* Mnemonic collapsible chip */}
              <div className="forge-mnemonic-section">
                <button className="forge-mnemonic-chip" onClick={() => setMnemonicOpen(o => !o)}>
                  ✨ Memory trick {mnemonicOpen ? '▲' : '▼'}
                </button>
                {mnemonicOpen && (
                  <div className="forge-mnemonic-body">
                    <MnemonicStudio topic={topic} onUpdate={onUpdate} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right: tab panel */}
        <div className="forge-hub-right">
          <div className="forge-hub-tabs">
            {(['chat', 'tutor', 'quiz'] as HubTab[]).map(t => (
              <button key={t} className={`forge-hub-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                {t === 'chat' ? '💬 Chat' : t === 'tutor' ? '🎙️ Live Tutor' : '🧠 Quiz Me'}
              </button>
            ))}
          </div>

          <div className="forge-hub-panel-body">
            {tab === 'chat' && <ChatStudio topic={topic} />}
            {tab === 'tutor' && (
              <div className="forge-tutor-tab">
                <div className="forge-tutor-icon">🤖</div>
                <p className="forge-tutor-title">Live AI Tutor</p>
                <p className="forge-tutor-sub">Speak naturally — the tutor listens and responds with voice in real-time.</p>
                <button className="forge-tutor-btn" onClick={() => onStartTutor(topic)}>🎙️ Start live session</button>
              </div>
            )}
            {tab === 'quiz' && <InlineQuiz topic={topic} />}
          </div>
        </div>
      </div>
    </section>
  );
};

// ── QuizPage ──────────────────────────────────────────────────
const QuizPage = ({ topic, questions, onBack, onFinish }: {
  topic: Topic; questions: QuizQuestion[];
  onBack: () => void;
  onFinish: (score: number, total: number, wrong: QuizQuestion[]) => void;
}) => {
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [wrong, setWrong] = useState<QuizQuestion[]>([]);
  const q = questions[idx];

  const pick = (opt: string) => {
    if (picked) return;
    setPicked(opt);
    if (opt === q.correct_answer) setScore(s => s + 1);
    else setWrong(w => [...w, q]);
  };

  const next = () => {
    if (idx < questions.length - 1) { setIdx(i => i + 1); setPicked(null); }
    else onFinish(score, questions.length, wrong);
  };

  const cls = (opt: string) => {
    if (!picked) return '';
    if (opt === q.correct_answer) return 'correct';
    if (opt === picked) return 'incorrect';
    return 'disabled';
  };

  return (
    <section className="quiz-view view-container">
      <header className="quiz-header">
        <button className="back-button" onClick={onBack}>&larr; Back</button>
        <div className="quiz-progress">Q {idx + 1}/{questions.length}</div>
        <div className="quiz-score">Score: {score}</div>
      </header>
      <h1 className="study-topic-title">Quiz: {topic.topic}</h1>
      <div className="quiz-card">
        <h2 className="quiz-question">{q.question}</h2>
        <div className="quiz-options">
          {q.options.map((opt, i) => (
            <button key={i} className={`quiz-option ${cls(opt)}`} onClick={() => pick(opt)} disabled={!!picked}>{opt}</button>
          ))}
        </div>
        {picked && <div className="quiz-explanation"><p><strong>Explanation:</strong> {q.explanation}</p></div>}
      </div>
      {picked && <button className="quiz-next-button" onClick={next}>{idx < questions.length - 1 ? 'Next' : 'Finish'} →</button>}
    </section>
  );
};

// ── QuizSummaryPage ───────────────────────────────────────────
const QuizSummary = ({ topic, score, total, reflection, onRetry, onBack }: {
  topic: Topic; score: number; total: number; reflection: string; onRetry: () => void; onBack: () => void;
}) => {
  const pct = total > 0 ? Math.round(score / total * 100) : 0;
  const msg = pct === 100 ? "Perfect! You've mastered this topic." : pct >= 80 ? 'Excellent work!' : pct >= 60 ? 'Good effort — a bit more review will help.' : "You're building a foundation. Try again!";
  return (
    <section className="quiz-summary-view view-container">
      <header className="page-header"><h1>Quiz Results: {topic.topic}</h1></header>
      <div className="summary-card">
        <div className="summary-score-container"><div className="summary-score">{score}/{total}</div><div className="summary-accuracy">{pct}% Accuracy</div></div>
        <p className="summary-message">{msg}</p>
        <div className="summary-reflection"><h2 className="reflection-title">💡 Reflection</h2><p className="reflection-text">{reflection}</p></div>
        <div className="summary-actions">
          <button className="summary-button primary" onClick={onRetry}>Try Again</button>
          <button className="summary-button secondary" onClick={onBack}>Back to Plan</button>
        </div>
      </div>
    </section>
  );
};

// ── LiveTutorView ─────────────────────────────────────────────
const LiveTutorView = ({ topic, onEnd }: { topic: Topic; onEnd: () => void }) => {
  const [status,   setStatus]   = useState<'connecting'|'connected'|'error'|'disconnected'>('connecting');
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [speaking,   setSpeaking]   = useState(false);
  const [paused,     setPaused]     = useState(false);  // ← pause/resume state

  // Refs that must survive re-renders without causing them
  const sessionRef  = useRef<any>(null);
  const inCtxRef    = useRef<AudioContext | null>(null);
  const outCtxRef   = useRef<AudioContext | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const nodesRef    = useRef<{ src?: MediaStreamAudioSourceNode; proc?: ScriptProcessorNode }>({});

  // ── FIX 1: Audio queue ──────────────────────────────────────
  // A single promise chain ensures chunks play one-after-another,
  // never in parallel, regardless of how fast onmessage fires.
  const audioQueueRef = useRef<Promise<void>>(Promise.resolve());
  const nextStartRef  = useRef<number>(0);

  // ── FIX 2: Pending transcript ───────────────────────────────
  // outputAudioTranscription text arrives alongside audio chunks.
  // We buffer it and only commit it to the transcript once the
  // full audio turn has finished playing — so text never races ahead.
  const pendingModelTextRef = useRef('');
  const inTextRef           = useRef('');

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [transcript]);

  // ── Enqueue one audio chunk onto the sequential play chain ──
  const enqueueChunk = useCallback((b64: string) => {
    audioQueueRef.current = audioQueueRef.current.then(async () => {
      const ctx = outCtxRef.current;
      if (!ctx || ctx.state === 'closed') return;

      // If paused, wait until resumed (poll every 100 ms)
      while (ctx.state === 'suspended') {
        await new Promise(r => setTimeout(r, 100));
      }

      try {
        const buf = await decodeAudioData(decode(b64), ctx, 24000, 1);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);

        const now   = ctx.currentTime;
        const start = Math.max(now, nextStartRef.current);
        src.start(start);
        nextStartRef.current = start + buf.duration;

        setSpeaking(true);

        // Wait for this chunk to actually finish
        await new Promise<void>(resolve => { src.onended = () => resolve(); });
      } catch (err) {
        console.warn('Audio chunk error:', err);
      }
    });
  }, []);

  // ── Toggle pause / resume ────────────────────────────────────
  const togglePause = useCallback(() => {
    const ctx = outCtxRef.current;
    if (!ctx) return;
    if (ctx.state === 'running') {
      ctx.suspend();
      setPaused(true);
    } else {
      ctx.resume();
      setPaused(false);
    }
  }, []);

  // ── Main effect: connect session + mic ──────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;

        const AC = window.AudioContext || (window as any).webkitAudioContext;
        inCtxRef.current  = new AC({ sampleRate: 16000 });
        outCtxRef.current = new AC({ sampleRate: 24000 });
        nextStartRef.current = 0;

        sessionRef.current = await apiConnectLiveTutor(topic, {
          onopen: () => {
            if (cancelled) return;
            setStatus('connected');

            // Wire mic → Gemini Live
            const src  = inCtxRef.current!.createMediaStreamSource(stream);
            const proc = inCtxRef.current!.createScriptProcessor(4096, 1, 1);
            proc.onaudioprocess = ev => {
              if (!sessionRef.current) return;
              sessionRef.current.sendRealtimeInput({ audio: createBlob(ev.inputBuffer.getChannelData(0)) });
            };
            src.connect(proc);
            proc.connect(inCtxRef.current!.destination);
            nodesRef.current = { src, proc };
          },

          onmessage: (msg: LiveServerMessage) => {
            if (cancelled) return;

            // ── User speech transcript — stream in immediately ──
            const inChunk = msg.serverContent?.inputTranscription?.text;
            if (inChunk) {
              inTextRef.current += inChunk;
              setTranscript(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'user') return [...prev.slice(0, -1), { ...last, text: inTextRef.current }];
                return [...prev, { role: 'user', text: inTextRef.current, id: Date.now() + Math.random() }];
              });
            }

            // ── Model transcript — stream in immediately as AI speaks ──
            const outChunk = msg.serverContent?.outputTranscription?.text;
            if (outChunk) {
              pendingModelTextRef.current += outChunk;
              setTranscript(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'model') {
                  return [...prev.slice(0, -1), { ...last, text: pendingModelTextRef.current }];
                }
                return [...prev, { role: 'model', text: pendingModelTextRef.current, id: Date.now() + Math.random() }];
              });
            }

            // ── Iterate ALL audio parts, enqueue sequentially ──
            const parts = msg.serverContent?.modelTurn?.parts ?? [];
            for (const part of parts) {
              if (part.inlineData?.data) enqueueChunk(part.inlineData.data);
            }

            // Turn complete — reset both text buffers
            if (msg.serverContent?.turnComplete) {
              inTextRef.current = '';
              pendingModelTextRef.current = '';
              // Mark not-speaking after audio queue drains
              audioQueueRef.current.then(() => setSpeaking(false));
            }
          },

          onerror: (e: ErrorEvent) => {
            setStatus('error');
            setTranscript(prev => [...prev, { role: 'status', text: `Error: ${e.message}`, id: Date.now() }]);
          },
          onclose: () => {
            if (!cancelled) setStatus('disconnected');
          },
        });

      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setStatus('error');
          setTranscript(prev => [...prev, { role: 'status', text: 'Could not access microphone. Check permissions.', id: Date.now() }]);
        }
      }
    })();

    return () => {
      cancelled = true;
      sessionRef.current?.close?.();
      streamRef.current?.getTracks().forEach(t => t.stop());
      nodesRef.current.src?.disconnect();
      nodesRef.current.proc?.disconnect();
      inCtxRef.current?.close().catch(() => {});
      outCtxRef.current?.close().catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic]);

  const statusLabel =
    status === 'connecting'   ? 'Connecting…' :
    status === 'error'        ? 'Error'        :
    status === 'disconnected' ? 'Ended'        :
    paused                    ? 'Paused'       :
    speaking                  ? 'Tutor speaking…' : 'Listening…';

  // ── Orb icon depends on state ────────────────────────────────
  const orbIcon = paused ? (
    // Play icon
    <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
  ) : speaking ? (
    // Waveform icon
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M12 6v12"/><path d="M16 8v8"/><path d="M8 8v8"/><path d="M20 10v4"/><path d="M4 10v4"/>
    </svg>
  ) : (
    // Microphone icon
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8"  y1="23" x2="16" y2="23"/>
    </svg>
  );

  return (
    <div className="tutor-overlay" role="dialog" aria-modal="true">
      <div className="tutor-container">

        <header className="tutor-header">
          <h2>Live Tutor: {topic.topic}</h2>
          <button className="tutor-close-button" onClick={onEnd}>&times;</button>
        </header>

        <div className="tutor-visualizer">
          {/* ── FIX 5: Orb is now a tappable button for pause/resume ── */}
          <button
            className={`tutor-orb ${status === 'connected' && !speaking && !paused ? 'listening' : ''} ${speaking && !paused ? 'speaking' : ''} ${paused ? 'paused' : ''}`}
            onClick={status === 'connected' ? togglePause : undefined}
            disabled={status !== 'connected'}
            title={paused ? 'Resume' : speaking ? 'Pause tutor' : 'Tap to pause'}
            style={{ cursor: status === 'connected' ? 'pointer' : 'default', border: 'none', background: 'none', padding: 0 }}
          >
            {orbIcon}
          </button>
          <div className="tutor-status">{statusLabel}</div>
          {status === 'connected' && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 2, opacity: 0.7 }}>
              {paused ? 'tap orb to resume' : 'tap orb to pause'}
            </div>
          )}
        </div>

        <div className="tutor-transcript-container">
          <div className="tutor-transcript">
            {transcript.map(m => (
              <div key={m.id} className={`transcript-message ${m.role}`}>
                <div className="message-bubble">{m.text}</div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        </div>

      </div>
    </div>
  );
};

// ── History modal ─────────────────────────────────────────────
const HistoryModal = ({ open, history, onClose, onLoad, onDelete, onClear }: {
  open: boolean; history: HistoryItem[];
  onClose: () => void; onLoad: (i: HistoryItem) => void;
  onDelete: (id: string) => void; onClear: () => void;
}) => {
  if (!open) return null;
  return (
    <div className="history-overlay" role="dialog" aria-modal="true">
      <div className="history-modal">
        <header className="history-header">
          <h2>Study Plan History</h2>
          <button className="history-close-button" onClick={onClose}>&times;</button>
        </header>
        <div className="history-content">
          {history.length === 0
            ? <div className="history-empty-state"><p>No saved plans yet.</p></div>
            : <ul className="history-list">{history.map(item => (
                <li key={item.id} className="history-item">
                  <div className="history-item-info">
                    <div className="history-item-mode">{getStatus(item.mode).icon} {getStatus(item.mode).modeTitle}</div>
                    <div className="history-item-date">{new Date(item.timestamp).toLocaleString()}</div>
                    <div className="history-item-files">{item.files.map(f => f.name).join(', ')}</div>
                  </div>
                  <div className="history-item-actions">
                    <button className="history-action-button load" onClick={() => onLoad(item)}>Load</button>
                    <button className="history-action-button delete" onClick={() => onDelete(item.id)}>Delete</button>
                  </div>
                </li>
              ))}</ul>}
        </div>
        {history.length > 0 && <footer className="history-footer"><button className="history-clear-all-button" onClick={onClear}>Clear All</button></footer>}
      </div>
    </div>
  );
};

// ── RoomLobby ─────────────────────────────────────────────────
const RoomLobby = ({ userId, analysis, onEnter, onBack }: {
  userId: string; analysis: AnalysisResult | null;
  onEnter: (id: string) => void; onBack: () => void;
}) => {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) { setErr('Enter a room name.'); return; }
    setCreating(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token;

      let dailyUrl: string | null = null;
      try {
        const res = await fetch('/api/room', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt ?? ''}` },
          body: JSON.stringify({ roomName: name.trim().toLowerCase().replace(/\s+/g, '-') }),
        });
        if (res.ok) { const d = await res.json() as { url: string }; dailyUrl = d.url; }
      } catch { /* video optional */ }

      const { data, error } = await supabase
        .from('rooms')
        .insert({ name: name.trim(), host_id: userId, topic_context: analysis ?? null, daily_room_url: dailyUrl })
        .select('id')
        .single();

      if (error) throw error;
      onEnter((data as { id: string }).id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to create room.');
    } finally { setCreating(false); }
  };

  const join = async () => {
    if (!token.trim()) { setErr('Enter a room code.'); return; }
    setJoining(true); setErr(null);
    try {
      const { data, error } = await supabase
        .from('rooms')
        .select('id')
        .eq('join_token', token.trim())
        .eq('is_active', true)
        .maybeSingle();

      if (error || !data) { setErr('Room not found. Check the code.'); return; }
      onEnter((data as { id: string }).id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to join room.');
    } finally { setJoining(false); }
  };

  return (
    <section className="room-lobby view-container">
      <header className="page-header">
        <button className="back-button" onClick={onBack}>&larr; Back</button>
        <h1>Forge Room</h1>
        <p className="subtitle">Study together with video, shared AI, and quiz battles.</p>
      </header>
      {err && <div className="error-message">{err}</div>}
      <div className="room-lobby-grid">
        <div className="room-lobby-card">
          <div className="room-lobby-icon">⚡</div>
          <h2>Create a Room</h2>
          <p>Start a session and share the link with your group.</p>
          <input className="room-lobby-input" type="text" placeholder="Room name e.g. Thermo Exam Prep"
            value={name} onChange={e => setName(e.target.value)} />
          <button className="room-lobby-btn primary" onClick={create} disabled={creating}>
            {creating ? 'Creating...' : '⚡ Create Room'}
          </button>
        </div>
        <div className="room-lobby-or">or</div>
        <div className="room-lobby-card">
          <div className="room-lobby-icon">🔗</div>
          <h2>Join a Room</h2>
          <p>Enter the 8-character code from your friend's link.</p>
          <input className="room-lobby-input" type="text" placeholder="Room code e.g. ab3x9f2c"
            value={token} onChange={e => setToken(e.target.value.toLowerCase())} maxLength={8} />
          <button className="room-lobby-btn" onClick={join} disabled={joining}>
            {joining ? 'Joining...' : '🔗 Join Room'}
          </button>
        </div>
      </div>
    </section>
  );
};

// ════════════════════════════════════════════════════════════
// APP
// ════════════════════════════════════════════════════════════
const App = () => {
  // Auth
  const [user, setUser]           = useState<User | null>(null);
  const [profile, setProfile]     = useState<Profile | null>(null);
  const [authReady, setAuthReady] = useState(false);

  // App state
  const [view, setView]         = useState<AppView>('home');
  const [mode, setMode]         = useState<Mode | null>(null);
  const [files, setFiles]       = useState<(File | null)[]>([null, null, null]);
  const [ytUrl, setYtUrl]       = useState('');
  const [error, setError]       = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [topic, setTopic]       = useState<Topic | null>(null);
  const [quizQs, setQuizQs]     = useState<QuizQuestion[] | null>(null);
  const [quizSum, setQuizSum]   = useState<{ score: number; total: number; reflection: string } | null>(null);
  const [tutorOn, setTutorOn]   = useState(false);
  const [hlTopic, setHlTopic]   = useState<string | null>(null);
  const [history, setHistory]   = useState<HistoryItem[]>([]);
  const [histOpen, setHistOpen] = useState(false);

  // Room state
  const [roomId, setRoomId] = useState<string | null>(null);

  const th = getStatus(mode);

  // ── Auth listener ────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setUser(s?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) { setProfile(null); return; }
    supabase.from('profiles').select('*').eq('id', user.id).single().then(({ data }) => {
      if (data) setProfile(data as Profile);
    });
  }, [user]);

  // Check for room token in URL
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    const t = params.get('room');
    if (!t) return;
    supabase.from('rooms').select('id').eq('join_token', t).eq('is_active', true).maybeSingle().then(({ data }) => {
      if (data) { setRoomId((data as { id: string }).id); setView('room'); }
    });
  }, [user]);

  // Apply theme
  useEffect(() => {
    if (view === 'room') { document.body.className = 'theme-neutral'; return; }
    document.body.className = th.themeClass;
    document.documentElement.style.setProperty('--dynamic-primary', th.primary);
    document.documentElement.style.setProperty('--dynamic-bg', th.darkBg);
    document.documentElement.style.setProperty('--dynamic-primary-trans', `${th.primary}50`);
  }, [th, view]);

  // History persistence
  useEffect(() => {
    try { const s = localStorage.getItem('forgeai_history'); if (s) setHistory(JSON.parse(s) as HistoryItem[]); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem('forgeai_history', JSON.stringify(history)); } catch { /* ignore */ }
  }, [history]);

  // ── Handlers ─────────────────────────────────────────────
  const reset = () => {
    setView('home'); setMode(null); setFiles([null,null,null]); setYtUrl('');
    setError(null); setAnalysis(null); setTopic(null); setQuizQs(null);
    setQuizSum(null); setHlTopic(null); setTutorOn(false);
  };

  const updateTopic = useCallback((updated: Topic) => {
    setAnalysis(prev => prev ? { ...prev, study_these: prev.study_these.map(t => t.topic === updated.topic ? updated : t) } : null);
    setTopic(prev => prev?.topic === updated.topic ? updated : prev);
  }, []);

  const addFile = (file: File, index: number) => {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) { alert(`Unsupported file type: ${file.type}`); return; }
    const max = file.type.startsWith('audio/') ? MAX_AUDIO : MAX_DEFAULT;
    if (file.size > max) { alert(`File too large. Max ${fmtSize(max)}.`); return; }
    setFiles(prev => { const n = [...prev]; n[index] = file; return n; });
  };

  const generatePlan = async () => {
    const valid = files.filter(Boolean) as File[];
    if (!mode || (!valid.length && !ytUrl.trim())) return;
    setView('loading'); setError(null);
    try {
      let ytTranscript: string | undefined;
      if (ytUrl.trim()) {
        try { ytTranscript = await apiFetchYoutubeTranscript(ytUrl); } catch { /* fallback to search */ }
      }
      const initial = await apiGenerateStudyPlan(mode, valid, ytUrl.trim() || undefined, ytTranscript);
      const hItem: HistoryItem = { id: Date.now().toString(), timestamp: Date.now(), mode: mode!, analysis: initial, files: valid.map(f => ({ name: f.name, size: f.size, type: f.type })), youtubeUrl: ytUrl.trim() || undefined };
      setHistory(prev => [hItem, ...prev]);
      setAnalysis(initial); setView('results');

      // Generate notes sequentially
      const done: Topic[] = [];
      for (const t of initial.study_these) {
        if (done.length) await new Promise(r => setTimeout(r, 1000));
        try {
          const notes = await apiGenerateStudyNotes(t);
          const updated = { ...t, notes };
          updateTopic(updated); done.push(updated);
        } catch {
          const err = { ...t, notes: 'Error: Could not generate notes. Click Retry.' };
          updateTopic(err); done.push(err);
        }
      }
      const final = { ...initial, study_these: done };
      setHistory(prev => prev.map(i => i.id === hItem.id ? { ...i, analysis: final } : i));
    } catch (e) {
      setError(`Could not generate plan. ${e instanceof Error ? e.message : ''}`);
      setView('upload');
    }
  };

  const retryNotes = useCallback(async (t: Topic) => {
    updateTopic({ ...t, notes: undefined });
    try { updateTopic({ ...t, notes: await apiGenerateStudyNotes(t) }); }
    catch { updateTopic({ ...t, notes: 'Error: Could not generate notes. Click Retry.' }); }
  }, [updateTopic]);

  const startQuiz = async (t: Topic) => {
    setTopic(t); setView('loading');
    try {
      const qs = await apiGeneratePracticeQuiz(t);
      if (!qs.length) throw new Error('No questions generated.');
      setQuizQs(qs); setView('quiz');
    } catch { setError('Could not create quiz. Try again.'); setView('results'); }
  };

  // ✅ FIX 2: Derive score from wrong count to avoid stale setState on the last question
  const finishQuiz = async (_score: number, total: number, wrong: QuizQuestion[]) => {
    const score = total - wrong.length; // always accurate regardless of setState timing
    setView('loading');
    if (!topic) { setView('results'); return; }
    try { setQuizSum({ score, total, reflection: await apiGenerateQuizReflection(topic, score, total, wrong) }); }
    catch { setQuizSum({ score, total, reflection: 'Great effort! Keep reviewing.' }); }
    finally { setView('quiz-summary'); }
  };

  const loadHistory = (item: HistoryItem) => {
    setMode(item.mode);
    setAnalysis(item.analysis);

    const loadedFiles: (File | null)[] = item.files
      .slice(0, 3)
      .map(f => new File([], f.name, { type: f.type }));

    while (loadedFiles.length < 3) loadedFiles.push(null);

    setFiles(loadedFiles);
    setYtUrl(item.youtubeUrl ?? '');
    setView('results');
    setHistOpen(false);
  };

  // ── Auth loading ─────────────────────────────────────────
  if (!authReady) {
    return <div className="loading-view"><div className="loading-spinner" /><div className="loading-text">Loading Forge AI...</div></div>;
  }

  // ── Auth gate ────────────────────────────────────────────
  if (!user) return <AuthPage />;

  // ── Full-screen room ─────────────────────────────────────
  if (view === 'room' && roomId && profile) {
    return (
      <ForgeRoom
        roomId={roomId}
        userId={user.id}
        userProfile={profile}
        onLeave={() => { setRoomId(null); setView(analysis ? 'results' : 'home'); }}
      />
    );
  }

  // ── Room lobby ───────────────────────────────────────────
  if (view === 'room-lobby') {
    return (
      <>
        <BackgroundEffects mode={mode} />
        <div className="container">
          <header className="app-header">
            <div className="emblem"><span className="forge-emblem-icon">⚡</span><span className="emblem-text">Forge AI</span></div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="history-button" onClick={() => setHistOpen(true)}>History 📜</button>
              <button className="history-button" onClick={() => supabase.auth.signOut()}>Sign out</button>
            </div>
          </header>
          <main>
            <RoomLobby
              userId={user.id}
              analysis={analysis}
              onEnter={id => { setRoomId(id); setView('room'); }}
              onBack={() => setView(analysis ? 'results' : 'home')}
            />
          </main>
        </div>
      </>
    );
  }

  // ── Main views ───────────────────────────────────────────
  const renderView = () => {
    switch (view) {
      case 'home':
        return <HomePage onSelectMode={m => { setMode(m); setView('upload'); }} onOpenRoom={() => setView('room-lobby')} />;

      case 'upload':
        return <UploadPage
          mode={mode!} files={files} youtubeUrl={ytUrl} setYoutubeUrl={setYtUrl}
          onBack={() => { setMode(null); setView('home'); }}
          addFile={addFile}
          onRemoveFile={i => setFiles(prev => { const n = [...prev]; n[i] = null; return n; })}
          onGeneratePlan={generatePlan}
          onOpenRoom={() => setView('room-lobby')}
        />;

      case 'loading':
        return <LoadingPage mode={mode} />;

      // ✅ FIX 3: Guard against null mode before rendering ResultsPage
      case 'results':
        if (!mode) { reset(); return null; }
        return <ResultsPage
          analysis={analysis} mode={mode}
          onStudyTopic={t => { setTopic(t); setView('study'); }}
          onStartQuiz={startQuiz} onReset={reset}
          highlightedTopic={hlTopic} setHighlightedTopic={setHlTopic}
          onRetryNotes={retryNotes} onOpenRoom={() => setView('room-lobby')}
        />;

      case 'study':
        return <StudyPage
          topic={topic!}
          onBack={() => { setHlTopic(topic?.topic ?? null); setView('results'); setTopic(null); }}
          onUpdate={updateTopic}
          onStartTutor={t => { setTopic(t); setTutorOn(true); }}
        />;

      case 'quiz':
        return <QuizPage
          topic={topic!} questions={quizQs!}
          onBack={() => { setHlTopic(topic?.topic ?? null); setView('results'); setTopic(null); setQuizQs(null); }}
          onFinish={finishQuiz}
        />;

      case 'quiz-summary':
        return <QuizSummary
          topic={topic!} score={quizSum!.score} total={quizSum!.total} reflection={quizSum!.reflection}
          onRetry={() => setView('quiz')}
          onBack={() => { setHlTopic(topic?.topic ?? null); setView('results'); setTopic(null); setQuizQs(null); }}
        />;

      default:
        return <HomePage onSelectMode={m => { setMode(m); setView('upload'); }} onOpenRoom={() => setView('room-lobby')} />;
    }
  };

  return (
    <>
      <BackgroundEffects mode={mode} />
      <div className="container">
        <header className="app-header">
          <div className="emblem">
            <span className="forge-emblem-icon">⚡</span>
            <span className="emblem-text">Forge AI</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {profile && <span className="forge-user-chip">👤 {profile.display_name}</span>}
            <button className="history-button" onClick={() => setHistOpen(true)}>History 📜</button>
            <button className="history-button" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        </header>
        <main>
          {error && <div className="error-message">{error}</div>}
          {renderView()}
        </main>
      </div>

      {tutorOn && topic && <LiveTutorView topic={topic} onEnd={() => setTutorOn(false)} />}

      <HistoryModal
        open={histOpen} history={history}
        onClose={() => setHistOpen(false)} onLoad={loadHistory}
        onDelete={id => setHistory(prev => prev.filter(i => i.id !== id))}
        onClear={() => { if (window.confirm('Delete all history?')) setHistory([]); }}
      />
    </>
  );
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode><App /></React.StrictMode>
);