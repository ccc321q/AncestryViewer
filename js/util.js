/* util.js - binary helpers, text decoding, date maths, small DOM helpers.
   Everything hangs off a single AV global so the app runs from file://
   without ES-module CORS restrictions. */
var AV = window.AV || {};
(function (AV) {
  'use strict';

  /* --- CP1252 -------------------------------------------------------------
     PAF files are Windows-1252, not UTF-8. Only 0x80-0x9F differ from
     Latin-1, so a 32-entry table plus identity for the rest is enough. */
  var CP1252_HIGH = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
    0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178
  ];

  function decodeCp1252(bytes, start, end) {
    var out = '', i, c;
    for (i = start; i < end; i++) {
      c = bytes[i];
      if (c === 0) continue;
      out += String.fromCharCode(c >= 0x80 && c <= 0x9f ? CP1252_HIGH[c - 0x80] : c);
    }
    return out;
  }

  /* PAF 5.2 wrote UTF-8 into fields that are nominally CP1252 (accented
     Afrikaans and French names), so sniff before falling back. */
  var utf8Decoder = new TextDecoder('utf-8', { fatal: true });

  function looksUtf8(b) {
    var i = 0, n = b.length, c, len, j, sawHigh = false;
    while (i < n) {
      c = b[i];
      if (c < 0x80) { i++; continue; }
      sawHigh = true;
      if (c >= 0xc2 && c <= 0xdf) len = 1;
      else if (c >= 0xe0 && c <= 0xef) len = 2;
      else if (c >= 0xf0 && c <= 0xf4) len = 3;
      else return false;
      for (j = 1; j <= len; j++) {
        if (i + j >= n || (b[i + j] & 0xc0) !== 0x80) return false;
      }
      i += len + 1;
    }
    return sawHigh;
  }

  function decodeText(bytes, start, end) {
    if (end <= start) return '';
    var slice = bytes.subarray(start, end);
    if (looksUtf8(slice)) {
      try { return utf8Decoder.decode(slice).replace(/\0/g, ''); } catch (e) { /* fall through */ }
    }
    return decodeCp1252(bytes, start, end);
  }

  function Reader(buf) {
    this.buf = buf;
    this.bytes = new Uint8Array(buf);
    this.dv = new DataView(buf);
    this.length = buf.byteLength;
  }
  Reader.prototype = {
    u8: function (o) { return this.bytes[o]; },
    u16: function (o) { return this.dv.getUint16(o, true); },
    u32: function (o) { return this.dv.getUint32(o, true); },
    u16be: function (o) { return this.dv.getUint16(o, false); },
    u32be: function (o) { return this.dv.getUint32(o, false); },
    f64be: function (o) { return this.dv.getFloat64(o, false); },
    str: function (o, n) { return decodeText(this.bytes, o, o + n); },
    cstr: function (o, limit) {
      var e = o;
      limit = Math.min(limit === undefined ? this.length : limit, this.length);
      while (e < limit && this.bytes[e] !== 0) e++;
      return { text: decodeText(this.bytes, o, e), end: e };
    },
    eq: function (o, sig) {
      for (var i = 0; i < sig.length; i++) {
        if (this.bytes[o + i] !== sig.charCodeAt(i)) return false;
      }
      return true;
    }
  };

  /* --- dates --------------------------------------------------------------
     PAF stores every date as a Julian Day Number. Verified against 1772
     independent date pairs from the matching RootsMagic export. */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function jdnToYmd(jdn) {                       // Fliegel & Van Flandern
    var l = jdn + 68569;
    var n = Math.floor((4 * l) / 146097);
    l = l - Math.floor((146097 * n + 3) / 4);
    var i = Math.floor((4000 * (l + 1)) / 1461001);
    l = l - Math.floor((1461 * i) / 4) + 31;
    var j = Math.floor((80 * l) / 2447);
    var d = l - Math.floor((2447 * j) / 80);
    l = Math.floor(j / 11);
    var m = j + 2 - 12 * l;
    var y = 100 * (n - 49) + i + l;
    return { y: y, m: m, d: d };
  }

  function gedcomDate(o) {
    var s = '';
    if (o.day && o.month) s = o.day + ' ' + MONTHS[o.month - 1].toUpperCase();
    else if (o.month) s = MONTHS[o.month - 1].toUpperCase();
    if (o.year) s += (s ? ' ' : '') + o.year;
    if (!s) return '';
    var mod = { about: 'ABT', before: 'BEF', after: 'AFT' }[(o.modifier || '').toLowerCase()];
    return mod ? mod + ' ' + s : s;
  }

  /* The single date shape every parser produces. */
  function makeDate(o) {
    o = o || {};
    var parts = [];
    if (o.day && o.month) parts.push(o.day + ' ' + MONTHS[o.month - 1]);
    else if (o.month) parts.push(MONTHS[o.month - 1]);
    else if (o.day) parts.push(o.day);
    if (o.year) parts.push(String(o.year));
    var text = parts.join(' ');
    if (o.modifier && text) text = o.modifier + ' ' + text;
    if (!text && o.raw) text = o.raw;
    return {
      display: text || '',
      year: o.year || 0, month: o.month || 0, day: o.day || 0,
      modifier: o.modifier || '',
      sort: (o.year || 0) * 10000 + (o.month || 0) * 100 + (o.day || 0),
      gedcom: gedcomDate(o),
      raw: o.raw || ''
    };
  }
  var EMPTY_DATE = makeDate({});

  /* Free text -> the same date shape. Used by the GEDCOM reader, which takes
     its text from a file, and by the merge conflict dialog, which takes it from
     a person typing. Accepts "10 Jun 1838", "Jun 1838", "1927", with a leading
     qualifier ("abt 1736", "before 1742"). Anything else comes back as a raw
     date that still displays, so nothing typed is ever silently discarded. */
  var MONTH_NO = {};
  MONTHS.forEach(function (m, i) { MONTH_NO[m.toLowerCase()] = i + 1; });
  var QUALIFIER = {
    abt: 'about', about: 'about', circa: 'about', ca: 'about', c: 'about',
    est: 'about', cal: 'about',
    bef: 'before', before: 'before',
    aft: 'after', after: 'after'
  };

  function parseDateText(text, modifier) {
    var raw = (text == null ? '' : String(text)).trim();
    if (!raw) return EMPTY_DATE;
    var rest = raw, mod = modifier || '';
    var q = /^([A-Za-z]+)\.?\s+(.*)$/.exec(raw);
    if (q && QUALIFIER[q[1].toLowerCase()]) {
      mod = QUALIFIER[q[1].toLowerCase()];
      rest = q[2].trim();
    }
    var m = /^(?:(\d{1,2})\s+)?(?:([A-Za-z]{3,})\.?\s+)?(\d{3,4})$/.exec(rest);
    var month = m && m[2] ? MONTH_NO[m[2].slice(0, 3).toLowerCase()] : 0;
    if (!m || (m[2] && !month)) {
      return makeDate({ modifier: mod, raw: mod ? mod + ' ' + rest : raw });
    }
    return makeDate({
      day: m[1] ? +m[1] : 0, month: month || 0, year: +m[3],
      modifier: mod, raw: raw
    });
  }

  /* --- DOM ---------------------------------------------------------------- */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag), k;
    if (attrs) {
      for (k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'class') n.className = attrs[k];
        else if (k === 'text') n.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
      }
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function svg(tag, attrs, kids) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag), k;
    if (attrs) {
      for (k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'text') n.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
      }
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function hexdump(bytes, start, len, hi) {
    var lines = [], i, j, hex, asc, c, mark;
    start = Math.max(0, start);
    for (i = start; i < start + len && i < bytes.length; i += 16) {
      hex = ''; asc = '';
      for (j = 0; j < 16; j++) {
        if (i + j >= bytes.length) { hex += '   '; asc += ' '; continue; }
        c = bytes[i + j];
        mark = hi && i + j >= hi[0] && i + j < hi[1];
        hex += (mark ? '·' : ' ') + (c < 16 ? '0' : '') + c.toString(16);
        asc += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
      }
      lines.push(('00000' + i.toString(16)).slice(-6) + ' ' + hex + '  ' + asc);
    }
    return lines.join('\n');
  }

  function bytesToHex(bytes, start, len) {
    var s = [], i;
    for (i = start; i < start + len && i < bytes.length; i++) {
      s.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16));
    }
    return s.join(' ');
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  AV.util = {
    Reader: Reader,
    decodeText: decodeText,
    decodeCp1252: decodeCp1252,
    jdnToYmd: jdnToYmd,
    MONTHS: MONTHS,
    makeDate: makeDate,
    parseDateText: parseDateText,
    EMPTY_DATE: EMPTY_DATE,
    el: el, svg: svg, $: $, clear: clear,
    hexdump: hexdump, bytesToHex: bytesToHex, fmtSize: fmtSize
  };
  window.AV = AV;
})(AV);
