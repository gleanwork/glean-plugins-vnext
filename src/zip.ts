// Minimal ZIP reader for skill bundles downloaded from Glean's Platform API
// (`GET /api/skills/{id}/content` returns a .zip / .skill archive). Node has
// no stdlib zip reader and the plugin ships as a single bundled file, so a
// ~60-line central-directory reader beats adding a dependency.
//
// ponytail: stored + deflate only, no zip64, no CRC verification. Skill
// bundles are small text archives; if Glean ever emits zip64 or another
// compression method we throw a clear error rather than guess.
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CD_ENTRY_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOCAL_SIG;
}

/**
 * Extract every file entry from a ZIP archive. Returns a map of
 * slash-separated entry path to raw bytes. Directory entries are skipped.
 */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buf);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdOffset === 0xffffffff) {
    throw new Error("zip64 archives are not supported");
  }

  const files = new Map<string, Buffer>();
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_ENTRY_SIG) {
      throw new Error(`malformed zip: bad central directory entry ${i}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf-8");
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
      throw new Error(`zip64 entry is not supported: ${name}`);
    }

    // Data sits after the *local* header, whose extra field can differ in
    // length from the central directory's, so read the length from there.
    if (localOffset + 30 > buf.length) {
      throw new Error(`malformed zip: local header out of range for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    if (start + compSize > buf.length) {
      throw new Error(`malformed zip: truncated entry ${name}`);
    }
    const raw = buf.subarray(start, start + compSize);

    if (method === 0) {
      files.set(name, Buffer.from(raw));
    } else if (method === 8) {
      files.set(name, inflateRawSync(raw));
    } else {
      throw new Error(
        `unsupported zip compression method ${method} for ${name}`,
      );
    }
  }
  return files;
}

function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - (MAX_COMMENT + 22));
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("malformed zip: end-of-central-directory record not found");
}
