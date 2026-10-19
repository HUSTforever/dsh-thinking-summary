#!/usr/bin/env node
/**
 * Minimal read-only ASAR reader (no dependencies).
 *
 * Usage:
 *   node asar.mjs list   <archive> <dirPath>        # list entries under a virtual dir
 *   node asar.mjs extract <archive> <filePath> <out># extract one file
 *   node asar.mjs size   <archive> <filePath>       # print file size
 */
import { createReadStream, statSync } from 'node:fs'
import { open, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const [, , command, archive, arg1, arg2] = process.argv

if (!command || !archive) {
  console.error('usage: node asar.mjs <list|extract|size> <archive> <path> [out]')
  process.exit(2)
}

const fd = await open(archive, 'r')

async function readExact(position, length) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await fd.read(buffer, 0, length, position)
  if (bytesRead !== length) throw new Error(`short read at ${position}`)
  return buffer
}

const sizeBuf = await readExact(0, 8)
const headerPickleSize = sizeBuf.readUInt32LE(4)
const headerBuf = await readExact(8, headerPickleSize)
// Pickle: uint32 payload size, then uint32 string length, then JSON.
const jsonLength = headerBuf.readUInt32LE(4)
const headerJson = headerBuf.subarray(8, 8 + jsonLength).toString('utf8')
const header = JSON.parse(headerJson)
const dataStart = 8 + headerPickleSize

function walk(nodes, prefix) {
  const out = []
  for (const [name, entry] of Object.entries(nodes)) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files) out.push(...walk(entry.files, path))
    else out.push({ path, size: Number(entry.size), offset: Number(entry.offset) })
  }
  return out
}

const allFiles = walk(header.files, '')

if (command === 'list') {
  const dir = (arg1 ?? '').replace(/^\/+|\/+$/g, '')
  const prefix = dir === '' ? '' : `${dir}/`
  const depth = prefix === '' ? 1 : prefix.split('/').length
  const names = new Set()
  for (const file of allFiles) {
    if (!file.path.startsWith(prefix)) continue
    const rest = file.path.slice(prefix.length).split('/')
    if (rest.length === depth) names.add(rest.join('/'))
    else names.add(`${rest[0]}/`)
  }
  for (const name of [...names].sort()) console.log(name)
} else if (command === 'size') {
  const file = allFiles.find((candidate) => candidate.path === arg1)
  if (!file) throw new Error(`not found: ${arg1}`)
  console.log(file.size)
} else if (command === 'extract') {
  const file = allFiles.find((candidate) => candidate.path === arg1)
  if (!file) throw new Error(`not found: ${arg1}`)
  const outPath = arg2 ?? arg1.split('/').pop()
  await mkdir(dirname(outPath), { recursive: true })
  const chunks = []
  const stream = createReadStream(archive, {
    start: dataStart + file.offset,
    end: dataStart + file.offset + file.size - 1,
  })
  for await (const chunk of stream) chunks.push(chunk)
  await writeFile(outPath, Buffer.concat(chunks))
  console.log(`${outPath} (${file.size} bytes)`)
} else {
  throw new Error(`unknown command: ${command}`)
}

await fd.close()
void statSync
