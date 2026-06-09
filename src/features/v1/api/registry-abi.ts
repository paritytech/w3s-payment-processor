// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Slice of the `W3SPayRegistry` ABI the processor uses. Mirrors
 * `apps/w3spay-admin/src/shared/chain/registry-abi.ts`:
 *  - `getAllTerminalKeys` / `getMerchantByKey` — v1 remote terminal read.
 *  - `getProcessorConfig` — config-from-chain resolution at unlock.
 *  - `addProcessorReport` (write) + `getProcessorReport` / `getProcessorReportSeqs`
 *    — on-chain Z reports. This is the one write the processor makes,
 *    permissionless on the contract side (the device is a merchant, not an admin).
 */
export const W3SPayRegistryABI = [
  {
    inputs: [],
    name: "getAllTerminalKeys",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "key", type: "bytes32" }],
    name: "getMerchantByKey",
    outputs: [
      {
        components: [
          { internalType: "string", name: "merchantId", type: "string" },
          { internalType: "string", name: "terminalId", type: "string" },
          { internalType: "bytes32", name: "destinationAccountId", type: "bytes32" },
          { internalType: "string", name: "displayName", type: "string" },
          { internalType: "enum IW3SPayRegistry.MerchantStatus", name: "status", type: "uint8" },
          { internalType: "uint64", name: "addedAt", type: "uint64" },
          { internalType: "uint64", name: "updatedAt", type: "uint64" },
          { internalType: "bool", name: "exists", type: "bool" },
        ],
        internalType: "struct IW3SPayRegistry.MerchantEntry",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "string", name: "groupId", type: "string" }],
    name: "getProcessorConfig",
    outputs: [
      {
        components: [
          { internalType: "string", name: "groupId", type: "string" },
          { internalType: "string", name: "cid", type: "string" },
          { internalType: "uint32", name: "size", type: "uint32" },
          { internalType: "uint64", name: "updatedAt", type: "uint64" },
          { internalType: "bool", name: "exists", type: "bool" },
        ],
        internalType: "struct IW3SPayRegistry.ProcessorConfigRecord",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "string", name: "groupId", type: "string" },
      { internalType: "uint64", name: "seq", type: "uint64" },
      { internalType: "string", name: "cid", type: "string" },
      { internalType: "uint32", name: "size", type: "uint32" },
    ],
    name: "addProcessorReport",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "string", name: "groupId", type: "string" },
      { internalType: "uint64", name: "seq", type: "uint64" },
    ],
    name: "getProcessorReport",
    outputs: [
      {
        components: [
          { internalType: "uint64", name: "seq", type: "uint64" },
          { internalType: "string", name: "cid", type: "string" },
          { internalType: "uint32", name: "size", type: "uint32" },
          { internalType: "uint64", name: "committedAt", type: "uint64" },
          { internalType: "bool", name: "exists", type: "bool" },
        ],
        internalType: "struct IW3SPayRegistry.ProcessorReportRecord",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "string", name: "groupId", type: "string" }],
    name: "getProcessorReportSeqs",
    outputs: [{ internalType: "uint64[]", name: "", type: "uint64[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
