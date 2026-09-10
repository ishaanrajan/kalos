# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Deployment

Kalos ships via EAS. It's a small, semi-private app (~32 user profiles, friend-group scale), but a production build is still a real, live deploy to real people's devices via TestFlight -- treat it with the same care as any other production deploy, not as a toy.

## Never run `eas build` or `eas submit` without asking first

Confirm the exact platform, profile, and whether to submit with the user immediately before running either command -- every time, even though the commands below are memorized. A prior session ran `eas build` + `eas submit` for iOS production on its own judgment and shipped a build carrying known bugs (a boot-time sign-out bug and an oversized upload default -- see the commit that fixed them for the postmortem) before the user could stop it. Don't repeat that: this doc tells you *how* to deploy, it is not standing authorization to *decide* to.

## Commands

- iOS production (TestFlight only): `eas build --profile production --platform ios`, then `eas submit --platform ios`.
- Android preview (sideloaded APK, not store-distributed): `eas build --profile preview --platform android` -- no submit step, there's no store to submit to.
- OTA JS-only update (no new/changed native deps): `eas update --branch <preview|production>`. Channel mapping is exactly what `eas.json` says: `preview` profile -> `preview` channel/branch, `production` profile -> `production` channel/branch.

## Config facts

- `eas.json`: `production` profile has `autoIncrement: true` and remote iOS credentials; `preview` profile builds an Android `apk` with `internal` distribution.
- `app.json`: `runtimeVersion.policy` is `"appVersion"` -- bumping the top-level `version` field is what forces a new runtime version. Bump it whenever a change adds or touches a native dependency; otherwise an `eas update` publish could serve JS built against the new native code to devices still running the old runtime. Run `eas update:list --branch <branch>` to see what's already been published to which runtime before assuming a bump can be skipped.
- Distribution: iOS is TestFlight-only (App Store Connect app id `6807053794`, Apple Team `C3AWB7CGFQ`, Individual). Android is a sideloaded preview APK, not on a store.
- Credentials are fully managed by EAS's remote credentials service -- there's nothing local (no keystores/certs/profiles) to manage or worry about.
