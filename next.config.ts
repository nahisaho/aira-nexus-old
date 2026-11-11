import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pg", "@github/copilot-sdk"],
};
export default config;
