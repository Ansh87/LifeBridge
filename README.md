# LifeBridge

**Crisis Assistance, Recovery & Empowerment, an AI-powered platform that helps people navigate life's hardest moments.**

Live demo: https://lifebridge-ai-prototype.netlify.app
A student-developed decision-support prototype for crisis recovery.

---

## Inspiration

When something goes badly wrong in a person's life, a spouse dies, a job disappears, a home floods, a diagnosis lands, a scam drains an account, the hardest question is rarely "where is one resource." It is **"what do I do now, and in what order."** People in crisis are handed phone numbers and PDFs, then left to assemble a plan while overwhelmed. And most tools stop at the first problem, when the damage that breaks a family often comes from the *second* one: the eviction that follows the job loss, the school disruption that follows a parent's death.

LifeBridge started from a simple idea: build the thing a good case worker does in their head, read the situation, weigh what is most at risk, lay out concrete next steps, point to real help, and warn about what tends to come next, and make it available to anyone, instantly.

## What it does

Describe a life-changing event in plain language. LifeBridge:

1. **Detects the crisis** and what is actually at stake.
2. **Assesses stability across six fixed areas** (housing, financial, food, health, family/education, safety) instead of a single number, and explains what drove each one.
3. **Builds a personalized recovery plan** with today / this week / this month steps, documents to gather, and who can help.
4. **Names the top three priorities**, each with why it matters and a concrete next step.
5. **Flags risks to watch**, the setbacks that tend to follow, worded as possibilities rather than predictions.
6. **Connects to real resources**: accurate US crisis hotlines, plus nearby social services pulled live from OpenStreetMap.
7. **Tracks recovery** through a roadmap grouped by urgency. Each action is linked to the area it supports, so completing it moves that area rather than inflating the whole score.

It spans six areas of life: Family & Personal, Housing & Basic Needs, Financial & Employment, Medical & Mental Health, Education & Youth, and Legal & Civic, 14 specific situations in all.

8. **Saves and follows you.** Sign in as a guest in one tap, or with Google, and your plans and roadmap progress persist across devices, because recovery takes weeks, not one browser session.

## Accounts and saved plans

Recovery is not a single sitting. Someone who builds a plan on a library computer on Monday needs it on their phone on Thursday, so LifeBridge saves plans to an account.

- **The first screen is sign-in.** Guest or Google, and the app opens behind it. The gate fails open by design: if Firebase is unconfigured, blocked, offline, or slow, LifeBridge opens normally rather than trapping someone at a screen whose buttons cannot work. Emergency hotlines and About are reachable from the gate without an account, so 988 is never behind a login.
- **Guest sign-in (Firebase Anonymous)**, one tap, no email, no password. Plans start saving immediately. This is also what makes the app demoable: a judge can try the full flow without creating anything.
- **Google sign-in**, the same plans, reachable from any device.
- **Guest → Google keeps everything.** Linking upgrades the *same* Firebase account, so saved plans stay exactly where they are with nothing copied. If that Google account already exists, the client buffers the guest's plans and re-creates them under the real account before the session switches. Nobody loses a plan for signing in.
- **Per-user isolation, enforced server-side.** Plans live at `users/{uid}/plans/{planId}` and the security rules allow access only when `request.auth.uid == uid`. Everything else in the database is denied by an explicit catch-all, and `collectionGroup("plans")`, the one query shape that could span accounts, is denied outright. `ownerUid` and `createdAt` are immutable after creation.

The schema and the reasoning behind it are in **[DATA_MODEL.md](DATA_MODEL.md)**; the annotated rules are in **[firestore.rules](firestore.rules)**. Those rules ship with a 23-case test suite (`npm run test:rules`) that proves the isolation claim against the Firestore emulator rather than asserting it.

**Setup is in [SETUP.md](SETUP.md)**, GitHub, the Firebase Console walkthrough, and where the config goes.

## The engine: the LifeBridge Recovery Engine

At the core is the **LifeBridge Recovery Engine** (ACRE, the Adaptive Crisis Recovery Engine), in `js/lifebridge-engine.js`. It is model-agnostic and pillar-agnostic: one reasoning core (crisis detection to multi-dimensional risk profile to recovery plan to secondary-risk prediction) serves every situation, with per-situation content authored as structured data. It runs the same six stages for every situation, and that vocabulary is used consistently across the whole product:

    Understand -> Assess -> Prioritize -> Plan -> Connect -> Recover

Two design choices carry most of the weight:

- **Six fixed stability dimensions**, not model-invented axes: Housing, Financial, Food & Essentials, Health & Wellbeing, Family / Education, Personal Safety. Letting the model name its own axes made two people's scores incomparable and the result impossible to explain.
- **Scores are stability, never risk.** Higher is always better, everywhere in the codebase. Mixing the two directions was the easiest available way to ship a bug that tells someone in crisis the opposite of the truth.

Each roadmap action is linked to the one dimension it supports, so completing it moves that area rather than inflating the whole score. Completing every action linked to a dimension closes at most half the remaining gap to 100, because a checkbox is evidence of progress, not proof of stability.

This is the novel component of the project.

## How it's built

- **Frontend:** HTML / CSS / vanilla JS, no framework. Mobile-responsive, keyboard-accessible, reduced-motion aware.
- **AI:** Google Gemini through a Netlify serverless proxy that keeps the key server-side and never exposes the provider in the UI. A 3-model fallback chain plus retry-with-backoff (server) and a second retry with lenient JSON repair (client) keep the planner reliable under free-tier rate limits.
- **Auth & data:** Firebase Authentication (Anonymous + Google) and Cloud Firestore, loaded as a deferred ES module so the app renders and works before, and without, it. Firebase never touches the Gemini path.
- **Resources:** OpenStreetMap Overpass API for nearby social facilities; browser geolocation; Leaflet for mapping. US crisis hotlines are accurate and hardcoded.
- **Deploy:** Netlify (static site + serverless function), env var GEMINI_API_KEY.

```
index.html                      the app: UI, screens, rendering
js/lifebridge-engine.js         the Recovery Engine: dimensions, scoring, prompts, demo, resources
js/firebase-config.js           the only file you edit after creating a Firebase project
js/lifebridge-cloud.js          auth + Firestore layer (ES module, degrades to local-only)
netlify/functions/ai-proxy.js   Gemini proxy, the only place GEMINI_API_KEY is read
firestore.rules                 per-user access rules, annotated
tests/firestore.rules.test.mjs  23 cases proving those rules hold
DATA_MODEL.md                   schema and the reasoning behind it
SETUP.md                        GitHub + Firebase Console walkthrough
```

### Two keys, two very different rules

- `GEMINI_API_KEY` is a **real secret**. It lives in Netlify's environment variables and is read only by the serverless function. It is not in this repository and must never be.
- The Firebase web `apiKey` in `js/firebase-config.js` is **not a secret**, it identifies the project and grants nothing by itself. Access is decided by Firebase Auth and `firestore.rules`, which is why those rules carry the weight they do. It is committed deliberately.

### Failure behaviour

The cloud layer is additive, never load-bearing. With Firebase unconfigured, offline, or blocked, `LBCloud` reports `disabled`, the account UI does not render at all, and every original feature, assessment, plan, roadmap, map, hotlines, works exactly as before against `localStorage`. Sign-in errors surface as plain sentences ("Sign-in window closed before finishing"), never as raw Firebase codes. Popup-blocked sign-in falls back to a full-page redirect, carrying the pending guest-plan migration through `sessionStorage` so nothing is lost across the navigation.

## What I learned

- **Reliability is a feature.** The single most impressive part of the app, live AI planning, was also the most fragile, because free-tier rate limits surfaced as an "offline" fallback. Layering server backoff, client retry, and lenient JSON parsing turned the weakest moment into a dependable one. A demo only counts if it works when someone else clicks the button.
- **Serverless functions need the right deploy path.** Drag-and-drop can silently flatten a functions folder; the CLI bundles it reliably. Verifying the function endpoint directly is the fastest way to prove it's live.
- **Multi-dimensional beats a single score.** Collapsing a crisis into one number hides the thing that matters, which dimension is on fire. Scoring each dimension separately makes the plan actually actionable.
- **Design carries trust.** For a crisis tool, calm-under-duress visual design (steady palette, a bridge that builds as you recover) does real work: it has to feel safe, not alarming, to someone at their worst moment.
- **Sensitive data changes how you design a schema.** Nesting plans under `users/{uid}` instead of a flat collection with an `ownerUid` filter makes ownership a property of the path, so no forgotten `where()` clause can leak across accounts. Writing the rules and their tests before the UI meant the storage layer was never "add security later."
- **A login is a barrier at the worst possible moment.** Requiring an account before someone in crisis can get help is the wrong trade. Anonymous auth removes the barrier without giving up persistence, and account linking means choosing the easy path first never costs them their plan later.

## Responsible-use note

LifeBridge is a student proof-of-concept for educational and decision-support use. It is **not** a substitute for professional legal, medical, financial, or emergency services, and not an emergency service itself. In an emergency, call 911; for crisis support, call or text 988. Crisis hotline numbers are for the United States. The full disclaimer and data notes live in the app's About panel.

On stored data specifically: the app is fully usable without an account, and plans stay in the browser unless the user signs in. Saved plans are encrypted at rest by Google and in transit by TLS, and are readable only by the account that created them, but they are not end-to-end encrypted, so a project owner with console access could read them. That is stated plainly here and in the app's About panel rather than implied otherwise.

## Run / deploy

Full first-time setup, including the Firebase Console steps, is in **[SETUP.md](SETUP.md)**. The short version, for a site that is already deployed:

    npm install -g netlify-cli
    netlify login
    netlify deploy --prod          # from the project folder
    netlify env:set GEMINI_API_KEY  <your Google AI Studio key>
    netlify deploy --prod          # redeploy so the function picks up the key

Verify: visiting /.netlify/functions/ai-proxy returns a health report, `{"ok":true,"configured":true,...}`. `configured:false` means GEMINI_API_KEY is not set on that deploy. The Navigator should show a green "Personalized by LifeBridge" badge.

For local development, `npm run dev` serves the folder on <http://localhost:5173>. `localhost` is a Firebase authorized domain by default, so sign-in works there; the Gemini proxy does not, since it needs the Netlify runtime, use `netlify dev` if you need both at once.

To verify the security rules (requires Java 11+):

    npm install
    npm run test:rules

## License

MIT, see [LICENSE](LICENSE).
