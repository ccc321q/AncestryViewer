/* conflicts.js - walk the user through every disagreement a merge turned up.

   When two files give different dates for the same fact the merge keeps both,
   because it has no way to know which is right. The person doing the merging
   usually does, so this asks them, one conflict at a time.

   review(model) resolves to a decisions map { conflictId: 0 | 1 | null }, or
   to null if the user cancels — in which case nothing is applied and both
   values stay, exactly as if the review had never run.                      */
var AV = window.AV || {};
(function (AV) {
  'use strict';
  var U = AV.util, el = U.el;

  function review(model) {
    var list = (model.conflicts || []).slice();
    if (!list.length) return Promise.resolve({});

    return new Promise(function (done) {
      var decisions = {};        // id -> 0 | 1 | null (null = keep both)
      var at = 0;

      var overlay = el('div', { class: 'popup-overlay' });
      var body = el('div', { class: 'popup-body conflict-body' });
      var counter = el('span', { class: 'muted' });
      var footer = el('div', { class: 'conflict-foot' });

      var box = el('div', { class: 'popup conflict-popup' }, [
        el('div', { class: 'popup-bar' }, [
          el('h3', { text: 'Which value is right?' }),
          counter
        ]),
        body,
        footer
      ]);
      overlay.appendChild(box);

      /* Deliberately not dismissible by Esc or a click outside: a half-made
         set of decisions should not be lost to a stray click. */
      function close() {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        document.removeEventListener('keydown', onKey);
      }
      function finish() { close(); done(decisions); }
      function cancel() { close(); done(null); }
      function onKey(e) {
        /* Someone typing a date into the custom fields must not have their
           digits and arrows eaten by the dialog's shortcuts. */
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
        else if (e.key === '1' || e.key === '2') {
          e.preventDefault(); choose(+e.key - 1);
        }
      }
      function go(d) {
        at = Math.max(0, Math.min(list.length - 1, at + d));
        paint();
      }
      function choose(i) {
        decisions[list[at].id] = i;
        if (at < list.length - 1) { at++; paint(); }
        else paint();
      }

      function isCustom(v) { return !!v && typeof v === 'object'; }

      function decidedCount() {
        return list.filter(function (c) {
          var d = decisions[c.id];
          return d === 0 || d === 1 || isCustom(d);
        }).length;
      }

      /* The date and place a person typed for this conflict, held while they
         move around the list so navigating away does not lose the entry. */
      function customPanel(c) {
        var held = isCustom(decisions[c.id]) ? decisions[c.id] : null;
        var dateIn = el('input', {
          type: 'text', class: 'ccustom-date', placeholder: 'e.g. 15 Mar 1766',
          value: held ? held.date : ''
        });
        var placeIn = el('input', {
          type: 'text', class: 'ccustom-place', placeholder: 'place (optional)',
          value: held ? held.place : (c.options[0].place || '')
        });
        var reads = el('div', { class: 'ccustom-reads' });

        function preview() {
          var txt = dateIn.value.trim();
          if (!txt) { reads.textContent = ''; return; }
          var d = U.parseDateText(txt);
          reads.textContent = d.year
            ? 'reads as ' + d.display
            : 'kept as written: “' + d.display + '” (no date recognised)';
          reads.className = 'ccustom-reads' + (d.year ? '' : ' warn');
        }
        dateIn.addEventListener('input', preview);
        preview();

        function use() {
          var date = dateIn.value.trim(), place = placeIn.value.trim();
          if (!date && !place) return;         // nothing to record
          decisions[c.id] = { date: date, place: place };
          if (at < list.length - 1) at++;
          paint();
        }
        placeIn.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); use(); }
        });
        dateIn.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); use(); }
        });

        return el('div', { class: 'conflict-custom' + (held ? ' on' : '') }, [
          el('div', { class: 'ccustom-head', text: held
            ? '✓ Using a value you entered'
            : 'Neither is right? Enter the correct value' }),
          el('div', { class: 'ccustom-row' }, [
            dateIn, placeIn,
            el('button', { class: 'ghost', text: 'Use this', onclick: use })
          ]),
          reads
        ]);
      }

      function optionCard(c, i) {
        var o = c.options[i];
        var picked = decisions[c.id] === i;
        return el('button', {
          class: 'conflict-opt' + (picked ? ' on' : ''),
          onclick: function () { choose(i); }
        }, [
          el('div', { class: 'copt-value', text: o.display || '(no date)' }),
          o.place ? el('div', { class: 'copt-place', text: o.place }) : null,
          el('div', { class: 'copt-from', text: o.origins.join(', ') }),
          el('div', { class: 'copt-key', text: 'press ' + (i + 1) })
        ]);
      }

      function paint() {
        var c = list[at];
        counter.textContent = 'Conflict ' + (at + 1) + ' of ' + list.length +
          ' · ' + decidedCount() + ' decided';
        U.clear(body);
        U.clear(footer);

        body.appendChild(el('div', { class: 'conflict-who' }, [
          el('h4', { text: c.who }),
          el('span', { class: 'muted', text: c.label +
            (c.ownerType === 'family' ? ' (family record)' : '') })
        ]));
        body.appendChild(el('p', { class: 'muted small', text:
          'These files disagree. Choose a value to keep, enter your own, or keep both.' }));
        body.appendChild(el('div', { class: 'conflict-opts' }, [
          optionCard(c, 0), optionCard(c, 1)
        ]));
        body.appendChild(customPanel(c));

        body.appendChild(el('button', {
          class: 'conflict-both' + (decisions[c.id] === null ? ' on' : ''),
          text: decisions[c.id] === null ? '✓ Keeping both' : 'Keep both',
          title: 'Leave both values on the record, as the merge does by default',
          onclick: function () {
            decisions[c.id] = null;
            if (at < list.length - 1) { at++; }
            paint();
          }
        }));

        footer.appendChild(el('button', {
          class: 'ghost', text: '← Back', disabled: at === 0 ? 'disabled' : null,
          onclick: function () { go(-1); }
        }));
        footer.appendChild(el('button', {
          class: 'ghost', text: 'Next →',
          disabled: at === list.length - 1 ? 'disabled' : null,
          onclick: function () { go(1); }
        }));
        footer.appendChild(el('span', { class: 'spacer' }));
        footer.appendChild(el('button', {
          class: 'ghost', text: 'Keep both for the rest',
          title: 'Stop deciding and leave every remaining conflict with both values',
          onclick: function () {
            list.forEach(function (x) {
              if (decisions[x.id] === undefined) decisions[x.id] = null;
            });
            finish();
          }
        }));
        footer.appendChild(el('button', {
          class: 'ghost', text: 'Cancel',
          title: 'Discard these decisions and keep both values everywhere',
          onclick: cancel
        }));
        footer.appendChild(el('button', {
          class: 'primary', text: 'Apply ' + decidedCount() + ' decision' +
            (decidedCount() === 1 ? '' : 's'),
          onclick: finish
        }));
      }

      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      paint();
    });
  }

  AV.conflicts = { review: review };
  window.AV = AV;
})(AV);
