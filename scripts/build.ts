import { $ } from "bun";
import { mkdir } from "fs/promises";
import { parseArgs } from "util";

const DIST_DIR = "./dist";
const PUBLIC_DIR = "./public";
const EMBEDDED_FILE = "./src/embedded.ts";

async function build() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      target: { type: "string" },
      define: { type: "string", multiple: true },
    },
    strict: false,
  });

  const forceWin = values.target === "windows";
  const forceLinux = values.target === "linux";

  const defineFlags = (values.define || []).flatMap((def) => ["--define", def]);

  console.log("🔨 Building Restream Panel...\n");

  console.log("1. Building frontend...");
  await $`bun build src/web/main.tsx --outdir ${PUBLIC_DIR} --minify ${defineFlags}`;

  console.log("\n2. Embedding static assets...");
  await mkdir(PUBLIC_DIR, { recursive: true });
  const html = await Bun.file(`${PUBLIC_DIR}/index.html`).text();
  const css = await Bun.file(`${PUBLIC_DIR}/styles.css`).text();
  const js = await Bun.file(`${PUBLIC_DIR}/main.js`).text();

  const embeddedContent = `export const EMBEDDED_HTML = ${JSON.stringify(html)};
export const EMBEDDED_CSS = ${JSON.stringify(css)};
export const EMBEDDED_JS = ${JSON.stringify(js)};
`;

  await Bun.write(EMBEDDED_FILE, embeddedContent);
  console.log(`   Generated ${EMBEDDED_FILE}`);

  console.log("\n3. Compiling binary...");

  let target = process.platform === "win32" ? "bun-windows-x64" : "bun-linux-x64";
  let ext = process.platform === "win32" ? ".exe" : "";

  if (forceWin) {
    target = "bun-windows-x64";
    ext = ".exe";
  } else if (forceLinux) {
    target = "bun-linux-x64";
    ext = "";
  }

  const outfile = `${DIST_DIR}/restream-panel${ext}`;
  await mkdir(DIST_DIR, { recursive: true });

  console.log(`   Target: ${target}`);
  await $`bun build src/main.ts --compile --target=${target} --outfile ${outfile} ${defineFlags}`;

  console.log(`\n✅ Build complete! Binary: ${outfile}`);
}

build().catch((error) => {
  console.error("❌ Build failed:", error);
  process.exit(1);
});
