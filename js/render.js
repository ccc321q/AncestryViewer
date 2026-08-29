/* render.js - all the views: people list, person detail, pedigree chart,
   descendant tree, families, places and the activity log. */
var AV = window.AV || {};
(function (AV) {
  'use strict';
  var U = AV.util, el = U.el, svg = U.svg;

  var R = {
    model: null,
    current: 0,
    filtered: [],
    sortBy: 'name',
    sortDir: 1,
    query: '',
    place: null,
    gens: 30                 // ancestor chart depth; 30 == "All" (see GEN_LIMIT)
  };

  function yearOf(ev) { return ev && ev.date && ev.date.year ? ev.date.year : ''; }
  function lifespan(p) {
    var b = yearOf(p.birth), d = yearOf(p.death);
    if (!b && !d) return '';
    return (b || '?') + '–' + (d || (p.living ? '' : '?'));
  }
  function sexClass(p) { return p.sex === 'M' ? 'male' : (p.sex === 'F' ? 'female' : 'unknown'); }

  function personLink(id, extra) {
    var p = R.model.people.get(id);
    if (!p) return el('span', { class: 'muted', text: '#' + id });
    return el('a', {
      href: '#/person/' + id, class: 'plink ' + sexClass(p),
      title: p.fullName + ' ' + lifespan(p)
    }, [p.fullName + (extra && lifespan(p) ? ' (' + lifespan(p) + ')' : '')]);
  }

  /* Places link through to the Places tab. The handler stops propagation
     because some of these sit inside rows that navigate to a person. */
  function placeLink(name) {
    if (!name) return el('span', { class: 'muted', text: '' });
    return el('a', {
      href: '#/place/' + encodeURIComponent(name),
      class: 'placelink', title: 'See everything recorded at ' + name,
      onclick: function (e) {
        e.preventDefault();
        e.stopPropagation();
        location.hash = '#/place/' + encodeURIComponent(name);
      }
    }, [name]);
  }

  /* Formats that record provenance (currently .ged) hang source ids off each
     fact. Render them as superscript markers that link out to the source. */
  function citations(ids) {
    var m = R.model;
    if (!ids || !ids.length || !m.sources.size) return null;
    var sup = el('sup', { class: 'cite' });
    ids.forEach(function (sid, i) {
      var s = m.sources.get(sid);
      if (!s) return;
      if (i) sup.appendChild(document.createTextNode(','));
      var label = s.title || s.id;
      sup.appendChild(s.url
        ? el('a', {
            href: s.url, target: '_blank', rel: 'noopener noreferrer',
            title: label + (s.retrieved ? ' — retrieved ' + s.retrieved : ''),
            text: s.id
          })
        : el('span', { title: label, text: s.id }));
    });
    return sup.childNodes.length ? sup : null;
  }

  /* Every source id cited anywhere on a person, in first-seen order. */
  function sourcesOf(p) {
    var m = R.model, seen = [], out = [];
    function add(ids) {
      (ids || []).forEach(function (sid) {
        if (seen.indexOf(sid) >= 0) return;
        seen.push(sid);
        var s = m.sources.get(sid);
        if (s) out.push(s);
      });
    }
    add(p.sources);
    p.events.forEach(function (e) { add(e.sources); });
    return out;
  }

  function sourcesCard(p) {
    var items = sourcesOf(p);
    if (!items.length) return null;
    var card = el('div', { class: 'card' }, [el('h3', { text: 'Sources' })]);
    items.forEach(function (s) {
      var meta = [s.repository, s.retrieved ? 'retrieved ' + s.retrieved : '', s.reliability]
        .filter(Boolean).join(' · ');
      card.appendChild(el('div', { class: 'source' }, [
        el('span', { class: 'src-id', text: s.id }),
        el('span', { class: 'src-body' }, [
          s.url
            ? el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer',
                        text: s.title || s.url })
            : el('span', { text: s.title || '(untitled source)' }),
          meta ? el('div', { class: 'muted small', text: meta }) : null
        ])
      ]));
    });
    return card;
  }

  /* ---------------------------------------------------------------- people */
  function applyFilter() {
    var q = R.query.trim().toLowerCase();
    var out = [];
    R.model.people.forEach(function (p) {
      if (!q || p.searchKey.indexOf(q) >= 0) out.push(p);
    });
    var by = R.sortBy, dir = R.sortDir;
    out.sort(function (a, b) {
      var x, y;
      if (by === 'id') { x = a.id; y = b.id; }
      else if (by === 'birth') { x = (a.birth ? a.birth.date.sort : 0); y = (b.birth ? b.birth.date.sort : 0); }
      else if (by === 'death') { x = (a.death ? a.death.date.sort : 0); y = (b.death ? b.death.date.sort : 0); }
      else if (by === 'sex') { x = a.sex || 'z'; y = b.sex || 'z'; }
      else { x = a.sortKey; y = b.sortKey; }
      if (x < y) return -dir;
      if (x > y) return dir;
      return a.id - b.id;
    });
    R.filtered = out;
  }

  /* A windowed table: only the rows near the viewport are in the DOM, which
     keeps a 2 000-person list responsive. */
  function renderPeople(host) {
    var ROW = 30, PAD = 12;
    /* The shell is built once. Typing only re-runs refresh(), so the <input>
       the user is typing into is never torn down and keeps the caret. */
    var input = el('input', {
      type: 'search', class: 'search',
      placeholder: 'Search names, places, dates, record numbers…',
      value: R.query,
      oninput: function (e) { R.query = e.target.value; scroller.scrollTop = 0; refresh(); }
    });
    var countEl = el('span', { class: 'count' });
    var head = el('div', { class: 'toolbar' }, [input, countEl]);
    var cols = [
      { key: 'id', label: '#', cls: 'c-id' },
      { key: 'name', label: 'Name', cls: 'c-name' },
      { key: 'sex', label: 'Sex', cls: 'c-sex' },
      { key: 'birth', label: 'Born', cls: 'c-date' },
      { key: 'death', label: 'Died', cls: 'c-date' },
      { key: null, label: 'Birthplace', cls: 'c-place' }
    ];
    var headCells = cols.map(function (c) {
      return el('span', {
        class: c.cls + (c.key ? ' sortable' : ''),
        onclick: c.key ? function () {
          if (R.sortBy === c.key) R.sortDir = -R.sortDir; else { R.sortBy = c.key; R.sortDir = 1; }
          scroller.scrollTop = 0;
          refresh();
        } : null
      });
    });
    var headRow = el('div', { class: 'trow thead' }, headCells);
    function paintHeader() {
      cols.forEach(function (c, i) {
        var on = R.sortBy === c.key;
        headCells[i].textContent = c.label + (on ? (R.sortDir > 0 ? ' ▲' : ' ▼') : '');
        headCells[i].classList.toggle('sorted', !!on);
      });
    }

    var spacer = el('div', { class: 'vspacer' });
    var body = el('div', { class: 'vbody' });
    var scroller = el('div', { class: 'vscroll' }, [spacer, body]);

    /* .people-fill makes the list run the full height of the window (see
       main.people-view in app.css); without a file it is just a plain view. */
    var fill = el('div', { class: 'people-fill' }, [
      head,
      el('div', { class: 'table' }, [headRow, scroller])
    ]);
    U.clear(host);
    host.appendChild(fill);

    function refresh() {
      applyFilter();
      paintHeader();
      countEl.textContent = R.filtered.length + ' of ' + R.model.people.size + ' people';
      spacer.style.height = (R.filtered.length * ROW) + 'px';
      draw();
    }

    function draw() {
      var top = scroller.scrollTop;
      var first = Math.max(0, Math.floor(top / ROW) - PAD);
      var last = Math.min(R.filtered.length, first + Math.ceil(scroller.clientHeight / ROW) + PAD * 2);
      U.clear(body);
      body.style.transform = 'translateY(' + (first * ROW) + 'px)';
      for (var i = first; i < last; i++) {
        var p = R.filtered[i];
        body.appendChild(el('div', {
          class: 'trow', 'data-id': p.id,
          onclick: (function (id) { return function () { location.hash = '#/person/' + id; }; })(p.id)
        }, [
          el('span', { class: 'c-id muted', text: String(p.id) }),
          el('span', { class: 'c-name ' + sexClass(p), text: p.fullName }),
          el('span', { class: 'c-sex', text: p.sex || '–' }),
          el('span', { class: 'c-date', text: p.birth ? p.birth.date.display : '' }),
          el('span', { class: 'c-date', text: p.death ? p.death.date.display : '' }),
          el('span', { class: 'c-place' }, [p.birth ? placeLink(p.birth.place) : null])
        ]));
      }
    }
    scroller.addEventListener('scroll', draw);
    refresh();
  }

  /* ---------------------------------------------------------------- person */
  function renderPerson(host, id) {
    var m = R.model, p = m.people.get(id);
    U.clear(host);
    if (!p) { host.appendChild(el('p', { class: 'empty', text: 'No such person.' })); return; }
    R.current = id;

    var header = el('div', { class: 'person-head' }, [
      el('h2', {}, [
        (p.prefix ? p.prefix + ' ' : '') + p.fullName + (p.suffix ? ' ' + p.suffix : ''),
        el('span', { class: 'badge ' + sexClass(p), text: p.sex || '?' })
      ]),
      el('div', { class: 'sub' }, [
        el('span', { class: 'muted', text: 'Record ' + p.id }),
        p.nickname ? el('span', { text: '“' + p.nickname + '”' }) : null,
        lifespan(p) ? el('span', { text: lifespan(p) }) : null
      ]),
      p.altNames.length ? el('div', { class: 'sub muted', text: 'Also known as: ' + p.altNames.join('; ') }) : null
    ]);

    var events = el('div', { class: 'card' }, [el('h3', { text: 'Events' })]);
    if (!p.events.length) events.appendChild(el('p', { class: 'empty', text: 'No events recorded.' }));
    p.events.forEach(function (e) {
      events.appendChild(el('div', { class: 'event' }, [
        el('span', { class: 'ev-label', text: e.label }),
        el('span', { class: 'ev-date', text: e.date.display || '–' }),
        el('span', { class: 'ev-place' }, [placeLink(e.place)]),
        e.detail ? el('span', { class: 'ev-detail', text: e.detail }) : null,
        citations(e.sources)
      ]));
    });

    var fam = el('div', { class: 'card' }, [el('h3', { text: 'Family' })]);
    var father = m.fatherOf(id), mother = m.motherOf(id);
    var parentsRow = el('div', { class: 'rel' }, [el('span', { class: 'rel-label', text: 'Parents' })]);
    if (father || mother) {
      if (father) parentsRow.appendChild(personLink(father, true));
      if (father && mother) parentsRow.appendChild(el('span', { class: 'amp', text: '&' }));
      if (mother) parentsRow.appendChild(personLink(mother, true));
    } else parentsRow.appendChild(el('span', { class: 'muted', text: 'unknown' }));
    fam.appendChild(parentsRow);

    p.fams.forEach(function (fid) {
      var f = m.families.get(fid);
      if (!f) return;
      var sp = f.husband === id ? f.wife : f.husband;
      var box = el('div', { class: 'union' }, [
        el('div', { class: 'rel' }, [
          el('span', { class: 'rel-label', text: 'Spouse' }),
          sp ? personLink(sp, true) : el('span', { class: 'muted', text: 'unknown' }),
          el('span', { class: 'muted small', text: 'family ' + fid })
        ])
      ]);
      f.events.forEach(function (e) {
        box.appendChild(el('div', { class: 'event indent' }, [
          el('span', { class: 'ev-label', text: e.label }),
          el('span', { class: 'ev-date', text: e.date.display || '–' }),
          el('span', { class: 'ev-place' }, [placeLink(e.place)]),
          e.detail ? el('span', { class: 'ev-detail', text: e.detail }) : null,
          citations(e.sources)
        ]));
      });
      if (f.children.length) {
        var kids = el('div', { class: 'rel indent' }, [
          el('span', { class: 'rel-label', text: 'Children' })
        ]);
        var list = el('ol', { class: 'kids' });
        f.children.forEach(function (c) { list.appendChild(el('li', {}, [personLink(c, true)])); });
        kids.appendChild(list);
        box.appendChild(kids);
      }
      f.notes.forEach(function (n) {
        box.appendChild(el('pre', { class: 'note indent', text: n }));
      });
      fam.appendChild(box);
    });

    var notes = null;
    if (p.notes.length) {
      notes = el('div', { class: 'card' }, [el('h3', { text: 'Notes' })]);
      p.notes.forEach(function (n) { notes.appendChild(el('pre', { class: 'note', text: n })); });
    }

    var charts = ancestorCard(id);
    var desc = el('div', { class: 'card' }, [
      el('h3', { text: 'Descendants' }),
      el('div', { class: 'chart-controls' }, [
        el('button', {
          class: 'subtab', text: 'Full screen',
          title: 'Show the whole descendant tree in a large popup',
          onclick: function () {
            openPopup('Descendants of ' + p.fullName, descendantTree(id, { expandAll: true }));
          }
        })
      ]),
      descendantTree(id)
    ]);

    var sources = sourcesCard(p);

    host.appendChild(header);
    host.appendChild(events);
    host.appendChild(fam);
    if (notes) host.appendChild(notes);
    if (sources) host.appendChild(sources);
    host.appendChild(charts);
    host.appendChild(desc);
  }

  /* ------------------------------------------------------- ancestor chart */
  var GEN_LIMIT = 30;              // hard stop, independent of what the user picks
  var BOXW = 190, BOXH = 34, GAPX = 34, GAPY = 8, ROW = BOXH + GAPY;

  /* A compact tidy layout: a row is spent only on an ancestor that actually
     exists, so the chart is as deep as the tree really goes without the
     2^generations blow-up of a fixed grid. */
  function buildAncestors(rootId, maxGens) {
    var m = R.model, count = 0, depth = 0, row = 0;

    function build(id, gen, path) {
      var node = { id: id, gen: gen, father: null, mother: null, y: 0 };
      count++;
      if (gen > depth) depth = gen;
      if (gen + 1 >= maxGens || gen + 1 >= GEN_LIMIT) return node;
      var f = m.fatherOf(id), mo = m.motherOf(id);
      // A cyclic parent link would otherwise recurse forever.
      if (f && path.has(f)) f = 0;
      if (mo && path.has(mo)) mo = 0;
      if (!f && !mo) return node;
      var next = new Set(path);
      if (f) next.add(f);
      if (mo) next.add(mo);
      // Only show an "unknown" stub when the other half of the couple is known.
      node.father = f ? build(f, gen + 1, next) : { id: 0, gen: gen + 1 };
      node.mother = mo ? build(mo, gen + 1, next) : { id: 0, gen: gen + 1 };
      return node;
    }

    function place(node) {
      var kids = [node.father, node.mother].filter(Boolean);
      if (!kids.length) { node.y = row * ROW + ROW / 2; row++; return; }
      kids.forEach(place);
      node.y = (kids[0].y + kids[kids.length - 1].y) / 2;
    }

    var root = build(rootId, 0, new Set([rootId]));
    place(root);
    return { root: root, count: count, depth: depth + 1, rows: row };
  }

  function ancestorChart(rootId, maxGens) {
    var m = R.model;
    var tree = buildAncestors(rootId, maxGens);
    var width = tree.depth * (BOXW + GAPX) - GAPX;
    var height = Math.max(tree.rows, 1) * ROW;
    var g = svg('g', {});

    var links = [], boxes = [];
    (function collect(node, childY) {
      var x = node.gen * (BOXW + GAPX);
      if (childY !== null) links.push({ gen: node.gen, x: x, y: node.y, childY: childY });
      boxes.push({ id: node.id, x: x, y: node.y });
      if (node.father) collect(node.father, node.y);
      if (node.mother) collect(node.mother, node.y);
    })(tree.root, null);

    // connectors first, so the boxes sit on top of them
    links.forEach(function (n) {
      var px = (n.gen - 1) * (BOXW + GAPX) + BOXW;
      var midX = px + GAPX / 2;
      g.appendChild(svg('path', {
        class: 'ped-link',
        d: 'M' + px + ',' + n.childY + ' H' + midX + ' V' + n.y + ' H' + n.x
      }));
    });

    boxes.forEach(function (n) {
      if (!n.id) {
        g.appendChild(svg('rect', {
          class: 'ped-box empty', x: n.x, y: n.y - BOXH / 2,
          width: BOXW, height: BOXH, rx: 4
        }));
        return;
      }
      var p = m.people.get(n.id);
      if (!p) return;
      var box = svg('g', {
        class: 'ped-node ' + sexClass(p),
        onclick: (function (id) { return function () { location.hash = '#/person/' + id; }; })(n.id)
      });
      box.appendChild(svg('rect', { class: 'ped-box', x: n.x, y: n.y - BOXH / 2, width: BOXW, height: BOXH, rx: 4 }));
      box.appendChild(svg('text', { class: 'ped-name', x: n.x + 8, y: n.y - 2, text: trim(p.fullName, 26) }));
      box.appendChild(svg('text', { class: 'ped-years', x: n.x + 8, y: n.y + 11, text: lifespan(p) }));
      box.appendChild(svg('title', { text: p.fullName + ' ' + lifespan(p) }));
      g.appendChild(box);
    });

    // natural pixel size, so the chart scrolls instead of shrinking to fit
    var s = svg('svg', {
      class: 'pedigree', width: width, height: height,
      viewBox: '0 0 ' + width + ' ' + height
    }, [g]);
    return { node: el('div', { class: 'chart-scroll' }, [s]), tree: tree };
  }

  /* The whole ancestry card: chart plus its generation control. */
  function ancestorCard(rootId) {
    var card = el('div', { class: 'card' });
    var heading = el('h3', {});
    var controls = el('div', { class: 'chart-controls' });
    var holder = el('div', {});
    card.appendChild(heading);
    card.appendChild(controls);
    card.appendChild(holder);

    var CHOICES = [
      { label: 'All', value: GEN_LIMIT },
      { label: '4', value: 4 }, { label: '6', value: 6 }, { label: '8', value: 8 }
    ];

    function paint() {
      var built = ancestorChart(rootId, R.gens);
      U.clear(holder);
      holder.appendChild(built.node);
      U.clear(heading);
      heading.appendChild(document.createTextNode('Ancestors'));
      heading.appendChild(el('span', {
        class: 'muted small',
        text: ' — ' + (built.tree.count - 1) + ' recorded over ' + built.tree.depth +
              ' generations · click a box to re-root'
      }));
      Array.prototype.forEach.call(controls.children, function (b, i) {
        if (i < CHOICES.length) b.classList.toggle('on', CHOICES[i].value === R.gens);
      });
    }

    CHOICES.forEach(function (c) {
      controls.appendChild(el('button', {
        class: 'subtab', text: c.label, title: c.label === 'All' ? 'Show every generation' : c.label + ' generations',
        onclick: function () { R.gens = c.value; paint(); }
      }));
    });
    controls.appendChild(el('button', {
      class: 'subtab', text: 'Full screen',
      title: 'Show the complete ancestry chart in a large popup',
      onclick: function () {
        var built = ancestorChart(rootId, GEN_LIMIT);
        var rp = R.model.people.get(rootId);
        openPopup('Ancestors of ' + (rp ? rp.fullName : '#' + rootId), built.node);
      }
    }));
    paint();
    return card;
  }

  function trim(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  /* An expandable branch tree: every person with recorded children gets a
     toggle, and only the top level is open at first. With {expandAll} every
     branch starts open — that is what the full-screen popup uses. */
  function descendantTree(rootId, opts) {
    opts = opts || {};
    var m = R.model;
    function node(id, level, seen) {
      var p = m.people.get(id);
      if (!p) return null;
      var li = el('li', { class: 'tree-node' });
      var row = el('div', { class: 'tree-row' }, [
        personLink(id, true),
        p.sex ? el('span', { class: 'muted small', text: p.sex }) : null
      ]);
      li.appendChild(row);
      var kids = m.childrenOf(id);
      if (!kids.length || seen.has(id)) return li;
      seen.add(id);
      var ul = el('ul');
      kids.forEach(function (c) {
        var n = node(c, level + 1, seen);
        if (n) ul.appendChild(n);
      });
      if (!ul.childNodes.length) return li;
      var open = level === 0 || !!opts.expandAll;
      var btn = el('button', {
        class: 'tree-toggle', text: open ? '▾' : '▸',
        title: open ? 'Collapse branch' : 'Expand branch',
        onclick: function () {
          var nowOpen = li.classList.toggle('open');
          btn.textContent = nowOpen ? '▾' : '▸';
          btn.title = nowOpen ? 'Collapse branch' : 'Expand branch';
        }
      });
      row.insertBefore(btn, row.firstChild);
      if (open) li.classList.add('open');
      li.appendChild(ul);
      return li;
    }
    var root = node(rootId, 0, new Set());
    var kids = m.childrenOf(rootId);
    if (!kids.length) return el('p', { class: 'empty', text: 'No recorded children.' });
    return el('ul', { class: 'tree' }, [root]);
  }

  /* ------------------------------------------------------------- families */
  function renderFamilies(host) {
    var m = R.model;
    U.clear(host);
    if (!m.families.size) {
      host.appendChild(el('p', { class: 'empty', text: 'This file records no families.' }));
      return;
    }
    function marr(f) { return f.events.find(function (e) { return e.tag === 'MARR'; }); }
    var built = sortableTable([
      { key: 'id', label: '#', cls: 'c-id', val: function (f) { return f.id; } },
      { key: 'husband', label: 'Husband', cls: 'c-name', val: function (f) { return f.husband ? m.nameOf(f.husband) : ''; } },
      { key: 'wife', label: 'Wife', cls: 'c-name', val: function (f) { return f.wife ? m.nameOf(f.wife) : ''; } },
      { key: 'married', label: 'Married', cls: 'c-date', val: function (f) { var e = marr(f); return e ? e.date.sort : 0; } },
      { key: 'place', label: 'Place', cls: 'c-place', val: function (f) { var e = marr(f); return e && e.place ? e.place : ''; } },
      { key: 'children', label: 'Children', cls: 'c-id', val: function (f) { return f.children.length; } }
    ], Array.from(m.families.values()), function (f) {
      var e = marr(f);
      return el('div', { class: 'trow' }, [
        el('span', { class: 'c-id muted', text: String(f.id) }),
        el('span', { class: 'c-name' }, [f.husband ? personLink(f.husband) : el('span', { class: 'muted', text: '–' })]),
        el('span', { class: 'c-name' }, [f.wife ? personLink(f.wife) : el('span', { class: 'muted', text: '–' })]),
        el('span', { class: 'c-date', text: e ? e.date.display : '' }),
        el('span', { class: 'c-place' }, [e ? placeLink(e.place) : null]),
        el('span', { class: 'c-id', text: String(f.children.length) })
      ]);
    });
    host.appendChild(built.table);
  }

  /* --------------------------------------------------------------- places */
  var USE_CAP = 500;   // a single place can carry 200+ events; cap the rendered list

  function renderPlaces(host) {
    var m = R.model;
    U.clear(host);

    /* Record where every use comes from, not just how many there are. */
    var usage = new Map();
    function add(name, entry) {
      if (!name) return;
      if (!usage.has(name)) usage.set(name, []);
      usage.get(name).push(entry);
    }
    m.people.forEach(function (p) {
      p.events.forEach(function (e) {
        add(e.place, { ownerType: 'person', id: p.id, label: e.label, date: e.date });
      });
    });
    m.families.forEach(function (f) {
      f.events.forEach(function (e) {
        add(e.place, { ownerType: 'family', id: f.id, label: e.label, date: e.date });
      });
    });
    m.places.forEach(function (pl) { if (!usage.has(pl.name)) usage.set(pl.name, []); });

    if (!usage.size) {
      host.appendChild(el('p', { class: 'empty', text: 'No places recorded.' }));
      return;
    }
    var items = Array.from(usage.entries());
    var panel = el('div', { class: 'place-panel' });
    var built = sortableTable([
      { key: 'place', label: 'Place', cls: 'c-place', val: function (r) { return r[0]; } },
      { key: 'uses', label: 'Uses', cls: 'c-id', val: function (r) { return r[1].length; } }
    ], items, function (r) {
      return el('div', {
        class: 'trow', 'data-name': r[0],
        onclick: function () { select(r[0]); }
      }, [
        el('span', { class: 'c-place wide', text: r[0] }),
        el('span', { class: 'c-id', text: String(r[1].length) })
      ]);
    }, { by: 'uses', dir: -1, tableClass: 'table plain clickable' });
    var table = built.table;

    function select(name, reveal) {
      R.place = name;
      Array.prototype.forEach.call(table.querySelectorAll('.trow[data-name]'), function (node) {
        node.classList.toggle('sel', node.getAttribute('data-name') === name);
      });
      U.clear(panel);
      if (!usage.has(name)) {
        panel.appendChild(el('div', { class: 'card warn' }, [
          el('h3', { text: name }),
          el('p', { text: 'This place is not recorded in ' + (R.model.source.filename || 'this file') + '.' })
        ]));
        return;
      }
      panel.appendChild(usesCard(name, usage.get(name)));
      // the list runs to hundreds of rows, so bring the selection into view
      if (reveal) {
        var node = null;
        Array.prototype.forEach.call(table.querySelectorAll('.trow[data-name]'), function (n) {
          if (n.getAttribute('data-name') === name) node = n;
        });
        if (node) node.scrollIntoView({ block: 'center' });
      }
    }

    host.appendChild(el('p', { class: 'muted', text: items.length + ' distinct places — click one to see its uses.' }));
    host.appendChild(panel);
    host.appendChild(table);
    if (R.place) select(R.place, true);
  }

  function usesCard(name, uses) {
    var m = R.model;
    var card = el('div', { class: 'card' }, [
      el('h3', {}, [name, el('span', { class: 'muted small', text: ' — ' + uses.length + (uses.length === 1 ? ' use' : ' uses') })])
    ]);
    if (!uses.length) {
      card.appendChild(el('p', { class: 'empty', text: 'Recorded in this file but not attached to any event.' }));
      return card;
    }
    var sorted = uses.slice().sort(function (a, b) {
      return (a.date.sort || 0) - (b.date.sort || 0) ||
             m.nameOf(a.id).localeCompare(m.nameOf(b.id));
    });
    sorted.slice(0, USE_CAP).forEach(function (u) {
      var who;
      if (u.ownerType === 'family') {
        var f = m.families.get(u.id) || {};
        who = el('span', {}, [
          f.husband ? personLink(f.husband) : el('span', { class: 'muted', text: '?' }),
          el('span', { class: 'amp', text: '&' }),
          f.wife ? personLink(f.wife) : el('span', { class: 'muted', text: '?' })
        ]);
      } else {
        who = personLink(u.id, true);
      }
      card.appendChild(el('div', { class: 'use' }, [
        el('span', { class: 'use-who' }, [who]),
        el('span', { class: 'use-label', text: u.label }),
        el('span', { class: 'use-date', text: u.date.display || '' })
      ]));
    });
    if (sorted.length > USE_CAP) {
      card.appendChild(el('p', { class: 'muted', text: '…and ' + (sorted.length - USE_CAP) + ' more.' }));
    }
    return card;
  }

  /* ------------------------------------------------------------------ log */
  function renderLog(host) {
    var m = R.model;
    U.clear(host);
    var built = sortableTable([
      { key: 'date', label: 'Date', cls: 'c-date', val: function (r) { return r.date ? r.date.sort : 0; } },
      { key: 'time', label: 'Time', cls: 'c-sex', val: function (r) { return r.time || ''; } },
      { key: 'action', label: 'Action', cls: 'c-name', val: function (r) { return r.action || r.raw || ''; } },
      { key: 'object', label: 'Object', cls: 'c-name', val: function (r) { return r.object || ''; } },
      { key: 'record', label: 'Record', cls: 'c-id', val: function (r) {
        return r.ref === null || r.ref === undefined ? '' : String(r.ref);
      } }
    ], m.log, function (r) {
      return el('div', { class: 'trow' }, [
        el('span', { class: 'c-date', text: r.date ? r.date.display : '' }),
        el('span', { class: 'c-sex', text: r.time || '' }),
        el('span', { class: 'c-name', text: r.action || r.raw }),
        el('span', { class: 'c-name', text: r.object || '' }),
        el('span', { class: 'c-id', text: r.ref === null || r.ref === undefined ? '' : String(r.ref) })
      ]);
    });
    host.appendChild(el('p', { class: 'muted', text: m.log.length + ' log entries.' }));
    host.appendChild(built.table);
  }

  /* -------------------------------------------------------------- summary */
  function renderSummary(host) {
    var m = R.model;
    U.clear(host);
    var s = m.stats;
    var cards = el('div', { class: 'stats' }, [
      stat(s.people, 'people'), stat(s.families, 'families'),
      stat(s.events, 'events'), stat(s.places, 'places'),
      s.sources ? stat(s.sources, 'sources') : null,
      m.log.length ? stat(m.log.length, 'log entries') : null
    ]);
    var meta = el('div', { class: 'card' }, [
      el('h3', { text: 'File' }),
      kv('Name', m.source.filename),
      kv('Format', m.source.formatLabel || m.source.format),
      kv('Size', U.fmtSize(m.source.size || 0)),
      kv('Details', m.source.version || '')
    ]);
    var notes = el('div', { class: 'card' }, [el('h3', { text: 'What was read' })]);
    (m.source.notes || []).forEach(function (n) { notes.appendChild(el('p', { text: n })); });
    if (m.warnings.length) {
      var w = el('div', { class: 'card warn' }, [el('h3', { text: 'Caveats' })]);
      m.warnings.forEach(function (n) { w.appendChild(el('p', { text: n })); });
      notes.appendChild(w);
    }
    // a couple of useful entry points
    var roots = el('div', { class: 'card' }, [el('h3', { text: 'Largest families' })]);
    var fams = Array.from(m.families.values())
      .sort(function (a, b) { return b.children.length - a.children.length; }).slice(0, 8);
    if (!fams.length) roots.appendChild(el('p', { class: 'empty', text: 'None.' }));
    fams.forEach(function (f) {
      roots.appendChild(el('div', { class: 'rel' }, [
        f.husband ? personLink(f.husband) : el('span', { class: 'muted', text: '?' }),
        el('span', { class: 'amp', text: '&' }),
        f.wife ? personLink(f.wife) : el('span', { class: 'muted', text: '?' }),
        el('span', { class: 'muted small', text: f.children.length + ' children' })
      ]));
    });
    host.appendChild(cards);
    host.appendChild(meta);
    host.appendChild(notes);
    host.appendChild(roots);
  }
  function stat(n, label) {
    return el('div', { class: 'stat' }, [
      el('div', { class: 'stat-n', text: String(n === undefined ? 0 : n) }),
      el('div', { class: 'stat-l', text: label })
    ]);
  }
  function kv(k, v) {
    return el('div', { class: 'kv' }, [
      el('span', { class: 'k', text: k }), el('span', { class: 'v', text: String(v || '–') })
    ]);
  }

  /* -------------------------------------------------------------- popups */
  var popup = null;
  function closePopup() {
    if (!popup) return;
    popup.teardown();
    popup = null;
  }
  function openPopup(title, bodyNode) {
    closePopup();
    var overlay = el('div', { class: 'popup-overlay' });
    var box = el('div', { class: 'popup' }, [
      el('div', { class: 'popup-bar' }, [
        el('h3', { text: title }),
        el('button', { class: 'popup-close', text: '×', title: 'Close (Esc)', onclick: close })
      ]),
      el('div', { class: 'popup-body' }, [bodyNode])
    ]);
    overlay.appendChild(box);
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() {
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      popup = null;
    }
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    popup = { teardown: close };
  }

  /* A table whose column headers all sort their rows. `col` objects are
     {key, label, cls, val(item)}; val supplies the value to compare. */
  function sortableTable(cols, items, rowFactory, opts) {
    opts = opts || {};
    var st = { by: opts.by || cols[0].key, dir: opts.dir === undefined ? 1 : opts.dir };
    var body = el('div', { class: 'tbody' });
    var headCells = cols.map(function (c) {
      return el('span', {
        class: (c.cls || '') + ' sortable',
        title: 'Sort by ' + c.label.toLowerCase(),
        onclick: function () {
          if (st.by === c.key) st.dir = -st.dir;
          else { st.by = c.key; st.dir = 1; }
          paint();
        }
      });
    });
    function paint() {
      headCells.forEach(function (h, i) {
        var on = cols[i].key === st.by;
        h.textContent = cols[i].label + (on ? (st.dir > 0 ? ' ▲' : ' ▼') : '');
        h.classList.toggle('sorted', on);
      });
      var col = cols[0];
      cols.forEach(function (c) { if (c.key === st.by) col = c; });
      var sorted = items.slice().sort(function (a, b) {
        var x = col.val(a), y = col.val(b);
        if (x < y) return -st.dir;
        if (x > y) return st.dir;
        return 0;
      });
      U.clear(body);
      sorted.forEach(function (it) { body.appendChild(rowFactory(it)); });
    }
    var table = el('div', { class: opts.tableClass || 'table plain' }, [
      el('div', { class: 'trow thead' }, headCells),
      body
    ]);
    paint();
    return { table: table, body: body };
  }

  AV.render = {
    state: R,
    people: renderPeople,
    person: renderPerson,
    families: renderFamilies,
    places: renderPlaces,
    log: renderLog,
    summary: renderSummary,
    personLink: personLink,
    lifespan: lifespan,
    openPopup: openPopup,
    closePopup: closePopup
  };
  window.AV = AV;
})(AV);
