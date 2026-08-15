# LifeBridge, Firestore data model

Written down before the code was, because this collection holds crisis
narratives. A `situationText` field can contain *"my husband is hitting me and
I'm planning to leave on Thursday."* That is the most sensitive class of data
this project touches, and the shape of the database is what makes it
protectable.

---

## Shape

```
users/{uid}                          ← one profile document per account
users/{uid}/plans/{planId}           ← one document per saved recovery plan
```

Plans are **nested under the owner**, not stored in a flat top-level
`plans` collection with an `ownerUid` filter. That choice is the whole security
design: ownership becomes a property of the *path*, so the rule is
`request.auth.uid == {uid}` and there is no query that can be written, by the
app, by a bug, or by someone poking at the SDK from the console, that reaches
across accounts. A flat collection would make every read depend on remembering
to attach the right `where()` clause.

---

## `users/{uid}`, profile

Deliberately tiny, and holds **no crisis content**. Its only job is to let a
returning device restore the home screen before any plan is fetched.

| Field | Type | Notes |
|---|---|---|
| `ownerUid` | string | Always equals `{uid}`. Validated on every write. |
| `schemaVersion` | int | Currently `1`. Present so a future migration has something to branch on. |
| `displayName` | string \| null | From Google. `null` for guests. ≤ 120 chars. |
| `isAnonymous` | bool | `true` while the account is a guest session. |
| `currentPlanId` | string \| null | The plan this user was last working on, powers cross-device resume. |
| `score` | number \| null | 0-100 LifeBridge Score. Denormalized so the bridge draws without loading a plan. |
| `createdAt` | timestamp | Server-set. Immutable after creation. |
| `updatedAt` | timestamp | Server-set on every write. |

---

## `users/{uid}/plans/{planId}`, a saved recovery plan

| Field | Type | Notes |
|---|---|---|
| `ownerUid` | string | Equals `{uid}`. Immutable. Defence in depth, a document body copied out of one account cannot be replayed into another. |
| `schemaVersion` | int | `1`. |
| `title` | string | Card heading. 1-140 chars. |
| `crisisType` | string \| null | What ACRE decided this is. ≤ 140. |
| `crisisId` | string \| null | One of the 14 crisis module ids (`jobloss`, `dv`, `eviction`, …), or `null` for an open-ended entry. |
| `pillarId` | string \| null | One of the 6 pillars (`family`, `housing`, `finance`, `health`, `education`, `legal`). |
| `situationText` | string \| null | **The user's own words.** Capped at 4000 chars. The most sensitive field in the database. |
| `source` | `"ai"` \| `"fallback"` | Whether the live planner produced this or the offline rule-based framework did. Kept so a plan built during an outage is labelled honestly when reopened. |
| `score` | number \| null | 0-100 at time of last write. |
| `plan` | map | The ACRE payload, see below. |
| `roadmap` | array | ≤ 60 steps, see below. |
| `progress` | map | `{done, total, pct}`. Denormalized so the plan list renders from one read instead of counting steps client-side. |
| `archived` | bool | Reserved. Always `false` today. |
| `createdAt` | timestamp | Server-set. Immutable. |
| `updatedAt` | timestamp | Server-set. Sorts the plan list. |

### `plan` (the Recovery Engine payload)

Mirrors the JSON the engine produces, so nothing has to be reshaped on the way
in or out. `js/lifebridge-cloud.js -> sanitizePlan()` drops unknown keys and
truncates every string before the write, so a malformed model response can
never bloat or corrupt a stored document.

```jsonc
{
  "engineVersion":   2,
  "crisisType":      "Loss of a spouse",
  "acknowledgement": "...",
  "isSample":        false,                                   // true for the demo scenario
  "priorities": [                                             // exactly 3, most urgent first
    { "title": "Protect your housing", "urgency": "High",
      "why": "...", "nextStep": "...", "dimension": "housing" }
  ],
  "dimensions": [                                             // all six, always
    { "id": "housing", "score": 34, "assessed": true, "why": "..." }
  ],
  "actions": [                                                // 4 to 8
    { "when": "today", "task": "...", "why": "...", "dimension": "financial" }
  ],
  // reassessment history, kept inside the plan map because firestore.rules
  // whitelists top-level document keys and would reject new ones
  "assessedAt":        1786800000000,
  "originalSituation": "how they first described it, preserved verbatim",
  "history": [{ "score": 42, "at": 1786700000000, "kind": "initial",
                // the six areas as they stood, so a reassessment can say which
                // ones moved rather than only replacing one total with another
                "dims": [{ "id": "housing", "score": 34 }] }],
  "updates": [{ "text": "what they said had changed", "at": 1786800000000 }],
  "documents":    ["Death certificate, several certified copies"],
  "helpers":      [{ "who": "...", "what": "...", "how": "..." }],
  "risksToWatch": [{ "risk": "...", "why": "...", "prevent": "..." }]
}
```

**Scores are stability, never risk.** 100 is fully stable, 0 is in crisis, and
that direction holds everywhere in the codebase. The first version stored
`risks[{dimension, level}]` where a *higher* number was *worse*. Mixing the two
directions is the easiest available way to ship a bug that tells someone in
crisis the opposite of the truth, so the inversion happens once, in
`normalizePlan()`, and nowhere else.

The six dimension ids are fixed: `housing`, `financial`, `food`, `health`,
`family`, `safety`. They are not model-chosen. Letting the model name its own
axes made two people's scores incomparable and the result impossible to explain.

#### Reading a plan saved by an earlier version

`normalizePlan()` in `js/lifebridge-engine.js` accepts both shapes. A v1 plan
has its `risks` inverted into stability, its `secondaryRisks` renamed to
`risksToWatch`, and priorities derived from its weakest areas, so a plan saved
before this engine existed still opens into the current experience rather than
a half-empty screen. Legacy fields are preserved on re-save rather than
stripped. `tests/` covers this path.

### Reassessment

`Update my situation` re-runs the engine with the original description, the
previous assessment, and what the person says has changed. The result replaces
the assessment; it does not replace their work.

- Completed actions are **never** removed. Someone who called 211 last week did
  call 211, whatever the new assessment concludes.
- Outstanding actions survive only if the new assessment still recommends them,
  so the roadmap does not accumulate stale advice.
- Genuinely new actions are flagged `isNew` for one render.
- The previous score **and its six area scores** are pushed onto `history`,
  which is what the `42 → 57` pairing on the plan card and the per-area
  breakdown after a reassessment are drawn from. That pairing is always a
  reassessment delta, never a side effect of ticking boxes.
- Because the breakdown is stored rather than held in memory, it survives a
  reload and appears on the person's other devices, and it ages off the screen
  on its own after a day.

If the planner is unreachable mid-reassessment the existing plan is left
completely untouched. Losing a working plan because a request timed out would
be a worse failure than not updating it.

### `roadmap`

```jsonc
[{ "label": "Call 211", "detail": "why it matters",
   "when": "today",            // now | today | week | month
   "dimension": "housing",     // the one area this action supports
   "done": false, "doneAt": null }]
```

`dimension` records the area an action is *intended* to support. It does not
feed the score.

**The two numbers are independent, on purpose.**

| | Answers | Moves when | Carries |
|---|---|---|---|
| LifeBridge Score | Where does this person stand? | They tell LifeBridge their situation changed, and it reassesses | The date it was taken |
| Recovery Progress | What have they done? | They tick a roadmap action | How much of it happened since that date |

An earlier version let ticking a box raise the stability score. That conflated
two genuinely different things: taking an action, and the action having worked.
Calling the landlord is progress; whether housing is actually more secure
depends on what the landlord said, and only the person knows that. Conflating
them meant a score could climb while someone's life got worse.

### What the separation costs, and what pays for it

Splitting them fixes the lie and introduces two costs, both real, both worth
naming rather than pretending away.

The first is staleness. A score that only moves on reassessment will sit
unchanged for weeks, and a number with no date on it reads as current. So
`assessedAt` travels with the score everywhere the score is drawn, and
`assessmentAge()` turns it into "assessed 6 days ago". Silence is not the same
as accuracy.

The second is that effort stops being acknowledged. The old model's one real
virtue was that doing the work moved something visible. Three things replace
it without reintroducing the false claim:

| | What it is |
|---|---|
| `actionsSinceAssessment()` | Work completed after the current assessment, counted as work, not as improvement. Reads `doneAt` against `assessedAt`, so it resets when a reassessment catches up. |
| `dimensionMomentum()` | Which areas have had every attached action completed. Finishing one is the moment the old model used to move the score at; it is the right moment for encouragement, and the wrong moment to assume an outcome. |
| `reassessNudge()` | Whether to invite a reassessment. Three actions completed, or a finished roadmap, is a strong invitation; a week old with work done, or a fortnight old regardless, is a soft one. Never on a demo, never without a roadmap, never as a modal. |

The invitation is deliberately quiet. This is a crisis app, and a product that
nags someone having the worst month of their life is a product they close. It
is one line with one button, dismissible for the session, and it comes back on
the next visit if the situation still warrants it, because a permanently
silenced prompt is how a score gets to be three months old without anyone
noticing.

`done` is the field that changes most often in the whole app. It is what a
user touches while recovering. Writes are debounced 700 ms in
`syncRoadmap()` so a burst of checkbox taps costs one write, not six.

---

## Access rules, in one sentence

A caller may read or write `users/{uid}/**` if and only if
`request.auth.uid == uid`; everything else in the database is denied by an
explicit catch-all. See [`firestore.rules`](firestore.rules) for the
annotated source.

Two things worth calling out:

- **Collection-group queries are denied.** There is no
  `match /{path=**}/plans/{planId}` rule, so `collectionGroup("plans")`, the
  one query shape that could otherwise span accounts, fails for everyone.
  Do not add one.
- **`ownerUid` and `createdAt` are immutable.** Updates must leave both equal
  to their existing values, so an account cannot rewrite provenance.

## Known limits

Honest about where the boundary is:

- Rules validate that `plan` is a map and `roadmap` is a list of ≤ 60, but do
  not walk inside them. String caps inside those structures are enforced
  client-side; Firestore's 1 MB document ceiling is the server-side backstop.
- Rules cannot count documents, so there is no server-side cap on plans per
  user. The client lists at most 50.
- Data is encrypted at rest by Google and in transit by TLS, but it is not
  end-to-end encrypted, a project owner with console access can read it.
  Worth stating plainly rather than implying otherwise.

## Guest sessions

A guest is a real Firebase user with a real uid and `isAnonymous: true`, the
same rules apply, so guest data is just as isolated. What a guest lacks is a
way to *prove* they are the same person from another browser. Linking a Google
account keeps the uid and therefore keeps every document; if that Google
account already exists, the client copies the guest's plans across before the
session switches (`signInGoogle()` in `js/lifebridge-cloud.js`).
