/* pal.js - PAF activity log (.pal).
   Plain CRLF text, one edit per line:
     "3-29-2014 16:03 Mod Ind 217"
     "4-29-2014 16:06 Lnk Ch  23"                                  */
var AV = window.AV || {};
(function (AV) {
  'use strict';
  var U = AV.util;

  var LINE = /^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})\s+(\S+)\s+(\S+)\s+(\d+)\s*$/;

  var ACTIONS = { Mod: 'Modified', Add: 'Added', Del: 'Deleted', Lnk: 'Linked',
                  Unl: 'Unlinked', Mrg: 'Merged', New: 'Created' };
  var OBJECTS = { Ind: 'Individual', Ch: 'Child', Mar: 'Marriage', Sp: 'Spouse',
                  Par: 'Parent', Note: 'Note', Src: 'Source' };

  function looksLikePal(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!lines.length) return false;
    var good = lines.filter(function (l) { return LINE.test(l); }).length;
    return good / lines.length >= 0.6;
  }

  function parse(buf, filename) {
    var bytes = new Uint8Array(buf);
    var text = U.decodeText(bytes, 0, bytes.length);
    var model = new AV.Model({
      format: 'pal',
      formatLabel: 'PAF activity log',
      filename: filename,
      size: buf.byteLength,
      version: 'plain text'
    });
    var raw = [];
    text.split(/\r?\n/).forEach(function (line, i) {
      if (!line.trim()) return;
      raw.push(line);
      var m = LINE.exec(line);
      if (!m) {
        model.log.push({ line: i + 1, raw: line, date: null, action: '', object: '', ref: null });
        return;
      }
      var month = +m[1], day = +m[2], year = +m[3];
      model.log.push({
        line: i + 1,
        raw: line,
        date: U.makeDate({ year: year, month: month, day: day }),
        time: m[4].padStart(2, '0') + ':' + m[5],
        sort: year * 100000000 + month * 1000000 + day * 10000 + (+m[4]) * 100 + (+m[5]),
        actionCode: m[6],
        action: ACTIONS[m[6]] || m[6],
        objectCode: m[7],
        object: OBJECTS[m[7]] || m[7],
        ref: +m[8]
      });
    });
    model.raw = { kind: 'pal', lines: raw };
    model.source.notes = [
      model.log.length + ' log entries. A .pal file records edits made to the ' +
      'matching .paf database; it holds no genealogy of its own.'
    ];
    return model.finalise();
  }

  AV.pal = { parse: parse, looksLikePal: looksLikePal };
  window.AV = AV;
})(AV);
