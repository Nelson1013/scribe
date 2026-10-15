// Records the microphone to a compact audio file and tracks the loudest level,
// so the app can warn when the phone gave it silence.

export function createRecorder() {
  var mr = null, stream = null, chunks = [], t0 = 0, mime = '';
  var ctx = null, peak = 0, peakTimer = null;

  function cleanup() {
    if (peakTimer) { clearInterval(peakTimer); peakTimer = null; }
    if (ctx) { try { ctx.close(); } catch (e) { /* ignore */ } ctx = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }

  return {
    get active() { return !!mr && mr.state !== 'inactive'; },

    async start() {
      if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('Recording is not supported on this phone.');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, noiseSuppression: true, echoCancellation: false, autoGainControl: true }
      });
      var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
      mime = types.filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0] || '';
      var o = { audioBitsPerSecond: 48000 };
      if (mime) o.mimeType = mime;
      mr = new MediaRecorder(stream, o);
      chunks = []; peak = 0;
      mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      mr.start(1000);
      t0 = Date.now();
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        var an = ctx.createAnalyser();
        an.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(an);
        var buf = new Float32Array(an.fftSize);
        peakTimer = setInterval(function () {
          an.getFloatTimeDomainData(buf);
          for (var i = 0; i < buf.length; i++) { var v = Math.abs(buf[i]); if (v > peak) peak = v; }
        }, 150);
      } catch (e) { peak = 1; /* cannot measure, assume fine */ }
    },

    stop() {
      return new Promise(function (res) {
        if (!mr || mr.state === 'inactive') { cleanup(); res({ blob: new Blob([]), secs: 0, peak: 0 }); return; }
        mr.onstop = function () {
          var secs = (Date.now() - t0) / 1000, p = peak;
          cleanup();
          res({ blob: new Blob(chunks, { type: mime || 'audio/webm' }), secs: secs, peak: p });
        };
        try { mr.stop(); } catch (e) { cleanup(); res({ blob: new Blob([]), secs: 0, peak: 0 }); }
      });
    }
  };
}
