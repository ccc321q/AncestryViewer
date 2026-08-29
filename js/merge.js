/* merge.js - combine several parsed models into one.
   The same family turns up in more than one file: a PAF database and its
   RootsMagic export are the same tree twice over, and a researched GEDCOM
   overlaps both. Stacking them would give four copies of every person, so
   people are matched first and only then merged.

   Matching is deliberately conservative. It never matches on name alone.
 */
var AV = window.AV || {};
(function (AV) {
  'use strict';
  var U = AV.util;

  /* Fold case, accents and punctuation so compare equal. */
  function normName(s) {
    s = String(s == null ? '' : s);
    if (s.normalize) s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function yearOf(ev) { return ev && ev.date && ev.date.year ? ev.date.year : 0; }

  /* "NN", "unknown", "infant" and friends are placeholders, not names. Two
     unnamed children of one couple are two different children, so structural
     evidence alone must not merge them. */
  function isPlaceholder(name) {
    var n = normName(name);
    return !n || /^(nn|n n|unknown|unnamed|infant|stillborn|baby|child|son|daughter|male|female)\b/.test(n);
  }

  function evKey(e) {
    return e.tag + '|' + (e.date.display || '') + '|' + (e.place || '') + '|' + (e.detail || '');
  }

  function pushUnique(arr, v) { if (v && arr.indexOf(v) < 0) arr.push(v); }

  /* --------------------------------------------------------------- merge */
  function models(inputs) {
    inputs = (inputs || []).filter(Boolean);
    if (!inputs.length) throw new Error('Nothing to merge.');
    if (inputs.length === 1) return inputs[0];

    var out = new AV.Model({
      format: 'ged',
      formatLabel: 'Merged tree',
      filename: 'merged.ged',
      size: inputs.reduce(function (n, m) { return n + (m.source.size || 0); }, 0),
      version: inputs.length + ' files merged'
    });
    out.conflicts = [];
    out.mergedFrom = inputs.map(function (m) {
      return {
        filename: m.source.filename,
        format: m.source.formatLabel || m.source.format,
        people: m.people.size,
        families: m.families.size
      };
    });

    var nextId = 0;
    var map = [];                 // per input: old person id -> new person id
    var byNs = {};                // "namespace#key"     -> new id
    var byNameYears = {};         // "name|birth|death"  -> new id
    var byNameYear = {};          // "name|year"         -> [new id, …]
    var byNameParents = {};       // "name|father+mother"-> new id
    var byNameSpouse = {};        // "name|spouse"       -> new id
    var srcMap = [];              // per input: old source id -> new source id

    /* Sources are copied first so facts can point at the new ids. Two files
       citing the same URL share one merged source record. */
    var byUrl = {};
    inputs.forEach(function (m, mi) {
      srcMap[mi] = {};
      m.sources.forEach(function (s, id) {
        var key = s.url || (m.source.filename + '#' + id);
        if (!byUrl[key]) {
          var nid = 'S' + String(Object.keys(byUrl).length + 1);
          byUrl[key] = nid;
          var rec = out.sourceRec(nid);
          rec.title = s.title; rec.url = s.url; rec.repository = s.repository;
          rec.retrieved = s.retrieved; rec.reliability = s.reliability;
        }
        srcMap[mi][id] = byUrl[key];
      });
    });
    function remapSources(mi, ids) {
      return (ids || []).map(function (id) { return srcMap[mi][id] || id; })
        .filter(function (v, i, a) { return a.indexOf(v) === i; });
    }

    function copyPerson(mi, m, p) {
      var np = out.person(++nextId);
      np.given = p.given; np.surname = p.surname; np.prefix = p.prefix;
      np.suffix = p.suffix; np.nickname = p.nickname;
      np.fullName = p.fullName; np.sex = p.sex; np.living = p.living;
      np.altNames = p.altNames.slice();
      np.notes = p.notes.slice();
      np.sources = remapSources(mi, p.sources);
      np.events = p.events.map(function (e) {
        return {
          tag: e.tag, label: e.label, order: e.order, date: e.date,
          place: e.place, detail: e.detail, note: e.note,
          sources: remapSources(mi, e.sources)
        };
      });
      np.origins = [m.source.filename];
      np.fromInput = {}; np.fromInput[mi] = true;
      np.sourceKeys = p.sourceKey ? [m.source.filename + ':' + p.sourceKey] : [];
      return np;
    }

    /* Fold a second sighting of the same person into the record already held.
       Everything is unioned; a vital fact that disagrees is kept as a second
       event and reported, never overwritten. */
    function mergeInto(np, mi, m, p) {
      pushUnique(np.origins, m.source.filename);
      np.fromInput[mi] = true;
      if (p.sourceKey) pushUnique(np.sourceKeys, m.source.filename + ':' + p.sourceKey);
      if (!np.sex) np.sex = p.sex;
      if (!np.nickname) np.nickname = p.nickname;
      if (!np.prefix) np.prefix = p.prefix;
      if (!np.suffix) np.suffix = p.suffix;
      if (p.living) np.living = true;
      if (p.fullName && p.fullName !== np.fullName) pushUnique(np.altNames, p.fullName);
      p.altNames.forEach(function (n) { pushUnique(np.altNames, n); });
      p.notes.forEach(function (n) { pushUnique(np.notes, n); });
      remapSources(mi, p.sources).forEach(function (s) { pushUnique(np.sources, s); });

      var have = {};
      np.events.forEach(function (e) { have[evKey(e)] = e; });
      p.events.forEach(function (e) {
        var ne = {
          tag: e.tag, label: e.label, order: e.order, date: e.date,
          place: e.place, detail: e.detail, note: e.note,
          sources: remapSources(mi, e.sources)
        };
        var k = evKey(ne);
        if (have[k]) {                       // identical fact, just add its source
          ne.sources.forEach(function (s) { pushUnique(have[k].sources, s); });
          return;
        }
        /* Same vital event, different value: keep both and record it so the
           user can be asked which to trust. */
        var clash = np.events.filter(function (x) {
          return x.tag === ne.tag && x.date.display && ne.date.display &&
                 x.date.display !== ne.date.display;
        })[0];
        if (clash) {
          addConflict('person', np.id, np.fullName, ne.label,
                      clash, np.origins.slice(), ne, [m.source.filename]);
        }
        np.events.push(ne);
        have[k] = ne;
      });
    }

    /* A conflict has to be actionable, not just readable: it carries the two
       events themselves so a decision can drop the losing one. */
    function addConflict(ownerType, ownerId, who, label, a, aFrom, b, bFrom) {
      out.conflicts.push({
        id: 'C' + (out.conflicts.length + 1),
        ownerType: ownerType,
        ownerId: ownerId,
        about: who + ' — ' + label,
        who: who,
        tag: a.tag,
        label: label,
        options: [
          { event: a, display: a.date.display, place: a.place || '', origins: aFrom },
          { event: b, display: b.date.display, place: b.place || '', origins: bFrom }
        ],
        issue: aFrom.join(' / ') + ' gives "' + a.date.display + '", ' +
               bFrom.join(' / ') + ' gives "' + b.date.display + '".',
        resolution: null
      });
    }

    /* Who a person's parents are is strong evidence of identity even when no
       dates are recorded, which is the common case in these files. Parent
       names are read from the input model, before any merging. */
    function parentKey(m, p) {
      if (isPlaceholder(p.fullName)) return '';
      var names = m.parentsOf(p.id).map(function (id) {
        return normName(m.nameOf(id));
      }).filter(Boolean).sort();
      if (!names.length) return '';
      return normName(p.fullName) + '|' + names.join('+');
    }

    /* Likewise who they married. Most people who carry no dates at all in
       these files are spouses married into the tree, and their name plus
       their partner's name identifies them where nothing else does. */
    function spouseKey(m, p) {
      if (isPlaceholder(p.fullName)) return '';
      var names = m.spousesOf(p.id).map(function (s) {
        return normName(m.nameOf(s.id));
      }).filter(Boolean).sort();
      if (!names.length) return '';
      return normName(p.fullName) + '|' + names.join('+');
    }

    /* Five passes, strongest evidence first. A person already matched in an
       earlier pass is never reconsidered. */
    inputs.forEach(function (m, mi) {
      map[mi] = {};
      var ns = m.source.idNamespace || '';
      m.people.forEach(function (p, oldId) {
        var by = yearOf(p.birth), dy = yearOf(p.death);
        var name = normName(p.fullName);
        var hit = 0;

        /* A file is its own authority on how many people it holds: if its
           author kept two similar records apart, they stay apart. Matching
           therefore only ever joins records from *different* files. */
        function free(id) {
          return id && !out.people.get(id).fromInput[mi] ? id : 0;
        }

        if (ns && p.sourceKey) {
          var k = ns + '#' + p.sourceKey;
          if (byNs[k]) hit = free(byNs[k]);
        }
        if (!hit && name && by && dy) {
          var k2 = name + '|' + by + '|' + dy;
          if (byNameYears[k2]) hit = free(byNameYears[k2]);
        }
        var pk = parentKey(m, p);
        if (!hit && pk && free(byNameParents[pk])) {
          /* same name and same parents; reject only on a hard date clash */
          var cand = out.people.get(byNameParents[pk]);
          var cby = yearOf(cand.events.filter(function (e) { return e.tag === 'BIRT'; })[0]);
          var cdy = yearOf(cand.events.filter(function (e) { return e.tag === 'DEAT'; })[0]);
          if (!(by && cby && by !== cby) && !(dy && cdy && dy !== cdy)) hit = cand.id;
        }
        var sk = spouseKey(m, p);
        if (!hit && sk && free(byNameSpouse[sk])) {
          var cs = out.people.get(byNameSpouse[sk]);
          var sby = yearOf(cs.events.filter(function (e) { return e.tag === 'BIRT'; })[0]);
          var sdy = yearOf(cs.events.filter(function (e) { return e.tag === 'DEAT'; })[0]);
          if (!(by && sby && by !== sby) && !(dy && sdy && dy !== sdy)) hit = cs.id;
        }
        if (!hit && name && (by || dy)) {
          /* one year only: accept solely when it is unambiguous on both sides */
          var k3 = name + '|' + (by || dy);
          var cands = byNameYear[k3] || [];
          if (cands.length === 1 && free(cands[0])) {
            var other = out.people.get(cands[0]);
            var oby = yearOf(other.birth), ody = yearOf(other.death);
            if (!(by && oby && by !== oby) && !(dy && ody && dy !== ody)) hit = cands[0];
          }
        }

        var np;
        if (hit) { np = out.people.get(hit); mergeInto(np, mi, m, p); }
        else { np = copyPerson(mi, m, p); }
        map[mi][oldId] = np.id;

        /* index the merged record under every key it now answers to */
        if (ns && p.sourceKey) byNs[ns + '#' + p.sourceKey] = np.id;
        var nb = yearOf(np.events.filter(function (e) { return e.tag === 'BIRT'; })[0]);
        var nd = yearOf(np.events.filter(function (e) { return e.tag === 'DEAT'; })[0]);
        var nn = normName(np.fullName);
        if (nn && nb && nd) byNameYears[nn + '|' + nb + '|' + nd] = np.id;
        if (pk && !byNameParents[pk]) byNameParents[pk] = np.id;
        if (sk && !byNameSpouse[sk]) byNameSpouse[sk] = np.id;
        [nb, nd].forEach(function (y) {
          if (!nn || !y) return;
          var key = nn + '|' + y;
          if (!byNameYear[key]) byNameYear[key] = [];
          pushUnique(byNameYear[key], np.id);
        });
      });
    });

    /* Families follow their people: a family is the same family when its
       merged spouse pair is the same. */
    var famBy = {}, famN = 0;
    inputs.forEach(function (m, mi) {
      m.families.forEach(function (f) {
        var from = m.source.filename;
        var h = f.husband ? map[mi][f.husband] : 0;
        var w = f.wife ? map[mi][f.wife] : 0;
        var key = h + '+' + w;
        var nf;
        if (h || w) {
          if (famBy[key]) nf = out.families.get(famBy[key]);
          else { nf = out.family(++famN); nf.husband = h; nf.wife = w; famBy[key] = nf.id; }
        } else {
          nf = out.family(++famN);
        }
        f.children.forEach(function (c) { pushUnique(nf.children, map[mi][c]); });
        f.notes.forEach(function (n) { pushUnique(nf.notes, n); });
        remapSources(mi, f.sources).forEach(function (s) { pushUnique(nf.sources, s); });
        var have = {};
        nf.events.forEach(function (e) { have[evKey(e)] = e; });
        f.events.forEach(function (e) {
          var ne = {
            tag: e.tag, label: e.label, order: e.order, date: e.date,
            place: e.place, detail: e.detail, note: e.note,
            sources: remapSources(mi, e.sources)
          };
          if (have[evKey(ne)]) {
            ne.sources.forEach(function (s) { pushUnique(have[evKey(ne)].sources, s); });
            return;
          }
          /* two files giving different wedding dates is a conflict too */
          var clash = nf.events.filter(function (x) {
            return x.tag === ne.tag && x.date.display && ne.date.display &&
                   x.date.display !== ne.date.display;
          })[0];
          if (clash) {
            var couple = [nf.husband, nf.wife].filter(Boolean)
              .map(function (id) { return out.nameOf(id); }).join(' & ') || 'family ' + nf.id;
            addConflict('family', nf.id, couple, ne.label,
                        clash, (nf.origins || []).slice(), ne, [from]);
          }
          nf.events.push(ne);
          have[evKey(ne)] = ne;
        });
        nf.origins = nf.origins || [];
        pushUnique(nf.origins, from);
      });
    });

    /* places, activity log and the inputs' own caveats all carry over */
    var placeN = 0, seenPlace = {};
    function collect(e) {
      if (!e.place || seenPlace[e.place]) return;
      seenPlace[e.place] = true;
      out.places.set(++placeN, { id: placeN, name: e.place });
    }
    out.people.forEach(function (p) { p.events.forEach(collect); });
    out.families.forEach(function (f) { f.events.forEach(collect); });

    inputs.forEach(function (m) {
      m.log.forEach(function (l) { out.log.push(l); });
      m.warnings.forEach(function (w) {
        pushUnique(out.warnings, m.source.filename + ': ' + w);
      });
    });

    var total = inputs.reduce(function (n, m) { return n + m.people.size; }, 0);
    out.source.notes = [
      'Merged from ' + inputs.length + ' files: ' +
        out.mergedFrom.map(function (f) { return f.filename; }).join(', ') + '.',
      total + ' person records went in and ' + out.people.size + ' came out, so ' +
        (total - out.people.size) + ' were matched as the same people appearing in ' +
        'more than one file.',
      'People are matched on a shared record id within one numbering, or on name ' +
        'plus dates, plus parents, or plus spouse. Name alone is never enough to ' +
        'merge two people.'
    ];
    if (out.conflicts.length) {
      out.warnings.push(out.conflicts.length + ' facts disagree between files; both ' +
        'values are kept and listed under Conflicts.');
    }
    out.raw = { kind: 'merged', inputs: out.mergedFrom, conflicts: out.conflicts };
    return out.finalise();
  }

  /* ------------------------------------------------------------- resolve */
  /* Apply the user's decisions: drop the losing event from its owner and note
     what was chosen. Kept apart from models() so the merge itself stays pure
     and a merge can always be run without anyone being asked anything. */
  function resolve(model, decisions) {
    var applied = 0;
    (model.conflicts || []).forEach(function (c) {
      var pick = decisions ? decisions[c.id] : undefined;
      var owner = c.ownerType === 'family'
        ? model.families.get(c.ownerId)
        : model.people.get(c.ownerId);

      /* A value the user typed, matching neither file. */
      if (pick && typeof pick === 'object') {
        if (!owner) return;
        var a = c.options[0], b = c.options[1];
        var kept = 0;
        [a, b].forEach(function (o) {
          var j = owner.events.indexOf(o.event);
          if (j >= 0) { owner.events.splice(j, 1); kept++; }
        });
        if (!kept) return;
        var tpl = a.event;
        /* No sources: the format's rule is that a fact carries the sources it
           came from, and this one came from the person doing the merge. What
           the files actually said is kept in the note instead. */
        owner.events.push({
          tag: tpl.tag, label: tpl.label, order: tpl.order,
          date: U.parseDateText(pick.date),
          place: (pick.place || '').trim(),
          detail: '', sources: [],
          note: 'Entered while merging. ' + a.origins.join(' / ') + ' gave "' +
                a.display + '", ' + b.origins.join(' / ') + ' gave "' + b.display + '".'
        });
        applied++;
        c.resolvedBy = 'manual';
        c.resolution = 'entered "' + (U.parseDateText(pick.date).display || '(no date)') +
          '"; discarded "' + a.display + '" from ' + a.origins.join(' / ') +
          ' and "' + b.display + '" from ' + b.origins.join(' / ');
        return;
      }

      if (pick !== 0 && pick !== 1) {
        c.resolution = c.resolution || 'both kept';
        c.resolvedBy = c.resolvedBy || 'both';
        return;
      }
      var keep = c.options[pick], drop = c.options[1 - pick];
      if (!owner) return;
      var i = owner.events.indexOf(drop.event);
      if (i >= 0) {
        /* the discarded reading's sources still back the surviving fact */
        (drop.event.sources || []).forEach(function (s) { pushUnique(keep.event.sources, s); });
        owner.events.splice(i, 1);
        applied++;
      }
      c.resolvedBy = 'file';
      c.resolution = 'kept "' + keep.display + '" from ' + keep.origins.join(' / ') +
                     '; discarded "' + drop.display + '" from ' + drop.origins.join(' / ');
    });
    if (applied) model.finalise();     // p.birth / p.death re-derive from events
    return applied;
  }

  AV.merge = { models: models, resolve: resolve, normName: normName };
  window.AV = AV;
})(AV);
