import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // API do monitor (Fastify)
      { source: "/api/monitor/:path*", destination: "http://192.168.1.125:3030/api/:path*" },
      // WS não passa por rewrite do Next, vamos usar URL direto no front
    ];
  },
};

export default nextConfig;
