// ============================================================================
// LifeBridge — cloud layer (Firebase Auth + Cloud Firestore)
// ============================================================================
//
// Scope, deliberately narrow:
//   Firebase does two things here — it says who the user is, and it stores
//   their saved plans. It never touches Gemini. Every AI call still goes to
//   /.netlify/functions/ai-proxy, where GEMINI_API_KEY lives server-side.
//
// This file is an ES module and is therefore deferred. The main application
// script in index.html is a classic script that runs first and renders from
// localStorage, so LifeBridge is fully usable before this module resolves —
// and stays fully usable if it never does (offline, blocked, unconfigured).
// Communication happens one way: this module publishes `window.LBCloud` and
// fires a `lb:cloud` event; the app listens and re-renders.
//
// If firebase-config.js still holds placeholders, this module short-circuits
// into local-only mode without throwing.
// ============================================================================

import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/12.17.1";
const SCHEMA_VERSION = 1;
const MIGRATE_KEY = "lb_pending_migration"; // survives a redirect sign-in

/* ---------------------------------------------------------------- publish */
const LBCloud = {
  status: "loading", // loading | disabled | ready | error
  user: null, // {uid, isAnonymous, displayName, photoURL, email}
  error: null,
  enabled: false,
};
window.LBCloud = LBCloud;

function publish(patch) {
  Object.assign(LBCloud, patch);
  window.dispatchEvent(
    new CustomEvent("lb:cloud", {
      detail: { status: LBCloud.status, user: LBCloud.user, error: LBCloud.error },
    })
  );
}

/* --------------------------------------------------- local-only shortcut */
if (!firebaseConfigured) {
  publish({
    status: "disabled",
    enabled: false,
    error: "Firebase is not configured yet — running in local-only mode.",
  });
  // Stub the API so index.html never needs to null-check individual methods.
  Object.assign(LBCloud, unavailableApi("Firebase is not configured yet."));
} else {
  boot().catch((e) => {
    console.warn("[LifeBridge] cloud boot failed:", e);
    publish({ status: "error", enabled: false, error: humanError(e) });
    Object.assign(LBCloud, unavailableApi(humanError(e)));
  });
}

function unavailableApi(msg) {
  const nope = async () => {
    throw new Error(msg);
  };
  return {
    signInDemo: nope,
    signInGoogle: nope,
    signOutUser: nope,
    upgradeToGoogle: nope,
    savePlan: nope,
    updatePlan: nope,
    listPlans: async () => [],
    getPlan: nope,
    deletePlan: nope,
    saveProfile: async () => {},
    getProfile: async () => null,
  };
}

/* ================================================================== boot */
async function boot() {
  const [{ initializeApp }, auth_, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);

  const {
    getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged,
    signInAnonymously, signOut, GoogleAuthProvider, signInWithPopup,
    signInWithRedirect, getRedirectResult, linkWithPopup, linkWithRedirect,
    signInWithCredential,
  } = auth_;

  const {
    getFirestore, doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc,
    deleteDoc, query, orderBy, limit, serverTimestamp,
  } = fs;

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  // Keep the guest session across reloads — a guest who closes the tab mid
  // crisis should come back to their plan, not to a blank slate.
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (e) {
    console.warn("[LifeBridge] persistence fallback:", e?.code || e);
  }

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  /* ----------------------------------------------------- path helpers */
  const userRef = (uid) => doc(db, "users", uid);
  const plansRef = (uid) => collection(db, "users", uid, "plans");
  const planRef = (uid, id) => doc(db, "users", uid, "plans", id);

  const requireUid = () => {
    const u = auth.currentUser;
    if (!u) throw new Error("Sign in first to use your account.");
    return u.uid;
  };

  const shapeUser = (u) =>
    u && {
      uid: u.uid,
      isAnonymous: u.isAnonymous,
      displayName: u.displayName || null,
      email: u.email || null,
      photoURL: u.photoURL || null,
    };

  /* -------------------------------------------------------- profile doc */
  // firestore.rules requires a profile write to carry ownerUid, schemaVersion
  // and createdAt. A merge write onto a document that does not exist yet would
  // carry none of them and be rejected — so every profile write funnels through
  // this guard first. It matters because "save my plan" can fire the instant
  // sign-in resolves, before onAuthStateChanged has created the profile.
  let ensuredUid = null;
  async function ensureProfileOnce(u) {
    if (!u) throw new Error("Sign in first to use your account.");
    if (ensuredUid === u.uid) return;
    await ensureProfile(u);
    ensuredUid = u.uid;
  }

  async function ensureProfile(u) {
    const ref = userRef(u.uid);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      // Refresh only the identity fields; never clobber score/currentPlanId.
      await setDoc(
        ref,
        {
          displayName: u.displayName || null,
          isAnonymous: !!u.isAnonymous,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      return snap.data();
    }
    const fresh = {
      ownerUid: u.uid,
      schemaVersion: SCHEMA_VERSION,
      displayName: u.displayName || null,
      isAnonymous: !!u.isAnonymous,
      currentPlanId: null,
      score: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(ref, fresh);
    return fresh;
  }

  async function saveProfile(patch) {
    const uid = requireUid();
    await ensureProfileOnce(auth.currentUser);
    const allowed = {};
    if ("currentPlanId" in patch) allowed.currentPlanId = patch.currentPlanId ?? null;
    if ("score" in patch)
      allowed.score = patch.score == null ? null : clampScore(patch.score);
    allowed.updatedAt = serverTimestamp();
    await setDoc(userRef(uid), allowed, { merge: true });
  }

  async function getProfile() {
    const uid = requireUid();
    const snap = await getDoc(userRef(uid));
    return snap.exists() ? snap.data() : null;
  }

  /* ----------------------------------------------------------- plan CRUD */
  // Build a document that satisfies firestore.rules exactly. Anything the
  // rules do not whitelist is dropped here rather than rejected server-side.
  function buildPlanDoc(input, uid) {
    const plan = input.plan || {};
    const roadmap = (input.roadmap || []).slice(0, 60).map((s) => ({
      label: String(s.label || "").slice(0, 300),
      detail: String(s.detail || "").slice(0, 300),
      done: !!s.done,
      doneAt: s.doneAt ?? null,
    }));
    const total = roadmap.length;
    const done = roadmap.filter((s) => s.done).length;

    return {
      ownerUid: uid,
      schemaVersion: SCHEMA_VERSION,
      title: String(input.title || plan.crisisType || "Recovery plan").slice(0, 140) || "Recovery plan",
      crisisType: input.crisisType ? String(input.crisisType).slice(0, 140) : null,
      crisisId: input.crisisId ? String(input.crisisId).slice(0, 40) : null,
      pillarId: input.pillarId ? String(input.pillarId).slice(0, 40) : null,
      situationText: input.situationText ? String(input.situationText).slice(0, 4000) : null,
      source: input.source === "fallback" ? "fallback" : "ai",
      score: input.score == null ? null : clampScore(input.score),
      plan: sanitizePlan(plan),
      roadmap,
      progress: { done, total, pct: total ? Math.round((done / total) * 100) : 0 },
      archived: false,
    };
  }

  async function savePlan(input) {
    const uid = requireUid();
    const body = buildPlanDoc(input, uid);
    const ref = await addDoc(plansRef(uid), {
      ...body,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await saveProfile({ currentPlanId: ref.id, score: body.score });
    return ref.id;
  }

  // updateDoc merges, so createdAt and ownerUid stay untouched — which is what
  // the immutability checks in firestore.rules require.
  async function updatePlan(id, patch) {
    const uid = requireUid();
    const out = { updatedAt: serverTimestamp() };

    if (patch.roadmap) {
      const roadmap = patch.roadmap.slice(0, 60).map((s) => ({
        label: String(s.label || "").slice(0, 300),
        detail: String(s.detail || "").slice(0, 300),
        done: !!s.done,
        doneAt: s.doneAt ?? null,
      }));
      const total = roadmap.length;
      const done = roadmap.filter((s) => s.done).length;
      out.roadmap = roadmap;
      out.progress = { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
    }
    if ("score" in patch) out.score = patch.score == null ? null : clampScore(patch.score);
    if ("title" in patch) out.title = String(patch.title || "Recovery plan").slice(0, 140);
    if ("archived" in patch) out.archived = !!patch.archived;

    await updateDoc(planRef(uid, id), out);
  }

  async function listPlans(max = 50) {
    const uid = requireUid();
    const snap = await getDocs(
      query(plansRef(uid), orderBy("updatedAt", "desc"), limit(max))
    );
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  async function getPlan(id) {
    const uid = requireUid();
    const snap = await getDoc(planRef(uid, id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  }

  async function deletePlan(id) {
    const uid = requireUid();
    await deleteDoc(planRef(uid, id));
  }

  /* -------------------------------------------------------- auth actions */
  async function signInDemo() {
    if (auth.currentUser) return shapeUser(auth.currentUser);
    const { user } = await signInAnonymously(auth);
    return shapeUser(user);
  }

  // Guest → Google. The whole point is that nothing the guest built is lost.
  //
  // Happy path: linkWithPopup keeps the SAME uid, so every plan document stays
  // exactly where it is. Nothing to copy.
  //
  // Collision path: the Google account already exists as its own Firebase user.
  // Linking is impossible, so we buffer the guest's plans in memory FIRST,
  // sign in as the real account, then re-create the buffered plans under the
  // new uid. Reading has to happen before the switch — after it, the old uid's
  // documents are unreachable by design (that is the security rule working).
  async function signInGoogle() {
    const current = auth.currentUser;

    if (!current || !current.isAnonymous) {
      try {
        const { user } = await signInWithPopup(auth, provider);
        return shapeUser(user);
      } catch (e) {
        if (isPopupProblem(e)) {
          await signInWithRedirect(auth, provider);
          return null; // page navigates away
        }
        throw new Error(humanError(e));
      }
    }

    let buffer = [];
    try {
      buffer = await listPlans(50);
    } catch (e) {
      console.warn("[LifeBridge] could not buffer guest plans:", e);
    }

    try {
      const { user } = await linkWithPopup(current, provider);
      return shapeUser(user); // same uid — plans already belong to it
    } catch (e) {
      const code = e?.code || "";

      if (code === "auth/credential-already-in-use" || code === "auth/email-already-in-use") {
        const cred = GoogleAuthProvider.credentialFromError(e);
        if (!cred) throw new Error(humanError(e));
        const { user } = await signInWithCredential(auth, cred);
        ensuredUid = null;
        await ensureProfileOnce(user);
        const moved = await importPlans(buffer, user.uid);
        return { ...shapeUser(user), migrated: moved };
      }

      if (isPopupProblem(e)) {
        // Redirect leaves the page, so park the buffer where it survives.
        try {
          sessionStorage.setItem(MIGRATE_KEY, JSON.stringify(buffer));
        } catch (_) {}
        await linkWithRedirect(current, provider);
        return null;
      }

      throw new Error(humanError(e));
    }
  }

  async function importPlans(buffer, uid) {
    if (!buffer || !buffer.length) return 0;
    let n = 0;
    for (const p of buffer) {
      try {
        const body = buildPlanDoc(
          {
            title: p.title,
            crisisType: p.crisisType,
            crisisId: p.crisisId,
            pillarId: p.pillarId,
            situationText: p.situationText,
            source: p.source,
            score: p.score,
            plan: p.plan,
            roadmap: p.roadmap,
          },
          uid
        );
        await addDoc(plansRef(uid), {
          ...body,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        n++;
      } catch (e) {
        console.warn("[LifeBridge] plan migration skipped one document:", e);
      }
    }
    return n;
  }

  async function signOutUser() {
    await signOut(auth);
  }

  /* ------------------------------------------------------- wire it up */
  // Done before awaiting getRedirectResult below, so the sign-in button is
  // live as early as possible rather than waiting on a network round trip.
  Object.assign(LBCloud, {
    signInDemo, signInGoogle, signOutUser,
    upgradeToGoogle: signInGoogle,
    savePlan, updatePlan, listPlans, getPlan, deletePlan,
    saveProfile, getProfile,
  });

  onAuthStateChanged(auth, async (u) => {
    ensuredUid = null;
    if (u) {
      try {
        await ensureProfileOnce(u);
      } catch (e) {
        console.warn("[LifeBridge] profile init:", e);
      }
    }
    publish({ status: "ready", enabled: true, user: shapeUser(u), error: null });
  });

  publish({ status: "ready", enabled: true });

  /* -------------------------------------------- returning from a redirect */
  try {
    const res = await getRedirectResult(auth);
    if (res?.user) {
      ensuredUid = null;
      await ensureProfileOnce(res.user);
      const raw = sessionStorage.getItem(MIGRATE_KEY);
      if (raw) {
        sessionStorage.removeItem(MIGRATE_KEY);
        const moved = await importPlans(JSON.parse(raw), res.user.uid);
        if (moved) {
          window.dispatchEvent(
            new CustomEvent("lb:migrated", { detail: { count: moved } })
          );
        }
      }
    }
  } catch (e) {
    const code = e?.code || "";
    if (code === "auth/credential-already-in-use" || code === "auth/email-already-in-use") {
      try {
        const cred = GoogleAuthProvider.credentialFromError(e);
        if (cred) {
          const { user } = await signInWithCredential(auth, cred);
          ensuredUid = null;
          await ensureProfileOnce(user);
          const raw = sessionStorage.getItem(MIGRATE_KEY);
          if (raw) {
            sessionStorage.removeItem(MIGRATE_KEY);
            const moved = await importPlans(JSON.parse(raw), user.uid);
            if (moved)
              window.dispatchEvent(
                new CustomEvent("lb:migrated", { detail: { count: moved } })
              );
          }
        }
      } catch (e2) {
        console.warn("[LifeBridge] redirect collision recovery failed:", e2);
      }
    } else if (code) {
      console.warn("[LifeBridge] redirect result:", code);
    }
  }

}

/* ------------------------------------------------------------- utilities */
function clampScore(v) {
  const n = Number(v) || 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Keep only the ACRE fields, with caps. Firestore rules check `plan is map`;
// this is where the shape is actually enforced, so a malformed model response
// can never bloat or corrupt a stored document.
function sanitizePlan(p) {
  const str = (v, n = 600) => String(v == null ? "" : v).slice(0, n);
  const arr = (v, n = 24) => (Array.isArray(v) ? v.slice(0, n) : []);
  return {
    crisisType: str(p.crisisType, 140),
    acknowledgement: str(p.acknowledgement, 1200),
    immediateNeeds: arr(p.immediateNeeds).map((x) => ({
      title: str(x?.title, 160),
      detail: str(x?.detail, 600),
    })),
    risks: arr(p.risks).map((x) => ({
      dimension: str(x?.dimension, 120),
      level: clampScore(x?.level),
      note: str(x?.note, 400),
    })),
    actions: arr(p.actions, 30).map((x) => ({
      when: str(x?.when, 60),
      task: str(x?.task, 600),
    })),
    documents: arr(p.documents, 30).map((x) => str(x, 240)),
    helpers: arr(p.helpers).map((x) => ({
      who: str(x?.who, 200),
      how: str(x?.how, 600),
    })),
    secondaryRisks: arr(p.secondaryRisks).map((x) => ({
      risk: str(x?.risk, 300),
      prevent: str(x?.prevent, 600),
    })),
  };
}

function isPopupProblem(e) {
  const c = e?.code || "";
  return (
    c === "auth/popup-blocked" ||
    c === "auth/cancelled-popup-request" ||
    c === "auth/operation-not-supported-in-this-environment" ||
    c === "auth/web-storage-unsupported"
  );
}

function humanError(e) {
  const c = e?.code || "";
  const map = {
    "auth/popup-closed-by-user": "Sign-in window closed before finishing.",
    "auth/network-request-failed": "Network problem — check your connection and try again.",
    "auth/unauthorized-domain":
      "This domain isn't authorized in Firebase. Add it under Authentication → Settings → Authorized domains.",
    "auth/operation-not-allowed":
      "That sign-in method is turned off in the Firebase Console. Enable it under Authentication → Sign-in method.",
    "auth/admin-restricted-operation":
      "Anonymous sign-in is disabled. Enable it under Authentication → Sign-in method.",
    "permission-denied": "Your account doesn't have access to that record.",
    "unavailable": "Can't reach the database right now. Your plan is still saved on this device.",
  };
  return map[c] || e?.message || "Something went wrong.";
}
