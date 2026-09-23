/**
 * Forge AI — MD.tsx
 * Shared Markdown renderer used by both index.tsx and ForgeRoom.tsx.
 *
 * - Input is HTML-escaped before it is converted, so AI/user text can't inject markup
 *   (shared room answers are visible to everyone in the room).
 * - Parsing is memoised on `text`, so streaming a reply only re-parses the message
 *   that is actually changing instead of every message on each chunk.
 */
import React, { memo, useMemo } from 'react';

const escapeHtml = (s: string) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const inline = (s: string) => escapeHtml(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
  .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
  .replace(/\*(.*?)\*/g, '<em>$1</em>');

const toHtml = (text: string): string => {
  let html = '';
  let list = false;
  const closeList = () => { if (list) { html += '</ul>'; list = false; } };

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#### '))      { closeList(); html += `<h4>${inline(t.slice(5))}</h4>`; }
    else if (t.startsWith('### '))  { closeList(); html += `<h3>${inline(t.slice(4))}</h3>`; }
    else if (t.startsWith('## '))   { closeList(); html += `<h2>${inline(t.slice(3))}</h2>`; }
    else if (t.startsWith('# '))    { closeList(); html += `<h1>${inline(t.slice(2))}</h1>`; }
    else if (t.startsWith('* ') || t.startsWith('- ')) {
      if (!list) { html += '<ul>'; list = true; }
      html += `<li>${inline(t.slice(2))}</li>`;
    }
    else if (/^---\s*$/.test(t))    { closeList(); html += '<hr />'; }
    else { closeList(); if (t) html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  return html;
};

const MD: React.FC<{ text?: string; className?: string }> = ({ text, className }) => {
  const html = useMemo(() => (text ? toHtml(text) : ''), [text]);
  if (!text) return null;
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
};

export default memo(MD);
