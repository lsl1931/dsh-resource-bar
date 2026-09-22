# dsh-resource-bar

在 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）Web 版**左侧边栏「设置」按钮上方**常驻显示本机 **CPU 与内存**使用率的药丸，点击展开完整详情。

与 [dsh-usage-bar](https://github.com/lsl1931/dsh-usage-bar) 同一座位（`sidebar.footer.action`）、同一呈现思路：一枚常驻药丸 + 点击弹出面板。

## 功能

- **常驻药丸**：`CPU 37.5%` + 内存条 + `内存 62.5%`，带迷你占用条，按占用分档着色（<70% 正常 / ≥70% 警告 / ≥90% 危险）。2 秒轮询一次，首屏后降为 10 秒。
- **点击展开**：`aria-expanded` 正确翻转；按 `Esc` 或点击面板外关闭。
- **详情面板**：
  - **CPU**：总占用、逐核柱状图、时间片构成（用户态 / 内核态 / 等待 IO / 中断 / 低优先级 / 被虚拟化抢占 / 空闲）。
  - **内存**：已用（`已用 / 总量 · 百分比`）、可用、空闲、缓存/可回收、缓冲区、共享内存、本进程 RSS；有交换分区时额外显示交换占用。
  - **负载**：1 / 5 / 15 分钟平均负载，可运行进程 / 总进程数。
  - **进程**：按 CPU 与按内存各取前 5，展示进程名与占用。
  - **页脚**：CPU 型号 · 核心数 · 已运行时长，以及「刷新」按钮。
- **侧边栏收起时自适应**：收起为窄轨道时只显示紧凑的 `C 38% / M 63%` 两行，面板从轨道右侧弹出并保持最小宽度，保证完整可读。

## 数据来源

全部取自内核自己的接口，不做任何估算：

| 来源 | 用途 |
|---|---|
| `/proc/stat` | CPU 时间片（总量 + 逐核）与其构成 |
| `/proc/meminfo` | 内存账目（MemTotal / MemAvailable / Cached / Swap） |
| `/proc/loadavg` | 运行队列负载 |
| `/proc/uptime` | 运行时长 |
| `/proc/cpuinfo` | CPU 型号 |
| `/proc/<pid>/stat` | 每进程 CPU 时间片与 RSS |

口径说明：

- **CPU 占用** = `(Δtotal − Δidle − Δiowait) / Δtotal`，即把 `iowait` 计入空闲，与 `top` 一致；需要两次采样才能得出，因此服务端按 1 秒自采样，路由只下发缓存快照 —— 轮询**不产生 /proc IO**。
- **内存已用** = `MemTotal − MemAvailable`（内核自己的口径）。只用 `MemFree` 会把可回收的页缓存算成已用，长时间开机的机器会显示得异常高。
- **每进程 CPU** 沿用 `top` 语义：**单核百分比**，4 核上跑满四核是 400%，因此可以超过 100%。
- 计数器因挂起或重置而回退时，该次读数为 `null`（显示「—」），**不会伪造 0%**。

## 健壮性

监控插件把宿主搞崩比没有插件更糟，因此：

- 所有 `/proc` 读取都容错：非 Linux 主机、被限制的容器、消失的 pid、截断的读取，一律降级为 `available:false` / 字段缺失，**不抛异常**。
- 每个路由都做方法校验（非 GET 返回 405 + `Allow`），并经 `ctx.connection.requestRejection` **信任栅栏**（Host/Origin 防 DNS 重绑定 + 浏览器鉴权）；`connection` 缺失时**fail closed**（拒绝，不服务）。
- 所有定时器通过 `ctx.effect` 由 fiber 持有，禁用插件后不留存活定时器。
- 进程采样器**惰性启动**：只有详情面板被打开过才启动，且最后一次请求 15 秒后自动停止。

## 安装

作为独立插件包被 profile 引用，**不反向侵入 DSH**。从公开仓库安装（推荐，锁得住版本）：

```bash
dsh plugin --profile web add https://codeload.github.com/lsl1931/dsh-resource-bar/tar.gz/refs/heads/main
```

随后在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 中列出 `dsh-resource-bar`，重启 `dsh web` 即可。

> `github:lsl1931/dsh-resource-bar` 这种简写在本机不可用：pnpm 会把它解析成
> `git+ssh://`，没有 SSH 密钥时会以 `Host key verification failed` 失败。
> 上面的 codeload HTTPS URL 可以完全绕开 git。

在本仓库目录开发时，用 `link:` 让改动即时生效：

```bash
cd ~/.dsh/profiles/web
pnpm add "link:/path/to/dsh-resource-bar"
```

> 开发提示：用 `link:` 而非 `file:`。`file:` 会做快照拷贝，改完源码后 host 端可能仍加载旧版本。

## 开发

零构建依赖，仅需 Node.js ≥ 22：

```bash
node build.mjs           # 由 src/ 生成 lib/
npm test                 # 全量自检（9 个套件）
npm run test:e2e         # 真实 dsh web 挂载验证（临时 DSH_HOME，不碰你的 profile）
```

- `src/index.js` → `lib/index.js`（Node half，原样拷贝）
- `src/client/index.js` → `lib/client.js`（包成 `window.__ModuleLoader__` 的 factory 形式）

**只改 client half 时**，浏览器硬刷新即可生效；改 Node half 需要重启 `dsh web`。

## 测试

`node run-selftests.mjs` 依次运行：

| 套件 | 覆盖 |
|---|---|
| `selftest-parse.mjs` | 解析与折叠：真实 `/proc` 交叉校验、字段偏移、重置/截断/敌意输入 |
| `selftest-timers.mjs` | 定时器归属：dispose 后零存活定时器（含惰性进程采样器） |
| `selftest-routes.mjs` | 路由契约：`kind:exact`、方法校验、信任栅栏、fail-closed、不泄漏密钥 |
| `selftest-failure.mjs` | 失败路径：不可读的 procfs 全部降级而非抛异常 |
| `selftest-client.mjs` | 客户端渲染：真实 React + happy-dom 驱动真实 bundle，断言交互与可访问性 |
| `selftest-contracts.mjs` | 官方条例：清单约束、patch 形状、样式归属、主题 token 白名单、无硬编码颜色 |
| `selftest-live.mjs` | 真实采样：对活着的 `/proc` 连续采样并校验数值区间 |
| `selftest-packaging.mjs` | 发布面：`npm pack` 后 tarball 恰为 6 个文件、无测试/源码泄漏、打包清单无生命周期脚本 |
| `selftest-perf.mjs` | 性能边界：单次采样与快照序列化耗时上限 |

测试只依赖 `react` / `react-dom` / `happy-dom`（devDependencies，**不进发布面**，`files` 白名单已排除）。

### 端到端挂载验证

`in-process` 自检跑不出**启动期**的契约违规（读未声明的 `ctx.X`、清单字段被加载器拒绝）—— 只有真实启动才能。因此 `npm run test:e2e` 会：

1. 在 `/tmp` 下建一个**一次性 `DSH_HOME`**（你的真实 profile 全程不被触碰）；
2. `dsh plugin --profile web add` 把本插件装进 scratch profile；
3. 在空闲端口真实启动 `dsh web`，等待就绪并确认启动日志无加载器报错；
4. 经鉴权 HTTP 跑 38 项契约检查：信任栅栏（未鉴权 401）、方法校验（POST 405）、实时 CPU/内存载荷、逐核读数、惰性进程采样器及其 18 秒自动停止；
5. 确认客户端 bundle 确实被打进 boot combo 并在 `/plugins` 正常下发；
6. 解析真实 `__DSH_BOOT__` 载荷，确认本插件的行存在、未被 rejected、且其指向的资源可 200 下载（11 项检查）。

合计 57 项端到端检查。

脚本按**端口持有者**识别进程（本平台的 dsh 进程 `comm` 是 `MainThread`，用 `pgrep node` 找不到它 —— 这个坑在开发时真的留下过孤儿进程）。清理只杀自己那个端口的进程，不会波及你 `:3080` 上的服务。

## CI

`.github/workflows/ci.yml` 在每次 push / PR 上跑：全量自检 + **校验提交的 `lib/` 不是陈旧的**（`git diff --exit-code -- lib/`）+ 打包清单门（`npm pack` 后确认无 `cordis` 依赖、无生命周期脚本、tarball 内容正确）。

端到端挂载测试**不进 CI**：它要真实启动 `dsh web`、依赖可用的 dsh 安装与空闲端口，属于本机发布前的手动门禁（`npm run test:e2e`）。

## 发布到 GitHub

仓库尚需创建（本机无任何 GitHub 凭据）。本地仓库已就绪：分支 `main`、两处提交、`origin` 指向 `https://github.com/lsl1931/dsh-resource-bar.git`（不含凭据）。

两种方式二选一：

**A. 自己推（不需要交出凭据）** —— 在 GitHub 建空公开仓库 `dsh-resource-bar`（**不要**勾 README/gitignore），然后：

```bash
cd ~/dsh-resource-bar && git push -u origin main
```

**B. 用脚本一键建仓并推送** —— 需要 `repo` scope 的 PAT：

```bash
# token 只进文件，不进命令行历史
read -rsp "PAT: " T && printf '%s' "$T" > ~/.gh-pat && chmod 600 ~/.gh-pat && unset T
bash scripts/publish.sh     # 建仓（已存在则跳过）+ 推送 + 校验远程 ref
rm ~/.gh-pat                # 完成后自行删除
```

该脚本把 token 经**临时 credential helper** 传给 git，且 helper 在调用时从文件读取，因此 token 既不会写进 `.git/config`、日志，也不会出现在任何进程的 argv 里（可用 `ps` 验证）。

## 已知边界

- **仅 Linux**：数据源是 procfs。其他平台下药丸仍会渲染，但显示「无读数」，不报错。
- **每进程 RSS 的页大小按 4096 假定**（Linux/amd64 默认）。它只用于进程排行，不影响总量口径（总量来自 `/proc/meminfo` 的字节值）。
- **进程排行需要两次采样**：新出现的进程首次上报 0%，避免用生命周期均值把长命进程排到真实负载前面。
- 负载均值是内核的 1/5/15 分钟指数平均，不是瞬时值。

## 许可

MIT
