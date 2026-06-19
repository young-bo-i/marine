// zip.js — 极简 ZIP 编码器（STORE 不压缩 + CRC32 + UTF-8 文件名），零依赖。
// marineZip([{name, content}]) -> Blob(application/zip)。名字带 / 即表示文件夹结构。

function marineCRC32(bytes) {
  if (!marineCRC32.table) {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    marineCRC32.table = t;
  }
  const t = marineCRC32.table;
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = t[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function marineZip(entries) {
  const enc = new TextEncoder();
  const u16 = n => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = enc.encode(e.content || '');
    const crc = marineCRC32(data);
    const size = data.length;
    // 本地文件头（30 字节定长 + 文件名 + 数据）。flags=0x0800 标记 UTF-8 文件名。
    const lh = [].concat(
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0)
    );
    chunks.push(new Uint8Array(lh), nameBytes, data);
    central.push({ nameBytes, crc, size, offset });
    offset += lh.length + nameBytes.length + size;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const ch = [].concat(
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(c.crc), u32(c.size), u32(c.size), u16(c.nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(c.offset)
    );
    chunks.push(new Uint8Array(ch), c.nameBytes);
    cdSize += ch.length + c.nameBytes.length;
  }

  const eocd = [].concat(
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(cdSize), u32(cdStart), u16(0)
  );
  chunks.push(new Uint8Array(eocd));

  return new Blob(chunks, { type: 'application/zip' });
}
