/* gedcom.js - export the neutral model as GEDCOM, 7.0 by default.
   Written once, so it works for every format the app reads.

   7.0 differs from 5.5.1 in ways that matter here: CONC is gone (there is no
   line-length limit), CHAR is gone (UTF-8 is the only encoding), extension
   tags must be declared in HEAD.SCHMA against a URI, and NO <EVENT> can assert
   that something did not happen. 5.5.1 output is kept for older software.   */
var AV = window.AV || {};
(function (AV) {
  'use strict';

  var MAXLEN = 200;   // 5.5.1 only: value length before CONC folding

  /* Extension tags. The meaning of a documented extension travels with its
     URI, not its tag, so every one of these is declared in HEAD.SCHMA. */
  var EXT_BASE = 'https://github.com/AncestryViewer/terms/';
  var EXT = {
    _LIVING: EXT_BASE + 'living',
    _WWW: 'https://gedcom.io/terms/v7/WWW',   // same meaning, a place SOUR allows
    _CONFLICT: EXT_BASE + 'conflict',
    _RECORD: EXT_BASE + 'conflict-record',
    _FACT: EXT_BASE + 'conflict-fact',
    _VALUE: EXT_BASE + 'conflict-value',
    _PLACE: EXT_BASE + 'conflict-place',
    _FROM: EXT_BASE + 'conflict-from',
    _RESOLVEDBY: EXT_BASE + 'conflict-resolved-by'
  };

  function Writer(v7) {
    this.lines = [];
    this.v7 = !!v7;
    this.used = {};        // extension tags actually written
  }
  Writer.prototype.line = function (level, tag, value) {
    if (tag.charAt(0) === '_') this.used[tag] = true;
    /* a record line is "0 @X@ TAG", so the tag arrives as the value */
    if (tag.charAt(0) === '@' && String(value).charAt(0) === '_') {
      this.used[String(value).split(' ')[0]] = true;
    }
    if (value === null || value === undefined || value === '') {
      this.lines.push(level + ' ' + tag);
      return;
    }
    var parts = String(value).split(/\r\n|\r|\n/);
    var self = this;
    parts.forEach(function (part, i) {
      var t = i === 0 ? tag : 'CONT';
      var lvl = i === 0 ? level : level + 1;
      if (part === '') { self.lines.push(lvl + ' ' + t); return; }
      if (self.v7) {                       // 7.0 has no length limit and no CONC
        self.lines.push(lvl + ' ' + t + ' ' + part);
        return;
      }
      var first = true;
      while (part.length) {
        var chunk = part.slice(0, MAXLEN);
        part = part.slice(MAXLEN);
        if (first) { self.lines.push(lvl + ' ' + t + ' ' + chunk); first = false; }
        else { self.lines.push((lvl + 1) + ' CONC ' + chunk); }
      }
    });
  };
  Writer.prototype.text = function () { return this.lines.join('\n') + '\n'; };

  function gedName(p) {
    if (p.gedcomName) return p.gedcomName;
    return (p.given || '') + ' /' + (p.surname || '') + '/' + (p.suffix ? ' ' + p.suffix : '');
  }

  /* xrefs must be letters and digits only, must start with a letter, and must
     be unique. An id that already looks like one ("S001") is used as it is. */
  function xrefer(prefix) {
    var taken = {};
    return function (id) {
      var base = String(id).replace(/[^A-Za-z0-9]/g, '');
      if (!/^[A-Za-z]/.test(base)) base = prefix + base;
      var key = base, n = 2;
      while (taken[key]) key = base + 'x' + (n++);
      taken[key] = true;
      return key;
    };
  }

  function build(model, opts) {
    opts = opts || {};
    var v7 = opts.version !== '5.5.1';
    var w = new Writer(v7), now = new Date();
    var MON = AV.util.MONTHS.map(function (m) { return m.toUpperCase(); });

    /* ---- sources and repositories -------------------------------------- */
    /* 7.0 allows WWW on a REPO record but not on a SOUR record, so the site a
       source came from becomes a repository and the page URL rides on the
       source itself. */
    var sxref = {}, mkS = xrefer('S');
    model.sources.forEach(function (s, id) { sxref[id] = mkS(id); });

    var repoOf = {}, repos = [], mkR = xrefer('R');
    model.sources.forEach(function (s) {
      var name = (s.repository || '').trim();
      if (!name || repoOf[name]) return;
      var rec = { xref: mkR(repos.length + 1), name: name, www: '' };
      repoOf[name] = rec;
      repos.push(rec);
    });
    /* give each repository the site root of the first URL filed under it */
    model.sources.forEach(function (s) {
      var r = repoOf[(s.repository || '').trim()];
      if (!r || r.www || !s.url) return;
      var m = /^(https?:\/\/[^/]+)/i.exec(s.url);
      if (m) r.www = m[1] + '/';
    });

    function citeList(ww, level, ids) {
      (ids || []).forEach(function (id) {
        if (sxref[id]) ww.line(level, 'SOUR', '@' + sxref[id] + '@');
      });
    }

    /* ---- body, written first so SCHMA knows which extensions are used --- */
    var body = new Writer(v7);

    var ids = Array.from(model.people.keys()).sort(function (a, b) { return a - b; });
    ids.forEach(function (id) {
      var p = model.people.get(id);
      body.line(0, '@I' + id + '@', 'INDI');
      body.line(1, 'NAME', gedName(p));
      if (p.prefix) body.line(2, 'NPFX', p.prefix);
      if (p.given) body.line(2, 'GIVN', p.given);
      if (p.surname) body.line(2, 'SURN', p.surname);
      if (p.suffix) body.line(2, 'NSFX', p.suffix);
      if (p.nickname) body.line(2, 'NICK', p.nickname);
      p.altNames.forEach(function (n) {
        body.line(1, 'NAME', /\//.test(n) ? n : n + ' //');
        body.line(2, 'TYPE', v7 ? 'AKA' : 'aka');     // 7.0 enum is upper case
      });
      if (p.sex) body.line(1, 'SEX', p.sex);
      p.events.forEach(function (e) { writeEvent(body, e, citeList, v7); });
      p.famc.forEach(function (f) {
        if (model.families.has(f)) body.line(1, 'FAMC', '@F' + f + '@');
      });
      p.fams.forEach(function (f) {
        if (model.families.has(f)) body.line(1, 'FAMS', '@F' + f + '@');
      });
      p.notes.forEach(function (n) { body.line(1, 'NOTE', n); });
      citeList(body, 1, p.sources);
      /* A record id from the numbering the data came from, tagged with the
         namespace that gives it meaning. */
      if (v7 && p.sourceKey) {
        body.line(1, 'EXID', String(p.sourceKey));
        /* The TYPE names the numbering the id belongs to. Without a declared
           namespace the ids are only meaningful inside this one file, and the
           URI says so, so a merge never treats them as shared. */
        body.line(2, 'TYPE', EXT_BASE + 'id/' + (model.source.idNamespace
          ? encodeURIComponent(model.source.idNamespace)
          : 'file/' + encodeURIComponent(model.source.filename || 'unnamed')));
      }
      if (v7 && p.living) body.line(1, '_LIVING', 'Y');
      body.line(1, 'RIN', String(id));
    });

    var fids = Array.from(model.families.keys()).sort(function (a, b) { return a - b; });
    fids.forEach(function (id) {
      var f = model.families.get(id);
      body.line(0, '@F' + id + '@', 'FAM');
      /* A source file can point at a person it does not actually contain — one
         PAF individual is unrecoverable from the name stream — and a pointer to
         a record that is not written is invalid GEDCOM, so it is dropped. */
      if (model.people.has(f.husband)) body.line(1, 'HUSB', '@I' + f.husband + '@');
      if (model.people.has(f.wife)) body.line(1, 'WIFE', '@I' + f.wife + '@');
      /* A couple recorded as partners rather than spouses. 7.0 can say this
         outright with NO MARR, which would contradict a MARR event, so the
         marriage event is replaced rather than accompanied: any date or place
         recorded for the union moves to a typed EVEN. */
      var union = v7 && f.events.filter(function (e) {
        return e.tag === 'MARR' && /union/i.test(e.detail || '');
      })[0];
      f.events.forEach(function (e) {
        if (e === union) return;
        writeEvent(body, e, citeList, v7);
      });
      if (union) {
        body.line(1, 'NO', 'MARR');
        body.line(2, 'NOTE', union.detail);
        if (union.date.gedcom || union.place) {
          body.line(1, 'EVEN');
          body.line(2, 'TYPE', 'Union');
          if (union.date.gedcom) body.line(2, 'DATE', union.date.gedcom);
          if (union.place) body.line(2, 'PLAC', union.place);
          citeList(body, 2, union.sources);
        } else {
          citeList(body, 2, union.sources);
        }
      }
      f.children.forEach(function (c) {
        if (model.people.has(c)) body.line(1, 'CHIL', '@I' + c + '@');
      });
      f.notes.forEach(function (n) { body.line(1, 'NOTE', n); });
      citeList(body, 1, f.sources);
    });

    repos.forEach(function (r) {
      body.line(0, '@' + r.xref + '@', 'REPO');
      body.line(1, 'NAME', r.name);
      if (r.www) body.line(1, 'WWW', r.www);
    });

    model.sources.forEach(function (s, id) {
      body.line(0, '@' + sxref[id] + '@', 'SOUR');
      if (s.title) body.line(1, 'TITL', s.title);
      /* PUBL carries the URL in prose as well as _WWW carrying it as data, so
         a reader that drops extension tags still keeps the address. */
      var publ = [];
      if (s.url) publ.push(s.url);
      if (s.retrieved) publ.push('retrieved ' + s.retrieved);
      if (publ.length) body.line(1, 'PUBL', publ.join(', '));
      if (v7 && s.url) body.line(1, '_WWW', s.url);
      var r = repoOf[(s.repository || '').trim()];
      if (r) body.line(1, 'REPO', '@' + r.xref + '@');
      if (s.reliability) body.line(1, 'NOTE', s.reliability);
    });

    /* Which files disagreed, what each said, and how it was settled. GEDCOM
       has no concept for this, so it is carried as a documented extension. */
    if (v7) {
      (model.conflicts || []).forEach(function (c, i) {
        body.line(0, '@C' + (i + 1) + '@', '_CONFLICT');
        body.line(1, '_RECORD', c.ownerType === 'family'
          ? '@F' + c.ownerId + '@' : '@I' + c.ownerId + '@');
        if (c.tag) body.line(1, '_FACT', c.tag);
        (c.options || []).forEach(function (o) {
          body.line(1, '_VALUE', o.display || '');
          if (o.place) body.line(2, '_PLACE', o.place);
          (o.origins || []).forEach(function (f) { body.line(2, '_FROM', f); });
        });
        body.line(1, '_RESOLVEDBY', c.resolvedBy || 'both');
        if (c.resolution) body.line(1, 'NOTE', c.resolution);
      });
    }

    /* ---- header -------------------------------------------------------- */
    w.line(0, 'HEAD');
    w.line(1, 'GEDC');
    w.line(2, 'VERS', v7 ? '7.0' : '5.5.1');
    if (!v7) w.line(2, 'FORM', 'LINEAGE-LINKED');
    if (v7) {
      var used = Object.keys(body.used).filter(function (t) { return EXT[t]; }).sort();
      if (used.length) {
        w.line(1, 'SCHMA');
        used.forEach(function (t) { w.line(2, 'TAG', t + ' ' + EXT[t]); });
      }
    }
    w.line(1, 'SOUR', 'AncestryFileViewer');
    w.line(2, 'NAME', 'Ancestry File Viewer');
    w.line(2, 'VERS', '1.0');
    if (!v7) w.line(1, 'DEST', 'ANY');
    w.line(1, 'DATE', now.getDate() + ' ' + MON[now.getMonth()] + ' ' + now.getFullYear());
    if (!v7) w.line(1, 'FILE', model.source.filename || 'export.ged');
    if (!v7) w.line(1, 'CHAR', 'UTF-8');       // removed in 7.0: UTF-8 is implied
    /* Header notes survive a round trip, so anything the reader derives rather
       than read — the counts it prints in the Overview — is left out, and the
       rest is de-duplicated. Otherwise every save/open cycle grows the header. */
    var head = ['Converted from ' + (model.source.formatLabel || model.source.format) +
                ' file "' + (model.source.filename || '') + '".'];
    (model.source.notes || []).concat(model.warnings || []).forEach(function (n) {
      head.push(n);
    });
    var seenNote = {};
    head.filter(function (n) {
      n = String(n || '').trim();
      if (!n || /were read\.?$/.test(n) || /were read \(/.test(n)) return false;
      if (seenNote[n]) return false;
      seenNote[n] = true;
      return true;
    }).forEach(function (n) { w.line(1, 'NOTE', n); });

    return w.text().replace(/\n$/, '\n') + body.text() + '0 TRLR\n';
  }

  var KNOWN = ['BIRT', 'CHR', 'DEAT', 'BURI', 'CREM', 'ADOP', 'BAPM', 'BARM', 'BASM',
               'BLES', 'CHRA', 'CONF', 'FCOM', 'ORDN', 'NATU', 'EMIG', 'IMMI', 'CENS',
               'PROB', 'WILL', 'GRAD', 'RETI', 'MARR', 'DIV', 'ANUL', 'ENGA', 'MARB',
               'MARC', 'MARL', 'MARS', 'EVEN', 'OCCU', 'RESI', 'RELI', 'EDUC', 'DSCR',
               'NATI', 'PROP', 'SSN', 'TITL', 'CAST', 'IDNO', 'NCHI', 'NMR'];

  /* Tags whose payload may not be free text: a family event takes Y or nothing,
     so a descriptive detail has to become a NOTE instead. */
  var NO_PAYLOAD = { MARR: 1, DIV: 1, ANUL: 1, ENGA: 1, BIRT: 1, DEAT: 1, CHR: 1, BURI: 1 };

  function writeEvent(w, e, citeList, v7) {
    var tag = KNOWN.indexOf(e.tag) >= 0 ? e.tag : 'EVEN';
    if (!e.date.gedcom && !e.date.display && !e.place && !e.detail && !e.note) return;
    var detail = e.detail || '';
    var payload = (tag === 'EVEN' || NO_PAYLOAD[tag]) ? '' : detail;
    w.line(1, tag, payload);
    if (tag === 'EVEN') w.line(2, 'TYPE', e.label || e.tag);
    if (e.date.gedcom) w.line(2, 'DATE', e.date.gedcom);
    else if (e.date.display) w.line(2, 'DATE', e.date.display);
    if (e.place) w.line(2, 'PLAC', e.place);
    if (detail && !payload) w.line(2, 'NOTE', detail);
    if (e.note) w.line(2, 'NOTE', e.note);
    if (citeList) citeList(w, 2, e.sources);
  }

  /* A self-check on the produced text: shape of every line, level steps,
     xref resolution, and — for 7.0 — that every extension tag is declared. */
  function validate(text) {
    var lines = text.split('\n'), prev = -1, problems = [];
    var counts = { INDI: 0, FAM: 0, SOUR: 0, REPO: 0, _CONFLICT: 0 };
    var defined = {}, used = {}, declared = {}, extUsed = {}, v7 = false;
    lines.forEach(function (line, i) {
      if (!line) return;
      var m = /^(\d+) (@[^@]+@|\S+)(?: (.*))?$/.exec(line);
      if (!m) { problems.push('line ' + (i + 1) + ': malformed'); return; }
      var lvl = +m[1], a = m[2], val = m[3] || '';
      if (lvl > prev + 1) problems.push('line ' + (i + 1) + ': level jumps ' + prev + '->' + lvl);
      prev = lvl;
      var tag = /^@/.test(a) ? val.split(' ')[0] : a;
      if (lvl === 0 && /^@/.test(a)) {
        defined[a] = true;
        if (counts[tag] !== undefined) counts[tag]++;
      }
      if (tag && tag.charAt(0) === '_') extUsed[tag] = true;
      if (lvl === 2 && tag === 'VERS' && val === '7.0') v7 = true;
      if (lvl === 2 && a === 'TAG') declared[val.split(' ')[0]] = true;
      /* pointer payloads */
      if (/^@[^@]+@$/.test(val)) used[val] = true;
      if (v7 && /^\d+ CONC/.test(line)) problems.push('line ' + (i + 1) + ': CONC is not allowed in 7.0');
      if (v7 && lvl === 1 && tag === 'CHAR') problems.push('line ' + (i + 1) + ': CHAR is not used in 7.0');
      if (NO_PAYLOAD[tag] && lvl >= 1 && val && val !== 'Y' && !/^@/.test(a)) {
        problems.push('line ' + (i + 1) + ': ' + tag + ' takes Y or no payload, got "' + val + '"');
      }
    });
    Object.keys(used).forEach(function (p) {
      if (!defined[p]) problems.push('pointer ' + p + ' has no record');
    });
    if (v7) {
      Object.keys(extUsed).forEach(function (t) {
        if (!declared[t]) problems.push('extension tag ' + t + ' is not declared in SCHMA');
      });
      if (!/\n0 TRLR/.test('\n' + text)) problems.push('missing TRLR');
    }
    return {
      lines: lines.length, version: v7 ? '7.0' : '5.5.1',
      individuals: counts.INDI, families: counts.FAM, sources: counts.SOUR,
      repositories: counts.REPO, conflicts: counts._CONFLICT, problems: problems
    };
  }

  AV.gedcom = { build: build, validate: validate, EXT: EXT };
  window.AV = AV;
})(AV);
