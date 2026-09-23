/**
 * Forge AI — RoomChat.tsx
 * Persistent room text chat using Supabase Realtime.
 */
import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../supabase/client';
import type { RoomMessage, Profile } from '../supabase/client';
import { Icon, Avatar } from './icons';

type Props = {
  roomId: string;
  userId: string;
  userProfile: Profile;
};

type ChatRow = RoomMessage & { profiles: Profile };

const PROFILE_COLS = 'id, display_name, avatar_color';

const RoomChat: React.FC<Props> = ({ roomId, userId }) => {
  const [messages, setMessages] = useState<ChatRow[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const profiles = useRef(new Map<string, Profile>());

  useEffect(() => {
    const loadMessages = async () => {
      const { data, error } = await supabase
        .from('room_messages')
        .select(`*, profiles(${PROFILE_COLS})`)
        .eq('room_id', roomId)
        // newest 100 (ascending + limit would return the OLDEST 100), shown oldest-first
        .order('created_at', { ascending: false })
        .limit(100);
      if (error || !data) return;
      const rows = [...data].reverse();
      for (const m of rows as any[]) if (m.profiles) profiles.current.set(m.user_id, m.profiles);
      setMessages(rows as any);
    };

    loadMessages();

    const channel = supabase
      .channel(`room_chat:${roomId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${roomId}` },
        async (payload) => {
          const row = payload.new as RoomMessage;
          // One profile lookup per sender, not per message
          let profile = profiles.current.get(row.user_id);
          if (!profile) {
            const { data } = await supabase.from('profiles').select(PROFILE_COLS).eq('id', row.user_id).single();
            if (data) { profile = data as Profile; profiles.current.set(row.user_id, profile); }
          }
          setMessages(prev => prev.some(m => m.id === row.id) ? prev : [...prev, { ...row, profiles: profile as Profile }]);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [roomId]);

  // Scroll the list, not the page (scrollIntoView would also scroll the mobile page)
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isSending) return;
    const content = input.trim();
    setInput('');
    setIsSending(true);
    const { error } = await supabase.from('room_messages').insert({ room_id: roomId, user_id: userId, content });
    if (error) { console.error('Failed to send message:', error); setInput(content); }
    setIsSending(false);
  };

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="room-chat">
      <div className="room-chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="fr-empty">
            <span className="fr-empty-icon"><Icon name="chat" size={22} /></span>
            <strong>No messages yet</strong>
            <span>Say hello to your study group!</span>
          </div>
        )}
        {messages.map((msg, i) => {
          const isMe = msg.user_id === userId;
          const name = msg.profiles?.display_name ?? 'Student';
          const color: string = (msg.profiles?.avatar_color as string | undefined) ?? '#534AB7';
          // Group consecutive messages from the same sender
          const grouped = messages[i - 1]?.user_id === msg.user_id;
          return (
            <div key={msg.id} className={`room-chat-msg ${isMe ? 'me' : 'them'}${grouped ? ' grouped' : ''}`}>
              {!isMe && (grouped
                ? <span className="room-chat-spacer" />
                : <Avatar name={name} color={color} size={28} />)}
              <div className="room-chat-bubble-wrap">
                {!isMe && !grouped && <div className="room-chat-sender">{name}</div>}
                <div className="room-chat-bubble">{msg.content}</div>
                <div className="room-chat-time">{formatTime(msg.created_at)}</div>
              </div>
            </div>
          );
        })}
      </div>

      <form className="fr-composer" onSubmit={handleSend}>
        <input
          type="text" className="fr-input" placeholder="Message the group…"
          value={input} onChange={e => setInput(e.target.value)}
          disabled={isSending} maxLength={500} aria-label="Message"
        />
        <button type="submit" className="fr-send" disabled={!input.trim() || isSending} aria-label="Send message">
          <Icon name="send" size={17} />
        </button>
      </form>
    </div>
  );
};

export default RoomChat;
