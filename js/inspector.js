/* inspector.js - the raw view. For PAF it shows the region table, the decoded
   record streams, a hex window and a byte-coverage figure, so anything the
   parser did not understand stays visible rather than silently disappearing.
   For RootsMagic it is a plain table browser; for .pal, the raw lines. */
var AV = window.AV || {};
(function (AV) {
  'use strict';
  var U = AV.util, el = U.el;

  function render(host, model) {
    U.clear(host);
    var raw = model.raw;
    if (!raw) { host.appendChild(el('p', { class: 'empty', text: 'Nothing to inspect.' })); return; }
    if (raw.kind === 'paf') return pafInspector(host, model, raw);
    if (raw.kind === 'sqlite') return sqliteInspector(host, model, raw);
    if (raw.kind === 'pal') return palInspector(host, model, raw);
    if (raw.kind === 'gedcom') return gedcomInspector(host, model, raw);
    if (raw.kind === 'merged') return mergedInspector(host, model, raw);
  }

  /* --------------------------------------------------------------- merged */
  /* What went in, how much of it collapsed together, and every fact the files
     disagreed about — the merge's own audit trail. */
  function mergedInspector(host, model, raw) {
    var went = raw.inputs.reduce(function (n, f) { return n + f.people; }, 0);
    host.appendChild(el('p', { class: 'muted', text:
      raw.inputs.length + ' files merged: ' + went + ' person records in, ' +
      model.people.size + ' out (' + (went - model.people.size) + ' matched as duplicates).' }));
    host.appendChild(table(['File', 'Format', 'People', 'Families'],
      raw.inputs.map(function (f) { return [f.filename, f.format, f.people, f.families]; })));

    host.appendChild(el('h3', { text: 'Conflicting facts (' + raw.conflicts.length + ')' }));
    if (!raw.conflicts.length) {
      host.appendChild(el('p', { class: 'empty', text: 'No file disagreed with another.' }));
    } else {
      host.appendChild(table(['Person / fact', 'Disagreement'],
        raw.conflicts.map(function (c) { return [c.about, c.issue]; })));
    }
  }

  /* --------------------------------------------------------------- GEDCOM */
  /* A GEDCOM file is already human-readable, so the inspector shows what was
     recognised, the source and repository records, any conflict records the
     file carries, and the raw text. */
  function gedcomInspector(host, model, raw) {
    var tabs = ['Overview', 'Sources', 'Conflicts', 'Raw'];
    var bar = el('div', { class: 'subtabs' });
    var pane = el('div', { class: 'subpane' });
    tabs.forEach(function (t, i) {
      bar.appendChild(el('button', {
        class: 'subtab' + (i === 0 ? ' on' : ''), text: t,
        onclick: function (e) {
          Array.prototype.forEach.call(bar.children, function (c) { c.classList.remove('on'); });
          e.target.classList.add('on');
          show(t);
        }
      }));
    });
    host.appendChild(bar);
    host.appendChild(pane);

    function show(t) {
      U.clear(pane);
      if (t === 'Overview') {
        pane.appendChild(table(['Key', 'Value'], [
          ['format', model.source.formatLabel],
          ['top-level records', raw.records],
          ['people', model.stats.people],
          ['families', model.stats.families],
          ['sources', model.stats.sources],
          ['places', model.stats.places],
          ['events', model.stats.events]
        ]));
        (model.source.notes || []).forEach(function (n) {
          pane.appendChild(el('p', { class: 'muted small', text: n }));
        });
      } else if (t === 'Sources') {
        var srcs = Array.from(model.sources.values());
        if (!srcs.length) return void pane.appendChild(el('p', { class: 'empty', text: 'No source records.' }));
        pane.appendChild(table(['ID', 'Title', 'Repository', 'Retrieved', 'URL'],
          srcs.map(function (s) {
            return [s.id, s.title, s.repository, s.retrieved, s.url];
          })));
      } else if (t === 'Conflicts') {
        var cs = model.conflicts || [];
        if (!cs.length) return void pane.appendChild(el('p', { class: 'empty', text: 'This file records no conflicts.' }));
        pane.appendChild(table(['Fact', 'Values', 'Settled by', 'Resolution'],
          cs.map(function (c) {
            return [c.label,
              (c.options || []).map(function (o) {
                return o.display + ' (' + (o.origins || []).join(', ') + ')';
              }).join('  vs  '),
              c.resolvedBy, c.resolution || ''];
          })));
      } else {
        pane.appendChild(el('p', { class: 'muted', text: U.fmtSize(raw.text.length) + ' of GEDCOM.' }));
        pane.appendChild(el('pre', { class: 'hex', text: raw.text.slice(0, 200000) }));
      }
    }
    show('Overview');
  }

  /* ------------------------------------------------------------------ PAF */
  function pafInspector(host, model, raw) {
    var r = raw.reader, h = raw.header;
    var tabs = ['Header', 'Name records', 'Person records', 'Marriages', 'Child links', 'Notes', 'Hex'];
    var bar = el('div', { class: 'subtabs' });
    var pane = el('div', { class: 'subpane' });
    tabs.forEach(function (t, i) {
      bar.appendChild(el('button', {
        class: 'subtab' + (i === 0 ? ' on' : ''), text: t,
        onclick: function (e) {
          Array.prototype.forEach.call(bar.children, function (c) { c.classList.remove('on'); });
          e.target.classList.add('on');
          show(t);
        }
      }));
    });
    host.appendChild(bar);
    host.appendChild(pane);

    function show(t) {
      U.clear(pane);
      if (t === 'Header') showHeader();
      else if (t === 'Name records') showNames();
      else if (t === 'Person records') showPersons();
      else if (t === 'Marriages') showMarriages();
      else if (t === 'Child links') showLinks();
      else if (t === 'Notes') showNotes();
      else showHex();
    }

    function showHeader() {
      var coverage = computeCoverage(raw);
      pane.appendChild(el('div', { class: 'card' }, [
        el('h3', { text: 'Header' }),
        kv('Signature', '"500\\0500\\0PAF\\0" — written by PAF ' + raw.writeVersion +
                        ', readable from ' + raw.readVersion),
        kv('Individual count (0x16)', h.individualCount),
        kv('Next record number (0x3e)', h.nextRin),
        kv('Name region (0x46/0x4a)', hex(h.nameStart) + ' … ' + hex(h.nameEnd)),
        kv('Place count (0x5a)', h.placeCount),
        kv('Place region (0x62)', hex(h.placeStart)),
        kv('Fact/sentence region (0x76)', hex(h.factStart)),
        kv('File size', U.fmtSize(r.length))
      ]));
      pane.appendChild(el('div', { class: 'card' }, [
        el('h3', { text: 'What the parser explains' }),
        bar2('Name-record region bytes consumed', coverage.namePct),
        el('p', { class: 'muted', text:
          'The name region also carries the note stream and other record types, ' +
          'so the parser resynchronises past them (' + (raw.report.resyncs || 0) +
          ' times here, ' + U.fmtSize(raw.report.skippedBytes || 0) + ' skipped).' }),
        kv('Name records decoded', raw.nameRecords.length),
        kv('Person detail records', raw.personRecords.size +
           (raw.report.personRecordsRecovered ? ' (' + raw.report.personRecordsRecovered + ' recovered positionally)' : '')),
        kv('Marriage records', raw.marriages.size),
        kv('Child links', raw.links.size),
        kv('Notes', raw.notes.length)
      ]));
      var undec = el('div', { class: 'card' }, [
        el('h3', { text: 'Known gaps' }),
        el('p', { text:
          'PAF stores a handful of less common events (divorce, cremation, funeral ' +
          'and memorial services) and LDS ordinance data outside the four vital-event ' +
          'slots of the person record. Those are not decoded yet; on the two reference ' +
          'files they account for about 2% of all events.' }),
        el('p', { text:
          'Sources, multimedia links and the sentence-template region at ' +
          hex(h.factStart) + ' are also left undecoded.' })
      ]);
      pane.appendChild(undec);
    }

    function showNames() {
      var rows = raw.nameRecords.slice(0, 4000);
      var TAG = { 1: 'name', 4: 'title', 5: 'alt surname', 6: 'alt given', 7: 'nickname' };
      pane.appendChild(el('p', { class: 'muted', text: raw.nameRecords.length + ' records (showing ' + rows.length + ').' }));
      pane.appendChild(table(
        ['Offset', 'RIN', 'Tag', 'Len', 'Handle', 'Text'],
        rows.map(function (x) {
          return [hex(x.off), x.rin, (TAG[x.tag] || x.tag), x.len, hex(x.handle), x.text];
        })));
    }

    function showPersons() {
      var rows = [];
      raw.personRecords.forEach(function (v) { rows.push(v); });
      rows.sort(function (a, b) { return a.rin - b.rin; });
      pane.appendChild(el('p', { class: 'muted', text: rows.length + ' records of 221 bytes.' }));
      pane.appendChild(table(
        ['Offset', 'RIN', 'Name', 'Sex', 'Birth', 'Chr', 'Death', 'Burial', 'Src'],
        rows.slice(0, 4000).map(function (v) {
          var p = model.people.get(v.rin) || { fullName: '', events: [] };
          function ev(tag) {
            var e = p.events.find(function (x) { return x.tag === tag; });
            return e ? ((e.date.display || '') + (e.place ? ' · ' + e.place : '')) : '';
          }
          var sx = r.u8(v.off + 154);
          return [hex(v.off), v.rin, p.fullName,
                  sx === 0x4d ? 'M' : (sx === 0x46 ? 'F' : '–'),
                  ev('BIRT'), ev('CHR'), ev('DEAT'), ev('BURI'),
                  v.inferred ? 'inferred' : 'handle'];
        })));
    }

    function showMarriages() {
      var rows = [];
      raw.marriages.forEach(function (m) { rows.push(m); });
      rows.sort(function (a, b) { return a.mrin - b.mrin; });
      pane.appendChild(table(
        ['MRIN', 'Offset', 'Husband', 'Wife', 'Date', 'Place', 'First child link'],
        rows.slice(0, 4000).map(function (m) {
          return [m.mrin, hex(m.off), m.husband + ' ' + model.nameOf(m.husband),
                  m.wife + ' ' + model.nameOf(m.wife),
                  m.date ? m.date.display : '', model.placeName(m.placePtr) || '', m.head];
        })));
    }

    function showLinks() {
      var rows = [];
      raw.links.forEach(function (l) { rows.push(l); });
      rows.sort(function (a, b) { return a.id - b.id; });
      pane.appendChild(table(
        ['Link', 'Family', 'Next', 'Child', 'Name'],
        rows.slice(0, 5000).map(function (l) {
          return [l.id, l.fam, l.next, l.child, model.nameOf(l.child)];
        })));
    }

    function showNotes() {
      pane.appendChild(table(
        ['Owner', 'Kind', 'Text'],
        raw.notes.slice(0, 3000).map(function (n) {
          return [n.owner, n.kind === 'I' ? 'individual' : 'marriage', n.text];
        })));
    }

    function showHex() {
      var at = h.nameStart;
      var input = el('input', {
        type: 'text', class: 'search hexgo', value: hex(at),
        oninput: function (e) {
          var v = parseInt(e.target.value.replace(/^0x/i, ''), 16);
          if (!isNaN(v) && v >= 0 && v < r.length) { at = v; dump.textContent = U.hexdump(r.bytes, at, 1024); }
        }
      });
      var dump = el('pre', { class: 'hex', text: U.hexdump(r.bytes, at, 1024) });
      pane.appendChild(el('div', { class: 'toolbar' }, [
        el('span', { class: 'muted', text: 'Offset (hex):' }), input,
        el('span', { class: 'muted', text: 'file is ' + hex(r.length) + ' bytes' })
      ]));
      pane.appendChild(dump);
    }

    show('Header');
  }

  function computeCoverage(raw) {
    var span = raw.header.nameEnd - raw.header.nameStart;
    var used = span - (raw.report.skippedBytes || 0);
    return { namePct: span > 0 ? Math.round((used / span) * 100) : 0 };
  }

  /* -------------------------------------------------------------- SQLite */
  function sqliteInspector(host, model, raw) {
    var db = raw.db, names = db.tableNames();
    var sel = el('select', {
      class: 'search',
      onchange: function (e) { showTable(e.target.value); }
    }, names.map(function (n) { return el('option', { value: n, text: n }); }));
    var pane = el('div', { class: 'subpane' });
    host.appendChild(el('div', { class: 'card' }, [
      el('h3', { text: 'Database' }),
      kv('Page size', db.pageSize),
      kv('Pages', db.pageCount),
      kv('Text encoding', db.encoding === 1 ? 'UTF-8' : (db.encoding === 2 ? 'UTF-16LE' : 'UTF-16BE')),
      kv('Tables', names.length),
      el('p', { class: 'muted', text:
        'Read by walking b-tree pages directly. Index collations such as ' +
        'RMNOCASE are never used, which is why this file opens here but is ' +
        'refused by generic SQLite tools.' })
    ]));
    host.appendChild(el('div', { class: 'toolbar' }, [el('span', { class: 'muted', text: 'Table:' }), sel]));
    host.appendChild(pane);

    function showTable(name) {
      U.clear(pane);
      var rows = db.table(name);
      var cols = db.schema[name].columns;
      pane.appendChild(el('p', { class: 'muted', text: rows.length + ' rows (showing up to 500).' }));
      pane.appendChild(table(cols, rows.slice(0, 500).map(function (r) {
        return cols.map(function (c) {
          var v = r[c];
          if (v instanceof Uint8Array) return '<' + v.length + ' bytes>';
          return v === null || v === undefined ? '' : String(v);
        });
      })));
    }
    showTable(names.indexOf('PersonTable') >= 0 ? 'PersonTable' : names[0]);
  }

  /* ----------------------------------------------------------------- PAL */
  function palInspector(host, model, raw) {
    host.appendChild(el('p', { class: 'muted', text: raw.lines.length + ' raw lines.' }));
    host.appendChild(el('pre', { class: 'hex', text: raw.lines.join('\n') }));
  }

  /* --------------------------------------------------------------- bits  */
  function hex(n) { return '0x' + (n >>> 0).toString(16); }
  function kv(k, v) {
    return el('div', { class: 'kv' }, [
      el('span', { class: 'k', text: k }),
      el('span', { class: 'v', text: String(v === undefined || v === null ? '–' : v) })
    ]);
  }
  function bar2(label, pct) {
    return el('div', { class: 'meter' }, [
      el('span', { class: 'k', text: label }),
      el('span', { class: 'track' }, [el('span', { class: 'fill', style: 'width:' + pct + '%' })]),
      el('span', { class: 'v', text: pct + '%' })
    ]);
  }
  function table(headers, rows) {
    var t = el('div', { class: 'table plain mono' });
    t.appendChild(el('div', { class: 'trow thead' },
      headers.map(function (hh) { return el('span', { class: 'cell', text: String(hh) }); })));
    rows.forEach(function (r) {
      t.appendChild(el('div', { class: 'trow' },
        r.map(function (c) { return el('span', { class: 'cell', text: String(c === null || c === undefined ? '' : c) }); })));
    });
    return el('div', { class: 'scrollx' }, [t]);
  }

  AV.inspector = { render: render };
  window.AV = AV;
})(AV);
