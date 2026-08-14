// ============================================================================
// LifeBridge — Firebase client configuration
// ============================================================================
//
//  >>> THIS IS THE ONLY FILE YOU EDIT AFTER CREATING YOUR FIREBASE PROJECT. <<<
//
//  Replace the six PASTE_… strings below with the values from:
//    Firebase Console → Project settings (gear icon) → General
//    → "Your apps" → your Web app → "SDK setup and configuration" → Config
//
//  Is it safe to commit this to a public GitHub repo?  Yes.
//  The Firebase web apiKey is an identifier, not a credential. It only tells
//  the SDK which project to talk to. It grants nothing on its own — access is
//  decided by Firebase Auth and by firestore.rules, which is why those rules
//  are written the way they are. Google documents this explicitly.
//
//  What is NOT safe to put here: GEMINI_API_KEY. That one is a real secret and
//  it stays in Netlify → Site configuration → Environment variables, read only
//  by netlify/functions/ai-proxy.js on the server. It must never appear in any
//  file the browser downloads.
//
//  Until you paste real values, LifeBridge runs in local-only mode: every
//  existing feature works, saving to an account is simply disabled.
// ============================================================================

export const firebaseConfig = {
  apiKey:            "AIzaSyCp0ZUCx8ovvYu1EHqNjQcMJwC0i-FRK88",
  authDomain:        "lifebridge-7a8d7.firebaseapp.com",
  projectId:         "lifebridge-7a8d7",
  storageBucket:     "lifebridge-7a8d7.firebasestorage.app",
  messagingSenderId: "679298681918",
  appId:             "1:679298681918:web:a05810ca6cf069cb48d56f",
};

// True once real values are in place. Used to decide between cloud mode and
// local-only mode — no console errors, no broken buttons before setup.
export const firebaseConfigured =
  !Object.values(firebaseConfig).some((v) => String(v).includes("PASTE_"));
