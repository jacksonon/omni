# Omni Action（`omni/omni/action@v1` 或本仓库子目录引用）

把 Omni 变成 CI 里的「修 CI 失败」agent：一个 **read-only job** 复现失败 → `omni exec`
生成 `git diff` 补丁 → 另一个**带写权限的 job** 应用补丁并开 PR（密钥不进入生成补丁的 job）。

## 用法（完整双 job 模板见 `examples/ci/omni-fix-ci.yml`）

```yaml
jobs:
  fix:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    env: { OMNI_API_KEY: ${{ secrets.OMNI_API_KEY }} }
    steps:
      - uses: actions/checkout@v4
        with: { ref: 'main' }
      - run: npm ci && npm test   # 复现失败
        continue-on-error: true
      - id: omni
        uses: ./.github/actions/omni   # 或 owner/omni/action@v1
        with:
          task: "修复 CI 失败。失败输出：\n${{ steps.test.outputs.stdout }}"
          api-key: ${{ secrets.OMNI_API_KEY }}
      - uses: actions/upload-artifact@v4
        with: { name: patch, path: ${{ steps.omni.outputs.patch-file }} }
  apply:
    needs: fix
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: actions/download-artifact@v4
        with: { name: patch }
      - run: git apply --binary patch.diff && git add -A && git commit -m "fix: agent 修复 CI 失败" && git push -u origin agent-fix
      - uses: actions/github-script@v7
        with:
          script: "await github.rest.pulls.create({ ...owner/repo, title:'🤖 fix CI', head:'agent-fix', base:'main' })"
```

## 输入 / 输出

| 输入 | 说明 |
|---|---|
| `task` | 任务描述（可注入失败日志） |
| `api-key` / `base-url` / `model` | 端点配置（key 建议走 Secrets） |
| `max-turns` | 步数上限（默认 30） |
| `allowed-tools` | 工具白名单（默认只读+执行+写） |

| 输出 | 说明 |
|---|---|
| `patch-file` | `git diff --binary` 补丁路径（read-only job 生成，密钥不进该 job） |
| `exit-code` | `omni exec` 退出码（0 成功 / 1 失败——下游据 `${{ steps.omni.outputs.exit-code }}` 决定是否开 PR） |

## 协议冻结

`omni exec --output-format json` 的结构化结果（`schemas/exec-result.v1.json`）与
stream-json / 会话 JSONL / mcp-server / hook 协议（`schemas/`）均为 **v1 冻结**：
破坏性变更升 minor+ 并保留弃用窗口；新字段只做 addititive 追加。见 `Doc/Headless-Protocol.md`。
