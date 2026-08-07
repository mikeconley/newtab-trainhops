@AGENTS.md

# Building in this folder

**This folder is the site — build at the top level.** Edit the existing
`index.html` (and add assets) here at the repo root; do **not** create a new
subfolder for the site. `quick deploy .` publishes this one folder as one site.

Multiple sites from one repo is possible but not the default — only split content
into its own subfolder site if explicitly asked, then deploy it by name
(`quick deploy ./other-site other-name`).
