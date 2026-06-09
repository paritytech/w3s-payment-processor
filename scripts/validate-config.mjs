// Deploy preflight: validate the STATIC / build-time config only — the
// chain/token/host env wiring in src/config.ts plus the on-chain registry the
// processor reads per-merchant config from at unlock. The per-merchant config
// bundles (profile + v1/v2 terminals incl. PEM) are NOT bundled: they are
// published from w3spay-admin, content-addressed on Bulletin, and AES-GCM
// decrypted at unlock time.
// Run via vite-node so TS + the `@/` alias + import.meta.env all resolve.
try {
  const { envConfig } = await import("../src/config.ts");
  const net = envConfig.network;
  const registry = envConfig.remoteCredentials.registryAddress.trim();
  if (registry === "") {
    console.warn(
      "static config WARNING — VITE_W3SPAY_REGISTRY_ADDRESS is empty; the app stays locked until it is set.",
    );
  }
  console.log(
    `static config OK — network "${net.key}" (${net.displayName}); ` +
      `token ${envConfig.token.symbol} (${envConfig.token.decimals}dp); ` +
      `host ${envConfig.host.productDotNs}; ` +
      `listeners v1=${envConfig.protocols.v1Enabled ? "on" : "off"} v2=${envConfig.protocols.v2Enabled ? "on" : "off"}; ` +
      `registry ${registry || "(unset)"}`,
  );
} catch (error) {
  console.error(`static config INVALID: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
