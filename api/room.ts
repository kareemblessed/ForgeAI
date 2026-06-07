/**
 * Forge AI — /api/room.ts
 * Vercel serverless function that creates a Daily.co video room.
 * The DAILY_API_KEY stays server-side — never exposed to the browser.
 *
 * POST /api/room
 * Body: { roomName: string }
 * Returns: { url: string, token: string }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const DAILY_API_KEY = process.env.DAILY_API_KEY;
const DAILY_BASE_URL = 'https://api.daily.co/v1';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate auth — require Supabase JWT in Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized — missing auth token' });
  }

  if (!DAILY_API_KEY) {
    return res.status(500).json({ error: 'DAILY_API_KEY is not configured on the server' });
  }

  const { roomName } = req.body;
  if (!roomName || typeof roomName !== 'string') {
    return res.status(400).json({ error: 'roomName is required' });
  }

  try {
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
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 4, // expires in 4 hours
          max_participants: 8,
          enable_screenshare: true,
          enable_chat: false, // we use our own Supabase chat
          start_video_off: false,
          start_audio_off: false,
        },
      }),
    });

    if (!createRoomRes.ok) {
      const err = await createRoomRes.json();
      console.error('Daily.co room creation failed:', err);
      return res.status(500).json({ error: 'Failed to create video room', details: err });
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
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 4,
          is_owner: true, // first person gets owner rights
        },
      }),
    });

    const tokenData = await tokenRes.json();

    return res.status(200).json({
      url: room.url,
      token: tokenData.token,
    });

  } catch (error: any) {
    console.error('Error in /api/room:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
