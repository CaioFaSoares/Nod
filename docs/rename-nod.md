# Renaming Bond to Nod

Decided by the owner on 2026-10-16: the project and the repository are **Nod** (GitHub
`CaioFaSoares/Nod`, renamed on GitHub on 2026-10-16). `docs/canonico.md` §22 carries the decision;
documents written from that date name the project Nod.

## Status (2026-10-16)

The identifier rename **landed in 0.3.5 as a clean cutover**. Owner, 2026-10-16: "pode renomear, tem
problema nao, limpa no 0.3.5". No data migration and no compatibility aliases.

- The app id is `copland.nod`; with it changed are the `urlScheme` and the `nod://join` / `nod://open`
  deep links, the `nod.*` RPC methods, the `NOD_*` environment variables, the `/.well-known/nod`
  discovery path, the `Nod-Signature` header, the `nod.db` database and the keychain keys under
  `nod.*` (`nod.cred.*`, `nod.host.*`, `nod.bio.*`, `nod.keys.*`).
- An installed 0.3.0 **starts fresh**: the new app id, database file and keychain prefix mean the old
  account, catalog, vault and tool sessions are not read. That is the accepted cost of the cutover.
- The cryptographic protocol labels keep `bond` on purpose: the KDF/HKDF/seal domain-separation
  labels and info strings (`bond/auth/v1`, `bond/vault/v1`, `bond/local/v1`, `bond/share/v1`) and
  the algorithm name `BOND-KDF-V1`, with their pinned test vectors. Changing them would change every
  derived key.
- Old invite links using `bond://` no longer open the app; re-issue them after the switch.
- Hosts must be **redeployed with `NOD_*` env**: the compose (env vars, the `nod-data` volume) and
  the `/.well-known/nod` route are the new contract.
