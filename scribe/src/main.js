import { Share } from '@capacitor/share';
import { createEngine } from './speech.js';
import { processSegment, countWords, titleOf, fmtTime } from './text.js';

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

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

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
      dict: Array.isArray(st.dict) ? st.dict : []
    },
    notes: Array.isArray(s.notes) ? s.notes : [],
    cur: s.cur || null
  };
}
var S = load();
function persist() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }

function note() {
  var n = S.notes.filter(function (x) { return x.id === S.cur; })[0];
  if (!n) {
    S.notes = S.notes.filter(function (x) { return x.text.trim(); });
    n = { id: Date.now().toString(36), text: '', created: Date.now(), updated: Date.now(), lang: S.settings.lang, secs: 0 };
    S.notes.unshift(n);
    S.cur = n.id;
    persist();
  }
  return n;
}

/* ---------- state ---------- */
var view = 'rec', listening = false, startedAt = 0, timerId = null, engineLabel = '';
var logLines = [], lock = null, saveTimer = null, msgTimer = null;

function log(l) {
  logLines.unshift(new Date().toTimeString().slice(0, 8) + ' ' + l);
  logLines = logLines.slice(0, 25);
}

function elapsed() {
  return note().secs + (startedAt ? (Date.now() - startedAt) / 1000 : 0);
}

function setMsg(text, kind) {
  var m = $('msg');
  m.textContent = text || '';
  m.className = kind || '';
  if (msgTimer) clearTimeout(msgTimer);
  if (text && kind === 'info') msgTimer = setTimeout(function () { setMsg(''); }, 4000);
}

function updateCounts() {
  $('wc').textContent = countWords($('txt').value) + ' words';
  $('timer').textContent = fmtTime(elapsed());
}

function updateChip() {
  var chip = $('chip');
  var on = navigator.onLine;
  chip.textContent = (on ? 'Online' : 'Offline') + (listening && engineLabel ? ' · ' + engineLabel : '');
  chip.className = 'chip' + (on ? '' : ' off');
}

async function wake(on) {
  try {
    if (on && S.settings.wake && 'wakeLock' in navigator) lock = await navigator.wakeLock.request('screen');
    else if (lock) { await lock.release(); lock = null; }
  } catch (e) { /* ignore */ }
}

/* ---------- speech ---------- */
function commit(raw) {
  var ta = $('txt');
  var n = note();
  var out = processSegment(raw, ta.value, {
    commands: S.settings.commands, periodPause: S.settings.periodPause,
    dict: S.settings.dict, stamp: S.settings.stamps ? fmtTime(elapsed()) : ''
  });
  ta.value = out;
  n.text = out;
  n.updated = Date.now();
  n.lang = S.settings.lang;
  persist();
  updateCounts();
  ta.scrollTop = ta.scrollHeight;
}

var engine = createEngine({
  onPartial: function (t) { $('live').textContent = t; },
  onFinal: commit,
  onMessage: setMsg,
  onLog: log,
  onEngine: function (l) { engineLabel = l; updateChip(); },
  onState: function (st) {
    listening = st !== 'idle';
    var mic = $('mic');
    mic.classList.toggle('on', listening);
    mic.setAttribute('aria-label', listening ? 'Stop listening' : 'Start listening');
    if (st === 'listening' && !startedAt) {
      startedAt = Date.now();
      timerId = setInterval(updateCounts, 500);
      wake(true);
    }
    if (st === 'idle') {
      if (startedAt) {
        note().secs += (Date.now() - startedAt) / 1000;
        startedAt = 0;
        clearInterval(timerId);
        persist();
      }
      wake(false);
      engineLabel = '';
      $('live').textContent = '';
      updateCounts();
    }
    updateChip();
  }
});

async function toggleMic() {
  if (listening) { await engine.stop(); return; }
  note();
  setMsg('');
  await engine.start({ lang: S.settings.lang, mode: S.settings.mode });
}

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
function showNote(id) {
  S.cur = id; persist();
  var n = note();
  $('txt').value = n.text;
  updateCounts();
  go('rec');
}

/* ---------- views ---------- */
function go(v) {
  view = v;
  ['rec', 'lib', 'set'].forEach(function (x) { $('v-' + x).hidden = x !== v; });
  var btns = document.querySelectorAll('nav button');
  for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.view === v);
  $('title').textContent = { rec: 'Scribe', lib: 'Library', set: 'Settings' }[v];
  if (v === 'lib') renderLib();
  if (v === 'set') renderSettings();
}

function renderLib() {
  var q = $('lq').value.trim().toLowerCase();
  var list = S.notes.filter(function (n) { return n.text.trim() && (!q || n.text.toLowerCase().indexOf(q) > -1); })
    .sort(function (a, b) { return b.updated - a.updated; });
  if (!list.length) {
    $('llist').innerHTML = '<div class="empty">' + (q ? 'No transcripts match your search.' : 'Your saved transcripts will appear here.') + '</div>';
    return;
  }
  $('llist').innerHTML = list.map(function (n) {
    var d = new Date(n.updated).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return '<div class="row"><button class="open" data-open="' + n.id + '"><b>' + esc(titleOf(n.text)) + '</b>' +
      '<small>' + esc(d) + ' · ' + countWords(n.text) + ' words' + (n.secs ? ' · ' + fmtTime(n.secs) : '') + '</small></button>' +
      '<button class="del" data-del="' + n.id + '" aria-label="Delete transcript">Delete</button></div>';
  }).join('');
}

function opts(list, cur) {
  return list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
}
function sw(key, label) {
  return '<label class="sw">' + esc(label) + '<input type="checkbox" data-set="' + key + '"' + (S.settings[key] ? ' checked' : '') + '></label>';
}

function renderSettings() {
  var st = S.settings;
  var dict = st.dict.map(function (d, i) {
    return '<div class="dict"><input type="text" value="' + esc(d.from) + '" data-dfrom="' + i + '" aria-label="Heard as">' +
      '<input type="text" value="' + esc(d.to) + '" data-dto="' + i + '" aria-label="Write as">' +
      '<button class="del" data-ddel="' + i + '">Remove</button></div>';
  }).join('');
  $('v-set').innerHTML =
    '<div class="group"><h2>Recognition</h2>' +
    '<label class="f">Language<select data-set="lang">' + opts(LANGS, st.lang) + '</select></label>' +
    '<p class="help">Hausa, Yoruba and Igbo depend on what your phone\'s speech service supports.</p>' +
    '<label class="f">Engine<select data-set="mode">' + opts(MODES, st.mode) + '</select></label>' +
    '<p class="help">Automatic uses online recognition when you have a connection and switches to the on-device engine when you do not. For offline use, download your language pack first: search your phone Settings for "offline speech recognition".</p></div>' +
    '<div class="group"><h2>Writing</h2>' +
    sw('commands', 'Voice commands (say "new line", "full stop", "comma", "question mark", "delete that")') +
    sw('periodPause', 'Add a full stop at each pause') +
    sw('stamps', 'Timestamp every segment') +
    sw('wake', 'Keep screen on while listening') + '</div>' +
    '<div class="group"><h2>My words</h2><p class="help">Fix words the recogniser keeps getting wrong. Left: what it hears. Right: what to write.</p>' + dict +
    '<div class="dict"><input type="text" id="nf" placeholder="Heard as" aria-label="New heard as"><input type="text" id="nt" placeholder="Write as" aria-label="New write as"><button class="del" style="color:var(--ok)" data-dadd="1">Add</button></div></div>' +
    '<div class="group"><h2>Diagnostics</h2><button class="btn" data-diag="1">Run check</button><pre id="diag">Tap Run check to test the speech engine.</pre></div>' +
    '<div class="group"><button class="btn d" data-wipe="1">Delete all transcripts</button></div>';
}

async function runDiag() {
  var d = await engine.diagnostics(S.settings.lang);
  $('diag').textContent =
    'Speech service available: ' + d.available + '\n' +
    'Microphone permission: ' + d.permission + '\n' +
    'On-device for ' + S.settings.lang + ': ' + d.onDevice + '\n' +
    'Plugin version: ' + d.plugin + '\n' +
    'Network: ' + (navigator.onLine ? 'online' : 'offline') + '\n\n' +
    'Recent events:\n' + (logLines.join('\n') || '(none yet)');
}

/* ---------- events ---------- */
$('mic').addEventListener('click', toggleMic);
$('copy').addEventListener('click', copyText);
$('share').addEventListener('click', shareText);
$('clear').addEventListener('click', function () {
  if (!$('txt').value.trim() || !confirm('Clear this transcript?')) return;
  $('txt').value = ''; note().text = ''; persist(); updateCounts();
});
$('new').addEventListener('click', async function () {
  if (listening) await engine.stop();
  S.cur = null; persist();
  note();
  $('txt').value = '';
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

document.querySelector('nav').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-view]');
  if (b) go(b.dataset.view);
});
$('llist').addEventListener('click', function (e) {
  var o = e.target.closest('[data-open]');
  if (o) { if (listening) engine.stop(); showNote(o.dataset.open); return; }
  var d = e.target.closest('[data-del]');
  if (d && confirm('Delete this transcript?')) {
    S.notes = S.notes.filter(function (n) { return n.id !== d.dataset.del; });
    if (S.cur === d.dataset.del) { S.cur = null; $('txt').value = ''; }
    persist(); renderLib();
  }
});

var setView = $('v-set');
setView.addEventListener('change', function (e) {
  var t = e.target;
  if (t.dataset.set) {
    S.settings[t.dataset.set] = t.type === 'checkbox' ? t.checked : t.value;
    persist();
  } else if (t.dataset.dfrom != null) { S.settings.dict[t.dataset.dfrom].from = t.value.trim(); persist(); }
  else if (t.dataset.dto != null) { S.settings.dict[t.dataset.dto].to = t.value.trim(); persist(); }
});
setView.addEventListener('click', function (e) {
  var t = e.target.closest('button'); if (!t) return;
  if (t.dataset.dadd) {
    var f = $('nf').value.trim(), to = $('nt').value.trim();
    if (!f || !to) { alert('Fill in both boxes.'); return; }
    S.settings.dict.push({ from: f, to: to }); persist(); renderSettings();
  } else if (t.dataset.ddel != null) {
    S.settings.dict.splice(+t.dataset.ddel, 1); persist(); renderSettings();
  } else if (t.dataset.diag) { runDiag(); }
  else if (t.dataset.wipe) {
    if (!confirm('Delete every saved transcript? This cannot be undone.')) return;
    if (listening) engine.stop();
    S.notes = []; S.cur = null; persist(); $('txt').value = ''; note(); updateCounts();
    setMsg('All transcripts deleted.', 'info');
  }
});

window.addEventListener('online', updateChip);
window.addEventListener('offline', updateChip);
document.addEventListener('visibilitychange', function () {
  if (document.hidden && listening) {
    engine.stop();
    setMsg('Listening stopped because the app went to the background. Tap the microphone to continue.', 'warn');
  }
});

/* ---------- start ---------- */
$('txt').value = note().text;
updateCounts();
updateChip();
