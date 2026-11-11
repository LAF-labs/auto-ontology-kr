// SPDX-License-Identifier: Apache-2.0

import { withPermission } from '@/auth/with-auth';
import { proxyToBackend } from '@/auth/proxy-backend';

// Saved-analysis exports, newest first, with today's usage and the limits in
// force (docs/saved-analyses.md §15). analysis:export.
export const GET = withPermission({ analysis: ['export'] })((req) => proxyToBackend(req));
