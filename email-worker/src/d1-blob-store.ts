/**
 * D1BlobStore — drop-in replacement for R2Bucket backed by D1.
 *
 * Implements the subset of the R2Bucket interface actually used by OmniMail:
 *   get, put, delete, head, list
 *
 * Binary data is base64-encoded in a D1 `blobs` table.  Suitable for
 * personal/small-team deployments where R2 is not available.
 */

export interface D1BlobStoreOptions {
  db: D1Database
}

interface BlobRow {
  key: string
  value: string
  content_type: string
  size: number
  created_at: number
}

/* ------------------------------------------------------------------ */
/*  Minimal R2-compatible return types                                 */
/* ------------------------------------------------------------------ */

class D1R2Object {
  readonly key: string
  readonly size: number
  readonly httpMetadata: { contentType: string }
  readonly uploaded: Date

  constructor(row: BlobRow) {
    this.key = row.key
    this.size = row.size
    this.httpMetadata = { contentType: row.content_type }
    this.uploaded = new Date(row.created_at * 1000)
  }
}

class D1R2ObjectBody extends D1R2Object {
  private readonly _buf: ArrayBuffer

  constructor(row: BlobRow, buf: ArrayBuffer) {
    super(row)
    this._buf = buf
  }

  get body(): ReadableStream<Uint8Array> {
    return new Response(this._buf).body!
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this._buf)
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this._buf
  }

  async blob(): Promise<Blob> {
    return new Blob([this._buf], { type: this.httpMetadata.contentType })
  }
}

/* ------------------------------------------------------------------ */
/*  D1BlobStore                                                        */
/* ------------------------------------------------------------------ */

export class D1BlobStore {
  private readonly db: D1Database

  constructor(opts: D1BlobStoreOptions) {
    this.db = opts.db
  }

  /* ---------- get ---------- */

  async get(key: string): Promise<D1R2ObjectBody | null> {
    const row = await this.db.prepare(
      'SELECT key, value, content_type, size, created_at FROM blobs WHERE key = ?',
    ).bind(key).first<BlobRow>()
    if (!row) return null
    const buf = base64ToArrayBuffer(row.value)
    return new D1R2ObjectBody(row, buf)
  }

  /* ---------- head ---------- */

  async head(key: string): Promise<D1R2Object | null> {
    const row = await this.db.prepare(
      'SELECT key, value, content_type, size, created_at FROM blobs WHERE key = ?',
    ).bind(key).first<BlobRow>()
    if (!row) return null
    return new D1R2Object(row)
  }

  /* ---------- put ---------- */

  async put(
    key: string,
    value: string | ReadableStream | ArrayBuffer | ArrayBufferView | Blob | null,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<D1R2Object> {
    const contentType = options?.httpMetadata?.contentType ?? 'application/octet-stream'

    let bytes: Uint8Array
    if (value === null || value === undefined) {
      bytes = new Uint8Array(0)
    } else if (typeof value === 'string') {
      bytes = new TextEncoder().encode(value)
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value)
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    } else if (value instanceof Blob) {
      bytes = new Uint8Array(await value.arrayBuffer())
    } else if (typeof (value as ReadableStream).getReader === 'function') {
      // ReadableStream — read all chunks
      const reader = (value as ReadableStream<Uint8Array>).getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        chunks.push(chunk)
        total += chunk.byteLength
      }
      bytes = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) {
        bytes.set(c, offset)
        offset += c.byteLength
      }
    } else {
      // Fallback: try to treat as string
      bytes = new TextEncoder().encode(String(value))
    }

    const b64 = arrayBufferToBase64(bytes.buffer as ArrayBuffer)
    const size = bytes.byteLength

    await this.db.prepare(
      `INSERT INTO blobs (key, value, content_type, size, created_at)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         content_type = excluded.content_type,
         size = excluded.size,
         created_at = excluded.created_at`,
    ).bind(key, b64, contentType, size).run()

    const row: BlobRow = { key, value: '', content_type: contentType, size, created_at: 0 }
    return new D1R2Object(row)
  }

  /* ---------- delete ---------- */

  async delete(keys: string | string[]): Promise<void> {
    const arr = Array.isArray(keys) ? keys : [keys]
    if (!arr.length) return
    // D1 batch limit: process in chunks of 100
    for (let i = 0; i < arr.length; i += 100) {
      const chunk = arr.slice(i, i + 100)
      const stmts = chunk.map((k) =>
        this.db.prepare('DELETE FROM blobs WHERE key = ?').bind(k),
      )
      await this.db.batch(stmts)
    }
  }

  /* ---------- list ---------- */

  async list(options?: {
    prefix?: string
    limit?: number
    cursor?: string
  }): Promise<{
    objects: D1R2Object[]
    delimitedPrefixes: string[]
    truncated: boolean
    cursor?: string
  }> {
    const limit = Math.min(options?.limit ?? 1000, 1000)
    const prefix = options?.prefix ?? ''

    let query = 'SELECT key, value, content_type, size, created_at FROM blobs WHERE key LIKE ?'
    const params: unknown[] = [`${prefix}%`]

    if (options?.cursor) {
      query += ' AND key > ?'
      params.push(options.cursor)
    }

    query += ' ORDER BY key ASC LIMIT ?'
    params.push(limit + 1) // fetch one extra to detect truncation

    const { results } = await this.db.prepare(query).bind(...params).all<BlobRow>()
    const truncated = results.length > limit
    const objects = results.slice(0, limit).map((r) => new D1R2Object(r))

    return {
      objects,
      delimitedPrefixes: [],
      truncated,
      cursor: truncated ? objects[objects.length - 1]?.key : undefined,
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Base64 helpers (Workers runtime has btoa/atob)                     */
/* ------------------------------------------------------------------ */

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}
