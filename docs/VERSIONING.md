# Releases, source retention and rollback

The first public release of this repository is **v0.2.0**, retaining the version used by the supplied snapshot. Earlier development is described as provenance, not invented as release history.

Each subsequent release uses a new semantic-version tag (`vMAJOR.MINOR.PATCH`) and a GitHub Release. Publish source ZIP and TAR.GZ files generated from that exact tag, plus `SHA256SUMS.txt`. GitHub's automatic source archives also remain available for each tag. Mark preview releases explicitly.

**Never overwrite, move or delete an existing release tag or its source assets.** Mainline development continues through new commits; fixes receive new tags. Protect `v*` tags against update/deletion in repository rules. Never use force-push for a published release. Keep CHANGELOG entries and migration instructions for each version.

Before publishing:

1. Review the worktree and full intended file manifest; exclude runtime secrets and customer data.
2. Run CI-equivalent tests, the public-file checker, dependency audit and Gitleaks on all reachable history.
3. Record the commit, scope, test results and limitations in the release notes. Distinguish Mock/local checks from provider acceptance.
4. Create the annotated tag once, push it, and generate archives with `git archive` from the tag.
5. Verify archive contents/checksums, publish a Release, then download/read back its metadata and assets to confirm the same tag/commit and hashes.

The **Publish an existing version tag** workflow can prepare a draft and its checksummed source assets from an already-pushed tag. It refuses to replace an existing release. Its local/Mock checks do not replace the three-database CI run; inspect that result and the release notes before publishing the draft.

For rollback, check out the older tag and use its instructions. **Old source alone cannot safely downgrade a database.** Keep compatible database/config/archive backups and reconcile in-flight external writes before any deployment rollback; never delete business data to make an older binary start.

If a future release accidentally exposes a real secret or personal data, preserving it publicly is inappropriate: revoke credentials first, coordinate removal of the affected content and document the security exception with a sanitized replacement. Ordinary updates must retain older source unchanged. No such exception is claimed for this initial release.
