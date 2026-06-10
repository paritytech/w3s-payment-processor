// SPDX-License-Identifier: GPL-3.0-or-later
// @paritytech

/**
 * Generate throwaway German fiscal TSE QR codes ("Kassenbeleg-V1", KassenSichV
 * §6 / DSFinV-K §4.2) as PNGs, in the wire shape w3spay's `parseTseQr` consumes.
 * Seeds the scanner with test receipts; every identifier is synthetic.
 *
 * Wire format — twelve `;`-delimited fields:
 *   V0;<terminalId>;Kassenbeleg-V1;Beleg^0.00_0.00_0.00_0.00_<eur>^<eur>:Bar;
 *   <txNumber>;<sigCounter>;<startTime>;<logTime>;
 *   ecdsa-plain-SHA256;unixTime;<signatureB64>;<publicKeyB64>
 *
 * Usage:
 *   node scripts/generate-receipt-qrs.mjs
 *   node scripts/generate-receipt-qrs.mjs --terminals=TILL-0001,TILL-0002 --count=4
 *   node scripts/generate-receipt-qrs.mjs --min=0.01 --max=0.20 --out=qr-codes
 */

import { randomBytes, randomInt } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Defaults (override via CLI flags); all identifiers are synthetic test data.
const DEFAULT_TERMINAL_IDS = ["TILL-0001"];
const DEFAULT_COUNT_PER_TERMINAL = 1;
const DEFAULT_MIN_CENTS = 1;
const DEFAULT_MAX_CENTS = 20;
const DEFAULT_OUT_DIR = "qr-codes";

const QR_VERSION = "V0";
const PROCESS_TYPE = "Kassenbeleg-V1";
const SIG_ALGORITHM = "ecdsa-plain-SHA256";
const LOG_TIME_FORMAT = "unixTime";

// Synthetic device key: a random 65-byte uncompressed P-256 point (0x04 prefix),
// constant for this run. Not a real TSE key — v1 does not verify signatures.
const PUBLIC_KEY_B64 = (() => {
  const point = randomBytes(65);
  point[0] = 0x04;
  return point.toString("base64");
})();

const QR_PNG_OPTIONS = {
  errorCorrectionLevel: "M",
  margin: 2,
  width: 512,
  color: { dark: "#1c1917", light: "#fafaf9" },
};

const eur = (cents) => (cents / 100).toFixed(2);

function uniqueInt(seen, min, max) {
  let n;
  do {
    n = randomInt(min, max + 1);
  } while (seen.has(n));
  seen.add(n);
  return n;
}

const randomSignature = () => randomBytes(64).toString("base64");

function isoSeconds(ms) {
  const d = new Date(ms);
  d.setMilliseconds(0);
  return d.toISOString();
}

const slug = (value) => value.replace(/[^A-Za-z0-9-]+/g, "_");

function buildPayload({ terminalId, amountCents, txNumber, sigCounter, startTime, logTime }) {
  const amount = eur(amountCents);
  const processData = `Beleg^0.00_0.00_0.00_0.00_${amount}^${amount}:Bar`;
  return [
    QR_VERSION,
    terminalId,
    PROCESS_TYPE,
    processData,
    txNumber,
    sigCounter,
    startTime,
    logTime,
    SIG_ALGORITHM,
    LOG_TIME_FORMAT,
    randomSignature(),
    PUBLIC_KEY_B64,
  ].join(";");
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function centsFromEur(raw, fallback) {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`invalid EUR amount: "${raw}"`);
  return Math.round(n * 100);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const terminalIds = (args.terminals ? args.terminals.split(",") : DEFAULT_TERMINAL_IDS)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terminalIds.length === 0) {
    throw new Error("no terminal ids — pass --terminals=a,b,c");
  }

  const count = args.count != null ? Number.parseInt(args.count, 10) : DEFAULT_COUNT_PER_TERMINAL;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`--count must be a positive integer, got "${args.count}"`);
  }

  const minCents = centsFromEur(args.min, DEFAULT_MIN_CENTS);
  const maxCents = centsFromEur(args.max, DEFAULT_MAX_CENTS);
  if (minCents < 1) throw new Error("--min must be ≥ 0.01 EUR (parser rejects non-positive totals)");
  if (maxCents < minCents) throw new Error("--max must be ≥ --min");

  const outDir = resolve(PKG_ROOT, args.out ?? DEFAULT_OUT_DIR);
  await mkdir(outDir, { recursive: true });

  const usedTx = new Set();
  const usedSig = new Set();
  const manifest = [];

  for (const terminalId of terminalIds) {
    for (let i = 0; i < count; i++) {
      const amountCents = randomInt(minCents, maxCents + 1);
      const txNumber = uniqueInt(usedTx, 1000, 9_999_999);
      const sigCounter = uniqueInt(usedSig, 1, 999_999);
      const logTime = isoSeconds(Date.now());
      const startTime = isoSeconds(Date.now() - randomInt(3, 31) * 1000);

      const payload = buildPayload({ terminalId, amountCents, txNumber, sigCounter, startTime, logTime });
      const fileName = `receipt-${slug(terminalId)}-${txNumber}-${eur(amountCents)}EUR.png`;
      await QRCode.toFile(join(outDir, fileName), payload, QR_PNG_OPTIONS);

      manifest.push({ terminalId, txNumber, sigCounter, amountEur: eur(amountCents), file: fileName, payload });
      console.log(`  ${fileName}  →  terminal ${terminalId}, txNo ${txNumber}, ${eur(amountCents)} EUR`);
    }
  }

  await writeFile(join(outDir, "index.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nGenerated ${manifest.length} QR code(s) across ${terminalIds.length} terminal(s) → ${outDir}`);
}

main().catch((error) => {
  console.error(`generate-receipt-qrs failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
