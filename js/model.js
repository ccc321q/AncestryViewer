/* model.js - the neutral genealogy model every parser targets.
   Rendering, search, pedigree and GEDCOM export are written once against
   this shape, so adding a format only means adding a parser. */
var AV = window.AV || {};
(function (AV) {
  'use strict';
  var U = AV.util;

  function Model(source) {
    this.source = source || {};      // {format, filename, size, version, notes[]}
    this.people = new Map();         // id -> Person
    this.families = new Map();       // id -> Family
    this.places = new Map();         // id -> {id, name}
    this.sources = new Map();        // id -> {id, title, url, repository, retrieved, reliability}
    this.log = [];                   // .pal activity rows
    this.warnings = [];
    this.stats = {};
    this.raw = null;                 // format-specific payload for the inspector
  }

  Model.prototype.person = function (id) {
    var p = this.people.get(id);
    if (!p) {
      p = {
        id: id, given: '', surname: '', prefix: '', suffix: '', nickname: '',
        fullName: '', altNames: [], sex: '', living: false,
        events: [],                  // {tag, label, date, place, detail, note, sources[]}
        notes: [],
        sources: [],                 // source ids backing the person as a whole
        famc: [],                    // families this person is a child in
        fams: []                     // families this person is a spouse in
      };
      this.people.set(id, p);
    }
    return p;
  };

  Model.prototype.family = function (id) {
    var f = this.families.get(id);
    if (!f) {
      f = { id: id, husband: 0, wife: 0, children: [], events: [], notes: [], sources: [] };
      this.families.set(id, f);
    }
    return f;
  };

  /* Sources are optional: only formats that record where a fact came from
     (currently .ged) populate this, and the UI hides itself when it is empty.
     Named sourceRec, not source, because `model.source` is the file's own
     metadata and an instance property would shadow a prototype method. */
  Model.prototype.sourceRec = function (id) {
    var s = this.sources.get(id);
    if (!s) {
      s = { id: id, title: '', url: '', repository: '', retrieved: '', reliability: '' };
      this.sources.set(id, s);
    }
    return s;
  };

  Model.prototype.placeName = function (id) {
    var p = this.places.get(id);
    return p ? p.name : '';
  };

  /* Split a GEDCOM-style "Given Names /Surname/" into parts. */
  function splitName(full) {
    var m = /^(.*?)\s*\/([^/]*)\/\s*(.*)$/.exec(full || '');
    if (!m) return { given: (full || '').trim(), surname: '', suffix: '' };
    return { given: m[1].trim(), surname: m[2].trim(), suffix: (m[3] || '').trim() };
  }

  function displayName(p) {
    var n = (p.given + ' ' + p.surname).trim();
    return n || '(unnamed)';
  }

  /* Called once after a parser has filled the model. */
  Model.prototype.finalise = function () {
    var self = this;
    this.people.forEach(function (p) {
      if (!p.fullName) p.fullName = displayName(p);
      p.events.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      p.birth = p.events.find(function (e) { return e.tag === 'BIRT'; }) || null;
      p.death = p.events.find(function (e) { return e.tag === 'DEAT'; }) || null;
      p.sortKey = (p.surname + ',' + p.given).toLowerCase();
      p.searchKey = (p.fullName + ' ' + p.altNames.join(' ') + ' ' + p.id + ' ' +
        p.events.map(function (e) { return e.place + ' ' + e.date.display; }).join(' ')
      ).toLowerCase();
    });
    this.families.forEach(function (f) {
      if (f.husband && self.people.has(f.husband)) pushUnique(self.people.get(f.husband).fams, f.id);
      if (f.wife && self.people.has(f.wife)) pushUnique(self.people.get(f.wife).fams, f.id);
      f.children.forEach(function (c) {
        if (self.people.has(c)) pushUnique(self.people.get(c).famc, f.id);
      });
    });
    this.stats.people = this.people.size;
    this.stats.families = this.families.size;
    this.stats.places = this.places.size;
    this.stats.sources = this.sources.size;
    this.stats.events = 0;
    this.people.forEach(function (p) { self.stats.events += p.events.length; });
    this.families.forEach(function (f) { self.stats.events += f.events.length; });
    return this;
  };

  function pushUnique(arr, v) { if (arr.indexOf(v) < 0) arr.push(v); }

  /* Relationship helpers used by the detail view, pedigree and GEDCOM. */
  Model.prototype.parentsOf = function (id) {
    var self = this, out = [];
    (this.people.get(id) || { famc: [] }).famc.forEach(function (fid) {
      var f = self.families.get(fid);
      if (!f) return;
      if (f.husband) out.push(f.husband);
      if (f.wife) out.push(f.wife);
    });
    return out;
  };
  Model.prototype.fatherOf = function (id) {
    var self = this, r = 0;
    (this.people.get(id) || { famc: [] }).famc.forEach(function (fid) {
      var f = self.families.get(fid);
      if (f && f.husband && !r) r = f.husband;
    });
    return r;
  };
  Model.prototype.motherOf = function (id) {
    var self = this, r = 0;
    (this.people.get(id) || { famc: [] }).famc.forEach(function (fid) {
      var f = self.families.get(fid);
      if (f && f.wife && !r) r = f.wife;
    });
    return r;
  };
  Model.prototype.childrenOf = function (id) {
    var self = this, out = [];
    (this.people.get(id) || { fams: [] }).fams.forEach(function (fid) {
      var f = self.families.get(fid);
      if (f) f.children.forEach(function (c) { pushUnique(out, c); });
    });
    return out;
  };
  Model.prototype.spousesOf = function (id) {
    var self = this, out = [];
    (this.people.get(id) || { fams: [] }).fams.forEach(function (fid) {
      var f = self.families.get(fid);
      if (!f) return;
      var s = f.husband === id ? f.wife : f.husband;
      if (s) out.push({ id: s, family: fid });
    });
    return out;
  };
  Model.prototype.nameOf = function (id) {
    var p = this.people.get(id);
    return p ? p.fullName : '';
  };

  AV.Model = Model;
  AV.splitName = splitName;
  window.AV = AV;
})(AV);
