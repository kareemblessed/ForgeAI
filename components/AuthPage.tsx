/**
 * Forge AI — AuthPage.tsx
 * Email + password sign in / create account using Supabase Auth.
 * Two-column layout: brand panel + form. Styles live in styles/auth.css.
 */
import React, { useId, useMemo, useState } from 'react';
import { supabase } from '../supabase/client';
import { Icon } from './icons';

type AuthMode = 'signin' | 'signup';

const friendlyError = (msg: string): string => {
  const m = msg.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Wrong email or password. Please try again.';
  if (m.includes('email not confirmed')) return 'Please confirm your email first — check your inbox for the link.';
  if (m.includes('already registered') || m.includes('already been registered')) return 'That email already has an account. Try signing in instead.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Wait a minute and try again.';
  if (m.includes('failed to fetch') || m.includes('network')) return 'Could not reach the server. Check your connection.';
  return msg || 'Something went wrong. Please try again.';
};

/** 0–4: length, mixed case, number, symbol. */
const passwordScore = (pw: string) => {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw) || pw.length >= 14) s++;
  return s;
};

const STRENGTH_LABEL = ['', 'Weak', 'Okay', 'Good', 'Strong'];

const FEATURES: { icon: 'sparkles' | 'mic' | 'users'; text: string }[] = [
  { icon: 'sparkles', text: 'AI study plans and notes from your own materials' },
  { icon: 'mic',      text: 'A live voice tutor that talks you through it' },
  { icon: 'users',    text: 'Study rooms with video, shared AI and quiz battles' },
];

const MOCK_ROWS = [
  { name: 'KA', color: '#8f86ff', pts: 9, w: 90 },
  { name: 'MJ', color: '#46e8ff', pts: 7, w: 70 },
  { name: 'SR', color: '#ffb454', pts: 6, w: 60 },
];

const AuthPage: React.FC = () => {
  const [authMode, setAuthMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const uid = useId();
  const isSignup = authMode === 'signup';
  const score = useMemo(() => passwordScore(password), [password]);

  const switchMode = (next: AuthMode) => {
    if (next === authMode) return;
    setAuthMode(next);
    setError(null);
    setSuccessMessage(null);
    setShowPw(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setError(null);
    setSuccessMessage(null);

    if (isSignup && !displayName.trim()) { setError('Please enter your name.'); return; }
    if (isSignup && password.length < 8) { setError('Use at least 8 characters for your password.'); return; }

    setIsLoading(true);
    try {
      if (isSignup) {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { display_name: displayName.trim() } },
        });
        if (signUpError) throw signUpError;

        // With email confirmation off Supabase returns a session and App signs us in.
        if (!data.session) {
          setSuccessMessage('Account created! Check your email to confirm, then sign in.');
          setAuthMode('signin');
          setPassword('');
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signInError) throw signInError;
        // App's onAuthStateChange listener picks the session up from here.
      }
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : ''));
    } finally {
      setIsLoading(false);
    }
  };

  const id = (n: string) => `${uid}-${n}`;

  return (
    <div className="auth-shell">
      {/* ── Brand panel ─────────────────────────────────────── */}
      <aside className="auth-hero">
        <div className="auth-brand">
          <span className="auth-mark"><Icon name="bolt" size={22} /></span>
          <span className="auth-brand-name">Forge AI</span>
        </div>

        <div className="auth-hero-copy">
          <h2 className="auth-headline">Study smarter.<br /><em>Together.</em></h2>
          <p className="auth-lede">
            Turn your notes, slides and lectures into a plan you can actually follow — then work through it with friends.
          </p>
          <ul className="auth-features">
            {FEATURES.map(f => (
              <li key={f.text}>
                <span className="auth-feature-icon"><Icon name={f.icon} size={18} /></span>
                {f.text}
              </li>
            ))}
          </ul>
        </div>

        <div className="auth-mock" aria-hidden="true">
          <div className="auth-mock-head">
            <span>Thermo Exam Prep</span>
            <span className="auth-mock-code">#ab3x9f2c</span>
            <span className="auth-mock-live"><i />3 live</span>
          </div>
          <div className="auth-mock-rows">
            {MOCK_ROWS.map(r => (
              <div className="auth-mock-row" key={r.name}>
                <span className="auth-mock-av" style={{ background: `${r.color}26`, color: r.color }}>{r.name}</span>
                <span className="auth-mock-bar"><i style={{ width: `${r.w}%` }} /></span>
                <span className="auth-mock-pts">{r.pts}/10</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* ── Form ────────────────────────────────────────────── */}
      <main className="auth-panel">
        <div className="auth-card">
          <h1 className="auth-title">{isSignup ? 'Create your account' : 'Welcome back'}</h1>
          <p className="auth-subtitle">
            {isSignup ? 'Join Forge AI — it takes under a minute.' : 'Sign in to pick up where you left off.'}
          </p>

          <div className="auth-tabs" role="tablist" aria-label="Account" data-mode={authMode}>
            <span className="auth-tab-thumb" aria-hidden="true" />
            <button type="button" role="tab" className="auth-tab" aria-selected={!isSignup} onClick={() => switchMode('signin')}>
              Sign in
            </button>
            <button type="button" role="tab" className="auth-tab" aria-selected={isSignup} onClick={() => switchMode('signup')}>
              Create account
            </button>
          </div>

          <div aria-live="polite">
            {error && (
              <div className="auth-alert error" role="alert">
                <Icon name="alert" size={18} /><span>{error}</span>
              </div>
            )}
            {successMessage && (
              <div className="auth-alert success" role="status">
                <Icon name="checkCircle" size={18} /><span>{successMessage}</span>
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} className="auth-form">
            {isSignup && (
              <div className="auth-field">
                <label htmlFor={id('name')}>Your name</label>
                <div className="auth-input-wrap">
                  <span className="auth-input-icon"><Icon name="user" size={18} /></span>
                  <input
                    id={id('name')} className="auth-input" type="text" placeholder="e.g. Kareem"
                    value={displayName} onChange={e => setDisplayName(e.target.value)}
                    required maxLength={40} autoComplete="name" autoFocus
                  />
                </div>
              </div>
            )}

            <div className="auth-field">
              <label htmlFor={id('email')}>Email address</label>
              <div className="auth-input-wrap">
                <span className="auth-input-icon"><Icon name="mail" size={18} /></span>
                <input
                  id={id('email')} className="auth-input" type="email" placeholder="you@example.com"
                  value={email} onChange={e => setEmail(e.target.value)}
                  required autoComplete="email" autoFocus={!isSignup}
                />
              </div>
            </div>

            <div className="auth-field">
              <label htmlFor={id('pw')}>Password</label>
              <div className="auth-input-wrap">
                <span className="auth-input-icon"><Icon name="lock" size={18} /></span>
                <input
                  id={id('pw')} className="auth-input" type={showPw ? 'text' : 'password'}
                  placeholder={isSignup ? 'At least 8 characters' : 'Your password'}
                  value={password} onChange={e => setPassword(e.target.value)}
                  required minLength={isSignup ? 8 : undefined}
                  autoComplete={isSignup ? 'new-password' : 'current-password'}
                  aria-describedby={isSignup ? id('pw-hint') : undefined}
                />
                <button
                  type="button" className="auth-reveal"
                  onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw}
                >
                  <Icon name={showPw ? 'eyeOff' : 'eye'} size={18} />
                </button>
              </div>
              {isSignup && (
                <>
                  <div className="auth-strength" data-level={score} aria-hidden="true">
                    <span /><span /><span /><span />
                  </div>
                  <span id={id('pw-hint')} className="auth-hint" aria-live="polite">
                    {password ? `Strength: ${STRENGTH_LABEL[score]}` : 'Mix upper and lower case, numbers and symbols.'}
                  </span>
                </>
              )}
            </div>

            <button type="submit" className="auth-submit" disabled={isLoading}>
              {isLoading
                ? <><span className="forge-spin" />{isSignup ? 'Creating account…' : 'Signing in…'}</>
                : isSignup ? 'Create account' : 'Sign in'}
            </button>
          </form>

          <p className="auth-switch">
            {isSignup ? 'Already have an account? ' : "Don't have an account? "}
            <button type="button" onClick={() => switchMode(isSignup ? 'signin' : 'signup')}>
              {isSignup ? 'Sign in' : 'Sign up'}
            </button>
          </p>
        </div>
      </main>
    </div>
  );
};

export default AuthPage;
