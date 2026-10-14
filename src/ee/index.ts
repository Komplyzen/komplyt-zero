// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2026 Komplyzen GmbH. Licensed under the Elastic License 2.0; see LICENSE in this directory.

/**
 * Enterprise Edition entry point.
 *
 * License: Elastic License 2.0 (ELv2) - see LICENSE in this directory.
 *
 * You may use, copy, distribute, modify and self-host this code. ELv2 does
 * not allow providing it to third parties as a hosted or managed service that
 * gives them a substantial set of its features, circumventing licence keys, or
 * removing licensing notices. See LICENSE for the full terms.
 */

// Re-export enterprise features
export { createOAuthRoutes } from "./oauth.js";
export { createAdminRoutes } from "./admin-routes.js";
export { adminSoftDelete } from "./admin-delete.js";
export { runPurge } from "./purge.js";
export { createContainerRoutes } from "./container-routes.js";
