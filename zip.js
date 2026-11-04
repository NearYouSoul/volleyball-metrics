// Простой ZIP без сторонних библиотек: собрать архив (deflate) и прочитать его обратно.
// Нужен для экспорта: пакет команды, матч — один файл, который открывается любым архиватором.
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';

const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
// Дата и время в формате DOS (так их хранит ZIP).
function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// files: [{ name, data: Buffer | string }] → Buffer с архивом. Имена — UTF-8 (флаг 0x800), русские буквы читаются.
export function makeZip(files, when = new Date()) {
  const { time, date } = dosTime(when);
  const local = [], central = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const packed = deflateRawSync(raw, { level: 9 });
    const store = packed.length >= raw.length; // уже сжатое (png) — кладём как есть
    const body = store ? raw : packed;
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(raw);
    const head = [u16(20), u16(0x800), u16(store ? 0 : 8), u16(time), u16(date), u32(crc), u32(body.length), u32(raw.length), u16(name.length), u16(0)];
    const lh = Buffer.concat([u32(0x04034b50), ...head, name]);
    local.push(lh, body);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), ...head, u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += lh.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...local, cd, end]);
}

// Buffer с архивом → [{ name, data: Buffer }]. Читаем по центральному каталогу; поддерживаются store и deflate.
export function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Это не ZIP-архив');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Архив повреждён');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const body = buf.subarray(start, start + size);
    if (!name.endsWith('/')) {
      if (method !== 0 && method !== 8) throw new Error(`Неподдерживаемое сжатие в «${name}»`);
      out.push({ name, data: method === 8 ? inflateRawSync(body) : Buffer.from(body) });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
