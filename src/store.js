// Keeps audio files in IndexedDB (localStorage is far too small for audio).

var DB = 'scribe-audio';

function open() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open(DB, 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('a'); };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
function run(mode, fn) {
  return open().then(function (db) {
    return new Promise(function (res, rej) {
      var tx = db.transaction('a', mode), out;
      out = fn(tx.objectStore('a'));
      tx.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); };
      tx.onerror = function () { rej(tx.error); };
      tx.onabort = function () { rej(tx.error); };
    });
  });
}

export function putAudio(id, rec) { return run('readwrite', function (s) { return s.put(rec, id); }); }
export function getAudio(id) { return run('readonly', function (s) { return s.get(id); }); }
export function delAudio(id) { return run('readwrite', function (s) { return s.delete(id); }); }
