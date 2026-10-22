# Documentation layout

Where this repository's documents live, which of them can be relied on, and which cannot.

Before writing a document, decide which class it belongs to: each class rots at a different speed and has exactly one home (ADR-0013).

## Conclusions and process records are not the same thing

**Conclusions** answer "what is true now"; any skill may rely on them:

| Location | Question it answers | Maintained by |
|---|---|---|
| `CONTEXT.md` (repository root) | What each term means, which synonyms to avoid, and the invariants you only learn by breaking them. Read it before changing anything | `/domain-modeling` |
| `docs/adr/` | Why a decision was made and what was rejected. One decision per file, append-only: a new decision gets a new ADR. Indexed in its `README.md` | `/domain-modeling` |
| `docs/specs/<slug>.md` | Which boundaries a feature has enumerated (user stories, failure modes and boundaries, test decisions) and what is explicitly out of scope. Rewritten in place; the trade-offs belong in ADRs and are cited by number. A persistent artifact, not deleted when the feature merges (ADR-0017) | `/to-spec` |
| `docs/features/<slug>.md` | User-visible behaviour of the current version only. Rewritten in place | `/features-catalog` |
| `docs/prototypes/` | What the interface and state models look like. Kept permanently (ADR-0014); browse them all from the `index.html` gallery | `/prototype` |
| `docs/postmortems/` | The causal chain of one incident. One per file, append-only, written in the same round a real bug is diagnosed, indexed in its `README.md` | `/implement` step 7 |
| `docs/ops/` | This project's runbooks — how the current processes are operated (signing, notarization, Pages, R2, download statistics) with their actual values. Updated in place; every new runbook goes here (ADR-0015). A PR that changes a process must update its runbook | The PR that changes the process |

`docs/specs/` and `docs/features/` **share slugs one-to-one**: `docs/features/transfer-chat.md` pairs with `docs/specs/transfer-chat.md`. Distribution-channel specs are the exception: they have a spec and no features entry.

`docs/DESIGN.md` is a system design overview of archival value; its status notes may be stale. **The current state is defined by the code and the ADRs.**

**Process records** answer "how it was done at the time":

| Location | Contents |
|---|---|
| `docs/.workings/<slug>/` | Tickets, `review-code.md`, `review-tests.md`, and other process notes |

**`docs/.workings/` is kept after merge, but no skill may treat it as a reliable basis.** Read it only to answer "why was this done that way at the time", never to infer the current state; check any line number or code claim in it against the code before citing it. When it conflicts with a conclusion document, the conclusion document wins, **and the process record does not need to be corrected**: it is meant to stay as it was. It is a hidden directory, excluded from documentation publishing and from globs such as `docs/**/*.md`.

It is gitignored (ADR-0019), so only this machine has it: anything that people or models on another machine must know has to be promoted to one of the conclusion documents above. Keeping it is the default, not an obligation: once a feature is fully done with nothing left over, its whole slug directory may be deleted.

## Read these first when exploring

Before changing code or proposing a design, read:

- `CONTEXT.md` at the repository root
- the ADRs in `docs/adr/` that relate to the area being changed

## Use the glossary's words

Whenever an output mentions a domain concept (issue titles, proposals, assumptions, test names), **it must use the term defined in `CONTEXT.md`**, never a synonym listed under its `_Avoid_`.

A concept missing from the glossary is a signal: either you are inventing language this project does not use (reconsider it), or an entry is genuinely missing (note it and hand it to `/domain-modeling`).

## Conflicts with an existing ADR must be called out

If an output contradicts an ADR, **name the ADR explicitly; never override it silently**:

> _Contradicts ADR-0020 (idle timeout, not total duration) — but worth reopening because…_
