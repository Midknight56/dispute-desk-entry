import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function modelIdFrom(sourceText) {
  return sourceText.match(/export\s+const\s+MODEL\s*=\s*"([^"]+)"/)?.[1];
}

export function modelPageUrl(id) {
  const slug = id?.split("/").at(-1);
  if (!slug) throw new Error("Could not read MODEL id from src/agent.ts");
  return `https://developers.cloudflare.com/workers-ai/models/${slug}/`;
}

export function deprecationLine(pageText) {
  return pageText.match(/[^\r\n]*deprecat[^\r\n]*/i)?.[0];
}

export async function main() {
  try {
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const source = await readFile(resolve(root, "src/agent.ts"), "utf8");
    const id = modelIdFrom(source);
    const response = await fetch(modelPageUrl(id));
    if (response.status !== 200) {
      console.error(`model check failed: model page returned HTTP ${response.status}`);
      process.exitCode = 1;
      return;
    }
    const line = deprecationLine(await response.text());
    if (line) {
      console.error(`model check failed: ${id} has a deprecation line: ${line.trim()}`);
      process.exitCode = 1;
      return;
    }
    console.log(`model ok: ${id}, no deprecation line`);
  } catch (error) {
    console.error(`model check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
