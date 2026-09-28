// A minimal streaming ZIP writer.
//
// Drive has no folder-download endpoint, so folders are zipped in the browser.
// Entries use the "store" method (no compression) with a data descriptor, which
// means each file's CRC and length are written *after* its bytes — necessary
// because a Google-native file's exported size is unknown until it arrives.
//
// ZIP32 only: the 4 GiB ceiling is checked by the caller before it starts.

const LOCAL_SIG = 0x04034b50;
const DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const VERSION = 20;

export const ZIP32_LIMIT = 0xffffffff; // 4 GiB - 1

// --- CRC-32 -----------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

/** Incremental CRC-32. Pass the previous result back in as `seed`. */
export function crc32(bytes, seed = 0) {
  let crc = (seed ^ -1) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ -1) >>> 0;
}

// --- Byte helpers -----------------------------------------------------------

class ByteWriter {
  constructor(length) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
    this.offset = 0;
  }
  u16(value) { this.view.setUint16(this.offset, value, true); this.offset += 2; return this; }
  u32(value) { this.view.setUint32(this.offset, value >>> 0, true); this.offset += 4; return this; }
  raw(chunk) { this.bytes.set(chunk, this.offset); this.offset += chunk.length; return this; }
}

/** MS-DOS packed time and date, which is all a ZIP header can carry. */
function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 0x1f) << 11)
      | ((date.getMinutes() & 0x3f) << 5)
      | ((date.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9)
      | (((date.getMonth() + 1) & 0x0f) << 5)
      | (date.getDate() & 0x1f)
  };
}

const encoder = new TextEncoder();

// --- Writer -----------------------------------------------------------------

/**
 * @param {(chunk: Uint8Array) => (void|Promise<void>)} sink receives the archive
 *   in order; back-pressure is respected if it returns a promise.
 */
export function createZip(sink) {
  const central = [];
  let offset = 0;
  let open = null;

  async function emit(chunk) {
    await sink(chunk);
    offset += chunk.length;
  }

  function localHeader(nameBytes, stamp) {
    const writer = new ByteWriter(30 + nameBytes.length);
    writer.u32(LOCAL_SIG)
      .u16(VERSION)
      .u16(FLAG_DATA_DESCRIPTOR | FLAG_UTF8)
      .u16(METHOD_STORE)
      .u16(stamp.time)
      .u16(stamp.date)
      .u32(0)  // crc, in the data descriptor
      .u32(0)  // compressed size, likewise
      .u32(0)  // uncompressed size, likewise
      .u16(nameBytes.length)
      .u16(0)  // no extra field
      .raw(nameBytes);
    return writer.bytes;
  }

  async function startEntry(name, { isDirectory = false, modified } = {}) {
    if (open) throw new Error('Previous ZIP entry was never closed');

    // A directory entry is a zero-length record whose name ends in a slash.
    const entryName = isDirectory && !name.endsWith('/') ? `${name}/` : name;
    const nameBytes = encoder.encode(entryName);
    const stamp = dosDateTime(modified ? new Date(modified) : new Date());

    open = { nameBytes, stamp, headerOffset: offset, crc: 0, size: 0, isDirectory };
    await emit(localHeader(nameBytes, stamp));
  }

  async function writeChunk(chunk) {
    if (!open) throw new Error('No open ZIP entry');
    if (!chunk || !chunk.length) return;
    open.crc = crc32(chunk, open.crc);
    open.size += chunk.length;
    if (open.size > ZIP32_LIMIT) {
      throw new Error('A single file exceeds the 4 GB ZIP limit');
    }
    await emit(chunk);
  }

  async function endEntry() {
    if (!open) throw new Error('No open ZIP entry');

    const descriptor = new ByteWriter(16);
    descriptor.u32(DESCRIPTOR_SIG).u32(open.crc).u32(open.size).u32(open.size);
    await emit(descriptor.bytes);

    central.push({ ...open });
    open = null;
  }

  return {
    /** Record an explicit directory, so empty folders survive the round trip. */
    async addDirectory(name, options = {}) {
      await startEntry(name, { ...options, isDirectory: true });
      await endEntry();
    },

    /**
     * Add one file. `source` is a Uint8Array, or a ReadableStream of them.
     */
    async addFile(name, source, options = {}) {
      await startEntry(name, options);

      if (source instanceof Uint8Array) {
        await writeChunk(source);
      } else if (source && typeof source.getReader === 'function') {
        const reader = source.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writeChunk(value instanceof Uint8Array ? value : new Uint8Array(value));
        }
      } else if (source) {
        throw new Error('ZIP source must be a Uint8Array or a ReadableStream');
      }

      await endEntry();
      return { crc: central[central.length - 1].crc, size: central[central.length - 1].size };
    },

    /** Write the central directory and end-of-archive record. */
    async finish() {
      if (open) throw new Error('A ZIP entry is still open');

      const directoryOffset = offset;

      for (const entry of central) {
        const writer = new ByteWriter(46 + entry.nameBytes.length);
        writer.u32(CENTRAL_SIG)
          .u16(VERSION)  // version made by
          .u16(VERSION)  // version needed
          .u16(FLAG_DATA_DESCRIPTOR | FLAG_UTF8)
          .u16(METHOD_STORE)
          .u16(entry.stamp.time)
          .u16(entry.stamp.date)
          .u32(entry.crc)
          .u32(entry.size)
          .u32(entry.size)
          .u16(entry.nameBytes.length)
          .u16(0)  // extra
          .u16(0)  // comment
          .u16(0)  // disk number
          .u16(0)  // internal attributes
          // External attributes: the high word carries Unix mode, and bit 4 of
          // the low byte is the MS-DOS directory flag.
          .u32(entry.isDirectory ? 0x41ed0010 : 0x81a40000)
          .u32(entry.headerOffset)
          .raw(entry.nameBytes);
        await emit(writer.bytes);
      }

      const directorySize = offset - directoryOffset;
      const eocd = new ByteWriter(22);
      eocd.u32(EOCD_SIG)
        .u16(0)  // this disk
        .u16(0)  // disk with the directory
        .u16(central.length)
        .u16(central.length)
        .u32(directorySize)
        .u32(directoryOffset)
        .u16(0); // no archive comment
      await emit(eocd.bytes);

      return { entries: central.length, bytes: offset };
    },

    get bytesWritten() { return offset; },
    get entryCount() { return central.length; }
  };
}
