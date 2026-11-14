import {
  Button, ForEach, HStack, Label, List, Navigation, NavigationStack,
  ProgressView, Script, Section, SecureField, Text, TextField, VStack, useRef, useState,
} from "scripting"
import { rmSync } from "node:fs"
import { Archive } from "./archive"
import type { Checkpoint, Format } from "./archive"
import { PAGE_ROOT, readHistory, rememberWait, saveFile, waitRemaining } from "./exporter"
import {
  API_KEY, LOGIN_KEY, Telegram, clearSecret, explain, loadAPI, loadLogin,
  saveSecret, sessionExpired, validAPI, waitSeconds,
} from "./telegram"
import type { Channel, Credentials, SavedLogin } from "./telegram"

type Operation = "login" | "channels" | "export" | "save" | "settings" | "signout"
type Page = "home" | "channels" | "settings" | "login" | "api"
type Runtime = {
  client?: Telegram
  work?: AbortController
  operation?: Operation
  closing: boolean
}
const CANCELLED = "AUTH_USER_CANCEL"

type Challenge = {
  kind: "code" | "password" | "email"
  title: string
  detail?: string
}
type PendingChallenge = {
  resolve: (value: string) => void
  reject: (error: Error) => void
}

async function closeClient(runtime: Runtime) {
  const client = runtime.client
  delete runtime.client
  if (client) await client.close().catch(() => {})
}

function ExporterView({ runtime, saved, startupError }: {
  runtime: Runtime; saved: SavedLogin | null; startupError?: string
}) {
  const dismiss = Navigation.useDismiss()
  const [login, setLogin] = useState(saved)
  const [page, setPage] = useState<Page>("home")
  const [operation, setOperation] = useState<Operation | undefined>(undefined)
  const [channels, setChannels] = useState<Channel[]>([])
  const [selected, setSelected] = useState<Channel | null>(null)
  const [query, setQuery] = useState("")
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null)
  const [status, setStatus] = useState(startupError || "")
  const [cancelling, setCancelling] = useState(false)
  const confirmOpen = useRef(false)

  const [apiId, setApiId] = useState("")
  const [apiHash, setApiHash] = useState("")
  const [phone, setPhone] = useState("")
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [reply, setReply] = useState("")
  const pending = useRef<PendingChallenge | null>(null)

  function openCredentials(destination: "api" | "login") {
    setApiId("")
    setApiHash("")
    setPhone("")
    setStatus("")
    setPage(destination)
  }

  function credentials(reuseSaved: boolean): Credentials {
    const id = apiId.trim()
    const hash = apiHash.trim()
    if (reuseSaved && !id && !hash) {
      const api = loadAPI()
      if (api) return api
    }
    if (!/^\d+$/.test(id) || !validAPI(Number(id), hash)) {
      throw new Error("请填写数字 API ID 和 32 位十六进制 API Hash。")
    }
    return { apiId: Number(id), apiHash: hash }
  }

  function requestInput(input: Challenge) {
    if (runtime.closing) return Promise.reject(new Error(CANCELLED))
    return new Promise<string>((resolve, reject) => {
      pending.current = { resolve, reject }
      setReply("")
      setChallenge(input)
    })
  }

  function submitInput(cancel: boolean) {
    const waiting = pending.current
    if (!waiting) return
    const value = challenge?.kind === "password" ? reply : reply.trim()
    if (!cancel && !value) return
    pending.current = null
    setReply("")
    setChallenge(null)
    setStatus("")
    if (cancel) waiting.reject(new Error(CANCELLED))
    else waiting.resolve(value)
  }

  function perform(kind: Operation, fallback: string, action: () => Promise<void>) {
    if (runtime.closing || runtime.operation) return
    runtime.operation = kind
    setOperation(kind)
    setStatus("")
    void action().catch(async error => {
      if (runtime.closing || (error instanceof Error && error.message === CANCELLED)) return
      if (login && waitSeconds(error)) rememberWait(login.account, waitSeconds(error))
      if (sessionExpired(error)) await closeClient(runtime)
      if (!runtime.closing) setStatus(explain(error, fallback))
    }).finally(() => {
      runtime.operation = undefined
      if (!runtime.closing) setOperation(undefined)
    })
  }

  async function connection(account: SavedLogin, signal?: AbortSignal) {
    if (runtime.client) return runtime.client
    const client = new Telegram(account, account.session)
    runtime.client = client
    try {
      const current = await client.restore(signal)
      if (current.account !== account.account) throw new Error("本机会话对应的 Telegram 账号发生变化，请清除会话后重新登录。")
      if (current.session !== account.session) saveSecret(LOGIN_KEY, current)
      return client
    } catch (error) {
      await closeClient(runtime)
      throw error
    }
  }

  function signIn() {
    perform("login", "登录失败。请检查网络与 API 配置后重试。", async () => {
      if (loadLogin()) throw new Error("本机已有登录会话，请重新打开脚本。")
      const number = phone.replace(/[\s()-]/g, "")
      if (!/^\+[1-9]\d{6,14}$/.test(number)) throw new Error("请填写带国际区号的手机号，例如 +86 开头。")
      const api = credentials(true)
      saveSecret(API_KEY, api)
      const client = new Telegram(api)
      runtime.client = client
      try {
        const account = await client.signIn(number, {
          code: viaApp => requestInput({
            kind: "code", title: "Telegram 登录验证码",
            detail: viaApp ? "请打开已登录的 Telegram，查看官方发来的验证码。" : "请输入 Telegram 发给你的验证码。",
          }),
          password: hint => requestInput({
            kind: "password", title: "两步验证密码",
            detail: hint ? `密码提示：${hint}` : undefined,
          }),
          email: () => requestInput({ kind: "email", title: "Telegram 登录邮箱" }),
          emailCode: () => requestInput({ kind: "code", title: "邮箱验证码" }),
          invalid: async message => { if (!runtime.closing) setStatus(message) },
        })
        if (!runtime.closing) {
          saveSecret(LOGIN_KEY, account)
          setLogin(account)
          setApiHash("")
          setPhone("")
          setPage("home")
          setStatus("登录成功。")
        }
      } catch (error) {
        await closeClient(runtime)
        throw error
      }
    })
  }

  function loadChannels() {
    if (!login) return
    perform("channels", "无法读取频道，请检查网络后重试。", async () => {
      const wait = waitRemaining(login.account)
      if (wait) {
        setStatus(`Telegram 限速，请等待 ${wait} 秒再刷新。`)
        return
      }
      const client = await connection(login)
      let latest: Channel[] = []
      await client.channels(batch => {
        latest = batch
        if (!runtime.closing && batch.length) setChannels(old => {
          const updated = new Map(old.map(channel => [channel.id, channel]))
          for (const channel of batch) updated.set(channel.id, channel)
          return [...updated.values()]
        })
      })
      if (runtime.closing) return
      setChannels(latest)
      const updated = latest.find(channel => channel.id === selected?.id)
      if (selected) {
        setSelected(updated ?? null)
        if (!updated) setCheckpoint(null)
      }
      if (!latest.length) setStatus("当前账号没有已加入的频道。")
    })
  }

  function select(channel: Channel) {
    if (!login || runtime.operation) return
    setSelected(channel)
    setQuery("")
    setPage("home")
    setStatus("")
    try {
      setCheckpoint(new Archive(PAGE_ROOT(), login.account, channel.id).read())
    } catch (error) {
      setCheckpoint(null)
      setStatus(explain(error, "无法读取此频道的本地断点。"))
    }
  }

  function start() {
    if (!login || !selected) return
    perform("export", "导出中断。已保存的分页可在下次继续。", async () => {
      const controller = new AbortController()
      runtime.work = controller
      try {
        const client = await connection(login, controller.signal)
        if (controller.signal.aborted) return
        const archive = new Archive(PAGE_ROOT(), login.account, selected.id)
        await readHistory(client, selected, login.account, archive, controller.signal, (state, wait) => {
          if (runtime.closing) return
          setCheckpoint(state)
          setStatus(wait ? `Telegram 限速，${wait} 秒后自动继续。` :
            state.complete ? "历史读取完成，可以保存文件。" : "正在分页读取频道历史…")
        })
      } catch (error) {
        if (!controller.signal.aborted) throw error
      } finally {
        if (controller.signal.aborted && !runtime.closing) {
          setStatus("已暂停，断点已保留。")
        }
        delete runtime.work
      }
    })
  }

  async function erase() {
    if (!login || !selected || confirmOpen.current) return
    confirmOpen.current = true
    setCancelling(true)
    try {
      if (!await Dialog.confirm({
        title: "清除此频道的导出进度？",
        message: "将删除本机的历史分页和断点。已经存入「文件」App 的导出文件会保留。",
        cancelLabel: "返回", confirmLabel: "清除",
      })) return
      runtime.work?.abort()
      setStatus("正在停止导出…")
      while (runtime.operation === "export" && !runtime.closing) {
        await new Promise(resolve => setTimeout(resolve, 75))
      }
      if (runtime.closing || runtime.operation) return
      const archive = new Archive(PAGE_ROOT(), login.account, selected.id)
      archive.remove()
      setCheckpoint(archive.read())
      setStatus("已清除此频道的本地进度。")
    } catch (error) {
      setStatus(explain(error, "无法清除本地进度。"))
    } finally {
      confirmOpen.current = false
      setCancelling(false)
    }
  }

  function save(format: Format) {
    if (!login || !selected) return
    perform("save", "文件保存失败，请检查目标位置的权限和剩余空间。", async () => {
      const archive = new Archive(PAGE_ROOT(), login.account, selected.id)
      const file = await saveFile(archive, selected, format, setStatus)
      setStatus(file ? `已保存 ${file}` : "已取消保存，可再次选择文件夹。")
    })
  }

  function signOut(remote: boolean) {
    perform("signout", "操作失败，请稍后重试。", async () => {
      if (!await Dialog.confirm({
        title: remote ? "退出 Telegram 登录？" : "清除本机登录信息？",
        message: remote ? "将撤销本脚本的 Telegram 登录，并移除钥匙串中的会话。" :
          "将移除本脚本钥匙串中的登录会话及 API 配置。",
        confirmLabel: remote ? "退出登录" : "清除", cancelLabel: "返回",
      })) return
      let serverConfirmed = true
      if (remote && login) {
        try { await (await connection(login)).signOut() }
        catch (error) { serverConfirmed = sessionExpired(error) }
      }
      await closeClient(runtime)
      clearSecret(LOGIN_KEY)
      setLogin(null)
      setChannels([])
      setSelected(null)
      setCheckpoint(null)
      setQuery("")
      setPage("home")
      if (!remote) clearSecret(API_KEY)
      setStatus(serverConfirmed ? "本机登录会话已清除。" :
        "本机登录会话已清除。Telegram 未确认撤销，请在 Telegram 的「设置 → 设备」中结束此会话。")
    })
  }

  function clearArchives() {
    perform("settings", "无法清除本地导出缓存。", async () => {
      if (!await Dialog.confirm({
        title: "删除本机导出缓存？",
        message: "将清除本机所有账号的频道分页和断点。已经保存的导出文件会保留。",
        cancelLabel: "返回", confirmLabel: "删除",
      })) return
      rmSync(PAGE_ROOT(), { force: true, recursive: true })
      setCheckpoint(null)
      setStatus("已删除本机导出缓存。")
    })
  }

  const busy = !!operation || cancelling
  const active = operation === "export"
  const search = query.trim().toLowerCase()
  const filtered = channels.filter(channel => !search || channel.name.toLowerCase().includes(search) ||
    (channel.username && ("@" + channel.username.toLowerCase()).includes(search)))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans"))
  const titles: Record<Page, string> = {
    home: "Telegram 频道导出", channels: "选择频道", settings: "设置",
    login: "登录 Telegram", api: "Telegram API 配置",
  }

  function goBack() {
    if (challenge) {
      submitInput(true)
      return
    }
    if (busy) return
    if (page === "home") {
      dismiss()
      return
    }
    setApiHash("")
    setPhone("")
    setStatus("")
    setPage(page === "api" ? "settings" : "home")
  }

  return <NavigationStack>
    <List navigationTitle={titles[page]} navigationBarTitleDisplayMode="inline"
      interactiveDismissDisabled={busy}
      toolbar={{
        cancellationAction: <Button title={challenge ? "取消登录" : page === "home" ? "关闭" : "返回"}
          disabled={busy && !challenge} action={goBack} />,
        primaryAction: page === "home" && Script.supportsMinimization() ?
          <Button title="最小化" disabled={!!operation && !active} action={async () => { await Script.minimize() }} /> : undefined,
      }}>
      {page === "home" && <>
        <Section header={<Text>Telegram 账号</Text>}>
          <Label title={login ? login.label : "未登录"} systemImage={login ? "person.crop.circle.fill" : "person.crop.circle"} />
          {!login && <Button title="登录 Telegram" systemImage="person.badge.key" disabled={busy} action={() => openCredentials("login")} />}
        </Section>
        <Section header={<Text>频道</Text>}>
          {selected && <VStack alignment="leading" spacing={4}>
            <Text font="headline">{selected.name}</Text>
            <Text font="caption" foregroundStyle="secondary">{selected.username ? "@" + selected.username : "私人频道"}</Text>
          </VStack>}
          <Button title={selected ? "更换频道" : "选择频道"} systemImage="list.bullet"
            disabled={!login || busy} action={() => {
              setStatus("")
              setPage("channels")
              if (!channels.length) loadChannels()
            }} />
        </Section>
        <Section header={<Text>导出进度</Text>}>
          <VStack alignment="leading" spacing={5}>
            <Text font="headline" monospacedDigit>{`已导出 ${checkpoint?.count ?? 0} 条文字消息`}</Text>
            {active && <Text font="caption" foregroundStyle="secondary">{status || "正在连接 Telegram…"}</Text>}
            {selected && !active && <Text font="caption" foregroundStyle="secondary">
              {checkpoint?.complete ? "历史读取完成" : checkpoint?.pages ? "有可继续的本地断点" : "从频道最早可见的消息开始"}
            </Text>}
          </VStack>
          {!active && <Button title={checkpoint?.pages && !checkpoint.complete ? "继续导出" : "开始导出"}
            systemImage="arrow.down.circle" disabled={!selected || busy || !!checkpoint?.complete} action={start} />}
          {active && <Button title="暂停" systemImage="pause.circle" disabled={cancelling}
            action={() => runtime.work?.abort()} />}
          {(active || !!checkpoint?.pages || checkpoint?.complete || (!!selected && checkpoint === null)) &&
            <Button title={active ? "取消导出…" : "清除本频道进度…"} systemImage="trash" role="destructive"
              disabled={cancelling || (!!operation && !active)} action={() => { void erase() }} />}
        </Section>
        <Section header={<Text>保存文件</Text>}>
          <Button title="保存 TXT 到「文件」" systemImage="doc.text" disabled={busy || !checkpoint?.complete}
            action={() => save("txt")} />
          <Button title="保存 JSON 到「文件」" systemImage="curlybraces" disabled={busy || !checkpoint?.complete}
            action={() => save("json")} />
        </Section>
        <Section>
          <Button title="设置与退出登录" systemImage="gearshape" disabled={busy} action={() => {
            setStatus("")
            setPage("settings")
          }} />
        </Section>
      </>}
      {page === "channels" && <>
        <Section>
          <TextField title="搜索频道" prompt="频道名称或 @用户名" value={query} onChanged={setQuery}
            autocorrectionDisabled />
          <Button title="刷新频道列表" systemImage="arrow.clockwise" disabled={busy} action={loadChannels} />
        </Section>
        <Section header={<Text>{`已加入的频道（${filtered.length}）`}</Text>}>
          <ForEach data={filtered} builder={channel =>
            <Button disabled={busy} action={() => select(channel)}>
              <HStack spacing={12}>
                <Label title={channel.name} systemImage={channel.id === selected?.id ? "checkmark.circle.fill" : channel.username ? "megaphone" : "lock"} />
                <Text font="caption" foregroundStyle="secondary">{channel.username ? "@" + channel.username : "私人频道"}</Text>
              </HStack>
            </Button>} />
          {!filtered.length && search && <Text foregroundStyle="secondary">没有符合搜索的频道。</Text>}
        </Section>
      </>}
      {(page === "api" || page === "login") && !challenge && <>
        <Section header={<Text>Telegram API</Text>}>
          <TextField title="API ID" prompt="输入数字 API ID" value={apiId}
            onChanged={setApiId} keyboardType="numberPad" disabled={busy} />
          <SecureField title="API Hash" prompt="粘贴 32 位 API Hash" value={apiHash}
            onChanged={setApiHash} autocorrectionDisabled disabled={busy} />
          <Text font="caption" foregroundStyle="secondary">
            {"在 my.telegram.org 的 API development tools 获取。"}
          </Text>
          {page === "login" && <Text font="caption" foregroundStyle="secondary">
            {"若已在设置保存过 API 配置，这两项可以留空。"}
          </Text>}
        </Section>
        {page === "login" ?
          <Section header={<Text>Telegram 手机号</Text>}>
            <TextField title="手机号" prompt="含国际区号，例如 +86…" value={phone}
              onChanged={setPhone} keyboardType="phonePad" disabled={busy} />
            <Button title="继续登录" disabled={busy} action={signIn} />
          </Section> :
          <Section>
            <Button title="保存 API 配置" disabled={busy}
              action={() => perform("settings", "无法保存 API 配置。", async () => {
                saveSecret(API_KEY, credentials(false))
                setApiHash("")
                setPage("settings")
                setStatus("已保存 API 配置。")
              })} />
          </Section>}
      </>}
      {page === "login" && challenge && <Section header={<Text>{challenge.title}</Text>}>
        {challenge.detail && <Text>{challenge.detail}</Text>}
        {challenge.kind === "email" ?
          <TextField key="email" title={challenge.title} value={reply} onChanged={setReply}
            keyboardType="emailAddress" autocorrectionDisabled /> :
          <SecureField key={challenge.kind} title={challenge.title} value={reply} onChanged={setReply}
            keyboardType={challenge.kind === "code" ? "numberPad" : "default"} />}
        <Button title="提交" disabled={!reply} action={() => submitInput(false)} />
      </Section>}
      {page === "settings" && <>
        <Section header={<Text>登录与凭据</Text>}>
          <Button title="设置 API ID 与 API Hash" systemImage="key" disabled={busy || !!login}
            action={() => openCredentials("api")} />
          <Button title="退出 Telegram 登录…" disabled={busy || !login} role="destructive" action={() => signOut(true)} />
          <Button title="清除本机登录信息…" disabled={busy} role="destructive" action={() => signOut(false)} />
        </Section>
        <Section header={<Text>本地导出缓存</Text>}>
          <Button title="删除所有账号的导出缓存…" disabled={busy} role="destructive" action={clearArchives} />
        </Section>
      </>}
      {!active && (status || (operation && !challenge)) && <Section header={<Text>状态</Text>}>
        {operation && !challenge && <ProgressView />}
        {status ? <Text foregroundStyle="secondary">{status}</Text> :
          operation === "login" ? <Text>正在连接 Telegram…</Text> :
          operation === "channels" ? <Text>正在读取频道…</Text> : null}
      </Section>}
    </List>
  </NavigationStack>
}

async function main() {
  const runtime: Runtime = { closing: false }
  let initial: SavedLogin | null = null
  let startupError: string | undefined
  try {
    try { initial = loadLogin() }
    catch (error) { startupError = explain(error, "无法读取本机登录会话。") }
    await Navigation.present({ element: <ExporterView runtime={runtime} saved={initial} startupError={startupError} /> })
  } catch {
    await Dialog.alert({ title: "Telegram 频道导出", message: "脚本界面启动失败，请更新 Scripting 后重试。", buttonLabel: "好" })
  } finally {
    runtime.closing = true
    runtime.work?.abort()
    await closeClient(runtime)
    Script.exit()
  }
}

void main()
