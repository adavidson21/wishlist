// A small QR code maker for the invite card: byte mode, error correction level M, versions 1 to 10
// (up to 213 bytes, plenty for an invite link). Returns an SVG string. Loaded only when someone taps
// "Show QR code". Follows ISO/IEC 18004; the structure mirrors Project Nayuki's reference encoder.
(function () {
  "use strict";
  // Per version (index 1..10) at level M: [EC codewords per block, [blocks, data codewords per block], ...]
  const BLOCKS = [null,
    [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
    [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // GF(256) with the QR polynomial 0x11D.
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function rsDivisor(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= mul(poly[j], EXP[i]); }
      poly = next;
    }
    return poly.slice(1);
  }
  function rsRemainder(data, div) {
    const out = new Array(div.length).fill(0);
    for (const b of data) {
      const f = b ^ out.shift();
      out.push(0);
      for (let i = 0; i < div.length; i++) out[i] ^= mul(div[i], f);
    }
    return out;
  }

  const capacity = (v) => BLOCKS[v].slice(1).reduce((s, [n, d]) => s + n * d, 0);

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let version = 1;
    while (version <= 10 && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > capacity(version) * 8) version++;
    if (version > 10) throw new Error("Too long for a QR code here.");
    const cap = capacity(version) * 8;
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4);
    put(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

    // Split into blocks, add error correction, interleave.
    const [ecLen, ...groups] = BLOCKS[version];
    const div = rsDivisor(ecLen);
    const blocks = [];
    let k = 0;
    for (const [n, d] of groups) for (let i = 0; i < n; i++) { const blk = data.slice(k, k + d); k += d; blocks.push([blk, rsRemainder(blk, div)]); }
    const final = [];
    const maxData = Math.max(...blocks.map((b) => b[0].length));
    for (let i = 0; i < maxData; i++) for (const [d] of blocks) if (i < d.length) final.push(d[i]);
    for (let i = 0; i < ecLen; i++) for (const [, e] of blocks) final.push(e[i]);

    // Function patterns.
    const size = version * 4 + 17;
    const mods = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { mods[y][x] = dark; isFn[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const al = ALIGN[version];
    for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const drawFormat = (mask) => {
      const d = (0 << 3) | mask; // level M is 00
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((d << 10) | rem) ^ 0x5412;
      const bit = (i) => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0); // reserves the format areas
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
        set(a, c, dark); set(c, a, dark);
      }
    }

    // Data, in the zigzag order.
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!isFn[y][x] && i < final.length * 8) { mods[y][x] = ((final[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }

    // Try all 8 masks, keep the one that scans best.
    const MASKS = [(x, y) => (x + y) % 2, (x, y) => y % 2, (x) => x % 3, (x, y) => (x + y) % 3,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2, (x, y) => ((x * y) % 2) + ((x * y) % 3),
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2];
    const applyMask = (m) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && MASKS[m](x, y) === 0) mods[y][x] = !mods[y][x];
    };
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const s = penalty(mods, size);
      if (s < bestScore) { bestScore = s; best = m; }
      applyMask(m);
    }
    applyMask(best); drawFormat(best);
    return mods;
  }

  function penalty(m, size) {
    let score = 0, dark = 0;
    const lines = [];
    for (let y = 0; y < size; y++) { lines.push(m[y].map((v) => (v ? 1 : 0)).join("")); }
    for (let x = 0; x < size; x++) { let s = ""; for (let y = 0; y < size; y++) s += m[y][x] ? 1 : 0; lines.push(s); }
    for (const line of lines) {
      for (const run of line.match(/0{5,}|1{5,}/g) || []) score += run.length - 2;
      score += 40 * ((line.match(/(?=10111010000|00001011101)/g) || []).length);
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (x < size - 1 && y < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  // An SVG with a 4-module quiet zone. Colors come from the caller (CSS variables work).
  window.qrSvg = function (text, { dark = "#000", light = "#fff", label = "QR code" } = {}) {
    const mods = encode(text);
    const n = mods.length, q = 4, w = n + q * 2;
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (mods[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
    return `<svg viewBox="0 0 ${w} ${w}" role="img" aria-label="${label.replace(/[<>"&]/g, "")}" shape-rendering="crispEdges">` +
      `<rect width="${w}" height="${w}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  };
})();
