# Publish full camera controls in Apple Home

Peter gets each camera's real controls in Apple Home, and nothing the camera cannot do. Support comes from Home Manager's read-only GetAbility pass. A config flag can only turn a supported feature off. The firmware revision constant stays `1.3.16`. This plan records no house address and no serial.

The PR order is capabilities, floodlight, siren, doorbell, talk, home-mode, then night. The operator lands that stack. This file does not implement it.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. The operator lands capabilities, floodlight, siren, doorbell, talk, home-mode, and night. Each of those stops at merge-ready. Nobody merges from this plan.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

Appendix E is the ability matrix. Appendix F is the mapping, the commands, and rollback.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:pstack/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:pstack/skills/technical-writing/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/unslop/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/no-comments/SKILL.md`
  - [ ] If `git show` fails, read the same path from the poteto skill store. The Argus repo does not contain `pstack`.
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim.

```
Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none.
```

- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.
- [ ] Do not push to pull requests 21, 26, 23, 24, or 25. Do not edit those branches. Do not deploy to the Mini until the operator says deploy. Do not SSH from this program.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] capabilities is first. It branches from this plan branch.
  - [ ] floodlight after capabilities. Base it on the capabilities branch.
  - [ ] siren after floodlight.
  - [ ] doorbell after siren.
  - [ ] talk after doorbell.
  - [ ] home-mode after talk.
  - [ ] night after home-mode. If the IR write values are still unnamed, do not spawn night.
- [ ] Hold the file boundaries. capabilities touches only `src/camera-features.ts`, `src/reolink.ts`, `src/config.ts`, `argus.example.yaml`, and `tests/camera-features.test.ts`. floodlight, siren, doorbell, talk, home-mode, and night touch `src/homekit.ts` only in that order, because they share it. home-mode also touches `src/reolink.ts` for the motion filter. `src/serve.ts` changes only in floodlight and doorbell, where the record has to reach publish. A later PR may edit `tests/camera-features.test.ts` only to replace an expected literal that its own change made false.
- [ ] Hold the review gate. floodlight, siren, doorbell, talk, home-mode, and night change a Home interaction. They wait for the operator's review in chat with screenshots and a video before merge. capabilities does not.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`. If `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per Opening a PR. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. The commands are `npm run build` and `npm test`.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, or on a CI failure that comes from a change on trunk.
- [ ] Leave the firmware revision constant untouched. `docs/invariants.md` allows a bump only when the advertised ladder, profile list, or codec list changes. This program changes none of those.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's Verify, live block. The perf lane from its Verify, perf block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] No owner merges, arms auto-merge, or closes. A clean verdict appends the PR to the one linear base-branch stack. The operator lands it bottom-up. Apply the patch-id rule in `playbooks/shipping.md` at each verdict SHA.

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Apple Home has no `control-ui` and no `control-cli` in this repo. Drive the iPhone Home app by hand. Read Argus logs for the predicates that are not on screen. Do not start these lanes until the operator says deploy.

- [ ] `git fetch` the head branch and `git checkout` the head SHA.
- [ ] Start Argus from that SHA. Wait until the seven accessories are published. Use the house file only on the operator's deploy go. A scratch config uses the host name `camera.example` and never a house address.
- [ ] Deliver taps through the iPhone Home app. Read-only diagnostics are the Argus log and the HAP accessory service list. Do not send a camera write from a lane whose PR has not shipped that write.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Add the capability record, capabilities

**Depends on.** None.

**Files.**

- [ ] Create `src/camera-features.ts`.
- [ ] Edit `src/reolink.ts`.
- [ ] Edit `src/config.ts`.
- [ ] Edit `argus.example.yaml`.
- [ ] Create `tests/camera-features.test.ts`.
- [ ] Do not edit `src/homekit.ts` or `src/serve.ts` in this PR.

**Build.**

- [ ] Add `CameraAbility` and `CameraFlags` in `src/camera-features.ts`. Siren is the union `none`, `v1`, or `v20`. Flags are booleans and default to false. `publishedFeatures` returns a feature only when the ability and the flag both allow it. A flag cannot select the siren API version.
- [ ] Add `categoryFor`. It returns 18 only when the doorbell ability and the doorbell flag both allow it. Otherwise it returns the IP camera category. This PR does not call it from `serve.ts` or `createCameraAccessory`.
- [ ] Parse GetAbility at the edge of `ReolinkClient`. Action is 0. Cache one success for the process. On failure, return no features. Do not call GetWhiteLed. Do not call GetAudioAlarmV20 to decide support.
- [ ] Add an optional `features` object on `cameraSchema` in `src/config.ts`. Missing keys stay false, so today's house file keeps today's accessories.
- [ ] Show the keys, all false, in `argus.example.yaml`. Use no house address.

**You see.**

- [ ] `npx vitest run tests/camera-features.test.ts` prints the seven literal records from Appendix E.
- [ ] A published accessory still has the same service display names as this branch before the edit. The owner records that list from one run and asserts the literals. Do not type the list from memory.
- [ ] The firmware revision characteristic is still `1.3.16`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Mutant. Spotlight ability false and spotlight flag true. Expect spotlight false. Run `npx vitest run tests/camera-features.test.ts`.
- [ ] Mutant. A GetWhiteLed-shaped default sits in the fixture. Expect spotlight false unless the ability field says true.
- [ ] Mutant. A V20 audio-alarm default sits on the Backyard Left fixture. Expect siren `v1`, because the ability says V1.
- [ ] Mutant. A talk permit flag sits on the Garage Door fixture. Expect talk false.
- [ ] Mutant. GetAbility fetch fails. Expect every published feature false, and expect no Set command in the recorded requests.
- [ ] Mutant. `publishedFeatures` called twice after one success. Expect one GetAbility request, then the cached record.
- [ ] Mutant. Doorbell ability true and flag true. Expect `categoryFor` to return 18. Expect `createCameraAccessory` to stay an IP camera.
- [ ] Assert `createCameraAccessory` service names equal the recorded trunk list. Run `npx vitest run tests/camera-features.test.ts`.
- [ ] Run `npm test` and `npm run build`. Run `npx vitest run tests/firmware-census.test.ts tests/invariants.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the Home camera grid at trunk and head. If trunk lacks the feature, record that and gate the unchanged seven-camera grid plus the end state the user waits for. Save `capabilities-lane-1.png`. Pass when both sides show seven cameras and no light, siren, or doorbell tile.
- [ ] Lane 2. Open Front L. Save `capabilities-lane-2.png`. Pass when Front L has no floodlight tile.
- [ ] Lane 3. Open Front R. Save `capabilities-lane-3.png`. Pass when Front R has no floodlight tile.
- [ ] Lane 4. Open Backyard Left. Save `capabilities-lane-4.png`. Pass when Backyard Left has no siren switch.
- [ ] Lane 5. Open the Doorbell. Save `capabilities-lane-5.png`. Pass when it is still an IP camera and has no ring button.
- [ ] Lane 6. Open Garage Door. Save `capabilities-lane-6.png`. Pass when Garage Door has no new tile.
- [ ] Lane 7. Open Backyard. Save `capabilities-lane-7.png`. Pass when Backyard has no new tile.
- [ ] Lane 8. Open Backyard Right. Save `capabilities-lane-8.png`. Pass when Backyard Right has no new tile.
- [ ] Lane 9. Show the vitest log for the mutant suite. Save `capabilities-lane-9.png`. Pass when the log shows the mutant file passed.
- [ ] Lane 10. Read the firmware revision characteristic. Save `capabilities-lane-10.png`. Pass when the value is `1.3.16`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Home tile count on both sides, and milliseconds to parse seven fixtures on the head. Trunk has no parser, so its parse metric is the recorded absence.
- [ ] Probe. Interleave trunk and head. Count Home tiles on both. Time the fixture parse only on the head.
- [ ] Baseline. Record the trunk tile count first. Record that trunk has no parser.
- [ ] Rule. Fail if the head tile count differs from trunk. Fail if the head parse takes 50 ms or more. The 50 ms figure is a budget. Nobody has measured it on this branch. A parse of seven small fixtures that takes that long has waited on the network. The owner measures the real parse and writes that number down before merge.

**Review gate.** None. capabilities is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends this PR to the stack. The operator lands it. The owner does not merge.
- [ ] Rollback. Set every new flag false and restart. The accessory list matches trunk. Do not delete `.homekit`. Do not change the firmware revision constant.

## Publish floodlights, floodlight

**Depends on.** capabilities.

**Files.**

- [ ] Edit `src/homekit.ts`.
- [ ] Edit `src/serve.ts`.
- [ ] Create `tests/floodlight.test.ts`.
- [ ] Edit `tests/camera-features.test.ts` only to replace the no-light literal.
- [ ] Do not edit the firmware revision constant.

**Build.**

- [ ] When `publishedFeatures` says spotlight, add `Service.Lightbulb` with `Characteristic.On`. When it also says brightness, add `Characteristic.Brightness`.
- [ ] Front L and Front R are the only cameras whose record says spotlight and brightness. Pass Home's 0 to 100 integer through in the log. If the camera rejects 1 or 100, stop and ask for the range. Do not invent a scale.
- [ ] The floodlight write command name is not in Home Manager's summary. Stop this PR until that name is supplied. Do not infer it from GetWhiteLed.
- [ ] On and off are idempotent. A second on while the light is on does not toggle it off.

**You see.**

- [ ] Front L and Front R gain a light in Home. The log line is `floodlight_set` plus the integer that was sent.
- [ ] Garage Door, Backyard, Backyard Left, Backyard Right, and the Doorbell have no light.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Mutant. Front L record with both gates true. Expect a Lightbulb and Brightness. Run `npx vitest run tests/floodlight.test.ts`.
- [ ] Mutant. Garage Door flag true and ability false. Expect no Lightbulb.
- [ ] Mutant. Spotlight true and brightness false. Expect On and no Brightness characteristic.
- [ ] Mutant. Startup requests contain no floodlight write. Expect the write only after On changes.
- [ ] Run `npm test` and `npm run build`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the Front L tile at trunk and head. If trunk lacks the feature, record that and gate the new light plus the end state the user waits for. Save `floodlight-lane-1.png`. Pass when trunk has no light and the head light exists only on Front L and Front R.
- [ ] Lane 2. Turn Front L on. Save `floodlight-lane-2.png`. Pass when the log contains `floodlight_set` and the light is on.
- [ ] Lane 3. Turn Front L off. Save `floodlight-lane-3.png`. Pass when the log shows off and the light is off.
- [ ] Lane 4. Set Front L brightness to 100. Save `floodlight-lane-4.png`. Pass when the log shows 100.
- [ ] Lane 5. Set Front L brightness to 1. Save `floodlight-lane-5.png`. Pass when the log shows 1. If the camera rejects it, the lane fails and the owner stops.
- [ ] Lane 6. Turn Front R on, then off. Save `floodlight-lane-6.png`. Pass when both states match the log.
- [ ] Lane 7. Open Garage Door with a scratch flag forced true. Save `floodlight-lane-7.png`. Pass when Garage Door has no light.
- [ ] Lane 8. Open the Doorbell and Backyard Left. Save `floodlight-lane-8.png`. Pass when neither has a light.
- [ ] Lane 9. Open Backyard and Backyard Right. Save `floodlight-lane-9.png`. Pass when neither has a light.
- [ ] Lane 10. Restart Argus. Save `floodlight-lane-10.png`. Pass when Front L shows the same on or off state as before the restart.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Whether a floodlight tile exists, on trunk and head. On the head, milliseconds from the On write to `floodlight_set`.
- [ ] Probe. Interleave trunk and head. Record the tile on both. Time the write only on the head.
- [ ] Baseline. Record the trunk absence first.
- [ ] Rule. Fail if a camera other than Front L or Front R shows a light. Fail if `floodlight_set` is missing at 2 seconds. The 2 second figure is a budget. Nobody has measured it on this branch. The motion poll default is 1000 ms in `MotionMonitor`. A control that takes 2 seconds has already missed a poll. The owner measures the real delay and names whether the camera HTTP or the HAP callback waited.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 2 screenshot into chat with the operator. Do not commit the screenshot.
- [ ] Record a 30 to 60 second video of Front L on, then off. Save it as `floodlight-review.mp4`. Post the video in chat.
- [ ] Stop at merge-ready. Wait for the operator to accept the screenshot and the video.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends this PR to the stack. The operator lands it. The owner does not merge.
- [ ] Rollback. Set the spotlight flags false and restart. The lights disappear. The pairing files stay. Do not delete `.homekit`.

## Publish siren switches, siren

**Depends on.** floodlight.

**Files.**

- [ ] Edit `src/homekit.ts`.
- [ ] Create `tests/siren.test.ts`.
- [ ] Edit `tests/camera-features.test.ts` only to replace the no-siren literal.
- [ ] Do not edit the firmware revision constant.

**Build.**

- [ ] When the record says siren `v1` or `v20` and the flag is true, add `Service.Switch` with `Characteristic.On`.
- [ ] Backyard Left uses audio-alarm V1. The Doorbell uses the V20 audio-alarm API. No other camera gets a switch.
- [ ] Do not read GetAudioAlarmV20 to decide support. The ability record already decided.
- [ ] Drive the switch from the alarm state. If the camera clears the alarm by itself, the next read sets the switch off. Do not invent a timeout.

**You see.**

- [ ] Backyard Left and the Doorbell each show one switch. The log names `v1` or `v20`.
- [ ] The other five cameras show no siren switch.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Mutant. Backyard Left ability `v1` and flag true, with a V20 decoy in the fixture. Expect a switch that writes V1. Run `npx vitest run tests/siren.test.ts`.
- [ ] Mutant. Doorbell ability `v20` and flag true. Expect a V20 write and no V1 write.
- [ ] Mutant. Garage Door flag true and siren `none`. Expect no switch.
- [ ] Mutant. Alarm read returns cleared after an on. Expect the characteristic off.
- [ ] Run `npm test` and `npm run build`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run Backyard Left and the Doorbell at trunk and head. If trunk lacks the feature, record that and gate the new switches plus the end state the user waits for. Save `siren-lane-1.png`. Pass when trunk has no switch and the head has a switch only on those two.
- [ ] Lane 2. Turn the Backyard Left switch on. Save `siren-lane-2.png`. Pass when the log says V1 and the alarm is on.
- [ ] Lane 3. Turn the Backyard Left switch off. Save `siren-lane-3.png`. Pass when the log says V1 off.
- [ ] Lane 4. Turn the Doorbell switch on. Save `siren-lane-4.png`. Pass when the log says V20 and not V1.
- [ ] Lane 5. Turn the Doorbell switch off. Save `siren-lane-5.png`. Pass when the log says V20 off.
- [ ] Lane 6. Open Garage Door and Backyard. Save `siren-lane-6.png`. Pass when neither has a siren switch.
- [ ] Lane 7. Open Front L and Front R. Save `siren-lane-7.png`. Pass when neither has a siren switch.
- [ ] Lane 8. Open Backyard Right. Save `siren-lane-8.png`. Pass when it has no siren switch.
- [ ] Lane 9. Leave the Backyard Left switch on for one poll. Save `siren-lane-9.png`. Pass when the note says latch or follow, and a second alarm read agrees with the switch.
- [ ] Lane 10. Restart Argus. Save `siren-lane-10.png`. Pass when each switch matches the camera alarm state.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Whether a siren switch exists, on trunk and head. On the head, milliseconds from On to the alarm log line.
- [ ] Probe. Interleave trunk and head. Record the switch on both. Time the write only on the head.
- [ ] Baseline. Record the trunk absence first.
- [ ] Rule. Fail if any camera other than Backyard Left or the Doorbell shows a siren switch. Fail if the log line is missing at 2 seconds. The 2 second figure is a budget. Nobody has measured it on this branch. The reason matches the floodlight poll budget. The owner measures the real delay before merge.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 2 screenshot into chat with the operator. Do not commit the screenshot.
- [ ] Record a 30 to 60 second video of the Backyard Left siren on, then off. Save it as `siren-review.mp4`. Post the video in chat.
- [ ] Stop at merge-ready. Wait for the operator to accept the screenshot and the video.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends this PR to the stack. The operator lands it. The owner does not merge.
- [ ] Rollback. Set the siren flags false and restart. The switches disappear. Do not delete `.homekit`.

## Publish the doorbell, doorbell

**Depends on.** siren.

**Files.**

- [ ] Edit `src/homekit.ts`.
- [ ] Edit `src/serve.ts`.
- [ ] Create `tests/doorbell.test.ts`.
- [ ] Edit `tests/camera-features.test.ts` only to replace the IP-camera literal for a flagged Doorbell.
- [ ] Do not edit the firmware revision constant.

**Build.**

- [ ] Call the existing `categoryFor` from both `createCameraAccessory` and `accessory.publish`. The two sites must not keep separate copies.
- [ ] When the Doorbell ability and the doorbell flag are both true, category is 18 and the hap-nodejs value is `Categories.VIDEO_DOORBELL`. Otherwise category stays `Categories.IP_CAMERA`.
- [ ] Add `Service.Doorbell`. On a rising press from the BELL state, set `Characteristic.ProgrammableSwitchEvent` to a single press. A held press does not fire again.
- [ ] Keep `macFromName` as the HAP username. Do not delete `.homekit`. That is the no-repair path.
- [ ] Do not re-pair in this PR. If Home keeps the old category, stop and leave the decision in Appendix A.

**You see.**

- [ ] With the flag on, the Doorbell accessory advertises category 18 and shows a single ring when the button rises.
- [ ] The other six cameras stay IP cameras.
- [ ] With the flag off, the Doorbell stays an IP camera even though the ability says BELL.
- [ ] The firmware revision characteristic stays `1.3.16`. The Doorbell `c#` is greater than its trunk value when the service is added.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Mutant. Ability true and flag false. Expect category IP camera and no Doorbell service. Run `npx vitest run tests/doorbell.test.ts`.
- [ ] Mutant. Ability true and flag true. Expect category 18, and expect `accessory.category` to equal the publish category.
- [ ] Mutant. Bell state stays 1 across two polls. Expect one single-press event.
- [ ] Mutant. Bell state falls to 0 and rises to 1. Expect a second single-press event.
- [ ] Mutant. Front L record. Expect category IP camera.
- [ ] Run `npm test` and `npm run build`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the Doorbell tile at trunk and head. If trunk lacks the feature, record that and gate category 18 plus a ring, which is the end state the user waits for. Save `doorbell-lane-1.png`. Pass when trunk is an IP camera and the head Doorbell is category 18, and the other cameras stay IP cameras.
- [ ] Lane 2. No-repair check. Keep the username from `macFromName`. Do not delete `.homekit`. Do not remove the accessory. Save `doorbell-lane-2.png`. Pass when Home shows the doorbell UI and the pairing is the same accessory. If this fails, stop. Do not re-pair to make the lane pass.
- [ ] Lane 3. Press the button once. Save `doorbell-lane-3.png`. Pass when Home shows one ring and the log shows one single press.
- [ ] Lane 4. Hold the button across a poll. Save `doorbell-lane-4.png`. Pass when Home does not show a second ring.
- [ ] Lane 5. Release and press again. Save `doorbell-lane-5.png`. Pass when Home shows a second ring.
- [ ] Lane 6. Restart with the doorbell flag false. Save `doorbell-lane-6.png`. Pass when the category is IP camera and there is no ring service.
- [ ] Lane 7. Open Front L. Save `doorbell-lane-7.png`. Pass when Front L has no doorbell service.
- [ ] Lane 8. Open Backyard Left. Save `doorbell-lane-8.png`. Pass when Backyard Left has no doorbell service.
- [ ] Lane 9. Read firmware revision and `c#`. Save `doorbell-lane-9.png`. Pass when firmware is `1.3.16` and the Doorbell `c#` moved while the other cameras' categories did not.
- [ ] Lane 10. Open a live view on Garage Door. Save `doorbell-lane-10.png`. Pass when that camera still streams.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Category of the Doorbell on trunk and head. On the head, milliseconds from the rising BELL read to the HAP event.
- [ ] Probe. Interleave trunk and head. Record category on both. Time the press only on the head.
- [ ] Baseline. Record the trunk category IP camera first.
- [ ] Rule. Fail if any camera other than the Doorbell changes category. Fail if the HAP event is missing at 2 seconds. The 2 second figure is a budget. Nobody has measured it on this branch. Motion polling defaults to 1000 ms. A press that takes 2 seconds has missed the ring the user expects. The owner measures the real delay before merge.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 2 and lane 3 screenshots into chat with the operator. Do not commit the screenshots.
- [ ] Record a 30 to 60 second video of one press and the Home ring. Save it as `doorbell-review.mp4`. Post the video in chat.
- [ ] Stop at merge-ready. Wait for the operator to accept the screenshots and the video. Do not re-pair while you wait.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends this PR to the stack. The operator lands it. The owner does not merge.
- [ ] Rollback. Set the doorbell flag false and restart. Category returns to IP camera on the next publish. Do not delete `.homekit`. If a re-pair already happened, stop and tell the operator before any second re-pair.

## Publish doorbell talk, talk

**Depends on.** doorbell.

**Files.**

- [ ] Edit `src/homekit.ts`.
- [ ] Create `tests/talk.test.ts`.
- [ ] Do not edit the firmware revision constant.

**Build.**

- [ ] When the record says talk and the flag is true, accept HAP return audio and send it on the Doorbell talk path.
- [ ] The talk command name is not in Home Manager's summary. Stop this PR until that name is supplied. A talk permit flag is not that name.
- [ ] Backyard Left has a speaker and no confirmed talk. Do not open a talk path for it. The speaker stays the siren.
- [ ] Closing the HAP session closes the talk path. A second session opens a new one.

**You see.**

- [ ] During a Doorbell live view, sound from the phone is heard at the camera, or the log shows `talk_bytes` greater than 0 while the mic is open.
- [ ] No other camera grows a talk path.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Mutant. Doorbell talk true and flag true. Expect the return-audio handler. Run `npx vitest run tests/talk.test.ts`.
- [ ] Mutant. Backyard Left speaker true, permit flag true, talk ability false. Expect no return-audio handler.
- [ ] Mutant. Garage Door permit flag true. Expect no handler.
- [ ] Mutant. Session stop. Expect the talk path closed, then a later session can open it again.
- [ ] Run `npm test` and `npm run build`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a Doorbell live view at trunk and head. If trunk lacks the feature, record that and gate return audio plus the end state the user waits for, which is sound at the camera. Save `talk-lane-1.png`. Pass when trunk has no talk path and the head Doorbell does.
- [ ] Lane 2. Open Doorbell talk and speak. Save `talk-lane-2.png`. Pass when a person at the camera hears the phone, and the lane note says so.
- [ ] Lane 3. End the view. Save `talk-lane-3.png`. Pass when the log says the talk path closed.
- [ ] Lane 4. Open a second view and speak. Save `talk-lane-4.png`. Pass when the camera hears the phone again.
- [ ] Lane 5. Open Backyard Left. Save `talk-lane-5.png`. Pass when it has no talk path.
- [ ] Lane 6. Open Garage Door and Backyard. Save `talk-lane-6.png`. Pass when neither has a talk path.
- [ ] Lane 7. Open Front L. Save `talk-lane-7.png`. Pass when it has no talk path.
- [ ] Lane 8. Open Front R and Backyard Right. Save `talk-lane-8.png`. Pass when neither has a talk path.
- [ ] Lane 9. Show the permit-flag mutant log. Save `talk-lane-9.png`. Pass when the log shows talk false for Garage Door.
- [ ] Lane 10. Restart and open the Doorbell again. Save `talk-lane-10.png`. Pass when talk works and the siren switch still matches the alarm.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Whether a talk path exists, on trunk and head. On the head, milliseconds from mic open to the first `talk_bytes` line. The end state is audible sound at the camera.
- [ ] Probe. Interleave trunk and head. Record the path on both. Time the first byte only on the head.
- [ ] Baseline. Record the trunk absence first.
- [ ] Rule. Fail if any camera other than the Doorbell has a talk path. Fail if `talk_bytes` is missing at 2 seconds. The 2 second figure is a budget. Nobody has measured it on this branch. A person waiting on the porch hears nothing when the first byte is later than that. The owner measures the real delay and says whether the camera or the RTP session waited.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 2 screenshot into chat with the operator. Do not commit the screenshot.
- [ ] Record a 30 to 60 second video of a talk session. Save it as `talk-review.mp4`. Post the video in chat.
- [ ] Stop at merge-ready. Wait for the operator to accept the screenshot and the video.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends this PR to the stack. The operator lands it. The owner does not merge.
- [ ] Rollback. Set the talk flag false and restart. Return audio stops. Listen audio from the camera mic stays, because every camera in the matrix has a mic and this program does not remove it. Do not delete `.homekit`.

## Publish privacy and motion filters, home-mode

**Depends on.** talk.

**Files.**

- [ ] Edit `src/homekit.ts`.
- [ ] Edit `src/reolink.ts`.
- [ ] Create `tests/home-mode.test.ts`.
- [ ] Do not edit the firmware revision constant.

**Build.**

- [ ] When the privacy flag is true, wire `ManuallyDisabled` and `HomeKitCameraActive` on the existing `Service.CameraOperatingMode` if `CameraController` already added it. If the recorded service list has no such service, add one. Do not add a second copy.
- [ ] `ManuallyDisabled` true refuses a new live session and refuses snapshots. `HomeKitCameraActive` false does the same. One flag enables both. They cannot be configured apart.
- [ ] Change `getMotionState` so an AI type counts only when the ability lists it. Ignore GetAiCfg extras. Keep people, vehicle, and `dog_cat` as the only type names this client already reads.
- [ ] Do not enable NVR push. Do not add a second `MotionSensor`. The controller-managed sensor starts HKSV. A hand-added sensor leaves HKSV idle.

**You see.**

- [ ] With the privacy flag on, Home can turn that camera off and the live view stops.
- [ ] A `dog_cat` alarm on Garage Door does not set `MotionDetected`. The same alarm on the Doorbell does.
- [ ] On Front L, Front R, and Backyard Right, the log says `ai_skipped` when GetAiState fails, and motion then follows GetMdState only.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Mutant. Garage Door ability has no `dog_cat`, and the state has only that alarm. Expect motion false. Run `npx vitest run tests/home-mode.test.ts`.
- [ ] Mutant. Doorbell ability has `dog_cat`, and the state has that alarm. Expect motion true.
- [ ] Mutant. A GetAiCfg-only type that is absent from the ability. Expect motion false.
- [ ] Mutant. Privacy true. Expect the delegate to refuse a new session.
- [ ] Mutant. Privacy false. Expect the session path unchanged from trunk.
- [ ] Mutant. Startup requests include no push-enable command.
- [ ] Run `npm test` and `npm run build`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run Garage Door live at trunk and head. If trunk lacks the feature, record that and gate privacy off plus the stopped tile, which is the end state the user waits for. Save `home-mode-lane-1.png`. Pass when trunk has no new privacy behavior and the head stops the tile when privacy is on.
- [ ] Lane 2. Turn Garage Door privacy on. Save `home-mode-lane-2.png`. Pass when the live tile stops.
- [ ] Lane 3. Turn Garage Door privacy off. Save `home-mode-lane-3.png`. Pass when the live tile returns.
- [ ] Lane 4. Confirm the pairing still exists after privacy on. Save `home-mode-lane-4.png`. Pass when the accessory was not removed.
- [ ] Lane 5. Trigger a person alarm on the Doorbell. Save `home-mode-lane-5.png`. Pass when the log says motion DETECTED.
- [ ] Lane 6. Run the Garage Door `dog_cat`-only mutant. Save `home-mode-lane-6.png`. Pass when the log stays cleared.
- [ ] Lane 7. Watch one Front L poll. Save `home-mode-lane-7.png`. Pass when the log either shows a person alarm from GetAiState or says `ai_skipped` and then follows GetMdState. The note names which one happened.
- [ ] Lane 8. Watch one Front R poll. Save `home-mode-lane-8.png`. Pass when the note names the same GetAiState or `ai_skipped` outcome as the log.
- [ ] Lane 9. Watch one Backyard Right poll. Save `home-mode-lane-9.png`. Pass when the note names the outcome and the tile matches it. Push stays off.
- [ ] Lane 10. Restart with Garage Door privacy on. Save `home-mode-lane-10.png`. Pass when it stays private and the pairing remains.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from the privacy write to the refused session, on the head. Trunk has no privacy write, so record that absence. Also record that a motion poll still finishes.
- [ ] Probe. Interleave trunk and head. Time the privacy write on the head. Time one `pollOnce` on both.
- [ ] Baseline. Record the trunk absence of a privacy write first, and record the trunk poll duration.
- [ ] Rule. Fail if the refused-session log is missing at 2 seconds. The 2 second figure is a budget. Nobody has measured it on this branch. Fail if the head poll is slower than the trunk poll by 500 ms or more. The poll interval in code is 1000 ms. A 500 ms slowdown is half of a cycle and means the filter is doing extra work. The owner measures both numbers before merge. Keep the privacy-write budget separate from the poll comparison. Those are different pieces of work.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 2 screenshot into chat with the operator. Do not commit the screenshot.
- [ ] Record a 30 to 60 second video of privacy on, then off, on Garage Door. Save it as `home-mode-review.mp4`. Post the video in chat.
- [ ] Stop at merge-ready. Wait for the operator to accept the screenshot and the video.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends this PR to the stack. The operator lands it. The owner does not merge.
- [ ] Rollback. Set the privacy flags false and restart. Session refusal stops. The motion filter stays if the code stays, so a full code rollback reverts `getMotionState` too. Do not delete `.homekit`. Do not turn NVR push on as part of rollback.

## Publish night vision, night

**Depends on.** home-mode.

**Files.**

- [ ] Edit `src/homekit.ts`.
- [ ] Create `tests/night-vision.test.ts`.
- [ ] Do not edit the firmware revision constant.
- [ ] Do not spawn this PR until the IR off value and the IR write command are named. Until then, night vision stays in the Reolink app.

**Build.**

- [ ] When the record has an explicit off value and the nightVision flag is true, wire `Characteristic.NightVision` on the same `CameraOperatingMode` service home-mode used.
- [ ] True sends the camera's on or auto value from the ability record. False sends the named off value. Backyard Left's recorded IR mode is auto, so true must not force a color mode.
- [ ] If the off value is missing, register no setter. Do not publish a switch that snaps back.

**You see.**

- [ ] Home's night switch changes IR, and the log names the value sent.
- [ ] A camera with the flag false does not write IR.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Mutant. Fixture with off value and flag true. NightVision false expects the off literal. Run `npx vitest run tests/night-vision.test.ts`.
- [ ] Mutant. Fixture with no off value. Expect no setter.
- [ ] Mutant. Backyard Left true expects the auto value recorded for that camera.
- [ ] Mutant. Flag false. Expect no IR write when the characteristic would have changed.
- [ ] Run `npm test` and `npm run build`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the Doorbell night control at trunk and head. If trunk lacks the feature, record that and gate an IR change plus the end state the user waits for. Save `night-lane-1.png`. Pass when trunk writes no IR and the head writes IR only with the flag on.
- [ ] Lane 2. Turn Backyard Left night on. Save `night-lane-2.png`. Pass when the log shows the auto value.
- [ ] Lane 3. Turn Backyard Left night off. Save `night-lane-3.png`. Pass when the log shows the named off value.
- [ ] Lane 4. Turn the Doorbell night off, then on. Save `night-lane-4.png`. Pass when both log values match the record.
- [ ] Lane 5. Turn Front L night off, then on. Save `night-lane-5.png`. Pass when both log values match the record.
- [ ] Lane 6. Turn Garage Door night off, then on. Save `night-lane-6.png`. Pass when both log values match the record.
- [ ] Lane 7. Repeat for Backyard, Front R, and Backyard Right. Save `night-lane-7.png`. Pass when each log value matches that camera's record.
- [ ] Lane 8. Flag false on a scratch camera. Save `night-lane-8.png`. Pass when toggling Home does not write IR.
- [ ] Lane 9. Turn the Front L floodlight on after the night change. Save `night-lane-9.png`. Pass when the light still works.
- [ ] Lane 10. Restart. Save `night-lane-10.png`. Pass when NightVision matches the camera and firmware is still `1.3.16`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Whether an IR write exists, on trunk and head. On the head, milliseconds from NightVision false to the IR log line.
- [ ] Probe. Interleave trunk and head. Record the write on both. Time it only on the head.
- [ ] Baseline. Record the trunk absence first.
- [ ] Rule. Fail if the IR log line is missing at 2 seconds. The 2 second figure is a budget. Nobody has measured it on this branch. The reason matches the other write budgets. Fail if any write uses a value that was not in the named record. The owner measures the real delay before merge.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 3 screenshot into chat with the operator. Do not commit the screenshot.
- [ ] Record a 30 to 60 second video of night off, then on, on Backyard Left. Save it as `night-review.mp4`. Post the video in chat.
- [ ] Stop at merge-ready. Wait for the operator to accept the screenshot and the video.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends this PR to the stack. The operator lands it. The owner does not merge. If this PR was never spawned, the operator lands the stack through home-mode.
- [ ] Rollback. Set the nightVision flags false and restart. IR writes stop. The camera keeps whatever IR state it already had. Do not delete `.homekit`.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

No prototype branch exists. A hardware prototype would have to publish to the Mini or SSH to a camera. This plan forbids both until the operator says deploy. The ability questions are not open. Home Manager already ran read-only GetAbility, and Appendix E is that evidence.

These questions stay unproven. No run in this plan can settle them.

The no-repair path for category 18 is unproven. `progress/attempt-006.md` records a 2026-06-12 measurement. A `c#` bump did not flush the iPhone camera profile. Removing the accessory and pairing it again did. That note also says the Doorbell service wants one re-pair. It does not measure category 18. The default is to try the no-repair path and stop if Home keeps the old category. The operator can instead say to remove and re-pair only the Doorbell.

The floodlight write command name is unproven. The default is to keep floodlight unspawned until the name is supplied. The operator can send the command name Home Manager already saw.

The talk command name is unproven. The same default applies. A talk permit flag is not a substitute.

The IR off value and IR write command are unproven. The default is to leave night vision in the Reolink app. The operator can send the off value and the command name.

NVR `GetAiState` through the recorder is unproven. The client skips it after one failure. The default is to keep push off and to log `ai_skipped` when the read fails. The operator can ask for a later plan that turns push on. This plan does not turn push on.

Front L and Front R are not a guess. Home Manager names them as channels 2 and 3, in that order. `docs/camera-health.md` names Preview_03 and Preview_04 in that same order. `progress/attempt-002.md` names the D1200s as channels 2 and 3, and the D500 as channel 6. Backyard Right is that D500.

The recommended house opt-in, once the blocked names exist, is spotlight on Front L and Front R, siren on Backyard Left and the Doorbell, talk and doorbell on the Doorbell, and privacy on all seven. Night stays off until its values exist. The schema default remains false, so deploying the code changes nothing until the house file opts in. The operator can say to leave privacy off.

Ring light stays in the Reolink app. The operator can say to expose on or off as a Switch and accept that keep is dropped.

## Appendix B. Alternatives rejected

One PR for every new service was rejected. A bad doorbell category change would ship in the same diff as the floodlight.

Trusting GetWhiteLed or GetAudioAlarmV20 was rejected. Home Manager's evidence says both return defaults on unsupported models. GetAbility is the only detection source.

Treating the talk permit flag as talk support was rejected. Only the Doorbell has confirmed talk.

A config flag that picks V1 or V20 was rejected. The API version is part of the ability. A flag that could say V20 on the 812A is an illegal state.

Extra MotionSensor tiles for person, vehicle, and animal were rejected. `buildCameraControllerOptions` documents that a hand-added MotionSensor does not start HKSV. The hub labels the clip. Argus only sets `MotionDetected`.

Bumping the firmware revision to flush Home was rejected. The 2026-06-12 note measured that a firmware change did not flush the phone. `docs/invariants.md` also forbids a firmware-only bump.

Leaving the Doorbell at category 17 as the target was rejected. The operator asked for category 18. Category 17 remains the flag-off state and the rollback state.

A Switch for the ring light was rejected. The recorded modes are on, off, or keep. A Switch has no keep value.

A zoom or focus slider was rejected. HAP has no standard zoom or focus characteristic for this camera profile. No camera has PTZ, so there is no PTZ control to reuse.

Publishing NightVision before the off value exists was rejected. A switch that snaps back is worse than leaving IR in the Reolink app.

## Appendix C. Risks

The doorbell category change can force a remove and re-pair. It lands in doorbell. The owner watches lane 2 and does not delete `.homekit`.

`c#` moves when services appear or disappear. Home has ignored `c#` before, for the stream profile. Every service PR treats a matching log with a stale tile as a failure.

`GetAiState` can fail through the NVR. home-mode records that and does not turn push on. Until a person alarm is readable, Front L, Front R, and Backyard Right start HKSV only from GetMdState.

`Characteristic.SerialNumber` is built from the camera host and channel in `createCameraAccessory`. Tests use `camera.example`. No PR writes a house address or a serial into the repo.

floodlight, siren, doorbell, talk, home-mode, and night all edit `src/homekit.ts`. They are one chain so two owners do not write that file at once.

Apple Home has no control skill here. Live lanes are manual. That is a risk for every PR after capabilities.

The siren may clear itself. siren lane 9 records latch or follow. A switch left on while the camera is silent is a defect.

Brightness scale is unknown. floodlight lanes send 1 and 100 and stop on rejection.

Night write values are unknown. night does not spawn without them.

`tests/invariants.test.ts` rejects a new markdown file under `docs`. This plan lives at `plans/camera-controls.md` so that test stays green without a code edit.

## Appendix D. Links and reading list

Read these before editing.

`src/homekit.ts` `createCameraAccessory`, the firmware revision constant, and `buildCameraControllerOptions`.

`src/serve.ts` `macFromName`, `HAPStorage.setCustomStoragePath`, and `accessory.publish`.

`src/reolink.ts` `getMotionState`.

`src/motion.ts` `MotionMonitor`.

`src/config.ts` `cameraSchema`.

`docs/camera-health.md`, `docs/aspect-migration.md`, and `docs/invariants.md`.

`progress/attempt-002.md` for the D1200 and D500 channel note.

`progress/attempt-006.md` for the re-pair measurement. Do not copy pairing material out of that file.

Stream shape is already measured. Do not re-probe it. The old backyard restream host mix-up is Home Manager's separate fix. Do not record addresses.

doorbell and talk get `pstack/skills/how/SKILL.md` and `pstack/skills/interrogate/SKILL.md` before their owners call the design done. floodlight and siren get the how skill. The decision trail for each owner follows `pstack/skills/show-me-your-work/SKILL.md`.

## Appendix E. Ability matrix

Home Manager's read-only GetAbility pass is the source for every ability cell. The repo is the source for the model names noted below. No cell is waiting on a probe.

| Camera | Model | Channel | Spotlight | Siren | Talk | Button | IR | AI |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Backyard Left | RLC-812A | 0, standalone | no | V1 | no | no | auto | person, vehicle |
| Garage Door | RLC-520A | 0, standalone | no | no | no | no | yes | person, vehicle |
| Backyard | RLC-520A | 0, standalone | no | no | no | no | yes | person, vehicle |
| Doorbell | Video Doorbell PoE | 0, standalone | no | V20 | yes | yes, BELL | yes | person, vehicle, dog and cat |
| Front L | D1200 | 2, on the NVR | floodlight and brightness | no | no | no | yes | person, vehicle, dog and cat |
| Front R | D1200 | 3, on the NVR | floodlight and brightness | no | no | no | yes | person, vehicle, dog and cat |
| Backyard Right | D500 | 6, on the NVR | no | no | no | no | yes | person, vehicle |

| Camera | Mic | Speaker | Zoom | Focus | Ring light | Push |
| --- | --- | --- | --- | --- | --- | --- |
| Backyard Left | yes | yes | no | no | no | not reported |
| Garage Door | yes | no | no | no | no | not reported |
| Backyard | yes | no | no | no | no | not reported |
| Doorbell | yes | yes | no | no | on, off, or keep | not reported |
| Front L | yes | no | yes | yes | no | off |
| Front R | yes | no | yes | yes | no | off |
| Backyard Right | yes | no | yes | yes | no | off |

No camera has PTZ.

Backyard Left is the RLC-812A from Home Manager's evidence. The repo does not say that name binding in one line. Garage Door and Backyard are the RLC-520As from Home Manager's evidence. `docs/camera-health.md` already calls Backyard an RLC-520A. The Doorbell is the Video Doorbell PoE in both places. Front L and Front R are the D1200s by the channel chain in Appendix A. Backyard Right is the D500 on channel 6 in `docs/camera-health.md`.

Push is off on the three NVR channels. Argus does not use push today. The `MotionMonitor` default poll is 1000 ms. If GetAiState fails on those channels, person, vehicle, and animal alarms never become `MotionDetected`, and HKSV gets no trigger from them. GetMdState can still start a clip. The hub paints the person, vehicle, or animal badge on a clip that does start.

Standalone push was not in the evidence. The program does not read it and does not change it.

## Appendix F. HomeKit mapping and rollback

| Ability | HomeKit | Cameras | Else |
| --- | --- | --- | --- |
| Floodlight on, and brightness | Lightbulb On, and Brightness | Front L, Front R | Reolink app |
| Siren | Switch On | Backyard Left on V1, Doorbell on V20 | Reolink app |
| Talk | HAP return audio on the camera stream | Doorbell | Reolink app |
| Button | Category 18, Doorbell service, single press | Doorbell | not present |
| IR | NightVision boolean | all seven, after the off value is named | Reolink app until then |
| Privacy and camera active | CameraOperatingMode ManuallyDisabled and HomeKitCameraActive | all seven, flag default false | unchanged |
| Person, vehicle, animal | MotionDetected only | types the ability lists | hub labels the clip |
| Zoom and focus | none | Front L, Front R, Backyard Right | Reolink app |
| Ring light | none | Doorbell | Reolink app |
| PTZ | none | none | not present |
| Talk permit flag | none | not a capability | ignore |
| GetWhiteLed default | none | not a capability | ignore |
| GetAudioAlarmV20 default | none | not a capability | ignore |
| GetAiCfg extra | none | not a capability | ignore |

Detection command, already run by Home Manager, read-only. Do not run a write. Do not put the payload in the repo.

Send cmd GetAbility and action 0, with the same channel parameter `GetMdState` uses. Standalone cameras use channel 0. Front L uses channel 2. Front R uses channel 3. Backyard Right uses channel 6. Read spotlight, siren, talk, BELL, IR, and AI types from that payload only.

Siren writes, later, use V1 on Backyard Left and V20 on the Doorbell. The Set command is the pair of that Get API. Do not cross them.

Rollback of a flag is the same end state every time. Set that flag false, restart Argus, and leave `.homekit` in place. A second restart stays at the same tiles. A code revert is for when the flag is not enough. Never bump the firmware revision on the way back. Never delete pairings as a rollback. If the Doorbell was re-paired, ask the operator before pairing it again.
