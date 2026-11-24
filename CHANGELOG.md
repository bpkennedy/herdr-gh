# Changelog

All notable changes to this plugin. Versions follow [semver](https://semver.org); each release is tagged `vX.Y.Z`.

## 0.4.0 — 2026-11-24

- **Vulns:** when Dependabot alerts are off for the repo, `e` turns them on. It asks whether Dependabot should also open PRs that fix alerts, then confirms the exact change before making it.

## 0.3.0 — 2026-11-18

- Windows support. Manifest commands run `node` directly instead of through `sh`; on Windows, logs and PRs page through `more` and links open with the default browser.

## 0.2.0 — 2026-11-18

- Renamed from "GitHub Monitor" to **GitHub Ops**: it reviews, merges and reruns, not only watches. Plugin id (`bpkennedy.herdr-gh`) and action ids are unchanged, so keybindings keep working. Close any sidebar opened by an older version before toggling again; it is recognised by its old title.
- README: screenshots and a demo of the panel following the Space.

## 0.1.1 — 2026-11-18

- Default `merge_method` is now `merge` (was `squash`). Existing config files keep their value.
- Merge prompt reads `merge #12 Title (merge)`.

## 0.1.0 — 2026-11-18

First release.

- Right-hand sidebar (toggle) and popup showing GitHub for the repo named after the current Herdr Space; follows the Space as you `cd` between repos.
- **PRs:** open PRs with failing and pending checks by name, review status, author, comments; view PR and checks in `less`; approve, merge and `@dependabot rebase` behind a `y/N` prompt. Approve and merge are pinned to the head commit shown.
- **CI:** recent Actions runs; failed-job log; rerun failed jobs.
- **Vulns:** open Dependabot alerts (GHSA id, severity, package, fixed version).
- Requires Herdr 0.9.5+, Node.js 22+ and a logged-in `gh`.
