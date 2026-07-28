import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "prisma/config";

const envPath = path.resolve(process.cwd(), ".env");

if (!process.env.DATABASE_URL) {
  if (process.env.TASUKI_KEIFU_AGENT_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TASUKI_KEIFU_AGENT_DATABASE_URL;
  } else if (existsSync(envPath)) {
    const envText = readFileSync(envPath, "utf8");

    for (const rawLine of envText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      if (!key || process.env[key] !== undefined) {
        continue;
      }

      let value = line.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }

    if (process.env.TASUKI_KEIFU_AGENT_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.TASUKI_KEIFU_AGENT_DATABASE_URL;
    }
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
