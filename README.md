# deep-smoke

Walk every reachable route of a web app, as every kind of user, signed in and signed out, and check that the page actually rendered something real.

Works with anything that serves routes over HTTP: React, Vue, Svelte, Angular, Astro, Next, Nuxt, Rails, Django, a folder of HTML files. It drives a browser, so it does not care what produced the page.

MIT licensed. No runtime dependencies. Playwright is an optional peer dependency.

---

## Why

"It compiles" tells you that a bundler was happy. "The component mounts" tells you that one component, in one state, in a test harness, did not throw. Neither tells you what happens when a person opens `/settings` on a Tuesday.

This gap got wider once a good share of UI code started being written by an assistant. Generated code is syntactically perfect and locally plausible. It compiles, it type-checks, the tests it wrote for itself pass. Then a route that nobody opened during review renders an error boundary, or a blank screen, or a page that a signed-out visitor should never have been able to read. None of those are compile errors. All of them are visible in half a second to anyone who opens the page.

So open the pages. All of them. As everyone who can reach them.

That is the whole idea. What makes it usable in practice is the other half: the crawl writes down what it proved, and a second command decides whether that proof still describes the code you are about to ship.

---

## Install

Requires Node 18.17 or later, Git and npm. Run these commands in your app's directory.

As of 5 October 2026, `deep-smoke` is not published on the public npm registry. Install it from the public GitHub repository instead:

```bash
npm install --save-dev --ignore-scripts "git+https://github.com/danilolapegna/deep-smoke.git#main" playwright
npx playwright install chromium
```

For a reproducible installation, replace `main` with the full commit SHA you have reviewed. Keep the generated lockfile: it records the Git revision and dependency versions. Installing adds development dependencies and updates your manifest and lockfile. It does not start a crawl or edit your application code. Chromium is a separate browser download, used locally for the checks.

Check that the installed command actually runs:

```bash
npx --no-install deep-smoke --version
```

It should print `0.1.0`. An empty response is not a successful check. Stop if installation fails or the command prints nothing.

Playwright is a peer dependency, declared optional. It is large, many projects already have it, and the `verify` subcommand needs neither it nor a browser, so a pre-push hook or a pipeline stage can check evidence on a machine that cannot run browsers at all. If it is missing when you try to crawl, deep-smoke prints the commands to install Playwright and Chromium.

---

## 60-second quick start

Start your app, then point deep-smoke at it. The example below uses `npm run dev` and port `5173`; use your app's start command and URL if they differ:

```bash
npm run dev &
npx deep-smoke --level=1 --url=http://localhost:5173
```

That checks one route and one edge case. When it passes, try the whole tree:

```bash
npx deep-smoke --level=3 --url=http://localhost:5173
```

Level 3 discovers routes by following links, so how much it finds depends on how much of your app is linked from the home page. Tell it about the rest, and about who your users are, in a config file:

```jsonc
// deep-smoke.config.json
{
  "baseUrl": "http://localhost:5173",
  "routes": ["/", "/pricing", "/sign-in", "/app", "/app/settings"],
  "protectedPrefixes": ["/app"],
  "publicRoutes": ["/", "/pricing"]
}
```

Now `npx deep-smoke --level=3` crawls those seeds, everything they link to, and checks that `/app` bounces a signed-out visitor. Add personas and it crawls the signed-in half of the app too.

Complete examples, including four ways to authenticate, are in [`examples/`](examples/).

For a small example you can build and break yourself, see [A passing smoke test can still miss your broken page](https://dev.to/danilolapegna/a-passing-smoke-test-can-still-miss-your-broken-page-5332). It shows the same site passing with an incomplete route list and failing once the missing orders page is included.

---

## The three levels

The right amount of testing depends on what the change can break. One setting for everything is either too slow to run often or too shallow to trust, so there are three, and each one is a fixed, nameable amount of paranoia.

| | What it does | When to use it | Roughly |
|---|---|---|---|
| **`--level=1`** | One route, plus a probe of a URL that should not exist. | A small, contained change. The check you run without thinking about it. | Seconds |
| **`--level=2`** | The surface of one feature, signed out and signed in, following links one hop. | A medium or large feature, or anything touching shared layout, navigation or a route guard. | Under a minute |
| **`--level=3`** | The entire reachable route tree, every persona, with and without authentication, plus the authentication rules. | The gate before merging. Run it against a production build. | Minutes |

The levels are cumulative: everything level 1 checks, level 3 also checks.

Two details worth knowing.

**Level 1 probes an unknown URL** (`/your-route/deep-smoke-unknown-route`). It is the single most useful edge case on any stack, because a missing catch-all route is invisible to a happy-path check. On that probe, the status code and emptiness checks are switched off: answering an unknown URL with a 404 is correct, and so is answering with a 200 and a client-rendered not-found view. What still counts is that the app did not throw, did not fall into an error boundary and did not fail to load its own assets.

**`--only` scopes a run** and disables link discovery, so `--only=/orders,/orders/new` visits exactly those two routes on an app whose header links to everything. A scoped run cannot satisfy a level 3 claim, and `verify` says so, because "the whole route tree" and "the two routes I chose" are different sentences.

---

## What counts as a failure

Every check can be switched off individually under `checks` in the config.

| Check | Fails when | Config key |
|---|---|---|
| Uncaught exception | Anything reached `window.onerror` during the visit. | `pageExceptions` |
| Error boundary | An error fallback is on screen instead of the page. | `errorBoundaries` |
| Blank screen | The app root has no children and the page has no text. | `blankScreen` |
| HTTP status | The document, or a same-origin request, answered 4xx or 5xx. | `httpStatus` |
| Broken asset | A same-origin script, stylesheet, font or image 404s. | `brokenAssets` |
| Console error | A console message matched the configured patterns. | `consoleErrors` |
| Authentication rules | A protected route was readable while signed out, or a public route bounced a signed-in visitor. | `authRedirects` |

### How it avoids crying wolf

A crawler that fails healthy pages gets bypassed, and a bypassed gate is worth less than no gate, because it also carries the illusion of coverage. So the judgement is deliberately conservative, and all of it lives in one file, [`src/assertions.js`](src/assertions.js), which you can read in ten minutes before deciding to trust a red build.

- **A failing route is visited twice**, the second time on a brand new page. Only a failure that reproduces is reported. A route that passes on the retry is recorded as flaky rather than silently forgiven.
- **Third-party failures are ignored by default.** A 503 from an analytics beacon is somebody else's outage. Same-origin requests stay strict. Set `http.thirdPartyIsFatal` to change that.
- **An error boundary is detected by selector first.** Add `data-error-boundary` to your fallback component and detection becomes exact. Text matching is the fallback for apps that do not, and it only counts on a page that is sparse in both structure and text, so a documentation page containing the words "something went wrong" is left alone.
- **Console noise is filtered by anchored patterns.** A message that starts with `Failed to load resource` is browser bookkeeping we already catch through status codes. A message that merely contains those words, such as `Uncaught TypeError: Failed to fetch`, is a real crash and still fails.
- **A navigation timeout on a page that rendered is a slow route, not a broken one.** The same timeout on an empty page is reported, because then it is the only evidence of what went wrong.
- **A missing favicon is ignored** out of the box. It 404s on a large share of healthy projects and failing every route over it on the first run is not a good introduction.

If your app has its own noise, narrow it: `console.ignorePatterns` mutes messages, `http.ignoreUrlPatterns` mutes requests, `ignoreRoutes` skips whole subtrees.

---

## Configuration

deep-smoke reads `deep-smoke.config.json` from the working directory, or the file given to `--config`. Every key is optional. Keys starting with an underscore are ignored, so you can use them for comments in a format that has none. An unknown key is an error rather than a silent no-op, because a typo that quietly disables a check is the worst thing this tool could do.

| Key | Default | What it does |
|---|---|---|
| `baseUrl` | none | Where the app is running. Same as `--url`. |
| `routes` | `["/"]` | Seed routes. Discovery expands these at levels 2 and 3. |
| `ignoreRoutes` | `[]` | Never visit these. A trailing `*` matches a subtree. |
| `personas` | none | A path to a personas file, or an inline array. |
| `protectedPrefixes` | `[]` | Route prefixes that require a session. |
| `publicRoutes` | `[]` | Routes that must stay reachable when signed in. |
| `maxRoutes` | `100` | Cap on routes per persona. |
| `budgetMs` | `180000` | Wall-clock budget per persona. |
| `navigationTimeoutMs` | `20000` | How long one navigation may take. Also sets how patient the crawl is with a page that renders late. |
| `routeTimeoutMs` | `45000` | Hard deadline for one route, so a hung page cannot hang the run. |
| `settleMs` | `250` | Pause after the page is ready, to catch errors that fire late. |
| `readySelector` | `null` | A selector that exists only after your first render. Worth setting. |
| `retryFailedRoutes` | `true` | Visit a failing route once more before believing it. |
| `checks` | all on | Individual switches, listed above. |
| `errorBoundary.selectors` | `[data-error-boundary]` and friends | Authoritative markers of an error fallback. |
| `errorBoundary.texts` | a few generic phrases | Fallback text matching, used only on sparse pages. |
| `console.severity` | `error` | `error`, `warning` or `all`. |
| `console.failPatterns` | a built-in list | Messages that mean the page is broken. Set to `[]` to fail on every console error at the chosen severity. |
| `console.ignorePatterns` | browser noise | Messages to mute outright. |
| `http.failFrom` | `400` | Lowest status treated as a failure. |
| `http.thirdPartyIsFatal` | `false` | Whether off-origin failures count. |
| `http.ignoreUrlPatterns` | favicon | Requests to disregard entirely. |
| `evidence.dir` | `.deep-smoke` | Where evidence files are written. |
| `evidence.write` | `true` | Set false, or pass `--no-evidence`, for a dry run. |
| `freshness.behaviourPaths` | source-shaped list | Paths whose contents invalidate old evidence. |
| `freshness.maxAgeMinutes` | `120` | Age limit, used only when a crawl ran outside version control. |
| `browser.channel` | `null` | Use a system browser, for example `chrome`. |
| `browser.executablePath` | `null` | Use a specific browser binary. |
| `browser.headless` | `true` | `--headed` flips it for a run. |
| `browser.viewport` | 1366x900 | Window size. |
| `browser.launchArgs` | `[]` | Extra browser arguments. |

A fully annotated version of this table, as a file you can copy and edit, is in [`examples/deep-smoke.config.json`](examples/deep-smoke.config.json).

---

## Personas and authentication

A route is not one thing. `/settings` is a redirect for a signed-out visitor, a page for a member, and a different page for an administrator. The two most expensive bugs in that list, the member seeing the admin view and the signed-out visitor seeing the member view, are invisible to any crawl that only knows about URLs.

Declare who can reach your app, and deep-smoke crawls it once per persona, each in its own browser context:

```json
{
  "personas": [
    { "id": "anonymous", "auth": { "strategy": "none" } },
    {
      "id": "member",
      "label": "Signed-in member",
      "seeds": ["/app", "/app/settings"],
      "auth": {
        "strategy": "form",
        "loginPath": "/sign-in",
        "usernameSelector": "input[name='email']",
        "passwordSelector": "input[name='password']",
        "submitSelector": "button[type='submit']",
        "username": "env:SMOKE_MEMBER_EMAIL",
        "password": "env:SMOKE_MEMBER_PASSWORD",
        "waitForSelector": "[data-user-menu]"
      }
    }
  ]
}
```

Point at the file from the config with `"personas": "./deep-smoke.personas.json"`, pass `--personas`, or just leave a `deep-smoke.personas.json` next to your config and it is picked up. With no personas at all, deep-smoke crawls as a single anonymous visitor, which is the right default for an app without a login screen.

### The four strategies

No auth provider is named anywhere in this codebase, and none should be. A smoke tool that ships a special case for one vendor starts rotting in step with that vendor's API.

| Strategy | Use it when | Fields |
|---|---|---|
| `none` | Public pages. | Nothing. |
| `form` | There is a username field, a password field and a button. | `loginPath`, `usernameSelector`, `passwordSelector`, `submitSelector`, `username`, `password`, optionally `waitForSelector` or `waitForPath`, `timeoutMs`. |
| `storageState` | You can sign in once by hand and save the session. | `path` to a Playwright storage state file. |
| `module` | Anything else: single sign-on, one-time codes, token exchanges, tenant headers. | `path` to your own ESM module, optionally `export` and `options`. |

Create a storage state file with `npx playwright codegen --save-storage=.auth/admin.json https://your-app`, and add `.auth/` to `.gitignore`.

For `module`, export an async function. It receives the persona's browser context and a page, and anything it leaves behind applies to every page of the crawl. A complete example is in [`examples/auth-module.mjs`](examples/auth-module.mjs).

### Secrets

Any string field can be written as `env:VARIABLE_NAME` and is read from the environment at run time. Only the variable name is ever printed, so a failing run cannot leak a password into a build log. A missing variable exits 3, the environment code, rather than 1: an unset secret means the pipeline is misconfigured, not that a page is broken.

### The check that keeps this honest

An authenticated persona whose session never took effect would produce the most confident lie a smoke tool can tell: it would visit the login page many times, find it perfectly healthy, and report full coverage of an application it never entered.

So if a persona is declared as authenticated, `protectedPrefixes` is set, and every protected route it tried redirected away, the run fails with a persona error naming that persona. A red build here nearly always means the sign-in configuration is wrong, not the app.

A sign-in that throws outright, because a selector does not match, a module failed or a secret is unset, exits 3 rather than 1. Nothing was proved about the app in that case, and saying "this app is broken" when the truth is "I could not get in" would be the same over-claiming from the other direction. A genuinely broken sign-in page is still caught, by the anonymous persona crawling it like any other route.

---

## Evidence files

Every run writes a JSON file to `.deep-smoke/L<level>-<commit>.json`. It is also what `--json` prints, so there is one shape to learn rather than two.

```jsonc
{
  "tool": "deep-smoke",
  "toolVersion": "0.1.0",
  "schemaVersion": 1,
  "level": 3,
  "scoped": false,
  "createdAt": "2026-08-06T09:21:44.512Z",
  "durationMs": 48210,
  "vcs": { "kind": "git", "commit": "9f1c...", "branch": "main", "dirty": false },
  "target": { "baseUrl": "http://localhost:4173" },
  "declared": { "routes": [...], "protectedPrefixes": [...], "checks": {...} },
  "personas": [
    { "id": "member", "authenticated": true, "authStrategy": "form",
      "authDetail": "form login at /sign-in", "routesVisited": 34,
      "routesFailed": 0, "truncated": false, "error": null }
  ],
  "results": [
    { "persona": "member", "route": "/app/orders/:id", "requestedPath": "/app/orders/1042",
      "finalPath": "/app/orders/1042", "ok": true, "flaky": false,
      "durationMs": 812, "failures": [] }
  ],
  "invariants": [
    { "persona": "anonymous", "route": "/app", "kind": "protected-route-must-bounce-anonymous",
      "ok": true, "message": "anonymous visitor was redirected away from /app to /sign-in" }
  ],
  "coverage": { "truncated": false, "truncationReasons": [], "authInvariantsChecked": true },
  "summary": { "routesVisited": 61, "routesFailed": 0, "invariantsViolated": 0, "personaErrors": [] },
  "result": "pass"
}
```

Two things about this shape are load-bearing.

The `declared` section records what the run was allowed to look at, because half of reading old evidence is working out its scope. A green level 3 that ignored half the app is a different claim from one that did not.

Routes are recorded twice: `route` is the deduplicated identity (`/orders/:id`), `requestedPath` is what was actually navigated (`/orders/1042`). Identifiers are collapsed so one detail page is not crawled a thousand times, but a real path is always used for navigation. Navigating the literal string `/orders/:id` would test the not-found page and report it as coverage of the detail page.

Add `.deep-smoke/` to `.gitignore` unless you deliberately want evidence in review, which some teams do.

---

## verify, and why freshness is the point

```bash
deep-smoke verify --level=3
```

Exit 0 if there is passing level 3 evidence for the code in front of it. Exit 1, with reasons, if not. No browser needed, so this is what belongs in a pre-push hook or a merge gate.

A crawl proves something about a specific version of an app at a specific moment. Without a way to tie that proof to the commit being shipped, a green result decays quietly into a green sticker. The rule is small enough to state in one sentence:

> Evidence is valid for the commit it was produced from, or for a later commit that changed nothing which could affect behaviour.

Editing a README does not invalidate a crawl. Touching anything under `freshness.behaviourPaths`, which defaults to `src`, `app`, `pages`, `components`, `lib`, `public`, `index.html` and the lockfile, does.

Everything uncertain resolves to "stale":

- The evidence commit is not in this repository, or is not an ancestor of the current one.
- The clone is shallow, so the range cannot be examined. Use `fetch-depth: 0` in CI.
- Git itself errored. An error must never read as "nothing changed".

Level 3 asks for more, because it is the gate:

- The run must not have been truncated by `maxRoutes` or `budgetMs`. A truncated crawl is not a crawl of the whole tree.
- The run must not have been scoped with `--only`.
- Every persona declared in your current config must appear in the evidence. Adding a persona invalidates old evidence, which is the correct answer: nobody has crawled as that persona yet.

### The anti-cheat, stated honestly

Nothing here proves a browser ever ran. What it does is make the dishonest path expensive and the accidental path impossible.

- Evidence must embed a commit that exists in this repository's history. A file written by hand has no such commit, and inventing one means picking a real ancestor, which the behaviour-path check then compares against.
- **Totals are never trusted.** `verify` recomputes them from the per-route results using the same function that produced them. Editing `routesFailed` to 0 while a result still says `"ok": false` produces a file that contradicts itself, and that contradiction is reported as its own reason.
- Deleting the failing entries instead does not help either: the remaining route count, the persona coverage and the truncation flags all have to hold up on their own.
- Evidence produced outside version control is refused inside a repository unless you pass `--allow-unversioned`, which downgrades the check to an age limit and says so in the output.

That is the honest boundary. It stops the five-second edit and the accidental stale pass, which is how this actually goes wrong in practice. It does not stop a determined person with an afternoon, and no file format could.

---

## Continuous integration

```yaml
name: smoke

on: [pull_request]

jobs:
  deep-smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # the freshness rule compares commits

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run build

      - name: Start the production build
        run: |
          npm run preview -- --port 4173 &
          npx wait-on http://localhost:4173 --timeout 60000

      - name: Crawl every route, as every persona
        run: npx deep-smoke --level=3 --url=http://localhost:4173
        env:
          SMOKE_MEMBER_EMAIL: ${{ secrets.SMOKE_MEMBER_EMAIL }}
          SMOKE_MEMBER_PASSWORD: ${{ secrets.SMOKE_MEMBER_PASSWORD }}

      - name: Keep the evidence, whatever the outcome
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: deep-smoke-evidence
          path: .deep-smoke/
```

Crawl a production build, not a dev server. Dev servers hide broken imports, serve unminified code that fails differently, and inject a client that reports errors your users will never see.

As a pre-push hook, where the browser may not be available:

```bash
#!/bin/sh
# .git/hooks/pre-push
npx deep-smoke verify --level=3 || {
  echo "Run: npx deep-smoke --level=3 --url=http://localhost:4173"
  exit 1
}
```

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The crawl passed, or the evidence was accepted. |
| `1` | Something failed: a route, an authentication rule, or the evidence check. |
| `2` | The command or the configuration was wrong. |
| `3` | The machine could not run the crawl: no Playwright, no browser, no session. |

Three codes rather than one, so a pipeline can tell "the app is broken" from "the flag was wrong" from "this runner cannot start a browser". An ambiguous red build gets retried instead of read.

---

## Programmatic use

```js
import { loadConfig, loadPersonas, runSmoke, buildEvidence, verifyEvidence } from 'deep-smoke';

const { config } = loadConfig({ overrides: { baseUrl: 'http://localhost:4173' } });
const { personas } = loadPersonas({ source: config.personas });

const evidence = buildEvidence(await runSmoke({ config, personas, level: 3 }));
if (evidence.result !== 'pass') {
  console.error(evidence.results.filter((route) => !route.ok));
  process.exitCode = 1;
}
```

The pure parts are exported too, so the judgement can be reused or tested on its own: `evaluateRoute`, `classifyConsoleMessage`, `checkAuthInvariant`, `buildPlan`, `checkFreshness`.

---

## Honest limits

A synthetic crawl proves that a page renders. It does not prove that the page is right.

- **It does not check data correctness.** A dashboard showing every number as zero renders perfectly. If the numbers matter, assert them in a real end-to-end test.
- **It does not check that your backend is healthy.** It sees what the browser sees. A cached page over a dead API passes. A queue that stopped draining is invisible.
- **It is not a visual test.** A stylesheet that failed to apply but returned 200 renders as unstyled text, and that passes.
- **It is not an accessibility, performance or security audit.** Use tools built for those.
- **Discovery only follows links.** A route reachable only through a button, a form submission or a redirect is not found unless you list it in `routes` or in a persona's `seeds`. Redirect destinations are followed, which is how a sign-in page usually gets covered.
- **It is not a substitute for tests.** It is the layer underneath: the check that nothing is catastrophically broken anywhere, which unit and integration tests do not attempt and end-to-end suites are too slow to do everywhere.
- **Level 3 is only as complete as your declared surface.** It crawls what it can reach. A page nobody links to and nobody declared is not covered, and no crawler can know it exists.

What it does catch, reliably, is the class of failure that reaches production most often and embarrasses most quickly: a route that throws, a route that renders nothing, a route that shows an error fallback, a bundle that 404s, and a page that the wrong person can read.

---

## Troubleshooting

**`Playwright is required to run a crawl, and it is not installed.`**
`npm install --save-dev playwright` and then `npx playwright install chromium`. The second command is the one people forget, and skipping it produces a different, more confusing error later.

**`No browser could be launched.`**
Run `npx playwright install chromium`, or point at a browser you already have with `--channel=chrome` or `browser.executablePath`. deep-smoke tries the bundled browser first, then falls back to a system Chromium-family channel on its own.

**Everything fails with a blank screen.**
Your app probably renders after deep-smoke looks. Set `readySelector` to something that exists only after the first render, and raise `navigationTimeoutMs`. A `readySelector` is faster and more reliable than a longer delay.

**A healthy page fails on a console error.**
Find the message in the evidence file under `failures[].detail` and add an anchored pattern to `console.ignorePatterns`. If your app has no console noise at all, the opposite is also reasonable: set `console.failPatterns` to `[]` and fail on every console error.

**The crawl finds only two routes.**
Discovery follows links from the seeds. Add the rest to `routes`, and put persona-specific entry points in that persona's `seeds`.

**The crawl is slow.**
Lower `maxRoutes` for local runs and keep the full tree for CI, narrow with `--only` while developing, and set `readySelector`. A large part of a slow crawl is usually the tool waiting for pages that render late.

**verify says the evidence is stale, but nothing changed.**
Something under `freshness.behaviourPaths` changed between the two commits. The reason names the files. If a path in that list does not affect runtime behaviour in your project, remove it.

**verify fails in CI with "shallow clone".**
Set `fetch-depth: 0` on the checkout step. The freshness rule compares commits, and a shallow clone cannot be reasoned about, so it fails closed.

**A signed-in persona reports "never reached the protected area".**
The session did not take effect, so the crawl was testing the signed-out experience. For `form`, set `waitForSelector` to something that only exists once signed in. For `storageState`, regenerate the file, since sessions expire. For `module`, run with `--verbose` to see how far it got.

---

## Contributing

```bash
npm install
npm test
```

The suite is `node --test`, with no test framework and no network. Tests that need a browser skip with a printed reason when Playwright is not installed, so a contributor touching the pure logic still gets a green run. They crawl a small fixture site in `test/fixtures/static-site/`, served over localhost by node's own http module.

The one architectural rule worth keeping: judgement lives in `src/assertions.js` as pure functions over a plain description of what the browser did, and nothing there touches a browser. That is what makes the interesting half testable in milliseconds, and auditable by someone deciding whether to trust a red build.

---

## License

MIT, Copyright (c) 2026 Danilo Lapegna. See [LICENSE](LICENSE).
