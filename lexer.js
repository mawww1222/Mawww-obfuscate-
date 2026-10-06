// lexer.js — Lua/Luau tokenizer.
// Produces a token stream used by parser and transformer.

export const TOKEN = {
  KEYWORD: "keyword",
  IDENT: "ident",
  NUMBER: "number",
  STRING: "string",
  OPERATOR: "operator",
  PUNCT: "punct",
  COMMENT: "comment",
  WHITESPACE: "ws",
  LONG_STRING: "longstring",
  EOF: "eof"
};

const KEYWORDS = new Set([
  "and","break","do","else","elseif","end","false","for","function","goto",
  "if","in","local","nil","not","or","repeat","return","then","true","until","while",
  "continue","export","type"
]);

function isAlpha(ch) { return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_"; }
function isDigit(ch) { return ch >= "0" && ch <= "9"; }
function isAlphaNum(ch) { return isAlpha(ch) || isDigit(ch); }
function isHex(ch) { return isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F"); }
function isSpace(ch) { return ch === " " || ch === "\t" || ch === "\r" || ch === "\n"; }

export class LexError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = "LexError";
    this.line = line;
    this.col = col;
  }
}

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = src.length;

  const push = (type, value) => {
    tokens.push({ type, value, line, col });
  };

  const advance = (k = 1) => {
    for (let j = 0; j < k; j++) {
      if (src[i] === "\n") { line++; col = 1; } else { col++; }
      i++;
    }
  };

  while (i < n) {
    const ch = src[i];

    // Whitespace
    if (isSpace(ch)) {
      const start = i;
      while (i < n && isSpace(src[i])) advance();
      push(TOKEN.WHITESPACE, src.slice(start, i));
      continue;
    }

    // Comment: -- ... or --[[ ... ]]
    if (ch === "-" && src[i + 1] === "-") {
      if (src[i + 2] === "[") {
        // Maybe long comment
        const level = countEquals(src, i + 3);
        if (level >= 0) {
          const openLen = 2 + level + 2; // --[[ plus =
          const closeSeq = "]" + "=".repeat(level) + "]";
          const start = i;
          advance(openLen);
          while (i < n && !src.startsWith(closeSeq, i)) advance();
          if (i >= n) throw new LexError("Unterminated long comment", line, col);
          advance(closeSeq.length);
          push(TOKEN.COMMENT, src.slice(start, i));
          continue;
        }
      }
      const start = i;
      while (i < n && src[i] !== "\n") advance();
      push(TOKEN.COMMENT, src.slice(start, i));
      continue;
    }

    // Long string [[ ... ]] or [=*[ ... ]=*]
    if (ch === "[") {
      const level = countEquals(src, i + 1);
      if (level >= 0) {
        const openLen = 1 + level + 1;
        const closeSeq = "]" + "=".repeat(level) + "]";
        const start = i;
        advance(openLen);
        while (i < n && !src.startsWith(closeSeq, i)) advance();
        if (i >= n) throw new LexError("Unterminated long string", line, col);
        advance(closeSeq.length);
        const raw = src.slice(start, i);
        // Extract inner content
        const innerStart = openLen;
        const innerEnd = raw.length - closeSeq.length;
        const inner = raw.slice(innerStart, innerEnd);
        push(TOKEN.LONG_STRING, inner);
        continue;
      }
    }

    // String (single or double quoted)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      advance();
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (c === "\\") { advance(2); continue; }
        if (c === quote) { advance(); closed = true; break; }
        if (c === "\n") break;
        advance();
      }
      if (!closed) throw new LexError("Unterminated string", line, col);
      push(TOKEN.STRING, src.slice(start, i));
      continue;
    }

    // Number
    if (isDigit(ch) || (ch === "." && isDigit(src[i + 1]))) {
      const start = i;
      // hex
      if (ch === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        advance(2);
        while (i < n && (isHex(src[i]) || src[i] === ".")) advance();
        if (src[i] === "p" || src[i] === "P") {
          advance();
          if (src[i] === "+" || src[i] === "-") advance();
          while (i < n && isDigit(src[i])) advance();
        }
      } else {
        while (i < n && (isDigit(src[i]) || src[i] === ".")) advance();
        if (src[i] === "e" || src[i] === "E") {
          advance();
          if (src[i] === "+" || src[i] === "-") advance();
          while (i < n && isDigit(src[i])) advance();
        }
        // Lua 5.3+ integer suffix LL / ULL
        if (src[i] === "L" || src[i] === "l") advance();
        if (src[i] === "L" || src[i] === "l") advance();
        if (src[i] === "U" || src[i] === "u") advance();
      }
      push(TOKEN.NUMBER, src.slice(start, i));
      continue;
    }

    // Identifier / keyword
    if (isAlpha(ch)) {
      const start = i;
      while (i < n && (isAlphaNum(src[i]))) advance();
      const word = src.slice(start, i);
      if (KEYWORDS.has(word)) push(TOKEN.KEYWORD, word);
      else push(TOKEN.IDENT, word);
      continue;
    }

    // Operators / punctuation — multi-char first
    const three = src.substr(i, 3);
    if (three === "...") { push(TOKEN.OPERATOR, "..."); advance(3); continue; }
    if (three === "..=") { push(TOKEN.OPERATOR, "..="); advance(3); continue; }
    if (three === "//=") { push(TOKEN.OPERATOR, "//="); advance(3); continue; }
    if (three === ">>=" ) { push(TOKEN.OPERATOR, ">>="); advance(3); continue; }
    if (three === "<<=" ) { push(TOKEN.OPERATOR, "<<="); advance(3); continue; }

    const two = src.substr(i, 2);
    if (["==","~=","<=",">=","..","::","//","<<",">>","+=","-=","*=","/=","%=","^=","&=","|="].includes(two)) {
      push(TOKEN.OPERATOR, two); advance(2); continue;
    }

    if ("+-*/%^#=<>;:,.(){}[]&|~".includes(ch)) {
      push(TOKEN.OPERATOR, ch);
      advance();
      continue;
    }

    // Unknown character — emit as operator so downstream can still proceed
    push(TOKEN.OPERATOR, ch);
    advance();
  }

  push(TOKEN.EOF, "");
  return tokens;
}

function countEquals(src, start) {
  let k = start;
  let count = 0;
  while (src[k] === "=") { count++; k++; }
  if (src[k] === "[") return count;
  return -1;
  }
