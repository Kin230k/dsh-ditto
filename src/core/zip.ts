import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'

/**
 * A deliberately tiny, deterministic, store-only ZIP writer.
 *
 * Ditto ships no archive dependency and never runs a shell command, so the
 * archive is assembled byte by byte here. Every field that could vary between
 * machines is fixed: no timestamps, no host metadata, no compression, and
 * entries are written in the order they are given. Two runs over the same
 * reviewed outputs therefore produce byte-identical archives.
 */

const DOS_DATE = 0x0021 // 1980-01-01
const DOS_TIME = 0

export interface ZipEntry { name: string; bytes: Buffer }
export interface ZipFileEntry { name: string; path: string; size: number; checksum: number; contentHash: string }

const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffffffff

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function updateCrc32(value: number, bytes: Buffer): number {
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return value >>> 0
}

export function crc32(bytes: Buffer): number {
  return (updateCrc32(0xffffffff, bytes) ^ 0xffffffff) >>> 0
}

/** Inspect one regular file without buffering it, rejecting classic-ZIP overflow. */
export async function inspectZipFile(path: string): Promise<{ size: number; checksum: number; contentHash: string }> {
  let size = 0
  let value = 0xffffffff
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > UINT32_MAX) throw new Error(`A ZIP entry exceeds the 4 GiB classic-ZIP limit: ${path}`)
    value = updateCrc32(value, bytes)
    hash.update(bytes)
  }
  return { size, checksum: (value ^ 0xffffffff) >>> 0, contentHash: hash.digest('hex') }
}

/** Entry names are relative, forward-slashed, and never traversing. */
export function assertSafeEntryName(name: string): void {
  if (name.length === 0 || name.length > 400) throw new Error('A zip entry name must be 1–400 characters')
  if (name.includes('\0') || name.includes('\\')) throw new Error(`A zip entry name may not contain a backslash or NUL: ${name}`)
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`A zip entry name must be relative: ${name}`)
  const segments = name.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) throw new Error(`A zip entry name must not contain empty, "." or ".." segments: ${name}`)
}

/** Stream a deterministic classic ZIP to a new file without buffering payloads. */
export async function writeZipFile(entries: readonly ZipFileEntry[], output: string): Promise<void> {
  validateEntries(entries)
  if (entries.length > UINT16_MAX) throw new Error('A ZIP may contain at most 65,535 entries without Zip64')
  const file = await open(output, 'wx')
  const centrals: Buffer[] = []
  let offset = 0
  try {
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > UINT32_MAX) throw new Error(`A ZIP entry exceeds the classic-ZIP size limit: ${entry.name}`)
      const nameBytes = Buffer.from(entry.name, 'utf8')
      if (nameBytes.length > UINT16_MAX) throw new Error(`A ZIP entry name is too long in UTF-8: ${entry.name}`)
      const local = localHeader(nameBytes, entry.checksum, entry.size)
      if (offset + local.length + entry.size > UINT32_MAX) throw new Error('The ZIP exceeds the 4 GiB classic-ZIP offset limit; split the batch or disable the archive')
      await file.write(local)
      let written = 0
      let checksum = 0xffffffff
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(entry.path)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        await file.write(bytes)
        written += bytes.length
        checksum = updateCrc32(checksum, bytes)
        hash.update(bytes)
      }
      const finalChecksum = (checksum ^ 0xffffffff) >>> 0
      if (written !== entry.size || finalChecksum !== entry.checksum || hash.digest('hex') !== entry.contentHash) throw new Error(`A ZIP input changed while it was being archived: ${entry.name}`)
      centrals.push(centralHeader(nameBytes, entry.checksum, entry.size, offset))
      offset += local.length + entry.size
    }
    const centralBytes = Buffer.concat(centrals)
    if (offset + centralBytes.length + 22 > UINT32_MAX) throw new Error('The ZIP exceeds the 4 GiB classic-ZIP limit; split the batch or disable the archive')
    await file.write(centralBytes)
    await file.write(endHeader(entries.length, centralBytes.length, offset))
  } catch (error) {
    await file.close().catch(() => undefined)
    await rm(output, { force: true }).catch(() => undefined)
    throw error
  }
  await file.close()
}

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > UINT16_MAX) throw new Error('A ZIP may contain at most 65,535 entries without Zip64')
  const seen = new Set<string>()
  for (const entry of entries) {
    assertSafeEntryName(entry.name)
    const key = entry.name.toLocaleLowerCase('en-US')
    if (seen.has(key)) throw new Error(`Two zip entries would use the same name: ${entry.name}`)
    seen.add(key)
  }
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    if (nameBytes.length > UINT16_MAX) throw new Error(`A ZIP entry name is too long in UTF-8: ${entry.name}`)
    if (entry.bytes.length > UINT32_MAX || offset + 30 + nameBytes.length + entry.bytes.length > UINT32_MAX) throw new Error('The ZIP exceeds the 4 GiB classic-ZIP limit')
    const checksum = crc32(entry.bytes)
    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)      // version needed
    local.writeUInt16LE(0x0800, 6)  // UTF-8 names, no data descriptor
    local.writeUInt16LE(0, 8)       // stored, no compression
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.bytes.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)      // no extra field
    nameBytes.copy(local, 30)
    locals.push(local, entry.bytes)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)    // version made by
    central.writeUInt16LE(20, 6)    // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(entry.bytes.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)    // extra
    central.writeUInt16LE(0, 32)    // comment
    central.writeUInt16LE(0, 34)    // disk number
    central.writeUInt16LE(0, 36)    // internal attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38) // deterministic regular-file mode
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    centrals.push(central)

    offset += local.length + entry.bytes.length
  }
  const centralBytes = Buffer.concat(centrals)
  if (offset + centralBytes.length + 22 > UINT32_MAX) throw new Error('The ZIP exceeds the 4 GiB classic-ZIP limit')
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBytes, end])
}

function validateEntries(entries: readonly { name: string }[]): void {
  const seen = new Set<string>()
  for (const entry of entries) {
    assertSafeEntryName(entry.name)
    const key = entry.name.toLocaleLowerCase('en-US')
    if (seen.has(key)) throw new Error(`Two zip entries would use the same name: ${entry.name}`)
    seen.add(key)
  }
}

function localHeader(nameBytes: Buffer, checksum: number, size: number): Buffer {
  const local = Buffer.alloc(30 + nameBytes.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt16LE(DOS_TIME, 10)
  local.writeUInt16LE(DOS_DATE, 12)
  local.writeUInt32LE(checksum >>> 0, 14)
  local.writeUInt32LE(size, 18)
  local.writeUInt32LE(size, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  local.writeUInt16LE(0, 28)
  nameBytes.copy(local, 30)
  return local
}

function centralHeader(nameBytes: Buffer, checksum: number, size: number, offset: number): Buffer {
  const central = Buffer.alloc(46 + nameBytes.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt16LE(DOS_TIME, 12)
  central.writeUInt16LE(DOS_DATE, 14)
  central.writeUInt32LE(checksum >>> 0, 16)
  central.writeUInt32LE(size, 20)
  central.writeUInt32LE(size, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  central.writeUInt32LE(offset, 42)
  nameBytes.copy(central, 46)
  return central
}

function endHeader(entries: number, centralSize: number, centralOffset: number): Buffer {
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries, 8)
  end.writeUInt16LE(entries, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)
  return end
}
