// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Single facade over the Novasama Host API SDK. Product code imports host
 * primitives through here, never directly from `@novasamatech/host-api-wrapper`
 * — the wrapper owns a module-level transport singleton and the Desktop webview
 * `MessagePort.onmessage` handler; multiple physical copies clobber each other
 * and drop handshake responses.
 */
export {
  createAccountsProvider,
  createPapiProvider,
  createPaymentManager,
  createStatementStore,
  hostLocalStorage,
  preimageManager,
  requestPermission,
  sandboxProvider,
  sandboxTransport,
} from "@novasamatech/host-api-wrapper";

export type {
  AccountConnectionStatus,
  PaymentBalance,
  PaymentStatus,
  ProductAccount,
  SignedStatement,
  StatementsPage,
  StatementTopicFilter,
  Topic,
  TopUpSource,
} from "@novasamatech/host-api-wrapper";

export type { Subscription } from "@novasamatech/host-api";
