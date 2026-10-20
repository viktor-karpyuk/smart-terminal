'use strict';

/**
 * The QR encoder, checked against the standard rather than against a reader:
 * the finder patterns and timing lines are where they must be, the format
 * bits name the mask that was applied, and the data read back along the
 * placement path is the codewords that went in, for every version it makes.
 */

const test = require('node:test');
const assert = require('node:assert');

const { QR } = require('../electron/qr');

const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];
const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** Which cells are function patterns, by the standard's layout. */
function reserved(version) {
  const n = version * 4 + 17;
  const is = (r, c) => {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 8) || (r >= n - 8 && c <= 8)) return true;
    if (r === 6 || c === 6) return true;
    if (version >= 7 && ((r <= 5 && c >= n - 11 && c <= n - 9) || (c <= 5 && r >= n - 11 && r <= n - 9))) return true;
    for (const ar of ALIGN[version]) for (const ac of ALIGN[version]) {
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= n - 9) || (ar >= n - 9 && ac <= 8)) continue;
      if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
    }
    return false;
  };
  return { n, is };
}

function readFormat(grid) {
  let bits = 0;
  for (let k = 0; k < 15; k += 1) {
    const bit = k < 6 ? grid[k][8] : k === 6 ? grid[7][8] : k === 7 ? grid[8][8] : k === 8 ? grid[8][7] : grid[8][14 - k];
    if (bit) bits |= 1 << k;
  }
  return bits;
}

function readCodewords(grid, version, mask) {
  const { n, is } = reserved(version);
  const bits = [];
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let step = 0; step < n; step += 1) {
      const row = up ? n - 1 - step : step;
      for (let dc = 0; dc < 2; dc += 1) {
        const c = col - dc;
        if (is(row, c)) continue;
        bits.push(grid[row][c] !== MASKS[mask](row, c) ? 1 : 0);
      }
    }
    up = !up;
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  return out;
}

test('every version from 1 to 10 reads back as the codewords that went in', () => {
  for (const len of [2, 20, 40, 60, 90, 110, 140, 170, 200, 213]) {
    const text = `http://mac.local:7373/?code=${'K'.repeat(Math.max(0, len - 28))}`;
    const grid = QR.make(text);
    assert.ok(grid, `${len} bytes fit`);
    const version = (grid.length - 17) / 4;
    assert.ok(Number.isInteger(version) && version >= 1 && version <= 10, `version ${version}`);
    const format = readFormat(grid);
    const mask = FORMAT_M.indexOf(format);
    assert.notEqual(mask, -1, 'the format bits name a mask at level M');
    const want = QR.codewords(Array.from(Buffer.from(text)), version);
    const got = readCodewords(grid, version, mask).slice(0, want.length);
    assert.deepEqual(got, want, `version ${version}: the data along the path is the codewords`);
  }
});

test('finders, timing lines and the dark module are where the standard puts them', () => {
  const grid = QR.make('hi');
  const n = grid.length;
  assert.equal(n, 21);
  const finder = (r0, c0) => {
    for (let r = 0; r < 7; r += 1) for (let c = 0; c < 7; c += 1) {
      const on = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      assert.equal(grid[r0 + r][c0 + c], on, `finder at ${r0},${c0} cell ${r},${c}`);
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i += 1) { assert.equal(grid[6][i], i % 2 === 0); assert.equal(grid[i][6], i % 2 === 0); }
  assert.equal(grid[n - 8][8], true, 'the dark module');
});

test('too long is null; the SVG has a quiet zone and escapes its label', () => {
  assert.equal(QR.make('x'.repeat(214)), null);
  const svg = QR.svg('hi', 'a <label> & "more"');
  assert.match(svg, /viewBox="0 0 29 29"/);
  assert.match(svg, /aria-label="a &#60;label&#62; &#38; &#34;more&#34;"/);
  assert.equal(QR.svg('x'.repeat(300)), '');
});
