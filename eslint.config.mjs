import nextConfig from "eslint-config-next";

const config = [...nextConfig, { ignores: [".next/**", "node_modules/**", "data/**", "data-mock/**", "next-env.d.ts", "scripts/**/*.d.mts"] }];

export default config;
