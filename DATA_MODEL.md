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

### `roadmap`

```jsonc
[{ "label": "Call 211", "detail": "why it matters",
   "when": "today",            // now | today | week | month
   "dimension": "housing",     // the one area this action supports
   "done": false, "doneAt": null }]
```

`dimension` is what connects the roadmap back to the score. Completing an
action raises only the area it supports, and completing every action linked to
an area closes at most **half** the remaining gap to 100. A checkbox is
evidence of progress, not proof of stability, and a score that reached 100 from
checkboxes alone would be dishonest to someone still in a hard situation.

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
