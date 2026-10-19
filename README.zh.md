# dsh-thinking-summary · 思考摘要

[English](README.md) | 中文

[GitHub 仓库](https://github.com/HUSTforever/dsh-thinking-summary) · MIT · Node.js 22.19+ 或 24+

把 DeepSeek Harness 原生「思考」折叠行改成 Codex 风格的阶段摘要：折叠时显示行动短标题，展开时显示 1～2 句高层进展，可随时切换查看原始思考。

## 与 Codex 的区别

| 项目 | 旧版插件 0.1 | 新版插件 0.2 | Codex 的官方摘要接口 |
|---|---|---|---|
| 时机 | 整轮结束后 | 当前步骤进行中更新，步骤结束后补齐 | 支持独立的摘要流事件 |
| 粒度 | 整轮所有思考合成一段 | 每个模型步骤一份 | reasoning item 的摘要片段 |
| 展示 | 回答下方额外卡片 | 原生思考行：短标题、展开摘要、原文切换 | 由 Codex 客户端展示 |
| 生成 | 额外模型调用 | 仍需额外模型调用，并做节流与缓存 | 模型接口直接返回摘要 |

这里只对齐前端的展示方式和阶段摘要体验，并不复刻 OpenAI 模型内部的摘要机制。DeepSeek 的实时摘要可能稍后于原始思考到达。

参考：[OpenAI Reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning)、[摘要流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)。

## 行为

- 沿用 Harness 的原生思考折叠、过程分组、主题和回答组件；摘要同时以过程卡片显示在思考行下方，不再额外插入会话消息。
- 摘要卡片直接显示摘要正文，不需要展开折叠行；折叠行保留短标题，展开仍可切换原始思考。
- 摘要侧重当前行动、关键发现和下一步；不逐句转述内部自言自语，不把计划描述成已经完成的工作。
- 实时思考达到 40 字后，约 1.2 秒触发首次请求；持续更新至少相隔 8 秒且新增至少 600 字。服务端仍执行 `minReasoningChars` 阈值。
- 步骤结束时补齐最终快照；同一页面的辅助调用排队执行，相同请求合并。
- 可见的历史步骤在进入视口后自动补齐；滚动到哪补到哪，不会一次性批量调用模型。浏览器已缓存的结果可直接复用。
- 摘要失败可重试；原始思考始终可查看。少于阈值的步骤直接提供原文入口。
- 摘要默认跟随 DSH 语言；可在「插件 → 已安装插件 → dsh-thinking-summary」里选择摘要模型，并把语言设为 `auto`（跟随 DSH）或输入 `zh`、`en`、`zh-CN` 等覆盖。提示词要求按 Codex 的 `**行动标题** + 1-2 句进展` 格式输出，并优先依据用户请求、工具调用/结果和回答，而不是只复述思考。
- 摘要通过独立 HTTP 服务传递，不写入会话日志，也不进入模型上下文。
- 浏览器缓存区分原文、provider、model、locale；服务端缓存还区分摘要格式版本、长度预算、输出上限和思考设置。

## 安装

插件以 DSH 组合包（bundle）的形式安装：manifest 指向 `cordis.patch.yml`，插件管理器会下载包、把它加入 profile 的 bundles，并自动应用默认配置。不需要手工复制文件，也不需要修改 profile。

已核对 Harness 桌面端 `0.2.1-rc.2`；manifest 声明 `engines.dsh: ">=0.2.1-rc.2"`。

### 在 Web / 桌面端「插件」页安装

1. 侧栏打开**插件**。
2. 点**添加插件**，选择**安装第三方插件**。
3. 粘贴以下任一安装源：
   - Release 压缩包：
     `https://github.com/HUSTforever/dsh-thinking-summary/releases/download/v0.3.0/dsh-thinking-summary-0.3.0.tgz`
   - Git 标签：`github:HUSTforever/dsh-thinking-summary#v0.3.0`
4. 安装完成后如出现**立即启用**，选择启用。
5. 在**插件 → 已安装插件 → dsh-thinking-summary** 页面选择摘要模型和语言。

默认配置由组合包 patch 提供（`language: auto`、`thinking: 'off'`、`maxChars: 600`），无需再往 profile 的 `cordis.patch.yml` 添加条目。

### 用 CLI 安装（web、TUI、headless profile）

```powershell
dsh plugin --profile <profile> add <安装源>
```

安装源同上。桌面 profile 由桌面应用托管，请在「插件」页安装。

### 手工安装（仅开发调试）

要测试本地改动而不是安装组合包时，把 `package.json`、`cordis.patch.yml`、`lib/` 以及 README、CHANGELOG、LICENSE 复制到：

```text
%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-thinking-summary
```

再把 [cordis.patch.yml](cordis.patch.yml) 里的 insert 条目加到 profile 的 `cordis.patch.yml`。已经安装组包时不要再手工添加，否则条目会被插入两次。

### 更新

第三方组合包通过「卸载旧版 → 安装新安装源」升级（插件页会分别提供卸载和安装）。每个版本都有固定标签，例如 `github:HUSTforever/dsh-thinking-summary#v0.3.0`。

修改 profile 配置可触发热加载；替换已经导入的 JS 文件后，刷新页面（主机半侧有改动时重启 Harness）以加载新版代码。主机端口可能在重启后变化，可在当前端口检查 `/dsh-thinking-summary/health`。

```powershell
Invoke-WebRequest http://127.0.0.1:<当前端口>/dsh-thinking-summary/health
# version: 0.3.0，client 应指向本插件 lib/client.js
```

## 插件设置

打开「插件」页 →「已安装插件」→ 点 `dsh-thinking-summary`，在插件详情页的「思考摘要」配置区可以：

- 选择摘要使用的 provider/model（「跟随对话模型」表示沿用当前步骤的路由）。
- 设置摘要语言：`auto` 跟随 DSH 语言；也可以直接输入 `zh`、`en`、`zh-CN` 等。
- 保存后立即生效；设置写入 `~/.dsh/thinking-summary/settings.json`，不需要改 profile。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` / `model` | 空 | 使用当前步骤的真实路由；缺少路由时可在服务端同时配置两者。 |
| `language` | `auto` | 跟随 DSH 语言；可在插件设置中覆盖为 `zh`、`en` 等。 |
| `thinking` | `off` | 辅助调用关闭思考；provider 不支持时退回其默认值。 |
| `maxChars` | `600` | 标题与正文的总字符预算。 |
| `maxOutputTokens` | `220` | 辅助调用的输出上限。 |
| `minReasoningChars` | `120` | 短于该长度不调用模型。 |
| `maxInputChars` | `24000` | 输入字符上限；超长保留开头和结尾。 |
| `timeoutMs` | `45000` | 单次模型请求超时。 |
| `cacheSize` | `400` | 服务端缓存条目数，`0` 关闭缓存。 |

磁盘缓存位于 `~/.dsh/thinking-summary/cache.json`，插件设置位于 `~/.dsh/thinking-summary/settings.json`。清除缓存不改变会话。

## 版本管理

`package.json` 是版本号的唯一来源：主机端加载时读取它并用于健康检查，发版不需要改两处。改动进入 `main` 分支，每次发布打一个语义化版本标签：

```powershell
npm version patch --message "release: v%s"   # 或 minor / major
git push --follow-tags
```

`npm version` 会更新 `package.json`、创建提交和带注释的 `vX.Y.Z` 标签。用 `git push --follow-tags` 推送后，Release 工作流会执行检查、打包 `dsh-thinking-summary-X.Y.Z.tgz` 并创建带该压缩包的 GitHub Release；每个版本都可以直接用压缩包地址或 Git 标签安装。CI 在每次 push 和 PR 时执行 `npm run check` 与 `npm test`。

## 验证

```powershell
npm test
npm run check
```

测试覆盖主机路由、结构化摘要、纯文本兼容、失败与回退、限流，以及真实前端 bundle 的原生渲染转发、实时更新、历史调用限制、模型与语言缓存隔离、过期响应和最终快照。