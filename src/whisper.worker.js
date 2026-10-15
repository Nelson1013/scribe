// Runs the offline Whisper model away from the screen so the app stays smooth.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

var asr = null, curModel = null, probed = false, ortLocal = false;

async function probe() {
  if (probed) return;
  probed = true;
  try {
    var base = self.location.origin + '/ort/';
    var r = await fetch(base + 'ort-wasm-simd-threaded.mjs');
    if (r.ok) { env.backends.onnx.wasm.wasmPaths = base; ortLocal = true; }
  } catch (e) { /* fall back to the default download location */ }
  try { env.backends.onnx.wasm.numThreads = 1; } catch (e) { /* ignore */ }
}

self.onmessage = async function (e) {
  var m = e.data;
  try {
    if (m.type === 'info') {
      await probe();
      self.postMessage({ id: m.id, type: 'done', ortLocal: ortLocal, isolated: !!self.crossOriginIsolated, model: curModel });
    } else if (m.type === 'load') {
      await probe();
      if (!asr || curModel !== m.model) {
        asr = null;
        asr = await pipeline('automatic-speech-recognition', m.model, {
          dtype: 'q8',
          device: 'wasm',
          progress_callback: function (p) { self.postMessage({ id: m.id, type: 'progress', p: p }); }
        });
        curModel = m.model;
      }
      self.postMessage({ id: m.id, type: 'done' });
    } else if (m.type === 'run') {
      var o = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true };
      if (m.language) { o.language = m.language; o.task = 'transcribe'; }
      var out = await asr(m.audio, o);
      var chunks = out.chunks && out.chunks.length ? out.chunks : [{ text: out.text || '', timestamp: [0, null] }];
      self.postMessage({ id: m.id, type: 'done', chunks: chunks });
    }
  } catch (err) {
    self.postMessage({ id: m.id, type: 'error', message: String((err && err.message) || err) });
  }
};
