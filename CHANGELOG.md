# Changelog

All notable changes to WeChat-iLink Bridge will be documented in this file.

This project follows semantic versioning after the first public package. Pre-`0.1.0` entries track milestone builds and release-readiness work.

## Unreleased

- No changes yet.

## 0.2.2 - 2026-11-09

Documentation-only release on top of 0.2.1 — no code changes; the bump exists so the packaged download carries the new guide.

- Added a measured "token economy" pitfall guide for deployers and their AI agents — main README (extras section), `extras/wxb-inbox/README.md`, and `docs/auto-reply-worker.md` — covering why auto-reply must run as a fresh short-lived worker instead of in a long-lived main chat, script-only polling, read-pending-once, conditional pre-send recheck, no sub-agents per message, and merged sends. The sample worker prompt in `extras/wxb-inbox/wxb-inbox.json` now opens with these as hard rules for the on-duty agent.

## 0.2.1 - 2026-11-08

Integrated build for Muse (personal use, provided as-is — see README "关于本版本"), assembled on top of upstream 0.2.0 (DONGH4O). All changes below were verified live on the maintainer's own account.

From the lyrnoxfan fork (5 commits, original authorship preserved in git history):

- Outbound voice sending: `send --voice`, audio MIME handling, automatic SILK transcode with duration, `voice_item.playtime` fix.
- `fetch` long-poll no longer holds the account lock (removes `STATE_LOCK_TIMEOUT` on concurrent sends).
- Stale account locks left by dead processes are reclaimed.

Fixes made in this build:

- SILK encoder is now resolved via configuration / `WX_SILK_ENCODER_PATH` / PATH instead of a hardcoded machine-specific path.
- Inbound voice messages surface WeChat's own transcript (`voice_item.text`) as `metadata.transcript` and message text.

Nine improvements adapted from peer iLink projects (per-item sources in README "本整合版的构成"):

- Cursor commit ordering in `fetch` (server buffer only advances after local persistence succeeds).
- Text chunking: 3800 chars per chunk with a 400 ms inter-chunk interval.
- Quote (`ref_msg`) resolution with a bounded summary cache and a three-tier id matching strategy.
- Conditional pre-reply inbox recheck for quote-like, fragment-like, or background-dependent messages.
- Durable delivery queue: delayed resend on `INVALID_CONTEXT_TOKEN`, manual `wxb queue retry / discard`.
- Retry policy differentiation: network errors get long backoff and never stop the bridge; auth / business errors surface immediately.
- Layered diagnostics: `wxb doctor` health checks and age-aware cache cleanup.
- Poller lease: overlapping `fetch` runs fail fast with `POLLER_ALREADY_RUNNING`.
- Per-context-token send quota accounting (measured lifetime cap: 10 sends per token); `wxb doctor` reports token age and quota state.

Packaging:

- README rewritten for the integrated build; `docs/auto-reply-worker.md` added.
- `extras/wxb-inbox/`: 24-hour auto-reply example for the Muse hook runtime (poll script with dedupe, stuck re-wake cooldown, one-shot fault alerts, self-healing reinstall, and the slim worker prompt).
- `third_party/silk-v3-decoder`: SILK codec source included for `install.sh` (only the `silk/` source tree is kept; the upstream repo's prebuilt Windows binaries are omitted).
- Release hygiene: removed the diagnostic raw-payload capture code (flag-gated, wrote raw protocol payloads to the state dir); live message ids used during quote-resolution verification were replaced in tests / fixtures / comments with synthetic ids preserving the measured numeric relationships.
- Upstream milestone-era readiness tests that asserted the old README text and the 0.2.0 package metadata were re-pointed at the integrated README and the 0.2.1 metadata; the full suite (205 tests) passes against the packaged tree.

## 0.2.0 - 2026-05-18

- Added M14 `wxb-mcp` stdio adapter with `fetchMessages`, `sendText`, `sendFile`, `listUsers`, and `status` tools.
- Added MCP adapter tests and docs while preserving token-safe tool schemas and media handoff through local paths.
- Added M15 optional `analyzeMedia` helper for local media metadata, text preview, host-provided multimodal hooks, and fail-soft degradation.
- Added M13 CI matrix and stable-release readiness documentation.
- Added troubleshooting guidance for install, login, sending, media, state, and safe debugging.

## 0.1.0-beta.1 - 2026-05-17

- Added M10 GitHub source release readiness: source install docs, issue templates, PR template, security policy, and validation report.
- Added M11 outbound file/image sending with AES upload, optional typing status, safe CLI output, and mock protocol coverage.
- Made optional typing best-effort so typing setup or stop failures do not block text, file, or image delivery.
- Prepared the M12 npm beta package by setting `private: false`, updating the package version, and documenting beta install validation.

## 0.1.0-beta.0 - 2026-05-17

- Established the M9 local release framework for pre-GitHub and pre-npm distribution readiness.
- Updated package metadata to the first public-source preview version while keeping `private: true`.
- Added M9-M15 follow-up roadmap in `docs/next-milestones.md`.
- Added local npm package file boundary through `package.json.files`.
- Added `pack:dry-run` script for release rehearsal.
- Added MIT `LICENSE` draft and release metadata placeholders for the future GitHub repository.
- Added npm ignore rules for local state, live outputs, test fixtures, logs, and package archives.
- Planned release framework before GitHub upload; CI and automated publishing remain post-GitHub work.
- Added `docs/m9-validation-report.md` with M9 test and package dry-run results.
- Kept `wxb-spike` as a source-only maintenance script instead of a public npm bin.

## 0.0.0-m8 - 2026-05-16

- Completed P1 media download support for image, file, voice, and video inbound messages.
- Added `wxb fetch --download-media` attachment output with absolute local inbox paths.
- Added AES-128-ECB media decryption and MIME/extension inference for common media types.
- Preserved token-safe stdout by omitting context tokens, CDN URLs, signed query parameters, and AES keys.
- Updated WeChat bridge skill docs to consume `attachments[].path` as the media handoff.

## 0.0.0-m7 - 2026-05-16

- Added `wxb poll` foreground polling.
- Added `wxb heartbeat` for scheduled keepalive calls.
- Added delayed resend queue for invalid context token failures.
- Added alias management for opaque `fromUserId` values.
- Added cleanup support for local history and inbox retention.

## 0.0.0-m6 - 2026-05-16

- Completed P0 Windows stabilization.
- Verified login, accounts, status, fetch, and text send flows.
- Added recovery behavior for corrupted JSON/JSONL local state.
- Preserved local-only token and context token handling.

## 0.0.0-m0-m5 - 2026-05-16

- Established protocol spike, project skeleton, local state layer, login, account management, fetch, text send, and Agent skill documentation.
