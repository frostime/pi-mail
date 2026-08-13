# Release Guide

Pi Mail is distributed as a Pi package through two public sources:

- npm: `pi install npm:pi-mail`
- GitHub: `pi install git:github.com/frostime/pi-mail`

The package gallery at <https://pi.dev/packages> discovers public npm packages that include the `pi-package` keyword. The `pi` manifest in `package.json` declares the Pi extension, skill, and gallery preview image.

## First npm release

1. Create or sign in to an npm account that owns the unscoped package name `pi-mail`.
2. Publish version `0.6.0` once from a trusted local machine with `npm login && npm publish --access public`. This initial publish creates the npm package; the repository's automated workflow cannot use trusted publishing until the package has publisher settings.
3. On npmjs.com, open `pi-mail` package settings and add a GitHub Actions trusted publisher:
   - User: `frostime`
   - Repository: `pi-mail`
   - Workflow filename: `publish.yml`
   - Allowed action: `npm publish`
4. For later releases, update the package version, commit the change, and push a matching `vX.Y.Z` tag. Do not reuse `v0.6.0`, because that version is already published by step 2.

The workflow at `.github/workflows/publish.yml` runs tests, checks the npm tarball, and publishes with OIDC and provenance. It does not use a long-lived npm token.

## Subsequent releases

1. Update `package.json` version and `CHANGELOG.md`.
2. Commit and push the release change.
3. Create and push a matching tag:

```bash
npm version patch --no-git-tag-version
git add package.json CHANGELOG.md
git commit -m "🔧 chore(release): bump version to X.Y.Z"
git tag vX.Y.Z
git push origin main --follow-tags
```

The tag workflow publishes the package. After npm indexes the new version, Pi's package gallery updates from the public npm metadata.

## Verification

Before pushing a release tag:

```bash
npm test
npm run pack:check
npm view pi-mail version
```

For a repository-only smoke test:

```bash
pi install git:github.com/frostime/pi-mail
```
