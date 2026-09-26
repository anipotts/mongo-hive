import type { NextConfig } from "next";
import path from "node:path";

// the console reads the same atlas cluster as the agents, with the repo-root .env (server-side only)
try {
  process.loadEnvFile(path.join(__dirname, "..", ".env"));
} catch {
  // no local .env: rely on the environment (e.g. vercel project env vars)
}

const nextConfig: NextConfig = {
  // lets a verification build run beside `next dev` without clobbering it
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // share src/ (validator, publish, registry) with the mcp server so the console never re-implements the rules.
  // src/ uses node-style ".js" specifiers for .ts files, which webpack maps via extensionAlias.
  experimental: { externalDir: true },
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return config;
  },
};

export default nextConfig;
