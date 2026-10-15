// Bridge to the Android background service and native recorder.
// On the web (no phone) everything here switches itself off.
import { registerPlugin, Capacitor } from '@capacitor/core';

var P = registerPlugin('ScribeBg');
var native = !!(Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());

function quiet(p) { return p && p.catch ? p.catch(function () { /* ignore */ }) : p; }

export var bg = {
  native: native,
  ensurePermissions: function () { return native ? P.ensurePermissions() : Promise.resolve({ mic: true }); },
  startRecording: function () { return P.startRecording(); },
  stopRecording: function () { return P.stopRecording(); },
  level: function () { return P.level(); },
  keepAlive: function (text, mic) { if (native) quiet(P.keepAlive({ text: text, mic: !!mic })); },
  update: function (text) { if (native) quiet(P.update({ text: text })); },
  release: function () { if (native) quiet(P.release()); },
  deleteFile: function (path) { if (native) quiet(P.deleteFile({ path: path })); },
  batterySettings: function () { if (native) quiet(P.batterySettings()); },
  readFile: async function (path) {
    var r = await fetch(Capacitor.convertFileSrc('file://' + path));
    if (!r.ok) throw new Error('Could not read the recording (' + r.status + ').');
    return r.blob();
  }
};
