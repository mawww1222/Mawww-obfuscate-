// transformer.js — Applies safe identifier renaming and string encoding
// to a token stream, then rebuilds the source.

import { TOKEN } from "./lexer.js";
import { escapeLuaString } from "./utils.js";

const LUA_KEYWORDS = new Set([
  "and","break","do","else","elseif","end","false","for","function","goto",
  "if","in","local","nil","not","or","repeat","return","then","true","until","while",
  "continue","export","type"
]);

const GLOBALS_WHITELIST = new Set([
  "print","warn","error","assert","pcall","xpcall","select","type","typeof","tonumber",
  "tostring","ipairs","pairs","next","unpack","table","string","math","os","io","coroutine",
  "task","game","workspace","script","wait","spawn","delay","tick","load","loadstring",
  "require","getfenv","setfenv","getmetatable","setmetatable","rawget","rawset","rawequal",
  "rawlen","_G","_ENV","self","bit","bit32","utf8","debug","newproxy","Instance","Vector3",
  "CFrame","Color3","UDim2","Enum","Ray","Region3","NumberSequence","ColorSequence","TweenInfo",
  "BrickColor","Faces","Axes","Rect","Random","DateTime","PhysicalProperties","NumberRange",
  "HttpService","RunService","UserInputService","Players","ReplicatedStorage","ServerStorage",
  "ServerScriptService","TweenService","CollectionService","SoundService","TeleportService",
  "VirtualUser","VirtualInputManager","GuiService","Stats","Lighting","CoreGui",
  "tick","time","os","math","string","table","coroutine","debug","utf8"
]);

// Compute a rename map by analyzing scopes. We only rename identifiers that
// are declared as local, and we handle shadowing by walking scopes.
export function buildRenameMap(tokens, genFn) {
  // Build scopes with explicit names collected, then walk tokens again and
  // map each identifier reference to a unique new name per declaration.
  //
  // Because Lua allows references BEFORE a local declaration to resolve to
  // the enclosing scope, our simplest safe policy is:
  //   - rename identifier only if its name is declared as local SOMEWHERE
  //     in the current active scope stack at the point of the reference.
  //
  // We recompute the active scope state while walking tokens to keep it correct.
  const scopes = [{ parent: null, map: Object.create(null), named: false }];
  let current = scopes[0];
  let pendingLocals = [];
  let pendingRename = []; // [{ name, newName, scope }]

  const renameMap = new Map(); // token index -> new name

  const pushScope = () => {
    current = { parent: current, map: Object.create(null), named: true };
  };
  const popScope = () => { if (current.parent) current = current.parent; };

  const lookup = (name) => {
    let s = current;
    while (s) {
      if (s.map[name]) return s.map[name];
      s = s.parent;
    }
    return null;
  };

  const flushPending = () => {
    if (!pendingLocals.length) return;
    for (const item of pendingRename) {
      current.map[item.name] = item.newName;
    }
    pendingLocals = [];
    pendingRename = [];
  };

  // First pass: record tokens that are identifiers, along with which scope
  // they resolve in and whether they're a local.
  let i = 0;
  const n = tokens.length;

  const pushLocalRename = (name) => {
    if (!name) return;
    if (!pendingLocals.includes(name)) {
      pendingLocals.push(name);
      pendingRename.push({ name, newName: genFn() });
    }
  };

  while (i < n) {
    const tok = tokens[i];
    if (tok.type === TOKEN.COMMENT || tok.type === TOKEN.WHITESPACE || tok.type === TOKEN.EOF) { i++; continue; }

    if (tok.type === TOKEN.KEYWORD) {
      const v = tok.value;

      if (v === "local") {
        let j = i + 1;
        while (tokens[j] && (tokens[j].type === TOKEN.WHITESPACE || tokens[j].type === TOKEN.COMMENT)) j++;
        if (tokens[j] && tokens[j].type === TOKEN.KEYWORD && tokens[j].value === "function") {
          // local function <name>
          let k = j + 1;
          while (tokens[k] && (tokens[k].type === TOKEN.WHITESPACE || tokens[k].type === TOKEN.COMMENT)) k++;
          if (tokens[k] && tokens[k].type === TOKEN.IDENT) {
            pushLocalRename(tokens[k].value);
            renameMap.set(k, pendingRename[pendingRename.length - 1].newName);
          }
        } else {
          let k = j;
          while (tokens[k]) {
            while (tokens[k] && (tokens[k].type === TOKEN.WHITESPACE || tokens[k].type === TOKEN.COMMENT)) k++;
            if (!tokens[k]) break;
            if (tokens[k].type === TOKEN.IDENT) {
              pushLocalRename(tokens[k].value);
              renameMap.set(k, pendingRename[pendingRename.length - 1].newName);
              k++;
              while (tokens[k] && (tokens[k].type === TOKEN.WHITESPACE || tokens[k].type === TOKEN.COMMENT)) k++;
              if (tokens[k] && tokens[k].type === TOKEN.OPERATOR && tokens[k].value === ",") { k++; continue; }
            }
            break;
          }
        }
        i++;
        continue;
      }

      if (v === "function") {
        // Capture params to new scope
        let j = i + 1;
        while (tokens[j] && (tokens[j].type === TOKEN.WHITESPACE || tokens[j].type === TOKEN.COMMENT)) j++;
        // Optional name path
        while (tokens[j] && (tokens[j].type === TOKEN.IDENT
              || (tokens[j].type === TOKEN.OPERATOR && (tokens[j].value === "." || tokens[j].value === ":")))) {
          j++;
          while (tokens[j] && (tokens[j].type === TOKEN.WHITESPACE || tokens[j].type === TOKEN.COMMENT)) j++;
        }
        const params = [];
        const paramIdxs = [];
        if (tokens[j] && tokens[j].type === TOKEN.OPERATOR && tokens[j].value === "(") {
          j++;
          while (tokens[j]) {
            while (tokens[j] && (tokens[j].type === TOKEN.WHITESPACE || tokens[j].type === TOKEN.COMMENT)) j++;
            if (!tokens[j]) break;
            if (tokens[j].type === TOKEN.OPERATOR && tokens[j].value === ")") break;
            if (tokens[j].type === TOKEN.IDENT) {
              params.push(tokens[j].value);
              paramIdxs.push(j);
            }
            j++;
          }
        }
        flushPending();
        pushScope();
        for (let k = 0; k < params.length; k++) {
          const newName = genFn();
          current.map[params[k]] = newName;
          renameMap.set(paramIdxs[k], newName);
        }
        i++;
        continue;
      }

      if (v === "do" || v === "then" || v === "repeat") {
        flushPending();
        pushScope();
        i++;
        continue;
      }

      if (v === "elseif" || v === "else") {
        popScope();
        flushPending();
        pushScope();
        i++;
        continue;
      }

      if (v === "for") {
        flushPending();
        // Collect names
        let j = i + 1;
        const names = [];
        const nameIdxs = [];
        let depth = 0;
        while (tokens[j]) {
          const t = tokens[j];
          if (t.type === TOKEN.OPERATOR) {
            if (t.value === "(") depth++;
            else if (t.value === ")") depth--;
          }
          if (depth === 0 && t.type === TOKEN.KEYWORD && t.value === "do") break;
          if (depth === 0 && t.type === TOKEN.KEYWORD && t.value === "in") break;
          if (depth === 0 && t.type === TOKEN.OPERATOR && t.value === "=") break;
          if (depth === 0 && t.type === TOKEN.IDENT) {
            names.push(t.value);
            nameIdxs.push(j);
          }
          j++;
        }
        pushScope();
        for (let k = 0; k < names.length; k++) {
          const newName = genFn();
          current.map[names[k]] = newName;
          renameMap.set(nameIdxs[k], newName);
        }
        i++;
        continue;
      }

      if (v === "end") {
        flushPending();
        popScope();
        i++;
        continue;
      }

      if (v === "until") {
        flushPending();
        popScope();
        i++;
        continue;
      }

      i++;
      continue;
    }

    // Identifier reference: rename if it resolves to a local.
    if (tok.type === TOKEN.IDENT) {
      const mapped = lookup(tok.value);
      if (mapped) renameMap.set(i, mapped);
    }

    i++;
  }

  return renameMap;
}

// Apply the rename map and (optionally) encode string literals.
export function applyTransform(tokens, options) {
  const {
    renameMap = new Map(),
    encodeStrings = false,
    stringEncoder = null,        // function(str, salt) -> array of bytes
    stringSalt = 0,
    stringsCollector = null,     // optional array to push decoded string references
  } = options;

  const pieces = [];
  const replacements = []; // { placeholder, decodedString }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === TOKEN.EOF) continue;

    if (tok.type === TOKEN.COMMENT) {
      // Keep comments out of the output — they don't affect semantics.
      // (We still emit a single space to avoid merging tokens.)
      pieces.push(" ");
      continue;
    }

    if (tok.type === TOKEN.WHITESPACE) {
      // Collapse to single space when needed; keep it simple with "\n" preserved.
      if (tok.value.includes("\n")) pieces.push("\n");
      else pieces.push(" ");
      continue;
    }

    if (renameMap.has(i)) {
      pieces.push(renameMap.get(i));
      continue;
    }

    if (encodeStrings && (tok.type === TOKEN.STRING || tok.type === TOKEN.LONG_STRING)) {
      const inner = extractStringInner(tok);
      const placeholder = `__MSTR_${replacements.length}__`;
      replacements.push({ placeholder, inner, raw: tok.value, type: tok.type });
      pieces.push(placeholder);
      continue;
    }

    pieces.push(tok.value);
  }

  let rebuilt = pieces.join("");

  return { source: rebuilt, stringReplacements: replacements };
}

function extractStringInner(tok) {
  if (tok.type === TOKEN.LONG_STRING) return tok.value;
  const raw = tok.value;
  const quote = raw[0];
  let body = raw.slice(1, -1);
  return unescapeLuaString(body);
}

export function unescapeLuaString(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") { out += s[i]; continue; }
    const next = s[i + 1];
    if (next === "n") { out += "\n"; i++; }
    else if (next === "r") { out += "\r"; i++; }
    else if (next === "t") { out += "\t"; i++; }
    else if (next === "\\") { out += "\\"; i++; }
    else if (next === '"') { out += '"'; i++; }
    else if (next === "'") { out += "'"; i++; }
    else if (next === "0" || (next >= "0" && next <= "9")) {
      let num = "";
      let j = i + 1;
      let count = 0;
      while (count < 3 && s[j] >= "0" && s[j] <= "9") { num += s[j]; j++; count++; }
      out += String.fromCharCode(parseInt(num, 10) & 0xff);
      i = j - 1;
    }
    else if (next === "x") {
      let hex = s.substr(i + 2, 2);
      out += String.fromCharCode(parseInt(hex, 16) & 0xff);
      i += 3;
    }
    else if (next === "z") {
      // skip following whitespace
      let j = i + 2;
      while (j < s.length && /\s/.test(s[j])) j++;
      i = j - 1;
    }
    else if (next !== undefined) { out += next; i++; }
  }
  return out;
        }
