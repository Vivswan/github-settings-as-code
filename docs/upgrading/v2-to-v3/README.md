---
order: 21
title: "v2 to v3: by topic"
---

# Upgrading from v2 to v3: by topic

The sixty-three breaks of the [v2 to v3 guide](../v2-to-v3.md), one page per topic. The guide carries the summary table and the order of operations; read these in the order below.

- [Run inputs and outputs](run.md): what the workflow step passes in and what it reads back.
- [Settings-file keys and directives](settings-file.md): keys and directives of the settings file that were renamed or changed meaning.
- [Layering and the render step](layering.md): the layered settings files and `mode: render`.
- [Per-section behavior](sections.md): sections that act differently on the same declaration.
- [Parse-time refusals: repository-level sections](refusals-repository.md): declarations in the repository-level sections that now fail when the file is parsed.
- [Parse-time refusals: list sections](refusals-lists.md): the same for the sections that hold lists.
- [Library API](library.md): the public entry of the npm package and its v3 names.
- [Releases and tags](releases.md): for anyone pinning a sha or installing `@next`.
