import type { NextConfig } from "next";

// The browser only talks to /api/* on this origin; Next forwards it to the customer gateway (customer/api.mjs).
const gateway = (process.env.CUSTOMER_API_URL ?? "http://127.0.0.1:21952").replace(/\/+$/, "");

const config: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${gateway}/api/:path*` }];
  },
};

export default config;
