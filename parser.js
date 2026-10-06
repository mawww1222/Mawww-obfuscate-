// parser.js — Lightweight structural analyzer.
// Tracks block scopes and extracts local declarations so we can safely
// rename identifiers without breaking Lua semantics.
//
// The parser does NOT need to fully evaluate Lua; it only needs to know
// where locals, parameters, and block boundaries live.

import { TOKEN } from "./lexer.js";

const BLOCK_OPENERS = new Set([
  "do", "then", "repeat", "function"
]);

function isBlockKeyword(tok) {
  if (tok.type !== TOKEN.KEYWORD) return false;
  return tok.value === "do" || tok.value === "then";
}

// Returns an array of scopes. Each scope is { parent, vars: { orig: new } , depth }.
// We only collect DECLARATIONS here; renaming happens in the transformer.
export function analyzeScopes(tokens) {
  const scopes = [];
  let current = { parent: null, vars: Object.create(null), depth: 0 };
  scopes.push(current);

  // pendingLocal: names declared by `local x, y` that become active after the
  // current statement finishes.
  let pendingLocals = [];

  // Track `function` declarations separately, since parameters belong to the
  // function body's scope.
  let pendingFunctionParams = null; // { names: [] } — becomes active on the body
  let pendingFunctionDepth = 0;
  let inFunctionHeader = 0;

  let forContext = null;

  // Simple paren/braket tracking so we can distinguish `function` expressions
  // inside argument lists.
  let parenDepth = 0;

  const flushPendingLocals = () => {
    if (pendingLocals.length) {
      for (const name of pendingLocals) {
        current.vars[name] = true;
      }
      pendingLocals = [];
    }
  };

  const pushScope = () => {
    current = { parent: current, vars: Object.create(null), depth: current.depth + 1 };
    scopes.push(current);
  };

  const popScope = () => {
    if (current.parent) current = current.parent;
  };

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (tok.type === TOKEN.COMMENT || tok.type === TOKEN.WHITESPACE) continue;

    if (tok.type === TOKEN.OPERATOR) {
      if (tok.value === "(") parenDepth++;
      else if (tok.value === ")") parenDepth = Math.max(0, parenDepth - 1);
    }

    if (tok.type === TOKEN.KEYWORD) {
      const v = tok.value;

      if (v === "local") {
        // `local function name` or `local a, b, c`
        let j = idx + 1;
        while (tokens[j] && (tokens[j].type === TOKEN.WHITESPACE || tokens[j].type === TOKEN.COMMENT)) j++;

        if (tokens[j] && tokens[j].type === TOKEN.KEYWORD && tokens[j].value === "function") {
          // local function <name>(...)
          let k = j + 1;
          while (tokens[k] && (tokens[k].type === TOKEN.WHITESPACE || tokens[k].type === TOKEN.COMMENT)) k++;
          if (tokens[k] && tokens[k].type === TOKEN.IDENT) {
            pendingLocals.push(tokens[k].value);
          }
        } else {
          // local name1, name2, name3 ...
          let k = j;
          while (tokens[k]) {
            while (tokens[k] && (tokens[k].type === TOKEN.WHITESPACE || tokens[k].type === TOKEN.COMMENT)) k++;
            if (!tokens[k]) break;
            if (tokens[k].type === TOKEN.IDENT) {
              pendingLocals.push(tokens[k].value);
              k++;
              while (tokens[k] && (tokens[k].type === TOKEN.WHITESPACE || tokens[k].type === TOKEN.COMMENT)) k++;
              if (tokens[k] && tokens[k].type === TOKEN.OPERATOR && tokens[k].value === ",") {
                k++;
                continue;
              }
            }
            break;
          }
        }
        continue;
      }

      if (v === "function") {
        // Function declaration body opens a new scope at its matching `end`.
        // The `function` keyword itself is followed by optional name and (params).
        // We push scope at the `)` and record parameters.
        let j = idx + 1;
        const params = [];
        // Skip optional function name path (foo.bar:baz)
        while (tokens[j] && (tokens[j].type === TOKEN.WHITESPACE || tokens[j].type === TOKEN.COMMENT)) j++;
        while (tokens[j] && (tokens[j].type === TOKEN.IDENT
              || (tokens[j].type === TOKEN.OPERATOR && (tokens[j].value === "." || tokens[j].value === ":")))) {
          j++;
          while (tokens[j] && (tokens[j].type === TOKEN.WHITESPACE || tokens[j].type === TOKEN.COMMENT)) j++;
        }
        if (tokens[j] && tokens[j].type === TOKEN.OPERATOR && tokens[j].value === "(") {
          j++;
          while (tokens[j]) {
            while (tokens[j] && (tokens[j].type === TOKEN.WHITESPACE || tokens[j].type === TOKEN.COMMENT)) j++;
            if (!tokens[j]) break;
            if (tokens[j].type === TOKEN.OPERATOR && tokens[j].value === ")") break;
            if (tokens[j].type === TOKEN.IDENT) {
              params.push(tokens[j].value);
            } else if (tokens[j].type === TOKEN.OPERATOR && tokens[j].value === "...") {
              // varargs, ignore
            }
            j++;
          }
        }
        // Push a new scope for the function body. Params become locals.
        flushPendingLocals();
        pushScope();
        for (const p of params) current.vars[p] = true;
        // Record vararg marker for later detection; nothing needed here.
        continue;
      }

      if (v === "do" || v === "then" || v === "repeat") {
        flushPendingLocals();
        pushScope();
        continue;
      }

      if (v === "elseif" || v === "else") {
        // Closes the current `then` block, opens a new one.
        popScope();
        flushPendingLocals();
        pushScope();
        continue;
      }

      if (v === "for") {
        // for i = 1, 10 do ... end  OR for k, v in pairs(t) do ... end
        flushPendingLocals();
        // Scan until `do` (but not through nested parens)
        let j = idx + 1;
        const names = [];
        let depth = 0;
        while (tokens[j]) {
          const t = tokens[j];
          if (t.type === TOKEN.OPERATOR) {
            if (t.value === "(") depth++;
            else if (t.value === ")") depth--;
          }
          if (depth === 0 && t.type === TOKEN.KEYWORD && t.value === "do") break;
          if (depth === 0 && t.type === TOKEN.IDENT) names.push(t.value);
          if (depth === 0 && t.type === TOKEN.KEYWORD && t.value === "in") break;
          if (depth === 0 && t.type === TOKEN.OPERATOR && t.value === "=") break;
          j++;
        }
        pushScope();
        for (const nm of names) current.vars[nm] = true;
        continue;
      }

      if (v === "while") {
        // while cond do ... end — `do` handled above
        continue;
      }

      if (v === "end") {
        flushPendingLocals();
        popScope();
        continue;
      }

      if (v === "until") {
        // repeat ... until <cond>: cond is in the scope of the repeat block,
        // so we pop AFTER consuming the until expression. For simplicity, pop here.
        flushPendingLocals();
        popScope();
        continue;
      }
    }
  }

  return scopes;
}

// Extract the set of identifiers that are ever declared as `local`.
export function collectLocalDeclarations(tokens) {
  const names = new Set();
  const scopes = analyzeScopes(tokens);
  for (const s of scopes) {
    for (const k of Object.keys(s.vars)) names.add(k);
  }
  return names;
}

// Quick syntax sanity check (unbalanced constructs).
export function checkBalanced(tokens) {
  const stack = [];
  for (const tok of tokens) {
    if (tok.type === TOKEN.COMMENT || tok.type === TOKEN.WHITESPACE) continue;
    if (tok.type === TOKEN.OPERATOR) {
      if (tok.value === "(" || tok.value === "[" || tok.value === "{") stack.push(tok);
      else if (tok.value === ")" || tok.value === "]" || tok.value === "}") {
        const expect = tok.value === ")" ? "(" : tok.value === "]" ? "[" : "{";
        const top = stack.pop();
        if (!top || top.value !== expect) {
          throw new SyntaxError(`Unbalanced '${tok.value}' at line ${tok.line}`);
        }
      }
    }
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    throw new SyntaxError(`Unclosed '${top.value}' opened at line ${top.line}`);
  }
  return true;
}

// Simple Lua syntax normalizer: mostly whitespace / line handling.
export function normalizeSource(src) {
  // Remove BOM
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
  // Replace CRLF with LF
  src = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return src;
          }
