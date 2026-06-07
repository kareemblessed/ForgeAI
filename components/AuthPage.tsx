/**
 * Forge AI — AuthPage.tsx
 * Email + password sign up / sign in using Supabase Auth.
 * Matches the Forge AI design system.
 */
import React, { useState } from 'react';
import { supabase } from '../supabase/client';

type AuthMode = 'signin' | 'signup';

const AuthPage: React.FC = () => {
  const [authMode, setAuthMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      if (authMode === 'signup') {
        if (!displayName.trim()) {
          setError('Please enter your name.');
          setIsLoading(false);
          return;
        }

        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: displayName.trim() },
          },
        });

        if (signUpError) throw signUpError;
        setSuccessMessage('Account created! Check your email to confirm, then sign in.');
        setAuthMode('signin');

      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
        // Session is set — App.tsx auth listener will pick this up automatically
      }
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        {/* Logo */}
        <div className="auth-logo">
          <div className="auth-logo-icon">⚡</div>
          <span className="auth-logo-text">Forge AI</span>
        </div>

        <h1 className="auth-title">
          {authMode === 'signin' ? 'Welcome back' : 'Create your account'}
        </h1>
        <p className="auth-subtitle">
          {authMode === 'signin'
            ? 'Sign in to continue your study session.'
            : 'Join Forge AI and study smarter, together.'}
        </p>

        {error && <div className="auth-error">{error}</div>}
        {successMessage && <div className="auth-success">{successMessage}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          {authMode === 'signup' && (
            <div className="auth-field">
              <label htmlFor="displayName">Your name</label>
              <input
                id="displayName"
                type="text"
                placeholder="e.g. Kareem"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                required
                autoComplete="name"
              />
            </div>
          )}

          <div className="auth-field">
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder={authMode === 'signup' ? 'At least 8 characters' : 'Your password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={authMode === 'signup' ? 8 : undefined}
              autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
            />
          </div>

          <button
            type="submit"
            className="auth-submit-button"
            disabled={isLoading}
          >
            {isLoading
              ? 'Please wait...'
              : authMode === 'signin'
              ? 'Sign in'
              : 'Create account'}
          </button>
        </form>

        <div className="auth-toggle">
          {authMode === 'signin' ? (
            <>
              Don't have an account?{' '}
              <button onClick={() => { setAuthMode('signup'); setError(null); }}>
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button onClick={() => { setAuthMode('signin'); setError(null); }}>
                Sign in
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default AuthPage;
