import { readFileSync } from "node:fs";

const indexHtml = readFileSync("index.html", "utf8");
const ids = new Set([...indexHtml.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));

const files = [
  "src/client/App.ts",
  "src/client/ui/HudController.ts",
  "src/client/ui/LobbyController.ts",
  "src/client/ui/ResultsController.ts",
  "src/client/ui/TouchControls.ts",
  "src/client/ui/ModalManager.ts",
  "src/client/ui/dom.ts",
];

const referenced = new Set<string>();
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/byId(?:<[^>]*>)?\("([^"]+)"\)/g)) {
    referenced.add(match[1]);
  }
  for (const match of source.matchAll(/querySelector(?:All)?(?:<[^>]*>)?\("([^"]+)"\)/g)) {
    const selector = match[1];
    for (const id of selector.matchAll(/#([\w-]+)/g)) referenced.add(id[1]);
  }
}

const missing = [...referenced].filter((id) => !ids.has(id)).sort();
const unused = [...ids].filter((id) => !referenced.has(id)).sort();

console.log(`dom ids in index.html: ${ids.size}`);
console.log(`ids referenced by client code: ${referenced.size}`);
console.log(`missing in index.html (${missing.length}):`, missing);
console.log(`not referenced by audited files (${unused.length}):`, unused);

const dataAttributes = new Set<string>();
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/data-([a-z-]+)=/g)) dataAttributes.add(match[1]);
}
console.log("data attributes used in JS:", [...dataAttributes].sort());

if (missing.length > 0) process.exit(1);
