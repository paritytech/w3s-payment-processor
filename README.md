# W3sPay Payment Processor

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

This is code developed and published by Parity as an experimental proof-of-concept. It is **not** a Parity product or service, and Parity does not operate, host, deploy, or endorse any downstream deployment of it — downstream operators run their own forks at their own discretion.

Per-merchant, always-on dashboard for the W3sPay payment surface. The app unlocks merchant credentials on device, monitors v1 on-chain CASH credits and v2 Statement Store payments in parallel, claims supported v2 bearer coins through the Polkadot host, and gives staff live totals, reconciliation, reports, and network status.

## Getting Started

### Deploy

> [!IMPORTANT]
> **Deploy [w3spay-admin](../w3spay-admin/) first** — it owns the `W3SPayRegistry`
> this app reads and publishes the encrypted per-merchant config fetched at unlock.
> Without an admin-published config for your group, the unlock gate has nothing to
> resolve. See [DEPLOY.md](./DEPLOY.md).

```bash
npm install
cp .env.example .env.local        # set secrets, or let the wizard prompt
npm run setup                     # guided deploy: configure → readiness → publish
```

See **[DEPLOY.md](./DEPLOY.md)** for the full guide: the `npm run setup` wizard, the `.env.local` variable table, flags (`--yes`, `--dry-run`, `--publish`, …), and the manual `npm run deploy` path.

### Per-merchant config

Per-merchant config (group profile + v1/v2 terminals incl. PEM) is published
from the **w3spay-admin** app: the operator fills it out, it is AES-encrypted
with a group passkey, uploaded to Bulletin via the host, and its CID recorded
on the W3SPay registry contract. This app reads that CID by `groupId` at unlock
— set `VITE_W3SPAY_REGISTRY_ADDRESS` to the deployed registry (defaulted in
`src/config.ts`).

### Frontend (local dev)

```bash
npm install
cp .env.example .env.local        # then set VITE_DOTNS_PRODUCT_DOMAIN and VITE_* values
npm run dev                       # http://localhost:5176
```

The app renders a merchant unlock gate first. Monitors do not mount until the POS group and passkey resolve a valid remote credential bundle.

### Checks

```bash
npm run validate-config
npm test
npm run typecheck
npm run build
```

## Adding a Network

There are two supported paths:

- **One-off deploy** — set `VITE_NETWORK` and `BULLETIN_ENV` to an existing supported key (`paseo-next-v2`, `paseo`, or `previewnet`) before running `npm run deploy`.
- **Permanent built-in network** — commit a new network entry so the app and deployment script agree on the same chain.

For a permanent network:

1. Add the key to `NetworkKey`, `SUPPORTED_NETWORKS`, and `NETWORKS` in `src/shared/api/host/networks.ts`.
2. Add the same key to the supported-network check in `deploy.sh`.
3. Confirm the network has the main-chain and People-chain endpoints required by the enabled v1 / v2 flows.
4. Add `.env.<network>.example` templates if contributors need a starting point.
5. Confirm `bulletin-deploy` supports the same `BULLETIN_ENV` value before publishing.

## Security

Before deploying it for real use cases, you are responsible for:

- Reviewing the code yourself; this is a reference proof-of-concept, not a hardened production build.
- Checking that dependencies are up to date and free of known vulnerabilities.
- Securing your own fork or deployment environment, especially mnemonics, CI secrets, remote credential passkeys, PEMs, DotNS ownership, and Bulletin upload authority.
- Tracking the latest tagged release / commits for security fixes; older releases are not backported (exceptions might apply).

For Parity's security disclosure process and Bug Bounty program, see [parity.io/bug-bounty](https://parity.io/bug-bounty).

## License

Licensed under [GPL-3.0-or-later](./LICENSE).
