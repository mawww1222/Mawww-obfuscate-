// utils.js — shared helpers for the obfuscator.

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function escapeLuaString(s) {
  // Convert arbitrary JS string into a Lua string literal body (without quotes).
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) out += "\\\\";
    else if (c === 0x22) out += '\\"';
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 32 || c > 126) out += "\\" + c;
    else out += s[i];
  }
  return out;
}

export function toLuaStringLiteral(s) {
  return '"' + escapeLuaString(s) + '"';
}

export function bytesToLuaString(bytes) {
  // bytes: array of integers 0-255 -> Lua string literal with decimal escapes.
  let out = '"';
  for (const b of bytes) out += "\\" + b;
  out += '"';
  return out;
}

export function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function countLines(s) {
  if (!s) return 0;
  return s.split(/\r\n|\r|\n/).length;
}

export function nowId() {
  return Math.random().toString(36).slice(2, 8);
}
