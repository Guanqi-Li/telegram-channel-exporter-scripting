import { join } from "node:path"
import { mkdirSync } from "node:fs"
import { Archive, sleep } from "./archive"
import type { Checkpoint, Format } from "./archive"
import { Telegram, waitSeconds } from "./telegram"
import type { Channel } from "./telegram"

export const PAGE_ROOT = () => join(FileManager.appGroupDocumentsDirectory, "TelegramChannelExporter-v1")
const cooldownKey = (account: string) => `telegram-wait-${account}`

export function waitRemaining(account: string) {
  const resumeAt = Storage.get<number>(cooldownKey(account))
  return typeof resumeAt === "number" ? Math.max(0, Math.ceil((resumeAt - Date.now()) / 1000)) : 0
}

export function rememberWait(account: string, seconds: number) {
  if (seconds > waitRemaining(account)) Storage.set(cooldownKey(account), Date.now() + (seconds + 1) * 1000)
}

export async function readHistory(client: Telegram, channel: Channel, account: string, archive: Archive,
                                  signal: AbortSignal,
                                  progress: (state: Checkpoint, wait: number) => void) {
  let state = archive.read()
  let waitUntil = Date.now() + waitRemaining(account) * 1000
  while (!state.complete) {
    if (signal.aborted) return
    const seconds = Math.ceil((waitUntil - Date.now()) / 1000)
    if (seconds > 0) {
      progress(state, seconds)
      await sleep(1000, signal)
      continue
    }
    progress(state, 0)
    try {
      const page = await client.history(channel, state.cursor, signal)
      if (signal.aborted) return
      state = archive.advance(state, page)
    } catch (error) {
      const wait = waitSeconds(error)
      if (!wait) throw error
      rememberWait(account, wait)
      waitUntil = Date.now() + (wait + 1) * 1000
      continue
    }
    progress(state, 0)
    if (!state.complete) await sleep(1000, signal)
  }
}

export async function saveFile(archive: Archive, channel: Channel, format: Format,
                               progress: (status: string) => void) {
  const selected = await DocumentPicker.pickDirectory()
  if (!selected) return null
  const name = channel.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim()
  const safeName = [...name].slice(0, 36).join("") || "Telegram"
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
  const base = `${safeName}-${channel.id}-${timestamp}`
  let temporary: string | undefined
  try {
    temporary = join(FileManager.temporaryDirectory, `tg-export-${Date.now()}-${channel.id}`)
    mkdirSync(temporary, { recursive: true })
    let suffix = 1
    let fileName = `${base}.${format}`
    while (await FileManager.exists(join(selected, fileName))) fileName = `${base}-${++suffix}.${format}`

    const local = join(temporary, fileName)
    const file = FileEntity.openNewForWriting(local)
    try {
      await archive.writeOutput(channel.name, format, text => {
        const bytes = Data.fromRawString(text, "utf-8")
        if (!bytes) throw new Error("无法将导出内容编码为 UTF-8。")
        file.write(bytes)
      }, (done, total) => progress(`正在写入文件 · ${done} / ${total} 批`))
    } finally {
      file.close()
    }

    progress("正在将文件保存到所选文件夹…")
    await FileManager.copyFile(local, join(selected, fileName))
    return fileName
  } finally {
    try {
      if (temporary && await FileManager.exists(temporary)) await FileManager.remove(temporary)
    } finally {
      DocumentPicker.stopAcessingSecurityScopedResources()
    }
  }
}
