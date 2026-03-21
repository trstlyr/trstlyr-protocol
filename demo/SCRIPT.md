# TrstLyr Protocol — Demo Narration Script

**Target length:** ~2.5 minutes
**Setup:** Browser open to `demo/index.html`, screen recording at 1080p

---

## INTRO (0:00 – 0:25)

> Hey, I'm Chris. This is TrstLyr Protocol — trust infrastructure for the agent internet.
>
> Here's the problem: we're building a world where AI agents transact autonomously — they trade, delegate tasks, access data. But right now there's no standard way for one agent to ask: "Should I trust this other agent?"
>
> TrstLyr answers that question. We aggregate trust signals from on-chain registries, code repos, and peer behavior — then fuse them into a single score using Subjective Logic. Let me show you it working live.

## SECTION 1 — API Health (0:25 – 0:50)

*Click "Check API Health"*

> First — this is a live API, running right now on Base Mainnet. You can see all the trust signal providers that are online: ERC-8004 on-chain registry, GitHub, behavioral attestations, and more.
>
> Each provider is an independent source of truth. TrstLyr doesn't pick one — it fuses all of them using opinion-weighted Subjective Logic. More signals, higher confidence.

## SECTION 2 — Trust Score Query (0:50 – 1:45)

*Click "Query Trust Score" (pre-filled with erc8004:31977 — Charon)*

> Now let's query a real agent. This is Charon — agent 31977 in the ERC-8004 registry on Base.
>
> *Wait for result*
>
> Look at this — we get a composite trust score, a risk level, and a recommendation. But what's powerful is the breakdown.
>
> Each signal comes from a different provider — the on-chain registration, the GitHub commit history, behavioral attestations from peers. They each contribute independently, and Subjective Logic handles the uncertainty. If a provider has no data, it doesn't drag the score down — it just reduces confidence.
>
> See the confidence bar? That's the system telling you how much evidence it actually has. A high score with low confidence means "looks good, but we don't have much to go on." That's honest. Most trust systems just give you a number and pretend they're certain.
>
> This whole response is also anchored on-chain via EAS — the Ethereum Attestation Service. Every trust evaluation can be verified.

## SECTION 3 — Behavioral Attestation (1:45 – 2:25)

*Fill is pre-populated. Click "Submit Attestation"*

> Now here's something interesting. TrstLyr lets agents attest about each other's behavior — like a peer review system. I'm submitting that Charon completed a delegation successfully with a 5-star rating.
>
> *Wait for 402 response*
>
> And we get a 402 — Payment Required. This is actually a feature, not a bug.
>
> Every attestation requires a $0.01 USDC micropayment through the x402 protocol. That's a machine-native HTTP payment standard. Why? Because if attestations are free, you get Sybil attacks — fake reviews from fake wallets. By requiring even a tiny payment, we bind every attestation to a real on-chain identity.
>
> One penny. That's the cost to make trust auditable, Sybil-resistant, and anchored on Base.

## CLOSE (2:25 – 2:35)

> That's TrstLyr Protocol. On-chain trust scoring for the agent internet. ERC-8004, Base Mainnet, live today. Thanks for watching.

---

**Tips for recording:**
- Pause 1–2 seconds after each click to let the UI animate
- Keep mouse movements smooth and deliberate
- If a response is slow, fill the silence: "It's hitting the live API right now..."
- The score may vary between takes — that's fine, it shows it's live
