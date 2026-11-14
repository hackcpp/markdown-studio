# 08 — 技术架构

## 进程与模块

| 模块 | 职责 |
| --- | --- |
| [应用界面](../../src/main.tsx) | React 和 TypeScript，负责文件树、会话、编辑区、搜索面板以及恢复流程 |
| [编辑器](../../src/Editor.tsx)、[Markdown 预览](../../src/markdown-preview.tsx) | CodeMirror 6 编辑。remark 解析文档块，KaTeX 渲染公式，Mermaid 渲染图表 |
| [Preload](../../electron/preload.cjs)、[接口类型](../../src/types.ts) | 通过 `contextBridge` 暴露工作区业务方法 |
| [主进程](../../electron/main.cjs) | Electron 窗口、IPC 队列、工作区选择、Chokidar 文件监听和本地图片协议 |
| [文件操作](../../electron/workspace.cjs)、[元数据](../../electron/metadata.cjs) | 工作区路径解析、文件读写与移动、图片及 YAML 处理 |
| [本地会话](../../electron/local-state.cjs)、[搜索索引](../../electron/search.cjs) | 会话 JSON、Node.js SQLite 和 FTS5 trigram |

## 应用边界

渲染进程启用沙盒与上下文隔离，通过 Preload 访问应用业务。主进程核对 IPC 调用来源与工作区标记，并校验文件路径，拒绝越出工作区及经过符号链接的路径。窗口限制导航和新窗口，外部链接仅允许 HTTP、HTTPS 和 mailto。

Markdown 预览跳过内嵌 HTML，LaTeX 和 Mermaid 按受限配置渲染。页面资源权限由 [CSP](../../index.html) 约束。

## 构建和验收

Vite 构建前端，Node.js 内置测试运行器执行 [回归测试](../../test/)。electron-builder 在 [Release 工作流](../../.github/workflows/build.yml) 中生成 Windows x64 和 macOS 两种架构的安装包。版本发布前的检查见[发布验收](09-roadmap-and-acceptance.md)。
