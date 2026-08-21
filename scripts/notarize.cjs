'use strict';

// Electron Builder afterSign hook：对 macOS 产物做 Apple 公证（notarize）。
//
// 仅当配置了 Apple 凭证环境变量时才执行；缺凭证则跳过。这样：
//   - 未配置 secrets 时：行为与现在一致（electron-builder 跳过签名、本脚本跳过公证），
//     构建出的 mac app 需用户本地 `xattr -cr /Applications/omni.app` 才能打开；
//   - 配置了 secrets 后：自动 Developer ID 签名 + 公证，下载即能打开，无需绕过。
//
// 使用 .cjs 扩展名：仓库 package.json 为 "type": "module"，afterSign 由
// electron-builder 以 require() 加载，必须是 CommonJS。
module.exports = async function notarize(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const applePassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !applePassword || !teamId) {
    console.warn(
      '[notarize] 未配置 Apple 凭证（APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID），跳过公证。' +
        ' 构建出的 mac app 需用户本地执行 `xattr -cr /Applications/omni.app` 才能打开。'
    );
    return;
  }

  // 懒加载：缺凭证路径不触碰此依赖，避免在缺包环境报错
  const { notarize } = require('@electron/notarize');
  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] 正在公证 ${appPath} ...`);
  await notarize({
    tool: 'notarytool',
    appBundleId: 'ai.omni.web',
    appPath,
    appleId,
    appleIdPassword: applePassword,
    teamId,
  });
  console.log('[notarize] 公证完成');
};
