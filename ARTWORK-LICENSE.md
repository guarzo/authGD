# Reference-deployment artwork

The MIT License in [`LICENSE`](LICENSE) applies to the source code and to the
repository's own documentation graphics under `docs/assets/`. It does **not**
apply to the reference-deployment artwork in these files:

- `public/brand/mark.webp`
- `public/brand/emblem.webp`
- `public/brand/hero.webp`
- `public/brand/hero-account.webp`

That artwork was created by **Faoble**.

Faoble permits the listed artwork to be used and redistributed, including as
part of a fork or a self-hosted authGD deployment, provided **Faoble is
credited**. All other rights remain with the artist; no other use is granted.

You may keep the artwork under those terms or replace it with artwork licensed
for your own deployment. `BRAND_MARK_URL` and `BRAND_SEAL_URL` repoint the first
two by configuration; the other two are referenced by path and are replaced by
overwriting the file.

## Not covered here

`public/brand/eve-sso-login-white-large.png` is CCP's official EVE SSO login
button, vendored so the login page does not hot-link CCP's CDN. It is neither
MIT-licensed nor Faoble's work — see [`NOTICE.md`](NOTICE.md).
