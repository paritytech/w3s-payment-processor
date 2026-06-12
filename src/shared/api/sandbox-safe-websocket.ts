// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

import { isInHost } from "@/shared/api/host/connection.ts";

function createDeniedSocket(url: string, reason: unknown): WebSocket {
  console.error(`[ws] socket to ${url} refused synchronously by the host sandbox`, reason);
  const socket = Object.assign(new EventTarget(), {
    url,
    readyState: 3 satisfies typeof WebSocket.CLOSED,
    send: () => {},
    close: () => {},
  });
  // Listeners attach synchronously right after construction; fire after that.
  setTimeout(() => {
    socket.dispatchEvent(new Event("error"));
    socket.dispatchEvent(new Event("close"));
  }, 0);
  return socket as unknown as WebSocket;
}

/**
 * `WebSocket` substitute for polkadot-api's `getWsProvider` inside a sandboxed
 * Polkadot host. The sandbox denies non-allowlisted origins by throwing
 * synchronously from the constructor ("TypeError: Network access is not
 * allowed"); `@polkadot-api/ws-provider` constructs sockets with no try/catch,
 * so the throw escapes as an uncaught crash and bypasses the provider's halt
 * path, wedging the client without retry. This class converts the denial into
 * an ordinary dead socket that emits async `error` + `close`, putting the
 * provider on its normal halt/backoff-retry path — which self-heals once the
 * `Remote` origin grant lands.
 */
export const SandboxSafeWebSocket = function (
  url: string | URL,
  protocols?: string | string[],
): WebSocket {
  try {
    return new WebSocket(url, protocols);
  } catch (caught) {
    return createDeniedSocket(String(url), caught);
  }
} as unknown as typeof WebSocket;

/** `getWsProvider` config: in-host, swap in the sandbox-safe socket class. */
export function sandboxSafeWsConfig(): { websocketClass: typeof WebSocket } | undefined {
  return isInHost() ? { websocketClass: SandboxSafeWebSocket } : undefined;
}
