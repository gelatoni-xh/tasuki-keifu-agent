import { mkdir, readFile, writeFile, rename, realpath } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import path from "node:path";
import { fingerprint, canonicalJson } from "./rules.js";
import { batchInputSchema, type BatchInput } from "./contracts.js";

export interface PayloadStore {
  put(input: BatchInput): Promise<{ ref: string; hash: string; bytes: number }>;
  get(ref: string, hash: string): Promise<BatchInput>;
}
export class DirectoryPayloadStore implements PayloadStore {
  constructor(readonly directory: string) {
    if (!path.isAbsolute(directory))
      throw new Error("Payload directory must be absolute and persistent");
  }
  async put(input: BatchInput) {
    const hash = fingerprint(input),
      bytes = gzipSync(canonicalJson(input));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const ref = `${hash}.json.gz`,
      dest = path.join(this.directory, ref);
    const temp = `${dest}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
    await rename(temp, dest);
    return { ref, hash, bytes: bytes.length };
  }
  async get(ref: string, hash: string) {
    if (!/^[a-f0-9]{64}\.json\.gz$/.test(ref) || ref !== `${hash}.json.gz`)
      throw new Error("Invalid payload reference");
    const root = await realpath(this.directory),
      file = await realpath(path.join(root, ref));
    if (path.dirname(file) !== root)
      throw new Error("Payload escaped storage directory");
    const value = batchInputSchema.parse(
      JSON.parse(
        gunzipSync(await readFile(file), {
          maxOutputLength: 64 * 1024 * 1024,
        }).toString("utf8"),
      ),
    );
    if (fingerprint(value) !== hash) throw new Error("Payload hash mismatch");
    return value;
  }
}
