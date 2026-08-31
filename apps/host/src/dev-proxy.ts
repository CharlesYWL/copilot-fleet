export type ProxyRequest = {
  getHeader(name: string): string | string[] | number | undefined;
  setHeader(name: string, value: string): void;
};

/**
 * Makes Vite's internal proxy hop look same-origin to the Host.
 *
 * The browser is legitimately talking to Vite on 5173, but Vite forwards that
 * request to the API on another port without changing `Origin`. The Host's
 * exact-origin guard then sees `5173 -> 8790` and rejects it. Rewriting only
 * inside the development proxy preserves the production guard unchanged.
 */
export function rewriteDevProxyOrigin(
  request: ProxyRequest,
  browserOrigin: string,
): void {
  if (request.getHeader("origin") !== undefined) {
    request.setHeader("origin", browserOrigin);
  }
}
