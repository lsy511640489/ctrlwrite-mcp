# CtrlWrite：其他用户 MCP 接入与使用指南

适用范围：Windows 用户，在自己的电脑上通过支持本地 STDIO MCP 的 AI 客户端操作线上 CtrlWrite 画布。Codex 配置示例依据官方文档及本项目当前代码核对，日期为 2026 年 10 月 28 日。

## 1. 先理解需要连接哪些东西

可以把 MCP 理解成 AI 的一只“操作画布的手”，本机桥接程序则是连接这只手与网页的桥。网站打开后，用户先把自己的网页连接到本机桥接，再让 AI 客户端通过 MCP 连接同一个桥接，双方才能看到同一份画布。

| 组成部分 | 在哪里运行 | 作用 | 使用时的要求 |
| --- | --- | --- | --- |
| CtrlWrite 网站 | 云服务器提供网页，用户浏览器打开 | 显示和编辑画布 | 操作画布期间保持该网页打开 |
| 本机桥接程序 | 用户自己的 Windows 电脑 | 连接网页和 MCP，提供本地文件功能 | 保持程序运行 |
| MCP 服务进程 | 用户电脑，由 AI 客户端启动 | 把 `list_tabs`、`edit_canvas` 等工具提供给 AI | 在 AI 客户端中配置一次 |
| AI 客户端 | 用户自己的电脑 | 根据用户要求调用画布工具 | 允许使用已配置的 MCP 工具 |

这里有两个独立的配置动作：

1. 在网页 Settings → Data 中填写配对令牌，使网页连接本机桥接。
2. 在 AI 客户端中配置 MCP 服务，使 AI 连接同一个本机桥接。

只完成其中一项，不能完成整套连接。网页里的“本机 MCP 配对令牌”输入框不会自动替用户配置 AI 客户端。

每位用户各自在本机安装和配对。其他用户不需要你电脑上的配对令牌，也不需要登录你的服务器。

## 2. 网站维护者需要给用户提供哪些文件

当前项目的分发包用途如下：

| 文件或目录 | 用途 | 是否需要给普通用户 |
| --- | --- | --- |
| `ctrlwrite-cloud-upgrade.tar.gz` / `.zip` | 网站维护者更新云服务器上的网页 | 不需要 |
| `ctrlwrite-local-bridge-windows.zip` | Windows 本机桥接程序；解压后运行 `Start-CtrlWrite.cmd` | 使用打包启动方式时需要 |
| 当前版本的项目源码 | 包含 `mcp/server.ts`、`package.json`、`package-lock.json` 等 | 当前版本接入 MCP 需要 |
| 本文档 | 安装、配对、配置和排错 | 需要 |

**当前 Windows 启动包只包含 `bridge.mjs` 和启动文件，没有单独打包的 MCP 服务入口。只给用户本机启动包，还不足以完成 AI 客户端的 MCP 配置。当前可用方案是同时提供项目源码，让客户端运行源码中的 `mcp/server.ts`。**

为了减少下载项，新用户也可以只使用源码：安装依赖后，源码同时提供桥接程序和 MCP 服务。本文先介绍这种方式；已经使用 Windows 启动包的用户可直接使用第 4 节的打包方式。

维护者分发源码前，应排除自己的 `.env`、`deploy/.env`、`.auth`、`.canvas-mcp`、用户工作区、私有技能与约束、模型密钥配置以及 `node_modules`。提供与当前网页兼容的版本，不要打包个人令牌或个人画布给其他用户。

本地尚未提交的代码不会自动出现在按旧 Git 提交导出的源码包里，发布前应检查分发包确实包含当前的 `mcp/`、`server/`、`utils/` 和依赖清单。

## 3. 用户首次准备

### 3.1 安装运行环境

准备以下内容：

- Windows 电脑。
- Node.js 22 或更新版本，包含 npm。
- 支持本地 STDIO MCP 的 AI 客户端；本文使用 Codex 举例。
- 维护者提供的当前项目源码。
- 能正常打开的 CtrlWrite 网站地址。

本指南示例网站地址为：

```text
https://www.yuancao.online
```

如果使用其他域名，请统一替换为浏览器地址栏里实际打开的网站来源。

在 PowerShell 中检查 Node.js 和 npm：

```powershell
node --version
npm --version
```

如果提示找不到命令，先完成 Node.js 安装，再重新打开 PowerShell 和 AI 客户端。

### 3.2 解压源码并安装依赖

本文假设源码目录是：

```text
C:\Users\用户\Desktop\ctrlwrite-local-bridge-windows\CtrlWrite-mcp
```

这是示例路径，可以换成其他位置。确认该目录直接包含以下文件：

```text
CtrlWrite-mcp/
  package.json
  package-lock.json
  mcp/
    server.ts
    localBridge.ts
  server/
  utils/
```

有些源码压缩包会多套一层目录。后续使用的是包含 `package.json` 的那一层。

在 PowerShell 中执行：

```powershell
Set-Location 'C:\Users\用户\Desktop\ctrlwrite-local-bridge-windows\CtrlWrite-mcp'
npm ci
```

预期结果：安装结束后，源码目录出现 `node_modules`，并存在：

```text
C:\Users\用户\Desktop\ctrlwrite-local-bridge-windows\CtrlWrite-mcp\node_modules\tsx\dist\cli.mjs
```

首次安装和后续依赖清单变化时需要执行 `npm ci`；正常日常使用不需要每次安装。

## 4. 启动用户自己的本机桥接程序

以下两种方式选择一种。不要同时启动两份桥接程序占用同一个端口。

### 4.1 方式 A：从源码启动

在 PowerShell 中执行：

```powershell
Set-Location 'C:\Tools\CtrlWrite'
$env:IAMTIRED_SITE_ORIGIN = 'https://www.yuancao.online'
$env:IAMTIRED_CANVAS_DATA_DIR = Join-Path $env:USERPROFILE 'ctrlwrite_config\bridge'
npm run mcp:bridge
```

这里显式指定令牌目录，是为了让源码启动方式与 Windows 打包程序使用同一个约定位置。不要省略这一行后，又在 AI 客户端里填写另一个令牌目录。

启动成功后，终端会显示类似内容：

```text
Local MCP bridge listening on http://127.0.0.1:39173
Website origin: https://www.yuancao.online
Pairing token (enter in website Data settings): <当前电脑生成的配对令牌>
```

复制 `Pairing token` 冒号后面的完整令牌。上面尖括号中的文字只是占位说明，不能作为真实令牌使用。

保持这个窗口运行。关闭窗口会停止桥接服务。

### 4.2 方式 B：使用 Windows 本机启动包

如果用户已经拿到 `ctrlwrite-local-bridge-windows.zip`：

1. 解压到自己的电脑，例如 `C:\Tools\CtrlWrite-Bridge`。
2. 双击 `Start-CtrlWrite.cmd`。
3. 提示输入网站地址时，输入实际网站来源。
4. 看到启动成功及配对令牌后，保持窗口运行。

该程序会记录上次输入的网站地址。只有确认上次地址正确时，才直接按回车沿用。

打包程序不需要在其解压目录执行 `npm ci`，但 AI 客户端运行 `mcp/server.ts` 时仍需要第 3 节准备好的项目源码和依赖。

### 4.3 网站来源必须准确

来源由协议、主机名和必要的端口组成，不包含网页路径。

| 浏览器实际访问 | 桥接程序应填写 |
| --- | --- |
| `https://www.yuancao.online/` | `https://www.yuancao.online` |
| `https://www.yuancao.online/some-page` | `https://www.yuancao.online` |
| `https://write.example.com:8443/` | `https://write.example.com:8443` |

以下地址彼此不同，不能混用：

- `https://www.yuancao.online` 与 `https://yuancao.online`。
- `http://www.yuancao.online` 与 `https://www.yuancao.online`。
- 正确的 `.online` 与误写的 `.omline`。

以地址栏最终显示的来源为准；如果网站发生跳转，应填写跳转后的来源。

## 5. 在网页中配对

1. 在同一台电脑的浏览器里打开 CtrlWrite 网站。
2. 打开 Settings → Data。
3. 找到“本机 MCP 配对令牌”。
4. 粘贴刚才启动窗口显示的完整令牌。
5. 点击“配对”。
6. 刷新网页，读取本机配置并重新连接画布。
7. 点击“检查连接”，并确认本机 MCP 连接状态正常。

如果浏览器询问是否允许网站访问本地网络或本机设备，需要允许该网站访问本机桥接。

同一桥接程序一次只允许一个活跃网页标签连接。首次配置时，只保留一个 CtrlWrite 画布页面，以免 AI 连接到另一个标签页。

MCP 操作画布并不要求先绑定磁盘工作区。用户可以继续使用浏览器保存，也可以在 Data 中选择本地工作区。选择本地文件夹后，应确认“当前保存位置”显示的是预期目录。

## 6. 配置 Codex 的 MCP 服务

### 6.1 配置文件在哪里

Codex 的用户级 MCP 配置位于：

```text
C:\Users\你的Windows用户名\.codex\config.toml
```

如果配置了自定义 Codex 配置目录，应使用该客户端实际使用的配置文件。受信任的项目还可能有项目级 `.codex/config.toml`；排查旧连接时，也要检查项目级配置。

编辑时保留原来的模型、登录和其他 MCP 配置，只新增或修改本指南对应的服务条目。

### 6.2 添加配置

将下面示例中的源码路径和 Windows 用户名替换为当前用户自己的实际值：

```toml
[mcp_servers.ctrlwrite_canvas]
command = "node"
args = ["C:/Tools/CtrlWrite/node_modules/tsx/dist/cli.mjs", "C:/Tools/CtrlWrite/mcp/server.ts"]
cwd = "C:/Tools/CtrlWrite"
startup_timeout_sec = 20
tool_timeout_sec = 60
enabled = true

[mcp_servers.ctrlwrite_canvas.env]
IAMTIRED_CANVAS_URL = "http://127.0.0.1:39173"
IAMTIRED_CANVAS_DATA_DIR = "C:/Users/你的Windows用户名/ctrlwrite_config/bridge"
```

TOML 示例使用正斜杠，避免 Windows 反斜杠转义问题。不要原样保留“你的Windows用户名”。

如果 AI 客户端找不到 `node`，在 PowerShell 中执行：

```powershell
(Get-Command node).Source
```

把得到的 `node.exe` 完整路径填写到 `command`。例如：

```toml
command = "C:/Program Files/nodejs/node.exe"
```

### 6.3 可选：自动生成适合当前用户的配置文本

为避免手动拼错用户名，可以在 PowerShell 中运行以下命令。它只输出配置文本，不会覆盖原有 Codex 配置文件：

```powershell
$sourceDirectory = 'C:\Tools\CtrlWrite'
$sourceForConfig = [IO.Path]::GetFullPath($sourceDirectory).Replace('\', '/')
$tokenForConfig = (Join-Path $env:USERPROFILE 'ctrlwrite_config\bridge').Replace('\', '/')
$nodeForConfig = (Get-Command node).Source.Replace('\', '/')
@"
[mcp_servers.ctrlwrite_canvas]
command = "$nodeForConfig"
args = ["$sourceForConfig/node_modules/tsx/dist/cli.mjs", "$sourceForConfig/mcp/server.ts"]
cwd = "$sourceForConfig"
startup_timeout_sec = 20
tool_timeout_sec = 60
enabled = true

[mcp_servers.ctrlwrite_canvas.env]
IAMTIRED_CANVAS_URL = "http://127.0.0.1:39173"
IAMTIRED_CANVAS_DATA_DIR = "$tokenForConfig"
"@
```

把输出复制到实际使用的 `config.toml`。如果已经存在同名的 `[mcp_servers.ctrlwrite_canvas]` 条目，应修改原条目，不能重复添加。

### 6.4 让配置生效

保存配置后，在 AI 客户端里重新连接该 MCP 服务；如果当前客户端没有重连入口，退出并重新打开客户端。

使用 Codex CLI 的用户可执行下面的命令检查已登记的服务：

```powershell
codex mcp list
```

在 Codex 终端界面可使用 `/mcp` 查看连接状态。登记了服务与工具实际能读到当前画布是两项检查，后者需要继续执行第 8 节的验收。

## 7. 三个最容易配错的地方

### 7.1 MCP 必须连接 39173，而不是旧开发服务 3000

线上网页的本机桥接地址是：

```text
http://127.0.0.1:39173
```

不要把 `IAMTIRED_CANVAS_URL` 配置为：

```text
http://127.0.0.1:3000
```

3000 可能对应旧的本地开发画布。它可能正常返回工具结果，甚至报告创建成功，但操作的是另一份画布，用户当前打开的线上网页不会出现变化。

也不要将这个值填写为网站公网域名。当前 `mcp/server.ts` 只连接本机回环地址；云端静态网站没有提供这套画布工具接口。

### 7.2 网页和 MCP 必须使用同一份令牌

本文统一约定令牌文件为：

```text
C:\Users\当前Windows用户名\ctrlwrite_config\bridge\token
```

对照检查：

| 连接端 | 从哪里取得令牌 |
| --- | --- |
| 网页 | 用户从本机启动窗口复制并粘贴 |
| MCP 服务 | 根据 `IAMTIRED_CANVAS_DATA_DIR` 读取其中的 `token` 文件 |

`IAMTIRED_CANVAS_DATA_DIR` 应指向包含 `token` 的目录，不能填成 `token` 文件本身，也不能只填外层 `ctrlwrite_config`。

如果不显式设置目录，源码可能使用工程自己的 `.canvas-mcp` 目录，从而与 Windows 启动包的令牌位置不一致。

MCP 还支持 `IAMTIRED_CANVAS_TOKEN` 直接指定令牌，它的优先级高于令牌文件。普通用户按本文配置时无需填写该项；如果旧配置里硬编码了旧令牌，应先修正或移除该旧项。

配置文件中的路径请填写真实绝对路径，不要假设 `%USERPROFILE%` 或 `$env:USERPROFILE` 写在 TOML 字符串中就会自动展开。第 6.3 节的 PowerShell 命令会提前完成路径展开。

### 7.3 停用重复的旧画布 MCP 条目

用户以前可能添加过名为 `iamtired_canvas`、`canvas` 或其他名称的画布服务。不要只添加一个新服务后继续让 AI 自行选择。

检查用户级、项目级配置以及客户端安装的插件，保留当前要使用的一份连接。对于配置文件里的旧服务，可以在它自己的 `[mcp_servers.旧名称]` 表中设置：

```toml
enabled = false
```

不要把这行误放到旧服务的 `.env` 子表中。更改后重连或重启客户端，再开始新一轮验证。

如果旧工具由插件提供，应在客户端的插件或 MCP 设置里停用对应旧连接，避免同名工具指向不同画布。

## 8. 首次验收：确认操作的是当前网页

不要只凭 AI 说“已创建成功”判断连接正确。建议做一次可见验证：

1. 保持本机程序运行，只打开一个 CtrlWrite 画布标签。
2. 在网页中手动创建一个节点，命名为 `连接验证-当前用户-001`；也可以使用用户自己起的独特名称。
3. 在 AI 客户端中发送下面的要求。

```text
请使用 ctrlwrite_canvas MCP 的 list_tabs 获取 activeTabId，
再用 list_objects 读取当前标签页。
先确认存在名为“连接验证-当前用户-001”的节点；
如果找不到，请停止写入并报告，不要在其他画布创建节点。
确认找到后，使用最新 revision，
在该节点右侧创建一个名为“MCP连接成功”的文本节点。
```

4. 确认 AI 读取到了网页中刚刚添加的那个节点。
5. 确认当前网页出现 `MCP连接成功` 新节点。

如果第一步读取的节点就对不上，先检查第 7 节，不要继续创建更多节点。不同画布都可能叫 `Canvas 1`，仅比较标签页标题不足以确认连接正确。

## 9. 日常使用流程

首次安装和配置完成后，每次使用通常只需要：

1. 启动本机桥接程序，保留运行窗口。
2. 打开 CtrlWrite 网站，等待当前画布连接。
3. 打开已经配置好的 AI 客户端。
4. 告诉 AI 使用 `ctrlwrite_canvas` 操作当前画布。

MCP 服务进程由 AI 客户端按配置启动，用户不需要再手动打开第二个 `npm run mcp` 窗口。手动运行 stdio MCP 入口后看到它一直等待输入，属于正常现象，并不等于网页已经配对。

当前分发包不会自动安装 Windows 后台服务或开机自启。关闭桥接运行窗口后，本机文件功能和画布 MCP 会停止；重新启动即可。仅关闭网页，MCP 也无法继续操作该页面。

### 9.1 可以直接发送的操作示例

```text
请使用 ctrlwrite_canvas MCP 查看当前活动标签页里有哪些节点。
```

```text
请先读取当前画布，再在现有节点旁边创建一个“本周计划”节点，
正文是“整理资料、撰写初稿、检查引用”。
```

```text
请查找标题为“本周计划”的节点，
将正文改为“周一整理资料，周三完成初稿，周五检查引用”。
```

```text
请读取我指定的 Markdown 文件，先预览导入结果，
再把内容追加为新的画布标签页，保留现有画布。
```

修改或删除已有内容前，应明确目标节点。AI 应先读取当前对象和最新版本，再执行修改。

### 9.2 当前提供的工具

| 工具 | 用途 |
| --- | --- |
| `list_tabs` | 读取当前活动标签、各标签对象数及 revision |
| `list_objects` | 读取指定标签的节点、连线和技能组 |
| `get_object` | 读取一个节点的详细文本和属性 |
| `edit_canvas` | 创建、修改、删除节点，连线，设置局部技能组 |
| `preview_canvas` | 预览结构化画布 JSON 或支持的 JSON 文件 |
| `preview_markdown` | 预览 Markdown 文本或 Markdown 文件 |
| `apply_preview` | 将有效预览追加到画布 |

`revision` 是本次画布状态的版本号。修改工具要求携带刚读取的版本；如果网页或其他操作已经更改画布，需要重新读取后再决定如何修改。

文件路径指向运行 MCP 进程的这台电脑。当前导入入口直接处理 UTF-8 Markdown 和支持的画布 JSON；PDF、Word 和图片需要先由 AI 的其他可用工具提取或转换，不能只修改文件扩展名。

## 10. 常见问题与处理

### 10.1 网页提示 Failed to fetch

表示浏览器没有成功拿到本机服务的可读响应，可能是服务没启动、来源不匹配，或浏览器阻止了本机访问。

按顺序检查：

1. 本机程序窗口是否还在运行，有没有启动失败提示。
2. 终端中的 `Website origin` 是否与网页地址来源完全一致，尤其是 `.online`、`www` 和 `https`。
3. 浏览器是否允许该网站访问本地网络；如曾拒绝，检查网站权限。
4. 网页中的配对令牌是否来自当前正在运行的本机程序。
5. 修改地址或令牌后，是否已经重启相应程序并刷新网页。

### 10.2 Invalid local MCP token

网页或 MCP 使用的令牌与桥接程序不一致。

- 网页端：重新复制当前启动窗口显示的令牌，配对并刷新。
- MCP 端：确认 `IAMTIRED_CANVAS_DATA_DIR` 指向本文约定的 `ctrlwrite_config\bridge`。
- 检查是否仍在使用旧的 `IAMTIRED_CANVAS_TOKEN` 配置。
- 检查是否混用了源码默认 `.canvas-mcp` 与打包程序的令牌目录。

同一台电脑保留相同令牌文件时，正常重启不需要重新生成令牌。不要为了排查问题随意删除令牌或用户配置目录。

### 10.3 Open the website and connect its local MCP bridge in Data settings

MCP 已经访问到桥接程序，但桥接没有可用的网页画布会话。

打开网页，完成配对并等待连接；确保网页没有被关闭、暂停或休眠，然后重试读取画布。

### 10.4 Another browser tab is connected

已有另一个网页标签占用了连接。关闭或断开其他 CtrlWrite 页面，只保留准备操作的那一份。

意外关闭网页后，会话需要一小段时间才会过期。当前实现约 20 秒后判定超时；等待后再重试连接。

### 10.5 AI 报创建成功，当前网页却没有节点

优先检查是否连接了旧画布：

- `IAMTIRED_CANVAS_URL` 是否仍为旧的 3000 端口。
- 是否同时启用了多个画布 MCP 服务或旧插件。
- 第 8 节的独特验证节点，AI 是否真的读取到了。
- 网页和 AI 是否使用同一电脑、同一桥接程序和同一令牌。

如果确实连接到同一画布，再检查新节点坐标是否位于当前可视范围外，以及网页是否提示版本冲突或停止同步。保留未保存内容，必要时先导出备份，再重新连接。

### 10.6 Revision conflict 或提示两边同时更改

网页与 MCP 操作期间发生了并发修改。先读取最新画布状态；如果网页提示同步冲突，先导出需要保留的内容，再重新加载和连接。

不要使用旧 revision 反复重试同一写入，也不要在未核对内容时直接覆盖存档。

### 10.7 node / tsx / mcp/server.ts 找不到

检查 Node.js 是否安装，源码目录是否正确，以及 `npm ci` 是否已成功完成。

```powershell
Get-Command node
Test-Path 'C:\Tools\CtrlWrite\mcp\server.ts'
Test-Path 'C:\Tools\CtrlWrite\node_modules\tsx\dist\cli.mjs'
Test-Path (Join-Path $env:USERPROFILE 'ctrlwrite_config\bridge\token')
```

将源码路径替换为实际路径。后面三个检查在完成对应准备步骤后应返回 `True`。如果最后一项为 `False`，先检查桥接启动方式和令牌目录，不要让 MCP 在错误目录创建另一份令牌。

### 10.8 39173 端口已被占用

通常是旧的桥接程序还在运行。先找到并关闭自己此前启动的那份程序，再启动新版本；不要直接结束不认识的进程。

本文约定使用默认 39173 端口。虽然服务端可以通过环境变量调整监听端口，但当前网页的本机请求地址固定使用 39173，仅改服务端端口不能完成整套连接。

## 11. 其他 AI 客户端如何配置

本项目对 AI 客户端提供的是本地 STDIO MCP。客户端需要能够在当前 Windows 电脑上启动以下命令：

```text
node C:/Tools/CtrlWrite/node_modules/tsx/dist/cli.mjs C:/Tools/CtrlWrite/mcp/server.ts
```

并设置两个环境变量：

```text
IAMTIRED_CANVAS_URL=http://127.0.0.1:39173
IAMTIRED_CANVAS_DATA_DIR=C:/Users/当前Windows用户名/ctrlwrite_config/bridge
```

按客户端自己的设置界面分别填写命令、参数和环境变量；不要把整条命令都塞进只接受可执行文件名的 `command` 字段。不同客户端的配置文件位置和外层结构可能不同，不应直接将 Codex 的 TOML 粘贴到其他产品。

不要把 `http://127.0.0.1:39173` 直接当成可填写到“远程 HTTP MCP URL”的接口。它是本项目桥接的内部 HTTP 地址，当前 MCP 协议入口是 `mcp/server.ts` 的 STDIO 进程。

按本文配置时，AI 客户端应使用用户的本地 Windows 执行环境。如果 MCP 进程实际运行在另一台服务器、云端容器或独立的远程环境，`127.0.0.1` 指向的是那个环境，不能据此连接用户 Windows 上的桥接。

## 12. 令牌、API Key 和数据分别在哪里

| 项目 | 默认位置或来源 | 用途 |
| --- | --- | --- |
| MCP 配对令牌 | `%USERPROFILE%\ctrlwrite_config\bridge\token`，前提是按本文统一启动 | 让网页和 MCP 连接本机桥接 |
| 模型 API Key 配置 | `%USERPROFILE%\ctrlwrite_config\config.json` | 网页的文字或图片模型配置；由当前 Windows 用户加密 |
| 打包程序记住的网站来源 | `%USERPROFILE%\ctrlwrite_config\site.txt` | 下次启动时沿用网站地址 |
| 浏览器模式的画布 | 当前网站的浏览器存储 | 未绑定本地工作区时保存内容 |
| 文件夹模式的画布 | 用户选择的工作区内 `canvases\canvas.json` | 正式画布存档，含标签页和现有格式的嵌入图片 |
| 技能与约束 | 文件夹模式下的 `skills`、`constraints` | 用户自己的 Markdown 内容 |

`%USERPROFILE%` 在本表中表示当前 Windows 用户目录；实际配置 TOML 时按第 6 节填写展开后的绝对路径。

配对令牌与模型 API Key 是两种东西。单纯通过 MCP 读取或编辑画布，不需要把网页的模型 API Key 写进 MCP 配置。AI 客户端本身的登录或模型服务仍由客户端各自配置。

不要把自己的配对令牌给其他用户共用。令牌保存在本机；网站静态服务器不负责给每位用户分配这份令牌。用户通过 MCP 让 AI 读取的文本可能进入其 AI 对话，应按实际使用的 AI 服务处理数据。

## 13. 网站维护者的上线与支持流程

对每个新用户，维护者只需提供：正确的网站来源、兼容源码或本机启动包、本指南。用户按照自己的 Windows 目录生成配置，不需要维护者登录用户电脑替他复制个人令牌。

新用户接入不需要在云服务器上创建一个新的桥接进程，也不需要把 39173 端口开放到公网。当前本机服务只监听回环地址；每位用户使用自己电脑上的同一端口即可。

升级时：

1. 网页界面改动按现有云端升级流程发布。
2. 如果桥接接口变更，同时分发新版 Windows 本机启动包或源码。
3. 如果 MCP 工具入口或参数变更，更新用户的源码依赖，并让 AI 客户端重连 MCP。
4. 保留用户自己的配置目录与工作区，确认令牌路径没有被改到另一处。
5. 用第 8 节的方法做一次当前画布的读写验收。

**验收标准：AI 能读取用户刚在网页创建的独特节点，并且通过 MCP 创建的新节点出现在同一个网页画布中。**

## 14. 核对依据

项目行为依据当前版本的 `mcp/server.ts`、`mcp/localBridge.ts`、`server/canvasStore.ts`、`hooks/useCanvasBridge.ts`、本地工作区存储代码及 Windows 打包脚本。

本文配置示例已通过 TOML 和 PowerShell 语法检查。客户端版本变化时，应结合实际客户端的 MCP 设置与官方文档确认字段支持情况。本次未能完整读取官方页面，因此不将语法检查视为对所有客户端版本的兼容性保证。官方参考入口如下：

```text
https://developers.openai.com/codex/mcp
https://developers.openai.com/codex/config-reference
```
