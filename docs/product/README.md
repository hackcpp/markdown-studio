# Markdown Studio 产品设计

本目录记录产品规格、已确认的交互和待实现的功能。Markdown Studio 面向本地 Markdown 笔记管理，提供 Windows 和 macOS 桌面版本。用户安装和使用说明见[项目 README](../../README.md)。

## 文件导航

| 文件 | 用途 |
|---|---|
| [产品需求](01-product-requirements.md) | 产品定位、用户场景和功能范围 |
| [信息架构](02-information-architecture.md) | 主窗口布局、导航和面板 |
| [编辑器交互](03-editor-interaction.md) | 编辑模式、标签、快捷键和保存状态 |
| [工作区与文件](04-file-and-workspace.md) | 创建、移动、删除及附件 |
| [数据与元数据](05-data-model.md) | Markdown、Frontmatter、索引和应用状态 |
| [可靠性与恢复](06-reliability-and-recovery.md) | 自动保存、草稿和冲突处理 |
| [搜索](07-search-spec.md) | 搜索范围、结果定位和维护 |
| [技术架构](08-technical-architecture.md) | Electron 进程边界和实现约束 |
| [发布验收](09-roadmap-and-acceptance.md) | 安装包和回归检查 |
| [产品决策](10-decisions-and-open-issues.md) | 已确认的交互与下一步范围 |
| [待实现功能规格](11-feature-follow-up.md) | 草稿与冲突、文件移动与删除、Frontmatter、编辑快捷键、搜索与工作区维护 |
| [交互原型](prototype/markdown-studio-prototype.html) | 主窗口布局与核心操作演示 |

在本地浏览器打开原型 HTML。原型使用浏览器存储中的演示数据，桌面文件读写、系统废纸篓、故障恢复和完整 Markdown 渲染以应用为准。
