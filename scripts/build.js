import { mkdir, copyFile, cp, rm, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join, relative, isAbsolute } from "node:path";

export async function build() {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const target = join(root, "dist");
    const outputPath = relative(resolve(root), resolve(target));
    if (outputPath !== "dist" || isAbsolute(outputPath)) throw new Error("Pasta de saída fora do projeto.");
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const name of await readdir(root)) {
        if (/\.(html|css)$/.test(name) || ["script.js", "admin.js", "validador.js", "hosting.js", "sw.js", "manifest.webmanifest"].includes(name)) {
            await copyFile(join(root, name), join(target, name));
        }
    }
    for (const name of ["assets", "vendor", "client"]) await cp(join(root, name), join(target, name), { recursive: true });
    for (const name of ["Canecas-horizontal.mp4", "HeroCaneca-optimized.mp4", "hero-poster.webp", "caneca-poster.webp"]) {
        await copyFile(join(root, name), join(target, name));
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
