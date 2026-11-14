# Telegram 频道导出

在 iPhone 的 Scripting 中导出当前账号已经加入的公开频道、私人频道，包括归档列表里的频道。

## 安装

1. 安装或更新 Scripting。脚本以 **Scripting 3.2.2 或更新版本**的原生 TCP 与文件接口为目标。
2. 把项目 ZIP 保存到 iOS「文件」App，在 Scripting 的脚本导入入口选择 ZIP。如果界面提供的是项目文件夹导入，先在「文件」中解压，再选择包含 `script.json` 的 `Telegram-Channel-Exporter` 文件夹。也可以把解压后的完整文件夹复制到 Scripting 的脚本目录，回到 Scripting 的脚本列表打开。
3. 运行 **Telegram 频道导出**。项目已内置 Telegram 客户端模块，可以直接运行入口 `index.tsx`，手机上无需安装 npm 包。

## 使用

1. 在 [my.telegram.org](https://my.telegram.org/) 的 **API development tools** 获取自己的 API ID 和 API Hash。
2. 在脚本内点「登录 Telegram」，输入 API 配置、带国际区号的手机号，以及 Telegram 发给你的验证码。启用了两步验证的账号会另行提示输入密码。
3. 点「选择频道」，按频道标题或 @用户名搜索，选中后返回主页。
4. 点「开始导出」。需要暂时停下时点「暂停」。下次选择同一个频道，点「继续导出」，会从最后一批成功写入的断点接着读。点「取消导出」并确认会删除该频道的本地进度。
5. 读取结束后点「保存 TXT 到『文件』」或「保存 JSON 到『文件』」，在系统选择器中选一个可写文件夹。

## 文件和会话

- 每次从开始读取时可见的最新消息向前分页，直到该账号可见的最早历史。保存时从旧到新写出。重新抓取频道最新内容前，可在主页清除该频道的本地进度。
- TXT 和 JSON 均使用 UTF-8。每条记录保留 Telegram 消息 ID、UTC 时间和正文。媒体消息中随帖附带的说明会一并保存。已删除的消息、没有正文的消息和服务消息会被跳过。
- TCP 连接由 iOS 路由到 Telegram。凭据和会话保存在此脚本的设备本地钥匙串。验证码和两步验证密码只在当次登录中使用。下载进度按账号和频道分别保存在本机。可以在设置里清除缓存或登录会话。
- 大频道建议在 Scripting 前台导出。iOS 挂起或结束 Scripting 后，可重新打开脚本并继续。Telegram 返回 FloodWait 时，导出会显示等待时间并在到期后继续。
- 输出归你选择的「文件」位置管理。签出账号、清除缓存和取消任务不会删除已保存的导出文件。

## 项目文件

| 文件 | 用途 |
| --- | --- |
| `index.tsx` | 原生中文界面及任务控制 |
| `telegram.ts` | Telegram 用户会话、频道和历史请求 |
| `archive.ts` | 磁盘分页、断点提交、TXT 和 JSON 编码 |
| `exporter.ts` | 分页任务、限速等待和系统文件选择器 |
| `mtproto.js` | 内置 teleproto 1.233.0 及依赖 |
| `build-tools/` | 可选的桌面依赖构建配置 |

桌面重建依赖包时，在 `build-tools` 中运行 `npm ci`，再运行 `npm run build`。第三方许可见 `THIRD-PARTY-NOTICES.txt`。

## 验证范围

桌面验证覆盖分页、断点重启恢复、暂停、继续、FloodWait、UTF-8 和 TXT/JSON 分段输出，使用约 20 万个模拟消息 ID。Telegram 测试数据中心直连在当前开发环境返回网络不可达，Scripting 真机上的手机号登录、私人频道权限和「文件」选择器仍需验证。
