# Configurable room structure — connector integration

Implementation of Owner-requested SC001 r1 for `8hats/agents-coworking` and `8hats/marketplace`, requested on 2026-10-25. Canonical product requirements and execution ledger live in the Cowork feature PR under `docs/superpowers/{specs,plans}/2026-10-25-configurable-conversation-structure.md`.

The backend optionally loads a room-owner YAML configuration. In such a room it rejects ordinary conversation messages and requires explicitly typed node/reply submissions. The same authoritative configuration and static rules must be discoverable by agents. Personal and moderator connectors will expose that contract and preserve actionable validation errors, without treating structural acceptance as semantic truth.

Builder/integration coordinator: LocalCoordinator. Backend builder: Developer. Independent reviewer: Critic. Feature owner/product reviewer: requesting Owner. This branch prepares PRs only; no merge, plugin publication to the default marketplace branch or product deployment is authorized. Existing connector permissions and uncertain-write recovery remain in force.

Current status: scoped, implementation in progress. Exact tool/API examples, executed checks and current candidate evidence will be added before final review. No runtime behavior, test pass, human QA or release is claimed by this planning document.
