#!/usr/bin/env node
// ported from packages/bodhi-pi-chrome-ext/scripts/gen-ext-key.mjs

/**
 * Generates a stable Chrome extension keypair so chrome-extension://<id>/ stays
 * the same across reloads, manual loading, and Playwright runs.
 *
 * Outputs:
 *   key.pem      private RSA key (gitignored, do NOT commit)
 *   manifest.json patched with `key` (committed)
 *   .ext-id      derived extension id (committed; e2e + tooling read this)
 *
 * Run once. Re-running rotates the key (don't unless you mean to).
 */
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const keyPath = resolve(root, "key.pem");
const manifestPath = resolve(root, "manifest.json");
const extIdPath = resolve(root, ".ext-id");

if (existsSync(keyPath) && process.argv[2] !== "--force") {
	console.error(`refusing to overwrite ${keyPath}. Pass --force to rotate.`);
	process.exit(1);
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const privatePem = privateKey.export({ type: "pkcs1", format: "pem" });
writeFileSync(keyPath, privatePem, { mode: 0o600 });

const publicKey = createPublicKey(createPrivateKey(privatePem));
const publicDer = publicKey.export({ type: "spki", format: "der" });
const publicB64 = publicDer.toString("base64");

// Chrome derives the extension id from SHA-256(public-key-DER), takes the
// first 32 hex chars, and maps each hex digit 0-9a-f → a-p.
const hash = createHash("sha256").update(publicDer).digest("hex").slice(0, 32);
const extId = Array.from(hash, (c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.key = publicB64;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

writeFileSync(extIdPath, `${extId}\n`);

console.log(`generated: ${keyPath}`);
console.log(`patched:   ${manifestPath} (key)`);
console.log(`wrote:     ${extIdPath} (${extId})`);
console.log("");
console.log(`Load unpacked at chrome://extensions and verify the id matches: ${extId}`);
