// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 OR LicenseRef-Komplyzen-Commercial
// Copyright 2024-2026 Komplyzen GmbH. Licensed under the PolyForm Noncommercial License 1.0.0 or a commercial licence from Komplyzen; see LICENSE in this directory.

/**
 * Enterprise Edition entry point.
 *
 * License: PolyForm Noncommercial 1.0.0 (see LICENSE in this directory), or a
 * commercial licence from Komplyzen GmbH (hello@kompl.yt). Use for
 * noncommercial purposes, as that licence defines them, is free; any other use
 * needs the commercial licence. The rest of the repository is Apache-2.0.
 */

// Re-export enterprise features
export { createOAuthRoutes } from "./oauth.js";
export { createAdminRoutes } from "./admin-routes.js";
export { adminSoftDelete } from "./admin-delete.js";
export { runPurge } from "./purge.js";
export { createContainerRoutes } from "./container-routes.js";
