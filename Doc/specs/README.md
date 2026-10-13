# Doc/specs — 功能规格（历史设计文档）

> 本目录收录从仓库根目录迁入的功能规格文档（保留原文，未做改写）。它们记录当时的需求、代码调查与设计决策，可能落后于当前实现——**以代码与 `AGENTS.md` 为准**。
> 迁入原因：让仓库根目录只保留必要的入口文档（README / AGENTS / CONTRIBUTING 等）。

| 规格 | 内容 |
|---|---|
| [keyboard-shortcuts-spec.md](keyboard-shortcuts-spec.md) | Web 键盘快捷键系统设计（侧栏/设置/新建会话/会话切换/主题/权限；竞品键位调研 + 注册表方案）。 |
| [settings-providers-spec.md](settings-providers-spec.md) | Web「设置 → 模型配置」支持 `providers` 分组（一个 baseURL+key 对应多个模型）的修复规格。 |
| [stats-restore-spec.md](stats-restore-spec.md) | 恢复会话思考丢失 + token 速率统计修正 + 上下文统计的修复规格。 |
| [web-attach-spec.md](web-attach-spec.md) | Web 输入区拖拽/选择图片与文件 + `+` 号改文件选择器的修复规格。 |
| [web-model-config-redesign-spec.md](web-model-config-redesign-spec.md) | Web「设置 → 模型配置」页整页重设计 Spec（top Provider 条 + 表单 + 模型表格 + 能力表联动）。 |