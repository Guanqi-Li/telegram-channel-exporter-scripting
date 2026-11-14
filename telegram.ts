import { Api, FloodWaitError, Logger, LogLevel, StringSession, TelegramClient, bigInt } from "./mtproto"
import type { HistoryPage } from "./archive"

export type Credentials = { apiId: number; apiHash: string }
export type SavedLogin = Credentials & { session: string; account: string; label: string }
export type Channel = { id: string; name: string; username?: string; peer: Api.InputPeerChannel }
export type LoginPrompts = {
  code: (viaApp: boolean) => Promise<string>
  password: (hint?: string) => Promise<string>
  email: () => Promise<string>
  emailCode: () => Promise<string>
  invalid: (message: string) => Promise<void>
}

export const LOGIN_KEY = "telegram-login-v1"
export const API_KEY = "telegram-api-v1"
const localKeychain = { synchronizable: false } as const
const damagedLogin = "钥匙串中的登录记录损坏，请在设置中清除本机会话。"

function keychainError(action: string, cause?: unknown) {
  const detail = typeof Keychain === "undefined"
    ? "当前 Scripting 运行环境未提供钥匙串接口。请更新 Scripting，并在 App 内直接运行脚本。"
    : `无法${action} iOS 钥匙串。请解锁 iPhone，并在 Scripting App 内重试。`
  return new Error(detail, { cause })
}

function readSecret(key: string): string | null {
  try {
    // Check existence before reading. Some versions throw when reading a missing item.
    if (typeof Keychain.contains === "function" && !Keychain.contains(key, localKeychain)) return null
    return Keychain.get(key, localKeychain) ?? null
  } catch (cause) {
    throw keychainError("读取", cause)
  }
}

export function loadLogin(): SavedLogin | null {
  const raw = readSecret(LOGIN_KEY)
  if (raw === null) return null

  let value: SavedLogin
  try { value = JSON.parse(raw) }
  catch { throw new Error(damagedLogin) }
  if (!value || typeof value.account !== "string" || !/^\d+$/.test(value.account) ||
      !validAPI(value.apiId, value.apiHash) || typeof value.session !== "string" ||
      !value.session || typeof value.label !== "string") throw new Error(damagedLogin)
  return value
}

export function loadAPI(): Credentials | null {
  const raw = readSecret(API_KEY)
  if (raw === null) return null
  try {
    const entry: Credentials = JSON.parse(raw)
    return validAPI(entry.apiId, entry.apiHash) ? entry : null
  } catch { return null }
}

export function validAPI(id: number, hash: string) {
  return Number.isInteger(id) && id > 0 && id <= 2147483647 &&
    typeof hash === "string" && /^[0-9a-f]{32}$/i.test(hash)
}

export function saveSecret(key: string, object: Credentials | SavedLogin) {
  try {
    const serialized = JSON.stringify(object)
    const saved = Keychain.set(key, serialized, {
      ...localKeychain, accessibility: "first_unlock_this_device",
    })
    if (saved === true || (saved == null && Keychain.get(key, localKeychain) === serialized)) return
  } catch (cause) {
    throw keychainError("写入", cause)
  }
  throw keychainError("写入")
}

export function clearSecret(key: string) {
  let removalError: unknown
  try {
    // A malformed or unreadable value must still be removable.
    if (typeof Keychain.contains === "function" && !Keychain.contains(key, localKeychain)) return
    if (Keychain.remove(key, localKeychain) === true) return
  } catch (cause) {
    removalError = cause
  }
  if (readSecret(key) === null) return
  throw keychainError("清除", removalError)
}

function rpcCode(error: unknown): string {
  if (error instanceof Error) {
    const candidate = (error as Error & { errorMessage?: string }).errorMessage || ""
    if (/^[A-Z][A-Z0-9_]+$/.test(candidate)) return candidate
  }
  return ""
}

export function sessionExpired(error: unknown) {
  return ["AUTH_KEY_UNREGISTERED", "SESSION_EXPIRED", "SESSION_REVOKED", "AUTH_KEY_DUPLICATED",
    "AUTH_KEY_INVALID"].includes(rpcCode(error))
}

export function waitSeconds(error: unknown): number {
  if (error instanceof FloodWaitError) return Math.max(0, error.seconds)
  const seconds = /^FLOOD_(?:PREMIUM_|TEST_PHONE_)?WAIT_(\d+)$/.exec(rpcCode(error))
  return seconds ? Number(seconds[1]) : 0
}

const errors: Record<string, string> = {
  API_ID_INVALID: "Telegram 拒绝了这组 API ID 或 API Hash，请在设置中重新填写。",
  API_ID_PUBLISHED_FLOOD: "Telegram 限制了这组 API 凭据，请使用自己申请的 API ID 和 API Hash。",
  PHONE_NUMBER_INVALID: "请检查手机号和国际区号。",
  PHONE_NUMBER_BANNED: "Telegram 已限制此手机号登录。",
  PHONE_CODE_INVALID: "验证码有误，请重新输入。",
  PHONE_CODE_EMPTY: "请输入验证码。",
  PHONE_CODE_EXPIRED: "验证码已过期，请重新开始登录。",
  PASSWORD_HASH_INVALID: "两步验证密码有误，请重试。",
  CODE_INVALID: "邮箱验证码有误，请重试。",
  EMAIL_INVALID: "邮箱地址无效。",
  CHANNEL_PRIVATE: "Telegram 已限制当前账号读取此频道。已写入的断点仍保存在本机。",
  CHANNEL_INVALID: "频道不可用，请刷新频道列表后重试。",
  USER_DEACTIVATED: "此 Telegram 账号已停用。",
}

export function explain(error: unknown, fallback: string): string {
  if (sessionExpired(error)) return "Telegram 会话已失效，请清除本机会话后重新登录。"
  const seconds = waitSeconds(error)
  if (seconds) return `Telegram 限速，请等待 ${seconds} 秒后再试。`
  const code = rpcCode(error)
  if (code) return errors[code] || `Telegram 返回错误（${code}）。`
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || /ECONN|ENET|timed out|socket|CONNECTION_DEAD/i.test(error.message))
      return "连接 Telegram 超时或中断。请检查当前网络能否连接 Telegram，再重试。"
    if (/^[\u3400-\u9fff]/.test(error.message)) return error.message
    if (error.message.startsWith("Telegram requires a payment")) return "Telegram 要求使用官方客户端完成该号码的付费验证码流程。"
    if (error.message.startsWith("No account is registered")) return "该手机号没有已注册的 Telegram 账号。"
  }
  return fallback
}

// Set a deadline on library-internal calls too, including sign-in and dialog paging.
class PhoneClient extends TelegramClient<StringSession> {
  override invoke<R extends Api.AnyRequest>(request: R, dcId?: number,
                                            options?: Api.ApiCallOptions): Promise<R["__response"]> {
    return super.invoke(request, dcId, { timeout: 30000, ...options })
  }
}

export class Telegram {
  private readonly client: PhoneClient
  private readonly session: StringSession
  private ready = false

  constructor(private readonly api: Credentials, session = "") {
    this.session = new StringSession(session)
    this.client = new PhoneClient(this.session, api.apiId, api.apiHash, {
      timeout: 10, connectionRetries: 2, reconnectRetries: 2,
      requestRetries: 2, floodSleepThreshold: 0,
      catchUp: false, baseLogger: new Logger(LogLevel.NONE), deviceModel: "Scripting for iPhone",
      langCode: "zh-hans", systemLangCode: "zh-hans",
    })
  }

  private async connect() {
    if (this.ready && this.client.connected) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.client.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.client.destroy().catch(() => {})
            reject(Object.assign(new Error("Unable to connect"), { name: "TimeoutError" }))
          }, 25000)
        }),
      ])
      this.ready = true
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async signIn(phoneNumber: string, prompts: LoginPrompts): Promise<SavedLogin> {
    await this.connect()
    const profile = await this.client.signInUser(this.api, {
      phoneNumber,
      phoneCode: async (viaApp) => prompts.code(!!viaApp),
      password: prompts.password,
      emailAddress: prompts.email,
      emailVerification: prompts.emailCode,
      onError: async error => {
        if (["PHONE_CODE_INVALID", "PHONE_CODE_EMPTY", "PASSWORD_HASH_INVALID", "CODE_INVALID", "EMAIL_INVALID"]
            .includes(rpcCode(error))) {
          await prompts.invalid(explain(error, "请重试。"))
          return false
        }
        throw error
      },
    })
    if (!(profile instanceof Api.User)) throw new Error("Telegram 未返回账号信息。")
    return this.loginRecord(profile)
  }

  async restore(signal?: AbortSignal): Promise<SavedLogin> {
    const closeOnAbort = () => { void this.close().catch(() => {}) }
    if (signal?.aborted) throw signal.reason
    signal?.addEventListener("abort", closeOnAbort, { once: true })
    try {
      await this.connect()
      const self = await this.client.invoke(new Api.users.GetUsers({ id: [new Api.InputUserSelf()] }),
        undefined, { abortSignal: signal })
      const profile = self.find((user): user is Api.User => user instanceof Api.User)
      if (!profile) throw new Error("Telegram 未返回账号信息。")
      return this.loginRecord(profile)
    } finally {
      signal?.removeEventListener("abort", closeOnAbort)
    }
  }

  private loginRecord(profile: Api.User): SavedLogin {
    const session = this.session.save()
    if (!session) throw new Error("Telegram 未生成可保存的登录会话。")
    return {
      ...this.api, session, account: profile.id.toString(),
      label: [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
        (profile.username ? "@" + profile.username : "Telegram 用户"),
    }
  }

  async channels(onBatch: (channels: Channel[]) => void) {
    await this.connect()
    const found = new Map<string, Channel>()
    for (const archived of [false, true]) {
      let sinceUpdate = 0
      for await (const { entity, inputEntity } of this.client.iterDialogs({ archived })) {
        if (entity instanceof Api.Channel && entity.broadcast && !entity.left &&
            inputEntity instanceof Api.InputPeerChannel) {
          const id = entity.id.toString()
          found.set(id, {
            id, name: entity.title,
            username: entity.username || entity.usernames?.find(alias => alias.active)?.username,
            peer: inputEntity,
          })
          if (++sinceUpdate % 20 === 0) onBatch([...found.values()])
        }
      }
      onBatch([...found.values()])
    }
  }

  async history(channel: Channel, cursor: number, signal: AbortSignal): Promise<HistoryPage> {
    await this.connect()
    const result = await this.client.invoke(new Api.messages.GetHistory({
      peer: channel.peer, offsetId: cursor, offsetDate: 0, addOffset: 0,
      limit: 100, maxId: 0, minId: 0, hash: bigInt.zero,
    }), undefined, { abortSignal: signal })
    if (!("messages" in result)) throw new Error("Telegram 未返回历史消息，请重试。")
    const page: HistoryPage = { ids: [], entries: [] }
    for (const message of result.messages) {
      page.ids.push(message.id)
      if (message instanceof Api.Message && message.message) {
        page.entries.push({ id: message.id, timestamp: message.date, text: message.message })
      }
    }
    return page
  }

  async signOut() {
    await this.connect()
    await this.client.invoke(new Api.auth.LogOut())
  }

  async close() { await this.client.destroy() }
}
