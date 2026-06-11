# Deploy

Builds the SPA and publishes it as a `.dot` product via `bulletin-deploy`.

> [!IMPORTANT]
> **Deploy [w3spay-admin](../w3spay-admin/) first.** This app is a downstream
> consumer of w3spay-admin's `W3SPayRegistry`: at unlock it fetches the encrypted
> per-merchant config by `groupId` from that registry. w3spay-admin is what
> deploys the registry and what publishes the encrypted config (recording its CID
> on the registry). Until admin has run for your group, this app has no config to
> unlock and the monitors never mount. For a fresh fork, take the `W3SPayRegistry`
> address admin prints and set it as `VITE_W3SPAY_REGISTRY_ADDRESS` (a shared
> default lives in `src/config.ts`). See [w3spay-admin/DEPLOY.md](../w3spay-admin/DEPLOY.md).

## Guided deploy (`npm run setup`)

```bash
npm install
cp .env.example .env.local   # optional — the wizard prompts for anything missing
npm run setup
```

`npm run setup` is an interactive wizard that runs the whole pipeline from a
single repo-root `.env.local`: **environment** (Node ≥ 22, `bulletin-deploy`) →
**configure** (network, domain, optional registry override, publisher mnemonic,
and whether to list the app in the Browse directory — written back to
`.env.local`) → **readiness** (Asset Hub RPC reachable) → **build & publish**
(`deploy.sh` → `bulletin-deploy`). Re-running reuses the saved choices. It does
not provision per-merchant configs — those come from w3spay-admin (above).

| Flag | Effect |
| --- | --- |
| `--network <key>` (`--env <key>`) | `paseo` \| `paseo-next-v2` \| `previewnet`. |
| `--domain <name[.dot]>` | Target domain; `.dot` is appended if missing. |
| `--publish` / `--no-publish` | List (or not) the `.dot` in the on-chain Publisher registry — the Browse directory (`paseo-next-v2` only). Default: the saved/`.env` value, else off. |
| `--yes` (`-y`, `--non-interactive`) | No prompts. Every required value must come from `.env.local`/flags. |
| `--dry-run` | Run environment + configure + readiness checks only. Writes nothing. |

Non-interactive (CI):

```bash
npm run setup -- --network paseo-next-v2 --domain yourproduct.dot --yes
```

## Prerequisites

- Node ≥ 22
- `npm install` (pins `bulletin-deploy@^0.10.0`; the script requires ≥ 0.10.0)
- **w3spay-admin deployed first** (see the note above) — its `W3SPayRegistry` and a
  published per-merchant config for your group must exist before this app can unlock.

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
| `BULLETIN_DEPLOY_PUBLISH` | no | `true` = pass `--publish` (lists the `.dot` in the Browse directory). Default `false` = upload only. |

Per-merchant credentials are NOT provisioned here — they are published encrypted from w3spay-admin and fetched at unlock.

## Manual deploy (`npm run deploy`)

```bash
npm run deploy
# or override the domain for one run:
npm run deploy -- mydomain.dot
```

If both the env var and the CLI arg are set, they must match — the script aborts otherwise.

The script runs the `validate-config` preflight (chain/token/host env only), builds, rewrites `dist/manifest.toml` with the resolved domain, and runs `bulletin-deploy --env paseo-next-v2`.

Result: `https://<name>.dot.li`
