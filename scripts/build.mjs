import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_FILES = [
  "index.html",
  "agb.html",
  "datenschutz.html",
  "impressum.html",
  "styles.css",
  "legal.css",
  "script.js",
  "i18n.js",
  "robots.txt",
  "sitemap.xml",
  "admin/index.html"
];

export const PUBLIC_DIRECTORIES = ["assets"];

export async function buildStaticSite({ sourceRoot, outputRoot }) {
  const source = resolve(sourceRoot);
  const output = resolve(outputRoot);

  if (source === output) {
    throw new Error("Refusing to replace the source directory");
  }

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  await Promise.all(
    PUBLIC_FILES.map((path) => mkdir(dirname(resolve(output, path)), { recursive: true }))
  );

  await Promise.all([
    ...PUBLIC_FILES.map((path) => cp(resolve(source, path), resolve(output, path))),
    ...PUBLIC_DIRECTORIES.map((path) => cp(resolve(source, path), resolve(output, path), { recursive: true }))
  ]);
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildStaticSite({
    sourceRoot: repositoryRoot,
    outputRoot: resolve(repositoryRoot, "dist")
  });
}
