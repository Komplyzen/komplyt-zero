# Licensing

komplyt-zero is open core. The licence depends on the path:

| Path | Licence | Text |
|------|---------|------|
| `src/ee/` and its subdirectories | [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0), or a commercial licence from Komplyzen GmbH | [src/ee/LICENSE](src/ee/LICENSE) |
| everything else | Apache License 2.0 | [LICENSE](LICENSE) |

Files under `src/ee/` carry an `SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 OR LicenseRef-Komplyzen-Commercial` header. The code in `src/ee/` is source-available, not open source: you may use it for noncommercial purposes as the PolyForm licence defines them, and any other use needs a commercial licence. Write to hello@kompl.yt for commercial terms.

The Docker image built from this repository contains `src/ee/`, so the code can run from the image. It is nevertheless not covered by the Apache licence: only the terms in [src/ee/LICENSE](src/ee/LICENSE) apply to it. The server runs without `src/ee/`; it then logs that it is the open-source edition and leaves those routes out. The npm package does not contain `src/ee/`.
