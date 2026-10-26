import { readServerRecord } from '../server/discovery.js';
import { runBotCommand } from './bot.js';
export async function runPetCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('omni pet [show|hide|status]\n显示 / 隐藏桌面宠物（需要桌面应用）；status 查看已有共享服务的任务。\n形象与对话页开关：Web/Electron 侧栏「宠物」。终端任务会同步驱动宠物状态。'); return 0;
  }
  const command = args[0] || 'show';
  if (command === 'status') {
    const record = readServerRecord();
    if (!record) { console.log(JSON.stringify({ version: 1, connected: false, tasks: [] }, null, 2)); return 0; }
    try {
      const r = await fetch(`http://127.0.0.1:${record.port}/_omni/pet`, { headers: { authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error('共享服务未连接');
      console.log(JSON.stringify({ connected: true, ...await r.json() as object }, null, 2)); return 0;
    } catch { console.log(JSON.stringify({ version: 1, connected: false, tasks: [] }, null, 2)); return 0; }
  }
  if (!['show', 'hide'].includes(command)) { console.error('用法：omni pet [show|hide|status]'); return 1; }
  return runBotCommand([...args.slice(args.length ? 1 : 0), command === 'show' ? '--pet' : '--pet-hide']);
}
