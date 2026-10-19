/*
 * A QR code, as a grid of booleans: byte mode, error level M, versions 1 to 10
 * (up to 213 bytes), masks chosen by the standard's penalty. Enough for a
 * pairing link, and nothing to install.
 */
(function (root) {
  'use strict';
  // Error-correction level M: [total codewords, EC codewords per block, blocks in group 1, data codewords in group 1, blocks in group 2, data codewords in group 2]
  var EC_M = [null,
    [26, 10, 1, 16, 0, 0], [44, 16, 1, 28, 0, 0], [70, 26, 1, 44, 0, 0], [100, 18, 2, 32, 0, 0], [134, 24, 2, 43, 0, 0],
    [172, 16, 4, 27, 0, 0], [196, 18, 4, 31, 0, 0], [242, 22, 2, 38, 2, 39], [292, 22, 3, 36, 2, 37], [346, 26, 4, 43, 1, 44]];
  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  var EXP = new Array(256), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
    EXP[255] = EXP[0];
  })();
  function mul(a, b) { return a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0; }
  function generator(n) {
    var g = [1];
    for (var i = 0; i < n; i += 1) {
      var next = new Array(g.length + 1).fill(0);
      for (var j = 0; j < g.length; j += 1) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
      g = next;
    }
    return g;
  }
  function ecOf(data, n) {
    var g = generator(n);
    var rest = data.slice().concat(new Array(n).fill(0));
    for (var i = 0; i < data.length; i += 1) {
      var lead = rest[i];
      if (!lead) continue;
      for (var j = 0; j < g.length; j += 1) rest[i + j] ^= mul(g[j], lead);
    }
    return rest.slice(data.length);
  }

  function bytesOf(text) {
    var out = [];
    var s = unescape(encodeURIComponent(String(text)));
    for (var i = 0; i < s.length; i += 1) out.push(s.charCodeAt(i));
    return out;
  }

  function codewords(bytes, version) {
    var spec = EC_M[version];
    var dataLen = spec[2] * spec[3] + spec[4] * spec[5];
    var bits = [];
    var push = function (value, n) { for (var i = n - 1; i >= 0; i -= 1) bits.push((value >> i) & 1); };
    push(4, 4);
    push(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach(function (b) { push(b, 8); });
    push(0, Math.min(4, dataLen * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (var pad = 0; data.length < dataLen; pad += 1) data.push(pad % 2 ? 0x11 : 0xec);
    // Blocks, each with its own error correction, then interleaved.
    var blocks = [], at = 0;
    for (var b = 0; b < spec[2]; b += 1) { blocks.push(data.slice(at, at + spec[3])); at += spec[3]; }
    for (b = 0; b < spec[4]; b += 1) { blocks.push(data.slice(at, at + spec[5])); at += spec[5]; }
    var ecs = blocks.map(function (block) { return ecOf(block, spec[1]); });
    var out = [];
    var longest = Math.max.apply(null, blocks.map(function (x) { return x.length; }));
    for (i = 0; i < longest; i += 1) blocks.forEach(function (block) { if (i < block.length) out.push(block[i]); });
    for (i = 0; i < spec[1]; i += 1) ecs.forEach(function (ec) { out.push(ec[i]); });
    return out;
  }

  function versionFor(n) {
    for (var v = 1; v <= 10; v += 1) {
      var spec = EC_M[v];
      var capacity = spec[2] * spec[3] + spec[4] * spec[5] - (v < 10 ? 2 : 3);
      if (n <= capacity) return v;
    }
    return null;
  }

  function make(text, forced) {
    // `forced` picks a mask by hand; the tests use it to compare with another encoder.
    var bytes = bytesOf(text);
    var version = versionFor(bytes.length);
    if (!version) return null;
    var size = version * 4 + 17;
    var grid = [], fixed = [];
    for (var r = 0; r < size; r += 1) { grid.push(new Array(size).fill(false)); fixed.push(new Array(size).fill(false)); }
    var set = function (r, c, v) { grid[r][c] = v; fixed[r][c] = true; };
    var finder = function (r0, c0) {
      for (var r = -1; r <= 7; r += 1) for (var c = -1; c <= 7; c += 1) {
        var rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        var on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, on);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    for (var i = 8; i < size - 8; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    var centres = ALIGN[version];
    centres.forEach(function (ar) {
      centres.forEach(function (ac) {
        // Not where a finder is; a timing line underneath is fine, the two agree.
        if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) return;
        for (var r = -2; r <= 2; r += 1) for (var c = -2; c <= 2; c += 1) set(ar + r, ac + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
      });
    });
    // Format information goes here; reserved now, written once the mask is known.
    for (i = 0; i <= 8; i += 1) { fixed[8][i] = true; fixed[i][8] = true; }
    for (i = 0; i < 8; i += 1) { fixed[8][size - 1 - i] = true; fixed[size - 1 - i][8] = true; }
    set(size - 8, 8, true);
    if (version >= 7) for (i = 0; i < 6; i += 1) for (var j = 0; j < 3; j += 1) { fixed[i][size - 11 + j] = true; fixed[size - 11 + j][i] = true; }

    var words = codewords(bytes, version);
    var bits = [];
    words.forEach(function (w) { for (var k = 7; k >= 0; k -= 1) bits.push((w >> k) & 1); });
    var at = 0, up = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      for (var step = 0; step < size; step += 1) {
        var row = up ? size - 1 - step : step;
        for (var dc = 0; dc < 2; dc += 1) {
          var c = col - dc;
          if (fixed[row][c]) continue;
          grid[row][c] = Boolean(bits[at]); at += 1;
        }
      }
      up = !up;
    }

    var MASKS = [
      function (r, c) { return (r + c) % 2 === 0; }, function (r) { return r % 2 === 0; }, function (r, c) { return c % 3 === 0; },
      function (r, c) { return (r + c) % 3 === 0; }, function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
      function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; }, function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
      function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }];
    var FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
    var apply = function (mask) {
      var out = grid.map(function (row) { return row.slice(); });
      for (var r = 0; r < size; r += 1) for (var c = 0; c < size; c += 1) if (!fixed[r][c] && MASKS[mask](r, c)) out[r][c] = !out[r][c];
      var f = FORMAT_M[mask];
      for (var k = 0; k < 15; k += 1) {
        var bit = ((f >> k) & 1) === 1;
        if (k < 6) out[k][8] = bit; else if (k === 6) out[7][8] = bit; else if (k === 7) out[8][8] = bit; else if (k === 8) out[8][7] = bit; else out[8][14 - k] = bit;
        if (k < 8) out[8][size - 1 - k] = bit; else out[size - 15 + k][8] = bit;
      }
      if (version >= 7) {
        var v = version << 12, rem = version;
        for (var s = 0; s < 12; s += 1) rem = (rem << 1) ^ ((rem >> 11) & 1 ? 0x1f25 : 0);
        v |= rem & 0xfff;
        for (k = 0; k < 18; k += 1) { bit = ((v >> k) & 1) === 1; out[Math.floor(k / 3)][size - 11 + (k % 3)] = bit; out[size - 11 + (k % 3)][Math.floor(k / 3)] = bit; }
      }
      return out;
    };
    var penalty = function (m) {
      var score = 0, r, c, run, last;
      var line = function (get) {
        for (var a = 0; a < size; a += 1) {
          run = 0; last = null;
          for (var b = 0; b < size; b += 1) {
            var v = get(a, b);
            if (v === last) { run += 1; if (run === 5) score += 3; else if (run > 5) score += 1; } else { run = 1; last = v; }
          }
        }
      };
      line(function (a, b) { return m[a][b]; });
      line(function (a, b) { return m[b][a]; });
      for (r = 0; r < size - 1; r += 1) for (c = 0; c < size - 1; c += 1) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
      var pattern = [true, false, true, true, true, false, true, false, false, false, false];
      var matches = function (get, a, b) {
        for (var p = 0; p < 11; p += 1) if (get(a, b + p) !== pattern[p]) break;
        if (p === 11) return true;
        for (p = 0; p < 11; p += 1) if (get(a, b + p) !== pattern[10 - p]) break;
        return p === 11;
      };
      for (r = 0; r < size; r += 1) for (c = 0; c <= size - 11; c += 1) {
        if (matches(function (a, b) { return m[a][b]; }, r, c)) score += 40;
        if (matches(function (a, b) { return m[b][a]; }, r, c)) score += 40;
      }
      var dark = 0;
      for (r = 0; r < size; r += 1) for (c = 0; c < size; c += 1) if (m[r][c]) dark += 1;
      score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
      return score;
    };
    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask += 1) {
      if (forced != null && mask !== forced) continue;
      var candidate = apply(mask);
      var s2 = penalty(candidate);
      if (s2 < bestScore) { bestScore = s2; best = candidate; }
    }
    return best;
  }

  /** An SVG of the code, dark on light with a quiet zone, that scales to its box. */
  function svg(text, label) {
    var grid = make(text);
    if (!grid) return '';
    var n = grid.length, q = 4, size = n + q * 2;
    var d = '';
    for (var r = 0; r < n; r += 1) for (var c = 0; c < n; c += 1) if (grid[r][c]) d += 'M' + (c + q) + ' ' + (r + q) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" role="img" aria-label="' + String(label || '').replace(/[&<>"]/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }) + '"><rect width="' + size + '" height="' + size + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }

  root.QR = { make: make, svg: svg, codewords: codewords, ecOf: ecOf };
})(typeof module !== 'undefined' && module.exports ? module.exports : window);
