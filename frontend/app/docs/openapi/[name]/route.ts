import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Serves the OpenAPI specs in ../docs/openapi/ to the Swagger UI at /docs.
// Only the four known files are served; `name` never reaches the file system unchecked.
const SPECS =["customer-api", "main-api", "backend", "investigator-api"] as const;
type SpecName = (typeof SPECS)[number];

const SPEC_DIR = resolve(process.cwd(), "..", "docs", "openapi");

// The customer gateway is reachable through this app's /api/* rewrite, so add this origin as the
// first server. "Try it out" then works from any browser that can open the UI.
const SAME_ORIGIN_SERVER = "servers:\n  - url: /\n    description: This UI (forwarded to the customer gateway)\n";

const isSpecName = (name: string): name is SpecName => (SPECS as readonly string[]).includes(name);

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const base = name.replace(/\.yaml$/, "");
  if (!isSpecName(base)) return new Response("not found", { status: 404 });

  let text = await readFile(join(SPEC_DIR, `${base}.yaml`), "utf8");
  if (base === "customer-api") text = text.replace(/^servers:\n/m, SAME_ORIGIN_SERVER);

  return new Response(text, {
    headers: { "content-type": "application/yaml; charset=utf-8", "cache-control": "no-store" },
  });
}
