# Licensing

komplyt-zero is open core. The licence depends on the path:

| Path | Licence | Text |
|------|---------|------|
| `src/ee/` and its subdirectories | Elastic License 2.0 (ELv2) | [src/ee/LICENSE](src/ee/LICENSE) |
| everything else | Apache License 2.0 | [LICENSE](LICENSE) |

Files under `src/ee/` carry an `SPDX-License-Identifier: Elastic-2.0` header. The server runs without `src/ee/`; it then logs that it is the open-source edition and leaves those routes out.

The Docker image built from this repository contains `src/ee/`, so the code can run from the image. It is nevertheless not covered by the Apache licence: only the terms in [src/ee/LICENSE](src/ee/LICENSE) apply to it.
