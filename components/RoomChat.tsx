/**
 * Forge AI — RoomChat.tsx
 * Persistent room text chat using Supabase Realtime.
 */
import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../supabase/client';
import type { RoomMessage, Profile } from '../supabase/client';

type Props = {
  roomId: string;
  userId: string;
  userProfile: Profile;
};

const RoomChat: React.FC<Props> = ({ roomId, userId, userProfile }) => {
  const [messages, setMessages] = useState<(RoomMessage & { profiles: Profile })[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadMessages = async () => {
      const { data, error } = await supabase
        .from('room_messages')
        .select('*, profiles(id, display_name, avatar_color)')
        .eq('room_id', roomId)
        .order('created_at', { ascending: true })
        .limit(100);
      if (!error && data) setMessages(data as any);
    };

    loadMessages();

    const channel = supabase
      .channel(`room_chat:${roomId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${roomId}` },
        async (payload) => {
          const { data: profileData } = await supabase
            .from('profiles').select('*').eq('id', payload.new.user_id).single();
          setMessages(prev => [...prev, { ...payload.new, profiles: profileData } as any]);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [roomId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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

  const getInitials = (name: string) =>
    name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

  return (
    <div className="room-chat">
      <div className="room-chat-messages">
        {messages.length === 0 && (
          <div className="room-chat-empty">No messages yet — say hello to your study group!</div>
        )}
        {messages.map(msg => {
          const isMe = msg.user_id === userId;
          const name = msg.profiles?.display_name ?? 'Student';
          const color: string = (msg.profiles?.avatar_color as string | undefined) ?? '#534AB7';
          return (
            <div key={msg.id} className={`room-chat-msg ${isMe ? 'me' : 'them'}`}>
              {!isMe && (
                <div className="room-chat-avatar" style={{ background: color + '22', color }}>
                  {getInitials(name)}
                </div>
              )}
              <div className="room-chat-bubble-wrap">
                {!isMe && <div className="room-chat-sender">{name}</div>}
                <div className="room-chat-bubble">{msg.content}</div>
                <div className="room-chat-time">{formatTime(msg.created_at)}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form className="room-chat-form" onSubmit={handleSend}>
        <input
          type="text"
          className="room-chat-input"
          placeholder="Message the group..."
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={isSending}
          maxLength={500}
        />
        <button
          type="submit"
          className="room-chat-send-btn"
          disabled={!input.trim() || isSending}
          aria-label="Send message"
        >
          ↑
        </button>
      </form>
    </div>
  );
};

export default RoomChat;