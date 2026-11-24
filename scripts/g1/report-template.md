# Gate G1 report

- Date: @@DATE@@
- Claude Code (`claude --version` in the image): @@CLAUDE_VERSION@@
- Pinned version (`images/base/claude-code-version`): @@PINNED_VERSION@@
- Image: @@IMAGE@@
- Image digest: @@IMAGE_ID@@
- Network: <fill in: where you ran it and on what connection>
- Host: @@HOST@@
- GitHub needed? @@FILE_URL@@
- Fixture SHAs: @@SHAS@@
- Work dir: @@WORKDIR@@
@@PROBE_NOTE@@
Post this file on #153. Any FAIL goes back to owner-i5 before the design adapts;
item 2 failing goes to Or (spec P6).

Statuses: PASS and FAIL are assertions the spec states; RECORDED is an
observation the design needs; MANUAL needs a human (instructions in the
details); NOT RUN means the item could not run (the reason is in the details).

## Summary

@@SUMMARY@@

## Fills

The RECORDED items fill these. Values the script derived are listed under
"Recorded values"; read the item's details for the rest.

- The env rule for Latest (item 7): when the update lands, with and without
  `FORCE_AUTOUPDATE_PLUGINS=1`. Fills §7.3 step 4.
- `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` (item 2): needed or not. Fills §7.3 step 4.
- `OFFICIAL_MARKETPLACES` pin rules (item 4 d and e). Fills §7.4.
- The `init.plugins` entry shape (item 1). Fills §7.3 step 8.
- The `plugin_not_loaded` copy (items 8 and 9): what Claude Code does and prints
  when a plugin can't load.
- The cold-start command wait (item 20 e): whether a cold start exceeds the
  harness's 5 s `initialize` wait.
- The floor (item 21).

### Recorded values

@@CONSTANTS@@

## Install and start timing (item 20)

RECORDED only, never PASS or FAIL. Fill in the network and host line.

@@TIMING@@

## Details

@@DETAILS@@
