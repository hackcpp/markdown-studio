# Markdown Studio 0.4.0 MVP

打开一个本地目录即可浏览、编辑和管理其中的 Markdown 笔记。应用直接读写原目录中的文件。

## 在 Windows 中运行

使用 Windows 版 Node.js 22.12 或更新版本。首次启动需要下载 Electron 运行时。

```powershell
Set-Location 'D:\Work\vagrant\ubuntu-jammy64\code\markdown'
npm.cmd ci
npm.cmd run dev
```

`npm.cmd run dist:win` 在 `release` 目录生成 Windows 安装包。

## GitHub Actions

`Release build` 工作流仅在 GitHub Release 发布时运行，并构建该 Release 标签指向的提交。各平台使用原生 runner 和 Node.js 24 执行测试、类型检查及打包。构建完成后，在该次运行的 Artifacts 下载对应的安装文件。

| 平台 | 构建产物 |
| --- | --- |
| Windows x64 | `markdown-studio-windows-x64`（NSIS 安装程序） |
| macOS Apple Silicon | `markdown-studio-macos-arm64`（DMG） |
| macOS Intel | `markdown-studio-macos-x64`（DMG） |

macOS 构建产物未使用 Apple Developer ID 签名及公证。

## 在 WSL 中运行

使用 Linux Node.js 22.12 或更新版本，以及可用的 WSLg 图形环境。

```bash
cd /home/ziyou/work/code/markdown
npm ci
npm run dev
```

`npm test` 运行文件、搜索、元数据和恢复测试。`npm run build` 执行 TypeScript 检查和生产构建。`npm run dist:linux` 生成 Linux 压缩包，解压后运行 `markdown-studio`。`npm run dist:mac` 是 macOS DMG 打包入口。

## 使用

- 在文件树选中笔记或目录，可创建、重命名、移动或移至系统废纸篓。应用发起的移动会同步已打开的标签。外部移动会按旧路径消失、新路径出现处理。
- 点击工具栏的图标可在实时预览和源码之间切换。停止输入约 800 毫秒后自动保存。也可使用界面上的「保存」按钮，或在编辑器中按 `Ctrl+S` / `⌘S`。
- 粘贴剪贴板图片时，应用将 PNG 写入工作区的 `Attachments/images`，并在笔记中插入相对链接。通过应用移动笔记时，应用生成的图片链接会更新。将笔记移至废纸篓会保留图片。
- 有未保存编辑时，磁盘变化会暂停该笔记的自动保存。可以并排比较两版正文，将需要的内容合并到编辑器，再显式保存。覆盖前，磁盘版本写入应用数据目录下的 `recovery/`。
- 左侧搜索支持路径、标题和正文，包含中文短词。SQLite 索引保存在应用数据目录，可以从 Markdown 文件重新生成。
- 新建笔记会写入 YAML 文档信息。「文档信息」用于编辑标题和标签。保存已有 YAML 的笔记会更新时间，原有笔记可继续直接编辑正文。
- 重启会恢复上次工作区、打开的标签和编辑模式。编辑期间每次检查点调度延迟约半秒。异常退出后可以查看或恢复草稿。磁盘版本发生变化时，恢复草稿会进入冲突处理。
