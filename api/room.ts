/**
 * Forge AI — /api/room.ts
 * Vercel serverless function that creates a Daily.co video room.
 * The DAILY_API_KEY stays server-side — never exposed to the browser.
 *
 * POST /api/room
 * Headers: Authorization: Bearer <Supabase access token>
 * Body: { roomName: string }
 * Returns: { url: string, token: string }
 *
 * Env (server): DAILY_API_KEY, and SUPABASE_URL + SUPABASE_ANON_KEY
 * (the VITE_ prefixed copies are accepted as a fallback).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const DAILY_API_KEY = process.env.DAILY_API_KEY;
const DAILY_BASE_URL = 'https://api.daily.co/v1';
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;

// Daily room names: letters, digits, "-" and "_"
const ROOM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** Asks Supabase Auth whether this access token belongs to a real, signed-in user. */
async function verifyUser(accessToken: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: SUPABASE_ANON_KEY as string },
  });
  return res.ok;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Require a valid Supabase session. (Checking that a header merely exists would let
  // anyone create rooms on our Daily.co account.)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized — missing auth token' });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY are not configured on the server' });
  }
  try {
    if (!(await verifyUser(authHeader.slice('Bearer '.length)))) {
      return res.status(401).json({ error: 'Unauthorized — invalid or expired session' });
    }
  } catch {
    return res.status(502).json({ error: 'Could not verify session' });
  }

  if (!DAILY_API_KEY) {
    return res.status(500).json({ error: 'DAILY_API_KEY is not configured on the server' });
  }

  const roomName = (req.body as { roomName?: unknown } | undefined)?.roomName;
  if (typeof roomName !== 'string' || !ROOM_NAME.test(roomName)) {
    return res.status(400).json({ error: 'roomName must be 1–63 characters: letters, digits, "-" or "_"' });
  }

  try {
    const expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 4; // 4 hours

    // 1. Create the Daily.co room
    const createRoomRes = await fetch(`${DAILY_BASE_URL}/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DAILY_API_KEY}`,
      },
      body: JSON.stringify({
        name: roomName,
        properties: {
          exp: expiry,
          max_participants: 8,
          enable_screenshare: true,
          enable_chat: false, // we use our own Supabase chat
          start_video_off: false,
          start_audio_off: false,
        },
      }),
    });

    if (!createRoomRes.ok) {
      console.error('Daily.co room creation failed:', await createRoomRes.text());
      return res.status(502).json({ error: 'Failed to create video room' });
    }

    const room = await createRoomRes.json();

    // 2. Create a meeting token for this room
    const tokenRes = await fetch(`${DAILY_BASE_URL}/meeting-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DAILY_API_KEY}`,
      },
      body: JSON.stringify({
        properties: {
          room_name: roomName,
          exp: expiry,
          is_owner: true, // the creator gets owner rights
        },
      }),
    });

    if (!tokenRes.ok) {
      console.error('Daily.co token creation failed:', await tokenRes.text());
      return res.status(502).json({ error: 'Failed to create video token' });
    }
    const tokenData = await tokenRes.json();

    return res.status(200).json({
      url: room.url,
      token: tokenData.token,
    });

  } catch (error: unknown) {
    console.error('Error in /api/room:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
