// SPDX-License-Identifier: Apache-2.0

import { withPermission } from '@/auth/with-auth';
import { proxyToBackend } from '@/auth/proxy-backend';

// Saved analyses: versioned SQL that dashboards run by id. Contract:
// docs/saved-analyses.md. Anyone may list; only admins (analysis:manage) save.
export const GET = withPermission({ analysis: ['read'] })((req) => proxyToBackend(req));
export const POST = withPermission({ analysis: ['manage'] })((req, { user }) =>
	proxyToBackend(req, { userId: user.id }),
);
