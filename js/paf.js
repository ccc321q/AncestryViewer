/* paf.js - Personal Ancestral File 5 (.paf) reader.
 *
 * PAF was retired by FamilySearch in 2013 and its binary format was never
 * published. Everything below was reverse-engineered from two real files and
 * cross-checked against a RootsMagic export of the same data, which gave an
 * independent ground truth for names, sex, dates, places and relationships.
 *
 * Layout, in brief
 * ----------------
 *   header      "500\0500\0PAF\0" + flags, then a struct of region pointers.
 *   name recs   variable length, [u32 RIN][u8 tag][u16 len][data][10-byte tail].
 *               The tail's first link word doubles as the record's "handle",
 *               which every other structure uses to point at a person.
 *   person recs 221 bytes: UUID, four event slots (birth / christening /
 *               death / burial), a sex byte, and the name handle.
 *   marriages   106 bytes: husband RIN, wife RIN, head of the child list,
 *               UUID, marriage date + place. 77 per 8 KB extent, and the
 *               extent order is the marriage-number order.
 *   child links 46 bytes: [family][next link][link id][child RIN], forming a
 *               circular list per family that preserves birth order.
 *   notes       [u32 owner][u8 'I'|'M'][text][NUL].
 *   places      a binary tree of strings: [left][right][parent][tag][text].
 *   dates       Julian Day Numbers, with a 4-byte qualifier in front giving
 *               the modifier (about / before / after) and the precision.
 */
var AV = window.AV || {};
(function (AV) {
  'use strict';
  var U = AV.util;

  var FREE = 0xFFFFFFFF;
  var EXTENT = 0x2000;              // allocation extent, always 8 KB
  var PERSON_LEN = 221, MARR_LEN = 106, LINK_LEN = 46;
  var PERSON_PER_EXT = 37, MARR_PER_EXT = 77, LINK_PER_EXT = 178;

  var NAME_TAG = { 1: 'name', 4: 'title', 5: 'altSurname', 6: 'altGiven', 7: 'nickname' };

  var SLOTS = [
    { off: 16, tag: 'BIRT', label: 'Birth', order: 1 },
    { off: 40, tag: 'CHR', label: 'Christening', order: 2 },
    { off: 64, tag: 'DEAT', label: 'Death', order: 20 },
    { off: 88, tag: 'BURI', label: 'Burial', order: 21 }
  ];
  var MODIFIER = { 0: '', 1: 'about', 2: 'after', 3: 'before' };

  /* "500" is the version that wrote the file: 5.0.0 */
  function dotted(v) { return /^\d{3}$/.test(v) ? v.split('').join('.') : v; }

  function looksLikePaf(bytes) {
    return bytes.length > 0x80 &&
      bytes[0] === 0x35 && bytes[1] === 0x30 && bytes[2] === 0x30 && bytes[3] === 0 &&
      bytes[8] === 0x50 && bytes[9] === 0x41 && bytes[10] === 0x46;
  }

  /* --- date ---------------------------------------------------------------
     Four qualifier bytes then the Julian Day Number:
       [0] 0x12 marker  [1] modifier  [2] flags  [3] precision
     precision bits: 0x20 no day, 0x40 no month, 0x80 no year. */
  function readDate(r, o) {
    if (r.u8(o) !== 0x12) return null;
    var jdn = r.u32(o + 4);
    if (!jdn || jdn < 1000000 || jdn > 3000000) return null;
    var ymd = U.jdnToYmd(jdn);
    var prec = r.u8(o + 3);
    return U.makeDate({
      year: (prec & 0x80) ? 0 : ymd.y,
      month: (prec & 0x40) ? 0 : ymd.m,
      day: (prec & 0x20) ? 0 : ymd.d,
      modifier: MODIFIER[r.u8(o + 1)] || '',
      raw: 'JDN ' + jdn
    });
  }

  /* --- place strings ------------------------------------------------------
     Nodes are packed contiguously: [u32 left][u32 right][u32 parent][u8 tag]
     [NUL-terminated text]. Pointers elsewhere in the file address the node,
     so resolution is a direct read plus a sanity check. */
  function PlacePool(r, model) {
    this.r = r; this.model = model; this.cache = new Map();
  }
  PlacePool.prototype.resolve = function (ptr) {
    if (!ptr || ptr + 14 >= this.r.length) return '';
    if (this.cache.has(ptr)) return this.cache.get(ptr);
    var tag = this.r.u8(ptr + 12);
    var s = '';
    if (tag >= 1 && tag <= 8) {
      var got = this.r.cstr(ptr + 13, ptr + 13 + 250);
      var text = got.text;
      if (text.length >= 1 && text.length <= 240 && !/[\x00-\x08\x0e-\x1f]/.test(text)) s = text;
    }
    this.cache.set(ptr, s);
    if (s) this.model.places.set(ptr, { id: ptr, name: s });
    return s;
  };

  /* --- name records ------------------------------------------------------- */
  function readNameRecords(r, start, end, maxRin, report) {
    function parse(p) {
      if (p + 17 > end) return null;
      var rin = r.u32(p), tag = r.u8(p + 4), len = r.u16(p + 5);
      if (len < 1 || len > 400) return null;
      var next = p + 7 + len + 10;
      if (next > end) return null;
      if (rin === FREE) return { next: next, rec: null };        // free block
      if (rin < 1 || rin > maxRin || tag < 1 || tag > 8) return null;
      var i, z = -1;
      for (i = 0; i < len; i++) {
        if (r.bytes[p + 7 + i] === 0) { z = i; break; }
        if (r.bytes[p + 7 + i] < 32) return null;
      }
      var nameLen = z < 0 ? len : z;
      if (nameLen < 1) return null;
      return {
        next: next,
        rec: {
          off: p, rin: rin, tag: tag, len: len,
          text: U.decodeText(r.bytes, p + 7, p + 7 + nameLen),
          handle: p + 9 + len
        }
      };
    }
    function chain(p, k) {
      var i, res;
      for (i = 0; i < k; i++) {
        res = parse(p);
        if (!res) return false;
        p = res.next;
      }
      return true;
    }

    var recs = [], p = start + 8, resyncs = 0, skipped = 0, res, q;
    while (p < end) {
      res = parse(p);
      if (!res) {
        // Other record streams are interleaved into the same region; skip to
        // the next position that starts a believable run of name records.
        q = p + 1;
        while (q < end && !chain(q, 4)) q++;
        if (q >= end) { skipped += end - p; break; }
        resyncs++; skipped += q - p; p = q;
        continue;
      }
      if (res.rec) recs.push(res.rec);
      p = res.next;
    }
    report.resyncs = resyncs;
    report.skippedBytes = skipped;
    return recs;
  }

  /* --- notes -------------------------------------------------------------- */
  function readNotes(r, maxRin) {
    var b = r.bytes, n = r.length, i = 0, out = [], j, kind, rin, text;
    while (i < n - 8) {
      rin = r.u32(i);
      kind = b[i + 4];
      if (rin >= 1 && rin <= maxRin && (kind === 0x49 || kind === 0x4d)) {
        j = i + 5;
        while (j < n && (b[j] >= 0x20 || b[j] === 9 || b[j] === 10 || b[j] === 13)) j++;
        if (j < n && b[j] === 0 && j - i - 5 >= 8) {
          text = U.decodeText(b, i + 5, j);
          if (/[A-Za-z]{3}/.test(text)) {
            out.push({ off: i, owner: rin, kind: kind === 0x49 ? 'I' : 'M', text: text });
            i = j + 1;
            continue;
          }
        }
      }
      i++;
    }
    /* PAF splits long notes into ~244-character chunks stored as consecutive
       records for the same owner; stitch those back into one note. */
    var merged = [], k;
    for (k = 0; k < out.length; k++) {
      var prev = merged[merged.length - 1];
      if (prev && prev.owner === out[k].owner && prev.kind === out[k].kind &&
          prev.lastChunk >= 240 && out[k].off - prev.endOff < 0x4000) {
        prev.text += out[k].text;
        prev.lastChunk = out[k].text.length;
        prev.endOff = out[k].off + 6 + out[k].text.length;
      } else {
        merged.push({
          off: out[k].off, owner: out[k].owner, kind: out[k].kind, text: out[k].text,
          lastChunk: out[k].text.length, endOff: out[k].off + 6 + out[k].text.length
        });
      }
    }
    return merged;
  }

  /* --- 221-byte person records -------------------------------------------
     Anchored on the name handle at +173, then confirmed by requiring either
     a sex byte or at least one well-formed event slot. */
  function readPersonRecords(r, handles, report) {
    var n = r.length, o, h, rin, score, s, sex, found = new Map(), byOff = new Map();
    for (o = 0; o + PERSON_LEN <= n; o++) {
      h = r.u32(o + 173);
      rin = handles.get(h);
      if (!rin) continue;
      var ts = r.u32(o + 193);
      if (ts < 0x28000000 || ts > 0x70000000) continue;    // plausible mtime
      sex = r.u8(o + 154);
      if (sex !== 0x4d && sex !== 0x46 && sex !== 0) continue;
      score = 0;
      for (s = 0; s < SLOTS.length; s++) {
        if (r.u8(o + SLOTS[s].off) === 0x12 && r.u32(o + SLOTS[s].off + 4) > 1000000) score++;
      }
      if (sex === 0x4d || sex === 0x46) score++;
      if (score < 1) continue;
      var prev = found.get(rin);
      if (!prev || score > prev.score) found.set(rin, { off: o, score: score, rin: rin });
    }
    found.forEach(function (v) { byOff.set(v.off, v); });

    /* Records sit at extentBase+0x30 + k*221, 37 to an 8 KB extent, in RIN
       order. The 37th record's handle word is not always written, so recover
       it from its neighbour when the position and the free RIN both line up. */
    var recovered = 0;
    byOff.forEach(function (v) {
      var k, base = -1;
      for (k = 0; k < PERSON_PER_EXT; k++) {
        var bb = v.off - 0x30 - k * PERSON_LEN;
        if (bb >= 0 && bb % 0x1000 === 0) { base = bb; break; }
      }
      if (base < 0) return;
      var last = base + 0x30 + (PERSON_PER_EXT - 1) * PERSON_LEN;
      if (byOff.has(last) || last + PERSON_LEN > n) return;
      var prevRec = byOff.get(last - PERSON_LEN);
      if (!prevRec) return;
      var guess = prevRec.rin + 1;
      if (found.has(guess)) return;
      var sx = r.u8(last + 154);
      if (sx !== 0x4d && sx !== 0x46 && sx !== 0) return;
      var sc = 0, i;
      for (i = 0; i < SLOTS.length; i++) {
        if (r.u8(last + SLOTS[i].off) === 0x12 && r.u32(last + SLOTS[i].off + 4) > 1000000) sc++;
      }
      if (sx !== 0) sc++;
      if (sc < 1) return;
      found.set(guess, { off: last, score: sc, rin: guess, inferred: true });
      recovered++;
    });
    report.personRecordsRecovered = recovered;
    return found;
  }

  /* --- marriages and child links ------------------------------------------ */
  function readMarriages(r, maxRin) {
    var n = r.length, base, k, o, hu, wi, ts, bases = [], any, i;
    for (base = 0; base + 4 + MARR_LEN * 3 < n; base += 0x1000) {
      var okCount = 0;
      for (k = 0; k < 3; k++) {
        o = base + 4 + k * MARR_LEN;
        hu = r.u32(o); wi = r.u32(o + 4); ts = r.u32(o + 102);
        if (hu > maxRin || wi > maxRin) break;
        if (ts < 0x28000000 || ts > 0x70000000) break;
        any = false;
        for (i = 0; i < 16; i++) if (r.bytes[o + 32 + i]) { any = true; break; }
        if (!any) break;
        okCount++;
      }
      if (okCount === 3) bases.push(base);
    }
    var marriages = new Map();
    bases.forEach(function (b0, ei) {
      for (k = 0; k < MARR_PER_EXT; k++) {
        o = b0 + 4 + k * MARR_LEN;
        if (o + MARR_LEN > n) break;
        var h = r.u32(o), w = r.u32(o + 4), head = r.u32(o + 8);
        var mrin = ei * MARR_PER_EXT + k + 1;
        if (h > maxRin || w > maxRin) continue;
        if (!h && !w && !head) continue;                       // unused slot
        marriages.set(mrin, {
          mrin: mrin, off: o, husband: h, wife: w, head: head,
          date: readDate(r, o + 48), placePtr: r.u32(o + 60)
        });
      }
    });
    return marriages;
  }

  function readChildLinks(r, maxRin) {
    var n = r.length, links = new Map(), base, k, f, id0;
    for (base = 0; base + LINK_LEN * 3 < n; base += 0x1000) {
      id0 = r.u32(base + 8);
      if (!id0 || id0 > 400000) continue;
      var good = true;
      for (k = 0; k < 3; k++) {
        f = base + k * LINK_LEN;
        var child = r.u32(f + 12);
        if (child < 1 || child > maxRin) { good = false; break; }
        if (r.u32(f + 8) !== id0 + k) { good = false; break; }
      }
      if (!good) continue;
      for (k = 0; k < LINK_PER_EXT; k++) {
        f = base + k * LINK_LEN;
        if (f + LINK_LEN > n) break;
        var id = r.u32(f + 8);
        if (!id || id > 400000) continue;
        links.set(id, { fam: r.u32(f), next: r.u32(f + 4), id: id, child: r.u32(f + 12) });
      }
    }
    return links;
  }

  /* --- main ---------------------------------------------------------------- */
  function parse(buf, filename) {
    var r = new U.Reader(buf);
    if (!looksLikePaf(r.bytes)) throw new Error('Not a Personal Ancestral File');

    var writeVer = dotted(r.str(0, 3)), readVer = dotted(r.str(4, 3));
    var hdr = {
      individualCount: r.u32(0x16),
      nextRin: r.u32(0x3e),
      nameStart: r.u32(0x46),
      nameEnd: r.u32(0x4a),
      placeCount: r.u32(0x5a),
      placeStart: r.u32(0x62),
      factStart: r.u32(0x76)
    };
    var maxRin = Math.max(hdr.nextRin, hdr.individualCount) || 100000;

    var model = new AV.Model({
      format: 'paf',
      formatLabel: 'Personal Ancestral File ' + writeVer,
      filename: filename,
      size: buf.byteLength,
      version: 'written by PAF ' + writeVer + ', readable by ' + readVer + ' and later'
    });
    var report = {};
    var places = new PlacePool(r, model);

    /* names */
    var nameRecs = readNameRecords(r, hdr.nameStart, hdr.nameEnd, maxRin, report);
    var handles = new Map();
    nameRecs.forEach(function (rec) { handles.set(rec.handle, rec.rin); });
    nameRecs.forEach(function (rec) {
      var p = model.person(rec.rin), kind = NAME_TAG[rec.tag];
      if (kind === 'name') {
        var parts = AV.splitName(rec.text);
        p.given = parts.given; p.surname = parts.surname;
        if (parts.suffix) p.suffix = parts.suffix;
        p.fullName = (parts.given + ' ' + parts.surname).trim() || '(unnamed)';
        p.gedcomName = rec.text;
      } else if (kind === 'title') { p.prefix = rec.text; }
      else if (kind === 'nickname' || kind === 'altGiven') {
        if (!p.nickname) p.nickname = rec.text;
        else if (p.altNames.indexOf(rec.text) < 0) p.altNames.push(rec.text);
      } else if (kind === 'altSurname') {
        if (p.altNames.indexOf(rec.text) < 0) p.altNames.push(rec.text);
      }
    });

    /* person detail: sex + the four vital events */
    var persons = readPersonRecords(r, handles, report);
    persons.forEach(function (rec) {
      var p = model.person(rec.rin), sx = r.u8(rec.off + 154);
      p.sex = sx === 0x4d ? 'M' : (sx === 0x46 ? 'F' : '');
      p.recordOffset = rec.off;
      SLOTS.forEach(function (slot) {
        var o = rec.off + slot.off;
        var d = readDate(r, o);
        var placePtr = r.u32(o + 12);
        var place = places.resolve(placePtr);
        if (!d && !place) return;
        p.events.push({
          tag: slot.tag, label: slot.label,
          date: d || U.EMPTY_DATE,
          place: place, placeId: placePtr,
          detail: '', note: '', order: slot.order
        });
      });
    });

    /* marriages */
    var marriages = readMarriages(r, maxRin);
    var links = readChildLinks(r, maxRin);
    marriages.forEach(function (m) {
      var f = model.family(m.mrin);
      f.husband = m.husband; f.wife = m.wife;
      f.recordOffset = m.off;
      var place = places.resolve(m.placePtr);
      if (m.date || place) {
        f.events.push({
          tag: 'MARR', label: 'Marriage',
          date: m.date || U.EMPTY_DATE,
          place: place, placeId: m.placePtr,
          detail: '', note: '', order: 9
        });
      }
      // children: a circular singly-linked list starting at the family head
      var id = m.head, guard = 0, seen = {};
      while (id && !seen[id] && guard++ < 5000) {
        seen[id] = 1;
        var link = links.get(id);
        if (!link) break;
        if (link.child && f.children.indexOf(link.child) < 0) f.children.push(link.child);
        id = link.next;
      }
    });

    /* Child links whose family never produced a marriage record still tell us
       the parentage, so fold them in rather than dropping the relationship. */
    var orphanLinks = 0;
    links.forEach(function (link) {
      if (!link.fam || !link.child) return;
      var f = model.families.get(link.fam);
      if (!f) { orphanLinks++; return; }
      if (f.children.indexOf(link.child) < 0) { f.children.push(link.child); orphanLinks++; }
    });

    /* notes */
    var notes = readNotes(r, maxRin);
    notes.forEach(function (nt) {
      if (nt.kind === 'I') {
        if (model.people.has(nt.owner)) model.person(nt.owner).notes.push(nt.text);
      } else if (model.families.has(nt.owner)) {
        model.family(nt.owner).notes.push(nt.text);
      }
    });

    model.raw = {
      kind: 'paf', reader: r, header: hdr, nameRecords: nameRecs,
      personRecords: persons, marriages: marriages, links: links,
      notes: notes, report: report,
      writeVersion: writeVer, readVersion: readVer
    };

    var named = 0;
    model.people.forEach(function (p) { if (p.fullName && p.fullName !== '(unnamed)') named++; });
    model.source.notes = [
      'Header declares ' + hdr.individualCount + ' individuals; ' + named + ' names recovered.',
      persons.size + ' individual detail records (sex, birth, christening, death, burial).',
      marriages.size + ' marriages and ' + links.size + ' child links.',
      notes.length + ' notes.',
      'PAF 5 has no published specification - this reader was reverse-engineered ' +
      'from the file itself. Use the Inspector tab to see the raw records.'
    ];
    if (report.resyncs) {
      model.warnings.push('Name-record stream needed ' + report.resyncs +
        ' resynchronisations (other record types are interleaved into the same region).');
    }
    if (named < hdr.individualCount) {
      model.warnings.push((hdr.individualCount - named) + ' of ' + hdr.individualCount +
        ' individuals could not be recovered from the name stream.');
    }
    if (persons.size < named) {
      model.warnings.push((named - persons.size) + ' individuals have no detail record, ' +
        'so no sex or vital dates are shown for them.');
    }
    return model.finalise();
  }

  AV.paf = { parse: parse, looksLikePaf: looksLikePaf, readDate: readDate, SLOTS: SLOTS };
  window.AV = AV;
})(AV);
