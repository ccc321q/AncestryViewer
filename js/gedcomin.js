/* gedcomin.js - GEDCOM (.ged) -> model.
   Reads both 7.0 and 5.5.1, since files come from everywhere: 7.0 dropped
   CONC and CHAR and added SCHMA-declared extension tags, but the record shapes
   this app cares about are the same in both.

   The extension tags this project writes (_LIVING, _WWW, _CONFLICT and its
   substructures) are read back so a tree exported here round-trips intact.  */
var AV = window.AV || {};
(function (AV) {
  'use strict';
  var U = AV.util;

  /* ------------------------------------------------------------- detect */
  function looksLikeGedcom(text) {
    var first = (text || '').replace(/^﻿/, '')
      .split(/\r\n|\r|\n/).find(function (l) { return l.trim(); });
    return /^0\s+HEAD\b/.test(first || '');
  }

  /* --------------------------------------------------------------- parse */
  /* A line is "level [@xref@] TAG [value]". CONT adds a newline, CONC (5.5.1
     only) continues without one; both attach to the line before. */
  function tokenise(text) {
    var out = [];
    text.replace(/^﻿/, '').split(/\r\n|\r|\n/).forEach(function (raw) {
      if (!raw.trim()) return;
      var m = /^\s*(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s(.*))?$/.exec(raw);
      if (!m) return;
      var tag = m[3], value = m[4] === undefined ? '' : m[4];
      if ((tag === 'CONT' || tag === 'CONC') && out.length) {
        var prev = out[out.length - 1];
        prev.value += (tag === 'CONT' ? '\n' : '') + value;
        return;
      }
      out.push({ level: +m[1], xref: m[2] || '', tag: tag, value: value });
    });
    return out;
  }

  /* Group the flat lines into a tree so each record can be walked. */
  function nest(lines) {
    var roots = [], stack = [];
    lines.forEach(function (l) {
      var node = { tag: l.tag, xref: l.xref, value: l.value, kids: [] };
      while (stack.length > l.level) stack.pop();
      if (!stack.length) roots.push(node);
      else stack[stack.length - 1].kids.push(node);
      stack.push(node);
    });
    return roots;
  }

  function kid(node, tag) {
    return node.kids.filter(function (k) { return k.tag === tag; })[0] || null;
  }
  function kids(node, tag) {
    return node.kids.filter(function (k) { return k.tag === tag; });
  }
  function val(node, tag) {
    var k = kid(node, tag);
    return k ? k.value : '';
  }
  function ptr(v) {
    var m = /^@([^@]+)@$/.exec((v || '').trim());
    return m ? m[1] : '';
  }

  /* ------------------------------------------------------------- events */
  var LABEL = {
    BIRT: 'Birth', CHR: 'Christening', BAPM: 'Baptism', DEAT: 'Death',
    BURI: 'Burial', CREM: 'Cremation', MARR: 'Marriage', DIV: 'Divorce',
    OCCU: 'Occupation', RESI: 'Residence', RELI: 'Religion', NATI: 'Nationality',
    EDUC: 'Education', CENS: 'Census', PROB: 'Probate', WILL: 'Will',
    EMIG: 'Emigration', IMMI: 'Immigration', NATU: 'Naturalisation',
    ENGA: 'Engagement', ANUL: 'Annulment', GRAD: 'Graduation', RETI: 'Retirement'
  };
  var ORDER = { BIRT: 1, CHR: 2, BAPM: 2, DEAT: 3, BURI: 4, CREM: 4, MARR: 1, DIV: 2 };
  var NOT_EVENT = {
    NAME: 1, SEX: 1, FAMC: 1, FAMS: 1, NOTE: 1, SNOTE: 1, SOUR: 1, OBJE: 1,
    CHAN: 1, CREA: 1, RIN: 1, REFN: 1, UID: 1, EXID: 1, HUSB: 1, WIFE: 1,
    CHIL: 1, NO: 1, _LIVING: 1, SUBM: 1, ASSO: 1, ALIA: 1, ANCI: 1, DESI: 1
  };

  function eventFrom(node, srcOf) {
    var date = U.parseDateText(val(node, 'DATE'));
    var place = val(node, 'PLAC');
    var notes = kids(node, 'NOTE').map(function (n) { return n.value; }).filter(Boolean);
    var detail = (node.value && node.value !== 'Y') ? node.value : '';
    if (node.tag === 'EVEN' && !detail) detail = '';
    var sources = kids(node, 'SOUR').map(function (s) {
      return srcOf(ptr(s.value));
    }).filter(Boolean);
    if (!date.display && !place && !detail && !notes.length) return null;
    return {
      tag: node.tag, label: LABEL[node.tag] || val(node, 'TYPE') || node.tag,
      order: ORDER[node.tag] || 6,
      date: date, place: place, detail: detail,
      note: notes.join('\n'), sources: sources
    };
  }

  /* --------------------------------------------------------------- parse */
  function parse(buf, filename) {
    var bytes = new Uint8Array(buf);
    var text = U.decodeText(bytes, 0, bytes.length);
    if (!looksLikeGedcom(text)) throw new Error('not a GEDCOM file (no 0 HEAD line)');
    var recs = nest(tokenise(text));

    var head = recs.filter(function (r) { return r.tag === 'HEAD'; })[0] || { kids: [] };
    var gedc = kid(head, 'GEDC');
    var version = gedc ? val(gedc, 'VERS') : '';

    var model = new AV.Model({
      format: 'ged',
      formatLabel: 'GEDCOM ' + (version || '5.5.1'),
      filename: filename,
      size: buf.byteLength,
      version: 'GEDCOM ' + (version || 'unknown')
    });

    /* ---- sources and repositories, first so citations can resolve ---- */
    var repoName = {};
    recs.forEach(function (r) {
      if (r.tag !== 'REPO' || !r.xref) return;
      repoName[ptr(r.xref)] = { name: val(r, 'NAME'), www: val(r, 'WWW') };
    });

    var srcId = {};
    recs.forEach(function (r) {
      if (r.tag !== 'SOUR' || !r.xref) return;
      var key = ptr(r.xref);
      srcId[key] = key;
      var rec = model.sourceRec(key);
      rec.title = val(r, 'TITL');
      var publ = val(r, 'PUBL');
      rec.url = val(r, '_WWW') || (/(https?:\/\/\S+)/.exec(publ) || [])[1] || '';
      var got = /retrieved\s+([0-9-]+)/i.exec(publ);
      rec.retrieved = got ? got[1] : '';
      var rp = repoName[ptr(val(r, 'REPO'))];
      rec.repository = rp ? rp.name : '';
      rec.reliability = kids(r, 'NOTE').map(function (n) { return n.value; }).join(' ');
    });
    function srcOf(key) { return srcId[key] ? key : ''; }

    /* ---- people ---- */
    var pid = {}, nextId = 0;
    recs.forEach(function (r) {
      if (r.tag !== 'INDI' || !r.xref) return;
      var key = ptr(r.xref);
      var rin = parseInt(val(r, 'RIN'), 10);
      var num = (rin && !pid[key]) ? rin : ++nextId;
      pid[key] = num;
      if (num > nextId) nextId = num;
    });

    recs.forEach(function (r) {
      if (r.tag !== 'INDI' || !r.xref) return;
      var p = model.person(pid[ptr(r.xref)]);
      var names = kids(r, 'NAME');
      names.forEach(function (nm, i) {
        var parts = AV.splitName(nm.value);
        var given = val(nm, 'GIVN') || parts.given;
        var surname = val(nm, 'SURN') || parts.surname;
        var full = (given + ' ' + surname).trim() ||
                   nm.value.replace(/\//g, '').trim();
        if (i === 0) {
          p.given = given; p.surname = surname;
          p.prefix = val(nm, 'NPFX'); p.suffix = val(nm, 'NSFX') || parts.suffix;
          p.nickname = val(nm, 'NICK');
          p.fullName = full;
        } else if (full && p.altNames.indexOf(full) < 0) {
          p.altNames.push(full);
        }
      });
      p.sex = val(r, 'SEX');
      p.living = !!kid(r, '_LIVING');
      var exid = kid(r, 'EXID');
      p.sourceKey = (exid ? exid.value : val(r, 'REFN')) || '';
      /* The TYPE on an EXID names the numbering the id belongs to. A merge can
         only match on ids when it knows they come from the same numbering. */
      if (exid && !model.source.idNamespace) {
        var type = val(exid, 'TYPE') || '';
        var ns = /\/id\/(?!file\/)([^/]+)$/.exec(type);   // "id/file/…" is file-local
        if (ns) {
          try { model.source.idNamespace = decodeURIComponent(ns[1]); }
          catch (e) { model.source.idNamespace = ns[1]; }
        }
      }

      r.kids.forEach(function (k) {
        if (NOT_EVENT[k.tag]) return;
        var e = eventFrom(k, srcOf);
        if (e) p.events.push(e);
      });
      kids(r, 'NOTE').forEach(function (n) { if (n.value) p.notes.push(n.value); });
      kids(r, 'SOUR').forEach(function (s) {
        var id = srcOf(ptr(s.value));
        if (id && p.sources.indexOf(id) < 0) p.sources.push(id);
      });
    });

    /* ---- families ---- */
    var fid = {}, nextF = 0;
    recs.forEach(function (r) {
      if (r.tag !== 'FAM' || !r.xref) return;
      fid[ptr(r.xref)] = ++nextF;
    });
    recs.forEach(function (r) {
      if (r.tag !== 'FAM' || !r.xref) return;
      var f = model.family(fid[ptr(r.xref)]);
      f.husband = pid[ptr(val(r, 'HUSB'))] || 0;
      f.wife = pid[ptr(val(r, 'WIFE'))] || 0;
      kids(r, 'CHIL').forEach(function (c) {
        var id = pid[ptr(c.value)];
        if (id && f.children.indexOf(id) < 0) f.children.push(id);
      });
      r.kids.forEach(function (k) {
        if (NOT_EVENT[k.tag]) return;
        var e = eventFrom(k, srcOf);
        if (e) f.events.push(e);
      });
      /* NO MARR says this couple were partners, not spouses. Put that back as
         a marriage event carrying the union as its detail, which is how every
         other reader in this app represents it. */
      kids(r, 'NO').forEach(function (n) {
        if (n.value !== 'MARR') return;
        f.events.push({
          tag: 'MARR', label: 'Marriage', order: 1,
          date: U.parseDateText(val(n, 'DATE')), place: '',
          detail: val(n, 'NOTE') || 'union (unmarried)',
          note: '', sources: kids(n, 'SOUR').map(function (s) {
            return srcOf(ptr(s.value));
          }).filter(Boolean)
        });
      });
      kids(r, 'NOTE').forEach(function (n) { if (n.value) f.notes.push(n.value); });
      kids(r, 'SOUR').forEach(function (s) {
        var id = srcOf(ptr(s.value));
        if (id && f.sources.indexOf(id) < 0) f.sources.push(id);
      });
    });

    /* ---- merge conflicts, if this file carries them ---- */
    model.conflicts = [];
    recs.forEach(function (r) {
      if (r.tag !== '_CONFLICT') return;
      var target = ptr(val(r, '_RECORD'));
      var isFam = /^F/.test(target) || fid[target] !== undefined;
      var options = kids(r, '_VALUE').map(function (v) {
        return {
          event: null, display: v.value,
          place: val(v, '_PLACE'),
          origins: kids(v, '_FROM').map(function (f) { return f.value; })
        };
      });
      model.conflicts.push({
        id: 'C' + (model.conflicts.length + 1),
        ownerType: isFam ? 'family' : 'person',
        ownerId: isFam ? fid[target] : pid[target],
        about: '', who: '', tag: val(r, '_FACT'),
        label: LABEL[val(r, '_FACT')] || val(r, '_FACT'),
        options: options,
        issue: '',
        resolvedBy: val(r, '_RESOLVEDBY') || 'both',
        resolution: val(r, 'NOTE') || null
      });
    });

    /* places are free text on events, so collect the distinct ones */
    var placeN = 0, seen = {};
    function collect(e) {
      if (!e.place || seen[e.place]) return;
      seen[e.place] = true;
      model.places.set(++placeN, { id: placeN, name: e.place });
    }
    model.people.forEach(function (p) { p.events.forEach(collect); });
    model.families.forEach(function (f) { f.events.forEach(collect); });

    kids(head, 'NOTE').forEach(function (n) {
      if (n.value) model.source.notes = (model.source.notes || []).concat(n.value);
    });
    model.source.notes = (model.source.notes || []).concat(
      model.people.size + ' people, ' + model.families.size + ' families and ' +
      model.sources.size + ' sources were read.');

    model.raw = { kind: 'gedcom', text: text, records: recs.length };
    return model.finalise();
  }

  AV.gedcomin = { parse: parse, looksLikeGedcom: looksLikeGedcom };
  window.AV = AV;
})(AV);
