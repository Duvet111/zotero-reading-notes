# 随读笔记 · Zotero Reading Notes

在 Zotero 阅读 PDF 时记录想法、摘录文字和图片，并保留原文位置。当前版本 **0.3.5**，适用 **Zotero 9.0.6**。

## 安装

1. 下载 [reading-notes-0.3.5.xpi](https://github.com/Duvet111/zotero-reading-notes/raw/refs/heads/main/outputs/reading-notes-0.3.5.xpi)。
2. 在 Zotero 中打开“工具 → 插件 → 齿轮 → 从文件安装插件”，选择下载的 XPI 文件。
3. 安装完成后重启 Zotero。

目前采用手动安装更新。

## 功能

- 点击阅读器工具栏“随读笔记”，在右侧打开笔记；点击“切换”或按 `Ctrl+Alt+N` 切换独立笔记窗口。
- 摘录文字时保存原文位置，不新增 PDF 高亮。笔记中的摘录可通过“在页面中显示”回到原文。
- 图片使用“截图 → 框选原生区域批注 → 添加到随读笔记”的流程。
- 可分别设置自己文字与摘录的字体，以及字号、行距、段落间距、摘录斜体和加粗。
- 导出 Word 文档，包含图片和自定义样式，不包含原文回跳链接。
- 内容保存为 Zotero 原生笔记，停用插件后仍保留。

支持 Zotero 主窗口内的 PDF 标签页。独立 PDF 阅读器窗口、EPUB 和网页快照暂未支持。样式设置保存在本机，不自动同步到其他电脑。

## 0.3.5 更新

通过 `Components.utils.cloneInto` 将输入格式标记数组复制到笔记编辑器窗口，处理跨权限域访问数组时出现的 `Permission denied to access property "slice"` 问题。

见 [0.3.5 使用说明](outputs/随读笔记-0.3.5-使用说明.md)。实际 Zotero 界面、Windows 中文输入法及 Word 排版效果仍需实机确认。

## 源码与构建

插件源码位于 `work/plugin/`，测试脚本和构建脚本位于 `work/`。插件运行不需要下载外部依赖。

在仓库根目录执行：

```sh
node work/verify.cjs
node work/verify-dom.mjs
python work/test_docx.py
python work/build.py
```

Word 导出测试需要 Python 的 `Pillow` 和 `lxml`。构建结果位于 `outputs/`。`verify-native.mjs` 是之前的原生编辑器研究测试，需要本机 Zotero 对应的 `work/native-editor.js`，该文件未随仓库分发。

测试使用的 LinkeDOM 许可见 [linkedom-LICENSE](work/test-deps/linkedom-LICENSE)。
