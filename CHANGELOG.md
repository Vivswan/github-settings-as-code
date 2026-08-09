# Changelog

## [2.0.0](https://github.com/Vivswan/repo-settings-as-code/compare/v1.0.1...v2.0.0) (2026-08-09)


### ⚠ BREAKING CHANGES

* branches[].protection.required_signatures now acts. Previously the key rode the protection PUT, where GitHub dropped it (check mode showed permanent drift). A settings file already carrying it will start toggling the signed-commit requirement on the first apply after upgrading - a stale required_signatures: false would REMOVE a hand-enabled requirement. Audit existing declarations for intent before moving to v2. The v1 line keeps the old inert behavior.
* actions.fork_pr_contributor_approval and actions.fork_pr_workflows_private_repos now act. Previously both keys fell through to the base permissions PUT, where GitHub ignored them and a notice said so. A settings file already carrying either key will start applying these policies on the first apply after upgrading; audit existing declarations for intent before moving to v2. The v1 line keeps the old inert behavior.
* actions.oidc_customization_sub now acts. Previously the key fell through to the base permissions PUT, where GitHub ignored it and a notice said so. A settings file already carrying the key will start customizing the OIDC subject claim template on the first apply after upgrading; audit existing declarations for intent before moving to v2. The v1 line keeps the old inert behavior.

### Features

* add issue-on-failure private-report channel (quiet on healthy runs) ([1774a95](https://github.com/Vivswan/repo-settings-as-code/commit/1774a95d8ee78c91ce86a3f2f2e92eca181d9529))
* enrich API rejection errors and reject unknown keys in closed sections ([28fe97c](https://github.com/Vivswan/repo-settings-as-code/commit/28fe97c38b6d69650727195bd4ff2d44c574ac61))
* let settings.yml choose the undeclared-resource policy per section ([b75ea04](https://github.com/Vivswan/repo-settings-as-code/commit/b75ea04472bcde0ecda0f27eec1cec7816764b00))
* manage Actions artifact/log retention and cache limits ([a3ac4d2](https://github.com/Vivswan/repo-settings-as-code/commit/a3ac4d2f3d24c4c5af9f35d6b7ffca21462d0c40))
* manage deploy keys ([0983f53](https://github.com/Vivswan/repo-settings-as-code/commit/0983f53a073e6151884aeb5e3a893c610e022e85))
* manage environment custom deployment protection rules ([3b68683](https://github.com/Vivswan/repo-settings-as-code/commit/3b68683c5413c59a1fd33235ee5724b9fd0db6d0))
* manage environment deployment branch-policy patterns ([237972d](https://github.com/Vivswan/repo-settings-as-code/commit/237972dd4241141e8bad24a478f6a67464c307c1))
* manage environment variables in the environments section ([99fd99f](https://github.com/Vivswan/repo-settings-as-code/commit/99fd99f00b06633a452d324396d1d4ab8d743991))
* manage environment, Dependabot, and Codespaces secrets ([b3a5699](https://github.com/Vivswan/repo-settings-as-code/commit/b3a569930d8e0a9e75a3806ca451fb22fd098639))
* manage fork pull request workflow policies from the actions section ([3c87cfe](https://github.com/Vivswan/repo-settings-as-code/commit/3c87cfe8f19fe1fef036169a832744dd48a129eb))
* manage Git LFS enablement from the repository section ([795c4c5](https://github.com/Vivswan/repo-settings-as-code/commit/795c4c5188cf218721f9da0c145244d1517e2089))
* manage immutable releases from the repository section ([d761fd6](https://github.com/Vivswan/repo-settings-as-code/commit/d761fd63f88aa843cf8cac6d49be5095c3a07116))
* manage repository Actions secrets ([ad39689](https://github.com/Vivswan/repo-settings-as-code/commit/ad39689618655ea9d99cf899f2c440abdf9cc5f8))
* manage repository Actions variables ([c18f154](https://github.com/Vivswan/repo-settings-as-code/commit/c18f154ac26ab446d3a65c8bad09d6f69ffcffee))
* manage repository custom property values ([3b23727](https://github.com/Vivswan/repo-settings-as-code/commit/3b23727baead44a6ceb497e121e534854e31089d))
* manage repository interaction limits ([2db5b0a](https://github.com/Vivswan/repo-settings-as-code/commit/2db5b0aaa36c43e270ccc4c7295a496100adf5e0))
* manage repository secret scanning custom patterns ([73aa6fb](https://github.com/Vivswan/repo-settings-as-code/commit/73aa6fb2658cace8d23f5bc2cb327010b4a87d9e))
* manage repository webhooks ([a9d04ae](https://github.com/Vivswan/repo-settings-as-code/commit/a9d04ae1d05c703d8dfa72e524f5ddd05e586c52))
* manage required commit signatures in the branches section ([789a52b](https://github.com/Vivswan/repo-settings-as-code/commit/789a52b10702ee292e952082e0e3f0eb601f9383))
* manage the Actions OIDC subject claim from the actions section ([bb3004d](https://github.com/Vivswan/repo-settings-as-code/commit/bb3004d17f6b17e820107512a2b77249b0ccda93))
* move repo-owned CI and release logic to template extension points ([#12](https://github.com/Vivswan/repo-settings-as-code/issues/12)) ([bfe9388](https://github.com/Vivswan/repo-settings-as-code/commit/bfe9388d47acedbaf7fb9cb65ff9e66c0896dd51))


### Bug Fixes

* **ci:** cover src/report in the changed-sections selector and openapi cache key ([677e1cb](https://github.com/Vivswan/repo-settings-as-code/commit/677e1cbaaa17c38da7789efa3def9e8aa40db690))
* declare dependabot default labels and realign SECURITY.md ([c4250da](https://github.com/Vivswan/repo-settings-as-code/commit/c4250da7a24761aadf1c02b0ba4b24e65ad82d70))
* **e2e:** keep body-presence checks active for requestOffSpec rejections ([47dc39c](https://github.com/Vivswan/repo-settings-as-code/commit/47dc39c8ff597f885d97eec7ad2b7dadd519d98f))
* preserve a rotated deploy key's live read_only flag ([1484a4f](https://github.com/Vivswan/repo-settings-as-code/commit/1484a4fe4cbdf220cee8df989df5aadbf8e1d0a0))
* re-enable declared protection rules the API reports as disabled ([0a191af](https://github.com/Vivswan/repo-settings-as-code/commit/0a191afc3144fac50f653b8969db3e2057235487))
* reject invalid actions and repository declarations before any section writes ([72d02de](https://github.com/Vivswan/repo-settings-as-code/commit/72d02dec1a0ffefc6a235fba751ca628f4c83624))
* track secret-reference provenance structurally through the merge ([9cde4a8](https://github.com/Vivswan/repo-settings-as-code/commit/9cde4a8a54ddbb694009d6fa7c70531a89670c32))
* write version-less secret scanning patterns the way the API allows ([5f8958e](https://github.com/Vivswan/repo-settings-as-code/commit/5f8958ee1cecd91cf4a2f2b95e76c63aa0b91cb0))

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
