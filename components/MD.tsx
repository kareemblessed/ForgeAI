/**
 * Forge AI — MD.tsx
 * Shared Markdown renderer used by both index.tsx and ForgeRoom.tsx
 */
import React from 'react';

const MD: React.FC<{ text?: string; className?: string }> = ({ text, className }) => {
  if (!text) return null;
  const inline = (s: string) => s
    .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
  const lines = text.split('\n');
  let html = '', list = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#### ')) { if (list) { html += '</ul>'; list = false; } html += `<h4>${inline(t.slice(5))}</h4>`; }
    else if (t.startsWith('### '))  { if (list) { html += '</ul>'; list = false; } html += `<h3>${inline(t.slice(4))}</h3>`; }
    else if (t.startsWith('## '))   { if (list) { html += '</ul>'; list = false; } html += `<h2>${inline(t.slice(3))}</h2>`; }
    else if (t.startsWith('# '))    { if (list) { html += '</ul>'; list = false; } html += `<h1>${inline(t.slice(2))}</h1>`; }
    else if (t.startsWith('* '))    { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(t.slice(2))}</li>`; }
    else if (/^---\s*$/.test(t))    { if (list) { html += '</ul>'; list = false; } html += '<hr />'; }
    else { if (list) { html += '</ul>'; list = false; } if (t) html += `<p>${inline(line)}</p>`; }
  }
  if (list) html += '</ul>';
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
};

export default MD;