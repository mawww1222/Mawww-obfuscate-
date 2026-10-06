// app.js — Main application controller.
// Wires UI, editor, obfuscation pipeline, and file I/O (upload + download).
//
// Unlimited file size support:
//  - Tidak ada batas ukuran file (unlimited).
//  - Untuk file raksasa, editor hanya menampilkan preview (~400 KB) agar
//    CodeMirror tetap responsif, tetapi pipeline obfuscation selalu memakai
//    source lengkap (state.lastInputRaw).
//  - Output yang sangat besar juga di-preview di editor; tombol Copy dan
//    Download tetap memakai output lengkap (state.lastOutput).

import { tokenize, LexError } from "./lexer.js";
import { buildRenameMap, applyTransform } from "./transformer.js";
import { generateObfuscated, PRESETS } from "./vm-generator.js";
import { IdentifierGenerator } from "./identifier-generator.js";
import { checkBalanced, normalizeSource } from "./parser.js";
import { countLines, formatBytes, sleep } from "./utils.js";

// ---------- Config ----------
const EDITOR_PREVIEW_LIMIT = 400 * 1024; // 400 KB tampil di CodeMirror
const LARGE_FILE_WARN = 5 * 1024 * 1024; // 5 MB — hanya info
const HUGE_FILE_WARN = 20 * 1024 * 1024; // 20 MB — warning lebih tegas
const ACCEPTED_EXT = /\.(lua|luau|txt)$/i;

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

  // Full source (mungkin jauh lebih besar dari yang tampil di editor).
  lastInputRaw: "",
  lastInputSize: 0,
  lastInputLines: 0,
  lastInputName: "source.lua",

  // Full output.
  lastOutput: "",
  lastOutputSize: 0,
  lastPreset: "",
};

// Flag internal: mencegah handler "change" dari meng-clobber state.lastInputRaw
// saat kita memuat preview ke editor secara programatik.
let suppressEditorChange = false;
let inputIsPreview = false; // true kalau editor cuma menampilkan preview
let outputIsPreview = false;

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
  const raw = inputIsPreview ? state.lastInputRaw : state.inputEditor.getValue();
  const lines = countLines(raw);
  const chars = raw.length;
  const suffix = inputIsPreview ? ` (preview · full: ${formatBytes(chars)})` : "";
  $("inputStats").textContent = `${lines} lines · ${chars} chars${suffix}`;
}

function updateOutputStats() {
  const chars = state.lastOutputSize;
  const lines = countLines(state.lastOutput);
  const suffix = outputIsPreview ? ` (preview · full: ${formatBytes(chars)})` : "";
  $("outputStats").textContent = `${lines} lines · ${chars} chars${suffix}`;
}

// ---------- File Metadata UI ----------
function updateInputFilename(name) {
  state.lastInputName = name || "source.lua";
  $("inputFilename").textContent = state.lastInputName;
  const base = state.lastInputName.replace(/\.[^.]+$/, "");
  $("outFilename").textContent = base + "_protected.lua";
}

function showFileMeta(file, text) {
  const meta = $("fileMeta");
  meta.classList.remove("hidden");
  $("fileMetaName").textContent = file.name;
  $("fileMetaSize").textContent = formatBytes(file.size);
  $("fileMetaLines").textContent = countLines(text);
  $("fileMetaType").textContent = file.type || "text/plain";
  $("fileMetaMtime").textContent = file.lastModified
    ? new Date(file.lastModified).toLocaleString()
    : "—";
}

function updateOutputMeta(status, preset) {
  $("outMetaStatus").textContent = status;
  $("outMetaSize").textContent = state.lastOutput ? formatBytes(state.lastOutputSize) : "—";
  $("outMetaPreset").textContent = preset ? preset.toUpperCase() : "—";
}

// ---------- Editor source loader (preview-safe) ----------
function setInputSource(text, isPreview) {
  suppressEditorChange = true;
  try {
    if (isPreview) {
      const preview = text.slice(0, EDITOR_PREVIEW_LIMIT) +
        `\n\n-- [PREVIEW TRUNCATED]\n-- Full source: ${formatBytes(text.length)} (${countLines(text)} lines)\n-- Obfuscation will use the FULL source in memory.\n-- Download the source backup to view the original file.`;
      state.inputEditor.setValue(preview);
    } else {
      state.inputEditor.setValue(text);
    }
  } finally {
    suppressEditorChange = false;
  }
  inputIsPreview = isPreview;
  state.lastInputRaw = text;
  state.lastInputSize = text.length;
  state.lastInputLines = countLines(text);
  updateInputStats();
}

function setOutputSource(text) {
  state.lastOutput = text;
  state.lastOutputSize = text.length;
  if (text.length > EDITOR_PREVIEW_LIMIT) {
    outputIsPreview = true;
    const preview = text.slice(0, EDITOR_PREVIEW_LIMIT) +
      `\n\n-- [OUTPUT PREVIEW TRUNCATED]\n-- Full output: ${formatBytes(text.length)} (${countLines(text)} lines)\n-- Use Copy or Download buttons for the complete file.`;
    state.outputEditor.setValue(preview);
  } else {
    outputIsPreview = false;
    state.outputEditor.setValue(text);
  }
  updateOutputStats();
}

// ---------- File reading ----------
function readFileAsText(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Read error"));
    if (typeof onProgress === "function") {
      reader.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          onProgress(e.loaded / e.total, e.loaded, e.total);
        }
      };
    }
    reader.readAsText(file, "utf-8");
  });
}

function validateFile(file) {
  if (!file) throw new Error("Tidak ada file yang dipilih.");
  if (!ACCEPTED_EXT.test(file.name)) {
    throw new Error("Format tidak didukung. Gunakan .lua / .luau / .txt.");
  }
  return true;
}

async function handleFileUpload(file) {
  try {
    validateFile(file);

    const size = file.size || 0;
    const isLarge = size > LARGE_FILE_WARN;
    const isHuge = size > HUGE_FILE_WARN;

    if (isHuge) {
      toast(
        "File sangat besar",
        `${file.name} · ${formatBytes(size)}. Loading & obfuscation bisa memakan waktu lama dan browser bisa tampak freeze sebentar.`,
        "warn",
        6000
      );
    } else if (isLarge) {
      toast(
        "File besar",
        `Membaca ${file.name} (${formatBytes(size)})…`,
        "info",
        3500
      );
    }

    setProgress(0, "Reading...");
    setStatus("Reading file...");

    const t0 = performance.now();
    const text = await readFileAsText(file, (p) => {
      const pct = Math.floor(p * 40);
      setProgress(pct, `Reading ${Math.floor(p * 100)}%`);
    });
    const elapsed = performance.now() - t0;

    // Isi editor (pakai preview-safe loader).
    const preview = text.length > EDITOR_PREVIEW_LIMIT;
    updateInputFilename(file.name);
    setInputSource(text, preview);
    showFileMeta(file, text);

    setProgress(100, "Loaded");
    updateOutputMeta("Belum ada hasil", "");

    const readMsg = `${file.name} · ${formatBytes(text.length)} · ${countLines(text)} lines · ${elapsed.toFixed(0)} ms`;
    toast("File loaded", readMsg, "success", 3800);

    if (preview) {
      toast(
        "Preview aktif",
        `Editor hanya menampilkan 400 KB pertama. Obfuscation tetap memakai source lengkap (${formatBytes(text.length)}).`,
        "info",
        5200
      );
    }

    setTimeout(() => setProgress(0, "Ready"), 900);
  } catch (err) {
    console.error(err);
    setProgress(0, "Error");
    setStatus("Upload error");
    toast("Upload gagal", err.message || String(err), "error");
  }
}

// ---------- Download helpers ----------
function sanitizeFilename(name) {
  return String(name || "file")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function download(filename, content, mime = "text/plain;charset=utf-8") {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sanitizeFilename(filename);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1200);
    return true;
  } catch (e) {
    console.error("Download failed:", e);
    toast("Download gagal", e.message || String(e), "error");
    return false;
  }
}

function getBaseName() {
  return state.lastInputName.replace(/\.[^.]+$/, "") || "source";
}

// ---------- Obfuscation pipeline ----------
async function obfuscate() {
  if (state.obfuscating) return;

  // Ambil source lengkap (bukan preview).
  const input = inputIsPreview ? state.lastInputRaw : state.inputEditor.getValue();

  if (!input || !input.trim()) {
    toast("Empty input", "Masukkan source code Lua/Luau terlebih dahulu.", "warn");
    return;
  }

  state.obfuscating = true;
  $("obfuscateBtn").disabled = true;
  setProgress(2, "Starting...");
  setStatus("Obfuscating...");

  const t0 = performance.now();
  const inputSize = input.length;
  const inputIsHuge = inputSize > LARGE_FILE_WARN;

  try {
    const preset = $("presetSelect").value;
    const presetCfg = PRESETS[preset] || PRESETS.medium;

    if (inputIsHuge) {
      toast(
        "Memproses file besar",
        `${formatBytes(inputSize)} · preset ${preset.toUpperCase()}. Mohon tunggu…`,
        "info",
        4200
      );
    }

    // Stage 1: normalize + lex
    await sleep(20);
    setProgress(8, "Lexing...");
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

    // Stage 2: validate
    await sleep(15);
    setProgress(20, "Validating...");
    try { checkBalanced(tokens); }
    catch (e) { throw new Error(`Syntax error: ${e.message}`); }

    // Stage 3: rename locals
    await sleep(15);
    setProgress(35, "Renaming identifiers...");
    const identGen = new IdentifierGenerator("_");
    let renameMap;
    try {
      renameMap = buildRenameMap(tokens, () => identGen.generate("var"));
    } catch (e) {
      console.warn("Rename pass skipped:", e);
      renameMap = new Map();
    }

    // Stage 4: transforms
    await sleep(15);
    setProgress(50, "Applying transforms...");
    const transformed = applyTransform(tokens, {
      renameMap,
      encodeStrings: false,
    });

    try {
      checkBalanced(tokenize(transformed.source));
    } catch (e) {
      throw new Error("Internal error: transform produced invalid Lua.");
    }

    // Stage 5: VM build
    await sleep(25);
    setProgress(70, "Generating VM...");
    const { output, stats } = generateObfuscated(transformed.source, { preset });

    // Stage 6: finalize
    await sleep(15);
    setProgress(92, "Finalizing...");
    checkBalanced(tokenize(output));

    // Simpan output lengkap + preview editor.
    state.lastPreset = preset;
    setOutputSource(output);
    setStatus("Done");

    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

    // Stats
    $("statOrigSize").textContent = formatBytes(inputSize);
    $("statObfSize").textContent = formatBytes(output.length);
    $("statInstrCount").textContent = stats.instrCount;
    $("statConstCount").textContent = stats.constCount;
    $("statLevel").textContent = preset.toUpperCase();
    $("statRenamed").textContent = renameMap.size;

    updateOutputMeta("Berhasil", preset);
    setProgress(100, "Done");

    toast(
      "Obfuscation complete",
      `Preset ${preset.toUpperCase()} · ${formatBytes(output.length)} · ${elapsed}s`,
      "success",
      3800
    );

    if (outputIsPreview) {
      toast(
        "Output besar",
        `Editor hanya menampilkan 400 KB pertama. Gunakan Copy atau Download untuk output lengkap (${formatBytes(output.length)}).`,
        "info",
        5500
      );
    }
  } catch (err) {
    console.error(err);
    setProgress(0, "Error");
    setStatus("Error");
    updateOutputMeta("Gagal: " + (err.message || "unknown"), "");
    toast("Obfuscation failed", err.message || String(err), "error", 5500);
  } finally {
    state.obfuscating = false;
    $("obfuscateBtn").disabled = false;
    setTimeout(() => setProgress(0, "Ready"), 900);
  }
}

// ---------- Navigation ----------
function switchPanel(target) {
  for (const btn of document.querySelectorAll(".nav-item")) {
    btn.classList.toggle("active", btn.dataset.target === target);
  }
  for (const id of ["workspace", "stats", "files", "about"]) {
    const el = document.getElementById("panel-" + id);
    if (el) el.classList.toggle("hidden", id !== target);
  }
  const titles = {
    workspace: ["VM Obfuscator", "Protect Lua/Luau scripts with multi-layer VM encoding."],
    stats: ["Statistics", "Obfuscation metrics dari proses terakhir."],
    files: ["Files", "Upload source dan download hasil obfuscation."],
    about: ["About", "Cara kerja dan preset yang tersedia."],
  };
  if (titles[target]) {
    $("pageTitle").textContent = titles[target][0];
    $("pageSubtitle").textContent = titles[target][1];
  }
  if (state.outputEditor && state.outputEditor.refresh) {
    setTimeout(() => state.outputEditor.refresh(), 60);
  }
}

// ---------- Simple Format (dengan guard untuk file besar) ----------
function formatLua(source) {
  // Untuk file sangat besar, lompati reformat (bisa lambat & memakan memori).
  if (source.length > 2 * 1024 * 1024) {
    toast(
      "Format dilewati",
      "Source terlalu besar (>2 MB). Reformat di-skip agar tidak lambat.",
      "warn",
      3500
    );
    return source;
  }
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let indent = 0;
  for (let raw of lines) {
    let line = raw.replace(/[ \t]+$/g, "");
    const stripped = line.replace(/^\s+/, "");
    if (/^(end|else|elseif|until|\})\b/.test(stripped)) {
      indent = Math.max(0, indent - 1);
    }
    const prefix = "    ".repeat(indent);
    out.push(prefix + stripped);
    const opensDo = /\b(do|then|function|repeat)\b\s*$/.test(stripped) ||
                    /\{[\s]*$/.test(stripped);
    if (opensDo) indent++;
    const opens = (stripped.match(/\b(function|do|then|repeat)\b/g) || []).length;
    const closes = (stripped.match(/\b(end|until)\b/g) || []).length;
    indent = Math.max(0, indent + Math.max(0, opens - 1) - Math.max(0, closes - 1));
  }
  return out.join("\n");
}

// ---------- Report generator (Markdown) ----------
function buildReport() {
  const lines = [
    "# VM Obfuscator Report",
    "",
    `- Tanggal: ${new Date().toLocaleString()}`,
    `- Source: ${state.lastInputName}`,
    `- Preset: ${(state.lastPreset || "-").toUpperCase()}`,
    `- Ukuran input: ${formatBytes(state.lastInputSize)}`,
    `- Ukuran output: ${formatBytes(state.lastOutputSize)}`,
    `- Baris input: ${state.lastInputLines}`,
    `- Baris output: ${countLines(state.lastOutput)}`,
    "",
    "## Output",
    "",
    "```lua",
    state.lastOutput,
    "```",
    "",
  ];
  return lines.join("\n");
}

// ---------- Init ----------
function init() {
  state.inputEditor = createEditor("inputEditor");
  state.outputEditor = createEditor("outputEditor", { readOnly: true, lineWrapping: true });

  // Change handler — abaikan saat kita sedang memuat preview secara programatik.
  const onEditorChange = () => {
    if (suppressEditorChange) return;
    // User benar-benar mengedit: hilangkan preview flag, sinkronkan raw.
    inputIsPreview = false;
    state.lastInputRaw = state.inputEditor.getValue();
    state.lastInputSize = state.lastInputRaw.length;
    state.lastInputLines = countLines(state.lastInputRaw);
    updateInputStats();
  };

  if (state.inputEditor.on) {
    try { state.inputEditor.on("change", onEditorChange); } catch (e) {}
  }
  // Fallback textarea
  $("inputEditor").addEventListener("input", onEditorChange);

  // Buttons — main
  $("obfuscateBtn").addEventListener("click", obfuscate);

  // Input editor actions
  $("pasteBtn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return toast("Paste", "Clipboard kosong.", "warn");
      const preview = text.length > EDITOR_PREVIEW_LIMIT;
      updateInputFilename("pasted.lua");
      setInputSource(text, preview);
      toast("Paste", `Source dimuat (${formatBytes(text.length)}).`, "success");
    } catch (e) {
      toast("Paste failed", "Izin clipboard ditolak. Gunakan Ctrl+V.", "warn");
    }
  });

  $("clearBtn").addEventListener("click", () => {
    setInputSource("", false);
    updateInputFilename("source.lua");
    $("fileMeta").classList.add("hidden");
  });

  $("formatBtn").addEventListener("click", () => {
    const src = inputIsPreview ? state.lastInputRaw : state.inputEditor.getValue();
    if (!src.trim()) return;
    try {
      const formatted = formatLua(src);
      if (formatted !== src) {
        setInputSource(formatted, formatted.length > EDITOR_PREVIEW_LIMIT);
      }
      toast("Format", "Source diformat.", "success");
    } catch (e) {
      toast("Format failed", e.message, "error");
    }
  });

  $("sampleBtn").addEventListener("click", () => {
    updateInputFilename("sample.lua");
    setInputSource(SAMPLE_LUA, false);
    toast("Sample", "Contoh Lua dimuat.", "success");
  });

  // Upload button (editor header & Files panel)
  const hiddenInput = $("fileInput");
  $("uploadBtn").addEventListener("click", () => hiddenInput.click());
  $("browseFileBtn").addEventListener("click", () => hiddenInput.click());

  hiddenInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFileUpload(f);
    hiddenInput.value = "";
  });

  // Drop area on Files panel
  const dropZone = $("fileDrop");
  ["dragenter", "dragover"].forEach(ev => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add("active");
    });
  });
  ["dragleave", "drop"].forEach(ev => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.remove("active");
    });
  });
  dropZone.addEventListener("drop", (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    handleFileUpload(files[0]);
  });
  dropZone.addEventListener("click", (e) => {
    if (e.target.closest("#browseFileBtn")) return;
    hiddenInput.click();
  });

  // Editor wrap drop area (workspace)
  const editorDropArea = $("inputEditorWrap");
  ["dragenter", "dragover"].forEach(ev => {
    editorDropArea.addEventListener(ev, (e) => {
      e.preventDefault();
      editorDropArea.style.outline = "2px dashed var(--accent)";
    });
  });
  ["dragleave", "drop"].forEach(ev => {
    editorDropArea.addEventListener(ev, (e) => {
      e.preventDefault();
      editorDropArea.style.outline = "none";
    });
  });
  editorDropArea.addEventListener("drop", (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    handleFileUpload(files[0]);
  });

  // Output actions
  $("copyBtn").addEventListener("click", async () => {
    if (!state.lastOutput) return toast("Copy", "Belum ada output.", "warn");
    try {
      await navigator.clipboard.writeText(state.lastOutput);
      toast("Copy", `Output lengkap (${formatBytes(state.lastOutputSize)}) disalin ke clipboard.`, "success");
    } catch (e) {
      toast("Copy failed", "Izin clipboard ditolak atau output terlalu besar.", "warn", 4200);
    }
  });

  const dlLua = () => {
    if (!state.lastOutput) return toast("Download", "Belum ada output.", "warn");
    download(`${getBaseName()}_protected.lua`, state.lastOutput, "text/plain;charset=utf-8");
  };
  const dlLuau = () => {
    if (!state.lastOutput) return toast("Download", "Belum ada output.", "warn");
    download(`${getBaseName()}_protected.luau`, state.lastOutput, "text/plain;charset=utf-8");
  };
  const dlTxt = () => {
    if (!state.lastOutput) return toast("Download", "Belum ada output.", "warn");
    download(`${getBaseName()}_protected.txt`, state.lastOutput, "text/plain;charset=utf-8");
  };

  $("downloadLuaBtn").addEventListener("click", dlLua);
  $("downloadLuauBtn").addEventListener("click", dlLuau);
  $("downloadTxtBtn").addEventListener("click", dlTxt);
  $("dlLua").addEventListener("click", dlLua);
  $("dlLuau").addEventListener("click", dlLuau);
  $("dlTxt").addEventListener("click", dlTxt);

  $("dlZipLike").addEventListener("click", () => {
    if (!state.lastOutput) return toast("Download", "Belum ada output.", "warn");
    download(`${getBaseName()}_report.md`, buildReport(), "text/markdown;charset=utf-8");
  });

  $("dlInputBackup").addEventListener("click", () => {
    const src = inputIsPreview ? state.lastInputRaw : state.inputEditor.getValue();
    if (!src || !src.trim()) return toast("Download", "Source input kosong.", "warn");
    download(`${getBaseName()}_backup.lua`, src, "text/plain;charset=utf-8");
  });

  // Navigation
  for (const btn of document.querySelectorAll(".nav-item")) {
    btn.addEventListener("click", () => switchPanel(btn.dataset.target));
  }

  // Keyboard shortcut
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      obfuscate();
    }
  });

  // Initial state
  updateInputStats();
  updateOutputStats();
  updateOutputMeta("Belum ada hasil", "");
  setProgress(0, "Ready");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}