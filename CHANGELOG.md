# Changelog

All notable changes to this plugin. Versions follow [semver](https://semver.org); each release is tagged `vX.Y.Z`.

## 0.1.0 — Unreleased

First release.

- Right-hand sidebar (toggle) and popup showing GitHub for the repo named after the current Herdr Space; follows the Space as you `cd` between repos.
- **PRs:** open PRs with failing and pending checks by name, review status, author, comments; view PR and checks in `less`; approve, merge and `@dependabot rebase` behind a `y/N` prompt. Approve and merge are pinned to the head commit shown.
- **CI:** recent Actions runs; failed-job log; rerun failed jobs.
- **Vulns:** open Dependabot alerts (GHSA id, severity, package, fixed version).
- Requires Herdr 0.9.5+, Node.js 22+ and a logged-in `gh`.
