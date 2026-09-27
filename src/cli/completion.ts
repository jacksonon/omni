/**
 * `omni completion <shell>`：生成 shell 补全脚本（codex completion 对等）。
 * 覆盖子命令 + 常用 flags（bash/zsh；其它 shell 暂不支持，用法错时提示）。
 * 纯函数拼字符串（可单测断言内容；bash -n / zsh -n 做语法校验）。
 */

/** 顶层子命令（main.ts 分发口径） */
const SUBCOMMANDS = [
  'exec',
  'mini',
  'web',
  'plugin',
  'preset',
  'import',
  'watch',
  'mcp-server',
  'acp',
  'completion',
];

/** 全局 flags（parseArgs 口径） */
const GLOBAL_FLAGS = [
  '-m', '--model',
  '-c', '--continue',
  '-C', '--config',
  '--profile',
  '-s', '-r', '--resume',
  '-l', '--list-sessions',
  '-f', '--full', '--all',
  '--cd',
  '--lang',
  '--no-tui',
  '-h', '--help',
  '-v', '--version',
];

/** 分命令 flags（常用子集；exec/mini/web 为补全重点） */
const COMMAND_FLAGS: Record<string, string[]> = {
  exec: ['--output-format', '--max-turns', '--allowed-tools', '--output-schema', '--quiet', '--approve-for-me', 'resume'],
  mini: ['-o', '--output-last-message', '--approve-for-me', '-c', '-s', '--cd'],
  web: ['--port', '--host', '--no-open', '--token'],
  plugin: ['install', 'list', 'enable', 'disable', 'remove'],
};

/** bash 补全（bash 3.2 兼容：不用关联数组/mapfile；文件/目录回退默认补全） */
function bashScript(): string {
  const subs = SUBCOMMANDS.join(' ');
  const globals = GLOBAL_FLAGS.join(' ');
  const cases = Object.entries(COMMAND_FLAGS)
    .map(([cmd, flags]) => `      ${cmd}) COMPREPLY=($(compgen -W "${flags.join(' ')}" -- "$cur")) ;;`)
    .join('\n');
  return `# omni bash completion: eval "\$(omni completion bash)" 或写入 ~/.bash_completion
_omni() {
  local cur prev cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${subs} ${globals}" -- "$cur"))
    return 0
  fi
  case "$cmd" in
${cases}
      *) COMPREPLY=($(compgen -W "${globals}" -- "$cur")) ;;
  esac
  if [ "$prev" = "-o" ] || [ "$prev" = "--output-last-message" ] || [ "$prev" = "-C" ] || [ "$prev" = "--config" ] || [ "$prev" = "--cd" ]; then
    COMPREPLY=($(compgen -f -- "$cur"))
  fi
}
complete -o default -F _omni omni
`;
}

/** zsh 补全（#compdef；_arguments 按位置分发） */
function zshScript(): string {
  const subs = SUBCOMMANDS.join(' ');
  const globals = GLOBAL_FLAGS.map((f) => (f.startsWith('--') ? `${f}[global option]` : `${f}[global option]`)).join(' ');
  const execFlags = COMMAND_FLAGS.exec!.map((f) => (f.startsWith('-') ? `'${f}[exec option]'` : `': :->args'`)).join(' ');
  const miniFlags = COMMAND_FLAGS.mini!.map((f) => `'${f}[mini option]'`).join(' ');
  return `# omni zsh completion: 写入 \$fpath 某目录（如 ~/.zsh/completion/_omni）后 compinit
#compdef omni
_omni() {
  local context state line
  typeset -A opt_args
  _arguments -C \
    '1: :->cmd' \
    '*:: :->args' && return 0
  case $state in
    cmd)
      _describe -t commands 'omni command' '(${subs})' && return 0
      ;;
    args)
      case $line[1] in
        exec)
          _arguments ${execFlags} '*:task:_files' && return 0
          ;;
        mini)
          _arguments ${miniFlags} '*:task:_files' && return 0
          ;;
        web)
          _arguments '--port[port]' '--host[host]' '--no-open[no browser]' '--token[token]' && return 0
          ;;
      esac
      ;;
  esac
  _arguments '${globals}' && return 0
}
_omni
`;
}

/** 取某 shell 的补全脚本；不支持返回 null（调用方打印用法） */
export function completionScript(shell: string): string | null {
  const s = shell.trim().toLowerCase();
  if (s === 'bash') return bashScript();
  if (s === 'zsh') return zshScript();
  return null;
}

/** `omni completion [shell]` 入口：打印脚本；缺省/非法打印用法并返回非零 */
export function runCompletionCommand(args: string[]): number {
  const shell = (args[0] ?? '').trim().toLowerCase() || 'bash';
  const script = completionScript(shell);
  if (!script) {
    console.error(`未知 shell「${args[0]}」——可选：bash / zsh（如：eval "$(omni completion bash)"）`);
    return 1;
  }
  process.stdout.write(script);
  return 0;
}
