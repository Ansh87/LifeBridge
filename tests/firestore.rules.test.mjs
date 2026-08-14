/**
 * LifeBridge, Firestore security rules test suite
 *
 * Proves the claim in DATA_MODEL.md rather than asserting it: that a signed-in
 * user can reach their own plans and nothing else.
 *
 * Run it:
 *     npm install
 *     npm run test:rules
 *
 * That starts the Firestore emulator against firestore.rules, no real project,
 * no real data, nothing billed. Requires Java 11+ (the emulator is a JVM
 * process); `java -version` will tell you.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, collectionGroup, serverTimestamp,
} from "firebase/firestore";

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, e.message]); }
};

const env = await initializeTestEnvironment({
  projectId: "lifebridge-rules-test",
  firestore: {
    rules: readFileSync("firestore.rules", "utf8"),
    host: "127.0.0.1",
    port: 8080,
  },
});

const ALICE = "alice_uid";
const BOB = "bob_uid";
const alice = env.authenticatedContext(ALICE).firestore();
const bob = env.authenticatedContext(BOB).firestore();
const anon = env.unauthenticatedContext().firestore();

const profile = (uid, over = {}) => ({
  ownerUid: uid, schemaVersion: 1, displayName: "Alice", isAnonymous: false,
  currentPlanId: null, score: 50,
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over,
});

const plan = (uid, over = {}) => ({
  ownerUid: uid, schemaVersion: 1,
  title: "Job loss", crisisType: "Job loss", crisisId: "jobloss", pillarId: "finance",
  situationText: "I lost my job and rent is due.", source: "ai", score: 44,
  plan: { acknowledgement: "…", risks: [{ dimension: "Financial", level: 70, note: "" }] },
  roadmap: [{ label: "Call 211", detail: "Today", done: false, doneAt: null }],
  progress: { done: 0, total: 1, pct: 0 }, archived: false,
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over,
});

/* ---------------------------------------------------------- the happy path */

await test("owner can create their own profile", async () => {
  await assertSucceeds(setDoc(doc(alice, "users", ALICE), profile(ALICE)));
});

await test("owner can create a plan under their own account", async () => {
  await assertSucceeds(addDoc(collection(alice, "users", ALICE, "plans"), plan(ALICE)));
});

await test("owner can read their own plans", async () => {
  await assertSucceeds(getDocs(collection(alice, "users", ALICE, "plans")));
});

await test("owner can update roadmap progress", async () => {
  const ref = doc(alice, "users", ALICE, "plans", "p1");
  await assertSucceeds(setDoc(ref, plan(ALICE)));
  await assertSucceeds(updateDoc(ref, {
    roadmap: [{ label: "Call 211", detail: "Today", done: true, doneAt: null }],
    progress: { done: 1, total: 1, pct: 100 },
    score: 80, updatedAt: serverTimestamp(),
  }));
});

await test("owner can delete their own plan", async () => {
  const ref = doc(alice, "users", ALICE, "plans", "trash");
  await assertSucceeds(setDoc(ref, plan(ALICE)));
  await assertSucceeds(deleteDoc(ref));
});

/* ------------------------------------------------------------- isolation */

await test("another signed-in user CANNOT read your plans", async () => {
  await assertFails(getDocs(collection(bob, "users", ALICE, "plans")));
});

await test("another signed-in user CANNOT read a specific plan", async () => {
  await assertFails(getDoc(doc(bob, "users", ALICE, "plans", "p1")));
});

await test("another signed-in user CANNOT write into your account", async () => {
  await assertFails(addDoc(collection(bob, "users", ALICE, "plans"), plan(ALICE)));
});

await test("another signed-in user CANNOT delete your plan", async () => {
  await assertFails(deleteDoc(doc(bob, "users", ALICE, "plans", "p1")));
});

await test("another signed-in user CANNOT read your profile", async () => {
  await assertFails(getDoc(doc(bob, "users", ALICE)));
});

await test("signed-out visitors can read nothing", async () => {
  await assertFails(getDoc(doc(anon, "users", ALICE)));
  await assertFails(getDocs(collection(anon, "users", ALICE, "plans")));
});

await test("signed-out visitors can write nothing", async () => {
  await assertFails(addDoc(collection(anon, "users", ALICE, "plans"), plan(ALICE)));
});

await test("collectionGroup('plans') is denied even to a signed-in user", async () => {
  // The query shape that could otherwise span every account in the database.
  await assertFails(getDocs(query(collectionGroup(bob, "plans"))));
});

/* ------------------------------------------------------------ forgery */

await test("cannot forge ownerUid to point at someone else", async () => {
  await assertFails(addDoc(collection(bob, "users", BOB, "plans"), plan(ALICE)));
});

await test("cannot rewrite ownerUid on an existing plan", async () => {
  const ref = doc(alice, "users", ALICE, "plans", "p1");
  await assertFails(updateDoc(ref, { ownerUid: BOB, updatedAt: serverTimestamp() }));
});

await test("cannot backdate createdAt", async () => {
  const ref = doc(alice, "users", ALICE, "plans", "p1");
  await assertFails(updateDoc(ref, { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
});

/* ------------------------------------------------------------ validation */

await test("rejects an unknown field", async () => {
  await assertFails(addDoc(collection(alice, "users", ALICE, "plans"),
    plan(ALICE, { isAdmin: true })));
});

await test("rejects a missing title", async () => {
  const p = plan(ALICE); delete p.title;
  await assertFails(addDoc(collection(alice, "users", ALICE, "plans"), p));
});

await test("rejects an out-of-range score", async () => {
  await assertFails(addDoc(collection(alice, "users", ALICE, "plans"),
    plan(ALICE, { score: 5000 })));
});

await test("rejects situationText over the 4000-char cap", async () => {
  await assertFails(addDoc(collection(alice, "users", ALICE, "plans"),
    plan(ALICE, { situationText: "x".repeat(4001) })));
});

await test("rejects a roadmap longer than 60 steps", async () => {
  await assertFails(addDoc(collection(alice, "users", ALICE, "plans"),
    plan(ALICE, { roadmap: Array.from({ length: 61 }, () => ({ label: "s", detail: "", done: false, doneAt: null })) })));
});

await test("rejects an unrecognised source value", async () => {
  await assertFails(addDoc(collection(alice, "users", ALICE, "plans"),
    plan(ALICE, { source: "scraped" })));
});

await test("rejects a write to an undeclared top-level collection", async () => {
  await assertFails(setDoc(doc(alice, "anything", "goes"), { x: 1 }));
});

/* ---------------------------------------------------------------- report */

await env.cleanup();

let failed = 0;
for (const [status, name, msg] of results) {
  if (status === "FAIL") failed++;
  console.log(`${status}  ${name}${msg ? `\n      ${msg}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
