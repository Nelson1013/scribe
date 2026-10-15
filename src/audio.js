// Helpers for reading audio files and cutting long audio into pieces for Whisper.

export var SAMPLE_RATE = 16000;   // Whisper works on 16 kHz mono audio
var FRAME = 1600;                 // 100 ms

function rms(a, from, to) {
  var s = 0;
  for (var i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

// Decode any audio or video file the phone can play into 16 kHz mono samples.
export async function decodeTo16k(blob) {
  var buf = await blob.arrayBuffer();
  var Ctx = window.AudioContext || window.webkitAudioContext;
  var ctx = new Ctx({ sampleRate: SAMPLE_RATE });
  var ab;
  try {
    ab = await ctx.decodeAudioData(buf);
  } catch (e) {
    throw new Error('This file could not be read as audio. Try an mp3, m4a, wav, ogg or mp4 file.');
  } finally {
    if (ctx.close) { try { ctx.close(); } catch (e2) { /* ignore */ } }
  }
  var ch = ab.numberOfChannels, len = ab.length, out = new Float32Array(len);
  for (var c = 0; c < ch; c++) {
    var d = ab.getChannelData(c);
    for (var i = 0; i < len; i++) out[i] += d[i] / ch;
  }
  return out;
}

// Split samples into windows of about `secs` seconds. Each cut is placed at the
// quietest moment near the end of a window so words are not cut in half.
export function splitWindows(audio, secs) {
  var W = Math.round(secs * SAMPLE_RATE), out = [], start = 0;
  while (start < audio.length) {
    if (audio.length - start <= W * 1.15) { out.push([start, audio.length]); break; }
    var from = start + Math.round(W * 0.7), to = start + W, best = to, bv = 1e9;
    for (var i = from; i + FRAME <= to; i += FRAME) {
      var v = rms(audio, i, i + FRAME);
      if (v < bv) { bv = v; best = i + FRAME / 2; }
    }
    out.push([start, best]);
    start = best;
  }
  return out;
}
