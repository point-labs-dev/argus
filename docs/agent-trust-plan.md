# Argus agent trust plan

Agents copy the file they opened. For live view that file is a firmware diary, a pad filter, and a callback test that calls the callback once. This plan makes a legal stream setup the one that compiles, then runs that check in CI.

Peter lands every later PR. This document does not open those PRs, does not merge, and does not deploy. Leave the Mini alone. Leave notification timing alone.

The later program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. Peter approved the three defaults on 10/16. The implementation pull requests are a stack so the check runs on every head before anything merges. PR-shape is the base and targets `main`. Outside QA on 10/17 split the Home session changes out of PR-shape. PR-shape requires `aspect` and stays behavior-neutral otherwise. A separate behavior-change pull request, for Peter's review, omits audio from the prepareStream answer when audio is off, returns from a duplicate prepareStream without calling the HAP callback, and requires delegate aspect. That pull request targets PR-shape. PR-ci targets the behavior pull request. PR-prose targets PR-ci. PR-verify targets PR-prose. This document does not gain their commits. Merge order is PR-shape, then the behavior pull request, then PR-ci, then PR-prose, then PR-verify. Peter lands them. No owner merges.

PR-shape carries the base workflow: ffmpeg, the go2rtc binary the loopback test already expects, `npx tsc -p tsconfig.json --noEmit`, and `npx vitest run`. The runner has no ffmpeg. Without it the crop checks throw `ENOENT`, and `scripts/install-launchd.sh` exits 1 with empty stderr because `command -v ffmpeg` fails under `set -e` before the plist is written. PR-ci adds the census step and `npx tsc -p tsconfig.check.json --noEmit` on top of that same workflow. PR-prose and PR-verify do not edit the workflow. They run the base check.

PR-shape and PR-ci both edit `tests/homekit.test.ts`. PR-ci is rebased on PR-shape. The stream-setup version of that test is the one kept, with the type fixes that still apply.

`tsconfig.json` stays the emit program, `rootDir` `src`. Including `tests/**/*.ts` there fails with `TS6059`. PR-ci adds `tsconfig.check.json`, which extends the emit config, sets `rootDir` to `.`, emits nothing, and includes `src` and `tests`.

PR-prose keeps `LATENCY.md`, `TESTING.md`, and `TELEMETRY-QUICK-REF.md`. Those are the alert-latency notes. The firmware diary deletion stays on PR-shape.

PR-verify names `tests/hap-setup-contract.test.ts` and `scripts/firmware-census.mjs` as the drives. The contract test is on PR-shape. The audio-off answer and the required delegate are on the behavior pull request. The census script is on PR-ci, and PR-verify depends on that pull request. The skill's own test runs the doctor and the optional-property probe. The doctor checks camera aspect and that audio-off does not still advertise a codec. The timing check uses a temp copy and does not edit `src/timing.ts`.

Home Manager's read-only `ffprobe` on the Mini at about 8:00 PM ET on 2026-10-16 is the aspect list. Credentials stay redacted. Garage Door, Backyard, and Backyard Right are `4:3` (main 2560x1920). Backyard Left is `16:9` (main 3840x2160). Front L and Front R are `16:9` (main 4512x2512). Doorbell is `4:3`, inferred and unverified, because it was unreachable. The record is `docs/camera-health.md` and `docs/aspect-migration.md` on PR-shape. Garage Door's main in that record is 2560x1920.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. Peter lands every PR. No owner merges.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State this plan to Peter, then stop. Start execution only after he says to start.
- [ ] Re-read the execution playbook at the start and at every tick. Argus main has no `pstack` tree. A failed `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md` means the file is not in this repo. Read `poteto-mode/playbooks/autopilot-stack.md` from the operator skill store, and read `poteto-mode/playbooks/opening-a-pr.md` the same way.
- [ ] On Peter's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim.

```
Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none.
```

- [ ] On Peter's hold, send every owner a zero-writes order at once.
- [ ] Do not deploy, reboot, SSH, or edit the Mini. Do not edit `src/timing.ts`.

### Spawn owners

- [ ] Spawn one owner per PR. Each owner builds, pushes, opens a ready PR, and stops at merge-ready. Peter lands it.
- [ ] Follow this dependency graph for merge order. The opened pull requests are a stack so each head contains the workflow.
  - [ ] PR-shape is first, branches from `main`, and carries the base workflow. It requires aspect and does not change the prepareStream answer.
  - [ ] The behavior pull request targets PR-shape. It is the audio-off answer, the duplicate prepareStream, and required delegate aspect.
  - [ ] PR-ci targets the behavior pull request and adds the census steps. PR-prose targets PR-ci and does not edit the workflow.
  - [ ] PR-verify targets PR-prose. Its census drive depends on PR-ci.
- [ ] Hold the file boundaries. PR-shape touches stream setup, camera config, and the homekit tests. It does not touch `src/timing.ts` or `src/recording.ts`. The behavior pull request touches the prepareStream answer and the delegate options. PR-ci touches the workflow and the test files that fail `tsc`. PR-prose touches root markdown and `docs/invariants.md`. PR-verify touches `.cursor/skills/verify-argus/`.
- [ ] Hold the review gate. PR-shape changes the camera config a future deploy will parse. The behavior pull request changes a Home session and waits for Peter's review before merge. The other three PRs do not change a Home session.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Use `gh` for this repo. `origin` is not required.
- [ ] Open the later PRs ready, never draft, per Opening a PR. This plan's own PR stays draft. Do not mark it ready and do not merge it.
- [ ] Run `npx tsc -p tsconfig.json --noEmit` and `npx vitest run` before the PR-facing push. Push with hooks on.
- [ ] Run the deslop pass and the no-comments pass before review.
- [ ] Triage every Bugbot and security-reviewer comment per the bugbot triage note in the poteto-mode references.
- [ ] Rebase onto current trunk before the code-ready report. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, or on a CI failure that comes from a change on trunk.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA, run one gates lane, the ten live lanes, the perf lane, and at least two audit lanes that read the diff and distrust the PR body.
- [ ] Clean only when every lane is PASS. A new head gets a fresh swarm, except for results that stay valid under the patch-id rule in the shipping playbook.
- [ ] No owner merges, arms auto-merge, or closes. A clean verdict appends the PR to the stack. Peter lands the stack bottom-up.

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. `control-cli` is not installed here. Drive `npx vitest` and `npx tsx`. Do not SSH.

- [ ] `git fetch origin` the head branch and `git checkout` the head SHA.
- [ ] Run `npx tsc -p tsconfig.json --noEmit` and wait until it exits 0.
- [ ] Deliver input only through `npx vitest` and `npx tsx`. Do not open Apple Home.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Make illegal stream setups unrepresentable, PR-shape

**Depends on.** None.

**Files.**

- [ ] Create `src/homekit/prepare-answer.ts`.
- [ ] Edit `src/homekit.ts`, `src/config.ts`, `src/serve.ts`, `argus.example.yaml`, and `tests/homekit.test.ts`.
- [ ] Create `tests/hap-setup-contract.test.ts`.
- [ ] Do not edit `src/timing.ts` or `src/recording.ts`.

**Build.**

- [ ] Add required `aspect` on each camera, with values `16:9` and `4:3`. Delete `FOUR_BY_THREE_CAMERAS` and `isFourByThreeCamera`. Pass aspect into the delegate.
- [ ] Add `prepareAnswer` that returns audio only when the session includes audio, and that copies the request SRTP key and salt.
- [ ] Make `buildLiveFfmpegArgs` take aspect. Four by three crops into the box. Sixteen by nine pads. Delete the `cropToFill` flag.
- [ ] Delete the block comment directly above `ARGUS_FIRMWARE_REVISION`, and delete the parked-main comment in `src/serve.ts`.
- [ ] Change the pad test so it covers a sixteen by nine camera only. Add the contract test. The double-callback test must invoke the answer twice.

**You see.**

- [ ] A Garage Door config without `aspect` fails `parseArgusConfig`.
- [ ] `includeAudio: false` yields a response with no `audio` property, and the ffmpeg args have no `-c:a`.
- [ ] An audio-on response copies the request key bytes.
- [ ] A second answer returns false, and the HAP callback runs once.
- [ ] `src/homekit.ts` contains no `FIELD TEST RESULT` line.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/hap-setup-contract.test.ts` gains the key echo, the audio-off omission, the second answer, and the aspect filter cases. Run `npx vitest run tests/hap-setup-contract.test.ts tests/homekit.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npx tsx prototypes/agent-trust/hap-setup-contract.ts` at trunk and the new vitest file at head. Trunk has no `aspect` field, so record that and gate the new assertions plus a parsed example camera. Save `pr-shape-lane-regression.png`. Pass when trunk JSON shows `audio_off_has_audio` true and head vitest exits 0.
- [ ] Lane 2. Audio off. Save `pr-shape-lane-audio-off.png`. Pass when the response has no audio property and the ffmpeg args have no `-c:a`.
- [ ] Lane 3. Key echo. Save `pr-shape-lane-key.png`. Pass when the response video key bytes equal the request video key bytes.
- [ ] Lane 4. Second answer. Save `pr-shape-lane-double.png`. Pass when the first answer is allowed, the second answer is rejected, and the callback count is 1.
- [ ] Lane 5. Four by three crop. Save `pr-shape-lane-crop.png`. Pass when a Garage Door 1280 by 720 ask contains `crop=` and does not contain `pad=`.
- [ ] Lane 6. Sixteen by nine pad. Save `pr-shape-lane-pad.png`. Pass when a Backyard Left 1280 by 720 ask contains `pad=` and does not contain `crop=`.
- [ ] Lane 7. Missing aspect. Save `pr-shape-lane-aspect.png`. Pass when a camera object without `aspect` makes `parseArgusConfig` throw.
- [ ] Lane 8. Bind address. Save `pr-shape-lane-bind.png`. Pass when `ARGUS_HAP_BIND=not-an-iface` does not return the string `not-an-iface`, and `ARGUS_HAP_BIND=10.0.0.46` returns `10.0.0.46`.
- [ ] Lane 9. Diary deleted. Save `pr-shape-lane-diary.png`. Pass when `rg FIELD TEST RESULT src/homekit.ts` prints nothing, and `rg PARKED src/serve.ts` prints nothing.
- [ ] Lane 10. Timing file untouched. Save `pr-shape-lane-timing.png`. Pass when `git diff origin/main -- src/timing.ts` is empty.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Exit status and wall time of `npx vitest run tests/homekit.test.ts tests/hap-setup-contract.test.ts` at trunk and at head. Trunk has no contract file, so also time the existing homekit file alone on both sides.
- [ ] Probe. Run the homekit vitest at trunk, then both files at head, then the homekit file at trunk again.
- [ ] Baseline. Record the trunk exit status and the trunk duration first.
- [ ] Rule. Head fails when vitest exits non-zero. Do not report a duration ratio. The budget is a zero exit. A draft measurement at `20bd5e3` was 48 passed in 3.35 seconds and is not this baseline.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and lane 5 screenshots into `docs/reviews/pr-shape-review-contract.png` and `docs/reviews/pr-shape-review-crop.png`.
- [ ] Record a 30 to 60 second video of the contract test and the failing parse on a lane VM. Save it as `docs/reviews/pr-shape-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's review. Do not deploy.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Peter squash-merges this PR. The owner does not merge.

## Run the contract on every pull request, PR-ci

**Depends on.** PR-shape.

**Files.**

- [ ] Create `.github/workflows/ci.yml`.
- [ ] Edit the test files that fail `tsc` once `tests/**/*.ts` is included. Measured set is `tests/homekit.test.ts`, `tests/go2rtc-api-secrets.test.ts`, `tests/install-launchd.test.ts`, `tests/recording.test.ts`, `tests/snapshot-cache.test.ts`, and `tests/stream-health.test.ts`.
- [ ] Leave `tsconfig.json` as the emit program. Add `tsconfig.check.json` so the CI program typechecks `src` and `tests` without moving `dist/`.
- [ ] Create `scripts/firmware-census.mjs` from the prototype rule. Do not import `src/timing.ts`.

**Build.**

- [ ] The workflow runs `npx tsc -p tsconfig.json --noEmit` and `npx vitest run` on pull requests. It has no deploy job and no SSH step.
- [ ] Fix the 18 test type errors so that program exits 0. Replace string codec literals that are not `AudioStreamingCodecType` with the enum.
- [ ] The census fails a diff that changes `ARGUS_FIRMWARE_REVISION` while the ladder, profiles, and codec lines in `buildCameraControllerOptions` stay the same.
- [ ] Keep `exactOptionalPropertyTypes` true.

**You see.**

- [ ] A pull request that only changes the firmware string goes red.
- [ ] `npx tsc` covering `src` and `tests` exits 0.
- [ ] The bad optional assignment still exits 2 with `TS2375` when compiled under that flag.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add a fixture test that the census marks commit `6117635239cb0e5bdcbd877160fe877967a1d99e` as churn and commit `2312c702ccedb8d0587fff0bebe3f269765143b6` as justified. Run `npx vitest run tests/firmware-census.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npx tsc -p tsconfig.json --noEmit` at trunk and the widened program at head. Trunk typechecks `src` only. Record that, and gate a zero exit on `src` plus a zero exit on `src` and `tests` at head. Save `pr-ci-lane-regression.png`. Pass when both commands exit 0.
- [ ] Lane 2. Eighteen errors gone. Save `pr-ci-lane-tsc-tests.png`. Pass when the widened `tsc` prints no `error TS`.
- [ ] Lane 3. Workflow matches the local commands. Save `pr-ci-lane-workflow.png`. Pass when `.github/workflows/ci.yml` contains `npx tsc -p tsconfig.json --noEmit` and `npx vitest run`.
- [ ] Lane 4. Churn fixture. Save `pr-ci-lane-churn.png`. Pass when the census reports churn for `6117635239cb0e5bdcbd877160fe877967a1d99e`.
- [ ] Lane 5. Justified fixture. Save `pr-ci-lane-justified.png`. Pass when the census reports justified for `2312c702ccedb8d0587fff0bebe3f269765143b6`.
- [ ] Lane 6. Ladder change. Save `pr-ci-lane-ladder.png`. Pass when parent `96174fd3a6839b67eaa266c2a2c03b88d9a95f32` to `87fe4edf22e25a9f15b17ae705bcdd7b98901944` is an advertisement change.
- [ ] Lane 7. Version-only diff. Save `pr-ci-lane-version-only.png`. Pass when a scratch edit of the firmware string alone makes the census exit non-zero, and the scratch edit is reverted afterward.
- [ ] Lane 8. Exact optional. Save `pr-ci-lane-optional.png`. Pass when the bad sample exits 2 and the text contains `TS2375`.
- [ ] Lane 9. No deploy. Save `pr-ci-lane-no-deploy.png`. Pass when `rg -n "ssh|deploy" .github/workflows/ci.yml` finds no command.
- [ ] Lane 10. Timing file untouched. Save `pr-ci-lane-timing.png`. Pass when `git diff origin/main -- src/timing.ts` is empty.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `npx tsc -p tsconfig.json --noEmit` and of `npx vitest run` at trunk and at head.
- [ ] Probe. Run `tsc`, then vitest, at trunk, then at head, then `tsc` at trunk again.
- [ ] Baseline. Record the trunk durations first.
- [ ] Rule. Head fails when either command exits non-zero. Do not report a duration ratio. The budget is a zero exit for both commands.

**Review gate.** None. PR-ci does not change a Home session.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Peter squash-merges this PR. The owner does not merge.

## Delete the stale deploy notes, PR-prose

**Depends on.** PR-shape.

**Files.**

- [ ] Create `docs/invariants.md`.
- [ ] Delete each root markdown file that is a one-off field fix or a deploy checklist. Keep `README.md`, `SPEC.md`, `LEARNINGS.md`, `PROJECT.md`, `progress/`, `scenarios/`, and `docs/`.
- [ ] Do not edit `src/timing.ts`.

**Build.**

- [ ] Write `docs/invariants.md` in under 80 lines. State the firmware rule, the SRTP echo, the audio-off omission, the aspect filter, and that a first-frame log line is not the painted picture.
- [ ] Do not assign a firmware version in that file. Point at `ARGUS_FIRMWARE_REVISION` in source.
- [ ] Do not add a deploy procedure.

**You see.**

- [ ] `docs/invariants.md` exists and is under 80 lines.
- [ ] A root note that tells the reader to grep for firmware `1.3.0` is gone.
- [ ] `docs/camera-health.md` is still present.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] No new test. Run `npx vitest run tests/homekit.test.ts` so the deletion did not touch behavior. The file list in the diff is the assertion for the docs.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. List root `*.md` at trunk and at head. Save `pr-prose-lane-regression.png`. Pass when head is missing the field-fix notes and still has `README.md`, `SPEC.md`, `LEARNINGS.md`, and `PROJECT.md`.
- [ ] Lane 2. Invariants length. Save `pr-prose-lane-length.png`. Pass when `docs/invariants.md` is under 80 lines.
- [ ] Lane 3. No version assignment. Save `pr-prose-lane-version.png`. Pass when `docs/invariants.md` contains `ARGUS_FIRMWARE_REVISION` and does not contain `ARGUS_FIRMWARE_REVISION =`.
- [ ] Lane 4. Picture sentence. Save `pr-prose-lane-picture.png`. Pass when the file says a first-frame log line is not the painted picture.
- [ ] Lane 5. Camera health kept. Save `pr-prose-lane-health.png`. Pass when `docs/camera-health.md` exists.
- [ ] Lane 6. Spec kept. Save `pr-prose-lane-spec.png`. Pass when `SPEC.md` and `LEARNINGS.md` exist.
- [ ] Lane 7. No new deploy checklist. Save `pr-prose-lane-no-deploy.png`. Pass when the diff adds no file whose name contains `DEPLOY`.
- [ ] Lane 8. Homekit tests still pass. Save `pr-prose-lane-vitest.png`. Pass when `npx vitest run tests/homekit.test.ts` exits 0.
- [ ] Lane 9. Diary stays deleted. Save `pr-prose-lane-diary.png`. Pass when `rg FIELD TEST RESULT src` prints nothing.
- [ ] Lane 10. Timing file untouched. Save `pr-prose-lane-timing.png`. Pass when `git diff origin/main -- src/timing.ts` is empty.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Exit status of `npx vitest run tests/homekit.test.ts` at trunk and at head. This PR does not change that work, so the durations should be the same command.
- [ ] Probe. Run the homekit vitest at trunk, then at head, then at trunk again.
- [ ] Baseline. Record the trunk exit status and duration first.
- [ ] Rule. Head fails when vitest exits non-zero. Do not report a duration ratio. The budget is a zero exit.

**Review gate.** None. PR-prose does not change a Home session.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Peter squash-merges this PR. The owner does not merge.

## Add the field-check skill, PR-verify

**Depends on.** PR-ci.

**Files.**

- [ ] Create `.cursor/skills/verify-argus/SKILL.md` and `.cursor/skills/verify-argus/features/` for HAP setup, the firmware census, and the exact-optional probe.
- [ ] Create `.cursor/skills/verify-argus/doctor.sh`.
- [ ] Do not edit `src/timing.ts`. Do not add an SSH command.

**Build.**

- [ ] Copy the prototype skill's launch, doctor, drive, evidence, and cleanup sections onto the real path, and point the commands at the CI census and the contract test rather than `prototypes/`.
- [ ] Doctor fails when `src/timing.ts` differs from `origin/main`.
- [ ] The picture feature says a `live_session_first_frame` line is not a pass, and that the iPhone check stays with Peter.

**You see.**

- [ ] `bash .cursor/skills/verify-argus/doctor.sh` prints `doctor=ok` and `mini=not-contacted`.
- [ ] One drive writes a proof file under a path the skill names, and cleanup leaves that file in place.
- [ ] The skill text contains no `ssh` command.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npx vitest run tests/hap-setup-contract.test.ts` and `bash .cursor/skills/verify-argus/doctor.sh`. Both exit 0.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no `verify-argus` skill. Record that. At head, run the doctor and one HAP drive. Save `pr-verify-lane-regression.png`. Pass when the doctor prints `doctor=ok` and the proof file exists.
- [ ] Lane 2. Frontmatter. Save `pr-verify-lane-frontmatter.png`. Pass when `SKILL.md` starts with `name: verify-argus`.
- [ ] Lane 3. Doctor timing guard. Save `pr-verify-lane-timing-guard.png`. Pass when the script diffs `src/timing.ts` against `origin/main`.
- [ ] Lane 4. Drive one feature. Save `pr-verify-lane-drive.png`. Pass when the HAP proof file exists after the drive command.
- [ ] Lane 5. Cleanup keeps proof. Save `pr-verify-lane-cleanup.png`. Pass when the proof file is still on disk after the cleanup command.
- [ ] Lane 6. Picture rule. Save `pr-verify-lane-picture.png`. Pass when the skill says a first-frame log line is not a pass for the picture.
- [ ] Lane 7. No SSH. Save `pr-verify-lane-no-ssh.png`. Pass when `rg -n ssh .cursor/skills/verify-argus` finds no remote command.
- [ ] Lane 8. Feature headings. Save `pr-verify-lane-map.png`. Pass when each feature file has the four required headings.
- [ ] Lane 9. Census feature. Save `pr-verify-lane-census.png`. Pass when the firmware feature file names `pr3_churn`.
- [ ] Lane 10. Mini not contacted. Save `pr-verify-lane-mini.png`. Pass when the doctor prints `mini=not-contacted`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `bash .cursor/skills/verify-argus/doctor.sh` at head. Trunk has no script, so the trunk metric is the existing `npx tsc -p tsconfig.json --noEmit` that the doctor wraps.
- [ ] Probe. Run `npx tsc -p tsconfig.json --noEmit` at trunk, then the doctor at head, then `tsc` at trunk again.
- [ ] Baseline. Record the trunk `tsc` duration first.
- [ ] Rule. Head fails when the doctor exits non-zero. Do not report a duration ratio against trunk. The budget is a zero exit and the `doctor=ok` line.

**Review gate.** None. PR-verify does not change a Home session.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Peter squash-merges this PR. The owner does not merge.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to Peter with the stack links, the verdict for each PR, and anything left unproven.

## Appendix A. Prototype evidence

These commands ran on this draft branch, based on `20bd5e3`. The scripts are prototypes. They are not the change to merge. Raw output is in `prototypes/agent-trust/evidence/`.

Firmware census, `python3 prototypes/agent-trust/firmware-census.py`. PR 3 has 56 commits and 16 firmware versions from `1.1.0` to `1.3.13`. Three steps changed the ladder, profiles, or codecs. Twelve did not. On main, PR 5 commit `fcca4a5069ec431615e66c57aeada43be8b5b7fa` at firmware `1.3.14` and PR 6 commit `96174fd3a6839b67eaa266c2a2c03b88d9a95f32` at firmware `1.3.15` are `AD_SAME`. PR 18 commit `87fe4edf22e25a9f15b17ae705bcdd7b98901944` at firmware `1.3.16` is `AD_CHANGED`.

HAP contract, `npx tsx prototypes/agent-trust/hap-setup-contract.ts`. Audio-on echoes the request SRTP key and includes audio. Audio-off still includes audio on the response, and the ffmpeg args have no `-c:a`. The state machine's first answer is true and the second is false. The test `prevents double-callback crash` calls `prepareStream` once. The crop filter is `scale=1280:720:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1280:720,setsar=1`. The default filter is `scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2`. `ARGUS_HAP_BIND=10.0.0.46` returns that address. `ARGUS_HAP_BIND=not-an-iface` does not return that name. This VM returned `172.30.0.2`.

Exact optional probe, `node prototypes/agent-trust/exact-optional-probe.mjs`. The bad assignment exits 2 with `TS2375`. The union sample exits 0.

Test typecheck. A temporary program with `exactOptionalPropertyTypes` including `src` and `tests` printed 18 errors and exited 2. Codes were four `TS2493`, four `TS2322`, four `TS2304`, two `TS2339`, two `TS1259`, one `TS2532`, and one `TS18048`. `tests/homekit.test.ts` had 10 of them, including string codec literals that are not `AudioStreamingCodecType`.

Homekit vitest at `20bd5e3` on this VM. `npx vitest run tests/homekit.test.ts` exited 0. 48 tests passed in 3.35 seconds. That number is this machine, not a future baseline.

Verification skill proof. `bash prototypes/agent-trust/verify-argus/doctor.sh` printed `head=20bd5e3852cfb5e33d48b6ee0f3567173f39c4dd`, `mini=not-contacted`, and `doctor=ok`, then exited 0. The HAP drive wrote `prototypes/agent-trust/evidence/hap-setup.json` and exited 0. Cleanup was `echo cleanup=noop`, and that JSON file was still on disk.

`hap-nodejs` `0.14.3` types `PrepareStreamResponse.audio` as optional. `RTPStreamManagement.js` throws `Audio was enabled but not supplied in PrepareStreamResponse!` when video-only mode is false and audio is missing. An empty codec list sets video-only mode and still pushes a fake Opus codec into the advertisement.

The prepare-answer union in the probe compiled. That is the shape PR-shape should implement. It is not in `src` on this branch.

Chat transcripts were not available. `~/.cursor/projects/workspace/agent-transcripts` does not exist. The project inbox files that were opened are GitHub delivery events, including the merge notice for PR 18. They are not a record of Peter typing. The steering summary in Appendix F uses the store notes and the GitHub review threads that were opened.

## Appendix B. Pitfall table

Rank is by how often the miss repeated and by field rounds lost. Count is what this draft measured or read. Prevented by names the later PR.

| Rank | Pitfall | Count | Evidence | Prevented by |
| --- | --- | --- | --- | --- |
| 1 | Firmware bump with an unchanged ladder, profile list, and codec list | 12 of 15 steps on PR 3, plus PR 5 and PR 6 | [PR 3](https://github.com/point-labs-dev/argus/pull/3), census in `prototypes/agent-trust/evidence/firmware-census.txt`, [PR 5](https://github.com/point-labs-dev/argus/pull/5), [PR 6](https://github.com/point-labs-dev/argus/pull/6) | PR-ci census, PR-shape deletes the diary that says to bump, PR-prose deletes the root checklists |
| 2 | RTCP URL and watchdog experiments scored on a spinner | 3 URL revisions on PR 3 (`1.3.3`, `1.3.4`, `1.3.5`), then the watchdog removal in PR 6 and the 15 minute abandon in [PR 13](https://github.com/point-labs-dev/argus/pull/13) | [1.3.3](https://github.com/point-labs-dev/argus/commit/91e96938139e0199db7005ad43d431ea3a8c4cbd), [1.3.4](https://github.com/point-labs-dev/argus/commit/e045386291d92e185a1c1e4add829fa296512e3b), [1.3.5](https://github.com/point-labs-dev/argus/commit/ecadaaaf3f3e4f2cdbbb38e87355c1c3604ac203) | PR-ci runs the existing URL pin. PR-prose says the first-frame log is not the picture. No new URL flag |
| 3 | Double `prepareStream` callback | 4 commits (`1.3.7` through `1.3.10`), 3 failed field notes, then a crash on the revert | [1.3.7](https://github.com/point-labs-dev/argus/commit/6117635239cb0e5bdcbd877160fe877967a1d99e), [1.3.9](https://github.com/point-labs-dev/argus/commit/56045dd342d8c18909dc233ca8b769dd43e9f067) | PR-shape makes the test call the answer twice. The guard already returns false on the second call |
| 4 | MAIN source parked, then unreachable under the cap | Park commit, then the cap bug fixed in PR 6. The parked comment is still in `src/serve.ts` | [park](https://github.com/point-labs-dev/argus/commit/b559f7e5bee95319d0402753e363ae7783f3c0b5), [PR 6](https://github.com/point-labs-dev/argus/pull/6) | PR-shape deletes the parked comment. The policy test already encodes the pre-cap rule |
| 5 | Four by three picture padded into a sixteen by nine box | Pad commit on PR 3, pillarbox seen in the field, crop landed in [PR 18](https://github.com/point-labs-dev/argus/pull/18). The default filter and the pad test still teach pad for every aspect | [pad](https://github.com/point-labs-dev/argus/commit/3568b2c8927fc3206783d8bce344b57dec53ad31), `tests/homekit.test.ts` pad case | PR-shape replaces the name set and the `cropToFill` flag with required `aspect` |
| 6 | HAP answer does not match the packets ffmpeg sends, and a first frame is treated as paint | SRTP key fix [9cd9271](https://github.com/point-labs-dev/argus/commit/9cd927197d2f0fba0b2a83e3a27dd13226f4a2b1). Video-only ports [01dee81396](https://github.com/point-labs-dev/argus/commit/01dee8139693f1da2c0eba27b940afd80413631e). Diary field note for `1.3.11` has a first frame and still no picture. Audio-off still returns audio today | Contract JSON `audio_off_has_audio` true and `audio_off_ffmpeg_has_audio_codec` false | PR-shape `prepareAnswer`. PR-prose and PR-verify say the log line is not the picture |
| 7 | `exactOptionalPropertyTypes` break, with tests outside `tsc` | One Mini build break, `TS2412` and `TS2375`, in [1813f77](https://github.com/point-labs-dev/argus/commit/1813f771f120f2644b16ffb20fe0564be96a4cf5). The bad pattern exits 2 with `TS2375` now. Widening `tsc` to tests prints 18 errors | Probe JSON and the temporary `tsc` run | PR-ci keeps the flag, typechecks tests, and runs `tsc` in GitHub Actions. The repo has no `.github` workflow today |

Ten `FIELD TEST RESULT` lines sit in the comment above `ARGUS_FIRMWARE_REVISION` in `src/homekit.ts`. They are the field rounds for rank 1 through rank 3 on 2026-10-02. GitHub review threads exist on [PR 2](https://github.com/point-labs-dev/argus/pull/2#pullrequestreview-5374141402) and [PR 3](https://github.com/point-labs-dev/argus/pull/3#pullrequestreview-5378799534). Both are signed as QA reviews. PRs 4 through 19 have no review bodies. PR 2 had no CI to trust, and the repo still has no `.github` workflow.

## Appendix C. Alternatives rejected

A lint that bans the word firmware was rejected. The legal bump is the one that changes the advertisement. The census encodes that. A banned word would also ban the constant agents must read.

Leaving `cropToFill` next to the name set was rejected. The contract measured both filters from one boolean. A camera name and that boolean can disagree. One `aspect` value cannot.

Landing the contract test red, before the shape fix, was rejected. Each later PR has to stay green. The prototype already shows the current audio-off answer failing the desired check.

Another SRTP query parameter, another RTCP timeout, and another firmware bump were rejected. Those are the fixes that already failed the same field gate. The premise was that a Mac spinner meant the URL was wrong. The progress history already records Mac-local Home as a bad picture instrument. This plan does not add a URL flag.

Splitting types and module boundaries into two PRs was rejected. The answer builder is the boundary. A half-landed builder is a second example to copy.

## Appendix D. Risks

PR-shape can change a future boot. Required `aspect` makes a Mini yaml without that field fail parse. This plan does not deploy, so the running Mini stays on its current build. The risk lands only when Peter deploys a build that includes PR-shape. Appendix E states the default and the override.

The behavior pull request's audio-off omission matches `hap-nodejs` `0.14.3` only when the codec list is empty, because that is when the library sets video-only mode. If audio is advertised and the response omits audio, the library throws. The owner must keep those two sides together. The happy path stays audio-on. PR-shape still returns audio when audio is off.

PR-ci's widened `tsc` fails today with 18 errors. The PR includes those fixes. They are type fixes in tests, and the owner must not change assertions just to silence a code.

`control-cli` is not installed. Live lanes drive `npx vitest` and `npx tsx`. The iPhone is not on the lane VM. A green lane is not a painted picture.

The prototype folder on this draft branch is not an implementation. Later PRs reimplement the checks under `tests/`, `scripts/`, and `.cursor/skills/`. Merging this draft would publish the prototypes as if they were the fix. Leave the draft unmerged.

## Appendix E. Questions for Peter

Peter approved all three defaults on 10/16. The opened pull requests follow them.

The firmware gate fails a bump when the ladder, profiles, and codecs are unchanged. That marks 12 of the 15 PR 3 steps, plus the bumps in PR 5 and PR 6. A bump that changes the ladder still passes, which includes the `1.3.12` step whose field note says Home kept asking for 720p anyway.

`aspect` becomes required on every camera, and a missing field fails config parse. The name set is deleted in that same PR. The Mini is not restarted here. The next deploy Peter approves will refuse to boot until that yaml has `aspect`. The stream-setup pull request lists the key and the value for each camera from the 2026-10-16 `ffprobe`. Doorbell stays `4:3` and is marked unverified.

The prose PR deletes root markdown files that are one-off field fixes or deploy checklists, and it keeps `README.md`, `SPEC.md`, `LEARNINGS.md`, `PROJECT.md`, `progress/`, `scenarios/`, and `docs/`. It also keeps `LATENCY.md`, `TESTING.md`, and `TELEMETRY-QUICK-REF.md`, because those are the alert-latency notes and this program does not touch that work.

## Appendix F. Links and reading list

Read before editing. `src/homekit.ts`, `src/homekit/session-state-machine.ts`, `src/homekit/session-policy.ts`, `src/serve.ts`, `src/config.ts`, `tests/homekit.test.ts`, and `node_modules/hap-nodejs/dist/lib/camera/RTPStreamManagement.d.ts` at the installed `0.14.3`.

Method. [poteto, how do you trust your agents' work more?](https://x.com/poteto/status/2111133080526495985). Code and types first, then lint and tests, then a short note, then human review. Use `/create-verification-skill` for the field check, and keep that check local.

Recall scope. Argus pull requests 1 through 19, the project store notes, and the GitHub review threads. No agent chat transcript could be opened.

What the opened record shows about steering. Deploy, reboot, and Home checks wait for Peter's go. The store plan says not to bump firmware when the advertisement stays. The store live-picture note separates the stopwatch from `live_first_frame`. PR 13's 15 minute quiet-RTCP limit is an accepted limit, not a new bug. FileVault plan C was a choice, and it is not installed until he says so. QA on PR 2 blocked an unguarded telemetry call and a jq recipe that did not match the log line. QA on PR 3 blocked a producer check that was true for idle streams, then blocked a summary doc that still described the deleted check.

PRs that get a fresh read of the code before editing are PR-shape and PR-ci. PR-prose and PR-verify should not rediscover the streaming design. They follow the shape that landed.

The decision trail for a later execution belongs with that execution, per the show-me-your-work skill. This draft's trail is the evidence directory and this plan.
