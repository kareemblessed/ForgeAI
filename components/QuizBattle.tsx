/**
 * Forge AI — QuizBattle.tsx
 * Group quiz battle using Supabase Realtime.
 *
 * Progress lives in the database (quiz_answers), so switching tabs or rejoining the room
 * resumes where you left off. The leaderboard is derived from the answers list.
 */
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '../supabase/client';
import type { QuizSession, QuizAnswer, Profile } from '../supabase/client';
import type { QuizQuestion } from '../api';
import { Icon, Avatar } from './icons';

type Props = {
  roomId: string;
  userId: string;
  isHost: boolean;
  userProfile: Profile;
  availableTopics: string[];
  onGenerateQuestions: (topic: string) => Promise<QuizQuestion[]>;
};

const MEDALS = ['🥇', '🥈', '🥉'];

type LeaderboardEntry = {
  userId: string;
  displayName: string;
  avatarColor: string;
  score: number;
  answered: number;
};

type AnswerRow = QuizAnswer & { profiles?: Profile | null };

const buildLeaderboard = (answers: AnswerRow[]): LeaderboardEntry[] => {
  const map = new Map<string, LeaderboardEntry>();
  for (const a of answers) {
    const existing = map.get(a.user_id);
    if (existing) { existing.score += a.is_correct ? 1 : 0; existing.answered += 1; }
    else map.set(a.user_id, {
      userId: a.user_id,
      displayName: a.profiles?.display_name ?? 'Student',
      avatarColor: (a.profiles?.avatar_color as string | undefined) ?? '#534AB7',
      score: a.is_correct ? 1 : 0, answered: 1,
    });
  }
  return Array.from(map.values()).sort((a, b) => b.score - a.score);
};

const QuizBattle: React.FC<Props> = ({
  roomId, userId, isHost, availableTopics, onGenerateQuestions,
}) => {
  const [activeSession, setActiveSession] = useState<QuizSession | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [selectedTopic, setSelectedTopic] = useState(availableTopics[0] ?? '');
  const [allAnswers, setAllAnswers] = useState<AnswerRow[]>([]);
  const [sessionFinished, setSessionFinished] = useState(false);
  const activeIdRef = useRef<string | null>(null);

  const leaderboard = useMemo(() => buildLeaderboard(allAnswers), [allAnswers]);

  useEffect(() => { activeIdRef.current = activeSession?.id ?? null; }, [activeSession]);

  // Current session + new sessions started by the host
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('quiz_sessions').select('*').eq('room_id', roomId)
        .eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (data) setActiveSession(data as QuizSession);
    })();

    const sessionChannel = supabase
      .channel(`quiz_sessions:${roomId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'quiz_sessions', filter: `room_id=eq.${roomId}` },
        (payload) => {
          const row = payload.new as QuizSession;
          if (row.id === activeIdRef.current) return; // the host already has it
          setActiveSession(row);
          setCurrentIndex(0); setSelectedAnswer(null);
          setSessionFinished(false); setAllAnswers([]);
        })
      .subscribe();

    return () => { supabase.removeChannel(sessionChannel); };
  }, [roomId]);

  // Answers for the active session: initial load (resumes progress) + realtime inserts
  useEffect(() => {
    if (!activeSession) return;
    const total = activeSession.questions.length;

    (async () => {
      const { data } = await supabase
        .from('quiz_answers').select('*, profiles(id, display_name, avatar_color)')
        .eq('quiz_session_id', activeSession.id);
      if (!data) return;
      const rows = data as AnswerRow[];
      setAllAnswers(rows);
      // Resume where this player left off (tab switch / rejoin)
      const mine = rows.filter(a => a.user_id === userId).length;
      if (mine >= total) setSessionFinished(true);
      else setCurrentIndex(mine);
    })();

    const answerChannel = supabase
      .channel(`quiz_answers:${activeSession.id}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'quiz_answers', filter: `quiz_session_id=eq.${activeSession.id}` },
        async (payload) => {
          const row = payload.new as QuizAnswer;
          const { data: profile } = await supabase.from('profiles').select('id, display_name, avatar_color').eq('id', row.user_id).maybeSingle();
          // De-duplicate: the initial load and the realtime event can both deliver the same row
          setAllAnswers(prev => prev.some(a => a.id === row.id) ? prev : [...prev, { ...row, profiles: profile as Profile | null }]);
        })
      .subscribe();

    return () => { supabase.removeChannel(answerChannel); };
  }, [activeSession, userId]);

  const handleStartBattle = async () => {
    if (!selectedTopic || !isHost) return;
    setIsStarting(true); setStartError(null);
    try {
      const questions = await onGenerateQuestions(selectedTopic);
      if (!Array.isArray(questions) || !questions.length || questions.some(q => !q?.question || !Array.isArray(q.options) || !q.options.length)) {
        throw new Error('The AI returned an invalid quiz. Please try again.');
      }
      const { data, error } = await supabase.from('quiz_sessions')
        .insert({ room_id: roomId, host_id: userId, topic: selectedTopic, questions, is_active: true })
        .select().single();
      if (error) throw error;
      activeIdRef.current = (data as QuizSession).id;
      setCurrentIndex(0); setSelectedAnswer(null); setSessionFinished(false); setAllAnswers([]);
      setActiveSession(data as QuizSession);
    } catch (e) {
      console.error('Failed to start quiz battle:', e);
      setStartError(e instanceof Error ? e.message : 'Could not start the quiz battle.');
    } finally { setIsStarting(false); }
  };

  const handleAnswer = async (option: string) => {
    if (selectedAnswer || !activeSession) return;
    setSelectedAnswer(option);
    const question: QuizQuestion = activeSession.questions[currentIndex];
    const { error } = await supabase.from('quiz_answers').insert({
      quiz_session_id: activeSession.id, user_id: userId,
      question_index: currentIndex, selected_answer: option,
      is_correct: option === question.correct_answer,
    });
    // 23505 = already answered this question (e.g. after a reconnect): nothing to do
    if (error && error.code !== '23505') console.error('Failed to save answer:', error);
  };

  const handleNext = () => {
    if (!activeSession) return;
    if (currentIndex < activeSession.questions.length - 1) {
      setCurrentIndex(prev => prev + 1); setSelectedAnswer(null);
    } else { setSessionFinished(true); }
  };

  const handleNewBattle = () => {
    // Retire the finished session so people who join later don't land on it
    if (activeSession) void supabase.from('quiz_sessions').update({ is_active: false }).eq('id', activeSession.id);
    activeIdRef.current = null;
    setActiveSession(null); setSessionFinished(false);
    setAllAnswers([]); setCurrentIndex(0); setSelectedAnswer(null);
  };

  const getOptClass = (option: string) => {
    if (!selectedAnswer) return 'qb-opt';
    const q: QuizQuestion = activeSession!.questions[currentIndex];
    if (option === q.correct_answer) return 'qb-opt correct';
    if (option === selectedAnswer)   return 'qb-opt wrong';
    return 'qb-opt dimmed';
  };

  // ── Lobby ─────────────────────────────────────────────────
  if (!activeSession) {
    return (
      <div className="qb-lobby">
        <div className="qb-lobby-icon"><Icon name="trophy" size={28} /></div>
        <h3 className="qb-lobby-title">Quiz Battle</h3>
        <p className="qb-lobby-sub">
          {isHost
            ? 'Challenge your study group to a live quiz!'
            : 'Waiting for the host to start a quiz battle...'}
        </p>
        {isHost && (
          <div className="qb-setup">
            <select className="qb-select" value={selectedTopic} onChange={e => setSelectedTopic(e.target.value)}>
              {availableTopics.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            {startError && <div className="qb-error" role="alert">{startError}</div>}
            <button className="qb-start-btn" onClick={handleStartBattle} disabled={isStarting || !selectedTopic}>
              {isStarting ? <><span className="forge-spin" />Generating questions…</> : <><Icon name="bolt" size={15} />Start quiz battle</>}
            </button>
          </div>
        )}
      </div>
    );
  }

  const questions: QuizQuestion[] = activeSession.questions;
  const currentQ = questions[currentIndex];
  const myScore = allAnswers.filter(a => a.user_id === userId && a.is_correct).length;

  // ── Results ───────────────────────────────────────────────
  if (sessionFinished) {
    return (
      <div className="qb-results">
        <div className="qb-results-title"><Icon name="trophy" size={20} />Final leaderboard</div>
        <div className="qb-results-topic">{activeSession.topic}</div>
        {leaderboard.map((entry, i) => (
          <div key={entry.userId} className={`qb-lb-row${entry.userId === userId ? ' me' : ''}`}>
            <div className="qb-lb-rank">{MEDALS[i] ?? `#${i + 1}`}</div>
            <Avatar name={entry.displayName} color={entry.avatarColor} size={28} />
            <div className="qb-lb-name">{entry.displayName}{entry.userId === userId && ' (you)'}</div>
            <div className="qb-lb-score">{entry.score}/{questions.length}</div>
          </div>
        ))}
        {isHost && (
          <button className="qb-start-btn" onClick={handleNewBattle}>
            New battle
          </button>
        )}
      </div>
    );
  }

  // ── Active quiz ───────────────────────────────────────────
  return (
    <div className="qb-active">
      <div className="qb-active-header">
        <span className="qb-topic-tag">{activeSession.topic}</span>
        <span className="qb-progress">Q {currentIndex + 1}/{questions.length}</span>
        <span className="qb-my-score">Score: {myScore}</span>
      </div>

      <div className="qb-bar" aria-hidden="true"><i style={{ width: `${((currentIndex + (selectedAnswer ? 1 : 0)) / questions.length) * 100}%` }} /></div>

      <div className="qb-question">{currentQ.question}</div>

      <div className="qb-options">
        {currentQ.options.map((opt, i) => (
          <button key={i} className={getOptClass(opt)} onClick={() => handleAnswer(opt)} disabled={!!selectedAnswer}>
            <span className="qb-letter">{String.fromCharCode(65 + i)}</span>
            <span className="qb-opt-text">{opt}</span>
          </button>
        ))}
      </div>

      {selectedAnswer && <div className="qb-explanation">{currentQ.explanation}</div>}

      {selectedAnswer && (
        <button className="qb-next-btn" onClick={handleNext}>
          {currentIndex < questions.length - 1 ? 'Next question' : 'See results'}
        </button>
      )}

      {leaderboard.length > 0 && (
        <div className="qb-live-lb">
          <div className="qb-live-lb-title">Live scores</div>
          {leaderboard.slice(0, 5).map((entry, i) => (
            <div key={entry.userId} className="qb-live-row">
              <span className="qb-live-rank">#{i + 1}</span>
              <span className="qb-live-name">{entry.userId === userId ? 'You' : entry.displayName.split(' ')[0]}</span>
              <span className="qb-live-pts">{entry.score}pts</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default QuizBattle;