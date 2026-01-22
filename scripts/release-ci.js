const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const pkgPath = path.join(rootDir, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

const shortSha = (process.env.GITHUB_SHA || "local").slice(0, 7);
const runId = process.env.GITHUB_RUN_ID || Date.now().toString();
const baseVersion = pkg.version || "0.0.0";
// Use numeric version for Windows compatibility, tag for release naming
const buildNumber = Date.now().toString().slice(-6);
const numericVersion = baseVersion === "0.0.0" ? `0.1.${buildNumber}` : baseVersion;
const releaseTag = `v${numericVersion}-${shortSha}-run-${runId}`;

const releaseEnv = {
  ...process.env,
  GH_TOKEN: process.env.GH_TOKEN,
};

const run = (command) => {
  execSync(command, { stdio: "inherit", cwd: rootDir, env: releaseEnv });
};

console.log(`Publishing release: ${releaseTag} (version: ${numericVersion})`);

run("npm run build");
run("npm run electron:build");
run(
  `npx electron-builder --publish always --config.extraMetadata.version=${numericVersion} --config.publish[0].tag=${releaseTag}`
);
