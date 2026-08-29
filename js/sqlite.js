/* sqlite.js - a dependency-free, read-only SQLite 3 reader.
   It walks table b-trees and decodes record payloads directly, so the
   custom RMNOCASE collation that RootsMagic registers (and which makes
   sql.js and most generic SQLite tools refuse the file) is never invoked:
   collations only matter for index lookups and ORDER BY, and we do
   neither -- we read table pages in rowid order and sort in JS. */
var AV = window.AV || {};
(function (AV) {
  'use strict';
  var U = AV.util;

  function SQLiteDB(buf) {
    var r = new U.Reader(buf);
    if (!r.eq(0, 'SQLite format 3')) throw new Error('Not a SQLite 3 database');
    this.r = r;
    this.pageSize = r.u16be(16);
    if (this.pageSize === 1) this.pageSize = 65536;
    this.reserved = r.u8(20);
    this.usable = this.pageSize - this.reserved;
    this.pageCount = r.u32be(28) || Math.floor(r.length / this.pageSize);
    this.encoding = r.u32be(56) || 1;   // 1 = UTF-8, 2 = UTF-16le, 3 = UTF-16be
    this.schema = this.readSchema();
  }

  /* --- varint (big-endian, 7 bits per byte, up to 9 bytes) ---------------- */
  function varint(bytes, o) {
    var v = 0, i, b;
    for (i = 0; i < 8; i++) {
      b = bytes[o + i];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return { value: v, size: i + 1 };
    }
    v = v * 256 + bytes[o + 8];
    return { value: v, size: 9 };
  }

  SQLiteDB.prototype.pageOffset = function (n) { return (n - 1) * this.pageSize; };

  /* Collect every (rowid, payloadBytes) in the table b-tree rooted at page. */
  SQLiteDB.prototype.walkTable = function (root, emit) {
    var self = this, seen = new Set(), stack = [root];
    while (stack.length) {
      var pg = stack.pop();
      if (!pg || pg > self.pageCount || seen.has(pg)) continue;
      seen.add(pg);
      var base = self.pageOffset(pg);
      var hdr = base + (pg === 1 ? 100 : 0);
      var type = self.r.u8(hdr);
      if (type !== 0x0d && type !== 0x05) continue;      // table leaf / interior
      var nCells = self.r.u16be(hdr + 3);
      var cellStart = hdr + (type === 0x05 ? 12 : 8);
      var i, ptr;
      if (type === 0x05) {
        stack.push(self.r.u32be(hdr + 8));               // rightmost child
        for (i = 0; i < nCells; i++) {
          ptr = base + self.r.u16be(cellStart + i * 2);
          stack.push(self.r.u32be(ptr));
        }
        continue;
      }
      for (i = 0; i < nCells; i++) {
        ptr = base + self.r.u16be(cellStart + i * 2);
        var a = varint(self.r.bytes, ptr);
        var b = varint(self.r.bytes, ptr + a.size);
        var payloadSize = a.value, rowid = b.value;
        var dataAt = ptr + a.size + b.size;
        emit(rowid, self.readPayload(dataAt, payloadSize));
      }
    }
  };

  /* Assemble a payload, following the overflow-page chain when needed. */
  SQLiteDB.prototype.readPayload = function (at, size) {
    var U_ = this.usable;
    var maxLocal = U_ - 35;
    if (size <= maxLocal) return this.r.bytes.subarray(at, at + size);
    var minLocal = Math.floor(((U_ - 12) * 32) / 255) - 23;
    var local = minLocal + ((size - minLocal) % (U_ - 4));
    if (local > maxLocal) local = minLocal;
    var out = new Uint8Array(size), n = 0, i;
    for (i = 0; i < local; i++) out[n++] = this.r.bytes[at + i];
    var next = this.r.u32be(at + local);
    while (next && n < size && next <= this.pageCount) {
      var off = this.pageOffset(next);
      var take = Math.min(U_ - 4, size - n);
      for (i = 0; i < take; i++) out[n++] = this.r.bytes[off + 4 + i];
      next = this.r.u32be(off);
    }
    return out;
  };

  /* Decode one record (serial-type header + values). */
  SQLiteDB.prototype.decodeRecord = function (buf) {
    var h = varint(buf, 0), o = h.size, end = h.value, types = [], v;
    while (o < end && o < buf.length) {
      v = varint(buf, o); o += v.size; types.push(v.value);
    }
    var vals = [], p = end, i, t;
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (i = 0; i < types.length; i++) {
      t = types[i];
      if (t === 0) { vals.push(null); }
      else if (t === 1) { vals.push(dv.getInt8(p)); p += 1; }
      else if (t === 2) { vals.push(dv.getInt16(p, false)); p += 2; }
      else if (t === 3) { vals.push(int24(buf, p)); p += 3; }
      else if (t === 4) { vals.push(dv.getInt32(p, false)); p += 4; }
      else if (t === 5) { vals.push(int48(buf, p)); p += 6; }
      else if (t === 6) { vals.push(Number(dv.getBigInt64(p, false))); p += 8; }
      else if (t === 7) { vals.push(dv.getFloat64(p, false)); p += 8; }
      else if (t === 8) { vals.push(0); }
      else if (t === 9) { vals.push(1); }
      else if (t >= 12 && t % 2 === 0) {
        var bl = (t - 12) / 2;
        vals.push(buf.subarray(p, p + bl)); p += bl;
      } else if (t >= 13) {
        var sl = (t - 13) / 2;
        vals.push(this.decodeString(buf, p, sl)); p += sl;
      } else { vals.push(null); }
    }
    return vals;
  };

  function int24(b, p) {
    var v = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
    return (v & 0x800000) ? v - 0x1000000 : v;
  }
  function int48(b, p) {
    var hi = (b[p] << 8) | b[p + 1];
    if (hi & 0x8000) hi -= 0x10000;
    return hi * 4294967296 + ((b[p + 2] << 24 >>> 0) + (b[p + 3] << 16) + (b[p + 4] << 8) + b[p + 5]);
  }

  SQLiteDB.prototype.decodeString = function (buf, p, len) {
    if (this.encoding === 1) return U.decodeText(buf, p, p + len);
    var out = '', i, c;
    for (i = 0; i + 1 < len; i += 2) {
      c = this.encoding === 2 ? (buf[p + i] | (buf[p + i + 1] << 8))
                              : ((buf[p + i] << 8) | buf[p + i + 1]);
      out += String.fromCharCode(c);
    }
    return out;
  };

  /* sqlite_master lives on page 1: (type, name, tbl_name, rootpage, sql). */
  SQLiteDB.prototype.readSchema = function () {
    var self = this, tables = {};
    this.walkTable(1, function (rowid, payload) {
      var v = self.decodeRecord(payload);
      if (v[0] !== 'table' || !v[3]) return;
      tables[v[1]] = { name: v[1], root: v[3], sql: v[4] || '', columns: parseColumns(v[4] || '') };
    });
    return tables;
  };

  function parseColumns(sql) {
    var m = /\(([\s\S]*)\)\s*$/.exec(sql);
    if (!m) return [];
    var body = m[1], out = [], depth = 0, cur = '', i, c;
    for (i = 0; i < body.length; i++) {
      c = body[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim().split(/\s+/)[0].replace(/[`"\[\]]/g, ''); })
              .filter(function (s) { return s && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(s); });
  }

  SQLiteDB.prototype.tableNames = function () { return Object.keys(this.schema).sort(); };

  /* Read a whole table into plain objects. INTEGER PRIMARY KEY columns are
     stored as NULL in the record and take their value from the rowid. */
  SQLiteDB.prototype.table = function (name) {
    var t = this.schema[name];
    if (!t) return [];
    var self = this, cols = t.columns, rows = [];
    var pkCol = /(\w+)\s+INTEGER\s+PRIMARY\s+KEY/i.exec(t.sql);
    pkCol = pkCol ? pkCol[1] : null;
    this.walkTable(t.root, function (rowid, payload) {
      var v = self.decodeRecord(payload), o = {}, i;
      for (i = 0; i < cols.length; i++) o[cols[i]] = v[i] === undefined ? null : v[i];
      if (pkCol && (o[pkCol] === null || o[pkCol] === undefined)) o[pkCol] = rowid;
      o.__rowid = rowid;
      rows.push(o);
    });
    return rows;
  };

  AV.SQLiteDB = SQLiteDB;
  window.AV = AV;
})(AV);
