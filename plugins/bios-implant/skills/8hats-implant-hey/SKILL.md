---
name: 8hats-implant-hey
description: Invoke when the user greets or challenges the implant, or checks whether it is working — including a bare "hey", "hi", or "hello" as an opening message, and "hey implant", "are you awake", "are you there", "is the implant active", "is it working", "prove you are running" — or asks for any visible sign that BIOS Implant is live in this session.
allowed-tools: mcp__plugin_bios-implant_implant-local__local_hello
---

# Hey implant

## State

`TRIGGER`
- Enter when the user greets the implant or asks for proof that it is active.

`GOAL`
- Turn "is it on?" into one sentence the person can read without opening a log.

## The one rule

**The answer is the tool's answer.** Never compose a greeting from memory, from this file,
from the plugin's documentation, or from anything the user said earlier in the conversation.
The phrase is stored inside the local companion process, and reaching it is the entire proof:
a session where the implant is not running cannot produce it.

If you find yourself about to write the greeting without having called the tool, the honest
answer is that the implant is **not** active.

## Protocol

`ASK`
1. Resolve any callable tool whose name ends in `local_hello` — match by capability suffix, not
   by server display name, because Cowork can show duplicate MCP instances.
2. Call it. Pass no arguments; the companion resolves the current folder itself.

`ANSWER`
1. Print the tool's text result **as the first line of your reply**, verbatim by default.
2. Add nothing before it. One short line after it is fine if the tool named a `next_action`.
3. If you restate it instead of copying it, **every fact must survive**: the companion version,
   whether the folder is bound, and — when it is — the agent, the label, the folder and the
   staged BIOS version. Dropping one turns a proof into a pleasantry.

`FAIL`
1. If no `local_hello` tool exists: the plugin is not loaded in this session. Say exactly that,
   and give one next action — install BIOS Implant, or restart the host so it loads.
2. If the tool exists but the call errors: the companion is registered but not running. Say
   that, quote the error, and send the person to the `8hats-implant-doctor` skill.
3. In both cases state plainly: **implant NOT active** — and do not print a greeting.

## Completion Gate

Complete only when the reply contains either:
- the tool's answer as the first line — copied, or restated with **every** field intact
  (companion version, binding state, and when bound the agent, label, folder and BIOS
  version); or
- an explicit "implant NOT active", the reason, and one next action.

Never both. Never a greeting the tool did not return, and never a greeting stripped of the
evidence that came with it — the evidence is the only part that cannot be faked.
