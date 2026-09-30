// UserPromptSubmit hook: appends each prompt to prompts.txt in the project root.
// Must print nothing — stdout from this hook is added to Claude's context.
const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) return;
    const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    fs.appendFileSync(path.join(dir, 'prompts.txt'), `[${stamp}]\n${input.prompt}\n\n`);
  } catch {
    // Never block a prompt because logging failed.
  }
});
