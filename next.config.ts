import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@allorc/a423-sdk', 'ethers', '@libsql/client', 'libsql'],
  allowedDevOrigins: ['*.trycloudflare.com'],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
