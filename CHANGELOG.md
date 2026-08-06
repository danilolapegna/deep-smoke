# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-06

First public release.

### Added

- **Three smoke levels.** Level 1 visits one route plus a probe of a URL that
  should not exist. Level 2 covers a feature surface, signed out and signed in,
  following links one hop. Level 3 walks the entire reachable route tree as every
  declared persona and checks the authentication rules.
- **Seven failure classes, each individually switchable:** uncaught exceptions,
  error boundaries, blank screens, HTTP 4xx and 5xx on navigation, broken
  same-origin assets, console errors matching a configurable severity and pattern
  set, and authentication rule violations.
- **Pluggable authentication** with four strategies: `none`, `form`,
  `storageState` and `module`. No auth provider is special-cased. Secrets are
  referenced as `env:VARIABLE_NAME` and never printed.
- **Authentication rules at level 3:** a protected route must redirect an
  anonymous visitor, and a public route must not bounce a signed-in one. Declared
  rules are probed explicitly rather than inferred from wherever the crawl
  happened to reach.
- **Session engagement check.** An authenticated persona whose every protected
  route redirected away fails the run, instead of reporting a healthy crawl of
  the sign-in page as coverage of the application.
- **Evidence files** in `.deep-smoke/L<level>-<commit>.json`, recording the
  verdict, the per-route detail, the declared scope and the commit the crawl ran
  against. The same object is what `--json` prints.
- **`verify` subcommand** with a commit-bound freshness rule: evidence is valid
  for the commit it was produced from, or a later commit with no change under the
  configured behaviour paths. Every uncertain case, including a shallow clone and
  a failing git command, resolves to stale.
- **Anti-cheat measures in `verify`:** totals are always recomputed from the
  per-route results rather than read from the file, so an edited total contradicts
  itself; evidence must embed a commit present in the repository history; level 3
  rejects truncated and `--only` scoped runs, and requires every declared persona
  to appear.
- **Retry-once on failure**, on a fresh page, so only reproducible failures are
  reported. Routes that pass on the retry are recorded as flaky.
- **Route identity de-duplication.** Identifier-shaped segments collapse to
  `:id` so a detail page is crawled once, while navigation always uses a real
  path that was observed in a link.
- **Redirect destinations are crawled.** A sign-in page usually exists only at
  the end of a guard, and a crawl that never opens it has not tested the page
  most visitors see first.
- **Browser fallback.** When no bundled browser is installed, a system
  Chromium-family channel is tried automatically. When everything fails, the
  error reported is the one from the supported path.
- **Three exit codes**, separating a failing app (1) from a wrong command (2)
  from a machine that cannot run browsers (3).
- Programmatic API exporting both the runner and the pure judgement functions.
- Test suite on `node --test` with no dependencies, including a fixture site
  served over localhost and crawled for real. Browser-dependent tests skip with a
  printed reason when Playwright is absent.

[Unreleased]: https://github.com/danilolapegna/deep-smoke/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/danilolapegna/deep-smoke/releases/tag/v0.1.0
