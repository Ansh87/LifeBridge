# LifeBridge, setup

Three parts, in this order. Firebase first, because step 2 commits the config
that step 1 gives you, and step 3 deploys what step 2 pushed.

1. [Set up Firebase](#1-set-up-firebase) (browser, ~15 min)
2. [Push to GitHub](#2-push-to-github) (terminal, ~5 min)
3. [Configure Netlify](#3-configure-netlify) (browser, ~5 min)
4. [Check that it works](#4-check-that-it-works)
5. [Verify the security rules](#5-verify-the-security-rules-optional) (optional)

Nothing here touches `GEMINI_API_KEY`. It stays where it already is, in
Netlify's environment variables, read only by `netlify/functions/ai-proxy.js`
on the server. It must never appear in any file in this repository.

Work from the `lifebridge-deploy` folder throughout. That folder is the repo
root. The files sitting loose in its parent are older copies; ignore them.

---

## 1. Set up Firebase

Account creation happens in your browser. Free tier ("Spark") covers this
project comfortably.

### 1a. Create the project

1. Go to <https://console.firebase.google.com> and sign in with a Google account.
2. **Create a project** (or "Add project").
3. Name it `lifebridge`. The console appends a suffix to make it globally
   unique, e.g. `lifebridge-4f2a1`. That full string is your **project ID**.
4. Google Analytics: **turn it off**. You don't need it, and for an app storing
   crisis narratives, fewer trackers is the better default.
5. Create project, wait for it to finish, Continue.

### 1b. Register the web app

1. On the project overview page, click the **`</>`** (Web) icon.
2. App nickname: `LifeBridge Web`. **Do not** tick "Also set up Firebase
   Hosting", Netlify is doing the hosting.
3. Register app.
4. You'll be shown a `firebaseConfig` object. **Copy it and keep the tab open.**
   Step 1f needs it. (If you lose it: gear icon → Project settings → General →
   scroll to "Your apps" → SDK setup and configuration → Config.)

### 1c. Turn on the two sign-in methods

Left sidebar → **Build → Authentication → Get started**, then the **Sign-in
method** tab.

- **Anonymous** → click it → toggle **Enable** → Save.
  This is the frictionless demo login. A judge can try the whole app in one tap.
- **Google**, click it, toggle **Enable**, then set two fields before saving:
  - **Project public-facing name**, change it to `LifeBridge`.
  - **Project support email**, this appears on the consent screen, so pick the
    address you would want a user to actually see.

  Save.

#### If the sign-in popup still says `lifebridge-xxxxx.firebaseapp.com`

That is Google's OAuth consent screen falling back to the auth domain because
no **App name** is set on the OAuth branding record, or because the app has not
been brand verified. Firebase's "public-facing name" writes to the same record,
but the change is not always immediate and the name only renders once branding
is accepted.

To fix it properly:

1. Go to <https://console.cloud.google.com/auth/branding> and select your
   Firebase project (same project, the Google Cloud side of it).
2. Set **App name** to `LifeBridge`, set the user support email, and add a logo
   if you have one. Save.
3. Under **Audience**, check the publishing status. In **Testing** the name
   shows only for accounts you add as test users, which is no good for a public
   demo. **Published** (External) is what you want, and with only the basic
   `email`, `profile` and `openid` scopes there is no sensitive-scope review to
   pass.
4. To display a custom name and logo on a Published External app, Google
   requires **brand verification**: you verify ownership of the authorized
   domain in Search Console, then submit from the Branding page. For a simple
   app on non-sensitive scopes the automated check often clears in minutes.
5. Sign-in popups are cached hard. Test in a fresh private window before
   concluding it did not work.

Worth being realistic about the trade: this is cosmetic. Sign-in works either
way, and if verification has not cleared before your deadline, the screen says
your Firebase domain instead of your app name. Nothing is broken.

Both providers must read **Enabled** before the app's sign-in buttons will work.

### 1d. Authorize your domain

Still under Authentication → **Settings** tab → **Authorized domains**.

`localhost` is there by default. Click **Add domain** and add:

```
lifebridge-ai-prototype.netlify.app
```

Without this, Google sign-in fails with `auth/unauthorized-domain`. If you
later add a custom domain, add that too. Netlify deploy previews get their own
URLs (`deploy-preview-3--lifebridge-ai-prototype.netlify.app`) and each needs
its own entry if you want sign-in to work there.

### 1e. Create the database and install the rules

Left sidebar → **Build → Firestore Database → Create database**.

1. Location: pick the region nearest your users. `nam5 (us-central)` is the
   usual US choice. **This cannot be changed later.**
2. Start in **production mode**, which is locked down by default. Never start
   in test mode. That leaves the database world-readable for 30 days.
3. Create.

Then open the **Rules** tab. Delete everything in the editor and paste the
entire contents of [`firestore.rules`](firestore.rules) from this folder.
**Publish**.

Sanity check: the first line should read `rules_version = '2';` and the last
block should be the `allow read, write: if false;` catch-all. A syntax error
in the editor almost always means a partial paste.

### 1f. Paste the config into the app

Open **`js/firebase-config.js`**. It is the only file you edit. Replace the six
`PASTE_…` strings with the values from step 1b:

```js
export const firebaseConfig = {
  apiKey:            "AIzaSy…",
  authDomain:        "lifebridge-4f2a1.firebaseapp.com",
  projectId:         "lifebridge-4f2a1",
  storageBucket:     "lifebridge-4f2a1.firebasestorage.app",
  messagingSenderId: "123456789012",
  appId:             "1:123456789012:web:abc123def456",
};
```

Save the file.

**Yes, this one gets committed to a public repo.** The Firebase web `apiKey` is
an identifier, not a credential. It tells the SDK which project to talk to and
grants nothing by itself; access is decided entirely by Firebase Auth and by
`firestore.rules`, which is exactly why those rules are written the way they
are. Google documents this explicitly. `GEMINI_API_KEY` is the opposite: a real
secret, and it stays in Netlify.

Optional but useful: open `index.html` directly in your browser now. A **Sign
in** button should appear in the top bar. If it doesn't, a `PASTE_` value is
still in place. (Sign-in itself won't work from a `file://` URL; that's
expected. It works on `localhost` and on the live site.)

---

## 2. Push to GitHub

Your repo already exists at <https://github.com/Ansh87/LifeBridge>.

Open a terminal and `cd` into the `lifebridge-deploy` folder, the one
containing `index.html`. Lines starting with `#` are comments; don't type
those.

```bash
# Initialize git here (skip the first line if a .git folder already exists)
git init
git branch -M main

# Safety check: make sure no real secret is about to be committed.
# The ONLY line this should print is the apiKey in js/firebase-config.js.
# If it prints anything from netlify/ or a .env file, stop and remove it first.
grep -rIn "AIza" . --exclude-dir=.git --exclude-dir=node_modules

git add .
git status          # read this list; nothing surprising should be in it

git commit -m "Add Firebase auth, saved plans, and Firestore security rules"

git remote add origin https://github.com/Ansh87/LifeBridge.git
git push -u origin main
```

**If `git push` is rejected** because the repo already has commits (a README
created at repo setup, for instance):

```bash
git pull --rebase origin main
git push -u origin main
```

**If `git remote add` says "remote origin already exists":**

```bash
git remote set-url origin https://github.com/Ansh87/LifeBridge.git
```

**If it asks for a password:** GitHub stopped accepting account passwords over
HTTPS. Either install [GitHub CLI](https://cli.github.com) and run
`gh auth login` once, or create a Personal Access Token at GitHub → Settings →
Developer settings → Personal access tokens → Tokens (classic), tick the `repo`
scope, and paste the token where it asks for a password.

Refresh the repo page. You should see `index.html`, `js/`, `netlify/`,
`firestore.rules`, `tests/`, and the three markdown files.

---

## 3. Configure Netlify

Right now the site is probably deployed by drag-and-drop. Connecting it to
GitHub means every `git push` redeploys automatically, which is what you want
for the rest of the build.

### 3a. Link the repository

Netlify → your site → **Site configuration → Build & deploy → Continuous
deployment → Link repository** → GitHub → authorize if asked →
`Ansh87/LifeBridge`.

Settings:

| Field | Value |
|---|---|
| Branch to deploy | `main` |
| Build command | *(leave empty)* |
| Publish directory | `.` |
| Functions directory | `netlify/functions` |

The publish and functions directories are already declared in `netlify.toml`,
so `netlify.toml` wins if the UI disagrees. Leave the build command empty,
there is no build step, and `netlify.toml` already sets `NPM_FLAGS="--omit=dev"`
so the rules-testing devDependencies never get installed during a deploy.

### 3b. About the "Exposed secrets detected" build failure

If a deploy fails with **"Exposed secrets detected"** and a masked value
starting `AIza…`, that is Netlify's smart secret scanning matching the Firebase
web `apiKey` in `js/firebase-config.js`. It is a false positive, that key is a
public project identifier, not a credential.

`netlify.toml` already handles it, with two narrowly scoped settings:

```toml
SECRETS_SCAN_OMIT_PATHS = "js/firebase-config.js"
SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES = "<your Firebase apiKey>"
```

**Do not "fix" this with `SECRETS_SCAN_ENABLED = "false"`.** That switches off
every protection site-wide. Your Gemini key also starts with `AIza`, so the
scanner is the thing that would catch it if it ever landed in a committed file.
Keeping scanning on everywhere except one known-public file is the whole point.

Worth confirming before you suppress any secret warning, here or on a future
project: click **Review exposed secrets** in the failed deploy and check which
file and field it found. Both Firebase and Google AI Studio keys begin `AIza`,
so the masked preview alone cannot tell them apart. It should be `apiKey` in
`js/firebase-config.js`, and the `projectId` beside it should match your
Firebase project. Anything under `netlify/` or in a `.env` file is a real leak:
rotate that key in Google AI Studio immediately rather than safelisting it.

### 3c. Confirm the Gemini key survived

**Site configuration → Environment variables.** `GEMINI_API_KEY` should still
be there. Linking a repo does not remove it, but check, because the AI planner
silently falls back to the offline framework without it.

If it's missing, add it: key `GEMINI_API_KEY`, value your Google AI Studio key,
scope "All deploy contexts."

### 3d. Deploy

**Deploys → Trigger deploy → Deploy site.** Takes about a minute.

If you prefer the CLI:

```bash
npm install -g netlify-cli
netlify login
netlify deploy --prod
```

---

## 4. Check that it works

On <https://lifebridge-ai-prototype.netlify.app>:

| Step | What should happen |
|---|---|
| Load the page | The **sign-in screen** appears first, with Guest and Google. If the app opens straight to the home screen instead, the deployed config still has placeholders, or Firebase could not load, and the gate correctly failed open. |
| Sign in → **Continue as a guest** | Top bar becomes **My plans** plus a "Guest" chip. No popup, no email. |
| Build a plan → **Save this plan** | The button becomes a green "Saved to your account". |
| **My plans** | The plan appears as a card with its progress bar. |
| Check off a roadmap step, wait a second, reload the page | The step is still checked. |
| Account chip → **Add Google and keep these plans** | Google popup, then the same plan is still listed. |
| Open the site in a private window, sign in with the same Google account | The plan is there. This is the cross-device proof, and the thing worth demoing. |

In Firebase Console → Firestore → Data you should now see
`users / {some-uid} / plans / {some-id}`.

### Is the AI actually configured? One URL tells you

Open this in a browser:

```
https://lifebridge-ai-prototype.netlify.app/.netlify/functions/ai-proxy
```

The function answers a plain GET with a health report:

```json
{ "ok": true, "configured": true, "keyLength": 39, "models": [ ... ] }
```

`configured: false` means `GEMINI_API_KEY` is not set on that deploy, which is
the single most common cause of "Planner offline" and of the assistant replying
"I'm having trouble reaching the assistant right now." It reports a boolean and
a length only, never the key itself.

If `configured` is `true` but the planner still fails, the cause is a quota or a
model problem. Open the browser console, trigger it again, and look for
`[LifeBridge] AI proxy attempts` which lists each model tried, the HTTP status
it returned, and the reason. `429` on every model means the free tier quota is
exhausted and will reset on a rolling window. `404` means that model ID is
retired and should be replaced in `netlify/functions/ai-proxy.js`.

### If something's wrong

| Symptom | Cause | Fix |
|---|---|---|
| No Sign in button at all | Config still has `PASTE_` values, or that commit wasn't pushed | Step 1f, then push again |
| `auth/unauthorized-domain` | Netlify domain not authorized | Step 1d |
| `auth/operation-not-allowed` | Google provider not enabled | Step 1c |
| `auth/admin-restricted-operation` | Anonymous sign-in is off | Step 1c, Anonymous |
| "Missing or insufficient permissions" | Rules not published, or pasted partially | Step 1e |
| Google popup opens then closes instantly | Browser blocked it | The app falls back to a full-page redirect automatically; allow popups to skip that |
| Saving works but cross-device doesn't | You're comparing two *guest* sessions | Guest sessions are per-browser by design; link Google on both |
| Planner shows "Planner offline" | `GEMINI_API_KEY` missing or rate-limited | Step 3b |
| A module-load error in the console | The pinned Firebase SDK version 404s | Bump the version in the `SDK` constant at the top of `js/lifebridge-cloud.js` |

---

## 5. Verify the security rules (optional)

The rules ship with a test suite that proves the isolation claim rather than
asserting it. Needs Java 11 or newer (`java -version` will tell you).

```bash
npm install
npm run test:rules
```

23 tests run against the Firestore emulator. No real project, no real data,
nothing billed. They check that an owner can reach their own plans, that a
second signed-in account cannot read, write, or delete them, that
`collectionGroup("plans")` is denied outright, that `ownerUid` and `createdAt`
cannot be rewritten, and that oversized or unknown fields are rejected.

Good thing to have ready for a judge who asks whether the data is actually
protected.
