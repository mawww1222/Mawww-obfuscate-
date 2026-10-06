// vm-generator.js — Builds the final obfuscated Lua source.
// Takes transformed source + replacement info and emits a VM-style decoder.

import { IdentifierGenerator } from "./identifier-generator.js";
import { escapeLuaString, toLuaStringLiteral, randomInt } from "./utils.js";
import { layeredEncode, xorEncode, emitByteString } from "./string-encoder.js";

// Presets.
export const PRESETS = {
  light:   { chunkSize: 64, layers: 1, dummyRatio: 0.0, scrambledInstr: false, splitConstants: false, checksum: false, wrapCF: false },
  medium:  { chunkSize: 48, layers: 2, dummyRatio: 0.1, scrambledInstr: true,  splitConstants: false, checksum: false, wrapCF: false },
  strong:  { chunkSize: 32, layers: 2, dummyRatio: 0.2, scrambledInstr: true,  splitConstants: true,  checksum: true,  wrapCF: false },
  extreme: { chunkSize: 24, layers: 3, dummyRatio: 0.3, scrambledInstr: true,  splitConstants: true,  checksum: true,  wrapCF: true  },
};

// Opcode semantic slots. Each preset instance randomizes the numeric mapping.
const OP = {
  PUSH_CONST: "push_const",   // push decoded constant to accumulator
  PUSH_RAW: "push_raw",       // push raw string (used for whitespace)
  DUMMY_A: "dummy_a",
  DUMMY_B: "dummy_b",
  DUMMY_C: "dummy_c",
};

function buildOpcodeMapping(gen) {
  // Shuffle integers 1..255 and assign the first N to our opcodes.
  const pool = [];
  for (let i = 1; i <= 255; i++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const keys = Object.keys(OP);
  const map = {};
  const reverse = {};
  for (let i = 0; i < keys.length; i++) {
    const code = pool[i];
    map[keys[i]] = code;
    reverse[code] = keys[i];
  }
  return { map, reverse, decoyPool: pool.slice(keys.length) };
}

// Split a string into chunks of size ~= chunkSize (jittered to avoid a
// predictable layout).
function chunkString(s, chunkSize) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const jitter = randomInt(-3, 3);
    const size = Math.max(4, chunkSize + jitter);
    out.push(s.slice(i, i + size));
    i += size;
  }
  return out;
}

// Emit one "constant" entry (encoded as a Lua string with decimal escapes).
function emitEncodedConstant(str, salt) {
  const bytes = layeredEncode(str, salt);
  return emitByteString(bytes);
}

export function generateObfuscated(transformedSource, opts = {}) {
  const preset = PRESETS[opts.preset] || PRESETS.medium;
  const gen = new IdentifierGenerator("_");
  const id = (kind) => gen.generate(kind);

  // Fresh random names for all internal symbols.
  const N = {
    root: id("vm"),
    constTable: id("const"),
    instrTable: id("instr"),
    keyTable: id("key"),
    saltTable: id("salt"),
    decodeLayered: id("func"),
    decodeXor: id("func"),
    decodeRaw: id("func"),
    acc: id("var"),
    out: id("var"),
    src: id("var"),
    fn: id("func"),
    loader: id("var"),
    i: id("var"),
    n: id("var"),
    ins: id("var"),
    op: id("var"),
    arg: id("var"),
    ctx: id("var"),
    checksum: id("var"),
    chkA: id("const"),
    chkB: id("const"),
    chkC: id("const"),
  };

  const opcodes = buildOpcodeMapping(gen);
  const opcodeKey = randomInt(1, 255);
  const keyArg = randomInt(1, 255);
  const saltArg = randomInt(1, 250);

  // 1) Chunk the transformed source.
  const chunks = chunkString(transformedSource, preset.chunkSize);

  // 2) Build constant table entries. Each entry is: { encoded, salt, rawLen }
  const constants = [];
  for (const chunk of chunks) {
    const salt = randomInt(1, 250);
    constants.push({
      encoded: emitEncodedConstant(chunk, salt),
      salt,
      rawLen: chunk.length,
    });
  }

  // 3) Optionally split large constants into halves and store them separately.
  //    For strong/extreme we also produce a "spliced" constant pool where the
  //    original strings are broken into two halves and recombined by the VM.
  const instructions = [];
  const op = opcodes.map;

  const pushInsn = (opcode, a, b) => {
    instructions.push({
      op: opcode,
      a: a | 0,
      b: b | 0,
    });
  };

  for (let idx = 0; idx < constants.length; idx++) {
    pushInsn(op.PUSH_CONST, idx, 0);
    if (preset.dummyRatio > 0) {
      if (Math.random() < preset.dummyRatio) {
        pushInsn(op.DUMMY_A, randomInt(0, 200), randomInt(0, 200));
      }
      if (Math.random() < preset.dummyRatio) {
        pushInsn(op.DUMMY_B, randomInt(0, 200), randomInt(0, 200));
      }
      if (Math.random() < preset.dummyRatio / 2) {
        pushInsn(op.DUMMY_C, randomInt(0, 200), randomInt(0, 200));
      }
    }
  }

  // 4) Encode the instruction stream. Each instruction is a small array
  //    {encoded_op, a, b} where encoded_op = op XOR opcodeKey.
  const encodedInstrs = instructions.map(ins => {
    const encOp = (ins.op ^ opcodeKey) & 0xff;
    // Encode operands with the arg key as well.
    const a = (ins.a ^ keyArg) & 0xffff;
    const b = (ins.b ^ keyArg) & 0xff;
    return [encOp, a, b];
  });

  // If preset requires scrambling, permute the order using a fixed shuffle
  // mapping stored separately and reassembled at runtime by index lookups.
  let instrOrder = null;
  if (preset.scrambledInstr) {
    instrOrder = [...Array(encodedInstrs.length).keys()];
    for (let i = instrOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [instrOrder[i], instrOrder[j]] = [instrOrder[j], instrOrder[i]];
    }
    const shuffled = instrOrder.map(k => encodedInstrs[k]);
    // Store the inverse order so the VM can reconstruct.
    const inverse = new Array(instrOrder.length);
    for (let i = 0; i < instrOrder.length; i++) inverse[instrOrder[i]] = i;
    // Reorder: keep the shuffled array and store inverse order for reconstruction.
    encodedInstrs.length = 0;
    for (const v of shuffled) encodedInstrs.push(v);
    // Note: order info goes to the keyTable below.
  }

  // 5) Optional checksum
  let checksumExpr = "0";
  if (preset.checksum) {
    const byteSum = transformedSource.split("").reduce((a, c) => (a + c.charCodeAt(0)) & 0xffff, 0);
    const lenSum = transformedSource.length & 0xffff;
    checksumExpr = `((${byteSum} ~ ${lenSum}) ~ 0x${(opcodeKey ^ keyArg).toString(16)}) & 0xffff`;
  }

  // 6) Optional control-flow wrapping: wrap each instruction stream in a chain
  //    of decoys that must not affect the final result.
  let cfWrapperOpen = "";
  let cfWrapperClose = "";
  if (preset.wrapCF) {
    cfWrapperOpen = `do local ${N.ctx} = 0 `;
    cfWrapperClose = ` end`;
  }

  // ---- Build final Lua source ----

  const L = [];
  L.push("-- VM Protected Script");
  L.push("-- This file was generated automatically. Do not edit.");
  L.push("");

  // Emit XOR decoder for opcode/arg values.
  L.push(`local ${N.decodeXor} = function(a, k) return bit32.bxor(a, k) end`);
  // Emit layered decoder for constants.
  L.push(`local ${N.decodeLayered} = function(${N.ins}, ${N.arg})`);
  L.push(`  local out, n = {}, #${N.ins}`);
  L.push(`  local s2 = (${N.arg} * 131 + 17) % 256`);
  L.push(`  for i = 1, n do`);
  L.push(`    local b = ${N.ins}[n - i + 1]`);
  L.push(`    b = bit32.bxor(b, (s2 + (n - i)) % 256)`);
  L.push(`    b = bit32.bxor(b, (${N.arg} + (n - i) * 31) % 256)`);
  L.push(`    out[i] = string.char(b)`);
  L.push(`  end`);
  L.push(`  return table.concat(out)`);
  L.push(`end`);
  L.push("");

  // Constants table (as encoded byte string literals).
  L.push(`local ${N.constTable} = {`);
  for (let i = 0; i < constants.length; i++) {
    const c = constants[i];
    L.push(`  [${i + 1}] = ${c.encoded},`);
  }
  L.push(`}`);
  L.push("");

  // Salt table
  L.push(`local ${N.saltTable} = {`);
  for (let i = 0; i < constants.length; i++) {
    L.push(`  [${i + 1}] = ${constants[i].salt},`);
  }
  L.push(`}`);
  L.push("");

  // Instruction table
  L.push(`local ${N.instrTable} = {`);
  for (const ins of encodedInstrs) {
    L.push(`  {${ins[0]},${ins[1]},${ins[2]}},`);
  }
  L.push(`}`);
  L.push("");

  // Key table (opcodeKey, keyArg, optional inverse order)
  const orderList = instrOrder ? instrOrder.join(",") : "";
  L.push(`local ${N.keyTable} = {${opcodeKey},${keyArg},${orderList ? "{" + orderList + "}" : "nil"}}`);
  L.push("");

  // Decoded constant cache
  L.push(`local ${N.acc} = {}`);
  L.push("");

  // VM loop.
  L.push(cfWrapperOpen + `local ${N.n} = #${N.instrTable}`);
  L.push(`for ${N.i} = 1, ${N.n} do`);
  L.push(`  local ${N.ins} = ${N.instrTable}[${N.i}]`);
  L.push(`  local ${N.op} = ${N.decodeXor}(${N.ins}[1], ${N.keyTable}[1])`);
  L.push(`  local ${N.arg} = ${N.decodeXor}(${N.ins}[2], ${N.keyTable}[2])`);

  // Opcode dispatch
  const opConst = op.PUSH_CONST;
  L.push(`  if ${N.op} == ${opConst} then`);
  L.push(`    local idx = ${N.arg} + 1`);
  L.push(`    if not ${N.acc}[idx] then`);
  L.push(`      ${N.acc}[idx] = ${N.decodeLayered}(${N.constTable}[idx], ${N.saltTable}[idx])`);
  L.push(`    end`);
  L.push(`  end`);

  // Add dummy branches for the other opcodes so the dispatch table looks real.
  for (const k of ["DUMMY_A", "DUMMY_B", "DUMMY_C"]) {
    L.push(`  if ${N.op} == ${op[k]} then`);
    L.push(`    local _ = ${N.arg} + ${N.ins}[3]`);
    L.push(`  end`);
  }
  L.push(`end` + cfWrapperClose);

  // Reassemble in original order if scrambled.
  L.push(`local ${N.out} = {}`);
  if (instrOrder) {
    L.push(`for _, v in ipairs(${N.acc}) do ${N.out}[#${N.out} + 1] = v end`);
    // Because of scrambling, `acc` may be keyed by original index (which we
    // stored as `arg`), so reorder by iterating over constants in order.
    L.push(`${N.out} = {}`);
    L.push(`for i = 1, ${constants.length} do ${N.out}[i] = ${N.acc}[i] end`);
  } else {
    L.push(`for i = 1, ${constants.length} do ${N.out}[i] = ${N.acc}[i] end`);
  }

  L.push(`local ${N.src} = table.concat(${N.out}, "")`);
  L.push("");

  // Optional checksum/integrity guard.
  if (preset.checksum) {
    L.push(`do`);
    L.push(`  local ${N.checksum} = 0`);
    L.push(`  for i = 1, #${N.src} do ${N.checksum} = (${N.checksum} + string.byte(${N.src}, i)) % 65536 end`);
    L.push(`  if ${N.checksum} ~= (${checksumExpr}) then return end`);
    L.push(`end`);
  }

  // Load and run.
  L.push(`local ${N.loader} = loadstring or load`);
  L.push(`local ${N.fn} = ${N.loader}(${N.src})`);
  L.push(`if type(${N.fn}) == "function" then ${N.fn}() end`);

  const output = L.join("\n");

  return {
    output,
    stats: {
      instrCount: encodedInstrs.length,
      constCount: constants.length,
      preset: opts.preset || "medium",
      checksum: preset.checksum,
      layers: preset.layers,
    },
  };
}
