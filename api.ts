/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forge AI — api.ts
 * Original CrammAI functions kept exactly as-is.
 * Two new functions added at the bottom for Forge AI room features.
 */

/// <reference types="vite/client" />

import { GoogleGenAI, Part, Type, Chat, LiveServerMessage, Modality, Blob, GenerateContentResponse } from "@google/genai";

// --- TYPE DEFINITIONS ---
export type Mode = 'calm' | 'warn' | 'zoom';

export interface MnemonicResult {
  title: string;
  mnemonic_word: string;
  description: string;
  breakdown: string[];
}

export interface Topic {
  topic: string;
  reason: string;
  key_points?: string[];
  notes?: string;
  mnemonic?: MnemonicResult;
}

export interface AnalysisResult {
  study_these: Topic[];
}

export interface QuizQuestion {
  question: string;
  options: string[];
  correct_answer: string;
  explanation: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  imageUrl?: string;
}

export interface LiveCallbacks {
  onopen: () => void;
  onmessage: (message: LiveServerMessage) => void;
  onerror: (event: ErrorEvent) => void;
  onclose: (event: CloseEvent) => void;
}

declare global {
  interface Window {
    ai?: {
      canCreateTextSession: () => Promise<'readily' | 'after-prompt' | 'no'>;
      createTextSession: () => Promise<{
        prompt: (prompt: string) => Promise<string>;
        destroy: () => void;
      }>;
    };
  }
}

// --- API INITIALIZATION ---
// FIX 1: `/// <reference types="vite/client" />` at the top of the file
// resolves "Property 'env' does not exist on type 'ImportMeta'" (ts2339)
const GEMINI_API_KEY = (import.meta.env.VITE_GEMINI_API_KEY as string) || "";

if (!GEMINI_API_KEY) {
  console.warn("GEMINI_API_KEY is missing. Add VITE_GEMINI_API_KEY to your .env.local");
} else {
  console.log("Gemini API Key detected.");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- HELPERS ---
const fileToGenerativePart = (file: File): Promise<Part> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve({ inlineData: { mimeType: file.type, data: dataUrl.split(',')[1] } });
    };
    reader.onerror = error => reject(error);
  });

const getPromptForMode = (mode: Mode): string => {
  switch (mode) {
    case 'zoom':
      return "My exam is tonight. I need a tactical strike plan. Analyze these documents like a football playbook. Identify the critical 'plays'—the topics and concepts with the highest scoring potential. Give me a concise, high-impact briefing. No fluff, just strategy.";
    case 'warn':
      return "My exam is in the next couple of days. I need an efficient and focused study plan. Please analyze these materials and prioritize the most important topics. The goal is to be strategic and cover the highest-impact areas effectively.";
    case 'calm':
    default:
      return "I have over a week until my exam, so I want a comprehensive study plan. Please analyze these documents and structure a thorough plan that covers all key areas, prioritized by importance.";
  }
};

// --- AUDIO HELPERS ---
export function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function createBlob(data: Float32Array): Blob {
  const int16 = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) int16[i] = data[i] * 32768;
  return { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
}

export function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

export const extractYoutubeId = (url: string): string | null => {
  const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
  const match = url.match(regExp);
  return match && match[7].length === 11 ? match[7] : null;
};

export const apiFetchYoutubeTranscript = async (url: string): Promise<string> => {
  const videoId = extractYoutubeId(url);
  if (!videoId) throw new Error("Invalid YouTube URL.");
  const response = await fetch(`/api/transcript?videoId=${videoId}`);
  if (!response.ok) {
    const errorData = await response.json() as { error?: string };
    throw new Error(errorData.error ?? "Failed to fetch transcript.");
  }
  const data = await response.json() as { transcript: string };
  return data.transcript;
};

// --- STUDY PLAN ---
export const apiGenerateStudyPlan = async (
  mode: Mode,
  files: File[],
  youtubeUrl?: string,
  youtubeTranscript?: string
): Promise<AnalysisResult> => {
  const fileParts = await Promise.all(files.map(fileToGenerativePart));
  const prompt = getPromptForMode(mode);
  let requestParts: Part[] = [...fileParts, { text: prompt }];
  let useGrounding = false;

  if (youtubeTranscript) {
    requestParts.unshift({ text: `YouTube Video Transcript:\n${youtubeTranscript}` });
  } else if (youtubeUrl) {
    useGrounding = true;
    requestParts.unshift({ text: `No transcript for: ${youtubeUrl}. Use search to research this video.` });
  }

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      study_these: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            topic: { type: Type.STRING },
            reason: { type: Type.STRING },
            key_points: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["topic", "reason"],
        },
      },
    },
  };

  const config: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseSchema,
  };
  if (useGrounding) config.tools = [{ googleSearch: {} }];

  const MAX_RETRIES = 5;
  let currentTranscript = youtubeTranscript;

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      if (i > 0 && currentTranscript && currentTranscript.length > 3000) {
        currentTranscript = currentTranscript.substring(0, 3000) + "... [truncated]";
        requestParts = [...fileParts, { text: prompt }, { text: `Context:\n${currentTranscript}` }];
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [{ role: 'user', parts: requestParts }],
        config,
      });

      let resultText = response.text?.trim() ?? '';
      if (!resultText) throw new Error("Empty response from AI.");
      resultText = resultText.replace(/^```json\s*/, '').replace(/```$/, '');
      const result = JSON.parse(resultText) as AnalysisResult;
      if (!result?.study_these || !Array.isArray(result.study_these)) {
        throw new Error("Unexpected data format from AI.");
      }
      return result;

    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const isQuota = msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota") || msg.includes("429");

      if (isQuota) {
        if (i === MAX_RETRIES - 1) throw new Error("Quota exceeded. Please try again in 2 minutes.");
        await new Promise(r => setTimeout(r, Math.pow(2, i) * 6000));
        continue;
      }

      if (i === MAX_RETRIES - 1) throw new Error(`AI error: ${msg}`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }

  throw new Error("Failed after multiple attempts.");
};

// --- STUDY NOTES ---
export const apiGenerateStudyNotes = async (topic: Topic): Promise<string> => {
  const prompt = `You are an expert educator. Create a high-quality study guide for: "${topic.topic}".

Formatting rules:
- NO LaTeX. Use plain text with Unicode characters.
- Use ***bold italic*** for equations and formulas.
- Use × for multiplication, − for minus, ° for degrees.
- Write fractions as (numerator / denominator).
- Use unicode subscripts/superscripts (e.g. ₁, ², ⁻¹).
- Use ## for section headers, * for bullet lists.

Structure:
### 🔎 Topic Overview
Brief summary.
---
#### Key Concept: [Name]
* **Core Idea:** explanation
* **Details:** key facts

Focus on: ${topic.key_points?.join(', ') || 'main concepts'}.
Start directly with the first heading.`;

  if (typeof window.ai?.canCreateTextSession === 'function') {
    try {
      const canCreate = await window.ai.canCreateTextSession();
      if (canCreate === 'readily') {
        const session = await window.ai.createTextSession();
        const result = await session.prompt(prompt);
        if (result?.trim().length > 20) return result;
      }
    } catch (e) {
      console.warn("On-device AI failed, falling back:", e);
    }
  }

  for (let i = 0; i < 3; i++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });
      const text = response.text ?? '';
      if (text.trim().length > 20) return text;
    } catch (error) {
      if (i === 2) throw error;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }

  throw new Error("Failed to generate study notes.");
};

// --- MNEMONIC ---
export const apiGenerateMnemonic = async (
  topic: string,
  previous_word?: string
): Promise<{ mnemonic_result: MnemonicResult }> => {
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      mnemonic_result: {
        type: Type.OBJECT,
        properties: {
          mnemonic_word: { type: Type.STRING },
          description: { type: Type.STRING },
          breakdown: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["mnemonic_word", "description", "breakdown"],
      },
    },
  };

  const extra = previous_word ? `Generate a different mnemonic than "${previous_word}".` : '';

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-lite',
    contents: [{ role: 'user', parts: [{ text: `Create a mnemonic for: "${topic}". ${extra}` }] }],
    config: { responseMimeType: "application/json", responseSchema },
  });

  // FIX 2 & 3: Separate the nullish coalesce from the string methods to avoid
  // "Object is possibly undefined" and "string | undefined not assignable to string"
  const rawText = response.text ?? '';
  const resultText = rawText.trim().replace(/^```json\s*/, '').replace(/```$/, '');

  const parsed = JSON.parse(resultText) as Record<string, unknown>;

  // FIX 4: Use `unknown` as an intermediate cast to safely convert
  // 'Record<string, unknown>' to 'MnemonicResult' without a type overlap error
  if (parsed.mnemonic_result) {
    return parsed as unknown as { mnemonic_result: MnemonicResult };
  }
  return { mnemonic_result: parsed as unknown as MnemonicResult };
};

// --- PRACTICE QUIZ ---
export const apiGeneratePracticeQuiz = async (topic: Topic): Promise<QuizQuestion[]> => {
  const prompt = `Create a 5-question multiple-choice quiz on "${topic.topic}". Key points: ${topic.key_points?.join(', ') ?? 'main concepts'}. Each question needs 4 options, one correct answer, and a brief explanation. University-level difficulty.`;

  const responseSchema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        question: { type: Type.STRING },
        options: { type: Type.ARRAY, items: { type: Type.STRING } },
        correct_answer: { type: Type.STRING },
        explanation: { type: Type.STRING },
      },
      required: ["question", "options", "correct_answer", "explanation"],
    },
  };

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { responseMimeType: 'application/json', responseSchema },
  });

  const rawText = response.text ?? '';
  const resultText = rawText.trim().replace(/^```json\s*/, '').replace(/```$/, '');
  return JSON.parse(resultText) as QuizQuestion[];
};

// --- QUIZ REFLECTION ---
export const apiGenerateQuizReflection = async (
  topic: Topic,
  score: number,
  total: number,
  incorrectQuestions: QuizQuestion[]
): Promise<string> => {
  const prompt = incorrectQuestions.length === 0
    ? `A student scored ${total}/${total} on "${topic.topic}". Write a 45-word positive reflection.`
    : `A student scored ${score}/${total} on "${topic.topic}". They missed: ${incorrectQuestions.map(q => `"${q.question}"`).join(', ')}. Write a 45-word encouraging reflection highlighting areas to review.`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-lite',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
  return response.text ?? '';
};

// --- CHAT ---
export const apiCreateChatForTopic = (topic: Topic): Chat | null => {
  if (!topic.notes) return null;
  return ai.chats.create({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: `You are an expert study assistant. Answer questions based only on the study notes for "${topic.topic}". Be concise and helpful.\n\nSTUDY NOTES:\n${topic.notes}`,
    },
    history: [],
  });
};

export const apiChatWithDocumentsStream = async (
  chat: Chat,
  message: string,
  imageFile?: File
): Promise<AsyncGenerator<GenerateContentResponse>> => {
  if (!chat) throw new Error("Chat not initialised.");

  const wordLimit = imageFile ? 250 : 230;
  const fullMessage = `${message}\n\n(Keep response under ~${wordLimit} words.)`;
  const messageParts: Part[] = [{ text: fullMessage }];

  if (imageFile) {
    const imagePart = await fileToGenerativePart(imageFile);
    messageParts.unshift(imagePart);
  }

  return chat.sendMessageStream({ message: messageParts });
};

// --- LIVE TUTOR ---
export const apiConnectLiveTutor = (topic: Topic, callbacks: LiveCallbacks): Promise<unknown> => {
  const systemInstruction = `You are an enthusiastic AI tutor named Forge AI. Help the student master "${topic.topic}".
- Welcome them warmly.
- Ask questions to check understanding.
- Stay focused on their study notes.
- Keep responses concise for fast-paced dialogue.
- Be encouraging and Socratic.

STUDY NOTES:\n${topic.notes ?? 'No notes provided. Use general knowledge for this topic.'}`;

  return ai.live.connect({
    model: 'gemini-3.1-flash-live-preview',
    callbacks,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
      systemInstruction,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  });
};