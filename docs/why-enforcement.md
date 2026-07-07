# Why enforcement, not prompting

## The failure mode: advisory rules

If your only governance is a rule written into an instruction file — a
`CONSTITUTION.md`, a system prompt, a "hard rules" section — you have made a
*request*, not a *guarantee*. The model reads it, usually complies, and then on
some turn proposes exactly the thing the file forbade: a post with no
AI-disclosure, a spend past the cap, a secret pasted into an outbound message.
An instruction file has no mechanism to *stop* an action; it can only ask. When
the stakes are money moving, credentials leaking, or a claim going out under
your name, "usually complies" is not a control.

Mainspring's answer is to move the rule out of the prompt and into code that
runs *between* the brain proposing an action and the action happening. The brain
is pure reasoning: it returns a list of `Action`s and never touches disk,
network, or a secret itself. Every one of those actions is checked before
dispatch — a rule the model cannot route around is enforced; a paragraph it is
trusted to honor is advisory.

## How the governance gate works

`@mainspring/governance` is the constitution-as-code layer. The flow:

1. **Load the rules from the constitution.** `loadConstitutionRules(markdown,
   config)` parses the hard rules out of your `CONSTITUTION.md` and returns
   `{ rules }` — a set of `Rule`s, each with an `id`, a human `description`, and
   a `test(action)` function. The built-in set (`createBuiltInRules(config)`)
   covers the common controls: `no-secrets`, `spend-caps`, `external-allowlist`,
   and `honesty-disclosure`.

2. **Evaluate every proposed action.** `evaluate(action, rules)` runs each rule's
   `test()` against one `Action` and returns a `GuardResult`:
   `{ verdict, firedRules }`. Verdicts compose by precedence —
   `block` beats `escalate` beats `allow` — so a single blocking rule is
   decisive. `firedRules` lists every rule that objected, by `id` and reason, so
   a block is *cited*, never silent.

3. **Fail closed.** A rule whose `test()` throws is treated as `escalate`, not
   `allow`. Governance breaking sends the action to a human instead of waving it
   through.

The runnable `examples/quickstart` shows this end to end, offline: the brain
proposes `run post-to-reddit` with no disclosure flag, the `honesty-disclosure`
rule returns `block`, and the post is refused by name against constitution hard
rule 2 — no model, no network, no API key.

## Honest limits: what a gate can and can't stop

Enforcement is real but bounded, and it is worth being precise about the edge.

- **It governs *actions*, not *text*.** The gate inspects the structured
  `Action`s the brain emits — writes, ledger entries, tool calls,
  notifications. It does not police the model's free-form reasoning. A false
  claim *inside* the model's own output is a prompt-and-review concern; the gate
  only ever guards the side effects that flow through the loop.

- **Only actions routed through the loop are covered.** The guarantee holds for
  side effects that go through `assemble → brain.step → gate → dispatch`. Give
  the brain a raw, ungated tool that writes or spends directly and you've routed
  around the control — the gate can only check what it is asked to check.

- **The rules are only as good as you write them.** `honesty-disclosure` catches
  post-shaped tool calls via a configurable pattern; `no-secrets` is a coarse
  secret-shape check (pair it with `@mainspring/scrub` for real coverage);
  `spend-caps` enforces the numbers *you* set. The gate enforces your rules
  faithfully — it does not invent good ones for you.

The claim is narrow and true: for every action that passes through the loop,
your constitution is checked by code before the action happens, and anything it
blocks is blocked with a named reason. That is the difference between a rule and
a wish.
