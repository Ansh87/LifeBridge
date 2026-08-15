/* ============================================================================
   LifeBridge Recovery Engine (ACRE, Adaptive Crisis Recovery Engine)
   ============================================================================

   Loaded as a classic script before the application logic in index.html, so
   everything here is available as a global to the UI layer.

   This file is the decision-support core. It is deliberately separate from the
   presentation code, because the claim LifeBridge makes is that it performs
   structured reasoning rather than generating prose. That claim is easier to
   trust when the reasoning is a readable artifact.

   Six stages, used as consistent vocabulary across the whole product:
       Understand -> Assess -> Prioritize -> Plan -> Connect -> Recover

   Two things this file is careful about:

   1. Scores are STABILITY, not risk. Higher is better, everywhere. Mixing the
      two directions was the single easiest way to ship a bug that tells someone
      in crisis the opposite of the truth.

   2. Nothing here is a clinical, legal, financial or eligibility determination.
      Wording is hedged on purpose ("may help with", "check eligibility") and
      the score is labelled an estimate. Do not tighten that language.
   ========================================================================== */

/* ---------------------------------------------------------------- stages */
const ENGINE_STEPS = [
  { id: "understand", label: "Understand", blurb: "Tell LifeBridge what happened." },
  { id: "assess",     label: "Assess",     blurb: "LifeBridge evaluates needs across key areas." },
  { id: "prioritize", label: "Prioritize", blurb: "See what may require attention first." },
  { id: "plan",       label: "Plan",       blurb: "Receive a personalized recovery roadmap." },
  { id: "connect",    label: "Connect",    blurb: "Find relevant support and resources." },
  { id: "recover",    label: "Recover",    blurb: "Complete actions and track your progress." },
];

/* ------------------------------------------------------------ dimensions */
/* Fixed set, on purpose. Letting the model invent its own axes made scores
   incomparable between two people and impossible to explain. */
const DIMENSIONS = [
  { id: "housing",   label: "Housing Stability",  short: "Housing"   },
  { id: "financial", label: "Financial Stability", short: "Financial" },
  { id: "food",      label: "Food & Essentials",   short: "Food"      },
  { id: "health",    label: "Health & Wellbeing",  short: "Health"    },
  { id: "family",    label: "Family / Education",  short: "Family"    },
  { id: "safety",    label: "Personal Safety",     short: "Safety"    },
];
const DIM_IDS = DIMENSIONS.map(d => d.id);
const DIM_BY_ID = Object.fromEntries(DIMENSIONS.map(d => [d.id, d]));

/* Bands describe the score in words as well as a number, so the meaning does
   not depend on reading a colour. */
const SCORE_BANDS = [
  { min: 80, label: "Stable ground",   tone: "good" },
  { min: 60, label: "Making progress", tone: "good" },
  { min: 40, label: "Needs attention", tone: "warn" },
  { min: 20, label: "High need",       tone: "bad"  },
  { min: 0,  label: "Urgent need",     tone: "bad"  },
];

function scoreBand(score) {
  const s = clampScore(score);
  return SCORE_BANDS.find(b => s >= b.min) || SCORE_BANDS[SCORE_BANDS.length - 1];
}

function clampScore(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/* Urgency buckets for roadmap actions, in display order. */
const WHEN_BUCKETS = [
  { id: "now",   label: "Do now",     note: "Genuinely urgent" },
  { id: "today", label: "Today",      note: "Important today" },
  { id: "week",  label: "This week",  note: "Near-term recovery" },
  { id: "month", label: "This month", note: "Longer-term stabilization" },
];

function normalizeWhen(when) {
  const w = String(when || "").toLowerCase();
  if (/(now|immediate|right away|urgent|first)/.test(w)) return "now";
  if (/(today|tonight|24 hour)/.test(w))                 return "today";
  if (/(week|few days|coming days)/.test(w))             return "week";
  if (/(month|longer|ongoing|later)/.test(w))            return "month";
  return "week";
}

/* Map whatever label the model used onto one of the six fixed dimensions. Also
   used as a fallback over an action's own wording when the model omits the
   field, so the vocabulary has to cover programme names and plain speech, not
   only the dimension words themselves.

   Word boundaries are not decoration here. Bare substrings quietly mislabel:
   "discard" contains "card", "parent" contains "rent", "please" contains
   "lease", "female" contains "fema", "fundamental" contains "mental". Every one
   of those sent an action to the wrong area of someone's assessment, silently.
   Short or ambiguous tokens are anchored; long distinctive ones are left open
   so they still catch inflections like "housing" and "evicted".

   Order matters. Specific programme names sit ahead of the generic terms that
   would otherwise swallow them. Returns null when nothing matches confidently. */
function matchDimension(name) {
  const s = String(name || "").toLowerCase();
  if (DIM_IDS.includes(s)) return s;

  // Named food programmes first: "SNAP eligibility" is about food, but
  // "eligibility" on its own reads as financial.
  if (/(\bsnap\b|\bwic\b|food bank|food stamp|pantry|school meal|grocer|meals on wheels)/.test(s)) return "food";

  // Specific school contacts before the generic care vocabulary, so "school
  // counselor" lands on family rather than on health via "counsel".
  if (/(school counsel|family liaison|school office|\bteacher\b|principal|daycare|childcare)/.test(s)) return "family";

  // Physical safety and the reporting that goes with it, ahead of "legal".
  if (/(police|theft|stolen|robbed|assault|abuse|violence|danger|threat|unsafe|restraining|\b911\b|\b988\b|crisis line)/.test(s)) return "safety";

  if (/(\bhous|\brent\b|\brental|evict|landlord|mortgage|\blease\b|shelter|\broof\b|repair|contractor|\bfema\b|red cross)/.test(s)) return "housing";
  if (/(financ|\bmoney\b|income|\bwages?\b|\bjobs?\b|employ|\bdebts?\b|benefit|\bbills?\b|payment|\bbanks?\b|\bcards?\b|\bclaims?\b|insur|fraud|credit|\bloans?\b|survivor|deposit|refund|reimburse)/.test(s)) return "financial";
  if (/(\bfood\b|hunger|\bmeals?\b|nutrition|essential|utilit|\bwater\b|\bheat\b|electric)/.test(s)) return "food";
  if (/(health|medical|\bmental\b|emotion|grief|wellbeing|well-being|illness|doctor|hospital|therap|counsel|prescription|mould|\bmold\b)/.test(s)) return "health";
  if (/(child|\bschool\b|educat|family|\bkids?\b|student|depend|\bparent|caregiv)/.test(s)) return "family";
  if (/(\bsafe|legal|protect|security|passport|embassy|consulate|court|lawyer|attorney)/.test(s)) return "safety";

  return null;   // no confident match
}

/* Explicit labels go through here: a dimension must come out, so an
   unrecognized label falls back to financial rather than vanishing. */
function normalizeDimension(name) {
  return matchDimension(name) || "financial";
}

/* ================================================================= prompt */
/* The schema the model must return. Richer than the first version because the
   product now has to explain itself: every priority carries a reason, every
   action carries why it matters and which dimension it moves. */
const ACRE_SYSTEM = `You are the LifeBridge Recovery Engine, the reasoning core of a crisis-recovery decision-support tool. A person in a difficult life situation describes what they are facing.

Be warm but practical and specific. You are NOT a lawyer, doctor, therapist, emergency service or government agency, and you never claim to be. Never state that someone qualifies for a program; say they may qualify and should check eligibility.

Output ONLY valid JSON, no markdown fences, with exactly this shape:
{
 "crisisType": "short label, 2-5 words",
 "acknowledgement": "2-3 warm sentences showing you understood THEIR specific situation, referencing details they gave",
 "priorities": [
   {"title":"Short action-oriented label","urgency":"High|Medium|Low","why":"one sentence grounded in what they told you","nextStep":"one concrete next step","dimension":"housing|financial|food|health|family|safety"}
 ],
 "dimensions": [
   {"id":"housing","score":0-100,"why":"one short sentence"},
   {"id":"financial","score":0-100,"why":"..."},
   {"id":"food","score":0-100,"why":"..."},
   {"id":"health","score":0-100,"why":"..."},
   {"id":"family","score":0-100,"why":"..."},
   {"id":"safety","score":0-100,"why":"..."}
 ],
 "actions": [
   {"when":"Do now|Today|This week|This month","task":"concrete, specific step","why":"one sentence on why it matters","dimension":"housing|financial|food|health|family|safety"}
 ],
 "documents": ["specific document to gather"],
 "helpers": [{"who":"Program or organization type","what":"what it is","how":"how it may help and how to reach it"}],
 "risksToWatch": [{"risk":"what may become a problem next","why":"why it may follow from their situation","prevent":"how to get ahead of it"}]
}

Rules:
- "dimensions" MUST contain all six ids exactly once. Scores are STABILITY: 100 means fully stable, 0 means in crisis. A person who just lost their income has LOW financial stability.
- "priorities" MUST contain exactly 3, ordered most urgent first, and must reflect THIS person's circumstances rather than generic advice for the category.
- "actions": 4 to 8 items, spread across the time buckets. Include a "Do now" item only when something is genuinely urgent.
- 3 to 5 items for documents, helpers and risksToWatch.
- If there is any sign of immediate physical danger, abuse, or self-harm: make the first priority contacting emergency services or the 988 Suicide and Crisis Lifeline, set safety stability low, and put a "Do now" action first.`;

function buildPrompt(text, crisis) {
  let ctx = "";
  if (crisis) {
    ctx = `\n\nContext: the person selected the situation "${crisis.name}".` +
          ` Areas typically affected: ${(crisis.dims || []).join(", ")}.`;
  }
  return `The person writes:\n"""${text}"""${ctx}\n\nProduce the LifeBridge Recovery Engine JSON now.`;
}

/* =============================================================== normalize */
/* Takes anything plan-shaped, whether fresh model output, the offline
   framework, or a plan saved by an earlier version of the app, and returns one
   canonical structure. Everything downstream can then assume the shape.

   Backward compatibility matters here: plans already saved to Firestore use
   `risks: [{dimension, level}]` where level was severity (higher was worse) and
   `secondaryRisks`. Those must keep opening correctly. */
function normalizePlan(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const str = (v, n) => String(v == null ? "" : v).slice(0, n || 400).trim();
  const arr = (v) => (Array.isArray(v) ? v : []);

  /* ---- dimensions ---- */
  const dimScores = {};
  const dimWhy = {};

  if (arr(p.dimensions).length) {
    arr(p.dimensions).forEach(d => {
      const id = normalizeDimension(d && (d.id || d.dimension));
      dimScores[id] = clampScore(d && d.score);
      if (d && d.why) dimWhy[id] = str(d.why, 220);
    });
  } else if (arr(p.risks).length) {
    // legacy: risk severity, invert into stability
    arr(p.risks).forEach(r => {
      const id = normalizeDimension(r && r.dimension);
      const stability = 100 - clampScore(r && r.level);
      // if two legacy risks map to the same dimension, keep the worse one
      dimScores[id] = id in dimScores ? Math.min(dimScores[id], stability) : stability;
      if (r && r.note) dimWhy[id] = str(r.note, 220);
    });
  }

  // any dimension the model skipped defaults to a neutral, clearly-unassessed 60
  const dimensions = DIMENSIONS.map(d => ({
    id: d.id,
    label: d.label,
    score: d.id in dimScores ? dimScores[d.id] : 60,
    assessed: d.id in dimScores,
    why: dimWhy[d.id] || "",
  }));

  /* ---- priorities ---- */
  let priorities = arr(p.priorities).slice(0, 3).map(x => ({
    title: str(x && x.title, 80) || "Priority",
    urgency: /high/i.test(String(x && x.urgency)) ? "High"
           : /low/i.test(String(x && x.urgency)) ? "Low" : "Medium",
    why: str(x && x.why, 240),
    nextStep: str(x && x.nextStep, 240),
    dimension: normalizeDimension(x && x.dimension),
  }));

  // Legacy plans carry no priorities, so derive them from the weakest areas.
  // Assessed dimensions rank first, but unassessed ones can fill the remaining
  // slots: a plan that only ever scored two areas should still show three
  // priorities rather than a short, oddly empty list.
  if (priorities.length < 3) {
    const taken = new Set(priorities.map(x => x.dimension));
    const ranked = dimensions
      .filter(d => !taken.has(d.id))
      .sort((a, b) =>
        (a.assessed === b.assessed) ? a.score - b.score : (a.assessed ? -1 : 1));

    for (const d of ranked) {
      if (priorities.length >= 3) break;
      priorities.push({
        title: d.label,
        urgency: d.score < 35 ? "High" : d.score < 60 ? "Medium" : "Low",
        why: d.why || (d.assessed
          ? "This area scored lowest in your assessment."
          : "This area was not assessed in detail, so it is worth a look."),
        nextStep: "Review the roadmap actions linked to this area.",
        dimension: d.id,
      });
    }
  }

  /* ---- actions ---- */
  const actions = arr(p.actions).slice(0, 40).map(a => {
    const task = str(a && a.task, 300);
    return {
      when: normalizeWhen(a && a.when),
      task,
      why: str(a && a.why, 240),
      // Model label first, then inference from the wording. Never the time
      // bucket: "today" matches no dimension, so the old fallback quietly
      // labelled every unlabelled action financial. If nothing matches
      // confidently the action stays unlinked and moves no score, which is
      // better than attributing recovery to an area it did not touch.
      dimension: (a && a.dimension ? normalizeDimension(a.dimension) : null)
                 || matchDimension(task + " " + str(a && a.why, 240)),
    };
  }).filter(a => a.task);

  /* ---- risks to watch ---- */
  const risksToWatch = arr(p.risksToWatch).length
    ? arr(p.risksToWatch).slice(0, 6).map(r => ({
        risk: str(r && r.risk, 200),
        why: str(r && r.why, 240),
        prevent: str(r && r.prevent, 240),
      })).filter(r => r.risk)
    : arr(p.secondaryRisks).slice(0, 6).map(r => ({   // legacy field name
        risk: str(r && r.risk, 200),
        why: "",
        prevent: str(r && r.prevent, 240),
      })).filter(r => r.risk);

  /* ---- helpers ---- */
  const helpers = arr(p.helpers).slice(0, 8).map(h => ({
    who: str(h && h.who, 160),
    what: str(h && h.what, 240),
    how: str(h && h.how, 300),
  })).filter(h => h.who);

  return {
    engineVersion: 2,
    crisisType: str(p.crisisType, 140) || "Recovery plan",
    acknowledgement: str(p.acknowledgement, 900),
    priorities,
    dimensions,
    actions,
    documents: arr(p.documents).slice(0, 12).map(d => str(d, 200)).filter(Boolean),
    helpers,
    risksToWatch,
    isSample: !!p.isSample,
  };
}

/* ================================================================ scoring */
/* The relationship the product claims: assessment sets a baseline, completing
   roadmap actions moves the specific dimension that action supports, and the
   LifeBridge Score is the average of the six.

   Deliberate ceiling: completing every action linked to a dimension closes at
   most RECOVERY_CEILING of the gap to 100. Checking boxes is evidence of
   progress, not proof of stability, and a score that hits 100 from checkboxes
   alone would be dishonest to someone still in a hard situation. */
const RECOVERY_CEILING = 0.5;

function dimensionProgress(plan, roadmap) {
  const out = {};
  DIM_IDS.forEach(id => { out[id] = { total: 0, done: 0 }; });
  (roadmap || []).forEach(step => {
    const id = DIM_IDS.includes(step.dimension) ? step.dimension : null;
    if (!id) return;
    out[id].total++;
    if (step.done) out[id].done++;
  });
  return out;
}

function currentDimensions(plan, roadmap) {
  const prog = dimensionProgress(plan, roadmap);
  return (plan.dimensions || []).map(d => {
    const p = prog[d.id] || { total: 0, done: 0 };
    const gain = p.total
      ? (100 - d.score) * RECOVERY_CEILING * (p.done / p.total)
      : 0;
    return {
      ...d,
      base: d.score,
      current: clampScore(d.score + gain),
      actionsTotal: p.total,
      actionsDone: p.done,
    };
  });
}

function lifeBridgeScore(plan, roadmap) {
  const dims = currentDimensions(plan, roadmap);
  if (!dims.length) return null;
  const sum = dims.reduce((a, d) => a + d.current, 0);
  return clampScore(sum / dims.length);
}

function baselineScore(plan) {
  const dims = plan && plan.dimensions;
  if (!dims || !dims.length) return null;
  return clampScore(dims.reduce((a, d) => a + clampScore(d.score), 0) / dims.length);
}

function recoveryProgress(roadmap) {
  const total = (roadmap || []).length;
  const done = (roadmap || []).filter(s => s.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

/* Build the tracked roadmap from a plan. Document gathering is included as real
   work, because for most of these situations it genuinely is.

   Those steps carry no dimension on purpose. One certified death certificate
   unlocks the benefit claim, the landlord conversation and the school at the
   same time; crediting a single area would overstate it and understate the
   others. They count toward recovery progress without moving any one score. */
function seedRoadmapFromPlan(plan) {
  const steps = (plan.actions || []).map(a => ({
    label: a.task,
    detail: a.why,
    when: a.when,
    dimension: a.dimension,
    done: false,
  }));
  (plan.documents || []).slice(0, 3).forEach(d => {
    steps.push({
      label: "Gather: " + d,
      detail: "Having this ready speeds up almost every application and appointment.",
      when: "week",
      dimension: null,   // deliberately cross-cutting, see above
      kind: "document",
      done: false,
    });
  });
  return steps;
}

/* The single next thing worth doing, used on plan cards and by the assistant. */
function nextAction(roadmap) {
  const order = { now: 0, today: 1, week: 2, month: 3 };
  return (roadmap || [])
    .filter(s => !s.done)
    .sort((a, b) => (order[a.when] ?? 2) - (order[b.when] ?? 2))[0] || null;
}

/* =========================================================== demo scenarios */
/* Three written examples so the product can be understood without typing.
   All three are fictional and contain no real person's information.

   Each carries a hand-written plan. That is not decoration: if the live planner
   is unavailable, rate limited, or slow, the demo still shows the complete
   experience. A demo that depends on an external API is a demo that fails in
   front of an audience. When the planner IS reachable, the engine runs for real
   on the scenario text and these are never used.

   The three are chosen to be genuinely different in shape, not three flavours
   of the same crisis: a slow rebuild with dependents, a physical disaster with
   an insurance and agency process, and an acute emergency far from any of your
   usual support. */

const DEMO_SCENARIOS = [
  {
    id: "family_loss",
    label: "Family Loss",
    recommended: true,
    blurb: "See how LifeBridge supports a parent rebuilding after the loss of a spouse.",
    crisisId: "spouse_loss",
    text: "My spouse died unexpectedly three weeks ago. I have two children in " +
          "elementary and middle school. My spouse was the main earner, so there is " +
          "no household income coming in right now. Rent is due at the end of the " +
          "month and we have very little in savings. I am worried about keeping the " +
          "kids in the same school and keeping things steady for them. My sister " +
          "lives nearby and has been helping some.",
    plan: {
      isSample: true,
      crisisType: "Loss of a spouse",
      acknowledgement:
        "Losing your spouse three weeks ago and becoming the only parent overnight is an enormous amount to carry, and doing it while the household income has stopped makes it heavier still. The fact that your sister is nearby matters more than it might feel right now. Here is what appears to need attention first, and what can reasonably wait.",
      priorities: [
        { title: "Protect your housing", urgency: "High", dimension: "housing",
          why: "Household income has stopped and rent is due at the end of this month.",
          nextStep: "Call 211 and ask about emergency rental assistance in your county, then tell your landlord in writing what has happened." },
        { title: "Restart household income", urgency: "High", dimension: "financial",
          why: "Your spouse was the main earner, and survivor benefits for you and two children can take weeks to begin.",
          nextStep: "Contact the Social Security Administration about survivor benefits. Children under 18 may qualify as well." },
        { title: "Keep your children steady", urgency: "Medium", dimension: "family",
          why: "Two school-age children have just lost a parent, and school routine is one of the few things still holding steady.",
          nextStep: "Tell each child's school counselor what has happened so they can watch for changes and connect you with family support." },
      ],
      dimensions: [
        { id: "housing",   score: 34, why: "Rent is due soon with no income to cover it." },
        { id: "financial", score: 22, why: "The main earner's income stopped and savings are limited." },
        { id: "food",      score: 55, why: "Groceries are manageable now but depend on the same lost income." },
        { id: "health",    score: 58, why: "Grief is very recent for you and for both children." },
        { id: "family",    score: 47, why: "Both children are in school and have just lost a parent." },
        { id: "safety",    score: 88, why: "No indication of danger in the home." },
      ],
      actions: [
        { when: "Today", dimension: "financial", task: "Request at least 10 certified copies of the death certificate",
          why: "Nearly every benefit, bank, insurance and school process will ask for one, and reordering later costs weeks." },
        { when: "Today", dimension: "housing", task: "Call 211 and ask about emergency rental and utility assistance",
          why: "Most emergency rental funds are local and time limited, so applying before rent is late matters." },
        { when: "This week", dimension: "financial", task: "Contact the Social Security Administration about survivor benefits",
          why: "A surviving parent and children under 18 may qualify, and payments are not backdated indefinitely." },
        { when: "This week", dimension: "family", task: "Tell each child's school counselor what has happened",
          why: "Schools can adjust expectations, watch for changes, and connect you with a family liaison." },
        { when: "This week", dimension: "housing", task: "Write to your landlord explaining the change and asking about a payment plan",
          why: "A written record of good-faith contact before rent is missed strengthens your position later." },
        { when: "This week", dimension: "financial", task: "Locate any life insurance policy, including through your spouse's employer",
          why: "Employer-provided coverage is the most commonly missed policy, and claims cannot start until it is found." },
        { when: "This month", dimension: "food", task: "Check SNAP eligibility using your new household income",
          why: "Eligibility is based on current income, not last year's, so a recent change can qualify a household that did not before." },
        { when: "This month", dimension: "health", task: "Find a grief support option for you and for the children",
          why: "Grief support for children often looks different from adult support, and schools frequently know local options." },
      ],
      documents: [
        "Death certificate, several certified copies",
        "Marriage certificate",
        "Children's birth certificates and Social Security numbers",
        "Most recent pay stubs and last year's tax return",
        "Lease agreement and recent rent receipts",
        "Any life insurance policy documents",
      ],
      helpers: [
        { who: "Social Security survivor benefits", what: "Federal monthly benefits for a surviving spouse and children",
          how: "May provide ongoing income for you and each child under 18. Apply by phone or at a local office." },
        { who: "211 community resource line", what: "Free local referral service, available in most of the US",
          how: "Connects you with emergency rental assistance, utility help and food programs in your county." },
        { who: "School family liaison or counselor", what: "Support staff at your children's schools",
          how: "May help with meal programs, fee waivers, counseling and keeping routine steady." },
        { who: "Legal aid for estate matters", what: "Free or reduced-cost civil legal help",
          how: "May help with the estate, benefit claims and any landlord dispute if one develops." },
      ],
      risksToWatch: [
        { risk: "Housing instability", why: "Rent depends on income that has stopped, and assistance can take time to arrive.",
          prevent: "Apply for rental assistance before rent is late, and keep every landlord conversation in writing." },
        { risk: "Food insecurity", why: "The same lost income covers groceries, so pressure usually shows up here next.",
          prevent: "Check SNAP and school meal programs now rather than waiting until the cupboard is bare." },
        { risk: "School disruption", why: "Grief, a possible move and changed routine all affect attendance and schoolwork.",
          prevent: "Keep the school informed so support can start before grades or attendance slip." },
        { risk: "Delayed grief in the children", why: "Children often carry on normally for weeks, then struggle later.",
          prevent: "Set up a check-in with the school counselor now, so someone is watching alongside you." },
      ],
    },
  },

  {
    id: "flood",
    label: "Flood Recovery",
    recommended: false,
    blurb: "See how LifeBridge prioritizes shelter, insurance, resources, and rebuilding.",
    crisisId: "disaster",
    text: "A storm flooded our house four days ago. About two feet of water came " +
          "through the ground floor and the furnace and water heater are ruined. We " +
          "are a family of four staying with my brother-in-law right now, but that " +
          "cannot last more than a week or two. I have homeowners insurance but I do " +
          "not know if flood is covered. I have not registered with FEMA yet. I am " +
          "still working, but I have already spent money on a hotel and supplies.",
    plan: {
      isSample: true,
      crisisType: "Flood and storm recovery",
      acknowledgement:
        "Four days after two feet of water came through your home, with four people in a place that can only hold you for another week or so, the pressure to fix everything at once is intense. Your income has not stopped, which gives you more room than most people in this situation. The order below matters: a few things done in the next few days protect money and options you cannot get back later.",
      priorities: [
        { title: "Register with FEMA and start the insurance claim", urgency: "High", dimension: "financial",
          why: "Assistance and claims both have deadlines, and standard homeowners policies usually exclude flood, so you need to know which applies before spending more.",
          nextStep: "Register at DisasterAssistance.gov and call your insurer to ask specifically whether you have separate flood coverage." },
        { title: "Secure housing beyond the next two weeks", urgency: "High", dimension: "housing",
          why: "You are staying somewhere that can only hold four people for another week or two, and the house has no working furnace or water heater.",
          nextStep: "Ask FEMA about temporary housing assistance and contact the Red Cross about longer-term options in your area." },
        { title: "Document everything before you clean up", urgency: "Medium", dimension: "financial",
          why: "Photographs taken before removal are the evidence every claim and appeal depends on, and they cannot be recreated once the debris is gone.",
          nextStep: "Photograph every damaged room, appliance and item, and keep receipts for every expense from the day of the flood." },
      ],
      dimensions: [
        { id: "housing",   score: 18, why: "The home is uninhabitable and the current arrangement ends within two weeks." },
        { id: "financial", score: 38, why: "Income continues, but out-of-pocket costs are mounting and coverage is unconfirmed." },
        { id: "food",      score: 62, why: "Meals are covered for now through family, without a kitchen of your own." },
        { id: "health",    score: 52, why: "Floodwater, mould and a lost furnace all carry health risk during cleanup." },
        { id: "family",    score: 58, why: "Four people are displaced together, which is stressful but stable for now." },
        { id: "safety",    score: 45, why: "The property has standing-water damage and damaged utilities." },
      ],
      actions: [
        { when: "Do now", dimension: "safety", task: "Do not restart the furnace, water heater or any flooded electrics until an electrician or utility has checked them",
          why: "Flood-damaged gas and electrical equipment is a fire and carbon monoxide risk, and insurers can deny claims for damage caused by restarting it." },
        { when: "Today", dimension: "financial", task: "Register with FEMA at DisasterAssistance.gov",
          why: "Registration windows for a declared disaster close, and registering early does not commit you to anything." },
        { when: "Today", dimension: "financial", task: "Photograph every damaged room and item before removing anything",
          why: "Once debris is hauled away the evidence is gone, and this is what claims and appeals turn on." },
        { when: "Today", dimension: "financial", task: "Call your insurer and ask specifically whether you have flood coverage",
          why: "Standard homeowners policies usually exclude flood, so knowing now changes which route you pursue." },
        { when: "This week", dimension: "housing", task: "Ask FEMA about temporary housing assistance and contact the Red Cross",
          why: "Your current arrangement ends in about two weeks, and these programmes take time to process." },
        { when: "This week", dimension: "financial", task: "Start a single folder or photo album for every receipt since the flood",
          why: "Hotel, supplies and meals are frequently reimbursable, but only against records you kept at the time." },
        { when: "This week", dimension: "health", task: "Use gloves, boots and an N95 mask for any cleanup, and discard soaked porous materials",
          why: "Floodwater is contaminated and mould can establish within 48 hours in wet drywall and carpet." },
        { when: "This month", dimension: "financial", task: "Check SBA disaster loan eligibility, which is open to homeowners and renters",
          why: "Widely assumed to be for businesses only, it is often the largest source of rebuild funding available to a household." },
        { when: "This month", dimension: "housing", task: "Verify any contractor's licence and never pay in full up front",
          why: "Contractor fraud spikes after disasters, and it targets people under time pressure." },
      ],
      documents: [
        "Homeowners or renters insurance policy, full document",
        "Photographs and video of all damage, before cleanup",
        "FEMA registration number",
        "Proof of residence, such as a utility bill or lease",
        "Receipts for every expense since the flood",
        "Serial numbers or receipts for major damaged appliances",
      ],
      helpers: [
        { who: "FEMA disaster assistance", what: "Federal help after a declared disaster",
          how: "May cover temporary housing, home repair and other disaster-caused needs. Register at DisasterAssistance.gov." },
        { who: "American Red Cross", what: "Emergency shelter, meals and relief supplies",
          how: "Usually the fastest source of shelter and essentials in the first days after a disaster." },
        { who: "Your insurance adjuster", what: "The person who assesses and prices your claim",
          how: "You may request a re-inspection if the assessment misses damage. Keep your own photographs to compare." },
        { who: "SBA disaster loans", what: "Low-interest federal loans for disaster losses",
          how: "Open to homeowners and renters, not only businesses, and often the largest available funding." },
      ],
      risksToWatch: [
        { risk: "Mould and long-term health effects", why: "Mould establishes in wet drywall, insulation and carpet within about 48 hours.",
          prevent: "Remove soaked porous materials rather than drying them in place, and ventilate aggressively." },
        { risk: "Contractor fraud", why: "Unlicensed contractors target disaster areas where people are under time pressure.",
          prevent: "Verify licences, get written estimates, and never pay the full amount before work is finished." },
        { risk: "An underpaid insurance claim", why: "First assessments frequently miss damage inside walls, under floors and in mechanical systems.",
          prevent: "Keep your own photographic record and ask for a re-inspection if the assessment looks low." },
        { risk: "Housing running out before repairs finish", why: "Rebuilding usually takes months while temporary arrangements last weeks.",
          prevent: "Start looking for a medium-term rental now, rather than when the current arrangement ends." },
      ],
    },
  },

  {
    id: "travel",
    label: "Travel Emergency",
    recommended: false,
    blurb: "See how LifeBridge guides someone after losing critical documents and money abroad.",
    crisisId: "travel",
    text: "I am travelling abroad and my bag was stolen this morning with my " +
          "passport, my wallet with both bank cards and cash, and my phone. I am a " +
          "US citizen. I have three days left on my hotel booking and my flight home " +
          "is in five days. I do not speak the local language well and I have no way " +
          "to call anyone. I have a photo of my passport saved in my email.",
    plan: {
      isSample: true,
      crisisType: "Travel emergency abroad",
      acknowledgement:
        "Losing your passport, both cards and your phone at once, in a country where you do not speak the language, removes almost every normal way of solving a problem at the same moment. Two things are working in your favour: you have five days before your flight, and you have a photo of your passport, which will make the replacement noticeably faster. The order below is deliberate, because some of these steps unlock the others.",
      priorities: [
        { title: "Stop the cards and start the passport replacement", urgency: "High", dimension: "financial",
          why: "Both bank cards and your passport are in someone else's hands, and your flight home is in five days.",
          nextStep: "Use hotel wifi and a borrowed device or laptop to freeze both cards, then contact the nearest US embassy about an emergency passport." },
        { title: "File a local police report", urgency: "High", dimension: "safety",
          why: "Nearly every next step, the embassy, your travel insurer and your bank, will ask for a report number.",
          nextStep: "Ask hotel reception to help you find the nearest station and to translate, then keep a photo of the report." },
        { title: "Get emergency funds in reach", urgency: "High", dimension: "financial",
          why: "You have no cash and no working cards, and your hotel booking runs out in three days.",
          nextStep: "Arrange a wire transfer to a cash pickup point, or ask the embassy about their emergency financial assistance options." },
      ],
      dimensions: [
        { id: "housing",   score: 30, why: "The hotel is paid for three more days with no means to extend it." },
        { id: "financial", score: 12, why: "No cash, no working cards, and no phone to manage accounts." },
        { id: "food",      score: 35, why: "Meals depend on funds that are currently unreachable." },
        { id: "health",    score: 70, why: "No injury reported, though stress and isolation are high." },
        { id: "family",    score: 60, why: "No dependents present, but contact with people at home has been cut off." },
        { id: "safety",    score: 40, why: "Recently targeted by theft, without identification, in an unfamiliar place." },
      ],
      actions: [
        { when: "Do now", dimension: "financial", task: "Freeze or cancel both bank cards, using hotel wifi and any borrowed device",
          why: "Fraud losses grow by the hour, and most banks limit your liability only from the moment you report." },
        { when: "Do now", dimension: "safety", task: "Report the theft to the local police and get a written report or a report number",
          why: "The embassy, your insurer and your bank will each ask for it, and it is far harder to obtain after you leave the country." },
        { when: "Today", dimension: "safety", task: "Contact the nearest US embassy or consulate about an emergency passport",
          why: "They can issue a limited-validity passport quickly, often within a day or two, which is what gets you onto your flight." },
        { when: "Today", dimension: "financial", task: "Email your passport photo to yourself again and print a copy at the hotel",
          why: "Having the number and a printable image measurably speeds up the replacement." },
        { when: "Today", dimension: "financial", task: "Arrange emergency funds through a wire transfer to a cash pickup point",
          why: "Cash pickup does not require a card or a phone, only photo identification, which the embassy can help with." },
        { when: "This week", dimension: "housing", task: "Tell the hotel what happened and ask about extending on a card held on file",
          why: "Many hotels will extend on an existing authorization when they know the circumstances." },
        { when: "This week", dimension: "financial", task: "Open a claim with your travel insurer, or your card issuer if the trip was booked on it",
          why: "Stolen belongings, emergency accommodation and replacement documents are often covered, but claims have short windows." },
        { when: "This month", dimension: "financial", task: "Place a fraud alert on your credit once home, and change passwords for accounts on the stolen phone",
          why: "A stolen phone plus identity documents is the combination most often used for account takeover afterwards." },
      ],
      documents: [
        "Any remaining photo identification",
        "Passport number and the saved photo of the passport page",
        "Police report or report number",
        "Travel insurance policy number",
        "Flight booking reference",
        "Bank contact numbers, from the bank's website rather than memory",
      ],
      helpers: [
        { who: "Nearest US embassy or consulate", what: "Official US diplomatic post",
          how: "May issue an emergency passport, contact family on your behalf, and explain local options for funds." },
        { who: "Local police", what: "The authority that issues the theft report",
          how: "The report number is required by the embassy, your insurer and your bank." },
        { who: "Your travel insurer", what: "Coverage bought with the trip, or included with some credit cards",
          how: "May reimburse stolen belongings, emergency accommodation and document replacement." },
        { who: "Bank fraud department", what: "The 24-hour line on your bank's website",
          how: "Can freeze cards, arrange emergency cash abroad, and start a fraud claim." },
      ],
      risksToWatch: [
        { risk: "Identity theft from the stolen documents", why: "A passport together with an unlocked phone is enough to attempt account takeover.",
          prevent: "Change passwords for accounts reachable from the phone, and place a fraud alert on your credit once home." },
        { risk: "Missing your flight or overstaying a visa", why: "Emergency passports take time, and an expired permission to stay creates a separate legal problem.",
          prevent: "Tell the embassy your flight date at first contact so they can prioritize accordingly." },
        { risk: "Running out of accommodation before funds arrive", why: "The hotel is paid for three days and transfers can take longer than expected.",
          prevent: "Speak to the hotel early, and ask the embassy about their emergency assistance options in parallel." },
        { risk: "Being targeted again", why: "Travellers who have just been robbed are often visibly disoriented and carrying replacement cash.",
          prevent: "Split funds between two places, and keep the printed passport copy separate from the money." },
      ],
    },
  },
];

const DEMO_BY_ID = Object.fromEntries(DEMO_SCENARIOS.map(d => [d.id, d]));

/* The recommended scenario, and the one used if an id is not recognized. */
const DEMO_SCENARIO = DEMO_SCENARIOS.find(d => d.recommended) || DEMO_SCENARIOS[0];

function demoById(id) { return DEMO_BY_ID[id] || DEMO_SCENARIO; }

/* ========================================================= resource catalog */
/* Curated, mostly official sources, mapped to crisis modules. This sits
   alongside the live map rather than replacing it: the map answers "what is
   physically near me", this answers "what should I be looking for at all".

   Every entry says what it is and why it is being suggested. Eligibility
   language is hedged everywhere, because nothing here checks eligibility. */
const RESOURCE_CATALOG = {
  _always: [
    { name: "211", what: "Free local referral line covering most of the US",
      why: "Fastest route to rental, utility, food and transport help in your specific county.",
      url: "https://www.211.org", tag: "Community" },
  ],
  spouse_loss: [
    { name: "Social Security survivor benefits", what: "Federal benefits for surviving spouses and children",
      why: "A household that has lost its main earner may qualify for monthly income, including for each child under 18.",
      url: "https://www.ssa.gov/survivor", tag: "Income" },
    { name: "SNAP food assistance", what: "Federal food benefit administered by each state",
      why: "Eligibility uses current income, so a sudden loss of earnings can change the answer.",
      url: "https://www.fns.usda.gov/snap/state-directory", tag: "Food" },
    { name: "Legal aid directory", what: "Free and reduced-cost civil legal help",
      why: "Estate paperwork, benefit denials and landlord disputes are common after a death in the family.",
      url: "https://www.lsc.gov/about-lsc/what-legal-aid/get-legal-help", tag: "Legal" },
    { name: "School meal programs", what: "Free and reduced-price meals at public schools",
      why: "Reduces household food cost immediately and is usually quick to apply for.",
      url: "https://www.fns.usda.gov/nslp", tag: "Family" },
  ],
  disaster: [
    { name: "FEMA disaster assistance", what: "Federal help after a declared disaster",
      why: "May cover temporary housing, home repair and other disaster-caused needs.",
      url: "https://www.disasterassistance.gov", tag: "Housing" },
    { name: "American Red Cross", what: "Emergency shelter, meals and relief supplies",
      why: "Usually the fastest source of shelter and essentials in the first days.",
      url: "https://www.redcross.org/get-help.html", tag: "Shelter" },
    { name: "SBA disaster loans", what: "Low-interest federal loans for disaster losses",
      why: "Available to homeowners and renters, not only businesses, which is widely missed.",
      url: "https://www.sba.gov/funding-programs/disaster-assistance", tag: "Financial" },
  ],
  eviction: [
    { name: "HUD rental assistance", what: "Federal housing programs and local housing agencies",
      why: "Local housing agencies administer emergency rental funds and can advise on options.",
      url: "https://www.hud.gov/topics/rental_assistance", tag: "Housing" },
    { name: "Tenant legal aid", what: "Free civil legal help for housing matters",
      why: "Representation measurably changes eviction outcomes, and it is often free.",
      url: "https://www.lsc.gov/about-lsc/what-legal-aid/get-legal-help", tag: "Legal" },
    { name: "LIHEAP utility assistance", what: "Federal help with heating and cooling bills",
      why: "Utility arrears often accompany rent arrears and have their own separate program.",
      url: "https://www.acf.hhs.gov/ocs/programs/liheap", tag: "Utilities" },
  ],
  food: [
    { name: "SNAP food assistance", what: "Federal food benefit administered by each state",
      why: "The largest food program in the US, and eligibility follows current income.",
      url: "https://www.fns.usda.gov/snap/state-directory", tag: "Food" },
    { name: "Feeding America food bank finder", what: "National network of local food banks",
      why: "Most food banks do not require an application or proof of income.",
      url: "https://www.feedingamerica.org/find-your-local-foodbank", tag: "Food" },
    { name: "WIC", what: "Nutrition program for pregnant people, infants and young children",
      why: "Separate from SNAP, with its own eligibility, and often missed.",
      url: "https://www.fns.usda.gov/wic", tag: "Family" },
  ],
  jobloss: [
    { name: "State unemployment benefits", what: "State-run income replacement after job loss",
      why: "Claims are generally not backdated, so filing early matters more than filing perfectly.",
      url: "https://www.dol.gov/general/topic/unemployment-insurance", tag: "Income" },
    { name: "Health insurance marketplace", what: "Subsidized health coverage",
      why: "Losing a job usually opens a special enrollment period, and marketplace plans are often cheaper than COBRA.",
      url: "https://www.healthcare.gov", tag: "Health" },
    { name: "American Job Centers", what: "Free local career and training services",
      why: "Offers resume help, training funds and local hiring connections at no cost.",
      url: "https://www.careeronestop.org/LocalHelp/local-help.aspx", tag: "Employment" },
  ],
  fraud: [
    { name: "IdentityTheft.gov", what: "Official FTC reporting and recovery service",
      why: "Generates a personalized recovery plan and an official affidavit banks accept.",
      url: "https://www.identitytheft.gov", tag: "Reporting" },
    { name: "Credit freeze, all three bureaus", what: "Free freeze at Equifax, Experian and TransUnion",
      why: "The single most effective step to stop new accounts being opened in your name.",
      url: "https://www.usa.gov/credit-freeze", tag: "Financial" },
    { name: "FBI IC3", what: "Federal internet crime complaint center",
      why: "The right channel for online and wire fraud, especially where money has moved.",
      url: "https://www.ic3.gov", tag: "Reporting" },
  ],
  travel: [
    { name: "US embassy or consulate finder", what: "Official US diplomatic posts abroad",
      why: "Can issue emergency passports and help contact family or transfer funds.",
      url: "https://www.usembassy.gov", tag: "Documents" },
    { name: "Lost or stolen passport", what: "Official State Department reporting and replacement",
      why: "Reporting it protects you from misuse and starts the replacement process.",
      url: "https://travel.state.gov/content/travel/en/passports/have-passport/lost-stolen.html", tag: "Documents" },
    { name: "STEP traveler enrollment", what: "Free State Department program for US travelers",
      why: "Lets the nearest embassy reach you during an emergency abroad.",
      url: "https://step.state.gov", tag: "Safety" },
  ],
  medical: [
    { name: "Hospital financial assistance", what: "Charity care, required of nonprofit hospitals",
      why: "Nonprofit hospitals must offer it, and many patients are never told it exists.",
      url: "https://www.healthcare.gov/have-job-based-coverage/if-you-lose-job-based-coverage/", tag: "Financial" },
    { name: "Prescription assistance", what: "Manufacturer and nonprofit medication programs",
      why: "May substantially reduce the cost of ongoing medication.",
      url: "https://www.needymeds.org", tag: "Health" },
    { name: "Patient advocate or hospital social worker", what: "Staff who navigate care and cost",
      why: "Can coordinate transport, billing and care questions in one conversation.",
      url: "https://www.patientadvocate.org", tag: "Support" },
  ],
  mental: [
    { name: "988 Suicide and Crisis Lifeline", what: "Free, confidential, 24/7 crisis support",
      why: "Available by call or text for anyone in emotional distress, not only for suicidal crisis.",
      url: "https://988lifeline.org", tag: "Crisis" },
    { name: "SAMHSA treatment locator", what: "Official directory of mental health and substance use services",
      why: "Filters for sliding-scale and free providers near you.",
      url: "https://findtreatment.gov", tag: "Health" },
    { name: "NAMI HelpLine", what: "Peer support and information line",
      why: "Useful for families supporting someone, not only for the person affected.",
      url: "https://www.nami.org/help", tag: "Support" },
  ],
  dv: [
    { name: "National Domestic Violence Hotline", what: "24/7 confidential support and safety planning",
      why: "Can help build a safety plan before anything changes, at your own pace.",
      url: "https://www.thehotline.org", tag: "Crisis" },
    { name: "WomensLaw legal information", what: "State-by-state guide to protective orders",
      why: "Explains what protection is available where you actually live.",
      url: "https://www.womenslaw.org", tag: "Legal" },
    { name: "Local shelter and housing help", what: "Emergency shelter through the DV network",
      why: "Shelters can hold space and keep the location confidential.",
      url: "https://www.thehotline.org/get-help/", tag: "Shelter" },
  ],
  senior: [
    { name: "Eldercare Locator", what: "Official federal service for older adults",
      why: "Single entry point for local aging services, transport and meals.",
      url: "https://eldercare.acl.gov", tag: "Care" },
    { name: "Meals on Wheels", what: "Home-delivered meals for older adults",
      why: "Addresses nutrition and provides a regular wellbeing check.",
      url: "https://www.mealsonwheelsamerica.org", tag: "Food" },
    { name: "SHIP Medicare counseling", what: "Free, unbiased Medicare guidance",
      why: "State counselors help compare coverage without a sales interest.",
      url: "https://www.shiphelp.org", tag: "Health" },
  ],
  veteran: [
    { name: "VA benefits", what: "Official Department of Veterans Affairs services",
      why: "Covers healthcare, disability, education and housing in one place.",
      url: "https://www.va.gov", tag: "Benefits" },
    { name: "SSVF homelessness prevention", what: "VA program for veteran families at housing risk",
      why: "May cover rent arrears and deposits to prevent a loss of housing.",
      url: "https://www.va.gov/homeless/ssvf/", tag: "Housing" },
    { name: "Veterans Crisis Line", what: "24/7 confidential support for veterans",
      why: "Staffed by people trained for military and veteran experience.",
      url: "https://www.veteranscrisisline.net", tag: "Crisis" },
  ],
  student: [
    { name: "StopBullying.gov", what: "Official federal guidance on bullying",
      why: "Explains what schools are required to do and how to escalate.",
      url: "https://www.stopbullying.gov", tag: "School" },
    { name: "School counselor and family liaison", what: "Support staff in most public schools",
      why: "Can arrange academic support, fee waivers and counseling.",
      url: "https://www.211.org", tag: "School" },
    { name: "988 Suicide and Crisis Lifeline", what: "Free, confidential, 24/7 support",
      why: "Available to students by call or text at any hour.",
      url: "https://988lifeline.org", tag: "Crisis" },
  ],
  traffic: [
    { name: "Court self-help centers", what: "Free procedural help from the court system",
      why: "Explains deadlines and options without charging for legal advice.",
      url: "https://www.lawhelp.org", tag: "Legal" },
    { name: "Legal aid directory", what: "Free and reduced-cost civil legal help",
      why: "Some traffic and licence matters carry consequences worth advice on.",
      url: "https://www.lsc.gov/about-lsc/what-legal-aid/get-legal-help", tag: "Legal" },
  ],
};

function resourcesForCrisis(crisisId) {
  const specific = RESOURCE_CATALOG[crisisId] || [];
  return specific.concat(RESOURCE_CATALOG._always);
}

/* ========================================================= offline fallback */
/* Used when the live planner cannot be reached. Honest rather than clever: it
   says plainly that it is a general framework and points at a live human. */
function fallbackPlan(text, crisis) {
  const c = crisis || { name: "Your situation", id: null };
  const lower = String(text || "").toLowerCase();
  const safetyFlag = /(hurt|hit|abuse|threat|unsafe|afraid|scared|violent|kill|suicid|harm)/.test(lower);

  const dims = [
    { id: "housing",   score: 50, why: "Not assessed while the planner is offline." },
    { id: "financial", score: 45, why: "Not assessed while the planner is offline." },
    { id: "food",      score: 60, why: "Not assessed while the planner is offline." },
    { id: "health",    score: 60, why: "Not assessed while the planner is offline." },
    { id: "family",    score: 60, why: "Not assessed while the planner is offline." },
    { id: "safety",    score: safetyFlag ? 25 : 80, why: safetyFlag
        ? "Your description mentions possible danger, so this is flagged for attention."
        : "Not assessed while the planner is offline." },
  ];

  const actions = [];
  if (safetyFlag) {
    actions.push({ when: "Do now", dimension: "safety",
      task: "If anyone is in immediate danger, call 911. For crisis support call or text 988.",
      why: "Safety comes before any recovery planning." });
  }
  actions.push(
    { when: "Today", dimension: "financial", task: "Call 211, or text your ZIP code to 898211, to reach local emergency resources",
      why: "A local referral specialist can point at the specific programs in your county." },
    { when: "This week", dimension: "financial", task: "Gather the documents listed below",
      why: "Almost every application will ask for the same core paperwork." },
    { when: "This month", dimension: "housing", task: "Write down every deadline you are facing this month and handle the soonest first",
      why: "Missed deadlines are what usually turn one problem into two." },
  );

  return normalizePlan({
    isSample: false,
    crisisType: c.name,
    acknowledgement:
      "The live planner is unavailable right now, so this is a general starting framework rather than a personalized assessment. The steps below still hold for most situations, and the resources can connect you with a real person who can look at your specific circumstances.",
    priorities: [
      { title: safetyFlag ? "Make sure everyone is safe" : "Reach a local referral line",
        urgency: "High", dimension: safetyFlag ? "safety" : "financial",
        why: safetyFlag ? "Your description mentions possible danger."
                        : "A local specialist can identify the programs that apply where you live.",
        nextStep: safetyFlag ? "Call 911 if anyone is in immediate danger, or 988 for crisis support."
                             : "Call 211, or text your ZIP code to 898211." },
      { title: "Gather your key documents", urgency: "Medium", dimension: "financial",
        why: "Nearly every form of assistance requires the same core paperwork.",
        nextStep: "Start with photo ID, proof of income and any relevant policy or agreement." },
      { title: "Map your deadlines", urgency: "Medium", dimension: "housing",
        why: "Knowing what is due when prevents a second problem forming behind the first.",
        nextStep: "List every payment and appointment due this month, soonest first." },
    ],
    dimensions: dims,
    actions,
    documents: (c.docs && c.docs.length) ? c.docs
      : ["Photo ID", "Proof of income", "Insurance or policy information", "Any recent official letters"],
    helpers: (c.helpers || ["211 community resources"]).map(h => ({
      who: typeof h === "string" ? h : (h.who || ""), what: "", how: "See Help Near You to find the nearest option.",
    })),
    risksToWatch: [
      { risk: "A second obligation slipping while you handle the first",
        why: "Crises rarely stay contained to one area of life.",
        prevent: "List every deadline this month and work from the soonest." },
    ],
  });
}

/* Expose explicitly so the dependency is obvious to anyone reading index.html. */
window.LBEngine = {
  ENGINE_STEPS, DIMENSIONS, DIM_IDS, DIM_BY_ID, WHEN_BUCKETS, SCORE_BANDS,
  ACRE_SYSTEM, buildPrompt, normalizePlan, normalizeDimension, matchDimension, normalizeWhen,
  scoreBand, clampScore, currentDimensions, lifeBridgeScore, baselineScore,
  recoveryProgress, seedRoadmapFromPlan, nextAction, dimensionProgress,
  DEMO_SCENARIO, DEMO_SCENARIOS, DEMO_BY_ID, demoById,
  RESOURCE_CATALOG, resourcesForCrisis, fallbackPlan,
  RECOVERY_CEILING,
};
