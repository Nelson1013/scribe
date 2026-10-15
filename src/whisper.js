// Talks to the Whisper worker (whisper.worker.js). One job runs at a time.

export function createWhisper() {
  var worker = null, nextId = 1, jobs = {};

  function failAll(err) {
    var j = jobs;
    jobs = {};
    Object.keys(j).forEach(function (k) { j[k].rej(err); });
  }

  function spawn() {
    worker = new Worker(new URL('./whisper.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = function (e) {
      var m = e.data, job = jobs[m.id];
      if (!job) return;
      if (m.type === 'progress') { if (job.onp) job.onp(m.p); return; }
      delete jobs[m.id];
      if (m.type === 'error') job.rej(new Error(m.message));
      else job.res(m);
    };
    worker.onerror = function (e) {
      worker = null;
      failAll(new Error((e && e.message) || 'The speech engine stopped unexpectedly.'));
    };
  }

  function send(msg, onp, transfer) {
    return new Promise(function (res, rej) {
      if (!worker) spawn();
      msg.id = nextId++;
      jobs[msg.id] = { res: res, rej: rej, onp: onp };
      worker.postMessage(msg, transfer || []);
    });
  }

  return {
    load: function (model, onp) { return send({ type: 'load', model: model }, onp); },
    run: function (audio, language) { return send({ type: 'run', audio: audio, language: language }, null, [audio.buffer]); },
    info: function () { return send({ type: 'info' }); },
    stop: function () {
      if (worker) { worker.terminate(); worker = null; }
      failAll(new Error('Cancelled'));
    }
  };
}
