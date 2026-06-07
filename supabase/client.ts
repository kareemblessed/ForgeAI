/**
 * Forge AI — Supabase Client
 * Single exported instance used everywhere in the app.
 * Keys are read from environment variables — never hardcode them.
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Supabase environment variables are missing. ' +
    'Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your .env.local file.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ── Type helpers ────────────────────────────────────────────

export type Profile = {
  id: string;
  display_name: string;
  avatar_color: string;
  created_at: string;
};

export type Room = {
  id: string;
  name: string;
  join_token: string;
  host_id: string;
  topic_context: any | null;
  is_active: boolean;
  daily_room_url: string | null;
  created_at: string;
};

export type RoomMember = {
  id: string;
  room_id: string;
  user_id: string;
  joined_at: string;
  profiles?: Profile;
};

export type RoomMessage = {
  id: string;
  room_id: string;
  user_id: string;
  content: string;
  created_at: string;
  profiles?: Profile;
};

export type SharedAIMessage = {
  id: string;
  room_id: string;
  asked_by: string;
  question: string;
  answer: string | null;
  created_at: string;
  profiles?: Profile;
};

export type QuizSession = {
  id: string;
  room_id: string;
  host_id: string;
  topic: string;
  questions: any[];
  is_active: boolean;
  created_at: string;
};

export type QuizAnswer = {
  id: string;
  quiz_session_id: string;
  user_id: string;
  question_index: number;
  selected_answer: string;
  is_correct: boolean;
  answered_at: string;
};

export type ProgressEntry = {
  id: string;
  user_id: string;
  topic: string;
  score: number;
  total: number;
  mode: string;
  created_at: string;
};
