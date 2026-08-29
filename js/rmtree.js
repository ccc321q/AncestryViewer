/* rmtree.js - RootsMagic (.rmtree / .rmgc / .rmgb) into the neutral model.
   The file is a plain SQLite 3 database; sqlite.js reads the pages. */
var AV = window.AV || {};
(function (AV) {
  'use strict';
  var U = AV.util;

  /* RootsMagic packs dates as e.g. "D.+18820114..+00000000..":
       [0]  'D' when a date is present
       [1]  '.' single | 'B' before | 'A' after | 'R' range
       [2]  '+' / '-' era sign
       [3..10] YYYYMMDD, zeroes meaning "unknown"
       [12] 'A' when the date is approximate ("about")            */
  function parseRmDate(s) {
    if (!s || s.charAt(0) !== 'D') return U.makeDate({ raw: s === '.' ? '' : (s || '') });
    var kind = s.charAt(1);
    var y = parseInt(s.substr(3, 4), 10) || 0;
    var m = parseInt(s.substr(7, 2), 10) || 0;
    var d = parseInt(s.substr(9, 2), 10) || 0;
    var mod = '';
    if (s.charAt(12) === 'A') mod = 'about';
    if (kind === 'B') mod = 'before';
    else if (kind === 'A') mod = 'after';
    var out = U.makeDate({ year: y, month: m, day: d, modifier: mod, raw: s });
    if (kind === 'R') {
      var y2 = parseInt(s.substr(14, 4), 10) || 0;
      if (y2) {
        out.display = 'between ' + out.display + ' and ' + y2;
        out.gedcom = 'BET ' + out.gedcom + ' AND ' + y2;
      }
    }
    return out;
  }

  function parse(buf, filename) {
    var db = new AV.SQLiteDB(buf);
    var model = new AV.Model({
      format: 'rmtree',
      formatLabel: 'RootsMagic database (SQLite 3)',
      filename: filename,
      size: buf.byteLength,
      version: 'page size ' + db.pageSize + ', ' + db.pageCount + ' pages'
    });
    model.raw = { kind: 'sqlite', db: db };

    /* places */
    db.table('PlaceTable').forEach(function (r) {
      model.places.set(r.PlaceID, {
        id: r.PlaceID, name: r.Name || '', normalized: r.Normalized || '',
        lat: r.Latitude, lng: r.Longitude, type: r.PlaceType
      });
    });

    /* fact types: id -> {label, tag} */
    var facts = new Map();
    db.table('FactTypeTable').forEach(function (r) {
      facts.set(r.FactTypeID, {
        label: r.Name || r.Abbrev || ('Type ' + r.FactTypeID),
        tag: (r.GedcomTag || 'EVEN').toUpperCase(),
        sentence: r.Sentence || '',
        ownerType: r.OwnerType
      });
    });

    /* people + primary/alternate names */
    db.table('PersonTable').forEach(function (r) {
      var p = model.person(r.PersonID);
      p.sex = r.Sex === 0 ? 'M' : (r.Sex === 1 ? 'F' : '');
      p.living = !!r.Living;
      p.uid = r.UniqueID || '';
      if (r.Note) p.notes.push(String(r.Note));
    });
    db.table('NameTable').forEach(function (r) {
      var p = model.person(r.OwnerID);
      var given = (r.Given || '').trim(), sur = (r.Surname || '').trim();
      if (r.IsPrimary || !p.fullName) {
        p.given = given; p.surname = sur;
        p.prefix = (r.Prefix || '').trim();
        p.suffix = (r.Suffix || '').trim();
        p.nickname = (r.Nickname || '').trim();
        p.fullName = (given + ' ' + sur).trim() || '(unnamed)';
      } else {
        var alt = (given + ' ' + sur).trim();
        if (alt && p.altNames.indexOf(alt) < 0) p.altNames.push(alt);
      }
      if (r.Note) p.notes.push(String(r.Note));
    });

    /* families and children */
    db.table('FamilyTable').forEach(function (r) {
      var f = model.family(r.FamilyID);
      f.husband = r.FatherID || 0;
      f.wife = r.MotherID || 0;
      if (r.Note) f.notes.push(String(r.Note));
    });
    var kids = db.table('ChildTable');
    kids.sort(function (a, b) { return (a.ChildOrder || 0) - (b.ChildOrder || 0); });
    kids.forEach(function (r) {
      var f = model.family(r.FamilyID);
      if (r.ChildID && f.children.indexOf(r.ChildID) < 0) f.children.push(r.ChildID);
    });

    /* events */
    db.table('EventTable').forEach(function (r) {
      var ft = facts.get(r.EventType) || { label: 'Event ' + r.EventType, tag: 'EVEN' };
      var ev = {
        tag: ft.tag,
        label: ft.label,
        date: parseRmDate(r.Date),
        place: model.placeName(r.PlaceID),
        placeId: r.PlaceID || 0,
        detail: r.Details || '',
        note: r.Note || '',
        order: orderOf(ft.tag)
      };
      if (r.OwnerType === 1) {
        model.family(r.OwnerID || r.FamilyID).events.push(ev);
      } else {
        model.person(r.OwnerID).events.push(ev);
      }
    });

    model.source.notes = [
      'RootsMagic schema with ' + db.tableNames().length + ' tables.',
      'Read with the built-in SQLite reader, so the RMNOCASE collation that ' +
      'blocks generic SQLite tools is never invoked.'
    ];
    return model.finalise();
  }

  var ORDER = { BIRT: 1, CHR: 2, BAPM: 3, CONF: 4, GRAD: 5, OCCU: 6, RESI: 7, CENS: 8,
                MARR: 9, DIV: 10, RETI: 11, DEAT: 20, BURI: 21, CREM: 22, PROB: 23, WILL: 24 };
  function orderOf(tag) { return ORDER[tag] || 12; }

  AV.rmtree = { parse: parse, parseDate: parseRmDate, orderOf: orderOf };
  window.AV = AV;
})(AV);
