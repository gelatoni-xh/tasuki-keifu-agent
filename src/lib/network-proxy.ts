import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function environmentProxy() {
  return process.env.HTTPS_PROXY
    ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY
    ?? process.env.http_proxy
    ?? null;
}

export async function resolveHttpProxy() {
  const configured = environmentProxy()?.trim();
  if (configured) {
    return configured;
  }

  if (os.platform() !== "darwin") {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("scutil", ["--proxy"], { timeout: 3000 });
    const enabled = stdout.match(/HTTPSEnable\s*:\s*(\d+)/)?.[1] === "1"
      || stdout.match(/HTTPEnable\s*:\s*(\d+)/)?.[1] === "1";
    const host = stdout.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1]
      ?? stdout.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
    const port = stdout.match(/HTTPSPort\s*:\s*(\d+)/)?.[1]
      ?? stdout.match(/HTTPPort\s*:\s*(\d+)/)?.[1];

    return enabled && host && port ? `http://${host}:${port}` : null;
  } catch {
    return null;
  }
}
