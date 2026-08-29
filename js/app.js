/* app.js - file loading, format sniffing, tab routing, GEDCOM download. */
var AV = window.AV || {};
(function (AV) {
  'use strict';
  var U = AV.util, el = U.el;

  var App = {
    file: null,         // {name, model}
    tab: 'summary'
  };

  var TABS = [
    { id: 'summary', label: 'Overview' },
    { id: 'people', label: 'People' },
    { id: 'families', label: 'Families' },
    { id: 'places', label: 'Places' },
    { id: 'log', label: 'Activity log' },
    { id: 'inspector', label: 'Inspector' }
  ];

  /* --------------------------------------------------------------- detect */
  function sniff(buf, name) {
    var bytes = new Uint8Array(buf);
    var r = new U.Reader(buf);
    if (r.eq(0, 'SQLite format 3')) return 'rmtree';
    if (AV.paf.looksLikePaf(bytes)) return 'paf';
    var head = U.decodeText(bytes, 0, Math.min(bytes.length, 4096));
    if (AV.gedcomin.looksLikeGedcom(head)) return 'ged';
    if (AV.pal.looksLikePal(head)) return 'pal';
    if (/\.(rmtree|rmgc|rmgb)$/i.test(name)) return 'rmtree';
    if (/\.paf$/i.test(name)) return 'paf';
    if (/\.pal$/i.test(name)) return 'pal';
    if (/\.(ged|gedcom)$/i.test(name)) return 'ged';
    return null;
  }

  function parseBuffer(buf, name) {
    var kind = sniff(buf, name);
    if (kind === 'rmtree') return AV.rmtree.parse(buf, name);
    if (kind === 'paf') return AV.paf.parse(buf, name);
    if (kind === 'pal') return AV.pal.parse(buf, name);
    if (kind === 'ged') return AV.gedcomin.parse(buf, name);
    throw new Error('Unrecognised file. Expected a .paf, .pal, .rmtree or .ged file.');
  }

  /* ----------------------------------------------------------------- load */
  /* Open takes one file. Merge takes two or more, parses them separately and
     combines them into a single model, so the rest of the app still only ever
     deals with one tree. Opening or merging over an open file replaces it
     after a confirm; re-offering the open file by name is a refusal. */
  function readFile(f) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve({ name: f.name, buf: fr.result }); };
      fr.onerror = function () { reject(new Error(f.name + ': could not be read')); };
      fr.readAsArrayBuffer(f);
    });
  }

  /* Swap in a freshly built model and reset everything that belonged to the
     previous one. */
  function adopt(name, model, t0, failed) {
    model.parseMs = Math.round(performance.now() - t0);
    App.file = { name: name, model: model };
    App.tab = 'summary';
    AV.render.state.place = null;
    AV.render.closePopup();   // a popup would still show the old model
    if (location.hash) location.hash = '';   // routes belong to the old model
    setStatus(failed && failed.length
      ? failed.length + ' file(s) skipped — ' + failed.join('; ') : '',
      !!(failed && failed.length));
    render();
  }

  function confirmReplace(label) {
    return !App.file || window.confirm('Replace ' + App.file.name + ' with ' + label + '?');
  }

  /* ---- open: exactly one file ---- */
  function openFile(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    var f = files[0];
    if (files.length > 1) toast('Open takes one file — use Merge files for several');
    if (App.file && App.file.name === f.name) { toast(f.name + ': already open'); return; }
    if (!confirmReplace(f.name)) return;
    setStatus('Reading ' + f.name + '…');

    readFile(f).then(function (r) {
      var t0 = performance.now();
      adopt(r.name, parseBuffer(r.buf, r.name), t0, []);
    }).catch(function (e) {
      setStatus(f.name + ': ' + e.message, true);
      if (window.console) console.error(e);
      render();
    });
  }

  /* ---- merge: two or more files ---- */
  function mergeFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    if (files.length < 2) {
      toast('Pick at least two files to merge');
      return;
    }
    var label = files.length + ' files';
    if (!confirmReplace(label)) return;
    setStatus('Reading ' + label + '…');

    Promise.all(files.map(readFile)).then(function (loaded) {
      var t0 = performance.now();
      var models = [], failed = [];
      loaded.forEach(function (f) {
        try { models.push(parseBuffer(f.buf, f.name)); }
        catch (e) { failed.push(f.name + ': ' + e.message); }
      });
      if (!models.length) throw new Error(failed.join('; ') || 'nothing could be parsed');
      if (models.length === 1) { adopt(models[0].source.filename, models[0], t0, failed); return; }

      var model = AV.merge.models(models);
      if (!model.conflicts || !model.conflicts.length) {
        adopt('merged tree', model, t0, failed);
        return;
      }
      /* The files disagree somewhere; ask before settling it. */
      setStatus(model.conflicts.length + ' facts disagree between these files — ' +
                'choose which to keep.');
      AV.conflicts.review(model).then(function (decisions) {
        var applied = decisions ? AV.merge.resolve(model, decisions) : 0;
        adopt('merged tree', model, t0, failed);
        if (decisions) {
          toast(applied
            ? applied + ' conflict' + (applied === 1 ? '' : 's') + ' resolved'
            : 'Both values kept for every conflict');
        } else {
          toast('Review cancelled — both values kept');
        }
      });
    }).catch(function (e) {
      setStatus(label + ': ' + e.message, true);
      if (window.console) console.error(e);
      render();
    });
  }

  /* Dropping files stays forgiving: one opens, several merge. */
  function loadFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (files.length > 1) mergeFiles(files);
    else openFile(files);
  }

  /* Put the app back to the empty welcome view. */
  function closeFile() {
    App.file = null;
    App.tab = 'summary';
    AV.render.state.place = null;
    AV.render.closePopup();
    if (location.hash) location.hash = '';
    setStatus('', false);
    render();
  }

  /* ----------------------------------------------------------------- view */
  function render() {
    var host = U.$('#main'), tabsHost = U.$('#tabs'), filesHost = U.$('#files');
    U.clear(filesHost);
    if (App.file) filesHost.appendChild(fileChip());

    U.clear(tabsHost);
    if (!App.file) {
      U.clear(host);
      host.appendChild(welcome());
      return;
    }
    var model = App.file.model;
    AV.render.state.model = model;

    /* Routes are read before the tab strip is built, because a place link from
       anywhere in the app decides which tab is highlighted. */
    var personRoute = /^#\/person\/(\d+)$/.exec(location.hash);
    var placeRoute = /^#\/place\/(.*)$/.exec(location.hash);
    if (placeRoute) {
      App.tab = 'places';
      try { AV.render.state.place = decodeURIComponent(placeRoute[1]); }
      catch (e) { AV.render.state.place = placeRoute[1]; }
    }

    TABS.forEach(function (t) {
      if (t.id === 'log' && !model.log.length) return;
      tabsHost.appendChild(el('button', {
        class: 'tab' + (!personRoute && t.id === App.tab ? ' on' : ''), text: t.label,
        onclick: function () { App.tab = t.id; location.hash = ''; render(); }
      }));
    });
    tabsHost.appendChild(el('span', { class: 'spacer' }));
    tabsHost.appendChild(el('button', {
      class: 'ghost', text: 'Export GEDCOM',
      title: 'Write this tree as a GEDCOM 7.0 file',
      onclick: function () { exportGedcom(model); }
    }));

    U.clear(host);
    /* The people list wants to run the full window height, so main must stop
       scrolling and let the list's own scroller own the overflow. */
    host.classList.toggle('people-view', !personRoute && App.tab === 'people');
    if (personRoute) { AV.render.person(host, +personRoute[1]); return; }
    if (App.tab === 'summary') AV.render.summary(host);
    else if (App.tab === 'people') AV.render.people(host);
    else if (App.tab === 'families') AV.render.families(host);
    else if (App.tab === 'places') AV.render.places(host);
    else if (App.tab === 'log') AV.render.log(host);
    else if (App.tab === 'inspector') AV.inspector.render(host, model);
  }

  function welcome() {
    return el('div', { class: 'welcome' }, [
      el('h2', { text: 'Open a family history file' }),
      el('p', {}, [
        'Drop a file anywhere on this page, or use the ', el('b', { text: 'Open file' }),
        ' button. Everything is parsed in your browser — nothing is uploaded.'
      ]),
      el('div', { class: 'formats' }, [
        fmtCard('.paf', 'Personal Ancestral File 5',
          'FamilySearch’s discontinued genealogy program. Undocumented binary format, ' +
          'reverse-engineered here: names, sex, birth, christening, death, burial, ' +
          'marriages, children and notes.'),
        fmtCard('.rmtree', 'RootsMagic database',
          'A SQLite database with a custom RMNOCASE collation that stops most SQLite ' +
          'tools. Read here with a built-in page-level reader, so it just opens.'),
        fmtCard('.pal', 'PAF activity log',
          'The plain-text edit log that sits beside a .paf file. Opens on its ' +
          'own as an Activity log; it holds no genealogy.'),
        fmtCard('.ged', 'GEDCOM 7.0',
          'The genealogy interchange standard, read and written here. Sources ' +
          'and repositories, per-fact citations, and — as documented extension ' +
          'tags — the living flag and the record of any merge conflicts.')
      ])
    ]);
  }
  function fmtCard(ext, title, body) {
    return el('div', { class: 'fcard' }, [
      el('code', { text: ext }), el('h4', { text: title }), el('p', { text: body })
    ]);
  }

  function setStatus(msg, isErr) {
    var s = U.$('#status');
    s.textContent = msg || '';
    s.style.display = msg ? 'block' : 'none';
    s.classList.toggle('error', !!isErr);
  }

  /* A small transient popup for one-off notices that shouldn't take up a
     permanent strip of the window, like "this file is already open". */
  function toast(msg) {
    var host = U.$('#toasts');
    var t = el('div', { class: 'toast', text: msg });
    host.appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () {
        if (t.parentNode) t.parentNode.removeChild(t);
      }, 300);
    }, 4500);
  }

  function fileChip() {
    var f = App.file;
    return el('div', { class: 'filetab on', title: f.name }, [
      el('span', { class: 'fmt ' + f.model.source.format, text: f.model.source.format }),
      el('span', { class: 'fname', text: f.name }),
      el('span', {
        class: 'fclose', role: 'button', tabindex: '0',
        title: 'Close ' + f.name, 'aria-label': 'Close ' + f.name, text: '×',
        onclick: closeFile,
        onkeydown: function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeFile(); }
        }
      })
    ]);
  }

  /* --------------------------------------------------------------- export */
  function download(text, filename, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function exportGedcom(model) {
    var text = AV.gedcom.build(model);
    var check = AV.gedcom.validate(text);
    var base = (model.source.filename || 'export').replace(/\.[^.]+$/, '');
    download(text, base + '.ged', 'text/plain;charset=utf-8');
    setStatus('Exported ' + check.individuals + ' individuals, ' + check.families +
      ' families' + (check.sources ? ' and ' + check.sources + ' sources' : '') +
      (check.conflicts ? ', with ' + check.conflicts + ' recorded conflicts' : '') +
      ' to ' + base + '.ged as GEDCOM ' + check.version +
      (check.problems.length ? ' — ' + check.problems.length + ' structural warnings' : ' (structure validated)'));
  }

  /* ----------------------------------------------------------------- boot */
  function init() {
    U.$('#picker').addEventListener('change', function (e) {
      openFile(e.target.files);
      e.target.value = '';
    });
    U.$('#openBtn').addEventListener('click', function () { U.$('#picker').click(); });
    U.$('#mergePicker').addEventListener('change', function (e) {
      mergeFiles(e.target.files);
      e.target.value = '';
    });
    U.$('#mergeBtn').addEventListener('click', function () { U.$('#mergePicker').click(); });
    var drop = document.body;
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); document.body.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        if (ev === 'dragleave' && e.relatedTarget) return;
        document.body.classList.remove('dragging');
      });
    });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
    });
    window.addEventListener('hashchange', render);
    setStatus('');
    render();
  }

  AV.app = {
    init: init, load: loadFiles, open: openFile, merge: mergeFiles,
    state: App, parseBuffer: parseBuffer, sniff: sniff
  };
  window.AV = AV;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(AV);
