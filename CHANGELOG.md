# Changelog

## [2.0.0](https://github.com/Vivswan/repo-settings-as-code/compare/v1.0.1...v2.0.0) (2026-08-09)


### ⚠ BREAKING CHANGES

* branches[].protection.required_signatures now acts. Previously the key rode the protection PUT, where GitHub dropped it (check mode showed permanent drift). A settings file already carrying it will start toggling the signed-commit requirement on the first apply after upgrading - a stale required_signatures: false would REMOVE a hand-enabled requirement. Audit existing declarations for intent before moving to v2. The v1 line keeps the old inert behavior.
* actions.fork_pr_contributor_approval and actions.fork_pr_workflows_private_repos now act. Previously both keys fell through to the base permissions PUT, where GitHub ignored them and a notice said so. A settings file already carrying either key will start applying these policies on the first apply after upgrading; audit existing declarations for intent before moving to v2. The v1 line keeps the old inert behavior.
* actions.oidc_customization_sub now acts. Previously the key fell through to the base permissions PUT, where GitHub ignored it and a notice said so. A settings file already carrying the key will start customizing the OIDC subject claim template on the first apply after upgrading; audit existing declarations for intent before moving to v2. The v1 line keeps the old inert behavior.

### Features

* actionable errors, per-call debug tracing, and coverage docs ([f19d6a4](https://github.com/Vivswan/repo-settings-as-code/commit/f19d6a46ccaaf744065966498bde8e7850efde47))
* add discovery filters for multi-repo "*" mode ([7d5f9d7](https://github.com/Vivswan/repo-settings-as-code/commit/7d5f9d734d524cc921f440eb7488d1cc4f2157f9))
* add issue-on-failure private-report channel (quiet on healthy runs) ([a4ac3d0](https://github.com/Vivswan/repo-settings-as-code/commit/a4ac3d09a4c3a25e77a8a2fca686144c73b0037c))
* adopt octokit, actions/core, and zod for transport, IO, and validation ([a877eb0](https://github.com/Vivswan/repo-settings-as-code/commit/a877eb09b47fbbab3d62b0ea47cf6a3d771fe32c))
* api-version input, self-updating pre-commit, bundle-freshness test ([36df530](https://github.com/Vivswan/repo-settings-as-code/commit/36df530685ea99c0a957f62f7b9fb2d054a9cd4c))
* apply own settings with the action at HEAD ([8ca4657](https://github.com/Vivswan/repo-settings-as-code/commit/8ca4657ef0a27f86855a18e0e5e2968609fa6156))
* declarative section permissions and endpoint dictionaries ([aa554f5](https://github.com/Vivswan/repo-settings-as-code/commit/aa554f5e54bb0d990188b879b71afbb271e79c28))
* enrich API rejection errors and reject unknown keys in closed sections ([909c0f1](https://github.com/Vivswan/repo-settings-as-code/commit/909c0f17403efb995ba95b7fc7ceb68e04f5313f))
* five new settings surfaces, audit fixes, and structural refactors ([95f3937](https://github.com/Vivswan/repo-settings-as-code/commit/95f39379a877ade7617d97fc58c9d4280869d0cd))
* forward-compatible key routing in the actions section ([a00d22e](https://github.com/Vivswan/repo-settings-as-code/commit/a00d22e234fe7669db2611e14fe0a7606f83354c))
* full passthrough in every section plus coverage inventory ([16e7d7a](https://github.com/Vivswan/repo-settings-as-code/commit/16e7d7afee47085a39ac6e356afbc44dd43fd4b5))
* initial settings-as-code action ([fe98b40](https://github.com/Vivswan/repo-settings-as-code/commit/fe98b40160d70a551496b07fc417443234ffaa5d))
* let settings.yml choose the undeclared-resource policy per section ([397d37b](https://github.com/Vivswan/repo-settings-as-code/commit/397d37b4f2dedbbef5bb86739067f8c228159181))
* manage Actions artifact/log retention and cache limits ([198a04d](https://github.com/Vivswan/repo-settings-as-code/commit/198a04d2d55c558632cb181285f89eb43d360eee))
* manage deploy keys ([c6a9c5d](https://github.com/Vivswan/repo-settings-as-code/commit/c6a9c5d7323f687d7a1d5588fbb6c736c088f428))
* manage environment custom deployment protection rules ([cd197b1](https://github.com/Vivswan/repo-settings-as-code/commit/cd197b1aa5a8f8369a1fa36431fa0aeb78fb7cf2))
* manage environment deployment branch-policy patterns ([eb92219](https://github.com/Vivswan/repo-settings-as-code/commit/eb922192fdc3705cbaba5495e3a8584a0683a36a))
* manage environment variables in the environments section ([66dd1e1](https://github.com/Vivswan/repo-settings-as-code/commit/66dd1e1466b59f0c843ec9f1dfc22d3bf6a0c633))
* manage environment, Dependabot, and Codespaces secrets ([611ac56](https://github.com/Vivswan/repo-settings-as-code/commit/611ac5639b9c034c96d3c9ba4468f5377abddc9b))
* manage fork pull request workflow policies from the actions section ([becfe60](https://github.com/Vivswan/repo-settings-as-code/commit/becfe600a32a8953b09f5f984977cc7c3b86c862))
* manage Git LFS enablement from the repository section ([bb2c93c](https://github.com/Vivswan/repo-settings-as-code/commit/bb2c93c3a7e766a6797bb0b1cba1014e9070929b))
* manage immutable releases from the repository section ([896396a](https://github.com/Vivswan/repo-settings-as-code/commit/896396aca849eff62e87b486d77922dba51d7eed))
* manage repository Actions secrets ([3f5e653](https://github.com/Vivswan/repo-settings-as-code/commit/3f5e6536b1d043dda65fc9027fb7b93a630011e9))
* manage repository Actions variables ([550b6e2](https://github.com/Vivswan/repo-settings-as-code/commit/550b6e2ac857bbb25057aedb11f16553898071ae))
* manage repository custom property values ([e645016](https://github.com/Vivswan/repo-settings-as-code/commit/e64501682216028e151a4c08e4a1e0a416fdd08b))
* manage repository interaction limits ([2ec6f3c](https://github.com/Vivswan/repo-settings-as-code/commit/2ec6f3cca496725ff4eb2111306c4c59b51b2632))
* manage repository secret scanning custom patterns ([2b61354](https://github.com/Vivswan/repo-settings-as-code/commit/2b61354bd44c0ba993730214db096ffb0ed0b9fc))
* manage repository webhooks ([da9a9c3](https://github.com/Vivswan/repo-settings-as-code/commit/da9a9c38836a5888cfff52d2a7d51a7c2028cab0))
* manage required commit signatures in the branches section ([db17392](https://github.com/Vivswan/repo-settings-as-code/commit/db173925f9650cfb1da61c8377b486e7b3eccf95))
* manage the Actions OIDC subject claim from the actions section ([bad4739](https://github.com/Vivswan/repo-settings-as-code/commit/bad473907931bfc601a99e5b5e196056db73902b))
* move repo-owned CI and release logic to template extension points ([#12](https://github.com/Vivswan/repo-settings-as-code/issues/12)) ([560de4d](https://github.com/Vivswan/repo-settings-as-code/commit/560de4dd98a4893088bec99b408235f2e42a6e32))
* multi-repo mode with central files, remote settings, and a defaults layer ([a8492cb](https://github.com/Vivswan/repo-settings-as-code/commit/a8492cb076e0bb51b77356a34b4684a663cbf500))
* node24 runtime and husky pre-commit hook ([4beb74d](https://github.com/Vivswan/repo-settings-as-code/commit/4beb74da1c5f684a7ee83327b5a7c1e37ad15e6f))
* preflight barrier makes strict applies all-or-nothing ([174ad96](https://github.com/Vivswan/repo-settings-as-code/commit/174ad96a0bcb56ab523fa505c0a94f86efca54fc))
* publish generated settings.yml JSON Schema ([a523bcf](https://github.com/Vivswan/repo-settings-as-code/commit/a523bcf3b301c4eda090db6eb40d7207333c2aed))


### Bug Fixes

* **ci:** adopt the top-level modules format in .repo-platform.yml ([70be40d](https://github.com/Vivswan/repo-settings-as-code/commit/70be40d98fe567a516f53981fbc9424e218bf62c))
* **ci:** cover src/report in the changed-sections selector and openapi cache key ([ab01134](https://github.com/Vivswan/repo-settings-as-code/commit/ab011346fb2b5ce31a7f9899326f301fbfa096a8))
* **ci:** exclude the generated bundle from CodeQL and inline the suppression ([504497d](https://github.com/Vivswan/repo-settings-as-code/commit/504497d10d53c95ce014cb8bb3b1c569d53bdf66))
* **ci:** grant contents read so auto-assign can resolve CODEOWNERS ([2c41c50](https://github.com/Vivswan/repo-settings-as-code/commit/2c41c50baa51b994309b0ef65c68ef6b1c2b12b4))
* declare dependabot default labels and realign SECURITY.md ([82543d5](https://github.com/Vivswan/repo-settings-as-code/commit/82543d59e9c61f6c9b82660e069f7619dff64f50))
* **discovery:** redact private repositories from logs, summaries, and outputs ([ed2446e](https://github.com/Vivswan/repo-settings-as-code/commit/ed2446ef43929fa354f0edea2ee2f349306cfa64))
* **e2e:** keep body-presence checks active for requestOffSpec rejections ([35f5d63](https://github.com/Vivswan/repo-settings-as-code/commit/35f5d631ac4797b5a7b4a4a64ca2fad4fcbfd724))
* enforce read-only preflight probes and guard check-mode purity ([9bf37c3](https://github.com/Vivswan/repo-settings-as-code/commit/9bf37c35cb12ea9140e4dadfde315515a0243d3a))
* **engine:** move multi-repo label prefixing into the Io sink ([4c81b6e](https://github.com/Vivswan/repo-settings-as-code/commit/4c81b6effb5bc7c2371319a64034a9395036fdee))
* environments PUT status and write-throttle scaling, found by the new e2e fuzz harness ([eb3c78a](https://github.com/Vivswan/repo-settings-as-code/commit/eb3c78ade722660f74d1ca9c110d51cb375b86e4))
* escape backslashes before pipes in the summary table ([cfec263](https://github.com/Vivswan/repo-settings-as-code/commit/cfec2630864e96d61f538d706aaf9f40a06ab4c6))
* format the e2e mock files that landed mid-refinement ([f517cc4](https://github.com/Vivswan/repo-settings-as-code/commit/f517cc4ace68498a79cc4bfb73d120ccad8e95a6))
* make the unrecognized actions-key note mode-aware and name the enabled value ([cb90c36](https://github.com/Vivswan/repo-settings-as-code/commit/cb90c36d62be512744a9f9425af1b245351add91))
* pin bun via .bun-version so CI rebuilds the bundle byte-identically ([a342371](https://github.com/Vivswan/repo-settings-as-code/commit/a342371e542d109723b41f0652dbac7d876d04a5))
* preserve a rotated deploy key's live read_only flag ([be868de](https://github.com/Vivswan/repo-settings-as-code/commit/be868de23da3005dab0701470daddfef9bb06e30))
* print the final result on stdout ([b12eba5](https://github.com/Vivswan/repo-settings-as-code/commit/b12eba5440185a2ca212c77154b2954e67c49ffc))
* **quality:** flatten nested branches into guard clauses across the codebase ([2acc4ac](https://github.com/Vivswan/repo-settings-as-code/commit/2acc4ac2fe80d034728872f302c70280ade28fb4))
* rate-limit discovery advice, shared constants, docs pinned to code ([568cef5](https://github.com/Vivswan/repo-settings-as-code/commit/568cef53517f55969240d9cbb9b05ed5a372598b))
* re-enable declared protection rules the API reports as disabled ([5d369af](https://github.com/Vivswan/repo-settings-as-code/commit/5d369af3e169f94fed1381a8bd0788cd4b851bcd))
* reject duplicate ruleset and branch declarations before any API call ([db15132](https://github.com/Vivswan/repo-settings-as-code/commit/db1513287d923f109ea5e33d678cf86e45eda7d9))
* reject invalid actions and repository declarations before any section writes ([1113969](https://github.com/Vivswan/repo-settings-as-code/commit/111396910da87a1da42489195d0087800dd1345f))
* **report:** add the encrypted artifact report channel ([7d6b643](https://github.com/Vivswan/repo-settings-as-code/commit/7d6b643331e04087d30b869681681f777628f883))
* **report:** deliver full private-target reports via repo issues ([20ba504](https://github.com/Vivswan/repo-settings-as-code/commit/20ba504d7526af863b1e5feec4daf0d457d16edb))
* **report:** escape backslashes and bare CR in markdown table cells ([4e64d3e](https://github.com/Vivswan/repo-settings-as-code/commit/4e64d3e64c7a9044fb3622c23d860e01c67c536c))
* shape-check the fields section handlers dereference ([37d5c15](https://github.com/Vivswan/repo-settings-as-code/commit/37d5c15caf90c9f7f597d4d4abe18fecef19bfe2))
* teams org grading, nightly issue auto-assignment, and fuzz artifact hygiene ([80ea6d2](https://github.com/Vivswan/repo-settings-as-code/commit/80ea6d25aec8628347303a5daac6872a36bc31d5))
* **test:** add token-leak and self-consistency fuzz invariants ([2d702ab](https://github.com/Vivswan/repo-settings-as-code/commit/2d702ab96eae50b9454bd059e997a574ee80ce1b))
* **test:** assert apply-convergence and state stability under fuzz ([f9da4b6](https://github.com/Vivswan/repo-settings-as-code/commit/f9da4b6773cc71e3683d31ec266838a57a5d1fa9))
* **test:** broaden input-mode validator fuzzing across the settings surface ([aa5dec2](https://github.com/Vivswan/repo-settings-as-code/commit/aa5dec2fa48ae4d345dfddba068f963cd145d653))
* **test:** close fuzz vacuity with a discovery guard and a live CI seed ([09497ff](https://github.com/Vivswan/repo-settings-as-code/commit/09497ffcaa290acfc432b33ac0a960d2af6db534))
* **test:** extend the e2e harness with core-route faults, idempotence checks, and raw settings ([c18ac93](https://github.com/Vivswan/repo-settings-as-code/commit/c18ac938c1ac0fbbacf3d5a2b66d0d9b8b8f311e))
* **test:** fuzz live state so drift detection is actually tested ([04f064f](https://github.com/Vivswan/repo-settings-as-code/commit/04f064fded5aa6544e29b19253cbc61bdc6c62c4))
* **test:** fuzz the dead corners of the input space ([9134591](https://github.com/Vivswan/repo-settings-as-code/commit/9134591dfb673fa71e4940c8431b3c67c80f7a3f))
* **test:** randomize fault targets and model 5xx and core-path faults ([1792738](https://github.com/Vivswan/repo-settings-as-code/commit/1792738d8895f49ce54addfe47800880bb875841))
* track secret-reference provenance structurally through the merge ([cfc5857](https://github.com/Vivswan/repo-settings-as-code/commit/cfc5857e215fe378b9720223363caff642f261c9))
* unique marketplace name and shorter description ([a4f6ad8](https://github.com/Vivswan/repo-settings-as-code/commit/a4f6ad809d72293fa84abcabe4211e9b669304aa))
* write version-less secret scanning patterns the way the API allows ([963d366](https://github.com/Vivswan/repo-settings-as-code/commit/963d3669a02a199ee25abfea04f7311c9dcfc8ee))

## [1.0.1](https://github.com/Vivswan/repo-settings-as-code/compare/v1.0.0...v1.0.1) (2026-07-23)


### Bug Fixes

* **ci:** adopt the top-level modules format in .repo-platform.yml ([0d33581](https://github.com/Vivswan/repo-settings-as-code/commit/0d33581fd15099b01692a1dadd91b4200322a173))
* **ci:** exclude the generated bundle from CodeQL and inline the suppression ([a5e286c](https://github.com/Vivswan/repo-settings-as-code/commit/a5e286cfb79dcdd297263a8869e42d385b1562ba))
* **ci:** grant contents read so auto-assign can resolve CODEOWNERS ([494f2bd](https://github.com/Vivswan/repo-settings-as-code/commit/494f2bdd57b66cba8c3243f81c5644ea73d824a8))
* **discovery:** redact private repositories from logs, summaries, and outputs ([fd8d105](https://github.com/Vivswan/repo-settings-as-code/commit/fd8d105b6446d16a839937fa03007a853011366f))
* **engine:** move multi-repo label prefixing into the Io sink ([eec6ecb](https://github.com/Vivswan/repo-settings-as-code/commit/eec6ecbae71a3512d5fd72e2fd20d0c78e619a5b))
* **quality:** flatten nested branches into guard clauses across the codebase ([1c0a3ce](https://github.com/Vivswan/repo-settings-as-code/commit/1c0a3ce2ba3fce462918ccf0c4e6ff16f1ca9491))
* **report:** add the encrypted artifact report channel ([770dbb0](https://github.com/Vivswan/repo-settings-as-code/commit/770dbb0434d2329b3e248abdf0042e34f43589f3))
* **report:** deliver full private-target reports via repo issues ([4465282](https://github.com/Vivswan/repo-settings-as-code/commit/446528244592b16d4671d10738935d8e3bdcffa3))
* **report:** escape backslashes and bare CR in markdown table cells ([571166f](https://github.com/Vivswan/repo-settings-as-code/commit/571166f6daeeff9c1cf62da7c540ba4c0ef7f066))
* **test:** add token-leak and self-consistency fuzz invariants ([089fe60](https://github.com/Vivswan/repo-settings-as-code/commit/089fe600d6192cfd392153560ff2434d6979b62d))
* **test:** assert apply-convergence and state stability under fuzz ([193c6f2](https://github.com/Vivswan/repo-settings-as-code/commit/193c6f28a1780725c8adf44f1ca33598cf4b4eeb))
* **test:** broaden input-mode validator fuzzing across the settings surface ([8c55504](https://github.com/Vivswan/repo-settings-as-code/commit/8c555041bd001c7f8311cc537c42833a3012d835))
* **test:** close fuzz vacuity with a discovery guard and a live CI seed ([7c023fc](https://github.com/Vivswan/repo-settings-as-code/commit/7c023fc1c7e63502d45ee8b17c6bf0db14faf0e8))
* **test:** extend the e2e harness with core-route faults, idempotence checks, and raw settings ([aa3cdbc](https://github.com/Vivswan/repo-settings-as-code/commit/aa3cdbc35b0eb764c729bc944877b10d8ba0c752))
* **test:** fuzz live state so drift detection is actually tested ([9599759](https://github.com/Vivswan/repo-settings-as-code/commit/9599759926164969019be4edf10358b4a6f42e8d))
* **test:** fuzz the dead corners of the input space ([7de5404](https://github.com/Vivswan/repo-settings-as-code/commit/7de5404180041a15ba5eb2a45a335026a96d5e84))
* **test:** randomize fault targets and model 5xx and core-path faults ([4a80ac6](https://github.com/Vivswan/repo-settings-as-code/commit/4a80ac65aa21fe327cfed028a8667fc67ab58e61))

## 1.0.0 (2026-07-22)


### Features

* actionable errors, per-call debug tracing, and coverage docs ([fe9c9c5](https://github.com/Vivswan/repo-settings-as-code/commit/fe9c9c51b565f740a76324533e0eb3c34bd57a9f))
* add discovery filters for multi-repo "*" mode ([1d6531f](https://github.com/Vivswan/repo-settings-as-code/commit/1d6531f22b8d46a088b4e0f017eb1e67d080a1a2))
* adopt octokit, actions/core, and zod for transport, IO, and validation ([ff89bb6](https://github.com/Vivswan/repo-settings-as-code/commit/ff89bb6d3500b6917c3adc0a4a6f4118d397ab39))
* api-version input, self-updating pre-commit, bundle-freshness test ([a836718](https://github.com/Vivswan/repo-settings-as-code/commit/a83671815b3bce667f0784ff5befe950fd0c552d))
* apply own settings with the action at HEAD ([4dac8fc](https://github.com/Vivswan/repo-settings-as-code/commit/4dac8fc756ec7bffb439896a92febbf6028a263a))
* declarative section permissions and endpoint dictionaries ([de24164](https://github.com/Vivswan/repo-settings-as-code/commit/de2416411d32eda6f38c145890a8d8091ea3a5a2))
* five new settings surfaces, audit fixes, and structural refactors ([30e2dd2](https://github.com/Vivswan/repo-settings-as-code/commit/30e2dd2e932776302d563536282a5e7f969aa62b))
* forward-compatible key routing in the actions section ([1818569](https://github.com/Vivswan/repo-settings-as-code/commit/1818569cad66a37d174090dada741e058ee13307))
* full passthrough in every section plus coverage inventory ([34f108a](https://github.com/Vivswan/repo-settings-as-code/commit/34f108a30e5f925e783e17279be8abeadbb42c4d))
* initial settings-as-code action ([6e4857f](https://github.com/Vivswan/repo-settings-as-code/commit/6e4857f78bf37304a3e115b42f6c4b99a2018cf7))
* multi-repo mode with central files, remote settings, and a defaults layer ([04b379e](https://github.com/Vivswan/repo-settings-as-code/commit/04b379e10e236e753eed740d27c3f809b526d2ed))
* node24 runtime and husky pre-commit hook ([ba04830](https://github.com/Vivswan/repo-settings-as-code/commit/ba04830806226425d9e8b3375ff2651a26d78e73))
* preflight barrier makes strict applies all-or-nothing ([a92173f](https://github.com/Vivswan/repo-settings-as-code/commit/a92173fe5ada43a5bbc3602ae332a9d30b1a4e6e))
* publish generated settings.yml JSON Schema ([b706fa9](https://github.com/Vivswan/repo-settings-as-code/commit/b706fa9287569b0d9c7be7e4a073e28d4e0e3419))


### Bug Fixes

* enforce read-only preflight probes and guard check-mode purity ([009def9](https://github.com/Vivswan/repo-settings-as-code/commit/009def97ad53a5ab84416cc4416a930a21c67ba9))
* environments PUT status and write-throttle scaling, found by the new e2e fuzz harness ([b032024](https://github.com/Vivswan/repo-settings-as-code/commit/b03202487bb0e0149b34304464cfe2ca08ea615a))
* escape backslashes before pipes in the summary table ([6684569](https://github.com/Vivswan/repo-settings-as-code/commit/668456951edcad3701955467d082a56f7f7928e0))
* format the e2e mock files that landed mid-refinement ([8911068](https://github.com/Vivswan/repo-settings-as-code/commit/89110689a6b2476c663fb3f0ea8a9a292139fe0f))
* make the unrecognized actions-key note mode-aware and name the enabled value ([1d3bc0a](https://github.com/Vivswan/repo-settings-as-code/commit/1d3bc0a4c78dd76854e7eb119438dd6a86e7c2c0))
* pin bun via .bun-version so CI rebuilds the bundle byte-identically ([4e7f2bc](https://github.com/Vivswan/repo-settings-as-code/commit/4e7f2bcf59d5d477e1bb6727ba5c3bf33dcadbdf))
* print the final result on stdout ([76b258d](https://github.com/Vivswan/repo-settings-as-code/commit/76b258d05785ea3d5fbed0ca62329811ae4a5557))
* rate-limit discovery advice, shared constants, docs pinned to code ([cf8f291](https://github.com/Vivswan/repo-settings-as-code/commit/cf8f291ca25222b28c8d6db1e28b14e387153714))
* reject duplicate ruleset and branch declarations before any API call ([441ed49](https://github.com/Vivswan/repo-settings-as-code/commit/441ed4956f95272517bdf058286c78e5a2acdb50))
* shape-check the fields section handlers dereference ([c9a8585](https://github.com/Vivswan/repo-settings-as-code/commit/c9a8585d16d8a18b790e71bef1704067d25fb991))
* teams org grading, nightly issue auto-assignment, and fuzz artifact hygiene ([f0378f0](https://github.com/Vivswan/repo-settings-as-code/commit/f0378f0c0e641978bf387c60bedf6471f4af652b))
* unique marketplace name and shorter description ([9508134](https://github.com/Vivswan/repo-settings-as-code/commit/9508134821b3197a81476bc4033ebebd413bc239))
