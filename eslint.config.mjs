import nextConfig from "eslint-config-next";

const config = [...nextConfig, { ignores: [".next/**", "node_modules/**", "data/**", "next-env.d.ts"] }];

export default config;
