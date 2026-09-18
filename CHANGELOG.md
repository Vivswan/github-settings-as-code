# Changelog

## [3.0.0](https://github.com/Vivswan/github-settings-as-code/compare/v2.0.0...v3.0.0) (2026-09-18)


### ⚠ BREAKING CHANGES

* **sections:** a GET or GraphQL body off GitHub's documented shape now fails the section with `returned a body outside the documented shape` naming the endpoint and field, where before it flowed into the comparison or a section's own message; a reading section without snapshot() no longer compiles; the teams and custom_properties owner probe runs ahead of their own validation.
* **sections:** teams, workflows, the environment listing and its pins, the protected-branch listing, the GraphQL protection rules, and the protection-rule Apps now fail plan and snapshot when GitHub holds two items under one identity, naming both; before, one was picked silently. The protection-rule Apps list is read at plan for an existing environment and after the PUT for one the run creates.
* **sections:** the teams, collaborators, and inherited interaction-limit snapshot notes read `<label>: left out of the snapshot - <reason>`; the interaction_limits.expiry and repository toggle notes use the cannot-verify template; a personal account under teams or custom_properties reads one note (docs/upgrading/v2-to-v3.md section 13).
* **library:** the merged file is the fold in the layers' key order, so a merged file committed under v2 reorders once. A top-level null on a section nothing below declares drops without a notice (pages and interaction_limits keep it), where v2 refused the merge.
* **flows:** `parseConfig(read, env, capabilities)` owns the `private-report: artifact` refusal (`input-artifact-unsupported`); `artifact-uploader-missing` and the flows' uploader check are gone. `executeRun` returns `RunEnd { exitCode, fatal? }` and `RunDeps` has no `describe`; `failRun(io, problem)` takes no wording hook. `validateSettingsDoc` and `validateSettings` take a `SectionSelection` where they took a `ReadonlySet<SectionKey>`. `parseSnapshotFileConfig(read, env, "settings-file")` reads the destination itself; `SettingsFileRole` gains `central-file`. The action and the command line print one wording per problem; remedies name the input and its flag and say "re-run" without "the workflow".
* **release:** the build branch gets nothing new and is deleted once every consumer has repinned; packaged commits live under build/<position>.<sha7> tags, the ten newest kept, so a sha pinned from one lives until ten newer commits are packaged. A rerun of an older release's retag-major leaves a newer release's major in place instead of failing; the verify subcommand is gone.
* **sections:** check mode no longer reads a secret family's sealing key (a malformed key fails the first PUT at apply); the environment secret and variable lines use the engines' wording (docs/upgrading/v2-to-v3.md sections 19-20).
* **settings:** an unknown underscore key at the document root fails validation naming `_layering` and `_undeclared`, where v2 dropped it as a private note; move notes into YAML comments. `teams` takes the `{_undeclared, entries}` wrapper (default `keep`): every run lists the repository's teams (repository Administration read) and notes undeclared direct grants, `_undeclared: delete` revokes them, and snapshots write the wrapper form. The retry-timing knob is read from `GSAC_RETRY_BASE_MS`; `RETRY_BASE_MS` is ignored.
* **sections:** two live items under one identity fail every list section, in plan and snapshot; the webhook snapshot placeholder is $SECRET_WEBHOOK_<id>; webhooks manage web hooks only and never write `name`; a ruleset without source_type is repository-owned, a repeated rule type a settings-file error; one wording per concept in drift lines and notes (docs/upgrading/v2-to-v3.md sections 11-15).
* **library:** the npm library's entry exports the 118 documented names; 88 of its v2 names leave it: 83 move to the `./internal` subpath with no semver promise and 5 are renamed below. `GithubApi`, `GithubApiOptions`, `GithubClient` are `GitHubApi`, `GitHubApiOptions`, `GitHubClient`; `MissingPermissionPolicy` is `OnMissingPermission`. `checkRepository` and `applyRepository` take `(client, repo, settings, options?)`; `RepoRunReport` is `CheckReport` and `ApplyReport`; `SnapshotLibraryOptions` is `SnapshotOptions`. `validateSettings` returns `{ settings, log }` and takes `sections` as a `SectionSelection`; `mergeSettings(layers, options?)` replaces the public `foldLayers`.
* **flows:** one redaction seal for every target kind ([#204](https://github.com/Vivswan/github-settings-as-code/issues/204))
* **flows:** one run outcome model for every mode ([#201](https://github.com/Vivswan/github-settings-as-code/issues/201))
* **upgrading:** two more v3 breaks. (1) A settings-file path may no longer contain a comma or a newline in any mode (they are the list separators mode: merge splits on); apply and check reject such a path with an input error naming the rule; rename the file. (2) defaults-file is no longer merged under every multi-repo target: it is applied whole to a target that has no settings file of its own (previously skipped), and a target's own file is applied as written; build layered documents with mode: merge and apply its output; run mode: check first, since with repos: "*" every discovered repository without a settings file now receives the defaults.
* the knobbed list wrapper's policy key is `_undeclared`; a settings file still writing `undeclared` fails validation with an error naming the new key.

### Features

* add mode: merge with a layered settings-file ([#104](https://github.com/Vivswan/github-settings-as-code/issues/104)) ([d50e70b](https://github.com/Vivswan/github-settings-as-code/commit/d50e70bd51ddf620d023c8c9daf8f94dc269b4b3))
* add the plan-returning section contract and migrate the workflows section ([8a65765](https://github.com/Vivswan/github-settings-as-code/commit/8a65765e276540e75aae83992b3383ea8e4002ef))
* **ci:** gate kept backward-compatibility code behind COMPAT markers ([#173](https://github.com/Vivswan/github-settings-as-code/issues/173)) ([bf9f482](https://github.com/Vivswan/github-settings-as-code/commit/bf9f482a7ce55911918d81208cf7c88922e67220))
* **cli:** github-settings-as-code and gsac commands over the library ([#152](https://github.com/Vivswan/github-settings-as-code/issues/152)) ([364a9c6](https://github.com/Vivswan/github-settings-as-code/commit/364a9c62988a60a6e6af0e434c364aed37be41bc))
* **cli:** gsac init writes the live settings to .github/settings.yml and prints its PAT grant ([#178](https://github.com/Vivswan/github-settings-as-code/issues/178)) ([3fad2b2](https://github.com/Vivswan/github-settings-as-code/commit/3fad2b25706a3d4fc82a1012c2068053bff8c243))
* **cli:** under GitHub Actions the CLI emits the action's workflow commands ([#223](https://github.com/Vivswan/github-settings-as-code/issues/223)) ([de75a22](https://github.com/Vivswan/github-settings-as-code/commit/de75a22ac3bff374c509523391c5be3c6cd3e006))
* **contract:** extend the plan contract for every migrating section ([9ae375c](https://github.com/Vivswan/github-settings-as-code/commit/9ae375cc6027d9d7eac970eb808d14a588bac80f))
* derive list sections from a declarative factory, piloted on labels ([71859b5](https://github.com/Vivswan/github-settings-as-code/commit/71859b571bc4c334d4e6796b5424b27f361fb8df))
* generate action.yml, the inputs table, and the policy and permissions references from declarations ([d062cf1](https://github.com/Vivswan/github-settings-as-code/commit/d062cf1b6bd4f2767986477c383f2bed1a201341))
* generate COVERAGE.md from section declarations ([51068cd](https://github.com/Vivswan/github-settings-as-code/commit/51068cdd765667b1190cb99625cd7ab6f656df7f))
* generate the README sections table, outputs, and PAT form from section declarations ([83f3c84](https://github.com/Vivswan/github-settings-as-code/commit/83f3c84ede257c66e2d5ca0cb46f9b3ebfee20e3))
* **library:** export the section contexts so a consumer can call a section module directly ([#191](https://github.com/Vivswan/github-settings-as-code/issues/191)) ([ed6143a](https://github.com/Vivswan/github-settings-as-code/commit/ed6143ab0772866a4eb6d74526b759a294759d92))
* **library:** package @vivswan/github-settings-as-code ([#142](https://github.com/Vivswan/github-settings-as-code/issues/142)) ([cbeb56f](https://github.com/Vivswan/github-settings-as-code/commit/cbeb56f7406e201a1363d3b8023f509fe00aa1c9))
* publish packaged commits on a build branch, with latest and the version tags on it ([#122](https://github.com/Vivswan/github-settings-as-code/issues/122)) ([db45c7d](https://github.com/Vivswan/github-settings-as-code/commit/db45c7d9f297b68a10a39c8f24a4d65a5fffe99b))
* **release:** carry the library build on the packaged branch and publish to npm ([#150](https://github.com/Vivswan/github-settings-as-code/issues/150)) ([8eb5897](https://github.com/Vivswan/github-settings-as-code/commit/8eb589726fd142f811b74717229ae1925a68a525))
* **render:** the snapshot and the merged file render one canonical order, and the snapshot carries no timestamp ([#237](https://github.com/Vivswan/github-settings-as-code/issues/237)) ([9d16e15](https://github.com/Vivswan/github-settings-as-code/commit/9d16e15352064f52c8f38c3aa93aa6cec9d23e52))
* **report:** a delivered report issue is announced in the log ([#235](https://github.com/Vivswan/github-settings-as-code/issues/235)) ([7e85572](https://github.com/Vivswan/github-settings-as-code/commit/7e8557291ea08607924bb7fdc5e7f2f665703af4))
* **snapshot:** branches and environments read back ([#147](https://github.com/Vivswan/github-settings-as-code/issues/147)) ([5f03322](https://github.com/Vivswan/github-settings-as-code/commit/5f03322b08e2da054445692f48d7650364fb675b))
* **snapshot:** collaborators and teams read back ([#148](https://github.com/Vivswan/github-settings-as-code/issues/148)) ([3b4f753](https://github.com/Vivswan/github-settings-as-code/commit/3b4f75392db21a7eb1a87532decf2bd0c34cd1f9))
* **snapshot:** mode snapshot writes live settings to a file or a per-repo directory ([#146](https://github.com/Vivswan/github-settings-as-code/issues/146)) ([9233a14](https://github.com/Vivswan/github-settings-as-code/commit/9233a14949815e14c50936fa697200fc46938f00))
* **snapshot:** read back the GraphQL-only branch rules and environment pins ([#185](https://github.com/Vivswan/github-settings-as-code/issues/185)) ([63435fc](https://github.com/Vivswan/github-settings-as-code/commit/63435fcaa35ef601d3719282385a0a6f39927387))
* **snapshot:** repository, actions, and rulesets read back ([#143](https://github.com/Vivswan/github-settings-as-code/issues/143)) ([3d256b8](https://github.com/Vivswan/github-settings-as-code/commit/3d256b83c1231c5f5897c1dd35d735080a169951))
* **snapshot:** section snapshot contract, engine, round-trip harness, and the first sections ([#140](https://github.com/Vivswan/github-settings-as-code/issues/140)) ([f721bb1](https://github.com/Vivswan/github-settings-as-code/commit/f721bb19f35e6dfdda1159eed4c975b4a125425f))


### Bug Fixes

* **action:** the YAML parser never prints a settings file's source lines as warnings ([#123](https://github.com/Vivswan/github-settings-as-code/issues/123)) ([54a50a0](https://github.com/Vivswan/github-settings-as-code/commit/54a50a074dfbd6ccee945f1b476e3f9f9fc06699))
* adopt zod 4.5's native root $ref emission and own-__proto__ rejection ([#67](https://github.com/Vivswan/github-settings-as-code/issues/67)) ([44dab3b](https://github.com/Vivswan/github-settings-as-code/commit/44dab3bccf1e5fca5546d48dda45756c1d7ae084))
* apply review fixes to the docs and tooling sweep ([73b6b4a](https://github.com/Vivswan/github-settings-as-code/commit/73b6b4a4f2cbc2f0f3263fee3478ea0eb2b6eab8))
* apply review fixes to the harness audit batch ([ceb9f46](https://github.com/Vivswan/github-settings-as-code/commit/ceb9f463d7e7bd24acf4bcb770eb6bee63a9219a))
* apply review fixes to the src-side audit batch ([b9de617](https://github.com/Vivswan/github-settings-as-code/commit/b9de617bdd0e9cb2444f2b544f8c5c3ae8c754bb))
* attest build provenance and attach the sigstore bundle to releases ([b5db672](https://github.com/Vivswan/github-settings-as-code/commit/b5db67242eabf3b2c380ba672bcd022c476ddfdf))
* **branches:** a denied branch probe no longer reads as a missing branch ([#149](https://github.com/Vivswan/github-settings-as-code/issues/149)) ([c1d6243](https://github.com/Vivswan/github-settings-as-code/commit/c1d62434c124cb8b49bf482884a9966b4498d43e))
* **branches:** seal GraphQL node-id lookups at execution so check mode never issues them ([#75](https://github.com/Vivswan/github-settings-as-code/issues/75)) ([feaf279](https://github.com/Vivswan/github-settings-as-code/commit/feaf279a69df4c125f33827ed5b300c18b657a4e)), closes [#73](https://github.com/Vivswan/github-settings-as-code/issues/73)
* centralize the token-leak sweep in the runner ([7dcc225](https://github.com/Vivswan/github-settings-as-code/commit/7dcc2256e80f56248284b77b7ef1c17decd3c5c2))
* **ci:** name the fuzz-issue inputs the action no longer defaults ([#186](https://github.com/Vivswan/github-settings-as-code/issues/186)) ([fded5f5](https://github.com/Vivswan/github-settings-as-code/commit/fded5f527679e8028a8eeb5dd77af39aa51c012d))
* classify rate limits structurally on every path ([65f97a2](https://github.com/Vivswan/github-settings-as-code/commit/65f97a2a86e85d60492889a85f28273996d48fd7))
* **cli:** each command's help names only the flags it accepts ([#182](https://github.com/Vivswan/github-settings-as-code/issues/182)) ([51a75e7](https://github.com/Vivswan/github-settings-as-code/commit/51a75e79d4df92282b4339f3571ec7f7107a3ac4))
* **contract:** classify definitive 404 rejections ahead of the permission branch ([#164](https://github.com/Vivswan/github-settings-as-code/issues/164)) ([8be6b7d](https://github.com/Vivswan/github-settings-as-code/commit/8be6b7d901e840e3088066699723e83e9f5ea8ec))
* **contract:** the plainData refusal names what JSON does with each bad item; the grant comment points at the generated docs; the validate truncation arms get their relation ([#231](https://github.com/Vivswan/github-settings-as-code/issues/231)) ([0118807](https://github.com/Vivswan/github-settings-as-code/commit/0118807afdb1fcef33d0b5b5d3b73d861c1a917e))
* correct mock identity minting and the pages resurrect bug ([9152a91](https://github.com/Vivswan/github-settings-as-code/commit/9152a91b6f1ef2dd8b5ef94223abb9d5dc72a663))
* cover every faultable section in the fuzz fault battery ([e41aa99](https://github.com/Vivswan/github-settings-as-code/commit/e41aa9916c9673941b40365347c77692352a16e1))
* derive owner-kind sensitivity from the section declaration ([0181f01](https://github.com/Vivswan/github-settings-as-code/commit/0181f01a752eb9675f48663d21e9ce70ef497b31))
* **dev:** a fresh checkout runs bun run check green; the trimmed OpenAPI file regenerates when absent ([#219](https://github.com/Vivswan/github-settings-as-code/issues/219)) ([7468741](https://github.com/Vivswan/github-settings-as-code/commit/746874159452dcece59b25187070b534643a9ac8))
* discover schema-corpus scenarios across all scenario roots ([d34d031](https://github.com/Vivswan/github-settings-as-code/commit/d34d0316af107fccf5c910352eae608dff39e91c))
* **e2e:** oracle never predicts a preflight abort for teams on a personal account ([#114](https://github.com/Vivswan/github-settings-as-code/issues/114)) ([152c7d9](https://github.com/Vivswan/github-settings-as-code/commit/152c7d98e9de002a9ffad32e06ed6a1bfaa17733))
* **e2e:** path param accessors read own keys only ([#158](https://github.com/Vivswan/github-settings-as-code/issues/158)) ([89c8ee8](https://github.com/Vivswan/github-settings-as-code/commit/89c8ee811d661baab9a4610ae7fc1f777276bd18))
* **engine:** withhold a secret-carrying request's failure for any client ([#175](https://github.com/Vivswan/github-settings-as-code/issues/175)) ([14a5c72](https://github.com/Vivswan/github-settings-as-code/commit/14a5c72fe150a97d947d00a54b97467c2e5ab025))
* every count in a user-facing message takes the singular or the plural, never "(s)" ([#236](https://github.com/Vivswan/github-settings-as-code/issues/236)) ([5523d38](https://github.com/Vivswan/github-settings-as-code/commit/5523d38f714a27b293379596f8309a5e73305cd5))
* **flows:** the fleet summary says one repository; a duplicate private target is deduped under its redacted name ([#233](https://github.com/Vivswan/github-settings-as-code/issues/233)) ([d23fea1](https://github.com/Vivswan/github-settings-as-code/commit/d23fea17fb7ce70988ee530a02f3f82a404a6c8f))
* **github:** keep the throttling plugin on under the test knob via an injected scheduler ([#161](https://github.com/Vivswan/github-settings-as-code/issues/161)) ([dbdcd7b](https://github.com/Vivswan/github-settings-as-code/commit/dbdcd7b265619c13d4d6f900f65eba716280dac5))
* **github:** pace every throttling group by the client's own scheduler ([#165](https://github.com/Vivswan/github-settings-as-code/issues/165)) ([d70d315](https://github.com/Vivswan/github-settings-as-code/commit/d70d31578167c1004c3820d5d184d4c7f4ae74c8))
* **github:** refuse a cyclic payload at its field instead of exhausting the stack ([#171](https://github.com/Vivswan/github-settings-as-code/issues/171)) ([9dc8e42](https://github.com/Vivswan/github-settings-as-code/commit/9dc8e429514aebfccc9519aecfaa2cbc4223e954))
* hand sections the parsed settings document instead of the raw one ([1ddc2f3](https://github.com/Vivswan/github-settings-as-code/commit/1ddc2f3ed9cf567e5bd5bb67d658d6ae28f3902a))
* harden release boundary checks and decouple the schema id from the release manifest ([f5c4c59](https://github.com/Vivswan/github-settings-as-code/commit/f5c4c59896053ed9ef5eecd44e550887dfe33959))
* harden the CI tooling ([6fb2603](https://github.com/Vivswan/github-settings-as-code/commit/6fb2603a57cfa6ed2d6fc98041fbb60dd2d18f7a))
* **io:** collectingIo masks captured text with the shared redactor ([#163](https://github.com/Vivswan/github-settings-as-code/issues/163)) ([a0faf1c](https://github.com/Vivswan/github-settings-as-code/commit/a0faf1cd2f4a427973478a33385572296767072a))
* keep spec-pinned gaps out of automatic graduation ([ae278c9](https://github.com/Vivswan/github-settings-as-code/commit/ae278c9f3770a8580727db917124a0cea32e164b))
* **library:** gate findings on the packaging PR ([#156](https://github.com/Vivswan/github-settings-as-code/issues/156)) ([e4e8b4c](https://github.com/Vivswan/github-settings-as-code/commit/e4e8b4c1f7717100a5a96348fe0e2174ae6d5e0e))
* **library:** mergeSettings renders the fold the action writes; a null over nothing drops ([e725c08](https://github.com/Vivswan/github-settings-as-code/commit/e725c08621d92414afd124a1523fa8cf4f05750b))
* **nightly:** file the curated e2e issue through the fleet action ([#160](https://github.com/Vivswan/github-settings-as-code/issues/160)) ([8ef9747](https://github.com/Vivswan/github-settings-as-code/commit/8ef974791d61264e69dcae81be481a645fb5a420))
* **nightly:** replay a fuzz artifact with the command its run wrote ([#157](https://github.com/Vivswan/github-settings-as-code/issues/157)) ([339e002](https://github.com/Vivswan/github-settings-as-code/commit/339e002d13cdcf4054d185bf44661695ccf7877e))
* parse live bodies through parseLive in the seven asserting sections ([56ca3e4](https://github.com/Vivswan/github-settings-as-code/commit/56ca3e41dc90981580c4d45057594ad8f4b74369))
* pass zod's schema layout through instead of guarding it ([#68](https://github.com/Vivswan/github-settings-as-code/issues/68)) ([64aad27](https://github.com/Vivswan/github-settings-as-code/commit/64aad276b2182d4a39175d15fe5e4e7b530345d0))
* reject required-sections entries excluded by the sections allowlist ([c1fc169](https://github.com/Vivswan/github-settings-as-code/commit/c1fc1699adc8027919464bea8eceb65b53fc81f2))
* **release:** follow the attestation bundle rename in the repo-owned asset check and SECURITY.md ([#76](https://github.com/Vivswan/github-settings-as-code/issues/76)) ([3704176](https://github.com/Vivswan/github-settings-as-code/commit/3704176cc0709d1c19a70765c925f033f4266ccd))
* **release:** keep next from moving back on a publish the registry has not yet shown ([#190](https://github.com/Vivswan/github-settings-as-code/issues/190)) ([c247bab](https://github.com/Vivswan/github-settings-as-code/commit/c247babde06fc16d8b1a0fb3e0ee4d3de44439cd))
* **release:** order pre-release versions by main's commit count, not the run number ([#197](https://github.com/Vivswan/github-settings-as-code/issues/197)) ([131780e](https://github.com/Vivswan/github-settings-as-code/commit/131780e1d385820500eda378f81c79da2335d72e))
* **release:** read the major line in one advertisement and publish latest from the whole chain ([#172](https://github.com/Vivswan/github-settings-as-code/issues/172)) ([1312f3f](https://github.com/Vivswan/github-settings-as-code/commit/1312f3f04db9bde25256229f5409033c08958560))
* **release:** refuse a build tip whose Source trailer is not a full sha and fix the post-green coalescing note ([#176](https://github.com/Vivswan/github-settings-as-code/issues/176)) ([ee6c725](https://github.com/Vivswan/github-settings-as-code/commit/ee6c725a9b12beeddfe936dd29f51a25fc89a1f5))
* **report:** match report issues by their own body, open over closed, newest first ([#170](https://github.com/Vivswan/github-settings-as-code/issues/170)) ([8d5c1a8](https://github.com/Vivswan/github-settings-as-code/commit/8d5c1a88340e4227f7894e11f9059023c10031e3))
* **report:** paginate the report-issue lookups and scan by title, not creator ([#159](https://github.com/Vivswan/github-settings-as-code/issues/159)) ([631e1da](https://github.com/Vivswan/github-settings-as-code/commit/631e1da622e16f75c8c95caf3a2f7b8614c6d4a0))
* **rulesets:** bypass_actors hidden from a non-admin token is not drift ([#137](https://github.com/Vivswan/github-settings-as-code/issues/137)) ([b8df084](https://github.com/Vivswan/github-settings-as-code/commit/b8df084cb0af6bc15e6d7cf9afe68a6e3f68226e))
* **scripts:** the permission count in the generated docs takes the helper; the npm-confirm line is pinned with an injectable pause ([#239](https://github.com/Vivswan/github-settings-as-code/issues/239)) ([e6897d8](https://github.com/Vivswan/github-settings-as-code/commit/e6897d81d3306fe4447c9e5b0c003bff2c3e8d0d))
* **sections:** make the impossible literal-with-routed-keys branch entry unrepresentable and declare the sealing-key read's phase ([#195](https://github.com/Vivswan/github-settings-as-code/issues/195)) ([95d081d](https://github.com/Vivswan/github-settings-as-code/commit/95d081d8d20d16661ef3caf0475e801b4d9ce5a5))
* **sections:** require the deploy key read_only flag, carry the label brands through the list section, deep-freeze the registries ([#187](https://github.com/Vivswan/github-settings-as-code/issues/187)) ([15ef0c9](https://github.com/Vivswan/github-settings-as-code/commit/15ef0c95905d21b541a19bfcc058fc4d6b88229a))
* **settings:** unknown underscore keys fail everywhere; teams gets the _undeclared knob; GSAC_RETRY_BASE_MS ([05e6d41](https://github.com/Vivswan/github-settings-as-code/commit/05e6d410541988f63d92f74d5e00e47947bffe66))
* single-tag releases - version tags live only on packaged commits ([08d5585](https://github.com/Vivswan/github-settings-as-code/commit/08d5585b974e529898cf2121bfea220317c914c8))
* size the harness kill cap for the directed fuzz battery ([8543af8](https://github.com/Vivswan/github-settings-as-code/commit/8543af85d8178f736598e6565839df1c57b8334c))
* **snapshot:** a denied sub-read fails the section under on-missing-permission: fail ([#184](https://github.com/Vivswan/github-settings-as-code/issues/184)) ([04d8d35](https://github.com/Vivswan/github-settings-as-code/commit/04d8d356942f4435cd2962381bbb348f7daf989c))
* **snapshot:** refuse a destination the filesystem carries onto an authored file ([#179](https://github.com/Vivswan/github-settings-as-code/issues/179)) ([5b24963](https://github.com/Vivswan/github-settings-as-code/commit/5b249639e7e11c073197eae3fa8af6ecc1848539))
* strengthen the remaining per-section representations ([3fc0f85](https://github.com/Vivswan/github-settings-as-code/commit/3fc0f853f914d032e0bf5f746aee48357d062a03))
* **test:** match private-report heading markers without an HTML-comment regex ([#106](https://github.com/Vivswan/github-settings-as-code/issues/106)) ([33ff405](https://github.com/Vivswan/github-settings-as-code/commit/33ff40576b478606dce525da0ee0aa5bd64fd290))


### Documentation

* **upgrading:** link the v3 breaks to their guides ([8541b3d](https://github.com/Vivswan/github-settings-as-code/commit/8541b3d1c40c6e31a5f682d5c034495a76adbba2))


### Miscellaneous Chores

* drop the release-as pin and the machinery that retired it ([a2cc999](https://github.com/Vivswan/github-settings-as-code/commit/a2cc999d1936b9e72e7762778f3ac2ba58091ecc))


### Code Refactoring

* **flows:** one owner per refusal, read, and write; one wording for both faces ([bd9b6dd](https://github.com/Vivswan/github-settings-as-code/commit/bd9b6dd3f92e9280a436279f6eccbfad541977ac))
* **flows:** one redaction seal for every target kind ([#204](https://github.com/Vivswan/github-settings-as-code/issues/204)) ([f1f938e](https://github.com/Vivswan/github-settings-as-code/commit/f1f938e48147d6dcf5c4255486a32c9b86a811ba))
* **flows:** one run outcome model for every mode ([#201](https://github.com/Vivswan/github-settings-as-code/issues/201)) ([033a9c6](https://github.com/Vivswan/github-settings-as-code/commit/033a9c6ea5ce54993a9b0fbc22a0f4b4b4868606))
* **library:** a documented public entry and an internal one; one naming family per layer ([d92b738](https://github.com/Vivswan/github-settings-as-code/commit/d92b738c9c32564e14d1e85ae3f48249454e8380))
* **release:** one immutable packaged commit per main sha; latest and vN move only forward; the build chain retires ([eac7de6](https://github.com/Vivswan/github-settings-as-code/commit/eac7de6a6d2bbe94562da4d514cc679654bed9cc))
* **sections:** environments plan through the secrets and variables engines; the sealing key is read at apply ([5dfc10a](https://github.com/Vivswan/github-settings-as-code/commit/5dfc10a39fbef174914c7e7df3322f67b1ecf06a))
* **sections:** milestones, webhooks, and rulesets join listSection; duplicate live items fail loudly everywhere ([2cb5c8a](https://github.com/Vivswan/github-settings-as-code/commit/2cb5c8acd665c096cc01a689f6d8cbaabb85ba7a))
* **sections:** one duplicate-live guard and identity rendering over every live list ([f7c72ff](https://github.com/Vivswan/github-settings-as-code/commit/f7c72ffac8d47497036149841a338c8d4e88badc))
* **sections:** one helper per repeated concept; the snapshot notes teams and collaborators leave out use the shared template ([aa1f86f](https://github.com/Vivswan/github-settings-as-code/commit/aa1f86fb74163c35ccde81634a025106b066e7d0))
* **sections:** the read port parses every live body, and the registry owns the owner probe ([cb772c5](https://github.com/Vivswan/github-settings-as-code/commit/cb772c57cb9890d18577db528ca48887d5714697))

## [2.0.0](https://github.com/Vivswan/github-settings-as-code/compare/v1.0.1...v2.0.0) (2026-08-11)


### ⚠ BREAKING CHANGES

* the action moved to Vivswan/github-settings-as-code; uses: references to Vivswan/repo-settings-as-code fail with "repository not found" and must be updated.
* branches[].protection.required_signatures now acts. Previously the key rode the protection PUT, where GitHub dropped it (check mode showed permanent drift). A settings file already carrying it will start toggling the signed-commit requirement on the first apply after upgrading - a stale required_signatures: false would REMOVE a hand-enabled requirement. Audit existing declarations for intent before moving to v2. The v1 line keeps the old inert behavior.
* actions.fork_pr_contributor_approval and actions.fork_pr_workflows_private_repos now act. Previously both keys fell through to the base permissions PUT, where GitHub ignored them and a notice said so. A settings file already carrying either key will start applying these policies on the first apply after upgrading; audit existing declarations for intent before moving to v2. The v1 line keeps the old inert behavior.
* actions.oidc_customization_sub now acts. Previously the key fell through to the base permissions PUT, where GitHub ignored it and a notice said so. A settings file already carrying the key will start customizing the OIDC subject claim template on the first apply after upgrading; audit existing declarations for intent before moving to v2. The v1 line keeps the old inert behavior.

### Features

* add issue-on-failure private-report channel (quiet on healthy runs) ([934a321](https://github.com/Vivswan/github-settings-as-code/commit/934a321d64d49470ced76b484f6f714fc2a2bbe4))
* enrich API rejection errors and reject unknown keys in closed sections ([7a44e90](https://github.com/Vivswan/github-settings-as-code/commit/7a44e90bc15016d7926b812000f22043d1f3058f))
* first-class GraphQL operation layer ([7d5279f](https://github.com/Vivswan/github-settings-as-code/commit/7d5279fcdae87c0985c9a6ecb637c89dcd38e2f7))
* let settings.yml choose the undeclared-resource policy per section ([372b884](https://github.com/Vivswan/github-settings-as-code/commit/372b8844f1274cdfac71d04b5c526d6d6714da8f))
* manage Actions artifact/log retention and cache limits ([8014910](https://github.com/Vivswan/github-settings-as-code/commit/8014910b884aece9cc71f974cef26db4656da74f))
* manage code quality setup and check suite preferences ([adab49e](https://github.com/Vivswan/github-settings-as-code/commit/adab49e76316dfab7122b30c114d7bde1f69b1ba))
* manage Copilot agents secrets and variables ([1d839e1](https://github.com/Vivswan/github-settings-as-code/commit/1d839e1797f622da2cb01331a8ec395cd56dcf0b))
* manage deploy keys ([a6f7ae1](https://github.com/Vivswan/github-settings-as-code/commit/a6f7ae1251177cd07c1ce6d0acc3176e3986f9b0))
* manage environment custom deployment protection rules ([f752ce8](https://github.com/Vivswan/github-settings-as-code/commit/f752ce8626e98689902e4f83463816fe25636139))
* manage environment deployment branch-policy patterns ([34eafe4](https://github.com/Vivswan/github-settings-as-code/commit/34eafe4e46dd12f6b17dfdf4987b7898270d1718))
* manage environment variables in the environments section ([1d272c3](https://github.com/Vivswan/github-settings-as-code/commit/1d272c355ed1b933080d1234b3925625ec1e1edb))
* manage environment, Dependabot, and Codespaces secrets ([c8bbe75](https://github.com/Vivswan/github-settings-as-code/commit/c8bbe75a91fadbfe241e152ab3fdcf3d52120309))
* manage fork pull request workflow policies from the actions section ([cd2bfcf](https://github.com/Vivswan/github-settings-as-code/commit/cd2bfcfb332cd789cb4d8d55a7ca40daefcdfec8))
* manage Git LFS enablement from the repository section ([a0195fa](https://github.com/Vivswan/github-settings-as-code/commit/a0195faf6bc2a8df6e68437a38c35c6d419020bc))
* manage immutable releases from the repository section ([f2582f7](https://github.com/Vivswan/github-settings-as-code/commit/f2582f7b8d66d5d7db79fad6b2b0f70788baa590))
* manage pinned environments ([c368c98](https://github.com/Vivswan/github-settings-as-code/commit/c368c98a52ee5d0a35028e2501423316b5c65023))
* manage repository Actions secrets ([0f8ea4e](https://github.com/Vivswan/github-settings-as-code/commit/0f8ea4e0ba0ffc23802bfd608fc979b40045eaf2))
* manage repository Actions variables ([780abf0](https://github.com/Vivswan/github-settings-as-code/commit/780abf0ec19c50279cc2454606492101bfbdebf7))
* manage repository custom property values ([b5bf3ac](https://github.com/Vivswan/github-settings-as-code/commit/b5bf3ac547b0ad84ae19427cf2da06b35b3911fb))
* manage repository interaction limits ([c8dd58d](https://github.com/Vivswan/github-settings-as-code/commit/c8dd58d04de93da9f76168f985654e5d54646065))
* manage repository secret scanning custom patterns ([05f614c](https://github.com/Vivswan/github-settings-as-code/commit/05f614c0a894e2a9599e81f03c7de593164ad9eb))
* manage repository webhooks ([85013d3](https://github.com/Vivswan/github-settings-as-code/commit/85013d3d6437bd78357dd37547c1426c80fb449b))
* manage required commit signatures in the branches section ([16bec9a](https://github.com/Vivswan/github-settings-as-code/commit/16bec9a328879af3a522e67fb80c86e50c4e6460))
* manage the Actions OIDC subject claim from the actions section ([c4e712f](https://github.com/Vivswan/github-settings-as-code/commit/c4e712fd4b929ba6553f2e54c3f1b53b6fd7971b))
* manage the pull request creation cap and bypass list ([e98fb3a](https://github.com/Vivswan/github-settings-as-code/commit/e98fb3ad58b2f8b78d759480cf096a483678a741))
* manage the sponsor button and issue creation policy ([97111fb](https://github.com/Vivswan/github-settings-as-code/commit/97111fb2fa66779f099e6daf3c0ac5c5b44b189f))
* manage wildcard branch protection, force-push bypassers, and required deployments ([085ac52](https://github.com/Vivswan/github-settings-as-code/commit/085ac52683eaacbda1d974cf19f5a6e38f774b71))
* move repo-owned CI and release logic to template extension points ([#12](https://github.com/Vivswan/github-settings-as-code/issues/12)) ([cdde9cc](https://github.com/Vivswan/github-settings-as-code/commit/cdde9ccbf867af6d257ce26f5eac8180930b4ca9))
* reconcile pending collaborator invitations ([cb92188](https://github.com/Vivswan/github-settings-as-code/commit/cb9218874d6a6956cb1a575ce64418ad8614c199))
* rename to github-settings-as-code ([9678cee](https://github.com/Vivswan/github-settings-as-code/commit/9678ceef5375ce7a30f70107ef441a496cf8653b))


### Bug Fixes

* **ci:** cover src/report in the changed-sections selector and openapi cache key ([a1c4302](https://github.com/Vivswan/github-settings-as-code/commit/a1c43023ab54ea3dca16dd61a2034d2b003756fd))
* declare dependabot default labels and realign SECURITY.md ([aa89a23](https://github.com/Vivswan/github-settings-as-code/commit/aa89a230e6dbe0f823dc7998c21edbed0b167972))
* drop connections for real in the e2e mock, on bun 1.3.14 ([791c4bf](https://github.com/Vivswan/github-settings-as-code/commit/791c4bfe668f02b1d72bdb8677f14fd390678ea5))
* **e2e:** keep body-presence checks active for requestOffSpec rejections ([43426a6](https://github.com/Vivswan/github-settings-as-code/commit/43426a6cca49370f6200acef20dbe368af190106))
* mark the secrets-and-vaults action pins for major-tag rewrites ([9d1f616](https://github.com/Vivswan/github-settings-as-code/commit/9d1f616eaf368f959b1761945619ca1926ecc659))
* name every offender in errors and carry engine invariants in types ([49b386a](https://github.com/Vivswan/github-settings-as-code/commit/49b386a1313173fdcf376c7698852f497a355626))
* preserve a rotated deploy key's live read_only flag ([a36da82](https://github.com/Vivswan/github-settings-as-code/commit/a36da82b4c2ca0a91549b40ca8a4a1e522b16bc4))
* re-enable declared protection rules the API reports as disabled ([b469a6f](https://github.com/Vivswan/github-settings-as-code/commit/b469a6fde4c32b20fe4abf4b895a0d4f525d39d6))
* reject invalid actions and repository declarations before any section writes ([85be8ef](https://github.com/Vivswan/github-settings-as-code/commit/85be8efd6355326f3814616580d8ff6586e7cbe7))
* silence and label intentional error noise in green runs ([a786ae6](https://github.com/Vivswan/github-settings-as-code/commit/a786ae682fc791c0be8fc1bc94881265d28c30ed))
* track secret-reference provenance structurally through the merge ([e9c223e](https://github.com/Vivswan/github-settings-as-code/commit/e9c223e2f828aee777270939948093e3467618c9))
* unpad flow-mapping braces in the pins cap scenario ([7b041fd](https://github.com/Vivswan/github-settings-as-code/commit/7b041fd13a4da8466f5b9c622993a04a7fc3ff73))
* write version-less secret scanning patterns the way the API allows ([6fa0cef](https://github.com/Vivswan/github-settings-as-code/commit/6fa0cefed39867bcd44d615da5e5bf0c22b237c1))

## [1.0.1](https://github.com/Vivswan/github-settings-as-code/compare/v1.0.0...v1.0.1) (2026-07-23)


### Bug Fixes

* **ci:** adopt the top-level modules format in .repo-platform.yml ([0d33581](https://github.com/Vivswan/github-settings-as-code/commit/0d33581fd15099b01692a1dadd91b4200322a173))
* **ci:** exclude the generated bundle from CodeQL and inline the suppression ([a5e286c](https://github.com/Vivswan/github-settings-as-code/commit/a5e286cfb79dcdd297263a8869e42d385b1562ba))
* **ci:** grant contents read so auto-assign can resolve CODEOWNERS ([494f2bd](https://github.com/Vivswan/github-settings-as-code/commit/494f2bdd57b66cba8c3243f81c5644ea73d824a8))
* **discovery:** redact private repositories from logs, summaries, and outputs ([fd8d105](https://github.com/Vivswan/github-settings-as-code/commit/fd8d105b6446d16a839937fa03007a853011366f))
* **engine:** move multi-repo label prefixing into the Io sink ([eec6ecb](https://github.com/Vivswan/github-settings-as-code/commit/eec6ecbae71a3512d5fd72e2fd20d0c78e619a5b))
* **quality:** flatten nested branches into guard clauses across the codebase ([1c0a3ce](https://github.com/Vivswan/github-settings-as-code/commit/1c0a3ce2ba3fce462918ccf0c4e6ff16f1ca9491))
* **report:** add the encrypted artifact report channel ([770dbb0](https://github.com/Vivswan/github-settings-as-code/commit/770dbb0434d2329b3e248abdf0042e34f43589f3))
* **report:** deliver full private-target reports via repo issues ([4465282](https://github.com/Vivswan/github-settings-as-code/commit/446528244592b16d4671d10738935d8e3bdcffa3))
* **report:** escape backslashes and bare CR in markdown table cells ([571166f](https://github.com/Vivswan/github-settings-as-code/commit/571166f6daeeff9c1cf62da7c540ba4c0ef7f066))
* **test:** add token-leak and self-consistency fuzz invariants ([089fe60](https://github.com/Vivswan/github-settings-as-code/commit/089fe600d6192cfd392153560ff2434d6979b62d))
* **test:** assert apply-convergence and state stability under fuzz ([193c6f2](https://github.com/Vivswan/github-settings-as-code/commit/193c6f28a1780725c8adf44f1ca33598cf4b4eeb))
* **test:** broaden input-mode validator fuzzing across the settings surface ([8c55504](https://github.com/Vivswan/github-settings-as-code/commit/8c555041bd001c7f8311cc537c42833a3012d835))
* **test:** close fuzz vacuity with a discovery guard and a live CI seed ([7c023fc](https://github.com/Vivswan/github-settings-as-code/commit/7c023fc1c7e63502d45ee8b17c6bf0db14faf0e8))
* **test:** extend the e2e harness with core-route faults, idempotence checks, and raw settings ([aa3cdbc](https://github.com/Vivswan/github-settings-as-code/commit/aa3cdbc35b0eb764c729bc944877b10d8ba0c752))
* **test:** fuzz live state so drift detection is actually tested ([9599759](https://github.com/Vivswan/github-settings-as-code/commit/9599759926164969019be4edf10358b4a6f42e8d))
* **test:** fuzz the dead corners of the input space ([7de5404](https://github.com/Vivswan/github-settings-as-code/commit/7de5404180041a15ba5eb2a45a335026a96d5e84))
* **test:** randomize fault targets and model 5xx and core-path faults ([4a80ac6](https://github.com/Vivswan/github-settings-as-code/commit/4a80ac65aa21fe327cfed028a8667fc67ab58e61))

## 1.0.0 (2026-07-22)


### Features

* actionable errors, per-call debug tracing, and coverage docs ([fe9c9c5](https://github.com/Vivswan/github-settings-as-code/commit/fe9c9c51b565f740a76324533e0eb3c34bd57a9f))
* add discovery filters for multi-repo "*" mode ([1d6531f](https://github.com/Vivswan/github-settings-as-code/commit/1d6531f22b8d46a088b4e0f017eb1e67d080a1a2))
* adopt octokit, actions/core, and zod for transport, IO, and validation ([ff89bb6](https://github.com/Vivswan/github-settings-as-code/commit/ff89bb6d3500b6917c3adc0a4a6f4118d397ab39))
* api-version input, self-updating pre-commit, bundle-freshness test ([a836718](https://github.com/Vivswan/github-settings-as-code/commit/a83671815b3bce667f0784ff5befe950fd0c552d))
* apply own settings with the action at HEAD ([4dac8fc](https://github.com/Vivswan/github-settings-as-code/commit/4dac8fc756ec7bffb439896a92febbf6028a263a))
* declarative section permissions and endpoint dictionaries ([de24164](https://github.com/Vivswan/github-settings-as-code/commit/de2416411d32eda6f38c145890a8d8091ea3a5a2))
* five new settings surfaces, audit fixes, and structural refactors ([30e2dd2](https://github.com/Vivswan/github-settings-as-code/commit/30e2dd2e932776302d563536282a5e7f969aa62b))
* forward-compatible key routing in the actions section ([1818569](https://github.com/Vivswan/github-settings-as-code/commit/1818569cad66a37d174090dada741e058ee13307))
* full passthrough in every section plus coverage inventory ([34f108a](https://github.com/Vivswan/github-settings-as-code/commit/34f108a30e5f925e783e17279be8abeadbb42c4d))
* initial settings-as-code action ([6e4857f](https://github.com/Vivswan/github-settings-as-code/commit/6e4857f78bf37304a3e115b42f6c4b99a2018cf7))
* multi-repo mode with central files, remote settings, and a defaults layer ([04b379e](https://github.com/Vivswan/github-settings-as-code/commit/04b379e10e236e753eed740d27c3f809b526d2ed))
* node24 runtime and husky pre-commit hook ([ba04830](https://github.com/Vivswan/github-settings-as-code/commit/ba04830806226425d9e8b3375ff2651a26d78e73))
* preflight barrier makes strict applies all-or-nothing ([a92173f](https://github.com/Vivswan/github-settings-as-code/commit/a92173fe5ada43a5bbc3602ae332a9d30b1a4e6e))
* publish generated settings.yml JSON Schema ([b706fa9](https://github.com/Vivswan/github-settings-as-code/commit/b706fa9287569b0d9c7be7e4a073e28d4e0e3419))


### Bug Fixes

* enforce read-only preflight probes and guard check-mode purity ([009def9](https://github.com/Vivswan/github-settings-as-code/commit/009def97ad53a5ab84416cc4416a930a21c67ba9))
* environments PUT status and write-throttle scaling, found by the new e2e fuzz harness ([b032024](https://github.com/Vivswan/github-settings-as-code/commit/b03202487bb0e0149b34304464cfe2ca08ea615a))
* escape backslashes before pipes in the summary table ([6684569](https://github.com/Vivswan/github-settings-as-code/commit/668456951edcad3701955467d082a56f7f7928e0))
* format the e2e mock files that landed mid-refinement ([8911068](https://github.com/Vivswan/github-settings-as-code/commit/89110689a6b2476c663fb3f0ea8a9a292139fe0f))
* make the unrecognized actions-key note mode-aware and name the enabled value ([1d3bc0a](https://github.com/Vivswan/github-settings-as-code/commit/1d3bc0a4c78dd76854e7eb119438dd6a86e7c2c0))
* pin bun via .bun-version so CI rebuilds the bundle byte-identically ([4e7f2bc](https://github.com/Vivswan/github-settings-as-code/commit/4e7f2bcf59d5d477e1bb6727ba5c3bf33dcadbdf))
* print the final result on stdout ([76b258d](https://github.com/Vivswan/github-settings-as-code/commit/76b258d05785ea3d5fbed0ca62329811ae4a5557))
* rate-limit discovery advice, shared constants, docs pinned to code ([cf8f291](https://github.com/Vivswan/github-settings-as-code/commit/cf8f291ca25222b28c8d6db1e28b14e387153714))
* reject duplicate ruleset and branch declarations before any API call ([441ed49](https://github.com/Vivswan/github-settings-as-code/commit/441ed4956f95272517bdf058286c78e5a2acdb50))
* shape-check the fields section handlers dereference ([c9a8585](https://github.com/Vivswan/github-settings-as-code/commit/c9a8585d16d8a18b790e71bef1704067d25fb991))
* teams org grading, nightly issue auto-assignment, and fuzz artifact hygiene ([f0378f0](https://github.com/Vivswan/github-settings-as-code/commit/f0378f0c0e641978bf387c60bedf6471f4af652b))
* unique marketplace name and shorter description ([9508134](https://github.com/Vivswan/github-settings-as-code/commit/9508134821b3197a81476bc4033ebebd413bc239))
