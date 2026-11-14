import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type RecordEntry = { id: number; timestamp: number; text: string }
export type HistoryPage = { ids: number[]; entries: RecordEntry[] }
export type Format = "txt" | "json"
export type Checkpoint = {
  version: 1
  pages: number
  cursor: number
  count: number
  complete: boolean
}

const defaultCheckpoint: Checkpoint = { version: 1, pages: 0, cursor: 0, count: 0, complete: false }
const messageId = (value: number) => Number.isSafeInteger(value) && value > 0

function atomicWrite(path: string, contents: string) {
  const temporary = path + ".pending"
  writeFileSync(temporary, contents, "utf8")
  renameSync(temporary, path)
}

export class Archive {
  private readonly directory: string
  private readonly checkpointFile: string

  constructor(root: string, account: string, channel: string) {
    if (!/^\d+$/.test(account) || !/^\d+$/.test(channel)) throw new Error("频道或账号标识无效。")
    this.directory = join(root, account, channel)
    this.checkpointFile = join(this.directory, "checkpoint.json")
  }

  read(): Checkpoint {
    if (!existsSync(this.checkpointFile)) return { ...defaultCheckpoint }
    const data: Checkpoint = JSON.parse(readFileSync(this.checkpointFile, "utf8"))
    if (data?.version !== 1 || !Number.isSafeInteger(data.pages) || data.pages < 0 ||
        !Number.isSafeInteger(data.count) || data.count < 0 || typeof data.complete !== "boolean" ||
        (data.pages ? !messageId(data.cursor) || !existsSync(this.pageFile(data.pages)) :
          data.cursor !== 0 || data.count !== 0)) throw new Error("频道的本地断点无法读取。")
    return data
  }

  advance(current: Checkpoint, page: HistoryPage): Checkpoint {
    if (current.complete) return current
    const ids = page.ids.filter(id => messageId(id) && (!current.cursor || id < current.cursor))
    if (!ids.length && page.ids.length) throw new Error("Telegram 返回的历史页未推进，已保留断点。")

    mkdirSync(this.directory, { recursive: true })
    if (!ids.length) {
      const done: Checkpoint = { ...current, complete: true }
      atomicWrite(this.checkpointFile, JSON.stringify(done))
      return done
    }

    const allowed = new Set(ids)
    const entries = page.entries.filter(entry => allowed.delete(entry.id))
      .sort((first, second) => first.id - second.id)
    const next: Checkpoint = {
      version: 1, pages: current.pages + 1, cursor: Math.min(...ids),
      count: current.count + entries.length, complete: ids.includes(1),
    }

    // A page becomes visible only when the checkpoint referencing it is committed.
    atomicWrite(this.pageFile(next.pages), JSON.stringify(entries))
    atomicWrite(this.checkpointFile, JSON.stringify(next))
    return next
  }

  async writeOutput(title: string, format: Format, write: (value: string) => void,
                    onProgress: (pages: number, total: number) => void) {
    const state = this.read()
    if (!state.complete) throw new Error("请先完成频道历史读取。")
    const { count, pages } = state
    const json = format === "json"
    write(json ? `{"channel":${JSON.stringify(title)},"count":${count},"messages":[` :
      `频道：${title}\n共 ${count} 条文字消息 · 时间为 UTC\n\n`)
    let written = 0
    let previousId = 0
    for (let page = pages; page > 0; page--) {
      const entries: RecordEntry[] = JSON.parse(readFileSync(this.pageFile(page), "utf8"))
      const parts: string[] = []
      if (!Array.isArray(entries)) throw new Error("本地消息分段损坏。")
      for (const { id, timestamp, text } of entries) {
        if (!messageId(id) || id <= previousId || !Number.isFinite(timestamp) || typeof text !== "string") {
          throw new Error("本地消息分段损坏或顺序异常。")
        }
        previousId = id
        const date = new Date(timestamp * 1000).toISOString()
        parts.push(json ? (written ? ",\n" : "\n") + JSON.stringify({ id, date, text }) :
          `[${date}] #${id}\n${text}\n\n`)
        written++
      }
      if (parts.length) write(parts.join(""))
      if ((pages - page + 1) % 24 === 0 || page === 1) {
        onProgress(pages - page + 1, pages)
        await sleep(1)
      }
    }
    if (written !== count) throw new Error("本地消息数量与断点不一致。")
    if (json) write(written ? "\n]}\n" : "]}\n")
  }

  remove() {
    rmSync(this.directory, { recursive: true, force: true })
  }

  private pageFile(index: number) { return join(this.directory, `page-${index}.json`) }
}

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const abort = () => { clearTimeout(timer); reject(signal?.reason) }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
}
