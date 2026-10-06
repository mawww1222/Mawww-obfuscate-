// string-encoder.js — String encryption/encoding used across presets.
// Each preset decides how aggressive the encoding is.
//
// Encoder layers (in order):
//   1) XOR with rolling key:  working[i] = byte[i] ^ ((salt + i*31) & 0xff)
//   2) reverse the byte array
//   3) XOR with per-position salt2: working[i] = working[i] ^ ((salt2 + i) & 0xff)
//
// The decoder reverses each layer in reverse order. Layer 1 must be undone
// using the ORIGINAL byte index (i-1), not the reversed index (n-i).

import { escapeLuaString } from "./utils.js";

// XOR helper used by both encoder and (mirrored) decoder.
export function xorEncode(bytes, key) {
  const out = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = (bytes[i] ^ ((key + i * 31) & 0xff)) & 0xff;
  }
  return out;
}

export function xorDecode(encoded, key) {
  const out = new Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) {
    out[i] = (encoded[i] ^ ((key + i * 31) & 0xff)) & 0xff;
  }
  return out;
}

// Multi-layer encode:
//   Layer 1: XOR with rolling key (original index based)
//   Layer 2: reverse byte order
//   Layer 3: XOR with position-dependent salt2
//
// Correctness contract (must match luaDecodeReverse and the inline decoder
// emitted by vm-generator.js):
//   bytes[j] = enc[n-1-j] ^ ((salt2 + (n-1-j)) & 0xff) ^ ((salt + j*31) & 0xff)
export function layeredEncode(str, salt) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff);

  // Layer 1 — XOR with rolling key (index = original byte index).
  let working = xorEncode(bytes, salt);

  // Layer 2 — reverse.
  working.reverse();

  // Layer 3 — XOR with position-dependent salt2.
  const salt2 = (salt * 131 + 17) & 0xff;
  for (let i = 0; i < working.length; i++) {
    working[i] = (working[i] ^ ((salt2 + i) & 0xff)) & 0xff;
  }

  return working;
}

// Emit a Lua array literal of numbers, compacted into groups for readability.
export function emitEncodedBytes(bytes) {
  return "{" + bytes.join(",") + "}";
}

// Emit a Lua string literal from bytes using decimal escapes.
// Example: [72, 101, 108] -> "\72\101\108"
export function emitByteString(bytes) {
  let out = '"';
  for (const b of bytes) out += "\\" + b;
  out += '"';
  return out;
}

// Runtime Lua XOR-of-byte-string decoder.
// NOTE: This helper is a reference implementation used by external callers;
// the obfuscator itself emits an inline decoder via vm-generator.js.
export function luaDecodeFunction(nameDecoder, nameStr, nameKey) {
  // function <nameDecoder>(s, k)
  //   local out, i, n = {}, 1, #s
  //   while i <= n do
  //     out[i] = string.char(bit32.bxor(string.byte(s,i), (k + (i-1)*31) % 256))
  //     i = i + 1
  //   end
  //   return table.concat(out)
  // end
  return `
local function ${nameDecoder}(${nameStr}, ${nameKey})
  local r, i, n = {}, 1, #${nameStr}
  while i <= n do
    r[i] = string.char(bit32.bxor(string.byte(${nameStr}, i), (${nameKey} + (i - 1) * 31) % 256))
    i = i + 1
  end
  return table.concat(r)
end
`.trim();
}

// Runtime Lua layered decoder — FIXED to use (i-1)*31 for the rolling XOR.
export function luaDecodeReverse(nameDecoder, nameBytes, nameSalt) {
  // function <nameDecoder>(arr, salt)
  //   local out = {}
  //   local n = #arr
  //   local s2 = (salt * 131 + 17) % 256
  //   for i = 1, n do
  //     local b = arr[n - i + 1]
  //     b = bit32.bxor(b, (s2 + (n - i)) % 256)       -- undo layer 3
  //     b = bit32.bxor(b, (salt + (i - 1) * 31) % 256) -- undo layer 1 (FIXED)
  //     out[i] = string.char(b)
  //   end
  //   return table.concat(out)
  // end
  return `
local function ${nameDecoder}(${nameBytes}, ${nameSalt})
  local out, n = {}, #${nameBytes}
  local s2 = (${nameSalt} * 131 + 17) % 256
  for i = 1, n do
    local b = ${nameBytes}[n - i + 1]
    b = bit32.bxor(b, (s2 + (n - i)) % 256)
    b = bit32.bxor(b, (${nameSalt} + (i - 1) * 31) % 256)
    out[i] = string.char(b)
  end
  return table.concat(out)
end
`.trim();
}
