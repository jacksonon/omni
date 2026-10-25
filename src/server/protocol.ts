/** 本机共享服务协议：只暴露身份信息，不借用含 provider 配置的 /api/status 探活。 */
export const SERVER_PROTOCOL = 1;
export const SERVER_PRODUCT = 'omni-shared-server';
export const BROKER_COOKIE = 'omni_broker';

export interface ServerRecord {
  product: typeof SERVER_PRODUCT;
  protocol: typeof SERVER_PROTOCOL;
  version: string;
  pid: number;
  port: number;
  token: string;
  startedAt: number;
}

export interface ServerConnection {
  /** 工作区 API/页面的公共前缀；不含末尾 /。 */
  url: string;
  serverUrl: string;
  workspaceId: string;
  token: string;
  /** 一次性、短效的浏览器登录链接；不含长期服务令牌。 */
  browserUrl: string;
}
