// The hosted desk's address, read from tools/desk-url.txt (one line, no trailing slash). DESK_URL wins when set.
import fs from "node:fs";

const file = new URL("./desk-url.txt", import.meta.url);
export const DESK = (process.env.DESK_URL || fs.readFileSync(file, "utf8")).trim().replace(/\/+$/, "");
