const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const pkgPath = path.join(rootDir, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

const shortSha = (process.env.GITHUB_SHA || "local").slice(0, 7);
const baseVersion = pkg.version || "0.0.0";
const releaseTag = `ci-${baseVersion}-${shortSha}`;

const releaseEnv = {
  ...process.env,
  GH_TOKEN: process.env.GH_TOKEN,
};

const run = (command) => {
  execSync(command, { stdio: "inherit", cwd: rootDir, env: releaseEnv });
};

console.log(`Publishing release: ${releaseTag}`);

run("npm run build");
run("npm run electron:build");
run(`npx electron-builder --publish always --config.extraMetadata.version=${releaseTag}`);
