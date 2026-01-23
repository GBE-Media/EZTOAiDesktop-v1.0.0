/**
 * Semantic Release Configuration
 * 
 * Commit message format (Conventional Commits):
 * - fix: description  → Patch release (1.0.0 → 1.0.1)
 * - feat: description → Minor release (1.0.0 → 1.1.0)
 * - feat!: description or BREAKING CHANGE: → Major release (1.0.0 → 2.0.0)
 * 
 * Examples:
 * - fix: resolve login issue
 * - feat: add dark mode support
 * - feat!: redesign API endpoints
 * - chore: update dependencies (no release)
 * - docs: update README (no release)
 */
module.exports = {
  branches: ['main'],
  plugins: [
    // Analyze commits to determine version bump
    ['@semantic-release/commit-analyzer', {
      preset: 'angular',
      releaseRules: [
        { type: 'feat', release: 'minor' },
        { type: 'fix', release: 'patch' },
        { type: 'perf', release: 'patch' },
        { type: 'refactor', release: 'patch' },
        { type: 'style', release: 'patch' },
        { type: 'build', release: 'patch' },
        { breaking: true, release: 'major' },
      ],
    }],
    // Generate release notes
    '@semantic-release/release-notes-generator',
    // Generate/update CHANGELOG.md
    ['@semantic-release/changelog', {
      changelogFile: 'CHANGELOG.md',
    }],
    // Update package.json version and commit changes
    ['@semantic-release/git', {
      assets: ['package.json', 'package-lock.json', 'CHANGELOG.md'],
      message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
    }],
    // Create GitHub release (electron-builder will add artifacts to this)
    ['@semantic-release/github', {
      successComment: false,
      failComment: false,
    }],
  ],
};
