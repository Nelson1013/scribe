// Turns recognised speech into clean written text.
// Everything here is plain string handling so it can be tested without a phone.

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

var COMMANDS = [
  [/\b(?:new|next) paragraph\b/gi, '\n\n'],
  [/\b(?:new|next) line\b/gi, '\n'],
  [/\s*\b(?:full stop|period)\b/gi, '.'],
  [/\s*\bcomma\b/gi, ','],
  [/\s*\bquestion mark\b/gi, '?'],
  [/\s*\bexclamation (?:mark|point)\b/gi, '!'],
  [/\s*\bsemicolon\b/gi, ';'],
  [/\s*\bcolon\b/gi, ':']
];

function applyCommands(s) {
  for (var i = 0; i < COMMANDS.length; i++) s = s.replace(COMMANDS[i][0], COMMANDS[i][1]);
  return s.replace(/[ \t]*\n[ \t]*/g, '\n');
}

function capitalise(s, atStart) {
  var out = s.replace(/([.!?]\s+|\n\s*)([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
  if (atStart) out = out.replace(/^(\s*)([a-z])/, function (m, a, b) { return a + b.toUpperCase(); });
  return out;
}

// raw: text just heard. base: transcript so far. o: settings plus optional stamp.
// Returns the new full transcript.
export function processSegment(raw, base, o) {
  o = o || {};
  var s = (raw || '').trim();
  if (!s) return base;

  if (o.commands && /^(delete that|scratch that|undo that)[.!]?$/i.test(s)) {
    return base.replace(/[^.!?\n]*[.!?]?\s*$/, '').trimEnd();
  }

  (o.dict || []).forEach(function (d) {
    if (d && d.from) s = s.replace(new RegExp('\\b' + escapeRe(d.from) + '\\b', 'gi'), function () { return d.to || ''; });
  });
  if (o.commands) s = applyCommands(s);
  s = s.replace(/\bi\b/g, 'I');
  if (o.periodPause && s.trim() && !/[.!?\n]\s*$/.test(s)) s = s.trimEnd() + '.';
  if (!s.trim() && s.indexOf('\n') === -1) return base;

  var prev = base || '';
  var endsNewline = /\n$/.test(prev);
  var atStart = !prev.trim() || endsNewline || /[.!?]\s*$/.test(prev);
  s = capitalise(s, atStart);

  var sep;
  if (!prev.trim() || endsNewline) sep = '';
  else if (/^[.,;:!?\n]/.test(s)) sep = '';
  else sep = ' ';

  if (o.stamp) {
    sep = (!prev.trim() || endsNewline) ? '' : '\n';
    s = '[' + o.stamp + '] ' + s.replace(/^\s+/, '');
  }
  return prev + sep + s;
}

export function countWords(t) { return ((t || '').trim().match(/\S+/g) || []).length; }

export function titleOf(t) {
  var line = (t || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean)[0] || 'Untitled';
  line = line.replace(/^\[\d+:\d+\]\s*/, '');
  return line.length > 48 ? line.slice(0, 48) + '…' : line;
}

export function fmtTime(secs) {
  secs = Math.max(0, Math.floor(secs));
  var m = Math.floor(secs / 60), s = secs % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}
