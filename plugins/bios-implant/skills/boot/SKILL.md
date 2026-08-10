---
name: boot
description: Invoke at session start or when the user asks to boot, refresh, or load BIOS Implant context for the exact current workspace.
---

# Boot

## State

`TRIGGER`
- Enter at session start, or when the user asks to boot, load BIOS, or refresh BIOS Implant context.

`PREREQ`
- Use the exact current folder.
- Operate remote-first.

## Tool Boundary

`LOCAL`
- `local_selection`
- `local_stage`
- `local_status`

`REMOTE`
- `bios_load`
- `wm_load`

`FORBIDDEN`
- Never expose BIOS body unless needed to apply it as session context.
- Never claim fallback context was loaded unless `local_status` actually returned a valid last-good BIOS body or context.
- Never replace a newer cached generation with an older one.

## Protocol

`SELECT`
1. Call `local_selection` for the exact current folder first.
2. If no binding exists, stop.
3. Return the next action: run `connect` for this exact folder.

`LOAD-BIOS`
1. Call `bios_load` for the bound agent and label before any worldmodel call.
2. Treat BIOS as the primary gate. Worldmodel is secondary.
3. On successful `bios_load`, call `local_stage` with the exact current folder plus the returned BIOS body, version, and response metadata needed for monotonic staging.
4. Let `local_stage` enforce downgrade-safe last-good storage.

`LOAD-WM`
1. After successful BIOS load, call `wm_load`.
2. If `wm_load` fails, keep the BIOS result and report a partial boot.

`FALLBACK`
1. Only on BIOS auth or network failure, call `local_status`.
2. Use only a companion-returned valid last-good BIOS body or context if the tool actually returns one.
3. If `local_status` does not return a usable BIOS body or context, report partial or offline state and the exact recovery action.
4. Never synthesize fallback text from metadata alone.

## Failure Paths

`LOADED`
- `bios_load` succeeded, `local_stage` completed, and `wm_load` succeeded.

`PARTIAL`
- BIOS loaded but `wm_load` failed.
- Or BIOS remote auth/network failed and a valid companion-returned last-good BIOS body or context was used.
- Or BIOS remote auth/network failed, no valid fallback body was returned, and the session must proceed without BIOS freshness.

`UNAVAILABLE`
- No folder binding exists.
- `bios_load` failed for a non-auth, non-network reason.
- `local_stage` or `local_status` made the local state untrustworthy.

## Completion Gate

Complete only when the response ends with one explicit boot status:
- `LOADED`
- `PARTIAL`
- `UNAVAILABLE`

And only when the sequence stayed:
- `local_selection`
- `bios_load`
- `local_stage` on BIOS success
- `wm_load`
