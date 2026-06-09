# Deploy

Builds the SPA and publishes it as a `.dot` product via `bulletin-deploy`.

## Prerequisites

- Node ≥ 22
- `npm install` (pins `bulletin-deploy@^0.10.0`; the script requires ≥ 0.10.0)

## Configure

```bash
cp .env.example .env.local
```

Set in `.env.local` (gitignored — never commit a mnemonic):

| Variable | Required | Notes |
| --- | --- | --- |
| `MNEMONIC` or `DOTNS_MNEMONIC` | yes | 12- or 24-word publisher phrase. If both set, must match. |
| `VITE_DOTNS_PRODUCT_DOMAIN` | yes | Target `.dot` name. No default — drives BOTH the deploy target AND the v2 claim wallet. |
| `VITE_NETWORK` | no | Defaults to `BULLETIN_ENV` (`paseo-next-v2`). Must match it. |
| `VITE_W3SPAY_REGISTRY_ADDRESS` | no | `src/config.ts` carries the network default. |

Per-merchant credentials are NOT provisioned here — they are published encrypted from w3spay-admin and fetched at unlock.

## Deploy

```bash
npm run deploy
# or override the domain for one run:
npm run deploy -- mydomain.dot
```

If both the env var and the CLI arg are set, they must match — the script aborts otherwise.

The script runs the `validate-config` preflight (chain/token/host env only), builds, rewrites `dist/manifest.toml` with the resolved domain, and runs `bulletin-deploy --env paseo-next-v2`.

Result: `https://<name>.dot.li`
