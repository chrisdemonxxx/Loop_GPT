# Legacy tunnel credential handling

This connector is separate from the new owned staging topology. Changes here do
not deploy, restart, rotate, or replace the existing production tunnel.

The image now includes only `config.yml`. Provision the tunnel credential through
the hosting platform's secret-file mechanism, mounted read-only at
`/etc/cloudflared/tunnel-creds.json`, before using this revised image. Verify the
file is readable by the image's runtime user. Do not supply credentials as build
arguments, copy them into an image, or commit them to Git.

The previous tracked `tunnel-creds.json` was removed from the Git index and ignored;
the local file was preserved. **This does not remove historical exposure or revoke
the credential.** Treat prior copies in repository history, images and caches as
exposed. Arrange provider-side rotation/revocation and update the running connector
in a coordinated maintenance operation before relying on that tunnel's security.
No rotation, history rewrite or cache deletion was performed by this change.

The legacy image still uses `cloudflare/cloudflared:latest`; it is not a qualified,
digest-pinned production release. New staging does not use this connector.
