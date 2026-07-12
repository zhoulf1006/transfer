// 接收文件落盘(见 docs/DESIGN §7:.part 同目录→rename 防 EXDEV、重名去重、sha256 校验)

import { createWriteStream } from 'node:fs'
import { rename, unlink, open } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { sanitizeFileName } from '@shared/safe-name'

export interface ReceiveResult {
  /** 最终落盘的文件名(经 sanitize + 去重) */
  fileName: string
  /** 最终绝对路径 */
  path: string
  /** 实际写入字节数 */
  size: number
  /** 内容 sha256(hex) */
  sha256: string
}

/**
 * 把可读流写入接收目录。
 * - .part 临时文件与最终文件**同目录**(同盘),写完 rename —— 防 EXDEV(DESIGN §1.4)
 * - 文件名 sanitize 防逃逸;重名自动加后缀
 * - 边写边算 sha256
 * - 失败时删除 .part,抛错交调用方(该文件 upload → 500)
 *
 * @param expectedSha256 若提供,写完比对,不符则删文件并抛错
 */
export async function receiveFileToDir(
  stream: Readable,
  rawFileName: string,
  receiveDir: string,
  expectedSha256?: string
): Promise<ReceiveResult> {
  const safeName = sanitizeFileName(rawFileName)
  // 原子占位去重(S2 修复):用 O_EXCL(wx)独占创建最终文件名,消除 existsSync 的 TOCTOU。
  // 并发同名上传各自抢到不同名字(foo.bin / foo (1).bin ...),不会互相覆盖。
  const { finalName, finalPath } = await reserveName(receiveDir, safeName)
  // .part 放同目录(同盘),用随机后缀避免并发/重名撞车
  const partPath = join(receiveDir, `${finalName}.${randomUUID()}.part`)

  const hash = createHash('sha256')
  let size = 0
  const out = createWriteStream(partPath)

  stream.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    size += chunk.length
  })

  try {
    await pipeline(stream, out)
  } catch (err) {
    await cleanup(partPath, finalPath)
    throw err
  }

  const sha256 = hash.digest('hex')

  if (expectedSha256 && expectedSha256.toLowerCase() !== sha256.toLowerCase()) {
    await cleanup(partPath, finalPath)
    throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${sha256}`)
  }

  try {
    // rename 原子替换占位空文件(POSIX:目标存在则被替换),同目录不跨盘
    await rename(partPath, finalPath)
  } catch (err) {
    await cleanup(partPath, finalPath)
    throw err
  }

  return { fileName: finalName, path: finalPath, size, sha256 }
}

/**
 * 原子占位:循环用 O_EXCL(wx)独占创建 name / name (1) / name (2)...,
 * 第一个成功创建的即锁定为最终名(消除 existsSync 判重的 TOCTOU,S2 修复)。
 */
async function reserveName(
  dir: string,
  name: string
): Promise<{ finalName: string; finalPath: string }> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''

  for (let i = 0; ; i++) {
    const candidate = i === 0 ? name : `${stem} (${i})${ext}`
    const path = join(dir, candidate)
    try {
      const fh = await open(path, 'wx') // O_CREAT|O_EXCL,已存在则抛 EEXIST
      await fh.close()
      return { finalName: candidate, finalPath: path }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw err
    }
  }
}

/** 清理失败残留:.part 与占位文件都删。 */
async function cleanup(partPath: string, finalPath: string): Promise<void> {
  await safeUnlink(partPath)
  await safeUnlink(finalPath)
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await unlink(p)
  } catch {
    // 已不存在,忽略
  }
}
