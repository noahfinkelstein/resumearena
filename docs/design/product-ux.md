# ResumeArena — Product and UI design

Status: v2 design, 2026-10-03 (re-platformed: GitHub-only backend, no accounts). Owner: Noah Finkelstein.
Scope: positioning, copy, information architecture, page specs, design system, React component inventory, identity without accounts, mobile, copy deck.
Out of scope (other docs): rating math (`ranking-system.md`), the analysis schema and prompts (`scoring-rubric.md`), workflows, the `data` branch layout and the write-channel threat model (platform doc, being rewritten). Where this doc needs a value from those it says so and names the field it expects (§8).

The stack is fixed: Vite + React 19 + TypeScript SPA on GitHub Pages at `/resumearena/`; GitHub Actions as the only compute; an orphan `data` branch of JSON files as the only database; static JSON indexes under `/resumearena/data/` as the only read path; `workflow_dispatch` called from the browser (with a GitHub Issue Form as the fallback) as the only write path; Claude through the Anthropic API for analysis and judging. No accounts, no servers, no third party besides GitHub and Anthropic. Everything below is designed inside that.

Five consequences of the platform that shape every page, stated once:

1. **Reads are files.** The site shows what the last deploy wrote. Freshness is minutes, not seconds; the UI says "updated 4 min ago", never "live".
2. **Writes are fire-and-forget.** A dispatch returns `204` and nothing else, so the browser chooses the ids and knows where to look afterwards.
3. **Two stages.** The analysis lands first (3–6 minutes). The rating lands after the next rerank and the deploy that follows it (usually 5–15 minutes more).
4. **The text is public the moment it is submitted.** Not the file: the redacted text, shown to the user before they submit it. The UI says so before, not after.
5. **Identity is a handle plus a key the browser made.** Lose the key and you lose control of the entry, not the entry itself. There is nobody to email for a reset.

---

## 0. The idea in one paragraph

You submit a resume. It gets read, scored against a rubric, and then it plays: it is compared head to head against other resumes by an LLM judge, and a chess-style rating settles on where it stands. The site shows you that number, what it is made of, where it puts you on four ladders (general, finance, tech, academia), and what would move it. Anyone can watch; entering takes a resume and a handle, not an account. The pitch is not "AI resume review"; it is **a ladder with receipts**. Every number on the page can be traced to a match or a rubric line, and every piece of text the judge read is on the page too.

Design principles, in priority order:

1. **The number is the product.** The rating, its uncertainty, and the rank are set large, in monospace, and are never decorated. Everything else supports them.
2. **Receipts, not vibes.** Every score has a breakdown; every match has a reason; every tier has a threshold. No unexplained badges.
3. **Scoresheet, not dashboard.** Dense tables, hairline rules, square corners, two typefaces. No cards-on-cards, no radar charts, no gradients, no glass.
4. **Quiet motion.** One orchestrated moment (the rating revealing after placement). Everything else is 150–250 ms state changes or nothing.
5. **Say less.** Sentence case, plain verbs, no exclamation marks, no emoji, no "unleash".
6. **Honest about time and exposure.** Nothing here is instant and no copy pretends it is. Every waiting state says what is happening and roughly how long. Every public thing is called public before it becomes public.

---

## 1. Positioning and voice

### 1.1 Tagline and self-description

Tagline (site `<title>` suffix and hero): **Where resumes are rated, not reviewed.**

Two-line explanation (hero subhead, also the `<meta description>`):

> Upload a resume. It is scored, then matched head to head against others until a rating settles.
> Four ladders: general, finance, tech, academia. No accounts; anyone can watch, and entering takes a handle, not an email.

Short form (OG card, footer): *A rated ladder for resumes.*

### 1.2 Naming

| Thing | Name in UI | Notes |
| --- | --- | --- |
| The score | **Arena rating** | "rating" alone after first mention on a page. Never "score", "Elo", "ELO". |
| Uncertainty | **±** (spoken: "plus or minus") | Rendered next to the rating: `1642 ±38`. Tooltip: "How settled the rating is. It narrows as matches are played." |
| A comparison | **match** | Not "battle", "duel", "fight". |
| LLM comparison | **judge** | "the judge preferred", "judge's note". |
| Arena interaction | **guess** | Visitors guess which resume the judge preferred. Guesses are local and change nothing. "Votes" that move ratings are v2 and the word does not appear in v1. |
| First matches after submission | **placement** | "Placement matches", "placing". |
| One of the four lists | **ladder** | Route is `/leaderboard/:category` for discoverability; copy says "ladder". |
| The four categories | general, finance, tech, academia | Always lowercase in running text, capitalised only at sentence start or as a heading. |
| A submitted resume | **entry** | "your entry", "manage your entry". Not "submission" in UI copy (that is the engineering word), not "profile". |
| The chosen name | **handle** | 3–20 chars `[a-z0-9-]`. One entry per handle at a time. |
| The secret | **owner key** | "key" alone after first mention. Never "password", "token", "secret". |
| Unlisted identity | **anonymous** | Shown as `anon-k7q2m`. |
| Removing contact details | **redaction** / **removed** | "We removed what looked like contact details." Not "scrubbed", "sanitised". |
| Tier | **tier** | Not "rank" (rank is the ordinal position). |

### 1.3 Tiers

Eight tiers by rating, plus a provisional state. Thresholds are the UI's defaults and are read from `data/config.json#tiers` at runtime (emitted at deploy from `packages/shared/src/tiers.ts`) so the rating doc can move them.

| Tier | Rating | Marker |
| --- | --- | --- |
| Provisional | fewer than N placement matches complete | hollow square, grey |
| Entrant | < 1200 | I |
| Contender | 1200–1399 | II |
| Challenger | 1400–1599 | III |
| Candidate | 1600–1799 | IV |
| Expert | 1800–1999 | V |
| Master | 2000–2199 | VI |
| Grandmaster | 2200–2399 | VII |
| Laureate | 2400+ | VIII |

Tier is a word set in the serif, with a small roman numeral in mono after it (`Candidate IV`). No icons, no shields, no colour per tier. The only colour-coded things on the site are win/loss/draw and the rating delta.

Tier microcopy (shown on hover/tap of a tier word and on `/about`):

- Provisional: "Not yet placed. The rating is a guess until placement finishes."
- Entrant: "Below 1200. Most placements start here."
- Contender: "1200–1399. Clears the median on at least one ladder."
- Challenger: "1400–1599. Consistently preferred by the judge."
- Candidate: "1600–1799. Top quarter on its ladder."
- Expert: "1800–1999. Top tenth."
- Master: "2000–2199. Top 2 percent."
- Grandmaster: "2200–2399. Top half-percent."
- Laureate: "2400 and above. Rarely more than a few dozen at a time."

(The percent claims are targets for the rating doc's calibration; the UI copies them from `config.tiers[i].blurb`, so they can be corrected without a code change.)

### 1.4 Voice

Dry, precise, confident, a little wry. The model is a tournament arbiter who has seen a lot of resumes.

Rules:

- Sentence case everywhere, including buttons and table headers.
- No exclamation marks. No emoji. No "unleash", "supercharge", "elevate", "level up", "crush", "cracked" (the user's word; we do not use it in UI copy — the rating says it for us).
- Buttons say what happens: "Upload a resume", "Use this text", "Submit for rating", "Delete this entry".
- Errors say what went wrong and what to do, in that order, in two sentences at most.
- Waiting copy states a range and what is happening ("Usually 3 to 6 minutes. Reading and scoring."). It never says "almost there", "hang tight", or shows a percentage it does not know.
- Numbers do the bragging. Copy never says "impressive".
- Second person is fine ("your rating"); first person plural is rare ("we") and only on `/about` and in the redaction panel ("We removed…"), where a human voice is reassuring.
- Wry is a light touch, roughly one line per page, never in errors, never in a waiting state.

### 1.5 Microcopy by state

Status copy for the submit-to-result pipeline. Stage names are honest: they describe what is actually happening. There are two clocks: the browser's (synchronous steps the user watches) and the platform's (workflow runs and deploys the page polls for).

**Browser steps** (upload page, §3.2; all local, no network):

| Key | Label (shown) | Secondary line |
| --- | --- | --- |
| `reading` | Reading `resume.pdf`. | "Extracting text and layout. Nothing is uploaded." |
| `redacting` | Removing contact details. | (brief; usually invisible) |
| `sending` | Sending. | "Handing the text to the workflow." |

**Platform states** (pending page, §3.3; from the GitHub runs API and the result JSON, see `PollingStatus` §4.10):

| Key | Label (shown) | Secondary line |
| --- | --- | --- |
| `dispatched` | Received. | "GitHub accepted the submission at 14:21. A workflow starts within a minute." |
| `queued` | Queued. | "Waiting for a runner. 3 ahead of you." (the count is omitted when unknown) |
| `running` | Reading and scoring. | "The gate check takes seconds; the analysis one to two minutes. Started 0:42 ago." |
| `publishing` | Scored. Publishing. | "The result is written; the site rebuilds in one to two minutes." |
| `analysed` | Analysed. Not yet rated. | "Placement runs in the next rerank, every ten minutes, then the site rebuilds. Usually 5 to 15 minutes. This page keeps checking." |
| `placing` | Placing, 3 of 8. | "Head to head against resumes near the starting estimate." |
| `budget_wait` | Queued for tomorrow. | "Today's judging budget is spent. Placement resumes at 00:00 UTC; the analysis above stands." |
| `rated` | Placed. | (the rating reveals; see §4.5) |
| `not_seen` | Not seen yet. | "GitHub accepted the submission but no run has appeared. This happens; we keep checking for ten minutes." |
| `fallback_pending` | Submitted through the fallback. | "Issue submissions are picked up by the same workflow and usually take a few minutes longer. This page keeps checking." |
| `stale` | Still waiting on placement. | "Longer than usual. The status block on the about page shows the queue. This page checks every minute; it is safe to close and come back, the link is yours." |

Beneath every platform state, one fixed line: **We will keep checking. You can close this page; the link is yours.** with the share button next to it.

Stage 1 landing (analysis appears while the page is open): the status list collapses to one row "Analysed. Not yet rated." and the analysis sections render beneath; no animation beyond the 150 ms opacity of new sections.

Stage 2 landing: heading on the result page the first time the rating is seen in this browser: **Placed.** then the rating reveals (§4.5). Toast: "Your resume is rated. The link is yours to share or keep."

**Errors** (title, then body). File and text errors are on the upload page; submission errors on step iv; pipeline errors on the pending page.

File:

- Type: **That is not a PDF or DOCX.** "Export it as a PDF, or paste the text."
- Too large: **The file is over 10 MB.** "Resume files are usually under 500 KB. Re-export without embedded images, or paste the text."
- No text layer: **No readable text in this file.** "It is probably a scan. Export from the original document, or paste the text; scanned resumes also fail most applicant-tracking systems."
- Unreadable: **Could not read the file.** "It may be encrypted or damaged. Re-export it, or paste the text."
- Poor extraction (warning, not blocking): **The extraction looks poor.** "Columns or tables came out in the wrong order. Fix the order here, or paste the text from the original document."

Text:

- Over the limit (inline under the counter, button disabled): "Over the limit by 812 characters. Trim it here."
- Under the minimum: "Fewer than 400 characters. Paste or upload more."

Handle (inline under the field):

- Invalid: "Handles are lowercase letters, numbers, and hyphens, 3 to 20 characters, no hyphen at the ends."
- Taken: "That handle is taken."
- Reserved: "That handle is reserved."
- Yours: "You hold the key for this handle. Submitting replaces your current entry; its rating carries over as the starting estimate."

Submitting (step iv):

- Token missing or revoked (`401`/`403`/`404` from the dispatch, or the preflight): **The direct channel is down.** "The token that lets this page start the workflow is missing or revoked. The fallback is a GitHub issue form carrying the same fields; it needs a GitHub account, which the direct channel does not. The text is copied to your clipboard; paste it into the field called Resume text." Buttons: **Copy text and open the form** (primary), **Try the direct channel again** (quiet).
- Rate limited (`429`): **GitHub is rate limiting submissions.** "Wait a minute and try again. Nothing was sent."
- Refused (`422`, `5xx`): **GitHub refused the request.** "Try again in a minute. If it keeps failing, use the fallback below." (the fallback panel opens beneath)
- Network: **Lost the connection.** "Nothing was sent. Try again when you are back online."

Pipeline (pending page; `status: 'rejected'` with `reason`, or a failed run):

- `not_a_resume`: **This does not look like a resume.** "The gate found no roles, education, or dates. If it is one, the extraction may have scrambled it: go back, check the preview reads top to bottom, and submit again." Button: **Back to the text** (returns to step ii with the text restored from this browser).
- `spam`: **This was rejected as spam.** "The text is mostly links, repeated phrases, or promotional copy. Submit a resume."
- `injection`: **This contains instructions to the judge.** "Text addressed to the evaluator is ignored and flagged. Remove it and submit again."
- `too_short`: **Not enough text.** "Fewer than 400 characters reached the workflow. Paste more, or check the extraction."
- `handle_taken`: **The handle was taken first.** "Someone registered priya-n between your check and the workflow. Pick another and submit again; the text is still in this browser."
- `duplicate`: **This text is already on the ladder.** "An identical text was submitted under another handle. If it is yours, manage that entry with its key; if it is not, send the id to the address on the about page."
- `bad_payload`: **The submission was malformed.** "Something between the browser and the workflow changed the payload. Reload and try again."
- Run failed (no result file, run `conclusion: failure`): **The analysis did not finish.** "The workflow failed before writing a result. Nothing is published. Try again; if it fails twice, send the id to the address on the about page." with the id in mono and a quiet **Workflow log** link to the run.
- Lost (no run seen after 10 minutes): **The submission did not start.** "GitHub accepted it but never ran it. Submit again; the text is still in this browser." Button: **Submit again** (same payload, new id).
- Budget exhausted at analysis time (`status: 'queued'`): **Queued.** "Today's analysis budget is spent. Your text is stored and will be analysed after 00:00 UTC, in order. You are number 41." (count from `status.json`)

Manage (`/me`):

- Wrong key: **That key does not match.** "Keys are 52 characters after `rak-`, in groups of four. Check for a missing group; keys are case-insensitive."
- No entry for the key's handle: **No entry under that handle.** "It may have been deleted, or the handle was never registered."
- Action refused (`401` from the workflow, written to the result as `last_action`): **The workflow rejected the key.** "The fingerprint did not match the one on file. If you resubmitted from another device, that device's key is the current one."

General:

- 404: **Nothing here.** "The link may be deleted or mistyped." with links to the general ladder and the arena.
- Deleted entry (`status: 'deleted'`): **This entry was deleted by its owner.** "Its matches remain in opponents' histories as an anonymous placeholder."
- Data unreachable (static JSON fetch fails): **Could not load.** "GitHub Pages did not answer. Retrying." (quiet retry link; the chrome stays)

Empty states:

- Ladder with a stage filter that matches nothing: **No resumes match.** "Loosen the career stage."
- Ladder search with no hit: **No one by that handle.**
- Profile with no entry: **No entry under this handle.**
- Recent matches, before placement: **No matches yet.** "Placement starts at the next rerank."
- Arena when fewer than 20 judged matches exist in a category: **Not enough matches to guess from yet.**
- Landing, new deployment: **No resumes yet.** "The first entry sits at the top for a while."
- `/me` with no key anywhere: **No key on this device.** "Paste the key you saved when you submitted, or submit a resume."

Wry lines (one per page, optional, in `--fg-muted`):

- Landing, under the ladder table: "Updated as deploys finish. Refreshing will not help your rating."
- Upload step ii, under the public notice: "Recruiters read this part too. Now you know how it feels."
- Arena, after a 10-guess streak agreeing with the judge: "Ten in a row. You may be the judge."
- Arena, after disagreeing 5 in a row: "Five disagreements. One of you is wrong, and the judge is not sure it is you."
- `/me`, delete section: "This is the only button on the site with a second step."
- `/about`, status block: "All of this is a git branch."

---

## 2. Information architecture and routes

### 2.1 Routes

All paths are real paths under `/resumearena/` (no hash routing). React Router with `basename="/resumearena"`. There is no auth; the "Key" column says whether the page does anything differently when the browser holds an owner key (§6).

| Path | Page | Key | Notes |
| --- | --- | --- | --- |
| `/` | Landing | optional | Top-10 of the general ladder from static JSON, one primary action, how it works. With a key: a "your entry" line. |
| `/upload` | Upload | makes one | Four steps on one page: file, preview, details, submit. `?handle=` prefills for resubmission. |
| `/r/:id` | Result | optional | Pending, analysed, or rated. `id` is 10 chars `[a-z2-7]`, chosen by the browser at submit time. With the matching key: a "Manage this entry" link. |
| `/leaderboard/:category` | Ladder | optional | `category ∈ general|finance|tech|academia`. `/leaderboard` redirects to `/leaderboard/general`. Query: `?stage=&q=&page=&focus=` |
| `/arena` | Arena | no | Guess the judge. `?category=` optional; default rotates. No writes. |
| `/u/:handle` | Profile | optional | The entry under a handle, if its owner shows the handle. Anonymous entries have no profile page. |
| `/me` | Manage your entry | required | Paste or use the local key: visibility, resubmit, delete, forget key. |
| `/about` | About | no | How the rating works, what the judge sees, how writes work, privacy, limits, status block, contact. |
| `*` | Not found | no | |

Secondary entry points, not nav items: `/r/:id/matches` (full match list, paginated client-side from `data/r/:id/matches.json`), `/u/:handle/history` (rating history table). These are the same page components with a "show all" mode; listed so deep links are stable.

### 2.2 Navigation

Top bar, one line, 56 px tall, hairline bottom border, sticky:

```
ResumeArena      Ladders ▾   Arena   About                 [Upload a resume]  theme  Your entry
```

- Wordmark is text in the display serif, no logo.
- "Ladders" is a disclosure with the four categories; on hover/focus it opens, on click it goes to general.
- "Upload a resume" is the only primary button in the chrome.
- Theme toggle is a 1-character-wide quiet button in mono reading `night` / `paper`.
- "Your entry" is a quiet text link to `/me`, rendered only when `localStorage` holds at least one owner key (§6.4). There is no "Sign in" and no avatar; when there is no key, the slot is empty.

Footer: one line. `ResumeArena · about · privacy · status · github` with the current build short-sha in mono on the right, linking to the commit. (The middle dot is used once, here, as a deliberate separator in the one place a footer is expected to have one.) `status` links to `/about#status`.

### 2.3 GitHub Pages SPA fallback

GitHub Pages serves `404.html` for unknown paths. Use the standard two-file redirect:

`public/404.html` (shipped as-is):

```html
<!doctype html><meta charset="utf-8"><title>ResumeArena</title>
<script>
  // Keep the path, stash it in the query, bounce to the app root.
  // /resumearena/r/abc?x=1#h  ->  /resumearena/?/r/abc&x=1#h
  var l = window.location, seg = 1; // 1 = one path segment is the repo name
  l.replace(
    l.protocol + '//' + l.hostname + (l.port ? ':' + l.port : '') +
    l.pathname.split('/').slice(0, 1 + seg).join('/') + '/?/' +
    l.pathname.slice(1).split('/').slice(seg).join('/').replace(/&/g, '~and~') +
    (l.search ? '&' + l.search.slice(1).replace(/&/g, '~and~') : '') + l.hash
  );
</script>
```

`index.html` head, before the app script:

```html
<script>
  (function (l) {
    if (l.search[1] === '/') {
      var decoded = l.search.slice(1).split('&').map(function (s) { return s.replace(/~and~/g, '&'); });
      window.history.replaceState(null, null, l.pathname.slice(0, -1) + decoded.join('?') + l.hash);
    }
  })(window.location);
</script>
```

Consequences the UI accepts: a deep link flashes the 404 document for one navigation (it is blank and titled correctly, so it is invisible in practice); crawlers see a 404 status for deep links, which is acceptable because the ladders are discoverable from `/`. `vite.config.ts` sets `base: '/resumearena/'`. Asset links are absolute under that base. Static data lives under the same base (`/resumearena/data/...`), copied into the Pages artifact by the deploy workflow, so it is served by the same origin with no CORS.

### 2.4 Theme bootstrap

Same approach as the owner's portfolio, written independently: an inline script in `<head>` reads `localStorage['resumearena.theme']` (`paper` | `night`), falls back to `prefers-color-scheme`, and sets `html[data-theme]` before first paint. `color-scheme` is set per theme so native form controls and scrollbars match.

### 2.5 Reading data (`src/lib/data.ts`)

Every page reads static JSON through one helper; pages never call `fetch` directly.

```ts
export async function getJson<T>(path: DataPath, opts: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<T | null>;
// path is relative to `${import.meta.env.BASE_URL}data/`, e.g. 'ladders/general/top.json'.
// fresh: true appends `?v=<floor(Date.now()/30000)>` and sets cache: 'no-store'.
// Returns null on 404 (a pending result, a free handle); throws DataError on anything else.
```

Why `fresh` exists: GitHub Pages serves with `Cache-Control: max-age=600` behind a CDN that keys on the full URL. A poller that re-fetched the same URL could see a ten-minute-old 404 long after the deploy landed. The 30-second bucket in the query string gives the poller a new cache key every half minute without defeating the cache for everyone else. Pages that merely revalidate (landing, ladder) use `fresh: false` and accept up to ten minutes of staleness; their "updated N min ago" label comes from the file's `generated_at`, so the label is honest either way.

Fetch budget per page, so nothing fans out: landing 2 files, ladder 2 (index + one page) plus 1 per search, result 1 (plus `matches.json` on the full list), arena 2 (index + one shard), about 2, `/me` 1 per handle.

---

## 3. Page specifications

Common frame for every page: `max-width: 72rem`, side gutter `clamp(1rem, 4vw, 2.5rem)`, left-aligned text, no centered hero text anywhere. Data tables may break out to `max-width: 84rem` on the ladder page.

Loading rule for every page: no spinners. Pages render their chrome immediately and fill data in place. Where a number is pending, render a `—` in mono at the same width so nothing shifts. Skeleton blocks are a `--bg-3` rectangle with no shimmer.

Freshness rule for every page that shows derived data: a mono label `updated 4 min ago` (from `generated_at`, relative, refreshed every 30 s client-side without refetching) in the section header. Never the word "live".

### 3.1 Landing `/`

Purpose: show the ladder (the characteristic thing) and get a visitor to upload. One primary action on the whole page.

Layout, desktop (two columns, 5/7):

```
┌──────────────────────────────────────────────────────────────────────┐
│ ResumeArena   Ladders  Arena  About            [Upload a resume]  ·  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Where resumes are rated,        General ladder   updated 4 min ago  │
│  not reviewed.                   ───────────────────────────────────  │
│                                  #   handle        tier       rating │
│  Upload a resume. It is scored,  1   m-castellan   Laureate   2431   │
│  then matched head to head ...   2   anon-k7q2m    Grandm.    2388   │
│                                  3   priya-n       Grandm.    2371   │
│  [Upload a resume]  Browse the   …                                   │
│                     ladders      10  anon-x91pp    Master     2104   │
│                                  ───────────────────────────────────  │
│  12,418 resumes · 301,992 matches  Updated as deploys finish. ...    │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  How it works                                                        │
│  1  Read here. The text is extracted and contact details removed in  │
│     your browser. You see exactly what will be public before it is.  │
│  2  Scored. Five sub-scores from the text alone: pedigree, trajectory│
│     impact, selectivity, breadth. Plus a parse-readiness check.      │
│  3  Matched. Eight placement matches against resumes near the        │
│     starting estimate, both orderings, judged with a reason.         │
│  4  Rated. A chess-style rating with an uncertainty that narrows.    │
│                                                                      │
│  Then it keeps playing: every entry is re-matched as new ones        │
│  arrive, so ranks move. No account; a handle and a key. →about       │
├──────────────────────────────────────────────────────────────────────┤
│  Arena   Two resumes, anonymised. Guess which the judge preferred.   │
│          Then read why.                                  Try it →    │
└──────────────────────────────────────────────────────────────────────┘
```

Components: `Hero` (h1 in display serif at `--text-2xl`, subhead at `--text-md`), `LeaderboardTable` in `compact` mode (top 10, no filters, columns: rank, identity, tier, rating), `StatLine` (counts in mono), `HowItWorks` (an ordered list; numbers are justified because it is a sequence), `ArenaTeaser` (its action is a quiet link, not a button; the page has one button).

Data: `ladders/general/top.json` (10 rows, written at deploy) and `status.json` (counts). The page revalidates both every 5 minutes while visible via a simple interval, paused when `document.hidden`; the "updated" label ticks every 30 s from the file's `generated_at`.

Interactions: rows link to `/r/:id`. The whole table links to `/leaderboard/general`.

States: loading shows ten rows of `—`; empty (new deployment) per §1.5; error shows the table header and "Could not load. GitHub Pages did not answer. Retrying." with a quiet retry link.

Has-key variant (§6.4): if `localStorage` holds an entry, a line under the CTA reads `Your entry: 1642 ±38 · Candidate IV · #1,204 general` linking to that result, or `Your entry: analysed, awaiting placement` / `Your entry: pending` while it is not rated. The CTA label stays "Upload a resume"; resubmission is reached from `/me`.

### 3.2 Upload `/upload`

Purpose: get the text out of the file in the browser, show the person exactly what will be public, take a handle and a ladder hint, hand it to the workflow, land on the pending page. Four steps on one route, state kept in memory (and the text in `sessionStorage['resumearena.draft']` so a reload or a "Back to the text" from a rejection does not lose it). The URL does not change between steps; the back button leaves the page (a `beforeunload` guard asks only when a file has been read and nothing submitted).

Layout: one column, `max-width: 40rem` for steps i, iii, iv; step ii widens to `max-width: 64rem` for the two-pane preview. A `StepRail` at the top: `1 File   2 Preview   3 Details   4 Submit`, serif, the current step in `--fg` with a 2 px underline, completed steps clickable, future steps not.

Heading on every step: "Upload a resume". Lead line under it on step i only: "A PDF, a Word file, or pasted text. Everything up to the submit button happens in this browser."

**Step i: File.**

1. `FileDropzone`: 100% width, 10rem tall, 1 px dashed `--border`, square corners. Idle text **Drop a PDF or DOCX here, or choose a file.** Below in mono: `PDF or DOCX · up to 10 MB · 1–3 pages works best`. Dragging over: border becomes solid `--accent`, text **Release to read it.** Click opens the picker (`accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"`). The whole zone is a `<button>`.
2. Under it, a quiet button **Paste text instead**. It replaces the dropzone with `PasteBox`: a textarea (12 rows, serif 15 px), placeholder **Paste the resume text here.**, helper "Pasted text has no layout, so layout metrics will be blank.", a primary **Use this text** button and a quiet **Choose a file instead**.
3. On file: the dropzone turns into the `reading` state: **Reading resume.pdf.** with a 2 px bar (indeterminate is not allowed, so the bar is page-by-page for PDF: width = pages read / pages; DOCX is one step) and the secondary line "Extracting text and layout. Nothing is uploaded." Parsing runs in a Web Worker (`src/workers/extract.ts`: `pdfjs-dist` with its own worker disabled and run inline inside ours; `mammoth` for DOCX). Typical 1–3 s; a 30 s timeout surfaces the "Could not read the file" error.
4. Extraction produces `{ text, metrics }` (`LayoutMetrics`, §8). The redaction pass (`packages/shared/src/redact.ts`, pure, also used by the engine as a second pass) produces `{ text, removed[] }`. Then step ii.

Errors per §1.5 render in place of the dropzone text with **Choose another** beneath. Nothing on this step touches the network.

**Step ii: Preview.** Heading row: "Check what will be public" at `--text-lg`, lead "We removed what looked like contact details. Read it once; fix anything the extraction got wrong."

Two panes, 8/4:

```
┌──────────────────────────────────────────────┬────────────────────────┐
│ Text to be submitted           3,412 / 15,000│ Removed                │
│ ┌──────────────────────────────────────────┐ │ Name, from the first   │
│ │ [name]                                   │ │   line                 │
│ │ [email] · [phone] · [link]               │ │   Priya Natarajan      │
│ │                                          │ │   → [name]   Not a name│
│ │ Experience                               │ │ Email                  │
│ │ Senior engineer, Acme Cloud  2022–present│ │   priya.n@… → [email]  │
│ │ · Led migration of a 40k rps service ... │ │ Phone                  │
│ │ ...                                      │ │   +1 415 … → [phone]   │
│ │                                          │ │ Links (3)              │
│ └──────────────────────────────────────────┘ │   linkedin.com/in/…    │
│ [Redact selection]                           │   github.com/…         │
│                                              │   priya.dev → [link]   │
│ 2 pages · 1 column · 2 fonts · 0 images ·    │ Address                │
│ 3,412 characters · extraction good           │   12 Market St → [addr]│
│ Layout metrics go to the analysis as numbers;│                        │
│ the file does not.                           │ Removal is by pattern  │
│                                              │ and can miss things.   │
│ Exactly this text becomes public, attached   │ The text is yours to   │
│ to your handle or an anonymous id, in a      │ edit.                  │
│ public GitHub repository anyone can read.    │                        │
│ The original file never leaves this browser. │                        │
│                                              │                        │
│ [Use this text]   Choose another file   Back │                        │
└──────────────────────────────────────────────┴────────────────────────┘
```

- `RedactionPreview` (left): label "Text to be submitted"; an editable `<textarea>` (serif 15 px, `--bg-2`, hairline border, `min-height: 24rem`, grows to content up to 60 vh then scrolls); the counter in mono top-right `3,412 / 15,000` turning `--loss` when over 15,000 or under 400 with the inline messages from §1.5. Replacement tokens are literal text (`[name]`, `[email]`, `[phone]`, `[link]`, `[address]`, `[redacted]`), not styled spans, because the textarea is the truth and what it contains is what is sent. A **Redact selection** secondary button (32 px `small`) sits under the textarea, enabled when the selection is non-empty; it replaces the selection with `[redacted]` and adds a "Redacted by you" item to the panel.
- `MetricsLine`: mono, `--fg-muted`: `2 pages · 1 column · 2 fonts · 0 images · 3,412 characters · extraction good`. Quality is `good | fair | poor` (`poor` → the warning from §1.5 above the textarea, with a `--warn` left rule). For pasted text: `pasted · 3,412 characters`. Helper line in serif: "Layout metrics go to the analysis as numbers; the file does not."
- `PublicNotice`: serif at base size, `--fg` (not muted; this is the one line on the page that must be read): "Exactly this text becomes public, attached to your handle or an anonymous id, in a public GitHub repository anyone can read. The original file never leaves this browser." The wry line follows in `--fg-muted`.
- `RedactionPanel` (right): heading "Removed"; a list grouped by kind in the order name, emails, phones, links, addresses, by you. Each item: the kind in serif, the original in mono `--fg-muted` (middle-truncated to 28 chars), `→` and the token. The name item is a heuristic (first non-empty line, 2–4 title-case words, no digits, appearing before any email or phone) and carries a quiet **Not a name** button that restores it and removes the item; nothing else is restorable from the panel, people restore by editing the text. Empty: "Nothing matched. Check the text for a name, email, or phone." Footnote: "Removal is by pattern and can miss things. The text is yours to edit."
- Buttons: **Use this text** (primary; disabled with reason while the counter is out of range), **Choose another file** (quiet; back to step i with the file cleared), **Back** (quiet).

The redaction rules are the platform's regex set (emails, phones, URLs and bare domains, social paths, street addresses) plus the name heuristic; the engine runs the same shared function again on arrival and the analysis prompt is told the text is pre-redacted. Institution and employer names stay; that is the signal, and `/about` says so.

**Step iii: Details.** Heading "Handle and ladder". `max-width: 40rem`.

1. `TextField` label **Handle**, placeholder `e.g. priya-n`, `maxLength=20`, lowercase forced on input, helper "3 to 20 characters: lowercase letters, numbers, hyphens. It is how the entry appears when you choose not to be anonymous, and how you find it again." Availability is checked after 400 ms idle by `getJson('u/<handle>.json', { fresh: true })`: `null` → "Available."; a file whose `owner_hash` matches the SHA-256 of a local key for that handle → the "Yours" line from §1.5 and the page switches to resubmit mode; otherwise "That handle is taken." A reserved list (`packages/shared/src/handles.ts`: route names, `anon`, `anonymous`, `admin`, `resumearena`, `status`, `data`, `api`, `github`, and anything starting `anon-`) is checked locally first. Format errors per §1.5. Prefilled from `?handle=` or from the most recent local key.
2. `RadioRow` legend **Which ladder is this mainly for?** options `General` (default), `Finance`, `Tech`, `Academia`, helper "It is rated on every ladder it qualifies for. This one decides where placement starts."
3. `Toggle` **Show my handle on the ladders**, default off, helper "Off means you appear as an anonymous id, like anon-k7q2m. You can change this later with your key."
4. Consent line (plain text, not a checkbox; the act of submitting is the consent and the public notice was the disclosure): "By continuing you confirm this is your own resume. The text is analysed by Claude, a model from Anthropic, through its API, and is public as shown in the previous step."
5. Buttons **Continue** (primary; disabled with "Choose an available handle" until the handle passes) and **Back**.

Career stage is not asked; the analysis infers it (`signals.career_stage` in the rubric doc) and the ladders filter on the inferred value. One fewer field, and the judge never saw it anyway.

**Step iv: Submit.** Two variants.

New handle: heading **Your owner key**. `KeyReveal`:

```
Your owner key
This key is the only way to change or delete your entry. It is made in this
browser and shown once. We store only its fingerprint.

rak-k7q2-m9x3-ab4d-ef5g-h6jk-lm7n-pq8r-st9u-vw2x-yz3a-bc4d-ef5g-h6j2
[Copy key]  Save as file

☐ I have saved the key somewhere I will find it.

It also stays in this browser's storage, which clears if you clear site data
or switch devices.

priya-n · tech · anonymous · 3,412 characters
[Submit for rating]
```

- The key is generated when step iv mounts (`generateOwnerKey()`, §6.2), rendered in mono at `--text-md` with `user-select: all`, wrapped at the hyphens. **Copy key** is a secondary button that turns to **Copied** for 2 s. **Save as file** is a quiet button that downloads `resumearena-key-priya-n.txt` built from a `Blob` (contents: the key, the handle, the site URL, one line of what it is for).
- The checkbox gates the submit button (`disabledReason: "Confirm you saved the key first"`).
- Summary line in mono: `handle · ladder hint · anonymous|shown · N characters`.
- **Submit for rating** (primary, full width on mobile).

Resubmit (a local key exists for the handle): heading **Resubmitting as priya-n**, lead "Your key for priya-n is in this browser. Submitting replaces the current entry; the rating carries over as the starting estimate and the old text is removed." No key reveal, no checkbox. Same summary line and button.

On click:

1. `id = newResumeId()` (10 chars `[a-z2-7]`, `crypto.getRandomValues`).
2. Build `SubmitPayload` (§8.2) with `owner_hash = hashOwnerKey(key)`; in resubmit mode also `owner_key`.
3. Preflight already ran when the step mounted: `GET /repos/noahfinkelstein/resumearena/actions/workflows/submit.yml` with the build-time token; a non-200 shows the fallback panel immediately (so the person never types a handle for nothing). On `200`, `POST .../actions/workflows/submit.yml/dispatches` with `{ ref: 'main', inputs }`.
4. `204`: persist the key (`localStorage['resumearena.keys'][handle] = key`), record `localStorage['resumearena.entries'][id] = { handle, submittedAt, via: 'dispatch' }`, clear the draft, navigate to `/r/:id`.
5. Errors per §1.5. The key is already shown and stays stored even if the dispatch fails, so a retry reuses it.

`FallbackPanel` (token missing, revoked, or GitHub refusing twice): the copy from §1.5, then **Copy text and open the form**, which (a) writes the text to the clipboard, (b) opens `https://github.com/noahfinkelstein/resumearena/issues/new?template=submit.yml&title=submit+<id>&id=<id>&handle=<handle>&owner_hash=<hash>&meta=<urlencoded json>` in a new tab (the Issue Form's small fields are prefilled by query string; the text is pasted by the person because 15,000 characters do not fit in a URL), (c) records the entry with `via: 'issue'`, and (d) navigates to `/r/:id` in `fallback_pending` state. A line under the button: "Needs a GitHub account. The form has the same fields; the workflow treats both the same."

Mobile: identical structure; the dropzone becomes a 56 px tall button **Choose a file** with the constraints line beneath (drag-and-drop does not exist); step ii stacks (§7).

### 3.3 Result `/r/:id`

Purpose: the page a person screenshots, and before that the page they wait on. Three phases, one route, one shareable link from the first second.

Who sees what: everyone sees everything. There is no private result; the text and analysis are public by design and the page says so in the footer line "Everything on this page is public, including the text as submitted." The only difference for the owner (a local key whose hash equals `owner_hash`) is a quiet **Manage this entry** link in the header to `/me`.

Phase detection on load and on every poll:

| `getJson('r/<id>.json', { fresh })` | Phase |
| --- | --- |
| `null` and the id is in `localStorage.entries` | **pending** (this browser submitted it) |
| `null` and the id is unknown | 404 after two tries 30 s apart (a shared link may precede the deploy; the 404 copy adds "If you were just sent this link, the result may still be publishing. Try again in a few minutes.") |
| `status: 'queued'` | **pending** with the budget copy |
| `status: 'rejected'` | **rejected** (reason copy from §1.5, text restored from this browser if it is here) |
| `status: 'analysed'` | **analysed** (stage 1 shown, stage 2 pending) |
| `status: 'rated'` | **rated** |
| `status: 'deleted'` | deleted copy |

**Pending layout** (desktop; one column, `max-width: 48rem`):

```
┌──────────────────────────────────────────────────────────────────────┐
│ priya-n  ·  tech  ·  submitted 14:21                     [Copy link] │
│                                                                      │
│  Submitted.                                                          │
│  Analysis usually lands in 3 to 6 minutes; the rating 5 to 15        │
│  minutes after that.                                                 │
│                                                                      │
│  ■  Received.           GitHub accepted the submission at 14:21.     │
│  ■  Queued.             Waiting for a runner. 3 ahead of you.        │
│  ▣  Reading and scoring.  The gate check takes seconds; the         │
│                         analysis one to two minutes. Started 0:42 ago│
│  □  Scored. Publishing.                                              │
│  □  Analysed. Not yet rated.                                         │
│  □  Placed.                                                          │
│                                                                      │
│  We will keep checking. You can close this page; the link is yours.  │
│                                                                      │
│  What happens now                                                    │
│  1  A gate check confirms it is a resume.                            │
│  2  The analysis scores it against the rubric.                       │
│  3  The site rebuilds with the result.                               │
│  4  The next rerank places it with eight matches; the site rebuilds  │
│     again.                                                           │
└──────────────────────────────────────────────────────────────────────┘
```

`PollingStatus` (§4.10) drives the list: each row has a 10 px square (hollow = ahead, filled accent = done, filled `--fg` with the elapsed timer = current). Rows beyond the current show only their label. The identity line shows the handle if visibility is "shown", else `anon-…` once known; before the result file exists it shows the handle from `localStorage` for the submitter and nothing for anyone else.

**Analysed layout** (stage 1 landed): the header row, then the rating block in its pending form, then the analysis.

```
┌──────────────────────────────────────────────────────────────────────┐
│ priya-n  ·  tech, mid career  ·  submitted 3 Oct 2026   [Copy link]  │
│                                                       Manage this entry│
│  ——— ±——                               general   —      after placement│
│  Not yet placed                        tech      —                   │
│  ▣ Analysed. Not yet rated.            finance   —                   │
│    Placement runs in the next rerank, every ten minutes, then the    │
│    site rebuilds. Usually 5 to 15 minutes. This page keeps checking. │
│                                                                      │
│  Verdict                                                             │
│  A strong mid-career infrastructure resume whose numbers do the      │
│  work; the education line is the only soft spot.                     │
├──────────────────────────────────────────────────────────────────────┤
│  Breakdown                                    weight (tech)   score  │
│  Pedigree                   ████████░░░░░░░░     .15          52     │
│  Trajectory                 ███████████░░░░░     .20          70     │
│  Impact                     ████████████░░░░     .30          78     │
│  Selectivity                ██████████████░░     .25          86     │
│  Breadth                    ███████████░░░░░     .10          68     │
│  Stage-relative             ████████████░░░░                  74     │
│  general 71 · tech 78 · finance —  · academia —   (headline scores)  │
├────────────────────────────────┬─────────────────────────────────────┤
│  Strengths                     │  Weaknesses                         │
│  · Quantified results on 7 of  │  · Education sits below the ladder  │
│    9 bullets                   │    median for this tier             │
│  · Two promotions in 4 years   │  · No open-source or public work    │
│  · Owned a system with named   │  · Summary paragraph repeats the    │
│    scale (40k rps)             │    bullets                          │
├────────────────────────────────┴─────────────────────────────────────┤
│  ATS readiness   94 / 100   Parsers will read this correctly.        │
│  Fixes                                                               │
│  · Dates in "Jan 2023 – present" form; two parsers read "present"    │
│    as missing. Use an end month or "Present".                        │
│  · The skills section is a table; export as plain lines.             │
├──────────────────────────────────────────────────────────────────────┤
│  Recent matches                                                      │
│  No matches yet. Placement starts at the next rerank.                │
├──────────────────────────────────────────────────────────────────────┤
│  ▸ Text as submitted  (3,412 characters, 2 pages, 1 column)          │
│  Everything on this page is public, including the text as submitted. │
└──────────────────────────────────────────────────────────────────────┘
```

**Rated layout**: the same page with the rating block filled, the rank table populated, the sparkline, and matches.

```
│  1642 ±38                              general   #1,204   top 3.2%   │
│  Candidate IV                          tech      #  412   top 1.9%   │
│  +12 this week                         finance   —        not rated  │
│                                        academia  —        not rated  │
│  ▁▂▂▃▃▄▄▅▅▅▆▆▆ (sparkline, 40 points)                                │
```

Sections, in order, with the fields of `ResultView` (§8.3) each expects:

1. **Header row.** Identity (`identity.value`), ladder hint and inferred career stage, submitted date. Right: `ShareButton` (copies the URL; toast "Link copied." or, while pending, "Link copied. It works before the result does."), and for the owner a quiet **Manage this entry** link.
2. **Rating block.** `RatingDisplay`: rating in mono at `--text-2xl` with `±rd` at `--text-md` baseline-aligned; tier word and numeral beneath in serif `--text-lg`; delta line `+12 this week` in win/loss colour (`delta_7d`). While not rated: `———` and `±——` as same-width placeholders, "Not yet placed" in place of the tier, and the current `PollingStatus` row beneath. While provisional (`placement.done < placement.total` or `rd > provisional_rd`): the number shows, the tier line reads "Provisional, 3 of 8 placement matches", and the rank cells read `—` with "after placement". `Sparkline` of `history` (last 40 points, 1 px line, no axes, min/max as two mono labels at the ends; `title` carries the range). Hidden until there are 3 points.
3. **Rank table.** `RankTable`: one row per category in `ratings[]` (the ladder hint first, in `--fg`; the others in `--fg-muted`; categories the analysis excluded show `—  not rated` with a tooltip "Relevance below the threshold for this ladder."). Each rated row links to that ladder at the right page with focus: `/leaderboard/tech?page=5&focus=:id`.
4. **Verdict.** One sentence from the analysis (`analysis.verdict`). Serif, `--text-md`. The only place the LLM's prose is set large.
5. **Breakdown.** `ScoreBars`: a table, not a chart. Columns: name, bar, weight, score. Bars are 8 px tall, `--fg` on `--bg-3`, square; width is `score/100`. Rows are the five rubric sub-scores (`analysis.subscores[]`: `key`, `label`, `score`, `weight`, `median`), then `stage_relative` without a weight. The weight column is headed with the ladder it applies to (`weight (tech)`); a thin vertical tick on each bar marks that ladder's median from the deploy-time index (`median`), with the one-line note "Tick marks the median on your primary ladder." Under the table a mono line lists the headline score per category (`analysis.category_scores[]`), `—` for excluded ones. Clicking a row expands the sub-score's rationale (`note`) beneath it.
6. **Strengths / weaknesses.** Two columns of bullet lists, three to five items each. Plain bullets, serif. Weaknesses are phrased as observations, not insults.
7. **ATS readiness.** `ats.score` out of 100 with `ats.summary`. `ats.fixes[]` (each `{ priority, factor, issue, fix }`) as bullets, public (the text is public, so quoting it reveals nothing). A disclosure "Factors" shows the seven factor scores as a small `ScoreBars` without medians.
8. **Red flags** (only when `analysis.red_flags[]` has medium or high severity items): a short list under a `--warn` left rule. "Flags are shown to you and affect only the lines they touch."
9. **Recent matches.** `MatchList` with the last 8 (`matches[]`: `outcome`, `opponent { id, identity, rating, tier }`, `delta`, `judge_note`, `at`). Outcome is a single mono letter W/L/D in its colour. Opponent identity links to their result. `judge_note` is one sentence, clamped to two lines with a title attribute for the full text. Link to `/r/:id/matches` for the full list (`matches_total`).
10. **Text as submitted.** A native `<details>` whose summary reads `Text as submitted (3,412 characters, 2 pages, 1 column)`; inside, the text in a `<pre>`-wrapped block in serif with the redaction tokens as they are. Beneath it, the fixed line "Everything on this page is public, including the text as submitted." and, for the owner, "Remove it with your key on the manage page."

The reveal: the first time this browser sees `status: 'rated'` for this id (tracked in `localStorage['resumearena.revealed']`), the rating block starts with the number hidden behind a `--bg-3` rectangle of the right width; after 300 ms it wipes left-to-right over 250 ms revealing the digits; the ± and tier fade in over 150 ms after. Under reduced motion everything is simply present. This is the one orchestrated moment on the site, and it runs whether the page was open while the status changed or was opened afterwards.

Polling: `PollingStatus` polls `r/<id>.json` with `fresh: true` every 20 s while pending (runs API every 30 s in parallel for the status rows), every 60 s while analysed, and stops once rated; all intervals pause when `document.hidden` and fire once on `visibilitychange`. A page opened from a shared link with no local entry polls the file only (no runs API) and shows a shorter list: "Publishing." / "Analysed. Not yet rated."

Error states per §1.5: rejected (with **Back to the text** when the draft is in this browser, else **Upload a resume**); failed run; lost; deleted; 404.

### 3.4 Ladder `/leaderboard/:category`

Purpose: a dense, fast table over tens of thousands of rows that a person can find themselves in, served entirely from static pages.

Layout: full-width table under a thin filter bar. No sidebars.

```
┌──────────────────────────────────────────────────────────────────────┐
│ General ladder                        12,418 rated · updated 4 min ago│
│ general  finance  tech  academia                                     │
│ ─────────────────────────────────────────────────────────────────── │
│ stage [any ▾]   search [handle          ]   [find me]   page [ 12 ]  │
├─────┬──────────────┬────────────────┬───────┬─────┬─────────┬────────┤
│   # │ identity     │ tier           │ rating│  ±  │ record  │ stage  │ signal
├─────┼──────────────┼────────────────┼───────┼─────┼─────────┼────────┤
│   1 │ m-castellan  │ Laureate VIII  │  2431 │  22 │ 61-9-4  │ senior │ FAANG staff
│   2 │ anon-k7q2m   │ Grandmaster VII│  2388 │  31 │ 44-11-2 │ mid    │ YC founder
│ …   │              │                │       │     │         │        │
│1,204│ priya-n  ◂you│ Candidate IV   │  1642 │  38 │ 21-15-2 │ mid    │ 40k rps system
│ …   │              │                │       │     │         │        │
├─────┴──────────────┴────────────────┴───────┴─────┴─────────┴────────┤
│  1,101–1,200 of 12,418                   ◂ newer   page 12 of 125  older ▸ │
└──────────────────────────────────────────────────────────────────────┘
```

Data (all written at deploy):

- `ladders/<category>/index.json` → `{ generated_at, total, page_size: 100, pages, medians: { pedigree, … }, stages: { student: { total, pages }, … } }`
- `ladders/<category>/page-<n>.json` → `LadderRow[]` (100 rows, `n` zero-padded to 4 digits)
- `ladders/<category>/stage-<stage>/page-<n>.json` → the same for one career stage
- `ladders/<category>/top.json` → first 10 rows (landing)
- `handles/<first char>.json` → `[handle, id, rank_general][]` for search (shard of at most a few thousand entries; anonymous entries are listed under their anon id's first character after the prefix)

Columns (`LeaderboardTable` full mode):

| Column | Content | Format |
| --- | --- | --- |
| # | rank within the view (overall or within the stage filter; the index precomputes both) | mono, right-aligned, thousands separator |
| identity | handle or anon id | handle links to `/u/:handle`; anon links to `/r/:id` |
| tier | word + numeral | serif + mono numeral |
| rating | integer | mono |
| ± | rd | mono, muted |
| record | W-L-D | mono, hyphens (`21-15-2`), no colour |
| stage | inferred career stage | short word: student, new grad, early, mid, senior, exec |
| signal | `top_signal` | one `Chip`, max 18 chars, from the analysis card's headline (the single most load-bearing fact). Truncate with an ellipsis and a title attribute. |
| 7d | rating delta over 7 days | mono, signed, win/loss colour; hidden under 1100 px |

Row density: 40 px rows, 15 px mono, hairline row borders only (no zebra). Rank 1–3 are not styled differently; the ladder is not a podium.

Filters:

- **stage**: any, student, new grad, early, mid, senior, exec (`?stage=`). Switching swaps the page directory; the page number resets to 1.
- **search**: handle or anon id prefix, debounced 250 ms, `?q=`. Loads the one `handles/<c>.json` shard for the first character and filters it client-side; results (up to 50) replace the table with columns #, identity, rating pulled from the shard's rank and a follow-up fetch of the containing page for the rating. "No one by that handle."
- **find me**: visible when `localStorage` holds an entry rated in this category (the result file's `ratings[]` carries `rank` and `page`); navigates to `?page=<page>&focus=<id>` and highlights the row with a left 2 px accent rule and a `◂ you` marker in mono. The row stays pinned as a sticky footer strip (`YouAreHereRow`) when scrolled out of view, showing rank, rating, and a "jump" link.
- A **window** filter (active this week) is not in v1; it would need a second set of derived pages per category and the "updated N min ago" label already answers the question people ask with it.

Pagination: page numbers, because pages are files. `?page=12`; controls are "◂ newer   page 12 of 125   older ▸" with the page number as a small mono input (`Cursor`); "jump to rank" is the same input with a `#` prefix, computed as `ceil(rank / 100)`. Rendering is a plain table of 100 rows; no virtualisation.

Header: the four category names are a segmented row of text links (the current one underlined with a 2 px rule in `--fg`), not tabs with backgrounds. Right: `12,418 rated · updated 4 min ago`.

Freshness: the index re-fetches every 5 minutes when visible; if `generated_at` changed, the current page re-fetches and changed rating cells crossfade 150 ms. Rank changes do not animate rows moving; the table simply re-renders.

States: loading shows 100 skeleton rows at 40 px (or `pages` from the index when known); empty per §1.5; error shows the header, filters, and one row spanning the table: "Could not load. GitHub Pages did not answer. Retrying." The filters stay usable.

### 3.5 Arena `/arena`

Purpose: a fast, slightly addictive loop that teaches what the judge rewards. In v1 it writes nothing: the visitor guesses, the judge's recorded verdict is revealed. Votes that move ratings are v2 and nothing on this page hints at them.

Layout: one centred column `max-width: 60rem`, two cards side by side with a 2 rem gap and the question above.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Arena   tech ▾                            streak 7 · 142 guesses  ?  │
│                                                                      │
│ Which did the judge prefer?                                          │
│                                                                      │
│ ┌──────────────────────────────┐  ┌──────────────────────────────┐  │
│ │ A                             │  │ B                             │  │
│ │ mid career · 6 years          │  │ early career · 2 years        │  │
│ │ ───────────────────────────── │  │ ───────────────────────────── │  │
│ │ Senior engineer, Acme Cloud   │  │ Engineer, seed-stage startup  │  │
│ │ 2022–present                  │  │ 2024–present                  │  │
│ │ · Led migration of a 40k rps  │  │ · Sole owner of the payments  │  │
│ │   service; cut p99 by 38%     │  │   service from zero           │  │
│ │ · Promoted twice in 4 years   │  │ · Shipped to 20k users in 9 mo│  │
│ │ Engineer, mid-size fintech    │  │ Research assistant, T2 CS     │  │
│ │ 2020–2022                     │  │ department, 2023              │  │
│ │ BS Computer Science, large    │  │ BS Computer Science, T1       │  │
│ │ state university, 2020        │  │ program, 2024                 │  │
│ │                               │  │ · 2 publications (workshop)   │  │
│ │ [ A ]                  key 1  │  │ [ B ]                  key 2  │  │
│ └──────────────────────────────┘  └──────────────────────────────┘  │
│                                                                      │
│                          Too close to call   ·   Skip                │
└──────────────────────────────────────────────────────────────────────┘
```

Cards (`ArenaCard`): the anonymised `Card` from the analysis (`headline`, `career_stage`, `years_fulltime`, `experiences[]`, `education[]`, `notable[]`, per the rubric doc), rendered as a dense list. Institutions and employers appear by name when the card has them; there is no name, contact, link, or exact date, because the card never had them. The person's rating and identity are hidden until the reveal.

Data: `arena/<category>/index.json` → `{ generated_at, shards, per_shard }` and `arena/<category>/shard-<n>.json` → `ArenaPair[]` (40 per shard): recent judged matches where both orderings agreed or both disagreed (so draws are real draws), each `{ match_id, a: { id, card, rating_before, tier }, b: {...}, verdict: 'A' | 'B' | 'draw', reason, deltas: { a, b }, at }`. The page picks a random shard, shuffles, and skips `match_id`s already in `localStorage['resumearena.arena'].seen` (last 300). Shards exclude any pair involving an entry whose owner key is in this browser? They cannot (the file is shared), so the client hides pairs whose `a.id` or `b.id` is in `localStorage.entries`.

Interaction loop:

1. A pair renders; the next is prepared from the same shard.
2. Guess: click **A** / **B** (primary buttons inside the cards), or keys `1` / `2` (also `←` / `→`), or **Too close to call** (`=`), or **Skip** (`s`, not counted).
3. On guess, both cards stay; the chosen card gets a 2 px `--fg` outline. Below the cards a `JudgeReveal` block slides in (200 ms height transition): "The judge preferred **B**." then the reason in italics: *Sole ownership of a revenue system at two years beats a well-executed migration inside a larger team; the education line also tilts B.* then a mono line `A 1588 → −7 · B 1611 → +7` and the identities as links (`anon-x91pp`, `priya-n`). If the guess matched, the line beneath reads "You agree with the judge." and the streak increments; if not, "You and the judge disagree." and the streak resets. For draws: "The judge could not separate them: it picked differently in the two orderings, which counts as a draw."
4. **Next** (Enter, or click) swaps in the prepared pair; the reveal collapses.

Streak counter (`StreakCounter`): consecutive guesses agreeing with the judge, lifetime guesses, agreement percentage after 20 guesses, all in `localStorage['resumearena.arena']` (`{ streak, best, guesses, agreed, seen[] }`). The `?` button opens a one-paragraph explainer: "These are real matches the judge already decided. Your guesses stay in this browser and change nothing; the judge's reason is the lesson."

Category selector: a small disclosure; default rotates per visit (persisted in the same storage key so the rotation is actually a rotation).

States: loading shows two card frames with skeleton lines; empty per §1.5; shard exhausted → the next shard; all shards seen → "You have seen every recent match on this ladder. New ones arrive with each rerank." with a link to another ladder; error "Could not load. GitHub Pages did not answer. Retrying."

### 3.6 Profile `/u/:handle`

Purpose: a public page per handle for the entry under it. Deliberately small. Exists only for entries whose owner shows the handle; anonymous entries 404 here and are reached by `/r/:id`.

Layout: one column `max-width: 48rem`.

- Header: handle in display serif at `--text-xl`, "entered 3 Oct 2026", and a `Chip` `resubmitted 2×` when the entry has prior versions.
- Rating line: `1642 ±38 · Candidate IV` with the ladder hint, rank, and percentile; `RankTable` beneath.
- Link to the result page: **Full result →**.
- `RatingHistoryTable` (collapsed, "show history"): date, event (match W/L/D, placement, resubmission), opponent, delta, rating after. From `u/<handle>/history.json`, 50 rows a page client-side.
- Owner (local key matches) sees **Manage this entry →**.

Data: `u/<handle>.json` → `{ handle, owner_hash, resume_id, visibility, entered_at, versions, ratings[] }`. Empty per §1.5. Not found → 404 copy with "No one by that handle."

### 3.7 Manage your entry `/me`

Purpose: every write after the first, in one place, behind the key. Plain form, one action at a time.

Layout: one column, `max-width: 40rem`.

1. **Key.** If `localStorage.keys` holds keys, a `SelectField` **Entry** listing them by handle (one key usually; the field is hidden when there is exactly one). Beneath, always: `KeyInput` (`TextField` label **Or paste a key**, mono, placeholder `rak-…`, helper "Pasting a key from another device manages that entry here and remembers the key in this browser.") with a secondary **Use this key** button. On use: parse (§6.2); hash; fetch `u/<handle>.json` for each candidate handle? No: the key does not encode the handle, so the person also types the handle (`TextField` **Handle**, prefilled from the last entry). Fetch `u/<handle>.json`; compare `owner_hash`; mismatch → "That key does not match."; success → store and continue.
2. **Entry.** A summary block: identity as shown, result link, rating line (or "analysed, awaiting placement" / "pending"), submitted date, `versions`.
3. **Visibility.** `Toggle` **Show my handle on the ladders** reflecting `visibility`. Changing it dispatches `manage` with `action: 'set_visibility'` and shows an inline `PollingStatus` in miniature: "Sending." → "Received. Changes land with the next deploy, a few minutes." The toggle is disabled until the next poll of `u/<handle>.json` shows the new value or 15 minutes pass (then "Not applied yet. Check back, or try again."). Toast on landing: "Now showing as priya-n" / "Now anonymous".
4. **Resubmit.** One line "Replace the text with a new version. The rating carries over as the starting estimate; the old text is removed." and a secondary button **Resubmit a resume** linking to `/upload?handle=priya-n` (which lands in resubmit mode at step i).
5. **Delete.** Line: "Delete this entry." and the wry line. Secondary-destructive button **Delete this entry** opens `ConfirmDialog`: title **Delete this entry?**, body "This removes the text, the analysis, and the rating from the ladders with the next deploy. Opponents keep their results; your side of each match becomes an anonymous placeholder. The handle becomes available again. This cannot be undone.", input **Type the handle to confirm**, button **Delete this entry** (destructive, disabled until the handle matches). On dispatch: the key and entry are removed from this browser immediately, and the page shows "Deletion received. It lands with the next deploy, a few minutes. The link will then say the entry was deleted." If the direct channel is down, the dialog offers the Issue Form fallback for deletion only (`delete.yml`, fields `id`, `handle`, `owner_key`; the raw key becomes public in the issue, which is acceptable only because deletion makes it worthless, and the dialog says so: "This posts your key in a public issue. After deletion the key is useless, so that is acceptable; it is not acceptable for anything else, which is why only deletion has a fallback.").
6. **This device.** Quiet button **Forget this key on this device** (removes it from `localStorage`; confirm inline "Forgotten. The entry is unchanged; paste the key to manage it again."). Quiet button **Show key** reveals the stored key with a copy button, for moving to another device.

Visibility and resubmission have no issue fallback (they would post the raw key publicly for a non-terminal action); when the direct channel is down they show: **The direct channel is down.** "Changing visibility and resubmitting need it. Try again later; deletion still works through the fallback."

### 3.8 About `/about`

Purpose: trust. Written as a short paper with anchor headings: How the rating works · What the judge sees · How writes work · The ladders · Limits · Privacy · Status · Contact.

- **How the rating works**: Glicko (rating + deviation), what ± means, the rubric-seeded start, eight placement matches in general and six per domain ladder, both orderings per match with disagreement scored as a draw, why ratings move when you do nothing ("The ladder moves under you: as new resumes are placed, yours is re-matched against them, which is why a rating can drift a few points a week."), the tiers table with thresholds.
- **What the judge sees**: the card (what stays: institutions, employers, titles, year ranges, numbers; what never reaches it: name, contact, links, exact dates), the five sub-scores and per-ladder weights, the model names ("Scoring uses a larger model; matches use a faster one; a small model checks that the text is a resume at all."), that the judge gives a reason every time and the reason is shown.
- **How writes work**: the honest paragraph. "This site has no server. Submitting calls GitHub directly and starts a workflow in the public repository; the workflow reads the text, calls the model, and commits the result to a branch, which is then published as the files this site reads. The key that lets the page start that workflow is public and can do nothing except start or cancel our workflows; the workflow checks everything it is given. If that key is withdrawn, a GitHub issue form does the same job. Nothing you submit passes through anything but your browser, GitHub, and Anthropic."
- **The ladders**: the four categories, inclusion by relevance, how the ladder hint picks the placement pool, stage filters.
- **Limits**: 15,000 characters of text; one entry per handle at a time; a daily judging budget that, when spent, queues placement to the next day; GitHub's own rate limits on the direct channel.
- **Privacy**: what is public (the redacted text, the analysis, the card, matches and ratings, the handle if shown), what never exists on our side (the file, an email, an IP log beyond GitHub's), that the data lives in a public git branch and so has history ("Deleting removes the current files; the branch history is rewritten weekly to drop deleted entries, so a deleted text can remain visible to someone reading the repository for up to a week."), the Anthropic API retention line, and the "Something personal slipped through?" route: delete with the key, or send the id to the contact address.
- **Status**: `StatusBlock` (§4.14). A mono table from `status.json`:

  ```
  Status                                    as of 14:32 UTC · 4 min ago
  Awaiting analysis              3
  Awaiting placement             7
  Spend today            $18.40 of $40.00
  Last rerank            14:28 UTC · 212 matches · 6 placed
  Last deploy            14:31 UTC · a1b2c3d
  Resumes rated              12,418
  Matches played            301,992
  Direct channel         open
  ```

  Rows: `queue.awaiting_analysis`, `queue.awaiting_placement`, `spend_today_usd / daily_budget_usd` (over budget → the row reads `$40.00 of $40.00 · placement resumes 00:00 UTC` in `--warn`), `last_rerank { at, matches, placed }`, `last_deploy { at, sha }`, `totals { resumes_rated, matches }`, and the direct-channel probe (the same preflight as step iv, run on mount: `open` / `down, fallback only`). The wry line beneath.
- **Contact**: an email address and the GitHub repo.

### 3.9 Not found

Heading "Nothing here." and the body from §1.5 with two links. Also used for `/u/:handle` of an anonymous or unknown entry ("No one by that handle.") and for `/r/:id` of an unknown id (with the "may still be publishing" sentence).

---

## 4. Design system

The system is a sibling of the owner's portfolio, not a copy: the same discipline (two faces, square corners, paper/night, hairlines), different faces, a cooler paper, a different accent, and a data layer the portfolio does not need (win/loss/draw, bars, chips, tables).

### 4.1 Typefaces

Two faces, both from Google Fonts, self-hosted via `@fontsource-variable` so the site does not call Google at runtime.

- **Newsreader** (variable: weight 200–800, optical size 6–72, italic). Display, body, UI. Chosen because it is a text serif designed for screens with a real optical-size axis, so a 56 px rating caption and a 15 px table label come from the same family without looking like the same cut. It is clearly distinct from STIX Two (which is a mathematics face) while keeping the same literate register.
- **IBM Plex Mono** (400, 500, italic 400). Every numeral that is data: ratings, ±, ranks, deltas, records, dates in tables, ids, chips, keyboard hints, the sparkline labels. Chosen for its tabular figures by default, its distinct `0`/`O` and `1`/`l`, and because it sits visually heavier than JetBrains Mono, which suits a table that is mostly numbers.

Body is the serif. UI chrome (nav, buttons, form labels) is also the serif. The mono is never used for prose or for labels; the moment a thing is a word rather than a value, it is in Newsreader. This is the one rule that keeps the page from reading as "terminal".

```css
:root {
  --font-serif: "Newsreader Variable", "Newsreader", Georgia, "Times New Roman", serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
body { font-family: var(--font-serif); font-optical-sizing: auto; }
.num, td.num, .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
```

Display sizes use `font-variation-settings: "opsz" 72` explicitly where the browser's auto optical sizing does not kick in (Safari).

### 4.2 Type scale

Base 17 px, ratio ~1.2 with a jump at the top, line-heights tuned per size. (Numbers are rem.)

| Token | Size | Line height | Use |
| --- | --- | --- | --- |
| `--text-xs` | 0.8125 (13 px) | 1.4 | chips, table meta, footer |
| `--text-sm` | 0.9375 (15 px) | 1.45 | table cells, helper text, labels |
| `--text-base` | 1.0625 (17 px) | 1.55 | body |
| `--text-md` | 1.25 (20 px) | 1.4 | verdict, subheads, ± next to rating |
| `--text-lg` | 1.5 (24 px) | 1.3 | tier under rating, section headings |
| `--text-xl` | 2 (32 px) | 1.2 | page headings, profile handle |
| `--text-2xl` | clamp(2.75rem, 6vw, 4.5rem) | 1.0 | the rating, the landing h1 |

Weights: serif 400 for everything; 500 for the current nav item and table headers; italics for emphasis in prose and for judge quotes. Mono 400; 500 for the rating. No bold anywhere.

Measure: prose blocks cap at `64ch`. Tables are exempt.

### 4.3 Colour tokens

All tokens are plain hex (no `color-mix` for the ones the sparkline canvas reads). Contrast figures are against the theme's `--bg` unless noted; every text token clears 4.5:1 on `--bg`, `--bg-2`, and `--bg-3`.

```css
:root, html[data-theme="paper"] {
  color-scheme: light;
  --bg:        #f5f4ef;  /* cool paper, not cream */
  --bg-2:      #ffffff;  /* raised: cards in arena, dialogs */
  --bg-3:      #e9e8e1;  /* quiet fills: bar tracks, skeletons, chips */
  --fg:        #16171b;  /* 16.3:1 */
  --fg-muted:  #5b5d64;  /* 6.0:1 */
  --accent:    #23408e;  /* ink: fills, rules, focus */
  --accent-text: #1f3a82;/* 9.6:1 — links */
  --accent-soft: #c9d2ea;/* underlines, selected row tint */
  --on-accent: #ffffff;
  --border:    #d8d6ce;
  --border-strong: #16171b;
  --win:       #1d6b4a;  /* 5.9:1 */
  --loss:      #a3302a;  /* 6.3:1 */
  --draw:      #5f6168;  /* 5.6:1 */
  --warn:      #7a5200;  /* 6.3:1 — ATS warnings, rate-limit notes */
  --warn-soft: #f3e7c6;
  --danger:    #a3302a;
  --shadow:    none;
}

html[data-theme="night"] {
  color-scheme: dark;
  --bg:        #0f1114;  /* charcoal, not navy */
  --bg-2:      #16191e;
  --bg-3:      #1f2329;
  --fg:        #e7e5de;  /* 15.0:1 */
  --fg-muted:  #a3a5ac;  /* 7.7:1 */
  --accent:    #8ea8ee;
  --accent-text: #a6bbf4;/* 9.9:1 */
  --accent-soft: #2a3652;
  --on-accent: #0f1114;
  --border:    #2a2e35;
  --border-strong: #e7e5de;
  --win:       #62c493;  /* 8.9:1 */
  --loss:      #ef8072;  /* 7.2:1 */
  --draw:      #9a9ca3;  /* 6.9:1 */
  --warn:      #e3b85e;  /* 10.2:1 */
  --warn-soft: #3a3012;
  --danger:    #ef8072;
  --shadow:    none;
}
```

Usage rules:

- `--accent` is for links, focus rings, the primary button, selected states, and the "you are here" rule. It is never a background for large areas.
- `--win`/`--loss`/`--draw` colour exactly three things: the W/L/D letter, signed deltas, and the chosen-side marker in the arena reveal. Not bars, not tiers, not backgrounds.
- No gradients. No shadows (`--shadow: none` exists so a future dialog can opt in once, consciously).
- There is no `--glow`. The page is flat paper.

### 4.4 Spacing, layout, radii, borders

```css
:root {
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
  --space-5: 1.5rem;  --space-6: 2rem;   --space-7: 3rem;    --space-8: 4.5rem;
  --content-max: 72rem;   /* prose and most pages */
  --table-max: 84rem;     /* the ladder */
  --gutter: clamp(1rem, 4vw, 2.5rem);
  --radius: 0;            /* everything */
  --radius-focus: 2px;    /* focus rings only */
  --hairline: 1px solid var(--border);
  --rule: 1px solid var(--border-strong);
}
```

- Section separation is a hairline plus `--space-7` of air, not boxes.
- "Cards" exist only in the Arena (two things being compared) and dialogs. They are `--bg-2` with a hairline border and no radius.
- A `--rule` (full-strength 1 px) is used under page headings and above table bodies, the way a scoresheet is ruled; hairlines everywhere else.

### 4.5 Focus, motion, reduced motion

```css
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--radius-focus); }
:focus:not(:focus-visible) { outline: none; }

:root { --ease: cubic-bezier(0.2, 0.8, 0.2, 1); --dur-fast: 150ms; --dur: 200ms; --dur-slow: 250ms; }
@media (prefers-reduced-motion: reduce) {
  :root { --dur-fast: 0ms; --dur: 0ms; --dur-slow: 0ms; }
  * { animation: none !important; scroll-behavior: auto !important; }
}
```

Motion inventory, complete:

| Where | What | Duration |
| --- | --- | --- |
| Buttons, links | colour/underline | 150 ms |
| Toggle | knob translate | 150 ms |
| Arena judge reveal | height + opacity | 200 ms |
| Arena card selection | outline appears | 0 (instant) |
| Ladder cell change after a refresh | opacity crossfade | 150 ms |
| Result reveal (first time `status: 'rated'` is seen in this browser) | wipe then fade | 250 + 150 ms, once |
| Result sections appearing when stage 1 lands while the page is open | opacity | 150 ms |
| Pending step row becoming current | square fill | 0 (instant) |
| Toast | translateY 8 px + opacity | 200 ms in, 150 ms out |
| Dialog | opacity | 150 ms |
| Extraction progress bar width (step i) | width | 250 ms |
| `StepRail` step change | underline moves | 0 (instant) |

Nothing animates on scroll. Nothing loops: the pending page's elapsed timer is text that changes once a second, not an animation, and the "updated N min ago" label changes at most every 30 s.

### 4.6 Tables

```css
table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
thead th { text-align: left; font-weight: 500; padding: var(--space-2) var(--space-3); border-bottom: var(--rule); color: var(--fg); }
tbody td { padding: 0 var(--space-3); height: 40px; border-bottom: var(--hairline); vertical-align: middle; }
td.num, th.num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
tbody tr:hover { background: var(--bg-3); }           /* no transition */
tbody tr[aria-current="true"] { box-shadow: inset 2px 0 0 var(--accent); background: var(--accent-soft); }
```

- Header text is sentence case, 500 weight; no all-caps, no letter-spacing.
- No zebra striping. Hairlines carry the rows.
- Numeric columns right-aligned, mono. Text columns left-aligned, serif.
- Sticky header on the ladder (`position: sticky; top: 56px`).

### 4.7 Chips and tags

One chip style. 13 px serif text, 2 px 6 px padding, hairline border, no fill, square. Variants change only the border/text colour: default (`--fg-muted`), `warn` (`--warn`; used for `resubmitted 2×` on a profile and for the over-budget status row), `provisional` (`--draw`, dashed border). The `signal` chip on the ladder is the default variant. Chips never carry icons.

### 4.8 Buttons

Three styles, one size (36 px tall, 15 px text, 0 14 px padding), plus a 32 px `small` for in-table actions.

| Style | Paper | Night | Use |
| --- | --- | --- | --- |
| primary | `--accent` fill, `--on-accent` text, no border | same tokens | one per view: Upload a resume, Use this text, Continue, Submit for rating, Copy text and open the form, A / B in the arena |
| secondary | transparent, 1 px `--border-strong` border, `--fg` text | same | Copy key, Choose another, Redact selection, Use this key, Resubmit a resume, Next |
| quiet | transparent, no border, `--accent-text` text, underlined on hover | same | Skip, Back, Paste text instead, Save as file, Not a name, Show all, theme toggle, Forget this key on this device |
| destructive | transparent, 1 px `--danger` border, `--danger` text; fills `--danger` on hover | same | Delete this entry (inside the dialog only) |

Hover: primary darkens by mixing 10% `--fg`; secondary gets `--bg-3`. Active: no scale transforms. Disabled: 45% opacity, `cursor: not-allowed`, and the reason is always written next to it (e.g. "Choose a file first").

Keyboard hints (arena) are a mono `kbd` at 13 px with a hairline border, placed after the button text with a space, never inside the button.

### 4.9 Forms

- `TextField`: 36 px, 1 px `--border` border, `--bg-2` fill, 15 px serif text, square. Label above in 15 px serif; helper or error below in 13 px (`--fg-muted` / `--loss`). Focus uses the global ring. Invalid adds `aria-invalid` and a `--loss` border.
- `SelectField`: native `<select>` styled to match (the `color-scheme` token keeps the dropdown themed).
- `RadioRow`: options as square chips, 36 px, selected = `--fg` border and `--bg-3` fill; it is a `fieldset` with real radios visually hidden.
- `Toggle`: 36×20 track, hairline border, 16 px square knob; on = `--accent` track. Label to the right; helper beneath.
- `Checkbox`: 18 px square, hairline border, `--accent` fill with a 2 px inset `--on-accent` square when checked (no tick glyph); label to the right at 15 px serif. Used once, in `KeyReveal`.
- `FileDropzone`: described in §3.2. States: idle, drag-over (solid `--accent` border, `--accent-soft` fill), reading (file name in mono, a 2 px page-progress bar, the "Nothing is uploaded" line), error (title and body from §1.5 inside the zone with "Choose another"), disabled. There is no "has-file" state: a successfully read file advances to step ii. All parsing is in a Web Worker so the main thread stays responsive and a hostile file cannot hang the page; the component has no network path.
- Textareas (`PasteBox`, `RedactionPreview`): serif 15 px (16 px on touch), `--bg-2`, hairline border, square, `resize: vertical`, `spellcheck="false"` on the preview (the text is not ours to correct), tab inserts nothing (focus moves on).

### 4.10 Progress and waiting

There is no spinner component in the codebase. Indeterminate waits (first fetch) use a static `—` or skeleton. Two components show progress, and both only show what they know.

**Extraction progress** (step i, inside `FileDropzone`): a 2 px bar whose width is `pagesRead / pages` for PDF (one step for DOCX), with the file name in mono above and "Extracting text and layout. Nothing is uploaded." beneath. It is the only determinate bar on the site because it is the only process the browser can measure.

**`PollingStatus`** (pending and result pages, §3.3; miniature on `/me`): a vertical list of the platform states from §1.5. Each row: a 10 px square (hollow = ahead, filled `--fg` = current, filled `--accent` = done), the label in serif, the secondary line in `--fg-muted`, and a mono elapsed timer on the current row only. No bar: the platform does not report fractions and the component does not invent them.

State machine (submitter mode; visitor mode has only the file poll and the rows `publishing` → `analysed` → `rated`):

```
dispatched ──(run found: queued/waiting)──▶ queued ──(in_progress)──▶ running ──(completed: success)──▶ publishing
    │                                                    │                                                 │
    │ no run after 2 min ─▶ not_seen ─ no run after 10 min ─▶ lost (error)                                │
    │                                                    └─(completed: failure/cancelled)─▶ failed (error) │
    └──────────────────────────── r/<id>.json appears ────────────────────────────────────────────────────┘
                                          │
            ┌─────────────────────────────┼──────────────────────────────┐
     status: rejected               status: queued                status: analysed ──▶ placing (placement.done > 0) ──▶ rated
     (reason copy)                  (budget copy)                        │  budget_wait when status.json says spend ≥ budget
                                                                         └─ stale after 45 min without rated (keeps polling at 60 s)
```

Sources and cadence: the result file every 20 s while pending and 60 s while analysed (`fresh: true`); the GitHub runs API every 30 s in submitter mode until the file appears or 20 minutes pass; `status.json` once a minute for the queue count and budget flag. All timers pause on `document.hidden` and fire immediately on return. A run found via the API but with a different `display_title` is ignored; the match is exact on `submit <id>`.

The component never navigates. It reports `onPhase` and the page decides what to render; the pending list collapses to the single current row once the analysis is on screen.

### 4.11 Toast

One at a time, bottom-left on desktop (24 px from edges), top-centre on mobile under the nav. `--bg-2` with `--rule` border, 15 px serif, max 48 ch, 4 s auto-dismiss, dismiss on click, `role="status"`. No icons; no colour variants except an error toast which has a 2 px `--loss` left border.

### 4.12 Dialog

Native `<dialog>` with `showModal()`. `--bg-2`, hairline border, 32 px padding, `max-width: 28rem`, backdrop `rgb(0 0 0 / 0.4)`. Title at `--text-lg`, body at base, buttons right-aligned: quiet "Cancel", then the action. Escape closes; focus returns to the opener.

### 4.13 Accessibility floor

- All text tokens ≥ 4.5:1 on all three backgrounds; verified for the values in §4.3 with the WCAG formula (lowest: `--draw` on paper `--bg-3` at 5.0:1; `--fg-muted` on paper `--bg-3` at 5.4:1).
- Everything reachable and operable by keyboard; arena has single-key shortcuts that are also buttons; shortcuts are disabled while focus is in an input.
- Tables use `<th scope>`; the "you are here" row uses `aria-current="true"`; outcome letters have `aria-label="win"` etc.
- Sparkline is an inline `<svg role="img">` with an `aria-label` stating start, end, min, max.
- Score bars are a `<table>` with the numeric value in a cell, so the bar is decoration (`aria-hidden`).
- Live regions: toast (`status`), the current `PollingStatus` row label (`aria-live="polite"`; the elapsed timer is `aria-hidden` so it does not announce every second), the handle availability line (`aria-live="polite"`), arena reveal (`aria-live="polite"`).
- The redaction preview textarea has `aria-describedby` pointing at the public notice, so a screen reader hears the exposure sentence when focus enters the text.
- The owner key is in an element with `aria-label="Owner key"` and is also copied by the button; it is never only visual.
- Reduced motion per §4.5; reduced data is respected by not preparing the next arena pair early.
- Touch targets ≥ 40 px on mobile for buttons and row links.

### 4.14 Status block

`StatusBlock` (`/about#status`): a two-column mono table at 13 px, labels in serif `--fg-muted` on the left, values in mono `--fg` on the right, hairline rows, a `--rule` above. The header row carries `as of 14:32 UTC · 4 min ago` on the right. One row may be `--warn`: the spend row when `spend_today_usd ≥ daily_budget_usd`. The direct-channel row's value is `open`, `down, fallback only`, or `checking` while the preflight is in flight; it is the one value on the page that comes from a GitHub API call rather than a file. The block renders with `—` values until `status.json` arrives and shows "Could not load. GitHub Pages did not answer. Retrying." in its last row on failure. No sparkline, no history, no chart: it is a status, not a dashboard.

---

## 5. React component inventory and formatting rules

### 5.1 Components

Files live under `web/src/components/` (shared) and `web/src/pages/` (route components). Pure logic shared with the engine (redaction, owner keys, ids, handles, tiers, payload codecs) lives in `packages/shared/src/` and is imported by both. Props are TypeScript; only the public props are listed.

**Layout and chrome**

- `AppShell({ children })` — nav, footer, toast outlet, theme provider, identity provider (§6.4).
- `TopNav({ hasKey: boolean })` — wordmark, ladders disclosure, arena, about, primary CTA, theme toggle, "Your entry" when `hasKey`.
- `Page({ title, width?: 'prose' | 'content' | 'wide' | 'table', children })` — sets `<title>`, max-width, gutters.
- `Section({ heading?, rule?: boolean, updatedAt?: string, children })` — heading at `--text-lg` with optional `--rule` and the `updated N min ago` label.
- `ThemeToggle()` — reads/writes `localStorage['resumearena.theme']` and `html[data-theme]`.
- `Footer({ sha })`.
- `UpdatedAgo({ at: string })` — the mono relative label, re-rendered every 30 s.

**Rating and numbers**

- `RatingDisplay({ rating: number | null, rd: number | null, tier: TierKey | null, provisional?: { done: number, total: number }, delta7d?: number, size?: 'lg' | 'md' | 'sm', revealOnce?: string })` — `revealOnce` is the result id; when set and not in `localStorage.revealed`, runs the wipe (§4.5).
- `TierLabel({ tier: TierKey, numeral?: boolean, withBlurb?: boolean })` — word in serif, numeral in mono, optional tooltip.
- `Num({ value: number, kind?: 'int' | 'rating' | 'rank' | 'delta' | 'pct' | 'rd' | 'usd', className? })` — the single formatter component; see §5.2.
- `Outcome({ value: 'W' | 'L' | 'D' })` — coloured mono letter with `aria-label`.
- `Record({ w: number, l: number, d: number })` — `21-15-2`.
- `Sparkline({ points: { at: string, rating: number }[], width?: number, height?: number })` — inline SVG; renders nothing under 3 points.
- `RankTable({ ratings: RatingView[], primary: Category, focusLinkFor: (r: RatingView) => string })` — `—  after placement` / `—  not rated` rows per §3.3.
- `ScoreBars({ rows: SubScoreView[], weightLabel?: string, showMedianNote?: boolean, expandable?: boolean })` and `ScoreBarRow`.
- `StatLine({ items: { label: string, value: number | string }[] })`.

**Tables and lists**

- `LeaderboardTable({ rows: LadderRow[], mode: 'compact' | 'full', focusId?: string, loading?: boolean, rankOffset?: number })`.
- `LadderFilters({ value: { stage, q }, onChange, canFindMe: boolean, onFindMe })`.
- `Cursor({ page: number, pages: number, total: number, pageSize: number, onPage(n), onJumpToRank(rank) })` — numbered, because pages are files.
- `YouAreHereRow({ row: LadderRow, onJump })` — sticky strip.
- `MatchList({ matches: MatchView[], limit?: number, moreHref?: string, total?: number })`.
- `RatingHistoryTable({ events: RatingEvent[], pageSize?: number })` — client-side paging.
- `Chip({ children, variant?: 'default' | 'warn' | 'provisional', title? })`.

**Upload (client-side ingestion)**

- `StepRail({ step: 1 | 2 | 3 | 4, reachable: number, onStep(n) })`.
- `FileDropzone({ onText(result: ExtractResult), accept: string[], maxBytes: number, disabled?, disabledReason? })` — owns the worker: on file it posts to `workers/extract.ts`, renders the `reading` state with a page-progress bar, and calls `onText({ text, metrics, source: 'pdf' | 'docx' })`. Errors from §1.5 render inside the zone with **Choose another**. Nothing leaves the browser; the component has no network code path by construction (lint rule: no `fetch` import in `components/upload/*`).
- `PasteBox({ onText(result: ExtractResult) })` — textarea; emits `{ text, metrics: pastedMetrics(text), source: 'paste' }`.
- `RedactionPreview({ value: string, onChange(text), removed: Redaction[], onRemovedChange(items), metrics: LayoutMetrics, limits: { min: 400, max: 15000 } })` — the editable textarea, counter, **Redact selection**, `MetricsLine`, `PublicNotice`, and the composed `RedactionPanel`. Calls `redact()` from `packages/shared` on mount only; subsequent edits are the user's.
- `RedactionPanel({ items: Redaction[], onRestoreName?() })` — grouped list; the only restorable item is the name guess.
- `MetricsLine({ metrics: LayoutMetrics })`.
- `PublicNotice()` — the fixed public-text sentence; no props, so nobody rewrites it per page.
- `HandleField({ value, onChange, status: 'idle' | 'checking' | 'available' | 'taken' | 'reserved' | 'invalid' | 'yours', onStatus })` — runs the reserved list, the regex, and the `u/<handle>.json` probe with a 400 ms debounce.
- `KeyReveal({ handle: string, keyString: string, saved: boolean, onSaved(bool) })` — the key in mono with `user-select: all`, **Copy key** → **Copied**, **Save as file** (Blob download), the checkbox, the storage note.
- `SubmitSummary({ handle, ladderHint, visibility, chars })` — the mono line.
- `FallbackPanel({ payload: SubmitPayload, reason: 'missing' | 'revoked' | 'refused', onOpened(): void })` — copies the text, builds the prefilled Issue Form URL, opens it, reports back.

**Pending and result**

- `PollingStatus({ id: string, mode: 'submitter' | 'visitor', via: 'dispatch' | 'issue', submittedAt: string, onPhase(phase: Phase, view: ResultView | null) })` — the state machine in §4.10; renders the step list (full) or the single current row (`compact` prop) and the fixed "We will keep checking" line. Two sources: `getJson('r/<id>.json', { fresh: true })` and, in `submitter` mode with `via: 'dispatch'`, the GitHub runs API matched on `display_title === 'submit <id>'`.
- `Verdict({ text })`.
- `StrengthsWeaknesses({ strengths: string[], weaknesses: string[] })`.
- `AtsPanel({ score: number, summary: string, fixes: AtsFix[], factors: SubScoreView[] })`.
- `RedFlags({ flags: RedFlag[] })` — renders only medium and high.
- `SubmittedText({ text: string, metrics: LayoutMetrics, isOwner: boolean })` — the `<details>` block.
- `ShareButton({ url, pendingHint?: boolean })`.
- `ManageLink({ handle })` — the quiet header link, rendered by the identity provider only when the hash matches.

**Arena**

- `ArenaCard({ side: 'A' | 'B', card: Card, chosen?: boolean, dimmed?: boolean, onPick, hotkey: string })`.
- `JudgeReveal({ pair: ArenaPair, guess: 'A' | 'B' | 'draw' })` — winner line, reason, the rating movements, the identities, agree/disagree line.
- `StreakCounter({ streak: number, guesses: number, agreedPct?: number })` — local only.
- `CategoryPicker({ value, onChange })`.

**Manage**

- `KeyInput({ onKey(key: OwnerKey, handle: string) })` — paste field, handle field, **Use this key**, parse and hash errors.
- `EntrySummary({ profile: ProfileView, result: ResultView | null })`.
- `VisibilityControl({ handle, value: 'anonymous' | 'handle', onDispatch(next) , pending?: { since: string } })`.
- `DeleteEntry({ handle, id, onDispatch, fallbackAvailable: boolean })` — opens `ConfirmDialog` with the copy from §3.7.
- `DeviceKeys({ handles: string[], onForget(handle), onShow(handle) })`.

**About**

- `StatusBlock({ status: Status | null, channel: 'open' | 'down' | 'checking' })` — the mono table (§4.14).

**Forms and feedback**

- `Button({ variant: 'primary' | 'secondary' | 'quiet' | 'destructive', size?: 'md' | 'sm', disabled?, disabledReason?, type?, onClick, children })`.
- `TextField({ label, value, onChange, helper?, error?, type?, autoComplete?, maxLength?, mono?, placeholder? })`.
- `SelectField({ label, value, options: { value, label }[], onChange, helper? })`.
- `RadioRow({ legend, value, options, onChange, helper? })`.
- `Toggle({ label, checked, onChange, helper?, disabled?, disabledReason? })`.
- `Checkbox({ label, checked, onChange })` — used once, in `KeyReveal`.
- `Toast` via `useToast(): { show(message, { error?: boolean }) }`.
- `ConfirmDialog({ open, title, body, confirmLabel, confirmMatch?: string, destructive?, onConfirm, onCancel, extra?: ReactNode })`.
- `Skeleton({ width, height })` — a `--bg-3` block.
- `EmptyState({ title, body, action? })`.
- `ErrorState({ title, body, retry?, extra?: ReactNode })`.

**Hooks and libs** (`web/src/lib/`)

- `useIdentity(): { keys: Record<handle, OwnerKey>, entries: Record<id, EntryRecord>, isOwnerOf(ownerHash: string): handle | null, remember(handle, key), forget(handle), recordEntry(id, rec) }` — the `localStorage` facade (§6.4), with `storage` events so two tabs agree.
- `useData<T>(path, { fresh?, every?: ms })` — `getJson` with visibility-aware polling.
- `github.ts`: `dispatchSubmit(payload)`, `dispatchManage(payload)`, `preflight()`, `findRun(id, since)`, `issueFormUrl(kind, fields)`; the token is `import.meta.env.VITE_GH_DISPATCH_TOKEN` and nothing else reads it.
- `format.ts` (§5.2), `redact` and `ownerKey` re-exported from `@resumearena/shared`.

### 5.2 Shared formatting rules (`src/lib/format.ts`)

All numbers in data positions use `font-variant-numeric: tabular-nums` and the mono face. Prose numbers ("about a minute") are serif.

| Kind | Rule | Examples |
| --- | --- | --- |
| rating | integer, no separator | `1642` |
| rd (±) | `±` U+00B1 then integer, no space between | `±38` |
| rating with rd | rating, thin space U+2009, ±rd | `1642 ±38` |
| rank | `#` then integer with locale grouping | `#1,204` |
| delta | sign always; minus is U+2212, not hyphen; zero is `0` with no sign in `--draw` | `+12`, `−7`, `0` |
| record | `W-L-D` with ASCII hyphens, no spaces | `21-15-2` |
| percentile | "top X%": one decimal below 10, integer at 10 and above, floor `top 0.1%`; above 50 shows `bottom (100−X)%` only on the owner's own page, otherwise `top 61%` | `top 3.2%`, `top 24%`, `top 0.1%` |
| percent (agreement) | integer, `%` attached | `72%` |
| large counts | locale grouping; above 1,000,000 use `2.1M` | `124,318`, `2.1M` |
| dates | `3 Oct 2026` in tables and headers; relative under 7 days in match lists (`2 h ago`, `yesterday`, `4 d ago`), with the absolute date in `title` | |
| times | 24-hour with the viewer's zone in rate-limit copy | `Friday at 09:00` |
| durations | elapsed stage timer `0:42`; prose uses words | |
| ids | lowercase base32, prefixed: `anon-k7q2m`, result ids 10 chars | |
| file sizes | `412 KB`, `1.3 MB` (binary → decimal rounded to 1 decimal) | |
| ranges | en dash, no spaces | `1200–1399` |

`Num` is the only component that renders these; pages never format numbers inline.

### 5.3 Percentile and rank source

Percentile = `rank / total` on the "any stage" ladder for that category, computed by the deploy's index builder and written into both the ladder pages and each `r/<id>.json`. The UI never divides. Ranks on a stage-filtered page come from the stage directory's own numbering; the index carries both so "find me" works under a filter.

Additional formatting rows for this version (extend the table in §5.2):

| Kind | Rule | Examples |
| --- | --- | --- |
| owner key | `rak-` then 13 groups of 4 lowercase base32 chars, hyphen-separated; mono; `user-select: all` | `rak-k7q2-m9x3-…` |
| result id | 10 lowercase base32 chars, mono | `k7q2m9x3ab` |
| updated-ago | `updated just now` under 45 s, `updated 4 min ago` under 60 min, `updated 2 h ago` under 24 h, then the absolute `3 Oct 14:31 UTC` | |
| elapsed | `0:42` mono, ticking each second, for the current pipeline row | |
| clock times in pipeline copy | 24-hour, the viewer's zone, no seconds; UTC only in the status block and budget copy, labelled | `14:21`, `00:00 UTC` |
| usd | `$18.40`, two decimals, `$` attached | |

---

## 6. Identity without accounts

### 6.1 Decision

Nobody signs in and nobody verifies anything. An entry belongs to whoever holds its owner key. The browser generates the key, keeps it, and shows it once; the site stores only its SHA-256 fingerprint. Later actions present the raw key to the workflow, which hashes it and compares.

Tradeoff in two lines: an account would give password resets, a per-person quota, and a cleaner duplicate story; it would also need a vendor, an email, and a sign-in page in front of the dropzone, all three of which the platform forbids. A key costs one honest sentence ("lose it and nobody can give it back") and buys a submission flow with no gate at all.

What a key controls: visibility of the handle, resubmission under the handle, deletion. What it does not control: whether the text is public (it always is), whether the entry is rated (it always is, once it passes the gate).

### 6.2 The key (`packages/shared/src/ownerKey.ts`)

```ts
export type OwnerKey = string & { readonly __brand: 'OwnerKey' };   // canonical: 52 chars of [a-z2-7]

export function generateOwnerKey(): OwnerKey;          // 32 bytes from crypto.getRandomValues → RFC 4648 base32, lowercase, no padding → 52 chars
export function formatOwnerKey(key: OwnerKey): string;  // 'rak-' + 13 groups of 4 joined by '-'
export function parseOwnerKey(input: string): OwnerKey | null;  // strips 'rak-'/'rak', whitespace, hyphens; lowercases; must match /^[a-z2-7]{52}$/
export async function hashOwnerKey(key: OwnerKey): Promise<string>; // hex SHA-256 of the UTF-8 canonical string (WebCrypto in the browser, node:crypto in the engine) → 64 hex chars = owner_hash
```

Rules:

- Entropy is 256 bits; the hash is of the canonical string, not the bytes, so both sides agree without a decoder.
- The display form is 56 characters wide with the prefix; it wraps at hyphens. The prefix makes a key recognisable in a notes app and lets `parseOwnerKey` reject a pasted result id or handle with a specific message.
- Keys never appear in URLs, never in the result file, never in a toast, never in analytics (there are none).
- The raw key travels only in a `manage` or resubmit dispatch, as a `workflow_dispatch` input. The workflow masks it (`::add-mask::`) before any step logs; the platform doc owns the rest of that threat model.

### 6.3 Handles (`packages/shared/src/handles.ts`)

```ts
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;   // 3–20, no hyphen at the ends
export const RESERVED = new Set(['about', 'arena', 'me', 'upload', 'leaderboard', 'r', 'u', 'anon', 'anonymous', 'admin', 'resumearena', 'status', 'data', 'api', 'github', 'noah']);
export function validateHandle(h: string): 'ok' | 'invalid' | 'reserved';  // also rejects /^anon-/
```

- One entry per handle at a time. A handle is registered by the first submission workflow that writes `users/<handle>.json`; the browser's availability check is advisory and the `handle_taken` rejection (§1.5) covers the race.
- Resubmission under a handle requires the raw key and supersedes the previous entry (the ranking doc's revision flow). The old `resumes/<id>.json` becomes `status: 'superseded'` with a pointer; its link redirects client-side to the new result ("This entry was resubmitted. Showing the current version.").
- Deletion frees the handle. A freed handle can be taken by anyone; the old key is useless.
- Anonymous display: the entry still has a handle (it is how the owner finds it); the ladders and result page show `anon-` + the first 5 base32 chars of `sha256('anon:' + id)`, computed by the engine and written into the files, never by the client.

### 6.4 What the browser keeps (`localStorage`, all under the `resumearena.` prefix)

| Key | Shape | Purpose |
| --- | --- | --- |
| `resumearena.theme` | `'paper' \| 'night'` | §2.4 |
| `resumearena.keys` | `{ [handle]: OwnerKey }` | the keys this browser holds |
| `resumearena.entries` | `{ [id]: { handle, submittedAt, via: 'dispatch' \| 'issue' } }` | ids this browser submitted, for the pending page and "find me" |
| `resumearena.revealed` | `{ [id]: true }` | the one-time reveal |
| `resumearena.arena` | `{ streak, best, guesses, agreed, seen: string[], lastCategory }` | §3.5 |
| `sessionStorage['resumearena.draft']` | `{ text, removed, metrics, source, handle?, ladderHint?, visibility? }` | survives a reload mid-upload and the "Back to the text" from a rejection |

Every read is wrapped: a private window, cleared site data, or a blocked storage API yields an empty identity and the site still works for reading. The identity provider listens to `storage` events so a key pasted in one tab appears in another.

### 6.5 The flow

```
visitor on /            → "Upload a resume"
  → /upload step i      → file or paste; extraction in a worker
  → step ii             → redaction preview; the public sentence; edit
  → step iii            → handle (checked against u/<handle>.json), ladder hint, visibility
  → step iv             → key generated, shown, copied, confirmed → dispatch (or fallback)
  → /r/:id              → pending: runs API + file poll → analysed (3–6 min) → rated (+5–15 min), reveal
later, same device      → "Your entry" in the nav → /me → toggle / resubmit / delete with the stored key
later, new device       → /me → paste key + handle → same controls; the key is remembered there too
```

### 6.6 A new device, a lost key, a shared computer

- **New device**: `/me`, paste the key and the handle. The page explains this in its empty state. The same key works on any number of devices; there is no "sign out" because there is no session, only **Forget this key on this device**.
- **Lost key**: nothing can be done for that entry. The copy on `/me` is plain: "Without the key the entry cannot be changed or deleted. It will keep being rated. You can submit again under a new handle." This is stated at key-reveal time too ("the only way"), which is why the checkbox exists. The owner may, out of band, handle a deletion request sent to the contact address with proof that is not the key (that is a human process, not a feature).
- **Shared computer**: the key sits in `localStorage` until forgotten. Step iv says so ("It also stays in this browser's storage"); `/me` has the forget button; neither nags.
- **Resubmitting from a device without the key** is impossible by design; `/upload` with that handle shows "That handle is taken." and the person either pastes the key on `/me` first or picks another handle.

---

## 7. Mobile layout notes

Breakpoints: `< 640` phone, `640–1023` tablet, `≥ 1024` desktop. Mobile-first CSS. 16 px minimum gutter. No horizontal page scroll anywhere; tables scroll inside their own container when they must.

- **Nav**: wordmark left, "Upload" primary button (shortened label) right, and a "Menu" quiet button that opens a full-width disclosure listing Ladders (four links indented), Arena, About, theme, and "Your entry" when a key exists. No hamburger glyph; the word "Menu".
- **Landing**: single column. Order: h1, two-line subhead, CTA (primary full width, "Browse the ladders" as a quiet link beneath), the "your entry" line when present, the compact top-10 table with three columns (#, identity, rating; tier is dropped), the stat line, how-it-works, arena teaser.
- **Upload, step i**: the dropzone becomes a 56 px tall button **Choose a file** with the constraints line beneath; the native picker on iOS shows Files, which is where most people's PDFs are. "Paste text instead" stays beneath it. The `StepRail` compresses to `1 · 2 · 3 · 4` with the current step's word.
- **Upload, step ii**: one column. Order: the warning (if poor), a collapsed `RedactionPanel` as a `<details>` headed `Removed (6)` (open by default when the name guess fired, so "Not a name" is one tap away), the textarea at `min-height: 50vh`, the counter pinned to the textarea's top-right, **Redact selection** beneath, the metrics line, the public notice, then a sticky bottom bar above the safe area with **Use this text** full width and "Choose another file" as a quiet link beneath it. The textarea gets `font-size: 16px` on touch devices so iOS does not zoom.
- **Upload, step iii**: unchanged; radio chips wrap to two rows; **Continue** sticky to the bottom edge.
- **Upload, step iv**: the key wraps to 4 lines at hyphens; **Copy key** full width above **Save as file**; the checkbox has a 44 px tap target; **Submit for rating** sticky to the bottom once the checkbox is on. The fallback panel's button opens the Issue Form in the same tab (new tabs on mobile lose the page); the entry is recorded before navigation so returning to `/r/:id` works.
- **Pending**: single column; the step list keeps its squares; secondary lines wrap; the share button moves under the heading as a full-width secondary.
- **Result**: single column in this order: identity line, rating block (rating at the `clamp` floor 2.75rem, ± on the same line, tier beneath, delta), rank table as a 2×2 grid of small blocks (category, rank, percentile in each), sparkline full width at 48 px tall, verdict, breakdown (bar table keeps all four columns; the name column wraps; weight column hidden under 400 px), strengths then weaknesses stacked, ATS, red flags, recent matches as stacked rows (outcome letter and opponent on line one, delta right-aligned, judge note on line two), text as submitted (closed), manage link, footer sentence. The reveal still runs.
- **Ladder**: the table has a fixed first column (#) and a horizontally scrolling body inside a container with a 1 px rule on the right edge as the affordance; columns shown on phone: #, identity, rating, ± (tier, record, stage, signal appear with scroll; `7d` hidden). Filters collapse to one row: a "Filters" quiet button opening an inline panel with stage and search; "find me" becomes a full-width secondary button under the header when applicable. The `YouAreHereRow` sticks to the bottom above the safe area. Page controls are two buttons "newer" "older" with `page 12 of 125` between them; the page input moves into the filters panel.
- **Arena**: cards stack vertically, A above B, each capped at 40 vh with internal scroll when the card is long; the two pick buttons move out of the cards into a sticky bottom bar (`A | Too close | B`) so the thumb never travels; keyboard hints are hidden; the reveal inserts between the bar and the cards and scrolls into view. Streak and category move into a single line under the heading.
- **Profile**: single column; rank table as the 2×2 grid; history table scrolls horizontally.
- **Manage**: single column; each section separated by a hairline; the key paste field is `font-size: 16px` mono with `autocapitalize="off" autocorrect="off" spellcheck="false"`; the dialog is a bottom sheet.
- **About**: prose; headings become a horizontally scrolling anchor row under the title; the status block's two-column table keeps its mono alignment at 13 px.
- **Inputs**: 44 px tall on touch devices (`@media (pointer: coarse)` raises the control height token from 36 to 44 everywhere).
- **Toast**: top-centre under the nav, full width minus gutters.
- **Dialog**: full-width sheet pinned to the bottom with the same content; still a native `<dialog>`.

---

## 8. Interfaces this doc expects from other docs

Named so the platform and engine docs can match them exactly. All JSON is written by the engine (`engine/`) or the deploy's index builder; the SPA only reads. Types live in `packages/shared/src/types.ts`.

### 8.1 Static files in the Pages artifact (`/resumearena/data/…`)

| Path | Written by | Shape |
| --- | --- | --- |
| `config.json` | deploy | `{ tiers: { key, label, numeral, min, blurb }[], limits: { min_chars: 400, max_chars: 15000, max_file_bytes: 10485760 }, categories: Category[], provisional_rd: number, versions: { prompt, judge, schema, taxonomy } }` |
| `status.json` | rerank (copied by deploy) | `Status` (§8.4) |
| `ladders/<cat>/index.json`, `page-<nnnn>.json`, `stage-<stage>/page-<nnnn>.json`, `top.json` | deploy | §3.4 |
| `handles/<c>.json` | deploy | `[handle_or_anon, id, rank_general][]` |
| `r/<id>.json` | deploy, from `resumes/<id>.json` + ratings + matches on the `data` branch | `ResultView` (§8.3) |
| `r/<id>/matches.json` | deploy | `MatchView[]` (all) |
| `u/<handle>.json`, `u/<handle>/history.json` | deploy | `ProfileView`, `RatingEvent[]` |
| `arena/<cat>/index.json`, `shard-<nn>.json` | deploy | §3.5 |

Rejected and queued entries also get an `r/<id>.json` (small: `status`, `reason`, timestamps, no text) so the pending page can explain itself. Deleted entries keep a tombstone `{ id, status: 'deleted', deleted_at }`.

### 8.2 Write payloads (`workflow_dispatch` inputs; the Issue Forms carry the same field ids)

```ts
export type SubmitPayload = {
  kind: 'submit';
  id: string;                 // ^[a-z2-7]{10}$, chosen by the browser
  handle: string;             // HANDLE_RE
  owner_hash: string;         // 64 hex
  owner_key?: string;         // resubmission only: raw canonical key; the workflow verifies sha256(owner_key) === users/<handle>.owner_hash
  text: string;               // 400–15000 chars, post-redaction, NFC, \n line endings
  meta: string;               // JSON.stringify(SubmitMeta)
};
export type SubmitMeta = {
  ladder_hint: Category;
  visibility: 'anonymous' | 'handle';
  metrics: LayoutMetrics;
  client: { version: string; parser: 'pdfjs' | 'mammoth' | 'paste'; redactions: Record<RedactionKind, number> };
};
export type ManagePayload = {
  kind: 'manage';
  id: string;                 // current resume id under the handle
  handle: string;
  owner_key: string;          // raw canonical key
  action: 'set_visibility' | 'delete';
  value?: 'anonymous' | 'handle';
};
```

Every value is a string on the wire (GitHub's constraint); `meta` is JSON inside a string. Ten inputs maximum and roughly 64 KB per dispatch is GitHub's limit, which with 15,000 characters of text leaves comfortable room. The workflow sets `run-name: ${{ inputs.kind }} ${{ inputs.id }}` so the pending page can find its run by `display_title`.

Issue Forms: `.github/ISSUE_TEMPLATE/submit.yml` (fields `id`, `handle`, `owner_hash`, `meta`, `text`; label `submission`) and `delete.yml` (fields `id`, `handle`, `owner_key`; label `manage`). The adapter in the engine parses either source into the same payload type; the workflow comments on the issue with the result link and closes it.

### 8.3 `LayoutMetrics`, `Redaction`, `ResultView`

```ts
export type LayoutMetrics = {
  source: 'pdf' | 'docx' | 'paste';
  pages: number | null;            // null for paste/docx
  columns: 1 | 2 | 3 | null;       // from x-clustering of text runs per page; null when unknown
  fonts: number | null;            // distinct font names in the text layer
  images: number | null;           // image XObjects / inline images counted
  chars: number;                   // after redaction
  words: number;
  extraction_quality: 'good' | 'fair' | 'poor' | null;  // chars per page < 300 or replacement-char ratio > 2% → poor; reading-order breaks → fair
};
export type RedactionKind = 'name' | 'email' | 'phone' | 'link' | 'address' | 'manual';
export type Redaction = { kind: RedactionKind; original: string; token: string; index: number };

export type ResultView = {
  id: string;
  status: 'queued' | 'analysed' | 'rated' | 'rejected' | 'superseded' | 'deleted';
  reason?: 'not_a_resume' | 'spam' | 'injection' | 'too_short' | 'handle_taken' | 'duplicate' | 'bad_payload';
  superseded_by?: string;
  identity: { kind: 'handle' | 'anon'; value: string };
  owner_hash: string;
  submitted_at: string; analysed_at?: string; rated_at?: string;
  ladder_hint: Category;
  career_stage?: Stage;
  metrics: LayoutMetrics;
  text?: string;                   // the public text as submitted (absent on rejected/deleted)
  versions?: { prompt: string; schema: string; model: string };
  analysis?: {
    verdict: string;
    headline: string;              // card headline; also the ladder's top_signal source
    subscores: SubScoreView[];     // pedigree, trajectory, impact, selectivity, breadth, with weight for ladder_hint and median for ladder_hint
    stage_relative: number;
    category_scores: { category: Category; score: number | null; included: boolean }[];
    strengths: string[]; weaknesses: string[];
    ats: { score: number; summary: string; factors: SubScoreView[]; fixes: { priority: number; factor: string; issue: string; fix: string }[] };
    red_flags: { type: string; severity: 'low' | 'medium' | 'high'; note: string }[];
    card: Card;                    // rubric doc §2.3
  };
  ratings?: RatingView[];
  matches?: MatchView[];           // last 8
  matches_total: number;
  last_action?: { action: string; at: string; result: 'applied' | 'rejected_key' };
};
export type SubScoreView = { key: string; label: string; score: number; weight?: number; median?: number | null; note?: string };
export type RatingView = {
  category: Category; rating: number; rd: number; tier: TierKey; provisional: boolean;
  placement: { done: number; total: number };
  rank: number | null; total: number; percentile: number | null; page: number | null;
  delta_7d: number | null; record: { w: number; l: number; d: number };
  history: { at: string; rating: number }[];   // last 40
};
export type MatchView = { id: string; category: Category; outcome: 'W' | 'L' | 'D'; opponent: { id: string; identity: ResultView['identity']; rating: number; tier: TierKey } | { deleted: true }; delta: number; judge_note: string; at: string };
export type LadderRow = { id: string; rank: number; identity: ResultView['identity']; tier: TierKey; rating: number; rd: number; w: number; l: number; d: number; stage: Stage; top_signal: string; delta_7d: number | null };
export type ProfileView = { handle: string; owner_hash: string; resume_id: string; visibility: 'anonymous' | 'handle'; entered_at: string; versions: number; ratings: RatingView[] };
```

### 8.4 `Status` and the Arena pair

```ts
export type Status = {
  generated_at: string;
  queue: { awaiting_analysis: number; awaiting_placement: number };
  spend_today_usd: number; daily_budget_usd: number; budget_day: string;   // 'YYYY-MM-DD' UTC
  last_rerank: { at: string; matches: number; placed: number } | null;
  last_deploy: { at: string; sha: string };
  totals: { resumes_rated: number; matches: number };
};
export type ArenaPair = {
  match_id: string; category: Category; at: string;
  a: { id: string; card: Card; rating_before: number; tier: TierKey; identity: ResultView['identity'] };
  b: { id: string; card: Card; rating_before: number; tier: TierKey; identity: ResultView['identity'] };
  verdict: 'A' | 'B' | 'draw'; reason: string; deltas: { a: number; b: number };
};
```

### 8.5 GitHub endpoints the SPA touches (and nothing else)

| Call | Auth | When |
| --- | --- | --- |
| `GET /repos/noahfinkelstein/resumearena/actions/workflows/submit.yml` | build-time token | preflight on step iv mount and on `/about` (channel probe) |
| `POST /repos/noahfinkelstein/resumearena/actions/workflows/submit.yml/dispatches` body `{ ref: 'main', inputs }` | build-time token | submit, resubmit |
| `POST /repos/noahfinkelstein/resumearena/actions/workflows/manage.yml/dispatches` | build-time token | visibility, delete |
| `GET /repos/noahfinkelstein/resumearena/actions/workflows/submit.yml/runs?event=workflow_dispatch&per_page=30&created=>=<iso>` | build-time token when present, else none | pending page, every 30 s, submitter mode only |
| `https://github.com/noahfinkelstein/resumearena/issues/new?template=…` (navigation, not fetch) | the person's GitHub session | fallback |

---

## 9. Open questions for the owner

1. The name heuristic (first line, 2–4 title-case words) will mis-fire on resumes that open with a title ("Senior Software Engineer") and miss names in all caps. Ship with the "Not a name" undo and accept it, or also ask "Is this your name?" as a one-field confirm before step ii?
2. Showing the submitted text on the result page (§3.3 item 10): keep it (receipts; it is public anyway) or hide it behind the repository link only? This doc keeps it.
3. Pending page status via the GitHub runs API: it spends the public token's rate limit on reads. Keep it (honest "queued / running" rows) or poll the result file only (one fewer dependency, vaguer copy)? This doc keeps it with a 30 s cadence and a 20-minute cap.
4. Should resubmission be allowed from the Issue Form fallback at all, given it posts the raw key publicly? This doc says no; only deletion has a fallback.
5. "Laureate" as the top tier name stays from v1; confirm, or rename before anything is rated.
6. The weekly history rewrite of the `data` branch to purge deleted texts (§3.8 Privacy) is a platform-doc decision; the About copy promises "up to a week". Confirm the cadence or change the sentence.

---

## 10. Copy deck

Every user-facing string on the upload page and the pending/result page, verbatim, keyed for `web/src/copy/upload.ts` and `web/src/copy/result.ts`. Interpolations are in braces. Buttons are listed with their disabled reasons where one exists.

### 10.1 Upload page

**Chrome**

- `upload.title`: `Upload a resume`
- `upload.lead`: `A PDF, a Word file, or pasted text. Everything up to the submit button happens in this browser.`
- `upload.rail.1`: `File` · `upload.rail.2`: `Preview` · `upload.rail.3`: `Details` · `upload.rail.4`: `Submit`
- `upload.leave.guard`: `The text you prepared will be lost if you leave. Leave anyway?`

**Step i: File**

- `dropzone.idle`: `Drop a PDF or DOCX here, or choose a file.`
- `dropzone.constraints`: `PDF or DOCX · up to 10 MB · 1–3 pages works best`
- `dropzone.dragover`: `Release to read it.`
- `dropzone.mobile`: `Choose a file`
- `dropzone.reading`: `Reading {filename}.`
- `dropzone.reading.secondary`: `Extracting text and layout. Nothing is uploaded.`
- `dropzone.chooseAnother`: `Choose another`
- `paste.switch`: `Paste text instead`
- `paste.placeholder`: `Paste the resume text here.`
- `paste.helper`: `Pasted text has no layout, so layout metrics will be blank.`
- `paste.use`: `Use this text`
- `paste.switchBack`: `Choose a file instead`
- `error.file.type.title`: `That is not a PDF or DOCX.`
- `error.file.type.body`: `Export it as a PDF, or paste the text.`
- `error.file.size.title`: `The file is over 10 MB.`
- `error.file.size.body`: `Resume files are usually under 500 KB. Re-export without embedded images, or paste the text.`
- `error.file.noText.title`: `No readable text in this file.`
- `error.file.noText.body`: `It is probably a scan. Export from the original document, or paste the text; scanned resumes also fail most applicant-tracking systems.`
- `error.file.unreadable.title`: `Could not read the file.`
- `error.file.unreadable.body`: `It may be encrypted or damaged. Re-export it, or paste the text.`

**Step ii: Preview**

- `preview.heading`: `Check what will be public`
- `preview.lead`: `We removed what looked like contact details. Read it once; fix anything the extraction got wrong.`
- `preview.textarea.label`: `Text to be submitted`
- `preview.counter`: `{chars} / 15,000`
- `preview.over`: `Over the limit by {n} characters. Trim it here.`
- `preview.under`: `Fewer than 400 characters. Paste or upload more.`
- `preview.redactSelection`: `Redact selection`
- `preview.redactSelection.title`: `Replaces the selected text with [redacted]`
- `preview.warning.poor.title`: `The extraction looks poor.`
- `preview.warning.poor.body`: `Columns or tables came out in the wrong order. Fix the order here, or paste the text from the original document.`
- `metrics.line`: `{pages} pages · {columns} column · {fonts} fonts · {images} images · {chars} characters · extraction {quality}` (singular forms `1 page`, `1 font`, `1 image`; `columns` is always followed by `column`/`columns`)
- `metrics.line.paste`: `pasted · {chars} characters`
- `metrics.line.docx`: `Word file · {chars} characters`
- `metrics.helper`: `Layout metrics go to the analysis as numbers; the file does not.`
- `public.notice`: `Exactly this text becomes public, attached to your handle or an anonymous id, in a public GitHub repository anyone can read. The original file never leaves this browser.`
- `public.wry`: `Recruiters read this part too. Now you know how it feels.`
- `removed.heading`: `Removed`
- `removed.heading.count` (mobile summary): `Removed ({n})`
- `removed.kind.name`: `Name, from the first line`
- `removed.kind.email`: `Email` · `removed.kind.emails`: `Emails ({n})`
- `removed.kind.phone`: `Phone` · `removed.kind.phones`: `Phones ({n})`
- `removed.kind.link`: `Link` · `removed.kind.links`: `Links ({n})`
- `removed.kind.address`: `Address` · `removed.kind.addresses`: `Addresses ({n})`
- `removed.kind.manual`: `Redacted by you` · `removed.kind.manuals`: `Redacted by you ({n})`
- `removed.notAName`: `Not a name`
- `removed.empty`: `Nothing matched. Check the text for a name, email, or phone.`
- `removed.footnote`: `Removal is by pattern and can miss things. The text is yours to edit.`
- `preview.use`: `Use this text`
- `preview.use.disabled.over`: `Trim the text to 15,000 characters first`
- `preview.use.disabled.under`: `Add at least 400 characters first`
- `preview.chooseAnother`: `Choose another file`
- `preview.back`: `Back`

**Step iii: Details**

- `details.heading`: `Handle and ladder`
- `handle.label`: `Handle`
- `handle.placeholder`: `e.g. priya-n`
- `handle.helper`: `3 to 20 characters: lowercase letters, numbers, hyphens. It is how the entry appears when you choose not to be anonymous, and how you find it again.`
- `handle.checking`: `Checking.`
- `handle.available`: `Available.`
- `handle.taken`: `That handle is taken.`
- `handle.reserved`: `That handle is reserved.`
- `handle.invalid`: `Handles are lowercase letters, numbers, and hyphens, 3 to 20 characters, no hyphen at the ends.`
- `handle.yours`: `You hold the key for this handle. Submitting replaces your current entry; its rating carries over as the starting estimate.`
- `ladder.legend`: `Which ladder is this mainly for?`
- `ladder.general`: `General` · `ladder.finance`: `Finance` · `ladder.tech`: `Tech` · `ladder.academia`: `Academia`
- `ladder.helper`: `It is rated on every ladder it qualifies for. This one decides where placement starts.`
- `visibility.label`: `Show my handle on the ladders`
- `visibility.helper`: `Off means you appear as an anonymous id, like anon-k7q2m. You can change this later with your key.`
- `consent.line`: `By continuing you confirm this is your own resume. The text is analysed by Claude, a model from Anthropic, through its API, and is public as shown in the previous step.`
- `details.continue`: `Continue`
- `details.continue.disabled`: `Choose an available handle`
- `details.back`: `Back`

**Step iv: Submit**

- `key.heading`: `Your owner key`
- `key.lead`: `This key is the only way to change or delete your entry. It is made in this browser and shown once. We store only its fingerprint.`
- `key.copy`: `Copy key` · `key.copied`: `Copied`
- `key.save`: `Save as file`
- `key.file.contents`: `ResumeArena owner key for {handle}\n{key}\nKeep this. It is the only way to change or delete your entry at https://noahfinkelstein.github.io/resumearena/me`
- `key.saved.checkbox`: `I have saved the key somewhere I will find it.`
- `key.storage.note`: `It also stays in this browser's storage, which clears if you clear site data or switch devices.`
- `resubmit.heading`: `Resubmitting as {handle}`
- `resubmit.lead`: `Your key for {handle} is in this browser. Submitting replaces the current entry; the rating carries over as the starting estimate and the old text is removed.`
- `summary.line`: `{handle} · {ladder} · {visibility} · {chars} characters` (`visibility` renders `anonymous` or `handle shown`)
- `submit.button`: `Submit for rating`
- `submit.button.disabled`: `Confirm you saved the key first`
- `submit.sending`: `Sending.`
- `error.submit.channel.title`: `The direct channel is down.`
- `error.submit.channel.body`: `The token that lets this page start the workflow is missing or revoked. The fallback is a GitHub issue form carrying the same fields; it needs a GitHub account, which the direct channel does not. The text is copied to your clipboard; paste it into the field called Resume text.`
- `fallback.open`: `Copy text and open the form`
- `fallback.retry`: `Try the direct channel again`
- `fallback.note`: `Needs a GitHub account. The form has the same fields; the workflow treats both the same.`
- `fallback.opened`: `Opened. Once you submit the issue, this page checks for the result.`
- `error.submit.rateLimited.title`: `GitHub is rate limiting submissions.`
- `error.submit.rateLimited.body`: `Wait a minute and try again. Nothing was sent.`
- `error.submit.refused.title`: `GitHub refused the request.`
- `error.submit.refused.body`: `Try again in a minute. If it keeps failing, use the fallback below.`
- `error.submit.network.title`: `Lost the connection.`
- `error.submit.network.body`: `Nothing was sent. Try again when you are back online.`

### 10.2 Pending and result page

**Header and fixed lines**

- `result.title.pending`: `Submitted`
- `result.identity`: `{identity} · {ladder} · submitted {time}` (pending) / `{identity} · {ladder}, {stage} · submitted {date}` (analysed, rated)
- `result.share`: `Copy link`
- `result.share.toast`: `Link copied.`
- `result.share.toast.pending`: `Link copied. It works before the result does.`
- `result.manage`: `Manage this entry`
- `result.public.footer`: `Everything on this page is public, including the text as submitted.`
- `result.public.footer.owner`: `Remove it with your key on the manage page.`

**Pending**

- `pending.heading`: `Submitted.`
- `pending.timing`: `Analysis usually lands in 3 to 6 minutes; the rating 5 to 15 minutes after that.`
- `pending.keepChecking`: `We will keep checking. You can close this page; the link is yours.`
- `pending.whatNow.heading`: `What happens now`
- `pending.whatNow.1`: `A gate check confirms it is a resume.`
- `pending.whatNow.2`: `The analysis scores it against the rubric.`
- `pending.whatNow.3`: `The site rebuilds with the result.`
- `pending.whatNow.4`: `The next rerank places it with eight matches; the site rebuilds again.`
- `state.dispatched.label`: `Received.`
- `state.dispatched.secondary`: `GitHub accepted the submission at {time}. A workflow starts within a minute.`
- `state.queued.label`: `Queued.`
- `state.queued.secondary`: `Waiting for a runner. {n} ahead of you.`
- `state.queued.secondary.unknown`: `Waiting for a runner.`
- `state.running.label`: `Reading and scoring.`
- `state.running.secondary`: `The gate check takes seconds; the analysis one to two minutes. Started {elapsed} ago.`
- `state.publishing.label`: `Scored. Publishing.`
- `state.publishing.secondary`: `The result is written; the site rebuilds in one to two minutes.`
- `state.analysed.label`: `Analysed. Not yet rated.`
- `state.analysed.secondary`: `Placement runs in the next rerank, every ten minutes, then the site rebuilds. Usually 5 to 15 minutes. This page keeps checking.`
- `state.placing.label`: `Placing, {done} of {total}.`
- `state.placing.secondary`: `Head to head against resumes near the starting estimate.`
- `state.budgetWait.label`: `Queued for tomorrow.`
- `state.budgetWait.secondary`: `Today's judging budget is spent. Placement resumes at 00:00 UTC; the analysis above stands.`
- `state.rated.label`: `Placed.`
- `state.notSeen.label`: `Not seen yet.`
- `state.notSeen.secondary`: `GitHub accepted the submission but no run has appeared. This happens; we keep checking for ten minutes.`
- `state.fallbackPending.label`: `Submitted through the fallback.`
- `state.fallbackPending.secondary`: `Issue submissions are picked up by the same workflow and usually take a few minutes longer. This page keeps checking.`
- `state.stale.label`: `Still waiting on placement.`
- `state.stale.secondary`: `Longer than usual. The status block on the about page shows the queue. This page checks every minute; it is safe to close and come back, the link is yours.`
- `state.visitor.publishing`: `Publishing.`
- `state.visitor.analysed`: `Analysed. Not yet rated.`
- `queued.title`: `Queued.`
- `queued.body`: `Today's analysis budget is spent. Your text is stored and will be analysed after 00:00 UTC, in order. You are number {n}.`

**Pipeline errors**

- `rejected.not_a_resume.title`: `This does not look like a resume.`
- `rejected.not_a_resume.body`: `The gate found no roles, education, or dates. If it is one, the extraction may have scrambled it: go back, check the preview reads top to bottom, and submit again.`
- `rejected.spam.title`: `This was rejected as spam.`
- `rejected.spam.body`: `The text is mostly links, repeated phrases, or promotional copy. Submit a resume.`
- `rejected.injection.title`: `This contains instructions to the judge.`
- `rejected.injection.body`: `Text addressed to the evaluator is ignored and flagged. Remove it and submit again.`
- `rejected.too_short.title`: `Not enough text.`
- `rejected.too_short.body`: `Fewer than 400 characters reached the workflow. Paste more, or check the extraction.`
- `rejected.handle_taken.title`: `The handle was taken first.`
- `rejected.handle_taken.body`: `Someone registered {handle} between your check and the workflow. Pick another and submit again; the text is still in this browser.`
- `rejected.duplicate.title`: `This text is already on the ladder.`
- `rejected.duplicate.body`: `An identical text was submitted under another handle. If it is yours, manage that entry with its key; if it is not, send the id to the address on the about page.`
- `rejected.bad_payload.title`: `The submission was malformed.`
- `rejected.bad_payload.body`: `Something between the browser and the workflow changed the payload. Reload and try again.`
- `rejected.backToText`: `Back to the text`
- `rejected.uploadAgain`: `Upload a resume`
- `failed.title`: `The analysis did not finish.`
- `failed.body`: `The workflow failed before writing a result. Nothing is published. Try again; if it fails twice, send the id to the address on the about page.`
- `failed.log`: `Workflow log`
- `lost.title`: `The submission did not start.`
- `lost.body`: `GitHub accepted it but never ran it. Submit again; the text is still in this browser.`
- `lost.again`: `Submit again`
- `deleted.title`: `This entry was deleted by its owner.`
- `deleted.body`: `Its matches remain in opponents' histories as an anonymous placeholder.`
- `superseded.note`: `This entry was resubmitted. Showing the current version.`
- `notFound.title`: `Nothing here.`
- `notFound.body`: `The link may be deleted or mistyped.`
- `notFound.publishing`: `If you were just sent this link, the result may still be publishing. Try again in a few minutes.`
- `data.error.title`: `Could not load.`
- `data.error.body`: `GitHub Pages did not answer. Retrying.`

**Analysed and rated sections**

- `rating.notPlaced`: `Not yet placed`
- `rating.provisional`: `Provisional, {done} of {total} placement matches`
- `rating.delta7d`: `{delta} this week`
- `rating.pm.tooltip`: `How settled the rating is. It narrows as matches are played.`
- `rank.afterPlacement`: `after placement`
- `rank.notRated`: `not rated`
- `rank.notRated.tooltip`: `Relevance below the threshold for this ladder.`
- `rank.topPct`: `top {pct}%`
- `section.verdict`: `Verdict`
- `section.breakdown`: `Breakdown`
- `breakdown.weightHeader`: `weight ({ladder})`
- `breakdown.scoreHeader`: `score`
- `breakdown.stageRelative`: `Stage-relative`
- `breakdown.medianNote`: `Tick marks the median on your primary ladder.`
- `breakdown.headlines`: `{general} · {finance} · {tech} · {academia}` rendered as `general 71 · tech 78 · finance — · academia —` followed by `(headline scores)`
- `section.strengths`: `Strengths` · `section.weaknesses`: `Weaknesses`
- `section.ats`: `ATS readiness`
- `ats.score`: `{score} / 100`
- `ats.fixes`: `Fixes`
- `ats.factors`: `Factors`
- `section.redFlags`: `Flags`
- `redFlags.note`: `Flags are shown to you and affect only the lines they touch.`
- `section.matches`: `Recent matches`
- `matches.all`: `all {n} matches →`
- `matches.empty.title`: `No matches yet.`
- `matches.empty.body`: `Placement starts at the next rerank.`
- `matches.columns`: `result` · `opponent` · `Δ` · `judge's note`
- `text.summary`: `Text as submitted ({chars} characters, {pages} pages, {columns} column)` (`Text as submitted ({chars} characters, pasted)` for paste)
- `placed.heading`: `Placed.`
- `placed.toast`: `Your resume is rated. The link is yours to share or keep.`
