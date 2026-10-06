// identifier-generator.js — Generates random, valid Lua identifiers.

const LUA_KEYWORDS = new Set([
  "and","break","do","else","elseif","end","false","for","function","goto",
  "if","in","local","nil","not","or","repeat","return","then","true","until","while",
  "continue","export","type","typeof"
]);

const LUA_BUILTINS = new Set([
  "print","warn","error","assert","pcall","xpcall","select","type","typeof","tonumber",
  "tostring","ipairs","pairs","next","unpack","table","string","math","os","io","coroutine",
  "task","game","workspace","script","wait","spawn","delay","tick","load","loadstring",
  "require","getfenv","setfenv","getmetatable","setmetatable","rawget","rawset","rawequal",
  "rawlen","_G","_ENV","self","bit","bit32","utf8","debug","newproxy","Instance","Vector3",
  "CFrame","Color3","UDim2","Enum","Ray","Region3","NumberSequence","ColorSequence","TweenInfo",
  "BrickColor","Faces","Axes","Rect","Random","DateTime","PhysicalProperties","NumberRange"
]);

const SAFE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SAFE_ALNUM = SAFE_ALPHABET + "0123456789";
const HEX = "abcdef0123456789";

export class IdentifierGenerator {
  constructor(prefix = "_") {
    this.prefix = prefix;
    this.used = new Set();
    // Reserve common names so we never emit one by accident.
    for (const k of LUA_KEYWORDS) this.used.add(k);
    for (const k of LUA_BUILTINS) this.used.add(k);
  }

  _randHex(len) {
    let s = "";
    for (let i = 0; i < len; i++) s += HEX[Math.floor(Math.random() * HEX.length)];
    return s;
  }

  generate(kind = "var") {
    for (let attempt = 0; attempt < 40; attempt++) {
      let name;
      if (kind === "vm") {
        name = "_" + this._randHex(6) + "_" + this._randHex(4);
      } else if (kind === "func") {
        name = this.prefix + "f_" + this._randHex(5) + Math.floor(Math.random() * 900 + 100);
      } else if (kind === "const") {
        name = "_C" + this._randHex(5) + Math.floor(Math.random() * 900 + 100);
      } else {
        const len = 5 + Math.floor(Math.random() * 4);
        let s = SAFE_ALPHABET[Math.floor(Math.random() * SAFE_ALPHABET.length)];
        for (let i = 1; i < len; i++) {
          s += SAFE_ALNUM[Math.floor(Math.random() * SAFE_ALNUM.length)];
        }
        name = this.prefix + s;
      }
      if (!this.used.has(name) && !LUA_KEYWORDS.has(name) && !LUA_BUILTINS.has(name)) {
        this.used.add(name);
        return name;
      }
    }
    // Fallback with guaranteed uniqueness
    let n = this.prefix + "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    while (this.used.has(n)) n += Math.random().toString(36).slice(2, 3);
    this.used.add(n);
    return n;
  }
}
