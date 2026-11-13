/** 共享 Server 的展示状态统一同步；不创建本地客户端或执行本地切换副作用。 */
import type { RunOptions } from '../agent/types.js';
import { resolveContextLimit } from '../config/model-context.js';
import { syncRemoteRunOptions, type ServerSession } from '../server/client.js';
import type { TuiState } from './state.js';

export function syncRemoteTuiState(remote: ServerSession, runOpts: RunOptions, state: TuiState, out: { showThinking: boolean }): void {
  syncRemoteRunOptions(remote, runOpts);
  const status = remote.status;
  state.model = status.model ?? state.model;
  state.models = (runOpts.models ?? []).map(model => model.name);
  const model = runOpts.models?.find(model => model.name === state.model);
  state.provider = model?.provider ?? '';
  state.permission = runOpts.permission ?? 'safe';
  state.planMode = runOpts.planMode ?? false;
  state.reasoningEffort = runOpts.reasoningEffort ?? '';
  state.reasoningEffortOptions = runOpts.reasoningEffortOptions ?? [];
  state.activeVariant = runOpts.activeVariant ?? null;
  state.contextLimit = typeof status.contextLimit === 'number' ? status.contextLimit
    : resolveContextLimit(runOpts.cfg?.contextLimit, model?.limit?.context) ?? 0;
  if (typeof status.cwd === 'string') state.cwd = status.cwd;
  if (status.language === 'zh' || status.language === 'en') state.language = status.language;
  if (typeof status.showThinking === 'boolean') {
    state.thinkingShow = status.showThinking;
    out.showThinking = status.showThinking;
    runOpts.showThinking = status.showThinking;
    if (runOpts.cfg) runOpts.cfg.showThinking = status.showThinking;
  }
  state.restoreHint = `omni -s ${remote.id}`;
}
