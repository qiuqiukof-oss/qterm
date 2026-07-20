'use strict';
// Generates tray/icon.ico (Windows) and tray/icon.png (macOS/Linux) at build time.
// No external deps — pure Node (zlib is built-in).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 32;
const TEAL = [0x1a, 0xb8, 0xc6];
const DARK = [0x12, 0x6e, 0x7a];

function pixel(x, y) {
  const border = x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2;
  return border ? DARK : TEAL;
}

function makeICO() {
  const w = SIZE, h = SIZE;
  const pix = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = pixel(x, y);
    const i = (y * w + x) * 4;
    pix[i] = b; pix[i + 1] = g; pix[i + 2] = r; pix[i + 3] = 255;
  }
  // bottom-up BGRA
  const bgra = Buffer.alloc(pix.length);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    pix.copy(bgra, y * w * 4, src, src + w * 4);
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8); // ICO height is doubled
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(bgra.length, 20);
  const dib = Buffer.concat([header, bgra]);

  const icondir = Buffer.alloc(6);
  icondir.writeUInt16LE(0, 0); icondir.writeUInt16LE(1, 2); icondir.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(w, 0); entry.writeUInt8(h, 1); entry.writeUInt8(0, 2); entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(dib.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([icondir, entry, dib]);
}

function makePNG() {
  const w = SIZE, h = SIZE;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 4 + 1);
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const i = off + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw);
  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const out = path.join(__dirname);
fs.writeFileSync(path.join(out, 'icon.ico'), makeICO());
fs.writeFileSync(path.join(out, 'icon.png'), makePNG());
console.log('[make-icon] wrote icon.ico and icon.png (' + SIZE + 'x' + SIZE + ')');
