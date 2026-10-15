import { Share } from '@capacitor/share';
import { createEngine } from './speech.js';
import { createRecorder } from './recorder.js';
import { createWhisper } from './whisper.js';
import { bg } from './bg.js';
import { putAudio, getAudio, delAudio } from './store.js';
import { decodeTo16k, splitWindows, SAMPLE_RATE } from './audio.js';
import { processSegment, countWords, titleOf, fmtTime, segmentsToText, stampAtCaret } from './text.js';

var KEY = 'scribe.v1';
var LANGS = [
  ['en-NG', 'English (Nigeria)'], ['en-GB', 'English (UK)'], ['en-US', 'English (US)'],
  ['fr-FR', 'French'], ['ha-NG', 'Hausa'], ['yo-NG', 'Yoruba'], ['ig-NG', 'Igbo'],
  ['es-ES', 'Spanish'], ['ar-SA', 'Arabic'], ['sw-KE', 'Swahili']
];
var MODES = [
  ['auto', 'Automatic (recommended)'],
  ['online', 'Online only (best accuracy)'],
  ['device', 'On-device only (works offline)']
];
var MODELS = [
  ['onnx-community/whisper-tiny.en', 'Fast · English · about 40 MB', '40 MB'],
  ['onnx-community/whisper-base.en', 'Better · English · about 80 MB', '80 MB'],
  ['onnx-community/whisper-base', 'Multilingual · about 80 MB', '80 MB']
];
var WLANGS = [['auto', 'Detect automatically'], ['english', 'English'], ['yoruba', 'Yoruba'], ['hausa', 'Hausa'],
  ['french', 'French'], ['swahili', 'Swahili'], ['arabic', 'Arabic'], ['spanish', 'Spanish']];

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function mb(bytes) { return (bytes / 1048576).toFixed(bytes > 10485760 ? 0 : 1) + ' MB'; }

/* ---------- saved data ---------- */
function load() {
  var s = null;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* ignore */ }
  s = s || {};
  var st = s.settings || {};
  return {
    settings: {
      lang: st.lang || 'en-NG', mode: st.mode || 'auto',
      commands: st.commands !== false, periodPause: !!st.periodPause,
      stamps: !!st.stamps, wake: st.wake !== false,
      dict: Array.isArray(st.dict) ? st.dict : [],
      capture: st.capture === 'rec' ? 'rec' : 'live',
      liveAudio: !!st.liveAudio, autoTranscribe: st.autoTranscribe !== false,
      model: st.model || MODELS[0][0], wlang: st.wlang || 'auto',
      bg: st.bg !== false,
      ready: st.ready && typeof st.ready === 'object' ? st.ready : {}
    },
    notes: Array.isArray(s.notes) ? s.notes : [],
    cur: s.cur || null
  };
}
var S = load();
function persist() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }

function newNote() {
  S.notes = S.notes.filter(function (x) { return x.text.trim() || x.audio || x.id === S.cur; });
  var n = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: '', created: Date.now(), updated: Date.now(), lang: S.settings.lang, secs: 0, audio: false };
  S.notes.unshift(n);
  S.cur = n.id;
  persist();
  return n;
}
function note() {
  var n = S.notes.filter(function (x) { return x.id === S.cur; })[0];
  return n || newNote();
}
function noteById(id) { return S.notes.filter(function (x) { return x.id === id; })[0]; }

/* ---------- state ---------- */
var listening = false, recording = false, sessStart = 0, timerId = null, engineLabel = '';
var logLines = [], lock = null, saveTimer = null, msgTimer = null, segStart = null;
var audioUrl = null, tr = { busy: false, cancel: false };
var nat = null, bgNote = '', bgNoteAt = 0;

/* ---------- background work (Android foreground service) ---------- */
function bgOn() { return bg.native && S.settings.bg; }
function syncBg() {
  if (!bgOn() || nat) return;
  if (listening) bg.keepAlive('Scribe is listening', true);
  else if (tr.busy) bg.keepAlive('Scribe is working on a transcription', false);
  else bg.release();
}
function bgText(t) {
  if (!bgOn() || !t || t === bgNote || Date.now() - bgNoteAt < 3000) return;
  bgNote = t; bgNoteAt = Date.now();
  bg.update(t.length > 90 ? t.slice(0, 90) : t);
}

function log(l) {
  logLines.unshift(new Date().toTimeString().slice(0, 8) + ' ' + l);
  logLines = logLines.slice(0, 30);
}
function capturing() { return listening || recording; }
function sessSecs() { return sessStart ? (Date.now() - sessStart) / 1000 : 0; }

function setMsg(text, kind) {
  var m = $('msg');
  m.textContent = text || '';
  m.className = kind || '';
  if (msgTimer) clearTimeout(msgTimer);
  if (text && kind === 'info') msgTimer = setTimeout(function () { setMsg(''); }, 4500);
}

function updateCounts() {
  $('wc').textContent = countWords($('txt').value) + ' words';
  var n = note();
  $('timer').textContent = fmtTime(capturing() || sessStart ? sessSecs() : (n.audioSecs || n.secs || 0));
}

function updateChip() {
  var on = navigator.onLine;
  var c = $('chip');
  c.textContent = (on ? 'Online' : 'Offline') + (listening && engineLabel ? ' · ' + engineLabel : (recording ? ' · Recording' : ''));
  c.className = 'chip' + (on ? '' : ' off');
}

async function wake(on) {
  try {
    if (on && S.settings.wake && 'wakeLock' in navigator) lock = await navigator.wakeLock.request('screen');
    else if (lock) { await lock.release(); lock = null; }
  } catch (e) { /* ignore */ }
}

function beginSession() {
  if (sessStart) return;
  sessStart = Date.now();
  timerId = setInterval(updateCounts, 500);
  wake(true);
}
function endSession() {
  if (!sessStart) return;
  var n = note();
  n.secs = (n.secs || 0) + sessSecs();
  sessStart = 0;
  clearInterval(timerId);
  wake(false);
  persist();
  updateCounts();
}

function refreshMic() {
  var on = capturing();
  $('mic').classList.toggle('on', on);
  $('mic').setAttribute('aria-label', on ? 'Stop' : (S.settings.capture === 'rec' ? 'Start recording' : 'Start listening'));
  updateChip();
}

function refreshMode() {
  var rec = S.settings.capture === 'rec';
  $('m-live').classList.toggle('on', !rec);
  $('m-rec').classList.toggle('on', rec);
  $('modehelp').textContent = rec
    ? 'Record saves the audio and turns it into text when you stop, using the offline speech engine.'
    : 'Live shows words as you speak.' + (S.settings.liveAudio ? ' Audio is also being saved (experimental).' : ' Audio is not saved. Use Record to keep it.');
  refreshMic();
}

/* ---------- live speech ---------- */
var recorder = createRecorder();

function commit(raw) {
  var ta = $('txt'), n = note();
  var withAudio = recording;
  var at = segStart == null ? sessSecs() : segStart;
  segStart = null;
  var out = processSegment(raw, ta.value, {
    commands: S.settings.commands, periodPause: S.settings.periodPause, dict: S.settings.dict,
    stamp: (S.settings.stamps || withAudio) ? fmtTime(Math.max(0, at - 0.5)) : ''
  });
  ta.value = out;
  n.text = out; n.updated = Date.now(); n.lang = S.settings.lang;
  persist(); updateCounts();
  ta.scrollTop = ta.scrollHeight;
}

var engine = createEngine({
  onPartial: function (t) {
    $('live').textContent = t;
    if (t && segStart == null) segStart = sessSecs();
  },
  onFinal: commit,
  onMessage: setMsg,
  onLog: log,
  onEngine: function (l) { engineLabel = l; updateChip(); },
  onState: function (st) {
    listening = st !== 'idle';
    if (st === 'listening') beginSession();
    syncBg();
    if (st === 'idle') {
      engineLabel = '';
      $('live').textContent = '';
      if (!recording) endSession();
    }
    refreshMic();
  }
});

/* ---------- starting and stopping ---------- */
function micError(e) {
  var n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Microphone permission is needed. Allow it in your phone Settings, Apps, Scribe, Permissions.';
  if (n === 'NotFoundError') return 'No microphone was found.';
  return 'Recording could not start: ' + ((e && e.message) || e);
}

async function startRecording() {
  if (bgOn()) {
    try {
      var perm = await bg.ensurePermissions();
      if (!perm || !perm.mic) { var pe = new Error('Microphone permission is needed.'); pe.name = 'NotAllowedError'; throw pe; }
      var started = await bg.startRecording();
      var m = { path: started.path, peak: 0, polls: 0, timer: null };
      m.timer = setInterval(async function () {
        try { var l = await bg.level(); m.polls++; if (l && l.peak > m.peak) m.peak = l.peak; } catch (e) { /* ignore */ }
      }, 1000);
      nat = m;
      recording = true;
      beginSession();
      refreshMic();
      return;
    } catch (e) {
      if (e && e.name === 'NotAllowedError') throw e;
      log('background recorder failed, using the basic recorder: ' + ((e && e.message) || e));
      nat = null;
    }
  }
  await recorder.start();
  recording = true;
  beginSession();
  refreshMic();
}

async function stopCapture() {
  if (!nat) return recorder.stop();
  var m = nat; nat = null;
  clearInterval(m.timer);
  var o = await bg.stopRecording();
  var blob = await bg.readFile(o.path);
  if (!blob.type || blob.type === 'application/octet-stream') blob = new Blob([blob], { type: 'audio/mp4' });
  bg.deleteFile(o.path);
  return { blob: blob, secs: o.secs, peak: m.polls ? m.peak : 1 };
}

async function finishRecording() {
  var n = note();
  var r;
  try { r = await stopCapture(); }
  catch (e) {
    recording = false;
    if (!listening) endSession();
    refreshMic();
    setMsg('The recording could not be finished: ' + ((e && e.message) || e), 'error');
    return false;
  }
  recording = false;
  if (!listening) endSession();
  refreshMic();
  if (!r.blob.size) { setMsg('Nothing was recorded.', 'warn'); return false; }
  try {
    await putAudio(n.id, { blob: r.blob, type: r.blob.type });
  } catch (e) {
    setMsg('The recording could not be saved: ' + ((e && e.message) || e), 'error');
    return false;
  }
  n.audio = true; n.audioSecs = r.secs; n.audioSize = r.blob.size; n.updated = Date.now();
  persist();
  await refreshPlayer();
  updateCounts();
  if (r.peak < 0.002 && r.secs > 2) {
    setMsg('The recording is silent. Your phone may not allow recording while the live recogniser is listening. Use Record mode instead.', 'error');
    return false;
  }
  return true;
}

async function toggleMic() {
  if (tr.busy) { setMsg('Wait for the transcription to finish, or cancel it first.', 'warn'); return; }
  if (capturing()) { await stopAll(); return; }
  var wantsAudio = S.settings.capture === 'rec' || S.settings.liveAudio;
  var n = note();
  if (wantsAudio && n.audio) {
    n = newNote();
    $('txt').value = '';
    await refreshPlayer();
    updateCounts();
    setMsg('Started a new transcript because the previous one already has audio.', 'info');
  }
  segStart = null;
  if (S.settings.capture === 'rec') {
    try { await startRecording(); setMsg(''); $('live').textContent = 'Recording… it will be transcribed when you stop.'; }
    catch (e) { setMsg(micError(e), 'error'); }
    return;
  }
  var recOk = false, warn = '';
  if (S.settings.liveAudio) {
    try { await startRecording(); recOk = true; }
    catch (e) { warn = 'Audio could not be saved, so this is dictation only. ' + micError(e); }
  }
  setMsg(warn, warn ? 'warn' : '');
  var ok = await engine.start({ lang: S.settings.lang, mode: S.settings.mode });
  if (!ok && recOk) { await recorder.stop(); recording = false; endSession(); refreshMic(); }
}

async function stopAll() {
  var wasRec = recording, wasLive = listening;
  if (wasLive) await engine.stop();
  var saved = true;
  if (wasRec) saved = await finishRecording();
  $('live').textContent = '';
  if (wasRec && saved && S.settings.capture === 'rec' && S.settings.autoTranscribe) {
    transcribeNote(note().id, { auto: true });
  } else if (wasRec && saved && S.settings.capture === 'rec') {
    setMsg('Audio saved. Tap Transcribe audio to turn it into text.', 'info');
  }
  syncBg();
}

/* ---------- audio player ---------- */
async function refreshPlayer() {
  var n = note(), id = n.id;
  var box = $('player'), aud = $('aud');
  if (!n.audio) {
    box.hidden = true;
    aud.removeAttribute('src'); aud.load();
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
    return;
  }
  var rec = null;
  try { rec = await getAudio(id); } catch (e) { /* ignore */ }
  if (S.cur !== id) return;
  if (!rec || !rec.blob) {
    n.audio = false; persist(); box.hidden = true;
    setMsg('The saved audio for this transcript is missing.', 'warn');
    return;
  }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(rec.blob);
  aud.src = audioUrl;
  aud.playbackRate = 1; $('speed').textContent = '1×';
  box.hidden = false;
  $('trbtn').textContent = n.text.trim() ? 'Transcribe again' : 'Transcribe audio';
}

// Recorded files often report an infinite length until the browser scans them once.
$('aud').addEventListener('loadedmetadata', function () {
  var a = $('aud');
  if (a.duration === Infinity) {
    a.currentTime = 1e101;
    a.addEventListener('timeupdate', function fix() { a.removeEventListener('timeupdate', fix); a.currentTime = 0; });
  }
});

function seekBy(d) { var a = $('aud'); a.currentTime = Math.max(0, a.currentTime + d); }
$('back5').addEventListener('click', function () { seekBy(-5); });
$('fwd5').addEventListener('click', function () { seekBy(5); });
$('speed').addEventListener('click', function () {
  var a = $('aud'), steps = [1, 1.25, 1.5, 0.75], i = steps.indexOf(a.playbackRate);
  a.playbackRate = steps[(i + 1) % steps.length];
  $('speed').textContent = a.playbackRate + '×';
});
$('playline').addEventListener('click', function () {
  var ta = $('txt'), t = stampAtCaret(ta.value, ta.selectionStart);
  if (t == null) { setMsg('Tap a line that starts with a time like [01:25], then press Play from cursor.', 'warn'); return; }
  var a = $('aud');
  a.currentTime = Math.max(0, t - 1);
  var p = a.play(); if (p && p.catch) p.catch(function () { /* needs a tap */ });
});
$('adel').addEventListener('click', async function () {
  if (!confirm('Delete the saved audio for this transcript? The text stays.')) return;
  var n = note();
  try { await delAudio(n.id); } catch (e) { /* ignore */ }
  n.audio = false; n.audioSecs = 0; n.audioSize = 0; persist();
  await refreshPlayer();
});

/* ---------- offline transcription (Whisper) ---------- */
var whisper = createWhisper();

function showTr(frac, text, isError) {
  var bar = $('trbar');
  bar.hidden = frac == null;
  if (frac != null) bar.value = Math.max(0, Math.min(1, frac));
  var s = $('trstat');
  s.textContent = text || '';
  s.className = isError ? 'error' : '';
  if (tr.busy) bgText(text);
  $('trbtn').hidden = tr.busy;
  $('trcancel').hidden = !tr.busy;
  $('adel').hidden = tr.busy;
}

function fmtLeft(sec) {
  if (sec < 60) return Math.max(5, Math.round(sec / 5) * 5) + ' seconds';
  return Math.round(sec / 60) + ' min';
}

function modelProgress(label, set) {
  var files = {};
  return function (p) {
    if (!p) return;
    if (p.file && p.total) files[p.file] = { l: p.loaded || 0, t: p.total };
    var L = 0, T = 0;
    Object.keys(files).forEach(function (k) { L += files[k].l; T += files[k].t; });
    set(T ? L / T : null, label + (T ? ' ' + Math.round(100 * L / T) + '%' : ''));
  };
}

async function ensureModel(set) {
  var model = S.settings.model;
  var info = MODELS.filter(function (m) { return m[0] === model; })[0] || MODELS[0];
  if (!S.settings.ready[model]) {
    if (!navigator.onLine) throw new Error('The speech model must be downloaded once while you are online. Connect, then try again.');
    if (!confirm('Download the speech model now? It is about ' + info[2] + ', needed only once. After that it works offline.')) throw new Error('cancelled');
  }
  set(0, S.settings.ready[model] ? 'Preparing the speech engine…' : 'Downloading the speech model… 0%');
  await whisper.load(model, modelProgress('Downloading the speech model…', set));
  S.settings.ready[model] = true;
  persist();
}

async function transcribeNote(id, o) {
  o = o || {};
  var n = noteById(id);
  if (!n || !n.audio || tr.busy) return;
  if (!o.auto && n.text.trim() && !confirm('Replace the current text with a new transcription of the audio?')) return;
  tr.busy = true; tr.cancel = false;
  syncBg();
  var set = function (f, t) { showTr(f, t); };
  showTr(0, 'Preparing…');
  try {
    await ensureModel(set);
    var rec = await getAudio(id);
    if (!rec || !rec.blob) throw new Error('The saved audio is missing.');
    showTr(null, 'Reading the audio…');
    var audio = await decodeTo16k(rec.blob);
    var totalSec = audio.length / SAMPLE_RATE;
    var multi = !/\.en$/.test(S.settings.model);
    var lang = multi && S.settings.wlang !== 'auto' ? S.settings.wlang : undefined;
    var wins = splitWindows(audio, 60), segs = [], t0 = Date.now(), done = 0;
    for (var i = 0; i < wins.length; i++) {
      if (tr.cancel) throw new Error('cancelled');
      var s = wins[i][0], e = wins[i][1], off = s / SAMPLE_RATE;
      var out = await whisper.run(audio.slice(s, e), lang);
      (out.chunks || []).forEach(function (c) {
        var ts = c.timestamp || [0, null];
        segs.push({ t0: off + (ts[0] || 0), t1: off + (ts[1] == null ? (e - s) / SAMPLE_RATE : ts[1]), text: c.text });
      });
      done += (e - s) / SAMPLE_RATE;
      var left = ((Date.now() - t0) / 1000 / done) * (totalSec - done);
      showTr(done / totalSec, i + 1 < wins.length ? 'Transcribing… about ' + fmtLeft(left) + ' left' : 'Finishing…');
    }
    var text = segmentsToText(segs, S.settings.dict);
    if (!text) { showTr(null, 'No speech was found in the audio.', true); }
    else {
      n.text = text; n.updated = Date.now();
      n.lang = lang || S.settings.lang;
      persist();
      if (S.cur === id) { $('txt').value = text; updateCounts(); }
      showTr(null, 'Done. Tap a line, then press Play from cursor to check it against the audio.');
    }
  } catch (err) {
    var msg = String((err && err.message) || err);
    if (msg === 'cancelled' || msg === 'Cancelled') showTr(null, 'Cancelled.');
    else { log('transcribe failed: ' + msg); showTr(null, msg, true); }
  } finally {
    tr.busy = false;
    syncBg();
    $('trbtn').hidden = false; $('trcancel').hidden = true; $('adel').hidden = false;
    if (S.cur === id) await refreshPlayer();
  }
}

$('trbtn').addEventListener('click', function () { transcribeNote(note().id); });
$('trcancel').addEventListener('click', function () { tr.cancel = true; whisper.stop(); });

/* ---------- importing files ---------- */
function pickFile() { $('file').value = ''; $('file').click(); }
$('import').addEventListener('click', pickFile);
$('import2').addEventListener('click', pickFile);
$('file').addEventListener('change', async function () {
  var f = $('file').files && $('file').files[0];
  if (!f) return;
  if (capturing()) await stopAll();
  if (tr.busy) { setMsg('Wait for the current transcription to finish first.', 'warn'); return; }
  if (f.size > 120 * 1048576) {
    if (!confirm('This file is large (' + mb(f.size) + '). Long files can run out of memory on some phones. Continue?')) return;
  }
  var n = newNote();
  try { await putAudio(n.id, { blob: f, type: f.type }); }
  catch (e) { setMsg('The file could not be saved: ' + ((e && e.message) || e), 'error'); return; }
  n.audio = true; n.audioSize = f.size; n.name = f.name; n.updated = Date.now();
  persist();
  $('txt').value = '';
  go('rec');
  await refreshPlayer();
  updateCounts();
  setMsg('Imported ' + f.name + '.', 'info');
  transcribeNote(n.id, { auto: true });
});

/* ---------- transcript tools ---------- */
async function copyText() {
  var t = $('txt').value;
  if (!t.trim()) { setMsg('Nothing to copy yet.', 'warn'); return; }
  try { await navigator.clipboard.writeText(t); }
  catch (e) { var ta = $('txt'); ta.select(); document.execCommand('copy'); }
  setMsg('Copied.', 'info');
}
async function shareText() {
  var t = $('txt').value;
  if (!t.trim()) { setMsg('Nothing to share yet.', 'warn'); return; }
  try { await Share.share({ title: titleOf(t), text: t }); }
  catch (e) { if (navigator.share) { try { await navigator.share({ text: t }); } catch (e2) { /* cancelled */ } } else copyText(); }
}
async function showNote(id) {
  S.cur = id; persist();
  var n = note();
  $('txt').value = n.text;
  showTr(null, '');
  go('rec');
  updateCounts();
  await refreshPlayer();
}

/* ---------- views ---------- */
function go(v) {
  ['rec', 'lib', 'set'].forEach(function (x) { $('v-' + x).hidden = x !== v; });
  var btns = document.querySelectorAll('nav button');
  for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.view === v);
  $('title').textContent = { rec: 'Scribe', lib: 'Library', set: 'Settings' }[v];
  if (v === 'lib') renderLib();
  if (v === 'set') renderSettings();
}

function renderLib() {
  var q = $('lq').value.trim().toLowerCase();
  var list = S.notes.filter(function (n) { return (n.text.trim() || n.audio) && (!q || (n.text + ' ' + (n.name || '')).toLowerCase().indexOf(q) > -1); })
    .sort(function (a, b) { return b.updated - a.updated; });
  if (!list.length) {
    $('llist').innerHTML = '<div class="empty">' + (q ? 'No transcripts match your search.' : 'Your saved transcripts will appear here.') + '</div>';
    return;
  }
  $('llist').innerHTML = list.map(function (n) {
    var d = new Date(n.updated).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    var title = n.text.trim() ? titleOf(n.text) : (n.name || 'Untitled');
    return '<div class="row"><button class="open" data-open="' + n.id + '"><b>' + esc(title) + '</b>' +
      '<small>' + esc(d) + ' · ' + countWords(n.text) + ' words' + (n.audio ? ' · Audio ' + (n.audioSize ? mb(n.audioSize) : '') : '') + '</small></button>' +
      '<button class="del" data-del="' + n.id + '" aria-label="Delete transcript">Delete</button></div>';
  }).join('');
}

function opts(list, cur) {
  return list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
}
function sw(key, label) {
  return '<label class="sw">' + esc(label) + '<input type="checkbox" data-set="' + key + '"' + (S.settings[key] ? ' checked' : '') + '></label>';
}
function audioTotal() {
  return S.notes.reduce(function (a, n) { return a + (n.audio ? (n.audioSize || 0) : 0); }, 0);
}

function renderSettings() {
  var st = S.settings;
  var ready = st.ready[st.model];
  var dict = st.dict.map(function (d, i) {
    return '<div class="dict"><input type="text" value="' + esc(d.from) + '" data-dfrom="' + i + '" aria-label="Heard as">' +
      '<input type="text" value="' + esc(d.to) + '" data-dto="' + i + '" aria-label="Write as">' +
      '<button class="del" data-ddel="' + i + '">Remove</button></div>';
  }).join('');
  $('v-set').innerHTML =
    '<div class="group"><h2>Live dictation</h2>' +
    '<label class="f">Language<select data-set="lang">' + opts(LANGS, st.lang) + '</select></label>' +
    '<p class="help">Hausa, Yoruba and Igbo depend on what your phone\'s speech service supports.</p>' +
    '<label class="f">Engine<select data-set="mode">' + opts(MODES, st.mode) + '</select></label>' +
    '<p class="help">Automatic uses online recognition when you have a connection and the on-device engine when you do not. For offline Live use, download your language pack first: search your phone Settings for "offline speech recognition".</p>' +
    sw('liveAudio', 'Also save audio in Live mode (experimental)') +
    '<p class="help">Some phones give the microphone to only one listener, so this can silence the recording or the dictation. If it does, turn it off and use Record mode.</p></div>' +
    '<div class="group"><h2>Offline transcription (Record and Import)</h2>' +
    '<label class="f">Speech model<select data-set="model">' + opts(MODELS.map(function (m) { return [m[0], m[1]]; }), st.model) + '</select></label>' +
    '<label class="f">Language (multilingual model only)<select data-set="wlang">' + opts(WLANGS, st.wlang) + '</select></label>' +
    sw('autoTranscribe', 'Transcribe automatically after recording') +
    '<p class="help" id="wstat">' + (ready ? 'This model is downloaded and works offline.' : 'Not downloaded yet. It downloads once (needs internet), then works offline.') + '</p>' +
    '<progress id="wbar" max="1" value="0" hidden></progress>' +
    '<button class="btn p" data-wdl="1">' + (ready ? 'Check model' : 'Download model') + '</button>' +
    '<button class="btn d" data-wrm="1">Remove downloaded models</button>' +
    '<p class="help">Saved audio uses ' + mb(audioTotal()) + ' of storage.</p></div>' +
    '<div class="group"><h2>Writing</h2>' +
    sw('commands', 'Voice commands (say "new line", "full stop", "comma", "question mark", "delete that")') +
    sw('periodPause', 'Add a full stop at each pause') +
    sw('stamps', 'Timestamp every live segment') +
    sw('wake', 'Keep screen on while listening') + '</div>' +
    (bg.native ? '<div class="group"><h2>Background</h2>' +
      sw('bg', 'Keep recording, listening and transcribing when the app is in the background') +
      '<p class="help">A small notification shows while Scribe is working. Some phones (Tecno, Infinix, Xiaomi, Samsung and others) stop apps aggressively. If it stops, allow Scribe to run without battery limits.</p>' +
      '<button class="btn" data-batt="1">Open battery settings</button></div>' : '') +
    '<div class="group"><h2>My words</h2><p class="help">Fix words that keep coming out wrong. Left: what it hears. Right: what to write. Applies to live dictation and transcribed audio.</p>' + dict +
    '<div class="dict"><input type="text" id="nf" placeholder="Heard as" aria-label="New heard as"><input type="text" id="nt" placeholder="Write as" aria-label="New write as"><button class="del" style="color:var(--ok)" data-dadd="1">Add</button></div></div>' +
    '<div class="group"><h2>Diagnostics</h2><button class="btn" data-diag="1">Run check</button><pre id="diag">Tap Run check to test the speech engines.</pre></div>' +
    '<div class="group"><button class="btn d" data-wipe="1">Delete all transcripts and audio</button></div>';
}

async function runDiag() {
  var d = await engine.diagnostics(S.settings.lang);
  var w = 'not started';
  try { var i = await whisper.info(); w = 'ok (engine files ' + (i.ortLocal ? 'bundled' : 'downloaded on demand') + ', threads ' + (i.isolated ? 'multi' : 'single') + ')'; }
  catch (e) { w = 'error: ' + ((e && e.message) || e); }
  var rec = !!(window.MediaRecorder && navigator.mediaDevices);
  $('diag').textContent =
    'Live speech service: ' + d.available + '\n' +
    'Microphone permission: ' + d.permission + '\n' +
    'On-device for ' + S.settings.lang + ': ' + d.onDevice + '\n' +
    'Plugin version: ' + d.plugin + '\n' +
    'Audio recording supported: ' + rec + '\n' +
    'Background service: ' + (bg.native ? (S.settings.bg ? 'on' : 'off') : 'not available here') + '\n' +
    'Offline transcription engine: ' + w + '\n' +
    'Network: ' + (navigator.onLine ? 'online' : 'offline') + '\n\n' +
    'Recent events:\n' + (logLines.join('\n') || '(none yet)');
}

async function downloadModel() {
  var bar = $('wbar'), stat = $('wstat');
  bar.hidden = false; bar.value = 0;
  tr.busy = true;
  syncBg();
  try {
    await ensureModel(function (f, t) { if (f != null) bar.value = f; stat.textContent = t; });
    stat.textContent = 'This model is downloaded and works offline.';
  } catch (e) {
    var m = String((e && e.message) || e);
    stat.textContent = m === 'cancelled' ? 'Cancelled.' : m;
    log('model download failed: ' + m);
  } finally { tr.busy = false; syncBg(); bar.hidden = true; }
}

async function removeModels() {
  if (!confirm('Remove the downloaded speech models? You will need internet to download one again.')) return;
  try {
    var keys = await caches.keys();
    for (var i = 0; i < keys.length; i++) if (/transformers|onnx|huggingface/i.test(keys[i])) await caches.delete(keys[i]);
  } catch (e) { /* ignore */ }
  whisper.stop();
  S.settings.ready = {};
  persist();
  renderSettings();
}

/* ---------- events ---------- */
$('mic').addEventListener('click', toggleMic);
$('copy').addEventListener('click', copyText);
$('share').addEventListener('click', shareText);
$('clear').addEventListener('click', function () {
  if (!$('txt').value.trim() || !confirm('Clear the text of this transcript? Saved audio stays.')) return;
  $('txt').value = ''; note().text = ''; persist(); updateCounts(); refreshPlayer();
});
$('new').addEventListener('click', async function () {
  if (tr.busy) { setMsg('Wait for the transcription to finish first.', 'warn'); return; }
  if (capturing()) await stopAll();
  newNote();
  $('txt').value = '';
  showTr(null, '');
  await refreshPlayer();
  updateCounts();
  setMsg('Started a new transcript. The old one is in your Library.', 'info');
});
$('txt').addEventListener('input', function () {
  var n = note();
  n.text = $('txt').value;
  n.updated = Date.now();
  updateCounts();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
});
$('lq').addEventListener('input', renderLib);
$('m-live').addEventListener('click', function () { if (capturing()) return; S.settings.capture = 'live'; persist(); refreshMode(); });
$('m-rec').addEventListener('click', function () { if (capturing()) return; S.settings.capture = 'rec'; persist(); refreshMode(); });

document.querySelector('nav').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-view]');
  if (b) go(b.dataset.view);
});
$('llist').addEventListener('click', async function (e) {
  var o = e.target.closest('[data-open]');
  if (o) {
    if (tr.busy) { setMsg('Wait for the transcription to finish first.', 'warn'); go('rec'); return; }
    if (capturing()) await stopAll();
    showNote(o.dataset.open);
    return;
  }
  var d = e.target.closest('[data-del]');
  if (d && confirm('Delete this transcript and its audio?')) {
    var id = d.dataset.del;
    try { await delAudio(id); } catch (err) { /* ignore */ }
    S.notes = S.notes.filter(function (n) { return n.id !== id; });
    if (S.cur === id) { S.cur = null; $('txt').value = ''; }
    persist(); renderLib();
  }
});

var setView = $('v-set');
setView.addEventListener('change', function (e) {
  var t = e.target;
  if (t.dataset.set) {
    S.settings[t.dataset.set] = t.type === 'checkbox' ? t.checked : t.value;
    persist();
    if (t.dataset.set === 'model') renderSettings();
    if (t.dataset.set === 'liveAudio') refreshMode();
  } else if (t.dataset.dfrom != null) { S.settings.dict[t.dataset.dfrom].from = t.value.trim(); persist(); }
  else if (t.dataset.dto != null) { S.settings.dict[t.dataset.dto].to = t.value.trim(); persist(); }
});
setView.addEventListener('click', async function (e) {
  var t = e.target.closest('button'); if (!t) return;
  if (t.dataset.dadd) {
    var f = $('nf').value.trim(), to = $('nt').value.trim();
    if (!f || !to) { alert('Fill in both boxes.'); return; }
    S.settings.dict.push({ from: f, to: to }); persist(); renderSettings();
  } else if (t.dataset.ddel != null) {
    S.settings.dict.splice(+t.dataset.ddel, 1); persist(); renderSettings();
  } else if (t.dataset.diag) { runDiag(); }
  else if (t.dataset.batt) { bg.batterySettings(); }
  else if (t.dataset.wdl) { if (!tr.busy) downloadModel(); }
  else if (t.dataset.wrm) { removeModels(); }
  else if (t.dataset.wipe) {
    if (!confirm('Delete every saved transcript and recording? This cannot be undone.')) return;
    if (capturing()) await stopAll();
    for (var i = 0; i < S.notes.length; i++) { try { await delAudio(S.notes[i].id); } catch (err) { /* ignore */ } }
    S.notes = []; S.cur = null; persist(); $('txt').value = ''; note(); await refreshPlayer(); updateCounts(); renderSettings();
    setMsg('Everything was deleted.', 'info');
  }
});

window.addEventListener('online', updateChip);
window.addEventListener('offline', updateChip);
document.addEventListener('visibilitychange', function () {
  var safe = bgOn() && (nat || (listening && !recording));
  if (document.hidden && capturing() && !safe) {
    stopAll();
    setMsg('Stopped because the app went to the background. Your audio so far was kept. Tap the microphone to continue.', 'warn');
  }
});

/* ---------- start ---------- */
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
$('txt').value = note().text;
refreshMode();
updateCounts();
updateChip();
refreshPlayer();
