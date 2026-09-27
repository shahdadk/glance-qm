# Native integration sources

Glance QM native app code is an independent implementation. Its Meta DAT API usage follows the official public SDK 1.0.0 interfaces and documentation:

- https://github.com/facebook/meta-wearables-dat-ios/tree/1.0.0
- https://github.com/facebook/meta-wearables-dat-ios/blob/main/samples/DisplayAccess/DisplayAccess/ViewModels/DisplayViewModel.swift
- https://github.com/facebook/meta-wearables-dat-ios/blob/main/plugins/mwdat-ios/skills/getting-started/SKILL.md
- https://github.com/facebook/meta-wearables-dat-ios/blob/main/plugins/mwdat-ios/skills/speech/SKILL.md
- https://github.com/facebook/meta-wearables-dat-ios/blob/main/plugins/mwdat-ios/skills/display-access/SKILL.md
- https://github.com/facebook/meta-wearables-dat-ios/blob/main/plugins/mwdat-ios/skills/session-lifecycle/SKILL.md
- https://github.com/facebook/meta-wearables-dat-ios/blob/main/plugins/mwdat-ios/skills/permissions-registration/SKILL.md

The SDK is distributed as binary Swift packages under the [Meta Wearables Developer Terms](https://wearables.developer.meta.com/terms), including its Acceptable Use Policy. It is not represented as MIT/Apache-licensed code. The local ignored `MetaWearablesDAT/` checkout is a reference copy pinned to `1f38beecba83c4c8b5e343540f9cd615323ab19a`; the app resolves the same exact 1.0.0 release through Swift Package Manager. No SDK binary is checked into this project.

No credentials, recordings, sessions, transcripts, source files, or provisioning assumptions were copied from the prior Glance application. The prior app was consulted only as a reference for available platform capabilities. Phone microphone capture is implemented using Apple's AVFoundation and Speech frameworks.
