// app.js — Main application controller.
// Wires UI, editor, obfuscation pipeline, and file I/O.

import { tokenize, LexError } from "./lexer.js";
import { buildRenameMap, applyTransform, unescapeLuaString } from "./transformer.js";
import { generateObfuscated, PRESETS } from "./vm-generator.js";
import { IdentifierGenerator } from "./identifier-generator.js";
import { layeredEncode } from "./string-encoder.js";
import { checkBalanced, normalizeSource } from "./parser.js";
import { countLines, formatBytes, toLuaStringLiteral, sleep } from "./utils.js";

// ---------- Sample ----------
const SAMPLE_LUA = `-- Sample Lua script for testing the obfuscator.
local Players = game:GetService("Players")
local LocalPlayer = Players.LocalPlayer

local function greet(name)
    local message = "Hello, " .. tostring(name) .. "!"
    print(message)
    return #message
end

local scores = {10, 20, 30, 40}
local total = 0
for i = 1, #scores do
    total = total + scores[i]
end

local config = {
    enabled = true,
    speed = 16,
    name = "Mawww Demo",
}

if config.enabled then
    greet(config.name)
    print("Total score:", total)
    print("Speed:", config.speed)
end

local counter = 0
while counter < 3 do
    counter = counter + 1
end
print("Counter:", counter)
`;

// ---------- State ----------
const state = {
  inputEditor: null,
  outputEditor: null,
  obfuscating: false,
  lastOutput: "",
};

// ---------- UI helpers ----------
const $ = (id) => document.getElementById(id);
const toastContainer = $("toastContainer");

function toast(title, message, kind = "info", ttl = 3200) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "info");
  el.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div><div class="toast-msg">${escapeHtml(message)}</div>`;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .25s ease";
    setTimeout(() => el.remove(), 260);
  }, ttl);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setProgress(percent, label) {
  $("progressFill").style.width = Math.max(0, Math.min(100, percent)) + "%";
  if (label) $("progressLabel").textContent = label;
}

function setStatus(text) {
  $("statusText").textContent = text;
}

// ---------- Editor setup ----------
function createEditor(textareaId, options = {}) {
  const textarea = $(textareaId);
  if (typeof CodeMirror !== "undefined") {
    const cm = CodeMirror.fromTextArea(textarea, {
      mode: "lua",
      theme: "dracula",
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      lineWrapping: options.lineWrapping !== false,
      matchBrackets: true,
      autoCloseBrackets: true,
      readOnly: options.readOnly === true,
      viewportMargin: options.viewportMargin || 40,
    });
    cm.setSize("100%", "100%");
    return cm;
  }
  // Fallback: plain textarea.
  return {
    getValue: () => textarea.value,
    setValue: (v) => { textarea.value = v; },
    on: (ev, fn) => textarea.addEventListener(ev, fn),
    setSize: () => {},
    refresh: () => {},
    focus: () => textarea.focus(),
  };
}

// ---------- Stats ----------
function updateInputStats() {
  const v = state.inputEditor.getValue();
  const lines = countLines(v);
  const chars = v.length;
  $("inputStats").textContent = `${lines} lines · ${chars} chars`;
}

// ---------- Obfuscation pipeline ----------
async function obfuscate() {
  if (state.obfuscating) return;
  const input = state.inputEditor.getValue();
  if (!input || !input.trim()) {
    toast("Empty input", "Masukkan source code Lua/Luau terlebih dahulu.", "warn");
    return;
  }

  state.obfuscating = true;
  $("obfuscateBtn").disabled = true;
  setProgress(2, "Starting...");
  setStatus("Obfuscating...");

  try {
    const preset = $("presetSelect").value;
    const presetCfg = PRESETS[preset] || PRESETS.medium;

    // Stage 1: normalize + lex
    await sleep(30);
    setProgress(10, "Lexing...");
    const normalized = normalizeSource(input);
    let tokens;
    try {
      tokens = tokenize(normalized);
    } catch (e) {
      if (e instanceof LexError) {
        throw new Error(`Lexer error: ${e.message} (line ${e.line}, col ${e.col})`);
      }
      throw e;
    }

    // Stage 2: validate structure
    await sleep(20);
    setProgress(20, "Validating...");
    try { checkBalanced(tokens); }
    catch (e) { throw new Error(`Syntax error: ${e.message}`); }

    // Stage 3: rename locals
    await sleep(20);
    setProgress(35, "Renaming identifiers...");
    const identGen = new IdentifierGenerator("_");
    let renameMap;
    try {
      renameMap = buildRenameMap(tokens, () => identGen.generate("var"));
    } catch (e) {
      console.warn("Rename pass skipped:", e);
      renameMap = new Map();
    }

    // Stage 4: apply transformations (rename, string encoding flag)
    await sleep(20);
    setProgress(50, "Applying transforms...");
    const useStringEncoding = preset === "strong" || preset === "extreme";
    const transformed = applyTransform(tokens, {
      renameMap,
      encodeStrings: false, // Strings are further protected by the VM constant encoder.
    });

    // Guard: ensure transformed source still tokenizes.
    try {
      checkBalanced(tokenize(transformed.source));
    } catch (e) {
      throw new Error("Internal error: transform produced invalid Lua.");
    }

    // Stage 5: build VM
    await sleep(30);
    setProgress(70, "Generating VM...");
    const { output, stats } = generateObfuscated(transformed.source, { preset });

    // Stage 6: post-process (identifier obfuscation on VM internals is
    // already handled by the generator — nothing extra required here).
    await sleep(20);
    setProgress(92, "Finalizing...");

    const obfTokens = tokenize(output);
    checkBalanced(obfTokens);

    state.lastOutput = output;
    state.outputEditor.setValue(output);
    setStatus("Done");

    // Stats
    const origSize = normalized.length;
    const obfSize = output.length;
    $("statOrigSize").textContent = formatBytes(origSize);
    $("statObfSize").textContent = formatBytes(obfSize);
    $("statInstrCount").textContent = stats.instrCount;
    $("statConstCount").textContent = stats.constCount;
    $("statLevel").textContent = preset.toUpperCase();
    $("statRenamed").textContent = renameMap.size;

    setProgress(100, "Done");

    toast("Obfuscation complete", `Preset ${preset.toUpperCase()} · ${formatBytes(obfSize)}`, "success");
  } catch (err) {
    console.error(err);
    setProgress(0, "Error");
    setStatus("Error");
    toast("Obfuscation failed", err.message || String(err), "error", 5200);
  } finally {
    state.obfuscating = false;
    $("obfuscateBtn").disabled = false;
    setTimeout(() => setProgress(0, "Ready"), 900);
  }
}

// ---------- File handling ----------
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "utf-8");
  });
}

function download(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

// ---------- Navigation ----------
function switchPanel(target) {
  for (const btn of document.querySelectorAll(".nav-item")) {
    btn.classList.toggle("active", btn.dataset.target === target);
  }
  for (const id of ["workspace", "stats", "about"]) {
    document.getElementById("panel-" + id).classList.toggle("hidden", id !== target);
  }
  const titles = {
    workspace: ["VM Obfuscator", "Protect Lua/Luau scripts with multi-layer VM encoding."],
    stats: ["Statistics", "Obfuscation metrics dari proses terakhir."],
    about: ["About", "Cara kerja dan preset yang tersedia."],
  };
  if (titles[target]) {
    $("pageTitle").textContent = titles[target][0];
    $("pageSubtitle").textContent = titles[target][1];
  }
}

// ---------- Simple Format ----------
function formatLua(source) {
  // Conservative formatter: normalize line endings and strip trailing spaces.
  // We deliberately avoid aggressive re-indentation because Lua/Luau semantics
  // depend on token-level content, not whitespace.
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let indent = 0;
  for (let raw of lines) {
    let line = raw.replace(/[ \t]+$/g, "");
    // Decrease indent for closers
    const stripped = line.replace(/^\s+/, "");
    if (/^(end|else|elseif|until|\})\b/.test(stripped)) {
      indent = Math.max(0, indent - 1);
    }
    const prefix = "    ".repeat(indent);
    out.push(prefix + stripped);
    // Increase indent for openers
    const opensDo = /\b(do|then|function|repeat)\b\s*$/.test(stripped) ||
                    /\{[\s]*$/.test(stripped);
    if (opensDo) indent++;
    // Count extra nested keywords on this line (heuristic)
    const opens = (stripped.match(/\b(function|do|then|repeat)\b/g) || []).length;
    const closes = (stripped.match(/\b(end|until)\b/g) || []).length;
    // Already adjusted for the leading closer; adjust for additional balance
    indent = Math.max(0, indent + Math.max(0, opens - 1) - Math.max(0, closes - 1));
  }
  return out.join("\n");
}

// ---------- Init ----------
function init() {
  // Editors
  state.inputEditor = createEditor("inputEditor");
  state.outputEditor = createEditor("outputEditor", { readOnly: true, lineWrapping: true });

  // Wire editor events
  if (state.inputEditor.on) {
    try {
      state.inputEditor.on("change", updateInputStats);
    } catch (e) { /* plain textarea fallback */ }
  }
  // For textarea fallback
  const rawInput = $("inputEditor");
  rawInput.addEventListener("input", updateInputStats);

  // Buttons
  $("obfuscateBtn").addEventListener("click", obfuscate);
  $("pasteBtn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return toast("Paste", "Clipboard kosong.", "warn");
      state.inputEditor.setValue(text);
      updateInputStats();
      toast("Paste", "Source dimuat dari clipboard.", "success");
    } catch (e) {
      toast("Paste failed", "Izin clipboard ditolak. Gunakan Ctrl+V.", "warn");
    }
  });
  $("clearBtn").addEventListener("click", () => {
    state.inputEditor.setValue("");
    updateInputStats();
  });
  $("formatBtn").addEventListener("click", () => {
    const src = state.inputEditor.getValue();
    if (!src.trim()) return;
    try {
      const formatted = formatLua(src);
      state.inputEditor.setValue(formatted);
      updateInputStats();
      toast("Format", "Source diformat.", "success");
    } catch (e) {
      toast("Format failed", e.message, "error");
    }
  });
  $("sampleBtn").addEventListener("click", () => {
    state.inputEditor.setValue(SAMPLE_LUA);
    updateInputStats();
    toast("Sample", "Contoh Lua dimuat.", "success");
  });

  $("copyBtn").addEventListener("click", async () => {
    const out = state.lastOutput;
    if (!out) return toast("Copy", "Belum ada output.", "warn");
    try {
      await navigator.clipboard.writeText(out);
      toast("Copy", "Output disalin ke clipboard.", "success");
    } catch (e) {
      toast("Copy failed", "Izin clipboard ditolak.", "warn");
    }
  });

  $("downloadLuaBtn").addEventListener("click", () => {
    if (!state.lastOutput) return toast("Download", "Belum ada output.", "warn");
    download("protected.lua", state.lastOutput);
  });

  $("downloadTxtBtn").addEventListener("click", () => {
    if (!state.lastOutput) return toast("Download", "Belum ada output.", "warn");
    download("protected.txt", state.lastOutput);
  });

  // Navigation
  for (const btn of document.querySelectorAll(".nav-item")) {
    btn.addEventListener("click", () => switchPanel(btn.dataset.target));
  }

  // Drag & drop
  const dropArea = $("inputEditorWrap");
  ["dragenter", "dragover"].forEach(ev => {
    dropArea.addEventListener(ev, (e) => {
      e.preventDefault();
      dropArea.style.outline = "2px dashed var(--accent)";
    });
  });
  ["dragleave", "drop"].forEach(ev => {
    dropArea.addEventListener(ev, (e) => {
      e.preventDefault();
      dropArea.style.outline = "none";
    });
  });
  dropArea.addEventListener("drop", async (e) => {
    const files = e.dataTransfer.files;
    if (!files || !files.length) return;
    const f = files[0];
    if (!/\.(lua|luau|txt)$/i.test(f.name)) {
      toast("Unsupported file", "Gunakan file .lua / .luau / .txt.", "warn");
      return;
    }
    try {
      const text = await readFileAsText(f);
      state.inputEditor.setValue(text);
      updateInputStats();
      toast("File loaded", f.name, "success");
    } catch (err) {
      toast("Read failed", err.message, "error");
    }
  });

  // Keyboard shortcut: Ctrl/Cmd + Enter to obfuscate
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      obfuscate();
    }
  });

  updateInputStats();
  setProgress(0, "Ready");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
      }
