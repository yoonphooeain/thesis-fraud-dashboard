import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distClient = join(projectRoot, "dist", "client");
const outDir = join(projectRoot, process.env.PAGES_OUT_DIR ?? "docs");
const rawBasePath =
  process.env.PAGES_BASE_PATH ??
  (process.env.GITHUB_REPOSITORY ? `/${process.env.GITHUB_REPOSITORY.split("/")[1]}` : "");
const basePath = rawBasePath.replace(/\/+$/, "");

const routes = [
  "/",
  "/gift-cards",
  "/checkout",
  "/otp",
  "/result",
  "/admin",
  "/admin/dashboard",
  "/admin/cases",
  "/admin/transactions",
  "/admin/review",
  "/admin/audit",
];

function routeOutputFile(route) {
  if (route === "/") return join(outDir, "index.html");
  return join(outDir, route.replace(/^\//, ""), "index.html");
}

function withBasePath(path) {
  if (!basePath || !path.startsWith("/")) return path;
  if (path === "/") return `${basePath}/`;
  return `${basePath}${path}`;
}

function rewriteHtmlForPages(html) {
  if (!basePath) return html;

  let nextHtml = html
    .replaceAll("http://localhost:3000/og.png", withBasePath("/og.png"))
    .replaceAll("http://localhost/og.png", withBasePath("/og.png"));

  nextHtml = nextHtml.replace(
    /(["'])\/(assets\/|gift-card-[^"']+|login-ai-security-robot\.png|thesis-gift-card-secure\.png|favicon\.svg|file\.svg|globe\.svg|window\.svg|og\.png)([^"']*)\1/g,
    (_match, quote, prefix, suffix) => `${quote}${withBasePath(`/${prefix}${suffix}`)}${quote}`,
  );

  nextHtml = nextHtml.replace(
    /(href=)(["'])\/(["'])/g,
    (_match, attr, quote) => `${attr}${quote}${withBasePath("/")}${quote}`,
  );

  nextHtml = nextHtml.replace(
    /(href=)(["'])\/(admin(?:\/(?:dashboard|cases|transactions|review|audit))?|checkout|gift-cards|otp|result)([^"']*)\2/g,
    (_match, attr, quote, route, suffix) => `${attr}${quote}${withBasePath(`/${route}${suffix}`)}${quote}`,
  );

  nextHtml = nextHtml.replace(
    /(["'])\/(admin(?:\/(?:dashboard|cases|transactions|review|audit))?|checkout|gift-cards|otp|result)(?=[?#"'])/g,
    (_match, quote, route) => `${quote}${withBasePath(`/${route}`)}`,
  );

  return nextHtml;
}

async function renderRoute(worker, route) {
  const response = await worker.fetch(
    new Request(`http://localhost${route}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to render ${route}: ${response.status}`);
  }
  return rewriteHtmlForPages(await response.text());
}

await rm(outDir, { force: true, recursive: true });
await mkdir(outDir, { recursive: true });
await cp(distClient, outDir, { recursive: true });
await writeFile(join(outDir, ".nojekyll"), "");

const workerUrl = pathToFileURL(join(projectRoot, "dist", "server", "index.js"));
workerUrl.searchParams.set("static-export", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

for (const route of routes) {
  const html = await renderRoute(worker, route);
  const outputFile = routeOutputFile(route);
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, html);
  console.log(`exported ${route} -> ${outputFile}`);
}

await writeFile(join(outDir, "404.html"), rewriteHtmlForPages(await renderRoute(worker, "/")));
console.log(`GitHub Pages export ready: ${outDir}`);
