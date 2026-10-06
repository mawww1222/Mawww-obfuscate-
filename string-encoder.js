// string-encoder.js — String encryption/encoding used across presets.
// Each preset decides how aggressive the encoding is.

import { escapeLuaString } from "./utils.js";

// Very simple but effective XOR + byte shift per character with a per-string key.
// Returns an array of integers (0-255) that can be emitted as a Lua string with
// decimal escapes and decoded at runtime.
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

// Multi-layer: 1) XOR with a rolling key, 2) reverse bytes, 3) XOR with a
// per-string "salt" byte.
export function layeredEncode(str, salt) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff);
  let working = bytes.slice();
  // Layer 1: XOR with rolling key
  working = xorEncode(working, salt);
  // Layer 2: reverse
  working.reverse();
  // Layer 3: XOR with position-dependent salt2
  const salt2 = (salt * 131 + 17) & 0xff;
  for (let i = 0; i < working.length; i++) {
    working[i] = (working[i] ^ ((salt2 + i) & 0xff)) & 0xff;
  }
  return working;
}

// Produce a Lua expression that decodes a layered-encoded byte array at runtime.
// The generated code has the same shape as the encoder but is randomized in
// naming and can be inlined. We return the byte array itself; the caller
// decides whether to inline the decoder or use the shared one.
export function emitEncodedBytes(bytes) {
  // Return a Lua array literal of numbers, compacted into groups for readability.
  // e.g. {173,45,28,90,...}
  return "{" + bytes.join(",") + "}";
}

// Emit a Lua string literal from bytes using decimal escapes.
export function emitByteString(bytes) {
  let out = '"';
  for (const b of bytes) out += "\\" + b;
  out += '"';
  return out;
}

// Runtime Lua decoder snippets (as strings of Lua source). The transformer
// generates fresh names and injects them into the VM preamble; this function
// only contains the algorithm.
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

export function luaDecodeReverse(nameDecoder, nameBytes, nameSalt) {
  // function <nameDecoder>(arr, salt)
  //   local out = {}
  //   local n = #arr
  //   local salt2 = (salt * 131 + 17) % 256
  //   for i = 1, n do
  //     local b = arr[n - i + 1]
  //     b = bit32.bxor(b, (salt2 + (n - i)) % 256)
  //     b = bit32.bxor(b, (salt + (n - i) * 31) % 256)
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
    b = bit32.bxor(b, (${nameSalt} + (n - i) * 31) % 256)
    out[i] = string.char(b)
  end
  return table.concat(out)
end
`.trim();
      }
