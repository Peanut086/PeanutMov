/**
 * 连接层失败的归因（P1-6）
 *
 * `fetch` 在「域名解析不了 / 上游拒连」和「设备断网」两种成因上抛的是同一个
 * `TypeError('Failed to fetch')`，历史上统统映射成 `E_NETWORK` →
 * 「网络不可用，请检查网络后重试」。真机上死源任务就是这么显示的，而当时
 * `navigator.onLine === true`——用户被引导去查 WiFi，实际问题在那条线路/那个源站。
 *
 * 口径（与 `LiveView.describeSourceError` 一致，只是这里在抛出侧就把归因做完，
 * 让下载列表、错误面板、重试按钮读到同一份语义）：
 * - 确实离线（`isOnline() === false`）→ 保留 `E_NETWORK`，文案本来就对；
 * - 在线但连不上 → `E_SOURCE_UNAVAILABLE` + 点明「本机网络正常」，并给出下一步动作；
 * - 其余错误码（超时、取消、4xx/5xx、已是 AppError）原样返回，不改写语义。
 *
 * 换成 `E_SOURCE_UNAVAILABLE` 还顺带接上了换链：该码在
 * `downloadService.STALE_LINK_CODES` 里，会先刷新直链再重试，而 `E_NETWORK` 不会。
 */
import { AppError, toAppError } from '@/shared/errors';
import { isOnline } from '@/native/network';

/**
 * 把一次「请求根本没建立起来」的失败归因到正确的对象上。
 *
 * 只处理**连接层原语异常**（fetch 抛的 TypeError 之类）。已经是 `AppError` 的原样返回：
 * 那些是调用点自己构造过的结论（`下载停滞超过 30s` / `HLS 分片不完整` /
 * `清单直连请求超时` / 爬虫闸门「该源上一次调用仍在原生侧执行」），
 * 它们的 code 已经表达过成因，再改一次就把「半截没下完」说成「线路不可用」。
 *
 * @param subject 主语，决定文案点名的对象（线路 / 源 / 直链）
 */
export function classifyConnectivityError(e: unknown, subject = '该线路'): AppError {
  if (e instanceof AppError) return e;
  const app = toAppError(e, 'E_NETWORK');
  if (app.code !== 'E_NETWORK') return app;
  if (!isOnline()) return app;
  return new AppError(
    'E_SOURCE_UNAVAILABLE',
    `${subject}暂时不可用（本机网络正常），请稍后重试或切换线路`,
    { detail: app.detail ?? app.message, httpStatus: app.httpStatus, cause: e },
  );
}
