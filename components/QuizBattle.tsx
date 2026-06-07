/**
 * Forge AI — QuizBattle.tsx
 * Group quiz battle using Supabase Realtime.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabase/client';
import type { QuizSession, QuizAnswer, Profile } from '../supabase/client';
import type { QuizQuestion } from '../api';

type Props = {
  roomId: string;
  userId: string;
  isHost: boolean;
  userProfile: Profile;
  availableTopics: string[];
  onGenerateQuestions: (topic: string) => Promise<QuizQuestion[]>;
};

type LeaderboardEntry = {
  userId: string;
  displayName: string;
  avatarColor: string;
  score: number;
  answered: number;
};

const QuizBattle: React.FC<Props> = ({
  roomId, userId, isHost, userProfile, availableTopics, onGenerateQuestions,
}) => {
  const [activeSession, setActiveSession] = useState<QuizSession | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState(availableTopics[0] ?? '');
  const [allAnswers, setAllAnswers] = useState<QuizAnswer[]>([]);
  const [sessionFinished, setSessionFinished] = useState(false);

  useEffect(() => {
    const loadSession = async () => {
      const { data } = await supabase
        .from('quiz_sessions').select('*').eq('room_id', roomId)
        .eq('is_active', true).order('created_at', { ascending: false }).limit(1).single();
      if (data) setActiveSession(data as QuizSession);
    };
    loadSession();

    const sessionChannel = supabase
      .channel(`quiz_sessions:${roomId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'quiz_sessions', filter: `room_id=eq.${roomId}` },
        (payload) => {
          setActiveSession(payload.new as QuizSession);
          setCurrentIndex(0); setSelectedAnswer(null);
          setSessionFinished(false); setAllAnswers([]);
        })
      .subscribe();

    return () => { supabase.removeChannel(sessionChannel); };
  }, [roomId]);

  useEffect(() => {
    if (!activeSession) return;

    const loadAnswers = async () => {
      const { data } = await supabase
        .from('quiz_answers').select('*, profiles(id, display_name, avatar_color)')
        .eq('quiz_session_id', activeSession.id);
      if (data) { setAllAnswers(data as any); computeLeaderboard(data as any, activeSession.questions.length); }
    };
    loadAnswers();

    const answerChannel = supabase
      .channel(`quiz_answers:${activeSession.id}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'quiz_answers', filter: `quiz_session_id=eq.${activeSession.id}` },
        async (payload) => {
          const { data: profileData } = await supabase.from('profiles').select('*').eq('id', payload.new.user_id).single();
          const enriched = { ...payload.new, profiles: profileData };
          setAllAnswers(prev => {
            const updated = [...prev, enriched as any];
            computeLeaderboard(updated, activeSession.questions.length);
            return updated;
          });
        })
      .subscribe();

    return () => { supabase.removeChannel(answerChannel); };
  }, [activeSession]);

  const computeLeaderboard = useCallback((answers: any[], totalQuestions: number) => {
    const map = new Map<string, LeaderboardEntry>();
    for (const a of answers) {
      const uid = a.user_id;
      const existing = map.get(uid);
      if (existing) { existing.score += a.is_correct ? 1 : 0; existing.answered += 1; }
      else map.set(uid, {
        userId: uid,
        displayName: a.profiles?.display_name ?? 'Student',
        avatarColor: (a.profiles?.avatar_color as string | undefined) ?? '#534AB7',
        score: a.is_correct ? 1 : 0, answered: 1,
      });
    }
    setLeaderboard(Array.from(map.values()).sort((a, b) => b.score - a.score));
    if (answers.filter(a => a.user_id === userId).length >= totalQuestions) setSessionFinished(true);
  }, [userId]);

  const handleStartBattle = async () => {
    if (!selectedTopic || !isHost) return;
    setIsStarting(true);
    try {
      const questions = await onGenerateQuestions(selectedTopic);
      const { data, error } = await supabase.from('quiz_sessions')
        .insert({ room_id: roomId, host_id: userId, topic: selectedTopic, questions, is_active: true })
        .select().single();
      if (error) throw error;
      setActiveSession(data as QuizSession);
    } catch (e) { console.error('Failed to start quiz battle:', e); }
    finally { setIsStarting(false); }
  };

  const handleAnswer = async (option: string) => {
    if (selectedAnswer || !activeSession) return;
    setSelectedAnswer(option);
    const question: QuizQuestion = activeSession.questions[currentIndex];
    await supabase.from('quiz_answers').insert({
      quiz_session_id: activeSession.id, user_id: userId,
      question_index: currentIndex, selected_answer: option,
      is_correct: option === question.correct_answer,
    });
  };

  const handleNext = () => {
    if (!activeSession) return;
    if (currentIndex < activeSession.questions.length - 1) {
      setCurrentIndex(prev => prev + 1); setSelectedAnswer(null);
    } else { setSessionFinished(true); }
  };

  const getOptClass = (option: string) => {
    if (!selectedAnswer) return 'qb-opt';
    const q: QuizQuestion = activeSession!.questions[currentIndex];
    if (option === q.correct_answer) return 'qb-opt correct';
    if (option === selectedAnswer)   return 'qb-opt wrong';
    return 'qb-opt dimmed';
  };

  const getInitials = (name: string) =>
    name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

  // ── Lobby ─────────────────────────────────────────────────
  if (!activeSession) {
    return (
      <div className="qb-lobby">
        <div className="qb-lobby-icon">🏆</div>
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
            <button className="qb-start-btn" onClick={handleStartBattle} disabled={isStarting || !selectedTopic}>
              {isStarting ? 'Generating questions...' : '⚡ Start Quiz Battle'}
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
        <div className="qb-results-title">🏆 Final Leaderboard</div>
        <div className="qb-results-topic">{activeSession.topic}</div>
        {leaderboard.map((entry, i) => (
          <div key={entry.userId} className={`qb-lb-row${entry.userId === userId ? ' me' : ''}`}>
            <div className="qb-lb-rank">#{i + 1}</div>
            <div className="qb-lb-avatar" style={{ background: entry.avatarColor + '22', color: entry.avatarColor }}>
              {getInitials(entry.displayName)}
            </div>
            <div className="qb-lb-name">{entry.displayName}{entry.userId === userId && ' (you)'}</div>
            <div className="qb-lb-score">{entry.score}/{questions.length}</div>
          </div>
        ))}
        {isHost && (
          <button className="qb-start-btn" style={{ marginTop: 16 }} onClick={() => {
            setActiveSession(null); setSessionFinished(false);
            setAllAnswers([]); setLeaderboard([]);
            setCurrentIndex(0); setSelectedAnswer(null);
          }}>
            New Battle
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

      <div className="qb-question">{currentQ.question}</div>

      <div className="qb-options">
        {currentQ.options.map((opt, i) => (
          <button key={i} className={getOptClass(opt)} onClick={() => handleAnswer(opt)} disabled={!!selectedAnswer}>
            {opt}
          </button>
        ))}
      </div>

      {selectedAnswer && <div className="qb-explanation">{currentQ.explanation}</div>}

      {selectedAnswer && (
        <button className="qb-next-btn" onClick={handleNext}>
          {currentIndex < questions.length - 1 ? 'Next →' : 'See Results'}
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