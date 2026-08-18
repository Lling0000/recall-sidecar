import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const destination = join(root, "dist", "assets", "dashboard");
await mkdir(destination, { recursive: true });
await cp(join(root, "assets", "dashboard"), destination, { recursive: true });
