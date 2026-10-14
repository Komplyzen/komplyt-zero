# Licensing

komplyt-zero is open core. The licence depends on the path:

| Path | Licence | Text |
|------|---------|------|
| `src/ee/` and its subdirectories | Elastic License 2.0 (ELv2) | [src/ee/LICENSE](src/ee/LICENSE) |
| everything else | Apache License 2.0 | [LICENSE](LICENSE) |

Files under `src/ee/` carry an `SPDX-License-Identifier: Elastic-2.0` header. The server runs without `src/ee/`; it then logs that it is the open-source edition and leaves those routes out.

ELv2 lets you use, modify and self-host the `src/ee/` code for your own organisation. It forbids offering it to others as a hosted or managed service. There is no licence key.
