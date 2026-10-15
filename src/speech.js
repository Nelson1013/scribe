// Wraps the native Android speech recogniser and keeps it listening.
// Android stops the recogniser after a pause, so this restarts it in a loop
// until the user taps stop. Every piece of recognised text is handed to
// h.onFinal when a segment ends, and h.onPartial streams the live words.

import { SpeechRecognition } from '@capgo/capacitor-speech-recognition';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

export function createEngine(h) {
  var wanted = false, running = false, starting = false, wired = false;
  var live = '', errStreak = 0, forceDevice = false, warned = false;
  var cfg = { lang: 'en-US', mode: 'auto' };
  var restartTimer = null, pollTimer = null;

  function log(m) { if (h.onLog) h.onLog(m); }
  function msg(m, kind) { if (h.onMessage) h.onMessage(m, kind); }

  function flush() {
    var t = live.trim();
    live = '';
    if (h.onPartial) h.onPartial('');
    if (t) h.onFinal(t);
  }

  function scheduleRestart(ms) {
    if (!wanted) return;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(function () { restartTimer = null; begin(); }, ms);
  }

  function fatal(text) {
    wanted = false;
    running = false;
    stopPoll();
    msg(text, 'error');
    h.onState('idle');
  }

  function onError(e) {
    var code = String((e && e.code) || '').toLowerCase();
    var text = String((e && e.message) || '').toLowerCase();
    var all = code + ' ' + text;
    running = false;
    flush();
    if (/permission|denied|not.?allowed/.test(all) || code === '9') {
      return fatal('Microphone permission is needed. Allow it in your phone Settings, Apps, Scribe, Permissions.');
    }
    if (/language/.test(all) || code === '12' || code === '13') {
      return fatal('This language is not available on your phone. Download its offline language pack or choose another language in Settings.');
    }
    if (/network|timeout.*network|server/.test(all) || code === '1' || code === '2' || code === '4' || code === '11') {
      if (!forceDevice && cfg.mode !== 'online') {
        forceDevice = true;
        msg('No usable connection. Switching to on-device recognition.', 'warn');
      } else if (!warned) {
        warned = true;
        msg('Online recognition is not responding. Check your connection, or switch to on-device mode in Settings.', 'warn');
      }
      errStreak++;
    } else if (/busy/.test(all) || code === '8') {
      errStreak++;
    } else {
      // "no match" and "speech timeout" are normal in continuous mode.
      errStreak++;
    }
    if (errStreak >= 10) return fatal('Listening stopped after repeated errors. Open Settings, then Diagnostics, for details.');
    scheduleRestart(errStreak > 3 ? 1200 : 400);
  }

  function onStopped() {
    running = false;
    flush();
    if (wanted) scheduleRestart(250);
    else h.onState('idle');
  }

  async function wire() {
    if (wired) return;
    wired = true;
    await SpeechRecognition.addListener('partialResults', function (e) {
      var t = (e && e.matches && e.matches[0]) || '';
      if (!t) return;
      live = t;
      errStreak = 0;
      h.onPartial(t);
    });
    await SpeechRecognition.addListener('segmentResults', function (e) {
      var t = e && e.matches && e.matches[0];
      if (t) { live = t; flush(); }
    });
    await SpeechRecognition.addListener('listeningState', function (e) {
      log('state ' + e.state + (e.reason ? ' (' + e.reason + ')' : ''));
      if (e.state === 'stopped') onStopped();
    });
    await SpeechRecognition.addListener('error', function (e) {
      log('error ' + e.code + ' ' + e.message);
      onError(e);
    });
  }

  async function onDeviceOk() {
    try {
      var r = await SpeechRecognition.isOnDeviceRecognitionAvailable({ language: cfg.lang });
      return !!(r && r.available);
    } catch (e) { return false; }
  }

  async function pickDevice() {
    if (cfg.mode === 'online' && !forceDevice) return false;
    var ok = await onDeviceOk();
    if (cfg.mode === 'device' && !ok && !warned) {
      warned = true;
      msg('On-device recognition is not available for this language, so the standard recogniser is being used.', 'warn');
    }
    if (cfg.mode === 'device' || forceDevice) return ok;
    return !navigator.onLine && ok;   // auto mode
  }

  async function begin() {
    if (!wanted || running || starting) return;
    starting = true;
    try {
      var dev = await pickDevice();
      await SpeechRecognition.start({
        language: cfg.lang,
        maxResults: 1,
        partialResults: true,
        popup: false,
        useOnDeviceRecognition: dev,
        muteRecognizerBeep: true
      });
      running = true;
      h.onState('listening');
      if (h.onEngine) h.onEngine(dev ? 'On-device' : (navigator.onLine ? 'Online' : 'Offline pack'));
    } catch (err) {
      var m = String((err && err.message) || err);
      log('start failed: ' + m);
      onError({ code: 'start', message: m });
    } finally {
      starting = false;
    }
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(async function () {
      if (!wanted || starting || restartTimer) return;
      if (!running) { begin(); return; }
      try {
        var r = await SpeechRecognition.isListening();
        if (!r.listening) { log('poll: recogniser idle, restarting'); onStopped(); }
      } catch (e) { /* ignore */ }
    }, 2000);
  }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function ensurePermission() {
    var p = await SpeechRecognition.checkPermissions();
    if (p.speechRecognition === 'granted') return true;
    var r = await SpeechRecognition.requestPermissions();
    return r.speechRecognition === 'granted';
  }

  return {
    async start(options) {
      cfg = { lang: options.lang, mode: options.mode };
      errStreak = 0; warned = false; forceDevice = false; live = '';
      try {
        var av = await SpeechRecognition.available();
        if (!av.available) { msg('Speech recognition is not available on this phone. Install or enable Speech Services by Google.', 'error'); return false; }
        if (!(await ensurePermission())) { msg('Microphone permission is needed. Allow it in your phone Settings, Apps, Scribe, Permissions.', 'error'); return false; }
        await wire();
      } catch (e) {
        msg('Speech recognition could not start: ' + String((e && e.message) || e), 'error');
        return false;
      }
      wanted = true;
      h.onState('starting');
      startPoll();
      begin();
      return true;
    },
    async stop() {
      wanted = false;
      stopPoll();
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      try { await SpeechRecognition.stop(); } catch (e) { /* ignore */ }
      await sleep(350);   // let the last result arrive
      flush();
      running = false;
      h.onState('idle');
    },
    async diagnostics(lang) {
      var out = {};
      try { out.available = (await SpeechRecognition.available()).available; } catch (e) { out.available = 'error: ' + e.message; }
      try { out.permission = (await SpeechRecognition.checkPermissions()).speechRecognition; } catch (e) { out.permission = 'error: ' + e.message; }
      try { out.onDevice = (await SpeechRecognition.isOnDeviceRecognitionAvailable({ language: lang })).available; } catch (e) { out.onDevice = 'error: ' + e.message; }
      try { out.plugin = (await SpeechRecognition.getPluginVersion()).version; } catch (e) { out.plugin = 'unknown'; }
      return out;
    }
  };
}
