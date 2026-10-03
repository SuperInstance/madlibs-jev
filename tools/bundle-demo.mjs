#!/usr/bin/env node
// tools/bundle-demo.mjs — inject the current templates + receipts ledger into
// demo/index.html (placeholders __BUNDLED_TEMPLATES__ / __BUNDLED_RECEIPTS__).
// Idempotent: replaces the CONTENT of the two bundled <script> tags by id.
// The demo stays fully self-contained: no fetch, no CDN, no network.
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const templateFiles = [
  "../templates/scene-skin.json",
  "../templates/scene-skin.v2.json",
  "../templates/discovery-skin.json",
  "../templates/discovery-skin.v2.json",
];
const templates = templateFiles.map((f) => JSON.parse(read(f)));

const ledgerRows = read("../receipts/ledger.jsonl").split("\n")
  .filter((l) => l.trim()).map((l) => JSON.parse(l));

let html = read("../demo/index.html");
const inject = (id, json) => {
  const re = new RegExp(`(<script id="${id}" type="application\\/json">)[\\s\\S]*?(</script>)`);
  if (!re.test(html)) throw new Error(`placeholder #${id} not found`);
  html = html.replace(re, (_, open, close) => open + json + close);
};
inject("bundled-templates", JSON.stringify(templates));
inject("bundled-receipts", JSON.stringify(ledgerRows));

fs.writeFileSync(new URL("../demo/index.html", import.meta.url), html);
console.log(`bundled ${templates.length} templates + ${ledgerRows.length} receipts into demo/index.html`);
