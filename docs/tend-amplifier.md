# Tend teammate: Amplifier (LinkedIn member amplification)

The first browsing teammate. Watches EAC members on LinkedIn and drafts
company-page amplifies (repost with thoughts) into the Airtable Amplify
Watchlist for approval, then posts the approved ones as the EAC page.

Rebuilt from Cam's own Grok bot template (September 2026). The rules below
are his, lifted from that template and from the notes column of the existing
Airtable table. Nothing here comes from any third-party source.

## Where the data lives

| Thing | Where |
|---|---|
| Watchlist, findings, drafts, status | Airtable base `Expert Author Social Media Management` (`appWJ2eQQOQfYZcX6`), table `LinkedIn Amplify Watchlist` (`tblUuFEU1Bma0obDM`) |
| Seen posts (never re-read) | Supabase `tend_linkedin_seen` (to build) |
| Approval | Tend thread, one card per evening. Approved rows flip to `Reposted` in Airtable. |

Watchlist facts at 11 Sep 2026: 427 rows. 178 current authors, 249
alumni/members. **152 have a LinkedIn URL, all current authors.** 26 current
authors and all 249 alumni have no URL. Status: 409 Watching, 13 Draft ready,
5 Reposted.

Airtable columns the teammate reads and writes: `Name`, `List source`,
`Amplify when`, `LinkedIn profile`, `Watch status`, `Last checked`,
`Post to amplify`, `Repost draft`, `Notes / findings`.

`Watch status` values: Watching → Candidate found → Draft ready → Reposted / Skipped.
`Amplify when` values: Book / launch, Events / keynotes, Showcasing book,
Mentions EAC, Involved with EAC author, Other.

## Schedule

Daily, **evening AEST** (prep for next-day posting). Drafts 2 to 3. Does not
publish in the same run. A second short run the next morning posts what was
approved, spaced 1 to 2 hours apart, business hours.

## Standing instructions (paste into the Tend teammate)

```
Evening prep for EAC company LinkedIn page amplifies (next-day posting). Stay lean on tokens.

Goal: find 2 to 3 strong amplify drafts and update the Airtable Amplify Watchlist. Do not publish in this run.

Priority order:
1. Open the EAC company page admin notifications. Find recent notifications where someone @mentioned the page. Cap at 5 to 8 mention notifications.
2. For each mention person worth amplifying: read their personal recent activity briefly, newest 3 posts only. Pick book, launch, event or keynote, showcasing book, or a clear community shout-out.
3. Only if mentions are thin: scan watchlist authors' recent activity. Prefer quieter authors. Cap at 10 to 12 posts per pass, 15 max.

When you open a candidate post, Like it before you leave, as the company page. Do not comment.

Selection rules:
- Current authors: amplify book, launch, events, keynotes, showcasing the book.
- Alumni and pre-book members: amplify only when they mention EAC or engage with an EAC author.
- One amplify per author per 30 days. Spread the love. Skip anyone amplified recently. Prefer quieter authors when building next-day drafts.
- Never claim or @mention a publisher imprint (including EAC Books) unless the original post text names it. Do not invent an imprint from memory or from Airtable.

Writing the repost draft:
- A unique, post-specific hook line. Never reuse a generic opener across posts.
- Then one or two short sentences naming the member and what they did. Warm, direct, practical, no hype. Light emoji is fine. A soft closing question is fine.
- No em dashes or long hyphens anywhere. Use commas, colons, or a full stop.
- End the draft with a line: "@mentions when posting: <names>" listing only real people to tag.

For each chosen candidate, update the Amplify Watchlist row: Watch status = Draft ready, Post to amplify = the post URL, Repost draft, Notes / findings (one line: date, source, why), Last checked = today.

Finish with a short brief. Link the Airtable records, not LinkedIn profile URLs. If nothing qualifies, say so in one line.
```

## Publishing (the morning run, after approval)

For each row approved in Tend: open the post, switch identity to the EAC
company page, choose "Repost with your thoughts", paste the draft, add
@mentions by typing `@` and selecting the real profile (plain-text names do
not become tags), post. Then set `Watch status = Reposted` and append the
date to `Notes / findings`. Cap 5 a day, default 1 to 2, up to 3 on launch
weeks. Space posts 1 to 2 hours apart.

There is no API path for organic company-page reposts. This step needs the
browser. That is the reason the browser worker exists.

## Tools to build (rows in `api/_lib/tend-tools.ts`)

| Tool | Write | Notes |
|---|---|---|
| `amplify_watchlist_read` | no | Rows with a LinkedIn URL, plus status and last-amplified date. |
| `amplify_watchlist_update` | yes, but not gated | Writes findings and drafts. Safe: Airtable is the queue, not the world. |
| `linkedin_page_notifications` | no | Mentions of the page, capped. Browser. |
| `linkedin_recent_posts` | no | Newest N posts for a profile URL as compact text. Browser + code reader + seen table. |
| `linkedin_like_post` | yes, not gated | Liking is part of reading, per Cam's rule. Cap per run. |
| `linkedin_repost_as_page` | **yes, gated** | The only action that publishes. Approval card in Tend. Daily cap baked into the tool. |

## Safety rails

- One dedicated LinkedIn login (page admin), stored once, never typed by the teammate.
- Stable Australian IP. Business hours only.
- Hard daily caps in the tools, not the prompt: 5 reposts, 20 likes, 40 profile reads.
- A "verify you are human" screen stops the run and reports it. Never attempted.
- Every repost is approved by a human in Tend first.

## Cost estimate

Browser about 25 minutes a day. 30 to 50 new posts through Haiku for sorting,
2 to 3 drafts through Sonnet. Under $30 a month in model spend.

## Known gap

275 watchlist rows have no LinkedIn URL. A separate read-only "URL Finder"
teammate can search LinkedIn by name and write candidates back for a human
to confirm. Not part of the first build.
