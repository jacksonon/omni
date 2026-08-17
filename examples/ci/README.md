# CI 集成示例（Headless）

把 omni 变成 CI 里的可组合 Unix 命令：`omni exec "任务"` 非交互执行，stdout 只输出最终结果、
进度走 stderr，`--output-format json` 输出结构化结果、exit code 语义（0 成功 / 非零失败）
可直接 `&&`/`||` 分支。配合 `--output-schema` 可强制最终回答符合 JSON Schema，供下游 job
读取稳定字段。

## 工作流模板：自动修复 CI 失败

`omni-fix-ci.yml` —— 对标 anthropics/claude-code-action 与 openai/codex-action 的
「agent 修 CI」模式，**两阶段安全设计**：

```
┌─ fix-ci job（只读）─────────────────────────────────────────┐
│  permissions: contents: read                                │
│  1. checkout（fetch-depth 0）→ npm ci                       │
│  2. 复现失败：npm test || true → 失败输出存文件              │
│  3. cat 失败输出 | omni exec "修复…" --output-format json   │
│     · stdin 注入失败上下文（prompt + stdin 两段式）           │
│     · --allowed-tools 白名单（读/写/搜索/执行五件套）          │
│     · --max-turns 30 控制成本；json 输出的 session_id 可续跑  │
│  4. git add -A && git diff --cached --binary > 补丁          │
│  5. upload-artifact：omni-fix-patch                          │
└──────────────────────────────────────────────────────────────┘
        │ artifact（纯 diff，无任何密钥）
        ▼
┌─ apply-patch job（有写权限）────────────────────────────────┐
│  permissions: contents: write + pull-requests: write        │
│  download-artifact → git apply --binary → 推送分支 → 开 PR   │
└──────────────────────────────────────────────────────────────┘
```

**关键安全边界**：生成补丁的 job **永远拿不到仓库写凭据**——GITHUB_TOKEN 被
`permissions: contents: read` 钳制为只读，即使 prompt / 仓库内容注入恶意指令，agent 也
推不出去，所有改动以「人类可审查的 PR diff」形式呈现。该 job 只接收 LLM 的
`OMNI_API_KEY`（这是跑 agent 的必要密钥），与 GitHub 凭据隔离。

### 使用步骤

1. 仓库 Settings → Secrets and variables → Actions：配置 `OMNI_API_KEY`（必要）；
   非 OpenAI 端点再配 `OMNI_BASE_URL` / `OMNI_MODEL`（Actions variables）。
2. 复制 `omni-fix-ci.yml` 到 `.github/workflows/`，把「复现 CI 失败」步骤里的
   `npm test` 换成项目的真实失败命令。
3. 按需调整 `--allowed-tools` / `--max-turns` 与触发条件（workflow_dispatch /
   schedule / push）。
4. 触发后到 PR 里 review diff 再合并。修复不完整时，把失败原因交给 omni 继续：

```bash
# PR 描述里带上 session_id（上游 json 输出），本地续跑：
omni exec resume <session_id> "仍然失败，原因：<CI 输出>"
```

### 变体与说明

| 变体 | 做法 |
|---|---|
| 只修不 PR | 删掉 `apply-patch` job，仅保留 `fix-ci`（补丁在 artifact 里人工下载） |
| 定时巡检 | `on.schedule` 已内置（cron `0 3 * * *`），配合 `workflow_dispatch` 手动触发 |
| 支持（可信）PR | 加 `pull_request` 触发 + `if: github.event.pull_request.head.repo.fork == false` 守卫——**fork PR 不要跑**（可携带任意代码/指令） |
| 成本控制 | `--max-turns`（步数上限，超出非零退出）+ `--allowed-tools`（白名单防止无谓探索）+ `--output-schema`（只认结构化结论，非 JSON 即失败） |
| 密钥隔离 | agent 只看到 `OMNI_API_KEY`；`GITHUB_TOKEN` 只读；其它 secrets（部署/发布）默认不进 fix-ci job |

## 其它 headless 用法速查

```bash
# 结构化结果（jq 消费）
omni exec "任务" --output-format json | jq -r .result

# 轨迹流（每行一个事件，末行 result；tail -1 即结果）
omni exec "任务" --output-format stream-json | tail -1 | jq .

# 强制结构化结论（下游 job 读稳定字段）
omni exec "检查 .env 是否泄漏密钥" \
  --output-schema '{"type":"object","required":["verdict"],"properties":{"verdict":{"type":"string","enum":["safe","unsafe"]}}}' \
  --output-format json
# verdict 字段缺失/值非法 → exit 1（可 || 分支告警）

# 会话续跑（同一次任务失败后带新信息继续）
omni exec resume <session_id> "补充信息：..."

# 管道语义：stdout 干净 → 可安全重定向
omni exec "task" > result.txt          # 进度全部走 stderr，文件里只有结果
```

## 在 CI 里消费结构化结果

```yaml
- name: omni 安全检查
  id: check
  env:
    OMNI_API_KEY: ${{ secrets.OMNI_API_KEY }}
  run: |
    omni exec "扫描仓库是否泄露密钥" \
      --output-schema '{"type":"object","required":["verdict"]}' \
      --output-format json > /tmp/omni.json || exit 1
    echo "verdict=$(jq -r .result /tmp/omni.json | jq -r .verdict)" >> "$GITHUB_OUTPUT"

- name: 按结论分支
  if: steps.check.outputs.verdict == 'unsafe'
  run: echo '发现密钥泄露，拒绝合并'
```

## 引用

- 命令参考：`omni --help` 的 Headless 段；`omni exec --help`（参数解析错误时会打印用法）
- 验证：`scripts/probe-tmp/probe-exec.ts`（单元 + 端到端：text/json/stream-json、
  max-turns、allowed-tools、schema 通过/失败、stdin 两种形态、exec resume、MCP server 握手）