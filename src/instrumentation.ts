// Runs once when the Next.js server starts. The env check lets the bundler drop
// Node-only modules (SQLite) from the edge build.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
