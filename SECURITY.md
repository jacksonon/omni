# Security Policy

## 报告安全漏洞（Reporting a vulnerability）

Omni 是一个本地运行的 AI 编程助手，安全模型是**用户显式授权**：权限分级（full/safe/ask/read）+ 危险命令确认 + 审批 UI + 审计日志。

如果你发现了安全漏洞，**请勿在公开 Issues 中披露**。请通过 GitHub 的 **Security Advisories**（仓库页 → Security → Report a vulnerability）提交私密报告，或直接邮件维护者。

报告请包含：

- 影响版本（`omni --version`）
- 漏洞类型与严重性评估
- 复现步骤
- 影响范围（能拿到什么？配置文件？API Key？执行任意命令？）

## 处理流程

| 阶段 | 时间 |
|---|---|
| 确认收到 | 3 个工作日内 |
| 初步评估与修复 | 7 个工作日内 |
| 发布修复版本 | 评估完成后 14 日内 |

## 安全边界说明（Security model）

| 面 | 说明 |
|---|---|
| **API Key** | 优先使用环境变量 `OMNI_API_KEY`；`omni.json` 项目配置被 gitignore（防密钥入库）；`/api/settings` 提交的 API Key 仅写入内存（本次运行），不落盘 |
| **命令执行** | 权限分级 + 危险命令拦截（`rm -rf /`、`mkfs`、`dd`、fork bomb、`git push` 等）+ 审批；`full` 档位为显式信任，直通任意命令 |
| **审计** | 每次工具调用写入 `~/.config/omni/audit.log`（`auditLog: true`） |
| **Web 服务** | `omni web` 只监听 `127.0.0.1`（默认），不暴露公网；无认证，请勿绑定非回环地址后暴露给不可信网络 |
| **子代理 / MCP / Hooks** | 全部经统一 Safety 闸门；Hooks 超时/失败降级放行，不会阻断主流程 |

## Supported versions

当前维护策略：**仅最新发布版本**接受安全修复（见 GitHub Releases）。历史版本不单独维护。

## 开源许可

本项目基于 BSD-3-Clause 许可（见 [LICENSE](LICENSE)）。Web UI 部分派生自 deepseek-ai/deepseek-harness（MIT，版权声明保留在文件头）。
