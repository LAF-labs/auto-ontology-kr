// SPDX-License-Identifier: Apache-2.0

import { withPermission } from '@/auth/with-auth';
import { proxyToBackend } from '@/auth/proxy-backend';

// Export a verified saved analysis's full result to a file
// (docs/saved-analyses.md §15). analysis:export only: admin and
// analysis_exporter. The caller is recorded as the export's requested_by.
export const POST = withPermission({ analysis: ['export'] })((req, { user }) =>
	proxyToBackend(req, { userId: user.id }),
);
